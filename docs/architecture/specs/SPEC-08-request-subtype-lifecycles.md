# SPEC-08 — Request Aggregate, Subtype Constraints, and Vacation Lifecycle

**Status: `PROPOSED`.** Remediates **CAR-011** (High).
**Supersedes:** [06](../06-data-architecture.md) §3.4 `requests` and `vacation_selections`; [09](../09-requests-vacation-opportunities-transfers.md) §§1–2.
**ADR:** [ADR-0016](../decisions/ADR-0016-request-aggregate-and-subtypes.md) (new).

> **Product-owner direction, 2026-08-01:** one Request aggregate with **constrained subtype records** and a **linked but distinct** Vacation lifecycle. **PO-DEC-03 remains `pending`.** This design is therefore explicitly **provisional**: it implements the pending working default, says so, and defines what changes if the decision goes the other way (§8).

> **What was wrong.** One `requests.status` covered five subtypes whose lifecycles genuinely differ, with subtype fields as nullable columns and no per-type constraint. `applied` meant different things per subtype. Vacation was modelled separately with none of the promised linkage. Deadlines, weekend/holiday rules, negative balances, open-mode approval, and concurrent last-unit allocation were undefined. And the architecture treated the pending default as settled.

---

## 1. Structure

**One aggregate root, five constrained subtype tables, one linked vacation domain.**

| Table | Role |
|---|---|
| `requests` | **Aggregate root.** Only fields common to *every* subtype |
| `request_availability` | ON request |
| `request_time_off` | OFF request |
| `request_no_call` | No-call |
| `request_shift_preference` | Shift preference |
| `request_shift_group_off` | Shift-group off |
| `vacation_selections` | **Linked, distinct lifecycle** (§5) |

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

---

## 2. Per-subtype transition matrices

**There is no universal status machine.** `✓` permitted, blank forbidden — enforced by a transition table checked in the domain **and** by D-20 plus a trigger.

| From → To | avail. | time-off | no-call | shift-pref | sg-off |
|---|:--:|:--:|:--:|:--:|:--:|
| `draft → submitted` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `submitted → under_review` | ✓ | ✓ | ✓ | | ✓ |
| `submitted → accepted_as_input` | ✓ | | | **✓** | |
| `under_review → approved` | ✓ | ✓ | ✓ | | ✓ |
| `under_review → denied` | ✓ | ✓ | ✓ | | ✓ |
| `submitted → withdrawn` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `under_review → withdrawn` | ✓ | ✓ | ✓ | | ✓ |
| `approved → withdrawn` | ✓ | ✓ | ✓ | | ✓ |
| `approved → consumed_by_build` | ✓ | ✓ | ✓ | | ✓ |
| `accepted_as_input → consumed_by_build` | | | | **✓** | |
| `consumed_by_build → reflected_in_version` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `consumed_by_build → unsatisfied` | | | | **✓** | |
| `* → expired` (deadline passed, undecided) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `approved → superseded_by_revision` | ✓ | ✓ | ✓ | | ✓ |

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

### 5.2 Tables

| Table | Key fields |
|---|---|
| `vacation_periods` | `group_id`, `start_date` (Mon), `end_date` (Fri), `mode ∈ {quota, open}`, `state` |
| **`vacation_grants`** *(renamed from `vacation_quotas`)* | `period_id`, `kind ∈ {personal-entitlement, weekly-capacity}`, `membership_id?`, `week_start?`, **`units_total`**, **`units_consumed`**, `version` |
| `vacation_selections` | `request_id`, `membership_id`, `period_id`, `week_start`, `status`, `grant_id?`, `committed_to_version_id?`, `commit_idempotency_key` |

### 5.3 Lifecycle

`available → pending → approved → committed`, with `denied`, `withdrawn`, and `expired` terminals, plus **`reversed`** (previously missing).

### 5.4 Atomic last-unit allocation

**The review's scenario: two approvals both pass a pre-check for the last weekly slot.**

```
APPROVE-VACATION (selection_id, expected_grant_version)
withUnitOfWork(ctx):
  UPDATE vacation_grants
     SET units_consumed = units_consumed + 1, version = version + 1
   WHERE id = :grant_id
     AND version = :expected_grant_version
     AND units_consumed < units_total          -- D-21: the predicate IS the allocation
  -- zero rows => QUOTA_EXHAUSTED or VERSION_CONFLICT. Nothing is approved.
  UPDATE vacation_selections SET status='approved', grant_id=:grant_id
  INSERT approvals; INSERT audit_events; INSERT outbox_events
COMMIT
```

| # | Invariant | Mechanism |
|---|---|---|
| **D-21** | **`0 <= units_consumed <= units_total`** | `CHECK`, plus the conditional predicate above |
| **D-22** | One selection per `(membership, period, week)` | `UNIQUE` |
| **D-23** | Commit is idempotent | `UNIQUE (selection_id, committed_to_version_id)` |

**Exactly one of two racing approvals succeeds. The loser receives `QUOTA_EXHAUSTED`, not a silent overwrite.**

### 5.5 Over-quota, negative balance, open mode

| Situation | Behaviour |
|---|---|
| **Approval beyond `units_total`** | **Requires an explicit override capability and a mandatory reason.** `units_consumed` may then exceed `units_total`; `D-21`'s upper bound is relaxed **only** on the override path, which records `is_override = true`. The variance indicator warns. **The observed product's advisory-not-blocking behaviour is preserved — but it is now an audited, deliberate act rather than an unnoticed one** |
| **Negative balance** | **Prohibited.** `units_consumed` never goes below zero; a reversal that would do so is rejected as a data error |
| **Open mode** | No `vacation_grants` rows; approval is unconstrained by quota but still requires the capability and still records an approval |
| **Mode change mid-period** | Prohibited while selections exist in `pending` or `approved` |

### 5.6 Commit and reversal

**Commit** targets a **draft** version ([SPEC-05](SPEC-05-schedule-version-identity-and-publication.md)), creating OFF assignment snapshots, marking selections `committed` with `committed_to_version_id`, in one transaction, idempotent by D-23.

**Reversal** (`committed → reversed`) requires the override capability and a reason; it decrements `units_consumed`, marks the selection `reversed`, and **raises a revision request against the schedule rather than editing a published version.** *(Reversal did not exist before — the observed product's one-way transfer had no undo, and neither did the previous design.)*

---

## 6. Solver projection

The solver reads a **projection**, never the raw tables, so a status whose meaning is subtype-dependent cannot leak into the model:

| Projection row | Built from |
|---|---|
| `HardOff(membership, date)` | `time-off` and `no-call` in `approved` / `consumed_by_build`; committed vacation |
| `HardOn(membership, date)` | `availability` in `approved`, where group policy makes it binding |
| `SoftPreference(membership, date, shift_type, strength)` | `shift-preference` in `accepted_as_input` |
| `ShiftGroupOff(membership, date, shift_group)` | `shift-group-off` in `approved` |

**A request in `draft`, `submitted`, `denied`, `withdrawn`, or `expired` never enters the projection.** The projection is part of the pinned `solver_inputs` snapshot.

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
| R-13 | Open vs quota mode | Both complete; quota rules apply only in quota mode |
| R-14 | Solver projection over mixed statuses | Only eligible rows appear |

---

## 8. If PO-DEC-03 is decided differently

**Recorded so the provisional status is real rather than decorative.**

| Alternative | Impact |
|---|---|
| **Separate aggregates per subtype** | The five subtype tables become five roots; withdrawal, deadline, approval, audit, comment, and idempotency logic is duplicated per type; cross-type reporting becomes a union. **The transition matrices in §2 survive unchanged** — they are the valuable part and are portable |
| **Fully generic single table** | **Rejected in advance**: it is the design CAR-011 identified as unsafe, and no owner decision should be interpreted as a request to reinstate it |

**Migration cost if the decision changes after implementation begins: high.** This is exactly why the decision is flagged rather than assumed settled.

---

## 9. Traceability

**Capabilities:** CAP-021, CAP-022, CAP-023.
**Decisions:** **PO-DEC-03 (pending — this design is provisional)**, PO-DEC-14 (pending).
**ADR:** **[ADR-0016](../decisions/ADR-0016-request-aggregate-and-subtypes.md) (new)**.
**Gates:** `G-ARCH`, `G-BETA`, `G-PROD`. **None passed.**
