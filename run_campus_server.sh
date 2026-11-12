#!/usr/bin/env bash
# UWED Campus Server Launcher for Linux (Ubuntu / Debian / CentOS)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================================"
echo "      UWED Campus Server Launcher (Linux 24/7)"
echo "========================================================"
echo ""

if command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PY_CMD="python"
else
    echo "[ERROR] Python 3 is not installed! Run: sudo apt update && sudo apt install -y python3"
    exit 1
fi

echo "Python detected: $($PY_CMD --version)"
echo "Starting UWED Campus Server..."
echo ""

while true; do
    "$PY_CMD" "$SCRIPT_DIR/uwed_campus_server.py" "$@"
    echo "[WATCHDOG] Process exited. Restarting in 5 seconds (Press Ctrl+C to stop)..."
    sleep 5
done
