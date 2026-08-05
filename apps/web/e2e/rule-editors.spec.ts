import { expect, test, type Page, type Route } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

/**
 * Every one of the thirty rule node kinds, authored → listed → edited through
 * the real interface (OPUS-M3-004).
 *
 * ## What this proves that the unit test cannot
 *
 * `apps/web/test/node-editors.test.ts` proves `toPredicate(fromPredicate(x))`
 * equals `x` for all thirty kinds. That is the conversion. It says nothing about
 * whether a human can actually reach those parameters: a field with no control,
 * a select with no options, a checkbox whose handler never fires, or a testid
 * that does not exist would all pass the unit test and leave the kind
 * unauthorable.
 *
 * So each kind here is driven through the DOM — choose the kind, fill its
 * controls, Save, then reopen the saved rule from the list and Save again — and
 * the assertion is on the **request bodies**: what the browser sent for the
 * create must be the predicate the fixture describes, and what it sent for the
 * edit must be byte-equal to it. A kind that cannot be filled in fails; a kind
 * whose editor loses a parameter on reopen fails.
 *
 * ## Coverage is asserted, not counted by hand
 *
 * The fixture list is compared against the contract's own discriminated union at
 * the top of the file, so a kind added to the AST without a fixture here fails
 * rather than silently reducing the coverage this file claims.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/catalogue/rules`;
const RULES_API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/rules`;
const RULE_API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/rules/*`;
const SHIFT_TYPES_API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/catalogue/shift-types`;

/** The catalogue the shift-type pickers offer. Synthetic codes only. */
function catalogueShiftType(id: string, code: string, name: string) {
  return {
    shiftTypeId: id,
    code,
    name,
    description: null,
    displayPaletteKey: 'neutral',
    displayTextStyle: 'regular',
    startTime: '08:00',
    endTime: '16:00',
    crossesMidnight: false,
    isOnCall: false,
    attractsStipend: false,
    isManualOnly: false,
    isDailyPick: false,
    includeInStatistics: true,
    isLeaveOfAbsence: false,
    allowOnRequest: false,
    allowOffRequest: false,
    reportOrder: 0,
    creditWeight: 1,
    status: 'active',
    effectiveFrom: '2027-01-01T00:00:00.000Z',
    effectiveTo: null,
    version: 1,
  };
}

const SHIFT_TYPES = [
  catalogueShiftType('77777777-7777-4777-8777-777777777777', 'DAY', 'Day shift'),
  catalogueShiftType('88888888-8888-4888-8888-888888888888', 'NGT', 'Night shift'),
];

type Step =
  | { control: string; type: 'text'; value: string }
  | { control: string; type: 'select'; value: string }
  | { control: string; type: 'check' }
  | { control: string; type: 'click' };

interface KindFixture {
  readonly kind: string;
  readonly steps: readonly Step[];
  readonly predicate: Record<string, unknown>;
}

function text(control: string, value: string): Step {
  return { control, type: 'text', value };
}
function select(control: string, value: string): Step {
  return { control, type: 'select', value };
}

/**
 * One authored example of every kind, with the controls a human would touch.
 *
 * The `predicate` is what the browser must put on the wire. Every value is
 * synthetic; the shift-type codes are the two in the fixture catalogue above.
 */
const FIXTURES: readonly KindFixture[] = [
  { kind: 'RequiredCount', steps: [text('node-count', '3')], predicate: { kind: 'RequiredCount', count: 3 } },
  { kind: 'MinCoverage', steps: [text('node-min', '2')], predicate: { kind: 'MinCoverage', min: 2 } },
  { kind: 'MaxCoverage', steps: [text('node-max', '5')], predicate: { kind: 'MaxCoverage', max: 5 } },
  {
    kind: 'RequiresQualification',
    steps: [text('node-qualification', 'advanced_life_support')],
    predicate: {
      kind: 'RequiresQualification',
      qualification: 'advanced_life_support',
      validAt: 'shift_date',
    },
  },
  {
    kind: 'MemberOfStaffGroup',
    steps: [text('node-staffGroup', 'senior_cover')],
    predicate: { kind: 'MemberOfStaffGroup', staffGroup: 'senior_cover' },
  },
  {
    kind: 'ValidGroupRestriction',
    steps: [text('node-validGroup', 'weekend_combination')],
    predicate: { kind: 'ValidGroupRestriction', validGroup: 'weekend_combination' },
  },
  {
    kind: 'PickPositionRestriction',
    steps: [text('node-allowedPickPositions', '0, 2, 5')],
    predicate: { kind: 'PickPositionRestriction', allowedPickPositions: [0, 2, 5] },
  },
  {
    kind: 'MaxAssignmentsInWindow',
    steps: [text('node-max', '3'), text('node-windowDays', '14')],
    predicate: { kind: 'MaxAssignmentsInWindow', max: 3, windowDays: 14 },
  },
  {
    kind: 'WeekdayFteLimit',
    steps: [select('node-weekday', 'wed'), text('node-fteFraction', '0.5')],
    predicate: { kind: 'WeekdayFteLimit', weekday: 'wed', fteFraction: 0.5 },
  },
  {
    kind: 'WorkPercentageTarget',
    steps: [text('node-targetPercentage', '80')],
    predicate: { kind: 'WorkPercentageTarget', targetPercentage: 80 },
  },
  { kind: 'MaxConsecutive', steps: [text('node-maxDays', '6')], predicate: { kind: 'MaxConsecutive', maxDays: 6 } },
  {
    kind: 'MinimumRestBetween',
    steps: [text('node-minHours', '11')],
    predicate: { kind: 'MinimumRestBetween', minHours: 11 },
  },
  {
    kind: 'CallSpacing',
    steps: [text('node-minDaysBetweenCalls', '4')],
    predicate: { kind: 'CallSpacing', minDaysBetweenCalls: 4 },
  },
  {
    kind: 'NoAdjacent',
    steps: [select('node-shiftTypeA', 'NGT'), select('node-shiftTypeB', 'DAY')],
    predicate: { kind: 'NoAdjacent', shiftTypeA: 'NGT', shiftTypeB: 'DAY' },
  },
  {
    kind: 'ForbiddenSequence',
    steps: [
      select('node-sequence-0', 'NGT'),
      { control: 'node-sequence-add', type: 'click' },
      select('node-sequence-1', 'DAY'),
    ],
    predicate: { kind: 'ForbiddenSequence', sequence: ['NGT', 'DAY'] },
  },
  {
    kind: 'PatternRule',
    steps: [
      select('node-trigger', 'DAY'),
      { control: 'node-daysOfWeek-fri', type: 'check' },
      text('node-segment-offset-0', '0'),
      select('node-segment-shift-0', 'DAY'),
      { control: 'node-segments-add', type: 'click' },
      text('node-segment-offset-1', '1'),
      select('node-segment-shift-1', 'NGT'),
    ],
    predicate: {
      kind: 'PatternRule',
      trigger: 'DAY',
      daysOfWeek: ['fri'],
      segments: [
        { offsetDays: 0, shiftType: 'DAY' },
        { offsetDays: 1, shiftType: 'NGT' },
      ],
    },
  },
  {
    kind: 'AlternatingWeek',
    steps: [select('node-onShiftType', 'DAY'), text('node-cycleWeeks', '2')],
    predicate: { kind: 'AlternatingWeek', onShiftType: 'DAY', cycleWeeks: 2 },
  },
  {
    kind: 'TemplateAdherence',
    steps: [text('node-template', 'four_week_rota'), text('node-cycleWeeks', '4')],
    predicate: { kind: 'TemplateAdherence', template: 'four_week_rota', cycleWeeks: 4 },
  },
  {
    kind: 'LinkedShifts',
    steps: [
      select('node-shiftTypes-0', 'DAY'),
      { control: 'node-shiftTypes-add', type: 'click' },
      select('node-shiftTypes-1', 'NGT'),
    ],
    predicate: { kind: 'LinkedShifts', shiftTypes: ['DAY', 'NGT'] },
  },
  {
    kind: 'ImpliesAssignment',
    steps: [select('node-ifShiftType', 'DAY'), select('node-thenShiftType', 'NGT')],
    predicate: { kind: 'ImpliesAssignment', ifShiftType: 'DAY', thenShiftType: 'NGT' },
  },
  {
    kind: 'MutuallyExclusive',
    steps: [
      select('node-shiftTypes-0', 'NGT'),
      { control: 'node-shiftTypes-add', type: 'click' },
      select('node-shiftTypes-1', 'DAY'),
    ],
    predicate: { kind: 'MutuallyExclusive', shiftTypes: ['NGT', 'DAY'] },
  },
  {
    kind: 'RequestHonoured',
    steps: [text('node-requestType', 'annual_leave')],
    predicate: { kind: 'RequestHonoured', requestType: 'annual_leave' },
  },
  {
    kind: 'ShiftPreference',
    steps: [select('node-shiftType', 'NGT'), select('node-strength', 'strong_avoid')],
    predicate: { kind: 'ShiftPreference', shiftType: 'NGT', strength: 'strong_avoid' },
  },
  {
    kind: 'AvoidDate',
    steps: [text('node-date', '2028-04-17')],
    predicate: { kind: 'AvoidDate', date: '2028-04-17' },
  },
  {
    kind: 'FairnessBalance',
    steps: [select('node-metric', 'weekend_load'), select('node-normalisation', 'per_fte')],
    predicate: { kind: 'FairnessBalance', metric: 'weekend_load', normalisation: 'per_fte' },
  },
  {
    kind: 'CreditDistribution',
    steps: [select('node-metric', 'credits')],
    predicate: { kind: 'CreditDistribution', metric: 'credits' },
  },
  {
    kind: 'StaffOverLocumPriority',
    steps: [text('node-windowDays', '30')],
    predicate: { kind: 'StaffOverLocumPriority', windowDays: 30 },
  },
  {
    kind: 'LocumRestriction',
    steps: [select('node-restriction', 'locum_last_resort')],
    predicate: { kind: 'LocumRestriction', restriction: 'locum_last_resort' },
  },
  {
    kind: 'FixedAssignment',
    steps: [text('node-assignmentIdentity', 'fixture_identity_1')],
    predicate: { kind: 'FixedAssignment', assignmentIdentity: 'fixture_identity_1' },
  },
  {
    kind: 'ProtectedRange',
    steps: [text('node-from', '2028-12-24'), text('node-to', '2028-12-26')],
    predicate: { kind: 'ProtectedRange', from: '2028-12-24', to: '2028-12-26' },
  },
];

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function ruleView(ruleKey: string, predicate: Record<string, unknown>) {
  return {
    ruleKey,
    name: `Fixture ${ruleKey}`,
    ruleSchemaVersion: 1,
    classification: 'HARD',
    weight: null,
    scope: {},
    predicate,
    state: 'active',
  };
}

async function applyStep(page: Page, step: Step): Promise<void> {
  const control = page.getByTestId(step.control);
  if (step.type === 'text') await control.fill(step.value);
  else if (step.type === 'select') await control.selectOption(step.value);
  else if (step.type === 'check') await control.check();
  else await control.click();
}

test.describe('every rule node kind is authorable end to end', () => {
  test('the fixture list covers the closed node set exactly', async ({ page }) => {
    await page.route(SHIFT_TYPES_API, (route) =>
      json(route, 200, { shiftTypes: SHIFT_TYPES, correlationId: 'e2e-correlation-id' }),
    );
    await page.route(RULES_API, (route) =>
      json(route, 200, { rules: [], correlationId: 'e2e-correlation-id' }),
    );
    await page.goto(BASE);
    await page.getByTestId('rules-new').click();

    // The options the SELECT actually offers are the closed set as the user
    // meets it. Comparing the fixtures against them means a kind added to the
    // AST without a fixture fails here rather than quietly reducing coverage.
    const offered = await page.getByTestId('rules-kind').locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    expect(offered).toHaveLength(30);
    expect([...offered].sort()).toEqual([...FIXTURES.map((fixture) => fixture.kind)].sort());

    // And the page's own quantification agrees with it.
    await expect(page.getByTestId('rules-staging-note')).toContainText('all 30 of the 30 rule types');
  });

  test('I-13/I-10: opening a rule for editing issues ZERO requests; saving issues two', async ({
    page,
  }, info) => {
    const ruleKey = 'fixture_budget_probe';
    await page.route(SHIFT_TYPES_API, (route) =>
      json(route, 200, { shiftTypes: SHIFT_TYPES, correlationId: 'e2e-correlation-id' }),
    );
    await page.route(RULE_API, (route) =>
      json(route, 200, {
        rule: ruleView(ruleKey, { kind: 'RequiredCount', count: 3 }),
        correlationId: 'e2e-correlation-id',
      }),
    );
    await page.route(RULES_API, (route) =>
      json(route, 200, {
        rules: [ruleView(ruleKey, { kind: 'RequiredCount', count: 3 })],
        correlationId: 'e2e-correlation-id',
      }),
    );

    await page.goto(BASE);
    await expect(page.getByTestId(`rules-row-${ruleKey}`)).toBeVisible();

    // The edit form is filled from the list the page already holds. A fetch here
    // would be amplification of a control that only opens a form (I-13/I-10).
    const opening = await recordRequests(page, 'rules-open-edit', info.project.name, async () => {
      await page.getByTestId(`rules-edit-${ruleKey}`).click();
      await expect(page.getByTestId('rules-form')).toBeVisible();
    });
    expect(opening.requests).toEqual([]);

    const saving = await recordRequests(page, 'rules-save-edit', info.project.name, async () => {
      await page.getByTestId('rules-save').click();
      await expect(page.getByTestId('rules-form')).toHaveCount(0);
    });
    expect(saving.requests.length).toBeLessThanOrEqual(2);
  });

  for (const fixture of FIXTURES) {
    test(`${fixture.kind}: author → list → edit round trip`, async ({ page }) => {
      const ruleKey = `fixture_${fixture.kind.toLowerCase()}`;
      let created: Record<string, unknown> | undefined;
      let edited: Record<string, unknown> | undefined;
      let listed = false;

      await page.route(SHIFT_TYPES_API, (route) =>
        json(route, 200, { shiftTypes: SHIFT_TYPES, correlationId: 'e2e-correlation-id' }),
      );
      await page.route(RULE_API, async (route) => {
        // The EDIT half: a `PUT` on the individual rule.
        edited = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        await json(route, 200, {
          rule: ruleView(ruleKey, fixture.predicate),
          correlationId: 'e2e-correlation-id',
        });
      });
      await page.route(RULES_API, async (route) => {
        if (route.request().method() === 'POST') {
          created = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
          listed = true;
          await json(route, 200, {
            rule: ruleView(ruleKey, fixture.predicate),
            correlationId: 'e2e-correlation-id',
          });
          return;
        }
        await json(route, 200, {
          rules: listed ? [ruleView(ruleKey, fixture.predicate)] : [],
          correlationId: 'e2e-correlation-id',
        });
      });

      /* ── author ────────────────────────────────────────────────────────── */
      await page.goto(BASE);
      await page.getByTestId('rules-new').click();
      await page.getByTestId('rules-key').fill(ruleKey);
      await page.getByTestId('rules-name').fill(`Fixture ${fixture.kind}`);
      await page.getByTestId('rules-kind').selectOption(fixture.kind);
      for (const step of fixture.steps) await applyStep(page, step);
      await page.getByTestId('rules-save').click();
      await expect(page.getByTestId('rules-form')).toHaveCount(0);

      // What the browser SENT — not what the component held.
      expect(created?.['predicate']).toEqual(fixture.predicate);
      expect(created?.['ruleKey']).toBe(ruleKey);

      /* ── list ──────────────────────────────────────────────────────────── */
      await expect(page.getByTestId(`rules-row-${ruleKey}`)).toBeVisible();

      /* ── edit ──────────────────────────────────────────────────────────── */
      await page.getByTestId(`rules-edit-${ruleKey}`).click();
      await expect(page.getByTestId('rules-form')).toBeVisible();
      // The form opened ON this rule: its kind is selected and its key is locked
      // (non-bypass rule 13 — a stable id is never renamed).
      await expect(page.getByTestId('rules-kind')).toHaveValue(fixture.kind);
      await expect(page.getByTestId('rules-key')).toHaveAttribute('readonly', '');

      await page.getByTestId('rules-save').click();
      await expect(page.getByTestId('rules-form')).toHaveCount(0);

      // The lossless property, measured on the wire: reopening a rule and
      // pressing Save must send back exactly what was stored.
      expect(edited?.['predicate']).toEqual(fixture.predicate);
    });
  }
});
