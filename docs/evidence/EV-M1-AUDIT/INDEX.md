# EV-M1-AUDIT — OPUS-M1-003 evidence index

**Task:** OPUS-M1-003 — audit chain + outbox/job runner, opening with the TDG-04 micro-spike
**Branch:** `opus/m1-003-audit-outbox`
**Revision:** second submission, after the independent second review returned **REVISE** (R-01..R-10)
**Normative:** [SPEC-11](../../architecture/specs/SPEC-11-audit-assurance-and-security-boundaries.md) (A1 chain, checkpoints, X-01..X-03) · ADR-0019 / non-bypass rule 6 · [FAD-12](../../fable/control/ARCHITECTURE-DECISIONS.md) · I-07 · I-11 · TDG-04

> **Every number in this index comes from a captured file in this directory.** Nothing is quoted from memory, and nothing describes designed behaviour as verified behaviour. Where something is designed but unproven, it is in §5 rather than absent.

---

## 1. Verdicts

| | |
|---|---|
| **TDG-04 (graphile-worker)** | **GO** — confirmed against a real PostgreSQL 17.10 with real worker processes and real `SIGKILL`. **18/18** spike experiments pass. Four conditions attached, all four implemented — see §3 |
| **`corepack pnpm check`** | **12 / 12 gates pass** |
| **Test battery** | **336 tests, 27 files, 0 failures.** 64 of them are this task's audit suites |
| **`corepack pnpm red-cases`** | **14 / 14 proven** — every gate still fails on its violation |
| **Migration cycle** | `up → down → up → down → up` clean with the new composite key and triggers; **no tables and no policies remain after `down`** |
| **Chain verification** | intact → exit `0`; after a privileged edit → exit `1` naming the sequence; after the revert → exit `0` |

### 1.1 What the second review changed

The reviewer confirmed the chain core clean and returned **REVISE** on two merge-blocking findings and several required smalls. Every one is implemented **and has a test that reproduces the reviewer's own scenario**:

| # | Finding | Change | Proof |
|---|---|---|---|
| **R-01** | tail truncation undetected — checkpoint at 10, append to 15, delete 11–15 read as `intact` | `app_verify_audit_chain` compares the registered head against the last row that exists; two new problem kinds; the head row itself made monotonic and undeletable | `chain.test.ts` "R-01: a TAIL TRUNCATION…": *head says 32, chain stops at 28 → `head_sequence_ahead_of_chain` at 29, while every checkpoint still verified and matched* |
| **R-02** | double delivery in two windows | claim CAS + mark CAS + a durable `outbox_effects` table keyed on the idempotency key | `outbox-dispatch.test.ts` R-02(a) and R-02(b) — see §4.5 |
| **R-03** | the async kernel was test-only | `src/index.ts` installs the queue schema and starts the runner; SPEC-11 §2's two periodic jobs are cron tasks | `periodic.test.ts`: `audit.checkpoint` **enqueued by name** and executed by the real runner |
| **R-04** | checkpoint poisoning | `UNIQUE (organization_id, sequence, entry_hash)` + composite checkpoint FK | a wrong-hash checkpoint is refused (`23503`) |
| **R-05** | verify-function confinement | raises `restrict_violation` on a foreign organization id | a foreign id and a missing context both raise `23001` |
| **R-06** | checkpoint read policy contradicted its comment | added the `app.group_id IS NULL` clause | organization-scoped sees 5 checkpoints, group-scoped sees 0 |
| **R-07** | canonical-bytes docblock named the wrong delimiter | fields are US `0x1f`, payload records are RS `0x1e` | — (documentation) |
| **R-09** | KMS-shaped transaction held across `signer.sign()`; concurrent-checkpointer `23505` | the `23505` half fixed (one line, treated as benign); the transaction shape **carried** | §5 #14 |
| **R-10** | `_private_jobs` diagnostic read | removed | — |

---

## 2. Captured files

| File | What it is | Command |
|---|---|---|
| [`spike-sp-d-harness-output.txt`](spike-sp-d-harness-output.txt) | The TDG-04 micro-spike, verbatim. 18/18 | `npm test` in `spikes/sp-d-worker` |
| [`check-output.txt`](check-output.txt) | All twelve gates | `corepack pnpm check` |
| [`test-battery-output.txt`](test-battery-output.txt) | Every test in the workspace, verbose | `corepack pnpm vitest run --reporter=verbose` |
| [`red-cases-output.txt`](red-cases-output.txt) | Each gate proved to fail on its violation | `corepack pnpm red-cases` |
| [`migration-cycle-output.txt`](migration-cycle-output.txt) | The migration cycle including 0003 | `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` |
| [`chain-verification-output.txt`](chain-verification-output.txt) | The verification command in three states, exit codes checked | `tsx apps/api/test/support/audit-verify-demo.ts` |

The spike's own report — verdict, conditions and sharp edges — is [`spikes/sp-d-worker/SPIKE-REPORT.md`](../../../spikes/sp-d-worker/SPIKE-REPORT.md).

---

## 3. The TDG-04 conditions, and where each is discharged

The micro-spike returned **GO with four conditions**. All four are implemented and tested; a condition recorded in a spike report and not carried into the code is a condition nobody met.

| # | Condition | Discharged by | Proven by |
|---|---|---|---|
| **C-1** | graphile-worker's schema needs explicit policies for the consumer and a `SECURITY DEFINER` wrapper for the producer — grants alone leave the worker reading **zero rows, silently** | `apps/api/src/db/queue-schema.ts`, applied in bootstrap **and now at process start**; `app_runtime` holds no grant on the queue tables at all | spike E-0.1/E-0.2/E-0.3; `outbox-dispatch.test.ts` "ROLLBACK …" (the rollback test cannot even *count* queue rows as `app_runtime`, which is C-1 working) |
| **C-2** | a pool registry + stale-lease reclaim, because the lease is **4 hours** and a *graceful* shutdown does not release the in-flight job either | `queue_pools` (migration 0003) + `apps/api/src/db/queue-pools.ts` + the sweep in `outbox/runner.ts` | spike E-2.6; `crash-restart.test.ts` part B — **a real killed worker's job recovered in ~0.5 s of real time, no clock manipulation** |
| **C-3** | every handler must honour `helpers.abortSignal`; the deployment must send `SIGTERM` twice or set a kill deadline | the dispatch task passes the signal through and the dispatcher checks it **before** delivering; `runner.ts` sets `noHandleSignals: true` and says why | spike E-2.4b |
| **C-4** | every externally visible effect carries an idempotency key — graphile-worker is at-least-once and nothing changes that | **restated after R-02.** The key is on `outbox_events`, and the thing that *enforces* it is `outbox_effects`, whose **PRIMARY KEY** is `(organization_id, idempotency_key)`. Applying an effect *is* inserting that row | `outbox-dispatch.test.ts` R-02(a) and R-02(b) |

**C-4's first discharge was weaker than the spike's own design and the review said so.** The spike deduplicated with a table (`spike_effects`, primary key on the idempotency key); the first submission deduplicated with a `Map` in the delivering process. That is worth nothing across a restart and nothing across two workers, and both failures were measured. The table is now the mechanism; the in-process arrays that remain on `DatabaseOutboxSink` are observation for tests and are never consulted by `deliver`.

---

## 4. What was built, and what proves it

### 4.1 The chain (SPEC-11 §2)

`audit_events` carries a **gapless per-organization `sequence`**, a `prev_hash` and an `entry_hash = sha256(prev_hash ‖ canonical(row))`, all assigned by a `BEFORE INSERT` trigger and all **absent from the column-level `INSERT` grant** — so the application cannot name a chain column in a statement at all (`42501`). The tip lives in `audit_chain_heads`, on which **no role holds any grant**; it is reachable only through a `SECURITY DEFINER` trigger function that is itself under `FORCE` RLS, so it gains privilege and no tenant reach.

**A defect the tests found, recorded rather than quietly fixed:** the first version of `app_audit_canonical_bytes` **omitted `prev_hash` from the hashed input**. Every `entry_hash` then depended only on its own row, so altering row 1 left rows 2..n verifying perfectly and the head hash unchanged. Invisible in review; visible only to X-02. `chain.test.ts` now asserts the property directly.

### 4.2 Append-only (non-bypass rule 6), in three layers

| Layer | Measured |
|---|---|
| **No grant.** No `UPDATE`, `DELETE`, `TRUNCATE` or `REFERENCES` on `audit_events` or `audit_checkpoints`, to any role | per-role assertion against `information_schema` (table **and** column privileges — a column-level `INSERT` grant does not appear in `table_privileges` at all) |
| **No policy.** There is no `UPDATE` policy, so even the table **owner**'s `UPDATE` matches **zero rows** — vacuous rather than refused, and the test asserts the row count precisely because those look different to a reviewer | `chain.test.ts` "the OWNER updates ZERO rows" |
| **`ENABLE ALWAYS` triggers.** Superuser `UPDATE`, `DELETE` and `TRUNCATE CASCADE` all raise `23001` — **including under `session_replication_role = 'replica'`** | `chain.test.ts` "the SUPERUSER is refused too" |

`audit_chain_heads` and `outbox_effects` are protected on the same terms: the head row is monotonic and undeletable (R-01 — otherwise the truncation check has an input the attacker controls), and an applied effect cannot be edited or removed (R-02 — the suppression is only as good as the row's permanence).

### 4.3 Detection, which is the layer that survives a privileged actor

| SPEC-11 §10 | What is actually covered |
|---|---|
| **X-01** — an audit row edited by an actor who disabled the trigger | `entry_hash_mismatch` at the exact sequence (*measured: sequence 10*). Reverting the edit restores the hash, which is itself a proof the recomputation is genuine |
| **X-02** — a segment rewritten **consistently** | Two results, and the first is new. **(a)** R-04's composite foreign key now **refuses** the rewrite outright while a checkpoint exists (`23503`) — prevention where SPEC-11 §2 promised only detection. **(b)** An actor privileged enough to drop the constraint completes the rewrite: the **chain verifies** (`intact=true`), the checkpoint reports `signatureValid=true, matchesChain=false`, and the dropped foreign key **cannot be re-added** |
| **X-03** — deletion, in **two shapes** | **Corrected after R-01.** A **mid-chain** deletion is recorded as an explicit `sequence_gap` at a named sequence (*measured: deleting 24 → gap at 25*). A **tail truncation above the last checkpoint** produces no gap and no hash mismatch at all — every remaining row is consistent and every checkpoint still verifies and matches — and is caught only by the **head comparison** (*measured: head 32, chain stops at 28 → `head_sequence_ahead_of_chain` at 29*). The first submission covered the first shape and claimed X-03; it did not cover the second, and reported `intact` for it |
| X-04..X-18 | **not covered.** See §5 |

### 4.4 The outbox, atomic with the domain change

One transaction: domain mutation → `audit_events` → `outbox_events` → `app_enqueue_job`. `COMMIT` produces all four; `ROLLBACK` produces **0 audit rows, 0 outbox rows and 0 queue jobs**. Measured on the production path, not only in the spike.

**Ordering and idempotency, as they actually are:** at-least-once delivery; **no ordering guarantee between two outbox events at all**, not even for the same subject, because this milestone uses no named queue; exact enqueue atomicity; at-most-once not available and not requested.

### 4.5 Exactly-once, and the two windows that were not closed (R-02)

Three mechanisms, and the code comments are explicit about which is worth what:

| Mechanism | Prevents |
|---|---|
| **claim CAS** (`state <> 'dispatched'` → `dispatching`) | a second dispatcher picking up a finished event; attempt double-counting |
| **mark CAS** (`state = 'dispatching'`) | two dispatchers both writing `outbox.dispatched` — only the winner audits |
| **`outbox_effects` primary key** | **the duplicate EFFECT.** The one that actually matters |

The claim is deliberately re-takeable from `dispatching` — a SIGKILLed dispatcher must not strand its row forever — which is exactly why a claim can never be the exactly-once guarantee.

| Window | Measured now |
|---|---|
| **two concurrent dispatchers**, started with `Promise.all` | outcomes `[already_dispatched, delivered]`, **1** effect row, **1** `outbox.dispatched` audit event |
| **crash after the effect, before the mark** | effect applied on attempt 1; the replacement re-ran, was **suppressed by the primary key**, applied nothing, and completed the bookkeeping. Still **1** effect row, and it is still the original row rather than one the retry rewrote. `outbox_events.attempts = 2` — two claims, honestly counted |

### 4.6 I-11

A failing sink leaves the committed domain row, the audit row and the chain untouched; the outbox row records `state = 'failed'` and `last_error_code = 'sink_unavailable'`. The delivery happens **outside every transaction** the domain change touched. `last_error_code` rejects an exception message at the database (`23514`).

### 4.7 I-07 — the closed payload

Enforced **twice**, tested against **one corpus of 22 candidates** so the two cannot drift. A string value must be **printable ASCII with no space** (`[!-~]*`), ≤ 64 characters — an allowlist rather than a whitespace test **because the two disagreed**: `[[:space:]]` in SQL does not match U+00A0 under this cluster's ctype while JavaScript's `\s` does.

### 4.8 What runs automatically, and what an operator must invoke (R-03)

The first submission had all of this wired into the test harness and nowhere else; a production process would have started happily and failed on the first `publishOutboxEvent`.

| | Trigger | Where |
|---|---|---|
| **queue schema + SP-D C-1 policies** | **automatic**, at process start, before the socket opens | `src/index.ts` → `installQueueSchema()` |
| **outbox dispatch** | **automatic**, continuously | the outbox runner |
| **stale-pool reclaim** | **automatic**, at startup and every 5 s | `db/queue-pools.ts` |
| **checkpoint sweep** | **automatic**, cron `0 * * * *` (hourly), every *N* entries or at least daily | `audit.checkpoint` task |
| **chain verification** | **automatic**, cron `30 */6 * * *`; **pages** at `severity: 'page'` on any discrepancy | `audit.verify` task |
| **chain verification, on demand** | **operator-invoked**, exit `0`/`1`/`2` | `src/audit/verify-cli.ts` |
| **`SP_DISABLE_WORKER=1`** | an explicit opt-out for deployments running workers separately. It logs what it costs; it is not a default | `src/index.ts` |

The verification job's page carries the organization id, the problem kinds, the first affected sequence, the checkpoint-mismatch count and **`signingKeyIsIsolated: false`** — because a signature verified by a key this process also holds is not evidence, and the operator has to be told that in the alert rather than in a document.

Finding work across tenants needs one cross-tenant read, and it is **named rather than hidden**: two `TO app_migrator` `SELECT` policies (`audit_chain_heads_maintenance_read`, `audit_checkpoints_maintenance_read`) and one `SECURITY DEFINER` enumeration function granted to `app_worker` alone, returning **counters and timestamps and no tenant content beyond the organization identifier itself**. `chain.test.ts` asserts the policies are `FOR SELECT` and name `{app_migrator}`, that the function is granted to `app_worker` only, that neither `SECURITY DEFINER` function carries an inherited `PUBLIC:EXECUTE`, and that `app_runtime` calling it gets `42501`.

### 4.9 Emission coverage

Both mutating surfaces that exist emit the same event against the same subject: the HTTP context-probe touch and its job twin. Wiring is **one call with three fields** — see §6.

---

## 5. What is **NOT** proven

Everything in this section is a claim nobody may make on this evidence.

| # | Not proven | Why, and who owns it |
|---|---|---|
| 1 | **A2 — external immutable replication** (SPEC-11 §3.1) | Not built. This milestone reaches **A1**. **A2 is the production target and is not claimed.** X-04 is untested |
| 2 | **The checkpoint signing key is NOT isolated** | `LocalCheckpointSigner` holds the private key **in the application process**; `keyIsIsolated` returns `false`, the CLI prints a note on every run, `src/index.ts` logs it at startup, and the verification job puts it in every page. Real KMS (TDG-15) is a named CI/deployment condition |
| 3 | **Privileged-access auditing** (SPEC-11 §3.2) | Support and break-glass reads are **not** written to the chain. Lands with the support tooling |
| 4 | **The reconciler** (SPEC-11 §3.3) | The three sequences are *reconcilable* — `outbox_events.audit_sequence` is a composite FK — but no job reconciles them and **X-05 is untested** |
| 5 | **X-06 through X-18** | Legal hold, anonymisation, WebSocket origin, provider callbacks, OIDC, SSRF, archive bombs, image signing, support bulk export, incident tabletop |
| 6 | **Retention and deletion** (SPEC-11 §4) | No retention job, no legal hold, no anonymisation path |
| 7 | **The four-hour lease under real elapsed time** | The spike ages `locked_at` rather than waiting four hours. Server-side arithmetic on that column, so the substitution is exact — but it *is* a substitution. C-2's mitigation was measured under **real** elapsed time |
| 8 | **Ordering between outbox events** | There is none, and none is claimed |
| 9 | **An external connection pooler** | Unchanged from SP-A §8.1. graphile-worker additionally uses `LISTEN`/`NOTIFY`, which is **session**-scoped and a known incompatibility class with transaction-mode PgBouncer |
| 10 | **`zod` strict for the payload schema** | Hand-written validator instead: `packages/domain` imports **nothing**, and `packages/contracts` is outside this task's globs. Not weaker — zod's `.strict()` rejects unknown keys and says nothing about whether a known key's value is an identifier or a clinician's note. Deviation, disclosed |
| 11 | **A red case for "a migration adds an UPDATE rule to `audit_events`"** | Not automatable yet, per the packet. `test/audit/architecture.test.ts` covers the *code* half; a **migration** adding a permissive rule would still pass every gate. Review-checklist item |
| 12 | **Throughput and chain contention at scale** | No load test. Every append takes a row lock on the organization's chain tip, so appends **serialise per organization** by design — correct for gaplessness, and a throughput ceiling nobody has measured |
| 13 | **`TENANT_TABLES` does not include the new tables** | `src/db/schema.ts` is outside this task's globs. Their isolation is tested in this task's own suites instead. Registry extension is a merge-time follow-up |
| 14 | **`writeCheckpoint` holds its transaction across `signer.sign()`** | **Carried (R-09).** Harmless for the in-process stub; **the wrong shape for a real KMS**, where a slow or unavailable signer would hold a database transaction across a network round trip. The fix — sign first, write in a second transaction re-checking the head — belongs **with** the KMS adapter rather than speculatively before it, and is named alongside condition #2. The other half of R-09 *is* fixed: a concurrent checkpointer's `23505` is treated as benign |
| 15 | **Exactly-once for a real external provider** | `outbox_effects` makes exactly-once real for an effect that lives in **this database**, because the row and the effect are the same object. For a provider they are not, and no database can make them one. The available shape is: commit the key before calling the provider, and require the provider to honour an idempotency key of its own. Neither exists yet |
| 16 | **The cross-tenant maintenance read has no runtime auditing** | The two `TO app_migrator` policies and `app_audit_organizations_due` are confined and tested (§4.8), but a use of them is not itself written to the audit chain. Same owner as #3 |

---

## 6. The OPUS-M1-002 integration point

Wiring a new mutation is **one call**, and it names nothing tenant-shaped — organization, group, acting membership and correlation id all come from `uow.context`, inside the same transaction as the mutation and its authorization (FAD-12):

```ts
await recordAuditEvent(uow, {
  eventName: 'grant.issued',      // add it to packages/domain/src/audit/event-names.ts
  subjectType: 'membership',
  subjectId: targetMembershipId,
});
```

A mutation that also needs asynchronous follow-up adds a second line:

```ts
await publishOutboxEvent(uow, recorded, { kind: 'grant.issued', idempotencyKey: `grant:${grantId}` });
```

Both refuse to work outside a unit of work — `recordAuditEvent` takes the `UnitOfWork` as its first argument and cannot obtain one, and the chain trigger's insert into `audit_chain_heads` fails closed with no tenant context.

**Three things OPUS-M1-002 must do at merge:**

1. add its event names to `packages/domain/src/audit/event-names.ts` (the list only grows — rule 13);
2. add one `recordAuditEvent` call inside each mutation's existing `runtime.run(...)` callback;
3. renumber this migration if `0002` and `0003` collide, and re-run the cycle.

---

## 7. Synthetic data and egress

Two organizations, "Organization Alpha/Beta (synthetic)", role-descriptive person labels, every address at `example.invalid` (RFC 2606, cannot resolve). **No name from the research corpus appears anywhere.**

**Nothing leaves the machine.** The only sink writes a row to this database. `outbox-dispatch.test.ts` asserts by reading the source that no module on the dispatch path imports an HTTP, SMTP or socket client, and the spike opens no socket except to `127.0.0.1`.
