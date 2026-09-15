#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

ACTION="${1:-restart}"

HAPI_LOCAL_HOST="${HAPI_LOCAL_HOST:-127.0.0.1}"
HAPI_LOCAL_HUB_PORT="${HAPI_LOCAL_HUB_PORT:-8318}"
HAPI_LOCAL_WEB_PORT="${HAPI_LOCAL_WEB_PORT:-5173}"
HAPI_LOCAL_ACCESS_TOKEN="${HAPI_LOCAL_ACCESS_TOKEN:-hapi-test-local:localdev}"
HAPI_LOCAL_REGISTRATION_SECRET="${HAPI_LOCAL_REGISTRATION_SECRET:-hapi-local-enrollment-secret-do-not-use}"
if [[ "$HAPI_LOCAL_ACCESS_TOKEN" == *:* ]]; then
    HAPI_LOCAL_HUB_TOKEN="${HAPI_LOCAL_ACCESS_TOKEN%:*}"
else
    HAPI_LOCAL_HUB_TOKEN="$HAPI_LOCAL_ACCESS_TOKEN"
fi
HAPI_LOCAL_HUB_URL="${HAPI_LOCAL_HUB_URL:-http://${HAPI_LOCAL_HOST}:${HAPI_LOCAL_HUB_PORT}}"
HAPI_LOCAL_HUB_HOME="${HAPI_LOCAL_HUB_HOME:-$HOME/.hapi-local-dev}"
HAPI_LOCAL_DB_PATH="${HAPI_LOCAL_DB_PATH:-$HOME/.hapi-local-dev/hapi.db}"
HAPI_LOCAL_RUNNER_HOME="${HAPI_LOCAL_RUNNER_HOME:-$HAPI_LOCAL_HUB_HOME}"
HAPI_LOCAL_WORKSPACE_ROOT="${HAPI_LOCAL_WORKSPACE_ROOT:-$ROOT}"
HAPI_LOCAL_STATE_DIR="${HAPI_LOCAL_STATE_DIR:-/tmp/hapi-local-dev}"

PID_DIR="$HAPI_LOCAL_STATE_DIR/pids"
LOG_DIR="$HAPI_LOCAL_STATE_DIR/logs"
HUB_PID_FILE="$PID_DIR/hub-${HAPI_LOCAL_HUB_PORT}.pid"
WEB_PID_FILE="$PID_DIR/web-${HAPI_LOCAL_WEB_PORT}.pid"
HUB_LOG="$LOG_DIR/hub-${HAPI_LOCAL_HUB_PORT}.log"
WEB_LOG="$LOG_DIR/web-${HAPI_LOCAL_WEB_PORT}.log"

mkdir -p "$PID_DIR" "$LOG_DIR" "$HAPI_LOCAL_HUB_HOME" "$HAPI_LOCAL_RUNNER_HOME" "$(dirname -- "$HAPI_LOCAL_DB_PATH")"

is_running() {
    local pid="$1"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
    local file="$1"
    [[ -f "$file" ]] && cat "$file" || true
}

stop_pid_file() {
    local name="$1"
    local file="$2"
    local pid
    pid="$(read_pid "$file")"
    if ! is_running "$pid"; then
        rm -f "$file"
        return
    fi

    echo "[$name] stopping pid $pid"
    kill "$pid" 2>/dev/null || true
    for _ in {1..40}; do
        if ! is_running "$pid"; then
            rm -f "$file"
            return
        fi
        sleep 0.25
    done

    echo "[$name] force stopping pid $pid"
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$file"
}

stop_port_listeners() {
    local port="$1"
    command -v lsof >/dev/null 2>&1 || return

    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -n "$pids" ]] || return 0

    echo "[port:$port] stopping existing listener(s): $pids"
    for pid in $pids; do
        [[ "$pid" == "$$" ]] && continue
        kill "$pid" 2>/dev/null || true
    done
    sleep 1
}

wait_http() {
    local name="$1"
    local url="$2"
    for _ in {1..120}; do
        if curl -fsS "$url" >/dev/null 2>&1; then
            echo "[$name] ready: $url"
            return
        fi
        sleep 0.5
    done

    echo "[$name] failed to become ready: $url" >&2
    return 1
}

spawn_detached() {
    local cwd="$1"
    local log="$2"
    local pid_file="$3"
    shift 3

    python3 - "$cwd" "$log" "$pid_file" "$@" <<'PY'
import os
import subprocess
import sys

cwd, log_path, pid_path = sys.argv[1:4]
cmd = sys.argv[4:]

os.makedirs(os.path.dirname(log_path), exist_ok=True)
os.makedirs(os.path.dirname(pid_path), exist_ok=True)

with open(log_path, "ab", buffering=0) as out:
    process = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=out,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
        env=os.environ.copy(),
    )

with open(pid_path, "w", encoding="utf-8") as pid_file:
    pid_file.write(f"{process.pid}\n")
PY
}

stop_runner() {
    echo "[runner] stopping for HAPI_HOME=$HAPI_LOCAL_RUNNER_HOME"
    (
        cd "$ROOT/cli"
        CLI_API_TOKEN="$HAPI_LOCAL_ACCESS_TOKEN" \
        HAPI_API_URL="$HAPI_LOCAL_HUB_URL" \
        HAPI_HOME="$HAPI_LOCAL_RUNNER_HOME" \
        bun run dev runner stop
    ) >/dev/null 2>&1 || true
}

start_hub() {
    stop_pid_file hub "$HUB_PID_FILE"
    stop_port_listeners "$HAPI_LOCAL_HUB_PORT"

    echo "[hub] starting from $ROOT/hub"
    spawn_detached "$ROOT/hub" "$HUB_LOG" "$HUB_PID_FILE" \
        env \
            HAPI_HOME="$HAPI_LOCAL_HUB_HOME" \
            DB_PATH="$HAPI_LOCAL_DB_PATH" \
            CLI_API_TOKEN="$HAPI_LOCAL_HUB_TOKEN" \
            HAPI_REGISTRATION_SECRET="$HAPI_LOCAL_REGISTRATION_SECRET" \
            HAPI_LISTEN_HOST="$HAPI_LOCAL_HOST" \
            HAPI_LISTEN_PORT="$HAPI_LOCAL_HUB_PORT" \
            HAPI_PUBLIC_URL="$HAPI_LOCAL_HUB_URL" \
            CORS_ORIGINS="${CORS_ORIGINS:-${HAPI_LOCAL_HUB_URL},http://${HAPI_LOCAL_HOST}:${HAPI_LOCAL_WEB_PORT}}" \
            bun run dev

    wait_http hub "$HAPI_LOCAL_HUB_URL"
}

start_web() {
    stop_pid_file web "$WEB_PID_FILE"
    stop_port_listeners "$HAPI_LOCAL_WEB_PORT"

    echo "[web] starting from $ROOT/web"
    spawn_detached "$ROOT/web" "$WEB_LOG" "$WEB_PID_FILE" \
        env \
            VITE_HUB_PROXY="$HAPI_LOCAL_HUB_URL" \
            VITE_HAPI_DEV_ACCESS_TOKEN="$HAPI_LOCAL_ACCESS_TOKEN" \
            bun run dev --host "$HAPI_LOCAL_HOST" --port "$HAPI_LOCAL_WEB_PORT"

    wait_http web "http://${HAPI_LOCAL_HOST}:${HAPI_LOCAL_WEB_PORT}/"
}

start_runner() {
    stop_runner

    echo "[runner] starting from $ROOT/cli"
    (
        cd "$ROOT/cli"
        CLI_API_TOKEN="$HAPI_LOCAL_ACCESS_TOKEN" \
        HAPI_API_URL="$HAPI_LOCAL_HUB_URL" \
        HAPI_HOME="$HAPI_LOCAL_RUNNER_HOME" \
        bun run dev runner start --workspace-root "$HAPI_LOCAL_WORKSPACE_ROOT"
    )
}

start_all() {
    start_hub
    start_web
    start_runner
    status_all
}

stop_all() {
    stop_runner
    stop_pid_file web "$WEB_PID_FILE"
    stop_pid_file hub "$HUB_PID_FILE"
}

status_all() {
    echo
    echo "Hub:        $HAPI_LOCAL_HUB_URL"
    echo "Web:        http://${HAPI_LOCAL_HOST}:${HAPI_LOCAL_WEB_PORT}"
    echo "Token:      $HAPI_LOCAL_ACCESS_TOKEN"
    echo "Enrollment: $HAPI_LOCAL_REGISTRATION_SECRET"
    echo "Hub home:   $HAPI_LOCAL_HUB_HOME"
    echo "DB path:    $HAPI_LOCAL_DB_PATH"
    echo "Runner home:$HAPI_LOCAL_RUNNER_HOME"
    echo "Workspace:  $HAPI_LOCAL_WORKSPACE_ROOT"
    echo "Hub log:    $HUB_LOG"
    echo "Web log:    $WEB_LOG"
    echo
    (
        cd "$ROOT/cli"
        CLI_API_TOKEN="$HAPI_LOCAL_ACCESS_TOKEN" \
        HAPI_API_URL="$HAPI_LOCAL_HUB_URL" \
        HAPI_HOME="$HAPI_LOCAL_RUNNER_HOME" \
        bun run dev runner status
    )
}

case "$ACTION" in
    start)
        start_all
        ;;
    stop)
        stop_all
        ;;
    restart)
        stop_all
        start_all
        ;;
    status)
        status_all
        ;;
    *)
        echo "Usage: $0 [start|stop|restart|status]" >&2
        exit 2
        ;;
esac
