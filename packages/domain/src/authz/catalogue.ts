/**
 * The action catalogue — modules, module dependencies, and capability keys.
 *
 * ## Why this is code and not a table
 *
 * [06](../../../../docs/architecture/06-data-architecture.md) §3.1 lists
 * `capabilities`, `module_definitions` and `module_dependencies` with tenant
 * scope **`system`** — they are reference data, identical for every
 * organization, and they carry no `organization_id`. Three consequences follow,
 * and together they are why this milestone ships them as constants:
 *
 *  1. **SPEC-06 A-14 and A-16 must fail the BUILD.** "A route with no declared
 *     policy — or no declared `scope`" and "a capability key declared in both
 *     namespaces" are build failures, not runtime denials. A row in a table
 *     cannot fail a build; a constant here can, and does
 *     (`packages/domain/test/authz/named-cases.test.ts`, describe block "the catalogue", and
 *     `apps/api/test/http/route-declarations.test.ts` for the route side).
 *  2. **The evaluator is pure.** SPEC-06 §1: "it performs no I/O". A capability's
 *     scope and its module are inputs to the truth table, so if they lived in a
 *     table the evaluator would either need a database handle or a second
 *     snapshot loader whose failure mode is "no capabilities exist".
 *  3. **A non-tenant table would need an RLS opt-out.** `scripts/gates/
 *     migration-rls-check.mjs` fails any `CREATE TABLE` without ENABLE + FORCE +
 *     a policy unless it carries a written opt-out. Three opt-outs to store data
 *     that never varies is a worse trade than three constants.
 *
 * **What IS tenant data, and lands in `0002_authorization.sql`:** `roles`,
 * `role_capabilities`, `capability_grants`, `entitlements`,
 * `group_module_availability`. Those vary per organization, so they are rows
 * under RLS. The catalogue below is the closed vocabulary they reference.
 *
 * Recorded as a deviation in `docs/evidence/EV-M1-AUTHZ/INDEX.md` §6.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Modules — [05](../../../../docs/architecture/05-tenancy-entitlements-authorization.md) §3.2
 * ──────────────────────────────────────────────────────────────────────────── */

export const MODULE_KEYS = [
  'core_scheduling',
  'requests_vacation',
  'marketplace',
  'communications',
  'reporting_documents',
  'picklist',
  'hospital_integration',
  /**
   * The two modules SPEC-06 §1.1's "Governing module" column names that doc 05
   * §3.2's seven-module list does not: **`Organization administration`** and
   * **`Entitlements`**.
   *
   * They are here because of a defect the HTTP battery found rather than because
   * the list looked incomplete. With `organization.entitlement.administer` placed
   * in `core_scheduling`, revoking `core_scheduling` **locked the organization
   * out of its own entitlement administration** — L1.2 denied the only action
   * that could have re-enabled it. The lockout was reachable in one request and
   * unrecoverable without a platform-administration surface that does not exist.
   *
   * Splitting them out is what SPEC-06 §1.1 already says: entitlement
   * administration is governed by *Entitlements*, and group / user / role /
   * profile administration by *Organization administration*. Neither is a
   * commercially packaged module and neither has dependencies.
   *
   * **The lockout is narrowed, not eliminated** — an organization that revokes
   * the `entitlements` module itself still locks out entitlement administration.
   * That is SPEC-06's model working as written (L1 applies to every action), the
   * recovery path is platform administration (M-25), and it is recorded in
   * `docs/evidence/EV-M1-AUTHZ/INDEX.md` §5 rather than papered over with an
   * exemption in the evaluator.
   */
  'organization_administration',
  'entitlements',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/**
 * Each module's declared dependencies (doc 05 §3.2).
 *
 * > **The last dependency is load-bearing:** integrated picklist mode is
 * > meaningless without the picklist module.
 *
 * SPEC-06 L1.4 requires **every** declared dependency of the action's module to
 * be itself satisfied by L1.1–L1.3. `moduleClosure` computes the transitive set,
 * because a one-level check would let `hospital_integration` pass while
 * `core_scheduling` — reached through `picklist` — was revoked.
 */
export const MODULE_DEPENDENCIES: Readonly<Record<ModuleKey, readonly ModuleKey[]>> = {
  core_scheduling: [],
  requests_vacation: ['core_scheduling'],
  marketplace: ['core_scheduling'],
  communications: ['core_scheduling'],
  reporting_documents: ['core_scheduling'],
  picklist: ['core_scheduling'],
  hospital_integration: ['picklist'],
  organization_administration: [],
  entitlements: [],
};

/**
 * The module and every module it transitively depends on, the module itself
 * first.
 *
 * Cycle-safe by construction: a key already in the accumulator is not expanded
 * again. `moduleDependencyCycles()` asserts there are none in the first place.
 */
export function moduleClosure(key: ModuleKey): readonly ModuleKey[] {
  const seen: ModuleKey[] = [];
  const walk = (current: ModuleKey): void => {
    if (seen.includes(current)) return;
    seen.push(current);
    for (const next of MODULE_DEPENDENCIES[current]) walk(next);
  };
  walk(key);
  return seen;
}

/**
 * Any module that reaches itself through its dependencies, and any module that
 * depends on itself directly (doc 06: "**No self-dependency**").
 *
 * Returns the offending keys rather than throwing, so the check can be a test
 * assertion with a readable failure rather than an import-time crash.
 */
export function moduleDependencyCycles(): readonly ModuleKey[] {
  return MODULE_KEYS.filter((key) => {
    const reached = new Set<ModuleKey>();
    const walk = (current: ModuleKey): void => {
      for (const next of MODULE_DEPENDENCIES[current]) {
        if (reached.has(next)) continue;
        reached.add(next);
        walk(next);
      }
    };
    walk(key);
    return reached.has(key);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Capabilities
 * ──────────────────────────────────────────────────────────────────────────── */

export type CapabilityScope = 'group' | 'organization';

export interface CapabilityDefinition {
  /** The action key. `action.key` in SPEC-06's `PolicyInput`. */
  readonly key: string;
  /**
   * SPEC-06 §1.1. **P-10: a key is declared group-scoped or organization-scoped,
   * never both.** Declaring it once, with a scope field, is what makes A-16
   * structurally impossible rather than merely tested — and the test still
   * exists, because "structurally impossible" is a claim about today's shape.
   */
  readonly scope: CapabilityScope;
  /** The module L1 evaluates the entitlement for. */
  readonly module: ModuleKey;
  /** Why this key exists, in one sentence. Read by reviewers, not by code. */
  readonly description: string;
}

/**
 * The closed capability vocabulary.
 *
 * Every key here traces to [08](../../../../docs/fable/08-roles-and-permissions.md)
 * §4's named-grant list or to SPEC-06 §1.1's organization-scoped action classes.
 * The one exception is `membership.touch_self` / `organization.membership.touch_self`,
 * which are the **harness** capabilities the context-probe surfaces declare —
 * they are named for what they do rather than dressed up as a product action,
 * and they are the only two keys with no product feature behind them.
 *
 * **This list does not expand the 58-capability baseline.** That baseline
 * (`CAP-###`) is a different register: it enumerates product *capabilities*, and
 * a route still declares its `CAP-###` in `policy.capability`. These keys are
 * *action* keys — the unit SPEC-06's L4 evaluates — and several of them belong
 * to one baseline capability.
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = [
  /* ── group scope ─────────────────────────────────────────────────────────── */
  {
    key: 'membership.touch_self',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'Harness capability: update the acting group membership\'s own activity timestamp. The ' +
      'group-scoped context-probe surfaces declare it (SPEC-01 §7.1 T-01/T-05).',
  },
  {
    key: 'schedule.publish',
    scope: 'group',
    module: 'core_scheduling',
    description: 'Publish a schedule version (doc 08 §4; grant-only, never role-implied).',
  },
  {
    key: 'schedule.revert',
    scope: 'group',
    module: 'core_scheduling',
    description: 'Revert a published schedule version by publishing forward (I-18, doc 08 §4).',
  },
  /* ── OPUS-M3-003 — schedule authoring (SPEC-05; CAP-014, CAP-019, CAP-020) ────
   *
   * Two group-scoped `core_scheduling` action keys, DISTINCT from
   * `schedule.publish`: the packet requires "publish is a distinct capability
   * from edit". They are role-implied for the scheduler (doc 08 §6 "author the
   * schedule"), whereas `schedule.publish`/`schedule.revert` stay grant-only —
   * so a scheduler drafts freely but publication is a named, granted act.
   *
   * **This does not expand the 58-capability baseline** — see this file's
   * header. Routes still declare their `CAP-###` in `policy.capability`; these
   * are ACTION keys, the unit L4 evaluates, several to one baseline capability. */
  {
    key: 'schedule.period.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-019/CAP-020: create and maintain schedule periods and their staffing requirements ' +
      '(bounded planning ranges; no-overlap per group). Role-implied for the scheduler.',
  },
  {
    key: 'schedule.version.edit',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-014: author a DRAFT schedule version — create/clone, manual assignment/removal/' +
      'reassignment, overrides with reasons, pins, credits, and lifecycle transitions short of ' +
      'publication. Draft-only (D-15a forbids editing a published version); distinct from ' +
      '`schedule.publish`. Role-implied for the scheduler.',
  },
  /* ── OPUS-M3-006 — the staff-facing READ surface (CAP-020, doc 07 §1) ────────
   *
   * Two group-scoped `core_scheduling` READ keys, proposed additively because
   * neither existed and no shipped key could stand in for them:
   *
   *  - `schedule.version.edit` and `schedule.period.administer` are AUTHORING
   *    keys held by the scheduler and the group administrator. Gating a staff
   *    member's own rota on an authoring key would mean nobody who is scheduled
   *    could read the schedule, and everybody who could read it could rewrite
   *    it. That is precisely the write/read confusion the calendar-key edge
   *    (packet 32 §2 row 10) is about, and this packet's ruling refuses it in
   *    both directions: **a write key never implies a read, and a read key never
   *    implies a write.** Neither key below carries any power to change
   *    anything.
   *  - `membership.touch_self` is a harness capability with no product action
   *    behind it (see this file's header). Reusing it for a product read would
   *    make the harness key load-bearing in production.
   *
   * `docs/fable/08-roles-and-permissions.md` §6's "View published schedules"
   * row is what assigns them: Member ✓, Viewer ✓, Telecom —, Scheduler ✓, Group
   * Admin ✓. They are `✓` cells, not `G` cells, so both are role-implied rather
   * than grant-only — a person's own rota is not something they should have to
   * be granted. (The full path is deliberate: a bare "doc 08" resolves to
   * `docs/architecture/08` under the repo convention, which is a different
   * document.)
   *
   * **This does not expand the 58-capability baseline.** Both routes declare
   * CAP-020 in `policy.capability`; these are ACTION keys, the unit L4
   * evaluates. */
  {
    key: 'schedule.own_published.read',
    scope: 'group',
    module: 'core_scheduling',
    description:
      "CAP-020: read one's OWN assignments in the group's current published schedule. " +
      'Self-scoped through SPEC-06 L5.1 with ownership required and **no ownership override** — ' +
      'reading a named colleague\'s personal view is not an administrative power anybody holds; ' +
      'the daily sheet and the authoring grid are the surfaces that show other people, and each ' +
      'is separately authorized.',
  },
  {
    key: 'schedule.published.read',
    scope: 'group',
    module: 'core_scheduling',
    description:
      "CAP-020: read the group's current published schedule — the daily assignment sheet for a " +
      'date (doc 07 §1, a read of the published master schedule; NOT the picklist ' +
      '`daily_assignments` module, which is M9). Published content only: a draft version is ' +
      'invisible to this key at the query level, not filtered afterwards.',
  },
  {
    key: 'requests.batch_approve',
    scope: 'group',
    module: 'requests_vacation',
    description: 'Approve requests in bulk (doc 08 §6: Scheduler, batch requires a grant).',
  },
  {
    key: 'vacation.commit',
    scope: 'group',
    module: 'requests_vacation',
    description: 'Commit the vacation round (doc 08 §4).',
  },
  {
    key: 'vacation.override_quota',
    scope: 'group',
    module: 'requests_vacation',
    description: 'Exceed a configured vacation quota (doc 08 §4).',
  },
  {
    key: 'picklist.administer',
    scope: 'group',
    module: 'picklist',
    description: 'Administer picklist rounds (doc 08 §4).',
  },
  {
    key: 'picklist.intervene',
    scope: 'group',
    module: 'picklist',
    description: 'Intervene in a running picklist turn (doc 08 §4).',
  },
  {
    key: 'messaging.bulk_send',
    scope: 'group',
    module: 'communications',
    description: 'Send a message to many recipients at once (doc 08 §4).',
  },
  {
    key: 'documents.manage',
    scope: 'group',
    module: 'reporting_documents',
    description: 'Administer group documents (doc 08 §4).',
  },
  {
    key: 'connectors.manage',
    scope: 'group',
    module: 'hospital_integration',
    description: 'Configure a hospital connector (doc 08 §4; depends on picklist, doc 05 §3.2).',
  },

  /* ── OPUS-M2-003 — staffing parameters (CAP-013, CAP-058) ───────────────────
   *
   * Six action keys, all **group-scoped** and all in `core_scheduling`.
   *
   * *Why group scope:* doc 06 §3.2 gives all four tables tenant scope `org+group`,
   * and a work profile or a credential belongs to a GROUP membership. There is no
   * organization-wide version of "this person works 60% on Tuesdays".
   *
   * *Why `core_scheduling` and not a module of their own:* the entitlement modules
   * are doc 05 §3.2's commercially packaged set. M-05 (Qualifications) and M-06
   * (Scheduling Configuration) in doc 04 are **domain** modules — bounded
   * contexts — not packages anybody buys separately, and inventing an entitlement
   * module for them would be making a PO-DEC-04 packaging decision nobody has
   * made. FTE targets and credential eligibility are inputs the scheduling engine
   * cannot run without, so `core_scheduling` is where revoking the entitlement has
   * the meaning it should: no scheduling, no staffing parameters.
   *
   * *Why grant-only:* no system role carries them. CAP-013 and CAP-058 both state
   * the requirement as "requires an administrative capability", which is doc 08
   * §4's named-grant class — the same shape as `schedule.publish`,
   * `vacation.commit` and `audit.export`. `SYSTEM_ROLE_CAPABILITIES` is
   * OPUS-M1-002's file and is deliberately not edited here.
   *
   * The read/write split on holdings is the `SENSITIVE-PII` classification made
   * operational: a scheduler who must check eligibility gets
   * `…holding.read_any` and thereby no power to issue or revoke a credential. */
  {
    key: 'staffing.work_profile.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-013: author a membership\'s effective-dated work profile — FTE, weekday and holiday ' +
      'targets, maximum assignments. Grant-only ("editing another member\'s work profile requires ' +
      'an administrative capability").',
  },
  {
    key: 'staffing.work_profile.read',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-013: read a membership\'s work profile in force, and its history. Separate from the ' +
      'administer key so a reader of FTE data gains no power to change it.',
  },
  {
    key: 'staffing.qualification.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-058: maintain the group\'s qualification vocabulary — create, rename, retire. Retiring ' +
      'is the only removal; a qualification with holdings is never deleted (06 §3.2).',
  },
  {
    key: 'staffing.qualification_holding.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-058, PO-DEC-12 default (administrator-granted, patient-safety adjacent): issue and ' +
      'revoke a membership\'s credential. Revocation is a first-class audited event.',
  },
  {
    key: 'staffing.qualification_holding.read',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-058: use the credential read surface. It admits a caller to the route; WHAT they see ' +
      'is decided by the RLS policies — their own holdings always, anyone else\'s only with ' +
      '`read_any`. Two keys rather than one so the SENSITIVE-PII narrowing is a property of the ' +
      'data rather than of which URL was called.',
  },
  {
    key: 'staffing.qualification_holding.read_any',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-058: read ANOTHER membership\'s credential holdings. A member always reads their own; ' +
      'this is the SENSITIVE-PII narrowing, enforced in the RLS SELECT policy itself.',
  },

  /* ── OPUS-M2-002: the scheduling-structure catalogue (CAP-011, CAP-012) ─────
   *
   * All three are GROUP-scoped because SPEC-06 §1.1 says so by exclusion:
   * "Everything not in this enumeration is group-scoped. The default is the
   * narrower scope, deliberately." Catalogue authoring appears in none of the six
   * organization-scoped action classes.
   *
   * All three are in `core_scheduling` because that is the module the catalogue
   * belongs to — CAP-011 and CAP-012 both name module M-06 (Scheduling
   * Configuration) in doc 18, and `core_scheduling` is its key in doc 05 §3.2.
   * **No new module is invented**: the packet says the module taxonomy being
   * ambiguous is an escalation, and it is not ambiguous here.
   *
   * They are THREE keys rather than one because doc 08 §6 draws the role line in
   * two different places, and one key would have had to pick a side:
   *
   *   "Author catalogue & rules"   scheduler ✓  group_admin ✓
   *   "Group settings"             scheduler —  group_admin ✓
   */
  {
    key: 'schedule.catalogue.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'Author the scheduling-structure catalogue: shift types, shift groups, staff groups, valid ' +
      'combinations and per-weekday demand (doc 08 §6 "Author catalogue & rules"; CAP-011/CAP-012).',
  },
  {
    key: 'group.holiday_calendar.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'Maintain the group holiday calendar (CAR-011). A group setting rather than catalogue ' +
      'authoring, so doc 08 §6 puts it with "Group settings" — group administrators only.',
  },
  {
    key: 'group.pick_positions.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'Increase the group-wide count of numbered draft pick positions. Its own key because the ' +
      'change is MONOTONIC and therefore irreversible (research 05 §ADM-07), which is the one ' +
      'catalogue action a mistake cannot be undone from.',
  },

  /* ── OPUS-M3-007 — group settings and locations (packet 32 §10c) ───────────
   *
   * Three group-scoped `core_scheduling` keys, all **role-implied for
   * `group_admin` and for nobody else**.
   *
   * *Why role-implied rather than grant-only.* doc 08 §6's "Group settings /
   * vocabulary / connectors" row reads `— — — — ✓ ✓` with the parenthetical
   * "(connectors: G)". A `✓` is role-implied and a `G` is grant-only; the row
   * marks exactly one of its three subjects as a grant, and it is not these.
   * Scheduler is `—`, which is why none of the three joins `scheduler` — the
   * same line `group.holiday_calendar.administer` and
   * `group.pick_positions.administer` already sit on.
   *
   * *Why group scope.* SPEC-06 §1.1: "Everything not in this enumeration is
   * group-scoped. The default is the narrower scope, deliberately." Group
   * settings are not in that enumeration. doc 08 §6 also gives the row to Org
   * Admin, and that is honoured the way this system honours it everywhere —
   * an organization administrator who needs to administer a group's settings
   * holds a group membership with the `group_admin` role, because a
   * group-scoped action evaluates against a group membership (L3).
   *
   * *Why `core_scheduling`.* Same reasoning as the catalogue keys: the
   * entitlement modules are doc 05 §3.2's commercially packaged set, and a
   * group's request window, picklist policy, timezone and locations are
   * scheduling configuration. Inventing a module for them would be making a
   * PO-DEC-04 packaging decision nobody has made.
   *
   * *Why three keys and not one.* doc 08 §6 draws no line inside the row, so
   * the split is justified by blast radius, exactly as the catalogue's is:
   *
   *   `group.settings.administer`  request-until + picklist access. Both are
   *                                STORED ONLY at this milestone (enforcement
   *                                M5 and M9 respectively, packet 32 §2 rows
   *                                5-6), so a mistake changes a row nothing
   *                                reads yet.
   *   `group.timezone.administer`  the one settings change that reaches
   *                                ALREADY-PUBLISHED history: every shift-local
   *                                boundary in every published version resolves
   *                                against `groups.timezone`, so changing it
   *                                re-interprets immutable rows without
   *                                touching them. Its own key for the same
   *                                shape of reason `group.pick_positions.
   *                                administer` has one — it is the settings
   *                                action whose consequences a mistake cannot
   *                                simply be edited back out of.
   *   `group.location.administer`  the `locations` table. A separate key so a
   *                                grant to maintain the places a group works
   *                                is not also a grant over its request window.
   *
   * **This does not expand the 58-capability baseline** — see this file's
   * header. The routes declare `CAP-004` / `CAP-021` / `CAP-030` in
   * `policy.capability`; these are ACTION keys, the unit L4 evaluates. */
  {
    key: 'group.settings.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      "CAP-021/CAP-030: author the group's request-until policy and its picklist-access mode " +
      '(doc 08 §6 "Group settings"; group administrators only). Storage and authoring only — ' +
      'enforcement is M5 (SPEC-08) and M9 (SPEC-02) respectively.',
  },
  {
    key: 'group.timezone.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      "Change the group's timezone (06 §3.1, `groups.timezone` NOT NULL). Its own key because " +
      'it is the one group setting that re-interprets already-published history: every ' +
      'shift-local boundary resolves against it.',
  },
  {
    key: 'group.location.administer',
    scope: 'group',
    module: 'core_scheduling',
    description:
      'CAP-004: maintain the group\'s locations — name, the free-form `site_label` attribute ' +
      '(PO-DEC-01 default, CAR-021), address and optional zone. Archive, never delete.',
  },

  /* ── organization scope (SPEC-06 §1.1's enumerated classes) ──────────────── */
  {
    key: 'organization.membership.touch_self',
    scope: 'organization',
    module: 'core_scheduling',
    description:
      'Harness capability: the organization-scoped half of `membership.touch_self`. A SEPARATE ' +
      'key, because P-10 forbids one key spanning both namespaces (SPEC-01 §7.1 T-06b/T-06c).',
  },
  {
    key: 'organization.membership.administer',
    scope: 'organization',
    module: 'organization_administration',
    description:
      'SPEC-06 §1.1 "User and membership administration": invite a user to the organization, ' +
      'end a membership, assign a group role. The control for EV-M1-TENANCY residuals 1 and 2.',
  },
  {
    key: 'organization.group.administer',
    scope: 'organization',
    module: 'organization_administration',
    description:
      'SPEC-06 §1.1 "Group administration": create, rename, deactivate a group; set group module ' +
      'availability (SPEC-01 §4.3 EX-2 as amended 2026-08-02).',
  },
  {
    key: 'organization.role.administer',
    scope: 'organization',
    module: 'organization_administration',
    description:
      'SPEC-06 §1.1 "Role and capability administration": manage `role_capabilities` and ' +
      'capability grants.',
  },
  {
    key: 'organization.entitlement.administer',
    scope: 'organization',
    module: 'entitlements',
    description:
      'SPEC-06 §1.1 "Entitlement administration" (CAP-057): grant, suspend, revoke and re-window ' +
      'a module entitlement. In its OWN module, because with it in `core_scheduling` revoking ' +
      'core_scheduling locked the organization out of the only action that could restore it.',
  },
  {
    key: 'organization.profile.administer',
    scope: 'organization',
    module: 'organization_administration',
    description: 'SPEC-06 §1.1 "Organization profile and settings".',
  },
  {
    key: 'identity.change_login_email',
    scope: 'organization',
    module: 'organization_administration',
    description: 'Change a user\'s login email (doc 08 §4, CAR-027). Grant-only.',
  },
  {
    key: 'identity.impersonate',
    scope: 'organization',
    module: 'organization_administration',
    description: 'Impersonate a user (CAP-010, SPEC-06 §3.3). Grant-only.',
  },
  /* ── OPUS-M3-001 ────────────────────────────────────────────────────────────
   *
   * Two keys, and they are deliberately NOT folded into
   * `organization.membership.administer`. That key is role-implied for an
   * organization administrator; these two are grant-only, like their neighbours
   * `identity.change_login_email` and `identity.impersonate`, because each is a
   * CREDENTIAL action rather than a membership action:
   *
   *   MFA reset hands an account back to whoever asks for it, and T-25 (SPEC-11
   *   §5) names MFA reset abuse as its own threat. An administrator who may
   *   invite and end memberships does not thereby acquire the ability to strip a
   *   second factor.
   *
   *   Revoking another person's sessions is an eviction. It is the right control
   *   to have during an incident and the wrong one to have by default.
   *
   * **This does not expand the 58-capability baseline** — see this file's
   * header. Both routes declare `CAP-009` (invitation and credential lifecycle)
   * in `policy.capability`; these are ACTION keys, the unit L4 evaluates. */
  {
    key: 'identity.reset_mfa',
    scope: 'organization',
    module: 'organization_administration',
    description:
      "Reset a user's multi-factor enrolment (SPEC-11 X-12; T-25 MFA-reset abuse). Grant-only, " +
      'and separate from membership administration because it is a credential action.',
  },
  {
    key: 'identity.administer_sessions',
    scope: 'organization',
    module: 'organization_administration',
    description:
      "Revoke another user's live sessions (14 §3). Grant-only: an eviction is an incident " +
      'control, not a default administrative power.',
  },
  {
    key: 'audit.export',
    scope: 'organization',
    module: 'reporting_documents',
    description: 'Export the audit log (doc 08 §4). Grant-only.',
  },
];

const BY_KEY: ReadonlyMap<string, CapabilityDefinition> = new Map(
  CAPABILITIES.map((capability) => [capability.key, capability]),
);

export function capabilityDefinition(key: string): CapabilityDefinition | undefined {
  return BY_KEY.get(key);
}

export function isKnownCapability(key: string): boolean {
  return BY_KEY.has(key);
}

export function capabilityKeys(scope?: CapabilityScope): readonly string[] {
  return CAPABILITIES.filter((c) => scope === undefined || c.scope === scope).map((c) => c.key);
}

/**
 * SPEC-06 A-16 — a key declared in **both** namespaces fails the build.
 *
 * Returns the offending keys. With a single `scope` field per definition the
 * only way to produce one is a duplicated `key`, which is exactly what this
 * detects — so the assertion is about the list's integrity rather than about a
 * shape the type system already prevents.
 */
export function overlappingCapabilityKeys(): readonly string[] {
  const groupKeys = new Set(capabilityKeys('group'));
  return capabilityKeys('organization').filter((key) => groupKeys.has(key));
}

/** Keys declared more than once, whatever their scope. A catalogue integrity check. */
export function duplicateCapabilityKeys(): readonly string[] {
  const counts = new Map<string, number>();
  for (const capability of CAPABILITIES) {
    counts.set(capability.key, (counts.get(capability.key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([key]) => key);
}
