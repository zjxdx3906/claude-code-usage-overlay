/* Claude Code 实时用量浮层 (usage overlay)
 * ---------------------------------------------------------------------------
 * 由 ~/.claude/usage-overlay/apply.js 注入到官方 Claude Code 扩展的 webview 里。
 *
 * 工作原理：扩展会把 CLI 的原始 JSON 消息流通过 postMessage
 * ({type:"from-extension", message:<原始消息>}) 转发给 webview。
 * 这里挂一个只读的 message 监听，拿同一条流自己记账、自己按 DeepSeek 人民币
 * 价目算钱，然后渲染一枚浮层。不改动扩展自身的任何行为。
 *
 * 之所以自己算钱：本机走的是 api.deepseek.com/anthropic，模型 deepseek-flash /
 * deepseek-v4-pro 不在 Claude Code 内置价目表里，CLI 的 total_cost_usd 恒为 0。
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  // 只注入一次（webview 里可能被重复加载）
  if (window.__claudeUsageOverlayLoaded) return;
  window.__claudeUsageOverlayLoaded = true;

  // 会话列表那种 webview 不显示浮层
  if (window.IS_SESSION_LIST_ONLY) return;

  /* ======================================================================
   * 0. 配置
   * ==================================================================== */

  var BAKED = window.__CLAUDE_USAGE_OVERLAY_CONFIG__ || {};
  var LS_CONFIG = "cuo.config.v1";
  var LS_POS = "cuo.pos.v1";

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  // 递归合并，over 覆盖 base；不修改入参
  function merge(base, over) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in over) {
      if (!Object.prototype.hasOwnProperty.call(over, k)) continue;
      var b = out[k], o = over[k];
      out[k] = isPlainObject(b) && isPlainObject(o) ? merge(b, o) : o;
    }
    return out;
  }

  function readJSON(store, key) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeJSON(store, key, val) {
    try {
      store.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  var DEFAULTS = {
    currency: "¥",
    display: {
      position: "top-right",
      collapsed: false,
      showInSidebar: true,
      showContextRing: true,
      showTokenArrows: true,
      autoHideWhenIdle: false,
      // CLI 对不认识的模型一律假定 200k 上下文，DeepSeek v4 实际是 1M，
      // 所以默认以本文件的配置为准；想让 CLI 报的值优先就打开这个开关。
      contextWindowFallback: 1000000,
      // CLI 对认不出的模型一律按 200k 触发自动压缩（本机实测 167K/175K 就压了）。
      // 真正决定"还能聊多久"的是这条线，不是模型窗口 —— 只显示 1M 会让人以为
      // 还剩八成，压缩却突然砸下来。设成 0 就退回按模型窗口显示。
      autoCompactWindow: 200000,
      preferCliContextWindow: false
    },
    // CLI 的账是美元，浮层算的是人民币，对账时要换算
    usdToCny: 7.1,
    // 兜底服务商。apply.js 会把 settings.json 里读到的真值烤进 config.json，
    // 那份在 merge 里压过这里。这份只在 config.json 丢了时兜底。
    provider: {
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/anthropic",
      known: true,
      // 这份是自动识别的；用户手改后标 "manual"
      source: "auto"
    },
    pricing: {
      peakPricingEnabled: true,
      defaultModel: "pro",
      // 每个模型的 provider 标明这套单价是给哪家填的。缺了这个字段，CC Switch
      // 换到别家之后，撞上子串的模型名会被静默套用这里的价 —— 差几十倍。
      models: {
        flash: {
          label: "deepseek-v4-flash",
          provider: "deepseek",
          idle: { cacheHit: 0.02, cacheMiss: 1.0, output: 2.0 },
          peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 4.0 }
        },
        pro: {
          label: "deepseek-v4-pro",
          provider: "deepseek",
          idle: { cacheHit: 0.025, cacheMiss: 3.0, output: 6.0 },
          peak: { cacheHit: 0.05, cacheMiss: 6.0, output: 12.0 }
        }
      }
    }
  };

  var cfg = merge(merge(DEFAULTS, BAKED), readJSON(window.localStorage, LS_CONFIG) || {});
  migrateCfg();

  // 老版本留下的东西：手动绑定表已并进"加一行价目"；自己加的行不再挂服务商，
  // 否则 CC Switch 换了家，昨天刚填的价今天就不生效了。
  function migrateCfg() {
    if (cfg.pricing) delete cfg.pricing.aliases;
    var ms = (cfg.pricing && cfg.pricing.models) || {};
    Object.keys(ms).forEach(function (k) {
      if (!DEFAULTS.pricing.models[k] && ms[k]) delete ms[k].provider;
    });
  }

  /* ======================================================================
   * 1. 计价
   * ==================================================================== */

  function num(v) {
    return typeof v === "number" && isFinite(v) && v > 0 ? v : 0;
  }

  // 分时定价规则。时段本身写死在这里，倍率不写死 —— 倍率是从价目表反推的
  // （见 peakRatios），因为用户可以把高峰价改成任意值，"双倍"只是默认而已。
  var PEAK_TZ_LABEL = "北京时间 (UTC+8)";
  var PEAK_DAYS_LABEL = "周一至周五";
  var PEAK_WINDOWS = [[9, 0, 12, 0], [14, 0, 18, 0]];   // 时:分 起 → 时:分 止
  // 状态在这几个整点上翻转：午夜、09:00、12:00、14:00、18:00
  var PEAK_BOUNDS = [0, 540, 720, 840, 1080];

  function peakWindowsText() {
    return PEAK_WINDOWS.map(function (w) {
      function hm(p) { return (p[0] < 10 ? "0" : "") + p[0] + ":" + (p[1] < 10 ? "0" : "") + p[1]; }
      return hm(w) + "–" + hm([w[2], w[3]]);
    }).join("、");
  }

  // 北京时间 → 分钟数 + 星期，两处都要用
  function bjNow() {
    var now = new Date();
    var bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
    return { d: bj, min: bj.getHours() * 60 + bj.getMinutes(), day: bj.getDay() };
  }

  // 给定北京时间的一天内分钟数与星期，判断那一刻是不是高峰。
  // 区间是半开的 [起, 止)，所以在 09:00 这一刻就已经算高峰 —— 下面找切换点时
  // 会用同一个函数判断"边界之后"的状态，两边必须一致。
  function isPeakAt(min, day) {
    if (!cfg.pricing.peakPricingEnabled) return false;
    if (day === 0 || day === 6) return false;
    return (min >= 540 && min < 720) || (min >= 840 && min < 1080);
  }

  function isPeakNow() {
    var n = bjNow();
    return isPeakAt(n.min, n.day);
  }

  // 下一次「高峰 ↔ 空闲」翻转在什么时候。只标一个"高峰"标签的话，用户没法知道
  // 这价还能用多久。返回 {at: 北京时间的 Date, toPeak: bool}，找不到就 null。
  function nextPeakSwitch() {
    if (!cfg.pricing.peakPricingEnabled) return null;
    var n = bjNow();
    var was = isPeakAt(n.min, n.day);
    for (var d = 0; d < 4; d++) {
      var day = new Date(n.d.getTime());
      day.setDate(day.getDate() + d);
      for (var i = 0; i < PEAK_BOUNDS.length; i++) {
        var b = PEAK_BOUNDS[i];
        if (d === 0 && b <= n.min) continue;
        var will = isPeakAt(b, day.getDay());
        if (will !== was) {
          var at = new Date(day.getTime());
          at.setHours(Math.floor(b / 60), b % 60, 0, 0);
          return { at: at, toPeak: will };
        }
      }
    }
    return null;
  }

  function untilText(ms) {
    var min = Math.round(ms / 60000);
    if (min <= 1) return "不到 1 分钟";
    if (min < 60) return min + " 分钟";
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + " 小时 " + m + " 分" : h + " 小时";
  }

  function hhmm(d) {
    return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }

  // 从价目表反推高峰倍率。用户能把高峰价改成任何数，所以不能写死 ×2；
  // 各字段倍率不一致时如实说"按字段不同"，不编一个平均值出来。
  function peakRatios() {
    var out = [];
    var models = cfg.pricing.models || {};
    Object.keys(models).forEach(function (k) {
      var m = models[k] || {};
      var rs = [];
      ["cacheHit", "cacheMiss", "output"].forEach(function (f) {
        var i = num(m.idle && m.idle[f]), p = num(m.peak && m.peak[f]);
        if (i > 0 && p > 0) rs.push(p / i);
      });
      if (!rs.length) return;
      var lo = Math.min.apply(null, rs), hi = Math.max.apply(null, rs);
      out.push({
        key: k, label: (m.label || k),
        mult: Math.abs(hi - lo) < 1e-9 ? hi : null,
        lo: lo, hi: hi
      });
    });
    return out;
  }

  function ratioText(r) {
    function f(x) { return trimZeros(x.toFixed(2)); }
    if (r.mult !== null) return "×" + f(r.mult);
    return "×" + f(r.lo) + "–×" + f(r.hi) + "（各字段不同）";
  }

  // 设置面板上那行需要一句话说清倍率；价目被改乱时也得说实话
  function ratioShort() {
    var rs = peakRatios();
    if (!rs.length) return "倍率未填";
    var uniq = {};
    rs.forEach(function (r) { uniq[r.mult === null ? "mixed" : String(r.mult)] = 1; });
    var keys = Object.keys(uniq);
    if (keys.length === 1 && keys[0] !== "mixed") return "×" + trimZeros(Number(keys[0]).toFixed(2));
    return "各模型不同";
  }

  // 高峰标签 / 页脚的悬停说明。要回答四个问题：现在什么价、适用时段、时区、
  // 倍率，以及什么时候切 —— 只挂一个"高峰"标签等于什么都没说。
  function peakTitle(peak) {
    var lines = [];
    if (!cfg.pricing.peakPricingEnabled) {
      lines.push("高峰分段计价已关闭：所有时段都按空闲价算。");
      lines.push("");
      lines.push("原始规则：" + PEAK_TZ_LABEL + " " + PEAK_DAYS_LABEL + " " + peakWindowsText());
      lines.push("（齿轮面板里可以重新打开）");
      return lines.join("\n");
    }
    lines.push("当前：" + (peak ? "高峰价" : "空闲价"));
    lines.push("时段：" + PEAK_TZ_LABEL + " " + PEAK_DAYS_LABEL + " " + peakWindowsText());
    lines.push("倍率：" + ratioShort() + "（相对空闲价，可在齿轮面板里改）");

    var sw = nextPeakSwitch();
    if (sw) {
      lines.push("切换：" + hhmm(sw.at) + " 起转为" + (sw.toPeak ? "高峰" : "空闲")
        + "价，还有约 " + untilText(sw.at.getTime() - Date.now()));
    }
    var rs = peakRatios();
    if (rs.length > 1) {
      lines.push("");
      lines.push("各模型倍率：");
      rs.forEach(function (r) { lines.push("  " + r.label + "  " + ratioText(r)); });
    }
    return lines.join("\n");
  }

  // 匹配价目表，只有一条规则：模型名里含哪行的名字，就按哪行的价算
  // （先看完全同名，再取含进去的最长那个，免得短词抢了长词的活）。
  //
  // 内置的两行标了 provider:"deepseek"，只在 DeepSeek 下生效 —— CC Switch 换到
  // 别家后，kimi-k2-pro 撞上 "pro" 也不会被按 DeepSeek 的价静默算掉。自己加的行
  // 不挂服务商，哪家都生效。
  //
  // 返回 {key}；没有能用的行返回 null，调用方按 defaultModel 估算并报警。
  function lookupPricing(modelName) {
    var models = cfg.pricing.models || {};
    var name = String(modelName || "").toLowerCase();
    if (!name) return null;
    var best = null;
    for (var key in models) {
      if (!Object.prototype.hasOwnProperty.call(models, key) || !entryFitsProvider(models[key])) continue;
      var k = key.toLowerCase();
      if (k === name) return { key: key };
      if (name.indexOf(k) !== -1 && (!best || k.length > best.length)) best = key;
    }
    return best ? { key: best } : null;
  }

  // 这笔价目是给当前服务商填的吗？没标 provider 的老条目一律放行（向后兼容）。
  function entryFitsProvider(entry) {
    var want = (entry && entry.provider) || "";
    if (!want) return true;
    var cur = (cfg.provider && cfg.provider.id) || "";
    if (!cur) return true;
    return String(want).toLowerCase() === String(cur).toLowerCase();
  }

  function providerLabel() {
    var p = cfg.provider || {};
    return p.label || p.id || "未知服务商";
  }

  function matchPricingKey(modelName) {
    var hit = lookupPricing(modelName);
    return hit ? hit.key : cfg.pricing.defaultModel;
  }

  // 价目条目是否真填过数。新加的模型默认六个 0，那种"有名字没价"的状态
  // 会让金额静默变成 ¥0 —— 比按别的模型估价更糟，所以也要报警。
  function hasPrices(entry) {
    if (!entry) return false;
    var tiers = ["idle", "peak"];
    for (var i = 0; i < tiers.length; i++) {
      var t = entry[tiers[i]];
      if (t && (num(t.cacheHit) || num(t.cacheMiss) || num(t.output))) return true;
    }
    return false;
  }

  function ratesFor(modelName, peak) {
    var models = cfg.pricing.models || {};
    var entry = models[matchPricingKey(modelName)] || models[cfg.pricing.defaultModel];
    if (!entry) return { cacheHit: 0, cacheMiss: 0, output: 0 };
    var tier = peak && entry.peak ? entry.peak : entry.idle;
    return {
      cacheHit: num(tier && tier.cacheHit),
      cacheMiss: num(tier && tier.cacheMiss),
      output: num(tier && tier.output)
    };
  }

  /* ======================================================================
   * 2. 记账
   * ==================================================================== */

  // 自检用的计数器。界面上一直显示为 0 时，看这几个数就能分清是
  // "压根没收到消息" 还是 "收到了但没渲染"，不用去猜。
  // types 是收到的消息类型直方图 —— 记账为 0 时，一眼能看出 assistant /
  // stream_event 到底有没有来过。
  var diag = { seen: 0, errors: 0, lastType: "", types: {}, sample: {}, startedAt: Date.now() };

  var acc = {
    // message.id -> {model,input,cacheRead,cacheCreation,output,turn,snap}
    // snap 是这条记录落地那一刻定格的计价快照（钱、桶、时段、单价）。
    // 之后改价只影响新记录，历史费用不跟着变。
    entries: new Map(),
    // 正在流式输出、但 assistant 消息还没落地的那个请求
    pending: null,
    streaming: false,
    turn: 1,
    lastTurn: 0,
    // 最近一次请求的总输入 = 当前上下文占用
    ctx: 0,
    ctxWindowFromCli: 0,
    // 当前在记的会话。切换会话时清空重来（用户明确要求过）
    sessionId: "",
    // 最后一次收到用量数据的时间，状态行"最近更新 N 秒前"用
    lastUpdateAt: 0,
    // 本会话开始统计的时刻。存盘，跨窗口重载保留 —— 状态行"统计自 xx:xx 起"
    startedAt: 0,
    // 自动压缩：CLI 每压一次都会发 compact_boundary，把砍掉的量告诉我们
    compact: { count: 0, pre: 0, post: 0, dropped: 0, at: 0, auto: true },
    // CLI 自己算的账（cost-state）。用来对账，看浮层的价目偏了多少
    cliCost: null
  };

  /* ---------- 账本存盘：重载窗口不该让钱清零 ---------- */

  var LS_ACC = "cuo.acc.v1";
  var accSaveId = 0;

  // 连价格快照一起存 —— 只存条目的话，重载后旧记录会被新价重算，
  // 和"改价只影响之后的请求"这条承诺自相矛盾。
  function persistAcc() {
    try {
      var rows = [];
      acc.entries.forEach(function (e, id) { rows.push([id, e]); });
      if (rows.length > 3000) rows = rows.slice(rows.length - 3000);
      writeJSON(window.localStorage, LS_ACC, {
        sessionId: acc.sessionId, startedAt: acc.startedAt,
        turn: acc.turn, lastTurn: acc.lastTurn, ctx: acc.ctx,
        compact: acc.compact, entries: rows
      });
      return rows.length;
    } catch (e) { return 0; /* 存不下就算了，绝不能影响记账 */ }
  }

  // 落地一条就存一次太频繁（每条要序列化整本账），攒 1.5 秒再写；
  // 回合结束时立刻写一次，那是天然的检查点。
  function saveAcc() {
    if (accSaveId) return;
    accSaveId = setTimeout(function () { accSaveId = 0; persistAcc(); }, 1500);
  }

  // 返回收下几条。存档炸了就返回 0 —— 调用方不该因为读不回历史而拒绝启动。
  function restoreAcc() {
    var d = readJSON(window.localStorage, LS_ACC);
    if (!d || !d.entries || !d.entries.length) return 0;
    var n = 0;
    d.entries.forEach(function (r) {
      if (!r || !r[0] || !r[1] || typeof r[1] !== "object") return; // 单条坏了只丢这条
      acc.entries.set(r[0], r[1]);
      n++;
    });
    if (!n) return 0;
    acc.sessionId = d.sessionId || "";
    acc.startedAt = d.startedAt || 0;
    acc.turn = d.turn || 1;
    acc.lastTurn = d.lastTurn || 0;
    acc.ctx = d.ctx || 0;
    if (d.compact) acc.compact = d.compact;
    return n;
  }

  function zeroUsage() {
    return { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  }

  function usageFrom(u) {
    return {
      input: num(u && u.input_tokens),
      cacheRead: num(u && u.cache_read_input_tokens),
      cacheCreation: num(u && u.cache_creation_input_tokens),
      output: num(u && u.output_tokens)
    };
  }

  function totalInput(u) {
    return u.input + u.cacheRead + u.cacheCreation;
  }

  // 宿主把 CLI 消息套了一层再转发：
  //   {type:"from-extension", message:{type:"io_message", channelId, message:<CLI消息>, done}}
  // 不剥掉这层壳，下面所有 type 判断都会落空 —— 记账恒为 0，界面一直"等待数据"。
  // webview 自己也是这么剥的：case "io_message": streams.get($.channelId).enqueue($.message)
  function unwrap(m) {
    if (m && m.type === "io_message" && m.message && typeof m.message === "object") {
      if (m.channelId) diag.channelId = m.channelId;
      return m.message;
    }
    return m;
  }

  function ingest(raw) {
    var m = unwrap(raw);
    if (!m || typeof m !== "object") return;
    diag.lastType = m.type === "stream_event" && m.event ? "stream_event/" + m.event.type : String(m.type);

    // ---- 会话切换：清空重来 ----
    // sessionId 在 assistant / user 消息顶层都有。切到另一个会话时，本会话的
    // 统计已经没有任何意义了，继续往上累加只会越错越远。
    if (m.sessionId) {
      if (!acc.sessionId) {
        acc.sessionId = m.sessionId;
      } else if (acc.sessionId !== m.sessionId) {
        acc.sessionId = m.sessionId;
        acc.entries.clear();
        acc.pending = null;
        acc.streaming = false;
        acc.turn = 1;
        acc.lastTurn = 0;
        acc.ctx = 0;
        acc.lastUpdateAt = 0;
        acc.startedAt = 0;
        acc.compact = { count: 0, pre: 0, post: 0, dropped: 0, at: 0, auto: true };
        acc.cliCost = null;
        persistAcc();   // 新会话的空账立刻覆盖旧账
        diag.switches = (diag.switches || 0) + 1;
        dirty();
        toast("切换了会话，已重新统计");
      }
    }

    // ---- 自动压缩：CLI 主动告诉我们上下文被砍了、砍掉多少 ----
    // 这条平时看不见，但对用户是大事：压缩一来上下文骤降，而且被丢掉的那些
    // token 已经付过钱了。不说明白，用户只会觉得"聊着聊着它突然失忆了"。
    if (m.type === "system" && m.subtype === "compact_boundary") {
      var cm = m.compactMetadata || {};
      var preT = num(cm.preTokens), postT = num(cm.postTokens);
      acc.compact.count += 1;
      acc.compact.pre = preT;
      acc.compact.post = postT;
      acc.compact.auto = cm.trigger !== "manual";
      // cumulativeDroppedTokens 是 CLI 给的累计值；没有就自己加
      acc.compact.dropped = num(cm.cumulativeDroppedTokens)
        || (acc.compact.dropped + Math.max(0, preT - postT));
      acc.compact.at = Date.now();
      if (postT > 0) acc.ctx = postT;   // 上下文真的变小了
      if (!acc.startedAt) acc.startedAt = Date.now();
      saveAcc();
      toast("上下文已自动压缩：" + fmtTokens(preT) + " → " + fmtTokens(postT));
      dirty();
      return;
    }

    // ---- CLI 自己的账：拿来和浮层对账 ----
    // CLI 认不出这些模型时会标 hasUnknownModelCost，那个数只能当参考；
    // 但拿它一比，就能看出浮层的价目偏了多少。
    if (m.type === "cost-state") {
      acc.cliCost = {
        usd: num(m.totalCostUSD),
        unknown: !!m.hasUnknownModelCost,
        at: Date.now()
      };
      dirty();
      return;
    }

    // ---- 流式事件：实时性的来源 ----
    if (m.type === "stream_event") {
      var ev = m.event || m;
      if (!ev || typeof ev !== "object") return;

      if (ev.type === "message_start" && ev.message) {
        var u0 = usageFrom(ev.message.usage);
        acc.pending = {
          id: ev.message.id,
          model: ev.message.model,
          input: u0.input,
          cacheRead: u0.cacheRead,
          cacheCreation: u0.cacheCreation,
          output: u0.output
        };
        acc.streaming = true;
        acc.lastUpdateAt = Date.now();
        var t0 = totalInput(u0);
        if (t0 > 0) acc.ctx = t0;
        dirty();
      } else if (ev.type === "message_delta") {
        if (acc.pending && ev.usage) {
          // message_delta 里的 output_tokens 是本次请求的累计值
          var od = num(ev.usage.output_tokens);
          if (od > 0) acc.pending.output = od;
          var id1 = num(ev.usage.input_tokens);
          if (id1 > 0) acc.pending.input = id1;
          var cr = num(ev.usage.cache_read_input_tokens);
          if (cr > 0) acc.pending.cacheRead = cr;
          var cc = num(ev.usage.cache_creation_input_tokens);
          if (cc > 0) acc.pending.cacheCreation = cc;
          acc.lastUpdateAt = Date.now();
          dirty();
        }
      } else if (ev.type === "message_stop") {
        // 等 assistant 消息落地再收尾
      }
      return;
    }

    // ---- assistant 消息：按 id 覆盖，同一个 id 会重复推送 ----
    if (m.type === "assistant" && m.message) {
      var mm = m.message;
      if (mm.id && mm.usage) {
        var u1 = usageFrom(mm.usage);
        var model = mm.model || (acc.pending && acc.pending.model) || "";
        // 落地即定格：钱、桶、时段都按这一刻的价目快照存下。
        // 之后改价不影响这一条 —— 只会影响接下来的请求。
        acc.entries.set(mm.id, {
          model: model,
          input: u1.input,
          cacheRead: u1.cacheRead,
          cacheCreation: u1.cacheCreation,
          output: u1.output,
          turn: acc.turn,
          snap: snapFor(model, u1)
        });
        acc.lastUpdateAt = Date.now();
        if (!acc.startedAt) acc.startedAt = Date.now();
        var t1 = totalInput(u1);
        if (t1 > 0) acc.ctx = t1;
        // 该请求已经落地，撤掉在途副本，避免重复计数
        if (acc.pending && (!acc.pending.id || acc.pending.id === mm.id)) {
          acc.pending = null;
        }
        acc.streaming = false;
        saveAcc();
        dirty();
      }
      return;
    }

    // ---- result：一个回合结束 ----
    if (m.type === "result") {
      var mu = m.modelUsage;
      if (mu && typeof mu === "object") {
        for (var k in mu) {
          if (Object.prototype.hasOwnProperty.call(mu, k) && num(mu[k] && mu[k].contextWindow) > 0) {
            acc.ctxWindowFromCli = num(mu[k].contextWindow);
          }
        }
      }
      acc.lastTurn = acc.turn;
      acc.turn += 1;
      acc.pending = null;
      acc.streaming = false;
      persistAcc();   // 回合结束是天然检查点，立刻落盘
      dirty();
      return;
    }

    // ---- 新的用户输入：开新的一轮 ----
    if (m.type === "user") {
      acc.pending = null;
      dirty();
    }
  }

  // 一条记录按当前价目算出的全部结果：钱、桶、可信度、时段。
  // 在 assistant 落地那一刻定格（snapshot）—— 之后改价只影响新记录，
  // 历史费用不跟着变；「按当前价重算」是显式操作（见 recomputeAll）。
  // peak 默认取"现在"，重算时传当时记下的时段，保留原样。
  function snapFor(model, tok, peakOverride) {
    var hit = lookupPricing(model);
    var unpriced = !!hit && !hasPrices(cfg.pricing.models[hit.key]);
    var shaky = !hit || unpriced;
    var real = model || "(模型名缺失)";
    var key = shaky ? real : hit.key;
    var peak = peakOverride === undefined ? isPeakNow() : peakOverride;
    var rates = ratesFor(model, peak);
    var mIn = (tok.input / 1e6) * rates.cacheMiss;
    var mRead = (tok.cacheRead / 1e6) * rates.cacheHit;
    var mWrite = (tok.cacheCreation / 1e6) * rates.cacheMiss;
    var mOut = (tok.output / 1e6) * rates.output;
    return {
      key: key, real: real, peak: peak, rates: rates,
      shaky: shaky, known: !shaky,
      // fallback = 没有能用的行，按 defaultModel 估的；unpriced = 有行但价还没填
      via: !hit ? "fallback" : (unpriced ? "unpriced" : "matched"),
      // 是不是用户自己加的那几行（页脚据此显示"自定义价"）
      custom: !!hit && !DEFAULTS.pricing.models[hit.key],
      priced: hit ? hit.key : cfg.pricing.defaultModel,
      money: { in: mIn, read: mRead, write: mWrite, out: mOut },
      total: mIn + mRead + mWrite + mOut
    };
  }

  // 按当前价重算所有已记记录，保留各自当时的高峰/空闲时段。
  // 注意开关本身也参与：关掉分时计价后，旧的高峰时段一并按空闲价重算 ——
  // ratesFor() 只查价目表、不看开关，所以这里必须先过一遍 isPeakAt。
  function recomputeAll() {
    var n = 0;
    acc.entries.forEach(function (e) {
      var wasPeak = !!(e.snap && e.snap.peak) && cfg.pricing.peakPricingEnabled;
      e.snap = snapFor(e.model, e, wasPeak);
      n++;
    });
    dirty();
    return n;
  }

  // 把一笔累进合计。有 snap 用快照（历史定格），没有就是在途请求，实时算。
  function addInto(t, u, snap) {
    if (!snap) snap = snapFor(u.model, u);

    t.input += u.input;
    t.cacheRead += u.cacheRead;
    t.cacheCreation += u.cacheCreation;
    t.output += u.output;
    t.tokens += u.input + u.cacheRead + u.cacheCreation + u.output;

    t.costInput += snap.money.in;
    t.costCacheRead += snap.money.read;
    t.costCacheWrite += snap.money.write;
    t.costOutput += snap.money.out;
    t.cost += snap.total;

    var tok = u.input + u.cacheRead + u.cacheCreation + u.output;

    if (snap.shaky) {
      // 这笔钱是拿别的模型的单价凑的，可能差十倍。单独开一个桶（key 就是真实
      // 模型名）再单独记一份，好让 UI 把话说清楚 —— 要是混进 defaultModel 那个
      // 桶，页脚会给它贴上 "deepseek-v4-pro" 的标签，那比不显示还容易骗人。
      t.unknown[snap.real] = t.unknown[snap.real] || {
        tokens: 0, cost: 0,
        priced: snap.priced,
        via: snap.via
      };
      t.unknown[snap.real].tokens += tok;
      t.unknown[snap.real].cost += snap.total;
    }
    if (snap.custom) t.customUsed = true;

    if (!t.byModel[snap.key]) t.byModel[snap.key] = { tokens: 0, cost: 0, model: snap.real, known: snap.known };
    t.byModel[snap.key].tokens += tok;
    t.byModel[snap.key].cost += snap.total;
    return t;
  }

  function emptyTotals() {
    return {
      input: 0, cacheRead: 0, cacheCreation: 0, output: 0, tokens: 0, cost: 0,
      costInput: 0, costCacheRead: 0, costCacheWrite: 0, costOutput: 0,
      byModel: {},
      // 模型名 -> {tokens,cost,priced}，只装价目表里没有的模型
      unknown: {},
      // 是否用到了自己加的价目行
      customUsed: false
    };
  }

  // scope: "session" | "turn"
  function totals(scope) {
    var peak = isPeakNow();
    var t = emptyTotals();
    var wantTurn = scope === "turn";
    var turnNo = acc.turn;
    var anyThisTurn = false;

    acc.entries.forEach(function (e) {
      if (wantTurn && e.turn === turnNo) anyThisTurn = true;
    });
    // 刚跑完一轮、还没开始下一轮时，"本回合"显示刚结束的那一轮
    if (wantTurn && !anyThisTurn && !acc.pending) turnNo = acc.lastTurn;

    acc.entries.forEach(function (e) {
      if (wantTurn && e.turn !== turnNo) return;
      addInto(t, e, e.snap);
    });
    // 在途请求两个范围都计。流式输出期间"本回合"的输出要是 0，看起来就像
    // 漏统计了 —— 这正是那条 229K 输入 / 0 输出的截图背后的原因
    if (acc.pending) addInto(t, acc.pending, null);

    t.scope = scope;
    t.peak = peak;
    return t;
  }

  /* ======================================================================
   * 3. 格式化
   * ==================================================================== */

  function trimZeros(s) {
    return s.indexOf(".") < 0 ? s : s.replace(/0+$/, "").replace(/\.$/, "");
  }

  // 摘要形式，给胶囊和上下文条用（12.8K / 1M）。精确值走 fmtFull()，
  // 挂在这些节点的 title 上 —— 摘要看不出到底多少，悬停要能补上。
  function fmtTokens(n) {
    n = Math.round(n);
    if (n < 1000) return String(n);
    if (n < 1e6) {
      var k = n / 1000;
      // 999,999 会被四舍五入成 "1000K"，不如直接进位到 1M
      if (k >= 999.5) return "1M";
      return trimZeros(k < 10 ? k.toFixed(2) : k < 100 ? k.toFixed(1) : String(Math.round(k))) + "K";
    }
    return trimZeros((n / 1e6).toFixed(2)) + "M";
  }

  function fmtFull(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  // 金额按数量级给小数位。一个回合常常只有几厘钱，固定两位小数会把它压成
  // ¥0.00 —— 看着就像根本没在计费。所以越小给得越细，小到四位小数还不够时
  // 用 "<" 明说"有，只是太小"，而不是让 0 去冒充。
  function fmtCost(v) {
    var cur = cfg.currency || "¥";
    if (!(v > 0)) return cur + "0";
    if (v >= 1) return cur + v.toFixed(2);
    if (v >= 0.01) return cur + v.toFixed(3);
    if (v >= 0.0001) return cur + v.toFixed(4);
    return "<" + cur + "0.0001";
  }

  // 悬停用：不按数量级截断，直接把算出来的值给全
  function fmtCostExact(v) {
    var cur = cfg.currency || "¥";
    if (!(v > 0)) return cur + "0";
    return cur + trimZeros(v.toFixed(6));
  }

  /* ======================================================================
   * 4. UI
   * ==================================================================== */

  var root = null;
  var el = {};      // 缓存 DOM 引用
  var uiScope = "session";
  var pinned = false;
  var settingsOpen = false;
  // 上次的落点：{corner:"top-right"} 或 {x,y}
  var savedSnapshot = readJSON(window.localStorage, LS_POS) || {};

  var rafId = 0, fallbackId = 0;

  // rAF 在 webview 切到后台、或 VS Code 窗口失焦时会被压到几乎不触发。
  // 那种情况下记账照常进行，但界面会永远停在最后一次渲染上 —— 看起来就像
  // "聊天不计费"。所以再挂一个 setTimeout 兜底，谁先到算谁。
  function flush() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (fallbackId) { clearTimeout(fallbackId); fallbackId = 0; }
    render();
  }

  function dirty() {
    if (rafId || fallbackId) return;
    rafId = requestAnimationFrame(flush);
    fallbackId = setTimeout(flush, 200);
  }

  var CSS = [
    ".cuo-root{position:fixed;z-index:2147483000;font-family:var(--app-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);",
    "font-size:11px;line-height:1;color:var(--app-primary-foreground);-webkit-font-smoothing:antialiased;",
    "display:flex;flex-direction:column;align-items:flex-end;gap:6px;}",

    // ---- 胶囊 ----
    ".cuo-pill{display:flex;align-items:center;gap:9px;height:28px;padding:0 11px;border-radius:14px;",
    "background:color-mix(in srgb,var(--app-menu-background) 82%,transparent);",
    "backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);",
    "border:1px solid color-mix(in srgb,var(--app-primary-border-color) 70%,transparent);",
    "box-shadow:0 2px 10px rgba(0,0,0,.16),0 1px 2px rgba(0,0,0,.10);",
    "cursor:grab;user-select:none;-webkit-user-select:none;white-space:nowrap;",
    "transition:box-shadow .18s ease,border-color .18s ease,transform .18s ease;font-variant-numeric:tabular-nums;}",
    ".cuo-root:hover .cuo-pill{border-color:color-mix(in srgb,var(--app-claude-orange) 55%,transparent);",
    "box-shadow:0 4px 16px rgba(0,0,0,.22),0 1px 3px rgba(0,0,0,.12);}",
    ".cuo-pill.cuo-dragging{cursor:grabbing;transform:scale(1.02);}",

    ".cuo-ring{width:14px;height:14px;flex-shrink:0;transform:rotate(-90deg);}",
    ".cuo-ring circle{fill:none;stroke-width:2.5;stroke-linecap:round;}",
    ".cuo-ring .cuo-ring-bg{stroke:color-mix(in srgb,var(--app-primary-foreground) 16%,transparent);}",
    ".cuo-ring .cuo-ring-fg{transition:stroke-dashoffset .5s cubic-bezier(.4,0,.2,1),stroke .4s ease;}",

    ".cuo-sep{width:1px;height:12px;background:color-mix(in srgb,var(--app-primary-foreground) 18%,transparent);flex-shrink:0;}",
    ".cuo-ar{display:flex;align-items:center;gap:4px;color:var(--app-secondary-foreground);}",
    ".cuo-ar b{font-weight:600;color:var(--app-primary-foreground);font-variant-numeric:tabular-nums;}",
    ".cuo-ar.cuo-in svg{color:var(--app-chart-4,#8b8bf5);}",
    ".cuo-ar.cuo-out svg{color:var(--app-chart-2,#4ec9b0);}",

    ".cuo-cost{font-weight:700;color:var(--app-claude-orange);font-variant-numeric:tabular-nums;letter-spacing:.2px;}",
    ".cuo-peak{font-size:9px;padding:1px 4px;border-radius:4px;font-weight:700;letter-spacing:.3px;",
    "background:color-mix(in srgb,var(--app-error-foreground,#e5534b) 18%,transparent);color:var(--app-error-foreground,#e5534b);}",

    // 状态点：常驻三态 —— 灰=统计完成，橙脉冲=流式统计中，蓝=等待用量返回。
    // 颜色不是唯一的通道，每种状态悬停都有文字说明（见 render 里的 dot.title）
    ".cuo-dot{width:5px;height:5px;border-radius:50%;background:var(--app-secondary-foreground);flex-shrink:0;opacity:.45;",
    "transition:opacity .2s ease,background .2s ease;cursor:help;}",
    ".cuo-pill.cuo-live .cuo-dot{background:var(--app-claude-orange);opacity:1;animation:cuo-pulse 1.1s ease-in-out infinite;}",
    ".cuo-pill.cuo-wait .cuo-dot{background:var(--app-chart-4,#8b8bf5);opacity:.9;}",
    "@keyframes cuo-pulse{0%,100%{transform:scale(.7);opacity:.45}50%{transform:scale(1.15);opacity:1}}",

    // ---- 展开卡片 ----
    ".cuo-card{width:268px;border-radius:10px;padding:11px 12px 9px;",
    "background:color-mix(in srgb,var(--app-menu-background) 94%,transparent);",
    "backdrop-filter:blur(18px) saturate(1.7);-webkit-backdrop-filter:blur(18px) saturate(1.7);",
    "border:1px solid color-mix(in srgb,var(--app-primary-border-color) 80%,transparent);",
    "box-shadow:0 8px 28px rgba(0,0,0,.26),0 2px 6px rgba(0,0,0,.14);",
    "opacity:0;visibility:hidden;transform:translateY(-4px) scale(.98);transform-origin:top right;",
    "transition:opacity .16s ease,transform .16s cubic-bezier(.4,0,.2,1),visibility .16s;",
    "pointer-events:none;font-variant-numeric:tabular-nums;}",
    ".cuo-root.cuo-open .cuo-card{opacity:1;visibility:visible;transform:none;pointer-events:auto;}",
    ".cuo-root.cuo-pos-bottom .cuo-card{transform-origin:bottom right;}",
    ".cuo-root.cuo-pos-bottom .cuo-card{order:-1;}",

    ".cuo-head{display:flex;align-items:center;gap:6px;margin-bottom:9px;}",
    ".cuo-tab{padding:2px 7px;border-radius:5px;cursor:pointer;color:var(--app-secondary-foreground);",
    "font-weight:600;transition:background .14s ease,color .14s ease;}",
    ".cuo-tab:hover{background:color-mix(in srgb,var(--app-primary-foreground) 8%,transparent);}",
    ".cuo-tab.cuo-active{background:color-mix(in srgb,var(--app-claude-orange) 16%,transparent);color:var(--app-claude-orange);}",
    ".cuo-spacer{flex:1;}",
    ".cuo-icon{width:18px;height:18px;display:flex;align-items:center;justify-content:center;border-radius:5px;",
    "cursor:pointer;color:var(--app-secondary-foreground);transition:background .14s ease,color .14s ease;}",
    ".cuo-icon:hover{background:color-mix(in srgb,var(--app-primary-foreground) 10%,transparent);color:var(--app-primary-foreground);}",
    ".cuo-icon.cuo-on{color:var(--app-claude-orange);}",

    ".cuo-ctx{margin-bottom:10px;}",
    ".cuo-ctx-top{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px;",
    "color:var(--app-secondary-foreground);}",
    ".cuo-ctx-name{display:flex;align-items:center;gap:5px;min-width:0;}",
    // 这行是给「当前上下文 vs 累计用量」做区分的，别删
    ".cuo-ctx-hint{margin-top:4px;font-size:9px;line-height:1.35;opacity:.62;color:var(--app-secondary-foreground);}",
    ".cuo-tag-manual{background:color-mix(in srgb,var(--app-chart-4,#8b8bf5) 20%,transparent);",
    "color:var(--app-chart-4,#8b8bf5);font-weight:700;cursor:help;}",
    ".cuo-bar{height:4px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,var(--app-primary-foreground) 12%,transparent);}",
    ".cuo-bar i{display:block;height:100%;border-radius:2px;transition:width .5s cubic-bezier(.4,0,.2,1),background .4s ease;}",
    ".cuo-bar i{background:var(--app-chart-3,#3fb950);}",

    ".cuo-row{display:flex;align-items:baseline;justify-content:space-between;padding:2.5px 0;gap:8px;}",
    ".cuo-row span{color:var(--app-secondary-foreground);}",
    ".cuo-row b{font-weight:600;font-family:var(--app-monospace-font-family,monospace);font-size:10.5px;}",
    ".cuo-row .cuo-tok{color:var(--app-primary-foreground);min-width:52px;text-align:right;}",
    ".cuo-row .cuo-amt{color:var(--app-secondary-foreground);min-width:58px;text-align:right;font-weight:500;}",
    ".cuo-row.cuo-total{margin-top:6px;padding-top:7px;border-top:1px solid color-mix(in srgb,var(--app-primary-foreground) 13%,transparent);}",
    ".cuo-row.cuo-total span{color:var(--app-primary-foreground);font-weight:700;}",
    ".cuo-row.cuo-total b{color:var(--app-claude-orange);font-size:11.5px;font-weight:700;}",

    // 页脚四行：计价规则 / 模型 / 服务商 / 状态。用户要的是"看得出来用了哪条
    // 价格规则"，标签堆给不了这个，所以用文字行。
    ".cuo-foot{margin-top:9px;padding-top:8px;display:flex;flex-direction:column;gap:3px;",
    "border-top:1px solid color-mix(in srgb,var(--app-primary-foreground) 10%,transparent);",
    "color:var(--app-secondary-foreground);font-size:10px;}",
    ".cuo-foot .cuo-fl{display:flex;align-items:baseline;gap:6px;min-width:0;}",
    ".cuo-foot .cuo-fl b{font-weight:600;color:var(--app-primary-foreground);}",
    ".cuo-tag{padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--app-primary-foreground) 8%,transparent);}",
    ".cuo-tag-warn{background:color-mix(in srgb,var(--app-error-foreground,#e5534b) 16%,transparent);",
    "color:var(--app-error-foreground,#e5534b);font-weight:700;}",
    // 胶囊上的范围标签（本会话/本回合），金额前面
    ".cuo-scope{font-size:9px;color:var(--app-secondary-foreground);opacity:.85;cursor:help;}",
    // 小字注释：合计舍入说明等
    ".cuo-note{margin-top:5px;font-size:9px;line-height:1.35;opacity:.62;color:var(--app-secondary-foreground);}",
    ".cuo-note-warn{opacity:.95;color:var(--app-claude-orange);}",

    // ---- 设置 ----
    ".cuo-set{margin-top:9px;padding-top:9px;border-top:1px solid color-mix(in srgb,var(--app-primary-foreground) 13%,transparent);}",
    ".cuo-set-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0;}",
    ".cuo-set-row input[type=number]{width:66px;background:var(--app-input-background);color:var(--app-input-foreground);",
    "border:1px solid var(--app-input-border);border-radius:4px;padding:2px 5px;font-size:10.5px;font-family:var(--app-monospace-font-family,monospace);}",
    ".cuo-set-row input[type=number]:focus{outline:none;border-color:var(--app-input-active-border,var(--app-claude-orange));}",
    ".cuo-set-title{font-weight:700;color:var(--app-primary-foreground);margin:7px 0 3px;font-size:10px;letter-spacing:.4px;text-transform:uppercase;}",
    ".cuo-set-head{display:flex;align-items:center;gap:6px;}",
    ".cuo-set-head .cuo-set-title{margin:7px 0 3px;}",
    ".cuo-del{width:14px;height:14px;display:flex;align-items:center;justify-content:center;border-radius:4px;",
    "cursor:pointer;color:var(--app-secondary-foreground);font-size:12px;line-height:1;opacity:.5;transition:all .14s ease;}",
    ".cuo-del:hover{opacity:1;background:color-mix(in srgb,var(--app-error-foreground,#e5534b) 18%,transparent);",
    "color:var(--app-error-foreground,#e5534b);}",
    ".cuo-add input[type=text]{flex:1;min-width:0;background:var(--app-input-background);color:var(--app-input-foreground);",
    "border:1px solid var(--app-input-border);border-radius:4px;padding:2px 6px;font-size:10.5px;}",
    // 所有文本输入框共用同一套皮肤 —— 之前"服务商"框白底黑字就是漏了这条规则，
    // 在深色主题里特别抢眼
    ".cuo-set-row input[type=text]{flex:1;min-width:0;background:var(--app-input-background);color:var(--app-input-foreground);",
    "border:1px solid var(--app-input-border);border-radius:4px;padding:2px 6px;font-size:10.5px;",
    "font-family:var(--app-monospace-font-family,monospace);}",
    ".cuo-set-row input[type=text]:focus{outline:none;border-color:var(--app-input-active-border,var(--app-claude-orange));}",
    ".cuo-root select{-webkit-appearance:none;appearance:none;color-scheme:dark light;",
    "background:var(--app-input-background,rgba(255,255,255,.06));color:var(--app-input-foreground,inherit);",
    "border:1px solid var(--app-input-border,rgba(255,255,255,.14));border-radius:4px;padding:2px 18px 2px 6px;font-size:10.5px;max-width:140px;",
    "background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);",
    "background-position:calc(100% - 9px) 50%,calc(100% - 5px) 50%;background-size:4px 4px;background-repeat:no-repeat;}",
    ".cuo-root select:focus{outline:none;border-color:var(--app-input-active-border,var(--app-claude-orange));}",
    ".cuo-root option{background:var(--app-menu-background,#252526);color:var(--app-primary-foreground,#ccc);}",
    // 价格表列名行（缓存读取/普通输入/输出），跟下面的输入框对齐
    ".cuo-set-cols span{width:52px;text-align:center;font-size:9px;color:var(--app-secondary-foreground);opacity:.8;}",
    // 可折叠分区：计价设置 / 诊断信息
    ".cuo-sec{display:flex;align-items:center;gap:5px;padding:5px 0;cursor:pointer;color:var(--app-primary-foreground);",
    "font-weight:700;font-size:10px;letter-spacing:.4px;text-transform:uppercase;user-select:none;-webkit-user-select:none;}",
    ".cuo-sec:hover{color:var(--app-claude-orange);}",
    ".cuo-sec .cuo-arw{transition:transform .15s ease;font-size:8px;opacity:.8;}",
    ".cuo-sec.cuo-open .cuo-arw{transform:rotate(90deg);}",
    ".cuo-add input[type=text]:focus{outline:none;border-color:var(--app-input-active-border,var(--app-claude-orange));}",
    ".cuo-btn{padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px;font-weight:600;flex-shrink:0;",
    "background:color-mix(in srgb,var(--app-claude-orange) 18%,transparent);color:var(--app-claude-orange);",
    "transition:background .14s ease;}",
    ".cuo-btn:hover{background:color-mix(in srgb,var(--app-claude-orange) 30%,transparent);}",
    ".cuo-set-note{margin-top:7px;color:var(--app-secondary-foreground);font-size:9.5px;line-height:1.5;}",
    ".cuo-link{color:var(--app-link-foreground,var(--app-claude-orange));cursor:pointer;text-decoration:underline;}",

    // ---- 未知模型警告 ----
    ".cuo-warn{display:none;font-size:10px;line-height:1;color:var(--app-error-foreground,#e5534b);flex-shrink:0;}",
    ".cuo-pill.cuo-haswarn .cuo-warn{display:block;}",
    ".cuo-pill.cuo-haswarn{border-color:color-mix(in srgb,var(--app-error-foreground,#e5534b) 45%,transparent);}",
    ".cuo-warnbox{display:none;margin-top:8px;padding:6px 8px;border-radius:6px;font-size:9.5px;line-height:1.5;",
    "background:color-mix(in srgb,var(--app-error-foreground,#e5534b) 12%,transparent);",
    "border:1px solid color-mix(in srgb,var(--app-error-foreground,#e5534b) 30%,transparent);",
    "color:var(--app-error-foreground,#e5534b);}",
    ".cuo-warnbox.cuo-show{display:block;}",
    ".cuo-warnbox b{font-family:var(--app-monospace-font-family,monospace);font-weight:700;word-break:break-all;}",

    ".cuo-toast{position:fixed;z-index:2147483001;padding:5px 10px;border-radius:6px;font-size:11px;",
    "background:var(--app-menu-background);color:var(--app-primary-foreground);border:1px solid var(--app-primary-border-color);",
    "box-shadow:0 4px 14px rgba(0,0,0,.24);}",
    "@media (prefers-reduced-motion:reduce){.cuo-pill.cuo-live .cuo-dot{animation:none}}"
  ].join("");

  var ICON = {
    up: '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
    down: '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3.5 8.5L8 13l4.5-4.5"/></svg>',
    gear: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4"/></svg>',
    reset: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/></svg>'
  };

  function h(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  // 注意：createElement("svg") 建出来的是 HTMLUnknownElement，里面的 <circle> 不会被
  // 当成 SVG 解析（圆环会画不出来）。必须让 HTML 解析器走 foreign content 那条路。
  function svgFromHTML(html) {
    var t = document.createElement("div");
    t.innerHTML = html;
    return t.firstElementChild;
  }

  function ringColor(pct) {
    if (pct >= 85) return "var(--app-error-foreground,#e5534b)";
    if (pct >= 60) return "var(--app-chart-1,#e8912d)";
    return "var(--app-chart-3,#3fb950)";
  }

  function build() {
    root = h("div", { class: "cuo-root", id: "cuo-root" });

    // 上下文圆环
    el.ring = svgFromHTML(
      '<svg class="cuo-ring" viewBox="0 0 16 16">' +
      '<circle class="cuo-ring-bg" cx="8" cy="8" r="6"/>' +
      '<circle class="cuo-ring-fg" cx="8" cy="8" r="6"/>' +
      '</svg>'
    );
    el.ringFg = el.ring.querySelector(".cuo-ring-fg");

    el.arIn = h("span", { class: "cuo-ar cuo-in", html: ICON.up });
    el.inVal = h("b", { text: "0" });
    el.arIn.appendChild(el.inVal);

    el.arOut = h("span", { class: "cuo-ar cuo-out", html: ICON.down });
    el.outVal = h("b", { text: "0" });
    el.arOut.appendChild(el.outVal);

    el.cost = h("span", { class: "cuo-cost", text: cfg.currency + "0" });
    // 胶囊上的金额属于哪个范围？不写清的话，切换本会话/本回合时数字变了
    // 用户都不知道为什么变
    el.scopePill = h("span", { class: "cuo-scope", text: "本会话" });
    el.peakTag = h("span", { class: "cuo-peak", text: "高峰" });
    el.warn = h("span", { class: "cuo-warn", text: "⚠", title: "有模型不在价目表里，费用是估算的" });
    el.dot = h("span", { class: "cuo-dot" });

    el.pill = h("div", { class: "cuo-pill" }, [el.dot, el.ring, el.arIn, el.arOut,
      h("span", { class: "cuo-sep" }), el.scopePill, el.cost, el.peakTag, el.warn]);

    // ---- 卡片 ----
    el.tabSession = h("div", { class: "cuo-tab cuo-active", text: "本会话" });
    el.tabTurn = h("div", { class: "cuo-tab", text: "本回合" });
    el.btnReset = h("div", { class: "cuo-icon", title: "清零重新统计", html: ICON.reset });
    el.btnGear = h("div", { class: "cuo-icon", title: "价格设置", html: ICON.gear });
    var head = h("div", { class: "cuo-head" }, [el.tabSession, el.tabTurn,
      h("span", { class: "cuo-spacer" }), el.btnReset, el.btnGear]);

    el.ctxLabel = h("span", { text: "当前上下文" });
    // 窗口上限如果是设置里手填的，就说清楚 —— 否则用户会以为这是 CLI 报的
    el.ctxMode = h("span", { class: "cuo-tag cuo-tag-manual", text: "手动设置" });
    el.ctxVal = h("span", { text: "0 / 0" });
    el.barFill = h("i", { style: "width:0%" });
    // 光看数字，「当前上下文」和下面的「合计」很容易被当成同一件事：
    // 一个是此刻窗口里压着多少，一个是这个会话逐次累加了多少。写一行说明。
    el.ctxHint = h("div", { class: "cuo-ctx-hint", text: "随对话涨落，压缩后会回落；下方各项是逐次累加" });
    // 压缩是件大事但平时看不见：上下文骤降、而且被丢掉的那些 token 已经付过钱了
    el.ctxNote = h("div", { class: "cuo-note cuo-note-warn", style: "display:none" });
    el.ctx = h("div", { class: "cuo-ctx" }, [
      h("div", { class: "cuo-ctx-top" }, [
        h("span", { class: "cuo-ctx-name" }, [el.ctxLabel, el.ctxMode]),
        el.ctxVal
      ]),
      h("div", { class: "cuo-bar" }, [el.barFill]),
      el.ctxHint, el.ctxNote
    ]);

    function row(label) {
      var tok = h("b", { class: "cuo-tok", text: "0" });
      var amt = h("b", { class: "cuo-amt", text: cfg.currency + "0" });
      return { node: h("div", { class: "cuo-row" }, [h("span", { text: label }), h("span", { class: "cuo-spacer" }), tok, amt]), tok: tok, amt: amt };
    }
    el.rInput = row("输入（未命中）");
    el.rCacheRead = row("缓存读取");
    // 价格表里没有缓存写入这一列 —— 不能让它显得像免费，标清按什么价
    el.rCacheWrite = row("缓存写入（同未命中价）");
    el.rOutput = row("输出");
    el.rTotal = row("合计");
    el.rTotal.node.className = "cuo-row cuo-total";

    // 分项是显示舍入（¥0.0012 + ¥0.0057 看着不等于 ¥0.0070 就是它），
    // 合计按未舍入金额算 —— 这行说明不能省
    el.roundNote = h("div", { class: "cuo-note", text: "分项为显示舍入，合计按未舍入金额计算；悬停金额可见精确值" });
    // "怎么这么贵"是第一反应。缓存写入常常占掉九成以上，不点破的话用户只能干瞪眼
    el.shareNote = h("div", { class: "cuo-note", style: "display:none" });

    el.foot = h("div", { class: "cuo-foot" });
    el.warnBox = h("div", { class: "cuo-warnbox" });

    el.settings = h("div", { class: "cuo-set", style: "display:none" });

    el.card = h("div", { class: "cuo-card" }, [
      head, el.ctx, el.rInput.node, el.rCacheRead.node, el.rCacheWrite.node, el.rOutput.node,
      el.rTotal.node, el.roundNote, el.shareNote, el.warnBox, el.foot, el.settings
    ]);

    root.appendChild(el.pill);
    root.appendChild(el.card);
    document.body.appendChild(root);

    var style = h("style", { text: CSS });
    document.head.appendChild(style);

    applyPosition();
    wire();
    render();
  }

  /* ---------- 位置 / 拖拽 ---------- */

  function cornersOf() {
    return { w: root.offsetWidth || 150, h: root.offsetHeight || 30 };
  }

  function setPos(p) {
    var c = cornersOf();
    var vw = window.innerWidth, vh = window.innerHeight, m = 10;
    if (p.corner === "top-right") { root.style.left = "auto"; root.style.top = m + "px"; root.style.right = m + "px"; root.style.bottom = "auto"; }
    else if (p.corner === "top-left") { root.style.left = m + "px"; root.style.top = m + "px"; root.style.right = "auto"; root.style.bottom = "auto"; }
    else if (p.corner === "bottom-left") { root.style.left = m + "px"; root.style.bottom = m + "px"; root.style.right = "auto"; root.style.top = "auto"; }
    else if (p.corner === "bottom-right") { root.style.right = m + "px"; root.style.bottom = m + "px"; root.style.left = "auto"; root.style.top = "auto"; }
    else if (typeof p.x === "number") {
      root.style.left = Math.max(0, Math.min(vw - c.w, p.x)) + "px";
      root.style.top = Math.max(0, Math.min(vh - 30, p.y)) + "px";
      root.style.right = "auto"; root.style.bottom = "auto";
    }
    root.classList.toggle("cuo-pos-bottom", /bottom/.test(String(p.corner || "")) ||
      (typeof p.y === "number" && p.y > window.innerHeight / 2));
  }

  function applyPosition() {
    if (window.IS_SIDEBAR && cfg.display && cfg.display.showInSidebar === false) {
      root.style.display = "none";
      return;
    }
    root.style.display = "";
    setPos(savedSnapshot || { corner: (cfg.display && cfg.display.position) || "top-right" });
  }

  function snapCorner(x, y) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = x < vw / 2, top = y < vh / 2;
    return (top ? "top" : "bottom") + "-" + (left ? "left" : "right");
  }

  function wire() {
    // 展开只能由胶囊本身触发。卡片收起时是 visibility:hidden，看不见但仍占布局，
    // 所以 root 的框一直延伸到卡片那片空白 —— 绑在 root 上会导致鼠标隔着老远
    // 飘过空白就弹窗。收起则仍然看整个 root，这样鼠标能从胶囊移到卡片上。
    el.pill.addEventListener("mouseenter", function () { root.classList.add("cuo-open"); });
    root.addEventListener("mouseleave", function () {
      if (!pinned) root.classList.remove("cuo-open");
    });

    // 点击胶囊：钉住展开
    el.pill.addEventListener("click", function () {
      if (dragMoved) return;
      pinned = !pinned;
      root.classList.toggle("cuo-open", pinned);
    });

    // 拖拽
    var dragMoved = false, sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

    el.pill.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      var r = root.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      dragging = true; dragMoved = false;
      try { el.pill.setPointerCapture(e.pointerId); } catch (err) {}
    });

    el.pill.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 4) return;
      dragMoved = true;
      el.pill.classList.add("cuo-dragging");
      root.classList.remove("cuo-open");
      setPos({ x: ox + dx, y: oy + dy });
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      el.pill.classList.remove("cuo-dragging");
      try { el.pill.releasePointerCapture(e.pointerId); } catch (err) {}
      if (dragMoved) {
        var r = root.getBoundingClientRect();
        var corner = snapCorner(r.left + r.width / 2, r.top + r.height / 2);
        // 只有松手时离边角足够近才吸附到角落，否则保留自由位置
        var m = 10, near = 28;
        var atCorner =
          (/right/.test(corner) ? Math.abs(window.innerWidth - m - (r.left + r.width)) < near
                                : Math.abs(r.left - m) < near) &&
          (/bottom/.test(corner) ? Math.abs(window.innerHeight - m - (r.top + r.height)) < near
                                 : Math.abs(r.top - m) < near);
        var next = atCorner ? { corner: corner } : { x: Math.round(r.left), y: Math.round(r.top) };
        savedSnapshot = next;
        writeJSON(window.localStorage, LS_POS, next);
        setPos(next);
      }
      setTimeout(function () { dragMoved = false; }, 0);
    }
    el.pill.addEventListener("pointerup", endDrag);
    el.pill.addEventListener("pointercancel", endDrag);

    // 本会话 / 本回合
    el.tabSession.addEventListener("click", function () { uiScope = "session"; syncTabs(); render(); });
    el.tabTurn.addEventListener("click", function () { uiScope = "turn"; syncTabs(); render(); });

    // 清零
    el.btnReset.addEventListener("click", function () {
      acc.entries.clear();
      acc.pending = null;
      acc.turn = 1; acc.lastTurn = 0; acc.ctx = 0;
      render();
      toast("已清零");
    });

    // 设置面板
    el.btnGear.addEventListener("click", function (e) {
      e.stopPropagation();
      settingsOpen = !settingsOpen;
      el.settings.style.display = settingsOpen ? "block" : "none";
      el.btnGear.classList.toggle("cuo-on", settingsOpen);
      if (settingsOpen) buildSettings();
    });

    window.addEventListener("resize", function () { applyPosition(); });
  }

  function syncTabs() {
    el.tabSession.classList.toggle("cuo-active", uiScope === "session");
    el.tabTurn.classList.toggle("cuo-active", uiScope === "turn");
  }

  function toast(msg) {
    var t = h("div", { class: "cuo-toast", text: msg });
    t.style.top = "14px"; t.style.left = "50%"; t.style.transform = "translateX(-50%)";
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1400);
  }

  /* ---------- 设置面板 ---------- */

  // 两个折叠分区的状态。默认都收着 —— 日常只看卡片主体，别让价格表和
  // 事件直方图占掉大半个面板。
  var secPricingOpen = false;
  var secDiagOpen = false;

  function secHeader(label, isOpen) {
    var head = h("div", { class: "cuo-sec" + (isOpen ? " cuo-open" : "") });
    head.appendChild(h("span", { class: "cuo-arw", text: "▶" }));
    head.appendChild(h("span", { text: label }));
    return head;
  }

  function buildSettings(expandPricing) {
    if (expandPricing) secPricingOpen = true;
    el.settings.innerHTML = "";
    var p = cfg.pricing;

    /* ================= 计价设置 ================= */
    var sh = secHeader("计价设置", secPricingOpen);
    var sbody = h("div", { style: "display:" + (secPricingOpen ? "block" : "none") });
    sh.addEventListener("click", function () {
      secPricingOpen = !secPricingOpen;
      buildSettings();
    });
    el.settings.appendChild(sh);
    el.settings.appendChild(sbody);

    // 高峰计价开关
    var chk = h("input", { type: "checkbox" });
    chk.checked = !!p.peakPricingEnabled;
    chk.addEventListener("change", function () {
      cfg.pricing.peakPricingEnabled = chk.checked;
      saveCfg(); render();
    });
    // 倍率是从价目表反推的，不是写死的 —— 用户改过高峰价之后，
    // 这个标签必须跟着改口，否则"双倍"就成了骗人的
    sbody.appendChild(h("div", { class: "cuo-set-row", title: peakTitle(isPeakNow()) }, [
      h("span", { text: "工作日高峰分时计价 " + ratioShort() }), chk
    ]));

    // 上下文窗口
    var cw = h("input", { type: "number", min: "1000", step: "1000" });
    cw.value = (cfg.display && cfg.display.contextWindowFallback) || 1000000;
    cw.addEventListener("change", function () {
      var v = parseInt(cw.value, 10);
      if (v > 0) { cfg.display.contextWindowFallback = v; saveCfg(); render(); }
    });
    sbody.appendChild(h("div", { class: "cuo-set-row" }, [
      h("span", { text: "上下文窗口 (token)" }), cw
    ]));

    // 自动压缩线：真正决定"还能聊多久"的是这条，不是模型窗口。
    // CLI 认不出这些模型名，一律按 200k 触发压缩（本机实测 167K/175K 就压了），
    // 1M 的窗口根本够不到。填 0 = 不按这条线算。' + N + '"
    var ac = h("input", { type: "number", min: "0", step: "1000" });
    ac.value = (cfg.display && cfg.display.autoCompactWindow) || 200000;
    ac.addEventListener("change", function () {
      var v = parseInt(ac.value, 10);
      if (isFinite(v) && v >= 0) { cfg.display.autoCompactWindow = v; saveCfg(); render(); }
    });
    sbody.appendChild(h("div", {
      class: "cuo-set-row",
      title: "上下文涨到这儿，CLI 会把前面的对话总结掉，占用随之回落。' + N + '"
        + "它通常远小于模型窗口 —— CLI 认不出模型名时一律按 200,000 算，所以 1M 的窗口根本用不满。' + N + '"
        + "下面的进度条以这条线为分母，才看得出'还剩多少才被压缩'。填 0 = 改用上面的模型窗口。"
    }, [
      h("span", { text: "自动压缩线 (token)" }), ac
    ]));

    // 汇率：只用于页脚拿 CLI 的 cost-state 对账（CLI 报美元）
    var fx = h("input", { type: "number", min: "0", step: "0.1" });
    fx.value = num(cfg.usdToCny) || 7.1;
    fx.addEventListener("change", function () {
      var v = parseFloat(fx.value);
      if (isFinite(v) && v > 0) { cfg.usdToCny = v; saveCfg(); render(); }
    });
    sbody.appendChild(h("div", {
      class: "cuo-set-row",
      title: "只用来把 CLI 报的美元换成人民币，方便在页脚跟浮层的数对一下。' + N + '"
        + "浮层自己的金额是直接按上面的人民币单价算的，不经过这个汇率。"
    }, [
      h("span", { text: "汇率 1 USD = ¥" }), fx
    ]));

    // 服务商：决定那些单价算不算数。apply.js 会按 settings.json 自动填，
    // CC Switch 换了配置而窗口还没重载时，可以在这里手动改过来。
    // 自动识别和手动填写要分得清 —— 填个名字不能伪装成识别成功。
    var prov = cfg.provider || (cfg.provider = {});
    var pv = h("input", { type: "text" });
    pv.value = prov.label || prov.id || "";
    pv.title = "价目表按哪家填的。" + (prov.baseUrl ? "\nbase_url：" + prov.baseUrl : "");
    pv.addEventListener("change", function () {
      prov.label = String(pv.value || "").trim();
      // 名字改了，id 也跟着换 —— 它俩是同一件事，留着旧的会跟价目表的 provider 对不上
      prov.id = prov.label.toLowerCase().replace(/\s+/g, "-");
      prov.known = true;   // 用户亲自填的，不再算"认不出来"
      prov.source = "manual";
      saveCfg(); render();
      toast("服务商改成 " + prov.label);
    });
    sbody.appendChild(h("div", { class: "cuo-set-row" }, [
      h("span", { text: "服务商" }), pv
    ]));
    sbody.appendChild(h("div", { class: "cuo-set-note", text:
      prov.source === "manual" ? "手动填写。" : "由 apply.js 从 settings.json 的 base_url 自动识别。" }));

    // 历史费用语义：改价只影响之后的请求，已记的每条都定格了当时的单价和时段
    sbody.appendChild(h("div", { class: "cuo-set-title", text: "历史费用" }));
    var reBtn = h("span", { class: "cuo-btn", text: "按当前价重算已记的 " + acc.entries.size + " 条" });
    reBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var n = recomputeAll();
      buildSettings();
      toast("已按当前价重算 " + n + " 条");
    });
    sbody.appendChild(h("div", { class: "cuo-set-row" }, [
      h("span", { text: "改价只影响之后的请求" }), reBtn
    ]));

    sbody.appendChild(h("div", { class: "cuo-set-title", text: "单价 · " + (cfg.currency || "¥") + " / 百万 token" }));
    // 列名直接压在输入框上面 —— 别让用户到下面说明里找顺序
    sbody.appendChild(h("div", { class: "cuo-set-row cuo-set-cols" }, [
      h("span", { text: "　" }),
      h("span", { text: "缓存读取" }),
      h("span", { text: "普通输入" }),
      h("span", { text: "输出" })
    ]));

    Object.keys(p.models || {}).forEach(function (key) {
      var m = p.models[key];
      var del = h("span", { class: "cuo-del", text: "×", title: "删掉这个模型的价目" });
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        if (Object.keys(p.models).length <= 1) { toast("至少要留一个模型"); return; }
        delete p.models[key];
        // 删掉的正好是兜底模型的话，换一个，否则认不出的模型会算出 ¥0
        if (!p.models[p.defaultModel]) p.defaultModel = Object.keys(p.models)[0];
        saveCfg(); buildSettings(); render();
        toast("已删除 " + key);
      });
      // 内置行只在对应服务商下生效，换了家要让人一眼看出它"暂停"了
      var mProv = m.provider || "";
      var fits = entryFitsProvider(m);
      sbody.appendChild(h("div", { class: "cuo-set-head" }, [
        h("span", { class: "cuo-set-title", text: key }),
        mProv
          ? h("span", {
            class: "cuo-tag" + (fits ? "" : " cuo-tag-warn"),
            text: fits ? mProv : "仅 " + mProv,
            title: fits ? "DeepSeek 官方价，只在 DeepSeek 下生效"
              : "这行只在 " + mProv + " 下生效，当前是 " + providerLabel() + "，已暂停使用"
          })
          : null,
        h("span", { class: "cuo-spacer" }),
        del
      ]));
      ["idle", "peak"].forEach(function (tier) {
        var t = m[tier] || (m[tier] = { cacheHit: 0, cacheMiss: 0, output: 0 });
        var row = h("div", { class: "cuo-set-row" }, [
          h("span", { text: tier === "idle" ? "空闲" : "高峰" })
        ]);
        [["cacheHit", "命中"], ["cacheMiss", "未命中"], ["output", "输出"]].forEach(function (pair) {
          var inp = h("input", { type: "number", min: "0", step: "0.01", title: pair[1], style: "width:52px" });
          inp.value = t[pair[0]];
          inp.addEventListener("change", function () {
            var v = parseFloat(inp.value);
            if (isFinite(v) && v >= 0) { t[pair[0]] = v; saveCfg(); render(); }
          });
          row.appendChild(inp);
        });
        sbody.appendChild(row);
      });
    });

    // ---- 加模型 ----
    var nameInp = h("input", { type: "text", placeholder: "如 qwen3-max", style: "flex:1;min-width:0" });
    var addBtn = h("span", { class: "cuo-btn", text: "添加" });
    function doAdd() {
      var name = String(nameInp.value || "").trim();
      if (!name) { toast("先填模型名"); return; }
      if (p.models[name]) { toast("已经有 " + name + " 了"); return; }
      addModel(name);
      buildSettings(); render();
      toast("已加上 " + name + "，填单价");
    }
    addBtn.addEventListener("click", function (e) { e.stopPropagation(); doAdd(); });
    nameInp.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") doAdd();
    });
    nameInp.addEventListener("click", function (e) { e.stopPropagation(); });
    sbody.appendChild(h("div", { class: "cuo-set-row cuo-add" }, [nameInp, addBtn]));
    sbody.appendChild(h("div", { class: "cuo-set-note", text:
      "模型名里含这个词就按它的价算，不区分大小写。" +
      "缓存写入按普通输入价计。改价只影响之后的请求。" }));

    sbody.appendChild(h("div", { class: "cuo-set-note", html:
      '<span class="cuo-link" id="cuo-reset-cfg">恢复默认价目</span>' }));
    var rl = el.settings.querySelector("#cuo-reset-cfg");
    if (rl) rl.addEventListener("click", function () {
      try { window.localStorage.removeItem(LS_CONFIG); } catch (e) {}
      cfg = merge(merge(DEFAULTS, BAKED), {});
      buildSettings(); render();
      toast("已恢复默认");
    });

    /* ================= 诊断信息 ================= */
    var dh = secHeader("诊断信息", secDiagOpen);
    var dbody = h("div", { style: "display:" + (secDiagOpen ? "block" : "none") });
    dh.addEventListener("click", function () {
      secDiagOpen = !secDiagOpen;
      buildSettings();
    });
    el.settings.appendChild(dh);
    el.settings.appendChild(dbody);

    // 自检 + 事件直方图。普通用户不需要看到这些，卡片页脚的"状态"行已经够用了；
    // 需要排查"不计费"时才展开这里。
    var hist = Object.keys(diag.types).sort(function (a, b) { return diag.types[b] - diag.types[a]; })
      .map(function (k) { return k + "×" + diag.types[k]; }).join("  ");
    dbody.appendChild(h("div", { class: "cuo-set-note", html:
      '<span style="opacity:.75">自检：收到 ' + diag.seen + ' 条，记账 ' + acc.entries.size + ' 条' +
      (diag.switches ? '，切会话 ' + diag.switches + ' 次' : '') +
      (diag.errors ? '，<b>' + diag.errors + ' 次出错</b>' : '') + '</span>' +
      (hist ? '<br><span style="opacity:.6;word-break:break-all">' + hist + '</span>' : '') +
      '<br><span class="cuo-link" id="cuo-dump">把收到的原始消息打到 Console</span>' }));
    var dp = el.settings.querySelector("#cuo-dump");
    if (dp) dp.addEventListener("click", function () {
      if (window.console && console.log) {
        console.log("[usage-overlay] 各类型样本:", diag.sample);
        console.log("[usage-overlay] 类型计数:", diag.types);
        console.log("[usage-overlay] 计数:", { seen: diag.seen, 记账: acc.entries.size, 在途: !!acc.pending });
      }
      toast("已打到 Console（Ctrl+Shift+I 看）");
    });
  }

  // 把模型加进价目表。单价先留空（全 0），UI 会把它当"没填价"继续报警，
  // 免得刚加完就显示成一个看着正常的 ¥0。
  // 根据模型名识别它属于哪个服务商（如果能识别的话）
  var PROVIDER_HINTS = {
    "deepseek": ["deepseek"],
    "anthropic": ["claude", "opus", "sonnet", "haiku"],
    "zhipu": ["glm"],
    "moonshot": ["kimi"],
    "qwen": ["qwen"],
    "siliconflow": ["internlm", "llama", "mistral"],
    "openrouter": ["openrouter"]
  };
  function detectModelProvider(modelName) {
    var name = (modelName || "").toLowerCase();
    for (var prov in PROVIDER_HINTS) {
      var hints = PROVIDER_HINTS[prov];
      for (var i = 0; i < hints.length; i++) {
        if (name.indexOf(hints[i]) !== -1) return prov;
      }
    }
    return "";
  }

  function addModel(name) {
    var p = cfg.pricing;
    if (!p.models[name]) {
      var prov = detectModelProvider(name);
      p.models[name] = {
        label: name,
        // 自动识别所属服务商。识别不出来就不标，这样换到任何地方都生效
        provider: prov,
        idle: { cacheHit: 0, cacheMiss: 0, output: 0 },
        peak: { cacheHit: 0, cacheMiss: 0, output: 0 }
      };
      saveCfg();
    }
    return name;
  }

  function saveCfg() {
    // 只持久化用户改过的部分。provider 也得带 —— 手动填的服务商
    // 要跟价目一起活过窗口重载，不然一刷新就退回自动识别的旧值
    writeJSON(window.localStorage, LS_CONFIG, { pricing: cfg.pricing, display: cfg.display, provider: cfg.provider });
  }

  /* ---------- 渲染 ---------- */

  // 摘要 + 悬停精确值。摘要形式（12.8K）适合扫一眼，但看不出到底多少，
  // 所以精确值一律挂在 title 上。
  function setSum(node, n) {
    node.textContent = fmtTokens(n);
    node.title = fmtFull(n) + " token";
  }

  // 窗口上限从哪来：CLI 报的还是设置里手填的。界面上必须标出来 ——
  // 手填值被当成"自动识别"的话，整个占用率就是错的。默认以手填值为准，
  // 因为 CLI 对不认识的模型一律假定 200k，DeepSeek v4 实际是 1M。
  function contextWindowInfo() {
    var d = cfg.display || {};
    var modelWin = num(d.contextWindowFallback) || 1000000;
    var fromCli = !!(d.preferCliContextWindow && acc.ctxWindowFromCli);
    if (fromCli) modelWin = acc.ctxWindowFromCli;
    // 决定"还能聊多久"的是自动压缩线，不是模型窗口：CLI 认不出这些模型名，
    // 一律按 200k 触发压缩（本机实测 167K/175K 就压了），1M 的窗口根本够不到。
    // 拿模型窗口当分母会显示"还剩 87%"，然后压缩毫无预兆地砸下来。
    var autoWin = num(d.autoCompactWindow);
    var useAuto = autoWin > 0 && autoWin < modelWin;
    return {
      win: useAuto ? autoWin : modelWin,
      autoWin: autoWin, modelWin: modelWin, useAuto: useAuto, fromCli: fromCli
    };
  }

  // 胶囊上那笔钱是按哪些模型算的，写进悬停提示 —— 混用多个模型时不要
  // 假装是单一价目算出来的。
  function scopeModelLabel(t) {
    var keys = Object.keys(t.byModel || {});
    if (!keys.length) return (cfg.pricing.models[cfg.pricing.defaultModel] || {}).label || "默认";
    return keys.map(function (k) {
      var b = t.byModel[k];
      return b.known ? ((cfg.pricing.models[k] && cfg.pricing.models[k].label) || k) : (b.model || k) + "（估）";
    }).join(" + ");
  }

  function render() {
    if (!root) return;
    var t = totals(uiScope);
    var peak = t.peak;

    // 胶囊。↑↓ 和金额都是摘要形式，精确值挂在 title 上 —— 12.8K 看不出
    // 到底多少，金额截断到四位小数也可能丢信息。
    var inTok = t.input + t.cacheRead + t.cacheCreation;
    setSum(el.inVal, inTok);
    setSum(el.outVal, t.output);
    el.cost.textContent = fmtCost(t.cost);
    el.cost.title = fmtCostExact(t.cost) + "（按 " + scopeModelLabel(t) + " 价目）";
    // 金额前的范围标签：本会话/本回合。切卡片里的页签时它跟着变。
    el.scopePill.textContent = uiScope === "turn" ? "本回合" : "本会话";
    el.scopePill.title = "显示范围：" + (uiScope === "turn" ? "本回合" : "本会话")
      + "（点开卡片可切换）";
    el.peakTag.style.display = peak ? "" : "none";
    el.peakTag.title = peakTitle(peak);
    // 状态点三态。颜色不是唯一通道：每种状态悬停都有文字。
    var isLive = !!acc.streaming;
    var isWait = !acc.streaming && !!acc.pending;
    el.pill.classList.toggle("cuo-live", isLive);
    el.pill.classList.toggle("cuo-wait", isWait);
    el.dot.title = isLive ? "正在统计（流式输出中，数字随输出逐 token 涨）"
      : isWait ? "等待用量返回（请求已发出，用量还没回来）"
        : "统计完成";

    var unknownNames = Object.keys(t.unknown);
    el.pill.classList.toggle("cuo-haswarn", unknownNames.length > 0);

    // 上下文圆环
    var cwi = contextWindowInfo();
    var win = cwi.win;
    var pct = win > 0 ? Math.min(100, (acc.ctx / win) * 100) : 0;
    var C = 2 * Math.PI * 6;
    el.ringFg.setAttribute("stroke-dasharray", C.toFixed(2));
    el.ringFg.setAttribute("stroke-dashoffset", (C * (1 - pct / 100)).toFixed(2));
    el.ringFg.setAttribute("stroke", ringColor(pct));
    el.ring.style.display = cfg.display && cfg.display.showContextRing === false ? "none" : "";
    el.ring.title = "当前上下文 " + pct.toFixed(1) + "%（" + fmtFull(acc.ctx) + " / " + fmtFull(win)
      + " token）· 不是累计用量"
      + (cwi.useAuto ? "\n分母是自动压缩线（" + fmtTokens(cwi.autoWin) + "），不是模型窗口" : "");

    // 卡片：上下文条
    el.ctxVal.textContent = fmtTokens(acc.ctx) + " / " + fmtTokens(win) + " · " + pct.toFixed(1) + "%";
    el.ctxVal.title = "精确：" + fmtFull(acc.ctx) + " / " + fmtFull(win) + " token（" + pct.toFixed(2) + "%）";
    el.ctxMode.style.display = (cwi.fromCli && !cwi.useAuto) ? "none" : "";
    el.ctxMode.textContent = cwi.useAuto ? "自动压缩线" : "手动设置";
    el.ctxMode.title = cwi.useAuto
      ? "分母 " + fmtFull(win) + " 是自动压缩线 —— 上下文到这儿，CLI 就会把前面的对话总结掉。"
        + "\n模型窗口是 " + fmtFull(cwi.modelWin) + "，但 CLI 认不出这个模型名，"
        + "一律按 " + fmtFull(cwi.autoWin) + " 触发压缩，所以真正会用满的是这条线。"
        + "\n（齿轮面板里可改）"
      : "窗口上限 " + fmtFull(win) + " 是设置里手填的，不是 CLI 报的。"
        + "\nCLI 对不认识的模型一律按 200,000 算，所以这里默认以手填值为准。";
    el.ctx.title = "当前上下文：最近一次请求压在窗口里的 token（未命中输入 + 缓存读取 + 缓存写入）。"
      + "\n它会随对话涨落，自动压缩后回落。"
      + "\n\n和下面的「合计」不是一回事 —— 那个是本次会话每一次请求的累加，只增不减。";

    // 压缩提示：平时不显示，压过才出现。上下文骤降 + 丢掉的 token 已经付过钱，
    // 这两件事都不说明白，用户只会觉得"聊着聊着它突然失忆了"
    var cpt = acc.compact || {};
    if (cpt.count > 0) {
      el.ctxNote.style.display = "";
      el.ctxNote.textContent = (Date.now() - (cpt.at || 0) < 180000)
        ? "刚刚自动压缩：" + fmtTokens(cpt.pre) + " → " + fmtTokens(cpt.post)
          + "，丢掉 " + fmtTokens(Math.max(0, cpt.pre - cpt.post))
        : "已自动压缩 " + cpt.count + " 次 · 累计丢掉 " + fmtTokens(cpt.dropped);
      el.ctxNote.title = "自动压缩是 CLI 自己做的：上下文快到上限时，它把前面的对话总结成一小段。"
        + "\n本次会话压了 " + cpt.count + " 次，最近一次 " + fmtFull(cpt.pre) + " → " + fmtFull(cpt.post)
        + " token，累计丢掉约 " + fmtFull(cpt.dropped) + " token。"
        + "\n被丢掉的内容仍然要付钱 —— 那些 token 已经计过费了。";
    } else {
      el.ctxNote.style.display = "none";
    }
    el.barFill.style.width = pct + "%";
    el.barFill.style.background = ringColor(pct);

    el.rInput.tok.textContent = fmtFull(t.input);
    el.rInput.amt.textContent = fmtCost(t.costInput);
    el.rInput.amt.title = fmtCostExact(t.costInput);

    el.rCacheRead.tok.textContent = fmtFull(t.cacheRead);
    el.rCacheRead.amt.textContent = fmtCost(t.costCacheRead);
    el.rCacheRead.amt.title = fmtCostExact(t.costCacheRead);

    el.rCacheWrite.tok.textContent = fmtFull(t.cacheCreation);
    el.rCacheWrite.amt.textContent = fmtCost(t.costCacheWrite);
    el.rCacheWrite.amt.title = fmtCostExact(t.costCacheWrite);

    // 在途请求的输出可能还没数：显示"等待中…"而不是 0，免得看着像漏统计。
    // 金额同时标"暂计"，请求结束后恢复完整统计。
    var pendingNow = !!acc.pending;
    el.rOutput.tok.textContent = (pendingNow && t.output === 0) ? "…" : fmtFull(t.output);
    el.rOutput.tok.title = pendingNow
      ? "本次请求还没结束，输出用量仍在增长" : "";
    el.rOutput.amt.textContent = fmtCost(t.costOutput) + (pendingNow ? " 暂计" : "");
    el.rOutput.amt.title = fmtCostExact(t.costOutput);

    el.rTotal.tok.textContent = fmtFull(t.tokens);
    el.rTotal.tok.title = "本会话每一次请求累加，与会话长度一起只增不减";
    el.rTotal.amt.textContent = fmtCost(t.cost) + (pendingNow ? " 暂计" : "");
    el.rTotal.amt.title = fmtCostExact(t.cost) + (pendingNow ? "（含 1 笔在途请求，暂计）" : "");
    // "怎么这么贵"是第一反应。缓存写入通常占掉九成以上，不点破就只能干瞪眼
    var cwShare = t.cost > 0 ? t.costCacheWrite / t.cost : 0;
    if (t.costCacheWrite > 0 && cwShare >= 0.15) {
      el.shareNote.style.display = "";
      el.shareNote.textContent = "其中缓存写入占 " + Math.round(cwShare * 100) + "%（" + fmtCost(t.costCacheWrite) + "）";
      el.shareNote.title = "缓存写入：CLI 每往上下文里加新内容（你的提问、工具输出、读进来的文件），"
        + "模型都要把这段重新写进缓存，按「未命中」价计费。\n"
        + "它比缓存读取贵几十倍，所以在长会话里常常是花费大头。\n\n"
        + "想省的话：少粘贴超长内容、别让工具一次吐太多、感觉跑偏了就开新会话（上下文越短，重复写入越少）。";
    } else {
      el.shareNote.style.display = "none";
    }

    // 未知模型警告：把最差的那条说清楚，而不是笼统地标个感叹号
    el.warnBox.innerHTML = "";
    el.warnBox.className = "cuo-warnbox" + (unknownNames.length ? " cuo-show" : "");
    if (unknownNames.length) {
      unknownNames.forEach(function (name) {
        var u = t.unknown[name];
        var priced = (cfg.pricing.models[u.priced] && cfg.pricing.models[u.priced].label) || u.priced;
        var msg = u.via === "unpriced"
          ? " 单价还没填，现在按 ¥0 记。"
          : " 没有对应价目，暂按 " + priced + " 估算（" + fmtCost(u.cost) + "），可能差很多。";
        var add = h("span", { class: "cuo-link", text: u.via === "unpriced" ? "去填价" : "加进价目表" });
        add.addEventListener("click", function (e) {
          e.stopPropagation();
          addModel(name);
          settingsOpen = true;
          el.settings.style.display = "block";
          el.btnGear.classList.add("cuo-on");
          buildSettings(true);
          toast("填上 " + name + " 的单价");
        });
        el.warnBox.appendChild(h("div", {}, [
          h("b", { text: name }), h("span", { text: msg + " " }), add
        ]));
      });
    }

    // 页脚四行：计价规则 / 模型 / 服务商 / 状态。
    // 用户要的第一件事就是"看得出用了哪条价格规则" —— 标签堆给不了，文字行才行。
    el.foot.innerHTML = "";

    function fl(label, valueNode, title) {
      var row = h("div", { class: "cuo-fl" });
      row.appendChild(h("span", { text: label }));
      row.appendChild(valueNode);
      if (title) row.title = title;
      el.foot.appendChild(row);
      return valueNode;
    }

    var models = Object.keys(t.byModel);
    var knownKeys = models.filter(function (k) { return t.byModel[k].known; });
    // 计价行：PRO · 空闲价 · 自动匹配 / 自定义价 / 含估算
    var tierText = !cfg.pricing.peakPricingEnabled ? "不分时段"
      : (peak ? "高峰价" : "空闲价");
    var mode = unknownNames.length ? "含估算 ⚠"
      : (t.customUsed ? "自定义价" : "自动匹配");
    var pricingVal = h("b", { text: (knownKeys.length ? knownKeys.join(" + ").toUpperCase() : "—")
      + " · " + tierText + " · " + mode });
    if (unknownNames.length) pricingVal.className = "cuo-tag-warn";
    var pk = fl("计价：", pricingVal, peakTitle(peak));

    if (models.length === 0) {
      el.foot.appendChild(h("span", { text: "等待数据…" }));
    } else {
      // 模型行：实际收到的模型名，去重
      var modelNames = {};
      models.forEach(function (k) {
        var b = t.byModel[k];
        modelNames[b.model || k] = 1;
      });
      fl("模型：", h("b", { text: Object.keys(modelNames).join(" + ") }));

      // 服务商行：自动识别 vs 手动填写要分清 —— 填个名字不能伪装成识别成功
      var prov = cfg.provider || {};
      var provSrc = prov.source === "manual" ? "手动填写" : "自动识别";
      if (prov.known === false) provSrc = "未识别 ⚠";
      fl("服务商：", h("b", {
        text: providerLabel() + " · " + provSrc,
        className: prov.known === false ? "cuo-tag-warn" : ""
      }), "价目表按这个服务商填的。\n" + (prov.baseUrl ? "base_url：" + prov.baseUrl : "未设 base_url（直连官方）")
        + "\n" + (prov.source === "manual"
          ? "这个名字是在齿轮面板里手动填的。"
          : "由 apply.js 从 settings.json 的 base_url 自动识别，可在齿轮面板里改。"));

      // 状态行：最近更新 N 秒前 / 正在统计 / 等待用量。普通用户只需要这一行，
      // 事件直方图进诊断区了。
      var statusText;
      if (acc.streaming) statusText = "正在统计（流式输出中）";
      else if (acc.pending) statusText = "等待用量返回";
      else if (!acc.lastUpdateAt) statusText = "等待数据…";
      else {
        var sec = Math.max(0, Math.round((Date.now() - acc.lastUpdateAt) / 1000));
        statusText = "统计完成 · " + (sec < 5 ? "刚刚更新" : sec + " 秒前更新");
      }
      // 统计从哪儿算起。重载窗口不清零了，所以这个时间点是跨重载的
      if (acc.startedAt) {
        var sd = new Date(acc.startedAt);
        statusText += " · 自 " + (sd.getHours() < 10 ? "0" : "") + sd.getHours()
          + ":" + (sd.getMinutes() < 10 ? "0" : "") + sd.getMinutes() + " 起";
      }
      var statNode = h("b", { text: statusText });
      statNode.title = (acc.pending ? "有 1 笔请求的用量还没返回，其金额按当前已知数据暂计。\n" : "")
        + "统计从 " + (acc.startedAt ? new Date(acc.startedAt).toLocaleString("zh-CN") : "—")
        + " 开始，重载窗口不会清零。";
      fl("状态：", statNode);

      // 对账行：CLI 自己也在算钱（cost-state），只是价目表不对，会高出一二十倍。
      // 两边都摆出来，用户才能判断"是浮层算错了还是本来就该这么多"，而不是
      // 只能选择信谁。差异本身是预期内的，所以这里只给数、不报警。
      if (acc.cliCost && num(cfg.usdToCny) > 0 && acc.entries.size) {
        var cliUsd = num(acc.cliCost.usd);
        var cliCny = cliUsd * cfg.usdToCny;
        var mine = totals("session").cost;
        var ratio = mine > 0 ? cliCny / mine : 0;
        var reconcile = fl("对账：", h("b", {
          text: "CLI " + fmtCost(cliCny) + "（$" + cliUsd.toFixed(2) + "）· 浮层 " + fmtCost(mine)
        }), "同一场对话，CLI 和浮层各算各的。' + N + '"
          + "CLI：$" + cliUsd.toFixed(4) + " → ¥" + cliCny.toFixed(2) + "（按 1 USD = ¥" + cfg.usdToCny + "）' + N + '"
          + "浮层：¥" + mine.toFixed(4) + "' + N + '"
          + (ratio > 0 ? "倍数：" + ratio.toFixed(1) + "×' + N + '" : "")
          + (acc.cliCost.unknown ? "CLI 那边标了 hasUnknownModelCost —— 它不认识这个模型，套的是兜底价（$5/M 输入、$25/M 输出），所以虚高是预期的。' + N + '" : "")
          + "以浮层为准（价目表是按 DeepSeek 实际单价填的，可用 verify-pricing.js 对账单校准）。");
        if (ratio >= 3) reconcile.className = "cuo-tag-warn";
      }
    }
  }

  /* ======================================================================
   * 5. 启动
   * ==================================================================== */

  function onMessage(e) {
    try {
      var d = e && e.data;
      if (!d || d.type !== "from-extension") return;
      diag.seen++;
      // 记下类型分布 + 每种类型的第一条样本（样本给 DevTools 看，界面只显示分布）
      var mm = unwrap(d.message);
      var ty = (mm && mm.type) || "(无 type)";
      if (mm && mm.type === "stream_event" && mm.event) ty = "stream_event/" + mm.event.type;
      diag.types[ty] = (diag.types[ty] || 0) + 1;
      if (!diag.sample[ty]) {
        try { diag.sample[ty] = JSON.stringify(mm).slice(0, 400); } catch (err) { diag.sample[ty] = "(无法序列化)"; }
      }
      ingest(mm);
    } catch (err) {
      // 绝不能影响主面板
      diag.errors++;
      if (window.console && console.warn) console.warn("[usage-overlay]", err);
    }
  }

  function start() {
    // 先把上回存的账接上 —— 重载窗口不该让钱清零
    try { restoreAcc(); } catch (err) { /* 恢复失败就从零开始 */ }
    // 渲染失败也不能影响记账，所以两件事分开 try
    try {
      build();
    } catch (err) {
      if (window.console && console.warn) console.warn("[usage-overlay] 渲染失败", err);
    }
    try {
      window.addEventListener("message", onMessage);
      // 方便在 DevTools 里排查：__cuo.diag.seen（收到几条）、__cuo.acc.entries.size（记了几条）
      window.__cuo = {
        acc: acc, totals: totals, ingest: ingest, ratesFor: ratesFor, diag: diag,
        fmtCost: fmtCost, fmtCostExact: fmtCostExact, fmtTokens: fmtTokens, fmtFull: fmtFull,
        peakTitle: peakTitle, nextPeakSwitch: nextPeakSwitch, peakRatios: peakRatios,
        ratioShort: ratioShort,
        recomputeAll: recomputeAll, snapFor: snapFor, dirty: dirty, render: render,
        persistAcc: persistAcc, restoreAcc: restoreAcc, contextWindowInfo: contextWindowInfo,
        // 用 getter，否则齿轮改完价 __cuo.cfg 还指着旧对象
        get cfg() { return cfg; },
        // DOM 句柄，方便在 DevTools 里直接看某一行渲染成什么了（测试也用）
        get el() { return el; }
      };
      // 兜底定时渲染：状态行的"秒前更新"和高峰倒计时是时间驱动的，
      // 没有新消息也会变。顺带盖住 rAF 被后台压住的旧坑（见 README）。
      setInterval(function () {
        if (root) { try { render(); } catch (err) {} }
      }, 5000);
    } catch (err) {
      /* 忽略 */
    }
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
