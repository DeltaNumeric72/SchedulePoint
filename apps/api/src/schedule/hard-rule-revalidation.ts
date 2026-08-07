import {
  compileRule,
  evaluateHardRules,
  isEligibleAt,
  type CheckedAssignment,
  type CheckedVersion,
  type CompiledRule,
  type HardRuleFinding,
  type Rule,
  type UnitOfWork,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { loadHoldings, type HoldingRow } from '../profiles/in-force-loader.js';
import { rowToRule } from '../rules/service.js';
import { calendarDate } from './render.js';
import { SchedulePreconditionError } from './errors.js';

/**
 * SPEC-05 §6 **step 06** — "assert every HARD rule re-validated" (OPUS-M3-008).
 *
 * ## The join this packet exists to make, and the one it still refuses
 *
 * M3-003 left step 06 unimplemented **on purpose**: the typed rule model was
 * being written in a parallel packet, and packet 32 §6 forbade the rules ×
 * publication join outside the integration packet. This is that packet, and this
 * file is that join — the only place in the system where a compiled rule and a
 * schedule version's content meet.
 *
 * What it is **not** is a solver. `evaluateHardRules` is a bounded, deterministic
 * pass: for each active HARD rule, one walk over the assignments that already
 * exist. There is no search, no objective, no relaxation, and nothing that
 * produces an assignment. That is M4 and it is prohibited (non-bypass rule 7).
 * SPEC-04 §3.3 names this component separately from the solver for exactly this
 * reason — "an **independent checker**" — and building it before the solver is
 * what makes the solver's output checkable rather than trusted.
 *
 * ## Why the evaluation is pure and the loading is here
 *
 * Every decision lives in `@schedulepoint/domain`'s `hard-rule-check.ts`, which
 * has no database and no clock. This module does the reading: the group's active
 * HARD rules, the version's active snapshots with their shift-type codes, the
 * group's shift-type and membership vocabulary, and the credential holdings of
 * the memberships that actually appear in the version.
 *
 * ## Holdings come through the ONE loader
 *
 * `apps/api/test/profiles/loader-is-the-only-selector.test.ts` fails the build if
 * any module but `profiles/in-force-loader.ts` names `qualification_holdings` in
 * a query, and `isEligibleAt` is the shipped window-and-status rule. Both are
 * used here rather than re-spelled — the S-01 lesson: a second selection rule is
 * a second answer waiting to disagree.
 *
 * ## One instant per date, decided once
 *
 * "Eligibility is evaluated at the shift date, not at the build date" (CAP-058;
 * the AST pins `RequiresQualification.validAt = 'shift_date'`). A holding that
 * expires mid-period therefore blocks **exactly** the assignments dated after its
 * expiry and no others. The instant used for a date is the same for every
 * membership and every rule in one publication, computed once in
 * {@link instantOfDate}, so two rows in one transaction can never be judged
 * against two clock readings.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/**
 * A calendar date, as the instant eligibility is evaluated at.
 *
 * **Midday UTC, not midnight**, and the reason is the whole point of the
 * deliverable. A holding whose `valid_until` is `2027-03-15T00:00:00Z` is
 * honoured on the 14th and not on the 15th under either convention; but a
 * holding recorded as expiring "on the 15th" with an end-of-day instant would be
 * judged *not held* at midnight-of-the-15th under a midnight convention, moving
 * the boundary by a day for every credential in the system. Midday is the
 * instant no timezone offset in use (UTC−12..UTC+14) can move across a date
 * boundary in either direction, so "the shift date" resolves to the same
 * calendar day whatever the group's timezone is.
 *
 * It is a deliberate, recorded convention, not an accident of `new Date(date)`.
 */
export function instantOfDate(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

interface HardRuleRow {
  id: string;
  rule_key: string;
  name: string;
  rule_schema_version: number;
  classification: 'HARD' | 'SOFT';
  weight: string | null;
  category: 'general' | 'pattern' | 'staff';
  scope: unknown;
  predicate: unknown;
  status: 'active' | 'disabled' | 'archived';
}

/** The group's ACTIVE HARD rules, compiled. Disabled and archived are excluded. */
export async function loadActiveHardRules(uow: Uow): Promise<readonly CompiledRule[]> {
  const rows = (await uow.query
    .selectFrom('rules')
    .select([
      'id',
      'rule_key',
      'name',
      'rule_schema_version',
      'classification',
      'weight',
      'category',
      'scope',
      'predicate',
      'status',
    ])
    /* `status = 'active'` is what disabling a rule MEANS (rules/service.ts
     * `compileActiveRules` says the same): the rule stays authored, and no build
     * — and no publication check — consumes it. That is the falsifiability lever
     * the red case pulls. */
    .where('status', '=', 'active')
    .where('classification', '=', 'HARD')
    .orderBy('rule_key')
    .execute()) as unknown as HardRuleRow[];

  return rows.map((row) => compileRule(rowToRule(row) as Rule));
}

interface SnapshotRow {
  id: string;
  assignment_identity_id: string;
  membership_id: string;
  date: string | Date;
  starts_at: Date;
  ends_at: Date;
  shift_type_code: string;
  is_on_call: boolean;
}

/**
 * Assemble everything the pure checker needs for one version.
 *
 * Reads are confined to the caller's unit of work, so RLS scopes every one of
 * them to the acting tenant; nothing here takes an organization or group id from
 * an argument.
 */
export async function loadCheckedVersion(uow: Uow, versionId: string): Promise<CheckedVersion> {
  const snapshots = (await uow.query
    .selectFrom('assignment_snapshots as s')
    .innerJoin('shifts as sh', (join) =>
      join
        .onRef('sh.id', '=', 's.shift_id')
        .onRef('sh.organization_id', '=', 's.organization_id')
        .onRef('sh.group_id', '=', 's.group_id'),
    )
    .innerJoin('shift_types as st', (join) =>
      join
        .onRef('st.id', '=', 'sh.shift_type_id')
        .onRef('st.organization_id', '=', 'sh.organization_id')
        .onRef('st.group_id', '=', 'sh.group_id'),
    )
    .where('s.version_id', '=', versionId)
    .where('s.status', '=', 'active')
    .select([
      's.id as id',
      's.assignment_identity_id as assignment_identity_id',
      's.membership_id as membership_id',
      's.date as date',
      's.starts_at as starts_at',
      's.ends_at as ends_at',
      'st.code as shift_type_code',
      // B-2: the one attribute that says a shift IS a call. The join was already
      // here; only the column was missing, which is what made `CallSpacing` look
      // unevaluable when it was not.
      'st.is_on_call as is_on_call',
    ])
    // Qualified, for the reason `src/audit/verification.ts` gives at length: an
    // unqualified ORDER BY resolves to an output column when one carries the name.
    .orderBy('s.starts_at')
    .orderBy('s.id')
    .execute()) as unknown as SnapshotRow[];

  const assignments: CheckedAssignment[] = snapshots.map((row) => ({
    snapshotId: row.id,
    assignmentIdentityId: row.assignment_identity_id,
    membershipId: row.membership_id,
    date: calendarDate(row.date),
    startsAtMs: row.starts_at.getTime(),
    endsAtMs: row.ends_at.getTime(),
    shiftTypeCode: row.shift_type_code,
    isOnCall: row.is_on_call,
  }));

  const shiftTypes = await uow.query.selectFrom('shift_types').select('code').execute();
  const memberships = await uow.query.selectFrom('memberships').select('id').execute();
  const qualifications = (await uow.query
    .selectFrom('qualifications')
    .select(['id', 'key'])
    .execute()) as unknown as { id: string; key: string }[];

  const keyById = new Map(qualifications.map((row) => [row.id, row.key]));

  /* Holdings for the memberships that actually APPEAR in this version — not for
   * the whole group. A publication reads what it is about to publish. */
  const holdingsByMembership = new Map<string, readonly HoldingRow[]>();
  for (const membershipId of new Set(assignments.map((assignment) => assignment.membershipId))) {
    holdingsByMembership.set(
      membershipId,
      await loadHoldings(uow.query, {
        organizationId: uow.context.organizationId,
        membershipId,
      }),
    );
  }

  return {
    assignments,
    knownShiftTypeCodes: new Set(shiftTypes.map((row) => row.code)),
    knownMembershipIds: new Set(memberships.map((row) => row.id)),
    qualifications: {
      knownQualificationKeys: new Set(keyById.values()),
      heldOn(membershipId, qualificationKey, date) {
        const held = holdingsByMembership.get(membershipId) ?? [];
        const forKey = held.filter(
          (holding) => keyById.get(holding.qualificationId) === qualificationKey,
        );
        return isEligibleAt(forKey, instantOfDate(date));
      },
    },
  };
}

/** Every step-06 finding for a version, in the checker's deterministic order. */
export async function findHardRuleFindings(
  uow: Uow,
  versionId: string,
): Promise<readonly HardRuleFinding[]> {
  const compiled = await loadActiveHardRules(uow);
  // Nothing to check is not a reason to read the version's content.
  if (compiled.length === 0) return [];
  return evaluateHardRules(compiled, await loadCheckedVersion(uow, versionId));
}

/**
 * The step-06 refusal.
 *
 * A `SchedulePreconditionError` subclass, so the publication route's existing
 * `CONFLICT_CODES` mapping and its "map outside the unit of work so a failure
 * ROLLS BACK" discipline both apply unchanged — including the property M3-005's
 * self-found defect established: a refusal at step 06 must not leave the version
 * committed in `publishing`.
 *
 * The findings travel on the error because a refusal that does not say WHICH
 * rule was breached is a refusal a scheduler cannot act on. `rule_key` is the
 * stable identifier and is always named.
 */
export class HardRuleBreachError extends SchedulePreconditionError {
  readonly findings: readonly HardRuleFinding[];

  constructor(findings: readonly HardRuleFinding[]) {
    const first = findings[0];
    super(
      'HARD_RULE_BREACH',
      `publication is blocked by ${String(findings.length)} HARD-rule finding(s); the first is ` +
        `${first?.ruleKey ?? '(none)'} (${first?.finding ?? 'breach'}): ${first?.explanation ?? ''}`,
    );
    this.name = 'HardRuleBreachError';
    this.findings = findings;
  }
}

/**
 * SPEC-05 §6 step 06, as the publication transaction calls it.
 *
 * Raises rather than returning a verdict: every other prerequisite in §6 raises,
 * and a returned boolean is a prerequisite a future caller can forget to read.
 */
export async function assertHardRulesRevalidated(uow: Uow, versionId: string): Promise<void> {
  const findings = await findHardRuleFindings(uow, versionId);
  if (findings.length > 0) throw new HardRuleBreachError(findings);
}
