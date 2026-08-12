import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import type { TenantContext } from '@schedulepoint/domain';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { grantHolding } from '../../src/profiles/qualifications.js';
import { createRule, getRule, setRuleState } from '../../src/rules/service.js';
import {
  HardRuleBreachError,
  findHardRuleFindings,
  instantOfDate,
} from '../../src/schedule/hard-rule-revalidation.js';
import { publishVersion } from '../../src/schedule/publication.js';
import { calendarDate } from '../../src/schedule/render.js';
import {
  addManualAssignment,
  createDraftVersion,
  createPeriod,
  transitionVersion,
} from '../../src/schedule/service.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { grantStaffingCapabilities } from '../support/staffing.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, publicationKey, scheduleActor } from '../support/schedule.js';

/**
 * **SPEC-05 §6 step 06 against a real database** — the named proof of
 * OPUS-M3-008's central deliverable.
 *
 * ## Falsifiability is the point of this file
 *
 * A publication that is refused proves nothing on its own: it could be refused
 * by step 03, step 05, the period lock, a constraint, or a typo. So every
 * blocking claim below is paired with the SAME content publishing successfully
 * once the rule is `disabled` — the one fact that changed. If the refusal
 * survived disabling the rule, the rule was not what refused it.
 *
 * ## Everything goes through the production write path
 *
 * Rules are authored with `createRule`, assignments with `addManualAssignment`,
 * publications with `publishVersion`. A test that inserted rows directly would
 * be proving a property of states the application cannot reach.
 */

const multi = ownedMulti('step-06-hard-rules', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: TenantContext;
let actor: ReturnType<typeof scheduleActor>;
let shiftTypeId: string;
/** An ON-CALL shift type (`shift_types.is_on_call`) — the fixture's NIGHT. */
let onCallShiftTypeId: string;
let assignee: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/**
 * Disable a rule, reading its CAS token first (OPUS-M4-000C, doc 34 §4-D).
 *
 * `setRuleState` now requires `expectedVersion` — a lifecycle move is a mutation
 * like any other, and archiving is terminal. The falsifiability controls in this
 * file do not care WHICH version they are disabling, only that the rule ends up
 * disabled, so they read the current one first. A test that hard-coded a version
 * number would start failing the day a rule gained an extra edit.
 */
const disableRule = async (uow: PgUnitOfWork, ruleKey: string): Promise<void> => {
  const found = await getRule(uow, ruleKey);
  if (found.kind !== 'ok') throw new Error(`no rule ${ruleKey} to disable`);
  const outcome = await setRuleState(uow, ruleKey, 'disabled', found.value.version);
  if (outcome.kind !== 'ok') throw new Error(`could not disable ${ruleKey}: ${outcome.kind}`);
};

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
  const fixture = multi();
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) throw new Error('needs the alpha catalogue seed');
  const type = catalogue.shiftTypeIds[0];
  if (type === undefined) throw new Error('no shift type');
  shiftTypeId = type;

  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'step-06-hard-rules',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
  assignee = fixture.alpha.users.member.membershipId;

  /* The ON-CALL one, found by READING `is_on_call` rather than by trusting an
   * index into the fixture array — the column is what `CallSpacing` keys on, so
   * a test that assumed which element it was would pass if the fixture were
   * reordered and the checker were broken. */
  const onCall = await runtime.runner.run(context, async (uow) =>
    uow.query
      .selectFrom('shift_types')
      .select(['id', 'code'])
      .where('is_on_call', '=', true)
      .orderBy('code')
      .executeTakeFirstOrThrow(),
  );
  onCallShiftTypeId = onCall.id;
  if (onCallShiftTypeId === shiftTypeId) {
    throw new Error('the fixture has no shift type that is NOT on call — the control is vacuous');
  }


});

afterAll(async () => {
  await runtime?.destroy();
});

/** An approved version holding the given dates, on its own period. */
async function approvedVersionOn(
  label: string,
  dates: readonly string[],
  membershipId?: string,
  useShiftTypeId?: string,
): Promise<{ periodId: string; versionId: string }> {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) throw new Error('no dates');
  const periodId = await run(async (uow) =>
    createPeriod(uow, actor, { name: `${label} period`, startDate: first, endDate: last }),
  );
  const versionId = await run(async (uow) => {
    const draft = await createDraftVersion(uow, actor, periodId);
    for (const date of dates) {
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: membershipId ?? assignee,
        shiftTypeId: useShiftTypeId ?? shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 8),
        endsAt: fixtureInstant(date, 16),
      });
    }
    await transitionVersion(uow, actor, draft, 'in_review');
    await transitionVersion(uow, actor, draft, 'approved');
    return draft;
  });
  return { periodId, versionId };
}

async function publish(periodId: string, versionId: string, key: string): Promise<void> {
  await run(async (uow) =>
    publishVersion(uow, actor, {
      periodId,
      versionId,
      idempotencyKey: key,
      expectedPriorCurrentVersionId: null,
    }),
  );
}

async function versionState(versionId: string): Promise<string> {
  const row = await run(async (uow) =>
    uow.query
      .selectFrom('schedule_versions')
      .select('state')
      .where('id', '=', versionId)
      .executeTakeFirstOrThrow(),
  );
  return row.state;
}

describe('step 06 — a breached HARD rule BLOCKS publication, and disabling it unblocks', () => {
  it('the same version is refused with the rule active and publishes with it disabled', async () => {
    const { periodId, versionId } = await approvedVersionOn('breach', ['2033-02-10']);

    /* GREEN-BEFORE-RED. With no rule at all the version publishes, so the
     * refusal below cannot be an artefact of the fixture. This is a THIRD
     * version of the same content on its own period rather than the subject,
     * because publishing the subject would take it out of `approved`. */
    const control = await approvedVersionOn('breach-control', ['2033-02-11']);
    await publish(control.periodId, control.versionId, publicationKey('s06-control'));
    expect(await versionState(control.versionId)).toBe('published');

    await run(async (uow) => {
      const outcome = await createRule(uow, {
        ruleKey: 'no_work_on_2033_02_10',
        name: 'Synthetic: nobody works 2033-02-10',
        classification: 'HARD',
        scope: {},
        predicate: { kind: 'AvoidDate', date: '2033-02-10' },
      });
      expect(outcome.kind).toBe('ok');
    });

    await expect(publish(periodId, versionId, publicationKey('s06-blocked'))).rejects.toThrow(
      HardRuleBreachError,
    );

    /* The refusal ROLLED BACK. M3-005's self-found defect was a refusal that
     * committed the step-04 `publishing` write, leaving a version only the
     * reconciler could clear — the same failure would be available here. */
    expect(await versionState(versionId)).toBe('approved');

    // …and nothing was published: no supersession, no current-assignment rows.
    const published = await run(async (uow) =>
      uow.query
        .selectFrom('current_published_assignments')
        .select('id')
        .where('source_version_id', '=', versionId)
        .execute(),
    );
    expect(published).toEqual([]);

    /* FALSIFIABILITY. One fact moves — the rule becomes `disabled` — and the
     * identical publication succeeds. If this still failed, the refusal above
     * was never the rule's. */
    // `disableRule` throws if the state move is refused, so reaching the next
    // line IS the assertion that the rule is now disabled.
    await run(async (uow) => {
      await disableRule(uow, 'no_work_on_2033_02_10');
    });

    await publish(periodId, versionId, publicationKey('s06-after-disable'));
    expect(await versionState(versionId)).toBe('published');
  });

  it('the refusal names the rule_key and addresses the offending snapshot', async () => {
    const { versionId } = await approvedVersionOn('named', ['2033-03-05']);
    await run(async (uow) => {
      await createRule(uow, {
        ruleKey: 'named_avoid_2033_03_05',
        name: 'Synthetic: named refusal',
        classification: 'HARD',
        scope: {},
        predicate: { kind: 'AvoidDate', date: '2033-03-05' },
      });
    });

    const findings = await run(async (uow) => findHardRuleFindings(uow, versionId));
    const mine = findings.filter((f) => f.ruleKey === 'named_avoid_2033_03_05');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.finding).toBe('breach');
    expect(mine[0]?.nodeKind).toBe('AvoidDate');
    // The addressed field is a real snapshot id in this version.
    const snapshot = await run(async (uow) =>
      uow.query
        .selectFrom('assignment_snapshots')
        .select('id')
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(mine[0]?.field).toBe(snapshot.id);

    await run(async (uow) => disableRule(uow, 'named_avoid_2033_03_05'));
  });

  it('a SOFT rule with the same predicate does not block', async () => {
    const { periodId, versionId } = await approvedVersionOn('soft', ['2033-04-07']);
    await run(async (uow) => {
      const outcome = await createRule(uow, {
        ruleKey: 'soft_avoid_2033_04_07',
        name: 'Synthetic: soft avoid',
        classification: 'SOFT',
        weight: 5,
        scope: {},
        predicate: { kind: 'AvoidDate', date: '2033-04-07' },
      });
      expect(outcome.kind).toBe('ok');
    });

    await publish(periodId, versionId, publicationKey('s06-soft'));
    expect(await versionState(versionId)).toBe('published');

    // The control: the SAME predicate as HARD refuses, so the success above is
    // the classification and not the predicate being inert.
    const hardSubject = await approvedVersionOn('soft-control', ['2033-04-08']);
    await run(async (uow) => {
      await createRule(uow, {
        ruleKey: 'hard_avoid_2033_04_08',
        name: 'Synthetic: hard avoid',
        classification: 'HARD',
        scope: {},
        predicate: { kind: 'AvoidDate', date: '2033-04-08' },
      });
    });
    await expect(
      publish(hardSubject.periodId, hardSubject.versionId, publicationKey('s06-soft-ctl')),
    ).rejects.toThrow(HardRuleBreachError);
    await run(async (uow) => disableRule(uow, 'hard_avoid_2033_04_08'));
    await run(async (uow) => disableRule(uow, 'soft_avoid_2033_04_07'));
  });

  it('an active HARD rule this system cannot evaluate BLOCKS rather than passing', async () => {
    const { periodId, versionId } = await approvedVersionOn('unevaluable', ['2033-05-02']);
    await run(async (uow) => {
      await createRule(uow, {
        ruleKey: 'coverage_not_evaluable',
        name: 'Synthetic: an unevaluable HARD rule',
        classification: 'HARD',
        scope: {},
        // `RequiredCount`'s grouping unit is not pinned by SPEC-04 §3.1.
        predicate: { kind: 'RequiredCount', count: 4 },
      });
    });

    const findings = await run(async (uow) => findHardRuleFindings(uow, versionId));
    const mine = findings.filter((f) => f.ruleKey === 'coverage_not_evaluable');
    expect(mine[0]?.finding).toBe('not-evaluable');

    await expect(publish(periodId, versionId, publicationKey('s06-uneval'))).rejects.toThrow(
      HardRuleBreachError,
    );
    expect(await versionState(versionId)).toBe('approved');

    // Falsifiability again: disabling it publishes.
    await run(async (uow) => disableRule(uow, 'coverage_not_evaluable'));
    await publish(periodId, versionId, publicationKey('s06-uneval-ok'));
    expect(await versionState(versionId)).toBe('published');
  });
});

describe('CallSpacing at publication — B-2, against a real database', () => {
  it('too-close ON-CALL shifts block; the same spacing in NON-CALL shifts does not', async () => {
    /* The arm that matters is the CONTROL: `CallSpacing` keys on
     * `shift_types.is_on_call`, and the reason it was recorded NOT-EVALUABLE was
     * a claim that no such column existed. So the same two dates are published
     * twice — once as on-call shifts (refused) and once as ordinary shifts
     * (published) — and the only difference is the column. */
    await run(async (uow) => {
      const outcome = await createRule(uow, {
        ruleKey: 'calls_three_days_apart',
        name: 'Synthetic: three days between calls',
        classification: 'HARD',
        scope: {},
        predicate: { kind: 'CallSpacing', minDaysBetweenCalls: 3 },
      });
      expect(outcome.kind).toBe('ok');
    });

    /* CONTROL FIRST: two NON-CALL assignments two days apart publish, with the
     * rule active. Without this arm, the refusal below could be the rule firing
     * on everything. */
    const control = await approvedVersionOn('callspacing-noncall', ['2034-04-03', '2034-04-05']);
    await publish(control.periodId, control.versionId, publicationKey('s06-call-control'));
    expect(await versionState(control.versionId)).toBe('published');

    // The same two dates, as ON-CALL shifts: a gap of 2 against a minimum of 3.
    const subject = await approvedVersionOn(
      'callspacing-oncall',
      ['2034-05-03', '2034-05-05'],
      undefined,
      onCallShiftTypeId,
    );

    const findings = await run(async (uow) => findHardRuleFindings(uow, subject.versionId));
    const mine = findings.filter((f) => f.ruleKey === 'calls_three_days_apart');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.finding).toBe('breach');
    expect(mine[0]?.nodeKind).toBe('CallSpacing');
    expect(mine[0]?.explanation).toContain('2 day(s) after');

    await expect(
      publish(subject.periodId, subject.versionId, publicationKey('s06-call-blocked')),
    ).rejects.toThrow(HardRuleBreachError);
    expect(await versionState(subject.versionId)).toBe('approved');

    // FALSIFIABILITY: one fact moves — the rule is disabled — and it publishes.
    await run(async (uow) => disableRule(uow, 'calls_three_days_apart'));
    await publish(subject.periodId, subject.versionId, publicationKey('s06-call-ok'));
    expect(await versionState(subject.versionId)).toBe('published');
  });

  it('on-call shifts EXACTLY the minimum apart publish', async () => {
    await run(async (uow) => {
      await createRule(uow, {
        ruleKey: 'calls_three_days_apart_boundary',
        name: 'Synthetic: the boundary',
        classification: 'HARD',
        scope: {},
        predicate: { kind: 'CallSpacing', minDaysBetweenCalls: 3 },
      });
    });

    // 3rd and 6th: a difference of exactly 3.
    const at = await approvedVersionOn(
      'callspacing-boundary',
      ['2034-06-03', '2034-06-06'],
      undefined,
      onCallShiftTypeId,
    );
    const findings = await run(async (uow) => findHardRuleFindings(uow, at.versionId));
    expect(findings.filter((f) => f.ruleKey === 'calls_three_days_apart_boundary')).toEqual([]);
    await publish(at.periodId, at.versionId, publicationKey('s06-call-boundary'));
    expect(await versionState(at.versionId)).toBe('published');

    await run(async (uow) => disableRule(uow, 'calls_three_days_apart_boundary'));
  });
});

describe('qualification expiry against the ASSIGNMENT DATE (packet 32 §10f deliverable 2)', () => {
  /**
   * A holding valid to 2033-06-15T00:00:00Z, over a period spanning the 10th to
   * the 20th. Exactly the assignments dated ON or AFTER the expiry must be
   * blocked, and exactly the ones before must not be — "a holding expiring
   * mid-period blocks exactly the assignments on dates after expiry".
   */
  it('a mid-period expiry blocks exactly the dates after it, and no others', async () => {
    /* The SUBJECT is the scheduler's own membership, so `loadHoldings` reads its
     * own holdings under the SENSITIVE-PII SELECT policy without needing
     * `staffing.qualification_holding.read_any`. That is a fixture choice, not a
     * narrowing of the claim: the checker asks the same question of every
     * membership, and the cross-membership visibility rule is CAP-058's and is
     * proven in `apps/api/test/profiles/`.
     *
     * The QUALIFICATION is the one the catalogue seed already wrote, because the
     * seed grants `staffing.qualification.administer` and then deliberately
     * CLOSES it again (SBX-001's oracle depends on that), and re-granting an
     * open window over a closed row is refused by
     * `capability_grants_no_overlapping_window`. Reusing the seeded vocabulary
     * is the honest way round it rather than reopening a grant the fixture
     * closed on purpose. */
    const fixture = multi();
    const alphaCatalogue = fixture.catalogue?.alpha;
    if (alphaCatalogue === undefined) throw new Error('needs the alpha catalogue seed');
    const qualificationId = alphaCatalogue.qualificationId;

    const qualificationKey = (
      await run(async (uow) =>
        uow.query
          .selectFrom('qualifications')
          .select('key')
          .where('id', '=', qualificationId)
          .executeTakeFirstOrThrow(),
      )
    ).key;

    const granted = await grantStaffingCapabilities(runtime.runner, fixture, {
      organizationId: context.organizationId,
      groupId: context.groupId ?? '',
      membershipId: context.membershipId ?? '',
      capabilities: ['staffing.qualification_holding.administer'],
    });
    expect(granted.grantIds).toHaveLength(1);

    const subject = context.membershipId ?? '';

    /* OPUS-M4-000A: this file opts into `scheduleCredentials`, which seeds an
     * OPEN-ENDED valid holding of this very qualification for the scheduler so
     * the structural publication gate admits the file's other fixtures. An
     * open-ended holding would satisfy every date and dissolve the boundary
     * this test exists to pin — so it is REVOKED first, through the production
     * status machine. A revoked holding confers nothing (the verdict's rule 4),
     * and the dated holdings below then carry the boundary alone. */
    await run(async (uow) => {
      const seeded = (await uow.query
        .selectFrom('qualification_holdings')
        .select(['id', 'version'])
        .where('membership_id', '=', subject)
        .where('qualification_id', '=', qualificationId)
        .where('valid_until', 'is', null)
        .execute()) as unknown as { id: string; version: number }[];
      const { changeHoldingStatus } = await import('../../src/profiles/qualifications.js');
      for (const row of seeded) {
        await changeHoldingStatus(uow, {
          holdingId: row.id,
          status: 'revoked',
          expectedVersion: row.version,
        });
      }
    });

    await run(async (uow) => {
      const holding = await grantHolding(uow, {
        membershipId: subject,
        qualificationId,
        validFrom: '2030-01-01T00:00:00.000Z',
        validUntil: '2033-06-15T00:00:00.000Z',
        status: 'valid',
      });
      expect(holding.status).toBe('valid');
    });

    const dates = ['2033-06-11', '2033-06-13', '2033-06-17', '2033-06-19'];
    const { periodId, versionId } = await approvedVersionOn('expiry', dates, subject);

    await run(async (uow) => {
      const outcome = await createRule(uow, {
        ruleKey: 'requires_midperiod_credential',
        name: 'Synthetic: the shift needs the credential',
        classification: 'HARD',
        scope: {},
        predicate: {
          kind: 'RequiresQualification',
          qualification: qualificationKey,
          validAt: 'shift_date',
        },
      });
      expect(outcome.kind).toBe('ok');
    });

    const findings = await run(async (uow) => findHardRuleFindings(uow, versionId));
    const mine = findings.filter((f) => f.ruleKey === 'requires_midperiod_credential');

    // Map each finding back to the DATE it addresses, so the assertion is about
    // dates rather than about opaque ids.
    const snapshots = await run(async (uow) =>
      uow.query
        .selectFrom('assignment_snapshots')
        .select(['id', 'date'])
        .where('version_id', '=', versionId)
        .execute(),
    );
    const dateById = new Map(
      snapshots.map((row) => [row.id, calendarDate(row.date as string | Date)]),
    );
    const blockedDates = mine.map((finding) => dateById.get(finding.field)).sort();

    // EXACTLY the dates after expiry. The two before it are not blocked, which
    // is the half that makes this a boundary proof rather than a smoke test.
    expect(blockedDates).toEqual(['2033-06-17', '2033-06-19']);

    // The publication refuses for exactly this reason.
    await expect(publish(periodId, versionId, publicationKey('s06-expiry'))).rejects.toThrow(
      HardRuleBreachError,
    );
    expect(await versionState(versionId)).toBe('approved');

    /* FALSIFIABILITY, and it is the CREDENTIAL that moves rather than the rule:
     * a renewal covering the rest of the period publishes the SAME content under
     * the SAME active rule. The holding window is immutable by design — a
     * renewed credential is a second holding, which is exactly how a real one is
     * recorded. */
    await run(async (uow) => {
      await grantHolding(uow, {
        membershipId: subject,
        qualificationId,
        validFrom: '2033-06-15T00:00:00.000Z',
        validUntil: '2034-01-01T00:00:00.000Z',
        status: 'valid',
      });
    });

    const afterRenewal = await run(async (uow) => findHardRuleFindings(uow, versionId));
    expect(afterRenewal.filter((f) => f.ruleKey === 'requires_midperiod_credential')).toEqual([]);

    await publish(periodId, versionId, publicationKey('s06-expiry-renewed'));
    expect(await versionState(versionId)).toBe('published');

    await run(async (uow) => disableRule(uow, 'requires_midperiod_credential'));
  });

  it('the evaluation instant for a date is midday UTC, so no offset moves the day', () => {
    // The convention is load-bearing (see `instantOfDate`), so it is pinned by a
    // test rather than left to a reader of the implementation.
    expect(instantOfDate('2033-06-15').toISOString()).toBe('2033-06-15T12:00:00.000Z');
  });
});

describe('the checker reads nothing it is not entitled to', () => {
  it('a version in a sibling group is invisible, so its findings are empty', async () => {
    const fixture = multi();
    const sibling = fixture.alpha.groupTwo;
    const { versionId } = await approvedVersionOn('isolation', ['2033-07-01']);

    const siblingContext: TenantContext = {
      ...context,
      groupId: sibling.id,
      membershipId: fixture.alpha.users.scheduler.membershipId,
    };

    // RLS hides the version's snapshots from the sibling group's context, so the
    // checker sees an empty version rather than another group's content.
    const findings = await runtime.runner.run(siblingContext, async (uow) =>
      findHardRuleFindings(uow, versionId),
    );
    expect(findings).toEqual([]);

    const visible = await runtime.runner.run(siblingContext, async (uow) =>
      sql<{
        n: string;
      }>`select count(*)::text as n from assignment_snapshots where version_id = ${versionId}`.execute(
        uow.query,
      ),
    );
    expect(visible.rows[0]?.n).toBe('0');
  });
});
