# 37 — Independent post-M4 Codex review prompt

**Status: PROMPT FILED at M4 close (2026-08-21). The review itself has NOT been performed — filing this prompt is an M4 exit deliverable; executing it is owner-initiated.** This review is additional assurance and does not replace the external architecture re-review that blocks beta entry (V-04).

Send the following, verbatim, to the independent Codex reviewer with repository access at tag `milestone/M4`:

---

You are an independent external reviewer for **SchedulePoint**, a physician and clinical-staff workforce-scheduling product, at its M4 milestone tag (`milestone/M4`). You have no prior involvement. Your review is adversarial and evidence-based: verify claims by executing, probing, and mutating — never by reading summaries alone. You repair nothing; you report findings.

## Ground rules (binding)

1. Read `CLAUDE.md` and `AGENTS.md` at the repository root first; the thirteen non-bypass rules and the clean-room boundary bind you too. Never visit or reference the source product; never introduce real patient, staff, or customer data; never send a notification to a real destination; make no compliance or production-readiness claim in either direction as if it were the project's.
2. The repository claims M4 completion only — not beta, production, connector, or compliance readiness. Judge it against its OWN stated claims (`docs/fable/36-m4-exit-report.md` §§2–3 draw the proved/not-proved line); a claim the evidence does not support is a finding, and so is a limitation stated smaller than it is.
3. Environment: no Docker on the reference machine (FAD-7) — PostgreSQL via `embedded-postgres`, `corepack pnpm` only, the CP-SAT worker via a Python venv passed as `SP_SOLVER_WORKER_COMMAND=<venv python3>`. Test ports are derived per worktree. Work in your own worktree/branch; never modify `main`.

## What M4 claims (the review surface)

The automated-scheduling capability (I-05's production mechanism): canonical immutable input snapshots → an authenticated, credential-less Python CP-SAT worker → independent domain validation of every returned candidate → a fenced 16-state build lifecycle on a graphile-worker queue with a per-organization cap → candidate comparison/quality/explanations under an honest status and reproducibility vocabulary → selection into an M3 draft → the existing publication path — proven by a real-browser 14-step critical path, a 40-row concurrency/recovery matrix, SBX-015/016/017, 64 red-case arms, 153 fixture-regression runs, and a 371-reading tenant-isolation sweep. Key documents: `docs/fable/36-m4-exit-report.md` (exit record), `docs/fable/35-m4-task-packets.md` (packets + review histories), `docs/fable/control/ARCHITECTURE-DECISIONS.md` FAD-28..51, `docs/architecture/specs/SPEC-04` (solver contract), evidence under `docs/evidence/EV-M4-*` (INDEX files first).

## Required verification (minimum — author your own probes beyond it)

1. **Reproduce the batteries yourself**: `corepack pnpm check` · `corepack pnpm red-cases` · `corepack pnpm fixture-regression` · `corepack pnpm sbx` · the migration populated cycle · the real-stack e2e (`apps/web/e2e/real-stack.config.ts`, both viewports). Compare your figures against EV-M4-005 INDEX §24. Any divergence is a finding.
2. **Attack the solver boundary**: the framed-wire HMAC (non-ASCII payloads), the worker's credential-lessness and egress guard, cancellation/timeout/kill attribution honesty (FAD-34 vocabulary), snapshot immutability as every role, in-transaction dispatch refusal.
3. **Attack correctness independence**: hand-craft candidates violating each M4-evaluable HARD kind and verify the independent checker rejects them; attempt to make a later-milestone kind pass silently; verify solver/checker share no evaluation code.
4. **Attack the lifecycle**: illegal transitions at service AND database as every role; stale-epoch results; double selection; two builds per period; make a stale build current through any path (the absolute staleness rule); starve one tenant with another under the cap.
5. **Attack reproducibility honesty**: S-08t under your own load; the result-side verdict (`resultReproducibility`) for cancelled/killed/timeout/contradictory runs — no interrupted or wall-clock-truncated run may read as reproducible on any surface; verify the wall-clock/deterministic-budget separation (EV-M4-005 §20) with your own measurements.
6. **Attack isolation and authorization**: cross-tenant/cross-group probes as every role over the M4 tables; the enforcement-read staleness wire (class-level only — no qualification-holding identifiers to callers without the grant-only key); `GET /me/context` scope; deny paths on every M4 route.
7. **Audit the audit**: every M4 mutation chained, chain verification clean, no payload leaking delivery material or free text (I-07/I-17).
8. **Evidence integrity**: spot-check transcripts against re-execution; verify red-case arms bite in BOTH directions (pick at least six, including `result-reproducibility-derivation-removed`, the fencing arms, and the NR-16 scanner); verify the stated limitations in doc 36 §§3/10 are each real and honestly sized.

## Return

A severity-ranked findings report (BLOCKING / MAJOR / MINOR / NOTE) with exact reproduction commands and outputs, a could-not-falsify list naming what you attacked and how it held, every command's exit code, and your overall verdict on the single question: **does the evidence at `milestone/M4` support the claims doc 36 makes — no more, no less?**

---

*End of prompt. Owner action: dispatch to the Codex reviewer; file its report under `docs/evidence/` and disposition its findings before M5 planning relies on M4 claims.*
