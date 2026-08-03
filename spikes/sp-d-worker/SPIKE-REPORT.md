# SPIKE-REPORT — SP-D · TDG-04 confirmation micro-spike (graphile-worker)

**Task:** OPUS-M1-003, step 0
**Gate under test:** **TDG-04** — queue technology (`graphile-worker`), SELECTED but UNCONFIRMED ([21-decision-resolution.md](../../docs/fable/21-decision-resolution.md) §3)
**Specs touched:** SPEC-01 §6 (job context), SPEC-11 §3.3 (`outbox_events` reconciliation), I-11
**Status of this document:** spike evidence. It closes nothing on its own; TDG-04 is closed by the orchestrator on the strength of it.

> **Every number in this document comes from one captured run:** [`evidence/harness-output.txt`](evidence/harness-output.txt), whose header records its timestamp. PIDs, pool ids, transaction ids and millisecond timings are **run-specific**. Structural figures (test counts, the four-hour lease, SQLSTATEs, table counts, "exactly once") are invariant.

---

## 1. Verdict

# **GO** — TDG-04 CONFIRMED, with four conditions

| Question the packet asked | Result | Evidence |
|---|---|---|
| **1. Transactional enqueue** — does the enqueue participate in the caller's transaction, so a rolled-back domain transaction enqueues nothing? | **YES** | E-1.1 / E-1.2 / E-1.3 / E-1.4 |
| **2. Durable lease** — is a job locked by a worker that dies re-executed after the lease expires? | **YES.** The lease is **4 hours**, hard-coded and not configurable | E-2.1 / E-2.2 / E-2.3 |
| **3. Crash-mid-job recovery** — SIGKILL mid-job: does the job re-run and complete with no orphaned state? | **YES**, exactly once | E-3.1 / E-3.2 |

**18/18 harness tests pass** against a real PostgreSQL 17.10 server, with real separate worker processes and real `SIGKILL`.

**The four conditions are in §5. None of them is a reason to reopen the selection**; all four are cheap, all four are things the implementation must do rather than things the library cannot do. The largest — a four-hour default recovery for a hard-killed worker — was measured, and a mitigation reducing it to **316 ms** was also measured (E-2.6), so it is a design obligation, not a residual risk.

**What would have made this NO-GO:** any of (a) an enqueue that survives a rolled-back transaction, (b) an enqueue that is lost when the transaction commits, (c) a job that a dead worker takes with it, (d) a crashed job that re-runs its externally visible effect twice. **None of the four occurred, in any experiment.**

---

## 2. Environment substitution (FAD-7)

Identical posture to SP-A. No Docker, no Homebrew, no sudo on this machine, so the cluster is **PostgreSQL 17.10**, the stock `postgres` executable, started user-space from `embedded-postgres@17.10.0-beta.17` on `127.0.0.1:55433` with a throwaway `.pgdata` inside the spike.

| | |
|---|---|
| **Why the substitution is sound here** | Everything the three questions turn on is server-side: transaction visibility, `for update skip locked`, generated columns, RLS, `LISTEN`/`NOTIFY`, interval arithmetic on `locked_at`. It is the same executable a container would run |
| **The part that is NOT substituted, and matters most** | The workers are **real separate OS processes** (`node --import tsx src/worker-child.ts`) and the kills are **real signal 9**. An in-process worker would only ever have proved that a promise was abandoned |
| **What it does not cover** | Container/orchestrator shutdown semantics (how long ECS actually waits between `SIGTERM` and `SIGKILL`), multi-host clock skew, and an external connection pooler — see §7 |

**Synthetic data only.** Three roles, two synthetic tables, fixture keys of the form `e2-reclaim`. No name from the research corpus appears anywhere. **No notification is sent and nothing leaves the machine**; the spike opens no socket except to `127.0.0.1:55433`.

---

## 3. What was built

```
spikes/sp-d-worker/
  src/config.ts          three of the five SPEC-01 §4.4 roles, ports, connection strings
  src/cluster.ts         embedded PostgreSQL lifecycle + cluster bootstrap
  src/domain.ts          the observed tables, the grants, and the E-0 remediation
  src/observe.ts         out-of-band observation + the ONE fault injector (ageLocks)
  src/child-handle.ts    spawn / signal / measure a real worker process
  src/worker-child.ts    the worker process: six tasks, pool registration, startup reclaim
  test/worker.test.ts    18 experiments (node:test)
  evidence/              verbatim captured output
```

Six tasks, each existing to make one thing observable: `spike.complete` (baseline), `spike.hold` (holds a job open until killed; ignores `abortSignal`), `spike.abortable` (well-behaved: gives the job up on `abortSignal`), `spike.suicide` (SIGKILLs its own process mid-job, after committing a run marker and before applying its effect), `spike.always_fails` (the I-11 contrast).

Three observed tables: `spike_domain_writes` (the domain change), `spike_effects` (the externally visible effect, primary-keyed on an idempotency key so a duplicate is a constraint violation rather than an argument), `spike_runs` (one row per invocation, written **before** anything else so an attempt that is killed still leaves a trace).

---

## 4. Findings

### 4.1 E-0 — graphile-worker's own schema is closed to every role but its owner (**unanticipated**)

The first run of the harness did not fail on any of the three questions. It failed on setup, with:

```
42501  new row violates row-level security policy for table "_private_tasks"
```

**graphile-worker creates all four of its tables with `ENABLE ROW LEVEL SECURITY` and defines no policy at all**, and its migrations contain **no `GRANT`**. RLS is not `FORCE`d, so the schema owner bypasses it and every other role is refused — regardless of how generous the grants are.

Measured (E-0.1, E-0.2):

| Role | Grants held | Result |
|---|---|---|
| `app_worker` | `SELECT, INSERT, UPDATE, DELETE` on every table in the schema | **Reads zero rows, silently.** graphile-worker logs `No tasks found; nothing to do!` and idles forever |
| `app_runtime` | none needed for the wrapper | `add_job` → **`42501`** |

**The silent half is the dangerous half.** A worker with grants but no policy does not crash; it starts, reports healthy, and processes nothing.

**Remediation, measured working (E-0.3):**

- **Consumer:** one named permissive policy per RLS-enabled table, `TO app_worker`, created by a loop over `pg_class.relrowsecurity` so a graphile-worker upgrade that adds a table cannot silently leave a hole. **Not** `DISABLE ROW LEVEL SECURITY` (non-bypass rule 3) and **not** `BYPASSRLS` on `app_worker`, which would hand it a bypass over every *tenant* table as well.
- **Producer:** a `SECURITY DEFINER` wrapper owned by the schema owner. `app_runtime` holds **no grant and no policy** on the queue tables and can only enqueue through the wrapper. `SET search_path = graphile_worker, public, pg_temp` — **`pg_temp` last**, for the reason migration 0001 spells out.

### 4.2 E-1 — the enqueue is transactional. **This is the property TDG-04 was selected for, and it holds.**

| # | Experiment | Result |
|---|---|---|
| E-1.1 | domain write + enqueue, then `ROLLBACK` | **0 jobs, 0 domain rows.** The wrapper had returned a real job id inside the transaction first, so `SECURITY DEFINER` demonstrably does **not** open a transaction of its own |
| E-1.2 | domain write + enqueue, then `COMMIT` | exactly 1 job (the id the wrapper returned) + 1 domain row, one `xid` |
| E-1.3 | enqueue, then the domain write fails its `CHECK` (`23514`) | **0 jobs.** An enqueue cannot outlive the mutation that justified it |
| E-1.4 | enqueue, and read from a second connection mid-transaction | **invisible.** A worker cannot pick up an uncommitted job |
| E-1.5 | commit, worker consumes | effect applied in **27 ms** |

### 4.3 E-2 — the lease is durable, and it is **four hours**

| # | Experiment | Result |
|---|---|---|
| E-2.1 | `SIGKILL` a worker holding a job | job **survives**, still locked, `attempts = 1` |
| E-2.2 | a second live worker, sweeping every 250–500 ms | did **not** touch the leased job for **4 008 ms** |
| E-2.3a | age `locked_at` to **3 h 59 m** | **not** reclaimed within 3 002 ms |
| E-2.3b | age `locked_at` to **4 h 01 m** | re-executed after **241 ms**, completed, **effect applied exactly once** |

The boundary is measured, not read off the source: the only thing manipulated is `locked_at`, which is exactly equivalent to letting the clock move forward, and the two probes bracket the boundary from both sides.

**The lease is hard-coded.** `interval '4 hours'` appears in `resetLockedAt()` and throughout graphile-worker's SQL. Only the **sweep interval** is configurable (`minResetLockedInterval` / `maxResetLockedInterval`, default **8–10 minutes**). There is no option to shorten the lease itself.

### 4.4 E-2.4 — **graceful shutdown does not release the in-flight job.** The sharpest edge found.

This experiment now asserts the opposite of what it was first written to assert, and establishing that took a 20-second timeout and a standalone diagnostic rather than a plausible-looking green test.

| # | Experiment | Result |
|---|---|---|
| E-2.4 | `SIGTERM` with an **`abortSignal`-aware** task in flight | The task observed the abort and threw. graphile-worker logged `Failed task 1 … attempt 1 of 25`. The process exited on its own re-raised `SIGTERM` in **512 ms**. **The job was still locked, with `last_error = null`, a full second later.** The failure was never written to the database |
| E-2.4b | `SIGTERM` with a task that **ignores** `abortSignal` | The process was **still alive after 6 026 ms** and the job still locked. A **second** `SIGTERM` (graphile-worker's forceful path) ended it in 14 ms |

**Consequence, and it is an operational one:** an ordinary rolling deploy strands **every in-flight job for the full four-hour lease**. This is not a crash path; it is the normal deployment path.

### 4.5 E-2.5 / E-2.6 — the mitigation, measured

| # | Experiment | Result |
|---|---|---|
| E-2.5 | `forceUnlockWorkers([deadPoolId])` | cleared the lease in **1 ms** — but it needs the dead pool's id, and graphile-worker keeps no registry of pools |
| E-2.6 | **a registry of our own** + `force_unlock_workers` at worker startup, before serving | stranded job recovered **end-to-end in 316 ms**, effect applied exactly once. **No clock was manipulated in this test** |

The registry is a table of ours: a row per pool at startup, `released_at` set on clean shutdown, anything still null is a pool that died without releasing. The pool id is generated inside `run()` and is not on the returned `Runner`; the only public route to it is the **`pool:create` event**, captured by passing an `events` emitter into `run()`.

**The narrow reading matters:** this reclaims pools *the registry knows about*. A cold, empty registry cannot reclaim a pool it never saw.

### 4.6 E-3 — crash mid-job recovers, exactly once

| # | Experiment | Result |
|---|---|---|
| E-3.1 | a task commits its run marker, then `SIGKILL`s its own process before applying its effect | domain row **committed**; effect **not** applied; job **durable and still locked**, `attempts = 1` |
| E-3.2 | replacement worker, lease expired | re-ran in **399 ms**, drained in 1 ms. **2 starts, 1 completion, effect applied exactly once**, no orphaned `_private_job_queues` lock, domain row untouched |

Exactly-once is a property of the **idempotency key**, not of the queue. graphile-worker's guarantee is **at-least-once**; E-3.2's second attempt would have applied a duplicate effect had the primary key not been there.

### 4.7 E-4 — I-11 holds

A job that always throws: `last_error` recorded, `attempts = 1/2`, retry scheduled — and **the committed domain row is untouched**. A notification/job failure does not roll back a domain change, because they are in different transactions by construction.

---

## 5. Conditions attached to the GO verdict

Each is a thing the OPUS-M1-003 implementation must do. None requires a library change.

| # | Condition | Because |
|---|---|---|
| **C-1** | The `graphile_worker` schema needs **explicit named policies for the consuming role** and a **`SECURITY DEFINER` enqueue wrapper for the producing role**, both in our own migration. The producing role gets no direct grant on the queue tables | §4.1. Without them the worker silently processes nothing |
| **C-2** | **A pool registry + startup reclaim**, per E-2.6 | §4.4. Otherwise a rolling deploy costs four hours of latency on every in-flight job |
| **C-3** | **Every job handler must honour `helpers.abortSignal`**, and the deployment must send `SIGTERM` twice (or set a kill deadline) | §4.4. A handler that ignores it does not exit on the first signal at all |
| **C-4** | **Every externally visible effect must carry an idempotency key.** graphile-worker is at-least-once and nothing in it changes that | §4.6 |

**Recorded, not a condition:** real KMS for checkpoint signing (TDG-15) remains a named CI/deployment condition; nothing in this spike touches it.

---

## 6. Ordering and idempotency — what we actually have

Stated plainly, because the packet asks for the guarantee we have rather than the one we would like.

| Property | What graphile-worker gives | What that means for SchedulePoint |
|---|---|---|
| **Delivery** | **At-least-once.** Retries on failure with exponential backoff; re-execution after lease expiry | Every effect needs an idempotency key (C-4) |
| **Ordering** | **None across jobs by default.** `getJobs` orders by `(priority, run_at)` and takes a batch `for update skip locked`, so concurrent workers interleave freely. A **named queue** (`queue_name`) serialises the jobs within it, and that is the *only* ordering primitive | Any handler needing per-entity order must use a named queue keyed by the entity. Note graphile-worker's own warning against high-cardinality queue names |
| **Enqueue atomicity** | **Exact**, inside the caller's transaction | The outbox property. Proven in E-1 |
| **At-most-once** | **Not available, and not requested** | — |

---

## 7. What this spike does NOT prove

| Gap | Why it is out of scope here |
|---|---|
| **Behaviour with RLS on the payload path** | The spike's tables are not tenant-scoped and carry no RLS. Tenant isolation is SP-A's and OPUS-M1-001's question, already answered; mixing it in would make a queue failure and an isolation failure hard to tell apart. The integration tests in OPUS-M1-003 exercise the real unit of work |
| **An external connection pooler** | Same gap SP-A recorded (§8.1 there). PgBouncer in transaction mode is untested against graphile-worker's `LISTEN`/`NOTIFY` use, which **is** session-scoped and is a known incompatibility class |
| **Orchestrator shutdown timing** | How long ECS actually waits between `SIGTERM` and `SIGKILL` is a deployment parameter, not measured here. C-2 and C-3 are written so the answer does not matter |
| **Throughput / scale** | No load test. The largest queue depth in any experiment is one job |
| **Multi-host clock skew** | The lease is a `now()` comparison evaluated on the server, so all workers share one clock here. A multi-writer topology is not in scope for M1 |
| **`cron` / scheduled jobs** | graphile-worker's crontab support is untouched |
| **The four-hour lease under real elapsed time** | E-2.3 ages `locked_at` rather than waiting four hours. The comparison is server-side arithmetic on that column, so the substitution is exact — but it is a substitution, and it is named here rather than left implicit |

---

## 8. Reproducing

```bash
cd spikes/sp-d-worker
npm install       # approves 2 postinstall scripts (esbuild, embedded-postgres binaries)
npx tsc --noEmit
npm test          # 18 tests, ~48 s, starts and stops its own PostgreSQL cluster
```

`SPIKE_PG_PORT` (default `55433`) moves the cluster if 55433 is taken. Nothing persists between runs; nothing needs tearing down by hand.

> **Spike code. It ships nowhere** (runbook §3). `src/worker-child.ts` is a reference for the production worker, not the production worker.
