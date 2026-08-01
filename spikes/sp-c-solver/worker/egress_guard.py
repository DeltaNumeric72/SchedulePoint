"""Prove, at runtime, that the solve performs no network egress.

SPIKE CODE — SP-C / SP-5.

SPEC-04 §1.1: the worker receives a problem and returns a result. It holds no
database credential and needs no network access beyond the RPC channel itself —
which, in this spike, is stdin/stdout and therefore not a socket at all.

Rather than assert that in prose, the worker replaces the socket constructors
with raising stubs for the duration of the solve. If anything in the solver
stack, the protobuf runtime, or our own code tried to open a connection, the
solve would fail loudly instead of quietly phoning home.

This is the only module permitted to import ``socket``; the H-0 static check
enforces that.
"""

from __future__ import annotations

import socket

INSTALLED = False


class EgressBlocked(RuntimeError):
    pass


def _blocked(*args, **kwargs):
    raise EgressBlocked("solver worker attempted network egress; blocked by policy")


def install() -> str:
    """Disable socket creation and name resolution. Returns a status string."""
    global INSTALLED
    if INSTALLED:
        return "already_installed"
    socket.socket = _blocked  # type: ignore[assignment]
    socket.create_connection = _blocked  # type: ignore[assignment]
    socket.getaddrinfo = _blocked  # type: ignore[assignment]
    INSTALLED = True
    return "installed"
