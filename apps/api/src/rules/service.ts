import { randomUUID } from 'node:crypto';

import type { RuleSetWriteRequest, RuleView, RuleWriteRequest } from '@schedulepoint/contracts';
import {
  RULE_SCHEMA_VERSION,
  canonicalStringify,
  compileRuleSetToCanonicalString,
  ruleProblems,
  type Rule,
  type RuleNode,
  type RuleProblem,
  type RuleScope,
  type TenantContext,
  type UnitOfWork,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * The typed rule model's domain services (OPUS-M3-002; CAP-015, CAP-045).
 *
 * ## Every function takes a unit of work, and none of them opens one
 *
 * I-15 and non-bypass rule 1, exactly as `catalogue/service.ts` states it: the
 * transaction boundary belongs to `PgUnitOfWorkRunner`, and a service that could
 * start its own would be a second place where FAD-12's "authorize, then mutate,
 * then audit, all in one transaction" could be got wrong.
 *
 * ## Validation happens three times, and the database is the control
 *
 * `ruleProblems` (the pure domain validator) gives the authoring form a
 * field-addressed `422` instead of a `500` with a SQLSTATE. The zod contract
 * refuses an unknown predicate `kind` on the wire. **Migration 0008 enforces the
 * same rules independently** — `rules_hard_soft_weight`,
 * `rules_predicate_kind_is_closed`, `rules_staff_category_matches_scope` — so a
 * bug here produces a refused statement rather than a bad row.
 *
 * ## Nothing here reads a tenant identifier from its arguments
 *
 * `organization_id` and `group_id` always come from `uow.context`, never from a
 * body or a path parameter.
 *
 * ## The round trip this file exists to make lossless
 *
 * SPEC-04 §3.2 and the packet: **author → persist → compile → load →
 * re-validate → re-serialize, with canonical-form equality.** `toRule` and
 * `rowFromWrite` are inverse over the AST, and `loadRuleForRoundTrip` reads a
 * row back and rebuilds exactly the `Rule` that was written — proven against a
 * real database by `apps/api/test/rules/round-trip.test.ts`, not merely in
 * memory. `jsonb` is why it can be lossless: PostgreSQL normalises key order and
 * whitespace, and `canonicalStringify` normalises the same things, so the two
 * agree on the bytes rather than on a hope.
 */

type Uow = UnitOfWork<Kysely<Database>>;

export type RuleOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'invalid'; readonly problems: readonly RuleProblem[] }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  /**
   * OPUS-M4-000C (doc 34 §4-D): the caller's `expectedVersion` is not the row's
   * current one. The current value travels back so the editor can re-fetch and
   * show the author what moved — **a stale edit is refused, never merged
   * blindly** (doc 07 §3.1), and the refusal is explicit rather than a silent
   * last-write-wins.
   */
  | { readonly kind: 'stale'; readonly currentVersion: number };

/** The tenant coordinates every statement below is pinned to. Never from a body. */
function tenantOf(context: TenantContext): { organization_id: string; group_id: string } {
  const { organizationId, groupId } = context;
  if (groupId === null) {
    // Unreachable through the routes: every rules route declares
    // `actionScope: 'group'`, and SPEC-01 §2.1's group branch refuses a request
    // with no group. Thrown rather than defaulted, because a rule written with
    // no group is a row the group predicate can never see again.
    throw new Error(
      'RULES_REQUIRE_GROUP_CONTEXT: a rule statement was reached under an ' +
        'organization-scoped unit of work',
    );
  }
  return { organization_id: organizationId, group_id: groupId };
}

const RULE_COLUMNS = [
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
  // OPUS-M4-000C: the database-owned counter 0008 created and nothing read.
  // It is the CAS token AND the revision number — see `rule_revisions`.
  'version',
] as const;

interface RuleRow {
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
  version: number;
}

/**
 * FAD-21's discriminator, DERIVED — never taken from the caller.
 *
 * The database asserts the same equivalence (`rules_staff_category_matches_scope`),
 * so a disagreement between this function and the stored row is a refused
 * statement rather than a row whose category lies about its content. `pattern` is
 * derived from the predicate rather than declared for the same reason: a
 * `PatternRule` IS the `pattern_rules` class FAD-21 folded in, and asking an
 * author to also tick a box is asking them to be able to tick the wrong one.
 */
export function categoryOf(scope: RuleScope, predicate: RuleNode): 'general' | 'pattern' | 'staff' {
  const memberships = scope.memberships;
  if (memberships !== undefined && memberships.length > 0) return 'staff';
  if (
    predicate.kind === 'PatternRule' ||
    predicate.kind === 'AlternatingWeek' ||
    predicate.kind === 'TemplateAdherence'
  ) {
    return 'pattern';
  }
  return 'general';
}

/** The wire write, as the typed domain `Rule` the validator and compiler consume. */
export function toRule(body: RuleWriteRequest): Rule {
  const base = {
    ruleKey: body.ruleKey,
    name: body.name,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    scope: body.scope as RuleScope,
    predicate: body.predicate as RuleNode,
  };
  return body.classification === 'HARD'
    ? { ...base, classification: 'HARD' }
    : { ...base, classification: 'SOFT', weight: body.weight ?? 0 };
}

/**
 * The AST-bearing subset of a stored rule row.
 *
 * `rowToRule` is defined over THIS rather than over `RuleRow` deliberately: the
 * CAS/revision counter is not part of the AST, and typing the reconstruction
 * against the full row would force every reader that does not need the counter
 * (the HARD-rule revalidation loader, which selects only what it evaluates) to
 * select it anyway. A wider parameter type than the function reads is a coupling
 * that shows up as an unrelated compile error two modules away.
 */
export type RuleAstRow = Omit<RuleRow, 'version'>;

/** A stored row, as the typed domain `Rule`. The inverse of {@link toRule}. */
export function rowToRule(row: RuleAstRow): Rule {
  const base = {
    ruleKey: row.rule_key,
    name: row.name,
    ruleSchemaVersion: row.rule_schema_version,
    scope: (row.scope ?? {}) as RuleScope,
    predicate: row.predicate as RuleNode,
  };
  return row.classification === 'HARD'
    ? { ...base, classification: 'HARD' }
    : { ...base, classification: 'SOFT', weight: Number(row.weight) };
}

function rowToWire(row: RuleRow): RuleView {
  return {
    ruleKey: row.rule_key,
    name: row.name,
    ruleSchemaVersion: row.rule_schema_version,
    classification: row.classification,
    weight: row.weight === null ? null : Number(row.weight),
    scope: (row.scope ?? {}) as RuleView['scope'],
    predicate: row.predicate as RuleView['predicate'],
    state: row.status,
    // The editor loads this and presents it back on save. Without it the
    // authoring surface has no way to say "this is the rule I was looking at".
    version: row.version,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rules
 * ──────────────────────────────────────────────────────────────────────────── */

export async function listRules(uow: Uow): Promise<readonly RuleView[]> {
  const rows = (await uow.query
    .selectFrom('rules')
    .select(RULE_COLUMNS)
    .orderBy('rule_key')
    .execute()) as unknown as RuleRow[];
  return rows.map(rowToWire);
}

export async function getRule(uow: Uow, ruleKey: string): Promise<RuleOutcome<RuleView>> {
  const row = (await uow.query
    .selectFrom('rules')
    .select(RULE_COLUMNS)
    .where('rule_key', '=', ruleKey)
    .executeTakeFirst()) as unknown as RuleRow | undefined;
  return row === undefined ? { kind: 'not-found' } : { kind: 'ok', value: rowToWire(row) };
}

/**
 * Loads a stored rule back as the typed domain `Rule` — the "load" leg of the
 * round trip. Exported because the proof needs the domain object, not the wire
 * view: re-validation and re-serialization are defined over the AST.
 */
export async function loadRuleForRoundTrip(uow: Uow, ruleKey: string): Promise<Rule | null> {
  const row = (await uow.query
    .selectFrom('rules')
    .select(RULE_COLUMNS)
    .where('rule_key', '=', ruleKey)
    .executeTakeFirst()) as unknown as RuleRow | undefined;
  return row === undefined ? null : rowToRule(row);
}

/**
 * What a mutation hands back to its audit entry.
 *
 * Both identifiers, because the audit row needs both and they are not
 * interchangeable: `audit_events.subject_id` is a **uuid column**, so the
 * subject is the row `id`; the STABLE `rule_key` travels in the closed audit
 * payload beside it (identifiers only — never rule content, I-07). Filing under
 * the key alone is impossible against the existing audit schema, and the audit
 * module is frozen to this packet; carrying the key in the payload preserves
 * what the stable identifier is for without touching it.
 */
export interface RuleMutation {
  readonly rule: RuleView;
  readonly id: string;
  readonly ruleKey: string;
}

export async function createRule(
  uow: Uow,
  body: RuleWriteRequest,
): Promise<RuleOutcome<RuleMutation>> {
  const rule = toRule(body);
  const problems = ruleProblems(rule);
  if (problems.length > 0) return { kind: 'invalid', problems };

  const tenant = tenantOf(uow.context);
  const inserted = (await uow.query
    .insertInto('rules')
    .values({
      id: randomUUID(),
      ...tenant,
      rule_key: rule.ruleKey,
      name: rule.name,
      rule_schema_version: rule.ruleSchemaVersion,
      classification: rule.classification,
      // The hard/soft discipline, at the write: a HARD rule inserts NULL, and the
      // `rules_hard_soft_weight` CHECK refuses the row if this ever disagrees.
      weight: rule.classification === 'SOFT' ? String(rule.weight) : null,
      category: categoryOf(rule.scope, rule.predicate),
      // `canonicalStringify` rather than `JSON.stringify`: the stored bytes are
      // then the canonical form, which is what makes the round trip an equality
      // rather than a comparison of two spellings of the same tree.
      scope: canonicalStringify(rule.scope),
      predicate: canonicalStringify(rule.predicate),
    })
    .returning(RULE_COLUMNS)
    .executeTakeFirstOrThrow()) as unknown as RuleRow;

  return {
    kind: 'ok',
    value: { rule: rowToWire(inserted), id: inserted.id, ruleKey: inserted.rule_key },
  };
}

/**
 * Amends a rule's content. **`rule_key` is never updated** — it is not in the SET
 * below, it is not in the UPDATE grant, and `rules_guard_key_immutable` refuses
 * a change anyway (non-bypass rule 13, three layers deep).
 */
export async function updateRule(
  uow: Uow,
  ruleKey: string,
  body: RuleWriteRequest,
  expectedVersion: number,
): Promise<RuleOutcome<RuleMutation>> {
  if (body.ruleKey !== ruleKey) {
    return {
      kind: 'invalid',
      problems: [
        {
          path: 'ruleKey',
          message: 'A rule key cannot be changed. Archive it and author a new rule.',
        },
      ],
    };
  }
  const rule = toRule(body);
  const problems = ruleProblems(rule);
  if (problems.length > 0) return { kind: 'invalid', problems };

  const updated = (await uow.query
    .updateTable('rules')
    .set({
      name: rule.name,
      rule_schema_version: rule.ruleSchemaVersion,
      classification: rule.classification,
      weight: rule.classification === 'SOFT' ? String(rule.weight) : null,
      category: categoryOf(rule.scope, rule.predicate),
      scope: canonicalStringify(rule.scope),
      predicate: canonicalStringify(rule.predicate),
      updated_at: new Date(),
    })
    .where('rule_key', '=', ruleKey)
    .where('status', '!=', 'archived')
    // ── The compare-and-set (OPUS-M4-000C, doc 34 §4-D) ────────────────────
    //
    // In the UPDATE's own predicate, not in a read before it. That distinction
    // is the whole M3-004 lesson, and it lands on the other side here: an
    // unlocked read-then-write CAS over a SET is unsafe under READ COMMITTED
    // (measured — 11 of 12 rounds both writers won), but a SINGLE-STATEMENT CAS
    // on ONE row is safe without a lock, because a blocked UPDATE re-evaluates
    // its WHERE clause against the row version the winner committed. The loser
    // therefore matches zero rows rather than overwriting.
    //
    // `version` is database-owned: `app_maintain_catalogue_version` (0008)
    // increments it unconditionally, including for a no-op UPDATE, so a writer
    // that read N and wrote nothing still loses to a writer that read N and
    // wrote something. It is also absent from the UPDATE grant, so the
    // application cannot rewind it.
    .where('version', '=', expectedVersion)
    .returning(RULE_COLUMNS)
    .executeTakeFirst()) as unknown as RuleRow | undefined;

  if (updated !== undefined) {
    return {
      kind: 'ok',
      value: { rule: rowToWire(updated), id: updated.id, ruleKey: updated.rule_key },
    };
  }

  // Zero rows has two causes and they are different answers to the author: the
  // rule is gone (or archived), or somebody else edited it first. Distinguishing
  // them costs one read and is the difference between "re-fetch and try again"
  // and "this no longer exists".
  return staleOrMissing(uow, ruleKey);
}

/** The zero-rows discriminator shared by every rule CAS write. */
async function staleOrMissing(uow: Uow, ruleKey: string): Promise<RuleOutcome<never>> {
  const current = (await uow.query
    .selectFrom('rules')
    .select(['version', 'status'])
    .where('rule_key', '=', ruleKey)
    .executeTakeFirst()) as unknown as { version: number; status: string } | undefined;
  if (current === undefined || current.status === 'archived') return { kind: 'not-found' };
  return { kind: 'stale', currentVersion: current.version };
}

/**
 * Moves a rule's lifecycle state. **Archived is terminal and nothing is deleted**
 * — `rule_key` is cited by rule sets and by every build that consumed it, and a
 * deleted key turns those citations into dangling references that still look
 * correct. `app_guard_rule_delete` refuses a DELETE outright.
 */
export async function setRuleState(
  uow: Uow,
  ruleKey: string,
  state: 'active' | 'disabled' | 'archived',
  expectedVersion: number,
): Promise<RuleOutcome<RuleMutation>> {
  const updated = (await uow.query
    .updateTable('rules')
    .set({ status: state, updated_at: new Date() })
    .where('rule_key', '=', ruleKey)
    .where('status', '!=', 'archived')
    // A lifecycle move is a mutation like any other, and archiving is
    // TERMINAL — archiving a rule somebody has just rewritten, without being
    // told, is the most consequential last-write-wins on this surface.
    .where('version', '=', expectedVersion)
    .returning(RULE_COLUMNS)
    .executeTakeFirst()) as unknown as RuleRow | undefined;

  if (updated !== undefined) {
    return {
      kind: 'ok',
      value: { rule: rowToWire(updated), id: updated.id, ruleKey: updated.rule_key },
    };
  }
  return staleOrMissing(uow, ruleKey);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Revisions (OPUS-M4-000C, doc 34 §4-D)
 * ──────────────────────────────────────────────────────────────────────────── */

/** One historical revision, as stored. Read through raw SQL: the table is append-only. */
export interface RuleRevisionView {
  readonly ruleKey: string;
  readonly revision: number;
  readonly ruleSchemaVersion: number;
  readonly name: string;
  readonly classification: 'HARD' | 'SOFT';
  readonly weight: number | null;
  readonly state: 'active' | 'disabled' | 'archived';
  readonly recordedAt: Date;
}

interface RuleRevisionRow {
  rule_key: string;
  revision: number;
  rule_schema_version: number;
  name: string;
  classification: 'HARD' | 'SOFT';
  weight: string | null;
  scope: unknown;
  predicate: unknown;
  status: 'active' | 'disabled' | 'archived';
  recorded_at: Date;
}

/**
 * Every revision of one rule, newest first.
 *
 * Raw `sql` rather than a Kysely builder, and `rule_revisions` is deliberately
 * absent from the `Database` interface, for the same reason `publication_records`
 * is: a typed `updateTable('rule_revisions')` would be a rewrite path the type
 * system handed out for a table whose entire value is that it cannot be
 * rewritten (D-15d). The database refuses it anyway — no runtime role holds
 * UPDATE or DELETE and `app_guard_append_only` fires for the owner too — and not
 * offering the path is the cheaper half of the same discipline.
 */
export async function listRuleRevisions(
  uow: Uow,
  ruleKey: string,
): Promise<readonly RuleRevisionView[]> {
  const rows = await sql<RuleRevisionRow>`
    SELECT rule_key, revision, rule_schema_version, name, classification, weight,
           scope, predicate, status, recorded_at
      FROM rule_revisions
     WHERE rule_key = ${ruleKey}
     ORDER BY revision DESC
  `.execute(uow.query);
  return rows.rows.map((row) => ({
    ruleKey: row.rule_key,
    revision: row.revision,
    ruleSchemaVersion: row.rule_schema_version,
    name: row.name,
    classification: row.classification,
    weight: row.weight === null ? null : Number(row.weight),
    state: row.status,
    recordedAt: row.recorded_at,
  }));
}

/**
 * Reconstruct one historical revision as the typed domain `Rule`.
 *
 * This is the function the packet's byte-identity requirement is about: what was
 * authored at revision N must come back as the same AST, canonicalising to the
 * same bytes, however many times the rule has been rewritten since. It returns
 * the domain object rather than a wire view because re-validation and
 * re-serialization are defined over the AST.
 */
export async function loadRuleRevision(
  uow: Uow,
  ruleKey: string,
  revision: number,
): Promise<Rule | null> {
  const rows = await sql<RuleRevisionRow>`
    SELECT rule_key, revision, rule_schema_version, name, classification, weight,
           scope, predicate, status, recorded_at
      FROM rule_revisions
     WHERE rule_key = ${ruleKey} AND revision = ${revision}
  `.execute(uow.query);
  const row = rows.rows[0];
  if (row === undefined) return null;
  const base = {
    ruleKey: row.rule_key,
    name: row.name,
    ruleSchemaVersion: row.rule_schema_version,
    scope: (row.scope ?? {}) as RuleScope,
    predicate: row.predicate as RuleNode,
  };
  return row.classification === 'HARD'
    ? { ...base, classification: 'HARD' }
    : { ...base, classification: 'SOFT', weight: Number(row.weight) };
}

/** `rule_key` → the revision currently in force. The citation a build records. */
export interface RuleRevisionRef {
  readonly ruleKey: string;
  readonly revision: number;
}

/**
 * The exact revisions of the group's ACTIVE rules, at this instant, inside this
 * transaction.
 *
 * Doc 34 §4-D: "builds and publications record exact rule revisions". Read
 * inside the same unit of work as the operation that records them, so the
 * citation names what the operation actually consumed rather than what was
 * current a moment before.
 *
 * `ruleKeys` narrows to a rule set's members; omitting it takes every active
 * rule, which is what a publication's HARD-rule re-validation evaluates.
 */
export async function currentRuleRevisions(
  uow: Uow,
  ruleKeys?: readonly string[],
): Promise<readonly RuleRevisionRef[]> {
  let query = uow.query
    .selectFrom('rules')
    .select(['rule_key', 'version'])
    .where('status', '=', 'active');
  if (ruleKeys !== undefined) query = query.where('rule_key', 'in', [...ruleKeys]);
  const rows = (await query.orderBy('rule_key').execute()) as unknown as {
    rule_key: string;
    version: number;
  }[];
  return rows.map((row) => ({ ruleKey: row.rule_key, revision: row.version }));
}

/**
 * Compiles a rule set's active members to the canonical solver-input form.
 *
 * **No solve happens here and none can**: `compileRuleSetToCanonicalString` is a
 * pure AST→description translation, and building or searching the model is M4
 * (non-bypass rule 7, the M4 boundary). This exists so the round-trip proof can
 * assert that what was persisted compiles to the same bytes as what was authored.
 *
 * Disabled and archived rules are excluded — that is what disabling a rule
 * MEANS: it stays authored and no build consumes it.
 */
export async function compileActiveRules(uow: Uow, ruleKeys?: readonly string[]): Promise<string> {
  let query = uow.query.selectFrom('rules').select(RULE_COLUMNS).where('status', '=', 'active');
  if (ruleKeys !== undefined) query = query.where('rule_key', 'in', [...ruleKeys]);
  const rows = (await query.orderBy('rule_key').execute()) as unknown as RuleRow[];
  return compileRuleSetToCanonicalString(rows.map(rowToRule), RULE_SCHEMA_VERSION);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rule sets
 * ──────────────────────────────────────────────────────────────────────────── */

const RULE_SET_COLUMNS = ['id', 'name', 'rule_keys', 'status', 'version'] as const;

interface RuleSetRow {
  id: string;
  name: string;
  rule_keys: string[];
  status: 'active' | 'archived';
  version: number;
}

export interface RuleSetView {
  readonly id: string;
  readonly name: string;
  readonly ruleKeys: readonly string[];
  readonly state: 'active' | 'archived';
  /** The CAS token (OPUS-M4-000C). Database-owned, absent from the UPDATE grant. */
  readonly version: number;
}

function ruleSetToWire(row: RuleSetRow): RuleSetView {
  return {
    id: row.id,
    name: row.name,
    ruleKeys: row.rule_keys,
    state: row.status,
    version: row.version,
  };
}

/** The zero-rows discriminator for rule sets. Same reasoning as `staleOrMissing`. */
async function ruleSetStaleOrMissing(uow: Uow, id: string): Promise<RuleOutcome<never>> {
  const current = (await uow.query
    .selectFrom('rule_sets')
    .select(['version', 'status'])
    .where('id', '=', id)
    .executeTakeFirst()) as unknown as { version: number; status: string } | undefined;
  if (current === undefined || current.status === 'archived') return { kind: 'not-found' };
  return { kind: 'stale', currentVersion: current.version };
}

export async function listRuleSets(uow: Uow): Promise<readonly RuleSetView[]> {
  const rows = (await uow.query
    .selectFrom('rule_sets')
    .select(RULE_SET_COLUMNS)
    .orderBy('name')
    .execute()) as unknown as RuleSetRow[];
  return rows.map(ruleSetToWire);
}

/**
 * Creates a rule set. Every named key must resolve to a rule **in this group** —
 * checked with a read inside the same unit of work, so RLS decides what "exists"
 * means and a key from another group is simply not found (T-05b: the caller
 * cannot tell "no such rule" from "not yours").
 */
export async function createRuleSet(
  uow: Uow,
  body: RuleSetWriteRequest,
): Promise<RuleOutcome<RuleSetView>> {
  const missing = await unresolvedKeys(uow, body.ruleKeys);
  if (missing.length > 0) {
    return {
      kind: 'invalid',
      problems: missing.map((key) => ({
        path: 'ruleKeys',
        // The key is echoed because the caller just sent it — reaching here
        // required passing the evaluator in this group, so nothing is disclosed.
        message: `No rule in this group has the key ${key}.`,
      })),
    };
  }

  const tenant = tenantOf(uow.context);
  const inserted = (await uow.query
    .insertInto('rule_sets')
    .values({ id: randomUUID(), ...tenant, name: body.name, rule_keys: [...body.ruleKeys] })
    .returning(RULE_SET_COLUMNS)
    .executeTakeFirstOrThrow()) as unknown as RuleSetRow;
  return { kind: 'ok', value: ruleSetToWire(inserted) };
}

export async function updateRuleSet(
  uow: Uow,
  id: string,
  body: RuleSetWriteRequest,
  expectedVersion: number,
): Promise<RuleOutcome<RuleSetView>> {
  const missing = await unresolvedKeys(uow, body.ruleKeys);
  if (missing.length > 0) {
    return {
      kind: 'invalid',
      problems: missing.map((key) => ({
        path: 'ruleKeys',
        message: `No rule in this group has the key ${key}.`,
      })),
    };
  }
  const updated = (await uow.query
    .updateTable('rule_sets')
    .set({ name: body.name, rule_keys: [...body.ruleKeys], updated_at: new Date() })
    .where('id', '=', id)
    .where('status', '=', 'active')
    // A rule set IS a list, and last-write-wins on a list is the union failure
    // mode by another route: two editors adding one key each, and one key
    // silently disappearing. The single-statement CAS refuses the loser.
    .where('version', '=', expectedVersion)
    .returning(RULE_SET_COLUMNS)
    .executeTakeFirst()) as unknown as RuleSetRow | undefined;
  return updated === undefined
    ? ruleSetStaleOrMissing(uow, id)
    : { kind: 'ok', value: ruleSetToWire(updated) };
}

export async function archiveRuleSet(
  uow: Uow,
  id: string,
  expectedVersion: number,
): Promise<RuleOutcome<RuleSetView>> {
  const updated = (await uow.query
    .updateTable('rule_sets')
    .set({ status: 'archived', updated_at: new Date() })
    .where('id', '=', id)
    .where('status', '=', 'active')
    .where('version', '=', expectedVersion)
    .returning(RULE_SET_COLUMNS)
    .executeTakeFirst()) as unknown as RuleSetRow | undefined;
  return updated === undefined
    ? ruleSetStaleOrMissing(uow, id)
    : { kind: 'ok', value: ruleSetToWire(updated) };
}

async function unresolvedKeys(uow: Uow, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await uow.query
    .selectFrom('rules')
    .select('rule_key')
    .where('rule_key', 'in', [...keys])
    .execute();
  const present = new Set(rows.map((row) => row.rule_key));
  return keys.filter((key) => !present.has(key));
}
