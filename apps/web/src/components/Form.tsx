import { useId, useRef, type JSX, type ReactNode } from 'react';

/**
 * The form foundation every catalogue surface uses, and every later one will.
 *
 * ## What the SP-E brief §3 requires, and where each part lives
 *
 * > **Forms:** label + `aria-describedby` help; on submit failure focus moves to
 * > a `role="alert"` validation summary that links to fields; errors announced
 * > once, not per keystroke; server errors render the typed error envelope's
 * > message.
 *
 * | Requirement | Here |
 * |---|---|
 * | label + `aria-describedby` | `Field` wires both from one `useId` |
 * | `role="alert"` summary linking to fields | `ValidationSummary`, whose links are `#<fieldId>` |
 * | focus moves to the summary on failure | `ValidationSummary` takes focus in a layout effect when it appears |
 * | announced once, not per keystroke | validation runs on SUBMIT only. There is no `onChange` validation anywhere in this slice, deliberately |
 *
 * ## Why validation is submit-only
 *
 * Per-keystroke validation re-announces on every character to a screen-reader
 * user, which SPEC-14 AC-11 names directly ("error count announced **once**").
 * It is also the pattern that turns a half-typed value into an error message
 * about a value nobody has finished entering. The server's `422` and the
 * client's pre-check produce the same shape, so the summary looks identical
 * whichever found the problem.
 */

export interface FieldProblem {
  readonly field: string;
  readonly message: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Validation summary
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ValidationSummaryProps {
  readonly problems: readonly FieldProblem[];
  /** Maps a contract field name to the DOM id of its control. */
  readonly fieldIds: Readonly<Record<string, string>>;
  /** Identifies the form, so two forms on one page have distinct summaries. */
  readonly formName: string;
}

export function ValidationSummary({
  problems,
  fieldIds,
  formName,
}: ValidationSummaryProps): JSX.Element | null {
  /**
   * Focus moves to the summary when it APPEARS, and not on every re-render.
   *
   * A callback ref rather than an effect, and the distinction is behavioural: an
   * effect keyed on `problems` fires again whenever the array identity changes,
   * which would drag focus back out of the field the user had just started
   * fixing. A callback ref fires when the node is attached — i.e. when the
   * summary was not there and now is, which is exactly the moment SPEC-14 AC-11
   * describes.
   */
  const focused = useRef(false);
  const takeFocus = (node: HTMLDivElement | null): void => {
    if (node === null) {
      focused.current = false;
      return;
    }
    if (focused.current) return;
    focused.current = true;
    node.focus();
  };

  if (problems.length === 0) return null;

  return (
    <div
      ref={takeFocus}
      // `role="alert"` is announced when it appears; `tabIndex={-1}` makes it
      // focusable programmatically without adding it to the tab order.
      role="alert"
      tabIndex={-1}
      className="rounded-panel border border-danger bg-surface-raised p-sp-4"
      data-testid={`validation-summary-${formName}`}
    >
      <h3 className="font-semibold text-danger">
        {problems.length === 1
          ? 'There is 1 problem with this form'
          : `There are ${String(problems.length)} problems with this form`}
      </h3>
      <ul className="mt-sp-2 list-disc pl-sp-5">
        {problems.map((problem) => {
          const target = fieldIds[problem.field];
          return (
            <li key={`${problem.field}:${problem.message}`} className="text-text">
              {target === undefined ? (
                problem.message
              ) : (
                <a className="text-accent underline" href={`#${target}`}>
                  {problem.message}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Field
 * ──────────────────────────────────────────────────────────────────────────── */

export interface FieldProps {
  readonly id: string;
  readonly label: string;
  /** Rendered under the control and referenced by `aria-describedby`. */
  readonly help?: string;
  readonly problem?: string | undefined;
  readonly children: (attributes: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
  }) => ReactNode;
}

export function Field({ id, label, help, problem, children }: FieldProps): JSX.Element {
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const described = [help === undefined ? undefined : helpId, problem === undefined ? undefined : errorId]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div className="flex flex-col gap-sp-1">
      <label className="font-medium text-text" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': described.length === 0 ? undefined : described,
        'aria-invalid': problem === undefined ? undefined : true,
      })}
      {help === undefined ? null : (
        <p className="text-sm text-text-muted" id={helpId}>
          {help}
        </p>
      )}
      {problem === undefined ? null : (
        // NOT a live region: the summary above already announced it once. A
        // second live region here would announce every problem twice.
        <p className="text-sm text-danger" id={errorId}>
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * A stable id per field name, so the summary's links resolve.
 *
 * `useId()` returns something like `:r0:`, and a COLON in an id makes
 * `href="#:r0:-code"` unusable as a CSS selector — `document.querySelector` and
 * every testing tool reject it without escaping, even though the browser's own
 * fragment navigation copes. Stripping the colons costs nothing and keeps the
 * summary's links addressable by ordinary means.
 */
export function useFieldIds<T extends string>(
  formName: string,
  fields: readonly T[],
): Readonly<Record<T, string>> {
  const base = useId().replaceAll(':', '');
  const entries = fields.map((field) => [field, `${base}-${formName}-${field}`] as const);
  return Object.fromEntries(entries) as Record<T, string>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Controls
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every interactive control is at least `--sp-size-target` (44px) in both
 * directions, expressed as a token rather than as a number so SPEC-14's matrix
 * can cite it (SP-HR-4, AC-09).
 */
export const CONTROL_CLASS =
  'min-h-target rounded-control border border-border bg-surface px-sp-3 py-sp-2 text-text';

export const PRIMARY_BUTTON_CLASS =
  'min-h-target min-w-target rounded-control bg-accent px-sp-4 py-sp-2 font-medium text-accent-contrast';

export const SECONDARY_BUTTON_CLASS =
  'min-h-target min-w-target rounded-control border border-border bg-surface px-sp-4 py-sp-2 font-medium text-text';
