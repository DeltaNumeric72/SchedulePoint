import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database, SessionRevokedReason } from '../db/schema.js';

/**
 * Every statement this subsystem issues, in one module.
 *
 * ## Raw SQL rather than the query builder, for the reason the audit recorder
 * gives
 *
 * The column list in each `INSERT` and `UPDATE` must match the column-level
 * grant in migration 0007 exactly, and the reviewer's question is "does this
 * statement name a column the runtime role may not write?" — `token_hash`,
 * `absolute_expires_at` after issue, `session_epoch_at_issue`, `organization_id`.
 * Writing the statements out makes that answerable by reading them. Every value
 * is a bind parameter; nothing is interpolated.
 *
 * ## Every expiry is a BIND PARAMETER, never `now()`
 *
 * `now()` is the database's clock and no test can move it, so a deadline test
 * written against it can only sleep. Each function below takes the instant it
 * should compare against, and the caller takes it from the injected clock. Grep
 * this file for `now()`: it appears only in `set updated_at = now()` and in
 * revocation timestamps, neither of which is a deadline anybody compares.
 *
 * ## Nothing here is reachable outside a unit of work
 *
 * Every function takes `uow` and issues through `uow.query`. There is no pool
 * accessor, no client, and no variant that takes a runner (I-15, non-bypass
 * rule 1).
 */

type Uow = UnitOfWork<Kysely<Database>>;

/* ────────────────────────────────────────────────────────────────────────────
 * users
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CredentialRow {
  readonly id: string;
  readonly loginEmail: string;
  readonly displayName: string;
  readonly status: 'active' | 'deactivated';
  readonly passwordHash: string | null;
  readonly activatedAt: Date | null;
  readonly failedSignInCount: number;
  readonly lastFailedSignInAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly sessionEpoch: string;
}

interface CredentialDbRow {
  id: string;
  login_email: string;
  display_name: string;
  status: 'active' | 'deactivated';
  password_hash: string | null;
  activated_at: Date | null;
  failed_sign_in_count: number;
  last_failed_sign_in_at: Date | null;
  locked_until: Date | null;
  session_epoch: string;
}

function toCredential(row: CredentialDbRow): CredentialRow {
  return {
    id: row.id,
    loginEmail: row.login_email,
    displayName: row.display_name,
    status: row.status,
    passwordHash: row.password_hash,
    activatedAt: row.activated_at,
    failedSignInCount: row.failed_sign_in_count,
    lastFailedSignInAt: row.last_failed_sign_in_at,
    lockedUntil: row.locked_until,
    sessionEpoch: row.session_epoch,
  };
}

const CREDENTIAL_COLUMNS = sql`
  id::text                   as id,
  login_email                as login_email,
  display_name               as display_name,
  status                     as status,
  password_hash              as password_hash,
  activated_at               as activated_at,
  failed_sign_in_count       as failed_sign_in_count,
  last_failed_sign_in_at     as last_failed_sign_in_at,
  locked_until               as locked_until,
  session_epoch::text        as session_epoch
`;

/**
 * The identity a login email names, within the CURRENT tenant context.
 *
 * `users` is global (PO-DEC-06) and reachable only through a membership visible
 * in context, so this read is already organization-scoped by RLS: an address
 * that belongs to another organization's member returns nothing here, which is
 * the correct answer and not a leak.
 *
 * `lower(login_email)` on both sides, because an email address's local part is
 * case-sensitive in the RFC and case-insensitive in every mail system anybody
 * uses, and treating them as distinct produces two accounts for one person.
 */
export async function findCredentialByLoginEmail(
  uow: Uow,
  loginEmail: string,
): Promise<CredentialRow | undefined> {
  const result = await sql<CredentialDbRow>`
    select ${CREDENTIAL_COLUMNS} from users where lower(login_email) = lower(${loginEmail})
  `.execute(uow.query);
  const row = result.rows[0];
  return row === undefined ? undefined : toCredential(row);
}

export async function findCredentialById(
  uow: Uow,
  userId: string,
): Promise<CredentialRow | undefined> {
  const result = await sql<CredentialDbRow>`
    select ${CREDENTIAL_COLUMNS} from users where id = ${userId}::uuid
  `.execute(uow.query);
  const row = result.rows[0];
  return row === undefined ? undefined : toCredential(row);
}

/**
 * Records a failed attempt and returns the new count.
 *
 * The count DECAYS: a failure older than `failureDecayMs` no longer contributes,
 * so a person who mistypes once a month is never progressively locked. The decay
 * is computed here rather than by a scheduled job because a job that had not run
 * yet would make the threshold depend on the scheduler.
 */
export async function recordSignInFailure(
  uow: Uow,
  options: {
    readonly userId: string;
    readonly now: Date;
    readonly decayBefore: Date;
    readonly lockUntil: Date | null;
  },
): Promise<number> {
  const result = await sql<{ failed_sign_in_count: number }>`
    update users
       set failed_sign_in_count = case
             when last_failed_sign_in_at is null or last_failed_sign_in_at < ${options.decayBefore}
               then 1
             else failed_sign_in_count + 1
           end,
           last_failed_sign_in_at = ${options.now},
           locked_until = ${options.lockUntil}
     where id = ${options.userId}::uuid
    returning failed_sign_in_count
  `.execute(uow.query);
  return result.rows[0]?.failed_sign_in_count ?? 0;
}

/** Applies a lock computed from the count the previous statement returned. */
export async function applyLock(uow: Uow, userId: string, lockUntil: Date): Promise<void> {
  await sql`
    update users set locked_until = ${lockUntil} where id = ${userId}::uuid
  `.execute(uow.query);
}

export async function clearSignInFailures(uow: Uow, userId: string): Promise<void> {
  await sql`
    update users
       set failed_sign_in_count = 0, last_failed_sign_in_at = null, locked_until = null
     where id = ${userId}::uuid
  `.execute(uow.query);
}

export async function setPassword(
  uow: Uow,
  options: { readonly userId: string; readonly passwordHash: string; readonly now: Date },
): Promise<void> {
  await sql`
    update users
       set password_hash = ${options.passwordHash},
           password_updated_at = ${options.now},
           failed_sign_in_count = 0,
           last_failed_sign_in_at = null,
           locked_until = null,
           updated_at = now()
     where id = ${options.userId}::uuid
  `.execute(uow.query);
}

/** STM-018 `invited -> active`. Conditional, so a replayed activation writes nothing. */
export async function activateAccount(
  uow: Uow,
  options: { readonly userId: string; readonly passwordHash: string; readonly now: Date },
): Promise<boolean> {
  const result = await sql`
    update users
       set password_hash = ${options.passwordHash},
           password_updated_at = ${options.now},
           activated_at = ${options.now},
           failed_sign_in_count = 0,
           last_failed_sign_in_at = null,
           locked_until = null,
           updated_at = now()
     where id = ${options.userId}::uuid
       and activated_at is null
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/**
 * CAR-027. Returns `false` when the address is already in use, so the caller can
 * answer `409` rather than surfacing a constraint name.
 */
export async function changeLoginEmail(
  uow: Uow,
  options: { readonly userId: string; readonly loginEmail: string },
): Promise<'changed' | 'in_use' | 'not_found'> {
  // The unique constraint would refuse the write anyway. The explicit read is
  // what lets the caller answer 409 with a stated reason instead of surfacing a
  // constraint name — and, because it runs under RLS, it sees only addresses
  // inside this organization, so it is not an existence oracle for other tenants.
  const existing = await sql<{ id: string }>`
    select id::text as id from users
     where lower(login_email) = lower(${options.loginEmail}) and id <> ${options.userId}::uuid
  `.execute(uow.query);
  if (existing.rows.length > 0) return 'in_use';

  const result = await sql`
    update users set login_email = ${options.loginEmail}, updated_at = now()
     where id = ${options.userId}::uuid
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1 ? 'changed' : 'not_found';
}

/** SPEC-06 §4's `session_epoch`, through the SECURITY DEFINER function 0007 defines. */
export async function bumpSessionEpoch(uow: Uow, userId: string): Promise<string> {
  const result = await sql<{ epoch: string }>`
    select app_bump_session_epoch(${userId}::uuid)::text as epoch
  `.execute(uow.query);
  const epoch = result.rows[0]?.epoch;
  if (epoch === undefined || epoch === null) {
    throw new Error('SESSION_EPOCH_BUMP_RETURNED_NOTHING');
  }
  return epoch;
}

/** Every role the user holds in the current organization — for the MFA requirement. */
export async function rolesHeldByUser(uow: Uow, userId: string): Promise<string[]> {
  const result = await sql<{ role: string }>`
    select organization_role as role from memberships
     where user_id = ${userId}::uuid and organization_role is not null and status = 'active'
    union
    select group_role as role from memberships
     where user_id = ${userId}::uuid and group_role is not null and status = 'active'
  `.execute(uow.query);
  return result.rows.map((row) => row.role);
}

/** Whether the user holds any ACTIVE membership in the current organization. */
export async function hasActiveMembership(uow: Uow, userId: string): Promise<boolean> {
  const result = await sql<{ n: number }>`
    select count(*)::int as n from memberships
     where user_id = ${userId}::uuid and status = 'active'
  `.execute(uow.query);
  return (result.rows[0]?.n ?? 0) > 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * sessions
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SessionRow {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly state: 'active' | 'revoked';
  readonly mfaSatisfied: boolean;
  readonly sessionEpochAtIssue: string;
  readonly persistent: boolean;
}

interface SessionDbRow {
  id: string;
  organization_id: string;
  user_id: string;
  expires_at: Date;
  absolute_expires_at: Date;
  state: 'active' | 'revoked';
  mfa_satisfied: boolean;
  session_epoch_at_issue: string;
  persistent: boolean;
}

const SESSION_COLUMNS = sql`
  id::text                       as id,
  organization_id::text          as organization_id,
  user_id::text                  as user_id,
  expires_at                     as expires_at,
  absolute_expires_at            as absolute_expires_at,
  state                          as state,
  mfa_satisfied                  as mfa_satisfied,
  session_epoch_at_issue::text   as session_epoch_at_issue,
  persistent                     as persistent
`;

function toSession(row: SessionDbRow): SessionRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    state: row.state,
    mfaSatisfied: row.mfa_satisfied,
    sessionEpochAtIssue: row.session_epoch_at_issue,
    persistent: row.persistent,
  };
}

/**
 * `session_epoch_at_issue` is absent from this INSERT and that is deliberate:
 * `sessions_assign_epoch` (BEFORE INSERT, SECURITY DEFINER) bumps the user's
 * epoch and writes the result. An application-supplied value could disagree with
 * the `users` row it claims to describe, and nothing downstream would notice.
 */
export async function insertSession(
  uow: Uow,
  options: {
    readonly userId: string;
    readonly tokenHash: Buffer;
    /** The injected clock's instant. Supplied so the row is SELF-CONSISTENT. */
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly absoluteExpiresAt: Date;
    readonly persistent: boolean;
    readonly rotatedFromSessionId?: string | null;
  },
): Promise<SessionRow> {
  const id = randomUUID();
  /* `issued_at` and `last_seen_at` are SUPPLIED rather than defaulted to
   * `now()`, and the reason was measured rather than anticipated: the deadlines
   * come from the injected clock and the defaults come from the database's, so
   * under a controllable clock the row described a session issued in August that
   * expired in April. SBX-006 duly reported an absolute window of MINUS 2988
   * hours. In production the two clocks agree and this changes nothing; under
   * the seam it is the difference between a row that describes a session and a
   * row that describes two. */
  const result = await sql<SessionDbRow>`
    insert into sessions (
      organization_id, id, user_id, token_hash, issued_at, last_seen_at,
      expires_at, absolute_expires_at, persistent, rotated_from_session_id
    ) values (
      ${uow.context.organizationId}::uuid,
      ${id}::uuid,
      ${options.userId}::uuid,
      ${options.tokenHash},
      ${options.issuedAt},
      ${options.issuedAt},
      ${options.expiresAt},
      ${options.absoluteExpiresAt},
      ${options.persistent},
      ${options.rotatedFromSessionId ?? null}::uuid
    )
    returning ${SESSION_COLUMNS}
  `.execute(uow.query);
  const row = result.rows[0];
  if (row === undefined) throw new Error('SESSION_INSERT_PRODUCED_NO_ROW');
  return toSession(row);
}

/**
 * The session a presented token names, if it is live at `now`.
 *
 * Both deadlines are in the predicate, so an expired session is INDISTINGUISHABLE
 * from an absent one at this layer — the caller cannot accidentally branch on
 * which, and a timing difference between the two cases does not exist. Which one
 * it was is recovered separately by `describeSessionFailure` for the audit
 * payload, under an explicit second read.
 */
export async function findLiveSessionByTokenHash(
  uow: Uow,
  tokenHash: Buffer,
  now: Date,
): Promise<SessionRow | undefined> {
  const result = await sql<SessionDbRow>`
    select ${SESSION_COLUMNS} from sessions
     where token_hash = ${tokenHash}
       and state = 'active'
       and expires_at > ${now}
       and absolute_expires_at > ${now}
  `.execute(uow.query);
  const row = result.rows[0];
  return row === undefined ? undefined : toSession(row);
}

/** Operator-facing only: which of the four reasons a lookup failed. */
export async function describeSessionFailure(
  uow: Uow,
  tokenHash: Buffer,
  now: Date,
): Promise<'unknown' | 'revoked' | 'idle_expired' | 'absolute_expired'> {
  const result = await sql<SessionDbRow>`
    select ${SESSION_COLUMNS} from sessions where token_hash = ${tokenHash}
  `.execute(uow.query);
  const row = result.rows[0];
  if (row === undefined) return 'unknown';
  if (row.state === 'revoked') return 'revoked';
  if (row.absolute_expires_at.getTime() <= now.getTime()) return 'absolute_expired';
  if (row.expires_at.getTime() <= now.getTime()) return 'idle_expired';
  // Live after all — a concurrent slide landed between the two reads.
  return 'unknown';
}

/**
 * Slides the idle deadline. `absolute_expires_at` is deliberately absent: the
 * grant permits it and the trigger refuses it, which is a control an omission
 * here would not be.
 */
export async function slideSession(
  uow: Uow,
  options: { readonly sessionId: string; readonly now: Date; readonly expiresAt: Date },
): Promise<void> {
  await sql`
    update sessions
       set last_seen_at = ${options.now},
           expires_at = least(${options.expiresAt}::timestamptz, absolute_expires_at),
           updated_at = now()
     where id = ${options.sessionId}::uuid and state = 'active'
  `.execute(uow.query);
}

export async function markMfaSatisfied(uow: Uow, sessionId: string): Promise<void> {
  await sql`
    update sessions set mfa_satisfied = true, updated_at = now()
     where id = ${sessionId}::uuid and state = 'active'
  `.execute(uow.query);
}

export async function revokeSession(
  uow: Uow,
  options: {
    readonly sessionId: string;
    readonly reason: SessionRevokedReason;
    readonly now: Date;
  },
): Promise<boolean> {
  const result = await sql`
    update sessions
       set state = 'revoked', revoked_at = ${options.now},
           revoked_reason = ${options.reason}, updated_at = now()
     where id = ${options.sessionId}::uuid and state = 'active'
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/** Every live session for a user in the current organization. Returns the count. */
export async function revokeAllSessionsForUser(
  uow: Uow,
  options: {
    readonly userId: string;
    readonly reason: SessionRevokedReason;
    readonly now: Date;
    readonly exceptSessionId?: string | null;
  },
): Promise<number> {
  const result = await sql`
    update sessions
       set state = 'revoked', revoked_at = ${options.now},
           revoked_reason = ${options.reason}, updated_at = now()
     where user_id = ${options.userId}::uuid
       and state = 'active'
       and (${options.exceptSessionId ?? null}::uuid is null
            or id <> ${options.exceptSessionId ?? null}::uuid)
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n);
}

export async function countLiveSessions(uow: Uow, userId: string, now: Date): Promise<number> {
  const result = await sql<{ n: number }>`
    select count(*)::int as n from sessions
     where user_id = ${userId}::uuid and state = 'active'
       and expires_at > ${now} and absolute_expires_at > ${now}
  `.execute(uow.query);
  return result.rows[0]?.n ?? 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * invitations (STM-017)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface InvitationRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly state: 'pending' | 'accepted' | 'expired' | 'revoked';
}

/**
 * Aliased to the INTERFACE's names, in quotes.
 *
 * Not a style choice. The first version aliased to snake_case and cast the row
 * to `InvitationRow`, so every camelCase field read `undefined` — and the shape
 * that failed was `invitation.consumedAt !== null`, which is `true` for
 * `undefined`. Every activation therefore reported "already consumed" and the
 * single-use control looked like it was working. A cast that renames nothing is
 * the most expensive kind of lie a type can tell.
 */
const INVITATION_COLUMNS = sql`
  id::text      as "id",
  user_id::text as "userId",
  email         as "email",
  expires_at    as "expiresAt",
  consumed_at   as "consumedAt",
  state         as "state"
`;

export async function insertInvitation(
  uow: Uow,
  options: {
    readonly userId: string;
    readonly email: string;
    readonly tokenHash: Buffer;
    readonly expiresAt: Date;
    readonly issuedByMembershipId: string | null;
  },
): Promise<InvitationRow> {
  const id = randomUUID();
  const result = await sql<InvitationRow>`
    insert into invitations (
      organization_id, id, user_id, email, token_hash, expires_at, issued_by_membership_id
    ) values (
      ${uow.context.organizationId}::uuid,
      ${id}::uuid,
      ${options.userId}::uuid,
      ${options.email},
      ${options.tokenHash},
      ${options.expiresAt},
      ${options.issuedByMembershipId}::uuid
    )
    returning ${INVITATION_COLUMNS}
  `.execute(uow.query);
  const row = result.rows[0];
  if (row === undefined) throw new Error('INVITATION_INSERT_PRODUCED_NO_ROW');
  return row;
}

export async function findInvitationByTokenHash(
  uow: Uow,
  tokenHash: Buffer,
): Promise<InvitationRow | undefined> {
  const result = await sql<InvitationRow>`
    select ${INVITATION_COLUMNS} from invitations where token_hash = ${tokenHash}
  `.execute(uow.query);
  return result.rows[0];
}

/**
 * **This statement IS the single-use mechanism.**
 *
 * `consumed_at is null and state = 'pending'` in the WHERE clause means two
 * concurrent consumers of the same token contend on the row lock, the second
 * re-evaluates the predicate after the first commits, and exactly one of them
 * sees a row. There is no second check anywhere that could disagree with it, and
 * no read-then-write window for a race to live in.
 *
 * The expiry is a bind parameter, so the clock seam reaches this decision too.
 */
export async function consumeInvitation(
  uow: Uow,
  options: { readonly invitationId: string; readonly now: Date },
): Promise<boolean> {
  const result = await sql`
    update invitations
       set consumed_at = ${options.now}, state = 'accepted', updated_at = now()
     where id = ${options.invitationId}::uuid
       and consumed_at is null
       and state = 'pending'
       and expires_at > ${options.now}
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

export async function revokeInvitation(
  uow: Uow,
  options: { readonly invitationId: string; readonly now: Date },
): Promise<boolean> {
  const result = await sql`
    update invitations
       set state = 'revoked', revoked_at = ${options.now}, updated_at = now()
     where id = ${options.invitationId}::uuid and state = 'pending'
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/**
 * CAR-027's "pending invitations reconciled".
 *
 * A pending invitation addressed to the OLD login email is re-addressed to the
 * new one. Without this, an administrator who corrects a mistyped address leaves
 * a live token pointing at the wrong mailbox — which is the mistyped-invitation
 * case CAR-027 exists to make correctable in the first place.
 */
export async function reconcileInvitationsForUser(
  uow: Uow,
  options: { readonly userId: string; readonly email: string },
): Promise<number> {
  const result = await sql`
    update invitations
       set email = ${options.email}, updated_at = now()
     where user_id = ${options.userId}::uuid
       and state = 'pending'
       and lower(email) <> lower(${options.email})
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n);
}

/* ────────────────────────────────────────────────────────────────────────────
 * password reset — a SEPARATE table and a SEPARATE hash namespace
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PasswordResetRow {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly state: 'pending' | 'consumed' | 'expired' | 'revoked';
}

export async function insertPasswordReset(
  uow: Uow,
  options: {
    readonly userId: string;
    readonly tokenHash: Buffer;
    readonly expiresAt: Date;
  },
): Promise<PasswordResetRow> {
  const id = randomUUID();
  const result = await sql<PasswordResetRow>`
    insert into password_reset_tokens (organization_id, id, user_id, token_hash, expires_at)
    values (
      ${uow.context.organizationId}::uuid,
      ${id}::uuid,
      ${options.userId}::uuid,
      ${options.tokenHash},
      ${options.expiresAt}
    )
    returning id::text as "id", user_id::text as "userId",
              expires_at as "expiresAt", consumed_at as "consumedAt", state as "state"
  `.execute(uow.query);
  const row = result.rows[0];
  if (row === undefined) throw new Error('PASSWORD_RESET_INSERT_PRODUCED_NO_ROW');
  return row;
}

export async function findPasswordResetByTokenHash(
  uow: Uow,
  tokenHash: Buffer,
): Promise<PasswordResetRow | undefined> {
  const result = await sql<PasswordResetRow>`
    select id::text as "id", user_id::text as "userId",
           expires_at as "expiresAt", consumed_at as "consumedAt", state as "state"
      from password_reset_tokens where token_hash = ${tokenHash}
  `.execute(uow.query);
  return result.rows[0];
}

/** The same conditional-UPDATE atom as `consumeInvitation`, in its own namespace. */
export async function consumePasswordReset(
  uow: Uow,
  options: { readonly tokenId: string; readonly now: Date },
): Promise<boolean> {
  const result = await sql`
    update password_reset_tokens
       set consumed_at = ${options.now}, state = 'consumed', updated_at = now()
     where id = ${options.tokenId}::uuid
       and consumed_at is null
       and state = 'pending'
       and expires_at > ${options.now}
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/** Outstanding reset tokens die when the password changes by any other route. */
export async function revokeOutstandingPasswordResets(
  uow: Uow,
  options: { readonly userId: string; readonly now: Date },
): Promise<number> {
  const result = await sql`
    update password_reset_tokens
       set state = 'revoked', revoked_at = ${options.now}, updated_at = now()
     where user_id = ${options.userId}::uuid and state = 'pending'
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n);
}

/* ────────────────────────────────────────────────────────────────────────────
 * user_mfa
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MfaRow {
  readonly id: string;
  readonly userId: string;
  readonly secretCiphertext: Buffer;
  readonly secretNonce: Buffer;
  readonly secretTag: Buffer;
  readonly keyVersion: number;
  readonly algorithm: 'SHA1' | 'SHA256';
  readonly digits: number;
  readonly periodSeconds: number;
  readonly state: 'provisioned' | 'active';
  readonly lastAcceptedTimeStep: string | null;
  readonly recoveryCodes: readonly { h: string; c: string | null }[];
}

interface MfaDbRow {
  id: string;
  user_id: string;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  key_version: number;
  algorithm: 'SHA1' | 'SHA256';
  digits: number;
  period_seconds: number;
  state: 'provisioned' | 'active';
  last_accepted_time_step: string | null;
  recovery_codes: { h: string; c: string | null }[];
}

const MFA_COLUMNS = sql`
  id::text                      as id,
  user_id::text                 as user_id,
  secret_ciphertext             as secret_ciphertext,
  secret_nonce                  as secret_nonce,
  secret_tag                    as secret_tag,
  key_version                   as key_version,
  algorithm                     as algorithm,
  digits                        as digits,
  period_seconds                as period_seconds,
  state                         as state,
  last_accepted_time_step::text as last_accepted_time_step,
  recovery_codes                as recovery_codes
`;

function toMfa(row: MfaDbRow): MfaRow {
  return {
    id: row.id,
    userId: row.user_id,
    secretCiphertext: row.secret_ciphertext,
    secretNonce: row.secret_nonce,
    secretTag: row.secret_tag,
    keyVersion: row.key_version,
    algorithm: row.algorithm,
    digits: row.digits,
    periodSeconds: row.period_seconds,
    state: row.state,
    lastAcceptedTimeStep: row.last_accepted_time_step,
    recoveryCodes: row.recovery_codes,
  };
}

export async function findMfaForUser(uow: Uow, userId: string): Promise<MfaRow | undefined> {
  const result = await sql<MfaDbRow>`
    select ${MFA_COLUMNS} from user_mfa where user_id = ${userId}::uuid
  `.execute(uow.query);
  const row = result.rows[0];
  return row === undefined ? undefined : toMfa(row);
}

/**
 * Provisions (or re-provisions) an enrolment in the `provisioned` state.
 *
 * `on conflict … do update` rather than delete-then-insert: re-scanning the QR
 * code before confirming is an ordinary thing to do, and a delete would drop the
 * unique row two concurrent enrolment starts are contending for. Re-provisioning
 * resets `state`, `enrolled_at` and the accepted step, because the new secret has
 * no history — and `last_accepted_time_step` is set to NULL rather than left,
 * which the monotonic trigger permits precisely because a NULL old value means
 * "no step has been accepted for THIS secret".
 */
export async function upsertMfaProvisioning(
  uow: Uow,
  options: {
    readonly userId: string;
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    readonly tag: Buffer;
    readonly keyVersion: number;
    readonly algorithm: 'SHA1' | 'SHA256';
    readonly digits: number;
    readonly periodSeconds: number;
  },
): Promise<MfaRow> {
  const id = randomUUID();
  const result = await sql<MfaDbRow>`
    insert into user_mfa (
      organization_id, id, user_id, secret_ciphertext, secret_nonce, secret_tag,
      key_version, algorithm, digits, period_seconds
    ) values (
      ${uow.context.organizationId}::uuid,
      ${id}::uuid,
      ${options.userId}::uuid,
      ${options.ciphertext},
      ${options.nonce},
      ${options.tag},
      ${options.keyVersion},
      ${options.algorithm},
      ${options.digits},
      ${options.periodSeconds}
    )
    on conflict (organization_id, user_id) do update
       set secret_ciphertext = excluded.secret_ciphertext,
           secret_nonce = excluded.secret_nonce,
           secret_tag = excluded.secret_tag,
           key_version = excluded.key_version,
           algorithm = excluded.algorithm,
           digits = excluded.digits,
           period_seconds = excluded.period_seconds,
           state = 'provisioned',
           enrolled_at = null,
           last_accepted_time_step = null,
           recovery_codes = '[]'::jsonb,
           updated_at = now()
    returning ${MFA_COLUMNS}
  `.execute(uow.query);
  const row = result.rows[0];
  if (row === undefined) throw new Error('MFA_UPSERT_PRODUCED_NO_ROW');
  return toMfa(row);
}

/**
 * Confirms an enrolment with the step that confirmed it.
 *
 * Conditional on `state = 'provisioned'`, so a replayed confirmation writes
 * nothing, and on the step being new, so the trigger's rule is also the
 * statement's rule.
 */
export async function confirmMfaEnrolment(
  uow: Uow,
  options: {
    readonly mfaId: string;
    readonly timeStep: number;
    readonly now: Date;
    readonly recoveryCodeHashes: readonly string[];
  },
): Promise<boolean> {
  const codes = options.recoveryCodeHashes.map((h) => ({ h, c: null }));
  const result = await sql`
    update user_mfa
       set state = 'active',
           enrolled_at = ${options.now},
           last_accepted_time_step = ${options.timeStep},
           recovery_codes = ${JSON.stringify(codes)}::jsonb,
           updated_at = now()
     where id = ${options.mfaId}::uuid and state = 'provisioned'
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/**
 * Accepts a time step, exactly once.
 *
 * `last_accepted_time_step < $step` in the WHERE clause makes the replay check
 * part of the statement rather than a decision taken from a row read earlier.
 * Two concurrent challenges presenting the same code contend on the row lock and
 * exactly one updates; the loser sees zero rows and is refused. The trigger
 * refuses it a second time, for a caller that reaches the table another way.
 */
export async function acceptMfaTimeStep(
  uow: Uow,
  options: { readonly mfaId: string; readonly timeStep: number },
): Promise<boolean> {
  const result = await sql`
    update user_mfa
       set last_accepted_time_step = ${options.timeStep}, updated_at = now()
     where id = ${options.mfaId}::uuid
       and state = 'active'
       and (last_accepted_time_step is null or last_accepted_time_step < ${options.timeStep})
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/**
 * Consumes one recovery code, atomically, by its position.
 *
 * `jsonb_set` on the element at `index`, guarded by that element still being
 * unconsumed. Two concurrent presentations of the same code contend on the row
 * and exactly one succeeds.
 */
export async function consumeRecoveryCode(
  uow: Uow,
  options: { readonly mfaId: string; readonly index: number; readonly now: Date },
): Promise<boolean> {
  const result = await sql`
    update user_mfa
       set recovery_codes = jsonb_set(
             recovery_codes,
             array[${String(options.index)}, 'c'],
             to_jsonb(${options.now.toISOString()}::text)
           ),
           updated_at = now()
     where id = ${options.mfaId}::uuid
       and recovery_codes -> ${options.index} ->> 'c' is null
  `.execute(uow.query);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/**
 * SPEC-11 X-12: the enrolment is REMOVED, secret and all.
 *
 * A `state = 'reset'` row would keep a decryptable secret in the table after the
 * event whose whole purpose is to invalidate it. The audit chain retains the
 * history; the row does not need to.
 *
 * **No runtime role holds DELETE on any tenant table** and 0007 does not change
 * that, so the statement runs inside `app_reset_user_mfa`, a SECURITY DEFINER
 * function whose whole body is that one DELETE — and which, being owner-run
 * against a FORCE-RLS table, still cannot reach a user outside the caller's
 * tenant context. The caller is capability-gated on `identity.reset_mfa` in the
 * same unit of work.
 */
export async function deleteMfaEnrolment(uow: Uow, userId: string): Promise<boolean> {
  const result = await sql<{ removed: number }>`
    select app_reset_user_mfa(${userId}::uuid) as removed
  `.execute(uow.query);
  return (result.rows[0]?.removed ?? 0) === 1;
}
