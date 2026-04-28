from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from threading import Lock
import time
from typing import Any, Callable, Protocol

try:
    import paramiko
except ImportError:  # pragma: no cover - optional at import time
    paramiko = None


@dataclass
class CommandResult:
    command: str
    stdout: str
    stderr: str
    exit_code: int


CommandLogger = Callable[[dict[str, Any]], None]


class SSHGatewayProtocol(Protocol):
    def run(
        self,
        username: str,
        command: str,
        cwd: str | None = None,
        logger: CommandLogger | None = None,
        get_pty: bool = False,
    ) -> CommandResult:
        ...

    def read_file(self, username: str, path: str) -> str:
        ...

    def read_bytes(self, username: str, path: str) -> bytes:
        ...

    def read_bytes_range(self, username: str, path: str, start: int = 0, max_bytes: int | None = None) -> tuple[bytes, int]:
        ...

    def read_bytes_tail(self, username: str, path: str, max_bytes: int) -> tuple[bytes, int, int]:
        ...

    def stat(self, username: str, path: str) -> bool:
        ...

    def listdir(self, username: str, path: str) -> list[tuple[str, bool]]:
        ...

    def close(self) -> None:
        ...


class SSHError(RuntimeError):
    pass


class ParamikoSSHGateway:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self._clients: dict[str, "paramiko.SSHClient"] = {}
        self._client_locks: dict[str, Lock] = {}
        self._clients_lock = Lock()

    def _get_client(self, username: str) -> "paramiko.SSHClient":
        if paramiko is None:
            raise SSHError("paramiko is not installed. Please install backend dependencies.")
        with self._clients_lock:
            client = self._clients.get(username)
            if client is not None:
                return client
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(self.host, port=self.port, username=username, look_for_keys=True)
            self._clients[username] = client
            self._client_locks.setdefault(username, Lock())
            return client

    def _get_client_lock(self, username: str) -> Lock:
        with self._clients_lock:
            return self._client_locks.setdefault(username, Lock())

    def run(
        self,
        username: str,
        command: str,
        cwd: str | None = None,
        logger: CommandLogger | None = None,
        get_pty: bool = False,
    ) -> CommandResult:
        with self._get_client_lock(username):
            client = self._get_client(username)
            remote_command = command if cwd is None else f"cd {cwd} && {command}"
            if logger is not None:
                logger(
                    {
                        "stage": "command_start",
                        "username": username,
                        "command": remote_command,
                        "message": f"$ {remote_command}",
                    }
                )
            stdin, stdout, stderr = client.exec_command(remote_command, get_pty=get_pty)
            channel = stdout.channel
            stdout_chunks: list[str] = []
            stderr_chunks: list[str] = []
            while True:
                made_progress = False
                if channel.recv_ready():
                    data = channel.recv(4096)
                    if data:
                        text = data.decode("utf-8", errors="replace")
                        stdout_chunks.append(text)
                        if logger is not None:
                            logger(
                                {
                                    "stage": "stdout",
                                    "username": username,
                                    "command": remote_command,
                                    "message": text,
                                }
                            )
                    made_progress = True
                if not get_pty and channel.recv_stderr_ready():
                    data = channel.recv_stderr(4096)
                    if data:
                        text = data.decode("utf-8", errors="replace")
                        stderr_chunks.append(text)
                        if logger is not None:
                            logger(
                                {
                                    "stage": "stderr",
                                    "username": username,
                                    "command": remote_command,
                                    "message": text,
                                }
                            )
                    made_progress = True
                if channel.exit_status_ready():
                    if not channel.recv_ready() and (get_pty or not channel.recv_stderr_ready()):
                        break
                if not made_progress:
                    time.sleep(0.05)
            exit_code = channel.recv_exit_status()
            stdout_text = "".join(stdout_chunks)
            stderr_text = "" if get_pty else "".join(stderr_chunks)
            if logger is not None:
                logger(
                    {
                        "stage": "command_end",
                        "username": username,
                        "command": remote_command,
                        "message": f"Command finished with exit code {exit_code}",
                        "exit_code": exit_code,
                    }
                )
            return CommandResult(
                command=remote_command,
                stdout=stdout_text,
                stderr=stderr_text,
                exit_code=exit_code,
            )

    def read_file(self, username: str, path: str) -> str:
        return self.read_bytes(username, path).decode("utf-8", errors="replace")

    def read_bytes(self, username: str, path: str) -> bytes:
        data, _ = self.read_bytes_range(username, path)
        return data

    def read_bytes_range(self, username: str, path: str, start: int = 0, max_bytes: int | None = None) -> tuple[bytes, int]:
        with self._get_client_lock(username):
            client = self._get_client(username)
            with client.open_sftp() as sftp:
                try:
                    size = int(sftp.stat(path).st_size)
                    safe_start = max(0, min(start, size))
                    with sftp.file(path, "r") as remote_file:
                        remote_file.seek(safe_start)
                        return remote_file.read() if max_bytes is None else remote_file.read(max_bytes), size
                except FileNotFoundError as exc:
                    raise SSHError(f"Remote file not found: {username}:{path}") from exc

    def read_bytes_tail(self, username: str, path: str, max_bytes: int) -> tuple[bytes, int, int]:
        with self._get_client_lock(username):
            client = self._get_client(username)
            with client.open_sftp() as sftp:
                try:
                    size = int(sftp.stat(path).st_size)
                    start = max(0, size - max(0, max_bytes))
                    with sftp.file(path, "r") as remote_file:
                        remote_file.seek(start)
                        return remote_file.read(size - start), size, start
                except FileNotFoundError as exc:
                    raise SSHError(f"Remote file not found: {username}:{path}") from exc

    def stat(self, username: str, path: str) -> bool:
        with self._get_client_lock(username):
            client = self._get_client(username)
            with client.open_sftp() as sftp:
                try:
                    sftp.stat(path)
                    return True
                except FileNotFoundError:
                    return False

    def listdir(self, username: str, path: str) -> list[tuple[str, bool]]:
        with self._get_client_lock(username):
            client = self._get_client(username)
            with client.open_sftp() as sftp:
                entries = []
                for entry in sftp.listdir_attr(path):
                    is_dir = bool(entry.st_mode & 0o040000)
                    entries.append((str(PurePosixPath(path) / entry.filename), is_dir))
                return entries

    def close(self) -> None:
        with self._clients_lock:
            for client in self._clients.values():
                client.close()
            self._clients.clear()
            self._client_locks.clear()


class InMemorySSHGateway:
    def __init__(
        self,
        files: dict[str, dict[str, str | bytes]] | None = None,
        commands: dict[tuple[str, str], CommandResult] | None = None,
    ) -> None:
        self.files = files or {}
        self.commands = commands or {}

    def run(self, username: str, command: str, cwd: str | None = None) -> CommandResult:
        return self._run(username, command, cwd=cwd)

    def _run(
        self,
        username: str,
        command: str,
        cwd: str | None = None,
        logger: CommandLogger | None = None,
        get_pty: bool = False,
    ) -> CommandResult:
        key = (username, f"{cwd or ''}::{command}")
        result = self.commands.get(key)
        remote_command = command if cwd is None else f"cd {cwd} && {command}"
        if logger is not None:
            logger(
                {
                    "stage": "command_start",
                    "username": username,
                    "command": remote_command,
                    "message": f"$ {remote_command}",
                }
            )
        if result is not None:
            if logger is not None and result.stdout:
                logger(
                    {
                        "stage": "stdout",
                        "username": username,
                        "command": remote_command,
                        "message": result.stdout,
                    }
                )
            if logger is not None and result.stderr:
                logger(
                    {
                        "stage": "stderr",
                        "username": username,
                        "command": remote_command,
                        "message": result.stderr,
                    }
                )
            if logger is not None:
                logger(
                    {
                        "stage": "command_end",
                        "username": username,
                        "command": remote_command,
                        "message": f"Command finished with exit code {result.exit_code}",
                        "exit_code": result.exit_code,
                    }
                )
            return result
        if logger is not None:
            logger(
                {
                    "stage": "command_end",
                    "username": username,
                    "command": remote_command,
                    "message": "Command finished with exit code 0",
                    "exit_code": 0,
                }
            )
        return CommandResult(command=command, stdout="", stderr="", exit_code=0)

    def run(
        self,
        username: str,
        command: str,
        cwd: str | None = None,
        logger: CommandLogger | None = None,
        get_pty: bool = False,
    ) -> CommandResult:
        return self._run(username, command, cwd=cwd, logger=logger, get_pty=get_pty)

    def read_file(self, username: str, path: str) -> str:
        return self.read_bytes(username, path).decode("utf-8", errors="replace")

    def read_bytes(self, username: str, path: str) -> bytes:
        data, _ = self.read_bytes_range(username, path)
        return data

    def read_bytes_range(self, username: str, path: str, start: int = 0, max_bytes: int | None = None) -> tuple[bytes, int]:
        try:
            content = self.files[username][path]
        except KeyError as exc:
            raise SSHError(f"Remote file not found: {username}:{path}") from exc
        data = content.encode("utf-8") if isinstance(content, str) else content
        size = len(data)
        safe_start = max(0, min(start, size))
        chunk = data[safe_start:] if max_bytes is None else data[safe_start : safe_start + max_bytes]
        return chunk, size

    def read_bytes_tail(self, username: str, path: str, max_bytes: int) -> tuple[bytes, int, int]:
        data, size = self.read_bytes_range(username, path)
        start = max(0, size - max(0, max_bytes))
        return data[start:], size, start

    def stat(self, username: str, path: str) -> bool:
        user_files = self.files.get(username, {})
        if path in user_files:
            return True
        prefix = path.rstrip("/") + "/"
        return any(name.startswith(prefix) for name in user_files)

    def listdir(self, username: str, path: str) -> list[tuple[str, bool]]:
        user_files = self.files.get(username, {})
        prefix = path.rstrip("/") + "/"
        children: dict[str, bool] = {}
        for name in user_files:
            if not name.startswith(prefix):
                continue
            remainder = name[len(prefix):]
            if not remainder:
                continue
            head = remainder.split("/", 1)[0]
            child_path = prefix + head
            is_dir = "/" in remainder
            children[child_path] = is_dir
        return sorted(children.items())

    def close(self) -> None:
        return None
