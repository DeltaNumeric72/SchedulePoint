"""Cancellation control channel for the solver worker (layer 2 of 3).

SPIKE CODE — SP-C / SP-5. No solver import here.

SPEC-04 §2 layers cancellation:

  1. solver-native deadline          -> handled by the adapter's time limit
  2. cooperative callback + control  -> **this module** supplies the flag
  3. SIGKILL of the subprocess       -> handled by the parent; needs nothing here

The control channel in production is the worker's authenticated RPC control
channel. A spike cannot stand that up, so two stand-ins are implemented and
**both are measured**, because the choice has a real latency consequence:

``file``   a watcher thread polls for a sentinel file. Works regardless of
           which thread the solver calls back on.
``signal`` SIGUSR1. Python runs signal handlers **only on the main thread**, and
           only when that thread is executing bytecode. During a blocking native
           solve it is not. Delivery therefore waits for a Python callback that
           happens to run on the main thread. Measured, not assumed.
"""

from __future__ import annotations

import os
import signal
import threading
import time
from typing import Optional

POLL_INTERVAL_SECONDS = 0.010


class CancelChannel:
    """A cancellation flag plus the timestamps needed to attribute latency."""

    def __init__(self, channel: str = "none", cancel_file: Optional[str] = None):
        if channel not in ("none", "file", "signal"):
            raise ValueError("unknown cancel channel %r" % channel)
        self.channel = channel
        self.cancel_file = cancel_file
        self.event = threading.Event()
        # Monotonic instant at which the worker first *observed* the request.
        self.observed_at: Optional[float] = None
        # Monotonic instant at which solver-facing code first acted on it.
        self.acted_at: Optional[float] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._poll_count = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self.channel == "signal":
            signal.signal(signal.SIGUSR1, self._on_signal)
        elif self.channel == "file":
            if not self.cancel_file:
                raise ValueError("cancel_file required for the 'file' channel")
            self._thread = threading.Thread(
                target=self._watch_file, name="cancel-watcher", daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)

    # -- flag --------------------------------------------------------------

    def is_cancelled(self) -> bool:
        return self.event.is_set()

    def mark_acted(self) -> None:
        if self.acted_at is None:
            self.acted_at = time.monotonic()

    def _trip(self) -> None:
        if self.observed_at is None:
            self.observed_at = time.monotonic()
        self.event.set()

    # -- channels ----------------------------------------------------------

    def _on_signal(self, signum, frame):  # pragma: no cover - timing dependent
        self._trip()

    def _watch_file(self) -> None:
        assert self.cancel_file is not None
        while not self._stop.is_set():
            self._poll_count += 1
            if os.path.exists(self.cancel_file):
                self._trip()
                return
            time.sleep(POLL_INTERVAL_SECONDS)

    # -- reporting ---------------------------------------------------------

    def report(self) -> dict:
        return {
            "channel": self.channel,
            "cancelled": self.event.is_set(),
            "poll_count": self._poll_count,
            "poll_interval_seconds": POLL_INTERVAL_SECONDS
            if self.channel == "file"
            else None,
        }
