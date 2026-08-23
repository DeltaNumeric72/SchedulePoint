# EV-REVIEW-C — REV-C: cross-check and consolidation (post-M4 internal review, doc 38 §3)

**Reviewer:** REV-C — a fresh high-effort Opus agent, cross-check-and-consolidation scope.
**Packet:** [docs/fable/38-post-m4-internal-review-plan.md](../../fable/38-post-m4-internal-review-plan.md)
§§1–5, packet REV-C. **Not blind:** REV-C's charter is to read both prior reports in full,
and it did.

**Branch:** `review/rev-c` (never merged), based on `64ddfd1` = `origin/main`.
**Evidence:** this directory only. **This reviewer implements nothing, adjudicates nothing,
and does not decide the gate.** It recommends.

**Inputs read in full before any execution:**

| Input | Ref |
| --- | --- |
| REV-A report + evidence | branch `review/rev-a` @ `6cac92f` — `REPORT.md`, `INDEX.md` (16 §§), 13 transcripts, 7 probe sources |
| REV-B report + evidence | branch `review/rev-b` @ `e3220a5` — `INDEX.md` (§§A–H), 21 transcripts, 3 probes |

**Machine:** 4 vCPU / 15 GiB, Linux 6.18.44, Node v22.22.2, pnpm 11.18.0.
`SP_SOLVER_WORKER_COMMAND=/home/user/SchedulePoint/solver/.venv/bin/python`. This is the same
machine class both prior reviewers measured (2.7–3.9× the M4 reference); REV-C's own composed
run independently reproduced the FAD-52 cross-machine figure `83.130356` deterministic units,
which pins this machine to the same class as FAD-52's.

**Probe-source convention:** REV-B-005 established that `.ts`/`.sh` under `docs/` turns the
architecture and fable validators red. REV-C's probe sources therefore carry `.txt` suffixes,
and REV-C re-verified the validators green from a fresh clone with this bundle absent
(t05) and green on this branch with it present (t14).

---

## Contents

| § | Transcript | What |
| --- | --- | --- |
| t01 | `transcripts/t01-m3r-findings-enumeration.txt` | The M3R registered findings (doc 38 §2.7) — enumeration attempt |
| t02 | `transcripts/t02-capability-figure-recheck.txt` | REV-A's capability figure, re-derived with REV-C's own parser |
| t03 | `transcripts/t03-revb-figure-match.txt` | REV-B's migration-cycle row + inventory sweeps |
| t04 | `transcripts/t04-ci-on-main-third-occurrence.txt` | CI on `main`, read directly — a third failing push run |
| t05 | `transcripts/t05-fresh-clone-validation.txt` | Fresh-clone validation against `origin/main` (doc 38 §7) |
| t06 | `transcripts/t06-mutation-spot-checks.txt` | One mutation probe re-run from each reviewer + probe-quality verdicts |
| t07 | `transcripts/t07-repro-truth-table-recheck.txt` | REV-A-005/006/007 by re-running REV-A's committed probe |
| t08 | `transcripts/t08-doc-reliance.txt` | Doc-reliance detection across both bundles |
| t09 | `transcripts/t09-a-vs-b-comparison.txt` | A vs B: overlap, the one contradiction, cross-misses |
| t10 | `transcripts/t10-revb001-product-innocence.txt` | REV-B-001's product-innocence half + class width |
| t11 | `transcripts/t11-nr15-composed-run-1.txt` | REV-B-002 recheck, composed run #1 |
| t12 | `transcripts/t12-nr15-composed-run-2.txt` | REV-B-002 recheck, composed run #2 |
| t13 | `transcripts/t13-reva-003-004-rerun.txt` | REV-A-003 and REV-A-004, re-run from REV-A's committed probe sources |
| t14 | `transcripts/t14-recorder-window-instrumented.txt` | REV-C's own probe: the recorder-window ordering hazard, measured |
| — | `probe-sources/` | Every REV-C probe source, `.txt`-suffixed |

*(This file is written incrementally; sections land as their evidence does.)*

---

## 1. Independent rechecks — confirmed / not confirmed, claim by claim

The packet names five rechecks by ID plus one figure-match from each report. All are executed.

| # | Claim rechecked | REV-C's method | Verdict |
| --- | --- | --- | --- |
| 1 | **REV-A-003** — doc 36 §10.4's "un-falsified selection window" is reachable, and deterministically constructible via the audit advisory lock | Re-ran REV-A's committed `p3-selection-window.test.ts` unmodified, from `probe-sources`; plus an independent code-read of `selection.ts` and migration `0003` | **CONFIRMED** — see §1.1 and t13 |
| 2 | **REV-A-004** — a same-state `UPDATE` rewrites `termination_reason`/`solver_status` on `build_runs`, flipping the reproducibility verdict, while `build_run_results` holds the same facts append-only | Re-ran REV-A's committed `p2-audit-and-termination.test.ts` arm REV-A/H; plus an independent read of migration `0018`'s guard and column-level grants | **CONFIRMED** — see §1.2 and t13 |
| 3 | **REV-B-002** — NR-15 recurs in a composed run, mechanism = a signer-less `drainQueue` at the `outbox-dispatch` call site | Two full composed `vitest run`s (t11, t12) + code-read of `support/queue.ts` and the call site | **MECHANISM CONFIRMED; RECURRENCE NOT REPRODUCED in REV-C's runs** — see §1.3 |
| 4 | **REV-B-001's product-innocence half** — against the real stack the same interaction records 0 requests | Read the retained real-stack ledgers and transcripts directly; code-read of `PeriodsPage.tsx` and `request-budget.ts` | **CONFIRMED, on stronger evidence than REV-B cited** — see §1.4 and t10 |
| 5 | **Figure-match from REV-A** (REV-C's choice): the 58-capability traceability figure, 18/3/37, nothing dropped | Re-derived with REV-C's own Python parser against report 19's headings, doc 06's rows and doc 18 | **CONFIRMED** — 58 = 58 = 58, no ID dropped, no ID invented, 18 verified / 3 in-progress (018, 020, 057) / 37 not-started (t02) |
| 6 | **Figure-match from REV-B** (REV-C's choice): §C row 5, "migration populated cycle 0001–0019 … matches" | Read the loop of the test REV-B credited; read the docblock of the CLI that produced the claimed row | **NOT CONFIRMED** — filed as REV-C-002 (t03) |
| 7 | *(added)* REV-A-005 / REV-A-006 / REV-A-007 | Re-ran REV-A's committed `repro-truth-table.mjs` unmodified; re-ran the rule-kind gate | **ALL THREE CONFIRMED, row for row** (t07) |
| 8 | *(added)* REV-B's zero-test / `.only` / `.todo` / e2e inventory figures | Re-derived independently | **CONFIRMED exactly** — 0 `.only`, 0 `.todo`, 0 zero-declaration test files across 184 files; 11 specs, 188 `test(`, 10 explicit 320px assertions across 6 specs (t03) |
| 9 | *(added)* REV-A-009 / REV-A-010 (the CAP-061 rename; the four rows missing a trailing pipe) | Re-derived | **BOTH CONFIRMED** — exactly rows 015, 017, 018, 059 (t02) |
| 10 | *(added)* REV-B-005 (probe sources under `docs/` redden the validators) | Read both validators' source | **CONFIRMED, and its root cause is deeper than REV-B stated** — REV-C-008 (t06) |

### 1.1 REV-A-003 — CONFIRMED

REV-C first established the mechanism independently of the probe, by reading the code:

* `apps/api/src/builds/selection.ts` calls `buildStaleness(uow, run)` and refuses on `stale`,
  then — 45 lines later, after the snapshot and candidate reads — calls `createDraftVersion`.
* `apps/api/migrations/0003_audit_outbox.sql:768` takes
  `pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(NEW.organization_id::text))`
  inside the audit-chain trigger, and the comment above it says the lock is taken "because the
  specification names it and it is free".

So a hook that any same-organization transaction can hold sits **after** the staleness read and
**before** the draft write. That is REV-A's construction, and it is a property of the shipped
code, not of the probe.

REV-C then re-ran REV-A's own probe unmodified. Result in t13.

### 1.2 REV-A-004 — CONFIRMED

Established independently from the migration source before re-running the probe:

* `app_guard_build_run_transition` (migration `0018`, line 762) returns early —
  `IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;` — and every
  state-conditioned guard, including `BUILD_TERMINATION_REASON_REQUIRED`, sits **below** that line.
* The columns frozen **above** the early return are identity, request binding, snapshot,
  applied-version and epoch. `termination_reason` and `solver_status` are **not** among them.
* The column-level grant at migration `0018` line 1048 puts `termination_reason` and
  `solver_status` squarely inside `GRANT UPDATE (…) ON build_runs TO app_runtime, app_worker`.

So the write is reachable by an application role, inside a unit of work, with no guard in its
path. Re-run result in t13.

### 1.3 REV-B-002 — mechanism CONFIRMED, recurrence NOT REPRODUCED

The mechanism is a **structural** property of the failing call site, and REV-C confirmed every
link of it by reading (t11):

* `drainableJobCount` (`apps/api/test/support/queue.ts:72`) counts `outbox.%` **and** `audit.%`;
* `drainQueue` registers the `audit.*` handlers **only when a `signer` is supplied**
  (`queue.ts:126`/`:131`), and its own R-10 docblock states the consequence: "a signer-less
  drainer has no handler for an `audit.checkpoint` job and therefore cannot empty a queue holding
  one";
* the failing call site — `apps/api/test/audit/outbox-dispatch.test.ts`'s `afterAll` at line 123
  — passes no signer. The identifier `signer` does not occur anywhere in that file.

Given one `audit.*` job in the backlog, the 45-second loop is unsatisfiable at any machine speed.
Only the *precondition* is racy. REV-C therefore grades REV-B's MAJOR as correct: a finding whose
mechanism is deterministic should not be discounted because its trigger is order-dependent.

**Rate, across the widened series** — same tree, same machine class, three independent reviewers:

| Composed run | Failed files | NR-15 |
| --- | --- | --- |
| REV-A, whole workspace | 1 (e2-objective) | absent |
| REV-B, whole workspace | 2 (e2-objective + drain) | **PRESENT** |
| REV-B, `api` project with the ceiling raised | 0 | absent |
| REV-C #1, whole workspace | 1 (e2-objective) | absent |
| REV-C #2, whole workspace | *(t12)* | *(t12)* |

REV-B's own framing ("one occurrence in two full composed runs", "intermittent even between two
composed runs") is **conservative rather than overstated**: on the wider series the rate is lower
than 1-in-2. The rate does not touch the finding's substance, which is that the failure recurred
**at all** after RISK-REGISTER recorded NR-15 "RETIRED-AS-DIAGNOSED-AND-REPAIRED … verified clean
across the COMPLETE seed set".

### 1.4 REV-B-001's product-innocence half — CONFIRMED

The retained real-stack ledgers record `critical-path-open-new-period` = **0 requests at both
viewports**, against a real API and a real migrated database — and the immediately following
step, `critical-path-save-period`, records **2**. The zero is a measurement, not an absence of
measurement. REV-B cited this; REV-C read the artifact and its non-vacuous neighbour directly.

REV-C additionally **proved the mechanism by code-read**, which REV-B explicitly declined to do
("REV-B did not prove it by construction"): in `apps/web/src/schedule/PeriodsPage.tsx` the
`periods` query is declared at line 70 with key `['schedule-periods', …]`; `NewPeriodForm` — which
carries `data-testid="periods-new"` at line 228 — is rendered at line 85, **above** the
`SurfaceState` at line 91 that wraps that query's states. The button paints independently of the
query. `apps/web/e2e/schedule.spec.ts:434` opens the recording window on that button's visibility.
The page's own initial `GET …/schedule/periods` can therefore be issued after the window is
already open. Measured directly in t14.
