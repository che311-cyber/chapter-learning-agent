"""Schema 校验与状态机测试。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.agent import schemas


def valid_context():
    return {
        "chapter": "第一章", "source_files": ["a.md"],
        "core_concepts": ["群", "单位元"],
        "definitions": [{"term": "群", "content": "...", "source_file": "a.md",
                         "source_page": 2}],
        "theorems": [],
        "source_references": [{"file": "a.md", "page": 2}],
    }


def test_context_requires_sources():
    assert schemas.validate_chapter_context(valid_context()) == []
    bad = valid_context()
    bad["definitions"][0].pop("source_file")
    errors = schemas.validate_chapter_context(bad)
    assert any("出处" in e for e in errors)
    bad2 = valid_context()
    bad2["source_references"] = []
    assert schemas.validate_chapter_context(bad2)


def test_question_validation():
    good = {"id": "q1", "type": "single_choice", "difficulty": 2,
            "learning_objective": "x", "prompt": "p", "options": ["A选项", "B选项"],
            "answer": "A", "explanation": "e", "source_basis": ["a.md P3"]}
    errors = []
    schemas.validate_question(good, 0, errors, set())
    assert not errors

    for mutate, expect in [
        (lambda q: q.update(answer="H"), "选项字母"),
        (lambda q: q.update(type="quiz"), "type"),
        (lambda q: q.update(difficulty=5), "difficulty"),
        (lambda q: q.pop("explanation"), "explanation"),
        (lambda q: q.update(source_basis=[]), "source_basis"),
        (lambda q: q.update(options=["只有一项"], answer="A"), "选项"),
    ]:
        q = dict(good)
        mutate(q)
        errors = []
        schemas.validate_question(q, 0, errors, set())
        assert errors, f"应拒绝: {q}"


def test_plan_validation():
    good = {"chapter": "c", "learning_objectives": ["a", "b"],
            "learning_sequence": [
                {"stage": 1, "name": "n", "goal": "g", "content": ["x"]},
                {"stage": 2, "name": "n2", "goal": "g2", "content": ["y"]}],
            "mastery_criteria": ["m1", "m2"]}
    assert schemas.validate_learning_plan(good) == []
    bad = dict(good)
    bad["learning_sequence"] = bad["learning_sequence"][:1]
    assert schemas.validate_learning_plan(bad)
    bad2 = dict(good)
    bad2["mastery_criteria"] = []
    assert schemas.validate_learning_plan(bad2)


def test_qa_report():
    def item(p):
        return {"pass": p, "issues": [] if p else ["x"], "changes": []}
    good = {k: item(True) for k in schemas.QA_KEYS}
    assert schemas.validate_qa_report(good) == []
    assert schemas.qa_all_pass(good)
    bad = {k: item(True) for k in schemas.QA_KEYS}
    bad["curiosity"] = item(False)
    assert not schemas.qa_all_pass(bad)
    assert schemas.validate_qa_report(bad) == []  # pass=false 且给出 issues：合法
    bad2 = {k: item(True) for k in schemas.QA_KEYS}
    bad2["curiosity"] = {"pass": False, "issues": [], "changes": []}  # 无 issues：非法
    assert schemas.validate_qa_report(bad2)
    partial = {k: item(True) for k in schemas.QA_KEYS}
    partial["curiosity"] = {"pass": True, "issues": [], "changes": [],
                            "partial": True}  # 缺 justification
    assert schemas.validate_qa_report(partial)


def test_verification_validation():
    good = {"re_solved": True, "issues": [], "overall_pass": True}
    assert schemas.validate_verification(good) == []
    bad = {"re_solved": False, "issues": [], "overall_pass": True}
    assert schemas.validate_verification(bad)
    bad2 = {"re_solved": True, "issues": [{"question_id": "q1"}], "overall_pass": False}
    assert schemas.validate_verification(bad2)  # issue 缺 problem 或 fix
    bad3 = {"re_solved": True,
            "issues": [{"question_id": "q1", "problem": "p"}], "overall_pass": False}
    assert schemas.validate_verification(bad3) == []  # 允许诚实报告未解决问题
