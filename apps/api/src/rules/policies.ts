import type { AuditEventName } from '@schedulepoint/domain';

import type { RouteConfigWithPolicy } from '../http/policy.js';

/**
 * The rule model's route declarations and audit vocabulary, in one place
 * (OPUS-M3-002; CAP-015, CAP-045, CAR-006).
 *
 * ## Why no new capability key is minted
 *
 * `schedule.catalogue.administer`. doc 08 §6's row is literally **"Author
 * catalogue & rules"** (scheduler ✓, group admin ✓) — the existing key's own
 * documented population already covers rule authoring, and
 * `catalogue/policies.ts` cites that same row as the key's source. Gating rules
 * with it is **integration** with the SPEC-06 evaluator, which is what the packet
 * requires; minting a `schedule.rules.administer` would mean deciding which roles
 * hold it, and doc 08 §6 has no separate rules row to read that off. It would
 * also mean editing `packages/domain/src/authz/catalogue.ts`, which this task may
 * not touch (the evaluator is integrated with, never modified).
 *
 * The consequence is honest and recorded rather than discovered: **a principal
 * who may author the catalogue may author rules.** doc 08 §6 puts them on one
 * row, so that is the specification's population, not a widening of it.
 *
 * ## Reads are gated by the SAME capability as writes, deliberately
 *
 * The same choice, for the same reason, that OPUS-M2-002 recorded for the
 * catalogue: there is no `schedule.rules.read`, the only consumers in this
 * milestone are the authoring surfaces, and inventing a read key would mean
 * inventing which roles hold it. Deny-by-default is the correct direction to be
 * wrong in (I-02). The later surfaces that need to READ compiled rules — the
 * M3-004 validation display, the M4 build pipeline — declare their own actions
 * when they ship.
 *
 * ## Why the declarations live here and not in the route file
 *
 * The route file is a thin registration surface (auto-discovery requires it to
 * sit in `http/routes/`), and **the tests compare against these objects, not
 * against copies of their contents**: `apps/api/test/rules/authorization.test.ts`
 * walks `RULES_CAPABILITY_KEYS` and asserts a deny case for each.
 */

/** CAP-015 · rule authoring and the rule model. */
const CAP_RULES = 'CAP-015';
/** CAP-045 · rule sets composed for builds. */
const CAP_RULE_SETS = 'CAP-045';

/**
 * doc 08 §6 "Author catalogue & rules". Group-scoped, `core_scheduling` — for the
 * reasons `catalogue/policies.ts` gives for the identical constant: SPEC-06 §1.1
 * enumerates the organization-scoped classes and rule authoring is not among
 * them, so the narrower scope is the default and it is deliberate.
 */
const RULES_ACTION = {
  key: 'schedule.catalogue.administer',
  moduleKey: 'core_scheduling',
  requiresObjectPolicy: false,
} as const;

export const RULE_CONFIG = {
  policy: { kind: 'capability', capability: CAP_RULES },
  actionScope: 'group',
  action: RULES_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const RULE_SET_CONFIG = {
  policy: { kind: 'capability', capability: CAP_RULE_SETS },
  actionScope: 'group',
  action: RULES_ACTION,
} as const satisfies RouteConfigWithPolicy;

/**
 * The event name each rule mutation is audited under.
 *
 * Exported and asserted against `AUDIT_EVENT_NAMES` (`apps/api/test/rules/
 * audit.test.ts`), so the names are a contract rather than strings in handlers
 * that quietly diverge — the discipline `authorization.route.ts` established and
 * `catalogue/policies.ts` follows.
 */
export const RULES_AUDIT_EVENTS = {
  ruleCreated: 'rules.rule.created',
  ruleUpdated: 'rules.rule.updated',
  ruleDisabled: 'rules.rule.disabled',
  ruleEnabled: 'rules.rule.enabled',
  ruleArchived: 'rules.rule.archived',
  ruleSetCreated: 'rules.rule_set.created',
  ruleSetUpdated: 'rules.rule_set.updated',
  ruleSetArchived: 'rules.rule_set.archived',
} as const satisfies Record<string, AuditEventName>;

/**
 * Every capability key this slice reaches, for the per-capability deny tests.
 *
 * A list rather than a derivation from the route configs: the test walks THIS
 * list and asserts each key is reachable through at least one registered rules
 * route AND has a deny case. A derivation could not notice a key no route uses.
 */
export const RULES_CAPABILITY_KEYS = ['schedule.catalogue.administer'] as const;
