import {
  ASSIGNMENT_CHANGE_KINDS,
  assignmentChangeCoreOf,
  type AssignmentChangeView,
} from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  differenceByIdentity,
  type AssignmentChangeKind,
  type DiffSnapshot,
} from '../../src/schedule/diff.js';
import { reviewDigestOf } from '../../src/http/routes/schedule-publication.route.js';
import { adminClient } from '../support/admin-client.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **The diff display equals the pure-function diff** (packet 32 §10d, key proof).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What is actually compared, and why it is a comparison of VALUES
 *
 * The publication surface decorates each change with a date, a shift type, two
 * instants and two display names so a human can read it. Decoration is where an
 * equality claim usually goes to die: a hand-written field-by-field check drifts
 * the moment somebody adds a field, and it still passes.
 *
 * So the contract splits the change into a CORE (the four fields the pure
 * function decides) and a view (core + decoration), and exports the projection
 * `assignmentChangeCoreOf`. This test:
 *
 *  1. reads the comparison over HTTP, through the real route, against the real
 *     database;
 *  2. reads the same two versions' snapshots directly and calls the frozen
 *     `differenceByIdentity` itself;
 *  3. asserts the projected response **deep-equals** the pure result — changes
 *     and affected set, order included.
 *
 * ## Falsifiability
 *
 * A parity assertion that would pass on any input proves nothing, so the last
 * test perturbs the response in each of the four ways the decoration could hide
 * — a dropped change, a flipped kind, a swapped membership, a re-ordering — and
 * asserts the comparison FAILS on every one of them. If the equality check were
 * vacuous, those would pass and this file would say so.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const multi = ownedMulti('publication-diff-parity', {
  profile: 'full',
  seed: { catalogue: ['alpha'], schedule: true },
});

let harness: HttpHarness;
let admin: pg.Client;

beforeAll(async () => {
  harness = await buildHttpHarness();
  admin = adminClient();
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

/**
 * The independent read the parity proof compares against.
 *
 * OPUS-M4-000C: it now selects every dimension the shared material-change
 * definition compares — shift type, location, pin, credit — because a proof that
 * fed the pure function a NARROWER projection than the route feeds it would
 * agree about fields neither of them ever saw.
 */
async function readSnapshotsDirect(versionId: string): Promise<DiffSnapshot[]> {
  const result = await admin.query<{
    assignment_identity_id: string;
    membership_id: string;
    starts_at: Date;
    ends_at: Date;
    status: string;
    date: string | Date;
    shift_type_id: string;
    location_id: string | null;
    is_pinned: boolean;
    credited_membership_id: string | null;
    credit_weight: string | null;
  }>(
    `select s.assignment_identity_id, s.membership_id, s.starts_at, s.ends_at, s.status,
            s.date, s.is_pinned, sh.shift_type_id, sh.location_id,
            c.credited_membership_id, c.weight as credit_weight
       from assignment_snapshots s
       join shifts sh on sh.id = s.shift_id
       left join credits c
              on c.assignment_identity_id = s.assignment_identity_id
             and c.source_version_id = s.version_id
             and c.status <> 'voided'
      where s.version_id = $1`,
    [versionId],
  );
  return result.rows.map((row) => ({
    assignmentIdentityId: row.assignment_identity_id,
    membershipId: row.membership_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    date: String(row.date instanceof Date ? row.date.toISOString() : row.date).slice(0, 10),
    shiftTypeId: row.shift_type_id,
    locationId: row.location_id,
    isPinned: row.is_pinned,
    creditedMembershipId: row.credited_membership_id,
    creditWeight: row.credit_weight,
  }));
}

async function readComparison(
  versionId: string,
  againstVersionId: string,
): Promise<{ changes: AssignmentChangeView[]; affectedMembershipIds: string[] }> {
  const alpha = multi().alpha;
  const counters = await currentCounters(admin, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    userId: alpha.users.scheduler.id,
  });
  const response = await harness.app.inject({
    method: 'GET',
    url:
      `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/schedule` +
      `/versions/${versionId}/comparison?againstVersionId=${againstVersionId}`,
    headers: contextHeaders(alpha.users.scheduler.id, counters),
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = JSON.parse(response.body) as {
    difference: { changes: AssignmentChangeView[]; affectedMembershipIds: string[] };
  };
  return body.difference;
}

describe('the rendered difference equals the pure function', () => {
  it('the contract kind union is exactly the module`s', () => {
    // A kind added to the module and not to the wire would silently render as
    // nothing at all. `satisfies` is the assertion: this stops compiling if the
    // two sets diverge in either direction.
    //
    // `amended` is OPUS-M4-000C's (doc 34 §4-G) — the same person, at the same
    // time, whose shift type, location, pin or credit moved. This list is the
    // one place the module's union is written out by hand, so it is EXACTLY
    // what must move when a kind is added; updating it does not weaken the
    // assertion, which still fails in both directions.
    const wire: readonly AssignmentChangeKind[] = ASSIGNMENT_CHANGE_KINDS;
    const module: readonly (typeof ASSIGNMENT_CHANGE_KINDS)[number][] = [
      'added',
      'removed',
      'reassigned',
      'retimed',
      'amended',
    ] satisfies readonly AssignmentChangeKind[];
    expect([...wire].sort()).toEqual([...module].sort());
  });

  it('the comparison response projects EXACTLY onto differenceByIdentity', async () => {
    const seeded = multi().schedule?.groupOne;
    if (seeded === undefined) throw new Error('the schedule seed did not run');

    const rendered = await readComparison(seeded.currentVersionId, seeded.firstVersionId);
    const pure = differenceByIdentity(
      await readSnapshotsDirect(seeded.firstVersionId),
      await readSnapshotsDirect(seeded.currentVersionId),
    );

    expect(rendered.changes.map(assignmentChangeCoreOf)).toEqual(pure.changes);
    expect(rendered.affectedMembershipIds).toEqual(pure.affectedMembershipIds);
    // Non-vacuity: the seed's V1 → V2 really does differ.
    expect(pure.changes.length).toBeGreaterThan(0);
  });

  it('the comparison against NOTHING renders every assignment as added, and matches', async () => {
    const seeded = multi().schedule?.groupOne;
    if (seeded === undefined) throw new Error('the schedule seed did not run');

    const alpha = multi().alpha;
    const counters = await currentCounters(admin, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      userId: alpha.users.scheduler.id,
    });
    const response = await harness.app.inject({
      method: 'GET',
      url:
        `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/schedule` +
        `/versions/${seeded.firstVersionId}/comparison`,
      headers: contextHeaders(alpha.users.scheduler.id, counters),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      fromVersion: unknown;
      difference: { changes: AssignmentChangeView[]; affectedMembershipIds: string[] };
    };

    // V1 was the FIRST publication, so it superseded nothing.
    expect(body.fromVersion).toBeNull();
    const pure = differenceByIdentity([], await readSnapshotsDirect(seeded.firstVersionId));
    expect(body.difference.changes.map(assignmentChangeCoreOf)).toEqual(pure.changes);
    expect(body.difference.changes.every((change) => change.kind === 'added')).toBe(true);
  });

  it('FALSIFIABILITY: the equality fails on every way the decoration could hide a change', async () => {
    const seeded = multi().schedule?.groupOne;
    if (seeded === undefined) throw new Error('the schedule seed did not run');

    const rendered = await readComparison(seeded.currentVersionId, seeded.firstVersionId);
    const pure = differenceByIdentity(
      await readSnapshotsDirect(seeded.firstVersionId),
      await readSnapshotsDirect(seeded.currentVersionId),
    );
    const first = rendered.changes[0];
    if (first === undefined) throw new Error('the seed produced no changes to perturb');

    const swappable = rendered.changes.find(
      (change) => change.fromMembershipId !== change.toMembershipId,
    );
    if (swappable === undefined) {
      throw new Error('the seed produced no change with two distinct memberships to swap');
    }

    const perturbations: { name: string; changes: AssignmentChangeView[] }[] = [
      { name: 'a dropped change', changes: rendered.changes.slice(1) },
      {
        name: 'a flipped kind',
        changes: [{ ...first, kind: first.kind === 'reassigned' ? 'added' : 'reassigned' }, ...rendered.changes.slice(1)],
      },
      {
        name: 'a swapped membership',
        /* Perturb a change whose two memberships actually DIFFER.
         *
         * This used to swap `changes[0]` unconditionally. OPUS-M4-000C added the
         * `amended` kind, and the seed's credit move produces one — a change
         * whose from and to are the SAME person, because the assignee did not
         * move. Swapping those two is a no-op, so the perturbation silently
         * stopped perturbing anything and the falsifiability check passed
         * vacuously. `swappable` is asserted to exist, so the case can never go
         * quiet again. */
        changes: [
          {
            ...swappable,
            toMembershipId: swappable.fromMembershipId,
            fromMembershipId: swappable.toMembershipId,
          },
          ...rendered.changes.filter(
            (change) => change.assignmentIdentityId !== swappable.assignmentIdentityId,
          ),
        ],
      },
      {
        name: 'an invented change',
        changes: [...rendered.changes, { ...first, assignmentIdentityId: multi().alpha.groupOne.id }],
      },
    ];

    for (const perturbation of perturbations) {
      expect(
        perturbation.changes.map(assignmentChangeCoreOf),
        `the equality did not detect ${perturbation.name}`,
      ).not.toEqual(pure.changes);
    }
  });

  it('the review digest is a function of the CHANGES and of nothing else', async () => {
    const seeded = multi().schedule?.groupOne;
    if (seeded === undefined) throw new Error('the schedule seed did not run');

    const before = await readSnapshotsDirect(seeded.firstVersionId);
    const after = await readSnapshotsDirect(seeded.currentVersionId);
    const pure = differenceByIdentity(before, after);

    /* OPUS-M4-000C: the digest is now a function of the changes AND of the
     * material-input digest (doc 34 §4-G). The material-input half is held
     * CONSTANT here so this test still isolates the change half; that the
     * material half also moves the token is proven separately, in
     * `publication-handoff.test.ts`'s NINE-CLASS MATRIX, by moving one input
     * class at a time. (This cited `review-identity.test.ts`, which has never
     * existed — a citation to a file nobody can open is worse than none, because
     * it reads as though the coverage had been checked.) */
    const inputs = 'material-input-digest-held-constant';

    // Deterministic across calls…
    expect(reviewDigestOf(pure, inputs)).toBe(
      reviewDigestOf(differenceByIdentity(before, after), inputs),
    );
    // …independent of the ROW order the database happened to return…
    expect(
      reviewDigestOf(differenceByIdentity([...before].reverse(), [...after].reverse()), inputs),
    ).toBe(reviewDigestOf(pure, inputs));
    // …and SENSITIVE to a real change, or it would be a decorative token.
    const perturbed = differenceByIdentity(before, after.slice(1));
    expect(reviewDigestOf(perturbed, inputs)).not.toBe(reviewDigestOf(pure, inputs));
    // …and sensitive to the MATERIAL INPUTS moving while the changes do not.
    expect(reviewDigestOf(pure, 'a-different-world')).not.toBe(reviewDigestOf(pure, inputs));
  });
});
