# EV-M2-NR13 — measurements

**OPUS-M2-001, phase A.** Every number below was produced by a command in this bundle
and is reproducible from it. Where a figure is a **projection** from a measured unit
price rather than an end-to-end measurement, it says so in the same sentence.

- **Baseline commit:** `29d90b7` (worktree `.worktrees/m2-001`, branch `opus/m2-001-sbx-harness`)
- **Host:** Mac16,8 · 12 cores · 24 GiB · macOS 26.5.2 · node v24.18.0 · PostgreSQL 17.10 (embedded, FAD-7 substitution)
- **Discipline:** every run serial. The embedded cluster's port is derived per worktree and its
  data directory from the port, so two concurrent runs measure contention rather than code
  (the runbook's standing merge/port hygiene). Cost-model and prototype runs used
  `SP_TEST_PG_PORT=55439` so they could not collide with a suite run even by accident.

---

## 0. The baseline is green before anything was measured

`corepack pnpm check` at `29d90b7`, from clean: **12 gates, 12 passed, 0 failed**;
36 test files, 551 tests, all passing; 50.42 s wall (`unit` gate 38.199 s). Captured in
`baseline-check.txt`.

---

## 1. What the current strategy costs, and what it hides

| Measurement | Value | Source |
|---|---|---|
| Full workspace suite, 3 repetitions | **34.67 / 34.17 / 35.07 s** (551 tests, 36 files) | `baseline-and-shuffle.txt` §A |
| `api` project alone, 3 repetitions | **14.40 / 14.56 / 14.73 s** (339 tests, 24 files) | §B |
| Every api file run **alone**, one at a time | **24 of 24 pass**; total **51.44 s** | `per-file-standalone-and-mutation.txt` |
| Worst three files standalone | `red-cases/gates-fail-on-violations` **5.33 s** · `tenancy/unit-of-work` **4.92 s** · `audit/periodic` **4.78 s** | same |
| Median file standalone | ≈ **1.7 s**, of which ≈ 0.79 s is database fixed cost (§3) | same |

**Order dependence, measured rather than assumed.**

| Mode | Result | Source |
|---|---|---|
| File-order shuffle, seeds 20260803 / 424242 / 7 | **all pass** | `baseline-and-shuffle.txt` §C |
| …and the shuffle was real | **23 of 24 positions hold a different file** on every seed | `order-dependence.txt` §2 |
| Intra-file test-order shuffle, 10 seeds | **6 of 10 seeds RED**; 1–5 failures each | `coupled-test-population.txt` |
| Union across those 10 seeds | **6 distinct tests in 5 files** do not own their state | same |
| Repeatability of seed 20260803 | **3 of 3 repeats**, identical three failures | `order-dependence.txt` §4 |

The non-vacuity check in the second row is the load-bearing one: without it, "the shuffled
run passed" would be consistent with the shuffle having done nothing.

**Where the coupling actually lives.** All six are *within* a file — a test reading state a
sibling test in its own `describe` established. Diagnosed by reading each, in
`order-dependence.txt` §3. One of them is worse than order-dependent:
`outbox-dispatch.test.ts:320` UPDATEs a row a sibling test creates and expects SQLSTATE
23514; with the row absent the UPDATE matches zero rows and **succeeds**, so in that
ordering the assertion cannot fail for the right reason.

**The mutation footprint — how much shared state each file changes.** Measured by digesting
every row of every table after the seed and again after the file finished
(`test/nr13/mutation-census.ts`):

| Class | Count | Files |
|---|---|---|
| Leave the fixture **byte-identical** | **10 of 24** | `architecture/*` (2) · `audit/architecture` · `audit/payload-closedness` · `authz/fail-closed-guard` · `authz/loader-cross-checks` · `http/route-declarations` · `red-cases/*` (2) · `server` |
| Change the fixture at all | **14 of 24** | the rest |
| **Modify rows the seed created** (the coupling class) | **11 of 24** | `crash-restart` · `emission-coverage` · `outbox-dispatch` · `entitlement-in-force` · `http-authorization` · `no-explanation-leaks` · `authz/schema` · `context-surface` · `job-context` · `roles-and-schema` · `unit-of-work` |
| Largest appenders | `http-authorization` +56 rows · `crash-restart` +49 · `outbox-dispatch` +33 · `periodic` +30 · `chain` +25 | |

`memberships`, `organizations` and `users` are each modified in place by seven files —
that is the freshness-counter bump that coupled X-07 during OPUS-M1-004.

---

## 2. Is per-test transactional rollback available at all?

Four experiments against the real wrapper (`test/nr13/rollback-feasibility.ts`,
captured in `rollback-feasibility.txt`). **The runtime question turned out not to be the
question.**

| # | Experiment | Result |
|---|---|---|
| **E1** | One test-level transaction spanning **both** fixture organizations | **REFUSED** — `NestedTenantChangeError [NESTED_TENANT_CHANGE]: a nested unit of work may not re-tenant` |
| **E2** | A **second pool** observing the outer transaction's uncommitted rows | **INVISIBLE** — 0 rows |
| **E3** | The **superuser** observation client (census, fault injection) | **INVISIBLE** — 0 rows |
| **control** | The marker row after the rollback | **0 rows** — so E2/E3 measured invisibility, not a failed INSERT |
| **E4** | Cost of the nesting itself, 200 iterations | outermost **0.329 ms**, nested savepoint **0.047 ms** |

E1 is decisive and it is not a limitation of the test harness: it is I-15 and the
`NestedTenantChangeError` guard doing exactly what SPEC-01 requires. A per-test
transaction is therefore **per-tenant, not per-test**, and a cross-tenant isolation probe —
which is what most of this suite *is* — cannot be wrapped in one.

E2/E3 remove what E1 leaves. Counted file by file in
`rollback-disqualification-census.txt`: **20 of 24 api files** construct a second
`Runtime`, probe outside the unit of work, grab the whole pool, use the superuser
observation client, spawn a child process, or run a graphile-worker job. Each of those
runs on a different backend, cannot see the test-level transaction, and commits
independently of it. **At most 4 of 24 files remain candidates**, and E1 then removes any
of those four whose assertions span both fixture organizations.

---

## 3. Unit prices for every candidate

`test/nr13/cost-model.ts`, captured in `cost-model.txt`. Fresh cluster per invocation, so
these are **cold** numbers.

| Fixed, once per run | ms |
|---|---|
| `startClusterDaemon` (initdb + start, fresh data directory) | **496.3** |
| `bootstrapCluster` (5 roles + database) | 102.7 |
| `migrateCycle` up → down → up | 107.1 |
| `installQueueSchema` | 32.6 |
| `seedFixture` (MULTI: 2 organizations) | 22.5 |
| `seedAuditAndOutbox` | 22.6 |
| **total database fixed cost** | **≈ 784 ms** |

| Per unit | n | median ms |
|---|---|---|
| Provision **one more organization** (2 groups, 1 admin, full `provisionAuthorization`) | 10 | **2.7** |
| Provision **one full owned tenant** (adds a group scheduler, a grant, an audited + published event) | 24 | **4.7** |
| An **empty unit of work** (BEGIN + 4 × `set_config` + read-back + COMMIT) | 200 | **0.3** |
| `CREATE DATABASE … TEMPLATE` | 5 | **41.5** |
| `DROP DATABASE` | 5 | **14.7** (one 251 ms outlier) |

**A per-file "wipe and reseed" is not available on this schema.** TRUNCATE, attempted as
superuser inside a rolled-back transaction:

```
memberships:        REFUSED — 23001: TRUNCATE on audit_events is refused (cascade)
audit_events:       REFUSED — 23001 (ADR-0019, non-bypass rule 6)
audit_checkpoints:  REFUSED — 23001
outbox_events:      accepted
```

`memberships` is refused because the cascade reaches `audit_events`. The append-only
guarantee that makes the audit chain worth having also makes truncation-based fixture
reset structurally impossible — correctly.

---

## 4. The recommended mechanism, prototyped at the real file count

`test/nr13/owned-tenant-prototype.ts`, captured in `owned-tenant-prototype.txt`. One owned
tenant per existing api test file, in one cluster, alongside the unchanged shared baseline.

| | |
|---|---|
| Owned tenants provisioned | **24** |
| Per tenant | min 4.2 ms · **median 4.7 ms** · max 6.3 ms |
| **Total added to a run** | **113.5 ms** |
| Cross-tenant probes (tenant × table, from inside each tenant's own unit of work) | 288 |
| **Worst wrong-tenant row count across every probe** | **0** |

**Recorded honestly:** 3 of the 12 tables (`capability_grants`, `audit_checkpoints`,
`outbox_effects`) show `0 visible` under this prototype's organization-scoped,
`app_runtime` context, so those probes are vacuous *here*. P2 establishes zero leakage on
the **nine** tables with rows actually visible and establishes nothing on the other three.
Closing that is deliverable B's job (the SBX-004 sweep probes every role and context
class), not this prototype's.

---

## 5. The comparison

Wall-clock figures marked **(projected)** are the measured baseline plus a measured unit
price, not an end-to-end measurement of a converted suite. Nothing here was estimated by
judgement.

| | **S0** status quo | **S1** per-test transactional rollback | **S2** dedicated organizations per mutating suite | **S3** per-file database clone from a template | **S4** hybrid *(recommended)* |
|---|---|---|---|---|---|
| **Full-suite wall clock** | 14.5 s api / 34.6 s workspace *(measured)* | **cannot be stated** — the strategy cannot express the suite (E1–E3) | ≈ 14.6 s api *(projected: 14.5 s + 113 ms)* | ≈ 15.9 s api *(projected: 14.5 s + 24 × 56.2 ms)*, plus an unmeasured loss of pool warmth | ≈ 14.6 s api *(projected, same basis as S2)* |
| **Standalone worst file** | 5.33 s *(measured)* | unchanged in principle; unmeasurable in practice | 5.33 s + ~5 ms *(projected)* | 5.33 s + ~56 ms *(projected)* | 5.33 s + ~5 ms *(projected)* |
| **Isolation guarantee** | none structural — 11 files modify seeded rows | would be strong **if applicable**; applies to **at most 4 of 24 files** | RLS, per organization — proven 0 wrong rows on 9 tables at 24 tenants | total, per file | RLS per organization **plus** an enforced immutable baseline **plus** declared non-tenant preconditions |
| **Covers non-tenant shared state** (queue, clock, global `users`, processes) | no | no | **no** — tenancy does not isolate the queue | yes | **yes, by explicit declaration** — the only candidate that addresses it |
| **Embedded PG per worktree** | works | works | works — one cluster, more rows | works, but every support module must learn a per-file database name (`HARNESS_ENV` is a frozen module constant) | works — no change to the cluster model |
| **Concurrent agents / worktrees** | works (port-derived data dir) | works | works | works | works |
| **Migration cost across the suite** | — | **not payable** | 14 files (those that mutate) + the MULTI provisioner becomes a factory + `VALID_ORGANIZATIONS`/`impossibleCensusRows` stop hard-coding two organizations | concentrated in ~5 support modules, but changes how every file connects | 14 files + 6 tests (intra-file state ownership) + the same support changes as S2 + a baseline-immutability guard |
| **Catches the 6 measured couplings** | — | no (they are intra-file and not all tenant-scoped) | **no** — 4 of the 6 are queue/checkpoint/sibling-row, not cross-tenant | yes for all 6 | **yes for all 6** |

### Why S2 alone is not enough — the evidence, not a preference

Of the six measured coupled tests, **only two** are about tenant rows. The other four are
about state a dedicated organization does not isolate:

| Coupled test | What it actually depends on | Does a dedicated organization fix it? |
|---|---|---|
| `crash-restart` "exactly once" | an `outbox_events` row a sibling test dispatched | no — same organization either way |
| `outbox-dispatch` "failure is a CODE" | an `outbox_events` row a sibling test created | no |
| `outbox-dispatch` "effect row is append-only" | an `outbox_effects` row a sibling test created | no |
| `periodic` "second sweep writes nothing" | the checkpoint horizon a sibling test advanced | no |
| `chain` "R-04 checkpoint over a hash the chain never had" | chain head position | partly |
| `http-authorization` "A-12 overlapping grant window" | a grant a sibling test wrote | partly |

S2 is necessary — it closes the 11-file seeded-row-modification class that the mutation
census measured — and it is **not sufficient**. That is the whole argument for S4.

---

## 6. What was NOT measured

Stated so nothing here is read as more than it is.

1. **No converted suite was measured end to end.** The 14.6 s figures are projections from
   a measured baseline plus a measured unit price. The refactor has not been written; that
   is deliberate — phase A stops at the proposal.
2. **S3 was priced but not built.** `CREATE DATABASE … TEMPLATE` and `DROP DATABASE` are
   measured; a suite actually running that way is not.
3. **No claim is made that file-level parallelism becomes possible under S4.** It is
   plausible and it is not measured, so it is not offered as a benefit.
4. **One machine, one OS, one PostgreSQL build.** All suite runs were warm (pnpm store
   populated, first run discarded by taking three repetitions); all cost-model runs were
   cold (fresh initdb per invocation). No run overlapped another.
5. **Ten shuffle seeds is a sample.** 6 of 10 found something, so 6 coupled tests is a
   **lower bound** on the population, not a census.
