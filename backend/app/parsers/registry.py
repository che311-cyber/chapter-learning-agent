"""按扩展名分发解析器，并缓存解析结果（以 mtime+size 判断失效）。"""
from __future__ import annotations

import threading
import weakref
from pathlib import Path
from typing import Any, Dict

from .base import ParsedDocument, ParseError
from .text_parser import parse_markdown, parse_text
from .pdf_parser import parse_pdf
from .office_parser import parse_docx, parse_pptx

_cache: Dict[str, tuple] = {}
_ocr_cache: Dict[str, Dict[int, Any]] = {}
_ocr_versions: Dict[str, tuple] = {}
_lock = threading.Lock()
_parse_locks = weakref.WeakValueDictionary()
_MAX_DOCUMENTS = 12


def parse_file(path: Path) -> ParsedDocument:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return parse_pdf(path)
    if ext in (".md", ".markdown"):
        return parse_markdown(path)
    if ext == ".txt":
        return parse_text(path, kind="txt")
    if ext == ".docx":
        return parse_docx(path)
    if ext == ".pptx":
        return parse_pptx(path)
    raise ParseError(f"暂不支持的文件类型: {ext}（支持 pdf/txt/md/docx/pptx）")


def get_document(path: Path) -> ParsedDocument:
    """带缓存的解析：input 文件只读，解析结果按 mtime+size 失效。"""
    key = str(path.resolve())
    with _lock:
        parse_lock = _parse_locks.setdefault(key, threading.Lock())
    # 同一教材的并发上传检查/列表查询只解析一次，不阻塞其他教材及 OCR 缓存。
    with parse_lock:
        stat = path.stat()
        token = (stat.st_mtime_ns, stat.st_size)
        with _lock:
            hit = _cache.get(key)
            if hit and hit[0] == token:
                _cache.pop(key)
                _cache[key] = hit
                return hit[1]
        doc = parse_file(path)
        with _lock:
            _cache[key] = (token, doc)
            while len(_cache) > _MAX_DOCUMENTS:
                oldest = next(iter(_cache))
                _cache.pop(oldest)
        return doc


def get_ocr_cache(file_key: str) -> Dict[int, Any]:
    """按文件缓存的 OCR 页结果（Page 对象），跨多次 read_pages 复用。"""
    try:
        stat = Path(file_key).stat()
        version = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        version = None
    with _lock:
        if _ocr_versions.get(file_key) != version:
            _ocr_cache.pop(file_key, None)
            _ocr_versions[file_key] = version
        return _ocr_cache.setdefault(file_key, {})


def clear_cache() -> None:
    with _lock:
        _cache.clear()
        _ocr_cache.clear()
        _ocr_versions.clear()
