"""Prompt 加载器：所有 System Prompt 独立保存在项目根 prompts/ 目录。

模板用 {{placeholder}} 占位（避免与 Prompt 中的 JSON 示例花括号冲突）。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict

from .. import config

_cache: Dict[str, str] = {}

_PLACEHOLDER = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def load_prompt(name: str) -> str:
    """读取 prompts/<name>.md；不存在时抛 FileNotFoundError。"""
    if name in _cache:
        return _cache[name]
    path = Path(config.PROMPTS_DIR) / f"{name}.md"
    if not path.exists():
        raise FileNotFoundError(f"Prompt 文件缺失: {path}")
    text = path.read_text(encoding="utf-8")
    _cache[name] = text
    return text


def render(name: str, **kwargs) -> str:
    template = load_prompt(name)

    def sub(m: "re.Match[str]") -> str:
        key = m.group(1)
        return str(kwargs.get(key, m.group(0)))

    return _PLACEHOLDER.sub(sub, template)


PHASE_PROMPTS = {
    "LOCATE": "phase_locate",
    "READ": "phase_read",
    "UNDERSTAND": "phase_understand",
    "DESIGN": "learning_designer",
    "GENERATE": "phase_generate",
    "PSYCHOLOGY_CHECK": "psychology_qa",
    "VERIFY": "verification",
}
