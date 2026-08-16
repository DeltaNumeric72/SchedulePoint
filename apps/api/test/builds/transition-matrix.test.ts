import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BUILD_RUN_STATES,
  isLegalTransition,
  LEGAL_TRANSITIONS,
} from '../../src/builds/states.js';
import type { BuildRunState } from '../../src/db/schema.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **The transition matrix, proven at BOTH layers** (doc 35 §6e Tests/red cases:
 * "every legal edge green, every illegal edge refused at BOTH layers, by name").
 *
 * ## Why both layers, and why they are compared to each other
 *
 * The rule is written twice on purpose: `LEGAL_TRANSITIONS` in TypeScript, so a
 * route can answer `409 BUILD_STATE_MOVED` instead of a raw `restrict_violation`,
 * and `app_build_run_transition_is_legal` in SQL, so the rule binds a psql
 * session, an ORM write and a repair script as well as the service.
 *
 * Two spellings of one rule is normally the S-01 defect. It is safe here for
 * exactly one reason: **the two are compared, edge by edge, over the full
 * 16 × 16 matrix**. A divergence is a failure of this file rather than a
 * surprise in production, and the comparison is what turns the duplication from
 * a risk into a redundancy.
 *
 * ## The database is the control
 *
 * The second `describe` drives the SQL function directly as `app_runtime` — the
 * role the application uses, under RLS, with no service code in the path at all.
 * If the service's check were deleted tomorrow, every illegal edge would still
 * be refused, and that is the property being asserted.
 */

const multi = ownedMulti('builds-transition-matrix', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'builds-transition-matrix',
  };
}, 180_000);

afterAll(async () => {
  await runtime?.destroy();
});

/** The database's own answer for one ordered pair. */
async function databaseSaysLegal(from: string, to: string): Promise<boolean> {
  const result = await runtime.runner.run(context, async ({ query }) =>
    sql<{ legal: boolean }>`SELECT app_build_run_transition_is_legal(${from}, ${to}) AS legal`.execute(
      query,
    ),
  );
  return result.rows[0]?.legal === true;
}

describe('the sixteen states', () => {
  it('names exactly the sixteen report 21 §4 governs, in its order', () => {
    expect([...BUILD_RUN_STATES]).toEqual([
      'draft_configuration',
      'validating',
      'readiness_check',
      'queued',
      'running',
      'completed',
      'completed_with_unmet_preferences',
      'infeasible',
      'failed',
      'cancelled',
      'reviewed',
      'progressively_extended',
      'approved',
      'applied_to_draft_schedule',
      'superseded',
      'archived',
    ]);
    expect(BUILD_RUN_STATES).toHaveLength(16);
  });

  it('keeps `infeasible` and `failed` apart — neither reaches the other', () => {
    /* report 21 §4: "the first is a statement about the problem; the second
     * about the system". A matrix that let one become the other would make the
     * distinction editable after the fact. */
    expect(isLegalTransition('infeasible', 'failed')).toBe(false);
    expect(isLegalTransition('failed', 'infeasible')).toBe(false);
  });

  it('has no in-place retry edge — SPEC-04 §2 makes a retry a NEW run', () => {
    /* Report 21 draws `infeasible → draft_configuration`. doc 35 §6e's governing
     * ruling supersedes it: an in-place edge would rewrite the record of a build
     * that really did run and really was infeasible. */
    expect(isLegalTransition('infeasible', 'draft_configuration')).toBe(false);
    expect(LEGAL_TRANSITIONS.infeasible).toEqual(['archived']);
  });
});

describe('the transition matrix agrees at both layers', () => {
  it('all 256 ordered pairs: the service table and the database function agree', async () => {
    const disagreements: string[] = [];
    let legalCount = 0;

    for (const from of BUILD_RUN_STATES) {
      for (const to of BUILD_RUN_STATES) {
        const service = isLegalTransition(from as BuildRunState, to as BuildRunState);
        const database = await databaseSaysLegal(from, to);
        if (service) legalCount += 1;
        if (service !== database) {
          disagreements.push(
            `${from} -> ${to}: service says ${String(service)}, database says ${String(database)}`,
          );
        }
      }
    }

    expect(disagreements, 'the two spellings of the transition rule have drifted').toEqual([]);
    /* A count, so that a matrix that quietly became "everything is legal" or
     * "nothing is legal" fails here rather than passing the agreement check. */
    expect(legalCount, 'the number of legal edges moved').toBe(
      Object.values(LEGAL_TRANSITIONS).reduce((total, list) => total + list.length, 0),
    );
    expect(legalCount).toBeGreaterThan(20);
  }, 120_000);

  it('refuses every self-edge — a state does not transition to itself', async () => {
    for (const state of BUILD_RUN_STATES) {
      expect(isLegalTransition(state as BuildRunState, state as BuildRunState)).toBe(false);
      expect(await databaseSaysLegal(state, state)).toBe(false);
    }
  }, 60_000);

  it('`archived` is absorbing at both layers', async () => {
    expect(LEGAL_TRANSITIONS.archived).toEqual([]);
    for (const to of BUILD_RUN_STATES) {
      expect(await databaseSaysLegal('archived', to)).toBe(false);
    }
  }, 60_000);

  it('refuses a state name that is not one of the sixteen', async () => {
    /* The CHECK constraint is the control on the column; this asserts the
     * function does not quietly admit an unknown word either. */
    expect(await databaseSaysLegal('queued', 'nearly_done')).toBe(false);
    expect(await databaseSaysLegal('nearly_done', 'queued')).toBe(false);
  });
});
