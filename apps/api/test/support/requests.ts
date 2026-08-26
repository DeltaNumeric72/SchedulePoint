import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

/**
 * Seeding for the request aggregate and the vacation carriers (OPUS-M5-000b;
 * SPEC-08 §1, §2, §5; migrations 0021 and 0022).
 *
 * ## Why this file exists
 *
 * The two migrations register ten tables in `TENANT_TABLES`, which raises the
 * SBX-004 sweep floor from 54 to 64 — and the sweep's own non-vacuity check
 * **fails a registered table that is never seen with a visible row**. A probe
 * over an empty table reports "zero cross-tenant rows" for the most boring
 * possible reason, and that vacuous pass is exactly what the check exists to
 * refuse. So every one of the ten gets a row, in more than one group, before the
 * sweep runs.
 *
 * Same arrangement as `seedRulesForSweep`, `seedLocationsForSweep`,
 * `seedSolverSnapshotsForSweep` and `seedBuildLifecycleForSweep`: seeded HERE
 * rather than in `provisionMulti`, because `test/support/multi.ts` is the single
 * fixture owner, and invoked BY the calling test file against an
 * already-provisioned fixture.
 *
 * ## The honest difference from the four helpers it copies
 *
 * Each of those drives a production SERVICE. This one cannot, and saying why
 * matters more than the shortcut: **doc 42 §5b ships no service.** The request
 * and vacation transactions are M5-001 through M5-004, and the whole point of
 * the packet is that the schema and its enforcement land BEFORE any of them, so
 * that those transactions are written against constraints that are already
 * proven rather than constraints shaped by the first writer's convenience.
 *
 * So this seed writes through the unit of work and the typed query builder,
 * under transaction-local tenant context (`set_config(name, value, true)` — the
 * only permitted spelling, I-15/S-03b), meeting every constraint and trigger the
 * migrations declare: the deferred D-18 subtype-row guard, D-19's required
 * fields, D-20's per-subtype status domain, the `allow_request` trigger, the
 * week-in-period trigger, and D-27's mapping. That is the production DATA path
 * without a production CALLER.
 *
 * **When M5-001's service lands, this helper should be rewritten onto it**, for
 * the reason the other four give in their own words: a row a fixture can write
 * directly is a row the application could forge.
 *
 * ## Synthetic only
 *
 * No organization, site or person name from the research appears here. Labels
 * are the fixture's own (`alpha_one`, `beta_one`, …) and every date is a
 * far-future synthetic one.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * The seam the seeding needs
 * ──────────────────────────────────────────────────────────────────────────── */

interface SeedRunner {
  run<T>(
    context: {
      organizationId: string;
      groupId: string | null;
      membershipId: string | null;
      correlationId: string;
    },
    body: (uow: { query: unknown }) => Promise<T>,
  ): Promise<T>;
}

export interface RequestSeedTarget {
  readonly organizationId: string;
  readonly groupId: string;
  /** A membership in that group. It is the REQUESTER as well as the context. */
  readonly membershipId: string;
  /** Distinguishes this target's idempotency keys and dates from the others'. */
  readonly label: string;
  /**
   * The Monday the synthetic vacation period starts on. Distinct per target, so
   * two targets in the same group could not collide on
   * `vacation_periods_start_unique_in_group`.
   */
  readonly periodStart: string;
}

/** What one target's seeding actually managed to write. */
export interface RequestSeedOutcome {
  readonly label: string;
  /** Root rows written — five, or six where a shift group admits requests. */
  readonly requests: number;
  /** `true` when this group had a shift type, so a shift preference was written. */
  readonly shiftPreference: boolean;
  /**
   * `true` when this group had a shift group with `allow_request = true`, so a
   * shift-group-off request was written.
   *
   * The fixture's sibling bundle is deliberately `allow_request = false`
   * (`test/support/multi.ts`), so this is `false` there — and that is not a gap
   * to paper over: it means the `allow_request` trigger has a real negative case
   * standing in the fixture rather than only in a test that constructs one.
   */
  readonly shiftGroupOff: boolean;
}

/** `YYYY-MM-DD` for `base` plus `days`, without going through a local timezone. */
function plusDays(base: string, days: number): string {
  const at = new Date(`${base}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Writes one row into each of the ten tables, per target.
 *
 * Returns one outcome per target rather than a bare count, because two of the
 * ten rows are conditional on what the catalogue fixture seeded into that group
 * and a caller asserting non-vacuity should be able to see WHICH.
 *
 * Idempotent: a target that has already been seeded is skipped whole. The
 * detection is a `requests` row carrying this target's key prefix, which is the
 * first thing written and the last thing that could survive a partial run —
 * there are no partial runs, because the whole target is one unit of work.
 */
export async function seedRequestsForSweep(
  runner: SeedRunner,
  targets: readonly RequestSeedTarget[],
): Promise<readonly RequestSeedOutcome[]> {
  const outcomes: RequestSeedOutcome[] = [];

  for (const target of targets) {
    const keyPrefix = `sweep.${target.label}`;

    const outcome = await runner.run(
      {
        organizationId: target.organizationId,
        groupId: target.groupId,
        membershipId: target.membershipId,
        correlationId: `seed-requests-${target.label}`,
      },
      async (uow) => {
        const db = uow.query as never;

        const already = await sql<{ n: string }>`
          select count(*)::text as n from requests
           where membership_id = ${target.membershipId}::uuid
             and idempotency_key like ${`${keyPrefix}.%`}
        `.execute(db);
        if (Number(already.rows[0]?.n ?? '0') > 0) {
          return { label: target.label, requests: 0, shiftPreference: false, shiftGroupOff: false };
        }

        /* What this group actually has. Only Alpha's groups get a catalogue
         * (`seed: { catalogue: ['alpha'] }` at every sweeping call site), and
         * only Alpha Group One's bundle admits off requests — so both lookups
         * are questions, not assumptions. */
        const shiftType = await sql<{ id: string }>`
          select id from shift_types
           where organization_id = ${target.organizationId}::uuid
             and group_id = ${target.groupId}::uuid
           order by id
           limit 1
        `.execute(db);
        const shiftTypeId = shiftType.rows[0]?.id ?? null;

        const shiftGroup = await sql<{ id: string }>`
          select id from shift_groups
           where organization_id = ${target.organizationId}::uuid
             and group_id = ${target.groupId}::uuid
             and allow_request
           order by id
           limit 1
        `.execute(db);
        const shiftGroupId = shiftGroup.rows[0]?.id ?? null;

        /* One root plus its one subtype row, in this transaction — which is what
         * D-18's DEFERRED zero-row guard requires and, equally, what it permits:
         * the root necessarily exists before the row referencing it, and the
         * guard is evaluated at COMMIT, when the pair is complete. */
        /**
         * A root at the requested status, reached the way a writer must reach it.
         *
         * **OPUS-M5-001: the row is INSERTed at its subtype's initial status and
         * then WALKED to the target along §2's legal edges.** Migration 0023's
         * `requests_guard_initial_status` refuses an insert at anything else —
         * `draft` for the five non-vacation subtypes, `submitted` for
         * `vacation-selection` — because submission is a TRANSITION, never an
         * insert state (doc 42 §5c Part A).
         *
         * This seed previously inserted directly at `submitted` and
         * `accepted_as_input`. Walking instead is not a workaround: it makes the
         * fixture exercise the transition guard rather than sidestep it, so a
         * seeded row is now a row a production writer could actually have
         * produced — which is what a fixture is FOR.
         */
        const writeRoot = async (
          subtype: string,
          status: string,
          suffix: string,
        ): Promise<string> => {
          const id = randomUUID();
          const initial = subtype === 'vacation-selection' ? 'submitted' : 'draft';
          await sql`
            insert into requests
              (id, organization_id, group_id, membership_id, subtype, status,
               expires_at, idempotency_key)
            values
              (${id}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
               ${target.membershipId}::uuid, ${subtype}, ${initial},
               ${'2099-01-01T00:00:00.000Z'}::timestamptz, ${`${keyPrefix}.${suffix}`})
          `.execute(db);

          /* The walk. `draft → submitted` for every subtype, then
           * `submitted → accepted_as_input` where §2 carries it. Each step is a
           * separate statement because each is a separate EDGE, and the guard
           * evaluates one edge at a time. */
          if (status !== initial) {
            await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(db);
          }
          if (status !== initial && status !== 'submitted') {
            await sql`update requests set status = ${status} where id = ${id}::uuid`.execute(db);
          }
          return id;
        };

        const day = (offset: number): string => plusDays(target.periodStart, offset);

        /* ── the five non-vacation subtypes ──────────────────────────────── */

        const availabilityId = await writeRoot('availability', 'submitted', 'availability');
        await sql`
          insert into request_availability (request_id, organization_id, group_id, target_date)
          values (${availabilityId}::uuid, ${target.organizationId}::uuid,
                  ${target.groupId}::uuid, ${day(0)}::date)
        `.execute(db);

        /* The RANGE shape of D-19's exactly-one-of, deliberately — the single
         * `target_date` shape is already covered by the four rows around it, and
         * a fixture that only ever exercised one of the two admissible shapes
         * would leave the other untested by everything downstream. */
        const timeOffId = await writeRoot('time-off', 'submitted', 'time-off');
        await sql`
          insert into request_time_off
            (request_id, organization_id, group_id, range_start, range_end)
          values (${timeOffId}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
                  ${day(1)}::date, ${day(3)}::date)
        `.execute(db);

        const noCallId = await writeRoot('no-call', 'submitted', 'no-call');
        await sql`
          insert into request_no_call (request_id, organization_id, group_id, target_date)
          values (${noCallId}::uuid, ${target.organizationId}::uuid,
                  ${target.groupId}::uuid, ${day(2)}::date)
        `.execute(db);

        if (shiftTypeId !== null) {
          /* `accepted_as_input`, not `submitted`: a shift preference is never
           * approved, so `submitted → accepted_as_input` is where it actually
           * goes (§2.1, and V-31's reason for adding the withdrawal edge). */
          const preferenceId = await writeRoot(
            'shift-preference',
            'accepted_as_input',
            'shift-preference',
          );
          await sql`
            insert into request_shift_preference
              (request_id, organization_id, group_id, target_date, shift_type_id,
               preference_strength)
            values (${preferenceId}::uuid, ${target.organizationId}::uuid,
                    ${target.groupId}::uuid, ${day(3)}::date, ${shiftTypeId}::uuid, ${'medium'})
          `.execute(db);
        }

        if (shiftGroupId !== null) {
          const groupOffId = await writeRoot('shift-group-off', 'submitted', 'shift-group-off');
          await sql`
            insert into request_shift_group_off
              (request_id, organization_id, group_id, target_date, shift_group_id)
            values (${groupOffId}::uuid, ${target.organizationId}::uuid,
                    ${target.groupId}::uuid, ${day(4)}::date, ${shiftGroupId}::uuid)
          `.execute(db);
        }

        /* ── the vacation carriers, and the sixth subtype ─────────────────── */

        /* A TWO-week round: Monday of week one to Friday of week two, which is
         * `+11` days and still a Friday, as `vacation_periods_ends_friday`
         * requires. One week would be `+4` — and the first version of this seed
         * used it, which the week-in-period trigger promptly refused when the
         * second selection asked for `periodStart + 7`. Recorded rather than
         * quietly corrected: a fixture that had happened to fit would have left
         * that trigger untested by everything downstream of it. */
        const periodId = randomUUID();
        await sql`
          insert into vacation_periods
            (id, organization_id, group_id, start_date, end_date, mode, state)
          values (${periodId}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
                  ${target.periodStart}::date, ${plusDays(target.periodStart, 11)}::date,
                  ${'quota'}, ${'open'})
        `.execute(db);

        const grantId = randomUUID();
        await sql`
          insert into vacation_grants
            (id, organization_id, group_id, vacation_period_id, kind, membership_id,
             units_total, units_consumed)
          values (${grantId}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
                  ${periodId}::uuid, ${'personal-entitlement'}, ${target.membershipId}::uuid,
                  ${2}, ${1})
        `.execute(db);

        /* TWO selections, and the pair is the point.
         *
         * The first is `available` with a NULL `request_id` — §5.3's "no request
         * row yet", the one state that has no root. It stands in the fixture so
         * every sweep and every downstream reader meets it, rather than only the
         * test that constructs it.
         *
         * The second is `pending` with a root, which is D-27's mapping holding:
         * `pending` derives `submitted`, and both deferred triggers check it at
         * commit. Different weeks, so D-22 is satisfied. */
        const availableSelectionId = randomUUID();
        await sql`
          insert into vacation_selections
            (id, organization_id, group_id, request_id, membership_id,
             vacation_period_id, week_start, status)
          values (${availableSelectionId}::uuid, ${target.organizationId}::uuid,
                  ${target.groupId}::uuid, null, ${target.membershipId}::uuid,
                  ${periodId}::uuid, ${target.periodStart}::date, ${'available'})
        `.execute(db);

        const vacationRootId = await writeRoot('vacation-selection', 'submitted', 'vacation');
        const pendingSelectionId = randomUUID();
        await sql`
          insert into vacation_selections
            (id, organization_id, group_id, request_id, membership_id,
             vacation_period_id, week_start, status)
          values (${pendingSelectionId}::uuid, ${target.organizationId}::uuid,
                  ${target.groupId}::uuid, ${vacationRootId}::uuid, ${target.membershipId}::uuid,
                  ${periodId}::uuid, ${plusDays(target.periodStart, 7)}::date, ${'pending'})
        `.execute(db);

        /* D-26's ledger. Written for the pending selection, which is the only one
         * an approval command could ever name. */
        await sql`
          insert into vacation_approval_commands
            (id, organization_id, group_id, selection_id, approval_idempotency_key, outcome)
          values (${randomUUID()}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
                  ${pendingSelectionId}::uuid, ${`${keyPrefix}.approve`}, null)
        `.execute(db);

        return {
          label: target.label,
          requests: 4 + (shiftTypeId === null ? 0 : 1) + (shiftGroupId === null ? 0 : 1),
          shiftPreference: shiftTypeId !== null,
          shiftGroupOff: shiftGroupId !== null,
        };
      },
    );

    outcomes.push(outcome);
  }

  return outcomes;
}

/**
 * The vacation period a target's seeding used, for a caller that needs to reach
 * it. A lookup rather than a returned id, because the seed is idempotent and a
 * re-run returns no ids at all.
 */
export async function seededVacationPeriodId(
  runner: SeedRunner,
  target: RequestSeedTarget,
): Promise<string | null> {
  return runner.run(
    {
      organizationId: target.organizationId,
      groupId: target.groupId,
      membershipId: target.membershipId,
      correlationId: `seed-requests-lookup-${target.label}`,
    },
    async (uow) => {
      const rows = await sql<{ id: string }>`
        select id from vacation_periods
         where organization_id = ${target.organizationId}::uuid
           and group_id = ${target.groupId}::uuid
           and start_date = ${target.periodStart}::date
      `.execute(uow.query as never);
      return rows.rows[0]?.id ?? null;
    },
  );
}
