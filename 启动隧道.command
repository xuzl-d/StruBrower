#!/usr/bin/env bash
# 双击运行：启动 StruBrowser（生产模式）并把公网地址打印出来，供外部访问。
#
# 等价于在终端执行：./start.sh tunnel --open
# 关闭这个窗口或按 Ctrl+C，隧道与本次启动的本地服务会一起关闭。
cd "$(dirname "$0")" || exit 1

# 双击时用的是新的登录 shell，PATH 里可能没有 Homebrew（cloudflared 常从 brew 安装）
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

printf '\n'
printf '  StruBrowser · 公网隧道\n'
printf '  ─────────────────────────────────────────────\n'
printf '  正在检查本地服务与隧道工具，稍等十几秒…\n'
printf '  关闭本窗口或按 Ctrl+C 会一并停止隧道和本地服务。\n'
printf '\n'

# --install 是幂等的：cloudflared 已存在就跳过下载，没有才去下
exec bash ./scripts/tunnel.sh --install --open "$@"
