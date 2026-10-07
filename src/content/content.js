// ════════════════════════════════════════════════════════════════
// 闪投 · content script 消息路由（ISOLATED world）
// ────────────────────────────────────────────────────────────────
// SW 是编排中枢但没有 cookie，所有需要登录态的动作都委托到这里执行。
// 本文件只做「收消息 → 调 Collector → 回结果」，不放业务逻辑。
// ════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // 同一批 content_scripts 可能被重复注入（SPA 路由变化 + 手动 executeScript），
  // 重复注册监听器会导致一条消息被回复多次，sendResponse 报错
  if (window.__jtContentLoaded) return;
  window.__jtContentLoaded = true;

  const HANDLERS = {
    [MSG.PING]: async () => ({
      ok: true,
      url: location.href,
      hasTemplate: !!document.documentElement.getAttribute(DOM_BRIDGE.JOBLIST_REQ),
    }),

    [MSG.COLLECT_PAGES]: async (payload) => {
      const result = await Collector.collectPages({
        maxPages: payload?.maxPages || CONFIG.MAX_PAGES,
        relevance: payload?.relevance || null,
        queryOverride: payload?.queryOverride ?? null,
        positionOverride: payload?.positionOverride ?? null,
        cityOverride: payload?.cityOverride ?? null,
        preferKind: payload?.preferKind || null,
        noSelfBuild: !!payload?.noSelfBuild,
        onProgress: (p) => {
          // 进度是 fire-and-forget，SW 可能正好在休眠，失败无所谓
          chrome.runtime.sendMessage({ type: MSG.COLLECT_PROGRESS, payload: p }).catch(() => {});
        },
      });
      return { ok: true, ...result };
    },

    [MSG.FETCH_JD]: async (payload) => {
      const text = await Collector.fetchJD(payload.jobId, payload.securityId);
      return { ok: true, jobId: payload.jobId, jdText: text };
    },

    [MSG.READ_JD]: async () => ({ ok: true, jdText: Collector.readCurrentJd() }),

    [MSG.SEARCH_BRAND]: async (payload) => {
      const brands = await Collector.searchBrand(payload.companyName);
      return { ok: true, brands };
    },

    [MSG.READ_BRAND_DOM]: async (payload) => Collector.readBrandFromSearchDom(payload && payload.names),

    [MSG.COMPANY_BOX_SEARCH]: async (payload) => {
      return await Collector.driveCompanyBoxSearch(payload.keyword || '');
    },

    [MSG.COMPANY_DOM_COLLECT]: async (payload = {}) => {
      const r = await Collector.collectCompanyJobsFromDom({
        maxPages: payload.maxPages || CONFIG.MAX_PAGES,
        cap: payload.cap || CONFIG.COLLECT_CAP_PER_SEARCH,
        intervalMin: payload.intervalMin || 0,
        intervalMax: payload.intervalMax || 0,
      });
      return { ok: true, ...r };
    },

    // 单步读页：翻一页(可选)+读这一页。冷却节拍由 SW 全局掐，这里不睡。
    [MSG.COMPANY_DOM_PAGE]: async (payload = {}) => {
      return await Collector.collectOneDomPage({ turnFirst: !!payload.turnFirst });
    },

    // 海投 v2：首页搜索框驱动（真人链路第 2 步）
    [MSG.DRIVE_HOME_SEARCH]: async (payload = {}) => {
      return await Collector.driveHomeSearch(payload.keyword || '');
    },

    // 海投 v2：换词/换城时清空滚动读卡状态
    [MSG.SCROLL_RESET]: async () => { Collector.resetScroll(); return { ok: true }; },

    // 海投 v2 布置：在结果页筛选栏按 code 点一个筛选项（找不到由 SW 退回 URL 补）
    [MSG.APPLY_FILTER]: async (payload = {}) => {
      return Collector.applyFilterByCode(payload.key || '', payload.code || '');
    },

    // 海投 v2 布置地点：点页面城市选择器选城市 / 读当前城市 chip（jobs 列表页不吃 URL city 参数）
    [MSG.APPLY_CITY]: async (payload = {}) => {
      return Collector.applyCity(payload.code || '', payload.name || '');
    },
    [MSG.READ_CITY_CHIP]: async () => Collector.readCityChip(),

    // 海投 v2 单步：读新增卡 → 滚一屏。节拍由 SW 全局闸掐；SW 负责先激活标签。
    [MSG.COLLECT_ONE_SCROLL]: async () => {
      return await Collector.collectOneScroll();
    },

    [MSG.CHECK_RISK]: async () => ({ ok: true, ...Collector.checkRisk() }),

    // 抓筛选项字典。三个来源各自独立，任一失败不影响其余
    [MSG.GREETING_SWITCH]: async (payload) => {
      if (payload && typeof payload.enabled === 'boolean') {
        return { ok: true, ...(await Collector.setGreetingSwitch(payload.enabled)) };
      }
      return { ok: true, ...(await Collector.getGreetingSwitch()) };
    },

    [MSG.OPEN_DETAIL]: async () => ({ ok: true, ...Collector.readChatButton() }),

    [MSG.CLICK_CHAT]: async () => {
      const r = await Collector.clickChatButton();
      return { ok: true, ...r };
    },

    [MSG.SEND_CHAT]: async (payload) => {
      await Collector.confirmChangeJobDialog();

      // 招呼语必须真的发出去了才算数（sendChatText 内部会验证）
      const t = await Collector.sendChatText(payload.text);
      if (!t.ok) return { ok: true, sent: false, reason: t.reason };

      // 简历图逐张发，记录真正发成功了几张
      let images = 0;
      const imgReasons = [];
      for (const dataUrl of payload.images || []) {
        const r = await Collector.sendChatImage(dataUrl);
        if (r.ok) images++; else imgReasons.push(r.reason);
        await U.sleep(800);
      }
      return {
        ok: true, sent: true, images,
        imageTotal: (payload.images || []).length,
        imageReasons: imgReasons,
      };
    },

    [MSG.SCRAPE_FILTERS]: async () => {
      const scraped = FilterDict.scrape();
      const [cities, positions] = await Promise.all([
        FilterDict.cities().catch(() => []),
        FilterDict.positions().catch(() => []),
      ]);
      return { ok: true, ...scraped, cities, positions };
    },

    [MSG.STOP_TASK]: async () => {
      Collector.abort();
      return { ok: true };
    },
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = HANDLERS[msg?.type];
    if (!handler) return false;

    handler(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));

    return true; // 保持消息通道开启以支持异步回复
  });

  chrome.runtime.sendMessage({
    type: MSG.CS_READY,
    payload: { url: location.href },
  }).catch(() => {});
})();
