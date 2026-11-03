#!/usr/bin/env bash
# StruBrowser 一键启动
#   ./start.sh                开发模式：API(8787) + Web(5173)，自动打开浏览器
#   ./start.sh prod           生产模式：构建后用单端口(8787)运行
#   STRU_NO_OPEN=1 ./start.sh 不自动打开浏览器
#   PORT=9000 WEB_PORT=9001 ./start.sh  自定义端口
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
MODE="${1:-dev}"
RESTART=0
if [ "$MODE" = "restart" ] || [ "$MODE" = "--restart" ]; then
  MODE="dev"
  RESTART=1
fi
LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

info() { printf '\033[36m[start]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[start]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[start]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 环境检查 ----------

[ -f package.json ] || fail "请在 StruBrowser 项目根目录运行此脚本"
command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请先安装 Node ≥ 22.5"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || fail "Node 版本过低（当前 $(node -v)），需要 ≥ 22.5（内置 node:sqlite）"
command -v npm >/dev/null 2>&1 || fail "未找到 npm"

if [ ! -d node_modules ]; then
  info "首次运行，安装前端依赖（npm install）…"
  npm install
fi

if [ ! -x server/convert/.venv/bin/python ] && [ ! -x server/convert/.venv/Scripts/python.exe ]; then
  warn "未安装 STEP 服务端转换器（可选）。需要 STEP 保留面颜色时运行：npm run setup:step"
fi

# ---------- 工具函数 ----------

# 端口被占用返回 0，空闲返回 1
port_busy() {
  node -e '
    const net = require("net");
    const server = net.createServer();
    server.once("error", () => process.exit(0));
    server.once("listening", () => server.close(() => process.exit(1)));
    server.listen(Number(process.argv[1]), "127.0.0.1");
  ' "$1"
}

find_free_port() {
  node -e '
    const net = require("net");
    let port = Number(process.argv[1]);
    (function attempt() {
      const server = net.createServer();
      server.once("error", () => { port += 1; attempt(); });
      server.once("listening", () => server.close(() => { console.log(port); }));
      server.listen(port, "127.0.0.1");
    })();
  ' "$1"
}

wait_http() {
  local url="$1"
  local tries="${2:-80}"
  while [ "$tries" -gt 0 ]; do
    if curl -sf --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
    tries=$((tries - 1))
  done
  return 1
}

api_alive() {
  curl -sf --max-time 2 "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1
}

# 只重启 StruBrowser 自己的服务端（先确认 /api/health 是我们的服务）
stop_server() {
  if ! api_alive; then return 0; fi
  info "停止旧服务端（端口 ${API_PORT}）…"
  local pids
  pids=$(lsof -ti tcp:"${API_PORT}" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  else
    pkill -f "node --experimental-sqlite server/index.js" 2>/dev/null || true
  fi
  local tries=20
  while [ "$tries" -gt 0 ] && api_alive; do
    sleep 0.3
    tries=$((tries - 1))
  done
}

# 停止本项目的 Vite 开发服务器（用页面特征识别，避免误杀其它程序）
stop_web() {
  local port="$1"
  command -v curl >/dev/null 2>&1 || return 0
  local html
  html=$(curl -sf --max-time 2 "http://127.0.0.1:${port}/" 2>/dev/null || true)
  case "$html" in
    *'/src/main.tsx'*)
      info "停止旧前端（端口 ${port}）…"
      local pids
      pids=$(lsof -ti tcp:"${port}" 2>/dev/null || true)
      if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
      ;;
  esac
}

# 复用旧服务端时检查功能版本
check_server_features() {
  local health
  health=$(curl -sf --max-time 2 "http://127.0.0.1:${API_PORT}/api/health" 2>/dev/null || true)
  case "$health" in
    *'"features":'*'ai'*) : ;;
    *) warn "检测到旧版服务端（缺少 AI 接口）。运行 ./start.sh restart 可重启到最新代码" ;;
  esac
}

open_browser() {
  local url="$1"
  [ "${STRU_NO_OPEN:-0}" = "1" ] && return 0
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  else
    warn "未找到浏览器启动命令，请手动打开 $url"
  fi
}

# ---------- 进程与清理 ----------

PIDS=()
TAIL_PIDS=()

cleanup() {
  trap - EXIT INT TERM
  echo
  info "正在停止 StruBrowser…"
  for pid in ${TAIL_PIDS[@]+"${TAIL_PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  info "已停止"
}
trap cleanup EXIT INT TERM

# ---------- 生产模式 ----------

API_PORT="${PORT:-8787}"

if [ "$MODE" = "prod" ] || [ "$MODE" = "--prod" ]; then
  if [ "$RESTART" = "1" ]; then stop_server; fi
  if api_alive; then
    info "端口 ${API_PORT} 上已有 StruBrowser 服务，切换到生产模式…"
    stop_server
  fi
  if port_busy "$API_PORT"; then
    fail "端口 ${API_PORT} 被其他程序占用，请用 PORT=其他端口 ./start.sh prod"
  fi

  info "构建前端…"
  npm run build

  info "启动服务端（单端口）…"
  PORT="$API_PORT" NODE_ENV=production node --experimental-sqlite server/index.js > "$LOG_DIR/server.log" 2>&1 &
  PIDS+=($!)

  wait_http "http://127.0.0.1:${API_PORT}/api/health" || {
    tail -n 30 "$LOG_DIR/server.log" || true
    fail "服务端启动失败，详见 .logs/server.log"
  }

  URL="http://127.0.0.1:${API_PORT}/"
  open_browser "$URL"
  printf '\n  StruBrowser 已启动（生产模式）\n  Web/API : %s\n  局域网  : 见服务端日志中的 http://<内网IP>:%s（需防火墙放行）\n  日志    : .logs/server.log\n  停止    : Ctrl+C\n  公网部署: docs/DEPLOY.md\n\n' "$URL" "$API_PORT"
  # tail 放后台，前台用 wait（可被信号打断，保证 trap 能清理子进程）
  tail -n +1 -f "$LOG_DIR/server.log" &
  TAIL_PIDS+=($!)
  wait ${TAIL_PIDS[0]}
  exit 0
fi

# ---------- 开发模式 ----------

if [ "$RESTART" = "1" ]; then
  stop_server
  stop_web 5173
  stop_web 5174
fi
if api_alive; then
  info "API 已在 ${API_PORT} 运行，直接复用"
  check_server_features
else
  if port_busy "$API_PORT"; then
    fail "端口 ${API_PORT} 被占用；可运行 PORT=9000 ./start.sh 换端口"
  fi
  info "启动 API（${API_PORT}）…"
  PORT="$API_PORT" node --experimental-sqlite server/index.js > "$LOG_DIR/server.log" 2>&1 &
  PIDS+=($!)
  wait_http "http://127.0.0.1:${API_PORT}/api/health" || {
    tail -n 30 "$LOG_DIR/server.log" || true
    fail "API 启动失败，详见 .logs/server.log"
  }
fi

WEB_PORT="${WEB_PORT:-$(find_free_port 5173)}"
info "启动 Web（${WEB_PORT}）…"
STRU_API_URL="http://127.0.0.1:${API_PORT}" ./node_modules/.bin/vite --port "$WEB_PORT" --strictPort --host 127.0.0.1 > "$LOG_DIR/web.log" 2>&1 &
PIDS+=($!)

wait_http "http://127.0.0.1:${WEB_PORT}/" || {
  tail -n 30 "$LOG_DIR/web.log" || true
  fail "Web 启动失败，详见 .logs/web.log"
}

URL="http://127.0.0.1:${WEB_PORT}/"
open_browser "$URL"
printf '\n  StruBrowser 已启动\n  Web : %s\n  API : http://127.0.0.1:%s/api/health\n  日志: .logs/web.log  .logs/server.log\n  提示: 首次使用请注册账号；Ctrl+C 停止\n\n' "$URL" "$API_PORT"

# 同时跟踪两份日志（有服务端日志时）
if [ -f "$LOG_DIR/server.log" ] && [ "${#PIDS[@]}" -gt 1 ]; then
  tail -n +1 -f "$LOG_DIR/server.log" "$LOG_DIR/web.log" &
else
  tail -n +1 -f "$LOG_DIR/web.log" &
fi
TAIL_PIDS+=($!)
wait ${TAIL_PIDS[0]}
