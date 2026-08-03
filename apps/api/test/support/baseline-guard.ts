import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';

import { adminClient } from './admin-client.js';
import { CLUSTER_PORT } from './env.js';
import { BASELINE_ORGANIZATIONS, FIXTURE } from './fixtures.js';

/* ────────────────────────────────────────────────────────────────────────────
 * FAD-15 Layer 1 — the shared baseline is read-only, and this is what enforces it.
 *
 * `globalSetup` digests the baseline immediately after seeding it. `setup-env.ts`
 * re-digests it after **every** test file and fails the run if anything moved,
 * naming the file and the table.
 *
 * ## Why after every file rather than once at the end
 *
 * A run-level check says "somebody wrote to the baseline". A per-file check says
 * WHICH file, which is the difference between a finding and a hunt. It also
 * works under `--sequence.shuffle.files`, where "the end" is not a fixed place.
 *
 * ## What counts as the baseline
 *
 * Every row of every public table that belongs to one of the two baseline
 * organizations, plus the baseline's `users` rows (`users` is global by
 * PO-DEC-06 and has no `organization_id`). Membership of the set is decided by
 * asking the catalogue which tables carry an `organization_id`, not by a
 * hand-maintained list that a later migration would silently outdate.
 *
 * Rows belonging to an OWNED fixture are deliberately invisible to this check —
 * they are exactly what Layer 2 exists to allow.
 *
 * ## Row identity
 *
 * `md5(row::text)`, compared as a multiset. An in-place UPDATE therefore shows up
 * as one row gone and one row arrived, which is the honest reading: to a test
 * that had memorised the old row, an UPDATE and a delete/insert pair are the
 * same event. The freshness-counter bump that coupled X-07 during OPUS-M1-004 is
 * precisely this shape, and it is what this control is for.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BaselineDigest {
  /** `schema.table` → the sorted md5 of every baseline row in it. */
  readonly tables: Record<string, string[]>;
}

/** Keyed by port so a nested harness (the exit-code red case) cannot overwrite ours. */
function digestPath(): string {
  return join(tmpdir(), `schedulepoint-baseline-${String(CLUSTER_PORT)}.json`);
}

const BASELINE_USER_IDS: readonly string[] = [
  ...Object.values(FIXTURE.alpha.users).map((user) => user.id),
  ...Object.values(FIXTURE.beta.users).map((user) => user.id),
];

async function digestWith(client: pg.Client): Promise<BaselineDigest> {
  const organizationIds = [...BASELINE_ORGANIZATIONS];

  const tables = await client.query<{ schemaname: string; tablename: string }>(
    `select t.schemaname, t.tablename
       from pg_tables t
       join information_schema.columns c
         on c.table_schema = t.schemaname
        and c.table_name = t.tablename
        and c.column_name = 'organization_id'
      where t.schemaname not in ('pg_catalog', 'information_schema')
      order by 1, 2`,
  );

  const result: Record<string, string[]> = {};

  for (const { schemaname, tablename } of tables.rows) {
    // Identifiers cannot be bind parameters. Both halves come from the
    // catalogue of this same cluster, never from input, and are quoted.
    const rows = await client.query<{ h: string }>(
      `select md5(t::text) as h from "${schemaname}"."${tablename}" t
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    result[`${schemaname}.${tablename}`] = rows.rows.map((row) => row.h).sort();
  }

  // `organizations` is keyed by `id`, and `users` is global — neither is caught
  // by the `organization_id` sweep above.
  const organizations = await client.query<{ h: string }>(
    'select md5(t::text) as h from organizations t where id = any($1::uuid[])',
    [organizationIds],
  );
  result['public.organizations'] = organizations.rows.map((row) => row.h).sort();

  const users = await client.query<{ h: string }>(
    'select md5(t::text) as h from users t where id = any($1::uuid[])',
    [BASELINE_USER_IDS],
  );
  result['public.users'] = users.rows.map((row) => row.h).sort();

  return { tables: result };
}

/** Digest the baseline and record it as the reference. Called once, after the seed. */
export async function captureBaselineDigest(): Promise<BaselineDigest> {
  const client = adminClient();
  await client.connect();
  try {
    const digest = await digestWith(client);
    const total = Object.values(digest.tables).reduce((sum, rows) => sum + rows.length, 0);
    if (total === 0) {
      throw new Error(
        'baseline digest is empty — the guard would pass vacuously for the rest of the run',
      );
    }
    writeFileSync(digestPath(), JSON.stringify(digest), 'utf8');
    writeFileSync(previousPath(), JSON.stringify(digest), 'utf8');
    return digest;
  } finally {
    await client.end();
  }
}

export function readBaselineDigest(): BaselineDigest | undefined {
  try {
    return JSON.parse(readFileSync(digestPath(), 'utf8')) as BaselineDigest;
  } catch {
    return undefined;
  }
}

/** The state as of the previous file, so a violation can name its actual author. */
function previousPath(): string {
  return join(tmpdir(), `schedulepoint-baseline-${String(CLUSTER_PORT)}-previous.json`);
}

function readPreviousDigest(): BaselineDigest | undefined {
  try {
    return JSON.parse(readFileSync(previousPath(), 'utf8')) as BaselineDigest;
  } catch {
    return undefined;
  }
}

function writePreviousDigest(digest: BaselineDigest): void {
  writeFileSync(previousPath(), JSON.stringify(digest), 'utf8');
}

/** Multiset difference: how many hashes appear in `b` that `a` did not have. */
function surplus(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const hash of a) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  let extra = 0;
  for (const hash of b) {
    const remaining = counts.get(hash) ?? 0;
    if (remaining > 0) counts.set(hash, remaining - 1);
    else extra += 1;
  }
  return extra;
}

/** Every way the current state differs from the reference, in reader-facing prose. */
export function baselineViolations(
  reference: BaselineDigest,
  current: BaselineDigest,
): readonly string[] {
  const names = new Set([...Object.keys(reference.tables), ...Object.keys(current.tables)]);
  const problems: string[] = [];
  for (const name of [...names].sort()) {
    const before = reference.tables[name] ?? [];
    const after = current.tables[name] ?? [];
    const appeared = surplus(before, after);
    const vanished = surplus(after, before);
    if (appeared === 0 && vanished === 0) continue;
    problems.push(
      `${name}: ${String(appeared)} row(s) appeared, ${String(vanished)} row(s) removed or ` +
        `modified in place (${String(before.length)} -> ${String(after.length)})`,
    );
  }
  return problems;
}

/**
 * Throws if the shared baseline changed. `label` is the test file, so the failure
 * names the culprit rather than the run.
 */
export async function assertBaselineUnchanged(label: string): Promise<void> {
  const reference = readBaselineDigest();
  if (reference === undefined) {
    // Not "pass because we cannot tell". A missing reference means the guard is
    // inert, and an inert control that reports success is the failure mode this
    // whole task exists to remove.
    throw new Error(
      `baseline reference digest is missing (${digestPath()}). The Layer 1 control cannot ` +
        'run, so it fails rather than passing vacuously.',
    );
  }

  const client = adminClient();
  await client.connect();
  let current: BaselineDigest;
  try {
    current = await digestWith(client);
  } finally {
    await client.end();
  }

  const cumulative = baselineViolations(reference, current);
  // What THIS file changed, as distinct from what the run has accumulated. Without
  // it, the first offender damages the baseline and every innocent file after it
  // is reported as the culprit — which is a hunt, not a finding.
  const previous = readPreviousDigest() ?? reference;
  const own = baselineViolations(previous, current);
  writePreviousDigest(current);

  if (cumulative.length === 0) return;

  const section = (title: string, problems: readonly string[]): string =>
    `\n  ${title}\n` +
    (problems.length === 0
      ? '    (none)\n'
      : `${problems.map((problem) => `    - ${problem}`).join('\n')}\n`);

  throw new Error(
    `FAD-15 Layer 1 violated: the shared read-only baseline has changed.\n` +
      `  file: ${label}\n` +
      section('CHANGED BY THIS FILE:', own) +
      section('CUMULATIVE since the seed (an earlier file may own these):', cumulative) +
      '\n  The shared MULTI fixture is read-only. A test that needs to write must call\n' +
      "  ownedMulti('<slug>') and work in its own tenant (apps/api/test/support/owned-multi.ts).",
  );
}
