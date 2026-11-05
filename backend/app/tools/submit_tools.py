"""submit_* 工具定义：Agent 用它们提交各阶段产物，controller 校验后驱动状态机。

参数 JSON Schema 与 agent/schemas.py 的校验函数一一对应。
"""
from __future__ import annotations

from typing import Any, Dict, List

from .base import Tool


def _arr(item: Dict[str, Any], desc: str) -> Dict[str, Any]:
    return {"type": "array", "items": item, "description": desc}


def _str_item() -> Dict[str, Any]:
    return {"type": "string"}


def build_all() -> List[Tool]:
    location = Tool(
        name="submit_location",
        description="【LOCATE 阶段提交】提交目标章节的定位结果。只有基于 find_section 的真实结果才可提交；确实找不到时 file 填 'NOT_FOUND' 并在 heading 说明原因。",
        parameters={
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "教材文件名；定位失败填 NOT_FOUND"},
                "heading": {"type": "string", "description": "命中的章节标题原文"},
                "start_page": {"type": "integer"},
                "end_page": {"type": "integer"},
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                "notes": {"type": "string"},
            },
            "required": ["file"],
            "additionalProperties": False,
        },
        handler=None,
    )

    reading = Tool(
        name="submit_reading",
        description="【READ 阶段提交】确认目标章节已完整读取（read_pages 必须读到 has_more=false）。summary 需概述本章结构。",
        parameters={
            "type": "object",
            "properties": {
                "read_complete": {"type": "boolean"},
                "outline_summary": {"type": "string", "description": "本章结构概述：小节顺序、定义/定理/例题分布"},
                "chunks_read": {"type": "integer"},
                "backtracking_queries": {"type": "array", "items": _str_item(),
                                         "description": "为理解本章而回溯检索过的前置概念（可为空）"},
                "notes": {"type": "string"},
            },
            "required": ["read_complete", "outline_summary"],
            "additionalProperties": False,
        },
        handler=None,
    )

    src_ref = {"type": "object",
               "properties": {"file": {"type": "string"}, "page": {"type": "integer"},
                              "locator": {"type": "string", "description": "标题/小节号等文本定位"}},
               "required": ["file"]}

    context = Tool(
        name="submit_chapter_context",
        description="【UNDERSTAND 阶段提交】提交本章临时理解（chapter_context）。所有定义/定理必须带教材出处（文件+页码），禁止凭模型记忆编写。",
        parameters={
            "type": "object",
            "properties": {
                "chapter": {"type": "string"},
                "source_files": _arr(_str_item(), "本章内容来源文件名列表"),
                "core_concepts": _arr(_str_item(), "核心概念（≥2）"),
                "definitions": _arr({"type": "object", "properties": {
                    "term": {"type": "string"}, "content": {"type": "string"},
                    "source_file": {"type": "string"}, "source_page": {"type": "integer"}},
                    "required": ["term", "content", "source_file"]}, "定义列表，每条带出处"),
                "theorems": _arr({"type": "object", "properties": {
                    "name": {"type": "string"}, "content": {"type": "string"},
                    "source_file": {"type": "string"}, "source_page": {"type": "integer"}},
                    "required": ["name", "content"]}, "定理/性质列表"),
                "key_examples": _arr({"type": "object", "properties": {
                    "name": {"type": "string"}, "content": {"type": "string"}},
                    "required": ["name"]}, "关键例子"),
                "skills": _arr(_str_item(), "本章训练的技能（如：验证群公理）"),
                "common_mistakes": _arr(_str_item(), "常见错误"),
                "difficulty_points": _arr(_str_item(), "难点"),
                "prerequisites": _arr(_str_item(), "本章依赖的前置知识"),
                "source_references": _arr(src_ref, "本章内容出处汇总（file+page）"),
            },
            "required": ["chapter", "source_files", "core_concepts", "definitions",
                         "theorems", "source_references"],
            "additionalProperties": False,
        },
        handler=None,
    )

    plan = Tool(
        name="submit_learning_plan",
        description="【DESIGN 阶段提交】提交学习方案。learning_sequence 是有顺序的学习阶段（先直觉后形式化等），每个阶段含 goal/content/practice。",
        parameters={
            "type": "object",
            "properties": {
                "chapter": {"type": "string"},
                "learning_objectives": _arr(_str_item(), "学完本章应达成的目标（≥2）"),
                "learning_sequence": _arr({"type": "object", "properties": {
                    "stage": {"type": "integer"},
                    "name": {"type": "string"},
                    "goal": {"type": "string"},
                    "content": _arr(_str_item(), "这一阶段学什么/怎么学"),
                    "practice": _arr(_str_item(), "这一阶段的练习形式"),
                    "psychology_note": {"type": "string", "description": "设计意图（如先抛反直觉问题）"}},
                    "required": ["stage", "name", "goal", "content"]},
                    "有序学习阶段（≥2）"),
                "mastery_criteria": _arr(_str_item(), "掌握标准：能独立做什么才算掌握（禁止虚假进度）"),
                "common_failure_points": _arr(_str_item(), "常见失败点与补救策略"),
            },
            "required": ["chapter", "learning_objectives", "learning_sequence", "mastery_criteria"],
            "additionalProperties": False,
        },
        handler=None,
    )

    question_item = {"type": "object", "properties": {
        "id": {"type": "string"},
        "stage_index": {"type": "integer", "description": "所属学习阶段编号（必须与 learning_plan 的 stage 对应）"},
        "type": {"type": "string", "enum": ["single_choice", "multiple_choice", "short_answer",
                                            "calculation", "proof", "ordering", "comparison"]},
        "difficulty": {"type": "integer", "enum": [1, 2, 3]},
        "learning_objective": {"type": "string", "description": "逐字复制 learning_plan.learning_objectives 中的一项，不得缩写或改写"},
        "prompt": {"type": "string"},
        "options": {"type": "array", "items": _str_item(),
                    "description": "选择题选项（A/B/C/D 对应数组顺序）；非选择题可省略"},
        "answer": {"type": "string"},
        "explanation": {"type": "string"},
        "source_basis": _arr(_str_item(), "教材依据（如 '第1章 定义1.2，P3'）"),
    }, "required": ["id", "type", "difficulty", "learning_objective", "prompt",
                    "answer", "explanation", "source_basis"]}

    pool = Tool(
        name="submit_question_pool",
        description="【GENERATE/修订阶段提交】提交练习题批次。题目必须覆盖概念理解/辨析/应用/计算/证明等维度（由章节内容决定，不强行凑类型）。答案与解析必须正确。",
        parameters={
            "type": "object",
            "properties": {
                "chapter": {"type": "string"},
                "questions": _arr(question_item, "本批题目"),
                "batch_index": {"type": "integer", "description": "批次号，从 1 开始"},
                "is_final": {"type": "boolean", "description": "这是最后一批吗"},
                "revision": {"type": "boolean", "description": "修订全量题库；分批时 batch_index 从1递增，首批替换旧题库，后续累积，最后 is_final=true"},
            },
            "required": ["chapter", "questions", "is_final"],
            "additionalProperties": False,
        },
        handler=None,
    )

    qa_item = {"type": "object",
               "properties": {"pass": {"type": "boolean"},
                              "issues": {"type": "array", "items": _str_item()},
                              "changes": {"type": "array", "items": _str_item(),
                                          "description": "为通过本条而做的修改"},
                              "partial": {"type": "boolean",
                                          "description": "因课程性质只能部分应用该原则"},
                              "justification": {"type": "string"}},
               "required": ["pass", "issues", "changes"]}

    qa = Tool(
        name="submit_qa_report",
        description="【PSYCHOLOGY_CHECK 阶段提交】按 7 条学习游戏心理学原则逐条检查学习方案与练习。pass=false 的条目必须先修改方案再重新提交检查。",
        parameters={
            "type": "object",
            "properties": {k: qa_item for k in
                           ["clear_goal", "immediate_feedback", "real_progress",
                            "meaningful_agency", "small_wins", "challenge_skill_match",
                            "curiosity"]},
            "required": ["clear_goal", "immediate_feedback", "real_progress",
                         "meaningful_agency", "small_wins", "challenge_skill_match", "curiosity"],
            "additionalProperties": False,
        },
        handler=None,
    )

    verify = Tool(
        name="submit_verification",
        description="【VERIFY 阶段提交】最终验证报告。必须对每道题独立重新解题核对答案/解析，发现问题给出修正（corrected_question 提供完整修正后的题目）。",
        parameters={
            "type": "object",
            "properties": {
                "re_solved": {"type": "boolean", "description": "是否真的独立重解了题目"},
                "verified_count": {"type": "integer"},
                "issues": _arr({"type": "object", "properties": {
                    "question_id": {"type": "string"},
                    "severity": {"type": "string", "enum": ["critical", "minor"]},
                    "problem": {"type": "string"},
                    "fix_applied": {"type": "string"},
                    "corrected_question": question_item},
                    "required": ["question_id", "problem"]}, "发现的问题（可为空）"),
                "overall_pass": {"type": "boolean"},
                "coverage_notes": {"type": "string", "description": "题目对学习目标的覆盖情况"},
                "notes": {"type": "string"},
            },
            "required": ["re_solved", "verified_count", "issues", "overall_pass"],
            "additionalProperties": False,
        },
        handler=None,
    )

    return [location, reading, context, plan, pool, qa, verify]
