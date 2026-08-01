"""Placeholder entrypoint.

The solver image's ``CMD`` targets this module. It exits non-zero on purpose: a
solver container that starts successfully while containing no solver would be a
worse outcome than one that refuses to run.
"""

import sys


def main() -> int:
    sys.stderr.write(
        "schedulepoint-solver: skeleton only — no solver is implemented.\n"
        "The RPC worker lands after the OPUS-M0-003 boundary spike (SPEC-04).\n"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
