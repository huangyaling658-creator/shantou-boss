# 开发交接文档（接手先读这份）

> 这份文档补充 `README.md`。README 里「当前进度」的里程碑表和「三个关键设计」第 3 条已过时（见下），以**本文档**为准。
> 面向「换一台机器 / 换一个工具（Cursor、Windsurf、workbuddy 等）继续开发」的人。

---

## 1. 这是什么、现在到哪了

闪投 = BOSS 直聘的 Chrome MV3 扩展，侧边栏里跑。两种模式：

- **海投（position）**：按岗位关键词，多城市并行搜，走 BOSS 的搜索接口（签名请求复放）。
- **精投（company）**：锁定几家目标公司，进每家公司自己的招聘页读岗位。**绝不全网搜**（搜公司名是全文检索，会带进别家公司）。

全链路已打通：**搜索召回 → （就地）生成招呼语 → 投递发送**，都能跑。不是 README 里说的「M1-M4 待开始」，那表是早期的。

### ⚠️ 当前最大的未解问题（接手优先看这个）

**精投经常「已收 0 个」。** 现象：4 家公司并行，第一家整轮跑完一个岗位都没收到。

- 判断依据：进度条的「已收 N 个」最后停在多少。
  - 几百 → 后台读卡正常，只是翻太多页（上「自适应早停」：连续两页没新岗位就收手）。
  - **一直是 0 或个位数 → 后台标签根本没渲染出岗位卡片**（最可能就是这个）。
- 根因假设：精投阶段 B 用 `chrome.tabs.create({ active:false })` 开**后台标签**读公司页的 DOM 卡片。但 Chrome 对后台标签有引擎级节流，公司页靠 AJAX 渲染岗位列表，后台可能压根不渲染 → `collectCompanyJobsFromDom` 读到 0 张卡 → 15 页全在空等超时 → 又慢又收 0。
- **下一步方向**：把阶段 B 的「后台并行」改成**前台轮转**——一次只把一家公司的标签切到前台让它真加载出卡，收完再切下一家。慢一点，但能真收到。改之前先用「已收数字」确认确实是这个分支。

---

## 2. 架构：三个 world 怎么协作

扩展没 cookie 的那半边（Service Worker）负责编排，需要登录态的动作全委托到页面里执行。

```
panel（侧边栏 UI） ──消息──> service-worker（编排中枢，无 cookie）
                                  │ 用 chrome.tabs.sendMessage 委托
                                  v
   页面里：  content.js（ISOLATED world，消息路由）
             collector.js（ISOLATED world，复放请求 / 读 DOM 卡 / 拉 JD）
             sniffer.js（MAIN world，hook 页面自身 fetch/XHR 捕请求模板）
```

- **MAIN ↔ ISOLATED 只能 postMessage 通信**。签名请求必须在 MAIN world 用页面包装过的 `window.fetch` 发（带齐 BOSS 的签名头），ISOLATED 的裸 fetch 会被拒（`code:19`）。
- **嗅探器按「种类」分开存模板**（`data-jt-joblist-req-search` / `-company` / `-recommend`）。曾经 search 模板覆盖 company 模板，导致精投搜出全站结果，务必保持分开。

### 几个「别改坏」的设计
- **SW 不用 module 模式**（manifest 没有 `"type":"module"`），为的是 `importScripts()` 跟 content script 共用同一份 `constants.js`，常量只有一份。
- **不自己拼搜索 URL**：BOSS 的参数（securityId 等）无法稳定复现，拼了当天能跑、改版即静默失效。所以嗅探真实请求当模板，只换 `page`/`query`。
- **海投直调接口**（后台标签不受网络节流，能跑满）；**精投读 DOM 卡**（公司招聘页天然只含本公司，且没有稳定的 JSON 接口可复放）。README 第 3 条只讲了前者，精投是后加的。

---

## 3. 本次迭代踩过的坑（都是架构级，别当偶发）

1. **MV3 Service Worker 空闲 ~30 秒就被回收。** 长任务（召回/招呼语/投递）里只要有一段不发消息超过 30 秒，SW 就被杀，所有在途 promise 全死、进度永远卡住。
   - **铁律：每一个几分钟的长任务都必须 `startKeepAlive()`/`stopKeepAlive()` 包住**（alarms 每 30 秒顶一次），并在静默段（如后台导航等待）补发心跳广播。`runRecall`/`runGreeting`/`runSend` 现在都挂了——加新的长任务记得照做。
2. **长任务不能 `await` 整轮再响应。** `START_RECALL`/`START_GREETING`/`START_SEND` 都是**发令即返回 `{started:true}`**，进度和收尾全靠 `TASK_PROGRESS` 广播。谁要是写成 `await run...()` 再 sendResponse，通道撑不过几分钟会被判「message channel closed」，面板误报「出错了」而后台其实在跑。
3. **精投要先把公司名翻译成 brandId**（BOSS 内部加密 ID，如 `64bf...4F1A~`，尾部 `~` 不能被 URL 编码）。brandId 解析走**前台**搜索页（签名 AJAX 后台会被 `code:19` 拒）；拿到后才进 `/gongsi/job/{brandId}.html` 公司招聘页读卡。
4. **职位筛选用三级叶子 code**（产品经理=110101），不是类目组 code（1000160，会返回 0）。完整树在 `src/data/position-tree.js`。
5. **时间账**：精投总耗时 ≈ 阶段A串行 + ⌈公司数/4⌉ × 岗位词数 × 每单位(约 15 页 × 6~8 秒)。并行只切「公司」这根轴（最多 4 家），切不动「每词翻 15 页」这个地板。真要提速得砍单元成本（自适应早停），不是加并行。

---

## 4. 跑起来 / 调试

1. `cp src/shared/secrets.example.js src/shared/secrets.js`，填入自己的**通义千问 DashScope** key（`secrets.js` 已在 `.gitignore`，不进仓库，各人填各人的）。
2. Chrome → `chrome://extensions/` → 开发者模式 → 「加载已解压的扩展程序」选本目录。
3. 登录 BOSS 直聘，打开侧边栏用。
4. **改完代码**：在扩展管理页点「重新加载」。
5. **看后台日志**：扩展卡片上点 service worker 的「检查视图」，Console 里搜 `[闪投]`。精投每家每词会打 `计时(ms) brandId= 进页= 驱动框= 翻页=`，用来定位慢在哪一段。
6. 改完习惯性全量语法自查：`for f in $(find src -name '*.js'); do node --check "$f"; done`

---

## 5. 硬约束（见 README「硬约束」表）

拉 JD ≥ 3000ms（1.5s 触发软封 `code:37`）、单批 75、单日 150、分数地板 60、禁投 0-7 点。风控第一层是弹验证码不是封号，探到边界即停、不硬顶。当前自用。
