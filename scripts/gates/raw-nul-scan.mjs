#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * **The raw-NUL gate** — FAD-45(1), mandated after the THIRD recurrence.
 *
 * ## Why this exists, stated plainly
 *
 * A `U+0000` byte in a text file is invisible in every editor, survives review,
 * and changes what the file MEANS to anything that reads it as text. It has now
 * been introduced three separate times in two milestones — M3-008 (NR-18),
 * OPUS-M4-002 (FAD-42's R-2, nine bytes across three files), and OPUS-M4-003
 * (four bytes in `builds/readiness.ts`) — each time against a written lesson
 * that was quoted back at the next author.
 *
 * FAD-45(1) drew the obvious conclusion: **a class that recurs three times
 * against a quoted lesson gets an automated control, not a fourth lesson.**
 *
 * ## What it scans, and why the allowlist is by CONTENT not by trust
 *
 * Every file `git ls-files` reports — source, docs, evidence, config. The only
 * exemptions are formats that are genuinely binary, where a zero byte is data
 * rather than a defect: PNG, JPEG, PDF, and friends. The allowlist is a list of
 * EXTENSIONS, not of paths, so it cannot be used to excuse a text file by moving
 * it somewhere.
 *
 * ## The known-violations baseline, and why it is not an amnesty
 *
 * Three pre-existing instances live in files this packet may not edit
 * (`docs/fable/control/**` is prohibited to it, and `EV-M3-AUTHN` belongs to
 * another packet's evidence). They are pinned here BY PATH AND BY COUNT.
 *
 * That is deliberately the strictest form of a baseline:
 *
 *  * a NEW violation anywhere fails the build;
 *  * a new violation in a baselined FILE fails the build too, because the count
 *    is pinned — the baseline says "exactly one, at this path", not "this path
 *    is exempt";
 *  * a baselined violation that gets FIXED also fails the build, with a message
 *    saying so, so the baseline shrinks deliberately rather than rotting.
 *
 * A baseline that only checked existence would let the next NUL hide behind an
 * old one, which is the failure mode this gate exists to prevent.
 */

/** Extensions where a zero byte is legitimate content. Extensions, never paths. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.webm',
  '.wasm',
]);

/**
 * Pre-existing instances, pinned by path AND count (NR-18; FAD-45(1)).
 *
 * Each is a single `U+0000` in a Markdown document owned by a packet other than
 * the one that added this gate. They are carried rather than repaired because
 * the repairing packet's allowed globs do not include them — recorded honestly
 * rather than silently skipped, and the count is pinned so the file cannot
 * acquire a second one unnoticed.
 */
const KNOWN_VIOLATIONS = new Map([
  ['docs/evidence/EV-M3-AUTHN/INDEX.md', 1],
  ['docs/fable/control/CHANGELOG.md', 1],
  ['docs/fable/control/OPUS-AGENT-RUNBOOK.md', 1],
]);

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 });
  return out
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0);
}

/** Byte offsets of every `U+0000` in the file, capped so a binary blob cannot flood. */
function nulOffsets(path) {
  const data = readFileSync(path);
  const offsets = [];
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === 0) {
      offsets.push(index);
      if (offsets.length >= 64) break;
    }
  }
  let total = 0;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0) total += 1;
  return { offsets, total };
}

const problems = [];
const baselineSeen = new Map();
let scanned = 0;
let skippedBinary = 0;

for (const path of trackedFiles()) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    continue; // a tracked path that is not present (submodule, sparse checkout)
  }
  if (!stats.isFile()) continue;

  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) {
    skippedBinary += 1;
    continue;
  }
  scanned += 1;

  const { offsets, total } = nulOffsets(path);
  if (total === 0) continue;

  const allowed = KNOWN_VIOLATIONS.get(path);
  if (allowed === undefined) {
    problems.push(
      `${path}: ${String(total)} raw U+0000 byte(s) at offset(s) ${offsets.join(', ')}` +
        ' — spell it `\\x00` (the escape produces an identical string; see' +
        ' apps/api/src/solver/candidate-validation.ts)',
    );
    continue;
  }

  baselineSeen.set(path, total);
  if (total !== allowed) {
    problems.push(
      `${path}: ${String(total)} raw U+0000 byte(s), but the known-violations baseline pins ` +
        `exactly ${String(allowed)}. A baselined file is not exempt — its count is pinned.`,
    );
  }
}

/* A baselined violation that has been REPAIRED must shrink the baseline, or the
 * list rots into a set of paths nobody remembers the reason for. */
for (const [path, allowed] of KNOWN_VIOLATIONS) {
  if (!baselineSeen.has(path)) {
    problems.push(
      `${path}: the known-violations baseline pins ${String(allowed)} raw U+0000 byte(s), and ` +
        'there are now none. Remove this entry from KNOWN_VIOLATIONS — the baseline shrinks ' +
        'deliberately.',
    );
  }
}

if (problems.length > 0) {
  process.stdout.write(`FAIL  raw-nul-scan (FAD-45(1)) — ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `PASS  raw-nul-scan (FAD-45(1)) — ${String(scanned)} text file(s) scanned, ` +
    `${String(skippedBinary)} binary file(s) skipped by extension, ` +
    `${String(KNOWN_VIOLATIONS.size)} known violation(s) held at their pinned counts\n`,
);
