#!/usr/bin/env bash
# macOS 双击启动（Finder 中会打开终端窗口）
cd "$(dirname "$0")" || exit 1
exec bash ./start.sh "$@"
