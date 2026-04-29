# Exp-Queue-Manager

Exp-Queue-Manager 是一个本地 Web 应用，用于管理远端服务器上的机器学习 / HPC 实验任务。项目由：

- `backend/`：FastAPI 后端，负责 SSH 连接、任务调度、日志与结果同步、SQLite 持久化
- `frontend/`：React + TypeScript 前端界面
- `run_local.sh` / `run_local.bat`：仓库级一键启动脚本

---

## 1. 适用场景

当你完成以下动作后：

```bash
git clone <your-repo-url>
cd Task_Manager
```

希望通过一条命令直接把项目跑起来：

```bash
./run_local.sh
```

Windows 下也可以直接运行：

```bat
run_local.bat
```

本 README 就是为这个目标准备的运行环境指导。

---

## 2. 本地运行环境要求

### 必装软件

| 组件 | 建议版本 | 用途 |
| --- | --- | --- |
| Git | 任意较新版本 | clone 项目 |
| Python | **3.11+** | 后端运行环境 |
| Node.js | **18+** | 前端构建 |
| npm | 随 Node.js 安装 | 前端依赖安装 |
| SSH / SSH Key | 已配置 | 连接远端实验服务器 |

### 建议先确认版本

```bash
python3 --version
node --version
npm --version
```

---

## 3. clone 后的一键部署方式（推荐）

### 3.1 启动命令

```bash
./run_local.sh
```

### 3.2 脚本会自动完成什么

`run_local.sh` / `run_local.bat` 已经处理了首次启动最常见的准备动作：

1. 检查 `python3` / `node` / `npm` 是否存在
2. 校验 Python 版本是否为 **3.11+**
3. 校验 Node.js 版本是否为 **18+**
4. 启动前自动检查 Git 远端更新；若当前分支可安全 fast-forward，则自动执行 `git pull --ff-only`
5. 若 `.venv/` 不存在，则自动创建虚拟环境
6. 若后端依赖缺失，或 `backend/pyproject.toml` 有变更，则自动重新安装后端依赖；否则跳过
7. 若前端依赖缺失，或 `frontend/package.json` / `package-lock.json` 有变更，则自动安装前端依赖；否则跳过
8. 若前端静态资源不存在，或前端源码有更新，则自动重新构建 `frontend/dist/`；否则跳过
9. 启动 FastAPI，并在 `http://127.0.0.1:8000` 提供页面

### 3.3 首次启动后的访问地址

浏览器打开：

```text
http://127.0.0.1:8000
```

---

## 4. 首次使用后的必要配置

应用启动成功后，进入页面的“配置”页，填写远端环境信息。配置文件默认保存在：

```text
~/.exp-queue-manager/config.json
```

如果当前环境不能写入用户目录，后端会自动回退到：

```text
backend/data/runtime-config/config.json
```

### 支持的配置字段

- `server_ip`：远端服务器 IP
- `server_port`：SSH 端口，默认 `22`
- `main_username`：主账号
- `sub_usernames`：子账号列表
- `repo_paths`：不同账号对应的远端仓库路径
- `refresh_interval`：任务刷新间隔（秒）

### 一个可参考的配置示例

```json
{
  "server_ip": "10.10.10.10",
  "server_port": 22,
  "main_username": "main_user",
  "sub_usernames": ["gpu_user_1", "gpu_user_2"],
  "repo_paths": {
    "main_user": "/data/repos/Task_Manager",
    "gpu_user_1": "/data/repos/Task_Manager",
    "gpu_user_2": "/data/repos/Task_Manager"
  },
  "refresh_interval": 10
}
```

---

## 5. 推荐的一键部署流程

适合新机器或新同事接手时直接照做：

```bash
git clone <your-repo-url>
cd Task_Manager
./run_local.sh
```

Windows:

```bat
git clone <your-repo-url>
cd Task_Manager
run_local.bat
```

然后：

1. 浏览器访问 `http://127.0.0.1:8000`
2. 在“配置”页填入远端 SSH 信息
3. 先执行连接测试
4. 连接通过后再浏览实验、提交任务、查看日志、同步结果

---

## 6. 如果想手动启动，也可以按下面拆开执行

### 6.1 创建并激活虚拟环境

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 6.2 安装后端依赖

```bash
pip install --upgrade pip
pip install -e backend
```

### 6.3 安装前端依赖

```bash
cd frontend
npm ci
cd ..
```

### 6.4 构建前端

```bash
cd frontend
npm run build
cd ..
```

### 6.5 启动后端

```bash
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend
```

---

## 7. 数据与运行产物说明

### 本地数据库

默认数据库位置：

```text
backend/data/app.db
```

用于保存：

- 任务快照
- 刷新状态
- 同步元数据

### 主要可忽略目录

以下内容已在 `.gitignore` 中忽略，不应提交：

- `.venv/`
- `frontend/node_modules/`
- `frontend/dist/`
- `backend/data/runtime-config/`
- `backend/data/*.db`
- 各类缓存、日志、构建产物

---

## 8. 常见问题排查

### 8.1 `python3` 不存在

安装 Python 3.11 或更高版本后重试。

### 8.2 `node` / `npm` 不存在

安装 Node.js 18+ 后重试。

### 8.3 启动成功但页面无法操作

通常是远端 SSH 配置未完成，请检查：

- 本机是否已经配置可用 SSH Key
- `server_ip` / `server_port` 是否正确
- `main_username` / `sub_usernames` 是否正确
- `repo_paths` 是否对应远端真实仓库目录

### 8.4 修改了前端代码但页面没有变化

重新执行：

```bash
./run_local.sh
```

脚本会在检测到前端源码更新后自动重新构建。

### 8.5 修改了后端依赖声明但环境没更新

重新执行：

```bash
./run_local.sh
```

脚本会在检测到 `backend/pyproject.toml` 变化后自动重新安装依赖。

### 8.6 为什么 run_local 没有自动 pull 最新代码

`run_local` 的自动更新采用“尽量安全”的策略，只会在以下条件满足时执行：

- 当前目录是 Git 仓库
- 当前分支配置了 upstream
- 远端更新可以通过 fast-forward 合并
- 本地没有未提交的已跟踪文件修改

如果本地分支领先远端、与远端分叉、处于 detached HEAD，或本地有已跟踪文件改动，脚本会跳过自动 pull，并继续使用当前代码启动。

---

## 9. 后端测试

```bash
source .venv/bin/activate
python -m unittest discover -s backend/tests
```

---

## 10. 给团队的最短交付说明

如果你只是想把“clone 后怎么跑”这件事发给同事，直接发下面三行即可：

```bash
git clone <your-repo-url>
cd Task_Manager
./run_local.sh
```

然后告诉他：浏览器打开 `http://127.0.0.1:8000`，先去“配置”页填写 SSH 信息。
