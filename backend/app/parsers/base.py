"""解析器公共模型：所有格式统一解析为 Page 列表（1-based 页码）。

PDF 用真实页码；TXT/MD/DOCX/PPTX 切分为固定字符量的虚拟页，
页码语义对 Agent 透明（工具返回中会说明是 chunk 页）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


class ParseError(Exception):
    """文件解析失败（损坏 / 不支持的排版 / 空文档等）。"""


@dataclass
class Page:
    index: int  # 1-based
    text: str
    ocr_confidence: Optional[float] = None  # OCR 平均置信度（0-100），非 OCR 页为 None
    ocr_failed: bool = False


@dataclass
class ParsedDocument:
    name: str
    kind: str  # pdf / txt / md / docx / pptx
    pages: List[Page] = field(default_factory=list)
    text_density: float = 0.0  # 平均每页字符数；过低疑似扫描版

    @property
    def scan_suspect(self) -> bool:
        return self.kind == "pdf" and self.text_density < 120

    @property
    def total_pages(self) -> int:
        return len(self.pages)

    def page_text(self, index: int) -> str:
        for p in self.pages:
            if p.index == index:
                return p.text
        raise ParseError(f"页码 {index} 不存在（文档共 {self.total_pages} 页）")

    def full_text(self) -> str:
        return "\n\n".join(p.text for p in self.pages)


def chunk_text_into_pages(text: str, page_chars: int) -> List[Page]:
    """把长文本按行边界切成虚拟页，尽量不在段落中间断开。"""
    pages: List[Page] = []
    buf: List[str] = []
    size = 0

    def flush():
        nonlocal buf, size
        if buf:
            pages.append(Page(index=len(pages) + 1, text="\n".join(buf).strip()))
            buf, size = [], 0

    for line in text.splitlines():
        # 单行超长时硬切
        while len(line) > page_chars:
            flush()
            pages.append(Page(index=len(pages) + 1, text=line[:page_chars].strip()))
            line = line[page_chars:]
        buf.append(line)
        size += len(line) + 1
        if size >= page_chars:
            flush()
    flush()
    return [p for p in pages if p.text] or [Page(index=1, text=text.strip() or "（空文档）")]


def read_text_file(path) -> str:
    """按常见编码依次尝试读取文本文件。"""
    from pathlib import Path

    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "big5", "latin-1"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, ValueError):
            continue
    raise ParseError("无法识别文件编码（已尝试 utf-8/gb18030/big5/latin-1）")


def sanitize_extracted_text(text: str) -> str:
    """清洗 PDF/Office 提取文本：清除孤立代理字符与控制字符。

    PDF 解析器（尤其 pdfminer）可能输出 \\udce2 这类孤立代理——
    一旦进入 JSON 落盘（ensure_ascii=False + utf-8 写入）就会抛
    UnicodeEncodeError，导致整个运行崩溃。此处从源头根治。
    """
    text = text.encode("utf-8", "replace").decode("utf-8")
    return "".join(ch for ch in text if ch in ("\n", "\t") or ord(ch) >= 32)


import re as _re

def is_toc_page(text: str) -> bool:
    """检测页面是否为目录页。目录页特征：大量短标题行，无正文段落。"""
    if not text or len(text.strip()) < 30:
        return False
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if len(lines) < 3:
        return False
    toc_indicators = 0
    body_indicators = 0
    for ln in lines:
        if _re.search(r'第?\s*[\d一二三四五六七八九十百]+\s*[章节讲单元篇]', ln):
            toc_indicators += 1
        elif _re.match(r'^\d{1,2}[.、]?\d{0,2}[.、]?\s*\S', ln) and len(ln) < 40:
            toc_indicators += 1
        elif _re.search(r'\.{2,}\s*\d+\s*$', ln):
            toc_indicators += 1
        elif ln in ('习题', '复习题', '小结') or _re.match(r'^习题\s*\d*$', ln):
            toc_indicators += 1
        if len(ln) > 50:
            body_indicators += 1
        if _re.search(r'[。？！]$', ln) and len(ln) > 20:
            body_indicators += 1
        if _re.search(r'[=≤≥∫∑≠±∞]', ln) and len(ln) > 15:
            body_indicators += 1
    return toc_indicators >= 3 and toc_indicators >= body_indicators * 2
