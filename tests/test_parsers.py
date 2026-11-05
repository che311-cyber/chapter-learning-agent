"""解析器测试：TXT/MD 虚拟页、编码回退、空文件、PDF 错误路径。"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.parsers.base import ParseError, chunk_text_into_pages, read_text_file
from app.parsers.registry import clear_cache, get_document, parse_file


def test_chunk_pages_respect_line_boundaries():
    text = "\n".join(f"第{i}行 内容内容内容" for i in range(500))
    pages = chunk_text_into_pages(text, 2200)
    assert len(pages) >= 2
    assert [p.index for p in pages] == list(range(1, len(pages) + 1))
    for p in pages:
        assert "第i行" not in p.text  # 无格式串泄漏


def test_gbk_fallback(tmp_path):
    p = tmp_path / "gbk.txt"
    p.write_bytes("第一章 群\n内容：群是带运算的集合".encode("gb18030"))
    assert "群" in read_text_file(p)


def test_empty_text_file(tmp_path):
    p = tmp_path / "empty.txt"
    p.write_bytes(b"")
    doc = parse_file(p)
    assert doc.total_pages >= 1


def test_markdown_document(tmp_path):
    p = tmp_path / "book.md"
    p.write_text("# 书\n\n# 第一章 A\n\n" + "内容内容内容内容内容\n" * 600 + "\n# 第二章 B\n\n尾", encoding="utf-8")
    clear_cache()
    doc = get_document(p)
    assert doc.kind == "md"
    assert doc.total_pages >= 2


def test_pdf_scanned_error(tmp_path):
    """纯空白 PDF（等价扫描件）必须给出可理解错误，而不是崩溃。"""
    pytest.importorskip("pypdf")
    from pypdf import PdfWriter

    p = tmp_path / "blank.pdf"
    w = PdfWriter()
    w.add_blank_page(width=612, height=792)
    with open(p, "wb") as f:
        w.write(f)
    with pytest.raises(ParseError):
        parse_file(p)


def test_pdf_with_text_via_cupsfilter(tmp_path):
    """macOS 上用 cupsfilter 从文本生成真实 PDF，验证正向解析路径。"""
    import shutil
    import subprocess

    if shutil.which("cupsfilter") is None:
        pytest.skip("cupsfilter 不可用")
    src = tmp_path / "src.txt"
    src.write_text("Chapter 1 Groups\nA group is a set with one binary operation.\n" * 30,
                   encoding="utf-8")
    out = tmp_path / "src.pdf"
    r = subprocess.run(["cupsfilter", str(src)], capture_output=True, timeout=60)
    if r.returncode != 0 or not r.stdout.startswith(b"%PDF"):
        pytest.skip("cupsfilter 生成失败")
    out.write_bytes(r.stdout)
    doc = parse_file(out)
    assert doc.kind == "pdf"
    full = doc.full_text()
    assert "group" in full.lower()
