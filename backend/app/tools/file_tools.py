"""项目资料工具：list_files —— Agent 了解当前项目有哪些教材。"""
from __future__ import annotations

from typing import Any, Dict

from .base import ToolError
from ..parsers import registry as parser_registry


INPUT_EXTS = {".pdf", ".txt", ".md", ".markdown", ".docx", ".pptx"}


def _input_files(ctx) -> list:
    if not ctx.input_dir.exists():
        return []
    return sorted([p for p in ctx.input_dir.iterdir()
                   if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in INPUT_EXTS
                   and (ctx.allowed_files is None or p.name in ctx.allowed_files)],
                  key=lambda p: p.name)


def list_files(ctx, args: Dict[str, Any]) -> Dict[str, Any]:
    files = []
    for p in _input_files(ctx):
        try:
            doc = parser_registry.get_document(p)
            info = {"file": p.name, "type": doc.kind, "pages": doc.total_pages,
                    "size_bytes": p.stat().st_size}
            preview = doc.pages[0].text[:150].replace("\n", " ") if doc.pages else ""
            info["first_line_preview"] = preview
            files.append(info)
        except Exception as e:  # noqa: BLE001 - 单个文件解析失败不拖垮列表
            files.append({"file": p.name, "type": p.suffix, "error": f"解析失败: {e}"})
    existing_runs = []
    ws = ctx.project_dir / "workspace"
    if ws.exists():
        existing_runs = sorted([d.name for d in ws.iterdir() if d.is_dir()])
    return {"project": ctx.project, "files": files, "analyzed_chapters": existing_runs}


def build_list_files_tool() -> list:
    from .base import Tool

    return [Tool(
        name="list_files",
        description="列出当前学习项目 input/ 目录中的全部教材文件（名称、类型、页数、预览）。"
                    "开始任何工作前必须先调用它了解可用资料。",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        handler=list_files,
    )]
