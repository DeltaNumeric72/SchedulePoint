# EV-M1-INTEGRATION — OPUS-M1-004, the M1 kernel integration

**Task:** OPUS-M1-004 · **Branch:** `opus/m1-004-integration` · **Base:** `main` at `0c7c90f`
**Authority:** FAD-13 (three OPUS-M1-002 escalations ruled) — items 1, 2 and 3 — plus the
S-21 residual from OPUS-M1-002's second review.

OPUS-M1-002 (authorization) and OPUS-M1-003 (audit + outbox) were built in parallel
worktrees with deliberately disjoint file scopes. Both are ACCEPTED. This task merges them
and closes the four seams the disjointness left open. **Every conflict was resolved by
composition; nothing from either side was discarded.**

---

## 1. What was done

| | |
|---|---|
| **Merge** | `opus/m1-002-authz-evaluator` (`0e82eea`) merged into this branch. Two conflicts, both composed — see §2 |
| **FAD-13 item 1** | The worker authorizes through the SPEC-06 evaluator. `provisionallyAuthorized` **deleted** — there is no second authorization path on any surface |
| **FAD-13 item 2** | OPUS-M1-002's three mutations emit audit events; the entitlement change also publishes an outbox event |
| **FAD-13 item 3** | `TENANT_TABLES` covers migrations 0002 **and** 0003; every table in the schema is accounted for |
| **S-21** | The unguarded `.toISOString()` in `apps/api/src/jobs/worker.ts` is guarded, with the repro as a test |

---

## 2. The merge, conflict by conflict

Two files conflicted. Everything else — `pnpm-lock.yaml`, `apps/api/package.json`,
`apps/api/src/jobs/handlers.ts`, `packages/domain/src/index.ts` — auto-merged.

### `apps/api/src/http/routes/context-probe.route.ts`

The integration surface itself. M1-003 added `recordAuditEvent` after the mutation;
M1-002 replaced `provisionallyAuthorized` with `evaluateInTransaction` + `respondToDenial`
before it. **Both, in FAD-12's order, inside one unit of work:**

```
evaluate (SPEC-06's full truth table)  →  deny early, writing nothing
                                       →  perform the mutation
                                       →  record the audit event
```

The callback takes the `uow` again — M1-002 had narrowed it to `{ query }`, and the
recorder needs `uow.context` for the organization, group, actor and correlation id.
Evaluation is first so a denial leaves neither a change nor an audit row claiming one;
the audit call is last so it records something that happened.

### `docs/dev-setup.md`

Both sides appended a section. Both kept, ordered by migration number: 0002's `btree_gist`
note, then 0003's audit-chain and queue note.

---

## 3. The four integration items

### 3.1 The worker runs the SPEC-06 evaluator (FAD-13 item 1)

`apps/api/src/jobs/worker.ts` authorized on OPUS-M1-001's role allow-list, because
`jobs/**` was OPUS-M1-003's scope while OPUS-M1-002 replaced that mechanism on HTTP.
SPEC-06 §7 — *"One evaluator, every path. A surface with its own authorization logic is a
defect"* — was **not true**, and the gap was not cosmetic: a role allow-list cannot see
entitlements, module availability or grants, so A-07's *"capability revoked after enqueue,
before execution"* was covered only in the role dimension.

| Change | |
|---|---|
| `apps/api/src/authz/authorize-request.ts` | `evaluateAction` is the transport-neutral core; `evaluateInTransaction` is now the Fastify wrapper that marks the request and delegates. One truth table, two entry points |
| `apps/api/src/http/policy.ts` | `DeclaredAction` — the pair of fields a route config and a job handler both declare, so `actionInputOf` serves both. `provisionallyAuthorized` and `ProvisionalJobPolicy` **deleted** |
| `apps/api/src/jobs/handlers.ts` | The handler declares the same SPEC-06 action object the route declares |
| `packages/domain/src/ports/job-queue.ts` | `FrozenJobContext.principalUserId` — see below |

**Why the principal is frozen rather than derived.** `loadPolicyInput` cross-checks the
acting membership's `user_id` against the evaluation context's principal. Deriving the
principal from the row being authorized would make that check compare the row with itself.
Frozen at enqueue, it is a real control: a membership re-pointed at another user between
enqueue and execution fails L3.

**Unchanged:** re-evaluation happens at execution against current state, and the two
terminal states keep their names and meanings — `refused_no_context` when the frozen
context cannot be used at all, `cancelled_unauthorized` when it can and the answer is no.
The outcome carries the denial's `reason` code, never its `explanation` (the same rule
`respondToDenial` follows on HTTP).

Proof — `apps/api/test/jobs/job-context.test.ts`, describe block *"the dimensions the
worker could NOT see before OPUS-M1-004 (SPEC-06 A-07)"*. **Each of these would have
COMPLETED under the role allow-list:**

| Case | Outcome |
|---|---|
| L1 — entitlement revoked between enqueue and execution | `cancelled_unauthorized`, nothing written |
| L2 — the module made unavailable in the group | `cancelled_unauthorized`, nothing written |
| L4 — an explicit DENY grant on the actor (P-1) | `cancelled_unauthorized`, nothing written |
| the frozen principal no longer matches the membership | `cancelled_unauthorized` |
| a frozen context with no principal | `refused_no_context` |

And `apps/api/test/http/route-declarations.test.ts` asserts the mechanism stays deleted:
`provisionallyAuthorized` is exported by nothing, called by nobody, and no registered route
carries a `provisional` allow-list.

### 3.2 Audit emission for OPUS-M1-002's mutations (FAD-13 item 2)

Three mutations, three names — the ones the route already exported as `AUDIT_EVENTS` when
it shipped, so they are a contract honoured rather than three strings invented here.

| Mutation | Event | Subject |
|---|---|---|
| create a membership | `authorization.membership.created` | the membership |
| write a capability grant | `authorization.capability_grant.written` | **the grant**, not the membership it names |
| change an entitlement's state | `authorization.entitlement.state_changed` | the entitlement row, whose `id` the update now returns |

Each is the documented one-liner, in the same `runtime.run(...)` callback as its write,
after the mutation and after the authorization that permitted it. Nothing tenant-shaped is
passed. `capability_grant` and `entitlement` join `AUDIT_SUBJECT_TYPES`; a grant and an
entitlement are their own aggregates, and filing them under a membership would make
*"everything that happened to this grant"* unanswerable — the question an authorization
incident asks.

**One outbox publication, and the asymmetry is deliberate.** A membership or grant change's
whole downstream consequence is the `membership_set_version` bump, which 0001/0002's
triggers perform in the same transaction and which forces the affected principal's next
request through SPEC-01 §2.3's staleness check. An entitlement change moves what an entire
organization may do, and the counter only reaches a principal who makes another request —
not a live server-authoritative session (PO-DEC-18), not a queued job for the withdrawn
module, not an administrator who should be told. That work is outside the transaction by
definition, and I-11 says a notification failure must never roll back a domain change,
which is the transactional outbox's reason for existing (SPEC-11 §3.3). The idempotency key
is the gapless audit sequence.

Proof — `apps/api/test/authz/http-authorization.test.ts`, describe block *"OPUS-M1-004 —
every OPUS-M1-002 mutation emits its audit event"*: the three emissions read from ground
truth with the superuser; the entitlement's outbox row linked to its audit sequence; a
DENIED mutation leaving neither the change nor an audit row; and a mutation that FAILS
after its audit call (driven through A-12's exclusion constraint, not a synthetic throw)
leaving neither.

Plus a static gate in `apps/api/test/audit/emission-coverage.test.ts`: **every module under
`http/routes/**` or `jobs/**` that writes must also call `recordAuditEvent`.** Three
modules scanned, three record. A fourth mutation added without one fails there, not at
review.

### 3.3 The tenant-table registry (FAD-13 item 3)

`TENANT_TABLES` drives the pool-cleanliness probe, the wrong-tenant probe, the T-15 storm,
the (role, table) privilege matrix and the nullif-guard scan. Migration 0003's four tenant
tables were outside all of it, and **nothing noticed, because nothing was asking.**

| Table | Scope |
|---|---|
| `audit_events` | `organization-and-group` |
| `outbox_events` | `organization-and-group` |
| `outbox_effects` | `organization-and-group` |
| `audit_checkpoints` | **`organization-context-only`** — a new scope class |

`audit_checkpoints`'s read policy carries `app.group_id IS NULL` (0003, R-06), so a
group-scoped context correctly sees nothing. The existing `organization-only` class exists
precisely because `roles`, `role_capabilities` and `entitlements` **are** readable from a
group; using it here would have mis-declared the opposite property.

`TenantTable.name` is now `string`, not `keyof Database`. Registering the audit tables the
old way meant adding them to the Kysely `Database` interface — which makes
`query.updateTable('audit_events')` a statement that type-checks. That is an update path to
the audit chain handed out by the type system, in exchange for a constraint that only
proved a name appeared in a hand-written interface. **The names are validated against the
database instead**, in both directions.

Turning the registry on surfaced five things. None was weakened away:

1. **Every new table's probe was vacuous.** `seedAuditAndOutbox` seeds all four in both
   organizations and every group, entirely through the production path — a real
   `last_active_at` touch, `recordAuditEvent`, `publishOutboxEvent`, `writeCheckpoint` with
   the local signer, and `outbox_effects` under `app_worker`'s own credential because 0003
   grants it to nobody else.
2. **`audit_checkpoints` cannot be probed from a group context at all.** The red-case
   probes and the T-15 storm now run organization-scoped contexts too — added to the storm
   as *probe* contexts, not workload contexts, because the workload writes `memberships
   where group_id = …` and has no meaning without a group. The red case asserts every
   registered table was probed under some context.
3. **A-04 is false for `audit_checkpoints`, by design.** FAD-14's maintenance-plane read
   (`FOR SELECT TO app_migrator USING (true)`) is *"the only cross-tenant read in the
   system, pinned by tests"*. Asserted in both directions rather than skipped: `> 0` for
   `app_migrator` so removing the policy fails, and `0` for `app_runtime` / `app_worker` /
   `app_readonly_support` so widening it fails. `app_breakglass` is excluded **and named** —
   SPEC-01 §4.4 gives it `BYPASSRLS` deliberately.
4. **"Every policy applies to PUBLIC"** now allows exactly that one policy by name, table
   and role, and additionally asserts it still exists and is still `SELECT`-only.
5. **`chain.test.ts`'s X-02** restored BETA's chain by delete-and-reinsert, which the seeded
   `outbox_events` foreign key now forbids. Restored by `UPDATE` of the three columns the
   rewrite touches — same state, no row ever removed, one trigger disabled instead of three.
   **No assertion changed.**

`apps/api/test/support/schema-census.ts` declares the tables deliberately **not** registered
— `audit_chain_heads` (no runtime role holds any grant; it moves only through the SECURITY
DEFINER trigger), `queue_pools` (SP-D C-2: maintenance-plane, deliberately not
tenant-scoped) and `pgmigrations` — each with a reason, and a test asserts
`TENANT_TABLES ∪ NON_TENANT_TABLES` is every table in the public schema. It lives in test
support rather than beside the registry because naming `audit_chain_heads` in a module
under `src/` would trip `architecture.test.ts`'s absolute rule that no TypeScript module
names it — a rule worth keeping absolute.

**16 public tables: 13 tenant, 3 declared non-tenant, 0 unaccounted.**

### 3.4 S-21 — the third copy of the `instantOf` guard

`apps/api/src/jobs/worker.ts` built its `MembershipSnapshot` with a bare `.toISOString()`
on `valid_from` / `valid_to`. `timestamptz` accepts `infinity`, node-postgres returns it as
the JavaScript **number** `Infinity`, and `Infinity.toISOString` does not exist — so a
single stored infinite bound threw a `TypeError` out of `executeJob`: a job that neither
completed nor reached a terminal state, which is exactly what SPEC-06 §5 forbids.

OPUS-M1-002 fixed the same shape in `http/context/snapshot.ts` and `authz/load-policy-input.ts`
and could not fix this one. Same guard; the job now terminates `cancelled_unauthorized`.

The repro is a test, and it is honest about what it has to do: `0002_authorization.sql`'s
`memberships_finite_window` CHECK means the row **cannot be written any more**, so the test
drops that constraint as the superuser, makes the write through a genuine administrator
unit of work (the administration trigger is not touched — only the bound is impossible),
runs the job, repairs the row, and re-adds the constraint. Re-adding it is a second
assertion: `ADD CONSTRAINT` validates every existing row.

### 3.5 Post-review corrections

Three defects found after the first submission — one by orchestrator verification, two
by the independent second review. All three are the same species: **a proof that did not
prove what it claimed.**

#### The C-2 lease-recovery proof was order-dependent

`crash-restart.test.ts` describe-block B passed in the full suite and failed
**deterministically in isolation, 5 runs of 5**. It is the proof for TDG-04 GO condition
C-2 (FAD-14) — the mitigation for graphile-worker's non-configurable four-hour lease — so
a proof holding only under unstated preconditions is not acceptable there.

**The hidden precondition, established rather than guessed:** block B publishes one
outbox event, then starts a real worker that takes **whatever job is next** and dies
holding it; every later assertion is about `published.jobId`. That is only the job the
worker took if the queue was empty. Instrumenting the child's `delivering` event showed
it plainly:

```
DIAG published.id=f1d63fb7-…  published.jobId=5  child-took=4d0d5116-…
```

`jobId=5` — four jobs were already queued, and the child took one of them. Those four are
**this task's own doing**: §3.3's `seedAuditAndOutbox` seeds one outbox event per group
across both organizations, needed so the wrong-tenant probe over `outbox_events` is not
vacuous. In the full suite an earlier file's dispatcher drained them first; alone, nothing
did, `published.jobId` was never leased, and the assertion reported `locked_by = null` —
the exact shape of the four-hour problem the test exists to disprove.

**Not a defect in the reclaim path**, so no FAD-14 escalation: once the precondition
holds, the replacement reclaims and completes the stranded job in **574–576 ms** across
three consecutive isolated runs. The mitigation works; the test's setup did not say what
it needed.

**The fix** establishes the precondition and then asserts it:

1. `drainQueue()` empties the queue the way production does — a real dispatcher with the
   real `DatabaseOutboxSink`, never a `DELETE`, because a test that empties a queue with
   a statement the system cannot issue asserts against a state the system cannot reach.
   It reports what it drained (`drained 4 pre-existing job(s)`).
2. `expect(delivering.outboxEventId).toBe(published.id)` — the assumption is now a
   first-class assertion, so a future backlog fails loudly and specifically instead of
   silently measuring the wrong job.

#### T-01 — the audit-emission gate had no red case

§3.2's static gate was correct when probed by hand but **nothing proved it could fail**,
which is the same class as R-02 against OPUS-M1-003. The scanner moved to
`apps/api/test/support/audit-emission-scan.ts` — exported, one implementation — and the
red cases run **it** against fixtures on disk, the pattern `tenant-access-scan.ts`
already established. Six write detectors instead of one combined regex, each fired by its
own fixture, because a single pattern can only be proved as a whole and a broken
alternative is otherwise carried by its neighbours.

Both directions, plus the failure mode a non-vacuity floor catches only by accident: a
subdirectory prefix matching nothing. **Verified red** by inverting one character in one
detector (`updateTable` → `updateTabIe`): 4 tests fail, including the per-detector case
naming the broken one.

#### T-02 — the deny-ordering test denied one layer too early

It drove `alpha.users.groupOnly` at an organization-scoped route. That principal holds no
organization membership, so SPEC-01 §2.3 step 2 refuses **in the middleware** and the
handler never runs — meaning the test passed identically against a handler ordered
mutate → evaluate → audit. It asserted that the middleware works while claiming to assert
the merge's central property.

The actor is now `alpha.users.member`: an active group membership in Group One, so §2.3
resolves it, and the group role `member` does not carry `membership.touch_self`, so
SPEC-06 denies at L4.2 **inside the handler's open transaction**. Three assertions
discriminate that from a middleware refusal — the status is **403** (every §2.3 failure is
404, SPEC-01 §2.4), the logged decision names an **L4** step and `NO_CAPABILITY`, and a
decision was logged at all. Then the property: `last_active_at` unmoved, zero audit rows.

A paired case grants the capability and re-runs the same request: **200, the row moves,
exactly one audit row.** Without it the denial test would pass for a route that is simply
broken.

#### T-04 — the two halves of FAD-14's pinning now cite each other

`roles-and-schema.test.ts`'s `SANCTIONED_ROLE_SCOPED` and `chain.test.ts`'s
maintenance-read assertion cover different things and neither subsumes the other: the
latter covers **both** maintenance policies including `audit_chain_heads`, which is not in
`TENANT_TABLES` and is invisible to the former; the former is what stops a *new*
role-scoped policy appearing anywhere in the registry. Each now names the other, so an
edit cannot leave FAD-14 pinned by half a test.

---

## 4. Verification — commands and results

Every capture in this directory is verbatim, from one pass on this branch after the last
change.

| Artefact | Command | Result |
|---|---|---|
| [`check-output.txt`](check-output.txt) | `corepack pnpm check` | **12 gates, 12 passed, 0 failed** |
| [`test-battery-output.txt`](test-battery-output.txt) | `corepack pnpm exec vitest run` | **36 files, 551 tests, 551 passed** |
| [`red-cases-output.txt`](red-cases-output.txt) | `corepack pnpm red-cases` | **14 cases, 14 proven, 0 not proven** |
| [`migration-cycle-output.txt`](migration-cycle-output.txt) | `corepack pnpm exec tsx test/support/migrate-cycle-cli.ts` (in `apps/api`) | **up → down → up → down → up clean, 860 ms**, 0001+0002+0003 |
| [`cross-product-output.txt`](cross-product-output.txt) | `corepack pnpm exec vitest run --project domain --reporter=verbose` | **39,285,000 cases, 0 disagreements** |
| [`chain-verification-output.txt`](chain-verification-output.txt) | `corepack pnpm exec tsx apps/api/test/support/audit-verify-demo.ts` | **exit 0 / 1 / 0** — intact, broken, intact |
| [`standalone-sweep-output.txt`](standalone-sweep-output.txt) | `vitest run --project api <file>`, once per file | **24 files, 24 pass ALONE, 0 order-dependent** |
| [`environment.txt`](environment.txt) | — | host, Node, pnpm, branch, log |

### Both verification modes, for the order dependence specifically

| Mode | Result |
|---|---|
| `vitest run --project api apps/api/test/audit/crash-restart.test.ts`, **6 consecutive runs** | 4/4 tests pass every time. Before the fix: 2 failed, 5 runs of 5 |
| full battery, before and after | 36 files / 551 tests, exit 0 |
| every other api file, alone | 24/24 pass — the sweep found no sibling |

### The combined migration order

`0001 → 0002 → 0003` up, `0003 → 0002 → 0001` down, and **`tables remaining after down:
(none)`, `policies remaining after down: 0`.** The numbering is unchanged: 0002 and 0003
were authored in parallel and do not collide. Neither depends on anything the other
creates — 0003's tables reference only `organizations` and `groups`, both from 0001 — so
the ordering works as authored and nothing was reordered. The down-order concern the packet
named (0002's `app_acting_membership_role_holds` must drop after the policies depending on
it) is satisfied by 0003 dropping first, which the capture shows.

The cycle also runs inside `test/support/global-setup.ts` before every test run, so the
545-test battery executes against a schema whose down migration has just been proven
executable.

### Test counts, before and after

| | Tests |
|---|---|
| merge of both branches, before any integration work | 531 (1 failing — see below) |
| after items 1 and 4 | 534 |
| after item 2 | 541 |
| after item 3 | 545 |
| after the post-review corrections (§3.5) | **551** |

The one failure on the raw merge was `http-authorization.test.ts`'s assertion that **no
audit table exists** — M1-002's contract with M1-003, correct when written and obsolete at
merge. It is replaced by its opposite (§3.2), not deleted.

---

## 5. What is NOT proven

| # | Claim NOT made | Why, and what would prove it |
|---|---|---|
| 1 | **SPEC-06 §8.1's six-way surface agreement.** | Two of six surfaces exist — HTTP and the worker — and they now share one evaluator. Publication, report request, document upload and WebSocket command do not exist. Each must run SPEC-01 §7.1's table when it lands |
| 2 | **`provisionAuthorization` emits no audit event.** | It writes roles, role capabilities, entitlements and group availability through 0002's bootstrap door, before the organization has a membership — so there is no actor, and the only production caller is the test fixture. When an operator surface lands it must be audited as a **system action**. Recorded, not fixed |
| 3 | **The entitlement outbox event has no real consumer.** | `DatabaseOutboxSink` writes an `outbox_effects` row and nothing leaves the machine. Nothing yet reads that effect to invalidate a live session or notify an administrator. Real delivery is SPEC-07 / TDG-06 |
| 4 | **A system-actor job still has no capability set.** | SPEC-06 §5 gives one "its own narrow capability set"; the catalogue has no system-actor role and the evaluator no slot for one, so the worker refuses such jobs. Refusing is the honest behaviour, not the finished one |
| 5 | **No authorization cache exists, so I-19 holds trivially.** | Every fact is re-read per request and per job execution. SPEC-06 §4's cache design is unimplemented — the safest state, and the one that will need re-proving when a cache lands |
| 6 | **The checkpoint signing key is not isolated.** | `LocalCheckpointSigner` holds it in the process (`keyIsIsolated === false`), including in the fixture seed. A verified checkpoint proves the signing path works and nothing about who could have produced it. SPEC-11 §6 / TDG-15 remain deployment conditions |
| 7 | **`audit_chain_heads` and `queue_pools` are not covered by the generic probes.** | Both are declared in `schema-census.ts` with reasons. `audit_chain_heads` is unreachable by any runtime role, which is stronger than the registry can express and is pinned separately; `queue_pools` is deliberately not tenant-scoped |
| 8 | **The T-15 storm's organization-scoped contexts probe only.** | They do not run the storm's workload — that workload is group-scoped by construction. Concurrency *under* an organization-scoped write path is unproven |
| 9 | **The fault schedule in T-15 is one deterministic interleaving.** | Fixed modulus, not a seeded RNG. Reproducible, and it explores one pattern rather than sampling many. Unchanged from OPUS-M1-001 and restated because it still holds |
| 10 | **`app_breakglass` reads every tenant table.** | `BYPASSRLS` by design (SPEC-01 §4.4, two-person emergency). The audit obligation on its sessions is **not implemented** — SPEC-11 §3.2's requirement that support and break-glass reads be audited to the same chain lands with the support tooling |
| 11 | **No external re-review.** | FAD-6: internal adversarial verification gates M1; external re-review is required and blocking for beta entry (V-04) |
| 12 | **Nothing here claims compliance.** | Not HIPAA, PHIPA, SOC 2, ISO 27001 or GDPR readiness. The required legal and operational work is explicitly not done (doc 14 §11) |
| 13 | **Order-independence is proven per FILE, not per test.** | The sweep runs each file alone. A test that depends on an earlier test *within its own file* would still pass, and several deliberately do (block B follows block A; the emission cases run in sequence). Per-test isolation would need `sequence.shuffle` or a per-test transaction — see item 14 |
| 14 | **T-03: the shared fixture is accumulating coupling, and this is a named M2-entry consideration.** | 551 tests now run against ONE seeded fixture in ONE database. Three couplings were found and fixed during this task alone — a grant that broke an unrelated denial test, an extra organization membership that broke X-07, and the queue backlog above. Each fix was local; the pattern is not. Per-test transactional rollback, or a dedicated organization for mutating suites, is worth **costing before M2** rather than after the next one. Recorded, not implemented — it is a test-architecture change, not a defect |
| 15 | **Two concurrent test runs in the same worktree COLLIDE, and the signature is distinctive.** | The embedded-postgres port is derived per worktree, so a second run attaches to the first one's cluster. Observed signature: **18 failed FILES, 278 skipped tests, 0 failed tests** — file-level failures with no test-level failures. That is environmental and means "something else was running", not "the code is broken". Every capture in this directory was taken sequentially with nothing else running |

---

## 6. Files changed

| Path | |
|---|---|
| `apps/api/src/authz/authorize-request.ts` | `evaluateAction` split out; `evaluateInTransaction` delegates |
| `apps/api/src/db/schema.ts` | registry: 0003's four tables, the new scope, `name: string` |
| `apps/api/src/http/policy.ts` | `DeclaredAction`; provisional mechanism deleted |
| `apps/api/src/http/routes/authorization.route.ts` | three audit calls, one outbox publication |
| `apps/api/src/http/routes/context-probe.route.ts` | the composed conflict; frozen principal |
| `apps/api/src/jobs/handlers.ts` | SPEC-06 action declaration |
| `apps/api/src/jobs/worker.ts` | the evaluator; the S-21 guard |
| `packages/domain/src/audit/event-names.ts` | three event names, two subject types |
| `packages/domain/src/ports/job-queue.ts` | `FrozenJobContext.principalUserId` |
| `apps/api/test/support/schema-census.ts` | **new** — declared non-tenant tables |
| `apps/api/test/support/audit-emission-scan.ts` | **new** — the extracted emission scanner (T-01) |
| `apps/api/test/support/fixtures.ts` | `seedAuditAndOutbox` |
| `apps/api/test/support/global-setup.ts` | worker runner; seeds the audit/outbox partitions |
| `apps/api/test/support/harness.ts` | the new scope in `wrongTenantProbe` |
| `apps/api/test/audit/chain.test.ts` | X-02 restores by UPDATE; T-04 cross-reference |
| `apps/api/test/audit/crash-restart.test.ts` | block B establishes and asserts its precondition |
| `apps/api/test/audit/emission-coverage.test.ts` | the write-coverage gate, and its red cases (T-01) |
| `apps/api/test/authz/http-authorization.test.ts` | emission proofs replace "emits none"; deny-ordering fixed (T-02) |
| `apps/api/test/http/route-declarations.test.ts` | the mechanism stays deleted |
| `apps/api/test/jobs/job-context.test.ts` | A-07 dimensions, S-21 repro |
| `apps/api/test/red-cases/probe-is-not-vacuous.test.ts` | scope-aware probing |
| `apps/api/test/tenancy/roles-and-schema.test.ts` | FAD-14 exemption; registry completeness; T-04 cross-reference |
| `apps/api/test/tenancy/unit-of-work.test.ts` | organization probe contexts in the storm |
| `docs/dev-setup.md` | both appended sections, composed |
