import { createHash } from 'node:crypto';

/**
 * A minimal, deterministic, version-scoped rendering — and NOT a product feature.
 *
 * ## Why this exists at all
 *
 * SPEC-05 §8's V-02 and V-09 require that a report and a calendar feed
 * regenerated from a historical `version_id` are **byte-identical** to the ones
 * captured before two later publications. That proof needs *something* to
 * render. Packet 32 §5 pre-ruled this case: "a minimal deterministic
 * version-scoped rendering (not a product feature) is in scope solely to satisfy
 * byte-identity".
 *
 * So the scope is deliberately the minimum that makes the proof real:
 *
 *  - it binds an explicit `version_id` (SPEC-09's rule for reports) and prints
 *    it, so a rendering can never silently be of a different version;
 *  - it is a pure function of rows the caller read inside a unit of work;
 *  - it has **no** styling, pagination, localisation, filtering, permissions,
 *    export format, delivery, or persistence — every one of which is a product
 *    decision this packet has no authority to make. The real report and calendar
 *    surfaces are SPEC-09 and M3-005/006.
 *
 * ## Determinism is the whole point, so it is engineered, not hoped for
 *
 * A byte-identity proof over a non-deterministic renderer proves nothing. Three
 * hazards are closed explicitly:
 *
 *  - **Ordering:** rows are sorted by a total, tie-free key. A database returns
 *    rows in whatever order it likes; two runs must not differ because a plan
 *    changed.
 *  - **Time zone and locale:** instants are printed as `toISOString()` (always
 *    UTC, always the same shape) and nothing is passed through a locale-aware
 *    formatter. A renderer that read the machine's zone would produce a
 *    different artifact on a different machine, which would make V-04/V-11 pass
 *    or fail for reasons having nothing to do with immutability.
 *  - **Ambient state:** no clock, no environment, no randomness is read here.
 *    The output is a function of the arguments and of nothing else.
 */

/**
 * Normalise a `date` column to `YYYY-MM-DD`.
 *
 * node-postgres parses `date` (OID 1082) into a **`Date`**, not a string — the
 * same measured fact `catalogue/service.ts` records. The driver builds that
 * `Date` at LOCAL midnight, so `toISOString()` west of UTC would render the
 * PREVIOUS day: a rendering that used it would differ between two machines, and
 * a byte-identity proof over a renderer that varies by machine proves nothing.
 * The local components are therefore the right ones, and they reconstruct the
 * same calendar date the database holds wherever this runs.
 */
export function calendarDate(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The fields a rendering reads. Deliberately narrow. */
export interface RenderableAssignment {
  readonly assignmentIdentityId: string;
  readonly membershipId: string;
  readonly date: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly shiftTypeId: string;
  readonly status: string;
  readonly isPinned: boolean;
}

/**
 * The total order every rendering uses.
 *
 * `assignment_identity_id` is last and is what makes the key TIE-FREE: it is
 * unique within a version (D-14), so no two rows can compare equal and no run
 * can differ from another by a stable-sort accident.
 */
function renderOrder(a: RenderableAssignment, b: RenderableAssignment): number {
  return (
    a.date.localeCompare(b.date) ||
    a.startsAt.toISOString().localeCompare(b.startsAt.toISOString()) ||
    a.shiftTypeId.localeCompare(b.shiftTypeId) ||
    a.membershipId.localeCompare(b.membershipId) ||
    a.assignmentIdentityId.localeCompare(b.assignmentIdentityId)
  );
}

function ordered(rows: readonly RenderableAssignment[]): RenderableAssignment[] {
  return [...rows].sort(renderOrder);
}

/**
 * The version-scoped report.
 *
 * The header names the `version_id` the artifact was rendered from — SPEC-05 §9:
 * "Reports bind an explicit `version_id` in the input snapshot".
 */
export function renderVersionReport(
  versionId: string,
  rows: readonly RenderableAssignment[],
): string {
  const lines = [`SCHEDULE REPORT version=${versionId}`];
  for (const row of ordered(rows)) {
    lines.push(
      [
        row.date,
        row.startsAt.toISOString(),
        row.endsAt.toISOString(),
        row.shiftTypeId,
        row.membershipId,
        row.assignmentIdentityId,
        row.status,
        row.isPinned ? 'pinned' : 'unpinned',
      ].join('\t'),
    );
  }
  // A trailing newline so the artifact is a well-formed text file and so
  // appending a row changes the bytes in exactly one place.
  return `${lines.join('\n')}\n`;
}

/**
 * The version-scoped calendar feed.
 *
 * An iCalendar-shaped rendering with **no generated timestamps** — a real
 * `DTSTAMP` would be the current time, which would make every regeneration
 * differ and quietly destroy the byte-identity proof. The identity of the event
 * is the assignment identity, which is stable across versions by construction.
 */
export function renderCalendarFeed(
  versionId: string,
  rows: readonly RenderableAssignment[],
): string {
  const stamp = (value: Date): string => value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `X-SCHEDULEPOINT-VERSION-ID:${versionId}`];
  for (const row of ordered(rows)) {
    if (row.status !== 'active') continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${row.assignmentIdentityId}`,
      `DTSTART:${stamp(row.startsAt)}`,
      `DTEND:${stamp(row.endsAt)}`,
      `X-SHIFT-TYPE:${row.shiftTypeId}`,
      `X-MEMBERSHIP:${row.membershipId}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/** Hex `sha256`. The comparison V-02/04/09/11 make. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Digest delimiters, deliberately PRINTABLE.
 *
 * These were the ASCII unit and record separators (0x1F/0x1E) — a defensible
 * choice for a digest and an indefensible one for a source file: they made this
 * module BINARY to git, so it could not be diffed or reviewed.
 */
const FIELD_SEPARATOR = '\n';
const ROW_SEPARATOR = '\n--\n';

/**
 * A stable digest of a set of database rows.
 *
 * Used to hash "every V1 row" (V-02) rather than a rendered artifact. Keys are
 * sorted within each row and rows are sorted as whole serialized strings, so the
 * digest depends on the CONTENT and not on column or row order.
 *
 * ## Every field is LENGTH-PREFIXED, and that is the security property (N-7)
 *
 * `key=value` joined by a delimiter is forgeable: several of these columns hold
 * operator free text — `override_reason`, `change_summary`, a conflict
 * `explanation` — and a reason containing the delimiter and an `=` could forge a
 * field boundary, so two genuinely different row sets could produce the SAME
 * digest. That is a byte-identity proof that can be defeated by typing, which is
 * worse than no proof: V-04, V-08 and V-11 all rest on this function.
 *
 * Length-prefixing (`<n>:<bytes>`) removes the ambiguity entirely — the reader
 * never has to find a boundary, because the length says where it is — so no
 * value, whatever it contains, can be mistaken for structure.
 */
export function digestRows(rows: readonly Readonly<Record<string, unknown>>[]): string {
  const serialized = rows
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((key) => {
          const value = row[key];
          // `'<null>'` is a PRINTABLE sentinel. This was a raw NUL, which made
          // this source file binary to git and put a NUL into the digest input
          // — the same defect OPUS-M3-001's review ruled on (raw NUL ->
          // printable).
          const printed =
            value instanceof Date
              ? value.toISOString()
              : value === null || value === undefined
                ? '<null>'
                : String(value);
          // Length-prefixed, so a value can never forge a field boundary.
          return `${key.length}:${key}=${printed.length}:${printed}`;
        })
        .join(FIELD_SEPARATOR),
    )
    .sort();
  return sha256(serialized.join(ROW_SEPARATOR));
}
