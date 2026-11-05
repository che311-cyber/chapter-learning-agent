"""运行管理器：后台线程 + 并发去重 + 缓存/续跑判断 + 状态查询。"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..agent.controller import AnalysisController
from ..agent.context import read_event_tail, slugify
from ..agent.state_machine import PHASES
from .. import config

_lock = threading.RLock()
_active: Dict[str, AnalysisController] = {}  # "project/slug" -> controller
_TERMINAL = {"COMPLETE", "FAILED", "CANCELLED", "NEEDS_REVIEW", "INCOMPLETE"}


def run_key(project: str, slug: str) -> str:
    return f"{project}/{slug}"


class RunConflict(Exception):
    """同一章节已有运行在进行中。"""

    def __init__(self, message: str, run_id: str):
        super().__init__(message)
        self.run_id = run_id


class RunCapacityError(Exception):
    pass


class TargetCollision(ValueError):
    pass


def _run_controller(key: str, controller: AnalysisController) -> None:
    try:
        controller.run()
    finally:
        with _lock:
            if _active.get(key) is controller:
                _active.pop(key, None)


def start_run(project: str, target: str, force: bool = False,
              allowed_files: Optional[List[str]] = None) -> Dict[str, Any]:
    """启动（或续跑）一次分析。返回 {run_id, action}。"""
    slug = slugify(target)
    key = run_key(project, slug)
    with _lock:
        existing = _active.get(key)
        # 最后一轮落盘结束前仍持有运行槽，避免新运行与旧线程的 finally 互相覆盖。
        if existing is not None:
            raise RunConflict(f"章节「{target}」正在分析中，请等待完成或查看当前进度", run_id=slug)
        # 顺手清掉已结束的旧句柄，避免内存常驻
        _active.pop(key, None)

        state = read_state(project, slug) or {}
        if state.get("target") and "".join(str(state["target"]).split()) != "".join(target.split()):
            raise TargetCollision("该名称与已有章节共用存储路径，请使用可区分的章节标题，以免覆盖原成果")
        all_inputs = {p.name: [p.stat().st_mtime_ns, p.stat().st_size]
                      for p in (config.PROJECTS_DIR / project / "input").glob("*")
                      if p.is_file() and p.suffix.lower() in config.ALLOWED_UPLOAD_EXTS}
        scope = set(allowed_files) if allowed_files is not None else set(all_inputs)
        previous_scope = set(state.get("allowed_files") or all_inputs)
        versions = {name: all_inputs[name] for name in scope if name in all_inputs}
        changed = bool(state) and (scope != previous_scope or (
            state.get("source_versions") is not None and state["source_versions"] != versions))
        force = force or changed
        complete = is_complete(project, slug)
        if complete and not force:
            return {"run_id": slug, "action": "cached"}

        active_count = len(_active)
        if active_count >= config.MAX_CONCURRENT_RUNS:
            raise RunCapacityError(f"当前已有 {active_count} 个分析任务，请稍后重试；已有成果仍可正常浏览")
        resumed = not force and (state.get("status") in PHASES[:-1]
                                  or state.get("resume_phase") in PHASES[:-1])

        controller = AnalysisController(project, target, force=force, allowed_files=allowed_files)
        from .teacher import read_review, set_review

        if not read_review(project, slug).get("updated_at") or force or not complete:
            set_review(project, slug, "draft", note="")
        _active[key] = controller
        thread = threading.Thread(target=_run_controller, args=(key, controller),
                                  name=f"run-{key}", daemon=True)
        try:
            thread.start()
        except Exception:
            _active.pop(key, None)
            raise
        action = "resumed" if resumed else "started"
        return {"run_id": slug, "action": action}


def get_controller(project: str, slug: str) -> Optional[AnalysisController]:
    return _active.get(run_key(project, slug))


def cancel_run(project: str, slug: str) -> bool:
    c = _active.get(run_key(project, slug))
    if c is None:
        return False
    c.ctx.cancel_event.set()
    return True


def _workspace_dir(project: str, slug: str) -> Path:
    return config.PROJECTS_DIR / project / "workspace" / slug


def read_state(project: str, slug: str) -> Optional[Dict[str, Any]]:
    f = _workspace_dir(project, slug) / "state.json"
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        return None


def is_complete(project: str, slug: str) -> bool:
    state = read_state(project, slug)
    if not state or state.get("status") != "COMPLETE":
        return False
    return result_payload(project, slug, include_markdown=False)["status"] == "COMPLETE"


def list_runs(project: str) -> list:
    ws = config.PROJECTS_DIR / project / "workspace"
    out = []
    if ws.exists():
        for d in sorted(ws.iterdir()):
            if d.is_dir():
                state = read_state(project, d.name)
                if state:
                    status = state.get("status")
                    # 完整性校验：标记 COMPLETE 但缺必需产物 → 降级为"结果缺失"
                    if status == "COMPLETE":
                        status = result_payload(project, d.name, include_markdown=False)["status"]
                    out.append({"slug": d.name, "target": state.get("target"),
                                "status": status,
                                "updated_at": state.get("updated_at"),
                                "error": state.get("error")})
    return out


def project_status_payload(project: str, slug: str) -> Dict[str, Any]:
    """合并内存运行态 + 磁盘状态 + 事件流（供前端轮询）。"""
    controller = get_controller(project, slug)
    state = read_state(project, slug) or {}
    running = controller is not None and controller.ctx.phase not in _TERMINAL

    if controller is not None:
        ctx = controller.ctx
        phase, flags, error, located = ctx.phase, dict(ctx.flags), ctx.error, ctx.located
        with ctx.lock:
            events = list(ctx.events[-400:])
    else:
        phase = state.get("status", "")
        flags = state.get("flags", {})
        error = state.get("error")
        located = state.get("located")
        events = _events_from_disk(project, slug)

    interrupted = controller is None and phase in PHASES[:-1]
    if interrupted and not error:
        error = "上次分析因服务重启而中断，点击「开始分析」可从保存的进度继续"

    return {
        "run_id": slug,
        "project": project,
        "target": state.get("target"),
        "phase": phase,
        "running": running,
        "interrupted": interrupted,
        "cancel_requested": bool(controller and controller.ctx.cancel_event.is_set()),
        "flags": flags,
        "error": error,
        "located": located,
        "events_total": events[-1]["seq"] if events else 0,
        "events": events,
    }


def _events_from_disk(project: str, slug: str, limit: int = 400) -> list:
    return read_event_tail(_workspace_dir(project, slug) / "events.jsonl", limit)


def result_payload(project: str, slug: str, include_markdown: bool = True) -> Dict[str, Any]:
    from .quality import artifact_readable, audit_source, map_legacy_questions
    ws = _workspace_dir(project, slug)
    out_dir = config.PROJECTS_DIR / project / "output" / slug

    def _load(name):
        f = ws / f"{name}.json"
        if not f.exists():
            return None
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            return data if artifact_readable(name, data) else None
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            return None

    md_files = {}
    if include_markdown and out_dir.exists():
        for f in sorted(out_dir.glob("*.md")):
            if f.name.startswith("._"):
                continue  # macOS AppleDouble 垃圾文件
            try:
                md_files[f.name] = f.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass

    state = read_state(project, slug) or {}

    from .teacher import read_review

    review = read_review(project, slug)

    pool_data = _load("question_pool")
    from ..agent.verification import summarize_verification
    context_data = _load("chapter_context")
    plan_data = _load("learning_plan")
    if plan_data:
        for stage in plan_data.get("learning_sequence", []):
            stage["stage"] = int(stage["stage"])
    verification_data = _load("verification")
    qa_data = _load("qa_report")
    missing_artifacts = any(artifact is None for artifact in (context_data, plan_data, pool_data, qa_data, verification_data))
    pool_data = map_legacy_questions(plan_data, pool_data, verification_data) if pool_data else None
    verification_data = summarize_verification(verification_data, pool_data)
    state["quality"] = audit_source(state, context_data, verification_data)
    if state["quality"].get("requiresReview") and state.get("status") == "COMPLETE":
        state["status"] = "NEEDS_REVIEW"
    elif missing_artifacts and state.get("status") == "COMPLETE":
        state["status"] = "INCOMPLETE"
    if (state["quality"].get("requiresReview") or missing_artifacts) and review.get("status") in ("published", "approved"):
        review = dict(review, status="needs_review", block_reasons=[
            "章节成果缺失或损坏" if missing_artifacts else "旧成果需要正文质量复核"])
    current_n = len((pool_data or {}).get("questions", []))

    if state["quality"].get("requiresReview"):
        md_files = {name: "> ⚠️ 此为旧成果，正文来源尚未通过复核，不能作为已完成教学内容。\n\n" + content
                    for name, content in md_files.items()}
    return {
        "run_id": slug,
        "status": state.get("status"),
        "target": state.get("target"),
        "located": state.get("located"),
        "review": review,
        "tasks": review.get("tasks", []),
        # 学情明细只通过带教师鉴权的独立接口返回。
        "learning_reports": [],
        "quality": state.get("quality"),
        "question_counts": {
            # 单一口径：current = question_pool.json 的真实题数（生成/修订/验证修正后的最终态）
            "current": current_n,
            "published": current_n if review.get("status") == "published" else 0,
            "visible_to_student": current_n if review.get("status") == "published" else 0,
        },
        "chapter_context": context_data,
        "learning_plan": plan_data,
        "question_pool": pool_data,
        "qa_report": qa_data,
        "verification": verification_data,
        "markdown": md_files,
        "files": {
            "workspace": [p.name for p in sorted(ws.glob("*")) if p.is_file()] if ws.exists() else [],
            "output": [p.name for p in sorted(out_dir.glob("*")) if p.is_file()] if out_dir.exists() else [],
        },
    }
