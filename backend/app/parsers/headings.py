"""章节标题识别：支持中文教材常见体例 + Markdown 标题。

- 第X章 / 第X讲 / 第X单元（X = 中文数字或阿拉伯数字）
- 1 / 1.2 / 1.2.3 编号式标题
- 第X节 / Chapter N / Section N
- Markdown # 级别
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

_CN_DIGITS = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000}


def cn_num_to_int(s: str) -> Optional[int]:
    """把 '十二' / '二十三' / '一百零五' / '42' 转成 int；失败返回 None。"""
    s = s.strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    total, cur = 0, 0
    for ch in s:
        if ch in _CN_DIGITS:
            cur = _CN_DIGITS[ch]
        elif ch in _CN_UNITS:
            unit = _CN_UNITS[ch]
            total += (cur if cur else 1) * unit
            cur = 0
        else:
            return None
    return total + cur


def normalize_label(s: str) -> str:
    """归一化：去空白/全角空格/常见标点差异，英文转小写。"""
    s = s.replace("\u3000", " ").replace("　", " ")
    s = re.sub(r"\s+", "", s)
    s = s.replace("：", ":").replace("．", ".").replace("、", "")
    s = s.replace("（", "(").replace("）", ")")
    return s.lower()


@dataclass
class Heading:
    page: int          # 1-based 页码
    line_no: int       # 页内行号（0-based）
    text: str          # 原始标题行
    level: int         # 1=章级 2=节级 3=更细
    number: Optional[int]      # 章号（第3章 -> 3）
    dotted: Optional[str]      # 点分编号（'8.3' / '1.2.3'）
    kind: str          # chapter / section / sub


_CH_NUM = r"([0-9０-９]+|[一二两三四五六七八九十百零]+)"
_RE_CN_CHAPTER = re.compile(rf"^第\s*{_CH_NUM}\s*(章|讲|单元|部分)")
_RE_CN_SECTION = re.compile(rf"^第\s*{_CH_NUM}\s*(节|课)")
_RE_DOTTED = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){1,3})[\s、.．]+(\S.*)$")
# "1 引言"（空格分隔，常见章级写法）；"1. 标题"（点号分隔更可能是练习题列表，降级为节级）
_RE_DOTTED_TOP = re.compile(r"^(\d{1,2})\s+([^\d.\s].*)$")
_RE_DOTTED_DOT = re.compile(r"^(\d{1,2})[.．、]\s*([^\d.\s].*)$")
# 量词/单位开头的大概率是正文（"3 个性质"），不是标题
_MEASURE_HEADS = set("个种条位次项道章节页点元类组步步")
_RE_EN = re.compile(r"^(chapter|section|lecture|part)\s+(\d{1,2})\b", re.I)
_RE_MD = re.compile("^(#{1,6})\\s+(.*)$")


def _norm_digits(s: str) -> str:
    return s.translate(str.maketrans("０１２３４５６７８９", "0123456789"))


def _number_from(s: str) -> Optional[int]:
    s = _norm_digits(s)
    if s.isdigit():
        return int(s)
    return cn_num_to_int(s)


def detect_heading(line: str, md: bool = False) -> Optional[Heading]:
    """判断一行是否标题，返回 Heading 或 None。

    md=True（Markdown 文档）时只认 '#' 标题与中文章级模式，
    避免 '1. 列表项' 被误判为节标题。
    """
    t = line.strip()
    if not t or len(t) > 80:
        return None

    m = _RE_MD.match(t)
    if m:
        level = len(m.group(1))
        rest = m.group(2).strip()
        h = _classify(rest)
        if h:
            return h
        return Heading(page=0, line_no=0, text=t, level=min(level, 6),
                       number=None, dotted=None, kind="md")

    h = _classify(t, md=md)
    return h


def _classify(title: str, md: bool = False) -> Optional[Heading]:
    plain = title.strip()

    m = _RE_CN_CHAPTER.match(plain)
    if m:
        num = _number_from(m.group(1))
        return Heading(page=0, line_no=0, text=plain, level=1, number=num,
                       dotted=None, kind="chapter")

    m = _RE_EN.match(plain)
    if m:
        kind = "chapter" if m.group(1).lower() in ("chapter", "lecture", "part") else "section"
        return Heading(page=0, line_no=0, text=plain,
                       level=1 if kind == "chapter" else 2,
                       number=int(m.group(2)), dotted=None, kind=kind)

    m = _RE_CN_SECTION.match(plain)
    if m:
        return Heading(page=0, line_no=0, text=plain, level=2,
                       number=_number_from(m.group(1)), dotted=None, kind="section")

    if md:
        return None  # Markdown 文档：非 '#' 行不再猜测编号标题

    m = _RE_DOTTED.match(plain)
    if m:
        depth = m.group(1).count(".") + 1
        return Heading(page=0, line_no=0, text=plain, level=min(depth + 1, 5),
                       number=None, dotted=m.group(1), kind="sub" if depth >= 3 else "section")

    m = _RE_DOTTED_TOP.match(plain)
    if m and len(m.group(2)) <= 40 and m.group(2)[0] not in _MEASURE_HEADS \
            and _has_cjk(m.group(2)):
        return Heading(page=0, line_no=0, text=plain, level=1,
                       number=int(m.group(1)), dotted=None, kind="chapter")

    m = _RE_DOTTED_DOT.match(plain)
    if m and len(m.group(2)) <= 40 and m.group(2)[0] not in _MEASURE_HEADS \
            and _has_cjk(m.group(2)):
        # 'N. 标题'：更可能是列表/习题条目，降为 sub 级，不参与节级边界切割
        return Heading(page=0, line_no=0, text=plain, level=4,
                       number=None, dotted=m.group(1), kind="sub")

    return None


def _has_cjk(s: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def _iter_lines(doc):
    for page in doc.pages:
        for ln, line in enumerate(page.text.splitlines()):
            yield page.index, ln, line


def extract_headings(doc) -> List[Heading]:
    """全文档标题列表（按出现顺序）。Markdown 文档只认 '#' 标题。"""
    md = getattr(doc, "kind", "") in ("md", "markdown")
    out: List[Heading] = []
    for page, ln, line in _iter_lines(doc):
        h = detect_heading(line, md=md)
        if h:
            h.page, h.line_no = page, ln
            out.append(h)
    return out


def match_score(heading: Heading, target_norm: str, target_num: Optional[int],
                target_dotted: Optional[str]) -> int:
    """标题与目标的匹配分（0-100）。"""
    hn = normalize_label(heading.text)
    if not target_norm:
        return 0
    if hn == target_norm:
        return 100
    numbered = _RE_CN_CHAPTER.match(heading.text.strip()) or _RE_CN_SECTION.match(heading.text.strip())
    if numbered and normalize_label(heading.text.strip()[numbered.end():]) == target_norm:
        return 98
    core = heading.text.strip()
    core_norm = normalize_label(core)
    if core_norm.startswith(target_norm) or target_norm.startswith(
            normalize_label(_strip_after_title(heading))):
        return 92
    if target_norm and target_norm in hn:
        return 85 - min(20, len(hn) - len(target_norm))

    # 编号匹配
    if heading.dotted and target_dotted:
        if heading.dotted == target_dotted:
            return 95
        if heading.dotted.startswith(target_dotted + "."):
            return 60
        return 0
    if target_dotted and not heading.dotted:
        return 0
    if target_num is not None and heading.number == target_num:
        if heading.kind == "chapter":
            return 90
        return 70
    return 0


def _strip_after_title(h: Heading) -> str:
    """取标题中编号与分隔符之前的部分（用于 '第1章 群' 匹配 '第一章'）。"""
    t = h.text
    m = _RE_CN_CHAPTER.match(t.strip()) or _RE_CN_SECTION.match(t.strip())
    if m:
        return m.group(0)
    m = _RE_DOTTED.match(t.strip()) or _RE_DOTTED_TOP.match(t.strip())
    if m:
        return m.group(1)
    return t


def parse_target(target: str):
    """解析目标字符串 -> (norm, number, dotted)。"""
    t = normalize_label(target)
    t = _norm_digits(t)
    m = re.match(r"^第([0-9一二两三四五六七八九十百零]+)(章|讲|单元|部分|节|课)", t)
    number = _number_from(m.group(1)) if m else None
    m2 = re.match(r"^(\d{1,2}(?:\.\d{1,2}){0,3})", t)
    dotted = m2.group(1) if m2 else None
    return t, number, dotted


def section_range(headings: List[Heading], idx: int, total_pages: int):
    """headings[idx] 所在章节的页范围 [start, end]（含端点，1-based）。"""
    h = headings[idx]
    start = h.page
    end = total_pages
    for nxt in headings[idx + 1:]:
        if nxt.level <= h.level and nxt.page >= start:
            end = max(start, nxt.page - 1) if nxt.page > start else start
            break
    return start, end
