/**
 * Long-polling loop for receiving WeChat messages via iLink.
 * Adapted from src/bridge.ts — replaces Claude CLI calls with a generic message handler.
 */

import { getUpdates, sendTyping, getConfig, MessageItemType, TypingStatus } from "./client.js";
import type { WeixinMessage, MessageItem } from "./client.js";
import { markdownToPlainText, sendChunkedReply } from "./send.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Extract user text from message items. Handles text, voice-to-text, and quoted refs.
 */
export function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item?.type === MessageItemType.TEXT && ref.message_item.text_item?.text) {
        parts.push(ref.message_item.text_item.text);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

// Typing ticket cache per user
const typingTicketCache = new Map<string, string>();

async function fetchTypingTicket(
  baseUrl: string,
  token: string,
  userId: string,
  contextToken?: string,
): Promise<string | undefined> {
  const cached = typingTicketCache.get(userId);
  if (cached) return cached;
  try {
    const resp = await getConfig({ baseUrl, token, ilinkUserId: userId, contextToken });
    if (resp.typing_ticket) {
      typingTicketCache.set(userId, resp.typing_ticket);
      return resp.typing_ticket;
    }
  } catch {
    // best-effort
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

// ===========================================================================
// Message handler type (OpenClaw integration point)
// ===========================================================================

export type InboundMessage = {
  fromUserId: string;
  text: string;
  contextToken: string;
  raw: WeixinMessage;
};

export type MessageHandler = (msg: InboundMessage) => Promise<string | void>;

// ===========================================================================
// Polling options & main loop
// ===========================================================================

export type PollingOpts = {
  baseUrl: string;
  token: string;
  accountId: string;
  abortSignal?: AbortSignal;
  onMessage: MessageHandler;
  onSessionExpired?: () => void;
  loadSyncCursor?: () => string | undefined;
  saveSyncCursor?: (cursor: string) => void;
  log?: { debug(msg: string): void; info(msg: string): void; warn(msg: string): void; error(msg: string): void };
};

/**
 * Start the long-polling loop. Calls `onMessage` for each inbound text message.
 * If `onMessage` returns a string, it is sent back as a reply (with markdown conversion + chunking).
 */
export async function startPolling(opts: PollingOpts): Promise<void> {
  const { baseUrl, token, abortSignal, onMessage, log } = opts;

  log?.info(`WeChat polling started: baseUrl=${baseUrl} account=${opts.accountId}`);

  let cursor = opts.loadSyncCursor?.() ?? "";
  if (cursor) {
    log?.info(`Resuming from saved sync cursor (${cursor.length} bytes)`);
  }

  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: cursor,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          log?.error("WeChat session expired! Please re-login.");
          opts.onSessionExpired?.();
          await sleep(5 * 60_000, abortSignal);
          continue;
        }

        consecutiveFailures++;
        log?.error(
          `getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log?.error(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        opts.saveSyncCursor?.(resp.get_updates_buf);
        cursor = resp.get_updates_buf;
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        try {
          await processOneMessage(msg, opts);
        } catch (err) {
          log?.error(`processOneMessage error: ${String(err)}`);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        log?.info("WeChat polling stopped (aborted)");
        return;
      }
      consecutiveFailures++;
      log?.error(`Polling loop error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  log?.info("WeChat polling ended");
}

async function processOneMessage(msg: WeixinMessage, opts: PollingOpts): Promise<void> {
  const fromUser = msg.from_user_id ?? "";
  const contextToken = msg.context_token;
  const text = extractText(msg.item_list);

  if (!text.trim()) return;
  if (!contextToken) {
    opts.log?.warn(`No contextToken for message from ${fromUser}, cannot reply`);
    return;
  }

  opts.log?.info(`Inbound: from=${fromUser} text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

  const apiOpts = { baseUrl: opts.baseUrl, token: opts.token, contextToken };

  // Typing indicator: start
  const typingTicket = await fetchTypingTicket(opts.baseUrl, opts.token, fromUser, contextToken);
  if (typingTicket) {
    await sendTyping({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: { ilink_user_id: fromUser, typing_ticket: typingTicket, status: TypingStatus.TYPING },
    });
  }

  // Delegate to handler
  let response: string | void;
  try {
    response = await opts.onMessage({
      fromUserId: fromUser,
      text,
      contextToken,
      raw: msg,
    });
  } catch (err) {
    opts.log?.error(`Message handler failed: ${String(err)}`);
    response = "⚠️ An error occurred while processing your message.";
  }

  // Typing indicator: cancel
  if (typingTicket) {
    await sendTyping({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: { ilink_user_id: fromUser, typing_ticket: typingTicket, status: TypingStatus.CANCEL },
    });
  }

  // Send reply if handler returned text
  if (typeof response === "string" && response.length > 0) {
    const plainText = markdownToPlainText(response);
    await sendChunkedReply({ to: fromUser, text: plainText, opts: apiOpts });
  }
}
