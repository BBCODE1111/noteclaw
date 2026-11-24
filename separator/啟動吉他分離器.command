#!/bin/bash
# Double-click to start NoteClaw's guitar separator. The first run installs Demucs (about 400 MB, internet
# needed once) into ~/Library/Application Support/NoteClaw — nothing else on the Mac is changed.
cd "$(dirname "$0")"
HOME_DIR="$HOME/Library/Application Support/NoteClaw"
VENV="$HOME_DIR/separator-venv"
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys' >/dev/null 2>&1; then
  echo "需要 Python 3。macOS 會跳出視窗問要不要安裝「命令列開發者工具」，按「安裝」，裝好後再雙擊這個檔案。"
  read -p "按 Return 關閉…"
  exit 1
fi
if [ ! -x "$VENV/bin/python" ] || ! "$VENV/bin/python" -c 'import demucs, soundfile' >/dev/null 2>&1; then
  echo "第一次使用：安裝吉他分離模型（約 400MB，需要網路，大概幾分鐘）…"
  mkdir -p "$HOME_DIR"
  python3 -m venv "$VENV" || { read -p "建立環境失敗，按 Return 關閉…"; exit 1; }
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q demucs soundfile || { read -p "安裝失敗（請檢查網路），按 Return 關閉…"; exit 1; }
fi
exec "$VENV/bin/python" server.py
