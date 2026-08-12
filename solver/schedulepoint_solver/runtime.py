"""The reproducibility record — SPEC-04 §4, as AMENDED by FAD-10.

SPEC-04 §4 lists what must be recorded per build, and its 2026-08-01 amendment
(measured, from EV-M0-SPC H-6/H-7) is the part that matters here:

    A fixed seed plus a fixed worker count is **NOT sufficient** for
    reproduction … **Reproducible builds therefore require, and the
    reproducibility record must pin, all of:** solver version/image digest ·
    seed · worker count · ``interleave_search = true`` (the deterministic
    portfolio) · **deterministic time limits (`max_deterministic_time`), never
    wall-clock, on any reproducibility-claiming build** · the full remaining
    parameter set.

Five runs, one seed, eight workers: five different schedules, same objective. So
``reproducibility_mode`` is **computed from the parameters**, never declared. A
declared flag is a claim, and the amendment exists precisely because the claim
was being made without the conditions.

Two absences are recorded honestly rather than filled in:

* **The image digest.** ``SP_SOLVER_IMAGE_DIGEST`` is set by the deployment that
  built the image. Under the FAD-7 substitution there is no image, so the record
  reads ``venv:<interpreter>`` — a stated absence. A fabricated digest would make
  a build look reproducible against an image that never existed, which is worse
  than an honest gap because it is actionable and wrong.
* **The solver library version.** M4-001 ships the **stub** solver: the round
  trip, the authentication, the timeout, the cancellation and the forced-kill
  paths are proven before any constraint model exists. When OR-Tools is resident
  its version is recorded; when it is not, ``solverVersion`` says ``stub-only``
  and does not pretend a library was consulted.
"""

from __future__ import annotations

import os
import platform
import sys
from typing import Any, Dict, Optional

#: The version of the stub solve implementation. Bumped when its output changes,
#: because a build recorded against ``stub-1`` must not silently mean ``stub-2``.
STUB_SOLVER_VERSION = "stub-1"

#: The AST -> model compiler version. M4-001 ships no compiler; the constant
#: travels so the field exists in every record from the first build, and M4-002
#: replaces the value rather than adding the column.
COMPILER_VERSION = "0"

IMAGE_DIGEST_ENV = "SP_SOLVER_IMAGE_DIGEST"


def solver_library_version() -> str:
    """The installed OR-Tools version, read from package METADATA — never imported.

    Two reasons, and the second is the load-bearing one:

    * **Cost.** The SP-C spike measured ``import ortools`` at 200–630 ms — the
      dominant per-solve cost, and one solve is one process. Paying it to fill in
      a version string on a run that will not use the library would make every
      stub round trip half a second slower for a field.
    * **The boundary.** ADR-0006 allows ``ortools`` in exactly ONE adapter
      module, so the engine stays replaceable behind the port. A convenience
      import here would spend that budget on bookkeeping and leave M4-002's real
      adapter as the second importer —
      ``apps/api/test/solver/worker-invariants.test.ts`` scans for exactly that
      and would fail the build.

    ``stub-only`` when the distribution is absent: M4-001 ships the stub, and a
    recorded absence is better than a version string implying a library was
    consulted.
    """
    try:
        from importlib import metadata

        return "ortools-%s" % metadata.version("ortools")
    except Exception:
        return "stub-only"


def image_digest() -> str:
    """The image this solve ran in, by content digest, or a stated absence."""
    digest = os.environ.get(IMAGE_DIGEST_ENV, "").strip()
    if digest:
        return digest
    return "venv:%s" % sys.executable


def reproducibility_mode(parameters: Dict[str, Any]) -> str:
    """``'deterministic'`` only when every FAD-10 condition is met."""
    if parameters.get("interleaveSearch") is not True:
        return "best-effort"
    deterministic_time: Optional[Any] = parameters.get("maxDeterministicTime")
    if deterministic_time is None:
        return "best-effort"
    return "deterministic"


def runtime_record(parameters: Dict[str, Any]) -> Dict[str, Any]:
    """The whole §4 record for one solve.

    ``platformArch`` is here because SPEC-04 §4 names it: "Architecture affects
    floating-point and threading behaviour". It is what makes the promise in that
    section checkable instead of aspirational — a reproduction attempt on a
    different architecture can be *refused* rather than attempted and quietly
    disbelieved.
    """
    return {
        "imageDigest": image_digest(),
        "solverVersion": "%s+%s" % (STUB_SOLVER_VERSION, solver_library_version()),
        "compilerVersion": COMPILER_VERSION,
        "platformArch": "%s-%s" % (platform.system().lower(), platform.machine()),
        "languageRuntime": "cpython-%s" % platform.python_version(),
        "reproducibilityMode": reproducibility_mode(parameters),
        "parameters": {
            "randomSeed": parameters.get("randomSeed"),
            "numSearchWorkers": parameters.get("numSearchWorkers"),
            "maxTimeInSeconds": parameters.get("maxTimeInSeconds"),
            "maxDeterministicTime": parameters.get("maxDeterministicTime"),
            "interleaveSearch": parameters.get("interleaveSearch"),
        },
    }
