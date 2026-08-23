# EV-REVIEW-A — REV-A evidence bundle (post-M4 internal review, packet REV-A)

**Reviewer:** REV-A, a fresh high-effort Opus agent, architecture-and-domain scope.
**Packet:** [doc 38](../../fable/38-post-m4-internal-review-plan.md) §§1–5, packet REV-A.
**Probe branch:** `review/rev-a` (never merged). **Base:** `f855340` (= `origin/main`
`93a71f5` + doc 38 + the AUTO-RUN-STATE sync commit).
**Review baseline (doc 38 §1):** M1–M4 claims judged at `milestone/M4`
= `cc9f3f92583565e540a4a3b682303675ba8b6a70`; the delta to `origin/main`
= `93a71f52a16c60d99fecd6c862ba952b170cfb3a` judged for non-alteration of frozen claims
plus its own correctness.

**This reviewer implements nothing and repairs nothing.** Every probe that modified a
tracked file was applied, measured, and restored; the applied diff is recorded inline in
the transcript for that probe. The final tree of `review/rev-a` differs from its base
only under `docs/evidence/EV-REVIEW-A/`.

**Machine of record for this review:** 4 vCPU, 15 GiB RAM, Linux 6.18.44, Node v22.22.2,
pnpm 11.18.0, CPython venv at `solver/.venv/bin/python`, load average 0.19 at start.
`SP_SOLVER_WORKER_COMMAND=/home/user/SchedulePoint/solver/.venv/bin/python` for every
solver-touching run. **Figures measured here are not directly comparable to EV-M4-005's
machine of record** for any wall-clock or deterministic-unit quantity (FAD-52(3):
deterministic units are same-machine-stable, not cross-machine-portable); count-valued
figures (gate counts, arm counts, run counts, reading counts, table counts) are.

---

## Contents

| § | Area | Transcript |
| --- | --- | --- |
| 1 | Baseline: `corepack pnpm check` | `transcripts/01-check.txt` |
| 2 | Capability traceability (58 rows, 18/3/37) | inline §2 |
| — | further sections appended as stages complete | |

---

## 2. Capability traceability — executed

Executed, not read: the 58 rows were extracted mechanically from all three documents and
diffed.

```
$ awk -F'|' '/^\| [0-9]{3} \|/ {n++; s=(NF==10)?$(NF-1):$NF; ...}' docs/fable/06-feature-parity-matrix.md
rows=58 verified=18 in-progress=3 implemented= not-started=37
in-progress: 018 020 057
verified:    001 002 003 004 005 006 008 009 011 012 013 014 015 016 017 019 058 059
```

- **Report 19 (scope authority) ID set vs doc 06 ID set: byte-identical, 58 = 58.**
  (`diff` of the two sorted `CAP-0NN` sets → no output.)
- **Doc 18 (architecture traceability) covers all 58** — `comm -23` of report 19's set
  against doc 18's set is empty.
- **Counts match doc 36 §7 and FEATURE-PARITY-MATRIX exactly**: 18 verified · 3
  in-progress · 37 not-started; the verified set is the M4-004-era 14 plus
  CAP-015/016/017/059, as claimed.
- **No capability dropped.** No ID in report 19 is absent from doc 06 or doc 18.

Name-level comparison of report 19's `#### CAP-0NN · <name>` headings against doc 06's
row names: 40 rows differ by abbreviation only (e.g. "Authentication and session
management" → "AuthN & sessions"); one row differs semantically and is filed as
**REV-A-006 (NOTE)** — CAP-061 "ORSOS connector" → "Connector certification pipeline".
The substance (external specification required before connector certification; blocks
connector release) is preserved in doc 06's row, and the rename is required by the
clean-room rule, but doc 06 carries no rename annotation.

Formatting note (not a finding, recorded for the next reader): four rows of doc 06's
table — 015, 017, 018, 059 — are missing their trailing `|`. Markdown renders them
correctly; a naive column-index parser mis-reads them (this reviewer's first tally read
15/2/37 before the missing pipe was accounted for).

---

## 1. Baseline `corepack pnpm check` — EXECUTED, and it does NOT reproduce green

`transcripts/01-check.txt` (4555 lines). Started 02:21:18Z, ended 03:00:25Z (39 min).

```
GATE                     RESULT   TIME
lint                     PASS      16845ms
typecheck                PASS      32866ms
unit                     FAIL     1584119ms      <<<<
import-boundary          PASS       2939ms
route-policy             PASS       1950ms
migration-rls            PASS        762ms
invariant-ids            PASS        701ms
rule-node-mapping        PASS        683ms
rule-kind-registry       PASS        863ms
provider-boundary        PASS        714ms
solver-kind-parity       PASS        675ms
secret-scan              PASS       1734ms
raw-nul                  PASS        961ms
build                    PASS       4288ms
network-guard            PASS        685ms
axe                      PASS     694592ms
request-budget           PASS        747ms
17 gate(s): 16 passed, 1 failed
EXIT=1
```

```
Test Files  1 failed | 169 passed | 1 skipped (171)
     Tests  2 failed | 2166 passed | 14 skipped (2182)

FAIL api test/solver/e2-objective.test.ts > the objective is TIERED … >
     records rank, multiplier, scale and each rule's scaled weight
  Error: Test timed out in 120000ms.   (test/solver/e2-objective.test.ts:159)

FAIL api test/solver/e2-objective.test.ts > status honesty and the metric set, end to end >
     measures SPEC-04 §7 and leaves the unmeasurable rates NULL
  Error: Test timed out in 120000ms.   (test/solver/e2-objective.test.ts:754)
```

Filed as **REV-A-001**. Every other figure the gates report corroborates a claim:

| Gate line, as printed | Claim it corroborates |
| --- | --- |
| `route-policy — 113 registered route(s)` | I-02: every registered route declares a policy |
| `migration-rls-pairing (I-15) — 19 migration file(s)` | migrations 0001–0019, every CREATE TABLE ENABLE+FORCE+policy in the same migration |
| `invariant-id-uniqueness — 64 document(s), 22 invariant definition(s), 22 distinct ID(s)` | I-01..I-22, rule 13 (no ID removed or renumbered) |
| `rule-node → compiler-mapping closure — 30 declared node(s) / 30 compiler mapping(s)` | SPEC-04 §3.2 closure |
| `rule-kind registry — 30 unique kind(s), 22 evaluated / 8 not-evaluable, 0 one ruling away` | doc 36 §7's "22 M4-evaluable kinds … the 8 later-milestone kinds failing closed" |
| `solver/checker HARD-kind parity — 22 in model.py, 22 in hard-rule-check.ts` | SPEC-04 §3.3 independent re-validation, kind-for-kind |
| `network-assertion-guard — requestHosts allowlist: 0 (must be 0)` | CAP-068 / T-23, the EMPTY client allowlist |
| `axe — 430 passed, 16 skipped (11.5m)` · `request-budget — 44 budgeted interaction(s), 87 recording(s)` | I-12 / CAP-066 and I-10 |
| `raw-nul-scan — 1298 text file(s), 273 binary skipped, 0 known violation(s)` | NR-18 closed with an EMPTY baseline |
| `provider-boundary — 152 module(s), 2 declared @provider-port module(s)` | SPEC-12 U-07 |
| `secret-scan — 1394 file(s), 11 detectors` | — |

## 3. The delta `milestone/M4..origin/main` — EXECUTED

```
$ git rev-parse 332603e^{tree}   → be81cfa6c62c0e9a345c1f5b5f8808872345f678
$ git rev-parse 93a71f5^{tree}   → be81cfa6c62c0e9a345c1f5b5f8808872345f678   (byte-identical)
$ git log --oneline milestone/M4..93a71f5   → the 11 commits doc 38 §1 names, exactly
$ git diff --name-only milestone/M4 93a71f5 -- docs/fable/36-m4-exit-report.md \
      docs/evidence/ apps/api/migrations/                          → EMPTY
```

Three consequences, all established by execution rather than by reading the record:

1. **No frozen record was retro-edited.** Doc 36 and every `EV-*` bundle are byte-identical
   to `milestone/M4`. FAD-52's supersession is carried in `ARCHITECTURE-DECISIONS.md` only,
   exactly as FAD-52(5) says it is.
2. **No migration changed.** Migrations 0001–0019 at `origin/main` are byte-identical to
   the tag, so every M4 schema claim carries forward unaltered.
3. The 29-file change surface matches doc 38 §1's per-commit description with no file
   outside it.

## 4. Solver / checker independence — EXECUTED, both sides extracted independently

`packages/domain/package.json` declares `"dependencies": {}` — the checker package has no
runtime dependency at all. The two HARD-kind declarations were extracted by this reviewer
with its own parsers (not the shipped gate) and compared:

```
python  solver/schedulepoint_solver/model.py  HARD_KINDS      = 22
ts      packages/domain/.../hard-rule-check.ts EVALUATED_...  = 22
sorted sets: IDENTICAL
```

## 5. R-B4 / R-B5 / overnight — EXECUTED far beyond the shipped set

`transcripts/02-dst-overnight-sweep.txt` · source `transcripts/probe-sources/dst-sweep.mjs`

**23 IANA zones × 3 years × every offset-transition date ±1 day × 16 authored windows =
5424 intervals**, including Lord Howe's 30-minute DST shift, Chatham's :45 offset,
four midnight-transition zones, +14 and −12, and eight overnight windows.

```
gap starts observed : 108      (the R-B4 path is genuinely exercised — not vacuous)
fold starts observed:  93
fold ends observed  :  78
P1 degenerate/refused                       : 0
P2 gap start NOT translated (R-B4a)         : 0
P3a non-positive elapsed                    : 0
P3b delta not a whole quarter-hour          : 0
TOTAL VIOLATIONS: 0        EXIT=0
```

The M4-000B claim ("399 enumerated → 0") holds under a 13.6× wider enumeration.

## 6. Hard-rule checker — EXECUTED at the boundaries

`transcripts/03-hard-rule-boundaries.txt` · source `probe-sources/hard-rule-boundaries.mjs`

**36 hand-crafted arms, 0 failures.** Eight M4-evaluable HARD kinds, each attacked where a
checker is most likely to be wrong and least likely to be tested — the limit itself:

- `MinimumRestBetween` — exactly 10h clean / 9h59m breach; a violation across a two-day gap
  (the M4-002 R-1 defect class) caught; two different memberships never paired.
- `MaxConsecutive` — exactly 3 clean / 4 breach; **4 in a row across a month boundary**
  caught; two memberships alternating not counted; a doubled date not counted twice.
- `MaxAssignmentsInWindow` — exactly 2-in-7 clean / 3-in-7 breach; 3 spread wide clean.
- `RequiresQualification` — held on the date clean; held the day before, the day after, or
  by the other membership all breach; an **unknown key reads `not-evaluable`, never satisfied**.
- `CallSpacing` — exactly 3 days clean / 2 days breach; `isOnCall=false` pairs never fire.
- `AvoidDate` — on the date breach; ±1 day clean.
- `FixedAssignment` — the pin dropped, moved to another membership, moved to another date,
  or given another shift type all breach; **with no `candidateFacts` it is `not-evaluable`,
  never a silent pass**.
- The registry: 30 kinds = 22 evaluated + 8 not, every unevaluated kind carrying a named reason.

## 7. `resultReproducibility` (FAD-49/50/52) — EXECUTED over its whole input space

`transcripts/04-repro-truth-table.txt` · source `probe-sources/repro-truth-table.mjs`

26 direct calls. The FAD-52 repair holds on the exact ground truth the GH-007 record
measured, on **both** sides of the knife edge:

| Facts | Verdict |
| --- | --- |
| wall 8.68s / 10s, 8.076904 of 100 units, FEASIBLE, completed | `stopped-early` (claims-less) |
| wall 9.07s / 10s, same otherwise | `wall-clock-truncated` |
| CANCELLED status vs `completed` termination (FAD-50 B-1) | `interrupted` |
| OPTIMAL at 76.702882 units · OPTIMAL at 5 units · INFEASIBLE at 0.0 units | `reproducible` (the three FAD-52 counterexamples, correctly NOT `stopped-early`) |
| units exactly 50.0 of 100 | `stopped-early` |
| **units 50.000001 of 100, FEASIBLE, completed** | **`reproducible`, with the promise sentence** ← REV-A-003 (GH-008 M-1) |
| **`solver_status` NULL or unrecognised, completed, low wall** | **`reproducible`, with the promise sentence** ← REV-A-004 (GH-008 M-2) |
| units NULL · termination NULL · wall NULL | `unrecorded` ×3 |
| all five interruption reasons | `interrupted` ×5 |

## 8. The database probes — EXECUTED, 17/17

`transcripts/06-db-probes.txt` · sources `probe-sources/p1-*.ts`, `p2-*.ts`
Two probe files, 17 arms, **exit 0**. Every "reads zero rows" arm is preceded by a
NON-VACUITY arm proving the rows exist under the correct context (build_runs,
schedule_versions, assignment_snapshots all non-empty).

| Arm | Result |
| --- | --- |
| **I-15 outside the unit of work** — 4 non-BYPASSRLS roles × 17 M4/publication tables | **0 non-zero reads**; an unscoped `update build_runs` tampers **0 rows** |
| **cross-TENANT** — a Beta-declared context over 17 tables, every role, read AND write | **0 Alpha rows visible, 0 tampered** |
| **cross-GROUP** — a sibling-group context over build/version tables, every role | 0 for every application role. `app_migrator` sees 1 — migration 0019's `build_runs_organization_capacity_read` policy, ORGANIZATION-scoped by design (REV-A-007, NOTE) |
| **I-18 at the database, all FIVE roles incl. BYPASSRLS break-glass**, against a version verified `published` first: update-child · delete-child · **insert a NEW child** · delete the version · update the publication record | **every one refused, every role** (`SCHEDULE_PUBLISHED_IMMUTABLE`, `SCHEDULE_VERSION_NO_DELETE`, permission denied, column-privilege denial) |
| **audit rows, measured by ROW COUNT** (probe 1 had read a zero-row DELETE under RLS as "not refused") | `app_migrator`: DELETE and UPDATE return with **rows affected = 0**; the other four roles refused outright. Chain **55 entries → 55 entries, 0 problems** across the attempts |
| **transition trigger on REAL ROWS** (the shipped matrix drives the SQL function) | `failed → {draft_configuration, queued, running, completed, approved, reviewed}` all `BUILD_TRANSITION_ILLEGAL` |
| **epoch fencing** | `claim_epoch - 1` → `BUILD_CLAIM_EPOCH_REGRESSED: claim epoch moves forward only (1 -> 0)` |
| **identity freeze** | `period_id`, `build_configuration_id`, `source_version_id`, `idempotency_key`, `semantic_request_digest` — every one refused |

## 9. Mutation probes — four, each DETECTED and each RESTORED byte-identical

Driver `probe-sources/mutate.sh`: sha256 before → patch (exactly one occurrence or abort)
→ print the applied diff → run the detector → `git checkout --` → sha256 after → assert
byte-identical → `git status` on the file.

| # | Mutation | Detector | Result |
| --- | --- | --- | --- |
| **M1** RLS predicate | `build_runs_group_scope` USING → `true OR …` (`0018`) | REV-A's OWN tenancy probes | **DETECTED** — 3 arms red (I-15 fail-closed, cross-tenant, cross-group). `transcripts/07` |
| **M2** lifecycle guard | `app_build_run_transition_is_legal` → `SELECT true OR …` (`0018`) | REV-A's own trigger arm + the shipped 256-pair matrix | **DETECTED** — 5 arms red. `transcripts/08` |
| **M3** checker rule | `MinimumRestBetween`: `rest >= minMs` → `rest >= minMs - 3_600_000` | REV-A's boundary probe (rebuilt dist) + the shipped domain test | **DETECTED** — REV-A `[FAIL] rest: 9h59m apart`, 36 arms 1 failed; shipped test 1 failed \| 39 passed. `transcripts/09` |
| **M4** audit-chain link | superuser, triggers disabled: (a) payload tamper on a MIDDLE row, (b) 2-row tail truncation | `verifyAuditChain` | **DETECTED both** — (a) `entry_hash_mismatch` at sequence 34, restore → 0 problems; (b) `head_sequence_ahead_of_chain`, 11 → 9 entries. `transcripts/06` |

Every one restored: `RESTORE VERIFIED: byte-identical`, `git status` clean on the file, and
after M3 the rebuilt dist returns the boundary probe to `arms=36 failed=0`.

## 10. Migration cycle 0001–0019 — EXECUTED, and the claim's WORDING does not survive it

`transcripts/10-migration-cycle.txt` — the exact command EV-M4-005 transcript 42 ran.

```
$ (cd apps/api && corepack pnpm exec tsx test/support/migrate-cycle-cli.ts)
tables remaining after down: (none)
policies remaining after down: 0
MIGRATION CYCLE CLEAN — up -> down -> up -> down -> up, 3826ms
EXIT=0
95 "### MIGRATION" legs (19 migrations × 5), 0019 UP ×3 / DOWN ×2 — by NAME
```

The cycle is clean. **It is also empty**: `migrate-cycle-cli.ts` destroys and re-initialises
the data directory and never seeds a row; a case-insensitive grep for
`insert|seed|populat` over the whole transcript matches only this reviewer's own two header
lines. Genuine POPULATED cycles exist for **5 of 19** migrations (0014, 0016, 0017, 0018,
0019) as unit tests. Filed as **REV-A-002**.

## 11. SBX — EXECUTED, every figure reproduces

`transcripts/11-sbx.txt`, exit 0.

```
scenarios required 9 · executed 9 · passed 9 · failed 0 · blocked 0 · vacuous 0 · probe-error 0
SBX-004 readings: 371 (role, context, table) readings across 7 contexts;
                  0 wrong-tenant rows; 53 of 53 tables observed with visible rows
vacuous assertions detected: 0
```

Identical to EV-M4-005 §24 row 4 and doc 36 §6 (9/9 · 371 · 53/53 · 0 wrong-tenant · 0 vacuous).

## 12. doc 36 §10.4 — the "un-falsified selection window" IS reachable

`transcripts/12-selection-window.txt` · source `probe-sources/p3-selection-window.test.ts`

The record says the reviewer "could not construct the interleaving and did not assert it
reachable". It is constructible **deterministically**, not by racing. `createDraftVersion`
writes an audit event, and migration 0003's chain trigger takes
`pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(<organization>))` — a hook
that sits AFTER `buildStaleness` and BEFORE the draft write.

```
[REV-A/W] CONTROL applied -> 087c03aa-… assignments 1        <- non-vacuous
[REV-A/W] staleness before the race: {"stale":false,"kinds":[]}
[REV-A/W] T2 holds the audit advisory lock for this organization
[REV-A/W] backends waiting on a lock while T2 holds it: 1 (selection is PENDING)   <- the block is VERIFIED
[REV-A/W] T2 moved 1 shift_type row(s) and committed          <- the M-11 shiftType class, edited as the shipped matrix edits it
[REV-A/W] selection outcome: APPLIED draft = 7ca80164-…
[REV-A/W] staleness AFTER, for the same run: {"stale":true,"kinds":["shiftType"]}
[REV-A/W] run state: {"state":"applied_to_draft_schedule","applied":"7ca80164-…"}
EXIT=0  (2 passed)
```

Filed as **REV-A-003**.

---

*(Findings register: returned in REV-A's report to the orchestrator.)*
