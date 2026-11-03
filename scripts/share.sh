#!/usr/bin/env bash
# 通过隧道把本机的 StruBrowser 临时暴露到公网（无需公网服务器/公网 IP）。
# 用法：./scripts/share.sh [cloudflared|ngrok]
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
PROVIDER="${1:-cloudflared}"

info() { printf '\033[36m[share]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[share]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[share]\033[0m %s\n' "$*" >&2; exit 1; }

if ! curl -sf --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  fail "本机 ${PORT} 端口上没有运行 StruBrowser。先执行：./start.sh prod"
fi

warn "注意：隧道会把服务暴露到公网。请使用强密码，创建管理员后建议关闭开放注册"
warn "（STRU_ALLOW_REGISTER=0），并保持这台电脑开机、不休眠、网络稳定。"

case "$PROVIDER" in
  cloudflared)
    CF_BIN="$(command -v cloudflared 2>/dev/null || true)"
    if [ -z "$CF_BIN" ] && [ -x ".tools/cloudflared" ]; then
      CF_BIN=".tools/cloudflared"
    fi
    if [ -z "$CF_BIN" ]; then
      cat <<'TIP'
未安装 cloudflared。任选一种安装：
  macOS:   brew install cloudflared
  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
安装后重新运行：./scripts/share.sh cloudflared
TIP
      exit 1
    fi
    info "正在创建临时公网地址（Ctrl+C 结束）…"
    info "输出里形如 https://xxxx.trycloudflare.com 的地址就是给别人访问的链接。"
    exec "$CF_BIN" tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate
    ;;
  ngrok)
    if ! command -v ngrok >/dev/null 2>&1; then
      cat <<'TIP'
未安装 ngrok。安装并配置 token：
  macOS:   brew install ngrok/ngrok/ngrok
  然后：   ngrok config add-authtoken <你的 token>
安装后重新运行：./scripts/share.sh ngrok
TIP
      exit 1
    fi
    info "正在创建临时公网地址（Ctrl+C 结束）…"
    exec ngrok http "$PORT"
    ;;
  *)
    fail "用法：./scripts/share.sh [cloudflared|ngrok]"
    ;;
esac
