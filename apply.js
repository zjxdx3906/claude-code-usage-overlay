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

// 注入点的几个变量名一律从 extension.js 里现学，一个都不写死。
// 2.1.284 → 2.1.285 就一次改了三处：nonce 变量 B→V、vscode 模块别名 S1→y1。
// 写死的后果不是"注入失败"而是"注入一段 ReferenceError" —— 补丁装上、
// 资源拷好、语法检查也过，要到用户重载窗口才发现浮层不出现。
function learn(src) {
  // JS 标识符允许 $，压缩器很爱用（webview 实例就叫 $）—— 别用 \w，那匹配不到它
  const ID = "[A-Za-z_$][\\w$]*";
  // 生成 webview HTML 的那行 script 标签，全文件唯一
  const anchor = src.match(new RegExp(
    '<script nonce="\\$\\{(' + ID + ')\\}" src="\\$\\{(' + ID + ')\\}" type="module"></script>'));
  if (!anchor) return null;
  // 函数定义（6 个参数）的第一个参数就是 webview 实例。
  // 注意别拿调用点 getHtmlForWebview($.webview,void 0,...) 去匹配。
  const def = src.match(new RegExp(
    "getHtmlForWebview\\((" + ID + "),(" + ID + "),(" + ID + "),(" + ID + "),(" + ID + "),(" + ID + ")\\)\\{"));
  if (!def) return null;
  // vscode 模块别名：从既有的 y1.Uri.joinPath(this.extensionUri,"webview","index.js") 里认
  const mod = src.match(new RegExp(
    "(" + ID + ")\\.Uri\\.joinPath\\(this\\.extensionUri,\"webview\",\"index\\.js\"\\)"));
  if (!mod) return null;
  return {
    anchor: anchor[0],
    nonce: anchor[1],
    webview: def[1],
    vscode: mod[1],
  };
}

// ⚠️ 用普通字符串拼接，绝不能用模板字符串，否则 ${...} 会被 Node 插值掉
function buildInject(L) {
  return (
    L.anchor +
    '<script nonce="${' + L.nonce + '}" src="${' + L.webview + '.asWebviewUri(' +
    L.vscode + '.Uri.joinPath(this.extensionUri,"webview","' + OVERLAY_NAME + '"))}"></script>'
  );
}

// CSP 里脚本来源，顺带把扩展自己的资源域放行，作为 nonce 之外的兜底
function buildCsp(L) {
  return {
    from: "script-src 'nonce-${" + L.nonce + "}';",
    to: "script-src 'nonce-${" + L.nonce + "}' ${" + L.webview + ".cspSource};",
  };
}

const MARKER = OVERLAY_NAME; // 用它判断是否已注入

/* ---------------------------------------------------------------- utils */

// 输出重定向到文件时不要塞 ANSI 转义 —— autorepair.vbs 就是这么调用的，
// 否则日志里全是 [1m [0m 这种噪声，真正有用的那行反而看不清
const COLOR = !!process.stdout.isTTY;

const c = {
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
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
    if (!patched) {
      const L = learn(src);
      log(c.dim("     注入点:" + (L
        ? `找到了（nonce=${L.nonce} webview=${L.webview} vscode=${L.vscode}）—— 跑 node apply.js 装上`
        : c.yellow("找不到，扩展结构可能变了，需要人工看一眼"))));
    }
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

    const L = learn(src);
    if (!L) {
      log(`  ${name}  ${c.yellow("找不到注入锚点，跳过（扩展结构可能变了）")}`);
      log(c.dim("      这次要人工看一眼了：getHtmlForWebview 里的 script 标签或函数签名改了。"));
      log(c.dim("      找 " + OVERLAY_NAME + " 需要的四样东西：script 标签原文、nonce 变量名、webview 实例名、vscode 模块别名。"));
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
    let out = src.replace(L.anchor, buildInject(L));
    if (out === src) {
      log(`  ${name}  ${c.red("替换失败")}`);
      continue;
    }
    const csp = buildCsp(L);
    if (out.includes(csp.from)) {
      out = out.replace(csp.from, csp.to);
    } else {
      log(c.dim(`      （CSP 里没找到 ${csp.from}，只靠 nonce 放行）`));
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

// learn/buildInject/buildCsp 给 test.js 用 —— 扩展一改名就得有人守着，
// 所以让它们可以被 require 进来单独测，而不是只能整个脚本跑一遍看结果。
module.exports = { learn, buildInject, buildCsp };

if (require.main === module) {
  const arg = (process.argv[2] || "").toLowerCase();
  if (arg === "--status" || arg === "-s") status();
  else if (arg === "--revert" || arg === "-r") revert();
  else apply();
}
