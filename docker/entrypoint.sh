#!/bin/bash
set -e

# =============================================================================
# Container entrypoint - handles credential isolation and process lifecycle
#
# Patterns implemented:
#   - Copy-not-mount: Credentials are copied from staging mount to runtime
#     location, so the bind mount is only needed at startup
#   - Exec decoupling: Container stays alive as the entrypoint, node process
#     is a child that can crash/restart without killing the container
#   - Signal forwarding: SIGTERM/SIGINT are forwarded to the child process
# =============================================================================

CLAUDE_DIR="/home/node/.claude"
STAGING_DIR="/tmp/.credentials-staging"

# --- Credential Copy (copy-not-mount pattern) ---
# If credentials are mounted at the staging path, copy them to the runtime
# location with proper permissions. This means the bind mount is only needed
# during container startup, not for the lifetime of the process.

if [ -f "${STAGING_DIR}/.credentials.json" ]; then
    echo "[entrypoint] Copying credentials from staging mount..."
    mkdir -p "${CLAUDE_DIR}"
    cp "${STAGING_DIR}/.credentials.json" "${CLAUDE_DIR}/.credentials.json"
    chmod 600 "${CLAUDE_DIR}/.credentials.json"
    echo "[entrypoint] Credentials copied (mode 600)"
elif [ -f "${CLAUDE_DIR}/.credentials.json" ]; then
    # Credentials already in place (direct mount or baked into image)
    echo "[entrypoint] Credentials found at ${CLAUDE_DIR}/.credentials.json"
else
    echo "[entrypoint] No OAuth credentials found (will use API key or fail)"
fi

# --- Git Config ---
# Copy .gitconfig if mounted at staging
if [ -f "${STAGING_DIR}/.gitconfig" ]; then
    cp "${STAGING_DIR}/.gitconfig" /home/node/.gitconfig
    echo "[entrypoint] Git config copied from staging"
fi

# --- Determine Mode ---
# CMD argument overrides MODE env var
CMD_ARG="${1:-auto}"

if [ "$CMD_ARG" = "auto" ]; then
    # Use MODE env var (default: server)
    CMD_ARG="${MODE:-server}"
fi

case "$CMD_ARG" in
    server)
        echo "[entrypoint] Starting API server..."
        EXEC_CMD="node src/server.js"
        ;;
    worker)
        echo "[entrypoint] Starting Redis worker..."
        EXEC_CMD="node src/worker.js"
        ;;
    *)
        # Pass through arbitrary commands (useful for debugging)
        echo "[entrypoint] Running custom command: $@"
        exec "$@"
        ;;
esac

# --- Signal Forwarding ---
# Forward signals to the child process for graceful shutdown
CHILD_PID=""

cleanup() {
    if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
        echo "[entrypoint] Forwarding signal to child process (PID: $CHILD_PID)..."
        kill -TERM "$CHILD_PID"
        wait "$CHILD_PID" 2>/dev/null
    fi
    exit 0
}

trap cleanup SIGTERM SIGINT

# Start the process in the background so we can handle signals
$EXEC_CMD &
CHILD_PID=$!

echo "[entrypoint] Process started (PID: $CHILD_PID)"

# Wait for the child process
wait "$CHILD_PID"
EXIT_CODE=$?

echo "[entrypoint] Process exited with code $EXIT_CODE"
exit $EXIT_CODE
