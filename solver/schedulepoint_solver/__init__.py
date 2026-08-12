"""SchedulePoint scheduling worker.

**M4-001 ships the boundary and a stub solve.** The RPC envelope, the mutual
authentication, the one-solve-per-subprocess lifetime, the layered cancellation
and the reproducibility record are all real; the *model* is a deterministic
greedy fill that makes no claim it cannot support. M4-002 replaces
``stub_solver`` with the CP-SAT adapter and nothing else in this package moves.

The rules that constrain every line added here, each cheaper to hold from the
start than to restore later:

* **No database access, ever.** The worker receives a problem and returns a
  solution. It holds no credential and opens no connection, which is why it can
  never breach tenant isolation and needs no unit of work (SPEC-04 §1.1, S-15t).
  ``egress_guard`` turns that from a claim into a runtime property.
* **No solver type crosses the boundary.** The problem and solution schemas are
  solver-neutral; ``ortools`` may be imported in exactly one adapter module, so
  the engine can be replaced without renegotiating the contract (ADR-0006).
* **One solve per subprocess**, so a cancel can become a kill and a kill is
  clean (ADR-0020, SPEC-04 §2 mechanism 3).
* **Cancellation is a watcher thread, never a signal.** EV-M0-SPC H-4 measured
  the signal path at 28 s with a misreported outcome; FAD-10 made the
  prohibition architectural.
* **Every run records seed, parameters, worker count, library and image
  versions** — reproducibility is a recorded fact, and after the SPEC-04 §4
  amendment it is a *computed* one (report 21 §7, FAD-10).
* **Synthetic problems only.** No staff, patient or customer data reaches the
  worker.
"""

__all__ = ["__version__"]

#: The worker's own version. Distinct from the solver library version and from
#: the image digest, both of which are recorded separately per solve.
__version__ = "1.0.0"
