import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import type { RuleView } from '@schedulepoint/contracts';

import { ValidationError, fetchShiftTypes } from '../api/catalogue.js';
import { createRule, fetchRules, setRuleState } from '../api/rules.js';
import { updateRule } from './api.js';
import {
  NODE_KINDS,
  NODE_SPECS,
  NodeParameterEditor,
  fromPredicate,
  initialState,
  toPredicate,
  type NodeFormState,
  type RuleNodeKind,
} from './node-editors.js';
import { CatalogueLayout, useGroupScope } from '../catalogue/CatalogueLayout.js';
import {
  CONTROL_CLASS,
  Field,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  ValidationSummary,
  useFieldIds,
  type FieldProblem,
} from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';

/**
 * Rule authoring over the typed model (OPUS-M3-002; CAP-015, CAP-045).
 *
 * ## I-13, and why the form is not on the page until it is asked for
 *
 * > "No control labelled Add, New, or Create may persist anything before a
 * > completed form, validation, and an explicit Save."
 *
 * `New rule` toggles local state and issues **zero requests** — measured, and
 * budgeted at 0 in `scripts/gates/request-budget/budgets.json`, where the number
 * can never be raised without the invariant changing first. Nothing reaches the
 * server until Save, and Save sends exactly one request.
 *
 * ## The closed node set as a `<select>`, deliberately
 *
 * The predicate kind is a fixed list of thirty, so it is a select — not a text
 * box, not a "custom expression" field. **The interface has no affordance for a
 * rule the AST cannot express** (SPEC-04 §3.1). That is the same statement the
 * contract's discriminated union and the database's
 * `rules_predicate_kind_is_closed` CHECK make, made where the user is: there is
 * no box to type an escape hatch into.
 *
 * **All thirty kinds are authorable here** (OPUS-M3-004). OPUS-M3-002 shipped
 * three — the nodes whose only parameter is one number — and said "3 of the 30"
 * on the page rather than leaving it to be discovered; `node-editors.tsx` adds
 * the remaining twenty-seven, and the on-page quantification is updated in the
 * same change. The enumerated parameters are selects and checkbox sets over the
 * contract's own constants, so the closed set is now closed at the parameter
 * level too.
 *
 * ## Editing is a round trip, and it is lossless
 *
 * A rule can be opened, changed and saved. `fromPredicate` reads a stored
 * predicate into the form and `toPredicate` builds it back;
 * `apps/web/test/node-editors.test.ts` drives one example of every kind through
 * both and asserts equality, because the property an author depends on is that
 * opening a rule and pressing Save does not change it.
 *
 * ## Two representations, one of them in the DOM at a time
 *
 * Below 640px the six-column table does not fit — measured, not assumed: the
 * first version overflowed the 320px viewport by 211px and
 * `apps/web/e2e/rules.spec.ts`'s AC-08 assertion caught it. So the narrow
 * viewport gets a **list alternative** carrying the same information, chosen in
 * JavaScript rather than hidden in CSS: rendering both and hiding one would put
 * every rule in the accessibility tree twice (`useNarrowViewport`'s docblock has
 * the full reasoning, and this is the second surface to need it).
 *
 * ## Validation is submit-only, and the summary takes focus
 *
 * `Form.tsx`'s contract, unchanged: no `onChange` validation anywhere, errors
 * announced once, and the `role="alert"` summary links to the control that is
 * wrong by the dotted AST path the server returns.
 */

/**
 * Every field name any node kind uses, so the validation summary's links
 * resolve whichever kind is selected.
 *
 * Derived from `NODE_SPECS` rather than listed: a kind whose parameter had no id
 * here would produce a summary entry that links nowhere, and the failure is
 * silent — the link simply does not move the caret.
 */
const PREDICATE_FIELD_NAMES = [
  ...new Set(
    NODE_KINDS.flatMap((kind) => NODE_SPECS[kind].fields.map((field) => `predicate.${field.name}`)),
  ),
];
const RULE_FIELD_NAMES = [
  'ruleKey',
  'name',
  'classification',
  'weight',
  'predicate.kind',
  ...PREDICATE_FIELD_NAMES,
];

export function RulesPage(): JSX.Element {
  return (
    <CatalogueLayout
      title="Scheduling rules"
      description="Typed rules the scheduling engine consumes. Hard rules are never relaxed; soft rules carry a weight."
    >
      <RulesPanel />
    </CatalogueLayout>
  );
}

function RulesPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const narrow = useNarrowViewport();
  const fieldIds = useFieldIds('rule', RULE_FIELD_NAMES);
  /**
   * `fieldIds` is now keyed by a runtime-derived list rather than a literal
   * tuple, so indexing it yields `string | undefined` under
   * `noUncheckedIndexedAccess`. The fallback is the field name itself, which is
   * still a usable DOM id — a summary link that resolved to nothing would be a
   * silent accessibility failure, and this makes that impossible.
   */
  const fieldId = (field: string): string => fieldIds[field] ?? `rule-${field}`;

  /** I-13: opening the form is local state and issues no request. */
  const [isAuthoring, setIsAuthoring] = useState(false);
  /** Non-null when an EXISTING rule is open. Its key cannot change. */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [ruleKey, setRuleKey] = useState('');
  const [name, setName] = useState('');
  const [classification, setClassification] = useState<'HARD' | 'SOFT'>('HARD');
  const [weight, setWeight] = useState('');
  const [kind, setKind] = useState<RuleNodeKind>('RequiredCount');
  const [node, setNode] = useState<NodeFormState>(() => initialState('RequiredCount'));
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const rules = useQuery({
    queryKey: ['rules', scope.organizationId, scope.groupId],
    queryFn: () => fetchRules(scope),
    retry: false,
  });

  /** The shift-type codes the pickers offer. A page-load read, not a per-keystroke one. */
  const shiftTypes = useQuery({
    queryKey: ['shift-types', scope.organizationId, scope.groupId],
    queryFn: () => fetchShiftTypes(scope),
    retry: false,
  });
  const shiftTypeCodes = (shiftTypes.data?.shiftTypes ?? []).map((shiftType) => shiftType.code);

  const closeForm = (): void => {
    setProblems([]);
    setIsAuthoring(false);
    setEditingKey(null);
    setRuleKey('');
    setName('');
    setWeight('');
    setKind('RequiredCount');
    setNode(initialState('RequiredCount'));
  };

  /** Open an existing rule. Reads from the list already held — no extra request. */
  const openForEdit = (rule: RuleView): void => {
    setProblems([]);
    setEditingKey(rule.ruleKey);
    setRuleKey(rule.ruleKey);
    setName(rule.name);
    setClassification(rule.classification);
    setWeight(rule.weight === null ? '' : String(rule.weight));
    setKind(rule.predicate.kind);
    setNode(fromPredicate(rule.predicate));
    setIsAuthoring(true);
  };

  const body = () => ({
    ruleKey,
    name,
    classification,
    ...(classification === 'SOFT' ? { weight: Number(weight) } : {}),
    scope: {},
    // Assembled from the closed set and its typed parameters, never free text.
    predicate: toPredicate(kind, node) as never,
  });

  const save = useMutation({
    mutationFn: () =>
      editingKey === null ? createRule(scope, body()) : updateRule(scope, editingKey, body()),
    onSuccess: () => {
      closeForm();
      void queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (error: unknown) =>
      setProblems(error instanceof ValidationError ? error.problems : []),
  });

  const changeState = useMutation({
    mutationFn: (input: { ruleKey: string; state: 'active' | 'disabled' | 'archived' }) =>
      setRuleState(scope, input.ruleKey, input.state),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  const list = rules.data?.rules ?? [];

  return (
    <section aria-labelledby="rules-heading" className="flex flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="rules-heading">
        Rules
      </h2>

      {/* Stated on the page rather than left to be discovered. The number is
          DERIVED from the node registry, so it cannot drift from what the form
          can actually author — the previous version of this sentence was a
          hand-written "3 of the 30" and would have had to be remembered. */}
      <p className="text-sm text-text-muted" data-testid="rules-staging-note">
        This release authors{' '}
        <strong>
          all {String(NODE_KINDS.length)} of the {String(NODE_KINDS.length)} rule types
        </strong>
        . Every rule is chosen from the rule language and edited here; there is no free-form rule.
        Rules are checked against a schedule when a version is published, not while it is being
        drafted.
      </p>

      {isAuthoring ? null : (
        <p>
          <button
            className={PRIMARY_BUTTON_CLASS}
            data-testid="rules-new"
            onClick={() => {
              // I-13: local state only. Nothing is created, nothing is fetched.
              closeForm();
              setIsAuthoring(true);
            }}
            type="button"
          >
            New rule
          </button>
        </p>
      )}

      {isAuthoring ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          data-testid="rules-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            save.mutate();
          }}
        >
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="rule" />

          <Field
            id={fieldId('ruleKey')}
            label="Rule key"
            help="A stable identifier. It cannot be changed after the rule is saved."
            problem={problemFor(problems, 'ruleKey')}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="rules-key"
                onChange={(event) => setRuleKey(event.target.value)}
                // Non-bypass rule 13, at the surface: a stable id that silently
                // changes meaning corrupts every reference to it. Editing a rule
                // cannot rename its key.
                readOnly={editingKey !== null}
                type="text"
                value={ruleKey}
              />
            )}
          </Field>

          <Field id={fieldId('name')} label="Name" problem={problemFor(problems, 'name')}>
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="rules-name"
                onChange={(event) => setName(event.target.value)}
                type="text"
                value={name}
              />
            )}
          </Field>

          <Field
            id={fieldId('classification')}
            label="Classification"
            help="A hard rule is never relaxed. A soft rule is a preference and carries a weight."
            problem={problemFor(problems, 'classification')}
          >
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                onChange={(event) =>
                  setClassification(event.target.value === 'SOFT' ? 'SOFT' : 'HARD')
                }
                value={classification}
              >
                <option value="HARD">Hard — never relaxed</option>
                <option value="SOFT">Soft — a weighted preference</option>
              </select>
            )}
          </Field>

          {classification === 'SOFT' ? (
            <Field
              id={fieldId('weight')}
              label="Weight"
              help="Greater than zero. Higher weights are honoured first."
              problem={problemFor(problems, 'weight')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  inputMode="decimal"
                  onChange={(event) => setWeight(event.target.value)}
                  type="text"
                  value={weight}
                />
              )}
            </Field>
          ) : null}

          <Field
            id={fieldId('predicate.kind')}
            label="Rule type"
            help="Chosen from the rule language. There is no free-form rule."
            problem={problemFor(problems, 'predicate.kind')}
          >
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="rules-kind"
                onChange={(event) => {
                  const next = event.target.value as RuleNodeKind;
                  setKind(next);
                  // A kind change starts its own parameters. Carrying the old
                  // ones over would leave fields the new node does not have,
                  // and `.strict()` would reject the save for a reason the
                  // author could not see.
                  setNode(initialState(next));
                }}
                value={kind}
              >
                {NODE_KINDS.map((nodeKind) => (
                  <option key={nodeKind} value={nodeKind}>
                    {NODE_SPECS[nodeKind].label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <NodeParameterEditor
            fieldIds={fieldIds}
            kind={kind}
            onChange={setNode}
            problemFor={(field) => problemFor(problems, field)}
            shiftTypeCodes={shiftTypeCodes}
            state={node}
          />

          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} data-testid="rules-save" type="submit">
              {editingKey === null ? 'Save rule' : 'Save changes'}
            </button>
            <button className={SECONDARY_BUTTON_CLASS} onClick={closeForm} type="button">
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <SurfaceState
        isLoading={rules.isPending}
        error={rules.error}
        isEmpty={list.length === 0}
        emptyMessage="No rules have been authored for this group yet."
        label="the rules"
      >
        {narrow ? (
          /* The list alternative. Same rows, same actions, no horizontal
             scrolling (SC 1.4.10). A definition list per rule rather than a
             table, because a two-column table at 320px is a table nobody can
             read either. */
          <ul className="flex flex-col gap-sp-3" data-testid="rules-list">
            {list.map((rule) => (
              <li
                className="rounded-panel border border-border bg-surface-raised p-sp-3"
                data-testid={`rules-row-${rule.ruleKey}`}
                key={rule.ruleKey}
              >
                <h3 className="font-semibold text-text">{rule.name}</h3>
                <dl className="mt-sp-2 flex flex-col gap-sp-1 text-sm">
                  <div className="flex gap-sp-2">
                    <dt className="text-text-muted">Key</dt>
                    <dd className="font-mono text-text">{rule.ruleKey}</dd>
                  </div>
                  <div className="flex gap-sp-2">
                    <dt className="text-text-muted">Rule type</dt>
                    <dd className="text-text" data-testid={`rules-kind-${rule.ruleKey}`}>
                      {NODE_SPECS[rule.predicate.kind].label}
                    </dd>
                  </div>
                  <div className="flex gap-sp-2">
                    <dt className="text-text-muted">Classification</dt>
                    <dd className="text-text">
                      {rule.classification === 'HARD' ? 'Hard' : 'Soft'}
                      {rule.weight === null ? '' : ` (weight ${String(rule.weight)})`}
                    </dd>
                  </div>
                  <div className="flex gap-sp-2">
                    <dt className="text-text-muted">State</dt>
                    <dd className="text-text">{rule.state}</dd>
                  </div>
                </dl>
                {rule.state === 'archived' ? null : (
                  <p className="mt-sp-3 flex flex-wrap gap-sp-2">
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      data-testid={`rules-edit-${rule.ruleKey}`}
                      // Opens from the list already held. No request (I-13/I-10).
                      onClick={() => openForEdit(rule)}
                      type="button"
                    >
                      Edit
                      <span className="sr-only"> rule {rule.ruleKey}</span>
                    </button>
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      data-testid={`rules-toggle-${rule.ruleKey}`}
                      onClick={() =>
                        changeState.mutate({
                          ruleKey: rule.ruleKey,
                          state: rule.state === 'active' ? 'disabled' : 'active',
                        })
                      }
                      type="button"
                    >
                      {rule.state === 'active' ? 'Disable' : 'Enable'}
                      <span className="sr-only"> rule {rule.ruleKey}</span>
                    </button>
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          /* A table, not a grid of divs: a rule list IS tabular, and a screen
             reader announces row and column position only for a real table. */
          <table className="w-full border-collapse text-left" data-testid="rules-table">
            <caption className="sr-only">Scheduling rules for this group</caption>
            <thead>
              <tr>
                <th className="border-b border-border p-sp-2" scope="col">
                  Key
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  Name
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  Rule type
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  Classification
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  Weight
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  State
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((rule) => (
                <tr key={rule.ruleKey} data-testid={`rules-row-${rule.ruleKey}`}>
                  <th className="border-b border-border p-sp-2 font-mono font-normal" scope="row">
                    {rule.ruleKey}
                  </th>
                  <td className="border-b border-border p-sp-2">{rule.name}</td>
                  <td className="border-b border-border p-sp-2" data-testid={`rules-kind-${rule.ruleKey}`}>
                    {NODE_SPECS[rule.predicate.kind].label}
                  </td>
                  <td className="border-b border-border p-sp-2">
                    {rule.classification === 'HARD' ? 'Hard' : 'Soft'}
                  </td>
                  <td className="border-b border-border p-sp-2">
                    {rule.weight === null ? '—' : String(rule.weight)}
                  </td>
                  <td className="border-b border-border p-sp-2">{rule.state}</td>
                  <td className="border-b border-border p-sp-2 flex flex-wrap gap-sp-2">
                    {rule.state === 'archived' ? (
                      '—'
                    ) : (
                      <>
                      <button
                        className={SECONDARY_BUTTON_CLASS}
                        data-testid={`rules-edit-${rule.ruleKey}`}
                        onClick={() => openForEdit(rule)}
                        type="button"
                      >
                        Edit
                        <span className="sr-only"> rule {rule.ruleKey}</span>
                      </button>
                      <button
                        className={SECONDARY_BUTTON_CLASS}
                        data-testid={`rules-toggle-${rule.ruleKey}`}
                        onClick={() =>
                          changeState.mutate({
                            ruleKey: rule.ruleKey,
                            state: rule.state === 'active' ? 'disabled' : 'active',
                          })
                        }
                        type="button"
                      >
                        {/* The accessible name names the RULE, so a screen-reader
                            user hearing the button out of context knows which row
                            it belongs to (SP-HR-3). */}
                        {rule.state === 'active' ? 'Disable' : 'Enable'}
                        <span className="sr-only"> rule {rule.ruleKey}</span>
                      </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SurfaceState>
    </section>
  );
}

function problemFor(problems: readonly FieldProblem[], field: string): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}
