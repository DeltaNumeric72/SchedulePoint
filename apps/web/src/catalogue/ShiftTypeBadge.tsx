import type { JSX } from 'react';

import type { ShiftType } from '@schedulepoint/contracts';

/**
 * How a shift type appears in a list — and the one place in this codebase where
 * a user-chosen colour is rendered.
 *
 * ## Colour is never the sole carrier (SPEC-14 §2, SP-E §1.5)
 *
 * The swatch is decorative. Three things carry the meaning as text:
 *
 *  * the **code** is rendered inside the swatch, in the palette's ink;
 *  * the palette's **name** is rendered beside it, visible to everyone;
 *  * the on-call / stipend / leave flags are rendered as words, never as icons
 *    or as a second colour.
 *
 * Remove the colour entirely and nothing is lost — which is the test. That is
 * also why the swatch carries no `aria-label` of its own: a decorative element
 * announcing "indigo" would make a screen-reader user hear the palette name
 * twice, once from the swatch and once from the text next to it.
 *
 * ## The class is looked up, never interpolated
 *
 * `bg-shift-${key}` would defeat Tailwind's content scanner — the class would be
 * absent from the built stylesheet and the badge would render unstyled, which is
 * the sort of failure that only shows up in the production bundle. A literal
 * lookup keyed by the closed palette set is what makes the six pairs actually
 * ship, and therefore what makes axe measure them.
 */

const PALETTE_CLASS: Readonly<Record<ShiftType['displayPaletteKey'], string>> = {
  neutral: 'bg-shift-neutral text-shift-neutral-ink',
  indigo: 'bg-shift-indigo text-shift-indigo-ink',
  teal: 'bg-shift-teal text-shift-teal-ink',
  amber: 'bg-shift-amber text-shift-amber-ink',
  rose: 'bg-shift-rose text-shift-rose-ink',
  violet: 'bg-shift-violet text-shift-violet-ink',
};

const PALETTE_LABEL: Readonly<Record<ShiftType['displayPaletteKey'], string>> = {
  neutral: 'Neutral',
  indigo: 'Indigo',
  teal: 'Teal',
  amber: 'Amber',
  rose: 'Rose',
  violet: 'Violet',
};

const TEXT_STYLE_CLASS: Readonly<Record<ShiftType['displayTextStyle'], string>> = {
  regular: '',
  bold: 'font-bold',
  italic: 'italic',
};

const TEXT_STYLE_LABEL: Readonly<Record<ShiftType['displayTextStyle'], string>> = {
  regular: 'Regular',
  bold: 'Bold',
  italic: 'Italic',
};

export function ShiftTypeBadge({ shiftType }: { shiftType: ShiftType }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-sp-2">
      <span
        className={`rounded-control px-sp-2 py-sp-1 font-mono ${PALETTE_CLASS[shiftType.displayPaletteKey]} ${TEXT_STYLE_CLASS[shiftType.displayTextStyle]}`}
        data-testid={`shift-badge-${shiftType.displayPaletteKey}`}
      >
        {shiftType.code}
      </span>
      <span className="text-sm text-text-muted">
        {PALETTE_LABEL[shiftType.displayPaletteKey]} ·{' '}
        {TEXT_STYLE_LABEL[shiftType.displayTextStyle]}
      </span>
    </span>
  );
}

/** The flags, as words. Never an icon, never a second colour. */
export function ShiftTypeFlags({ shiftType }: { shiftType: ShiftType }): JSX.Element {
  const flags = [
    shiftType.isOnCall ? 'On call' : undefined,
    shiftType.attractsStipend ? 'Stipend' : undefined,
    shiftType.isManualOnly ? 'Manual only' : undefined,
    shiftType.isDailyPick ? 'Daily pick' : undefined,
    shiftType.isLeaveOfAbsence ? 'Leave of absence' : undefined,
    shiftType.includeInStatistics ? undefined : 'Excluded from statistics',
    shiftType.allowOnRequest ? 'ON requests' : undefined,
    shiftType.allowOffRequest ? 'OFF requests' : undefined,
  ].filter((flag): flag is string => flag !== undefined);

  if (flags.length === 0) return <span className="text-text-muted">—</span>;
  return <span className="text-sm text-text">{flags.join(' · ')}</span>;
}
