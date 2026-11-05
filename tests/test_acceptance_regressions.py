"""本轮五项验收回归：实际工具、提交校验与线上旧成果夹具。"""
import importlib.util
import json
from pathlib import Path

import pytest

from app.agent.controller import AnalysisController
from app.agent.loop import PhaseError
from app.agent.verification import summarize_verification
from app.parsers.base import Page, ParsedDocument
from app.parsers import registry, ocr
from app.store import runs, teacher
from app.store.quality import audit_source, map_legacy_questions
from app.tools.document_tools import find_section, read_pages, read_section

FIXTURE = json.loads((Path(__file__).parent / "fixtures/legacy_acceptance.json").read_text())
BODY = "若一阶微分方程可写成 y'=f(x)g(y)，称为变量可分离的形式。\n" * 8
TOC = "第七章 多元函数微分学.......201\n第八章 多元函数积分学.......245\n第九章 级数.......280\n"


def fake_document(ctx, monkeypatch, pages, target, name="lecture.pdf"):
    (ctx.input_dir / name).write_bytes(b"mock PDF")
    doc = ParsedDocument(name, "pdf", [Page(i + 1, t) for i, t in enumerate(pages)],
                         text_density=sum(map(len, pages)) / len(pages))
    monkeypatch.setattr(registry, "get_document", lambda path: doc)
    monkeypatch.setattr(ocr, "ocr_available", lambda: False)
    controller = AnalysisController(ctx.project, target)
    controller.ctx = ctx
    return controller


def test_plain_four_page_lecture(ctx_factory, monkeypatch):
    target = "变量可分离一阶微分方程"
    ctx = ctx_factory(target)
    c = fake_document(ctx, monkeypatch, [target + "\n" + BODY] + [BODY] * 3, target)
    found = find_section(ctx, {"file": "lecture.pdf", "target": target})
    assert found["found"] and found["locationState"] == "BODY_LOCATED"
    assert found["best"]["start_page"] == 1 and found["best"]["end_page"] == 4
    assert c._on_submit_location(dict(file="lecture.pdf", heading=target, start_page=1, end_page=4)).startswith("SUBMIT_ACCEPTED")
    assert c._on_submit_location(dict(file="lecture.pdf", heading=target, start_page=2, end_page=4)).startswith("SUBMIT_REJECTED")
    assert read_section(ctx, {"file": "lecture.pdf", "section": target})["matched_title"] == target


def test_incidental_mention_not_a_title(ctx_factory, monkeypatch):
    ctx = ctx_factory("变量可分离一阶微分方程")
    fake_document(ctx, monkeypatch, ["本节回顾变量可分离一阶微分方程的一般情形。\n" + BODY], ctx.target)
    assert not find_section(ctx, {"file": "lecture.pdf", "target": ctx.target})["found"]


def test_body_wins_over_toc(ctx_factory, monkeypatch):
    ctx = ctx_factory("第七章")
    fake_document(ctx, monkeypatch, [TOC, "第七章 多元函数微分学\n" + BODY], ctx.target)
    found = find_section(ctx, {"file": "lecture.pdf", "target": ctx.target})
    assert found["locationState"] == "BODY_LOCATED" and found["best"]["start_page"] == 2


def test_toc_reading_cannot_start_generation(ctx_factory, monkeypatch):
    ctx = ctx_factory("第七章")
    c = fake_document(ctx, monkeypatch, [TOC * 3], ctx.target)
    ctx.located = dict(file="lecture.pdf", heading="第七章", start_page=1, end_page=1)
    read_pages(ctx, {"file": "lecture.pdf", "start_page": 1, "end_page": 1})
    with pytest.raises(PhaseError, match="仅定位并读取到目录"):
        c._on_submit_reading({"read_complete": True, "outline_summary": "目录结构说明，仅含章节与小节名称，正文尚未读取。" * 2, "backtracking_queries": []})
    assert not ctx.flags["chapter_read_complete"]
    assert ctx.artifacts["quality"]["readableCoverage"] == 0


def test_ocr_checks_gaps_and_reads_whole_chapter(tmp_path, monkeypatch):
    monkeypatch.setattr(ocr, "ocr_available", lambda: True)
    texts = {p: BODY for p in range(1, 81)}
    texts[37] = "第十章 常微分方程\n" + BODY
    texts[51] = "第十一章 概率论\n" + BODY
    monkeypatch.setattr(ocr, "ocr_page_with_cache", lambda path, p, cache, **kw: {
        "text": texts[p], "confidence": 90, "failed": False})
    r = ocr.locate_chapter_body_by_scan(tmp_path / "a.pdf", "第十章", "常微分方程", None,
                                         content_start=1, content_end=80)
    assert r["chapterStartPage"] == 37 and r["chapterEndPage"] == 50
    assert len(r["bodyPages"]) == 14  # 旧实现只读前 10 页。
    assert r["bodyContentCoverage"] == 1
    by_title = ocr.locate_chapter_body_by_scan(tmp_path / "a.pdf", "常微分方程", "", None,
                                                content_start=1, content_end=80)
    assert by_title["chapterStartPage"] == 37 and by_title["chapterEndPage"] == 50
    assert not ocr._fuzzy_contains("题目 10，数据 100", "第十章")
    assert ocr._fuzzy_contains("第10章 常微分方程", "第十章")
    assert not ocr._fuzzy_contains("任意内容", "")
    assert ocr._title_on_page('第十章，常微分方程', '常微分方程')
    assert ocr._title_on_page('第十章 ”常微分方程', '常微分方程')
    located = ocr.locate_chapter_body_by_scan(tmp_path / "a.pdf", "常微分方程", "", None,
                                               content_start=1, content_end=80, read_body=False)
    assert len(located["bodyPages"]) == 1
    assert located["bodyContentCoverage"] < 1  # 定位不得冒充全文已读。
    assert ocr.content_bounds(528, [522, 523, 524]) == (1, 521)
    assert ocr.content_bounds(528, [2, 3]) == (4, 528)


def test_pdf_bookmark_range_and_ocr_confirmation(ctx_factory, monkeypatch):
    from pypdf import PdfWriter
    from app.tools import document_tools
    ctx = ctx_factory('常微分方程')
    path = ctx.input_dir / 'bookmarked.pdf'
    writer = PdfWriter()
    for _ in range(8):
        writer.add_blank_page(width=600, height=800)
    writer.add_outline_item('第十章 常微分方程', 2)
    writer.add_outline_item('第十一章 概率论', 5)
    with path.open('wb') as f:
        writer.write(f)
    bookmark = document_tools._bookmark_range(path, '常微分方程', 8)
    assert bookmark['start_page'] == 3 and bookmark['end_page'] == 5
    monkeypatch.setattr(registry, 'get_document', lambda p: ParsedDocument(path.name, 'pdf', [Page(i + 1, '') for i in range(8)]))
    monkeypatch.setattr(ocr, 'ocr_available', lambda: True)
    seen = []
    def recognize(path, page, cache, **kwargs):
        seen.append(page)
        return {'text': '第十章\n常微分方程\n' + BODY, 'confidence': 90, 'failed': False}
    monkeypatch.setattr(ocr, 'ocr_page_with_cache', recognize)
    found = find_section(ctx, {'file': path.name, 'target': ctx.target})
    assert found['locationState'] == 'BODY_LOCATED'
    assert found['best']['start_page'] == 3 and found['best']['end_page'] == 5
    assert found['ocr']['bookmarksUsed'] is True
    assert seen == [3]  # 定位只核验命中页，完整读取在 READ 阶段进行。
    ctx._location_evidence = {}
    seen.clear()
    def recognize_title_typo(path, page, cache, **kwargs):
        seen.append(page)
        return {'text': ('第十章\n常微分方程错字\n' if page == 3 else '第十章 常微分方程\n') + BODY,
                'confidence': 90, 'failed': False}
    monkeypatch.setattr(ocr, 'ocr_page_with_cache', recognize_title_typo)
    found = find_section(ctx, {'file': path.name, 'target': ctx.target})
    assert found['best']['start_page'] == 3 and found['best']['end_page'] == 5
    assert seen == [3, 4]  # 下一页页眉确认后保留完整书签范围。


def test_real_legacy_source_and_stage_map():
    old = FIXTURE["ch7"]
    q = audit_source(old["state"], old["chapter_context"], old["verification"])
    assert q["sourceScope"] == "TOC_ONLY" and q["readableCoverage"] == 0 and q["requiresReview"]
    old = FIXTURE["multivariable"]
    pool = map_legacy_questions(old["learning_plan"], old["question_pool"], old["verification"])
    assert [q["stage_index"] for q in pool["questions"]] == [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6]
    assert all("stage_index" not in q for q in old["question_pool"]["questions"])
    verify = summarize_verification(FIXTURE["ch7"]["verification"])
    assert verify["issue_counts"] == {"found": 12, "corrected": 0, "unresolved": 1, "no_change_needed": 11}


def test_verification_only_counts_actual_changes(ctx_factory):
    from copy import deepcopy
    ctx = ctx_factory()
    c = AnalysisController(ctx.project, ctx.target)
    c.ctx = ctx
    original = {"id": "q1", "type": "single_choice", "difficulty": 1, "stage_index": 1,
                "learning_objective": "封闭性", "prompt": "测试题", "options": ["A", "B"],
                "answer": "A", "explanation": "原解析", "source_basis": ["sample.md P1"]}
    ctx.artifacts["pool"] = {"questions": [original]}
    ctx.artifacts["plan"] = {"learning_sequence": [{"stage": 1}]}
    corrected = dict(original, answer="B", explanation="修正解析")
    payload = {"re_solved": True, "overall_pass": True, "verified_count": 1,
               "issues": [{"question_id": "q1", "problem": "答案错误", "corrected_question": corrected}]}
    assert c._on_submit_verify(payload).startswith("SUBMIT_ACCEPTED")
    assert ctx.artifacts["verify"]["issue_counts"]["corrected"] == 1
    assert ctx.artifacts["pool"]["questions"][0]["answer"] == "B"
    assert c._on_submit_verify(payload).startswith("SUBMIT_ACCEPTED")
    assert ctx.artifacts["verify"]["issue_counts"]["corrected"] == 0
    assert ctx.artifacts["verify"]["issue_counts"]["no_change_needed"] == 1
    bad = deepcopy(payload)
    bad["issues"].append({"question_id": "q99", "problem": "不应新增题目", "corrected_question": dict(original, id="q99")})
    before = deepcopy(ctx.artifacts["pool"])
    assert c._on_submit_verify(bad).startswith("SUBMIT_REJECTED")
    assert ctx.artifacts["pool"] == before
    claimed = {"re_solved": True, "overall_pass": True, "verified_count": 1, "issues": [
        {"question_id": "q1", "problem": "解析有问题", "fix_applied": "已修复"}]}
    assert c._on_submit_verify(claimed).startswith("SUBMIT_ACCEPTED")
    assert ctx.artifacts["verify"]["overall_pass"] is False
    assert ctx.artifacts["verify"]["issue_counts"]["unresolved"] == 1


def test_question_objective_and_stage_coverage_before_finalizing(ctx_factory):
    from copy import deepcopy
    ctx = ctx_factory()
    c = AnalysisController(ctx.project, ctx.target)
    c.ctx = ctx
    ctx.artifacts["plan"] = {"learning_objectives": ["能求逆元（P2）", "能应用消去律（P3）"],
                             "learning_sequence": [{"stage": 1}, {"stage": 2}]}
    q = {"id": "q1", "type": "short_answer", "difficulty": 1, "stage_index": 1,
         "learning_objective": "求逆元", "prompt": "求逆元", "answer": "答案",
         "explanation": "解析", "source_basis": ["sample.md P2"]}
    assert "逐字复制" in c._on_submit_pool({"questions": [q]})
    assert "pool" not in ctx.artifacts
    qs = [dict(deepcopy(q), id=f"q{i}", learning_objective="能求逆元（P2）",
               difficulty=1 if i == 1 else 2) for i in range(1, 6)]
    assert "全部 learning_objectives" in c._on_submit_pool({"questions": qs, "is_final": True})
    qs[-1]["learning_objective"] = "能应用消去律（P3）"
    assert "没有练习题" in c._on_submit_pool({"questions": qs, "is_final": True})
    qs[-1]["stage_index"] = 2
    assert c._on_submit_pool({"questions": qs, "is_final": True}).startswith("SUBMIT_ACCEPTED")


def test_ocr_text_and_confidence_from_one_recognition(tmp_path, monkeypatch):
    import subprocess
    calls = []
    monkeypatch.setattr(ocr, "ocr_available", lambda: True)
    def run(cmd, **kwargs):
        calls.append(cmd)
        prefix = Path(cmd[-1]) if cmd[0] == "pdftoppm" else Path(cmd[2])
        if cmd[0] == "pdftoppm":
            prefix.with_suffix(".png").write_bytes(b"image")
        else:
            prefix.with_suffix(".txt").write_text("正文\n")
            prefix.with_suffix(".tsv").write_text("header\n1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t90\t正文\n")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")
    monkeypatch.setattr(ocr, "_run", run)
    result = ocr.ocr_pdf_pages(tmp_path / "test.pdf", [1])
    assert result.pages[0].text == "正文" and result.pages[0].ocr_confidence == 90
    assert not result.pages[0].ocr_failed
    assert len([cmd for cmd in calls if cmd[0] == "tesseract"]) == 1
    monkeypatch.setattr(ocr, "_run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, b"", b""))
    assert ocr.ocr_pdf_pages(tmp_path / "test.pdf", [1]).pages[0].ocr_failed


def test_ocr_cancel_is_not_swallowed(ctx_factory, monkeypatch):
    from app.agent.loop import RunCancelled
    from app.tools.document_tools import _ocr_range
    ctx = ctx_factory()
    ctx.cancel_event.set()
    doc = ParsedDocument("test.pdf", "pdf", [Page(1, "")])
    monkeypatch.setattr(registry, "get_ocr_cache", lambda path: {})
    monkeypatch.setattr(ocr, "ocr_page_with_cache", lambda *a, **kw: pytest.fail("cancelled OCR must not run"))
    with pytest.raises(RunCancelled):
        _ocr_range(ctx, "sample.md", doc, 1, 1)


def test_truncated_tool_arguments_receive_compact_retry_hint(ctx_factory):
    from app.agent.loop import PhaseRunner
    ctx = ctx_factory()
    ctx.phase = "UNDERSTAND"
    class Client:
        calls = 0
        def chat(self, messages, **kwargs):
            self.calls += 1
            if self.calls == 2:
                assert messages[-1]["role"] == "user"
                assert "缩短至少一半" in messages[-1]["content"]
                assert messages[-2]["role"] == "tool"
            return {"truncated": self.calls == 1, "tool_calls": [{"id": str(self.calls),
                "function": {"name": "submit_chapter_context",
                             "arguments": '{"chapter":' if self.calls == 1 else '{}'}}]}
    def submit(name, args):
        runner.accepted = {"tool": name, "args": args}
        return "SUBMIT_ACCEPTED: accepted"
    runner = PhaseRunner(ctx, Client(), submit)
    assert runner.run("test", "test")["tool"] == "submit_chapter_context"


def test_new_failure_points_use_schema_strings():
    from app.agent.schemas import validate_learning_plan
    plan = {"chapter": "test", "learning_objectives": ["a", "b"],
            "mastery_criteria": ["a", "b"], "learning_sequence": [
                {"stage": 1, "name": "a", "goal": "a", "content": ["a"]},
                {"stage": 2, "name": "b", "goal": "b", "content": ["b"]}],
            "common_failure_points": [{"failure": "error", "remedy": "fix"}]}
    assert any("common_failure_points" in error for error in validate_learning_plan(plan))
    plan["common_failure_points"] = ["error：fix"]
    assert validate_learning_plan(plan) == []


def test_qa_revision_batches_accumulate_and_require_final(ctx_factory):
    from app.agent.schemas import QA_KEYS
    ctx = ctx_factory()
    ctx.phase = "PSYCHOLOGY_CHECK"
    c = AnalysisController(ctx.project, ctx.target)
    c.ctx = ctx
    ctx.artifacts["plan"] = {"learning_objectives": ["a", "b"], "learning_sequence": [{"stage": 1}, {"stage": 2}]}
    ctx.artifacts["pool"] = {"questions": [{"id": "old"}], "final": True}
    qs = [{"id": f"q{i}", "type": "short_answer", "difficulty": 1 if i == 1 else 2,
           "learning_objective": "a" if i < 4 else "b", "stage_index": 1 if i < 4 else 2,
           "prompt": "题目", "answer": "答案", "explanation": "解析", "source_basis": ["sample.md P2"]}
          for i in range(1,6)]
    report = {key: {"pass": True, "issues": [], "changes": []} for key in QA_KEYS}
    assert c._on_submit_pool({"questions": qs[:3], "batch_index": 1, "is_final": False}).startswith("REVISION_ACCEPTED")
    assert "尚未定稿" in c._on_submit_qa(report)
    assert c._on_submit_pool({"questions": qs[3:], "batch_index": 2, "is_final": True}).startswith("REVISION_ACCEPTED")
    assert [q["id"] for q in ctx.artifacts["pool"]["questions"]] == [f"q{i}" for i in range(1,6)]
    assert c._on_submit_qa(report).startswith("SUBMIT_ACCEPTED")


def test_large_generated_file_cursor_preserves_all_questions(ctx_factory):
    from app.tools.registry import execute_tool
    ctx=ctx_factory()
    ctx.phase='VERIFY'
    ctx.workspace_dir.mkdir(parents=True)
    content=json.dumps({"questions":[{"id":f"q{i}","prompt":"公式与正文\n"*400} for i in range(32)]},ensure_ascii=False)
    path=ctx.workspace_dir/'question_pool.json'
    path.write_text(content)
    pieces=[];offset=0
    while True:
        text,_=execute_tool(ctx,'read_file',json.dumps({'path':f'workspace/{ctx.slug}/question_pool.json','offset':offset}))
        part=json.loads(text)
        pieces.append(part['content'])
        if not part['has_more']:break
        assert part['next_offset']>offset
        offset=part['next_offset']
    assert len(pieces)>1 and ''.join(pieces)==content
    assert len(json.loads(''.join(pieces))['questions'])==32


def test_full_chapter_title_beats_shorter_subsection(tmp_path):
    from pypdf import PdfWriter
    from app.tools.document_tools import _bookmark_range
    path=tmp_path/'chapter.pdf'
    writer=PdfWriter()
    for _ in range(12):writer.add_blank_page(width=600,height=800)
    chapter=writer.add_outline_item('第七章 多元函数微分学',0)
    writer.add_outline_item('多元函数',1,parent=chapter)
    writer.add_outline_item('多元函数的极限',3,parent=chapter)
    writer.add_outline_item('第八章 多元函数积分学',10)
    with path.open('wb') as stream:writer.write(stream)
    found=_bookmark_range(path,'多元函数微分学',12)
    assert found['start_page']==1 and found['end_page']==10
    assert found['title']=='第七章 多元函数微分学'


def test_legacy_published_toc_is_retracted_in_payload(ctx_factory):
    ctx = ctx_factory("多元函数微分学")
    old = FIXTURE["multivariable"]
    ctx.workspace_dir.mkdir(parents=True)
    for filename, key in [("state", "state"), ("review", "review"), ("chapter_context", "chapter_context"),
                          ("learning_plan", "learning_plan"), ("question_pool", "question_pool"), ("verification", "verification")]:
        (ctx.workspace_dir / (filename + ".json")).write_text(json.dumps(old[key]))
    r = runs.result_payload(ctx.project, ctx.slug)
    assert r["status"] == "NEEDS_REVIEW" and r["review"]["status"] == "needs_review"
    assert r["question_counts"]["visible_to_student"] == 0
    assert not runs.is_complete(ctx.project, ctx.slug)
    assert teacher.set_review(ctx.project, ctx.slug, "published", teacher_confirmed=True)["blocked"]
    spec = importlib.util.spec_from_file_location("migration", Path(__file__).parents[1] / "scripts/migrate-quality.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = module.migrate(ctx.project_dir.parent if hasattr(ctx, "project_dir") else ctx.input_dir.parents[1], apply=True)
    assert result["backup"] and Path(result["backup"]).exists()
    assert json.loads((ctx.workspace_dir / "state.json").read_text())["status"] == "NEEDS_REVIEW"
    assert module.migrate(ctx.input_dir.parents[1], apply=True)["changes"] == []
