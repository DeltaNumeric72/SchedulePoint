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

| 2 | **M5-002 — approvals** | Individual + batch approval/denial/comments (§4); over-quota advisory + audited override (R-06/R-07); D-21 last-unit race (R-05); reversal floor (R-08); quota CHECK integrity (R-20/R-21); approval idempotency (R-17/R-18/R-19) | M5-001 |
| H | **M5-H — hygiene batch** | FU-06/07/08/13 (+FU-04 if not yet touched) | after M5-002, issues alone |
| 3 | **M5-003 — vacation** | Grants/selections + quota vs open modes (§5, R-13, R-16); §5.3 status-mapping invariant (R-15); variance display; selection UX | M5-001 |
| 4 | **M5-004 — commit/reverse + solver projection** | Vacation commit to a NEW schedule version, idempotent (R-12) and reversible with graduated confirmation; request-until gating; the §6 solver projection incl. the rebuild HardOff invariant (R-14); integration with the M4 build pipeline | M5-002 + M5-003 |
| 5 | **M5-005 — request/vacation UX + contacts** | Staff request UIs + status history; scheduler approval surfaces; contacts directory (CAP-042, minimised PII — I-07 posture, no clinical free text); axe + request-budget coverage for every new surface (I-12, I-13, I-10) | M5-004 |
| 6 | **M5-006 — integration, SBX, close** | Composed integration + concurrency/recovery arms; SBX-010/011/012/013; QA-REQ battery; fixture-regression on the close candidate; the M5 exit report | all |

Ten-ish packets was M4's real count including correctives; the same allowance stands —
correctives get their own serial packets, never squeezed into a neighbour's scope.

## 6. Standing acceptance battery (every packet, per 24 §G and the M4 form)

Validators (36/36 · 95/95 · research PASS) · `corepack pnpm check` 17/17 · the full
red-case battery at the current census · targeted fixture-regression where the packet
touches suite composition · migration schema cycle + a populated cycle for every new
migration · SBX arms named per packet · CI green on the packet's PR before merge.
NR-22's rule binds every executor: reproduce by pinning the observed precondition,
never by re-running a seed and expecting the same order (until FU-01 lands and seed-N
becomes a true replay key — after M5-000, seed replay is admissible again and the
fixture-regression docblock is updated by that packet).
