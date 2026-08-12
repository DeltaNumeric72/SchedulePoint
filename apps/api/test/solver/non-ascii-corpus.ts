/**
 * The non-ASCII corpus — the regression guard for the canonicalisation defect.
 *
 * The solver RPC's MAC once covered a *re-derivation* of the message rather than
 * the bytes on the wire: the platform signed `canonicalStringify(...)` (raw
 * UTF-8) and the worker re-derived `json.dumps(..., ensure_ascii=True)`
 * (`\uXXXX` escapes). Identical for ASCII, different for everything else — so
 * every test passed and a period named "Février 2029" failed to authenticate
 * through the real production path, every time.
 *
 * Period names, location names, shift-type codes and rule AST text all travel in
 * the signed snapshot and none of them is restricted to ASCII. These cases are
 * chosen to cover the distinct ways an encoding can go wrong rather than to be a
 * list of languages:
 *
 *  - **accented Latin** — the ordinary European case, and the one the reviewer
 *    measured;
 *  - **CJK** — three-byte UTF-8, well outside anything Latin-1 could carry;
 *  - **en-dash / NBSP** — punctuation and whitespace that survive a copy-paste
 *    from a document and are invisible in a diff;
 *  - **emoji (astral)** — above the BMP, a surrogate PAIR in UTF-16. This is the
 *    case that `ensure_ascii=False` alone would NOT have fixed, because the two
 *    runtimes also sort object keys differently up there;
 *  - **RTL** — bidirectional text, which some sanitisers mangle.
 */
export const NON_ASCII_CASES: readonly { readonly label: string; readonly text: string }[] = [
  { label: 'accented Latin', text: 'Février 2029 — Périodes' },
  { label: 'CJK', text: '二月排班表' },
  { label: 'en-dash and NBSP', text: 'Feb\u00a02029\u2013Mar' },
  { label: 'astral (emoji, surrogate pair)', text: 'Night shift \u{1f319}' },
  { label: 'RTL', text: 'תורנות לילה' },
  { label: 'mixed', text: 'Ward\u00a0Ω — 病棟 \u{1f319}' },
];
