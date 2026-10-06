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
