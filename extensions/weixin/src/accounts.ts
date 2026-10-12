/**
 * OpenClaw account resolution for the WeChat channel.
 * Reads config from openclaw.json's `channels.weixin` section.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHANNEL_ID = "weixin";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

// ===========================================================================
// Resolved account type
// ===========================================================================

export type ResolvedWeixinAccount = {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  allowFrom: string[];
  dmPolicy: string;
};

// ===========================================================================
// Config helpers (OpenClaw config shape)
// ===========================================================================

type WeixinChannelConfig = {
  token?: string;
  baseUrl?: string;
  userId?: string;
  allowFrom?: string[];
  dmPolicy?: string;
  accounts?: Record<string, {
    token?: string;
    baseUrl?: string;
    userId?: string;
    allowFrom?: string[];
    dmPolicy?: string;
  }>;
};

type OpenClawConfig = {
  channels?: Record<string, unknown>;
  [key: string]: unknown;
};

function getWeixinConfig(cfg: OpenClawConfig): WeixinChannelConfig | undefined {
  return cfg.channels?.[CHANNEL_ID] as WeixinChannelConfig | undefined;
}

// ===========================================================================
// Account resolution (OpenClaw adapter)
// ===========================================================================

export function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedWeixinAccount {
  const section = getWeixinConfig(cfg);
  if (!section) {
    throw new Error(`${CHANNEL_ID}: channel not configured in openclaw.json`);
  }

  // Multi-account support: check accounts sub-section first
  if (accountId && section.accounts?.[accountId]) {
    const acct = section.accounts[accountId];
    const token = acct.token ?? section.token;
    if (!token) throw new Error(`${CHANNEL_ID}: token is required for account ${accountId}`);
    return {
      accountId,
      token,
      baseUrl: acct.baseUrl ?? section.baseUrl ?? DEFAULT_BASE_URL,
      userId: acct.userId ?? section.userId,
      allowFrom: acct.allowFrom ?? section.allowFrom ?? [],
      dmPolicy: acct.dmPolicy ?? section.dmPolicy ?? "pairing",
    };
  }

  // Single account (default)
  const token = section.token;
  if (!token) throw new Error(`${CHANNEL_ID}: token is required`);

  return {
    accountId: accountId ?? "default",
    token,
    baseUrl: section.baseUrl ?? DEFAULT_BASE_URL,
    userId: section.userId,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmPolicy ?? "pairing",
  };
}

export function inspectAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): { enabled: boolean; configured: boolean; tokenStatus?: string } {
  try {
    const section = getWeixinConfig(cfg);
    if (!section) return { enabled: false, configured: false };

    const token = accountId && section.accounts?.[accountId]
      ? section.accounts[accountId].token ?? section.token
      : section.token;

    return {
      enabled: Boolean(token),
      configured: Boolean(token),
      tokenStatus: token ? "available" : "missing",
    };
  } catch {
    return { enabled: false, configured: false };
  }
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
  const section = getWeixinConfig(cfg);
  if (!section) return [];

  if (section.accounts) {
    return Object.keys(section.accounts);
  }

  // Single account
  return section.token ? ["default"] : [];
}

// ===========================================================================
// Sync cursor persistence (file-based, under ~/.openclaw/weixin/)
// ===========================================================================

function stateDir(): string {
  return path.join(os.homedir(), ".openclaw", "weixin");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function loadSyncCursor(accountId: string): string | undefined {
  try {
    const filePath = path.join(stateDir(), `${accountId}.sync.json`);
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    return typeof data.get_updates_buf === "string" ? data.get_updates_buf : undefined;
  } catch {
    return undefined;
  }
}

export function saveSyncCursor(accountId: string, cursor: string): void {
  const dir = stateDir();
  ensureDir(dir);
  fs.writeFileSync(
    path.join(dir, `${accountId}.sync.json`),
    JSON.stringify({ get_updates_buf: cursor }),
    "utf-8",
  );
}
