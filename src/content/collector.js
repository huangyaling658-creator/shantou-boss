// ════════════════════════════════════════════════════════════════
// 闪投 · 采集器（ISOLATED world）
// ────────────────────────────────────────────────────────────────
// 跑在 zhipin.com 页面里，借用页面已有的登录态发同源请求。
// 所有对外请求都从这里发出，SW 自己发不了（没有 cookie）。
// ════════════════════════════════════════════════════════════════

const Collector = {
  aborted: false,

  abort() { this.aborted = true; },
  reset() { this.aborted = false; },

  /**
   * 驱动公司主页的「查找职位中包含的关键词」框搜索（= 人在公司页里搜）。
   * 往 .search-job-input 填关键词、点 .job-search-btn，页面自己会发出【公司内部
   * 搜索】请求，嗅探器据此抓到正确的、锁定本公司的模板，再交给 collectPages 复放。
   *
   * 不自己拼接口、不猜参数：请求由页面构造，天然带对 brandId、走对接口、锁死本公司。
   */
  async driveCompanyBoxSearch(keyword) {
    const input = document.querySelector('.search-job-input input, input[placeholder*="查找职位"]');
    const btn = document.querySelector('.job-search-btn, .search-job-input .job-search-btn');
    const KINDS = ['search', 'company', 'recommend'];
    const readKind = (k) => {
      try { const o = JSON.parse(document.documentElement.getAttribute(DOM_BRIDGE.JOBLIST_REQ + '-' + k) || 'null'); return (o && o.url) ? o : null; } catch (e) { return null; }
    };
    const latest = () => {
      let best = null;
      for (const k of KINDS) { const o = readKind(k); if (o && (!best || (o.ts || 0) > (best.ts || 0))) best = Object.assign({ kind: k }, o); }
      return best;
    };

    // 没找到框：不报错失败，退回「页面已抓到的默认列表模板」（公司招聘页天然只有本公司）
    if (!input) {
      const def = latest();
      return def ? { ok: true, kind: def.kind, url: def.url, viaDefault: true }
        : { ok: false, reason: 'no_company_box', url: '' };
    }

    // 记下点框前最新模板的时间戳，用它区分「框发出的新请求」
    const before = latest();
    const beforeTs = before ? (before.ts || 0) : 0;

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, keyword); else input.value = keyword;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await U.sleep(200);
    if (btn) btn.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

    // 等「比点击前更新」的一条请求出现（= 框这次搜索发的）。
    // 注意：DOM 读卡路径并不使用这里返回的 url/kind，只需要列表重渲染即可，
    // 所以不必死等 8 秒——够一次重渲染就返回，后台标签也不会白等满。
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const cur = latest();
      if (cur && (cur.ts || 0) > beforeTs) return { ok: true, kind: cur.kind, url: cur.url };
      await U.sleep(250);
    }
    // 框没发出新请求（可能是纯前端过滤/按钮没绑）→ 退回默认列表模板，至少锁在本公司
    let dbg = [];
    try { dbg = JSON.parse(document.documentElement.getAttribute('data-jt-debug-urls') || '[]'); } catch (e) {}
    return before ? { ok: true, kind: before.kind, url: before.url, viaDefault: true, debugUrls: dbg }
      : { ok: false, reason: 'no_template_after_search', url: '', debugUrls: dbg };
  },

  /**
   * 从搜索结果页的 DOM 里读公司 brandId：扫所有 /gongsi/{brandId}.html 链接，投票取最多的。
   * 搜「公司名」时首屏结果基本都是这家公司，占多数的那个 brandId 就是它。
   * 走 DOM 不走签名接口，所以后台标签也能用、能并行。
   */
  readBrandFromSearchDom(names) {
    const bidOf = (href) => { const m = (href || '').match(/gongsi\/(?:job\/)?([^.?\/]+)\.html/); return (m && m[1]) || null; };
    const want = (names || []).map((s) => String(s || '').toLowerCase()).filter(Boolean);
    const cardSels = ['.job-card-wrapper', 'li.job-card-wrapper', '.job-card-box', 'ul.job-list-box > li', '.search-job-result li', '[class*="job-card"]'];
    let cards = [];
    for (const sel of cardSels) { cards = document.querySelectorAll(sel); if (cards.length) break; }
    const nameOf = (c) => {
      const n = c.querySelector('.company-name, [class*="company-name"], .company-info .name, .name');
      return String((n ? n.textContent : c.textContent) || '').toLowerCase();
    };
    // 1. 【按公司名匹配】：取第一张「公司名含搜索词」的卡的公司链接。
    //    排除底部「推荐的别家公司」（名字不含搜索词），小公司也能精准进自己的页面。
    if (want.length) {
      for (const c of cards) {
        if (!want.some((w) => nameOf(c).includes(w))) continue;
        const a = c.querySelector('a[href*="/gongsi/"]');
        const bid = a && bidOf(a.getAttribute('href'));
        if (bid) return { ok: true, brandId: bid, from: 'name-match' };
      }
    }
    // 2. 退：第一张有公司链接的卡
    for (const c of cards) {
      const a = c.querySelector('a[href*="/gongsi/"]');
      const bid = a && bidOf(a.getAttribute('href'));
      if (bid) return { ok: true, brandId: bid, from: 'first-card' };
    }
    // 3. 兜底：全页 /gongsi/ 链接投票取最多
    const votes = new Map();
    for (const a of document.querySelectorAll('a[href*="/gongsi/"]')) {
      const bid = bidOf(a.getAttribute('href'));
      if (bid) votes.set(bid, (votes.get(bid) || 0) + 1);
    }
    if (!votes.size) return { ok: true, brandId: null };
    const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    return { ok: true, brandId: top[0], from: 'vote' };
  },

  /** 读嗅探器记录的最近 /wapi/ 请求 URL（调试用）*/
  getDebugUrls() {
    try { return JSON.parse(document.documentElement.getAttribute('data-jt-debug-urls') || '[]'); } catch (e) { return []; }
  },

  // ── 请求模板 ──────────────────────────────────────────────

  /**
   * 等 MAIN world 嗅探器捕获到页面自己的列表请求。
   * 页面一进来就会发首屏请求，正常几百毫秒内就有。
   */
  async waitForTemplate(timeoutMs = 10000, preferKind = null) {
    // preferKind 指定时只等那个类型的模板（如 'company'），不退回别的类型
    const attr = preferKind ? (DOM_BRIDGE.JOBLIST_REQ + '-' + preferKind) : DOM_BRIDGE.JOBLIST_REQ;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = document.documentElement.getAttribute(attr);
      if (raw) {
        try {
          const o = JSON.parse(raw);
          if (o && o.url) return o;
        } catch (e) { /* 属性坏了，继续等下一次写入 */ }
      }
      await U.sleep(300);
    }
    return null;
  },

  /** 把模板套到第 N 页。POST 换 body 里的 page，GET 换 URL 上的 page */
  buildPagedRequest(tpl, page) {
    if (tpl.method === 'POST') {
      let body = String(tpl.body || '');
      body = /(^|&)page=\d+/.test(body)
        ? body.replace(/(^|&)page=\d+/, `$1page=${page}`)
        : (body ? `${body}&page=${page}` : `page=${page}`);
      return {
        url: tpl.url,
        init: {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json, text/plain, */*',
          },
          body,
        },
      };
    }
    const u = new URL(tpl.url, location.origin);
    u.searchParams.set('page', String(page));
    return {
      url: u.toString(),
      init: {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json, text/plain, */*' },
      },
    };
  },

  /**
   * 自己构造列表请求。
   *
   * 嗅探器抓不到模板时的退路。参数从当前页面 URL 上抄，因为我们本来就是
   * 自己拼 URL 导航过来的，该带的筛选条件都在地址栏里。
   *
   * 原本的设计只走「复放页面真实请求」这一条路，理由是自己拼容易漏参数。
   * 但实测嗅探会失败（页面首屏请求早于 hook、或走了没覆盖到的链路），
   * 而失败的表现是整个搜索直接报错、一条都搜不到。宁可少几个参数，
   * 也不能没有退路。
   */
  buildOwnRequest(page) {
    const cur = new URL(location.href);
    const u = new URL(BOSS.ORIGIN + BOSS.API.SEARCH_JOBLIST);
    u.searchParams.set('scene', '1');
    for (const k of ['query', 'city', 'experience', 'degree', 'salary', 'scale',
      'stage', 'industry', 'jobType', 'position', 'multiBusinessDistrict',
      'payType', 'partTime', 'jobActive', 'activeTime']) {
      const v = cur.searchParams.get(k);
      if (v) u.searchParams.set(k, v);
    }
    u.searchParams.set('page', String(page));
    u.searchParams.set('pageSize', '30');
    return {
      url: u.toString(),
      init: {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json, text/plain, */*' },
      },
    };
  },

  /**
   * 最后的兜底：直接从页面 DOM 上读岗位卡片。
   *
   * 拿到的字段比接口少（没有 HR 活跃度、公司规模、融资阶段这些），
   * 但至少页面上看得见的岗位不会一个都拿不到。
   * 后台标签页有懒加载节流，所以这条路要求标签页可见，滚动才会触发加载。
   */
  async collectFromDom({ maxScrolls = 12 } = {}) {
    const CARD_SELECTORS = [
      'li.job-card-wrapper', '.job-card-wrapper', '.job-card-box',
      '[class*="job-card"]', '.job-list-box li',
    ];
    const pick = (el, sels) => {
      for (const s of sels) {
        const n = el.querySelector(s);
        if (n && n.textContent.trim()) return n.textContent.trim();
      }
      return '';
    };

    const seen = new Map();
    let lastCount = -1;

    for (let i = 0; i < maxScrolls; i++) {
      if (this.aborted) break;

      let cards = [];
      for (const sel of CARD_SELECTORS) {
        cards = document.querySelectorAll(sel);
        if (cards.length) break;
      }
      if (!cards.length) break;

      for (const c of cards) {
        const link = c.querySelector('a[href*="job_detail"]')?.getAttribute('href') || '';
        const jobId = (link.match(/job_detail\/([^.?]+)/) || [])[1] || '';
        if (!jobId || seen.has(jobId)) continue;

        seen.set(jobId, this.normalizeJob({
          encryptJobId: jobId,
          jobName: pick(c, ['.job-name', '.job-title .job-name', '[class*="job-name"]']),
          salaryDesc: pick(c, ['.salary', '[class*="salary"]']),
          brandName: pick(c, ['.company-name', '[class*="company-name"]']),
          cityName: pick(c, ['.job-area', '[class*="job-area"]']),
          jobExperience: '',
          jobDegree: '',
        }));
      }

      if (seen.size === lastCount) break;   // 滚不动了，到底了
      lastCount = seen.size;

      window.scrollTo(0, document.body.scrollHeight);
      await U.sleep(1200);
    }

    return [...seen.values()];
  },

  /**
   * 精投专用：直接读「公司招聘职位页」(/gongsi/job/)上的岗位卡片。
   * 不抓接口、不猜参数——页面上看得见的卡就是答案。每张卡抠出 jobId（投递只需它）
   * + 岗位名/公司/薪资/城市。翻页靠点「下一页」，点不动了就停。
   *
   * @returns {{jobs:Array, pages:number, stoppedBy:string}}
   */
  async collectCompanyJobsFromDom({ maxPages = 6, cap = 90, intervalMin = 0, intervalMax = 0 } = {}) {
    const CARD_SELECTORS = [
      '.position-job-list li', 'ul.position-job-list > li',
      '.job-card-box', 'li.job-card-wrapper', '[class*="job-card"]',
    ];
    const NEXT_SELECTORS = [
      '.options-pages a.next:not(.disabled)', 'a.ui-icon-arrow-right',
      '.pager-next:not(.disabled)', '.options-pages a:last-child:not(.disabled)',
    ];
    const pick = (el, sels) => {
      for (const s of sels) { const n = el.querySelector(s); if (n && n.textContent.trim()) return n.textContent.trim(); }
      return '';
    };
    // 薪资格式很固定（25-50K、8-12K·15薪、1-2万、200-400元/天、面议…）。
    // 类名靠不住（BOSS 各页 class 不一样），所以类名命中就用、认不出就从整张卡文字里正则认。
    // 「3-5年」「本科」不含 K/万/元，不会被误当薪资。
    const SAL_RE = /\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*[KkWw万千元](?:[·,、]\s*\d+\s*薪)?(?:\s*\/?\s*(?:小时|[天日周月]))?|\d+(?:\.\d+)?\s*[KkWw万千元]\s*以上|薪资面议|面议/;
    const pickSalary = (el) => {
      const byClass = pick(el, ['.job-salary', '.salary', '[class*="salary"]', '.red', 'em']);
      if (byClass) { const m = byClass.match(SAL_RE); if (m) return m[0]; }
      const m = (el.innerText || el.textContent || '').match(SAL_RE);
      return m ? m[0] : (byClass || '');
    };
    const readCards = () => {
      let cards = [];
      for (const sel of CARD_SELECTORS) { cards = document.querySelectorAll(sel); if (cards.length) break; }
      return cards;
    };

    const seen = new Map();
    let stoppedBy = 'exhausted';
    let page = 0;

    for (page = 1; page <= maxPages; page++) {
      if (this.aborted) { stoppedBy = 'aborted'; break; }
      await U.sleep(600);   // 等本页卡片渲染
      const cards = readCards();
      if (!cards.length) { stoppedBy = page === 1 ? 'no_cards' : 'empty_page'; break; }

      let before = seen.size;
      for (const c of cards) {
        const link = c.querySelector('a[href*="job_detail"]')?.getAttribute('href')
          || (/job_detail/.test(c.innerHTML) ? (c.querySelector('a')?.getAttribute('href') || '') : '');
        const jobId = (String(link).match(/job_detail\/([^.?]+)/) || [])[1] || '';
        if (!jobId || seen.has(jobId)) continue;
        seen.set(jobId, this.normalizeJob({
          encryptJobId: jobId,
          jobName: pick(c, ['.job-name', '.job-title .job-name', '[class*="job-name"]', '.name']),
          salaryDesc: pickSalary(c),
          brandName: pick(c, ['.company-name', '[class*="company-name"]', '.company-info .name']),
          cityName: pick(c, ['.job-area', '.job-area-wrapper', '[class*="job-area"]', '[class*="city"]']),
        }));
      }

      // 上报本页进度，让面板进度条跟着翻页平滑推进（而不是一次跳到 99%）
      try { chrome.runtime.sendMessage({ type: MSG.COLLECT_PROGRESS, payload: { domPage: page, domMaxPages: maxPages } }); } catch (e) {}

      if (seen.size >= cap) { stoppedBy = 'cap_reached'; break; }
      if (seen.size === before) { stoppedBy = 'no_new_items'; break; }

      // 翻下一页：找「下一页」按钮点击；找不到就到底
      let next = null;
      for (const s of NEXT_SELECTORS) { const n = document.querySelector(s); if (n && n.offsetHeight > 0) { next = n; break; } }
      if (!next) {
        // 兜底：找文字是「下一页」且可点的
        next = [...document.querySelectorAll('a,button,.ui-icon-arrow-right')]
          .find((el) => /下一页|下一頁/.test(el.textContent || '') && !el.className.includes('disabled'));
      }
      if (!next) { stoppedBy = 'has_more_false'; break; }
      next.click();
      // 翻页间隔随机，精确到 0.01 秒。区间由上层按并行数传入（并行越多越长）
      const lo = intervalMin || CONFIG.PAGE_INTERVAL_MIN_MS || 4000;
      const hi = intervalMax || CONFIG.PAGE_INTERVAL_MAX_MS || 6000;
      await U.sleep(Math.round((lo + Math.random() * (hi - lo)) / 10) * 10);
    }

    return { jobs: [...seen.values()], pages: page, stoppedBy };
  },

  /**
   * 单步：翻一页(可选) + 读「当前这一页」的岗位卡，然后立刻返回。
   * 翻页的节拍(冷却时间)不在这里睡，由 Service Worker 全局统一掐——这样四家公司
   * 共用一条全局队列，任意时刻只有一个请求在飞，均匀无突刺。
   *   turnFirst=false：读第 1 页（刚进页/刚搜完词，不翻）
   *   turnFirst=true ：先点「下一页」，等渲染，再读这一页
   * 返回 { ok, jobs, hasNext, turned }。
   */
  async collectOneDomPage({ turnFirst = false } = {}) {
    const CARD_SELECTORS = [
      '.position-job-list li', 'ul.position-job-list > li',
      '.job-card-box', 'li.job-card-wrapper', '[class*="job-card"]',
    ];
    const NEXT_SELECTORS = [
      '.options-pages a.next:not(.disabled)', 'a.ui-icon-arrow-right',
      '.pager-next:not(.disabled)', '.options-pages a:last-child:not(.disabled)',
    ];
    const pick = (el, sels) => {
      for (const s of sels) { const n = el.querySelector(s); if (n && n.textContent.trim()) return n.textContent.trim(); }
      return '';
    };
    const SAL_RE = /\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*[KkWw万千元](?:[·,、]\s*\d+\s*薪)?(?:\s*\/?\s*(?:小时|[天日周月]))?|\d+(?:\.\d+)?\s*[KkWw万千元]\s*以上|薪资面议|面议/;
    const pickSalary = (el) => {
      const byClass = pick(el, ['.job-salary', '.salary', '[class*="salary"]', '.red', 'em']);
      if (byClass) { const m = byClass.match(SAL_RE); if (m) return m[0]; }
      const m = (el.innerText || el.textContent || '').match(SAL_RE);
      return m ? m[0] : (byClass || '');
    };
    const findNext = () => {
      for (const s of NEXT_SELECTORS) { const n = document.querySelector(s); if (n && n.offsetHeight > 0) return n; }
      return [...document.querySelectorAll('a,button,.ui-icon-arrow-right')]
        .find((el) => /下一页|下一頁/.test(el.textContent || '') && !el.className.includes('disabled')) || null;
    };
    const readCards = () => {
      for (const sel of CARD_SELECTORS) { const cs = document.querySelectorAll(sel); if (cs.length) return cs; }
      return [];
    };

    let turned = false;
    if (turnFirst) {
      const next = findNext();
      if (!next) return { ok: true, jobs: [], hasNext: false, turned: false };
      next.click();
      turned = true;
      await U.sleep(900);   // 等翻页后新卡渲染
    } else {
      await U.sleep(500);   // 等本页渲染
    }

    const jobs = [];
    for (const c of readCards()) {
      const link = c.querySelector('a[href*="job_detail"]')?.getAttribute('href')
        || (/job_detail/.test(c.innerHTML) ? (c.querySelector('a')?.getAttribute('href') || '') : '');
      const jobId = (String(link).match(/job_detail\/([^.?]+)/) || [])[1] || '';
      if (!jobId) continue;
      jobs.push(this.normalizeJob({
        encryptJobId: jobId,
        jobName: pick(c, ['.job-name', '.job-title .job-name', '[class*="job-name"]', '.name']),
        salaryDesc: pickSalary(c),
        brandName: pick(c, ['.company-name', '[class*="company-name"]', '.company-info .name']),
        cityName: pick(c, ['.job-area', '.job-area-wrapper', '[class*="job-area"]', '[class*="city"]']),
      }));
    }
    return { ok: true, jobs, hasNext: !!findNext(), turned };
  },

  /**
   * 委托 MAIN world（嗅探器）用页面自己的 fetch 复放第 page 页。
   *
   * 这是解决 code:19 的关键：BOSS 的 joblist 请求需要拦截器加的签名头，
   * ISOLATED world 的裸 fetch 没有，会被平台拒。MAIN world 的 window.fetch
   * 已被 BOSS 包装，会自动带齐。两个 world 只能靠 postMessage 通信。
   *
   * 返回 {ok, code, list, hasMore} 或 {ok:false, reason}（超时/无模板/未就绪）。
   */
  _mainSeq: 0,
  fetchPageViaMain(page, timeoutMs = 12000, query, kind, position, city) {
    return new Promise((resolve) => {
      const nonce = 'jt' + Date.now() + '_' + (++this._mainSeq);
      let done = false;
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.__jtRes !== 'fetchPage' || d.nonce !== nonce) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(d);
      };
      window.addEventListener('message', onMsg);
      try { window.postMessage({ __jtReq: 'fetchPage', nonce, page, query, kind, position, city }, '*'); } catch (e) {}
      setTimeout(() => {
        if (!done) { window.removeEventListener('message', onMsg); resolve({ ok: false, reason: 'timeout' }); }
      }, timeoutMs);
    });
  },

  /**
   * 海投 v2：驱动 BOSS 首页的搜索框搜词（真人链路第 2 步：主页打词点搜索）。
   * 在 www.zhipin.com 首页执行：填关键词 → 点「搜索」→ 页面自己跳结果页。
   * 找不到首页搜索框就如实返回 false，由 SW 兜底直接导航结果页 URL。
   */
  async driveHomeSearch(keyword) {
    const input = document.querySelector('input[placeholder*="搜索职位"], .search-input input, input[name="query"], [class*="search"] input[type="text"]');
    if (!input) return { ok: false, reason: 'no_home_search_box' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, keyword); else input.value = keyword;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await U.sleep(300);
    const btn = [...document.querySelectorAll('button, a.btn, [class*="search-btn"], [class*="btn-search"]')]
      .find((b) => /^搜\s*索$/.test((b.textContent || '').trim()) && b.offsetHeight > 0);
    if (btn) btn.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return { ok: true, via: btn ? 'button' : 'enter' };
  },

  // ── 海投 v2：滚动读卡（真人链路第 4 步：一路往下滚，一次滚动 = 一个行为）──
  _scrollSeen: null,
  resetScroll() { this._scrollSeen = new Map(); },

  /**
   * 单步：读当前列表里新增的岗位卡 → 向下滚一屏 → 等渲染再读一次。
   * 冷却节拍由 SW 全局闸统一掐，这里只等渲染、不睡长觉。
   * 新版结果页是「左卡右 JD」双栏，左栏是自己的滚动容器，找不到就滚 window。
   * 注意：滚动懒加载只在前台标签触发，SW 调用前负责把标签激活。
   * 字段补全：读卡只有卡片字段，拿 jobId 查嗅探器的 JOBLIST_META
   * （页面自己滚动加载时发的请求被嗅探器记下接口级字段），两头都占。
   * 返回 { ok, jobs(本步新增), newCount, total }。
   */
  async collectOneScroll() {
    if (!this._scrollSeen) this.resetScroll();
    const seen = this._scrollSeen;
    const CARD_SELECTORS = ['.job-card-wrapper', 'li.job-card-wrapper', '.job-card-box', '[class*="job-card"]', '.job-list-box li'];
    const pick = (el, sels) => {
      for (const s of sels) { const n = el.querySelector(s); if (n && n.textContent.trim()) return n.textContent.trim(); }
      return '';
    };
    const SAL_RE = /\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*[KkWw万千元](?:[·,、]\s*\d+\s*薪)?(?:\s*\/?\s*(?:小时|[天日周月]))?|\d+(?:\.\d+)?\s*[KkWw万千元]\s*以上|薪资面议|面议/;
    const pickSalary = (el) => {
      const byClass = pick(el, ['.job-salary', '.salary', '[class*="salary"]', '.red', 'em']);
      if (byClass) { const m = byClass.match(SAL_RE); if (m) return m[0]; }
      const m = (el.innerText || el.textContent || '').match(SAL_RE);
      return m ? m[0] : (byClass || '');
    };
    const metaOf = () => {
      try { return JSON.parse(document.documentElement.getAttribute(DOM_BRIDGE.JOBLIST_META) || '{}'); } catch (e) { return {}; }
    };
    // BOSS 防爬：薪资数字用自定义字体渲染，DOM 读出来是私有区/替换字符
    // （面板里就显示成 □□□-□□□元/天）。检测到乱码就丢弃 DOM 值，
    // 让嗅探器从接口 JSON 里抓的真薪资（meta.salaryDesc）兜底。
    const GARBLE_RE = /[\uE000-\uF8FF\uFFFD]/;
    const cleanSalary = (s) => (s && !GARBLE_RE.test(s) ? s : '');

    const readNew = () => {
      let cards = [];
      for (const sel of CARD_SELECTORS) { cards = document.querySelectorAll(sel); if (cards.length) break; }
      const meta = metaOf();
      const out = [];
      for (const c of cards) {
        const link = c.querySelector('a[href*="job_detail"]')?.getAttribute('href')
          || (/job_detail/.test(c.innerHTML) ? (c.querySelector('a')?.getAttribute('href') || '') : '');
        const jobId = (String(link).match(/job_detail\/([^.?]+)/) || [])[1] || '';
        if (!jobId || seen.has(jobId)) continue;
        seen.set(jobId, true);
        const m = meta[jobId] || {};
        out.push(this.normalizeJob({
          encryptJobId: jobId,
          jobName: pick(c, ['.job-name', '.job-title .job-name', '[class*="job-name"]', '.name']),
          salaryDesc: cleanSalary(pickSalary(c)) || m.salaryDesc || '',
          brandName: pick(c, ['.company-name', '[class*="company-name"]', '.company-info .name']) || m.brandName || '',
          cityName: pick(c, ['.job-area', '.job-area-wrapper', '[class*="job-area"]']) || m.cityName || '',
          // ↓ 嗅探器补的接口级字段（DOM 卡上没有的）
          areaDistrict: m.areaDistrict || '',
          securityId: m.securityId || '',
          encryptBossId: m.encryptBossId || '',
          encryptBrandId: m.encryptBrandId || '',
          brandScaleName: m.brandScaleName || '',
          brandStageName: m.brandStageName || '',
          brandIndustry: m.brandIndustry || '',
          jobLabels: m.jobLabels || [],
          skills: m.skills || [],
          welfareList: m.welfareList || null,
          daysPerWeekDesc: m.daysPerWeekDesc || null,
          proxyJob: m.proxyJob,
          anonymous: m.anonymous,
        }));
      }
      return out;
    };

    // 1) 先收当前屏的新卡
    const first = readNew();

    // 2) 向下滚一屏：优先找左栏自己的滚动容器，找不到滚 window
    let box = null;
    let n = document.querySelector(CARD_SELECTORS[0]) || document.querySelector('[class*="job-card"]');
    while (n && n !== document.body) {
      try {
        const st = getComputedStyle(n);
        if (n.scrollHeight > n.clientHeight + 80 && /(auto|scroll)/.test(st.overflowY)) { box = n; break; }
      } catch (e) { /* 忽略 */ }
      n = n.parentElement;
    }
    if (box) box.scrollBy(0, Math.max(300, Math.round(box.clientHeight * 0.9)));
    else window.scrollBy(0, Math.max(400, Math.round(window.innerHeight * 0.9)));
    await U.sleep(900);   // 等滚动触发加载 + 新卡渲染

    // 3) 再收滚动后的新卡
    const second = readNew();
    const jobs = [...first, ...second];
    return { ok: true, jobs, newCount: jobs.length, total: seen.size };
  },

  // ── 分页采集 ──────────────────────────────────────────────

  /**
   * 复放列表请求逐页采集。
   *
   * 为什么不用滚动加载 DOM：Chrome 对后台标签页有引擎级节流，BOSS 的无限
   * 滚动懒加载不触发，只能拿到首屏十几条。网络请求不受可见性节流影响，
   * 后台标签页照常跑，所以直调接口是唯一能在后台稳定跑满的路径。
   *
   * @returns {{jobs: Array, pages: number, stoppedBy: string}}
   */
  async collectPages({ maxPages = CONFIG.MAX_PAGES, onProgress, relevance = null, queryOverride = null, positionOverride = null, cityOverride = null, preferKind = null, noSelfBuild = false } = {}) {
    // noSelfBuild=true：抓不到页面模板时【不】自己拼全局搜索兜底（精投专用）——
    // 全局兜底会丢掉 brandId、变成全网搜，宁可如实返回 0 也不给错误的全网结果。
    // preferKind='company' 时，强制用公司主页接口模板复放，不被同页全局搜索模板污染
    // positionOverride/cityOverride：注入职位类型 code、城市 code，让接口按类目+地点精筛
    this.reset();
    // queryOverride：精投「源头筛」——复放时把关键词换成职位词，让接口只返回匹配的。
    // relevance = { field:'jobName'|'companyName', tokens:[...] }
    //   BOSS 在精确匹配发完后会用「推荐」岗位把后面的页填满（还一直说 hasMore）。
    //   逐页判断相关度：这一页有多少岗位的 field 命中 tokens，连续两页基本不命中
    //   就认定翻进了推荐填充区，停下，别再往下收垃圾。
    const relOf = (job) => {
      if (!relevance || !relevance.tokens || !relevance.tokens.length) return true;
      const v = String(job[relevance.field] || '').toLowerCase();
      return relevance.tokens.some((t) => v.includes(t));
    };
    let drift = 0;

    // 完全对齐即投 collectViaApi：
    //   1. 等页面自己发列表请求、嗅探器捕到模板，最多等 8 秒（后台标签页慢，
    //      等短了抓不到）。
    //   2. 抓到模板 → 从第 1 页起用 API 复放翻页。第 1 页照常请求，不玩花招；
    //      页面自己的首屏请求发生在几秒前（等 cs 就绪那段时间），跟我们的第 1 页
    //      有自然间隔，不构成 1 秒双发。
    //   3. 第 1 页就失败 / 抓不到模板 → 整体回退 DOM 采集。
    const tpl = await this.waitForTemplate(8000, preferKind);
    const source = tpl ? 'template' : 'self_built';

    // 精投：抓不到模板且禁用全局兜底 → 直接如实返回 0，绝不退回全网搜
    if (!tpl && noSelfBuild) {
      return { jobs: [], pages: 0, stoppedBy: 'no_template', source: 'none' };
    }

    const seen = new Map();
    let stoppedBy = 'exhausted';
    let stall = 0;
    let lastPage = 0;

    for (let page = 1; page <= maxPages; page++) {
      lastPage = page;
      if (this.aborted) { stoppedBy = 'aborted'; break; }

      // ★ 优先用 MAIN world 驱动复放（带 BOSS 签名头，避免 code:19）。
      //   MAIN 明确被平台拒（返回了 code≠0）→ 不再裸 fetch 加压，直接止损。
      //   MAIN 超时/无模板/没就绪 → ISOLATED 裸 fetch 兜底。
      let list = null;
      let hasMore = true;
      let via = await this.fetchPageViaMain(page, 12000, queryOverride, preferKind, positionOverride, cityOverride);

      if (via && via.ok) {
        list = via.list; hasMore = via.hasMore;
      } else if (via && typeof via.code === 'number' && via.code !== BOSS.CODE.OK) {
        stoppedBy = via.code === BOSS.CODE.SOFT_BLOCK ? 'soft_block_37' : `code_${via.code}`;
        break;
      } else {
        // 兜底裸 fetch。精投禁用全局自拼(noSelfBuild)时，没有页面模板就不兜底
        // （自拼会丢 brandId 变全网搜），直接止损。
        if (!tpl && noSelfBuild) { stoppedBy = 'no_template'; break; }
        let { url, init } = tpl ? this.buildPagedRequest(tpl, page) : this.buildOwnRequest(page);
        if (queryOverride != null) ({ url, init } = this.patchQuery(url, init, queryOverride));
        if (positionOverride != null) ({ url, init } = this.patchParam(url, init, 'position', positionOverride));
        if (cityOverride != null) ({ url, init } = this.patchParam(url, init, 'city', cityOverride));
        try {
          const res = await fetch(url, init);
          if (!res.ok) { stoppedBy = `http_${res.status}`; break; }
          const json = await res.json();
          if (typeof json.code === 'number' && json.code !== BOSS.CODE.OK) {
            stoppedBy = json.code === BOSS.CODE.SOFT_BLOCK ? 'soft_block_37' : `code_${json.code}`;
            break;
          }
          list = json?.zpData?.jobList || json?.zpData?.jobCardList || json?.zpData?.list || [];
          hasMore = json?.zpData?.hasMore !== false;
        } catch (e) { stoppedBy = 'network_error'; break; }
      }

      if (!Array.isArray(list) || list.length === 0) { stoppedBy = 'empty_page'; break; }

      let newCount = 0;
      let relCount = 0;
      for (const raw of list) {
        const job = this.normalizeJob(raw);
        if (relOf(job)) relCount++;
        if (job.jobId && !seen.has(job.jobId)) { seen.set(job.jobId, job); newCount++; }
      }

      if (onProgress) onProgress({ page, total: seen.size, newCount });

      // 总量兜底：收够了就停，别一口气扫太多职位引 BOSS 注意
      const cap = CONFIG.COLLECT_CAP_PER_SEARCH || 90;
      if (seen.size >= cap) { stoppedBy = 'cap_reached'; break; }

      // 相关度闸门：这一页命中率太低（<25%）记一次漂移，连续两页漂移就停——
      // 已经翻进 BOSS 的推荐填充区了，再翻全是无关岗位。第 1 页不计（有时首屏乱）。
      if (relevance && relevance.tokens && relevance.tokens.length && page > 1) {
        const rate = list.length ? relCount / list.length : 0;
        // 放宽一点：命中率跌破 15% 才记漂移，连续 3 页漂移才停。
        // 目的是多翻几页、把筛完还能剩够 75 个的量攒出来，别因一两页稀疏就早停。
        if (rate < 0.15) { drift++; if (drift >= 3) { stoppedBy = 'off_topic'; break; } }
        else drift = 0;
      }

      // 连续两页无新增才停（对齐即投的 stall>=2），单页重复可能是分页抖动
      if (newCount === 0) { stall++; if (stall >= 2) { stoppedBy = 'no_new_items'; break; } }
      else stall = 0;

      if (hasMore === false) { stoppedBy = 'has_more_false'; break; }

      // 随机抖动的翻页间隔，更像人、更不触发限流
      await U.sleep(U.randInt(CONFIG.PAGE_INTERVAL_MIN_MS || 4500, CONFIG.PAGE_INTERVAL_MAX_MS || 7000));
    }

    // 接口这条路一条都没拿到，落到 DOM 采集再试一次
    if (seen.size === 0 && !this.aborted) {
      const domJobs = await this.collectFromDom();
      if (domJobs.length) {
        return { jobs: domJobs, pages: 1, stoppedBy: 'dom_fallback', source: 'dom' };
      }
    }

    return { jobs: [...seen.values()], pages: lastPage, stoppedBy, source };
  },

  /**
   * 平台原始字段 → 我们的岗位记录。
   * 只做映射和派生，不做任何过滤判断，过滤是上层的事。
   */
  normalizeJob(raw) {
    const jobId = raw.encryptJobId || raw.jobId || '';
    const jobName = raw.jobName || raw.name || '';
    const sal = U.parseSalary(raw.salaryDesc || '');
    const proxyJob = typeof raw.proxyJob === 'number' ? raw.proxyJob : 0;
    const anonymous = typeof raw.anonymous === 'number' ? raw.anonymous : 0;

    const job = {
      jobId,
      jobName,
      jobNameNormalized: U.normalizeJobName(jobName),

      companyName: raw.brandName || '',
      companyId: raw.encryptBrandId || raw.brandId || '',
      companyScale: raw.brandScaleName || '',
      financeStage: raw.brandStageName || '',
      industry: raw.brandIndustry || '',

      city: raw.cityName || '',
      district: raw.areaDistrict || '',
      businessDistrict: raw.businessDistrict || '',

      salaryDesc: raw.salaryDesc || '',
      salaryMin: sal.min,
      salaryMax: sal.max,
      salaryMonths: sal.months,

      experience: raw.jobExperience || '',
      degree: raw.jobDegree || '',
      skills: raw.skills || [],
      jobLabels: raw.jobLabels || [],
      welfareList: raw.welfareList || null,
      daysPerWeekDesc: raw.daysPerWeekDesc || null,

      hrId: raw.encryptBossId || raw.bossId || '',
      hrName: raw.bossName || '',
      hrTitle: raw.bossTitle || '',
      hrOnline: typeof raw.bossOnline === 'boolean' ? raw.bossOnline : undefined,
      hrActiveDesc: raw.activeTimeDesc || '',

      proxyJob,
      anonymous,
      // 猎头代招和匿名岗在列表页拿不到活跃度，且不是「只投大厂」的目标，
      // 打标后由上层硬规则剔除
      isHeadhunter: !!(proxyJob || anonymous),

      securityId: raw.securityId || '',
      link: jobId ? BOSS.PAGE.JOB_DETAIL(jobId) : '',

      jdText: null,
      jdFetchedAt: null,
      state: JOB_STATE.RECALLED,
      createdAt: U.now(),
      updatedAt: U.now(),
    };

    job.fingerprint = U.fingerprint(job);
    return job;
  },

  // ── 投递 ──────────────────────────────────────────────────

  /**
   * BOSS 自带的「自动招呼语」开关。
   *
   * 不关掉的话，点「立即沟通」平台会先替你发一条默认模板语，
   * 我们精心写的那条变成第二句，HR 看到的第一眼还是模板。
   * 投递前关，整批结束后恢复原状。
   */
  async setGreetingSwitch(enabled) {
    const res = await fetch(BOSS.ORIGIN + BOSS.API.GREETING_UPDATE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `status=${enabled ? 1 : 0}`,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: json.code === BOSS.CODE.OK, raw: json };
  },

  async getGreetingSwitch() {
    const res = await fetch(BOSS.ORIGIN + BOSS.API.GREETING_LIST, { credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    const d = json?.zpData || {};
    return { enabled: !!(d.status || d.greetingStatus), raw: json };
  },

  /**
   * 读详情页上「立即沟通」按钮的文案。
   *
   * 这是去重的最后一道兜底，而且是免费的：
   * 文案是「继续沟通」说明这个岗位早就聊过了，直接跳过，不浪费一次沟通额度。
   * 插件不做冷启动回读历史会话，全靠这一下把手动聊过的岗位挡住。
   */
  readChatButton(doc = document) {
    const SELS = ['a.btn-startchat', '.btn-startchat', '[class*="btn-startchat"]',
      '.job-banner .btn-container a', '.btn.btn-startchat'];
    for (const s of SELS) {
      const el = doc.querySelector(s);
      if (el) {
        const txt = (el.textContent || '').trim();
        return { found: true, text: txt, alreadyChatted: txt.includes('继续沟通'), el };
      }
    }
    return { found: false, text: '', alreadyChatted: false, el: null };
  },

  /** 点「立即沟通」。点完 BOSS 会整页跳到聊天页 */
  async clickChatButton() {
    const btn = this.readChatButton();
    if (!btn.found) return { ok: false, reason: 'button_not_found' };
    if (btn.alreadyChatted) return { ok: false, reason: 'already_chatted' };
    btn.el.click();
    return { ok: true };
  },

  /** 同 HR 换岗位时会弹「沟通新职位」确认框，需要多点一下 */
  async confirmChangeJobDialog(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const btns = [...document.querySelectorAll('.dialog-container button, .boss-dialog button, .dialog-wrap button')];
      const hit = btns.find((b) => /沟通新职位|确定|继续/.test(b.textContent || ''));
      if (hit) { hit.click(); return { clicked: true }; }
      await U.sleep(300);
    }
    return { clicked: false };
  },

  /**
   * 在聊天页发一条文本消息。
   *
   * BOSS 的输入框是 Vue 托管的，直接改 value 组件收不到，
   * 必须派发 input 事件走原生 setter，否则发送按钮一直是禁用态。
   */
  // BOSS 聊天页真实选择器（对齐即投，实测有效）
  CHAT: {
    input: 'div#chat-input.chat-input',
    btnSend: 'button.btn-send',
    sentBubble: '.item-myself',            // 自己发出的消息气泡
    imageInput: '.btn-sendimg input[type=file]',
  },

  async waitEl(sel, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 0) return el;   // 只要可见的
      await U.sleep(250);
    }
    return null;
  },

  /**
   * 发文字招呼语，并**验证真的发出去了**。
   *
   * 之前的 bug：找到输入框、点一下发送就返回 ok:true，根本没验证。
   * 失败的消息气泡照样插进 DOM，所以点了不等于发成功。
   * 现在照即投：填字 → 等发送按钮从 .disabled 变可用 → 记下发送前自己
   * 消息数 → 点发送 → 轮询自己消息数是否 +1 且状态不是「发送失败」。
   */
  async sendChatText(text) {
    if (!text || !text.trim()) return { ok: false, reason: 'greeting_empty' };

    const input = await this.waitEl(this.CHAT.input, 10000);
    if (!input) return { ok: false, reason: 'input_not_found' };
    const btn = await this.waitEl(this.CHAT.btnSend, 3000);
    if (!btn) return { ok: false, reason: 'send_btn_not_found' };

    // contenteditable div：直填 textContent + 派发 InputEvent 让 Vue v-model 更新
    input.focus();
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    if (!input.textContent || !input.textContent.trim()) {
      return { ok: false, reason: 'fill_failed' };
    }

    // 等 Vue watch 把 btn-send 从 .disabled 切成可用（BOSS 用 class 不是 disabled 属性）
    await U.sleep(700);
    let enabled = !btn.classList.contains('disabled') && !btn.disabled;
    if (!enabled) { await U.sleep(300); enabled = !btn.classList.contains('disabled') && !btn.disabled; }
    if (!enabled) return { ok: false, reason: 'send_btn_disabled' };

    const before = document.querySelectorAll(this.CHAT.sentBubble).length;
    btn.click();

    // 验证：自己消息数 +1，且新气泡不是「发送失败」状态
    const ok = await this._waitDelivered(before, 8000);
    return ok ? { ok: true } : { ok: false, reason: 'not_delivered' };
  },

  /** 轮询确认最新自己消息确实发出去了（不是失败气泡）*/
  async _waitDelivered(baselineCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const items = document.querySelectorAll(this.CHAT.sentBubble);
      if (items.length > baselineCount) {
        const last = items[items.length - 1];
        const st = last.querySelector('.message-status');
        const cls = (st && st.className) || '';
        // 明确失败态
        if (/fail|error|警告|error/i.test(cls) || /发送失败|重新发送/.test(last.textContent || '')) {
          return false;
        }
        // 没有失败标记、气泡已出现 → 认为投递成功
        if (!/loading|sending|发送中/i.test(cls)) return true;
      }
      await U.sleep(400);
    }
    return false;   // 超时没确认到 → 如实算失败，不谎报成功
  },

  /**
   * 上传并发送简历截图。
   * 走 BOSS 自己的上传接口拿到图床地址，再通过聊天页的文件输入框发出去。
   */
  async sendChatImage(dataUrl) {
    // BOSS 的发图 file input 藏在 .btn-sendimg 里；change 事件会触发它自动上传+发送
    const fileInput = document.querySelector(this.CHAT.imageInput)
      || document.querySelector('input[type=file]');
    if (!fileInput) return { ok: false, reason: 'file_input_not_found' };

    const before = document.querySelectorAll(this.CHAT.sentBubble).length;

    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], `resume_${Date.now()}.png`, { type: blob.type || 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    // React/Vue 兼容，两种事件都派发
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));

    // 验证图片真的作为一条消息发出去了（上传+发送需要时间，给 15 秒）
    const ok = await this._waitImageDelivered(before, 15000);
    return ok ? { ok: true } : { ok: false, reason: 'image_not_delivered' };
  },

  /** 确认新出现的自己消息里带了图片 */
  async _waitImageDelivered(baselineCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const items = document.querySelectorAll(this.CHAT.sentBubble);
      if (items.length > baselineCount) {
        const last = items[items.length - 1];
        if (last.querySelector('img')) {
          const st = last.querySelector('.message-status');
          if (!/fail|error/i.test((st && st.className) || '')) return true;
        }
      }
      await U.sleep(500);
    }
    return false;
  },

  // ── JD 抓取 ──────────────────────────────────────────────

  /**
   * 拉单个岗位的 JD 全文。
   *
   * ★ 调用方必须保证串行且间隔 ≥ CONFIG.JD_FETCH_INTERVAL_MS（3 秒）。
   *   1.5 秒实测会触发 BOSS 软封锁 code:37。这是整个系统里最贵也最危险的
   *   动作，请求量直接等于风控风险，所以上层必须先用廉价过滤把候选砍到
   *   几百个再调这里。
   */
  // JD 正文选择器，读页面 DOM 和读 fetch 回来的 HTML 共用
  JD_SELECTORS: [
    '.job-sec-text', '.job-detail-section .text', '.job-detail .text',
    '[class*="job-detail"] [class*="text"]', '.job-sec .text',
  ],

  /**
   * 从「当前已经打开的详情页」DOM 直接读 JD。
   * 配合可见导航用：先把标签页导到详情页（用户看得见），再读它的正文。
   */
  readCurrentJd() {
    for (const sel of this.JD_SELECTORS) {
      const el = document.querySelector(sel);
      const txt = el && el.textContent.trim();
      if (txt && txt.length > 50) return txt.slice(0, CONFIG.JD_TEXT_MAX_LEN);
    }
    let best = '';
    document.querySelectorAll('div,section,p').forEach((el) => {
      const t = el.textContent.trim();
      if (t.length > best.length && t.length < 8000) best = t;
    });
    return best.length > 50 ? best.slice(0, CONFIG.JD_TEXT_MAX_LEN) : '';
  },

  async fetchJD(jobId, securityId) {
    let url = BOSS.PAGE.JOB_DETAIL(jobId);
    // 带上 securityId 更接近页面内真实跳转，减少被判定为异常访问的可能
    if (securityId) url += `?securityId=${encodeURIComponent(securityId)}`;

    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) throw new Error(`jd_http_${res.status}`);

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 容器 class 随改版会变，按优先级依次尝试，全落空再退到正文启发式
    const SELECTORS = [
      '.job-sec-text',
      '.job-detail-section .text',
      '.job-detail .text',
      '[class*="job-detail"] [class*="text"]',
    ];
    for (const sel of SELECTORS) {
      const el = doc.querySelector(sel);
      const txt = el && el.textContent.trim();
      if (txt && txt.length > 50) return txt.slice(0, CONFIG.JD_TEXT_MAX_LEN);
    }

    // 兜底：取页面里最长的一段文本块。JD 通常是详情页最长的一块
    let best = '';
    doc.querySelectorAll('div,section,p').forEach((el) => {
      const t = el.textContent.trim();
      if (t.length > best.length && t.length < 8000) best = t;
    });
    if (best.length > 50) return best.slice(0, CONFIG.JD_TEXT_MAX_LEN);

    throw new Error('jd_not_found');
  },

  // ── 公司品牌解析 ──────────────────────────────────────────

  /**
   * 按公司名反查 BOSS 的 encryptBrandId。
   *
   * 设计选择：不去调未经验证的「公司搜索」接口，而是复用已确认可用的岗位
   * 搜索接口，从返回岗位里取 brandName / encryptBrandId。理由是接口路径靠
   * 猜容易在平台改版时静默失效，而岗位搜索是本产品的主链路，它坏了我们
   * 立刻就会知道，不会悄悄退化。
   *
   * 「只投大厂」最大的坑就在这里：字节在 BOSS 上可能是「字节跳动」「抖音」
   * 「巨量引擎」等多个主体，靠公司名模糊匹配一定漏。所以返回全部候选主体，
   * 由上层结合别名表决定收哪些。
   *
   * @returns {Array<{brandId, brandName, jobCount}>}
   */
  async searchBrand(companyName) {
    const tpl = await this.waitForTemplate();
    if (!tpl) throw new Error('no_template');

    const { url, init } = this.buildPagedRequest(tpl, 1);
    const patched = this.patchQuery(url, init, companyName);

    const res = await fetch(patched.url, patched.init);
    if (!res.ok) throw new Error(`brand_http_${res.status}`);
    const json = await res.json();
    if (typeof json.code === 'number' && json.code !== BOSS.CODE.OK) {
      throw new Error(`brand_code_${json.code}`);
    }

    const list = json?.zpData?.jobList || json?.zpData?.jobCardList || [];
    const brands = new Map();
    for (const j of list) {
      const id = j.encryptBrandId || j.brandId;
      const name = j.brandName;
      if (!id || !name) continue;
      if (!brands.has(id)) brands.set(id, { brandId: id, brandName: name, jobCount: 0 });
      brands.get(id).jobCount++;
    }
    return [...brands.values()].sort((a, b) => b.jobCount - a.jobCount);
  },

  /** 把模板请求里的关键词换成指定值（POST 换 body，GET 换 query） */
  patchQuery(url, init, query) { return this.patchParam(url, init, 'query', query); },

  /** 把复放请求里的某个参数替换成指定值（GET 改 query、POST 改 body）*/
  patchParam(url, init, key, value) {
    const re = new RegExp(`(^|&)${key}=[^&]*`);
    if (init.method === 'POST') {
      let body = String(init.body || '');
      body = re.test(body)
        ? body.replace(re, `$1${key}=${encodeURIComponent(value)}`)
        : `${body ? body + '&' : ''}${key}=${encodeURIComponent(value)}`;
      return { url, init: { ...init, body } };
    }
    const u = new URL(url, location.origin);
    u.searchParams.set(key, value);
    return { url: u.toString(), init };
  },

  // ── 风控信号 ──────────────────────────────────────────────

  /**
   * 读当前页面上的风控迹象。
   * 两个来源：嗅探器记下的 BOSS 错误码，以及页面上出现的验证码组件。
   */
  checkRisk() {
    const out = { captcha: false, softBlock: false, detail: null };

    try {
      const raw = document.documentElement.getAttribute(DOM_BRIDGE.LAST_ERROR);
      if (raw) {
        const e = JSON.parse(raw);
        // 只认 5 分钟内的，避免把上次任务的旧信号当成本次的
        if (Date.now() - e.ts < 5 * 60 * 1000) {
          out.detail = e;
          if (e.code === BOSS.CODE.SOFT_BLOCK) out.softBlock = true;
        }
      }
    } catch (e) { /* 忽略 */ }

    const CAPTCHA_HINTS = [
      '.geetest_panel', '.geetest_holder', '#captcha',
      '[class*="verify-"]', '[class*="captcha"]',
    ];
    for (const sel of CAPTCHA_HINTS) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { out.captcha = true; break; }
    }
    if (/验证|安全验证/.test(document.title)) out.captcha = true;

    return out;
  },
};
