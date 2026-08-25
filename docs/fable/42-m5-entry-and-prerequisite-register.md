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
| 0 | **M5-000 — entry prerequisites** | FU-01 sequencer retirement + FU-03 enforcement arm (census 68) + the SPEC-08 schema foundation: `requests` aggregate + the six subtype tables + status/history model (migrations, RLS + FORCE + policies in the same migration, D-18/D-19/D-20 constraints), domain ports, no routes yet | checkpoint (41) |
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
