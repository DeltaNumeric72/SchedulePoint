/**
 * `YYYY-MM-DD` from whatever the driver produced — one spelling, two readers
 * (OPUS-M4-001's, extracted at OPUS-M5-004).
 *
 * node-postgres parses `date` (OID 1082) into a **`Date` at LOCAL midnight**, so
 * `toISOString()` west of UTC renders the PREVIOUS day — the same measured fact
 * `apps/api/src/schedule/render.ts` records for the same reason. The local
 * components are the right ones and reconstruct the calendar date the database
 * holds wherever this runs.
 *
 * **Its own module since OPUS-M5-004.** It was private to `canonical-input.ts`;
 * `request-projection.ts` needs the identical conversion, and importing it from
 * there would have made the two modules circular — `canonical-input` calls the
 * projection assembly. A second copy was the other option, and a second copy of
 * this function is a second west-of-UTC off-by-one waiting to happen in exactly
 * the module whose rows say when somebody is away.
 */
export function calendarText(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
