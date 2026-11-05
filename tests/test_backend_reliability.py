"""后端试用回归：真实路由与磁盘操作，模型使用 Mock。"""
import asyncio
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app import config
from app.agent.context import atomic_write_json
from app.api import routes
from app.main import app
from app.parsers import registry as parser_registry
from app.services import deepseek
from app.store import projects, runs, teacher


@pytest.fixture()
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path)
    monkeypatch.setattr(config, "DEEPSEEK_API_KEY", "mock-key")
    monkeypatch.setattr(config, "DEEPSEEK_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("TEACHER_PASSWORD", "test-only-password")
    monkeypatch.setattr(routes, "_TEACHER_TOKENS", {})
    monkeypatch.setattr(runs, "_active", {})
    projects.create_project("p")
    ws = tmp_path / "p/workspace/ch"
    ws.mkdir()
    atomic_write_json(ws / "state.json", {"status": "COMPLETE", "target": "ch"})
    atomic_write_json(ws / "question_pool.json", {"questions": [
        {"id": "q1", "prompt": "Old question", "answer": "A"},
        {"id": "q2", "prompt": "Second question", "answer": "B"},
    ]})
    return TestClient(app), ws


def login(client):
    response = client.post("/api/teacher/login", json={"password": "test-only-password"})
    assert response.status_code == 200
    return {"X-Teacher-Token": response.json()["data"]["token"]}


def test_teacher_can_edit_questions_with_header_or_body_token(setup):
    client, ws = setup
    headers = login(client)
    path = "/api/projects/p/runs/ch/questions/q1"
    assert client.post(path, json={"patch": {"answer": "C"}}).status_code == 401
    response = client.post(path, headers=headers, json={"patch": {"answer": "C"}})
    assert response.status_code == 200
    assert json.loads((ws / "question_pool.json").read_text())["questions"][0]["answer"] == "C"
    response = client.post(path, json={"patch": {"answer": "D"},
                                      "teacher_token": headers["X-Teacher-Token"]})
    assert response.status_code == 200


def test_teacher_confirmation_reaches_quality_gate(setup, monkeypatch):
    client, ws = setup
    monkeypatch.setattr(teacher, "quality_gate", lambda *args: {
        "ok": False, "reasons": ["PARTIAL QA"], "hard_blocked": False,
    })
    path = "/api/projects/p/runs/ch/review"
    headers = login(client)
    assert client.post(path, headers=headers, json={"status": "published"}).status_code == 422
    response = client.post(path, headers=headers,
                           json={"status": "published", "teacher_confirmed": True})
    assert response.status_code == 200
    assert response.json()["data"]["teacher_override"]["reasons"] == ["PARTIAL QA"]
    monkeypatch.setattr(teacher, "quality_gate", lambda *args: {
        "ok": False, "reasons": ["TOC_ONLY"], "hard_blocked": True,
    })
    assert client.post(path, headers=headers,
                       json={"status": "published", "teacher_confirmed": True}).status_code == 422


@pytest.mark.parametrize("path,body", [
    ("review", {"status": "draft"}),
    ("teacher-note", {"note": "Changed"}),
    ("learning-plan", {"patch": {}}),
])
def test_teacher_mutations_require_login(setup, path, body):
    client, _ = setup
    assert client.post("/api/projects/p/runs/ch/" + path, json=body).status_code == 401


def test_disabled_and_expired_teacher_access_is_rejected(setup, monkeypatch):
    client, _ = setup
    headers = login(client)
    routes._TEACHER_TOKENS[headers["X-Teacher-Token"]] = time.time() - 12 * 3600 - 1
    path = "/api/projects/p/runs/ch/learning-reports"
    assert client.get(path, headers=headers).status_code == 401
    monkeypatch.delenv("TEACHER_PASSWORD")
    assert client.get(path).status_code == 503


def test_public_results_do_not_bypass_report_auth(setup):
    client, _ = setup
    teacher.save_learning_report("p", "ch", {"student": "private student"})
    assert client.get("/api/projects/p/runs/ch/result").json()["data"]["learning_reports"] == []
    assert client.get("/api/projects/p/runs/ch/learning-reports").status_code == 401
    response = client.get("/api/projects/p/runs/ch/learning-reports", headers=login(client))
    assert response.status_code == 200 and len(response.json()["data"]) == 1


def test_report_ids_do_not_collide_and_timestamp_is_server_owned(setup, monkeypatch):
    _, ws = setup
    monkeypatch.setattr(teacher.time, "time", lambda: 1234.5)
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda index: teacher.save_learning_report(
            "p", "ch", {"student": str(index), "submitted_at": 0}), range(16)))
    assert len({result["saved"] for result in results}) == 16
    assert len(list((ws / "learning_reports").glob("*.json"))) == 16
    assert all(json.loads(path.read_text())["submitted_at"] == 1234.5
               for path in (ws / "learning_reports").glob("*.json"))


def test_concurrent_json_writes_remain_complete(setup):
    _, ws = setup
    path = ws / "shared.json"
    with ThreadPoolExecutor(max_workers=12) as executor:
        list(executor.map(lambda index: atomic_write_json(path, {"value": index, "data": "X" * 10000}), range(48)))
    assert json.loads(path.read_text())["data"] == "X" * 10000
    assert not list(ws.glob("*.tmp"))


def test_concurrent_teacher_tasks_are_not_lost(setup, monkeypatch):
    original = teacher.read_review
    def slow_read(*args):
        result = original(*args)
        time.sleep(0.002)
        return result
    monkeypatch.setattr(teacher, "read_review", slow_read)
    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(lambda index: teacher.add_teacher_task("p", "ch", str(index)), range(16)))
    assert len(teacher.read_review("p", "ch")["tasks"]) == 16


def test_upload_size_empty_and_duplicate_protection(setup, monkeypatch):
    client, ws = setup
    monkeypatch.setattr(config, "MAX_UPLOAD_BYTES", 16)
    path = "/api/projects/p/files"
    assert client.post(path, files={"file": ("book.md", b"X" * 17)}).status_code == 413
    assert client.post(path, files={"file": ("book.md", b"")}).status_code == 400
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda text: client.post(path, files={"file": ("book.md", text)}),
                                      [b"First version", b"Other version"]))
    assert sorted(response.status_code for response in responses) == [200, 400]
    assert (ws.parents[1] / "input/book.md").read_bytes() in (b"First version", b"Other version")


def test_slow_upload_does_not_block_health(setup, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    def slow_save(*args):
        entered.set()
        release.wait(3)
        return {"name": "book.md"}
    monkeypatch.setattr(projects, "save_upload", slow_save)
    async def probe():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            upload = asyncio.create_task(client.post("/api/projects/p/files", files={"file": ("book.md", b"body")}))
            try:
                assert await asyncio.to_thread(entered.wait, 1)
                response = await asyncio.wait_for(client.get("/api/health"), 0.5)
                assert response.status_code == 200
                assert not upload.done()
            finally:
                release.set()
                await upload
    asyncio.run(probe())


@pytest.mark.parametrize("files", [[], ["../workspace/ch/state.json"], ["book.md", "book.md"]])
def test_invalid_input_scope_rejected_before_model_call(setup, files):
    client, ws = setup
    (ws.parents[1] / "input/book.md").write_text("# First chapter\n" + "Content " * 20)
    response = client.post("/api/projects/p/analyze", json={"target": "ch", "files": files})
    assert response.status_code == 400
    assert not runs._active


def test_missing_model_key_has_helpful_service_error(setup, monkeypatch):
    client, ws = setup
    (ws.parents[1] / "input/book.md").write_text("Textbook")
    monkeypatch.setattr(config, "DEEPSEEK_API_KEY", "")
    response = client.post("/api/projects/p/analyze", json={"target": "new chapter"})
    assert response.status_code == 503
    assert not runs._active


def test_capacity_limit_does_not_start_more_workers(setup, monkeypatch):
    client, ws = setup
    (ws.parents[1] / "input/book.md").write_text("Textbook")
    monkeypatch.setattr(config, "MAX_CONCURRENT_RUNS", 1)
    runs._active["p/other"] = SimpleNamespace(ctx=SimpleNamespace(phase="READ"))
    response = client.post("/api/projects/p/analyze", json={"target": "new chapter"})
    assert response.status_code == 429 and response.headers["retry-after"] == "10"
    assert list(runs._active) == ["p/other"]


def test_finished_workers_are_released_even_on_failure(setup):
    controller = SimpleNamespace(run=lambda: None)
    runs._active["p/ch"] = controller
    runs._run_controller("p/ch", controller)
    assert not runs._active
    def fail():
        raise OSError("Disk unavailable")
    controller.run = fail
    runs._active["p/ch"] = controller
    with pytest.raises(OSError):
        runs._run_controller("p/ch", controller)
    assert not runs._active


def test_interrupted_run_explains_resume_and_event_tail_is_bounded(setup):
    client, ws = setup
    atomic_write_json(ws / "state.json", {"status": "READ"})
    (ws / "events.jsonl").write_text("\n".join(json.dumps({"seq": i}) for i in range(1, 501)))
    result = client.get("/api/projects/p/runs/ch/status").json()["data"]
    assert result["interrupted"] and not result["running"]
    assert "继续" in result["error"]
    assert len(result["events"]) == 400 and result["events_total"] == 500


def test_cancel_stops_model_retry_immediately(monkeypatch):
    event = threading.Event()
    client = deepseek.DeepSeekClient(api_key="mock-key")
    client.cancel_event = event
    def fail(payload):
        event.set()
        raise deepseek.DeepSeekError("Transient", status=500)
    monkeypatch.setattr(client, "_request_once", fail)
    started = time.monotonic()
    with pytest.raises(deepseek.DeepSeekCancelled):
        client.chat([])
    assert time.monotonic() - started < 0.5


def test_retry_does_not_wait_after_final_attempt(monkeypatch):
    monkeypatch.setattr(config, "API_MAX_RETRIES", 2)
    waits = []
    monkeypatch.setattr(deepseek.time, "sleep", waits.append)
    client = deepseek.DeepSeekClient(api_key="mock-key")
    def fail(payload):
        raise deepseek.DeepSeekError("Transient", status=500)
    monkeypatch.setattr(client, "_request_once", fail)
    with pytest.raises(deepseek.DeepSeekError):
        client.chat([])
    assert waits == [1.5]


@pytest.mark.parametrize("payload", [[], {"choices": {}}, {"choices": [{}]},
    {"choices": [{"message": {"content": []}}]}])
def test_malformed_model_response_is_retryable(monkeypatch, payload):
    original = httpx.Client
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    monkeypatch.setattr(deepseek.httpx, "Client", lambda **kwargs: original(transport=transport, **kwargs))
    client = deepseek.DeepSeekClient(api_key="mock-key")
    with pytest.raises(deepseek.DeepSeekError) as error:
        client._request_once({})
    assert not error.value.fatal


def test_provider_error_never_echoes_key(monkeypatch):
    original = httpx.Client
    transport = httpx.MockTransport(lambda request: httpx.Response(403, json={
        "error": "Rejected credential mock-secret-key",
    }))
    monkeypatch.setattr(deepseek.httpx, "Client", lambda **kwargs: original(transport=transport, **kwargs))
    with pytest.raises(deepseek.DeepSeekError) as error:
        deepseek.DeepSeekClient(api_key="mock-secret-key")._request_once({})
    assert "mock-secret-key" not in str(error.value)


def test_scope_and_file_versions_invalidate_cached_analysis(setup, monkeypatch):
    _, ws = setup
    inputs = ws.parents[1] / "input"
    (inputs / "book.md").write_text("Original textbook")
    (inputs / "other.md").write_text("Different textbook")
    stat = (inputs / "book.md").stat()
    state = {"status": "COMPLETE", "allowed_files": ["book.md"],
             "source_versions": {"book.md": [stat.st_mtime_ns, stat.st_size]}}
    atomic_write_json(ws / "state.json", state)
    monkeypatch.setattr(runs, "is_complete", lambda *args: True)
    monkeypatch.setattr(threading.Thread, "start", lambda self: None)
    assert runs.start_run("p", "ch", allowed_files=["book.md"])["action"] == "cached"
    result = runs.start_run("p", "ch", allowed_files=["other.md"])
    assert result["action"] == "started" and runs._active["p/ch"].force
    runs._active.clear()
    (inputs / "book.md").write_text("Updated textbook contents")
    assert runs.start_run("p", "ch", allowed_files=["book.md"])["action"] == "started"
    assert runs._active["p/ch"].force


def test_resume_action_comes_from_checkpoint_not_thread_timing(setup, monkeypatch):
    _, ws = setup
    atomic_write_json(ws / "state.json", {"status": "READ"})
    monkeypatch.setattr(threading.Thread, "start", lambda self: None)
    assert runs.start_run("p", "ch")["action"] == "resumed"
    assert runs._active["p/ch"].ctx.messages == []


def test_corrupt_artifact_is_incomplete_and_cannot_be_published(setup):
    client, ws = setup
    atomic_write_json(ws / "state.json", {"status": "COMPLETE", "quality": {
        "sourceAuditVersion": 1, "contentStatus": "CONTENT_READY", "readableCoverage": 1,
    }})
    (ws / "learning_plan.json").write_bytes(b"\xff")
    response = client.get("/api/projects/p/runs/ch/result")
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "INCOMPLETE"
    response = client.post("/api/projects/p/runs/ch/review", headers=login(client),
                           json={"status": "published", "teacher_confirmed": True})
    assert response.status_code == 422


def test_corrupt_event_lines_do_not_crash_status(setup):
    client, ws = setup
    (ws / "events.jsonl").write_text('null\n[]\n{"bad":1}\nnot-json\n{"seq":42}\n')
    response = client.get("/api/projects/p/runs/ch/status")
    assert response.status_code == 200
    assert response.json()["data"]["events_total"] == 42


def test_teacher_edit_withdraws_previous_publication_and_records_history(setup):
    client, ws = setup
    atomic_write_json(ws / "review.json", {"status": "published", "teacher_override": {"old": True}})
    response = client.post("/api/projects/p/runs/ch/questions/q1", headers=login(client),
                           json={"patch": {"answer": "Corrected answer"}})
    assert response.status_code == 200
    review = teacher.read_review("p", "ch")
    assert review["status"] == "needs_review"
    assert review["edited_at"] and review["history"][-1]["note"]
    assert "teacher_override" not in review


@pytest.mark.parametrize("patch", [{"prompt": ""}, {"options": [1]},
    {"difficulty": True}, {"difficulty": 7}, {"stage_index": -1}])
def test_invalid_teacher_patch_does_not_corrupt_question_pool(setup, patch):
    client, ws = setup
    before = (ws / "question_pool.json").read_bytes()
    response = client.post("/api/projects/p/runs/ch/questions/q1", headers=login(client), json={"patch": patch})
    assert response.status_code == 422
    assert (ws / "question_pool.json").read_bytes() == before


def test_teacher_cannot_edit_while_generation_is_running(setup):
    client, ws = setup
    runs._active["p/ch"] = SimpleNamespace(ctx=SimpleNamespace(phase="GENERATE"))
    response = client.post("/api/projects/p/runs/ch/questions/q1", headers=login(client),
                           json={"patch": {"answer": "Race"}})
    assert response.status_code == 409
    assert json.loads((ws / "question_pool.json").read_text())["questions"][0]["answer"] == "A"


def test_finishing_run_cannot_be_replaced_before_final_save(setup):
    runs._active["p/ch"] = SimpleNamespace(ctx=SimpleNamespace(phase="COMPLETE"))
    with pytest.raises(runs.RunConflict):
        runs.start_run("p", "ch", force=True)


def test_concurrent_requests_parse_large_document_only_once(setup, monkeypatch):
    _, ws = setup
    path = ws.parents[1] / "input/book.md"
    path.write_text("Sample document")
    monkeypatch.setattr(parser_registry, "_cache", {})
    calls = []
    document = object()
    def parse(path):
        calls.append(path)
        time.sleep(0.02)
        return document
    monkeypatch.setattr(parser_registry, "parse_file", parse)
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: parser_registry.get_document(path), range(8)))
    assert len(calls) == 1 and all(result is document for result in results)
    path.write_text("Updated source document")
    parser_registry.get_document(path)
    assert len(calls) == 2


def test_recovery_keeps_checkpoint_phase_and_completes_pending_tool_reply(setup):
    from app.agent.context import RunContext
    from app.agent.controller import AnalysisController
    _, ws = setup
    atomic_write_json(ws / "messages.json", {"phase": "LOCATE", "messages": [
        {"role": "assistant", "reasoning_content": "Preserve this reasoning", "tool_calls": [
            {"id": "pending-1", "function": {"name": "read_pages", "arguments": "{}"}}]},
    ]})
    controller = AnalysisController("p", "ch")
    controller._restore_from({"status": "READ", "coverage": {"book.md": [[1, 2]]}})
    assert controller.ctx.phase == "READ"
    assert controller.ctx.coverage_of("book.md", 1, 3)["read"] == 2
    assert controller.ctx.messages[0]["reasoning_content"] == "Preserve this reasoning"
    assert controller.ctx.messages[-1]["tool_call_id"] == "pending-1"
    assert controller.ctx.messages[-1]["role"] == "tool"


@pytest.mark.parametrize("payload", [[], {"messages": [1]}, {"messages": None}])
def test_damaged_message_history_is_ignored(setup, payload):
    from app.agent.context import RunContext
    _, ws = setup
    atomic_write_json(ws / "messages.json", payload)
    context = RunContext("p", "ch", "ch", threading.Event())
    context.phase = "READ"
    assert not context.load_messages()
    assert context.phase == "READ" and not context.messages


def test_read_progress_survives_crash_before_phase_submission(setup):
    from app.agent.context import RunContext
    from app.agent.state_machine import load_state
    context = RunContext("p", "ch", "ch", threading.Event())
    context.phase = "READ"
    context.mark_read("book.md", 2, 4)
    assert load_state(context)["coverage"] == {"book.md": [[2, 4]]}


def test_cancelled_run_preserves_resume_checkpoint(setup, monkeypatch):
    from app.agent.controller import AnalysisController
    from app.agent.loop import RunCancelled
    controller = AnalysisController("p", "ch")
    def cancel():
        controller.ctx.phase = "READ"
        raise RunCancelled()
    monkeypatch.setattr(controller, "_pipeline", cancel)
    controller.run()
    assert runs.read_state("p", "ch")["resume_phase"] == "READ"
    monkeypatch.setattr(threading.Thread, "start", lambda self: None)
    assert runs.start_run("p", "ch")["action"] == "resumed"


def test_force_rerun_removes_stale_exported_markdown(setup):
    from app.agent.controller import AnalysisController
    _, ws = setup
    output = ws.parents[1] / "output/ch"
    output.mkdir()
    (output / "questions.md").write_text("Old answers")
    AnalysisController("p", "ch", force=True)._clean_workspace()
    assert not (output / "questions.md").exists()


def test_finishing_workers_still_count_toward_capacity(setup, monkeypatch):
    monkeypatch.setattr(config, "MAX_CONCURRENT_RUNS", 1)
    runs._active["p/other"] = SimpleNamespace(ctx=SimpleNamespace(phase="COMPLETE"))
    with pytest.raises(runs.RunCapacityError):
        runs.start_run("p", "new", force=True)


def test_slug_collision_cannot_return_or_overwrite_another_chapter(setup):
    _, ws = setup
    atomic_write_json(ws / "state.json", {"target": "c/h", "status": "COMPLETE"})
    with pytest.raises(runs.TargetCollision):
        runs.start_run("p", "ch", force=True)
    assert runs.read_state("p", "ch")["target"] == "c/h"


def test_teacher_store_rechecks_run_lock_after_route_validation(setup):
    client, ws = setup
    before = (ws / "question_pool.json").read_bytes()
    runs._active["p/ch"] = SimpleNamespace(ctx=SimpleNamespace(phase="COMPLETE"))
    with pytest.raises(teacher.TeacherBusyError):
        teacher.update_question("p", "ch", "q1", {"answer": "Race"})
    response = client.post("/api/projects/p/runs/ch/teacher-note", headers=login(client),
                           json={"task": "During final save"})
    assert response.status_code == 409
    assert (ws / "question_pool.json").read_bytes() == before


@pytest.mark.parametrize("report", [{"learning": "bad"}, {"game": [1]},
    {"learning": {"wrongQuestions": [None]}}, {"learning": {"mastery": [1]}},
    {"learning": {"answered": "many"}}, {"learning": {"accuracy": 101}},
    {"learning": {"wrongQuestions": [{"prompt": 5}]}}, {"submitted_at": "bad"}])
def test_bad_learning_report_is_rejected_without_poisoning_teacher_dashboard(setup, report):
    client, ws = setup
    path = "/api/projects/p/runs/ch/learning-reports"
    assert client.post(path, json={"data": report}).status_code == 422
    assert not list((ws / "learning_reports").glob("*.json"))
    # 旧目录中已有同类坏记录时，不应妨碍其他有效记录展示。
    folder = ws / "learning_reports"
    folder.mkdir(exist_ok=True)
    atomic_write_json(folder / "report-corrupt.json", report)
    teacher.save_learning_report("p", "ch", {"learning": {"answered": 1}})
    response = client.get(path, headers=login(client))
    assert response.status_code == 200
    assert len(response.json()["data"]) == 1


@pytest.mark.parametrize("patch", [{}, {"learning_objectives": [1]},
    {"learning_objectives": []}, {"learning_sequence": [None]},
    {"learning_sequence": [{"name": ""}]}, {"learning_sequence": [{"content": [1]}]}])
def test_bad_plan_edit_preserves_file_and_publication(setup, patch):
    client, ws = setup
    atomic_write_json(ws / "learning_plan.json", {"learning_objectives": ["One"],
        "learning_sequence": [{"stage": 1, "name": "Intro", "content": ["Content"]}]})
    atomic_write_json(ws / "review.json", {"status": "published"})
    before = (ws / "learning_plan.json").read_bytes()
    response = client.post("/api/projects/p/runs/ch/learning-plan", headers=login(client), json={"patch": patch})
    assert response.status_code == 422
    assert (ws / "learning_plan.json").read_bytes() == before
    assert teacher.read_review("p", "ch")["status"] == "published"


@pytest.mark.parametrize("name,data", [("question_pool", {"questions": None}),
    ("question_pool", {"questions": [1]}), ("learning_plan", {"learning_sequence": [None]}),
    ("chapter_context", {"definitions": ["bad"]}), ("verification", {"issues": [1]})])
def test_malformed_artifact_does_not_break_result_or_allow_publication(setup, name, data):
    client, ws = setup
    atomic_write_json(ws / "state.json", {"status": "COMPLETE", "quality": {
        "sourceAuditVersion": 1, "contentStatus": "CONTENT_READY", "readableCoverage": 1,
    }})
    atomic_write_json(ws / (name + ".json"), data)
    response = client.get("/api/projects/p/runs/ch/result")
    assert response.status_code == 200 and response.json()["data"]["status"] == "INCOMPLETE"
    response = client.post("/api/projects/p/runs/ch/review", headers=login(client),
                           json={"status": "published", "teacher_confirmed": True})
    assert response.status_code == 422


def test_log_tail_handles_large_utf8_history_and_memory_is_bounded(setup):
    from app.agent.context import RunContext, read_event_tail
    _, ws = setup
    path = ws / "events.jsonl"
    path.write_text("\n".join(json.dumps({"seq": i, "message": "正文日志" * 10}, ensure_ascii=False)
                              for i in range(1, 12001)) + "\n")
    events = read_event_tail(path)
    assert len(events) == 400 and events[0]["seq"] == 11601 and events[-1]["seq"] == 12000
    context = RunContext("p", "ch", "ch", threading.Event())
    for i in range(420):
        context.emit(str(i))
    assert len(context.events) == 400 and context.events[0]["seq"] == 21 and context.event_seq == 420


def test_upload_is_invisible_until_complete_and_temporary_files_are_hidden(setup, monkeypatch):
    _, ws = setup
    inputs = ws.parents[1] / "input"
    (inputs / ".upload-in-progress.tmp").write_text("Partial")
    original = projects.os.link
    checked = []
    def inspect(source, destination):
        assert not destination.exists()
        assert Path(source).read_bytes() == b"Complete textbook"
        assert projects.list_files("p") == []
        checked.append(True)
        original(source, destination)
    monkeypatch.setattr(projects.os, "link", inspect)
    projects.save_upload("p", "book.md", b"Complete textbook")
    assert checked and (inputs / "book.md").read_bytes() == b"Complete textbook"
    assert len(list(inputs.glob(".upload-*.tmp"))) == 1


def test_upload_capacity_limit_does_not_block_health(setup, monkeypatch):
    client, _ = setup
    slots = threading.BoundedSemaphore(1)
    slots.acquire()
    monkeypatch.setattr(routes, "_UPLOAD_SLOTS", slots)
    response = client.post("/api/projects/p/files", files={"file": ("book.md", b"text")})
    assert response.status_code == 429 and response.headers["retry-after"] == "5"
    assert client.get("/api/health").status_code == 200
    slots.release()


def test_document_cache_is_bounded_and_evicted_files_can_be_reparsed(setup, monkeypatch):
    _, ws = setup
    monkeypatch.setattr(parser_registry, "_cache", {})
    monkeypatch.setattr(parser_registry, "_MAX_DOCUMENTS", 2)
    paths = [ws.parents[1] / "input" / f"book-{i}.md" for i in range(3)]
    for path in paths:
        path.write_text("Sample textbook")
        parser_registry.get_document(path)
    assert len(parser_registry._cache) == 2
    assert str(paths[0].resolve()) not in parser_registry._cache
    assert parser_registry.get_document(paths[0]).total_pages == 1


def test_provider_retry_after_is_respected_and_status_survives_exhaustion(monkeypatch):
    original = httpx.Client
    transport = httpx.MockTransport(lambda request: httpx.Response(429, headers={"Retry-After": "12"}))
    monkeypatch.setattr(deepseek.httpx, "Client", lambda **kwargs: original(transport=transport, **kwargs))
    monkeypatch.setattr(config, "API_MAX_RETRIES", 2)
    waits = []
    monkeypatch.setattr(deepseek.time, "sleep", waits.append)
    with pytest.raises(deepseek.DeepSeekError) as error:
        deepseek.DeepSeekClient(api_key="mock-key").chat([])
    assert waits == [12.0] and error.value.status == 429


@pytest.mark.parametrize("calls", [[None], [{"id": "1", "function": []}],
    [{"id": "1", "function": {"name": "list_files", "arguments": {}}}]])
def test_malformed_tool_response_is_retryable(monkeypatch, calls):
    original = httpx.Client
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        "choices": [{"message": {"tool_calls": calls}}],
    }))
    monkeypatch.setattr(deepseek.httpx, "Client", lambda **kwargs: original(transport=transport, **kwargs))
    with pytest.raises(deepseek.DeepSeekError) as error:
        deepseek.DeepSeekClient(api_key="mock-key")._request_once({})
    assert not error.value.fatal


def test_review_cannot_create_ghost_chapter(setup):
    client, ws = setup
    response = client.post("/api/projects/p/runs/missing/review", headers=login(client), json={"status": "draft"})
    assert response.status_code == 404
    assert not (ws.parent / "missing").exists()


def test_oversized_raw_log_uses_status_tail_instead(setup):
    client, ws = setup
    (ws / "events.jsonl").write_text("X" * (8 * 1024 * 1024 + 1))
    response = client.get("/api/projects/p/runs/ch/files/events.jsonl")
    assert response.status_code == 413


def test_committed_question_batch_is_not_generated_again_after_restart(setup, monkeypatch):
    from app.agent.controller import AnalysisController
    from app.agent.loop import PhaseError
    _, ws = setup
    atomic_write_json(ws / "state.json", {"status": "GENERATE", "target": "ch",
        "flags": {"questions_complete": True}, "quality": {
            "sourceAuditVersion": 1, "contentStatus": "CONTENT_READY", "readableCoverage": 1,
        }})
    phases = []
    controller = AnalysisController("p", "ch")
    def probe(phase, *args):
        phases.append(phase)
        raise PhaseError("End of checkpoint probe")
    monkeypatch.setattr(controller, "_start_llm_phase", probe)
    with pytest.raises(PhaseError, match="checkpoint probe"):
        controller._pipeline()
    assert phases == ["PSYCHOLOGY_CHECK"]
    assert len(json.loads((ws / "question_pool.json").read_text())["questions"]) == 2
