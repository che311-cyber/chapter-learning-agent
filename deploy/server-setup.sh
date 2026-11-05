#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Chapter Learning Agent 服务器一键部署脚本
# 在【服务器上】以 root 执行。前提：已通过 scp 把两样东西传到服务器
#   /opt/upload/frontend-dist/   ← 本地 frontend/dist 的内容
#   /opt/upload/backend/         ← 本地 backend 目录（含 app/ 与 requirements.txt）
# ═══════════════════════════════════════════════════════════
set -euo pipefail

echo "==> 1/6 系统依赖（Ubuntu/Debian）"
if command -v apt-get >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq python3-venv python3-pip nginx curl rsync
elif command -v dnf >/dev/null; then
  dnf install -y python3 python3-pip nginx curl rsync
elif command -v yum >/dev/null; then
  yum install -y python3 python3-pip nginx curl rsync
else
  echo "请手动安装 python3 / nginx"; exit 1
fi

echo "==> 2/6 目录与代码"
mkdir -p /opt/chapter-agent/frontend
rsync -a /opt/upload/frontend-dist/ /opt/chapter-agent/frontend/dist/
rsync -a --exclude venv --exclude __pycache__ /opt/upload/backend/ /opt/chapter-agent/backend/
rsync -a /opt/upload/prompts/ /opt/chapter-agent/prompts/
if [ -d /opt/upload/projects ]; then
  rsync -a --ignore-existing /opt/upload/projects/ /opt/chapter-agent/projects/
fi

echo "==> 3/6 Python 环境"
cd /opt/chapter-agent/backend
[ -x venv/bin/python ] || python3 -m venv venv
./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -q -r requirements.txt

echo "==> 4/6 .env（模型与教师配置）"
if [ ! -f /opt/chapter-agent/.env ]; then
  install -m 600 /opt/upload/.env.example /opt/chapter-agent/.env
  echo "   已生成环境模板：请在 /opt/chapter-agent/.env 中填入自己的密钥，随后重启后端。"
fi

echo "==> 5/6 systemd 后端服务"
cp /opt/upload/chapter-agent-backend.service /etc/systemd/system/ 2>/dev/null || true
cat > /etc/systemd/system/chapter-agent-backend.service <<'UNIT'
[Unit]
Description=Chapter Learning Agent Backend (FastAPI)
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/chapter-agent/backend
ExecStart=/opt/chapter-agent/backend/venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now chapter-agent-backend

echo "==> 6/6 nginx"
cp /opt/upload/nginx-chapter-agent.conf /etc/nginx/conf.d/chapter-agent.conf 2>/dev/null || true
if [ ! -f /etc/nginx/conf.d/chapter-agent.conf ] && [ -d /etc/nginx/sites-enabled ]; then
  cp /opt/upload/nginx-chapter-agent.conf /etc/nginx/sites-available/chapter-agent.conf
  ln -sf /etc/nginx/sites-available/chapter-agent.conf /etc/nginx/sites-enabled/chapter-agent.conf
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t && systemctl reload nginx

# 2G 内存保险：加 1G swap
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

sleep 2
echo "── 自检 ──"
curl -s http://127.0.0.1:8000/api/health && echo
curl -s -o /dev/null -w "nginx 前端: %{http_code}\n" http://127.0.0.1/
IP=$(curl -s ifconfig.me || echo "服务器IP")
echo
echo "✅ 部署完成：http://$IP/"
echo "   如需 HTTPS：apt install certbot python3-certbot-nginx && certbot --nginx -d 你的域名"
