import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { Database } from '../db/schema.js';
import { loadHolding, type HoldingRow } from './in-force-loader.js';

/**
 * Qualifications and credential holdings (CAP-058, PO-DEC-12's recorded default:
 * **administrator-granted, patient-safety adjacent**).
 *
 * PO-DEC-12 is a pending decision resolved to its default (doc 21). Nothing here
 * implements a non-default branch: there is no self-service grant path, no
 * self-attestation, and no route by which a member records their own credential.
 * Adding one would be implementing the other branch, which non-bypass rule 12
 * forbids without a recorded decision change.
 *
 * ## What a "correction" is
 *
 * Not an edit. A holding's window, its evidence reference and the credential it
 * names are fixed at issue; the only thing that moves afterwards is `status`, and
 * only along the transitions the database permits. Correcting a mis-issued
 * credential means revoking it and issuing a new one — two audited events, both
 * retained, which is the record a credentialing review needs and an in-place edit
 * would have destroyed.
 *
 * ## Why revocation does not shorten the window
 *
 * A revoked holding keeps `valid_from` and `valid_until` exactly as issued. The
 * window is the statement the issuing body made; revocation is a statement *this*
 * organization makes about it. Overwriting the first with the second loses the
 * fact that the credential was valid for that period — and eligibility already
 * requires `status ∈ {valid, expiring}`, so the status change alone is what stops
 * a revoked credential conferring anything.
 */

export interface CreateQualificationInput {
  readonly key: string;
  readonly name: string;
  readonly requiresExpiry?: boolean | undefined;
  readonly issuingBody?: string | null | undefined;
}

export interface QualificationRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly requiresExpiry: boolean;
  readonly issuingBody: string | null;
  readonly status: 'active' | 'retired';
  /** Row CAS counter (OPUS-M4-000A, migration 0012). What a mutation presents back. */
  readonly version: number;
}

interface RawQualificationRow {
  id: string;
  key: string;
  name: string;
  requires_expiry: boolean;
  issuing_body: string | null;
  status: 'active' | 'retired';
  version: number;
}

const QUALIFICATION_COLUMNS = [
  'id',
  'key',
  'name',
  'requires_expiry',
  'issuing_body',
  'status',
  'version',
] as const;

function toQualification(row: RawQualificationRow): QualificationRow {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    requiresExpiry: row.requires_expiry,
    issuingBody: row.issuing_body,
    status: row.status,
    version: row.version,
  };
}

/**
 * A mutation presented a stale row version (OPUS-M4-000A).
 *
 * The row exists — the caller could read it — but it has moved since the
 * caller read it. The route maps this to the same `409` a unique-key conflict
 * gets; the message carries no schema detail. Distinguished from "not found"
 * because a caller told "gone" would recreate what merely moved.
 */
export class StaleRowVersionError extends Error {
  readonly code = 'STALE_ROW_VERSION';

  constructor(subject: string) {
    super(`STALE_ROW_VERSION: the ${subject} changed since it was read; re-read and decide again`);
    this.name = 'StaleRowVersionError';
  }
}

/**
 * The SERVICE half of a database rule (OPUS-M4-000A packet clause 2/3): the
 * caller typed something the rule refuses, so the answer is a field-addressed
 * 422 *before any statement*, and the 0012 trigger refuses the same shape
 * independently for every writer that is not this service.
 */
export class QualificationRuleError extends Error {
  readonly code: 'QUALIFICATION_REQUIRES_EXPIRY' | 'QUALIFICATION_RETIRED';

  constructor(code: 'QUALIFICATION_REQUIRES_EXPIRY' | 'QUALIFICATION_RETIRED', message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'QualificationRuleError';
  }
}

/** Create a qualification in the acting group's vocabulary. */
export async function createQualification(
  uow: UnitOfWork<Kysely<Database>>,
  input: CreateQualificationInput,
): Promise<QualificationRow> {
  const { query } = uow;
  const organizationId = uow.context.organizationId;
  const groupId = uow.context.groupId;
  if (groupId === null) throw new Error('a qualification requires a group-scoped unit of work');

  const id = randomUUID();
  await query
    .insertInto('qualifications')
    .values({
      id,
      organization_id: organizationId,
      group_id: groupId,
      key: input.key,
      name: input.name,
      requires_expiry: input.requiresExpiry ?? false,
      issuing_body: input.issuingBody ?? null,
    })
    .execute();

  const rows = (await query
    .selectFrom('qualifications')
    .select(QUALIFICATION_COLUMNS)
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute()) as unknown as RawQualificationRow[];
  const written = rows[0];
  if (written === undefined) throw new Error('the qualification was not readable after it was written');

  /* ── the `mechanism` discriminator, and why it is not three event names ────
   *
   * `staffing.qualification.written` is emitted for creation, retirement AND
   * reinstatement, which an independent review correctly called
   * indistinguishable. The fix the ruling permits is either distinguishing names
   * or a mechanism discriminator, and the discriminator is chosen here for one
   * reason: the name is already in `AUDIT_EVENT_NAMES`, and non-bypass rule 13
   * says a stable ID is never removed or repurposed. Splitting it would mean
   * retiring a name — cheap today, on an unmerged branch, and exactly the habit
   * the rule exists to prevent.
   *
   * `mechanism` is one of the five fields the packet's audit requirement names, so
   * it belongs in every payload regardless; here it also carries the distinction.
   * `payload->>'mechanism'` is queryable, and the before/after status pair says
   * the same thing a second way.
   *
   * `key` is safe to carry because the column is CHECK-constrained to a lower-case
   * token with no spaces. `name` and `issuing_body` are display text and are
   * NEVER carried — only whether an issuing body was recorded. */
  await recordAuditEvent(uow, {
    eventName: 'staffing.qualification.written',
    subjectType: 'qualification',
    subjectId: id,
    payload: {
      mechanism: 'create',
      key: written.key,
      beforeStatus: 'none',
      afterStatus: written.status,
      requiresExpiry: written.requires_expiry,
      hasIssuingBody: written.issuing_body !== null,
    },
  });

  return toQualification(written);
}

/**
 * Retire (or reinstate) a qualification. **Never a delete.**
 *
 * 06 §3.2: "Not deleted while holdings exist". Two controls, and neither is a
 * comment: no runtime role holds `DELETE` on the table, and
 * `app_guard_qualification_delete` refuses the statement for the table owner as
 * well — because the owner is who a maintenance script runs as, and "the runtime
 * cannot reach it" is a different claim from "it cannot happen".
 */
export async function setQualificationStatus(
  uow: UnitOfWork<Kysely<Database>>,
  input: {
    readonly qualificationId: string;
    readonly status: 'active' | 'retired';
    readonly expectedVersion: number;
  },
): Promise<QualificationRow | null> {
  const { query } = uow;
  const organizationId = uow.context.organizationId;

  // The BEFORE half, read in the same transaction as the write. Without it the
  // audit row can say what the status became and not what it was, which makes
  // "when was this retired" answerable and "was it ever reinstated" not.
  const existing = (await query
    .selectFrom('qualifications')
    .select(QUALIFICATION_COLUMNS)
    .where('organization_id', '=', organizationId)
    .where('id', '=', input.qualificationId)
    .execute()) as unknown as RawQualificationRow[];
  const before = existing[0];
  if (before === undefined) return null;

  /* ── the row CAS (OPUS-M4-000A) ────────────────────────────────────────────
   *
   * The predicate is `version = <what this transaction just read>`, so the CAS
   * refuses whenever the row moved between the CALLER's read (the form load)
   * and this write — `expectedVersion` is compared against the fresh read
   * first so the refusal happens before any statement, and the WHERE clause
   * repeats it so a racing writer inside this window loses at the database.
   * The counter itself is DB-owned (`qualifications_maintain_version`); this
   * predicate is the application's half, exactly the 0005 shape. */
  if (before.version !== input.expectedVersion) {
    throw new StaleRowVersionError('qualification');
  }

  const updated = (await query
    .updateTable('qualifications')
    .set({ status: input.status, updated_at: sql<Date>`now()` })
    .where('organization_id', '=', organizationId)
    .where('id', '=', input.qualificationId)
    .where('version', '=', input.expectedVersion)
    .returning([...QUALIFICATION_COLUMNS])
    .execute()) as unknown as RawQualificationRow[];

  const row = updated[0];
  if (row === undefined) throw new StaleRowVersionError('qualification');

  await recordAuditEvent(uow, {
    eventName: 'staffing.qualification.written',
    subjectType: 'qualification',
    subjectId: row.id,
    payload: {
      // Retiring and reinstating are the same statement in opposite directions,
      // and an audit reader must be able to tell them apart without inferring it
      // from the surrounding rows.
      mechanism: input.status === 'retired' ? 'retire' : 'reinstate',
      key: row.key,
      beforeStatus: before.status,
      afterStatus: row.status,
      requiresExpiry: row.requires_expiry,
      hasIssuingBody: row.issuing_body !== null,
    },
  });
  return toQualification(row);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Holdings
 * ──────────────────────────────────────────────────────────────────────────── */

export interface GrantHoldingInput {
  readonly membershipId: string;
  readonly qualificationId: string;
  readonly validFrom?: string | undefined;
  readonly validUntil?: string | null | undefined;
  readonly evidenceRef?: string | null | undefined;
  readonly status?: 'pending' | 'valid' | undefined;
}

/**
 * Issue a credential to a membership. PO-DEC-12: administrator-granted.
 *
 * Two OPUS-M4-000A rules are enforced HERE as well as by the 0012 trigger
 * (`qualification_holdings_guard_expiry_retirement`) — the service check is
 * what turns them into a 422 the form can address; the trigger is what binds
 * every writer that is not this function:
 *
 *   - `requires_expiry`: a holding of a requires-expiry qualification must
 *     carry `validUntil`.
 *   - retirement: a retired qualification cannot be NEWLY held. Existing
 *     holdings are untouched by retirement — their status machine keeps
 *     working, and their verdict reflects retirement through the shared
 *     eligibility function rather than through any rewrite.
 *
 * There is deliberately NO `expectedVersion` on a grant: nothing mutable is
 * read to become stale — the identity is new, and a duplicate issue is refused
 * by `qualification_holdings_unique_issue` on
 * `(membership, qualification, valid_from)`.
 *
 * ## The granted-while-retiring interleaving is ADMITTED, not excluded
 *
 * FAD-28(2) and FAD-35, measured by the M4-000A independent review's probe P3e
 * and pinned by
 * `apps/api/test/profiles/granted-while-retiring-inertness.test.ts`.
 *
 * Under READ COMMITTED a grant whose lookups — this function's and the trigger's
 * alike — returned `active` still commits after a retirement has committed on
 * another connection, and what it leaves behind is a holding of a now-retired
 * qualification. **Nothing at write time prevents that, and nothing here claims
 * to.** An earlier revision of this docblock said the race was closed by the
 * trigger; that claim was falsified deterministically and is corrected here.
 *
 * What makes the outcome safe is the READ side, and it is safe for a different
 * reason than write-prevention: the shared eligibility verdict evaluates the
 * qualification's LIFECYCLE FIRST (`packages/domain/src/eligibility`, ruling R3)
 * and returns `retired` even over an in-window `valid` holding, so the
 * credential such a race produces confers nothing on any consumer — the manual
 * eligibility read, the publication gate, and canonical solver-input assembly
 * all answer `retired`. Stated precisely: the interleaving is admitted; the
 * credential it produces is inert.
 */
export async function grantHolding(
  uow: UnitOfWork<Kysely<Database>>,
  input: GrantHoldingInput,
): Promise<HoldingRow> {
  const { query } = uow;
  const organizationId = uow.context.organizationId;
  const groupId = uow.context.groupId;
  if (groupId === null) throw new Error('a qualification holding requires a group-scoped unit of work');

  const qualification = (await query
    .selectFrom('qualifications')
    .select(['id', 'requires_expiry', 'status'])
    .where('organization_id', '=', organizationId)
    .where('id', '=', input.qualificationId)
    .executeTakeFirst()) as unknown as
    | { id: string; requires_expiry: boolean; status: 'active' | 'retired' }
    | undefined;
  // An invisible qualification falls through to the composite FK / trigger,
  // whose refusal the route maps to the same 404 an RLS-hidden row gets.
  if (qualification !== undefined) {
    if (qualification.status === 'retired') {
      throw new QualificationRuleError(
        'QUALIFICATION_RETIRED',
        'a retired qualification cannot be newly held; reinstate it first',
      );
    }
    if (
      qualification.requires_expiry &&
      (input.validUntil === undefined || input.validUntil === null)
    ) {
      throw new QualificationRuleError(
        'QUALIFICATION_REQUIRES_EXPIRY',
        'this qualification requires an expiry; the holding must carry validUntil',
      );
    }
  }

  const id = randomUUID();
  await query
    .insertInto('qualification_holdings')
    .values({
      id,
      organization_id: organizationId,
      group_id: groupId,
      membership_id: input.membershipId,
      qualification_id: input.qualificationId,
      ...(input.validFrom === undefined ? {} : { valid_from: new Date(input.validFrom) }),
      valid_until:
        input.validUntil === undefined || input.validUntil === null
          ? null
          : new Date(input.validUntil),
      evidence_ref: input.evidenceRef ?? null,
      status: input.status ?? 'pending',
    })
    .execute();

  const written = await loadHolding(query, { organizationId, holdingId: id });
  if (written === null) throw new Error('the holding was not readable after it was written');

  /* `evidenceRef` is recorded as a BOOLEAN and never as its value.
   *
   * Two independent reasons, and either alone would be enough. The column admits
   * 128 characters and the closed payload admits 64, so the value does not always
   * fit — and a reference to a credential document is exactly the kind of string
   * that should not be duplicated into an append-only table that is never deleted.
   * What an audit reader needs is whether evidence was recorded, which is what
   * this says. Stated in EV-M2-PROFILES INDEX §2b as a deliberate exclusion. */
  await recordAuditEvent(uow, {
    eventName: 'staffing.qualification_holding.granted',
    subjectType: 'qualification_holding',
    subjectId: id,
    payload: {
      mechanism: 'grant',
      membershipId: written.membershipId,
      qualificationId: written.qualificationId,
      beforeStatus: 'none',
      afterStatus: written.status,
      validFrom: written.effectiveFrom,
      validUntil: written.effectiveTo ?? 'open',
      hasEvidenceRef: written.evidenceRef !== null,
    },
  });

  return written;
}

/**
 * Move a holding's status. Revocation gets its own audit event name.
 *
 * The legal transitions are enforced by
 * `app_guard_qualification_holding_administration`, not here: an application-layer
 * state machine is a second copy that a future writer can bypass, and "an expired
 * credential quietly went back to valid" is a patient-safety-adjacent outcome
 * (PO-DEC-12). This function reports the database's refusal; it does not
 * anticipate it.
 */
export async function changeHoldingStatus(
  uow: UnitOfWork<Kysely<Database>>,
  input: {
    readonly holdingId: string;
    readonly status: 'valid' | 'expiring' | 'expired' | 'revoked';
    readonly expectedVersion: number;
  },
): Promise<HoldingRow | null> {
  const { query } = uow;
  const organizationId = uow.context.organizationId;

  // The BEFORE status, through the one loader, in this transaction. A status
  // machine's audit trail is worth nothing if it records only the destination.
  const before = await loadHolding(query, { organizationId, holdingId: input.holdingId });
  if (before === null) return null;

  /* ── the row CAS (OPUS-M4-000A) ────────────────────────────────────────────
   *
   * A status decision made against a holding that has since moved — revoked by
   * a colleague, expired by the periodic job — must be refused, not layered on
   * whatever the transition table happens to admit from the NEW state. The
   * counter is DB-owned (`qualification_holdings_maintain_version`); this is
   * the application's predicate half. */
  if (before.version !== input.expectedVersion) {
    throw new StaleRowVersionError('qualification holding');
  }

  const updated = (await query
    .updateTable('qualification_holdings')
    .set({ status: input.status, updated_at: sql<Date>`now()` })
    .where('organization_id', '=', organizationId)
    .where('id', '=', input.holdingId)
    .where('version', '=', input.expectedVersion)
    .returning(['id'])
    .execute()) as unknown as { id: string }[];

  const row = updated[0];
  if (row === undefined) throw new StaleRowVersionError('qualification holding');

  const after = await loadHolding(query, { organizationId, holdingId: row.id });
  if (after === null) throw new Error('the holding was not readable after its status changed');

  await recordAuditEvent(uow, {
    eventName:
      input.status === 'revoked'
        ? 'staffing.qualification_holding.revoked'
        : 'staffing.qualification_holding.status_changed',
    subjectType: 'qualification_holding',
    subjectId: row.id,
    payload: {
      mechanism: input.status === 'revoked' ? 'revoke' : `expire:${input.status}`,
      membershipId: after.membershipId,
      qualificationId: after.qualificationId,
      beforeStatus: before.status,
      afterStatus: after.status,
      // The window is NOT rewritten by a status change, and the payload says so
      // rather than leaving a reader to assume it.
      validUntil: after.effectiveTo ?? 'open',
    },
  });

  return after;
}
