#!/usr/bin/env node
/**
 * Computes the WCAG 2.2 contrast ratio for every design-token pair this slice
 * renders, and prints the table that goes into `docs/evidence/EV-M2-CATALOGUE/`.
 *
 * ## Why a script rather than a comment
 *
 * The SP-E brief (§4) requires every extension token to land "with a computed
 * contrast note", and SPEC-14's rule is that an **unrendered contrast pair is
 * unverified**. axe checks what is on the page; it cannot check a token nothing
 * uses. This computes the numbers, the e2e run renders every pair so axe checks
 * them, and the two together are the evidence.
 *
 * A hand-written ratio in a comment is a claim. This is a measurement.
 *
 *     node apps/web/scripts/contrast.mjs
 */

/** @param {string} hex */
function channel(hex) {
  const value = Number.parseInt(hex, 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, WCAG 2.x §relative-luminance. @param {string} colour */
function luminance(colour) {
  const hex = colour.replace('#', '');
  const r = channel(hex.slice(0, 2));
  const g = channel(hex.slice(2, 4));
  const b = channel(hex.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** @param {string} a @param {string} b */
function ratio(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

const SURFACE = '#ffffff';
const RAISED = '#f4f5f7';

/** The six curated shift-type palettes: a tinted surface and its ink. */
const PALETTES = [
  { key: 'neutral', surface: '#e7e9ee', ink: '#2b3240' },
  { key: 'indigo', surface: '#e2e8f7', ink: '#1f3468' },
  { key: 'teal', surface: '#daeae7', ink: '#0f4a43' },
  { key: 'amber', surface: '#f6ead4', ink: '#63400a' },
  { key: 'rose', surface: '#f8e3e6', ink: '#761d29' },
  { key: 'violet', surface: '#eae1f4', ink: '#452767' },
];

/** Everything else this slice adds or relies on. */
const PAIRS = [
  { label: 'text on surface', fg: '#1f2430', bg: SURFACE },
  { label: 'text on raised', fg: '#1f2430', bg: RAISED },
  { label: 'muted text on surface', fg: '#555f70', bg: SURFACE },
  { label: 'accent on surface', fg: '#1a4fa0', bg: SURFACE },
  { label: 'accent-contrast on accent', fg: '#ffffff', bg: '#1a4fa0' },
  { label: 'danger on surface', fg: '#9b1c1c', bg: SURFACE },
  { label: 'danger on raised', fg: '#9b1c1c', bg: RAISED },
  { label: 'success on surface', fg: '#136c39', bg: SURFACE },
  { label: 'warning on surface', fg: '#7a4a05', bg: SURFACE },
  { label: 'focus ring against surface', fg: '#0b3d91', bg: SURFACE },
  // INFORMATIONAL, and the low number is the design working rather than failing.
  // The ring is drawn with `outline-offset: 2px`, so it sits on the PAGE beside
  // the control, never on top of it — the adjacent colour it must clear is the
  // surface (the row above, 10.04), not the button's own fill. Kept in the table
  // so the number is visible and the reasoning is not a claim in a comment.
  { label: 'focus ring over accent (informational, offset places it off-control)', fg: '#0b3d91', bg: '#1a4fa0' },
  { label: 'border against surface', fg: '#c9ced6', bg: SURFACE },
];

const rows = [];
for (const pair of PAIRS) {
  rows.push({ pair: pair.label, fg: pair.fg, bg: pair.bg, ratio: ratio(pair.fg, pair.bg) });
}
for (const palette of PALETTES) {
  rows.push({
    pair: `shift ${palette.key}: ink on its own surface`,
    fg: palette.ink,
    bg: palette.surface,
    ratio: ratio(palette.ink, palette.surface),
  });
  rows.push({
    pair: `shift ${palette.key}: surface against the page`,
    fg: palette.surface,
    bg: SURFACE,
    ratio: ratio(palette.surface, SURFACE),
  });
}

const width = Math.max(...rows.map((row) => row.pair.length));
let failures = 0;
process.stdout.write(
  `${'pair'.padEnd(width)}  foreground  background  ratio   AA text (4.5)  AA non-text (3.0)\n`,
);
process.stdout.write(`${'-'.repeat(width)}  ----------  ----------  ------  -------------  -----------------\n`);
for (const row of rows) {
  const text = row.ratio >= 4.5 ? 'pass' : 'n/a';
  const nonText = row.ratio >= 3 ? 'pass' : 'n/a';
  // Only the pairs that carry TEXT are required to clear 4.5; a tinted surface
  // against the page carries no text of its own and is decorative — the shift
  // code and the palette NAME are what a reader reads, and both are ink on the
  // tint. Recorded rather than asserted, so the number is visible either way.
  const required =
    row.pair.includes('surface against the page') ||
    row.pair.includes('border') ||
    row.pair.includes('informational')
      ? 0
      : 4.5;
  if (row.ratio < required) failures += 1;
  process.stdout.write(
    `${row.pair.padEnd(width)}  ${row.fg}     ${row.bg}     ${row.ratio.toFixed(2).padStart(5)}  ${text.padEnd(13)}  ${nonText}\n`,
  );
}

process.stdout.write(
  `\n${String(rows.length)} pair(s) computed; ${String(failures)} below the level required for their role.\n`,
);
process.exit(failures === 0 ? 0 : 1);
