#!/usr/bin/env bash
# 一键把 StruBrowser 通过隧道暴露到公网，供外部访问。
#
#   ./scripts/tunnel.sh                 默认 cloudflared，必要时自动起生产服务
#   ./scripts/tunnel.sh ngrok           换 ngrok（需先 ngrok config add-authtoken）
#   ./scripts/tunnel.sh --port 9000     指定本机端口
#   ./scripts/tunnel.sh --no-start      只建隧道，要求服务已在跑
#   ./scripts/tunnel.sh --build         强制重新构建前端
#   ./scripts/tunnel.sh --install       下载 cloudflared 到 .tools/（无需 brew）
#   ./scripts/tunnel.sh --keep          退出时保留本脚本启动的服务
#   ./scripts/tunnel.sh --open          拿到地址后用默认浏览器打开
#
# 也可以双击项目根目录的「启动隧道.command」，或：./start.sh tunnel / npm run tunnel
#
# 隧道只是把 Cloudflare / ngrok 的边缘节点当作中转，流量仍然回到这台电脑：
# 关机、休眠、断网都会让公网地址失效；临时地址每次重启都会变。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PROVIDER="${TUNNEL_PROVIDER:-cloudflared}"
PORT="${PORT:-8787}"
AUTO_START=1
FORCE_BUILD=0
DO_INSTALL=0
KEEP_SERVER=0
OPEN_BROWSER=0
LOG_DIR="$ROOT/.logs"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
URL_FILE="$LOG_DIR/tunnel-url.txt"
SERVER_LOG="$LOG_DIR/server.log"

FAILED=0
info() { printf '\033[36m[tunnel]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[tunnel]\033[0m %s\n' "$*"; }
fail() { FAILED=1; printf '\033[31m[tunnel]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'TXT'
用法：./scripts/tunnel.sh [cloudflared|ngrok] [选项]

选项：
  --port <n>     本机端口（默认 8787，也可用环境变量 PORT）
  --no-start     不复用/不启动本地服务，只建隧道
  --build        强制 npm run build 后再起服务
  --install      下载 cloudflared 到 .tools/（macOS/Linux，无需 brew；已装则跳过）
  --keep         Ctrl+C 时保留由本脚本启动的服务端
  --open         拿到地址后用默认浏览器打开
  -h, --help     显示本帮助

示例：
  ./scripts/tunnel.sh                    # 最常用：一条命令起服务 + 公网地址
  ./scripts/tunnel.sh ngrok              # 走 ngrok
  ./scripts/tunnel.sh --install          # 先装 cloudflared，再跑一次本命令
TXT
}

while [ $# -gt 0 ]; do
  case "$1" in
    cloudflared|ngrok) PROVIDER="$1" ;;
    --port) PORT="${2:?--port 需要端口号}"; shift ;;
    --port=*) PORT="${1#*=}" ;;
    --no-start) AUTO_START=0 ;;
    --build) FORCE_BUILD=1 ;;
    --install) DO_INSTALL=1 ;;
    --keep) KEEP_SERVER=1 ;;
    --open) OPEN_BROWSER=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; fail "未知参数：$1" ;;
  esac
  shift
done

mkdir -p "$LOG_DIR"
rm -f "$URL_FILE"

# ---------- 基础检查 ----------

command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请先安装 Node ≥ 22.5"
[ -f package.json ] || fail "请在 StruBrowser 项目根目录运行此脚本"

if [ ! -d node_modules ]; then
  info "首次运行，安装依赖（npm install）…"
  npm install
fi

# ---------- cloudflared 安装 ----------

install_cloudflared() {
  local os arch asset url tmpdir
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64)  asset="cloudflared-darwin-arm64.tgz" ;;
    Darwin/x86_64) asset="cloudflared-darwin-amd64.tgz" ;;
    Linux/x86_64)  asset="cloudflared-linux-amd64" ;;
    Linux/aarch64|Linux/arm64) asset="cloudflared-linux-arm64" ;;
    *) fail "不支持的平台 $os/$arch，请手动安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" ;;
  esac
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}"
  mkdir -p .tools
  tmpdir="$(mktemp -d)"
  info "下载 cloudflared（${asset}）…"
  command -v curl >/dev/null 2>&1 || fail "需要 curl 才能下载"
  curl -fL --progress-bar "$url" -o "$tmpdir/$asset" || fail "下载失败：$url"
  case "$asset" in
    *.tgz) tar -xzf "$tmpdir/$asset" -C "$tmpdir" >/dev/null 2>&1 || fail "解压失败" ;;
    *) mv "$tmpdir/$asset" "$tmpdir/cloudflared" ;;
  esac
  mv "$tmpdir/cloudflared" .tools/cloudflared
  chmod +x .tools/cloudflared
  rm -rf "$tmpdir"
  ./.tools/cloudflared --version >/dev/null 2>&1 || fail "下载的 cloudflared 无法运行"
  info "已安装到 .tools/cloudflared（$(./.tools/cloudflared --version 2>/dev/null | head -1)）"
}

find_cloudflared() {
  local bin
  bin="$(command -v cloudflared 2>/dev/null || true)"
  if [ -z "$bin" ] && [ -x "$ROOT/.tools/cloudflared" ]; then
    bin="$ROOT/.tools/cloudflared"
  fi
  printf '%s' "$bin"
}

if [ "$DO_INSTALL" = "1" ]; then
  if [ -n "$(find_cloudflared)" ]; then
    info "cloudflared 已就绪（$(find_cloudflared)），跳过下载"
  else
    install_cloudflared
  fi
  echo
fi

# ---------- 探测本地服务 ----------

# 0 = 是我们的服务；1 = 端口没人听；2 = 端口被别的 HTTP 服务占着
probe() {
  node -e '
    (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${process.argv[1]}/api/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) process.exit(2);
        const data = await res.json().catch(() => null);
        process.exit(data && data.service === "strubrowser-server" ? 0 : 2);
      } catch {
        process.exit(1);
      }
    })();
  ' "$1"
}

health_field() {
  node -e '
    (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${process.argv[1]}/api/health`, {
          signal: AbortSignal.timeout(1500),
        });
        const data = await res.json();
        process.stdout.write(String(data?.[process.argv[2]] ?? ""));
      } catch { /* 忽略 */ }
    })();
  ' "$1" "$2"
}

port_busy() {
  node -e '
    const net = require("net");
    const server = net.createServer();
    server.once("error", () => process.exit(0));
    server.once("listening", () => server.close(() => process.exit(1)));
    server.listen(Number(process.argv[1]), "127.0.0.1");
  ' "$1"
}

wait_http() {
  local tries="${2:-120}"
  while [ "$tries" -gt 0 ]; do
    if probe "$1" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
    tries=$((tries - 1))
  done
  return 1
}

# dist 比 src/ 旧（或压根没构建）就需要重新构建
dist_stale() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    const index = path.join(root, "dist", "index.html");
    if (!fs.existsSync(index)) process.exit(0);
    const built = fs.statSync(index).mtimeMs;
    let newest = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|css|html)$/.test(entry.name)) {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        }
      }
    };
    try { walk(path.join(root, "src")); } catch { process.exit(1); }
    process.exit(newest > built ? 0 : 1);
  ' "$ROOT"
}

# ---------- 进程与清理 ----------

STARTED_SERVER=0
SERVER_PID=""
TUNNEL_PID=""
OWN_PID_FILE="$LOG_DIR/tunnel-server.pid"

cleanup() {
  trap - EXIT INT TERM HUP
  echo
  # 先删地址文件，后面即使卡住也不会留下「看起来还能用」的旧链接
  rm -f "$URL_FILE"
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    info "关闭隧道…"
    kill "$TUNNEL_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6; do
      kill -0 "$TUNNEL_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [ "$STARTED_SERVER" = "1" ]; then
    if [ "$KEEP_SERVER" != "1" ]; then
      if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        info "停止本地服务（端口 ${PORT}）…"
        kill "$SERVER_PID" 2>/dev/null || true
        for _ in 1 2 3 4 5 6; do
          kill -0 "$SERVER_PID" 2>/dev/null || break
          sleep 0.5
        done
        kill -9 "$SERVER_PID" 2>/dev/null || true
      fi
    else
      warn "本地服务仍在运行（--keep）：http://127.0.0.1:${PORT}/，PID $(cat "$OWN_PID_FILE" 2>/dev/null || echo "$SERVER_PID")"
    fi
    # pid 文件一律删掉：--keep 留下的服务不该被下次运行当孤儿收走
    rm -f "$OWN_PID_FILE"
  fi
  if [ "$FAILED" = "0" ]; then
    info "已退出，公网地址已失效"
  fi
}
trap cleanup EXIT INT TERM HUP

# ---------- 隧道客户端检查（先查，避免白构建） ----------

CF_BIN=""
NGROK_BIN=""
case "$PROVIDER" in
  cloudflared)
    CF_BIN="$(find_cloudflared)"
    if [ -z "$CF_BIN" ]; then
      cat <<'TIP'
未安装 cloudflared。任选一种：
  自动下载：  ./scripts/tunnel.sh --install
  Homebrew：  brew install cloudflared
  官网：      https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
TIP
      exit 1
    fi
    ;;
  ngrok)
    NGROK_BIN="$(command -v ngrok 2>/dev/null || true)"
    if [ -z "$NGROK_BIN" ]; then
      cat <<'TIP'
未安装 ngrok：
  macOS：brew install ngrok/ngrok/ngrok
  然后： ngrok config add-authtoken <你的 token>
TIP
      exit 1
    fi
    ;;
esac

# ---------- 准备本地服务 ----------

if [ "$AUTO_START" = "1" ]; then
  # 上次被强杀（SIGKILL，例如关终端/系统休眠）时服务可能还在：认自己的 pid 文件先收掉，
  # 避免「复用」到一份没人管的旧进程。用户自己 ./start.sh prod 起的服务不写这个文件，不会被误杀。
  if [ -f "$OWN_PID_FILE" ]; then
    ORPHAN="$(cat "$OWN_PID_FILE" 2>/dev/null || true)"
    if [ -n "$ORPHAN" ] && kill -0 "$ORPHAN" 2>/dev/null; then
      # pid 可能被系统复用给别的进程：命令行里没有 server/index.js 就不碰
      ORPHAN_CMD="$(ps -p "$ORPHAN" -o command= 2>/dev/null || true)"
      case "$ORPHAN_CMD" in
        ''|*server/index.js*)
          info "发现上次异常退出留下的服务（PID ${ORPHAN}），先停止…"
          kill "$ORPHAN" 2>/dev/null || true
          for _ in $(seq 1 20); do
            kill -0 "$ORPHAN" 2>/dev/null || break
            sleep 0.25
          done
          kill -9 "$ORPHAN" 2>/dev/null || true
          ;;
      esac
    fi
    rm -f "$OWN_PID_FILE"
  fi

  set +e
  probe "$PORT"
  STATE=$?
  set -e

  if [ "$STATE" = "0" ]; then
    USERS="$(health_field "$PORT" users)"
    info "复用已在 ${PORT} 端口运行的 StruBrowser（账号数 ${USERS:-?}）"
    if [ "$FORCE_BUILD" = "1" ]; then
      warn "服务已在运行，--build 不会影响正在跑的进程；如需新前端请先 ./start.sh restart"
    fi
  elif [ "$STATE" = "2" ]; then
    fail "端口 ${PORT} 上是一个非 StruBrowser 的 HTTP 服务，换个端口：./scripts/tunnel.sh --port 9000"
  else
    if port_busy "$PORT"; then
      fail "端口 ${PORT} 被其他程序占用；换端口：./scripts/tunnel.sh --port 9000"
    fi
    if [ "$FORCE_BUILD" = "1" ] || dist_stale; then
      info "构建前端（npm run build）…"
      npm run build
    else
      info "复用已有 dist/ 构建产物（改了源码可加 --build）"
    fi

    # 注册开关：没显式指定就保持服务端默认（开放），起来后按账号数给安全提示
    REGISTER_ENV="${STRU_ALLOW_REGISTER:-1}"

    info "启动服务端（端口 ${PORT}，生产模式）…"
    PORT="$PORT" NODE_ENV=production STRU_ALLOW_REGISTER="$REGISTER_ENV" \
      node --experimental-sqlite server/index.js > "$SERVER_LOG" 2>&1 &
    SERVER_PID=$!
    printf '%s\n' "$SERVER_PID" > "$OWN_PID_FILE"
    STARTED_SERVER=1

    if ! wait_http "$PORT" 200; then
      tail -n 30 "$SERVER_LOG" || true
      fail "服务端启动失败，详见 $SERVER_LOG"
    fi
    USERS="$(health_field "$PORT" users)"
  fi
else
  probe "$PORT" >/dev/null 2>&1 || fail "端口 ${PORT} 上没有 StruBrowser（--no-start 只建隧道），先去跑 ./start.sh prod"
fi

# ---------- 启动隧道 ----------

case "$PROVIDER" in
  cloudflared)
    info "建立 cloudflared 隧道（Ctrl+C 结束）…"
    : > "$TUNNEL_LOG"
    "$CF_BIN" tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!

    PUBLIC_URL=""
    for _ in $(seq 1 120); do
      PUBLIC_URL="$(sed -nE 's|.*(https://[A-Za-z0-9_-]+\.trycloudflare\.com).*|\1|p' "$TUNNEL_LOG" 2>/dev/null | head -1)"
      if [ -n "$PUBLIC_URL" ]; then break; fi
      if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
        tail -n 25 "$TUNNEL_LOG" || true
        fail "cloudflared 启动失败，详见 $TUNNEL_LOG"
      fi
      sleep 0.5
    done
    [ -n "$PUBLIC_URL" ] || { tail -n 25 "$TUNNEL_LOG" || true; fail "等待公网地址超时，详见 $TUNNEL_LOG"; }
    ;;

  ngrok)
    info "建立 ngrok 隧道（Ctrl+C 结束）…"
    : > "$TUNNEL_LOG"
    "$NGROK_BIN" http "$PORT" --log=stdout > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!

    PUBLIC_URL=""
    for _ in $(seq 1 120); do
      PUBLIC_URL="$(node -e '
        (async () => {
          try {
            const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1000) });
            const data = await res.json();
            const list = Array.isArray(data?.tunnels) ? data.tunnels : [];
            const https = list.find((t) => String(t.public_url || "").startsWith("https://"));
            process.stdout.write(String((https || list[0])?.public_url || ""));
          } catch { /* 隧道还没起来 */ }
        })();
      ' 2>/dev/null || true)"
      if [ -n "$PUBLIC_URL" ]; then break; fi
      if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
        tail -n 25 "$TUNNEL_LOG" || true
        fail "ngrok 启动失败，详见 $TUNNEL_LOG"
      fi
      sleep 0.5
    done
    [ -n "$PUBLIC_URL" ] || { tail -n 25 "$TUNNEL_LOG" || true; fail "等待公网地址超时，详见 $TUNNEL_LOG"; }
    ;;

  *)
    usage
    fail "未知隧道类型：$PROVIDER"
    ;;
esac

printf '%s\n' "$PUBLIC_URL" > "$URL_FILE"

# 复制到剪贴板（有就用，没有不影响）
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$PUBLIC_URL" | pbcopy 2>/dev/null || true
elif command -v wl-copy >/dev/null 2>&1; then
  printf '%s' "$PUBLIC_URL" | wl-copy 2>/dev/null || true
elif command -v xclip >/dev/null 2>&1; then
  printf '%s' "$PUBLIC_URL" | xclip -selection clipboard 2>/dev/null || true
fi

# 公网自检（失败只提示，不影响使用）
probe_public() {
  node -e '
    (async () => {
      try {
        const res = await fetch(process.argv[1], { signal: AbortSignal.timeout(8000), redirect: "follow" });
        process.exit(res.ok || res.status < 500 ? 0 : 1);
      } catch { process.exit(1); }
    })();
  ' "$1" >/dev/null 2>&1
}

REACHABLE="未能自检（本机 DNS/代理受限时常见，地址直接发出去试即可）"
for _ in 1 2 3; do
  if probe_public "$PUBLIC_URL"; then
    REACHABLE="公网可达 ✓"
    break
  fi
  sleep 1.5
done

# 自检之后再开浏览器：边缘节点刚建好时直接打开容易白屏
if [ "$OPEN_BROWSER" = "1" ]; then
  if command -v open >/dev/null 2>&1; then
    open "$PUBLIC_URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$PUBLIC_URL" >/dev/null 2>&1 || true
  fi
fi

printf '\n'
printf '  \033[1;32m公网地址  %s\033[0m\n' "$PUBLIC_URL"
printf '  本机地址  http://127.0.0.1:%s/\n' "$PORT"
printf '  状态      %s\n' "$REACHABLE"
if [ -n "${USERS:-}" ]; then
  if [ "$USERS" = "0" ]; then
    printf '  已有账号  0 个（先注册的第一个账号即系统管理员）\n'
  else
    printf '  已有账号  %s 个\n' "$USERS"
  fi
fi
printf '  地址也写入了 %s（已尝试复制到剪贴板）\n' "${URL_FILE#$ROOT/}"
printf '\n'
if [ -n "${USERS:-}" ] && [ "${USERS:-0}" != "0" ]; then
  printf '  \033[33m安全提示\033[0m  链接给谁谁就能打开，请用强密码；\n'
  printf '            不需要新用户注册时这样启动：STRU_ALLOW_REGISTER=0 ./scripts/tunnel.sh\n'
else
  printf '  \033[33m安全提示\033[0m  注册当前开放，任何拿到链接的人都能注册账号；\n'
  printf '            建好管理员后请用 STRU_ALLOW_REGISTER=0 ./scripts/tunnel.sh 重启。\n'
fi
printf '  退出      Ctrl+C（隧道关闭，公网地址立即失效）\n\n'

# 前台跟随隧道日志，保持进程存活
tail -n +1 -f "$TUNNEL_LOG"
