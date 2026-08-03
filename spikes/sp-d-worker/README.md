# SP-D — TDG-04 confirmation micro-spike (graphile-worker)

Throwaway evidence for **OPUS-M1-003, step 0**. Answers three questions about
`graphile-worker` before the job runner becomes load-bearing:

1. **Transactional enqueue** — does a rolled-back domain transaction enqueue nothing?
2. **Durable lease** — is a job locked by a worker that dies re-executed after the lease expires, and how long does that take?
3. **Crash-mid-job recovery** — after `SIGKILL`, does the job re-run and complete with no orphaned state?

**Read [SPIKE-REPORT.md](SPIKE-REPORT.md) for the GO/NO-GO verdict, the four
attached conditions, and the sharp edges.** This file only says how to run it.

> **Spike code. It ships nowhere** (runbook §3).

## Run

```bash
npm install          # approves 2 postinstall scripts (esbuild, embedded-postgres binaries)
npx tsc --noEmit
npm test             # 18 tests, ~48 s
```

Each command starts and stops its own PostgreSQL 17.10 cluster from a freshly
initialised data directory. Nothing persists between runs.

| Env var | Default | Effect |
|---|---|---|
| `SPIKE_PG_PORT` | `55433` | Port for the embedded cluster |

## No Docker here

Per **FAD-7** the cluster is the real `postgres` executable run user-space via
`embedded-postgres`. SPIKE-REPORT §2 explains why that does not weaken the
evidence, and §7 lists what it genuinely cannot cover. The workers are **real
separate OS processes** and the kills are **real signal 9** — that part is not
substituted, and it is the part the crash questions depend on.

## Layout

| Path | What |
|---|---|
| `src/cluster.ts` | Embedded cluster lifecycle + superuser bootstrap of three roles |
| `src/domain.ts` | The observed tables, the grants, and the E-0 remediation (policies + `SECURITY DEFINER` enqueue wrapper) |
| `src/worker-child.ts` | The worker process: six tasks, pool registration, startup reclaim |
| `src/child-handle.ts` | Spawn / signal / measure a real worker process |
| `src/observe.ts` | Out-of-band observation and the one fault injector (`ageLocks`) |
| `test/worker.test.ts` | 18 experiments, E-0 through E-4 |
| `evidence/` | Verbatim captured output. Nothing is claimed that is not in here |

**The experiments are order-dependent** (`--test-concurrency=1`, set in
`package.json`): E-0 applies the remediation everything after it needs, and
E-2.2/E-2.3 and E-3.2 deliberately continue from the state their predecessor
left.
