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
(t05, 36/36 + 95/95 + PASS) and green on this branch with it present (t17, the same three).

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
| t14 | `transcripts/t14-recorder-window-instrumented.txt` | REV-C's own probe: the recorder-window ordering hazard, measured over 22 runs |
| t15 | `transcripts/t15-reva-id-collisions.txt` | REV-A's finding IDs are not stable between its two documents |
| t16 | `transcripts/t16-revb-006-007-recheck.txt` | REV-B-006 and REV-B-007, rechecked |
| t17 | `transcripts/t17-validators-with-this-bundle.txt` | The three validators, green with this bundle present |
| — | `probe-sources/revc-window-probe.py.txt` | REV-C's only authored probe source. The re-run probes are REV-A's own, taken byte-identically from `review/rev-a` and not re-committed here. |

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
| REV-C #2, whole workspace | *(INVALID — REV-C's own probe contamination; see t12 and §8.5)* | — |
| REV-C #2R, whole workspace, verified-clean tree | 1 (e2-objective) | absent |

**1 occurrence in 5 valid composed runs** (1 in 4 whole-workspace runs). REV-B's own framing
("one occurrence in two full composed runs", "intermittent even between two composed runs") is
therefore **conservative rather than overstated**: on the wider series the rate is ~1-in-5, and
REV-B's figure should be read as its own sample rather than as the class's. The rate does not touch the finding's substance, which is that the failure recurred
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
already open.

**REV-C then proved it by construction — the step REV-B stated it had deliberately not taken**
("REV-B did not prove it by construction"). An instrumentation-only probe (t14; source in
`probe-sources/`, applied and restored byte-identically) timestamps every request the page issues
and the instant the recording window opens. Over **22 runs at the mobile project**:

* every load issues **two** `GET …/schedule/periods` — the first at +9…+21 ms, the second at
  +159…+195 ms;
* the **second** one lands within **4–16 ms of the window opening on every single pass**
  (median 8 ms);
* on run 5 it landed **6 ms after** the window opened, was captured, and the test failed — and
  the captured URL printed by the probe is the periods **list** endpoint, not anything the click
  issued.

So the straggler is the page's own query, proven from the failing side as well as the passing
side, and the invariant proof currently rests on a **single-digit-millisecond** margin. That is
why REV-C grades REV-C-001 BLOCKING rather than treating it as flakiness: a margin this thin is
flipped by a slower runner, a different Chromium build, or one more mocked route, and re-running
until green is therefore not a repair.

*(Observation, not a finding: the second request's shape — a refetch of the same key ~150 ms
after the first, once another query has settled — resembles the enabled-oscillation class GH-006
diagnosed on the publication comparison page and GH-009 left open. REV-C did not establish its
cause and does not claim it.)*

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

---

## 6. REV-C's own additional probes

The packet asks for "at least two" additional bounded probes where either report is thin. REV-C
ran six.

| # | Probe | Why it was needed | Result |
| --- | --- | --- | --- |
| P1 | **The GitHub Actions ledger for `main`, read directly** (t04) | REV-A accepted 60 red-case arms on CI evidence; REV-B read one CI run. Neither established what CI does *now*. | Run **32616586257** on main @ `64ddfd1` concluded **failure**: `red-case proofs (shard 8)` failed with `i13-schedule-authoring` **NOT PROVEN** (its GREEN half failed on a clean tree), taking `red-case shard completeness` — the union guard — with it. The gate battery passed in that run. Three consecutive push runs on `main` have now concluded failure. **REV-C-001.** |
| P2 | **Fresh-clone validation against `origin/main`** (t05) | doc 38 §7 requires it; neither reviewer ran it (REV-B declared it explicitly as a §7 item outside its packet). | Clone → `64ddfd1`, clean tree; install exit 0; **36/36 · 95/95 · PASS**, all exit 0. Also surfaced the tracked `=` file (**REV-C-007**) and the measured cost of the full battery from a clone (12–15 h serial here). |
| P3 | **The M3R findings-register enumeration** (t01) | doc 38 §2.7 puts it in the requirements surface; REV-A declared it out of lane, REV-B was silent. | No enumerable register exists; no `M3R-nnn` identifier exists; the term is never expanded; the seven candidate control registers contain the string zero times. **REV-C-004.** |
| P4 | **Re-running each reviewer's committed probes** (t06, t07, t13) | Both reports' key findings rest on probes only their author had executed. | REV-A's `repro-truth-table.mjs` reproduces row for row; REV-A's M3 mutation and REV-B's M-07 mutation both bite and both restore byte-identically; REV-A's `p2`/`p3` re-run in t13. |
| P5 | **The zero-budget class width** (t10) | REV-B-001 reads as a one-interaction flake. | 18 of 44 budgeted interactions carry `maxRequests: 0`, and every one is recorded through the same `recordRequests` helper with the same DOM-visibility trigger. The hazard is class-wide, not instance-local. Folded into **REV-C-001**. |
| P6 | **The recorder-window ordering, instrumented** (t14) | REV-B stated the mechanism and said explicitly it "did not prove it by construction". | **Proven by construction.** 22 runs; the page's second periods `GET` lands **4–16 ms before** the window opens on every pass and **6 ms after** on the one failure, where the probe printed the captured URL — the periods list endpoint, not the click. Margin median **8 ms**. Instrumentation only: no assertion, budget, or product code touched; file restored byte-identically, `git status` clean. |

**Declared, not executed, with the reason** — REV-C makes no statement about the current state of
any of these:

| Not executed | Reason |
| --- | --- |
| red-case arms 21 (`i13-schedule-authoring`) and 22 (`publish-idempotency-key-retained`) locally | ≈ 35 min each here (three `gate:axe` runs at ~11.6 min). REV-C substituted CI's own execution of arm 21 at main's tip, which returned **NOT PROVEN** — a more informative observation than a local green would have been. |
| the complete serial 65-arm red-case battery | 5.7–8.2 h at this machine's measured ratio (REV-B's arithmetic, which REV-C did not re-derive). |
| `pnpm fixture-regression` | ≥ 6.3 h here before the 139-run standalone sweep. Third consecutive reviewer to decline it; see REV-C-004. |
| the full doc 38 §7 battery from the fresh clone | 12–15 h serial. The validator third was executed and passes. |
| a cold-store `pnpm install` | The container's pnpm store was already warm (`reused 465, downloaded 0`). REV-C reports 2.9 s as a **warm-store** figure and claims nothing about a cold one. |
| assistive-technology sessions (SPEC-14 M-cells) | Already honestly unclaimed in doc 36 §3. REV-C confirms they remain unclaimed and does not claim them. |

---

## 7. The consolidated findings register

**Merged from REV-A (10), REV-B (8) and REV-C (11) — 29 original IDs, 28 register entries after
one merge.** Ordered by severity. **Every original ID and every original severity is preserved
verbatim**, per doc 38 §5: nothing is downgraded, omitted, or combined away. Where A and B found
the same thing it is said explicitly. REV-C's column records what REV-C independently established,
not an adjudication — adjudication is Fable's.

### BLOCKING

| ID | Finding | REV-C |
| --- | --- | --- |
| **REV-B-001** | GitHub CI is red on `main` at the review baseline (`93a71f5`, run 32612471848): the `axe` and `request-budget` gates fail on the I-13 "New period" mobile interaction, which records 1 request where the invariant demands 0. Mechanism: the shared `recordRequests` window can open before the page's own initial query is on the wire. **Not a product amplification** — the real stack records 0. | **CONFIRMED on both halves, and extended.** Product innocence verified against the retained real-stack ledger with its non-vacuous neighbour (§1.4). Mechanism verified by code-read of `PeriodsPage.tsx` — the button renders above the `SurfaceState`, independent of the `['schedule-periods']` query. REV-B's disposition ("repair the recorder window, never raise the budget or relax the assertion") is correct and follows from CLAUDE.md rule 10. |
| **REV-C-001** | **The same defect is red on `main`'s CURRENT tip, in a different battery, and neither reviewer saw it.** Run **32616586257** on `64ddfd1` concluded failure: `red-case proofs (shard 8)` failed because the `i13-schedule-authoring` arm's **GREEN half failed on a clean tree**, returning **NOT PROVEN**, which took the `red-case shard completeness` union guard with it. The gate battery passed that run — the two batteries traded places on one defect. Three consecutive push runs on `main` have concluded failure. The class is **18 interactions wide** (18 of 44 budgeted interactions carry `maxRequests: 0`, all through the same recorder). | Shares REV-B-001's root cause; **one repair addresses both**, which is why it is graded here rather than under-graded elsewhere. Its distinct consequence is that doc 38 §7's "65/65 arms, both directions, union guard green" and §9 criterion 8 both fail **today**, and that the arm whose purpose is to prove the I-13 detector works cannot currently certify it. **REV-C additionally measured the margin** (t14): over 22 instrumented runs the page's second periods `GET` and the recording window are separated by **4–16 ms** (median 8 ms) on every pass and by **−6 ms** on the one failure, where the probe printed the captured URL — the periods list endpoint, not the click. The invariant proof is decided by scheduler noise inside a 10 ms band, which is why this is graded BLOCKING and not flakiness. Evidence: t04, t14. |

### MAJOR

| ID | Finding | REV-C |
| --- | --- | --- |
| **REV-A-001 = REV-B-003** *(one defect, found independently by both)* | `corepack pnpm check` does not reproduce green on a correct-but-slower machine: two **single-solve** arms in `e2-objective.test.ts` (`:159`, `:754`) exceed the 120 s global ceiling by 7.4–8.9 %. GH-005 raised ceilings to 480 s / 540 s on the two **two-solve** arms in the same file and left these at the default — the repair was not generalised to its own class. | **CONFIRMED, and the two reports agree within 1.0 %** (t09). REV-C's own composed runs time out at `120009 ms` / `120005 ms` on the same two arms. REV-C verified the delta contains exactly `+ }, 480_000);` and `+ }, 540_000);`. **Merged, both IDs retained.** |
| **REV-A-002** | The "migration **populated** cycle 0001–0019" battery row (doc 36 §6 row 5, EV-M4-005 §24 row 5, propagated verbatim into doc 38 §7) is not what its transcript executed: the CLI destroys the data directory and seeds nothing. Genuine populated cycles exist for 5 of 19 migrations. | **CONFIRMED** (t03). The CLI's own docblock says "the up migration applies to an **empty** database". **This is the one point where the two reports contradict each other, and REV-A is right** — see REV-C-002. |
| **REV-A-003** | doc 36 §10.4's "un-falsified selection window" **is** reachable, deterministically: migration 0003's per-organization audit advisory lock is a hook sitting after `buildStaleness` and before the draft write. | **CONFIRMED twice over** (t13, §1.1). REV-C established the hook from source before running anything, then re-ran REV-A's committed probe byte-identically and reproduced every line, first attempt. Falsifies the word "un-falsified"; REV-A's own honest sizing (a draft, never a published version; staleness visible afterwards) stands. |
| **REV-A-004** | The reproducibility verdict reads a **mutable** copy of the termination facts. A same-state `UPDATE` as `app_runtime` rewrites `termination_reason`/`solver_status` on `build_runs` — the guard returns early on an unchanged state, above every state-conditioned check — while `build_run_results` holds the same facts append-only, one join away. | **CONFIRMED twice over** (t13, §1.2). Independently established from migration `0018`: the early return at the `NEW.state IS NOT DISTINCT FROM OLD.state` line sits above `BUILD_TERMINATION_REASON_REQUIRED`, and both columns are inside `GRANT UPDATE (…) ON build_runs TO app_runtime, app_worker`. Then reproduced line for line by re-running REV-A's probe. REV-A's "MAJOR not BLOCKING" reasoning (no shipped route writes those columns outside `transitionRun`/`persistOutcome`) is sound. |
| **REV-B-002** | NR-15 recurred in a composed run — `outbox-dispatch-finalize: the queue still holds 336 drainable job(s) after 45000 ms` — against RISK-REGISTER's "RETIRED-AS-DIAGNOSED-AND-REPAIRED … verified clean across the COMPLETE seed set". Mechanism: `drainableJobCount` counts `audit.%` jobs, `drainQueue` registers `audit.*` handlers only with a signer, and the failing call site passes none. | **MECHANISM CONFIRMED by code-read; the recurrence did NOT reproduce in either of REV-C's composed runs.** The mechanism is *structural* — given one `audit.*` job in the backlog the loop is unsatisfiable at any speed; only the precondition is racy. On the widened five-run series the rate is ~1-in-5, so REV-B's stated 1-in-2 should be read as its own sample. **A non-reproduction is not evidence against a captured failure** — the repository applies exactly that rule to itself (NR-15 was "explicitly NOT ruled a flake" after 55+ clean runs). **REV-B's MAJOR stands.** (t11, t12) |
| **REV-C-002** | REV-B §C row 5 endorses the migration-cycle battery row as re-executed and "matching", on the strength of `migration-0019-populated-cycle.test.ts` — a test that cycles **one** migration (`while (!down.some((name) => name.includes('0019')))`) and whose own docblock is titled "**Migration 0019**, up → down → up". REV-B did not run the 0001–0019 cycle at all, and the endorsement carries no declaration. | This is the **only undeclared doc-reliance in either bundle** and the **only factual contradiction between the two reports**. REV-C adjudicates it for REV-A: **REV-A-002 stands; REV-B's row-5 verdict is withdrawn**. The blind-review design is what surfaced it — REV-B endorsed the row *because* it had not read REV-A. (t03) |

### MINOR

| ID | Finding | REV-C |
| --- | --- | --- |
| **REV-A-005** | GH-008 M-1 reproduced: FEASIBLE + `completed` + 50.000001 of 100 units → `reproducible`, **with the promise sentence**. Plus a new sentence-accuracy defect: at wall 8.999999 s of a 10 s limit the text reads "well inside the 10s wall-clock limit" — at 90.0 % of it. | **CONFIRMED, row for row**, by re-running REV-A's committed probe unmodified (t07). Both the mid-band verdict and the "well inside" sentence reproduce verbatim. |
| **REV-A-006** | GH-008 M-2 reproduced and it is wider than "null": an **unrecognised** `solver_status` parses fail-closed to `null` and that then feeds a fail-**open** branch. The derivation applies "an absent fact is never evidence for the claim" to three of four nullable facts, not the fourth. | **CONFIRMED** (t07). `solver_status` NULL **and** `'UNKNOWN'` both render `reproducible` with the promise. |
| **REV-A-007** | `hard-rule-check.ts:300` says "the other **twenty-four** kinds" are not-evaluable; the gate prints **8**. A reader of the checker's own header concludes three times as many kinds are unenforced as actually are. | **CONFIRMED** (t07): the docblock line is present verbatim and `gate:rule-kind-registry` prints "30 unique kind(s), 22 evaluated / 8 not-evaluable". |
| **REV-B-004** | doc 36 carries superseded figures with **no pointer to FAD-52** (`grep -c "FAD-52" docs/fable/36-m4-exit-report.md` → 0): a machine-specific `76.702882` presented as portable, and "red-cases 64/64" against a live 65-arm battery. `docs/dev-setup.md` was corrected 64→65; doc 36 was not. | **CONFIRMED, and it is the one place A and B read the same fact oppositely** — REV-A logged "no frozen record was retro-edited" as a positive. Both readings are true; REV-B's is the one a reader of doc 36 needs. REV-C's own composed run independently produced the FAD-52 cross-machine figure `83.130356`, which is the fact doc 36 does not point at. |
| **REV-B-005** | The two doc validators forbid application-code extensions anywhere under `docs/`, so a reviewer writing a probe source into its own evidence directory — which is where doc 38 §3 says probe sources go — turns doc 38 §7's own battery red. Resolution adopted: `.txt` suffixes. | **CONFIRMED, and its root cause is deeper than reported** — see REV-C-008. REV-C adopted REV-B's convention and re-verified 36/36 + 95/95 from a fresh clone and on this branch. |
| **REV-B-006** | The vitest zero-match-exits-0 hazard is real and unguarded: a wrong `-t` filter exits 0 with 31 tests skipped and no diagnostic. Latent, not live: no `-t` filter is used anywhere, and a wrong **path** exits non-zero with a signature the red-case runner scores ERRORED. | **CONFIRMED, both halves, by execution** (t16). Exit 0 / 31 skipped on a bogus name filter; exit 1 on a bogus path. REV-B's "latent, not live" grade is right. |
| **REV-C-003** | REV-A's report cites a "full per-scope-area coverage table … in INDEX.md §§13–16". No such table exists anywhere in EV-REVIEW-A; §§13–16 are the M4-limitations table, the battery table, the five red-case arms and probe hygiene. doc 38 §3's REV-A completion criterion requires every scope area covered or declared, and the fifteen enumerated areas are never enumerated. | REV-A's *substantive* coverage is broad and most areas are covered somewhere; "authorization and entitlements" and "M1–M4 cross-module composition" have no dedicated declared coverage beyond gate lines. REV-B, by contrast, reproduces its scope enumeration verbatim as §D. Affects doc 38 §9 criterion 2. (t08) |
| **REV-C-004** | **Three items in doc 38's own requirements surface have no evidentiary home.** (a) `fixture-regression` — declared not-executed by all three reviewers and **never run in CI** (`ci.yml` runs `pnpm check` and `pnpm red-cases`, nothing else); its sole evidence is the frozen EV-M4-005 transcript 40. (b) `pnpm sbx` — required 9/9 by doc 38 §7 and likewise **never run in CI**. (c) **The M3R registered findings (doc 38 §2.7) do not exist as an enumerable register**: no `M3R-nnn` identifier anywhere, the term never expanded, zero occurrences across all seven candidate control registers. | (a) and (b) mean two of §7's eight battery items depend entirely on whoever last ran them by hand. (c) means §2.7 is **untestable as written, by anybody** — REV-A declared it out of lane, REV-B was silent, and REV-C's enumeration found nothing to enumerate. Affects doc 38 §9 criteria 2 and 7. (t01, t08) |
| **REV-C-005** | Packet **GH-011** is named in the PR #5 merge-commit message ("second occurrence of the recorder-window class, registered as packet GH-011") and appears in **no control register** — not RISK-REGISTER, not ARCHITECTURE-DECISIONS, not AUTO-RUN-STATE, whose "Open findings" row still lists only GH-004/GH-008/GH-009. | A registered follow-up that exists only in a commit message is not registered. It also means the recorder-window class had a **known second occurrence** before REV-B filed, which REV-B (blind, and reading the run ledger rather than commit messages) could not have known. (t04) |
| **REV-C-007** | A **tracked, empty, undocumented file named `=`** sits at the repository root, introduced in `dfa717f` (2026-08-05), present at the frozen `milestone/M4` tag, and still present at `origin/main`. It is the first entry a virgin clone lists. | Functionally harmless. Recorded because (i) its visibility on the first `ls` of a fresh clone is direct evidence that doc 38 §7's fresh-clone item had never been performed, and (ii) no gate has a file-name hygiene arm — architecture assertion 52b, the only candidate, iterates `os.listdir` filtered by `os.path.isdir` and so sees directories only. (t05, t06) |
| **REV-C-009** | Two retained artifacts **inside EV-M4-005 disagree**: the tracked `critical-path-requests.{desktop,mobile}.json` record `critical-path-apply-candidate` = **1**, while the acceptance transcript 43 beside them records **2**, as do REV-B's and the current runs. `writeLedger` goes through the NR-14 evidence redirect, so a plain run writes to `.evidence-scratch/` and only `--refresh` updates the tracked file; the acceptance run did not refresh it. The count also **doubled 1 → 2 inside M4-005 with no recorded reason**, and no budget covers it — the real-stack ledger is deliberately outside the request-budget gate. | An I-10-shaped change on the critical path's final step is measured by nobody: the mocked suite's budgets do not carry these step names, and the real-stack ledger has no gate. The exclusion is disclosed in the spec's own docblock and is defensible; the consequence is not obviously intended. (t10) |
| **REV-C-010** | **REV-A's finding IDs are not stable between its own two documents.** `REV-A-003`, `-004`, `-006` and `-007` each denote a *different* finding in `REPORT.md` than in `INDEX.md` (e.g. `REV-A-004` = the mutable termination facts in the report, = GH-008 M-2 in the index). Both files are committed on `review/rev-a`. | This is the CLAUDE.md rule-13 failure mode exactly — "a stable ID that silently changes meaning corrupts every document that cites it, and the citation still looks correct". doc 38 §5's "the reviewer's severity is preserved verbatim per finding" is not performable while an ID has two meanings. **`REPORT.md`'s numbering is the later and authoritative one**; this register uses it throughout. The repair is a citation repair in the index, not a renumbering of findings. (t15) |

### NOTE

| ID | Finding | REV-C |
| --- | --- | --- |
| **REV-A-008** | `build_runs` cross-**group** visibility for `app_migrator` (1 foreign-group row) — migration 0019's organization-scoped `build_runs_organization_capacity_read` policy, **by design**, the `SECURITY DEFINER` counter's route. Two accuracy notes only: the shipped D-4b arm covers `app_runtime`/`app_worker` only, and SBX-004's declared exceptions do not name it. | Not rechecked by execution; REV-C read migration 0019 and confirms the policy is `FOR SELECT TO app_migrator`, organization-scoped, and structurally pinned by its own populated-cycle test. REV-A's NOTE grade is right. |
| **REV-A-009** | CAP-061 is renamed relative to report 19 with no rename annotation in doc 06. | **CONFIRMED** (t02). Substance preserved; the rename is required by the clean-room rule; REV-C additionally verified the source-product noun appears in **no** code path. |
| **REV-A-010** | doc 06 rows 015, 017, 018, 059 are missing their trailing `\|`. | **CONFIRMED — exactly those four** (t02). |
| **REV-B-007** | One zod message shape echoes caller-supplied text into a 4xx body (`Unrecognized key(s) in object: '<caller string>'`); `parseBody` relays `issue.message` verbatim. The 5xx half holds — fixed string. | **CONFIRMED by source** (t16). REV-C endorses the NOTE grade *and* REV-B's stated worry: a future route with a free-text value in that position would relay free text back out of a protected ingestion path (I-17, rule 8). |
| **REV-B-008** | No test proves rule 9's first clause for an **ordinary request-body value**; `apps/api/src/index.ts` ships `logger: true` with no `redact`. REV-B's probe found 0 log hits — but across only **one** captured log line, which REV-B calls out as a thin haystack. | **REV-C endorses both the probe and the restraint.** The probe carries a non-vacuity assertion and a planted-needle control; REV-B declined to call the result a pass anyway. Its recommendation — a standing marker-in/log-hunted/needle-control regression — would make rule 9's first clause a tested property rather than a design intention. |
| **REV-C-006** | REV-A's INDEX §2 states the capability check as a "`diff` of the two sorted `CAP-0NN` sets"; doc 06 contains only 5 `CAP-0NN` strings (its rows are bare three-digit numbers), so that comparison cannot have run as described. REV-A's own `awk` line shows it actually parsed `^\| [0-9]{3} \|` rows, which is correct. | **Conclusion unaffected and independently confirmed** by REV-C's own parser: 58 = 58 = 58, nothing dropped, nothing invented, 18/3/37. Only the prose describing the method is inaccurate. (t02) |
| **REV-C-008** | `ALLOWED_IMPL_ROOTS` in `docs/architecture/validate.py` **names `docs/evidence`** and assertion 52a never consults it — 52a's condition is a bare `rel.startswith("docs/")`. The variable is read only by 52b, which iterates top-level **directories**. | A dead allowlist that reads as an exemption. It is precisely the trap REV-B-005 fell into, and — because 52b sees directories only — the reason nothing catches a stray file at the repository root (REV-C-007). Attached to REV-B-005 rather than replacing it. (t06) |
| **REV-C-011** | REV-A's `p2-audit-and-termination` probe is **not composed-run-safe**: it tampers with the audit chain as superuser with triggers disabled, so leaving it in the tree reddens `test/audit/chain.test.ts`. REV-C proved this the hard way by contaminating its own composed run #2 (recorded in full in t12) and re-running it clean as #2R. | Not a repository defect and not a criticism of REV-A, which ran the probe targeted and removed it. Recorded because it generalises: the NR-14 clean-tree discipline covers **tracked** files, and an **untracked** probe under `apps/api/test/` is invisible to it while participating in every run. |

**Tally: 2 BLOCKING · 6 MAJOR (5 distinct defects; A-001 and B-003 are one) · 12 MINOR · 8 NOTE.**

---

## 8. Recommendation

# REVISE.

REV-C recommends **REVISE**, not ACCEPT.

This is a recommendation, not an adjudication and not a gate decision — both belong to Fable
(doc 38 §3, §5).

### 8.1 Why REVISE, tied to doc 38 §9

Criterion 3 is REV-C's recommendation itself. Of the other ten, **five do not hold today** and
one **cannot be made to hold as written**:

| § 9 | Criterion | Holds? | REV-C's evidence |
| --- | --- | --- | --- |
| 1 | Plan committed with the §10 ratification | **yes** | doc 38 §10 reads PASS on all four checks |
| 2 | All three reports complete per their completion criteria | **no** | REV-A has no per-scope-area coverage table and its report mis-cites where one is (REV-C-003); and §2.7's M3R surface item **cannot be satisfied by anyone** because no enumerable register exists (REV-C-004) |
| 4 | Every valid finding resolved through §6 | **no — not begun** | 2 BLOCKING and 6 MAJOR entries stand unrepaired |
| 5 | No confirmed functional defect remains | **qualified yes, with one honest caveat** | see §8.3 |
| 6 | Original reviewers have delta-verified their corrections | **no — not begun** | no repair exists to verify |
| 7 | The complete serial §7 battery passes | **no** | `pnpm check` fails on this machine class (REV-A-001 = REV-B-003); the 65-arm red-case battery with a green union guard **fails on `main` today** (REV-C-001); `fixture-regression` and `sbx` have no automated evidence at all (REV-C-004); one §7 row — the "populated" migration cycle — describes a battery that was never run in that form (REV-A-002) |
| 8 | **GitHub CI passes on `main`** | **no** | **three consecutive push runs on `main` have concluded failure**: `1593b06`, `93a71f5` (run 32612471848 — gate battery), `64ddfd1` (run 32616586257 — red-case shard 8 + union guard). See §8.2 |
| 9 | All required PRs merged | n/a | nothing to merge yet |
| 10 | Fresh-clone validation passes against `origin/main` | **partially — and this is now executed** | the validator third **passes** from a genuine fresh clone (36/36 · 95/95 · PASS, t05); the remaining §7 items from that clone are a 12–15 h serial run and were not attempted |
| 11 | Control and evidence documents accurately reflect the outcome | **no** | REV-A-002, REV-B-004, REV-C-002, REV-C-005, REV-C-009, REV-C-010 are each a record that does not match what was executed |

Criterion 8 alone is dispositive. **Two independent BLOCKING-severity observations of the same
defect, on two different commits, in two different batteries** is not a condition an ACCEPT can
be written over.

### 8.2 What the recorder-window class means for criterion 8 — stated honestly

Criterion 8 is currently **red at first attempt, green on a flake re-run**. That phrasing is
accurate and it is also the most dangerous available description, so REV-C states plainly what
it does and does not mean.

**What it is not.** It is not a product defect. Against the real stack the interaction records
**0 requests at both viewports**, in the retained M4 ledger and in REV-B's re-execution, with a
non-vacuous neighbouring step recording 2. The invariant holds in the product. The failure is in
the instrument.

**What it is.** A load-sensitive race in a **shared** test harness — the open side of the class
GH-009 registered on the close side. Three properties make it worse than "a flake":

1. **It is class-wide.** 18 of the 44 budgeted interactions carry `maxRequests: 0` and every one
   is recorded through the same `recordRequests` helper with the same DOM-visibility trigger.
   Repairing one call site does not repair the class.
2. **It moves between batteries.** At `93a71f5` it took the gate battery; at `64ddfd1` the gate
   battery was green and it took red-case shard 8 instead. A re-run that turns one lane green is
   not evidence the class is gone; it is evidence about that lane on that run.
3. **The arm it took down is the I-13 detector's own proof.** `i13-schedule-authoring` returning
   NOT PROVEN means the battery cannot currently certify that the invariant CLAUDE.md rule 10
   forbids weakening is actually detected. That is the precise inversion the red-case battery
   exists to prevent.
4. **The margin is single-digit milliseconds, on every run.** REV-C measured it (t14, §1.4): the
   page's second periods `GET` and the window opening are separated by **4–16 ms** on 21 passes
   (median 8 ms) and by **−6 ms** on the one failure. The proof of an I-13/I-10 invariant is
   currently decided by scheduler noise inside a 10 ms band. That is a different thing from a
   flake, and it is why REV-C grades this BLOCKING.

**Therefore, re-running until green is not a repair, and a green re-run must not be recorded as
one.** The correct disposition is REV-B's: repair the recorder window at the class level; never
raise the budget, never relax the assertion. And until it is repaired, **"CI passes on `main`"
cannot be established by a single green run** — a class this load-sensitive needs a stated
number of consecutive green runs, decided by the adjudicator, before criterion 8 is closed.

### 8.3 What REVISE does NOT mean — the engineering underneath largely held

REV-C wants this recorded as plainly as the findings, because a bare REVISE would misdescribe
what three reviewers found.

**No reviewer, across three independent packets and roughly a hundred probes, found a functional
product defect reachable through a shipped surface.** REV-A filed zero BLOCKING and said so.
REV-B's single BLOCKING is a harness defect it took care to prove innocent of amplification.
REV-C found nothing to add to that column.

What held under attack, re-verified by REV-C rather than taken on trust:

* **The 58-capability scope.** 58 = 58 = 58 across report 19, doc 06 and doc 18 under REV-C's own
  parser; nothing dropped, nothing invented; 18/3/37 exactly as claimed.
* **Tenancy, immutability and the audit chain.** REV-A's 17-arm database battery — every "reads
  zero rows" arm preceded by a non-vacuity arm — held across four non-BYPASSRLS roles, 17 tables,
  cross-tenant and cross-group, plus I-18 refused for all **five** roles including break-glass.
* **Both mutation harnesses are real.** REV-C re-ran one mutation from each reviewer against the
  **shipped** tests: both bit, both restored byte-identically, both reproduced the original
  reviewer's exact figure.
* **The reproducibility derivation.** REV-A's 26-case truth table reproduced row for row under
  REV-C, including both FAD-52 knife-edge sides and the three counterexamples.
* **SBX.** 9/9 · 371 readings · 53/53 tables · 0 wrong-tenant · 0 vacuous, reproduced identically
  by two reviewers.
* **The client contacts no third party**, verified by REV-B with its own scanner rather than the
  repository's, with both guard arms biting in both directions.
* **Non-vacuity.** 10/10 sampled assertions load-bearing; no `.only`, no `.todo`, no zero-test
  file across 184 test files — re-derived independently by REV-C.
* **The delta is additive.** Byte-identical trees, no assertion deleted, no budget raised, no gate
  removed; the arm count moved 64 → 65 by addition.
* **The doc validators pass from a genuinely fresh clone of `origin/main`** — 36/36, 95/95, PASS.

The findings that force REVISE are, with two exceptions, about **the record rather than the
product**: a battery row that describes a run nobody performed, superseded figures with no
pointer to their supersession, an evidence bundle disagreeing with itself, a follow-up packet
that exists only in a commit message, finding IDs that mean two things. The two exceptions —
REV-A-003 (a recorded limitation that is less limited than recorded) and REV-A-004 (an honesty
guarantee resting on application discipline where this codebase's own standard is database
enforcement) — are real engineering findings, and both were confirmed twice by REV-C.

### 8.4 What an ACCEPT would require

Offered as REV-C's view of the shortest honest path, not as an adjudication:

1. **Repair the recorder window at the class level** (REV-B-001 + REV-C-001), never the budget or
   the assertion; then demonstrate criterion 8 with a stated number of consecutive green runs on
   `main`, not one.
2. **Generalise the GH-005 ceiling repair to its own class** (REV-A-001 = REV-B-003) so `pnpm
   check` is a property of the code rather than of the machine.
3. **Correct the "populated cycle 0001–0019" row** wherever it is live — doc 38 §7 included, since
   the error has already propagated into the review plan's own acceptance criteria — and either
   build a real populated 0001–0019 cycle or state the row as the empty cycle it is (REV-A-002,
   REV-C-002).
4. **Decide REV-A-003 and REV-A-004** on their merits. Both are confirmed and both are genuine;
   neither is a shipped-surface defect today, and both are exactly the class this repository says
   it enforces in the database rather than by discipline.
5. **Give `fixture-regression`, `sbx`, and the M3R surface item an evidentiary home** — or amend
   doc 38 §7/§2.7 to stop requiring what nothing produces (REV-C-004).
6. **Repair the record**: REV-B-004, REV-C-005, REV-C-009, REV-C-010, and REV-A's coverage table
   (REV-C-003).
7. **NR-15's retirement should not be restored by clean runs.** Five clean composed runs followed
   REV-B's one captured failure; the repository's own rule (NR-15 was "explicitly NOT ruled a
   flake" after 55+ clean runs) says that is not how this class is closed. Repair the signer-less
   call site, or re-open the risk with the mechanism named.

### 8.5 REV-C's own errors, declared

Two, both caught by REV-C and both recorded in the transcripts rather than quietly fixed:

1. **REV-C contaminated its own composed run #2** by leaving REV-A's probe files in
   `apps/api/test/rev-c/` when the whole-workspace run started. The run collected them, and
   REV-A's audit-tampering probe reddened two of the repository's own `chain.test.ts` tests.
   Run #2 is invalidated in full in t12; run #2R was executed on a verified-clean tree. The two
   `chain.test.ts` failures are REV-C's artefact and are **not** filed as findings.
2. **REV-C drafted a finding against REV-B's real-stack figure that was wrong** — REV-C compared
   REV-B's nine printed counts against an eight-entry JSON ledger, when REV-B had cited
   transcript 43, which prints exactly nine in exactly REV-B's order. The draft is withdrawn in
   t10; checking it is what surfaced the genuine REV-C-009 instead.

A third, minor: REV-C's spot-check of REV-A's `checkpoint-signer.ts` citation initially reported
ABSENT because REV-C guessed the wrong path. REV-A's quote is verbatim correct. Corrected in t08.

---

## 9. REV-C's own per-obligation coverage

REV-C filed REV-C-003 against REV-A for lacking this table. It would be hypocritical not to
provide one. **executed** = REV-C ran something and read its exit code or output. **declared** =
not done, with the reason. No obligation is silent.

| Charter obligation (doc 38 §3 REV-C, and the packet's enumeration) | Status | Evidence |
| --- | --- | --- |
| Independently recheck REV-A-003 | **executed** | t13 — REV-A's committed probe re-run byte-identically, plus an independent source derivation |
| Independently recheck REV-A-004 | **executed** | t13 — same, plus migration `0018` guard + grant read |
| Attempt the NR-15 recurrence **at least twice** | **executed — three attempts, two valid** | t11 (#1), t12 (#2 invalid + #2R). Both valid attempts clean |
| Recheck REV-B-001's product-innocence half | **executed** | t10 (retained ledger + code-read), t14 (proven by construction from the failing side) |
| One figure-match from REV-A | **executed** | t02 — the 58-capability figure, re-derived with REV-C's own parser |
| One figure-match from REV-B | **executed** | t03 — §C row 5; **not confirmed** |
| Compare A and B: overlap | **executed** | t09 §§2.1, 2.3 |
| Compare A and B: disagreements — name each or state there are none | **executed** | t09 §2.2 — **one**, named and adjudicated |
| Compare A and B: cross-misses | **executed** | t09 §2.4 |
| Shared omissions: `fixture-regression` | **executed** | t08 CHECK 3 — confirmed, and widened to SBX |
| Shared omissions: red-case arms 21/22 | **declared, with a substitute** | §6 — ≈ 35 min each; CI's own execution of arm 21 read instead (t04) |
| Shared omissions: fresh-clone validation | **executed** | t05 — 36/36 · 95/95 · PASS from a genuine clone of `origin/main` |
| Shared omissions: the M3R registered findings | **executed — and there is nothing to enumerate** | t01 |
| Doc-reliance detection, both reports | **executed** | t08 — six checks, three sampled source citations |
| Verify REV-A's two declared-not-executed rows are accurate, not understated | **executed** | t08 CHECK 2 and CHECK 3 — **accurate** |
| Probe quality: sample ≥ 3 from each reviewer | **executed** | t06 — three each, two re-run and four code-read |
| Spot-check one of REV-A's four mutation probes | **executed** | t06 — M3, bites, restores, REV-A's exact figure |
| Spot-check one of REV-B's 10 sampled assertions | **executed** | t06 — M-07, bites, restores, REV-B's exact figure |
| Additional bounded probes, ≥ 2 | **executed — six** | §6 |
| Consolidated findings register | **delivered** | §7 — 28 entries, 29 original IDs, every severity preserved |
| Recommend ACCEPT or REVISE | **delivered** | §8 — **REVISE** |
| **Not in REV-C's charter and not attempted:** adjudicating findings; deciding the gate; implementing any repair | **prohibited** | doc 38 §3, §4.3, §4.6 — REV-C did none of these |

### 9.1 Could not falsify — what REV-C attacked and could not break

1. **REV-A's four mutation probes.** REV-C re-ran M3 against the **shipped** domain test rather
   than REV-A's own probe, on the theory that a mutation might only be visible to its author's
   instrument. It was not: the shipped test caught it, with REV-A's exact figure.
2. **REV-B's non-vacuity claim.** REV-C looked for the arithmetic to be wrong (three different
   counts appear in REV-B's index) and it is not — the driver ran twice, 9 + 1 = 10, and the
   transcript shows both summaries.
3. **The capability baseline.** REV-C wrote its own parser specifically because REV-A's stated
   method could not have worked as written (REV-C-006). The conclusion survived: 58 = 58 = 58,
   nothing dropped.
4. **REV-B's real-stack figure.** REV-C drafted a finding that it did not match the retained
   record, and was wrong — REV-B had cited the transcript, which matches exactly. Withdrawn.
5. **REV-A-003 and REV-A-004.** REV-C tried to establish both from source *without* the probes,
   expecting to find the probes doing work the code did not support. Both mechanisms were
   already visible in the migrations and the route. Then both probes reproduced first time.
6. **REV-A's source citations.** Three sampled, three verbatim present.
7. **The doc validators.** REV-C ran all three from a genuinely fresh clone, on the theory that
   something in the working tree was propping them up. 36/36 · 95/95 · PASS.
8. **REV-B's declared-not-executed list.** REV-C checked the two checkable declarations as
   statements of fact. Both hold, including the exact `139`.

---

## 10. Probe hygiene

* Every code-modifying probe was applied, measured, and restored, with the restore verified:
  REV-A's M3 mutation (sha256 `94483d69…` → `94483d69…`), REV-B's M-07 mutation
  (`a4ee2025…` → `a4ee2025…`), and REV-C's own instrumentation of `apps/web/e2e/schedule.spec.ts`
  (restored, `git status` clean on the file).
* REV-A's two re-run probe files were staged under `apps/api/test/rev-c/` and **removed**. They
  are REV-A's bytes, verified by matching sha256 against `review/rev-a`, and are deliberately not
  re-committed here — they already live in REV-A's bundle.
* **One hygiene failure, declared:** those files were left in place when composed run #2 started
  and were collected by it. Recorded in full in t12 and §8.5; the run is invalidated and #2R was
  executed on a verified-clean tree.
* The final tree of `review/rev-c` differs from its base `64ddfd1` **only under
  `docs/evidence/EV-REVIEW-C/`**.

---

**Filed by REV-C, 2026-08-23. This reviewer implemented nothing, adjudicated nothing, and does
not decide the gate. Every figure above was produced by a command whose output is in
`transcripts/`; every claim REV-C could not execute is declared with its reason; and REV-C's own
two errors are recorded in §8.5 rather than quietly corrected.**

**Recommendation: REVISE.**
