@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

echo ========================================================
echo   Exp-Queue-Manager - Windows 一键初始化与启动脚本
echo ========================================================
echo.

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "STATE_DIR=%ROOT_DIR%\.run_local"
set "VENV_DIR=%ROOT_DIR%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "BACKEND_DIR=%ROOT_DIR%\backend"
set "FRONTEND_DIR=%ROOT_DIR%\frontend"
set "BACKEND_DEPS_STAMP=%STATE_DIR%\backend_deps.stamp"
set "FRONTEND_DEPS_STAMP=%STATE_DIR%\frontend_deps.stamp"
set "FRONTEND_BUILD_STAMP=%STATE_DIR%\frontend_build.stamp"

echo [1/6] 检查环境依赖 (Python ^& Node.js)...
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python 或 Python 版本低于 3.11。请确保已安装 Python 3.11+ 并添加到 PATH。
    pause
    exit /b 1
)

node -e "const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Node.js 或 Node.js 版本低于 18。请确保已安装 Node.js 18+ 并添加到 PATH。
    pause
    exit /b 1
)

npm -v >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 npm。请确认 Node.js 已完整安装并可在 PATH 中访问。
    pause
    exit /b 1
)

if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"

echo.
echo [2/6] 检查 Git 远端更新...
call :auto_update_repo

echo.
echo [3/6] 检查并配置 Python 虚拟环境 (.venv)...
if not exist "%VENV_PYTHON%" (
    echo 创建虚拟环境...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [错误] 创建虚拟环境失败。
        pause
        exit /b 1
    )
)

echo.
echo [4/6] 检查后端依赖...
set "NEED_BACKEND_INSTALL=0"
if not exist "%BACKEND_DEPS_STAMP%" set "NEED_BACKEND_INSTALL=1"
if "!NEED_BACKEND_INSTALL!"=="0" (
    python -c "from pathlib import Path; import sys; sys.exit(0 if Path(r'%BACKEND_DIR%\pyproject.toml').stat().st_mtime > Path(r'%BACKEND_DEPS_STAMP%').stat().st_mtime else 1)" >nul 2>&1
    if not errorlevel 1 set "NEED_BACKEND_INSTALL=1"
)
if "!NEED_BACKEND_INSTALL!"=="0" (
    "%VENV_PYTHON%" -c "import fastapi, uvicorn, paramiko, pydantic" >nul 2>&1
    if errorlevel 1 set "NEED_BACKEND_INSTALL=1"
)
if "!NEED_BACKEND_INSTALL!"=="1" (
    echo 安装/更新后端依赖...
    "%VENV_PYTHON%" -m pip install --upgrade pip
    if errorlevel 1 goto :backend_install_failed
    "%VENV_PYTHON%" -m pip install -e "%BACKEND_DIR%"
    if errorlevel 1 goto :backend_install_failed
    type nul > "%BACKEND_DEPS_STAMP%"
) else (
    echo 后端依赖已就绪，跳过安装。
)

echo.
echo [5/6] 检查前端依赖与构建产物...
set "NEED_FRONTEND_INSTALL=0"
if not exist "%FRONTEND_DIR%\node_modules" set "NEED_FRONTEND_INSTALL=1"
if "!NEED_FRONTEND_INSTALL!"=="0" if not exist "%FRONTEND_DEPS_STAMP%" set "NEED_FRONTEND_INSTALL=1"
if "!NEED_FRONTEND_INSTALL!"=="0" (
    python -c "from pathlib import Path; import sys; stamp=Path(r'%FRONTEND_DEPS_STAMP%'); files=[Path(r'%FRONTEND_DIR%\package.json')]; lock=Path(r'%FRONTEND_DIR%\package-lock.json'); files += [lock] if lock.exists() else []; sys.exit(0 if any(path.stat().st_mtime > stamp.stat().st_mtime for path in files) else 1)" >nul 2>&1
    if not errorlevel 1 set "NEED_FRONTEND_INSTALL=1"
)

if "!NEED_FRONTEND_INSTALL!"=="1" (
    echo 安装/更新前端依赖...
    pushd "%FRONTEND_DIR%"
    if exist "package-lock.json" (
        call npm ci
    ) else (
        call npm install
    )
    if errorlevel 1 (
        popd
        echo [错误] 安装前端依赖失败。
        pause
        exit /b 1
    )
    popd
    type nul > "%FRONTEND_DEPS_STAMP%"
) else (
    echo 前端依赖已就绪，跳过安装。
)

set "NEED_FRONTEND_BUILD=0"
if not exist "%FRONTEND_DIR%\dist" set "NEED_FRONTEND_BUILD=1"
if "!NEED_FRONTEND_BUILD!"=="0" if not exist "%FRONTEND_BUILD_STAMP%" set "NEED_FRONTEND_BUILD=1"
if "!NEED_FRONTEND_BUILD!"=="0" (
    python -c "from pathlib import Path; import sys; root=Path(r'%FRONTEND_DIR%'); stamp=Path(r'%FRONTEND_BUILD_STAMP%'); files=[root/'index.html', root/'package.json', root/'tsconfig.json', root/'vite.config.ts']; lock=root/'package-lock.json'; files += [lock] if lock.exists() else []; src=root/'src'; newer=any(path.exists() and path.stat().st_mtime > stamp.stat().st_mtime for path in files) or any(path.stat().st_mtime > stamp.stat().st_mtime for path in src.rglob('*') if path.is_file()); sys.exit(0 if newer else 1)" >nul 2>&1
    if not errorlevel 1 set "NEED_FRONTEND_BUILD=1"
)

if "!NEED_FRONTEND_BUILD!"=="1" (
    echo 检测到前端源码变更，开始构建...
    pushd "%FRONTEND_DIR%"
    call npm run build
    if errorlevel 1 (
        popd
        echo [错误] 前端构建失败。
        pause
        exit /b 1
    )
    popd
    type nul > "%FRONTEND_BUILD_STAMP%"
) else (
    echo 前端构建产物是最新的，跳过构建。
)

echo.
echo [6/6] 所有依赖已准备就绪，正在启动本地服务...
echo.
echo --------------------------------------------------------
echo 请在浏览器中打开: http://127.0.0.1:8000
echo 关闭此窗口或按 Ctrl+C 可停止服务
echo --------------------------------------------------------
echo.

call "%VENV_DIR%\Scripts\activate.bat"
uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend
goto :eof

:backend_install_failed
echo [错误] 安装后端依赖失败。
pause
exit /b 1

:auto_update_repo
set "GIT_BRANCH="
set "GIT_UPSTREAM="
set "LOCAL_SHA="
set "REMOTE_SHA="
set "BASE_SHA="
set "GIT_STATUS_OUTPUT="
git -C "%ROOT_DIR%" rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [run_local.bat] 当前目录不是 Git 仓库，跳过自动更新。
    goto :eof
)

for /f "delims=" %%i in ('git -C "%ROOT_DIR%" symbolic-ref --quiet --short HEAD 2^>nul') do set "GIT_BRANCH=%%i"
if not defined GIT_BRANCH (
    echo [run_local.bat] 当前处于 detached HEAD，跳过自动更新。
    goto :eof
)

for /f "delims=" %%i in ('git -C "%ROOT_DIR%" rev-parse --abbrev-ref --symbolic-full-name @{u} 2^>nul') do set "GIT_UPSTREAM=%%i"
if not defined GIT_UPSTREAM (
    echo [run_local.bat] 分支 %GIT_BRANCH% 未配置 upstream，跳过自动更新。
    goto :eof
)

git -C "%ROOT_DIR%" fetch --quiet --prune
if errorlevel 1 (
    echo [run_local.bat] 拉取远端信息失败，继续使用本地代码。
    goto :eof
)

for /f "delims=" %%i in ('git -C "%ROOT_DIR%" rev-parse HEAD') do set "LOCAL_SHA=%%i"
for /f "delims=" %%i in ('git -C "%ROOT_DIR%" rev-parse %GIT_UPSTREAM%') do set "REMOTE_SHA=%%i"
for /f "delims=" %%i in ('git -C "%ROOT_DIR%" merge-base HEAD %GIT_UPSTREAM%') do set "BASE_SHA=%%i"

if "%LOCAL_SHA%"=="%REMOTE_SHA%" (
    echo [run_local.bat] 仓库已是最新。
    goto :eof
)

if "%LOCAL_SHA%"=="%BASE_SHA%" (
    set "GIT_STATUS_OUTPUT="
    for /f "delims=" %%i in ('git -C "%ROOT_DIR%" status --porcelain --untracked-files=no 2^>nul') do set "GIT_STATUS_OUTPUT=%%i"
    if defined GIT_STATUS_OUTPUT (
        echo [run_local.bat] 发现远端更新，但本地有未提交跟踪文件修改，跳过自动 pull。
        goto :eof
    )
    echo [run_local.bat] 检测到远端更新，执行 fast-forward pull...
    git -C "%ROOT_DIR%" pull --ff-only
    if errorlevel 1 (
        echo [run_local.bat] 自动 pull 失败，继续使用当前代码。
    ) else (
        echo [run_local.bat] 已更新到最新代码。
    )
    goto :eof
)

if "%REMOTE_SHA%"=="%BASE_SHA%" (
    echo [run_local.bat] 本地分支领先于远端，保留当前代码。
    goto :eof
)

echo [run_local.bat] 本地与远端分支已分叉，跳过自动 pull。
goto :eof
