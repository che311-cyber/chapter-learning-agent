"""中文数字、标题识别、章节范围测试。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.parsers.base import ParsedDocument, Page
from app.parsers.headings import (cn_num_to_int, detect_heading, extract_headings,
                                  match_score, parse_target, section_range)


def make_doc(lines):
    text = "\n".join(lines)
    return ParsedDocument(name="t.md", kind="md", pages=[Page(index=1, text=text)])


def test_chinese_numerals():
    assert cn_num_to_int("一") == 1
    assert cn_num_to_int("十二") == 12
    assert cn_num_to_int("二十三") == 23
    assert cn_num_to_int("105") == 105
    assert cn_num_to_int("abc") is None


def test_cn_chapter_heading():
    for line, num in [("第一章 群", 1), ("第12章 极限", 12), ("第 二 章 映射", 2)]:
        h = detect_heading(line)
        assert h is not None, line
        assert h.kind == "chapter" and h.number == num


def test_dotted_headings_and_false_positives():
    assert detect_heading("8.3 一致收敛").dotted == "8.3"
    # 练习题列表行不应是章级标题
    h = detect_heading("1. 判断：ℤ 关于普通减法是否构成群？说明理由。")
    assert h is None or h.level > 1
    # 量词开头不是标题
    assert detect_heading("3 个性质需要注意") is None
    assert detect_heading("2023 年出版") is None


def test_md_mode_ignores_list_items():
    assert detect_heading("1. **封闭性**：对任意 a", md=True) is None
    assert detect_heading("## 1.2 群的定义", md=True) is not None
    assert detect_heading("第一章 群的定义与基本性质", md=True) is not None


def test_section_range_cut_by_same_level():
    doc = make_doc([
        "# 第一章 A", "内容", "## 1.1 甲", "内容甲", "## 1.2 乙", "内容乙",
        "# 第二章 B", "内容B",
    ])
    heads = extract_headings(doc)
    idx = next(i for i, h in enumerate(heads) if h.text.endswith("第一章 A"))
    st, en = section_range(heads, idx, doc.total_pages)
    assert (st, en) == (1, 1)
    idx2 = next(i for i, h in enumerate(heads) if h.text.endswith("1.1 甲"))
    st2, en2 = section_range(heads, idx2, doc.total_pages)
    assert (st2, en2) == (1, 1)


def test_parse_target_forms():
    assert parse_target("第一章")[1] == 1
    assert parse_target("第 1 章")[1] == 1
    assert parse_target("8.3 一致收敛")[2] == "8.3"
    assert parse_target("一致收敛") == ("一致收敛", None, None)


def test_match_score_tolerates_spaces():
    t = parse_target("第1章")
    h = detect_heading("第一章 群")
    assert match_score(h, *t) >= 90
