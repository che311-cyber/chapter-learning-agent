"""DOCX / PPTX 解析（成本可控的加分支持）。"""
from __future__ import annotations

from pathlib import Path

from .base import ParsedDocument, Page, ParseError, chunk_text_into_pages, sanitize_extracted_text
from .. import config


def parse_docx(path: Path) -> ParsedDocument:
    try:
        import docx  # python-docx

        d = docx.Document(str(path))
        lines = []
        for para in d.paragraphs:
            t = para.text.strip()
            if not t:
                continue
            style = (para.style.name or "").lower()
            if "heading" in style or "标题" in style:
                level = "".join(ch for ch in style if ch.isdigit())
                prefix = "#" * (int(level) if level.isdigit() else 2)
                lines.append(f"{prefix} {t}")
            else:
                lines.append(t)
        for table in d.tables:  # 表格文本也保留
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells]
                if any(cells):
                    lines.append(" | ".join(cells))
        text = "\n".join(lines)
    except Exception as e:  # noqa: BLE001
        raise ParseError(f"DOCX 解析失败: {type(e).__name__}: {e}") from e
    if not text.strip():
        raise ParseError("DOCX 中没有可提取的文本")
    text = sanitize_extracted_text(text)
    pages = chunk_text_into_pages(text, config.TEXT_PAGE_CHARS)
    return ParsedDocument(name=path.name, kind="docx", pages=pages)


def parse_pptx(path: Path) -> ParsedDocument:
    try:
        from pptx import Presentation

        prs = Presentation(str(path))
        pages = []
        for i, slide in enumerate(prs.slides, start=1):
            lines = []
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        t = "".join(run.text for run in para.runs).strip()
                        if t:
                            lines.append(t)
            if lines:
                pages.append(Page(index=len(pages) + 1, text=sanitize_extracted_text("\n".join(lines))))
    except Exception as e:  # noqa: BLE001
        raise ParseError(f"PPTX 解析失败: {type(e).__name__}: {e}") from e
    if not pages:
        raise ParseError("PPTX 中没有可提取的文本")
    return ParsedDocument(name=path.name, kind="pptx", pages=pages)
