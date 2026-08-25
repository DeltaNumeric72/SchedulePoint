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
| 1 | **M5-001 — request lifecycle core** | Subtype transition matrices (§2) domain+DB double enforcement; deadlines/expiry (§3, R-09, R-23); idempotent submission (R-11); withdrawal incl. accepted_as_input/consumed_by_build boundaries (R-22) and post-reflection revision requests (R-10); routes + policies (I-02, four-layer) | M5-000 |
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
