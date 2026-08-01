# 23 — First Three Opus Task Packets

**Status: approved for issuance ([21-decision-resolution.md](21-decision-resolution.md) FD-4) — NOT executed.** Issuance begins only after the owner sends the implementation-authorization prompt ([24-execution-standards.md](24-execution-standards.md) §G). All three are M0 tasks; OPUS-M0-002/003 may run concurrently after OPUS-M0-001's scaffold-independent portions land (001 and 002 are independent; 003 depends on nothing but its own directory). Every packet inherits the runbook ([17-opus-agent-runbook.md](17-opus-agent-runbook.md)) including the thirteen non-bypass rules, the return-report format, and worktree discipline.

---

## OPUS-M0-001 — Tenant-isolation unit-of-work spike (SP-A / SP-1 / SP-2)

| Field | Content |
|---|---|
| **Task ID** | OPUS-M0-001 |
| **Milestone / Slice** | M0 / SP-A |
| **Objective** | Confirm by executed evidence that **Kysely + `pg`** (TDG-02) and in-process **`pg.Pool`** with transaction affinity (TDG-03) implement SPEC-01's transaction-local tenant isolation, and that the required constraint forms are expressible in plain-SQL migrations (SP-2) |
| **Engineering outcome** | The single most load-bearing unknown becomes proven; failure reopens TDG-02/03 before anything is built on them |
| **Relevant documents** | SPEC-01 (all; §4 is normative — note doc 02 §3.2's corrected text); SPEC-15 TDG-02/03 + SP-1/SP-2; ADR-0003, ADR-0022; [21-decision-resolution.md](21-decision-resolution.md) §3 |
| **Dependencies** | none |
| **Allowed files** | `spikes/sp-a-isolation/**` (new) |
| **Prohibited files** | everything else; research reports always prohibited; no edits to docs/ |
| **Required implementation** | Docker-composed PostgreSQL. Two organizations; ≥1 tenant table with RLS policy reading `current_setting`-based context. **Five database roles per SPEC-01 §4** (app role: non-owner, no `BYPASSRLS`, `FORCE ROW LEVEL SECURITY`; separate migration, worker, support, break-glass roles). Unit-of-work wrapper: `BEGIN` → `set_config(..., true)` → read-back verification → commit/rollback ends context. Kysely executing through the wrapper; plain-SQL migrations (node-pg-migrate) creating one exclusion constraint, one partial unique index, one trigger, and demonstrating `FOR UPDATE` |
| **Architecture constraints** | No session-scoped `SET`, ever. No query path that checks out a connection outside the wrapper. No ORM layer on top |
| **Security constraints** | Synthetic data only; no real identifiers; secrets via env for local containers only |
| **Tenant-isolation requirements** | The point of the task: outside the wrapper every tenant table returns zero rows and rejects writes; any wrong-tenant row anywhere in any probe = task failure |
| **Audit requirements** | n/a (spike) — but record every harness run's output verbatim |
| **Tests** | SPEC-01 **T-07..T-15** as an automated harness, plus: forced exception mid-transaction; query cancellation; pool timeout/reuse across orgs; nested transaction; statement outside wrapper (fail-closed probe); worker-role probe; **transaction-affinity proof and a statement-pooling counter-demonstration** (TDG-03); continuous cross-tenant probe during a two-org concurrency storm (≥50 iterations) |
| **Acceptance criteria** | All T-07..T-15 pass with output captured; constraint-expressiveness demo migrates up and down; SPIKE-REPORT.md states: verdict per TDG-02 criteria, pooling verdict per TDG-03, sharp edges, recommendation |
| **Commands to run** | `docker compose up -d` · migration command · harness command (full output captured to file) |
| **Required evidence** | `spikes/sp-a-isolation/SPIKE-REPORT.md` + captured harness output → filed as `docs/evidence/EV-M0-SPA` |
| **Escalation conditions** | Kysely cannot issue `SET LOCAL`-equivalent inside a caller-controlled transaction cleanly; RLS behaviour contradicts SPEC-01 §4; pool reuse cannot be forced deterministically; any constraint form inexpressible |
| **Deliverables** | Spike directory, harness, report, evidence artifact |
| **Fable review checklist** | Re-run harness from clean state; verify T-07..T-15 map 1:1 to SPEC-01 §7.2; verify the five roles actually differ (probe as each); verify fail-closed probe is genuinely outside the wrapper; check no session-scoped `SET` anywhere in the diff; confirm report's claims match captured output |

---

## OPUS-M0-002 — Repository scaffold with the full CI gate battery

| Field | Content |
|---|---|
| **Task ID** | OPUS-M0-002 |
| **Milestone / Slice** | M0 / scaffold |
| **Objective** | Stand up the monorepo and the CI gates so every later slice lands against them from day one |
| **Engineering outcome** | A clean-checkout developer runs one command and gets: containers, typecheck, lint, tests, and all guard gates — green |
| **Relevant documents** | [11-architecture.md](11-architecture.md) §5; [15-testing-strategy.md](15-testing-strategy.md) §4; [21-decision-resolution.md](21-decision-resolution.md) §3 (TDG-01/04/14 selections); docs/architecture/drafts/* (source for the installed CLAUDE.md/AGENTS.md); SPEC-06 (route-policy check concept); 04-domain-boundaries (import-boundary concept) |
| **Dependencies** | none (001 runs in parallel; its library verdicts are already selected — a 001 failure would amend this scaffold, which is acceptable churn) |
| **Allowed files** | Repo root config files; `apps/web/**`, `apps/api/**`, `packages/**`, `solver/**` (skeletons only); `.github/workflows/**`; `CLAUDE.md`, `AGENTS.md`; `docs/dev-setup.md` |
| **Prohibited files** | `docs/architecture/**`, `docs/fable/**` (except none), `schedulepoint-research/**`; **no product feature code, no migrations beyond an empty migrations dir, no domain logic** |
| **Required implementation** | pnpm workspaces: `apps/api` (Fastify skeleton: health route, typed error envelope, correlation-id hook — no product routes), `apps/web` (Vite+React+TanStack+Radix+Tailwind skeleton: shell page only, tokens file), `packages/contracts` (zod), `packages/domain` (empty, with import-boundary config), `solver/` (Python package skeleton + `pyproject.toml`, no OR-Tools logic). Dockerfiles for the three images (skeleton). Local env: docker compose (PG + MinIO + Mailpit). Seed-data script placeholder (synthetic only). **Install CLAUDE.md/AGENTS.md generated from the drafts + runbook** (thirteen non-bypass rules included; drafts remain in place unmodified) |
| **Architecture constraints** | Layering per doc 04: domain imports nothing from infra/framework; CI enforces it (eslint boundaries or dependency-cruiser). Three-image structure honoured even as skeletons |
| **Security constraints** | **CI gates, all build-failing:** lint · typecheck · unit test runner · **network-assertion guard (SP-HR-1: test build fails on any non-allowlisted outbound host in client code)** · requests-per-interaction budget harness (skeleton with one enforced example) · axe-core wired into Playwright (runs against the shell page) · migration+RLS pairing check (runs, trivially green on empty dir) · route-without-policy check (Fastify route table enumeration; health route carries an explicit public policy) · import-boundary check · invariant-ID uniqueness check (parses docs) · secret-scan (gitleaks-class) · production build. No secrets in repo; `.env.example` only |
| **Tenant-isolation requirements** | None yet — but the unit-of-work module *location* is stubbed in `packages/domain` boundaries so 001's landing spot is defined |
| **Audit requirements** | n/a (no mutations exist) |
| **Tests** | One passing unit test per package; one Playwright smoke test (shell renders, axe passes); CI runs everything on a PR |
| **Acceptance criteria** | Fresh clone → `pnpm setup && pnpm check` green locally and in CI; every named gate demonstrably **fails** when violated (each gate ships with a red-case proof commit or test); CLAUDE.md/AGENTS.md installed and consistent with the runbook |
| **Commands to run** | `pnpm install` · `pnpm check` (aggregate) · `docker compose up -d` · CI run |
| **Required evidence** | CI run link/log + red-case proofs → `docs/evidence/EV-M0-SCAFFOLD` |
| **Escalation conditions** | Any selected library (TDG-01/14) fails a hard requirement during wiring; route enumeration for the policy check proves infeasible in Fastify; axe/Playwright integration conflicts |
| **Deliverables** | Scaffold, CI, installed agent instructions, dev-setup doc, evidence artifact |
| **Fable review checklist** | Clean-clone reproduction myself; trigger each gate's red case and confirm the build fails; verify layering config actually blocks a domain→infra import (try one); confirm installed CLAUDE.md/AGENTS.md carry all thirteen rules verbatim; confirm zero product logic snuck in |

---

## OPUS-M0-003 — Solver boundary spike (SP-C / SP-5)

| Field | Content |
|---|---|
| **Task ID** | OPUS-M0-003 |
| **Milestone / Slice** | M0 / SP-C (E0 in [12-scheduling-engine-plan.md](12-scheduling-engine-plan.md) §3) |
| **Objective** | Confirm the Python + OR-Tools CP-SAT worker boundary: serialize → solve → cancel → timeout → kill → restart → reproduce, and measure determinism vs. worker count (TDG-11 solver aspects) |
| **Engineering outcome** | The second-language boundary is proven cheap and controllable before M4 depends on it; determinism behaviour is measured, not assumed |
| **Relevant documents** | SPEC-04 §1; ADR-0020, ADR-0006; report 21 §7 (reproducibility); [12-scheduling-engine-plan.md](12-scheduling-engine-plan.md) |
| **Dependencies** | none |
| **Allowed files** | `spikes/sp-c-solver/**` (new) |
| **Prohibited files** | everything else; no production `solver/` package code |
| **Required implementation** | Toy scheduling problem (~20 staff × 14 days × 3 shift types, a spacing constraint, an FTE-target objective) in a solver-neutral JSON shape; Python worker: **one solve per subprocess**; versioned RPC stub (HTTP or stdio) with authenticated-call placeholder; **no database access anywhere in the worker**; fixed seed + recorded parameters |
| **Architecture constraints** | Domain-neutral problem/solution schema (no CP-SAT types leak); cancellation layered: deadline → callback → **SIGKILL**, each demonstrated |
| **Security constraints** | Worker image has no DB credential, no network egress needs beyond the RPC; synthetic data only |
| **Tenant-isolation requirements** | n/a (no tenant data — problem in, solution out) |
| **Audit requirements** | n/a (spike); reproducibility record fields captured per report 21 §7 (seed, params, worker count, versions) |
| **Tests** | Harness proving: OPTIMAL/FEASIBLE solve; **INFEASIBLE** correctly reported on an over-constrained variant; mid-solve cancel via each layer; timeout; kill + restart cleanliness; **same seed + same worker count → identical solution across 5 runs**; worker count varied → document whether results diverge |
| **Acceptance criteria** | All harness cases pass with captured output; SPIKE-REPORT.md states determinism findings, cancellation latency per layer, serialization cost, and any CP-SAT surprises (incl. whether the assumption mechanism needed for explanation tier T1 exists) |
| **Commands to run** | `docker build` (solver image) · harness command with captured output |
| **Required evidence** | `docs/evidence/EV-M0-SPC` |
| **Escalation conditions** | CP-SAT cannot report INFEASIBLE on the toy in reasonable time; determinism unachievable even at fixed worker count; kill leaves orphan state |
| **Deliverables** | Spike directory, harness, report, evidence artifact |
| **Fable review checklist** | Re-run the 5× reproducibility batch myself; verify INFEASIBLE case is genuinely infeasible (inspect constraints); verify kill test leaves no zombie process; confirm no `ortools` import outside the adapter file; check the RPC schema carries version + reproducibility fields |
