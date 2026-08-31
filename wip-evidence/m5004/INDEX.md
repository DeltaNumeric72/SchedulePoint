# OPUS-M5-004 — implementer transcript INDEX

Packet: doc 42 §5h (SPEC-08 §5.6 commit/reverse + the §6 solver projection), under
FAD-59 and FAD-60. Base: `origin/main` 6769319. Worktree:
`<scratchpad>/wt-m5004`. Delivery: patch, never a commit or a push.

Every file below is a RAW transcript. Failed and killed attempts are retained with
their causes; nothing is edited after the fact.

| # | File | What it is | Outcome |
|---|---|---|---|
| 00 | `00-install.log` | `corepack pnpm install` in the worktree | "Done in 7.1s using pnpm v11.18.0" |
| 01 | `01-venv.log` | `python3 -m venv .venv && pip install ortools` | "Successfully installed … ortools-9.15.6755" |
| 02 | `02-typecheck.log` | FIRST typecheck — **FAILED**, 5 diagnostics (audit event names ×2, a `groupId` null cast, two snapshot fixtures missing `requestProjection`) | exit 2, all five fixed |
| 03 | `03-typecheck.log` | second typecheck — completed clean, but its two background WAITERS dead-looped (see Environment, below) | log clean |
| 04 | `04-typecheck.log` | typecheck re-run in the FOREGROUND with an explicit exit code | `EXIT=0` |
| 05 | `05-lint.log` | `corepack pnpm gate:lint` | `EXIT=0` |
| 06 | `06-domain-tests.log` | domain projection + M5-001 transitions | `EXIT=0`, 38 passed (38) |
| 07 | `07-cycle27.log` | migration 0027 populated cycle, FIRST run — **1 failed** (my assertion `.resolves.toBeDefined()` on a helper returning `void`) | exit 1, 10 passed |
| 08 | `08-cycle27.log` | same, after the assertion was corrected to a row-count delta | `EXIT=0`, 11 passed (11) |
| 09 | `09-commit-http.log` | commit/reverse HTTP, attempt 1 — **suite error**: the request-until window write needs `group.settings.administer`, which `scheduler` does not carry | 12 skipped |
| 10 | `10-commit-http.log` | attempt 2 — **suite error**: `schedule_periods_length` (0011) bounds a period at 366 days; my single shared period spanned ~580 | 12 skipped |
| 11 | `11-commit-http.log` | attempt 3 — 5 passed, 7 failed: OFF snapshots carried `origin='manual'` (the new value was not passed through), and several literal far-future dates were not Mondays | exit 1 |
| 12 | `12-commit-http.log` | attempt 4 — 8 passed, 4 failed, ALL on the REVERSAL | exit 1 |
| 13 | `13-commit-http.log` | attempt 5, after the revision-flag finding (below) | `EXIT=0`, 12 passed (12) |
| 14 | `14-projection.log` | projection + R-14 worker half, attempt 1 — 6 passed, 2 failed: the solver answers `OPTIMAL`, not `FEASIBLE` | exit 1 |
| 15 | `15-projection.log` | attempt 2, asserting membership of the shipped `SOLVED_STATUSES` | `EXIT=0`, 8 passed (8) |
| 16 | `16-projection.log` | attempt 3, with the worker-echoed objective-digest case added | `EXIT=0`, 9 passed (9) |
| 17 | `17-mutation-red.log` | **MUTATION**: `model.py`'s `cells()` HardOff drop neutered | exit 1, **2 failed** — exactly the two R-14 cases, by name |
| 18 | `18-mutation-green.log` | restored by `cp` from the pristine copy; `__pycache__` removed on both legs | `EXIT=0`, 9 passed (9); md5 identical |
| 19 | `19-rebuild.log` | R-14 on a real rebuild, attempt 1 — 2 passed, 1 failed (`createDraftVersion` takes `periodId` positionally) | exit 1 |
| 20 | `20-rebuild.log` | attempt 2 | `EXIT=0`, 3 passed (3) |
| 21 | `21-check.log` | full `pnpm check`, attempt 1 — **KILLED BY ME** after the typecheck gate went red on two test-only type errors | killed deliberately |
| 22 | `22-typecheck.log` | typecheck after the helper-type fix — still red: `origin: 'vacation_commit'` not in `AddAssignmentInput`'s union, plus an unused fixture variable | exit 2 |
| 23 | `23-typecheck.log` | typecheck after widening that union with its reasoning | `EXIT=0` |
| 24 | `24-check.log` | full check, attempt 2 — **3 gates red, all three caused by MY kill of attempt 1**: an orphan postmaster on port 55744, and a `vite preview` still holding port 41838 (axe), which cascaded into request-budget's missing recordings | `CHECK_EXIT=1`, diagnosed not re-run |
| 25 | `25-check.log` | full check, attempt 3, on a box cleaned by pid chain | see the report |

## Environment record

- **The pgrep/pkill self-match trap, FIFTH recorded instance, first by this agent.**
  Two background waiters used `pgrep -f "tsc -b"`, which matched THEIR OWN command
  line, so they never exited and were reported as "exit code 144" task failures. The
  typecheck they were waiting for had already finished. Every subsequent wait is a
  FOREGROUND run with `echo "EXIT=$?"`, which is what produced the figures of record.
- **Killing a `pnpm check` leaves debris of two kinds, both observed here**: an orphan
  postmaster with its `.pgdata-test-*` directory (the next cluster start reports
  "STALE CLUSTER?" and names the pid), and a `vite preview` holding the axe gate's
  port. Cleaned in the register's order — kill by pid chain FIRST, remove the pgdata
  directory SECOND — after which `ps` and `lsof` both report zero.
- All source restores were by `cp` from an md5-recorded copy, never `git checkout --`.
- `scripts/red-cases/debris.mjs` PASS at every check; `git status --porcelain` carries
  only the packet's own ` M`/` A` entries and no untracked file.

## What was NOT run

- The full 69-arm red-case battery was NOT run serially on this container. The census
  argument is written in the report; the sharded CI form on the PR is the primary
  proof (FAD-54).
- `pnpm red-cases` in full was not run; no arm's mutation target intersects this
  packet's changed paths (argued in the report).
- `format:check` was not run and is not one of the seventeen gates.
