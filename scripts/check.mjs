import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm check` — the full gate battery, in dependency order.
 *
 * One command, twelve gates, all build-failing (15-testing-strategy §4). The
 * runner keeps going after a failure rather than stopping at the first one:
 * a developer fixing a broken branch wants the whole list, not one gate at a
 * time. The exit code is non-zero if any gate failed.
 *
 * Order matters in three places and only three:
 *   - `build` must precede `network-guard` (the guard scans the built bundle and
 *     treats a missing bundle as a failure);
 *   - `build` must precede `axe` (Playwright serves the production build);
 *   - `axe` must precede `request-budget` (the browser run writes the recordings
 *     the budget gate compares, and a missing recording is a failure).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How to re-invoke the package manager.
 *
 * When the outer command is `corepack pnpm check`, `pnpm` is not on `PATH`
 * inside the spawned script, so `spawnSync('pnpm', ...)` fails with ENOENT.
 * pnpm sets `npm_execpath` to its own CLI entry point; running that with the
 * current Node binary works under corepack, plain pnpm, and CI alike.
 */
const PM_EXECPATH = process.env['npm_execpath'];

/** @param {string[]} scriptArgs */
function packageManagerInvocation(scriptArgs) {
  // Under corepack this is `.../corepack/v1/pnpm/<version>/bin/pnpm.mjs`.
  if (PM_EXECPATH !== undefined && /\.(mjs|cjs|js)$/.test(PM_EXECPATH)) {
    return { command: process.execPath, args: [PM_EXECPATH, ...scriptArgs] };
  }
  return { command: PM_EXECPATH ?? 'pnpm', args: scriptArgs };
}

/**
 * @typedef {{ id: string, title: string, command: string, args: string[], cwd?: string }} Gate
 */

/** @type {Gate[]} */
const GATES = [
  { id: 'lint', title: 'lint (eslint)', command: 'pnpm', args: ['run', 'gate:lint'] },
  {
    id: 'typecheck',
    title: 'typecheck (tsc -b)',
    command: 'pnpm',
    args: ['run', 'gate:typecheck'],
  },
  { id: 'unit', title: 'unit tests (vitest)', command: 'pnpm', args: ['run', 'gate:unit'] },
  {
    id: 'import-boundary',
    title: 'import boundary (dependency-cruiser)',
    command: 'pnpm',
    args: ['run', 'gate:import-boundary'],
  },
  {
    id: 'route-policy',
    title: 'route-without-policy (I-02)',
    command: 'pnpm',
    args: ['run', 'gate:route-policy'],
  },
  {
    id: 'migration-rls',
    title: 'migration + RLS pairing (I-15)',
    command: 'pnpm',
    args: ['run', 'gate:migration-rls'],
  },
  {
    id: 'invariant-ids',
    title: 'invariant-ID uniqueness (CAR-023)',
    command: 'pnpm',
    args: ['run', 'gate:invariant-ids'],
  },
  { id: 'secret-scan', title: 'secret scan', command: 'pnpm', args: ['run', 'gate:secret-scan'] },
  {
    id: 'build',
    title: 'production build (vite build)',
    command: 'pnpm',
    args: ['run', 'gate:build'],
  },
  {
    id: 'network-guard',
    title: 'network-assertion guard (SP-HR-1)',
    command: 'pnpm',
    args: ['run', 'gate:network-guard'],
  },
  {
    id: 'axe',
    title: 'axe-core via Playwright (CAP-066)',
    command: 'pnpm',
    args: ['run', 'gate:axe'],
  },
  {
    id: 'request-budget',
    title: 'requests per interaction (SP-HR-2)',
    command: 'pnpm',
    args: ['run', 'gate:request-budget'],
  },
];

/** @param {string} text */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

function main() {
  /** @type {{ gate: Gate, ok: boolean, ms: number, output: string }[]} */
  const results = [];
  const transcript = [`# pnpm check — ${new Date().toISOString()}`, ''];

  for (const gate of GATES) {
    process.stdout.write(`\n[1m=== ${gate.id} — ${gate.title} ===[0m\n`);
    const started = Date.now();
    const invocation = packageManagerInvocation(gate.args);
    const run = spawnSync(invocation.command, invocation.args, {
      cwd: gate.cwd ?? REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
      shell: process.platform === 'win32',
    });
    const ms = Date.now() - started;
    const output = stripAnsi(`${run.stdout ?? ''}${run.stderr ?? ''}`);
    process.stdout.write(output);

    const ok = run.status === 0;
    results.push({ gate, ok, ms, output });
    transcript.push(`## ${gate.id} — ${gate.title}`, '', '```', output.trimEnd(), '```', '');
  }

  const failed = results.filter((r) => !r.ok);

  const table = [
    '',
    'GATE                     RESULT   TIME',
    '------------------------ -------- --------',
    ...results.map(
      (r) =>
        `${r.gate.id.padEnd(24)} ${(r.ok ? 'PASS' : 'FAIL').padEnd(8)} ${`${String(r.ms)}ms`.padStart(8)}`,
    ),
    '------------------------ -------- --------',
    `${String(results.length)} gate(s): ${String(results.length - failed.length)} passed, ${String(failed.length)} failed`,
    '',
  ].join('\n');

  process.stdout.write(table);
  transcript.push('## summary', '', '```', table.trim(), '```', '');

  mkdirSync(resolve(REPO_ROOT, 'scripts'), { recursive: true });
  writeFileSync(resolve(REPO_ROOT, 'scripts/check-output.txt'), transcript.join('\n'), 'utf8');

  process.exit(failed.length === 0 ? 0 : 1);
}

main();
