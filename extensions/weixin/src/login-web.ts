/**
 * Web-based QR login for WeChat iLink.
 * Starts a local HTTP server, shows a QR code page in the browser,
 * polls status via SSE, and saves credentials to OpenClaw config on success.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_PORT = 9847;
const DEFAULT_ILINK_BASE = "https://ilinkai.weixin.qq.com";
const DEFAULT_ILINK_BOT_TYPE = "3";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const LOGIN_TIMEOUT_MS = 480_000;
const MAX_QR_REFRESH_COUNT = 3;

// ===========================================================================
// iLink QR helpers (inline to keep login-web self-contained)
// ===========================================================================

interface QRCodeResponse { qrcode: string; qrcode_img_content: string }
interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

function trail(url: string): string { return url.endsWith("/") ? url : `${url}/`; }

async function fetchQR(base: string): Promise<QRCodeResponse> {
  const url = `${trail(base)}ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_ILINK_BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return res.json() as Promise<QRCodeResponse>;
}

async function pollStatus(base: string, qrcode: string): Promise<StatusResponse> {
  const url = `${trail(base)}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "iLink-App-ClientVersion": "1" }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    return res.json() as Promise<StatusResponse>;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    throw err;
  }
}

// ===========================================================================
// Config persistence
// ===========================================================================

function openclawConfigPath(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

type AnyConfig = Record<string, unknown>;

function readConfig(): AnyConfig {
  try {
    return JSON.parse(fs.readFileSync(openclawConfigPath(), "utf-8")) as AnyConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: AnyConfig): void {
  const dir = path.dirname(openclawConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(openclawConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

function saveCredentials(creds: { token: string; baseUrl: string; userId?: string; accountId?: string }): void {
  const cfg = readConfig();
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const weixin = (channels.weixin ?? {}) as Record<string, unknown>;

  weixin.token = creds.token;
  weixin.baseUrl = creds.baseUrl;
  if (creds.userId) weixin.userId = creds.userId;

  channels.weixin = weixin;
  cfg.channels = channels;
  writeConfig(cfg);
}

// ===========================================================================
// HTML page
// ===========================================================================

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw - WeChat Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh;
  }
  .card {
    background: #1a1a1a; border-radius: 16px; padding: 40px;
    text-align: center; max-width: 420px; width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  h1 { font-size: 24px; margin-bottom: 8px; color: #fff; }
  .subtitle { font-size: 14px; color: #888; margin-bottom: 32px; }
  #qr-container {
    background: #fff; border-radius: 12px; padding: 16px;
    display: inline-block; margin-bottom: 24px;
    min-width: 200px; min-height: 200px;
    display: flex; align-items: center; justify-content: center;
  }
  #qr-container img { width: 200px; height: 200px; image-rendering: pixelated; }
  #status {
    font-size: 16px; padding: 12px 24px;
    border-radius: 8px; background: #222; color: #aaa;
    transition: all 0.3s;
  }
  #status.scanned { background: #1a2e1a; color: #4ade80; }
  #status.success { background: #1a2e1a; color: #22c55e; font-weight: 600; }
  #status.error { background: #2e1a1a; color: #ef4444; }
  #status.refreshing { background: #2e2a1a; color: #facc15; }
  .spinner {
    display: inline-block; width: 16px; height: 16px;
    border: 2px solid #555; border-top-color: #aaa;
    border-radius: 50%; animation: spin 0.8s linear infinite;
    vertical-align: middle; margin-right: 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .logo { font-size: 40px; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">&#x1f99e;</div>
  <h1>OpenClaw WeChat</h1>
  <p class="subtitle">Scan with WeChat to connect</p>
  <div id="qr-container"><div class="spinner"></div></div>
  <div id="status"><span class="spinner"></span>Loading QR code...</div>
</div>
<script>
const qrContainer = document.getElementById("qr-container");
const statusEl = document.getElementById("status");

const es = new EventSource("/events");

es.addEventListener("qr", (e) => {
  const url = e.data;
  qrContainer.innerHTML = '<img src="' + url + '" alt="QR Code">';
  statusEl.className = "";
  statusEl.innerHTML = '<span class="spinner"></span>Waiting for scan...';
});

es.addEventListener("scanned", () => {
  statusEl.className = "scanned";
  statusEl.textContent = "Scanned! Confirm on your phone...";
});

es.addEventListener("refreshing", (e) => {
  statusEl.className = "refreshing";
  statusEl.textContent = "QR expired, refreshing... (" + e.data + ")";
});

es.addEventListener("success", (e) => {
  statusEl.className = "success";
  statusEl.textContent = "Connected! Token saved to openclaw.json";
  es.close();
  setTimeout(() => { statusEl.textContent += " — you can close this page."; }, 1500);
});

es.addEventListener("error_msg", (e) => {
  statusEl.className = "error";
  statusEl.textContent = e.data;
  es.close();
});

es.onerror = () => {
  statusEl.className = "error";
  statusEl.textContent = "Connection lost. Refresh to retry.";
};
</script>
</body>
</html>`;

// ===========================================================================
// Server
// ===========================================================================

export type WebLoginOptions = {
  port?: number;
  apiBaseUrl?: string;
  openBrowser?: boolean;
  onSuccess?: (creds: { token: string; baseUrl: string; userId?: string; accountId?: string }) => void;
  log?: { info(msg: string): void; error(msg: string): void };
};

export async function startLoginServer(opts?: WebLoginOptions): Promise<{
  url: string;
  close: () => void;
}> {
  const port = opts?.port ?? DEFAULT_PORT;
  const apiBase = opts?.apiBaseUrl ?? DEFAULT_ILINK_BASE;
  const log = opts?.log ?? { info: console.log, error: console.error };

  let sseResponse: http.ServerResponse | null = null;
  let loginDone = false;
  let serverInstance: http.Server;

  function sendSSE(event: string, data: string): void {
    if (sseResponse && !sseResponse.destroyed) {
      sseResponse.write(`event: ${event}\ndata: ${data}\n\n`);
    }
  }

  // Login flow runs in background once SSE connects
  async function runLoginFlow(): Promise<void> {
    let qr: QRCodeResponse;
    try {
      qr = await fetchQR(apiBase);
    } catch (err) {
      sendSSE("error_msg", `Failed to get QR code: ${String(err)}`);
      return;
    }

    // QR code: generate a data URL via a simple QR library URL
    // Since qrcode_img_content is already a URL the user can scan, send it as-is
    // For display, we use a QR code API to render the URL as an image
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr.qrcode_img_content)}`;
    sendSSE("qr", qrImageUrl);

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let scannedSent = false;
    let refreshCount = 1;

    while (Date.now() < deadline && !loginDone) {
      try {
        const status = await pollStatus(apiBase, qr.qrcode);

        switch (status.status) {
          case "wait":
            break;

          case "scaned":
            if (!scannedSent) {
              sendSSE("scanned", "");
              scannedSent = true;
            }
            break;

          case "expired": {
            refreshCount++;
            if (refreshCount > MAX_QR_REFRESH_COUNT) {
              sendSSE("error_msg", "QR code expired too many times. Please refresh the page.");
              return;
            }
            sendSSE("refreshing", `${refreshCount}/${MAX_QR_REFRESH_COUNT}`);
            try {
              const newQr = await fetchQR(apiBase);
              qr = newQr;
              scannedSent = false;
              const newImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(newQr.qrcode_img_content)}`;
              sendSSE("qr", newImgUrl);
            } catch (refreshErr) {
              sendSSE("error_msg", `Failed to refresh QR: ${String(refreshErr)}`);
              return;
            }
            break;
          }

          case "confirmed": {
            loginDone = true;
            if (!status.bot_token || !status.ilink_bot_id) {
              sendSSE("error_msg", "Login failed: server did not return credentials");
              return;
            }

            const creds = {
              token: status.bot_token,
              baseUrl: status.baseurl ?? apiBase,
              userId: status.ilink_user_id,
              accountId: status.ilink_bot_id,
            };

            // Save to openclaw.json
            saveCredentials(creds);
            log.info(`WeChat login success: accountId=${creds.accountId}, token saved to ${openclawConfigPath()}`);

            sendSSE("success", JSON.stringify({ accountId: creds.accountId }));
            opts?.onSuccess?.(creds);

            // Auto-close server after a short delay
            setTimeout(() => { serverInstance.close(); }, 3000);
            return;
          }
        }
      } catch (err) {
        sendSSE("error_msg", `Login error: ${String(err)}`);
        return;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!loginDone) {
      sendSSE("error_msg", "Login timed out. Please refresh to retry.");
    }
  }

  return new Promise((resolve, reject) => {
    serverInstance = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML_PAGE);
        return;
      }

      if (req.url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("\n");
        sseResponse = res;

        req.on("close", () => { sseResponse = null; });

        // Start the login flow
        loginDone = false;
        runLoginFlow().catch((err) => {
          log.error(`Login flow error: ${String(err)}`);
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    serverInstance.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}`;
      log.info(`WeChat login server running at ${url}`);

      // Try to open browser
      if (opts?.openBrowser !== false) {
        const open = process.platform === "darwin" ? "open"
          : process.platform === "win32" ? "start"
          : "xdg-open";
        import("node:child_process").then(({ exec }) => {
          exec(`${open} ${url}`);
        }).catch(() => {});
      }

      resolve({
        url,
        close: () => serverInstance.close(),
      });
    });

    serverInstance.on("error", reject);
  });
}

// ===========================================================================
// CLI entry: run directly with `npx tsx extensions/weixin/src/login-web.ts`
// ===========================================================================

const isMain = process.argv[1] && (
  process.argv[1].endsWith("login-web.ts") ||
  process.argv[1].endsWith("login-web.js")
);

if (isMain) {
  const port = parseInt(process.argv[2] ?? "", 10) || DEFAULT_PORT;
  startLoginServer({ port }).then(({ url }) => {
    console.log(`\nOpen ${url} in your browser to scan the WeChat QR code.\n`);
    console.log("Credentials will be saved to ~/.openclaw/openclaw.json automatically.\n");
  }).catch((err) => {
    console.error("Failed to start login server:", err);
    process.exit(1);
  });
}
