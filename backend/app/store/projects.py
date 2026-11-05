"""项目 / 教材文件管理（input 只读保护：上传同名文件直接拒绝，绝不覆盖）。"""
from __future__ import annotations

import re
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List

from .. import config
from ..parsers import registry as parser_registry

SAFE_NAME = re.compile(r"^[\w\u4e00-\u9fff.\-()（）\[\]【】 ]{1,120}$")


class ProjectError(Exception):
    pass


class ProjectNotFound(ProjectError):
    pass


def _last_activity(project_dir: Path) -> float:
    """该项目最近一次分析的时间（workspace 最新 state.json 的 mtime）。"""
    ws = project_dir / "workspace"
    latest = 0.0
    if ws.exists():
        for st in ws.glob("*/state.json"):
            try:
                latest = max(latest, st.stat().st_mtime)
            except OSError:
                continue
    return latest


def list_projects() -> List[Dict[str, Any]]:
    config.ensure_dirs()
    out = []
    for d in sorted(config.PROJECTS_DIR.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            out.append({"name": d.name,
                        "file_count": _count_input_files(d),
                        "last_activity": _last_activity(d)})
    # 最近活跃的排前面（前端默认选择用）
    out.sort(key=lambda x: (-x["last_activity"], x["name"]))
    return out


def _count_input_files(project_dir: Path) -> int:
    inp = project_dir / "input"
    if not inp.exists():
        return 0
    return len([p for p in inp.iterdir()
                if p.is_file() and p.suffix.lower() in config.ALLOWED_UPLOAD_EXTS])


def create_project(name: str) -> Dict[str, Any]:
    name = name.strip()
    if not SAFE_NAME.match(name) or name.startswith(".") or ".." in name:
        raise ProjectError("项目名只能包含中文、字母、数字、空格与 .-()[] 字符，长度 ≤120")
    d = config.PROJECTS_DIR / name
    if d.exists():
        raise ProjectError(f"项目 {name} 已存在")
    try:
        d.mkdir(parents=True)
    except FileExistsError:
        raise ProjectError(f"项目 {name} 已存在")
    (d / "input").mkdir()
    (d / "workspace").mkdir(parents=True)
    (d / "output").mkdir(parents=True)
    return {"name": name, "file_count": 0}


def project_dir(name: str) -> Path:
    if not SAFE_NAME.match(name or "") or ".." in name:
        raise ProjectError(f"非法项目名: {name!r}")
    d = config.PROJECTS_DIR / name
    if not d.is_dir():
        raise ProjectNotFound(f"项目不存在: {name}")
    return d


def list_files(project: str) -> List[Dict[str, Any]]:
    d = project_dir(project)
    inp = d / "input"
    files = []
    if inp.exists():
        for p in sorted(inp.iterdir()):
            if not p.is_file() or p.name.startswith("."):
                continue
            info: Dict[str, Any] = {
                "name": p.name, "size": p.stat().st_size,
                "ext": p.suffix.lower(),
                "mtime": p.stat().st_mtime,
            }
            if p.suffix.lower() in config.ALLOWED_UPLOAD_EXTS:
                try:
                    doc = parser_registry.get_document(p)
                    info["pages"] = doc.total_pages
                    info["parse_ok"] = True
                    info["text_density"] = round(getattr(doc, "text_density", 0.0))
                    info["scan_suspect"] = bool(getattr(doc, "scan_suspect", False))
                except Exception as e:  # noqa: BLE001
                    info["pages"] = 0
                    info["parse_ok"] = False
                    info["parse_error"] = str(e)[:200]
            else:
                info["parse_ok"] = False
                info["parse_error"] = "不支持的类型"
            files.append(info)
    return files


def save_upload(project: str, filename: str, content: bytes) -> Dict[str, Any]:
    d = project_dir(project)
    filename = filename.strip().replace("\\", "/").split("/")[-1]
    if not SAFE_NAME.match(filename) or filename.startswith("."):
        raise ProjectError(f"文件名不合法或过长: {filename!r}")
    ext = Path(filename).suffix.lower()
    if ext not in config.ALLOWED_UPLOAD_EXTS:
        raise ProjectError(f"不支持的文件类型 {ext}（支持：{sorted(config.ALLOWED_UPLOAD_EXTS)}）")
    if len(content) > config.MAX_UPLOAD_BYTES:
        raise ProjectError(f"文件超过大小上限 {config.MAX_UPLOAD_BYTES // (1024*1024)}MB")
    if not content:
        raise ProjectError("文件为空，请选择包含教材内容的文件")
    dest = d / "input" / filename
    fd, temporary = tempfile.mkstemp(prefix=".upload-", suffix=".tmp", dir=dest.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        # 完整写入后才可见；硬链接是同一文件系统内不覆盖已有教材的原子提交。
        os.link(temporary, dest)
    except FileExistsError:
        raise ProjectError(f"input/ 中已存在同名文件「{filename}」。为保护原始教材，系统不会覆盖；"
                           "请先删除旧文件或改名后再上传。")
    finally:
        Path(temporary).unlink(missing_ok=True)
    # 立即验证可解析，避免上传后才发现文件损坏
    try:
        doc = parser_registry.get_document(dest)
    except Exception as e:  # noqa: BLE001
        dest.unlink(missing_ok=True)
        raise ProjectError(f"文件上传后解析失败，已拒绝保存：{e}")
    return {"name": filename, "size": len(content), "pages": doc.total_pages,
            "uploaded_at": time.time()}
