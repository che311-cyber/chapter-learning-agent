"""产物 Schema 校验：所有 submit 载荷必须通过校验才能落盘/进入下一阶段。

校验策略：结构必须满足最小契约（缺失字段=拒绝），内容质量交给各阶段 Prompt + QA。
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

QUESTION_TYPES = {"single_choice", "multiple_choice", "short_answer",
                  "calculation", "proof", "ordering", "comparison"}
QA_KEYS = ["clear_goal", "immediate_feedback", "real_progress", "meaningful_agency",
           "small_wins", "challenge_skill_match", "curiosity"]


def _errs(ctx_list: List[str], msg: str) -> None:
    ctx_list.append(msg)


def _require_dict(payload: Dict[str, Any], keys: List[str]) -> List[str]:
    errors = []
    if not isinstance(payload, dict):
        return ["载荷必须是 JSON 对象"]
    for k in keys:
        if k not in payload or payload[k] in (None, ""):
            errors.append(f"缺少必填字段: {k}")
    return errors


def _str_list(v: Any, name: str, errors: List[str], min_len: int = 1) -> List[str]:
    if not isinstance(v, list) or len(v) < min_len:
        _errs(errors, f"{name} 必须是非空数组（≥{min_len}）")
        return []
    if any(not isinstance(x, str) or not x.strip() for x in v):
        errors.append(f"{name} 每项必须是非空字符串")
    return [x for x in v if isinstance(x, str) and x.strip()]


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_location(payload: Dict[str, Any]) -> List[str]:
    errors = _require_dict(payload, ["file", "start_page", "end_page"])
    if errors:
        return errors
    if type(payload["start_page"]) is not int or type(payload["end_page"]) is not int:
        return ["start_page / end_page 必须是整数"]
    sp, ep = payload["start_page"], payload["end_page"]
    if sp < 1 or ep < sp:
        errors.append(f"页码范围非法: {sp}–{ep}")
    if not _text(payload.get("file")):
        errors.append("file 必须是文件名字符串")
    if not _text(payload.get("heading")):
        errors.append("缺少 heading（定位到的章节标题原文）")
    return errors


def validate_reading(payload: Dict[str, Any]) -> List[str]:
    errors = _require_dict(payload, ["read_complete", "outline_summary"])
    if errors:
        return errors
    if payload.get("read_complete") is not True:
        errors.append("read_complete 必须为 true：只有完整读完目标章节后才允许提交")
    if len(str(payload.get("outline_summary", ""))) < 30:
        errors.append("outline_summary 过短，请概述本章结构（小节、定义、定理、例题分布）")
    return errors


def validate_chapter_context(payload: Dict[str, Any]) -> List[str]:
    errors = _require_dict(payload, ["chapter", "source_files", "core_concepts",
                                     "definitions", "theorems", "source_references"])
    if errors:
        return errors
    if not _text(payload.get("chapter")):
        errors.append("chapter 必须是非空文本")
    _str_list(payload.get("source_files"), "source_files", errors)
    concepts = _str_list(payload.get("core_concepts"), "core_concepts", errors, min_len=2)

    defs = payload.get("definitions")
    if not isinstance(defs, list) or len(defs) < 1:
        errors.append("definitions 必须是非空数组")
    else:
        for i, d in enumerate(defs):
            if not isinstance(d, dict) or not _text(d.get("term")) or not _text(d.get("content")):
                errors.append(f"definitions[{i}] 需要 term 与 content")
            elif not d.get("source_file") and not d.get("source"):
                errors.append(f"definitions[{i}]（{d.get('term')}）缺少教材出处 source_file/source_page —— 禁止无出处定义")

    thms = payload.get("theorems")
    if not isinstance(thms, list):
        errors.append("theorems 必须是数组（可为空）")
    elif any(not isinstance(t, dict) or not _text(t.get("name")) or not _text(t.get("content")) for t in thms):
        errors.append("theorems 每项需要文本 name 与 content")

    refs = payload.get("source_references")
    if not isinstance(refs, list) or len(refs) < 1:
        errors.append("source_references 必须是非空数组（保留文件名+页码防止幻觉）")
    else:
        for i, r in enumerate(refs):
            if not isinstance(r, dict) or not _text(r.get("file")):
                errors.append(f"source_references[{i}] 缺少 file")
    for key in ("skills", "common_mistakes", "difficulty_points", "prerequisites"):
        if key in payload:
            _str_list(payload[key], key, errors, min_len=0)
    if "key_examples" in payload and (not isinstance(payload["key_examples"], list) or any(
            not isinstance(ex, dict) or not _text(ex.get("name"))
            or ("content" in ex and not isinstance(ex["content"], str)) for ex in payload["key_examples"])):
        errors.append("key_examples 必须是文本 name/content 的对象列表")
    if not concepts:
        errors.append("core_concepts 至少需要 2 个核心概念")
    return errors


def validate_learning_plan(payload: Dict[str, Any]) -> List[str]:
    errors = _require_dict(payload, ["chapter", "learning_objectives",
                                     "learning_sequence", "mastery_criteria"])
    if errors:
        return errors
    if not _text(payload.get("chapter")):
        errors.append("chapter 必须是非空文本")
    _str_list(payload.get("learning_objectives"), "learning_objectives", errors, min_len=2)
    _str_list(payload.get("mastery_criteria"), "mastery_criteria", errors, min_len=2)
    if "common_failure_points" in payload:
        _str_list(payload["common_failure_points"], "common_failure_points", errors, min_len=0)
        if isinstance(payload["common_failure_points"], list) and any(
                not isinstance(item, str) for item in payload["common_failure_points"]):
            errors.append("common_failure_points 每项必须是字符串：失败点与补救策略合并为文字。")

    seq = payload.get("learning_sequence")
    if not isinstance(seq, list) or len(seq) < 2:
        errors.append("learning_sequence 至少需要 2 个学习阶段")
        return errors
    seen_stages = set()
    for i, s in enumerate(seq):
        if not isinstance(s, dict):
            errors.append(f"learning_sequence[{i}] 必须是对象")
            continue
        for k in ("stage", "name", "goal"):
            if k != "stage" and not _text(s.get(k)):
                errors.append(f"learning_sequence[{i}] 缺少 {k}")
        if type(s.get("stage")) is int and s["stage"] >= 1:
            st = s["stage"]
            if st in seen_stages:
                errors.append(f"learning_sequence stage 编号重复: {st}")
            seen_stages.add(st)
        else:
            errors.append(f"learning_sequence[{i}].stage 必须是正整数")
        if not _str_list(s.get("content"), f"learning_sequence[{i}].content", errors, min_len=1):
            pass
        if "practice" in s:
            _str_list(s["practice"], f"learning_sequence[{i}].practice", errors, min_len=0)
    return errors


def validate_question(q: Any, idx: int, errors: List[str], ids_seen: set) -> None:
    if not isinstance(q, dict):
        errors.append(f"questions[{idx}] 必须是对象")
        return
    qid = q.get("id", "") if isinstance(q.get("id", ""), str) else ""
    qid = qid.strip()
    if not qid:
        errors.append(f"questions[{idx}] 缺少 id")
    elif qid in ids_seen:
        errors.append(f"题目 id 重复: {qid}")
    ids_seen.add(qid)
    if not isinstance(q.get("type"), str) or q["type"] not in QUESTION_TYPES:
        errors.append(f"questions[{idx}]（{qid}）type 必须是 {sorted(QUESTION_TYPES)} 之一，实际: {q.get('type')}")
    if type(q.get("difficulty")) is not int or not 1 <= q["difficulty"] <= 3:
        errors.append(f"questions[{idx}]（{qid}）difficulty 必须是 1/2/3")
    if q.get("stage_index") is not None and (type(q["stage_index"]) is not int or q["stage_index"] < 1):
        errors.append(f"questions[{idx}]（{qid}）stage_index 必须是正整数")
    for k in ("prompt", "answer", "explanation", "learning_objective"):
        if not _text(q.get(k)):
            errors.append(f"questions[{idx}]（{qid}）缺少 {k}")
    basis = q.get("source_basis")
    if not isinstance(basis, list) or not basis or any(not _text(b) for b in basis):
        errors.append(f"questions[{idx}]（{qid}）source_basis 必须非空（题目必须能对应到教材出处）")
    if q.get("type") in ("single_choice", "multiple_choice"):
        opts = q.get("options")
        if not isinstance(opts, list) or not 2 <= len(opts) <= 26 or any(not _text(opt) for opt in opts):
            errors.append(f"questions[{idx}]（{qid}）选择题需要 ≥2 个 options")
        else:
            letters = [chr(65 + i) for i in range(len(opts))]
            ans = str(q.get("answer", "")).strip().upper().replace(",", "").replace("，", "")
            valid = all(c in letters for c in ans) and ans
            if q["type"] == "single_choice":
                valid = valid and len(ans) == 1
            else:
                valid = valid and len(set(ans)) == len(ans)
            if not valid:
                errors.append(f"questions[{idx}]（{qid}）选择题答案 {q.get('answer')!r} 必须是选项字母组合（如 A / ABD）")


def validate_question_pool(payload: Dict[str, Any], is_final: bool) -> List[str]:
    errors = _require_dict(payload, ["chapter", "questions"])
    if errors:
        return errors
    qs = payload.get("questions")
    if not isinstance(qs, list):
        return ["questions 必须是数组"]
    ids_seen: set = set()
    for i, q in enumerate(qs):
        validate_question(q, i, errors, ids_seen)
    if is_final and len(qs) < 5:
        errors.append(f"练习总数 {len(qs)} 太少：最终题库至少 5 道题")
    if len(qs) > 60:
        errors.append("练习总数超过 60，请控制在合理范围")
    diffs = [q.get("difficulty") for q in qs if isinstance(q, dict)]
    if is_final and qs and not (1 in diffs):
        errors.append("难度覆盖不足：至少需要 difficulty=1 的基础题")
    return errors


def _qa_item(v: Any, name: str, errors: List[str]) -> None:
    if not isinstance(v, dict):
        errors.append(f"{name} 必须是对象 {{pass, issues, changes}}")
        return
    if not isinstance(v.get("pass"), bool):
        errors.append(f"{name}.pass 必须是布尔值")
    for k in ("issues", "changes"):
        if not isinstance(v.get(k), list) or any(not _text(item) for item in v[k]):
            errors.append(f"{name}.{k} 必须是数组（可为空）")
    if v.get("pass") is False and not (isinstance(v.get("issues"), list) and any(_text(i) for i in v["issues"])):
        errors.append(f"{name}.pass=false 时必须给出 issues（发现了什么问题）")


def validate_qa_report(payload: Dict[str, Any]) -> List[str]:
    errors = _require_dict(payload, QA_KEYS)
    if errors:
        return errors
    for k in QA_KEYS:
        _qa_item(payload.get(k), k, errors)
    # 部分适用声明：pass=true 且 partial=true 时必须有 justification
    for k in QA_KEYS:
        item = payload.get(k)
        if isinstance(item, dict) and item.get("partial") and not str(item.get("justification", "")).strip():
            errors.append(f"{k} 声明 partial=true 时必须给出 justification（为何该原则只能部分应用）")
    return errors


def qa_all_pass(payload: Dict[str, Any]) -> bool:
    return all(isinstance(payload.get(k), dict) and payload[k].get("pass") is True
               for k in QA_KEYS)


def validate_verification(payload: Dict[str, Any]) -> List[str]:
    errors = _require_dict(payload, ["re_solved", "issues", "overall_pass"])
    if errors:
        return errors
    if payload.get("re_solved") is not True:
        errors.append("re_solved 必须为 true：验证阶段必须独立重新解题，不能默认原答案正确")
    if not isinstance(payload.get("issues"), list):
        errors.append("issues 必须是数组（可为空）")
    if not isinstance(payload.get("overall_pass"), bool):
        errors.append("overall_pass 必须是布尔值")
    for i, it in enumerate(payload.get("issues", []) if isinstance(payload.get("issues"), list) else []):
        if not isinstance(it, dict) or not _text(it.get("question_id")) or not _text(it.get("problem")):
            errors.append(f"issues[{i}] 需要 question_id 与 problem")
    if "verified_count" in payload and (type(payload["verified_count"]) is not int or payload["verified_count"] < 0):
        errors.append("verified_count 必须是非负整数")
    # 无法修复的缺陷允许如实报告为 unresolved，不能强迫填写虚假的修复描述。
    return errors


# ---- 阶段六：QA 四态语义（确定性推导，展示层禁止把 PARTIAL 当通过）----
def qa_item_status(item: Dict[str, Any]) -> str:
    """单条原则状态：PASS / PARTIAL / FAIL。"""
    if not isinstance(item, dict):
        return "FAIL"
    if item.get("pass") is True:
        return "PARTIAL" if item.get("partial") else "PASS"
    return "FAIL"


def qa_report_status(report: Dict[str, Any]) -> str:
    """整体：全部 PASS → PASS；有 FAIL → FAIL；含 PARTIAL → PARTIAL。"""
    keys = ["clear_goal", "immediate_feedback", "real_progress", "meaningful_agency",
            "small_wins", "challenge_skill_match", "curiosity"]
    statuses = [qa_item_status(report.get(k)) for k in keys if isinstance(report, dict)]
    if not statuses:
        return "FAIL"
    if any(x == "FAIL" for x in statuses):
        return "FAIL"
    if any(x == "PARTIAL" for x in statuses):
        return "PARTIAL"
    return "PASS"
