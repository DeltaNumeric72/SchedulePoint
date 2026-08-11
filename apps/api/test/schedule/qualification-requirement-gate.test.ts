import { createShiftTypeRequestSchema } from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as catalogue from '../../src/catalogue/service.js';
import { loadHoldings } from '../../src/profiles/in-force-loader.js';
import { QualificationRequirementBreachError } from '../../src/schedule/hard-rule-revalidation.js';
import { publishVersion } from '../../src/schedule/publication.js';
import {
  addManualAssignment,
  createDraftVersion,
  createPeriod,
  transitionVersion,
} from '../../src/schedule/service.js';
import { createQualification, grantHolding } from '../../src/profiles/qualifications.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, publicationKey, scheduleActor } from '../support/schedule.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **The structural publication gate: shift-type qualification requirements are
 * enforced with NO duplicate authored rule** (OPUS-M4-000A; doc 34 §4-B).
 *
 * Before this packet, `shift_type_qualifications` did nothing at publication
 * unless a scheduler had also authored a `RequiresQualification` rule by hand.
 * Now the shared verdict gates every publish:
 *
 *   - an assignment whose shift type requires a credential the assignee does
 *     not hold BLOCKS publication with `QUALIFICATION_REQUIREMENT_BREACH`,
 *     naming the qualification and the distinct outcome;
 *   - crediting the assignee unblocks the SAME version — the falsifiability
 *     lever is the credential, not the test;
 *   - **the gate computes on the TRUTH, not on the publisher's visibility**:
 *     the publisher here holds NO credential-read capability, and the member's
 *     holdings are invisible to them (proven inline) — yet the gate passes
 *     once the member is credentialed, because the enforcement read plane
 *     (migration 0012's `qualification_holdings_enforcement_read`) opens for
 *     exactly the span of the verdict computation. Without that plane this
 *     arm FAILS with a false `missing` — which is this file's built-in
 *     falsification of the mechanism.
 */

const multi = ownedMulti('qualification-gate', { seed: { catalogue: ['alpha'] } });

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

const schedulerContext = (correlationId: string) => ({
  organizationId: alpha().organizationId,
  groupId: alpha().groupOne.id,
  membershipId: alpha().users.scheduler.membershipId,
  correlationId,
});
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

let shiftTypeId: string;
let qualificationId: string;

const DATE = '2036-04-06';

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

  const created = await run('gate-shift-type', (uow) =>
    catalogue.createShiftType(
      uow as never,
      createShiftTypeRequestSchema.parse({
        code: 'GATE',
        name: 'Gate subject',
        startTime: '08:00',
        endTime: '16:00',
      }),
    ),
  );
  if (created.kind !== 'ok') throw new Error(`shift type: ${created.kind}`);
  shiftTypeId = created.value.shiftTypeId;

  qualificationId = (
    await staffingRun('gate-qualification', (uow) =>
      createQualification(uow as never, { key: 'gate-credential', name: 'Gate credential' }),
    )
  ).id;

  const requirement = await run('gate-requirement', (uow) =>
    catalogue.replaceShiftTypeQualifications(uow as never, shiftTypeId, {
      qualificationIds: [qualificationId],
      expectedVersion: 1,
    }),
  );
  if (requirement.kind !== 'ok') throw new Error(`requirement: ${requirement.kind}`);
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

async function approvedVersionAssigning(
  label: string,
  date: string,
  membershipId: string,
): Promise<{ periodId: string; versionId: string }> {
  const actor = scheduleActor(alpha().users.scheduler.id);
  return run(`gate-build-${label}`, async (uow) => {
    const periodId = await createPeriod(uow as never, actor, {
      name: `Gate window ${label}`,
      startDate: date,
      endDate: date,
    });
    const versionId = await createDraftVersion(uow as never, actor, periodId);
    await addManualAssignment(uow as never, actor, {
      versionId,
      membershipId,
      shiftTypeId,
      date,
      startsAt: fixtureInstant(date, 8),
      endsAt: fixtureInstant(date, 16),
    } as never);
    await transitionVersion(uow as never, actor, versionId, 'in_review');
    await transitionVersion(uow as never, actor, versionId, 'approved');
    return { periodId, versionId };
  });
}

describe('the gate, with no authored rule anywhere', () => {
  it('an uncredentialed assignee BLOCKS publication with the distinct outcome named', async () => {
    /* The assignee is `groupOnly`, which NOTHING in this file ever credentials.
     * It was `member` — the membership the next case grants a holding to — and
     * `fixture-regression` caught what that meant: under
     * `--sequence.shuffle.tests` the crediting case can run first, and then
     * this one publishes cleanly and asserts against `undefined`. A case that
     * needs an uncredentialed subject must own one (FAD-15). */
    const { periodId, versionId } = await approvedVersionAssigning(
      'blocked',
      DATE,
      alpha().users.groupOnly.membershipId,
    );

    const actor = scheduleActor(alpha().users.scheduler.id);
    let error: unknown;
    try {
      await run('gate-publish-blocked', (uow) =>
        publishVersion(uow as never, actor, {
          periodId,
          versionId,
          idempotencyKey: publicationKey('gate-blocked'),
          expectedPriorCurrentVersionId: null,
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QualificationRequirementBreachError);
    const breach = error as QualificationRequirementBreachError;
    expect(breach.findings).toHaveLength(1);
    expect(breach.findings[0]?.qualificationId).toBe(qualificationId);
    expect(breach.findings[0]?.outcome).toBe('missing');

    const state = await admin.query<{ state: string }>(
      'select state from schedule_versions where id = $1::uuid',
      [versionId],
    );
    expect(state.rows[0]?.state, 'the refused publication left the version moved').toBe('approved');
    log('uncredentialed assignee → QUALIFICATION_REQUIREMENT_BREACH (missing), version unmoved');
  });

  it('the ENFORCEMENT read plane: the publisher cannot see the holding, and the gate still can', async () => {
    /* The load-bearing arm. The member is credentialed by the staffing actor;
     * the PUBLISHER (scheduler) holds no credential-read capability, so under
     * the publisher's ordinary visibility the member still LOOKS
     * uncredentialed — proven inline — and a gate computing on that view
     * would refuse a valid schedule. It publishes, because the verdict reads
     * through migration 0012's enforcement plane. */
    await staffingRun('gate-credential-member', (uow) =>
      grantHolding(uow as never, {
        membershipId: alpha().users.member.membershipId,
        qualificationId,
        validFrom: '2030-01-01T00:00:00.000Z',
        status: 'valid',
      }),
    );

    // The publisher's ordinary view: the member's holdings are INVISIBLE.
    const publisherView = await run('gate-visibility-control', async (uow) =>
      loadHoldings((uow as { query: never }).query, {
        organizationId: alpha().organizationId,
        membershipId: alpha().users.member.membershipId,
      }),
    );
    expect(
      publisherView,
      'the visibility premise is gone — the publisher can read the holdings, so this arm proves nothing',
    ).toHaveLength(0);

    // A DIFFERENT date, so the blocked arm's period does not collide.
    const { periodId, versionId } = await approvedVersionAssigning(
      'unblocked',
      '2036-04-08',
      alpha().users.member.membershipId,
    );
    const actor = scheduleActor(alpha().users.scheduler.id);
    await run('gate-publish-ok', (uow) =>
      publishVersion(uow as never, actor, {
        periodId,
        versionId,
        idempotencyKey: publicationKey('gate-unblocked'),
        expectedPriorCurrentVersionId: null,
      }),
    );

    const state = await admin.query<{ state: string }>(
      'select state from schedule_versions where id = $1::uuid',
      [versionId],
    );
    expect(state.rows[0]?.state).toBe('published');
    log('holder invisible to the publisher, visible to the gate: published. The plane is load-bearing');
  });

  it('MUTATION CONTROL: without the purpose token, the same computation under-reads', async () => {
    /* `findQualificationRequirementFindings` sets and clears the token around
     * its reads. This control performs the SAME holdings read in the SAME
     * publisher context WITHOUT the token and sees nothing — so if the plane
     * were removed (the policy dropped, the token misspelled, the set_config
     * forgotten), the gate would compute exactly this empty view and the
     * previous arm would fail with a false `missing`. The detection is alive
     * in both directions. */
    /* The subject is this case's OWN holder, and its existence is asserted
     * before the empty read is claimed to mean anything. Reading the previous
     * case's holder made the control vacuous whenever the order put this case
     * first: an empty read proves nothing when there is no holding to miss. */
    const holder = alpha().users.departed.membershipId;
    await staffingRun('gate-control-credential', (uow) =>
      grantHolding(uow as never, {
        membershipId: holder,
        qualificationId,
        validFrom: '2030-01-01T00:00:00.000Z',
        status: 'valid',
      }),
    );
    const exists = await admin.query<{ n: number }>(
      `select count(*)::int as n from qualification_holdings
        where organization_id = $1::uuid and membership_id = $2::uuid
          and qualification_id = $3::uuid`,
      [alpha().organizationId, holder, qualificationId],
    );
    expect(
      exists.rows[0]?.n,
      'there is no holding to miss — the control would pass on an empty table',
    ).toBe(1);

    const withoutToken = await run('gate-mutation-control', async (uow) =>
      loadHoldings((uow as { query: never }).query, {
        organizationId: alpha().organizationId,
        membershipId: holder,
      }),
    );
    expect(
      withoutToken,
      'the token-less read SEES the holding — the plane is not load-bearing and the ' +
        'previous arm can no longer fail',
    ).toHaveLength(0);
    log('mutation control: the holding exists, and the token-less publisher read is empty');
  });
});
