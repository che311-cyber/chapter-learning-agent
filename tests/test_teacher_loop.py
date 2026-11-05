"""教师闭环：审核发布 / 批注任务 / 学情报告回流 / 题目编辑删除。"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.store import teacher


@pytest.fixture()
def tctx(tmp_path, monkeypatch):
    from app import config
    proj = tmp_path / "p1"
    (proj / "workspace" / "ch1").mkdir(parents=True)
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path)
    return proj


def test_review_draft_default_and_publish(tctx):
    assert teacher.read_review("p1", "ch1")["status"] == "draft"
    # 无质量数据 → 发布被门控阻止（blocked）并给出原因
    rev = teacher.set_review("p1", "ch1", "published", note="已审核，可发布")
    assert rev.get("blocked") is True and rev["status"] == "blocked"
    assert any("质量" in r or "覆盖率" in r for r in rev["reasons"])
    # 缺少正文证据不能通过教师强制确认绕过。
    rev2 = teacher.set_review("p1", "ch1", "published", note="已审核，可发布",
                              difficulty_note="基础题为主", teacher_confirmed=True)
    assert rev2["status"] == "blocked"
    # 正文可靠、仅 QA 为部分应用时，教师可显式确认并留痕。
    ws = tctx / "workspace" / "ch1"
    (ws / "state.json").write_text(json.dumps({"status": "COMPLETE", "quality": {
        "readableCoverage": 1, "contentStatus": "CONTENT_READY", "sourceAuditVersion": 1}}))
    (ws / "chapter_context.json").write_text(json.dumps({"core_concepts": ["a", "b"],
        "definitions": [{"term": "a", "content": "定义正文"}], "source_references": [{"file": "book.md", "page": 1}]}))
    (ws / "learning_plan.json").write_text(json.dumps({"learning_objectives": ["a", "b"],
        "learning_sequence": [{"stage": 1}, {"stage": 2}]}))
    (ws / "question_pool.json").write_text(json.dumps({"questions": [
        {"id": "q1", "stage_index": 1, "learning_objective": "a"},
        {"id": "q2", "stage_index": 2, "learning_objective": "b"}]}))
    (ws / "verification.json").write_text(json.dumps({"re_solved": True, "verified_count": 2, "issues": [], "overall_pass": True}))
    from app.agent.schemas import QA_KEYS
    qa = {k: {"pass": True, "issues": [], "changes": []} for k in QA_KEYS}
    qa["curiosity"].update(partial=True, justification="部分应用")
    (ws / "qa_report.json").write_text(json.dumps(qa))
    rev3 = teacher.set_review("p1", "ch1", "published", note="已审核，可发布",
                              difficulty_note="基础题为主", teacher_confirmed=True)
    assert rev3["status"] == "published" and rev3["note"] == "已审核，可发布"
    assert teacher.read_review("p1", "ch1")["difficulty_note"] == "基础题为主"
    assert teacher.read_review("p1", "ch1")["teacher_override"]["reasons"]


def test_learning_report_roundtrip(tctx):
    teacher.save_learning_report("p1", "ch1", {
        "learning": {"answered": 5, "correct": 3, "wrong": 2, "accuracy": 60,
                     "objectiveWeakness": [{"objective": "穿脱原理", "wrong": 2, "total": 2}],
                     "wrongQuestions": [{"id": "q1", "prompt": "?", "answer": "A"}],
                     "mastery": [{"criterion": "c1", "checked": True}]},
        "game": {"xp": 130, "level": 2},
    })
    rs = teacher.list_learning_reports("p1", "ch1")
    assert len(rs) == 1
    assert rs[0]["answered"] == 5 and rs[0]["accuracy"] == 60
    assert rs[0]["weak_objectives"][0]["objective"] == "穿脱原理"
    assert rs[0]["mastery"][0]["checked"] is True


def test_question_edit_delete(tctx):
    teacher._save_pool("p1", "ch1", {"questions": [
        {"id": "q1", "prompt": "旧题面", "answer": "A", "explanation": "e",
         "difficulty": 1, "learning_objective": "o", "options": ["A", "B"]},
        {"id": "q2", "prompt": "另一题", "answer": "B", "explanation": "e",
         "difficulty": 2, "learning_objective": "o", "options": ["A", "B"]},
    ]})
    r = teacher.update_question("p1", "ch1", "q1", {"prompt": "新题面", "answer": "B"})
    assert r["question"]["prompt"] == "新题面"
    pool = teacher._load_pool("p1", "ch1")
    assert pool["questions"][0]["answer"] == "B"
    r2 = teacher.delete_question("p1", "ch1", "q2")
    assert len(teacher._load_pool("p1", "ch1")["questions"]) == 1


def test_teacher_token_gate(monkeypatch):
    """阶段七：配置 TEACHER_PASSWORD 后，无效令牌被拒绝、有效令牌通过。"""
    import os
    monkeypatch.setenv("TEACHER_PASSWORD", "demo-pass")
    from app.api import routes as routes_mod
    monkeypatch.setattr(routes_mod, "_TEACHER_TOKENS", {})
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        routes_mod.require_teacher("bad-token")
    assert ei.value.status_code == 401
    login = routes_mod.teacher_login(routes_mod.TeacherLoginIn(password="demo-pass"))
    token = login["data"]["token"]
    routes_mod.require_teacher(token)  # 不抛即通过


def test_quality_gate_blocks_low_coverage(tmp_path, monkeypatch):
    """阶段一：正文覆盖率不足时发布被门控阻止。"""
    from app import config
    from app.store import teacher
    proj = tmp_path / "p"
    ws = proj / "workspace" / "ch"
    ws.mkdir(parents=True)
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path)
    (ws / "state.json").write_text(json.dumps({
        "quality": {"readableCoverage": 0.1, "pagesTotal": 10, "pagesReadable": 1,
                    "locationConfidence": "low"}}), encoding="utf-8")
    gate = teacher.quality_gate("p", "ch")
    assert not gate["ok"] and len(gate["reasons"]) >= 2
    rev = teacher.set_review("p", "ch", "published")
    assert rev.get("blocked") is True
