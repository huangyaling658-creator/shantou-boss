# 閃投hyl版_工作記錄筆記

> 记录本项目所有的修改、添加、删除、移动行为。新记录追加在文件末尾，旧记录永不修改。

---

时间 2026-10-06 16:57:00（事后补记，精确时分秒待本人确认，实际发生在 16:34~16:57 之间）;
用户 提出了「接着开发闪投项目（DEVELOPMENT.md 待办清单）」的要求，并选定待办第 1 项「海投没上全局行为闸」;
AI 提出修改方向：把精投的「全局行为闸」复用到海投，多城标签并行翻页时全局每 4~8 秒只放行一个请求，消除并行突刺（防 code:37 限流）;
AI 提出修改方法：新增 content→SW 的 ACQUIRE_TURN 领槽消息，SW 用「预约时间槽」统一派发；content 拿不到槽时降级本地随机睡，不卡死;
修改的内容：
- 修改 src/shared/constants.js：MSG 新增 ACQUIRE_TURN；CONFIG 新增 TURN_GATE_MIN_MS/TURN_GATE_MAX_MS（4000/8000）;
- 修改 src/background/service-worker.js：新增 acquireTurnGlobal() 与 ACQUIRE_TURN 路由；精投 turnGate 改读同一对常量;
- 修改 src/content/collector.js：新增 Collector.acquireTurn()；collectPages 每页开头领槽，删除页尾本地 sleep;
- 修改 docs/DEVELOPMENT.md：待办第 1 项标记已解决，§2 补充新机制说明;

---

时间 2026-10-06 17:31:21;
用户 提出了「加埋点，设计数据储存后台。目前只保三个数据：1、使用日活 2、海投和精投的点击渗透 3、一键投递按钮的点击渗透」的要求（用户转述需求方原话），并授权由 AI 决定方案;
AI 提出修改方向：先做方案 A（埋点 + 本地统计页 + 导出 CSV），云端上报接口预留；日后需要多用户汇总时升级方案 B，埋点部分零改动;
AI 提出修改方法：新增 tracker.js 统一打点（panel_open / mode_click / send_click 三类事件，匿名安装 ID 去重），事件存 chrome.storage.local 封顶 5000 条；条件设置页加「使用统计」折叠区展示三项指标并可导出 CSV；渗透口径 = 点过按钮的去重 ID ÷ 同期日活;
修改的内容：
- 添加 src/shared/tracker.js：埋点模块（track/stats/exportCsv/flush，异常静默不影响主流程）;
- 修改 src/shared/constants.js：STORE.UI 新增 ANALYTICS / ANALYTICS_UPLOADED / INSTALL_ID 三个 key；CONFIG 新增 ANALYTICS_ENDPOINT（空=仅本地）与 ANALYTICS_MAX_EVENTS;
- 修改 src/panel/panel.html：引入 tracker.js；条件设置页底部新增「使用统计」折叠区（stats-sec）;
- 修改 src/panel/panel.css：新增 .stats-content / .st-row / .stats-note 样式;
- 修改 src/panel/panel.js：boot 时打 panel_open 并渲染统计；海投/精投 pill 点击打 mode_click；runSend 与 runSendFromResult 打 send_click；新增 renderStats()、折叠交互、CSV 导出;
- 修改 docs/DEVELOPMENT.md：新增 §5.5「埋点与使用统计」说明;
- 验证：src 下全部 18 个 JS 文件通过 node --check;

---

时间 2026-10-06 18:52:52;
用户 提供了《闪投 · 周五上线需求（范围与功能清单）》PDF（截止 2026-10-09 上线），并授权由 AI 决定开发顺序;
AI 提出修改方向：按建议优先做需求 #7「数据存储和记录后台」（P0 基础设施，是 #5/#6 的前提）+ #5「客服反馈入库」（P1），形态定为扩展内的口令保护只读页（对齐需求「v1 做口令保护只读页，不做账号/权限」），数据沿用本地储存;
AI 提出修改方法：新增 src/admin/ 后台页（首次自设口令、SHA-256 哈希校验、认证态只在内存），读取本地埋点与反馈数据展示三指标卡/逐日明细/反馈列表并可导出 CSV；客服抽屉加反馈表单（自由文本必填 + 联系方式选填 + 自动带版本号/来源页/时间/设备 ID）;
修改的内容：
- 添加 src/admin/admin.html、src/admin/admin.css、src/admin/admin.js：口令保护只读数据后台页;
- 修改 src/shared/constants.js：STORE.UI 新增 FEEDBACK / ADMIN_PASS；CONFIG 新增 FEEDBACK_MAX(500);
- 修改 src/panel/panel.html：客服抽屉新增反馈表单（fb-text/fb-contact/fb-submit）与「数据后台（内部入口）」链接;
- 修改 src/panel/panel.css：新增 .svc-fb 表单样式与 .svc-admin 入口样式;
- 修改 src/panel/panel.js：新增反馈提交逻辑（存 ui:feedback，封顶 FIFO，失败 toast）;
- 修改 docs/DEVELOPMENT.md：新增 §5.6「数据后台页 + 客服反馈」说明;
- 验证：src 下全部 19 个 JS 文件通过 node --check；CSV 导出 BOM 已验证为 U+FEFF;

---


---

時間 2026-10-06 19:08:27 ;
esf（小辛） 提出了「海投召回总数太少，想重做；先由本人做一次真人行为链路，看 AI 能不能学到（精投当年也是这样跑通的）」的要求 ;
AI 提出了「不推倒重做，先在嗅探器里加只读的行为记录器，接住真人操作数据再决定重做方案」的修改方向 ;
AI 提出了「sniffer.js 新增 data-jt-req-log：按时间顺序记录本页的点击事件与列表请求（时间戳/耗时/kind/完整URL/page/code/条数/hasMore/页面地址），封顶200条；跑完在 Console 用 copy() 导出」的修改方法 ;
修改的内容：仅修改 src/content/sniffer.js（新增 kindOf()、noteLog()、全局点击监听，fetch 与 XHR 两个 hook 在捕获列表请求时追加记录）；未改任何采集/投递逻辑；node --check 通过 ;


---

時間 2026-10-06 19:42:51 ;
esf（小辛） 提出了「海投按真人行为链路重做：1.无论在哪都先回BOSS主页 2.首页搜索栏搜已选/填的职位 3.选城市 4.滚动鼠标读职位卡（每次滚动=一次行为） 5.选几个地方开几个分页、上限5个、行为分配参考精投；行为预算5分钟50个按词×城平分；每词各搜一轮」的要求 ;
AI 提出了「海投v2与精投同构：SW编排+模块级全局行为闸+单步滚动采集+标签轮换激活，行为是人的、字段靠嗅探器补接口级」的修改方向 ;
AI 提出了「constants加3个新消息与TURN_GATE/HAITOU_MAX_TABS配置；collector加driveHomeSearch与collectOneScroll（含JOBLIST_META字段补全）；content加3条路由；SW新增acquireTurnGlobal模块级共享闸、精投turnGate改读共享闸、新增runHaitouScroll替换海投分支、删除旧collectOnCity堆量路径」的修改方法 ;
修改的内容：修改 src/shared/constants.js、src/content/collector.js、src/content/content.js、src/background/service-worker.js、docs/DEVELOPMENT.md（§0/§2/待办#1）；删除 service-worker.js 的 collectOnCity 函数；src 下全部19个JS通过 node --check ;


---

時間 2026-10-06 19:56:48 ;
esf（小辛） 提出了「把精投的防限流行为复制到海投，比如开新分页的间隔、关分页的间隔等，以后这类行为要模仿人类」的要求 ;
AI 提出了「开关分页间隔抽成模块级共享机制（与全局行为闸同手法），精投海投同过一条开页闸、同一个关页函数；海投各步骤停顿全部改为随机区间」的修改方向 ;
AI 提出了「constants.js 新增 TAB_OPEN_MIN/MAX_MS(1000/2000) 与 TAB_CLOSE_MIN/MAX_MS(1000/3000)；service-worker.js 新增模块级 acquireOpenSlot() 与 closeTabLater()；精投 openGate/closeSlot 改为调用共享版；海投 runHaitouScroll 开城标签前过 acquireOpenSlot、关标签走 closeTabLater，主页加载后/换词回主页/搜索驱动后/筛选页导航后/激活后滚动前的固定停顿全改为随机区间」的修改方法 ;
修改的内容：修改 src/shared/constants.js、src/background/service-worker.js、docs/DEVELOPMENT.md（1.5 与 2 两节）；未删函数；src 下全部 19 个 JS 通过 node --check ;


---

時間 2026-10-06 19:59:01 ;
esf（小辛） 提出了「工作記錄筆記 改名為 閃投hyl版_工作記錄筆記」的要求 ;
AI 提出了「直接改名，本次改名行为本身也按格式追加记录到改名后的文件里」的修改方向 ;
AI 提出了「os.rename 改名后追加本条记录；文件内标题同步改为新名」的修改方法 ;
修改的内容：项目根目录 工作記錄筆記.md 改名为 閃投hyl版_工作記錄筆記.md，文件内标题同步更新 ;


---

時間 2026-10-06 20:02:25 ;
esf（小辛） 提出了「以后每次工作记录笔记更新，都同步一份到 D:\1_AI\google 插件\閃投\工作記錄筆記 _ 共同參考」的要求 ;
AI 提出了「该路径是已存在的文件夹，同步=每次更新笔记后把最新整份复制进去（覆盖旧副本，文件名保持 閃投hyl版_工作記錄筆記.md）」的修改方向 ;
AI 提出了「本条记录追加到笔记后，立即整份复制到共同参考文件夹，作为首次同步；同时把这条同步约定写入工作区长期记忆，以后每轮改动照做」的修改方法 ;
修改的内容：新增同步副本 D:\1_AI\google 插件\閃投\工作記錄筆記 _ 共同參考\閃投hyl版_工作記錄筆記.md（此后每次更新都会覆盖同步）;


---

時間 2026-10-06 20:16:59 ;
esf（小辛） 提出了「1.开完分页后布置各分页的地方时动作太快，一样要1-2秒随机时间行为；2.海投结果页薪资读不到（截图显示 □□□-□□□元/天）；3.海投行为冷却不再是4-8秒，改回5-7秒随机」的要求 ;
AI 提出了「导航布置（回主页/筛选URL）也过开页闸 acquireOpenSlot 全局错开；薪资判定为 BOSS 防爬自定义字体导致 DOM 读出私有区字符，加乱码检测让接口数据兜底；海投行为闸独立常量 5~7 秒、与精投 4~8 同槽链不同区间」的修改方向 ;
AI 提出了「constants.js 新增 HAITOU_TURN_GATE_MIN/MAX_MS(5000/7000)；service-worker.js 的 acquireTurnGlobal 加可选区间参数、海投滚动调用传 5000/7000、两处 tabs.update 导航前过 acquireOpenSlot；collector.js 的 collectOneScroll 加 GARBLE_RE(私有区U+E000~F8FF+U+FFFD) 与 cleanSalary，乱码时改用嗅探器 meta.salaryDesc」的修改方法 ;
修改的内容：修改 src/shared/constants.js、src/background/service-worker.js、src/content/collector.js、docs/DEVELOPMENT.md（第2节）；src 下全部 19 个 JS 通过 node --check ;


---

時間 2026-10-06 20:37:29 ;
esf（小辛） 提出了「布置时还是太快了，多页面排队布置吧，1-2秒一个行为」的要求 ;
AI 提出了「布置阶段缺口在驱动搜索框这步没过闸：把布置序列的每个动作（开分页/回主页导航/驱动搜索框/筛选URL导航）全部排进 1~2 秒开页闸，多分页轮流布置」的修改方向 ;
AI 提出了「service-worker.js 的 runHaitouScroll 在 DRIVE_HOME_SEARCH（激活分页+填词+点搜索）前补一个 acquireOpenSlot 并检查停止态」的修改方法 ;
修改的内容：修改 src/background/service-worker.js（runHaitouScroll 布置段补闸）、docs/DEVELOPMENT.md（第2节布置说明更新）；src 下全部 19 个 JS 通过 node --check ;


---

時間 2026-10-06 20:50:28 ;
esf（小辛） 提出了「行为冷却改 4-6s（精投由4-8、海投由5-7统一为4-6），5分钟行为总数改为60个」的要求 ;
AI 提出了「两模式闸区间统一为 4~6 秒、行为预算改为每分钟 12 个（ACTIONS_PER_MINUTE），面板耗时预估的冷却均值同步对齐」的修改方向 ;
AI 提出了「constants.js：TURN_GATE_MAX_MS 8000→6000、HAITOU_TURN_GATE_MIN/MAX_MS 5000/7000→4000/6000、新增 ACTIONS_PER_MINUTE:12、COOLDOWN_MIN_MS 2000→4000（仅供面板预估）；service-worker.js：精投与海投预算公式改按 ACTIONS_PER_MINUTE 计算；DEVELOPMENT.md 与 panel.js 注释同步」的修改方法 ;
修改的内容：修改 src/shared/constants.js、src/background/service-worker.js、src/panel/panel.js（仅注释与预估常量）、docs/DEVELOPMENT.md；src 下全部 19 个 JS 通过 node --check ;


---

時間 2026-10-06 21:07:27 ;
esf（小辛） 提出了「点苏州、厦门就自动跟着选上（截图），检举一下精投有没有同样问题」的要求 ;
AI 提出了「根因是快捷城市表硬编码错码：苏州错用厦门的码 101230200（选择按 code 判重所以联动）；排查后共 4 处错码；精投除了同病还有更隐蔽的字段名 bug」的修改方向 ;
AI 提出了「对照公开 BOSS 城市码表逐一核实全部 24 个快捷城市：苏州 101230200→101190400、无锡 101190400→101190200、合肥 101020900→101220100、东莞 101280800→101281600（原值是佛山的码）；精投 cityNames 由读不存在的 c.name 改为 c.name || c.label（原代码导致精投城市筛选从未生效）；面板启动加载存档时按 label 自愈历史错码」的修改方法 ;
修改的内容：修改 src/panel/panel.js（HOT_CITIES/MORE_CITIES 四个城市码、cityNames 字段、加载存档自愈逻辑）；src 下全部 19 个 JS 通过 node --check ;


---

時間 2026-10-06 21:10:32 ;
esf（小辛） 提出了「把整次海投的重做加进共筆里，包括冷却时间的调整」的要求 ;
AI 提出了「按共筆七项格式把海投重做拆成 4 条可通用条目写入交换簿」的修改方向 ;
AI 提出了「条目插在共同改动记录区末尾、文件创建注脚之前：条目3 海投v2真人链路重做（19:42:51实施）、条目4 分页行为全面拟人化（19:56:48与20:36实施）、条目5 冷却统一4~6秒+预算12个/分（20:49实施，含3.5秒出处未确认的风险提示）、条目6 薪资防爬字体乱码兜底（20:16实施）」的修改方法 ;
修改的内容：修改 共筆 D:_AI\google 插件\閃投\工作記錄筆記 _ 共同參考\hyl_esf_共同工作記錄筆記.md（新增条目3~6，共同者均为 hyl，写入时间 2026-10-06 21:08:54）；未改任何代码 ;
---
時間 2026-10-06 21:36:01 ;
用戶（esf） 提出了「定義『讀一下共筆』= 只讀對方的部份，並直接進行修改」的要求，本次讀到對方（esf 版）共筆條目 1 與條目 2：結果卡片上的公司名可點擊直達該公司官網招聘頁，並附 72 家公司的官網招聘網址庫 ;
AI 提出了「把該功能按共筆條目 1/2 的規格移植到 hyl 版：精投（鎖公司）模式下公司名渲染為連結，命中公司庫 → 新分頁開官網招聘頁，未命中 → Bing 搜索『公司名 官网 招聘』兜底，hover 提示區分『官網』與『搜索兜底』」的修改方向 ;
AI 提出了「esf 版筆記未附 72 條網址清單，故按條目 1 的標準（自有域名優先、其次公司專屬 Moka/飛書託管頁、社招頁優先）由 AI 逐家聯網核驗重建網址庫，寫入 COMPANY_LIB 的 url 字段；匹配用 顯示名/搜索名/別名 + 向前包含 + 最長鍵優先」的修改方法 ;
修改的内容：
- 修改 src/data/companies.js：73 家公司中 69 家新增 url（官網招聘頁）；階躍星辰、生數科技、面壁智能、赤子城 4 家查無可靠官網招聘入口，不寫 url，走搜索兜底（註釋說明）；集團歸屬映射：汽水音樂→字節招聘、陸金所→平安集團招聘、Lazada→阿里集團招聘；Soul 用公司專屬飛書託管頁（soulapp.jobs.feishu.cn）;
- 修改 src/panel/panel.js：新增 careersUrlOf()（匹配鍵=顯示名/搜索名/別名，向前包含、最長鍵優先，懶加載並按鍵長倒序排）；buildJobCard 在 S.searchMode === 'company' 時把公司名渲染為 <a target="_blank">，命中 tooltip『官網招聘页』，未命中 tooltip『搜索兜底（未收录官网，Bing 搜索）』；海投模式不受影響（條目前提：僅精投模式）;
- 修改 src/panel/panel.css：新增 .jcompany-link 樣式（主色、hover 下劃線）;
- 與 esf 版差異誠實記錄：esf 版條目 1 提到『技術人員模式可自訂每家公司的網址』，hyl 版沒有技術人員模式，該自訂覆蓋能力本次不實作；esf 的 72 條清單內容無從取得，網址庫為 AI 獨立核驗重建，個別條目可能與 esf 版不一致；
- 驗證：companies.js 與 panel.js 通過 node --check；
---
時間 2026-10-06 22:33:17 ;
用戶 提出了「海投停止條件第 4 條（連續 0 新增滾動容忍次數）由 2 改成 3 次」的要求 ;
AI 提出了「把 runHaitouScroll 的 noNew 跳出門檻從 2 調為 3，讓每個『詞×城』單元多一次確認機會，減少因首屏懶加載慢而誤判滾到底」的修改方向 ;
AI 提出了「只改判斷處與對應註釋，不動其他停止條件（時間閘/手動停止/單元配額）」的修改方法 ;
修改的内容：修改 src/background/service-worker.js（noNew >= 2 改為 noNew >= 3，兩處註釋同步）；修改 docs/DEVELOPMENT.md（§海投v2 第 5 條：連續 2 次改 3 次，並順手修正過期的『×10』為實際的『×12』）；通過 node --check ;
---
時間 2026-10-06 22:44:42 ;
用戶 提出了「把海投的那部份代碼複製一份打包放到共筆空間，加備注、方向、手段」的要求 ;
AI 提出了「把海投 v2 涉及的 5 個源文件整份複製成代碼包放進共筆空間，附一份說明文檔寫清設計方向、實現手段、移植備注，讓 esf 版能獨立讀懂移植」的修改方向 ;
AI 提出了「文件不刪減保持與線上一致；說明文檔分三段：方向（真人鏈路/行為閘/預算分配/提前收工/字段補齊）、手段（每文件改動對照表）、備注（依賴關係/滾動要激活分頁/薪資亂碼/4個停止條件/城市代碼/4~6秒未實跑驗證）；同時保留文件夾與 zip 兩種形式」的修改方法 ;
修改的内容：添加 共筆空間\海投v2代碼包_hyl_20261006\（constants.js、service-worker.js、collector.js、content.js、sniffer.js 共 5 個文件整份複製 + 說明.md）；添加 共筆空間\海投v2代碼包_hyl_20261006.zip（同內容壓縮包，62,980 字節）；未改任何代碼 ;
---
時間 2026-10-06 23:25:21 ;
用戶 提出了「把現在這個版本上傳到 https://github.com/huangyaling658-creator/shantou-boss」的要求 ;
AI 提出了「本地目錄原本是 zip 下載無 .git，為保留遠端已有提交歷史，把當前版本作為一個新提交接到遠端 main 之上再推送（不用 force push）」的修改方向 ;
AI 提出了「git init → 整體提交 → 發現遠端有 7 個歷史提交（最新 5c3df6d）→ git fetch 後 reset 到 origin/main 再整體提交（等於把所有差異合成一個新提交）→ gh CLI 瀏覽器授權（賬號 edwardlsf）→ push」的修改方法 ;
修改的内容：項目根目錄新增 .git（本地初始化倉庫，不影響代碼）；GitHub 倉庫 huangyaling658-creator/shantou-boss 新增提交 5341004「闪投 2026-10-06：海投 v2 真人链路重做 + 全局行为闸拟人化 + 埋点/管理页 + 公司名官网链接 + 城市代码修复」，遠端歷史完整保留（5c3df6d..5341004）；本機已安裝 GitHub CLI 並完成授權 ;
---
時間 2026-10-07 00:23:45 ;
用戶 提出了「海投佈置時除了佈置地點之外，還要佈置所有的前置選擇（截圖示例：薪資待遇下拉）；只要用戶有選擇了條件就推行佈置；佈置冷卻時間調整為 2-3 秒一個動作」的要求 ;
AI 提出了「把結果頁篩選欄上的單選條件（求職類型/薪資/經驗/學歷/行業/規模/融資）從 URL 帶參改為逐個真人點擊，地點照舊一步 URL 到位；佈置階段所有動作改走 2~3 秒佈置閘，精投開頁閘不動」的修改方向 ;
AI 提出了「篩選項按 href 裡的 參數名=code 匹配錨點再 click（不按顯示文案，面板文案和頁面文案有出入）；已選中跳過；找不到錨點退回 URL 導航補上保證條件不丟；position（頁籤行只渲染大類）、hrActive（欄上沒有）、同維度多選（BOSS 下拉單選）留在 URL」的修改方法 ;
修改的内容：修改 src/shared/constants.js（MSG 新增 APPLY_FILTER；CONFIG 新增 HAITOU_LAYOUT_MIN/MAX_MS 2000/3000）；修改 src/content/collector.js（新增 applyFilterByCode(key, code)：當前 URL 已帶該值→skipped，找不到可見錨點→ok:false，否則先返回再延時 50ms 點擊防卸載衝掉響應）；修改 src/content/content.js（新增 APPLY_FILTER 路由）；修改 src/background/service-worker.js（acquireOpenSlot 接受可選 min/max 參數；runHaitouScroll 新增 layoutSlot()=2~3 秒佈置閘，佈置階段 4 處開頁閘全部換成 layoutSlot；步驟③重寫：URL 只帶 詞+city+position+hrActive+多選項，7 個單選維度按篩選欄從左到右逐個點擊、每個過佈置閘、失敗退 URL 補）；修改 docs/DEVELOPMENT.md（§2 第 1/3/4 條同步新佈置鏈路與 2~3 秒佈置閘）；4 個 JS 文件通過 node --check；尚未實跑驗證（需用戶重載擴展實測）;
---
時間 2026-10-07 01:16:09 ;
用戶 提出了六項要求：1.海投初始環境改為 https://www.zhipin.com/web/geek/jobs?ka=header-jobs 2.佈置次序改為 求職類型>薪資待遇>工作經驗>學歷要求>公司行業>公司規模，然後再在搜索欄搜「已選崗位」3.期望職位和目標城市換位 4.公司行業換位到公司規模上方、學歷要求下方 5.工作性質改名為求職類型 6.HR活躍度和福利待遇刪掉 ;
AI 提出了「海投真人鏈路重排為：崗位列表頁起步（城市+position+融資階段+多選項隨環境 URL 一次到位）→ 按用戶定的次序逐個點 6 個單選條件 → 驅動搜索欄搜詞；面板按 3/4/5/6 調整，下線的兩個維度連選項表、存檔殘留、URL 參數拼接一併清乾淨」的修改方向 ;
AI 提出了「環境 URL 用 buildSearchUrl(city+position+stage+多選)+ka=header-jobs；點擊鏈不含融資階段（用戶次序裡沒有）改留 URL；搜索欄驅動失敗退全條件 URL 兜底；面板換位只動 panel.html 兩個 section 順序」的修改方法 ;
修改的内容：修改 src/background/service-worker.js（runHaitouScroll 重排：①環境 URL 起步 ②第 2 詞起回環境 ③按 求職類型>薪資>經驗>學歷>行業>規模 逐個點擊 ④驅動搜索欄搜詞/失敗退 URL ⑤滾動讀卡；buildSearchUrl 刪掉 hrActive 參數拼接）；修改 src/panel/panel.html（期望職位與目標城市兩個 section 換位）；修改 src/panel/panel.js（FILTER_SECTIONS：工作性質改名求職類型、公司行業移到學歷下方規模上方、刪 HR 活躍度/福利待遇兩項；OPT 刪 hrActive/welfare 選項表；fullReset 預設改空；runSearch 發送前 delete 存檔殘留的 hrActive/welfare；刪雙休警示死代碼）；修改 src/content/filter-dict.js（buildSearchUrl 刪 hrActive 參數拼接）；修改 docs/DEVELOPMENT.md（§1 概覽、§2 第 1~4 條、§3 佈局條目同步）；3 個 JS 文件通過 node --check；尚未實跑驗證（需用戶重載擴展實測，重點看崗位列表頁搜索欄驅動與點擊次序）;
---
時間 2026-10-07 01:31:39 ;
用戶 提出了「1.期望職位換位到目標城市上方 2.海投中止條件改為 3min 或 150個結果 或 60個行為，不要影響冷卻時間」的要求 ;
AI 提出了「換位上一轮（01:16）已完成，本次核實 panel.html 已是期望職位在上；中止條件改為全局硬闸：3 分鐘/150 結果/60 行為任一先到即停，冷卻（佈置閘 2~3s、行為閘 4~6s）一行不動」的修改方向 ;
AI 提出了「stop() 加入 actionsDone>=60 與 merged.size>=150 兩個條件，時間闸固定 3 分鐘；60 行為按詞×城平分的分配口径沿用；連續 3 次 0 新增的提前收工保留（用戶沒讓刪）」的修改方法 ;
修改的内容：修改 src/shared/constants.js（新增 HAITOU_STOP_MINUTES=3、HAITOU_MAX_RESULTS=150、HAITOU_MAX_ACTIONS=60）；修改 src/background/service-worker.js（runHaitouScroll 刪掉 searchMinutes×12 的預算公式，改固定三閘 + stop() 全局判斷，頭註釋同步）；修改 docs/DEVELOPMENT.md（§2 第 5 條改寫為新中止口径，並如實標注：60 行為×4~6s≈4~6 分鐘 > 3 分鐘，實跑通常 3 分鐘閘先到；搜索時長拉杆對海投不再生效、精投不受影響）；兩個 JS 文件通過 node --check ; 未改动：panel.html（換位已於 01:16 完成，本次僅核實），冷卻時間相關常量與閘函数均未動 ;
---
時間 2026-10-07 02:08:05 ;
用戶 提出了「這是本地的文件，換位還是沒生效；換一個邏輯，把期望職位放在圖片版簡歷下方」的要求 ;
AI 提出了「排查後找到真正原因：版塊順序由 renderMode() 裡的 JS 動態重排（海投原来是 sec-city 在前），panel.html 的靜態換位被 JS 覆蓋所以無效；改 JS 裡海投的順序數組才是對的修法」的修改方向 ;
AI 提出了「海投順序改為 sec-position → sec-city → sec-company（期望職位緊貼圖片版簡歷下方）；精投維持公司置頂不動（用戶截圖與訴求都在海投，精投主輸入是目標公司）」的修改方法 ;
修改的内容：修改 src/panel/panel.js（renderMode() 海投分支順序數組由 ['sec-city','sec-position','sec-company'] 改為 ['sec-position','sec-city','sec-company']，註釋同步標明順序由此處 JS 決定）；修改 docs/DEVELOPMENT.md（§3 佈局條目補上「版塊順序由 JS 動態排、HTML 靜態順序不生效」的警示）；panel.js 通過 node --check；致歉並更正：01:16 只改了 HTML 靜態順序，被 JS 覆蓋，屬排查不徹底 ;
---
時間 2026-10-07 02:24:36 ;
用戶 提出了「海投地點佈置沒做好」（截圖：BOSS 頁面城市 chip 顯示「澳門」而非所選城市）的要求 ;
AI 提出了「先查證再改：實測發現 /web/geek/jobs 列表頁不吃 URL 的 city 參數（帶 city=101280600 打開仍顯示默認城市，城市由頁面按 IP/cookie 定），所以地點不能像之前那樣靠環境 URL 帶參，要像人一樣點頁面上的城市選擇器」的修改方向 ;
AI 提出了「點『當前城市』chip → 彈層裡按 city=code 的 href 或城市名點目標項 → 讀 chip 文本校驗；點不動退兜底：寫 lastCity cookie + 帶參重載；吃 URL 參數的單數搜索頁 /web/geek/job 作為補條件導航與兜底的落點；搜完詞再校驗一次城市，被衝掉就補一次全條件導航」的修改方法 ;
修改的内容：修改 src/content/collector.js（新增 _findCityChip/readCityChip/applyCity：找 class 含 city 且文本為 2~4 個漢字的可見元素作 chip，點開後在彈層裡找目標城市點擊，先返回再延時點擊防卸載衝掉響應）；修改 src/content/content.js（新增 APPLY_CITY、READ_CITY_CHIP 路由）；修改 src/shared/constants.js（MSG 新增 APPLY_CITY、READ_CITY_CHIP）；修改 manifest.json（permissions 新增 cookies，供 lastCity 兜底用）；修改 src/background/service-worker.js（runHaitouScroll 新增 ensureCity/layoutPlaceAndExtras：①.5 布置地點+若還停在列表頁則補一次帶 position/stage/多選的搜索頁導航；換詞回環境後重新布置；④搜詞後校驗城市、被衝掉補全條件導航；兜底 URL 從 jobs 列表頁改為吃參數的單數搜索頁；城市帶名稱 cityNames 用於校驗；布置未生效通過 onProgress 帶 warn 字段上報）；修改 docs/DEVELOPMENT.md（§1 概覽、§2 第 1~3 條：補上「列表頁不吃 URL 參數、地點靠點選擇器、單數頁才吃參數」的實測結論與新鏈路）；4 個 JS 文件通過 node --check、manifest.json 通過 node JSON.parse；尚未實跑驗證（需用戶重載擴展實測，重點看城市 chip 是否變成所選城市；城市選擇器 DOM 選擇器是按通用規律寫的，若點不開需按實際頁面調整）;
---
時間 2026-10-07 16:05:58 ;
用戶 提出了四項要求：1.公司行業在 BOSS 上是主選+副選結構，副選只限三個（截圖告知）2.行為冷卻時間改為 4-5 秒 3.佈置鏈路重做：分頁數=地點×職位、去 https://www.zhipin.com/?ka=header-home-logo 主頁、搜索欄搜職位、然後順着篩選欄次序選、選不限就跳過 ;
AI 提出了「海投按一詞一城一個分頁重寫：主頁起步→驅動搜索欄搜詞→順着結果頁篩選欄從左到右點（地點>工作區域>職位類型>求職類型>薪資>經驗>學歷>行業>規模>融資），沒選的維度跳過；行業副選最多點 3 個、超出如實上報；海投行為閘由 4~6 秒改 4~5 秒（精投 4~6 不動）」的修改方向 ;
AI 提出了「篩選欄全是折疊下拉，選項不可見時 collector 先按維度顯示名（_FILTER_LABELS）點開下拉再找錨點；找不到退 URL 補（同維度追加不覆蓋，行業副選可多值）；多選維度最後統一 URL 補一次；布置完校驗城市 chip，被衝掉補全條件導航」的修改方法 ;
修改的内容：修改 src/background/service-worker.js（runHaitouScroll 重寫：units=地點×職位詞、每單元一個分頁、初始環境改 BOSS 主頁 ?ka=header-home-logo、先搜詞後點條件、CLICK_ORDER 九個維度含工作區域/職位類型/融資階段、行業 slice(0,3)+warn、urlFilters 統一補、城市校驗保留；刪掉 ki 詞循環與 layoutPlaceAndExtras/envUrl；行為閘預設值 6000→5000）；修改 src/content/collector.js（applyFilterByCode 改 async，新增 _FILTER_LABELS 與 _findFilterAnchor，選項找不到時先點開該維度下拉重試一次）；修改 src/shared/constants.js（HAITOU_TURN_GATE_MAX_MS 6000→5000，註釋標明精投不變）；修改 docs/DEVELOPMENT.md（§1 概覽、§2 第 1~4 條改寫為新鏈路）；3 個 JS 文件通過 node --check；尚未實跑驗證（需用戶重載擴展實測，重點：主頁搜索欄驅動、下拉點開後能否找到選項、行業副選點擊）;
---
時間 2026-10-07 16:23:16 ;
用戶 提出了四項要求：1.使用統計不是顯示給用戶看的、是公司看的，要想一個辦法去儲存和傳送這些資料 2.海投進度條不要寫 5 分鐘、就 3 分鐘 3.停留時間改 0.5-1 秒 4.海投行為冷卻由 4-5 秒改 3.000-4.000 秒、佈置冷卻改 1.000-2.000 秒 ;
AI 提出了「面板使用統計區塊整塊下線（埋點照常採集），公司查看走密碼保護的數據後台；傳送用 SW 定時上報機制；進度剩餘時間海投改按 3 分鐘硬閘倒推；三檔時間按新口徑改常量與停留區間」的修改方向 ;
AI 提出了「儲存=本地隊列照舊（5000 FIFO），傳送=SW 每 6 小時 alarm + 每次啟動各調一次 Tracker.flush()，配上 ANALYTICS_ENDPOINT 即生效、未配空轉只存本地；海投剩餘時間 = 3 分鐘 − 已用時（精投仍按剩餘行為×6 秒）；停留統一 500~1000ms 只動 runHaitouScroll 內的 randInt，精投各行為間隔不動」的修改方法 ;
修改的内容：修改 src/panel/panel.html（移除「使用統計」折疊區整塊，留註釋說明去向）；修改 src/panel/panel.js（移除 renderStats/折疊/導出 CSV 三段代碼與 boot 裡的 renderStats() 調用，留註釋；renderSearchProgress 海投分支剩餘時間改按 HAITOU_STOP_MINUTES 三分鐘減已用時）；修改 src/shared/tracker.js（頭註釋改寫為「儲存與傳送」新機制說明）；修改 src/background/service-worker.js（importScripts 加 tracker.js；onAlarm 改帶參數處理器：analytics-flush 時 Tracker.flush()；新增每 6 小時 analytics-flush alarm + SW 啟動即 flush 一次；layoutSlot 預設值 2000/3000→1000/2000；行為閘調用預設 4000/5000→3000/4000；runHaitouScroll 內全部停留 randInt 統一改 500~1000：900~1600×5、800~1800、1000~2000、1200~2200×3、250~600；相關註釋同步）；修改 src/shared/constants.js（HAITOU_TURN_GATE_MIN/MAX_MS 4000/5000→3000/4000；HAITOU_LAYOUT_MIN/MAX_MS 2000/3000→1000/2000，註釋同步）；修改 docs/DEVELOPMENT.md（§1 概覽、§2 第 1/4 條新時間口徑+停留檔位、§5.5 可見性與儲存傳送機制改寫）；4 個 JS 文件通過 node --check；未實跑（需重載擴展；ANALYTICS_ENDPOINT 目前為空，要上報需公司提供接收端點）;
---
時間 2026-10-07 16:36:47 ;
用戶 提出了「『生成打招呼語』與『一鍵發送』的判定：所選崗位（一個或多個）的打招呼格子全部已有內容 → 一鍵發送；只要有一個空 → 生成打招呼語，且只生成空的打招呼格子」（截圖：選中的崗位格子已填內容，按鈕仍顯示「生成打招呼语（1）」）的要求 ;
AI 提出了「按鈕判定從『greeted 標誌位』改為『逐格子看內容』：本批選中崗位逐個檢查招呼語格子，全有內容 → 一鍵發送，有空 → 生成打招呼語（空格子數），生成只針對空格子、已填內容絕不重寫」的修改方向 ;
AI 提出了「新增 emptyGreetIds()（自定義模式填了全局招呼語時所有格子算有內容）；updateAction 結果頁分支按空格子數翻轉按鈕文案；點擊處理：全滿 → 發送（AI 已生成走 runSend、手動填滿走 custom 落文案不調 AI），有空 → runGreeting(空格子列表)；runGreeting 接收 onlyIds 並兜底再過濾一次，沙漏態不再清 value；格子 input 時即時 updateAction 翻轉按鈕」的修改方法 ;
修改的内容：修改 src/panel/panel.js（新增 emptyGreetIds()；updateAction 結果頁判定改寫，按鈕文案「一键投递」按用戶用詞改「一键发送」；btn-action 點擊結果頁分支改寫；runGreeting 加 onlyIds 參數+空格子兜底過濾、不清已有內容；卡片 textarea input 監聽加 updateAction）；修改 docs/DEVELOPMENT.md（§3 補「結果页按钮判定」條目）；panel.js 通過 node --check；如實說明：自定義招呼語模式維持直投（該模式本就不調 AI，不適用「生成」語義）；未實跑，需重載擴展驗證 ;
---
時間 2026-10-07 16:43:28 ;
用戶 提出了「『生成打招呼語』按鈕括號裡的數字改為不顯示」的要求 ;
AI 提出了「按鈕文案去掉括號計數，判定邏輯（空格子才生成）不變」的修改方向 ;
AI 提出了「只改 updateAction 裡生成分支的文案，『一键发送（N）』的計數用戶沒讓動、先保留」的修改方法 ;
修改的内容：修改 src/panel/panel.js（生成分支由 生成打招呼语（空格子数）改為 生成打招呼语，註釋同步）；修改 docs/DEVELOPMENT.md（§3 按鈕判定條目同步）；panel.js 通過 node --check ;
---
時間 2026-10-07 19:42:34 ;
用戶 提出了「『一键发送』改回『一键投递』」的要求 ;
AI 提出了「把 16:36 按用戶用詞改出去的按鈕文案改回原用詞，判定邏輯不變」的修改方向 ;
AI 提出了「panel.js 全文一鍵替換（按鈕文案 2 處 + 註釋 4 處），開發文檔同步」的修改方法 ;
修改的内容：修改 src/panel/panel.js（「一键发送」全部改回「一键投递」，含「一键投递（N）」計數保留）；修改 docs/DEVELOPMENT.md（§3 按鈕判定條目同步）；panel.js 通過 node --check ;
---
時間 2026-10-07 20:28:23 ;
用戶 提出了兩項要求：1.目標城市的排序改為按 BOSS「請選擇城市」彈窗熱門城市頁的次序排（截圖：全國 北京 上海 廣州 深圳 / 杭州 天津 西安 蘇州 武漢 / 廈門 長沙 成都 鄭州 重慶）2.工作區域直接給答案：14 張截圖逐城給出 BOSS 篩選欄的行政區列表（北京/上海/廣州/深圳/杭州/天津/西安/蘇州/武漢/廈門/長沙/成都/鄭州/重慶），補充「區域是可多選的，其他沒有答案的就默認只有不限」 ;
AI 提出了「HOT_CITIES 按截圖 15 城次序重排、其餘城市保留收進『展開更多』；新增內置行政區表 CITY_DISTRICTS（城市 code → 區名數組），工作區域選項 = 不限 + 所選城市行政區並集，沒答案的城市只剩不限；區域按多選對待」的修改方向 ;
AI 提出了「選中存區名（同行業存名字的做法），發送時按抓取字典轉 code、轉不了保留區名；佈置時逐個去點（不限個數），collector 按 code 找不到錨點時按選項文字（區名）再找一次；點完有真 code 的區校驗 URL 里還在不在（多點可能互衝），缺了一次性 URL 補齊；純區名點不出來且無 code → warn 如實上報，不往 URL 塞中文」的修改方法 ;
修改的内容：修改 src/panel/panel.js（HOT_CITIES 重排為 15 城 BOSS 次序、MORE_CITIES 收南京/合肥/濟南/青島/瀋陽/珠海/東莞/寧波/無錫 9 城；新增 CITY_DISTRICTS 14 城行政區表；renderFilters 工作區域分支改為按所選城市取內置區名並集、所選城市都沒答案時才用抓取選項兜底、工作區域不再算 deadKey；發送時新增區名→code 轉換 districtVals）；修改 src/background/service-worker.js（CLICK_ORDER 循環新增 businessDistrict 多選分支：逐個點、clickedFilters 只記真 code；點擊失敗的 URL 兜底加「非數字不上 URL、改 warn 上報」守衛；urlFilters 統一補之後新增工作區域多選校驗補齊塊；buildSearchUrl 補 businessDistrict 且只帶數字 code）；修改 src/content/collector.js（新增 _findFilterAnchorByText，applyFilterByCode 在 code 匹配與下拉重試都落空後按選項文字再找一次）；修改 docs/DEVELOPMENT.md（§2 第 3 條補工作區域多選與文字匹配兜底、§3 補「目標城市次序」條目）；3 個 JS 文件通過 node --check；如實說明：抓取字典 FIELDS 本來就不含 businessDistrict，所以區名→code 大多走不通，實際靠按區名文字點；尚未實跑驗證（需重載擴展實測，重點：多選區域逐個點是否互相衝掉、區名文字匹配能否點中）;
---
時間 2026-10-07 20:46:38 ;
用戶 提出了四項要求（截圖：選了上海，工作區域仍只顯示「不限」一排舊狀）：1.工作區域要實時跟蹤目標城市換 2.兩個或以上城市時，工作區域只展現最後選擇的城市的區域 3.一個城市都沒選（取消選擇唯一個城市）時自動點選全國 4.全國是單選，點了全國後工作區域還原到只有不限 ;
AI 提出了「城市選擇與工作區域聯動收進 toggleCity 一處：全國與具體城市互斥、空選自動補全國、每次切城市重畫篩選區（renderFilters）並清掉不屬於當前展示城市的已選區名」的修改方向 ;
AI 提出了「新增 ALL_COUNTRY 常量與 currentDistrictNames()（只取 S.cities 最後一個城市的內置行政區）；配置載入與 fullReset 也套用同一套規則，避免存檔里的舊選擇與新規則打架」的修改方法 ;
修改的内容：修改 src/panel/panel.js（新增 ALL_COUNTRY 常量；toggleCity 重寫：全國單選互斥、空選自動補全國、清舊區名、聯動 renderFilters 實時跟隨；新增 currentDistrictNames()；renderFilters 工作區域分支由「所選城市並集」改為「只展最後選擇的城市」；配置載入處補互斥/空選補全國/清舊區名三條規則；fullReset 城市默認改為全國）；修改 docs/DEVELOPMENT.md（§2 工作區域條目、§3 目標城市次序條目同步新規則）；panel.js 通過 node --check；如實說明：海投「地點×職位」單元邏輯不變，全國（100010000）作為一個地點參與單元拆分的行為沿用舊邏輯，未實跑驗證 ;
---
時間 2026-10-07 21:05:09 ;
用戶 提出了「周五上线需求（范围与功能清单）更新：#8 ok（工作区域，前两轮已做）、#10 做（多公司最多选 3 家超出弹窗提示，P0）、#11 能做嗎怎麼做（停止后可恢复：恢复搜索/恢复投递入口，P0）」的要求 ;
AI 提出了「#10 按验收点『选第 4 家被拦+提示』实现：公司选择统一过 3 家上限检查，满了弹居中小弹窗（不用一闪而过的 toast，弹窗更贴验收口径）；#11 属问句，先答可行性与方案、经用户确认后再动手」的修改方向 ;
AI 提出了「新增通用提示弹窗 showAlert（遮罩+居中卡片+知道了按钮，样式复用抽屉的遮罩体系）；常量 COMPANY_MAX=3；内置库胶囊 toggle 与自定义添加公司两个入口都在 push 前过 companyFull() 拦截」的修改方法 ;
修改的内容：修改 src/panel/panel.html（新增通用提示弹窗结构 #alert-mask/#alert-box/#alert-msg/#alert-ok）；修改 src/panel/panel.css（新增 .alert-box/.alert-msg/.alert-btn 居中弹窗样式，z-index 高于抽屉）；修改 src/panel/panel.js（新增 showAlert/hideAlert、COMPANY_MAX=3、companyFull()；renderCompanies 内置胶囊与「+ 添加公司」两处入口加 3 家拦截；alert-ok/alert-mask 点击关闭绑定）；修改 docs/DEVELOPMENT.md（§3 补「目标公司最多 3 家」条目）；panel.js 通过 node --check；未实跑（需重载扩展验证：选满 3 家后点第 4 家弹窗、取消一家后可再选）; 另：用戶問了 #11「恢复搜索」可行性，AI 回覆「能做」並給出斷點續跑方案（停止時把 config 快照/已完成單元/已收 jobId 集合/已用預算落盤 chrome.storage，結果頁出『恢复搜索』入口，點了跳過已完成單元、舊 jobId 播種去重續跑），預算口徑（恢复後重新計 3 分鐘/60 行為 vs 扣掉已用）待用戶拍板後再實現 ;
---
時間 2026-10-07 21:31:43 ;
用戶 提出了「1」（确认 #11 恢复搜索按口径 1 做：恢复后预算重新给一轮 3 分钟/60 行为/150 结果）的要求 ;
AI 提出了「断点续跑：手动停止时 SW 把条件快照+已完成单元落盘 sw:searchCheckpoint，面板结果页出『恢复搜索』按钮，点了用快照续跑、跳过已完成单元、预算重新计一轮；正常跑完（含到闸自停）清断点；fullReset 也清」的修改方向 ;
AI 提出了「海投单元键 cityCode|kw、精投单元为公司名（没定位到 miss 的不记完成，恢复时给重试定位机会）；config 内部键 _skipUnits/_skipCompanies/_doneSoFar 走 Resume 装配，落盘前剥掉；面板按钮异步查 GET_SEARCH_CHECKPOINT，忙时藏、停止后的 done 广播里再刷一次（断点由后台收尾时才落盘）」的修改方法 ;
修改的内容：修改 src/shared/constants.js（MSG 新增 RESUME_RECALL/GET_SEARCH_CHECKPOINT/CLEAR_SEARCH_CHECKPOINT；STORE.SW 新增 SEARCH_CHECKPOINT）；修改 src/background/service-worker.js（新增 saveSearchCheckpoint/loadSearchCheckpoint/clearSearchCheckpoint；runHaitouScroll 新增 doneUnits 追踪+_skipUnits 跳过+unitKey，返回值带 doneUnits；augmentFromCompanyPages 新增 doneCompanies（located 才记）+_skipCompanies 过滤+unitTotal 改按本轮公司数；runRecall 收尾：stopRequested→存断点（累计 _doneSoFar+本轮新增，剥内部键）、否则清断点；ht 改 htResult 提出 if 块；新增三个 MSG 处理器）；修改 src/panel/panel.html（底部 action-row 新增 btn-resume-search）；修改 src/panel/panel.js（新增 refreshResumeSearchBtn（序号防旧响应覆盖）+按钮点击处理（界面起步同 runSearch，发令走 RESUME_RECALL）；updateAction 开头挂刷新；fullReset 清断点藏按钮；searchStopped 的 done 广播里补刷按钮）；修改 docs/DEVELOPMENT.md（§3 补「恢复搜索」条目）；3 个 JS 文件通过 node --check；未实跑（需重载扩展验证：搜索中点停止→结果页出恢复按钮→点后续跑跳过已完成单元；正常跑完按钮不出现）;
---
時間 2026-10-07 22:21:44 ;
用戶 提出了四點回覆（對應 AI 的診斷與修復四小改）：1.key 防偷——插件會給路人安裝，代碼內的 key 可能被偷，問有什麼辦法 2.做計時保護：每 30 秒沒生成一份打招呼就停止，並把已生成的招呼語存好到對應公司的招呼格子裡 3.（生成前驗 key 那項）先不用 4.好（生成結束如實顯示失敗條數與原因） ;
AI 提出了「#1 屬設計問題，先給方案對比待拍板：A 公司網关中轉（推薦，插件一個 key 都不放、服務器存真 key 轉發 DashScope，順帶限流/配額/使用統計，與 ANALYTICS_ENDPOINT 同一個後台）B 用戶自填 key（BYOK）C 混淆隨包發（等於沒防，不做）；#2 看門狗落在 doGreeting：30 秒無新產出置 stopRequested 停整批，已生成的本來就實時落庫+廣播進卡片、停了不丟，空格可再點接著補；#4 收尾 toast 帶失敗原因」的修改方向 ;
AI 提出了「看門狗要真停得住，卡住的步驟必須自己有超時：askTab 加可選超時參數（採集類長操作故意不傳、行為不變），抓 JD 傳 20 秒（JD_FETCH_TIMEOUT_MS）——這段以前無超時，是 0/75 卡死的根因；LLM 調用本來就有 30 秒超時」的修改方法 ;
修改的内容：修改 src/shared/constants.js（CONFIG 新增 GREETING_STALL_MS=30000、JD_FETCH_TIMEOUT_MS=20000）；修改 src/background/service-worker.js（askTab 加可選 timeoutMs 用 U.withTimeout；doGreeting 新增看門狗：setInterval 5 秒盯 lastProgressAt、超時 stalled=true 並置 stopRequested、emit 更新 lastProgressAt、Promise.all 外包 try/finally clearInterval、FETCH_JD 傳 20 秒超時、greetStat 新增 stopped）；修改 src/panel/panel.js（onGreetingDone：stopped→提示「已停止：30 秒沒有新進展，已生成的留在卡片裡，空格可再點接著生成」；failed→toast 帶 lastError 前 60 字）；修改 docs/DEVELOPMENT.md（§2 補「生成看門狗」條目與「模型密钥防偷」待辦）；3 個 JS 文件通過 node --check；未實跑（需重載擴展驗證：正常生成不受影響；人為斷網/風控時 30 秒自停、已生成保留）; 另：QWEN_KEY 目前仍是空（secrets.js），AI 生成/打分在 key 補回或網關落地前只會出走兜底語，已向用戶如實說明 ;
