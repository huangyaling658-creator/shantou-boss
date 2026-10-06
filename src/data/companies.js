// ════════════════════════════════════════════════════════════════
// 闪投 · 内置公司库（第一批，边用边补）
// ────────────────────────────────────────────────────────────────
// aliases 是「只投大厂」这件事成败的关键。字节在 BOSS 上可能是「字节跳动」
// 「抖音」「巨量引擎」等多个独立主体号，靠公司名模糊匹配一定漏人。
// brandId 是平台内部 ID，无法预先写死，首次勾选时运行时解析并缓存。
// n = 显示名（给用户看，可用好认的品牌名）；s = 搜索名（后台定位 brandId 用，必须是 BOSS 上
//   收得住的名字，没写则用 n）。两者分开：显示亲切、定位可靠。
// url = 官网招聘页（共笔条目 1/2 引入，2026-10-07 逐家联网核验）。
//   优先自有域名社招页，其次公司专属 Moka/飞书托管页；查无可靠入口的公司不写 url，
//   点击公司名时自动回退 Bing 搜索「公司名 官网 招聘」（tooltip 区分「官网」与「搜索兜底」）。
//   集团归属映射：汽水音乐→字节招聘、陆金所→平安集团招聘、Lazada→阿里集团招聘。
// ════════════════════════════════════════════════════════════════

const COMPANY_LIB = [
  // ── 大厂主体 ──
  { g: '大厂', n: '字节跳动', url: 'https://jobs.bytedance.com/', a: ['字节跳动', '抖音', '巨量引擎', '火山引擎', '今日头条', '飞书', 'TikTok', '剪映'] },
  { g: '大厂', n: '腾讯', url: 'https://careers.tencent.com/', a: ['腾讯', '腾讯科技', '腾讯音乐', 'QQ音乐', '腾讯云', '微信'] },
  { g: '大厂', n: '阿里巴巴', url: 'https://talent.alibaba.com/', a: ['阿里巴巴', '淘宝', '天猫', '阿里云', '钉钉', '夸克', '闲鱼', '高德'] },
  { g: '大厂', n: '蚂蚁集团', url: 'https://talent.antgroup.com/off-campus-position', a: ['蚂蚁集团', '蚂蚁科技', '支付宝'] },
  { g: '大厂', n: '快手', url: 'https://zhaopin.kuaishou.cn/', a: ['快手', '北京快手', '快手科技'] },
  { g: '大厂', n: '小红书', url: 'https://job.xiaohongshu.com/', a: ['小红书', '行吟信息', '行吟'] },
  { g: '大厂', n: '百度', url: 'https://talent.baidu.com/', a: ['百度', '百度在线', '小度', '度小满'] },
  { g: '大厂', n: '美团', url: 'https://zhaopin.meituan.com/', a: ['美团', '美团点评', '大众点评'] },
  { g: '大厂', n: '京东', url: 'https://zhaopin.jd.com/', a: ['京东', '京东科技', '京东物流', '京东健康'] },
  { g: '大厂', n: '拼多多', url: 'https://help.pinduoduo.com/recruit/delivery.html', a: ['拼多多', 'Temu', '寻梦信息'] },
  { g: '大厂', n: '网易', url: 'https://hr.163.com/', a: ['网易', '网易云音乐', '网易有道', '网易伏羲'] },
  { g: '大厂', n: '哔哩哔哩', url: 'https://jobs.bilibili.com/', a: ['哔哩哔哩', 'B站', 'bilibili'] },
  { g: '大厂', n: '滴滴', url: 'https://talent.didiglobal.com/', a: ['滴滴', '滴滴出行', '小桔科技'] },
  { g: '大厂', n: '携程', url: 'https://careers.ctrip.com/', a: ['携程', 'Trip.com', '去哪儿'] },
  { g: '大厂', n: '微博', url: 'https://career.sina.com.cn/', a: ['微博', '新浪', '新浪微博'] },
  { g: '大厂', n: '知乎', url: 'https://www.zhihu.com/careers', a: ['知乎', '智者四海'] },
  { g: '大厂', n: '贝壳', url: 'https://join.ke.com/', a: ['贝壳找房', '链家'] },
  { g: '大厂', n: '满帮', url: 'https://jobs.fulltruckalliance.com/', a: ['满帮', '运满满', '货车帮'] },

  // ── AI 模型公司 ──
  { g: 'AI模型', n: '月之暗面', url: 'https://careers.kimi.com/', a: ['月之暗面', 'Kimi', 'Moonshot'] },
  { g: 'AI模型', n: '智谱AI', s: '智谱华章', url: 'https://www.zhipuai.cn/zh/joinus', a: ['智谱华章', '智谱', '智谱AI', 'ChatGLM', 'Z.ai'] },
  { g: 'AI模型', n: 'MiniMax', url: 'https://www.minimax.io/careers', a: ['MiniMax', '稀宇科技', '海螺', '星野', 'Talkie'] },
  { g: 'AI模型', n: '阶跃星辰', a: ['阶跃星辰', 'StepFun'] }, // 官网无独立社招页，走搜索兜底
  { g: 'AI模型', n: 'DeepSeek', s: '深度求索', url: 'https://talent.deepseek.com/', a: ['深度求索', 'DeepSeek', '杭州深度求索人工智能基础技术研究有限公司', '幻方'] },
  { g: 'AI模型', n: '百川智能', url: 'https://careers.baichuan-inc.com/', a: ['百川智能', 'Baichuan'] },
  { g: 'AI模型', n: '零一万物', url: 'https://01.ai/careers.html', a: ['零一万物', '01.AI'] },
  { g: 'AI模型', n: '生数科技', a: ['生数科技', 'Vidu'] }, // 官网无招聘页，走搜索兜底
  { g: 'AI模型', n: '爱诗科技', url: 'https://pixverse.ai/zh/careers', a: ['爱诗科技', 'PixVerse'] },
  { g: 'AI模型', n: '商汤', url: 'https://hr.sensetime.com/', a: ['商汤', '商汤科技', 'SenseTime'] },
  { g: 'AI模型', n: '旷视', url: 'https://www.megvii.com/about/join-us', a: ['旷视', '旷视科技', 'Megvii'] },
  { g: 'AI模型', n: '出门问问', url: 'https://www.chumenwenwen.com/recruit/index', a: ['出门问问', 'Mobvoi'] },
  { g: 'AI模型', n: '面壁智能', a: ['面壁智能', 'ModelBest'] }, // 官网无招聘页（仅邮箱投递），走搜索兜底
  { g: 'AI模型', n: '无问芯穹', url: 'https://www.infinigence-ai.com/join-usnow.html', a: ['无问芯穹', 'Infinigence'] },

  // ── 音乐与泛娱乐 ──
  { g: '音乐泛娱乐', n: '腾讯音乐', url: 'https://join.tencentmusic.com/social', a: ['腾讯音乐', 'TME', 'QQ音乐', '酷狗', '酷我', '全民K歌'] },
  { g: '音乐泛娱乐', n: '网易云音乐', url: 'https://hr.163.com/product.html/music', a: ['网易云音乐', '杭州网易云音乐'] },
  { g: '音乐泛娱乐', n: '汽水音乐', url: 'https://jobs.bytedance.com/', a: ['汽水音乐', '字节音乐'] }, // 字节旗下，走字节招聘
  { g: '音乐泛娱乐', n: '喜马拉雅', url: 'https://jobs.ximalaya.com/', a: ['喜马拉雅', '喜马拉雅FM'] },
  { g: '音乐泛娱乐', n: '荔枝', url: 'https://jobs.lizhiinc.com/', a: ['荔枝', '荔枝FM', 'Lizhi'] },
  { g: '音乐泛娱乐', n: '小宇宙', url: 'https://okjike.com/careers', a: ['小宇宙', '即刻'] },
  { g: '音乐泛娱乐', n: '爱奇艺', url: 'https://careers.iqiyi.com/', a: ['爱奇艺', 'iQIYI'] },
  { g: '音乐泛娱乐', n: '芒果TV', url: 'https://hr.mgtv.com/', a: ['芒果TV', '芒果超媒'] },
  { g: '音乐泛娱乐', n: '阅文集团', url: 'https://join.yuewen.com/social', a: ['阅文', '阅文集团', '起点'] },

  // ── 游戏与内容 ──
  { g: '游戏内容', n: '米哈游', url: 'https://jobs.mihoyo.com/', a: ['米哈游', 'miHoYo', 'HoYoverse'] },
  { g: '游戏内容', n: '莉莉丝', url: 'https://jobs.lilith.com/', a: ['莉莉丝', 'Lilith'] },
  { g: '游戏内容', n: '叠纸游戏', url: 'https://career.papegames.com/', a: ['叠纸', '叠纸游戏', '叠纸网络'] },
  { g: '游戏内容', n: '三七互娱', url: 'https://zhaopin.37.com/', a: ['三七互娱', '37手游'] },
  { g: '游戏内容', n: '完美世界', url: 'https://jobs.games.wanmei.com/', a: ['完美世界'] },
  { g: '游戏内容', n: '游卡', url: 'https://campus.yokaverse.com/', a: ['游卡', '游卡网络'] }, // 校招页（官网仅有此招聘入口）
  { g: '游戏内容', n: '鹰角网络', url: 'https://career.hypergryph.com/', a: ['鹰角', '鹰角网络', '明日方舟'] },

  // ── 硬件与制造 ──
  { g: '硬件制造', n: '华为', url: 'https://career.huawei.com/reccampportal/portal5/social-recruitment.html', a: ['华为', '华为技术', '海思'] },
  { g: '硬件制造', n: '小米', url: 'https://hr.xiaomi.com/job', a: ['小米', '小米科技', '北京小米'] },
  { g: '硬件制造', n: '大疆', url: 'https://we.dji.com/zh-CN/social', a: ['大疆', 'DJI', '深圳市大疆'] },
  { g: '硬件制造', n: 'OPPO', url: 'https://career.oppo.com/', a: ['OPPO', '欧珀'] },
  { g: '硬件制造', n: 'vivo', url: 'https://hr.vivo.com/', a: ['vivo', '维沃'] },
  { g: '硬件制造', n: '比亚迪', url: 'https://job.byd.com/portal/pc/#/social/socialMainPageSocial', a: ['比亚迪', 'BYD'] },
  { g: '硬件制造', n: '宁德时代', url: 'https://talent.catl.com/', a: ['宁德时代', 'CATL'] },
  { g: '硬件制造', n: '理想汽车', url: 'https://www.lixiang.com/employ/social.html', a: ['理想汽车', '北京车和家'] },
  { g: '硬件制造', n: '蔚来', url: 'https://www.nio.cn/careers', a: ['蔚来', 'NIO'] },
  { g: '硬件制造', n: '小鹏汽车', url: 'https://social.xiaopeng.com/', a: ['小鹏汽车', '广州橙行'] },
  { g: '硬件制造', n: '影石Insta360', url: 'https://www.insta360.com/cn/jobs', a: ['影石', 'Insta360'] },

  // ── 金融科技与 SaaS ──
  { g: '金融SaaS', n: '金山办公', url: 'https://join.wps.cn/', a: ['金山办公', 'WPS', '珠海金山'] },
  { g: '金融SaaS', n: '金蝶', url: 'https://www.kingdee.com/job', a: ['金蝶', '金蝶软件'] },
  { g: '金融SaaS', n: '用友', url: 'https://career.yonyou.com/', a: ['用友', '用友网络'] },
  { g: '金融SaaS', n: '明源云', url: 'http://zhaopin.mingyuanyun.com/', a: ['明源云'] },
  { g: '金融SaaS', n: '有赞', url: 'https://job.youzan.com/', a: ['有赞', '白鸦'] },
  { g: '金融SaaS', n: '微盟', url: 'https://job.weimob.com/talent/society', a: ['微盟', 'Weimob'] },
  { g: '金融SaaS', n: '陆金所', url: 'https://talent.pingan.com/', a: ['陆金所', '平安科技'] }, // 平安系，走平安集团招聘
  { g: '金融SaaS', n: '同花顺', url: 'https://job.10jqka.com.cn/', a: ['同花顺', '浙江核新'] },

  // ── 出海 ──
  { g: '出海', n: 'SHEIN', url: 'https://careers.shein.cn/', a: ['SHEIN', '希音', '广州希音'] },
  { g: '出海', n: 'Lazada', url: 'https://careers.alibaba.com/', a: ['Lazada'] }, // 阿里旗下，走阿里集团招聘
  { g: '出海', n: 'Shopee', url: 'https://careers.shopee.cn/', a: ['Shopee', '虾皮'] },
  { g: '出海', n: '赤子城', a: ['赤子城', 'SoulGate'] }, // 未核验到可靠官网招聘页，走搜索兜底
  { g: '出海', n: '欢聚集团', url: 'https://hr.joyy.com/', a: ['欢聚', 'JOYY', 'BIGO', 'YY'] },
  { g: '出海', n: 'Soul', url: 'https://soulapp.jobs.feishu.cn/', a: ['Soul', '上海任意门'] }, // 公司专属飞书招聘托管页
];

/** 分组顺序，决定面板上的展示次序 */
const COMPANY_GROUPS = ['大厂', 'AI模型', '音乐泛娱乐', '游戏内容', '硬件制造', '金融SaaS', '出海'];
