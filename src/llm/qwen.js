// ════════════════════════════════════════════════════════════════
// 闪投 · 模型调用层（通义千问 DashScope，OpenAI 兼容模式）
// ────────────────────────────────────────────────────────────────
// 2026-10-08 起：插件不再持有 key（防偷 key 的定稿方案——「key 不出门，
// 请求送来服务器」）。请求发给统一后台 api.santaya.chat/v1/ai/shantou，
// 由服务器贴 key 转发 DashScope，响应原样传回。模型/提示词/参数全不变，
// 效果与直连一致；secrets.js 里的 QWEN_KEY 从此空置即可。
//
// 模型分工（以 src/shared/constants.js 的实际配置为准，此处为快照 2026-10-08）：
//   qwen-vl-plus 简历截图 OCR（MODEL_VISION，只在换简历时跑一次）
//   qwen-plus    四维打分（MODEL_SCORE，量大，选便宜快的）
//   qwen-plus    招呼语（MODEL_GREETING——注意：qwen-max 效果更好，
//                但该 DashScope 账号「仅免费额度」模式下 qwen-max/qwen-vl-max
//                的免费额度已耗尽（403 FreeTierOnly），充值/关闭该模式后
//                把 constants.js 的 MODEL_GREETING 改回 qwen-max 即可启用）
// 中转接口的模型白名单已包含全部 4 个型号，升级时平台侧无需改动。
//
// 走接口抽象，将来要换厂商或改走自己的网关，只需另写一个同形状的对象。
// ════════════════════════════════════════════════════════════════

const LLM = {

  /**
   * 通用对话调用。
   * 失败时把厂商返回的原始错误信息带出去，不吞掉。
   * 模型名会随厂商迭代过期（DeepSeek 就在 2026-07 停用过旧名），
   * 到时候这条原始信息是唯一能让人一眼看懂问题的东西。
   */
  async chat({ model, messages, temperature = 0.7, jsonMode = false, timeoutMs }) {
    const body = { model, messages, temperature };
    if (jsonMode) body.response_format = { type: 'json_object' };
    // 中转要求带安装 ID（8 位匿名 ID），服务器据此验身份、记调用次数
    body.uid = await Tracker.uid();

    const doFetch = fetch(CONFIG.LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const res = await U.withTimeout(doFetch, timeoutMs || CONFIG.LLM_TIMEOUT_MS, 'llm_timeout');

    if (!res.ok) {
      let detail = '';
      try {
        const err = await res.json();
        detail = err?.error?.message || err?.message || JSON.stringify(err).slice(0, 300);
      } catch (e) {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`模型调用失败 ${res.status}：${detail}`);
    }

    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new Error('模型返回内容为空');
    return text;
  },

  /**
   * 简历截图 → 文本。
   *
   * 一次把所有截图塞进同一轮对话，而不是每张单独 OCR 再拼接：
   * 简历的信息是跨页连续的（第一页的项目标题、第二页的项目细节），
   * 分开识别会丢掉这种关联，模型也无法判断哪些是页眉页脚噪声。
   */
  async ocrResume(dataUrls) {
    const content = [
      {
        type: 'text',
        text: [
          '这是一份求职简历的截图，可能有多页。请把其中的文字完整转写成结构化纯文本。',
          '',
          '要求：',
          '1. 保留原有的板块结构（基本信息、工作经历、项目经历、技能、教育背景等），用小标题分隔',
          '2. 完整保留所有具体的数字、项目名称、公司名称、时间范围，这些是后续判断岗位匹配度的关键依据，一个都不能丢',
          '3. 不要做任何总结、润色或补充，只做转写',
          '4. 忽略页眉页脚、页码、装饰性图形',
          '5. 直接输出转写结果，不要写任何开场白或说明',
        ].join('\n'),
      },
      ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];

    return this.chat({
      model: CONFIG.MODEL_VISION,
      messages: [{ role: 'user', content }],
      temperature: 0.1,   // 转写任务，不要发挥
      timeoutMs: CONFIG.OCR_TIMEOUT_MS,
    });
  },

  /**
   * 四维打分。这是闪投区别于海投工具的核心。
   *
   * 三个设计要点：
   * 1. 拆四维打分，不出单一总分。总分不可解释，用户看不出「为什么 87」，
   *    也没法知道该调哪个权重。
   * 2. 每维强制给出「JD 原句 + 简历原句」的证据配对。没有证据的分数一律
   *    不可信，这是压制幻觉最有效的一招，顺带把界面上的展示需求解决了。
   * 3. 强制输出短板。只会夸的模型给不出有区分度的分数，所有岗位都是 85。
   *
   * 锚点样例把标尺钉死，否则分数会全部堆在 80 到 90 之间。
   */
  async scoreJob({ resumeText, job, jdText }) {
    const sys = [
      '你是一个严格的岗位匹配评估员。你要判断一份简历和一个岗位到底有多匹配，',
      '并且必须为每个判断给出原文证据。你的评估会直接决定求职者把有限的投递',
      '机会花在哪里，所以宁可严格，不要放水。',
      '',
      '打分标尺（务必按此校准，不要让分数堆在 80 到 90 之间）：',
      '  95 分：岗位职责与候选人过往做的事高度重合，技术栈和行业都对口，级别相当',
      '  75 分：同一个职能方向，但业务领域不同，需要迁移经验',
      '  60 分：只是职能名称相同，实际做的事情差别很大',
      '  40 分：方向不对，投了大概率没有回音',
    ].join('\n');

    const user = [
      '【候选人简历】',
      resumeText.slice(0, 6000),
      '',
      '【岗位信息】',
      `岗位名称：${job.jobName}`,
      `公司：${job.companyName}${job.industry ? '（' + job.industry + '）' : ''}`,
      `城市：${job.city}　薪资：${job.salaryDesc}　经验要求：${job.experience}　学历：${job.degree}`,
      '',
      '【岗位职责原文】',
      (jdText || '（未能获取到岗位详情）').slice(0, 4000),
      '',
      '请按四个维度打分（0 到 100 的整数），并严格输出 JSON：',
      '{',
      '  "duty":     {"score": 0, "jdQuote": "JD里的原句", "resumeQuote": "简历里对应的原句"},',
      '  "skill":    {"score": 0, "jdQuote": "", "resumeQuote": ""},',
      '  "industry": {"score": 0, "jdQuote": "", "resumeQuote": ""},',
      '  "level":    {"score": 0, "jdQuote": "", "resumeQuote": ""},',
      '  "concerns": ["至少写一条这个岗位对候选人来说的短板或风险"],',
      '  "summary":  "一句话说清这个岗位值不值得投，不超过30字"',
      '}',
      '',
      '维度含义：',
      '  duty     职责重合度：JD 描述的日常工作，候选人做过多少',
      '  skill    能力与技术栈：要求的技能候选人有几项，熟练到什么程度',
      '  industry 行业与业务形态：ToC还是ToB，内容/工具/平台，行业是否对口',
      '  level    级别匹配：是高攀、平配还是低就',
      '',
      '硬性要求：',
      '  jdQuote 必须是上面岗位职责原文里真实出现过的句子，不许改写不许编造。',
      '  resumeQuote 必须是简历里真实出现过的内容。',
      '  找不到对应证据时，该维度分数不得高于 50，quote 写空字符串。',
    ].join('\n');

    const text = await this.chat({
      model: CONFIG.MODEL_SCORE,
      temperature: 0.2,
      jsonMode: true,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    });

    let o;
    try {
      o = JSON.parse(text);
    } catch (e) {
      throw new Error('打分结果不是合法 JSON');
    }

    const dim = (k) => {
      const d = o[k] || {};
      const n = Number(d.score);
      return {
        score: Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0,
        jdQuote: String(d.jdQuote || ''),
        resumeQuote: String(d.resumeQuote || ''),
      };
    };
    const dims = { duty: dim('duty'), skill: dim('skill'), industry: dim('industry'), level: dim('level') };
    const w = CONFIG.SCORE_WEIGHTS;
    const total = Math.round(
      dims.duty.score * w.duty + dims.skill.score * w.skill
      + dims.industry.score * w.industry + dims.level.score * w.level);

    return {
      total,
      dims,
      concerns: Array.isArray(o.concerns) ? o.concerns.map(String).slice(0, 3) : [],
      summary: String(o.summary || ''),
      // 溯源三件套。没有它们，将来想知道「这批分数是哪一版打的」就无从查起
      modelId: CONFIG.MODEL_SCORE,
      promptVersion: 'score-v1',
      scoredAt: Date.now(),
    };
  },

  /**
   * 写打招呼语。
   *
   * 这一环决定 HR 回不回你，是整个产品里唯一「质量比效率重要」的地方。
   *
   * 做法是 few-shot：直接把用户本人写过的真实招呼语当范本喂进去，
   * 比任何形容词描述都准。规则只负责兜住底线（不许提短板、不许编数据、
   * 不许写 markdown），风格交给范本去带。
   *
   * 生成完再让模型对照清单自查重写一遍。这一步便宜，
   * 但一次生成里混进来的空话和编造的数字，模型对着清单基本都能自己揪出来。
   */
  async writeGreeting({ resumeText, job, jdText, score }) {
    const R = GREETING_RULES;

    const sys = [
      '你在帮一个求职者写 BOSS 直聘上的第一条打招呼语。',
      '这条消息会直接发给招聘方，对方每天收几十条模板消息。',
      '你要写的是一条让人一眼看出「这人读过我的 JD，而且真的干过这些事」的消息。',
      '',
      '下面是这位求职者自己写过的招呼语，风格以此为准，照着写：',
      '',
      ...GREETING_SAMPLES.map((x, i) => `【范本 ${i + 1}】\n${x}\n`),
      '',
      '【两种结构，看 JD 长什么样选一个】',
      'JD 职责写成整段的，用段落叙述：',
      ...R.structures.段落叙述.map((x) => '  · ' + x),
      'JD 职责写成条目的，用分条对位：',
      ...R.structures.分条对位.map((x) => '  · ' + x),
      '',
      '【绝对禁止】',
      ...R.forbidden.map((x) => '· ' + x),
      '',
      '【必须做到】',
      ...R.required.map((x) => '· ' + x),
    ].join('\n');

    // 拿四维打分里最强的那一维当切入点：它已经有现成的
    // 「JD 原句 ↔ 简历原句」配对，是开头最有说服力的一句
    const strong = score && score.dims
      ? Object.entries(score.dims).sort((a, b) => b[1].score - a[1].score)[0]
      : null;

    const user = [
      '【我的简历】',
      resumeText.slice(0, 6000),
      '',
      '【岗位】',
      `${job.jobName}　${job.companyName}　${job.city}`,
      '',
      '【岗位职责原文】',
      (jdText || '（没抓到岗位详情，只能依据岗位名称写）').slice(0, 3500),
      '',
      strong && strong[1].jdQuote
        ? `【已经比对出的最强匹配点，开头优先引用它】\nJD 原话：${strong[1].jdQuote}\n我的经历：${strong[1].resumeQuote}`
        : '',
      '',
      `篇幅 ${R.lengthHint}。`,
      '',
      '写完后对照下面几条逐项自查，有问题就改掉再输出：',
      '1. 有没有提到任何短板、不足、还需提升？有就整句删掉',
      '2. 有没有哪一段一个数字都没有？有就补上简历里的真实数字',
      '3. 数字和项目名是不是都能在简历里找到？编造的一律删掉',
      '4. 有没有引用 JD 里的原话并加引号？没有就补上',
      '5. 有没有用星号加粗或减号列表？有就去掉，聊天框不渲染 markdown',
      '',
      '只输出自查修改后的最终版本。不要解释、不要标题、不要引号包裹全文。',
    ].filter(Boolean).join('\n');

    let text = await this.chat({
      model: CONFIG.MODEL_GREETING,
      temperature: 0.7,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    });

    text = String(text).trim()
      .replace(/^(打招呼语|招呼语|内容)[:：]\s*/, '')
      // markdown 残留兜底：模型偶尔还是会加粗，聊天框里会显示成一堆星号
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^[-*]\s+/gm, '')
      .replace(/——/g, '，')
      .trim();

    return {
      text,
      source: 'ai',
      modelId: CONFIG.MODEL_GREETING,
      promptVersion: 'greet-v3-fewshot',
      generatedAt: Date.now(),
    };
  },

  /** 从简历里推断同义岗位名，用于搜索时的关键词扩展 */
  async expandPositions(resumeText) {
    const text = await this.chat({
      model: CONFIG.MODEL_SCORE,
      temperature: 0.3,
      jsonMode: true,
      messages: [{
        role: 'user',
        content: [
          '下面是一份简历。请判断这个人在招聘网站上应该用哪些岗位名去搜索。',
          '',
          '要求：',
          '1. 只给招聘网站上真实存在的岗位名称，不要自造词',
          '2. 覆盖同一个方向的不同叫法（例如同一个方向可能被叫作 A 经理、B 经理、C 产品）',
          '3. 6 到 10 个，按相关度从高到低排',
          '4. 输出 JSON：{"positions": ["岗位名1", "岗位名2"]}',
          '',
          '简历：',
          resumeText.slice(0, 6000),
        ].join('\n'),
      }],
    });

    try {
      const o = JSON.parse(text);
      return Array.isArray(o.positions) ? o.positions.slice(0, 10) : [];
    } catch (e) {
      return [];
    }
  },

  /**
   * 语义归类：把用户输入的「怪词」(PM / 增长黑客 / AI解决方案…) 映射到 BOSS
   * 职位类型的叶子类目名。只在确定性字符串匹配失败时兜底调用。
   *
   * @param {string[]} keywords 没能字面匹配上的岗位词
   * @param {string[]} leafNames BOSS 职位类型的全部叶子类目名（候选项）
   * @returns {Object} { 岗位词: [匹配到的叶子名…] }
   */
  async classifyPositions(keywords, leafNames) {
    if (!keywords.length || !leafNames.length) return {};
    const text = await this.chat({
      model: CONFIG.MODEL_SCORE,
      temperature: 0,
      jsonMode: true,
      messages: [{
        role: 'user',
        content: [
          '你是 BOSS 直聘的职位分类器。下面是 BOSS 职位类型的全部叶子类目。',
          '用户输入了一些岗位词（可能是缩写/英文/口语/新造词）。请为每个岗位词',
          '从类目列表里选出语义最贴近的 1-4 个类目（必须是列表里的原词，不要自造）。',
          '选不出合适的就给空数组。',
          '',
          '输出 JSON：{"岗位词": ["类目名", ...], ...}',
          '',
          '类目列表：',
          leafNames.join('、'),
          '',
          '岗位词：',
          JSON.stringify(keywords),
        ].join('\n'),
      }],
    });
    try {
      const o = JSON.parse(text);
      return (o && typeof o === 'object') ? o : {};
    } catch (e) {
      return {};
    }
  },
};
