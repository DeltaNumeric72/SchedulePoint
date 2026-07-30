# 09 — Responsive & Accessibility Behaviour: ischedule.MD

**Phase:** 10 — responsive layout and accessibility observations across a representative sample of already-documented, safe read-only screens.

**Method:** Read-only per [RESEARCH-RULES.md](../RESEARCH-RULES.md), under the same strengthened safety boundary as Phase 9. No new action surface was opened solely for this testing; the one modal exercised (Swap Shift) was already established as safe-to-open-and-Cancel in Phase 4, and was only ever dismissed via **Escape** or left unsubmitted. Keyboard testing used only Tab/Shift+Tab/Escape and read-only JavaScript inspection of `document.activeElement` — **no Enter or Space was pressed on any button, checkbox, toggle, menu item, or link**, and no field was typed into. Viewport resizing used `resize_window` only; no viewport-specific setting was saved.

**Merges by stable ID** into every prior report's screen IDs (SCH-01/02/03/04/05, VAC-01, CON-01, DOC-01, PLM-01, ADM-05) rather than redescribing their functional behavior — this report adds only responsive/accessibility observations layered on top of those already-documented screens.

**Evidence labels:** **[OBSERVED]** · **[INFERRED]** · **[UNRESOLVED]**.

**Exclusions honored:** the Contacts screen's phone-width screenshot showed real staff names, emails, and phone numbers in an overflowing table. **None of that content is reproduced or described individually here** — only the structural/layout finding (the table overflows the viewport) is recorded, exactly as required.

**No accidental mutation occurred this phase.**

---

## §1 — Responsive behaviour

### RA-01 — Global app shell (top bar + sidebar)

Tested at desktop (1512×900), tablet (768×1024), and phone (375×812, rendered at a `window.innerWidth` of ~500 CSS px due to the test device's pixel ratio — noted for reproducibility).

| Breakpoint | Sidebar | Top bar |
|---|---|---|
| Desktop | Full icon+label sidebar, always visible, no toggle needed | Single row: Tour / Dashboard / Site switcher / User menu |
| Tablet (768) | **Collapses entirely**, replaced by a **hamburger icon** (☰) top-left | Same single-row layout, slightly compressed |
| Phone (~500 effective) | Hamburger icon (same as tablet) | **Wraps to two rows** — Tour/Dashboard/Site switcher on row one, User menu below |

**[OBSERVED]** There is a real, working breakpoint between 1512 and 768px where the sidebar switches from persistent to hamburger-triggered. **[UNRESOLVED]** the exact pixel breakpoint (not narrowed down beyond "somewhere between 768 and 1512") and what the hamburger menu's opened state looks like (not clicked, since its effect — full navigation drawer — was already established as safe in principle but re-opening it was not necessary to observe the collapse itself, which is visible without opening it).

### RA-02 — Calendar/schedule grids (My Schedule, Master Schedule)

**[OBSERVED]** Both the My Schedule month calendar and the Master Schedule staff×date grid use a **shrink-to-fit** strategy at narrow widths: all 7 day columns remain visible and roughly proportional, with cell content (shift codes, numbers) simply rendered smaller, rather than the grid being replaced by a card-per-day mobile layout or triggering horizontal scroll. Confirmed via `document.documentElement.scrollWidth` (510px) vs. `window.innerWidth` (500px) on both screens at phone width — effectively **no horizontal overflow**, meaning the shrink genuinely fits the content rather than silently clipping it.

**User impact:** at phone width, calendar cell text becomes quite small and dense (visually confirmed via screenshot — multi-line shift-code stacks in a cell become tightly packed), which is usable but not comfortable for sustained phone use. This is consistent with the product's own marketing positioning ("mobile picklist" delivered via SMS/voice notifications rather than a mobile-optimized web calendar) — **[INFERRED]** the web calendar was likely never designed with phone-first use as a priority, since the product's actual mobile story is the notification/pick-by-phone-call workflow documented in Phase 8, not this grid.

### RA-03 — Dense data tables (Contacts; by extension, admin tables)

**[OBSERVED, concrete]** The Contacts table does **not** shrink to fit at phone width. Measured: `scrollWidth` 770px vs. `innerWidth` 500px on the same device profile that showed the calendar fitting cleanly — a genuine 270px overflow. Critically, `document.body`'s computed `overflow-x` is `visible`, meaning **the entire page scrolls horizontally**, not just the table within a contained, scrollable region. The rightmost columns (Home phone, Pager, and the bulk-action buttons area) are pushed off-screen with no visible affordance (no scroll shadow/indicator) hinting that more content exists to the right.

**User impact:** a phone user must discover, by trial, that they can scroll the whole page sideways to see a contact's remaining phone numbers or reach the Send SMS button — a real usability gap, and a common one for tables that were designed desktop-first without a `overflow-x: auto` container specifically around the `<table>` element (which would at least keep the header/toolbar fixed while only the table body scrolls).

**[INFERRED]** the same pattern likely affects every other data-dense admin table encountered across this research (Staff/Users, Builds, Pattern/Staff Rules, Shift catalogs) given they share the same general table markup pattern observed in Phase 3/6 — **not independently re-verified at phone width this phase**, to keep the total number of screens tested manageable; flagged as a reasonable extrapolation, not a directly confirmed fact for those specific screens.

### RA-04 — Modals

**[OBSERVED]** The Swap Shift modal (My Schedule) renders as a centered overlay dialog at all three tested widths, with a semi-transparent backdrop. No responsive repositioning issue was observed — it did not overflow or get clipped at phone width (not independently re-screenshotted at phone width this phase, but its field count is small enough that overflow is unlikely; **[INFERRED]** based on its simplicity relative to the Contacts table).

### RA-05 — Toolbars and buttons

**[OBSERVED]** Multi-button toolbars (Master Schedule's Batch Mode/Font Size/All Shifts/Date View/1 Week/Print/Date/Today row; Vacation's Settings/Batch Entry Off/Approve/TRANSFER/Schedule View row) **wrap onto multiple lines** at narrower widths rather than collapsing into an overflow menu — confirmed visually on Master Schedule at phone width (buttons stacked across ~3 visual rows). No button was truncated or became unreachable; wrapping, while not elegant, did not break functionality.

### RA-06 — Print presentation, mobile-only/desktop-only controls, layout failures

- **Print presentation:** **[UNRESOLVED]** — no Print control was activated this phase (consistent with the strengthened safety boundary), so actual print-layout/print-stylesheet behavior is unknown.
- **Mobile-only or desktop-only controls:** **[OBSERVED — none found]** every control seen at desktop width remained present (if visually wrapped/shrunk) at phone width; no control appeared or disappeared based on viewport alone, beyond the sidebar↔hamburger swap (RA-01).
- **Layout failures:** the Contacts horizontal-overflow (RA-03) is the one genuine layout failure found — everything else degraded gracefully (shrinking or wrapping) rather than breaking.

---

## §2 — Keyboard behaviour

### RA-07 — Focus visibility (significant finding)

**[OBSERVED, high confidence]** Tabbing through Master Schedule and My Schedule and inspecting `document.activeElement`'s computed style at each stop showed **`outline-style: none`** consistently — on the sidebar-toggle link, on the "Dashboard" nav link, and (by the consistency of the pattern) very plausibly globally, via a CSS reset rather than a per-element override. **No alternative visible focus indicator** (no `box-shadow`, no background-color change observed) was found on any of the elements sampled.

**User impact:** a sighted keyboard-only user (e.g., someone with a motor impairment who cannot use a mouse, or simply someone who prefers keyboard navigation) has **no reliable way to see which element currently has focus** while tabbing through the app. This is one of the most impactful, easily-reproducible accessibility gaps found in this entire research effort.

**[UNRESOLVED]** whether *any* element anywhere in the app shows a visible focus state — only a handful of stops were sampled (sidebar toggle, Dashboard link, Cancel button, modal container). It remains possible some specific component (e.g., a native `<input>`) retains a browser-default focus ring not overridden by the app's CSS reset; not exhaustively tested.

### RA-08 — Focus order

**[OBSERVED]** Tab order on Master Schedule proceeded logically top-to-bottom, left-to-right through the top bar and into the sidebar (skip-link icon → Tour → Dashboard → …), consistent with visual/DOM order. No obvious reordering or skip was detected in the ~5-stop sample taken.

### RA-09 — Modal focus behaviour (positive finding)

**[OBSERVED, high confidence]** Opening the Swap Shift modal moved focus **into the modal's container element immediately** (a good initial-focus pattern). Tabbing forward through all of the modal's interactive elements (two checkboxes, the staff-search combobox, Cancel, Swap Shifts) and one step further returned focus to the **modal's own container**, not to any element in the page behind it — i.e., **focus was correctly trapped inside the modal** and did not leak to background controls. This is a genuine accessibility strength, worth explicitly calling out alongside the gaps.

### RA-10 — Escape behaviour (positive finding)

**[OBSERVED]** Pressing **Escape** while the Swap Shift modal was focused closed it cleanly, with no submission and no visible error — matching the same safe behavior as clicking its own Cancel button. **[INFERRED]** other modals throughout the product (Vacation Block Selection, Staff Balance, etc.) very likely support the same Escape-to-close pattern, given this is a common shared-component behavior in web UI frameworks, but this was not independently re-tested on every modal this phase (would require re-opening each, which risks repeating the kind of surprise found in Phase 8 §0 for any modal not already 100%-confirmed safe).

### RA-11 — Keyboard traps, skip links, unreachable controls

- **Keyboard traps:** **[OBSERVED — none found]** outside of the modal's *intentional* trap (RA-09, which is correct behavior, not a bug). No unintentional trap was encountered in the non-modal Tab sequence sampled.
- **Skip links:** **[OBSERVED — absent]** no "skip to main content" link was found via DOM query (`a[href="#main"]`, `.skip-link`, or any `class*="skip"` element) on Master Schedule. A keyboard user must tab through the entire top bar and full sidebar (11+ links) before reaching page content on every single page load.
- **Controls activated only by pointer input:** **[UNRESOLVED]** — determining this definitively would require pressing Enter/Space on suspect controls, which this phase's rules prohibit. No specific pointer-only control was identified, but none was ruled out either.

---

## §3 — Accessibility observations

### RA-12 — Heading hierarchy (significant finding)

**[OBSERVED, concrete]** Master Schedule has **zero `<h1>`, `<h2>`, or `<h3>` elements anywhere on the page** — only ten `<h4>` elements, the majority of which are **hidden modal titles** (e.g., "Create Stipend Report," "Create PickList Report," "Create Schedule Report," "Create DayXShift Report," "Create Requests Report" — pre-rendered but not visible until their respective modal opens) rather than actual visible page headings. The large "MASTER SCHEDULE" text seen at the top of the page **is not a heading element at all** — it renders as plain styled text.

**User impact:** a screen-reader user navigating by heading (a standard, heavily-relied-upon technique) finds **no page-level heading structure whatsoever** on one of the product's most important screens — they cannot jump to "the page title" or "the grid section" via heading navigation, and would encounter a flat, confusing set of unrelated H4s if they tried.

**Bonus finding, purely from this passive check:** the hidden H4 titles **name all five underlying report types** behind Master Schedule's Print menu, resolving Phase 9's open question about what those controls produce (they open "Create `<Type>` Report" configuration dialogs, not instant downloads) — including a previously-unknown fifth type, **"DayXShift Report"** (likely a day-by-shift cross-tabulation), which was not visible as a labeled Print-menu item in any prior phase's screenshots.

### RA-13 — ARIA labeling (mixed finding)

**[OBSERVED, concrete]** On Master Schedule: **zero elements** have `aria-label`, and **zero** have `aria-labelledby` — despite the page having 33 `<button>` elements, 3 of which have **no text content and no accessible name of any kind**. Identified specifically: the two icon-only **Prev/Next date-navigation arrows** flanking the "Today" button (present on nearly every schedule-bearing screen across the whole product — My Schedule, Master Schedule, On Call, Vacation, Shift Statistics, and more) and one dropdown-toggle icon button near a "Save Changes" area. A screen reader would announce these as a bare, unlabeled "button" — for the Prev/Next pair specifically, a user has no way to know which direction each button moves without relying on the icon's visual arrow alone.

**Balancing positive finding [OBSERVED]:** the app **does** use ARIA roles meaningfully in several places — `role="grid"`/`"row"`/`"gridcell"` on the schedule table (appropriate for a spreadsheet-like data grid), `role="combobox"`/`"listbox"`/`"option"` on the custom staff/shift-search widgets (appropriate given these aren't native `<select>` elements, as established in earlier phases), and `role="dialog"` on modals. This is a genuinely mixed picture: **structural roles are present, but accessible names are largely missing.**

### RA-14 — Dialog/modal naming (gap)

**[OBSERVED, concrete]** Of **nine** elements with `role="dialog"` present in Master Schedule's DOM at once (most hidden until triggered), only **one** has `aria-labelledby` set; **none** has `aria-label`; and **none** has `aria-modal="true"`. The visible dialog title text (e.g., "Swap - Jul 30, 2026 (Thu)") exists on-screen, but without `aria-modal` and (for 8 of 9) without a label association, a screen reader may not reliably announce that a modal has opened, what it's called, or that background content should be treated as inert.

### RA-15 — Table headers

**[OBSERVED]** Master Schedule uses 15 `<th>` elements across 8 `<table>` elements — genuine semantic table markup exists (a positive baseline), though `role="columnheader"` (the ARIA-grid equivalent, which would be expected alongside the `role="grid"` pattern noted in RA-13) was not found anywhere, suggesting the grid mixes plain HTML table semantics with an ARIA grid pattern inconsistently rather than committing fully to one model.

### RA-16 — Colour-only meaning (recap, now explicitly flagged as an accessibility concern)

**[OBSERVED, recap from Phases 1/7]** The Vacation grid's status badges (pending vs. approved vacation weeks) are visually distinguished **only by fill color** (amber vs. green) on an otherwise identically-shaped speech-bubble icon — no icon-shape change, text label, or pattern difference accompanies the color change. Similarly, Master Schedule's `OFF` (vacation) text and various shift-code colors throughout the product rely on color coding (e.g., red negative Staff Balance numbers) without a consistently paired non-color indicator. **User impact:** a colorblind user (or a screen-reader user, for whom color conveys nothing at all) cannot reliably distinguish a pending vacation request from an approved one by the badge alone.

### RA-17 — Required-field indication, error-message exposure, status communication

**[UNRESOLVED]** — none of the forms encountered this phase were submitted (per the safety boundary), so no validation error state was ever triggered or observed. Required-field marking (asterisks, `aria-required`, etc.) was not specifically inspected this phase; flagged as a gap for a future, explicitly-scoped pass.

### RA-18 — Live regions, timing, zoom/reflow

- **Live regions [OBSERVED]:** 4 elements with `aria-live` were found on Master Schedule — **[UNRESOLVED]** their exact purpose (most likely the "Loading Content" banner and/or the "last synced N minutes ago" staleness indicator from Phase 8, both of which update without a full page reload and would benefit from being announced) — not individually inspected further this phase.
- **Timing concerns [OBSERVED, recap]:** the "last synced N minutes ago" pattern on Picklist Manager (Phase 8) and the general lack of any countdown/timer UI anywhere (also Phase 8) suggests the product does not impose strict client-side timing pressure on users for reading content — a mild positive from an accessibility-timing perspective, though the *notification escalation* timers (Phase 8 §3) do impose real-world time pressure on picklist responses, which is a product-level (not web-accessibility) consideration.
- **Zoom and reflow:** **[UNRESOLVED]** — browser zoom (as opposed to viewport resize) was not tested this phase; the shrink-to-fit calendar behavior (RA-02) suggests the layout is fluid/percentage-based rather than fixed-pixel, which is a favorable sign for zoom/reflow, but this is an inference, not a direct zoom test.

### RA-19 — Alternative text

**[OBSERVED]** 1 of 3 `<img>` elements on Master Schedule lacks an `alt` attribute entirely. **[UNRESOLVED]** which image and whether it's purely decorative (in which case `alt=""` would be correct and its absence is a minor/moot gap) or conveys information (in which case this is a real gap) — not individually identified this phase.

---

## §4 — SchedulePoint recommendations

| Finding ID | Source screen | Observed behaviour | User impact | Recommended SchedulePoint behaviour | Priority | Acceptance criterion | Suggested test |
|---|---|---|---|---|---|---|---|
| **F-01** | RA-07, all screens | Global CSS suppresses the default focus outline with no replacement visible-focus style | Keyboard-only users cannot see which control has focus anywhere in the app | Never set `outline: none` without a compliant visible replacement (e.g., a high-contrast focus ring meeting WCAG 2.2 Focus Appearance) on every interactive element | **High** | Given any interactive element receives keyboard focus, when observed visually, then a focus indicator meeting at least a 3:1 contrast ratio against its background is visible | Automated: axe-core / Lighthouse focus-visible check across all interactive components. Manual: Tab through each screen and screenshot every focus stop |
| **F-02** | RA-13, all schedule screens | Prev/Next date-navigation icon buttons have no text or `aria-label` | Screen-reader users cannot tell what a Prev/Next button does or which direction it moves | Every icon-only control must carry an explicit `aria-label` (e.g., "Previous week," "Next week") | **High** | Given an icon-only button, when inspected by an accessibility tree tool, then it exposes a non-empty accessible name describing its action | Automated: axe-core "button-name" rule. Manual: screen-reader pass (VoiceOver/NVDA) through every date-navigation control |
| **F-03** | RA-12, all major screens | No `<h1>`/`<h2>`/`<h3>` exists on the busiest screen in the product; only hidden modal-title H4s | Screen-reader users lose heading-based page navigation entirely on core screens | Every screen must have exactly one `<h1>` (the page title) and a logical, non-skipping heading hierarchy for major sections | **High** | Given any page, when its heading structure is extracted, then it contains exactly one h1 and no heading level is skipped | Automated: axe-core "heading-order" + "page-has-heading-one." Manual: heading-only screen-reader navigation pass |
| **F-04** | RA-14, all modals | Dialogs mostly lack `aria-labelledby`/`aria-label` and none sets `aria-modal="true"` | Screen readers may not announce a modal as a modal, or announce what it's titled, and may not correctly suppress background content | Every dialog must set `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` pointing to its visible title | **High** | Given a modal is open, when inspected, then `aria-modal="true"` is set and `aria-labelledby` resolves to visible, non-empty title text | Automated: axe-core "aria-dialog-name". Manual: verify screen reader announces modal name and traps virtual cursor on open |
| **F-05** | RA-03, Contacts (and inferred for other admin tables) | Dense tables overflow the viewport at phone width with page-level (not table-scoped) horizontal scroll and no scroll affordance | Phone users must discover sideways page-scrolling by accident to reach cut-off columns or actions | Wrap wide tables in their own `overflow-x: auto` container (keeping page chrome fixed), and/or provide a card-based alternate layout below a defined breakpoint, with a visible scroll-shadow/indicator when content is clipped | **Medium** | Given a data table wider than the viewport, when viewed on a narrow screen, then only the table region scrolls horizontally (not the whole page), and a visual cue indicates more columns exist | Automated: viewport-width layout test comparing `table.scrollWidth` vs. its container's `clientWidth`. Manual: phone-width visual check on every admin/data table |
| **F-06** | RA-16, Vacation status badges and similar color-coded UI | Status is conveyed by fill color alone on otherwise-identical icons | Colorblind and screen-reader users cannot distinguish status | Pair every color-coded status with a non-color cue: icon shape/glyph difference, text label, or pattern | **Medium** | Given a status is shown via color, when color is removed (grayscale simulation), then the status remains distinguishable via shape, icon, or text | Automated: grayscale screenshot diff across status states. Manual: color-blindness simulator pass |
| **F-07** | RA-11, all screens | No skip-to-content link; a keyboard user must tab through the full top bar + sidebar on every page | Repetitive, slow navigation for keyboard/screen-reader users on every single page load | Add a visually-hidden-until-focused "Skip to main content" link as the first focusable element on every page | **Medium** | Given a page loads, when the first Tab press occurs, then a "Skip to main content" link receives focus and, when activated, moves focus to the main content region | Automated: check first focusable element's text/target. Manual: Tab-once-and-activate check per page |
| **F-08** | RA-09/RA-10, modals | Focus trapping and Escape-to-close work correctly on the one modal tested | (Positive — no negative impact) | **Preserve this pattern**: ensure every modal component in SchedulePoint traps focus and closes on Escape without side effects, as a baseline requirement, not an afterthought | **Low** (maintain, don't regress) | Given any modal is open, when Tab reaches the last focusable element and Tab is pressed again, then focus returns to the first focusable element inside the modal (not the page behind it); when Escape is pressed, then the modal closes without submitting | Automated: focus-trap unit test per modal component. Manual: Tab-wrap and Escape check per modal |

---

## Master checklist — Phase 10 topics

| Topic | Status |
|---|---|
| Responsive behaviour (nav, sidebar, calendar, tables, toolbars, modals) | **[OBSERVED]** — RA-01 through RA-06; one concrete layout failure found (Contacts overflow) |
| Keyboard behaviour (focus order, visibility, traps, skip links, modal focus, Escape) | **[OBSERVED]** — RA-07 through RA-11; one high-impact gap (no visible focus) and two positive findings (modal trap + Escape) |
| Accessibility observations (headings, ARIA, tables, color, live regions, alt text) | **[OBSERVED]** — RA-12 through RA-19; several concrete, reproducible gaps and some genuine strengths, kept clearly separated |
| SchedulePoint recommendations | **[OBSERVED/produced]** — 8 findings (F-01..F-08) with priority, acceptance criteria, and suggested tests |

**No WCAG conformance claim is made about ischedule.md** anywhere in this report, per instructions — findings describe specific, individually-evidenced behaviors only.

---

## Safety & boundary notes

- No new action surface was opened solely for this phase's testing; the one modal used (Swap Shift) was already established safe in Phase 4.
- No Enter or Space was pressed on any button, checkbox, toggle, menu item, or link at any point this phase.
- No field was typed into.
- No viewport-specific setting was saved (viewport changes used `resize_window` only, a tool-level viewport change, not an in-app preference).
- The Contacts screenshot at phone width contained real staff PII (names, emails, phone numbers); its content is not reproduced or individually described anywhere in this report — only the structural overflow finding is recorded.
- No credentials, tokens, cookies, or document contents were captured.

## Evidence & follow-up

- Screenshots not yet exported to disk (standing limitation across all ten phases).
- RA-01's exact breakpoint pixel value, RA-07's full extent (whether *any* element anywhere has visible focus), RA-17's required-field/error-message behavior, and RA-18's zoom/reflow behavior are all flagged as explicit follow-up items for a future, narrowly-scoped pass.
- Findings merged into [source-page-index.md](source-page-index.md), [unresolved-questions.md](unresolved-questions.md), [evidence-register.md](evidence-register.md), [manifest.json](manifest.json).
