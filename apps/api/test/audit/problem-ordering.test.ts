import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAuditEvent } from '../../src/audit/recorder.js';
import { verifyAuditChain } from '../../src/audit/verification.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext, organizationContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Named-condition proof (3): the chain-verification problems array is ordered
 * NUMERICALLY, under a fixture with more than nine problems.** (OPUS-M2-004
 * deliverable 3.)
 *
 * ## The class this pins
 *
 * `verifyAuditChain` read:
 *
 * ```sql
 * select sequence::text as sequence, … from app_verify_audit_chain($1)
 *  order by sequence, problem
 * ```
 *
 * PostgreSQL resolves an **unqualified** `ORDER BY` to the OUTPUT column when one
 * carries that name, so the bigint was ordered as the `::text` alias: `'10'`
 * above `'9'`. The finding is not a false verdict — the same problems were
 * found, `intact` was the same boolean, the count was the same — it is that the
 * **order** was wrong, and order is what an incident responder reads first.
 * "Where does the damage start?" is answered by `problems[0]`, and `problems[0]`
 * was whichever sequence sorted first as text.
 *
 * OPUS-M2-003's rotating seed 531651 exposed the class in three test sites; this
 * is the production site, and this file is the regression that keeps it fixed.
 *
 * ## Why the fixture must produce MORE THAN NINE problems
 *
 * Below ten, lexicographic and numeric order **coincide**, and a test that
 * asserted "ascending" would pass against the defect. That is the vacuity shape
 * FAD-15 rule 4 names, so it is not merely avoided here — it is **asserted**:
 * the perturbation arm checks that sorting the observed sequences as text gives
 * a DIFFERENT answer from sorting them as numbers. If a future change shrank the
 * fixture below the threshold, this file fails rather than quietly stopping to
 * test anything.
 *
 * ## ALLOW control first
 *
 * The chain is verified intact before anything is broken, so a later
 * "problems are ordered" assertion cannot be passing because the verifier was
 * broken, the fixture absent, or the context wrong. And the tampering is undone
 * **by sequence id** — never by predicate (FAD-15 as corrected, E-01) — with a
 * final intact verification proving the restore actually restored.
 */

const multi = ownedMulti('audit-problem-ordering');

/** Enough rows that the tampered set spans single- AND double-digit sequences. */
const APPENDS = 14;
/** Sequences tampered with. Deliberately straddles 9/10 — the boundary of the bug. */
const TAMPERED = [2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const;

const alpha = () => multi().alpha;

const admin = adminClient();
let runtime: Runtime;

beforeAll(async () => {
  await admin.connect();
  runtime = createRuntime('app_runtime');
}, 120_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

/**
 * Establishes the precondition rather than assuming it.
 *
 * The MULTI fixture seeds three audit rows into Alpha; this file needs a chain
 * long enough for sequence 10 to exist. It appends until it does instead of
 * assuming a row count somebody else's seeding happens to produce — the C-2
 * lesson, and the reason this file also passes standalone.
 */
async function chainOfAtLeast(rows: number): Promise<number> {
  const context = groupContext(
    alpha().organizationId,
    alpha().groupOne.id,
    alpha().users.scheduler.membershipId,
    'problem-ordering-seed',
  );
  let head = 0;
  for (let i = 0; head < rows; i += 1) {
    const recorded = await runtime.runner.run(context, (uow) =>
      recordAuditEvent(uow, {
        eventName: 'membership.activity_touched',
        subjectType: 'membership',
        subjectId: alpha().users.scheduler.membershipId,
        payload: { index: i },
      }),
    );
    head = Number(recorded.sequence);
    if (i > rows * 4) throw new Error('the chain is not advancing; refusing to loop');
  }
  return head;
}

/** Disables the refusal trigger for one privileged statement, then re-enables it. */
async function withTamperingEnabled(statement: () => Promise<void>): Promise<void> {
  await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
  try {
    await statement();
  } finally {
    await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');
  }
}

function verify() {
  return runtime.runner.run(
    organizationContext(alpha().organizationId, 'problem-ordering-verify'),
    (uow) => verifyAuditChain(uow),
  );
}

describe('chain verification orders its problems numerically (OPUS-M2-004)', () => {
  it('reports every problem in ascending NUMERIC sequence order, with more than nine of them', async () => {
    const head = await chainOfAtLeast(APPENDS);
    expect(head, 'the chain must reach at least sequence 13 for this proof to mean anything')
      .toBeGreaterThanOrEqual(Math.max(...TAMPERED));

    // ── ALLOW control ────────────────────────────────────────────────────────
    const before = await verify();
    expect(before.intact, JSON.stringify(before.problems)).toBe(true);
    expect(before.problems).toHaveLength(0);

    // ── perturb ──────────────────────────────────────────────────────────────
    await withTamperingEnabled(async () => {
      await admin.query(
        `update audit_events set payload = payload || '{"tampered": true}'::jsonb
          where organization_id = $1::uuid and sequence = any($2::bigint[])`,
        [alpha().organizationId, [...TAMPERED]],
      );
    });

    try {
      const after = await verify();
      expect(after.intact).toBe(false);

      const sequences = after.problems.map((problem) => problem.sequence);
      expect(
        sequences.length,
        'fewer than ten problems makes text order and numeric order identical, and this ' +
          'proof vacuous',
      ).toBeGreaterThan(9);

      // The proof itself: ascending, compared as NUMBERS.
      const asNumbers = sequences.map(Number);
      expect(asNumbers).toEqual([...asNumbers].sort((a, b) => a - b));

      // The non-vacuity witness. Sorting the SAME sequences as text must give a
      // different answer — otherwise "ascending" would have held for the broken
      // query too, and this file would be testing nothing.
      const lexicographic = [...sequences].sort();
      expect(
        lexicographic,
        'the observed sequences do not distinguish text order from numeric order — the ' +
          'fixture has stopped being able to catch the defect',
      ).not.toEqual(sequences);

      // And the operator-facing consequence, stated directly: the first problem
      // is the LOWEST sequence, not the lexicographically smallest string.
      expect(after.problems[0]?.sequence).toBe(String(Math.min(...asNumbers)));

      log(
        `problem ordering: ${String(sequences.length)} problems over sequences ` +
          `${sequences[0] ?? '?'}..${sequences[sequences.length - 1] ?? '?'}; ` +
          `text order would have started at ${lexicographic[0] ?? '?'}`,
      );
    } finally {
      // ── restore, BY SEQUENCE ID, never by predicate over content ───────────
      await withTamperingEnabled(async () => {
        await admin.query(
          `update audit_events set payload = payload - 'tampered'
            where organization_id = $1::uuid and sequence = any($2::bigint[])`,
          [alpha().organizationId, [...TAMPERED]],
        );
      });
    }

    // The restore is asserted rather than assumed: a destructive test that does
    // not restore decides the result of every test after it.
    const restored = await verify();
    expect(restored.intact, JSON.stringify(restored.problems)).toBe(true);
  });
});
