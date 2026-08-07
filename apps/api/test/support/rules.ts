import {
  RULE_SCHEMA_VERSION,
  canonicalStringify,
  type Rule,
  type RuleNode,
  type RuleScope,
} from '@schedulepoint/domain';
import { randomUUID } from 'node:crypto';

import { categoryOf } from '../../src/rules/service.js';

/**
 * The rule model's test fixtures and persistence helpers (OPUS-M3-002).
 *
 * **This file is OPUS-M3-002's alone** for the parallel window (packet 32 §6).
 * It does not touch `multi.ts`, `owned-multi.ts` or `staffing.ts`: `multi.ts` is
 * the single fixture owner and is prohibited to this packet, so the SBX seeding
 * below is invoked BY the calling test file (`test/sbx/sbx.test.ts`, which is in
 * this packet's allowed globs) against an already-provisioned fixture, rather
 * than by extending the provisioning script.
 *
 * ## Why the seeding goes through the unit of work, not a raw owner client
 *
 * `seedRulesForSweep` exists to give the SBX-004 sweep something it could see if
 * the group predicate were broken — its purpose is the *existence of rows in
 * more than one group*, not the exercise of the authoring path (which
 * `round-trip.test.ts` and `authorization.test.ts` cover through the real
 * routes).
 *
 * The first version wrote as the table OWNER with a raw client and was refused,
 * which is the correct behaviour and worth recording: `app_guard_rule_
 * administration` calls `app_require_capability`, and 0002's guard is not
 * role-conditional — it binds the owner too. So the seed goes through the
 * production write path under a capability-holding context, exactly as
 * `provisionMulti` seeds the catalogue.
 */

/** A synthetic HARD rule. No real names — synthetic identifiers only. */
export function hardRule(ruleKey: string, predicate: RuleNode, scope: RuleScope = {}): Rule {
  return {
    ruleKey,
    name: `Fixture rule ${ruleKey}`,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    classification: 'HARD',
    scope,
    predicate,
  };
}

/** A synthetic SOFT rule carrying the weight its classification requires. */
export function softRule(
  ruleKey: string,
  predicate: RuleNode,
  weight = 10,
  scope: RuleScope = {},
): Rule {
  return {
    ruleKey,
    name: `Fixture rule ${ruleKey}`,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    classification: 'SOFT',
    weight,
    scope,
    predicate,
  };
}

/**
 * The canonical fixture rule every isolation test uses when the content is
 * irrelevant.
 *
 * ## Why it is an `AvoidDate` on 2099-12-31 and not a `RequiredCount`
 *
 * It was `RequiredCount`, chosen because the content genuinely does not matter
 * to the SBX-004 sweep: the fixture's job is to put ROWS in more than one group
 * so the cross-group arm is measurable.
 *
 * OPUS-M3-008 gave rule content a consequence. SPEC-05 §6 step 06 now evaluates
 * every ACTIVE HARD rule against a version at publication, and SPEC-04 §3.3
 * forbids skipping one — so a HARD rule of a kind whose semantics SPEC-04 §3.1
 * does not pin (`RequiredCount` is one: it does not say what the count is over)
 * BLOCKS publication rather than passing silently. Seeding one into every swept
 * group made SBX-018's publication unpublishable, which is the control working
 * on a fixture that had no opinion about rules.
 *
 * `AvoidDate` on a synthetic far-future date is the minimal change that keeps
 * every property the fixture actually needs — HARD, `active`, one row per group,
 * synthetic content — while being **evaluable and satisfied**: no fixture
 * assignment is dated 2099-12-31, and D-2's period windows make one impossible
 * to add by accident.
 *
 * The rule is deliberately still HARD and still active. Making it `SOFT` or
 * `disabled` would have removed it from step 06's population entirely, which
 * would have hidden the interaction rather than resolved it.
 */
export function coverageRule(ruleKey: string): Rule {
  return hardRule(ruleKey, { kind: 'AvoidDate', date: '2099-12-31' });
}

/**
 * The seeding runs through a UNIT OF WORK under a capability-holding context.
 *
 * The first version wrote as the table owner with a raw client and was refused:
 * `app_guard_rule_administration` calls `app_require_capability`, which binds the
 * OWNER too (that is the point of it — 0002's guard is not role-conditional). So
 * the seed goes through the production write path, exactly as `provisionMulti`
 * seeds the catalogue. The context must hold `schedule.catalogue.administer`;
 * a scheduler membership does.
 */
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

export interface SeedTarget {
  readonly organizationId: string;
  readonly groupId: string;
  /** A membership in that group holding `schedule.catalogue.administer`. */
  readonly membershipId: string;
  /** Distinguishes the keys written per target — a stray row names its origin. */
  readonly label: string;
}

/**
 * Writes one rule and one rule set into each target, through the production
 * write path under that target's own capability-holding context.
 *
 * Idempotent: `on conflict do nothing`, so a test file that seeds and a battery
 * that seeds again do not fight.
 *
 * Returns the number of rule rows written (0 when everything already existed),
 * and the caller asserts the TABLES are non-empty rather than this count — a
 * re-run legitimately writes nothing.
 */
export async function seedRulesForSweep(
  runner: SeedRunner,
  targets: readonly SeedTarget[],
): Promise<number> {
  let written = 0;
  for (const target of targets) {
    const rule = coverageRule(`fixture_${target.label}`);
    written += await runner.run(
      {
        organizationId: target.organizationId,
        groupId: target.groupId,
        membershipId: target.membershipId,
        correlationId: `seed-rules-${target.label}`,
      },
      async (uow) => {
        const db = uow.query as {
          executeQuery?: unknown;
        };
        const { sql } = await import('kysely');
        const inserted = await sql`
          insert into rules
            (id, organization_id, group_id, rule_key, name, rule_schema_version,
             classification, weight, category, scope, predicate)
          values (${randomUUID()}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
                  ${rule.ruleKey}, ${rule.name}, ${rule.ruleSchemaVersion},
                  ${rule.classification}, null, ${categoryOf(rule.scope, rule.predicate)},
                  ${canonicalStringify(rule.scope)}::jsonb,
                  ${canonicalStringify(rule.predicate)}::jsonb)
          on conflict (organization_id, group_id, rule_key) do nothing
          returning id
        `.execute(db as never);

        await sql`
          insert into rule_sets (id, organization_id, group_id, name, rule_keys)
          values (${randomUUID()}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
                  ${`Fixture set ${target.label}`}, ${[rule.ruleKey]}::text[])
          on conflict (organization_id, group_id, name) do nothing
        `.execute(db as never);

        return inserted.rows.length;
      },
    );
  }
  return written;
}
