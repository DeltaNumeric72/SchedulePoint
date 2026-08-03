import { appendFileSync } from 'node:fs';

import { adminClient } from '../support/admin-client.js';
import { setup as realSetup, teardown as realTeardown } from '../support/global-setup.js';

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M2-001 phase A — the NR-13 mutation census (MEASUREMENT INSTRUMENT).
 *
 * NR-13 is "shared-fixture coupling": 551 tests across 36 files share one
 * cluster and one seeded fixture, and three order/state couplings were found and
 * point-fixed in OPUS-M1-004 alone. Choosing between per-test transactional
 * rollback and dedicated organizations needs a number that nobody has: **how
 * much shared state does each test file actually change?** A file that leaves
 * the fixture byte-identical cannot couple to anything; a file that rewrites
 * `memberships` can couple to everything downstream of it.
 *
 * This wraps the real `globalSetup` — it does not replace it, and it changes no
 * behaviour the tests can observe. It takes a row-level digest of every table
 * immediately after the real seed, takes it again after the last test file has
 * finished, and writes the difference. The cluster is still up at that point
 * because `teardown` here runs before the real one.
 *
 * It is loaded ONLY by `apps/api/vitest.nr13.config.ts`. The production test
 * config is untouched, so no measurement code runs in `pnpm check`.
 *
 * The digest is `md5(row::text)` per row, compared as a multiset. A modified row
 * therefore shows up as one removed and one added — which is the honest reading:
 * from the point of view of a later test that had memorised the old row, an
 * in-place UPDATE and a delete/insert pair are the same event.
 * ──────────────────────────────────────────────────────────────────────────── */

interface TableDigest {
  readonly qualified: string;
  readonly hashes: readonly string[];
}

type Census = ReadonlyMap<string, TableDigest>;

const OUTPUT_PATH = process.env['SP_NR13_OUT'];
const LABEL = process.env['SP_NR13_LABEL'] ?? '(unlabelled)';

async function census(): Promise<Census> {
  const client = adminClient();
  await client.connect();
  try {
    const tables = await client.query<{ schemaname: string; tablename: string }>(
      `select schemaname, tablename
         from pg_tables
        where schemaname not in ('pg_catalog', 'information_schema')
        order by schemaname, tablename`,
    );

    const result = new Map<string, TableDigest>();
    for (const { schemaname, tablename } of tables.rows) {
      // Identifiers cannot be bind parameters. Both halves come from
      // `pg_tables` in this same cluster, never from input, and are quoted.
      const qualified = `"${schemaname}"."${tablename}"`;
      const rows = await client.query<{ h: string }>(
        `select md5(t::text) as h from ${qualified} t`,
      );
      result.set(`${schemaname}.${tablename}`, {
        qualified,
        hashes: rows.rows.map((row) => row.h),
      });
    }
    return result;
  } finally {
    await client.end();
  }
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

let before: Census | undefined;

export async function setup(): Promise<void> {
  await realSetup();
  before = await census();
}

export async function teardown(): Promise<void> {
  try {
    const after = await census();
    const lines: string[] = [];
    let changedTables = 0;
    let addedTotal = 0;
    let removedTotal = 0;

    for (const [name, afterDigest] of after) {
      const beforeHashes = before?.get(name)?.hashes ?? [];
      const added = surplus(beforeHashes, afterDigest.hashes);
      const removed = surplus(afterDigest.hashes, beforeHashes);
      if (added === 0 && removed === 0) continue;
      changedTables += 1;
      addedTotal += added;
      removedTotal += removed;
      lines.push(
        `    ${name}: +${String(added)} -${String(removed)} ` +
          `(${String(beforeHashes.length)} -> ${String(afterDigest.hashes.length)} rows)`,
      );
    }

    const report =
      `FILE ${LABEL}\n` +
      `  tables changed: ${String(changedTables)}  rows appeared: ${String(addedTotal)}  ` +
      `rows vanished-or-modified: ${String(removedTotal)}\n` +
      (lines.length > 0 ? `${lines.join('\n')}\n` : '    (fixture byte-identical)\n');

    if (OUTPUT_PATH === undefined) process.stdout.write(report);
    else appendFileSync(OUTPUT_PATH, report);
  } finally {
    await realTeardown();
  }
}
