# SPEC-14 — the automatable cells, executed; the real-AT cells, unclaimed

**OPUS-M3-008 · SPEC-14 §§1–2 · packet 32 §2 row 12**

SPEC-14 §2 marks every cell `A` (automatable — axe-core or a scripted assertion)
or `M` (manual evidence required). Packet 32 §2 row 12 splits them: the
automatable portions are this packet's; **the real-assistive-technology sessions
are M6's**, and until then the cells are *"honestly marked unclaimed — never
converted to claims"*.

This document does that split for the components that exist at M3.

## The rule this document is written under

SPEC-14 §1 ends: **"A combination without retained manual evidence is not claimed
as supported."** No `M` cell below is marked satisfied. Where an automated
assertion happens to touch the same behaviour a manual cell describes, it is
recorded as *what the automation measured*, explicitly **not** as the manual
evidence — because a scripted DOM assertion and a screen-reader user's experience
are different claims, and conflating them is how an accessibility matrix becomes
decoration.

---

## 1. Components that exist at M3

SPEC-14 §2's matrix covers eleven components. Six do not exist yet — the picklist
turn panel, turn countdown, remaining-choice list (all M9), the vacation calendar
(M5), report/document tables (the reporting milestone), and the notification
banner (the notifications milestone). Their cells are neither claimed nor
dropped; each is owned by the milestone that builds it.

The five that exist:

| Component | Where |
|---|---|
| Schedule grid | `apps/web/src/schedule/` (M3-004), with its first-class tabular alternative |
| Conflict indicator | the authoring grid's conflict display (M3-004) |
| Request form → **read as: every authoring form** | catalogue, rules, schedule, settings, publication confirmation |
| Validation summary | `apps/web/src/components/` shared summary, used by every form |
| Modal / dialog | the publication confirmation, the clone/revert confirmations |
| Add/New/Create controls (I-13) | every `New …` control in the product |

---

## 2. The `A` cells — executed

Every row below is asserted by a test that runs in `pnpm check`'s `axe` gate at
**both** standing viewports (desktop 1280×800, mobile 390×844) plus a 320px arm.

| Component | Cell | Assertion | Where |
|---|---|---|---|
| Schedule grid | `A` real table semantics with row/column headers | the tabular alternative is a real `<table>` with `scope="row"`/`scope="col"`; the grid and the alternative render the **same** data (full-sweep equality, the reviewer's stronger form) | `apps/web/e2e/schedule.spec.ts` |
| Schedule grid | `A` visible focus ≥3:1 | axe `focus-order-semantics` + the shared focus ring token | axe, both viewports |
| Schedule grid | `A` ≥44px touch targets | measured per control | `schedule.spec.ts` AC-09 |
| Schedule grid | `A` no page-level horizontal scroll at 320px | the **table** scrolls, the page does not | `schedule.spec.ts` AC-08 |
| Schedule grid | `A` reduced-motion honoured | no animation is introduced by this product | — (vacuously true; recorded as such rather than claimed as tested) |
| Conflict indicator | `A` non-colour cue present | every conflict carries a text label; palette keys are CHECK-constrained tokens, never free colour | `catalogue.spec.ts` "colour is never the only carrier" |
| Conflict indicator | **`A` colour is never the sole carrier** | asserted across all six palettes | `catalogue.spec.ts` |
| Every form | `A` labels + `aria-describedby` | axe `label`, `form-field-multiple-labels` | axe, every surface |
| Every form | **`A` focus to the error summary on submit failure** | the summary receives focus and links to the field | `catalogue.spec.ts` AC-11, `rules.spec.ts`, `settings.spec.ts` |
| Validation summary | `A` `role="alert"`, links to fields | asserted directly | as above |
| Validation summary | `A` receives focus | asserted directly | as above |
| Modal / dialog | `A` `role="dialog"`, labelled | axe + direct assertion | `publication.spec.ts` |
| Modal / dialog | `A` focus trap, `Esc` closes | direct assertion | `publication.spec.ts` |
| Modal / dialog | `A` focus returns to trigger | direct assertion | `publication.spec.ts` |
| Add/New/Create (I-13) | `A` accessible name | axe `button-name` | every surface |
| Add/New/Create (I-13) | `A` keyboard reachable + focus | keyboard journeys end to end | every surface |

**Added by this packet, to the same standard:** the audit-chain table on the
published-schedule page (real table semantics, scoped headers, `overflow-x` on
the table not the page, axe green at both viewports), and its **denial** state,
which is a stated panel rather than an error — asserted in
`apps/web/e2e/publication.spec.ts`.

**The forced-colors half of two `A` + `M` cells is NOT claimed.** SPEC-14 marks
"Contrast / forced colors" as `A` **and** `M` for the grid and the conflict
indicator. axe measures contrast; it does not render Windows High Contrast. The
automated half is done and the forced-colors half is M6's.

---

## 3. The `M` cells — unclaimed, with their owner

| Component | Cell | Status |
|---|---|---|
| Schedule grid | navigable cell-by-cell **with position announced** | **UNCLAIMED** → M6 (EV-8 AT sessions) |
| Schedule grid | arrow-key navigation, `Home`/`End`, page jumps | **UNCLAIMED** → M6. *Automation measured*: arrow keys move between days and `Enter` opens the daily sheet (`my-schedule.spec.ts`). That is a DOM assertion, not the manual cell |
| Schedule grid | cell context announced without reading the whole row | **UNCLAIMED** → M6 |
| Schedule grid | forced-colors | **UNCLAIMED** → M6 |
| Schedule grid | **alternative list view** | *Automation measured*: the alternative exists, is first-class, and renders the same entries (full-sweep equality). The **manual** cell — that it is usable as an alternative by an AT user — is **UNCLAIMED** → M6 |
| Conflict indicator | conveyed textually | *Automation measured*: text is present. Announcement is **UNCLAIMED** → M6 |
| Every form | error count announced | **UNCLAIMED** → M6 |
| Validation summary | announced once, not per keystroke | **UNCLAIMED** → M6. *Automation measured*: the summary appears once per submit and the client refuses an empty form without a request |
| Modal / dialog | title announced | **UNCLAIMED** → M6 |
| Add/New/Create (I-13) | **nothing persists before Save — announced state matches reality** | The *behaviour* half is proven hard: filling every field on every form issues **zero** requests, budgeted at 0 and red-cased. The **announcement** half is **UNCLAIMED** → M6 |

**Count: 10 manual cells across the five existing components, every one
unclaimed, every one owned by M6.** None is marked satisfied by proximity to an
automated assertion.

---

## 4. The supported-combinations table (SPEC-14 §1)

| Combination | Claim |
|---|---|
| Keyboard-only, any supported browser | **CLAIMED** — end-to-end keyboard journeys on every surface, both viewports, in `pnpm check` |
| 400% zoom / 320 CSS px reflow | **CLAIMED for 320px reflow**; 400% zoom is **UNCLAIMED** → M6 (the two are related but not the same measurement) |
| NVDA + Firefox · JAWS + Chrome · VoiceOver + Safari (macOS and iOS) · TalkBack + Chrome | **NONE CLAIMED** → M6. No AT session has been run, so per §1 none of these is a supported combination yet |
| Windows High Contrast / forced-colors | **UNCLAIMED** → M6 |

This is the honest state and it is deliberately not improved by inference: axe
green at two viewports says the markup does not contain the violations axe knows
about. It does not say a screen-reader user can schedule a rota.
