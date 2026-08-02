# EV-M1-TENANCY — evidence bundle for OPUS-M1-001

**Task:** OPUS-M1-001 — Tenancy schema + SPEC-01 context middleware, end-to-end
**Branch:** `opus/m1-001-tenancy-context`
**Specs under test:** SPEC-01 §2 (context tuple), §3 (target binding), §4 (unit of work, RLS, roles), §5–§6 (surfaces), §7.1 and §7.2 (test contract)
**Status of this document:** captured evidence. It closes nothing on its own.
**Revision:** rewritten after the independent second review returned **REVISE**
(findings R-01..R-17). §6 records what that review found; §5 records what remains open.

> **Every figure below is taken from one captured run**, whose header records its
> timestamp. Backend PIDs, transaction counts and probe pass counts are run-specific and
> vary between runs. Structural figures — test counts, table counts, SQLSTATEs, gate
> verdicts, "zero wrong-tenant rows" — are invariant.

---

## 1. The files

| File | Command | Result |
|---|---|---|
| [`environment.txt`](environment.txt) | `uname -a`, `node --version`, `pnpm --version`, `git log` | PostgreSQL 17.10 via `embedded-postgres` (FAD-7), Node 24.18.0, pnpm 11.18.0 |
| [`migrate-cycle-output.txt`](migrate-cycle-output.txt) | `SP_TEST_PG_PORT=55444 corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | **exit 0** — up → down → up → down → up, 0 tables and 0 policies left behind |
| [`harness-output.txt`](harness-output.txt) | `corepack pnpm exec vitest run --project api --project domain --project contracts --reporter=verbose` | **exit 0** — 13 files, **183 tests passed, 0 failed** |
| [`pnpm-check-output.txt`](pnpm-check-output.txt) | `corepack pnpm check` | **12 gates, 12 passed, 0 failed** |
| [`red-cases-output.txt`](red-cases-output.txt) | `corepack pnpm red-cases` | **14 cases, 14 proven, 0 not proven** |

---

## 2. Headline results

- **183/183 tests pass**, split **133 `api` / 46 `domain` / 4 `contracts`** — each figure
  taken from its own `vitest run --project <name>` rather than apportioned by hand, which
  is how the previous revision of this document got the split wrong.
  `api` holds the SPEC-01 §7.1 and §7.2 batteries, the job surface, the red cases and the
  architecture scans; `domain` the pure validation sequence and the unit-of-work
  contract; `contracts` the wire schemas.
- **`corepack pnpm check`: 12/12 gates pass.**
- **`corepack pnpm red-cases`: 14/14 proven** — including the `unit` gate, which this task
  found and fixed (see §6).
- **T-15 storm: 900 iterations · 3 600 units of work · 3 087 committed · 513 injected
  faults (all exception-mid-transaction — see §5.3) · 10 800 tenant-table statements · 3 600 in-wrapper probe reads + 3 600
  outside-wrapper probe reads over all four tenant tables · census 15 partitions, 0
  impossible · **ZERO wrong-tenant rows**.** SPEC-01 T-15's stated bar is 10 000
  interleaved operations; that bar is met, not relaxed, and the count is asserted in the
  test so a shrinking storm fails rather than quietly passing.
- **Migration cycle clean**, and the `down` migration verified to leave **0 tables and 0
  policies** behind — not merely to run without error.

---

## 3. SPEC-01 §7.2 mapping (pooled-connection and failure-path isolation)

Every one of these runs against **`apps/api/src/db/unit-of-work.ts`**, the module the HTTP
surface uses. The spike's equivalents ran against spike code.

| SPEC-01 | Test | Result | Observed |
|---|---|---|---|
| **T-07** exception mid-transaction | `T-07` | ✔ | rollback; 0 marker rows; whole pool clean on all four tenant tables |
| **T-08** cancellation | `T-08` | ✔ | `pg_cancel_backend` → **57014**; rolled back; pool clean |
| **T-08b** client-side deadline | `T-08b` | ✔ | driver deadline, **no SQLSTATE** (asserted absent); rolled back |
| **T-09** server statement timeout | `T-09` | ✔ | **57014**; `statement_timeout` back to `0` after the transaction |
| **T-10** connection killed | `T-10` | ✔ | backend gone from `pg_stat_activity`; pool never re-issues it |
| **T-11** nested, same tenant | `T-11` | ✔ | savepoint; same backend; inner rolled back, outer committed |
| **T-12** nested, different tenant | `T-12` | ✔ | `NestedTenantChangeError` **before any statement**, for a different organization **and** a different group in the same organization; outer still commits |
| **T-13** outside any unit of work | `T-13` | ✔ | `app_runtime` and `app_worker`: 0 rows on **all four** tenant tables; `INSERT` → **42501**; `UPDATE`/`DELETE` affect 0 rows |
| **T-13b** group predicate, same org | `T-13b` | ✔ | Group Two invisible, unaddressable by id, unwritable; cross-group `INSERT` → **42501**; target verified unmodified |
| **T-14** statement-pooling mode | `T-14` | ✔ | all three consequences: (a) aborted, **body never ran**, 0 rows; (b) backend poisoned and destroyed, 12 later checkouts used other backends; (c) one alert at `severity=page` |
| **T-14b** partial context loss | `T-14b` | ✔ | only `app.group_id` dropped; **exactly one** mismatch reported, on `app.group_id`; same abort + discard + page |
| **T-15** two-organization storm | `T-15` | ✔ | see §2 |

**Additional:** X-01 (transaction affinity: one backend, one `xact_id`) · X-03 (pool reuse
across organizations, same backend, no bleed) · X-06 (composite tenant FK) · X-07
(organization-scoped context fail-closed on group-scoped rows) · X-09 (`SET LOCAL` reverts
the value, does not undefine the GUC) · X-10 (`SET LOCAL` is not parameterisable) · X-11
(tenant-qualified unique keys) · A-01..A-08 (environment; five-role matrix; RLS enabled
**and forced**; policy predicate shape; no `TRUNCATE`/`REFERENCES` on any tenant table for
any runtime role; RLS undisableable by the app role; support read-only; break-glass
genuinely differs) · the startup transaction-affinity assertion, in **both** directions.

---

## 4. SPEC-01 §7.1 mapping (cross-tab and stale context, over HTTP)

Executed through the production middleware, against the production schema.

| SPEC-01 | Test | Result | Observed |
|---|---|---|---|
| **T-01** | `T-01` | ✔ | **ONE principal holding memberships in BOTH Alpha groups.** Tab A's declared group honoured in the response *and* in ground truth; Group Two unchanged since Tab B's own write |
| **T-01b** *(added)* | `T-01b` | ✔ | the same dual-member principal is still refused a group it does not belong to — two memberships is not "every group" |
| **T-02** | `T-02` | ✔ *(status escalated)* | **no write, no event, no job enqueued.** Status **404**, not `409` — see §5 |
| **T-02b** *(added)* | `T-02b` | ✔ | active membership, advanced `membership_set_version` → **409 `CONTEXT_STALE`** with a re-fetch directive, no write |
| **T-03** | mutation + job enqueue | ◐ | two of five surfaces; three deferred — see §5 |
| **T-04** | `T-04` | ✔ | forged group → **404 byte-identical** to a non-existent group (body, status, `content-type`, `content-length`) **and** a `securityEvent: true` log line carrying step, code and declared group — with the diagnostic reason asserted **absent** from the response |
| **T-05** | `T-05` | ✔ | authorized actor, sibling-group target → **409 `CONTEXT_TARGET_MISMATCH`**, target verified unmodified |
| **T-05b** | `T-05b` | ✔ | unauthorized actor → **404, byte-identical** to a non-existent id (body, status, `content-type` and `content-length` all compared) |
| **T-06** | `T-06` | ✔ *(scope noted)* | `organization_version` advanced → **409 `CONTEXT_STALE`**, no partial effect — see §5 |
| **T-06b** | `T-06b` | ✔ | organization-scoped action accepted; `membership_id` resolved to the **organization** membership; `groupId` null |
| **T-06c** | `T-06c` | ✔ | group-only member attempting an organization-scoped action → **404** (P-9) |
| **T-06d** | `T-06d` | ✔ | group-scoped route with no declared group → **404** for every actor |

**Additional:** `SESSION_STALE` distinct from `CONTEXT_STALE` · 401 with no session · 400
with no context header (the path segment alone is not sufficient) · the shipped
`denyAllPrincipalResolver` denies · a forged organization id discloses nothing · an
authorized actor is still refused a target in another **organization** with a plain 404 ·
deny-by-default holds for the provisional policies (403, no write).

### 4.1 FAD-12 — authorization and mutation share one unit of work

The orchestrator's ruling that a re-evaluation and the mutation it authorizes must occupy
one transaction, on every surface. Three tests, in
`apps/api/test/http/context-surface.test.ts`:

| Property | How it is proven |
|---|---|
| **Structural** | A request opens **exactly two** transactions — the §2.3 resolution snapshot and the command — asserted as a count, so a future split back into three fails before anyone has to reason about the race |
| **Behavioural, interleaved** | A role revoked **between** the snapshot and the command → `403`, no write. The revocation is committed by a `beforeRun` hook on a runner subclass at a known call index, so the interleaving is exact rather than a sleep-and-hope |
| **Job surface** | The same interleaving on `/context-probe/enqueue` → `403`, **zero jobs enqueued** |

The middleware's resolution stays in its own read-only transaction — it must:
`app.membership_id` is *derived by* step 2 and cannot be set before it runs. The handler
therefore re-reads the acting membership rather than trusting the snapshot, which is also
what I-19 demands.

### 4.2 R-05 — `app_runtime`'s DML envelope

| Property | How it is proven |
|---|---|
| **Counters are not application-writable** | Column-level UPDATE grants exclude `organization_version`, `group_version`, `membership_set_version` and `session_epoch`; eight (role, counter) pairs checked, plus a live `42501` on an attempted write |
| **Counters are monotonic** | A decrease raises `restrict_violation` (23001) — for a superuser too. Clamping was rejected: it would hide the bug that caused it |
| **Counters are trigger-maintained** | A status change advances `organization_version`; a `name`-only update does not. A membership role change advances the user's `membership_set_version`; a `last_active_at` touch does not (SPEC-01 §2.1 V-08: a routine edit must not make `409 CONTEXT_STALE` routine) |
| **No hard delete** | DELETE is granted to **no** role on **any** of the four tables — 16 (role, table) pairs — and an attempted delete inside a correct unit of work is `42501`. Stronger than "affects zero rows" |
| **The bump enforces the unit of work** | A privilege-bearing membership change **outside** a unit of work is refused (23001). See §6.2 — this was a design change forced by a measurement |

---

## 5. What is NOT proven here

Recorded plainly, because a bundle that overstates its coverage is worse than a smaller
one. Items marked **(carried)** are accepted follow-ups with a named owner.

### 5.1 Scope and coverage

| Gap | Detail |
|---|---|
| **T-03: three of five surfaces** | **Covered:** mutation, job enqueue. **Deferred:** publication (SPEC-05's milestone), report request and document upload (SPEC-09's), WebSocket command (SPEC-01 §5 / SPEC-02's). None of those surfaces exists yet. Each must run this same table when it lands; because they share one context path, that is a wiring test rather than a re-implementation |
| **T-02's status code** | Ruled in favour of §2.3 + §2.4 (`404` for a departed member) as **FAD-11**; SPEC-01's T-02 row is being amended on `main`. `T-02b` covers the unambiguous half |
| **T-06 is the context half only** | `organization_version` is a SPEC-06 §4 entitlement-change counter, so the long-open submission fails closed at step 4 with no partial effect. The `entitlements` table and the L1 `NOT_ENTITLED` denial are OPUS-M1-002's |
| **Authorization is a placeholder** | An exact-match role allow-list per route, deny-by-default, no wildcard. SPEC-06's fourteen-step truth table is OPUS-M1-002. Every layer it adds can only remove access |
| **No authentication** | The shipped principal resolver denies everything. The test resolver exists only in `test/support` and no code under `src/` can construct it — asserted by the architecture scan |
| **No audit rows** | Mutations are *shaped* for audit emission — one unit-of-work boundary, stable event names — but nothing is written. OPUS-M1-003 |
| **I-10 has no new coverage** | The request-budget gate still measures only the two shell interactions from M0. The five context-probe routes are server-side and unreachable from the browser bundle, so no new budgeted interaction exists to measure. When a UI slice calls one of them, it must add its interaction to `scripts/gates/request-budget/budgets.json` |

### 5.2 Security residuals, open and owned

| # | Residual | Owner |
|---|---|---|
| **1** | **Cross-organization user attach — confidentiality *and* availability, the second one irreversible.** `memberships_organization_scope`'s WITH CHECK constrains `organization_id` and `group_id`; it never inspects `user_id`, and it cannot — `users` carries no tenant column by PO-DEC-06's design. An actor that reaches a membership INSERT can attach **any** user to its organization and then read them. The `users` RLS policy is a control against a **read-only** actor, not a writer; the migration's docblock said otherwise and has been corrected. **The INSERT also fires the counter trigger, which increments the FOREIGN user's `membership_set_version` as owner.** That counter is monotonic by construction — a decrease raises `restrict_violation` even for a superuser — so the bump **cannot be undone**, not by deleting the membership and not by an administrator. An Org-A actor holding an Org-B user's UUID can repeat the attach at will and force that user into `409 CONTEXT_STALE` from outside their organization, permanently | OPUS-M1-002 (SPEC-06 L4.2 on user administration) — no mechanism change proposed |
| **2** | **Global user-id existence oracle** at the membership-creation edge. `memberships.user_id REFERENCES users (id)` is checked outside RLS, so an INSERT naming a non-existent user raises 23503 while one naming an existing-but-invisible user succeeds | OPUS-M1-002 (capability gate on the INSERT) |
| **3** | **`login_email` uniqueness.** Globally unique because it is the authentication identity and cannot be tenant-qualified without breaking global login. Mitigated per SPEC-01 §4 amendment (b): 23505 is translated to a generic error at the edge, and no route inserts a user | standing; keep both mitigations |
| **4** | **Self role escalation** — an actor with UPDATE on `memberships` in its own group can raise its own role. An application-layer gate, not a database one **(carried)** | OPUS-M1-002 deny-path test |
| **5** | **EX-2's capability gate is above the database.** A policy on `memberships` that queries `memberships` is infinite recursion in PostgreSQL; the non-recursive relations that can carry the test arrive with the evaluator. The organization boundary **is** enforced in SQL today | OPUS-M1-002 |
| **6** | **Resolution-grant breadth.** The §2.3 snapshot transaction runs with the organization-scoped read grant before step 2 has decided anything. Safe for the four reads it performs, none of which returns anything to the caller; the breadth itself is on the design-review list **(carried)** | OPUS-M1-002 |
| **7** | **Self-service tenant creation.** `GRANT INSERT ON organizations` lets any unit of work insert an `organizations` row for the id it declared — the `WITH CHECK` is `id = app.organization_id`, so a caller that declares a fresh UUID can create that organization. Inert today: the new row has no memberships, so nothing is reachable through it, and DELETE is granted nowhere so the debris cannot be cleared either. Recorded because it was unrecorded, not because it is currently exploitable | the provisioning design in M1's later slices, gated by OPUS-M1-002 |

Residuals 1 and 2 are **documented by passing tests** (`roles-and-schema.test.ts`,
describe block "residuals this milestone leaves open"). Each one passing means the
residual is still real — a red baseline left deliberately red-side-up, so M1-002's gate
has something to flip.

### 5.3 Method and measurement

| Gap | Detail |
|---|---|
| **No external pooler** | Only the in-process `pg.Pool` was exercised. Statement-level pooling is **simulated** at the driver boundary, which is strictly more detectable than the worst real case. If the deployment puts PgBouncer/pgcat/RDS Proxy in front of PostgreSQL, TDG-03 needs a follow-up spike against that product (SPIKE-REPORT §8.1). The startup assertion is the load-bearing control either way |
| **The storm exercises ONE fault kind** | T-15 injects **exception-mid-transaction** only. Cancellation (T-08), client deadline (T-08b), server timeout (T-09) and connection kill (T-10) are each proven individually, but **not under concurrent two-organization load**. A multi-fault storm is a named **M1-exit follow-up** **(carried)** |
| **Fault schedule is deterministic** | Faults fire on a fixed modulus, not a seeded RNG. Reproducible, but it explores one interleaving pattern rather than sampling many |
| **Timing equality is not measured** | T-04 and T-05b assert byte-identical bodies, statuses and headers, and the unauthorized code path issues exactly the same queries as a non-existent id. Wall-clock equality is argued from the code path, not measured |
| **`authorization_version` is an encoding, not a hash** | SPEC-06 §4 says "hash". A canonical injective encoding gives the property the spec needs (differs whenever any input differs) with no collision risk and no hash dependency in a package that imports nothing. Wording reconciliation is with the orchestrator **(carried)** |

## 6. Three things that were wrong, and how they were found

None of these was found by reading the code. Each was found by a check that could fail.

### 6.1 A gate that could not fail

`corepack pnpm red-cases` reported `unit … NOT PROVEN` partway through the task.

**`embedded-postgres` registers a graceful-shutdown hook through `async-exit-hook`, which
hooks `beforeExit` with code `0` and calls `process.exit(0)` on a natural exit —
discarding `process.exitCode`.**

```
$ node -e "import('embedded-postgres').then(() => { process.exitCode = 1 })"
$ echo $?
0
```

With the package imported into Vitest's main process, `vitest run` printed
`1 failed | 232 passed` and **exited 0**. The `unit` gate — one of the twelve in
`pnpm check` — reported PASS on a failing suite.

**Fix:** the package is imported by exactly one module (`test/support/cluster.ts`),
imported by exactly one module (`test/support/cluster-daemon.ts`), which runs as a **child
process**. Two tests hold it: `embedded-postgres-isolation.test.ts` asserts the import
graph, and the red case in `gates-fail-on-violations.test.ts` asserts the *consequence*
three ways. The hazard test asserts the **mechanism** — importing the package installs an
`async-exit-hook` `beforeExit` listener (0 → 1) — and *logs* the symptom it produces
(a failing run in that process exited 0) rather than asserting it, so an upstream fix
turns the test into a signal to revisit the isolation instead of a red build somebody
deletes under time pressure. The two genuine red cases assert outcomes: no import → exits
1, and a failing spec through the **real api project** → exits 1. The hazard is specific to Vitest's **main** process; a `setupFiles`
import runs in a worker and masks nothing, which is why child-process isolation is a
complete fix rather than a partial one.

**This also bears on EV-M0-SPA.** The SP-A spike ran `node:test` through `tsx` in a
process that imported the package, so its `npm test` exit code was subject to the same
masking. The spike reported 36/36 and its per-test log is intact, so no failure was
hidden — but the *property* "the spike's test command fails when a test fails" was not
established there.

### 6.2 An owner exemption that cannot work

R-05 required the freshness counters to be trigger-maintained. The first implementation
gave the schema owner an **UPDATE-only** RLS exemption on `users`, so the SECURITY DEFINER
trigger could advance `membership_set_version` for a membership change made without tenant
context. Its own test failed, and the probe explains why:

```
as app_migrator, no tenant context:
  update users set membership_set_version = membership_set_version + 1 where id = $1
  -> rowCount 0
  update users set updated_at = now() where id = $1
  -> rowCount 0
```

**An UPDATE that reads columns — in `SET` or in `WHERE` — has the SELECT policy applied to
its row lookup.** The only way to make the out-of-context bump succeed would be to let the
owner SELECT every user row without a tenant context, which is precisely the property A-04
asserts.

**Resolution:** the exemption was removed and the consequence embraced. A
privilege-bearing membership change **outside a unit of work is refused** — it already
violated I-15 and non-bypass rule 1, and failing loudly beats committing a privilege change
with a stale counter, which would make every later `409 CONTEXT_STALE` decision wrong. The
trigger became an enforcement point for the unit of work rather than a passive maintainer.
A test asserts there is no owner-exempt policy on `users`, so the idea cannot quietly
return.

### 6.3 A harness that deleted its own database

The exit-code red case spawns a second harness on `SP_TEST_PG_PORT=55455`. `pnpm check`
then failed with `could not open file "global/pg_filenode.map"`: the data directory path
was a **constant**, so the child's `fresh: true` startup `rm -rf`'d the running parent's
data directory.

`SP_TEST_PG_PORT` was documented as the way two worktrees avoid sharing a database
(execution standards §E) and was a half-measure. The directory is now derived from the
port, so a distinct port means a genuinely distinct instance.

## 7. Reproducing

```bash
corepack pnpm install
corepack pnpm check                                                 # 12 gates
corepack pnpm red-cases                                             # 14 cases
corepack pnpm exec vitest run --project api --reporter=verbose      # the harness alone
corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded    # up -> down -> up
```

Every run starts from a **destroyed and re-initialised** data directory, so there is no
state to carry between runs. `SP_STORM_ITERATIONS` overrides the storm loop count
(default 900); `SP_TEST_PG_PORT` moves the cluster off `55433`, which is required when two
worktrees run at once.
