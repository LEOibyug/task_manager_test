from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Protocol

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


class SSHGatewayProtocol(Protocol):
    def run(self, username: str, command: str, cwd: str | None = None) -> CommandResult:
        ...

    def read_file(self, username: str, path: str) -> str:
        ...

    def read_bytes(self, username: str, path: str) -> bytes:
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

    def _get_client(self, username: str) -> "paramiko.SSHClient":
        if paramiko is None:
            raise SSHError("paramiko is not installed. Please install backend dependencies.")
        client = self._clients.get(username)
        if client is not None:
            return client
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(self.host, port=self.port, username=username, look_for_keys=True)
        self._clients[username] = client
        return client

    def run(self, username: str, command: str, cwd: str | None = None) -> CommandResult:
        client = self._get_client(username)
        remote_command = command if cwd is None else f"cd {cwd} && {command}"
        stdin, stdout, stderr = client.exec_command(remote_command)
        exit_code = stdout.channel.recv_exit_status()
        return CommandResult(
            command=remote_command,
            stdout=stdout.read().decode("utf-8", errors="replace"),
            stderr=stderr.read().decode("utf-8", errors="replace"),
            exit_code=exit_code,
        )

    def read_file(self, username: str, path: str) -> str:
        return self.read_bytes(username, path).decode("utf-8", errors="replace")

    def read_bytes(self, username: str, path: str) -> bytes:
        client = self._get_client(username)
        with client.open_sftp() as sftp:
            with sftp.file(path, "r") as remote_file:
                return remote_file.read()

    def stat(self, username: str, path: str) -> bool:
        client = self._get_client(username)
        with client.open_sftp() as sftp:
            try:
                sftp.stat(path)
                return True
            except FileNotFoundError:
                return False

    def listdir(self, username: str, path: str) -> list[tuple[str, bool]]:
        client = self._get_client(username)
        with client.open_sftp() as sftp:
            entries = []
            for entry in sftp.listdir_attr(path):
                is_dir = bool(entry.st_mode & 0o040000)
                entries.append((str(PurePosixPath(path) / entry.filename), is_dir))
            return entries

    def close(self) -> None:
        for client in self._clients.values():
            client.close()
        self._clients.clear()


class InMemorySSHGateway:
    def __init__(
        self,
        files: dict[str, dict[str, str | bytes]] | None = None,
        commands: dict[tuple[str, str], CommandResult] | None = None,
    ) -> None:
        self.files = files or {}
        self.commands = commands or {}

    def run(self, username: str, command: str, cwd: str | None = None) -> CommandResult:
        key = (username, f"{cwd or ''}::{command}")
        result = self.commands.get(key)
        if result is not None:
            return result
        return CommandResult(command=command, stdout="", stderr="", exit_code=0)

    def read_file(self, username: str, path: str) -> str:
        return self.read_bytes(username, path).decode("utf-8", errors="replace")

    def read_bytes(self, username: str, path: str) -> bytes:
        try:
            content = self.files[username][path]
        except KeyError as exc:
            raise SSHError(f"Remote file not found: {username}:{path}") from exc
        return content.encode("utf-8") if isinstance(content, str) else content

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
