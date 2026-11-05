"""pytest fixtures：临时项目、RunContext、mock DeepSeek 服务器。"""
from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

SAMPLE_TEXTBOOK = (Path(__file__).resolve().parents[1] /
                   "projects/abstract-algebra/input/sample_abstract_algebra.md")


@pytest.fixture()
def project_dir(tmp_path):
    """一个带示例教材的临时项目。"""
    proj = tmp_path / "test-project"
    (proj / "input").mkdir(parents=True)
    (proj / "workspace").mkdir()
    (proj / "output").mkdir()
    (proj / "input" / "sample.md").write_text(SAMPLE_TEXTBOOK.read_text(encoding="utf-8"),
                                              encoding="utf-8")
    (proj / "input" / "notes.txt").write_text("这是另一份资料，与章节定位无关。\n" * 50,
                                              encoding="utf-8")
    return proj


@pytest.fixture()
def ctx_factory(project_dir, monkeypatch):
    """构造绑定到临时项目的 RunContext（并把 PROJECTS_DIR 指过去）。"""
    from app import config
    from app.agent.context import RunContext

    monkeypatch.setattr(config, "PROJECTS_DIR", project_dir.parent)

    def make(target="第一章", slug=None):
        from app.agent.context import slugify

        return RunContext(project_dir.name, target, slug or slugify(target),
                          threading.Event())
    return make


class _MockState:
    """mock 服务器的可变配置（每个测试可注入故障）。"""
    def __init__(self):
        self.fail_at: dict = {}     # {第N次调用: 状态码} 精确故障
        self.fail_from = None       # (从第N次起, 状态码) 持续故障
        self.call_count = 0
        self.delay = 0.0

    def failure_code(self, call_no):
        if self.fail_at and call_no in self.fail_at:
            return self.fail_at[call_no]
        if self.fail_from and call_no >= self.fail_from[0]:
            return self.fail_from[1]
        return None


class MockDeepSeekHandler(BaseHTTPRequestHandler):
    state: _MockState = _MockState()

    def log_message(self, *args):  # 静默
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.state.call_count += 1
        code = self.state.failure_code(self.state.call_count)
        if code:
            self._respond(code, {"error": {"message": f"mock failure #{code}"}})
            return
        if self.state.delay:
            import time

            time.sleep(self.state.delay)
        try:
            reply = self._decide(body)
            self._respond(200, {
                "id": "mock", "object": "chat.completion", "model": "mock",
                "choices": [{"index": 0, "finish_reason": "tool_calls",
                             "message": {"role": "assistant", "content": "",
                                         "tool_calls": [reply]}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
        except StopIteration:
            # 结束信号：返回纯文本（会触发 nudge，测试用于异常路径）
            self._respond(200, {
                "id": "mock", "object": "chat.completion", "model": "mock",
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "done"}}],
                "usage": {}})

    def _respond(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------------- 规则式 mock Agent ----------------
    def _decide(self, body):
        messages = body.get("messages", [])
        system = messages[0].get("content", "") if messages else ""
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        last_tool_text = tool_msgs[-1]["content"] if tool_msgs else ""

        def call(name, args):
            return {"id": f"call_{self.state.call_count}", "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}

        def done(result):
            raise StopIteration()

        def last_json():
            try:
                return json.loads(last_tool_text)
            except json.JSONDecodeError:
                return {}

        if "阶段指令 — LOCATE" in system:
            names = tool_call_history(messages)
            if "list_files" not in names:
                return call("list_files", {})
            if "find_section" not in names:
                import re
                kick = "\n".join(m.get("content", "") for m in messages
                                 if m.get("role") == "user")
                m = re.search(r"定位章节「(.+?)」", kick)
                target = m.group(1) if m else "第一章"
                return call("find_section", {"file": "sample.md", "target": target})
            fs = last_json()
            best = fs.get("best")
            if not fs.get("found") or not best:
                return call("submit_location", {
                    "file": "NOT_FOUND", "heading": "未找到",
                    "notes": f"项目资料中不存在「{fs.get('target', '')}」这一章节"})
            return call("submit_location", {
                "file": "sample.md",
                "heading": best.get("title", "第一章"),
                "start_page": best.get("start_page", 1),
                "end_page": best.get("end_page", 2),
                "confidence": "high"})

        if "阶段指令 — READ" in system:
            import re
            m = re.search(r"第 (\d+)–(\d+) 页", "\n".join(
                mm.get("content", "") for mm in messages if mm.get("role") == "user"))
            start, end = int(m.group(1)), int(m.group(2))
            last = last_tool_text
            if last.startswith("SUBMIT_REJECTED") and "尚未完整读取" in last:
                # 被拒说明覆盖不足：从头再读一遍
                return call("read_pages", {"file": "sample.md",
                                           "start_page": start, "end_page": end})
            data = last_json()
            if not last.startswith("{") or data.get("has_more"):
                args = {"file": "sample.md", "start_page": start, "end_page": end}
                if data.get("has_more"):
                    args["offset"] = data["next_offset"]
                return call("read_pages", args)
            return call("submit_reading", {
                "read_complete": True,
                "outline_summary": "本章共5节：1.1二元运算（定义+正反例）、1.2群的定义（四公理，"
                                   "含Z_n与Klein四元群例子）、1.3基本性质（单位元唯一、逆元唯一、"
                                   "消去律、方程可解、穿脱原理）、1.4例题、1.5小结，章末有习题一。",
                "chunks_read": 3})

        if "阶段指令 — UNDERSTAND" in system:
            return call("submit_chapter_context", {
                "chapter": "第一章",
                "source_files": ["sample.md"],
                "core_concepts": ["二元运算", "群", "单位元", "逆元"],
                "definitions": [
                    {"term": "群", "content": "满足封闭性、结合律、单位元、逆元四公理的代数结构",
                     "source_file": "sample.md", "source_page": 2},
                    {"term": "二元运算", "content": "S×S 到 S 的映射",
                     "source_file": "sample.md", "source_page": 2}],
                "theorems": [{"name": "单位元唯一", "content": "群单位元唯一",
                              "source_file": "sample.md", "source_page": 2}],
                "key_examples": [{"name": "Klein四元群", "content": "四元素群"}],
                "skills": ["验证群公理"], "common_mistakes": ["忽略封闭性"],
                "difficulty_points": ["穿脱原理"], "prerequisites": ["映射"],
                "source_references": [{"file": "sample.md", "page": 2, "locator": "1.2"}]})

        if "学习设计师" in system:
            return call("submit_learning_plan", {
                "chapter": "第一章",
                "learning_objectives": ["能验证群公理", "能求逆元", "能应用消去律"],
                "learning_sequence": [
                    {"stage": 1, "name": "直觉建立", "goal": "能判断运算是否封闭",
                     "content": ["从加法例子入手"], "practice": ["判断3个运算的封闭性"]},
                    {"stage": 2, "name": "形式化", "goal": "能陈述群四公理",
                     "content": ["学习定义1.2.1"], "practice": ["验证Z3是群"]},
                    {"stage": 3, "name": "定理应用", "goal": "能用消去律解题",
                     "content": ["学习定理1.3.3"], "practice": ["解方程题"]}],
                "mastery_criteria": ["能独立验证Z_n是群", "能给非群结构举反例"],
                "common_failure_points": ["忘记验证封闭性：补救——重读定义1.1.1"]})

        if "阶段指令 — GENERATE" in system:
            batch = [m for m in tool_call_history(messages) if m == "submit_question_pool"]
            if not batch:
                return call("submit_question_pool", {
                    "chapter": "第一章", "batch_index": 1, "is_final": False,
                    "questions": [
                        {"id": "q1", "type": "single_choice", "difficulty": 1,
                         "stage_index": 1, "learning_objective": "能验证群公理", "prompt": "ℕ 上减法是二元运算吗？",
                         "options": ["是", "否"], "answer": "B",
                         "explanation": "1-2=-1∉ℕ，不封闭",
                         "source_basis": ["sample.md 例1.1.3"]},
                        {"id": "q2", "type": "short_answer", "difficulty": 2,
                         "stage_index": 2, "learning_objective": "能求逆元", "prompt": "求 Z3 中 [2] 的逆元",
                         "answer": "[1]", "explanation": "[2]+[1]=[3]=[0]",
                         "source_basis": ["sample.md 例1.4.1"]},
                        {"id": "q3", "type": "proof", "difficulty": 3,
                         "stage_index": 3, "learning_objective": "能应用消去律", "prompt": "证明群中消去律成立",
                         "answer": "用逆元左乘", "explanation": "见定理1.3.3",
                         "source_basis": ["sample.md 定理1.3.3"]}]})
            return call("submit_question_pool", {
                "chapter": "第一章", "batch_index": 2, "is_final": True,
                "questions": [
                    {"id": "q4", "type": "single_choice", "difficulty": 1,
                     "stage_index": 2, "learning_objective": "能验证群公理", "prompt": "Z_n 加法群的单位元是？",
                     "options": ["[0]", "[1]"], "answer": "A",
                     "explanation": "[0]+[a]=[a]", "source_basis": ["sample.md 例1.2.4"]},
                    {"id": "q5", "type": "calculation", "difficulty": 2,
                     "stage_index": 3, "learning_objective": "能求逆元", "prompt": "已知ab=e，ab的逆元是什么（用a,b表示）",
                     "answer": "b⁻¹a⁻¹", "explanation": "穿脱原理",
                     "source_basis": ["sample.md 性质1.3.6"]},
                    {"id": "q6", "type": "comparison", "difficulty": 2,
                     "stage_index": 2, "learning_objective": "能验证群公理", "prompt": "交换律与结合律是否互推？",
                     "answer": "否", "explanation": "两者独立",
                     "source_basis": ["sample.md 注1.1.5"]}]})

        if "QA 审查员" in system:
            qa_history = [m for m in tool_call_history(messages) if m == "submit_qa_report"]
            revised = [m for m in tool_call_history(messages)
                       if m in ("submit_learning_plan", "submit_question_pool")]
            if not qa_history:
                # 第一次：故意报一项不通过（且无修订），应被系统拒绝
                return call("submit_qa_report", {
                    "clear_goal": {"pass": True, "issues": [], "changes": []},
                    "immediate_feedback": {"pass": True, "issues": [], "changes": []},
                    "real_progress": {"pass": False,
                                      "issues": ["mastery criteria 不可检验"],
                                      "changes": []},
                    "meaningful_agency": {"pass": True, "issues": [], "changes": []},
                    "small_wins": {"pass": True, "issues": [], "changes": []},
                    "challenge_skill_match": {"pass": True, "issues": [], "changes": []},
                    "curiosity": {"pass": True, "issues": [], "changes": []}})
            if len(revised) == 0:
                # 修订方案（触发 controller 的修订接受逻辑）
                return call("submit_learning_plan", {
                    "chapter": "第一章",
                    "learning_objectives": ["能验证群公理", "能求逆元", "能应用消去律"],
                    "learning_sequence": [
                        {"stage": 1, "name": "直觉建立", "goal": "能判断运算是否封闭",
                         "content": ["从加法例子入手"], "practice": ["判断3个运算的封闭性"]},
                        {"stage": 2, "name": "形式化", "goal": "能陈述群四公理",
                         "content": ["学习定义1.2.1"], "practice": ["验证Z3是群"]},
                        {"stage": 3, "name": "定理应用", "goal": "能用消去律解题",
                         "content": ["学习定理1.3.3"], "practice": ["解方程题"]}],
                    "mastery_criteria": [
                        "能独立验证Z_n是群（逐条写出四公理验证过程）",
                        "能给非群结构举反例并指出违反哪条公理"],
                    "common_failure_points": ["忘记验证封闭性：补救——重读定义1.1.1"]})
            # 修订后复查：全部通过
            item = {"pass": True, "issues": [], "changes": []}
            return call("submit_qa_report", {
                "clear_goal": dict(item),
                "immediate_feedback": dict(item),
                "real_progress": {"pass": True, "issues": [],
                                  "changes": ["重写 mastery criteria 为可检验行为"]},
                "meaningful_agency": dict(item), "small_wins": dict(item),
                "challenge_skill_match": dict(item), "curiosity": dict(item)})

        if "独立验证员" in system or "最终验证" in system:
            verify_history = [m for m in tool_call_history(messages) if m == "submit_verification"]
            if not verify_history:
                return call("submit_verification", {
                    "re_solved": True, "verified_count": 6, "overall_pass": True,
                    "issues": [{"question_id": "q5", "severity": "minor",
                                "problem": "题目表述不够清晰",
                                "fix_applied": "改写题面",
                                "corrected_question": {
                                    "id": "q5", "type": "calculation", "difficulty": 2,
                                    "stage_index": 3, "learning_objective": "能求逆元",
                                    "prompt": "在群G中，a∘b=e。请用 a⁻¹、b⁻¹ 表示 (a∘b)⁻¹。",
                                    "answer": "(a∘b)⁻¹=b⁻¹∘a⁻¹=e，故即 b⁻¹∘a⁻¹",
                                    "explanation": "穿脱原理：(a∘b)⁻¹=b⁻¹∘a⁻¹",
                                    "source_basis": ["sample.md 性质1.3.6"]}}],
                    "coverage_notes": "覆盖全部学习目标", "notes": ""})
            # 第二轮复查：无问题
            return call("submit_verification", {
                "re_solved": True, "verified_count": 6, "overall_pass": True,
                "issues": [], "coverage_notes": "复查通过", "notes": ""})

        # 兜底
        return call("list_files", {})


def tool_call_history(messages):
    names = []
    for m in messages:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                names.append(tc.get("function", {}).get("name"))
    return names


@pytest.fixture()
def mock_llm():
    """启动 mock DeepSeek 服务器，并把后端指向它。"""
    from app import config

    server = ThreadingHTTPServer(("127.0.0.1", 0), MockDeepSeekHandler)
    state = _MockState()
    MockDeepSeekHandler.state = state
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    old = (config.DEEPSEEK_BASE_URL, config.DEEPSEEK_API_KEY, config.DEEPSEEK_MODEL,
           config.API_MAX_RETRIES)
    config.DEEPSEEK_BASE_URL = f"http://127.0.0.1:{server.server_address[1]}/v1"
    config.DEEPSEEK_API_KEY = "sk-mock"
    config.DEEPSEEK_MODEL = "mock-model"
    config.API_MAX_RETRIES = 1  # 测试不等待长退避
    try:
        yield state
    finally:
        config.DEEPSEEK_BASE_URL, config.DEEPSEEK_API_KEY, config.DEEPSEEK_MODEL, \
            config.API_MAX_RETRIES = old
        server.shutdown()
