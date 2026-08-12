"""Cancellation — layer 2 of SPEC-04 §2's three, and the one that was measured.

SPEC-04 §2 layers cancellation because the first two mechanisms can fail:

    1. solver-native deadline        -> the adapter's own time limit
    2. control channel + solver stop -> **this module** supplies the flag
    3. subprocess termination        -> the parent's, and needs nothing here

**POSIX signals are prohibited as the cancellation channel**, and that is a
measured finding rather than a preference. EV-M0-SPC H-4 (and FAD-10, which
raised it into the architecture record): Python runs signal handlers only on the
main thread, and only while that thread is executing bytecode. During a blocking
native solve it is doing neither, so delivery waits for a Python callback that
happens to land on the main thread — **28 s of measured latency, and an outcome
the worker then misreported**. A watcher *thread* is not subject to that: it runs
independently of what the main thread is doing inside the native library, and the
same spike measured ``StopSearch()`` from a watcher thread at **17 ms** against
**113 ms** for a per-solution callback.

So: one daemon thread, polling a sentinel path supplied by the parent on the
control channel, setting a :class:`threading.Event` the solve loop observes.

``apps/api/test/solver/worker-invariants.test.ts`` scans this package and
fails if ``signal.signal`` appears anywhere in it. The prohibition is a rule with
a scanner behind it, not a paragraph — a paragraph is what the next person
reaches for a signal handler in spite of.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Dict, Optional

#: How often the watcher looks. Ten milliseconds is well inside the measured
#: 17 ms stop latency, so the poll is not the dominant term; making it smaller
#: would burn a core to shave a fraction of something else's cost.
DEFAULT_POLL_INTERVAL_SECONDS = 0.010


class CancelChannel:
    """A cancellation flag, plus the timestamps needed to attribute latency.

    ``channel='none'`` is a real configuration and not a disabled control: an
    ordinary build that nobody cancels has no sentinel path, and starting a
    watcher for it would spend a thread per solve on nothing.
    """

    def __init__(
        self,
        channel: str = "none",
        cancel_file: Optional[str] = None,
        poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> None:
        if channel not in ("none", "file"):
            raise ValueError("unknown cancel channel %r" % channel)
        if channel == "file" and not cancel_file:
            raise ValueError("the 'file' cancel channel requires a path")
        self.channel = channel
        self.cancel_file = cancel_file
        self.poll_interval_seconds = poll_interval_seconds
        self.event = threading.Event()
        #: Monotonic instant the worker first OBSERVED the request.
        self.observed_at: Optional[float] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._poll_count = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self.channel != "file":
            return
        self._thread = threading.Thread(
            target=self._watch, name="sp-cancel-watcher", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            # Bounded: a watcher that will not join must never hold the response
            # back. It is a daemon thread, so the interpreter will not wait for
            # it either.
            self._thread.join(timeout=1.0)

    # -- the flag ----------------------------------------------------------

    def is_cancelled(self) -> bool:
        return self.event.is_set()

    def _trip(self) -> None:
        if self.observed_at is None:
            self.observed_at = time.monotonic()
        self.event.set()

    def _watch(self) -> None:
        path = self.cancel_file
        assert path is not None  # constructor-enforced
        while not self._stop.is_set():
            self._poll_count += 1
            if os.path.exists(path):
                self._trip()
                return
            time.sleep(self.poll_interval_seconds)

    # -- reporting ---------------------------------------------------------

    def report(self) -> Dict[str, Any]:
        """What the response carries about this channel. No paths, no content."""
        return {
            "channel": self.channel,
            "cancelled": self.event.is_set(),
            "pollCount": self._poll_count,
            "pollIntervalSeconds": (
                self.poll_interval_seconds if self.channel == "file" else None
            ),
        }
