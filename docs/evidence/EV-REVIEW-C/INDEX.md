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

---

## 2. REV-A vs REV-B — overlap, contradiction, cross-misses

Full working in **t09**. Summary:

### 2.1 Where they overlap: one defect, found twice

**REV-A-001 and REV-B-003 are the same finding.** Same file, same two arms, same line numbers
(`e2-objective.test.ts:159` and `:754`); same mechanism (GH-005/`dbee625` raised ceilings to
480 s / 540 s on the two **two-solve** arms and left the **single-solve** arms at the 120 s
default — REV-C verified the delta contains exactly `+ }, 480_000);` and `+ }, 540_000);`);
same severity (MAJOR). Measurements agree within 1.0 %:

| arm | REV-A | REV-B | ceiling | over by |
| --- | --- | --- | --- | --- |
| `:159` | 128,836 ms | 130,177 ms | 120,000 ms | 7.4 % / 8.5 % |
| `:754` | 130,714 ms | 129,429 ms | 120,000 ms | 8.9 % / 7.9 % |

REV-C's own composed runs reproduce both arms timing out at exactly `120009 ms` / `120006 ms`.
**They must be merged in the register with both IDs preserved** — doc 38 §5 forbids
combining-away.

Other agreements REV-C checked and found consistent: SBX (9/9 · 371 readings · 53/53 tables ·
0 wrong-tenant · 0 vacuous — identical figures, REV-B adding 9/9 FALSIFIABLE); the M-22
numbering gap (both confirm it is a disclosed gap, not a renumbering); the machine-speed ratio
(~3.9× vs 2.7–3.9×); and the delta's additive character — reached by two different methods,
REV-A by tree-hash identity, REV-B by reading every hunk.

### 2.2 The one real contradiction

| | |
| --- | --- |
| **REV-A-002** | the "migration **populated** cycle 0001–0019" battery row is not what its transcript executed — the CLI destroys the data directory and seeds nothing |
| **REV-B §C row 5** | the same row, "matches" |

These cannot both be right. REV-C adjudicated it by execution and code-read (t03 Part 1) and
**REV-A-002 stands**:

* the CLI that produced the claimed row (`apps/api/test/support/migrate-cycle-cli.ts`) says in
  its own docblock that "the up migration applies to an **empty** database";
* the artifact REV-B credited (`apps/api/test/builds/migration-0019-populated-cycle.test.ts`)
  cycles **one** migration — `while (!down.some((name) => name.includes('0019')))` — and its own
  docblock is titled "**Migration 0019**, up → down → up, over a POPULATED database". It cannot
  corroborate a 0001–0019 row.

REV-B's row-5 verdict is withdrawn by REV-C and refiled as **REV-C-002**. This is the single
factual disagreement between the two reports, and the blind-review design is exactly what
surfaced it: REV-B endorsed the row *because* it had not read REV-A.

### 2.3 A near-contradiction that is not one

REV-A: "CI's gate battery passed at `332603e`, so the runner is fast enough." REV-B: "CI on
`main` @ `93a71f5` concluded **failure**." Both are true — the two commits have **byte-identical
trees** (REV-A proved it: both hash to `be81cfa6c62c…`), so the same tree passed one CI run and
failed the next. That is the intermittency, seen from two sides. REV-A's narrow claim — that the
runner is fast enough, so the e2-objective failure is machine speed and not a code defect —
survives intact; only the implicature that CI is green on this tree does not.

### 2.4 What each lane could have caught and did not

* **REV-B could have caught REV-A-002.** "Database consistency" is verbatim in REV-B's scope;
  REV-B looked at exactly that battery row and endorsed it. This is the sharpest cross-miss in
  the pair — not a coverage gap but a wrong verdict inside covered ground.
* **REV-B could have caught REV-A-004.** "Database consistency" and "API enforcement" are in
  REV-B's scope and the probe is a two-statement `UPDATE` as `app_runtime`. REV-B did not attempt
  it. A fair lane split could equally put it in REV-A's "concurrency and stale writes".
* **REV-A recorded the same fact as REV-B-004 and read it the other way.** REV-A logged "no
  frozen record was retro-edited" as a positive; REV-B logged "doc 36 carries superseded figures
  with **no pointer** to FAD-52" as a defect. Not a contradiction — a difference in what each
  thought the fact meant. REV-B's reading is the one a reader of doc 36 needs.
* **REV-A did not miss REV-B-002.** It did not occur in REV-A's composed run — a non-occurrence,
  now corroborated by REV-C's own run #1. Likewise REV-B-001: the two gates REV-A could have
  witnessed it through (axe, request-budget) both passed in REV-A's run.
* **REV-A could not reasonably have been expected to catch REV-B-001 or REV-B-007** — CI
  accuracy, error handling and privacy are REV-B's enumerated lane.

---

## 3. Shared omissions — what NEITHER report covered

| Omission | Status after REV-C |
| --- | --- |
| **`fixture-regression` has no evidence anywhere current** | **CONFIRMED and WIDENED.** Both reviewers declared it not-executed with measured arithmetic (≥ 6.3 h here). REV-C verified REV-A's stronger claim that **no CI evidence exists either**: `.github/workflows/ci.yml` runs `pnpm check` and `pnpm red-cases` and nothing else. **REV-C adds that `pnpm sbx` is in the same position** — doc 38 §7 requires SBX 9/9 in the final battery and CI never runs it, so its only evidence is whoever last ran it locally. Two of §7's eight battery items have no automated home. Filed **REV-C-004**. |
| **Red-case arms 21 / 22 never re-executed locally** | **DECLARED, with a better substitute.** Each costs ≈ 35 min here (three `gate:axe` runs at ~11.6 min each). REV-C did not run them. It did something more informative: it read CI's own execution of **arm 21** at main's current tip, where the arm's GREEN half **failed** and the arm returned **NOT PROVEN** (t04). A local green would have proved less than this observed red. |
| **Fresh-clone validation (doc 38 §7)** | **EXECUTED — and it PASSES.** t05: `git clone` of `origin/main` into a scratch directory → HEAD `64ddfd1`, clean tree; `corepack pnpm install --frozen-lockfile` exit 0 (2.9 s, warm store — REV-C did **not** measure a cold store and does not claim one); **fable validator 36/36 exit 0 · architecture validator 95/95 exit 0 · research validator PASS exit 0.** The full §7 battery from that clone is a 12–15 h serial run on this machine and was not attempted; the arithmetic is in t05. The clone also produced REV-C-007 (below). |
| **The M3R registered findings (doc 38 §2.7)** | **ENUMERATED — and there is nothing to enumerate.** See §3.1. |

### 3.1 The M3R registered findings — the enumeration, and its result

doc 38 §2.7 places "the M3R registered findings" inside the requirements surface this review is
testing. REV-A declared it "not executable in REV-A's lane (control-document state)"; REV-B is
silent on it. REV-C attempted the enumeration the packet asks for (t01, every command with its
exit code):

* `git grep -ln "M3R"` over every tracked `.md`/`.json`/`.ts`/`.py`/`.yml`/`.sql`/`.sh` returns
  **ten files**, all of which mention M3R only as a *status* ("M3R is PAUSED", "M3R findings
  unchanged pending the review", "M3R remains PAUSED").
* `git grep -nE "M3R-[0-9]+|M3-R-[0-9]+"` — **no match**. There is no M3R finding identifier
  anywhere in the repository.
* The seven candidate control registers — RISK-REGISTER, TEST-TRACEABILITY, OPEN-QUESTIONS,
  ARCHITECTURE-DECISIONS, PRODUCT-DECISIONS, EVIDENCE-INDEX, FEATURE-PARITY-MATRIX — contain the
  string "M3R" **zero times each**.
* The two registers that *do* enumerate findings
  (`docs/architecture/remediation/codex-review-remediation.md`, 27 `CAR-*` findings, and
  `internal-verification-corrections.md`) contain **no** mention of M3R; those are the Codex
  **architecture** review, a different body of work.
* The term is never expanded anywhere. `docs/fable/34-m4-entry-and-prerequisite-register.md` §1
  asserts "its outstanding findings remain in **the project register**" without naming one.

**Result:** the M3R findings cannot be listed as addressed, unaddressed, or unverifiable, because
no enumerable register of them exists in this repository. Filed **REV-C-004** together with the
fixture-regression / SBX gap, since both are the same shape: a doc 38 §7/§2 requirement whose
evidence has no home. This is not a defect in either reviewer's work — it is a defect in the
review surface as written, and it means doc 38 §9 criterion 2 ("complete per their completion
criteria") cannot be fully satisfied against §2.7 by anybody, including REV-C.

### 3.2 Omissions REV-C found on its own

* **CI on `main` is red at the current tip**, and neither reviewer saw that run (REV-C-001, t04).
* **A tracked, empty, undocumented file named `=` sits at the repository root** since `dfa717f`
  (2026-08-05) and has survived every gate, every validator, the M4 exit hygiene sweep and both
  reviewers (REV-C-007, t05). It is the first thing a virgin clone lists — which is itself the
  evidence that doc 38 §7's fresh-clone item had never been performed.
* **The recorder-window class is 18 interactions wide**, not one: 18 of the 44 budgeted
  interactions carry `maxRequests: 0` and every one is recorded through the same
  `recordRequests` helper with the same DOM-visibility trigger (REV-C-001, t10).
* **`ALLOWED_IMPL_ROOTS` in `docs/architecture/validate.py` names `docs/evidence` and assertion
  52a never consults it** — a dead allowlist that is precisely the trap REV-B-005 fell into, and
  the reason nothing catches a stray file at the repository root (REV-C-008, t06).
* **Two retained artifacts inside EV-M4-005 disagree** about the apply-candidate request count
  (JSON ledger 1, acceptance transcript 43 says 2), and the count doubled inside M4-005 with no
  recorded reason and no budget covering it (REV-C-009, t10).

---

## 4. Doc-reliance detection

Full working in **t08**.

**REV-A.** Its two flagged declarations are **accurate and not understated**. The battery table
has six rows: three EXECUTED, one PARTIALLY EXECUTED (red-cases, 5 of 65 local + 60 on CI
evidence, disclosed in the same sentence and again in §14), two NOT EXECUTED with measured
reasons. REV-C confirmed the strongest of those reasons by execution: `ci.yml` really does run
only `pnpm check` and `pnpm red-cases`, so `fixture-regression` really has no CI evidence.
REV-A's §13 limitation verdicts rest on **reading source files**, which for a claim about what a
source file says is the right instrument, and each carries a checkable file-and-line citation;
REV-C spot-checked three and all three are verbatim present.

**One completion defect, though (REV-C-003):** REV-A's report says its "full per-scope-area
coverage table" is "in INDEX.md §§13–16". There is no per-scope-area table anywhere in
EV-REVIEW-A. §13 is the M4-limitations table, §14 the battery table, §15 the five red-case arms,
§16 probe hygiene. doc 38 §3's REV-A completion criterion requires *every scope area* covered or
declared, and the fifteen enumerated scope areas are never enumerated. REV-B, by contrast,
reproduces its scope enumeration verbatim as its §D. Most of REV-A's areas *are* covered
somewhere in the bundle; "authorization and entitlements" and "M1–M4 cross-module composition"
have no dedicated declared coverage beyond gate lines in §1.

**REV-B.** Its §F declarations are accurate. REV-C verified two as statements of fact: no
`-t`/`--testNamePattern` filter exists in `package.json`, `scripts/`, or `ci.yml` (no match), and
`git ls-files` over `apps/api/test` returns exactly **139** `.test.ts` files, which is REV-B's
arithmetic. Its one undeclared doc-reliance is §C row 5 (REV-C-002).

---

## 5. Probe quality and non-vacuity

Full working in **t06**. Three probes sampled from each reviewer; one mutation from each re-run.

**Spot-check of REV-A's "all four mutation probes bit" — CONFIRMED.** REV-C re-ran M3
(`MinimumRestBetween`: `rest >= minMs` → `rest >= minMs - 3_600_000`) against the **shipped**
domain test, not REV-A's own probe: `1 failed | 39 passed (40)`, detector exit 1, restore
byte-identical (`94483d69…` → `94483d69…`), `git status` clean. That is REV-A's exact figure.

**Spot-check of REV-B's "10/10 load-bearing" — CONFIRMED.** REV-C re-ran M-07 (the CAP-068/T-23
client-host scanner): `1 failed | 25 passed (26)`, exit 1, restore byte-identical
(`a4ee2025…` → `a4ee2025…`). REV-B's three differing counts (§A "10/10", §C-2 "9 of 9", §D "10
sampled … 9 run") looked self-inconsistent and are not: the driver ran twice — M-01..M-09 in one
batch and M-10 alone (it needs the `api` project and a database). 9 + 1 = 10. **No finding.**

| Probe | Verdict |
| --- | --- |
| REV-A `repro-truth-table.mjs` *(re-run)* | **Proves what it claims.** Direct calls into the shipped export; the promise column is a regex over the returned detail, not a re-derivation; both thresholds are printed so a different build would announce itself. Reproduced row for row. |
| REV-A `mutate.sh` *(code-read + M3 re-run)* | **Proves what it claims — the stronger of the two mutation drivers.** Aborts unless the find-string occurs **exactly once**, prints the applied diff, compares sha256, runs `git status` on the file. |
| REV-A `dst-sweep.mjs` *(code-read)* | **Proves what it claims and is non-vacuous by construction.** Prints `gap starts observed: 108` / `fold starts observed: 93` — a sweep that enumerated the right dates but never landed on a transition would report 0 and be visibly hollow. Exits non-zero on any violation. |
| REV-B `mutation-sample.mjs` *(code-read + M-07 re-run)* | **Proves what it claims**, with one recorded weakness: "load-bearing" is decided from the runner's **exit code alone**, so a compile break or an unrelated failure would also score load-bearing. Low risk here — every mutation is a one-line value swap and every run reported exactly `1 failed` — but the driver would be stronger asserting the failing test's *name*. |
| REV-B `red-case-arms.sh.txt` *(code-read)* | **Proves what it claims**, and makes the right design choice: it drives the **shipped** shard filter (`SP_RED_SHARD=k/65`) rather than a bespoke harness, reads `PIPESTATUS` rather than the tail's exit, and runs `git status --porcelain` after every arm. |
| REV-B `privacy-log-leak.probe.test.ts.txt` *(code-read)* | **Proves what it claims — and REV-B graded its own result correctly.** It carries both guards this shape needs: a non-vacuity assertion (`expect(harness.logs.length).toBeGreaterThan(0)`) and a planted-needle control arm. REV-B then declined to call the result a pass because only one log line was captured, and filed it a NOTE with that caveat. REV-C endorses both the probe and the restraint. |

**One design weakness common to REV-A's two finding-bearing DB probes, recorded for the
adjudicator:** neither `p3-selection-window` nor `p2/H` asserts its **outcome**. `p3` ends with
non-vacuity assertions only; `p2/H` ends with `expect(typeof accepted).toBe('boolean')`, which
cannot fail. This is a defensible review-probe stance — both files say so explicitly ("REV-A
reports; it does not decide") and it stops the probe failing merely for finding the other
outcome — but it means REV-A-003 and REV-A-004 rest on **reading a printed line**, not on a test
result. REV-C therefore re-ran both and read the same lines independently (t13).
