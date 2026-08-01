# ARCHITECTURE-DECISIONS (live register)

Canonical: docs/architecture/decisions/ — 23 ADRs, status **PROPOSED**; per-ADR acceptance occurs as their confirming spikes/harnesses pass (M0–M3), external re-review REQUIRED and blocking for beta entry (V-04); architecture remains PROPOSED until it upgrades the verdict.

Orchestrator decisions (FAD series):
| # | Decision | Where | Date |
|---|---|---|---|
| FAD-1 | Single repository: pnpm workspaces + solver/ Python package | [../11-architecture.md](../11-architecture.md) §5 | 2026-08-01 |
| FAD-2 | Entitlements are the product flag system; no runtime flag service | [../11-architecture.md](../11-architecture.md) §5 | 2026-08-01 |
| FAD-3 | Genius merges into Scheduler; no untestable role distinctions | [../08-roles-and-permissions.md](../08-roles-and-permissions.md) §3 | 2026-08-01 |
| FAD-4 | UI = typed-contract React SPA + Fastify JSON API (resolves doc 02 §2.3 posture within TDG-01/14 discretion) | [../21-decision-resolution.md](../21-decision-resolution.md) §3 note | 2026-08-01 |
| FAD-5 | Technology selections TDG-01..15 (Fastify, Kysely+pg, pg.Pool/PgBouncer-txn, graphile-worker, first-party auth + openid-client, provisional providers, Playwright-Chromium renderer, ical-generator, S3+MinIO, ClamAV, AWS ca-central-1 provisional, self-hosted OTel/Grafana, Secrets Manager, React+Radix+Tailwind+TanStack, KMS signing) — decided pending M0 spike confirmation | [../21-decision-resolution.md](../21-decision-resolution.md) §3 | 2026-08-01 |
| FAD-6 | Review strategy: internal adversarial verification gates M1; external re-review required, blocking beta entry (amended per V-04) | [../21-decision-resolution.md](../21-decision-resolution.md) FD-2 | 2026-08-01 |

Corrections applied: F-05 (doc 02 §3.2) — done 2026-08-01 · CAR-026 (report 18 count) — done 2026-08-01.
| FAD-7 | M0 local-environment substitution: no Docker/Homebrew/sudo on this machine — PostgreSQL via `embedded-postgres` (real user-space PG binaries) for spike/dev; pnpm via corepack (no global install); solver spike in a Python venv (ortools 9.15 on system 3.9), solver image authored but built later in CI; docker-compose files authored for CI/platform use. Evidence value preserved: genuine PostgreSQL semantics and genuine subprocess kill semantics either way | this entry | 2026-08-01 |
| FAD-8 | Validator phase-boundary rescope: planning-phase checks 52a/52b (arch) and 10a (plan) retired and replaced with the boundary they protected — no application code in docs//research trees; implementation only in authorized roots (spikes/, apps/, packages/, solver/, scripts/, .github/) | validate.py comments | 2026-08-01 |
