"""工具基类：Tool = 名称 + 描述 + JSON Schema 参数 + handler(ctx, args)。

handler 抛 ToolError 时，错误信息会作为工具结果返回给模型（模型可自我修正）；
其他异常由 registry 捕获并转换为通用错误结果。
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, Optional


class ToolError(Exception):
    """可恢复的工具错误：消息回传给模型，让 Agent 决定下一步。"""


class Tool:
    def __init__(self, name: str, description: str, parameters: Dict[str, Any],
                 handler: Callable[..., Any], emit_log: Optional[str] = None):
        self.name = name
        self.description = description
        self.parameters = parameters
        self.handler = handler
        # emit_log: 调用时向前端发的高级别日志模板，如 "正在定位 {target}"
        self.emit_log = emit_log

    def to_openai_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


def dump_result(result: Any, max_chars: int) -> str:
    """工具结果 -> 字符串（模型可读），超长截断并说明。"""
    if isinstance(result, str):
        text = result
        if len(text) > max_chars:
            cut = result[:max_chars]
            return cut + f"\n\n[TRUNCATED] 内容过长，已截断（原长度 {len(result)} 字符）。如需剩余部分，请用分页参数继续读取。"
        return text
    text = json.dumps(result, ensure_ascii=False, indent=1)
    if len(text) > max_chars:
        return text[:max_chars] + f"\n\n[TRUNCATED] JSON 过长已截断，请缩小查询范围。"
    return text
