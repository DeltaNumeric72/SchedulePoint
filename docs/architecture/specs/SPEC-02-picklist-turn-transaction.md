# SPEC-02 — Picklist Turn Transaction and Coordinator Fencing

**Status: `PROPOSED`.** Remediates **CAR-003** (Critical).
**Supersedes:** [06](../06-data-architecture.md) §3.5 and invariant **D-3**; [10](../10-picklist-and-realtime.md) §§4–8; [ADR-0008](../decisions/ADR-0008-realtime-picklist-transport.md) Decision.
**New invariants:** **I-16**, and database invariants **D-3a**, **D-3b**, **D-3c**, **D-11**, **D-12**, **D-13**.
**ADR:** [ADR-0023](../decisions/ADR-0023-picklist-turn-transaction.md).

> **What was wrong.** `D-3` claimed the partial unique index on `selections (picklist_id, work_item_id) WHERE accepted` meant "at most one work item claimed per picklist." **It does not.** It guarantees at most one claimant *per work item*. One turn could accept two different work items and satisfy the index perfectly. Turn state, timer state, pause state, proxy authority, and client version were each verified in prose, in separate steps, outside the transaction that performed the insert. Nothing bound them. Nothing ordered events. Nothing prevented two coordinators from advancing the same list.

---

## 1. The corrected invariant

**I-16 — A picklist turn resolves through exactly one authoritative database transaction that consumes exactly one open turn and produces at most one accepted selection. Every predicate the decision depends on is evaluated inside that transaction.**

Three distinct uniqueness properties, previously conflated into one:

| # | Property | Enforced by |
|---|---|---|
| **D-3a** | **At most one accepted selection per turn** | `UNIQUE (turn_id) WHERE status = 'accepted'` on `selections` |
| **D-3b** | **At most one claimant per work item** | `UNIQUE (picklist_id, work_item_id) WHERE status = 'accepted'` on `selections` |
| **D-3c** | **At most one open turn per picklist** | `UNIQUE (picklist_id) WHERE state = 'open'` on `picklist_turns` |

**D-3a is the constraint that was missing.** The review's failure scenario — physician and proxy pick *different* rooms simultaneously — is stopped by D-3a and by nothing else.

---

## 2. Revised picklist tables

Replaces [06](../06-data-architecture.md) §3.5. Changes are marked **NEW** or **CHANGED**.

| Table | Key fields | Uniqueness / constraints |
|---|---|---|
| `picklists` | `group_id`, `date`, `mode`, `state`, `lock_state`, `turn_time_limit_seconds?`, **`aggregate_version`**, **`event_sequence`** | `(group_id, date)`; `state ∈ {draft, ready, active, paused, completed, cancelled, reopened}` |
| `picklist_participants` | `picklist_id`, `membership_id`, `position`, `state`, `acting_proxy_membership_id?` | `(picklist_id, position)`, `(picklist_id, membership_id)` |
| `picklist_work_items` | `picklist_id`, `title_ref`, **constrained value fields only** ([SPEC-03](SPEC-03-raw-ingress-trust-boundary.md)), `display_order`, `state`, `origin`, `import_batch_id?` | `(picklist_id, display_order)`; **no free-text field** — see [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) §5 |
| `picklist_turns` **CHANGED** | `picklist_id`, `participant_id`, `turn_ordinal`, `opened_at`, `expires_at`, `state`, `resolution`, `resolved_at?`, **`opened_by_fencing_token`** | **`UNIQUE (picklist_id) WHERE state='open'` (D-3c)**; `UNIQUE (picklist_id, turn_ordinal)`; `state ∈ {open, resolved, expired, skipped}` |
| `selections` **CHANGED** | **`turn_id`**, `work_item_id`, `picked_by_membership_id`, **`acted_by_membership_id`**, **`actor_role ∈ {participant, proxy, administrator}`**, `picked_at`, `status`, `resulting_assignment_id?`, **`command_id`** | **`UNIQUE (turn_id) WHERE status='accepted'` (D-3a)**; **`UNIQUE (picklist_id, work_item_id) WHERE status='accepted'` (D-3b)**; `status ∈ {accepted, rejected}` |
| `picklist_commands` **NEW** | `picklist_id`, `command_id`, `command_type`, `received_at`, `outcome`, `result_ref?` | **`UNIQUE (picklist_id, command_id)` (D-11)** — idempotency |
| `picklist_events` **NEW** | `picklist_id`, **`sequence`**, `event_type`, `payload`, `occurred_at`, `caused_by_command_id?` | **`UNIQUE (picklist_id, sequence)` (D-12)**; `sequence` allocated **inside** the transaction; append-only |
| `picklist_leases` **NEW** | `picklist_id` (PK), `coordinator_id`, **`fencing_token`**, `acquired_at`, `expires_at` | **`fencing_token` strictly increasing per picklist (D-13)** |

**`aggregate_version`** increments on every state transition and is the value clients echo.
**`event_sequence`** is the high-water mark from which `picklist_events.sequence` is allocated, guaranteeing one total order per picklist.

---

## 3. The authoritative selection transaction

**One transaction. Every predicate inside it. No exceptions.**

```
SELECT-WORK-ITEM (picklist_id, command_id, expected_aggregate_version,
                  work_item_id, actor_membership_id, fencing_token)

withUnitOfWork(ctx):                                  -- SPEC-01 §4
  01  INSERT INTO picklist_commands (picklist_id, command_id, ...)
        ON CONFLICT (picklist_id, command_id) DO NOTHING
      -- zero rows inserted => replay: return the recorded outcome, emit nothing   [D-11]

  02  SELECT ... FROM picklists WHERE id = :picklist_id FOR UPDATE
      -- single-writer serialisation point for this picklist

  03  assert picklists.aggregate_version = :expected_aggregate_version
      -- else VERSION_CONFLICT; client resynchronises

  04  assert picklists.state = 'active'                  -- not paused, not completed
  05  assert picklists.lock_state = 'unlocked'

  06  SELECT ... FROM picklist_turns
        WHERE picklist_id = :picklist_id AND state = 'open' FOR UPDATE
      -- exactly one row exists by D-3c; zero rows => NO_OPEN_TURN

  07  assert now() < turns.expires_at                    -- SERVER clock, never the client's
  08  assert authority(actor, turn) ∈ {participant, proxy, administrator}   -- §4
  09  assert lease.fencing_token <= :fencing_token       -- §6; stale coordinator rejected

  10  SELECT ... FROM picklist_work_items
        WHERE id = :work_item_id AND picklist_id = :picklist_id
          AND state = 'available' FOR UPDATE
      -- zero rows => ITEM_UNAVAILABLE with a refreshed choice list

  11  INSERT INTO selections (turn_id, work_item_id, status='accepted', ...)
      -- unique violation on (turn_id)              => TURN_ALREADY_RESOLVED   [D-3a]
      -- unique violation on (picklist_id,item_id)  => ITEM_ALREADY_TAKEN      [D-3b]

  12  UPDATE picklist_work_items SET state='taken' WHERE id = :work_item_id
  13  INSERT INTO assignments … (the resulting assignment)                 -- SPEC-12 owner
  14  UPDATE picklist_turns SET state='resolved', resolution='picked', resolved_at=now()
  15  next := advance()                                  -- §5
  16  UPDATE picklists SET aggregate_version = aggregate_version + 1,
                           event_sequence    = event_sequence + N
  17  INSERT INTO picklist_events (sequence = allocated in 16) …            [D-12]
        TurnResolved, WorkItemTaken, (TurnStarted | PicklistCompleted)
  18  INSERT INTO outbox_events …                                          -- ADR-0009
  19  INSERT INTO audit_events …
  20  UPDATE picklist_commands SET outcome='accepted', result_ref=…
COMMIT
-- broadcast AFTER commit, from picklist_events, in sequence order
```

**Every rejection path returns a typed error and a refreshed snapshot. None returns a silent no-op.**

### 3.1 Why each ordering choice matters

| Step | Rationale |
|---|---|
| 01 before everything | A replayed command must never re-execute, even if every other predicate still holds |
| 02 `FOR UPDATE` on the picklist row | Makes the picklist a **logical single writer** without needing a distributed lock. Concurrency across *different* picklists is unaffected |
| 03 version check after the lock | Checking before the lock would be a TOCTOU window |
| 07 server clock | I-08. A client clock is display only |
| 09 fencing after state checks | A stale coordinator must be rejected even when its view of state is coincidentally correct |
| 11 insert **decides** the race | Not a check-then-write. The constraints are the arbiter |
| 17 inside the transaction | Event order and durable state commit together, so replay is deterministic |
| broadcast after commit | Persist, then broadcast. A broadcast without a commit shows a pick that did not happen |

---

## 4. Authority resolution

Evaluated in step 08, **inside** the transaction, against **current** state ([SPEC-06](SPEC-06-authorization-truth-table.md) §4).

| Actor | Permitted when | Recorded as |
|---|---|---|
| **Participant** | `turn.participant_id` resolves to the actor's membership | `actor_role='participant'`, `acted_by = picked_by` |
| **Proxy** | An `active` proxy grant with `scope='act-on-behalf'` from the turn's participant, valid at `now()` | `actor_role='proxy'`, `picked_by = grantor`, **`acted_by = proxy`** |
| **Administrator** | Holds `picklist.intervene`; entitlement and availability satisfied | `actor_role='administrator'`, `picked_by = participant`, **`acted_by = administrator`** |
| **Anyone else** | — | Denied; audited as a security event |

**`picked_by` and `acted_by` are always both recorded.** Attributing a proxy's or an administrator's pick solely to the participant misleads exactly the investigation the audit trail exists to serve.

**The three-way race is resolved by D-3a, not by precedence.** If participant, proxy, and administrator all submit simultaneously, all three transactions contend on the step-02 lock; the first to commit wins; the other two receive `TURN_ALREADY_RESOLVED` with the accepted outcome. **There is no administrator override of an already-accepted selection** — correction after the fact is §7, which is a different, audited operation.

---

## 5. Advancement, timers, pause, and expiry

### 5.1 Advancement

`advance()` runs **inside** the same transaction:

1. Find the next `waiting` participant by `position`, skipping `excluded` and `skipped`.
2. If one exists → `INSERT picklist_turns (state='open', turn_ordinal+1, expires_at = now() + limit, opened_by_fencing_token = :token)`. **D-3c guarantees the previous turn is already `resolved` — otherwise the insert fails and the whole transaction aborts.**
3. If none exists → `UPDATE picklists SET state='completed'`.
4. If the list is `paused` → **no new turn opens.** The list stays paused with no open turn.

### 5.2 Pause racing an in-flight selection

**Pause is itself a command against the same lock.** It therefore serialises:

| Order | Result |
|---|---|
| Pause commits first | The selection transaction reaches step 04, finds `state='paused'`, and **aborts. Nothing is written** |
| Selection commits first | The selection is accepted and the turn resolved. Pause then applies, and `advance()` **does not open the next turn** |

**There is no interleaving in which a selection commits after the turn advanced**, because both paths hold the step-02 lock.

### 5.3 Expiry

The sweeper is an ordinary command through the same transaction:

```
EXPIRE-TURN: lock picklist → assert open turn → assert now() >= expires_at
           → turn.state='expired', resolution='timed_out' → advance() → events
```

| Property | Design |
|---|---|
| **Only the lease holder sweeps** | Step 09 fencing rejects a sweeper without the current token |
| **Multiple sweepers are safe anyway** | The lock plus D-3c make a duplicate sweep a no-op, not a double advance |
| **Expiry cannot preempt a committed selection** | It contends on the same lock; if the selection committed, there is no open turn to expire |
| **A list never deadlocks** | Every open turn has an `expires_at`, and the sweeper is unconditional |

---

## 6. Coordinator leases and fencing

**Multiple real-time coordinator instances are expected.** Fencing makes a partitioned or paused instance harmless.

| Element | Design |
|---|---|
| **Lease acquisition** | `INSERT … ON CONFLICT (picklist_id) DO UPDATE … WHERE lease.expires_at < now()`, setting `fencing_token = fencing_token + 1` |
| **Monotonic token (D-13)** | Strictly increasing per picklist. A token is never reused |
| **Renewal** | Before expiry, by the holder, **without** incrementing the token |
| **Every mutating command carries the token** | Step 09 rejects `token < stored` |
| **Loss of lease** | A coordinator that fails to renew stops broadcasting and drops its subscriptions. If it acts anyway, **step 09 rejects it** |
| **Why not rely on the lease alone** | A paused process can hold a lease it believes is valid. The token comparison is what makes the *database* the arbiter |

**Non-mutating broadcast does not require the lease** — a read-only coordinator replaying `picklist_events` in sequence order is always safe.

---

## 7. Correction and reopening after completion

Previously unspecified. **SBX-027 could not pass against the old design.**

```
REOPEN-PICKLIST (picklist_id, command_id, expected_aggregate_version, reason)
  requires: capability picklist.reopen; picklists.state = 'completed'
  → state='reopened'; append ReopenedByAdministrator event with reason; audit
  → previously accepted selections remain accepted and their assignments remain valid

CORRECT-SELECTION (turn_id, command_id, new_work_item_id?, reason)
  requires: capability picklist.correct; picklists.state ∈ {reopened, completed}
  in ONE transaction:
    UPDATE selections SET status='rejected', corrected_at, corrected_by, reason
      WHERE turn_id = :turn AND status = 'accepted'
    -- the partial indexes now permit a replacement, because the old row is no longer 'accepted'
    INSERT selections (turn_id, new_work_item_id, status='accepted', supersedes_selection_id)
    release the previous work item to 'available'; claim the new one
    replace the resulting assignment                       -- SPEC-05 §6, new schedule version
    append SelectionCorrected event; audit with reason
```

| Property | Design |
|---|---|
| **Correction is never a delete** | The superseded selection row is retained with `status='rejected'` and a supersession pointer |
| **D-3a still holds** | Exactly one `accepted` row per turn at any instant |
| **The assignment change is a schedule amendment** | It flows through [SPEC-05](SPEC-05-schedule-version-identity-and-publication.md), producing a new schedule version — **not** an in-place edit of a published one |
| **Reason is mandatory** | Enforced by a `CHECK` |
| **Racing corrections** | Serialised by the step-02 lock; the second sees the changed `aggregate_version` and fails with `VERSION_CONFLICT` |

---

## 8. Event ordering, reconnection, and replay

| Concern | Design |
|---|---|
| **Total order** | `picklist_events.sequence` is gapless per picklist, allocated under the picklist lock (D-12) |
| **Reconnect** | Client sends its last `sequence`; server replies with events after it, or a full snapshot plus the current `sequence` if the gap exceeds the retained window |
| **Duplicate delivery** | Clients discard `sequence <= last_applied`. Idempotent by construction |
| **Reordered delivery** | Clients buffer out-of-order frames and apply in sequence; a gap that persists beyond a timeout triggers a snapshot request |
| **Two coordinators broadcasting** | Both read the same `picklist_events`. They may duplicate a frame; they **cannot** disagree, because neither generates events — only the transaction does |
| **Snapshot** | Carries `aggregate_version`, `event_sequence`, current turn, remaining items, and participant states |

**This is the specific defect the review named:** "two coordinators emit different `TurnResolved`/`TurnStarted` sequences." Under this design coordinators do not *emit* anything — they *relay* a single durable ordered log.

---

## 9. Mode-specific behaviour

| Mode | Turn transaction | Notes |
|---|---|---|
| **Paper** | **Not used live.** Results are recorded afterwards through `RECORD-PAPER-RESULT`, which writes selections with `actor_role='administrator'`, `mechanism='paper'`, one transaction per result, same constraints | D-3a/D-3b still apply, so a transcription error that double-assigns a room is rejected |
| **Manual-entry** | Full §3 transaction | Work items typed by the scheduler under [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) §5 constraints |
| **Integrated** | Full §3 transaction | Work items imported through the ingestion boundary; `origin='imported'` |

**Switching mode never destroys an in-flight list** and is rejected while `state='active'`.

---

## 10. Test contract

**Extends SBX-020 through SBX-027. All pre-existing IDs. None has been executed.**

| # | Race / scenario | Required outcome |
|---|---|---|
| P-01 | Participant + proxy, **same** item | One `accepted`; other gets `ITEM_ALREADY_TAKEN` |
| P-02 | Participant + proxy, **different** items | **One `accepted`; other gets `TURN_ALREADY_RESOLVED`.** *(The defect CAR-003 named — impossible to satisfy before D-3a)* |
| P-03 | Participant + proxy + administrator, three-way, mixed items | Exactly one accepted selection; two typed rejections |
| P-04 | Duplicate command, identical `command_id` | Second returns the recorded outcome; **no second event** |
| P-05 | Pause commits during an in-flight selection | Either accepted-then-paused, or rejected-nothing-written. **Never both** |
| P-06 | Two sweepers expire the same turn | One expiry, one advance, one event set |
| P-07 | Two coordinators, one partitioned | Stale token rejected at step 09 |
| P-08 | Coordinator restart mid-turn | New lease, higher token, state intact, clients resync |
| P-09 | Reconnect after N turns | Client converges to identical state via events or snapshot |
| P-10 | Reordered / duplicated frames injected | Client state identical to the authoritative sequence |
| P-11 | Correction after completion | Old selection `rejected` and retained; new one `accepted`; new schedule version |
| P-12 | Two concurrent corrections | One succeeds; other gets `VERSION_CONFLICT` |
| P-13 | Same-item race, **≥50 trials** (SBX-022) | Exactly one winner every trial |
| P-14 | Different-item same-turn race, **≥50 trials** | Exactly one winner every trial |
| P-15 | Paper transcription double-assigning a room | Rejected by D-3b |

**Earliest execution point: schema/prototype stage.** Per CAR-025, P-01..P-15 run against a real PostgreSQL before picklist feature work.

---

## 11. Traceability

**Capabilities:** CAP-030, CAP-031, CAP-032, CAP-033, CAP-034, CAP-060.
**Decisions:** PO-DEC-18 (approved), PO-DEC-19 (pending — default proxy scope; the mechanism is unaffected either way).
**ADRs:** [ADR-0008](../decisions/ADR-0008-realtime-picklist-transport.md) (revised), [ADR-0009](../decisions/ADR-0009-job-and-event-reliability.md), **[ADR-0023](../decisions/ADR-0023-picklist-turn-transaction.md) (new)**.
**Gates:** `G-ARCH`, `G-PROD`. **None passed.**
