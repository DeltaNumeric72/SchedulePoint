# SPEC-14 — Accessibility Acceptance Matrix

**Status: `PROPOSED`.** Remediates **CAR-022** (Medium).
**Supersedes:** [10](../10-picklist-and-realtime.md) §10; [16](../16-testing-and-environments.md) §§3, 5, 7 accessibility rows.
**ADR:** [ADR-0002](../decisions/ADR-0002-primary-technology-stack.md) (revised).

> **What was wrong.** Keyboard, focus, live regions, validation, zoom, and reflow were **named** but never turned into acceptance criteria. `axe-core` cannot verify most of them. The picklist — the product's most demanding surface — did not say how reordered, duplicated, or burst events are announced without overwhelming a screen-reader user, or where focus goes when a live update replaces the panel.

---

## 1. Conformance target and supported combinations

**Target: WCAG 2.2 Level AA**, plus the specific behaviours below where AA is silent about a live, timed workflow.

| Combination | Support level |
|---|---|
| NVDA + Firefox (Windows) | **Full — manual evidence required** |
| JAWS + Chrome (Windows) | **Full — manual evidence required** |
| VoiceOver + Safari (macOS) | **Full — manual evidence required** |
| VoiceOver + Safari (iOS) | **Full — manual evidence required** (mobile picking) |
| TalkBack + Chrome (Android) | Full — manual evidence required |
| Keyboard-only, any supported browser | **Full** |
| Windows High Contrast / forced-colors | **Full** |
| 400% zoom / 320 CSS px reflow | **Full** |

**A combination without retained manual evidence is not claimed as supported.**

---

## 2. Component acceptance matrix

`A` = automatable (axe-core or a scripted assertion). `M` = **manual evidence required**.

| Component | Semantics | Keyboard | Focus | Announcement | Contrast / forced colors | Touch | Reflow | Motion |
|---|---|---|---|---|---|---|---|---|
| **Schedule grid** | `A` real table semantics with row/column headers; **`M` navigable cell-by-cell with position announced** | `M` arrow-key navigation, `Home`/`End`, page jumps | `A` visible focus ≥3:1 | `M` cell context announced without reading the whole row | `A` + `M` forced-colors | `A` ≥44px | `A` no page-level horizontal scroll at 320px; **`M` alternative list view** | `A` reduced-motion honoured |
| **Conflict indicator** | `A` non-colour cue present | `A` reachable | `A` | `M` conveyed textually | **`A` colour is never the sole carrier** | `A` | `A` | — |
| **Picklist turn panel** | `A` roles correct | `M` full pick flow keyboard-only | **`M` §3** | **`M` §3** | `A` + `M` | `A` | `A` | `A` |
| **Turn countdown** | `A` `role="timer"` | — | — | **`M` announced at 50%, 25%, and 10% remaining — not every second** | `A` | — | `A` | `A` reduced-motion: no pulsing |
| **Remaining-choice list** | `A` list semantics | `M` navigable | **`M` focus preserved across updates** | **`M` throttled §3** | `A` | `A` | `A` | `A` |
| **Request form** | `A` labels, `aria-describedby` | `A` | **`A` focus to the error summary on submit failure** | `M` error count announced | `A` | `A` | `A` | — |
| **Validation summary** | `A` `role="alert"`, links to fields | `A` | `A` receives focus | `M` announced once, not per keystroke | `A` | `A` | `A` | — |
| **Vacation calendar** | `A` grid semantics | `M` date navigation | `A` | `M` selection state announced | `A` | `A` | **`M` list alternative** | `A` |
| **Report / document tables** | `A` table semantics, sortable headers | `A` | `A` | `M` sort change announced | `A` | `A` | `A` | — |
| **Notification banner** | `A` `role="status"` | `A` dismissible | `A` no focus steal | `M` polite | `A` | `A` | `A` | `A` |
| **Modal / dialog** | `A` `role="dialog"`, labelled | `A` focus trap, `Esc` closes | `A` focus returns to trigger | `M` title announced | `A` | `A` | `A` | `A` |
| **Add/New/Create controls** (I-13) | `A` accessible name | `A` | `A` | `M` nothing persists before Save — announced state matches reality | `A` | `A` | `A` | — |

---

## 3. Real-time interruption policy

**The hardest part of CAP-066 and the part previously undefined.**

| Event | `aria-live` | Focus | Throttle |
|---|---|---|---|
| **Your turn starts** | **`assertive`** | **Move focus to the choice list** and announce the time limit | Never throttled |
| Your turn is ending soon | `assertive` | **No focus change** | At 50%, 25%, 10% only |
| Another participant picked | `polite` | **No focus change** | **Coalesced: at most one announcement per 5 s, summarised — "3 rooms taken, 7 remain"** |
| Turn advanced to someone else | `polite` | No focus change | Coalesced |
| List paused / resumed | `assertive` | No focus change | Immediate |
| Picklist completed | `assertive` | Focus to the summary | Immediate |
| Connection lost / stale | `assertive` | No focus change | Immediate; **and it must be announced, because silence is indistinguishable from nothing happening** |
| Reconnected and resynchronised | `polite` | **Focus restored to its pre-disconnect element if it still exists**, else to the panel heading | Immediate |

| Rule | Detail |
|---|---|
| **AX-1 · Focus is never stolen except when the turn becomes yours** | The one interruption that justifies it |
| **AX-2 · Focus is never lost** | If the focused element is removed by an update, focus moves to its **nearest stable ancestor**, never to `<body>`. **Focus landing on `<body>` is a test failure** |
| **AX-3 · Bursts are coalesced, not queued** | Ten events in two seconds produce **one** summary announcement. A queue would read stale events after the turn moved on |
| **AX-4 · Reordered or duplicated events never reach the live region** | The client applies `picklist_events.sequence` ordering ([SPEC-02](SPEC-02-picklist-turn-transaction.md) §8) **before** announcing. Announcements come from reconciled state, not from the wire |
| **AX-5 · The timed turn must be completable** | A screen-reader user must finish a pick within the standard allowance. **If SBX-033 shows it cannot be, the allowance changes — not the requirement** |
| **AX-6 · Extension** | A per-user setting extends the allowance; the extension is visible to the administrator and audited |

**AX-5 is deliberately stated as a constraint on the product, not on the user.** A timed workflow that a screen-reader user cannot complete is an exclusion.

---

## 4. Evidence

| Type | Retained |
|---|---|
| Automated (`axe-core`) | Per-build report; **build fails on any violation** |
| **Manual screen-reader script** | Recorded session per `M` cell per supported combination, per release |
| Keyboard-only walkthrough | Recorded per critical journey |
| Forced-colors and 400% zoom | Screenshots per component |
| Touch-target measurement | Automated report |
| **Timed-turn completion (SBX-033)** | **Recorded session with elapsed time** per combination |

**Critical journeys requiring full manual evidence:** sign in → view schedule · submit and track a request · complete a **timed picklist turn** · claim an opportunity · request and download a report · select vacation.

---

## 5. Test contract

**Extends SBX-032, SBX-033, SBX-034.**

| # | Test | Required outcome |
|---|---|---|
| AC-01 | axe-core on every component and journey | **Zero violations; build fails otherwise** |
| AC-02 | Keyboard-only critical journeys | All completable |
| AC-03 | **Focus after every real-time transition** | **Never `<body>`; AX-1/AX-2 hold** |
| AC-04 | **Burst of 20 events in 2 s** | **One coalesced announcement (AX-3)** |
| AC-05 | **Reordered and duplicated events injected** | **Announcements match reconciled state (AX-4)** |
| AC-06 | **Timed turn via screen reader, all combinations** | **Completed within the allowance (AX-5)** |
| AC-07 | Forced-colors mode | All information conveyed; no colour-only cue |
| AC-08 | 400% zoom / 320px | No page-level horizontal scroll; alternatives available |
| AC-09 | Touch targets | ≥44×44 CSS px |
| AC-10 | Reduced motion | No non-essential animation |
| AC-11 | Form submission failure | Focus to summary; error count announced once |
| AC-12 | Schedule grid cell navigation | Position and context announced |
| AC-13 | Connection loss during a turn | **Announced assertively** |

---

## 6. Traceability

**Capabilities:** CAP-020, CAP-021, CAP-031, CAP-032, CAP-045, CAP-046, CAP-050, CAP-066, CAP-067.
**Decisions:** PO-DEC-18 (approved).
**Gates:** `G-BETA`, `G-PROD`. **Neither passed. No manual evidence has been collected.**
