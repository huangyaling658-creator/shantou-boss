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
  COMPANY_APPLY_FILTERS: 'COMPANY_APPLY_FILTERS',  // 精投布置：点公司页筛选下拉（城市/经验/学历/薪资），点不上跳「全部/不限」交本地过滤
  DRIVE_HOME_SEARCH: 'DRIVE_HOME_SEARCH', // 海投 v2：驱动 BOSS 首页搜索框搜词（真人链路第 2 步）
  SCROLL_RESET: 'SCROLL_RESET',         // 海投 v2：清空滚动读卡状态（换词/换城时）
  COLLECT_ONE_SCROLL: 'COLLECT_ONE_SCROLL', // 海投 v2 单步：读新增卡→滚一屏，节拍由 SW 全局闸掐
  APPLY_FILTER: 'APPLY_FILTER',         // 【已停用 2026-10-08】海投点击版布置：点结果页筛选项。布置改网址后不再调用，处理器留档
  APPLY_CITY: 'APPLY_CITY',             // 【已停用 2026-10-08】海投点击版布置地点：点城市选择器。用户实测 jobs 页吃 city 参数，改 URL 布置
  READ_CITY_CHIP: 'READ_CITY_CHIP',     // 【已停用 2026-10-08】读城市 chip 文本（配合 APPLY_CITY 校验用），随点击版一起退役
  COMPANY_CLICK_CARD: 'COMPANY_CLICK_CARD',  // 精投真人链路：结果页点卡片左下角公司名进公司页（attempt=第几个候选）
  READ_COMPANY_HEADER: 'READ_COMPANY_HEADER', // 精投：读公司页页头公司名（核对是否进对门，SW 轮询用）
  COMPANY_CLICK_JOBS_TAB: 'COMPANY_CLICK_JOBS_TAB', // 精投：点公司页「招聘职位」tab 进职位列表
  COMPANY_JOBS_READY: 'COMPANY_JOBS_READY',  // 精投：职位列表是否就绪（页内「查找职位」搜索框出现）
  COMPANY_BOX_ENSURE: 'COMPANY_BOX_ENSURE',  // 精投：布置后检查搜索框，被清空则补填重搜（先搜词再布置的配套）
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
    RESUME_IMAGES: 'sw:resumeImages',   // [{dataUrl, name, ocrDone}]，最多 10 张
    FILTER_DICT: 'sw:filterDict',       // 从 BOSS 页面抓来的筛选项字典 + 抓取时间
  },
  UI: {
    PANEL_TAB: 'ui:panelTab',
    FILTER_STATE: 'ui:filterState',
    COMPANY_GROUPS: 'ui:companyGroups',
    ANALYTICS: 'ui:analytics',              // 埋点事件数组（本地后台）
    ANALYTICS_UPLOADED: 'ui:analyticsUploaded', // 云端上报游标（方案 B 预留）
    INSTALL_ID: 'ui:installId',             // 匿名安装 ID（算日活去重用，非个人资料）
    FEEDBACK: 'ui:feedback',                // 客服反馈数组（自由文本+版本/来源页/时间/设备ID）
    ADMIN_PASS: 'ui:adminPass',             // 数据后台口令的 SHA-256（不存明文）
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
    // 公司简介页：用户贴公司主页网址的精投单元直达用（2026-10-08 真人链路：其余单元一律首页走进去）
    // brandId 结尾常带 ~，不能被转义，所以直接拼接、不走 encodeURIComponent
    COMPANY: (brandId) => `https://www.zhipin.com/gongsi/${brandId}.html`,
    // 招聘职位页直达（2026-10-08 用户定：列表网址一律用招聘職位頁形態）：贴网址/列表命中
    // 时开这个核对页头，省「简介页→职位页」一次导航。搜索流程仍靠点卡自然进、不改。
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
  MAX_PAGES: 15,                  // 海投翻页上限（约15/页 → 单搜最多 ~450，够到 BOSS 单搜天花板）
  // 精投公司页「每个岗位词」翻页上限：6~12 页随机（2026-10-09 收紧）。
  // 现在是在公司页搜索框里真正搜某个岗位词，返回的是已过滤的结果、数量很少（通常 1~3 页），
  // 翻不了几页就到底/没新增而自然停。上限不必大，压到 6~12 省时间、也更不像机器。
  COMPANY_PAGES_MIN: 6,
  COMPANY_PAGES_MAX: 12,
  // 精投每家公司「过滤后」目标召回量（2026-10-09 用户定）：
  // 每家攒够 50 个符合岗位的岗就停这家，三家合计 150；单家也按 50 算。
  // 攒不够就一直翻到页数上限/翻到底为止（宁可多翻，不凑开发岗充数）。
  COMPANY_KEPT_PER_COMPANY: 50,
  PARALLEL_COMPANIES: 8,          // 精投并行上限：每轮最多 8 个页面同时采（brandId 解析也按这个并行）
  // 全同步模式的「冷却时间」：每家公司各翻各的，翻一页后独立随机睡 [4+N, (4+N)×2] 秒，
  // N = 当前还在跑的家数。并行越多间隔越宽，总速率自己踩刹车（全局逼近每 1.5 秒一个封顶）；
  // 有公司收完 N 变小，剩下的自动提速。精确到 0.01 秒。
  TASK_HARD_TIMEOUT_MS: 300000,   // 5 分钟硬封顶：总时长到点就停，把已收的落库展示
  // ↓ 旧的全局队列冷却 / 按并行数间隔，全同步上线后不再用（留给老路径兜底）
  COOLDOWN_MIN_MS: 3000,               // 面板耗时预估用的冷却均值（与全局行为闸 3~4 秒对齐，2026-10-08 随精投闸 3~4 秒同步改）
  COOLDOWN_MAX_MS: 4000,
  PARALLEL_INTERVAL: { 1: [4000, 6000], 2: [5000, 7000], 3: [6000, 8000], 4: [6000, 8000] },
  COLLECT_CAP_PER_SEARCH: 450,    // 单个「关键词×城市」最多收这么多（≈BOSS 单搜天花板 ~300-450）
  // 堆量模式：先把池子搞大(单搜到顶 + 多词×多城叠加)，再靠精筛收窄到 ~75。
  RECALL_TARGET_JOBS: 800,
  // 召回封顶：反正单批只投 SOFT_BATCH_LIMIT(75) 个，召回到它的这个倍数就够精筛挑了，
  // 再多纯属拖时间。海投按「每岗位词」封顶、精投按「每公司」封顶（见 service-worker）。
  // 想要更全就调大倍数，想更快就调小（1 = 只收刚好够一批）。
  RECALL_CAP_MULTIPLIER: 2,       // 召回上限 = SOFT_BATCH_LIMIT × 2 ≈ 150
  // 搜索时长：产品定好的标准值，不再暴露给用户调。召回封顶后搜索会「收够即停」，
  // 这个分钟数只当安全时间上限（兜底防卡死）+ 行为预算(分钟×ACTIONS_PER_MINUTE)。
  DEFAULT_SEARCH_MINUTES: 3,
  // 列表翻页间隔。固定节奏像机器、容易被判频繁，改成区间随机抖动，更像人、更不触限流。
  // 实测 1.2 秒几页就被封；拉到 4.5~7 秒随机，慢一点但稳。
  PAGE_REQUEST_INTERVAL_MS: 3500,       // 兜底/非翻页场景仍用它
  PAGE_INTERVAL_MIN_MS: 4000,           // 翻页最小间隔 4 秒
  PAGE_INTERVAL_MAX_MS: 6000,           // 翻页最大间隔 6 秒（4~6 秒随机，精确到 0.01 秒）
  TURN_GATE_MIN_MS: 3000,               // 全局行为闸（精投·搜）：每 3~4 秒随机放行一个翻页行为（用户 2026-10-08 由 4~6 改 3~4，与海投一致）
  TURN_GATE_MAX_MS: 4000,
  HAITOU_TURN_GATE_MIN_MS: 3000,        // 全局行为闸（海投）：每 3~4 秒随机放行一个滚动行为（用户 2026-10-07 由 4~5 改 3~4）
  HAITOU_TURN_GATE_MAX_MS: 4000,
  ACTIONS_PER_MINUTE: 20,               // 行为预算：每分钟 20 个行为（3 分钟 = 60 个。2026-10-06 定 12，10-08 改 17，10-08 晚再改 20 配 3 分钟=60 个，闸仍 3~4 秒——预算是上限不是配速）
  COMPANY_LAYOUT_MIN_MS: 500,           // 精投布置闸（公司页四下拉）：每个动作 0.5~1.5 秒随机（用户 2026-10-08 定；海投布置仍走 HAITOU_LAYOUT_* 1~2 秒）
  COMPANY_LAYOUT_MAX_MS: 1500,
  HAITOU_MAX_TABS: 5,                   // 海投 v2：一城一标签，最多 5 城并行（用户定的上限）
  HAITOU_STOP_MINUTES: 3,               // 海投中止条件①：3 分钟硬闸（用户 2026-10-07 定）
  HAITOU_MAX_RESULTS: 150,              // 海投中止条件②：收满 150 个结果即停（用户 2026-10-07 定）
  HAITOU_MAX_ACTIONS: 60,               // 海投中止条件③：满 60 个行为即停（用户 2026-10-07 定）；三者任一先到即停，冷却时间不受影响
  // ── 拟人化的分页开关间隔（精投/海投共用）──
  // 原则：这类行为要模仿人类——人不会同一秒连开 5 个分页，也不会用完瞬间关掉。
  TAB_OPEN_MIN_MS: 1000,                // 开页闸：每开一个分页全局隔 1~2 秒随机，轮流开不突刺
  TAB_OPEN_MAX_MS: 2000,
  TAB_CLOSE_MIN_MS: 1000,               // 关页延迟：用完隔 1~2 秒随机再关（2026-10-08 用户由 1~3 收紧），且异步不阻塞下一个
  TAB_CLOSE_MAX_MS: 2000,
  HAITOU_LAYOUT_MIN_MS: 1000,           // 海投布置闸：每个单元开分页前过一道，1~2 秒随机（用户 2026-10-07 由 2~3 改 1~2）；
  HAITOU_LAYOUT_MAX_MS: 2000,           // 10-08 布置改网址后只剩「开分页」这一个用途；精投开页仍走 TAB_OPEN_* 不变
  ROUND_INTERVAL_MS: 6000,        // 换一组搜索条件之间的停顿
  MAX_PARALLEL_TABS: 4,           // 并行搜索的标签页上限（对齐即投：一城一页并行）
  CANDIDATE_CAP: 300,             // 廉价过滤后送去拉 JD 的上限
  REVIEW_POOL_SIZE: 800,          // 结果列表最多显示这么多（堆量模式，配合精筛收窄）
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
  // 2026-10-08 起改走统一后台中转：插件不持 key，请求发给 api.santaya.chat，
  // 由服务器贴上管理员在后台填入的 DashScope 密钥再转发。模型/提示词/参数全不变。
  LLM_ENDPOINT: 'https://api.santaya.chat/v1/ai/shantou',
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
  GREETING_STALL_MS: 30000,       // 生成看门狗（用户 2026-10-07 定）：30 秒没有新招呼语产出就停止整批，已生成的保留
  JD_FETCH_TIMEOUT_MS: 20000,     // 抓岗位详情 HTML 的超时。之前这段无超时，被风控挂起时 5 个 worker 全卡死、面板永远 0/N
  PING_TIMEOUT_MS: 5000,          // ping 标签页 content script 的超时。2026-10-08 坑：页面被冻结/风控卡死时监听还在但永不响应，不带超时会整批无声停摆
  TAB_ENSURE_TIMEOUT_MS: 30000,   // ensureBossTab 整体兜底超时。超时后生成流程降级为「跳过抓 JD 照样生成」，投递流程报错收场
  OCR_TIMEOUT_MS: 60000,

  GREETING_MIN_LEN: 350,
  GREETING_MAX_LEN: 650,

  // 简历
  RESUME_IMAGE_MAX: 10,
  RESUME_IMAGES_PER_SEND: 2,

  // 埋点（只保三个数据：日活、海投/精投点击渗透、投递点击渗透）
  ANALYTICS_ENDPOINT: 'https://api.santaya.chat/v1/ingest/shantou',  // 统一平台接收接口（唯写）。空 = 仅本地储存；配上即自动批量上报
  ANALYTICS_FLUSH_BATCH: 10,    // 本地攒够 N 条未上报事件就触发一次批量上报
  ANALYTICS_IDLE_FLUSH_MS: 10000, // 或：最后一次行为后 N 毫秒无新行为也触发上报（2026-10-08 用户定）
  // 以上两个条件任一满足即上报；都不满足时仍有 6 小时闹钟/下次启动补发兜底，数据不丢
  ANALYTICS_MAX_EVENTS: 5000,   // 本地事件封顶，先进先出
  FEEDBACK_MAX: 500,            // 客服反馈本地封顶，先进先出
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
