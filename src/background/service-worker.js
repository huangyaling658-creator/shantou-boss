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
  '../shared/company-urls.js',  // boss公司頁網址 列表：公司名→公司页网址，精投定位先查表再搜索（2026-10-08 用户定）
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
  // 2026-10-08 坑：标签页被冻结/风控卡死时，content script 监听还在但永不响应，
  // sendMessage 的 Promise 会永远挂起——ensureBossTab 卡死、整批任务无声停摆。
  // 所以 ping 必须带超时（5 秒），超时按「没就绪」走补注入/降级流程。
  try {
    const r = await U.withTimeout(
      chrome.tabs.sendMessage(tabId, { type: MSG.PING }),
      CONFIG.PING_TIMEOUT_MS || 5000, 'ping_timeout');
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
// 间隔区间各模式自带（2026-10-08 起精投/海投统一 3~4 秒）；
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
  // 2026-10-08 用户定的最新链路（推翻 10-07 的点击版）：分页数 = 地点数 × 职位词数
  // （一词一城一个分页，最多 5 个并行、其余的排队）；每个分页**直接开全条件 URL**：
  //   /web/geek/jobs?city={码}&query={词}&{全部筛选参数}
  // 不再开主页打字、不再点城市选择器、不再逐个筛选项点击——用户实测复数 jobs 页
  // city/query/multiBusinessDistrict/position/jobType/payType/partTime/salary/
  // experience/degree/industry/scale/stage 全部吃 URL 参数（样本见工作笔记 10-08）。
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
  const stop = () => state.stopRequested || state.task.phase === 'aborted' || Date.now() >= taskDeadline
    || actionsDone >= budget || merged.size >= maxResults;
  // 布置闸：海投每开一个单元分页前过一道（1~2 秒随机一个，HAITOU_LAYOUT_*）。
  // 与开页闸共用同一条「预约时间槽」，几个城分页自然排队轮流开，不一窝蜂。
  const layoutSlot = () => acquireOpenSlot(CONFIG.HAITOU_LAYOUT_MIN_MS || 1000, CONFIG.HAITOU_LAYOUT_MAX_MS || 2000);
  const report = (cityCode, kw) => onProgress && onProgress({
    city: cityCode, keyword: kw, collected: merged.size, actionsDone, actionsBudget: budget,
  });

  await runInBatches(units, CONFIG.HAITOU_MAX_TABS || 5, async ({ code: cityCode, kw }) => {
    if (stop()) return;
    // ① 拼全条件 URL 直接开分页（2026-10-08 用户定：布置改网址，一次到位）。
    //    工作区域 BOSS 限选 9 个（用户实测），超了截前 9 个并如实上报；
    //    公司行业副选 BOSS 限 3 个（用户 2026-10-07 告知），沿用截前 3 个 + 上报。
    const f = { ...(config.filters || {}) };
    const bdRaw = Array.isArray(f.businessDistrict) ? f.businessDistrict.filter(Boolean) : (f.businessDistrict ? [f.businessDistrict] : []);
    const bdCodes = bdRaw.map(String).filter((v) => /^\d+$/.test(v));
    if (bdCodes.length > 9 && onProgress) onProgress({
      city: cityCode, keyword: kw, collected: merged.size, actionsDone, actionsBudget: budget,
      warn: `工作区域最多选 9 个（BOSS 限制），已按前 9 个布置（面板共选 ${bdCodes.length} 个）`,
    });
    f.businessDistrict = bdCodes.slice(0, 9);
    const indRaw = Array.isArray(f.industry) ? f.industry.filter(Boolean) : (f.industry ? [f.industry] : []);
    if (indRaw.length > 3 && onProgress) onProgress({
      city: cityCode, keyword: kw, collected: merged.size, actionsDone, actionsBudget: budget,
      warn: `公司行业副选最多 3 个，已按前 3 个布置（面板共选 ${indRaw.length} 个）`,
    });
    if (indRaw.length) f.industry = indRaw.map(String).slice(0, 3);

    const url = buildSearchUrl({ query: kw, city: cityCode, ...f });
    await layoutSlot();   // 开分页 = 一个布置行为，排队轮流来（模仿人类）
    if (stop()) return;
    const tab = await chrome.tabs.create({ url, active: true });
    const tabId = tab.id;
    try {
      await waitForTabComplete(tabId);
      let readyOk = false;
      for (let i = 0; i < 20; i++) { await U.sleep(500); if ((await pingTab(tabId)).ok) { readyOk = true; break; } }
      if (!readyOk) return;
      await U.sleep(U.randInt(500, 1000));   // 页面加载完人也要看一眼再动手（停留 0.5~1 秒）
      // 取证：布置后的真实 URL 落日志——参数在 → 导航成了、没生效是 BOSS 没认参数。
      console.log('[闪投] 海投布置URL:', decodeURIComponent(url));
      await askTab(tabId, MSG.SCROLL_RESET).catch(() => {});

      // ② 滚动读卡：一次滚动 = 一个行为。滚动懒加载只在前台标签触发（后台被
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
      closeTabLater(tabId);   // 模仿人类：用完隔 1~2 秒随机再关，不秒删
    }
  });
  return { actionsDone, perCity };
}

// ── 精投布置 + 本地过滤（2026-10-08 用户定）──────────────────────
// 公司页筛选：城市(路径前缀)+薪资(单选)+经验+学历走 URL 布置（服务端筛，
// 10-08 晚用户全维样本实锤 degree/experience 也吃参数，「安慰剂」决定作废），
// 薪资多选走本地筛。

const _normSel = (s) => String(s || '').replace(/[（(][^)）]*[)）]/g, '').replace(/\s+/g, '').replace(/经验|学历/g, '');

/** 薪资档位 label → [min,max]（K）：'20-50K'→[20,50]，'50K以上'→[50,∞]，'3K以下'→[0,3] */
function _salRangeOfLabel(l) {
  const s = _normSel(l);
  let m = s.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)K/i); if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = s.match(/(\d+(?:\.\d+)?)K以上/i); if (m) return [parseFloat(m[1]), Infinity];
  m = s.match(/(\d+(?:\.\d+)?)K以下/i); if (m) return [0, parseFloat(m[1])];
  return null;
}

/** 薪资匹配：面议/没解析到的保留；岗位区间与任一选中档位相交即留 */
function matchSalary(job, labels) {
  if (!labels.length) return true;
  if (job.salaryMin == null && job.salaryMax == null) return true;
  const ranges = labels.map(_salRangeOfLabel).filter(Boolean);
  if (!ranges.length) return true;
  const jmin = job.salaryMin || 0, jmax = job.salaryMax == null ? Infinity : job.salaryMax;
  return ranges.some(([lo, hi]) => jmax >= lo && jmin <= hi);
}

/**
 * 精投（2026-10-08 用户定的真人链路，微重做）：每个单元一个分页从首页走起——
 * 首页搜索栏打公司搜寻名 → 结果页点卡片左下角最贴合的公司名进公司页 →
 * 核对页头公司名（不吻合回结果页试点优的卡，最多 3 张）→
 * 改网址一次到位（招聘职位+搜词+布置：/gongsi/job/[c{城市码}/]{brandId}.html?query=词&salary=码）→
 * 翻页扫卡收答案。一个分页从头到尾开一次、关一次（用户定）；点招聘职位 tab / 页内搜索框 /
 * 四下拉的点击版代码保留不删不再调用（BOSS 改 URL 结构可切回）。
 *
 * @returns {number} 新增岗位数
 */
// BOSS 公司招聘页的「职位类型」一级大类码（2026-10-09 在真实公司页实测扒取）。
// 关键：职位类型走 URL 路径 /gongsi/job/{类型码}/{brandId}.html，城市码在前时是
// /gongsi/job/c{城市码}/{类型码}/{brandId}.html（顺序反了是 404）。这是精投过滤岗位的
// 正解——纯 URL 路径，不碰那个驱动不动的搜索框。
const JOB_CATEGORY = [
  { code: '110000', kw: ['产品'] },
  { code: '100000', kw: ['技术', '开发', '工程师', '算法', '数据', '研发', '测试', '运维', '前端', '后端', '架构', 'java', 'python', 'golang', 'c++', '大模型', '机器学习', '嵌入式', 'sre', 'devops'] },
  { code: '130000', kw: ['运营', '客服'] },
  { code: '120000', kw: ['设计', 'ui', 'ux', '视觉', '交互', '美术'] },
  { code: '140000', kw: ['市场', '公关', '广告', '品牌', '营销', '投放'] },
  { code: '160000', kw: ['销售', 'bd', '商务'] },
  { code: '150000', kw: ['人力', 'hr', '财务', '行政', '招聘', '会计'] },
  { code: '250000', kw: ['采购'] },
  { code: '240000', kw: ['供应链', '物流', '仓储'] },
  { code: '180000', kw: ['金融', '投资', '风控', '基金', '证券', '银行'] },
  { code: '190000', kw: ['教育', '培训', '讲师', '教师', '老师'] },
  { code: '210000', kw: ['医疗', '健康', '医药', '护士', '医生', '临床', '药'] },
  { code: '260000', kw: ['咨询', '翻译', '法律', '律师', '法务'] },
  { code: '170000', kw: ['直播', '影视', '传媒', '编导', '剪辑', '主播'] },
];
// 岗位词 → 职位大类码。按关键词匹配（产品在最前，「高级产品经理」也归产品）。匹配不到 → ''（走全量，本地兜底过滤）。
function categoryCodeOf(word) {
  const w = String(word || '').toLowerCase();
  for (const c of JOB_CATEGORY) if (c.kw.some((k) => w.includes(k))) return c.code;
  return '';
}

async function augmentFromCompanyPages(merged, config, onProgress) {
  const companies = (config.companies || []);
  if (!companies.length) return 0;

  // 精投链路（2026-10-09 重做）：开首页 → 搜公司名 → 点卡进公司页 → 核对 →
  // 拼 URL /gongsi/job/c{城市}/{职位类型码}/{brandId}.html 一次到位（城市+职位大类都在网址里）
  // → 翻页扫卡 → 并集。全程一个分页，不再用搜索框。单元 = 公司 × 城市 × 职位大类码。
  const posWords = (config.positions || []).filter(Boolean);
  // 岗位词映射到的职位大类码（去重）；一个都映射不到就用 '' 全量单元（本地按岗位名兜底过滤）。
  const catCodes = [...new Set(posWords.map(categoryCodeOf))];
  const typeUnits = catCodes.length ? catCodes : [''];

  // diag 全量镜像到 SW Console（2026-10-08 用户定稿：面板成功的只报份数、失败/异常才解释；
  // 过程取证行「定位/布置/布置后URL/份额回流」上面板会刷屏，挪去 Console 看 [闪投][diag]）。
  const diag = new Proxy([], {
    set(target, prop, value) {
      target[prop] = value;
      if (prop !== 'length' && !isNaN(+prop)) {
        const e = value || {};
        console.log('[闪投][diag]', e.company || '', e.step || `${e.keyword || ''} ${e.got ?? ''}个`);
      }
      return true;
    },
  });
  const brandMiss = [];   // 没定位到的公司名（首页→搜→点卡→核对 全走完仍没进对门），实时+最终都报给用户
  augmentFromCompanyPages._diag = diag;
  augmentFromCompanyPages._brandMiss = brandMiss;

  // 城市维度（用户 2026-10-08 定）：新开分页数 = 公司数 × 城市数 × 岗位词数。
  // 全国/没选城市 → 只有一个不带城市的单元（城市维度跳「全部」，本地过滤兜底）。
  const cityUnits = (config.cityNames || []).filter((n) => n && n !== '全国');
  const cityList = cityUnits.length ? cityUnits : [''];
  // 城市名 → BOSS 城市码（config.cities 与 config.cityNames 是面板同源 S.cities 的平行数组，
  // URL 布置的路径前缀用，用户 2026-10-08 抓样本反解：/gongsi/job/c{码}/{brandId}.html）
  const codeOfCity = (name) => {
    const i = (config.cityNames || []).indexOf(name);
    return i >= 0 ? String((config.cities || [])[i] || '') : '';
  };

  // 开页闸：每开一个分页全局至少隔 1~2 秒随机，轮流开、不突刺。闸已提升为模块级
  // （acquireOpenSlot，海投开城标签也过同一条闸），这里只留个别名保持可读性。
  const openGate = acquireOpenSlot;

  let unitDone = 0;
  let added = 0;

  // 搜索时长：决定时间上限 + 行为预算（每分钟 20 个）。
  // 精投放宽下限到 8 分钟（2026-10-09 用户定）：公司页要本地按岗位名过滤、淘汰率高，
  // 得多翻几页才能攒够每家 50 个过滤后的岗，时间给足，别让时间先到、量还没攒够。
  const mins = Math.min(30, Math.max(8, config.searchMinutes || 8));
  const taskTimeoutMs = mins * 60000;
  const taskDeadline = (state.task.startedAt || Date.now()) + taskTimeoutMs;
  const bOver = config.brandOverrides || {};     // 用户贴的公司主页网址抽出的 brandId（公司名→brandId）
  const targets = companies.map((c) => {
    // brandId 三优先级（用户 2026-10-08 定）：手动贴网址 > boss公司頁網址列表 > 搜索流程。
    // 前两者跳过首页搜索/点卡/核对，直接拼职位页 URL 开工；没命中一律走首页全流程。
    const listHit = companyUrlLookup([c.name, c.search, ...(c.aliases || [])]);
    return {
      company: c.name,
      searchName: c.search || c.name,   // 改搜索词功能已撤（2026-10-08 用户定），用库里的默认搜寻名
      aliases: c.aliases || [],
      brandId: bOver[c.name] || (listHit && listHit.brandId) || null,
      brandSrc: bOver[c.name] ? '贴网址' : (listHit ? '列表' : ''),
    };
  });
  for (const t of targets) if (t.brandSrc === '列表') diag.push({ company: t.company, step: '定位:boss公司頁網址列表命中，直达' });

  // 单元装配：公司 × 城市 × 职位大类码（2026-10-09 重做为 URL 路径方案）。
  // 每个单元 = 一个「公司 + 城市 + 职位大类」，拼成一条 /gongsi/job/c{城市}/{类型}/{brand}.html
  // 导航一次就过滤到位。岗位词已归并成大类码（typeUnits），同大类的多个词只跑一个单元。
  const units = [];
  for (const t of targets) {
    for (const city of cityList) {
      for (const typeCode of typeUnits) {
        units.push({ t, city, typeCode });
      }
    }
  }
  const unitTotal = units.length;
  // 每次最多同开 8 个分页（用户 2026-10-08 定）：并行池大小 = 单元数封顶 8
  const P = Math.max(1, Math.min(CONFIG.PARALLEL_COMPANIES || 8, units.length));
  // 每家公司的剩余单元数 / 是否定位成功过：全部单元跑完才落「已完成」终态（面板按公司展示）
  const remainBy = {};
  const locatedBy = {};
  for (const u of units) remainBy[u.t.company] = (remainBy[u.t.company] || 0) + 1;

  // ── 采集：全同步并行，每标签一条龙 ──
  // 选中的公司（最多 PARALLEL_COMPANIES 家）全部同时开跑，各翻各的。每家翻一页后独立随机睡
  // [4+N, (4+N)×2] 秒（N=当前还在跑的家数）：并行越多间隔越宽、总速率自己踩刹车；有家收完
  // N 变小、剩下的自动提速。满 TASK_HARD_TIMEOUT_MS（5 分钟，从任务开始算）就停、把已收的展示。
  const timeUp = () => Date.now() >= taskDeadline;   // 5 分钟硬封顶（含解析阶段，见上）
  const pagesCap = () => U.randInt(CONFIG.COMPANY_PAGES_MIN || 10, CONFIG.COMPANY_PAGES_MAX || 15);
  // 每家公司「过滤后」召回封顶：攒够 50 个符合岗位的岗就停这家（2026-10-09 用户定）。
  const perCompanyCap = CONFIG.COMPANY_KEPT_PER_COMPANY || 50;

  // 把一页卡入库：全局 merged 去重 + slot 自己的 seen；返回这页给「这家」新增了几个。
  // ★ 岗位过滤前置（2026-10-09）：公司页 query 岗位词不生效、返回的是全公司岗位，
  //   必须在这里按用户选的【所有岗位词】过滤，只有符合的才计入 seen/companySeen/merged——
  //   这样「每家够 50」数的就是过滤后的 50 个产品岗，开发/销售等岗当场丢掉、不占名额。
  const posFilterOn = posWords.length > 0;
  const killedSet = new Set();      // 被岗位过滤砍掉的 jobId（去重，仅作诊断/日志）
  const killedSample = [];
  const absorb = (slot, res) => {
    let nSlot = 0;
    for (const j of res.jobs || []) {
      if (!j.companyName) j.companyName = slot.company;
      // 精投是「进这个城市的公司页」搜的，这个岗就属于这个城市——卡片上没读到城市时，
      // 用单元的城市兜底打标签（用户 2026-10-09 要卡片带城市标签）。
      if (!j.city && slot.cityName) j.city = slot.cityName;
      if (!j.jobId) continue;
      if (posFilterOn && !matchesAnyPosition(j.jobName, posWords)) {
        if (!killedSet.has(j.jobId)) { killedSet.add(j.jobId); if (killedSample.length < 12) killedSample.push(j.jobName); }
        continue;   // 不符合岗位：直接丢，不入 seen/merged，不占这家的 50 个名额
      }
      if (!slot.seen.has(j.jobId)) { slot.seen.add(j.jobId); nSlot++; }
      if (slot.companySeen) slot.companySeen.add(j.jobId);   // 这家公司【过滤后】累计数，用于 50 封顶
      if (!merged.has(j.jobId)) { j._fromCompanyPage = true; merged.set(j.jobId, j); added++; }
    }
    return nSlot;
  };
  augmentFromCompanyPages._posCut = () => ({ count: killedSet.size, sample: killedSample.slice() });
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
  const urlDeadReported = {};   // 「网址失效」每家公司只报一次（同城多单元/重做会反复踩同一个烂 brandId）
  const stats = {};   // 每家：{ ms 用时, count 收到数, pages 翻页数 }，完成时用来标异常
  const live = {};    // 每家实时翻页数（工作步数），搜索中逐页更新给面板看
  const companySeenBy = {};   // 公司名 → 跨单元累计收到的 jobId（一家多单元共用，收够封顶判定用）
  augmentFromCompanyPages._statuses = statuses;
  augmentFromCompanyPages._stats = stats;
  const report = (slot, kw) => { if (onProgress) onProgress({ company: slot.company, keyword: kw, unitDone, unitTotal, collected: merged.size, domPage: slot.page, domMaxPages: slot.maxPages, misses: brandMiss.slice(), statuses: { ...statuses }, live: { ...live }, actionsDone, actionsBudget }); };

  // 全局行为闸（轮流派发）：无论几家在采，全局每 3~4 秒随机才放行一个「翻页行为」
  // （用户 2026-10-08 由 4~6 改 3~4，与海投一致）。3 分钟≈180秒÷3.5秒均值≈51 个行为可放行，
  // 预算 60 个是上限（闸管配速，预算到不了顶就到时长收工，用户 2026-10-08 定 3 分钟=60 个）。
  // 闸本身是模块级共享的（acquireTurnGlobal，海投 v2 的滚动
  // 行为也过同一条闸），这里只负责本模式的计数。
  let activeCount = 0;   // 仅用于显示/参考
  let actionsDone = 0;   // 已执行的行为数（翻页数），进度% = actionsDone / actionsBudget
  // 行为预算（翻页次数上限）：按时长算，再保底「每家公司够翻到 COMPANY_PAGES_MAX 页」，
  // 免得公司多/岗位淘汰率高时预算先用完、每家攒不够 50（2026-10-09 用户定：宁可多翻）。
  let actionsBudget = Math.max(
    Math.round(taskTimeoutMs / (60000 / (CONFIG.ACTIONS_PER_MINUTE || 20))),
    targets.length * (CONFIG.COMPANY_PAGES_MAX || 40),
  );
  const turnGate = async () => { await acquireTurnGlobal(); actionsDone++; };
  // 总行为数平分给每个分页（用户 2026-10-08 定）：每个单元最多花自己那一份，花完这个分页收工。
  // 全局闸照旧管节奏（这是上限不是配速），分到不足 2 的保底 2 个（至少读一页+翻一页）。
  const perUnitBudget = Math.max(2, Math.floor(actionsBudget / Math.max(1, units.length)));
  // 份额动态化（用户 2026-10-08 定）：单元提前收工（词翻完/没定位到）没花完的份额不浪费，
  // 攒进 bonusPool，在 processUnit 里平分给还没跑完的单元（正在跑的 + 还在排队的，含本轮
  // 取整丢的零头）。份额挂在单元对象上（u.cap / u.actions），onePass 里实时读，加了立即生效。
  let bonusPool = Math.max(0, actionsBudget - perUnitBudget * units.length);   // 初始平分取整丢的零头也进池
  for (const u of units) { u.cap = perUnitBudget; u.actions = 0; }
  const stop = () => state.stopRequested || state.task.phase === 'aborted' || timeUp();

  const ready = async (tabId) => {   // 等页面加载 + content script 就绪
    await waitForTabComplete(tabId);
    for (let i = 0; i < 20; i++) { await U.sleep(400); if ((await pingTab(tabId)).ok) break; }
    await U.sleep(1000);
  };

  // 等公司简介页页头出现（点卡是整页导航，content 会换人；SW 轮询，最多 ~15 秒）
  const pollHeader = async (tabId) => {
    for (let k = 0; k < 15 && !stop(); k++) {
      if (k) await U.sleep(1000);
      const r = await askTab(tabId, MSG.READ_COMPANY_HEADER, undefined, 8000).catch(() => null);
      if (r && r.ok && r.name) return r;
    }
    return null;
  };

  // 跑一个单元（公司×城市×词）：一个分页走完真人链路（开一次、关一次，用户 2026-10-08 定）：
  // 首页搜公司名 → 点卡片公司名进公司页 → 核对页头 → 点「招聘职位」→ 先搜词再布置 → 翻页扫卡。
  const onePass = async (u) => {
    const t = u.t;
    const slot = { company: t.company, cityName: u.city || '', tabId: null, page: 0, seen: new Set(), companySeen: companySeenBy[t.company] || (companySeenBy[t.company] = new Set()), maxPages: pagesCap(), lastHasNext: false, lastNew: 0 };
    let located = false;
    // 本单元已花的行为数记在 u.actions（份额 u.cap 是动态的：别的单元提前收工会回流加额）
    activeCount++;
    try {
      await openGate();
      if (stop()) return { located: false, pages: 0 };
      statuses[t.company] = 'locating';
      if (onProgress) onProgress({ company: t.company, keyword: '正在定位公司', unitDone, unitTotal, collected: merged.size, statuses: { ...statuses } });

      // ★ 关键渲染步骤（首页搜索/读卡/核对/布置）前把分页激活到前台：BOSS 的列表是 SPA，
      // 后台标签被 Chrome 渲染节流会读不到卡（腾讯栽过）。翻页扫卡阶段后台已验证没问题。
      const front = () => chrome.tabs.update(slot.tabId, { active: true }).catch(() => {});
      const names = [t.company, t.searchName, ...(t.aliases || [])].filter(Boolean);
      const nameMatch = (n) => {
        const ln = String(n || '').toLowerCase();
        return names.some((x) => { const xl = x.toLowerCase(); return ln.includes(xl) || xl.includes(ln); });
      };
      let matched = false;
      // bid0 = 本单元生效的 brandId（贴网址/列表给的固定值）。网址失效回退搜索后置 null，
      // 下方拼最终 URL 时就会改用「从当前公司页 URL 抽」的那条路（不能直接改 t.brandId——
      // t 是这家公司所有单元共用的，改了会坑同公司的其他单元）。
      let bid0 = t.brandId;

      if (bid0) {
        // 贴网址/boss公司頁網址列表命中：跳过首页搜索/点卡，直接开「招聘职位」页核对页头
        // （2026-10-08 用户定：列表网址一律招聘職位頁形態，省「简介页→职位页」一次导航；
        // READ_COMPANY_HEADER 对 /gongsi/job/ 同样有效，都读 h1/公司名/title）
        const tab = await chrome.tabs.create({ url: BOSS.PAGE.COMPANY_JOBS(bid0), active: false });
        slot.tabId = tab.id;
        await ready(slot.tabId);
        await front();
        const hdr = await pollHeader(slot.tabId);
        if (hdr && nameMatch(hdr.name)) matched = true;
        else {
          // 网址失效专属报错（用户 2026-10-08 定）：报错照报，但不判死——关掉这个打不开的
          // 分页，bid0 置空，落进下方搜索流程兜底。每家公司只报一次（同城多单元/重做会
          // 反复踩同一个烂 brandId，刷一屏同一行没意义）。
          if (!urlDeadReported[t.company]) {
            urlDeadReported[t.company] = 1;
            const src = t.brandSrc === '贴网址' ? '贴的网址' : '列表里的网址';
            diag.push({ company: t.company, step: `网址失效:${src}打不开或指向别家(读到:${(hdr && hdr.name) || '无页头'})，BOSS可能改了网址，已回退搜索流程；请改网址/更新列表` });
            console.log('[闪投] 网址失效（BOSS可能改了网址），回退搜索流程', t.company, t.brandSrc);
          }
          closeSlot(slot); slot.tabId = null; bid0 = null;
        }
      }
      if (!matched && !stop()) {
        // ── 第 1~2 步：开首页 → 搜索栏打公司搜寻名点搜索 ──
        const tab = await chrome.tabs.create({ url: `${BOSS.ORIGIN}/?ka=header-home-logo`, active: false });
        slot.tabId = tab.id;
        await ready(slot.tabId);
        await front();
        const hs = await askTab(slot.tabId, MSG.DRIVE_HOME_SEARCH, { keyword: t.searchName || t.company }, 15000).catch(() => null);
        if (!hs || !hs.ok) {
          diag.push({ company: t.company, step: '首页搜索没驱动:' + ((hs && hs.reason) || '无响应') });
          return { located: false, pages: 0 };
        }
        await waitForTabComplete(slot.tabId).catch(() => {});
        await U.sleep(U.randInt(500, 1500));   // 等结果页渲染，人扫一眼（0.5~1.5 秒，2026-10-08 用户定）

        // ── 第 3~4 步：点最贴合的卡进公司页 → 核对页头；不吻合回结果页试点优卡（最多 3 张，用户 2026-10-08 定）──
        for (let attempt = 0; attempt < 3 && !matched && !stop(); attempt++) {
          if (attempt > 0) {
            try { await chrome.tabs.goBack(slot.tabId); } catch (e) { break; }
            await waitForTabComplete(slot.tabId).catch(() => {});
            await U.sleep(U.randInt(500, 1500));
          }
          await front();
          const cc = await askTab(slot.tabId, MSG.COMPANY_CLICK_CARD, { names, attempt }, 30000).catch(() => null);
          if (!cc || !cc.ok) {
            diag.push({ company: t.company, step: !cc ? '点卡无响应' : `没找到贴合的卡片:${cc.reason}` });
            break;
          }
          const hdr = await pollHeader(slot.tabId);
          if (!hdr) { diag.push({ company: t.company, step: `点卡「${cc.cardName}」没等到公司页` }); break; }
          if (!nameMatch(hdr.name)) { diag.push({ company: t.company, step: `页头不吻合:${hdr.name}` }); continue; }   // 回去试点优卡
          matched = true;   // 进对门。点招聘职位/搜词/布置不再点页面，统一在下方一次改网址到位（用户 2026-10-08 定）
        }
      }
      if (!matched) return { located: false, pages: 0 };

      // ── 第 4~5 步合一（2026-10-08 用户定稿：点招聘职位+搜词+布置全部改网址，一次导航到位）──
      // 用户抓样本反解：简介页 /gongsi/{brandId}.html?ka=company-intro；招聘职位 =
      // /gongsi/job/{brandId}.html?ka=company-jobs；搜词 = ?query=词；城市 = 路径前缀
      // /gongsi/job/c{码}/（码 = 面板 S.cities 的 BOSS 码）；薪资 = ?salary=402~407（与面板
      // OPT.salary 的 code 一致）；经验/学历也吃 URL（用户 2026-10-08 全维样本实锤：
      // ?degree=209&experience=108&salary=402，此前的「安慰剂」决定作废转正）。
      // 公司页三下拉均为**单选**（同日用户截图实锤：工作经验 108,102-107 / 学历
      // 209,208,206,202-205 / 薪资 402-407，码序与面板 OPT 一致）——面板多选时取第一个
      // 进 URL，diag 如实注明「单选取首」。该单选结论用户定：**预设为精投独享**，
      // 海投仍按搜索页样本走多选逗号连，互不回推。
      // 核对页头已通过 → 从当前 URL 抽 brandId（贴网址分支直接用 bid0）→ 拼最终 URL 一次
      // tabs.update。薪资多选/城市无码 → 不带参数，薪资多选走本地过滤（runRecall 里）。
      // 岗位过滤走 URL 的【职位大类码】路径（2026-10-09 重做）：/gongsi/job/c{城市}/{类型}/{brand}.html。
      // 不再用那个驱动不动的搜索框。类型码由岗位词映射（u.typeCode）。
      const salarySel = ((config.filters && config.filters.salary) || []).filter((c) => c);
      const salaryCode = salarySel.length === 1 ? String(salarySel[0]) : '';
      const expSel = ((config.filters && config.filters.experience) || []).filter((c) => c).map(String);
      const degSel = ((config.filters && config.filters.degree) || []).filter((c) => c).map(String);
      const expCode = expSel[0] || '';   // 公司页单选：多选取首
      const degCode = degSel[0] || '';
      const cityCode = u.city ? codeOfCity(u.city) : '';
      const typeCode = u.typeCode || '';
      const fl = config.filterLabels || {};
      const urlBits = [];
      if (typeCode) urlBits.push(`职位类型✈${typeCode}`);
      if (u.city) urlBits.push(cityCode ? `城市✈${u.city}` : '城市→本地筛(无码)');
      if (salarySel.length) urlBits.push(salaryCode ? `薪资✈${(fl.salary || [])[0] || salaryCode}` : '薪资→本地筛(多选)');
      if (expSel.length) urlBits.push(`经验✈${(fl.experience || [])[0] || expCode}${expSel.length > 1 ? '(单选取首)' : ''}`);
      if (degSel.length) urlBits.push(`学历✈${(fl.degree || [])[0] || degCode}${degSel.length > 1 ? '(单选取首)' : ''}`);
      diag.push({ company: t.company, step: '布置:' + (urlBits.join(' ') || '无条件可布置') });
      let jobsReady = false;
      try {
        const curUrl = bid0 ? '' : ((await chrome.tabs.get(slot.tabId)).url || '');
        // brandId 提取：跳过可能的城市码段(c+数字)和职位类型码段(6位数字)，取最后的 brand 段。
        const m = curUrl.match(/\/gongsi\/(?:job\/)?(?:c\d+\/)?(?:\d{6}\/)?([^.\/?]+)\.html/);
        const bid = bid0 || (m && m[1]);
        if (!bid) {
          diag.push({ company: t.company, step: '没从公司页URL抽到brandId:' + curUrl.replace(/^https?:\/\//, '').slice(0, 60) });
          return { located: false, pages: 0 };   // 交给 processUnit 重做
        }
        // 路径顺序实测定死：c{城市}/ 在前，{职位类型码}/ 在后（反了是 404）。
        const nu = new URL(`${BOSS.ORIGIN}/gongsi/job/${cityCode ? 'c' + cityCode + '/' : ''}${typeCode ? typeCode + '/' : ''}${bid}.html`);
        // 薪资/经验/学历这几个 query 参数实测生效，照旧带。
        if (salaryCode) nu.searchParams.set('salary', salaryCode);
        if (expCode) nu.searchParams.set('experience', expCode);
        if (degCode) nu.searchParams.set('degree', degCode);
        if (!salaryCode && !expCode && !degCode) nu.searchParams.set('ka', 'company-jobs');   // 无参数时带上 ka，跟人点 tab 一样
        // 贴网址/列表命中时分页已停在招聘职位页：若最终 URL 与当前 URL 一致（无词无薪资
        // 无城市码），不用再 tabs.update 白刷一次（2026-10-08 用户把列表网址改成职位页形态
        // 后，「核对页头 → 布置导航」经常其实是同一页）。不一致才导航。
        await front();   // 关键渲染步骤前激活前台（后台标签 SPA 列表会被节流，腾讯栽过）
        const beforeUrl = await chrome.tabs.get(slot.tabId).then((tb) => (tb.url || '').split('#')[0]).catch(() => '');
        if (beforeUrl !== nu.toString()) {
          await chrome.tabs.update(slot.tabId, { url: nu.toString() });
          await U.sleep(U.randInt(500, 1500));   // 等 Chrome 真开始导航（防 waitForTabComplete 看到旧的 complete；0.5~1.5 秒）
          await waitForTabComplete(slot.tabId).catch(() => {});
        }
        for (let k = 0; k < 15 && !jobsReady && !stop(); k++) {   // 等职位列表（页内搜索框）就绪
          if (k) await U.sleep(1000);
          const r = await askTab(slot.tabId, MSG.COMPANY_JOBS_READY, undefined, 8000).catch(() => null);
          jobsReady = !!(r && r.ready);
        }
        // 取证：把导航后的真实 URL 写进 diag——有 c码/salary/query → 导航成了、无效是 BOSS 没认参数；
        // 没有 → 导航没成，查异常行。显示前 decode 一次：地址栏人眼看的是解码态（ai产品经理），
        // 复制出来/传输的是编码态（ai%E4%BA%A7…），两者等价，diag 按人眼习惯显示（用户 2026-10-08 提）。
        const afterUrl = await chrome.tabs.get(slot.tabId).then((tb) => tb.url || '').catch(() => '');
        if (afterUrl) {
          let shown = afterUrl.replace(/^https?:\/\//, '');
          try { shown = decodeURIComponent(shown); } catch (e) { /* 有个别字符解不开就显示原样 */ }
          diag.push({ company: t.company, step: '布置后URL:' + shown.slice(0, 110) });
        }
      } catch (e) {
        diag.push({ company: t.company, step: '布置网址异常:' + String(e.message || e).slice(0, 24) });
      }
      // 列表没就绪：贴网址/列表单元加一句提示——简介页能开但职位页出不来，可能是 BOSS
      // 把职位页网址结构改了（这种确定性故障重做也白搭，但先按没定位到交回重做兜底，
      // 连续 3 次都一样就实锤网址结构变了，看 diag 里这句提示 + 上方「布置后URL」取证行）。
      if (!jobsReady) {
        diag.push({ company: t.company, step: '职位列表没就绪' + (bid0 ? '（若重做3次都一样：BOSS可能改了职位页网址结构）' : '') });
        return { located: false, pages: 0 };
      }
      located = true;
      statuses[t.company] = 'searching';
      if (onProgress) onProgress({ company: t.company, keyword: '正在搜职位', unitDone, unitTotal, collected: merged.size, statuses: { ...statuses } });
      await U.sleep(U.randInt(CONFIG.COMPANY_LAYOUT_MIN_MS || 500, CONFIG.COMPANY_LAYOUT_MAX_MS || 1500));   // 布置完停一下再开扫（0.5~1.5 秒）

      // ★ 职位类型已经通过 URL 路径过滤好了（/gongsi/job/c城市/类型/brand.html），
      //   这里直接翻页读卡即可，不再碰搜索框（2026-10-09 重做）。读到的就是这个大类的岗位。
      const companyFull = () => (slot.companySeen && slot.companySeen.size >= perCompanyCap);
      slot.page = 0; slot.lastHasNext = true; slot.lastNew = 1;
      await turnGate(); u.actions++; if (stop()) return { located, pages: u.actions };   // 读第 1 页也算一个行为，过全局闸
      let res = await askTab(slot.tabId, MSG.COMPANY_DOM_PAGE, { turnFirst: false }).catch(() => ({ jobs: [], hasNext: false }));
      slot.lastNew = absorb(slot, res); slot.page = 1; slot.lastHasNext = !!res.hasNext;
      live[t.company] = slot.page; report(slot, typeCode || '全部');
      while (!kwExhausted(slot) && !stop() && u.actions < u.cap && !companyFull()) {
        await turnGate(); u.actions++;   // 翻一页 = 一个行为，全局每 3~4 秒才放行一个
        if (stop()) break;
        res = await askTab(slot.tabId, MSG.COMPANY_DOM_PAGE, { turnFirst: true }).catch(() => ({ jobs: [], hasNext: false, turned: false }));
        slot.page++;
        slot.lastNew = absorb(slot, res);
        slot.lastHasNext = res.turned === false ? false : !!res.hasNext;
        live[t.company] = slot.page; report(slot, typeCode || '全部');
      }
      diag.push({ company: slot.company, keyword: (typeCode ? '类型' + typeCode : '全部') + (u.city ? '@' + u.city : ''), got: slot.companySeen.size, source: 'url-type' });
      if (u.actions >= u.cap && !companyFull()) {
        diag.push({ company: t.company, step: `单元行为份额用完(${u.cap}个)：${u.city || '全国'}` });
      }
      return { located, pages: u.actions };   // 本单元累计翻页数
    } catch (e) {
      diag.push({ company: t.company, step: '采集异常:' + String(e.message || e).slice(0, 24) });
      return { located, pages: 0 };
    } finally {
      // 搜成功(定位到并读完)的标签【留着别关】，方便用户回看那页岗位（用户 2026-10-09）；
      // 只关掉没定位到/重做作废的垃圾标签。
      if (!located) closeSlot(slot);
      activeCount = Math.max(0, activeCount - 1);
    }
  };

  // 一个单元（公司×城市）跑一遍（内部对所有岗位词在搜索框依次搜）。没定位到的单元重做：
  // 最多重做 3 次，每次重做总剩余行为数 +10（actionsBudget 与这个单元的 cap 各 +10，
  // 这份额外预算留给重做的单元用）。定位成功/已定位但提前收工的单元不重做，
  // 省下的份额照常在下方回流给未完单元。
  const processUnit = async (u) => {
    if (stop()) return;
    const t = u.t;
    // 这家公司已攒够「过滤后」目标量（50）→ 跳过它剩下的单元，不再开页空转（2026-10-09）。
    // （一家公司的多个城市单元共用 companySeenBy[公司]，第一个城市攒满后其余城市直接跳过。）
    if ((companySeenBy[t.company] || new Set()).size >= perCompanyCap) {
      unitDone++;
      remainBy[t.company] = Math.max(0, (remainBy[t.company] || 1) - 1);
      if (remainBy[t.company] === 0 && locatedBy[t.company]) statuses[t.company] = 'done';
      return;
    }
    const tStart = Date.now();
    let r = await onePass(u);
    // 网址失效不在这层处理（2026-10-08 用户改定）：onePass 里报错后已回退搜索流程兜底，
    // 搜得到就照常跑，搜不到才按普通「没定位到」进下面的重做。
    for (let retry = 1; retry <= 3 && !r.located && !stop(); retry++) {
      actionsBudget += 10;   // 总剩余行为数 +10（用户 2026-10-08 定）
      u.cap += 10;           // 这 +10 给这个重做的单元自己用（定位成功后可多翻页）
      diag.push({ company: t.company, step: `没定位到，第${retry}次重做（总预算+10）` });
      console.log('[闪投] 没定位到，重做', retry, '/', 3, t.company);
      await U.sleep(U.randInt(1000, 2000));   // 隔 1~2 秒再来，跟人重试一样（2026-10-08 用户由 1~3 收紧）
      if (stop()) break;
      r = await onePass(u);
    }
    unitDone++;
    locatedBy[t.company] = locatedBy[t.company] || r.located;
    remainBy[t.company] = Math.max(0, (remainBy[t.company] || 1) - 1);
    if (remainBy[t.company] === 0) {   // 这家公司的全部单元都跑完了才落终态（面板按公司展示）
      if (locatedBy[t.company]) { statuses[t.company] = 'done'; }
      else {
        statuses[t.company] = 'miss';
        if (!brandMiss.includes(t.company)) brandMiss.push(t.company);
        console.log('[闪投] 没定位到', t.company); diag.push({ company: t.company, step: '没定位到' });
        // 埋点：定位失败上报平台（重做 3 次后仍没进对门，1 家公司 1 条）
        if (typeof Tracker !== 'undefined') Tracker.track('locate_fail', { reason: 'company_miss' });
      }
    }
    // 指标按公司累计（跨单元）：用时/页数累加，count 取该公司当前在库岗位数
    const count = [...merged.values()].filter((j) => j.companyName === t.company).length;
    const prev = stats[t.company] || { ms: 0, count: 0, pages: 0 };
    stats[t.company] = { ms: prev.ms + (Date.now() - tStart), count, pages: (prev.pages || 0) + (r.pages || 0) };
    // ── 剩余份额回流（用户 2026-10-08 定）──
    // 这个单元提前收工（词翻完/页数到/没定位到）没花完的份额 + 池里攒的零头，平分给
    // 还没跑完的单元（正在跑的 + 还在排队的），正在翻页的单元下一轮判断立即按新份额走。
    // 不变式：所有单元的 cap 之和 ≤ actionsBudget，总预算不会超。
    u._done = true;
    const leftover = Math.max(0, u.cap - (u.actions || 0));
    if (leftover > 0) bonusPool += leftover;
    const unfinished = units.filter((x) => !x._done);
    if (unfinished.length && bonusPool > 0) {
      const add = Math.floor(bonusPool / unfinished.length);
      if (add > 0) {
        for (const x of unfinished) x.cap += add;
        bonusPool -= add * unfinished.length;   // 除不尽的零头留在池里，等下一个单元收工再分
        diag.push({ company: t.company, step: `份额回流：剩${leftover}个平分给${unfinished.length}个未完单元(各+${add})` });
      }
    }
    if (onProgress) onProgress({ company: t.company, keyword: '', unitDone, unitTotal, collected: merged.size, misses: brandMiss.slice(), statuses: { ...statuses }, stats: { ...stats }, actionsDone, actionsBudget });
  };

  // 并行池：最多 8 个分页同时一条龙，一个收完就从队列拉下一个单元顶上
  const queue = units.slice();
  const worker = async () => { while (queue.length && !stop()) { const u = queue.shift(); if (u) await processUnit(u); } };
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
  // 参数名/码表全部按用户 2026-10-08 实测样本：salary=402~407、experience=101~108、
  // degree=202~209、scale=301~306、stage=801~808、jobType=1901全职/1903兼职、
  // industry=100020…、payType=2501~2504、partTime=2701~2706（后两者面板还没有，先透传）。
  // 多选逗号拼接（用户实测：选九个区就是九个码逗号连）。不限 = 不带这个参数。
  for (const key of ['experience', 'degree', 'salary', 'scale', 'stage', 'jobType', 'industry', 'payType', 'partTime']) {
    const v = val(filters[key]);
    if (v) u.searchParams.set(key, v);
  }
  // 工作区域（2026-10-08 用户实测）：参数名是 multiBusinessDistrict（旧代码拼的
  // businessDistrict 页面根本不认，等于区域条件从没通过 URL 生效过）；
  // 一码对一区，BOSS 限选 9 个 → 超了截前 9 个（SW 里会附带 warn 上报）。
  // 值里可能混着区名（没抓到真实 code），URL 只带数字 code。
  const bd = val(filters.businessDistrict);
  if (bd) {
    const codes = String(bd).split(',').filter((v) => /^\d+$/.test(v)).slice(0, 9);
    if (codes.length) u.searchParams.set('multiBusinessDistrict', codes.join(','));
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

// 职能族的英文/缩写线索：岗位词属于这个族时，岗位名里出现这些也算命中（修 2026-10-09 误砍）。
// 典型：「Agent评测PM」是产品岗，但名字不带「产品」二字，光靠中文根词会被砍。
// PM/PO 要求是独立词（前后不是字母），免得误吃 PMO/SPM/APM 之类。
const FAMILY_ALIASES = {
  '产品': [/(^|[^a-z])(pm|po)([^a-z]|$)/, /product/],
  '运营': [/operation/],
  '设计': [/design|(^|[^a-z])(ui|ux)([^a-z]|$)/],
};

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
    // 3. 英文/缩写线索：如「产品」族的岗位名含独立的 PM/PO 或 product，也算命中（修误砍）。
    for (const r of roots) {
      const res = FAMILY_ALIASES[r];
      if (res && res.some((re) => re.test(n))) return true;
    }
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

async function runRecall(config = {}) {
  // 允许 aborted：用户点「停止」后后台虽还在卸载，但应能立刻开新一轮，不卡「任务进行中」
  if (state.task && !['done', 'error', 'aborted'].includes(state.task.phase)) {
    throw new Error('task_already_running');
  }
  state.stopRequested = false;   // 新一轮搜索，清掉上次的停止标志

  // OCR 与搜索同时做（2026-10-08 用户定）：搜索一开始就在后台预热简历识别，
  // 搜索要跑几分钟、识别最多 60 秒，等用户点生成时文字早就备好。
  // 刻意不 await、不阻塞搜索；失败静默（生成时 ensureResumeText 会再试）；
  // 与点生成同时触发时的并发去重由 ensureResumeText 内部处理。
  ensureResumeText().catch(() => {});

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
    // 真人链路进公司招聘职位页（首页搜公司→点卡→核对→招聘职位），全部在 augmentFromCompanyPages 里做。
    // 海投 v2：一词一城一个分页直接开全条件 URL（布置改网址，2026-10-08 定）→ 滚动读卡，在 runHaitouScroll 里做。
    let htResult = null;   // 海投结果（actionsDone/perCity）；精投为 null
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
    // 精投：公司页是「全公司岗位」，absorb 已按岗位名过滤。把砍掉的非目标岗数亮给漏斗看，
    // 否则用户只看到「搜到 50」，不知道其实扫了一大堆、大多是开发/销售等非目标岗（2026-10-09）。
    if (mode === 'company' && augmentFromCompanyPages._posCut) {
      const pc = augmentFromCompanyPages._posCut();
      if (pc.count > 0) { funnel.companyPosCut = pc.count; funnel.companyPosCutSample = pc.sample; }
    }
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

    // ── 精投本地过滤：只留薪资（2026-10-08 用户定）──
    // 经验/学历已于 10-08 晚转正进 URL（用户全维样本实锤公司页吃 degree/experience），
    // 由服务端筛，本地不再碰。薪资多选时 URL 只放单选，
    // 这里按用户所选在本地筛一道。卡片没抓到标签的、写「不限」的、薪资面议的
    // 一律保留（宁可多给）；筛完归零 → 放弃该维，别让用户空手。
    if (mode === 'company') {
      const fl = config.filterLabels || {};
      const localCut = {};
      const applyLocal = (name, labels, pred) => {
        if (!labels.length || !jobs.length) return;
        const before = jobs.length;
        const kept = jobs.filter(pred);
        if (kept.length) { localCut[name] = before - kept.length; jobs = kept; }
        else localCut[name + 'Skipped'] = true;
      };
      applyLocal('salary', fl.salary || [], (j) => matchSalary(j, fl.salary || []));
      if (Object.keys(localCut).length) funnel.localFilterCut = localCut;
    }

    // ── 岗位名过滤（本地兜底，仅海投）──
    // BOSS 的推荐填充会无视职位类型筛选硬塞非目标岗（大客户代表、机械工程师…），
    // 翻页闸门拦不干净的，这里再按「职能家族根词」兜一道。
    //
    // ★ 精投不在这里过滤：公司招聘页返回的是全公司岗位、query 岗位词不生效，
    //   精投的岗位过滤已【前置到 absorb】（边翻边按所有岗位词筛，只留符合的、攒满 50），
    //   到这里 merged 已经是过滤后的，再跑一遍纯属重复。海投没有前置过滤，仍走这一道。
    //   matchesAnyPosition 已放宽到「职能家族根词」（产品/运营/设计…），同族岗不会误杀。
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

/**
 * 简历文字按需取（2026-10-08 用户定：OCR 放在搜索之后做）。
 * 上传时只存图不识别；走到真正要用文字的环节（生成招呼语/推荐岗位词）才识别：
 *   - 文字已有 → 直接用（图没变不重复花钱）
 *   - 文字空但图在 → 当场 OCR 一次（≤60 秒）并存储，下次直接用
 *   - OCR 失败 → 异常原样抛出，不缓存失败状态，下次自动再试
 *   - 连图都没有 → 返回空串，由调用方决定怎么提示
 */
async function ensureResumeText() {
  // 并发去重：搜索开始的预热和用户点生成可能同时触发，只跑一次识别；
  // 失败后清掉挂起的 Promise，下次调用自动重试。
  if (ensureResumeText._p) return ensureResumeText._p;
  const run = (async () => {
    const st = await chrome.storage.local.get([STORE.SW.RESUME_TEXT, STORE.SW.RESUME_IMAGES]);
    if (st[STORE.SW.RESUME_TEXT]) return st[STORE.SW.RESUME_TEXT];
    const images = st[STORE.SW.RESUME_IMAGES] || [];
    if (!images.length) return '';
    const text = await LLM.ocrResume(images.map((i) => i.dataUrl));
    await chrome.storage.local.set({ [STORE.SW.RESUME_TEXT]: text });
    return text;
  })();
  ensureResumeText._p = run;
  try { return await run; } finally { ensureResumeText._p = null; }
}

async function doGreeting(jobIds, opts = {}) {
  state.stopRequested = false;   // 新一轮生成，清掉上次的停止标志
  const mode = opts.mode || 'ai';          // ai | custom
  const globalGreet = (opts.globalGreet || '').trim();
  const jobGreet = opts.jobGreet || {};

  // 简历文字按需取（2026-10-08 用户定：OCR 放在搜索之后做）。这里在
  // AI 模式才识别（自定义模式直接用现成文案，不必拦）；放在看门狗启动
  // 之前调，识别最长 60 秒，不能被 30 秒看门狗误杀。
  const resumeText = mode === 'ai' ? await ensureResumeText() : '';
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
      // 埋点：自定义招呼语，1 份算 1 次
      if (typeof Tracker !== 'undefined') Tracker.track('greeting_custom', { via: perJob ? 'job' : 'global' });
      emit(job);
    } else {
      aiJobs.push(job);
    }
  }

  // 2. AI 岗位用并发工作池：每个 worker 抓 JD（后台直接抓 HTML，快）+ 生成招呼语。
  //    之前是逐个「导航开页面→等加载→读 JD→生成」串行，81 个要好几分钟。
  //    改成后台抓 JD + 多个岗位同时生成，快数倍。JD 走详情页 HTML（不是被严格
  //    限流的 joblist 接口），并发抓风险低。
  // 2026-10-08：ensureBossTab 整体再加一道 30 秒兜底（ping 已带 5 秒超时，这里防
  // 重载/注入链里任何一环再出意外）。拿不到标签页不致命——跳过抓 JD 照样生成，
  // 招呼语里少引用 JD 细节而已，绝不能再让生成整批无声卡死。
  const tabId = aiJobs.length
    ? await U.withTimeout(ensureBossTab(), CONFIG.TAB_ENSURE_TIMEOUT_MS || 30000, 'ensure_boss_tab_timeout').catch(() => null)
    : null;
  const queue = [...aiJobs];
  const conc = Math.min(CONFIG.GREETING_CONCURRENCY || 5, Math.max(1, aiJobs.length));

  const worker = async () => {
    while (queue.length) {
      if (state.stopRequested || state.task.phase === 'aborted') return;
      const job = queue.shift();

      // 抓 JD（后台 HTML 抓取，不导航、不抢焦点；带超时——这段以前无超时，
      // 被风控挂起时所有 worker 一起卡死，面板永远停在 0/N）
      // tabId 为 null（ensureBossTab 超时降级）时直接跳过抓 JD，照样生成
      if (!job.jdText && tabId) {
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
        // 埋点：AI 招呼语生成成功，1 份算 1 次（fallback 不计）
        if (typeof Tracker !== 'undefined') Tracker.track('greeting_gen');
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

  // 后台投递，不抢焦点。30 秒兜底：标签页卡死时报错收场，不再无声挂起（2026-10-08 坑）
  const tabId = await U.withTimeout(ensureBossTab(), CONFIG.TAB_ENSURE_TIMEOUT_MS || 30000, 'ensure_boss_tab_timeout');

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
  // 当天已投基数（用插件投过的累计）：本批要【累加】在它之上，不能覆盖。
  // 修 2026-10-09：原来落库是 q.sentCount = sent，每批都把当天历史覆盖成「本批数」，
  // 所以「今天累计」永远只剩最后一批的量（用户投了好多却显示 8）。
  const baseSent = ((await Repo.getQuota(U.today())) || {}).sentCount || 0;

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
        // 埋点：投递跳过（HR 冷却）上报平台
        if (typeof Tracker !== 'undefined') Tracker.track('deliver_skip', { reason: SKIP_REASON.HR_COOLDOWN });
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
        // 埋点：投递跳过（聊过了）上报平台
        if (typeof Tracker !== 'undefined') Tracker.track('deliver_skip', { reason: SKIP_REASON.ALREADY_CHATTED });
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
        // 埋点：确认发出才算投递成功 1 份（与 send_click「点了按钮」区分，可算转化率）
        if (typeof Tracker !== 'undefined') Tracker.track('deliver');
        if (job.hrId) await Repo.touchHr(job.hrId, job.companyId);
        // 招呼语发出去了，但图片没发全，如实标注
        const imgNote = imgTotal && (r.images || 0) < imgTotal
          ? `招呼语已发，简历图 ${r.images || 0}/${imgTotal}` : '';
        log('ok', imgNote);
      } else {
        job.dispatch = { status: 'failed', failReason: r.reason };
        job.state = JOB_STATE.FAILED;
        await Repo.putJob(job);
        // 埋点：投递失败上报平台（reason=原始代号，如 input_not_found）
        if (typeof Tracker !== 'undefined') Tracker.track('deliver_fail', { reason: r.reason || 'unknown' });
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
    q.sentCount = baseSent + sent;   // 累加在当天已投基数上，不覆盖（见上 baseSent 说明）
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
  [MSG.START_RECALL]: async (payload) => {
    // 每次都是全新搜索（2026-10-08 用户定：恢复搜索整个功能取消，不再比对条件、
    // 不再有断点/跳过已完成单元，点了「开始搜索」就从头上跑一轮）。
    const config = payload || {};
    runRecall(config).catch((e) => {
      setPhase('error', { error: String(e.message || e) });
    });
    return { ok: true, started: true };
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
      const prev = job.greeting?.text;
      job.greeting = await LLM.writeGreeting({
        resumeText: await ensureResumeText(), job, jdText: job.jdText, score: job.score,
      });
      // 保留历史版本，这是「什么样的招呼语是好的」最直接的训练信号
      job.greeting.history = [...(payload.history || []), prev].filter(Boolean);
      job.greeting.source = 'ai_regenerated';
      // 埋点：重新生成也算 1 份
      if (typeof Tracker !== 'undefined') Tracker.track('greeting_gen', { via: 'regenerate' });
    } else {
      job.greeting = { ...(job.greeting || {}), text: payload.text, source: 'manual_edited' };
      // 埋点：手动改文案也算自定义招呼语 1 份
      if (typeof Tracker !== 'undefined') Tracker.track('greeting_custom', { via: 'manual_edit' });
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
    // OCR 不在上传时跑（2026-10-08 用户定：放在搜索之后要用文字时自动做）。
    // 换图必须清掉旧文字——宁可空着等下次自动识别，也不能拿旧简历的文字
    // 冒充新简历去生成。
    await chrome.storage.local.set({ [STORE.SW.RESUME_TEXT]: '' });
    return { ok: true, text: '' };
  },

  /**
   * 读简历推荐岗位词。
   * 结果缓存在 storage 里，简历没变就不重复调模型。
   */
  [MSG.SUGGEST_POSITIONS]: async () => {
    // 简历文字按需取：没有就当场识别（第一次点推荐会先读简历，最多等 1 分钟）
    const st = await chrome.storage.local.get('sw:suggestedPositions');
    const text = await ensureResumeText();
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
