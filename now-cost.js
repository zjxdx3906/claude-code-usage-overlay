#!/usr/bin/env node
/* 算「当前这个会话」按真实价目应该显示多少钱，用来跟浮层对账
 *   node now-cost.js            当前会话全量
 *   node now-cost.js 15         只看最近 15 分钟
 * 自动挑 ~/.claude/projects/ 下最近改动过的那个 jsonl。
 */
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");

const MINUTES = parseFloat(process.argv[2]) || 0;

// 与 config.json 一致：人民币 / 百万 token
const PRICING = {
  flash: { idle: { h: 0.02, m: 1.0, o: 2.0 }, peak: { h: 0.04, m: 2.0, o: 4.0 } },
  pro: { idle: { h: 0.025, m: 3.0, o: 6.0 }, peak: { h: 0.05, m: 6.0, o: 12.0 } }
};

function pricingKey(model) {
  const m = String(model || "").toLowerCase();
  if (/flash|sonnet|haiku/.test(m)) return "flash";
  if (/pro|opus|fable/.test(m)) return "pro";
  return "pro";
}

function isPeak(t) {
  const d = new Date(t + (new Date(t).getTimezoneOffset() + 480) * 60000); // 北京
  const w = d.getDay();
  if (w === 0 || w === 6) return false;
  const x = d.getHours() * 60 + d.getMinutes();
  return (x >= 540 && x < 720) || (x >= 840 && x < 1080);
}

const root = path.join(os.homedir(), ".claude", "projects");
let best = null;
(function walk(d) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith(".jsonl")) continue;
    try { const s = fs.statSync(p); if (!best || s.mtimeMs > best.m) best = { p, m: s.mtimeMs }; } catch (err) {}
  }
})(root);

if (!best) { console.log("没找到转写文件"); process.exit(1); }

const cutoff = MINUTES > 0 ? Date.now() - MINUTES * 60000 : 0;
const byId = new Map();
for (const line of fs.readFileSync(best.p, "utf8").split("\n")) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch (e) { continue; }
  const m = o.message;
  if (o.type !== "assistant" || !m || !m.usage || !m.id) continue;
  const t = Date.parse(o.timestamp || "");
  if (t < cutoff) continue;
  // 按 id 覆盖，不是累加 —— 同一个 id 会重复推送
  byId.set(m.id, {
    model: m.model || "", t,
    i: m.usage.input_tokens || 0,
    cr: m.usage.cache_read_input_tokens || 0,
    cc: m.usage.cache_creation_input_tokens || 0,
    o: m.usage.output_tokens || 0
  });
}

let cost = 0, tok = 0, peakN = 0;
const byModel = {};
for (const v of byId.values()) {
  const key = pricingKey(v.model);
  const pk = isPeak(v.t);
  if (pk) peakN++;
  const r = PRICING[key][pk ? "peak" : "idle"];
  cost += (v.i / 1e6) * r.m + (v.cr / 1e6) * r.h + (v.cc / 1e6) * r.m + (v.o / 1e6) * r.o;
  tok += v.i + v.cr + v.cc + v.o;
  const b = (byModel[key] = byModel[key] || { n: 0, cost: 0 });
  b.n++; b.cost += (v.i / 1e6) * r.m + (v.cr / 1e6) * r.h + (v.cc / 1e6) * r.m + (v.o / 1e6) * r.o;
}

const n = (x) => x.toLocaleString("en-US");
console.log("\n现在: " + new Date().toLocaleString("zh-CN"));
console.log("会话: " + path.basename(best.p, ".jsonl"));
console.log("范围: " + (MINUTES > 0 ? "最近 " + MINUTES + " 分钟" : "整个会话") + "（按 message.id 去重后）\n");
console.log("  请求数   " + byId.size + "   （高峰时段 " + peakN + "）");
console.log("  总 token " + n(tok));
for (const k in byModel) {
  console.log("    " + k.padEnd(6) + " req=" + String(byModel[k].n).padStart(4) + "   ¥" + byModel[k].cost.toFixed(4));
}
console.log("\n  合计     ¥" + cost.toFixed(4) + "   ← 浮层上「本会话」应显示这个数\n");
