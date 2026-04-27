# Exp-Queue-Manager

Exp-Queue-Manager is a local web application for managing machine learning or HPC experiments stored on a remote server. It uses a FastAPI backend for SSH, persistence, and job orchestration, plus a React frontend for configuration, experiment browsing, job monitoring, log viewing, output browsing, and sync actions.

## Project Layout

- `backend/`: FastAPI application, SQLite persistence, SSH services, and tests
- `frontend/`: React + TypeScript UI built with Vite
- `.venv/`: local Python virtual environment for this repository only

## Local Development

### One-click run

```bash
./run_local.sh
```

The script creates `.venv/` if needed, installs backend and frontend dependencies when missing, builds the frontend bundle if `frontend/dist/` does not exist, and then starts the app at `http://127.0.0.1:8000`.

### 1. Create and activate the virtual environment

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 2. Install backend dependencies

```bash
pip install --upgrade pip
pip install -e backend
```

### 3. Install frontend dependencies

```bash
cd frontend
npm install
cd ..
```

### 4. Run the backend

```bash
source .venv/bin/activate
uvicorn app.main:app --reload --app-dir backend
```

The backend listens on `127.0.0.1:8000`.

### 5. Run the frontend

```bash
cd frontend
npm run dev
```

The Vite dev server listens on `127.0.0.1:5173` and proxies API requests to the backend.

## Configuration

Runtime configuration is stored at `~/.exp-queue-manager/config.json`.
If the environment does not allow writing to the home directory, the backend falls back to `backend/data/runtime-config/config.json`.

Supported fields:

- `server_ip`
- `server_port`
- `main_username`
- `sub_usernames`
- `repo_paths`
- `refresh_interval`

The backend also stores task snapshots and sync metadata in a local SQLite database at `backend/data/app.db` by default.

## Testing

Backend tests use the standard library `unittest` runner:

```bash
source .venv/bin/activate
python -m unittest discover -s backend/tests
```

## Notes

- `.venv/`, `node_modules/`, build artifacts, caches, local databases, and user config files are ignored by Git.
- Production frontend assets are expected in `frontend/dist/`; when present, FastAPI serves them directly.
- SSH authentication relies on the current machine's configured SSH keys.
