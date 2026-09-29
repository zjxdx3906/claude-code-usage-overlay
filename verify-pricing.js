#!/usr/bin/env node
/* 用本机转写文件反查价目表准不准
 * ---------------------------------------------------------------------------
 *   node verify-pricing.js            近 30 天
 *   node verify-pricing.js 7          近 7 天
 *   node verify-pricing.js 30 12.6    指定天数 + 拿它跟 DeepSeek 账单金额对比
 *
 * 数据源：~/.claude/projects/ 下所有 jsonl 里每条 assistant 消息的 usage。
 * 按 message.id 去重（同一会话被 resume/fork 时同一条消息会出现在多个文件里）。
 * ---------------------------------------------------------------------------
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DAYS = parseInt(process.argv[2], 10) || 30;
const BILL = process.argv[3] ? parseFloat(process.argv[3]) : null;
const PROJECTS = path.join(os.homedir(), ".claude", "projects");

// 与 config.json 保持一致（人民币 / 百万 token）
const PRICING = {
  flash: { idle: { h: 0.02, m: 1.0, o: 2.0 }, peak: { h: 0.04, m: 2.0, o: 4.0 } },
  pro: { idle: { h: 0.025, m: 3.0, o: 6.0 }, peak: { h: 0.05, m: 6.0, o: 12.0 } }
};

const DAY = 86400000;
const since = Date.now() - DAYS * DAY;

function isPeak(t) {
  const d = new Date(t + (new Date(t).getTimezoneOffset() + 480) * 60000); // 北京
  const w = d.getDay();
  if (w === 0 || w === 6) return false;
  const x = d.getHours() * 60 + d.getMinutes();
  return (x >= 540 && x < 720) || (x >= 840 && x < 1080);
}

// 按 ~/.claude/settings.json 里的 env 映射：
//   OPUS/FABLE/HAIKU -> deepseek-v4-pro ，SONNET/子代理 -> deepseek-flash
// 早期会话的转写里记的是 claude-opus-5-5 / claude-sonnet-5 这类原始名，也要认
function pricingKey(model) {
  const m = String(model || "").toLowerCase();
  if (/flash|sonnet|haiku/.test(m)) return "flash";
  if (/pro|opus|fable/.test(m)) return "pro";
  return "pro";
}

function collect(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { collect(p, out); continue; }
    if (!e.name.endsWith(".jsonl")) continue;
    let raw;
    try { raw = fs.readFileSync(p, "utf8"); } catch (err) { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch (err) { continue; }
      const m = o.message;
      if (o.type !== "assistant" || !m || !m.usage || !m.id) continue;
      const t = Date.parse(o.timestamp || "");
      if (!(t >= since)) continue;
      out.set(m.id, {
        model: m.model || "",
        t: t,
        i: m.usage.input_tokens || 0,
        cr: m.usage.cache_read_input_tokens || 0,
        cc: m.usage.cache_creation_input_tokens || 0,
        o: m.usage.output_tokens || 0
      });
    }
  }
}

const msgs = new Map();
collect(PROJECTS, msgs);

const dist = {};
const byModel = {};
let peakN = 0;
for (const v of msgs.values()) {
  dist[v.model] = (dist[v.model] || 0) + 1;
  const b = (byModel[v.model] = byModel[v.model] || { n: 0, i: 0, cr: 0, cc: 0, o: 0, cost: 0 });
  b.n++; b.i += v.i; b.cr += v.cr; b.cc += v.cc; b.o += v.o;
  if (isPeak(v.t)) peakN++;
}

function calc(usePeak, forceKey) {
  let cost = 0, tok = 0;
  for (const v of msgs.values()) {
    const key = forceKey || pricingKey(v.model);
    const r = PRICING[key][usePeak && isPeak(v.t) ? "peak" : "idle"];
    cost += (v.i / 1e6) * r.m + (v.cr / 1e6) * r.h + (v.cc / 1e6) * r.m + (v.o / 1e6) * r.o;
    tok += v.i + v.cr + v.cc + v.o;
  }
  return { cost, tok };
}

const n = (x) => x.toLocaleString("en-US");

console.log(`\n近 ${DAYS} 天 · 本机转写统计（按 message.id 去重）\n`);
console.log(`  请求数        ${n(msgs.size)}   （其中高峰时段 ${peakN}）`);
console.log(`  输入(未命中)  ${n([...msgs.values()].reduce((s, v) => s + v.i, 0))}`);
console.log(`  缓存读取      ${n([...msgs.values()].reduce((s, v) => s + v.cr, 0))}`);
console.log(`  缓存写入      ${n([...msgs.values()].reduce((s, v) => s + v.cc, 0))}`);
console.log(`  输出          ${n([...msgs.values()].reduce((s, v) => s + v.o, 0))}`);

console.log("\n  按模型明细");
for (const k in byModel) {
  const b = byModel[k];
  console.log(`    ${(k || "(空)").padEnd(24)} req=${String(b.n).padStart(4)}  in=${n(b.i).padStart(12)}  cr=${n(b.cr).padStart(12)}  out=${n(b.o).padStart(9)}`);
}

console.log("\n  各种计价假设");
const rows = [
  ["全部 flash · 空闲价", calc(false, "flash")],
  ["全部 flash · 含高峰", calc(true, "flash")],
  ["全部 pro   · 空闲价", calc(false, "pro")],
  ["flash/pro 混合 · 空闲价", calc(false)],
  ["flash/pro 混合 · 含高峰", calc(true)]
];
for (const [label, r] of rows) {
  console.log(`    ${label.padEnd(26)} ¥${r.cost.toFixed(2).padStart(9)}   (${n(r.tok)} tokens)`);
}

if (BILL) {
  const r = calc(true);
  console.log(`\n  对比 DeepSeek 账单 ¥${BILL.toFixed(2)}`);
  console.log(`    本机算得 ¥${r.cost.toFixed(2)}  →  ${(r.cost / BILL).toFixed(2)}x`);
  console.log(`    账单 ¥${BILL.toFixed(2)} 的隐含单价 ≈ flash 空价格的 ${(BILL / r.cost).toFixed(2)} 倍`);
}

console.log("\n  提示：本机转写只覆盖在**这台机器上用 Claude Code** 产生的调用。");
console.log("  如果账号还在别处（网页版、其他工具、其他机器）用过同一个 key，");
console.log("  本机统计会低于账单，这是正常的，不代表价目表错。\n");
