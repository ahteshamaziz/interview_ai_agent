#!/usr/bin/env bash
# Run backend, Vite renderer, and Electron together.
# Usage: npm run dev   (or: bash scripts/dev.sh)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BACKEND_PORT="${PORT:-8787}"
RENDERER_PORT=5173

PIDS=()

cleanup() {
  echo ""
  echo "Stopping dev servers..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-60}"

  echo "Waiting for $label ($url)..."
  for ((i = 1; i <= attempts; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "$label is ready."
      return 0
    fi
    sleep 0.5
  done

  echo "Timed out waiting for $label at $url" >&2
  return 1
}

echo "Starting backend (port $BACKEND_PORT)..."
npm run dev:backend &
PIDS+=($!)

echo "Starting renderer (port $RENDERER_PORT)..."
npm run dev:renderer &
PIDS+=($!)

wait_for_url "http://localhost:${BACKEND_PORT}/health" "backend"
wait_for_url "http://localhost:${RENDERER_PORT}" "renderer"

echo "Starting Electron..."
npm run dev:electron &
PIDS+=($!)

echo ""
echo "All services running:"
echo "  backend  -> http://localhost:${BACKEND_PORT}"
echo "  renderer -> http://localhost:${RENDERER_PORT}"
echo "  electron -> desktop window"
echo ""
echo "Press Ctrl+C to stop everything."

wait
