import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { resolveTestPgPort } from '../sbx/test-port.mjs';

/**
 * `pnpm red-cases` — proof that every gate actually fails.
 *
 * ## Why this exists
 *
 * A gate that has only ever been observed passing is not evidence of anything.
 * A regex with a typo, a config with a wrong path, a check that scans an empty
 * directory — all of them report PASS forever, and the first time anyone finds
 * out is when the thing the gate was supposed to prevent ships.
 *
 * So each gate ships with a violation that must make it fail, and this runner
 * proves both directions in one pass:
 *
 *   GREEN  the gate passes on the clean tree
 *   RED    the gate fails once the violation is introduced
 *
 * A gate that fails its GREEN check is broken. A gate that passes its RED check
 * is worse: it is decorative.
 *
 * ## How the violation is introduced
 *
 * Wherever possible the fixture is copied **into the real working tree** and the
 * **real gate command** is run against it — not a parallel copy of the config,
 * not a fixture directory the gate would never look at. Three gates cannot work
 * that way and say so explicitly:
 *
 *  - `invariant-ids` scans `docs/architecture`, which this task may not modify,
 *    so it targets a fixture directory via the gate's own `--dir` flag;
 *  - `secret-scan` would otherwise have to commit a key-shaped string into a
 *    scanned path, so it targets a fixture directory with `--no-exclude`;
 *  - `request-budget` reads recordings produced by the browser run, so it
 *    targets a fixture directory containing a copy of the budget shape.
 *
 * Everything injected is named `__red_case__*` and gitignored, and the runner
 * clears leftovers before it starts and restores every patched file afterwards.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = dirname(fileURLToPath(import.meta.url));
const PM_EXECPATH = process.env['npm_execpath'];

/**
 * @typedef {{ from: string, to: string }} Injection
 * @typedef {{ file: string, find: string, replace: string }} Patch
 * @typedef {{
 *   id: string,
 *   gate: string,
 *   violation: string,
 *   greenCommand: string[],
 *   redCommand: string[],
 *   inject?: Injection[],
 *   patch?: Patch[],
 *   prepare?: string[][],
 *   restore?: string[][],
 * }} RedCase
 */

/** @type {RedCase[]} */
const CASES = [
  {
    id: 'lint',
    gate: 'lint (eslint)',
    violation: 'a SET LOCAL tenant-context statement in API source',
    inject: [
      { from: 'lint/fixture/set-local.ts', to: 'apps/api/src/http/__red_case__set-local.ts' },
    ],
    greenCommand: ['run', 'gate:lint'],
    redCommand: ['run', 'gate:lint'],
  },
  {
    id: 'typecheck',
    gate: 'typecheck (tsc -b)',
    violation: 'a string returned from a function declared to return number',
    inject: [
      { from: 'typecheck/fixture/type-error.ts', to: 'packages/contracts/src/__red_case__type.ts' },
    ],
    greenCommand: ['run', 'gate:typecheck'],
    redCommand: ['run', 'gate:typecheck'],
  },
  {
    id: 'unit',
    gate: 'unit tests (vitest)',
    violation: 'a failing assertion in the domain package',
    inject: [
      { from: 'unit/fixture/failing.test.ts', to: 'packages/domain/test/__red_case__.test.ts' },
    ],
    greenCommand: ['run', 'gate:unit'],
    redCommand: ['run', 'gate:unit'],
  },
  {
    id: 'import-boundary',
    gate: 'import boundary (dependency-cruiser)',
    violation: 'packages/domain importing from apps/api',
    inject: [
      {
        from: 'import-boundary/fixture/infra-import.ts',
        to: 'packages/domain/src/__red_case__infra.ts',
      },
    ],
    greenCommand: ['run', 'gate:import-boundary'],
    redCommand: ['run', 'gate:import-boundary'],
  },
  {
    id: 'route-policy',
    gate: 'route-without-policy (I-02)',
    violation: 'POST /red-case/undeclared registered with no config.policy',
    inject: [
      {
        from: 'route-policy/fixture/undeclared.route.ts',
        to: 'apps/api/src/http/routes/__red_case__undeclared.route.ts',
      },
    ],
    greenCommand: ['run', 'gate:route-policy'],
    redCommand: ['run', 'gate:route-policy'],
  },
  {
    id: 'migration-rls',
    gate: 'migration + RLS pairing (I-15)',
    violation: 'CREATE TABLE with organization_id and no RLS policy',
    inject: [
      {
        from: 'migration-rls/fixture/001_no_rls.sql',
        to: 'apps/api/migrations/__red_case__001_no_rls.sql',
      },
    ],
    greenCommand: ['run', 'gate:migration-rls'],
    redCommand: ['run', 'gate:migration-rls'],
  },
  {
    id: 'invariant-ids',
    gate: 'invariant-ID uniqueness (CAR-023)',
    violation: 'I-05 defined with two different meanings in two documents',
    greenCommand: ['run', 'gate:invariant-ids'],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/invariant-id-uniqueness.mjs',
      '--dir',
      'scripts/red-cases/invariant-ids/fixture',
    ],
  },
  {
    id: 'rule-node-mapping',
    gate: 'rule-node → compiler-mapping closure (SPEC-04 §3.2)',
    violation: 'an AST node kind declared with no compiler mapping',
    // Add a node to the declared closed set without a compiler `case` for it.
    // TypeScript exhaustiveness would also catch this, but the point of the gate
    // is an independent build-failing check: it must fire on its own. The gate
    // scans source, so no rebuild is needed and the red arm is self-contained.
    patch: [
      {
        file: 'packages/domain/src/rules/ast.ts',
        find: "  'ProtectedRange',\n] as const satisfies readonly RuleNodeKind[];",
        replace:
          "  'ProtectedRange',\n  'UnmappedProbe',\n] as const satisfies readonly RuleNodeKind[];",
      },
    ],
    greenCommand: ['run', 'gate:rule-node-mapping'],
    redCommand: ['run', 'gate:rule-node-mapping'],
  },
  {
    id: 'corpus-tamper',
    gate: 'B-* corpus regeneration byte-identity (SPEC-04 §8)',
    violation: 'a committed corpus fixture edited away from its generated form',
    // Tamper with a committed fixture; regeneration produces the original bytes,
    // so the on-disk/regenerated diff must be caught. corpus:check rebuilds the
    // domain dist first so the comparison runs against the real generator.
    patch: [
      {
        file: 'solver/corpus/fixtures/B-feasible-small.json',
        find: '"count":1',
        replace: '"count":2',
      },
    ],
    greenCommand: ['run', 'corpus:check'],
    redCommand: ['run', 'corpus:check'],
  },
  {
    id: 'secret-scan',
    gate: 'secret scan',
    violation: 'AWS key, GitHub token, Stripe key and a DSN password in one file',
    greenCommand: ['run', 'gate:secret-scan'],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/secret-scan.mjs',
      '--dir',
      'scripts/red-cases/secret-scan/fixture',
      '--no-exclude',
    ],
  },
  {
    id: 'network-guard-source',
    gate: 'network-assertion guard (SP-HR-1) — source scan',
    violation: 'fetch() to analytics.example.com in apps/web/src',
    inject: [{ from: 'network-guard/fixture/beacon.ts', to: 'apps/web/src/__red_case__beacon.ts' }],
    greenCommand: ['run', 'gate:network-guard'],
    redCommand: ['run', 'gate:network-guard'],
  },
  {
    id: 'network-guard-bundle',
    gate: 'network-assertion guard (SP-HR-1) — built-bundle scan',
    violation: 'a minified third-party beacon present only in apps/web/dist',
    inject: [
      {
        from: 'network-guard-bundle/fixture/tracker.js',
        to: 'apps/web/dist/assets/__red_case__tracker.js',
      },
    ],
    greenCommand: ['run', 'gate:network-guard'],
    redCommand: ['run', 'gate:network-guard'],
  },
  {
    id: 'build',
    gate: 'production build (vite build)',
    violation: 'an unresolvable import reachable from the entry point',
    inject: [{ from: 'build/fixture/broken.tsx', to: 'apps/web/src/__red_case__broken.tsx' }],
    patch: [
      {
        file: 'apps/web/src/main.tsx',
        find: "import './styles/index.css';",
        replace: "import './styles/index.css';\nimport './__red_case__broken.js';",
      },
    ],
    greenCommand: ['run', 'gate:build'],
    redCommand: ['run', 'gate:build'],
    // The clean bundle has to come back: later gates scan apps/web/dist.
    restore: [['run', 'gate:build']],
  },
  {
    id: 'axe',
    gate: 'axe-core via Playwright (CAP-066)',
    violation: 'an <img> with no alt attribute in the rendered shell',
    patch: [
      {
        file: 'apps/web/src/shell/ShellPage.tsx',
        find: '<main id="main" className="flex flex-col gap-4">',
        replace:
          '<main id="main" className="flex flex-col gap-4">\n          <img src="/red-case.png" width={1} height={1} />',
      },
    ],
    // The gate runs against the production build, so the violation has to be
    // built before it can be observed.
    prepare: [['run', 'gate:build']],
    greenCommand: ['run', 'gate:axe'],
    redCommand: ['run', 'gate:axe'],
    restore: [['run', 'gate:build']],
  },
  {
    id: 'i13-schedule-authoring',
    gate: 'I-13 zero-requests-before-Save, on the schedule surface',
    violation: 'the "New period" control issues a request when it is clicked',
    // I-13 exists because a control labelled New once created a live record on
    // click. The e2e records the requests that one click produces and asserts
    // the list is EMPTY, and the budget for the interaction is 0. This injects
    // exactly the shape the invariant forbids — a click that talks to the
    // server before any form is completed — and the assertion must catch it.
    patch: [
      {
        file: 'apps/web/src/schedule/PeriodsPage.tsx',
        find:
          '            // I-13: local state only. Nothing is created, nothing is fetched.\n' +
          '            setProblems([]);\n' +
          '            setIsAuthoring(true);',
        replace:
          '            void fetch(\'/api/health\');\n' +
          '            setProblems([]);\n' +
          '            setIsAuthoring(true);',
      },
    ],
    // The gate runs against the production build, so the violation has to be
    // built before it can be observed.
    prepare: [['run', 'gate:build']],
    greenCommand: ['run', 'gate:axe'],
    redCommand: ['run', 'gate:axe'],
    // The RED arm leaves a VIOLATING recording on disk — the whole point is that
    // the click issued a request — and the two request-budget cases that follow
    // read those recordings. So the restore rebuilds the clean bundle AND
    // re-measures, or this case silently fails the next two.
    restore: [
      ['run', 'gate:build'],
      ['run', 'gate:axe'],
    ],
  },
  {
    id: 'stale-edit-cas',
    gate: 'server-authoritative compare-and-set (PO-DEC-18)',
    violation: 'the advisory lock removed, leaving the compare-and-set read unserialized',
    // "A stale edit is refused and re-fetched, never silently merged."
    //
    // The violation targets ATOMICITY, not the comparison. An earlier version of
    // this case disarmed the `!==` test, which a sequential test catches — and a
    // sequential test is exactly what missed the real defect. Every unit of work
    // is READ COMMITTED, so removing the lock leaves two concurrent writers
    // reading the same pre-state, both finding their token current, and both
    // writing. That is invisible to any test that does not actually race.
    //
    // `apps/api/test/schedule/authoring-concurrency.test.ts` is what fails here,
    // and it fails with the reviewer's own words: "both writers were accepted".
    patch: [
      {
        file: 'apps/api/src/http/routes/schedule-authoring.route.ts',
        find: '    await lockAnchor(uow, `cell:${versionId}:${date}:${shiftTypeId}`);',
        replace: '    // red case: the cell lock is removed, leaving the CAS read unserialized',
      },
      {
        file: 'apps/api/src/http/routes/schedule-authoring.route.ts',
        find: '    await lockAnchor(uow, `requirement:${periodId}:${date}:${shiftTypeId}`);',
        replace: '    // red case: the requirement lock is removed',
      },
    ],
    greenCommand: ['run', 'gate:unit'],
    redCommand: ['run', 'gate:unit'],
  },
  {
    id: 'request-budget-over',
    gate: 'requests per interaction (SP-HR-2)',
    violation: 'one click recorded as three requests, against a budget of one',
    greenCommand: ['run', 'gate:request-budget'],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/request-budget.mjs',
      '--dir',
      'scripts/red-cases/request-budget/fixture',
    ],
  },
  {
    id: 'request-budget-missing',
    gate: 'requests per interaction (SP-HR-2) — missing measurement',
    violation: 'a budgeted interaction with no recording at all',
    greenCommand: ['run', 'gate:request-budget'],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/request-budget.mjs',
      '--dir',
      'scripts/red-cases/request-budget-missing/fixture',
    ],
  },
];

/** @param {string[]} args */
function pm(args) {
  if (PM_EXECPATH !== undefined && /\.(mjs|cjs|js)$/.test(PM_EXECPATH)) {
    return { command: process.execPath, args: [PM_EXECPATH, ...args] };
  }
  return { command: PM_EXECPATH ?? 'pnpm', args };
}

/** @param {string} text */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * @param {string[]} args
 * @returns {{ ok: boolean, output: string }}
 */
function run(args) {
  const invocation = pm(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return {
    ok: result.status === 0,
    output: stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`),
  };
}

/** @type {Map<string, string>} */
const patchBackups = new Map();
/** @type {string[]} */
const injectedPaths = [];

/** @param {RedCase} testCase */
function applyViolation(testCase) {
  for (const injection of testCase.inject ?? []) {
    const target = resolve(REPO_ROOT, injection.to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(HERE, injection.from), target);
    injectedPaths.push(target);
  }

  for (const patch of testCase.patch ?? []) {
    const target = resolve(REPO_ROOT, patch.file);
    const original = readFileSync(target, 'utf8');
    if (!original.includes(patch.find)) {
      throw new Error(
        `red case "${testCase.id}": anchor not found in ${patch.file}.\nLooking for: ${patch.find}`,
      );
    }
    // The FIRST reading of a file is the one restored. A case with two patches
    // to one file used to back up the already-patched content on the second
    // pass, so `revertViolation` wrote back a half-patched file and left the
    // working tree dirty — observed with `stale-edit-cas`, which disarms the
    // compare-and-set in two places.
    if (!patchBackups.has(target)) patchBackups.set(target, original);
    writeFileSync(target, original.replace(patch.find, patch.replace), 'utf8');
  }
}

function revertViolation() {
  for (const [target, original] of patchBackups) writeFileSync(target, original, 'utf8');
  patchBackups.clear();
  for (const target of injectedPaths) rmSync(target, { force: true });
  injectedPaths.length = 0;
}

/** Clears anything a previous interrupted run may have left behind. */
function clearStaleInjections() {
  /** @type {string[]} */
  const stale = [];
  for (const testCase of CASES) {
    for (const injection of testCase.inject ?? []) {
      const target = resolve(REPO_ROOT, injection.to);
      if (existsSync(target)) {
        rmSync(target, { force: true });
        stale.push(injection.to);
      }
    }
  }
  if (stale.length > 0) {
    process.stdout.write(
      `Cleared stale red-case injections:\n${stale.map((s) => `  ${s}\n`).join('')}\n`,
    );
  }
}

/**
 * Is anything listening on `127.0.0.1:port` right now?
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portIsHeld(port) {
  return new Promise((resolveProbe) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (held) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(held);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Waits until this worktree's embedded-postgres port is free again (U-04).
 *
 * ## The transient this removes
 *
 * The `unit` red case's **GREEN arm** runs the real `gate:unit`, which starts the
 * embedded cluster on this worktree's port. Running `pnpm red-cases` immediately
 * after `pnpm check` therefore raced the previous run's shutdown: the port was
 * still held for a moment, the cluster failed to start, and the GREEN arm failed
 * — reporting "the gate is broken" when nothing was broken. OPUS-M2-002's delta
 * review saw it as finding U-04.
 *
 * A wait, not a retry: retrying the gate would mask a genuine GREEN failure,
 * which is the one thing this runner exists to detect. If the port is still held
 * when the budget runs out the run proceeds anyway and says so, so a genuinely
 * stuck cluster surfaces as the failure it is rather than as a hang.
 *
 * @param {number} port
 * @param {number} budgetMs
 */
async function waitForPortRelease(port, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs;
  let announced = false;
  while (await portIsHeld(port)) {
    if (!announced) {
      process.stdout.write(
        `Waiting for the embedded-postgres port ${String(port)} to be released ` +
          '(a previous `pnpm check` may still be shutting down)...\n',
      );
      announced = true;
    }
    if (Date.now() >= deadline) {
      process.stdout.write(
        `Port ${String(port)} is STILL held after ${String(budgetMs / 1000)}s. Continuing anyway — ` +
          'a GREEN-arm failure below is then a real finding, not this transient. See the runbook\n' +
          'standing port-hygiene discipline for how to identify and clear the holder.\n',
      );
      return;
    }
    await delay(500);
  }
  if (announced) process.stdout.write(`Port ${String(port)} released.\n`);
}

async function main() {
  await waitForPortRelease(resolveTestPgPort());

  clearStaleInjections();

  const transcript = [
    `# pnpm red-cases — ${new Date().toISOString()}`,
    '',
    'GREEN = the gate passes on the clean tree.',
    'RED   = the gate fails once the violation is introduced.',
    'A gate that passes its RED check is decorative and the run fails.',
    '',
  ];

  /** @type {{ id: string, gate: string, violation: string, green: boolean, red: boolean }[]} */
  const results = [];

  for (const testCase of CASES) {
    process.stdout.write(`\n=== ${testCase.id} — ${testCase.gate} ===\n`);
    transcript.push(
      `## ${testCase.id} — ${testCase.gate}`,
      '',
      `Violation: ${testCase.violation}`,
      '',
    );

    const green = run(testCase.greenCommand);
    process.stdout.write(`  GREEN (clean tree): ${green.ok ? 'gate passed' : 'GATE FAILED'}\n`);
    transcript.push('### GREEN — clean tree', '', '```', green.output.trimEnd(), '```', '');

    let red = { ok: true, output: '(not run)' };
    try {
      applyViolation(testCase);

      let prepareFailed = false;
      for (const prepareCommand of testCase.prepare ?? []) {
        const prepared = run(prepareCommand);
        if (!prepared.ok) {
          prepareFailed = true;
          transcript.push('### PREPARE FAILED', '', '```', prepared.output.trimEnd(), '```', '');
        }
      }

      red = prepareFailed ? { ok: true, output: 'prepare step failed' } : run(testCase.redCommand);
      process.stdout.write(
        `  RED   (violation in tree): ${red.ok ? 'GATE STILL PASSED — decorative' : 'gate failed as required'}\n`,
      );
      transcript.push('### RED — violation introduced', '', '```', red.output.trimEnd(), '```', '');
    } finally {
      revertViolation();
      for (const restoreCommand of testCase.restore ?? []) run(restoreCommand);
    }

    results.push({
      id: testCase.id,
      gate: testCase.gate,
      violation: testCase.violation,
      green: green.ok,
      red: !red.ok,
    });
  }

  const failures = results.filter((r) => !r.green || !r.red);

  const width = Math.max(...results.map((r) => r.id.length), 4);
  const table = [
    '',
    `${'CASE'.padEnd(width)}  GREEN  RED    VERDICT`,
    `${'-'.repeat(width)}  -----  -----  -------`,
    ...results.map(
      (r) =>
        `${r.id.padEnd(width)}  ${(r.green ? 'pass' : 'FAIL').padEnd(5)}  ${(r.red ? 'fail' : 'PASS').padEnd(5)}  ${
          r.green && r.red ? 'PROVEN' : 'NOT PROVEN'
        }`,
    ),
    `${'-'.repeat(width)}  -----  -----  -------`,
    `${String(results.length)} case(s): ${String(results.length - failures.length)} proven, ${String(failures.length)} not proven`,
    '',
    'GREEN "pass" = the gate passes on the clean tree.',
    'RED   "fail" = the gate fails when the violation is present. That is the desired outcome.',
    '',
  ].join('\n');

  process.stdout.write(table);
  transcript.push('## summary', '', '```', table.trim(), '```', '');

  writeFileSync(resolve(HERE, 'evidence-output.txt'), transcript.join('\n'), 'utf8');

  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
