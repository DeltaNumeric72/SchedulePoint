# SP-A — tenant-isolation unit-of-work spike

Throwaway evidence for **OPUS-M0-001**. Proves (or disproves) that **Kysely + `pg`**
(TDG-02) and an in-process **`pg.Pool`** with transaction affinity (TDG-03)
implement SPEC-01 §4's transaction-local tenant isolation, and that SPEC-15
SP-2's constraint forms are expressible in plain-SQL migrations.

**Read [SPIKE-REPORT.md](SPIKE-REPORT.md) for the verdicts and the sharp edges.**
This file only says how to run it.

> **Spike code. It ships nowhere** (runbook §3). `src/unit-of-work.ts` is a
> reference for the real implementation, not the real implementation.

## Run

```bash
npm install          # approves 2 postinstall scripts (esbuild, embedded-postgres binaries)
npm run typecheck
npm run migrate:cycle    # up -> down -> up, on a throwaway cluster
npm test                 # 36 tests, ~4.4 s
```

Each command starts and stops its own PostgreSQL 17.10 cluster from a freshly
initialised data directory. Nothing persists between runs; nothing needs to be
torn down by hand.

| Env var | Default | Effect |
|---|---|---|
| `SPIKE_PG_PORT` | `55432` | Port for the embedded cluster |
| `SPIKE_STORM_ITERATIONS` | `250` | T-15 storm loop count (packet floor: 50) |

## No Docker here

The packet asks for docker-compose. This machine has no Docker, no Homebrew and
no sudo, so per **FAD-7** the cluster is the real `postgres` executable run
user-space via the `embedded-postgres` package. `docker-compose.yml` is
committed for CI and is **marked not runnable here**. SPIKE-REPORT.md §2 explains
why the substitution does not weaken the evidence, and §8.1 explains the one
thing it genuinely cannot cover (an external pooler).

## Layout

| Path | What |
|---|---|
| `migrations/*.sql` | Plain SQL, `-- Up Migration` / `-- Down Migration`, run by `node-pg-migrate` as `app_migrator` |
| `src/unit-of-work.ts` | The SPEC-01 §4.2 wrapper: BEGIN → `set_config(..., true)` ×4 → read-back → commit/rollback, with poisoning and paging on mismatch |
| `src/cluster.ts` | Embedded cluster lifecycle + superuser bootstrap of the five roles |
| `test/isolation.test.ts` | T-07..T-15 plus the role matrix, SP-2 demos and the TDG-03 evidence |
| `evidence/` | Verbatim captured output. Nothing is claimed that is not in here |
