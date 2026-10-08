// ════════════════════════════════════════════════════════════════
// boss公司頁網址 列表（2026-10-08 用户定）
// ────────────────────────────────────────────────────────────────
// 公司名/别名 → BOSS 公司页网址。精投定位公司先查这张表：
//   命中   → 跳过「首页搜索 → 点卡 → 核对页头」，直接用 brandId 拼职位页 URL 开工；
//   没命中 → 照旧走搜索流程（首页搜 → 点卡 → 核对），行为不变。
// 优先级：面板手动贴网址（改网址功能 brandOverrides）> 本表 > 搜索流程。
//
// ⚠ 铁律：条目必须有出处（用户实测/提供的真实网址），不得编造 brandId——
//    编了就是定位到错公司。新增条目时在 url 注释里写明出处。
//
// 2026-10-08 用户截图指定候选公司全集（分类与名单照截图）：
//   除字节/腾讯外 url 一律留空 ''，由用户慢慢填；空网址条目查表视为未命中，
//   照旧走搜索流程，不会影响任何现有行为。
//   填法：把 url: '' 换成「招聘职位页」网址（2026-10-08 用户定，统一用这形态）：
//   'https://www.zhipin.com/gongsi/job/{brandId}.html?ka=company-jobs'，
//   并把出处注释改成实际来源。names 第一个写主名（与任务库公司名一致），
//   需要别名/英文名再往后加。（简介页形态 /gongsi/{brandId}.html 也认，但推荐职位页）
// ════════════════════════════════════════════════════════════════

const COMPANY_URL_LIST = [
  // ── 大厂（18）──
  { names: ['字节跳动', '字节', 'ByteDance', 'bytedance'], url: 'https://www.zhipin.com/gongsi/job/f409f37f83a6135b0nV_2d25EA~~.html?ka=company-jobs' },   // 出处：2026-10-08 用户抓样本
  { names: ['腾讯', 'Tencent', 'tencent'], url: 'https://www.zhipin.com/gongsi/job/64bfe11d3d8b5b6e1XV629u4F1A~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['阿里巴巴'], url: 'https://www.zhipin.com/gongsi/job/5d627415a46b4a750nJ9.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['蚂蚁集团'], url: 'https://www.zhipin.com/gongsi/job/4685d74590e9bc881nV43N-4EVo~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['快手'], url: 'https://www.zhipin.com/gongsi/job/480261c022ea03d81nV53tQ~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['小红书'], url: 'https://www.zhipin.com/gongsi/job/e57e6ccdcd0e71850Xx-2N-9Eg~~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['百度'], url: 'https://www.zhipin.com/gongsi/job/ab9fdc6f043679990HY~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['美团'], url: 'https://www.zhipin.com/gongsi/job/b633a34f787d94f21nZ_0929E1I~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['京东集团', '京东'], url: 'https://www.zhipin.com/gongsi/job/ffeedb3e4763f3891HN_0921FFQ~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供（京东集团页；「京东」单名默认归此页）
  { names: ['拼多多'], url: 'https://www.zhipin.com/gongsi/job/f3ff4c336c3e739103By0ti0E1U~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['网易'], url: 'https://www.zhipin.com/gongsi/job/38bd5c757efa4ab6331z.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['哔哩哔哩', 'B站', 'bilibili'], url: 'https://www.zhipin.com/gongsi/job/5bfc56c0e972e7c41Xx-3A~~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['滴滴'], url: 'https://www.zhipin.com/gongsi/job/8548fadc0b5c265403V93t61EQ~~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['携程'], url: 'https://www.zhipin.com/gongsi/job/ef2ede3e92bf51f91nV72966ElM~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['微博'], url: 'https://www.zhipin.com/gongsi/job/f3e62b9ed1bfa70b1nNy09w~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['知乎'], url: 'https://www.zhipin.com/gongsi/job/8372b71df55405071nJ52Nu9.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['贝壳'], url: 'https://www.zhipin.com/gongsi/job/1a273aa156f51c001nVz09y1Flc~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['满帮'], url: 'https://www.zhipin.com/gongsi/job/9ea9a955b7b33c1a03V62dW9EVU~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供

  // ── AI模型（14）──
  { names: ['月之暗面', 'Moonshot', 'Kimi'], url: 'https://www.zhipin.com/gongsi/job/f0fe9220123c051b03152d-4FVI~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['智谱AI', '智谱'], url: 'https://www.zhipin.com/gongsi/job/18815b858c0b88250nd72N66Fw~~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['MiniMax', 'minimax'], url: 'https://www.zhipin.com/gongsi/job/2c7c394fdf91db2d1XR42dy0EFo~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供
  { names: ['阶跃星辰'], url: 'https://www.zhipin.com/gongsi/job/0591ce5cac2618c303N43dm0F1o~.html?ka=company-jobs' },   // 待填
  { names: ['DeepSeek', '深度求索'], url: 'https://www.zhipin.com/gongsi/job/ffd531b0cbd4133f1XN92Nm0EFU~.html?ka=company-jobs' },   // 待填
  { names: ['百川智能'], url: 'https://www.zhipin.com/gongsi/job/8d42a94fe13be56c03N43t-7GVU~.html?ka=company-jobs' },   // 待填
  { names: ['零一万物'], url: 'https://www.zhipin.com/gongsi/job/6604fa28d0b480c11X1y09-6FFc~.html?ka=company-jobs' },   // 待填
  { names: ['生数科技'], url: 'https://www.zhipin.com/gongsi/job/f7c9e38b0683800a1Xx-2tW5FFY~.html?ka=company-jobs' },   // 待填
  { names: ['爱诗科技'], url: 'https://www.zhipin.com/gongsi/job/846753040df0fa341XJ83NS0FFQ~.html?ka=company-jobs' },   // 待填
  { names: ['商汤'], url: 'https://www.zhipin.com/gongsi/job/bf15d825d6d786d833dz2tu8Fw~~.html?ka=company-jobs' },   // 待填
  { names: ['旷视'], url: 'https://www.zhipin.com/gongsi/job/075e0d17cd137e971nV43NU~.html?ka=company-jobs' },   // 待填
  { names: ['出门问问'], url: 'https://www.zhipin.com/gongsi/job/1f115e0fa9d1944a1nFz39u_.html?ka=company-jobs' },   // 待填
  { names: ['面壁智能'], url: 'https://www.zhipin.com/gongsi/4d17ac830d700dea1XZ_3dq1FVU~.html?from=top-card' },   // 待填
  { names: ['无问芯穹'], url: 'https://www.zhipin.com/gongsi/job/75e9c4e4f7940ab41XNz2dm-FVI~.html?ka=company-jobs' },   // 待填

  // ── 音乐泛娱乐（9）──
  { names: ['腾讯音乐', 'TME'], url: 'https://www.zhipin.com/gongsi/job/58c878aa23085dec1XB70tm1FFI~.html?ka=company-jobs' },   // 待填
  { names: ['网易云音乐'], url: 'https://www.zhipin.com/gongsi/4cd458bd743625a11Xdy0t61.html?from=top-card' },   // 待填
  { names: ['汽水音乐'], url: 'https://www.zhipin.com/gongsi/job/f409f37f83a6135b0nV_2d25EA~~.html?ka=company-jobs' },   // 待填
  { names: ['喜马拉雅'], url: '' },   // 待填
  { names: ['荔枝'], url: '' },   // 待填
  { names: ['小宇宙'], url: '' },   // 待填
  { names: ['爱奇艺'], url: 'https://www.zhipin.com/gongsi/job/ab0ee64deb5cf6fe1HB609u5FFc~.html?ka=company-jobs' },   // 待填
  { names: ['芒果TV', '芒果'], url: 'https://www.zhipin.com/gongsi/job/d619057f23faadf233F70tw~.html?ka=company-jobs' },   // 待填
  { names: ['阅文集团', '阅文'], url: 'https://www.zhipin.com/gongsi/0a68dd7f498a6f181XV63N24E1M~.html?from=top-card' },   // 待填

  // ── 游戏内容（7）──
  { names: ['米哈游'], url: 'https://www.zhipin.com/gongsi/job/9f8c95b92321a8e11nJz2Nu7.html?ka=company-jobs' },   // 待填
  { names: ['莉莉丝'], url: '' },   // 待填
  { names: ['叠纸游戏', '叠纸'], url: '' },   // 待填
  { names: ['三七互娱'], url: '' },   // 待填
  { names: ['完美世界'], url: '' },   // 待填
  { names: ['游卡'], url: '' },   // 待填
  { names: ['鹰角网络', '鹰角'], url: '' },   // 待填

  // ── 硬件制造（截图可见 5/11，其余 6 家待用户补名单）──
  { names: ['华为'], url: 'https://www.zhipin.com/gongsi/job/02cd05cce753437e33V50w~~.html?ka=company-jobs' },   // 待填
  { names: ['小米'], url: 'https://www.zhipin.com/gongsi/job/6f1aa1d6b1d033ad33B43N0~.html?ka=company-jobs' },   // 待填
  { names: ['大疆', 'DJI'], url: 'https://www.zhipin.com/gongsi/job/05457bddad04a8e61nxy3tu7.html?ka=company-jobs' },   // 待填
  { names: ['OPPO', 'oppo'], url: 'https://www.zhipin.com/gongsi/job/cd2e2ae2dcc391380HZ82Q~~.html?ka=company-jobs' },   // 待填
  { names: ['vivo'], url: 'https://www.zhipin.com/gongsi/job/71f70f7aa52429bd33R43d28.html?ka=company-jobs' },   // 待填

  // ── 額外記錄（2026-10-08 用户定）──
  // 不作为面板选项按钮展示的公司（面板按钮由 src/data/companies.js 决定，跟本文件无关）。
  // 用户在插件上「打字搜」的公司名也会查本表（面板打字公司同样进 config.companies →
  // SW 查 companyUrlLookup），所以这里记的条目打字即直达，不用占按钮位。
  { names: ['京东物流'], url: 'https://www.zhipin.com/gongsi/job/951e8bf16e0821e40HR909i1Fw~~.html?ka=company-jobs' },   // 出处：2026-10-08 用户提供（用户确认此页是京东物流）

  // ── 格式模板（新增条目复制这段，names 第一个写主名）──
  // {
  //   names: ['公司名', '别名1', '英文名'],
  //   url: 'https://www.zhipin.com/gongsi/{brandId}.html',   // 出处：日期 + 来源
  // },
];

/**
 * 查表：候选名（公司名/搜寻名/别名）任一命中 → { brandId, url, matched }；没命中 → null。
 * 比对规则：去空白 + 小写后全等（不做互含——短名互含会误命中别家）。
 * 空网址（待填）条目视为未命中，照旧走搜索流程。
 */
function companyUrlLookup(names) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const wants = (names || []).map(norm).filter(Boolean);
  if (!wants.length) return null;
  for (const ent of COMPANY_URL_LIST) {
    if (!(ent.names || []).some((n) => wants.includes(norm(n)))) continue;
    const m = String(ent.url || '').match(/gongsi\/(?:job\/)?(?:c\d+\/)?([^.\/?]+)\.html/);
    if (m && m[1]) return { brandId: m[1], url: ent.url, matched: ent.names[0] };
    // 名字命中但网址待填：明确返回 null，走搜索流程
  }
  return null;
}
