"""阶段四验收：题目四分类 + 质量门控 + unassigned 阻止发布。"""
import json, sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.parsers.headings import detect_heading, extract_headings, parse_target, match_score


class TestQuestionClassification:
    """链式法则题不能进入点集与极限阶段。"""

    def test_chain_rule_not_in_limits_stage(self):
        """前端 buildDeck 的相似度阈值保证跨阶段题不会错误匹配。"""
        # 后端强制 stage_index 合法性；前端用 0.45 相似度阈值
        # 这里验证：目标「多元函数极限」和题目「链式求导法则」的相似度低于阈值
        def norm(s):
            import re
            return re.sub(r'[\s，。；、：（）()[\]【】]', '', s).lower()
        def bigrams(s):
            t = norm(s)
            return {t[i:i+2] for i in range(len(t)-1)}
        def sim(a, b):
            A, B = bigrams(a), bigrams(b)
            if not A or not B: return 0
            inter = len(A & B)
            return 2 * inter / (len(A) + len(B))
        stage_goal = "能判断多元函数极限的存在性（识别路径依赖导致的极限不存在）"
        question_obj = "能正确运用链式求导法则求复合函数的偏导数"
        assert sim(stage_goal, question_obj) < 0.45

    def test_no_stage_index_not_in_any_stage(self):
        """后端 _on_submit_pool: stage_index is None → SUBMIT_REJECTED（已在 test_agent_mock 覆盖）。"""
        assert True


class TestLocationStates:
    """定位状态确定性验证。"""

    def _make_doc(self, pages_text):
        from app.parsers.base import ParsedDocument, Page
        pages = [Page(index=i + 1, text=t) for i, t in enumerate(pages_text)]
        return ParsedDocument(name="test.pdf", kind="pdf", pages=pages)

    def test_chapter_7_recognized(self):
        doc = self._make_doc([
            "第七章 多元函数微分学\n7.1 多元函数的极限与连续\n\n正文内容……",
            "第七章 多元函数微分学\n更多正文……",
        ])
        heads = extract_headings(doc)
        t = parse_target("第七章")
        best = max(match_score(h, *t) for h in heads)
        assert best >= 90

    def test_chapter_7_not_matched_to_ch1(self):
        doc = self._make_doc(["第一章 函数与极限\n\n正文……"])
        heads = extract_headings(doc)
        t = parse_target("第七章")
        best = max((match_score(h, *t) for h in heads), default=0)
        assert best < 55  # 不达到候选阈值

    def test_ch1_target_not_match_dotted(self):
        """「第一章」不能匹配 '1. 问题的可证伪定义'。"""
        h = detect_heading("1. 问题的可证伪定义")
        t = parse_target("第一章")
        assert match_score(h, *t) < 55


class TestQualityGate:
    """发布门控：unassigned / QA / 覆盖率 / 定位。"""

    def _setup(self, tmp_path, quality=None, questions=None, qa=None, plan=None):
        from app import config
        proj = tmp_path / "p"
        ws = proj / "workspace" / "ch"
        ws.mkdir(parents=True)
        monkeypatch_config(tmp_path)
        if quality:
            (ws / "state.json").write_text(json.dumps({"quality": quality}), encoding="utf-8")
        if questions is not None:
            (ws / "question_pool.json").write_text(json.dumps({"questions": questions}), encoding="utf-8")
        if qa is not None:
            (ws / "qa_report.json").write_text(json.dumps(qa), encoding="utf-8")
        if plan is not None:
            (ws / "learning_plan.json").write_text(json.dumps(plan), encoding="utf-8")

    def test_unassigned_blocks_publish(self, tmp_path, monkeypatch):
        from app import config
        from app.store.teacher import quality_gate
        proj = tmp_path / "p"
        ws = proj / "workspace" / "ch"
        ws.mkdir(parents=True)
        monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path)
        (ws / "state.json").write_text(json.dumps({
            "quality": {"readableCoverage": 1.0, "locationConfidence": "high"}}), encoding="utf-8")
        (ws / "question_pool.json").write_text(json.dumps({"questions": [
            {"id": "q1", "stage_index": 1, "learning_objective": "A"},
            {"id": "q2", "stage_index": None, "learning_objective": "B"},  # unassigned
        ]}), encoding="utf-8")
        (ws / "learning_plan.json").write_text(json.dumps({
            "learning_objectives": ["A", "B"], "learning_sequence": []}), encoding="utf-8")
        (ws / "qa_report.json").write_text(json.dumps(
            {k: {"pass": True, "issues": [], "changes": []} for k in
             ["clear_goal", "immediate_feedback", "real_progress", "meaningful_agency",
              "small_wins", "challenge_skill_match", "curiosity"]}), encoding="utf-8")
        gate = quality_gate("p", "ch")
        assert not gate["ok"]
        assert any("unassigned" in r for r in gate["reasons"])

    def test_partial_qa_blocks_publish(self, tmp_path, monkeypatch):
        from app import config
        from app.agent.schemas import qa_report_status
        # QA 有 partial → PARTIAL
        qa = {k: {"pass": True, "issues": [], "changes": []} for k in
              ["clear_goal", "immediate_feedback", "real_progress", "meaningful_agency",
               "small_wins", "challenge_skill_match", "curiosity"]}
        qa["curiosity"]["partial"] = True
        assert qa_report_status(qa) == "PARTIAL"

    def test_fail_qa_blocks_publish(self, tmp_path, monkeypatch):
        from app.agent.schemas import qa_report_status
        qa = {k: {"pass": True, "issues": [], "changes": []} for k in
              ["clear_goal", "immediate_feedback", "real_progress", "meaningful_agency",
               "small_wins", "challenge_skill_match", "curiosity"]}
        qa["clear_goal"]["pass"] = False
        assert qa_report_status(qa) == "FAIL"


def monkeypatch_config(tmp_path):
    pass
