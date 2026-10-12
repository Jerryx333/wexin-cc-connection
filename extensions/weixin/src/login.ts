/**
 * WeChat QR code login flow for iLink Bot protocol.
 * Adapted from src/ilink/login.ts for OpenClaw plugin use.
 */

import { randomUUID } from "node:crypto";

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_ILINK_BOT_TYPE = "3";
const MAX_QR_REFRESH_COUNT = 3;

type ActiveLogin = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  status?: "wait" | "scaned" | "confirmed" | "expired";
};

const activeLogins = new Map<string, ActiveLogin>();

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(id);
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const base = ensureTrailingSlash(apiBaseUrl);
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} body=${body}`);
  }
  return (await response.json()) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  const base = ensureTrailingSlash(apiBaseUrl);
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

export type LoginResult = {
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
};

export type LoginCallbacks = {
  onQRCode?(qrcodeUrl: string): void;
  onScanned?(): void;
  onQRExpired?(refreshCount: number, maxRefresh: number): void;
  log?: { info(msg: string): void; debug(msg: string): void };
};

/**
 * Full QR login flow: fetch QR -> display -> poll until confirmed.
 */
export async function loginWithQR(opts?: {
  apiBaseUrl?: string;
  timeoutMs?: number;
  callbacks?: LoginCallbacks;
}): Promise<LoginResult> {
  const apiBaseUrl = opts?.apiBaseUrl ?? "https://ilinkai.weixin.qq.com";
  const timeoutMs = opts?.timeoutMs ?? 480_000;
  const cb = opts?.callbacks;
  const sessionKey = randomUUID();

  purgeExpiredLogins();

  let qrResponse: QRCodeResponse;
  try {
    qrResponse = await fetchQRCode(apiBaseUrl, DEFAULT_ILINK_BOT_TYPE);
  } catch (err) {
    return { connected: false, message: `Failed to get QR code: ${String(err)}` };
  }

  const login: ActiveLogin = {
    sessionKey,
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrResponse.qrcode_img_content,
    startedAt: Date.now(),
  };
  activeLogins.set(sessionKey, login);

  // Display QR
  if (cb?.onQRCode) {
    cb.onQRCode(login.qrcodeUrl);
  } else {
    console.log("\nScan the QR code with WeChat to connect:\n");
    try {
      const qrterm = await import("qrcode-terminal");
      await new Promise<void>((resolve) => {
        qrterm.default.generate(login.qrcodeUrl, { small: true }, (qr: string) => {
          console.log(qr);
          resolve();
        });
      });
    } catch {
      console.log(`QR Code URL: ${login.qrcodeUrl}`);
    }
  }

  const deadline = Date.now() + timeoutMs;
  let scannedNotified = false;
  let qrRefreshCount = 1;

  while (Date.now() < deadline) {
    try {
      const statusResponse = await pollQRStatus(apiBaseUrl, login.qrcode);

      switch (statusResponse.status) {
        case "wait":
          break;

        case "scaned":
          if (!scannedNotified) {
            cb?.onScanned?.();
            scannedNotified = true;
          }
          break;

        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            activeLogins.delete(sessionKey);
            return { connected: false, message: "Login timed out: QR code expired multiple times" };
          }
          cb?.onQRExpired?.(qrRefreshCount, MAX_QR_REFRESH_COUNT);
          try {
            const newQr = await fetchQRCode(apiBaseUrl, DEFAULT_ILINK_BOT_TYPE);
            login.qrcode = newQr.qrcode;
            login.qrcodeUrl = newQr.qrcode_img_content;
            login.startedAt = Date.now();
            scannedNotified = false;
            cb?.onQRCode?.(newQr.qrcode_img_content);
          } catch (refreshErr) {
            activeLogins.delete(sessionKey);
            return { connected: false, message: `Failed to refresh QR: ${String(refreshErr)}` };
          }
          break;
        }

        case "confirmed": {
          activeLogins.delete(sessionKey);
          if (!statusResponse.ilink_bot_id) {
            return { connected: false, message: "Login failed: server did not return ilink_bot_id" };
          }
          cb?.log?.info(`Login confirmed: bot_id=${statusResponse.ilink_bot_id}`);
          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "Connected to WeChat successfully",
          };
        }
      }
    } catch (err) {
      activeLogins.delete(sessionKey);
      return { connected: false, message: `Login failed: ${String(err)}` };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  activeLogins.delete(sessionKey);
  return { connected: false, message: "Login timed out, please retry." };
}
