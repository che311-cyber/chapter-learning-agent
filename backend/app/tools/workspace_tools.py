"""workspace 读写工具：Agent 可读取自己产生的文件、写入工作区草稿。

安全约束：
- read_file：仅允许 workspace/ 与 output/ 下的文件（教材原文必须走 read_pages/read_section，
  以保证覆盖统计与页码语义一致）。
- write_file：仅允许写入 workspace/ 子树；禁止触碰 input/（用户原始资料只读）。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from .base import Tool, ToolError

MAX_WRITE_BYTES = 512 * 1024


def _safe_resolve(base: Path, rel: str) -> Path:
    if not isinstance(rel, str) or not rel or rel.startswith(("/", "~")) or ".." in Path(rel).parts or ":" in rel or "\\" in rel:
        raise ToolError(f"非法路径: {rel!r}（必须是不带 .. 的项目内相对路径）")
    p = (base / rel).resolve()
    if not p.is_relative_to(base.resolve()):
        raise ToolError(f"路径越界: {rel!r}")
    return p


def read_file(ctx, args: Dict[str, Any]) -> Any:
    rel = args.get("path", "")
    p = _safe_resolve(ctx.project_dir, rel)
    if not p.is_file():
        raise ToolError(f"文件不存在: {rel}")
    inside_ws = p.is_relative_to(ctx.workspace_dir.resolve())
    inside_out = p.is_relative_to(ctx.output_dir.resolve())
    if not (inside_ws or inside_out):
        raise ToolError("read_file 只能读取当前章节 workspace/ 或 output/ 下的文件；"
                        "教材原文请使用 read_pages / read_section（保证阅读完整性统计）")
    if "learning_reports" in p.relative_to(ctx.project_dir.resolve()).parts:
        raise ToolError("学生学情报告只能通过教师鉴权接口读取，不能发送给分析模型")
    if p.suffix.lower() == ".pdf":
        raise ToolError("read_file 不支持 PDF，请用 read_pages")
    if p.stat().st_size > 8 * 1024 * 1024:
        raise ToolError("文件超过 8MB 文本读取上限，请读取结构化产物，不要加载完整会话历史")
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise ToolError(f"文件不是 UTF-8 文本: {rel}")
    from .. import config
    try:
        offset = int(args.get("offset", 0))
    except (ValueError, TypeError):
        raise ToolError("offset 必须是非负整数")
    if offset < 0:
        raise ToolError("offset 必须是非负整数")
    chunk_size = max(1, min(12000, (config.TOOL_RESULT_MAX_CHARS - 500) // 2))
    chunk = text[offset:offset + chunk_size]
    next_offset = offset + len(chunk)
    has_more = next_offset < len(text)
    return {"path": rel, "chars": len(chunk), "total_chars": len(text), "offset": offset,
            "content": chunk, "has_more": has_more, "next_offset": next_offset if has_more else None}


def write_file(ctx, args: Dict[str, Any]) -> Any:
    rel = args.get("path", "")
    content = args.get("content", "")
    if not isinstance(content, str):
        raise ToolError("content 必须是字符串")
    p = _safe_resolve(ctx.project_dir, rel)
    ws_root = ctx.workspace_dir.resolve()
    if not p.is_relative_to(ws_root):
        raise ToolError("write_file 只能写入 workspace/ 子树（input/ 用户资料禁止修改，output/ 由系统生成）")
    if p.name in {"state.json", "messages.json", "events.jsonl", "review.json", "chapter_context.json",
                   "learning_plan.json", "question_pool.json", "qa_report.json", "verification.json"} or "learning_reports" in p.parts:
        raise ToolError("系统产物必须通过当前阶段的 submit 工具提交，不能直接覆盖")
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ToolError(f"内容超过 {MAX_WRITE_BYTES // 1024}KB 上限，请精简或分文件")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return {"saved": rel, "bytes": len(content.encode("utf-8"))}


def build_workspace_tools() -> list:
    return [
        Tool(name="read_file",
             description="读取项目内 Agent 自己产生的文件（workspace/ 或 output/ 下的 json/md）。"
                         "has_more=true 时须用 next_offset 续读全部内容。教材原文必须用 read_pages / read_section。",
             parameters={"type": "object",
                         "properties": {"path": {"type": "string", "description": "相对项目根目录的路径，如 workspace/第一章/chapter_context.json"},
                                        "offset": {"type": "integer", "description": "续读游标，首次0，后续用 next_offset"}},
                         "required": ["path"], "additionalProperties": False},
             handler=read_file),
        Tool(name="write_file",
             description="把草稿/中间结果写入 workspace/（禁止写 input/ 与 output/）。",
             parameters={"type": "object",
                         "properties": {"path": {"type": "string"},
                                        "content": {"type": "string"}},
                         "required": ["path", "content"], "additionalProperties": False},
             handler=write_file),
    ]
