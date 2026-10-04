// ════════════════════════════════════════════════════════════════
// 闪投 · 侧边栏
// ────────────────────────────────────────────────────────────────
// 界面原则：
//   1. 顺着用户做事的顺序排，不设标签页，不露内部术语
//   2. 内部处理（OCR、去重、分档）不打断用户，也不拦着他往下走
//   3. 能点就不让打字，选项默认铺出来，搜索框只做补充
// ════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

// 界面上已经拿掉的元素（识别状态、底部提示），相关代码仍可能写它们。
// 用安全写法接住，避免因为一个 null 就把整段逻辑打断。
const $set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
const $has = (id) => !!$(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ask(type, payload) {
  return chrome.runtime.sendMessage({ type, payload }).then((r) => {
    if (!r) throw new Error('后台无响应，请到扩展管理页重新加载');
    if (r.ok === false) throw new Error(r.error || '未知错误');
    return r;
  });
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ════════════════════════════════════════════════════════════
// 状态
// ════════════════════════════════════════════════════════════

const S = {
  screen: 'config',
  searchMode: 'position',   // position=广撒网(岗位驱动) | company=锁定公司(公司驱动)
  resumeImages: [],
  resumeText: '',
  companies: [],
  positions: [],
  cities: [],
  filters: {},
  dict: null,
  dictSources: null,
  cityDict: [],
  positionDict: [],
  recommended: [],
  cityExpanded: false,
  jobs: [],
  selected: new Set(),
  busy: false,
  sending: false,        // 投递进行中（含暂停）
  sendPaused: false,     // 已暂停，等继续
  sentJobIds: new Set(), // 本轮已处理过的岗位
  taskId: null,
  greeted: false,
  sendResults: [],
  failedJobIds: [],
  industryOpen: '',
  greetMode: 'ai',
  globalGreet: '',
  jobGreet: {},
  refineTerms: [],       // [{term, on}] 按岗位词拆出的子词，点亮的是或门条件
};

const HOT_CITIES = [
  { code: '100010000', label: '全国' }, { code: '101010100', label: '北京' },
  { code: '101020100', label: '上海' }, { code: '101280100', label: '广州' },
  { code: '101280600', label: '深圳' }, { code: '101210100', label: '杭州' },
  { code: '101270100', label: '成都' }, { code: '101200100', label: '武汉' },
  { code: '101190100', label: '南京' }, { code: '101230200', label: '苏州' },
];
const MORE_CITIES = [
  { code: '101020900', label: '合肥' }, { code: '101250100', label: '长沙' },
  { code: '101040100', label: '重庆' }, { code: '101110100', label: '西安' },
  { code: '101030100', label: '天津' }, { code: '101120100', label: '济南' },
  { code: '101120200', label: '青岛' }, { code: '101070100', label: '沈阳' },
  { code: '101230200', label: '厦门' }, { code: '101280700', label: '珠海' },
  { code: '101280800', label: '东莞' }, { code: '101210400', label: '宁波' },
  { code: '101190400', label: '无锡' }, { code: '101180100', label: '郑州' },
];

// ── 各筛选项的选项表 ──
// 顺序、外露选项、默认值全部对齐同类产品的成熟形态，
// 用户在两个产品之间切换时不用重新认一遍。
// code 优先用运行时从 BOSS 页面抓到的真实编码；抓不到才用这里的内置值，
// 内置值未经实测验证，界面上会标注出来。
const OPT = {
  industry: [
    { code: '', label: '不限' }, { label: '互联网/AI' }, { label: '电子/通信/半导体' },
    { label: '服务业' }, { label: '消费品/零售' }, { label: '房地产/建筑' },
    { label: '教育培训' }, { label: '广告/传媒' }, { label: '制造业' },
    { label: '专业服务' }, { label: '制药/医疗' }, { label: '汽车' },
    { label: '交通/物流' }, { label: '能源/化工/环保' }, { label: '金融' },
    { label: '政府/非营利' },
  ],
  // 工作区域是所选城市下面的行政区，只能运行时从页面上抓，内置只留「不限」
  businessDistrict: [{ code: '', label: '不限' }],
  jobType: [
    { code: '', label: '不限' }, { code: '1901', label: '全职' },
    { code: '1902', label: '兼职' }, { code: '1903', label: '实习' },
  ],
  hrActive: [
    { code: '', label: '不限' }, { code: '0', label: '只投在线' },
    { code: '1', label: '3日内活跃' }, { code: '2', label: '本周内活跃' },
    { code: '3', label: '本月内活跃' },
  ],
  welfare: [
    { code: '', label: '不限' }, { code: 'double', label: '周末双休' },
    { code: 'insurance', label: '五险一金' },
  ],
  salary: [
    { code: '', label: '不限' }, { code: '402', label: '3K以下' }, { code: '403', label: '3-5K' },
    { code: '404', label: '5-10K' }, { code: '405', label: '10-20K' },
    { code: '406', label: '20-50K' }, { code: '407', label: '50K以上' },
  ],
  experience: [
    // 「不限」(空 code = 不发这个筛选) 与 BOSS 的「经验不限」(102) 是一回事，
    // 只保留统一风格的「不限」，去掉重复的 102。
    { code: '', label: '不限' }, { code: '103', label: '在校生(实习)' },
    { code: '101', label: '应届生(校招)' },
    { code: '104', label: '1年以内' }, { code: '105', label: '1-3年' },
    { code: '106', label: '3-5年' }, { code: '107', label: '5-10年' },
    { code: '108', label: '10年以上' },
  ],
  degree: [
    { code: '', label: '不限' }, { code: '209', label: '初中及以下' },
    { code: '208', label: '中专/中技' }, { code: '206', label: '高中' },
    { code: '202', label: '大专' }, { code: '203', label: '本科' },
    { code: '204', label: '硕士' }, { code: '205', label: '博士' },
  ],
  scale: [
    { code: '', label: '不限' }, { code: '301', label: '0-20人' }, { code: '302', label: '20-99人' },
    { code: '303', label: '100-499人' }, { code: '304', label: '500-999人' },
    { code: '305', label: '1000-9999人' }, { code: '306', label: '10000人以上' },
  ],
  stage: [
    { code: '', label: '不限' }, { code: '801', label: '未融资' }, { code: '802', label: '天使轮' },
    { code: '803', label: 'A轮' }, { code: '804', label: 'B轮' }, { code: '805', label: 'C轮' },
    { code: '806', label: 'D轮及以上' }, { code: '807', label: '已上市' },
    { code: '808', label: '不需要融资' },
  ],
};

const FILTER_SECTIONS = [
  { key: 'industry', label: '公司行业', searchable: true },
  { key: 'businessDistrict', label: '工作区域' },
  { key: 'jobType', label: '工作性质' },
  { key: 'hrActive', label: 'HR 活跃度' },
  { key: 'welfare', label: '福利待遇' },
  { key: 'salary', label: '薪资待遇' },
  { key: 'experience', label: '工作经验' },
  { key: 'degree', label: '学历要求' },
  { key: 'scale', label: '公司规模' },
  { key: 'stage', label: '融资阶段' },
];

// ════════════════════════════════════════════════════════════
// 屏幕切换
// ════════════════════════════════════════════════════════════

function showScreen(name) {
  S.screen = name;
  for (const s of ['config', 'result', 'greeting', 'send']) {
    $(`screen-${s}`).classList.toggle('on', s === name);
  }
  $('btn-back').hidden = name === 'config';
  $('btn-forward').hidden = !forwardTarget();   // 有「下一页」可去才显示 →
  // 离开投递屏时收掉「投递中」的底部计数条，别残留到别的页面
  if (name !== 'send') { $('action-count').hidden = true; $('btn-reset').hidden = false; }
  if (name === 'config') renderResumeBar();
  window.scrollTo(0, 0);
  updateAction();
}

/** 「下一页」要去哪：条件页有结果→回结果页；投递中在结果页→跳投递进度。没有就返回 null（→ 隐藏）。*/
function forwardTarget() {
  if (S.screen === 'config' && (S.hasResult || S.busy)) return 'result';
  if (S.screen === 'result' && S.sending) return 'send';
  return null;
}
$('btn-forward').addEventListener('click', () => {
  const t = forwardTarget();
  if (t) showScreen(t);
});

/** 条件页顶部「返回结果」入口：有结果就显示，点了切回结果页（不丢答案）*/
function renderResumeBar() {
  const bar = $('resume-bar');
  if (!bar) return;
  const n = (S.jobs || []).length;
  // 只要搜索正在跑、或跑过且没被重置，就给一个回结果页的入口——
  // 哪怕收到 0 个（停止/空结果），用户也要能切回去看进度页/漏斗，而不是被困在条件页。
  if (S.busy || S.hasResult) {
    const label = S.busy ? '搜索进行中' : '上次搜索结果';
    const count = S.busy ? '' : ` · ${n} 个岗位`;
    bar.innerHTML = `<span>${label}${count}</span><span class="arrow">查看 →</span>`;
    bar.hidden = false;
    bar.onclick = () => showScreen('result');
  } else {
    bar.hidden = true;
  }
}

// 逐屏往回退，不要一脚踢回最开头：从招呼语退回去应该看到岗位列表，
// 用户多半是想改勾选，而不是重新设条件
const BACK_TO = { result: 'config', greeting: 'result', send: 'greeting' };
$('btn-back').addEventListener('click', () => showScreen(BACK_TO[S.screen] || 'config'));

// ════════════════════════════════════════════════════════════
// 通用小部件
// ════════════════════════════════════════════════════════════

function makePill(label, on, onClick, { multi = false, dashed = false } = {}) {
  const el = document.createElement('span');
  el.className = 'pill' + (multi ? ' multi' : '') + (dashed ? ' dashed' : '') + (on ? ' on' : '');
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function renderChips(boxId, wrapId, items, labelOf, onRemove) {
  const box = $(boxId);
  box.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('span');
    el.className = 'chip';
    el.innerHTML = `${esc(labelOf(it))}<span class="x">×</span>`;
    el.querySelector('.x').addEventListener('click', () => onRemove(it));
    box.appendChild(el);
  }
  $(wrapId).hidden = items.length === 0;
}

document.querySelectorAll('[data-clear]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.clear);
    input.value = '';
    input.dispatchEvent(new Event('input'));
  });
});

// ════════════════════════════════════════════════════════════
// 简历（OCR 在后台静默跑，不拦用户）
// ════════════════════════════════════════════════════════════

// 简历上传区在配置页和结果页各有一个（uploads / uploads-2），两个都渲染
function renderUploads() {
  for (const boxId of ['uploads', 'uploads-2']) {
    const box = $(boxId);
    if (!box) continue;
    box.innerHTML = '';

    S.resumeImages.forEach((img, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<img src="${img.dataUrl}"><span class="del">×</span>`;
      el.querySelector('.del').addEventListener('click', (e) => {
        e.stopPropagation();
        S.resumeImages.splice(i, 1);
        saveResume();
      });
      box.appendChild(el);
    });

    if (S.resumeImages.length < CONFIG.RESUME_IMAGE_MAX) {
      const add = document.createElement('div');
      add.className = 'slot';
      add.textContent = '+';
      add.addEventListener('click', () => $('file-input').click());
      box.appendChild(add);
    }
  }
}

$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    if (S.resumeImages.length >= CONFIG.RESUME_IMAGE_MAX) break;
    S.resumeImages.push({ name: f.name, dataUrl: await fileToDataUrl(f) });
  }
  saveResume();
});

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/**
 * 存图并在后台识别。
 * 刻意不 await、不禁用任何按钮：识别是我们的事，用户传完图就该能继续往下选。
 * 识别结果要到生成打招呼语那一步才真正需要，那时候早跑完了。
 */
function saveResume() {
  renderUploads();

  if (!S.resumeImages.length) {
    S.resumeText = '';
    ask(MSG.SAVE_RESUME_IMAGES, { images: [] }).catch(() => {});
    return;
  }

  $set('ocr-status', '正在读取简历…');

  ask(MSG.SAVE_RESUME_IMAGES, { images: S.resumeImages })
    .then((r) => {
      S.resumeText = r.text || '';
      $set('ocr-status', `已读取 ${S.resumeText.length} 字`);
      if (S.resumeText.length < 200) {
        $set('ocr-status', ($('ocr-status')?.textContent || '') + '，内容偏少，建议换清晰完整的截图');
      }
      loadRecommendedPositions();
    })
    .catch((e) => { $set('ocr-status', `读取失败：${e.message}`); });
}

// ════════════════════════════════════════════════════════════
// 目标公司
// ════════════════════════════════════════════════════════════

function renderCompanies(q = '') {
  const box = $('company-groups');
  box.innerHTML = '';
  const kw = q.trim().toLowerCase();
  S.companyGroupCollapsed = S.companyGroupCollapsed || new Set();

  for (const g of COMPANY_GROUPS) {
    const items = COMPANY_LIB.filter((c) => c.g === g).filter((c) => !kw
      || c.n.toLowerCase().includes(kw) || c.a.some((a) => a.toLowerCase().includes(kw)));
    if (!items.length) continue;

    // 搜索时强制展开（方便看到命中）；否则按收起状态
    const collapsed = !kw && S.companyGroupCollapsed.has(g);
    const selN = items.filter((c) => S.companies.some((x) => x.name === c.n)).length;

    const label = document.createElement('div');
    label.className = 'sub-label group-foldable';
    label.innerHTML = `<span class="fold-arrow">${collapsed ? '▸' : '▾'}</span>${esc(g)}`
      + `<span class="cat">${items.length}</span>`
      + (selN ? `<span class="cat sel">已选 ${selN}</span>` : '');
    label.addEventListener('click', () => {
      if (S.companyGroupCollapsed.has(g)) S.companyGroupCollapsed.delete(g);
      else S.companyGroupCollapsed.add(g);
      renderCompanies($('company-search').value);
    });
    box.appendChild(label);
    if (collapsed) continue;   // 收起就不渲染这组的胶囊

    const row = document.createElement('div');
    row.className = 'pills';
    for (const c of items) {
      row.appendChild(makePill(c.n, S.companies.some((x) => x.name === c.n), () => {
        const i = S.companies.findIndex((x) => x.name === c.n);
        if (i >= 0) S.companies.splice(i, 1);
        else S.companies.push({ name: c.n, aliases: c.a });
        renderCompanies($('company-search').value);
        renderCompanyChips();
        saveConfig();
      }, { multi: true }));
    }
    box.appendChild(row);
  }
}

function renderCompanyChips() {
  renderChips('company-selected', 'company-picked', S.companies, (c) => c.name, (c) => {
    S.companies = S.companies.filter((x) => x.name !== c.name);
    renderCompanyChips();
    renderCompanies($('company-search').value);
    saveConfig();
  });
  updateAction();
}

$('company-search').addEventListener('input', (e) => renderCompanies(e.target.value));

// ════════════════════════════════════════════════════════════
// 目标城市
// ════════════════════════════════════════════════════════════

function toggleCity(c) {
  const i = S.cities.findIndex((x) => x.code === c.code);
  if (i >= 0) S.cities.splice(i, 1);
  else S.cities.push(c);
  renderCityQuick();
  renderCityChips();
  saveConfig();
}

function renderCityQuick(searchHits) {
  const box = $('city-quick');
  box.innerHTML = '';
  const list = searchHits || (S.cityExpanded ? [...HOT_CITIES, ...MORE_CITIES] : HOT_CITIES);
  for (const c of list) {
    box.appendChild(makePill(c.label, S.cities.some((x) => x.code === c.code),
      () => toggleCity(c), { multi: true }));
  }
  $('btn-city-more').hidden = !!searchHits;
  $('btn-city-more').textContent = S.cityExpanded ? '收起' : '展开更多';
}

function renderCityChips() {
  renderChips('city-selected', 'city-picked', S.cities, (c) => c.label, (c) => toggleCity(c));
  updateAction();
}

$('btn-city-more').addEventListener('click', () => {
  S.cityExpanded = !S.cityExpanded;
  renderCityQuick();
});

$('city-search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  if (!q) { renderCityQuick(); return; }
  const pool = [...HOT_CITIES, ...MORE_CITIES, ...S.cityDict];
  const seen = new Set();
  const hits = pool.filter((c) => c.label.includes(q) && !seen.has(c.code) && seen.add(c.code)).slice(0, 18);
  renderCityQuick(hits);
});

// ════════════════════════════════════════════════════════════
// 期望职位（能点就不让打字）
// ════════════════════════════════════════════════════════════

/**
 * 把用户输入的岗位词语义归纳到 BOSS 的「职位类型」三级类目，返回要塞进
 * 搜索 position 参数的【叶子 code】（如 AI产品经理=110110、产品经理=110101）。
 *
 * ★ 关键：BOSS 的 position 筛选只认三级【叶子】code，不认二级分组 code
 *   （上次错用分组 code 1000160，BOSS 不识别 → 返回 0）。职位树核对自即投源码。
 *
 * 命中策略：对每个岗位词，在三级叶子里找匹配（精确 / 岗位词含叶子名 /
 * 叶子名含岗位词），命中后【扩展到该叶子所在的二级分组的全部叶子】——
 * 这样选「AI产品经理」会把整个「产品经理」家族（产品经理/产品专员/产品总监/
 * 数据产品经理…）都框进去，对齐用户「框选到产品品类」的意图，少漏同族岗位。
 */
function walkLeaves(tree) {
  // 返回 [{name, code, l2name, siblings:[{name,code}]}]
  const out = [];
  const cats = (tree && tree.categories) || [];
  for (const c of cats) {
    for (const l2 of (c.children || [])) {
      const sibs = (l2.children || []).map((x) => ({ name: x.name, code: String(x.code) }));
      for (const leaf of (l2.children || [])) {
        out.push({ name: leaf.name, code: String(leaf.code), l2name: l2.name, siblings: sibs });
      }
    }
  }
  return out;
}

function matchLeaf(p, leaves) {
  const lp = String(p || '').toLowerCase().trim();
  if (!lp) return null;
  // 1. 精确同名
  let hit = leaves.find((l) => l.name.toLowerCase() === lp);
  // 2. 岗位词 ⊇ 叶子名（AIGC产品经理 ⊇ 产品经理）：取被包含的最长叶子
  if (!hit) {
    let best = null; let bestLen = 0;
    for (const l of leaves) {
      const ln = l.name.toLowerCase();
      if (ln.length >= 2 && lp.includes(ln) && ln.length > bestLen) { bestLen = ln.length; best = l; }
    }
    hit = best;
  }
  // 3. 叶子名 ⊇ 岗位词：取包含岗位词的最短叶子
  if (!hit && lp.length >= 2) {
    let best = null; let bestLen = 999;
    for (const l of leaves) {
      const ln = l.name.toLowerCase();
      if (ln.includes(lp) && ln.length < bestLen) { bestLen = ln.length; best = l; }
    }
    hit = best;
  }
  return hit || null;
}

function derivePositionCodes(positions) {
  const tree = (typeof POSITION_TREE !== 'undefined') ? POSITION_TREE : null;
  if (!tree) return [];
  const leaves = walkLeaves(tree);
  const codes = new Set();
  for (const p of positions || []) {
    const hit = matchLeaf(p, leaves);
    if (hit) {
      // 扩展到该叶子所在二级分组的全部叶子 → 框住整个职能家族
      for (const s of hit.siblings) codes.add(s.code);
    }
  }
  return [...codes];
}

function derivePositionLabels(positions) {
  const tree = (typeof POSITION_TREE !== 'undefined') ? POSITION_TREE : null;
  if (!tree) return [];
  const leaves = walkLeaves(tree);
  const groups = new Set();
  for (const p of positions || []) {
    const hit = matchLeaf(p, leaves);
    if (hit) groups.add(hit.l2name);
  }
  return [...groups];
}

// ── 结果页精筛：把岗位词拆成子词（或门），在收到的结果里再筛一道 ──
// 拆法（对齐用户：AI产品经理 → AI产品 / 产品经理 / AI产品经理）：
//   全词 + 去掉尾部职能(得 AI产品) + 去掉头部修饰(得 产品经理)
const REFINE_HEAD = ['ai', 'aigc', 'agent', '大模型', '高级', '资深', '初级', 'c端', 'b端', '智能', '海外', '影视', '游戏'];
const REFINE_TAIL = ['经理', '专员', '助理', '总监', '专家', '负责人', '主管', '工程师', '架构师', '设计师', '顾问', '官', '师'];
function splitToSubterms(word) {
  const w = String(word || '').trim();
  if (!w) return [];
  const lw = w.toLowerCase();
  const out = new Set([w]);                         // 全词：AI产品经理
  // 识别头部修饰(AI) 和 尾部职能(经理)
  let head = '';
  for (const h of REFINE_HEAD) { if (lw.startsWith(h) && w.length > h.length) { head = w.slice(0, h.length); break; } }
  const body = head ? w.slice(head.length) : w;     // 去头主体：产品经理
  let tail = '', core = body;
  for (const t of REFINE_TAIL) { if (body.endsWith(t) && body.length > t.length) { tail = t; core = body.slice(0, body.length - t.length); break; } }
  if (head) out.add(body);                          // 去头：产品经理
  if (tail) out.add(head + core);                   // 保头去尾：AI产品
  if (head && tail.length >= 2) out.add(head + tail);  // 头+尾(去中间名词)：AI经理；单字尾(师/官)太泛不拆
  // 只保留 2 字以上、或英文的子词
  return [...out].filter((s) => s.length >= 2);
}
function genRefineTerms(positions) {
  const set = new Set();
  for (const p of positions || []) for (const s of splitToSubterms(p)) set.add(s);
  const terms = [...set].map((term) => ({ term, on: true }));
  // 追加「其他」桶：接住「不含任何子词」的岗位。默认【不点】→ 默认只显示命中子词的；
  // 「其他 N」带数量摆着，想查那些落空的是误判还是真不相关，点一下就显出来（不偷偷藏）。
  if (terms.length) terms.push({ term: '其他', on: false, other: true });
  return terms;
}

function togglePosition(p) {
  const i = S.positions.indexOf(p);
  if (i >= 0) S.positions.splice(i, 1);
  else S.positions.push(p);
  renderPositionResult($('position-search').value);
  renderPositionChips();
  saveConfig();
}

function renderPositionChips() {
  renderChips('position-selected', 'position-picked', S.positions, (p) => p, (p) => togglePosition(p));
  updateAction();
}

/**
 * 岗位区。无搜索词时铺「简历推荐 + 常用岗位」，有搜索词时按职类归组显示命中项。
 * 搜不到就给一个「添加自创词条」的虚线胶囊，仍然是点一下，不用回车。
 */
function renderPositionResult(q = '') {
  const box = $('position-result');
  box.innerHTML = '';
  const kw = q.trim();

  // 不搜就什么都不铺。
  // 之前默认外露了「简历推荐 + 产品岗位组」两大片胶囊，占掉整整一屏，
  // 把后面的筛选项全挤到看不见的地方。岗位靠搜索进入即可。
  if (!kw) return;

  // 命中项按职类归组，跟平台自己的呈现方式一致
  const lower = kw.toLowerCase();
  const groups = new Map();
  for (const it of POSITION_FLAT) {
    if (!it.name.toLowerCase().includes(lower)) continue;
    const key = `${it.sub}|${it.cat}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it.name);
  }

  const known = new Set(POSITION_FLAT.map((i) => i.name));
  const extra = S.positionDict.map((p) => p.label)
    .filter((n) => n.toLowerCase().includes(lower) && !known.has(n)).slice(0, 20);
  if (extra.length) groups.set('更多岗位|来自 BOSS', extra);

  for (const [key, items] of groups) {
    const [sub, cat] = key.split('|');
    box.appendChild(subLabel(sub, cat));
    const row = document.createElement('div');
    row.className = 'pills';
    for (const p of items) {
      row.appendChild(makePill(p, S.positions.includes(p), () => togglePosition(p), { multi: true }));
    }
    box.appendChild(row);
  }

  // 搜不到就让用户把原词直接加进去，仍然是点一下，不用回车
  const row = document.createElement('div');
  row.className = 'pills';
  row.style.marginTop = '14px';
  row.appendChild(makePill(`+ 添加自创词条「${kw}」`, false, () => {
    togglePosition(kw);
    $('position-search').value = '';
    renderPositionResult('');
  }, { dashed: true }));
  box.appendChild(row);
}

function subLabel(text, cat) {
  const el = document.createElement('div');
  el.className = 'sub-label';
  el.innerHTML = `${esc(text)}${cat ? `<span class="cat">${esc(cat)}</span>` : ''}`;
  return el;
}

$('position-search').addEventListener('input', (e) => renderPositionResult(e.target.value));

/** 让模型读简历推荐岗位词。结果按简历内容缓存，简历没变不重复调 */
async function loadRecommendedPositions() {
  if (!S.resumeText) return;
  try {
    const r = await ask(MSG.SUGGEST_POSITIONS);
    S.recommended = r.positions || [];
  } catch (e) { /* 推荐失败不影响手选，静默即可 */ }
}

// ════════════════════════════════════════════════════════════
// 其余筛选（全部平铺）
// ════════════════════════════════════════════════════════════

/**
 * 公司行业两级选择（对齐即投）。
 *
 * 一级铺在外面，点一个一级 → 下面展开它的卡片，卡片里是二级。
 * 卡片右上角勾选框 = 选中整个一级。二级可单独多选。
 * S.filters.industry 存的是选中的二级（或一级）名字，搜索时再转 BOSS 内部 code。
 */
function renderIndustry() {
  const sel = new Set(S.filters.industry || []);
  const sec = document.createElement('section');
  sec.className = 'sec';
  sec.innerHTML = '<h2>公司行业</h2>';

  const commit = () => { S.filters.industry = [...sel]; renderFilters(); saveConfig(); };

  // 一级行 + 「不限」
  const row = document.createElement('div');
  row.className = 'pills';
  row.appendChild(makePill('不限', sel.size === 0, () => { sel.clear(); S.industryOpen = ''; commit(); }, { multi: true }));
  for (const g of INDUSTRY_TREE) {
    const picked = g.items.some((it) => sel.has(it)) || sel.has(g.cat);
    const pill = makePill(g.cat, picked, () => {
      // 点一级：展开/收起它的二级卡片
      S.industryOpen = S.industryOpen === g.cat ? '' : g.cat;
      renderFilters();
    }, { multi: true });
    row.appendChild(pill);
  }
  sec.appendChild(row);

  // 展开的一级 → 二级卡片
  const open = INDUSTRY_TREE.find((g) => g.cat === S.industryOpen);
  if (open) {
    const allOn = open.items.every((it) => sel.has(it));
    const card = document.createElement('div');
    card.className = 'sub-card';
    const head = document.createElement('div');
    head.className = 'sub-card-head';
    head.innerHTML = `<b>${esc(open.cat)}</b><span class="sub-check${allOn ? ' on' : ''}">${allOn ? '✓' : ''}</span>`;
    head.querySelector('.sub-check').addEventListener('click', () => {
      if (allOn) open.items.forEach((it) => sel.delete(it));
      else open.items.forEach((it) => sel.add(it));
      commit();
    });
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'pills';
    for (const it of open.items) {
      body.appendChild(makePill(it, sel.has(it), () => {
        if (sel.has(it)) sel.delete(it); else sel.add(it);
        commit();
      }, { multi: true }));
    }
    card.appendChild(body);
    sec.appendChild(card);
  }

  // 选中的二级在卡片里直接高亮就代表选中了，下面不再另出一排 chip
  return sec;
}

function renderFilters() {
  const area = $('filter-area');
  area.innerHTML = '';
  let deadKeys = [];

  for (const f of FILTER_SECTIONS) {
    // 公司行业是两级：一级铺在外面，点开一级在下面卡片里展二级（对齐即投）
    if (f.key === 'industry') { area.appendChild(renderIndustry()); continue; }

    // 选项表以内置的为准（保证外露项和顺序稳定），
    // code 用运行时从 BOSS 页面抓到的真实值按 label 对齐覆盖。
    const scraped = (S.dict && S.dict[f.key]) || [];
    const byLabel = new Map(scraped.map((o) => [o.label, o.code]));

    // 第一项永远是「不限」，它的空 code 代表「没有选择」。
    // 其余项如果拿不到真实 code，绝不能也用空串——那样会和「不限」的空串
    // 撞上，导致每一项都被判成选中、整排变橙。给它们一个不会与任何真实值
    // 相等的占位 code，既不高亮，点了也不会误改筛选状态。
    const options = (OPT[f.key] || []).map((o, i) => {
      let code = o.code !== undefined ? o.code : byLabel.get(o.label);
      if (code === undefined || code === '') code = i === 0 ? '' : `__unresolved_${f.key}_${i}`;
      return { label: o.label, code, unresolved: String(code).startsWith('__unresolved') };
    });
    // 只有工作区域需要用页面上抓到的动态选项补全（各城市的行政区不一样）。
    // 其余维度以内置表为准，不再合并抓取到的项——否则会冒出
    // 「应届生」和「应届生(校招)」这种重复选项。
    if (f.key === 'businessDistrict') {
      for (const o of scraped) {
        if (!options.some((x) => x.label === o.label)) options.push({ label: o.label, code: o.code });
      }
    }
    if (!options.length) continue;

    const sel = new Set(S.filters[f.key] || []);   // 多选，存成数组
    // 除「不限」外一个真实 code 都没有，说明这一项点了也筛不动
    if (options.length > 1 && !options.some((o) => o.code && !o.unresolved)) deadKeys.push(f.label);

    const sec = document.createElement('section');
    sec.className = 'sec';
    sec.innerHTML = `<h2>${esc(f.label)}</h2>`;

    if (f.searchable) {
      const sw = document.createElement('div');
      sw.className = 'search';
      sw.innerHTML = '<input type="text" placeholder="搜索行业…">';
      sec.appendChild(sw);
      sw.querySelector('input').addEventListener('input', (e) => {
        const kw = e.target.value.trim();
        sec.querySelectorAll('.pill').forEach((p) => {
          p.hidden = !!kw && p.textContent !== '不限' && !p.textContent.includes(kw);
        });
      });
    }

    const row = document.createElement('div');
    row.className = 'pills';
    for (const o of options) {
      const isUnlimited = o.code === '';
      const on = isUnlimited ? sel.size === 0 : sel.has(o.code);
      row.appendChild(makePill(o.label, on, () => {
        if (isUnlimited) {
          sel.clear();                       // 点「不限」清空整组
        } else if (sel.has(o.code)) {
          sel.delete(o.code);
        } else {
          sel.add(o.code);
        }
        S.filters[f.key] = [...sel];
        renderFilters();
        saveConfig();
      }, { multi: true }));
    }
    sec.appendChild(row);

    // 双休没有结构化字段，只能看岗位标题写没写，会误杀大量实际双休的岗位。
    // 这个代价必须在用户选中的当下说清楚。
    if (f.key === 'welfare' && (S.filters.welfare || []).includes('double')) {
      const w = document.createElement('div');
      w.className = 'warn';
      w.innerHTML = '⚠ <b>可投岗位会大幅减少。</b>双休依据岗位标题是否写明判断，大量实际双休但没写的岗位会被过滤掉。';
      sec.appendChild(w);
    }
    area.appendChild(sec);
  }


  if (deadKeys.length) {
    const sec = document.createElement('section');
    sec.className = 'sec';
    const n = document.createElement('div');
    n.className = 'warn';
    n.innerHTML = `⚠ ${esc(deadKeys.join('、'))} 没能从 BOSS 页面读到真实编码，点了不会生效。`
      + '打开 BOSS 岗位搜索页后，从右上角「⋯」点「重新读取 BOSS 筛选项」。';
    sec.appendChild(n);
    area.appendChild(sec);
  }
}

async function loadDict(force = false) {
  try {
    const r = await ask(MSG.GET_FILTER_DICT, { force });
    S.dict = r.dict;
    S.dictSources = r.sources;
    S.cityDict = r.cities || [];
    S.positionDict = r.positions || [];
    renderFilters();
    if (!$('position-search').value) renderPositionResult('');
    if (force) toast('筛选项已更新');
  } catch (e) {
    renderFilters();
    toast(`读不到 BOSS 筛选项：${e.message}`, 5000);
  }
}

function saveConfig() {
  chrome.storage.local.set({
    [STORE.UI.FILTER_STATE]: {
      searchMode: S.searchMode,
      companies: S.companies, cities: S.cities,
      positions: S.positions, filters: S.filters,
    },
  });
}

// ── 投递模式切换：海投(按岗位) / 精投(按公司) ──
function renderMode() {
  document.querySelectorAll('#search-mode .pill').forEach((p) => {
    p.classList.toggle('on', p.dataset.mode === S.searchMode);
  });
  // 目标公司只在精投(company)下出现——海投是广搜+软筛，锁公司能力弱，
  // 留着反而让人误以为能精准锁公司，所以海投直接隐藏整个模块。
  const isCompany = S.searchMode === 'company';
  $('sec-company').hidden = !isCompany;
  // 换位营造切换感：精投把「目标公司」提到最上面，海投只有城市/职位
  const anchor = $('filter-area');
  const parent = anchor.parentNode;
  const order = isCompany
    ? ['sec-company', 'sec-position', 'sec-city']
    : ['sec-city', 'sec-position', 'sec-company'];
  for (const id of order) parent.insertBefore($(id), anchor);
  updateAction();
}
document.querySelectorAll('#search-mode .pill').forEach((p) => {
  p.addEventListener('click', () => {
    S.searchMode = p.dataset.mode;
    renderMode();
    saveConfig();
  });
});

// ════════════════════════════════════════════════════════════
// 底部操作条
// ════════════════════════════════════════════════════════════

// ── 精投耗时预估 ──
// 一个「公司×词」是一个单位。单位内翻 8~10 页、每页 4~8 秒 + 固定开销。
// 单元数 = 公司数 × max(词数,1)。总时长按单元算，供开搜前预告 + 搜索中倒推。
// 按「全局冷却队列」模型估时：翻页是全局串行的(每次翻页前过一个随机冷却闸)，
// 所以总翻页耗时 = 总翻页数 × 冷却均值，【不除以并行数】。第 1 页不占冷却。
// brandId 解析是每家串行的固定开销。翻页数用现实区间(非硬上限 15)，免得吓人。
const EST = {
  perCompanyOverheadSec: 12,   // 每家 brandId 解析 + 开页搜词的固定开销
  estPagesMin: 3,              // 预估每「公司×词」翻几页（现实区间）
  estPagesMax: 10,
};
function estimateUnits() {
  const companies = S.companies.length;
  const words = Math.max(S.positions.length, 1);
  return companies * words;
}
function estimateRangeSec() {
  const companies = S.companies.length;
  const units = estimateUnits();
  if (!units) return null;
  const cdAvg = ((CONFIG.COOLDOWN_MIN_MS + CONFIG.COOLDOWN_MAX_MS) / 2) / 1000;   // 冷却均值(秒)
  const overhead = companies * EST.perCompanyOverheadSec;
  const min = overhead + units * Math.max(0, EST.estPagesMin - 1) * cdAvg;
  const max = overhead + units * Math.max(0, EST.estPagesMax - 1) * cdAvg;
  return { min, max };
}
function fmtMin(sec) {
  const m = sec / 60;
  if (m < 1) return `${Math.ceil(sec)} 秒`;
  return `${Math.round(m)} 分钟`;
}
/** 条件页：开始搜索按钮旁的「预计 X~Y 分钟」，只精投显示 */
function renderEtaHint() {
  const hint = $('eta-hint');
  const row = document.querySelector('.action-row');
  if (!hint || !row) return;
  if (S.screen === 'config' && S.searchMode === 'company' && estimateUnits() > 0) {
    const r = estimateRangeSec();
    const mid = (r.min + r.max) / 2;   // 中间值，不显示区间
    hint.textContent = `预计 ${fmtMin(mid)}`;
    hint.hidden = false;
    row.classList.add('has-eta');
  } else {
    hint.hidden = true;
    row.classList.remove('has-eta');
  }
}

function updateAction() {
  const btn = $('btn-action');
  const reset = $('btn-reset');
  if (S.busy || S.sending) return;   // 投递进行中/暂停中由 enterSendingBar 管按钮

  reset.hidden = false;
  renderEtaHint();

  if (S.screen === 'config') {
    // 广撒网必须有岗位词；锁定公司必须有公司
    const ready = S.searchMode === 'company'
      ? S.companies.length > 0
      : S.positions.length > 0;
    btn.textContent = '开始搜索';
    btn.disabled = !ready;
    return;
  }

  if (S.screen === 'result') {
    // 自定义模式，或 AI 已经生成完 → 直接投递；否则先生成。
    const n = S.selected.size;
    if (S.greetMode === 'custom' || S.greeted) {
      btn.textContent = n ? `一键投递（${n}）` : '一键投递';
    } else {
      btn.textContent = n ? `生成打招呼语（${n}）` : '生成打招呼语';
    }
    btn.disabled = n === 0;
    return;
  }

  if (S.screen === 'greeting') {
    btn.textContent = `投递这 ${S.selected.size} 个岗位`;
    btn.disabled = S.selected.size === 0 || !S.greeted;
    return;
  }

  if (S.screen === 'send') {
    btn.textContent = '完成';
    btn.disabled = S.busy;
    reset.textContent = '重置';   // 投递完成页：重置 = 清空一切重来
  }
}

$('btn-reset').addEventListener('click', () => {
  // 按钮写「停止」时（搜索进行中）：只停止，不清结果、不跳屏。
  if ($('btn-reset').textContent === '停止') { stopSearch(); return; }
  // 投递完成后的「重置」= 彻底清空（连筛选条件一起），从空白开始。
  if (S.screen === 'send') { fullReset(); return; }
  if (S.screen !== 'config') { showScreen('config'); return; }
  fullReset();
});

/**
 * 点「停止」：真停止后台任务，并立刻把界面切到「已停止」——不等后台卸载。
 *
 * 后台 worker 常卡在翻页间隔/等页面里，收到停止不会立刻醒，终态广播要十几二十秒
 * 后才来。所以这里乐观更新：点击那一刻就停住进度、换回「重置」，并打上 searchStopped
 * 标记，忽略后面迟到的进度广播（否则界面会被又翻回「正在搜索」）。已落库的半成品
 * 用 loadResults 显示出来，后台真正收尾（done）时再补刷一次。
 */
function stopSearch() {
  ask(MSG.STOP_TASK).catch(() => {});   // 发令即走，不阻塞界面
  S.busy = false;
  S.searchStopped = true;
  S.hasResult = true;                   // 保住「回结果页」入口，哪怕收到 0 个
  $('search-phase').textContent = '已停止';
  $('btn-reset').textContent = '重置';
  $('btn-action').disabled = false;
  updateAction();
  loadResults().catch(() => {});        // 把已收到的岗位显示出来（可能为空，正常）
  toast('已停止');
}

/** 清空一切：条件 + 岗位词 + 城市 + 结果，回到空白条件页 */
function fullReset() {
  S.companies = []; S.positions = []; S.cities = [];
  S.filters = { hrActive: '1' };
  S.jobs = []; S.selected = new Set(); S.greeted = false; S.taskId = null;
  S.busy = false; S.sending = false; S.sendPaused = false; S.searchStopped = false; S.hasResult = false;
  $('send-banner').hidden = true; exitSendingBar();
  $('search-progress').hidden = true;
  $('funnel').hidden = true;
  $('job-list').innerHTML = '';
  renderCompanies(); renderCompanyChips();
  renderCityQuick(); renderCityChips();
  renderPositionResult(''); renderPositionChips();
  renderFilters();
  saveConfig();
  showScreen('config');
  updateAction();
  toast('已重置');
}

$('btn-action').addEventListener('click', () => {
  // 投递进行中：按钮是「停止发送 / 继续发送」，优先于按屏幕路由
  if (S.sending) return S.sendPaused ? resumeSending() : pauseSending();
  if (S.screen === 'config') return runSearch();
  if (S.screen === 'result') {
    if (S.greeted) return runSend();                        // AI 已生成 → 投递
    if (S.greetMode === 'custom') return runSendFromResult(); // 自定义 → 落文案后投递
    return runGreeting();                                    // AI → 就地生成
  }
  if (S.screen === 'greeting') return runSend();
  // 投递完成屏：点「完成」收尾
  if (S.screen === 'send') return finishBatch();
});

/**
 * 投递完成后点「完成」：这批收工，回到搜索条件页，保留筛选条件（城市/岗位词），
 * 清掉这批的岗位和勾选，方便直接再搜下一批。
 */
function finishBatch() {
  S.busy = false;
  S.sending = false;
  S.sendPaused = false;
  S.hasResult = false;
  S.jobs = [];
  S.selected = new Set();
  S.greeted = false;
  S.taskId = null;
  $('search-progress').hidden = true;
  $('funnel').hidden = true;
  $('job-list').innerHTML = '';
  showScreen('config');
  updateAction();
  toast('这批投完啦，条件已保留，可以接着搜下一批');
}

/**
 * 结果页自定义模式：先把选中岗位的招呼语落好（全局自定义 / 单岗位自定义），
 * 再直接进投递。省掉 AI 生成那一屏。
 */
async function runSendFromResult() {
  if (!S.globalGreet && Object.keys(S.jobGreet || {}).length === 0) {
    toast('自定义模式下，请先在上面填一条招呼语', 4000);
    return;
  }
  S.busy = true;
  $('btn-action').disabled = true;
  $('btn-action').textContent = '准备中…';
  try {
    // 用自定义模式跑一遍生成（不调 AI，只是把文案落进每个岗位），完成后自动进投递
    await ask(MSG.START_GREETING, {
      jobIds: [...S.selected],
      mode: 'custom',
      globalGreet: S.globalGreet || '',
      jobGreet: S.jobGreet || {},
    });
    S.pendingSendAfterGreet = true;   // 生成完成广播里接着投递
  } catch (e) {
    S.busy = false;
    toast(e.message, 5000);
    updateAction();
  }
}

// ════════════════════════════════════════════════════════════
// 搜索
// ════════════════════════════════════════════════════════════

const PHASE_TEXT = {
  starting: '准备中', opening_tab: '正在打开 BOSS 页面',
  collecting: '正在搜索岗位', deduping: '正在整理去重',
  fetching_jd: '正在读岗位详情',
  fetching_jd: '正在读岗位详情',
  greeting: '正在为每个岗位写打招呼语',
  greeting_done: '打招呼语已生成',
  greeting_error: '生成中断',
  sending: '正在投递',
  send_done: '投递完成',
  done: '搜索完成', aborted: '已停止', error: '出错了',
};

const STOP_REASON = {
  exhausted: '已翻到页数上限', empty_page: '平台没有更多结果',
  no_new_items: '后面没有新岗位了', has_more_false: '已经到底',
  target_reached: '已经搜够，没再往下翻',
  no_template: '读不到 BOSS 的岗位列表，请确认已登录',
  soft_block_37: '搜太快被平台限流，已停下，歇几分钟再试',
  aborted: '手动停止', network_error: '网络出错',
  dom_fallback: '接口没返回数据，改从页面上直接读取',
};

async function runSearch() {
  S.busy = true;
  S.searchStopped = false;   // 新一轮搜索，清掉上一轮的停止标记
  S.hasResult = false;       // 新一轮，旧结果入口先撤
  showScreen('result');
  $('search-progress').hidden = false;
  $('funnel').hidden = true;
  $('job-list').innerHTML = '';
  $('result-body').hidden = true;
  $('search-empty').hidden = true;
  $('btn-action').disabled = true;
  $('btn-action').textContent = '搜索中…';
  $('btn-reset').textContent = '停止';

  try {
    // 行业存的是二级名字，发给后台前转成 BOSS 内部 code。
    // 抓不到 code 的名字直接丢（deadKey 警示已经提示过用户）。
    const byLabel = new Map(((S.dict && S.dict.industry) || []).map((o) => [o.label, o.code]));
    const industryCodes = (S.filters.industry || [])
      .map((name) => byLabel.get(name)).filter(Boolean);
    const filters = { ...S.filters, industry: industryCodes };

    // ★ 把岗位词语义归纳到 BOSS 职位类型的【三级叶子 code】，塞进 position 参数，
    //   让 BOSS 服务端只返回对应职能家族的岗位，从源头挡掉模糊匹配的杂项。
    //   分两层：① 确定性字符串匹配（秒出，覆盖带家族字的规范词）；
    //          ② 匹配不上的怪词（PM/增长黑客/英文…）交给 LLM 语义归类兜底。
    const codeSet = new Set(derivePositionCodes(S.positions));
    const unmatched = (S.positions || []).filter((p) => !matchLeaf(p, walkLeaves(POSITION_TREE)));
    if (unmatched.length) {
      try {
        const r = await ask(MSG.CLASSIFY_POSITIONS, { keywords: unmatched });
        for (const codes of Object.values(r.map || {})) for (const c of codes) codeSet.add(String(c));
        console.log('[闪投] LLM 兜底归类:', r.map);
      } catch (e) { console.log('[闪投] LLM 归类跳过:', e.message); }
    }
    const posCodes = [...codeSet];
    if (posCodes.length) {
      filters.position = posCodes;
      console.log('[闪投] 岗位词归类到 BOSS 职位类型 → code', posCodes);
    }

    // 海投不按公司过滤（公司模块已隐藏），只有精投才带公司
    const sendCompanies = S.searchMode === 'company' ? S.companies : [];
    // 发令即返回：整轮召回在后台烧几分钟，这里不能 await 整轮（通道撑不住会被
    // 判「channel closed」误报出错）。收尾（loadResults + 复位按钮）交给
    // TASK_PROGRESS 的 'done' 广播在 onMessage 里做。
    await ask(MSG.START_RECALL, {
      searchMode: S.searchMode,
      companies: sendCompanies,
      companyAliases: sendCompanies.flatMap((c) => c.aliases),
      positions: S.positions,
      cities: S.cities.map((c) => c.code),
      cityNames: S.cities.map((c) => c.name).filter(Boolean),   // 精投本地按城市名筛用
      filters,
    });
    // 这里保持 busy=true、按钮停在「停止」，直到 'done'/'error'/'aborted' 广播
  } catch (e) {
    // 只有「发令」本身失败才到这（通道瞬时错误等），整轮跑不到这
    $('search-phase').textContent = `出错了：${e.message}`;
    toast(e.message, 5000);
    S.busy = false;
    $('btn-reset').textContent = '重置';
    updateAction();
  }
}

function renderSearchProgress(task) {
  $('search-progress').hidden = false;
  $('search-phase').textContent = PHASE_TEXT[task.phase] || task.phase;
  const p = task.progress || {};

  // 精投：按「已完成单元 + 当前单元页进度/单元总单元」给百分比，跟着翻页平滑推进
  if (p.unitTotal && task.phase !== 'done') {
    const subFrac = Math.min(1, (p.domPage || 0) / (p.domMaxPages || CONFIG.COMPANY_PAGES_MAX || 15));
    const doneFrac = ((p.unitDone || 0) + subFrac) / p.unitTotal;
    const pct = Math.min(99, Math.max(1, Math.round(doneFrac * 100)));
    const unitsLeft = Math.max(0, p.unitTotal - (p.unitDone || 0) - subFrac);
    // 每单元剩余耗时≈中位页数×冷却均值（同 estimateRangeSec 的模型）
    const cdAvg = ((CONFIG.COOLDOWN_MIN_MS + CONFIG.COOLDOWN_MAX_MS) / 2) / 1000;
    const midUnitSec = ((EST.estPagesMin + EST.estPagesMax) / 2 - 1) * cdAvg;
    const remainSec = unitsLeft * midUnitSec;
    $('search-fill').style.width = `${pct}%`;
    $('search-detail').textContent =
      `${pct}% · 已完成 ${p.unitDone || 0}/${p.unitTotal} · 约还需 ${fmtMin(remainSec)} · 已收 ${p.collected || 0} 个`;
  } else if (p.rounds) {
    $('search-fill').style.width = `${task.phase === 'done' ? 100 : ((p.round || 0) / p.rounds) * 100}%`;
    // 只留一行干净的进度，不提限流、不堆细节
    $('search-detail').textContent = task.phase === 'done'
      ? '' : `已找到 ${p.collected || 0} 个`;
  }
  if (task.phase === 'error') $('search-phase').textContent = `出错了：${task.error}`;
  if (task.phase === 'done') {
    $('search-fill').style.width = '100%';
    // 不再显示灰色小字（数量+限流提示），漏斗里已经有完整数据
    $('search-detail').textContent = '';
    renderFunnel(task);
  }
}

/**
 * 把过滤漏斗摊开给用户看。
 * 「没搜到，放宽条件再试」这种提示等于什么都没说：到底是平台没结果、
 * 被公司名单滤光了、还是岗位词太窄，三种原因对应三种完全不同的处理。
 */
const STOP_TXT = {
  cs_not_ready: '页面没能就绪（可能未登录 BOSS，或页面还没加载完）',
  no_template: '没抓到岗位列表请求',
  soft_block_37: '今天搜太多次被平台限流了，歇 5–10 分钟再搜（不是 bug）',
  empty_page: '平台没有更多结果',
  exhausted: '已到底',
  off_topic: '后面都是平台推荐的无关岗位，已停',
  company_empty: '这家公司主页没搜到匹配岗位（精投只认这家，不全网搜）',
};

function renderFunnel(task) {
  const f = task.funnel;
  if (!f) return;
  const rows = [`搜到 <b>${f.raw}</b> 个`];

  // 精投：把每家公司的「公司主页直采」诊断摊开，一眼看出卡在哪一步
  if (f.companyDiag && f.companyDiag.length) {
    const STOP = {
      no_template_company: '没抓到公司主页接口', empty_page: '接口返回空',
      off_topic: '翻到无关区停', exhausted: '已到底', has_more_false: '已到底',
      no_new_items: '无新增停', soft_block_37: '被限流',
    };
    for (const d of f.companyDiag) {
      if (d.step) { rows.push(`<span class="cut">${esc(d.company)}：${esc(d.step)}</span>`); continue; }
      const why = STOP[d.stop] || d.stop || '';
      const kw = d.keyword ? `·${esc(d.keyword)}` : '';
      const api = d.api ? `　[${esc(d.api)}]` : '';
      rows.push(`${esc(d.company)}${kw} <b>${d.got || 0}</b> 个${why ? `（${esc(why)}）` : ''}${api}`);
    }
  }

  // 搜到 0 时把诊断全摊开：停止原因 + 每个城市各采到多少
  if (f.raw === 0) {
    rows.push(`<span class="cut">${STOP_TXT[f.lastStop] || ('停止原因：' + (f.lastStop || '未知'))}</span>`);
    if (f.perCity) {
      const detail = Object.entries(f.perCity).map(([c, n]) => `${c || '未选城市'}:${n}`).join(' ');
      if (detail) rows.push(`各城：${detail}`);
    }
  }
  if (f.afterPosition != null && f.afterPosition < f.raw) {
    // 文案随模式变：
    //  海投=用岗位词搜，被剔的是 BOSS 模糊匹配带回的杂项；
    //  精投=用公司名搜(拉回公司全部岗位)，被剔的是这家公司的其他岗位(非你要的岗位)。
    const label = S.searchMode === 'company'
      ? (S.positions.length ? '公司里的其他岗位（非你要的）' : '岗位名不匹配')
      : '剔除 BOSS 带回的杂项（运营/工程师/销售等）';
    rows.push(`${label} <span class="cut">-${f.raw - f.afterPosition}</span>`);
    if (f.killedSample && f.killedSample.length) {
      rows.push(`<span class="cut">例如：${f.killedSample.slice(0, 6).map(esc).join('、')}…</span>`);
    }
  }
  if (f.cityCutSkipped) {
    rows.push(`<span class="cut">所选城市没匹配到，已给出全部城市结果</span>`);
  }
  if (f.cityCut != null && f.cityCut > 0) {
    rows.push(`非目标城市 <span class="cut">-${f.cityCut}</span>`);
  }
  if (f.companyCut != null && f.companyCut > 0) {
    rows.push(`非目标公司 <span class="cut">-${f.companyCut}</span>`);
    if (f.companyCutSample && f.companyCutSample.length) {
      rows.push(`<span class="cut">例如：${f.companyCutSample.slice(0, 6).map(esc).join('、')}${f.companyCut > 6 ? '…' : ''}</span>`);
    }
  }
  if (f.dupSent) rows.push(`之前已经聊过 <span class="cut">-${f.dupSent}</span>`);
  if (f.dupFp) rows.push(`重复挂牌 <span class="cut">-${f.dupFp}</span>`);
  if (f.dupSent || f.dupFp || f.companyCut || f.cityCut || (f.afterPosition < f.raw)) {
    rows.push(`剩下 <b>${f.afterDedup ?? f.afterCompany ?? f.afterPosition ?? f.raw}</b> 个`);
  }

  $('funnel').innerHTML = rows.join(' · ');
  $('funnel').hidden = false;
}

async function loadResults() {
  // 按 taskId 查而不是按 state：岗位状态会随流程推进变化（recalled → greeted → sent），
  // 按单一 state 查会漏
  const r = await ask(MSG.QUERY_JOBS, { taskId: S.taskId, limit: CONFIG.REVIEW_POOL_SIZE });
  S.jobs = r.jobs || [];
  // 精筛子词：从这次搜的岗位词拆出来，默认全部点亮
  S.refineTerms = genRefineTerms(S.positions);
  // 默认全选当前可见(精筛后)的岗位
  renderUploads();   // 结果页顶部也放简历，跟即投一致
  renderRefineBar();
  S.selected = new Set(visibleJobs().map((j) => j.jobId));
  renderJobs();
  $('result-body').hidden = S.jobs.length === 0;
  $('search-empty').hidden = S.jobs.length > 0;
  if (!S.jobs.length) {
    $('search-empty').textContent = '这一轮没有符合条件的岗位。换个关键词或放宽筛选再试。';
  }
}

/**
 * 岗位卡，样式对齐即投：
 * 勾选框 + 岗位名（粗）+ 公司名（灰）+ 薪资（橙）+ 标签（灰胶囊）
 * + 单岗位自定义招呼语（可折叠的输入框）。
 */
/**
 * 把一个岗位归到用户选的哪个岗位词下。跟后端过滤用同一套「核心词」逻辑，
 * 保证「过滤留下来的岗位一定能归进某个组」。
 *
 *   优先：岗位名完整包含某个岗位词（如岗位名含「ai产品经理」→ AI产品经理组）
 *   其次：岗位名包含某个岗位词的核心词（AI训练师 核心词=训练师）
 *   都不满足：其他
 */
// 跟后端 tokensOfPosition 保持一致：把关键词按 / 、,，空格 拆成多个 token
const GROUP_GENERIC = new Set(['ai', 'aigc', 'agent', '智能', '数据', '高级', '资深', '初级', '专员', '经理', '工程师', '师', '端']);
function tokensOfPosition(position) {
  const phrases = position.toLowerCase().split(/[\/、,，\s]+/).filter(Boolean);
  const tokens = new Set();
  for (const ph of phrases) {
    if (ph.length >= 2) tokens.add(ph);
    const parts = ph.match(/[a-z0-9]{2,}|[一-龥]{2,}/g) || [];
    for (const p of parts) if (p.length >= 2) tokens.add(p);
  }
  const strong = [...tokens].filter((t) => !GROUP_GENERIC.has(t));
  return strong.length ? strong : [...tokens];
}

function bucketOf(job) {
  const name = (job.jobName || '').toLowerCase();

  // 1. 完整岗位词命中，取最长（最具体）的那个
  let full = null; let fullLen = 0;
  for (const p of S.positions) {
    const lp = p.toLowerCase();
    if (name.includes(lp) && lp.length > fullLen) { fullLen = lp.length; full = p; }
  }
  if (full) return full;

  // 2. token 命中：归到「命中的最长 token」所属的岗位词
  let best = null; let bestLen = 0;
  for (const p of S.positions) {
    for (const t of tokensOfPosition(p)) {
      if (name.includes(t) && t.length > bestLen) { bestLen = t.length; best = p; }
    }
  }
  return best || '其他';
}

/** 锁定公司模式：把岗位归到匹配的那家目标公司（按公司名/别名包含匹配）*/
function companyBucketOf(job) {
  const cn = (job.companyName || '').toLowerCase();
  let best = null; let bestLen = 0;
  for (const c of S.companies) {
    const keys = [c.name, ...(c.aliases || [])];
    for (const k of keys) {
      const lk = String(k).toLowerCase();
      if (lk && cn.includes(lk) && lk.length > bestLen) { bestLen = lk.length; best = c.name; }
    }
  }
  return best || '其他';
}

function buildJobCard(j) {
  const on = S.selected.has(j.jobId);
  const el = document.createElement('div');
  el.className = 'jcard' + (on ? '' : ' off');
  el.dataset.jobid = j.jobId;

  // 只保留公司名 + 薪资（对齐同类产品）。资历、学历要求按用户要求不显示。
  const custom = S.jobGreet?.[j.jobId] || '';
  el.innerHTML = `
    <label class="jcheck"><input type="checkbox" ${on ? 'checked' : ''}></label>
    <div class="body">
      <div class="jname">${esc(j.jobName)}</div>
      <div class="jcompany">${esc(j.companyName || '')}</div>
      <div class="jsalary">${esc(j.salaryDesc || '薪资面议')}</div>
      <div class="jgreet-toggle">单岗位－自定义招呼语 <span class="tri">▾</span></div>
      <textarea class="jgreet" rows="3" hidden>${esc(custom)}</textarea>
    </div>`;

  el.querySelector('input').addEventListener('change', (e) => {
    if (e.target.checked) S.selected.add(j.jobId); else S.selected.delete(j.jobId);
    el.classList.toggle('off', !e.target.checked);
    syncSelectAll();
    updateAction();
  });
  const ta = el.querySelector('.jgreet');
  const toggle = el.querySelector('.jgreet-toggle');
  toggle.addEventListener('click', () => {
    ta.hidden = !ta.hidden;
    toggle.querySelector('.tri').textContent = ta.hidden ? '▾' : '▴';
  });
  ta.addEventListener('input', () => {
    S.jobGreet = S.jobGreet || {};
    S.jobGreet[j.jobId] = ta.value;
  });
  return el;
}

/** 精筛后可见的岗位：岗位名含「任一点亮的子词」(或门)才留。
 *  没有子词可筛(没岗位词)→ 全给；有子词但一个都没点亮 → 0 个。 */
function visibleJobs() {
  if (!S.refineTerms || !S.refineTerms.length) return S.jobs;   // 没得筛，全给
  const lit = S.refineTerms.filter((t) => t.on);
  if (!lit.length) return [];   // 一个词都不点 = 不显示
  const realTerms = S.refineTerms.filter((t) => !t.other).map((t) => t.term.toLowerCase());
  const litReal = lit.filter((t) => !t.other).map((t) => t.term.toLowerCase());
  const otherLit = lit.some((t) => t.other);
  return S.jobs.filter((j) => {
    const n = (j.jobName || '').toLowerCase();
    if (litReal.some((t) => n.includes(t))) return true;                  // 命中任一点亮的子词
    if (otherLit && !realTerms.some((t) => n.includes(t))) return true;   // 「其他」：不含任何子词
    return false;
  });
}

/** 结果页精筛条：子词 chip（点亮=生效，点灭=不要）+ 加词 */
function renderRefineBar() {
  const sec = $('refine-sec');
  if (!sec) return;
  sec.hidden = !(S.refineTerms && S.refineTerms.length);
  const box = $('refine-chips');
  box.innerHTML = '';
  const jobs = S.jobs || [];
  const realTerms = (S.refineTerms || []).filter((t) => !t.other).map((t) => t.term.toLowerCase());
  for (const t of (S.refineTerms || [])) {
    const tl = t.term.toLowerCase();
    const cnt = t.other
      ? jobs.filter((j) => { const n = (j.jobName || '').toLowerCase(); return !realTerms.some((x) => n.includes(x)); }).length
      : jobs.filter((j) => (j.jobName || '').toLowerCase().includes(tl)).length;
    const chip = document.createElement('span');
    chip.className = 'pill multi' + (t.on ? ' on' : '');
    chip.innerHTML = `${esc(t.term)} <b>${cnt}</b>`;   // 标数量：一眼看清这个词圈住几个
    chip.addEventListener('click', () => { t.on = !t.on; afterRefineChange(); });
    box.appendChild(chip);
  }
}
function afterRefineChange() {
  // 精筛变化后，默认把可见岗位重新全选（取消不想要的更省力）
  S.selected = new Set(visibleJobs().map((j) => j.jobId));
  renderRefineBar();
  renderJobs();
}

function renderJobs() {
  const list = $('job-list');
  list.innerHTML = '';
  const shown = visibleJobs();   // 精筛后的集合

  // 分组：锁定公司模式按公司分；广撒网模式按岗位词分
  let groups = null;
  if (S.searchMode === 'company' && S.companies.length) {
    groups = new Map(S.companies.map((c) => [c.name, []]));
    groups.set('其他', []);
    for (const j of shown) groups.get(companyBucketOf(j)).push(j);
  } else if (S.positions.length > 1) {
    groups = new Map(S.positions.map((p) => [p, []]));
    groups.set('其他', []);
    for (const j of shown) groups.get(bucketOf(j)).push(j);
  }

  if (groups) {
    for (const [name, jobs] of groups) {
      if (!jobs.length) continue;
      const head = document.createElement('div');
      head.className = 'group-head';
      // 用正方形勾选框：勾上=全选这组，取消=全不选
      const ids = jobs.map((j) => j.jobId);
      const allOn = ids.every((id) => S.selected.has(id));
      const someOn = ids.some((id) => S.selected.has(id));
      head.innerHTML = `<span class="group-title">${esc(name)} <span class="group-count">${jobs.length}</span></span>`
        + `<label class="group-check"><input type="checkbox" ${allOn ? 'checked' : ''}></label>`;
      const box = head.querySelector('.group-check input');
      box.indeterminate = someOn && !allOn;   // 半选状态
      box.addEventListener('change', (e) => {
        if (e.target.checked) { for (const id of ids) S.selected.add(id); }
        else { for (const id of ids) S.selected.delete(id); }
        renderJobs();
      });
      list.appendChild(head);
      for (const j of jobs) list.appendChild(buildJobCard(j));
    }
  } else {
    for (const j of S.jobs) list.appendChild(buildJobCard(j));
  }

  // 岗位数：精筛开着就显示「精筛后 N / 共 M」，否则只显示总数
  const shownN = shown.length;
  $('jobs-count').textContent = (shownN !== S.jobs.length)
    ? `精筛后 ${shownN} 个 · 共 ${S.jobs.length}`
    : `${shownN} 个岗位`;
  document.querySelectorAll('#greet-mode .pill').forEach((p) => {
    p.classList.toggle('on', p.dataset.mode === S.greetMode);
  });
  $('global-greet').hidden = S.greetMode !== 'custom';
  syncSelectAll();
  updateAction();
}

/** 顶部全选框跟随当前勾选状态（针对精筛后可见的岗位）*/
function syncSelectAll() {
  const box = $('sel-all');
  if (!box) return;
  const vis = visibleJobs();
  const selVis = vis.filter((j) => S.selected.has(j.jobId)).length;
  box.checked = vis.length > 0 && selVis === vis.length;
  box.indeterminate = selVis > 0 && selVis < vis.length;
}

$('sel-all').addEventListener('change', (e) => {
  // 只对精筛后可见的岗位做全选/全不选
  const vis = visibleJobs().map((j) => j.jobId);
  if (e.target.checked) for (const id of vis) S.selected.add(id);
  else for (const id of vis) S.selected.delete(id);
  renderJobs();
});

// 招呼语模式：AI 定制 / 自定义
$('greet-mode').addEventListener('click', (e) => {
  const pill = e.target.closest('[data-mode]');
  if (!pill) return;
  S.greetMode = pill.dataset.mode;
  document.querySelectorAll('#greet-mode .pill').forEach((p) => {
    p.classList.toggle('on', p.dataset.mode === S.greetMode);
  });
  $('global-greet').hidden = S.greetMode !== 'custom';
  updateAction();   // 切换模式后底部按钮要跟着变（生成 ↔ 一键投递）
});
$('global-greet').addEventListener('input', (e) => { S.globalGreet = e.target.value; });

// ════════════════════════════════════════════════════════════
// 4 打招呼语
// ════════════════════════════════════════════════════════════

/**
 * AI 定制生成。不跳屏——就在当前结果页，每个岗位卡的招呼语框里就地生成。
 * 生成中卡片显示沙漏，每生成完一条（GREETING_ITEM 广播）就填进对应卡片。
 */
async function runGreeting() {
  S.busy = true;
  S.greeted = false;
  S.greetDone = 0;
  S.greetTotal = S.selected.size;
  $('btn-action').disabled = true;
  $('btn-action').textContent = `生成中 0/${S.greetTotal}…`;

  // 把选中岗位的招呼语框展开，置为「生成中」沙漏态
  for (const el of document.querySelectorAll('#job-list .jcard')) {
    if (!S.selected.has(el.dataset.jobid)) continue;
    const ta = el.querySelector('.jgreet');
    const toggle = el.querySelector('.jgreet-toggle');
    ta.hidden = false;
    ta.value = '';
    ta.placeholder = '⏳ 正在生成…';
    toggle.querySelector('.tri').textContent = '▴';
    el.classList.add('generating');
  }

  try {
    await ask(MSG.START_GREETING, {
      jobIds: [...S.selected],
      mode: 'ai',
      globalGreet: S.globalGreet || '',
      jobGreet: S.jobGreet || {},
    });
  } catch (e) {
    S.busy = false;
    toast(`启动失败：${e.message}`, 5000);
    updateAction();
  }
}

/** 让正在处理的岗位卡滚动到可见并保持沙漏态（按岗位名匹配） */
function markGeneratingCard(jobName) {
  if (!jobName) return;
  for (const el of document.querySelectorAll('#job-list .jcard')) {
    const nm = el.querySelector('.jname')?.textContent || '';
    if (nm === jobName) {
      if (!el.classList.contains('generating')) {
        el.classList.add('generating');
        const ta = el.querySelector('.jgreet');
        if (ta && !ta.value) { ta.hidden = false; ta.placeholder = '⏳ 正在生成…'; }
      }
      break;
    }
  }
}

/** 单个岗位招呼语生成完成，填进对应卡片 */
function onGreetingItem(d) {
  const el = document.querySelector(`#job-list .jcard[data-jobid="${d.jobId}"]`);
  if (el) {
    const ta = el.querySelector('.jgreet');
    ta.value = d.text || '';
    el.classList.remove('generating');
    S.jobGreet = S.jobGreet || {};
    S.jobGreet[d.jobId] = d.text || '';
  }
  S.greetDone = d.greeted || 0;
  if (S.busy) $('btn-action').textContent = `生成中 ${S.greetDone}/${d.total}…`;
}

/** 全部生成完成。就地收尾，不跳屏。 */
async function onGreetingDone(task) {
  S.busy = false;
  S.greeted = true;

  // 自定义模式：招呼语已落好，直接投递
  if (S.pendingSendAfterGreet) {
    S.pendingSendAfterGreet = false;
    runSend();
    return;
  }

  // AI 模式：招呼语已就地填进各卡片，把还在沙漏态的清掉（生成失败的兜底）
  for (const el of document.querySelectorAll('#job-list .jcard.generating')) {
    el.classList.remove('generating');
  }
  const g = task.greetStat || {};
  if (g.failed) toast(`${g.failed} 条生成失败，用的是兜底语，可手动改`, 4000);
  // 生成完，底部按钮变成一键投递
  S.greetMode = S.greetMode;   // 保持
  updateAction();
}

function renderGreetProgress(task) {
  const p = task.progress || {};
  $('greet-progress').hidden = false;
  $('greet-phase').textContent = PHASE_TEXT[task.phase] || task.phase;

  // 读 JD 这一段最慢（串行，每个间隔 3 秒），必须报剩余时间，
  // 否则用户会以为卡死了
  if (task.phase === 'fetching_jd' && p.jdTotal) {
    const left = Math.max(0, p.jdTotal - (p.jdDone || 0));
    $('greet-fill').style.width = `${((p.jdDone || 0) / p.jdTotal) * 100}%`;
    $('greet-detail').textContent =
      `已读 ${p.jdDone || 0}/${p.jdTotal} 个岗位详情，大约还要 ${Math.max(1, Math.ceil(left * 3 / 60))} 分钟`;
    return;
  }

  if (p.greetTotal) {
    $('greet-fill').style.width = `${((p.greeted || 0) / p.greetTotal) * 100}%`;
    $('greet-detail').textContent = `已写好 ${p.greeted || 0}/${p.greetTotal} 条`;
  }
  if (task.phase === 'greeting_error') {
    $('greet-detail').textContent = task.error || '';
    return;
  }

  if (task.phase === 'greeting_done') {
    $('greet-fill').style.width = '100%';
    const g = task.greetStat || {};
    const bits = [`${g.total} 条已生成`];
    // JD 没抓到的话招呼语只能对着岗位名写，质量会明显下降，必须说清楚
    if (g.jdTotal) bits.push(`岗位详情读到 ${g.jdOk}/${g.jdTotal} 个`);
    if (g.failed) bits.push(`${g.failed} 条生成失败，用的是兜底语`);
    if (g.lastError) bits.push(`最后一个错误：${g.lastError}`);
    $('greet-detail').textContent = bits.join('　');
  }
}

async function loadGreetings() {
  const r = await ask(MSG.QUERY_JOBS, { taskId: S.taskId, limit: CONFIG.REVIEW_POOL_SIZE });
  const byId = new Map((r.jobs || []).map((j) => [j.jobId, j]));
  S.jobs = S.jobs.map((j) => byId.get(j.jobId) || j);
  renderGreetings();
}

function renderGreetings() {
  const box = $('greet-list');
  box.innerHTML = '';

  for (const j of S.jobs) {
    if (!S.selected.has(j.jobId)) continue;
    const g = j.greeting || {};
    const el = document.createElement('div');
    el.className = 'gcard';
    el.innerHTML = `
      <div class="name">${esc(j.jobName)}</div>
      <div class="meta">${esc(j.companyName)} · ${esc(j.city)}</div>
      <textarea rows="4">${esc(g.text || '')}</textarea>
      <div class="gact">
        <span class="glen"></span>
        <button class="link" data-act="regen">重新生成</button>
      </div>`;

    const ta = el.querySelector('textarea');
    const len = el.querySelector('.glen');
    const showLen = () => {
      const n = ta.value.length;
      len.textContent = `${n} 字`
        + (g.source === 'fallback' ? '　（生成失败，这是兜底语）' : '')
        + (n > CONFIG.GREETING_MAX_LEN ? '　偏长了' : '');
    };
    showLen();

    let t = null;
    ta.addEventListener('input', () => {
      showLen();
      clearTimeout(t);
      t = setTimeout(() => {
        ask(MSG.UPDATE_GREETING, { jobId: j.jobId, text: ta.value }).catch(() => {});
      }, 700);
    });

    el.querySelector('[data-act=regen]').addEventListener('click', async (e) => {
      e.target.textContent = '生成中…';
      try {
        const r = await ask(MSG.UPDATE_GREETING, { jobId: j.jobId, regenerate: true });
        ta.value = r.greeting.text;
        showLen();
      } catch (err) { toast(err.message); }
      e.target.textContent = '重新生成';
    });

    box.appendChild(el);
  }
}

// ════════════════════════════════════════════════════════════
// 5 投递
// ════════════════════════════════════════════════════════════

async function runSend() {
  // 不再弹确认框；也不切走页面——就在当前岗位列表页顶部叠一条投递进度（对齐即投）。
  S.busy = true;
  S.sending = true;
  S.sendPaused = false;
  S.sentJobIds = new Set();          // 本轮已处理过的岗位（跨暂停/继续累计）
  S.sendTotal = S.selected.size;     // 这批总数，底部计数用
  if (S.screen !== 'result') showScreen('result');
  $('send-banner').hidden = false;
  $('sendbar-fill').style.width = '0%';
  $('sendbar-phase').textContent = '正在启动投递...';
  enterSendingBar();
  await fireSend([...S.selected]);
}

/** 向后台发投递指令（首投 / 继续都走这里）*/
async function fireSend(jobIds) {
  try {
    await ask(MSG.START_SEND, { jobIds });
  } catch (e) {
    S.busy = false; S.sending = false;
    $('sendbar-phase').textContent = `启动失败：${e.message}`;
    toast(e.message, 6000);
    exitSendingBar();
    $('send-banner').hidden = true;
    updateAction();
  }
}

/** 投递中底部条：左侧「N / 总数个岗位已选」+ 右侧主按钮（停止/继续）*/
function enterSendingBar() {
  $('action-count').hidden = false;
  $('action-count').innerHTML = `<b>${S.sendTotal}</b>/ ${S.jobs.length || S.sendTotal} 个岗位已选`;
  $('btn-reset').hidden = true;
  const btn = $('btn-action');
  btn.hidden = false;
  btn.disabled = false;
  btn.textContent = S.sendPaused ? '继续发送' : '停止发送';
}
function exitSendingBar() {
  $('action-count').hidden = true;
  $('btn-reset').hidden = false;
}

/** 点「停止发送」：暂停（叫停当前批，保留进度，按钮变继续发送）*/
async function pauseSending() {
  S.sendPaused = true;              // 先标记，send_done 广播里据此判断是暂停不是完成
  $('btn-action').disabled = true;
  $('btn-action').textContent = '正在暂停…';
  try { await ask(MSG.STOP_TASK); } catch (e) { /* 忽略 */ }
}

/** 点「继续发送」：把还没投的接着投 */
async function resumeSending() {
  const remaining = [...S.selected].filter((id) => !S.sentJobIds.has(id));
  if (!remaining.length) {          // 没剩的了，直接当完成
    S.sending = false;
    finishBatch();
    return;
  }
  S.sendPaused = false;
  S.busy = true; S.sending = true;
  $('send-banner').hidden = false;
  $('sendbar-phase').textContent = '正在继续投递...';
  enterSendingBar();
  await fireSend(remaining);
}

const SEND_STATUS = { ok: '已投', skip: '跳过', fail: '失败' };

function renderSendProgress(task) {
  const p = task.progress || {};

  // 投递中：在 result 屏顶部横幅显示进度条 + 「正在投递 (N/M)...」，岗位列表照常露着
  if (task.phase === 'sending') {
    const idx = p.index || 0;
    const total = p.total || S.sendTotal || 0;
    $('send-banner').hidden = false;
    $('sendbar-phase').textContent = p.resting
      ? '投了一批，休息 90 秒再继续'
      : `正在投递 (${idx}/${total})...`;
    if (total) $('sendbar-fill').style.width = `${(idx / total) * 100}%`;
  }

  if (task.phase === 'send_done') {
    const st = task.sendStat || {};
    // 累计本轮已处理的岗位（暂停后继续时用来跳过）
    for (const r of (st.results || [])) if (r.jobId) (S.sentJobIds = S.sentJobIds || new Set()).add(r.jobId);

    // 是暂停而非完成：停在原地，按钮变「继续发送」，不切结果屏
    if (S.sendPaused) {
      const doneN = S.sentJobIds.size;
      $('sendbar-phase').textContent = `已暂停（已处理 ${doneN}/${S.sendTotal}），点「继续发送」接着投`;
      enterSendingBar();   // 按钮此时显示「继续发送」
      return;
    }

    // 真正完成：切到投递结果屏，展示明细
    S.sending = false;
    $('send-banner').hidden = true;
    exitSendingBar();
    showScreen('send');
    $('send-fill').style.width = '100%';
    $('send-log').hidden = false;
    $('send-log').innerHTML = '';
    const results = st.results || [];
    for (const r of results) {
      const line = document.createElement('div');
      line.className = r.status;
      line.textContent = `${SEND_STATUS[r.status] || r.status}　${r.jobName}（${r.company}）`
        + (r.reason ? `　${r.reason}` : '');
      $('send-log').appendChild(line);
    }
    const ok = results.filter((x) => x.status === 'ok').length;
    const skip = results.filter((x) => x.status === 'skip').length;
    const failed = results.filter((x) => x.status === 'fail');
    $('send-phase').textContent = '投递完成';
    $('send-detail').textContent =
      `成功 ${ok} 个，跳过 ${skip} 个，失败 ${failed.length} 个`
      + (st.todayTotal != null ? `　今天累计投了 ${st.todayTotal} 个` : '');

    // 重投：只把失败的挑出来，一键重发。成功和跳过的不再动。
    S.failedJobIds = failed.map((x) => x.jobId);
    $('send-actions').hidden = S.failedJobIds.length === 0;
  }
}

// ════════════════════════════════════════════════════════════
// 菜单 / 广播 / 启动
// ════════════════════════════════════════════════════════════

$('btn-reinvest').addEventListener('click', async () => {
  if (!S.failedJobIds.length) return;
  S.busy = true;
  $('send-actions').hidden = true;
  $('send-log').innerHTML = '';
  try {
    await ask(MSG.START_SEND, { jobIds: S.failedJobIds });
  } catch (e) {
    S.busy = false;
    toast(e.message, 6000);
    updateAction();
  }
});

// 客服小助手：半屏抽屉
function openService() { $('service-mask').hidden = false; $('service-drawer').hidden = false; }
function closeService() { $('service-mask').hidden = true; $('service-drawer').hidden = true; }
$('btn-service').addEventListener('click', openService);
$('service-close').addEventListener('click', closeService);
$('service-mask').addEventListener('click', closeService);

// 设置：暂时无动作，后续再设计
$('btn-settings').addEventListener('click', () => { /* TODO: 设置面板 */ });

chrome.runtime.onMessage.addListener((msg) => {
  // 单岗位招呼语生成完成：就地填进对应卡片（不跳屏）
  if (msg?.type === MSG.GREETING_ITEM) { onGreetingItem(msg.payload || {}); return; }

  if (msg?.type === MSG.TASK_PROGRESS) {
    if (msg.payload?.taskId) S.taskId = msg.payload.taskId;
    const t = msg.payload;
    if (['fetching_jd', 'greeting', 'greeting_done', 'greeting_error'].includes(t.phase)) {
      // AI 就地生成流水线：底部按钮实时显示正在处理哪个岗位
      if (S.busy && (t.phase === 'fetching_jd' || t.phase === 'greeting')) {
        const p = t.progress || {};
        const verb = t.phase === 'fetching_jd' ? '读取详情' : '生成招呼语';
        const cur = p.current ? `：${p.current.slice(0, 10)}` : '';
        $('btn-action').textContent = `${verb} ${p.greeted ?? p.jdDone ?? 0}/${p.greetTotal ?? p.jdTotal ?? 0}${cur}`;
        // 正在读/生成的那张卡片高亮沙漏
        markGeneratingCard(p.current);
      }
      if (t.phase === 'greeting_done') onGreetingDone(t);
      if (t.phase === 'greeting_error') {
        S.busy = false;
        toast(t.error || '生成失败', 6000);
        updateAction();
      }
    }
    else if (['sending', 'send_done', 'send_error'].includes(t.phase)) {
      renderSendProgress(t);
      if (t.phase === 'send_done' || t.phase === 'send_error') {
        S.busy = false;
        if (t.phase === 'send_error') {
          S.sending = false; S.sendPaused = false;
          $('send-banner').hidden = true; exitSendingBar();
          toast(t.error || '投递中断', 6000);
        }
        updateAction();
      }
    }
    else if (S.searchStopped) {
      // 用户已手动停止：界面已切到「已停止」，忽略后台迟到的进度广播别翻回「搜索中」；
      // 等后台真正卸载到终态（done/aborted），补刷一次把半成品结果显示全。
      if (t.phase === 'done' || t.phase === 'aborted' || t.phase === 'error') {
        S.hasResult = true;
        loadResults().catch(() => {});
      }
    }
    else {
      renderSearchProgress(t);
      // 召回收尾：整轮在后台跑完，靠这条广播兜住（替代原来 await START_RECALL 后的收尾）
      if (t.phase === 'done') {
        S.hasResult = true;
        loadResults().catch((e) => toast(e.message, 5000)).finally(() => {
          S.busy = false;
          $('btn-reset').textContent = '重置';
          updateAction();
        });
      } else if (t.phase === 'error' || t.phase === 'aborted') {
        S.hasResult = true;
        S.busy = false;
        $('btn-reset').textContent = '重置';
        updateAction();
      }
    }
  }
});

(async function boot() {
  // 默认全部「不限」，与同类产品一致。
  // HR 活跃度和工作性质之前是预设好的，现在交还给用户自己点：
  // 预设值会让人以为「我什么都没选」，实际上池子已经被悄悄收窄了。

  const st = await chrome.storage.local.get(STORE.UI.FILTER_STATE);
  const saved = st[STORE.UI.FILTER_STATE];
  if (saved) {
    S.searchMode = saved.searchMode || 'position';
    S.companies = saved.companies || [];
    S.cities = saved.cities || [];
    S.positions = saved.positions || [];
    S.filters = saved.filters || S.filters;
  }

  renderUploads();
  renderMode();
  renderCompanies(); renderCompanyChips();
  renderCityQuick(); renderCityChips();
  renderPositionResult(''); renderPositionChips();
  renderFilters();
  updateAction();

  try {
    const r = await ask(MSG.GET_RESUME);
    S.resumeImages = r.images || [];
    S.resumeText = r.text || '';
    if (S.resumeImages.length) {
          $set('ocr-status', S.resumeText ? `已读取 ${S.resumeText.length} 字` : '未读取');
    }
    renderUploads();
    if (S.resumeText) loadRecommendedPositions();
  } catch (e) { /* 首次打开没有数据，正常 */ }

  loadDict();

  // 面板可能是在长任务跑到一半时才打开的，那样就错过了前面的广播，
  // 所以启动时主动补拉一次当前任务状态
  try {
    const r = await ask(MSG.GET_TASK);
    const ph = r.task && r.task.phase;
    if (['fetching_jd', 'greeting'].includes(ph)) {
      S.taskId = r.task.taskId;
      showScreen('greeting');
      S.busy = true;
      renderGreetProgress(r.task);
    } else if (['opening_tab', 'collecting', 'deduping'].includes(ph)) {
      // 召回还在后台跑：接回搜索进度页，别让用户以为任务丢了
      S.taskId = r.task.taskId;
      showScreen('result');
      S.busy = true;
      $('btn-reset').textContent = '停止';
      renderSearchProgress(r.task);
    }
  } catch (e) { /* 没有在跑的任务是正常情况 */ }
})();
