import type { AlertSink, CheckpointSigner, TenantContext } from '@schedulepoint/domain';
import { sql } from 'kysely';

import type { PgUnitOfWorkRunner } from '../db/unit-of-work.js';
import { writeCheckpoint } from './checkpoints.js';
import { recordAuditEvent } from './recorder.js';
import { verifyAuditChain, verifyCheckpoints } from './verification.js';

/**
 * SPEC-11 §2's two periodic jobs — the **always-on** layer.
 *
 * > "Periodic checkpoint: every *N* entries and at least daily…"
 * > "Verification job: recomputes the chain between checkpoints and **alerts on
 * > any mismatch**."
 *
 * ## Why the CLI was not enough
 *
 * `src/audit/verify-cli.ts` answers the question when an operator asks it. A
 * tamper-evidence control that only reports when someone thinks to look is a
 * control that reports after the incident. These are the jobs that look
 * continuously; the CLI stays, because during an incident an operator needs to
 * ask directly and read the answer, and exit codes are a better interface for
 * that than a log line.
 *
 * ## How they find their work without a tenant context
 *
 * `app_audit_organizations_due(N, max_age)` — the **only** cross-tenant read in
 * the system, `SECURITY DEFINER`, granted to `app_worker` alone, returning
 * counters and timestamps and no tenant content beyond the organization
 * identifier itself. Each organization it names is
 * then processed in an ordinary per-tenant unit of work, so every byte of actual
 * audit content is read under RLS with a context, exactly as a request would.
 *
 * ## One organization's failure does not stop the sweep
 *
 * A sweep that aborts on the first problem stops looking at every organization
 * after it — and the organization with the problem is precisely the one whose
 * neighbours most need checking. Each is handled independently and the outcomes
 * are returned together.
 */

/** SPEC-11 §2's "every N entries". */
export const DEFAULT_CHECKPOINT_ENTRY_INTERVAL = 100n;
/** SPEC-11 §2's "and at least daily". */
export const DEFAULT_CHECKPOINT_MAX_AGE = '24 hours';

interface DueRow {
  organization_id: string;
  head_sequence: string;
  last_checkpoint_sequence: string | null;
}

function organizationContext(organizationId: string, correlationId: string): TenantContext {
  return { organizationId, groupId: null, membershipId: null, correlationId };
}

/**
 * Organizations whose chain has advanced by `entryInterval` since their last
 * checkpoint, or whose last checkpoint is older than `maxAge`, or which have
 * never been checkpointed.
 */
async function organizationsDue(
  worker: PgUnitOfWorkRunner,
  entryInterval: bigint,
  maxAge: string,
): Promise<readonly DueRow[]> {
  // No tenant context: the function is SECURITY DEFINER and returns counters
  // only. It is called through the unit-of-work runner all the same, so the
  // statement still goes through the one place that owns a transaction.
  const context: TenantContext = {
    // DELIBERATE SENTINEL, and it is the RFC 9562 **nil UUID** rather than a
    // valid v4 — `organizations.id` is populated with generated v4 values, so a
    // nil UUID cannot collide with a real organization even by accident, and a
    // reader can tell at a glance that it names nothing.
    //
    // The unit of work still establishes a full tenant context, because there is
    // no way to open one without a tenant and inventing an escape hatch for this
    // one caller would be the exact bypass I-15 exists to prevent. The
    // consequence is the right one: every tenant table is invisible for the
    // duration of this transaction, and the only thing reachable is
    // `app_audit_organizations_due`, which is SECURITY DEFINER and returns
    // counters.
    organizationId: '00000000-0000-0000-0000-000000000000',
    groupId: null,
    membershipId: null,
    correlationId: 'audit-periodic-enumerate',
  };
  return worker.run(context, async ({ query }) => {
    const result = await sql<DueRow>`
      select organization_id::text          as organization_id,
             head_sequence::text            as head_sequence,
             last_checkpoint_sequence::text as last_checkpoint_sequence
        from app_audit_organizations_due(${entryInterval.toString()}::bigint, ${maxAge}::interval)
    `.execute(query);
    return result.rows;
  });
}

export interface CheckpointSweepResult {
  readonly considered: number;
  readonly written: readonly { organizationId: string; sequence: string }[];
  readonly failed: readonly { organizationId: string; errorCode: string }[];
}

export interface CheckpointSweepOptions {
  readonly entryInterval?: bigint;
  readonly maxAge?: string;
}

/** SPEC-11 §2's periodic checkpoint. */
export async function runCheckpointSweep(
  worker: PgUnitOfWorkRunner,
  signer: CheckpointSigner,
  options: CheckpointSweepOptions = {},
): Promise<CheckpointSweepResult> {
  const due = await organizationsDue(
    worker,
    options.entryInterval ?? DEFAULT_CHECKPOINT_ENTRY_INTERVAL,
    options.maxAge ?? DEFAULT_CHECKPOINT_MAX_AGE,
  );

  const written: { organizationId: string; sequence: string }[] = [];
  const failed: { organizationId: string; errorCode: string }[] = [];

  for (const row of due) {
    try {
      const checkpoint = await worker.run(
        organizationContext(row.organization_id, 'audit-periodic-checkpoint'),
        (uow) => writeCheckpoint(uow, signer),
      );
      if (checkpoint !== null) {
        written.push({ organizationId: row.organization_id, sequence: checkpoint.sequence });
      }
    } catch {
      // A code, never the message (rule 9): a signer or database error string is
      // operator-facing text of unknown provenance.
      failed.push({ organizationId: row.organization_id, errorCode: 'checkpoint_failed' });
    }
  }

  return { considered: due.length, written, failed };
}

export interface VerificationSweepResult {
  readonly considered: number;
  readonly intact: readonly string[];
  readonly broken: readonly {
    organizationId: string;
    problems: readonly string[];
    checkpointMismatches: number;
  }[];
}

/**
 * SPEC-11 §2's verification job — and **it alerts**.
 *
 * The alert is the deliverable. A verification job that computes a verdict and
 * writes it to a return value nobody reads is a job that has verified nothing,
 * so a broken chain emits at **page** severity and records an
 * `audit.chain_broken` event in the chain itself.
 *
 * The detail carries organization ids, problem kinds and counts — tenant
 * identifiers are permitted in an alert; nothing a user typed is (I-07, I-17).
 */
export async function runVerificationSweep(
  worker: PgUnitOfWorkRunner,
  signer: CheckpointSigner,
  alerts: AlertSink,
  organizationIds: readonly string[],
): Promise<VerificationSweepResult> {
  const intact: string[] = [];
  const broken: { organizationId: string; problems: string[]; checkpointMismatches: number }[] = [];

  for (const organizationId of organizationIds) {
    const context = organizationContext(organizationId, 'audit-periodic-verify');
    const chain = await worker.run(context, (uow) => verifyAuditChain(uow));
    const checkpoints = await worker.run(context, (uow) =>
      verifyCheckpoints(uow, (m, s) => signer.verify(m, s)),
    );
    const badCheckpoints = checkpoints.filter((c) => !c.signatureValid || !c.matchesChain);

    if (chain.intact && badCheckpoints.length === 0) {
      intact.push(organizationId);
      continue;
    }

    const problems = [
      ...new Set([
        ...chain.problems.map((p) => p.problem),
        ...badCheckpoints.map((c) => (c.signatureValid ? 'checkpoint_chain_mismatch' : 'checkpoint_signature_invalid')),
      ]),
    ];
    broken.push({ organizationId, problems, checkpointMismatches: badCheckpoints.length });

    alerts.emit({
      severity: 'page',
      code: 'AUDIT_CHAIN_BROKEN',
      message:
        'Audit chain verification found a discrepancy. SPEC-11 §2: this is detection of ' +
        'alteration by a privileged actor until proven otherwise.',
      detail: {
        organizationId,
        problems,
        firstProblemSequence: chain.problems[0]?.sequence ?? null,
        checkpointMismatches: badCheckpoints.length,
        entries: chain.entries,
        // A checkpoint signature verified by a key this process also holds is
        // not evidence. The operator needs to know that in the alert itself.
        signingKeyIsIsolated: signer.keyIsIsolated,
      },
    });

    // Recorded in the chain as well as alerted. An append cannot repair the
    // chain, and it is not meant to: it timestamps the detection inside the very
    // record whose integrity is in question, so a later reader sees when the
    // system first knew.
    try {
      await worker.run(context, (uow) =>
        recordAuditEvent(uow, {
          eventName: 'audit.chain_broken',
          subjectType: 'audit_chain',
          subjectId: organizationId,
          systemActor: true,
          payload: { problems: problems.length, checkpointMismatches: badCheckpoints.length },
        }),
      );
    } catch {
      // If the chain is damaged badly enough that an append fails, the alert has
      // already gone out. Losing the alert to a secondary failure would be the
      // worse outcome, so this cannot throw.
    }
  }

  return { considered: organizationIds.length, intact, broken };
}

/**
 * Every organization that has an audit chain at all.
 *
 * Uses the same enumeration function with a zero interval and a zero age, so
 * every chain head matches. Exists so the verification sweep can cover
 * everything rather than only what is due for a checkpoint — an organization
 * that has stopped receiving events is exactly the one whose chain nobody would
 * otherwise look at again.
 */
export async function allAuditedOrganizations(
  worker: PgUnitOfWorkRunner,
): Promise<readonly string[]> {
  const rows = await organizationsDue(worker, 0n, '0 seconds');
  return rows.map((r) => r.organization_id);
}
