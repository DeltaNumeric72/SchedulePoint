import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';
import {
  CONNECTION_OWNERS,
  scanForDirectTenantAccess,
  type DirectAccessFinding,
} from '../support/tenant-access-scan.js';

/**
 * **Architecture scan — non-bypass rule 1 and I-15, enforced statically.**
 *
 * > never bypass the unit-of-work. Outside it, RLS returns zero rows — **if you
 * > are tempted to "just add a direct query," that is the failure mode, not the
 * > workaround**.
 *
 * The rule, the allow-list, and the reasoning all live in
 * `test/support/tenant-access-scan.ts`. **This file calls that scanner and
 * nothing else** — including in the red cases, which point the *same* function
 * at handler-shaped fixtures on disk. An earlier version re-declared the
 * patterns locally, so the red case exercised a copy and would have passed while
 * the real scan was broken; the independent review caught it, and the fix is one
 * implementation rather than a more careful copy.
 */

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-direct-access-'));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function describeFindings(findings: readonly DirectAccessFinding[]): string {
  return findings.map((f) => `${f.file}:${String(f.line)} ${f.detail}`).join('\n');
}

describe('no tenant access outside the unit of work (I-15)', () => {
  it('GREEN: no module outside the connection owners touches a connection or a tenant table', () => {
    const findings = scanForDirectTenantAccess(SRC);
    expect(findings, describeFindings(findings)).toEqual([]);
    log(
      `scanned apps/api/src; ${String(CONNECTION_OWNERS.length)} permitted connection owner(s): ${CONNECTION_OWNERS.map((o) => o.file).join(', ')}`,
    );
  });

  it('RED: the REAL scanner flags a direct query in a handler-shaped module', () => {
    // The fixture is a plausible handler — the shape someone actually writes when
    // they decide a repository call is too much ceremony for one lookup.
    const dir = scratch();
    writeFileSync(
      join(dir, 'shortcut.handler.ts'),
      [
        "import pg from 'pg';",
        '',
        'export async function listMemberships(pool: pg.Pool, organizationId: string) {',
        '  const client = await pool.connect();',
        '  try {',
        "    const rows = await client.query('select id from memberships where organization_id = $1', [",
        '      organizationId,',
        '    ]);',
        '    return rows.rows;',
        '  } finally {',
        '    client.release();',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const findings = scanForDirectTenantAccess(dir);
    const details = findings.map((f) => f.detail);

    expect(
      findings.length,
      'the scanner found nothing in a file that violates every rule',
    ).toBeGreaterThan(0);
    expect(details).toContain('imports the pg driver outside the unit of work');
    expect(details).toContain('checks out a connection outside the unit of work');
    expect(details).toContain('issues a raw statement outside the unit of work');
    expect(details).toContain('names the tenant table `memberships` in a SQL string literal');
    log(`red case: ${String(findings.length)} finding(s) — ${[...new Set(details)].join(' · ')}`);
  });

  it('RED: each detector fires on its own, so no one of them is carrying the others', () => {
    // Four separate fixtures rather than one. If a single detector's pattern were
    // broken, the combined fixture above would still trip the other three and the
    // red case would pass — which is how a decorative check survives.
    const cases: readonly { name: string; source: string; expected: string }[] = [
      {
        name: 'driver-import.ts',
        source: "import pg from 'pg';\nexport const x = pg;\n",
        expected: 'imports the pg driver outside the unit of work',
      },
      {
        name: 'checkout.ts',
        source:
          'export async function f(p: { connect(): Promise<unknown> }) { return p.connect(); }\n',
        expected: 'checks out a connection outside the unit of work',
      },
      {
        name: 'raw-query.ts',
        source:
          'export async function f(client: { query(t: string): Promise<unknown> }) { return client.query("select 1"); }\n',
        expected: 'issues a raw statement outside the unit of work',
      },
      {
        name: 'tenant-sql.ts',
        source: 'export const statement = "select id from organizations";\n',
        expected: 'names the tenant table `organizations` in a SQL string literal',
      },
    ];

    for (const testCase of cases) {
      const dir = scratch();
      writeFileSync(join(dir, testCase.name), testCase.source, 'utf8');
      expect(
        scanForDirectTenantAccess(dir).map((f) => f.detail),
        `${testCase.name}: detector did not fire`,
      ).toContain(testCase.expected);
    }
  });

  it('GREEN: a type-only pg import is not a violation — it holds no connection', () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'types-only.ts'),
      "import type pg from 'pg';\nexport type P = pg.Pool;\n",
      'utf8',
    );
    expect(scanForDirectTenantAccess(dir)).toEqual([]);
  });

  it('the allow-list exempts real files, and each entry has a recorded reason', () => {
    // An allow-list entry naming a file that no longer exists is an exemption
    // nobody is checking, and it would silently widen if that path were recreated.
    for (const owner of CONNECTION_OWNERS) {
      expect(
        statSync(join(SRC, owner.file)).isFile(),
        `${owner.file} is exempted but does not exist`,
      ).toBe(true);
      expect(owner.reason.length, `${owner.file} has no recorded reason`).toBeGreaterThan(30);
      // None is under `http/` or `jobs/`: a request handler that owns a
      // connection is the failure this rule prevents.
      expect(owner.file.startsWith('db/'), `${owner.file} is not in the db layer`).toBe(true);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The remaining scans are narrow enough to live inline — and each carries its
 * own red case, in the same block, for the same reason.
 * ──────────────────────────────────────────────────────────────────────────── */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const AMBIENT_TENANT_PATTERNS: readonly RegExp[] = [
  /\bactiveGroupId\b/,
  /\bactiveOrganizationId\b/,
  /\bcurrentGroupId\b/,
  /\bcurrentOrganizationId\b/,
  /\bsession\s*\.\s*group\b/,
  /\bsession\s*\.\s*organization\b/,
  /\bdefaultGroupId\b/,
  /\bdefaultOrganizationId\b/,
];

describe('no ambient tenant state (SPEC-01 §3.1)', () => {
  it('nothing reads a session-global active organization or active group', () => {
    // > The session stores `principal_user_id`, `session_epoch`, and
    // > authentication facts. **It stores no active organization and no active
    // > group.**
    //
    // The CAR-001 remediation is an ABSENCE, and an absence is exactly the kind
    // of property that quietly stops being true.
    const findings: string[] = [];
    for (const absolute of walk(SRC)) {
      if (!absolute.endsWith('.ts')) continue;
      const file = relative(SRC, absolute).replaceAll('\\', '/');
      readFileSync(absolute, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
          for (const pattern of AMBIENT_TENANT_PATTERNS) {
            if (pattern.test(code)) findings.push(`${file}:${String(index + 1)} ${text.trim()}`);
          }
        });
    }
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('RED: the ambient-tenant patterns match the code they exist to catch', () => {
    const offenders = [
      'const groupId = session.activeGroupId;',
      'return req.session.organization;',
      'const org = user.defaultOrganizationId ?? null;',
    ];
    for (const offender of offenders) {
      expect(
        AMBIENT_TENANT_PATTERNS.some((pattern) => pattern.test(offender)),
        `no pattern matched: ${offender}`,
      ).toBe(true);
    }
  });

  it('the only shipped principal resolver denies, and no header-based one exists in src', () => {
    const findings: string[] = [];
    for (const absolute of walk(SRC)) {
      if (!absolute.endsWith('.ts')) continue;
      // A resolver that reads a principal out of a header, an environment
      // variable or a query parameter is an authentication bypass waiting for a
      // misconfiguration. There is none, and there must remain none.
      if (/authenticated:\s*true/.test(readFileSync(absolute, 'utf8'))) {
        findings.push(relative(SRC, absolute));
      }
    }
    expect(
      findings,
      `these modules construct an AUTHENTICATED principal: ${findings.join(', ')}`,
    ).toEqual([]);
  });
});

describe('set_config is always transaction-local', () => {
  const NON_LOCAL = /set_config\s*\([^)]*,\s*false\s*\)/i;

  it('no call site passes `false` as the third argument', () => {
    // `set_config(name, value, false)` is the SESSION form under another name: it
    // survives the transaction and the next borrower of the pooled connection
    // inherits it. The lint rule catches every `SET` statement form; this covers
    // the function form's third argument, which lint cannot see.
    const findings: string[] = [];
    for (const absolute of walk(SRC)) {
      if (!absolute.endsWith('.ts')) continue;
      const file = relative(SRC, absolute).replaceAll('\\', '/');
      readFileSync(absolute, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          if (NON_LOCAL.test(text)) findings.push(`${file}:${String(index + 1)}`);
        });
    }
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('RED: the pattern catches the session form and spares the transaction-local one', () => {
    expect(NON_LOCAL.test("select set_config('app.organization_id', $1, false)")).toBe(true);
    expect(NON_LOCAL.test("select set_config('app.organization_id', $1, true)")).toBe(false);
  });
});
