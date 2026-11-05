"""教师闭环存储：审核发布状态、教师批注/追加任务、学生学情报告。

文件布局（workspace/<slug>/ 下）：
  review.json            {"status": "draft|published", "note": 教师批注/追加任务, "difficulty_note": ..., "updated_at"}
  learning_reports/      学生上传的学情报告 JSON（按时间戳命名）
所有写操作原子化；未初始化时 status 默认按 draft 处理（新分析需教师发布后才算正式发布给学生）。
"""
from __future__ import annotations

import json
import math
import threading
import time
from functools import wraps
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from ..agent.context import atomic_write_json, atomic_write_text

_write_lock = threading.RLock()


class TeacherValidationError(ValueError):
    pass


class TeacherBusyError(Exception):
    pass


def _serialized(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        from . import runs
        # 与启动分析共用锁，避免路由检查通过后恰好启动生成，导致教师修改被覆盖。
        with runs._lock, _write_lock:
            project = args[0] if args else kwargs["project"]
            slug = args[1] if len(args) > 1 else kwargs["slug"]
            if runs.get_controller(project, slug) is not None:
                raise TeacherBusyError("当前章节仍在分析或保存，请稍后再修改")
            return function(*args, **kwargs)
    return wrapped


def _ws(project: str, slug: str) -> Path:
    from .projects import project_dir

    if slug.startswith(".") or "/" in slug or "\\" in slug:
        raise ValueError("章节路径不合法")
    return project_dir(project) / "workspace" / slug


def _atomic(path: Path, obj: Any) -> None:
    atomic_write_json(path, obj)


def _record_edit(project: str, slug: str, description: str) -> None:
    review = read_review(project, slug)
    now = time.time()
    review.update(status="needs_review", edited_at=now, updated_at=now)
    review.pop("teacher_override", None)
    review["history"] = (review.get("history", []) + [
        {"status": "needs_review", "at": now, "note": description},
    ])[-20:]
    _atomic(_ws(project, slug) / "review.json", review)


def read_review(project: str, slug: str) -> Dict[str, Any]:
    f = _ws(project, slug) / "review.json"
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key, default in (("note", ""), ("difficulty_note", ""), ("tasks", []), ("history", [])):
                    if data.get(key) is None:
                        data[key] = default
                for key in ("edited_at", "content_confirmed_at"):
                    if data.get(key) is None:
                        data.pop(key, None)
                invalid = data.get("status", "draft") not in ("draft", "needs_review", "approved", "published", "blocked")
                invalid = invalid or any(key in data and not isinstance(data[key], str) for key in ("note", "difficulty_note"))
                for key, text in (("tasks", "task"), ("history", "status")):
                    if key in data:
                        invalid = invalid or not isinstance(data[key], list) or any(
                            not isinstance(item, dict) or not isinstance(item.get(text), str) for item in data[key])
                for key in ("updated_at", "edited_at", "content_confirmed_at"):
                    value = data.get(key)
                    invalid = invalid or (value is not None and (type(value) not in (int, float) or not math.isfinite(value)))
                if invalid:
                    return {"status": "needs_review", "note": "", "difficulty_note": "", "updated_at": None,
                            "block_reasons": ["审核记录格式异常，请教师重新审核"], "corrupt": True}
                return data
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            pass
    return {"status": "draft", "note": "", "difficulty_note": "", "updated_at": None}


# 审核状态机（阶段二）：DRAFT → NEEDS_REVIEW → APPROVED → PUBLISHED；draft 为旧值兼容别名
REVIEW_STATUSES = ("draft", "needs_review", "approved", "published", "blocked")


def _quality(project: str, slug: str) -> Dict[str, Any]:
    f = _ws(project, slug) / "state.json"
    try:
        from .quality import audit_source
        state = json.loads(f.read_text(encoding="utf-8")) or {}
        def load(name):
            path = f.parent / name
            return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        return audit_source(state, load("chapter_context.json"), load("verification.json"))
    except Exception:
        return {}


def quality_gate(project: str, slug: str) -> Dict[str, Any]:
    """发布前确定性质量门控：{ok, reasons}。涵盖正文覆盖/定位/QA状态/题目覆盖。"""
    q = _quality(project, slug)
    reasons = []
    missing_artifacts = False
    unfinished = False
    state_file = _ws(project, slug) / "state.json"
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            unfinished = state.get("status") != "COMPLETE"
            if state.get("status") in ("COMPLETE", "NEEDS_REVIEW", "INCOMPLETE"):
                from .quality import artifact_readable
                for name in ("chapter_context", "learning_plan", "question_pool", "qa_report", "verification"):
                    path = state_file.parent / (name + ".json")
                    if not path.exists() or not artifact_readable(name, json.loads(path.read_text(encoding="utf-8"))):
                        missing_artifacts = True
                        break
        except (ValueError, UnicodeDecodeError, OSError, AttributeError):
            missing_artifacts = True
    else:
        unfinished = True
    if unfinished:
        reasons.append("章节分析尚未完成，请先完成分析再审核发布")
    if missing_artifacts:
        reasons.append("章节成果缺失或损坏，请重新分析补齐后再发布")
    review = read_review(project, slug)
    if review.get("corrupt"):
        reasons.append("审核记录格式异常，请先重新审核")
    if review.get("edited_at", 0) > review.get("content_confirmed_at", 0):
        reasons.append("题目或学习方案已修改，请教师重新审核或显式确认后发布")
    if not q:
        reasons.append("缺少质量数据（state.json 无 quality 字段，可能为旧版本分析）——需要重新分析或教师确认")
    else:
        if q.get("requiresReview"):
            reasons.append("旧成果需要重新质量复核，不能沿用旧发布状态")
        # content_status 检查（阶段一核心门控）
        cs = q.get("contentStatus")
        if cs in ("STRUCTURE_ONLY", "BLOCKED", "UNKNOWN"):
            reasons.append("仅生成目录结构级内容（STRUCTURE_ONLY），正文缺失——不能作为教学内容发布")
        elif cs == "PARTIAL_CONTENT":
            reasons.append("正文内容部分缺失（PARTIAL_CONTENT）——需教师确认后发布")
        # readableCoverage
        if float(q.get("readableCoverage", 0)) < 0.6:
            reasons.append(
                f"正文可读覆盖率仅 {int(float(q.get('readableCoverage', 0)) * 100)}%"
                f"（{q.get('pagesReadable', 0)}/{q.get('pagesTotal', 0)} 页）——正文不可靠读取")
        if q.get("locationConfidence") == "low":
            reasons.append("章节定位置信度为 low（可能定位到目录页）")
        # locationState 检查
        ls = q.get("locationState")
        if ls in ("TOC_LOCATED", "READING_LIMITED", "TARGET_RECOGNIZED", "UNKNOWN"):
            if ls != "UNKNOWN" or cs == "UNKNOWN":
                reasons.append(f"章节定位/阅读状态为 {ls}——正文尚未成功读取")
    # QA 状态：FAIL / PARTIAL 均不放行自动发布
    qa_file = _ws(project, slug) / "qa_report.json"
    if qa_file.exists():
        try:
            from ..agent.schemas import qa_report_status
            qa_st = qa_report_status(json.loads(qa_file.read_text(encoding="utf-8")))
            if qa_st == "FAIL":
                reasons.append("心理学原则 QA 存在未通过项（FAIL）")
            elif qa_st == "PARTIAL":
                reasons.append("心理学原则 QA 为部分通过（PARTIAL）——需教师确认后发布")
        except Exception:
            reasons.append("QA 报告不可读")
    # 题目覆盖：学习目标应有题目（确定性计数）
    pool_file = _ws(project, slug) / "question_pool.json"
    plan_file = _ws(project, slug) / "learning_plan.json"
    if pool_file.exists() and plan_file.exists():
        try:
            pool = json.loads(pool_file.read_text(encoding="utf-8"))
            plan = json.loads(plan_file.read_text(encoding="utf-8"))
            qs = pool.get("questions", [])
            # unassigned 检查：缺 stage_index 的题
            unassigned = [q for q in qs if q.get("stage_index") is None]
            if unassigned:
                reasons.append(f"存在 {len(unassigned)} 道未分配阶段的题目（unassigned）——不能发布")
            stages = {str(s.get("stage")) for s in plan.get("learning_sequence", [])}
            covered_stages = {str(q.get("stage_index")) for q in qs}
            if stages - covered_stages:
                reasons.append("存在没有练习题的学习阶段——需补齐阶段练习")
            # 目标覆盖检查
            qobjs = {str(q.get("learning_objective", "")).strip()
                     for q in qs if q.get("stage_index") is not None}
            missing = [o for o in plan.get("learning_objectives", [])
                       if str(o).strip() and str(o).strip() not in qobjs]
            if missing:
                reasons.append(f"学习目标缺少对应题目（{len(missing)} 项）——"
                               f"如：{missing[0][:50]}")
        except Exception:
            reasons.append("题库/学习方案不可读，无法校验题目覆盖")
    verify_file = _ws(project, slug) / "verification.json"
    if verify_file.exists():
        try:
            from ..agent.verification import summarize_verification
            pool = json.loads(pool_file.read_text(encoding="utf-8")) if pool_file.exists() else {}
            verify = summarize_verification(json.loads(verify_file.read_text(encoding="utf-8")), pool)
            if not verify.get("overall_pass"):
                reasons.append("独立验证存在未解决项，需修正后复查")
        except Exception:
            reasons.append("独立验证报告不可读")
    hard_blocked = (unfinished or missing_artifacts or q.get("requiresReview") is True or q.get("sourceScope") == "TOC_ONLY"
                    or q.get("contentStatus") in ("STRUCTURE_ONLY", "BLOCKED", "UNKNOWN")
                    or float(q.get("readableCoverage", 0)) < 0.6)
    return {"ok": not reasons, "reasons": reasons, "quality": q, "hard_blocked": hard_blocked}


# 合法流转：需要教师操作的目标状态
TRANSITIONS = {
    "needs_review": {"draft", "published"},        # 提交审核（教师确认后 from draft 亦可直接发布）
    "approved": {"needs_review", "draft", "blocked"},
    "published": {"approved", "blocked"},          # 仅 APPROVED/BLOCKED 可发布
    "draft": set(REVIEW_STATUSES) - {"draft"},     # 撤回/退回到草稿：任意状态可回
    "blocked": set(),
}


@_serialized
def set_review(project: str, slug: str, status: str, note: Optional[str] = None,
               difficulty_note: Optional[str] = None,
               teacher_confirmed: bool = False) -> Dict[str, Any]:
    rev = read_review(project, slug)
    cur = rev.get("status", "draft")
    # 质量门控优先于流转检查：发布先过门控，不通过 → blocked（教师可确认强制）
    if status == "published":
        gate = quality_gate(project, slug)
        if not gate["ok"] and (not teacher_confirmed or gate["hard_blocked"]):
            rev["status"] = "blocked"
            rev["block_reasons"] = gate["reasons"]
            rev["updated_at"] = time.time()
            _atomic(_ws(project, slug) / "review.json", rev)
            return {"blocked": True, "reasons": gate["reasons"], **rev}
        if not gate["ok"] and teacher_confirmed:
            rev["teacher_override"] = {"at": time.time(), "reasons": gate["reasons"]}
        if cur not in TRANSITIONS["published"] and not teacher_confirmed:
            return {"invalid_transition": True, "reasons": ["请先审核通过，再发布章节内容"], **rev}
    elif status == cur:
        pass
    elif status in ("needs_review", "approved"):
        allowed_from = TRANSITIONS.get(status, set())
        if cur not in allowed_from:
            return {"invalid_transition": True,
                    "reasons": [f"当前状态 {cur} 不能直接变更为 {status}（合法流转见状态机）"],
                    **rev}
    if status in REVIEW_STATUSES:
        rev["status"] = status
    if status == "approved":
        rev["content_confirmed_at"] = time.time()
        rev.pop("corrupt", None)
    if status == "published":
        rev.pop("block_reasons", None)
    if note is not None:
        rev["note"] = note[:4000]
    if difficulty_note is not None:
        rev["difficulty_note"] = difficulty_note[:1000]
    rev["updated_at"] = time.time()
    hist = rev.get("history", [])
    hist.append({"status": rev["status"], "at": rev["updated_at"],
                 "note": (note or rev.get("note", "") or "")[:200]})
    rev["history"] = hist[-20:]
    _atomic(_ws(project, slug) / "review.json", rev)
    return rev


def save_learning_report(project: str, slug: str, data: Dict[str, Any]) -> Dict[str, Any]:
    _validate_report(data)
    ts = time.time()
    name = f"report-{int(ts * 1000)}-{uuid4().hex[:12]}.json"
    body = {**data, "student": data.get("student", ""), "submitted_at": ts}
    _atomic(_ws(project, slug) / "learning_reports" / name, body)
    return {"saved": name, "submitted_at": ts}


def _validate_report(data: Dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise TeacherValidationError("学情报告必须是对象")
    for key, numbers in (("learning", ("answered", "correct", "wrong", "accuracy")),
                         ("game", ("xp", "level"))):
        section = data.get(key) or {}
        if not isinstance(section, dict):
            raise TeacherValidationError(f"{key} 必须是对象")
        for name in numbers:
            value = section.get(name)
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value)
                                      or value < 0 or (name == "accuracy" and value > 100)):
                raise TeacherValidationError(f"{key}.{name} 必须是有效的非负数，正确率范围为 0–100")
    for key, text_fields in (("objectiveWeakness", ("objective",)),
                             ("wrongQuestions", ("id", "prompt", "answer")),
                             ("mastery", ("criterion",))):
        items = (data.get("learning") or {}).get(key) or []
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise TeacherValidationError(f"learning.{key} 必须是对象列表")
        if any(not isinstance(item.get(name, ""), str) for item in items for name in text_fields):
            raise TeacherValidationError(f"learning.{key} 的文本字段必须是字符串")
        if key == "objectiveWeakness" and any(
                type(item.get(name, 0)) not in (int, float) or not math.isfinite(item.get(name, 0))
                or item.get(name, 0) < 0 for item in items for name in ("wrong", "total")):
            raise TeacherValidationError("薄弱目标的计数必须是有效非负数")
        if key == "mastery" and any("checked" in item and type(item["checked"]) is not bool for item in items):
            raise TeacherValidationError("掌握状态必须是布尔值")
    learning = data.get("learning") or {}
    if all(learning.get(key) is not None for key in ("answered", "correct", "wrong")):
        if any(type(learning[key]) is not int for key in ("answered", "correct", "wrong")):
            raise TeacherValidationError("作答题数必须是非负整数")
        if learning["answered"] != learning["correct"] + learning["wrong"]:
            raise TeacherValidationError("作答题数与正确、错误题数不一致")
        if learning.get("accuracy") is not None:
            expected = 100 * learning["correct"] / learning["answered"] if learning["answered"] else 0
            if abs(learning["accuracy"] - expected) > 1:
                raise TeacherValidationError("正确率与作答明细计数不一致")
    submitted = data.get("submitted_at")
    if submitted is not None and (type(submitted) not in (int, float) or not math.isfinite(submitted)):
        raise TeacherValidationError("提交时间无效")


def _summarize(report: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"submitted_at": report.get("submitted_at")}
    ln = report.get("learning") or {}
    out["answered"] = ln.get("answered", 0)
    out["correct"] = ln.get("correct", 0)
    out["wrong"] = ln.get("wrong", 0)
    out["accuracy"] = ln.get("accuracy")
    gm = report.get("game") or {}
    out["game_xp"] = gm.get("xp", 0)
    out["game_level"] = gm.get("level", 0)
    weak = []
    for w in ln.get("objectiveWeakness", []) or []:
        weak.append({"objective": w.get("objective", ""), "wrong": w.get("wrong", 0), "total": w.get("total", 0)})
    out["weak_objectives"] = weak[:6]
    out["wrong_questions"] = [
        {"id": q.get("id", ""), "prompt": (q.get("prompt", "") or "")[:80], "answer": q.get("answer", "")}
        for q in (ln.get("wrongQuestions", []) or [])
    ][:10]
    out["mastery"] = [
        {"criterion": m.get("criterion", ""), "checked": bool(m.get("checked"))}
        for m in (ln.get("mastery", []) or [])
    ]
    return out


def list_learning_reports(project: str, slug: str) -> List[Dict[str, Any]]:
    d = _ws(project, slug) / "learning_reports"
    if not d.exists():
        return []
    out = []
    for f in sorted(d.glob("report-*.json")):
        try:
            report = json.loads(f.read_text(encoding="utf-8"))
            _validate_report(report)
            out.append(_summarize(report))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError, TeacherValidationError):
            continue
    out.sort(key=lambda x: -(x.get("submitted_at") or 0))
    return out


# ---- 题目编辑/删除（教师干预，持久化到 question_pool.json）----

def _pool_path(project: str, slug: str) -> Path:
    return _ws(project, slug) / "question_pool.json"


def _load_pool(project: str, slug: str) -> Dict[str, Any]:
    f = _pool_path(project, slug)
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if (not isinstance(data, dict) or not isinstance(data.get("questions"), list)
                    or any(not isinstance(q, dict) for q in data["questions"])):
                raise TeacherValidationError("题库结构损坏，请先重新分析或恢复备份")
            return data
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            raise TeacherValidationError("题库无法读取，请先重新分析或恢复备份")
    return {"questions": []}


def _save_pool(project: str, slug: str, pool: Dict[str, Any]) -> None:
    _atomic(_pool_path(project, slug), pool)


def _sync_exports(project: str, slug: str) -> None:
    """教师修改后 JSON 与可导出的 Markdown 使用同一份内容。"""
    from types import SimpleNamespace
    from ..agent import render
    from .quality import artifact_readable
    ws = _ws(project, slug)
    output = ws.parents[1] / "output" / slug
    if not output.exists():
        return
    values = {}
    for name in ("state", "chapter_context", "learning_plan", "question_pool", "qa_report", "verification"):
        try:
            value = json.loads((ws / (name + ".json")).read_text(encoding="utf-8"))
            values[name] = value if isinstance(value, dict) else {}
        except (ValueError, UnicodeDecodeError, OSError):
            values[name] = {}
    plan, pool = values["learning_plan"], values["question_pool"]
    if artifact_readable("learning_plan", plan):
        atomic_write_text(output / "learning_plan.md", render.render_learning_plan(plan))
    if artifact_readable("question_pool", pool):
        atomic_write_text(output / "questions.md", render.render_questions(pool))
    if all(artifact_readable(name, values[name]) for name in
           ("chapter_context", "learning_plan", "question_pool", "qa_report", "verification")):
        state = values["state"]
        ctx = SimpleNamespace(target=state.get("target", slug), located=state.get("located"), flags=state.get("flags") or {})
        text = render.render_final_report(ctx, values["chapter_context"], plan, pool,
                                         values["qa_report"], values["verification"], state)
        atomic_write_text(output / "final_report.md", "> 教师修改后的版本；自动验证报告保留修改前记录，需重新审核。\n\n" + text)


@_serialized
def delete_question(project: str, slug: str, qid: str) -> Dict[str, Any]:
    pool = _load_pool(project, slug)
    before = len(pool.get("questions", []))
    pool["questions"] = [q for q in pool.get("questions", []) if str(q.get("id")) != str(qid)]
    if before != len(pool["questions"]):
        _record_edit(project, slug, f"删除题目 {qid}")
        _save_pool(project, slug, pool)
        _sync_exports(project, slug)
    return {"deleted": qid, "remaining": len(pool["questions"]), "removed": before != len(pool["questions"])}


@_serialized
def update_question(project: str, slug: str, qid: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    pool = _load_pool(project, slug)
    editable = {"prompt", "answer", "explanation", "options", "difficulty",
                "learning_objective", "stage_index", "source_basis", "type"}
    changes = {key: value for key, value in patch.items() if key in editable}
    if not changes:
        raise TeacherValidationError("没有提供可修改的题目字段")
    for key, value in changes.items():
        if key in ("difficulty", "stage_index"):
            if type(value) is not int or value < 1 or (key == "difficulty" and value > 3):
                raise TeacherValidationError(f"{key} 必须为有效的正整数，难度范围为 1–3")
        elif key in ("options", "source_basis"):
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                raise TeacherValidationError(f"{key} 必须是文本列表")
        elif not isinstance(value, str) or (key in ("prompt", "answer") and not value.strip()):
            raise TeacherValidationError(f"{key} 必须是有效文本，题干和答案不能为空")
    for q in pool.get("questions", []):
        if str(q.get("id")) == str(qid):
            from ..agent.schemas import QUESTION_TYPES, validate_question
            candidate = dict(q, **changes)
            if "type" in changes and changes["type"] not in QUESTION_TYPES:
                raise TeacherValidationError("题目类型不受支持")
            # 完整新题沿用生成校验；旧记录先保留兼容，不能引入新的选项/答案冲突。
            if all(name in candidate for name in ("type", "difficulty", "explanation", "learning_objective", "source_basis")):
                errors = []
                validate_question(candidate, 0, errors, set())
                if errors:
                    raise TeacherValidationError("；".join(errors[:4]))
            q.update(changes)
            _record_edit(project, slug, f"修改题目 {qid}：{'、'.join(changes)}")
            _save_pool(project, slug, pool)
            _sync_exports(project, slug)
            return {"updated": qid, "question": q}
    raise ValueError(f"题目不存在: {qid}")


@_serialized
def update_learning_plan(project: str, slug: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    """教师修改学习目标/阶段标题/阶段内容。"""
    f = _ws(project, slug) / "learning_plan.json"
    if not f.exists():
        raise ValueError("learning_plan.json 不存在")
    plan = json.loads(f.read_text(encoding="utf-8"))
    if not patch or not set(patch) <= {"learning_objectives", "learning_sequence"}:
        raise TeacherValidationError("请提供可修改的学习目标或阶段内容")
    if "learning_objectives" in patch:
        values = patch["learning_objectives"]
        if not isinstance(values, list) or not values or any(not isinstance(v, str) or not v.strip() for v in values):
            raise TeacherValidationError("学习目标必须是非空文本列表")
        plan["learning_objectives"] = patch["learning_objectives"]
    if "learning_sequence" in patch:
        values = patch["learning_sequence"]
        if (not isinstance(values, list) or not values or len(values) > len(plan.get("learning_sequence", []))
                or any(not isinstance(st, dict) for st in values)):
            raise TeacherValidationError("阶段内容必须是已有学习阶段的对象列表")
        for stage in values:
            if "name" in stage and (not isinstance(stage["name"], str) or not stage["name"].strip()):
                raise TeacherValidationError("阶段名称不能为空")
            if "content" in stage and (not isinstance(stage["content"], list) or not stage["content"]
                    or any(not isinstance(v, str) or not v.strip() for v in stage["content"])):
                raise TeacherValidationError("阶段内容必须是非空文本列表")
        for i, st in enumerate(plan.get("learning_sequence", [])):
            if i < len(patch["learning_sequence"]):
                if "name" in patch["learning_sequence"][i]:
                    st["name"] = patch["learning_sequence"][i]["name"]
                if "content" in patch["learning_sequence"][i] and isinstance(patch["learning_sequence"][i]["content"], list):
                    st["content"] = patch["learning_sequence"][i]["content"]
    _record_edit(project, slug, "修改学习方案")
    _atomic(f, plan)
    _sync_exports(project, slug)
    return {"updated": True, "plan": plan}


@_serialized
def add_teacher_task(project: str, slug: str, task: str) -> Dict[str, Any]:
    """教师追加任务：写入 review 的『追加任务』区，学生学习页可见。"""
    rev = read_review(project, slug)
    tasks = rev.get("tasks", [])
    tasks.append({"task": task[:500], "at": time.time()})
    rev["tasks"] = tasks[-50:]
    rev["updated_at"] = time.time()
    _atomic(_ws(project, slug) / "review.json", rev)
    return rev
