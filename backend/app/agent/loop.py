"""Agent Loop：真正的 Tool Calling 执行循环（非模拟）。

每轮：DeepSeek 决定 → 后端执行工具 → 结果回传 → DeepSeek 再决定……
直到该阶段 submit 工具被接受、或达到迭代上限 / 用户取消。
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

from .. import config
from ..services.deepseek import DeepSeekClient, DeepSeekError
from ..tools import registry


class PhaseError(Exception):
    """阶段失败（迭代超限 / 反复无效提交 / 定位失败等）。"""


class RunCancelled(Exception):
    pass


def _tool_display(name: str, args: Dict[str, Any]) -> str:
    if name in ("list_files",):
        return "list_files()"
    if name == "find_section":
        return f"find_section(file={args.get('file')!r}, target={args.get('target')!r})"
    if name == "get_document_outline":
        return f"get_document_outline(file={args.get('file')!r})"
    if name == "read_pages":
        off = args.get("offset") or 0
        suffix = f", offset={off}" if off else ""
        return f"read_pages(file={args.get('file')!r}, P{args.get('start_page')}–P{args.get('end_page')}{suffix})"
    if name == "read_section":
        return f"read_section(file={args.get('file')!r}, section={args.get('section')!r})"
    if name == "search_local":
        return f"search_local(query={args.get('query')!r})"
    if name == "read_file":
        return f"read_file({args.get('path')!r})"
    if name == "write_file":
        return f"write_file({args.get('path')!r})"
    if name.startswith("submit_"):
        return f"{name}(...)"
    return name


class PhaseRunner:
    """驱动一个阶段的 LLM-工具循环。"""

    def __init__(self, ctx, client: DeepSeekClient,
                 submit_callback: Callable[[str, Dict[str, Any]], str],
                 on_tool: Optional[Callable[[str, Dict[str, Any], str], None]] = None):
        self.ctx = ctx
        self.client = client
        self.client.cancel_event = ctx.cancel_event
        self.client.on_retry = lambda attempt, wait: ctx.emit(
            f"模型服务暂时不可用，{wait:g} 秒后进行第 {attempt} 次尝试", level="warning")
        self.on_tool = on_tool
        ctx.submit_callback = submit_callback
        self.accepted: Optional[Dict[str, Any]] = None  # {"tool","args"}

    # ------------------------------------------------------------------
    def run(self, system_prompt: str, kickoff: str) -> Dict[str, Any]:
        ctx = self.ctx
        tools = registry.tool_schemas_for(ctx.phase)

        # system 始终位于消息列表头部，随阶段切换更新
        if ctx.messages and ctx.messages[0].get("role") == "system":
            ctx.messages[0]["content"] = system_prompt
        else:
            ctx.messages.insert(0, {"role": "system", "content": system_prompt})
        ctx.messages.append({"role": "user", "content": kickoff})

        nudges = 0
        for _iteration in range(config.MAX_TOOL_ITERATIONS_PER_PHASE):
            if ctx.cancel_event.is_set():
                raise RunCancelled()

            resp = self.client.chat(ctx.messages, tools=tools)
            ctx.messages.append(self._assistant_message(resp))
            ctx.save_messages()

            if resp.get("truncated"):
                ctx.emit("模型输出被截断，需要缩短后重新提交", level="warning")

            tool_calls = resp.get("tool_calls") or []
            if not tool_calls:
                if resp.get("truncated"):
                    ctx.messages.append({"role": "user",
                                         "content": "【系统】你的上一条输出因长度被截断且没有工具调用。"
                                                    "请减小单次输出量（例如分批 submit_question_pool），重新提交。"})
                    continue
                nudges += 1
                if nudges > config.MAX_NUDGES_PER_PHASE:
                    raise PhaseError(f"模型在 {ctx.phase} 阶段多次未调用提交工具，任务中止")
                ctx.messages.append({"role": "user",
                                     "content": "【系统】请使用当前阶段要求的 submit_* 工具提交结构化结果；"
                                                "不要用纯文本回复。"})
                continue

            submitted_ok = False
            for tc in tool_calls:
                if ctx.cancel_event.is_set():
                    raise RunCancelled()
                fn = (tc.get("function") or {})
                name = fn.get("name", "")
                args_json = fn.get("arguments") or "{}"
                ctx.emit(f"调用工具 {_tool_display(name, _safe_args(args_json))}", level="tool",
                         data={"tool": name})

                result_text, is_submit = registry.execute_tool(ctx, name, args_json)

                if is_submit:
                    if result_text.startswith("SUBMIT_ACCEPTED"):
                        submitted_ok = True
                        ctx.emit(result_text.split("\n", 1)[0].replace("SUBMIT_ACCEPTED:", "").strip(),
                                 level="success")
                elif result_text.startswith("TOOL_ERROR"):
                    ctx.emit(f"工具出错：{result_text[:160]}", level="warning")

                ctx.messages.append({"role": "tool", "tool_call_id": tc.get("id", name),
                                     "content": result_text[:config.TOOL_RESULT_MAX_CHARS]})
                if self.on_tool:
                    self.on_tool(name, _safe_args(args_json), result_text)

            if resp.get("truncated") and not submitted_ok:
                ctx.messages.append({"role": "user", "content":
                    "【系统】上一条工具参数因输出长度限额被截断，不能继续重复同等长度的结果。"
                    "请将总输出缩短至少一半并重新提交完整合法 JSON。章节理解只保留核心条目及必要公式，"
                    "不要抄录证明；学习方案减少逐项篇幅；只有题库支持分批累积。"})
            ctx.save_messages()
            if submitted_ok and self.accepted:
                return self.accepted

        raise PhaseError(f"阶段 {ctx.phase} 超过最大工具循环次数"
                         f"（{config.MAX_TOOL_ITERATIONS_PER_PHASE}），已中止以防止无限循环")

    # ------------------------------------------------------------------
    @staticmethod
    def _assistant_message(resp: Dict[str, Any]) -> Dict[str, Any]:
        msg: Dict[str, Any] = {"role": "assistant",
                               "content": resp.get("content") or ""}
        if "reasoning_content" in resp:
            msg["reasoning_content"] = resp["reasoning_content"]
        if resp.get("tool_calls"):
            msg["tool_calls"] = resp["tool_calls"]
        return msg


def _safe_args(args_json: str) -> Dict[str, Any]:
    try:
        v = json.loads(args_json) if args_json else {}
        return v if isinstance(v, dict) else {}
    except json.JSONDecodeError:
        return {"_unparsed": str(args_json)[:120]}
