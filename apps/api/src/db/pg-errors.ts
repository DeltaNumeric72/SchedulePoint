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

/* ────────────────────────────────────────────────────────────────────────────
 * Distinguishing a tenant-shaped refusal from a defect (OPUS-M3-008, M3-007 NB-3)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a SQLSTATE means about **this process**, for the LOG only.
 *
 * ## The follow-up this closes
 *
 * `settings.route.ts` and `schedule-publication.route.ts` both end their error
 * handling with "if it is a PostgresError, answer 404" and one `warn` line. That
 * disclosure posture is correct and does not change here: a caller must not be
 * able to tell a row RLS hid from a row that does not exist, and a schema
 * description is disclosure nobody has earned.
 *
 * The problem is the other side of the line. Under that mapping a genuine
 * **defect in this process** — a malformed query (42601), a column that does not
 * exist (42703), an undefined function (42883) — is logged with the same wording
 * and the same level as an ordinary tenant miss, so it lands in the noise floor.
 * The one thing that would have made it findable, an operator noticing "this is
 * not a not-found", is exactly what the uniform handler removed.
 *
 * So the classification below is **log-side only**. Nothing about the response
 * changes: the client still gets the fixed `404` body, byte-identical either way.
 *
 * ## The classes
 *
 * `tenant-shaped` — the statement was refused by a control that is *supposed* to
 * refuse statements: RLS (42501), an integrity constraint (class 23), a bad uuid
 * from a path parameter (22P02), a lock or cancellation (55/57). A 404 is the
 * honest answer and there is nothing to investigate.
 *
 * `defect` — everything else, and in particular class 42 (syntax and access-rule
 * errors that are not privilege), class 25 (invalid transaction state — an
 * ordering bug), and class XX (internal). These mean the code is wrong. They are
 * logged at `error` with `isDefect: true` so a query for real problems does not
 * have to read every 404 in the system.
 */
export type PgFailureClass = 'tenant-shaped' | 'defect';

/** SQLSTATE classes (the first two characters) that a correct process still provokes. */
const TENANT_SHAPED_CLASSES = new Set([
  '23', // integrity constraint violation
  '22', // data exception — e.g. 22P02 from a malformed uuid in a path
  '40', // transaction rollback / serialization failure
  '55', // object not in prerequisite state (lock not available)
  '57', // operator intervention (statement cancelled, admin shutdown)
]);

/** Individual codes that are tenant-shaped despite their class. */
const TENANT_SHAPED_CODES = new Set<string>([
  PG_ERRORS.insufficientPrivilege, // 42501 — an RLS WITH CHECK rejection
]);

export function classifyPgFailure(error: unknown): PgFailureClass {
  if (!isPostgresError(error) || error.code === undefined) return 'defect';
  if (TENANT_SHAPED_CODES.has(error.code)) return 'tenant-shaped';
  return TENANT_SHAPED_CLASSES.has(error.code.slice(0, 2)) ? 'tenant-shaped' : 'defect';
}

/**
 * The log fields for a database refusal that the edge is about to answer `404`
 * for. **Never sent to a client**; the response is unchanged.
 */
export interface PgFailureLogFields {
  readonly sqlstate: string;
  readonly failureClass: PgFailureClass;
  readonly isDefect: boolean;
}

export function pgFailureLogFields(error: unknown): PgFailureLogFields {
  const failure = classifyPgFailure(error);
  return {
    sqlstate: (isPostgresError(error) ? error.code : undefined) ?? 'unknown',
    failureClass: failure,
    // The field an operator filters on. A 404 answered because of a syntax error
    // is a bug report wearing a tenant miss's clothes.
    isDefect: failure === 'defect',
  };
}
