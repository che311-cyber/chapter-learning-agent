"""一次章节分析运行（Run）的共享上下文：路径、事件流、阅读覆盖追踪、消息历史。"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


class RunContext:
    def __init__(self, project: str, target: str, slug: str, cancel_event: threading.Event):
        from .. import config

        self.project = project
        self.target = target
        self.slug = slug
        self.cancel_event = cancel_event

        self.allowed_files: Optional[List[str]] = None  # 本次分析限定使用的教材文件
        self.project_dir: Path = config.PROJECTS_DIR / project
        self.input_dir: Path = self.project_dir / "input"
        self.workspace_dir: Path = self.project_dir / "workspace" / slug
        self.output_dir: Path = self.project_dir / "output" / slug

        # 运行期数据
        self.events: List[Dict[str, Any]] = []      # [{seq, ts, phase, level, message, data}]
        self.event_seq = 0
        self.phase = "TARGET"
        self.messages: List[Dict[str, Any]] = []    # LLM 会话历史
        self.located: Optional[Dict[str, Any]] = None  # {"file","start_page","end_page","heading"}
        self.coverage: Dict[str, List[List[int]]] = {}  # file -> [[start,end],...] 已读页区间
        self.read_fragments: Dict[str, Dict[str, Any]] = {}
        self.artifacts: Dict[str, Any] = {}         # 已提交产物 (context/plan/questions/qa/verify)
        self.flags: Dict[str, bool] = {
            "source_located": False,
            "chapter_read_complete": False,
            "understanding_complete": False,
            "design_complete": False,
            "questions_complete": False,
            "psychology_check_complete": False,
            "verification_complete": False,
        }
        self.error: Optional[str] = None
        self.lock = threading.RLock()

    # ---------- 事件 ----------
    def emit(self, message: str, level: str = "info", data: Optional[Dict] = None,
             phase: Optional[str] = None) -> None:
        with self.lock:
            self.event_seq += 1
            self.events.append({
                "seq": self.event_seq,
                "ts": time.time(),
                "phase": phase or self.phase,
                "level": level,          # info / tool / success / warning / error
                "message": message,
                "data": data or {},
            })
            del self.events[:-400]
            # 同步落盘，服务重启后日志仍在
            self._append_event_file(self.events[-1])

    def _append_event_file(self, ev: Dict[str, Any]) -> None:
        try:
            self.workspace_dir.mkdir(parents=True, exist_ok=True)
            line = json.dumps(ev, ensure_ascii=False) + "\n"
            try:
                with open(self.workspace_dir / "events.jsonl", "a", encoding="utf-8") as f:
                    f.write(line)
            except UnicodeEncodeError:
                # 兜底：内容含孤立代理字符时改用 ASCII 转义写法
                with open(self.workspace_dir / "events.jsonl", "a", encoding="utf-8") as f:
                    f.write(json.dumps(ev, ensure_ascii=True) + "\n")
        except OSError:
            pass

    # ---------- 阅读覆盖 ----------
    def mark_read(self, file: str, start: int, end: int) -> None:
        with self.lock:
            ivs = self.coverage.setdefault(file, [])
            ivs.append([start, end])
        from .state_machine import save_state
        save_state(self)

    def coverage_of(self, file: str, start: int, end: int) -> Dict[str, Any]:
        """计算 [start,end] 中已读/未读页。"""
        with self.lock:
            ivs = list(self.coverage.get(file, []))
        covered = set()
        for s, e in ivs:
            for p in range(max(s, start), min(e, end) + 1):
                covered.add(p)
        total = end - start + 1
        missing = [p for p in range(start, end + 1) if p not in covered]
        return {"total": total, "read": total - len(missing),
                "missing_pages": missing[:80]}

    def mark_returned_text(self, file: str, index: list, start: int, end: int) -> list:
        """只累计实际返回的字符区间；游标跳读不能补齐被跳过的正文。"""
        complete = []
        changed = False
        with self.lock:
            pages = self.read_fragments.setdefault(file, {})
            for page, lower, upper in index:
                left, right = max(start, lower), min(end, upper)
                if right <= left:
                    continue
                changed = True
                length = upper - lower
                item = pages.get(str(page), {})
                previous = item.get("ranges", []) if item.get("length") == length else []
                merged = []
                for interval in sorted(previous + [[left - lower, right - lower]]):
                    if merged and interval[0] <= merged[-1][1]:
                        merged[-1][1] = max(merged[-1][1], interval[1])
                    else:
                        merged.append(list(interval))
                pages[str(page)] = {"length": length, "ranges": merged}
                if merged == [[0, length]]:
                    complete.append(page)
            intervals = self.coverage.setdefault(file, [])
            intervals.extend([[page, page] for page in complete])
            merged = []
            for interval in sorted(intervals):
                if merged and interval[0] <= merged[-1][1] + 1:
                    merged[-1][1] = max(merged[-1][1], interval[1])
                else:
                    merged.append(list(interval))
            self.coverage[file] = merged
        if changed:
            from .state_machine import save_state
            save_state(self)
        return complete

    # ---------- 消息历史持久化（支持中断续跑） ----------
    def save_messages(self) -> None:
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.workspace_dir / "messages.json",
                          {"phase": self.phase, "messages": self.messages})

    def load_messages(self) -> bool:
        f = self.workspace_dir / "messages.json"
        if not f.exists():
            return False
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            messages = data.get("messages") if isinstance(data, dict) else None
            if not isinstance(messages, list) or any(not isinstance(m, dict) for m in messages):
                return False
            # state.json 是阶段检查点；messages.json 可能仍属于上一阶段。
            self.messages = messages
            pending = {}
            for message in messages:
                if message.get("role") == "assistant":
                    for call in message.get("tool_calls") or []:
                        if isinstance(call, dict) and call.get("id"):
                            pending[call["id"]] = call
                elif message.get("role") == "tool":
                    pending.pop(message.get("tool_call_id"), None)
            # 崩溃可能发生在工具执行后、结果消息保存前，补齐协议再继续核验已有产物。
            for call_id in pending:
                self.messages.append({"role": "tool", "tool_call_id": call_id,
                    "content": "TOOL_ERROR: 上次运行在保存工具结果前中断，请检查已保存产物后继续。"})
            return bool(self.messages)
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            return False

    # ---------- 产物 ----------
    def artifact_path(self, name: str) -> Path:
        return self.workspace_dir / f"{name}.json"


def atomic_write_json(path: Path, obj: Any) -> None:
    content = json.dumps(obj, ensure_ascii=False, indent=2)
    atomic_write_text(path, content)


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def read_event_tail(path: Path, limit: int = 400) -> List[Dict[str, Any]]:
    """只读日志尾部，轮询耗时不随整个历史日志增长。"""
    if limit < 1:
        return []
    try:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            offset = stream.tell()
            chunks = []
            newlines = 0
            while offset and newlines <= limit:
                size = min(offset, 16384)
                offset -= size
                stream.seek(offset)
                block = stream.read(size)
                chunks.append(block)
                newlines += block.count(b"\n")
        lines = b"".join(reversed(chunks)).splitlines()[-limit:]
    except OSError:
        return []
    events = []
    for line in lines:
        try:
            event = json.loads(line.decode("utf-8", errors="replace"))
            if (isinstance(event, dict) and type(event.get("seq")) is int
                    and all(key not in event or isinstance(event[key], str) for key in ("message", "phase", "level"))):
                events.append(event)
        except (ValueError, TypeError):
            continue
    return events


def slugify(target: str) -> str:
    """章节名 -> 安全目录名（去路径非法字符，限长）。"""
    import re

    s = re.sub(r"\s+", "", target.strip())
    s = re.sub(r"[\\/:*?\"<>|。———·,，。;；!！?？()（）\[\]【】{}]", "", s)
    s = s.strip(".")
    if not s:
        s = "chapter"
    return s[:60]
