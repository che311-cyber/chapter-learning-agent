#!/usr/bin/env bash
# Chapter Agent 常驻服务辅助脚本（launchd 由这些脚本驱动）
#   scripts/agent-backend.sh   启动 FastAPI 后端（8000）
#   scripts/agent-tunnel.sh    启动 cloudflared 快速隧道并把地址写入 ~/.chapter-agent/tunnel-url
set -euo pipefail
MODE="${1:-}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.chapter-agent"
mkdir -p "$STATE_DIR"

case "$MODE" in
  backend)
    cd "$DIR/backend"
    # 确保 venv 存在
    [ -x venv/bin/python ] || python3 -m venv venv
    [ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
    exec ./venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
    ;;
  tunnel)
    CFD="$(command -v cloudflared || true)"
    [ -n "$CFD" ] || { echo "请先安装 cloudflared 并将其加入 PATH" >&2; exit 1; }
    # 先清理旧的隧道进程与 URL
    pkill -f "cloudflared tunnel --url http://127.0.0.1:8000" 2>/dev/null || true
    rm -f "$STATE_DIR/tunnel-url" "$STATE_DIR/tunnel.log"
    sleep 1
    "$CFD" tunnel --url http://127.0.0.1:8000 --logfile "$STATE_DIR/tunnel.log" > /dev/null 2>&1 &
    TUNNEL_PID=$!
    # 最多等 40s 提取 trycloudflare 地址
    for _ in $(seq 1 40); do
      URL=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" "$STATE_DIR/tunnel.log" 2>/dev/null | head -1 || true)
      if [ -n "$URL" ]; then
        echo -n "$URL" > "$STATE_DIR/tunnel-url"
        # 常驻：每 30s 检查隧道是否还活着，日志里出现新地址就更新
        while kill -0 "$TUNNEL_PID" 2>/dev/null; do
          sleep 30
          NEW=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" "$STATE_DIR/tunnel.log" 2>/dev/null | tail -1 || true)
          [ -n "$NEW" ] && [ "$NEW" != "$URL" ] && { URL="$NEW"; echo -n "$URL" > "$STATE_DIR/tunnel-url"; }
        done
        exit 0
      fi
      sleep 1
    done
    echo "tunnel URL 提取失败，见 $STATE_DIR/tunnel.log" >&2
    exit 1
    ;;
  *)
    echo "用法: agent.sh [backend|tunnel]" >&2
    exit 1
    ;;
esac
