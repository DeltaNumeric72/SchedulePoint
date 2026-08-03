import type { CheckpointSigner, UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { GroupScopedChainVerificationError } from './verification.js';

/**
 * Writing a signed checkpoint — SPEC-11 §2.
 *
 * A checkpoint is a signed statement of the form *"at sequence N this
 * organization's chain ended with hash H"*. Its whole value is that a later
 * rewrite of the chain up to N cannot reproduce it without the signing key, so
 * a consistently rewritten segment — the one thing the chain itself cannot see
 * — becomes visible as a signature that no longer matches.
 *
 * ## Three properties, each with a reason
 *
 * 1. **The head is read and the checkpoint written in ONE transaction.** With
 *    two, a row appended between them would leave a checkpoint claiming a head
 *    that was never the head, and every later verification would report a
 *    mismatch that is a bookkeeping error rather than tampering — the fastest
 *    way to make an integrity alert something operators mute.
 * 2. **The signed bytes come from the DATABASE**, via
 *    `app_audit_checkpoint_bytes`, not from string concatenation here. The
 *    verifier calls the same function, so signer and verifier cannot disagree
 *    about what was signed.
 * 3. **Organization-scoped context required**, for the same reason verification
 *    requires it: a group-scoped read sees a subset of the chain, and would
 *    happily checkpoint a head that is not the head.
 *
 * ## Checkpointing is a WORKER action
 *
 * Migration 0003 grants `INSERT` on `audit_checkpoints` to `app_worker` alone. A
 * request path that could sign a checkpoint could checkpoint a chain it had
 * just corrupted, in the same breath, and the signature would say it was fine.
 */

export interface WrittenCheckpoint {
  readonly organizationId: string;
  readonly sequence: string;
  readonly entryHash: string;
  readonly keyId: string;
  readonly signedAt: string;
}

interface HeadRow {
  sequence: string;
  entry_hash: string;
  message: string;
  already_checkpointed: boolean;
}

interface WrittenRow {
  signed_at: Date;
}

/**
 * Signs a checkpoint over the organization's current chain head.
 *
 * @returns the checkpoint, or `null` when there is nothing to checkpoint —
 *          an organization with no audit events, or one whose head is already
 *          checkpointed. Returning `null` rather than throwing because "nothing
 *          changed since last time" is the ordinary case for a periodic job, and
 *          a job that logs an error every quiet hour is a job whose errors stop
 *          being read.
 */
export async function writeCheckpoint(
  uow: UnitOfWork<Kysely<Database>>,
  signer: CheckpointSigner,
): Promise<WrittenCheckpoint | null> {
  const { organizationId, groupId } = uow.context;
  if (groupId !== null) throw new GroupScopedChainVerificationError(groupId);

  const head = await sql<HeadRow>`
    select e.sequence::text                as sequence,
           encode(e.entry_hash, 'hex')     as entry_hash,
           encode(app_audit_checkpoint_bytes(e.organization_id, e.sequence, e.entry_hash), 'hex')
                                           as message,
           exists (
             select 1 from audit_checkpoints c
              where c.organization_id = e.organization_id
                and c.sequence        = e.sequence
           )                               as already_checkpointed
      from audit_events e
     where e.organization_id = ${organizationId}::uuid
     order by e.sequence desc
     limit 1
  `.execute(uow.query);

  const row = head.rows[0];
  if (row === undefined || row.already_checkpointed) return null;

  // R-09, recorded rather than hidden: this `await` holds the transaction open
  // across the signing call. Harmless for the in-process stub; **the wrong shape
  // for a real KMS**, where a slow or unavailable signer would hold a database
  // transaction for the duration of a network round trip. The fix is to sign
  // first and write in a second transaction, re-checking the head — which is a
  // change worth making WITH the KMS adapter rather than speculatively before
  // it. Named alongside the KMS condition in EV-M1-AUDIT §5.
  const signature = await signer.sign(Buffer.from(row.message, 'hex'));

  // Two checkpointers can reach the same head at the same time; the primary key
  // decides, and losing that race is not a fault. `23505` is treated as "already
  // checkpointed at this sequence", which is the same outcome the
  // `already_checkpointed` short-circuit above produces a moment earlier.
  let written;
  try {
    written = await sql<WrittenRow>`
      insert into audit_checkpoints (
        organization_id, sequence, entry_hash, key_id, algorithm, signature
      ) values (
        ${organizationId}::uuid,
        ${row.sequence}::bigint,
        decode(${row.entry_hash}, 'hex'),
        ${signature.keyId},
        ${signature.algorithm},
        decode(${signature.signature}, 'hex')
      )
      returning signed_at
    `.execute(uow.query);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }

  const signedAt = written.rows[0]?.signed_at;
  if (signedAt === undefined) {
    throw new Error('AUDIT_CHECKPOINT_PRODUCED_NO_ROW: the checkpoint insert returned nothing.');
  }

  return {
    organizationId,
    sequence: row.sequence,
    entryHash: row.entry_hash,
    keyId: signature.keyId,
    signedAt: signedAt.toISOString(),
  };
}
