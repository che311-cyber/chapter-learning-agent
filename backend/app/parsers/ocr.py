"""OCR 能力：对文字层稀疏的扫描版 PDF 页面进行光学字符识别。

设计约束：
- 优先复用现有 Page 模型与解析缓存；
- tesseract 不可用时优雅降级（ocr_available=False），不阻塞主流程；
- 每页记录 OCR 置信度（tesseract 的 mean conf）与耗时，供质量字段使用；
- 按"页"惰性 OCR：只对定位命中的页面范围做 OCR，而非整本 528 页。
"""
from __future__ import annotations

import shutil
import json
import os
import subprocess
import tempfile
import threading
import weakref
from functools import lru_cache
from pathlib import Path
from typing import List, Optional

from .base import ParsedDocument, Page, ParseError, is_toc_page


def ocr_available() -> bool:
    """tesseract + pdftoppm（poppler）任一缺失即视为不可用。"""
    return bool(shutil.which("tesseract")) and bool(shutil.which("pdftoppm"))


def _run(cmd: List[str], timeout: int = 120) -> subprocess.CompletedProcess:
    env = None
    if cmd[0] == "tesseract":
        env = dict(os.environ, OMP_THREAD_LIMIT="1")
    return subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)


def ocr_pdf_pages(pdf_path: Path, pages: List[int], lang: str = "chi_sim",
                  dpi: int = 200) -> "ParsedDocument":
    """对指定页做 OCR，返回与原文档同结构的 ParsedDocument。"""
    if not ocr_available():
        raise ParseError("OCR 不可用：服务器未安装 tesseract / poppler-utils")

    out = ParsedDocument(name=pdf_path.name, kind="pdf-ocr", pages=[])
    with tempfile.TemporaryDirectory() as td:
        for pno in pages:
            png_prefix = str(Path(td) / f"p{pno}")
            try:
                r = _run(["pdftoppm", "-f", str(pno), "-l", str(pno), "-r", str(dpi),
                          "-png", "-singlefile", str(pdf_path), png_prefix])
                png = Path(png_prefix + ".png")
                if r.returncode != 0 or not png.exists():
                    out.pages.append(Page(index=pno, text="", ocr_confidence=None, ocr_failed=True))
                    continue

                # 同一次识别生成正文与词置信度，避免每页重复运行识别器。
                recognized = Path(td) / f"p{pno}-recognized"
                r_text = _run(["tesseract", str(png), str(recognized), "-l", lang,
                               "txt", "tsv"], timeout=180)
                text_file = recognized.with_suffix(".txt")
                if r_text.returncode != 0 or not text_file.exists():
                    out.pages.append(Page(index=pno, text="", ocr_confidence=None, ocr_failed=True))
                    continue
                text = text_file.read_text(encoding="utf-8", errors="replace").strip()
                conf = _mean_conf_from_tsv(recognized.with_suffix(".tsv"))

                from .base import sanitize_extracted_text
                out.pages.append(Page(index=pno, text=sanitize_extracted_text(text),
                                      ocr_confidence=conf, ocr_failed=(r_text.returncode != 0)))
            except subprocess.TimeoutExpired:
                out.pages.append(Page(index=pno, text="", ocr_confidence=None, ocr_failed=True))
            except Exception:
                out.pages.append(Page(index=pno, text="", ocr_confidence=None, ocr_failed=True))
    return out


def _mean_conf_from_tsv_stdout(tsv_text: str) -> Optional[float]:
    confs = []
    for line in tsv_text.splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) >= 11:
            try:
                c = float(cols[10])
                if c >= 0:
                    confs.append(c)
            except ValueError:
                continue
    return round(sum(confs) / len(confs), 1) if confs else None

def _mean_conf_from_tsv(tsv_path: Optional[Path]) -> Optional[float]:
    """tesseract tsv 输出的第 11 列为逐词置信度（-1 表示非文本块），取文本词均值。"""
    if not tsv_path or not tsv_path.exists():
        return None
    confs: List[float] = []
    try:
        lines = tsv_path.read_text(encoding="utf-8", errors="replace").splitlines()[1:]
        for line in lines:
            cols = line.split("\t")
            if len(cols) >= 11:
                try:
                    c = float(cols[10])
                    if c >= 0:
                        confs.append(c)
                except ValueError:
                    continue
    except OSError:
        return None
    return round(sum(confs) / len(confs), 1) if confs else None


import hashlib as _hl
import re as _re


def _file_hash(path: Path) -> str:
    """完整正文指纹按文件版本复用，防止同大小、同前缀教材串用 OCR。"""
    path = path.resolve()
    stat = path.stat()
    return _hash_version(str(path), stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=64)
def _hash_version(path: str, mtime_ns: int, size: int) -> str:
    digest = _hl.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()[:16]


_CACHE_LOCK = threading.Lock()
_CACHE_LOCKS = weakref.WeakValueDictionary()


class OcrPageCache:
    """持久化 OCR 页缓存：按文件哈希+页码+DPI+语言为键，JSON 文件存储。"""

    def __init__(self, cache_dir: Path, file_hash: str):
        self.cache_dir = cache_dir
        self.file_hash = file_hash
        self.cache_file = cache_dir / f"ocr_{file_hash}.json"
        with _CACHE_LOCK:
            self._lock = _CACHE_LOCKS.setdefault(str(self.cache_file.resolve()), threading.RLock())
        self._data: Dict[str, Any] = {}
        self._load()

    def _load(self):
        if self.cache_file.exists():
            try:
                data = json.loads(self.cache_file.read_text(encoding="utf-8"))
                self._data = data if isinstance(data, dict) else {}
            except Exception:
                self._data = {}

    def _save(self):
        from ..agent.context import atomic_write_json
        atomic_write_json(self.cache_file, self._data)

    def get(self, page: int, dpi: int, lang: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            self._load()
            item = self._data.get(f"{page}_{dpi}_{lang}")
            return item if isinstance(item, dict) else None

    def put(self, page: int, dpi: int, lang: str, text: str, confidence: Optional[float]):
        with self._lock:
            self._load()
            self._data[f"{page}_{dpi}_{lang}"] = {"text": text, "confidence": confidence}
            self._save()

    @property
    def size(self):
        return len(self._data)


def ocr_page_with_cache(pdf_path: Path, page: int, cache: OcrPageCache,
                        lang: str = "chi_sim+eng", dpi: int = 300) -> Dict[str, Any]:
    """OCR 单页（带缓存），返回 {text, confidence, failed}。"""
    cached = cache.get(page, dpi, lang)
    if cached:
        return {**cached, "cached": True}
    result = ocr_pdf_pages(pdf_path, [page], lang=lang, dpi=dpi)
    p = result.pages[0] if result.pages else None
    if p is None:
        return {"text": "", "confidence": None, "failed": True, "cached": False}
    entry = {"text": p.text, "confidence": p.ocr_confidence, "failed": p.ocr_failed}
    cache.put(page, dpi, lang, p.text, p.ocr_confidence)
    return {**entry, "cached": False}


def extract_chapter_titles_from_toc(toc_texts: List[str]) -> List[Dict[str, Any]]:
    """从目录页文本列表中提取章节标题列表。

    返回 [{title, matched_text}]。不依赖页码（pdfplumber 可能丢失页码）。
    """
    chapters = []
    seen = set()
    for text in toc_texts:
        for ln in text.splitlines():
            ln = ln.strip()
            m = _re.match(r"^(第\s*[\d一二三四五六七八九十百]+\s*章)\s*(.{0,50})", ln)
            if m:
                label = _re.sub(r"\s+", " ", m.group(1))
                title = m.group(2).strip()
                key = label
                if key not in seen:
                    seen.add(key)
                    chapters.append({"label": label, "title": title, "matched": ln[:60]})
    return chapters


def body_signal_score(text: str) -> int:
    """计算页面正文信号得分（0-100）。高分 = 更可能是正文页。

    正文信号：长句、公式、定义标记、定理标记、例题标记。
    目录信号：短行、章节标题、无标点。
    """
    if not text or len(text.strip()) < 30:
        return 0
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    score = 0
    for ln in lines:
        # 正文信号（正向）
        if len(ln) > 40:
            score += 5
        if _re.search(r"[。？！]$", ln) and len(ln) > 15:
            score += 5
        if _re.search(r"[=≤≥∫∑≠±∞]", ln) and len(ln) > 10:
            score += 3
        if _re.search(r"定义|定理|推论|引理|证明|解|例\s*\d", ln):
            score += 4
        if _re.search(r"因为|所以|由于|因此|即|也就是|由此可得", ln):
            score += 3
    # 目录信号（负向）
    for ln in lines:
        if len(ln) < 15 and not _re.search(r"[。，？！；：]", ln):
            score -= 2
        if _re.match(r"^\d{1,2}[.、]?\d{0,2}\s*\S{1,20}$", ln):
            score -= 1
    return max(0, min(100, score))


def find_chapter_start_batch(pdf_path: Path, target_label: str,
                             cache: OcrPageCache,
                             search_start: int = 1, search_end: int = 520,
                             batch_size: int = 5, max_batches: int = 20) -> Optional[Dict[str, Any]]:
    """在 PDF 中批量 OCR 搜索目标章节标题。

    从 search_start 开始，每次 OCR batch_size 页，检查是否包含 target_label。
    找到后返回 {start_page, text, confidence}。
    """
    label_norm = _re.sub(r"\s+", "", target_label)
    page = search_start
    for batch_i in range(max_batches):
        pages_to_try = list(range(page, min(page + batch_size, search_end + 1)))
        for pno in pages_to_try:
            r = ocr_page_with_cache(pdf_path, pno, cache)
            text = r.get("text", "")
            if not text or len(text) < 20:
                continue
            text_norm = _re.sub(r"\s+", "", text)
            if label_norm in text_norm:
                score = body_signal_score(text)
                return {"start_page": pno, "text": text[:500],
                        "confidence": r.get("confidence"), "body_score": score}
        page += batch_size
        if page > search_end:
            break
    return None


def _fuzzy_contains(text: str, target: str, threshold: float = 0.5) -> bool:
    """模糊匹配：text 是否包含 target 的近似形式（容忍 OCR 误差）。"""
    tn = _re.sub(r"\s+", "", text)
    tg = _re.sub(r"\s+", "", target)
    if not tg:
        return False
    if tg in tn:
        return True
    from .headings import cn_num_to_int
    wanted = _re.fullmatch(r"第([\d一二三四五六七八九十百]+)章", tg)
    if wanted:
        number = cn_num_to_int(wanted.group(1))
        return any(cn_num_to_int(m.group(1)) == number
                   for m in _re.finditer(r"第([\d一二三四五六七八九十百]+)章", tn))
    return False


def _title_on_page(text: str, label: str, title: str = "") -> bool:
    from .headings import normalize_label
    for line in text.splitlines():
        line = line.strip()
        line = _re.sub(r'[，,:：·“”"‘’]', '', line)
        if not line or len(line) > 80 or _re.search(r"[。；？！]", line):
            continue
        if title and normalize_label(line) == normalize_label(title):
            return True
        if normalize_label(line) == normalize_label(label + title):
            return True
        # 用户常只输入章名，扫描页上的实际标题仍可能带“第十章”编号。
        without_number = _re.sub(r"^(?:第\s*[\d一二三四五六七八九十百]+\s*(?:章|节)|chapter\s+\d+)\s*", "", line, flags=_re.I)
        if without_number != line and normalize_label(without_number) == normalize_label(label + title):
            return True
        if _re.fullmatch(r"第[\d一二三四五六七八九十百]+章", _re.sub(r"\s+", "", label)):
            if _re.match(r"^第\s*[\d一二三四五六七八九十百]+\s*章", line) and _fuzzy_contains(line, label):
                return not title or _fuzzy_contains(line, title)
    return False


import re as _re2


def is_content_usable(text: str, min_chars: int = 30) -> bool:
    """判断 OCR 文本是否为可用的正文内容（不是乱码、页眉、页脚）。
    条件：字符数 >= min_chars，中文占比 >= 15%，乱码行 < 40%，至少1个可读句子。
    """
    if not text or len(text.strip()) < min_chars:
        return False
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if len(lines) < 2:
        return False
    total_chars = sum(len(ln) for ln in lines)
    if total_chars < min_chars:
        return False
    cn_chars = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    cn_ratio = cn_chars / max(1, total_chars)
    if cn_ratio < 0.15:
        return False
    junk_lines = sum(1 for ln in lines
                     if len(ln) > 5 and
                     len([c for c in ln if "\u4e00" <= c <= "\u9fff" or c.isalpha() or c.isdigit()
                          or c in '.;,!?，。；：！？、=≤≥∫∑∞()[]{}/_+']) < len(ln) * 0.3)
    if junk_lines > max(1, len(lines) * 0.4):
        return False
    sentences = sum(1 for ln in lines if _re2.search(r'[。？！；：]$', ln) and len(ln) > 10)
    return sentences >= 1


def find_chapter_start_backward(pdf_path: Path, forward_match_page: int,
                                target_label: str, target_title: str,
                                cache: "OcrPageCache",
                                search_lo: int = 1,
                                dpi: int = 150,
                                lang: str = "chi_sim+eng") -> Optional[int]:
    """从命中页向前回溯，找到章节真正的起始页（非页眉重复）。"""
    if forward_match_page <= search_lo:
        return search_lo
    target_norm = _re2.sub(r"\s+", "", target_label)
    boundary_page = search_lo
    step = max(5, (forward_match_page - search_lo) // 18)
    # Phase A：向前采样找前一章边界
    for pno in range(forward_match_page - step, search_lo - 1, -step):
        r = ocr_page_with_cache(pdf_path, pno, cache, lang=lang, dpi=dpi)
        txt = r.get("text", "")
        if not txt:
            continue
        txt_norm = _re2.sub(r"\s+", "", txt)
        if target_norm not in txt_norm:
            boundary_page = pno
            break
    # Phase B：逐页回溯，找真正的章标题页
    search_start = max(search_lo, boundary_page - step)
    search_end = min(forward_match_page, boundary_page + step * 2)
    for pno in range(search_start, search_end + 1):
        r = ocr_page_with_cache(pdf_path, pno, cache, lang=lang, dpi=dpi)
        txt = r.get("text", "")
        if not txt or len(txt.strip()) < 20:
            continue
        txt_norm = _re2.sub(r"\s+", "", txt)
        if not _title_on_page(txt, target_label, target_title):
            continue
        # 判断是章起始页还是页眉重复：有章节标题结构（第X节/10.X）或引言
        has_structure = bool(
            _re2.search(r"第.{0,2}[一二三四五六七八九十百\d]+[节\.]", txt) or
            _re2.search(r"^10\.\d", txt, _re2.MULTILINE) or
            (_re2.search(r"[习题]\s*\d", txt) and len(txt) > 200)
        )
        if has_structure and is_content_usable(txt):
            return pno
        # 即使没有明显结构，只要含目标词且是可用正文，也接受（但阈值更高）
        if _fuzzy_contains(txt, target_label) and is_content_usable(txt) and len(txt) > 100:
            return pno
    return None


def content_bounds(total_pages: int, toc_pages: List[int]) -> tuple:
    """支持目录位于书首、书尾或两端；不把末尾目录当正文。"""
    front = [p for p in toc_pages if p <= total_pages / 3]
    rear = [p for p in toc_pages if p > total_pages * 2 / 3]
    start = max(front) + 1 if front else 1
    end = min(rear) - 1 if rear else total_pages
    return start, end


def detect_chapter_end(pdf_path: Path, chapter_start: int, cache: "OcrPageCache",
                       content_end: int, max_pages: int = 60,
                       dpi: int = 150, lang: str = "chi_sim+eng", cancel_event=None) -> int:
    """从起始页向后读取，检测章节结束页（出现下一章标题/目录页/文件结束）。"""
    start_text = ocr_page_with_cache(pdf_path, chapter_start, cache, lang=lang, dpi=dpi).get("text", "")
    m = _re2.search(r"第\s*([一二三四五六七八九十百\d]+)\s*章", start_text)
    chapter_num_str = m.group(1) if m else None
    from .headings import cn_num_to_int
    chapter_num = cn_num_to_int(chapter_num_str) if chapter_num_str else None
    def boundary(pno):
        if cancel_event is not None and cancel_event.is_set():
            from ..agent.loop import RunCancelled
            raise RunCancelled()
        r = ocr_page_with_cache(pdf_path, pno, cache, lang=lang, dpi=dpi)
        txt = r.get("text", "")
        if not txt:
            return False
        head_text = "\n".join(txt.splitlines()[:max(1, len(txt.splitlines()) // 3)])
        if is_toc_page(txt):
            return True
        # 只认独立章标题行，正文引用“下一章”不能截断本章。
        for line in head_text.splitlines():
            h = _re2.match(r"^第\s*([一二三四五六七八九十百\d]+)\s*章", line.strip())
            if h and len(line) < 80 and not _re2.search(r"[。；？！]", line) and chapter_num is not None and cn_num_to_int(h.group(1)) != chapter_num:
                return True
        return False
    limit = min(content_end, chapter_start + max_pages - 1)
    if chapter_num is not None:
        previous = chapter_start
        for sample in list(range(chapter_start + 8, limit + 1, 8)) + [limit]:
            if boundary(sample):
                for pno in range(previous + 1, sample + 1):
                    if boundary(pno):
                        return pno - 1
            previous = sample
    # 没有重复页眉的教材仍需顺序检查，不能因采样未命中而漏掉下一章。
    for pno in range(chapter_start + 1, limit + 1):
        if boundary(pno):
            return pno - 1
    # 达到搜索上限时仅返回已核验范围，不能冒称读到文件末尾。
    return min(content_end, chapter_start + max_pages - 1)


def locate_chapter_body_by_scan(
    pdf_path: Path,
    target_label: str,
    target_title: str,
    cache: "OcrPageCache",
    content_start: int = 1,
    content_end: int = 520,
    dpi: int = 300,
    lang: str = "chi_sim+eng",
    cancel_event=None,
    read_body: bool = True,
) -> Optional[Dict[str, Any]]:
    """确定性 OCR 正文定位：采样→回溯找章标题→顺序读取→计算真实覆盖率。"""
    if not ocr_available():
        return None
    if content_start > content_end:
        return None
    def check_cancel():
        if cancel_event is not None and cancel_event.is_set():
            from ..agent.loop import RunCancelled
            raise RunCancelled()
    target_norm = _re2.sub(r"\s+", "", target_label)

    # Phase 1: 采样
    content_range = content_end - content_start + 1
    sample_step = max(1, content_range // 24)
    samples = list(range(content_start, content_end + 1, sample_step))
    if samples[-1] < content_end:
        samples.append(content_end)
    forward_match_page = None
    # 粗采样可能错过没有重复页眉的章节；未命中时检查采样间隙。
    known = sorted({int(key.split('_')[0]) for key, value in getattr(cache, '_data', {}).items()
                    if content_start <= int(key.split('_')[0]) <= content_end
                    and _title_on_page(value.get('text', ''), target_label, target_title)
                    and not is_toc_page(value.get('text', ''))})
    search_order = known + [p for p in samples if p not in known] + [p for p in range(content_start, content_end + 1) if p not in samples and p not in known]
    for pno in search_order:
        check_cancel()
        r = ocr_page_with_cache(pdf_path, pno, cache, lang=lang, dpi=150)
        txt = r.get("text", "")
        if not is_toc_page(txt) and _title_on_page(txt, target_label, target_title):
            forward_match_page = pno
            break
    if forward_match_page is None:
        return None

    # Phase 2: 回溯找章起始页
    match_text = ocr_page_with_cache(pdf_path, forward_match_page, cache, lang=lang, dpi=150).get('text', '')
    lines = [line.strip() for line in match_text.splitlines() if line.strip()]
    opening = any(_re2.fullmatch(r'第\s*[\d一二三四五六七八九十百]+\s*章', line)
                  and i + 1 < len(lines) and _title_on_page(lines[i + 1], target_label, target_title)
                  for i, line in enumerate(lines[:5]))
    chapter_start = forward_match_page if opening else find_chapter_start_backward(
        pdf_path, forward_match_page, target_label, target_title,
        cache, search_lo=content_start, dpi=150, lang=lang)
    if chapter_start is None:
        chapter_start = forward_match_page

    # Phase 3: 检测章节结束
    chapter_end = detect_chapter_end(pdf_path, chapter_start, cache, content_end,
                                     max_pages=content_end - chapter_start + 1, dpi=150, lang=lang,
                                     cancel_event=cancel_event)
    chapter_total = chapter_end - chapter_start + 1

    # Phase 4: 顺序读取 + 质量判断
    body_pages = []
    pages_ocr_attempted = 0
    pages_ocr_succeeded = 0
    pages_usable = 0
    confs = []
    for pno in range(chapter_start, chapter_end + 1 if read_body else chapter_start + 1):
        check_cancel()
        pages_ocr_attempted += 1
        r_q = ocr_page_with_cache(pdf_path, pno, cache, lang=lang, dpi=150)
        txt_q = r_q.get("text", "")
        if is_toc_page(txt_q) and pno > chapter_start:
            break
        r = ocr_page_with_cache(pdf_path, pno, cache, lang=lang, dpi=300)
        txt = r.get("text", "")
        conf = r.get("confidence")
        if conf is not None:
            confs.append(conf)
        if len(txt.strip()) < 20:
            continue
        pages_ocr_succeeded += 1
        usable = is_content_usable(txt)
        body_pages.append({
            "page": pno, "text": txt, "confidence": conf,
            "usable": usable, "chars": len(txt), "toc": is_toc_page(txt),
        })
        if usable:
            pages_usable += 1
    if not body_pages:
        return None

    body_content_coverage = round(pages_usable / max(1, chapter_total), 2)
    ocr_conf = round(sum(confs) / len(confs), 1) if confs else None

    # 内容状态判定
    if body_content_coverage < 0.30:
        content_status, source_scope = "PARTIAL_CONTENT", "PARTIAL_BODY"
    elif body_content_coverage < 0.80:
        content_status, source_scope = "PARTIAL_CONTENT", "PARTIAL_BODY"
    else:
        content_status = "CONTENT_READY" if (ocr_conf is None or ocr_conf >= 60) else "PARTIAL_CONTENT"
        source_scope = "FULL_BODY"
    location_state = "OCR_VERIFIED" if body_content_coverage >= 0.80 and (ocr_conf is None or ocr_conf >= 60) else (
        "BODY_READ" if body_content_coverage >= 0.30 else "READING_LIMITED")

    return {
        "chapterStartPage": chapter_start, "chapterEndPage": chapter_end,
        "chapterTotalPages": chapter_total,
        "startPage": body_pages[0]["page"] if body_pages else chapter_start,
        "endPage": body_pages[-1]["page"] if body_pages else chapter_start,
        "bodyPages": body_pages,
        "pagesRead": pages_ocr_succeeded,
        "pagesUsable": pages_usable,
        "pagesOcrAttempted": pages_ocr_attempted,
        "pagesOcrSucceeded": pages_ocr_succeeded,
        "ocrConfidence": ocr_conf,
        "bodyContentCoverage": body_content_coverage,
        "readableCoverage": body_content_coverage,
        "locationState": location_state,
        "sourceScope": source_scope,
        "contentStatus": content_status,
        "locationConfidence": "high" if location_state == "OCR_VERIFIED" else "medium",
    }
