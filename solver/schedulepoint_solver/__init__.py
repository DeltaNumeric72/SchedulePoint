"""SchedulePoint scheduling worker.

**Skeleton. No solver logic exists in this package.**

The rules that will constrain every line added here, stated now because each of
them is cheaper to hold from the start than to restore later:

* **No database access, ever.** The worker receives a problem and returns a
  solution. It holds no credential and opens no connection, which is why it can
  never breach tenant isolation and needs no unit of work (SPEC-04 §1).
* **No CP-SAT type crosses the boundary.** The problem and solution schemas are
  solver-neutral; ``ortools`` may be imported in exactly one adapter module so
  the engine can be replaced without renegotiating the contract (ADR-0006).
* **One solve per subprocess**, so cancellation is a kill and a kill is clean.
* Every run records its seed, parameters, worker count and library versions —
  reproducibility is a recorded fact, not an assumption (report 21 §7).

OPUS-M0-003 is the spike that tests these; its findings shape what lands here.
"""

__all__ = ["__version__"]

__version__ = "0.0.0"
