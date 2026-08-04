# SPEC-14 component-matrix rows — the catalogue surfaces

**OPUS-M2-002.** New rows for every component this slice introduces, in
SPEC-14 §2's format, with the evidence for each cell.

`A` = automatable (axe-core or a scripted assertion). `M` = **manual evidence
required**. **A cell marked `M` with no retained evidence is NOT a support
claim** — SPEC-14 §1: "A combination without retained manual evidence is not
claimed as supported."

**This file lives in the evidence bundle rather than in
`docs/architecture/specs/SPEC-14-…md`**, because `docs/architecture/**` is a
prohibited path for this packet. It is written in the spec's own format so it can
be merged into §2 by the orchestrator in one move.

---

## New rows

| Component | Semantics | Keyboard | Focus | Announcement | Contrast / forced colors | Touch | Reflow | Motion |
|---|---|---|---|---|---|---|---|---|
| **Catalogue list (table)** | `A` real table semantics, `<caption>`, `scope` on every header | `A` reachable | `A` visible focus ≥3:1 | `M` row context announced without reading the whole table | `A` axe, both viewports | `A` ≥44px | **`A` list alternative below 640px, asserted** | — |
| **Catalogue list (list alternative)** | `A` `<ul>` of `<dl>` pairs, one per row | `A` | `A` | `M` term/value pairing announced | `A` | `A` | `A` no page-level horizontal scroll at 320px | — |
| **Shift-type badge** | `A` code + palette name as text | — | — | `M` palette name read once, not twice (the swatch is decorative and carries no label of its own) | **`A` colour is never the sole carrier**; six pairs, 7.78:1–10.59:1 computed and rendered | — | `A` | — |
| **Catalogue form** | `A` labels, `aria-describedby`, `<fieldset>`/`<legend>` for flag groups, **`h2` under the page `h1` — no skipped level** | `A` completable keyboard-only | **`A` focus to the error summary on submit failure** | `M` error count announced once, not per keystroke | `A` | `A` ≥44px incl. checkbox ROWS | `A` single column below 640px | — |
| **Validation summary** | `A` `role="alert"`, links to fields | `A` | `A` receives focus when it appears (callback ref, not an effect) | `A` count in the heading; `M` announced once | `A` | `A` | `A` | — |
| **Surface state — loading** | `A` `role="status"` `aria-live="polite"` | — | `A` no focus steal | `M` polite | `A` | — | `A` | — |
| **Surface state — empty** | `A` ordinary prose, no live region | — | — | — (not an event) | `A` | — | `A` | — |
| **Surface state — error** | `A` `role="alert"` | `A` | `A` no focus steal | `M` announced once | `A` | — | `A` | — |
| **Surface state — permission denied** | `A` `role="alert"`, distinct copy from "not found" | `A` | `A` | `M` announced once | `A` | — | `A` | — |
| **New / Add control (I-13)** | `A` accessible name, `aria-expanded` | `A` | `A` | **`A` nothing persists before Save — request count around the click is zero** | `A` | `A` ≥44×44 | `A` | — |
| **Irreversible-action notice** (pick positions) | `A` prose beside the control, before the action | `A` | `A` | `M` read in document order before the input | `A` warning token 7.48:1, and the sentence reads the same without the colour | `A` | `A` | — |

---

## Evidence per cell

| Kind | Where |
|---|---|
| **Automated (axe-core)** | `axe-output.txt` — 36 tests, 30 of them catalogue, at **1280×800 and 390×844**, plus a 320×720 pass. Zero violations, **including the `best-practice` rule set**. The run asserts `heading-order` was actually selected, so a mis-spelled tag cannot buy a weaker check behind a stronger-looking claim. Build fails otherwise |
| **Computed contrast** | `contrast.txt` — 24 pairs, produced by `apps/web/scripts/contrast.mjs`. Every pair that carries text clears AA; the two that do not carry text are labelled and their numbers are shown rather than hidden |
| **Rendered contrast** | `screenshots/shift-types-populated.{desktop,mobile}.png` — all six palettes on one page, which is what turns the computed numbers into measured ones |
| **Keyboard** | `axe-output.txt` test "AC-02: the form is completable by keyboard alone" — tabs from the top of the document to the New control, opens it with Enter, fills by label association, submits with Enter, and asserts the request body |
| **Focus on failure** | test "AC-11: an empty form is refused by the CLIENT" — asserts `toBeFocused()` on the summary and that each entry links to a control that exists |
| **Reflow** | test "AC-08 and AC-09" — measured **behaviourally**: the page is asked to scroll sideways and `window.scrollX` must stay 0. `screenshots/shift-types-320px.*` |
| **Touch targets** | the same test — every button/link/input's row measured, plus the skip link measured while focused |
| **I-13** | test "I-13: opening the New form persists NOTHING" — request count around the click is asserted to be exactly `[]` |
| **States** | `screenshots/` — 12 states × 2 viewports = 24 files |

## What the independent review changed here

The first version of these rows claimed zero axe violations while the run
selected only the WCAG tags. `heading-order` is a `best-practice` rule, and
every authoring form went `h1` → `h3` — a screen-reader user navigating by
heading level would have been told the form sat inside a section that does not
exist. The headings are `h2` now, the tag is included, and the tag's presence is
asserted rather than assumed.

## Cells that are `M` and therefore NOT yet claimed

Every `M` cell above is **unclaimed**. SPEC-14 §1's five supported combinations
(NVDA+Firefox, JAWS+Chrome, VoiceOver+Safari macOS/iOS, TalkBack+Chrome) each
require a **recorded screen-reader session**, and no such session has been run
for these components. `G-BETA`/`G-PROD` remain not passed for CAP-066, exactly
as SPEC-14 §6 says.

What this slice does claim, because it has evidence:

* zero axe violations on every state at both viewports and at 320px;
* keyboard completability of the authoring journey;
* focus behaviour on submit failure;
* target sizes;
* no page-level horizontal scroll at 320px;
* computed **and rendered** contrast for every token pair introduced.
