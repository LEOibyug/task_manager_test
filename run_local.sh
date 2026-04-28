#!/usr/bin/env bash
set -euo pipefail

resolve_script_path() {
  local src="${BASH_SOURCE[0]}"

  if [[ "$src" != */* ]]; then
    src="$(command -v -- "$src")"
  fi

  while [[ -L "$src" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done

  cd -P "$(dirname "$src")" && pwd
}

ROOT_DIR="$(resolve_script_path)"
VENV_PYTHON="$ROOT_DIR/.venv/bin/python"
VENV_UVICORN="$ROOT_DIR/.venv/bin/uvicorn"
FRONTEND_DIR="$ROOT_DIR/frontend"
FRONTEND_DIST="$FRONTEND_DIR/dist"
BACKEND_DIR="$ROOT_DIR/backend"
HOST="127.0.0.1"
PORT="8000"

print_step() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf '\n[run_local.sh] %s\n' "$1" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || fail "npm is required but was not found in PATH."
command -v python3 >/dev/null 2>&1 || fail "python3 is required but was not found in PATH."

if [[ ! -x "$VENV_PYTHON" ]]; then
  print_step "Creating project virtual environment"
  python3 -m venv "$ROOT_DIR/.venv"
fi

print_step "Checking backend dependencies"
if ! "$VENV_PYTHON" -c "import fastapi, uvicorn, paramiko, pydantic" >/dev/null 2>&1; then
  print_step "Installing backend dependencies into .venv"
  "$VENV_PYTHON" -m pip install --upgrade pip
  "$VENV_PYTHON" -m pip install -e "$BACKEND_DIR"
fi

print_step "Checking frontend dependencies"
if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  print_step "Installing frontend dependencies"
  (cd "$FRONTEND_DIR" && npm install --cache /tmp/exp-queue-manager-npm-cache)
fi

if [[ ! -d "$FRONTEND_DIST" ]]; then
  print_step "Building frontend bundle"
  (cd "$FRONTEND_DIR" && npm run build)
fi

print_step "Starting Exp-Queue-Manager"
printf 'Open http://%s:%s in your browser.\n' "$HOST" "$PORT"

cd "$ROOT_DIR"
exec "$VENV_UVICORN" app.main:app --host "$HOST" --port "$PORT" --app-dir "$BACKEND_DIR"
