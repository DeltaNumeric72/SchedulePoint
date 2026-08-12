"""Prove at RUNTIME that a solve performs no network egress and holds no database.

SPEC-04 §1.1 and S-15t: "**Solver worker holds no database credential** … It
receives a problem, returns a result. It cannot read or write tenant tables", and
the test contract's expected outcome is "**No credential exists; connection
impossible**".

The cheap way to satisfy that is prose. This module is the expensive way, and it
is worth the expense: the claim is a security boundary, and a security boundary
that is only asserted in a document is one that a future ``import requests`` for
"just telemetry" quietly removes while every document still says otherwise.

Two enforcements, in the order they matter:

* **Sockets are replaced with raising stubs before the solve begins.** If
  anything — our code, the solver library, a protobuf runtime, a transitive
  dependency's import-time analytics — tried to open a connection or resolve a
  name, the solve fails loudly instead of quietly phoning home. This is the only
  module permitted to import ``socket`` **or ``_socket``**, and a test asserts
  that. Both are stubbed: ``socket.socket`` is a thin Python wrapper over the C
  accelerator ``_socket.socket``, and replacing only the wrapper left
  ``import _socket`` as a working bypass.
* **A database driver in the process is a refusal, not a warning.** The absence
  of a credential is the primary control; this is the detector for the case where
  a driver arrives first and somebody reaches for a credential afterwards.

Note what is deliberately *not* claimed: this is a defence-in-depth control
inside the process, not a sandbox. A determined attacker with code execution in
the worker can undo it. Its value is that an accidental egress path cannot exist
undetected, and that a deliberate one has to be written as a deliberate one.
"""

from __future__ import annotations

import socket
import sys
from typing import Any, Dict

try:  # pragma: no cover - present on every CPython build this targets
    import _socket
except ImportError:  # pragma: no cover
    _socket = None  # type: ignore[assignment]

#: Module names that mean a database client is resident in this process.
FORBIDDEN_MODULES = (
    "psycopg",
    "psycopg2",
    "asyncpg",
    "sqlalchemy",
    "sqlite3",
    "pymysql",
    "MySQLdb",
    "pyodbc",
)

_INSTALLED = False


class EgressBlocked(RuntimeError):
    """Raised when something in the solve attempts network egress."""


class DatabaseClientPresent(RuntimeError):
    """Raised when a database driver is resident in the worker process."""


def _blocked(*_args: Any, **_kwargs: Any) -> Any:
    raise EgressBlocked("solver worker attempted network egress; refused by policy (SPEC-04 §1.1)")


def assert_no_database_client() -> None:
    """Refuse to solve in a process that has a database driver loaded."""
    resident = [name for name in FORBIDDEN_MODULES if name in sys.modules]
    if resident:
        raise DatabaseClientPresent(
            "a database client is resident in the solver worker (%s); SPEC-04 §1.1 forbids it"
            % ", ".join(sorted(resident))
        )


def install() -> Dict[str, Any]:
    """Disable socket creation and name resolution; assert no driver is loaded.

    Idempotent. Returns a status record that travels in the response, so every
    solve carries evidence that the guard was in force rather than an assumption
    that it was.
    """
    global _INSTALLED
    assert_no_database_client()
    if _INSTALLED:
        return {"state": "already-installed", "databaseClient": "absent"}
    socket.socket = _blocked  # type: ignore[assignment]
    socket.create_connection = _blocked  # type: ignore[assignment]
    socket.getaddrinfo = _blocked  # type: ignore[assignment]
    # `socket.socket` is a thin wrapper; `_socket.socket` is the C accelerator it
    # is built on, and it stays reachable when only the wrapper is replaced —
    # `import _socket; _socket.socket(...)` walked straight past the guard. Both
    # are stubbed, so the bypass the independent review demonstrated is closed.
    if _socket is not None:
        _socket.socket = _blocked  # type: ignore[assignment]
        if hasattr(_socket, "getaddrinfo"):
            _socket.getaddrinfo = _blocked  # type: ignore[assignment]
    _INSTALLED = True
    return {"state": "installed", "databaseClient": "absent"}
