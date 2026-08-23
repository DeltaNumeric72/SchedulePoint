# EV-REVIEW-B — REV-B: implementation and evidence review (post-M4 internal review, doc 38 §3)

**Reviewer:** REV-B — a fresh high-effort Opus agent, launched from packet text alone.
**Packet:** [docs/fable/38-post-m4-internal-review-plan.md](../../fable/38-post-m4-internal-review-plan.md) §§1–5.
**Independence:** BLIND to REV-A. At no point before filing did this reviewer fetch,
check out, read, grep, or otherwise consult branch `review/rev-a`, the directory
`docs/evidence/EV-REVIEW-A`, or any description of REV-A's findings. One consequence is
recorded honestly in §D: an untracked `.evidence-scratch/` directory and untracked
`scripts/gates/request-budget/recordings/` produced by an earlier process in this
container were **deliberately not read**, because they could carry another reviewer's
output.

**Review branch:** `review/rev-b` (never merged). **Evidence:** this directory only.
**Rule:** this reviewer implements nothing. Code-modifying probes are applied, measured
and restored byte-identically, with the applied diff recorded here.

**Machine:** 4 vCPU, 15 GiB, Linux 6.18.44. Measured slower than the M4 reference
machine (see §C figures). `SP_SOLVER_WORKER_COMMAND=/home/user/SchedulePoint/solver/.venv/bin/python`
(CPython 3.9.6 venv, OR-Tools 9.15.6755).

**Baseline (doc 38 §1):** M1–M4 claims judged at `milestone/M4` =
`cc9f3f92583565e540a4a3b682303675ba8b6a70`; the delta to `origin/main` =
`93a71f52a16c60d99fecd6c862ba952b170cfb3a` judged for non-alteration of frozen claims
plus its own correctness. Execution in this bundle is on `review/rev-b` @ `f855340`,
whose tree differs from `origin/main` only by doc 38 and the AUTO-RUN-STATE sync
(verified: `git diff --stat origin/main..review/rev-b` = 3 files, all under `docs/`).

---

*(This file is written incrementally as stages complete. The findings register,
coverage table, could-not-falsify list and battery-figure table are at the end.)*

## A. Stage log (what was executed, in order, with its transcript)

| # | Transcript | What ran | Result |
| --- | --- | --- | --- |
| t01 | `transcripts/t01-pnpm-check.txt` | `corepack pnpm check` on `review/rev-b` @ f855340 | see §C |
| t02 | `transcripts/t02-validators-green.txt` | the three doc validators | architecture **95/95** · fable **36/36** · research **PASS** — all exit 0 |
| t03 | `transcripts/t03-vitest-zero-match.txt` | the GH-008 vitest zero-match hazard | **reproduced: exit 0 with 31 skipped / 0 executed** |
| t04 | `transcripts/t04-vitest-nofiles-and-errored-signatures.txt` | vitest against a non-existent path | exit 1, `No test files found` — the ERRORED signature has a real string to match |
| t06 | `transcripts/t06-ci-on-main.txt` | GitHub Actions run ledger + the `main` gate-battery job log | **CI on `main` @ 93a71f5 is RED** |
| t07 | `transcripts/t07-bundle-third-party-scan.txt` | REV-B's own third-party-host scan of the built bundle | **0 request-capable third-party hosts**; 4 vendor string hosts, all inert |
| t08 | `transcripts/t08-e2e-inventory.txt` | e2e spec and 320-pixel inventory | 11 specs, 188 `test(` declarations, 10 explicit 320px assertions |
| t09 | `transcripts/t09-route-policy.txt` | route/policy inventory and SBX-001 matrix coverage | 113 routes, all policy-declared; 112 covered by the role×route matrix |

| t10 | `transcripts/t10-error-body-echo.txt` | do 4xx validation messages echo caller-supplied text? | one shape does: `Unrecognized key(s) in object: '<caller string>'` |
| t11 | `transcripts/t11-interface-states.txt` | interface-state (loading/empty/error/denied) inventory | centralized in `SurfaceState`; 4 states, 6–16 e2e references each |
| t12 | `transcripts/t12-real-stack-critical-path.txt` | **the real-stack 14-step critical path, both viewports** | **2 passed (56.6s), exit 0** — every recorded request count identical to the M4 record |
| t13 | `transcripts/t13-outbox-drain-repeat.txt` | the drain failure, re-run standalone and per-directory | passes alone (12/12, 1.0s) and with the whole `test/audit` directory (83/83) |
| t14 | `transcripts/t14-api-suite-raised-timeout.txt` | the full `api` project with `--testTimeout=600000` | see §C |

