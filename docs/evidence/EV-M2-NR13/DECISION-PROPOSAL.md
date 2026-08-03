# NR-13 — decision proposal

**Status: PROPOSED. Not ratified.** OPUS-M2-001 phase A stops here by instruction: the
refactor is written only after Fable ratifies this as a FAD entry. Nothing in this
document has been implemented.

**Evidence:** [`MEASUREMENTS.md`](MEASUREMENTS.md) and the eight captures beside it.
Every claim below cites a measured number; where a figure is a projection it is labelled
one in both documents.

---

## 1. The proposal in one paragraph

**Adopt S4: an immutable shared baseline, per-file owned tenants, and declared
non-tenant preconditions — with test-level state ownership inside each file.** Reject
per-test transactional rollback (S1) on the grounds that the architecture forbids it, not
that it is slow. Adopt dedicated organizations (S2) as one of S4's three layers rather
than as the whole answer, because four of the six measured couplings are not tenant-scoped
and S2 would not have caught them.

---

## 2. Why S1 is rejected — and it is not about speed

Per-test transactional rollback is the textbook answer, and the packet requires it to be
measured rather than waved away. It was measured, and the runtime is excellent: an empty
unit of work costs **0.3 ms** and a nested savepoint **0.047 ms**. Runtime was never the
obstacle.

Three structural results end it:

1. **E1 — a test-level transaction cannot span two tenants.** `runner.run` refuses to
   re-tenant a nested unit of work: `NestedTenantChangeError [NESTED_TENANT_CHANGE]`. That
   guard is I-15 and SPEC-01 §7.2 T-12 working as specified. But a cross-tenant isolation
   probe — Alpha writes, Beta must not see it — is *precisely* a test that touches two
   tenants. The strategy cannot express the thing this suite exists to prove.
2. **E2/E3 — a second backend cannot see the transaction.** A second pool and the
   superuser observation client each saw **0 rows** of the outer transaction's uncommitted
   marker. **20 of 24 api files** use at least one such second backend
   (`rollback-disqualification-census.txt`). Their writes commit independently and survive
   the rollback, so the rollback would isolate nothing while appearing to.
3. **At most 4 of 24 files remain candidates**, and E1 removes any of those four that
   assert across both organizations.

A strategy that applies to at most a sixth of the suite, and whose failure mode is *silent
non-isolation* in the other five sixths, is worse than the status quo: it would look like a
guarantee. **Rejected on evidence.**

For completeness, the two other mechanisms the evidence surfaced:

- **Truncate-and-reseed per file is unavailable.** TRUNCATE on `memberships`,
  `audit_events` and `audit_checkpoints` is refused with SQLSTATE 23001 by the append-only
  trigger (ADR-0019, non-bypass rule 6). `memberships` fails because the cascade reaches
  `audit_events`. The guarantee that makes the audit chain worth having forecloses this,
  correctly, and the right response is to keep the guarantee.
- **Per-file database clone (S3) works but costs more and buys less.** `CREATE DATABASE …
  TEMPLATE` 41.5 ms + `DROP DATABASE` 14.7 ms = **56.2 ms per file**, projecting ≈ 1.35 s
  onto a 14.5 s run, and it requires every test-support module to learn a per-file database
  name (`HARNESS_ENV` is a frozen module-level constant today). It remains the fallback if
  S4 proves insufficient; it is not the first choice.

---

## 3. Why S2 alone is rejected, and S4 proposed

S2 — a dedicated organization per mutating suite — is cheap and it works: **4.7 ms** per
fully-provisioned owned tenant, **113.5 ms** for one per existing api file, and **0
wrong-tenant rows** across the probes that had rows to see. It closes the largest measured
class: **11 of 24 files modify rows the seed created**, `memberships`/`organizations`/
`users` each by seven files — the freshness-counter bump that coupled X-07 in OPUS-M1-004.

But it does not close what was actually measured breaking. Of the **six** coupled tests
found across ten shuffle seeds, **four** depend on state a dedicated organization does not
isolate: an `outbox_events` row, an `outbox_effects` row, a queue job, a checkpoint
horizon, all established by a *sibling test in the same file and the same tenant*. Giving
that file its own organization changes nothing about them.

So S2 is **necessary and not sufficient**, and S4 is S2 plus the two layers that cover the
remainder.

---

## 4. S4, stated precisely

### Layer 1 — the shared MULTI baseline is read-only, and that is enforced

Alpha and Beta stay, seeded once in `globalSetup`, and **no test writes to them**. The
mutation census built for this measurement (`test/nr13/mutation-census.ts`) is promoted
from instrument to control: at the end of a run it asserts the baseline's rows are
byte-identical to the seed, and names any row that changed.

*Why enforced rather than asked:* eleven files modify seeded rows today. A convention that
eleven files already violate is not a convention.

### Layer 2 — a file that mutates owns its tenant

Any file needing to write provisions its own tenant in `beforeAll`. The MULTI provisioner
becomes a **factory** — `provisionMulti(runner, { slug })` returning a fully-shaped tenant
set with fresh UUIDs — rather than a singleton. This is deliverable C's shape, and A
specifying it is why the packet orders A first.

- **Fixture ownership:** the provisioning script is the sole owner of fixture content. A
  test file owns the *instance* it provisions and nothing else.

  > **Corrected after the independent second review.** This section originally said "RLS
  > makes that structural rather than aspirational". **That was false**, and the reviewer
  > disproved it by re-deriving a sibling fixture's identifiers from its slug — which is in
  > the source — and writing into that tenant. RLS scopes a connection to the context it
  > **declares**; it does not decide which context a caller may declare.
  >
  > What actually enforces ownership is two controls added in response: a **per-run slug
  > registry** that throws on duplicate registration, naming both owners, and a **per-run
  > nonce** folded into each owned fixture's effective slug so its identifiers cannot be
  > derived from the declared slug. RLS still does its own job — keeping a tenant's rows
  > invisible to a *different* declared context, proven at 24 concurrent tenants with zero
  > wrong-tenant rows — and that is a different guarantee from ownership.
- **Cleanup responsibility, stated precisely.** On a **normal** run — pass, fail, or thrown
  error — there is nothing to clean: the cluster is created and destroyed per run and no
  state outlives it. On a **SIGKILL**, teardown does not run and the data directory
  survives; the next run does not inherit it silently — it refuses to start and names the
  orphan process, the directory, and the recovery commands. So: no contamination in either
  case, and no *silent* contamination in the second. (The original wording, "none, by
  construction", overstated the second case; corrected after the independent review.)
- **Global `users` is the exception and is handled explicitly.** `users` is global
  (PO-DEC-06) with a **global** unique on `login_email`, so the factory mints
  `<slug>-<role>@example.invalid`. The prototype does this and 24 tenants provisioned
  without a 23505.

### Layer 3 — non-tenant shared state is declared and established, never assumed

Tenancy does not isolate the queue, the clock, or the process table. For each, the
discipline is the one OPUS-M1-004 arrived at for C-2 the hard way, generalised:

| Shared thing | Rule |
|---|---|
| graphile-worker queue (`_private_jobs`, `queue_pools`) | A file that runs a worker **establishes and then asserts** its precondition — M1-004's `drainQueue()` pattern, which empties the queue the way production does rather than with a `DELETE` |
| Audit chain head / checkpoint horizon | Per organization, so Layer 2 covers it — *provided* the file owns the tenant it checkpoints |
| Clock | No test asserts on wall-clock time. `crash-restart` measures real elapsed time deliberately and states so; that stays |
| Ports, data directory, processes | Unchanged — port per worktree, data directory derived from the port |
| Migrations | Unchanged — `up → down → up` once per run in `globalSetup` |

### Layer 4 — inside a file, each test owns its subject

The six measured couplings are all intra-file. Each of the six creates its own subject
instead of reading a sibling's. `outbox-dispatch.test.ts:320` gets particular attention: as
written, with its row absent the UPDATE matches zero rows and **succeeds**, so that
assertion cannot fail for the right reason in that ordering. Making it own its row fixes
the order dependence *and* the latent vacuity.

---

## 5. The proposal against every "must" in the packet

| Packet requirement | How S4 meets it | Evidence |
|---|---|---|
| Eliminate test-order dependence | Layer 4 removes the six measured cases; the gate (§6) keeps them gone | `coupled-test-population.txt` |
| Each test owns its state | Layers 2 and 4 — tenant per file, subject per test | prototype P1 |
| Standalone **and** full-suite execution | Standalone already passes 24/24; owned tenants add ~5 ms per file and no cross-file precondition | `per-file-standalone-and-mutation.txt` |
| No hidden dependence on queues, clocks, ports, migrations, processes, prior suites | Layer 3, item by item. **This is the layer S2 alone lacks, and four of six measured couplings live here** | `coupled-test-population.txt` |
| Define fixture ownership | Provisioning script owns content; the file owns its instance | §4 Layer 2 |
| Define cleanup responsibility | None required — per-run cluster + RLS invisibility. Stated, not implied | §4 Layer 2 |
| Works with embedded PostgreSQL and worktrees | No change to the cluster model; one cluster, more rows | `owned-tenant-prototype.txt` |
| Supports concurrent agents/developers | Unchanged: port per worktree, data directory derived from port | `env.ts`, unchanged |
| Regression tests reproducing the prior coupling class | §6 | — |

---

## 6. The regression class this must ship with

The packet requires "an order-shuffled full run and per-file standalone runs must both
pass". The measurements say that bar needs raising in one specific way:

**A single shuffled run is a weak detector — 4 of 10 seeds found nothing.** So:

1. **A fixed seed set, not one seed.** At minimum the seeds that are known to expose the
   six cases (7, 20260803, 31337, 123456, 20250101, 8675309), plus a rotating seed so the
   gate keeps finding new ones. Both file-order and test-order shuffling.
2. **Per-file standalone sweep**, all files, as OPUS-M1-004 established.
3. **Baseline-immutability assertion** (Layer 1's control) as part of every run.
4. **Red cases — each must FAIL before it may pass:**
   - a deliberately coupled pair of tests (the reference implementation of the old class)
     is caught by the shuffled gate;
   - a test that writes to the shared baseline is caught by the immutability control;
   - a test that assumes a drained queue without establishing it is caught (the C-2 shape);
   - a test whose assertion cannot fail when its subject is absent — the
     `outbox-dispatch:320` shape — is caught.

Red case 4 is the one worth insisting on. It is the vacuity class the packet's deliverable
B is built around, and NR-13's evidence produced a live example of it inside the existing
suite.

---

## 7. Cost of the migration, and of the decision being wrong

**Migration cost, from measured counts:**

| Item | Size |
|---|---|
| Files that must provision an owned tenant | **14** (the ones that mutate) |
| Tests that must own their subject | **6**, in 5 files |
| Test-support changes | MULTI provisioner → factory · `VALID_ORGANIZATIONS`/`VALID_PARTITIONS`/`impossibleCensusRows` stop hard-coding two organizations · baseline-immutability control · queue-precondition helper |
| Files needing no change | **10** (byte-identical readers) |
| Production-code changes | **none** — every file above is under `apps/api/test/**`, an allowed glob |

**Runtime cost:** ≈ **+113 ms** on a 14.5 s `api` run (**+0.8 %**, projected from the
measured 4.7 ms unit price), and ≈ +5 ms per standalone file.

**If this is wrong, how would we know?** The immutability control and the multi-seed
shuffle gate both fail loudly rather than silently — which is the property S1 lacked.
S3 (per-file database clone) remains available at a measured 56.2 ms per file if owned
tenants prove insufficient, and adopting S4 does not foreclose it.

---

## 8. Explicitly not claimed

1. **No converted suite has been measured.** All post-refactor wall-clock figures are
   projections from a measured baseline plus a measured unit price.
2. **No claim that file-level parallelism becomes possible.** Plausible, unmeasured, not
   offered as a benefit.
3. **Six coupled tests is a lower bound, not a census** — ten seeds is a sample.
4. **The prototype's isolation result covers 9 of 12 tenant tables.** Three were probed
   vacuously under its context; closing that is deliverable B's SBX-004 sweep.
5. **No escalation is implied.** The refactor as scoped needs no schema change, no gate
   change, no production-code change and no dependency change. If implementation shows
   otherwise, that is an escalation at that point, not a silent widening.

---

## 9. What ratification would decide

1. **S4 adopted, S1 rejected on the E1–E3 evidence** — or a different reading of that
   evidence.
2. **The shared baseline becomes read-only and enforced** — the single most invasive part,
   touching 11 files' current behaviour.
3. **The regression gate uses a seed SET plus a rotating seed**, not a single seed.
4. **Deliverable C's MULTI provisioner is a factory**, because Layer 2 depends on it.
5. **Red case 4 (an assertion that cannot fail when its subject is absent) is in scope for
   this task**, since NR-13 surfaced a live instance.

**Awaiting ratification. No refactor has been written.**
