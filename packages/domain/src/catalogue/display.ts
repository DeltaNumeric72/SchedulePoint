/**
 * Shift-type display metadata — the CURATED, CLOSED token sets.
 *
 * ## Why these are keys and not colours
 *
 * The observed catalogue lets an administrator choose how a shift type appears
 * in a grid. Storing that choice as a colour value would put an unbounded,
 * user-authored input directly into the rendered interface, and **no
 * accessibility gate anywhere could catch an unreadable pair**: axe runs at
 * build time over a page whose contents arrive at run time. The failure would
 * reach a night-shift scheduler before it reached a test.
 *
 * So the choice is a key from a closed set. Each key resolves in the browser to
 * a pair of design tokens (`--sp-color-shift-<key>-surface` /
 * `--sp-color-shift-<key>-ink`) whose contrast has been computed, and every one
 * of them is rendered by `apps/web/e2e/catalogue.spec.ts` so axe actually
 * measures it. SP-E brief §4: "a hard-coded colour or size in a component is a
 * review-rejectable defect" — this extends the same discipline to the colours a
 * user picks.
 *
 * ## Colour is never the only carrier
 *
 * SPEC-14 §2 (conflict indicator row): "**colour is never the sole carrier**".
 * Each key therefore has a `label` — the word a person reads and a screen reader
 * announces — and the interface renders the label, not only the swatch.
 *
 * ## The database says the same thing
 *
 * `apps/api/migrations/0005_shift_catalogue.sql` CHECK-constrains both columns to
 * these exact members, and `apps/api/test/catalogue/schema.test.ts` reads
 * `pg_constraint` and asserts the two agree. A constant and a CHECK that drift
 * are worse than either alone: the code would offer a key the database refuses,
 * and the only symptom would be a save that fails for no visible reason.
 */

export interface ShiftPaletteDefinition {
  readonly key: ShiftPaletteKey;
  /** The word rendered beside the swatch and announced by a screen reader. */
  readonly label: string;
}

export const SHIFT_PALETTE_KEYS = [
  'neutral',
  'indigo',
  'teal',
  'amber',
  'rose',
  'violet',
] as const;

export type ShiftPaletteKey = (typeof SHIFT_PALETTE_KEYS)[number];

export const SHIFT_PALETTES: readonly ShiftPaletteDefinition[] = [
  { key: 'neutral', label: 'Neutral' },
  { key: 'indigo', label: 'Indigo' },
  { key: 'teal', label: 'Teal' },
  { key: 'amber', label: 'Amber' },
  { key: 'rose', label: 'Rose' },
  { key: 'violet', label: 'Violet' },
];

export const SHIFT_TEXT_STYLES = ['regular', 'bold', 'italic'] as const;
export type ShiftTextStyle = (typeof SHIFT_TEXT_STYLES)[number];

export interface ShiftTextStyleDefinition {
  readonly key: ShiftTextStyle;
  readonly label: string;
}

export const SHIFT_TEXT_STYLE_DEFINITIONS: readonly ShiftTextStyleDefinition[] = [
  { key: 'regular', label: 'Regular' },
  { key: 'bold', label: 'Bold' },
  { key: 'italic', label: 'Italic' },
];

export function isShiftPaletteKey(value: string): value is ShiftPaletteKey {
  return (SHIFT_PALETTE_KEYS as readonly string[]).includes(value);
}

export function isShiftTextStyle(value: string): value is ShiftTextStyle {
  return (SHIFT_TEXT_STYLES as readonly string[]).includes(value);
}

/** The human-readable label for a palette key, for interfaces and for tests. */
export function shiftPaletteLabel(key: ShiftPaletteKey): string {
  return SHIFT_PALETTES.find((palette) => palette.key === key)?.label ?? key;
}
