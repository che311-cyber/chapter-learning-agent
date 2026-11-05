"""TXT / Markdown 解析：按编码读取后切成虚拟页。"""
from __future__ import annotations

from pathlib import Path

from .base import ParsedDocument, chunk_text_into_pages, read_text_file
from .. import config


def parse_text(path: Path, kind: str = "txt") -> ParsedDocument:
    text = read_text_file(path)
    pages = chunk_text_into_pages(text, config.TEXT_PAGE_CHARS)
    return ParsedDocument(name=path.name, kind=kind, pages=pages)


def parse_markdown(path: Path) -> ParsedDocument:
    return parse_text(path, kind="md")
