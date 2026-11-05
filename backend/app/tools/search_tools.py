"""search_local：在项目全部资料中检索关键词（用于 Minimal Backtracking）。"""
from __future__ import annotations

from typing import Any, Dict, List

from .base import Tool, ToolError
from ..parsers import registry as parser_registry
from ..parsers.headings import normalize_label


def search_local(ctx, args: Dict[str, Any]) -> Dict[str, Any]:
    query = (args.get("query") or "").strip()
    if not query:
        raise ToolError("缺少参数 query")
    scope = (args.get("file") or "").strip() or None
    max_hits = 20

    allowed = getattr(ctx, "allowed_files", None)
    if ctx.input_dir.exists():
        files = sorted([p for p in ctx.input_dir.iterdir()
                        if p.is_file() and (scope is None or p.name == scope)
                        and (allowed is None or p.name in allowed)])
    else:
        files = []
    if scope and not files:
        raise ToolError(f"文件不存在: {scope}")

    terms = [normalize_label(q) for q in query.split() if q.strip()] or [normalize_label(query)]
    hits: List[Dict[str, Any]] = []
    for path in files:
        try:
            doc = parser_registry.get_document(path)
        except Exception as e:  # noqa: BLE001
            hits.append({"file": path.name, "error": str(e)})
            continue
        for page in doc.pages:
            lines = page.text.splitlines()
            for ln, line in enumerate(lines):
                nl = normalize_label(line)
                if all(t in nl for t in terms):
                    lo = max(0, ln - 1)
                    hi = min(len(lines), ln + 2)
                    hits.append({
                        "file": path.name, "page": page.index,
                        "snippet": "\n".join(x.strip() for x in lines[lo:hi])[:300],
                    })
                    if len(hits) >= max_hits:
                        break
            if len(hits) >= max_hits:
                break
        if len(hits) >= max_hits:
            break

    return {
        "query": query, "hits": hits, "hit_count": len(hits),
        "note": "只返回必要的前置知识检索结果。请只读取理解当前章节所需的最小范围，不要回溯整本书。",
    }


def build_search_tool() -> list:
    return [Tool(
        name="search_local",
        description="在项目全部教材资料中搜索关键词（如当前章节依赖但未定义的前置概念：'等价关系'）。"
                    "仅用于最小必要回溯：只检索、只读取解决当前理解所需的最小范围，禁止借此扫描整本书。",
        parameters={"type": "object",
                    "properties": {"query": {"type": "string"},
                                   "file": {"type": "string", "description": "可选，限定在某个文件内搜索"}},
                    "required": ["query"], "additionalProperties": False},
        handler=search_local,
    )]
