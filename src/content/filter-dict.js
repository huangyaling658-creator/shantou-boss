// ════════════════════════════════════════════════════════════════
// 闪投 · 筛选项字典
// ────────────────────────────────────────────────────────────────
// 面板上的每个筛选项最终要变成 BOSS 搜索 URL 上的一个参数（如 degree=203）。
// 这些 code 是平台内部编码，硬编码有两个风险：猜错了会静默搜出错误结果，
// 平台改版了也不会报错，只会「搜到的岗位莫名其妙变少」。
//
// 所以策略是三层：
//   1. 优先从 BOSS 搜索页自己的筛选器 DOM 里抓（页面上每个筛选按钮都带着
//      真实 code，这是最可靠的来源）
//   2. 城市和职位走平台字典接口（数据量大，DOM 上只渲染热门项）
//   3. 都拿不到才用内置兜底表，并在界面上标注「未经验证」
// ════════════════════════════════════════════════════════════════

const FilterDict = {

  /** 面板上要呈现的筛选维度。key 就是 BOSS 搜索 URL 的参数名 */
  FIELDS: [
    // position 是搜索页顶部「全部(2120) 技术(1134) 产品(387)」那排 tab。
    // 它带着平台真实的职位类型码，比 expectposition.json 更可靠，
    // 因为那个接口的返回结构会随版本变，而 tab 链接上的参数是所见即所得。
    { key: 'position', label: '职位类型' },
    { key: 'experience', label: '工作经验' },
    { key: 'degree', label: '学历要求' },
    { key: 'salary', label: '薪资待遇' },
    { key: 'scale', label: '公司规模' },
    { key: 'stage', label: '融资阶段' },
    { key: 'jobType', label: '工作性质' },
    { key: 'industry', label: '公司行业' },
  ],

  /**
   * 内置兜底表。
   * ⚠️ 这批 code 来自 BOSS 搜索 URL 的常见取值，未经本项目实测验证。
   * 只在 DOM 抓取失败时启用，且界面上会标注来源，避免把猜测当成事实用。
   */
  FALLBACK: {
    experience: [
      { code: '102', label: '经验不限' }, { code: '101', label: '应届生' },
      { code: '103', label: '在校生' }, { code: '104', label: '1年以内' },
      { code: '105', label: '1-3年' }, { code: '106', label: '3-5年' },
      { code: '107', label: '5-10年' }, { code: '108', label: '10年以上' },
    ],
    degree: [
      { code: '201', label: '学历不限' }, { code: '202', label: '大专' },
      { code: '203', label: '本科' }, { code: '204', label: '硕士' },
      { code: '205', label: '博士' }, { code: '206', label: '高中' },
      { code: '208', label: '中专/中技' }, { code: '209', label: '初中及以下' },
    ],
    salary: [
      { code: '402', label: '3K以下' }, { code: '403', label: '3-5K' },
      { code: '404', label: '5-10K' }, { code: '405', label: '10-20K' },
      { code: '406', label: '20-50K' }, { code: '407', label: '50K以上' },
    ],
    scale: [
      { code: '301', label: '0-20人' }, { code: '302', label: '20-99人' },
      { code: '303', label: '100-499人' }, { code: '304', label: '500-999人' },
      { code: '305', label: '1000-9999人' }, { code: '306', label: '10000人以上' },
    ],
    stage: [
      { code: '801', label: '未融资' }, { code: '802', label: '天使轮' },
      { code: '803', label: 'A轮' }, { code: '804', label: 'B轮' },
      { code: '805', label: 'C轮' }, { code: '806', label: 'D轮及以上' },
      { code: '807', label: '已上市' }, { code: '808', label: '不需要融资' },
    ],
    jobType: [
      { code: '1901', label: '全职' }, { code: '1902', label: '兼职' },
      { code: '1903', label: '实习' },
    ],
    industry: [],
  },

  /**
   * 从当前页面的筛选器 DOM 抓取真实 code。
   *
   * BOSS 的筛选器在不同版本里渲染方式不同，所以三种策略都试：
   *   a) 带 href 的链接，参数直接写在 URL 上（最理想）
   *   b) 带 data-* 属性的元素
   *   c) 点击后写入 URL 的 SPA 组件（抓不到，交给兜底表）
   */
  scrape() {
    const dict = {};
    const sources = {};

    // ── 策略 a：从筛选区的链接 href 上取 ──
    const anchors = document.querySelectorAll('a[href*="/web/geek/jobs?"], a[href*="/web/geek/job?"]');
    for (const a of anchors) {
      const label = (a.textContent || '').trim();
      if (!label || label.length > 12) continue;
      let url;
      try { url = new URL(a.getAttribute('href'), location.origin); } catch (e) { continue; }

      for (const { key } of this.FIELDS) {
        const v = url.searchParams.get(key);
        if (!v) continue;
        // 当前页面 URL 上已有的同名参数是「继承来的」，不是这个按钮代表的值
        const inherited = new URL(location.href).searchParams.get(key);
        if (v === inherited) continue;

        dict[key] = dict[key] || [];
        if (!dict[key].some((o) => o.code === v)) {
          dict[key].push({ code: v, label });
          sources[key] = 'dom';
        }
      }
    }

    // ── 策略 b：从 data-* 属性取 ──
    if (Object.keys(dict).length === 0) {
      const items = document.querySelectorAll('[data-val], [data-code], [data-value]');
      for (const el of items) {
        const code = el.getAttribute('data-val') || el.getAttribute('data-code') || el.getAttribute('data-value');
        const label = (el.textContent || '').trim();
        if (!code || !label || label.length > 12) continue;
        // 靠所属筛选区块的标题推断这是哪个维度
        const section = el.closest('[class*="filter"], [class*="condition"], dl, .search-condition');
        const title = section ? (section.querySelector('dt, [class*="label"], [class*="title"]')?.textContent || '').trim() : '';
        const field = this.FIELDS.find((f) => title.includes(f.label.slice(0, 2)));
        if (!field) continue;
        dict[field.key] = dict[field.key] || [];
        if (!dict[field.key].some((o) => o.code === code)) {
          dict[field.key].push({ code, label });
          sources[field.key] = 'dom';
        }
      }
    }

    // ── 兜底 ──
    for (const { key } of this.FIELDS) {
      if (!dict[key] || dict[key].length === 0) {
        dict[key] = this.FALLBACK[key] || [];
        sources[key] = dict[key].length ? 'fallback' : 'empty';
      }
    }

    return { dict, sources, scrapedAt: Date.now() };
  },

  /** 城市字典。数据量大，DOM 上只渲染热门城市，走平台接口拿全量 */
  async cities() {
    const res = await fetch(BOSS.ORIGIN + BOSS.API.CITY_DICT, { credentials: 'same-origin' });
    const json = await res.json();
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.code && n.name) out.push({ code: String(n.code), label: n.name });
        if (n.subLevelModelList) walk(n.subLevelModelList);
      }
    };
    walk(json?.zpData?.cityList || json?.zpData?.hotCityList || []);
    // 「全国」在 BOSS 上是一个特殊城市码，放在最前
    return [{ code: '100010000', label: '全国' }, ...out];
  },

  /**
   * 期望职位字典。
   *
   * 不按固定字段路径取，而是把整个响应深度遍历一遍，凡是同时带 code 和
   * name（或 label）的对象就收下。原因：这个接口的嵌套结构随版本变过，
   * 写死 zpData.positionList 这种路径，平台一改就静默返回空数组，
   * 表现是「职位类型解析不到」，但不报错，极难排查。
   */
  async positions() {
    const res = await fetch(BOSS.ORIGIN + BOSS.API.POSITION_DICT, { credentials: 'same-origin' });
    const json = await res.json();

    const out = [];
    const seen = new Set();
    const walk = (node, depth = 0) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
      if (typeof node !== 'object') return;

      const code = node.code ?? node.positionCode ?? node.id;
      const label = node.name || node.label || node.positionName;
      if (code != null && typeof label === 'string' && label && !seen.has(String(code))) {
        seen.add(String(code));
        out.push({ code: String(code), label });
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(json?.zpData ?? json);
    return out;
  },

  /**
   * 把面板上的筛选条件拼成 BOSS 搜索页 URL。
   *
   * ★ 关键设计：我们拼的是「页面 URL」，不是「API 请求」。
   *   导航过去之后由 BOSS 自己根据 URL 发出正确的列表请求，嗅探器再捕获它
   *   当翻页模板。这样我们只需要知道 URL 参数名，不需要知道 API 请求体里
   *   那些无法复现的内部字段（securityId、场景标识等）。
   */
  buildSearchUrl(filters) {
    const u = new URL(BOSS.ORIGIN + BOSS.PAGE.JOBS);
    if (filters.query) u.searchParams.set('query', filters.query);
    if (filters.city) u.searchParams.set('city', filters.city);
    for (const { key } of this.FIELDS) {
      const v = filters[key];
      if (v) u.searchParams.set(key, Array.isArray(v) ? v.join(',') : v);
    }
    return u.toString();
  },
};
