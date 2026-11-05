"""工具注册表：按阶段组装工具集 + 安全执行（JSON 参数校验、错误回传、提交拦截）。"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from .base import Tool, ToolError, dump_result
from .file_tools import build_list_files_tool
from .document_tools import build_document_tools
from .search_tools import build_search_tool
from .workspace_tools import build_workspace_tools
from .. import config


def build_submit_tools() -> Dict[str, Tool]:
    from .submit_tools import build_all
    return {t.name: t for t in build_all()}


SUBMIT_TOOLS: Dict[str, Tool] = build_submit_tools()

INFO_TOOLS: Dict[str, Tool] = {}
for _builder in (build_list_files_tool, build_document_tools, build_search_tool,
                 build_workspace_tools):
    for _t in _builder():
        INFO_TOOLS[_t.name] = _t

# 每阶段可用的工具（submit_* 由 controller 特殊处理）
PHASE_TOOLS: Dict[str, List[str]] = {
    "LOCATE": ["list_files", "get_document_outline", "find_section", "submit_location"],
    "READ": ["read_pages", "read_section", "find_section", "search_local", "submit_reading"],
    "UNDERSTAND": ["read_pages", "read_section", "search_local", "read_file",
                   "submit_chapter_context"],
    "DESIGN": ["read_file", "read_pages", "read_section", "search_local", "submit_learning_plan"],
    "GENERATE": ["read_file", "read_pages", "search_local", "submit_question_pool"],
    "PSYCHOLOGY_CHECK": ["read_file", "submit_qa_report", "submit_learning_plan",
                         "submit_question_pool"],
    "VERIFY": ["read_file", "read_pages", "read_section", "search_local",
               "submit_verification", "submit_question_pool"],
}


def tool_schemas_for(phase: str) -> List[Dict[str, Any]]:
    names = PHASE_TOOLS.get(phase, [])
    return [SUBMIT_TOOLS[n].to_openai_schema() if n in SUBMIT_TOOLS
            else INFO_TOOLS[n].to_openai_schema() for n in names]


def execute_tool(ctx, name: str, arguments_json: str) -> Tuple[str, bool]:
    """执行一个工具调用。

    返回 (result_text, is_submit)。submit_* 工具不直接执行，
    is_submit=True 且 result_text 为校验结果（controller 在 loop 中处理）。
    """
    if name not in PHASE_TOOLS.get(ctx.phase, []):
        return f"TOOL_ERROR: 当前 {ctx.phase} 阶段不允许调用 {name}。", False
    try:
        args = json.loads(arguments_json) if arguments_json and arguments_json.strip() else {}
    except json.JSONDecodeError as e:
        return f"TOOL_ERROR: 参数不是合法 JSON（{e}）。请修正参数后重新调用。", False
    if not isinstance(args, dict):
        return "TOOL_ERROR: 参数必须是 JSON 对象。", False

    if name in SUBMIT_TOOLS:
        # 交给 controller 校验（由 loop 注入回调）
        cb = getattr(ctx, "submit_callback", None)
        if cb is None:
            return "TOOL_ERROR: 当前无法提交。", False
        return cb(name, args), True

    tool = INFO_TOOLS.get(name)
    if tool is None:
        return f"TOOL_ERROR: 未知工具 {name}。可用工具: {sorted(list(INFO_TOOLS) + list(SUBMIT_TOOLS))}", False
    # 基本参数校验：required 字段
    missing = [r for r in tool.parameters.get("required", []) if r not in args]
    if missing:
        return f"TOOL_ERROR: 缺少必填参数 {missing}。", False
    for key, value in args.items():
        expected = tool.parameters.get("properties", {}).get(key, {}).get("type")
        if ((expected == "string" and not isinstance(value, str))
                or (expected == "integer" and type(value) is not int)):
            return f"TOOL_ERROR: 参数 {key} 必须为 {expected}。", False
    try:
        result = tool.handler(ctx, args)
    except ToolError as e:
        return f"TOOL_ERROR: {e}", False
    except RecursionError:
        return "TOOL_ERROR: 工具执行异常。", False
    except Exception as e:  # noqa: BLE001 - 工具意外异常也回传给模型自我修正
        return f"TOOL_ERROR: {type(e).__name__}: {e}", False
    return dump_result(result, config.TOOL_RESULT_MAX_CHARS), False
