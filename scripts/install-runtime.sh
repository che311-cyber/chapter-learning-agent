#!/usr/bin/env bash
# 把 Desktop 上的开发副本部署到运行时目录（launchd 从这里跑，绕过 macOS 桌面目录 TCC 限制）
#   ./scripts/install-runtime.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="$HOME/.chapter-agent/app"

mkdir -p "$DST"
# 同步后端/资料/Prompt/配置（排除 venv 与前端产物）
rsync -a --delete \
  --exclude 'backend/venv/' --exclude 'frontend/' --exclude '.git/' \
  --exclude '__pycache__/' --exclude '*.pyc' --exclude '.pytest_cache/' \
  "$SRC/backend" "$SRC/projects" "$SRC/prompts" "$SRC/scripts" \
  "$SRC/.env" "$SRC/.env.example" "$DST/"

# 运行时独立 venv（绝对路径绑定，不能直接拷贝）
if [ ! -x "$DST/backend/venv/bin/python" ]; then
  echo "==> 初始化运行时 venv…"
  python3 -m venv "$DST/backend/venv"
  "$DST/backend/venv/bin/pip" install -q -r "$DST/backend/requirements.txt"
fi
echo "✅ 运行时已部署: $DST"
