#!/usr/bin/env node
/* 把 usage-overlay.js 装进官方 Claude Code 扩展
 * ---------------------------------------------------------------------------
 *   node apply.js           装上（幂等，重复跑不会重复注入）
 *   node apply.js --status  看看装没装
 *   node apply.js --revert  还原成官方原版
 *
 * 干了两件事：
 *   1. 把 usage-overlay.js（前面拼上 config.json 的内容）拷进扩展的 webview/ 目录
 *   2. 在 extension.js 生成 webview HTML 的那段模板里插一个 <script>，加载它
 *
 * 扩展每次自动升级会换一个新版本目录，补丁就没了 —— 重跑一次本脚本即可。
 * ---------------------------------------------------------------------------
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { detect: detectProvider } = require("./provider.js");

const HERE = __dirname;
const EXT_ROOT = path.join(os.homedir(), ".vscode", "extensions");
const EXT_PREFIX = "anthropic.claude-code-";
const OVERLAY_NAME = "usage-overlay.js";
const BACKUP_SUFFIX = ".bak-usage-overlay";

// extension.js 里生成 webview HTML 的那行 script 标签，全文件唯一
const ANCHOR =
  '<script nonce="${B}" src="${G}" type="module"></script>';

// ⚠️ 用普通字符串拼接，绝不能用模板字符串，否则 ${B} 会被 Node 插值掉
const INJECT =
  ANCHOR +
  '<script nonce="${B}" src="${$.asWebviewUri(S1.Uri.joinPath(this.extensionUri,"webview","' +
  OVERLAY_NAME +
  '"))}"></script>';

// CSP 里脚本来源，顺带把扩展自己的资源域放行，作为 nonce 之外的兜底
const CSP_ANCHOR = "script-src 'nonce-${B}';";
const CSP_INJECT = "script-src 'nonce-${B}' ${$.cspSource};";

const MARKER = OVERLAY_NAME; // 用它判断是否已注入

/* ---------------------------------------------------------------- utils */

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function log(...a) {
  console.log(...a);
}

function findExtensions() {
  let names;
  try {
    names = fs.readdirSync(EXT_ROOT);
  } catch (e) {
    return [];
  }
  return names
    .filter((n) => n.startsWith(EXT_PREFIX) && fs.statSync(path.join(EXT_ROOT, n)).isDirectory())
    .map((n) => path.join(EXT_ROOT, n))
    .filter((p) => fs.existsSync(path.join(p, "extension.js")))
    .sort();
}

// 用 node 自己解析一遍，确认语法没被改坏
function syntaxCheck(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  return { ok: r.status === 0, err: (r.stderr || "").trim() };
}

function readConfig() {
  const f = path.join(HERE, "config.json");
  try {
    const raw = fs.readFileSync(f, "utf8");
    const stripped = raw.replace(/^\s*\/\/.*$/gm, ""); // 容错：允许整行注释
    return JSON.parse(stripped);
  } catch (e) {
    log(c.yellow(`  ! config.json 读取失败（${e.message}），改用内置默认值`));
    return {};
  }
}

/* ---------------------------------------------------------------- actions */

function status() {
  const dirs = findExtensions();
  if (!dirs.length) {
    log(c.red("没找到任何 anthropic.claude-code-* 扩展目录"));
    return;
  }
  log(c.bold("\nClaude Code 扩展 · usage overlay 安装状态\n"));
  for (const dir of dirs) {
    const ext = path.join(dir, "extension.js");
    const src = fs.readFileSync(ext, "utf8");
    const patched = src.includes(MARKER);
    const hasFile = fs.existsSync(path.join(dir, "webview", OVERLAY_NAME));
    const hasBackup = fs.existsSync(ext + BACKUP_SUFFIX);
    const tag = patched && hasFile ? c.green("已安装") : c.dim("未安装");
    log(`  ${path.basename(dir)}  ${tag}`);
    log(c.dim(`     补丁:${patched ? "有" : "无"}  资源:${hasFile ? "有" : "无"}  备份:${hasBackup ? "有" : "无"}`));
  }
  log("");
}

function revert() {
  const dirs = findExtensions();
  let n = 0;
  for (const dir of dirs) {
    const ext = path.join(dir, "extension.js");
    const bak = ext + BACKUP_SUFFIX;
    if (!fs.existsSync(bak)) {
      log(c.dim(`  ${path.basename(dir)}  没有备份，跳过`));
      continue;
    }
    fs.copyFileSync(bak, ext);
    const o = path.join(dir, "webview", OVERLAY_NAME);
    if (fs.existsSync(o)) fs.unlinkSync(o);
    log(c.green(`  ✓ ${path.basename(dir)}  已还原`));
    n++;
  }
  log(n ? c.green(`\n还原了 ${n} 个扩展，重载窗口后生效。`) : c.yellow("\n没有可还原的备份。"));
}

function apply() {
  const dirs = findExtensions();
  if (!dirs.length) {
    log(c.red(`没找到扩展目录：${EXT_ROOT}\\${EXT_PREFIX}*`));
    process.exit(1);
  }

  const cfg = readConfig();

  // 服务商是每次 apply 现读的，不采信 config.json 里的旧值 —— CC Switch 换一份
  // 接入配置就会改写 ~/.claude/settings.json，那份才是"请求实际发给谁"的答案。
  // 用户在齿轮面板里手改过的话，会在 localStorage 覆盖掉这里（见 usage-overlay.js）。
  const prov = detectProvider();
  const oldLabel = cfg.provider && cfg.provider.label;
  cfg.provider = {
    id: prov.id,
    label: prov.label,
    baseUrl: prov.baseUrl,
    known: prov.known,
    official: prov.official,
    // 这份是自动识别的；用户手改后 usage-overlay.js 会标成 "manual"
    source: "auto",
    model: prov.model,
    models: prov.models,
    detectedAt: prov.detectedAt,
  };
  if (oldLabel && oldLabel !== prov.label) {
    log(c.yellow(`  ! 服务商换过了：${oldLabel} → ${prov.label}（价目表还是按旧的那家填的，可能需要改）`));
  }

  const overlaySrc = fs.readFileSync(path.join(HERE, OVERLAY_NAME), "utf8");
  const bundled =
    "/* 由 apply.js 自动生成 —— 改内容请改 ~/.claude/usage-overlay/usage-overlay.js 和 config.json，然后重跑 apply.js */\n" +
    "window.__CLAUDE_USAGE_OVERLAY_CONFIG__ = " +
    JSON.stringify(cfg, null, 2) +
    ";\n" +
    overlaySrc;

  // 先确认浮层源码本身语法没问题
  const tmp = path.join(os.tmpdir(), "cuo-check-" + Date.now() + ".js");
  fs.writeFileSync(tmp, bundled, "utf8");
  const pre = syntaxCheck(tmp);
  fs.unlinkSync(tmp);
  if (!pre.ok) {
    log(c.red("usage-overlay.js 语法有问题，已中止：\n" + pre.err));
    process.exit(1);
  }

  log(c.bold("\nClaude Code 扩展 · 安装 usage overlay\n"));

  let done = 0;
  for (const dir of dirs) {
    const name = path.basename(dir);
    const ext = path.join(dir, "extension.js");
    const webviewDir = path.join(dir, "webview");

    let src = fs.readFileSync(ext, "utf8");

    // --- 幂等：已注入就只刷新资源文件 ---
    if (src.includes(MARKER)) {
      fs.writeFileSync(path.join(webviewDir, OVERLAY_NAME), bundled, "utf8");
      log(`  ${name}  ${c.dim("已安装，已更新资源文件")}`);
      done++;
      continue;
    }

    if (!src.includes(ANCHOR)) {
      log(`  ${name}  ${c.yellow("找不到注入锚点，跳过（扩展结构可能变了）")}`);
      continue;
    }

    // --- 备份（只备一次）---
    const bak = ext + BACKUP_SUFFIX;
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(ext, bak);
    }

    // 原文件本身能不能过语法检查？不能的话就不拿它当判据
    const baselineOk = syntaxCheck(ext).ok;

    // --- 注入 ---
    let out = src.replace(ANCHOR, INJECT);
    if (out === src) {
      log(`  ${name}  ${c.red("替换失败")}`);
      continue;
    }
    if (out.includes(CSP_ANCHOR)) {
      out = out.replace(CSP_ANCHOR, CSP_INJECT);
    }

    fs.writeFileSync(ext, out, "utf8");

    // --- 校验，坏了就回滚 ---
    const chk = syntaxCheck(ext);
    if (baselineOk && !chk.ok) {
      fs.copyFileSync(bak, ext);
      log(`  ${name}  ${c.red("语法校验失败，已自动回滚")}`);
      log(c.dim("      " + chk.err.split("\n").slice(0, 3).join("\n      ")));
      continue;
    }
    if (!baselineOk) {
      log(`  ${name}  ${c.yellow("注意：原文件本来就过不了 node --check，跳过校验")}`);
    }

    fs.writeFileSync(path.join(webviewDir, OVERLAY_NAME), bundled, "utf8");
    log(`  ${name}  ${c.green("✓ 注入成功")}`);
    done++;
  }

  log("");
  if (done) {
    log(c.green(`完成 ${done} 个。`) + " 现在在 VS Code 里按 " + c.bold("Ctrl+Shift+P → Developer: Reload Window") + " 重载，浮层就会出现。");
    log(c.dim("随时可以 `node apply.js --status` 查状态，`--revert` 还原。"));
  } else {
    log(c.yellow("没有做任何改动。"));
  }
  log("");
}

/* ---------------------------------------------------------------- main */

const arg = (process.argv[2] || "").toLowerCase();
if (arg === "--status" || arg === "-s") status();
else if (arg === "--revert" || arg === "-r") revert();
else apply();
