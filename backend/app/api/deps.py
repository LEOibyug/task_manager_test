from __future__ import annotations

from starlette.requests import HTTPConnection

from app.container import AppContainer


def get_container(connection: HTTPConnection) -> AppContainer:
    return connection.app.state.container
