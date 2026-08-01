# SPIKE-REPORT — SP-A / SP-1 / SP-2 · Tenant-isolation unit of work

**Task:** OPUS-M0-001
**Gates under test:** TDG-02 (data-access layer), TDG-03 (connection pooler mode)
**Specs:** SPEC-01 §4 (normative), SPEC-01 §7.2 T-07..T-15, SPEC-15 SP-1 / SP-2
**Status of this document:** spike evidence. It closes nothing on its own; TDG-02 and TDG-03 are closed by the orchestrator on the strength of it.

> **Every number in this document is taken from one specific captured run:** `evidence/harness-output.txt`, whose header records its timestamp. Backend PIDs, transaction counts, statement totals and probe-pass counts are **run-specific and vary between runs** — the storm's probe loop is time-sliced against the workload, so its pass count depends on machine speed. Structural figures (test counts, table counts, SQLSTATEs, partition validity, "zero wrong-tenant rows") are invariant.

---

## 1. Verdicts

| Gate | Verdict | Conditions |
|---|---|---|
| **TDG-02** — Kysely + `pg` as the data-access layer | **CONFIRM** | Three, all cheap, all listed in §7 |
| **TDG-03** — in-process `pg.Pool`, transaction affinity | **CONFIRM** for the in-process pool. **Statement-level pooling re-confirmed as prohibited** | An **external** pooler (PgBouncer/pgcat) was *not* exercised — see §8.1 |

**Recommendation: do not reopen TDG-02 or TDG-03.** Every capability the two gates require was demonstrated against a real PostgreSQL 17.10 server, and every failure mode SPEC-01 §4 anticipates was injected and observed to fail closed. The findings in §6 are corrections to *how the design is spelled*, not to the design.

**Headline result:** **36/36 harness tests pass.** The two-organization storm ran **1 000 units of work / 6 256 server-side transactions / 13 408 tenant-table operations** across two organizations and four groups on a 3- and a 2-connection pool, with 252 injected faults and a continuous probe sweeping **all eight tenant tables** both inside and outside the wrapper (5 704 in-wrapper table reads + 5 704 outside-wrapper table reads). **Zero wrong-tenant rows were observed anywhere, in any probe, at any point,** and the final ground-truth census across all eight tables found **30 partitions, every one of them legitimate**.

---

## 2. Environment substitution (FAD-7) — read this before reading the evidence

The packet specifies a **docker-composed PostgreSQL**. The execution machine has **no Docker, no Homebrew and no sudo**. Per FAD-7 the orchestrator authorised the `embedded-postgres` npm package instead.

| | |
|---|---|
| **What actually ran** | `PostgreSQL 17.10`, the stock `postgres` executable, started user-space on `127.0.0.1:55432` with a throwaway data directory inside the spike |
| **Package** | `embedded-postgres@17.10.0-beta.17` (MIT), platform binaries from `@embedded-postgres/darwin-arm64` |
| **Version-line note** | The npm package has **never published a non-beta**; the `-beta.N` suffix is the *wrapper's* versioning while the leading `17.10.0` is the **bundled PostgreSQL version**, which is a stable PostgreSQL release. `17.10.0-beta.17` is the newest 17.x, i.e. the closest available thing to "stable 17.x line, not a beta" |
| **Binary** | Universal Mach-O; the **arm64 slice** executes natively. `version()` reports the `x86_64-apple-darwin24.6.0` *build triple*, which is a compile-time string, not the running architecture |
| **Why the substitution is sound** | RLS evaluation, `SET LOCAL` / `set_config` lifetime, GUC reset semantics, role attributes, `FORCE ROW LEVEL SECURITY`, exclusion constraints and trigger behaviour are all server-side. It is the same executable a container would run |
| **What the substitution does NOT cover** | Anything about container networking, or about an **external** pooler process. See §8.1 |
| **CI path** | `docker-compose.yml` is committed for CI, pinned to `postgres:17.10-bookworm`, and is **explicitly marked not runnable on this machine**. The harness as committed always starts its own embedded cluster; the `SPIKE_PG_MODE=external` branch is deliberately *not* written, because an untested code path in an evidence harness is worse than its absence |

---

## 3. What was built

```
spikes/sp-a-isolation/
  migrations/0001_tenant_schema_and_rls.sql        plain SQL, up + down
  migrations/0002_constraint_expressiveness.sql    plain SQL, up + down
  src/config.ts          roles, synthetic fixture, connection config
  src/cluster.ts         embedded PostgreSQL lifecycle + cluster bootstrap
  src/migrate.ts         node-pg-migrate programmatic runner (up/down/cycle)
  src/unit-of-work.ts    THE DELIVERABLE — the SPEC-01 §4.2 wrapper
  src/schema.ts          Kysely table types
  src/seed.ts            fixture, tenant-table registry, probe SQL, census
  src/alerts.ts          page-severity alert sink (T-14 consequence (c))
  src/cli-migrate.ts     standalone migration CLI
  test/isolation.test.ts 36 tests (node:test)
  evidence/              verbatim captured output
  docker-compose.yml     CI-facing, not runnable here
```

**Migration tooling:** `node-pg-migrate@8.0.4`, driven through its **programmatic `runner()`** with a client the spike owns, running migrations **as `app_migrator` and only as `app_migrator`**. Migration bodies are **hand-written SQL** (`-- Up Migration` / `-- Down Migration`), not the JS DSL — SP-2 asks whether the constraint forms are expressible in migrations, and hand-written SQL is the honest test of that. node-pg-migrate did **not** fight the embedded setup; no fallback runner was needed.

**Test runner:** `node:test` via `tsx`, `--test-concurrency=1`. Chosen over vitest because it is zero-config, ships with Node, and produces a plain text log that is legible as evidence.

**Roles** are created by the **superuser** during cluster bootstrap, not by a migration: roles are cluster objects and `app_migrator` deliberately holds neither `CREATEROLE` nor `CREATEDB` nor superuser.

**Eight tenant tables**, all with RLS enabled *and* forced, all owned by `app_migrator`: `organizations`, `groups`, `things`, `thing_notes_naive`, `thing_notes_scoped`, `schedule_versions`, `assignments`, `picklist_turns`. `src/seed.ts` exports the registry (`TENANT_TABLES`) that the T-15 probe, the outside-wrapper probe, the A-05 privilege check and the final census all iterate, so "every tenant table" is enforced by construction rather than by hand.

---

## 4. TDG-02 — assessed against its own criteria

> *"Must reliably issue `SET LOCAL` inside a caller-controlled transaction; express exclusion constraints, partial unique indexes, triggers, and `FOR UPDATE`; no hidden connection checkout outside the unit of work."*

### 4.1 `SET LOCAL` inside a caller-controlled transaction — **YES**

The wrapper issues `BEGIN` and `COMMIT` itself, on a connection it checked out itself, and issues the four context statements **through Kysely** inside that transaction:

```ts
await client.query('BEGIN');                              // caller-controlled
const db = kyselyBoundTo(client, runtime);
for (const name of SETTINGS)
  await sql`select set_config(${name}, ${expected[name]}, true)`.execute(db);   // through Kysely
```

Kysely's `sql` tag parameterises cleanly to `select set_config($1, $2, true)`. Kysely never needed to be told about the transaction, and Kysely's own `db.transaction()` was **not** used — the caller owns the transaction boundary, which is exactly the property TDG-02 asks about. Verified by **X-01**: every statement in a unit of work reports the same `pg_backend_pid()` *and* the same `pg_current_xact_id()`.

> ### ⚠ **You cannot parameterise literal `SET LOCAL`** — measured, not assumed (**X-10**)
> ```
> raw pg:         SQLSTATE 42601 — syntax error at or near "$1"
> kysely sql tag: SQLSTATE 42601 — syntax error at or near "$1"
> set_config(name, $1, true): accepted, returned 11111111…
> ```
> `SET` is a utility statement, not a parameterisable one — the failure is identical through raw `pg` and through Kysely's `sql` tag. The only safe form is the function form `set_config(name, value, true)`, which SPEC-01 §4.2 already prescribes.
>
> **This matters more than it looks.** The obvious workaround — string-interpolating the tenant id into `SET LOCAL` — puts an **injection surface at the single most security-critical statement in the system**. §7 condition 2 turns this into a lint rule, and **X-08** enforces it with a self-tested regex covering `SET`, `SET SESSION` and `SET LOCAL`.

### 4.2 Constraint expressiveness (SP-2) — **YES, all four forms**

| Form | Where | Positive case | Negative case |
|---|---|---|---|
| **Exclusion constraint** | `assignments_no_overlap`, `EXCLUDE USING gist (group_id =, schedule_version_id =, membership_id =, during &&)` | two adjacent shifts accepted | overlapping shift → **23P01** `exclusion_violation` (B-02) |
| **Partial unique index** | `picklist_turns_one_accepted ON (turn_id) WHERE status='accepted'` | 4 non-accepted + 1 accepted accepted | second accepted → **23505** on `picklist_turns_one_accepted` (B-03) |
| **BEFORE UPDATE trigger** | `schedule_versions_published_is_immutable`, `WHEN (OLD.status='published')` | draft row updates | published row → **23001** `restrict_violation`, row verified unchanged (B-04) |
| **`FOR UPDATE`** | Kysely `.forUpdate()` / `.noWait()` | backend 99424 holds the lock | genuinely concurrent unit of work on backend 99428 → **55P03** `lock_not_available` (B-05) |

`btree_gist` is a **trusted extension** from PostgreSQL 13, so the non-superuser database owner `app_migrator` installed it inside the migration. No superuser step was required.

**Migrations run up, down and up again** (B-01, and `npm run migrate:cycle` standalone): `0001 → 0002` up, `0002 → 0001` down, `0001 → 0002` up. Every object, including the extension, the trigger function and the policies, is dropped by the down migration.

### 4.3 No hidden connection checkout — **YES, and structurally so**

Kysely is handed a **fake pool** whose `connect()` returns the connection the unit of work already owns and whose `release()` is a no-op. There is no code path by which a query built with that Kysely instance can reach a different backend. Proven by **X-01** (single pid, single xact id) and by **X-04**: a nested same-tenant unit of work on a `max: 1` pool succeeds, which it could not do if it needed a second checkout.

---

## 5. TDG-03 — pooler verdict

> *"Statement-level pooling is prohibited. Session or transaction pooling with transaction affinity, proven by the SPEC-01 T-14 harness."*

**Transaction affinity holds** for the in-process `pg.Pool` (X-01). **Statement-level pooling breaks the model**, demonstrated three independent ways:

1. **X-02 — direct counter-demonstration.** `set_config` is executed on pooled client 1 inside its transaction; the *next* statement of the same logical unit of work is issued on pooled client 2, exactly as a statement-level pooler would distribute it. Backend 99429 sees **213 rows**; backend 99428 sees **0 rows** and no `app.organization_id`. Under statement pooling the application would silently read nothing — and, on a write path, would be rejected by `WITH CHECK` rather than committing to the wrong tenant. **Fail-closed, but completely broken.**
2. **T-14 — the read-back detector, total loss.** With the pooler simulated as discarding `SET LOCAL`, the wrapper produced all three consequences SPEC-01 §4.2 (V-10) requires:
   - **(a)** `CONTEXT_READBACK_MISMATCH` raised, transaction aborted, **the unit-of-work body never ran at all**, zero rows written;
   - **(b)** backend `99441` poisoned and **destroyed** — 12 subsequent checkouts used only `99442/99443/99444`, and `pg_stat_activity` confirms `99441` is gone;
   - **(c)** one alert at **`severity=page`, `code=CONTEXT_READBACK_MISMATCH`**, carrying role, backend pid, pooler mode, correlation id and the per-setting mismatch list.

   The control leg then flips the pooler back to transaction affinity and the identical unit of work succeeds.
3. **T-14b — PARTIAL loss,** the case that would actually slip past a naive implementation. Only `app.group_id` is dropped; organization context survives. The read-back reports **exactly one mismatch, on `app.group_id`**, and produces the same three consequences (backend 99445 poisoned and paged). See §6.4.

> ### ⚠ **The read-back is a smoke detector, not a proof — and the report should not pretend otherwise.**
> The read-back is a **point-in-time** check. A real statement-level pooler routes *every* statement independently, including the read-back statement itself. It is therefore possible for a real pooler to route `set_config` and the read-back to the same backend (read-back passes) and then route the actual query elsewhere. The simulations used here — dropping all `set_config`s, or dropping one — are strictly *more detectable* than the worst real case.
>
> The read-back is still worth every line it costs: it catches the common case loudly and immediately. But **the load-bearing control for TDG-03 is configuration, not detection.** §7 recommends a startup assertion.

---

## 6. Sharp edges found

### 6.1 `SET LOCAL` reverts the VALUE; it does not undefine the GUC — **SPEC-01 §4.3 is inaccurate as written**

SPEC-01 §4.3 states:

> *"Outside a unit of work the setting is `NULL`, the predicate is false, and every tenant table returns zero rows."*

**That is true only on a connection that has never carried context.** Measured (X-09), all three rows:

| Connection state | `current_setting('app.organization_id', true)` |
|---|---|
| pristine backend | `NULL` |
| **reused backend, after COMMIT** | **`''` (empty string)** |
| **reused backend, after ROLLBACK** | **`''` (empty string)** |

Because a pooled connection is reused by definition — and because a rolled-back transaction is the *common* case in production, one per failed request — **the steady state in production is `''`, not `NULL`.** The consequence is concrete:

```sql
-- the literal SPEC-01 §4.3 spelling, on a reused connection:
select current_setting('app.organization_id', true)::uuid;
-- ERROR 22P02: invalid input syntax for type uuid: ""

-- the spelling this spike's migrations actually use:
select nullif(current_setting('app.organization_id', true), '')::uuid;
-- NULL  → predicate false → zero rows
```

**No isolation is lost either way** — an error is not a leak, and the tenant *identifier* genuinely does not survive the transaction. But the failure *mode* changes from "zero rows" to "22P02 on every query on a reused connection", which is a very different operational experience from the one §4.3 promises, and would look like a driver bug rather than a missing wrapper.

**Every RLS predicate in this spike uses `nullif(current_setting(...), '')::uuid`.** This should be normative.

### 6.2 Referential integrity is not RLS-governed — a single-column FK creates a cross-tenant reference

SPEC-01 §4.5 already notes that `TRUNCATE`/`REFERENCES` are outside RLS, and controls them by withholding grants. **The `REFERENCES` case has a second edge the spec does not mention:** the FK *check* performed on `INSERT` also bypasses RLS.

Demonstrated (X-06). Under an Org A / Group A1 unit of work:

- inserting into `thing_notes_naive (thing_id REFERENCES things(id))` a row whose *own* tenant columns are Org A / Group A1 but whose `thing_id` names an **Org B** row → **accepted**. RLS `WITH CHECK` only inspects the new row's own columns; the FK lookup finds the invisible Org B parent and is satisfied. A dangling cross-tenant reference now exists in the database.
- inserting the same thing into `thing_notes_scoped`, whose FK is composite — `FOREIGN KEY (thing_id, organization_id, group_id) REFERENCES things (id, organization_id, group_id)` — → **rejected, 23503**.

**Mitigation, and it is cheap:** give every tenant table a `UNIQUE (id, organization_id, group_id)` and make every FK between tenant tables carry the tenant columns. The reference then cannot cross a tenant boundary regardless of RLS, regardless of application bugs.

### 6.3 `set_config(name, NULL, true)` stores `''`, not `NULL`

Related to 6.1 but distinct, and it is why the wrapper passes `''` explicitly for an organization-scoped unit of work (`groupId: null`). Covered by the same `nullif` predicate; verified fail-closed in X-07, where an organization-scoped unit of work sees **0** group-scoped `things` and **2** organization-scoped `groups`.

### 6.4 A read-back that only checks `organization_id` is insufficient — **demonstrated, not merely argued (T-14b)**

SPEC-01 §4.2's pseudo-code verifies `app.organization_id` alone. T-14b simulates a pooler that preserves the organization setting and drops only `app.group_id`. Under a single-setting read-back the check would pass, and the unit of work would then execute against **every group in the right organization** — the CAR-001 defect class, reproduced below the application layer where no amount of application-level context validation can see it.

**This wrapper reads back and compares all four settings** and reports which mismatched; T-14b asserts that exactly one mismatch is reported and that it is `app.group_id`. Recommend making all-four read-back normative.

### 6.5 Unique and primary-key checks are a cross-tenant existence oracle

A companion to 6.2, and a new finding: referential integrity is not the only unique-index machinery that runs outside RLS. **The PRIMARY KEY check does too.**

Demonstrated (X-11). Under an Org A / Group A1 unit of work, with an Org B `things` row verified invisible first:

- `INSERT` a row whose `id` equals that invisible Org B row's id → **23505 `unique_violation` on `things_pkey`**;
- `INSERT` an otherwise identical row with a fresh id → **succeeds**.

The response therefore differs **by existence alone**, for a row the caller cannot see, in a tenant the caller has no access to. Over a guessable or leaked id space that is an existence oracle. UUIDv4 ids make it expensive rather than impossible — but the same shape applies to **every `UNIQUE` constraint on a tenant table whose columns a caller can choose**, and a natural key is far more guessable than a UUID.

**Not fixable by RLS**, because integrity checks must see all rows to be integrity checks. Realistic mitigations: keep unique keys on tenant tables **tenant-qualified** (`UNIQUE (organization_id, natural_key)` rather than `UNIQUE (natural_key)`), so a collision can only be reported against a row in the caller's own tenant; and translate `23505` at the edge into a generic error rather than surfacing the constraint name. Recorded as input to a future SPEC-01 note; no action taken in the spike beyond demonstrating it.

### 6.6 An `AsyncLocalStorage`-scoped unit of work makes "concurrent" hard to write by accident

A pleasant surprise that is also a trap. Because nesting is detected via `AsyncLocalStorage`, calling `withUnitOfWork` from *inside* another unit of work always produces a **savepoint on the same connection** — even when the caller intended a second, concurrent transaction. B-05's first draft hit exactly this and silently acquired its own lock instead of contending for one. For the isolation invariant this is the correct and desirable default; for **test authors and for anyone writing genuinely concurrent work**, it needs to be documented loudly.

### 6.7 Minor: `node-pg-migrate` warns on sequential filename prefixes

`Can't determine timestamp for 0001` is emitted on every run because the files use `0001_`/`0002_` rather than a 13-digit timestamp. Ordering and up/down behaviour are correct; the warning is cosmetic. Production should pick one convention and stick to it.

### 6.8 Minor: `embedded-postgres` hangs if you suppress its readiness log line

Setting `log_min_messages=fatal` made `start()` hang forever — it detects readiness by matching *"database system is ready to accept connections"* on stdout. Cost 5 minutes; recorded so nobody pays it twice. Irrelevant to the containerised path.

---

## 7. Conditions attached to the CONFIRM verdicts

1. **Predicate spelling is normative.** Amend SPEC-01 §4.3 to `nullif(current_setting('app.<x>', true), '')::uuid`, and correct the "the setting is NULL" sentence to "the setting is `NULL` or `''`". *(Finding 6.1 — the only amendment I consider mandatory.)*
2. **Ban every `SET`-statement form of a tenant setting by lint,** not only the session forms. `SET LOCAL app.*` must be rejected outright, because — per X-10 — the only way to write it is to interpolate the tenant id into SQL. The parameterisable `set_config(name, value, true)` is the sole permitted spelling. **X-08 implements this and self-tests it**: the regex is proved to flag `SET`, `SET SESSION`, `SET LOCAL` (upper and lower case) and `set_config(..., false)` — 5 forms — and proved *not* to flag legitimate `set_config(..., true)` calls, `set local statement_timeout`, or `current_setting` reads — 4 forms. On the captured run it scanned **11 files / 12 `set_config` call sites / 0 violations**, with 2 deliberately-marked lint fixtures skipped (both in the test file, both logged, and the test asserts no opt-out can escape into `src/` or `migrations/`).
3. **Assert the pooler's mode at process start,** in addition to the per-transaction read-back — e.g. query the pooler's admin interface, or run a two-statement probe equivalent to X-02 during boot and refuse to serve traffic if the second statement cannot see the first's `SET LOCAL`. *(§5 — the read-back cannot be the sole control.)*

**Recommended but not blocking:** read back all four settings, not one (6.4, now demonstrated by T-14b); adopt tenant-composite foreign keys (6.2); keep unique keys tenant-qualified and generalise `23505` at the edge (6.5); document the nesting/concurrency rule (6.6).

---

## 8. What this spike does NOT prove

### 8.1 No external pooler was exercised

**The most important limitation.** TDG-03 concerns *the connection pooler mode*, and the only pooler tested was the **in-process `pg.Pool`**. PgBouncer, pgcat and RDS Proxy were not run — there is no Docker on the execution machine and they are not installable without a package manager. Statement-level pooling was **simulated** (§5), faithfully enough to exercise the wrapper's detection path, but a simulation is not the product.

**If the deployment target puts an external pooler in front of PostgreSQL, TDG-03 needs a follow-up spike against that specific product in CI**, using this harness unchanged plus the `docker-compose.yml` already committed. The verdict above is scoped accordingly: *in-process `pg.Pool` with transaction affinity is confirmed; statement-level pooling is re-confirmed prohibited; an external pooler is unproven.*

### 8.2 Other gaps

| Gap | Note |
|---|---|
| **SPEC-01 §7.1 (T-01..T-06)** | Out of packet scope. This spike covers §7.2 only. The context *tuple*, its validation sequence, and target-aggregate binding are untested here |
| **"every tenant table"** | Satisfied *within the spike*: the T-15 in-wrapper probe, the outside-wrapper probe, the A-05 privilege check and the final census all iterate the same 8-table registry, and T-15 asserts the probe was **non-vacuous on all 8** (a table with no visible rows would report "0 wrong" for the boring reason). But these are 8 *synthetic* tables — the production harness must enumerate the real schema |
| **`groups` / `organizations` policies are broader than EX-2** | Deliberate, and now documented in `0001` itself. The spike's `groups` policy allows all of SELECT/INSERT/UPDATE/DELETE, applies under group-scoped contexts too, and gates on no capability. SPEC-01 §4.3's EX-2 requires **SELECT only**, gated on `app.group_id IS NULL` **and** an organization-administration capability. Production must implement EX-2 as specified; the spike models none of its three gates |
| **`app_readonly_support` auditing** | The role's read-only-under-RLS behaviour is proven (A-07). *"Every read audited"* is **not implemented** — placeholder only |
| **`app_breakglass` two-person authorization** | Only the `BYPASSRLS` attribute and its effect are proven (A-08). Two-person control, time-boxing, session recording: **not implemented** |
| **SPEC-01 §4.3 exceptions EX-1..EX-4** | None are implemented. See the `groups` row above |
| **T-15 scale** | SPEC-01 T-15 says *10 000 interleaved operations*; the packet relaxes it to *≥50 iterations*. Both satisfied: 250 iterations, 1 000 units of work, and **13 408 statements that actually touch a tenant table**. The harness asserts `tenantTableStatements >= 10_000`; protocol overhead (`BEGIN`, 4× `set_config`, read-back, `COMMIT`/`ROLLBACK` — 6 455 statements on the captured run, ~7 per unit of work) is counted and reported **separately** so it cannot inflate the figure |
| **The probe shares no pool with the workload** | The continuous probe runs on its own `pg.Pool`, so it proves cross-*connection* isolation but not that a probe interleaved onto a workload connection would also be clean. The in-unit-of-work self-check inside each storm worker covers that case on the workload pool itself |
| **Fault schedule is deterministic** | Faults fire on a fixed modulus, not a seeded RNG. Reproducible, but it explores one interleaving pattern rather than sampling many |
| **Spike code is not production code** | Per runbook §3, it ships nowhere. `src/unit-of-work.ts` is a reference for the real implementation, not the real implementation. Its `poolerMode` mock branches live **inside the wrapper under test** — disclosed because a mock inside the unit under test is a real (if accepted) weakness in the evidence |

---

## 9. SPEC-01 §7.2 test mapping

| SPEC-01 | Harness test | Result | Observed |
|---|---|---|---|
| **T-07** exception mid-transaction | `T-07` | ✔ | rollback; 0 rows; whole pool clean |
| **T-08** cancellation / client timeout | `T-08`, `T-08b` | ✔ | `pg_cancel_backend` → **57014** *canceling statement due to user request*. `T-08b` pins the distinct client-side shape: `Query read timeout` with **no SQLSTATE** (a driver deadline, not a server cancellation). Both roll back; pool clean |
| **T-09** server statement timeout | `T-09` | ✔ | **57014** *statement timeout*; `statement_timeout` itself back to `0` after the transaction |
| **T-10** connection killed mid-transaction | `T-10` | ✔ | **57P01** *terminating connection due to administrator command* on backend 99430; backend gone from `pg_stat_activity`; pool never hands it out again |
| **T-11** nested, same tenant | `T-11` | ✔ | savepoint; same backend; inner rolled back, outer committed |
| **T-12** nested, different tenant | `T-12` | ✔ | `NestedTenantChangeError` **before any statement** — for a different *organization* **and** for a different *group in the same organization*; outer transaction untouched and still commits |
| **T-13** outside any unit of work | `T-13` | ✔ | `app_runtime` and `app_worker`: 0 rows readable; `INSERT` → **42501**; `UPDATE`/`DELETE` affect 0 rows |
| **T-13b** group predicate, same org | `T-13b` | ✔ | Group A2 rows invisible, unaddressable by id, unwritable; cross-group `INSERT` → **42501**; target row verified unmodified |
| **T-14** statement-pooling mode | `T-14` | ✔ | all three consequences (a)/(b)/(c) asserted — see §5 |
| **T-14** partial context loss *(added)* | `T-14b` | ✔ | only `app.group_id` dropped; exactly one mismatch reported, on `app.group_id`; same abort + discard + page — see §6.4 |
| **T-15** two-org storm | `T-15` | ✔ | 250 iterations · 1 000 units of work · 6 256 transactions · 13 408 tenant-table operations (+6 455 protocol) · 252 faults · continuous probe over **all 8 tenant tables** (713 in-wrapper passes × 8 = 5 704 reads, plus 5 704 outside-wrapper reads) · probe non-vacuous on all 8 · **0 wrong-tenant rows** · census 30 partitions, all legitimate |

**Additional evidence:** A-01..A-08 (environment; five-role matrix; FORCE RLS binding the owner; **no TRUNCATE/REFERENCES on any of the 8 tenant tables — 32 (role, table) pairs, 0 violations**; RLS undisableable by the app role; support role read-only; break-glass genuinely differs) · B-01..B-05 (SP-2) · X-01..X-11 (transaction affinity; statement-pooling counter-demonstration; pool reuse across organizations; pool exhaustion; worker-role probe; FK sharp edge; empty-string context; self-tested static `SET` scan; GUC lifetime incl. the ROLLBACK leg; `SET LOCAL` non-parameterisability; unique/PK existence oracle).

---

## 10. Reproducing

```bash
cd spikes/sp-a-isolation
npm install                 # approves 2 postinstall scripts: esbuild, @embedded-postgres/darwin-arm64
npm run typecheck           # tsc --noEmit, 0 diagnostics
npm run migrate:cycle       # up -> down -> up on a throwaway cluster
npm test                    # 36 tests, ~4.4 s, starts and stops its own cluster
```

Every run starts from a **destroyed and re-initialised** data directory, so there is no state to carry between runs. `SPIKE_STORM_ITERATIONS` overrides the storm loop count (default 250).

**Captured output:** `evidence/harness-output.txt` (full `npm test`), `evidence/migrate-cycle-output.txt` (typecheck + migration cycle). Both are verbatim, and **every figure in this report is taken from those two files**, subject to the run-variance note at the top.

The packet also asks for the evidence to be filed as `docs/evidence/EV-M0-SPA`. **That was not done** — `docs/**` is outside this task's allowed paths. The two files above are the artifact; filing them is the orchestrator's step.
