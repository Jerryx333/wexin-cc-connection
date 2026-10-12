/**
 * Message sending utilities for WeChat.
 * Includes markdown-to-plaintext conversion and text chunking.
 */

import {
  sendMessage as sendMessageApi,
  generateId,
  MessageItemType,
  MessageState,
  MessageType,
} from "./client.js";
import type { WeixinApiOptions, MessageItem, SendMessageReq } from "./client.js";

const TEXT_CHUNK_LIMIT = 4000;

function generateClientId(): string {
  return generateId("openclaw-weixin");
}

/**
 * Strip basic markdown for plain-text WeChat delivery.
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s+/gm, "");
  return result.trim();
}

/**
 * Split text into chunks of max `limit` chars, breaking at newlines where possible.
 */
export function chunkText(text: string, limit: number = TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf("\n", limit);
    if (breakAt <= 0) breakAt = limit;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/, "");
  }
  return chunks;
}

function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
    },
  };
}

/**
 * Send a plain text message to a WeChat user.
 * contextToken MUST be echoed from the inbound message.
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    throw new Error("sendMessageWeixin: contextToken is required");
  }
  const clientId = generateClientId();
  const req = buildTextMessageReq({
    to,
    text,
    contextToken: opts.contextToken,
    clientId,
  });
  await sendMessageApi({
    baseUrl: opts.baseUrl,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    body: req,
  });
  return { messageId: clientId };
}

/**
 * Send a text reply, automatically chunked if too long.
 */
export async function sendChunkedReply(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<void> {
  const chunks = chunkText(params.text);
  for (const chunk of chunks) {
    await sendMessageWeixin({ to: params.to, text: chunk, opts: params.opts });
  }
}
