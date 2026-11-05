"""FastAPI 路由测试（TestClient）。"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fastapi.testclient import TestClient

from app import config
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path)
    config.ensure_dirs()
    return TestClient(app)


def _mk_project(client, name="p1", with_file=True):
    r = client.post("/api/projects", json={"name": name})
    assert r.status_code == 200
    if with_file:
        content = "# 书\n\n# 第一章 群\n\n群是……\n" * 30
        r = client.post(f"/api/projects/{name}/files",
                        files={"file": ("book.md", content.encode(), "text/markdown")})
        assert r.status_code == 200


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "model" in body["data"]


def test_project_crud_and_validation(client):
    assert client.get("/api/projects").status_code == 200
    r = client.post("/api/projects", json={"name": "bad/../name"})
    assert r.status_code == 400
    r = client.post("/api/projects", json={"name": "p1"})
    assert r.status_code == 200
    r = client.post("/api/projects", json={"name": "p1"})  # 重复
    assert r.status_code == 400


def test_upload_ok_dup_and_bad_type(client):
    _mk_project(client, "up")
    # 重复上传同名文件被拒绝（保护原始资料）
    r = client.post("/api/projects/up/files",
                    files={"file": ("book.md", b"x", "text/markdown")})
    assert r.status_code == 400 and "不会覆盖" in r.json()["detail"]
    # 不支持的类型
    r = client.post("/api/projects/up/files",
                    files={"file": ("evil.exe", b"MZ", "application/octet-stream")})
    assert r.status_code == 400
    # 未知项目
    r = client.post("/api/projects/ghost/files",
                    files={"file": ("a.md", b"x", "text/markdown")})
    assert r.status_code == 404


def test_analyze_validation(client):
    _mk_project(client, "an")
    # 空目标
    r = client.post("/api/projects/an/analyze", json={"target": "  "})
    assert r.status_code == 400
    # 未知项目
    r = client.post("/api/projects/ghost/analyze", json={"target": "第一章"})
    assert r.status_code == 404


def test_runs_endpoints_404(client):
    assert client.get("/api/projects/p1/runs/第一章/status").status_code == 404
    assert client.get("/api/projects/p1/runs/第一章/result").status_code == 404


def test_raw_file_endpoint_blocks_traversal(client):
    _mk_project(client, "rf")
    r = client.get("/api/projects/rf/runs/第一章/files/..%2F..%2F.env")
    assert r.status_code in (400, 404)
    r = client.get("/api/projects/rf/runs/x/files/../../.env")
    assert r.status_code in (400, 404)
