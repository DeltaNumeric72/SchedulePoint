import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import { ValidationError } from '../api/catalogue.js';
import { createRule, fetchRules, setRuleState } from '../api/rules.js';
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
 * This slice authors **3 of the 30 node kinds** — the single-parameter coverage
 * nodes, which is the complete set whose parameters are one number. The page says
 * "3 of the 30" in as many words, so the interface is as honest as this comment. The remaining
 * twenty-seven need per-node parameter editors (segment lists, weekday sets,
 * qualification pickers) and belong with the surfaces that own those
 * vocabularies — M3-004's cell editor and validation display. **The API and the
 * model accept all thirty**; only this form's editors are staged, and it says so
 * on the page rather than leaving a user to discover it.
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

/** The nodes this form can currently author. See the docblock. */
const AUTHORABLE_NODES = [
  { kind: 'RequiredCount', label: 'Required count', parameter: 'count' },
  { kind: 'MinCoverage', label: 'Minimum coverage', parameter: 'min' },
  { kind: 'MaxCoverage', label: 'Maximum coverage', parameter: 'max' },
] as const;

type AuthorableKind = (typeof AUTHORABLE_NODES)[number]['kind'];

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
  const fieldIds = useFieldIds('rule', [
    'ruleKey',
    'name',
    'classification',
    'weight',
    'predicate.kind',
    'predicate.count',
    'predicate.min',
    'predicate.max',
  ] as const);

  /** I-13: opening the form is local state and issues no request. */
  const [isAuthoring, setIsAuthoring] = useState(false);
  const [ruleKey, setRuleKey] = useState('');
  const [name, setName] = useState('');
  const [classification, setClassification] = useState<'HARD' | 'SOFT'>('HARD');
  const [weight, setWeight] = useState('');
  const [kind, setKind] = useState<AuthorableKind>('RequiredCount');
  const [amount, setAmount] = useState('1');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const rules = useQuery({
    queryKey: ['rules', scope.organizationId, scope.groupId],
    queryFn: () => fetchRules(scope),
    retry: false,
  });

  const parameter = AUTHORABLE_NODES.find((node) => node.kind === kind)?.parameter ?? 'count';

  const save = useMutation({
    mutationFn: () =>
      createRule(scope, {
        ruleKey,
        name,
        classification,
        ...(classification === 'SOFT' ? { weight: Number(weight) } : {}),
        scope: {},
        // The predicate is assembled from the closed list, never from free text.
        predicate: { kind, [parameter]: Number(amount) } as never,
      }),
    onSuccess: () => {
      setProblems([]);
      setIsAuthoring(false);
      setRuleKey('');
      setName('');
      setWeight('');
      setAmount('1');
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

      {/* Stated on the page rather than left to be discovered. */}
      <p className="text-sm text-text-muted" data-testid="rules-staging-note">
        This release authors <strong>3 of the 30 rule types</strong> — the coverage rules. The other
        27 are authored with the scheduling surfaces that own their vocabularies (shift patterns,
        qualifications, templates); rules of those types created elsewhere are listed below and can
        be enabled or disabled here.
      </p>

      {isAuthoring ? null : (
        <p>
          <button
            className={PRIMARY_BUTTON_CLASS}
            data-testid="rules-new"
            onClick={() => {
              // I-13: local state only. Nothing is created, nothing is fetched.
              setProblems([]);
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
            id={fieldIds.ruleKey}
            label="Rule key"
            help="A stable identifier. It cannot be changed after the rule is saved."
            problem={problemFor(problems, 'ruleKey')}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                onChange={(event) => setRuleKey(event.target.value)}
                type="text"
                value={ruleKey}
              />
            )}
          </Field>

          <Field id={fieldIds.name} label="Name" problem={problemFor(problems, 'name')}>
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                onChange={(event) => setName(event.target.value)}
                type="text"
                value={name}
              />
            )}
          </Field>

          <Field
            id={fieldIds.classification}
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
              id={fieldIds.weight}
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
            id={fieldIds['predicate.kind']}
            label="Rule type"
            help="Chosen from the rule language. There is no free-form rule."
            problem={problemFor(problems, 'predicate.kind')}
          >
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="rules-kind"
                onChange={(event) => setKind(event.target.value as AuthorableKind)}
                value={kind}
              >
                {AUTHORABLE_NODES.map((node) => (
                  <option key={node.kind} value={node.kind}>
                    {node.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            id={fieldIds[`predicate.${parameter}` as keyof typeof fieldIds]}
            label="Number of staff"
            problem={problemFor(problems, `predicate.${parameter}`)}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                inputMode="numeric"
                onChange={(event) => setAmount(event.target.value)}
                type="text"
                value={amount}
              />
            )}
          </Field>

          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} data-testid="rules-save" type="submit">
              Save rule
            </button>
            <button
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => {
                setIsAuthoring(false);
                setProblems([]);
              }}
              type="button"
            >
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
                  <p className="mt-sp-3">
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
                  <td className="border-b border-border p-sp-2">
                    {rule.classification === 'HARD' ? 'Hard' : 'Soft'}
                  </td>
                  <td className="border-b border-border p-sp-2">
                    {rule.weight === null ? '—' : String(rule.weight)}
                  </td>
                  <td className="border-b border-border p-sp-2">{rule.state}</td>
                  <td className="border-b border-border p-sp-2">
                    {rule.state === 'archived' ? (
                      '—'
                    ) : (
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
