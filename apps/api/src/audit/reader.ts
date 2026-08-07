import type { UnitOfWork } from '@schedulepoint/domain';
import { AUDIT_READ_MAX_LIMIT, type AuditEventQuery, type AuditEventView } from '@schedulepoint/contracts';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * The audit **read** surface — OPUS-M3-008, closing the gap FAD-26 recorded.
 *
 * ## The audit module is frozen, and this is one of the two things it is
 * unfrozen for
 *
 * Packet 32 §10f unfreezes `apps/api/src/audit/**` for exactly two changes: this
 * read surface and the `app_verify_audit_chain` group-scope fix. Nothing else in
 * the module moves — no new write path, no update path, no delete path.
 * Non-bypass rule 6 is untouched by construction: **this file contains no
 * statement that is not a `SELECT`**, and the module still exposes no way to
 * alter or remove an audit row.
 *
 * ## Reading is not verifying, and the two must not be confused
 *
 * `verification.ts` answers "is the chain intact?" and requires an
 * ORGANIZATION-scoped unit of work, because `sequence` is gapless per
 * organization and a group-scoped walk would report gaps that are not there
 * (the M3-003 review's N-8; migration 0011 now makes the SQL function refuse it
 * too).
 *
 * This function answers a different question — "what happened to this subject,
 * that I am allowed to see?" — and is therefore **deliberately group-scoped**,
 * with the gaps expected rather than alarming. The wire says so on every
 * response (`sequenceIsOrganizationWide`). Collapsing the two surfaces into one
 * "audit" endpoint is exactly how an operator learns to ignore a gap report.
 *
 * ## Tenancy is RLS's, not this function's
 *
 * There is no `organization_id` or `group_id` argument. `audit_events` carries
 * its own policies (migration 0003), so a group-scoped unit of work sees that
 * group's rows and a foreign group's rows are simply not there — the same
 * "not found and not yours are the same answer" property every other read in
 * this repository has (T-05b).
 */

type Uow = UnitOfWork<Kysely<Database>>;

export interface AuditReadResult {
  readonly events: readonly AuditEventView[];
  /** `true` when the ceiling truncated the answer. */
  readonly truncated: boolean;
}

interface AuditRow {
  id: string;
  sequence: string;
  occurred_at: Date;
  event_name: string;
  actor_kind: string;
  actor_membership_id: string | null;
  group_id: string | null;
  subject_type: string;
  subject_id: string | null;
  payload: unknown;
  entry_hash: string;
  prev_hash: string;
}

/** The default page size when a caller names none. */
const DEFAULT_LIMIT = 50;

/**
 * Read audit events visible in this unit of work's context, newest first.
 *
 * `displayNames` is passed in rather than read here so the caller decides
 * whether a name lookup is in scope for its surface — the publication surface
 * already holds one, and a second identical query per request would be
 * amplification for a cosmetic field.
 */
export async function readAuditEvents(
  uow: Uow,
  query: AuditEventQuery,
  displayNames: ReadonlyMap<string, string>,
): Promise<AuditReadResult> {
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, AUDIT_READ_MAX_LIMIT);

  /* One row over the limit, so "there is more" is MEASURED rather than inferred
   * from a full page — a page that happens to be exactly `limit` long is not
   * evidence of truncation, and telling a reader their history is complete when
   * it is not is the failure this surface must not have. */
  const rows = await sql<AuditRow>`
    SELECT e.id,
           e.sequence::text        AS sequence,
           e.occurred_at,
           e.event_name,
           e.actor_kind,
           e.actor_membership_id,
           e.group_id,
           e.subject_type,
           e.subject_id,
           e.payload,
           encode(e.entry_hash, 'hex') AS entry_hash,
           encode(e.prev_hash,  'hex') AS prev_hash
      FROM audit_events e
     WHERE (${query.subjectType ?? null}::text IS NULL OR e.subject_type = ${query.subjectType ?? null})
       AND (${query.subjectId ?? null}::uuid IS NULL OR e.subject_id = ${query.subjectId ?? null}::uuid)
       AND (${query.eventName ?? null}::text IS NULL OR e.event_name = ${query.eventName ?? null})
     -- Qualified, for the reason verification.ts gives at length: an unqualified
     -- ORDER BY resolves to the OUTPUT column when one carries the name, and
     -- sequence is aliased to text here. e.sequence is the bigint.
     ORDER BY e.sequence DESC
     LIMIT ${limit + 1}
  `.execute(uow.query);

  const page = rows.rows.slice(0, limit);
  return {
    truncated: rows.rows.length > limit,
    events: page.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      occurredAt: row.occurred_at.toISOString(),
      eventName: row.event_name,
      actorKind: row.actor_kind,
      actorMembershipId: row.actor_membership_id,
      actorDisplayName:
        row.actor_membership_id === null
          ? null
          : (displayNames.get(row.actor_membership_id) ?? null),
      groupId: row.group_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      // The closed-payload CHECK (migration 0003) is what makes this safe to
      // publish: sixteen scalar keys, 64 printable characters each, no free text.
      payload: (row.payload ?? {}) as AuditEventView['payload'],
      entryHash: row.entry_hash,
      prevHash: row.prev_hash,
    })),
  };
}
