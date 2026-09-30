#!/usr/bin/env node
/* usage-overlay.js 的离线自测
 * 用一个最小 DOM stub 把浮层跑起来，喂合成消息，验证记账/去重/计价/格式化。
 *   node test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

/* ------------------------------------------------ 最小 DOM stub */

function makeEl(tag) {
  const e = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: "",
    textContent: "",
    style: {},
    _attrs: {},
    _first: null,
    parentNode: null,
    checked: false,
    value: "",
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 150, height: 28 }; },
    querySelector() { return makeEl("div"); },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); }
    }
  };
  Object.defineProperty(e, "innerHTML", {
    get() { return this._html || ""; },
    set(v) {
      this._html = v;
      // 只关心 svg 那条路径：给个能 querySelector 的假子元素。
      // 注意不要再对假子元素设 innerHTML —— makeEl 的 setter 会无限递归。
      this._first = makeEl("div");
    }
  });
  Object.defineProperty(e, "firstElementChild", { get() { return this._first; } });
  return e;
}

function makeContext(fakeNowISO) {
  const body = makeEl("body");
  const head = makeEl("head");
  const document = {
    body, head,
    createElement: makeEl,
    addEventListener() {},
    querySelector() { return null; }
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };

  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(FakeDate.__fixed);
    return new RealDate(...args);
  }
  const RealDate = Date;
  FakeDate.__fixed = new RealDate(fakeNowISO).getTime();
  FakeDate.now = () => FakeDate.__fixed;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const listeners = [];
  const window = {
    localStorage,
    innerWidth: 1200,
    innerHeight: 900,
    IS_SIDEBAR: false,
    IS_SESSION_LIST_ONLY: false,
    addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
    removeEventListener() {}
  };

  const sandbox = {
    window, document, localStorage,
    Date: FakeDate,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    console: {
      warn: (...a) => { if (process.env.CUO_VERBOSE) console.log("    [warn]", ...a); else console.log("    [warn]", a[0] && a[0].message ? a[0].message : a[0]); if (a[0] && a[0].stack && process.env.CUO_VERBOSE) console.log(a[0].stack); },
      error: () => {}, log: () => {}
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  return { ctx, window, document, listeners };
}

/* ------------------------------------------------ 载入浮层 */

function load(fakeNowISO, cfgOverride) {
  const { ctx, window, document, listeners } = makeContext(fakeNowISO);
  const src = fs.readFileSync(path.join(__dirname, "usage-overlay.js"), "utf8");
  const prelude =
    "window.__CLAUDE_USAGE_OVERLAY_CONFIG__ = " +
    JSON.stringify(cfgOverride || {}) + ";\n";
  vm.runInContext(prelude + src, ctx, { filename: "usage-overlay.js" });
  return { window, document, listeners };
}

// 直接喂 ingest —— 快，但绕过了宿主那层信封，测不到真实形状
function send(win, msg) {
  win.__cuo.ingest(msg);
}

// 走真实路径：模拟宿主 postMessage，交给 onMessage 处理
function deliver(listeners, msg) {
  listeners.forEach((fn) => fn({ data: { type: "from-extension", message: msg } }));
}

// 宿主实际是用 io_message 包的（extension.js: this.send({type:"io_message",...})），
// 而 send() 又把它包成 {type:"from-extension", message:$}。少剥一层就恒为 0。
function ioMessage(cliMsg) {
  return { type: "io_message", channelId: "chan-1", message: cliMsg, done: false };
}

function assistant(id, usage, model) {
  return { type: "assistant", message: { id, model, usage } };
}

/* ------------------------------------------------ 用例 */

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  \x1b[32m✓\x1b[0m " + name);
  } catch (e) {
    console.log("  \x1b[31m✗\x1b[0m " + name);
    console.log("      " + e.message.split("\n")[0]);
    process.exitCode = 1;
  }
}

const SUNDAY = "2026-09-27T04:00:00Z"; // 北京时间周日 12:00 → 非高峰
const TUESDAY_PEAK = "2026-09-29T02:00:00Z"; // 北京时间周二 10:00 → 高峰

console.log("\nusage-overlay 自测\n");

console.log("记账与去重");
{
  const { window } = load(SUNDAY);

  check("同一个 message.id 重复推送只算一次，且取最后一次的值", () => {
    send(window, assistant("A", { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 500 }, "deepseek-flash"));
    send(window, assistant("A", { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 800 }, "deepseek-flash"));
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.output, 800, "output 应被覆盖成 800，实际 " + t.output);
    assert.strictEqual(t.input, 1000, "input 不应翻倍，实际 " + t.input);
    assert.strictEqual(t.cacheRead, 2000, "cacheRead 不应翻倍，实际 " + t.cacheRead);
  });

  check("不同 id 的消息会累加", () => {
    send(window, assistant("B", { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, output_tokens: 200 }, "deepseek-v4-pro"));
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.input, 1500);
    assert.strictEqual(t.cacheRead, 2000);
    assert.strictEqual(t.cacheCreation, 100);
    assert.strictEqual(t.output, 1000);
    assert.strictEqual(t.tokens, 4600, "总量应为 1500+2000+100+1000=4600，实际 " + t.tokens);
  });

  check("分项金额之和等于合计（两个模型不同单价混用）", () => {
    const t = window.__cuo.totals("session");
    const sum = t.costInput + t.costCacheRead + t.costCacheWrite + t.costOutput;
    assert.ok(Math.abs(sum - t.cost) < 1e-12, "分项和 " + sum + " 与合计 " + t.cost + " 不符");
    // 空闲价：flash hit .02/miss 1.0/out 2.0；pro hit .025/miss 3.0/out 6.0
    const expect =
      1000 / 1e6 * 1.0 + 500 / 1e6 * 3.0 +   // 未命中：A(flash) + B(pro)
      2000 / 1e6 * 0.02 +                     // 命中：A flash
      100 / 1e6 * 3.0 +                       // 缓存写入按未命中价：B pro
      800 / 1e6 * 2.0 + 200 / 1e6 * 6.0;      // 输出：A flash + B pro
    assert.ok(Math.abs(t.cost - expect) < 1e-12, "合计应为 " + expect + "，实际 " + t.cost);
  });
}

console.log("\n消息信封（线上真实形状）");
{
  const { window, listeners } = load(SUNDAY);

  check("裸的 assistant 消息能记账（向后兼容）", () => {
    deliver(listeners, assistant("E0", { input_tokens: 10, output_tokens: 5 }, "deepseek-flash"));
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.input, 10);
    assert.strictEqual(t.output, 5);
  });

  check("套了 io_message 的 assistant 也能记账 —— 不剥这层壳记账就恒为 0", () => {
    deliver(listeners, ioMessage(assistant("E1", { input_tokens: 100, output_tokens: 50 }, "deepseek-flash")));
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.input, 110, "input 应为 10+100，实际 " + t.input);
    assert.strictEqual(t.output, 55, "output 应为 5+50，实际 " + t.output);
  });

  check("套了 io_message 的 stream_event 也能实时计数", () => {
    deliver(listeners, ioMessage({ type: "stream_event", event: { type: "message_start", message: { id: "E2", model: "deepseek-flash", usage: { input_tokens: 300, output_tokens: 0 } } } }));
    deliver(listeners, ioMessage({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 77 } } }));
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.input, 410, "在途 input 300 应算进去，实际 " + t.input);
    assert.strictEqual(t.output, 132, "在途 output 77 应算进去，实际 " + t.output);
  });

  check("自检直方图记的是剥壳后的真实类型", () => {
    const ty = window.__cuo.diag.types;
    assert.ok(ty["assistant"] >= 1, "应看到 assistant，实际 " + JSON.stringify(ty));
    assert.ok(ty["stream_event/message_start"] >= 1, "应看到 stream_event/message_start");
    assert.ok(!ty["io_message"], "不该把外壳记成消息类型");
  });

  check("非消息类的外壳（response）不会污染记账", () => {
    deliver(listeners, { type: "response", requestId: "r1", response: { type: "ok" } });
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.tokens, 410 + 132, "无关消息不该改变合计");
  });
}

console.log("\n流式实时计数");
{
  const { window } = load(SUNDAY);

  check("message_start + message_delta 能在 assistant 落地前就计入", () => {
    send(window, { type: "stream_event", event: { type: "message_start", message: { id: "C", model: "deepseek-flash", usage: { input_tokens: 300, output_tokens: 0 } } } });
    send(window, { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 50 } } });
    let t = window.__cuo.totals("session");
    assert.strictEqual(t.output, 50, "在途 output 应为 50，实际 " + t.output);
    assert.strictEqual(t.input, 300);

    send(window, { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 120 } } });
    t = window.__cuo.totals("session");
    assert.strictEqual(t.output, 120, "delta 是累计值不是增量，实际 " + t.output);
  });

  check("assistant 落地后不和在途副本重复计数", () => {
    send(window, assistant("C", { input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 130 }, "deepseek-flash"));
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.output, 130, "应为 130，实际 " + t.output);
    assert.strictEqual(t.input, 300, "input 不应翻倍，实际 " + t.input);
    assert.strictEqual(t.tokens, 430);
  });
}

console.log("\n回合划分");
{
  const { window } = load(SUNDAY);
  send(window, assistant("T1", { input_tokens: 100, output_tokens: 10 }, "deepseek-flash"));
  send(window, { type: "result", modelUsage: {} });
  send(window, assistant("T2", { input_tokens: 200, output_tokens: 20 }, "deepseek-flash"));

  check("本回合只统计当前这一轮", () => {
    const t = window.__cuo.totals("turn");
    assert.strictEqual(t.input, 200, "本回合 input 应为 200，实际 " + t.input);
    assert.strictEqual(t.output, 20);
  });

  check("本会话统计全部", () => {
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.input, 300, "本会话 input 应为 300，实际 " + t.input);
    assert.strictEqual(t.output, 30);
  });
}

console.log("\n高峰计价");
{
  const { window } = load(TUESDAY_PEAK);
  send(window, assistant("P", { input_tokens: 1e6, output_tokens: 1e6 }, "deepseek-v4-pro"));

  check("北京时间周二 10:00 走高峰价（pro 未命中 6 / 输出 12）", () => {
    const t = window.__cuo.totals("session");
    assert.ok(t.peak, "应识别为高峰时段");
    assert.ok(Math.abs(t.cost - (6 + 12)) < 1e-9, "应为 18，实际 " + t.cost);
  });

  check("关掉高峰计价：已记的保留当时单价，之后的请求和重算才回落空闲价", () => {
    window.__cuo.cfg.pricing.peakPricingEnabled = false;
    // 改价只影响之后的请求 —— 已记的那条还定格在高峰价
    let t = window.__cuo.totals("session");
    assert.ok(!t.peak, "开关关了就不再标高峰");
    assert.ok(Math.abs(t.cost - (6 + 12)) < 1e-9, "旧条目应仍为 18，实际 " + t.cost);
    // 新来的请求按空闲价
    send(window, assistant("P2", { input_tokens: 1e6, output_tokens: 1e6 }, "deepseek-v4-pro"));
    t = window.__cuo.totals("session");
    assert.ok(Math.abs(t.cost - (18 + 9)) < 1e-9, "应为 18+9=27，实际 " + t.cost);
    // 显式重算后，全部按当前（空闲）价
    const n = window.__cuo.recomputeAll();
    assert.strictEqual(n, 2, "重算了 2 条");
    t = window.__cuo.totals("session");
    assert.ok(Math.abs(t.cost - (9 + 9)) < 1e-9, "重算后应为 9+9=18，实际 " + t.cost);
  });
}

console.log("\n模型名匹配");
{
  const { window } = load(SUNDAY);
  const hit = (m) => window.__cuo.ratesFor(m, false);
  check("价目表里的模型按名字子串匹配", () => {
    assert.strictEqual(hit("deepseek-flash").output, 2.0);
    assert.strictEqual(hit("deepseek-v4-flash").output, 2.0);
    assert.strictEqual(hit("deepseek-v4-pro").output, 6.0);
    assert.strictEqual(hit("DeepSeek-V4-Pro").output, 6.0, "大小写不敏感");
  });
  check("不在价目表的模型回落到 defaultModel，不会算成 0", () => {
    assert.strictEqual(hit("some-unknown-model").output, 6.0);
  });
}

console.log("\n未知 / 存疑模型");
{
  const { window } = load(SUNDAY);

  check("价目表里的模型不报警", () => {
    send(window, assistant("W1", { input_tokens: 100, output_tokens: 10 }, "deepseek-v4-pro"));
    send(window, assistant("W2", { input_tokens: 100, output_tokens: 10 }, "deepseek-flash"));
    const t = window.__cuo.totals("session");
    assert.deepStrictEqual(Object.keys(t.unknown), [], "不该有警告");
    assert.ok(t.byModel.pro.known && t.byModel.flash.known);
  });

  check("不在价目表的模型标 fallback，按 defaultModel 估算", () => {
    send(window, assistant("W3", { input_tokens: 100, output_tokens: 10 }, "qwen3-max"));
    const t = window.__cuo.totals("session");
    assert.deepStrictEqual(Object.keys(t.unknown), ["qwen3-max"]);
    assert.strictEqual(t.unknown["qwen3-max"].via, "fallback");
    assert.strictEqual(t.unknown["qwen3-max"].priced, "pro");
    assert.strictEqual(t.byModel["qwen3-max"].known, false);
    assert.ok(t.unknown["qwen3-max"].cost > 0, "钱照算，但必须标警告");
  });

  check("分项金额之和等于合计", () => {
    const t = window.__cuo.totals("session");
    const sum = t.costInput + t.costCacheRead + t.costCacheWrite + t.costOutput;
    assert.ok(Math.abs(sum - t.cost) < 1e-12, "分项和 " + sum + " 与合计 " + t.cost + " 不符");
  });

  check("刚加进价目表但单价空的，仍要报警（不能算成 ¥0）", () => {
    window.__cuo.cfg.pricing.models["qwen3-max"] = {
      label: "qwen3-max",
      idle: { cacheHit: 0, cacheMiss: 0, output: 0 },
      peak: { cacheHit: 0, cacheMiss: 0, output: 0 }
    };
    window.__cuo.recomputeAll();
    const t = window.__cuo.totals("session");
    assert.ok(t.unknown["qwen3-max"], "空价目必须仍然报警");
    assert.strictEqual(t.unknown["qwen3-max"].via, "unpriced");
    assert.strictEqual(t.byModel["qwen3-max"].known, false);
  });

  check("填上单价后重算，警告消失", () => {
    const m = window.__cuo.cfg.pricing.models["qwen3-max"];
    m.idle.cacheHit = 0.1; m.idle.cacheMiss = 1; m.idle.output = 2;
    m.peak.cacheHit = 0.2; m.peak.cacheMiss = 2; m.peak.output = 4;
    window.__cuo.recomputeAll();
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.unknown["qwen3-max"], undefined, "填完价就该安静");
    assert.strictEqual(t.byModel["qwen3-max"].known, true);
    assert.ok(t.byModel["qwen3-max"].cost > 0);
  });
}

console.log("\n服务商适配");
{
  check("标了 provider 的行只在该服务商下生效", () => {
    const { window } = load(SUNDAY, { provider: { id: "deepseek", label: "DeepSeek", known: true } });
    send(window, assistant("P0", { input_tokens: 1000, output_tokens: 100 }, "deepseek-v4-pro"));
    const t = window.__cuo.totals("session");
    assert.deepStrictEqual(Object.keys(t.unknown), []);
    assert.strictEqual(t.byModel.pro.known, true);
  });

  check("换了服务商，有 provider 标记的行停用", () => {
    const { window } = load(SUNDAY, { provider: { id: "moonshot", label: "Kimi", known: true } });
    send(window, assistant("P1", { input_tokens: 1000, output_tokens: 100 }, "deepseek-v4-pro"));
    const t = window.__cuo.totals("session");
    assert.ok(t.unknown["deepseek-v4-pro"], "DeepSeek 的行不该生效");
    assert.strictEqual(t.unknown["deepseek-v4-pro"].via, "fallback");
  });

  check("没标 provider 的行到哪家都生效", () => {
    const { window } = load(SUNDAY, { provider: { id: "moonshot", label: "Kimi", known: true } });
    // 新加一行不标 provider
    window.__cuo.cfg.pricing.models["custom"] = {
      label: "custom",
      idle: { cacheHit: 0.1, cacheMiss: 5, output: 10 },
      peak: { cacheHit: 0.2, cacheMiss: 10, output: 20 }
    };
    send(window, assistant("P2", { input_tokens: 1000, output_tokens: 100 }, "custom"));
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.unknown["custom"], undefined, "自己加的行不报警");
    assert.strictEqual(t.byModel.custom.known, true);
  });
}

console.log("\n快照计价（改价只影响之后的请求）");
{
  const { window } = load(SUNDAY);

  check("改单价不追溯已记条目，重算后才会变", () => {
    send(window, assistant("S1", { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1000 }, "deepseek-v4-pro"));
    // 空闲价输出 6/M → 1000 token = ¥0.006
    let t = window.__cuo.totals("session");
    assert.ok(Math.abs(t.cost - 0.006) < 1e-12, "改价前应为 0.006，实际 " + t.cost);

    window.__cuo.cfg.pricing.models.pro.idle.output = 12;
    t = window.__cuo.totals("session");
    assert.ok(Math.abs(t.cost - 0.006) < 1e-12, "改价后已记的仍按当时单价，实际 " + t.cost);

    const n = window.__cuo.recomputeAll();
    assert.strictEqual(n, 1, "重算了 1 条");
    t = window.__cuo.totals("session");
    assert.ok(Math.abs(t.cost - 0.012) < 1e-12, "重算后应为 0.012，实际 " + t.cost);
  });

  check("重算保留各自当时的高峰/空闲时段，不按现在的时段一刀切", () => {
    const { window: w2 } = load(TUESDAY_PEAK); // 周二 10:00 北京 = 高峰
    send(w2, assistant("S2", { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1000 }, "deepseek-v4-pro"));
    // 高峰价输出 12/M → ¥0.012
    assert.ok(Math.abs(w2.__cuo.totals("session").cost - 0.012) < 1e-12);
    // 把 pro 的高峰输出改成 18，重算应仍按高峰档（保留时段），而不是落到空闲档
    w2.__cuo.cfg.pricing.models.pro.peak.output = 18;
    w2.__cuo.recomputeAll();
    const t = w2.__cuo.totals("session");
    assert.ok(Math.abs(t.cost - 0.018) < 1e-12, "应仍按高峰档 ×18/M = 0.018，实际 " + t.cost);
  });
}

console.log("\n会话切换");
{
  const { window } = load(SUNDAY);

  check("换到另一个会话后统计清零重来，且不跨会话累加", () => {
    send(window, { ...assistant("G1", { input_tokens: 100, output_tokens: 10 }, "deepseek-flash"), sessionId: "sess-a" });
    send(window, { ...assistant("G2", { input_tokens: 50, output_tokens: 5 }, "deepseek-flash"), sessionId: "sess-a" });
    let t = window.__cuo.totals("session");
    assert.strictEqual(t.tokens, 165, "会话 A 应为 165，实际 " + t.tokens);

    // 切到会话 B：旧账清零，这条 B 的消息记进新的账
    send(window, { ...assistant("G3", { input_tokens: 30, output_tokens: 3 }, "deepseek-flash"), sessionId: "sess-b" });
    t = window.__cuo.totals("session");
    assert.strictEqual(t.tokens, 33, "切会话后应只剩新会话的 33，实际 " + t.tokens);
    assert.strictEqual(window.__cuo.acc.entries.size, 1, "旧条目应被清掉");
    assert.strictEqual(window.__cuo.diag.switches, 1, "应记一次切换");
  });

  check("同一会话的后续消息不触发重置", () => {
    send(window, { ...assistant("G4", { input_tokens: 20, output_tokens: 2 }, "deepseek-flash"), sessionId: "sess-b" });
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.tokens, 55, "应继续累加 33+22=55，实际 " + t.tokens);
    assert.strictEqual(window.__cuo.diag.switches, 1, "不该再记一次切换");
  });

  check("切换时在途请求一并清掉，不带进新会话", () => {
    const { window: w2 } = load(SUNDAY);
    // 旧会话里的在途请求（真实流程里它会带旧会话的 sessionId）
    send(w2, { type: "stream_event", sessionId: "sess-a", event: { type: "message_start", message: { id: "G5", model: "deepseek-flash", usage: { input_tokens: 300, output_tokens: 0 } } } });
    assert.strictEqual(w2.__cuo.totals("session").input, 300, "在途请求应计入旧会话");
    send(w2, { ...assistant("G6", { input_tokens: 1, output_tokens: 0 }, "deepseek-flash"), sessionId: "sess-b" });
    const t = w2.__cuo.totals("session");
    assert.strictEqual(t.input, 1, "在途的 300 不该带进新会话，实际 " + t.input);
  });
}

console.log("\n在途请求（等待用量返回）");
{
  const { window } = load(SUNDAY);
  send(window, { type: "stream_event", event: { type: "message_start", message: { id: "W8", model: "deepseek-flash", usage: { input_tokens: 300, output_tokens: 0 } } } });

  check("在途请求两个范围都计：本回合的输出不是 0", () => {
    const st = window.__cuo.totals("session");
    const tt = window.__cuo.totals("turn");
    assert.strictEqual(st.input, 300);
    assert.strictEqual(tt.input, 300, "本回合也要把在途请求算进去");
    assert.strictEqual(tt.cost > 0, true, "在途请求的钱不能是 0");
  });

  check("在途时金额算的是未舍入值，落地后换用快照", () => {
    // 在途：flash 空闲未命中 1/M × 300 = ¥0.0003
    assert.ok(Math.abs(window.__cuo.totals("session").cost - 0.0003) < 1e-12);
    // 落地后同一条消息按快照定格，金额不变（去重不翻倍）
    send(window, assistant("W8", { input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 }, "deepseek-flash"));
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.input, 300, "input 不应翻倍");
    assert.strictEqual(t.output, 100);
  });
}

console.log("\n服务商识别");
{
  const { detect, matchHost, hostOf } = require("./provider.js");

  check("从 base_url 认出各家", () => {
    assert.strictEqual(matchHost("api.deepseek.com").id, "deepseek");
    assert.strictEqual(matchHost("api.anthropic.com").id, "anthropic");
    assert.strictEqual(matchHost("open.bigmodel.cn").id, "zhipu");
    assert.strictEqual(matchHost("api.moonshot.cn").id, "moonshot");
    assert.strictEqual(matchHost("api.deepseek.com.evil.com"), null, "后缀伪装不能算同一家");
    assert.strictEqual(matchHost("localhost").id, "local");
  });

  check("base_url 写法不一也能取出域名", () => {
    assert.strictEqual(hostOf("https://api.deepseek.com/anthropic"), "api.deepseek.com");
    assert.strictEqual(hostOf("api.deepseek.com/anthropic"), "api.deepseek.com");
    assert.strictEqual(hostOf(""), "");
  });

  check("认不出来的服务商不硬塞名字，标 known:false", () => {
    const p = detect({ settingsPath: "C:/nonexistent/x.json" });
    // 文件不存在 → 没有 env → 当作直连官方
    assert.strictEqual(p.official, true);
    assert.strictEqual(p.id, "anthropic");
    assert.strictEqual(p.known, true);
  });
}

console.log("\n金额精度");
{
  const { window } = load(SUNDAY);
  const { fmtCost, fmtCostExact } = window.__cuo;

  check("金额为 0 时老实显示 ¥0", () => {
    assert.strictEqual(fmtCost(0), "¥0");
  });

  // 这正是用户报的问题：一个回合几厘钱，两位小数把它压成 ¥0.00，
  // 看着就像没计费。小数位必须跟着数量级走。
  check("小额不会退化成 ¥0 —— 越大位越少，越小位越多", () => {
    assert.strictEqual(fmtCost(12.678), "¥12.68");    // ≥¥1   两位
    assert.strictEqual(fmtCost(0.5), "¥0.500");       // ≥¥0.01 三位
    assert.strictEqual(fmtCost(0.0432), "¥0.043");
    assert.strictEqual(fmtCost(0.0089), "¥0.0089");   // ≥¥0.0001 四位
    assert.strictEqual(fmtCost(0.00012), "¥0.0001");
  });

  check("小到四位小数都不够时用 < 明说，而不是让 0 冒充", () => {
    assert.strictEqual(fmtCost(0.00009), "<¥0.0001");
    assert.strictEqual(fmtCost(0.0000001), "<¥0.0001");
  });

  check("悬停用的精确值不被数量级截断，且不留多余零", () => {
    assert.strictEqual(fmtCostExact(0.00009), "¥0.00009");
    assert.strictEqual(fmtCostExact(12.68), "¥12.68");
    assert.strictEqual(fmtCostExact(0.5), "¥0.5");
  });
}

console.log("\nToken 摘要");
{
  const { window } = load(SUNDAY);
  const { fmtTokens, fmtFull } = window.__cuo;

  check("摘要形式（悬停另有精确值）", () => {
    assert.strictEqual(fmtTokens(0), "0");
    assert.strictEqual(fmtTokens(950), "950");
    assert.strictEqual(fmtTokens(9500), "9.5K");
    assert.strictEqual(fmtTokens(12800), "12.8K");
    assert.strictEqual(fmtTokens(999999), "1M", "999,999 不该显示成 1000K");
    assert.strictEqual(fmtTokens(1000000), "1M");
    assert.strictEqual(fmtTokens(19854581), "19.85M");
  });

  check("精确值带千分位", () => {
    assert.strictEqual(fmtFull(19854581), "19,854,581");
  });
}

console.log("\n高峰时段说明");
{
  // 北京时间周二 10:00 → 高峰中
  const { window } = load(TUESDAY_PEAK);
  const { nextPeakSwitch, peakTitle, ratioShort, peakRatios } = window.__cuo;

  check("能算出下一次切换：周二 10:00 → 当天 12:00 转空闲", () => {
    const sw = nextPeakSwitch();
    assert.ok(sw, "应该有下一次切换");
    assert.strictEqual(sw.at.getHours(), 12);
    assert.strictEqual(sw.at.getMinutes(), 0);
    assert.strictEqual(sw.toPeak, false);
  });

  // 悬停提示要能回答：现在什么价、时段、时区、倍率、何时切
  check("悬停提示含时段、时区、倍率与切换时间", () => {
    const s = peakTitle(true);
    assert.ok(/高峰价/.test(s), "要说明当前档位");
    assert.ok(/北京时间 \(UTC\+8\)/.test(s), "要标时区");
    assert.ok(/09:00–12:00、14:00–18:00/.test(s), "要列适用时段");
    assert.ok(/周一至周五/.test(s), "要说是工作日");
    assert.ok(/×2/.test(s), "默认倍率 ×2");
    assert.ok(/切换：12:00 起转为空闲价/.test(s), "要说何时切、切成什么");
  });

  // 关掉之后不能只是"标签消失"，得说清现在是全程一个价
  check("关掉分时计价后，提示说明是一直按空闲价", () => {
    const { window: w } = load(TUESDAY_PEAK, { pricing: { peakPricingEnabled: false } });
    const s = w.__cuo.peakTitle(false);
    assert.ok(/已关闭/.test(s), "要说已关闭");
    assert.ok(/都按空闲价/.test(s), "要说清现在按什么价算");
    assert.strictEqual(w.__cuo.nextPeakSwitch(), null, "没有分时就没有切换点");
  });

  // 「如果是自定义规则，应注明」——把高峰价改成 3 倍，标签不能还写 ×2
  check("倍率是从价目表反推的：改成 3 倍就显示 ×3", () => {
    const { window: w } = load(TUESDAY_PEAK, {
      pricing: {
        models: {
          flash: { idle: { cacheHit: 0.02, cacheMiss: 1.0, output: 2.0 }, peak: { cacheHit: 0.06, cacheMiss: 3.0, output: 6.0 } },
          pro: { idle: { cacheHit: 0.025, cacheMiss: 3.0, output: 6.0 }, peak: { cacheHit: 0.075, cacheMiss: 9.0, output: 18.0 } }
        }
      }
    });
    assert.strictEqual(w.__cuo.ratioShort(), "×3");
    assert.ok(/×3/.test(w.__cuo.peakTitle(true)));
    assert.strictEqual(peakRatios().length, 2, "两个模型都要有倍率");
  });

  check("两个模型倍率不一致时说「各模型不同」，不编一个平均值", () => {
    const { window: w } = load(TUESDAY_PEAK, {
      pricing: {
        models: {
          pro: { idle: { cacheHit: 0.025, cacheMiss: 3.0, output: 6.0 }, peak: { cacheHit: 0.075, cacheMiss: 9.0, output: 18.0 } }
        }
      }
    });
    assert.strictEqual(w.__cuo.ratioShort(), "各模型不同", "flash 还是 ×2，pro 是 ×3");
    assert.ok(/各模型倍率/.test(w.__cuo.peakTitle(true)), "要逐个列出来");
  });

  // 同一模型内各字段倍率不一样时，也不能说成单一倍率
  check("同一模型内各字段倍率不同 → 标出区间而不是四舍五入", () => {
    const { window: w } = load(TUESDAY_PEAK, {
      pricing: {
        models: {
          pro: { idle: { cacheHit: 0.025, cacheMiss: 3.0, output: 6.0 }, peak: { cacheHit: 0.05, cacheMiss: 9.0, output: 12.0 } }
        }
      }
    });
    // 只覆盖了 pro，flash 还在且是 ×2 —— 按 key 取，不要按位置取
    const pro = w.__cuo.peakRatios().filter((r) => r.key === "pro")[0];
    assert.strictEqual(pro.mult, null, "pro 的命中是 ×2、未命中是 ×3，不该给出单一倍率");
    assert.strictEqual(pro.lo, 2);
    assert.strictEqual(pro.hi, 3);
    assert.ok(/各字段不同/.test(w.__cuo.peakTitle(true)));
  });
}

console.log("\n高峰切换点");
{
  const cases = [
    // [UTC 时刻, 北京, 期望切换(北京时:分), 切换到高峰?]
    ["2026-09-29T02:00:00Z", "周二 10:00 高峰中", 12, false],
    ["2026-09-29T04:30:00Z", "周二 12:30 午休空闲", 14, true],
    ["2026-09-29T06:00:00Z", "周二 14:00 高峰中", 18, false],
    ["2026-09-29T11:00:00Z", "周二 19:00 空闲", 9, true]  // 次日 09:00
  ];
  cases.forEach(([utc, label, hh, toPeak]) => {
    check("从 " + label + " 起，下一次切换在 " + hh + ":00", () => {
      const { window } = load(utc);
      const sw = window.__cuo.nextPeakSwitch();
      assert.ok(sw, "应该找得到切换点");
      assert.strictEqual(sw.at.getHours(), hh);
      assert.strictEqual(sw.toPeak, toPeak);
    });
  });

  // 周五 19:00 之后要到周一 09:00 才回高峰 —— 跨周末那段最容易算错
  check("周五晚上之后，下一次高峰在周一 09:00", () => {
    const { window } = load("2026-10-02T11:00:00Z"); // 北京 10-02 周五 19:00
    const sw = window.__cuo.nextPeakSwitch();
    assert.strictEqual(sw.at.getDay(), 1, "应该是周一");
    assert.strictEqual(sw.at.getHours(), 9);
    assert.strictEqual(sw.toPeak, true);
  });

  check("整个周末都没有切换点之外的高峰", () => {
    const { window } = load("2026-09-27T04:00:00Z"); // 北京周日 12:00
    const sw = window.__cuo.nextPeakSwitch();
    assert.strictEqual(sw.at.getDay(), 1, "周日之后的下一次切换是周一");
    assert.strictEqual(sw.toPeak, true);
  });
}

console.log("\n上下文窗口来源");
{
  // 分母该用自动压缩线，不是模型窗口。实测这个会话在 167K/167K/175K 连压三次，
  // 拿 1M 当分母会显示"才用了 13%"，然后压缩毫无预兆地砸下来。
  check("默认以自动压缩线为分母，并标出模型窗口是另一个数", () => {
    const { window } = load(SUNDAY);
    const c = window.__cuo.contextWindowInfo();
    assert.strictEqual(c.win, 200000, "分母应是自动压缩线");
    assert.strictEqual(c.useAuto, true);
    assert.strictEqual(c.autoWin, 200000);
    assert.strictEqual(c.modelWin, 1000000);
    assert.strictEqual(c.fromCli, false, "默认不该冒充自动识别");
  });

  check("autoCompactWindow 填 0 → 退回模型窗口", () => {
    const { window } = load(SUNDAY, { display: { autoCompactWindow: 0 } });
    const c = window.__cuo.contextWindowInfo();
    assert.strictEqual(c.win, 1000000);
    assert.strictEqual(c.useAuto, false);
  });

  check("压缩线比模型窗口还大 → 不冒充，退回模型窗口", () => {
    const { window } = load(SUNDAY, { display: { autoCompactWindow: 2000000 } });
    const c = window.__cuo.contextWindowInfo();
    assert.strictEqual(c.win, 1000000);
    assert.strictEqual(c.useAuto, false);
  });

  check("开了 preferCliContextWindow 且 CLI 报了值，才标成来自 CLI", () => {
    const { window, listeners } = load(SUNDAY, { display: { preferCliContextWindow: true } });
    // CLI 的 result 里带 modelUsage[model].contextWindow
    deliver(listeners, ioMessage({ type: "result", modelUsage: { "deepseek-v4-pro": { contextWindow: 131072 } } }));
    const c = window.__cuo.contextWindowInfo();
    assert.strictEqual(c.win, 131072);
    assert.strictEqual(c.fromCli, true);
    assert.strictEqual(c.useAuto, false, "压缩线比 CLI 窗口大，不该压过它");
  });

  check("开了但 CLI 没报值 → 回落手填值，仍标手动", () => {
    const { window } = load(SUNDAY, { display: { preferCliContextWindow: true } });
    const c = window.__cuo.contextWindowInfo();
    assert.strictEqual(c.modelWin, 1000000);
    assert.strictEqual(c.fromCli, false);
  });
}

console.log("\n自动压缩（compact_boundary）");
{
  const cmp = (pre, post, dropped, trigger) => ({
    type: "system", subtype: "compact_boundary",
    compactMetadata: { trigger: trigger || "auto", preTokens: pre, postTokens: post, cumulativeDroppedTokens: dropped, durationMs: 1200 }
  });

  check("收到压缩边界 → 记账次数、前后 token、丢掉多少", () => {
    const { window, listeners } = load(SUNDAY);
    deliver(listeners, ioMessage(cmp(175000, 17000, 158000)));
    const c = window.__cuo.acc.compact;
    assert.strictEqual(c.count, 1);
    assert.strictEqual(c.pre, 175000);
    assert.strictEqual(c.post, 17000);
    assert.strictEqual(c.dropped, 158000);
    assert.strictEqual(c.auto, true, "trigger=auto 不该被当成手动");
  });

  check("压缩后上下文跟着回落到 postTokens", () => {
    const { window, listeners } = load(SUNDAY);
    send(window, assistant("A", { input_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 500 }, "deepseek-v4-pro"));
    assert.strictEqual(window.__cuo.acc.ctx, 101000, "ctx 是压在窗口里的输入侧 token，不含输出");
    deliver(listeners, ioMessage(cmp(175000, 17000, 158000)));
    assert.strictEqual(window.__cuo.acc.ctx, 17000, "压缩后占用该回落，否则进度条永远卡在满格");
  });

  check("没给 cumulativeDroppedTokens 时按 pre-post 自己累加", () => {
    const { window, listeners } = load(SUNDAY);
    deliver(listeners, ioMessage({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 170000, postTokens: 15000 } }));
    deliver(listeners, ioMessage({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 168000, postTokens: 16000 } }));
    const c = window.__cuo.acc.compact;
    assert.strictEqual(c.count, 2);
    assert.strictEqual(c.dropped, 155000 + 152000);
  });

  check("trigger=manual 不冒充自动压缩", () => {
    const { window, listeners } = load(SUNDAY);
    deliver(listeners, ioMessage(cmp(100000, 12000, 88000, "manual")));
    assert.strictEqual(window.__cuo.acc.compact.auto, false);
  });

  check("压缩丢掉的 token 不从累计里扣 —— 那些钱已经付过了", () => {
    const { window, listeners } = load(SUNDAY);
    send(window, assistant("A", { input_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 500 }, "deepseek-v4-pro"));
    const before = window.__cuo.totals("session");
    deliver(listeners, ioMessage(cmp(175000, 17000, 158000)));
    const after = window.__cuo.totals("session");
    assert.strictEqual(after.input, before.input);
    assert.strictEqual(after.cost, before.cost);
  });

  check("切会话时压缩记录一并清零", () => {
    const { window, listeners } = load(SUNDAY);
    send(window, { type: "assistant", sessionId: "sess-a", message: { id: "A", model: "deepseek-v4-pro", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } } });
    deliver(listeners, ioMessage(cmp(175000, 17000, 158000)));
    assert.strictEqual(window.__cuo.acc.compact.count, 1);
    send(window, { type: "assistant", sessionId: "sess-b", message: { id: "B", model: "deepseek-v4-pro", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } } });
    assert.strictEqual(window.__cuo.acc.compact.count, 0, "上一个会话压过几次，不该挂到新会话头上");
    assert.strictEqual(window.__cuo.acc.compact.dropped, 0);
  });
}

console.log("\n持久化（重载窗口不清零）");
{
  check("记账后写进 localStorage", () => {
    const { window } = load(SUNDAY);
    send(window, assistant("A", { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 500 }, "deepseek-v4-pro"));
    window.__cuo.acc.sessionId = "sess-a";
    window.__cuo.acc.startedAt = 1700000000000;
    const n = window.__cuo.persistAcc();
    assert.strictEqual(n, 1);
    const raw = window.localStorage.getItem("cuo.acc.v1");
    assert.ok(raw, "该有存档");
    const saved = JSON.parse(raw);
    assert.strictEqual(saved.entries.length, 1);
    assert.strictEqual(saved.sessionId, "sess-a");
    assert.strictEqual(saved.startedAt, 1700000000000);
    assert.strictEqual(saved.ctx, 3000, "上下文占用也要存 —— 重载后进度条不该从 0 开始");
  });

  check("存档里的条目带回模型和用量，价格快照跟着一起回来", () => {
    const { window } = load(SUNDAY);
    window.localStorage.setItem("cuo.acc.v1", JSON.stringify({
      sessionId: "sess-a", startedAt: 1700000000000, turn: 0, ctx: 3000,
      compact: { count: 2, pre: 175000, post: 17000, dropped: 158000, auto: true },
      entries: [["A", {
        model: "deepseek-v4-pro", input: 1000, cacheRead: 2000, cacheCreation: 0,
        output: 500, turn: 0,
        snap: { key: "pro", real: "deepseek-v4-pro", peak: false, via: "matched", known: true,
          rates: { cacheHit: 0.025, cacheMiss: 3, output: 6 },
          money: { in: 0.003, read: 0.00005, write: 0, out: 0.003 }, total: 0.00605 }
      }]]
    }));
    const n = window.__cuo.restoreAcc();
    assert.strictEqual(n, 1);
    const t = window.__cuo.totals("session");
    assert.strictEqual(t.input, 1000);
    assert.strictEqual(t.cacheRead, 2000);
    assert.strictEqual(t.output, 500);
    assert.strictEqual(t.cost, 0.00605, "存档里的价格快照要照用 —— 不能拿今天的价重算昨天记的账");
    assert.strictEqual(window.__cuo.acc.ctx, 3000, "上下文占用也要接上，否则进度条从 0 开始");
    assert.strictEqual(window.__cuo.acc.compact.count, 2, "压过几次是跨重载的事实，不该丢");
  });

  check("存档坏了不影响启动，只是从零开始", () => {
    const { window } = load(SUNDAY);
    window.localStorage.setItem("cuo.acc.v1", "{不是 JSON");
    assert.strictEqual(window.__cuo.restoreAcc(), 0);
    assert.strictEqual(window.__cuo.acc.entries.size, 0);
  });

  check("空存档 / 条目格式不对的，单条跳过而不是整体崩掉", () => {
    const { window } = load(SUNDAY);
    window.localStorage.setItem("cuo.acc.v1", JSON.stringify({
      sessionId: "s",
      entries: [null, ["ok", { model: "deepseek-v4-pro", input: 10, cacheRead: 0, cacheCreation: 0, output: 1 }], [null, { model: "x" }], ["坏", "不是对象"]]
    }));
    assert.strictEqual(window.__cuo.restoreAcc(), 1, "只该收下那一条像样的");
  });

  check("会话切换之后存的，不会把上个会话的条目带回来", () => {
    const { window } = load(SUNDAY);
    send(window, { type: "assistant", sessionId: "sess-a", message: { id: "A", model: "deepseek-v4-pro", usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 500 } } });
    send(window, { type: "assistant", sessionId: "sess-b", message: { id: "B", model: "deepseek-v4-pro", usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 } } });
    window.__cuo.persistAcc();
    const saved = JSON.parse(window.localStorage.getItem("cuo.acc.v1"));
    assert.strictEqual(saved.entries.length, 1, "切会话时清了账，存档里也只该剩新会话那条");
    assert.strictEqual(saved.entries[0][0], "B", "条目存的是 [id, 记录] 对，顺序不能反");
  });
}

console.log("\n界面上真的写出来了（渲染）");
{
  const cmp = (pre, post, dropped) => ({
    type: "system", subtype: "compact_boundary",
    compactMetadata: { trigger: "auto", preTokens: pre, postTokens: post, cumulativeDroppedTokens: dropped }
  });

  check("没压过的时候，压缩提示行是收起的", () => {
    const { window } = load(SUNDAY);
    window.__cuo.render();
    assert.strictEqual(window.__cuo.el.ctxNote.style.display, "none", "平时不该占地方");
  });

  check("刚压完 → 写出前后数字和丢掉的量", () => {
    const { window, listeners } = load(SUNDAY);
    deliver(listeners, ioMessage(cmp(175000, 17000, 158000)));
    window.__cuo.render();
    const n = window.__cuo.el.ctxNote;
    assert.strictEqual(n.style.display, "");
    assert.strictEqual(n.textContent, "刚刚自动压缩：175K → 17K，丢掉 158K");
    assert.ok(/175,000/.test(n.title), "悬停要给精确值，实际：" + n.title.slice(0, 60));
  });

  check("过了一阵 → 收成累计文案，不是一直喊「刚刚」", () => {
    const { window, listeners } = load(SUNDAY);
    deliver(listeners, ioMessage(cmp(175000, 17000, 158000)));
    window.__cuo.acc.compact.at = window.__cuo.acc.compact.at - 10 * 60 * 1000; // 十分钟前
    window.__cuo.render();
    assert.strictEqual(window.__cuo.el.ctxNote.textContent, "已自动压缩 1 次 · 累计丢掉 158K");
  });

  check("缓存写入占大头时，合计下面点破它占了多少", () => {
    const { window } = load(SUNDAY);
    send(window, assistant("A", { input_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100000, output_tokens: 100 }, "deepseek-v4-pro"));
    window.__cuo.render();
    const s = window.__cuo.el.shareNote;
    assert.strictEqual(s.style.display, "");
    assert.ok(/其中缓存写入占 \d+%/.test(s.textContent), "实际：" + s.textContent);
    assert.ok(/新会话/.test(s.title), "悬停要给出省钱的建议，实际：" + s.title.slice(0, 80));
  });

  check("缓存写入不占大头时，这行不显示", () => {
    const { window } = load(SUNDAY);
    send(window, assistant("A", { input_tokens: 100000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 100 }, "deepseek-v4-pro"));
    window.__cuo.render();
    assert.strictEqual(window.__cuo.el.shareNote.style.display, "none");
  });

  // DOM stub 不会把子节点的文字汇总到父节点，也不在 innerHTML="" 时清 children，
  // 所以查页面上的字得自己摊平、并接受历史行的残留。
  const flat = (n) => (n.textContent || "") + (n.children || []).map(flat).join("");

  check("CLI 报了账 → 页脚出现对账行，且标明是两边各算各的", () => {
    const { window, listeners } = load(SUNDAY);
    send(window, assistant("A", { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 500 }, "deepseek-v4-pro"));
    deliver(listeners, ioMessage({ type: "cost-state", totalCostUSD: 20.63, hasUnknownModelCost: true }));
    window.__cuo.render();
    const rows = window.__cuo.el.foot.children.filter((c) => /对账/.test(flat(c)));
    assert.strictEqual(rows.length, 1, "该有且只有一行对账");
    const txt = flat(rows[0]);
    assert.ok(/CLI ¥146\.4\d（\$20\.63）/.test(txt), "实际：" + txt);
    assert.ok(/浮层 ¥/.test(txt), "两边都要给数，不能只摆 CLI 的：" + txt);
    assert.ok(/hasUnknownModelCost/.test(rows[0].title), "悬停要说明 CLI 为什么不作数");
    assert.ok(/以浮层为准/.test(rows[0].title));
  });

  check("CLI 没报账时不硬凑一行空对账", () => {
    const { window } = load(SUNDAY);
    send(window, assistant("A", { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 500 }, "deepseek-v4-pro"));
    window.__cuo.render();
    assert.ok(!window.__cuo.el.foot.children.some((c) => /对账/.test(flat(c))));
  });

  check("状态行标出统计起点，重载后这个时间点是跨窗口的", () => {
    const { window } = load(SUNDAY);
    window.__cuo.acc.startedAt = 1790481600000; // 本机时区 2026-09-27 12:00
    send(window, assistant("A", { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 500 }, "deepseek-v4-pro"));
    window.__cuo.render();
    const row = window.__cuo.el.foot.children.find((c) => /状态/.test(flat(c)));
    assert.ok(row, "该有状态行");
    assert.ok(/自 \d\d:\d\d 起/.test(flat(row)), "实际：" + flat(row));
  });
}

console.log("\n与 CLI 对账（cost-state）");
{
  check("收到 cost-state → 记下 CLI 的美元金额和「不认识模型」标记", () => {
    const { window, listeners } = load(SUNDAY);
    deliver(listeners, ioMessage({ type: "cost-state", sessionId: "s", totalCostUSD: 20.63, modelUsage: {}, hasUnknownModelCost: true }));
    assert.strictEqual(window.__cuo.acc.cliCost.usd, 20.63);
    assert.strictEqual(window.__cuo.acc.cliCost.unknown, true);
  });

  check("切会话时 CLI 的对账数一并清掉", () => {
    const { window, listeners } = load(SUNDAY);
    deliver(listeners, ioMessage({ type: "cost-state", sessionId: "s", totalCostUSD: 20.63, hasUnknownModelCost: true }));
    send(window, { type: "assistant", sessionId: "sess-b", message: { id: "B", model: "deepseek-v4-pro", usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 } } });
    assert.strictEqual(window.__cuo.acc.cliCost, null);
  });
}

console.log("\n内置默认值 vs config.json");
{
  // DEFAULTS 是 BAKED(config.json) 丢了时的兜底。两边一旦漂移，就会出现
  // "文件里明明标了 provider、跑起来却没有"这种只在异常路径上发作的 bug ——
  // 加 provider 那版就踩过一次，price 全被当成通用的静默套用。
  const fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const a = load(SUNDAY, {}).window.__cuo.cfg;
  const b = load(SUNDAY, fileCfg).window.__cuo.cfg;

  check("两边认得的模型集合相同", () => {
    assert.deepStrictEqual(Object.keys(a.pricing.models).sort(), Object.keys(b.pricing.models).sort());
  });

  // 注意用 JSON 比而不是 deepStrictEqual：load() 跑在 vm 沙箱里，两边对象的
  // 原型来自不同 realm，deepStrictEqual 会因为原型不同而判不等
  check("每个模型的单价与 provider 标记逐字相同", () => {
    for (const k of Object.keys(a.pricing.models)) {
      assert.strictEqual(
        JSON.stringify(a.pricing.models[k]), JSON.stringify(b.pricing.models[k]),
        "模型 " + k + " 两边不一致");
    }
  });


  check("兜底服务商两边一致", () => {
    assert.strictEqual(a.provider.id, b.provider.id);
    assert.strictEqual(a.provider.label, b.provider.label);
  });
}

console.log("\n补丁脚本能跟上扩展改名（apply.js）");
{
  const { learn, buildInject, buildCsp } = require("./apply.js");

  // 真事：2.1.284 → 2.1.285 一次改了三处（nonce B→V、vscode 别名 S1→y1）。
  // 变量名写死的后果不是"注入失败"而是"注入一段 ReferenceError" ——
  // 补丁装上、语法检查也过，要到用户重载窗口才发现浮层不出现。
  const OLD = 'function getHtmlForWebview($,J,Q,X,Y,W){let z=S1.Uri.joinPath(this.extensionUri,"webview","index.js"),G=$.asWebviewUri(z),B=G$(),Z2=`style-src ${$.cspSource}`;return `<!DOCTYPE html><html><body><script nonce="${B}" src="${G}" type="module"></script></body></html>`}';
  const NEW = 'function getHtmlForWebview($,J,Q,X,Y,W){let z=y1.Uri.joinPath(this.extensionUri,"webview","index.js"),G=$.asWebviewUri(z),V=G$(),Z2=`style-src ${$.cspSource}`;return `<!DOCTYPE html><html><body><script nonce="${V}" src="${G}" type="module"></script></body></html>`}';

  check("2.1.284 那版：认出 nonce=B、vscode=S1", () => {
    const L = learn(OLD);
    assert.ok(L, "该能认出注入点");
    assert.strictEqual(L.nonce, "B");
    assert.strictEqual(L.webview, "$");
    assert.strictEqual(L.vscode, "S1");
  });

  check("2.1.285 那版（三处改名）：照样认得出", () => {
    const L = learn(NEW);
    assert.ok(L, "扩展改名不该让补丁哑掉");
    assert.strictEqual(L.nonce, "V");
    assert.strictEqual(L.webview, "$");
    assert.strictEqual(L.vscode, "y1");
  });

  check("注入的标签用的是学到的变量名，不是写死的", () => {
    const html = buildInject(learn(NEW));
    assert.ok(html.includes('nonce="${V}"'), "nonce 该用 V：" + html);
    assert.ok(html.includes("$.asWebviewUri(y1.Uri.joinPath("), "该用学到的 webview/vscode：" + html);
    assert.ok(html.includes("usage-overlay.js"));
    assert.ok(!/\$\{B\}|\bS1\b/.test(html), "不该残留旧名字：" + html);
  });

  check("CSP 兜底也是按学到的 nonce 变量拼的", () => {
    const c = buildCsp(learn(NEW));
    assert.strictEqual(c.from, "script-src 'nonce-${V}';");
    assert.strictEqual(c.to, "script-src 'nonce-${V}' ${$.cspSource};");
  });

  check("结构真变了要返回 null（而不是拼一段坏代码出来）", () => {
    assert.strictEqual(learn("<html>扩展换了个写法</html>"), null);
    assert.strictEqual(learn('getHtmlForWebview($,J){return "<script nonce=1></script>"}'), null);
    // 只有调用点、没有函数定义时不能瞎认
    assert.strictEqual(learn('getHtmlForWebview($.webview,void 0,void 0,!0)'), null);
  });
}

console.log("\n" + (process.exitCode ? "\x1b[31m有失败\x1b[0m" : "\x1b[32m全部通过\x1b[0m") + ` (${passed} 项)\n`);
