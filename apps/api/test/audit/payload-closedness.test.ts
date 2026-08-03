import {
  AuditPayloadNotClosedError,
  assertClosedAuditPayload,
  auditPayloadViolations,
  isClosedAuditPayload,
} from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { FIXTURE, organizationContext } from '../support/fixtures.js';
import { createRuntime, log } from '../support/harness.js';

/**
 * I-07 — the audit payload is closed, in TWO places, and they agree.
 *
 * `packages/domain/src/audit/payload.ts` is the application's rule;
 * `app_audit_payload_is_closed(jsonb)` in migration 0003 is the database's. Two
 * validators that drift apart are worse than one, because the weaker one becomes
 * the real rule while the stronger one is the documented one — so this file runs
 * **one corpus through both** and asserts they agree on every case, rather than
 * testing each against its own expectations.
 *
 * The corpus deliberately includes the things a hurried implementer reaches for:
 * a nested object, a null, an array, and a sentence.
 */

interface Candidate {
  readonly label: string;
  readonly payload: unknown;
  readonly closed: boolean;
  readonly why: string;
}

const CORPUS: readonly Candidate[] = [
  { label: 'empty', payload: {}, closed: true, why: 'the ordinary case for an event with no extra facts' },
  {
    label: 'identifiers and tokens',
    payload: {
      membershipId: '11111111-1111-4111-8111-111111111111',
      kind: 'group',
      attempt: 3,
      deduplicated: false,
    },
    closed: true,
    why: 'exactly what an audit payload is for',
  },
  {
    label: 'an ISO timestamp',
    payload: { occurredAt: '2026-08-02T10:11:12.000Z' },
    closed: true,
    why: 'no whitespace, under 64 characters',
  },
  { label: 'a sentence', payload: { note: 'patient asked to swap' }, closed: false, why: 'FREE TEXT — the case I-07 exists for' },
  { label: 'a single space', payload: { note: 'a b' }, closed: false, why: 'whitespace is the rule, not sentence detection' },
  { label: 'a newline', payload: { note: 'a\nb' }, closed: false, why: 'whitespace includes newlines' },
  { label: 'a tab', payload: { note: 'a\tb' }, closed: false, why: 'and tabs' },
  {
    label: 'a non-breaking space',
    payload: { note: 'a\u00a0b' },
    closed: false,
    why: 'the case that MADE this an allowlist: `[[:space:]]` in SQL does not match U+00A0',
  },
  {
    label: 'a control character',
    payload: { token: 'a\u0001b' },
    closed: false,
    why: 'printable ASCII only',
  },
  {
    label: 'an emoji',
    payload: { token: 'ok\u2705' },
    closed: false,
    why: 'non-ASCII is not a token',
  },
  {
    label: 'a 65-character token',
    payload: { token: 'x'.repeat(65) },
    closed: false,
    why: 'over the length bound — long enough to hide a sentence with the spaces removed',
  },
  { label: 'a 64-character token', payload: { token: 'x'.repeat(64) }, closed: true, why: 'exactly at the bound' },
  { label: 'a nested object', payload: { inner: { a: 1 } }, closed: false, why: 'nesting is unbounded by construction' },
  { label: 'an array', payload: { items: [1, 2] }, closed: false, why: 'same' },
  { label: 'a null value', payload: { a: null }, closed: false, why: '"absent" is expressed by omitting the key' },
  { label: 'a top-level array', payload: [], closed: false, why: 'the payload is an object' },
  { label: 'a top-level null', payload: null, closed: false, why: 'same' },
  { label: 'a top-level string', payload: 'nope', closed: false, why: 'same' },
  { label: 'a snake_case key', payload: { membership_id: 'x' }, closed: false, why: 'keys are lowerCamel' },
  { label: 'a key with a space', payload: { 'a b': 'x' }, closed: false, why: 'a key is an identifier' },
  {
    label: '17 keys',
    payload: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${String(i)}`, i])),
    closed: false,
    why: 'over the 16-key bound',
  },
  {
    label: '16 keys',
    payload: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${String(i)}`, i])),
    closed: true,
    why: 'exactly at the bound',
  },
];

const admin = adminClient();

beforeAll(async () => {
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
});

describe('I-07 — the audit payload schema is closed', () => {
  it('the TypeScript validator classifies every candidate as expected', () => {
    for (const c of CORPUS) {
      expect(isClosedAuditPayload(c.payload), `${c.label}: ${c.why}`).toBe(c.closed);
    }
    log(`TypeScript validator: ${String(CORPUS.length)} candidates, all as expected`);
  });

  it('the SQL CHECK function agrees with it on every candidate', async () => {
    const disagreements: string[] = [];
    for (const c of CORPUS) {
      // A candidate that is not a JSON object cannot be passed as `jsonb` at all
      // in a column of that type; the SQL function still has to answer for it,
      // because `jsonb` accepts arrays, nulls and scalars perfectly happily.
      const { rows } = await admin.query<{ closed: boolean | null }>(
        'select app_audit_payload_is_closed($1::jsonb) as closed',
        [JSON.stringify(c.payload)],
      );
      const sqlClosed = rows[0]?.closed ?? false;
      if (sqlClosed !== c.closed) {
        disagreements.push(
          `${c.label}: TypeScript says ${String(c.closed)}, SQL says ${String(sqlClosed)}`,
        );
      }
    }
    expect(disagreements, disagreements.join('\n')).toEqual([]);
    log(`SQL CHECK function agrees on all ${String(CORPUS.length)} candidates`);
  });

  it('the database REFUSES a free-text payload even when the application layer is bypassed', async () => {
    // Straight at the table, inside a real unit of work but with the recorder
    // and its validator out of the path entirely. The CHECK constraint is what
    // has to hold here.
    //
    // The unit of work is required rather than incidental: the chain trigger's
    // SECURITY DEFINER insert into `audit_chain_heads` is itself under FORCE
    // RLS, so an audit insert with no tenant context fails at 42501 before the
    // payload CHECK is ever reached. That is a second, independent proof that an
    // audit row cannot be written outside a unit of work — and it is why this
    // test has to establish one to reach the constraint it is actually testing.
    const runtime = createRuntime('app_runtime');
    try {
      await expect(
        runtime.runner.run(
          organizationContext(FIXTURE.alpha.organizationId, 'payload-bypass'),
          async ({ query }) => {
            await sql`
              insert into audit_events (organization_id, id, event_name, actor_kind,
                                        subject_type, subject_id, correlation_id, payload)
              values (${FIXTURE.alpha.organizationId}::uuid, gen_random_uuid(),
                      'membership.activity_touched', 'system', 'membership',
                      gen_random_uuid(), 'probe',
                      ${JSON.stringify({ note: 'free text here' })}::jsonb)
            `.execute(query);
          },
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await runtime.destroy();
    }
    log('a free-text payload is rejected by the CHECK constraint (SQLSTATE 23514)');
  });

  it('the violation error names the rule and the key, and NEVER the value', () => {
    let message = '';
    try {
      assertClosedAuditPayload({ clinicalNote: 'do not repeat me' });
    } catch (error) {
      expect(error).toBeInstanceOf(AuditPayloadNotClosedError);
      message = (error as Error).message;
    }
    expect(message).toContain('string_not_a_token');
    expect(message).toContain('clinicalNote');
    // Rule 9: an error that quoted the free text it rejected would put that free
    // text into a log, which is the thing being prevented.
    expect(message).not.toContain('do not repeat me');
    log(`violation message carries rule + key only: ${message}`);
  });

  it('reports EVERY rule a payload breaks, not merely the first', () => {
    const violations = auditPayloadViolations({ 'bad key': 'a b'.repeat(40) });
    const codes = violations.map((v) => v.code).sort();
    expect(codes).toEqual(['key_not_an_identifier', 'string_not_a_token', 'string_too_long']);
  });
});
