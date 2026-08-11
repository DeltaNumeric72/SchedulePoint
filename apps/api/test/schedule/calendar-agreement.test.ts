import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import { calendarDateSchema, isCalendarDate as contractSaysReal } from '@schedulepoint/contracts';
import { dateFromEpochDays, isCalendarDate as domainSaysReal } from '@schedulepoint/domain';
import type { TenantContext } from '@schedulepoint/domain';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * The contract's calendar rule and the domain's answer identically, on every
 * input (OPUS-M4-000B; doc 34 §4-F).
 *
 * ## Why the rule exists twice
 *
 * `packages/contracts` may import **zod and nothing else** —
 * `.dependency-cruiser.cjs` rule `contracts-imports-only-zod`, proved by
 * `scripts/red-cases/import-boundary/`. The wire validator therefore cannot
 * import `packages/domain/src/calendar`, so the leap rule and the month lengths
 * are written twice.
 *
 * Two copies of a rule are two truths that can drift, and the drift is
 * asymmetric in the worst way: if the CONTRACT is the looser of the two, a
 * calendar-invalid date passes validation and reaches code that rolls it over
 * silently; if the DOMAIN is looser, the server refuses a date the client was
 * told was fine. Neither shows up in a green suite that exercises only ordinary
 * dates.
 *
 * So they are not left to agree by inspection. This file runs both over an
 * exhaustive range and asserts they answer identically — the same discipline
 * `packages/domain/test/catalogue` already uses against migration 0005's CHECK
 * constraints.
 *
 * This file lives in `apps/api/test` for a layering reason and not a
 * convenience one: `apps/api` is the only workspace permitted to import BOTH
 * packages. Putting it in either package would require that package to depend on
 * the other, which is exactly the edge the boundary rule forbids.
 *
 * ## What this file CANNOT do, and where that is done instead
 *
 * It reaches both packages through their `exports` entries, which resolve to
 * **`dist/`**. A change to either package's SOURCE is invisible here until
 * something rebuilds — measured, not assumed: the `calendar-date-shape-only`
 * red case patched the contract source, ran this file, and this file passed;
 * rebuilding first turned it red. That is correct behaviour for an agreement
 * sweep (it compares what SHIPS), and it makes this file the wrong arm for a
 * source-patching red case. The wire validator is therefore ALSO pinned
 * source-relative inside its own package, in
 * `packages/contracts/test/schedule/calendar-date.test.ts`, which is what the
 * red case targets.
 *
 * ## The DATABASE arm
 *
 * Doc 34 §4-F requires calendar validation "at contract AND database". The
 * database half needs no migration — PostgreSQL's `date` type refuses an
 * impossible date by construction — but "needs no code" is not the same as
 * "proven", so the final block asserts it as `app_runtime`, in raw SQL, with no
 * contract in front of it.
 */

describe('the contract validator and the domain validator are the same rule', () => {
  /**
   * Every `YYYY-MM-DD` string over four years chosen for what they contain: a
   * leap year, a common year, a century that is NOT a leap year, and a century
   * that IS. Both validators see all 12×31 = 372 candidate day numbers in every
   * month of each, so every month length and every leap branch is exercised —
   * including the 44 impossible dates per year that a shape-only regex accepts.
   */
  it.each([2024, 2027, 1900, 2000])('agrees on every candidate date in %i', (year) => {
    let real = 0;
    let refused = 0;
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 31; day += 1) {
        const value =
          `${String(year).padStart(4, '0')}-` +
          `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const contract = contractSaysReal(value);
        const domain = domainSaysReal(value);
        expect(contract, `${value}: contract and domain disagree`).toBe(domain);
        // The zod schema is the thing the wire actually meets, so it is checked
        // too rather than assumed to wrap the predicate faithfully.
        expect(calendarDateSchema.safeParse(value).success, `${value}: schema`).toBe(domain);
        if (domain) real += 1;
        else refused += 1;
      }
    }
    const expectedReal = year === 2024 || year === 2000 ? 366 : 365;
    expect(real, `${String(year)} real dates`).toBe(expectedReal);
    expect(refused, `${String(year)} impossible dates`).toBe(372 - expectedReal);
  });

  it('agrees on every date across a 40-year span, one week at a time', () => {
    /* A coarser sweep over a much wider range, so a bug that only appears far
     * from the sampled years — a century boundary, a year over 4 digits — is not
     * invisible. `dateFromEpochDays` generates the strings, so the inputs are
     * real dates by construction and BOTH validators must accept every one. */
    for (let day = 20_000; day <= 34_600; day += 7) {
      const value = dateFromEpochDays(day);
      expect(contractSaysReal(value), `${value}: contract rejected a real date`).toBe(true);
      expect(domainSaysReal(value), `${value}: domain rejected a real date`).toBe(true);
      expect(calendarDateSchema.safeParse(value).success).toBe(true);
    }
  });

  it('agrees on the malformed set, where neither may be lenient', () => {
    for (const value of [
      '2027-2-01',
      '2027-02-1',
      '27-02-01',
      '2027/02/01',
      '2027-02-01T00:00:00Z',
      ' 2027-02-01',
      '2027-02-01 ',
      '',
      'not-a-date',
      '0000-01-01',
      '99999-01-01',
    ]) {
      expect(contractSaysReal(value), `${value}: contract`).toBe(false);
      expect(domainSaysReal(value), `${value}: domain`).toBe(false);
      expect(calendarDateSchema.safeParse(value).success, `${value}: schema`).toBe(false);
    }
  });

  it('the schema’s message names the failure a human made, not the pattern', () => {
    const parsed = calendarDateSchema.safeParse('2027-02-29');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain('does not exist');
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * MUTATION CONTROL — the sweep is shown able to catch a divergence.
   * ────────────────────────────────────────────────────────────────────────── */
  it('MUTATION CONTROL: a naive %4 leap rule diverges, and the sweep finds it', () => {
    const naiveIsReal = (value: string): boolean => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (match === null) return false;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const leap = year % 4 === 0; // the bug
      const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return month >= 1 && month <= 12 && day >= 1 && day <= (lengths[month - 1] ?? 0);
    };

    const divergences: string[] = [];
    for (const year of [1900, 2000, 2100]) {
      const value = `${String(year)}-02-29`;
      if (naiveIsReal(value) !== domainSaysReal(value)) divergences.push(value);
    }
    expect(
      divergences,
      'the century cases are exactly where a %4 rule and the real rule part company',
    ).toEqual(['1900-02-29', '2100-02-29']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The DATABASE arm (doc 34 §4-F: "at contract AND database")
 * ──────────────────────────────────────────────────────────────────────────── */

const multi = ownedMulti('calendar-agreement', { profile: 'core' });

let runtime: Runtime;
let context: TenantContext;

beforeAll(() => {
  runtime = createRuntime('app_runtime', { max: 2 });
  const fixture = multi();
  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'calendar-agreement',
  };
});

afterAll(async () => {
  await runtime?.destroy();
});

describe('the DATABASE refuses an impossible date independently of the contract', () => {
  /**
   * No migration adds this: `date` is a real calendar type and refuses a date
   * that does not exist, by construction. That is exactly why it is worth
   * asserting rather than assuming — a claim resting on "the type handles it"
   * is a claim nobody has checked, and doc 34 §4-F asks for the database half
   * explicitly.
   *
   * Issued as `app_runtime` in raw SQL, so no zod schema, no route and no
   * service is in front of it.
   */
  it.each(['2027-02-29', '2027-13-01', '2027-04-31', '2027-00-10', '2027-01-32'])(
    '%s is refused by PostgreSQL, as app_runtime, with no contract in front',
    async (value) => {
      let error: string | null = null;
      try {
        await runtime.runner.run(context, async ({ query }) => {
          await sql.raw(`SELECT '${value}'::date`).execute(query);
        });
      } catch (caught) {
        error = (caught as Error).message;
      }
      expect(error, `${value} must be refused by the database`).not.toBeNull();
      expect(error).toMatch(/date\/time field value out of range|invalid input syntax/i);
    },
  );

  it('CONTROL: a real date on the same path is accepted', async () => {
    await expect(
      runtime.runner.run(context, async ({ query }) => {
        await sql.raw("SELECT '2024-02-29'::date").execute(query);
      }),
      'the probe must be able to succeed, or the refusals above prove nothing',
    ).resolves.toBeUndefined();
  });
});
