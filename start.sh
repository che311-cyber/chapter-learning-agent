#!/usr/bin/env bash
# Chapter Learning Agent 一键启动脚本
#   ./start.sh          启动 backend(8000) + frontend(5173)
#   ./start.sh backend  只启动 backend
#   ./start.sh frontend 只启动 frontend
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-all}"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️  已从 .env.example 生成 .env —— 请填入你的 DEEPSEEK_API_KEY 后重新运行"
  exit 1
fi

if ! grep -q '^DEEPSEEK_API_KEY=sk' .env 2>/dev/null; then
  echo "⚠️  .env 中未设置 DEEPSEEK_API_KEY（形如 DEEPSEEK_API_KEY=sk-xxxx），请填写后重试"
  exit 1
fi

# ---------- Backend ----------
start_backend() {
  echo "==> 初始化 Python 虚拟环境…"
  cd backend
  if [ ! -x venv/bin/python ]; then
    python3 -m venv venv
  fi
  ./venv/bin/pip install -q -r requirements.txt
  echo "==> 启动 Backend: http://127.0.0.1:8000  (API 文档 /docs)"
  ./venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
}

# ---------- Frontend ----------
start_frontend() {
  echo "==> 安装前端依赖…"
  cd frontend
  [ -d node_modules ] || npm install --silent
  echo "==> 启动 Frontend: http://localhost:5173"
  npm run dev
}

case "$MODE" in
  backend)  start_backend ;;
  frontend) start_frontend ;;
  all)
    start_backend &
    BACK_PID=$!
    trap 'kill $BACK_PID 2>/dev/null || true' EXIT
    start_frontend
    ;;
  *) echo "用法: ./start.sh [all|backend|frontend]"; exit 1 ;;
esac
