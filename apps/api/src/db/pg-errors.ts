/**
 * Translating PostgreSQL errors at the edge.
 *
 * SPEC-01 §4 amendment (b), from the executed spike's X-11:
 *
 * > **Unique-constraint existence oracle:** PK/unique checks also bypass RLS
 * > (X-11: inserting an id that exists only in another org raises 23505,
 * > disclosing existence of an invisible row). Unique keys on tenant tables are
 * > tenant-qualified wherever a caller can choose the key value, and **23505 is
 * > translated to a generic error at the edge.**
 *
 * Both halves are needed. Tenant-qualifying the key means a collision can only
 * be reported against a row in the caller's own tenant — but `users.login_email`
 * is globally unique because it is the authentication identity and cannot be
 * qualified. For that case the translation is the whole control: the constraint
 * name, the table name, the conflicting value and the SQLSTATE never reach a
 * client, so a 23505 raised by an invisible row is indistinguishable from any
 * other rejection.
 *
 * The same reasoning covers 23503 (foreign key) and 23514 (check): each of them
 * quotes a constraint name that describes the schema, and a schema description
 * is disclosure the caller has not earned.
 */

/** The subset of `pg`'s error shape this module relies on. */
export interface PostgresErrorLike {
  readonly code?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly detail?: string;
  readonly message?: string;
}

export function isPostgresError(error: unknown): error is PostgresErrorLike {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

export const PG_ERRORS = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  exclusionViolation: '23P01',
  restrictViolation: '23001',
  /** `new row violates row-level security policy` — the fail-closed write rejection. */
  insufficientPrivilege: '42501',
  invalidTextRepresentation: '22P02',
  queryCanceled: '57014',
  adminShutdown: '57P01',
  lockNotAvailable: '55P03',
} as const;

/**
 * What the edge should emit for a database error.
 *
 * `logDetail` is server-side only. `clientCode` and `clientMessage` are the only
 * things a caller sees, and neither varies with the constraint that fired.
 */
export interface TranslatedPgError {
  readonly status: number;
  readonly clientCode: string;
  readonly clientMessage: string;
  readonly logDetail: Readonly<Record<string, unknown>>;
}

const GENERIC_CONFLICT = 'The request conflicts with the current state of the resource.';
const GENERIC_REJECTED = 'The request was rejected.';

/**
 * Translates a database error into a client-safe outcome, or `null` when the
 * error is not one this module recognises (which the caller must treat as a
 * generic 500 — never as "probably fine").
 */
export function translatePgError(error: unknown): TranslatedPgError | null {
  if (!isPostgresError(error)) return null;

  const logDetail = {
    sqlstate: error.code,
    constraint: error.constraint,
    table: error.table,
  };

  switch (error.code) {
    case PG_ERRORS.uniqueViolation:
    case PG_ERRORS.exclusionViolation:
      // Deliberately identical for both, and deliberately free of the constraint
      // name: a 23505 raised against a row in another tenant must be
      // indistinguishable from one raised against a visible row (X-11).
      return {
        status: 409,
        clientCode: 'CONFLICT',
        clientMessage: GENERIC_CONFLICT,
        logDetail,
      };

    case PG_ERRORS.foreignKeyViolation:
    case PG_ERRORS.checkViolation:
    case PG_ERRORS.restrictViolation:
      return {
        status: 422,
        clientCode: 'UNPROCESSABLE',
        clientMessage: GENERIC_REJECTED,
        logDetail,
      };

    case PG_ERRORS.insufficientPrivilege:
      // A write rejected by an RLS `WITH CHECK`. The caller learns nothing about
      // which policy or which tenant; it is a plain 404, the same answer the
      // read path gives for a row it cannot see.
      return {
        status: 404,
        clientCode: 'NOT_FOUND',
        clientMessage: 'Not found.',
        logDetail,
      };

    default:
      return null;
  }
}
