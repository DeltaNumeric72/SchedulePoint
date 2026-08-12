import { randomUUID } from 'node:crypto';

import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import {
  SnapshotIdempotencyConflictError,
  canonicalInputHash,
  persistCanonicalInput,
  readSnapshot,
} from '../../src/solver/snapshot-store.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';
import { seedSolverFixture, type SolverFixture } from '../support/solver.js';
import { syntheticProblem } from './synthetic-problem.js';

/**
 * **NAMED PROOF — the canonical input hash is deterministic, and the snapshot is
 * persisted once** (OPUS-M4-001; SPEC-04 §3.4, doc 35 §6a).
 *
 * SPEC-04 §3.4 says `input_hash` "covers all of it". Two properties follow, and
 * both are the kind that look obvious and fail silently:
 *
 * | # | Property | What breaks silently without it |
 * |---|---|---|
 * | 1 | the same inputs produce the same hash, whatever order they arrived in | two identical builds look like different problems; a reproduction attempt is refused for no reason |
 * | 2 | *different* inputs produce a different hash | two different problems look identical; SPEC-04 §2's "re-runnable from the same pinned snapshot" reproduces the wrong one |
 * | 3 | an idempotency key identifies one REQUEST, not one caller | a retry after the world moved returns a build of a world that no longer exists |
 * | 4 | the persisted payload is the document, byte for byte | the hash covers something other than what the worker receives |
 *
 * ## Mutation control (FAD-15)
 *
 * Property 2 IS property 1's control, and it is asserted field by field: every
 * dimension of the document is perturbed in turn and the hash must move for each
 * one. A hash that ignored a field would satisfy property 1 perfectly.
 */

const multi = ownedMulti('solver-snapshot-store', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: { organizationId: string; groupId: string; membershipId: string; correlationId: string };
let fixture: SolverFixture;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

const BUILD_AT = fixtureInstant('2027-10-04', 12);

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const shiftTypeId = multi.catalogue('alpha').shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('no shift type');

  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'solver-snapshot-store',
  };
  void scheduleActor(alpha.users.scheduler.id);

  fixture = await seedSolverFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    actorMembershipId: alpha.users.scheduler.membershipId,
    actorUserId: alpha.users.scheduler.id,
    shiftTypeId,
    startDate: '2027-10-04',
    endDate: '2027-10-10',
    requiredCount: 1,
  });
});

afterAll(async () => {
  await runtime?.destroy();
});

describe('the canonical input hash', () => {
  it('is stable across key ORDER — the same world, described twice', () => {
    const document = syntheticProblem();
    /* Key insertion order is a property of how an object was built, not of what
     * it means. Two assemblies that read the same rows in a different order must
     * produce the same hash, or a reproduction is refused for a reason that has
     * nothing to do with the problem. */
    const reordered = Object.fromEntries(
      Object.entries(document).reverse(),
    ) as unknown as SolverInputSnapshotDocument;

    expect(Object.keys(reordered)).not.toEqual(Object.keys(document));
    expect(canonicalInputHash(reordered)).toBe(canonicalInputHash(document));
  });

  it('is stable across repeated computation, and is a sha-256', () => {
    const document = syntheticProblem();
    const first = canonicalInputHash(document);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(canonicalInputHash(document)).toBe(first);
    }
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('MUTATION CONTROL: every dimension of the document MOVES the hash', () => {
    /* The control for the two cases above, and the reason it is field by field:
     * a hash over "the interesting fields" would satisfy stability perfectly
     * while ignoring an input the solver consumes. Each perturbation below is a
     * real change to what a build would do. */
    const base = syntheticProblem();
    const baseline = canonicalInputHash(base);

    const perturbations: readonly [string, SolverInputSnapshotDocument][] = [
      ['startDate', { ...base, startDate: '2027-04-01' }],
      ['endDate', { ...base, endDate: '2027-04-30' }],
      ['dayCount', { ...base, dayCount: base.dayCount + 1 }],
      ['periodStatus', { ...base, periodStatus: 'closed' }],
      ['timezone', { ...base, timezone: { ...base.timezone, basis: 'Pacific/Kiritimati' } }],
      ['compilerVersion', { ...base, compilerVersion: base.compilerVersion + 1 }],
      ['snapshotSchemaVersion', { ...base, snapshotSchemaVersion: 99 }],
      [
        'demand.requiredCount',
        {
          ...base,
          demand: base.demand.map((cell, index) =>
            index === 0 ? { ...cell, requiredCount: cell.requiredCount + 1 } : cell,
          ),
        },
      ],
      [
        'participants.staffingKind',
        {
          ...base,
          participants: base.participants.map((p, index) =>
            index === 0 ? { ...p, staffingKind: 'locum' as const } : p,
          ),
        },
      ],
      [
        'participants.eligibility',
        {
          ...base,
          participants: base.participants.map((p, index) =>
            index === 0
              ? { ...p, eligibility: p.eligibility.map((e) => ({ ...e, eligible: false })) }
              : p,
          ),
        },
      ],
      [
        'shiftTypes.requiredQualificationIds',
        {
          ...base,
          shiftTypes: base.shiftTypes.map((s) => ({
            ...s,
            requiredQualificationIds: ['00000000-0000-4000-8000-000000000001'],
          })),
        },
      ],
      [
        'constituents',
        {
          ...base,
          constituents: base.constituents.map((c, index) =>
            index === 0 ? { ...c, revision: '999' } : c,
          ),
        },
      ],
    ];

    for (const [label, perturbed] of perturbations) {
      expect(canonicalInputHash(perturbed), `${label} did not move the hash`).not.toBe(baseline);
    }
    log(`      · MUTATION CONTROL: ${String(perturbations.length)} dimensions each move the hash`);
  });
});

describe('persisting the snapshot', () => {
  it('stores the document, its hash and its constituents, and reads them back', async () => {
    const key = `store-${randomUUID()}`;
    const persisted = await run(async (uow) => {
      const assembled = await assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      });
      return persistCanonicalInput(uow, {
        document: assembled.document,
        constituents: assembled.constituents,
        idempotencyKey: key,
      });
    });

    expect(persisted.replayed).toBe(false);
    expect(persisted.canonicalInputHash).toBe(canonicalInputHash(persisted.document));

    const stored = await run(async (uow) => readSnapshot(uow, persisted.snapshotId));
    expect(stored).not.toBeNull();
    expect(stored?.canonicalInputHash).toBe(persisted.canonicalInputHash);

    /* The payload is the DOCUMENT, byte for byte through `jsonb`. If PostgreSQL's
     * normalisation moved anything the hash covers, this would fail — which is
     * exactly the check worth having, because the hash and the stored payload
     * must describe the same thing for the snapshot to be worth storing. */
    expect(canonicalInputHash(stored?.payload as SolverInputSnapshotDocument)).toBe(
      persisted.canonicalInputHash,
    );

    const constituents = stored?.constituents as { kind: string; key: string }[];
    expect(Array.isArray(constituents)).toBe(true);
    expect(constituents.length).toBeGreaterThan(0);
    log(
      `      · snapshot ${persisted.snapshotId.slice(0, 8)} · hash ` +
        `${persisted.canonicalInputHash.slice(0, 12)}… · ${String(constituents.length)} constituents`,
    );
  });

  it('replays the SAME key for the SAME request instead of assembling twice', async () => {
    const key = `idem-${randomUUID()}`;
    const first = await run(async (uow) => {
      const assembled = await assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      });
      return persistCanonicalInput(uow, {
        document: assembled.document,
        constituents: assembled.constituents,
        idempotencyKey: key,
      });
    });
    const second = await run(async (uow) => {
      const assembled = await assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      });
      return persistCanonicalInput(uow, {
        document: assembled.document,
        constituents: assembled.constituents,
        idempotencyKey: key,
      });
    });

    expect(second.replayed).toBe(true);
    expect(second.snapshotId).toBe(first.snapshotId);

    const count = await run(
      async ({ query }) =>
        await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM solver_input_snapshots
           WHERE idempotency_key = ${key}
        `.execute(query),
    );
    expect(count.rows[0]?.n).toBe('1');
    log('      · one key, one snapshot row');
  });

  it('REFUSES a key replayed for a materially different request', async () => {
    /* 0015's `publication_records` lesson, applied before it can be learned
     * twice: a key bound to (period, key) alone answers "have I seen this key?"
     * and not "have I seen this key for THIS request?". Re-presenting a key
     * after the world moved is a NEW request wearing an old key, and answering
     * it with the old snapshot would hand a scheduler a build of a world that no
     * longer exists. */
    const key = `conflict-${randomUUID()}`;
    await run(async (uow) => {
      const assembled = await assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      });
      return persistCanonicalInput(uow, {
        document: assembled.document,
        constituents: assembled.constituents,
        idempotencyKey: key,
      });
    });

    // The world moves.
    await run(async ({ query }) => {
      await sql`
        UPDATE schedule_requirements SET required_count = required_count + 1
         WHERE period_id = ${fixture.periodId}
      `.execute(query);
    });

    let thrown: unknown;
    try {
      await run(async (uow) => {
        const assembled = await assembleCanonicalInput(uow, {
          periodId: fixture.periodId,
          versionId: fixture.versionId,
          at: BUILD_AT,
        });
        return persistCanonicalInput(uow, {
          document: assembled.document,
          constituents: assembled.constituents,
          idempotencyKey: key,
        });
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SnapshotIdempotencyConflictError);
    log('      · a key replayed after the world moved is refused, not answered');
  });
});
