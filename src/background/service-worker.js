// ════════════════════════════════════════════════════════════════
// 闪投 · Service Worker（编排中枢）
// ────────────────────────────────────────────────────────────────
// 注意：manifest 里刻意没写 "type": "module"，为的是能用 importScripts
// 加载与 content script 完全相同的那份 constants.js / utils.js。
// 若改成 module，常量就得在两边各抄一份，一处漏改消息就静默发不出去。
// ════════════════════════════════════════════════════════════════

importScripts(
  '../shared/constants.js',
  '../shared/utils.js',
  '../shared/secrets.js',
  '../shared/tracker.js',      // 埋点：本地储存 + 配了 ANALYTICS_ENDPOINT 后定时上报（见文件尾 alarm）
  '../db/repository.js',
  '../data/writing-rules.js',
  '../data/position-tree.js',
  '../llm/qwen.js',
);

// ── 运行时状态（内存态，随 SW 休眠丢失，关键字段同步落 storage）──
const state = {
  task: null,        // { taskId, phase, progress, startedAt, config }
  csTabId: null,     // 当前使用的 BOSS 标签页
  stopRequested: false,  // 用户点了停止/暂停。独立于 task.phase——因为发送循环里每投一个都会
                         // setPhase('sending')，会把 phase='aborted' 刷掉，靠这个标志才叫得停。
};

// ════════════════════════════════════════════════════════════
// 标签页与 content script
// ════════════════════════════════════════════════════════════

/**
 * 找到（或打开）一个可用的 BOSS 岗位页标签，并确认 content script 已就绪。
 *
 * 为什么必须借标签页：所有 BOSS 接口靠 cookie 鉴权，而 SW 的 fetch 不带
 * 页面 cookie。只有在页面上下文里发的同源请求才有登录态。
 */
async function ensureBossTab({ activate = false } = {}) {
  const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });

  // 优先复用岗位搜索页，嗅探器只在那里能捕到列表请求模板
  const preferred = tabs.find((t) => t.url && t.url.includes(BOSS.PAGE.JOBS)) || tabs[0];

  let tab = preferred;
  if (!tab) {
    tab = await chrome.tabs.create({
      url: `${BOSS.ORIGIN}${BOSS.PAGE.JOBS}`,
      active: activate,
    });
    await waitForTabComplete(tab.id);
  }

  state.csTabId = tab.id;

  let pong = await pingTab(tab.id);

  if (!pong.ok) {
    // content script 没就绪：页面可能在扩展安装或更新之前就开着，补注入一次
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'src/shared/constants.js',
          'src/shared/utils.js',
          'src/content/filter-dict.js',
          'src/content/collector.js',
          'src/content/content.js',
        ],
      });
      await U.sleep(300);
      pong = await pingTab(tab.id);
    } catch (e) {
      throw new Error(`content_script_inject_failed: ${e.message}`);
    }
  }

  // 嗅探器是 MAIN world + document_start，补注入救不了它：
  // executeScript 默认注入 ISOLATED world，而即便指定 MAIN world，页面此刻
  // 早已发完首屏列表请求，hook 上去也捕不到任何东西。唯一解法是重载页面，
  // 让嗅探器在请求发生之前就位。
  // 嗅探器抓不到模板不再是致命错误。
  // 采集器有三级降级（模板复放 → 自建请求 → DOM 采集），
  // 这里重载一次只是给嗅探器一个机会，抓不到也照样往下走。
  if (pong.ok && !pong.hasTemplate) {
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
    for (let i = 0; i < 12; i++) {
      await U.sleep(500);
      const p = await pingTab(tab.id);
      if (p.ok && p.hasTemplate) break;
    }
  }

  return tab.id;
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') finish();
    }
    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function pingTab(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    return r || { ok: false };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** 向 content script 发消息。失败会抛，调用方决定是否重试。
 *  timeoutMs 可选：传了就给响应加超时（抓 JD 这种一步一卡的操作必须传，
 *  否则对端挂起时 Promise 永远不返回、整批任务卡死且无任何报错）；
 *  不传则维持原行为（采集类长操作故意不限时）。 */
async function askTab(tabId, type, payload, timeoutMs) {
  const pending = chrome.tabs.sendMessage(tabId, { type, payload });
  const res = timeoutMs ? await U.withTimeout(pending, timeoutMs, 'ask_tab_timeout') : await pending;
  if (!res) throw new Error('no_response');
  if (res.ok === false) throw new Error(res.error || 'cs_error');
  return res;
}

// ── 全局行为闸（精投翻页 / 海投滚动共用）──
// 无论几个标签在跑，全局每 N 秒随机只放行一个「行为」。用「预约下一个时间槽」
// 保证并发的 worker 依次拿到往后排的槽（先到先得≈轮流派发），不会一起放行。
// 任意时刻只有一个请求在飞、均匀无突刺，这是躲限流(code:37)的关键。
// 间隔区间各模式自带（精投 4~6 秒；海投 2026-10-07 起 3~4 秒）；
// 槽链 nextTurnAt 全局一条，两模式不会同时跑。
let nextTurnAt = 0;
async function acquireTurnGlobal(minMs, maxMs) {
  const lo = minMs || CONFIG.TURN_GATE_MIN_MS || 4000;
  const hi = maxMs || CONFIG.TURN_GATE_MAX_MS || 6000;
  const now = Date.now();
  const at = Math.max(now, nextTurnAt);
  nextTurnAt = at + U.randInt(lo, hi);
  if (at > now) await U.sleep(at - now);
}

// ── 全局开页闸（精投 / 海投共用）──
// 模仿人类：人不会同一秒连开好几个分页。每开一个分页全局隔 1~2 秒随机，
// 同样用「预约下一个时间槽」保证并发调用拿到依次往后排的槽，轮流开、不突刺。
let nextOpenAt = 0;
async function acquireOpenSlot(minMs, maxMs) {
  const now = Date.now();
  const at = Math.max(now, nextOpenAt);
  nextOpenAt = at + U.randInt(minMs || CONFIG.TAB_OPEN_MIN_MS || 1000, maxMs || CONFIG.TAB_OPEN_MAX_MS || 2000);
  if (at > now) await U.sleep(at - now);
}

// ── 关分页（精投 / 海投共用手法）──
// 模仿人类：用完不秒关，隔 1~3 秒随机再关；异步不 await，下一步不用等它关完。
function closeTabLater(tabId) {
  if (!tabId) return;
  setTimeout(
    () => chrome.tabs.remove(tabId).catch(() => {}),
    U.randInt(CONFIG.TAB_CLOSE_MIN_MS || 1000, CONFIG.TAB_CLOSE_MAX_MS || 3000),
  );
}

/**
 * 在一个专属标签页里搜一个城市，采完就关。
 *
 * 对齐即投的做法：一城一页，多城并行。每个城市开自己的后台标签页，
 * 各搜各的互不干扰，最后合并去重。这样不用把一个标签页在多个城市之间
 * 来回导航，也不会因为串行等待把总耗时拉长。
 *
 * 每个新标签页里嗅探器和采集器会随页面加载自动就位（manifest 已注册），
 * 不用手动补注入。
 */
async function runHaitouScroll(config, merged, onProgress) {
  // 2026-10-07 用户定的最新链路：分页数 = 地点数 × 职位词数（一词一城一个分页，
  // 最多 5 个并行、其余的排队）；每个分页：BOSS 主页(?ka=header-home-logo) →
  // 驱动搜索栏搜职位词 → 顺着结果页筛选栏从左到右逐个点已选条件（不限/没选 = 跳过）→ 滚动读卡。
  // 中止条件（用户 2026-10-07 定）：3 分钟 / 150 个结果 / 60 个行为，任一先到即停——
  // 只改中止口径，冷却时间不受影响；
  // 60 个行为按「词×城」单元平分（沿用用户定的分配口径），每一次滚动 = 一个行为，
  // 过全局闸 acquireTurnGlobal（3~4 秒）；连续 3 次滚动 0 新增（滚到底）该单元提前收工。
  const posWords = (config.positions || []).filter(Boolean);
  const keywords = posWords.length ? posWords : [''];   // 没选词 → 空词按筛选条件浏览
  const cities = (config.cities && config.cities.length) ? config.cities : [''];
  const taskDeadline = (state.task.startedAt || Date.now()) + (CONFIG.HAITOU_STOP_MINUTES || 3) * 60000;
  const budget = CONFIG.HAITOU_MAX_ACTIONS || 60;
  const maxResults = CONFIG.HAITOU_MAX_RESULTS || 150;
  const cityNames = config.cityNames || [];
  const units = [];   // 一词一城一个单元 = 一个分页（用户 2026-10-07 定）
  cities.forEach((code, i) => { const name = cityNames[i] || ''; for (const kw of keywords) units.push({ code, name, kw }); });
  const perUnit = Math.max(3, Math.floor(budget / Math.max(1, units.length)));
  let actionsDone = 0;
  const perCity = {};
  const doneUnits = [];   // 恢复搜索（需求 #11）：完整跑完的单元 "cityCode|kw"，手动停止时落进断点
  const stop = () => state.stopRequested || state.task.phase === 'aborted' || Date.now() >= taskDeadline
    || actionsDone >= budget || merged.size >= maxResults;
  // 布置闸：海投布置阶段每个动作 1~2 秒随机一个（用户 2026-10-07 由 2~3 改 1~2，HAITOU_LAYOUT_*）。
  // 与开页闸共用同一条「预约时间槽」，几个城分页的布置动作自然排队轮流来。
  const layoutSlot = () => acquireOpenSlot(CONFIG.HAITOU_LAYOUT_MIN_MS || 1000, CONFIG.HAITOU_LAYOUT_MAX_MS || 2000);
  const report = (cityCode, kw) => onProgress && onProgress({
    city: cityCode, keyword: kw, collected: merged.size, actionsDone, actionsBudget: budget,
  });

  // ── 布置地点：在搜索后的结果页上点城市选择器（筛选栏最左的城市 chip）──
  // 城市由页面按 IP/cookie 定，所以要像人一样点选择器；
  // 点完读 chip 文本校验；点不动退兜底：写 lastCity cookie + 带参重载一次。
  // 单数 /web/geek/job 才是吃 URL 参数的搜索结果页（筛选锚点的 href 也指向它）。
  const searchPageUrl = (filters) => {
    const u = new URL(buildSearchUrl(filters));
    u.pathname = '/web/geek/job';
    return u.toString();
  };
  const readCity = (tid) => askTab(tid, MSG.READ_CITY_CHIP).catch(() => ({ ok: false, text: '' }));
  const cityOk = (r, name) => !!(r && r.ok && (!name || r.text === name));
  const ensureCity = async (tid, code, name) => {
    if (!code) return true;                        // 没选城市（全国）不用布置
    if (cityOk(await readCity(tid), name)) return true;
    await layoutSlot();                            // 点城市选择器 = 一个布置行为，排队
    await chrome.tabs.update(tid, { active: true }).catch(() => {});
    const r = await askTab(tid, MSG.APPLY_CITY, { code, name }).catch(() => ({ ok: false }));
    if (r.ok && r.clicked) {
      await waitForTabComplete(tid).catch(() => {});
      await U.sleep(U.randInt(500, 1000));         // 等页面换城市重渲染，像人扫一眼
    }
    if (cityOk(await readCity(tid), name)) return true;
    // 兜底：lastCity cookie + 带 city 参数重载。注意 cookie 是全域共享的，多城分页并行时
    // 可能被别的城分页写覆盖，所以这只是兜底，主路径仍是页面级点击。
    try { await chrome.cookies.set({ url: BOSS.ORIGIN + '/', name: 'lastCity', value: String(code), path: '/' }); } catch (e) { /* 无权限/失败则只靠 URL */ }
    const t = await chrome.tabs.get(tid).catch(() => null);
    if (t && t.url) {
      const u = new URL(t.url);
      u.searchParams.set('city', code);
      await chrome.tabs.update(tid, { url: u.toString() }).catch(() => {});
      await waitForTabComplete(tid).catch(() => {});
      await U.sleep(U.randInt(500, 1000));
    }
    const chk = await readCity(tid);
    if (!cityOk(chk, name) && onProgress) onProgress({
      city: code, keyword: '', collected: merged.size, actionsDone, actionsBudget: budget,
      warn: `地点布置未生效：页面显示「${chk.text || '?'}」，应为「${name || code}」`,
    });
    return cityOk(chk, name);
  };

  await runInBatches(units, CONFIG.HAITOU_MAX_TABS || 5, async ({ code: cityCode, name: cityName, kw }) => {
    const unitKey = `${cityCode}|${kw}`;
    if (config._skipUnits && config._skipUnits.has(unitKey)) return;   // 恢复搜索：已完成单元跳过
    if (stop()) return;
    // 筛选条件分流：顺着结果页筛选栏从左到右的次序点（用户 2026-10-07 定），不限/没选 = 跳过。
    // 行业是主选+副选结构，副选 BOSS 限 3 个（用户 2026-10-07 告知）→ 最多点 3 个，超出如实上报；
    // 其余维度同维度多选点不出来（下拉单选）→ 留在 URL 最后统一补。
    const f = config.filters || {};
    const CLICK_ORDER = ['businessDistrict', 'position', 'jobType', 'salary', 'experience', 'degree', 'industry', 'scale', 'stage'];
    const clickList = [];
    const clickedFilters = {};
    const urlFilters = {};
    for (const k of CLICK_ORDER) {
      const arr = Array.isArray(f[k]) ? f[k].filter(Boolean) : (f[k] ? [f[k]] : []);
      if (!arr.length) continue;                       // 不限/没选 → 跳过
      if (k === 'industry') {
        const subs = arr.map(String).slice(0, 3);
        if (arr.length > 3 && onProgress) onProgress({
          city: cityCode, keyword: kw, collected: merged.size, actionsDone, actionsBudget: budget,
          warn: `公司行业副选最多 3 个，已按前 3 个布置（面板共选 ${arr.length} 个）`,
        });
        for (const code of subs) clickList.push({ key: k, code });
        clickedFilters[k] = subs.join(',');
      } else if (k === 'businessDistrict') {
        // 工作区域可多选（2026-10-07 用户定）：逐个去点，不限个数。
        // 值可能是真实 code 也可能是区名（没抓到 code 时），collector 两种都能匹配。
        for (const v of arr) clickList.push({ key: k, code: String(v) });
        const codes = arr.map(String).filter((v) => /^\d+$/.test(v));
        if (codes.length) clickedFilters[k] = codes.join(',');   // URL 兜底只带真 code，区名塞 URL 没意义
      } else if (arr.length === 1) {
        clickList.push({ key: k, code: String(arr[0]) });
        clickedFilters[k] = String(arr[0]);
      } else {
        urlFilters[k] = arr;   // 同维度多选 → URL 兜底
      }
    }
    // ① 开分页到 BOSS 主页（用户 2026-10-07 定的初始环境）。开分页先过布置闸：
    //    几个单元分页每隔 1~2 秒随机轮流开，不一窝蜂齐开（模仿人类）。
    await layoutSlot();
    if (stop()) return;
    const tab = await chrome.tabs.create({ url: BOSS.ORIGIN + '/?ka=header-home-logo', active: true });
    const tabId = tab.id;
    try {
      await waitForTabComplete(tabId);
      let readyOk = false;
      for (let i = 0; i < 20; i++) { await U.sleep(500); if ((await pingTab(tabId)).ok) { readyOk = true; break; } }
      if (!readyOk) return;
      await U.sleep(U.randInt(500, 1000));   // 页面加载完人也要看一眼再动手（停留 0.5~1 秒，用户 2026-10-07 定）

      // ② 驱动主页搜索栏搜职位词（用户 2026-10-07 定：主页起步 → 搜索栏搜职位）。
      await layoutSlot();   // 驱动搜索栏（填词+点搜索）= 一个布置行为，排队
      if (stop()) return;
      await chrome.tabs.update(tabId, { active: true });
      const drive = kw
        ? await askTab(tabId, MSG.DRIVE_HOME_SEARCH, { keyword: kw }).catch(() => ({ ok: false }))
        : { ok: false };
      if (drive.ok) {
        await waitForTabComplete(tabId).catch(() => {});
        await U.sleep(U.randInt(500, 1000));
      } else if (kw) {
        // 搜索栏驱动失败 → 搜索页 URL 兜底（词+城市+全部条件一次带上，后面的点选会自动跳过已生效项）
        await layoutSlot();   // 兜底导航 = 一个布置行为，排队
        await chrome.tabs.update(tabId, { url: searchPageUrl({ query: kw, city: cityCode, ...urlFilters, ...clickedFilters }), active: true });
        await waitForTabComplete(tabId).catch(() => {});
        await U.sleep(U.randInt(500, 1000));
      }

      // ③ 顺着筛选栏从左到右布置：先地点（点城市选择器），再逐个点击已选条件。
      await ensureCity(tabId, cityCode, cityName);
      // ③ 顺着筛选栏从左到右逐个点已选条件（APPLY_FILTER，按 href 的 参数名=code 匹配锚点；
      //    选项藏在下拉里时 collector 会先点开该维度再找）。已选中跳过；
      //    找不到选项 → 退回 URL 导航补上（同维度追加不覆盖），条件不丢。
      for (const c of clickList) {
        if (stop()) break;
        await layoutSlot();   // 每点一个筛选项 = 一个布置行为，排队
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        const r = await askTab(tabId, MSG.APPLY_FILTER, c).catch(() => ({ ok: false }));
        if (r.ok && !r.skipped) {
          await waitForTabComplete(tabId).catch(() => {});
          await U.sleep(U.randInt(500, 1000));   // 点完等渲染，像人扫一眼新列表
        } else if (!r.ok) {
          if (!/^\d+$/.test(String(c.code))) {
            // 区名没有真实 code，点不出来也 URL 补不了，如实上报（条件可能未生效）
            if (onProgress) onProgress({
              city: cityCode, keyword: kw, collected: merged.size, actionsDone, actionsBudget: budget,
              warn: `工作区域「${c.code}」没在页面上点出来（无真实编码可 URL 补），该条件可能未生效`,
            });
          } else {
            const t = await chrome.tabs.get(tabId).catch(() => null);
            if (t && t.url) {
              const u = new URL(t.url);
              const cur = u.searchParams.get(c.key);
              u.searchParams.set(c.key, cur ? `${cur},${c.code}` : c.code);   // 行业副选有多个，追加不覆盖
              await chrome.tabs.update(tabId, { url: u.toString() }).catch(() => {});
              await waitForTabComplete(tabId).catch(() => {});
              await U.sleep(U.randInt(500, 1000));
            }
          }
        }
      }
      // 多选等点不了的条件最后统一用 URL 补一次（条件不丢）
      if (Object.keys(urlFilters).length) {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (t && t.url) {
          const u = new URL(t.url);
          let miss = false;
          for (const [k, v] of Object.entries(urlFilters)) {
            const want = v.join(',');
            if (u.searchParams.get(k) !== want) { u.searchParams.set(k, want); miss = true; }
          }
          if (miss) {
            await layoutSlot();   // 补条件导航 = 一个布置行为，排队
            await chrome.tabs.update(tabId, { url: u.toString() }).catch(() => {});
            await waitForTabComplete(tabId).catch(() => {});
            await U.sleep(U.randInt(500, 1000));
          }
        }
      }
      // 工作区域多选校验（2026-10-07 用户定区域可多选）：逐个点可能互相冲掉，
      // 有真 code 的区点完后看 URL 里还在不在，缺了用 URL 一次性补齐
      // （区名没 code 的补不了，只能靠上面点选尽力）。
      {
        const want = (clickedFilters.businessDistrict || '').split(',').filter(Boolean);
        if (want.length > 1) {
          const t = await chrome.tabs.get(tabId).catch(() => null);
          if (t && t.url) {
            const u = new URL(t.url);
            const cur = (u.searchParams.get('businessDistrict') || '').split(',').filter(Boolean);
            const missing = want.filter((c) => !cur.includes(c));
            if (missing.length) {
              await layoutSlot();   // 补区域导航 = 一个布置行为，排队
              u.searchParams.set('businessDistrict', cur.concat(missing).join(','));
              await chrome.tabs.update(tabId, { url: u.toString() }).catch(() => {});
              await waitForTabComplete(tabId).catch(() => {});
              await U.sleep(U.randInt(500, 1000));
            }
          }
        }
      }
      // 布置完校验地点还在（点选/兜底导航可能冲掉城市），丢了补一次全条件搜索页导航
      if (cityCode && !cityOk(await readCity(tabId), cityName)) {
        await layoutSlot();   // 纠偏导航 = 一个布置行为，排队
        await chrome.tabs.update(tabId, { url: searchPageUrl({ query: kw, city: cityCode, ...urlFilters, ...clickedFilters }), active: true });
        await waitForTabComplete(tabId).catch(() => {});
        await U.sleep(U.randInt(500, 1000));
      }
      await U.sleep(U.randInt(500, 1000));   // 等首屏渲染 + 嗅探器捕模板（随机，不写死）
      await askTab(tabId, MSG.SCROLL_RESET).catch(() => {});

      // ④ 滚动读卡：一次滚动 = 一个行为。滚动懒加载只在前台标签触发（后台被
      //    Chrome 节流），所以每步先把标签激活——人一次也只能看一个标签。
      let noNew = 0;
      for (let s = 0; s < perUnit && !stop(); s++) {
        // 海投行为闸：每 3~4 秒随机放行一个滚动行为（用户 2026-10-07 由 4~5 改 3~4）
        await acquireTurnGlobal(CONFIG.HAITOU_TURN_GATE_MIN_MS || 3000, CONFIG.HAITOU_TURN_GATE_MAX_MS || 4000);
        if (stop()) break;
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        await U.sleep(U.randInt(500, 1000));   // 切到前台后略停再滚，像人目光落回页面（停留 0.5~1 秒）
        const r = await askTab(tabId, MSG.COLLECT_ONE_SCROLL).catch(() => ({ jobs: [], newCount: 0 }));
        actionsDone++;
        for (const j of r.jobs || []) {
          if (j.jobId && !merged.has(j.jobId)) {
            j._cityCode = cityCode;
            merged.set(j.jobId, j);
            perCity[cityCode] = (perCity[cityCode] || 0) + 1;
          }
        }
        noNew = (r.newCount || 0) === 0 ? noNew + 1 : 0;
        report(cityCode, kw || '按筛选条件');
        if (noNew >= 3) break;   // 连续 3 次 0 新增 = 滚到底了（2026-10-06 由 2 改为 3，用户定的口径）
      }
    } catch (e) {
      console.log('[闪投] 海投滚动采集异常:', String(e.message || e));
    } finally {
      closeTabLater(tabId);   // 模仿人类：用完隔 1~3 秒随机再关，不秒删
    }
    if (!stop()) doneUnits.push(unitKey);   // 没被停止/到闸 = 这个单元完整跑完，记进断点
  });
  return { actionsDone, perCity, doneUnits };
}

/**
 * 精投终极：对每家目标公司，从已搜到的岗位里认出它的 brandId，
 * 直接翻公司主页 /gongsi/{brandId}.html，把全部在招岗位拉回来并进 merged。
 *
 * brandId 怎么来：搜索结果里每个岗位都带 companyId(encryptBrandId)+companyName。
 * 对每家目标公司，取「companyName 命中该公司名/别名」的岗位里出现最多的那个
 * companyId 当它的 brandId。这样不用猜接口、也顺带避开了同名多主体里的小众主体。
 *
 * @returns {number} 新增岗位数
 */
/**
 * 公司名 → brandId。
 * 导航到「搜公司名」的搜索页，用带签名的 MAIN 世界复放抓第 1 页（裸 fetch 会被
 * code:19 拒），从返回岗位的 companyId(encryptBrandId) 里投票选出目标公司的 brandId。
 */
async function resolveBrandId(tabId, company, filters) {
  try {
    await chrome.tabs.update(tabId, { url: buildSearchUrl({ ...filters, query: company.name }), active: true });
    await waitForTabComplete(tabId);
    for (let i = 0; i < 16; i++) { await U.sleep(400); if ((await pingTab(tabId)).ok) break; }
    await U.sleep(1500);   // 等页面发首屏、嗅探器捕到模板

    // 只抓 1 页，走和正式采集同一套签名复放
    const res = await askTab(tabId, MSG.COLLECT_PAGES, { maxPages: 1 });
    const jobs = (res && res.jobs) || [];
    const keys = [company.name, ...(company.aliases || [])].map((s) => String(s).toLowerCase());
    const votes = new Map();
    for (const j of jobs) {
      const cn = (j.companyName || '').toLowerCase();
      if (j.companyId && keys.some((k) => k && (cn.includes(k) || k.includes(cn)))) {
        votes.set(j.companyId, (votes.get(j.companyId) || 0) + 1);
      }
    }
    if (votes.size) return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // 名字没匹配上但有结果：退而取出现最多的 companyId（搜公司名时首屏基本就是这家）
    const any = new Map();
    for (const j of jobs) if (j.companyId) any.set(j.companyId, (any.get(j.companyId) || 0) + 1);
    if (any.size) return [...any.entries()].sort((a, b) => b[1] - a[1])[0][0];
    console.log('[闪投] brandId 反查：第1页没拿到岗位', company.name);
    return null;
  } catch (e) {
    console.log('[闪投] brandId 反查失败', company.name, String(e.message || e));
    return null;
  }
}

async function augmentFromCompanyPages(merged, config, onProgress) {
  const companies = (config.companies || []);
  if (!companies.length) return 0;

  // 复现人类链路：进公司主页 → 在公司页的「职位搜索框」里逐个打岗位词 → 翻到底 → 并集。
  // 量优先：不注入职位类型类目、不注入城市、不设相关度闸门。公司精准由「在公司页里」
  // 天然保证；城市/去重等减法留到第二阶段。
  const posWords = (config.positions || []).filter(Boolean);
  const queries = posWords.length ? posWords : [''];   // 没填岗位词就拉这家公司全部岗

  const diag = [];
  const brandMiss = [];   // 没解析到 brandId 的公司名，实时+最终都报给用户
  const doneCompanies = [];   // 恢复搜索（需求 #11）：完整跑完的公司，手动停止时落进断点
  augmentFromCompanyPages._diag = diag;
  augmentFromCompanyPages._brandMiss = brandMiss;
  augmentFromCompanyPages._doneCompanies = doneCompanies;

  // 要开多少个分页：公司数，封顶 8。这个 P 同时是冷却公式里的 N（固定，不随收完变）。
  const P = Math.max(1, Math.min(CONFIG.PARALLEL_COMPANIES || 2, companies.length));

  // 开页闸：每开一个分页全局至少隔 1~2 秒随机，轮流开、不突刺。闸已提升为模块级
  // （acquireOpenSlot，海投开城标签也过同一条闸），这里只留个别名保持可读性。
  const openGate = acquireOpenSlot;

  // 进度：一个「公司×词」是一个单元，总数 = 本轮要跑的公司数 × 词数（恢复搜索时已完成公司不计入）
  const runCompanies = (config._skipCompanies && config._skipCompanies.size)
    ? companies.filter((c) => !config._skipCompanies.has(c.name))   // 恢复搜索：已完成公司跳过
    : companies;
  const unitTotal = runCompanies.length * queries.length;
  let unitDone = 0;
  let added = 0;

  // 每个分页「一条龙」：先搜公司名读自己的 brandId → 直接进公司页搜职位（都在 processCompany 里）。
  // 这里只预取「已搜到的岗位」里能投票出的 brandId（精投通常没有，为 null），其余各标签现搜。
  // 搜索时长：设置里拉杆的分钟数（3~30），决定时间上限 + 行为预算（每分钟≈12个行为）
  const mins = Math.min(30, Math.max(3, config.searchMinutes || 5));
  const taskTimeoutMs = mins * 60000;
  const taskDeadline = (state.task.startedAt || Date.now()) + taskTimeoutMs;
  const jobs = [...merged.values()];
  const sOver = config.searchOverrides || {};   // 用户手动改的「搜寻名」（公司名→中文搜寻名）
  const bOver = config.brandOverrides || {};     // 用户贴的公司主页网址抽出的 brandId（公司名→brandId）
  const targets = runCompanies.map((c) => {
    const keys = [c.name, ...(c.aliases || [])].map((s) => String(s).toLowerCase());
    const votes = new Map();
    for (const j of jobs) {
      const cn = (j.companyName || '').toLowerCase();
      if (j.companyId && keys.some((k) => k && cn.includes(k))) votes.set(j.companyId, (votes.get(j.companyId) || 0) + 1);
    }
    const voted = votes.size ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
    // brandId 覆盖（用户贴网址）最优先，直接用、跳过定位；否则靠搜寻名去搜
    return { company: c.name, searchName: sOver[c.name] || c.search || c.name, aliases: c.aliases || [], brandId: bOver[c.name] || voted };
  });

  // ── 采集：全同步并行，每标签一条龙 ──
  // 选中的公司（最多 PARALLEL_COMPANIES 家）全部同时开跑，各翻各的。每家翻一页后独立随机睡
  // [4+N, (4+N)×2] 秒（N=当前还在跑的家数）：并行越多间隔越宽、总速率自己踩刹车；有家收完
  // N 变小、剩下的自动提速。满 TASK_HARD_TIMEOUT_MS（5 分钟，从任务开始算）就停、把已收的展示。
  const timeUp = () => Date.now() >= taskDeadline;   // 5 分钟硬封顶（含解析阶段，见上）
  const pagesCap = () => U.randInt(CONFIG.COMPANY_PAGES_MIN || 10, CONFIG.COMPANY_PAGES_MAX || 15);
  // 每家公司召回封顶：单批只投 SOFT_BATCH_LIMIT 个，一家收到它的 RECALL_CAP_MULTIPLIER 倍
  // (默认 2×≈150)就够精筛挑了，到量就停这家、不再往下翻，省时间。
  const perCompanyCap = (CONFIG.SOFT_BATCH_LIMIT || 75) * (CONFIG.RECALL_CAP_MULTIPLIER || 2);

  // 把一页卡入库：全局 merged 去重 + slot 自己的 seen；返回这页给「这家」新增了几个
  const absorb = (slot, res) => {
    let nSlot = 0;
    for (const j of res.jobs || []) {
      if (!j.companyName) j.companyName = slot.company;
      if (!j.jobId) continue;
      if (!slot.seen.has(j.jobId)) { slot.seen.add(j.jobId); nSlot++; }
      if (slot.companySeen) slot.companySeen.add(j.jobId);   // 这家公司累计收到的（跨岗位词，用于封顶）
      if (!merged.has(j.jobId)) { j._fromCompanyPage = true; merged.set(j.jobId, j); added++; }
    }
    return nSlot;
  };
  // 翻到底 / 到页数上限 / 这页没新增 / 这家已收够封顶量 —— 任一满足就停翻这个词
  const kwExhausted = (slot) => !slot.lastHasNext || slot.page >= slot.maxPages || slot.lastNew === 0
    || (slot.companySeen && slot.companySeen.size >= perCompanyCap);
  // 关标签：不秒删，隔 1~3 秒随机再删；而且是后台异步的（不 await），下一家不用等删完就能开始。
  // 手法与海投共用 closeTabLater。
  const closeSlot = (slot) => {
    if (!slot || !slot.tabId) return;
    closeTabLater(slot.tabId);
  };
  // 每家公司的实时状态：locating 定位中 / searching 搜职位中 / done 已完成 / miss 没定位到。
  const statuses = {};
  const stats = {};   // 每家：{ ms 用时, count 收到数, pages 翻页数 }，完成时用来标异常
  const live = {};    // 每家实时翻页数（工作步数），搜索中逐页更新给面板看
  augmentFromCompanyPages._statuses = statuses;
  augmentFromCompanyPages._stats = stats;
  const report = (slot, kw) => { if (onProgress) onProgress({ company: slot.company, keyword: kw, unitDone, unitTotal, collected: merged.size, domPage: slot.page, domMaxPages: slot.maxPages, misses: brandMiss.slice(), statuses: { ...statuses }, live: { ...live }, actionsDone, actionsBudget }); };

  // 全局行为闸（轮流派发）：无论几家在采，全局每 4~6 秒随机才放行一个「翻页行为」。
  // 5 分钟≈300秒÷5秒均值≈60 个行为，总量有硬顶、均匀无突刺。闸本身是模块级共享的
  // （acquireTurnGlobal，海投 v2 的滚动行为也过同一条闸），这里只负责本模式的计数。
  let activeCount = 0;   // 仅用于显示/参考
  let actionsDone = 0;   // 已执行的行为数（翻页数），进度% = actionsDone / actionsBudget
  let actionsBudget = Math.max(1, Math.round(taskTimeoutMs / (60000 / (CONFIG.ACTIONS_PER_MINUTE || 12))));   // 浅搜≈60 / 深搜≈120（重做会 +10）
  const turnGate = async () => { await acquireTurnGlobal(); actionsDone++; };
  const stop = () => state.stopRequested || state.task.phase === 'aborted' || timeUp();

  const ready = async (tabId) => {   // 等页面加载 + content script 就绪
    await waitForTabComplete(tabId);
    for (let i = 0; i < 20; i++) { await U.sleep(400); if ((await pingTab(tabId)).ok) break; }
    await U.sleep(1000);
  };

  // 单次完整跑一家：定位 brandId → 进公司页 → 逐词搜职位。返回 {located, pages}。
  const onePass = async (t) => {
    const slot = { company: t.company, brandId: t.brandId, tabId: null, kwi: 0, page: 0, seen: new Set(), companySeen: new Set(), maxPages: pagesCap(), lastHasNext: false, lastNew: 0 };
    let pagesTotal = 0, located = false;
    activeCount++;
    try {
      await openGate();
      if (stop()) return { located: false, pages: 0 };
      let brandId = t.brandId;
      if (!brandId) {
        statuses[t.company] = 'locating';
        if (onProgress) onProgress({ company: t.company, keyword: '正在定位公司', unitDone, unitTotal, collected: merged.size, statuses: { ...statuses } });
        const cands = [...new Set([t.searchName || t.company, t.company, ...(t.aliases || [])].filter(Boolean))].slice(0, 5);
        for (let ci = 0; ci < cands.length && !brandId && !stop(); ci++) {
          // 定位只搜公司名、不带职位/城市筛选：否则小公司加了职位筛选后搜不出几条，
          // 页面被「推荐其他公司」占满，/gongsi/ 投票会投到别家 → 定位到错公司。
          const url = buildSearchUrl({ query: cands[ci] });
          // ★ 定位这步必须用【前台】标签页：BOSS 的职位列表是 SPA，后台标签页被 Chrome
          // 渲染节流，列表常在我们读取时还没渲染出来 → 读到 0 张卡 → 定位失败（腾讯就栽在这）。
          // 前台加载完整、渲染及时，和海投路径/resolveBrandId 的做法一致。定位完会切回后台开公司页。
          if (!slot.tabId) { const tab = await chrome.tabs.create({ url, active: true }); slot.tabId = tab.id; }
          else { await chrome.tabs.update(slot.tabId, { url, active: true }); }
          await ready(slot.tabId);
          const names = [t.company, t.searchName, ...(t.aliases || [])].filter(Boolean);   // 按公司名匹配，排除推荐的别家
          // 轮询读取：SPA 渲染有快有慢，最多等 ~6.4 秒（8 次 ×0.8s），一拿到 brandId 立刻停。
          for (let k = 0; k < 8 && !brandId; k++) {
            const r = await askTab(slot.tabId, MSG.READ_BRAND_DOM, { names }).catch(() => null);
            brandId = r && r.brandId;
            if (!brandId) await U.sleep(800);
          }
        }
        if (!brandId) return { located: false, pages: 0 };
        slot.brandId = brandId;
        // 读到 brandId 后关搜索标签、开【全新】公司页标签（SPA 同标签导航会半加载，只收 1 页）
        closeSlot(slot);
        const tab = await chrome.tabs.create({ url: BOSS.PAGE.COMPANY_JOBS(brandId), active: false });
        slot.tabId = tab.id;
      } else {
        const tab = await chrome.tabs.create({ url: BOSS.PAGE.COMPANY_JOBS(brandId), active: false });
        slot.tabId = tab.id;
      }
      located = true;
      statuses[t.company] = 'searching';
      if (onProgress) onProgress({ company: t.company, keyword: '正在打开公司页', unitDone, unitTotal, collected: merged.size, statuses: { ...statuses } });
      await ready(slot.tabId);

      for (slot.kwi = 0; slot.kwi < queries.length; slot.kwi++) {
        if (stop()) break;
        if (slot.companySeen.size >= perCompanyCap) break;   // 这家已收够，剩下的岗位词不用再搜
        const q = queries[slot.kwi] || '';
        slot.page = 0; slot.seen = new Set(); slot.maxPages = pagesCap();
        if (q) { await askTab(slot.tabId, MSG.COMPANY_BOX_SEARCH, { keyword: q }).catch(() => {}); await U.sleep(800); }
        await turnGate(); if (stop()) break;   // 读第 1 页也算一个行为，过全局闸
        let res = await askTab(slot.tabId, MSG.COMPANY_DOM_PAGE, { turnFirst: false }).catch(() => ({ jobs: [], hasNext: false }));
        slot.lastNew = absorb(slot, res); slot.page = 1; slot.lastHasNext = !!res.hasNext;
        live[t.company] = pagesTotal + slot.page; report(slot, q);
        while (!kwExhausted(slot) && !stop()) {
          await turnGate();   // 翻一页 = 一个行为，全局每 4~6 秒才放行一个
          if (stop()) break;
          res = await askTab(slot.tabId, MSG.COMPANY_DOM_PAGE, { turnFirst: true }).catch(() => ({ jobs: [], hasNext: false, turned: false }));
          slot.page++;
          slot.lastNew = absorb(slot, res);
          slot.lastHasNext = res.turned === false ? false : !!res.hasNext;
          live[t.company] = pagesTotal + slot.page; report(slot, q);
        }
        pagesTotal += slot.page;
        diag.push({ company: slot.company, keyword: q || '全部', got: slot.seen.size, source: 'dom-parallel' });
      }
      return { located, pages: pagesTotal };
    } catch (e) {
      diag.push({ company: t.company, step: '采集异常:' + String(e.message || e).slice(0, 24) });
      return { located, pages: pagesTotal };
    } finally {
      closeSlot(slot);
      activeCount = Math.max(0, activeCount - 1);
    }
  };

  // 一家公司：跑一次；若这一轮用的行为数 ≤ 4（太快，多半只收到 1 页/定位错）就重做，
  // 并把全局行为预算 +10 给重做腾空间，每家最多重做 3 遍。
  const processCompany = async (t) => {
    if (stop()) return;
    statuses[t.company] = 'locating';
    const tStart = Date.now();
    let located = false, pages = 0, redos = 0;
    while (!stop()) {
      const before = actionsDone;
      const r = await onePass(t);
      const passActions = actionsDone - before;
      located = located || r.located;
      pages = Math.max(pages, r.pages);
      if (passActions <= 4 && redos < 3 && !stop()) {   // 4 个行为内就完成 → 重做
        redos++;
        actionsBudget += 10;   // 剩余行为数 +10，给重做腾空间
        continue;
      }
      break;
    }
    if (located) { statuses[t.company] = 'done'; }
    else { statuses[t.company] = 'miss'; if (!brandMiss.includes(t.company)) brandMiss.push(t.company); console.log('[闪投] 没定位到', t.company); diag.push({ company: t.company, step: '没定位到' }); }
    unitDone += Math.max(1, queries.length);
    // 没被停止/到闸且定位成功 = 这家完整跑完，记进断点；没定位到（miss）的不记，
    // 恢复搜索时给它再定位一次的机会（可能是网络波动）。
    if (!stop() && located) doneCompanies.push(t.company);
    const count = [...merged.values()].filter((j) => j.companyName === t.company).length;
    stats[t.company] = { ms: Date.now() - tStart, count, pages };
    if (onProgress) onProgress({ company: t.company, keyword: '', unitDone, unitTotal, collected: merged.size, misses: brandMiss.slice(), statuses: { ...statuses }, stats: { ...stats }, actionsDone, actionsBudget });
  };

  // 并行池：最多 P 个分页同时一条龙，一个收完就从队列拉下一家顶上
  const queue = targets.slice();
  const worker = async () => { while (queue.length && !stop()) { const t = queue.shift(); if (t) await processCompany(t); } };
  await Promise.all(Array.from({ length: P }, () => worker()));
  return added;
}

/** 把任务切成并发批次跑，每批不超过 limit 个 */
async function runInBatches(items, limit, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const results = await Promise.all(batch.map((it, k) => worker(it, i + k)));
    out.push(...results);
  }
  return out;
}

// ════════════════════════════════════════════════════════════
// 任务编排
// ════════════════════════════════════════════════════════════

function newTaskId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `task_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function broadcast(type, payload) {
  // panel 可能没开着，发不出去是正常的
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

function setPhase(phase, extra = {}) {
  if (!state.task) return;
  state.task.phase = phase;
  Object.assign(state.task, extra);
  broadcast(MSG.TASK_PROGRESS, state.task);
  chrome.storage.local.set({ [STORE.SW.TASK]: state.task }).catch(() => {});
}

/**
 * 把面板上的筛选条件变成 BOSS 搜索页 URL 并导航过去。
 *
 * ★ 关键设计：我们拼的是「页面 URL」，不是「API 请求」。
 *   导航过去之后 BOSS 自己会按 URL 发出正确的列表请求，嗅探器捕获它当翻页
 *   模板。这样我们只需要知道 URL 参数名，不需要复现 API 请求体里那些拿不到
 *   的内部字段（securityId、场景标识等）。
 */
function buildSearchUrl(filters) {
  const u = new URL(BOSS.ORIGIN + BOSS.PAGE.JOBS);
  if (filters.query) u.searchParams.set('query', filters.query);
  if (filters.city) u.searchParams.set('city', filters.city);
  // position 是 BOSS 自己的「职位类型」筛选，就是搜索页上
  // 「全部(2120) 技术(1134) 产品(387)」那一排。
  // 交给平台在服务端筛，比我们拿岗位名做字符串匹配准得多。
  // 筛选项现在是多选，存成数组，拼 URL 时逗号连接（对齐即投）
  const val = (v) => Array.isArray(v) ? v.filter(Boolean).join(',') : v;
  if (filters.position) u.searchParams.set('position', val(filters.position));
  for (const key of ['experience', 'degree', 'salary', 'scale', 'stage', 'jobType', 'industry']) {
    const v = val(filters[key]);
    if (v) u.searchParams.set(key, v);
  }
  // 工作区域（2026-10-07 起可多选）：值里可能混着区名（没抓到真实 code），
  // URL 只带数字 code，区名靠布置时在页面上按文字点。
  const bd = val(filters.businessDistrict);
  if (bd) {
    const codes = String(bd).split(',').filter((v) => /^\d+$/.test(v));
    if (codes.length) u.searchParams.set('businessDistrict', codes.join(','));
  }
  return u.toString();
}

/**
 * 岗位名是否命中用户选的任一岗位（对齐即投的客户端过滤）。
 *
 * BOSS 的 query 是模糊全文检索，搜「AI产品经理」会把「AI算法工程师」
 * 「AI Agent研发工程师」都带回来，因为都含「AI」。所以搜完要按岗位名
 * 再筛一道。判定用「职能核心词」而不是整词精确匹配，因为真实岗位名
 * 是「资深用户产品经理（C端）」这种，精确匹配一个都留不下。
 *
 * 规则：把选中岗位归纳出它属于哪个职能族（产品/运营/设计…），
 * 岗位名命中该族的核心词、且不属于其他冲突工种，就留。
 */
/**
 * 岗位名是否命中用户选的任一岗位词。
 *
 * 只用「用户实际输入的岗位词」判断，不再依赖任何硬编码的职能族表——
 * 那套表不认识「训练师」这种词，会把用户明确搜的岗位误砍。
 *
 * 判定：把每个岗位词拆成 token（英文段、2 字以上中文段），取其中最长的
 * 那个当核心词；岗位名包含任一岗位词的核心词（不分大小写）就保留。
 *   「AI训练师」核心词=训练师 → 岗位名含「训练师」就留
 *   「AI产品经理」核心词=产品经理 → 含「产品经理」就留
 * 这样搜什么就留什么，不会张冠李戴。
 */
// 太泛的词，单独拿来匹配会命中一切，不作为判定 token（但仍可作为整词的一部分）
const GENERIC_TOKENS = new Set(['ai', 'aigc', 'agent', '智能', '数据', '高级', '资深', '初级', '专员', '经理', '工程师', '师', '端']);

/**
 * 把一个岗位词拆成「用来判命中的 token 列表」。
 *
 * 关键修复：一个关键词可能含多个概念（数据标注/AI训练师），过去只取一个最长词
 * 当核心，导致另一个概念的岗位全被误砍。现在按 / 、,，空格 把关键词拆成多个
 * 短语，每个短语再抽出有意义的 token（英文段 + 2 字以上中文段），全都作为
 * 命中依据：岗位名含其中任一个就算命中这个关键词。
 *   「数据标注/AI训练师」→ [数据标注, 训练师]（ai 太泛丢掉）
 *   「AI产品经理」→ [产品经理]
 *   「FDE」→ [fde]
 */
function tokensOfPosition(position) {
  const phrases = position.toLowerCase().split(/[\/、,，\s]+/).filter(Boolean);
  const tokens = new Set();
  for (const ph of phrases) {
    // 整个短语先加进去（如 fde、产品经理、数据标注）
    if (ph.length >= 2) tokens.add(ph);
    // 再抽出英文段和 2 字以上中文段
    const parts = ph.match(/[a-z0-9]{2,}|[一-龥]{2,}/g) || [];
    for (const p of parts) if (p.length >= 2) tokens.add(p);
  }
  // 去掉过泛的 token；若删完空了，说明这个词本身就很泛，退回保留全部
  const strong = [...tokens].filter((t) => !GENERIC_TOKENS.has(t));
  return strong.length ? strong : [...tokens];
}

// 职能家族根词：岗位名带了家族根词就算同一类职能，放宽匹配用。
// 「AI产品经理/产品专员/AI产品专家/AI策略产品/推荐策略产品」都带「产品」=产品族；
// 「销售主管」「异构计算工程师」不带「产品」→ 不同族，照砍。
const FAMILY_ROOTS = [
  '产品', '运营', '设计', '数据', '算法', '研发', '测试', '市场', '销售',
  '运维', '增长', '策划', '分析', '架构', '开发', '采购', '法务', '财务',
  '人力', '行政', '客服', '编辑', '翻译', '训练师', '标注',
];

/** 从岗位词里提取它所属的职能家族根词 */
function familyRootsOf(position) {
  const lp = String(position || '').toLowerCase();
  return FAMILY_ROOTS.filter((r) => lp.includes(r.toLowerCase()));
}

function matchesAnyPosition(jobName, positions) {
  const n = (jobName || '').toLowerCase();
  if (!n) return false;
  if (!positions.length) return true;
  for (const pos of positions) {
    // 1. 精确 token 命中（产品经理、训练师、fde…）
    const toks = tokensOfPosition(pos);
    if (toks.some((t) => n.includes(t))) return true;
    // 2. 家族根词命中：放宽到同一职能家族，避免误砍「AI产品专家」「AI策略产品」
    //    这种同族但名字不含完整岗位词的岗位。
    const roots = familyRootsOf(pos);
    if (roots.some((r) => n.includes(r.toLowerCase()))) return true;
  }
  return false;
}

/**
 * 导航到目标搜索页。
 * 等嗅探器捕模板，但等不到也返回 true 继续：采集器会自建请求。
 * 只有 content script 本身没就绪才算失败。
 */
async function navigateAndWait(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
  let csReady = false;
  for (let i = 0; i < 16; i++) {
    await U.sleep(500);
    const p = await pingTab(tabId);
    if (p.ok) {
      csReady = true;
      if (p.hasTemplate) return true;
    }
  }
  return csReady;
}

/**
 * 搜索一轮：按筛选条件导航 → 复放列表请求抓全 → 去重入库。
 *
 * 岗位词是乘性维度：每个词单独搜一轮再合并。城市同理。
 * 公司维度刻意不进这个乘积（技术方案 3.2），勾多少家公司都不增加请求量，
 * 公司过滤放在本地做。
 */
// ── 搜索断点（需求 #11：手动停止后「恢复搜索」）──
// 断点内容：条件快照 + 已完成单元（海投="cityCode|kw"，精投=公司名）+ 当时已收数量。
// 恢复 = 跳过已完成单元续跑，预算重新给一轮（用户 2026-10-07 拍的口径 1）。
async function saveSearchCheckpoint(cp) {
  await chrome.storage.local.set({ [STORE.SW.SEARCH_CHECKPOINT]: cp }).catch(() => {});
}
async function loadSearchCheckpoint() {
  const st = await chrome.storage.local.get(STORE.SW.SEARCH_CHECKPOINT).catch(() => ({}));
  return st[STORE.SW.SEARCH_CHECKPOINT] || null;
}
async function clearSearchCheckpoint() {
  await chrome.storage.local.remove(STORE.SW.SEARCH_CHECKPOINT).catch(() => {});
}

async function runRecall(config = {}) {
  // 允许 aborted：用户点「停止」后后台虽还在卸载，但应能立刻开新一轮，不卡「任务进行中」
  if (state.task && !['done', 'error', 'aborted'].includes(state.task.phase)) {
    throw new Error('task_already_running');
  }
  state.stopRequested = false;   // 新一轮搜索，清掉上次的停止标志

  state.task = {
    taskId: newTaskId(),
    phase: 'starting',
    startedAt: Date.now(),
    config,
    progress: { page: 0, collected: 0, newJobs: 0, dupJobs: 0 },
  };
  broadcast(MSG.TASK_PROGRESS, state.task);

  // 关键：召回和招呼语/投递一样是几分钟的长任务，精投进后台公司页那段（等页面
  // 加载 + 等就绪）有近 30 秒不发任何消息，MV3 的 Service Worker 空闲 ~30 秒
  // 就被回收，一旦回收，后台采集全死、进度永远停在最后一次广播（就是你看到的
  // 卡在 42%）。挂上心跳（alarms 每 30 秒顶一次回收计时器）才不会被饿死。
  // 之前只有 runGreeting / runSend 挂了，runRecall 被漏下，这里补齐。
  startKeepAlive();

  try {
    setPhase('opening_tab');
    setPhase('collecting');

    // ── 搜索方式：完全对齐即投 ──
    //
    // 1. query = 期望岗位词（多个用逗号连接），不是公司名。
    //    这就是 BOSS 网页搜索框里输入的内容，返回结果最干净。
    //    用户不选岗位时 query 为空，等于在 BOSS 上不填关键词按筛选器浏览。
    // 2. 一城一标签页，多城并行（最多 4 个），对齐即投「开四个窗口」。
    // 3. 不搜公司、不按公司过滤。公司维度这一版完全不参与搜索。
    //
    // 城市、薪资、学历、行业这些筛选器照常拼进 URL，那是用户自己选的。
    const posWords = (config.positions || []).filter(Boolean);
    const compNames = (config.companies || []).map((c) => c.name).filter(Boolean);
    const cities = (config.cities && config.cities.length) ? config.cities : [''];

    // ── 搜索模式 ──
    //   position（广撒网）：用岗位词搜，公司是搜完的可选软筛。
    //   company（锁定公司）：用公司名搜（公司名是很强的搜索信号，BOSS 会优先
    //     返回这家的岗位），搜完必按公司名筛，再按岗位词收窄（若填了）。
    // 搜索方式：position（广撒网）/ company（锁定公司）。海投 v2 不再区分
    // 「是否归类到职位类型 code」——筛选条件（含职位类型）照常拼进结果页 URL，
    // 职位词逐个由首页搜索框驱动搜索（每词每城各一轮，量 = 词×城×滚动采集）。
    const mode = config.searchMode === 'company' ? 'company' : 'position';

    // ── 多城并行：一城一标签页（对齐即投「开四个窗口」）──
    //
    // 关键教训：标签页必须 active:true（前台可见）。之前用 active:false 后台
    // 标签页并行，BOSS 的会话/签名在后台没初始化全，复放 joblist 被判 code_19。
    // 前台标签页会话是完整的，所以这里每个城市开一个前台标签页并行采集。
    const merged = new Map();
    const sources = new Set();
    const perCity = {};
    let lastStop = 'exhausted';

    // 精投不再全网搜公司名（那是全文检索，必带别家公司）。它走「公司→岗位→地点」：
    // 直接解析 brandId → 翻公司主页 → 职位类型+城市筛，全部在 augmentFromCompanyPages 里做。
    // 海投 v2 走真人链路：主页→搜索框→筛选→滚动读卡，在 runHaitouScroll 里做。
    let htResult = null;   // 海投结果（含 doneUnits，搜索断点用）；精投为 null
    if (mode === 'position') {
      htResult = await runHaitouScroll(config, merged, (p) => {
        setPhase('collecting', {
          progress: {
            ...state.task.progress,
            keyword: (p.city ? p.city + ' · ' : '') + (p.keyword || '按筛选条件'),
            collected: p.collected,
            actionsDone: p.actionsDone, actionsBudget: p.actionsBudget,
          },
        });
      });
      if (htResult && htResult.perCity) Object.assign(perCity, htResult.perCity);
      lastStop = 'scroll_done';
    }

    // ── 精投：公司主页直采（已修好模板污染）──
    let companyDiag = null;
    if (mode === 'company') {
      try {
        const n = await augmentFromCompanyPages(merged, config, (p) => {
          setPhase('collecting', {
            progress: {
              ...state.task.progress,
              keyword: `${p.company}·${p.keyword || '全部'}`, collected: merged.size,
              unitDone: p.unitDone, unitTotal: p.unitTotal, domPage: p.domPage || 0,   // 精投进度：已完成单元 + 当前单元页进度
              companyStatus: p.statuses || {}, brandMiss: p.misses || [], companyStats: p.stats || {}, companyLive: p.live || {},   // 每家状态 + 定位失败 + 用时/数量 + 实时页数
              actionsDone: p.actionsDone || 0, actionsBudget: p.actionsBudget || 0,   // 行为进度 x/50
            },
          });
        });
        console.log('[闪投] 公司主页直采 +', n, '个');
      } catch (e) {
        console.log('[闪投] 公司主页直采异常：', String(e.message || e));
      }
      companyDiag = augmentFromCompanyPages._diag || [];

      // 精投【绝不】退回全网搜。公司页没出结果就如实是 0，让失败暴露出来，
      // 而不是悄悄全网搜公司名、灌一堆别家公司再砍掉给用户看。
      if (merged.size === 0) {
        console.log('[闪投] 公司主页零结果（精投不走全网兜底）');
        lastStop = 'company_empty';
      }
    }

    const funnel = { raw: merged.size, lastStop, perCity };
    if (companyDiag) funnel.companyDiag = companyDiag;   // 精投每家公司的搜索诊断，显示到面板
    let jobs = [...merged.values()];

    // ── 城市过滤 ──
    // 海投照旧。精投：公司页返回全城市，按用户选的城市名本地筛一道；
    // 但若筛完变 0（城市选太窄），退回不筛、把全城市结果给用户，别让他空手（方案B）。
    const cityNames = (config.cityNames || []).filter((n) => n && n !== '全国');
    if (cityNames.length) {
      const matchCity = (j) => !j.city || cityNames.some((n) => j.city.includes(n) || n.includes(j.city));
      if (mode === 'company') {
        const kept = jobs.filter(matchCity);
        if (kept.length > 0) { funnel.cityCut = jobs.length - kept.length; jobs = kept; }
        else { funnel.cityCutSkipped = true; }   // 筛没了 → 不筛，全给
      } else {
        const before = jobs.length;
        jobs = jobs.filter(matchCity);
        funnel.cityCut = before - jobs.length;
      }
    }

    // ── 岗位名过滤（本地兜底）──
    // BOSS 的推荐填充会无视职位类型筛选硬塞非目标岗（大客户代表、机械工程师…），
    // 翻页闸门拦不干净的，这里再按「职能家族根词」兜一道。
    //
    // ★ 只在海投跑。精投的产品岗是公司主页接口按「职位类型」服务端筛出来的，
    //   已经保证是产品类目；这里再按「岗位名含产品二字」卡，会把「AI策略总监/
    //   用户研究/需求分析」这类名字不带产品的产品岗误杀。精投信任服务端类目。
    if (posWords.length && mode !== 'company') {
      const killed = [];
      jobs = jobs.filter((j) => {
        const keep = matchesAnyPosition(j.jobName, posWords);
        if (!keep) killed.push(j.jobName);
        return keep;
      });
      console.log('[闪投] 岗位名过滤砍掉', killed.length, '个：', killed.join(' | '));
      funnel.killedSample = killed.slice(0, 12);
    }
    funnel.afterPosition = jobs.length;

    // ── 目标公司过滤（本地做）──
    // ★ 精投跳过：岗位本来就来自目标公司的招聘职位页（/gongsi/job/{brandId}），
    //   源头已锁定这家公司，收到的全是对的。再用「公司名字符串匹配」二次判断，
    //   只会因 companyName 格式对不上（如「腾讯科技(深圳)」vs「腾讯」）把正确答案误砍成 0。
    //   精投信任来源，全收。公司过滤只在海投(勾了公司当软筛)时才跑。
    const compAliases = config.companyAliases || [];
    const compKeys = [...compNames, ...compAliases].map((s) => String(s).toLowerCase()).filter(Boolean);
    if (compKeys.length && mode !== 'company') {
      const before = jobs.length;
      const cutNames = [];   // 被砍的「岗位名（公司名）」，暴露给用户看
      jobs = jobs.filter((j) => {
        const cn = (j.companyName || '').toLowerCase();
        const keep = compKeys.some((k) => cn.includes(k));
        if (!keep) cutNames.push(`${j.jobName}（${j.companyName || '未知公司'}）`);
        return keep;
      });
      funnel.afterCompany = jobs.length;
      funnel.companyCut = before - jobs.length;
      funnel.companyCutSample = cutNames.slice(0, 12);
      console.log('[闪投] 目标公司过滤：', before, '→', jobs.length, '（只留', compNames.join('/'), '）砍掉:', cutNames.join(' | '));
    }

    const res = { jobs, pages: cities.length, stoppedBy: lastStop, funnel, perCity, sources: [...sources] };
    setPhase('deduping', {
      progress: { ...state.task.progress, page: res.pages, collected: jobs.length },
    });

    // ── 去重 L1 + L2（此刻还没有 JD，L3 留到精排后）──
    // ── 去重 ──
    //
    // 去重的唯一标准是【这个岗位我是不是已经跟对方聊过了】，
    // 不是【数据库里有没有这条记录】。这两件事差别极大：
    // 按后者写的话，搜第二轮时前一轮搜到的全被判成重复，
    // 表现就是「平台搜到 70 个，最后只剩 2 个」。
    //
    // 所以只排除两种：真的投出去了，或者投递时发现按钮是「继续沟通」
    // （说明早就聊过）。因为 HR 冷却、当天额度用完而跳过的，
    // 过阵子应该重新出现，不能永久拉黑。
    const fresh = [];
    const kept = [];
    let dupSent = 0;
    let dupFp = 0;
    const seenFpThisRun = new Set();

    const PERMANENT_SKIP = [SKIP_REASON.ALREADY_CHATTED];

    for (const j of jobs) {
      const prev = await Repo.getJob(j.jobId);

      const alreadySent = prev && prev.state === JOB_STATE.SENT;
      const alreadyChatted = prev && prev.state === JOB_STATE.SKIPPED
        && PERMANENT_SKIP.includes(prev.dispatch?.skipReason);

      if (alreadySent || alreadyChatted) { dupSent++; continue; }

      // 同一批内部也可能撞指纹（一个坑挂多个 HR），只留第一条
      if (seenFpThisRun.has(j.fingerprint)) { dupFp++; continue; }
      seenFpThisRun.add(j.fingerprint);

      j.taskId = state.task.taskId;
      if (prev) {
        // 之前搜到过但没投：沿用已有的 JD 和分数，省掉重复的拉取和调用
        j.jdText = prev.jdText || null;
        j.jdFetchedAt = prev.jdFetchedAt || null;
        j.greeting = prev.greeting || undefined;
        kept.push(j);
      } else {
        fresh.push(j);
      }
    }

    jobs = [...fresh, ...kept];
    funnel.afterDedup = jobs.length;
    funnel.dupSent = dupSent;
    funnel.dupFp = dupFp;
    await Repo.putJobs(jobs);

    // ── 搜索断点（需求 #11：手动停止后可「恢复搜索」，不用从头来）──
    // 用户手动停止（stopRequested）→ 条件快照 + 已完成单元落盘，恢复时跳过已完成单元、
    // 预算重新给一轮（2026-10-07 用户拍的口径 1）；正常跑完（含到闸自停）→ 清掉断点。
    if (state.stopRequested) {
      const newDone = mode === 'company'
        ? (augmentFromCompanyPages._doneCompanies || [])
        : ((htResult && htResult.doneUnits) || []);
      const cleanConfig = { ...config };
      delete cleanConfig._skipUnits; delete cleanConfig._skipCompanies; delete cleanConfig._doneSoFar;
      await saveSearchCheckpoint({
        savedAt: Date.now(), mode, config: cleanConfig,
        doneUnits: [...(config._doneSoFar || []), ...newDone],
        jobCount: jobs.length,
      });
      console.log('[闪投] 搜索断点已存：已完成单元', (config._doneSoFar || []).length, '+', newDone.length);
    } else {
      await clearSearchCheckpoint();
    }

    setPhase('done', {
      finishedAt: Date.now(),
      stoppedBy: res.stoppedBy,
      funnel: res.funnel,
      perCity: res.perCity,
      sources: res.sources,
      positionMode: res.positionMode,
      progress: {
        page: res.pages,
        collected: jobs.length,
        newJobs: fresh.length,
        dupJobs: dupSent + dupFp,
        // 完成后仍带上每家公司的最终状态 + 没定位到名单 + 用时/数量，否则清单会全显示「未搜到」
        companyStatus: augmentFromCompanyPages._statuses || (state.task.progress || {}).companyStatus || {},
        brandMiss: augmentFromCompanyPages._brandMiss || (state.task.progress || {}).brandMiss || [],
        companyStats: augmentFromCompanyPages._stats || (state.task.progress || {}).companyStats || {},
      },
    });

    await Repo.putTask({
      taskId: state.task.taskId,
      startedAt: state.task.startedAt,
      finishedAt: Date.now(),
      config,
      stoppedBy: res.stoppedBy,
      funnel: res.funnel,
      perCity: res.perCity,
      counts: { collected: jobs.length, fresh: fresh.length, dup: dupSent + dupFp },
    });

    return state.task;
  } catch (e) {
    setPhase('error', { error: String((e && e.message) || e) });
    throw e;
  } finally {
    stopKeepAlive();
  }
}

// ════════════════════════════════════════════════════════════
// 招呼语生成
// ════════════════════════════════════════════════════════════

/**
 * 长任务期间的保活。
 *
 * MV3 的 Service Worker 空闲约 30 秒就会被回收，而 sleep 等待不算活动。
 * chrome.alarms 触发属于扩展事件，能把回收计时器顶回去。
 * 注意 alarms 的最小周期是 30 秒，所以这里设 0.5 分钟。
 */
function startKeepAlive() {
  chrome.alarms.create('jt-keepalive', { periodInMinutes: 0.5 });
}
function stopKeepAlive() {
  chrome.alarms.clear('jt-keepalive');
}
chrome.alarms.onAlarm.addListener((alarm) => {
  // 埋点定时上报（用户 2026-10-07 定「想办法储存和传送」）：每 6 小时 + SW 启动时各试一次。
  // 未配置 CONFIG.ANALYTICS_ENDPOINT 时 Tracker.flush() 内部直接返回，本地数据照存不丢。
  if (alarm && alarm.name === 'analytics-flush' && typeof Tracker !== 'undefined') Tracker.flush();
  // 其余（jt-keepalive）：空处理器即可，触发本身就是活动
});
chrome.alarms.create('analytics-flush', { periodInMinutes: 360 });
if (typeof Tracker !== 'undefined') Tracker.flush();   // SW 启动即试一次（未配端点则空转）

async function runGreeting(jobIds, opts) {
  startKeepAlive();
  try {
    return await doGreeting(jobIds, opts);
  } finally {
    stopKeepAlive();
  }
}

async function doGreeting(jobIds, opts = {}) {
  state.stopRequested = false;   // 新一轮生成，清掉上次的停止标志
  const mode = opts.mode || 'ai';          // ai | custom
  const globalGreet = (opts.globalGreet || '').trim();
  const jobGreet = opts.jobGreet || {};

  const st = await chrome.storage.local.get(STORE.SW.RESUME_TEXT);
  const resumeText = st[STORE.SW.RESUME_TEXT] || '';
  // AI 模式才需要简历；自定义模式直接用现成文案，不必拦
  if (mode === 'ai' && !resumeText) throw new Error('还没有简历内容，先在上一步传简历截图');

  const jobs = [];
  for (const id of jobIds) {
    const j = await Repo.getJob(id);
    if (j) jobs.push(j);
  }

  state.task = state.task || { taskId: newTaskId(), progress: {} };
  let done = 0;
  let failed = 0;
  let lastError = '';
  let jdOk = 0;

  // 看门狗（用户 2026-10-07 定）：30 秒没有新招呼语产出就停止整批。
  // 已生成的每条都实时落库 + 广播进卡片，停了不丢；没生成的留着空格，可再点一次接着生成。
  let lastProgressAt = Date.now();
  let stalled = false;
  const stallTimer = setInterval(() => {
    if (Date.now() - lastProgressAt > (CONFIG.GREETING_STALL_MS || 30000)) {
      stalled = true;
      state.stopRequested = true;   // worker 在下一轮循环退出；被卡住的步骤有各自超时兜底，会陆续回来
    }
  }, 5000);

  const emit = (job) => {
    done++;
    lastProgressAt = Date.now();
    broadcast(MSG.GREETING_ITEM, { jobId: job.jobId, text: job.greeting.text, greeted: done, total: jobs.length });
    setPhase('greeting', { progress: { ...state.task.progress, greeted: done, greetTotal: jobs.length, current: job.jobName } });
  };

  // 1. 有现成文案的（单岗位自定义 / 自定义模式）先秒填，不读 JD 不调 AI
  const aiJobs = [];
  for (const job of jobs) {
    const perJob = (jobGreet[job.jobId] || '').trim();
    if (perJob || mode === 'custom') {
      job.greeting = {
        text: perJob || globalGreet || FALLBACK_GREETING,
        source: perJob ? 'job_custom' : 'global_custom',
        generatedAt: Date.now(),
      };
      job.state = JOB_STATE.GREETED;
      await Repo.putJob(job);
      emit(job);
    } else {
      aiJobs.push(job);
    }
  }

  // 2. AI 岗位用并发工作池：每个 worker 抓 JD（后台直接抓 HTML，快）+ 生成招呼语。
  //    之前是逐个「导航开页面→等加载→读 JD→生成」串行，81 个要好几分钟。
  //    改成后台抓 JD + 多个岗位同时生成，快数倍。JD 走详情页 HTML（不是被严格
  //    限流的 joblist 接口），并发抓风险低。
  const tabId = aiJobs.length ? await ensureBossTab() : null;
  const queue = [...aiJobs];
  const conc = Math.min(CONFIG.GREETING_CONCURRENCY || 5, Math.max(1, aiJobs.length));

  const worker = async () => {
    while (queue.length) {
      if (state.stopRequested || state.task.phase === 'aborted') return;
      const job = queue.shift();

      // 抓 JD（后台 HTML 抓取，不导航、不抢焦点；带超时——这段以前无超时，
      // 被风控挂起时所有 worker 一起卡死，面板永远停在 0/N）
      if (!job.jdText) {
        try {
          const r = await askTab(tabId, MSG.FETCH_JD, { jobId: job.jobId, securityId: job.securityId },
            CONFIG.JD_FETCH_TIMEOUT_MS || 20000);
          job.jdText = r.jdText || null;
          job.jdFetchedAt = job.jdText ? Date.now() : null;
          if (job.jdText) jdOk++;
        } catch (e) {
          lastError = String(e.message || e);
          // 被限流不整批停，这条没 JD 也照样生成（招呼语里就少引用 JD 细节）
        }
      }

      // 生成招呼语
      try {
        job.greeting = await LLM.writeGreeting({ resumeText, job, jdText: job.jdText, score: job.score });
        job.state = JOB_STATE.GREETED;
      } catch (e) {
        const msg = String(e.message || e);
        job.greeting = { text: FALLBACK_GREETING, source: 'fallback', error: msg, generatedAt: Date.now() };
        failed++;
        lastError = msg;
      }
      await Repo.putJob(job);
      emit(job);
    }
  };

  try {
    await Promise.all(Array.from({ length: conc }, worker));
  } finally {
    clearInterval(stallTimer);
  }

  setPhase('greeting_done', {
    greetStat: { total: jobs.length, failed, lastError, jdOk, jdTotal: aiJobs.length, stopped: stalled || undefined },
  });
  return { total: jobs.length, failed };
}

// ════════════════════════════════════════════════════════════
// 投递
// ════════════════════════════════════════════════════════════

/** 今天还能投几个。BOSS 不给查额度，只能自己记 */
async function quotaLeft() {
  const today = U.today();
  const q = (await Repo.getQuota(today)) || { date: today, sentCount: 0, captchaCount: 0 };
  return {
    quota: q,
    batch: Math.max(0, CONFIG.SOFT_BATCH_LIMIT - q.sentCount),
    daily: Math.max(0, CONFIG.DAILY_SEND_LIMIT - q.sentCount),
  };
}

/** 12 小时滚动窗口内的验证码次数，决定降速还是停投 */
async function riskLevel() {
  const st = await chrome.storage.local.get(STORE.SW.RISK_LOG);
  const log = (st[STORE.SW.RISK_LOG] || []).filter((t) => Date.now() - t < CONFIG.RISK_WINDOW_MS);
  await chrome.storage.local.set({ [STORE.SW.RISK_LOG]: log });
  if (log.length >= CONFIG.RISK_STOP_THRESHOLD) return { level: 'stop', count: log.length };
  if (log.length >= 1) return { level: 'slow', count: log.length };
  return { level: 'normal', count: 0 };
}

async function noteRisk() {
  const st = await chrome.storage.local.get(STORE.SW.RISK_LOG);
  const log = st[STORE.SW.RISK_LOG] || [];
  log.push(Date.now());
  await chrome.storage.local.set({ [STORE.SW.RISK_LOG]: log });
}

/**
 * 一键投递。
 *
 * 整个产品里唯一会真的动用户账号的地方，所以每一步都要能停下来：
 *   · 额度闸门：单批 75、单日 150，超了直接拒
 *   · 时段闸门：凌晨不投，批量操作特征太明显
 *   · 风控退避：12 小时内弹过一次验证码就降速，两次直接停整批
 *   · 逐岗串行：不做并行 worker，并行是风控最大的诱因
 *
 * 每一岗的流程：
 *   详情页 → 读按钮文案（「继续沟通」说明聊过了，跳过）→ 点沟通
 *   → 整页跳到聊天页 → 发招呼语 → 连发两张简历截图 → 落库
 */
async function runSend(jobIds) {
  startKeepAlive();
  try {
    return await doSend(jobIds);
  } finally {
    stopKeepAlive();
  }
}

// 分片睡眠：每 500ms 查一次停止标志，停了就提前返回 true（让调用方 break）。
// 用于投递间隔/批次休息这些长 sleep，保证点「停止」能秒停，不用等满 90 秒。
async function sleepUnlessStopped(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (state.stopRequested) return true;
    await U.sleep(Math.min(500, end - Date.now()));
  }
  return state.stopRequested;
}

async function doSend(jobIds) {
  const hour = new Date().getHours();
  if (CONFIG.FORBIDDEN_HOURS.includes(hour)) {
    throw new Error(`现在是 ${hour} 点，凌晨批量投递特征太明显，${CONFIG.FORBIDDEN_HOURS.slice(-1)[0] + 1} 点以后再投`);
  }

  const risk = await riskLevel();
  if (risk.level === 'stop') {
    throw new Error(`12 小时内已经触发 ${risk.count} 次验证码，先停一停，等冷却过了再投`);
  }

  // 发送顺序：已生成招呼语的排前面（稳定排序，其余保持传入的显示顺序），对齐「优先发已生成的」。
  // 传入顺序由面板按界面显示顺序给，所以整体＝显示顺序，但有招呼语的优先。
  {
    const withG = [], without = [];
    for (const id of jobIds) {
      const j = await Repo.getJob(id);
      if (j && j.greeting && j.greeting.text) withG.push(id); else without.push(id);
    }
    jobIds = [...withG, ...without];
  }

  const { batch, daily } = await quotaLeft();
  const allow = Math.min(batch, daily, jobIds.length);
  if (allow <= 0) throw new Error('今天的投递额度已经用完了');

  const tabId = await ensureBossTab();   // 后台投递，不抢焦点

  // 关掉 BOSS 自带招呼语，结束后恢复
  let originalSwitch = null;
  try {
    const cur = await askTab(tabId, MSG.GREETING_SWITCH);
    originalSwitch = cur.enabled;
    if (cur.enabled) await askTab(tabId, MSG.GREETING_SWITCH, { enabled: false });
  } catch (e) { /* 读不到就算了，最坏情况是 HR 多收一条平台模板语 */ }

  const stImg = await chrome.storage.local.get(STORE.SW.RESUME_IMAGES);
  const images = (stImg[STORE.SW.RESUME_IMAGES] || [])
    .slice(0, CONFIG.RESUME_IMAGES_PER_SEND).map((i) => i.dataUrl);

  const slowFactor = risk.level === 'slow' ? CONFIG.RISK_SLOW_MULTIPLIER : 1;
  const results = [];
  let sent = 0;

  state.stopRequested = false;   // 新一批开始，清掉上一次的停止标志
  state.task = { taskId: newTaskId(), phase: 'sending', startedAt: Date.now(), progress: {} };

  for (let i = 0; i < allow; i++) {
    if (state.stopRequested) break;   // 停止/暂停：立刻收手，不再投下一个

    const job = await Repo.getJob(jobIds[i]);
    if (!job) continue;

    const log = (status, reason) => {
      results.push({ jobId: job.jobId, jobName: job.jobName, company: job.companyName, status, reason });
      setPhase('sending', {
        progress: { ...state.task.progress, sent, total: allow, index: i + 1 },
        lastResult: results[results.length - 1],
      });
    };

    // HR 冷却：同公司同 HR 14 天内不重复打扰
    if (job.hrId) {
      const cooling = await Repo.hrInCooldown([job.hrId], 14 * 24 * 3600 * 1000);
      if (cooling.has(job.hrId)) {
        job.dispatch = { status: 'skipped', skipReason: SKIP_REASON.HR_COOLDOWN };
        job.state = JOB_STATE.SKIPPED;
        await Repo.putJob(job);
        log('skip', 'HR 最近联系过');
        continue;
      }
    }

    try {
      // 1. 开详情页——在同一个投递标签页里导航，不抢焦点、不弹到最前，
      //    你想看就切过去看，不想看它就在后台安静投，不打断你手头的活。
      await chrome.tabs.update(tabId, { url: BOSS.PAGE.JOB_DETAIL(job.jobId) });
      await waitForTabComplete(tabId);
      await U.sleep(U.randInt(3000, 6000));   // 模拟阅读间隔（也是防风控）

      // 2. 读按钮文案，聊过的直接跳过，不浪费额度
      const btn = await askTab(tabId, MSG.OPEN_DETAIL);
      if (!btn.found) { log('fail', '页面上没找到沟通按钮'); continue; }
      if (btn.alreadyChatted) {
        job.dispatch = { status: 'skipped', skipReason: SKIP_REASON.ALREADY_CHATTED };
        job.state = JOB_STATE.SKIPPED;
        await Repo.putJob(job);
        log('skip', '这个岗位之前聊过了');
        continue;
      }

      // 3. 点「立即沟通」，整页跳到聊天页（你会看到聊天窗口打开）
      const click = await askTab(tabId, MSG.CLICK_CHAT);
      if (!click.ok) { log('fail', click.reason); continue; }
      await waitForTabComplete(tabId);
      await U.sleep(2000);   // 让聊天页渲染出来

      if (state.stopRequested) break;   // 打开聊天页后、真正发出前再查一次，停了就别发

      // 4. 发招呼语 + 简历截图
      const text = job.greeting?.text || FALLBACK_GREETING;
      const r = await askTab(tabId, MSG.SEND_CHAT, { text, images });

      if (r.sent) {
        sent++;
        const imgTotal = r.imageTotal ?? images.length;
        job.dispatch = {
          status: 'sent', sentAt: Date.now(),
          imagesSent: r.images || 0, imageTotal: imgTotal,
          tier: job.score ? tierOf(job.score.total) : 'unscored',
          conversationId: r.conversationId || null,
        };
        job.state = JOB_STATE.SENT;
        await Repo.putJob(job);
        if (job.hrId) await Repo.touchHr(job.hrId, job.companyId);
        // 招呼语发出去了，但图片没发全，如实标注
        const imgNote = imgTotal && (r.images || 0) < imgTotal
          ? `招呼语已发，简历图 ${r.images || 0}/${imgTotal}` : '';
        log('ok', imgNote);
      } else {
        job.dispatch = { status: 'failed', failReason: r.reason };
        job.state = JOB_STATE.FAILED;
        await Repo.putJob(job);
        // 把失败原因翻译成人话
        const why = {
          input_not_found: '没找到聊天输入框', send_btn_not_found: '没找到发送按钮',
          send_btn_disabled: '发送按钮没激活', fill_failed: '文字没填进去',
          not_delivered: '点了发送但没确认到消息发出', greeting_empty: '招呼语是空的',
        }[r.reason] || r.reason;
        log('fail', why);
      }
    } catch (e) {
      const msg = String(e.message || e);
      // 验证码或软封锁：立刻记一笔并停整批，不硬顶
      if (/captcha|验证|37/.test(msg)) {
        await noteRisk();
        log('fail', '触发了平台验证，已停止');
        break;
      }
      log('fail', msg);
    }

    // 额度落库要实时，SW 随时可能被浏览器回收
    const today = U.today();
    const q = (await Repo.getQuota(today)) || { date: today, sentCount: 0, captchaCount: 0 };
    q.sentCount = sent;
    await Repo.putQuota(q);

    if (state.stopRequested) break;   // 投完这个若已请求停止，别再进休息/间隔

    // 每 50 个歇 90 秒（分片睡，便于中途停止立刻响应）
    if (sent > 0 && sent % CONFIG.BATCH_SIZE === 0) {
      setPhase('sending', { progress: { ...state.task.progress, resting: true } });
      if (await sleepUnlessStopped(CONFIG.BATCH_REST_MS)) break;
    }
    if (i < allow - 1) {
      if (await sleepUnlessStopped(U.randInt(
        CONFIG.SEND_INTERVAL_MIN_MS * slowFactor,
        CONFIG.SEND_INTERVAL_MAX_MS * slowFactor))) break;
    }
  }

  // 恢复 BOSS 招呼语开关
  if (originalSwitch) {
    try { await askTab(tabId, MSG.GREETING_SWITCH, { enabled: true }); } catch (e) { /* 忽略 */ }
  }

  const finalQuota = await quotaLeft();
  setPhase('send_done', {
    sendStat: { sent, total: allow, results, todayTotal: finalQuota.quota.sentCount || 0 },
    finishedAt: Date.now(),
  });
  return { sent, total: allow, results };
}

function tierOf(score) {
  for (const t of CONFIG.SCORE_TIERS) if (score >= t) return `${t}+`;
  return 'below_floor';
}

// ════════════════════════════════════════════════════════════
// 消息路由
// ════════════════════════════════════════════════════════════

const ROUTES = {
  [MSG.GET_STATE]: async () => {
    const store = await chrome.storage.local.get([
      STORE.SW.CONFIG, STORE.SW.TASK, STORE.SW.API_KEY, STORE.SW.RESUME_TEXT,
    ]);
    return {
      ok: true,
      task: state.task || store[STORE.SW.TASK] || null,
      config: store[STORE.SW.CONFIG] || {},
      hasApiKey: !!store[STORE.SW.API_KEY],
      hasResume: !!store[STORE.SW.RESUME_TEXT],
      jobCount: await Repo.countJobs(),
    };
  },

  [MSG.SAVE_CONFIG]: async (payload) => {
    const patch = {};
    if (payload.config !== undefined) patch[STORE.SW.CONFIG] = payload.config;
    if (payload.apiKey !== undefined) patch[STORE.SW.API_KEY] = payload.apiKey;
    if (payload.resumeText !== undefined) patch[STORE.SW.RESUME_TEXT] = payload.resumeText;
    await chrome.storage.local.set(patch);
    return { ok: true };
  },

  // 发令即返回，理由同 START_GREETING / START_SEND：
  // 召回是几分钟的长任务，之前 await runRecall 再响应，一旦 Service Worker 在
  // 等待中被回收、或 panel↔SW 的消息通道撑不过这几分钟，这条 sendMessage 的
  // Promise 就被判「message channel closed」，面板直接显示「出错了」，可后台其实
  // 还在跑。改成立刻返回，进度/收尾全靠 TASK_PROGRESS 广播（done/error 已在
  // runRecall 内 setPhase+broadcast），面板重开也能用 GET_TASK 补当前状态。
  [MSG.START_RECALL]: (payload) => {
    runRecall(payload || {}).catch((e) => {
      setPhase('error', { error: String(e.message || e) });
    });
    return { ok: true, started: true };
  },

  // 恢复搜索（需求 #11）：读断点 → 用断点里的条件快照续跑，跳过已完成单元。
  // 发令即返回（同 START_RECALL），进度/收尾全走 TASK_PROGRESS 广播。
  [MSG.RESUME_RECALL]: async () => {
    const cp = await loadSearchCheckpoint();
    if (!cp || !cp.config) return { ok: false, error: 'no_checkpoint' };
    const config = { ...cp.config, _doneSoFar: cp.doneUnits || [] };
    if (cp.mode === 'company') config._skipCompanies = new Set(cp.doneUnits || []);
    else config._skipUnits = new Set(cp.doneUnits || []);
    runRecall(config).catch((e) => {
      setPhase('error', { error: String(e.message || e) });
    });
    return { ok: true, started: true };
  },

  // 面板查断点（决定要不要显示「恢复搜索」按钮）：只回展示用字段，不回整个条件快照
  [MSG.GET_SEARCH_CHECKPOINT]: async () => {
    const cp = await loadSearchCheckpoint();
    return {
      ok: true,
      checkpoint: cp ? {
        savedAt: cp.savedAt, mode: cp.mode,
        doneCount: (cp.doneUnits || []).length, jobCount: cp.jobCount || 0,
      } : null,
    };
  },

  [MSG.CLEAR_SEARCH_CHECKPOINT]: async () => {
    await clearSearchCheckpoint();
    return { ok: true };
  },

  // 岗位词语义归类（LLM 兜底）：把字符串匹配不上的怪词交给模型，
  // 从 BOSS 职位类目叶子里选出最贴近的，返回「怪词→叶子 code[]」。
  [MSG.CLASSIFY_POSITIONS]: async (payload = {}) => {
    const keywords = (payload.keywords || []).filter(Boolean);
    if (!keywords.length || typeof POSITION_TREE === 'undefined') return { ok: true, map: {} };
    // 叶子名→{code, siblings}，供把命中的叶子扩展到整个二级家族
    const nameTo = new Map();
    for (const c of (POSITION_TREE.categories || [])) {
      for (const l2 of (c.children || [])) {
        const sibs = (l2.children || []).map((x) => String(x.code));
        for (const leaf of (l2.children || [])) nameTo.set(leaf.name, { code: String(leaf.code), sibs });
      }
    }
    const leafNames = [...nameTo.keys()];
    let classified = {};
    try {
      classified = await LLM.classifyPositions(keywords, leafNames);
    } catch (e) {
      console.log('[闪投] LLM 职位归类失败：', String(e.message || e));
      return { ok: true, map: {} };
    }
    // 把命中的叶子名转成 code，并扩展到所在二级家族（和确定性匹配一致）
    const map = {};
    for (const kw of keywords) {
      const names = Array.isArray(classified[kw]) ? classified[kw] : [];
      const codes = new Set();
      for (const nm of names) {
        const hit = nameTo.get(nm);
        if (hit) for (const s of hit.sibs) codes.add(s);
      }
      map[kw] = [...codes];
      if (codes.size) console.log('[闪投] LLM 归类', kw, '→', names, '(', codes.size, 'code)');
    }
    return { ok: true, map };
  },

  [MSG.STOP_TASK]: async () => {
    state.stopRequested = true;   // 独立标志，发送循环每轮都查它，不会被 setPhase 覆盖
    if (state.csTabId) {
      await chrome.tabs.sendMessage(state.csTabId, { type: MSG.STOP_TASK }).catch(() => {});
    }
    setPhase('aborted');
    return { ok: true };
  },

  [MSG.QUERY_JOBS]: async (payload) => {
    const jobs = payload?.taskId
      ? await Repo.jobsByTask(payload.taskId)
      : await Repo.jobsByState(payload?.state || JOB_STATE.RECALLED);
    jobs.sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, jobs: jobs.slice(0, payload?.limit || 200), total: jobs.length };
  },

  [MSG.RESOLVE_BRAND]: async (payload) => {
    const tabId = await ensureBossTab();
    const r = await askTab(tabId, MSG.SEARCH_BRAND, { companyName: payload.companyName });
    return { ok: true, brands: r.brands };
  },

  /**
   * 发令即返回，不等任务跑完。
   *
   * 之前是 await runGreeting(...) 再响应，那是个架构错误：
   * 拉 JD 要串行且每个间隔 3 秒，75 个岗位就是四五分钟，
   * 而 MV3 的 Service Worker 在长时间等待中随时会被浏览器回收。
   * 一旦被回收，这条 sendMessage 的 Promise 永远不会 resolve，
   * 面板就永远卡在「生成中」，哪怕后台其实已经写好一部分存库了。
   *
   * 现在立刻返回，进度和结果全靠 TASK_PROGRESS 广播，
   * 面板重开也能用 GET_TASK 补一次当前状态。
   */
  [MSG.START_GREETING]: (payload) => {
    runGreeting(payload.jobIds || [], {
      mode: payload.mode, globalGreet: payload.globalGreet, jobGreet: payload.jobGreet,
    }).catch((e) => {
      setPhase('greeting_error', { error: String(e.message || e) });
    });
    return { ok: true, started: true };
  },

  [MSG.GET_TASK]: async () => {
    const st = await chrome.storage.local.get(STORE.SW.TASK);
    return { ok: true, task: state.task || st[STORE.SW.TASK] || null };
  },

  [MSG.UPDATE_GREETING]: async (payload) => {
    const job = await Repo.getJob(payload.jobId);
    if (!job) return { ok: false, error: 'job_not_found' };

    if (payload.regenerate) {
      const st = await chrome.storage.local.get(STORE.SW.RESUME_TEXT);
      const prev = job.greeting?.text;
      job.greeting = await LLM.writeGreeting({
        resumeText: st[STORE.SW.RESUME_TEXT] || '', job, jdText: job.jdText, score: job.score,
      });
      // 保留历史版本，这是「什么样的招呼语是好的」最直接的训练信号
      job.greeting.history = [...(payload.history || []), prev].filter(Boolean);
      job.greeting.source = 'ai_regenerated';
    } else {
      job.greeting = { ...(job.greeting || {}), text: payload.text, source: 'manual_edited' };
    }
    await Repo.putJob(job);
    return { ok: true, greeting: job.greeting };
  },

  // 发令即返回，理由同 START_GREETING：投递是几分钟的长任务，
  // 等它跑完再响应会因 Service Worker 被回收而卡死面板。
  [MSG.START_SEND]: (payload) => {
    runSend(payload.jobIds || []).catch((e) => {
      setPhase('send_error', { error: String(e.message || e) });
    });
    return { ok: true, started: true };
  },

  /** 今日投递情况，面板进投递页时拉一次做提示 */
  [MSG.GET_QUOTA]: async () => {
    const { quota, batch, daily } = await quotaLeft();
    return {
      ok: true,
      today: quota.sentCount || 0,
      batchLimit: CONFIG.SOFT_BATCH_LIMIT,
      dailyLimit: CONFIG.DAILY_SEND_LIMIT,
      canSend: Math.min(batch, daily),
    };
  },

  [MSG.EXPORT_DATA]: async () => ({ ok: true, dump: await Repo.exportAll() }),

  /** 存简历截图并立刻 OCR。OCR 只在换简历时跑一次，不进主流程的时间预算 */
  [MSG.SAVE_RESUME_IMAGES]: async (payload) => {
    const images = (payload.images || []).slice(0, CONFIG.RESUME_IMAGE_MAX);
    await chrome.storage.local.set({ [STORE.SW.RESUME_IMAGES]: images });
    if (!images.length) {
      await chrome.storage.local.set({ [STORE.SW.RESUME_TEXT]: '' });
      return { ok: true, text: '' };
    }
    const text = await LLM.ocrResume(images.map((i) => i.dataUrl));
    await chrome.storage.local.set({ [STORE.SW.RESUME_TEXT]: text });
    return { ok: true, text };
  },

  /**
   * 读简历推荐岗位词。
   * 结果缓存在 storage 里，简历没变就不重复调模型。
   */
  [MSG.SUGGEST_POSITIONS]: async () => {
    const st = await chrome.storage.local.get([STORE.SW.RESUME_TEXT, 'sw:suggestedPositions']);
    const text = st[STORE.SW.RESUME_TEXT] || '';
    if (!text) return { ok: true, positions: [] };

    const cache = st['sw:suggestedPositions'];
    const sig = U.hash(text);
    if (cache && cache.sig === sig) return { ok: true, positions: cache.positions, cached: true };

    const positions = await LLM.expandPositions(text);
    await chrome.storage.local.set({ 'sw:suggestedPositions': { sig, positions } });
    return { ok: true, positions };
  },

  [MSG.GET_RESUME]: async () => {
    const st = await chrome.storage.local.get([STORE.SW.RESUME_IMAGES, STORE.SW.RESUME_TEXT]);
    return {
      ok: true,
      images: st[STORE.SW.RESUME_IMAGES] || [],
      text: st[STORE.SW.RESUME_TEXT] || '',
    };
  },

  /** 筛选项字典。抓一次缓存七天，过期或强制刷新时重抓 */
  [MSG.GET_FILTER_DICT]: async (payload = {}) => {
    const cached = (await chrome.storage.local.get(STORE.SW.FILTER_DICT))[STORE.SW.FILTER_DICT];
    const fresh = cached && (Date.now() - cached.scrapedAt < 7 * 24 * 3600 * 1000);
    if (fresh && !payload.force) return { ok: true, ...cached, cached: true };

    const tabId = await ensureBossTab();
    const r = await askTab(tabId, MSG.SCRAPE_FILTERS);
    const data = {
      dict: r.dict, sources: r.sources, cities: r.cities,
      positions: r.positions, scrapedAt: r.scrapedAt,
    };
    await chrome.storage.local.set({ [STORE.SW.FILTER_DICT]: data });
    return { ok: true, ...data, cached: false };
  },

  // content → SW 的单向通知，无需回复
  [MSG.COLLECT_PROGRESS]: async (payload) => {
    if (state.task) {
      // total 只有列表翻页那条消息才带，带了才更新「已收」；公司页读卡的 domPage 进度不带 total
      const collected = payload.total != null ? payload.total : state.task.progress.collected;
      state.task.progress = { ...state.task.progress, ...payload, collected };
      broadcast(MSG.TASK_PROGRESS, state.task);
    }
    return { ok: true };
  },

  [MSG.CS_READY]: async () => ({ ok: true }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const route = ROUTES[msg?.type];
  if (!route) return false;

  // 有些处理器是「发令即返回」的同步函数（START_SEND / START_GREETING），
  // 返回的是普通对象不是 Promise。用 Promise.resolve 包一层，
  // 让同步和异步处理器都能走同一条 .then 回复路径。
  Promise.resolve()
    .then(() => route(msg.payload, sender))
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));

  return true;
});

// ── 点扩展图标打开侧边栏 ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  Repo.open().catch((e) => console.error('[闪投] 数据库打开失败', e));
});

chrome.runtime.onStartup.addListener(() => {
  Repo.open().catch(() => {});
});
