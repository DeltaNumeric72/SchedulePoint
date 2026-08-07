# Consolidated real-browser evidence for the M3 exit

**OPUS-M3-008, packet 32 §10f deliverable 13** — *"consolidated real-browser
evidence for the M3 exit: screenshots across authoring/publication/staff views at
desktop/mobile/320px/keyboard/loading/empty/error/denial states (gather from the
per-packet bundles + fresh captures where composition changed things)."*

## What is HERE, and what is deliberately not

**Here: only the captures composition actually changed.** Six files, three
surfaces, both viewports.

**Not here: 174 other PNGs.** They exist, they were re-captured from a coherent
run during this packet's acceptance, and they are byte-for-byte what the
per-packet bundles already hold — because the pages did not change. Copying 95 MB
of unchanged images into a second directory would make the exit bundle larger and
no more true. The per-packet bundles are the evidence; this directory is the
delta plus the map below.

## The map — every M3 surface, its states, and which bundle holds them

| Surface | Bundle | States captured |
|---|---|---|
| Sign-in, MFA, activation, reset | `EV-M3-AUTHN/screenshots/` | populated · validation · error · keyboard, both viewports |
| Shift-type / group catalogue | `EV-M2-CATALOGUE/screenshots/` | loading · empty · populated · validation · permission-denied · error · 320px |
| Rule authoring | `EV-M3-RULES/screenshots/` | loading · empty · populated · form · validation · denied · not-found |
| **Scheduler authoring grid** | `EV-M3-AUTHORING-UX/screenshots/` | grid · accessible alternative · cell editor · conflicts · denial · 320px · keyboard |
| **Publication review and history** | `EV-M3-PUBLICATION-UX/screenshots/` | review · difference · confirm · published · replay · CAS-moved · stale-review · publish-denied · publish-failed · blocked · history · comparison · 320px · keyboard |
| **Staff views** | `EV-M3-STAFF-VIEWS/screenshots/` | personal calendar · tabular alternative · daily sheet · overnight · empty · error · denial · 320px · mobile |
| Group settings and locations | `EV-M3-SETTINGS/screenshots/` | populated · form · validation · denial · 320px |

Every one of those was captured by the real Chromium at both standing viewports
with axe asserted green on the same page, in `pnpm check`'s `axe` gate.

## The three deltas in this directory

| Capture | What changed, and why it is worth a picture |
|---|---|
| `published-schedule.*` | The published-schedule page now carries **two** tables. `Publication records` keeps its M3-005 labelling ("the publication module's own records … not the audit chain"); `Audit chain` is new, reads the real chain through the OPUS-M3-008 audit-read API, and states that its sequence numbers have gaps because the read is group-scoped and the sequence is organization-wide. Two surfaces that answer different questions, each saying which one it is |
| `published-audit-denied.*` | The same page with the audit read **denied**. `audit.read` is grant-only and held by no role, so this is the ordinary state for a scheduler nobody has granted it to. It renders a stated panel — not an error — and everything else on the page still loads. A red error box here would teach a scheduler that the page is broken |
| `review-blocked-hard-rule.*` | SPEC-05 §6 step 06 on the review branch: a breached HARD rule and an unevaluable one, each naming its `rule_key` on its own line. The second reads *"cannot be checked by this system … A HARD rule is never skipped, so publication is blocked"* — which is the sentence that keeps "we could not check it" from ever looking like "it passed" |

All three are synthetic. No real staff, patient, or customer data exists in any
capture in this repository.
