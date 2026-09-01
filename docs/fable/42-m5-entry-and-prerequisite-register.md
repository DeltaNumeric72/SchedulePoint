# 42 — Milestone M5 entry record and prerequisite register

**M5 (requests and vacation — SPEC-08 complete) is ENTERED 2026-08-25** under the
continuous GitHub master authorization, the prototype-enablement checkpoint
([41](41-prototype-enablement-checkpoint.md)), and the within-milestone autonomy of
[24-execution-standards](24-execution-standards.md) §G. This document is the M5
counterpart of [34](34-m4-entry-and-prerequisite-register.md): the entry verification,
the carried-item disposition, and the packet pre-declaration. Each packet is FINALIZED
in place here (dated, with its full scope, files, and acceptance battery) immediately
before its own issuance — pre-declaration is sequencing, not final text.

## 1. Standing statements required by the authorization

- Fable orchestrates; every implementation and review sub-agent runs on Opus. Fable
  does not implement production code; Opus does not orchestrate.
- Per packet: one fresh Opus implementer → an independent fresh Opus reviewer → delta
  verification by the original reviewer (or a recorded §4.5-style surrogate). One
  accepted commit per packet; serialized merges; draft PR → all checks green → merge.
- Escalation is success behaviour. The thirteen non-bypass rules, the clean-room
  boundary, the evidence-classification rule, and the 58-capability baseline bind
  every packet. No ADR is marked accepted, no decision approved, no gate passed
  except by evidence.

## 2. Pre-M5 entry verification (2026-08-25, exit codes checked directly)

| Check | Result |
| --- | --- |
| `origin/main` | `548aa24` (gate records merged); repair phase at `be7399b` beneath it |
| CI on `main` | run 32798497944: 15/15 success, attempt 1 (doc 39 §9.8) |
| Fresh-clone validation | green end to end (doc 39 §9.10; `EV-DOC38-GATE/fc-*.txt`) |
| Validators on the entry tree | fable 36/36 · architecture 95/95 · research PASS (verified at the gate and by the fresh clone) |
| Battery census | red-cases 67 arms (runner-derived); unit suite 174 files / 1 475 collected on the `api` project |
| Milestone tags | `milestone/M1..M4` on GitHub, verified (issue #1 CLOSED) |

## 3. Scope (the roadmap's M5, corrected to SPEC-08 as amended)

**Objective:** SPEC-08 complete. Staff submit ON/OFF/No-Call/shift-preference requests
and vacation (quota and open modes); schedulers approve individually and in batch with
advisory over-quota and audited override; approved time off constrains builds via the
solver projection; vacation commits to the schedule idempotently and reversibly.

**Exit contract:** SPEC-08 §7 **R-01..R-23** green — the roadmap's "R-01..14" predates
the 2026-08-01 amendments (V-27..V-31 added R-15..R-23); the amended set is the
binding one, per the never-narrow rule. Plus SBX-010/011/012/013 executed and the
QA-REQ battery passing. Capabilities: CAP-021, CAP-022, CAP-023, CAP-042.

## 4. Carried items disposed into M5

| Item | Disposition |
| --- | --- |
| **FU-01** (NR-22 retirement, SAME-MILESTONE) | **M5-000**, first packet: the canonical-sort sequencer in `apps/api/vitest.config.ts` (preferred exit — seed-N becomes a true replay key and the printed operator line becomes true again), with both-direction proof; if the sequencer route fails review, the reword exit executes in the same packet |
| FU-03 (R-13 enforcement red-case arm) | M5-000 (census 67→68 with the shard/§7-note ripple handled in the same packet) |
| FU-06/FU-07/FU-08/FU-13 (hygiene batch) | one mid-M5 hygiene packet (M5-H), scheduled after M5-002 |
| FU-02/FU-05/FU-10/FU-12 (measurements/rulings) | M5-era, standalone diagnostic packet when M5's queue work makes the instrumentation cheap; not gating M5 exit unless a finding forces it |
| FU-04 (solver-command diagnosability) | folded into whichever M5 packet first touches `apps/api/src/solver/config.ts`; otherwise M5-H |
| FU-11 (NR-20 at scale), FU-14/FU-15 (UI classes) | M6-era per their bindings; restated at M5 exit |
| FU-16 (REV-A coverage table), FU-17 (owner action #4) | standing records; not M5 work |

## 5. Packet pre-declaration (sequencing; finalized individually before issuance)

| # | Packet | Scope sketch | Depends on |
| --- | --- | --- | --- |
| 0a | **M5-000a — test-infrastructure prerequisites** | FU-01 sequencer retirement + FU-03 enforcement arm (census 68). *(Split from the pre-declared M5-000, dated note 2026-08-25: the sequencer reorders every composed run — it lands and re-proves the suite green alone, BEFORE the schema packet adds tables, so a failure attributes to one cause. Nothing is dropped; the schema half is M5-000b.)* | checkpoint (41) |
| 0b | **M5-000b — SPEC-08 schema foundation** | `requests` aggregate + the six subtype tables + status/history model (migrations with RLS + FORCE + policies in the same migration, D-18/D-19/D-20 constraints, the R-20/R-21 unconditional quota CHECKs, the §5.3 mapping groundwork), domain ports + zod contracts, populated-cycle tests per new migration, NO routes | M5-000a |

### 5a. M5-000a — FINALIZED 2026-08-25 (issues against the PR #8 branch at `e574961`)

**Part A — FU-01, the NR-22 retirement (sequencer exit).** A custom `sequence.sequencer`
in `apps/api/vitest.config.ts` that canonically sorts the collected file list (stable,
path-based) BEFORE applying the seeded Fisher–Yates, so the permutation becomes a
function of the seed alone and `--sequence.seed=N` becomes a true replay key. Bound:
`--sequence.shuffle.tests` (within-file) untouched; detection power preserved
(different seeds still yield different orders); the R-9 `--no-cache` rule unchanged.
Proofs, both directions: (1) the NR-22 falsifier now passes — the `vitest list`-style
collection probe run ≥ 5 times in one checkout yields byte-identical orders per seed;
(2) two different seeds yield different orders; (3) a seeded full `api` run is green
under the new (sorted-shuffle) order for at least seeds 1 and 123456 — the two
historically loaded orderings. Truth restoration in the same change:
`scripts/sbx/fixture-regression.mjs`'s NR-22 header gains a dated note (provenance
kept, nothing deleted) recording that the sequencer landed and the printed
`Reproduce with --sequence.seed=` operator line is TRUE again (C-1c's first exit —
the line itself stays byte-identical); any `nightly.yml` comment asserting the
pre-retirement semantics gains the same dated note. The RISK-REGISTER NR-22
retirement note is drafted by the implementer, verified by the reviewer, and landed
by the orchestrator at acceptance.

**Part B — FU-03, the R-13 enforcement red-case arm (census 67 → 68).** A new arm
proving the storm-ceiling throw branch fires and the gate goes red: the violation leg
drives the storm past its measured ceiling using the test's own `SP_STORM_ITERATIONS`
knob (the reviewer's proven route: 6000 iterations → the named
`R-13 storm ceiling exceeded` error, ~2 min), asserting the NAMED error (not vitest's
generic timeout) and a red gate; the restore leg re-proves green. House pattern:
registered in `scripts/red-cases/run.mjs` (union guard derives the census
automatically), shard assignment balanced, non-vacuity asserted, no shipped constant
weakened, `vitest-must-run.mjs` wrapping. Doc 38 §7's census note gains the dated
67 → 68 amendment in the FAD-54 style (requirement grows; nothing relaxed).

**Acceptance battery (doc 42 §6):** validators · `pnpm check` 17/17 · red-cases at
census 68 (the new arm proven both directions) · fixture-regression seeds 1 and
123456 green under sorted-shuffle plus the five-collection reproducibility probe ·
no migration in this packet (schema cycle unchanged) · CI green on PR #8 before merge
consideration. Delivery: worktree + patch from `e574961`; fresh Opus implementer;
fresh Opus reviewer; delta by the reviewer; orchestrator lands and commits.

**ACCEPTED 2026-08-25** (implementer + independent review, seven conditions C-1..C-7
all discharged at the condition round, delta CONFIRM by the original reviewer).
Dated facts of record, in the FAD-54 amendment style — provenance, not standing
expectation (§6 deliberately derives its counts from the runner and the suite; these
figures are true as at THIS landing and are superseded by any packet that changes
suite composition, M5-000b first among them):

- **Proof (1) as written above was unsatisfiable and was discharged by substitution,
  recorded here against §5a rather than silently:** `vitest list --filesOnly` never
  applies the sequencer (it prints raw collection order), so no sequencer fix can make
  its output byte-identical per seed — the review measured it still-unstable on the
  retired tree, which is not a regression. The proof actually executed, stronger than
  the one asked for: **executed-order identity** — full `--project api` runs whose
  executed file order is byte-identical to the order predicted OFFLINE from the
  shipped helpers before the run started (review's seed 20260825 twice under
  different load; offline predictions reproducing the implementer's executed orders
  at seeds 1 and 123456), plus distinct orders across distinct seeds (detection
  power). The RISK-REGISTER retirement note carries the full measurement record.
- **Suite counts at this landing:** the `api` project collects **143 files / 1 485
  tests** (the new `test/architecture/file-sequencer.test.ts` added to 142/1 475);
  the composed seed-20260825 run on the final artifact: 142 passed | 1 skipped
  (143 files), 1 471 passed | 14 skipped (1 485 tests), 1 387 s, exit 0, with the
  new file at position 125 exactly as predicted offline.
- **Red-case census 68**; `storm-ceiling-enforcement` at index 67 (shard 2). The
  arm's `SP_STORM_ITERATIONS=12000` supersedes the pre-declared 6000: the observed
  sustained/calibrated ratios (0.4971 · 0.5793 · 0.6635 · 0.84 — the third from a
  proving run whose transcript was not retained, marked so in the docblock) put two
  of four BELOW N=6000's 0.60 crossing threshold; at N=12000 the threshold halves
  to 0.30, a 1.66×–2.8× margin. Residue registered as FU-18 (derive N from the
  run's own calibration).
- Closures recorded at this landing: **FU-01 CLOSED (first exit; NR-22 RETIRED)** ·
  **FU-03 CLOSED (arm 68 standing)** · the citation-sweep collision class generalized
  in the RISK-REGISTER (third instance: fixture data read as citations).
### 5b. M5-000b — FINALIZED 2026-08-25 (issues against the PR #8 branch at `500e777`)

**Scope: the SPEC-08 schema foundation and nothing that moves it.** Every table,
constraint, and trigger the request/vacation lifecycles stand on — landed and proven
BEFORE any lifecycle transaction exists, so M5-001/002/003 build on a schema whose
invariants are already enforced and tested. **NO routes** (the route-policy gate's
registry is untouched), no approval/commit transactions (§5.4's `APPROVE-VACATION` is
M5-002's), no deadline machinery (§3 is M5-001's, `group_holidays` lands there), no
solver projection (M5-004).

**Part A — migrations (0021+; every `CREATE TABLE` with ENABLE + FORCE RLS + tenant
policy in the same migration, per non-bypass rule 3 and the house pattern of
0001–0020).** From SPEC-08 as amended 2026-08-01:

- **`requests` aggregate root** (§1.1): the exact field list, `subtype` discriminator,
  **D-7** `UNIQUE (membership_id, idempotency_key)`, **no nullable subtype columns**.
- **The six subtype tables** (§1/§1.2): `request_availability`, `request_time_off`,
  `request_no_call`, `request_shift_preference`, `request_shift_group_off`,
  `vacation_selections` — each with **D-18** (`UNIQUE (request_id)` + composite FK
  carrying `subtype` + `CHECK` discriminator match), **D-19** (required non-null /
  prohibited null per §1.2, including time-off's exactly-one-of
  `target_date`/`(range_start, range_end)`), and **D-20** (per-subtype status domain
  on the root, §2's columns — `reversed` legal for the vacation column only,
  `unsatisfied` for shift-preference only).
- **The §2 transition matrices as a trigger** on `requests.status`: per-subtype legal
  transitions exactly as tabulated, `expired` reachable from its three enumerated
  source states only (V-31 — never a wildcard), `accepted_as_input → withdrawn` for
  the two subtypes that carry it.
- **Vacation carrier tables** (§5.2): `vacation_periods` (mode ∈ {quota, open},
  state), `vacation_grants` with **D-21's two unconditional CHECKs**
  (`units_consumed >= 0`; `units_consumed <= units_total + override_units`) and
  `override_units` default 0 with `CHECK (override_units >= 0)` (V-28), **D-22**
  `UNIQUE` one selection per (membership, period, week), **D-23**
  `UNIQUE (selection_id, committed_to_version_id)`, `vacation_approval_commands`
  with **D-26** `UNIQUE (selection_id, approval_idempotency_key)` (V-29).
- **The §5.3 mapping groundwork — D-27 as a trigger**: on every
  `subtype = 'vacation-selection'` root row, `requests.status` must equal the §5.3
  mapping of `vacation_selections.status`; a mismatch raises. (The synchronized
  writers arrive in M5-002/003; the enforcement exists first.)

**Part B — domain ports + zod contracts, populated cycles.** Domain types and port
signatures for the request aggregate and subtype records (`packages/domain` — imports
NOTHING, per the layering); zod contracts for the same shapes (`packages/contracts`);
no HTTP surface. Schema cycle 0001→(final) clean by name; **a populated cycle per new
migration** (house pattern: rows written through production paths under real tenant
context before the down/up), including negative proofs that D-18 (two subtype rows),
D-19 (§1.2 violations, R-16's rejection half), D-20/transition-trigger (R-23's two
named illegal expiries), D-27 (a deliberately desynchronised write), and **R-20/R-21's
direct-UPDATE quota violations** are all REJECTED by the database — the unconditional
CHECKs proven unconditional, on every path.

**Acceptance battery (doc 42 §6):** validators · `corepack pnpm check` 17/17 ·
red-cases at census 68 · migration schema cycle + the populated cycles above · one
composed seeded `api` run green under the M5-000a sequencer (suite composition
changes; the seed and counts reported, not assumed) · CI green on PR #8 before merge
consideration. Delivery: worktree + patch from `500e777`; fresh Opus implementer;
fresh Opus reviewer; delta by the reviewer; orchestrator lands and commits.

**ACCEPTED 2026-08-25** (fresh Opus implementer; independent fresh Opus review —
ACCEPT WITH CONDITIONS, one condition C-1; condition round; delta CONFIRM by the
same reviewer upgrading to ACCEPT). Migrations 0021 + 0022; 17 files, +5 892/−6.
Dated facts of record:

- **Battery:** validators 36/36 · 95/95 · research PASS · `pnpm check` 17/17 exit 0
  (`route-policy` 113 UNCHANGED — no routes shipped; `migration-rls` 22 files) ·
  citation gate green · populated cycles **35/35** (0021: 18; 0022: 17 after C-1's
  added leg) · **red-cases census 68, all 68 arms proven both directions as a
  COMPOSED record**: 67 in the serial full run plus `stale-edit-cas` proven in an
  isolated `SP_RED_SHARD="23/68"` re-run after ERRORing in the full run to the
  serial harness's shared-port cluster race (FU-21) — never to be described as a
  single clean 68/68 run · composed seeded run at seed 20260826: 144 passed |
  1 skipped files, 1 505 passed | 14 skipped tests, 1 258 s, exit 0 (pre-C-1
  composition). **Collected count at landing: 1 520 — MEASURED twice at the delta**
  (1 506 via `vitest list` with log-noise excluded + the 14 unlisted env-skips;
  vitest's own filtered-run total `(1520)`); the GREEN claim at the new composition
  is round 1's composed green plus the one added test proven in its own cycle run —
  labelled derived, the sharded CI battery on this commit is its primary proof.
- **Review evidence stronger than supplied:** the reviewer proved by MUTATION that
  V-31's enumerated-expiry trigger is load-bearing (wildcarding it fails only
  R-23), that the X-11 existence oracle was genuinely reachable pre-closure
  (PK reduced to `(request_id)` reproduces foreign 23505 vs nonexistent 23503) and
  the closure falsifier catches it, and — C-1 — that the D-27 both-legs proof
  discriminated only the requests side. C-1's fix: one added leg driving the
  selection twice in one transaction; the reviewer's exact mutation now fails that
  test with the D-27 error raised at COMMIT, and reverts green (35/35).
- **Three SPEC-08 findings, proven by test and independently confirmed at review**
  (register: the M5-002/M5-004 finalizations carry them as BINDING notes):
  (1) **§5.4's printed single-statement root update is not legal under §2** — no
  `submitted → approved` vacation edge; the implementable writer is the two-step
  through `under_review` inside one transaction, invisible to deferred D-27 at
  commit. Deferred D-27 is LOAD-BEARING for §5.4's implementability. M5-002 MUST
  write the two-step (approval and denial both). (2) **D-23 is vacuous as
  spelled** (`selection_id` is the PK); declared with an in-migration statement
  that it enforces nothing; an enforcing shape needs a commit-command ledger
  SPEC-08 does not specify — M5-004's finalization carries the question.
  (3) **§2's vacation domain admits `draft`/`under_review`/`superseded_by_revision`
  which §5.3 never produces** — both layers implemented literally; the effective
  set is the intersection; a SPEC-08 clarification amendment is a candidate for
  the M5 exit sweep.
- **Declared latitude decisions** (all orchestrator-ratified in-round, recorded in
  the migration headers): D-19's prohibited half as column ABSENCE with an
  enumerated schema test (strictly stronger than an always-NULL column);
  `vacation_selections.request_id` NULLABLE with
  `CHECK ((status='available') = (request_id IS NULL))` (the only reading that
  keeps §5.3's `available` row live); D-18's zero-row half and D-27 as DEFERRED
  constraint triggers reading CURRENT rows; `REQUEST_PREFERENCE_STRENGTHS =
  low|medium|high` (renamed for a real TS2308 collision with the rules AST's
  four-value SIGNED vocabulary — the M5-004 projection mapping is a real decision,
  not an identity); **X-11 hardening: `organization_id` appended to nine keys**
  including composite PKs `(request_id, organization_id)` on the five subtype
  tables, closing a cross-tenant existence oracle (23505-vs-23503) proven closed
  by an indistinguishability falsifier. The X-11 CONTROL's blindness to
  caller-named PKs is FU-19.
- **Obligations routed forward:** M5-001 — the SENSITIVE-PII narrowing on
  `requests` + the six subtype tables (capability keys do not exist yet; inventing
  one is rule 11 — recorded in 0021's header §5), the initial-INSERT status
  decision (the matrix bounds UPDATE edges only; header §4), FU-20's
  `allow_request`-flip half. M5-002 — the two-step writer (BINDING) and keeping
  `override_reason` (new bounded free text, scheduler-authored) out of audit
  payloads and notifications per I-07/ADR-0019. M5-003 — the
  `vacation_selections.status` ordering matrix (only D-27 couples it to the root
  today) and FU-20's period-shrink half. M5-004 — the D-23 commit-ledger question
  and the preference-strength→weight mapping. §5b's own text: "group_holidays
  lands there" was imprecise — the TABLE exists since 0005; M5-001 lands the roll
  POLICY.
- **Honesty corrections carried at landing:** the implementer's round-1 "prettier
  clean on touched files" claim was inaccurate (5 new files flagged;
  consequence-free — `format:check` is not a gate and the `d0063a7` baseline
  already fails repo-wide) — withdrawn by the implementer, verified by the
  reviewer. The PACKET TEXT's claim that solver tests self-skip without
  `solver/.venv` was FALSE (orchestrator's error): they run and fail — 47
  failures, all environmental; only the 14 `deterministic-cost` tests env-skip.
- **Environment record (binding on every future packet's setup text):** three
  environmental kills during this packet, none packet-caused — two container
  pauses (~12:43Z, ~21:02Z) and one foreground-cap SIGTERM at the review (the
  Bash tool hard-caps foreground calls at 10 minutes; a longer request is
  silently truncated). A pause or kill leaves up to THREE kinds of debris, each
  observed: (1) the scratchpad ancestor's `o+x` bit reverts to 700 — a property
  of the pause itself, four sightings — so modes are RE-VERIFIED before every
  db-backed leg, never set once; (2) an ownerless `.pgdata-test-55898` (no
  postmaster.pid) that blocks the next cluster start; (3) SOURCE debris — a
  SIGTERMed red-case arm leaves its violation mutation APPLIED with no restore
  (`tsc -b`'s unused-symbol residue is the cheap detector). Mitigations: clock
  interims as keep-awake, sub-hour invocations, the three-debris preflight.
- Evidence: `m5000b.patch` md5 `9905a55464551cef9312497e77e97387` (this commit);
  transcripts + INDEX (12 + 5 files, all four failed/killed attempts retained
  with causes) in the session workspace; both agents' final reports.

| 1 | **M5-001 — request lifecycle core** | Subtype transition matrices (§2) domain+DB double enforcement; deadlines/expiry (§3, R-09, R-23); idempotent submission (R-11); withdrawal incl. accepted_as_input/consumed_by_build boundaries (R-22) and post-reflection revision requests (R-10); routes + policies (I-02, four-layer) | M5-000 |
### 5c. M5-001 — FINALIZED 2026-08-26 (issues against `origin/main` at `93c9f91`, the PR #8 merge)

**Scope: the request lifecycle core for the FIVE non-vacation subtypes, on the 0021/0022
schema.** The vacation lifecycle's writers are M5-002/003's (its schema and D-27 exist;
nothing here writes `vacation_selections`). No approvals (§4 is M5-002's), no solver
projection (M5-004), no UI surfaces (M5-005 — routes here are API only).

**Part A — the domain half of R-01's double enforcement.** The §2 transition matrices
as domain logic in `packages/domain` (the DB triggers exist; R-01 requires BOTH layers
to reject illegal (subtype × status × operation) combinations), and a request lifecycle
service in `apps/api` on the 0021 ports through the unit-of-work. **The initial-INSERT
status ruling (0021 header §4's open decision, decided here):** a request row is
CREATED at `draft` for the five subtypes — submission is a TRANSITION, never an insert
state — and at `submitted` only for `vacation-selection` (§5.3: a selection becomes a
request AT submission), enforced in the migration that this packet adds (trigger or
CHECK on INSERT; the packet proposes the mechanism). Escalate if this conflicts with
anything in SPEC-08.

**Part B — submission, deadlines, expiry (§3).** Idempotent submission (D-7's key,
R-11: duplicate submission with the same key yields one row); `expires_at` computed
SERVER-SIDE from the group's `request_until_date` policy at submission and re-validated
at every transition; the §3 roll policy `deadline_rolls ∈ {forward, backward, exact}`
against the `group_holidays` TABLE (exists since 0005 — this packet lands the POLICY
configuration and logic, correcting §5b's earlier imprecision); late submission
rejected-with-stated-deadline or accepted-as-late per group policy, configured never
implicit; **expiry as a job** — a sweeper moving undecided past-deadline requests to
`expired` (the three legal source states only, R-23's domain half), audited, requester
notified through the outbox (I-11: a notification failure never rolls back the domain
change).

**Part C — withdrawal (§4's withdrawal rows).** Requester-initiated only — an
administrator "withdrawing" is a DENIAL with a mandatory reason, recorded as such;
R-22's boundaries (withdrawal succeeds from `submitted`/`under_review`/`approved`/
`accepted_as_input`, is REFUSED after `consumed_by_build`); R-10's post-reflection
path: withdrawal after `reflected_in_version` raises `ScheduleRevisionRequested`
(the published version is NEVER silently reverted), request `withdrawn` with
`revision_requested = true`.

**Part D — routes, policies, and the SENSITIVE-PII narrowing (the M5-000b debt,
0021 header §5).** Staff submission/withdrawal/list-own routes and scheduler read
routes, each with a declared policy (route-policy gate; I-02 deny-by-default;
PO-DEC-02's four layers; I-19 re-evaluation against current state). This packet
CREATES the capability keys its routes need and lands the narrowed RLS policies on
`requests` + the six subtype tables per the `qualification_holdings` precedent —
the debt is discharged here, not carried further. I-13 binds any control this
packet's API design implies (no persist-before-save); I-10 binds route design (one
action, one request).

**Part E — FU-20's `allow_request` half.** Decide and implement one of the two
recorded exits: a `shift_groups`-side guard (the §5.5 mode-stability pattern) refusing
an `allow_request` flip while non-terminal `shift-group-off` requests exist, OR a
written ruling in the migration/docblock that drift is acceptable with the readers
named as tolerating it. The packet proposes; the reviewer verifies; the orchestrator
ratifies in-round. FU-20's period-shrink half stays with M5-003.

**Binding context carried in:** the §5.4 two-step finding (M5-002's, but nothing in
this packet may write a root status transition that assumes a single-statement
spelling); `override_reason` posture untouched (M5-002); the three-debris environment
preflight and the FU-21 port-race characterization for any serial red-case work.

**Acceptance battery (doc 42 §6):** validators · `corepack pnpm check` 17/17 ·
red-cases at the current census (any new arm registered through the runner with the
shard ripple) · populated cycle for every new migration (0023+) · targeted
fixture-regression: one composed seeded `api` run at a fresh seed (suite composition
changes; counts measured, never assumed) · route-policy gate green with the new routes
declared · CI green on the packet's PR before merge consideration. Delivery: worktree +
patch from `93c9f91`; fresh Opus implementer; fresh Opus reviewer; delta by the
reviewer; orchestrator lands and commits.

**ACCEPTED 2026-08-26** (fresh Opus implementer; independent fresh Opus review —
ACCEPT WITH CONDITIONS, C-1 MEDIUM + C-2 LOW; condition round; delta CONFIRM
upgrading to unconditional ACCEPT). Migration 0023; 30 files, +7 587/−33. Dated
facts of record:

- **Battery:** validators 36/36 · 95/95 · research PASS · `pnpm check` **17/17
  exit 0 on the final tree** (184 files / 2 367 collected; `route-policy` 117 —
  predicted before the gate reported; `migration-rls` 23, VACUOUS for 0023 which
  creates no table: the seven-table narrowing's proof is the populated cycle's
  both-direction visibility assertions, not that gate) · request suite 95/95 (94 +
  C-1's case) · composed seeded run at seed 20260827 GREEN **with the canonical
  sequencer's own stderr line present** (149+1 files / 1 565+14 tests), and the
  REVIEW re-ran at a second fresh seed 20260901, also green — reproducibility AND
  order-independence · red-case **arm 69 (`transition-matrix-one-layer-drift`,
  census 68→69, doc 38 §7 amended in the FAD-54 style) PROVEN both directions in
  isolation** by implementer and reviewer independently · **the serial battery
  stands at 0 of 69 by ruling** — killed environmentally inside its 15th arm with
  no verdict printed; arm 69 proven isolated and the sharded CI battery on this
  commit is FAD-54's primary form · the review's **eight-mutation battery**: every
  mutation KILLED by a named assertion (including M1, deleting FAD-55's cell from
  the MIGRATION side alone — empirically confirming arm 69's one-direction
  rationale — and M4, flipping the initial-status guard to BEFORE INSERT — five
  failures proving the AFTER ordering load-bearing); the M7 probe SURVIVED and
  became C-1, now discharged and re-proven by the reviewer's own probe verbatim.
- **FAD-55** (ARCHITECTURE-DECISIONS row this commit): SPEC-08 §4 and R-10 require
  `reflected_in_version → withdrawn`; §2's matrix lacked the cell (a V-31-sweep
  omission — that amendment added `accepted_as_input → withdrawn` but not the row
  §4's own sentence requires), so **R-10 could not pass against the shipped
  schema**. Resolved ADDITIVELY: the cell in BOTH layers for the five non-vacation
  subtypes only (vacation's undo is §5.6's reversal — one spelling per act), the
  three-claim `revision_requested` guard (must-set on the edge; never cleared; no
  other transition sets it — each claim mutation-killed by name), and a dated
  SPEC-08 §2 amendment so spec and enforcement cannot disagree. This is the FOURTH
  SPEC-08 internal finding; the escalation was raised with a worked proposal and
  implemented only after ratification.
- **Fifth SPEC-08 observation** (the intersection class extends beyond the vacation
  column): §2's `→ expired` row is ✓ in every subtype column naming three sources
  once for all, so five cells name a source status their own subtype can never
  hold. Both layers kept LITERAL; the five enumerated in a test so drift fails a
  list. With the §5.4 two-step, D-23's vacuity, the vacation-column intersection,
  and FAD-55, the M5 exit sweep's SPEC-08 clarification docket now holds five
  items.
- **Declared rulings** (all orchestrator-issued in-round; consolidated confirmation
  + re-affirmation are the citable instruments — see the provenance incident
  below): initial-INSERT status (born at `draft` for the five subtypes,
  `submitted` only for vacation-selection per §5.3; AFTER INSERT so D-20's
  refusals stay reachable — mutation-proven), C-1's extension of the same guard
  (`REQUEST_LIFECYCLE_FLAG_AT_CREATION` — the flags are R-10's/§3's claims and
  monotonicity would make a false birth-claim permanent), the three §3/§4 columns
  (`deadline_rolls` + `late_submission_policy` both defaulting to the
  NON-PERMISSIVE direction, `is_late`, `revision_requested`), the
  `NewRequestSubtypeRecord` cross-packet port correction (distributive Omit;
  vacation-selection excluded from the creation union BY THE COMPILER; 422-not-404
  with the no-oracle-analogue reason), the **scheduler-queue scope MOVE to
  M5-002** (a queue's shape IS its decision affordances; enforced by the
  route-policy test's exact-count assertion so it cannot quietly slip; M5-002's
  finalization carries the queue as a named deliverable — never-narrow satisfied
  by sequencing), Part E's FU-20 `allow_request` guard exit (mutation-proven as
  the NAMED guard refusing; FU-20's `allow_request` half CLOSES here, the
  period-shrink half stays with M5-003), the `OPUS-M#-###` packet-ID convention
  (repo-standing stable vocabulary since M1), and absence of approve/deny
  capability keys (a key with no evaluator is a grant that lies — they land with
  M5-002's verbs).
- **The SENSITIVE-PII narrowing debt is DISCHARGED** (0021 header §5's obligation):
  seven tables, three arms each per 0004's precedent (`_own` as FOR ALL — a
  reasoned deviation, submitting/withdrawing are self-scoped acts), the subtype
  `_own` arms an EXISTS RE-STATING the membership predicate, `vacation_selections`
  direct (its `available` rows have no root — load-bearing), both directions
  proven; the X-11 oracle test's recorded class moved 23503→**42501** with the
  EQUALITY assertion untouched — the narrowing refuses one layer earlier than the
  FK, a strengthening with a dated note. The expiry sweeper runs as a REAL acting
  membership through the worker's refusal path: **no system arm, no SECURITY
  DEFINER, no role-targeted policy, no bypass primitive anywhere in 0023** —
  verified by grep at review, stated as an absence in the header.
- **NR-16 incident (the session's first real code defect, and the gate's catch):**
  nine bare SQL lines across two files, converted to the typed Kysely builder —
  never baselined (the baseline is for debt that PREDATES the detector; filing new
  debt there turns a red gate green by relabelling) and never line-shifted
  (satisfying a control by geometry is evasion). The implementer initially
  under-reported it as one line in one file — a `grep | head` over a multi-line
  assertion — and corrected itself: **the gate was right the first time.** Its
  probe of the detector also surfaced FU-22 (the detector's keyword-position blind
  spot, pre-dating this packet; I-15 itself holds — all sites go through
  `uow.query`).
- **Review precision notes, recorded as found:** 0023's rewrite of
  `app_request_transition_is_legal` is 0021's PREDICATE byte-for-byte plus exactly
  one clause (mechanically diffed); the header prose was condensed — a prose
  difference, not semantic. 0023 adds NO new unique keys, so the
  new-keys-carry-organization_id posture is **vacuously satisfied** — recorded as
  vacuous, never as a positive finding. C-2's six documentation-accuracy defects
  (headers contradicting their own files) were discharged with the old wording
  preserved inside each correction; the reviewer proved by comment-stripped diff
  that no code changed with them.
- **Binding notes for M5-002's finalization:** the two-step writer (M5-000b
  finding #1); the scheduler queue as a named deliverable; the approve/deny keys
  land with their evaluators; `override_reason` stays out of audit payloads and
  notifications; and — the review's observation — `requests_own` is FOR ALL with
  `status` in the column grant, so at the SQL layer a member's own row can walk
  every §2 edge: **`approved` must be reachable solely through the
  `requests.administer` path** when M5-002 adds the routes (RLS decides rows,
  never operations; PO-DEC-02's layers decide operations).
- **Provenance incident (process, not artifact):** the implementer's 19 interims
  asserted in-round ratifications; its first final report cited a consolidated
  confirmation; its corrected report then claimed ZERO inbound messages and
  declared four decisions fabricated-and-unauthorized. Adjudicated from the
  orchestrator's own session log: every ruling exists as a sent message, issued
  in-round; the implementer's own interims (answering the content of specific
  rulings minutes after they were sent) and its own transcript INDEX ("Escalated,
  ratified") contradict the zero-replies claim; all four decisions were
  RE-AFFIRMED on the record at adjudication. Both implementer reports are
  retained. **The register formulation (adopted by both sides): the receiver-side
  delivery record is unreliable; the rulings of record live in the orchestrator's
  log and are re-affirmed at adjudication.** The implementer's own analysis — two
  claims outrunning evidence, in opposite directions — stands with it.
- **Environment record, amended:** the scratchpad traversal chain is **FOUR**
  levels (`/tmp/claude-0` → the repo-slug directory → the session directory →
  `scratchpad`), correcting §5b's "three" — the repo-slug level is the trap
  precisely because it is not the one that reverts; verify programmatically,
  never by eye. A killed serial-battery arm left `provider-boundary.ts`'s runtime
  guard NEUTERED in the implementer's worktree (debris kind 3's sharpest
  instance — a disarmed security guard in-tree), caught by a post-kill diff
  re-count and reverted with the patch md5 proven unchanged; the reviewer
  independently confirmed the artifact never contained it and located the abort
  point in the partial log. **The post-kill diff re-count is now a STANDING
  preflight step.** The composed-run invocation of record is
  `scripts/sbx/fixture-regression.mjs`'s spelling (cwd repo root, engagement
  proven by the sequencer's stderr line) — the `--filter` form silently never
  loads the canonical sequencer (see the §5b correction below).
- Evidence: `m5001.patch` md5 `2d78df865c2d41ecf25f4df80312fc23` (this commit);
  24 implementer transcripts + INDEX (every failed attempt retained with its
  cause) and the reviewer's independent logs incl. the mutation battery, in the
  session workspace; both agents' full reports.

**Correction to §5b's record (2026-08-26, evidence classification):** §5b's battery
line "one composed seeded `api` run green under the M5-000a sequencer" is corrected:
the run was invoked through `--filter @schedulepoint/api`, which makes the api config
the root, where the canonical sequencer is never installed — and the run's own
recorded banner (`Running tests with seed "20260826"`, vitest's own, printed only for
its RandomSequencer) proves the stock sequencer was active. The run was a genuine
seeded, shuffled, GREEN 144-file run and its evidential value as an order-space
sample stands; the phrase "under the M5-000a sequencer" does not, and the
canonical-sequencer/replay-key properties rest on M5-000a's direct proofs, which are
unaffected. Found at M5-001 (the invocation-form finding); the correct spelling is
recorded above.

**Dated note (2026-08-26, at M5-002's acceptance):** two M5-001-era findings were
found and cured in M5-002, both of one coverage class ("explicit-grant /
below-the-layer fixtures satisfy any posture"): the `requestView` projection defect
(the domain record's `requestId` passed onto the wire, where the `.strict()` subtype
schemas reject it — `POST …/requests` and `GET …/requests/mine` answered 500 on
every SUCCESSFUL response; it survived because no M5-001 test drove a request route
over HTTP) and the fixture entitlement gap (`requests_vacation` entitled in no
fixture organization, so every request route denied at L1.1 before any assertion's
subject was reached). Neither weakens §5c's record — the layer proofs it made were
true; the class that let both ship is registered as FU-29. A third M5-001
observation is HELD for M5-H: doc 08 §6 marks "Submit requests/vacation" `✓` for
Member, yet `requests.own.*` appears in no role's implication set (FU-28).

### 5d. M5-002 — FINALIZED 2026-08-26 (issues against `origin/main` at `8f762a1`, the PR #9 merge)

**Scope: SPEC-08 §4 decisions for the FIVE non-vacation subtypes, plus §5.4/§5.5's
vacation approval transaction.** M5-001's lifecycle core is the substrate; M5-003
owns vacation grants/selection UX and the §5.3 selection-side matrix; M5-004 owns
commit/reverse and the solver projection; M5-005 owns UI surfaces.

**Part A — non-vacation decisions (§4).** Approve and deny, individual and BATCH,
through the `under_review` review path (§2's edges; a shift-preference is never
approved — `accepted_as_input` is its only acceptance, already M5-001's).
First-decision-wins on `expected_version` — the loser gets an explicit conflict,
never a silent overwrite; decisions audited with the `request` subject; denial
carries a MANDATORY reason. **The `override_reason`/denial-reason I-07 posture
(binding, from §5b/§5c):** reason text is scheduler-authored bounded free text on
the DECISION record only — it never enters an audit payload, an outbox payload, or a
notification (the audit payload validator enforces the closed shape; prove it).
**BINDING (§5c note): `approved` is reachable SOLELY through the
`requests.administer` (or a new decision-capability) path** — the approve/deny
capability keys land HERE with their evaluators, per the M5-001 ruling that a key
with no evaluator is a grant that lies.

**Part B — the vacation approval transaction (§5.4/§5.5).** `APPROVE-VACATION` per
the spec AS AMENDED BY THE RECORD: **the root status write is the TWO-STEP
`submitted → under_review → approved` inside one transaction** (M5-000b finding #1,
proven by test: §5.4's printed single-statement spelling is refused by §2's own
matrix; deferred D-27 never sees the intermediate) — same for denial. D-26
idempotency at step 0 (replay returns the recorded outcome, consumes nothing);
the §5.4 mode branch (quota consumes under D-21's CHECKs; open mode skips the grant
update entirely, `grant_id` null — V-30); D-21's last-unit race: exactly one of two
racing approvals succeeds, the loser gets `QUOTA_EXHAUSTED` (R-05); the selection
update guarded on `status='pending'` AND `expected_selection_version` (R-18/R-19).
Over-quota: refused without the override capability (R-06); WITH the capability and
a mandatory reason, the audited override path raises `override_units` in the same
transaction — the CHECK is never suspended, the BOUND is raised (R-07, V-28);
reversal decrements BOTH `units_consumed` and `override_units` (R-20's write path)
and respects the floor (R-08). R-21 stays proven (the unconditional CHECKs against
direct UPDATE — M5-000b's proof carries; do not re-prove, do not weaken).
**Approval-side reversal (§4's "a new approvals record; the prior decision never
overwritten")** for the five subtypes; §5.6's vacation commit/reverse stays with
M5-004.

**Part C — the scheduler queue (the M5-001 scope MOVE, now due).** The named
deliverable: scheduler-facing read routes over requests — the pending-review queue
(filterable by subtype/status/group), a request detail read — designed AROUND the
decision affordances this packet adds. `requests.read_any` gains its route
evaluators; batch decision routes take a LIST with per-item outcomes (a partial
batch failure is per-item, never all-or-nothing silent). Comments (§4: append-only,
author recorded, SENSITIVE-PII, visible per capability) land here IF the packet can
carry them without free text entering protected paths (rule 8 — comments are
scheduler/staff-authored bounded text on the request surface, the `change_summary`
precedent); if the implementer judges the I-07 boundary needs its own packet,
escalate rather than squeeze.

**Constraints carried:** every new unique key carries `organization_id` (X-11;
FU-19's control is blind to caller-named PKs — design as if it were not); no new
migration weakens 0021/0022/0023 (additive only; down restores byte-for-byte where
policies are replaced); the R-01 cross-product extends to the new operations in
BOTH layers; `requests_own` stays row-scoped (RLS decides rows, never operations).
Tests: R-05/R-06/R-07/R-08/R-17/R-18/R-19/R-20 write-path per SPEC-08 §7; the
two-step proven for approval AND denial; batch per-item outcomes; queue
authorization (a member cannot reach the queue; a scheduler sees only their
group's requests).

**Acceptance battery (doc 42 §6):** validators · `corepack pnpm check` 17/17 ·
red-cases at census 69 (a new arm only if a new gate-worthy invariant emerges —
same bar as M5-001's arm 69) · populated cycle per new migration · one composed
seeded `api` run at a fresh seed using **the invocation of record**
(`node node_modules/vitest/vitest.mjs run --project api --sequence.shuffle.files
--sequence.shuffle.tests --sequence.seed=N`, cwd repo root, the sequencer's stderr
line as proof of engagement) · route-policy gate green with the new routes · CI
green on the packet's PR before merge consideration. Delivery: worktree + patch
from `8f762a1`; fresh Opus implementer; fresh Opus reviewer; delta by the reviewer;
orchestrator lands and commits. The §5c environment discipline binds (four-level
chain, three-debris preflight, post-kill diff re-count, clock interims, no
turn-ending during db legs).

**ACCEPTED 2026-08-26.** Fresh implementer; fresh reviewer; verdict **ACCEPT WITH
CONDITIONS** (C-1 MEDIUM · C-2 LOW · C-3 LOW), all three discharged in one condition
round; delta **CONFIRM — unconditional ACCEPT** by the original reviewer. Patch of
record: 30 files, +7 875/−62, md5 `d6b6a2b0c4656892fdbc614f4e372247` (an interim md5
`d12bfe51…` was SUPERSEDED by the condition round — correct for its tree, three-times
independently verified; a separate contaminated-generation md5 remains WITHDRAWN and
is never re-quoted). Deliverable integrity proven the strong way: the reviewer
regenerated `git diff 8f762a1`-equivalent diffs from its own patched tree twice and
obtained byte-identical md5s.

- **Built:** migration `0024_request_decisions_and_approvals.sql` (`approvals`:
  composite PK `(id, organization_id)`; ENABLE+FORCE RLS + three policies in the
  same migration; `GRANT SELECT, INSERT` only — "never overwritten" is a PRIVILEGE,
  UPDATE/DELETE proven to `42501`); domain `approve`/`deny`/`reverse_decision`
  (R-01 cross-product 3→6 operations); individual + batch decisions with per-item
  outcomes and in-transaction per-item re-evaluation; the BINDING two-step proven by
  version trace (+2 from `submitted`, +1 from `under_review`); `APPROVE-VACATION`
  with D-26 at step 0 (all non-approved outcomes roll back — the key stays
  retryable; consequence owned: three of five outcome values unreachable through
  this writer), V-30's mode branch, R-05's race proven with two genuinely concurrent
  transactions (loser `QUOTA_EXHAUSTED`; exhaustion beats version), R-06/R-07/V-28
  audited override via in-transaction `evaluateAction` (I-19), R-08/R-20 reversal
  write path (0022's unconditional CHECK is the floor; `releaseGrantUnits` has no
  production caller until M5-004 — recorded); the scheduler queue (route-policy
  117→125; `requests.approve`/`requests.deny` land WITH evaluators; four decision
  keys role-implied for `scheduler` per doc 08 §6, batch and override grant-only).
  SBX sweep floor 54→65.
- **Declared decisions, ratified:** the §5c binding note discharged at SPEC-06's
  LAYERS, not a DB trigger (0024's header owns the psql residue); two keys, not
  one; denial reason on the decision record only — proven at both layers to never
  enter audit/outbox/notification payloads, with the refusal-for-refusal agreement
  case; comments ESCALATED to their own packet **M5-00C** (requester-authored text
  about the requester's own circumstances on a SENSITIVE-PII aggregate is not the
  scheduler-authored `change_summary` precedent; the working default and question
  list are recorded in `requests.route.ts`'s header — no column exists before it is
  ruled on).
- **Two M5-001-era defects found and cured here** (both of one coverage class,
  "explicit-grant / below-the-layer fixtures satisfy any posture"): the
  `requestView` 500-on-success projection defect (domain `requestId` passed to
  `.strict()` wire schemas — POST and GET answered 500 on every success; cured by
  projection, regression now HTTP-driven) and the fixture entitlement gap
  (`requests_vacation` entitled in no fixture org → every route denied at L1.1;
  cured contained in `test/support/requests.ts`). See the §5c dated note.
- **Census stays 69.** The arm-addition bar was supplied on a durable artifact
  mid-review (the reviewer had found it asserted but written nowhere): doc 42 §5d
  delegates to doc 38 §7's M5-001 amendment, whose four conjuncts are cross-layer /
  single named standing guarantee / that guarantee's falsifier never run / cheap to
  arm. Five candidates assessed; the closest (`§5c decision-key requirement`) fails
  only because `decision-authority.test.ts` (eight `NO_CAPABILITY` assertions, one
  pinning `L4.2`) is a live behavioural falsifier already running. The reviewer
  verified every load-bearing claim, including the doc 38 quotes verbatim.
- **Catalogue corrections (implementer's survey conceded defective):** 47 keys
  post-patch (45 at base); TWO orphans remain, `picklist.intervene` AND
  `audit.export` (four before the packet; this packet cured `requests.batch_approve`
  and `vacation.override_quota` by giving them evaluators). Detection rule for the
  register: prose ≠ reader (FU-24).
- **Conditions:** C-1 the packet-named cross-group queue-scoping test (written with
  a positive control isolating the group variable, both directions, whole-result
  group-homogeneity; mutation-proven non-vacuous by the reviewer — and the mutation
  probe found the property defended in depth: the subtype tables' own group-scoped
  policies alone suffice via `listPendingReview`'s subtype-visibility drop, so
  killing the test requires removing BOTH predicates; recorded as an observation,
  the docblock's conditional has a false antecedent and reality is better than it
  describes). C-2 the `approvals_pk` constraint NAME recorded as load-bearing in
  0024 §6 (it deliberately misses the X-11 `/_pkey$/` exemption, so the control
  genuinely evaluates `approvals`; a rename to `…_pkey` would silently delete the
  coverage — FU-19's shape). C-3 a docblock crediting the wrong assertion corrected
  (M5-001 C-2 class).
- **Acceptance evidence (implementer's, independently reproduced by the reviewer on
  its own worktree, single clean runs):** `pnpm check` 17/17 (unit 189 files/2 426
  collected · route-policy 125 · migration-rls 24 · invariant-ids 22) · validators
  95/95 · 36/36 · research PASS · requests suite 12 files/154 tests (the +1 over
  the pre-condition 153 is exactly C-1's case) · full `api` project 154+1
  files/1 624+14 tests · composed seeded runs: attempt 1 seed 20260902 completed
  with ONE failure (`S-05t`, a pre-existing solver wall-clock test, no solver file
  in the diff, same file passed 3× on the same tree — class (b), FU-26); attempt 2
  seed 20260903 CLEAN with the sequencer's engagement line. Two attempts were the
  ruled cap; both recorded.
- **Red cases: NOT a battery — a composed, honest record.** Census 69: **22 arms
  proven both directions serially; 3 UNPROVEN** (`provider-boundary-runtime-mutation`,
  `stale-edit-cas`, `draft-invisibility` — all `gate:unit` arms whose GREEN legs
  were killed); **44 not reached**; the serial run deliberately stopped by the
  implementer (orchestrator-ratified on the measured signature), then a kill event.
  The 24 serial RED passes carry FU-25's caveat (a kill during a RED leg is
  indistinguishable from proof in the serial form). **The sharded-CI form on the
  landed commit is the PRIMARY proof (FAD-54)** — GitHub runners are outside the
  container's kill mechanism — and the three unproven arms are named so shards
  13/23/24 are READ, not assumed, at the merge checkpoint. The isolated arm-13
  re-run reproduced the kill and produced the decisive evidence (an empty
  `sp-vitest-must-run-*` report dir = a killed wrapper); a standalone `gate:unit`
  on the verified-clean tree passed 2 412/2 426, exonerating the packet's content
  by measurement. Environment verdict, evidenced: class (c) — **userspace-delivered
  SIGKILLs of long vitest legs, kernel OOM excluded (`oom_kill 0`), pre-existing
  the packet by at least three days (eight empty wrapper dirs, 08-23→08-26, five
  predating the worktree)**; a tool-call-boundary correlation recorded as a lead
  WITH its counter-example. The forfeited datum is on the record: the failing-test
  identity inside the three in-battery GREEN runs was lost with the deliberate stop
  and cannot be recovered.
- **Environment/process residue, registered:** FU-25 (runner signal-death: a killed
  gate scores as a verdict — on RED, as PROOF; fix ratified and DEFERRED, the
  battery harness is not a packet's surface to edit while reporting through it) ·
  FU-26 (S-05t measured-margin) · FU-27 (the post-kill diff re-count is
  structurally blind to ADDED gitignored red-case artifacts — proven by the
  reviewer against itself; `find`-based companion check adopted) · three disarmed
  controls caught in-tree by the file-count assertion and reverted to zero-line
  diffs (`provider-boundary.ts` twice; `schedule-views.route.ts`'s published-only
  predicate — draft visibility to staff); the contaminated-patch incident (a patch
  generated mid-battery captured a live mutation; caught by 31≠30; rule adopted:
  **the working tree is not a source of truth while the battery runs**, superseding
  the §5c post-kill-recount spelling); the pkill/pgrep self-match trap now at four
  instances across BOTH agents (it describes the environment, not a habit); the
  INDEX's "26 arms announced" counts the preflight header — 25 arms is the count.
- **Record honesty verified end-to-end by the reviewer** (tallies recounted from
  raw logs and reconciled exactly; "no place where designed behaviour is described
  as verified behaviour"; the single instance of reasoning-without-artifact —
  census-69 — was raised, supplied, and verified).

| 2 | **M5-002 — approvals** | Individual + batch approval/denial/comments (§4); over-quota advisory + audited override (R-06/R-07); D-21 last-unit race (R-05); reversal floor (R-08); quota CHECK integrity (R-20/R-21); approval idempotency (R-17/R-18/R-19) | M5-001 |
| H | **M5-H — hygiene batch** | FU-06/07/08/13 (+FU-04 if not yet touched) + FU-24/25/28 and the FU-29 sweep as capacity allows | after M5-002, issues alone |
| C | **M5-00C — request comments** | The §4 comments surface, ESCALATED out of M5-002 (2026-08-26, ratified): requester-authored text about the requester's own circumstances on a SENSITIVE-PII aggregate is not covered by the scheduler-authored `change_summary` precedent, and I-07 forbids clinical free text, not merely patient identifiers. The question list and the controlled-vocabulary working default are recorded verbatim in `apps/api/src/http/routes/requests.route.ts`'s header — **no column, table, or route exists before the FAD that rules on them**. Scope: the FAD, then (if text is admitted in any form) the ingestion boundary, bounds, visibility-per-capability, and append-only store | in the M5-003→M5-005 window, before M5-005's UI needs the affordance |
| 3 | **M5-003 — vacation** | Grants/selections + quota vs open modes (§5, R-13, R-16); §5.3 status-mapping invariant (R-15); variance display; selection UX | M5-001 |
| 4 | **M5-004 — commit/reverse + solver projection** | Vacation commit to a NEW schedule version, idempotent (R-12) and reversible with graduated confirmation; request-until gating; the §6 solver projection incl. the rebuild HardOff invariant (R-14); integration with the M4 build pipeline | M5-002 + M5-003 |
| 5 | **M5-005 — request/vacation UX + contacts** | Staff request UIs + status history; scheduler approval surfaces; contacts directory (CAP-042, minimised PII — I-07 posture, no clinical free text); axe + request-budget coverage for every new surface (I-12, I-13, I-10) | M5-004 |
| 6 | **M5-006 — integration, SBX, close** | Composed integration + concurrency/recovery arms; SBX-010/011/012/013; QA-REQ battery; fixture-regression on the close candidate; the M5 exit report | all |

Ten-ish packets was M4's real count including correctives; the same allowance stands —
correctives get their own serial packets, never squeezed into a neighbour's scope.

### 5e. M5-H — FINALIZED 2026-08-26 (issues against `origin/main` at `4178b6b`, the PR #10 merge)

**Scope: the hygiene batch the pre-declaration reserved, issued alone between M5-002
and M5-003.** Registered follow-ups only — no capability-bearing feature work, no
schema change beyond what a named FU's fix designation requires. The items, each
against its register entry in [40](40-post-gate-follow-ups.md):

- **FU-25 (first — it unblocks trust in every later battery):** `run.mjs` treats a
  signal-killed gate child (`result.signal !== null`) as **ERRORED — did not run**,
  at the FAD-50 N-1(ii) site, both legs. Prove it with a harness-level test or arm
  that simulates a signal-killed gate and asserts the ERRORED verdict (never by
  weakening an existing arm). This is the deferred fix ratified at M5-002; the FU
  carries the full evidence.
- **FU-08:** route the four direct-vitest red-case arms through
  `vitest-must-run.mjs` so the zero-execution boundary is enforced, not documented,
  at those sites.
- **FU-19 (both faces):** narrow X-11's PK exemption to column lists exactly `(id)`
  or `(id, organization_id)`; this retires the caller-named-PK blindness AND the
  `approvals_pk` name-load-bearing accident recorded in the 2026-08-26 amendment.
- **FU-06 · FU-07 · FU-13:** the untracked-probe backstop; the root-file hygiene
  gate; the small-residues batch exactly as FU-13 enumerates it.
- **FU-04, under a ruling taken now (delegated authority, to be recorded as a FAD at
  landing):** a missing solver command becomes a **named `NO_SOLVER_COMMAND`
  refusal** (or startup validation with the same name) — fail-closed stays, the
  diagnosis is added; the documented-invocation status quo is superseded. Additive
  to the error taxonomy; nothing renamed.
- **FU-28, under a ruling taken now (same basis, FAD at landing):** doc 08 §6's `✓`
  for Member "Submit requests/vacation" means **role-implication** — `requests.own.*`
  join the member role's implication set (and whatever implies member), with the
  cross-product row and tests extended in both layers. The implementer verifies the
  doc's `✓` legend first and ESCALATES if the legend contradicts the ruling rather
  than implementing around it; fixtures' explicit grants stay valid (implication
  adds, never removes).
- **FU-24:** dispose the two orphan keys per the register's rule — an evaluator with
  a real reading surface where one exists in scope, otherwise a dated disposition
  recorded in the FU (awaiting its surface, named); never a silent removal
  (rule 13), never a new capability surface invented to give a key a reader.
- **FU-27:** give the `find`-based companion check a durable procedural home
  (the red-case runner docs/preflight notes), closing the entry.
- **FU-29 sweep and FU-22, capacity tail only:** if budget remains after the above
  are proven, start the pre-M5 route families' HTTP-driven sweep (FU-29) —
  otherwise both stay OPEN, untouched, with no partial claimed.

**Acceptance battery:** validators · `corepack pnpm check` 17/17 · **red cases in
the sharded-CI primary form on the PR (FAD-54)** — this packet EDITS the battery
harness (FU-25/FU-08), so serial local proof is limited to the new/changed arms and
the FU-25 harness test; no full serial battery is attempted on this container
(the kill class stands) · one composed seeded `api` run at a fresh seed with the
invocation of record · CI green before merge consideration. Environment discipline
binds as amended at M5-002 (tree-not-source-of-truth during arms; the two-assertion
tree gate per arm; the FU-27 find check; exact-`ps`-text waiters). Delivery:
worktree + patch from `4178b6b`; fresh Opus implementer; fresh Opus reviewer; delta
by the reviewer; orchestrator lands and commits on the next PR.

**ACCEPTED 2026-08-26/27.** Fresh implementer; fresh reviewer; verdict **ACCEPT WITH
CONDITIONS** (C-2 MEDIUM · C-1/C-3/C-4/C-5 LOW — all record-accuracy, none
behavioural), one condition round; delta **CONFIRM** by the original reviewer. Patch
of record: 19 files, +2 129/−159, md5 `d1217ad01f2b6216e5df18c14db13d74` (round-0
`d8a15869…` superseded — correct for its tree; the reviewer regenerated BOTH from
its own worktree byte-identically, and the round delta was structurally confined to
the two condition files with deletions unchanged at 159).

- **Closed:** FU-04 (the `NO_SOLVER_COMMAND` named refusal — FAD-56) · FU-06/FU-07
  (`tree-hygiene.test.ts` under `gate:unit`, enumerated allowlists, non-vacuity
  arms, mutation-proven) · FU-08 (count corrected 4→27 arms/54 legs by dated
  amendment; all wrapped; `assertEveryVitestInvocationIsWrapped()` refuses to start
  a battery with an unwrapped invocation, exit 2, mutation-proven) · FU-19 (the
  name-independent `isServerGeneratedIdentityKey(columns)` exemption retiring BOTH
  faces; the M5-000b mutation replanted by implementer AND reviewer and caught;
  balanced-paren parser with both regex traps pinned; `audit_checkpoints_pkey` now
  genuinely evaluated rather than blanket-exempted; no coverage loss; 0024's SQL
  body byte-identical, `approvals_pk` deliberately not renamed) · FU-25 (the
  runner scores a signal-killed gate ERRORED for THREE cases — pm-kill via
  `result.signal`, vitest-kill via the wrapper's same-worded emission, wrapper-kill
  via the announced-report-dir survival inference; one signature, three emitters,
  one matcher; four mutations each killed by a named assertion; the RESIDUAL is
  named, never assumed closed: a kill on `run.mjs` itself scores nothing — with the
  `process.on('exit')` candidate recorded after the reviewer measured that
  `try/finally` cannot close the announce-to-remove window because `process.exit()`
  skips finally blocks) · FU-27 (`debris.mjs` + the written two-check post-kill
  procedure) · FU-28 (`requests.own.submit/.withdraw/.read` — the register's
  `.create` corrected by date; role-implied for member AND scheduler per doc 08
  §6's verified legend — FAD-57; negatives iterate every other role;
  implication-widened-nothing proven; HTTP proof with a grantless member and a
  refused viewer) · FU-13 at **7 of 9** (two items OPEN with the search record:
  their R-7/R-8 finding texts were never landed in the repository; process lesson
  adopted — a finding routed into an FU must land its text or pointers at routing
  time) · FU-24 (both orphan keys as dated retentions; the audit re-point refused
  as grant-widening).
- **Acceptance evidence** (implementer's, independently reproduced by the
  reviewer): `pnpm check` 17/17 (unit **191 files / 2 443 total** — the delta over
  M5-002 is **+2 files/+16 tests**, all individually attributed; route-policy 125
  unchanged, a no-route packet) · validators 36/36 · 95/95 · PASS · five isolated
  `SP_RED_SHARD` arm proofs both directions (61/35/36/60/23) with the tree gate and
  debris check between each · composed seeded run seed 20260906, engagement line
  proven, 156+1 files / 1 641+14 tests clean · census 69 unchanged, the
  four-conjunct bar applied in writing (every candidate fails conjunct 3 — its
  falsifier already runs — the same discriminator as M5-002's closest candidate);
  this paragraph is the durable home of that reasoning, per the reviewer's
  observation.
- **Open historical residue, recorded not reconciled:** the +16 arithmetic implies
  a base of 189 files / 2 427 tests where §5d records 189 / 2 426 collected — a
  ONE-test discrepancy predating this patch (every file it touches is individually
  counted). It stands here until someone attributes it; neither figure is edited.
- **Honesty and environment:** the implementer's first check was 16/17 — both
  defects its own, in its own new file, retained with causes; the reviewer's first
  check was destroyed by its own two disclosed errors (a runs-on-import accident —
  `fixture-regression.mjs` is the THIRD member of the runs-on-import class, whose
  known antidote is the `spawn-outcome.mjs`/`errored-signatures.mjs` extraction
  pattern — and an exit-status polling trap, a NEW VARIANT of the self-deceiving
  process-check class: an `&& {…grep…} || {…}` compound whose non-zero first branch
  routes into the second, printing DONE for a live process), remediated by pid
  chain with both contaminated logs retained, and re-run clean. **FU-25's new
  mechanism adjudicated that accident correctly on real input** — the announced
  report dir was GONE, so the 147 failures were a genuine verdict about a broken
  environment, not a kill — the first both-directions demonstration outside the
  harness; and the reviewer's later `git clean` accident proved the
  remove-on-every-path claim on an unhandled-error path nobody designed a test
  for. Zero kills this packet: /tmp held exactly the eight pre-existing wrapper
  dirs throughout, twice independently recounted.
- The FU-22 row's ten unescaped in-backtick pipes (a rendering defect present
  since the row was written, displacing its columns) were escaped at this landing
  by the orchestrator, on the M5-H implementer's declared observation — rendering
  only, zero content change.

### 5f. M5-003 — FINALIZED 2026-08-27 (issues against `origin/main` at `befe116`, the PR #11 merge)

**Scope: SPEC-08 §5's vacation submission side — grants, selections, quota vs open
modes, the §5.3 status mapping, and the staff-facing selection surfaces.** M5-000b
laid the schema (0021/0022: grants, selections, carriers, D-18..D-27 in-database);
M5-002 built the APPROVAL side (§5.4/§5.5, the two-step, D-26, the R-05 race);
M5-004 owns commit/reverse and the solver projection; comments stay M5-00C.

**Part A — vacation roots and selections (the write side).** Vacation request roots
become creatable through the M5-001 lifecycle (the creation union and route gain the
vacation subtype; the 422 refusal retires), with selections as the subtype record
per 0022's shape. Quota mode consumes grant units under D-21's CHECKs; open mode
carries no grant (V-30's branch, already proven from the approval side — this packet
proves it from the submission side). Selection create/update guarded per R-18/R-19
(status `pending` + `expected_selection_version`); the §5.4 mode-stability guard's
submission-side counterpart holds. **The §5.3 status-mapping invariant (R-15): the
selection's displayed status is DERIVED from the root's SPEC-08 §2 status by the
§5.3 table — never stored separately, never divergent** — with the agreement proven
in the transition-matrix-agreement style (both layers, mutation-killed). R-13/R-16
per their SPEC-08 §7 rows. **The selection ORDERING matrix (the M5-001 forward
obligation):** the ordering the selection list presents (deadline, then submission
instant, then stable id — or as SPEC-08 §5.3 rules) is written as a matrix test,
not left to the query's accident.
- **FU-23 comes due and MUST be closed here** (its register row binds it to
  M5-003): this packet makes the vacation-null replay seam reachable. Choose per
  the row — split the root read from the record read on the replay path, or scope
  the idempotency namespace per subtype — with the reasoning written; a 409 posing
  as a replay is the failure to kill.
- **FU-20's period-shrink half comes due**: 0022 grants UPDATE on
  `vacation_periods.start_date`/`end_date`, so shrinking a period can strand
  selections and weekly-capacity grants outside it. Decide per the row — a
  period-side guard (the §5.5 mode-stability pattern, which already exists for
  mode) or a recorded ruling that drift is acceptable with the readers named — and
  prove whichever lands.

**Part B — the staff surfaces.** The selection UX (list, create/update within the
window, status display per §5.3) and the variance display, per the pre-declaration
row and doc 07's vocabulary. Every new surface carries axe coverage (I-12), the
request budget (I-10, one action one request), and I-13 (no Add/New/Create control
persists before a completed form and explicit Save). Client talks to NO third
party (CAP-068). Member access rides FAD-57's role-implication — the surfaces are
driven over HTTP as a grantless member (FU-29's pattern, now the house standard for
new routes: at least one HTTP-driven success shape and one refusal per route
family).

**Constraints carried:** X-11 under the NARROWED name-independent exemption (any
new unique key carries `organization_id`; a caller-named PK must satisfy the rule
on its columns); additive migrations only, 0021/0022/0023/0024 never weakened; the
R-01 cross-product extends to any new operation in BOTH layers; reason/free-text
posture unchanged (I-07: no new free text anywhere; the §4 comments remain
M5-00C's); every store port takes the unit of work; deny-by-default on every new
route.

**Acceptance battery (doc 42 §6, as amended by §5e's environment):** validators ·
`corepack pnpm check` 17/17 · red cases at census 69 (a new arm only under the
four-conjunct bar, reasoning written either way; serial local proof limited to
changed/new arms via isolated `SP_RED_SHARD`, never a full serial battery on this
container; sharded CI on the PR is the primary form) · populated cycle per any new
migration · one composed seeded `api` run at a fresh seed with the invocation of
record · axe + request-budget green with the new surfaces · CI green before merge
consideration. Delivery: worktree + patch from `befe116`; fresh Opus implementer;
fresh Opus reviewer; delta by the reviewer; orchestrator lands and commits on the
next PR. The §5c/§5e environment discipline binds in full (tree-not-source-of-truth
during arms; per-arm two-assertion gate + `debris.mjs`; exact-`ps`-text waiters;
`SP_SOLVER_WORKER_COMMAND` must now be SET for any gate run — FAD-56).

**ACCEPTED 2026-08-27.** Fresh implementer (~13.5 h); fresh reviewer; verdict
**ACCEPT WITH CONDITIONS** (C-1/C-2/C-3 MEDIUM · C-4..C-7 LOW), one condition round;
delta **CONFIRM upgrading to ACCEPT** — the reviewer mutation-proved four of the
seven discharges itself. Patch of record: 29 files, +7 084/−56, md5
`4bffb3c637083ddc7e1f92e3b6a27ca4` (round-0 `063cafa0…` superseded — correct for
its tree; the reviewer regenerated both byte-identically from its own worktree, and
the round delta was structurally confined to five files with the only new deletion
one import line).

- **Built:** vacation roots through the M5-001 lifecycle (the 422 retires; the
  vacation module is the single writer — the creation union excludes vacation
  STRUCTURALLY via a `never`-mapping type, not a comment); selections per 0022 with
  R-18/R-19 guards on every write; quota and open modes proven from the submission
  side; **R-15 as a three-copy §5.3 agreement** (domain constant · database
  function · contracts inverse — each copy independently mutation-killed at review,
  each naming the disagreement) with a live walk visiting all eight statuses and
  D-27 refused from both sides, AND proven ON SCREEN with a genuinely divergent
  fixture row after the review's C-2 finding; the ordering matrix (weekStart-first,
  RATIFIED under this section's "or as SPEC-08 §5.3 rules" clause — within one
  round every selection shares one deadline, so a deadline cannot discriminate);
  the staff round surface with advisory variance (`role="alert"`, control stays
  enabled), I-13 at zero requests both halves, four request budgets both
  viewports; route-policy 125→128, all four-layer, driven over HTTP as a grantless
  member with the viewer refusal pinned at NO_CAPABILITY.
- **FU-23 CLOSED:** root read split from record read; three answers classified
  before any write — fresh / replay / `IDEMPOTENCY_KEY_REUSED` (a named 409) —
  proven over HTTP in both directions with "a bare CONFLICT is the 409 posing as a
  replay" as the surviving-defect assertion; per-subtype namespacing rejected on
  0021's D-7 (non-additive; one key meaning two commands).
- **FU-20's period-shrink half CLOSED, branch (b) by measurement:** migration 0025
  (additive; 0021–0024 md5-identical) — the period-side bounds guard covering
  `pending`/`approved`/`committed` and allocating weekly-capacity grants, with the
  five irremediable statuses EXCLUDED by name (no DELETE grant exists;
  `week_start` is outside the UPDATE grant; no outgoing §2 edge — an unconditional
  guard would have made periods permanently unshrinkable against inert debris);
  BOTH measurement premises are themselves asserted as tests so a later grant
  cannot silently invalidate the exclusion; ten populated-cycle cases including
  permitted-shrink and widening-never-blocked.
- **The §4 authorization finding — found by this packet's own deny-by-default
  test, cured on both class members:** a scheduler could withdraw a member's
  selection (and, verified by measurement before any fix, a member's request via
  M5-001's route — 200, row withdrawn, transcript 09 retained). The composition
  gap: L5.1 passes BY CONSTRUCTION on self-scoped surfaces (the acting membership
  is its own target) and RLS admits the write BY DESIGN (rows, never operations) —
  so the operation-layer ownership predicate is the only place §4's
  "requester-initiated only" can live, and it was absent. Cured with the verified
  context's own membershipId on both by-id own-scoped write routes; the class
  closed by ENUMERATION (exactly two members; context-probe correctly OUT — it
  names a real subject, so L5.1 genuinely decides it) with a structural test
  re-deriving the set from the route table (write verbs widened per C-4) so a
  third member meets the rule at declaration; owner paths AND the scheduler's
  legitimate deny door proven preserved; the false docblock sentence corrected
  with the measurement beside it; FAD-57's exposure-widening recorded unsoftened
  (the defect predates it; the population widened with it). Both cures replanted
  and re-proven independently at review.
- **Conditions:** C-1 the approved→withdrawn quota release shipped unexecuted
  (`unitReleased: true` produced nowhere in 2 508 tests) — discharged with three
  HTTP cases built on the REAL routes: exact-equality unit restoration, the
  audited-override both-counters case, and a DETERMINISTIC grant-version-conflict
  interleave (lock held by a second connection, the block polled on
  `pg_stat_activity`, release and withdrawal proven to roll back TOGETHER; the
  reviewer verified a spurious poll can only produce a loud failure, never a false
  pass — residual note: the unscoped poll is a false-RED risk on a busy cluster;
  scoping via `pg_blocking_pids()` is the recorded candidate). C-2 the on-screen
  R-15 e2e could not discriminate (the review planted the read-off-selection
  defect and the case PASSED — pair-consistent fixtures cannot separate the
  implementations because the derivation is total) — discharged with a divergent
  row mutation-proven 2-failed-then-clean at both viewports, and the false
  docblock sentence corrected to state the CLASS. C-3 `overrideReason` removed
  from the member projection (a silent reader widening; the summary schema is
  `.strict()` with the field ABSENT, not nulled — a future recorded decision can
  grant it deliberately). C-4 write-verb widening (mutation-proven on a planted
  DELETE route). C-7 the one literal root status now derived, with an explicit
  throw on the sole unmapped status. C-5/C-6 record corrections carried here.
- **Acceptance figures, FROM MEASUREMENT (both agents' independent runs agree;
  the implementation report's passed-vs-total label slips are superseded by this
  paragraph per C-5):** `pnpm check` 17/17 · unit **196 files / 2 511 tests total
  (2 497 passed + 14 skipped)** — round-0's 2 508 + exactly C-1's three cases ·
  axe **458 passed / 16 skipped**, both viewports, all four vacation budgets ·
  request-budget 48/95 · route-policy **128** · migration-rls **25** ·
  invariant-ids 22 · validators 36/36 · 95/95 · PASS · composed seeded run at seed
  **20260913** clean (160+1 files / 1 680+14 tests, engagement line proven) after
  two environmental kills and one recorded own-error — the three-attempt history
  stands in the INDEX · census **69** (no arm touched, verified path-by-path by
  both agents; every candidate fails conjunct 3, and the §4 predicate fails
  conjunct 1 OUTRIGHT — the finding itself proves only one layer can hold it) ·
  arm 68 isolated PROVEN by both agents.
- **Observations recorded, no action this packet:** the accepted-save e2e state is
  the one rendered state without its own axe sweep (→ M5-005's surface work); the
  R-01 selection-level illegal-edge refusal is argued from D-27 + 0021's guard
  composition rather than database-tested (→ M5-006's integration sweep).
- **Environment record:** the unit gate's own in-test red leg left
  `provider-boundary.ts` neutered in-tree, poisoning two runs before `git diff`
  found it (→ FU-30; `debris.mjs` structurally cannot see in-place mutations —
  the two-check discipline is the cover); two phantom vitest process trees
  observed re-parented to init (mechanism UNKNOWN, recorded not theorized —
  RISK-REGISTER); run 11's four failures stand as one observed non-reproducing
  occurrence, not attributed; `git checkout --` TRUNCATES intent-to-add files to
  empty (their index entry IS empty) — every added file in a patch-delivered
  packet is at risk; restore added files by `cp` + recorded md5 or from the
  patch's own addition hunk (the reviewer verified the one repair three
  independent ways); the implementer's declared own-errors (recursive chmod, 393
  modes; pgdata removed before its postmaster was killed; a waiter blinded by
  vitest renaming its process title) are in the INDEX with causes.

**Dated correction to §5d (2026-08-27, C-6):** §5d's line "`releaseGrantUnits`
currently has no production caller — only tests — because §5.6's reversal
transaction is M5-004's" was true when written; as of M5-003, J1's
approved→withdrawn quota release is its first production caller, and (per C-1) that
composed path is now proven by execution. The original §5d text stands unedited.

### 5g. M5-00C — FINALIZED 2026-08-27 (issues against `origin/main` at `f85510f`, the PR #12 merge)

**Scope: SPEC-08 §4's fifth row — comments — under the FAD-58 ruling below, which
resolves the M5-002 escalation.** The question list and working default were
recorded at M5-002 in `requests.route.ts`'s header; the packet implements the
ruling, never re-litigates it, and ESCALATES if §4's text cannot be satisfied
within it.

**FAD-58 (ruled 2026-08-27 under the delegated mandate; recorded in
ARCHITECTURE-DECISIONS at this finalization):**
1. **The requester-side channel is a CONTROLLED VOCABULARY, permanently — no
   requester-authored free text enters the system on the request aggregate.**
   I-07's sentence is not patient-scoped ("no patient-identifying information OR
   CLINICAL FREE TEXT"), and in this product the honest answer to "why that
   Friday?" is frequently a medical one; a length bound bounds size, not kind.
   The requester attaches at most one reason CODE per comment turn from a curated
   non-clinical vocabulary (I-17; the code list is a SCHEDULEPOINT-REQUIREMENT
   artifact in contracts, extensible only by decision; NO "other, specify" text
   field exists — "other" is a terminal code). One turn, one accepted code, one
   transaction (I-16).
2. **The scheduler-side channel joins the existing scheduler-authored
   administrative bounded-text class** (`change_summary` / `override_reason` /
   `approvals.reason` — the precedents the M5-002 header enumerates): bounded
   free text, author and instant recorded, on the request aggregate.
3. **The store is APPEND-ONLY by privilege** (the `approvals` pattern: GRANT
   SELECT, INSERT and nothing else — no edit, no delete, ever; correction is a
   new comment); organization-scoped RLS in the same migration; X-11-conformant
   keys under the narrowed exemption.
4. **Visibility is per capability with an explicit table in the packet**, derived
   from §4's own text and doc 08 §6 under narrower-never-wider: the packet writes
   the reader table (requester sees their own request's comments; deciders see
   the queue's) and proves each cell positively AND negatively over HTTP; any
   cell §4 does not force is ruled by escalation, not filled by convenience.
5. **No notification work** — comment events may enqueue nothing in this packet
   (I-11 posture untouched); any outbound surface is a later packet against
   SPEC-07.

**The packet:** migration (comments table per FAD-58.3); domain comment module
(vocabulary, bounds, append-only port); contracts (the code list as the
SCHEDULEPOINT-REQUIREMENT artifact, comment shapes); api service + routes
(four-layer policies; deny-by-default; the by-id-write ownership class rule from
M5-003's register entry applies to any by-id write this surface adds); the
visibility table proven per cell; audit event names per the M5-002 naming rule;
UI is OUT of scope (M5-005 owns surfaces — this packet is API/store only, so no
axe/budget deltas are expected). Bounds: reuse the house bounded-text validator
for the scheduler channel; the wire refuses any text field on the requester
channel STRUCTURALLY (`.strict()` with no such field), proven by a test that
posts one and reads the refusal.

**Constraints carried:** additive migrations only (0021–0025 untouched);
R-01 cross-product extends to any new operation in both layers; I-07 — the
scheduler text passes the same non-clinical posture the precedents carry, and
the audit/outbox payload closure (reason-closure pattern) is proven for comment
bodies (a comment body NEVER enters an audit payload, an outbox row, or a log —
rule 9); every store port takes the unit of work.

**Acceptance battery:** validators · `corepack pnpm check` 17/17 · red cases at
census 69 under the four-conjunct bar (reasoning written either way; isolated
`SP_RED_SHARD` proofs for changed/new arms only; sharded CI primary) · populated
cycle for the new migration (with the `-- Up Migration` marker) · one composed
seeded `api` run at a fresh seed with the invocation of record · CI green before
merge consideration. Delivery: worktree + patch from `f85510f`; fresh Opus
implementer; fresh Opus reviewer; delta by the reviewer; orchestrator lands on
the next PR. The §5e/§5f environment discipline binds in full (tree gate +
debris check; exact-`ps` waiters; `SP_SOLVER_WORKER_COMMAND` set for gate runs;
restore ADDED files by cp + recorded md5, never `git checkout --`).

**ACCEPTED 2026-08-27.** Fresh implementer; fresh reviewer; verdict **ACCEPT WITH
CONDITIONS** (round 1, C-1..C-4) → delta → reviewer CONFIRM upgrading to ACCEPT
with one carried correction (C-5) → round-2 single-sentence remedy → reviewer
micro-CONFIRM: **ACCEPT, unconditional**. Patch chain v1 `8b02d341` → v2
`42363652` → v3 **`4d56bd47c88946392ac08cc4f95fc658`** (landed), 19 files,
+4 333/−8, base `b246b97`; the orchestrator's applied tree regenerated the v3
md5 byte-identically before any record was written.

- **FAD-58 held at every layer, adversarially.** No text field on the requester
  channel at wire (`.strict()`; seven candidate field names each POSTed and each
  refused with `unrecognized_keys` naming the key, comment rows proven absent
  after every one), domain (both entry shapes refuse requester-with-prose), or
  database (no column a requester channel can write text into; the exactly-one-of
  rule is TWO CHECKs written in both directions). Nine codes identical across
  SQL / domain / wire; `other` TERMINAL (domain refuses `{requester, other,
  body}`); 14 clinical near-synonyms asserted absent at all three layers; body
  `length(btrim(body)) BETWEEN 1 AND 1000` measured at 1000/1001/whitespace;
  UPDATE and DELETE driven to `42501` in the populated cycle; comment bodies
  proven absent from audit payloads, outbox rows, and logs with a non-vacuous
  closure leg (all nine codes pass both closure predicates, then the emitted
  payload's keys are exactly `['channel','commentId','requestId']`).
- **The packet's strongest property was killed and revived at review.** The 0026
  administration arm's `WITH CHECK` pins `channel = 'scheduler'` AND the acting
  author; the reviewer's M1 mutation removed exactly the channel pin and the
  forged-attribution write was ADMITTED (`numAffectedRows: 1n`, the named forgery
  case failing); restored, refused. D-1 (comments are not a request operation)
  proven both-layers-independent: dropping the DB CHECK fails the cycle test
  alone, dropping the domain half fails the agreement test BY NAME alone.
- **Conditions:** C-1 the patch's only unintended byte change (contracts barrel
  trailing newline + stray blank line; prettier-exact restore; noted:
  `format:check` is not one of the 17 gates, which is why nothing caught it).
  C-2 the `listOwnComments` ownership predicate was UNDEFENDED BY TEST (the
  reviewer's mutation turned nothing red) — discharged with the
  scheduler-drives-the-own-thread-route case (404 on a colleague's request, 200
  on their own — also the visibility table's one previously unproven positive
  cell) plus two controls separating "refused" from "empty thread"; the
  implementer replanted the mutation and found a STRONGER signature than review
  measured: the mutated route disclosed the member's actual reason code
  (`"family"`) and the scheduler's note through the requester's own door — the
  disclosure the predicate exists to prevent, shown rather than described. C-3
  the ownership docblocks overstated (the service predicate is A control, not
  THE control: 0026's own-arm WITH CHECK independently refuses the same forged
  write and `withRequests` maps its 42501 to the IDENTICAL 404 — X-11 design,
  not coincidence; killing the property took removing both layers). C-4 the
  `NewRequestComment` docblock claimed a discriminated-union guarantee the flat
  interface does not provide (the reviewer compiled the illegal shape under
  `tsc --strict`, exit 0) — corrected in place, the guarantee relocated to
  `CommentContent` and the three live layers, no type re-shaping (sole caller is
  the private `append()`). C-5 (found at delta CONFIRM) the C-3 remedy's added
  route-policy sentence named the WRONG arm — the neighbours' own-arms DO re-ask
  ownership in both clauses; the real mechanism is the ADMINISTRATION arms
  (0023:650/863, zero ownership predicates, permissive-OR combination means the
  own-arm's question is never reached for a `requests.administer` holder), and
  `request_comments` differs because ITS administration arm pins the channel —
  corrected after the implementer re-read 0023 itself, every citation re-checked
  by the reviewer against the SQL, the four policies quoted into the INDEX.
- **Acceptance figures, FROM MEASUREMENT (implementer and reviewer ran the full
  battery independently on the round-1 tree; both agree):** `pnpm check` 17/17 ·
  unit **200 files (199 + 1 skipped) / 2 562 tests (2 548 + 14 skipped)** — the
  base's 196/2 511 plus exactly the four new files' 51 tests, decomposed · axe
  458 passed / 16 skipped (API-only packet; no axe delta) · route-policy **131**
  (128 + 3) · migration-rls **26** · invariant-ids 22 · request-budget 48/95 ·
  validators 36/36 · 95/95 · PASS · census **69**, and the 41 registry mutation
  targets ∩ the 19 changed paths = **EMPTY** (measured independently by both
  agents from `run.mjs` read as text) — every census candidate fails conjunct 3
  (this packet's falsifiers RUN: four were killed by mutation at review), and
  the ownership predicate fails conjunct 1 outright · SBX floor 65→**66**, one
  row per channel through the two different RLS arms. The delta rounds re-ran
  what they touched (typecheck, lint, both changed test files 26/26 + 15/15,
  prettier) with v2→v3 confinement proven by tree comparison; the full battery
  was NOT re-run for v2/v3 (stated, not silent: 18 of 19 files byte-identical
  across the chain, 0026 unmoved since v1); the v3 whole-suite figure (2 563
  expected) is CI-on-PR-#13's to measure as the primary form.
- **Seeded composed runs (invocation of record, two-attempt cap honored):** seed
  20260920 → 3 failures, seed 20260921 → 4 failures, ALL in M5-003's
  `vacation-selection-http.test.ts` — and BOTH replicated BYTE-IDENTICALLY on
  the unmodified base tree (same seeds, same flags): a pre-existing
  order-dependence, not this packet's content (→ FU-32; the base-tree
  replication is the gold standard for "pre-existing, not mine," superseding
  diff-doesn't-name-the-file arguments). The packet's own six files: ZERO
  failures under both permutations. Attempt 2 also crossed NR-23's growth
  ceiling once at the R-03/R-12 drain precondition (198 jobs, the 45 s floor
  exceeded) — ruled the first observed crossing CANDIDATE, dated rider on NR-23;
  no third run (the nightly 13-seed matrix is the systematic series).
- **FU-06's first live production catch:** the round-1 interim check ran 16/17
  with the tree-hygiene gate failing on exactly the four new untracked test
  files — cured by its own named remedy (`git add -N`), then 17/17. The gate
  caught real drift in production use for the first time since it landed at M5-H.
- **Observations recorded, no action this packet:** the `python .egg-info`
  build debris is not in `.gitignore` (a bare `git add -N .` will intent-add
  it; excluded by hand twice this packet); the channel domain's CHECK is
  policy-shadowed on the write path (RLS refuses first — the CHECK is the
  BYPASSRLS/second-driver layer, 42501-asserted with the loosened-arm
  justification and FAD-15 positive controls on both legal shapes); group-scoped
  reads answer 404 before the capability layer for an org-admin (measured truth
  of the fixture's ORGANIZATION membership, asserted with the measured-not-
  designed paragraph — NOT a weakening: the `NO_CAPABILITY` identity is kept for
  the three roles that reach the capability layer).
- **Environment record:** clean run — zero kills, zero pauses, tree gate 0/0/0
  at every arm, `debris.mjs` PASS throughout, FU-30 in-place sweep clean at
  every mutation, all restores by `cp` + recorded md5 (never `git checkout --`),
  both throwaway interdiff worktrees removed. The reviewer's round-1 unit gate
  ran 2 025 588 ms and axe 865 719 ms on the shared box without incident.

**Ports-registry observation promoted at this landing (→ FU-31):** the packet's
store port joins `RequestStore` and `VacationStore` in being absent from
`packages/domain/src/ports/index.ts` — a registry gap standing since M5-001,
now three surfaces wide. Registered rather than fixed here: the barrel is a
shared control and the M5-H precedent routes shared-control changes through
their own packet.

### 5h. M5-004 — FINALIZED 2026-08-27 (issues against `origin/main` at `6769319`, the PR #13 merge)

**Scope: SPEC-08 §5.6 commit and reversal, the §6 solver projection, and their
integration with the M4 build pipeline.** The two questions this packet has owed
since M5-000b/M5-001 are ruled here (FAD-59, FAD-60, both recorded in
ARCHITECTURE-DECISIONS at this finalization); the packet implements the rulings,
never re-litigates them, and ESCALATES if SPEC-08's text cannot be satisfied
within them. API/store/solver-input only — UI surfaces (including the graduated
confirmation SURFACE) are M5-005's; this packet ships reversal's API half: the
override capability, the mandatory reason, and the named refusal without both.

**FAD-59 (the D-23 enforcing shape — answers M5-000b finding (2), "D-23 is
vacuous as spelled"):** commit idempotency is enforced by a COMMIT-COMMAND
LEDGER, the D-26/R-17 recorded-outcome pattern lifted from approvals to the
version level. A new migration (0027) adds the ledger table: one row per commit
command — organization, period, target DRAFT version, acting membership,
instant, outcome — UNIQUE on `(organization_id, idempotency_key)`, append-only
by privilege (GRANT SELECT, INSERT and nothing else; the
`approvals`/`request_comments` pattern), organization-scoped RLS in the same
migration, X-11-conformant keys. The ledger row, the OFF assignment snapshots,
and the selection updates commit in ONE transaction; a replayed command key
returns the recorded outcome (R-12) and writes nothing. The per-selection half
of D-23 is the §5.3 matrix itself: `approved → committed` is the only edge that
writes `committed_to_version_id` (double-enforced per R-01, so a second commit
of a committed selection is an illegal transition in BOTH layers), plus a CHECK
making `(status = 'committed') = (committed_to_version_id IS NOT NULL)` — the
`vacation_selections.request_id` CHECK precedent. D-23's original spelled form
stays in SPEC-08 unedited; 0027's header records this FAD as the enforcing
shape, superseding the in-migration honesty statement that the spelled form
enforces nothing.

**FAD-60 (the preference-strength→weight mapping — answers the M5-000b
declared-latitude note, "a real decision, not an identity"):** the projection
NEVER routes `REQUEST_PREFERENCE_STRENGTHS` (`low|medium|high`, unsigned — a
request states a preference FOR its named shift type) through the rules AST's
four-value SIGNED vocabulary (`strong_prefer|prefer|avoid|strong_avoid`,
`packages/domain/src/rules/ast.ts:33`): three unsigned values onto a two-value
positive arm is lossy, and the avoid arm is UNREACHABLE from a request by
construction — a mapping that could express it would manufacture a hostile
preference no one stated. Instead §6's `SoftPreference` row carries the
request's own three-value strength VERBATIM, and the solver-side objective maps
it by a TOTAL, STRICTLY MONOTONE, positive weight table recorded in the
projection module's header and pinned by test (totality over the closed set;
strict ordering low < medium < high; positivity). The exact weight values are
declared latitude for the implementer AGAINST doc 08's objective-term structure
(verify against the file, never from this text — the FU-28 rule); the
monotonicity and unreachability-of-avoid properties are NOT latitude.

**The packet:**
- **Commit (§5.6, doc 09 §2.3 — "the most consequential operation in this
  domain"):** in one transaction against a DRAFT version (SPEC-05; committing
  to a published version is refused by name — I-18, rule 5): create the OFF
  assignment snapshots, mark selections `committed` with
  `committed_to_version_id`, write the FAD-59 ledger row, audit, enqueue outbox
  events (I-11: a notification failure never rolls back the commit; SPEC-07
  payload closure — no reason text in any payload). Quota accounting is
  UNTOUCHED by commit (consumption happened at approval; M5-002's).
  Re-validation at commit per I-19: selection still `approved`, version still
  draft, period/mode state admits commitment — the request-until gate's
  commit-side reading is derived from SPEC-08 §3 + doc 09 §2.3 at
  implementation; if those texts do not force a reading, ESCALATE, never
  assume.
- **Reversal (§5.6):** `committed → reversed`, override capability + mandatory
  bounded reason (the administrative bounded-text class; kept out of audit
  payloads/outbox/logs per I-07 rule 9), decrements `units_consumed` — and
  `override_units` TOGETHER when reversing an override (R-20's write path;
  M5-000b's proof carries) — respecting the floor (R-08), marks the selection
  `reversed`, and RAISES A REVISION REQUEST against the schedule rather than
  editing any published version (I-18; rule 5). Reversal's quota release
  composes with `releaseGrantUnits` (first production caller was M5-003's J1
  per the §5d dated correction; this packet adds the reversal caller). Open
  mode: no grant row, release is a no-op by the same mode branch as §5.4.
- **Commit and reverse are REQUEST OPERATIONS** (status-moving — unlike
  M5-00C's comments, by D-1's own criterion): they join `REQUEST_OPERATIONS`
  and the R-01 cross-product in BOTH layers, with the by-name pin and
  agreement tests extended and the D-1 byte-identical-root proof updated.
- **The §6 solver projection:** the four projection rows built EXACTLY per the
  amended table (`reflected_in_version` INCLUDED per V-31; committed vacation
  in `HardOff`), the exhaustive never-enters list asserted status-by-status
  against §2's full set, `SoftPreference` per FAD-60, and the projection
  emitted into the pinned `solver_inputs` snapshot (M4's pipeline — the solver
  reads the projection, never the raw tables). R-14: on a REBUILD of the same
  period, a time-off request already honoured in a published version is still
  `HardOff` — proven with a real build-pipeline rebuild, not a unit stub.
- **Routes + policies:** commit, reverse (and any read this surface forces)
  under four-layer policies, deny-by-default, CAP-023 traceability; these are
  scheduler/administrative operations — NOT own-scoped; the by-id-write
  structural test still re-derives its set from the route table.

**Constraints carried:** additive migrations only (0021–0026 untouched);
0027's populated cycle with the `-- Up Migration` marker; every store port
takes the unit of work; no capability baseline change; audit event names per
the M5-002 naming rule; reason bodies never in audit payloads, outbox rows, or
logs; the §5e/§5f/§5g environment discipline binds in full (tree gate + debris
+ FU-30 in-place sweep; restore ADDED files by cp + recorded md5;
`SP_SOLVER_WORKER_COMMAND` set for every gate run; solver venv provisioned
before any solver-touching leg — the M5-000b lesson: solver tests do NOT
self-skip).

**Acceptance battery:** the standing battery (§6 below) · the SPEC-08 §7 rows
this packet owns: R-12 (replayed commit, one commit, recorded outcome), R-14
(the rebuild HardOff invariant on a real rebuild), R-08/R-20 on the reversal
path, R-10's composition where reversal raises the revision request · the
projection's never-enters list proven exhaustively · red cases at census 69+
under the four-conjunct bar (reasoning written either way; the FAD-59 ledger's
append-only privilege and the published-version commit refusal are candidate
arms — argue them against the bar, do not assume) · one composed seeded `api`
run at a fresh seed with the invocation of record (two-attempt cap; base-tree
replication for any pre-existing failure; FU-32's file is KNOWN
order-dependent — a failure there replicates on base by expectation: verify
and cite, do not re-diagnose) · CI 15/15 before merge. Delivery: worktree +
patch from `6769319`; fresh Opus implementer; fresh Opus reviewer; delta by
the reviewer; orchestrator lands on PR #14.

**ACCEPTED 2026-08-31.** Fresh implementer (the run SUSPENDED mid-packet by the
account's weekly usage limit 2026-08-27→31 — its full 17-gate check had already
passed; the in-flight work was preserved durably on
`claude/m5004-wip-preserve-a4ns2p`/PR #15 and the resumed tree regenerated the
preservation md5 byte-identically after 3.5 days); fresh reviewer; verdict
**ACCEPT WITH CONDITIONS** (round 1, C1..C7) → delta discharging six (C5 is
discharged by this record, below) → reviewer delta CONFIRM replanting its own
three mutations: **ACCEPT, unconditional**. Patch chain v1 `cfee3351` → v2
**`a28cc640dc2d73e5f084a92f06c21522`** (landed), 40 files +6 296/−52, base
`6769319`; the orchestrator's applied tree regenerated the v2 md5
byte-identically before any record was written.

- **The two rulings held at every layer.** FAD-59: the ledger's
  single-INSERT-at-end shape (forced by reading "GRANT SELECT, INSERT and
  nothing else" strictly — 0022's write-then-UPDATE sibling is foreclosed),
  UNIQUE-as-race-control with `COMMIT_RACE_LOST` converging invisibly
  (retry-once, absent from the wire enum), R-12 replay returning the recorded
  outcome writing nothing, and the per-selection CHECK — after C3, defended by
  a falsifier that discriminates THREE ways (FAD-59's constraint vs 0022's
  CHECK vs D-27's trigger: under the one-arm mutation the row sails to commit
  and D-27 fires). FAD-60: `low|medium|high` verbatim in the snapshot; the
  1/2/4 table's totality, strict monotonicity, and positivity each
  INDEPENDENTLY pinned (the reviewer's 1/2/2 mutation reddens exactly the
  strict-ordering case by name); the CP-SAT term correctly NOT built (→ FU-33).
- **The escalation chain, all three ruled mid-flight:** (1) HardOff had to be
  CONSUMED or R-14 was unprovable — measured first (the model's grid is
  date-independent; nothing named availability existed; fixedAssignments only
  pin and there is NO per-membership-per-date exclusivity constraint in
  `build()` — that last finding is register-grade on its own); the two
  authorized `model.py` edits touch no objective/tier/weight/digest, proven by
  the worker's own echoed digest equal on empty and populated solves. (2)
  §5.6's "raises a revision request" collides with 0023's guard
  (`app_guard_request_revision_requested` admits the flag only on
  `reflected_in_version → withdrawn` — FAD-55's exclusion from the other
  side); ruled option (a): the reversal raises the same audit + outbox events
  as M5-001's withdrawal and writes NO flag; the column-vs-event
  non-uniformity is owned in the header and routed forward (→ FU-35). (3) **A
  widened CHECK domain is a one-way door** — the first down migration restored
  0009's four-value origin CHECK byte-for-byte and THREW over live
  `vacation_commit` rows, half-reversing the chain (18 files down); ruled
  option (A): the down leaves the domain widened and says so with the measured
  error quoted, the three outcomes enumerated (fail / delete rows a published
  version may carry, I-18-forbidden / `NOT VALID`, which restores the name and
  not the state), and the cycle asserting the WIDENED definition via
  `pg_get_constraintdef`. The class rule is in the RISK-REGISTER: every future
  domain-widening migration states its reversibility at authoring time.
- **The read plane (FAD-61, recorded at this landing):** seven additive
  SELECT-only purpose-token arms (0012 §5's mechanism, a distinct token) so
  the build assembly can see the absences §6 projects — without it a builder
  lacking `requests.read_any` would project only their OWN absences and the
  solver would schedule everyone else onto their approved days off with §6
  silent. After C1 it is defended by THREE falsifiers catching different
  mutations: sibling IDENTITY (one distinct normalised qual, all seven printed
  on failure), the shared predicate clause-by-clause with the group EQUALITY
  quoted (catches a wholesale drop identity would accept), and a behavioural
  cross-group case whose failure signature IS the leak (`expected 1 to be +0`
  — a group-two row read from group one under the token). The token half was
  proven defended in round 1 (weakening it fails "is CLOSED without the
  token" by name); the reviewer's round-1 group_id-drop mutation had survived
  the ENTIRE 205-file gate — found before it shipped.
- **Conditions:** C1/C2/C3 above (each MEDIUM, each cured with the mutation
  re-killed and restored byte-exact). C2's remedy is the REVIEWER'S
  construction after its argument superseded the orchestrator's steer
  (demand-forcing provably collapses into the INFEASIBLE case because the
  trees differ exactly by the person's cells; the objective route — the only
  reachable slot plus a rules-side SOFT reward — makes detection structural:
  1-of-3 became 3-of-3 both directions). C4: the `is_override` overload on
  reversal (forced by 0022's frozen equality) owned at both sites; separation
  is a future recorded decision (→ FU-36). C6: 0027's header renumbered — and
  the renumbering caught the header's own false "six tables" count (seven
  CREATE POLICY lines; the file disagreed with its opening paragraph);
  corrected, SQL proven untouched by comment-stripped diff. C7: CENSUS.md
  corrected — 40 changed paths, not 38; candidate D fails conjunct 3 OUTRIGHT
  (the STANDING falsifier is `request-projection.test.ts`'s R-14 worker cases
  themselves, run on every unit gate; the manual mutation was the
  demonstration of their teeth, a different and lesser thing). **C5,
  discharged here per the M5-003 precedent — the implementation report's
  attempt-1 line is superseded by this sentence:** attempt 1 reached its full
  gate table at 13 passed / 4 failed with FIVE typecheck diagnostics, one in
  PRODUCTION source (`vacation-commit.ts` TS2322 on the origin union), plus a
  lint and an axe failure; the INDEX rows were accurate throughout, the
  report's one-line summary was not.
- **Arm 70 RULED: not added; census stays 69.** The reviewer's re-derivation
  adopted in full at C7. The genuine residual — the R-14 cases bind the
  REPO'S `model.py` through the venv substitution while the deployed worker
  is a separately built image — is FAD-7's existing obligation, not an arm's.
- **Acceptance figures, FROM MEASUREMENT (implementer's final check + the
  reviewer's independent two-run table, cause named — the reviewer's run-1
  unit FAIL was its own FU-06 catch, the gate's SECOND live production catch
  and the first against a REVIEWER'S setup):** check **17/17** (implementer,
  final tree) · unit v2 **205 files (204+1 skipped) / 2 614 tests (2 600 + 14
  skipped)** — the reviewer's own full-gate re-run after the delta, the +1
  reconciling exactly (the 0027 cycle 12→13) · route-policy **133** ·
  migration-rls **27** · axe 458 · request-budget 48/95 · import-boundary
  283/796 · validators 36/36 · 95/95 · PASS · census **69** (intersection
  NON-empty for the first time: 3 files / 8 sites / 7 arms — all seven arms
  PROVEN in isolation, arms 8 and 57 re-proven by the reviewer) · sweep floor
  **67** (the thirteenth table seeded through the administration arm, no
  privilege invented) · the reviewer's composed seeded run at **20260902** on
  the final tree: both cured files GREEN, one failure total in FU-32's file,
  cited · the implementer's two pre-cure seeded attempts (20260831,
  20260901) each found a FRESH INSTANCE of FU-32's class in the packet's OWN
  new files — both cured own-fixture-per-case and falsified across three
  permutations both directions (the second at 3-of-3-red pre-cure), the
  discipline working as designed · one observed, non-reproducing R-05
  occurrence recorded NOT ATTRIBUTED (passes 14/14 in isolation; no
  approval-path file in the diff; mechanism named as plausible only; →
  RISK-REGISTER watch item).
- **Environment record:** the six-attempt check history retained with causes
  (an orphaned postmaster + vite preview from a killed attempt; the one-way
  door; the vacuous-probe sweep floor); the pgrep self-match trap's FIFTH
  instance; the pause-debris class's FIFTH sighting (first across a multi-day
  pause — `/tmp/claude-0` reverted to 700); a SIGTERMed red-case arm whose
  restore HELD (the FU-25/FU-30 counter-datum); NR-23 measured again at
  **210.92 vs 20.83 ms** per probe pass (10×, ceiling scaled to cap, storm
  green); and a NEW standing rule from the reviewer's own false negative: **a
  `packages/domain` source mutation is invisible until `tsc -b` rebuilds —
  verify against the dist, never against a green.**

### 5i. M5-F32 — FINALIZED 2026-08-31 (corrective packet; issues against `origin/main` at `b599a7a`, the PR #14 merge)

**Scope: cure FU-32 — the order dependence in
`apps/api/test/requests/vacation-selection-http.test.ts` — and nothing else.**
One file, test-only, no production line moves. The nightly fixture-regression
matrix has been UNIFORMLY red on this defect since the M5-00C merge (runs 3–7,
all 14 seed jobs, one test at line 1036; three further seeds at M5-004) and is
BLIND as a regression monitor until this lands — which is why this packet
precedes M5-005.

**The remedy is the register's own, proven live twice at M5-004:**
own-fixture-per-case (the R-13/T-15 pattern) — every case creates every
request, selection, and round it asserts about; every assertion scoped to its
OWN subject, never to a whole-membership list or a shared setup row; shared
mutable fixture state across `it()` blocks eliminated. NOTHING WEAKENED (rule
10): the same behavioural assertions survive — same refusals by name, same
positive controls — restructured, not reduced; the reviewer verifies by
assertion-multiset diff (the M5-004 method).

**Acceptance battery (targeted — the corrective-packet form):**
1. The file green under `--sequence.shuffle.tests` at the KNOWN-failing shuffle
   orders AND three fresh seeds of the implementer's choosing, with the shuffle
   proven non-vacuous (executed-order diff, the M5-004 reviewer's method).
2. THE DECISIVE PROOF: one composed seeded `api` run (invocation of record) at
   a seed the nightly matrix has FAILED (e.g. seed 1 or 42) — the file green
   inside the composed run that used to redden it. Pre-cure red / cured green
   at the same seed is the both-directions form if the run budget allows two;
   the cured-green run is the minimum.
3. `gate:typecheck` + `gate:lint` + the file single-file green · tree gate ·
   debris · FU-30 sweep. Full `pnpm check` NOT required locally (one test
   file; CI on the PR is the primary form).
4. Census untouched (no arm, no mutation-target file); state the empty
   intersection in one line.
Delivery: worktree + patch from `b599a7a`; fresh Opus implementer; fresh Opus
reviewer (a LIGHT review — the falsification re-run at its own seeds + the
assertion-multiset diff + record honesty); delta if conditions; orchestrator
lands on the next PR. Closing FU-32 requires citing the first ALL-GREEN
nightly after the merge — the row stays OPEN until that run is read.

**ACCEPTED 2026-09-01.** Fresh implementer; fresh light reviewer; verdict
**CONFIRM/ACCEPT, no conditions** — every measured claim reproduced in the
reviewer's own worktree, the nothing-weakened check run one level STRICTER
than asked (whole-assertion-statement multiset: +4 identical 201 positive
controls, 2 pure subject renames, ZERO removals). Patch md5
`331d116aa421e6cb64093125710c0f50`, 1 file +232/−71, base `b599a7a`.
- **Falsification:** pre-cure RED at ten implementer seeds + three fresh
  reviewer seeds (seed 1 reproducing the nightly's exact line-1036 single
  signature; one fresh seed passing by luck, noted not forced); cured 19/19
  GREEN at every seed on both the as-run and delivered bytes; canonical order
  green on BOTH trees — the honest reason `pnpm check` never saw the defect
  and the nightly always did. Non-vacuity in the strong form: at every seed
  the executed order is BYTE-IDENTICAL pre-cure vs cured — the red→green IS
  the cure.
- **The decisive proof:** one composed seeded run at seed 1 (the nightly's
  own first fixed seed) on the cured tree — 168+1 files / 1 786 tests, ZERO
  failures, the target file green inside it (19 tests), M5-004's two cured
  files green beside it; adjudicated at review from the transcript with
  independent totals, zero-×-marker, and duration-arithmetic checks.
- **Register-grade finding (independently reproduced at review):** the five
  historical seeds reproduce FU-32's recorded COMPOSED-run failure counts
  EXACTLY in ~12-second SINGLE-FILE shuffled runs — within-file order alone
  is the mechanism, and a single-file `--sequence.shuffle.tests` run is the
  cheap replay key for this defect class.
- **One process incident, closed not argued:** a docblock-only edit during
  the live composed run, caught in the same tool round, the gap closed on the
  BYTES (TypeScript-parser comment-only proof with positive and negative
  controls; every leg re-run on the delivered bytes; the transcript's own
  per-file durations placing the target file ~14 minutes after the revert).
- **Environment record additions:** the single-file filter is the
  API-project-relative path; a fresh worktree needs `tsc -b` before any api
  test (the dist rule's other face); and `chmod 777 apps/api` is a
  prerequisite whose ABSENCE surfaces as a FALSE "STALE CLUSTER?" diagnostic
  (a permission bit masquerading as an orphan).
- FU-32 stays OPEN pending the first ALL-GREEN nightly after the merge, per
  this packet's own text.

### 5j. M5-005 — FINALIZED 2026-09-01 (issues against `origin/main` at `59f2659`, the PR #16 merge)

**Scope: the request/vacation UX and the contacts directory — the M5 surfaces'
UI half, per pre-declaration row 5.** Everything below rides on shipped API
surfaces (M5-001..004, M5-00C); this packet adds NO route, NO migration, NO
capability key, NO domain change — `apps/web` + e2e/axe/request-budget
coverage only. Any gap that seems to need an API change is an ESCALATION, not
an addition.

**The packet:**
- **Staff request UI + status history:** submit (the five subtypes + vacation
  selection through the M5-003 round surface), withdraw, and a status-history
  view derived from what the shipped read routes already return. I-13 binds
  every affordance: no control labelled Add/New/Create persists ANYTHING
  before a completed form, validation, and an explicit Save. I-10: one user
  action, one request — recorded in the request-budget registry per surface.
- **The comments affordance (M5-00C's):** the requester side is the
  controlled vocabulary EXACTLY — a code picker over the nine codes, `other`
  terminal with NO companion text input (rendering one would be FAD-58's
  free-text channel under another name — I-17); the scheduler side is bounded
  text with the shipped 1..1000 bound surfaced honestly. Per-capability
  visibility per the ratified table; nothing widened.
- **Scheduler approval surfaces:** the pending-review queue (M5-002's read
  routes), approve/deny (single + batch with per-item outcomes), the vacation
  approval with the D-21/D-26 semantics surfaced (idempotent, named
  refusals), and the M5-004 commit/reverse surfaces — REVERSAL CARRIES THE
  GRADUATED CONFIRMATION this packet owes (§5h routed it here): an explicit
  two-step confirm naming the consequence (units restored, revision request
  raised, snapshots retained) with the mandatory reason field, never a
  one-click destructive act.
- **Contacts directory (CAP-042):** minimised PII per I-07's posture — names
  and work-contact fields the schema already holds, NO clinical free text, no
  new PII field without a recorded decision; synthetic fixtures only.
- **Coverage:** axe on EVERY new rendered state at both viewports (I-12 /
  SP-HR-3..6) — including the M5-003 observation this packet owes: the
  ACCEPTED-SAVE state gets its own axe sweep; request-budget recordings for
  every interaction (I-10); e2e over the real stack for the primary flows.
- **FU-35 trigger rule:** if any surface here displays "outstanding revision
  requests", THIS packet is FU-35's consumer and must bring the question to
  the orchestrator for the recorded ruling (read-side union vs guard
  widening) BEFORE building it; if no surface needs it, say so and FU-35
  stays routed to M5-006.

**Constraints carried:** the client talks to NO third party (CAP-068/T-23,
allowlist empty — unconditional); layering (`apps/web` imports contracts
only); no weakened axe or architecture test (rule 10); terminology per the
glossary — the ten schedule concepts stay distinct; I-16 on any picklist
turn; the §5e..§5i environment discipline binds (tree gate, debris, FU-30
sweep, cp-restores, SP_SOLVER_WORKER_COMMAND for gate runs, `tsc -b` before
api tests in a fresh worktree, chmod cautions incl. the false-STALE-CLUSTER
diagnostic, the single-file replay key for any order-dependence).

**Acceptance battery:** the standing battery (§6) · axe with the new states
enumerated and counted (the 458 baseline grows; quote the delta and attribute
it per state) · request-budget with the new recordings enumerated (48 grows;
same discipline) · e2e primary flows both viewports · red cases at census 69
under the four-conjunct bar (argue, don't assume — UI packets rarely add
arms) · one composed seeded `api` run at a fresh seed (the matrix is
unblinded; a red here is a FINDING now, not a citation — FU-32 is cured) ·
CI 15/15. Delivery: worktree + patch from `59f2659`; fresh Opus implementer;
fresh Opus reviewer; delta; orchestrator lands on the next PR.

**Dated amendment 2026-09-01 (ruled at the implementer's pre-build
escalation, which measured three scope bullets undrivable from shipped
reads — the original text's "fields the schema already holds" and "riding
shipped read routes" were the finalization's errors, corrected here):**
1. **The contacts directory is DROPPED from this packet and RE-ROUTED, not
   narrowed:** zero contact columns exist across all 27 migrations, and doc
   11 §8 + PO-DEC-20 make inclusion and field-level minimisation SERVER
   obligations a UI cannot carry. CAP-042 keeps its baseline seat and gets
   its own packet — **M5-00D (contacts: the PII-field FAD + migration + read
   route + minimisation-per-role)** — sequenced before M5-006 closes the
   milestone. Sequencing, never deletion.
2. **One additive read route is AUTHORISED into this packet** — exposing
   `readVacationRound`'s existing, review-proven `'period'` scope (the
   scheduler's view; today its only caller passes `'own'`) so the scheduler
   vacation-approval surface and the §5h-routed graduated-confirmation
   reversal are drivable. Conditions: four-layer policy on the EXISTING key
   doc 08 §6 forces (proposed at interim, ratified by the orchestrator
   before registration); the projection carries selectionId,
   selectionVersion, status, weekStart, membershipId, is_override and
   NOTHING wider (no reason codes, no comments, no override_reason);
   route-policy 133→134; deny-by-default and both HTTP directions proven
   (FU-29); census argued.
3. **FU-35 ruling:** this packet is NOT the consumer — per-request
   `revisionRequested` renders on the five non-vacation subtypes only
   (where 0023's guard gives the flag its one meaning), never on vacation
   rows (a structural false negative), and consequence-copy in the reversal
   confirmation is not a query. FU-35 stays routed to M5-006.
4. **Recorded observation:** the pending queue built on shipped reads names
   nobody (membershipId UUIDs only) — rendered honestly, no invented names,
   no reach into another surface's roster; M5-00D is the cure and the UX
   cost is priced here, not overlooked.
5. **(Added same day, gap 4)** The submit FORMS for the two
   catalogue-dependent subtypes (shift-preference, shift-group-off) are
   SEQUENCED OUT to M5-00D: their record schemas require shiftTypeId /
   shiftGroupId, and no member-readable vocabulary route exists (the
   catalogue reads are gated on the WRITE key `schedule.catalogue.administer`
   — widening it to member would be a write implying a read, FAD-25-refused;
   the eligibility read is grant-only). M5-00D's scope grows accordingly to
   "member-facing directory and vocabulary reads": the contacts directory
   (CAP-042) AND a member catalogue vocabulary read (shift types + shift
   groups where `allow_request` is true, ids and names only), each with its
   key decision as a doc-08-§6-grounded FAD — the M5-001 precedent governs
   (a capability key is never invented inline). UI sequencing, not a
   capability drop: both subtypes' SUBMIT capability is API-real since
   M5-001; the forms are prop-pluggable and land with the vocabulary read.
   The three date-only subtypes (availability, time-off, no-call) ship their
   forms in this packet. Also recorded for M5-00D: the only member-readable
   shift-type identities today are INCIDENTAL (published-schedule entries),
   and deriving a picker from them would quietly redefine what a member may
   prefer — the reason the vocabulary read exists.
6. **(Ratified at interim 1)** The amended route's key is
   `requests.read_any` via the existing scheduler-read config verbatim —
   0023's `vacation_selections_group_read_any` arm already names the same
   key, so route policy and row predicate agree by design; the route landed
   NARROWER than authorised (zero new contract: the member's own
   `vacationRoundSchema` over the period-wide row set, C-3's exclusions
   structural).
7. **(Ruled at delivery, 2026-09-01)** The acceptance line "e2e primary
   flows both viewports" is met by the delivered interception-based specs
   (98 cases, the directory's uniform convention) **except for its
   real-stack extension, which the implementer handed back short
   explicitly** — `real-stack.config.ts` was not extended to the three new
   surfaces, while the new route and the ridden server behaviour ARE
   real-stack proven. Ruling: the real-stack extension of the three
   primary flows is ROUTED to M5-006's integration sweep as **FU-37**
   (doc 40), blocking M5 exit. Nothing subtracted, nothing weakened; the
   packet's remaining acceptance stands unamended and the reviewer
   verifies against this settled bar.

## 6. Standing acceptance battery (every packet, per 24 §G and the M4 form)

Validators (36/36 · 95/95 · research PASS) · `corepack pnpm check` 17/17 · the full
red-case battery at the current census · targeted fixture-regression where the packet
touches suite composition · migration schema cycle + a populated cycle for every new
migration · SBX arms named per packet · CI green on the packet's PR before merge.
NR-22's rule binds every executor: reproduce by pinning the observed precondition,
never by re-running a seed and expecting the same order (until FU-01 lands and seed-N
becomes a true replay key — after M5-000, seed replay is admissible again and the
fixture-regression docblock is updated by that packet).
