"""复核边界：阅读证据、工具权限、缓存竞争、生成结果完整性。模型使用 Mock。"""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.agent import schemas
from app.agent.controller import AnalysisController
from app.parsers import ocr
from app.tools.base import ToolError
from app.tools.document_tools import read_pages
from app.tools.file_tools import list_files
from app.tools.registry import execute_tool
from app.tools.workspace_tools import read_file, write_file


@pytest.fixture(autouse=True)
def isolate_active_workers(monkeypatch):
    from app.store import runs
    monkeypatch.setattr(runs, '_active', {})


def test_offset_cannot_claim_unreturned_pages_as_read(ctx_factory):
    ctx = ctx_factory()
    result = read_pages(ctx, {"file": "sample.md", "start_page": 1, "end_page": 2, "offset": 10**9})
    assert not result["pages_fully_read"]
    assert ctx.coverage_of("sample.md", 1, 2)["read"] == 0


def test_reading_only_suffix_does_not_cover_skipped_prefix(ctx_factory, monkeypatch):
    from app import config
    monkeypatch.setattr(config, "READ_CHUNK_CHARS", 50)
    ctx = ctx_factory()
    result = read_pages(ctx, {"file": "sample.md", "start_page": 1, "end_page": 1, "offset": 1000})
    offset = result["next_offset"]
    while result["has_more"]:
        result = read_pages(ctx, {"file": "sample.md", "start_page": 1, "end_page": 1, "offset": offset})
        offset = result["next_offset"]
    assert ctx.coverage_of("sample.md", 1, 1)["read"] == 0


def test_agent_file_listing_respects_selected_scope(ctx_factory):
    ctx = ctx_factory()
    ctx.allowed_files = ["notes.txt"]
    assert [item["file"] for item in list_files(ctx, {})["files"]] == ["notes.txt"]


def test_tool_not_available_in_phase_cannot_bypass_schema(ctx_factory):
    ctx = ctx_factory()
    ctx.phase = "LOCATE"
    called = []
    ctx.submit_callback = lambda *args: called.append(args) or 'SUBMIT_ACCEPTED'
    text, _ = execute_tool(ctx, "submit_verification", '{"re_solved":true,"issues":[],"overall_pass":true}')
    assert text.startswith("TOOL_ERROR") and not called
    text, _ = execute_tool(ctx, "write_file", '{"path":"workspace/第一章/state.json","content":"{}"}')
    assert text.startswith("TOOL_ERROR")
    assert not (ctx.workspace_dir / "state.json").exists()


def test_workspace_prefix_sibling_is_not_an_allowed_directory(ctx_factory):
    ctx = ctx_factory()
    sibling = ctx.project_dir / "workspace-private"
    sibling.mkdir()
    (sibling / "private.txt").write_text("Private material")
    with pytest.raises(ToolError):
        read_file(ctx, {"path": "workspace-private/private.txt"})
    with pytest.raises(ToolError):
        write_file(ctx, {"path": "workspace-private/new.txt", "content": "Bad"})


def test_agent_cannot_read_other_chapter_or_student_report(ctx_factory):
    ctx = ctx_factory()
    for relative in ("workspace/other/plan.json", f"workspace/{ctx.slug}/learning_reports/report.json"):
        path = ctx.project_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"student":"private"}')
        with pytest.raises(ToolError):
            read_file(ctx, {"path": relative})


def test_ocr_concurrent_instances_merge_pages_without_temp_collision(tmp_path):
    caches = [ocr.OcrPageCache(tmp_path, "shared") for _ in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda page: caches[page % 8].put(page, 300, "eng", f"Body {page}", 99), range(32)))
    final = ocr.OcrPageCache(tmp_path, "shared")
    assert final.size == 32
    assert all(final.get(page, 300, "eng")["text"] == f"Body {page}" for page in range(32))


def test_ocr_fingerprint_detects_different_body_after_identical_prefix(tmp_path):
    first, second = tmp_path / "first.pdf", tmp_path / "second.pdf"
    prefix = b"X" * 65536
    first.write_bytes(prefix + b"A" * 1024)
    second.write_bytes(prefix + b"B" * 1024)
    assert ocr._file_hash(first) != ocr._file_hash(second)


@pytest.mark.parametrize("bad", [None, True, [], {}])
def test_structured_context_rejects_nontext_definition_fields(bad):
    value = {"chapter": "c", "source_files": ["book.md"], "core_concepts": ["a", "b"],
        "definitions": [{"term": "term", "content": bad, "source_file": "book.md", "source_page": 1}],
        "theorems": [], "source_references": [{"file": "book.md", "page": 1}]}
    assert schemas.validate_chapter_context(value)


def test_string_lists_reject_invalid_items_instead_of_silently_filtering():
    from test_schemas import valid_context
    context = valid_context()
    context["core_concepts"] = ["Valid concept", {"bad": 1}]
    assert schemas.validate_chapter_context(context)


def test_verification_cannot_claim_more_or_fewer_questions_than_pool(ctx_factory, monkeypatch):
    from app import config
    monkeypatch.setattr(config, "DEEPSEEK_API_KEY", "mock-only")
    ctx = ctx_factory()
    controller = AnalysisController(ctx.project, ctx.target)
    controller.ctx = ctx
    ctx.artifacts["pool"] = {"questions": [{"id": "q1"}, {"id": "q2"}]}
    result = controller._on_submit_verify({"re_solved": True, "verified_count": 1,
        "issues": [], "overall_pass": True})
    assert result.startswith("SUBMIT_REJECTED")


def test_fragmented_reading_persists_and_only_finishes_after_gap_is_filled(ctx_factory, monkeypatch):
    from app import config
    from app.agent.state_machine import load_state
    monkeypatch.setattr(config, "READ_CHUNK_CHARS", 100)
    monkeypatch.setattr(config, "DEEPSEEK_API_KEY", "mock-only")
    ctx = ctx_factory()
    read_pages(ctx, {"file": "sample.md", "start_page": 1, "end_page": 1, "offset": 0})
    controller = AnalysisController(ctx.project, ctx.target)
    controller._restore_from(load_state(ctx))
    restored = controller.ctx
    assert restored.read_fragments == ctx.read_fragments
    offset = 200
    while True:
        result = read_pages(restored, {"file": "sample.md", "start_page": 1, "end_page": 1, "offset": offset})
        if not result["has_more"]:
            break
        offset = result["next_offset"]
    assert restored.coverage_of("sample.md", 1, 1)["read"] == 0
    read_pages(restored, {"file": "sample.md", "start_page": 1, "end_page": 1, "offset": 100})
    assert restored.coverage_of("sample.md", 1, 1)["read"] == 1


def test_invalid_payloads_return_validation_errors_instead_of_raising():
    from test_schemas import valid_context
    from copy import deepcopy
    values = [None, False, True, 0, 1.5, "", "text", [], [1], {}, {"x": 1}]
    for key in ("chapter", "source_files", "core_concepts", "definitions", "theorems", "source_references"):
        for value in values:
            candidate = deepcopy(valid_context())
            candidate[key] = value
            assert isinstance(schemas.validate_chapter_context(candidate), list)
    question = {"id": "q1", "type": "single_choice", "difficulty": 1, "stage_index": 1,
        "prompt": "p", "answer": "A", "explanation": "e", "options": ["one", "two"],
        "learning_objective": "g", "source_basis": ["book.md P1"]}
    for key in question:
        for value in values:
            candidate = dict(question, **{key: value})
            errors = []
            schemas.validate_question(candidate, 0, errors, set())
            assert isinstance(errors, list)


def test_memory_ocr_cache_is_invalidated_when_source_changes(tmp_path):
    from app.parsers import registry
    path = tmp_path / "book.pdf"
    path.write_bytes(b"old")
    registry.get_ocr_cache(str(path))[1] = "Old OCR page"
    path.write_bytes(b"different new source")
    assert registry.get_ocr_cache(str(path)) == {}


def test_chinese_teacher_password_is_handled_without_500(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    monkeypatch.setenv("TEACHER_PASSWORD", "教师口令测试")
    client = TestClient(app)
    assert client.post('/api/teacher/login', json={"password": "错误口令"}).status_code == 401
    assert client.post('/api/teacher/login', json={"password": "教师口令测试"}).status_code == 200


def test_blocked_review_can_be_approved_without_stuck_ui(tmp_path, monkeypatch):
    from app import config
    from app.store import teacher
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path)
    ws = tmp_path / "p/workspace/ch"
    ws.mkdir(parents=True)
    (ws / "review.json").write_text('{"status":"blocked"}')
    assert teacher.set_review("p", "ch", "approved")["status"] == "approved"
    assert teacher.set_review("p", "ch", "blocked")["status"] == "blocked"


def test_unfinished_analysis_cannot_be_published_by_override(tmp_path, monkeypatch):
    from app import config
    from app.store import teacher
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path)
    ws = tmp_path / "p/workspace/ch"
    ws.mkdir(parents=True)
    (ws / "state.json").write_text(json.dumps({"status": "FAILED", "quality": {
        "sourceAuditVersion": 1, "readableCoverage": 1, "contentStatus": "CONTENT_READY"}}))
    gate = teacher.quality_gate("p", "ch")
    assert gate["hard_blocked"]
    assert teacher.set_review("p", "ch", "published", teacher_confirmed=True)["blocked"]


def chapter_artifacts(ctx):
    from app.agent.context import atomic_write_json
    ctx.workspace_dir.mkdir(parents=True, exist_ok=True)
    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    pool = {"chapter": ctx.target, "questions": [{"id": f"q{i}", "type": "single_choice",
        "difficulty": 1, "stage_index": 1 if i < 3 else 2, "prompt": f"Question {i}",
        "answer": "A", "explanation": "Explanation", "options": ["One", "Two"],
        "learning_objective": "a" if i < 3 else "b", "source_basis": ["sample.md P1"]} for i in range(1, 6)]}
    values = {"state": {"target": ctx.target, "status": "COMPLETE", "quality": {
        "sourceAuditVersion": 1, "contentStatus": "CONTENT_READY", "readableCoverage": 1}},
        "chapter_context": {"chapter": ctx.target, "core_concepts": ["a", "b"],
            "definitions": [{"term": "a", "content": "Definition"}], "source_references": [{"file": "sample.md", "page": 1}]},
        "learning_plan": {"chapter": ctx.target, "learning_objectives": ["a", "b"],
            "learning_sequence": [{"stage": 1, "name": "One", "content": ["Content"]},
                                  {"stage": 2, "name": "Two", "content": ["Content"]}]},
        "question_pool": pool, "qa_report": {k: {"pass": True, "issues": [], "changes": []} for k in schemas.QA_KEYS},
        "verification": {"re_solved": True, "verified_count": 5, "issues": [], "overall_pass": True}}
    for name, value in values.items():
        atomic_write_json(ctx.workspace_dir / (name + '.json'), value)
    return pool


def test_preview_reports_are_not_counted_as_formal_student_reports(ctx_factory):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.store import teacher
    from urllib.parse import quote
    ctx = ctx_factory()
    chapter_artifacts(ctx)
    client = TestClient(app)
    path=f'/api/projects/{ctx.project}/runs/{quote(ctx.slug)}/learning-reports'
    body = {"data": {"learning": {"answered": 2, "correct": 1, "wrong": 1, "accuracy": 50}}}
    assert client.post(path, json=body).status_code == 409
    assert teacher.list_learning_reports(ctx.project, ctx.slug) == []
    teacher.set_review(ctx.project, ctx.slug, 'approved')
    assert teacher.set_review(ctx.project, ctx.slug, 'published')['status'] == 'published'
    assert client.post(path, json=body).status_code == 200
    assert len(teacher.list_learning_reports(ctx.project, ctx.slug)) == 1


@pytest.mark.parametrize('learning', [
    {'answered': 2, 'correct': 5, 'wrong': 0, 'accuracy': 100},
    {'answered': 2, 'correct': 1, 'wrong': 1, 'accuracy': 100},
    {'answered': 2.5, 'correct': 1.5, 'wrong': 1, 'accuracy': 60},
])
def test_inconsistent_report_statistics_are_rejected(learning):
    from app.store.teacher import _validate_report, TeacherValidationError
    with pytest.raises(TeacherValidationError):
        _validate_report({'learning': learning})


def test_teacher_edits_update_json_and_markdown_together(ctx_factory):
    from app.store import teacher
    ctx = ctx_factory()
    chapter_artifacts(ctx)
    (ctx.output_dir/'questions.md').write_text('Stale export')
    (ctx.output_dir/'learning_plan.md').write_text('Stale plan')
    teacher.update_question(ctx.project, ctx.slug, 'q1', {'prompt': 'Updated prompt'})
    assert 'Updated prompt' in (ctx.output_dir/'questions.md').read_text()
    assert 'Stale export' not in (ctx.output_dir/'questions.md').read_text()
    teacher.update_learning_plan(ctx.project, ctx.slug, {'learning_sequence': [{'name': 'Updated stage'}]})
    assert 'Updated stage' in (ctx.output_dir/'learning_plan.md').read_text()
    assert '教师修改后的版本' in (ctx.output_dir/'final_report.md').read_text()
    assert not list(ctx.output_dir.glob('*.tmp'))


def test_qa_partial_does_not_emit_all_passed_event(ctx_factory, monkeypatch):
    from app import config
    monkeypatch.setattr(config, 'DEEPSEEK_API_KEY', 'mock-only')
    ctx = ctx_factory()
    controller = AnalysisController(ctx.project, ctx.target)
    controller.ctx = ctx
    report = {k: {'pass': True, 'issues': [], 'changes': []} for k in schemas.QA_KEYS}
    report['curiosity'].update(partial=True, justification='部分适用')
    reply = controller._on_submit_qa(report)
    assert reply.startswith('SUBMIT_ACCEPTED') and '部分通过' in reply
    assert '检查通过' not in reply
    assert ctx.events[-1]['level'] == 'warning'
    assert '全部通过' not in ctx.events[-1]['message']


def test_context_cannot_invent_files_or_pages(ctx_factory, monkeypatch):
    from app import config
    from test_schemas import valid_context
    monkeypatch.setattr(config, 'DEEPSEEK_API_KEY', 'mock-only')
    ctx = ctx_factory()
    controller = AnalysisController(ctx.project, ctx.target)
    controller.ctx = ctx
    payload = valid_context()
    assert controller._on_submit_context(payload).startswith('SUBMIT_REJECTED')
    payload['source_files'] = ['sample.md']
    payload['definitions'][0].update(source_file='sample.md', source_page=99999)
    payload['source_references'] = [{'file':'sample.md','page':1}]
    assert controller._on_submit_context(payload).startswith('SUBMIT_REJECTED')


@pytest.mark.parametrize('name,field,value', [
    ('chapter_context', 'definitions', [{'term': 'a', 'content': {}}]),
    ('learning_plan', 'learning_sequence', [{'stage': 1, 'name': {}, 'content': ['Text']}]),
    ('question_pool', 'questions', [{'id': 'q1', 'prompt': {}}]),
    ('question_pool', 'questions', [{'id': 'q1'}, {'id': 'q1'}]),
    ('verification', 'issues', None),
])
def test_corrupt_nested_fields_are_not_returned_as_renderable_artifacts(ctx_factory, name, field, value):
    from app.store import runs
    from app.agent.context import atomic_write_json
    ctx = ctx_factory()
    chapter_artifacts(ctx)
    path = ctx.workspace_dir / (name + '.json')
    data = json.loads(path.read_text())
    data[field] = value
    atomic_write_json(path, data)
    payload = runs.result_payload(ctx.project, ctx.slug)
    assert payload[name] is None and payload['status'] == 'INCOMPLETE'


def test_corrupt_review_cannot_break_public_results_or_remain_published(ctx_factory):
    from app.store import runs, teacher
    ctx = ctx_factory()
    chapter_artifacts(ctx)
    (ctx.workspace_dir/'review.json').write_text('{"status":"published","tasks":{"bad":true}}')
    payload = runs.result_payload(ctx.project, ctx.slug)
    assert payload['review']['status'] == 'needs_review'
    assert payload['tasks'] == []
    assert teacher.set_review(ctx.project, ctx.slug, 'approved')['status'] == 'approved'


def test_nontext_log_messages_are_not_exposed_to_react(ctx_factory):
    from app.agent.context import read_event_tail
    ctx = ctx_factory()
    ctx.workspace_dir.mkdir(parents=True)
    path = ctx.workspace_dir/'events.jsonl'
    path.write_text('{"seq":1,"message":{"bad":true}}\n{"seq":2,"message":"Valid"}\n')
    assert [item['seq'] for item in read_event_tail(path)] == [2]
