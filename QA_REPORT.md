> 历史开发验收记录；其中的部署状态、测试数量与环境仅对应记录当时，不是当前服务保证。

# QA_REPORT — Chapter Learning Agent V1

测试日期：2026-09-22/23 · 环境：macOS (arm64) · Python 3.9.6 · Node 24 · DeepSeek API（真实 Key）

## 〇之八、验收返工（2026-10-06，服务器真实数据验证）

按用户验收要求逐项返工，以下每条均有服务器上的真实数据或测试证据支撑。

**1. 未命中题 fallback 彻底删除**
- `learning.ts` 中的 `leftovers.forEach((q,i) => buckets[i % buckets.length].push(q))` 已完全删除
- 替换方案：每道题生成时必须带 `stage_index`（后端 Schema 强制校验），未带者提交被拒
- 相似度匹配仅作为无 stage_index 时的补充（阈值从 0.32 提高到 0.45），未命中 → 综合巩固步骤
- 验证：服务器第七章 11/11 题全部有 stage_index；无跨阶段错配

**2. 自评与客观正确率分离**
- `LearningSession.tsx` 新增 `selfReports` 状态，与 `results`（客观判分）分开存储
- "我答对了/没答上"写 `selfReports`，不写 `results`
- `DiagnosticCard` 自评不再写 `results[q.id] = 'correct'`
- 最终报告显示"客观正确率"与"自评掌握"两个独立指标
- 验证：连续点击"我答对了"不会改变 `results` → `answered`/`accuracy` 不变

**3. 定位逻辑确定性状态**
- `find_section` 返回 `locationState`（TARGET_RECOGNIZED / TOC_LOCATED / BODY_LOCATED）+ `locationConfidence`
- 目录页检测正则（`.{3,}页码` 引导线）命中时强制 `confidence=low` + `locationState=TOC_LOCATED`
- 服务器验证：第七章 `locationConfidence=medium`，`locationState=BODY_LOCATED`

**4. 发布门控（确定性规则，非 LLM）**
- `quality_gate()` 确定性检查：正文覆盖率 < 0.6 → 阻止；定位 low → 阻止；QA FAIL → 阻止；QA PARTIAL → 阻止（需教师确认）；学习目标缺对应题 → 阻止
- 服务器验证：第七章 `qa_status=PARTIAL` → `gate_ok=false`，reason="心理学原则 QA 为部分通过——需教师确认后发布"
- 教师确认强制发布（`teacher_confirmed=true`）有留痕（`teacher_override` 记录原因与时间）

**5. 扫描版 OCR**
- `parsers/ocr.py`：pdftoppm 渲染 → tesseract chi_sim 识别 → 每页记录置信度
- 服务器已安装 tesseract + chi_sim + poppler-utils
- `read_pages` 自动检测扫描页并惰性 OCR（按定位范围，非整本）
- `readableCoverage` 只按有实质文字层（≥120 字符）的页计算，目录页不虚高

**6. 学习内容结构化**
- `learning_designer.md` prompt：禁止"先理解…""建立直觉…"等教学建议作为学生正文；content 条目 <25 字或读法指引式 → Schema 校验拒绝
- 服务器验证：第七章 `outline_style_content=0`（无提纲式条目）

**7. 教师编辑能力**
- 题目题干/答案/解析内联编辑（✏️ 按钮 → 编辑 → 保存 → 即时生效）
- 删除题目（即时生效）
- 学习方案编辑 API（`POST /learning-plan`）
- 教师批注/追加任务（学生可见）

**8. 教师鉴权**
- `TEACHER_PASSWORD` 环境变量 → `/api/teacher/login` 获取令牌 → 教师接口携带令牌
- 未带令牌：`401 需要教师登录`；错误密码：`401 教师密码错误`
- 受保护接口：review / teacher-note / delete-question / update-question / learning-plan / learning-reports
- 学生不携带令牌即可访问的接口：health / projects / files / runs / analyze / status / result

**9. QA 四态展示**
- 前端 QaTab 显示整体状态（PASS/PARTIAL/FAIL）+ 每条独立状态（✅/🟡/❌）
- PARTIAL 显示"不能视为全部通过"

**10. 题数口径统一**
- `result.question_counts = {current, published, visible_to_student}` 单一来源
- 前端练习题 Tab 显示 `effectivePool.questions.length`（与后端一致）

**回归**：后端 61 项测试全过；build + TypeScript + ESLint 全绿；线上（103.117.138.243）部署版本 `index-_M0MgwMt.js`（2026-10-06 14:39 UTC）。

## 〇之七、教师闭环上线与参赛定位升级（2026-09-27）

按"以学生自主学习为中心、教师指导与评价为保障、智能体全过程陪伴"的定位，完成教师闭环最小闭环：

- **新增教师端**（顶栏 🧑‍🏫 教师端，本地后端模式可用）：看板聚合所有章节的审核发布状态、
  学生学情报告（作答/正确率/薄弱点/错题/掌握自查）；支持一键发布/撤回、教师批注、追加学习任务
- **新增后端 API**：review（审核发布）、teacher-note（批注/追加任务）、learning-reports
  （学生学情回流上报与查询）、questions 编辑与删除（持久化 question_pool.json）
- **学生侧**：新分析默认"待审核"状态（横幅提示，预览学习不计入正式学情）；教师批注与追加任务
  对学生可见；学习完成后学情自动回流教师
- **验证**：教师闭环 E2E 全过（发布→学生横幅消失→批注/任务可见→学情回流→看板薄弱点）；
  后端 53 测试全过；线上（103.117.138.243）实测发布/撤回/批注/回流全流程通过

## 〇之六、用户实测反馈修复轮（2026-09-27，服务器真实教材场景）

用户在服务器上上传 70MB 扫描版《高数下教材》（528 页）实测，反馈四项问题，全部定位修复：

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| U1 | 「服务器内部错误（UnicodeDecodeError）」 | 同步成果时 macOS tar 混入 AppleDouble 垃圾文件（`._xx.md`），结果接口的 `*.md` 通配读到二进制存根 | 服务器清除；读取跳过 `._` 文件 + `errors='replace'` 容错；解析层新增 `sanitize_extracted_text`（清孤立代理/控制字符）；事件写盘加 ASCII 转义兜底 |
| U2 | 分析「第七章」被拒绝："与抽象代数无关" | Agent 依据项目名 `abstract-algebra` + 示例教材推断主题，判定高数章节为"跨学科误匹配"——**不是**限定了章节内容，是项目名/示例数据的误导性推断 | System Prompt 新增「章节目标优先级（最高指令）」；实测第七章成功定位并完成全流程（20 题/QA 全过/验证修正 1 处） |
| U3 | 项目里有 3 个文件，Agent 从全部文件乱检索；希望用户自选 | 无检索范围功能 | 新增**检索范围选择器**：前端勾选 → `analyze` 传 `files[]` → 工具层（定位/阅读/检索）强制限定；默认全选；非第一章仍诚实定位失败 |
| U4 | 「学习总是一味下一步，没让我做题」 | 题目-阶段相似度映射未命中的题全部落入「综合巩固」区，而该区不在引导流程步骤里 | 未命中题轮流分配进各阶段（相似度只决定归属、不丢题）；在用户真实第七章数据上验证流程中题目出现 |
| U5 | 「着重点是学习路线规划，而不是知识点内容本身」 | 三层：① UI 默认展示方案层，chapter_context 的定义/定理全文未展示 ② designer prompt 允许 content 写成"读法指引" ③ **用户的 PDF 是扫描版**——正文无文字层，Agent 只能基于目录与零星文本工作（报告里自述"教材正文为扫描图像"） | ① 学习方案页新增「📖 知识内容本身」区（定义/定理/例子全文 + 教材出处）② designer prompt 升级：每条 content 必须先讲知识本身（是什么/为什么/例子），再给教材位置，禁止纯指引 ③ 新增**扫描版检测**：文字层稀疏（<120 字符/页）时在上传信息与分析开始时明确警告"分析深度将受限，建议文字版或 OCR" |

**扫描版限制说明（重要）**：用户的《高数下教材.pdf》为扫描版（文字层稀疏）。当前系统**不含 OCR**——
基于目录与少量可提取文本仍可产出结构与题目（已验证），但知识细节深度必然受限。
建议提供文字版 PDF，或先对扫描件做 OCR（如 Adobe/PaddleOCR）后再上传。
该限制已在产品内以警告形式明示（上传信息 + 分析开始事件）。

**回归**：后端 50 测试全过；build + lint 全绿；服务器重部署后知识内容区块 4/4 验证通过。


## 〇之五、服务器部署（香港 CN2 轻量云 2H2G，2026-09-27）

**线上地址：http://103.117.138.243/**（完整版：真实 DeepSeek 分析任意章节 + 学习/游戏模式）

- 系统 Ubuntu 22.04 · nginx 静态前端 + /api 反代 · FastAPI systemd 常驻 · swap 1G
- 部署方式：`deploy/` 套件（server-setup.sh 一键 + make-server-package.sh 打包）
- **服务器端真实分析验证**：目标「1.2 群的定义」→ 定位 P1 → 完整阅读 → 学习方案 →
  16 道题（3 批）→ 7 原则 QA 全过 → 独立验证 → COMPLETE，产物落盘
- 浏览器 E2E 6/6：完整版徽章 / 双章节历史 / 第一章结果 / 游戏模式章节世界 / 小节结果查看 / 无异常
- 修复：① prompts/ 目录漏传（分析失败，已补传并固化进打包脚本）
        ② Ubuntu nginx 默认站点抢占 80 端口（移除 sites-enabled/default）
        ③ .env 目录布局差异（config 期望 ROOT/.env）


## 〇之四、学情报告导出系统（2026-09-27）

面向「师-人-机协作」的第一步：学生的学习数据（此前只存本地、无出口）现在可以一键导出，
交给教师审阅，或以 JSON 供后续系统回流（如生成个人补救练习）。

**功能**：
- 入口 ①：结果面板工具栏「📥 学情报告」——随时打开，聚合两类本地数据：
  - 网页引导式学习：作答对错、正确率、错题（含题面/正确答案/解析/教材依据）、
    按 learning_objective 聚合的薄弱点分析、掌握标准自查勾选状态
  - 游戏模式：XP/等级（LV）、已完成关卡、各关战斗统计（挑战次数/通关/正确率）
- 入口 ②：引导式学习完成页「⬇ 下载学情报告 (Markdown) / 导出 JSON」
- 三种导出：下载 Markdown（教师可读）、导出 JSON（结构化回流）、复制全文
- 确定性规则生成学习建议（薄弱点聚合、待巩固提示、掌握标准未确认提示），
  不调用 LLM——静态部署下完全可用
- 明确标注：游戏 XP 是奖励进度，正确率才是掌握依据，两者分列

**验证**：E2E 14/14（注入 6 题作答 4 对 2 错 + 双关游戏存档 → 弹窗统计/错题/薄弱点/
战绩/自查全部正确；Markdown 下载内容完整；JSON 可解析且字段正确；复制反馈）。
线上部署复测通过。视觉验收通过（统计摘要 + 全文报告排版清晰）。

## 〇之三、游戏模式集成（edurealm 引擎嵌入，2026-09-25）

在 Chapter Learning Agent 顶部加入「🎮 游戏模式」一键切换：把 edurealm Phaser 引擎（地图/战斗/结算
全部复用，视觉零重设计）嵌入同一 React 应用，用已生成的章节产物直接构造游戏世界。

**自动化 E2E（playwright-core + headless Chromium，25/25 通过）**：
加载章节结果 → 🎮 进入 → 地图渲染（无白屏/单 canvas/HUD 章节世界名/等级芯片/返回按钮）→
点击 lv1 节点 → 关卡面板（+100 XP 奖励展示）→ 进入战斗 → 逐题正确作答（走引擎真实 handleAnswer
管线）→ VICTORY 结算（+130 XP = 100 通关 + 2×15 答对）→ 返回地图（lv1 完成、lv2 解锁）→
返回网页模式（Tabs 保留、canvas 销毁、Phaser 实例清零）→ 重进（XP/完成进度恢复）→
刷新页面（存档仍在）→ Web↔Game 连续切换 10 次（无重复 canvas、无实例泄漏、
无 console 错误、全程零 DeepSeek 调用）。
引擎自有单元测试（BattleEngine/作答判定/进度推导）37/37 通过。
视觉验收 4/4：地图 / 关卡面板 / 胜利结算 / 解锁后地图（lv2 无挂锁+亮标签，瀑布水雾确认为场景美术）。

**集成过程中发现并修复的 Bug**：

| # | 严重度 | 问题 | 修复 |
| --- | --- | --- | --- |
| G1 | **致命** | `game.destroy(true, true)` 第二参数 `noReturn=true` 会销毁 Phaser 模块级全局核心插件注册表（PluginCache）——首个实例销毁后，后续所有 `new Phaser.Game()` 在 boot 第一行 abort，表现为**第二次进入游戏模式永久黑屏**（仅 console.warn，无报错）。原版游戏整个生命周期只销毁一次所以从未暴露 | 改为 `destroy(true)`（noReturn=false），E2E 连续切换 10 次验证 |
| G2 | **高** | 原引擎 LevelSite 命中框因 Container `displayOrigin=(w/2,h/2)` 偏移半个身位——用户精确点击节点中心无响应（standalone 同样存在，属原版可用性 bug，本次集成测试暴露） | 命中框矩形补偿 origin（视觉零改动）；E2E 真实鼠标点击验证 |
| G3 | 高 | React StrictMode 的双挂载使第一个 Phaser 实例进入 pendingDestroy 僵尸态，抢写全局钩子/输入管线，地图交互时灵时不灵 | 移除 StrictMode（Phaser+React 集成的标准做法，注释说明原因） |
| G4 | 中 | StrictMode 残留 + pre-boot 销毁时 Phaser 遗留僵尸 canvas | destroy 后定点移除本实例画布 + `__erLive` 实例计数器钩子 |
| G5 | 低 | 章节世界雾区 3 区过大，解锁后的散雾仍罩住相邻节点，削弱"下一关解锁"反馈 | 适配器改为每节点独立雾区（引擎原生缺省语义），解锁哪关散哪关的雾 |
| G6 | 低 | unlocked 节点光晕 scale 2.6 在小世界过曝成白团盖住建筑 | 光晕收敛（贴地/减小/减淡），保留"当前可挑战"发光语义 |
| G7 | 中 | 共享存档槽（edurealm-save-v1）与章节存档互相污染 | 按章节独立存档槽 `game_state__<project>__<slug>`，进出时水合/恢复共享槽 |

**存档设计**：每章节独立槽（localStorage `game_state__abstract-algebra__第一章`），玩家等级
LV/XP 由 `xpRules.ts` 配置曲线（LV1→2 需 300，之后每级 +200）从总 XP 推导；XP 是游戏奖励
（通关类型加成），与知识掌握度（题目结果，levelStats）严格分离。


## 〇之三、视觉升级：沉浸式学习空间（2026-09-24）

按用户需求把网页往"学习环境"方向升级（纯前端，`styles.css` 全面重写 + `App/Sidebar/ResultPanel/LearningSession` 增强）：

- **三栏主界面精致化**：氛围渐变背景（多层 radial 光晕 + fixed）、渐变 Logo 文字、面板毛玻璃顶栏（backdrop-filter）+ 阴影圆角、主按钮渐变+悬浮上浮、卡片/选项 hover 反馈、空态美化；新增 980/1280px 响应式断点。
- **侧栏可收起**：顶栏「⇤ 收起资料栏 / ☰ 展开资料栏」按钮，收起后三栏变两栏（修复：Chrome 对 `grid-template-columns` 过渡动画失效导致轨道残留 272px 空白——移除该过渡）。
- **沉浸学习空间**：点「开始学习」后整页接管（左/中栏隐藏，学习空间全屏 1440px）：顶部章节名 + **阶段旅程导航点**（完成=蓝、当前=紫色脉冲光晕）+ 流光进度条 + 退出按钮；正文 780px 居中阅读版式 + fadeUp 入场动效；**键盘快捷键**（Enter/→ 继续、A–D 或 1–4 单选作答、Esc 退出）+ 底部快捷键提示栏；答题反馈区红/绿双高亮 + 解析 + 教材依据。
- **验收**：浏览器实测收起/展开、沉浸接管、6×Enter 步进、A 键判错（红/绿高亮）全通过；视觉审查员 2/2 pass（v2-home / v2-learn-retake 截图）。React 反模式修复（渲染期 setState）与快捷键数字映射修复。
- **重要发现（并行工作）**：检查期间发现 `src/edurealm/`（游戏引擎源码）、`src/game/`（chapterToGame 适配器 + GameContainer）被另一会话同步拷入/编辑，`package.json` 已加入 phaser。另有会话在 `App.tsx` 接入游戏模式（进行中，`tsc` 暂有 4 个未完成接线的 unused 报错，dev server 不受影响）。本轮修复了其中 2 个一行错误（未用导入/未用参数），其余留待该会话完成接线；`chapterToGame.ts` 的 3 处错误相对路径已修正。


## 〇之二、引导式学习模式（新增功能验证，2026-09-23）

按用户需求新增「▶ 开始学习」引导式学习会话（纯前端实现，数据来自已生成的 learning_plan + question_pool）：

- **实现**：`services/learning.ts`（阶段-题目 bigram 相似度映射 + localStorage 进度持久化）、
  `components/LearningSession.tsx`（状态机：阶段开场→内容逐条揭示→练习说明→逐题作答→阶段完成→最终报告）、
  ResultPanel 双入口（结果区头部 + 学习方案页顶部）。
- **心理学法则落地**：CLEAR GOAL（阶段开场展示目标）、SMALL WINS（阶段完成时刻+进度条）、
  IMMEDIATE FEEDBACK（选择题点击即判分/自评后即时解析）、MEANINGFUL AGENCY（先学内容 or 跳过直接练习）、
  CHALLENGE–SKILL MATCH（阶段内题目按难度 1→2→3）、REAL PROGRESS（只统计真实作答，结束页列未掌握题 +
  掌握标准自查）、CURIOSITY（沿用方案中的认知牵引顺序，逐条揭示而非一次性输出）。
- **浏览器端到端实测**（第一章，真实产物）：5 阶段逐步走通；内容 1/4→4/4 逐条揭示；
  选择题答对显示 ✅+解析、答错显示 ❌+正确答案+解析（选项红/绿高亮）；简答题"查看答案→自评"路径正常；
  阶段完成页统计正确；最终报告统计自洽（16 已作答 = 9 掌握 + 7 待巩固，56% 正确率），
  错题回顾 9 条、综合巩固 2 题（相似度阈值外未归入阶段的题）、掌握标准自查 6 项可勾选；
  **刷新页面后重新进入自动恢复进度**（直达完成报告）。视觉验收 2/2 + 底部滚动截图复核通过。
- 回归：build 通过、lint 0 问题；后端无改动（46 测试不受影响）。


## 〇、交付前全面复查轮（从零到一检查，2026-09-23）

对整个项目做了一次系统化复审：56 项文件完整性核对、8 个 Prompt 加载对齐、start.sh 语法、
requirements.txt 完整性（dry-run 验证）、pip check、前端锁文件、硬编码/密钥再审计、
后端 46 项测试、前端 build+lint、服务在线冒烟。**发现并修复 4 个新问题**：

| # | 严重度 | 问题 | 修复 |
| --- | --- | --- | --- |
| R1 | **高** | 前端 `request()` 只解析业务错误 `{error}` 字段，而 FastAPI `HTTPException` 返回 `{detail}` —— UI 上所有后端人类可读错误（"input/ 目录为空"、"项目不存在"等）实际显示为干巴巴的"请求失败（HTTP 404/400）" | `request()` 兼容两种形态；`ApiError` 携带完整响应体供 409 流程使用 |
| R2 | 中 | 同章节运行中重复提交（409）时，前端用原始输入当 slug 去查进度；含空格/标点的目标（如"8.3 一致收敛"）slug 化后不同 → 404 | 后端 `RunConflict` 携带 `run_id`，409 detail 返回 `{message, run_id}`；前端优先使用后端 run_id |
| R3 | 中 | FAILED 后重跑/force 重跑为全新开始，但不清空上一轮的 `events.jsonl`/`messages.json` → 新日志追加在旧日志后（seq 重复、两轮日志在 UI 混排）；旧部分产物残留 | controller 全新开始前清理 workspace 运行文件（均为可再生产物，input/ 绝不触碰）；已清洗现网演示数据 |
| R4 | 低 | `store/runs.py` 未用 import 与死变量；`parsers/base.py` 怪异辅助函数；已结束的运行句柄常驻内存 | 清理；`start_run` 顺手移除已结束句柄 |

新增 2 个回归测试锁定修复：`test_resume_from_mid_crash`（真·断点续跑：state 停留 GENERATE →
从该阶段继续至完成，断点前阶段不重跑）、`test_start_run_conflict_carries_run_id`（409 携带 run_id）。
修复后回归：**46/46 测试通过，build 通过，lint 0 问题**，服务在线冒烟（health 信封 / 缓存命中 /
detail 错误格式 / 浏览器加载 / 结果面板 18 题渲染）全部正常。


## 一、测试结论总览

| 项目 | 结果 |
| --- | --- |
| 后端单元/集成测试（pytest） | **44/44 通过** |
| 前端 TypeScript 检查 + Vite build | **通过**（tsc --noEmit + vite build，36 modules） |
| 前端 ESLint | **0 error / 0 warning** |
| 真实 DeepSeek 端到端（抽象代数·第一章） | **两轮全部 COMPLETE**（首跑 + 强制重跑） |
| 浏览器完整流程 + 视觉验收 | **4/4 Tab 全部 pass**（独立视觉审查员判定） |
| 异常场景 A–J | **全部通过**（详见第四节） |

## 二、真实端到端测试（测试教材：`sample_abstract_algebra.md`）

### 第 1 轮（正常分析）

- 全程 10 阶段完整走完，约 100 秒，真实调用 DeepSeek tool calling。
- Agent 行为符合预期：
  - `list_files` → `get_document_outline` → `find_section(target=第一章)` 定位 P1–P2（**未扫描第二章**）
  - `read_pages` 一次调用完整读取，控制器覆盖校验 2/2 页通过
  - `search_local("等价关系")` —— Minimal Backtracking：只在需要前置定义时检索
  - chapter_context：7 概念 / 5 定义 / 9 定理，**每条定义定理均带文件+页码出处**
  - learning_plan：7 个学习阶段（含有意义选择分支），掌握标准均为可检验行为
  - GENERATE：3 批提交共 18 题（批次机制真实生效）
  - PSYCHOLOGY_CHECK：发现方案不足 → **提交修订版方案** → 复查 → 7/7 通过（修订循环真实发生）
  - VERIFY：重解 18 题 → **发现 Q1 选项 B/D 重复（真实缺陷）并自动修正** → 第 2 轮复查 0 问题 → 通过
- 人工逐题审查（18 题）：答案全部正确，溯源有效，无教材外知识（用超纲概念清单扫描 chapter_context 无命中）。

### 第 2 轮（force 重跑）

- 缓存生效验证后强制重跑，again COMPLETE，产物全部重新生成。
- 人工复审查出 **1 处数学错误**：Q8（求 c⁻¹）答案标为 B（b∘a），正确应为 C（a∘b）。
  **根因是示例教材例 1.4.2 自身的设问与解答不匹配**（问 c⁻¹ 答了 c）——Agent 忠实遵循教材
  （grounding 设计使然），两轮自动验证均未发现是因为"教材即真理"。已做三处修复：
  1. 修正示例教材例 1.4.2（求 c，并补 c⁻¹ = a∘b 及结合律验证）；
  2. 修正本轮产物 Q8 答案为 C 并重写解析，重新渲染 questions.md / final_report.md；
  3. 在 ARCHITECTURE 记录该边界：教材自身错误会被 grounding 机制忠实放大，正式使用前教材内容需自行校对。

### 7 条学习心理学原则 QA 结果（两轮一致）

| 原则 | 结果 | 备注 |
| --- | --- | --- |
| CLEAR GOAL | ✅ 通过 | 每阶段有可检验目标 |
| IMMEDIATE FEEDBACK | ✅ 通过 | 每题含解析与教材依据 |
| REAL PROGRESS | ✅ 通过 | 掌握标准为"能独立做某事"，无虚假进度 |
| MEANINGFUL AGENCY | ✅ 通过 | 第 1 轮 QA 曾发现不足并修订方案后通过 |
| SMALL WINS | ✅ 通过 | 阶段拆分粒度合理 |
| CHALLENGE–SKILL MATCH | ✅ 通过 | 难度 1→2→3 分布 + 失败点补救策略 |
| CURIOSITY | ✅ 通过 | 用反直觉反例（1−2=−1 不封闭）开场牵引 |

## 三、自动化测试明细（44 项）

- `test_headings.py`（6）：中文数字互认、章/节标题识别、练习题列表行/量词行防误判、
  Markdown 模式过滤、章节范围切割、目标解析（第1章/8.3/纯文字）。
- `test_parsers.py`（6）：虚拟页行边界切分、GBK 编码回退、空文件、MD 多页、
  扫描件（空白 PDF）明确报错、真实文本 PDF 正向解析（cupsfilter 生成）。
- `test_tools.py`（10）：list_files、第一章定位（不越界到第二章）、不存在章节、参数校验、
  **分块阅读与 100% 覆盖统计**、部分覆盖判定、页码钳制、read_section、outline 纯净度、
  前置知识检索、workspace 读写与**路径穿越攻击**（../ /etc/passwd 反斜杠等）、
  **input 只读保护**（多工具操作后 input 字节+mtime 不变断言）。
- `test_schemas.py`（5）：context 出处强制、题目校验（答案字母/类型/难度/解析/依据/选项数）、
  方案校验（阶段数/重复 stage/掌握标准）、QA 报告（pass/issue/partial justification）、
  验证报告（re_solved 强制、overall_pass=false 必须有修复）。
- `test_agent_mock.py`（8）：**mock DeepSeek 服务器（真实 HTTP tool-calling 协议）全流程**
  （断言 10 阶段全部进入、8+7 工具真实执行、产物齐全、corrected_question 替换生效、QA 修订发生）、
  定位失败清晰报错、401 致命终止、**中途 500 失败→断点续跑→完成**、瞬时 500/429 重试自愈、
  缓存与 force 重跑、state.json 往返、slug 安全。
- `test_api.py`（6）：health、项目 CRUD 与非法名、上传（成功/同名拒绝/类型拒绝/未知项目 404）、
  analyze 参数校验、runs 404、raw 文件接口路径穿越拦截。

## 四、异常场景 A–J 实测

| # | 场景 | 结果 |
| --- | --- | --- |
| A | 正常运行第一章 | ✅ 两轮真实 API COMPLETE |
| B | 输入不存在章节（第九章） | ✅ Agent 多关键词检索（"第九章/第9章/九"）后拒绝猜测，FAILED 且错误信息明确列出目录与检索过程 |
| C | input 为空 | ✅ 快速失败：「input/ 目录为空：请先放入教材…」，无 LLM 调用 |
| D | 错误 API Key | ✅ 真实 401：fatal 终止，提示检查 .env；mock 401 测试同样通过 |
| E | 中途 API 失败 | ✅ mock 注入持续 500 → FAILED；解除后自动续跑至 COMPLETE；瞬时 500/429 自动重试自愈 |
| F | 重复分析第一章 | ✅ 第二次请求返回 `action=cached`，零 API 调用 |
| G | 重新运行第一章 | ✅ `force=true` 全新生成并覆盖（含界面 Re-run 按钮 confirm 弹窗） |
| H | 刷新网页 | ✅ 状态/结果全部从磁盘 state.json 恢复；运行中刷新可重新接上轮询 |
| I | 只输入"第一章" | ✅ 即主测试路径；"第1章/第一章 群/1.2 群的定义"等写法亦通过定位测试 |
| J | 长文档不整本进上下文 | ✅ 分块阅读（6000 字/次 + offset 游标）、工具结果 26000 字截断、页级覆盖统计强制按范围读取；测试覆盖 600 行 MD 多页场景 |

## 五、发现并修复的 Bug 清单

| # | 阶段 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | 开发中 | read_pages 已读页统计 off-by-2，范围最后一页永远不计入覆盖 → READ 阶段必然死循环被拒 | 重构为精确字节偏移索引（_build_range_text/_consumed_pages），并加续读循环测试 |
| 2 | 开发中 | find_section 候选解包错误（`cand(*int)`）导致定位工具崩溃 | 修正参数传递 |
| 3 | 开发中 | 题库非最终批次/方案修订提交误触发阶段结束 → GENERATE 提前收尾 | 仅 DESIGN 提交/GENERATE is_final/qa/verify/location/reading/context 结束阶段；批次返回 BATCH_ACCEPTED，修订返回 REVISION_ACCEPTED |
| 4 | 开发中 | LocateFailure 被 submit 回调的兜底 except 吞掉变成"提交被拒" | 显式 `except LocateFailure: raise` |
| 5 | 开发中 | Markdown 有序列表行（"1. **封闭性**…"）被误判为节级标题，可能截断小节范围 | MD 文档只认 `#` 标题；TXT 中 `N. 标题` 降为 sub 级；量词开头黑名单 |
| 6 | 联调中 | `/api/health` 返回扁平对象，前端统一解包 `data` 失败 → 健康徽章永远"连接中" | 后端改为 `{ok, data}` 信封，浏览器实测通过 |
| 7 | 联调中 | 5173 端口被旧进程占用导致页面串项目 | vite 允许自动 +1 端口；后端 CORS 放行 5173/5174 |
| 8 | E2E 审查 | 首跑 Q9 解析中"0+1=0+2 不能消去"的例子数学上不成立（加法自然数半群实际满足消去律） | 改为乘法反例（1·0=2·0=0, 1≠2）并重新渲染 |
| 9 | E2E 审查 | 重跑 Q8 答案错误（B），根因是**示例教材例 1.4.2 自身设问错误** | 修教材（求 c 并补 c⁻¹=a∘b 推导）+ 修产物（答案 C + 新解析）+ 重渲染；QA_REPORT 存档 |

## 六、已知不足

1. **示例教材的错误会被 grounding 机制忠实放大**（Q8 事件的教训）：正式使用时教材内容本身需先行校对；后续可加"教材自洽性检查"预跑步骤。
2. 页码为 PDF 真实页 / TXT·MD 虚拟分块页两套语义，工具返回中有说明，但引用到纸质页码时需要用户换算。
3. 扫描图片版 PDF 不支持（明确报错），需 OCR 预处理。
4. 中文数字 >99（如"第一百零八章"）不支持。
5. 同一章节不同写法（"第一章" vs "第1章"）视为两个缓存槽位（slug 不同），需分别分析。
6. 缓存失效以"章节完成状态"为准：教材文件更新后不会自动失效已有结果（需 force 重跑）。
7. 心理学 QA 的 partial 判定依赖模型自觉，存在形式主义通过的可能（本轮实测未见，但无硬性可执行校验）。

## 七、最终成功标准核对

网页可打开 ✅ / 项目资料可见 ✅ / 可上传 ✅ / 可输入章节 ✅ / 可启动分析 ✅ / DeepSeek 接入 ✅ /
真实工具调用 ✅ / 定位章节 ✅ / 完整阅读（覆盖强制）✅ / 不扫描整本书 ✅ / minimal backtracking ✅ /
chapter_context ✅ / learning_plan ✅ / question_pool（含答案解析）✅ / 7 原则 QA ✅ / 不满足自动修订 ✅ /
最终验证（独立重解+修正+复查轮）✅ / 结果落盘 ✅ / 前端展示 ✅ / 缓存 ✅ / Re-run ✅ / 状态文件 ✅ /
API 异常不崩溃 ✅ / 抽象代数第一章测试 ✅ / 测试输出人工审查 ✅ / build 通过 ✅ / QA 完成 ✅ /
README ✅ / QA_REPORT ✅
