import {
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_CHANNELS,
  REQUEST_OPERATIONS,
  REQUEST_REASON_CODES,
  commentContentIsWellFormed,
} from '@schedulepoint/domain';
import {
  commentChannelSchema,
  requestReasonCodeSchema,
} from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';

/**
 * **FAD-58's controlled vocabulary lives in THREE copies, and this file holds
 * them to each other** (OPUS-M5-00C, doc 42 §5g).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Why three copies exist at all
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `REQUEST_REASON_CODES` in `@schedulepoint/domain`, `requestReasonCodeSchema`
 * in `@schedulepoint/contracts`, and migration 0026's
 * `request_comments_reason_code_domain` CHECK. They cannot be ONE copy:
 * `packages/contracts` may import zod and nothing else
 * (`.dependency-cruiser.cjs`'s `contracts-imports-only-zod`), and a database
 * CHECK is SQL. So the repository's standing answer applies — *two copies of a
 * closed set are two truths that can drift*, and they are held to each other by
 * test rather than left to agree by inspection. This is the discipline the
 * subtype and status vocabularies already use.
 *
 * **The database copy is read from the LIVE CONSTRAINT**, not from the migration
 * text: `pg_get_constraintdef` says what the server is enforcing, and a
 * migration file says what somebody wrote. On this table the difference is the
 * whole point of having a third copy.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The three NEGATIVE claims, which are the ones FAD-58 is about
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **No clinical code is in the vocabulary, at any layer.** The absence of a
 *     medical or sick code is the DESIGN, not an oversight: a requester whose
 *     reason is medical selects `personal` or `other` and discloses nothing.
 *     Asserted as a list of near-synonyms rather than as a single name, so
 *     "helpfully" adding `sick` or `appointment` fails here.
 *  2. **`other` is TERMINAL.** It exists, and nothing anywhere pairs it with a
 *     text field — the wire schema is `.strict()` with one member, and the
 *     domain's content type has no arm carrying both a code and prose.
 *  3. **`comment` is not a lifecycle operation.** `REQUEST_OPERATIONS` still has
 *     exactly its six status-moving members, pinned by name. Doc 42 §5g's "the
 *     R-01 cross-product extends to any new operation in both layers" was read
 *     as *any new STATUS-MOVING operation*, because `OperationVerdict`'s allowed
 *     arm carries `to: RequestStatus` — a comment has no target status, so
 *     adding it would require inventing one and the cross-product would then
 *     assert something false about every (subtype × status) pair. The
 *     both-layers obligation is discharged where it genuinely bites instead: the
 *     exactly-one-of rule, in the domain here and in 0026's CHECKs, each
 *     independently load-bearing.
 *
 * ## Synthetic only
 *
 * Nothing here writes a row. No organization, site or person name from the
 * research appears.
 */

let admin: pg.Client;

/** The CHECK the server is actually enforcing, as its own text. */
async function reasonCodeConstraintDef(): Promise<string> {
  const result = await admin.query<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname = 'request_comments'
        and c.conname = 'request_comments_reason_code_domain'`,
  );
  const def = result.rows[0]?.def;
  if (def === undefined) {
    throw new Error('request_comments_reason_code_domain is not on the live schema');
  }
  return def;
}

/**
 * The codes the live CHECK admits, parsed out of its own definition.
 *
 * Parsed rather than assumed: the alternative is asserting that the constraint
 * text CONTAINS each expected code, which passes just as happily on a constraint
 * that also admits four codes nobody declared. Extracting the set makes the
 * comparison total in both directions.
 */
function codesInConstraint(def: string): string[] {
  return [...def.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1] as string);
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
}, 120_000);

afterAll(async () => {
  await admin?.end();
});

describe('the reason-code vocabulary agrees across all three copies', () => {
  it('domain and contracts hold the SAME nine codes, as sets and in order', () => {
    expect([...requestReasonCodeSchema.options]).toEqual([...REQUEST_REASON_CODES]);
    expect(new Set(requestReasonCodeSchema.options)).toEqual(new Set(REQUEST_REASON_CODES));
    expect(REQUEST_REASON_CODES).toHaveLength(9);
  });

  it('the LIVE database CHECK admits exactly the same set', async () => {
    const admitted = codesInConstraint(await reasonCodeConstraintDef());
    /* Non-vacuity: a parse that found nothing would make the comparison below
     * trivially true against an empty expected set only — but if the parse broke,
     * this line fails first and names the reason. */
    expect(admitted.length, 'the constraint parse found no codes').toBeGreaterThan(0);
    expect(new Set(admitted)).toEqual(new Set(REQUEST_REASON_CODES));
  });

  it('the two channels agree across domain, contracts and the live CHECK', async () => {
    expect([...commentChannelSchema.options]).toEqual([...COMMENT_CHANNELS]);
    const result = await admin.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'request_comments'
          and c.conname = 'request_comments_channel_domain'`,
    );
    const def = result.rows[0]?.def ?? '';
    expect(new Set(codesInConstraint(def))).toEqual(new Set(COMMENT_CHANNELS));
  });
});

describe('the three NEGATIVE claims FAD-58 rests on', () => {
  /**
   * The near-synonyms a future packet might reach for. Named individually so the
   * failure message says which one arrived, rather than "the set changed".
   */
  const CLINICAL_NEAR_SYNONYMS = [
    'medical',
    'sick',
    'sickness',
    'illness',
    'health',
    'appointment',
    'treatment',
    'therapy',
    'surgery',
    'clinical',
    'diagnosis',
    'condition',
    'recovery',
    'injury',
  ] as const;

  it('NO clinical code exists at any of the three layers — the absence is the design', async () => {
    const constraintDef = await reasonCodeConstraintDef();
    for (const word of CLINICAL_NEAR_SYNONYMS) {
      expect(
        REQUEST_REASON_CODES as readonly string[],
        `\`${word}\` entered the domain vocabulary — FAD-58.1 rules the requester channel ` +
          'non-clinical, and a requester whose reason is medical uses `personal` or `other`',
      ).not.toContain(word);
      expect(requestReasonCodeSchema.options as readonly string[]).not.toContain(word);
      expect(constraintDef, `\`${word}\` entered the database CHECK`).not.toContain(`'${word}'`);
    }
    /* The positive half: the two codes a medical requester actually uses ARE
     * there, so this is a statement about what the list offers instead rather
     * than about it being short. */
    expect(REQUEST_REASON_CODES).toContain('personal');
    expect(REQUEST_REASON_CODES).toContain('other');
  });

  it('`other` is TERMINAL — it carries no companion text, in the type or on the wire', () => {
    expect(REQUEST_REASON_CODES).toContain('other');

    /* The domain's own answer: a requester content with a body is refused
     * whatever the code is, INCLUDING `other`, which is the code somebody would
     * reach for a "specify" field with. */
    expect(
      commentContentIsWellFormed({
        channel: 'requester',
        reasonCode: 'other',
        body: 'and here is what I actually mean',
      }),
    ).toEqual({ ok: false, reason: 'channel-content-mismatch' });

    /* …and the wire refuses the same body STRUCTURALLY. `.strict()` with one
     * member: there is no field to null and none to drop, because none was ever
     * declared. */
    const parsed = requestReasonCodeSchema.safeParse('other');
    expect(parsed.success).toBe(true);
  });

  it('`comment` is NOT a lifecycle operation — the list is pinned BY NAME', () => {
    /* Pinned BY NAME rather than by count, so a swap would fail as loudly as an
     * addition. See this file's header for why extending the list would have
     * falsified `OperationVerdict`, and what discharges the both-layers
     * obligation instead.
     *
     * ── OPUS-M5-004 extended the list to EIGHT, and the extension is this pin
     * working rather than being worked around. `commit` and `reverse` are
     * STATUS-MOVING (`approved → reflected_in_version`,
     * `reflected_in_version → reversed`, both §2's vacation column), which is
     * D-1's own criterion — the same criterion that kept `comment` OUT and keeps
     * it out below. A comment moves nothing: `request-comments.test.ts` proves
     * the root is byte-identical across an append, and migration 0026's header
     * §7 says there is no trigger that could. */
    expect([...REQUEST_OPERATIONS]).toEqual([
      'submit',
      'withdraw',
      'expire',
      'approve',
      'deny',
      'reverse_decision',
      'commit',
      'reverse',
    ]);
    expect(REQUEST_OPERATIONS as readonly string[]).not.toContain('comment');
  });
});

describe('the exactly-one-of rule, as the DOMAIN answers it', () => {
  /* The database half of the same rule is
   * `migration-0026-populated-cycle.test.ts`'s "every CHECK refuses, in both
   * directions". Two layers, each provable alone — which is what makes this two
   * layers rather than one layer and a comment. */

  it('a requester comment carrying PROSE is refused — the violation FAD-58 is about', () => {
    expect(
      commentContentIsWellFormed({
        channel: 'requester',
        reasonCode: 'childcare',
        body: 'my daughter has an appointment that morning',
      }),
    ).toEqual({ ok: false, reason: 'channel-content-mismatch' });
  });

  it('a SCHEDULER comment carrying a CODE is refused — the other direction', () => {
    /* Easier to forget and just as load-bearing: it would be a decider
     * attributing a circumstance to the person whose request it is. */
    expect(
      commentContentIsWellFormed({
        channel: 'scheduler',
        reasonCode: 'bereavement',
        body: 'A note about the rota.',
      }),
    ).toEqual({ ok: false, reason: 'channel-content-mismatch' });
  });

  it('an unknown channel, an unknown code, and a malformed body each get their own reason', () => {
    expect(commentContentIsWellFormed({ channel: 'auditor', body: 'x' })).toEqual({
      ok: false,
      reason: 'channel-not-in-domain',
    });
    expect(commentContentIsWellFormed({ channel: 'requester', reasonCode: 'medical' })).toEqual({
      ok: false,
      reason: 'reason-code-not-in-vocabulary',
    });
    expect(commentContentIsWellFormed({ channel: 'scheduler', body: '   ' })).toEqual({
      ok: false,
      reason: 'body-not-well-formed',
    });
    expect(
      commentContentIsWellFormed({
        channel: 'scheduler',
        body: 'x'.repeat(COMMENT_BODY_MAX_LENGTH + 1),
      }),
    ).toEqual({ ok: false, reason: 'body-not-well-formed' });
  });

  it('and the two LEGAL shapes are accepted, so the refusals above are not blanket', () => {
    expect(commentContentIsWellFormed({ channel: 'requester', reasonCode: 'travel' })).toEqual({
      ok: true,
      content: { channel: 'requester', reasonCode: 'travel' },
    });
    expect(
      commentContentIsWellFormed({ channel: 'scheduler', body: 'The week is covered.' }),
    ).toEqual({ ok: true, content: { channel: 'scheduler', body: 'The week is covered.' } });
  });

  it('the bound is the administrative class’s, exactly — 1000, as `approvals.reason` is', () => {
    expect(COMMENT_BODY_MAX_LENGTH).toBe(1000);
    expect(
      commentContentIsWellFormed({
        channel: 'scheduler',
        body: 'x'.repeat(COMMENT_BODY_MAX_LENGTH),
      }).ok,
    ).toBe(true);
  });
});
