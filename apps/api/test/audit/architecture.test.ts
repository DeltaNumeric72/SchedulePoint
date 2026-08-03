import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONNECTION_OWNERS } from '../support/tenant-access-scan.js';
import { log } from '../support/harness.js';

/**
 * The static half of non-bypass rule 6, and the price of two exemptions.
 *
 * ## Why this file exists
 *
 * `test/architecture/no-tenant-access-outside-unit-of-work.test.ts` enforces
 * I-15 by scanning every module under `src/` for a connection checkout or a
 * tenant-table name, with a short allowlist of **connection owners**, every
 * entry of which must live in the `db/` layer.
 *
 * OPUS-M1-003 adds two entries — `db/queue-schema.ts` and `db/queue-pools.ts`.
 * They were originally written under `outbox/` and `jobs/`, which would have
 * required relaxing the "connection owners live in `db/`" assertion; they were
 * MOVED instead. Weakening an architecture test to accommodate new code is
 * non-bypass rule 10's failure mode, and it is the one that always looks
 * reasonable at the time.
 *
 * An entry in that allowlist still exempts a file from **every** detector,
 * including the tenant-table ones, and an allowlist that is never re-narrowed is
 * how a scan stops meaning anything. So each exemption is paid for below.
 *
 * | Assertion | What it stops |
 * |---|---|
 * | the two exempt files name **no** tenant table | an exemption granted for `queue_pools` being used to reach `memberships` |
 * | `audit_events`, `audit_checkpoints` and `audit_chain_heads` are named **only** inside `src/audit/**` | an audit write appearing in a route, a job handler or a helper — non-bypass rule 6 as a scan rather than a review habit |
 * | no module names `audit_chain_heads` at all | the chain tip being touched from TypeScript. It is the `SECURITY DEFINER` trigger's, and nothing else's |
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/** The tenant tables migration 0001 created. Named here, not imported, so that
 *  a change to the shared registry cannot silently shrink this assertion. */
const TENANT_TABLES = ['organizations', 'groups', 'users', 'memberships'] as const;

const AUDIT_TABLES = ['audit_events', 'audit_checkpoints', 'audit_chain_heads'] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function sourceFiles(): { file: string; code: string }[] {
  return walk(SRC)
    .filter((f) => f.endsWith('.ts'))
    .map((absolute) => {
      const raw = readFileSync(absolute, 'utf8');
      // Comments discuss these tables constantly; the scan is about code.
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      return { file: relative(SRC, absolute).replaceAll('\\', '/'), code };
    });
}

const OPUS_M1_003_EXEMPTIONS = ['db/queue-schema.ts', 'db/queue-pools.ts'] as const;

describe('the price of the OPUS-M1-003 connection-owner exemptions', () => {
  it('both exemptions are declared, with a reason', () => {
    for (const file of OPUS_M1_003_EXEMPTIONS) {
      const owner = CONNECTION_OWNERS.find((o) => o.file === file);
      expect(owner, `${file} must be declared as a connection owner`).toBeDefined();
      expect(owner?.reason.length ?? 0).toBeGreaterThan(40);
    }
  });

  it('neither exempt file names a TENANT table', () => {
    const files = sourceFiles();
    const violations: string[] = [];
    for (const file of OPUS_M1_003_EXEMPTIONS) {
      const found = files.find((f) => f.file === file);
      expect(found, `${file} not found under src/`).toBeDefined();
      for (const table of TENANT_TABLES) {
        const pattern = new RegExp(
          String.raw`['"\`][^'"\`]*\b(?:from|into|update|join)\s+${table}\b`,
          'i',
        );
        if (pattern.test(found?.code ?? '')) {
          violations.push(`${file} names the tenant table ${table}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
    log(
      `${String(OPUS_M1_003_EXEMPTIONS.length)} exempt modules, 0 tenant-table references — ` +
        'the exemption is paid for',
    );
  });
});

describe('non-bypass rule 6, as a scan', () => {
  it('the audit tables are named ONLY inside src/audit', () => {
    const offenders = sourceFiles()
      .filter((f) => !f.file.startsWith('audit/'))
      .flatMap((f) =>
        AUDIT_TABLES.filter((t) =>
          new RegExp(String.raw`['"\`][^'"\`]*\b(?:from|into|update|join)\s+${t}\b`, 'i').test(
            f.code,
          ),
        ).map((t) => `${f.file} names ${t}`),
      );
    expect(offenders, offenders.join('\n')).toEqual([]);
    log('no module outside src/audit names an audit table in SQL');
  });

  it('NO module names audit_chain_heads — the chain tip belongs to the trigger', () => {
    const offenders = sourceFiles()
      .filter((f) => /\baudit_chain_heads\b/.test(f.code))
      .map((f) => f.file);
    expect(offenders, offenders.join('\n')).toEqual([]);
    log('audit_chain_heads appears in no TypeScript module at all');
  });

  it('no module issues an UPDATE or DELETE against audit_events', () => {
    // Belt and braces over the grant and the trigger: a statement that cannot
    // succeed should also not exist, because a caller writing one is a caller
    // who believes the audit trail is editable.
    const offenders = sourceFiles()
      .filter((f) =>
        /['"`][^'"`]*\b(?:update\s+audit_events|delete\s+from\s+audit_events|truncate\s+(?:table\s+)?audit_events)\b/i.test(
          f.code,
        ),
      )
      .map((f) => f.file);
    expect(offenders, offenders.join('\n')).toEqual([]);
    log('no module contains an UPDATE, DELETE or TRUNCATE against audit_events');
  });
});
