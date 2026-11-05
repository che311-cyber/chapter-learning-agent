"""用规则式 mock LLM 服务器做完整 Agent Loop / 状态机 / 持久化 / 异常测试。"""
import json
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.agent.context import slugify
from app.agent.controller import AnalysisController
from app.agent.state_machine import PHASES, load_state, save_state
from app.services.deepseek import DeepSeekClient, DeepSeekError


def run_sync(controller, timeout=120):
    t = threading.Thread(target=controller.run, daemon=True)
    t.start()
    t.join(timeout)
    assert not t.is_alive(), "运行超时（可能存在死循环）"
    return controller


def test_full_pipeline_with_mock_llm(ctx_factory, mock_llm):
    """端到端（mock LLM）：LOCATE→…→VERIFY→SAVE→COMPLETE，全部产物落盘。"""
    ctx = ctx_factory()
    c = AnalysisController(ctx.project, ctx.target)
    c.client = DeepSeekClient()
    run_sync(c)

    assert c.ctx.phase == "COMPLETE", c.ctx.error
    state = load_state(ctx)
    assert state["status"] == "COMPLETE"
    assert all(state["flags"].values())

    ws = ctx.workspace_dir
    for name in ["state.json", "chapter_context.json", "learning_plan.json",
                 "question_pool.json", "qa_report.json", "verification.json",
                 "messages.json", "events.jsonl"]:
        assert (ws / name).exists(), f"缺少 {name}"

    out = ctx.output_dir
    for name in ["learning_plan.md", "questions.md", "final_report.md"]:
        assert (out / name).exists(), f"缺少输出 {name}"

    pool = json.loads((ws / "question_pool.json").read_text())
    assert len(pool["questions"]) == 6  # 3+3 两批合并
    ids = [q["id"] for q in pool["questions"]]
    assert len(ids) == len(set(ids))

    # VERIFY 的 corrected_question 已替换原题
    q5 = next(q for q in pool["questions"] if q["id"] == "q5")
    assert "a∘b" in q5["prompt"]

    qa = json.loads((ws / "qa_report.json").read_text())
    from app.agent.schemas import qa_all_pass
    assert qa_all_pass(qa)

    # 事件流里应能看到的阶段性痕迹
    events = [json.loads(l) for l in
              (ws / "events.jsonl").read_text().splitlines()]
    levels = {e["level"] for e in events}
    assert "success" in levels


def test_locate_failure_clear_message(ctx_factory, mock_llm):
    """目标章节不存在 → 任务失败 + 人类可读错误（不是崩溃）。"""
    ctx = ctx_factory("第九章")
    c = AnalysisController(ctx.project, ctx.target)
    c.client = DeepSeekClient()
    run_sync(c)
    assert c.ctx.phase == "FAILED"
    assert "第九章" in (c.ctx.error or "")


def test_api_auth_error_is_fatal(ctx_factory, mock_llm):
    """401 → 明确的 Key 错误信息，任务失败而非挂死。"""
    ctx = ctx_factory()
    c = AnalysisController(ctx.project, ctx.target)
    calls = {"n": 0}

    class FailingClient(DeepSeekClient):
        def chat(self, *a, **k):
            calls["n"] += 1
            raise DeepSeekError("DeepSeek API Key 无效（401 Unauthorized）", fatal=True, status=401)

    c.client = FailingClient()
    run_sync(c)
    assert c.ctx.phase == "FAILED"
    assert "Key" in c.ctx.error
    assert c.ctx.events[-1]["level"] == "error"


def test_midrun_failure_and_resume(ctx_factory, mock_llm):
    """持续 500 → 保存断点；解除故障后续跑，不重新定位和丢弃已有进度。"""
    ctx = ctx_factory()
    mock_llm.fail_from = (3, 500)

    c1 = AnalysisController(ctx.project, ctx.target)
    c1.client = DeepSeekClient()
    run_sync(c1)
    assert c1.ctx.phase == "FAILED", c1.ctx.error
    st = load_state(ctx)
    assert st["status"] == "FAILED"
    assert st["resume_phase"] in PHASES[:-1]
    old_event_lines = (ctx.workspace_dir / "events.jsonl").read_text().splitlines()

    # 解除故障后复用已保存的定位/阅读与对话记录。
    mock_llm.fail_from = None
    c2 = AnalysisController(ctx.project, ctx.target, force=False)
    c2.client = DeepSeekClient()
    run_sync(c2)
    assert c2.ctx.phase == "COMPLETE", c2.ctx.error
    assert (ctx.output_dir / "final_report.md").exists()
    new_events = [json.loads(l) for l in
                  (ctx.workspace_dir / "events.jsonl").read_text().splitlines()]
    assert new_events[0]["seq"] == 1, "全新运行的事件 seq 应从 1 开始（旧事件已清理）"
    assert (ctx.workspace_dir / "events.jsonl").read_text().splitlines()[:len(old_event_lines)] == old_event_lines
    assert any("检测到未完成任务" in event["message"] for event in new_events)


def test_resume_from_mid_crash(ctx_factory, mock_llm):
    """真·断点续跑：进程崩溃在 GENERATE 阶段（state 停留在中间态）→ 新实例从该阶段继续至完成。"""
    from app.agent.context import atomic_write_json
    from app.agent.state_machine import save_state

    ctx = ctx_factory()
    ctx.phase = "GENERATE"
    ctx.flags.update({"source_located": True, "chapter_read_complete": True,
                      "understanding_complete": True, "design_complete": True})
    ctx.located = {"file": "sample.md", "heading": "第一章 群的定义与基本性质",
                   "start_page": 1, "end_page": 2}
    ctx.artifacts["context"] = {"chapter": "第一章", "source_files": ["sample.md"],
                                "core_concepts": ["群"], "definitions": [], "theorems": [],
                                "source_references": [{"file": "sample.md", "page": 1}]}
    ctx.artifacts["plan"] = {"chapter": "第一章",
                             "learning_objectives": ["能验证群公理", "能求逆元", "能应用消去律"],
                             "learning_sequence": [
                                 {"stage": 1, "name": "n", "goal": "g", "content": ["x"]},
                                 {"stage": 2, "name": "n2", "goal": "g2", "content": ["y"]},
                                 {"stage": 3, "name": "n3", "goal": "g3", "content": ["z"]}],
                             "mastery_criteria": ["m1", "m2"]}
    save_state(ctx)
    atomic_write_json(ctx.workspace_dir / "chapter_context.json", ctx.artifacts["context"])
    atomic_write_json(ctx.workspace_dir / "learning_plan.json", ctx.artifacts["plan"])
    ctx.event_seq = 40
    ctx.emit("已有阅读证据")

    c = AnalysisController(ctx.project, ctx.target, force=False)
    c.client = DeepSeekClient()
    run_sync(c)
    assert c.ctx.phase == "COMPLETE", c.ctx.error
    assert c.ctx.events[0]["seq"] == 41
    assert len({event["seq"] for event in c.ctx.events}) == len(c.ctx.events)
    events = [json.loads(l) for l in
              (ctx.workspace_dir / "events.jsonl").read_text().splitlines()]
    assert any("从阶段 GENERATE 继续" in e["message"] for e in events)
    # 断点前的阶段没有被重跑
    entered = [e["message"] for e in events if e["message"].startswith("进入阶段")]
    assert not any("TARGET" in m for m in entered)


def test_start_run_conflict_carries_run_id(ctx_factory, mock_llm):
    """同章节并发提交 → RunConflict 且携带 run_id（前端据此接上进度）。"""
    import time as _time

    from app.store import runs as run_store

    ctx = ctx_factory()
    mock_llm.delay = 0.5  # 拖慢 mock 让第一个 run 保持在运行态
    try:
        r1 = run_store.start_run(ctx.project, ctx.target, force=True)
        assert r1["action"] in ("started", "resumed")
        _time.sleep(0.3)
        try:
            run_store.start_run(ctx.project, ctx.target, force=True)
            raise AssertionError("应当抛出 RunConflict")
        except run_store.RunConflict as e:
            assert e.run_id == ctx.slug
    finally:
        mock_llm.delay = 0.0
        c = run_store.get_controller(ctx.project, ctx.slug)
        if c is not None:
            c.ctx.cancel_event.set()
            _time.sleep(2.0)


def test_retry_on_transient_500(ctx_factory, mock_llm):
    """瞬时 500（之后恢复）应通过重试自愈。"""
    from app import config
    old = config.API_MAX_RETRIES
    config.API_MAX_RETRIES = 3
    try:
        ctx = ctx_factory()
        mock_llm.fail_at = {1: 500, 2: 429}  # 第1、2次失败，之后成功
        c = AnalysisController(ctx.project, ctx.target)
        c.client = DeepSeekClient()
        run_sync(c)
        assert c.ctx.phase == "COMPLETE", c.ctx.error
    finally:
        config.API_MAX_RETRIES = old


def test_cache_and_force_rerun(ctx_factory, mock_llm):
    ctx = ctx_factory()
    c = AnalysisController(ctx.project, ctx.target)
    c.client = DeepSeekClient()
    run_sync(c)
    assert c.ctx.phase == "COMPLETE"

    from app.store import runs as run_store
    assert run_store.is_complete(ctx.project, ctx.slug)
    r = run_store.start_run(ctx.project, ctx.target, force=False)
    assert r["action"] == "cached"          # 缓存：不再启动
    r2 = run_store.start_run(ctx.project, ctx.target, force=True)
    assert r2["action"] == "started"        # 强制：重新运行


def test_state_roundtrip_and_slug(ctx_factory):
    ctx = ctx_factory()
    ctx.phase = "READ"
    ctx.flags["source_located"] = True
    save_state(ctx)
    st = load_state(ctx)
    assert st["status"] == "READ" and st["flags"]["source_located"]

    assert slugify("第一章") == "第一章"
    assert "/" not in slugify("8.3 一致收敛")
    assert ".." not in slugify("../evil")
    assert slugify("") == "chapter"


def test_full_phases_sequence_reached(ctx_factory, mock_llm):
    ctx = ctx_factory()
    c = AnalysisController(ctx.project, ctx.target)
    c.client = DeepSeekClient()
    run_sync(c)
    events = [json.loads(l) for l in
              (ctx.workspace_dir / "events.jsonl").read_text().splitlines()]
    entered = [e["message"] for e in events if e["message"].startswith("进入阶段")]
    for ph in ["LOCATE", "READ", "UNDERSTAND", "DESIGN", "GENERATE",
               "PSYCHOLOGY_CHECK", "VERIFY", "SAVE", "COMPLETE"]:
        assert any(ph in m for m in entered), f"未进入阶段 {ph}"
    # 状态机顺序
    seq = [PHASES.index(ph) for ph in
           ["LOCATE", "READ", "UNDERSTAND", "DESIGN", "GENERATE",
            "PSYCHOLOGY_CHECK", "VERIFY", "SAVE"]]
    assert seq == sorted(seq)
