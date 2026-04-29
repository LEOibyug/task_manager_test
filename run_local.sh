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
VENV_DIR="$ROOT_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
VENV_UVICORN="$VENV_DIR/bin/uvicorn"
FRONTEND_DIR="$ROOT_DIR/frontend"
FRONTEND_DIST="$FRONTEND_DIR/dist"
BACKEND_DIR="$ROOT_DIR/backend"
STATE_DIR="$ROOT_DIR/.run_local"
BACKEND_DEPS_STAMP="$STATE_DIR/backend_deps.stamp"
FRONTEND_DEPS_STAMP="$STATE_DIR/frontend_deps.stamp"
FRONTEND_BUILD_STAMP="$STATE_DIR/frontend_build.stamp"
NPM_CACHE_DIR="/tmp/exp-queue-manager-npm-cache"
HOST="127.0.0.1"
PORT="8000"

print_step() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf '\n[run_local.sh] %s\n' "$1" >&2
  exit 1
}

require_python_version() {
  python3 - <<'PY' || fail "Python 3.11 or newer is required."
import sys
raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PY
}

require_node_version() {
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ -z "$node_major" || "$node_major" -lt 18 ]]; then
    fail "Node.js 18 or newer is required."
  fi
}

needs_backend_install() {
  if [[ ! -x "$VENV_PYTHON" ]]; then
    return 0
  fi

  if [[ ! -f "$BACKEND_DEPS_STAMP" ]]; then
    return 0
  fi

  if [[ "$BACKEND_DIR/pyproject.toml" -nt "$BACKEND_DEPS_STAMP" ]]; then
    return 0
  fi

  if ! "$VENV_PYTHON" -c "import fastapi, uvicorn, paramiko, pydantic" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

needs_frontend_install() {
  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    return 0
  fi

  if [[ ! -f "$FRONTEND_DEPS_STAMP" ]]; then
    return 0
  fi

  if [[ "$FRONTEND_DIR/package.json" -nt "$FRONTEND_DEPS_STAMP" ]]; then
    return 0
  fi

  if [[ -f "$FRONTEND_DIR/package-lock.json" && "$FRONTEND_DIR/package-lock.json" -nt "$FRONTEND_DEPS_STAMP" ]]; then
    return 0
  fi

  return 1
}

has_newer_frontend_sources() {
  local reference="$1"
  local path

  for path in \
    "$FRONTEND_DIR/src" \
    "$FRONTEND_DIR/index.html" \
    "$FRONTEND_DIR/package.json" \
    "$FRONTEND_DIR/package-lock.json" \
    "$FRONTEND_DIR/tsconfig.json" \
    "$FRONTEND_DIR/vite.config.ts"; do
    if [[ -d "$path" ]]; then
      if find "$path" -type f -newer "$reference" -print -quit | grep -q .; then
        return 0
      fi
    elif [[ -e "$path" && "$path" -nt "$reference" ]]; then
      return 0
    fi
  done

  return 1
}

needs_frontend_build() {
  if [[ ! -d "$FRONTEND_DIST" ]]; then
    return 0
  fi

  if [[ ! -f "$FRONTEND_BUILD_STAMP" ]]; then
    return 0
  fi

  if has_newer_frontend_sources "$FRONTEND_BUILD_STAMP"; then
    return 0
  fi

  return 1
}

install_frontend_dependencies() {
  if [[ -f "$FRONTEND_DIR/package-lock.json" ]]; then
    (cd "$FRONTEND_DIR" && npm ci --cache "$NPM_CACHE_DIR")
  else
    (cd "$FRONTEND_DIR" && npm install --cache "$NPM_CACHE_DIR")
  fi
}

command -v python3 >/dev/null 2>&1 || fail "python3 is required but was not found in PATH."
command -v node >/dev/null 2>&1 || fail "node is required but was not found in PATH."
command -v npm >/dev/null 2>&1 || fail "npm is required but was not found in PATH."

require_python_version
require_node_version
mkdir -p "$STATE_DIR"

if [[ ! -x "$VENV_PYTHON" ]]; then
  print_step "Creating project virtual environment"
  python3 -m venv "$VENV_DIR"
fi

print_step "Checking backend dependencies"
if needs_backend_install; then
  print_step "Installing backend dependencies into .venv"
  "$VENV_PYTHON" -m pip install --upgrade pip
  "$VENV_PYTHON" -m pip install -e "$BACKEND_DIR"
  touch "$BACKEND_DEPS_STAMP"
fi

print_step "Checking frontend dependencies"
if needs_frontend_install; then
  print_step "Installing frontend dependencies"
  install_frontend_dependencies
  touch "$FRONTEND_DEPS_STAMP"
fi

if needs_frontend_build; then
  print_step "Building frontend bundle"
  (cd "$FRONTEND_DIR" && npm run build)
  touch "$FRONTEND_BUILD_STAMP"
fi

print_step "Starting Exp-Queue-Manager"
printf 'Open http://%s:%s in your browser.\n' "$HOST" "$PORT"

cd "$ROOT_DIR"
exec "$VENV_UVICORN" app.main:app --host "$HOST" --port "$PORT" --app-dir "$BACKEND_DIR"
