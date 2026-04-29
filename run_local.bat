@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================================
echo   Exp-Queue-Manager - Windows 一键初始化与启动脚本
echo ========================================================
echo.

:: 1. 检查 Python 版本
echo [1/5] 检查环境依赖 (Python ^& Node.js)...
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python 或 Python 版本低于 3.11。请确保已安装 Python 3.11+ 并添加到了系统环境变量 (PATH) 中。
    pause
    exit /b 1
)

:: 2. 检查 Node.js
node -v >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Node.js。请确保已安装 Node.js 18+ 并添加到了系统环境变量 (PATH) 中。
    pause
    exit /b 1
)

set "ROOT_DIR=%~dp0"
set "VENV_DIR=%ROOT_DIR%.venv"
set "FRONTEND_DIR=%ROOT_DIR%frontend"

:: 3. 初始化并激活虚拟环境
echo.
echo [2/5] 检查并配置 Python 虚拟环境 (.venv)...
if not exist "%VENV_DIR%" (
    echo 创建虚拟环境...
    python -m venv "%VENV_DIR%"
)

:: 4. 安装后端依赖
echo.
echo [3/5] 安装/更新后端依赖...
call "%VENV_DIR%\Scripts\activate.bat"
python -m pip install --upgrade pip >nul
pip install -e backend

:: 5. 安装前端依赖及构建
echo.
echo [4/5] 安装前端依赖并打包页面资源...
cd /d "%FRONTEND_DIR%"
call npm install
call npm run build
cd /d "%ROOT_DIR%"

:: 6. 启动后端项目
echo.
echo [5/5] 所有的依赖已准备就绪，正在启动本地服务...
echo.
echo --------------------------------------------------------
echo 请在浏览器中打开: http://127.0.0.1:8000
echo 关闭此窗口或按 Ctrl+C 可停止服务
echo --------------------------------------------------------
echo.

uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend

pause
