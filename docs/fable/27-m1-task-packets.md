# 27 — First Three M1 Opus Task Packets (finalized, NOT ISSUED)

**Status: finalized at M0 acceptance ([26-m0-acceptance-addendum.md](26-m0-acceptance-addendum.md)) — NOT ISSUED, not executed.** Issuance begins only on the owner's explicit M1 authorization (§5 below carries the exact prompt). Every packet inherits the runbook ([17-opus-agent-runbook.md](17-opus-agent-runbook.md)) including the thirteen non-bypass rules, the return-report format, worktree discipline, and the FAD-7 environment substitutions (embedded-postgres, corepack pnpm, no Docker builds on this machine — Dockerfiles authored, not built).

These packets supersede the *proposals* in [25-m0-exit-report.md](25-m0-exit-report.md) §10 by expanding them to full runbook format; the scopes are unchanged.

---

## OPUS-M1-001 — Tenancy schema + SPEC-01 context middleware, end-to-end

| Field | Content |
|---|---|
| **Task ID** | OPUS-M1-001 |
| **Milestone / Slice** | M1 / tenancy kernel |
| **Objective** | The production tenancy substrate: organizations/groups/users/memberships schema under RLS, the SPEC-01 context-tuple middleware on the HTTP surface, and the production unit-of-work module implementing the spike's normative pattern |
| **User outcome** | (foundation for) an org admin's organization and groups existing as real, isolated tenant data; every request carries a verified context |
| **Engineering outcome** | SPEC-01 §7.1 **and** §7.2 harnesses green against *production* code, not spike code; every later feature lands on a proven context path |
| **Dependencies** | none (first M1 task; M0 scaffold + EV-M0-SPA are its substrate) |
| **Relevant documents** | SPEC-01 (all; §4 as amended 2026-08-01 per FAD-9 — nullif predicate, all-four read-back, composite tenant FKs, tenant-qualified unique keys, pooler startup assertion); SPEC-12 (unit-of-work); ADR-0003, ADR-0022; [09-domain-model.md](09-domain-model.md) (org/group/user/membership shapes); spikes/sp-a-isolation/SPIKE-REPORT.md §6–7 (sharp edges are binding) |
| **Allowed files** | `apps/api/src/**`, `packages/domain/src/**`, `packages/contracts/src/**`, `migrations/**` (new), test files for each; `docs/dev-setup.md` (append-only, if setup changes) |
| **Prohibited files** | `docs/architecture/**`, `docs/fable/**`, `schedulepoint-research/**`, `spikes/**` (read-only reference), `apps/web/**`, `solver/**`, all gate scripts (`scripts/**`) |
| **Required implementation** | Migrations (plain SQL, reversible): `organizations`, `groups`, `users`, `memberships` — each tenant table with ENABLE + FORCE RLS + policy **in the same migration** (gate-enforced), composite tenant FKs, tenant-qualified unique keys. Context middleware: declared organization/group verification, `409 CONTEXT_STALE`, `404` for non-membership and forged ids (byte-identical to non-existent-id responses, T-05b), org-scoped branch (T-06b..d). Production `UnitOfWorkRunner` in `packages/domain` + pg adapter in `apps/api`: `BEGIN` → 4× `set_config(..., true)` → read-back of all four → commit/rollback; pooler-mode startup assertion; five-role SQL from the spike promoted to migrations |
| **Architecture constraints** | Layering (domain imports nothing); no session-scoped `SET` (lint-enforced); no statement touches a tenant table outside the unit of work (I-15); one user action = one request (I-10) |
| **Tenant-isolation requirements** | The spike's entire T-07..T-15 battery re-pointed at the production module must pass unchanged in meaning; any wrong-tenant row in any probe = task failure |
| **Authorization requirements** | Deny-by-default holds: every new route declares a policy (gate-enforced); real policy evaluation is OPUS-M1-002's scope — this task may register routes with explicit placeholder policies that **deny** everything except the context-verification paths under test |
| **Audit requirements** | Mutations must be *shaped* for audit emission (single unit-of-work boundary, stable event names) but audit rows land in OPUS-M1-003; no audit writes outside the future chain |
| **Tests** | SPEC-01 §7.1 **T-01, T-02, T-04, T-05, T-05b, T-06, T-06b, T-06c, T-06d** as an automated harness over HTTP (T-03's five surfaces: implement for mutation + job-enqueue stub now; publication/report/upload/WebSocket surfaces deferred to their milestones with a tracking note in the report); §7.2 **T-07..T-15 + T-14b** against the production unit-of-work; MULTI two-org fixtures (synthetic) |
| **Red-case tests** | A route without a policy fails the gate; a migration creating a tenant table without RLS fails the gate; a direct-query bypass attempt in test code fails lint; a deliberately wrong-tenant probe demonstrably fails the harness |
| **Acceptance criteria** | T-01..T-15 (as scoped above) green with captured output; `corepack pnpm check` 12/12; migrations up/down/up clean; five roles provably distinct (probe as each); no session-scoped `SET` anywhere in the diff |
| **Commands to run** | `corepack pnpm install` · `corepack pnpm check` · migration cycle command · harness command (full output captured) |
| **Required evidence** | Captured harness + gate output → `docs/evidence/EV-M1-TENANCY/` with INDEX.md |
| **Escalation conditions** | Any SPEC-01 behaviour is unimplementable as written; a schema need not covered by doc 09 appears; T-03's surface list cannot be partially deferred cleanly; embedded-postgres diverges from spike behaviour; any security doubt |
| **Fable acceptance checklist** | Re-run harness + gates from clean state; diff review against allowed globs; verify T-cases map 1:1 to SPEC-01 §7.1/7.2; probe the five roles myself; verify placeholder policies deny; confirm evidence matches captured output verbatim |

**Independent second review: MANDATORY** (unit-of-work/RLS critical class, [24-execution-standards.md](24-execution-standards.md) §F).

---

## OPUS-M1-002 — Authorization evaluator + roles/grants (SPEC-06)

| Field | Content |
|---|---|
| **Task ID** | OPUS-M1-002 |
| **Milestone / Slice** | M1 / authorization kernel |
| **Objective** | The SPEC-06 pure evaluator with the fourteen-step truth table (incl. the org-scope branch), the role/capability-grant schema, entitlement records with module gating (CAP-057), and real policies replacing OPUS-M1-001's deny placeholders |
| **User outcome** | (foundation for) per-membership roles determining exactly what each user can do, org-wide modules switchable per entitlement |
| **Engineering outcome** | Deny-by-default becomes *evaluated*, not just declared; the generated cross-product test battery makes authorization regressions build-failing |
| **Dependencies** | OPUS-M1-001 merged (schema + context middleware + unit of work) |
| **Relevant documents** | SPEC-06 (all, as amended — fourteen steps, disjoint org/group composition); SPEC-01 §3 (context tuple the evaluator consumes); [08-roles-and-permissions.md](08-roles-and-permissions.md); PO-DEC-02 (four-layer authorization, APPROVED); PO-DEC-04 (first-class entitlements, APPROVED) |
| **Allowed files** | `apps/api/src/**`, `packages/domain/src/**`, `packages/contracts/src/**`, `migrations/**` (additive only), tests |
| **Prohibited files** | As OPUS-M1-001, plus no modification to OPUS-M1-001's migrations (additive migrations only — never edit an applied migration) |
| **Required implementation** | Role and capability-grant schema: effective-dated, non-overlapping (exclusion constraint), tenant-scoped under RLS-in-same-migration; the **pure** evaluator (no I/O) implementing SPEC-06's truth table; entitlement records + module gating; route-policy registry wired to the evaluator so every route's declared policy is *evaluated per request against current state* (I-19); `404`-vs-`403` discipline exactly per SPEC-06 |
| **Architecture constraints** | Evaluator is a pure function in `packages/domain` — importable by tests without a database; grants read inside the same unit of work as the operation (I-19, no cached verdicts) |
| **Tenant-isolation requirements** | Grants are tenant data: RLS applies; cross-tenant grant leakage in any probe = task failure |
| **Authorization requirements** | The task **is** the authorization layer: deny-by-default fail-closed proven for unknown capability, expired grant, wrong scope, missing entitlement, revoked membership |
| **Audit requirements** | Grant/role/entitlement mutations shaped for audit emission (landed by OPUS-M1-003) |
| **Tests** | Generated cross-product battery per SPEC-06 §8 (roles × capabilities × scopes × entitlement states) run at the evaluator level **and** a sampled subset over HTTP; deny-path test for every grant type; entitlement-revocation mid-session (T-06 analogue) |
| **Red-case tests** | A route registered without a policy fails the gate (existing); a policy that names an unknown capability fails a new build-failing check; an overlapping effective-dated grant is rejected by the exclusion constraint (proven in a test) |
| **Acceptance criteria** | SPEC-06 §8 cross-product green; every OPUS-M1-001 placeholder replaced; `corepack pnpm check` green; fail-closed proofs captured |
| **Commands to run** | `corepack pnpm check` · cross-product harness with captured output |
| **Required evidence** | → `docs/evidence/EV-M1-AUTHZ/` with INDEX.md |
| **Escalation conditions** | The truth table proves ambiguous or contradictory on any input; cross-product size makes generated tests impractical (propose sampling, do not silently sample); any pending decision's default is insufficient |
| **Fable acceptance checklist** | Re-run battery + gates; verify the fourteen steps map 1:1 to code paths; adversarial probes (expired/overlapping/wrong-scope grants); verify `404`/`403` discipline; confirm no cached authorization state |

**Independent second review: MANDATORY** (authorization-evaluator critical class).

---

## OPUS-M1-003 — Audit chain + outbox/job runner (opens with the TDG-04 micro-spike)

| Field | Content |
|---|---|
| **Task ID** | OPUS-M1-003 |
| **Milestone / Slice** | M1 / audit + async kernel |
| **Objective** | **Step 0 — TDG-04 confirmation micro-spike** (graphile-worker: transactional `add_job` inside the domain transaction, durable lease behaviour, crash-mid-job recovery), then: `audit_events` with hash chain + signed checkpoints (SPEC-11 A1), the outbox, and audit emission wired into every OPUS-M1-001/002 mutation |
| **User outcome** | (foundation for) every action landing in a queryable, tamper-evident audit log; reliable async delivery without rollback coupling (I-11) |
| **Engineering outcome** | TDG-04 confirmed or reopened *before* the job runner is load-bearing; the audit chain exists from the first real mutation onward — no retrofit |
| **Dependencies** | OPUS-M1-001 merged (unit of work, schema); runs in parallel with OPUS-M1-002 (disjoint globs; both emit-shaping contracts agreed in the packets) |
| **Relevant documents** | SPEC-11 (A1 chain, checkpoints, X-01..X-03); ADR-0019 (audit chain, non-bypass rule 6); [21-decision-resolution.md](21-decision-resolution.md) TDG-04; I-11 (notification failure never rolls back a domain change) |
| **Allowed files** | `apps/api/src/**` (audit + worker wiring), `packages/domain/src/**` (audit port), `migrations/**` (additive), `spikes/sp-d-worker/**` (micro-spike, if kept separate), tests |
| **Prohibited files** | As OPUS-M1-001; no modification to applied migrations; no route-policy changes (002's scope) |
| **Required implementation** | Micro-spike first with a written go/no-go verdict in the report; then `audit_events` (append-only: no UPDATE/DELETE path in code, database rules deny them), hash chain per SPEC-11, signed checkpoints (local KMS stub per FAD-7 — real KMS is a CI condition), outbox table + graphile-worker consumption, emission from every existing mutation |
| **Architecture constraints** | Audit write happens inside the same unit of work as the mutation (chain rule); job execution is outside it; a job/notification failure must be provably unable to roll back the domain change (I-11 test) |
| **Tenant-isolation requirements** | `audit_events` is tenant data under RLS; chain verification runs per-tenant; cross-tenant reads in any probe = failure |
| **Authorization requirements** | Audit query surface (if any lands here) is deny-by-default; no new unprotected routes |
| **Audit requirements** | The task is the audit layer: never write outside the chain, never break it, never add an update path (non-bypass rule 6) |
| **Tests** | SPEC-11 X-01..X-03 subset; chain verification across a crash/restart (kill the process mid-batch, verify chain + lease recovery); I-11 proof (failing job, committed domain change); append-only proof (UPDATE/DELETE rejected at the database) |
| **Red-case tests** | A code path writing an audit row outside the unit of work fails a test; a hand-broken chain link is detected by verification; a migration adding an UPDATE-permitting rule to `audit_events` is caught in review checklist (documented, not automatable yet — note it) |
| **Acceptance criteria** | Micro-spike verdict recorded (TDG-04 confirmed or escalated); X-01..X-03 subset green; crash/restart chain proof captured; `corepack pnpm check` green |
| **Commands to run** | `corepack pnpm check` · micro-spike harness · chain-verification command, all captured |
| **Required evidence** | → `docs/evidence/EV-M1-AUDIT/` with INDEX.md (micro-spike output included) |
| **Escalation conditions** | TDG-04 disconfirmed (transactional enqueue or lease behaviour fails) — **stop after the micro-spike and report**; hash-chain performance is pathological; KMS stubbing proves unsound; any conflict between chain rule and I-11 |
| **Fable acceptance checklist** | Re-run micro-spike + harnesses; kill-mid-batch myself; attempt UPDATE/DELETE on audit rows as every role; verify emission coverage for all existing mutations; verify chain across restart |

**Independent second review: MANDATORY** (audit-chain critical class).

---

## 5. Execution order, branches, merge order, entry gate, authorization prompt

- **Order:** OPUS-M1-001 first (blocks both). On its acceptance, OPUS-M1-002 and OPUS-M1-003 run **in parallel** (disjoint globs; 003's micro-spike can start even earlier if the owner wants, but the packet keeps it sequenced for simplicity).
- **Branches/worktrees:** `opus/m1-001-tenancy-context` · `opus/m1-002-authz-evaluator` · `opus/m1-003-audit-outbox`, each in `.worktrees/`, squash-merged to always-green `main`, worktree removed and branch deleted after acceptance.
- **Merge order:** 001 → then 002 and 003 in acceptance order (no ordering constraint between them; additive migrations are numbered at merge time to avoid collision).
- **Independent second review:** mandatory for **all three** (unit-of-work/RLS, authorization evaluator, audit chain are all in the critical-task classes of [24-execution-standards.md](24-execution-standards.md) §F).
- **M1 entry gate:** M0 exit criteria passed ([26-m0-acceptance-addendum.md](26-m0-acceptance-addendum.md)) · FD-2 schema-freeze condition satisfied (internal-verification findings all dispositioned) · SP-E UX brief + design tokens authored by the orchestrator as the first M1-entry deliverable (does not block packet issuance; blocks the first UI-bearing slice).
- **Exact authorization prompt to begin M1:**

> Begin Milestone M1. Issue OPUS-M1-001, then OPUS-M1-002 and OPUS-M1-003 per docs/fable/27-m1-task-packets.md, under the same rules as M0: isolated worktrees, full quality gate per 24-execution-standards, independent second review for all three, commit each accepted task separately, escalate rather than improvise, produce the M1 exit report, and stop before M2.
