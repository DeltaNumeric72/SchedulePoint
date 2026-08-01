import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs a workspace package's local binary directly.
 *
 * `pnpm --filter <pkg> run <script>` is the obvious way to do this and it does
 * not work here: when the outer command is `corepack pnpm ...`, the package
 * manager is not on `PATH` inside the script it spawns, so a nested `pnpm`
 * invocation fails with "pnpm: command not found". The environment mandates
 * corepack (FAD-7), so the gates resolve `node_modules/.bin/<cmd>` themselves.
 *
 * This is also strictly more deterministic: it invokes exactly the binary the
 * lockfile installed for that package, with no PATH ambiguity.
 *
 * Usage: node scripts/run-in-workspace.mjs <package-dir> <command> [args...]
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [packageDir, command, ...args] = process.argv.slice(2);

if (packageDir === undefined || command === undefined) {
  process.stderr.write('usage: run-in-workspace.mjs <package-dir> <command> [args...]\n');
  process.exit(2);
}

const cwd = resolve(REPO_ROOT, packageDir);
const candidates = [
  resolve(cwd, 'node_modules/.bin', command),
  resolve(REPO_ROOT, 'node_modules/.bin', command),
];
const bin = candidates.find((candidate) => existsSync(candidate));

if (bin === undefined) {
  process.stderr.write(
    `run-in-workspace: "${command}" is not installed for ${packageDir}.\nLooked in:\n${candidates
      .map((c) => `  ${c}`)
      .join('\n')}\n`,
  );
  process.exit(127);
}

const result = spawnSync(bin, args, { cwd, stdio: 'inherit' });
process.exit(result.status ?? 1);
