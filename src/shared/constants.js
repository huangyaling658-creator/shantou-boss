// ════════════════════════════════════════════════════════════════
// 闪投 · 全局常量（单一真相源）
// ────────────────────────────────────────────────────────────────
// 本文件同时被三处加载，三方共用同一份定义，不存在「镜像」问题：
//   1. content script  —— manifest content_scripts.js 数组首位
//   2. service worker  —— importScripts()（故 SW 不能用 type:module）
//   3. side panel      —— panel.html 的 <script src>
// 顶层 const 会进入各自 realm 的全局词法环境，同 realm 内其他脚本可直接引用。
// ════════════════════════════════════════════════════════════════

// ── 消息类型（panel ↔ SW ↔ content）──
const MSG = {
  // panel → SW
  GET_STATE: 'GET_STATE',
  SAVE_CONFIG: 'SAVE_CONFIG',
  START_RECALL: 'START_RECALL',
  CLASSIFY_POSITIONS: 'CLASSIFY_POSITIONS',   // 岗位词→BOSS职位类目 语义归类（LLM兜底）
  START_GREETING: 'START_GREETING',     // 为已选岗位批量生成招呼语（立即返回，进度走广播）
  GET_TASK: 'GET_TASK',                 // 面板重连时拉一次当前任务状态
  GET_QUOTA: 'GET_QUOTA',               // 今日投递数量
  UPDATE_GREETING: 'UPDATE_GREETING',   // 手改或重生成单条
  START_SEND: 'START_SEND',             // 一键投递
  STOP_TASK: 'STOP_TASK',
  QUERY_JOBS: 'QUERY_JOBS',
  EXPORT_DATA: 'EXPORT_DATA',
  RESOLVE_BRAND: 'RESOLVE_BRAND',
  GET_FILTER_DICT: 'GET_FILTER_DICT',   // 取筛选项字典（没有则现抓）
  SAVE_RESUME_IMAGES: 'SAVE_RESUME_IMAGES', // 存简历截图并触发 OCR
  GET_RESUME: 'GET_RESUME',
  SUGGEST_POSITIONS: 'SUGGEST_POSITIONS', // 让模型读简历推荐岗位词

  // SW → panel（广播）
  STATE_UPDATE: 'STATE_UPDATE',
  TASK_PROGRESS: 'TASK_PROGRESS',
  GREETING_ITEM: 'GREETING_ITEM',   // 单岗位招呼语生成完成（就地填卡片）
  TASK_ERROR: 'TASK_ERROR',

  // SW → content
  PING: 'PING',
  COLLECT_PAGES: 'COLLECT_PAGES',   // 复放 joblist 请求翻页采集
  FETCH_JD: 'FETCH_JD',
  READ_JD: 'READ_JD',   // 读当前已打开详情页的 JD 正文             // 拉单个岗位 JD 全文
  SEARCH_BRAND: 'SEARCH_BRAND',     // 按公司名查 BOSS 品牌库
  COMPANY_BOX_SEARCH: 'COMPANY_BOX_SEARCH',  // 驱动公司主页「查找职位关键词」框搜索
  COMPANY_DOM_COLLECT: 'COMPANY_DOM_COLLECT',  // 直接读公司招聘页的岗位卡片（不抓接口）
  COMPANY_DOM_PAGE: 'COMPANY_DOM_PAGE',  // 单步：翻一页(可选)+读这一页的卡，由 SW 全局调度
  CHECK_RISK: 'CHECK_RISK',         // 读页面上的验证码/风控迹象
  GREETING_SWITCH: 'GREETING_SWITCH',   // 读写 BOSS 自带招呼语开关
  OPEN_DETAIL: 'OPEN_DETAIL',           // 打开岗位详情页并读沟通按钮文案
  CLICK_CHAT: 'CLICK_CHAT',             // 点「立即沟通」
  SEND_CHAT: 'SEND_CHAT',               // 在聊天页发文本 + 图片
  SCRAPE_FILTERS: 'SCRAPE_FILTERS', // 从 BOSS 搜索页 DOM 抓筛选项字典（含平台内部 code）
  NAVIGATE_SEARCH: 'NAVIGATE_SEARCH', // 按面板筛选条件导航页面，让 BOSS 自己发对的请求

  // content → SW
  CS_READY: 'CS_READY',
  COLLECT_PROGRESS: 'COLLECT_PROGRESS',
  RISK_DETECTED: 'RISK_DETECTED',
};

// ── DOM 属性名：MAIN world 嗅探器 → ISOLATED world 采集器 的传递通道 ──
// MAIN 和 ISOLATED 两个世界无法直接通信，唯一共享的是同一棵 DOM 树。
// 嗅探器把捕获到的请求模板写进 documentElement 的属性，采集器轮询读取。
const DOM_BRIDGE = {
  JOBLIST_REQ: 'data-jt-joblist-req',   // 岗位列表请求模板 {url, method, body, kind}
  JOBLIST_META: 'data-jt-joblist-meta', // encryptJobId → 列表页额外字段的映射
  JOBLIST_PAGE1: 'data-jt-joblist-page1', // 页面自己第 1 页的原始岗位数组（避免我们重复请求第 1 页触发风控）
  LAST_ERROR: 'data-jt-last-error',     // 页面自身请求返回的 BOSS 错误码（如 code:37）
};

// ── chrome.storage key（sw: / ui: 前缀隔离）──
const STORE = {
  SW: {
    CONFIG: 'sw:config',
    TASK: 'sw:task',
    API_KEY: 'sw:apiKey',
    RESUME_TEXT: 'sw:resumeText',
    QUOTA: 'sw:quota',
    RISK_LOG: 'sw:riskLog',
    BRAND_CACHE: 'sw:brandCache',
    RESUME_IMAGES: 'sw:resumeImages',   // [{dataUrl, name, ocrDone}]，最多 10 张
    FILTER_DICT: 'sw:filterDict',       // 从 BOSS 页面抓来的筛选项字典 + 抓取时间
  },
  UI: {
    PANEL_TAB: 'ui:panelTab',
    FILTER_STATE: 'ui:filterState',
    COMPANY_GROUPS: 'ui:companyGroups',
  },
};

// ── BOSS 接口（同源、cookie 自动鉴权、无签名）──
const BOSS = {
  ORIGIN: 'https://www.zhipin.com',
  API: {
    SEARCH_JOBLIST: '/wapi/zpgeek/search/joblist.json',
    RECOMMEND_JOBLIST: '/wapi/zpgeek/pc/recommend/job/list.json',
    CITY_DICT: '/wapi/zpgeek/common/data/city.json',
    POSITION_DICT: '/wapi/zpgeek/common/data/expectposition.json',
    BUSINESS_DISTRICT: '/wapi/zpgeek/businessDistrict.json',
    USER_INFO: '/wapi/zpuser/wap/getUserInfo.json',
    GREETING_LIST: '/wapi/zpchat/greeting/getGreetingList',
    GREETING_UPDATE: '/wapi/zpchat/greeting/updateGreetingV2',
    UPLOAD: '/wapi/zpupload/quicklyUpload',
    FRIEND_LIST: '/wapi/zprelation/friend/getGeekFriendList.json',
  },
  PAGE: {
    JOBS: '/web/geek/jobs',
    CHAT: '/web/geek/chat',
    JOB_DETAIL: (id) => `https://www.zhipin.com/job_detail/${id}.html`,
    // 公司简介页（没有搜索框和职位列表）——保留但精投不用它
    COMPANY: (brandId) => `https://www.zhipin.com/gongsi/${brandId}.html`,
    // 公司「招聘职位」筛选页：这里才有「查找职位关键词」框 + 职位列表(company/job/list)
    // brandId 结尾常带 ~，不能被转义，所以直接拼接、不走 encodeURIComponent
    // ?ka=company-jobs：对齐用户点「招聘职位」tab 的真实来源标记，更自然、也确保进职位态
    COMPANY_JOBS: (brandId) => `https://www.zhipin.com/gongsi/job/${brandId}.html?ka=company-jobs`,
  },
  // BOSS 业务错误码
  CODE: {
    OK: 0,
    SOFT_BLOCK: 37,   // 频率过高软封锁。实测取 JD 间隔 1.5s 会触发，3s 安全
  },
};

// ── 运行参数 ──
const CONFIG = {
  // 召回
  MAX_PAGES: 6,                   // 海投翻页上限（精投用下面的 8~10 随机）
  COMPANY_PAGES_MIN: 10,          // 精投公司页每词翻页：10~15 页随机
  COMPANY_PAGES_MAX: 15,
  PARALLEL_COMPANIES: 4,          // 精投同时在采几家公司（池子大小；多出来的排队，谁先完谁补位）
  // 冷却时间：全局翻页节拍。无论几家在采，任意两次翻页之间全局至少隔这么久（随机，精确到 0.01 秒）。
  // 效果：任意时刻只有一个请求在飞、均匀无突刺，这是躲限流(code:37)最理想的请求形状。
  COOLDOWN_MIN_MS: 2000,          // 冷却下限 2.00 秒
  COOLDOWN_MAX_MS: 6000,          // 冷却上限 6.00 秒
  // ↓ 旧的「每家各自 sleep」间隔，全局冷却上线后不再用（留着给老的 COMPANY_DOM_COLLECT 兜底）
  PARALLEL_INTERVAL: { 1: [4000, 6000], 2: [5000, 7000], 3: [6000, 8000], 4: [6000, 8000] },
  COLLECT_CAP_PER_SEARCH: 225,    // 单个关键词最多收这么多就停（配合 10~15 页，约15/页）
  // 召回到这么多个岗位就够了，不再往下翻。
  // 依据：一天只投 75 个，审核池 120 个，召回 400 个足够筛选后还有富余。
  // 不做成用户可调项：多召回的部分最后都会被截断丢掉，只是徒增请求量和风控风险。
  RECALL_TARGET_JOBS: 400,
  // 列表翻页间隔。固定节奏像机器、容易被判频繁，改成区间随机抖动，更像人、更不触限流。
  // 实测 1.2 秒几页就被封；拉到 4.5~7 秒随机，慢一点但稳。
  PAGE_REQUEST_INTERVAL_MS: 3500,       // 兜底/非翻页场景仍用它
  PAGE_INTERVAL_MIN_MS: 4000,           // 翻页最小间隔 4 秒
  PAGE_INTERVAL_MAX_MS: 6000,           // 翻页最大间隔 6 秒（4~6 秒随机，精确到 0.01 秒）
  ROUND_INTERVAL_MS: 6000,        // 换一组搜索条件之间的停顿
  MAX_PARALLEL_TABS: 4,           // 并行搜索的标签页上限（对齐即投：一城一页并行）
  CANDIDATE_CAP: 300,             // 廉价过滤后送去拉 JD 的上限
  REVIEW_POOL_SIZE: 200,          // 结果列表最多显示这么多，别把搜到的截断在几十个
  CHANNEL_A_MAX_COMPANIES: 30,    // 超过此数从「公司页遍历」切到「词搜+本地过滤」
  BACKFILL_MIN_JOBS: 3,           // 某公司召回少于此数则追加补漏

  // JD 抓取
  JD_FETCH_INTERVAL_MS: 3000,     // ★ 硬线。1.5s 实测触发 code:37，不得调低
  JD_TEXT_MAX_LEN: 4000,

  // 投递
  SOFT_BATCH_LIMIT: 75,           // 单批上限
  DAILY_SEND_LIMIT: 150,          // 单日累计红线
  SEND_INTERVAL_MIN_MS: 2000,
  SEND_INTERVAL_MAX_MS: 4000,
  BATCH_SIZE: 50,                 // 每投这么多个休息一次
  BATCH_REST_MS: 90000,
  FORBIDDEN_HOURS: [0, 1, 2, 3, 4, 5, 6],  // 禁止投递的时段（凌晨特征太明显）

  // 打分
  SCORE_WEIGHTS: { duty: 0.35, skill: 0.30, industry: 0.20, level: 0.15 },
  SCORE_FLOOR: 60,                // 地板分，低于此绝不投
  SCORE_TIERS: [90, 80, 70, 60],  // 分档凑满的降档顺序

  // 风控退避
  RISK_WINDOW_MS: 12 * 60 * 60 * 1000,
  RISK_SLOW_MULTIPLIER: 2,        // 触发 1 次 → 间隔翻倍
  RISK_STOP_THRESHOLD: 2,         // 触发 ≥2 次 → 拒绝整批

  // ── 模型（统一用通义千问 DashScope，一个 key 跑文本 + 视觉）──
  // 为什么不用 DeepSeek：产品第一步就是让用户上传简历截图，而 DeepSeek 是
  // 纯文本模型读不了图。简历图必须先 OCR 成文本才能喂给打分和招呼语，
  // 用同一家的视觉模型最省事，不用再接第二个厂商的 key。
  //
  // ⚠️ 模型名会随厂商迭代变更（DeepSeek 就在 2026-07 停用过 deepseek-chat，
  // 传旧名直接 400）。这三个名字是可调项，调用失败时会把厂商返回的原始
  // 错误信息透出到界面上，好让「模型名过期」这种问题一眼看出来。
  LLM_ENDPOINT: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  // 2026-09-16 实测结果（账号处于「仅使用免费额度」模式）：
  //   qwen-vl-plus  ✅ 可用，OCR 质量够，项目名和数字都能完整保留
  //   qwen-plus     ✅ 可用
  //   qwen-vl-max   ❌ 免费额度已耗尽（403 AllocationQuota.FreeTierOnly）
  //   qwen-max      ❌ 同上
  // 所以 max 档暂时用不了。若将来账号充值或关掉「仅免费额度」开关，
  // 把 MODEL_GREETING 换成 qwen-max 能提升招呼语质量，其余不用动。
  MODEL_VISION: 'qwen-vl-plus',   // 简历截图 OCR，只在换简历时跑一次
  MODEL_SCORE: 'qwen-plus',       // 四维打分，一天 75 到 300 次
  MODEL_GREETING: 'qwen-plus',    // 招呼语。qwen-max 更好但当前额度进不去
  LLM_CONCURRENCY: 3,
  GREETING_CONCURRENCY: 5,        // 招呼语并发工作池大小（每个 worker 抓JD+生成）
  LLM_TIMEOUT_MS: 30000,
  OCR_TIMEOUT_MS: 60000,

  GREETING_MIN_LEN: 350,
  GREETING_MAX_LEN: 650,

  // 简历
  RESUME_IMAGE_MAX: 10,
  RESUME_IMAGES_PER_SEND: 2,
};

// ── 岗位生命周期状态机 ──
const JOB_STATE = {
  RECALLED: 'recalled',    // 已召回
  FILTERED: 'filtered',    // 已过廉价过滤
  SCORED: 'scored',        // 已四维打分
  GREETED: 'greeted',      // 已生成招呼语
  CONFIRMED: 'confirmed',  // 用户已勾选
  SENT: 'sent',            // 已投递
  SKIPPED: 'skipped',      // 已跳过
  FAILED: 'failed',        // 投递失败
};

// ── 跳过原因 ──
const SKIP_REASON = {
  DUP_L1: 'duplicate_job_id',
  DUP_L2: 'duplicate_fingerprint',
  DUP_L3: 'duplicate_jd',
  ALREADY_CHATTED: 'already_chatted',   // 详情页按钮显示「继续沟通」
  HR_COOLDOWN: 'hr_cooldown',
  QUOTA_EXCEEDED: 'quota_exceeded',
  BELOW_FLOOR: 'below_score_floor',
  HARD_RULE: 'hard_rule_reject',
  HEADHUNTER: 'headhunter_job',
  NOT_IN_WHITELIST: 'not_in_company_whitelist',
};

// ── 出厂兜底招呼语（LLM 全链路失败时才用）──
const FALLBACK_GREETING =
  '您好，我看了这个岗位的职责描述，和我过往做的事情比较对得上，已附上简历，想跟您聊聊。';
