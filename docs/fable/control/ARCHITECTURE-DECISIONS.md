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
