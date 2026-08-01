# 13 — Picklist Plan

**The picklist is a separate real-time system and the least-evidenced, highest-concurrency part of the product — planned accordingly.** Normative design: SPEC-02 (turn transaction + fencing), SPEC-03 (work-item ingestion), doc 10, ADR-0008/0023, PO-DEC-18 (approved). Evidence posture: **live execution was never observed at the source; everything here is SchedulePoint's own design and is treated as unproven until its harness passes.**

---

## 1. Delivery strategy

Sequenced late deliberately (M9–M10, beta stage), for the researched reasons: severest concurrency requirements, least evidence, and blocked historically by C-02/C-04 — both now resolved by approved decisions. **Preconditions wired into the roadmap:** the LIVE-SIM environment (controllable virtual clock, barrier-released N-client orchestration, scriptable turn advancement — clock injection compiled out of production images) is built in M9 *before* execution code in M10; the notification platform (M7) precedes it because the escalation ladder is load-bearing for unattended turns; SPEC-02's P-01..P-15 run continuously from the first execution commit.

| Phase | Content | Milestone |
|---|---|---|
| P-A Preparation | Picklists, participants, work items (vocabulary-constrained), pick order derived from Master Schedule (not editable — Confirmed behaviour preserved), lock, comments, three operating modes (paper / manual-entry / integrated — CAP-060) | M9 |
| P-B LIVE-SIM | Deterministic concurrency harness + fixtures | M9 |
| P-C Execution core | Turn machine, selection transaction, timers, pause/resume/skip, completion → daily assignments | M10 |
| P-D Real-time | Coordinator, event relay, reconnect/resync, monitor dashboard | M10 |
| P-E Escalation & proxy | Ladder integration, proxy turns, acknowledgements | M10 |
| P-F Correction & audit | Post-completion correction (separate audited op), admin intervention surfaces | M10 |
| Connectors (integrated mode at scale) | Per-vendor, EV-1-gated — blocks G-CONN only | post-M12 |

## 2. The concurrency design (what protects what)

The mandate's required protections, each with its mechanism — races are decided by the database, not by application choreography:

| Threat | Protection |
|---|---|
| Two people choose the same room | **D-3b** `UNIQUE (picklist_id, work_item_id) WHERE accepted` |
| One turn accepts two different rooms (physician + proxy race) | **D-3a** `UNIQUE (turn_id) WHERE accepted` — the constraint the original design missed; nothing else stops this |
| Two turns open at once | **D-3c** `UNIQUE (picklist_id) WHERE state='open'` |
| Duplicate submission / replayed request | **D-11** command idempotency `UNIQUE (picklist_id, command_id)`; replays return the recorded outcome |
| Stale selection (client behind) | Aggregate version predicate in the turn transaction; version tokens on every frame; mismatch → typed rejection + resync |
| Queue advancement races / pause racing an in-flight commit | One authoritative transaction serialized by `FOR UPDATE` on the picklist row evaluates *every* predicate (turn open, server-clock expiry, list active/unpaused, actor authority, version, fencing token) with the constraints as final arbiter |
| Two coordinators / split-brain sweepers | **D-13** leases + monotonic fencing tokens; coordinators **relay a durable gapless event log (D-12) and never generate events** — two relays cannot disagree about history |
| Administrative edits during selection | Same transaction discipline; admin override of an accepted selection does not exist — correction is a separate post-hoc audited operation |
| Notification duplication on retry | Escalation steps dispatch via conditional claim; retries reuse `command_id`; provider idempotency keyed by stable `logical_delivery_id` (SPEC-07) |
| Reconnecting/stale clients | Resync from the event log by sequence number; announcements rebuilt from reconciled state ordered by `picklist_events.sequence` (AX-4) |
| Timer disputes | Server-authoritative clock only (I-08); client timers are display |

## 3. Real-time and monitoring

Turn-critical state pushed over page-scoped WebSockets (never global — the observed anti-pattern is banned); visible staleness indicator; explicit refresh fallback; monitor dashboard shows live progress, current picker, timer, and escalation state (SSE noted as an acceptable read-only alternative for the monitor — [11](11-architecture.md) §2). Every socket command frame re-declares context and re-authorizes (SPEC-01/06).

## 4. Notification ladder

Two-window model (mandatory + personal preferences), four channels (email, SMS, voice, push), safety-critical class overrides quiet hours and cannot be disabled; acknowledgement is durable state that halts the ladder; `no-destination` is an explicit recorded outcome; delivery ambiguity is honest (`ambiguous`/`unresolved`) rather than retried into duplication. The ladder is exercised in LIVE-SIM with fault-injected providers (EV-4 dependency for real-provider sandboxes).

## 5. Privacy boundary at the picklist

Work items carry **no free text** — `work_item_label_ref` and `location_ref` must resolve to approved vocabulary rows; ingestion passes through the raw-ingress enclave (SPEC-03); quarantine records paths/codes/counts, never values or hashes; the 16-surface canary sweep (SBX-029) is the proving test. Scheduler pushback on losing free text (RISK-30) is answered by a fast administrative vocabulary-add path in P-A — never by restoring free text.

## 6. Accessibility of the live turn (first-class acceptance)

AX-1 focus stolen only when the turn becomes yours · AX-2 focus never lands on `<body>` · AX-3 bursts coalesced, not queued · AX-4 announcements from reconciled state, ordered · AX-5 **a timed turn must be completable via assistive technology — if it is not, the time allowance changes, not the requirement.** Verified in SBX-033 with retained manual evidence (EV-8 AT lab dependency).

## 7. Exit evidence (M10 cannot close without)

P-01..P-15 pass, including P-02 (physician/proxy different-item race), ≥50-trial race batteries, pause-during-commit, duplicate/replayed commands, multi-sweeper fencing, reconnect-after-multiple-turns, completion/correction races — **exactly one accepted outcome per turn and one serialized event history in every trial**; SBX-020..027 evidence filed per SPEC-16 contracts; SBX-033 AT run retained; audit completeness check (every intervention, selection, and correction attributable).
