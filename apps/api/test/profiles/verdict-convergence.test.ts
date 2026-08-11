import { createShiftTypeRequestSchema } from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as catalogue from '../../src/catalogue/service.js';
import {
  findQualificationRequirementFindings,
  instantOfDate,
} from '../../src/schedule/hard-rule-revalidation.js';
import {
  addManualAssignment,
  createDraftVersion,
  createPeriod,
} from '../../src/schedule/service.js';
import {
  changeHoldingStatus,
  createQualification,
  grantHolding,
  setQualificationStatus,
} from '../../src/profiles/qualifications.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **The manual path and the publication path produce THE SAME VERDICT** —
 * same fixture, same instant, asserted (OPUS-M4-000A; doc 35 §3 Tests).
 *
 * The manual consumer is `catalogue.listMembershipEligibility` (what the cell
 * editor's candidates and the eligibility read render); the publication
 * consumer is `findQualificationRequirementFindings` (what blocks a publish).
 * Both converge on `packages/domain/src/eligibility` — and this file is what
 * makes that a measured property rather than an intention: for every arranged
 * credential state, the outcome the manual path reports for (member, shift
 * type, date) equals the outcome the publication path attaches to the
 * assignment on that date.
 *
 * The boundary case is the load-bearing one: a holding valid UNTIL the
 * midday-UTC instant of date D is OUT at D (half-open) — `expired` on BOTH
 * paths, never `satisfied` on one and `expired` on the other.
 *
 * ## Every test OWNS its arrangement (FAD-15)
 *
 * `arrange()` builds a fresh shift type, a fresh qualification, its
 * requirement edge, the specified holdings, and a draft version with one
 * assignment per date — per TEST. The first version of this file shared one
 * arrangement across the tests and the fixture-regression gate caught it on
 * its first shuffled seed: the revoke/retire arms mutate credential state,
 * and under test-order shuffle they ran before the satisfied/boundary arm.
 *
 * The MUTATION CONTROL evaluates the manual path one day EARLIER and asserts
 * the equality oracle rejects the pair — an equality that cannot fail proves
 * nothing.
 */

const multi = ownedMulti('verdict-convergence', { seed: { catalogue: ['alpha'] } });

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

/** The scheduler is caller AND subject: own holdings are readable without read_any. */
const schedulerContext = (correlationId: string) => ({
  organizationId: alpha().organizationId,
  groupId: alpha().groupOne.id,
  membershipId: alpha().users.scheduler.membershipId,
  correlationId,
});

/* The STAFFING actor is `groupOnly`, not the scheduler: the catalogue seeding
 * temporarily granted (and then closed) staffing keys on the scheduler, and
 * `capability_grants_no_overlapping_window` refuses re-opening a window over a
 * closed row — the same constraint step-06 records. `groupOnly` has no closed
 * windows in the way. */
const staffingContext = (correlationId: string) => ({
  organizationId: alpha().organizationId,
  groupId: alpha().groupOne.id,
  membershipId: alpha().users.groupOnly.membershipId,
  correlationId,
});

const run = async <T>(correlationId: string, fn: (uow: never) => Promise<T>): Promise<T> =>
  runtime.runner.run(schedulerContext(correlationId), fn as never) as Promise<T>;

const staffingRun = async <T>(correlationId: string, fn: (uow: never) => Promise<T>): Promise<T> =>
  runtime.runner.run(staffingContext(correlationId), fn as never) as Promise<T>;

/** Dates chosen so a holding can expire EXACTLY at DATE_BOUNDARY's evaluation instant. */
const DATE_SATISFIED = '2035-03-05';
const DATE_BOUNDARY = '2035-03-06';
const DATE_AFTER = '2035-03-07';
const DATES = [DATE_SATISFIED, DATE_BOUNDARY, DATE_AFTER] as const;

/* Periods must not overlap per group (D-2), so each arrangement takes its own
 * month; the three dates keep their day-of-month shape. */
let arrangementCounter = 0;

interface Arrangement {
  readonly shiftTypeId: string;
  readonly qualificationId: string;
  readonly qualificationVersion: number;
  readonly versionId: string;
  readonly dates: readonly [string, string, string];
  readonly holdingId: string | null;
  readonly holdingVersion: number | null;
}

/**
 * A fresh, fully-owned fixture: shift type + qualification + requirement +
 * (optionally) one holding of the scheduler + a draft with one assignment per
 * date. `validUntil: null` means open-ended; `holding: null` means none.
 */
async function arrange(
  label: string,
  holding: { readonly validFrom: string; readonly validUntil: string | null } | null,
): Promise<Arrangement> {
  arrangementCounter += 1;
  const n = arrangementCounter;
  const month = String(((n - 1) % 9) + 1).padStart(2, '0');
  const year = String(2035 + Math.floor((n - 1) / 9));
  const dates = DATES.map((date) => `${year}-${month}-${date.slice(8)}`) as [
    string,
    string,
    string,
  ];

  const created = await run(`${label}-shift-type`, (uow) =>
    catalogue.createShiftType(
      uow as never,
      createShiftTypeRequestSchema.parse({
        code: `VC${String(n)}`,
        name: `Verdict subject ${String(n)}`,
        startTime: '08:00',
        endTime: '16:00',
      }),
    ),
  );
  if (created.kind !== 'ok') throw new Error(`${label}: shift type ${created.kind}`);
  const shiftTypeId = created.value.shiftTypeId;

  const qualification = await staffingRun(`${label}-qualification`, (uow) =>
    createQualification(uow as never, {
      key: `verdict-credential-${String(n)}`,
      name: `Verdict credential ${String(n)}`,
    }),
  );

  const requirement = await run(`${label}-requirement`, (uow) =>
    catalogue.replaceShiftTypeQualifications(uow as never, shiftTypeId, {
      qualificationIds: [qualification.id],
      expectedVersion: 1,
    }),
  );
  if (requirement.kind !== 'ok') throw new Error(`${label}: requirement ${requirement.kind}`);

  let holdingId: string | null = null;
  let holdingVersion: number | null = null;
  if (holding !== null) {
    const granted = await staffingRun(`${label}-holding`, (uow) =>
      grantHolding(uow as never, {
        membershipId: alpha().users.scheduler.membershipId,
        qualificationId: qualification.id,
        validFrom: holding.validFrom,
        validUntil: holding.validUntil,
        status: 'valid',
      }),
    );
    holdingId = granted.id;
    holdingVersion = granted.version;
  }

  const actor = scheduleActor(alpha().users.scheduler.id);
  const versionId = await run(`${label}-version`, async (uow) => {
    const periodId = await createPeriod(uow as never, actor, {
      name: `Verdict window ${String(n)}`,
      startDate: dates[0],
      endDate: dates[2],
    });
    const draft = await createDraftVersion(uow as never, actor, periodId);
    for (const date of dates) {
      await addManualAssignment(uow as never, actor, {
        versionId: draft,
        membershipId: alpha().users.scheduler.membershipId,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 8),
        endsAt: fixtureInstant(date, 16),
      } as never);
    }
    return draft;
  });

  return {
    shiftTypeId,
    qualificationId: qualification.id,
    qualificationVersion: qualification.version,
    versionId,
    dates,
    holdingId,
    holdingVersion,
  };
}

/** The manual path's outcome for the arrangement's (shift type, qualification) at `at`. */
async function manualOutcome(
  arrangement: Arrangement,
  at: Date,
  correlationId: string,
): Promise<string> {
  const rows = await run(correlationId, (uow) =>
    catalogue.listMembershipEligibility(uow as never, alpha().users.scheduler.membershipId, at),
  );
  const row = rows.find((entry) => entry.shiftTypeId === arrangement.shiftTypeId);
  if (row === undefined) throw new Error('the shift type vanished from the eligibility read');
  const outcome = row.qualificationOutcomes.find(
    (entry) => entry.qualificationId === arrangement.qualificationId,
  );
  return outcome?.outcome ?? 'satisfied';
}

/** The publication path's outcome for the arrangement's assignment dated `date`. */
async function publicationOutcome(
  arrangement: Arrangement,
  date: string,
  correlationId: string,
): Promise<string> {
  const findings = await run(correlationId, (uow) =>
    findQualificationRequirementFindings(uow as never, arrangement.versionId),
  );
  const finding = findings.find(
    (entry) => entry.date === date && entry.qualificationId === arrangement.qualificationId,
  );
  // No finding for the date means the requirement was satisfied there.
  return finding?.outcome ?? 'satisfied';
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 4 });

  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    membershipId: alpha().users.groupOnly.membershipId,
    capabilities: [
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
    ],
  });
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('one fixture, one instant, one verdict', () => {
  it('satisfied / boundary-expired / expired agree across both consumers, per date', async () => {
    // The ONE holding expires EXACTLY at the boundary date's evaluation
    // instant. Granted after arrange() because the bound is derived from the
    // month arrange() allocated.
    const arrangement = await arrange('boundary', null);
    await staffingRun('boundary-holding', async (uow) => {
      await grantHolding(uow as never, {
        membershipId: alpha().users.scheduler.membershipId,
        qualificationId: arrangement.qualificationId,
        validFrom: '2030-01-01T00:00:00.000Z',
        validUntil: instantOfDate(arrangement.dates[1]).toISOString(),
        status: 'valid',
      });
    });

    const expectations = [
      { date: arrangement.dates[0], expected: 'satisfied' },
      // The boundary: valid UNTIL the instant is OUT at the instant.
      { date: arrangement.dates[1], expected: 'expired' },
      { date: arrangement.dates[2], expected: 'expired' },
    ] as const;

    for (const { date, expected } of expectations) {
      const manual = await manualOutcome(arrangement, instantOfDate(date), `manual-${date}`);
      const publication = await publicationOutcome(arrangement, date, `publication-${date}`);
      expect(manual, `manual path at ${date}`).toBe(expected);
      expect(
        publication,
        `the two consumers disagree at ${date}: manual=${manual} publication=${publication}`,
      ).toBe(manual);
    }
    log('satisfied/expired boundary: manual and publication verdicts identical per date');
  });

  it('MISSING agrees across both consumers', async () => {
    const arrangement = await arrange('missing', null);
    const manual = await manualOutcome(
      arrangement,
      instantOfDate(arrangement.dates[0]),
      'manual-missing',
    );
    const publication = await publicationOutcome(arrangement, arrangement.dates[0], 'pub-missing');
    expect(manual).toBe('missing');
    expect(publication).toBe(manual);
    log('missing: manual and publication verdicts identical');
  });

  it('REVOKED agrees across both consumers', async () => {
    const arrangement = await arrange('revoked', {
      validFrom: '2030-01-01T00:00:00.000Z',
      validUntil: null,
    });
    await staffingRun('revoke', async (uow) => {
      if (arrangement.holdingId === null || arrangement.holdingVersion === null) {
        throw new Error('the arrangement holds no credential');
      }
      await changeHoldingStatus(uow as never, {
        holdingId: arrangement.holdingId,
        status: 'revoked',
        expectedVersion: arrangement.holdingVersion,
      });
    });

    const manual = await manualOutcome(
      arrangement,
      instantOfDate(arrangement.dates[0]),
      'manual-revoked',
    );
    const publication = await publicationOutcome(arrangement, arrangement.dates[0], 'pub-revoked');
    expect(manual).toBe('revoked');
    expect(publication).toBe(manual);
    log('revoked: manual and publication verdicts identical');
  });

  it('FUTURE agrees across both consumers', async () => {
    const arrangement = await arrange('future', {
      validFrom: '2099-01-01T00:00:00.000Z',
      validUntil: null,
    });
    const manual = await manualOutcome(
      arrangement,
      instantOfDate(arrangement.dates[0]),
      'manual-future',
    );
    const publication = await publicationOutcome(arrangement, arrangement.dates[0], 'pub-future');
    expect(manual).toBe('future');
    expect(publication).toBe(manual);
    log('future: manual and publication verdicts identical');
  });

  it('RETIRED agrees across both consumers, and outranks the holding', async () => {
    const arrangement = await arrange('retired', {
      validFrom: '2030-01-01T00:00:00.000Z',
      validUntil: null,
    });
    await staffingRun('retire', (uow) =>
      setQualificationStatus(uow as never, {
        qualificationId: arrangement.qualificationId,
        status: 'retired',
        expectedVersion: arrangement.qualificationVersion,
      }),
    );

    const manual = await manualOutcome(
      arrangement,
      instantOfDate(arrangement.dates[0]),
      'manual-retired',
    );
    const publication = await publicationOutcome(arrangement, arrangement.dates[0], 'pub-retired');
    expect(manual).toBe('retired');
    expect(publication).toBe(manual);
    log('retired: manual and publication verdicts identical, lifecycle first');
  });

  it('AGGREGATE PRECEDENCE over several holdings of ONE qualification agrees across both consumers', async () => {
    /* The reviewer's coverage note (OPUS-M4-000A condition C4): every case
     * above arranges at most ONE holding per qualification, so the verdict's
     * aggregate precedence (revoked > expired > future) is exercised only by
     * the domain property tests. Overlapping holdings of one credential are
     * legitimate and deliberate — `qualification_holdings_unique_issue` keys on
     * `valid_from` precisely so a renewal can be issued before the previous
     * certificate lapses — so the api-side convergence proof should see the
     * fold too.
     *
     * Own arrangement, own shift type, own qualification, own holdings
     * (FAD-15): nothing here is shared with any other case in this file. */
    const arrangement = await arrange('aggregate', null);
    const at = arrangement.dates[0];

    // Holding 1 — lapsed before the evaluated date: `expired`.
    await staffingRun('aggregate-expired', async (uow) => {
      await grantHolding(uow as never, {
        membershipId: alpha().users.scheduler.membershipId,
        qualificationId: arrangement.qualificationId,
        validFrom: '2029-01-01T00:00:00.000Z',
        validUntil: instantOfDate(at).toISOString(),
        status: 'valid',
      });
    });
    // Holding 2 — the renewal, not yet started: `future`.
    await staffingRun('aggregate-future', async (uow) => {
      await grantHolding(uow as never, {
        membershipId: alpha().users.scheduler.membershipId,
        qualificationId: arrangement.qualificationId,
        validFrom: '2099-01-01T00:00:00.000Z',
        validUntil: null,
        status: 'valid',
      });
    });

    // expired > future: the fold is NOT "whichever holding was read first".
    const manualExpired = await manualOutcome(arrangement, instantOfDate(at), 'aggregate-manual-1');
    const publicationExpired = await publicationOutcome(arrangement, at, 'aggregate-pub-1');
    expect(manualExpired, 'expired did not outrank future on the manual path').toBe('expired');
    expect(
      publicationExpired,
      `the two consumers disagree at ${at}: manual=${manualExpired} publication=${publicationExpired}`,
    ).toBe(manualExpired);

    // Holding 3 — a third issue of the SAME credential, revoked, and whose
    // window never covers the evaluated date. `revoked` is the loudest fact
    // whatever the window, so it must now outrank both of the above.
    const revokedHolding = await staffingRun('aggregate-revoked', (uow) =>
      grantHolding(uow as never, {
        membershipId: alpha().users.scheduler.membershipId,
        qualificationId: arrangement.qualificationId,
        validFrom: '2030-01-01T00:00:00.000Z',
        validUntil: '2031-01-01T00:00:00.000Z',
        status: 'valid',
      }),
    );
    await staffingRun('aggregate-revoke', (uow) =>
      changeHoldingStatus(uow as never, {
        holdingId: revokedHolding.id,
        status: 'revoked',
        expectedVersion: revokedHolding.version,
      }),
    );

    const manualRevoked = await manualOutcome(arrangement, instantOfDate(at), 'aggregate-manual-2');
    const publicationRevoked = await publicationOutcome(arrangement, at, 'aggregate-pub-2');
    expect(manualRevoked, 'revoked did not outrank expired on the manual path').toBe('revoked');
    expect(
      publicationRevoked,
      `the two consumers disagree at ${at}: manual=${manualRevoked} publication=${publicationRevoked}`,
    ).toBe(manualRevoked);

    // The fold moved when the arrangement moved — the assertion above is live.
    expect(manualRevoked).not.toBe(manualExpired);
    log('aggregate precedence over three holdings of one qualification: expired > future, revoked > expired, both consumers');
  });

  it('MUTATION CONTROL: an off-by-one-day manual instant breaks the equality', async () => {
    /* The equality oracle must be able to fail. The same arrangement evaluated
     * at two instants gives two answers, so a convergence check that compared
     * across a one-day skew would report the disagreement this control pins. */
    const arrangement = await arrange('control', null);
    await staffingRun('control-holding', async (uow) => {
      await grantHolding(uow as never, {
        membershipId: alpha().users.scheduler.membershipId,
        qualificationId: arrangement.qualificationId,
        validFrom: '2030-01-01T00:00:00.000Z',
        validUntil: instantOfDate(arrangement.dates[1]).toISOString(),
        status: 'valid',
      });
    });

    const atBoundary = await manualOutcome(
      arrangement,
      instantOfDate(arrangement.dates[1]),
      'control-at',
    );
    const dayEarly = await manualOutcome(
      arrangement,
      instantOfDate(arrangement.dates[0]),
      'control-early',
    );

    expect(atBoundary).toBe('expired');
    expect(dayEarly).toBe('satisfied');
    expect(atBoundary).not.toBe(dayEarly);
    log('mutation control: shifting the instant one day flips the verdict — the equality is live');
  });
});
