# 09 — Domain Model

**The entity model SchedulePoint is built on.** I independently reviewed the conceptual model (report 14, 44 entities) and the remediated data architecture (doc 06 + SPECs), checked them against each other and against the mandate's Stage-6 entity checklist, and **adopt the remediated architecture model as authoritative**, with report 14 as its conceptual ancestor. This document records the model's shape, its load-bearing structural decisions, and the audit deltas — it does not restate every column (doc 06 §3 holds field-level detail).

**Universal properties (every tenant entity):** owned by exactly one organization; RLS policy created in the same migration as the table (CI-enforced pairing); reachable only through the SPEC-01 unit-of-work; soft-deleted/archived rather than destroyed where referenced; audited on every mutation (I-06); no patient-level entity exists anywhere (I-07) — deliberate, carried as an architectural requirement.

---

## 1. The model by area

**Tenancy & identity** — `organizations` · `organization_settings` · `groups` · `group_holidays` · `users` (immutable id; `login_email` admin-changeable, CAR-027) · `user_identities` (IdP links, proof-of-control) · `memberships` (role lives here; kinds staff/locum; suspension states) · `capability_grants` (effective-dated, non-overlapping by exclusion constraint) · `entitlements` (first-class, PO-DEC-04) · `proxy_grants` · `sessions`. Site is `locations.site_label` **attribute** pending PO-DEC-01 — both migration directions pre-modelled (06 §3.2a); no `sites` table exists.

**Scheduling structure** — `locations` · `shift_types` (four orthogonal flags) · `shift_groups` (scoring mode, weight, `allow_request`) · `staff_groups` · valid-group combinations · `membership_work_profiles` + `membership_weekday_fte` (canonical effective-dated FTE/max-assignment data, CAR-006) · `qualifications` + membership qualification records (evidence ref, expiry).

**Rules & builds** — `rules` (typed versioned AST rows, closed node set; hard/soft in a CHECK) · rule-set versions · `builds` (16-state lifecycle; reproducibility fields: seed, image digest, params, worker count, compiler version) · build results/explanations (bounded tiers).

**Schedule & publication (SPEC-05 — the CAR-007 redesign)** — `schedule_periods` · `schedule_versions` (state machine incl. durable `publishing`; `lock_state`; `is_current` partial-unique D-16) · **`assignment_identities`** (the durable thing an assignment *is*) · **`assignment_snapshots`** (what it *says* in one version; `is_pinned`; exclusion constraint includes `version_id` — D-1a; cross-version real-world non-overlap on current published — D-1b) · `credits` (separate from assignments — the observed split, preserved) · publication idempotency records (D-17). Published-version immutability enforced by triggers (D-15a–d, I-18).

**Requests & vacation (SPEC-08)** — `requests` (aggregate root) · five subtype tables (exactly-one enforced, D-18; per-subtype status domains, D-19/20) · `approvals` · `vacation_grants` (entitlement/capacity kinds) · vacation selections · D-21 conditional last-unit allocation.

**Marketplace (SPEC-13)** — `opportunities` (bound to `assignment_identity_id` + source version + snapshot — D-24) · acceptances · swaps/transfers with counterpart + optional review.

**Picklist (SPEC-02 — the CAR-003 redesign)** — `picklists` (aggregate row, version, fencing) · `picklist_participants` · **`picklist_turns`** (D-3c one open per list) · **`selections`** (D-3a one accepted per turn; D-3b one claimant per item; `picked_by` + `acted_by` + `actor_role`) · **`picklist_commands`** (D-11 idempotency) · **`picklist_events`** (D-12 gapless sequence, append-only) · coordinator leases (D-13, fencing tokens) · `picklist_work_items` (**no free-text title/description** — vocabulary refs only, CAR-004) · controlled-vocabulary tables · `quarantined_records` (paths/codes/counts/value-class — never values, never hashes).

**Notifications (SPEC-07 — the CAR-010 redesign)** — `notification_intents` · `logical_deliveries` (stable provider idempotency key) · `delivery_attempts` (outcomes incl. `ambiguous`/`unresolved`) · `provider_callbacks` (unique `provider_event_id`, replay-safe) · acknowledgements (durable) · escalation policies/steps · `push_registrations` (envelope-encrypted endpoint+`p256dh`+`auth`; lookup hash separate — CAR-009) · `broadcast_recipients` · notification-class matrix.

**Reports, documents, calendar (SPEC-09)** — `report_runs` (snapshot manifest + hash + `policy_version`) · `report_shares` (membership-targeted, re-evaluated at download) · report artifacts (object store, regenerable) · `calendar_feed_tokens` (hashed, revocable, rotatable) · `documents` + categories (retention policy per org) · `calendar_events`.

**Audit & platform (SPEC-11)** — `audit_events` (append-only; actor, on-behalf-of, before/after, mechanism, correlation id; **hash chain columns**) · `audit_checkpoints` (signed; D-25) · outbox · jobs (durable leases) · `connectors` (credentials referenced in secret store, never stored).

## 2. The structural decisions that carry the design (ratified)

1. **Role on membership, not user** — the research's key finding, modelled directly.
2. **Identity/snapshot split for assignments** — the only shape that makes immutable version cloning safe (CAR-007); "an assignment" was never one thing.
3. **Assignment ≠ credit** — two entities; the observed independent-movement behaviour depends on it.
4. **One request aggregate + constrained subtypes** — honest terminal facts (`consumed_by_build` / `reflected_in_version` / `unsatisfied`); provisional under PO-DEC-03 with the migration cost of deciding otherwise documented (SPEC-08 §8).
5. **Turn as a first-class row** — D-3a is expressible only if turns are entities; the constraint *is* the concurrency design.
6. **Notification as four concepts** — the dedup key lives on `logical_deliveries`, which is what makes retry-after-ambiguity safe to reason about.
7. **Business invariants as database constraints** — exclusion constraints, partial unique indexes, triggers, CHECKs (D-1..D-25): races are decided by the database, not by application discipline.
8. **No patient-level entity, anywhere** — with the ingestion vocabulary as the provable substitute.

## 3. Audit deltas (my review)

| # | Delta | Disposition |
|---|---|---|
| Δ-1 | Report 14's ENT numbering vs. doc 06 table names have no maintained crosswalk; report 22 traces capabilities→entities but not ENT→table | Low priority. Report 14 is conceptual ancestry, not a live authority; the traceability matrix + doc 06 suffice. **No action** — recording the decision so nobody builds the crosswalk out of tidiness |
| Δ-2 | `group_holidays` (SPEC-08 deadline-rolling) needs an owner for its admin surface | Assigned: W-61 group settings (M2) |
| Δ-3 | Mandate checklist cross-check: all Stage-6 entities present. Nearest-match naming: shift requirement → build demand inputs; pick option/room → `picklist_work_items`; vacation block/quota/grant → `vacation_grants` kinds + selections; report definition → report classes (code) + `report_runs` (data) | Confirmed complete; no missing entity |
| Δ-4 | Retention: audit 7y+legal-hold defined; documents per-org policy defined; **notification attempts and picklist events lack stated retention** | Add to M7/M10 exit criteria: partitioning + retention policy stated (doc 06 §5 extension) |
| Δ-5 | `organization_settings` vs `groups` settings split needs a one-page placement rule so settings don't accrete arbitrarily | Runbook rule: new setting PRs must state scope rationale; reviewed at milestone review |

## 4. Lifecycle/versioning/soft-deletion summary

| Concern | Rule |
|---|---|
| Versioned | schedule versions (immutable), rule sets, entitlement windows, grants (effective-dated), work profiles/FTE (effective-dated), report snapshots |
| Append-only | audit_events, picklist_events, delivery attempts, provider callbacks, outbox history |
| Soft-delete/archive | users (deactivate), memberships (suspend/archive), catalogue rows (archive), documents (policy), vocabulary entries (retire) |
| Hard-delete permitted | nothing tenant-scoped; personal-data requests are satisfied by **anonymisation-not-deletion** so the audit chain survives (SPEC-11) |
| Sensitive classes | contact PII (minimised, role-gated), push delivery material (envelope-encrypted), calendar tokens (hashed), quarantine metadata (no values), **patient data: none by construction** |
