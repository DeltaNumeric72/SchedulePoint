import { randomUUID } from 'node:crypto';

import { RULE_SCHEMA_VERSION, canonicalStringify, type Rule } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  createRule,
  currentRuleRevisions,
  getRule,
  listRuleRevisions,
  loadRuleRevision,
  setRuleState,
  updateRule,
} from '../../src/rules/service.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Named proof — rule revisions are immutable and reconstructable byte-
 * identically, and rule mutation is a compare-and-set** (OPUS-M4-000C; doc 34
 * §4-D).
 *
 * ## The three properties, and why each needed a database
 *
 *  1. **Byte-identity.** `rule_revisions.predicate` is `jsonb`, and `jsonb` does
 *     not store bytes — it stores a parsed tree and re-renders it, reordering
 *     object members and normalising numeric literals. So "the revision can be
 *     reconstructed byte-identically" is a claim about PostgreSQL, not about the
 *     serializer, and only a real database can settle it. This is the same
 *     reasoning `round-trip.test.ts` applies to the LIVE row, now applied to
 *     history.
 *
 *  2. **Immutability.** No runtime role holds INSERT, UPDATE or DELETE on
 *     `rule_revisions`, and `app_guard_append_only` refuses UPDATE and DELETE for
 *     the OWNER as well. Both arms are probed, because a grant-only control is
 *     one `GRANT` away from being gone.
 *
 *  3. **The compare-and-set under real concurrency.** A sequential stale-token
 *     test proves the comparison happens and says nothing about whether it is
 *     atomic. `PgUnitOfWorkRunner` issues a plain `BEGIN`, so every unit of work
 *     is READ COMMITTED — the exact condition under which the authoring
 *     surface's unlocked CAS let both writers through in 11 of 12 measured
 *     rounds. So the CAS is raced, twelve times.
 */

const multi = ownedMulti('rules-revision-cas', { profile: 'full' });

let runtime: Runtime;
let admin: pg.Client;

beforeAll(async () => {
  // Two racers plus headroom: a race on a pool of one is not a race.
  runtime = createRuntime('app_runtime', { max: 6 });
  admin = adminClient();
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

function context(correlationId = 'rules-revision-cas'): ReturnType<typeof groupContext> {
  const alpha = multi().alpha;
  return groupContext(
    alpha.organizationId,
    alpha.groupOne.id,
    alpha.users.scheduler.membershipId,
    correlationId,
  );
}

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context(), fn);

/** A distinct synthetic rule per test, so no two tests contend for one row. */
function ruleBody(ruleKey: string, count: number): Parameters<typeof createRule>[1] {
  return {
    ruleKey,
    name: `Revision probe ${String(count)}`,
    classification: 'HARD',
    scope: { shiftTypes: [`ST${String(count)}`] },
    predicate: { kind: 'MaxConsecutive', maxDays: count },
  } as unknown as Parameters<typeof createRule>[1];
}

describe('every rule mutation writes an immutable revision', () => {
  it('a create writes revision 1, and each amendment writes the next', async () => {
    const key = `rev_seq_${randomUUID().slice(0, 8).replace(/-/g, '')}`;

    await run(async (uow) => {
      const created = await createRule(uow, ruleBody(key, 1));
      expect(created.kind).toBe('ok');
      if (created.kind !== 'ok') return;
      expect(created.value.rule.version).toBe(1);
    });

    // Two amendments, each presenting the version it just read.
    for (const next of [2, 3]) {
      await run(async (uow) => {
        const current = await getRule(uow, key);
        if (current.kind !== 'ok') throw new Error('rule vanished');
        const outcome = await updateRule(uow, key, ruleBody(key, next), current.value.version);
        expect(outcome.kind).toBe('ok');
      });
    }

    const revisions = await run((uow) => listRuleRevisions(uow, key));
    // Newest first, gapless, one per mutation.
    expect(revisions.map((revision) => revision.revision)).toEqual([3, 2, 1]);
    expect(revisions.every((revision) => revision.ruleKey === key)).toBe(true);
  });

  it('a HISTORICAL revision reconstructs BYTE-IDENTICALLY after later rewrites', async () => {
    const key = `rev_bytes_${randomUUID().slice(0, 8).replace(/-/g, '')}`;

    const authored: Rule = {
      ruleKey: key,
      name: 'Byte identity probe',
      ruleSchemaVersion: RULE_SCHEMA_VERSION,
      classification: 'SOFT',
      weight: 12.5,
      // Deliberately awkward: key order that jsonb will reorder, an array whose
      // ORDER is meaning, and a fractional number jsonb re-renders.
      scope: { staffGroups: ['zeta', 'alpha'], shiftTypes: ['B', 'A'] },
      predicate: {
        kind: 'PatternRule',
        trigger: 'A',
        daysOfWeek: ['wed', 'mon'],
        segments: [
          { offsetDays: 2, shiftType: 'B' },
          { offsetDays: -1, shiftType: 'C' },
        ],
      },
    };
    const authoredBytes = canonicalStringify({
      scope: authored.scope,
      predicate: authored.predicate,
    });

    await run(async (uow) => {
      const created = await createRule(uow, authored as never);
      expect(created.kind).toBe('ok');
    });

    // Rewrite it twice into something completely different.
    for (const next of [7, 9]) {
      await run(async (uow) => {
        const current = await getRule(uow, key);
        if (current.kind !== 'ok') throw new Error('rule vanished');
        const outcome = await updateRule(uow, key, ruleBody(key, next), current.value.version);
        expect(outcome.kind).toBe('ok');
      });
    }

    const reconstructed = await run((uow) => loadRuleRevision(uow, key, 1));
    expect(reconstructed).not.toBeNull();
    if (reconstructed === null) return;

    // The equality that matters: the same BYTES, not "looks the same".
    expect(
      canonicalStringify({
        scope: reconstructed.scope,
        predicate: reconstructed.predicate,
      }),
    ).toBe(authoredBytes);
    expect(reconstructed.ruleKey).toBe(key);
    expect(reconstructed.classification).toBe('SOFT');
    expect(reconstructed.classification === 'SOFT' ? reconstructed.weight : null).toBe(12.5);

    // …and the live row is genuinely something else, so the reconstruction is
    // not passing because nothing ever changed.
    const live = await run((uow) => getRule(uow, key));
    if (live.kind !== 'ok') throw new Error('rule vanished');
    expect(canonicalStringify(live.value.predicate)).not.toBe(
      canonicalStringify(reconstructed.predicate),
    );
  });

  it('a state change is a revision too — history records what was disabled', async () => {
    const key = `rev_state_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    await run(async (uow) => {
      const created = await createRule(uow, ruleBody(key, 4));
      expect(created.kind).toBe('ok');
    });
    await run(async (uow) => {
      const current = await getRule(uow, key);
      if (current.kind !== 'ok') throw new Error('rule vanished');
      const outcome = await setRuleState(uow, key, 'disabled', current.value.version);
      expect(outcome.kind).toBe('ok');
    });

    const revisions = await run((uow) => listRuleRevisions(uow, key));
    expect(revisions.map((revision) => revision.state)).toEqual(['disabled', 'active']);
  });
});

describe('a revision cannot be rewritten or deleted', () => {
  async function seedOne(): Promise<string> {
    const key = `rev_immut_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    await run(async (uow) => {
      const created = await createRule(uow, ruleBody(key, 5));
      expect(created.kind).toBe('ok');
    });
    return key;
  }

  it('the RUNTIME role holds no INSERT, UPDATE or DELETE on rule_revisions', async () => {
    const key = await seedOne();

    for (const statement of [
      `insert into rule_revisions (organization_id, group_id, rule_id, rule_key, revision,
         rule_schema_version, name, classification, weight, category, scope, predicate, status)
       select organization_id, group_id, id, rule_key, 99, rule_schema_version, name,
              classification, weight, category, scope, predicate, status
         from rules where rule_key = $1`,
      `update rule_revisions set name = 'forged' where rule_key = $1`,
      `delete from rule_revisions where rule_key = $1`,
    ]) {
      await expect(
        run(async (uow) => {
          const { sql } = await import('kysely');
          return sql.raw(statement.replace('$1', `'${key}'`)).execute(uow.query);
        }),
      ).rejects.toThrow();
    }
  });

  it('the OWNER is refused too — the append-only guard is not a grant trick', async () => {
    /* A grant-only control is one `GRANT` away from being gone, and the owner
     * path is exactly where a maintenance script would run. `app_guard_append_only`
     * binds the owner as well, and this is the arm that proves it. */
    const key = await seedOne();
    const row = await admin.query<{ id: string }>(
      'select id from rule_revisions where rule_key = $1 limit 1',
      [key],
    );
    const id = row.rows[0]?.id;
    expect(id).toBeDefined();

    await expect(
      admin.query('update rule_revisions set name = $2 where id = $1', [id, 'forged']),
    ).rejects.toThrow(/APPEND_ONLY/);
    await expect(admin.query('delete from rule_revisions where id = $1', [id])).rejects.toThrow(
      /APPEND_ONLY/,
    );
  });
});

describe('the compare-and-set refuses a stale write, and does so ATOMICALLY', () => {
  it('a stale expectedVersion is refused with the current one, and nothing is written', async () => {
    const key = `cas_stale_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    await run(async (uow) => {
      const created = await createRule(uow, ruleBody(key, 1));
      expect(created.kind).toBe('ok');
    });

    await run(async (uow) => {
      const outcome = await updateRule(uow, key, ruleBody(key, 2), 1);
      expect(outcome.kind).toBe('ok');
    });

    const stale = await run((uow) => updateRule(uow, key, ruleBody(key, 3), 1));
    expect(stale.kind).toBe('stale');
    if (stale.kind === 'stale') expect(stale.currentVersion).toBe(2);

    // The refusal wrote nothing: the stored predicate is still the WINNER's.
    const live = await run((uow) => getRule(uow, key));
    if (live.kind !== 'ok') throw new Error('rule vanished');
    expect((live.value.predicate as { maxDays: number }).maxDays).toBe(2);
  });

  it('twelve concurrent rounds: exactly one writer wins each, and the DATABASE agrees', async () => {
    /* The measured failure this closes: two concurrent writers reading the same
     * pre-state under READ COMMITTED and BOTH being accepted. "One ok and one
     * stale" is necessary and not sufficient — a CAS that answered `stale` AFTER
     * writing would satisfy it — so each round also asserts the stored value is
     * the winner's and the loser's value is absent. */
    const key = `cas_race_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    await run(async (uow) => {
      const created = await createRule(uow, ruleBody(key, 1));
      expect(created.kind).toBe('ok');
    });

    for (let round = 1; round <= 12; round += 1) {
      const current = await run((uow) => getRule(uow, key));
      if (current.kind !== 'ok') throw new Error('rule vanished');
      const expectedVersion = current.value.version;

      // Both intents are built BEFORE the race, so the two transactions overlap
      // rather than being serialized by their own setup.
      const left = 100 + round * 2;
      const right = 101 + round * 2;

      const [a, b] = await Promise.all([
        runtime.runner.run(context(`race-a-${String(round)}`), (uow) =>
          updateRule(uow, key, ruleBody(key, left), expectedVersion),
        ),
        runtime.runner.run(context(`race-b-${String(round)}`), (uow) =>
          updateRule(uow, key, ruleBody(key, right), expectedVersion),
        ),
      ]);

      const kinds = [a.kind, b.kind].sort();
      expect(kinds, `round ${String(round)}: both writers were accepted`).toEqual(['ok', 'stale']);

      const stored = await admin.query<{ predicate: { maxDays: number }; version: number }>(
        'select predicate, version from rules where rule_key = $1',
        [key],
      );
      const winner = a.kind === 'ok' ? left : right;
      const loser = a.kind === 'ok' ? right : left;
      expect(stored.rows[0]?.predicate.maxDays).toBe(winner);
      expect(stored.rows[0]?.predicate.maxDays).not.toBe(loser);
      // Exactly one write happened, so the counter moved by exactly one.
      expect(stored.rows[0]?.version).toBe(expectedVersion + 1);
    }
  }, 180_000);
});

describe('a build or publication can name the exact revisions it used', () => {
  it('currentRuleRevisions reports rule_key@revision for the ACTIVE rules', async () => {
    const key = `cur_rev_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    await run(async (uow) => {
      const created = await createRule(uow, ruleBody(key, 1));
      expect(created.kind).toBe('ok');
    });
    await run(async (uow) => {
      const current = await getRule(uow, key);
      if (current.kind !== 'ok') throw new Error('rule vanished');
      await updateRule(uow, key, ruleBody(key, 2), current.value.version);
    });

    const cited = await run((uow) => currentRuleRevisions(uow, [key]));
    expect(cited).toEqual([{ ruleKey: key, revision: 2 }]);

    // And the cited revision reconstructs to the CURRENT content, which is what
    // makes the citation worth recording.
    const reconstructed = await run((uow) => loadRuleRevision(uow, key, 2));
    expect((reconstructed?.predicate as { maxDays: number } | undefined)?.maxDays).toBe(2);
  });

  it('a DISABLED rule is not cited — disabling means no build consumes it', async () => {
    const key = `cur_dis_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    await run(async (uow) => {
      const created = await createRule(uow, ruleBody(key, 1));
      expect(created.kind).toBe('ok');
    });
    await run(async (uow) => {
      const current = await getRule(uow, key);
      if (current.kind !== 'ok') throw new Error('rule vanished');
      await setRuleState(uow, key, 'disabled', current.value.version);
    });
    expect(await run((uow) => currentRuleRevisions(uow, [key]))).toEqual([]);
  });
});
