import type { UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * Chain verification — SPEC-11 §2's "verification job", and the X-01/X-02/X-03
 * detector.
 *
 * ## What verification can and cannot tell you
 *
 * | Tampering | Detected by | Why |
 * |---|---|---|
 * | a row's content altered | `entry_hash_mismatch` | the recomputed hash no longer matches the stored one |
 * | a row deleted | `sequence_gap` | the sequence is gapless by construction |
 * | a row inserted mid-chain | `prev_hash_mismatch` | it cannot know the hash it should have followed |
 * | **rows deleted from the TAIL** | **`head_sequence_ahead_of_chain`** | the walk sees nothing wrong — every remaining row is consistent — so the registered head is compared against the last row that exists (R-01) |
 * | the head row itself deleted | `chain_head_missing` | the input to that comparison going missing is the finding |
 * | **a whole segment rewritten consistently** | **NOT by the chain** — by the **checkpoint signature** | a rewriter who recomputes every hash produces a self-consistent chain. That is exactly why SPEC-11 §2 has checkpoints, and why `verifyAgainstCheckpoints` exists below |
 *
 * The division of labour is deliberate and is worth stating plainly: **the chain
 * detects local damage; the signature detects a competent rewrite.** Neither
 * prevents anything. SPEC-11 §1 calls this assurance level A1, and A2 —
 * replication into a separate trust domain — is not in this milestone.
 *
 * ## It requires an ORGANIZATION-scoped unit of work
 *
 * `audit_events` is read-scoped by group under a group context (migration 0003),
 * so verifying from inside a group context would walk a subset of the chain and
 * report a break at the first row belonging to another group — a false alarm
 * that would train an operator to ignore the real one. `verifyAuditChain`
 * refuses a group-scoped context rather than returning a wrong answer.
 */

export type ChainProblemKind =
  | 'sequence_gap'
  | 'prev_hash_mismatch'
  | 'entry_hash_mismatch'
  /**
   * The registered chain head is ahead of the last row that exists — rows are
   * missing **from the tail**.
   *
   * Walking the rows that exist can never notice rows that no longer do at the
   * end, and the second review measured exactly that: checkpoint at 10, append
   * to 15, delete 11–15 → intact, every checkpoint valid and matching. This is
   * the finding that closes it (R-01). `sequence` is the first missing one.
   */
  | 'head_sequence_ahead_of_chain'
  /**
   * Rows exist and the head row does not.
   *
   * An actor truncating the tail would delete the head row next, so the absence
   * of the comparison's input is itself the finding rather than a reason to stay
   * quiet. (`audit_chain_heads_guard` makes the deletion itself refuse; this is
   * what reports it if the guard is ever defeated.)
   */
  | 'chain_head_missing';

export interface ChainProblem {
  readonly sequence: string;
  readonly problem: ChainProblemKind;
  /** Hex, or `null` for a gap (there is no hash to compare). */
  readonly expected: string | null;
  readonly actual: string | null;
}

export interface ChainVerification {
  readonly organizationId: string;
  readonly entries: number;
  readonly headSequence: string | null;
  readonly headEntryHash: string | null;
  readonly problems: readonly ChainProblem[];
  readonly intact: boolean;
}

export class GroupScopedChainVerificationError extends Error {
  readonly code = 'CHAIN_VERIFICATION_REQUIRES_ORGANIZATION_SCOPE';

  constructor(groupId: string) {
    super(
      'CHAIN_VERIFICATION_REQUIRES_ORGANIZATION_SCOPE: the audit chain is per organization, but ' +
        `this unit of work declares group ${groupId}. A group-scoped read sees a subset of the ` +
        'chain and would report a break that is not there.',
    );
    this.name = 'GroupScopedChainVerificationError';
  }
}

interface ProblemRow {
  sequence: string;
  problem: ChainProblemKind;
  expected: string | null;
  actual: string | null;
}

interface HeadRow {
  entries: string;
  head_sequence: string | null;
  head_entry_hash: string | null;
}

/**
 * Walks the whole chain for the unit of work's organization.
 *
 * The recomputation happens **in the database**, in `app_verify_audit_chain`,
 * not here. That is not an optimisation: the writer's hash is computed by
 * `app_audit_canonical_bytes` in the same migration, and a verifier that
 * recomputed the bytes in TypeScript would be testing whether two
 * implementations agree rather than whether the chain is intact. One canonical
 * encoding, used by both sides, is the only version of this that means anything.
 */
export async function verifyAuditChain(
  uow: UnitOfWork<Kysely<Database>>,
): Promise<ChainVerification> {
  const { organizationId, groupId } = uow.context;
  if (groupId !== null) throw new GroupScopedChainVerificationError(groupId);

  const problems = await sql<ProblemRow>`
    select sequence::text                as sequence,
           problem                       as problem,
           encode(expected, 'hex')       as expected,
           encode(actual,   'hex')       as actual
      from app_verify_audit_chain(${organizationId}::uuid)
     order by sequence, problem
  `.execute(uow.query);

  const head = await sql<HeadRow>`
    select count(*)::text                                    as entries,
           max(sequence)::text                               as head_sequence,
           encode((array_agg(entry_hash ORDER BY sequence DESC))[1], 'hex') as head_entry_hash
      from audit_events
     where organization_id = ${organizationId}::uuid
  `.execute(uow.query);

  const summary = head.rows[0];
  return {
    organizationId,
    entries: Number(summary?.entries ?? '0'),
    headSequence: summary?.head_sequence ?? null,
    headEntryHash: summary?.head_entry_hash ?? null,
    problems: problems.rows,
    intact: problems.rows.length === 0,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Checkpoint verification — the half the chain cannot do
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CheckpointVerification {
  readonly sequence: string;
  /** The hash the checkpoint was signed over. */
  readonly signedEntryHash: string;
  /** The hash the chain currently holds at that sequence, or `null` if it is gone. */
  readonly currentEntryHash: string | null;
  readonly signatureValid: boolean;
  readonly matchesChain: boolean;
}

interface CheckpointRow {
  sequence: string;
  signed_entry_hash: string;
  current_entry_hash: string | null;
  key_id: string;
  algorithm: string;
  signature: string;
  message: string;
}

/**
 * Every checkpoint, with the two questions that matter answered separately.
 *
 * `signatureValid` asks "was this checkpoint produced by the signing key?".
 * `matchesChain` asks "does the chain still say what the checkpoint says it
 * said?". **X-02 is the case where the first is true and the second is false**:
 * an actor who rewrote a segment consistently produces a chain that verifies
 * against itself and disagrees with a signature they could not forge.
 *
 * Keeping them separate matters operationally too. A failed signature with a
 * matching chain means the key or the checkpoint row is the problem; a valid
 * signature with a mismatched chain means the history is. Collapsing them into
 * one boolean would lose exactly the distinction an incident responder needs.
 */
export async function verifyCheckpoints(
  uow: UnitOfWork<Kysely<Database>>,
  verifySignature: (
    message: Uint8Array,
    signature: { keyId: string; algorithm: 'ed25519'; signature: string },
  ) => Promise<boolean>,
): Promise<readonly CheckpointVerification[]> {
  const { organizationId, groupId } = uow.context;
  if (groupId !== null) throw new GroupScopedChainVerificationError(groupId);

  const rows = await sql<CheckpointRow>`
    select c.sequence::text                    as sequence,
           encode(c.entry_hash, 'hex')         as signed_entry_hash,
           encode(e.entry_hash, 'hex')         as current_entry_hash,
           c.key_id                            as key_id,
           c.algorithm                         as algorithm,
           encode(c.signature, 'hex')          as signature,
           encode(app_audit_checkpoint_bytes(c.organization_id, c.sequence, c.entry_hash), 'hex')
                                               as message
      from audit_checkpoints c
      left join audit_events e
        on e.organization_id = c.organization_id
       and e.sequence        = c.sequence
     where c.organization_id = ${organizationId}::uuid
     order by c.sequence
  `.execute(uow.query);

  const out: CheckpointVerification[] = [];
  for (const row of rows.rows) {
    const signatureValid =
      row.algorithm === 'ed25519' &&
      (await verifySignature(Buffer.from(row.message, 'hex'), {
        keyId: row.key_id,
        algorithm: 'ed25519',
        signature: row.signature,
      }));
    out.push({
      sequence: row.sequence,
      signedEntryHash: row.signed_entry_hash,
      currentEntryHash: row.current_entry_hash,
      signatureValid,
      matchesChain: row.current_entry_hash === row.signed_entry_hash,
    });
  }
  return out;
}
