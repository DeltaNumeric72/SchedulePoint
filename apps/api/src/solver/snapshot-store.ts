import { canonicalStringify, type UnitOfWork } from '@schedulepoint/domain';
import type { SnapshotConstituent, SolverInputSnapshotDocument } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { digestRows, sha256 } from '../schedule/render.js';

/**
 * Persisting the canonical input snapshot — migration 0016.
 *
 * ## The hash, and why it is over the canonical form
 *
 * SPEC-04 §3.4: "`input_hash` covers all of it." All of it means the document,
 * not a summary of the document — a hash over "the interesting fields" is a hash
 * that two genuinely different problems can share, and the whole value of the
 * hash is that they cannot.
 *
 * `canonicalStringify` is the rule module's canonicalisation, reused rather than
 * respelled: keys sorted, arrays in authored order (order is meaning for a
 * pattern rule's segments), `undefined` members dropped so an absent optional
 * and an explicit `undefined` hash identically, and a throw on a non-finite
 * number so `NaN` can never enter a "canonical" artifact silently. Determinism
 * is therefore a property of the shipped function, and the proof
 * (`apps/api/test/solver/snapshot-store.test.ts`) exercises it against reordered inputs rather than
 * asserting it.
 *
 * ## Why `solver_input_snapshots` is not in the `Database` interface
 *
 * The same reason `publication_records` and `rule_revisions` are not: a typed
 * `updateTable('solver_input_snapshots')` would be a rewrite path the type
 * system handed out for a table whose entire value is that it cannot be
 * rewritten. Rows go in through the raw `sql` insert below and come out through
 * raw reads; the database refuses UPDATE and DELETE to every role and to the
 * owner (0016 §2, §3).
 *
 * Not a provider module: nothing here reaches anything outside the database, and
 * every statement runs on the caller's unit of work.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** The identity of a persisted snapshot. What phase two dispatches. */
export interface PersistedSnapshot {
  readonly snapshotId: string;
  readonly canonicalInputHash: string;
  readonly document: SolverInputSnapshotDocument;
  /** `true` when an existing row with this idempotency key was returned. */
  readonly replayed: boolean;
}

/**
 * The canonical input hash. Pure over the document.
 *
 * Exported because the determinism proof, the worker's response check, and the
 * store all have to mean the same thing by "the hash", and three call sites
 * computing it three ways is the S-01 shape.
 */
export function canonicalInputHash(document: SolverInputSnapshotDocument): string {
  return sha256(canonicalStringify(document));
}

/**
 * What an idempotency key is a key FOR.
 *
 * 0015's `publication_records` lesson, applied here before it can be learned
 * twice: binding a key to (period, key) alone answers "have I seen this key?"
 * and not "have I seen this key for THIS request?". A client that reused a key
 * across two different versions, or after the world moved, would be told its
 * assembly had already succeeded when a different one had.
 *
 * The canonical input hash is deliberately part of the identity. Re-presenting a
 * key after demand changed is not a replay of the same request — it is a new
 * request wearing an old key, and answering it with the old snapshot would hand
 * a scheduler a build of a world that no longer exists.
 */
export interface SemanticAssemblyRequest {
  readonly periodId: string;
  readonly versionId: string;
  readonly canonicalInputHash: string;
}

export function semanticAssemblyDigest(request: SemanticAssemblyRequest): string {
  return digestRows([
    {
      operation: 'assemble-solver-input',
      period: request.periodId,
      version: request.versionId,
      inputHash: request.canonicalInputHash,
    },
  ]);
}

/** Raised when an idempotency key is replayed for a materially different request. */
export class SnapshotIdempotencyConflictError extends Error {
  readonly code = 'SOLVER_INPUT_IDEMPOTENCY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super(
      'SOLVER_INPUT_IDEMPOTENCY_CONFLICT: this idempotency key was already used for a ' +
        'materially different build input. A key identifies one request, not one caller.',
    );
    this.name = 'SnapshotIdempotencyConflictError';
  }
}

export interface PersistCanonicalInputOptions {
  readonly document: SolverInputSnapshotDocument;
  readonly constituents: readonly SnapshotConstituent[];
  readonly idempotencyKey: string;
}

/**
 * Insert the snapshot, or return the one this key already produced.
 *
 * **Runs inside the caller's unit of work**, in the same transaction that
 * assembled the document — which is the whole point of the two-phase design: the
 * world the snapshot describes and the world the snapshot was read from are the
 * same world, guaranteed by the transaction rather than by timing.
 *
 * `ON CONFLICT DO NOTHING` followed by a read, rather than `ON CONFLICT DO
 * UPDATE`: there is no UPDATE grant on this table and there must not be one, so
 * the replay path has to be a read. That is not a workaround — an upsert would
 * be a rewrite path, and the table exists precisely to have none.
 */
export async function persistCanonicalInput(
  uow: Uow,
  options: PersistCanonicalInputOptions,
): Promise<PersistedSnapshot> {
  const document = options.document;
  const hash = canonicalInputHash(document);
  const semanticDigest = semanticAssemblyDigest({
    periodId: document.periodId,
    versionId: document.versionId,
    canonicalInputHash: hash,
  });

  const inserted = await sql<{ id: string }>`
    INSERT INTO solver_input_snapshots (
      organization_id, group_id, period_id, version_id,
      snapshot_schema_version, compiler_version, rule_schema_version,
      canonical_input_hash, payload, constituents,
      timezone_basis, tzdb_version, start_date, end_date,
      initiated_by, idempotency_key, semantic_request_digest
    ) VALUES (
      ${document.organizationId}, ${document.groupId}, ${document.periodId}, ${document.versionId},
      ${document.snapshotSchemaVersion}, ${document.compilerVersion}, ${document.ruleSchemaVersion},
      ${hash},
      ${canonicalStringify(document)}::jsonb,
      ${canonicalStringify(options.constituents)}::jsonb,
      ${document.timezone.basis}, ${document.timezone.tzdbVersion},
      ${document.startDate}::date, ${document.endDate}::date,
      nullif(current_setting('app.membership_id', true), '')::uuid,
      ${options.idempotencyKey}, ${semanticDigest}
    )
    ON CONFLICT (organization_id, group_id, period_id, idempotency_key) DO NOTHING
    RETURNING id
  `.execute(uow.query);

  const newRow = inserted.rows[0];
  if (newRow !== undefined) {
    return { snapshotId: newRow.id, canonicalInputHash: hash, document, replayed: false };
  }

  const existing = await sql<{
    id: string;
    canonical_input_hash: string;
    semantic_request_digest: string;
  }>`
    SELECT id, canonical_input_hash, semantic_request_digest
      FROM solver_input_snapshots
     WHERE period_id = ${document.periodId}
       AND idempotency_key = ${options.idempotencyKey}
  `.execute(uow.query);

  const row = existing.rows[0];
  if (row === undefined) {
    /* The insert conflicted and the read found nothing. Under RLS that means the
     * conflicting row belongs to a tenant this context cannot see — which the
     * composite tenant predicate makes unreachable, because the conflicting key
     * includes `organization_id` and `group_id`. Refusing is the only honest
     * answer: the alternative is to retry and hide a genuine anomaly. */
    throw new SnapshotIdempotencyConflictError(options.idempotencyKey);
  }
  if (row.semantic_request_digest !== semanticDigest) {
    throw new SnapshotIdempotencyConflictError(options.idempotencyKey);
  }
  return {
    snapshotId: row.id,
    canonicalInputHash: row.canonical_input_hash,
    document,
    replayed: true,
  };
}

export interface StoredSnapshot {
  readonly snapshotId: string;
  readonly canonicalInputHash: string;
  readonly payload: unknown;
  readonly constituents: unknown;
  readonly createdAt: Date;
  readonly initiatedBy: string | null;
}

/** One snapshot by id, or `null` when it is not visible in this context. */
export async function readSnapshot(uow: Uow, snapshotId: string): Promise<StoredSnapshot | null> {
  const result = await sql<{
    id: string;
    canonical_input_hash: string;
    payload: unknown;
    constituents: unknown;
    created_at: Date;
    initiated_by: string | null;
  }>`
    SELECT id, canonical_input_hash, payload, constituents, created_at, initiated_by
      FROM solver_input_snapshots
     WHERE id = ${snapshotId}
  `.execute(uow.query);

  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    snapshotId: row.id,
    canonicalInputHash: row.canonical_input_hash,
    payload: row.payload,
    constituents: row.constituents,
    createdAt: row.created_at,
    initiatedBy: row.initiated_by,
  };
}
