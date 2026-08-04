# SPEC-05 — Schedule Version Identity, Coexistence, and Publication

**Status: `PROPOSED`.** Remediates **CAR-007** (High).
**Supersedes:** [06](../06-data-architecture.md) §3.3, invariant **D-1**, and the `assignments` / `assignment_versions` tables; [07](../07-schedule-and-publication.md) §§1–4.
**New invariants:** **I-18**, and database invariants **D-1a**, **D-1b**, **D-14**, **D-15**, **D-16**.
**New table (2026-08-01, V-21 / FD-8):** `current_published_assignments` — the real table on which D-1b's `EXCLUDE` constraint is declared (§2.1).
**ADR:** [ADR-0007](../decisions/ADR-0007-schedule-versioning.md) (revised).

> **What was wrong.** `D-1` was an exclusion constraint forbidding overlapping *active* assignments per membership **with no version in the equality columns**. Cloning a published V1 into a draft V2 therefore collided with V1's own identical rows. The only escapes were to mark V1's rows `superseded` — mutating history, so historical reports and calendars no longer show what staff saw — or to abandon cloning. Published immutability was **prose only**: no database rule stopped an ORM `UPDATE` on a published child row. `locked` existed twice (as a status value *and* as `is_locked`). The table's status list omitted the approval and publishing states the state diagram showed. And `assignment_versions` implied mutable assignments inside supposedly immutable versions.

---

## 1. Identity versus snapshot

**The root error was treating "an assignment" as one thing. It is two.**

| Concept | Meaning | Lifetime |
|---|---|---|
| **Assignment identity** | *"Dr A works the Monday day shift in this period"* — the stable thing a human means when they say "that assignment changed" | Spans versions |
| **Assignment snapshot** | *"In version 3, that assignment had these exact values"* | Belongs to **exactly one** version; **immutable once its version is published** |

**Two tables replace one:**

| Table | Key fields | Constraints |
|---|---|---|
| **`assignment_identities`** *(NEW)* | `id`, `organization_id`, `group_id`, `period_id`, `origin`, `created_at` | Composite FK to `groups`. **Never deleted.** Carries no schedule values |
| **`assignment_snapshots`** *(REPLACES `assignments`)* | `id`, `assignment_identity_id`, **`version_id`**, `membership_id`, `shift_id`, `starts_at`, `ends_at`, `origin`, `pick_position?`, `status`, `supersedes_snapshot_id?` | **`UNIQUE (version_id, assignment_identity_id)` (D-14)** — one snapshot per identity per version |

**`assignment_versions` is deleted.** Its purpose — "history of an assignment" — is now served correctly by *querying snapshots of one identity across versions*, which is both the honest model and a cheaper query. A per-assignment mutation log inside an immutable version was a contradiction.

---

## 2. Version-scoped conflict constraints

> **AMENDED 2026-08-01 (V-21 / FD-8)** — D-1b's previously stated mechanism **is withdrawn**. It could not be built: a PostgreSQL `EXCLUDE` constraint is a *table* constraint and cannot be declared on a view; `REFRESH MATERIALIZED VIEW` without `CONCURRENTLY` takes an `ACCESS EXCLUSIVE` lock that would serialise every publication across every tenant; and the `CONCURRENTLY` form cannot run inside a transaction block at all, so "refreshed inside the publication transaction" forced the blocking form. A view also sits outside the per-table RLS model of [SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §4.3, so it carried no fail-closed guarantee. **D-1b is now enforced on a real table.** [Rationale](../remediation/internal-verification-corrections.md) §1 FD-8.

| # | Invariant | Mechanism |
|---|---|---|
| **D-1a** | **No overlapping assignments for one membership *within a single version*, including across midnight** | `EXCLUDE USING gist (version_id WITH =, membership_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'active')` |
| **D-1b** *(mechanism amended 2026-08-01, V-21 / FD-8)* | **No overlapping assignments for one membership across the *current published* versions of *different* periods** | **`EXCLUDE` constraint on the real table `current_published_assignments`** (§2.1), maintained **inside** the publication transaction. Cross-period double-booking fails the *publishing* transaction, which is where it belongs |

**`version_id` in the equality columns is the entire fix for cloning.** V1 and V2 now hold identical assignment sets without conflicting, because the constraint asks "does this membership double-book *within this version*" — which is the question that was always meant.

**D-1b is what D-1 was reaching for and getting wrong.** A person must not be double-booked in reality; reality is the set of *currently published* versions, one per period. Draft and candidate versions are proposals and are deliberately allowed to conflict with published ones — that is what a proposal is.

### 2.1 `current_published_assignments` *(new table, 2026-08-01, V-21 / FD-8)*

| Column | Notes |
|---|---|
| `id` | PK |
| `organization_id`, `group_id` | **RLS-enabled**, carrying both the organization and the group predicate ([SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §4.3). Unlike a view, this table *is* covered by the fail-closed guarantee |
| `membership_id` | The person who must not be double-booked |
| `period_id` | Which period this row's version belongs to |
| `starts_at`, `ends_at` | The occupied interval |
| `source_version_id` | The **current published** version the row was derived from |
| `source_snapshot_id` | The `assignment_snapshots` row it was derived from |
| `assignment_identity_id` | For traceability back to the identity |

**Constraint (D-1b):**

```sql
EXCLUDE USING gist (
    membership_id            WITH =,
    tstzrange(starts_at, ends_at) WITH &&
)
```

Note there is deliberately **no `version_id` and no `period_id` in the equality columns** — the point of D-1b is that a person cannot be in two places in *reality*, regardless of which period's schedule put them there. D-1a handles the within-version case; this handles the across-period case, and the two are separate constraints on separate tables for that reason.

| Property | Design |
|---|---|
| **Maintenance** | Exclusively inside the publication transaction (§6 step 12): **delete the outgoing version's rows, insert the incoming version's rows**, under the period-scoped serialization publication already holds at step 02 |
| **Where a violation surfaces** | In the **publishing** transaction, as a constraint violation, which aborts the publication. This is the correct place: the schedule that would create the double-booking is the one that fails |
| **Locking** | Contention is on the **per-membership rows touched**, not on a global object. Two publications for unrelated memberships do not block each other; two publications that genuinely double-book the same person are serialised and the second fails — which is the intended behaviour, not a scalability defect |
| **No view, no refresh** | Nothing is refreshed, nothing takes `ACCESS EXCLUSIVE`, nothing needs `CONCURRENTLY`, and nothing runs outside a transaction block |
| **RLS** | Enabled, `FORCE ROW LEVEL SECURITY`, same predicates as every other tenant table |
| **Test V-15 is now executable** | It asserts rejection through this constraint (§8) |

---

## 3. Version states and locking

### 3.1 Complete state set

The table's status list now matches the state machine exactly. **The previous mismatch was itself a defect** — a reviewer could not tell which was authoritative.

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> in_review: submit for approval
    in_review --> draft: changes requested
    in_review --> approved: approver approves
    approved --> draft: withdraw approval
    approved --> publishing: publication transaction begins
    publishing --> published: transaction commits
    publishing --> approved: transaction fails (nothing changed)
    published --> superseded: a later version becomes current
    draft --> cancelled: abandon
    in_review --> cancelled: abandon
    approved --> cancelled: abandon
    published --> [*]
    superseded --> [*]
    cancelled --> [*]
```

`state ∈ {draft, in_review, approved, publishing, published, superseded, cancelled}`.

**`publishing` is a real, durable state**, not a moment. It is what makes a failed publication diagnosable and a concurrent attempt detectable.

### 3.2 Lock is one orthogonal concept

**`locked` is removed from the state enum.** It was never a lifecycle state; it is an editability flag, and representing it twice guaranteed the two would disagree.

| Field | Meaning |
|---|---|
| `lock_state ∈ {unlocked, locked}` on `schedule_versions` | An administrator has frozen editing of a **draft**. Meaningless — and rejected by a `CHECK` — on a published version, which is immutable regardless |
| `assignment_snapshots.is_pinned` | This snapshot is a **fixed assignment**: the solver must preserve it. **Renamed from `is_locked`**, because it is a solver input, not an editing control |

**CAP-017's traceability referenced `is_fixed` while the schema said `is_locked` (CAR-020). Both names are retired in favour of `is_pinned`, and the trace is corrected.**

---

## 4. Database-enforced published immutability

**I-18 — Once a version reaches `published`, its row and every child row are immutable in the database. Immutability is enforced by database rules, not by application discipline.**

| # | Mechanism | Covers |
|---|---|---|
| **D-15a** | `BEFORE UPDATE OR DELETE` trigger on `assignment_snapshots`, `shifts`, `schedule_conflicts`, and `credits` that **raises** when the parent version's state is `published` or `superseded` | ORM writes, ad-hoc SQL, well-meaning repair scripts |
| **D-15b** *(amended 2026-08-01, V-22)* | `BEFORE UPDATE` trigger on `schedule_versions` permitting **only** the four columns in the table below, each **only via its defined transition**. **Every other column is frozen** | Version-row tampering |
| **D-15c** | `BEFORE DELETE` trigger on `schedule_versions` that **always raises** for `published` and `superseded` | Deletion of history |
| **D-15d** | `publication_records` and `version_supersessions` have no `UPDATE`/`DELETE` grant for any runtime role | Rewriting the publication record |

> **AMENDED 2026-08-04 (FAD-22, from OPUS-M3-003's independent second review — three corrections, each strengthening, none weakening):**
> 1. **D-15a covers `INSERT` as well.** The review demonstrated that a `BEFORE UPDATE OR DELETE`-only trigger lets a published version's child **set grow** — a new `assignment_snapshots` row can be attached to a published `version_id`, changing the version's content and its re-derived affected-staff set while every existing row stays "immutable." I-18's words — "its row and **every child row** are immutable" — mean **set-immutability**: the mechanism is now `BEFORE INSERT OR UPDATE OR DELETE`, with the guard reading `COALESCE(NEW.version_id, OLD.version_id)`. The service layer enforces the same boundary: **every** exported mutator of version-scoped content (assignments, pins, credits, conflicts) refuses a non-draft version — credit moves and conflict recording included; a post-publication credit correction is expressed on a **draft** of the next version, never against published history.
> 2. **The §6 publication signature requires `expected_prior_current_version_id`.** §6's same-key/same-version mechanisms only catch same-version races; the review showed two concurrent publications of *different* approved versions both succeeding, one instantly superseded — V-12's "the loser fails explicitly" cannot hold under an optional parameter. The caller states which current version it believes it is superseding (`NULL` for a first publication); a mismatch fails explicitly (`CURRENT_VERSION_MOVED`).
> 3. **The publication idempotency key has one domain**: `^[A-Za-z0-9_.-]{1,64}$`, validated at the contract layer and CHECK-enforced on `publication_records`, sized so the composed outbox key also satisfies SPEC-07's outbox-key constraint. A replay returns the **recorded** outcome (from the publication record), never a fabricated empty one, and a reused key naming a different version fails explicitly.

### 4.1 D-15b's permitted-column set on a `published` or `superseded` row *(added 2026-08-01, V-22)*

> **AMENDED 2026-08-01 (V-22)** — as previously written, D-15b froze `is_current`, which **publication step 08 must clear on the outgoing version**. The publication transaction the trigger exists to protect could therefore never run a second time, D-16 could not be maintained, and the defect would have been discovered under time pressure and closed by widening the trigger — which is how prose immutability returns. The permitted set is now stated explicitly and narrowly ([rationale](../remediation/internal-verification-corrections.md) §2).

| Column | Permitted transition | Permitted only from |
|---|---|---|
| **`is_current`** | `true → false` on the **outgoing** version; `false → true` only as part of the same publication that sets `state='published'` | The publication transaction (§6 steps 08–09), under the step-02 period lock |
| **`lock_state`** | `unlocked ↔ locked` | Administrator lock/unlock. Rejected by `CHECK` on `published`/`superseded` rows (§3.2), so in practice this permission matters only for the pre-publication states — it is listed here so the trigger's set is complete and reviewable |
| **`superseded_at`** | `NULL → timestamp`, once, and only together with `state: published → superseded` | The publication transaction (§6 step 11) |
| **`superseded_by_version_id`** | `NULL → version id`, once, and only together with `state: published → superseded` | The publication transaction (§6 step 11) |
| **`state`** | **Only** `published → superseded` | The publication transaction (§6 step 11) |

**Every other column on a `published` or `superseded` row is frozen without exception** — `version_number`, `period_id`, `published_at`, `published_by`, `cloned_from_version_id`, and everything else. A permitted column changing outside its defined transition raises exactly as an unpermitted column does: the trigger checks the *transition*, not merely the *column name*.

**Why triggers rather than grants.** Grants are per-table, and the application legitimately needs `UPDATE` on `assignment_snapshots` — for **draft** versions. The permission depends on the *parent row's state*, which only a trigger can evaluate. The `app_migrator` role can still perform a reviewed corrective migration; that is deliberate, and such a migration is itself an audited, two-person event ([SPEC-11](SPEC-11-audit-assurance-and-security-boundaries.md) §3).

---

## 5. Current version selection

| # | Invariant | Mechanism |
|---|---|---|
| **D-16** | **Exactly one current version per period** | `UNIQUE (period_id) WHERE is_current` on `schedule_versions` |
| **D-9** *(retained)* | Version numbers gapless per period | `UNIQUE (period_id, version_number)`, allocated inside the publication transaction |

`is_current` is set and cleared **only inside the publication transaction**, so there is never an instant with zero or two current versions. Calendars, reports, and the on-call feed resolve "the schedule" through `is_current`; historical reads resolve through an explicit `version_id`.

---

## 6. The publication transaction

```
PUBLISH (period_id, version_id, publication_idempotency_key, expected_version_state)

withUnitOfWork(ctx):                                   -- SPEC-01 §4
  01 INSERT publication_records (period_id, publication_idempotency_key, ...)
       ON CONFLICT (period_id, publication_idempotency_key) DO NOTHING
     -- zero rows => replay: return the recorded result, emit nothing
  02 SELECT ... FROM schedule_periods WHERE id = :period FOR UPDATE
     -- single-writer point for this period
  03 assert version.state = :expected_version_state = 'approved'
  04 UPDATE schedule_versions SET state = 'publishing' WHERE id = :version
  05 assert no schedule_conflicts with severity='hard-breach' and state='open'
  06 assert every HARD rule re-validated                      -- SPEC-04 §3.3
  07 version_number := max(version_number)+1 for the period            [D-9]
  08 UPDATE schedule_versions SET is_current = false WHERE period_id = :p AND is_current
  09 UPDATE schedule_versions SET state='published', is_current=true,
                                  published_at, published_by
  10 INSERT version_supersessions (prior_current, this_version)   -- if a prior existed
  11 UPDATE prior version SET state='superseded', superseded_at
  12 -- amended 2026-08-01, V-21 / FD-8: a real table, not a view refresh
     DELETE FROM current_published_assignments WHERE source_version_id = <prior current>
     INSERT INTO current_published_assignments
          (organization_id, group_id, membership_id, period_id,
           starts_at, ends_at, source_version_id, source_snapshot_id,
           assignment_identity_id)
       SELECT ... FROM assignment_snapshots
        WHERE version_id = :version AND status = 'active'
     -- the EXCLUDE constraint on current_published_assignments (D-1b, §2.1) raises here
     --   and ABORTS THE PUBLICATION if this version double-books anyone in reality.
     -- Serialised by the step-02 period lock; contention is per-membership, not global.
  13 INSERT outbox_events (SchedulePublished, affected_membership_ids)   -- ADR-0009
  14 INSERT audit_events
  15 UPDATE publication_records SET outcome='published', ...
COMMIT
-- notifications dispatch after commit, never inside                     -- I-11
```

| Property | Design |
|---|---|
| **Idempotent** | Step 01. **A retried publication publishes once** (D-17: `UNIQUE (period_id, publication_idempotency_key)`) |
| **Atomic** | Steps 08–11 are one transaction. There is no instant with two current versions |
| **Concurrent publication** | Both contend on step 02. The first commits; the second finds `state != 'approved'` at step 03 and fails with an explicit conflict. **Exactly one outbox event** |
| **Failure** | `publishing → approved`, nothing else changed, failure recorded and surfaced |
| **Failover mid-publication** | The transaction either committed or did not. A `publishing` row observed after failover with no committed outcome is resolved by the reconciler ([SPEC-10](SPEC-10-deployment-topology.md) §5) back to `approved` |

### 6.1 Amendment, revert, and supersession

| Operation | Mechanism |
|---|---|
| **Amend** | Clone the current version into a new `draft` (§7), edit **the clone**, approve, publish. The prior version becomes `superseded` and **is not modified in any other way** |
| **Revert** | **Publish forward.** Clone the target historical version into a new draft, publish it as V(n+1). History stays a straight line and the revert is itself a recorded act |
| **Supersede** | A consequence of publication, never an independent operation |
| **Delete** | **Does not exist.** D-15c makes it impossible |

---

## 7. Cloning

```
CLONE (source_version_id) -> new draft version
  INSERT schedule_versions (period_id, state='draft', cloned_from_version_id, ...)
  INSERT shifts               SELECT ... FROM shifts WHERE version_id = :source
  INSERT assignment_snapshots SELECT assignment_identity_id,      -- identity PRESERVED
                                     :new_version_id, membership_id, shift_id,
                                     starts_at, ends_at, origin, pick_position,
                                     'active', id AS supersedes_snapshot_id
                              FROM assignment_snapshots WHERE version_id = :source
```

**No row in the source version is read for update, modified, or marked superseded.** The clone succeeds because D-1a is scoped by `version_id`. This is the operation that was impossible before.

**Identity is preserved across the clone**, which is what makes "what changed between V2 and V3?" a join on `assignment_identity_id` rather than a heuristic diff.

---

## 8. The required proof (CAR-007 regression test)

**A database-level design test. Not executed.**

| # | Step | Assertion |
|---|---|---|
| V-01 | Create period, build, approve, **publish V1** | V1 `published`, `is_current`, `version_number = 1` |
| V-02 | Capture `sha256` of every V1 row and of a generated report and calendar feed | Baseline recorded |
| V-03 | **Clone V1 → V2 (draft), unchanged** | **Clone succeeds.** *(Impossible under old D-1)* |
| V-04 | Re-hash V1 | **Byte-identical to V-02** |
| V-05 | Amend one assignment in V2 | Only V2 changes |
| V-06 | Attempt `UPDATE` on a V1 snapshot | **Trigger raises (D-15a)** |
| V-07 | Attempt `DELETE` on the V1 version row | **Trigger raises (D-15c)** |
| V-08 | Approve and **publish V2** | V2 current; V1 `superseded`; **V1 rows still byte-identical** |
| V-09 | Regenerate the V1 report and calendar feed by `version_id` | **Byte-identical to V-02** |
| V-10 | **Revert: clone V1 → V3, publish** | V3 current; V1 and V2 both unchanged and both readable |
| V-11 | Re-hash V1 and V2 | **Both byte-identical** |
| V-12 | Publish V2 and V3 concurrently | **Exactly one current version; exactly one outbox event**; the loser fails explicitly |
| V-13 | Replay a publication with the same idempotency key | Publishes once |
| V-14 | Double-book a membership within one version | **Rejected by D-1a** |
| V-15 | Publish a version double-booking a membership already committed in another period | **Rejected by D-1b** — the `EXCLUDE` constraint on `current_published_assignments` (§2.1) raises inside the publishing transaction, which aborts. *(amended 2026-08-01, V-21 / FD-8 — executable now that the mechanism is a real table)* |
| V-15b | Two publications for **different** memberships in different periods, concurrently *(added 2026-08-01, V-21 / FD-8)* | **Both succeed.** Contention is per-membership row, not a global lock |
| V-15c | After V-08 and V-10, compare `current_published_assignments` to the set of `active` snapshots in the `is_current` version of every period *(added 2026-08-01, V-21 / FD-8)* | **Exactly equal.** The table has no stale rows from superseded versions |
| V-16 | Kill the process mid-publication, restart | No partial state; reconciler returns the version to `approved`; `current_published_assignments` reflects the prior current version only |
| V-17 | **D-15b per-column matrix** *(added 2026-08-01, V-22)*: on a `published` row, attempt each of `is_current` (`true→false`), `lock_state`, `superseded_at`, `superseded_by_version_id`, and `state` (`published→superseded`), each **via its defined transition** | **Each individually permitted change succeeds** |
| V-18 | Same row, attempt **every other** column — `version_number`, `period_id`, `published_at`, `published_by`, `cloned_from_version_id`, and each remaining column in turn *(added 2026-08-01, V-22)* | **Each raises (D-15b).** One case per column; no column is untested |
| V-19 | A **permitted** column changed **outside** its defined transition — e.g. `superseded_at` set without `state → superseded`, or `is_current` set `false→true` on a row that is not being published *(added 2026-08-01, V-22)* | **Raises.** The trigger gates the transition, not merely the column name |

**Earliest execution point: schema/prototype stage**, per CAR-025.

---

## 9. Downstream reconstruction

> **AMENDED 2026-08-01 (V-13 / FD-5)** — the picklist row below is corrected. Picklist selections and picklist corrections write **picklist-owned daily-assignment records**, not schedule versions ([rationale](../remediation/internal-verification-corrections.md) §1 FD-5).

| Consumer | Binding |
|---|---|
| **Reports** | Bind an explicit `version_id` in the input snapshot ([SPEC-09](SPEC-09-report-snapshot-and-artifact-authorization.md)) |
| **Calendar feeds** | Resolve `is_current` at render; the response records which `version_id` it rendered |
| **Daily assignment sheet** *(amended 2026-08-01, V-13 / FD-5)* | Renders the `is_current` version's assignments **plus the `daily_assignments` overlay** for that date ([SPEC-02](SPEC-02-picklist-turn-transaction.md) §2.1); `version_id` and the overlay's provenance are both printed on the artifact |
| **Audit** | Names the `version_id` and the `assignment_identity_id`, so "what changed for this assignment" is answerable across versions |
| **Picklist selections and corrections** *(amended 2026-08-01, V-13 / FD-5)* | Revise **`daily_assignments`** (audited supersession, [SPEC-02](SPEC-02-picklist-turn-transaction.md) §7), **not** schedule versions. The previous statement that picklist corrections produce a new version is **withdrawn**: a live turn never touches a published version, so D-15a is never reached by the picklist module and the turn transaction stays single-aggregate |
| **Vacation commit** | Targets a **draft** version and is idempotent by `(selection, version)` |
| **Marketplace** | Binds `assignment_identity_id` **and** the source `version_id` ([SPEC-13](SPEC-13-marketplace-version-binding.md)) |

---

## 10. Traceability

**Capabilities:** CAP-014, CAP-017, CAP-018, CAP-019, CAP-020, CAP-023, CAP-027, CAP-045, CAP-046, CAP-047, CAP-049.
**Decisions:** none pending on this path.
**ADR:** [ADR-0007](../decisions/ADR-0007-schedule-versioning.md) (revised).
**Gates:** `G-BETA`, `G-PROD` (SBX-017, SBX-018). **Neither executed.**
