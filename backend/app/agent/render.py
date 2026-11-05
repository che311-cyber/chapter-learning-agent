"""把结构化产物渲染为人类可读的 Markdown（output/ 目录）。"""
from __future__ import annotations

from typing import Any, Dict, List

DIFF_LABEL = {1: "基础", 2: "中等", 3: "挑战"}


def _l(items: List[Any]) -> str:
    return "\n".join(f"- {x}" for x in items)


def render_learning_plan(plan: Dict[str, Any]) -> str:
    lines = [f"# 学习方案：{plan.get('chapter', '')}", ""]
    lines += ["## 学习目标", _l(plan.get("learning_objectives", [])), ""]
    lines += ["## 推荐学习顺序", ""]
    for s in plan.get("learning_sequence", []):
        lines.append(f"### 阶段 {s.get('stage')}：{s.get('name', '')}")
        lines.append(f"**目标**：{s.get('goal', '')}")
        lines.append("")
        lines.append("**内容**：")
        lines.append(_l(s.get("content", [])))
        if s.get("practice"):
            lines.append("")
            lines.append("**练习**：")
            lines.append(_l(s.get("practice", [])))
        if s.get("psychology_note"):
            lines.append("")
            lines.append(f"> 设计意图：{s['psychology_note']}")
        lines.append("")
    lines += ["## 掌握标准（真实进度）", _l(plan.get("mastery_criteria", [])), ""]
    if plan.get("common_failure_points"):
        lines += ["## 常见失败点与补救", _l(plan.get("common_failure_points", [])), ""]
    return "\n".join(lines)


def render_questions(pool: Dict[str, Any]) -> str:
    lines = [f"# 练习题：{pool.get('chapter', '')}", "",
             f"共 {len(pool.get('questions', []))} 题。建议先作答再查看答案。", ""]
    for i, q in enumerate(pool.get("questions", []), start=1):
        diff = q.get("difficulty")
        type_label = {"single_choice": "单选", "multiple_choice": "多选",
                      "short_answer": "简答", "calculation": "计算",
                      "proof": "证明", "ordering": "排序", "comparison": "对比"}.get(q.get("type"), q.get("type"))
        lines.append(f"## {i}. [{type_label}·{DIFF_LABEL.get(diff, diff)}] {q.get('learning_objective', '')}")
        lines.append("")
        lines.append(str(q.get("prompt", "")).strip())
        opts = q.get("options")
        if isinstance(opts, list) and opts:
            lines.append("")
            for j, opt in enumerate(opts):
                lines.append(f"- {chr(65 + j)}. {opt}")
        lines.append("")
        lines.append(f"<details><summary>查看答案</summary>")
        lines.append("")
        lines.append(f"**答案**：{q.get('answer', '')}")
        lines.append("")
        lines.append(f"**解析**：{q.get('explanation', '')}")
        lines.append("")
        src = q.get("source_basis")
        if isinstance(src, list) and src:
            lines.append(f"**教材依据**：{'；'.join(str(s) for s in src)}")
        lines.append("")
        lines.append("</details>")
        lines.append("")
    return "\n".join(lines)


def render_qa_section(qa: Dict[str, Any]) -> List[str]:
    names = {"clear_goal": "1. CLEAR GOAL（目标明确）",
             "immediate_feedback": "2. IMMEDIATE FEEDBACK（即时反馈）",
             "real_progress": "3. REAL PROGRESS（真实进度）",
             "meaningful_agency": "4. MEANINGFUL AGENCY（有意义的选择）",
             "small_wins": "5. SMALL WINS（小步成功）",
             "challenge_skill_match": "6. CHALLENGE–SKILL MATCH（难度匹配）",
             "curiosity": "7. CURIOSITY（认知牵引）"}
    lines = []
    for key, title in names.items():
        item = qa.get(key) or {}
        passed = item.get("pass") is True
        mark = "✅ 通过" if passed else "❌ 未通过"
        if passed and item.get("partial"):
            mark += "（部分应用）"
        lines.append(f"- **{title}**：{mark}")
        for issue in item.get("issues", []) or []:
            lines.append(f"  - 问题：{issue}")
        for ch in item.get("changes", []) or []:
            lines.append(f"  - 修改：{ch}")
        if item.get("partial"):
            lines.append(f"  - 说明：{item.get('justification', '')}")
    return lines


def render_final_report(ctx, context: Dict, plan: Dict, pool: Dict,
                        qa: Dict, verify: Dict, state: Dict) -> str:
    lines = [f"# 最终报告：{context.get('chapter', ctx.target)}", ""]
    lines += ["## 目标章节", f"- 用户目标：{ctx.target}", ""]
    lines += ["## 资料来源"]
    located = ctx.located or {}
    if located:
        lines.append(f"- 教材文件：{located.get('file')}")
        lines.append(f"- 章节定位：{located.get('heading', '')}（第 {located.get('start_page')}–{located.get('end_page')} 页）")
    for r in context.get("source_references", [])[:10]:
        page = r.get("page", "")
        lines.append(f"- {r.get('file', '')} P{page} {r.get('locator', '')}".strip())
    lines.append("")

    lines += ["## 核心知识", ""]
    for d in context.get("definitions", []):
        src = f"（{d.get('source_file', '')} P{d.get('source_page', '')}）" if d.get("source_file") else ""
        lines.append(f"- **{d.get('term', '')}**：{d.get('content', '')}{src}")
    for t in context.get("theorems", []):
        lines.append(f"- **定理/性质 {t.get('name', '')}**：{t.get('content', '')}")
    lines.append("")

    lines += ["## 推荐学习顺序（摘要）", ""]
    for s in plan.get("learning_sequence", []):
        lines.append(f"{s.get('stage')}. **{s.get('name', '')}** —— {s.get('goal', '')}")
    lines.append("")

    qs = pool.get("questions", [])
    by_diff: Dict[int, int] = {}
    for q in qs:
        try:
            by_diff[int(q.get("difficulty"))] = by_diff.get(int(q.get("difficulty")), 0) + 1
        except (TypeError, ValueError):
            pass
    lines += ["## 练习结构", "",
              f"- 题目总数：{len(qs)}（基础 {by_diff.get(1, 0)} / 中等 {by_diff.get(2, 0)} / 挑战 {by_diff.get(3, 0)}）", ""]

    lines += ["## 7 条学习心理学原则 QA", ""]
    lines += render_qa_section(qa)
    lines.append("")

    lines += ["## 最终验证结果", ""]
    if verify:
        from .verification import summarize_verification
        verify = summarize_verification(verify, pool)
        lines.append(f"- 独立重解题数：{verify.get('verified_count', len(qs))}")
        issues = verify.get("issues", []) or []
        lines.append(f"- 发现问题：{len(issues)} 个")
        counts = verify["issue_counts"]
        lines.append(f"- 实际修正：{counts['corrected']} 处；未解决：{counts['unresolved']} 项；无需修正：{counts['no_change_needed']} 项")
        for it in issues[:10]:
            lines.append(f"  - [{it.get('severity', '?')}] {it.get('question_id', '')}: {it.get('problem', '')}")
        lines.append(f"- 总体结论：{'✅ 通过' if verify.get('overall_pass') else '⚠️ 未完全通过（见上）'}")
    else:
        lines.append("- （无验证报告）")
    lines.append("")

    if ctx.flags.get("psychology_check_complete") and not qa_all_pass(qa):
        lines += ["> 注意：部分心理学原则在修订轮次上限内未能完全通过，已在上方标注。", ""]
    lines += ["---", f"*由 Chapter Learning Agent 自动生成（模型：{state.get('model', '')}），内容以教材为最终依据。*"]
    return "\n".join(lines)


def qa_all_pass(qa: Dict[str, Any]) -> bool:
    keys = ["clear_goal", "immediate_feedback", "real_progress", "meaningful_agency",
            "small_wins", "challenge_skill_match", "curiosity"]
    return all(isinstance(qa.get(k), dict) and qa[k].get("pass") is True for k in keys)
