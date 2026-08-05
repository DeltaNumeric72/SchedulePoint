import {
  FAIRNESS_METRIC_VALUES,
  FAIRNESS_NORMALISATION_VALUES,
  LOCUM_RESTRICTION_VALUES,
  PREFERENCE_STRENGTH_VALUES,
  RULE_WEEKDAY_VALUES,
  type RuleNodeWire,
} from '@schedulepoint/contracts';
import type { JSX } from 'react';

import { CONTROL_CLASS, Field, SECONDARY_BUTTON_CLASS } from '../components/Form.js';

/**
 * A parameter editor for every one of the thirty AST node kinds (OPUS-M3-004).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What this closes
 *
 * OPUS-M3-002 shipped the typed rule model and three editors — the nodes whose
 * only parameter is one number — and said so on the page rather than leaving it
 * to be discovered. The remaining **twenty-seven** land here, so every kind the
 * AST can express is authorable end to end through the interface.
 *
 * ## The closed set is still closed, and it is closed in more places now
 *
 * SPEC-04 §3.1: the interface has no affordance for a rule the AST cannot
 * express. That was already true of the node KIND — a `<select>` of exactly
 * thirty. It is now true of the parameters too: every enumerated parameter
 * (weekday, preference strength, fairness metric, normalisation, locum
 * restriction) is a `<select>` or a checkbox set over the contract's own
 * constant, imported rather than retyped. A value outside the enum cannot be
 * entered, so the server's rejection of one is a backstop rather than the only
 * control.
 *
 * `RULE_WEEKDAY_VALUES` and friends come from `@schedulepoint/contracts`, which
 * `apps/api/test/rules/contract-parity.test.ts` already asserts equal to
 * `@schedulepoint/domain`. So these controls cannot drift from the compiler's
 * vocabulary without a failing test.
 *
 * ## Entity references are identifiers, and the shift type is a picker
 *
 * A node that names a shift type gets a `<select>` over the group's catalogue
 * codes. Two consequences worth stating:
 *
 *  - authoring cannot invent a code that does not exist, which is the common
 *    error the server would otherwise have to catch;
 *  - **editing preserves an unknown code.** A rule may legitimately reference a
 *    code that has since been retired, and a picker that silently dropped it
 *    would rewrite the rule on open — the value is added as an option when it is
 *    not in the catalogue, so a round trip through the form is lossless.
 *
 * The other reference fields (qualification key, staff group, valid-group,
 * template, request type, assignment identity) stay text inputs with their
 * vocabulary named in the help. Their key spaces belong to surfaces that are not
 * all built yet, and a picker over a list this page cannot fetch would be a
 * guess about what the identifier means.
 *
 * ## Nothing here is a rule evaluation
 *
 * This file authors rule CONTENT. It does not run a rule, score a draft or
 * predict an outcome — the compiled HARD-rule check against version content
 * happens at publication (M3-008's step 06), and this surface makes no claim it
 * has happened.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type RuleNodeKind = RuleNodeWire['kind'];

/** One authored segment of a `PatternRule`. */
export interface SegmentState {
  readonly offsetDays: string;
  readonly shiftType: string;
}

/** The form's working value for one node. Strings until Save, deliberately. */
export type NodeFormState = Record<string, string | string[] | SegmentState[]>;

interface EnumOption {
  readonly value: string;
  readonly label: string;
}

type FieldSpec =
  | { kind: 'int'; name: string; label: string; help?: string }
  | { kind: 'decimal'; name: string; label: string; help?: string }
  | { kind: 'text'; name: string; label: string; help?: string }
  | { kind: 'shiftType'; name: string; label: string; help?: string }
  | { kind: 'date'; name: string; label: string; help?: string }
  | { kind: 'enum'; name: string; label: string; options: readonly EnumOption[]; help?: string }
  | { kind: 'intList'; name: string; label: string; help?: string }
  | { kind: 'shiftTypeList'; name: string; label: string; help?: string }
  | { kind: 'weekdaySet'; name: string; label: string; help?: string }
  | { kind: 'segments'; name: string; label: string; help?: string }
  /** A parameter the AST fixes. Rendered read-only so the rule stays honest. */
  | { kind: 'fixed'; name: string; label: string; value: string; help?: string };

export interface NodeSpec {
  readonly label: string;
  readonly description: string;
  readonly fields: readonly FieldSpec[];
}

function options(values: readonly string[]): EnumOption[] {
  return values.map((value) => ({ value, label: value.replaceAll('_', ' ') }));
}

/**
 * Every node kind, its human label, and the parameters it takes.
 *
 * The order matches the contract's discriminated union, so a reader can put the
 * two side by side. A kind added to the AST with no entry here fails
 * `apps/web/test/node-editors.test.ts`, which asserts the two sets are equal —
 * the same discipline the rule-node-mapping gate applies to the compiler.
 */
export const NODE_SPECS: Readonly<Record<RuleNodeKind, NodeSpec>> = {
  RequiredCount: {
    label: 'Required count',
    description: 'How many people this shift needs.',
    fields: [{ kind: 'int', name: 'count', label: 'Number of staff' }],
  },
  MinCoverage: {
    label: 'Minimum coverage',
    description: 'Never fewer than this many people.',
    fields: [{ kind: 'int', name: 'min', label: 'Minimum number of staff' }],
  },
  MaxCoverage: {
    label: 'Maximum coverage',
    description: 'Never more than this many people.',
    fields: [{ kind: 'int', name: 'max', label: 'Maximum number of staff' }],
  },
  RequiresQualification: {
    label: 'Requires a qualification',
    description: 'Only people holding a credential may be assigned.',
    fields: [
      {
        kind: 'text',
        name: 'qualification',
        label: 'Qualification key',
        help: 'The key from the group’s qualification vocabulary.',
      },
      {
        kind: 'fixed',
        name: 'validAt',
        label: 'Credential must be valid',
        value: 'shift_date',
        help: 'The AST offers exactly one answer: the credential must be in force on the shift date.',
      },
    ],
  },
  MemberOfStaffGroup: {
    label: 'Member of a staff group',
    description: 'Only people in a named staff group may be assigned.',
    fields: [{ kind: 'text', name: 'staffGroup', label: 'Staff group key' }],
  },
  ValidGroupRestriction: {
    label: 'Valid-combination restriction',
    description: 'Restrict to a named valid combination.',
    fields: [{ kind: 'text', name: 'validGroup', label: 'Valid-combination key' }],
  },
  PickPositionRestriction: {
    label: 'Pick-position restriction',
    description: 'Only these pick positions may take this shift.',
    fields: [
      {
        kind: 'intList',
        name: 'allowedPickPositions',
        label: 'Allowed pick positions',
        help: 'Whole numbers, separated by commas. At least one.',
      },
    ],
  },
  MaxAssignmentsInWindow: {
    label: 'Maximum assignments in a window',
    description: 'A ceiling on assignments inside a rolling window of days.',
    fields: [
      { kind: 'int', name: 'max', label: 'Maximum assignments' },
      { kind: 'int', name: 'windowDays', label: 'Window length in days' },
    ],
  },
  WeekdayFteLimit: {
    label: 'Weekday FTE limit',
    description: 'A per-weekday share of a full-time equivalent.',
    fields: [
      { kind: 'enum', name: 'weekday', label: 'Day', options: options(RULE_WEEKDAY_VALUES) },
      {
        kind: 'decimal',
        name: 'fteFraction',
        label: 'FTE fraction',
        help: 'Between 0 and 1.',
      },
    ],
  },
  WorkPercentageTarget: {
    label: 'Work-percentage target',
    description: 'A target share of available work.',
    fields: [
      {
        kind: 'decimal',
        name: 'targetPercentage',
        label: 'Target percentage',
        help: 'Greater than 0 and at most 100.',
      },
    ],
  },
  MaxConsecutive: {
    label: 'Maximum consecutive days',
    description: 'No more than this many days in a row.',
    fields: [{ kind: 'int', name: 'maxDays', label: 'Consecutive days' }],
  },
  MinimumRestBetween: {
    label: 'Minimum rest between shifts',
    description: 'A floor on the gap between two assignments.',
    fields: [{ kind: 'int', name: 'minHours', label: 'Rest hours' }],
  },
  CallSpacing: {
    label: 'Call spacing',
    description: 'A minimum gap between on-call assignments.',
    fields: [{ kind: 'int', name: 'minDaysBetweenCalls', label: 'Days between calls' }],
  },
  NoAdjacent: {
    label: 'No adjacent shift types',
    description: 'Two shift types may not be worked back to back.',
    fields: [
      { kind: 'shiftType', name: 'shiftTypeA', label: 'First shift type' },
      { kind: 'shiftType', name: 'shiftTypeB', label: 'Second shift type' },
    ],
  },
  ForbiddenSequence: {
    label: 'Forbidden sequence',
    description: 'A run of shift types that may never occur in order.',
    fields: [
      {
        kind: 'shiftTypeList',
        name: 'sequence',
        label: 'Sequence',
        help: 'In order. At least two.',
      },
    ],
  },
  PatternRule: {
    label: 'Pattern',
    description: 'A trigger shift on named days pulls a fixed pattern of shifts with it.',
    fields: [
      { kind: 'shiftType', name: 'trigger', label: 'Trigger shift type' },
      {
        kind: 'weekdaySet',
        name: 'daysOfWeek',
        label: 'Days the trigger applies on',
        help: 'At least one.',
      },
      {
        kind: 'segments',
        name: 'segments',
        label: 'Pattern segments',
        help: 'Each segment is an offset in days from the trigger and the shift type at that offset.',
      },
    ],
  },
  AlternatingWeek: {
    label: 'Alternating week',
    description: 'A shift type recurring on a fixed week cycle.',
    fields: [
      { kind: 'shiftType', name: 'onShiftType', label: 'Shift type' },
      { kind: 'int', name: 'cycleWeeks', label: 'Cycle length in weeks' },
    ],
  },
  TemplateAdherence: {
    label: 'Template adherence',
    description: 'Follow a named rotation template on a fixed cycle.',
    fields: [
      { kind: 'text', name: 'template', label: 'Template key' },
      { kind: 'int', name: 'cycleWeeks', label: 'Cycle length in weeks' },
    ],
  },
  LinkedShifts: {
    label: 'Linked shifts',
    description: 'Shift types that must be assigned together.',
    fields: [
      { kind: 'shiftTypeList', name: 'shiftTypes', label: 'Shift types', help: 'At least two.' },
    ],
  },
  ImpliesAssignment: {
    label: 'One shift implies another',
    description: 'Taking the first shift type requires the second.',
    fields: [
      { kind: 'shiftType', name: 'ifShiftType', label: 'If assigned' },
      { kind: 'shiftType', name: 'thenShiftType', label: 'Then also assigned' },
    ],
  },
  MutuallyExclusive: {
    label: 'Mutually exclusive shifts',
    description: 'Shift types that may never be held at once.',
    fields: [
      { kind: 'shiftTypeList', name: 'shiftTypes', label: 'Shift types', help: 'At least two.' },
    ],
  },
  RequestHonoured: {
    label: 'Request honoured',
    description: 'An accepted request of a named type should be respected.',
    fields: [{ kind: 'text', name: 'requestType', label: 'Request type key' }],
  },
  ShiftPreference: {
    label: 'Shift preference',
    description: 'A weighted preference for or against a shift type.',
    fields: [
      { kind: 'shiftType', name: 'shiftType', label: 'Shift type' },
      {
        kind: 'enum',
        name: 'strength',
        label: 'Strength',
        options: options(PREFERENCE_STRENGTH_VALUES),
      },
    ],
  },
  AvoidDate: {
    label: 'Avoid a date',
    description: 'A single date to keep clear.',
    fields: [{ kind: 'date', name: 'date', label: 'Date', help: 'YYYY-MM-DD.' }],
  },
  FairnessBalance: {
    label: 'Fairness balance',
    description: 'Balance a workload measure across people.',
    fields: [
      { kind: 'enum', name: 'metric', label: 'Measure', options: options(FAIRNESS_METRIC_VALUES) },
      {
        kind: 'enum',
        name: 'normalisation',
        label: 'Normalisation',
        options: options(FAIRNESS_NORMALISATION_VALUES),
      },
    ],
  },
  CreditDistribution: {
    label: 'Credit distribution',
    description: 'Distribute credit by a named measure.',
    fields: [
      { kind: 'enum', name: 'metric', label: 'Measure', options: options(FAIRNESS_METRIC_VALUES) },
    ],
  },
  StaffOverLocumPriority: {
    label: 'Staff before locum',
    description: 'Prefer permanent staff over locums inside a window.',
    fields: [{ kind: 'int', name: 'windowDays', label: 'Window length in days' }],
  },
  LocumRestriction: {
    label: 'Locum restriction',
    description: 'How locums may be used for this scope.',
    fields: [
      {
        kind: 'enum',
        name: 'restriction',
        label: 'Restriction',
        options: options(LOCUM_RESTRICTION_VALUES),
      },
    ],
  },
  FixedAssignment: {
    label: 'Fixed assignment',
    description: 'An assignment identity that must not be moved.',
    fields: [
      {
        kind: 'text',
        name: 'assignmentIdentity',
        label: 'Assignment identity',
        help: 'The stable identity of the assignment being fixed.',
      },
    ],
  },
  ProtectedRange: {
    label: 'Protected range',
    description: 'A date range to keep clear.',
    fields: [
      { kind: 'date', name: 'from', label: 'From', help: 'YYYY-MM-DD.' },
      { kind: 'date', name: 'to', label: 'To', help: 'YYYY-MM-DD.' },
    ],
  },
};

export const NODE_KINDS = Object.keys(NODE_SPECS) as RuleNodeKind[];

/* ────────────────────────────────────────────────────────────────────────────
 * Form state ⇆ predicate
 * ──────────────────────────────────────────────────────────────────────────── */

/** The state a freshly chosen kind starts in. Every field present, none guessed. */
export function initialState(kind: RuleNodeKind): NodeFormState {
  const state: NodeFormState = {};
  for (const field of NODE_SPECS[kind].fields) {
    if (field.kind === 'weekdaySet') state[field.name] = [];
    else if (field.kind === 'shiftTypeList') state[field.name] = [''];
    else if (field.kind === 'segments') state[field.name] = [{ offsetDays: '0', shiftType: '' }];
    else if (field.kind === 'enum') state[field.name] = field.options[0]?.value ?? '';
    else if (field.kind === 'fixed') state[field.name] = field.value;
    // A numeric parameter starts at 1 rather than blank. Every `int` and
    // `decimal` field in the AST accepts 1 (counts and windows are positive
    // integers; the two fractions admit it), so the form opens in a completable
    // state instead of one the outgoing contract parse would refuse before the
    // author had touched anything.
    else if (field.kind === 'int' || field.kind === 'decimal') state[field.name] = '1';
    else state[field.name] = '';
  }
  return state;
}

/**
 * Read an existing predicate back into the form — the EDIT half of the round
 * trip.
 *
 * Everything becomes a string, because that is what a control holds. The
 * conversion back is `toPredicate`, and `apps/web/test/node-editors.test.ts`
 * drives one authored example of all thirty kinds through
 * `toPredicate(fromPredicate(x))` and asserts it equals `x`. A lossy field would
 * fail that, which is the property an author actually depends on: opening a rule
 * and pressing Save must not change it.
 */
export function fromPredicate(node: RuleNodeWire): NodeFormState {
  const source = node as unknown as Record<string, unknown>;
  const state: NodeFormState = {};
  for (const field of NODE_SPECS[node.kind].fields) {
    const value = source[field.name];
    if (field.kind === 'weekdaySet') {
      state[field.name] = Array.isArray(value) ? value.map(String) : [];
    } else if (field.kind === 'shiftTypeList') {
      state[field.name] = Array.isArray(value) && value.length > 0 ? value.map(String) : [''];
    } else if (field.kind === 'intList') {
      state[field.name] = Array.isArray(value) ? value.map(String).join(', ') : '';
    } else if (field.kind === 'segments') {
      const segments = Array.isArray(value)
        ? value.map((entry) => {
            const segment = entry as { offsetDays?: unknown; shiftType?: unknown };
            return {
              offsetDays: String(segment.offsetDays ?? '0'),
              shiftType: String(segment.shiftType ?? ''),
            };
          })
        : [];
      state[field.name] = segments.length > 0 ? segments : [{ offsetDays: '0', shiftType: '' }];
    } else {
      state[field.name] = value === undefined || value === null ? '' : String(value);
    }
  }
  return state;
}

/**
 * Build the predicate the contract will parse.
 *
 * Deliberately **not** validating: the shared zod schema is the one validator,
 * on the way out of the client and again on the server, and a second set of
 * rules here would be a second thing to keep in step. What this does is convert
 * types — a number field is a number, a list is a list — so that what the
 * contract rejects is a real problem rather than a string where an integer
 * belongs.
 */
export function toPredicate(kind: RuleNodeKind, state: NodeFormState): unknown {
  const predicate: Record<string, unknown> = { kind };
  for (const field of NODE_SPECS[kind].fields) {
    const value = state[field.name];
    switch (field.kind) {
      case 'int':
      case 'decimal':
        predicate[field.name] = Number(String(value ?? '').trim());
        break;
      case 'intList':
        predicate[field.name] = String(value ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
          .map(Number);
        break;
      case 'weekdaySet':
        predicate[field.name] = Array.isArray(value) ? [...value] : [];
        break;
      case 'shiftTypeList':
        predicate[field.name] = (Array.isArray(value) ? value : [])
          .map((entry) => String(entry).trim())
          .filter((entry) => entry !== '');
        break;
      case 'segments':
        predicate[field.name] = (Array.isArray(value) ? (value as SegmentState[]) : []).map(
          (segment) => ({
            offsetDays: Number(String(segment.offsetDays).trim()),
            shiftType: String(segment.shiftType).trim(),
          }),
        );
        break;
      default:
        predicate[field.name] = String(value ?? '').trim();
    }
  }
  return predicate;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The editor
 * ──────────────────────────────────────────────────────────────────────────── */

export interface NodeParameterEditorProps {
  readonly kind: RuleNodeKind;
  readonly state: NodeFormState;
  readonly onChange: (state: NodeFormState) => void;
  /** Catalogue shift-type codes, for the pickers. */
  readonly shiftTypeCodes: readonly string[];
  /** `fieldName -> DOM id`, so the validation summary's links resolve. */
  readonly fieldIds: Readonly<Record<string, string>>;
  readonly problemFor: (field: string) => string | undefined;
}

export function NodeParameterEditor({
  kind,
  state,
  onChange,
  shiftTypeCodes,
  fieldIds,
  problemFor,
}: NodeParameterEditorProps): JSX.Element {
  const spec = NODE_SPECS[kind];
  const set = (name: string, value: string | string[] | SegmentState[]): void =>
    onChange({ ...state, [name]: value });

  return (
    <fieldset className="flex flex-col gap-sp-4 rounded-panel border border-border p-sp-3">
      <legend className="px-sp-1 font-medium text-text">{spec.label} parameters</legend>
      <p className="text-sm text-text-muted" data-testid="node-description">
        {spec.description}
      </p>

      {spec.fields.map((field) => {
        const id = fieldIds[`predicate.${field.name}`] ?? `predicate-${field.name}`;
        const problem = problemFor(`predicate.${field.name}`);

        if (field.kind === 'fixed') {
          return (
            <Field id={id} key={field.name} label={field.label} {...helpProp(field.help)}>
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  data-testid={`node-${field.name}`}
                  readOnly
                  type="text"
                  value={field.value}
                />
              )}
            </Field>
          );
        }

        if (field.kind === 'enum') {
          return (
            <Field id={id} key={field.name} label={field.label} {...helpProp(field.help)} problem={problem}>
              {(attributes) => (
                <select
                  {...attributes}
                  className={CONTROL_CLASS}
                  data-testid={`node-${field.name}`}
                  onChange={(event) => set(field.name, event.target.value)}
                  value={String(state[field.name] ?? '')}
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          );
        }

        if (field.kind === 'shiftType') {
          return (
            <Field id={id} key={field.name} label={field.label} {...helpProp(field.help)} problem={problem}>
              {(attributes) => (
                <select
                  {...attributes}
                  className={CONTROL_CLASS}
                  data-testid={`node-${field.name}`}
                  onChange={(event) => set(field.name, event.target.value)}
                  value={String(state[field.name] ?? '')}
                >
                  <option value="">Choose a shift type</option>
                  {codesIncluding(shiftTypeCodes, String(state[field.name] ?? '')).map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          );
        }

        if (field.kind === 'weekdaySet') {
          const selected = Array.isArray(state[field.name]) ? (state[field.name] as string[]) : [];
          return (
            <fieldset className="flex flex-col gap-sp-2" key={field.name}>
              <legend className="font-medium text-text">{field.label}</legend>
              {field.help === undefined ? null : (
                <p className="text-sm text-text-muted">{field.help}</p>
              )}
              {problem === undefined ? null : <p className="text-sm text-danger">{problem}</p>}
              <div className="flex flex-wrap gap-sp-3">
                {RULE_WEEKDAY_VALUES.map((weekday) => (
                  <label
                    className="inline-flex min-h-target items-center gap-sp-2 text-text"
                    key={weekday}
                  >
                    <input
                      checked={selected.includes(weekday)}
                      data-testid={`node-${field.name}-${weekday}`}
                      onChange={(event) =>
                        set(
                          field.name,
                          event.target.checked
                            ? [...selected, weekday]
                            : selected.filter((entry) => entry !== weekday),
                        )
                      }
                      type="checkbox"
                    />
                    {weekday}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        }

        if (field.kind === 'shiftTypeList') {
          const entries = Array.isArray(state[field.name]) ? (state[field.name] as string[]) : [''];
          return (
            <fieldset className="flex flex-col gap-sp-2" key={field.name}>
              <legend className="font-medium text-text">{field.label}</legend>
              {field.help === undefined ? null : (
                <p className="text-sm text-text-muted">{field.help}</p>
              )}
              {problem === undefined ? null : <p className="text-sm text-danger">{problem}</p>}
              {entries.map((entry, index) => (
                <div className="flex flex-wrap items-center gap-sp-2" key={`${field.name}-${String(index)}`}>
                  <label className="sr-only" htmlFor={`${id}-${String(index)}`}>
                    {field.label} position {index + 1}
                  </label>
                  <select
                    className={CONTROL_CLASS}
                    data-testid={`node-${field.name}-${String(index)}`}
                    id={`${id}-${String(index)}`}
                    onChange={(event) => {
                      const next = [...entries];
                      next[index] = event.target.value;
                      set(field.name, next);
                    }}
                    value={entry}
                  >
                    <option value="">Choose a shift type</option>
                    {codesIncluding(shiftTypeCodes, entry).map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                  {entries.length > 1 ? (
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      onClick={() => set(field.name, entries.filter((_, at) => at !== index))}
                      type="button"
                    >
                      Remove
                      <span className="sr-only">
                        {' '}
                        {field.label} position {index + 1}
                      </span>
                    </button>
                  ) : null}
                </div>
              ))}
              <p>
                <button
                  className={SECONDARY_BUTTON_CLASS}
                  data-testid={`node-${field.name}-add`}
                  // I-13: adding a row is local state and issues no request.
                  onClick={() => set(field.name, [...entries, ''])}
                  type="button"
                >
                  Add another
                  <span className="sr-only"> to {field.label}</span>
                </button>
              </p>
            </fieldset>
          );
        }

        if (field.kind === 'segments') {
          const segments = Array.isArray(state[field.name])
            ? (state[field.name] as SegmentState[])
            : [];
          return (
            <fieldset className="flex flex-col gap-sp-3" key={field.name}>
              <legend className="font-medium text-text">{field.label}</legend>
              {field.help === undefined ? null : (
                <p className="text-sm text-text-muted">{field.help}</p>
              )}
              {problem === undefined ? null : <p className="text-sm text-danger">{problem}</p>}
              {segments.map((segment, index) => (
                <div
                  className="flex flex-wrap items-end gap-sp-3 rounded-panel border border-border p-sp-2"
                  key={`${field.name}-${String(index)}`}
                >
                  <div className="flex flex-col gap-sp-1">
                    <label
                      className="font-medium text-text"
                      htmlFor={`${id}-offset-${String(index)}`}
                    >
                      Offset in days
                    </label>
                    <input
                      className={CONTROL_CLASS}
                      data-testid={`node-segment-offset-${String(index)}`}
                      id={`${id}-offset-${String(index)}`}
                      inputMode="numeric"
                      onChange={(event) => {
                        const next = [...segments];
                        next[index] = {
                          offsetDays: event.target.value,
                          shiftType: segment.shiftType,
                        };
                        set(field.name, next);
                      }}
                      type="text"
                      value={segment.offsetDays}
                    />
                  </div>
                  <div className="flex flex-col gap-sp-1">
                    <label
                      className="font-medium text-text"
                      htmlFor={`${id}-shift-${String(index)}`}
                    >
                      Shift type
                    </label>
                    <select
                      className={CONTROL_CLASS}
                      data-testid={`node-segment-shift-${String(index)}`}
                      id={`${id}-shift-${String(index)}`}
                      onChange={(event) => {
                        const next = [...segments];
                        next[index] = {
                          offsetDays: segment.offsetDays,
                          shiftType: event.target.value,
                        };
                        set(field.name, next);
                      }}
                      value={segment.shiftType}
                    >
                      <option value="">Choose a shift type</option>
                      {codesIncluding(shiftTypeCodes, segment.shiftType).map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </div>
                  {segments.length > 1 ? (
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      onClick={() => set(field.name, segments.filter((_, at) => at !== index))}
                      type="button"
                    >
                      Remove
                      <span className="sr-only"> segment {index + 1}</span>
                    </button>
                  ) : null}
                </div>
              ))}
              <p>
                <button
                  className={SECONDARY_BUTTON_CLASS}
                  data-testid="node-segments-add"
                  onClick={() => set(field.name, [...segments, { offsetDays: '1', shiftType: '' }])}
                  type="button"
                >
                  Add a segment
                </button>
              </p>
            </fieldset>
          );
        }

        // int, decimal, text, intList, date — all one text control, because a
        // native number input silently discards what it cannot parse and the
        // author then cannot see what the server is refusing.
        return (
          <Field id={id} key={field.name} label={field.label} {...helpProp(field.help)} problem={problem}>
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                data-testid={`node-${field.name}`}
                inputMode={field.kind === 'int' || field.kind === 'decimal' ? 'numeric' : 'text'}
                onChange={(event) => set(field.name, event.target.value)}
                type="text"
                value={String(state[field.name] ?? '')}
              />
            )}
          </Field>
        );
      })}
    </fieldset>
  );
}

/**
 * The catalogue codes, plus the value already in the rule if it is not among
 * them.
 *
 * A rule may reference a shift type that has since been retired. Dropping it
 * from the picker would rewrite the rule the moment somebody opened it — a
 * silent edit nobody asked for, and exactly the kind of loss the round-trip
 * test exists to catch.
 */
/**
 * `help` is spread in only when it exists.
 *
 * `exactOptionalPropertyTypes` makes an absent key and an explicit `undefined`
 * different things, and `FieldProps.help` is `help?: string` — "declared, value
 * undefined" is the shape a reader would mistake for "declared empty".
 */
function helpProp(help: string | undefined): { help?: string } {
  return help === undefined ? {} : { help };
}

function codesIncluding(codes: readonly string[], current: string): string[] {
  return current !== '' && !codes.includes(current) ? [...codes, current] : [...codes];
}
