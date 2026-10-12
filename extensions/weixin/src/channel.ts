/**
 * OpenClaw WeChat channel plugin.
 *
 * This module assembles the channel plugin using OpenClaw's createChatChannelPlugin() builder.
 * It wires together the iLink protocol client, long-polling, account config, and outbound sending.
 *
 * NOTE: This plugin depends on OpenClaw's plugin SDK types. Since OpenClaw is a peerDependency,
 * the types below are written to match the SDK interfaces without importing them directly,
 * making it possible to develop and test this plugin standalone. When installed as an OpenClaw
 * plugin, the actual SDK types will be resolved from the peer dependency.
 */

import {
  CHANNEL_ID,
  resolveAccount,
  inspectAccount,
  listAccountIds,
  loadSyncCursor,
  saveSyncCursor,
} from "./accounts.js";
import type { ResolvedWeixinAccount } from "./accounts.js";
import { setLogger } from "./client.js";
import { loginWithQR } from "./login.js";
import { startLoginServer } from "./login-web.js";
import { startPolling } from "./polling.js";
import type { InboundMessage } from "./polling.js";
import { sendMessageWeixin, markdownToPlainText, chunkText } from "./send.js";
import { setAccountState, removeAccountState } from "./runtime.js";

// ===========================================================================
// OpenClaw plugin SDK types (minimal, matching the SDK interface)
// ===========================================================================

type OpenClawConfig = { channels?: Record<string, unknown>; [key: string]: unknown };

type ChannelGatewayContext = {
  account: ResolvedWeixinAccount;
  cfg: OpenClawConfig;
  abortSignal: AbortSignal;
  log?: {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  channelRuntime?: {
    dispatchInbound?(params: {
      channelId: string;
      accountId: string;
      from: string;
      text: string;
      messageId?: string;
      replyToId?: string;
      contextToken?: string;
      raw?: unknown;
    }): Promise<{ response?: string }>;
  };
};

// ===========================================================================
// Channel plugin definition
// ===========================================================================

export const weixinChannelPlugin = {
  id: CHANNEL_ID,

  meta: {
    label: "WeChat",
    docsPath: "/channels/weixin",
    blurb: "Connect to WeChat via iLink Bot protocol",
  },

  capabilities: {
    chatTypes: ["dm"] as const,
    reactions: false,
    edit: false,
    unsend: false,
  },

  // ---- Config adapter (required) ----
  config: {
    resolveAccount(cfg: OpenClawConfig, accountId?: string | null) {
      return resolveAccount(cfg, accountId);
    },
    inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
      return inspectAccount(cfg, accountId);
    },
    listAccountIds(cfg: OpenClawConfig) {
      return listAccountIds(cfg);
    },
  },

  // ---- Security adapter ----
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy(account: ResolvedWeixinAccount): string | undefined {
        return account.dmPolicy;
      },
      resolveAllowFrom(account: ResolvedWeixinAccount): string[] {
        return account.allowFrom;
      },
    },
  },

  // ---- Pairing adapter (DM verification) ----
  pairing: {
    text: {
      idLabel: "WeChat User ID",
      message: "Send the pairing code to verify your identity.",
      async notify(params: { cfg: OpenClawConfig; id: string; message: string }): Promise<void> {
        // Pairing codes are sent back via normal reply flow,
        // no additional notification mechanism needed for WeChat.
      },
    },
  },

  // ---- Gateway adapter (start/stop account) ----
  gateway: {
    async startAccount(ctx: ChannelGatewayContext): Promise<void> {
      const { account, abortSignal, log } = ctx;

      // Wire up logging
      if (log) setLogger(log);

      setAccountState(account.accountId, { status: "connecting" });

      log?.info(`Starting WeChat channel: account=${account.accountId}`);

      try {
        await startPolling({
          baseUrl: account.baseUrl,
          token: account.token,
          accountId: account.accountId,
          abortSignal,

          loadSyncCursor: () => loadSyncCursor(account.accountId),
          saveSyncCursor: (cursor) => saveSyncCursor(account.accountId, cursor),

          log,

          onSessionExpired: () => {
            setAccountState(account.accountId, { status: "error", error: "Session expired" });
          },

          async onMessage(msg: InboundMessage): Promise<string | void> {
            // Dispatch to OpenClaw agent via channelRuntime
            if (ctx.channelRuntime?.dispatchInbound) {
              const result = await ctx.channelRuntime.dispatchInbound({
                channelId: CHANNEL_ID,
                accountId: account.accountId,
                from: msg.fromUserId,
                text: msg.text,
                messageId: String(msg.raw.message_id ?? ""),
                contextToken: msg.contextToken,
                raw: msg.raw,
              });
              return result?.response;
            }
            log?.warn("No channelRuntime.dispatchInbound available, message dropped");
            return undefined;
          },
        });
      } catch (err) {
        if (!abortSignal.aborted) {
          setAccountState(account.accountId, { status: "error", error: String(err) });
          throw err;
        }
      }
    },

    async stopAccount(params: { accountId: string }): Promise<void> {
      removeAccountState(params.accountId);
    },
  },

  // ---- Outbound adapter (send messages) ----
  outbound: {
    base: {
      textChunkLimit: 4000,
    },
    attachedResults: {
      channel: CHANNEL_ID,
      async sendText(params: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        accountId?: string | null;
        replyToId?: string | null;
      }): Promise<{ messageId?: string }> {
        const account = resolveAccount(params.cfg, params.accountId);
        const plainText = markdownToPlainText(params.text);
        const chunks = chunkText(plainText);
        let lastMessageId: string | undefined;

        for (const chunk of chunks) {
          // Note: contextToken is not available in outbound-initiated sends.
          // This path is for proactive messages from the agent, which require
          // a valid contextToken from a prior inbound message.
          // For reactive replies (most common), the polling loop handles sending directly.
          const result = await sendMessageWeixin({
            to: params.to,
            text: chunk,
            opts: {
              baseUrl: account.baseUrl,
              token: account.token,
              // contextToken would need to be resolved from recent message state
              // For now, proactive outbound sends may fail without contextToken
              contextToken: undefined,
            },
          });
          lastMessageId = result.messageId;
        }

        return { messageId: lastMessageId };
      },
    },
  },

  // ---- Auth adapter (QR login) ----
  auth: {
    /**
     * Terminal-based QR login (fallback).
     */
    async login(params: {
      cfg: OpenClawConfig;
      accountId?: string;
    }): Promise<{
      success: boolean;
      token?: string;
      accountId?: string;
      baseUrl?: string;
      userId?: string;
      message: string;
    }> {
      const section = (params.cfg.channels as Record<string, { baseUrl?: string }>)?.[CHANNEL_ID];
      const result = await loginWithQR({
        apiBaseUrl: section?.baseUrl ?? "https://ilinkai.weixin.qq.com",
      });
      return {
        success: result.connected,
        token: result.botToken,
        accountId: result.accountId,
        baseUrl: result.baseUrl,
        userId: result.userId,
        message: result.message,
      };
    },

    /**
     * Web-based QR login — opens a browser page with the QR code.
     * Credentials are saved to ~/.openclaw/openclaw.json automatically.
     */
    async loginWeb(params?: {
      port?: number;
      apiBaseUrl?: string;
    }): Promise<{ url: string; close: () => void }> {
      return startLoginServer({
        port: params?.port,
        apiBaseUrl: params?.apiBaseUrl,
      });
    },
  },

  // ---- Threading adapter ----
  threading: {
    topLevelReplyToMode: "reply" as const,
  },
};
