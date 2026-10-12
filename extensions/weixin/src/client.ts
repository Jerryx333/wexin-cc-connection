/**
 * iLink Bot protocol client for WeChat.
 * Merged from src/ilink/types.ts + src/ilink/api.ts — self-contained, no external deps.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ===========================================================================
// Types (from iLink protocol)
// ===========================================================================

export interface BaseInfo {
  channel_version?: string;
}

export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export interface TextItem { text?: string }
export interface CDNMedia { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number }
export interface ImageItem { media?: CDNMedia; thumb_media?: CDNMedia; aeskey?: string; url?: string; mid_size?: number; thumb_size?: number; thumb_height?: number; thumb_width?: number; hd_size?: number }
export interface VoiceItem { media?: CDNMedia; encode_type?: number; bits_per_sample?: number; sample_rate?: number; playtime?: number; text?: string }
export interface FileItem { media?: CDNMedia; file_name?: string; md5?: string; len?: string }
export interface VideoItem { media?: CDNMedia; video_size?: number; play_length?: number; video_md5?: string; thumb_media?: CDNMedia; thumb_size?: number; thumb_height?: number; thumb_width?: number }

export interface RefMessage { message_item?: MessageItem; title?: string }

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesReq { get_updates_buf?: string }
export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq { msg?: WeixinMessage }
export interface SendTypingReq { ilink_user_id?: string; typing_ticket?: string; status?: number }
export interface GetConfigResp { ret?: number; errmsg?: string; typing_ticket?: string }

// ===========================================================================
// API options
// ===========================================================================

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
};

// ===========================================================================
// Internal helpers
// ===========================================================================

function readChannelVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const CHANNEL_VERSION = readChannelVersion();

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

// Timeouts
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

type Logger = { debug(msg: string): void; info(msg: string): void; warn(msg: string): void; error(msg: string): void };

let _log: Logger = {
  debug: () => {},
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export function setLogger(log: Logger): void {
  _log = log;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });

  _log.debug(`POST ${url.toString()} [${params.label}]`);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    _log.debug(`${params.label} status=${res.status}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

// ===========================================================================
// Public API functions
// ===========================================================================

export async function getUpdates(
  params: GetUpdatesReq & { baseUrl: string; token?: string; timeoutMs?: number },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      _log.debug(`getUpdates: client-side timeout after ${timeout}ms`);
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(rawText) as GetConfigResp;
}

export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  try {
    await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
      token: params.token,
      timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
      label: "sendTyping",
    });
  } catch (err) {
    _log.debug(`sendTyping failed (non-fatal): ${String(err)}`);
  }
}
