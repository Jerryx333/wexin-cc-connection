/**
 * OpenClaw WeChat channel plugin entry point.
 *
 * Install: add this extension to your OpenClaw plugins directory or install via npm.
 * Configure in openclaw.json:
 *
 *   {
 *     "channels": {
 *       "weixin": {
 *         "token": "<bot_token from QR login>",
 *         "baseUrl": "https://ilinkai.weixin.qq.com",
 *         "dmPolicy": "pairing",
 *         "allowFrom": ["user-id-1", "user-id-2"]
 *       }
 *     }
 *   }
 *
 * Or run `openclaw onboard` and follow the WeChat setup wizard.
 */

import { weixinChannelPlugin } from "./src/channel.js";

export default {
  id: "weixin",
  name: "@openclaw/channel-weixin",
  description: "WeChat (微信) channel via iLink Bot protocol",
  plugin: weixinChannelPlugin,
};

// Re-export for direct SDK usage
export { weixinChannelPlugin } from "./src/channel.js";
export { loginWithQR } from "./src/login.js";
export { startLoginServer } from "./src/login-web.js";
export type { LoginResult } from "./src/login.js";
export type { WebLoginOptions } from "./src/login-web.js";
export type { InboundMessage, MessageHandler } from "./src/polling.js";
export type { ResolvedWeixinAccount } from "./src/accounts.js";
