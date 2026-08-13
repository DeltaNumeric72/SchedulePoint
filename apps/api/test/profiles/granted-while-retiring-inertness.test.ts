import { createShiftTypeRequestSchema } from '@schedulepoint/contracts';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as catalogue from '../../src/catalogue/service.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  createQualification,
  grantHolding,
  setQualificationStatus,
} from '../../src/profiles/qualifications.js';
import {
  QualificationRequirementBreachError,
  assertHardRulesRevalidated,
  findQualificationRequirementFindings,
  instantOfDate,
} from '../../src/schedule/hard-rule-revalidation.js';
import {
  addManualAssignment,
  createDraftVersion,
  createPeriod,
  setRequirement,
} from '../../src/schedule/service.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';
import { grantStaffingCapabilities } from '../support/staffing.js';
import { waitUntilBlockedOnLock } from './lock-observation.js';

/**
 * **NAMED PROOF — the granted-while-retiring race is ADMITTED, and the
 * credential it produces is INERT** (OPUS-M4-001R; doc 35 §6b; FAD-28(2),
 * FAD-33(1), FAD-35).
 *
 * ## What this file exists to pin
 *
 * FAD-28 R1 refuses a NEW holding of a retired qualification at two layers: the
 * service (`QUALIFICATION_RETIRED`, 422) and migration 0012's trigger
 * `qualification_holdings_guard_expiry_retirement`. Neither is a write-time
 * *exclusion* under concurrency, and the M4-000A independent review measured
 * exactly that (probe P3e): with a grant transaction still open across a
 * retirement's commit, the trigger's lookup had already returned `active` under
 * READ COMMITTED, so nothing refused and **a holding of a now-retired
 * qualification exists in the table**.
 *
 * FAD-35 ruled that outcome authoritative and intentional: no write-time
 * exclusion is claimed or implemented, and the safety property is supplied by
 * the READ side — the shared verdict evaluates the qualification's lifecycle
 * FIRST (`packages/domain/src/eligibility`, ruling R3) and answers `retired`
 * even over an in-window `valid` holding. What was missing was a runnable
 * proof: P3e was a reviewer's probe, never retained, and nothing pinned the
 * race-produced holding inert through canonical solver input at all.
 *
 * So this file reproduces the interleaving through the real services on two
 * real connections, and asserts, in order:
 *
 *   (a) the holding row **exists** and the qualification is **retired** — the
 *       admission is measured here, not assumed from the review's transcript;
 *   (b) manual path — `catalogue.listMembershipEligibility` answers `retired`;
 *   (c) publication path — `findQualificationRequirementFindings` reports
 *       `retired` and `assertHardRulesRevalidated` BLOCKS (FAD-27 fail-closed);
 *   (d) solver input — `assembleCanonicalInput`'s snapshot marks the
 *       qualification `retired` for that participant and the pair ineligible.
 *
 * ## How the interleaving is made DETERMINISTIC, using only production code
 *
 * The obvious ordering — hold the grant open, commit the retirement beside it —
 * cannot be built out of the shipped services, and the reason is worth stating
 * because it is the reason this file looks the way it does. Every mutation here
 * writes an audit row, and migration 0003's `app_audit_assign_chain` takes a
 * **per-organization transaction-scoped advisory lock** (plus the chain-head tip
 * row) before it assigns a sequence. A grant transaction that reached its audit
 * insert therefore holds that lock until it commits, and a retirement in the
 * same organization could never commit beside it.
 *
 * Turning the pair around produces the interleaving exactly, with the lock doing
 * the synchronisation instead of a sleep:
 *
 *   1. the RETIREMENT transaction runs `setQualificationStatus` and stops before
 *      commit. It now holds the audit advisory lock, and its `UPDATE` holds
 *      `FOR NO KEY UPDATE` on the qualification row — which does **not** conflict
 *      with the `FOR KEY SHARE` the holding's foreign key will take;
 *   2. the GRANT transaction runs `grantHolding`. Its service lookup and 0012's
 *      trigger both read the qualification under READ COMMITTED, both see
 *      `active` (the retirement is uncommitted), and the holding row is
 *      inserted. The grant then **blocks** at its own audit insert;
 *   3. the test observes that block directly in `pg_stat_activity` and asserts
 *      the grant has NOT settled. That is the ordering proof: the grant cannot
 *      commit until the retirement releases the lock, i.e. until the retirement
 *      has committed;
 *   4. the retirement is released and commits; the grant then commits behind it.
 *
 * Nothing is stubbed, no statement is hand-rolled around a service, and no sleep
 * decides anything. If the audit chain ever stopped serialising, step 3's
 * assertion fails loudly rather than the file quietly measuring the wrong order.
 *
 * ## Falsifiability (FAD-33(1))
 *
 * This file is listed in `scripts/red-cases/run.mjs`'s `retired-verdict` case,
 * whose violation removes the verdict's retirement-first rule and which rebuilds
 * `packages/domain` between the patch and the run — so this api-side proof
 * observes the patched `dist`. With rule 1 removed the race-produced holding
 * confers again and (b), (c) and (d) all fail. Verified in both directions
 * standalone; the transcripts are in `docs/evidence/EV-M4-001R/`.
 *
 * ## The control, and why it lives in the same arrangement
 *
 * A file that only ever asserts `retired` proves nothing about the consumers —
 * a consumer that answered `retired` for everything would pass it. So the same
 * period and the same version carry a SECOND shift type and a SECOND
 * qualification whose holding was granted with no race at all, and every
 * consumer is asked about both. `retired` on one and `satisfied` on the other,
 * from the same read, is what makes the assertions live.
 *
 * ## Fixture ownership (FAD-15)
 *
 * The tenant is this file's own (`ownedMulti`), every shift type,
 * qualification, period, version, assignment and holding is created here, and
 * nothing in the shared baseline is touched. The race runs ONCE in `beforeAll`
 * because it is the file's single subject; every `it` afterwards is a pure READ
 * of the state it produced, so no case can disturb another and file- or
 * test-order shuffle cannot change an outcome.
 */

const multi = ownedMulti('granted-while-retiring-inertness', {
  seed: { catalogue: ['alpha'] },
});

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

/* The STAFFING actor is `groupOnly`, not the scheduler, for the reason
 * `verdict-convergence.test.ts` records: the catalogue seeding opens and closes
 * staffing keys on the scheduler, and `capability_grants_no_overlapping_window`
 * refuses re-opening a window over a closed row. */
const staffingContext = (correlationId: string) => ({
  organizationId: alpha().organizationId,
  groupId: alpha().groupOne.id,
  membershipId: alpha().users.groupOnly.membershipId,
  correlationId,
});

const run = async <T>(
  correlationId: string,
  fn: (uow: PgUnitOfWork) => Promise<T>,
): Promise<T> => runtime.runner.run(schedulerContext(correlationId), fn);

const staffingRun = async <T>(
  correlationId: string,
  fn: (uow: PgUnitOfWork) => Promise<T>,
): Promise<T> => runtime.runner.run(staffingContext(correlationId), fn);

/** Three consecutive days; the period covers all three. */
const DATES = ['2036-05-05', '2036-05-06', '2036-05-07'] as const;
/** The assembly instant. `instantOfDate` is midday UTC — the same convention. */
const BUILD_AT = fixtureInstant(DATES[0], 12);

/** What the race produced, read back from ground truth for the record. */
interface RaceRecord {
  readonly grantPid: number;
  readonly retirePid: number;
  readonly grantWaitEventType: string;
  readonly grantWaitEvent: string | null;
  /** `pg_blocking_pids()` for the grant — WHO is holding the lock it waits on. */
  readonly grantBlockedBy: readonly number[];
  readonly grantSettledWhileRetirementOpen: boolean;
}

let racedQualificationId = '';
let racedShiftTypeId = '';
let racedHoldingId = '';
let controlQualificationId = '';
let controlShiftTypeId = '';
let periodId = '';
let versionId = '';
let race: RaceRecord;

/** A promise plus its resolver — the gate that holds a transaction open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Creates a shift type and returns its id. */
async function createShiftType(label: string, code: string): Promise<string> {
  const created = await run(`${label}-shift-type`, (uow) =>
    catalogue.createShiftType(
      uow,
      createShiftTypeRequestSchema.parse({
        code,
        name: `Inertness subject ${code}`,
        startTime: '08:00',
        endTime: '16:00',
      }),
    ),
  );
  if (created.kind !== 'ok') throw new Error(`${label}: shift type ${created.kind}`);
  return created.value.shiftTypeId;
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

  /* ── the two subjects: one raced into retirement, one ordinary ──────────── */
  racedShiftTypeId = await createShiftType('raced', 'GWR1');
  controlShiftTypeId = await createShiftType('control', 'GWR2');

  const racedQualification = await staffingRun('raced-qualification', (uow) =>
    createQualification(uow, {
      key: 'granted-while-retiring-raced',
      name: 'Raced credential',
    }),
  );
  racedQualificationId = racedQualification.id;

  const controlQualification = await staffingRun('control-qualification', (uow) =>
    createQualification(uow, {
      key: 'granted-while-retiring-control',
      name: 'Control credential',
    }),
  );
  controlQualificationId = controlQualification.id;

  for (const [label, shiftTypeId, qualificationId] of [
    ['raced', racedShiftTypeId, racedQualificationId],
    ['control', controlShiftTypeId, controlQualificationId],
  ] as const) {
    const requirement = await run(`${label}-requirement`, (uow) =>
      catalogue.replaceShiftTypeQualifications(uow, shiftTypeId, {
        qualificationIds: [qualificationId],
        expectedVersion: 1,
      }),
    );
    if (requirement.kind !== 'ok') throw new Error(`${label}: requirement ${requirement.kind}`);
  }

  /* ── one period, one draft, one assignment per subject ───────────────────── */
  const actor = scheduleActor(alpha().users.scheduler.id);
  const seeded = await run('seed-schedule', async (uow) => {
    const period = await createPeriod(uow, actor, {
      name: 'Granted-while-retiring window',
      startDate: DATES[0],
      endDate: DATES[2],
    });
    // A period requirement, so the canonical input is a posed problem rather
    // than a `missing-required-input` refusal.
    await setRequirement(uow, actor, {
      periodId: period,
      date: DATES[0],
      shiftTypeId: racedShiftTypeId,
      requiredCount: 1,
    });
    const draft = await createDraftVersion(uow, actor, period);
    // Different DATES so the two 08:00–16:00 shifts never overlap for one member.
    await addManualAssignment(uow, actor, {
      versionId: draft,
      membershipId: alpha().users.scheduler.membershipId,
      shiftTypeId: racedShiftTypeId,
      date: DATES[0],
      startsAt: fixtureInstant(DATES[0], 8),
      endsAt: fixtureInstant(DATES[0], 16),
    });
    await addManualAssignment(uow, actor, {
      versionId: draft,
      membershipId: alpha().users.scheduler.membershipId,
      shiftTypeId: controlShiftTypeId,
      date: DATES[1],
      startsAt: fixtureInstant(DATES[1], 8),
      endsAt: fixtureInstant(DATES[1], 16),
    });
    return { period, draft };
  });
  periodId = seeded.period;
  versionId = seeded.draft;

  /* The CONTROL holding: granted normally, no race, open-ended and conferring. */
  await staffingRun('control-holding', (uow) =>
    grantHolding(uow, {
      membershipId: alpha().users.scheduler.membershipId,
      qualificationId: controlQualificationId,
      validFrom: '2030-01-01T00:00:00.000Z',
      validUntil: null,
      status: 'valid',
    }),
  );

  /* ── THE RACE (probe P3e, reproduced) ────────────────────────────────────── */
  const retirementHoldsLock = deferred<number>();
  const retirementGate = deferred<void>();
  const grantPid = deferred<number>();

  let retirementSettled = false;
  const retirement = staffingRun('race-retirement', async (uow) => {
    const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(uow.query);
    await setQualificationStatus(uow, {
      qualificationId: racedQualificationId,
      status: 'retired',
      expectedVersion: racedQualification.version,
    });
    // Its audit row is written, so this transaction now holds the
    // per-organization audit advisory lock until it commits.
    retirementHoldsLock.resolve(pid.rows[0]?.pid ?? 0);
    await retirementGate.promise;
  }).then(() => {
    retirementSettled = true;
  });

  const retirePid = await retirementHoldsLock.promise;

  let grantSettled = false;
  const grant = staffingRun('race-grant', async (uow) => {
    const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(uow.query);
    grantPid.resolve(pid.rows[0]?.pid ?? 0);
    // Reads the qualification as `active` (the retirement is uncommitted), the
    // 0012 trigger reads it as `active` too, the row is inserted — and then this
    // transaction blocks at its own audit insert.
    return grantHolding(uow, {
      membershipId: alpha().users.scheduler.membershipId,
      qualificationId: racedQualificationId,
      validFrom: '2030-01-01T00:00:00.000Z',
      validUntil: null,
      status: 'valid',
    });
  }).then((granted) => {
    grantSettled = true;
    return granted;
  });

  /* R-3 (M4-001R review, closed by OPUS-M4-001S). This used to wait for
   * `wait_event_type = 'Lock'` and return — satisfied by ANY lock wait, on any
   * object, caused by any backend. The ordering premise deserves better than
   * "something blocked": the grant must be waiting on the **advisory** lock, and
   * it must be waiting on the **retirement's** backend, checked against
   * `pg_blocking_pids()` rather than inferred. Both are required before this
   * returns; neither weakens anything that was here. */
  const blocked = await waitUntilBlockedOnLock(admin, await grantPid.promise, {
    waitEvent: 'advisory',
    blockedBy: retirePid,
  });
  const grantSettledWhileRetirementOpen = grantSettled;

  // Release the retirement; it commits FIRST, and only then can the grant.
  retirementGate.resolve();
  await retirement;
  racedHoldingId = (await grant).id;

  race = {
    grantPid: await grantPid.promise,
    retirePid,
    grantWaitEventType: blocked.waitEventType,
    grantWaitEvent: blocked.waitEvent,
    grantBlockedBy: blocked.blockedBy,
    grantSettledWhileRetirementOpen,
  };

  expect(retirementSettled, 'the retirement did not commit').toBe(true);
  log(
    `race established: grant backend ${String(race.grantPid)} blocked on ` +
      `${race.grantWaitEventType}/${String(race.grantWaitEvent)} held by retirement backend ` +
      `${String(race.retirePid)}`,
  );
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
  await admin?.end();
});

describe('the granted-while-retiring interleaving is admitted, and its credential is inert', () => {
  it('(a) ADMITTED: the grant committed AFTER the retirement, and the holding row exists', async () => {
    /* The ordering proof, restated as an assertion: while the retirement was
     * still open the grant had NOT settled, because it was blocked on the lock
     * the retirement held. A grant that had settled there would have committed
     * BEFORE the retirement — an ordinary sequential grant, and this file would
     * be measuring something else entirely. */
    expect(
      race.grantSettledWhileRetirementOpen,
      'the grant committed before the retirement — the interleaving under proof did not occur',
    ).toBe(false);
    expect(race.grantWaitEventType).toBe('Lock');
    expect(race.grantPid).not.toBe(race.retirePid);
    /* R-3: WHICH lock, and WHOSE. `advisory` is the 0003 per-organization audit
     * lock — the only thing that can serialise these two transactions — and
     * `pg_blocking_pids` names the retirement as the holder. A grant blocked on
     * some other lock, or blocked by some other backend, is a different
     * interleaving and must not read as this one. */
    expect(race.grantWaitEvent, 'the grant blocked on the wrong lock').toBe('advisory');
    expect(
      race.grantBlockedBy,
      'the grant was not blocked by the retirement backend',
    ).toContain(race.retirePid);

    /* Ground truth, from the superuser: the review's `committedHoldings=1,
     * qualification=retired`, measured here rather than cited. */
    const holdings = await admin.query<{ n: number; status: string }>(
      `select count(*)::int as n, min(status) as status
         from qualification_holdings
        where qualification_id = $1::uuid and membership_id = $2::uuid`,
      [racedQualificationId, alpha().users.scheduler.membershipId],
    );
    expect(holdings.rows[0]?.n, 'the race produced no holding').toBe(1);
    /* And it is a CONFERRING holding — open-ended, `valid`, covering every date
     * in the period. Without the verdict's rule 1 it would satisfy the
     * requirement, which is exactly what makes (b), (c) and (d) falsifiable. */
    expect(holdings.rows[0]?.status).toBe('valid');

    const qualification = await admin.query<{ status: string }>(
      `select status from qualifications where id = $1::uuid`,
      [racedQualificationId],
    );
    expect(qualification.rows[0]?.status, 'the qualification is not retired').toBe('retired');
    expect(racedHoldingId).not.toBe('');
    log('admitted: one committed holding of a now-retired qualification, status valid');
  });

  it('(b) MANUAL PATH: listMembershipEligibility answers retired — and satisfied for the control', async () => {
    const rows = await run('manual-read', (uow) =>
      catalogue.listMembershipEligibility(
        uow,
        alpha().users.scheduler.membershipId,
        instantOfDate(DATES[0]),
      ),
    );

    const outcomeFor = (shiftTypeId: string, qualificationId: string): string | undefined =>
      rows
        .find((entry) => entry.shiftTypeId === shiftTypeId)
        ?.qualificationOutcomes.find((entry) => entry.qualificationId === qualificationId)?.outcome;

    expect(outcomeFor(racedShiftTypeId, racedQualificationId)).toBe('retired');
    // The control: the same read, the same member, the same instant.
    expect(outcomeFor(controlShiftTypeId, controlQualificationId)).toBe('satisfied');
    log('manual path: raced=retired, control=satisfied');
  });

  it('(c) PUBLICATION PATH: the gate reports retired and BLOCKS the publish', async () => {
    const findings = await run('publication-read', (uow) =>
      findQualificationRequirementFindings(uow, versionId),
    );

    const raced = findings.filter(
      (finding) => finding.qualificationId === racedQualificationId,
    );
    expect(raced).toHaveLength(1);
    expect(raced[0]?.outcome).toBe('retired');
    expect(raced[0]?.date).toBe(DATES[0]);
    expect(raced[0]?.membershipId).toBe(alpha().users.scheduler.membershipId);

    // The control's assignment is in the SAME version and produces no finding.
    expect(
      findings.filter((finding) => finding.qualificationId === controlQualificationId),
    ).toHaveLength(0);

    /* Reported is not enough — FAD-27 fail-closed means the publication
     * prerequisite REFUSES. `assertHardRulesRevalidated` is what SPEC-05 §6
     * step 06 calls, and it raises rather than returning a verdict. */
    const refusal = await run('publication-gate', (uow) =>
      assertHardRulesRevalidated(uow, versionId).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(refusal, 'the publication gate did not refuse').toBeInstanceOf(
      QualificationRequirementBreachError,
    );
    const breach = refusal as QualificationRequirementBreachError;
    expect(breach.findings.some((finding) => finding.outcome === 'retired')).toBe(true);
    log('publication path: retired finding reported, and the step-06 prerequisite refused');
  });

  it('(d) SOLVER INPUT: the canonical snapshot marks the qualification retired for that membership', async () => {
    const assembled = await run('solver-assembly', (uow) =>
      assembleCanonicalInput(uow, { periodId, versionId, at: BUILD_AT }),
    );

    const participant = assembled.document.participants.find(
      (entry) => entry.membershipId === alpha().users.scheduler.membershipId,
    );
    expect(participant, 'the assignee is not a participant of the snapshot').toBeDefined();

    // The holding is CARRIED — retirement retains it (FAD-28 R2) — and it is
    // the verdict, not the row, that withholds eligibility.
    expect(
      participant?.holdings.some((holding) => holding.qualificationId === racedQualificationId),
      'the race-produced holding is missing from the snapshot',
    ).toBe(true);

    const raced = participant?.eligibility.find(
      (entry) => entry.shiftTypeId === racedShiftTypeId,
    );
    expect(raced?.outcomes).toContain(`${racedQualificationId}:retired`);
    expect(raced?.eligible, 'the snapshot marks the raced pair eligible').toBe(false);

    const control = participant?.eligibility.find(
      (entry) => entry.shiftTypeId === controlShiftTypeId,
    );
    expect(control?.outcomes).toContain(`${controlQualificationId}:satisfied`);
    expect(control?.eligible, 'the control pair is not eligible — the oracle is dead').toBe(true);
    log('solver input: raced pair retired/ineligible, control pair satisfied/eligible');
  });
});
