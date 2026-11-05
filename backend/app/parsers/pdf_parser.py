"""PDF 解析：优先 pdfplumber（对中文排版更稳），失败时退回 pypdf。"""
from __future__ import annotations

from pathlib import Path

from .base import ParsedDocument, Page, ParseError, sanitize_extracted_text


def parse_pdf(path: Path) -> ParsedDocument:
    pages: list[Page] = []
    err_primary = ""
    try:
        import pdfplumber

        with pdfplumber.open(str(path)) as pdf:
            for i, page in enumerate(pdf.pages, start=1):
                try:
                    text = page.extract_text() or ""
                    pages.append(Page(index=i, text=sanitize_extracted_text(text)))
                finally:
                    # 数百页教材逐页释放字符/排版缓存，避免保留整本书的渲染对象。
                    page.close()
    except Exception as e:  # noqa: BLE001 - 记录后尝试备用解析器
        err_primary = f"{type(e).__name__}: {e}"
        pages = []

    if not pages or not any(p.text for p in pages):
        pages = _parse_with_pypdf(path)

    if not pages:
        raise ParseError(f"PDF 解析失败（pdfplumber: {err_primary or '无可提取文本'}）；若为扫描件请提供文字版")
    if not any(p.text for p in pages):
        raise ParseError("PDF 中未提取到任何文本：可能是扫描图片版教材，请提供文字版")
    total = sum(len(p.text) for p in pages)
    doc = ParsedDocument(name=path.name, kind="pdf", pages=pages,
                         text_density=total / max(1, len(pages)))
    return doc


def _parse_with_pypdf(path: Path) -> list[Page]:
    try:
        from pypdf import PdfReader

        reader = PdfReader(str(path))
        out = []
        for i, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception:  # noqa: BLE001 - 单页损坏不应拖垮整本
                text = ""
            out.append(Page(index=i, text=sanitize_extracted_text(text)))
        return out
    except Exception as e:  # noqa: BLE001
        raise ParseError(f"pypdf 备用解析也失败: {type(e).__name__}: {e}") from e
