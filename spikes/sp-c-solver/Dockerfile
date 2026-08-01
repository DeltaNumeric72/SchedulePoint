# SchedulePoint solver worker — SP-C spike image.
#
# NOT BUILT IN THIS SPIKE. See SPIKE-REPORT.md §"FAD-7 substitution": no Docker
# daemon is available in the M0 environment, so this file is authored and
# reviewed here and first built in CI. The behaviour the packet asked the spike
# to prove — subprocess spawn, deadline, cooperative cancel, SIGKILL, orphan
# cleanliness — is a property of POSIX process semantics and the OR-Tools
# library, not of the container: a SIGKILL to PID N inside a container kills the
# same process in the same way. What the container does add, and what therefore
# remains UNVERIFIED until CI builds this, is:
#   * that ortools resolves and imports on linux/amd64 and linux/arm64 slim
#   * the image size and cold-start cost of `import ortools` in the image
#   * that the non-root user can run the solve
#   * PID 1 reaping behaviour if the worker is ever run as PID 1 (it is not:
#     the worker is always a child of the dispatch process)
#
# ---------------------------------------------------------------------------
# Python version: the spike ran on CPython 3.9.6, which is what the M0 host
# provides (FAD-7: no Homebrew, no pyenv). 3.9 reached end-of-life in October
# 2025 and must not be the production runtime. The image pins 3.12, which is
# the recommendation in SPIKE-REPORT.md. That difference is deliberate and is
# itself a thing CI must verify.
# ---------------------------------------------------------------------------

# ---- stage 1: resolve dependencies into a wheel-only virtualenv -------------
FROM python:3.12-slim-bookworm AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build

# Only the pinned requirement file, so the layer caches on dependency changes
# and nothing else.
COPY requirements.txt ./
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install -r requirements.txt
# Production must tighten this to a hash-pinned lock file (pip-compile
# --generate-hashes). Left as a plain pin here so the spike does not carry a
# lock file that nobody generated from a verified environment.

# ---- stage 2: runtime -------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

# A distinct, non-root, non-login account. The worker needs no home directory,
# no shell, and no package manager at runtime.
RUN groupadd --system --gid 10001 solver \
 && useradd --system --uid 10001 --gid solver --no-create-home \
            --shell /usr/sbin/nologin solver

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=0

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=root:root worker/ /app/worker/

# The worker holds no database credential and needs no writable filesystem
# (ADR-0020). Run with `--read-only --tmpfs /tmp --network none --cap-drop ALL
# --security-opt no-new-privileges`; nothing in the worker writes to disk.
USER solver:solver

# One solve per process: the entrypoint reads one SolveRequest on stdin, writes
# one SolveResponse on stdout, and exits. There is no server loop to wedge.
ENTRYPOINT ["python", "-m", "worker.main"]
