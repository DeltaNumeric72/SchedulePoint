# EVIDENCE-INDEX (live)

Authoritative narrative index: [../02-evidence-index.md](../02-evidence-index.md).
New evidence artifacts are filed under `docs/evidence/` with stable IDs (EV-M<milestone>-<slug>), date, environment, and command record, and listed here.

| ID | Date | What | Artifact | Grade |
|---|---|---|---|---|
| EV-M0-SPA | 2026-08-01 | Tenant-isolation unit-of-work spike: SPEC-01 T-07..T-15 (+T-14b), 36/36; TDG-02/03 confirmation | [../../evidence/EV-M0-SPA/INDEX.md](../../evidence/EV-M0-SPA/INDEX.md) | Confirmed (re-run by orchestrator) |
| EV-M0-SCAFFOLD | 2026-08-01 | CI gate battery 12/12 + 14/14 red-case proofs; scaffold | [../../evidence/EV-M0-SCAFFOLD/INDEX.md](../../evidence/EV-M0-SCAFFOLD/INDEX.md) | Confirmed (re-run by orchestrator) |
| EV-M0-SPC | 2026-08-01 | Solver boundary H-0..H-8 incl. determinism finding; TDG-11(runtime) confirmation | [../../evidence/EV-M0-SPC/INDEX.md](../../evidence/EV-M0-SPC/INDEX.md) | Confirmed (re-run by orchestrator; H-6 reproduced) |
| EV-M1-INTEGRATION | 2026-08-03 | M1 kernel integration: composition merge, worker→evaluator, audit emission, tenant-table registry (five gaps surfaced), C-2 standalone proof; 551/551 | [../../evidence/EV-M1-INTEGRATION/INDEX.md](../../evidence/EV-M1-INTEGRATION/INDEX.md) | Confirmed (orchestrator re-ran serially; caught the C-2 order dependence both agents missed) |
| EV-M1-AUTHZ | 2026-08-03 | SPEC-06 evaluator (fifteen rows), roles/grants/entitlements, entitlement-in-force fix; 39.3M cross-product 0 disagreements | [../../evidence/EV-M1-AUTHZ/INDEX.md](../../evidence/EV-M1-AUTHZ/INDEX.md) | Confirmed (orchestrator re-ran each round; two review rounds, blocking defect reproduced end-to-end) |
| EV-M1-AUDIT | 2026-08-03 | Audit chain (SPEC-11 A1) + signed checkpoints + transactional outbox; TDG-04 confirmation spike SP-D 18/18 GO; 336/336 | [../../evidence/EV-M1-AUDIT/INDEX.md](../../evidence/EV-M1-AUDIT/INDEX.md) | Confirmed (orchestrator re-ran battery each round; second review re-probed both blockers closed) |
| EV-M1-TENANCY | 2026-08-02 | Production tenancy kernel: SPEC-01 §7.1+§7.2 vs production unit-of-work, 272/272; residuals 1–7 recorded (§5.2) | [../../evidence/EV-M1-TENANCY/INDEX.md](../../evidence/EV-M1-TENANCY/INDEX.md) | Confirmed (orchestrator re-ran full battery at 3 review rounds; adversarial second review incl. live DB probes) |
