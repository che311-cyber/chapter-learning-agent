"""文档定位/阅读工具：get_document_outline / find_section / read_pages / read_section。

设计要点：
- 页码是工具体系的通用坐标（PDF 真实页；TXT/MD 为 ~2200 字符的虚拟页，返回值会说明）。
- read_pages 用 offset 游标分块返回，直到 has_more=false 才算读完；
  仅当一页文本完整返回时才计入"已完整阅读"，供 READ 阶段完整性校验。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .base import ToolError
from .. import config
from ..parsers import registry as parser_registry
from ..parsers import ocr as ocr_mod
from ..parsers.base import Page, is_toc_page
from ..parsers.headings import (extract_headings, match_score, parse_target,
                                section_range, normalize_label, cn_num_to_int, Heading, detect_heading)


def _load_doc(ctx, file: str):
    if not file or "/" in file or "\\" in file or ".." in file:
        raise ToolError(f"非法文件名: {file!r}")
    allowed = getattr(ctx, "allowed_files", None)
    if allowed and file not in allowed:
        raise ToolError(f"文件 {file} 不在本次分析范围（用户指定的检索范围: {allowed}）。请只在指定文件中定位与阅读。")
    path = ctx.input_dir / file
    if not path.is_file():
        avail = [p.name for p in sorted(ctx.input_dir.glob("*")) if p.is_file()] if ctx.input_dir.exists() else []
        raise ToolError(f"文件不存在: {file}。可用文件: {avail}")
    try:
        return parser_registry.get_document(path)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"解析 {file} 失败: {e}")


def _virtual_note(doc) -> str:
    return "（注意：该文件为文本类资料，'页'为约 %d 字符的虚拟分块，非纸质页码）" % config.TEXT_PAGE_CHARS \
        if doc.kind in ("txt", "md") else ""


def _page_cache(ctx, file):
    """同项目同版本教材共享 OCR，旧缓存按文件指纹迁入。"""
    path = ctx.input_dir / file
    cache = ocr_mod.OcrPageCache(ctx.project_dir / "workspace" / "_ocr", ocr_mod._file_hash(path))
    for previous in (ctx.project_dir / "workspace").glob(f"*/{cache.cache_file.name}"):
        if previous == cache.cache_file:
            continue
        import json
        try:
            for key, value in json.loads(previous.read_text(encoding="utf-8")).items():
                cache._data.setdefault(key, value)
        except (ValueError, OSError):
            continue
    return cache


def _bookmark_range(path, target, total_pages):
    """PDF 书签提供真实物理页码；仍需在命中页核验正文标题。"""
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        headings = []
        def walk(items, depth=1):
            for item in items:
                if isinstance(item, list):
                    walk(item, depth + 1)
                    continue
                page = reader.get_destination_page_number(item) + 1
                title = str(item.get('/Title', ''))
                if not (1 <= page <= total_pages):
                    continue
                h = detect_heading(title) or Heading(page, 0, title, depth, None, None, 'bookmark')
                h.page, h.level = page, depth
                headings.append(h)
        walk(reader.outline)
        target_parts = parse_target(target)
        ranked = [(match_score(h, *target_parts), i, h) for i, h in enumerate(headings)]
        ranked = [r for r in ranked if r[0] >= 55]
        ranked.sort(key=lambda r: (-r[0], r[2].kind != 'chapter', r[2].page))
        if ranked:
            score, index, heading = ranked[0]
            start, end = section_range(headings, index, total_pages)
            return {'start_page': start, 'end_page': end, 'title': heading.text, 'score': score}
    except Exception:
        return None
    return None


# ---------------------------------------------------------------- outline
def get_document_outline(ctx, args: Dict[str, Any]) -> Dict[str, Any]:
    doc = _load_doc(ctx, args.get("file", ""))
    heads = extract_headings(doc)
    items = [{"page": h.page, "level": h.level, "kind": h.kind, "title": h.text}
             for h in heads[:200]]
    return {
        "file": doc.name, "type": doc.kind, "total_pages": doc.total_pages,
        "note": _virtual_note(doc),
        "headings": items,
        "hint": "headings 为空说明未检测到明显标题结构，可用 find_section 的文本搜索兜底。",
    }


# ---------------------------------------------------------------- find_section
def find_section(ctx, args: Dict[str, Any]) -> Dict[str, Any]:
    file = args.get("file", "")
    target = (args.get("target") or "").strip()
    if not target:
        raise ToolError("缺少参数 target（例如 '第一章' / '8.3 一致收敛'）")
    doc = _load_doc(ctx, file)
    evidence_cache = getattr(ctx, "_location_evidence", {})
    cache_key = (file, normalize_label(target))
    if cache_key in evidence_cache:
        return evidence_cache[cache_key]
    heads = extract_headings(doc)
    t_norm, t_num, t_dotted = parse_target(target)

    scored: List[tuple] = []
    for i, h in enumerate(heads):
        s = match_score(h, t_norm, t_num, t_dotted)
        if s >= 55:
            start, end = section_range(heads, i, doc.total_pages)
            scored.append((s, i, h, start, end))
    scored.sort(key=lambda x: (-x[0], x[2].page))
    # 相同标题常同时出现在目录与正文中；正文证据优先。
    scored.sort(key=lambda x: is_toc_page(doc.page_text(x[3])))

    def cand(s, h, start, end):
        return {"score": s, "title": h.text, "kind": h.kind, "level": h.level,
                "start_page": start, "end_page": end}

    candidates = [cand(s, h, st, en) for s, i, h, st, en in scored[:5]]

    text_hits: List[Dict[str, Any]] = []
    if not candidates or is_toc_page(doc.page_text(candidates[0]["start_page"])):
        # 兜底：正文文本直接包含目标字符串
        for page in doc.pages:
            for line in page.text.splitlines():
                if t_norm in normalize_label(line) and len(line.strip()) < 80:
                    text_hits.append({"page": page.index, "line": line.strip()[:70]})
                    if len(text_hits) >= 10:
                        break
            if len(text_hits) >= 10:
                break

    # 普通讲义未必采用章节编号。独立、逐字匹配的标题行也是定位证据；
    # 正文里随口提及目标、目录条目不能成为正文定位。
    for hit in text_hits:
        if (normalize_label(hit["line"].lstrip("# ")) == t_norm
                and not is_toc_page(doc.page_text(hit["page"]))
                and len(doc.page_text(hit["page"]).strip()) >= 120):
            end = min((h.page - 1 for h in heads
                       if h.page > hit["page"] and h.level == 1), default=doc.total_pages)
            candidates.insert(0, {"score": 95, "title": hit["line"], "kind": "text_title",
                                  "level": 1, "start_page": hit["page"], "end_page": end})
            break

    # 稀疏扫描件没有可用标题文字时，必须搜索图像正文，不能据目录缺项报不存在。
    needs_ocr = (doc.kind == "pdf" and doc.scan_suspect and
                 (not candidates or is_toc_page(doc.page_text(candidates[0]["start_page"]))))
    ocr_result = None
    if needs_ocr and ocr_mod.ocr_available():
        toc_pages = [p.index for p in doc.pages if is_toc_page(p.text)]
        start, end = ocr_mod.content_bounds(doc.total_pages, toc_pages)
        cache = _page_cache(ctx, file)
        label_match = re.match(r"^(第\s*[\d一二三四五六七八九十百]+\s*章)", target)
        label = label_match.group(1) if label_match else target
        title = target[len(label):].strip()
        if hasattr(ctx, "emit"):
            ctx.emit(f"文字层未定位到正文，OCR 搜索「{target}」（P{start}–P{end}）", level="info")
        bookmark = _bookmark_range(ctx.input_dir / file, target, doc.total_pages)
        if bookmark:
            # 首页标题可能有单字 OCR 错误；用随后两页的章页眉核验书签，
            # 仍保留书签完整范围，不能把重复页眉截成几页的小节。
            for page in range(bookmark['start_page'], min(bookmark['end_page'], bookmark['start_page'] + 2) + 1):
                r = cache.get(page, 300, 'chi_sim+eng') or ocr_mod.ocr_page_with_cache(
                    ctx.input_dir / file, page, cache, lang='chi_sim+eng', dpi=150)
                text = r.get('text', '')
                if not (ocr_mod._title_on_page(text, label, title) and not is_toc_page(text)
                        and not r.get('failed') and (r.get('confidence') or 0) >= 60):
                    continue
                total = bookmark['end_page'] - bookmark['start_page'] + 1
                ocr_result = {'chapterStartPage': bookmark['start_page'], 'chapterEndPage': bookmark['end_page'],
                              'chapterTotalPages': total, 'bookmarksUsed': True,
                              'pagesOcrAttempted': page - bookmark['start_page'] + 1, 'pagesOcrSucceeded': 1,
                              'bodyContentCoverage': round(1 / total, 2), 'contentStatus': 'PARTIAL_CONTENT',
                              'bodyPages': [{'page': page, 'text': text, 'confidence': r.get('confidence')}]}
                break
        if not ocr_result:
            ocr_result = ocr_mod.locate_chapter_body_by_scan(
                ctx.input_dir / file, label, title, cache, content_start=start, content_end=end,
                cancel_event=getattr(ctx, "cancel_event", None), read_body=False)
        if ocr_result:
            for p in ocr_result["bodyPages"]:
                parser_registry.get_ocr_cache(str((ctx.input_dir / file).resolve()))[p["page"]] = \
                    Page(p["page"], p["text"], p.get("confidence"))
            candidates.insert(0, {"score": 95, "title": target, "kind": "ocr_title", "level": 1,
                                  "start_page": ocr_result["chapterStartPage"],
                                  "end_page": ocr_result["chapterEndPage"]})

    result: Dict[str, Any] = {
        "file": doc.name, "target": target, "total_pages": doc.total_pages,
        "note": _virtual_note(doc),
        "found": bool(candidates),
        "best": candidates[0] if candidates else None,
        "candidates": candidates,
    }
    if candidates:
        # 定位置信度：分数 + 目录页检测（目录页特征：大量"……页码"引导线）
        best_score = candidates[0]["score"]
        page_text = doc.page_text(candidates[0]["start_page"])
        is_toc = is_toc_page(page_text) and not ocr_result
        if is_toc:
            conf = "low"
            result["locationState"] = "TOC_LOCATED"
            result["toc_warning"] = ("定位命中的页面疑似目录页。"
                                     "目录只能用于确认章节存在与编号，禁止作为章节正文的起止页。")
        elif best_score >= 90:
            conf = "high"
            result["locationState"] = "BODY_LOCATED"
        elif best_score >= 70:
            conf = "medium"
            result["locationState"] = "BODY_LOCATED"
        else:
            conf = "low"
            result["locationState"] = "TARGET_RECOGNIZED"
        result["locationConfidence"] = conf
        if ocr_result:
            result["locationState"] = "BODY_LOCATED"
            result["ocr"] = {k: v for k, v in ocr_result.items() if k != "bodyPages"}
    if text_hits:
        result["text_search_hits"] = text_hits
        result["hint"] = ("标题匹配失败，但正文中出现目标字符串（见 text_search_hits）。"
                          "可以结合 read_pages 查看附近页面，确认章节实际边界。")
        if candidates and candidates[0]['kind'] == 'text_title':
            result['hint'] = '已通过独立标题行和可读正文完成定位，无需章节编号。'
    if ocr_result:
        result['hint'] = '已通过正文 OCR 核验定位；完整章节尚需调用 read_pages 读取，定位成功不代表全文已读。'
    if candidates:
        b = result["best"]
        result["summary"] = (f"目标「{target}」最佳匹配：「{b['title']}」"
                             f"（P{b['start_page']}–P{b['end_page']}，共 {b['end_page'] - b['start_page'] + 1} 页）")
    evidence_cache[cache_key] = result
    ctx._location_evidence = evidence_cache
    return result


# ---------------------------------------------------------------- read_pages
def _build_range_text(doc, start: int, end: int):
    """拼接范围内的带页标文本，并返回每页在文本中的精确偏移索引。"""
    parts, index, cursor = [], [], 0
    for p in doc.pages:
        if start <= p.index <= end:
            part = f"〔第 {p.index} 页〕\n{p.text}"
            index.append((p.index, cursor, cursor + len(part)))
            parts.append(part)
            cursor += len(part) + 2  # "\n\n" 连接符
    return "\n\n".join(parts), index


def _consumed_pages(index, upto_chars: int) -> List[int]:
    """text[:upto_chars] 已完整覆盖了哪些页（按精确偏移判断）。"""
    consumed = []
    for page, _s, e in index:
        if e <= upto_chars:
            consumed.append(page)
        else:
            break
    return consumed


def read_pages(ctx, args: Dict[str, Any]) -> Dict[str, Any]:
    file = args.get("file", "")
    try:
        start = int(args.get("start_page"))
        end = int(args.get("end_page"))
        offset = int(args.get("offset", 0) or 0)
    except (TypeError, ValueError):
        raise ToolError("start_page / end_page / offset 必须是整数")
    if start < 1 or end < start:
        raise ToolError(f"页码范围非法: {start}–{end}")
    doc = _load_doc(ctx, file)
    end = min(end, doc.total_pages)
    if start > doc.total_pages:
        raise ToolError(f"start_page={start} 超出文档总页数 {doc.total_pages}")
    if offset < 0:
        offset = 0

    # 扫描版自动 OCR：文字层稀疏时，对该范围尝试 OCR（有缓存）
    ocr_meta: Dict[str, Any] = {}
    if doc.kind == "pdf" and ocr_mod.ocr_available():
        doc = _ocr_range(ctx, file, doc, start, end)
        ocr_meta = {"ocr_used": True,
                    "ocr_pages": [p.index for p in doc.pages if start <= p.index <= end and p.ocr_confidence is not None]}

    text, index = _build_range_text(doc, start, end)
    chunk = text[offset:offset + config.READ_CHUNK_CHARS]
    next_offset = offset + len(chunk)
    has_more = next_offset < len(text)
    fully = ctx.mark_returned_text(file, index, offset, next_offset)

    result = {
        "file": doc.name, "start_page": start, "end_page": end,
        "total_pages": doc.total_pages, "note": _virtual_note(doc),
        "offset": offset, "returned_chars": len(chunk),
        "total_range_chars": len(text), "next_offset": next_offset if has_more else None,
        "has_more": has_more,
        "pages_fully_read": fully,
        "text": chunk if chunk else "（该范围内没有更多内容）",
    }
    if ocr_meta:
        result["ocr"] = ocr_meta
    return result


def _ocr_range(ctx, file: str, doc, start: int, end: int):
    """对 [start,end] 内文字层稀疏的页执行 OCR，返回带 OCR 文本的新文档（带缓存）。"""
    from ..parsers import registry as reg

    missing = [p.index for p in doc.pages if start <= p.index <= end and len(p.text.strip()) < 120]
    if not missing:
        return doc
    cached = reg.get_ocr_cache(str((ctx.input_dir / file).resolve()))
    todo = [p for p in missing if p not in cached]
    if todo:
        pdf_path = ctx.input_dir / file
        from ..agent.loop import RunCancelled
        try:
            cache = _page_cache(ctx, file)
            from ..parsers.base import Page
            for number, pno in enumerate(todo, 1):
                if getattr(ctx, "cancel_event", None) is not None and ctx.cancel_event.is_set():
                    raise RunCancelled()
                if hasattr(ctx, "emit"):
                    ctx.emit(f"正在识别正文 P{pno}（{number}/{len(todo)} 页）", level="info")
                r = ocr_mod.ocr_page_with_cache(pdf_path, pno, cache, lang="chi_sim+eng", dpi=300)
                cached[pno] = Page(pno, r.get("text", ""), r.get("confidence"), r.get("failed", False))
        except RunCancelled:
            raise
        except Exception as e:  # noqa: BLE001 - OCR 失败降级为原文本
            ctx.emit(f"OCR 失败（{e}），该页内容将不可用", level="warning") if hasattr(ctx, "emit") else None
    new_pages = []
    for p in doc.pages:
        if start <= p.index <= end and p.index in cached:
            new_pages.append(cached[p.index])
        else:
            new_pages.append(p)
    import dataclasses
    return dataclasses.replace(doc, pages=new_pages)


# ---------------------------------------------------------------- read_section
def read_section(ctx, args: Dict[str, Any]) -> Dict[str, Any]:
    """按标题文本定位并读取一个章节范围（内部换算成页范围 + 游标）。"""
    file = args.get("file", "")
    section = (args.get("section") or "").strip()
    if not section:
        raise ToolError("缺少参数 section（标题文本，如 '第一章 群'）")
    location = find_section(ctx, {"file": file, "target": section})
    best = location.get("best")
    if not best:
        raise ToolError(f"未找到标题含「{section}」的章节，请先用 find_section 确认标题原文")
    start, end = best["start_page"], best["end_page"]
    res = read_pages(ctx, {"file": file, "start_page": start, "end_page": end,
                           "offset": int(args.get("offset", 0) or 0)})
    res["matched_title"] = best["title"]
    return res


# ---------------------------------------------------------------- builders
def build_document_tools() -> list:
    from .base import Tool

    return [
        Tool(name="get_document_outline",
             description="获取某本教材的标题结构（目录大纲，含每条标题所在页码）。"
                         "用于快速了解书的全貌并辅助定位章节。",
             parameters={"type": "object",
                         "properties": {"file": {"type": "string", "description": "input/ 下的文件名"}},
                         "required": ["file"], "additionalProperties": False},
             handler=get_document_outline),
        Tool(name="find_section",
             description="在指定教材中定位目标章节（如 '第一章' / '8.3 一致收敛'），"
                         "返回候选标题及其页码范围 [start_page, end_page]。禁止猜测页码，必须以本工具结果为准。",
             parameters={"type": "object",
                         "properties": {"file": {"type": "string"},
                                        "target": {"type": "string", "description": "用户指定的章节名"}},
                         "required": ["file", "target"], "additionalProperties": False},
             handler=find_section),
        Tool(name="read_pages",
             description="读取某教材第 start_page 到 end_page 页的文本（自动分块）。"
                         "返回 next_offset/has_more：has_more=true 时必须用 offset=next_offset 继续调用，"
                         "直到读完整个范围。pages_fully_read 表示已完整阅读的页。",
             parameters={"type": "object",
                         "properties": {"file": {"type": "string"},
                                        "start_page": {"type": "integer"},
                                        "end_page": {"type": "integer"},
                                        "offset": {"type": "integer", "description": "分块游标，上次返回的 next_offset"}},
                         "required": ["file", "start_page", "end_page"], "additionalProperties": False},
             handler=read_pages),
        Tool(name="read_section",
             description="按标题原文读取某章节（等价于定位后 read_pages）。"
                         "返回 matched_title 与页范围，后续续读用 read_pages + offset。",
             parameters={"type": "object",
                         "properties": {"file": {"type": "string"},
                                        "section": {"type": "string"},
                                        "offset": {"type": "integer"}},
                         "required": ["file", "section"], "additionalProperties": False},
             handler=read_section),
    ]
