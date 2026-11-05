#!/usr/bin/env bash
# 部署前端到 Cloudflare Pages（直传模式，需已 `npx wrangler login`）
#
# 用法：
#   ./deploy-pages.sh                       # 构建并部署（后端地址 = 同源 /api）
#   VITE_API_BASE=https://xxx.trycloudflare.com ./deploy-pages.sh
#                                           # 构建时写死后端地址（也可部署后在页面右上角徽章里设置）
#
# 后端不在 Cloudflare 上（Python/FastAPI + 本地文件系统）。
# 部署后需让后端放行 pages.dev 域名：在 .env 加
#   ALLOWED_ORIGINS=https://chapter-learning-agent.pages.dev
set -euo pipefail
cd "$(dirname "$0")/frontend"

echo "==> 构建前端…"
if [ -n "${VITE_API_BASE:-}" ]; then
  VITE_API_BASE="$VITE_API_BASE" npm run build
else
  npm run build
fi

echo "==> 部署到 Cloudflare Pages（项目 chapter-learning-agent）…"
npx wrangler pages deploy dist --project-name chapter-learning-agent

echo
echo "✅ 部署完成。首次部署后请把返回的 pages.dev 域名加进根目录 .env："
echo "   ALLOWED_ORIGINS=https://<你的域名>.pages.dev"
echo "   然后重启后端（./start.sh backend）。"
