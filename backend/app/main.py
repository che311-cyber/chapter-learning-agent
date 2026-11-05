"""Chapter Learning Agent 后端入口：FastAPI 应用。

启动：python -m uvicorn app.main:app --port 8000（见 start.sh）
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config
from .api.routes import router
from .store.teacher import TeacherBusyError

config.ensure_dirs()

app = FastAPI(title="Chapter Learning Agent", version="1.0.0")

# 允许的前端来源：本地开发默认 + .env 里 ALLOWED_ORIGINS 追加（部署后填 pages.dev 域名）
_EXTRA_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
        "http://localhost:4173", "http://127.0.0.1:4173",
        *_EXTRA_ORIGINS,
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def private_network_header(request: Request, call_next):
    """Chrome 的 Private Network Access：允许 https 部署页访问本机/内网后端。

    该中间件位于 CORS 之外（后添加者先执行），确保预检响应也带此头。
    """
    resp = await call_next(request)
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp


app.include_router(router)


@app.exception_handler(TeacherBusyError)
async def teacher_busy(_req, exc):
    return JSONResponse(status_code=409, content={"ok": False, "error": str(exc)})


@app.exception_handler(Exception)
async def unhandled(_req, exc: Exception):
    # 不泄漏堆栈与敏感信息
    logging.exception("未处理异常")
    return JSONResponse(status_code=500,
                        content={"ok": False, "error": f"服务器内部错误（{type(exc).__name__}），请查看后端日志"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
