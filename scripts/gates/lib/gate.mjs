import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file's location rather than from `cwd`. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const ALWAYS_SKIP = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.git',
  'dist',
  'dist-types',
  '.worktrees',
  'coverage',
  'playwright-report',
  'test-results',
  '.turbo',
  '.pnpm-store',
]);

/**
 * Recursively lists files under `dir`.
 *
 * @param {string} dir
 * @param {{ skip?: Set<string>, includeSkipped?: string[] }} [options]
 * @returns {string[]} absolute paths
 */
export function listFiles(dir, options = {}) {
  const skip = options.skip ?? ALWAYS_SKIP;
  const allowed = new Set(options.includeSkipped ?? []);
  /** @type {string[]} */
  const out = [];

  /** @param {string} current */
  function walk(current) {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name) && !allowed.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  try {
    if (!statSync(dir).isDirectory()) return [dir];
  } catch {
    return [];
  }

  walk(dir);
  return out.sort();
}

/** @param {string} absolutePath */
export function rel(absolutePath) {
  return relative(REPO_ROOT, absolutePath) || absolutePath;
}

/**
 * @typedef {{ file: string, line: number, detail: string }} Violation
 */

/**
 * Uniform gate output. Every gate prints the same three-part shape so a CI log
 * is readable without knowing which gate produced it.
 *
 * @param {string} gateName
 * @param {Violation[]} violations
 * @param {string} scannedSummary
 * @returns {number} process exit code
 */
export function report(gateName, violations, scannedSummary) {
  if (violations.length === 0) {
    process.stdout.write(`PASS  ${gateName} — ${scannedSummary}\n`);
    return 0;
  }

  process.stdout.write(`FAIL  ${gateName} — ${String(violations.length)} violation(s)\n`);
  for (const v of violations) {
    process.stdout.write(`  ${v.file}:${String(v.line)}  ${v.detail}\n`);
  }
  process.stdout.write(`      scanned: ${scannedSummary}\n`);
  return 1;
}

/**
 * Reads `--flag value` pairs and bare `--flag` switches from argv.
 *
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/** @param {string} source @returns {number[]} 1-based line start offsets */
export function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** @param {number[]} starts @param {number} index @returns {number} 1-based line number */
export function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((starts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
