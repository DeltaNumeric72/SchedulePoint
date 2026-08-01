# SPEC-13 — Marketplace Version Binding, Lock Order, and Deadlock Policy

**Status: `PROPOSED`.** Remediates **CAR-018** (Medium).
**Supersedes:** [09](../09-requests-vacation-opportunities-transfers.md) §§3–5.
**ADR:** [ADR-0007](../decisions/ADR-0007-schedule-versioning.md) (revised), [ADR-0009](../decisions/ADR-0009-job-and-event-reliability.md).

> **What was wrong.** The atomic claim was a conditional update on `opportunities.status` plus revalidation. **The expected assignment version was not part of the compare-and-set.** Exactly one claimant could win the *status* race while the underlying assignment had been revised, superseded, or already transferred. Two-leg swaps had no lock order and no deadlock policy. "Invalidation after publication" was promised but bound to nothing.

---

## 1. What a claim must actually bind

| Bound | Why |
|---|---|
| `opportunity_id` + expected `status = 'posted'` | Exactly one claimant (previously the only binding) |
| **`assignment_identity_id`** | The stable thing being transferred ([SPEC-05](SPEC-05-schedule-version-identity-and-publication.md) §1) |
| **`source_version_id`** | The version the offer was made against |
| **`expected_snapshot_id`** | The exact snapshot row the poster offered |
| `claimant_membership_id` | Who is claiming |
| `command_id` | Idempotency |

**Posting records all four schedule bindings. Claiming asserts them.** A publication between post and claim changes `source_version_id`, and the claim fails with `STALE_ASSIGNMENT` instead of transferring something that no longer exists in that form.

---

## 2. The claim transaction

```
CLAIM-OPPORTUNITY (opportunity_id, command_id, claimant, expected_source_version_id,
                   expected_snapshot_id)
withUnitOfWork(ctx):
  01 INSERT idempotency_records ... ON CONFLICT DO NOTHING   -- replay => recorded result
  02 SELECT ... FROM opportunities WHERE id = :o FOR UPDATE
  03 assert status = 'posted'                                        -- ALREADY_CLAIMED
  04 assert source_version_id  = :expected_source_version_id         -- STALE_ASSIGNMENT
  05 assert current published version for the period = source_version_id
  06 SELECT ... FROM assignment_snapshots WHERE id = :expected_snapshot_id
       AND version_id = :source_version_id AND status = 'active' FOR UPDATE
     -- zero rows => STALE_ASSIGNMENT
  07 re-check AT CLAIM TIME, in this transaction:
       qualification valid at the shift date; no conflicting assignment;
       minimum rest; maximum assignments; position restriction;
       staff-over-locum priority window
  08 create the replacement in a NEW draft version (SPEC-05 §7 clone + amend),
     preserving assignment_identity_id
  09 UPDATE opportunities SET status='claimed', claimed_by, claimed_at,
                              resulting_version_id
  10 INSERT opportunity_claims (winner and, for audit, the losers already recorded)
  11 INSERT audit_events; INSERT outbox_events
COMMIT
```

**Step 07 happens at claim time, not post time**, because the world changes between offering and taking: a credential expires, a conflicting assignment appears, rest is now violated.

**Step 08 never edits a published version.** The transfer produces a new schedule version that must itself be published — so the marketplace cannot silently mutate published history.

---

## 3. Deterministic lock order and deadlock policy

**A two-leg swap locks two assignment rows. Two reciprocal swaps locking in opposite order deadlock.**

| Rule | Detail |
|---|---|
| **L-1 · Canonical order** | All rows locked in **ascending `assignment_identity_id` (UUID byte order)**. Total, stable, and independent of which leg is "first" |
| **L-2 · Cross-entity order** | When a transaction locks several entity classes: `schedule_periods` → `schedule_versions` → `assignment_identities` → `assignment_snapshots` → `opportunities` → `shift_swaps`. **Fixed** |
| **L-3 · One transaction, both legs** | Both snapshots replaced in one transaction, or neither |
| **L-4 · Deadlock retry** | On a database deadlock error, retry up to 3 times with exponential backoff **and jitter** |
| **L-5 · Retry is idempotent** | Retries reuse the **same `command_id`**, so step 01 makes a retry after a partial-but-rolled-back attempt a no-op rather than a duplicate |
| **L-6 · Exhausted retries** | Explicit failure to the user. **Never a partial swap, never a duplicate notification** |
| **L-7 · Notifications after commit only** | A retried transaction cannot emit two notification sets, because the outbox row is written inside the transaction that finally commits |

**L-1 plus L-2 make deadlock rare; L-4 through L-7 make it harmless when it happens anyway.**

---

## 4. Invalidation on schedule change

Consuming `SchedulePublished`, `ScheduleAmended`, and `AssignmentChanged`:

| Affected | Action |
|---|---|
| Posted opportunity whose `source_version_id` is no longer current | **`invalidated`**; poster notified; **no longer claimable** |
| Pending offer or swap referencing a changed snapshot | **`invalidated`**; both parties notified |
| Claimed but not yet published | Flagged for scheduler review |
| Already published transfer | Unaffected — it is history |

**Invalidation is driven by the version binding, not by a heuristic.** That is the difference from the previous design, which promised invalidation with nothing to key it on.

### 4.1 Orphan prevention

**D-24 (new):** an `accepted` offer or swap must reference an `active` snapshot in the **current published** version — enforced by a periodic reconciler that moves violators to `invalidated` and alerts. The review's "accepted offer pointing to no active assignment" becomes detectable and self-healing rather than silent.

---

## 5. Staff-over-locum priority

`opportunities.locum_priority_until` set at post time from group configuration. During the window, a claim by a membership with `is_locum` fails at step 07 with `LOCUM_PRIORITY_WINDOW`. **PO-DEC-16 (default 24h) remains pending.**

---

## 6. Test contract

**Extends SBX-013b, SBX-014b, SBX-014c.**

| # | Test | Required outcome |
|---|---|---|
| M-01 | Two claimants, same opportunity | Exactly one wins; loser gets `ALREADY_CLAIMED` |
| M-02 | **Claim races a republication of the source assignment** | **Claim fails `STALE_ASSIGNMENT`. No transfer of a stale snapshot** |
| M-03 | Claimant's qualification expires between post and claim | Rejected at step 07 |
| M-04 | Claim would violate minimum rest | Rejected at step 07 |
| M-05 | Locum claims inside the priority window | Rejected |
| M-06 | **Two reciprocal swaps, opposite natural order** | **No deadlock** (L-1); if forced, retried and resolved (L-4) |
| M-07 | Forced deadlock, then retry | **One swap; one notification set** (L-5, L-7) |
| M-08 | Retries exhausted | Explicit failure; **no partial swap** |
| M-09 | One leg becomes invalid mid-transaction | **Whole swap fails; nothing changes** |
| M-10 | Publication invalidates a posted opportunity | `invalidated`; poster notified; claim now impossible |
| M-11 | Reconciler over a synthetic orphan | Detected and invalidated (D-24) |
| M-12 | Claim replayed with the same `command_id` | One claim |

---

## 7. Traceability

**Capabilities:** CAP-024, CAP-025, CAP-026, CAP-027, CAP-058, CAP-059.
**Decisions:** PO-DEC-12, PO-DEC-15, PO-DEC-16, PO-DEC-17 — **all pending.**
**Gates:** `G-BETA`, `G-PROD`. **None passed.**
