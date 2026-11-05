"""工具层测试：定位、分块阅读与覆盖、搜索、workspace 读写、路径安全。"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.parsers import registry as parser_registry
from app.tools.base import ToolError
from app.tools.document_tools import (find_section, get_document_outline,
                                      read_pages, read_section)
from app.tools.file_tools import list_files
from app.tools.search_tools import search_local
from app.tools.workspace_tools import read_file, write_file


@pytest.fixture(autouse=True)
def _clear_cache():
    parser_registry.clear_cache()
    yield
    parser_registry.clear_cache()


def test_list_files(ctx_factory):
    ctx = ctx_factory()
    r = list_files(ctx, {})
    assert r["project"]
    names = [f["file"] for f in r["files"]]
    assert "sample.md" in names and "notes.txt" in names
    sample = next(f for f in r["files"] if f["file"] == "sample.md")
    assert sample["pages"] >= 2


def test_find_section_first_chapter(ctx_factory):
    ctx = ctx_factory()
    r = find_section(ctx, {"file": "sample.md", "target": "第一章"})
    assert r["found"] and r["best"]["start_page"] >= 1
    assert r["best"]["end_page"] < 3  # 不应包含第二章(P3)


def test_find_section_not_found(ctx_factory):
    ctx = ctx_factory()
    r = find_section(ctx, {"file": "sample.md", "target": "第九章"})
    assert not r["found"]


def test_find_section_requires_target(ctx_factory):
    ctx = ctx_factory()
    with pytest.raises(ToolError):
        find_section(ctx, {"file": "sample.md", "target": ""})


def test_read_pages_chunking_and_full_coverage(ctx_factory):
    """连续用 next_offset 续读后，范围所有页都应计入已完整阅读。"""
    ctx = ctx_factory()
    loc = find_section(ctx, {"file": "sample.md", "target": "第一章"})
    start, end = loc["best"]["start_page"], loc["best"]["end_page"]
    offset = 0
    calls = 0
    while True:
        r = read_pages(ctx, {"file": "sample.md", "start_page": start,
                             "end_page": end, "offset": offset})
        calls += 1
        if not r["has_more"]:
            break
        offset = r["next_offset"]
        assert calls < 50
    cov = ctx.coverage_of("sample.md", start, end)
    assert cov["read"] == cov["total"], cov
    # 全文关键内容确实被读到
    all_text = "".join(read_pages(ctx, {"file": "sample.md", "start_page": start,
                                        "end_page": end, "offset": o})["text"]
                       for o in range(0, cov["total"] * 3000, 6000))
    assert "群的定义" in all_text


def test_read_pages_partial_coverage(ctx_factory):
    ctx = ctx_factory()
    loc = find_section(ctx, {"file": "sample.md", "target": "第一章"})
    start, end = loc["best"]["start_page"], loc["best"]["end_page"]
    r = read_pages(ctx, {"file": "sample.md", "start_page": start, "end_page": end})
    if r["has_more"]:
        cov = ctx.coverage_of("sample.md", start, end)
        assert cov["read"] < cov["total"]


def test_read_pages_invalid_args(ctx_factory):
    ctx = ctx_factory()
    with pytest.raises(ToolError):
        read_pages(ctx, {"file": "sample.md", "start_page": 5, "end_page": 2})
    r = read_pages(ctx, {"file": "sample.md", "start_page": 1, "end_page": 99999})
    assert r["end_page"] <= r["total_pages"]  # 超界页码被钳制到文档末页
    with pytest.raises(ToolError):
        read_pages(ctx, {"file": "../input/sample.md", "start_page": 1, "end_page": 1})


def test_read_section(ctx_factory):
    ctx = ctx_factory()
    r = read_section(ctx, {"file": "sample.md", "section": "1.2 群的定义"})
    assert r["matched_title"].startswith("1.2")
    assert "群公理" in r["text"] or "群" in r["text"]


def test_outline(ctx_factory):
    ctx = ctx_factory()
    r = get_document_outline(ctx, {"file": "sample.md"})
    titles = [h["title"] for h in r["headings"]]
    assert any("第一章" in t for t in titles)
    # 列表项不能混入大纲
    assert not any("封闭性**" in t for t in titles)


def test_search_local_finds_prerequisite(ctx_factory):
    ctx = ctx_factory()
    r = search_local(ctx, {"query": "等价关系"})
    assert r["hit_count"] >= 1
    assert r["hits"][0]["file"] == "sample.md"


def test_workspace_read_write_and_path_safety(ctx_factory):
    ctx = ctx_factory()
    r = write_file(ctx, {"path": "workspace/第一章/draft.json",
                         "content": json.dumps({"ok": True})})
    assert r["saved"].endswith("draft.json")
    r2 = read_file(ctx, {"path": "workspace/第一章/draft.json"})
    assert json.loads(r2["content"]) == {"ok": True}

    # 路径穿越
    for bad in ["../outside.txt", "/etc/passwd", "..\\x", "workspace/../../x.md"]:
        with pytest.raises(ToolError):
            write_file(ctx, {"path": bad, "content": "x"})
        with pytest.raises(ToolError):
            read_file(ctx, {"path": bad})

    # 禁止把教材原文当 read_file 读（必须走 read_pages）
    with pytest.raises(ToolError):
        read_file(ctx, {"path": "input/sample.md"})
    # 禁止写 input/ 与 output/
    with pytest.raises(ToolError):
        write_file(ctx, {"path": "input/evil.md", "content": "x"})
    with pytest.raises(ToolError):
        write_file(ctx, {"path": "output/evil.md", "content": "x"})


def test_input_files_untouched(ctx_factory, project_dir):
    """工具操作后 input 文件内容与 mtime 不变。"""
    ctx = ctx_factory()
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns)
              for p in (project_dir / "input").iterdir()}
    list_files(ctx, {})
    find_section(ctx, {"file": "sample.md", "target": "第一章"})
    read_pages(ctx, {"file": "sample.md", "start_page": 1, "end_page": 3})
    search_local(ctx, {"query": "群"})
    after = {p.name: (p.read_bytes(), p.stat().st_mtime_ns)
             for p in (project_dir / "input").iterdir()}
    assert before == after
