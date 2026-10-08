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

// 通用提示弹窗（周五上线需求 #10 用：选第 4 家公司时拦截+弹窗）
function showAlert(msg) {
  $('alert-msg').textContent = msg;
  $('alert-mask').hidden = false;
  $('alert-box').hidden = false;
}
function hideAlert() { $('alert-mask').hidden = true; $('alert-box').hidden = true; }

// 精投目标公司最多 3 家（周五上线需求 #10，P0：利于稳定/提速）。
// 返回 true = 已满，已弹窗提示，调用方直接 return 不加。
const COMPANY_MAX = 3;
function companyFull() {
  if (S.companies.length < COMPANY_MAX) return false;
  showAlert(`目标公司最多选 ${COMPANY_MAX} 家。\n先取消一家，再选新的。`);
  return true;
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
  refineTerms: [],       // [{term, on}] 结果页按「用户选定的岗位」分桶筛选，点亮=显示该桶
  searchDetailOpen: false, // 「搜索过程与结果」折叠区，默认折叠
  brandOverrides: {},    // 用户贴公司主页网址抽出的 brandId（公司名→brandId），最优先、跳过定位
  searchMinutes: (typeof CONFIG !== 'undefined' && CONFIG.DEFAULT_SEARCH_MINUTES) || 5,  // 固定安全时间上限，不再给用户调
};

// 热门城市次序对齐 BOSS「请选择城市」弹窗的热门城市页（2026-10-07 用户截图定）：
// 全国 北京 上海 广州 深圳 / 杭州 天津 西安 苏州 武汉 / 厦门 长沙 成都 郑州 重庆
const HOT_CITIES = [
  { code: '100010000', label: '全国' }, { code: '101010100', label: '北京' },
  { code: '101020100', label: '上海' }, { code: '101280100', label: '广州' },
  { code: '101280600', label: '深圳' }, { code: '101210100', label: '杭州' },
  { code: '101030100', label: '天津' }, { code: '101110100', label: '西安' },
  { code: '101190400', label: '苏州' }, { code: '101200100', label: '武汉' },
  { code: '101230200', label: '厦门' }, { code: '101250100', label: '长沙' },
  { code: '101270100', label: '成都' }, { code: '101180100', label: '郑州' },
  { code: '101040100', label: '重庆' },
];
// BOSS 热门页以外的城市收进「展开更多」（保留原可选范围）
const MORE_CITIES = [
  { code: '101190100', label: '南京' }, { code: '101220100', label: '合肥' },
  { code: '101120100', label: '济南' }, { code: '101120200', label: '青岛' },
  { code: '101070100', label: '沈阳' }, { code: '101280700', label: '珠海' },
  { code: '101281600', label: '东莞' }, { code: '101210400', label: '宁波' },
  { code: '101190200', label: '无锡' },
];

// ── 各城市的「工作区域」行政区选项（2026-10-07 用户按 BOSS 筛选栏逐城截图提供）──
// 区域是可多选的（BOSS 筛选栏本身支持多选）。没列的城市（含全国）没有答案，
// 工作区域只剩「不限」（用户原话：其他没有答案的就默认只有不限）。
const CITY_DISTRICTS = {
  '101010100': ['东城区', '西城区', '朝阳区', '石景山区', '丰台区', '门头沟区', '海淀区', '房山区', '顺义区', '通州区', '大兴区', '昌平区', '平谷区', '怀柔区', '延庆区', '密云区'], // 北京
  '101020100': ['崇明区', '黄浦区', '虹口区', '杨浦区', '徐汇区', '长宁区', '静安区', '普陀区', '金山区', '松江区', '青浦区', '闵行区', '宝山区', '嘉定区', '浦东新区', '奉贤区'], // 上海
  '101280100': ['荔湾区', '白云区', '天河区', '越秀区', '海珠区', '增城区', '从化区', '花都区', '南沙区', '黄埔区', '番禺区'], // 广州
  '101280600': ['罗湖区', '坪山区', '光明区', '盐田区', '龙华区', '宝安区', '龙岗区', '福田区', '南山区'], // 深圳
  '101210100': ['建德市', '临平区', '临安区', '钱塘区', '淳安县', '桐庐县', '上城区', '萧山区', '滨江区', '富阳区', '余杭区', '拱墅区', '西湖区'], // 杭州
  '101030100': ['和平区', '河西区', '河东区', '河北区', '南开区', '红桥区', '西青区', '东丽区', '北辰区', '津南区', '宝坻区', '武清区', '宁河区', '滨海新区', '蓟州区', '静海区'], // 天津
  '101110100': ['蓝田县', '周至县', '雁塔区', '未央区', '临潼区', '阎良区', '高陵区', '长安区', '鄠邑区', '莲湖区', '灞桥区', '碑林区', '新城区'], // 西安
  '101190400': ['常熟市', '张家港市', '昆山市', '太仓市', '姑苏区', '吴江区', '虎丘区', '吴中区', '相城区', '苏州工业园区'], // 苏州
  '101200100': ['江岸区', '江汉区', '洪山区', '武昌区', '青山区', '硚口区', '汉阳区', '黄陂区', '新洲区', '蔡甸区', '江夏区', '东西湖区', '汉南区'], // 武汉
  '101230200': ['翔安区', '同安区', '集美区', '海沧区', '湖里区', '思明区'], // 厦门
  '101250100': ['芙蓉区', '天心区', '雨花区', '岳麓区', '开福区', '宁乡市', '浏阳市', '望城区', '长沙县'], // 长沙
  '101270100': ['成华区', '武侯区', '金牛区', '青羊区', '锦江区', '邛崃市', '彭州市', '都江堰市', '郫都区', '双流区', '温江区', '新都区', '青白江区', '龙泉驿区', '金堂县', '简阳市', '崇州市', '新津区', '蒲江县', '大邑县'], // 成都
  '101180100': ['荥阳市', '新密市', '巩义市', '中牟县', '新郑市', '登封市', '中原区', '二七区', '惠济区', '上街区', '管城回族区', '金水区'], // 郑州
  '101040100': ['渝中区', '垫江县', '涪陵区', '丰都县', '万州区', '城口县', '大足区', '綦江区', '巫溪县', '北碚区', '巫山县', '南岸区', '奉节县', '九龙坡区', '云阳县', '沙坪坝区', '忠县', '大渡口区', '南川区', '永川区', '合川区', '江津区', '彭水苗族土家族自治县', '长寿区', '黔江区', '酉阳土家族苗族自治县', '秀山土家族苗族自治县', '巴南区', '石柱土家族自治县', '璧山区', '铜梁区', '两江新区', '武隆区', '梁平区', '开州区', '荣昌区', '潼南区'], // 重庆
};

// 全国：单选，与具体城市互斥（2026-10-07 用户定）
const ALL_COUNTRY = { code: '100010000', label: '全国' };

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
  // 工作区域 = 所选城市下面的行政区，内置表在 CITY_DISTRICTS（按所选城市取并集），
  // 这里只留「不限」占位；选中存区名，真实 code 运行时用抓取字典按名字对齐。
  businessDistrict: [{ code: '', label: '不限' }],
  jobType: [
    { code: '', label: '不限' }, { code: '1901', label: '全职' },
    { code: '1902', label: '兼职' }, { code: '1903', label: '实习' },
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
  { key: 'businessDistrict', label: '工作区域' },
  { key: 'jobType', label: '求职类型' },
  { key: 'salary', label: '薪资待遇' },
  { key: 'experience', label: '工作经验' },
  { key: 'degree', label: '学历要求' },
  { key: 'industry', label: '公司行业', searchable: true },
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
  // 离开投递屏时收掉「投递中」的底部计数条，别残留到别的页面
  if (name !== 'send') { $('action-count').hidden = true; $('btn-reset').hidden = false; }
  if (name === 'config') renderResumeBar();
  window.scrollTo(0, 0);
  updateAction();
}

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
 * 存图（2026-10-08 用户定：OCR 放在搜索之后做）。
 * 上传只存图、秒存秒走，不在这一步识别；识别挪到真正要用文字的环节
 * （生成打招呼语 / 推荐岗位词）自动做，识别失败下次自动再试，不会死锁。
 */
function saveResume() {
  renderUploads();

  if (!S.resumeImages.length) {
    S.resumeText = '';
    ask(MSG.SAVE_RESUME_IMAGES, { images: [] }).catch(() => {});
    $set('ocr-status', '未上传简历');
    return;
  }

  ask(MSG.SAVE_RESUME_IMAGES, { images: S.resumeImages })
    .then(() => {
      S.resumeText = '';
      $set('ocr-status', `已保存 ${S.resumeImages.length} 张，生成时自动读取文字`);
    })
    .catch((e) => { $set('ocr-status', `保存失败：${e.message}`); });
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
        else {
          if (companyFull()) return;   // 需求 #10：最多 3 家，第 4 家拦截+弹窗
          S.companies.push({ name: c.n, aliases: c.a, search: c.s || c.n });
        }
        renderCompanies($('company-search').value);
        renderCompanyChips();
        saveConfig();
      }, { multi: true }));
    }
    box.appendChild(row);
  }

  // 搜不到内置库里的公司？直接把用户输入的名字加进去当目标公司。
  // 不需要外接搜索接口：投递时会拿这个名字走首页搜索→点卡片进公司页的真人链路
  // （见 service-worker 的 augmentFromCompanyPages），和内置公司走的是同一条路。
  const raw = q.trim();
  if (raw) {
    const dup = S.companies.some((x) => x.name === raw)
      || COMPANY_LIB.some((c) => c.n.toLowerCase() === kw);
    if (!dup) {
      const addRow = document.createElement('div');
      addRow.className = 'pills';
      addRow.style.marginTop = '14px';
      addRow.appendChild(makePill(`+ 添加公司「${raw}」`, false, () => {
        if (!S.companies.some((x) => x.name === raw)) {
          if (companyFull()) return;   // 需求 #10：最多 3 家，第 4 家拦截+弹窗
          S.companies.push({ name: raw, aliases: [raw], search: raw });
        }
        $('company-search').value = '';
        renderCompanies('');
        renderCompanyChips();
        saveConfig();
      }, { dashed: true }));
      box.appendChild(addRow);
    }
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
  if (c.code === ALL_COUNTRY.code) {
    // 全国是单选：点了就只留全国（2026-10-07 用户定）
    S.cities = i >= 0 ? [] : [{ ...ALL_COUNTRY }];
  } else {
    if (i >= 0) S.cities.splice(i, 1);
    else {
      S.cities = S.cities.filter((x) => x.code !== ALL_COUNTRY.code);   // 选具体城市就挤掉全国（互斥）
      S.cities.push(c);
    }
  }
  // 一个城市都不选时（取消唯一城市后）自动点回全国（2026-10-07 用户定）
  if (!S.cities.length) S.cities = [{ ...ALL_COUNTRY }];
  // 工作区域实时跟着目标城市换：只展最后选择的城市的区域，
  // 清掉不属于当前展示城市的已选区名，再重画筛选区（2026-10-07 用户定）
  const dn = currentDistrictNames();
  S.filters.businessDistrict = (S.filters.businessDistrict || []).filter((v) => dn.includes(v));
  renderCityQuick();
  renderCityChips();
  renderFilters();   // 工作区域实时跟随目标城市
  saveConfig();
}

// 当前工作区域应展示的区名（2026-10-07 用户定）：两个或以上城市时只展**最后选择**的城市的区域；
// 全国/没答案的城市 → 空数组（工作区域只剩「不限」）。
function currentDistrictNames() {
  const last = S.cities[S.cities.length - 1];
  return last ? (CITY_DISTRICTS[last.code] || []) : [];
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
  // 精筛严格按「用户搜索前选定的岗位」分类，不再衍生出一堆子词 chip。
  // 子词拆解退到后台（bucketOf 里用 splitToSubterms 把岗位名归桶），
  // 比如「AIGC产品」「GC产品经理」都会被归进它所属的那个岗位桶，呈现上只保留原始岗位。
  // 只保留用户选定的岗位作为精筛桶，不再有「其他」——不属于任何选定岗位的岗位直接不展示。
  return (positions || []).map((term) => ({ term, on: true }));
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
    // 精投只布置四项（用户 2026-10-08 定）：工作城市（目标城市区承担）/工作经验/
    // 学历要求/薪资待遇。工作区域/求职类型/公司行业/公司规模/融资阶段在公司页
    // 布置不了也不本地筛，精投一律隐去；海投照展。
    if (S.searchMode === 'company'
      && ['industry', 'scale', 'stage', 'businessDistrict', 'jobType'].includes(f.key)) continue;
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
    let options;
    if (f.key === 'businessDistrict') {
      // 工作区域跟着所选城市走（2026-10-07 用户定）：只展**最后选择**的城市的行政区，
      // 全国/没答案的城市只剩「不限」。
      // 选中状态存「区名」（同行业存名字的做法），真实 code 运行时用抓取字典按名字
      // 对齐；对不上也能由 collector 按选项文字点出来，所以区域永远不算 deadKey。
      const names = currentDistrictNames();
      options = [{ label: '不限', code: '', unresolved: false }];
      for (const n of names) {
        options.push({ label: n, code: n, unresolved: !byLabel.has(n) });
      }
      if (!names.length) {
        // 所选城市都没有内置答案 → 用页面上抓到的选项兜底（保留旧行为）
        for (const o of scraped) {
          if (!options.some((x) => x.label === o.label)) options.push({ label: o.label, code: o.code });
        }
      }
    } else {
      options = (OPT[f.key] || []).map((o, i) => {
        let code = o.code !== undefined ? o.code : byLabel.get(o.label);
        if (code === undefined || code === '') code = i === 0 ? '' : `__unresolved_${f.key}_${i}`;
        return { label: o.label, code, unresolved: String(code).startsWith('__unresolved') };
      });
    }
    if (!options.length) continue;

    const sel = new Set(S.filters[f.key] || []);   // 多选，存成数组
    // 除「不限」外一个真实 code 都没有，说明这一项点了也筛不动
    // （工作区域除外：没 code 也能按区名文字点，不算死项）
    if (f.key !== 'businessDistrict' && options.length > 1 && !options.some((o) => o.code && !o.unresolved)) deadKeys.push(f.label);

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
  // 换位营造切换感：精投把「目标公司」提到最上面；
  // 海投把「期望职位」放在图片版简历正下方（用户 2026-10-07 定，position 在 city 前）。
  // 注意：版块顺序由这里的 JS 动态排，panel.html 里的静态顺序不生效。
  const anchor = $('filter-area');
  const parent = anchor.parentNode;
  const order = isCompany
    ? ['sec-company', 'sec-position', 'sec-city']
    : ['sec-position', 'sec-city', 'sec-company'];
  for (const id of order) parent.insertBefore($(id), anchor);
  renderFilters();   // 精投/海投的筛选区不一样（精投隐去行业/规模/融资），切模式要重画
  updateAction();
}
document.querySelectorAll('#search-mode .pill').forEach((p) => {
  p.addEventListener('click', () => {
    S.searchMode = p.dataset.mode;
    Tracker.track('mode_click', { mode: S.searchMode });   // 埋点：海投/精投点击渗透
    renderMode();
    saveConfig();
  });
});

// ════════════════════════════════════════════════════════════
// 底部操作条
// ════════════════════════════════════════════════════════════

// ── 精投耗时预估 ──
// 一个「公司×城市×词」是一个单元=一个分页（用户 2026-10-08 定）。单元内翻几页、
// 每页过一次全局冷却闸 + 固定开销。总时长按单元算，供开搜前预告 + 搜索中倒推。
// 按「全局冷却队列」模型估时：翻页是全局串行的(每次翻页前过一个随机冷却闸)，
// 所以总翻页耗时 = 总翻页数 × 冷却均值，【不除以并行数】。第 1 页不占冷却。
// brandId 解析是每家串行的固定开销（同一家多单元只定位一次）。翻页数用现实区间，免得吓人。
const EST = {
  perCompanyOverheadSec: 12,   // 每家 brandId 解析 + 开页搜词的固定开销
  estPagesMin: 3,              // 预估每单元翻几页（现实区间；行为预算平分后小单元多在低位）
  estPagesMax: 10,
};
function estimateUnits() {
  const companies = S.companies.length;
  const words = Math.max(S.positions.length, 1);
  // 城市数：全国/没选城市算 1 个单元维度（2026-10-08 定：分页数=公司×城市×词）
  const cities = S.cities.filter((c) => (c.name || c.label) !== '全国').length || 1;
  return companies * cities * words;
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
  // 恢复搜索功能已取消（2026-10-08 用户定）：每次点「开始搜索」都是全新一轮。
  if (S.busy || S.sending) return;   // 投递进行中/暂停中由 enterSendingBar 管按钮

  reset.hidden = false;
  $('btn-action2').hidden = true;   // 不再用双按钮，时长在设置里调

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
    // 判定（用户 2026-10-07 定）：所选岗位的招呼语格子全部有内容 →「一键投递」；
    // 有一个空 →「生成打招呼语」（不显示数字），只生成空的。自定义模式保持直投（AI 不介入）。
    const n = Math.min(S.selected.size, SEND_CAP());
    if (S.greetMode === 'custom') {
      btn.textContent = n ? `一键投递（${n}）` : '一键投递';
    } else {
      const empties = emptyGreetIds();
      btn.textContent = empties.length
        ? '生成打招呼语'   // 不显示数字（用户 2026-10-07 定）
        : (n ? `一键投递（${n}）` : '一键投递');
    }
    btn.disabled = n === 0;
    return;
  }

  if (S.screen === 'greeting') {
    const n = Math.min(S.selected.size, SEND_CAP());
    btn.textContent = `投递这 ${n} 个岗位`;
    btn.disabled = n === 0 || !S.greeted;
    return;
  }

  if (S.screen === 'send') {
    btn.textContent = '完成';
    btn.disabled = S.busy;
    reset.textContent = '重置';   // 投递完成页：重置 = 清空一切重来
  }
}

$('btn-reset').addEventListener('click', () => {
  // 按钮写「停止」时：只停止，不清结果、不跳屏。生成中与搜索中分流（用户 2026-10-08 定）。
  if ($('btn-reset').textContent === '停止') {
    if (S.greeting) stopGreeting(); else stopSearch();
    return;
  }
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
  finalizeSearchTimer();                // 停表，显示用到停止为止的时间
  $('search-phase').textContent = '已停止';
  $('btn-reset').textContent = '重置';
  $('btn-action').disabled = false;
  updateAction();
  loadResults().catch(() => {});        // 把已收到的岗位显示出来（可能为空，正常）
  toast('已停止');
}

/**
 * 生成中点「停止」（用户 2026-10-08 定）：停掉招呼语生成。
 * 后台 worker 循环本来就查 stopRequested，会陆续退出；卡住的步骤有各自超时兜底。
 * 已生成的每条都实时填进了卡片，停了不丢；空格子留着，再点「生成打招呼语」接着补。
 * 迟到的 greeting_done 广播只负责清沙漏态和刷新按钮，不会把已停的状态翻回去。
 */
function stopGreeting() {
  ask(MSG.STOP_TASK).catch(() => {});   // 同一个停止令，doGreeting 的 worker 会认
  S.busy = false;
  S.greeting = false;
  S.pendingSendAfterGreet = false;      // 自定义模式的「生成完直接投递」连锁也一起取消
  for (const el of document.querySelectorAll('#job-list .jcard.generating')) {
    el.classList.remove('generating');
    const ta = el.querySelector('.jgreet');
    if (ta && !ta.value) ta.placeholder = '（已停止，可再点生成）';
  }
  $('btn-reset').textContent = '重置';
  updateAction();
  toast('已停止，已生成的招呼语保留在卡片里');
}

// ── 重置 ──
// 恢复搜索功能已整体取消（2026-10-08 用户定）：每次点「开始搜索」都是全新一轮，无断点。
/** 清空一切：条件 + 岗位词 + 城市 + 结果，回到空白条件页 */
function fullReset() {
  S.companies = []; S.positions = []; S.cities = [{ ...ALL_COUNTRY }];   // 重置回默认：全国（2026-10-07 用户定的空选规则）
  S.filters = {};   // HR 活跃度/福利待遇两个维度已下线（用户 2026-10-07 定），重置即全空
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
  if (S.screen === 'config') return runSearch();   // 时长按设置里的分钟数
  if (S.screen === 'result') {
    if (S.greetMode === 'custom') return runSendFromResult(); // 自定义 → 落文案后投递
    const empties = emptyGreetIds();
    if (!empties.length) {                                   // 格子全部有内容 → 一键投递
      return S.greeted ? runSend() : runSendFromResult();    // 手动填满的走 custom 落文案（不调 AI）
    }
    return runGreeting(empties);                             // 有空格子 → 只生成空的
  }
  if (S.screen === 'greeting') return runSend();
  // 投递完成屏：点「完成」收尾
  if (S.screen === 'send') return finishBatch();
});

// 深搜 10min（条件页专用）
$('btn-action2').addEventListener('click', () => {
  if (S.screen === 'config' && !$('btn-action2').disabled) runSearch('deep');
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
  Tracker.track('send_click', { via: 'custom' });   // 埋点：一键投递点击渗透
  S.busy = true;
  $('btn-action').disabled = true;
  $('btn-action').textContent = '准备中…';
  try {
    // 用自定义模式跑一遍生成（不调 AI，只是把文案落进每个岗位），完成后自动进投递
    await ask(MSG.START_GREETING, {
      jobIds: batchIds(),
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
  startSearchTimer();        // 开表：实时走时
  $('search-progress').hidden = false;
  $('funnel').hidden = true; $('funnel').innerHTML = '';
  $('company-status').innerHTML = '';
  $('login-warn').hidden = true;
  S.searchDetailOpen = true; updateSearchDetailSec();   // 搜索中默认展开，结束后自动收起
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
    // 工作区域存的也是名字（区名，2026-10-07 用户定区域可多选）：能按抓取字典转成
    // 真实 code 的转 code，转不了的保留区名，布置时由 collector 按选项文字点。
    const bdByLabel = new Map(((S.dict && S.dict.businessDistrict) || []).map((o) => [o.label, o.code]));
    const districtVals = (S.filters.businessDistrict || []).map((v) => bdByLabel.get(v) || v);
    const filters = { ...S.filters, industry: industryCodes, businessDistrict: districtVals };
    // HR 活跃度/福利待遇已下线（用户 2026-10-07 定）：清掉存档里可能残留的旧值，不再发给后台
    delete filters.hrActive; delete filters.welfare;
    // 精投只带布置得动的维度（用户 2026-10-08 定，界面已隐去）：剥掉海投时可能
    // 选过的残留值（行业/规模/融资/工作区域/求职类型），免得混进后台配置。
    // 精投有效筛选 = 薪资/经验/学历 + 目标城市。
    if (S.searchMode === 'company') {
      for (const k of ['industry', 'scale', 'stage', 'businessDistrict', 'jobType']) delete filters[k];
    }

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
    // 精投布置/本地过滤用的中文 label（SW 没有 OPT 表）：选中的 code → label
    const labelsOf = (key) => (S.filters[key] || [])
      .map((code) => (OPT[key] || []).find((o) => String(o.code) === String(code)))
      .filter(Boolean).map((o) => o.label);
    // 发令即返回：整轮召回在后台烧几分钟，这里不能 await 整轮（通道撑不住会被
    // 判「channel closed」误报出错）。收尾（loadResults + 复位按钮）交给
    // TASK_PROGRESS 的 'done' 广播在 onMessage 里做。
    await ask(MSG.START_RECALL, {
      searchMode: S.searchMode,
      companies: sendCompanies,
      companyAliases: sendCompanies.flatMap((c) => c.aliases),
      positions: S.positions,
      cities: S.cities.map((c) => c.code),
      cityNames: S.cities.map((c) => c.name || c.label).filter(Boolean),   // 精投本地按城市名筛用（城市条目只有 label 字段，之前读 c.name 永远为空）
      filters,
      filterLabels: {   // 精投布置 + 本地过滤用（2026-10-08）：城市走 cityNames，这三维走 label
        salary: labelsOf('salary'),
        experience: labelsOf('experience'),
        degree: labelsOf('degree'),
      },
      brandOverrides: S.brandOverrides,     // 贴网址锁定的主页 brandId，直接用、跳过定位
      searchMinutes: S.searchMinutes,       // 搜索时长(分钟)，决定时间上限 + 行为预算(分钟×20)
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

// ── 搜索实时计时 ──
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function startSearchTimer() {
  S.searchStartAt = Date.now();
  stopSearchTimer();
  const tick = () => { const el = $('search-timer'); if (el) el.textContent = `用时 ${fmtClock(Date.now() - S.searchStartAt)}`; };
  tick();
  S.searchTimer = setInterval(tick, 1000);
}
function stopSearchTimer() { if (S.searchTimer) { clearInterval(S.searchTimer); S.searchTimer = null; } }
function finalizeSearchTimer() {
  stopSearchTimer();
  const el = $('search-timer');
  if (el && S.searchStartAt) el.textContent = `本次搜索用时 ${fmtClock(Date.now() - S.searchStartAt)}`;
}

function renderSearchProgress(task) {
  $('search-progress').hidden = false;
  $('search-phase').textContent = PHASE_TEXT[task.phase] || task.phase;
  const p = task.progress || {};

  // 进度% = 已执行行为数 / 行为预算。剩余时间：精投按剩余行为 × 6 秒估；
  // 海投有 3 分钟硬闸（HAITOU_STOP_MINUTES），剩余 = 3 分钟 − 已用时（用户 2026-10-07 定：不写 5 分钟）。
  if (p.actionsBudget && task.phase !== 'done') {
    const pct = Math.min(99, Math.max(1, Math.round((p.actionsDone || 0) / p.actionsBudget * 100)));
    let remainSec;
    if (S.searchMode === 'position') {
      const stopSec = (CONFIG.HAITOU_STOP_MINUTES || 3) * 60;
      const elapsed = S.searchStartAt ? (Date.now() - S.searchStartAt) / 1000 : 0;
      remainSec = Math.max(0, Math.round(stopSec - elapsed));
    } else {
      remainSec = Math.max(0, p.actionsBudget - (p.actionsDone || 0)) * 6;
    }
    $('search-fill').style.width = `${pct}%`;
    $('search-detail').textContent =
      `${pct}% · 约还需 ${fmtMin(remainSec)} · 已收 ${p.collected || 0} 个`;
  } else if (p.unitTotal && task.phase !== 'done') {
    const subFrac = Math.min(1, (p.domPage || 0) / (p.domMaxPages || CONFIG.COMPANY_PAGES_MAX || 15));
    const doneFrac = ((p.unitDone || 0) + subFrac) / p.unitTotal;
    const pct = Math.min(99, Math.max(1, Math.round(doneFrac * 100)));
    $('search-fill').style.width = `${pct}%`;
    $('search-detail').textContent = `${pct}% · 已完成 ${p.unitDone || 0}/${p.unitTotal} · 已收 ${p.collected || 0} 个`;
  } else if (p.rounds) {
    $('search-fill').style.width = `${task.phase === 'done' ? 100 : ((p.round || 0) / p.rounds) * 100}%`;
    // 只留一行干净的进度，不提限流、不堆细节
    $('search-detail').textContent = task.phase === 'done'
      ? '' : `已找到 ${p.collected || 0} 个`;
  }
  renderCompanyStatus(task);
  if (task.phase === 'error') { $('search-phase').textContent = `出错了：${task.error}`; finalizeSearchTimer(); }
  if (task.phase === 'done') {
    $('search-fill').style.width = '100%';
    // 不再显示灰色小字（数量+限流提示），漏斗里已经有完整数据
    $('search-detail').textContent = '';
    finalizeSearchTimer();   // 停表，显示本次搜索总用时
    S.searchDetailOpen = false;   // 结束后自动收起「搜索过程与结果」
    renderFunnel(task);
    syncSearchDetail();
    maybeWarnLogin(task);   // 结果异常偏少 → 提示检查登录
  }
}

/** 登录失效检测：精投时若「已定位的公司几乎都只收到 1 页」，极可能是 BOSS 登录失效，提示用户。 */
function maybeWarnLogin(task) {
  const warn = $('login-warn');
  if (!warn) return;
  let suspect = false;
  if (S.searchMode === 'company') {
    const stats = (task.progress || {}).companyStats || {};
    const located = Object.values(stats).filter((x) => x && x.count > 0);
    const avgP = located.length ? located.reduce((a, b) => a + (b.pages || 0), 0) / located.length : 0;
    suspect = located.length > 0 && avgP <= 1.3;   // 大家都只翻了 1 页左右 = 典型的没登录
  }
  warn.hidden = !suspect;
}

// 「搜索过程与结果」折叠区的显隐同步
function syncSearchDetail() {
  const open = S.searchDetailOpen;
  const body = $('sd-body'); if (body) body.hidden = !open;
  const a = $('sd-head') && $('sd-head').querySelector('.fold-arrow'); if (a) a.textContent = open ? '▾' : '▸';
}
function updateSearchDetailSec() {
  const sec = $('search-detail-sec'); if (!sec) return;
  const hasCs = $('company-status') && $('company-status').children.length > 0;
  const hasFn = $('funnel') && $('funnel').innerHTML.trim() !== '';
  sec.hidden = !(hasCs || hasFn);
  syncSearchDetail();
}

/** 及时回馈：精投时逐家公司显示到哪一步了（定位中/搜职位中/已完成/没定位到）。 */
function renderCompanyStatus(task) {
  const el = $('company-status');
  if (!el) return;
  if (S.searchMode !== 'company' || !S.companies.length) { el.innerHTML = ''; updateSearchDetailSec(); return; }
  const st = (task.progress || {}).companyStatus || {};
  const META = {
    locating: { t: '定位中', c: 'run', i: '•' },
    searching: { t: '搜职位中', c: 'run', i: '•' },
    running: { t: '搜索中', c: 'run', i: '•' },
    done: { t: '已完成', c: 'ok', i: '✓' },
    miss: { t: '没定位到', c: 'bad', i: '✗' },
  };
  // 完成后：按「翻页数(工作步数)」算本轮平均，页数过少的标出来（主指标，不受冷却时间影响；
  // 用时只做显示参考，不拿来判异常）。
  const stats = (task.progress || {}).companyStats || {};
  const live = (task.progress || {}).companyLive || {};
  // 只有翻了 2 页以上（真正有在翻页）的公司才算进平均，免得被一堆 1 页的拉低基准
  const pageArr = Object.values(stats).filter((x) => x && x.count > 0 && (x.pages || 0) >= 2).map((x) => x.pages || 0);
  const avgPages = pageArr.length ? pageArr.reduce((a, b) => a + b, 0) / pageArr.length : 0;

  el.innerHTML = S.companies.map((c) => {
    const s = st[c.name];
    const m = META[s] || { t: task.phase === 'done' ? '未搜到' : '排队中', c: 'pend', i: '◦' };
    let ico = m.i, cls = m.c, step = m.t;
    // 搜索中：实时显示翻了几页（工作步数）
    if (s === 'searching' && live[c.name]) step = `搜职位中 · 第 ${live[c.name]} 页`;
    const stat = stats[c.name];
    if (s === 'done' && stat) {
      const pages = stat.pages || 0, cnt = stat.count || 0;
      step = `${cnt} 个 · ${pages} 页 · ${(stat.ms / 1000).toFixed(0)}s`;
      // 异常标准：收到 0 个，或工作步数(翻页数) < 本轮平均的 50%
      if (cnt === 0) { ico = '❗'; cls = 'bad'; step += ' · 没收到岗位，疑似异常/没登录'; }
      else if (avgPages && pages < avgPages * 0.5) { ico = '⚠'; cls = 'warn'; step += ' · 页数不足平均一半，可能异常'; }
    }
    let html = `<div class="cs-row ${cls}"><span class="cs-ico">${ico}</span><span class="cs-name">${esc(c.name)}</span><span class="cs-step">${esc(step)}</span></div>`;
    // 有问题的公司（异常/没定位到）：给「改网址」入口——贴公司主页网址锁定直达。
    // 改搜索词功能已撤（2026-10-08 用户定）：失败后贴网址/进列表，不再改搜寻名。
    const flagged = s === 'miss' || (s === 'done' && (cls === 'bad' || cls === 'warn'));
    if (flagged) {
      const pinned = S.brandOverrides[c.name] ? '已锁定主页 · ' : '';
      html += `<div class="cs-sub"><span class="cs-bid">${pinned}</span>`
        + `<button class="cs-url" data-company="${esc(c.name)}">改网址</button></div>`;
    }
    return html;
  }).join('');
  updateSearchDetailSec();
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
  updateSearchDetailSec();
}

async function loadResults() {
  // 按 taskId 查而不是按 state：岗位状态会随流程推进变化（recalled → greeted → sent），
  // 按单一 state 查会漏
  const r = await ask(MSG.QUERY_JOBS, { taskId: S.taskId, limit: CONFIG.REVIEW_POOL_SIZE });
  S.jobs = r.jobs || [];
  // 新一轮结果：所有公司分组默认【收起】，用户点开想看的那家（收非存在的组名无害）
  S.collapsedGroups = new Set([...S.companies.map((c) => c.name), ...S.positions, '其他']);
  // 精筛子词：从这次搜的岗位词拆出来，默认全部点亮
  S.refineTerms = genRefineTerms(S.positions);
  // 默认全选当前可见(精筛后)的岗位
  renderUploads();   // 结果页顶部也放简历，跟即投一致
  renderRefineBar();
  selectAllVisible();   // 默认全选可见（发送时才按顺序取前 75）
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
/**
 * 把一个岗位严格归到「用户选定的某个岗位」下（或「其他」）。
 * 用每个选定岗位拆出的子词（splitToSubterms：全词 / 去头 / 保头去尾 等）去匹配岗位名，
 * 命中子词最长的那个岗位胜出——这样「AIGC产品」「AIGC产品经理」会一起落进「AIGC产品经理」桶，
 * 而「AI产品经理」因为能命中更长的「AI产品经理」子词，不会被误并到别处。
 */
function bucketOf(job) {
  const name = (job.jobName || '').toLowerCase();
  let best = '其他'; let bestLen = 0;
  for (const p of S.positions) {
    for (const s of splitToSubterms(p)) {
      const ls = s.toLowerCase();
      if (ls && name.includes(ls) && ls.length > bestLen) { bestLen = ls.length; best = p; }
    }
  }
  return best;
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

// ── 公司名 → 官网招聘页（共笔条目 1/2，仅精投模式生效）──
// 匹配键 = 显示名/搜索名/别名，向前包含（公司名以键开头），最长键优先。
// 命中 → 新分页打开官网招聘页；未命中 → Bing 搜索「公司名 官网 招聘」兜底。
let _careersKeys = null;
function careersUrlOf(companyName) {
  const cn = String(companyName || '').trim();
  if (!cn) return null;
  if (!_careersKeys) {
    _careersKeys = [];
    for (const c of (typeof COMPANY_LIB !== 'undefined' ? COMPANY_LIB : [])) {
      if (!c.url) continue;
      const keys = [c.n, c.s, ...(c.a || [])].filter(Boolean);
      for (const k of keys) _careersKeys.push({ k: String(k).toLowerCase(), url: c.url });
    }
    _careersKeys.sort((x, y) => y.k.length - x.k.length); // 最长键优先
  }
  const low = cn.toLowerCase();
  for (const e of _careersKeys) {
    if (low.startsWith(e.k)) return { url: e.url, official: true };
  }
  return { url: 'https://www.bing.com/search?q=' + encodeURIComponent(cn + ' 官网 招聘'), official: false };
}

function buildJobCard(j) {
  const on = S.selected.has(j.jobId);
  const el = document.createElement('div');
  el.className = 'jcard' + (on ? '' : ' off');
  el.dataset.jobid = j.jobId;

  // 只保留公司名 + 薪资（对齐同类产品）。资历、学历要求按用户要求不显示。
  const custom = S.jobGreet?.[j.jobId] || '';
  // 精投（锁公司）模式下公司名可点击 → 官网招聘页 / 搜索兜底（共笔条目 1/2）
  let companyHtml = esc(j.companyName || '');
  if (S.searchMode === 'company' && j.companyName) {
    const c = careersUrlOf(j.companyName);
    if (c) {
      const tip = c.official ? '官网招聘页' : '搜索兜底（未收录官网，Bing 搜索）';
      companyHtml = `<a class="jcompany-link" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="${tip}">${esc(j.companyName)}</a>`;
    }
  }
  el.innerHTML = `
    <label class="jcheck"><input type="checkbox" ${on ? 'checked' : ''}></label>
    <div class="body">
      <div class="jname">${esc(j.jobName)}</div>
      <div class="jcompany">${companyHtml}</div>
      <div class="jsalary">${esc(j.salaryDesc || '薪资面议')}${j.city ? `<span class="jcity">${esc(j.city)}</span>` : ''}</div>
      <div class="jgreet-toggle">单岗位－自定义招呼语 <span class="tri">▾</span></div>
      <textarea class="jgreet" rows="3" hidden>${esc(custom)}</textarea>
    </div>`;

  el.querySelector('input').addEventListener('change', (e) => {
    // 选择不设上限（上限只在发送时按顺序取前 75）；单个勾选随意。
    if (e.target.checked) S.selected.add(j.jobId);
    else S.selected.delete(j.jobId);
    el.classList.toggle('off', !e.target.checked);
    syncGroupChecks();   // 轻量更新各公司组全选框的勾/半选状态，不整列重绘
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
    updateAction();   // 格子内容变化要即时翻转按钮（生成打招呼语 ↔ 一键投递）
  });
  return el;
}

/** 精筛后可见的岗位：岗位名含「任一点亮的子词」(或门)才留。
 *  没有子词可筛(没岗位词)→ 全给；有子词但一个都没点亮 → 0 个。 */
// ── 单批上限：选择不设限，上限只在「生成招呼语/发送」时按显示顺序取前 SEND_CAP 个 ──
const SEND_CAP = () => CONFIG.SOFT_BATCH_LIMIT || 75;
/** 全选当前可见岗位（不封顶，封顶留到发送时）。*/
function selectAllVisible() {
  S.selected = new Set(visibleJobs().map((j) => j.jobId));
}

/** 选中岗位按「界面显示顺序」(分组后的先后)排列的 jobId 列表。*/
function orderedSelectedIds() {
  const shown = visibleJobs();
  const ordered = [];
  if (S.searchMode === 'company' && S.companies.length) {
    const groups = new Map(S.companies.map((c) => [c.name, []]));
    for (const j of shown) { const g = groups.get(companyBucketOf(j)); if (g) g.push(j); }
    for (const [, arr] of groups) ordered.push(...arr);
  } else if (S.positions.length) {
    const groups = new Map(S.positions.map((p) => [p, []]));
    for (const j of shown) { const g = groups.get(bucketOf(j)); if (g) g.push(j); }
    for (const [, arr] of groups) ordered.push(...arr);
  } else {
    ordered.push(...shown);
  }
  return ordered.filter((j) => S.selected.has(j.jobId)).map((j) => j.jobId);
}
/** 本批真正要处理的岗位：按显示顺序取前 SEND_CAP 个（单批上限，防封号）。*/
function batchIds() { return orderedSelectedIds().slice(0, SEND_CAP()); }

/** 本批选中岗位里「招呼语格子还是空的」jobId 列表（用户 2026-10-07 定的判定口径）：
 *  全部有内容 → 按钮是「一键投递」；只要有一个空 → 「生成打招呼语」且只生成空的。
 *  自定义模式填了全局招呼语时，所有格子都算有内容。 */
function emptyGreetIds() {
  const globalFilled = S.greetMode === 'custom' && !!(S.globalGreet || '').trim();
  if (globalFilled) return [];
  return batchIds().filter((id) => !((S.jobGreet?.[id] || '').trim()));
}

function visibleJobs() {
  if (!S.refineTerms || !S.refineTerms.length) return S.jobs;   // 没得筛，全给
  const litPos = new Set(S.refineTerms.filter((t) => t.on).map((t) => t.term));   // 点亮的岗位桶
  if (!litPos.size) return [];   // 一个岗位都不点 = 不显示
  // 按岗位桶筛：岗位落在某个点亮的岗位下才显示。不属于任何选定岗位(其他)的一律不显示。
  return S.jobs.filter((j) => litPos.has(bucketOf(j)));
}

/** 结果页精筛条：子词 chip（点亮=生效，点灭=不要）+ 加词 */
function renderRefineBar() {
  const sec = $('refine-sec');
  if (!sec) return;
  sec.hidden = !(S.jobs && S.jobs.length);   // 有结果就显示
  const box = $('refine-chips');
  box.innerHTML = '';
  const jobs = S.jobs || [];
  // 严格按岗位桶计数：每个岗位只属于一个桶（bucketOf），不再重复计数
  const counts = new Map();
  for (const j of jobs) { const b = bucketOf(j); counts.set(b, (counts.get(b) || 0) + 1); }
  for (const t of (S.refineTerms || [])) {
    const cnt = counts.get(t.term) || 0;
    const chip = document.createElement('span');
    chip.className = 'pill multi' + (t.on ? ' on' : '');
    chip.innerHTML = `${esc(t.term)} <b>${cnt}</b>`;   // 标数量：这个岗位召回了几个
    chip.addEventListener('click', () => { t.on = !t.on; afterRefineChange(); });
    box.appendChild(chip);
  }
  syncRefineToggle();
}
/** 精筛右上角的勾选框 = 控制「所有精筛标签」的全开/全关（不是选岗位）。*/
function syncRefineToggle() {
  const box = $('sel-all'); if (!box) return;
  const terms = S.refineTerms || [];
  const onN = terms.filter((t) => t.on).length;
  box.checked = terms.length > 0 && onN === terms.length;
  box.indeterminate = onN > 0 && onN < terms.length;
}
function afterRefineChange() {
  // 精筛标签变化只改「显示哪些桶」。被隐藏的桶不会进入发送（batchIds 基于可见岗位）。
  // 可见集里新冒出来的岗位默认也选上，省得用户再去挨个勾。
  selectAllVisible();
  renderRefineBar();
  renderJobs();
}

/** 把可见岗位分组：锁定公司模式按公司分；否则按岗位词分。都没有就返回 null（平铺）。
 *  不属于任何选定桶的岗位（companyBucketOf/bucketOf 命中不到）直接丢弃，不再有「其他」组。*/
function jobGroups(shown) {
  if (S.searchMode === 'company' && S.companies.length) {
    const g = new Map(S.companies.map((c) => [c.name, []]));
    for (const j of shown) { const a = g.get(companyBucketOf(j)); if (a) a.push(j); }
    return g;
  }
  if (S.positions.length) {
    const g = new Map(S.positions.map((p) => [p, []]));
    for (const j of shown) { const a = g.get(bucketOf(j)); if (a) a.push(j); }
    return g;
  }
  return null;
}

/** 轻量刷新各公司组全选框的勾/半选状态，不整列重绘（单个岗位勾选后调用）。*/
function syncGroupChecks() {
  const groups = jobGroups(visibleJobs());
  if (!groups) return;
  for (const head of document.querySelectorAll('#job-list .group-head')) {
    const name = head.dataset.group;
    const jobs = groups.get(name) || [];
    const ids = jobs.map((j) => j.jobId);
    const allOn = ids.length > 0 && ids.every((id) => S.selected.has(id));
    const someOn = ids.some((id) => S.selected.has(id));
    const box = head.querySelector('.group-check input');
    if (box) { box.checked = allOn; box.indeterminate = someOn && !allOn; }
  }
}

function renderJobs() {
  const list = $('job-list');
  list.innerHTML = '';
  const shown = visibleJobs();   // 精筛后的集合
  const groups = jobGroups(shown);

  if (groups) {
    S.collapsedGroups = S.collapsedGroups || new Set();
    for (const [name, jobs] of groups) {
      if (!jobs.length) continue;
      const collapsed = S.collapsedGroups.has(name);
      const head = document.createElement('div');
      head.className = 'group-head';
      head.dataset.group = name;
      // 左侧：折叠箭头 + 公司名 + 数量（点这块折叠/展开）；右侧：整组全选框
      const ids = jobs.map((j) => j.jobId);
      const allOn = ids.every((id) => S.selected.has(id));
      const someOn = ids.some((id) => S.selected.has(id));
      head.innerHTML = `<span class="group-left">`
        + `<span class="fold-arrow">${collapsed ? '▸' : '▾'}</span>`
        + `<span class="group-title">${esc(name)} <span class="group-count">${jobs.length}</span></span>`
        + `</span>`
        + `<label class="group-check"><input type="checkbox" ${allOn ? 'checked' : ''}></label>`;
      // 点左半区（箭头/公司名）折叠，点右边的勾选框全选——两者互不干扰
      head.querySelector('.group-left').addEventListener('click', () => {
        if (S.collapsedGroups.has(name)) S.collapsedGroups.delete(name); else S.collapsedGroups.add(name);
        renderJobs();
      });
      const box = head.querySelector('.group-check input');
      box.indeterminate = someOn && !allOn;   // 半选状态
      // 勾选=这家公司可见岗位全选，不勾=全不选。选择不封顶，发送时才按顺序取前 75。
      box.addEventListener('change', (e) => {
        if (e.target.checked) { for (const id of ids) S.selected.add(id); }
        else { for (const id of ids) S.selected.delete(id); }
        renderJobs();
      });
      list.appendChild(head);
      if (!collapsed) for (const j of jobs) list.appendChild(buildJobCard(j));   // 折叠时不渲染卡
    }
  } else {
    for (const j of shown) list.appendChild(buildJobCard(j));
  }

  // 岗位数：精筛收窄后显示「精筛后 N / 共 M」，否则只显示总数
  const shownN = shown.length;
  $('jobs-count').textContent = (shownN !== S.jobs.length)
    ? `精筛后 ${shownN} 个 · 共 ${S.jobs.length}`
    : `${shownN} 个岗位`;
  document.querySelectorAll('#greet-mode .pill').forEach((p) => {
    p.classList.toggle('on', p.dataset.mode === S.greetMode);
  });
  $('global-greet').hidden = S.greetMode !== 'custom';
  syncRefineToggle();
  updateAction();
}

// 精筛右上角勾选框 = 全开/全关所有精筛标签（控制显示哪些岗位桶，不是选岗位）。
$('sel-all').addEventListener('change', (e) => {
  const on = e.target.checked;
  for (const t of (S.refineTerms || [])) t.on = on;
  afterRefineChange();
});

// 「搜索过程与结果」折叠/展开
$('sd-head').addEventListener('click', () => { S.searchDetailOpen = !S.searchDetailOpen; syncSearchDetail(); });

// 改网址：贴公司主页网址 → 抽出 brandId → 下次搜这家直接进这个主页（跳过定位，最稳）
function saveBrandOverrides() { try { chrome.storage.local.set({ 'jt:brandOverrides': S.brandOverrides }); } catch (e) {} }
$('company-status').addEventListener('click', (e) => {
  const btn = e.target.closest('.cs-url');
  if (!btn) return;
  const company = btn.dataset.company;
  const pw = window.prompt('改网址需要密码：');
  if (pw == null) return;
  if (pw.trim() !== '012026') { toast('密码错误，未更改', 3000); return; }
  const v = window.prompt(`贴上「${company}」在 BOSS 的公司主页网址\n（在 BOSS 搜到这家、点进它主页，复制地址栏，形如 .../gongsi/xxxx.html；留空=取消锁定）`, '');
  if (v == null) return;
  const url = v.trim();
  if (!url) { delete S.brandOverrides[company]; saveBrandOverrides(); toast(`已取消「${company}」的主页锁定，恢复自动定位`, 3500); }
  else {
    const m = url.match(/gongsi\/(?:job\/)?([^.?\/]+)\.html/);
    if (!m) { toast('网址里没找到 /gongsi/xxx.html，没改', 4000); return; }
    S.brandOverrides[company] = m[1];
    saveBrandOverrides();
    toast(`已锁定「${company}」的主页，下次搜这家直接进它、跳过定位`, 3800);
  }
  const sub = btn.closest('.cs-sub'); const span = sub && sub.querySelector('.cs-bid');
  if (span) span.textContent = S.brandOverrides[company] ? '已锁定主页 · ' : '';
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
async function runGreeting(onlyIds) {
  // 只生成「空格子」的岗位（用户 2026-10-07 定）：调用方传入空格子列表；
  // 这里再兜底过滤一次，已有内容的绝不重写。本批上限按显示顺序取前 75（静默）。
  const batch = (Array.isArray(onlyIds) ? onlyIds : batchIds())
    .filter((id) => !((S.jobGreet?.[id] || '').trim()));
  if (!batch.length) { updateAction(); return; }
  const batchSet = new Set(batch);
  S.busy = true;
  S.greeting = true;                    // 生成中标记：给「停止」按钮分流用（搜索停止走 stopSearch）
  S.greeted = false;
  S.greetDone = 0;
  S.greetTotal = batch.length;
  $('btn-action').disabled = true;
  $('btn-action').textContent = `生成中 0/${S.greetTotal}…`;
  $('btn-reset').textContent = '停止';   // 生成中「重置」变「停止」（用户 2026-10-08 定）

  // 把本批（空格子）岗位的招呼语框展开，置为「生成中」沙漏态；已填内容的卡片不碰
  for (const el of document.querySelectorAll('#job-list .jcard')) {
    if (!batchSet.has(el.dataset.jobid)) continue;
    const ta = el.querySelector('.jgreet');
    const toggle = el.querySelector('.jgreet-toggle');
    ta.hidden = false;
    if (!ta.value) ta.placeholder = '⏳ 正在生成…';   // 不清 value：有内容的不重写
    toggle.querySelector('.tri').textContent = '▴';
    el.classList.add('generating');
  }

  try {
    await ask(MSG.START_GREETING, {
      jobIds: batch,
      mode: 'ai',
      globalGreet: S.globalGreet || '',
      jobGreet: S.jobGreet || {},
    });
  } catch (e) {
    S.busy = false;
    S.greeting = false;
    $('btn-reset').textContent = '重置';
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
  S.greeting = false;
  S.greeted = true;
  $('btn-reset').textContent = '重置';

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
  if (g.stopped) {
    // 看门狗停的：已生成的都在卡片里，空格子的再点一次「生成打招呼语」就接着生成（只补空格）
    toast('已停止：30 秒没有新进展。已生成的招呼语都留在卡片里，空格子的可再点一次接着生成', 6000);
  } else if (g.failed) {
    const why = (g.lastError || '').slice(0, 60);
    toast(`${g.failed} 条生成失败${why ? `（${why}）` : ''}，用的是兜底语，可手动改`, 6000);
  }
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
  Tracker.track('send_click', { via: 'ai' });   // 埋点：一键投递点击渗透
  S.busy = true;
  S.sending = true;
  S.sendPaused = false;
  S.sentJobIds = new Set();          // 本轮已处理过的岗位（跨暂停/继续累计）
  S.sendBatch = batchIds();          // 本批：按显示顺序取前 75（单批上限）
  S.sendTotal = S.sendBatch.length;  // 这批总数，底部计数用
  if (S.screen !== 'result') showScreen('result');
  $('send-banner').hidden = false;
  $('sendbar-fill').style.width = '0%';
  $('sendbar-phase').textContent = '正在启动投递...';
  enterSendingBar();
  await fireSend(S.sendBatch);
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
  const remaining = (S.sendBatch || batchIds()).filter((id) => !S.sentJobIds.has(id));
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
// 通用提示弹窗：点「知道了」或遮罩关闭
$('alert-ok').addEventListener('click', hideAlert);
$('alert-mask').addEventListener('click', hideAlert);

// 客服反馈提交（需求#5）：自由文本必填 + 联系方式选填，
// 自动带版本号/来源页/时间/设备 ID。存本地 ui:feedback，数据后台只读查看。
$('fb-submit').addEventListener('click', async () => {
  const text = $('fb-text').value.trim();
  if (!text) { toast('先写点内容再提交'); return; }
  try {
    const st = await chrome.storage.local.get(STORE.UI.FEEDBACK);
    const arr = Array.isArray(st[STORE.UI.FEEDBACK]) ? st[STORE.UI.FEEDBACK] : [];
    arr.push({
      ts: Date.now(),
      text,
      contact: $('fb-contact').value.trim(),
      version: chrome.runtime.getManifest().version,
      source: S.screen,
      uid: await Tracker.uid(),
    });
    while (arr.length > (CONFIG.FEEDBACK_MAX || 500)) arr.shift();
    await chrome.storage.local.set({ [STORE.UI.FEEDBACK]: arr });
    $('fb-text').value = '';
    $('fb-contact').value = '';
    toast('已收到，感谢反馈');
  } catch (e) { toast('提交失败，请再试一次'); }
});

// 搜索时长不再让用户调：召回已封顶(单批上限×2≈150)、收够就停，
// S.searchMinutes 只作为一个安全时间上限兜底（见 constants.DEFAULT_SEARCH_MINUTES）。

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
        S.greeting = false;
        $('btn-reset').textContent = '重置';
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

// ════════════════════════════════════════════════════════════
// 使用统计区块已于 2026-10-07 从面板下线（用户定：数据是公司看的，不给用户看）。
// 埋点仍照常采集；公司查看 = 数据后台 admin.html（密码保护，服务抽屉有内部入口）；
// 数据传送 = SW 里每 6 小时 Tracker.flush() 定时上报（配 ANALYTICS_ENDPOINT 后生效）。
// ════════════════════════════════════════════════════════════

(async function boot() {
  // 默认全部「不限」，与同类产品一致。
  // HR 活跃度和工作性质之前是预设好的，现在交还给用户自己点：
  // 预设值会让人以为「我什么都没选」，实际上池子已经被悄悄收窄了。

  const st = await chrome.storage.local.get([STORE.UI.FILTER_STATE, 'jt:brandOverrides']);   // jt:searchOverrides 已随改搜索词功能撤除（2026-10-08），旧键残留无害不再读
  const saved = st[STORE.UI.FILTER_STATE];
  if (saved) {
    S.searchMode = saved.searchMode || 'position';
    S.companies = saved.companies || [];
    S.cities = saved.cities || [];
    S.positions = saved.positions || [];
    S.filters = saved.filters || S.filters;
  }
  // 城市码自愈（2026-10-06 修过 苏州/无锡/合肥/东莞 四个错码）：历史存档里的选中项
  // 可能还带着错码，按 label 对齐内置表纠正一次，免得旧错码继续被发给后台。
  const CODE_BY_LABEL = Object.fromEntries([...HOT_CITIES, ...MORE_CITIES].map((c) => [c.label, c.code]));
  S.cities = S.cities.map((c) => (CODE_BY_LABEL[c.label] && CODE_BY_LABEL[c.label] !== c.code)
    ? { ...c, code: CODE_BY_LABEL[c.label] } : c);
  // 城市规则对齐（2026-10-07 用户定）：全国与具体城市互斥；一个都不选时自动补全国；
  // 工作区域只展最后选择的城市，清掉存档里不属于当前展示城市的已选区名
  if (S.cities.some((c) => c.code !== ALL_COUNTRY.code)) {
    S.cities = S.cities.filter((c) => c.code !== ALL_COUNTRY.code);
  }
  if (!S.cities.length) S.cities = [{ ...ALL_COUNTRY }];
  {
    const dn = currentDistrictNames();
    S.filters.businessDistrict = (S.filters.businessDistrict || []).filter((v) => dn.includes(v));
  }
  S.brandOverrides = st['jt:brandOverrides'] || {};
  // 搜索时长固定，不再从存储读用户值

  renderUploads();
  renderMode();
  renderCompanies(); renderCompanyChips();
  renderCityQuick(); renderCityChips();
  renderPositionResult(''); renderPositionChips();
  renderFilters();
  updateAction();

  Tracker.track('panel_open');   // 埋点：使用日活（打开面板即算活跃；面板不展示统计，数据进本地队列+定时上报）

  // 埋点（2026-10-08 碎片数据方案）：
  // ① 按钮点击全局委托——所有 <button> 和 id 以 btn- 开头的元素，点击即记一条
  //    button_click（name 取元素 id，没有 id 取按钮文本前 20 字），后台按 name 分组计数。
  document.addEventListener('click', (e) => {
    try {
      const el = e.target && e.target.closest ? e.target.closest('button,[id^="btn-"]') : null;
      if (!el) return;
      const name = el.id || (el.textContent || '').trim().slice(0, 20);
      if (name) Tracker.track('button_click', { name });
    } catch (err) { /* 静默 */ }
  }, true);
  // ② 在线心跳——面板开着每 60 秒记一条 online_tick（sec=60），后台累加即总在线时长。
  //    面板关闭 JS 即停，天然不多算；事件持久化在本地，断网不丢。
  setInterval(() => { try { Tracker.track('online_tick', { sec: 60 }); } catch (err) { /* 静默 */ } }, 60000);

  try {
    const r = await ask(MSG.GET_RESUME);
    S.resumeImages = r.images || [];
    S.resumeText = r.text || '';
    if (S.resumeImages.length) {
          $set('ocr-status', S.resumeText ? `已读取 ${S.resumeText.length} 字` : '已保存图片，生成时自动读取');
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
