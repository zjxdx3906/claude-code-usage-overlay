#!/usr/bin/env node
/* 服务商识别
 * ---------------------------------------------------------------------------
 * CC Switch 切换接入配置时，会把选中的那份 env 写进 ~/.claude/settings.json。
 * 所以「现在请求实际发给谁」有一份权威答案躺在那儿：env.ANTHROPIC_BASE_URL。
 * 本模块就是把它读出来，对到价目表应该用哪一套。
 *
 *   node provider.js          打印识别结果
 *
 * 两点必须说清楚：
 *
 * 1. 不看 ~/.cc-switch/cc-switch.db。那是 SQLite，读它要么引原生依赖，要么按
 *    字节扫文本猜 —— 前者太重，后者会把 provider 名字猜错。而 base_url 已经
 *    是权威信号了（CC Switch 正是靠它决定请求发给谁），不需要二手来源。
 * 2. CLI 报的 modelUsage[*].provider 是 "firstParty"，不管背后是 DeepSeek 还是
 *    智谱都一样 —— 那些都是 Anthropic 兼容端点，所以它在识别服务商这件事上
 *    没有信息量。模型名倒是有用（见 detect().models）。
 * ---------------------------------------------------------------------------
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// 域名 → 服务商。只列归属能确定的；认不出来就老实说认不出来，
// 别硬塞进一个看着像的名字里。
const HOSTS = [
  ["api.deepseek.com", { id: "deepseek", label: "DeepSeek" }],
  ["api.anthropic.com", { id: "anthropic", label: "Anthropic 官方" }],
  ["open.bigmodel.cn", { id: "zhipu", label: "智谱 GLM" }],
  ["api.z.ai", { id: "zhipu", label: "智谱 GLM" }],
  ["api.moonshot.cn", { id: "moonshot", label: "月之暗面 Kimi" }],
  ["api.moonshot.ai", { id: "moonshot", label: "月之暗面 Kimi" }],
  ["dashscope.aliyuncs.com", { id: "qwen", label: "阿里通义千问" }],
  ["api.siliconflow.cn", { id: "siliconflow", label: "硅基流动" }],
  ["api.siliconflow.com", { id: "siliconflow", label: "硅基流动" }],
  ["openrouter.ai", { id: "openrouter", label: "OpenRouter" }],
  ["api.minimaxi.com", { id: "minimax", label: "MiniMax" }],
  ["api.stepfun.com", { id: "stepfun", label: "阶跃星辰" }],
  ["api.lingyiwanwu.com", { id: "lingyi", label: "零一万物" }],
  ["api.xiaomimimo.com", { id: "mimo", label: "小米 MiMo" }],
];

// 本机地址：多半是本地代理 / 中转，价目表没法推，得靠手动绑定
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"];

const SETTINGS_PATHS = [
  path.join(os.homedir(), ".claude", "settings.json"),
  path.join(os.homedir(), ".claude", "settings.local.json"),
];

function readJSON(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return null;
  }
}

function hostOf(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  try {
    return new URL(s).hostname.toLowerCase();
  } catch (e) {
    // 没写协议的（"api.deepseek.com/anthropic"）补一个再试
    try {
      return new URL("https://" + s.replace(/^\/+/, "")).hostname.toLowerCase();
    } catch (e2) {
      return "";
    }
  }
}

function matchHost(host) {
  if (!host) return null;
  for (let i = 0; i < HOSTS.length; i++) {
    const h = HOSTS[i][0];
    if (host === h || host.endsWith("." + h)) return HOSTS[i][1];
  }
  if (LOCAL_HOSTS.indexOf(host) !== -1) {
    return { id: "local", label: "本地/中转 (" + host + ")" };
  }
  return null;
}

// 从 env 里把「模型实际上叫什么」捞出来。别名（claude-opus-5-5 之类）走
// ANTHROPIC_DEFAULT_*_MODEL 才能翻到真名。
function modelMap(env) {
  const out = {};
  for (const k of Object.keys(env || {})) {
    // 成对出现的 FOO_MODEL 与 FOO_MODEL_NAME 是同一个意思，只留一个
    const m = /^ANTHROPIC_DEFAULT_(\w+?)_MODEL$/.exec(k) || /^ANTHROPIC_DEFAULT_(\w+?)_MODEL_NAME$/.exec(k);
    if (m) out[m[1].toLowerCase()] = env[k];
  }
  return out;
}

function detect(opts) {
  opts = opts || {};
  const settingsFile = opts.settingsPath || SETTINGS_PATHS[0];
  const s = readJSON(settingsFile);
  const env = (s && s.env) || {};
  const baseUrl = env.ANTHROPIC_BASE_URL || "";
  const host = hostOf(baseUrl);
  const hit = matchHost(host);

  const out = {
    id: hit ? hit.id : (host ? "custom:" + host : "unknown"),
    label: hit ? hit.label : (host || "未设 base_url"),
    baseUrl: baseUrl,
    host: host,
    // 认不出来的服务商：价目表按别的家填的，必须报警而不是硬算
    known: !!hit,
    // ANTHROPIC_BASE_URL 没设 = 直连官方
    official: !baseUrl,
    model: env.ANTHROPIC_MODEL || "",
    models: modelMap(env),
    settingsPath: settingsFile,
    detectedAt: new Date().toISOString(),
  };
  if (!baseUrl) {
    out.id = "anthropic";
    out.label = "Anthropic 官方（未设 base_url）";
    out.known = true;
    out.official = true;
  }
  return out;
}

module.exports = { detect, matchHost, hostOf, HOSTS };

/* ---------------------------------------------------------------- CLI */

if (require.main === module) {
  const p = detect();
  const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
  console.log(c.bold("\n当前接入配置\n"));
  console.log("  服务商    " + p.label + (p.known ? "" : "  ⚠ 认不出来"));
  console.log("  id        " + p.id);
  console.log("  base_url  " + (p.baseUrl || c.dim("(未设 → 直连官方)")));
  if (p.model) console.log("  主模型    " + p.model);
  const ks = Object.keys(p.models);
  if (ks.length) {
    console.log("  别名映射");
    ks.forEach((k) => console.log("              " + k.padEnd(10) + " → " + p.models[k]));
  }
  console.log("  读自      " + c.dim(p.settingsPath));
  console.log("");
}
