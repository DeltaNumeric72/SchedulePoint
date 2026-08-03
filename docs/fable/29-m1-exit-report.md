# 29 — Milestone M1 Exit Report

**Date:** 2026-08-03. **Authorization executed:** "Begin Milestone M1" against frozen checkpoint `b49d3dd`. **Orchestrator:** Fable. **Status: M1 tasks 4/4 ACCEPTED and merged. M2 NOT authorized — awaiting the owner.**

---

## 1. Task outcomes

| Task | Outcome | Merged as | Evidence |
|---|---|---|---|
| **OPUS-M1-001** tenancy schema + SPEC-01 context middleware + production unit-of-work | **ACCEPTED** after three rounds. SPEC-01 §7.1 (T-01/01b/02/02b/04/05/05b/06b–d) and §7.2 (T-07..T-15+T-14b) green against production code; zero wrong-tenant rows in every probe | `356ddf5` | [EV-M1-TENANCY](../evidence/EV-M1-TENANCY/INDEX.md) |
| **OPUS-M1-002** SPEC-06 authorization evaluator + roles/grants/entitlements | **ACCEPTED** after three rounds. Fifteen-row truth table; **39,285,000-case cross-product, unsampled, 0 disagreements** against an independently written oracle | `f547e90` | [EV-M1-AUTHZ](../evidence/EV-M1-AUTHZ/INDEX.md) |
| **OPUS-M1-003** audit chain + signed checkpoints + transactional outbox | **ACCEPTED** after three rounds, opening with the **TDG-04 micro-spike: GO on 18/18** | `946fc72` | [EV-M1-AUDIT](../evidence/EV-M1-AUDIT/INDEX.md) · [SP-D](../../spikes/sp-d-worker/SPIKE-REPORT.md) |
| **OPUS-M1-004** M1 kernel integration (**added under FAD-13**, not in the original three) | **ACCEPTED** after two rounds. Composed 002 onto 003; worker moved to the real evaluator; audit emission wired; tenant-table registry extended | `f547e90` | [EV-M1-INTEGRATION](../evidence/EV-M1-INTEGRATION/INDEX.md) |

**Why there were four tasks.** M1-002 and M1-003 ran in parallel worktrees with deliberately disjoint scopes. That worked — neither blocked the other — but it left the integration surface unowned: the merge conflicted precisely where audit emission and real authorization meet in the same handler. Resolving it is production-code composition, so it became its own packet with its own review rather than an orchestrator hand-edit at merge time.

## 2. Branches, worktrees, commits, agents

- **Merges to main (chronological):** `a38e5ad` preflight · `db672bf` SP-E UX brief · `356ddf5` M1-001 · `5fa1c46` M1-001 records · `946fc72` M1-003 · `0c7c90f` M1-003 records · `0e1d08e` runbook discipline · `f547e90` M1-002 + M1-004 · this report's commit.
- **Branches/worktrees:** `opus/m1-001-tenancy-context`, `opus/m1-002-authz-evaluator`, `opus/m1-003-audit-outbox`, `opus/m1-004-integration`, each in `.worktrees/`, all squash-merged then removed. Serialized-merge strategy held; no branch was merged with a red gate.
- **Agents:** four implementers, three independent second reviewers (one reviewer covered 001/003/004; a separate reviewer took 002 to keep the authorization review independent of the reviewer who had shaped 001's tenancy decisions). Every command re-run by the orchestrator before every acceptance decision.
- **Interruptions:** one session limit killed both revision agents mid-flight. Recovery per the M0 protocol: read-only inspection established that 002's worktree was clean and 003's held uncommitted work; 002 restarted its revision, 003 resumed from `git diff` rather than memory. Nothing lost, nothing needlessly redone. Both were told to commit incrementally thereafter, and did.

## 3. Independent-review findings and their resolution

**Three of four tasks came back REVISE.** Every blocking finding was produced by a reviewer writing its own database probes against the shipped code — none came from reading tests.

| Task | Verdict path | Blocking findings |
|---|---|---|
| 001 | REVISE → APPROVE WITH FOLLOW-UPS | T-01 didn't exercise its own scenario (two principals, one group each — a session-global implementation would have passed the flagship CAR-001 test); a red case that re-declared its regexes and could not fail; a migration docblock asserting "directory enumeration across tenants is not reachable", falsified by a one-statement probe |
| 002 | REVISE → APPROVE WITH FOLLOW-UPS | L1 selected an arbitrary effective-dated entitlement row: one legitimate administrative write silently 404s every action in that module organization-wide, undiagnosably (reproduced end-to-end); its write-side twin rewrote history |
| 003 | REVISE → APPROVE WITH FOLLOW-UPS | Tail truncation past the last checkpoint reported `intact` with no problems, while the one table holding the true tip was deliberately unreadable — and SPEC-11 X-03 was claimed satisfied by a test covering the other case; outbox exactly-once discharged by an in-process map, measured double-delivering in two windows |
| 004 | APPROVE WITH FOLLOW-UPS | none blocking |

Beyond the blockers: an unrecoverable sole-administrator lockout; an explicit deny failing **open** on a malformed timestamp; `app_runtime` able to rewrite the freshness counters the entire staleness mechanism rests on and to hard-delete organizations; a checkpoint signable over a hash the chain never had, permanently poisoning the integrity signal; a verify function reporting "clean" for a tenant the caller cannot see; and several controls proven inert by mutation. All fixed; each fix carries a regression test that fails when the fix is reverted — the reviewers verified that by reverting them.

**Two implementers ran their own adversarial passes before submitting. The independent reviewer still found blocking defects in both.** That is the strongest evidence this milestone produced about process: self-review is not a substitute.

## 4. What the orchestrator caught that the reviews did not

Re-running every acceptance check is not ceremony. At M1-004, the C-2 lease-recovery proof — the mitigation the entire TDG-04 GO verdict rests on — **passed 545/545 in the full suite and failed 5 of 5 standalone**. Both the implementer and the reviewer had run the full suite only.

Diagnosis (by the implementer, instrumented rather than guessed): the block asserts on `published.jobId`, which is the job the crash worker takes *only if the queue is empty* — an assumption the test never stated and had been right about by accident, until this task's own non-vacuity seeding put four jobs ahead of it. **Not a reclaim defect** — with the precondition declared, recovery measures 574–576 ms, so FAD-14 C-2 stands. The queue is now drained the way production drains it (a real dispatcher, never a `DELETE`), and the assumption is a first-class assertion. A 24-file standalone sweep found no sibling.

This is now a standing rule: any proof of a named condition is run standalone as well as in the battery, and both are reported.

## 5. Tests, validators, harnesses at close

**On main:** `corepack pnpm check` **12/12** · **551 tests / 36 files** · `pnpm red-cases` **14/14 proven** · migration cycle up→down→up→down→up **clean across 0001+0002+0003**, zero tables and zero policies after `down` · SPEC-06 cross-product **39,285,000 cases, 0 disagreements** · audit chain verification **0 / 1 / 0** · crash-restart **3/3 standalone**. Research validator PASS · architecture **95/95** · plan **36/36**.

**Not run** (unchanged CI conditions plus M1's own): remote CI execution; container image builds (no Docker, FAD-7); external-pooler T-14 variant; solver harness under Python 3.12; SPEC-02/05/07/08/09/13 harnesses (their subjects don't exist); the 39 SBX tests; T-03's remaining three surfaces (publication, report/upload, WebSocket — deferred to their milestones).

## 6. Tenant isolation

Proven against production code, not spike code. Transaction-local context through the mandatory unit of work (`BEGIN` → four `set_config(...,true)` → read-back of all four → commit/rollback), fail-closed outside it for every role, FORCE RLS binding even the owner. The M0 sharp edges are now normative and enforced: the `nullif` predicate spelling (checked **per reference** — 29 of them — after a reviewer showed a single guarded reference was licensing bare casts elsewhere in the same predicate), composite tenant FKs, tenant-qualified unique keys.

Hardening added during review: freshness counters and `session_epoch` removed from `app_runtime`'s column grants and made monotonic by trigger; DELETE granted nowhere; a last-administrator check; CHECK constraints forbidding infinite window bounds (added because a code comment claimed a constraint that did not exist — the third such comment in one task, so the control was built rather than the comment softened).

**One deliberate exception, recorded:** `audit_checkpoints` is readable cross-tenant by `app_migrator` alone, through one `LANGUAGE sql` SECURITY DEFINER function granted to `app_worker`, returning organization ids, counters and timestamps and nothing else. Periodic jobs must find work before any tenant context exists; the alternative was a `BYPASSRLS` role or a hidden owner exemption. It is pinned by tests in both directions (including that it stays `SELECT`-only), and it is not itself audited.

## 7. Authorization, audit, outbox — headline results

- **Authorization:** the fifteen-row SPEC-06 table in a pure evaluator (no I/O, no clock), consulted per request **inside the mutation's own transaction** (I-19, FAD-12). One evaluator on every surface — the worker's provisional role allow-list is deleted, not deprecated. Deny-by-default proven fail-closed for unknown capability, expired grant, wrong scope, missing entitlement, revoked membership; `404`/`403` discipline per SPEC-06 with byte-identity where SPEC-01 requires it. Oracle-checked over 39.3M cases; the reviewer confirmed the oracle is independent in control flow and that the battery's blind spots (grant windows never varied, object-policy branch, cross-tenant target, wrong-module entitlement) are disclosed rather than papered over.
- **Audit:** append-only in three layers — no grant, no UPDATE policy, and `ENABLE ALWAYS` triggers refusing superuser UPDATE/DELETE/TRUNCATE **including under `session_replication_role = 'replica'`**. Chain columns are trigger-assigned and excluded from the INSERT grant; the tip lives in a table no role holds any grant on. Truncation is detected in both shapes (mid-chain gap, and head-ahead-of-chain), and even an actor privileged enough to disable the guard cannot make it silent — the missing input is itself a finding. A defect the implementer caught itself and recorded: the first canonical-bytes function omitted `prev_hash` from the hash input, so every entry hashed only itself.
- **Outbox:** enqueue is atomic with the domain write and the audit row; delivery is outside every transaction (I-11 structural, not merely tested). Exactly-once rests on a **durable** idempotency key, after the in-process version was measured double-delivering under concurrent dispatchers and after a crash-following-effect. Ordering between events is explicitly **not** guaranteed, and says so.
- **TDG-04:** CONFIRMED (FAD-14) with four conditions carried into production code — the queue's own tables ship RLS-enabled with zero policies (our installer generates them and throws if any table is unpoliced); the four-hour lease is not configurable and graceful shutdown strands in-flight jobs (heartbeat registry + `force_unlock_workers` at startup, 574–576 ms measured); a handler ignoring `abortSignal` survives the first SIGTERM; at-least-once requires durable idempotency.

## 8. Architecture decisions, risks, remaining assumptions

**Decisions recorded this milestone:** **FAD-11** (three SPEC-01 escalations: revoked membership → `404` with T-02b added for the genuinely-stale case; EX-2 governs cross-group reads and organization-scoped context holds organization-bounded DML; the organization-role gate sits above SQL until non-recursive grant relations exist) · **FAD-12** (authorization and the mutation it authorizes share one unit of work, on every surface — from a review finding that the HTTP surface split them while the job surface did not) · **FAD-13** (the jobs-surface evaluator gap closed by the integration task; entitlement administration may never be self-referentially module-gated; SPEC-06 has fifteen rows and the spec governs a stale packet) · **FAD-14** (TDG-04 closed with C-1..C-4; the maintenance-plane cross-tenant read sanctioned as the alternative to BYPASSRLS). SPEC-01 §7.1 and §4.3 carry dated amendments.

**Risks:** **NR-9 retired** — no selected technology remains unconfirmed. **NR-4 stays elevated** with far stronger data (§3 — three of four tasks REVISE, every blocker from independent probing, self-review insufficient). **NR-13 opened:** shared-fixture coupling — 551 tests across 36 files share one cluster and one fixture; three order/state couplings were point-fixed in M1-004 alone, and nothing structurally prevents the next. Retired by costing per-test transactional rollback or a dedicated organization for mutating suites at M2 entry. **FA-3 discharged.**

**Open residuals, all recorded and owned** (EV-M1-TENANCY §5.2, EV-M1-AUTHZ §5, EV-M1-AUDIT §5, EV-M1-INTEGRATION §5): residual 1b — an *authorized* administrator can attach an arbitrary global user id and irreversibly bump that user's freshness counter (a cross-tenant availability effect; `users` is global per PO-DEC-06, so it is owned by the provisioning design) · `app_membership_holds` became observer-dependent when the grant read was narrowed (inert today; fail-open arm goes live with custom organization roles) · self-service organization INSERT · the KMS-shaped transaction held across `signer.sign()` · the signing key is in-process, so a checkpoint proves the path works and nothing about who produced it · SPEC-11 §3.2's obligation to audit break-glass sessions is unimplemented · no consumer for outbox events yet · two of five T-03 surfaces agree. **Standing conditions unchanged:** external independent architecture re-review before beta (M10 exit, blocking); the four FAD-7 CI conditions.

## 9. Control-document audit

| Document | Reviewed | Updated | Change summary / reason no change | Final commit |
|---|---|---|---|---|
| PROJECT-STATUS.md | yes | **yes** | Phase → M1 complete 4/4, kernel state, M2 not authorized | this checkpoint |
| OPUS-AGENT-RUNBOOK.md | yes | **yes** | Four task rows with verdict paths; two standing disciplines added (worktree/port hygiene with the collision signature; standalone verification) | `0e1d08e` + this |
| TEST-TRACEABILITY.md | yes | **yes** | Four M1 execution rows with measured figures | this checkpoint |
| EVIDENCE-INDEX.md | yes | **yes** | EV-M1-TENANCY / AUTHZ / AUDIT / INTEGRATION | this checkpoint |
| ARCHITECTURE-DECISIONS.md | yes | **yes** | FAD-11, FAD-12, FAD-13, FAD-14 | `5fa1c46`, `0c7c90f` |
| RISK-REGISTER.md | yes | **yes** | NR-9 retired, NR-4 re-evidenced, NR-13 opened | this checkpoint |
| ASSUMPTIONS.md | yes | **yes** | FA-3 discharged (TDG-04 confirmed) | this checkpoint |
| IMPLEMENTATION-ROADMAP.md | yes | **yes** | M1 COMPLETE; M2 not authorized | this checkpoint |
| CHANGELOG.md | yes | **yes** | M1 entry | this checkpoint |
| PRODUCT-DECISIONS.md | yes | no | No product decision changed in M1; FAD-13(2)'s entitlement-administration ruling is architectural, recorded in ARCHITECTURE-DECISIONS | `2b64a7b` |
| OPEN-QUESTIONS.md | yes | no | Q-6/7/8 unchanged by M1 | `2b64a7b` |
| ORCHESTRATION.md | yes | no | Model unchanged and validated by use, including the added integration packet | `adcfdbb` |
| FEATURE-PARITY-MATRIX.md | yes | no | **Deliberate:** M1 delivered kernel substrate (tenancy, authorization, audit), not user-facing capabilities. CAP-057 module gating exists but has no tenant-facing surface. All 58 rows correctly remain `not-started`; the first rows move in M2 | `adcfdbb` |

## 10. M1 exit criteria — verdict

Roadmap M1 exit: *"isolation, authz, and audit harnesses green; QA-TEN/QA-AUTH battery passing; G-ARCH SBX subset for tenancy executed and filed."*

**Result: PASSED WITH ONE CARRIED ITEM.** Isolation, authorization and audit harnesses are green against production code with evidence filed. QA-TEN/QA-AUTH content is covered by the SPEC-01 §7.1/§7.2 and SPEC-06 §8 batteries. **Carried: the G-ARCH SBX subset for tenancy (SBX-001/002/004/005/006) was not executed** — the SBX harness does not exist yet (0 of 39 SBX tests have ever run) and building it was in no M1 packet. It is not a silent omission: it becomes the first item of M2 or a dedicated packet, and G-ARCH cannot close without it. Also carried: MULTI environment provisioning, and the entry-gate item NR-13 (fixture coupling) to cost before M2 work begins.

## 11. Recommendation and the proposed first three M2 packets

**M2 is recommended.** The kernel holds: every mutation now passes one evaluator and lands one audit row inside one transaction, and the review discipline demonstrably finds real defects before they reach main.

Proposed (full packets to be finalized in runbook format on authorization; scopes disjoint where parallel):

- **OPUS-M2-001 — SBX harness + the G-ARCH tenancy subset, and the fixture-isolation decision.** Build the SBX evidence harness ([SPEC-16](../architecture/specs/SPEC-16-sbx-evidence-contracts.md)) and execute SBX-001/002/004/005/006 against the M1 kernel; provision the MULTI environment. Opens with the NR-13 costing: per-test transactional rollback vs a dedicated organization for mutating suites — decide and implement before M2's feature work lands on the same fixture. Clears the M1 carried item and unblocks G-ARCH.
- **OPUS-M2-002 — Shift-type catalogue, groups and valid combinations (first capability-bearing slice).** The four shift-type flags, shift/staff/valid groups, group settings, and **the first UI-bearing surface** — therefore the first task governed by the [SP-E UX brief](28-sp-e-ux-brief.md) and SPEC-14's component matrix. First rows to move on the parity matrix. Critical class (first tenant-facing mutations on the new kernel): second review mandatory.
- **OPUS-M2-003 — Effective-dated work profiles, FTE and qualifications.** Effective-dated profile/FTE records and qualifications with expiry (PO-DEC-12 default), reusing 0002's EXCLUDE-constraint pattern — and reusing the **entitlement-in-force lesson**: any effective-dated read must select the row in force, never an arbitrary one. Exit: round-trip authoring proven; deny paths for every new capability.

Sequencing: M2-001 first (it decides the fixture strategy every later suite inherits, and clears the carried G-ARCH item); M2-002 and M2-003 then run in parallel worktrees with disjoint globs. Branches `opus/m2-001-sbx-harness`, `opus/m2-002-catalogue`, `opus/m2-003-profiles`. All three critical class → independent second review mandatory. **M2 entry gate:** M1 exit accepted; NR-13 costed as M2-001's opening step.

**Exact authorization prompt to begin M2:**

> Begin Milestone M2. Issue OPUS-M2-001, then OPUS-M2-002 and OPUS-M2-003 per the M1 exit report, under the same rules as M1: isolated worktrees, full quality gate per 24-execution-standards, independent second review for all three, standalone plus full verification of every named-condition proof, commit each accepted task separately, escalate rather than improvise, produce the M2 exit report, and stop before M3.

---

**Stopping here per the authorization. M2 begins only on your explicit instruction.**
