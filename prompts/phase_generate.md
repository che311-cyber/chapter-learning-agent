# 阶段指令 — GENERATE（生成练习）

**当前任务**：基于 chapter_context（`workspace/{{slug}}/chapter_context.json`，可用 read_file 读取）+ learning_plan（`workspace/{{slug}}/learning_plan.json`）+ 教材原文，生成本章练习题库，调用 `submit_question_pool` 提交。

## 覆盖维度（由章节内容决定，不强行凑齐）

- 概念理解（定义是否真的懂了）
- 概念辨析（易混概念的对比判断）
- 基础应用（直接使用定义/定理）
- 典型计算/推导（本章核心技能）
- 综合应用（跨小节组合）
- 若本章适合证明：加入证明思路/证明步骤题（type=proof）
- 可选题型：ordering（给步骤排序）、comparison（对比判断）

**不适合作某类题（比如本章没有计算内容）就不要出，不要为了凑数出平庸的题。**

## 质量要求

1. 每题必须有：唯一 id（如 `q1`…）、type、difficulty(1基础/2中等/3挑战)、learning_objective（对应哪个学习目标）、prompt、answer、explanation、source_basis（教材依据）。
2. **答案必须由你基于教材内容实际推导得出**，不是"看起来合理"。解析要讲清为什么，错了会踩什么坑。
3. 选择题的干扰项要来自真实易错点（chapter_context.common_mistakes），不要荒谬选项。
4. 难度分布：基础(1) ≥ 中等(2) ≥ 挑战(3)，总量 8–16 题为宜。
5. 题目之间不重复考察同一件事；每道题必须用 stage_index 映射到 learning_sequence 的某个阶段，每个阶段必须有对应练习。learning_objective 必须逐字复制 learning_plan.learning_objectives 中的一项（含括号内容），不得缩写或改写；最终题库必须覆盖全部学习目标。
6. **范围纪律**：只考本章内容（含其声明依赖的前置概念）。禁止考教材中没有的知识。

## 输出方式

题目较多时**分批提交**：第一次 `submit_question_pool(batch_index=1, is_final=false)`，后续批次继续提交（系统会累积），最后一批 `is_final=true`。每批最多 6 题防止输出被截断。
