> 开发阶段的架构说明；当前安装、模型配置与数据约定以 README.md 为准。

# ARCHITECTURE — Chapter Learning Agent V1

## 1. 设计目标

把「一章教材 → 高质量学习方案 + 练习」稳定自动化。核心不是 Prompt 本身，而是
**Prompt + Tool Calling + File Environment + State Machine + Persistence + Structured Output + QA + Frontend**
构成的可执行 Agent 系统。

## 2. 总体结构

```
┌──────────┐   HTTP/poll    ┌────────────────────── Backend (FastAPI :8000) ─────────────────────┐
│ Frontend │ ─────────────► │  api/routes ── store/runs ── agent/Controller（后台线程）            │
│ React+TS │                │                                    │                               │
│  :5173   │ ◄───────────── │   status/events/result（state.json + events.jsonl 驱动）            │
└──────────┘                │                                    │                               │
                            │   Controller ── agent/Loop ── services/DeepSeek（HTTP，重试/容错）   │
                            │        │            │                                              │
                            │        │            └── tools/registry（8 信息工具 + 7 提交工具）      │
                            │        └── state_machine（TARGET→…→COMPLETE，state.json 持久化）    │
                            │   parsers/（pdf·txt·md·docx·pptx → 统一 Page 模型 + 缓存）           │
                            └────────────────────────────────────────────────────────────────────┘
                                             │ 只读                      │ 写
                                     projects/<p>/input/         projects/<p>/workspace/<章节>/
                                     （用户教材，绝不修改）         projects/<p>/output/<章节>/
```

分层解耦：**Agent 逻辑（controller/loop/state machine）、工具（tools/）、解析器（parsers/）、
LLM 服务（services/）、API（api/）、前端、文件数据（projects/）** 相互独立，无巨型文件。

## 3. 状态机（固定）

```
TARGET → LOCATE → READ → UNDERSTAND → DESIGN → GENERATE → PSYCHOLOGY_CHECK → VERIFY → SAVE → COMPLETE
   │        │        │         │          │         │              │              │        │
   │     find_     read_    chapter_   learning_  question_     qa_report     verify    渲染
   │     section   pages    context    _plan      _pool(分批)    (+修订循环)    (复查轮)  落盘
   └── 失败任意阶段 → FAILED（error 人类可读）；用户可取消 → CANCELLED
```

- **每阶段独立工具白名单**（`tools/registry.PHASE_TOOLS`）：LOCATE 只给
  `list_files/get_document_outline/find_section`，READ 只给 `read_pages/read_section/search_local`……
  从机制上禁止"还没读就设计"。
- **阶段收尾必须调用 submit_\* 工具**，后端做 Schema 校验（`agent/schemas.py`），拒绝则把具体
  错误回传给模型令其自我修正——这是防幻觉/防摆烂的硬闸门。
- **state.json 每次落盘**；`messages.json` 保存完整对话。进程崩溃/重启后，`start_run`
  检测到未完成状态即自动续跑（同 phase、同对话历史继续）。

## 4. Agent Loop（真执行，非模拟）

`agent/loop.PhaseRunner` 每轮：

1. `DeepSeekClient.chat(messages, tools)` —— OpenAI 兼容 `/chat/completions`，
   `tool_choice=auto`；429/5xx/网络错误指数退避重试，401/402/400 直接致命终止并给出可读原因。
2. 有 tool_calls → 逐个**真实执行**（`tools/registry.execute_tool`）：
   - 参数 JSON 解析失败 / 缺必填字段 / 工具异常 → `TOOL_ERROR: …` 回传模型自我修正
   - 结果超长截断（TOOL_RESULT_MAX_CHARS）并提示分页
3. submit_\* 工具 → controller 校验载荷；`SUBMIT_ACCEPTED` 结束阶段；`SUBMIT_REJECTED`
   附带原因继续循环（如 READ 未读完会得到缺页清单）。
4. 模型纯文本不提交 → 提示注入（最多 MAX_NUDGES 次）；每阶段工具轮次有硬上限
   （MAX_TOOL_ITERATIONS_PER_PHASE=30），杜绝无限循环。
5. finish_reason=length → 提醒模型分批（题库支持 batch + is_final）。

## 5. 教材 Grounding 机制（防幻觉的三道闸）

1. **Prompt 层**（prompts/*.md）：知识来源=用户教材；未读取禁止产出；外部常识仅辅助；
   冲突以教材为准。
2. **工具层**：页码只能来自 `find_section/get_document_outline` 真实返回（禁止猜页码）；
   READ 阶段控制器按**页级覆盖统计**（read_pages 的精确字节偏移索引）强制 100% 完整阅读，
   未读完的 submit_reading 直接拒绝并列出缺页。
3. **产物层**：chapter_context 的每条定义/定理必须带 `source_file(+source_page)`；
   每道题必须带 `source_basis`；VERIFY 阶段必须独立重解题目（re_solved=true 强制）。

## 6. Current Chapter First / Minimal Backtracking

- 定位只处理目标章节；`section_range` 以下一同级标题截断范围，Agent 物理上看不到
  "整本书塞进上下文"的路径（read_pages 只按定位范围+显式回溯页读取）。
- 回溯：仅当本章依赖未定义概念时，`search_local` 全库检索 → 只 `read_pages` 该定义所在页。
  回溯次数记录在 submit_reading.backtracking_queries。

## 7. QA 修订循环与验证轮

- **PSYCHOLOGY_CHECK**：7 条原则逐条 `{pass, issues, changes, partial?, justification?}`。
  有 pass=false 却未提交任何修订 → 拒绝；修订（learning_plan/question_pool 的 revision 提交）
  后复查；MAX_QA_REVISION_ROUNDS=3 轮上限，超限定稿并在最终报告标注（诚实呈现而非伪装通过）。
- **VERIFY**：独立重解题目 → issues[].corrected_question 由控制器**替换回题库**并落盘；
  有修正时自动进入第 2 轮复查（MAX_VERIFY_ROUNDS=2）。

## 8. 解析器

统一 `ParsedDocument{pages[]}`（1-based 页）：

- PDF：pdfplumber 优先（中文排版稳），pypdf 兜底；提取不到文本 → 判定扫描件并明确报错
- TXT/MD：编码回退链 utf-8-sig→utf-8→gb18030→big5→latin-1；按行边界切 ~2200 字符虚拟页
- DOCX/PPTX：python-docx / python-pptx，保留标题层级/表格/逐页文本
- 标题识别（`parsers/headings.py`）：中文章节（第X章/节/讲/单元，中文数字互认）、
  `N`/`N.M` 编号、Chapter N、Markdown `#`。MD 文档只认 `#` 标题防列表误判；
  TXT 中 `N. 标题` 降级为 sub 级，量词开头（"3 个性质"）黑名单排除。

## 9. 安全

- API Key 仅存在于 `.env`（gitignore）；日志/异常/前端永不回显 Key
- 路径安全：工具层拒绝 `..`、绝对路径、越界 resolve；write_file 仅限 workspace/ 子树；
  read_file 仅限 workspace/ 与 output/（教材必须走 read_pages 保证覆盖统计）
- input/ 只读：上传同名文件直接 409 语义拒绝；所有工具执行前后测试断言 input 字节与 mtime 不变
- LLM 返回值不直接信任：所有 submit 载荷过 Schema 校验后才落盘/替换题库

## 10. 与游戏引擎（edurealm）的衔接点

- `learning_plan.learning_sequence[].stage` → 未来 MapSpec 的关卡节点顺序
- `question_pool.questions[]`（type/difficulty/options/answer/explanation）→ LevelSpec 题目数据
- `qa_report` / `mastery_criteria` → 游戏内真实进度与奖励的判定依据
- 因此 V1 刻意让所有产物**结构化 + 可溯源 + 难度分级**，游戏层无需再猜测语义。
