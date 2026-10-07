// ════════════════════════════════════════════════════════════════
// 闪投 · 使用埋点（本文件同时可被 panel / service worker 加载）
// ────────────────────────────────────────────────────────────────
// 只打 3 类事件（需求方明确「只保三个数据」）：
//   panel_open          面板打开            → 使用日活（DAU）
//   mode_click {mode}   点了海投/精投       → 两个模式的点击渗透
//   send_click          点了一键投递        → 投递按钮点击渗透
// 渗透口径：某天点过该按钮的去重用户数 ÷ 当天日活（去重 uid）。
//
// 隐私：uid 是首次运行时生成的 8 位随机匿名 ID（0-9 + a-z 小写，约 2.8 万亿组合），
//      不含账号、姓名等任何个人资料；卸载重装会换新 ID，视为新用户。
// 储存与传送（2026-10-07 与统一后台定稿的方案；2026-10-08 加「空闲即报」）：
//   ① 储存：事件先落 chrome.storage.local（封顶 5000 先进先出，本地不丢）；
//   ② 传送：两个条件任一满足即触发批量上报——
//      a) 攒够 ANALYTICS_FLUSH_BATCH 条；
//      b) 最后一次行为后 ANALYTICS_IDLE_FLUSH_MS 毫秒内无新行为（每来一条重置计时）。
//      service worker 每 6 小时 + 每次启动也会自动调 flush() 补发兜底
//     （MV3 下 setTimeout 可能随 worker 休眠失效，兜底链路保证数据终将送达、不丢）；
//      上报地址 CONFIG.ANALYTICS_ENDPOINT（统一平台唯写接口），未配置时空转（只存本地）；
//      上报成功才推进游标，失败静默下次再传，埋点任何异常都不影响主流程。
//   ③ 内容：只发行为流水（按钮名+时间+uid），不发简历、手机号等任何隐私数据，不加密（HTTPS 已加密传输）。
// 可见性：使用统计不给用户看（面板区块已下线），公司查看走密码保护的数据后台。
// ════════════════════════════════════════════════════════════════

const Tracker = {
  _uid: null,
  _flushing: false,
  _idleTimer: null,

  /** 生成 8 位匿名安装 ID：0-9 + a-z（小写），crypto 加密级随机 */
  _newInstallId() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    const buf = new Uint32Array(8);
    crypto.getRandomValues(buf);
    let id = '';
    for (let i = 0; i < 8; i++) id += chars[buf[i] % 36];
    return id;
  },

  /** 取（或首次生成）匿名安装 ID。旧版本已生成的 UUID 式 ID 保留沿用，不强制换新 */
  async uid() {
    if (this._uid) return this._uid;
    const key = STORE.UI.INSTALL_ID;
    const st = await chrome.storage.local.get(key);
    let id = st[key];
    if (!id) {
      id = this._newInstallId();
      await chrome.storage.local.set({ [key]: id });
    }
    this._uid = id;
    return id;
  },

  /** 时间戳 → 本地日期串 YYYY-MM-DD（统计按自然日聚合） */
  dayOf(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  /** 打一个事件。任何失败都吞掉——埋点绝不能影响投递主流程 */
  async track(event, props) {
    try {
      const ts = Date.now();
      const rec = { ts, day: this.dayOf(ts), uid: await this.uid(), event, props: props || {} };
      const key = STORE.UI.ANALYTICS;
      const st = await chrome.storage.local.get(key);
      const arr = Array.isArray(st[key]) ? st[key] : [];
      arr.push(rec);
      // 封顶先进先出，防无限增长
      const cap = CONFIG.ANALYTICS_MAX_EVENTS || 5000;
      while (arr.length > cap) arr.shift();
      await chrome.storage.local.set({ [key]: arr });
      // 上报触发（2026-10-08 用户定稿，两个条件任一满足）：
      //   a) 攒批：每积累约 N 条触发一次 flush；
      //   b) 空闲：每次行为后重置一个 N 毫秒计时器，期间再无新行为就 flush。
      // 都不满足时等 6 小时闹钟/下次启动补发；未配端点时 flush 内部直接返回
      const batch = CONFIG.ANALYTICS_FLUSH_BATCH || 10;
      if (arr.length % batch === 0) this.flush();
      const idleMs = CONFIG.ANALYTICS_IDLE_FLUSH_MS || 10000;
      if (this._idleTimer) clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => { this._idleTimer = null; this.flush(); }, idleMs);
    } catch (e) { /* 静默 */ }
  },

  /**
   * 方案 B 预留：批量上报到云端后台。
   * 用「已上报游标」记进度，成功才推进；本地事件数组超顶 shift 后
   * 游标可能越界，越界就重置到当前长度（丢的只是上报进度，本地数据在）。
   */
  async flush() {
    const endpoint = CONFIG.ANALYTICS_ENDPOINT;
    if (!endpoint || this._flushing) return;
    this._flushing = true;
    try {
      const key = STORE.UI.ANALYTICS;
      const curKey = STORE.UI.ANALYTICS_UPLOADED;
      const st = await chrome.storage.local.get([key, curKey]);
      const arr = Array.isArray(st[key]) ? st[key] : [];
      let cursor = typeof st[curKey] === 'number' ? st[curKey] : 0;
      if (cursor > arr.length) cursor = arr.length;
      const pending = arr.slice(cursor);
      if (!pending.length) return;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: pending }),
      });
      if (res.ok) await chrome.storage.local.set({ [curKey]: arr.length });
    } catch (e) { /* 网络失败下次再说 */ }
    finally { this._flushing = false; }
  },

  /**
   * 汇总近 N 天的三个指标。
   * 返回 { days:[{day, dau, ht, jt, send}], total:{dau, ht, jt, send} }
   * 每天一行：dau=当天去重活跃，ht/jt/send=当天点过对应按钮的去重人数；
   * total 是整段区间的去重并集（渗透率 = total.x / total.dau）。
   */
  async stats(days = 30) {
    const key = STORE.UI.ANALYTICS;
    const st = await chrome.storage.local.get(key);
    const arr = Array.isArray(st[key]) ? st[key] : [];
    const cutoff = Date.now() - days * 86400000;

    const byDay = new Map();
    const bucket = (day) => {
      if (!byDay.has(day)) {
        byDay.set(day, { day, active: new Set(), ht: new Set(), jt: new Set(), send: new Set() });
      }
      return byDay.get(day);
    };
    for (const e of arr) {
      if (!e || e.ts < cutoff) continue;
      const b = bucket(e.day || this.dayOf(e.ts));
      if (e.event === 'panel_open') b.active.add(e.uid);
      else if (e.event === 'mode_click' && e.props && e.props.mode === 'position') b.ht.add(e.uid);
      else if (e.event === 'mode_click' && e.props && e.props.mode === 'company') b.jt.add(e.uid);
      else if (e.event === 'send_click') b.send.add(e.uid);
    }

    const rows = [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((b) => ({ day: b.day, dau: b.active.size, ht: b.ht.size, jt: b.jt.size, send: b.send.size }));

    const union = { active: new Set(), ht: new Set(), jt: new Set(), send: new Set() };
    for (const b of byDay.values()) {
      for (const u of b.active) union.active.add(u);
      for (const u of b.ht) union.ht.add(u);
      for (const u of b.jt) union.jt.add(u);
      for (const u of b.send) union.send.add(u);
    }
    return {
      days: rows,
      total: { dau: union.active.size, ht: union.ht.size, jt: union.jt.size, send: union.send.size },
    };
  },

  /** 导出近 N 天的逐日汇总 CSV（交给需求方/老板看的格式） */
  async exportCsv(days = 90) {
    const { days: rows } = await this.stats(days);
    const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '0%');
    const head = '日期,日活(去重),海投点击人数,海投渗透,精投点击人数,精投渗透,投递点击人数,投递渗透';
    const lines = rows.map((r) =>
      [r.day, r.dau, r.ht, pct(r.ht, r.dau), r.jt, pct(r.jt, r.dau), r.send, pct(r.send, r.dau)].join(','));
    return '﻿' + [head, ...lines].join('\r\n');   // 开头是 BOM，Excel 打开中文不乱码
  },
};
