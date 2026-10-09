// ════════════════════════════════════════════════════════════════
// 闪投 · 通用工具（content / SW / panel 三方共用）
// ════════════════════════════════════════════════════════════════

const U = {
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  /** 闭区间随机整数。投递间隔靠它制造节奏抖动，固定值最容易被识别 */
  randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  },

  now() {
    return Date.now();
  },

  /** 本地自然日 YYYY-MM-DD。额度按本地日归零，不用 UTC */
  today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  /**
   * 岗位名归一化。去重 L2 的指纹依赖它。
   * 不做归一化的话，「AI产品经理（急招）」和「AI产品经理」会被判成两个岗位，
   * L2 大面积漏判。
   */
  normalizeJobName(name) {
    return String(name || '')
      // 各类括号及其内容：（急招）(J10086)【双休】
      .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
      // 届别
      .replace(/\b(20)?2\d届/g, '')
      .replace(/(校招|社招|实习生招聘)/g, '')
      // 招聘话术
      .replace(/(急聘|急招|高薪|诚聘|直招|大量招|双休|包住|包吃)/g, '')
      // base 地标注
      .replace(/base\s*[一-龥a-z]+/gi, '')
      // 全角转半角 + 去空白
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\s·、,，\/-]+/g, '')
      .toLowerCase()
      .trim();
  },

  /** 薪资文案 → {min, max, months}，单位 K。解析不出返回全 null */
  parseSalary(desc) {
    const s = String(desc || '');
    const range = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[kK]/);
    const months = s.match(/·?\s*(\d+)\s*薪/);
    if (!range) return { min: null, max: null, months: null };
    return {
      min: parseFloat(range[1]),
      max: parseFloat(range[2]),
      months: months ? parseInt(months[1], 10) : 12,
    };
  },

  /** 薪资区间归一到档位，用于指纹。避免 30-50K 和 30-50K·15薪 被判成两个岗位 */
  salaryBucket(min, max) {
    if (min == null || max == null) return 'na';
    return `${Math.round(min / 5) * 5}-${Math.round(max / 5) * 5}`;
  },

  /** FNV-1a 32 位。指纹用，不需要密码学强度，要的是快和稳定 */
  hash(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  },

  /**
   * 去重 L2 指纹：公司 + 归一化岗位名 + 城市 + 薪资档
   * 抓「岗位下架重发换了 ID」这种情况
   */
  fingerprint(job) {
    return U.hash([
      job.companyId || job.companyName || '',
      U.normalizeJobName(job.jobName),
      job.city || '',
      U.salaryBucket(job.salaryMin, job.salaryMax),
      // C 方案（用户 2026-10-09）：加上 HR。同岗不同 HR = 不同的坑，都投；
      // 只有「同岗 + 同 HR」才判为同一条重复挂牌。HR 用 hrId，拿不到就用 HR 名兜底。
      job.hrId || job.hrName || '',
    ].join('|'));
  },

  /**
   * JD 文本的 3-gram 集合。去重 L3 用。
   * 中文没有天然词边界，3-gram 比分词稳，也不需要引词典。
   */
  shingles(text, n = 3) {
    const t = String(text || '').replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
    return set;
  },

  /** Jaccard 相似度。同公司内 JD 超阈值判为同一个坑 */
  jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    for (const x of small) if (large.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  },

  /** 从详情页链接里取 encryptJobId */
  jobIdFromLink(link) {
    const m = String(link || '').match(/job_detail\/([^.?/]+)\.html/);
    return m ? m[1] : '';
  },

  /** 当前是否在禁投时段 */
  inForbiddenHours() {
    return CONFIG.FORBIDDEN_HOURS.includes(new Date().getHours());
  },

  /**
   * 带并发上限的批量执行。打分和招呼语生成都要用。
   * 保证结果顺序与输入一致，失败项返回 {ok:false, error}，不中断整批。
   */
  async mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          results[i] = { ok: true, value: await fn(items[i], i) };
        } catch (e) {
          results[i] = { ok: false, error: String(e && e.message || e) };
        }
      }
    });
    await Promise.all(workers);
    return results;
  },

  /** 给任意 promise 加超时。LLM 调用必须包一层，否则一个卡住的请求拖死整批 */
  withTimeout(promise, ms, label = 'timeout') {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
    ]);
  },
};
