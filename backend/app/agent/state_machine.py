"""固定状态机：TARGET → LOCATE → READ → UNDERSTAND → DESIGN → GENERATE
→ PSYCHOLOGY_CHECK → VERIFY → SAVE → COMPLETE。

state.json 持久化：程序/ API 中途退出后可以续跑，不必从头开始。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from .context import RunContext, atomic_write_json

PHASES: List[str] = ["TARGET", "LOCATE", "READ", "UNDERSTAND", "DESIGN",
                     "GENERATE", "PSYCHOLOGY_CHECK", "VERIFY", "SAVE", "COMPLETE"]

# 每个阶段需要的 LLM 轮次（TARGET/SAVE 无需 LLM）
LLM_PHASES = set(PHASES) - {"TARGET", "SAVE", "COMPLETE"}

TERMINAL_OK = "COMPLETE"
TERMINAL_FAIL = "FAILED"
TERMINAL_CANCELLED = "CANCELLED"

PHASE_LABELS_ZH = {
    "TARGET": "解析目标",
    "LOCATE": "定位章节",
    "READ": "完整阅读章节",
    "UNDERSTAND": "生成章节理解",
    "DESIGN": "设计学习方案",
    "GENERATE": "生成练习",
    "PSYCHOLOGY_CHECK": "7条心理学原则检查",
    "VERIFY": "独立验证",
    "SAVE": "保存结果",
    "COMPLETE": "完成",
    "FAILED": "失败",
    "CANCELLED": "已取消",
}


def phase_index(status: str) -> int:
    try:
        return PHASES.index(status)
    except ValueError:
        return -1


def build_state(ctx: RunContext) -> Dict[str, Any]:
    return {
        "target": ctx.target,
        "slug": ctx.slug,
        "project": ctx.project,
        "model": getattr(ctx, "model", None),
        "status": ctx.phase,
        "flags": dict(ctx.flags),
        "located": ctx.located,
        "quality": ctx.artifacts.get("quality"),
        "allowed_files": list(ctx.allowed_files) if ctx.allowed_files else None,
        "source_versions": getattr(ctx, "source_versions", None),
        "coverage": ctx.coverage,
        "read_fragments": ctx.read_fragments,
        "resume_phase": getattr(ctx, "resume_phase", None),
        "error": ctx.error,
        "updated_at": time.time(),
    }


def save_state(ctx: RunContext) -> None:
    ctx.workspace_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(ctx.workspace_dir / "state.json", build_state(ctx))


def load_state(ctx: RunContext) -> Optional[Dict[str, Any]]:
    f = ctx.workspace_dir / "state.json"
    if not f.exists():
        return None
    import json

    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        return None


def set_phase(ctx: RunContext, phase: str) -> None:
    ctx.phase = phase
    ctx.emit(f"进入阶段：{phase} —— {PHASE_LABELS_ZH.get(phase, '')}", level="info",
             data={"phase": phase}, phase=phase)
    save_state(ctx)
