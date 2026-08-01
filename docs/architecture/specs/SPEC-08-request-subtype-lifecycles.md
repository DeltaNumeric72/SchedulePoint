# SPEC-08 — Request Aggregate, Subtype Constraints, and Vacation Lifecycle

**Status: `PROPOSED`.** Remediates **CAR-011** (High).
**Supersedes:** [06](../06-data-architecture.md) §3.4 `requests` and `vacation_selections`; [09](../09-requests-vacation-opportunities-transfers.md) §§1–2.
**ADR:** [ADR-0016](../decisions/ADR-0016-request-aggregate-and-subtypes.md) (new).

> **AMENDED 2026-08-01 (V-03) — PO-DEC-03 is RESOLVED; this design is no longer provisional.**
> **PO-DEC-03 was resolved on 2026-08-01 under the product owner's delegated decision authority**, recorded in [docs/fable/21-decision-resolution.md](../../fable/21-decision-resolution.md) and dispositioned in [remediation/internal-verification-corrections.md](../remediation/internal-verification-corrections.md) §0. The resolution adopts exactly the design specified here: **one Request aggregate with constrained subtype records and a linked but distinct Vacation lifecycle.**
> Consequently: the statement that "PO-DEC-03 remains `pending`" and the description of this design as "provisional" are **withdrawn** and replaced by this note; §8 is retained as **historical reversal analysis**, not as a live branch; and §9's traceability is updated. The package previously carried a contradiction — the resolution record said SPEC-08 "stops being provisional" while SPEC-08 still said it was — and this amendment resolves it in the direction the resolution record states.
> **What has *not* changed:** the design itself. No table, constraint, transition, or transaction below is altered by the resolution — only its status.

> **Product-owner direction, 2026-08-01 (resolved):** one Request aggregate with **constrained subtype records** and a **linked but distinct** Vacation lifecycle, per the resolution above.

> **What was wrong.** One `requests.status` covered five subtypes whose lifecycles genuinely differ, with subtype fields as nullable columns and no per-type constraint. `applied` meant different things per subtype. Vacation was modelled separately with none of the promised linkage. Deadlines, weekend/holiday rules, negative balances, open-mode approval, and concurrent last-unit allocation were undefined. And the architecture treated the pending default as settled.

---

## 1. Structure

> **AMENDED 2026-08-01 (V-27 / FD-9) — `vacation-selection` IS a subtype under D-18/D-19/D-20.**
> The previous text set `requests.subtype = 'vacation-selection'` in §5.1 while classifying `vacation_selections` as something other than a subtype table here — so D-18 was either violated by every vacation request or silently depended on `vacation_selections` doubling as a subtype table, which this section denied. §1.2 had no row for it (D-19 had nothing to check), §2 had no column (D-20 had no domain to reference), and **no rule stated what `requests.status` contained for a vacation request**. CAR-011's complaint was one overloaded status whose meaning varied by subtype; for the sixth subtype it had been replaced by *two* statuses with no defined relationship, which is worse. Resolved: it is a subtype, its row and column are added below, and **`requests.status` for vacation is derived from `vacation_selections.status`** by the stated mapping in §5.3. [Rationale](../remediation/internal-verification-corrections.md) §1 FD-9.

**One aggregate root, six constrained subtype tables** *(amended 2026-08-01, V-27 / FD-9 — `vacation_selections` is the sixth)*, of which vacation additionally carries its own quota and commitment lifecycle.

| Table | Role |
|---|---|
| `requests` | **Aggregate root.** Only fields common to *every* subtype |
| `request_availability` | ON request |
| `request_time_off` | OFF request |
| `request_no_call` | No-call |
| `request_shift_preference` | Shift preference |
| `request_shift_group_off` | Shift-group off |
| `vacation_selections` *(amended 2026-08-01, V-27 / FD-9)* | **A subtype table under D-18/D-19/D-20** (`subtype = 'vacation-selection'`), **and** the carrier of a distinct quota/commitment lifecycle (§5). Both statements are true: D-18 counts it as the request's one subtype row, and §5.3 defines how its own status and the root status stay in lockstep |

### 1.1 Root

`id`, `organization_id`, `group_id`, `membership_id`, **`subtype`**, `status`, `submitted_at?`, `decided_at?`, `decided_by?`, `withdrawn_at?`, `expires_at`, `idempotency_key`, `version`.

| Constraint | Rule |
|---|---|
| **D-7** *(retained)* | `UNIQUE (membership_id, idempotency_key)` |
| **D-18** *(new)* | **Exactly one subtype row per request** — each subtype table has `UNIQUE (request_id)` and a FK carrying `subtype`, with a `CHECK` that the discriminator matches. A request with zero or two subtype rows is impossible |
| **D-19** *(new)* | `CHECK` per subtype table: **every required field non-null and every prohibited field null** |
| **D-20** *(new)* | `CHECK (status = ANY(allowed_statuses_for(subtype)))` via a per-subtype status domain |

**No nullable subtype columns exist on the root.** That was the defect: a `shift-preference` row could reach `applied` with no shift type because the column was nullable for everyone.

### 1.2 Required and prohibited fields

| Subtype | Required | Prohibited |
|---|---|---|
| `availability` | `target_date` | `shift_group_id` |
| `time-off` | `target_date` **or** `(range_start, range_end)`; exactly one | `shift_type_id`, `shift_group_id` |
| `no-call` | `target_date` | `shift_type_id`, `shift_group_id`, `preference_strength` |
| `shift-preference` | `target_date`, **`shift_type_id`**, `preference_strength` | `shift_group_id` |
| `shift-group-off` | `target_date`, **`shift_group_id`** (whose `allow_request` is true) | `shift_type_id` |
| `vacation-selection` *(added 2026-08-01, V-27 / FD-9)* | **`vacation_period_id`**, **`week_start`** (the week reference, which must fall inside the period) | `shift_type_id`, `shift_group_id`, `preference_strength`, `target_date`, `range_start`, `range_end` |

---

## 2. Per-subtype transition matrices

**There is no universal status machine.** `✓` permitted, blank forbidden — enforced by a transition table checked in the domain **and** by D-20 plus a trigger.

> **AMENDED 2026-08-01 (V-27 / FD-9, V-31)** — three corrections ([rationale](../remediation/internal-verification-corrections.md) §1 FD-9 and §2):
> 1. **A `vacation-selection` column is added**, giving D-20 a status domain to reference. Its values are the *derived root* statuses of the mapping in §5.3, not `vacation_selections.status` itself.
> 2. **`accepted_as_input → withdrawn` is added for shift-preference.** A shift preference moves `submitted → accepted_as_input` immediately, because it is never approved — so under the previous matrix it became **unwithdrawable the moment it was accepted**. A non-binding preference must be retractable until a build consumes it, and it is forbidden after that only because the build already used it.
> 3. **`* → expired` is replaced by the enumerated legal source states.** A literal `*` as a database rule would have permitted `reflected_in_version → expired` — expiring a request already honoured in a published version.

| From → To | avail. | time-off | no-call | shift-pref | sg-off | vacation *(V-27)* |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `draft → submitted` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `submitted → under_review` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `submitted → accepted_as_input` | ✓ | | | **✓** | | |
| `under_review → approved` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `under_review → denied` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `submitted → withdrawn` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `under_review → withdrawn` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `approved → withdrawn` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| **`accepted_as_input → withdrawn`** *(added 2026-08-01, V-31)* | ✓ | | | **✓** | | |
| `approved → consumed_by_build` | ✓ | ✓ | ✓ | | ✓ | |
| `accepted_as_input → consumed_by_build` | | | | **✓** | | |
| `consumed_by_build → reflected_in_version` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| **`approved → reflected_in_version`** *(vacation only — commit to a version, §5.6)* | | | | | | ✓ |
| `consumed_by_build → unsatisfied` | | | | **✓** | | |
| **`reflected_in_version → reversed`** *(vacation only, §5.6)* | | | | | | ✓ |
| `→ expired`, **from `submitted`, `under_review`, or `accepted_as_input` only** *(amended 2026-08-01, V-31 — replaces the literal `*`)* | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `approved → superseded_by_revision` | ✓ | ✓ | ✓ | | ✓ | ✓ |

**`expired` has exactly three legal source states** *(added 2026-08-01, V-31)*: `submitted`, `under_review`, and `accepted_as_input` — the undecided states. `approved`, `consumed_by_build`, `reflected_in_version`, `unsatisfied`, `denied`, `withdrawn`, and `reversed` are **not** legal sources, and the transition table and its trigger enumerate them rather than matching a wildcard. Expiring a request that a published version already honours is the specific outcome this prevents.

**`reversed` is in the root status domain for the `vacation` column only** *(added 2026-08-01, V-27 / FD-9)*. D-20's per-subtype status domains make that legal: a status value may exist for one subtype and not for others, which is the whole point of per-subtype domains.

### 2.1 What the overloaded `applied` concealed

**`applied` is deleted.** It meant three different things:

| New status | Meaning |
|---|---|
| **`consumed_by_build`** | A solver run took this request as input. **Says nothing about the outcome** |
| **`reflected_in_version`** | A *published* version honours it. Carries `reflected_in_version_id` |
| **`unsatisfied`** | **Shift-preference only.** Consumed, not honoured. **A normal, reportable outcome — not a denial**, and conflating the two misrepresents a soft preference as a refusal |

**`accepted_as_input`** exists because a shift preference is **non-binding**: nobody approves or denies it. Forcing it through `under_review → approved` would have invented an approval that does not happen.

---

## 3. Deadlines and expiry

| Rule | Design |
|---|---|
| **Server-side only** | `expires_at` computed server-side from the group's `request_until_date` policy at submission. **A client-side deadline is not a deadline** |
| **Re-validated at every transition** | Not only at submission |
| **Expiry is a job** | A sweeper moves undecided past-deadline requests to `expired`, audited, requester notified |
| **Weekend and holiday policy** | Group configuration: `deadline_rolls ∈ {forward, backward, exact}` against a group **holiday calendar** (`group_holidays`, new). **Explicit, because "the deadline is Friday" is ambiguous when Friday is a holiday** |
| **Late submission** | Rejected with the effective deadline stated, **or** accepted into `submitted` with `is_late = true` where group policy permits — configured, never implicit |

---

## 4. Approval, denial, withdrawal, comments

| Operation | Rule |
|---|---|
| **Approve / deny** | Requires the approval capability; conditional update on `expected_version`; **first decision wins**, the second gets an explicit conflict — never a silent overwrite |
| **Withdraw** | **Requester-initiated only.** An administrator "withdrawing" for someone is a **denial with a reason**, recorded as such |
| **Withdrawal after `reflected_in_version`** | **Does not silently revert the schedule.** It raises a `ScheduleRevisionRequested` event; the scheduler decides. The request moves to `withdrawn` with `revision_requested = true` |
| **Comments** | Append-only; author recorded; **`SENSITIVE-PII`**; visible per capability |
| **Reversal** | A new `approvals` record. **The prior decision is never overwritten** |

**The review's scenario — *a time-off request withdrawn after being committed to a published version without triggering a revision* — now produces an explicit revision request instead of a silent divergence.**

---

## 5. Vacation — linked, distinct

**Vacation shares the request infrastructure (audit, comments, approvals, idempotency) but has its own entity and its own lifecycle**, because quota accounting and commitment to a schedule version are materially different from a day-off request.

### 5.1 Linkage

`vacation_selections.request_id` → `requests(id)`, with `requests.subtype = 'vacation-selection'`. **The link the previous design promised and did not have.** The root gives one audit trail, one comment surface, one approval mechanism, and one idempotency key; the selection carries quota and commitment.

*(amended 2026-08-01, V-27 / FD-9)* **This linkage makes `vacation_selections` a subtype table under D-18**, and it satisfies D-18's requirements exactly as the other five do:

| D-18/D-19/D-20 requirement | How `vacation_selections` satisfies it |
|---|---|
| `UNIQUE (request_id)` | Declared on `vacation_selections` |
| FK carrying `subtype`, with a `CHECK` that the discriminator matches | `CHECK (subtype = 'vacation-selection')` on the composite FK, identical in form to the other five |
| Exactly one subtype row per request | A vacation request has exactly one `vacation_selections` row and **no** row in any of the other five tables |
| D-19 required/prohibited fields | §1.2's `vacation-selection` row |
| D-20 per-subtype status domain | §2's `vacation` column, applied to **`requests.status`** |

### 5.2 Tables

| Table | Key fields |
|---|---|
| `vacation_periods` | `group_id`, `start_date` (Mon), `end_date` (Fri), `mode ∈ {quota, open}`, `state` |
| **`vacation_grants`** *(renamed from `vacation_quotas`)* | `period_id`, `kind ∈ {personal-entitlement, weekly-capacity}`, `membership_id?`, `week_start?`, **`units_total`**, **`units_consumed`**, **`override_units`** *(added 2026-08-01, V-28 — default `0`, `CHECK (override_units >= 0)`, written **only** by the audited override path of §5.5)*, `version` |
| `vacation_selections` | `request_id`, `membership_id`, `period_id`, `week_start`, `status`, `version` *(the selection's own optimistic-concurrency counter — added 2026-08-01, V-29)*, `grant_id?`, `committed_to_version_id?`, **`approval_idempotency_key`** *(added 2026-08-01, V-29)*, `commit_idempotency_key` |

### 5.3 Lifecycle, and the derived root status

`vacation_selections.status`: `available → pending → approved → committed`, with `denied`, `withdrawn`, and `expired` terminals, plus **`reversed`** (previously missing).

> **AMENDED 2026-08-01 (V-27 / FD-9)** — **`requests.status` for a vacation request is DERIVED from `vacation_selections.status`.** Previously two statuses existed with no stated relationship, so two rows could disagree about whether a vacation request had been withdrawn. One of them must be authoritative; `vacation_selections.status` is, because it is the one the quota and commitment transactions already write ([rationale](../remediation/internal-verification-corrections.md) §1 FD-9).

| `vacation_selections.status` (authoritative) | → derived `requests.status` |
|---|---|
| `available` | *no request row yet* — a selection becomes a request at submission |
| `pending` | `submitted` |
| `approved` | `approved` |
| `committed` | `reflected_in_version` |
| `denied` | `denied` |
| `withdrawn` | `withdrawn` |
| `expired` | `expired` |
| `reversed` | **`reversed`** † |

† **`reversed` is added to the root status domain for the vacation column only.** D-20's per-subtype domains make this legal, and §2's matrix carries it.

| Rule | Statement |
|---|---|
| **Synchronised in the same transaction** | Every write that changes `vacation_selections.status` writes the derived `requests.status` **in the same transaction**. There is no window in which they disagree, and no reconciliation job — a job implies a window |
| **One writer** | **Only the vacation module updates either status.** No other module writes `requests.status` for a `vacation-selection` row, and the vacation module never writes one without the other |
| **Enforced, not merely intended** | A trigger asserts the mapping on `requests` rows with `subtype = 'vacation-selection'`; a mismatch raises (**D-27**). R-15 tests it |
| **D-18 and D-20 both hold** | D-18 counts the one `vacation_selections` row; D-20 checks `requests.status` against §2's vacation column, which is exactly the right-hand side of the mapping above |
| **R-01 is now generatable for vacation** | The subtype has a declared status set, so the *(subtype × status × operation)* cross-product includes it |

### 5.4 Atomic last-unit allocation

**The review's scenario: two approvals both pass a pre-check for the last weekly slot.**

> **AMENDED 2026-08-01 (V-29, V-30, V-28)** — three defects in this transaction ([rationale](../remediation/internal-verification-corrections.md) §2):
> **V-29:** the selection update ran **unconditionally** — no `WHERE status='pending'`, no version check on the selection (the version checked was the *grant's*), and no idempotency key on the approval (`commit_idempotency_key` covers commit, not approval). A duplicate approval command, a retry after an ambiguous response, or an approval of an already-`withdrawn` selection consumed a **second quota unit** — a quota-accounting error inside the transaction whose purpose is correct quota accounting, and one that D-21, D-22 and D-23 each legitimately permit.
> **V-30:** in **open mode** there are no `vacation_grants` rows, so the unconditional grant update affected zero rows, which this section defined as `QUOTA_EXHAUSTED` / `VERSION_CONFLICT`. **Open-mode approval therefore always failed**, and test R-13 could not pass. The transaction now branches on `vacation_periods.mode`.
> **V-28:** D-21's upper bound is expressed against `units_total + override_units` so that it can be a real, unconditional `CHECK` and still permit the audited override path (§5.5).

```
APPROVE-VACATION (selection_id, approval_idempotency_key,
                  expected_selection_version, expected_grant_version?)
withUnitOfWork(ctx):
  -- 0. Idempotency, first, before any effect          [amended 2026-08-01, V-29]
  INSERT INTO vacation_approval_commands (selection_id, approval_idempotency_key, ...)
       ON CONFLICT (selection_id, approval_idempotency_key) DO NOTHING
  -- zero rows inserted => replay: return the recorded outcome, consume no unit,
  --                       emit no event, write no approval row.

  -- 1. Mode branch                                    [amended 2026-08-01, V-30]
  SELECT mode FROM vacation_periods WHERE id = :period_id
  -- A mid-period mode change is already prohibited by §5.5 while selections are
  --   pending or approved, so this branch cannot flip under a live approval.

  IF mode = 'quota':
      UPDATE vacation_grants
         SET units_consumed = units_consumed + 1, version = version + 1
       WHERE id = :grant_id
         AND version = :expected_grant_version
         AND units_consumed < units_total + override_units   -- D-21  [V-28]
      -- zero rows => QUOTA_EXHAUSTED or VERSION_CONFLICT. Nothing is approved.
      resolved_grant_id := :grant_id
  ELSE  -- mode = 'open'
      -- no vacation_grants row exists; the grant update is SKIPPED entirely
      resolved_grant_id := NULL                                       -- [V-30]
      -- the approval capability is still required and an approval row is still written

  -- 2. Selection update, now guarded                  [amended 2026-08-01, V-29]
  UPDATE vacation_selections
     SET status = 'approved', grant_id = resolved_grant_id, version = version + 1
   WHERE id = :selection_id
     AND status  = 'pending'
     AND version = :expected_selection_version
  -- zero rows => SELECTION_NOT_PENDING. The whole transaction ROLLS BACK, so a unit
  --   consumed at step 1 is released with it. No unit is ever consumed without an
  --   approval, and no approval ever consumes two.

  -- 3. Derived root status, same transaction          [§5.3, V-27 / FD-9]
  UPDATE requests SET status = 'approved' WHERE id = <the selection's request_id>

  INSERT approvals; INSERT audit_events; INSERT outbox_events
  UPDATE vacation_approval_commands SET outcome = 'approved'
COMMIT
```

| # | Invariant | Mechanism |
|---|---|---|
| **D-21** *(amended 2026-08-01, V-28)* | **`units_consumed >= 0`** unconditionally, **and `units_consumed <= units_total + override_units`** | Two real `CHECK` constraints — `CHECK (units_consumed >= 0)` and `CHECK (units_consumed <= units_total + override_units)` — plus the conditional predicate above. Both are unconditional table constraints, because a `CHECK` cannot be relaxed per-caller; the override path raises the **bound**, not the enforcement |
| **D-22** | One selection per `(membership, period, week)` | `UNIQUE` |
| **D-23** | Commit is idempotent | `UNIQUE (selection_id, committed_to_version_id)` |
| **D-26** *(new, 2026-08-01, V-29)* | **Approval is idempotent** | `UNIQUE (selection_id, approval_idempotency_key)` on `vacation_approval_commands`. Distinct from D-23, which covers *commit*, and numbered D-26 because D-25 is already the audit-chain invariant in [06](../06-data-architecture.md) §4 |
| **D-27** *(new, 2026-08-01, V-27 / FD-9)* | **`requests.status` matches the §5.3 mapping** for every `subtype = 'vacation-selection'` row | Trigger; a mismatch raises |

**Exactly one of two racing approvals succeeds. The loser receives `QUOTA_EXHAUSTED`, not a silent overwrite.** *(added 2026-08-01, V-29)* And a **duplicate** approval — a retry, a double click, an at-least-once delivery — consumes nothing: it is stopped at step 0 by D-26, or at step 2 by `SELECTION_NOT_PENDING`.

### 5.5 Over-quota, negative balance, open mode

> **AMENDED 2026-08-01 (V-28)** — the previous text said D-21's upper bound was a `CHECK` **and** that it was "relaxed only on the override path." Those cannot both be true: a table `CHECK` is unconditional and cannot be relaxed per-transaction or per-caller, and `is_override` lives on `vacation_selections`, not on `vacation_grants`, so no `CHECK` on the grant row could even see it. R-07 and the `CHECK` could not both pass. **Resolved by raising the bound instead of relaxing the constraint:** `vacation_grants.override_units` (default `0`) is written only by the audited override path, and the bound is `units_consumed <= units_total + override_units` ([rationale](../remediation/internal-verification-corrections.md) §2).

| Situation | Behaviour |
|---|---|
| **Approval beyond `units_total`** *(amended 2026-08-01, V-28)* | **Requires an explicit override capability and a mandatory reason.** In the **same transaction** the override path (a) increments **`vacation_grants.override_units`** by the units being authorised and (b) records the approval with `is_override = true` and the reason on `vacation_selections`. `units_consumed` may then exceed `units_total` **while still satisfying the unconditional `CHECK (units_consumed <= units_total + override_units)`** — the invariant is never suspended, the *bound* is raised, and **every relaxation is a visible, audited row** on the grant itself. The variance indicator warns. **The observed product's advisory-not-blocking behaviour is preserved — but it is now an audited, deliberate act rather than an unnoticed one** |
| **Negative balance** | **Prohibited.** `CHECK (units_consumed >= 0)` is unconditional and applies on every path including override and reversal *(clarified 2026-08-01, V-28)*; a reversal that would go below zero is rejected as a data error |
| **Reversing an override** *(added 2026-08-01, V-28)* | Decrements `units_consumed` **and** `override_units` together, so the bound returns to its pre-override value and an override cannot silently persist as headroom for a later approval |
| **Open mode** *(amended 2026-08-01, V-30)* | No `vacation_grants` rows; approval is unconstrained by quota but still requires the capability and still records an approval. **`APPROVE-VACATION` skips the grant update entirely and leaves `grant_id` null** (§5.4 mode branch) — the previous specification's unconditional grant update made open-mode approval always fail |
| **Mode change mid-period** | Prohibited while selections exist in `pending` or `approved`. *(added 2026-08-01, V-30)* This is what makes §5.4's mode branch safe: the mode cannot flip underneath a live approval |

### 5.6 Commit and reversal

**Commit** targets a **draft** version ([SPEC-05](SPEC-05-schedule-version-identity-and-publication.md)), creating OFF assignment snapshots, marking selections `committed` with `committed_to_version_id`, in one transaction, idempotent by D-23.

**Reversal** (`committed → reversed`) requires the override capability and a reason; it decrements `units_consumed`, marks the selection `reversed`, and **raises a revision request against the schedule rather than editing a published version.** *(Reversal did not exist before — the observed product's one-way transfer had no undo, and neither did the previous design.)*

---

## 6. Solver projection

The solver reads a **projection**, never the raw tables, so a status whose meaning is subtype-dependent cannot leak into the model:

> **AMENDED 2026-08-01 (V-31)** — **`reflected_in_version` appeared in neither the include list nor the exclude list**, so on a rebuild of the same period a time-off request already honoured in a published version had undefined projection membership. If excluded, the rebuild could schedule the person on their approved day off, and §6 is the only gate — neither the domain nor the database would object. **It is included** ([rationale](../remediation/internal-verification-corrections.md) §2).

| Projection row | Built from |
|---|---|
| `HardOff(membership, date)` | `time-off` and `no-call` in `approved`, `consumed_by_build`, **or `reflected_in_version`** *(amended 2026-08-01, V-31)*; committed vacation |
| `HardOn(membership, date)` | `availability` in `approved` **or `reflected_in_version`** *(amended 2026-08-01, V-31)*, where group policy makes it binding |
| `SoftPreference(membership, date, shift_type, strength)` | `shift-preference` in `accepted_as_input` **or `reflected_in_version`** *(amended 2026-08-01, V-31)* |
| `ShiftGroupOff(membership, date, shift_group)` | `shift-group-off` in `approved` **or `reflected_in_version`** *(amended 2026-08-01, V-31)* |

**`reflected_in_version` enters the projection** *(added 2026-08-01, V-31)*. A rebuild of a period must honour what the published version already promised the person; excluding it would let a rebuild schedule someone on an approved day off with nothing in the system objecting.

**A request in `draft`, `submitted`, `denied`, `withdrawn`, `expired`, `unsatisfied`, or `reversed` never enters the projection** *(amended 2026-08-01, V-31 — the list is now exhaustive against §2's status set, so no status is undefined in either direction)*. The projection is part of the pinned `solver_inputs` snapshot.

---

## 7. Test contract

**Extends SBX-010, SBX-011, SBX-012, SBX-013.**

| # | Test | Required outcome |
|---|---|---|
| R-01 | Every (subtype × status × operation) combination | Illegal ones **rejected by both domain and database** |
| R-02 | `shift-preference` with no `shift_type_id` | **Rejected by D-19** — the review's named failure |
| R-03 | `shift-preference` reaching `approved` | **Rejected by D-20** — it has no such transition |
| R-04 | Two subtype rows for one request | **Rejected by D-18** |
| R-05 | Two approvals racing the last quota unit | **Exactly one succeeds** (D-21) |
| R-06 | Over-quota approval without the override capability | Denied |
| R-07 | Over-quota **with** capability and reason | Approved, audited, `is_override` set |
| R-08 | Reversal that would go negative | Rejected |
| R-09 | Deadline boundary; holiday roll forward/backward/exact | Correct in each configuration |
| R-10 | Withdrawal **after** `reflected_in_version` | **Revision requested; published version unchanged** |
| R-11 | Duplicate submission, same idempotency key | One row |
| R-12 | Commit replayed for the same `(selection, version)` | One commit (D-23) |
| R-13 | Open vs quota mode | Both complete; quota rules apply only in quota mode. *(amended 2026-08-01, V-30)* Open-mode approval succeeds with **no** `vacation_grants` row and leaves `grant_id` null |
| R-14 | Solver projection over mixed statuses, **including `reflected_in_version` on a rebuild of the same period** *(amended 2026-08-01, V-31)* | Only eligible rows appear, **and a time-off request already honoured in a published version is still `HardOff` on the rebuild** — the rebuild cannot schedule the person on their approved day off |
| R-15 | Every vacation status transition, checking `requests.status` against `vacation_selections.status` *(added 2026-08-01, V-27 / FD-9)* | **The §5.3 mapping holds after every transition**, in the same transaction; a deliberately desynchronised write **raises (D-27)** |
| R-16 | A vacation request's subtype rows *(added 2026-08-01, V-27 / FD-9)* | Exactly one `vacation_selections` row, zero rows in the other five tables. **D-18 satisfied.** D-19 rejects a vacation row missing `vacation_period_id` or `week_start`, or carrying `shift_type_id` |
| R-17 | Duplicate `APPROVE-VACATION` with the same `approval_idempotency_key` *(added 2026-08-01, V-29)* | Second call returns the recorded outcome. **Exactly one unit consumed**, one approval row, one event |
| R-18 | `APPROVE-VACATION` against a selection already `approved`, `withdrawn`, or `denied`, with a fresh idempotency key *(added 2026-08-01, V-29)* | **`SELECTION_NOT_PENDING`**; transaction rolls back; **no unit consumed**; status unchanged |
| R-19 | `APPROVE-VACATION` with a stale `expected_selection_version` *(added 2026-08-01, V-29)* | `SELECTION_NOT_PENDING`; nothing written |
| R-20 | Over-quota override, then reversal *(added 2026-08-01, V-28)* | Override increments `override_units` and the `CHECK (units_consumed <= units_total + override_units)` holds throughout; reversal decrements **both**, so no silent headroom remains |
| R-21 | Direct `UPDATE` driving `units_consumed` below zero or above `units_total + override_units` *(added 2026-08-01, V-28)* | **Rejected by the unconditional `CHECK`s**, on every path including override |
| R-22 | Shift-preference withdrawn while `accepted_as_input`, and again after `consumed_by_build` *(added 2026-08-01, V-31)* | Withdrawal **succeeds** before consumption, **is rejected** after it |
| R-23 | Attempt `reflected_in_version → expired` and `approved → expired` *(added 2026-08-01, V-31)* | **Rejected.** `expired` accepts only `submitted`, `under_review`, `accepted_as_input` |

---

## 8. Reversal analysis (historical) *(retitled 2026-08-01, V-03)*

> **AMENDED 2026-08-01 (V-03)** — this section was written as a live branch for a pending decision. **PO-DEC-03 is resolved** (see the header), so it is **no longer a branch**. It is retained as **historical reversal analysis**: what it would cost to change course, which is useful information about reversibility and is deliberately not deleted. **Nothing below is a live alternative, and no implementation decision should be conditioned on it.**

| Alternative *(not adopted; PO-DEC-03 resolved in favour of the design above)* | Impact if ever revisited |
|---|---|
| **Separate aggregates per subtype** | The five subtype tables become five roots; withdrawal, deadline, approval, audit, comment, and idempotency logic is duplicated per type; cross-type reporting becomes a union. **The transition matrices in §2 survive unchanged** — they are the valuable part and are portable |
| **Fully generic single table** | **Rejected, and remains rejected**: it is the design CAR-011 identified as unsafe, and the resolution of PO-DEC-03 does not reopen it |

**Migration cost if the design were changed after implementation begins: high.** That cost is why the decision was surfaced for an explicit resolution rather than assumed — and it is now resolved rather than assumed.

---

## 9. Traceability

**Capabilities:** CAP-021, CAP-022, CAP-023.
**Decisions:** **PO-DEC-03 — `RESOLVED` 2026-08-01 under delegated authority** ([resolution record](../../fable/21-decision-resolution.md); [disposition](../remediation/internal-verification-corrections.md) §0 V-03). This design is **no longer provisional** *(amended 2026-08-01, V-03)*. PO-DEC-14 (pending).
**ADR:** **[ADR-0016](../decisions/ADR-0016-request-aggregate-and-subtypes.md) (new)**.
**Gates:** `G-ARCH`, `G-BETA`, `G-PROD`. **None passed.**
