// ════════════════════════════════════════════════════════════════
// 闪投 · 请求嗅探器（MAIN world，document_start）
// ────────────────────────────────────────────────────────────────
// 职责只有一个：捕获 BOSS 页面自己发出的岗位列表请求，把「请求模板」和
// 「响应里的额外字段」交给 ISOLATED world 的采集器。
//
// 为什么不自己拼搜索 URL：
//   BOSS 的列表请求带一批我们无法稳定复现的参数（securityId、场景标识、
//   随平台改版增减的查询串）。自己拼当天能跑，平台一改就静默失效，而且
//   失效的表现是「搜到的岗位变少」，不报错，极难发现。复放页面自己的
//   真实请求，只替换 page，参数永远是对的。
//
// 为什么必须在 MAIN world：
//   content script 默认跑在 ISOLATED world，那里的 window.fetch 是副本，
//   hook 不到页面自身的请求。只有 MAIN world 能改到页面真正用的那个 fetch。
//
// 两个世界之间唯一的共享物是 DOM 树，所以用 documentElement 的属性传递。
// ════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // 与 shared/constants.js 的 DOM_BRIDGE 对应。
  // 此文件跑在 MAIN world，加载不到 constants.js（那是 ISOLATED world 的），
  // 故此处是全项目唯一允许的字面量重复，共三个字符串，改动时需同步。
  const ATTR_REQ = 'data-jt-joblist-req';
  const ATTR_META = 'data-jt-joblist-meta';
  const ATTR_PAGE1 = 'data-jt-joblist-page1';
  const ATTR_ERR = 'data-jt-last-error';

  const JOBLIST_PATTERNS = [
    '/wapi/zpgeek/search/joblist.json',
    '/wapi/zpgeek/pc/recommend/job/list.json',
    '/wapi/zpgeek/company/job/list.json', // 公司主页在招职位
  ];

  const isJoblist = (url) => JOBLIST_PATTERNS.some((p) => String(url).includes(p));

  // 调试：把页面发出的所有 /wapi/ 请求 URL 滚动记下来（最近12条），
  // 用来排查「某页到底调了哪个接口」——比如公司招聘页的职位列表接口是什么。
  function noteDebugUrl(url) {
    try {
      const s = String(url);
      if (!s.includes('/wapi/')) return;
      let arr = [];
      try { arr = JSON.parse(document.documentElement.getAttribute('data-jt-debug-urls') || '[]'); } catch (e) {}
      // 去掉 query 只留路径，短一点；但保留是否带 query 的信息
      arr.push(s.split('?')[0] + (s.includes('?') ? '?…' : ''));
      if (arr.length > 12) arr = arr.slice(-12);
      document.documentElement.setAttribute('data-jt-debug-urls', JSON.stringify(arr));
    } catch (e) { /* 忽略 */ }
  }

  /** 列表响应里带的、但 DOM 上没有的字段。这是廉价过滤层的弹药 */
  function harvestMeta(json) {
    try {
      const list =
        json?.zpData?.jobList ||
        json?.zpData?.jobCardList ||
        json?.zpData?.list ||
        [];
      if (!Array.isArray(list) || !list.length) return;

      // 把页面自己的第 1 页整包存下来，让采集器直接读，不必再请求一次第 1 页。
      // 只存第一次捕获到的（就是首屏那一页），后续翻页的不覆盖它。
      if (!document.documentElement.getAttribute(ATTR_PAGE1)) {
        try { document.documentElement.setAttribute(ATTR_PAGE1, JSON.stringify(list)); } catch (e) {}
      }

      let map = {};
      try {
        map = JSON.parse(document.documentElement.getAttribute(ATTR_META) || '{}');
      } catch (e) { /* 属性被外部写坏，重建即可 */ }

      for (const j of list) {
        const id = j.encryptJobId || j.jobId;
        if (!id) continue;
        map[id] = {
          welfareList: j.welfareList || null,
          daysPerWeekDesc: j.daysPerWeekDesc || null,
          bossOnline: typeof j.bossOnline === 'boolean' ? j.bossOnline : undefined,
          proxyJob: typeof j.proxyJob === 'number' ? j.proxyJob : undefined,
          anonymous: typeof j.anonymous === 'number' ? j.anonymous : undefined,
          securityId: j.securityId || undefined,
          encryptBossId: j.encryptBossId || j.bossId || undefined,
          brandName: j.brandName || undefined,
          encryptBrandId: j.encryptBrandId || j.brandId || undefined,
          cityName: j.cityName || undefined,
          areaDistrict: j.areaDistrict || undefined,
          jobLabels: j.jobLabels || undefined,
          skills: j.skills || undefined,
          salaryDesc: j.salaryDesc || undefined,
          brandScaleName: j.brandScaleName || undefined,
          brandStageName: j.brandStageName || undefined,
          brandIndustry: j.brandIndustry || undefined,
        };
      }
      document.documentElement.setAttribute(ATTR_META, JSON.stringify(map));
    } catch (e) { /* 采集是尽力而为，坏了就让消费方 fail-open */ }
  }

  /** BOSS 业务错误码。code:37 = 频率软封锁，是最重要的风控信号 */
  function noteError(json, url) {
    try {
      const code = json?.code;
      if (typeof code === 'number' && code !== 0) {
        document.documentElement.setAttribute(ATTR_ERR, JSON.stringify({
          code, url: String(url), ts: Date.now(), message: json.message || '',
        }));
      }
    } catch (e) { /* 忽略 */ }
  }

  // 模板优先级：搜索 > 公司 > 推荐。
  // 搜索页会同时发「搜索接口」和「推荐接口」，谁后发谁就会覆盖模板；
  // 一旦覆盖成推荐接口，复放翻页返回的全是推荐流（跟关键词无关的垃圾）。
  // 所以低优先级的请求绝不能盖掉已抓到的高优先级模板。
  const KIND_RANK = { search: 3, company: 2, recommend: 1 };
  // 按接口类型分开存模板，key = ATTR_REQ + '-' + kind。
  // 这样采公司主页岗位时能【强制用 company 模板】，不被同页的全局搜索框
  // 发出的 search 请求覆盖（之前就是被 search 盖掉，复放成全网搜索灌进别家公司）。
  function saveTemplate(url, method, body) {
    try {
      const kind = String(url).includes('search/joblist') ? 'search'
        : String(url).includes('company/job/list') ? 'company'
          : 'recommend';
      const tpl = JSON.stringify({
        url: String(url),
        method: String(method || 'GET').toUpperCase(),
        body: typeof body === 'string' ? body : '',
        kind,
        ts: Date.now(),
      });
      // 1. 分类型存：同类型后发覆盖先发（拿到最新一页的模板），不同类型互不干扰
      try { document.documentElement.setAttribute(ATTR_REQ + '-' + kind, tpl); } catch (e) {}
      // 2. 仍维护一个「默认最佳模板」ATTR_REQ（优先级：搜索>公司>推荐），
      //    给没指定类型的调用方用（海投/普通搜索走这个）。
      const prev = document.documentElement.getAttribute(ATTR_REQ);
      if (prev) {
        try {
          const prevKind = JSON.parse(prev).kind;
          if ((KIND_RANK[prevKind] || 0) > (KIND_RANK[kind] || 0)) return;
        } catch (e) { /* 解析失败就照常覆盖 */ }
      }
      document.documentElement.setAttribute(ATTR_REQ, tpl);
    } catch (e) { /* 忽略 */ }
  }

  // ── hook fetch ──
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    let method = 'GET';
    let body = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
      method = (init && init.method) || (input && input.method) || 'GET';
      if (init && typeof init.body === 'string') body = init.body;
    } catch (e) { /* 忽略 */ }

    const p = origFetch.apply(this, arguments);

    noteDebugUrl(url);
    if (isJoblist(url)) {
      saveTemplate(url, method, body);
      // clone 后再读，绝不能消费掉页面自己要用的那份 body
      p.then((res) => {
        try {
          res.clone().json().then((json) => {
            noteError(json, url);
            harvestMeta(json);
          }).catch(() => {});
        } catch (e) { /* 忽略 */ }
      }).catch(() => {});
    }
    return p;
  };

  // ── hook XMLHttpRequest（BOSS 部分链路仍走 XHR）──
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__jt = { method, url };
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__jt;
    if (info) noteDebugUrl(info.url);
    if (info && isJoblist(info.url)) {
      saveTemplate(info.url, info.method, typeof body === 'string' ? body : '');
      this.addEventListener('load', function () {
        try {
          const json = JSON.parse(this.responseText);
          noteError(json, info.url);
          harvestMeta(json);
        } catch (e) { /* 非 JSON 响应，忽略 */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ── MAIN world 翻页驱动（关键：解决 code:19）──
  // ISOLATED world 的采集器裸 fetch 复放 joblist，会缺 BOSS 拦截器加的签名头，
  // 平台回 code:19。这里在 MAIN world 用页面自己的 window.fetch 复放
  // （此时 window.fetch 已经过 BOSS 的拦截器包装，会自动带齐签名），
  // 采集器通过 postMessage 委托到这里执行，再把结果传回去。
  // query 非空时，在复放请求里把关键词也替换掉（精投「源头筛」用：
  // 拉公司主页时注入职位词，让 BOSS 只返回这家公司里匹配职位的岗位）。
  function buildPagedReq(req, page, query, position, city) {
    const isPost = String(req.method || 'GET').toUpperCase() === 'POST';
    const setParam = (body, k, v) => (new RegExp('(^|&)' + k + '=[^&]*')).test(body)
      ? body.replace(new RegExp('(^|&)' + k + '=[^&]*'), '$1' + k + '=' + encodeURIComponent(v))
      : (body ? body + '&' : '') + k + '=' + encodeURIComponent(v);
    if (isPost) {
      let body = String(req.body || '');
      body = /(^|&)page=\d+/.test(body)
        ? body.replace(/(^|&)page=\d+/, '$1page=' + page)
        : (body ? body + '&page=' + page : 'page=' + page);
      if (query != null) body = setParam(body, 'query', query);
      if (position != null) body = setParam(body, 'position', position);
      if (city != null) body = setParam(body, 'city', city);
      return {
        url: req.url,
        init: {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, text/plain, */*' },
          body,
        },
      };
    }
    let url = req.url;
    try {
      const u = new URL(req.url, location.href);
      u.searchParams.set('page', String(page));
      if (query != null) u.searchParams.set('query', query);
      if (position != null) u.searchParams.set('position', position);
      if (city != null) u.searchParams.set('city', city);
      url = u.href;
    } catch (e) {}
    return { url, init: { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json, text/plain, */*' } } };
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__jtReq !== 'fetchPage') return;
    const nonce = d.nonce;
    const reply = (o) => { try { window.postMessage(Object.assign({ __jtRes: 'fetchPage', nonce }, o), '*'); } catch (e) {} };

    // d.kind 指定了就强制用那个类型的模板（精投采公司主页 → 'company'），
    // 没指定走默认最佳模板 ATTR_REQ。指定了但没抓到该类型 → 明确报错，绝不
    // 退回别的类型模板（否则又会用错接口）。
    let req;
    try {
      const attr = d.kind ? (ATTR_REQ + '-' + d.kind) : ATTR_REQ;
      req = JSON.parse(document.documentElement.getAttribute(attr) || 'null');
    } catch (e) {}
    if (!req || !req.url) { reply({ ok: false, reason: d.kind ? ('no_template_' + d.kind) : 'no_template' }); return; }

    const pr = buildPagedReq(req, d.page, d.query, d.position, d.city);
    // 用 MAIN world 的 window.fetch —— 已被 BOSS 拦截器包装，自动加签名头
    window.fetch(pr.url, pr.init).then((r) => r.json()).then((o) => {
      const code = (o && typeof o.code === 'number') ? o.code : 0;
      const list = (o && o.zpData && (o.zpData.jobList || o.zpData.jobCardList || o.zpData.list)) || null;
      reply({
        ok: code === 0 && Array.isArray(list),
        code,
        list: Array.isArray(list) ? list : [],
        hasMore: !!(o && o.zpData && o.zpData.hasMore !== false),
      });
    }).catch(() => reply({ ok: false, reason: 'fetch_err' }));
  });
})();
