"""REST API 路由。所有响应 {ok, data|error}；错误信息人类可读，不暴露堆栈。"""
from __future__ import annotations

import json
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import config
from ..services.deepseek import DeepSeekError, describe_model
from ..store import projects as project_store
from ..store import runs as run_store
from ..store.projects import ProjectError, ProjectNotFound

def _validate_paths(request: Request) -> None:
    for name in ("project", "slug"):
        value = request.path_params.get(name)
        if value is not None and (value.startswith(".") or "/" in value or "\\" in value):
            raise HTTPException(status_code=400, detail="项目或章节路径不合法")
    project, slug = request.path_params.get("project"), request.path_params.get("slug")
    if project and slug:
        try:
            project_store.project_dir(project)
        except ProjectNotFound as error:
            raise HTTPException(status_code=404, detail=str(error))
        except ProjectError as error:
            raise HTTPException(status_code=400, detail=str(error))
        if request.method in ("POST", "DELETE") and (
                "/questions/" in request.url.path or request.url.path.endswith(("/review", "/learning-plan", "/teacher-note"))):
            controller = run_store.get_controller(project, slug)
            if controller is not None:
                raise HTTPException(status_code=409, detail="当前章节正在分析，请等待完成或取消后再修改")
            if not run_store.read_state(project, slug):
                raise HTTPException(status_code=404, detail="章节不存在，请先打开已生成的学习成果")


router = APIRouter(prefix="/api", dependencies=[Depends(_validate_paths)])


def _err(status: int, msg: str) -> HTTPException:
    return HTTPException(status_code=status, detail=msg)


# ---- 最小可用权限（阶段七）：教师令牌 = SHA256(TEACHER_PASSWORD+salt)，无状态校验 ----
import hashlib as _hashlib

_TEACHER_TOKENS: Dict[str, float] = {}
_TEACHER_LOCK = threading.Lock()
_TOKEN_TTL = 12 * 3600
_UPLOAD_SLOTS = threading.BoundedSemaphore(2)


class TeacherLoginIn(BaseModel):
    password: str


@router.post("/teacher/login")
def teacher_login(body: TeacherLoginIn) -> Dict[str, Any]:
    import os
    import secrets

    pw = os.getenv("TEACHER_PASSWORD", "").strip()
    if not pw:
        raise _err(503, "教师端未启用：服务器未配置 TEACHER_PASSWORD 环境变量")
    if not secrets.compare_digest(body.password.encode("utf-8", errors="replace"), pw.encode("utf-8")):
        raise _err(401, "教师密码错误")
    token = _hashlib.sha256(f"{pw}:{secrets.token_hex(8)}".encode()).hexdigest()
    with _TEACHER_LOCK:
        _TEACHER_TOKENS[token] = time.time()
        cutoff = time.time() - _TOKEN_TTL
        for tk in [k for k, v in _TEACHER_TOKENS.items() if v <= cutoff]:
            _TEACHER_TOKENS.pop(tk, None)
    return {"ok": True, "data": {"token": token, "expires_in": 12 * 3600}}


def require_teacher(token: Optional[str]) -> None:
    """教师接口鉴权：令牌无效直接 401（后端强制，不依赖前端按钮）。"""
    import os

    if not os.getenv("TEACHER_PASSWORD", "").strip():
        raise _err(503, "教师端未启用，请联系管理员配置教师密码")
    with _TEACHER_LOCK:
        issued = _TEACHER_TOKENS.get(token) if token else None
        if issued is None or time.time() - issued >= _TOKEN_TTL:
            _TEACHER_TOKENS.pop(token, None)
            raise _err(401, "需要教师登录（令牌无效或已过期）")


# ---------------------------------------------------------------- health
@router.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "data": describe_model()}


# ---------------------------------------------------------------- projects
@router.get("/projects")
def list_projects() -> Dict[str, Any]:
    return {"ok": True, "data": project_store.list_projects()}


class ProjectIn(BaseModel):
    name: str


@router.post("/projects")
def create_project(body: ProjectIn) -> Dict[str, Any]:
    try:
        return {"ok": True, "data": project_store.create_project(body.name)}
    except ProjectError as e:
        raise _err(400, str(e))


@router.get("/projects/{project}/files")
def list_files(project: str) -> Dict[str, Any]:
    try:
        return {"ok": True, "data": project_store.list_files(project)}
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))


@router.post("/projects/{project}/files")
async def upload_file(project: str, file: UploadFile = File(...)) -> Dict[str, Any]:
    acquired = False
    try:
        project_store.project_dir(project)
        acquired = _UPLOAD_SLOTS.acquire(blocking=False)
        if not acquired:
            raise HTTPException(status_code=429, detail="当前正在处理教材，请稍后重试上传", headers={"Retry-After": "5"})
        content = await file.read(config.MAX_UPLOAD_BYTES + 1)
        if len(content) > config.MAX_UPLOAD_BYTES:
            raise _err(413, f"文件超过大小上限 {config.MAX_UPLOAD_BYTES // (1024*1024)}MB")
        info = await run_in_threadpool(project_store.save_upload, project, file.filename or "", content)
        return {"ok": True, "data": info}
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    finally:
        if acquired:
            _UPLOAD_SLOTS.release()
        await file.close()


# ---------------------------------------------------------------- runs
@router.get("/projects/{project}/runs")
def list_runs(project: str) -> Dict[str, Any]:
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    return {"ok": True, "data": run_store.list_runs(project)}


class AnalyzeIn(BaseModel):
    target: str
    force: bool = False
    files: Optional[List[str]] = None


@router.post("/projects/{project}/analyze")
def analyze(project: str, body: AnalyzeIn) -> Dict[str, Any]:
    target = (body.target or "").strip()
    if not target:
        raise _err(400, "请输入目标章节，例如「第一章」或「8.3 一致收敛」")
    if len(target) > 120:
        raise _err(400, "章节名过长（≤120 字符）")
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    if body.files is not None:
        if not body.files:
            raise _err(400, "检索范围至少选择一个教材文件")
        input_dir = config.PROJECTS_DIR / project / "input"
        unknown = [f for f in body.files if not f or "/" in f or "\\" in f
                   or f.startswith(".") or not (input_dir / f).is_file()
                   or (input_dir / f).suffix.lower() not in config.ALLOWED_UPLOAD_EXTS]
        if unknown:
            raise _err(400, f"选择的教材文件不存在: {', '.join(unknown)}")
        if len(body.files) != len(set(body.files)):
            raise _err(400, "教材文件选择有重复")
    if not any(p.is_file() and p.suffix.lower() in config.ALLOWED_UPLOAD_EXTS
               for p in (config.PROJECTS_DIR / project / "input").glob("*")):
        raise _err(400, "请先上传教材，再开始章节分析")
    try:
        result = run_store.start_run(project, target, force=body.force,
                                     allowed_files=body.files)
    except run_store.RunConflict as e:
        raise HTTPException(status_code=409,
                            detail={"message": str(e), "run_id": e.run_id})
    except run_store.RunCapacityError as e:
        raise HTTPException(status_code=429, detail=str(e), headers={"Retry-After": "10"})
    except run_store.TargetCollision as e:
        raise _err(409, str(e))
    except DeepSeekError:
        raise _err(503, "模型服务尚未配置完成，请联系管理员；已有学习成果仍可浏览")
    return {"ok": True, "data": result}


@router.get("/projects/{project}/runs/{slug}/status")
def run_status(project: str, slug: str) -> Dict[str, Any]:
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    if not (config.PROJECTS_DIR / project / "workspace" / slug).exists() \
            and run_store.get_controller(project, slug) is None:
        raise _err(404, f"没有找到运行记录: {slug}")
    payload = run_store.project_status_payload(project, slug)
    return {"ok": True, "data": payload}


@router.get("/projects/{project}/runs/{slug}/result")
def run_result(project: str, slug: str) -> Dict[str, Any]:
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    if not run_store.read_state(project, slug):
        raise _err(404, f"没有找到运行记录: {slug}")
    return {"ok": True, "data": run_store.result_payload(project, slug)}


@router.post("/projects/{project}/runs/{slug}/cancel")
def cancel(project: str, slug: str) -> Dict[str, Any]:
    ok = run_store.cancel_run(project, slug)
    return {"ok": True, "data": {"cancelled": ok}}


# ---------------------------------------------------------------- 教师闭环：审核 / 批注 / 学情回流 / 题目干预
class ReviewIn(BaseModel):
    status: str = "draft"
    note: Optional[str] = None
    difficulty_note: Optional[str] = None
    teacher_confirmed: bool = False
    teacher_token: Optional[str] = None


@router.post("/projects/{project}/runs/{slug}/review")
def set_review(project: str, slug: str, body: ReviewIn,
               teacher_header: Optional[str] = Header(None, alias="X-Teacher-Token")) -> Dict[str, Any]:
    require_teacher(body.teacher_token or teacher_header)
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    if body.status not in ("draft", "needs_review", "approved", "published", "blocked"):
        raise _err(400, "status 必须是 draft/needs_review/approved/published/blocked")
    from ..store.teacher import set_review as do_set

    rev = do_set(project, slug, body.status, body.note, body.difficulty_note,
                 teacher_confirmed=body.teacher_confirmed)
    if rev.get("invalid_transition"):
        raise _err(409, "；".join(rev.get("reasons", [])))
    if rev.get("blocked"):
        raise _err(422, "发布被质量门控阻止：" + "；".join(rev.get("reasons", []))
                   + "。可先解决后重试，或教师确认后强制发布（teacher_confirmed）。")
    return {"ok": True, "data": rev}


class TeacherNoteIn(BaseModel):
    note: Optional[str] = None
    difficulty_note: Optional[str] = None
    task: Optional[str] = None
    teacher_token: Optional[str] = None


@router.post("/projects/{project}/runs/{slug}/teacher-note")
def teacher_note(project: str, slug: str, body: TeacherNoteIn,
                 teacher_header: Optional[str] = Header(None, alias="X-Teacher-Token")) -> Dict[str, Any]:
    require_teacher(body.teacher_token or teacher_header)
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    from ..store.teacher import add_teacher_task, set_review as do_set

    rev = None
    if body.note is not None or body.difficulty_note is not None:
        rev = do_set(project, slug, "draft", body.note, body.difficulty_note)
    if body.task:
        rev = add_teacher_task(project, slug, body.task)
    if rev is None:
        raise _err(400, "note/task 至少提供一项")
    return {"ok": True, "data": rev}


class QuestionPatchIn(BaseModel):
    patch: Dict[str, Any]
    teacher_token: Optional[str] = None


@router.delete("/projects/{project}/runs/{slug}/questions/{qid}")
def delete_question(project: str, slug: str, qid: str, teacher_token: Optional[str] = None,
                    teacher_header: Optional[str] = Header(None, alias="X-Teacher-Token")) -> Dict[str, Any]:
    require_teacher(teacher_token or teacher_header)
    from ..store.teacher import delete_question as do_delete

    try:
        return {"ok": True, "data": do_delete(project, slug, qid)}
    except ValueError as e:
        raise _err(400, str(e))


@router.post("/projects/{project}/runs/{slug}/questions/{qid}")
def update_question(project: str, slug: str, qid: str, body: QuestionPatchIn,
                    teacher_header: Optional[str] = Header(None, alias="X-Teacher-Token")) -> Dict[str, Any]:
    require_teacher(body.teacher_token or teacher_header)
    from ..store.teacher import TeacherValidationError, update_question as do_update

    try:
        return {"ok": True, "data": do_update(project, slug, qid, body.patch)}
    except TeacherValidationError as e:
        raise _err(422, str(e))
    except ValueError as e:
        raise _err(404, str(e))


class LearningReportIn(BaseModel):
    data: Dict[str, Any]


@router.post("/projects/{project}/runs/{slug}/learning-reports")
def submit_learning_report(project: str, slug: str, body: LearningReportIn) -> Dict[str, Any]:
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    from ..store.teacher import save_learning_report as do_save
    if not run_store.read_state(project, slug):
        raise _err(404, "章节不存在，请先打开已生成的学习成果")
    if len(json.dumps(body.data, ensure_ascii=False).encode("utf-8")) > 1024 * 1024:
        raise _err(413, "学情报告过大，请减少内容后重新提交")
    from ..store.teacher import TeacherValidationError
    try:
        from ..store.teacher import _validate_report
        _validate_report(body.data)
        if run_store.result_payload(project, slug, include_markdown=False)["review"].get("status") != "published":
            raise _err(409, "本章尚未正式发布，预览学习记录保存在本机，不计入教师学情")
        return {"ok": True, "data": do_save(project, slug, body.data)}
    except TeacherValidationError as e:
        raise _err(422, str(e))


@router.get("/projects/{project}/runs/{slug}/learning-reports")
def list_learning_reports(project: str, slug: str, teacher_token: Optional[str] = None,
                          teacher_header: Optional[str] = Header(None, alias="X-Teacher-Token")) -> Dict[str, Any]:
    require_teacher(teacher_token or teacher_header)
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    from ..store.teacher import list_learning_reports as do_list

    return {"ok": True, "data": do_list(project, slug)}


class PlanPatchIn(BaseModel):
    patch: Dict[str, Any]
    teacher_token: Optional[str] = None


@router.post("/projects/{project}/runs/{slug}/learning-plan")
def update_learning_plan(project: str, slug: str, body: PlanPatchIn,
                         teacher_header: Optional[str] = Header(None, alias="X-Teacher-Token")) -> Dict[str, Any]:
    require_teacher(body.teacher_token or teacher_header)
    from ..store.teacher import TeacherValidationError, update_learning_plan as do_update

    try:
        return {"ok": True, "data": do_update(project, slug, body.patch)}
    except TeacherValidationError as e:
        raise _err(422, str(e))
    except ValueError as e:
        raise _err(404, str(e))


# ---------------------------------------------------------------- raw files (JSON/MD 查看)
@router.get("/projects/{project}/runs/{slug}/files/{filename}")
def raw_file(project: str, slug: str, filename: str) -> Dict[str, Any]:
    try:
        project_store.project_dir(project)
    except ProjectNotFound as e:
        raise _err(404, str(e))
    except ProjectError as e:
        raise _err(400, str(e))
    if "/" in filename or ".." in filename or not filename.endswith((".json", ".md", ".jsonl")):
        raise _err(400, "仅允许查看 .json/.md/.jsonl 文件")
    for base in (config.PROJECTS_DIR / project / "workspace" / slug,
                 config.PROJECTS_DIR / project / "output" / slug):
        f = base / filename
        if f.is_file():
            try:
                if f.stat().st_size > 8 * 1024 * 1024:
                    raise _err(413, "该文件过大，请使用进度面板查看最新日志，或联系管理员导出完整文件")
                content = f.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                raise _err(400, "文件无法以文本读取")
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError:
                parsed = None
            return {"ok": True, "data": {"filename": filename, "content": content,
                                         "json": parsed}}
    raise _err(404, f"文件不存在: {filename}")
