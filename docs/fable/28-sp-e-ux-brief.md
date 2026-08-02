# 28 — SP-E UX Brief and Design-Token Specification

**Status:** orchestrator-authored M1-entry deliverable (the carried item from [25-m0-exit-report.md](25-m0-exit-report.md) §9). Written 2026-08-02, during OPUS-M1-001 execution. **It blocks the first UI-bearing slice, not the M1 kernel packets** (which have no UI). This brief governs every UI-bearing Opus task until superseded; it changes no code — the scaffold's `apps/web/src/styles/tokens.css` remains the single source of visual truth, and extensions to it land with the first task that renders them (SPEC-14's rule: an unrendered contrast pair is unverified).

## 1. Principles (derived from the invariant register and SPEC-14, not from taste)

1. **Nothing persists before Save** (I-13, from a real incident). No control labelled Add/New/Create may write anything on click; the announced state must match reality (SPEC-14 row 12). Optimistic UI is prohibited on creation paths.
2. **One user action, one request** (I-10). No keystroke-triggered fetch storms; search inputs debounce to a single request; the request-budget gate (SP-HR-2) is the enforcement, this brief is the design posture.
3. **The interface never lies about authority.** What a user cannot do is absent or disabled-with-reason, but the server verdict is the truth (I-19); a 404-for-existence-privacy is presented as "not found", never as "no access" (SPEC-01 T-05b discipline).
4. **Stale context is a first-class state** (SPEC-01 `409 CONTEXT_STALE`): the shell surfaces a single, consistent "your context changed — reload" interruption, never a silent retry.
5. **Accessibility is acceptance, not polish** (I-12, SP-HR-3..6, CAP-066). WCAG 2.2 AA; every interactive target ≥44px (`--sp-size-target`); no colour as sole carrier; reduced-motion honoured; 320px reflow with list alternatives for grids. SPEC-14's component matrix is the per-component contract; its `M` cells require retained manual evidence before a support claim.
6. **Dense, calm, professional.** Scheduling is a high-information task performed daily by tired people: prefer tables to cards, text to iconography, one accent colour, no decorative motion.

## 2. Information architecture (M1 → M3 surfaces)

- **Shell** (exists): top-level identity + organization/group context switcher (the SPEC-01 declared-context control — switching context is explicit, visible, and per SPEC-01 §3 never inferred), main navigation, notification banner region (`role="status"`).
- **M1 surfaces** (first UI-bearing tasks, not in the current three packets): sign-in + MFA; invitation/activation; organization/group admin (create/rename — behind explicit Save per I-13); memberships + role assignment (effective-dated grants shown with their date ranges); audit query (filterable table, SPEC-14 report-table row).
- **M2**: catalogue authoring (shift types, groups, profiles, qualifications, rules) — form-heavy, validation-summary pattern throughout.
- **M3**: the schedule grid — SPEC-14's most demanding rows; the tabular partial-view alternative ships in the same task as the grid, not later.

## 3. Interaction contracts (binding on UI-bearing packets)

- **Forms:** label + `aria-describedby` help; on submit failure focus moves to a `role="alert"` validation summary that links to fields; errors announced once, not per keystroke; server errors render the typed error envelope's message — the fixed 5xx text is shown verbatim, never expanded.
- **Destructive actions:** typed-confirmation only for irreversible ones; everything else undoes by compensating action (publication supersedes forward, I-18 — the UI never offers "edit published").
- **Live updates:** server-authoritative (PO-DEC-18); focus preserved across list updates; announcements throttled per SPEC-14 §3; countdowns announce at 50/25/10% only.
- **Tables:** real table semantics, sortable headers announced, row/column headers for grids; virtualization must not break AT row navigation (M evidence required).

## 4. Design tokens

- **Naming:** `--sp-<category>-<name>[-<variant>]` (`color`, `radius`, `size`, `font`, `space`, `text`). Components consume tokens only (directly or via the Tailwind aliases); a hard-coded colour or size in a component is a review-rejectable defect.
- **Existing baseline** (`tokens.css`, verified by axe in CI): surface/raised/border neutrals, text + muted (≥6.6:1), accent `#1a4fa0` (8.3:1 both directions), danger `#9b1c1c`, radii, `--sp-size-target: 2.75rem`, system font stack.
- **Extensions reserved** (land with the first task that renders them, each with a computed contrast note): `--sp-space-1..8` (0.25rem × {1,2,3,4,6,8,12,16}); `--sp-text-sm/base/lg/xl` (0.875/1/1.125/1.375rem, line-height ≥1.5 body); semantic states `--sp-color-success` and `--sp-color-warning` (paired with text/icon, never colour-alone per SPEC-14); focus ring `--sp-color-focus` (≥3:1 against adjacent colours, 2px offset outline).
- **Colour schemes:** alpha ships **light-only**; the token architecture (all colour through custom properties) keeps a dark scheme reachable without component changes. Forced-colors mode is supported now: components must not disable it, and borders (not shadows) carry boundaries.
- **Motion:** durations ≤200ms, opacity/transform only, every animation gated on `prefers-reduced-motion`.

## 5. Out of scope for this brief

Visual mockups (deliberately none — components derive from Radix primitives + tokens); copy/terminology (the glossary, report 12, is the authority); the picklist turn panel's full interaction spec (SPEC-02 + SPEC-14 §3 own it; the UI task for it gets a dedicated brief addendum).
