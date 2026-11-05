"""检索范围限定（allowed_files）测试。"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.agent.context import RunContext
from app.tools.base import ToolError
from app.tools.document_tools import find_section, read_pages
from app.tools.search_tools import search_local
import threading


@pytest.fixture()
def scoped_ctx(ctx_factory):
    ctx = ctx_factory()
    ctx.allowed_files = ["notes.txt"]  # 只允许 notes.txt（不含章节的文件）
    return ctx


def test_find_section_blocked_out_of_scope(scoped_ctx):
    with pytest.raises(ToolError) as ei:
        find_section(scoped_ctx, {"file": "sample.md", "target": "第一章"})
    assert "不在本次分析范围" in str(ei.value)


def test_read_pages_blocked_out_of_scope(scoped_ctx):
    with pytest.raises(ToolError):
        read_pages(scoped_ctx, {"file": "sample.md", "start_page": 1, "end_page": 1})


def test_search_local_scoped(scoped_ctx):
    r = search_local(scoped_ctx, {"query": "群"})
    assert all(h.get("file") == "notes.txt" for h in r["hits"]) or r["hit_count"] == 0


def test_in_scope_still_works(scoped_ctx):
    r = search_local(scoped_ctx, {"query": "无关"})
    assert isinstance(r["hit_count"], int)
