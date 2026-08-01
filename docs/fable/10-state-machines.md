# 10 — State Machines

**The lifecycle inventory SchedulePoint implements.** I reviewed all 21 research lifecycles (report 15, STM-001..021) against the remediated architecture and **adopt them as remediated** — the architecture's SPECs superseded several research machines with stronger versions, and this document records exactly which machine is authoritative for each lifecycle. Universal rules (ratified from report 15, now binding on implementation): every transition is server-enforced with actor + precondition + guard; membership-scoped authorization; mandatory audit; idempotent under retry (command id); invalid transitions rejected with typed errors; fail-closed.

| # | Lifecycle | Authoritative definition | Supersedes / notes | Confidence basis |
|---|---|---|---|---|
| 1 | **Schedule build** | Report 21 §16-state lifecycle + SPEC-04 | Supersedes STM-001..003 (draft/build/review). Distinguishes `infeasible` (proven, explained) from `failed` (engine error); cancellation layered: deadline → callback → process kill | D — no build ever observed; ours |
| 2 | **Schedule version / publication** | SPEC-05 (incl. durable `publishing`, `superseded`, revert-forward; V-01..16 proofs) | Supersedes STM-004/005. `lock_state` on versions | D + Confirmed publish surface |
| 3 | **Assignment snapshot pinning** | SPEC-05 (`is_pinned`) | One lock concept replaces the observed lock/fix ambiguity | C (pins observed) |
| 4 | **ON / OFF / No-Call request** | SPEC-08 per-subtype status domains (D-20) | Supersedes STM-006/007. Terminal facts split: consumed_by_build / reflected_in_version / unsatisfied; withdrawal-after-reflection → revision request | C structure / I transitions |
| 5 | **Shift preference** | SPEC-08 (`accepted_as_input`) | New — the research had no honest state for "never approved, still used" | D |
| 6 | **Vacation selection & approval** | SPEC-08 (quota/grant + open modes; D-21 last-unit race; audited over-quota override) | Supersedes STM-008 | C |
| 7 | **Vacation commit** | SPEC-08 (`committed` → reversible via `reversed` + forward revision) | Supersedes STM-009's one-way commit; graduated confirmation kept | C (commit) / D (reverse) |
| 8 | **Opportunity** | SPEC-13 (posted → claimed(atomic, version-bound) → transferred; `STALE_ASSIGNMENT` on republication race) | Supersedes STM-010 | C posting / I acceptance |
| 9 | **Swap / transfer** | SPEC-13 (proposed → counterpart-accepted → [review] → executed-as-new-version) | Supersedes STM-011 (was Low confidence) | D — source lifecycle unknown |
| 10 | **Picklist (list-level)** | SPEC-02 (setup → locked → active ⇄ paused → completed → [reopened-for-correction]) | Supersedes STM-012 | D |
| 11 | **Picklist turn** | SPEC-02 (`open` → `resolved` \| `expired` \| `skipped`; D-3a/c; one authoritative transaction) | Supersedes STM-013/014 — **the CAR-003 redesign; the single most safety-critical machine in the product** | D |
| 12 | **Selection command** | SPEC-02 (received → accepted \| rejected(typed reason); idempotent by command id, D-11) | New | D |
| 13 | **Coordinator lease** | SPEC-02 (acquired → renewed → expired/fenced; monotonic fencing tokens, D-13) | New | D |
| 14 | **Notification intent → logical delivery → attempt** | SPEC-07 (incl. `ambiguous`, `unresolved`, `no-destination` as first-class; retry only where provider idempotency declared) | Supersedes STM-015/016 | D — source had no observable delivery state |
| 15 | **Escalation ladder** | SPEC-07 (step dispatch via conditional claim; halted by durable acknowledgement; residual ms window documented) | Supersedes STM-017 | D |
| 16 | **User account** | invited → active → deactivated → archived; login-email change (CAR-027) invalidates sessions | STM-018 refined | C states / D transitions |
| 17 | **Membership** | active ⇄ suspended → archived; role changes bump context_version | STM-019 refined | C |
| 18 | **Proxy grant** | offered → accepted → active → revoked/expired (PO-DEC-19) | STM-020 | C config / D execution |
| 19 | **Document** | uploaded → available → retired-by-policy | STM-021 | C |
| 20 | **Calendar feed token** | issued → active → rotated/revoked (immediate) | Research had none as a machine; SPEC-09 defines it | D |
| 21 | **Report run** | requested(authz₁) → snapshot-bound → executing(authz₂) → artifact \| `cancelled_unauthorized`(no artifact) → download(authz₃ per fetch) | New (CAR-012) | D |
| 22 | **Build ↔ requests interaction** | Solver reads a projection, never raw request statuses (SPEC-08) | Cross-machine rule | D |
| 23 | **Entitlement window** | granted → active → expiring → expired (module unavailable, data retained) | New (PO-DEC-04) | D |
| 24 | **Quarantine record** | captured(metadata only) → reviewed → vocabulary-extended \| dismissed | New (SPEC-03) | D |
| 25 | **Audit chain segment** | open → checkpointed(signed) → replicated(A2) | New (SPEC-11) | D |

**Honesty rule carried forward:** the D-basis machines above are *designs*, and each one's proving test is named before its milestone exits — SPEC-02 P-01..15 (machines 10–13), SPEC-05 V-01..16 (2–3), SPEC-08 R-01..14 (4–7), SPEC-13 M-01..12 (8–9), SPEC-07 N-01..15 (14–15), SPEC-09 F-01..14 (20–21), SPEC-11 X-01..07 (25). The two research machines that were blocked on C-02/C-04 are unblocked by the approved decisions and superseded as noted. **No machine invents a source fact:** where the source was unobservable, the machine is labelled ours and tested as ours.
