import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalCheckpointSigner } from '../../src/audit/checkpoint-signer.js';
import { writeCheckpoint } from '../../src/audit/checkpoints.js';
import { recordAuditEvent } from '../../src/audit/recorder.js';
import {
  GroupScopedChainVerificationError,
  verifyAuditChain,
  verifyCheckpoints,
} from '../../src/audit/verification.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE, groupContext, organizationContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';

/**
 * SPEC-11 §2 and §10 — the chain, the checkpoints, and append-only.
 *
 * ## The test contract, and which parts of it this file covers
 *
 * | # | SPEC-11 §10 | Here |
 * |---|---|---|
 * | **X-01** | edit an audit row → chain verification detects it | yes |
 * | **X-02** | rewrite a chain segment consistently → checkpoint signature mismatch detected | yes |
 * | **X-03** | restore to a point, verify chain → continuity proven, or **the gap explicitly recorded** | yes (the gap case; a full backup restore is out of scope for a unit harness) |
 * | X-04..X-18 | external copy, legal hold, OIDC, SSRF, … | **not covered.** Out of this milestone's scope; recorded in `docs/evidence/EV-M1-AUDIT/INDEX.md` §5 |
 *
 * ## Why the tampering is done with the SUPERUSER
 *
 * Because that is the threat. SPEC-11 §3 is explicit that the interesting
 * adversary is a privileged database actor, and a test that could only tamper as
 * `app_runtime` would be testing the grant — which the append-only block below
 * does separately, and on its own terms. Here the point is that **detection
 * survives an actor powerful enough to defeat prevention**.
 *
 * ## Every destructive test restores what it broke
 *
 * Not tidiness. The first full `pnpm check` run failed two unrelated tests in
 * `crash-restart.test.ts` because X-03 had left a permanent gap in Alpha's chain
 * and every later verification in the battery reported it. A destructive test
 * that does not restore is a test that decides the result of every test after it.
 */

const ALPHA = FIXTURE.alpha;
/** Beta carries the X-02 rewrite, so Alpha's chain stays clean for everyone else. */
const BETA = FIXTURE.beta;

const admin = adminClient();
let runtime: Runtime;
let worker: Runtime;

beforeAll(async () => {
  await admin.connect();
  runtime = createRuntime('app_runtime');
  worker = createRuntime('app_worker');
});

afterAll(async () => {
  await runtime.destroy();
  await worker.destroy();
  await admin.end();
});

/** Appends `n` events under a group context and returns what the chain assigned. */
async function appendEvents(
  organizationId: string,
  groupId: string,
  membershipId: string,
  n: number,
  correlationId: string,
) {
  const context = groupContext(organizationId, groupId, membershipId, correlationId);
  const recorded = [];
  for (let i = 0; i < n; i += 1) {
    recorded.push(
      await runtime.runner.run(context, (uow) =>
        recordAuditEvent(uow, {
          eventName: 'membership.activity_touched',
          subjectType: 'membership',
          subjectId: membershipId,
          payload: { index: i },
        }),
      ),
    );
  }
  return recorded;
}

const appendAlpha = (n: number, correlationId: string) =>
  appendEvents(
    ALPHA.organizationId,
    ALPHA.groupOne.id,
    ALPHA.users.scheduler.membershipId,
    n,
    correlationId,
  );

const appendBeta = (n: number, correlationId: string) =>
  appendEvents(
    BETA.organizationId,
    BETA.groupOne.id,
    BETA.users.scheduler.membershipId,
    n,
    correlationId,
  );

async function countVisible(
  context: Parameters<Runtime['runner']['run']>[0],
  correlationId: string,
): Promise<number> {
  return runtime.runner.run(context, async ({ query }) => {
    const r = await sql<{ n: string }>`
      select count(*)::text as n from audit_events where correlation_id = ${correlationId}
    `.execute(query);
    return Number(r.rows[0]?.n ?? '-1');
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
describe('SPEC-11 §2 — the hash chain', () => {
  it('assigns a gapless per-organization sequence and links each row to the last', async () => {
    const recorded = await appendAlpha(5, 'chain-basic');

    const sequences = recorded.map((r) => Number(r.sequence));
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i], 'the sequence is gapless').toBe((sequences[i - 1] ?? 0) + 1);
    }
    for (let i = 1; i < recorded.length; i += 1) {
      expect(recorded[i]?.prevHash, "each row carries the previous row's hash").toBe(
        recorded[i - 1]?.entryHash,
      );
    }
    expect(new Set(recorded.map((r) => r.entryHash)).size).toBe(recorded.length);
    log(
      `5 events: sequence ${String(sequences[0])}..${String(sequences.at(-1))}, ` +
        'each prev_hash equals the previous entry_hash',
    );
  });

  it('prev_hash is part of the HASHED INPUT, not merely a stored neighbour', async () => {
    // This is the difference between a chain and a column of independent
    // checksums, and it is the defect X-02 found in the first version of
    // migration 0003: with `prev_hash` omitted from the canonical bytes,
    // altering row N left every row after it verifying perfectly and the head
    // hash unchanged.
    const recorded = await appendAlpha(2, 'chain-prev-hash-matters');
    const second = recorded[1];
    const first = recorded[0];

    const reproduced = await admin.query<{ h: string }>(
      `select encode(sha256(app_audit_canonical_bytes(
                e.organization_id, e.prev_hash, e.sequence, e.id, e.occurred_at, e.event_name,
                e.actor_kind, e.actor_membership_id, e.group_id, e.subject_type, e.subject_id,
                e.correlation_id, e.payload)), 'hex') as h
         from audit_events e
        where e.organization_id = $1::uuid and e.sequence = $2::bigint`,
      [ALPHA.organizationId, second?.sequence],
    );
    expect(reproduced.rows[0]?.h, 'the stored hash is reproducible from the row').toBe(
      second?.entryHash,
    );

    const withOtherPrev = await admin.query<{ h: string }>(
      `select encode(sha256(app_audit_canonical_bytes(
                e.organization_id, decode($3, 'hex'), e.sequence, e.id, e.occurred_at,
                e.event_name, e.actor_kind, e.actor_membership_id, e.group_id, e.subject_type,
                e.subject_id, e.correlation_id, e.payload)), 'hex') as h
         from audit_events e
        where e.organization_id = $1::uuid and e.sequence = $2::bigint`,
      [ALPHA.organizationId, second?.sequence, first?.prevHash],
    );
    expect(
      withOtherPrev.rows[0]?.h,
      'changing ONLY prev_hash must change the entry hash',
    ).not.toBe(second?.entryHash);
    log('prev_hash participates in the hash: changing only it changes entry_hash');
  });

  it('the application CANNOT name a chain column: the grant does not include it', async () => {
    await expect(
      runtime.runner.run(
        organizationContext(ALPHA.organizationId, 'chain-forge'),
        async ({ query }) => {
          await sql`
            insert into audit_events (organization_id, id, event_name, actor_kind, subject_type,
                                      subject_id, correlation_id, sequence, prev_hash, entry_hash)
            values (${ALPHA.organizationId}::uuid, ${randomUUID()}::uuid,
                    'membership.activity_touched', 'system', 'membership',
                    ${randomUUID()}::uuid, 'forge', 1, sha256(''::bytea), sha256(''::bytea))
          `.execute(query);
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });
    log('naming sequence/prev_hash/entry_hash in an INSERT raises 42501 (insufficient_privilege)');
  });

  it('the chain is per ORGANIZATION, with a genesis bound to the organization id', async () => {
    const genesis = async (organizationId: string): Promise<string> => {
      const r = await admin.query<{ h: string }>(
        `select encode(sha256(convert_to('sp.audit.genesis.v1:' || $1::text, 'UTF8')), 'hex') as h`,
        [organizationId],
      );
      return String(r.rows[0]?.h);
    };
    const alphaGenesis = await genesis(ALPHA.organizationId);
    const betaGenesis = await genesis(BETA.organizationId);
    expect(alphaGenesis, 'two organizations cannot be spliced').not.toBe(betaGenesis);

    const firstBeta = await admin.query<{ prev: string; sequence: string }>(
      `select encode(prev_hash, 'hex') as prev, sequence::text as sequence
         from audit_events where organization_id = $1::uuid order by sequence limit 1`,
      [BETA.organizationId],
    );
    if (firstBeta.rows[0] === undefined) {
      const recorded = await appendBeta(1, 'chain-beta-genesis');
      expect(recorded[0]?.sequence).toBe('1');
      expect(recorded[0]?.prevHash).toBe(betaGenesis);
    } else {
      expect(firstBeta.rows[0].sequence).toBe('1');
      expect(firstBeta.rows[0].prev).toBe(betaGenesis);
    }
    log("each organization's chain begins at sequence 1 from its own genesis link");
  });

  it('verification reports an intact chain', async () => {
    const result = await runtime.runner.run(
      organizationContext(ALPHA.organizationId, 'chain-verify'),
      (uow) => verifyAuditChain(uow),
    );
    expect(result.intact, JSON.stringify(result.problems)).toBe(true);
    expect(result.entries).toBeGreaterThan(0);
    log(`chain intact: ${String(result.entries)} entries, head ${String(result.headSequence)}`);
  });

  it('verification REFUSES a group-scoped context rather than returning a wrong answer', async () => {
    await expect(
      runtime.runner.run(
        groupContext(ALPHA.organizationId, ALPHA.groupOne.id, null, 'chain-wrong-scope'),
        (uow) => verifyAuditChain(uow),
      ),
    ).rejects.toBeInstanceOf(GroupScopedChainVerificationError);
    log('a group-scoped verification is refused (it would see a subset and cry wolf)');
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('SPEC-11 §10 X-01 — an edited audit row is detected', () => {
  it('a privileged UPDATE that defeats the trigger is caught by chain verification', async () => {
    const before = await runtime.runner.run(
      organizationContext(ALPHA.organizationId, 'x01-before'),
      (uow) => verifyAuditChain(uow),
    );
    expect(before.intact, JSON.stringify(before.problems)).toBe(true);

    // Defeating the refusal trigger requires disabling it — which is exactly the
    // point SPEC-11 §2 makes: prevention is defeasible by a privileged actor,
    // detection is not. This is that attack, performed.
    const target = await admin.query<{ sequence: string }>(
      `select sequence::text as sequence from audit_events
        where organization_id = $1::uuid order by sequence limit 1 offset 1`,
      [ALPHA.organizationId],
    );
    const sequence = target.rows[0]?.sequence;
    expect(sequence).toBeDefined();

    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    try {
      await admin.query(
        `update audit_events set payload = payload || '{"tampered": true}'::jsonb
          where organization_id = $1::uuid and sequence = $2::bigint`,
        [ALPHA.organizationId, sequence],
      );
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');
    }

    const after = await runtime.runner.run(
      organizationContext(ALPHA.organizationId, 'x01-after'),
      (uow) => verifyAuditChain(uow),
    );
    expect(after.intact).toBe(false);
    expect(after.problems.map((p) => p.problem)).toContain('entry_hash_mismatch');
    expect(after.problems[0]?.sequence).toBe(sequence);
    log(
      `X-01: a privileged edit at sequence ${String(sequence)} produced ` +
        `${String(after.problems.length)} problem(s): ` +
        after.problems.map((p) => p.problem).join(', '),
    );

    /* ── restore, and prove the restoration is real ─────────────────────────── */
    // Removing the key restores the payload, which restores the hash — because
    // the hash is a function of the payload. The chain verifying again is itself
    // a small proof that the recomputation is genuine rather than cached.
    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    try {
      await admin.query(
        `update audit_events set payload = payload - 'tampered'
          where organization_id = $1::uuid and sequence = $2::bigint`,
        [ALPHA.organizationId, sequence],
      );
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');
    }
    const restored = await runtime.runner.run(
      organizationContext(ALPHA.organizationId, 'x01-restored'),
      (uow) => verifyAuditChain(uow),
    );
    expect(restored.intact, JSON.stringify(restored.problems)).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('SPEC-11 §10 X-03 — a deleted row leaves a gap that is recorded explicitly', () => {
  it('the gap is a first-class finding, and restoring the row closes it', async () => {
    const doomed = (await appendAlpha(3, 'x03-gap')).map((r) => r.sequence);
    const middle = doomed[1];
    expect(middle).toBeDefined();

    // The row is captured and restored ENTIRELY IN SQL, via a temporary table on
    // this session. A round trip through JavaScript loses precision:
    // `occurred_at` is microsecond-precision `timestamptz` and arrives as a
    // millisecond-precision `Date`, so the restored row differed from the
    // original in the one field nobody looks at — and the recomputed hash caught
    // it. Measured, not anticipated.
    await admin.query(
      `create temp table x03_saved as
         select * from audit_events where organization_id = $1::uuid and sequence = $2::bigint`,
      [ALPHA.organizationId, middle],
    );
    const captured = await admin.query<{ n: string }>('select count(*)::text as n from x03_saved');
    expect(Number(captured.rows[0]?.n), 'the row to be deleted must exist').toBe(1);

    await admin.query('alter table audit_events disable trigger audit_events_refuse_delete');
    try {
      await admin.query(
        'delete from audit_events where organization_id = $1::uuid and sequence = $2::bigint',
        [ALPHA.organizationId, middle],
      );
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_delete');
    }

    const after = await runtime.runner.run(
      organizationContext(ALPHA.organizationId, 'x03-after'),
      (uow) => verifyAuditChain(uow),
    );
    expect(after.intact).toBe(false);
    const kinds = after.problems.map((p) => p.problem);
    expect(kinds).toContain('sequence_gap');
    // SPEC-11 X-03: "continuity proven, OR THE GAP IS EXPLICITLY RECORDED". The
    // gap is a finding with its own sequence, not an inference from a hash that
    // happens not to match.
    const gap = after.problems.find((p) => p.problem === 'sequence_gap');
    expect(gap?.sequence).toBe(String(Number(middle) + 1));
    log(
      `X-03: deleting sequence ${String(middle)} is recorded as an explicit sequence_gap at ` +
        `${String(gap?.sequence)} (plus ${String(kinds.length - 1)} hash problem(s))`,
    );

    /* ── restore verbatim ───────────────────────────────────────────────────── */
    // The chain-assignment trigger must be disabled for the restore: it is a
    // BEFORE INSERT trigger and would otherwise allocate a NEW sequence and a new
    // hash, appending the row rather than putting it back.
    await admin.query('alter table audit_events disable trigger audit_events_assign_chain');
    try {
      await admin.query('insert into audit_events select * from x03_saved');
    } finally {
      await admin.query('alter table audit_events enable trigger audit_events_assign_chain');
      await admin.query('drop table x03_saved');
    }

    const restored = await runtime.runner.run(
      organizationContext(ALPHA.organizationId, 'x03-restored'),
      (uow) => verifyAuditChain(uow),
    );
    expect(
      restored.intact,
      `restoring the row must close the gap: ${JSON.stringify(restored.problems)}`,
    ).toBe(true);
    log('X-03: the row restored verbatim closes the gap — the chain verifies again');
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('SPEC-11 §10 X-02 — a consistently rewritten segment is caught by the SIGNATURE', () => {
  it('the chain verifies against itself after a competent rewrite, and the checkpoint does not', async () => {
    const signer = new LocalCheckpointSigner({ keyId: 'x02-test-key' });
    const orgContext = organizationContext(BETA.organizationId, 'x02-checkpoint');

    await appendBeta(2, 'x02-seed');

    const checkpoint = await worker.runner.run(orgContext, (uow) => writeCheckpoint(uow, signer));
    expect(checkpoint, 'a checkpoint must have been written').not.toBeNull();

    const beforeRewrite = await worker.runner.run(orgContext, (uow) =>
      verifyCheckpoints(uow, (m, s) => signer.verify(m, s)),
    );
    expect(beforeRewrite.at(-1)?.signatureValid).toBe(true);
    expect(beforeRewrite.at(-1)?.matchesChain).toBe(true);

    /* ── R-04 first: the rewrite is now REFUSED outright ────────────────────── */
    //
    // `audit_checkpoints` references `(organization_id, sequence, entry_hash)`
    // compositely, so recomputing a checkpointed row's hash breaks a foreign
    // key. That is PREVENTION where SPEC-11 §2 only promised detection, and it
    // arrived as a side effect of fixing R-04 — worth asserting, because a
    // reader who only saw the detection test below would not know it was there.
    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    try {
      await expect(
        admin.query(
          `update audit_events set entry_hash = sha256('rewritten'::bytea)
            where organization_id = $1::uuid and sequence = $2::bigint`,
          [BETA.organizationId, checkpoint?.sequence],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');
    }
    log(
      'X-02/R-04: rewriting a CHECKPOINTED row is refused by the composite foreign key (23503) ' +
        '— prevention, not merely detection',
    );

    /* ── the competent rewrite, by an actor privileged enough to drop it ────── */
    //
    // Which is the threat SPEC-11 §3 actually models. Everything below is done
    // as the superuser with the trigger disabled and the constraint dropped:
    // if prevention could not be defeated there would be nothing left for
    // detection to do, and the point of X-02 is what happens when it is.
    await admin.query(
      'create temp table x02_saved as select * from audit_events where organization_id = $1::uuid',
      [BETA.organizationId],
    );
    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    await admin.query(
      'alter table audit_checkpoints drop constraint audit_checkpoints_entry_fk',
    );
    try {
      const changed = await admin.query(
        `update audit_events set payload = payload || '{"rewritten": true}'::jsonb
          where organization_id = $1::uuid and sequence = 1`,
        [BETA.organizationId],
      );
      expect(changed.rowCount, 'the tampering UPDATE must have hit exactly one row').toBe(1);

      // Walk forward recomputing, exactly as the writer would have.
      await admin.query(
        `do $x02$
         declare r record; v_prev bytea;
         begin
           v_prev := sha256(convert_to('sp.audit.genesis.v1:' || '${BETA.organizationId}', 'UTF8'));
           for r in select * from audit_events
                     where organization_id = '${BETA.organizationId}'::uuid order by sequence loop
             update audit_events
                set prev_hash = v_prev,
                    entry_hash = sha256(app_audit_canonical_bytes(
                        r.organization_id, v_prev, r.sequence, r.id, r.occurred_at, r.event_name,
                        r.actor_kind, r.actor_membership_id, r.group_id, r.subject_type,
                        r.subject_id, r.correlation_id, r.payload))
              where organization_id = r.organization_id and sequence = r.sequence
              returning entry_hash into v_prev;
           end loop;
         end $x02$;`,
      );
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');
    }

    const headAfter = await admin.query<{ h: string }>(
      `select encode(entry_hash, 'hex') as h from audit_events
        where organization_id = $1::uuid order by sequence desc limit 1`,
      [BETA.organizationId],
    );
    expect(
      headAfter.rows[0]?.h,
      'the rewrite must have moved the head hash, or the experiment proves nothing',
    ).not.toBe(checkpoint?.entryHash);

    /* ── the chain now verifies. That is the whole point of X-02. ───────────── */
    const chain = await worker.runner.run(orgContext, (uow) => verifyAuditChain(uow));
    expect(
      chain.intact,
      'a rewriter who recomputes every hash produces a SELF-CONSISTENT chain — this is ' +
        `expected, and it is why checkpoints exist: ${JSON.stringify(chain.problems)}`,
    ).toBe(true);

    /* ── the signature does not. ────────────────────────────────────────────── */
    const afterRewrite = await worker.runner.run(orgContext, (uow) =>
      verifyCheckpoints(uow, (m, s) => signer.verify(m, s)),
    );
    const latest = afterRewrite.at(-1);
    expect(latest?.signatureValid, 'the signature itself is still authentic').toBe(true);
    expect(latest?.matchesChain, 'but the chain no longer says what it was signed over').toBe(
      false,
    );
    log(
      `X-02: after a consistent rewrite the chain verifies (intact=${String(chain.intact)}) ` +
        `and the checkpoint at sequence ${String(latest?.sequence)} reports ` +
        `signatureValid=${String(latest?.signatureValid)} ` +
        `matchesChain=${String(latest?.matchesChain)}`,
    );

    /* ── a third, independent signal: the constraint will not go back on ───── */
    await expect(
      admin.query(
        `alter table audit_checkpoints add constraint audit_checkpoints_entry_fk
           foreign key (organization_id, sequence, entry_hash)
           references audit_events (organization_id, sequence, entry_hash)`,
      ),
      'the rewritten chain no longer contains the hash the checkpoint was signed over',
    ).rejects.toMatchObject({ code: '23503' });
    log('X-02: the dropped foreign key cannot be re-added — the chain and the checkpoint disagree');

    /* ── restore the organization, and the constraint with it ──────────────── */
    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    await admin.query('alter table audit_events disable trigger audit_events_refuse_delete');
    await admin.query('alter table audit_events disable trigger audit_events_assign_chain');
    try {
      await admin.query('delete from audit_events where organization_id = $1::uuid', [
        BETA.organizationId,
      ]);
      await admin.query('insert into audit_events select * from x02_saved');
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_delete');
      await admin.query('alter table audit_events enable trigger audit_events_assign_chain');
      await admin.query('drop table x02_saved');
    }
    await admin.query(
      `alter table audit_checkpoints add constraint audit_checkpoints_entry_fk
         foreign key (organization_id, sequence, entry_hash)
         references audit_events (organization_id, sequence, entry_hash)`,
    );
    const afterRestore = await worker.runner.run(orgContext, (uow) =>
      verifyCheckpoints(uow, (m, s) => signer.verify(m, s)),
    );
    expect(
      afterRestore.at(-1)?.matchesChain,
      'restoring the rows restores the agreement, and the constraint goes back on',
    ).toBe(true);
  });

  it('the local signer is HONEST about not being an assurance control', () => {
    // SPEC-11 §6 requires a key the application cannot read. This one is in the
    // process. The flag exists so a deployment check can refuse to start.
    expect(new LocalCheckpointSigner().keyIsIsolated).toBe(false);
    log('LocalCheckpointSigner.keyIsIsolated === false (real KMS is a deployment condition)');
  });

  it('a checkpoint does not verify under a DIFFERENT key of the same id', async () => {
    // Same `keyId`, different key material — the case a key-id check alone would
    // wave through, and the reason `verify` checks the signature and not the id.
    const impostor = new LocalCheckpointSigner({ keyId: 'x02-test-key' });
    const results = await worker.runner.run(
      organizationContext(BETA.organizationId, 'x02-wrong-key'),
      (uow) => verifyCheckpoints(uow, (m, s) => impostor.verify(m, s)),
    );
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((r) => !r.signatureValid),
      'a different key must not validate an existing signature',
    ).toBe(true);
    log('a checkpoint does not verify under different key material, even with the same key id');
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('non-bypass rule 6 — append-only, per role', () => {
  for (const role of ['app_runtime', 'app_worker'] as const) {
    it(`${role} holds NO update, delete, truncate or references grant`, async () => {
      const { rows } = await admin.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.table_privileges
          where table_name = 'audit_events' and grantee = $1 order by privilege_type`,
        [role],
      );
      const held = rows.map((r) => r.privilege_type);
      expect(held).not.toContain('UPDATE');
      expect(held).not.toContain('DELETE');
      expect(held).not.toContain('TRUNCATE');
      expect(held).not.toContain('REFERENCES');
      expect(held).toContain('SELECT');

      // A COLUMN-level grant does not appear in `table_privileges` at all — it is
      // in `column_privileges`, and reading the wrong catalogue is how a reviewer
      // concludes a role holds nothing when it holds exactly enough.
      const columns = await admin.query<{ column_name: string }>(
        `select column_name from information_schema.column_privileges
          where table_name = 'audit_events' and grantee = $1 and privilege_type = 'INSERT'
          order by column_name`,
        [role],
      );
      const insertable = columns.rows.map((r) => r.column_name);
      expect(insertable).toContain('event_name');
      for (const chainColumn of ['sequence', 'prev_hash', 'entry_hash', 'occurred_at']) {
        expect(insertable, `${role} must not be able to name ${chainColumn}`).not.toContain(
          chainColumn,
        );
      }
      log(
        `${role} on audit_events: table=[${held.join(', ')}] ` +
          `insertable columns=[${insertable.join(', ')}]`,
      );
    });
  }

  it('the OWNER updates ZERO rows — there is no UPDATE policy at all', async () => {
    // `app_migrator` owns `audit_events` and FORCE RLS binds it like anyone else.
    // The table has SELECT and INSERT policies and **no UPDATE policy**, and
    // under RLS a command with no permissive policy matches no rows — so the
    // owner's UPDATE is not refused, it is VACUOUS. That distinction matters: a
    // reviewer expecting an exception and finding none could reasonably conclude
    // the write succeeded, so the assertion is on the row count, and the table is
    // re-read afterwards to prove nothing moved.
    const migrator = createRuntime('app_migrator');
    try {
      const affected = await migrator.runner.run(
        organizationContext(ALPHA.organizationId, 'append-only-owner'),
        async ({ query }) => {
          const r = await sql`
            update audit_events set correlation_id = 'owner-tampered'
             where organization_id = ${ALPHA.organizationId}::uuid
          `.execute(query);
          return Number(r.numAffectedRows ?? 0n);
        },
      );
      expect(affected, 'no UPDATE policy exists, so no row is visible to update').toBe(0);
    } finally {
      await migrator.destroy();
    }

    const tampered = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events where correlation_id = 'owner-tampered'`,
    );
    expect(Number(tampered.rows[0]?.n)).toBe(0);
    log('app_migrator (the table owner) UPDATE affects 0 rows: no UPDATE policy exists');
  });

  it('the SUPERUSER is refused too, and so is replica mode', async () => {
    await expect(
      admin.query('update audit_events set correlation_id = $1 where sequence = 1', ['x']),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(admin.query('delete from audit_events where sequence = 1')).rejects.toMatchObject({
      code: '23001',
    });

    // `truncate audit_events` alone is refused earlier, by the foreign keys
    // `audit_checkpoints` and `outbox_events` hold on it (`0A000`) — a real
    // refusal, but not the one under test. CASCADE gets past the foreign keys and
    // reaches the statement trigger, which is.
    await expect(admin.query('truncate audit_events')).rejects.toMatchObject({ code: '0A000' });
    await expect(admin.query('truncate audit_events cascade')).rejects.toMatchObject({
      code: '23001',
    });

    // `session_replication_role = replica` disables ordinary triggers, and it is
    // the first thing an actor rewriting history would reach for. The refusal
    // triggers are ENABLE ALWAYS precisely so that it does not help.
    await admin.query(`set session_replication_role = 'replica'`);
    try {
      await expect(
        admin.query('delete from audit_events where sequence = 1'),
      ).rejects.toMatchObject({ code: '23001' });
    } finally {
      await admin.query(`set session_replication_role = 'origin'`);
    }
    log(
      'superuser UPDATE / DELETE / TRUNCATE CASCADE all refused (23001), including under ' +
        "session_replication_role = 'replica'",
    );
  });

  it('audit_checkpoints is append-only on the same terms', async () => {
    // A row must exist first: a row trigger on an UPDATE that matches nothing
    // never fires, and an assertion that passes because there was nothing to
    // update is not an assertion.
    await worker.runner.run(
      organizationContext(ALPHA.organizationId, 'checkpoint-append-only'),
      (uow) => writeCheckpoint(uow, new LocalCheckpointSigner({ keyId: 'append-only-test-key' })),
    );
    const present = await admin.query<{ n: string }>(
      'select count(*)::text as n from audit_checkpoints',
    );
    expect(Number(present.rows[0]?.n)).toBeGreaterThan(0);

    await expect(
      admin.query('update audit_checkpoints set key_id = $1', ['x']),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(admin.query('delete from audit_checkpoints')).rejects.toMatchObject({
      code: '23001',
    });
    await expect(admin.query('truncate audit_checkpoints')).rejects.toMatchObject({
      code: '23001',
    });
    log('audit_checkpoints: superuser UPDATE / DELETE / TRUNCATE all refused (23001)');
  });

  it('an outbox row cannot be re-pointed at a different audit event, or deleted', async () => {
    const existing = await admin.query<{ id: string }>(
      'select id::text as id from outbox_events limit 1',
    );
    if (existing.rows[0] === undefined) {
      // File ordering can put this before anything publishes. Rather than
      // fabricate a row here, the assertion is skipped and the same property is
      // covered by `outbox-dispatch.test.ts`. Saying so out loud, because a
      // silently-skipped assertion is worse than an absent one.
      log('SKIPPED: no outbox rows in this ordering — covered by outbox-dispatch.test.ts');
      return;
    }
    await expect(
      admin.query(
        'update outbox_events set audit_sequence = audit_sequence + 1 where id = $1::uuid',
        [existing.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      admin.query('delete from outbox_events where id = $1::uuid', [existing.rows[0].id]),
    ).rejects.toMatchObject({ code: '23001' });
    log('outbox rows: the audit link is immutable and the row is not deletable');
  });

  it('NO role holds any grant at all on audit_chain_heads', async () => {
    const { rows } = await admin.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.table_privileges
        where table_name = 'audit_chain_heads' and grantee <> 'app_migrator'`,
    );
    expect(rows, JSON.stringify(rows)).toEqual([]);
    log('audit_chain_heads: no grant to any role but its owner');
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('tenant isolation of the audit tables', () => {
  it("a group-scoped context reads only its own group's audit rows", async () => {
    // Counted by a MARKER this test writes, not by "group two should be empty".
    // Group two is not empty in a full battery — `context-surface.test.ts`
    // exercises it — and an absolute count here passed alone and failed in the
    // battery, which is the classic order-dependent test. What is being asserted
    // is the partition, so the assertion counts a partition.
    const marker = 'isolation-marker-run';
    const written = await appendEvents(
      ALPHA.organizationId,
      ALPHA.groupOne.id,
      ALPHA.users.scheduler.membershipId,
      1,
      marker,
    );
    expect(written[0]?.sequence).toMatch(/^\d+$/);

    expect(
      await countVisible(
        groupContext(ALPHA.organizationId, ALPHA.groupOne.id, null, 'isolation-probe'),
        marker,
      ),
      'visible in its own group',
    ).toBe(1);
    expect(
      await countVisible(
        groupContext(ALPHA.organizationId, ALPHA.groupTwo.id, null, 'isolation-probe'),
        marker,
      ),
      'invisible from the sibling group',
    ).toBe(0);
    expect(
      await countVisible(organizationContext(ALPHA.organizationId, 'isolation-probe-org'), marker),
      'visible organization-wide — the EX-2 shape: confined, not hidden',
    ).toBe(1);
    expect(
      await countVisible(organizationContext(BETA.organizationId, 'isolation-probe-beta'), marker),
      'invisible from the other organization',
    ).toBe(0);
    log('group scoping: 1 in its own group, 0 from the sibling, 1 org-wide, 0 cross-tenant');
  });

  it('a group-scoped writer CANNOT file an audit row against a sibling group', async () => {
    await expect(
      runtime.runner.run(
        groupContext(
          ALPHA.organizationId,
          ALPHA.groupOne.id,
          ALPHA.users.scheduler.membershipId,
          'isolation-cross-group',
        ),
        async ({ query }) => {
          await sql`
            insert into audit_events (organization_id, id, event_name, actor_kind, group_id,
                                      subject_type, subject_id, correlation_id)
            values (${ALPHA.organizationId}::uuid, ${randomUUID()}::uuid,
                    'membership.activity_touched', 'system', ${ALPHA.groupTwo.id}::uuid,
                    'membership', ${randomUUID()}::uuid, 'cross')
          `.execute(query);
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });
    log('a group-scoped context cannot write an audit row attributed to a sibling group');
  });

  it('outside a unit of work, every audit table is empty and unwritable', async () => {
    const client = await runtime.pool.connect();
    try {
      for (const table of ['audit_events', 'audit_checkpoints', 'outbox_events']) {
        const r = await client.query<{ n: string }>(`select count(*)::text as n from ${table}`);
        expect(Number(r.rows[0]?.n), `${table} outside a unit of work`).toBe(0);
      }
      await expect(
        client.query(
          `insert into audit_events (organization_id, id, event_name, actor_kind, subject_type,
                                     subject_id, correlation_id)
           values ($1::uuid, gen_random_uuid(), 'membership.activity_touched', 'system',
                   'membership', gen_random_uuid(), 'outside')`,
          [ALPHA.organizationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
    log('outside a unit of work: 0 rows visible on all three tables, INSERT refused (42501)');
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('second-review findings — the holes the first submission left', () => {
  it('R-01: a TAIL TRUNCATION above the last checkpoint is detected', async () => {
    // The reviewer's exact scenario. Checkpoint the head, append more, delete
    // everything above the checkpoint. Walking the rows that remain finds
    // nothing wrong — each is internally consistent and links correctly — and
    // every checkpoint still verifies AND matches, because the checkpointed row
    // was never touched. The first submission reported `intact = true` here.
    const signer = new LocalCheckpointSigner({ keyId: 'r01-test-key' });
    const orgContext = organizationContext(ALPHA.organizationId, 'r01-truncation');

    await appendAlpha(2, 'r01-before-checkpoint');
    const checkpoint = await worker.runner.run(orgContext, (uow) => writeCheckpoint(uow, signer));
    expect(checkpoint, 'a checkpoint over the current head').not.toBeNull();
    const checkpointSequence = Number(checkpoint?.sequence);

    const tail = (await appendAlpha(4, 'r01-tail')).map((r) => Number(r.sequence));
    expect(tail.at(-1)).toBe(checkpointSequence + 4);

    // Captured before deletion so the chain can be put back: a permanent gap
    // here would decide the result of every test after this one.
    await admin.query(
      `create temp table r01_saved as
         select * from audit_events
          where organization_id = $1::uuid and sequence > $2::bigint`,
      [ALPHA.organizationId, checkpointSequence],
    );
    await admin.query('alter table audit_events disable trigger audit_events_refuse_delete');
    try {
      const deleted = await admin.query(
        'delete from audit_events where organization_id = $1::uuid and sequence > $2::bigint',
        [ALPHA.organizationId, checkpointSequence],
      );
      expect(deleted.rowCount, 'the tail is really gone').toBe(4);
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_delete');
    }

    /* ── the checkpoint half still says everything is fine ─────────────────── */
    const checkpoints = await worker.runner.run(orgContext, (uow) =>
      verifyCheckpoints(uow, (m, s) => signer.verify(m, s)),
    );
    // Only THIS test's checkpoint. Earlier ones in the same organization were
    // signed with different key material, so `signatureValid` is legitimately
    // false for them under this signer — asserting over all of them would be
    // measuring key identity rather than truncation.
    const mine = checkpoints.find((c) => c.sequence === String(checkpointSequence));
    expect(mine, JSON.stringify(checkpoints)).toBeDefined();
    expect(
      mine?.signatureValid && mine.matchesChain,
      'the checkpointed row was not touched, so its signature still verifies AND still matches ' +
        '— which is exactly why the checkpoint half cannot see a truncation ABOVE it',
    ).toBe(true);

    /* ── and the head comparison catches it ────────────────────────────────── */
    const verification = await runtime.runner.run(
      organizationContext(ALPHA.organizationId, 'r01-verify'),
      (uow) => verifyAuditChain(uow),
    );
    expect(verification.intact, 'a truncated tail is NOT an intact chain').toBe(false);
    const problem = verification.problems.find((p) => p.problem === 'head_sequence_ahead_of_chain');
    expect(problem, JSON.stringify(verification.problems)).toBeDefined();
    expect(problem?.sequence, 'reported as the first MISSING sequence').toBe(
      String(checkpointSequence + 1),
    );
    log(
      `R-01: head says ${String(checkpointSequence + 4)}, chain stops at ` +
        `${String(checkpointSequence)} → head_sequence_ahead_of_chain at ` +
        `${String(problem?.sequence)}, while every checkpoint still verified and matched`,
    );

    /* ── restore ───────────────────────────────────────────────────────────── */
    await admin.query('alter table audit_events disable trigger audit_events_assign_chain');
    try {
      await admin.query('insert into audit_events select * from r01_saved');
    } finally {
      await admin.query('alter table audit_events enable trigger audit_events_assign_chain');
      await admin.query('drop table r01_saved');
    }
    const restored = await runtime.runner.run(
      organizationContext(ALPHA.organizationId, 'r01-restored'),
      (uow) => verifyAuditChain(uow),
    );
    expect(restored.intact, JSON.stringify(restored.problems)).toBe(true);
  });

  it('R-01: the head row that makes that check possible is monotonic and undeletable', async () => {
    // An actor truncating the tail deletes the head row next. If they could, the
    // check above would have no input left to compare against.
    await expect(
      admin.query('delete from audit_chain_heads where organization_id = $1::uuid', [
        ALPHA.organizationId,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      admin.query('update audit_chain_heads set sequence = 1 where organization_id = $1::uuid', [
        ALPHA.organizationId,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(admin.query('truncate audit_chain_heads cascade')).rejects.toMatchObject({
      code: '23001',
    });
    log('audit_chain_heads: DELETE, rewind and TRUNCATE all refused (23001)');
  });

  it('R-05: verification REFUSES an organization id that is not the session tenant', async () => {
    // `app_verify_audit_chain` is SECURITY DEFINER, so it can read any
    // organization's head row. Its `audit_events` reads are still RLS-confined
    // to the session tenant — so without the guard, asking about a FOREIGN
    // organization walks zero rows and answers "clean". To a support or
    // break-glass operator during an incident that is the worst possible lie.
    await expect(
      runtime.runner.run(
        organizationContext(ALPHA.organizationId, 'r05-confinement'),
        async ({ query }) => {
          await sql`select * from app_verify_audit_chain(${BETA.organizationId}::uuid)`.execute(
            query,
          );
        },
      ),
    ).rejects.toMatchObject({ code: '23001' });

    // And outside a unit of work there is no session tenant at all.
    const client = await runtime.pool.connect();
    try {
      await expect(
        client.query('select * from app_verify_audit_chain($1::uuid)', [ALPHA.organizationId]),
      ).rejects.toMatchObject({ code: '23001' });
    } finally {
      client.release();
    }
    log('R-05: a foreign organization id and a missing context both raise 23001, not "clean"');
  });

  it('R-04: a checkpoint CANNOT be signed over a hash the chain never had', async () => {
    // `app_worker` holds INSERT on `audit_checkpoints`, and the table is
    // append-only — so a checkpoint with a wrong `entry_hash` would be permanent
    // and would report `matchesChain = false` forever, poisoning the one signal
    // that catches a competent rewrite.
    const real = await admin.query<{ sequence: string }>(
      `select sequence::text as sequence from audit_events
        where organization_id = $1::uuid order by sequence desc limit 1`,
      [ALPHA.organizationId],
    );
    const sequence = real.rows[0]?.sequence;
    expect(sequence).toBeDefined();

    await expect(
      worker.runner.run(
        organizationContext(ALPHA.organizationId, 'r04-poison'),
        async ({ query }) => {
          await sql`
            insert into audit_checkpoints (organization_id, sequence, entry_hash, key_id,
                                           algorithm, signature)
            values (${ALPHA.organizationId}::uuid, ${sequence}::bigint,
                    sha256('not-the-real-hash'::bytea), 'poison', 'ed25519',
                    sha256('signature'::bytea))
          `.execute(query);
        },
      ),
      // 23503: the composite foreign key over (organization_id, sequence,
      // entry_hash) has no matching row in the chain.
    ).rejects.toMatchObject({ code: '23503' });
    log('R-04: a checkpoint naming a hash the chain never had is refused (23503)');
  });

  it('R-06: a GROUP-scoped context reads zero checkpoints', async () => {
    // The read policy's comment said "organization-scoped only" while its
    // predicate let a group-scoped context read every checkpoint in the
    // organization. Of the two readings the stricter one was the stated intent.
    await worker.runner.run(
      organizationContext(ALPHA.organizationId, 'r06-seed-checkpoint'),
      (uow) => writeCheckpoint(uow, new LocalCheckpointSigner({ keyId: 'r06-test-key' })),
    );

    const countCheckpoints = async (
      context: Parameters<Runtime['runner']['run']>[0],
    ): Promise<number> =>
      runtime.runner.run(context, async ({ query }) => {
        const r = await sql<{ n: string }>`
          select count(*)::text as n from audit_checkpoints
        `.execute(query);
        return Number(r.rows[0]?.n ?? '-1');
      });

    const orgWide = await countCheckpoints(
      organizationContext(ALPHA.organizationId, 'r06-org'),
    );
    expect(orgWide).toBeGreaterThan(0);
    const groupScoped = await countCheckpoints(
      groupContext(ALPHA.organizationId, ALPHA.groupOne.id, null, 'r06-group'),
    );
    expect(groupScoped).toBe(0);
    log(`R-06: organization-scoped sees ${String(orgWide)} checkpoint(s), group-scoped sees 0`);
  });

  it('the cross-tenant maintenance read is reachable by NO application role', async () => {
    // `audit_chain_heads_maintenance_read` and its checkpoint twin are the only
    // cross-tenant reads in the system. They are `TO app_migrator`, and the
    // enumeration function that uses them is granted to `app_worker` alone.
    const policies = await admin.query<{ tablename: string; roles: string; cmd: string }>(
      `select tablename, roles::text as roles, cmd from pg_policies
        where policyname like '%maintenance_read' order by tablename`,
    );
    expect(policies.rows).toHaveLength(2);
    for (const row of policies.rows) {
      expect(row.roles, `${row.tablename} maintenance read must name app_migrator only`).toBe(
        '{app_migrator}',
      );
      // The role list alone is not the whole grant: a `FOR ALL` policy with the
      // same name and the same role would sail through a roles-only assertion
      // while silently permitting cross-tenant INSERT, UPDATE and DELETE. The
      // command is half of what makes this read-only.
      expect(row.cmd, `${row.tablename} maintenance read must be SELECT only`).toBe('SELECT');
    }

    const grantees = await admin.query<{ grantee: string }>(
      `select grantee from information_schema.role_routine_grants
        where routine_name = 'app_audit_organizations_due' and grantee <> 'app_migrator'
        order by grantee`,
    );
    expect(grantees.rows.map((r) => r.grantee)).toEqual(['app_worker']);

    // Neither SECURITY DEFINER function may carry PostgreSQL's inherited
    // PUBLIC:EXECUTE. A function that runs as the schema owner should be
    // reachable only by roles somebody granted it to.
    const publicExecute = await admin.query<{ routine_name: string }>(
      `select routine_name from information_schema.role_routine_grants
        where grantee = 'PUBLIC'
          and routine_name in ('app_verify_audit_chain', 'app_audit_organizations_due')`,
    );
    expect(publicExecute.rows, JSON.stringify(publicExecute.rows)).toEqual([]);

    // And the request path cannot call it at all.
    await expect(
      runtime.runner.run(
        organizationContext(ALPHA.organizationId, 'maintenance-probe'),
        async ({ query }) => {
          await sql`
            select * from app_audit_organizations_due(0::bigint, '0 seconds'::interval)
          `.execute(query);
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });
    log(
      'both maintenance-read policies are FOR SELECT TO app_migrator only; the enumeration ' +
        'function is granted to app_worker only; app_runtime cannot call it (42501)',
    );
  });
});
