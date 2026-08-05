# 06 — Feature Parity Matrix

**The living parity framework.** One row per production capability (all 58, from report 19 — the scope authority). This document adds the dimension the corpus lacked: **fidelity intent** — how alike to the observed product each capability must feel, and why every divergence exists. It is a control document: the Status column is updated at every milestone review; report 19 is never edited to track progress.

**Parity levels:**
- **EXACT** — exact behavioural parity intended (user could not tell the products apart on this behaviour)
- **HIGH** — high functional parity (same outcome and workflow shape; own mechanism/visuals)
- **EQUIV** — equivalent modern behaviour (same user need; modern interaction pattern)
- **REDESIGN** — intentional redesign (observed behaviour rejected or absent; ours is deliberately different/better)
- **DEFERRED** — sequenced after production release (allowed only where report 19 assigns post-beta/post-production)
- **EXCLUDED** — not in the product (exactly one thing qualifies: patient-identifying content)

**Columns:** Observed behaviour & evidence are cited by ID (report 19 carries the full text). AC = acceptance-criteria source. Roadmap milestones (M0–M12) per [16-implementation-roadmap.md](16-implementation-roadmap.md). Status values: `not-started` / `in-progress` / `implemented` / `verified` (verified = its named tests passed and evidence filed).

| CAP | Capability | Parity | Intended difference (reason) | AC source | Depends on | Roadmap | Status |
|---|---|---|---|---|---|---|---|
| 001 | Organization tenancy root | HIGH | Org is explicit and first-class; source's org concept was implicit (retrofit-impossible) | SPEC-01 §7 | — | M1 | verified *(2026-08-04, M2 exit: SPEC-01 batteries M1 + SBX-004 sweep executed, EV-M2-SBX)* |
| 002 | Group scope & switching | HIGH | Context switch is declared+verified, never silent (CAR-001; QA-TEN-004) | SPEC-01 T-01..06 | 001 | M1 | verified *(2026-08-04, M2 exit: SPEC-01 T-01..06 M1 + SBX-001/004, EV-M2-SBX)* |
| 003 | Tenant isolation, server+DB | REDESIGN | No source equivalent observable; fail-closed RLS in unit-of-work | SPEC-01 T-07..15 | 001 | M0–M1 | verified *(2026-08-04, M2 exit: SPEC-01 T-07..15 + five-role SBX-004 incl. write arm, 0 wrong-tenant, EV-M2-SBX)* |
| 004 | Site modelling | HIGH | Attribute not entity while PO-DEC-01 pending; both migrations pre-modelled | 06 §3.2a | 002 | M2 | verified *(2026-08-05, OPUS-M3-007: locations + site_label per CAR-021, both migration directions fixture-proven with RED arms (reviewer mutation-tested), no site entity anywhere under independent search, EV-M3-SETTINGS)* |
| 005 | User accounts & types | HIGH | `login_email` admin-changeable (CAR-027); explicit account types (C-06) | SPEC-11 X-12 | 002 | M1 | verified *(2026-08-04, OPUS-M3-001: SBX-005 executed in full, login-email change audited+sessions-invalidated, SPEC-11 X-12 filed, EV-M3-AUTHN)* |
| 006 | Membership roles & capabilities | REDESIGN | Role+grant model replaces vestigial flags (C-02/PO-DEC-02); every grant tested | SPEC-06 §8 | 005, 057 | M1 | verified *(2026-08-04, M2 exit: SPEC-06 §8 cross-product 49.0M 0 disagreements + SBX-001/002, EV-M1-AUTHZ/EV-M2-SBX)* |
| 007 | Self-service profile & prefs | HIGH | — | R19 CAP-007 | 005 | M1 | not-started |
| 008 | AuthN & sessions | REDESIGN | MFA/SSO added; bounded lifetimes (source baseline unknown/weaker; PO-DEC-09) | R19 + 02 §7 | 001 | M1 | verified *(2026-08-04, OPUS-M3-001: password+TOTP MFA, server-side sessions with idle+absolute lifetimes, immediate suspension invalidation, session-epoch freshness; SBX-006 executed in full, SBX-001 re-run on real sessions, EV-M3-AUTHN. SSO/link deferred to its own decision)* |
| 009 | Invitation/activation | HIGH | Separated from password reset explicitly | R19 | 008 | M1 | verified *(2026-08-04, OPUS-M3-001: single-use atomic invitation, activation STM-017/018, separate password_reset_tokens namespace proven non-crossable (FAD-20), EV-M3-AUTHN)* |
| 010 | Impersonation | REDESIGN | Audited, banner, time-limited, no credential screens (source showed no audit trail) | R19; PO-DEC-11 | 006 | M8 | not-started |
| 011 | Shift type catalogue | **EXACT** | Four orthogonal flags preserved as-is (Confirmed, load-bearing product-wide) | R19 | 002 | M2 | verified *(2026-08-04, M2 exit: EV-M2-CATALOGUE: full field set, UI, field-mapping 31 rows)* |
| 012 | Shift groups & staff groups | **EXACT** | `allowRequest` server-side filter preserved; scoring mode+weight preserved | R19 | 011 | M2 | verified *(2026-08-04, M2 exit: EV-M2-CATALOGUE incl. valid combinations + monotonic pick positions)* |
| 013 | Weekday FTE / max assignments | HIGH | Canonical effective-dated tables (CAR-006) | SPEC-04 | 011 | M2 | verified *(2026-08-04, M2 exit: EV-M2-PROFILES: in-force battery, carry-forward semantics)* |
| 014 | Periods & versioned publication | REDESIGN | Immutable versions + revert-forward; **source has no rollback anywhere** | SPEC-05 V-01..16 | 015* | M3 | in-progress *(2026-08-04, OPUS-M3-003: SPEC-05 core API+DB verified — full V-01..V-19 harness green, SBX-018 falsifiable, D-15 set-immutability incl. FAD-22 INSERT arm, D-16/D-17, I-11 both halves, EV-M3-PUBLICATION; publication/version UX pends M3-005)* |
| 015 | Automated schedule generation | HIGH | Own solver/model (source algorithm unknown, clean-room) | SPEC-04; R21 | 011–013,016,058 | M4 | not-started |
| 016 | Rule engine (patterns/staff/positions) | HIGH | Typed versioned AST; hard/soft enforced in data+compiler | SPEC-04 S-01t..16t | 011,012 | M2 | in-progress *(2026-08-04, OPUS-M3-002: 30-node closed AST, deterministic compiler, unmapped-node gate, DB round trip all kinds, B-\* corpus with minimal certificates, authoring API + first UI slice (3 of 30 node editors; remainder assigned to M3-004), EV-M3-RULES; solver-side enforcement is M4)* |
| 017 | Progressive builds around pins | HIGH | `is_pinned` on snapshots (one lock concept) | SPEC-05 | 015,019 | M4 | not-started |
| 018 | Partial-schedule circulation | HIGH | — | R19 | 017 | M6 | not-started |
| 019 | Manual scheduling & override | HIGH | Permanent capability; production **mechanism** is automated (I-05/C-08) | R19; SPEC-05 | 014 | M3 | verified *(2026-08-05, OPUS-M3-004: grid + accessible alternative + cell editor over the M3-003 API; CAS atomicity proven under 12-round concurrent races after the review falsified the sequential proof; override reason enforced both sides on the known-missing arm (FAD-23); I-13 red-cased; EV-M3-AUTHORING-UX. Positioned as override/recovery/fixed-input/dev-stage only — M4 remains the production mechanism)* |
| 020 | Schedule viewing, 3 views, daily sheet | **EXACT**-leaning HIGH | Views/credit-split/provenance kept; a11y tabular alternative added (SPEC-14) | R19; SPEC-14 | 014 | M3/M6 | not-started |
| 021 | Requests: ON/OFF/No-Call/preference | HIGH | One aggregate + subtypes (PO-DEC-03 default); honest terminal states | SPEC-08 R-01..14 | 005 | M5 | not-started |
| 022 | Vacation quota/grant + open modes | **EXACT**-leaning HIGH | Advisory-not-blocking over-quota **preserved deliberately**; D-21 race fix added | SPEC-08 | 021 | M5 | not-started |
| 023 | Vacation commit to schedule | REDESIGN | Idempotent + reversible; graduated type-to-confirm friction **kept**; irreversibility dropped | SPEC-08 | 014, 022 | M5 | not-started |
| 024 | Opportunity board + fan-out | HIGH | Version-bound claims fail `STALE_ASSIGNMENT` (SPEC-13) | SPEC-13 M-01..12 | 020, 040 | M8 | not-started |
| 025 | Staff-over-locum priority | HIGH | Configurable window, default 24h (PO-DEC-16) | R19 | 024 | M8 | not-started |
| 026 | Offers/swaps/transfers + review | HIGH | Lifecycle is ours (source lifecycle Unknown); counterpart acceptance always | SPEC-13 | 020 | M8 | not-started |
| 027 | Change audit + affected-staff notify | REDESIGN | Generalized queryable audit; source had per-cell log only | R19; SPEC-11 | 019 | M1/M3 | not-started |
| 030 | Picklist preparation | HIGH | Vocabulary-constrained items; **no free text on protected paths** (CAR-004) | SPEC-02/03 | 014, 060 | M9 | not-started |
| 031 | Picklist execution | HIGH | Own turn machine (source never observed); I-13 everywhere | SPEC-02 P-01..15 | 030, 040 | M10 | not-started |
| 032 | Picklist concurrency & real-time | REDESIGN | D-3a/b/c constraints; fencing; event log — no source equivalent knowable | SPEC-02; SBX-022/023 | 031 | M10 | not-started |
| 033 | Admin intervention & monitoring | HIGH | Every intervention audited | SPEC-02 §7 | 031 | M10 | not-started |
| 034 | Proxy delegation | HIGH | Act-on-behalf, fully attributed (PO-DEC-19) | SPEC-02/06 | 031 | M10 | not-started |
| 040 | Delivery, escalation, retry, dedupe | REDESIGN | Delivery log + honest ambiguity states; **source has no delivery record at all** | SPEC-07 N-03..15 | 005 | M7 | not-started |
| 041 | Channels: email/SMS/voice/push | HIGH | Push added (C-10/PO-DEC-07); encrypted subscription material (CAR-009) | SPEC-07 §3 | 040 | M7/M9 | not-started |
| 042 | Contacts directory | REDESIGN | PII minimised by role (source exposed personal phones broadly); PO-DEC-20 | R19 | 005 | M5 | not-started |
| 043 | Bulk messaging | HIGH | — | R19 | 042 | M8 | not-started |
| 044 | On-call access (telecom) | HIGH | Dedicated minimal role | SPEC-06 | 006, 020 | M8 | not-started |
| 045 | Fairness statistics & variance | HIGH | Our formula, documented and visible (RISK-18) | R19; SPEC-04 | 019 | M6 | not-started |
| 046 | Reports: generate/print/export/share | EQUIV | Snapshot-bound async artifacts; 3-point authorization (CAR-012) | SPEC-09 F-01..14 | 020, 045 | M11 | not-started |
| 047 | Calendar feed | REDESIGN | High-entropy revocable tokens; **no PII/token-in-URL** (observed leak) | SPEC-09 | 020 | M11 | not-started |
| 048 | Document repository | HIGH | Policy-driven retention (PO-DEC-22) | R19 | 002 | M11 | not-started |
| 049 | Calendar events on schedule | HIGH | — | R19 | 020 | M11 | not-started |
| 050 | Design-system safety contract | REDESIGN | I-13 (anti instant-commit); graduated confirmation friction kept | SPEC-14; I-13 | all UI | M0→continuous | not-started |
| 051 | Observability, backup, recovery | REDESIGN | No source equivalent observable; restore rehearsal gated | SBX-035 | all | M1→M12 | not-started |
| 055 | Hospital integration framework | HIGH | Canonical schema owned by platform; connectors gated per-vendor | SPEC-03 I-01..12 | 030, 062 | M11 | not-started |
| 056 | Group communication identity | HIGH | Outbound-first (C-11/PO-DEC-21) | SPEC-07 | 040, 043 | M11 | not-started |
| 057 | Entitlements & feature gating | REDESIGN | First-class records; disable-never-deletes (PO-DEC-04 approved) | SPEC-06 | 001 | M1 | in-progress *(2026-08-04, M2 exit: gating live server-side + SBX-002 truth table; tenant-facing admin surface pending (FAD-13(2)))* |
| 058 | Qualifications & eligibility | HIGH | Evidence reference + expiry (PO-DEC-12) | R19 | 005, 011 | M2 | verified *(2026-08-04, M2 exit: EV-M2-PROFILES + EV-M2-INTEGRATION incl. shift_type_qualifications)* |
| 059 | Conflict detection & build quality | HIGH | Severity taxonomy (PO-DEC-13); independent solution re-validation | SPEC-04 | 015,016,058 | M4 | not-started |
| 060 | Picklist modes: paper/manual/integrated | HIGH | — | R19 | 030 | M9 | not-started |
| 061 | Connector certification pipeline | **DEFERRED** (post-beta per R19) | Gated on EV-1 vendor specs — blocks G-CONN only | SPEC-03; SBX-028/029 | 055 | M12+ | not-started |
| 062 | De-identification / ingestion boundary | REDESIGN | Raw-ingress enclave; rejection-never-sanitization; **the** privacy divergence | SPEC-03; SBX-029 16-surface sweep | 055 | M9/M11 | not-started |
| 063 | Cerner/Surginet connector | **DEFERRED** (post-beta) | EV-1 blocked | SBX-028/029 | 055 | post-M12 | not-started |
| 064 | Meditech connector | **DEFERRED** (post-beta) | EV-1 blocked | SBX-028/029 | 055 | post-M12 | not-started |
| 065 | Customer-specific connectors | **DEFERRED** (post-production) | Per-customer | SBX-028 | 055 | post-M12 | not-started |
| 066 | Accessibility conformance | REDESIGN | SP-HR-3..6 close observed failures; continuous | SPEC-14 AC-01..13 | all UI | M0→continuous | not-started |
| 067 | Request efficiency & performance | REDESIGN | SP-HR-2 budget closes observed 25–40× amplification; continuous | QA-PERF-001..011 | all | M0→continuous | not-started |
| 068 | No third-party identifier leakage | REDESIGN | Build-breaking CI network guard closes observed FEAT-052 leak | QA-SEC-001..003 | all UI | M0 | not-started |

*CAP-014 lists CAP-015 as dependency in report 19; the roadmap satisfies this by delivering publication (M3) against manually-created builds, with automated builds (M4) slotting into the same lifecycle — sequencing note recorded in [16](16-implementation-roadmap.md) M3.

## 2. Tallies

- EXACT or EXACT-leaning: 5 · HIGH: 30 · EQUIV: 1 · REDESIGN: 18 · DEFERRED: 4 (connector items only, per report 19's own dispositions) · EXCLUDED capabilities: **0**
- **EXCLUDED content: exactly one** — patient-identifying information, excluded by boundary (I-07/I-17), with the user outcome preserved (CAP-030/033/060).

## 3. Why every REDESIGN exists

Each maps to one of four justifications, all documented: **(a)** an observed source defect (SP-HR-1..6, I-13: CAP-050/066/067/068, 042, 047); **(b)** an observed structural absence with real consequences (no rollback → 014; no delivery log → 040; no queryable audit → 027; no entitlements → 057; no observable isolation → 003, 051); **(c)** an approved SchedulePoint decision where the source fact is permanently unresolvable (006 ← C-02; 032 ← C-04; 062 ← C-09); **(d)** modern-baseline security the source lacked (008, 010). **A difference from the source without a row in this table is a defect** — that rule is now part of the runbook review checklist.
