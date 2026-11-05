#!/usr/bin/env bash
# 生成可分发部署包；真实 .env 始终在目标服务器单独配置。
set -euo pipefail
cd "$(dirname "$0")/.."
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
STAGE="$TEMP_DIR/upload"
mkdir -p "$STAGE/frontend-dist" "$STAGE/backend"
cp -r frontend/dist/. "$STAGE/frontend-dist/"
cp -r backend/app backend/requirements.txt "$STAGE/backend/"
cp .env.example "$STAGE/.env.example"
cp -r prompts "$STAGE/prompts"
mkdir -p "$STAGE/projects/abstract-algebra/input"
cp projects/abstract-algebra/input/sample_abstract_algebra.md "$STAGE/projects/abstract-algebra/input/"
cp deploy/server-setup.sh deploy/nginx-chapter-agent.conf deploy/chapter-agent-backend.service "$STAGE/"
mkdir -p dist
tar --exclude='.DS_Store' --exclude='._*' --exclude='__pycache__' --exclude='*.pyc' \
  -czf dist/chapter-agent-server-upload.tar.gz -C "$TEMP_DIR" upload
echo "已生成 dist/chapter-agent-server-upload.tar.gz（不含真实密钥）"
