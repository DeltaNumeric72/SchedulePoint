# SchedulePoint — solver image (image 3 of 3).
#
# ############################################################################
# # SKELETON. Structure and syntax only. NOT BUILT in this environment       #
# # (FAD-7: no Docker daemon). Nothing here has been executed.               #
# ############################################################################
#
# The scheduling worker (ADR-0006 / ADR-0020 / SPEC-04). Python because CP-SAT
# is; a separate image because its resource profile, its lifetime and — most
# importantly — its **trust surface** are different from the application's.
#
# Non-negotiable properties of this image, all of which are cheaper to establish
# now than to retrofit:
#  - **no database credential and no database client.** The worker receives a
#    problem and returns a solution. It never reads tenant data, which is why it
#    needs no unit of work and can never breach tenant isolation.
#  - **one solve per subprocess**, so a cancel is a kill and a kill is clean.
#  - no OR-Tools code exists yet: OPUS-M0-003 is the spike that proves the
#    boundary, and its findings shape what lands here.

FROM python:3.12-slim-bookworm AS base
WORKDIR /solver
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

FROM base AS deps
COPY pyproject.toml ./
# `pip install .` resolves the pinned dependency set from pyproject.toml.
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir .

FROM base AS runtime
COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY schedulepoint_solver ./schedulepoint_solver

RUN useradd --create-home --shell /usr/sbin/nologin solver
USER solver

# Placeholder entrypoint. The RPC server lands after OPUS-M0-003.
CMD ["python", "-m", "schedulepoint_solver"]
