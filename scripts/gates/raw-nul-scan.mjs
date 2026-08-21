#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

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

/**
 * Extensions where a zero byte is legitimate content. Extensions, never paths.
 *
 * Each maps to the byte prefix a file of that format actually begins with — see
 * {@link looksBinary} for why an extension alone is not enough. `null` means the
 * format has no single stable prefix worth asserting (container formats whose
 * first bytes vary), and those are trusted on the extension as before: an
 * incomplete sniff is better than a wrong one, and it is stated rather than
 * implied.
 */
const BINARY_EXTENSIONS = new Map([
  ['.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['.jpg', [0xff, 0xd8, 0xff]],
  ['.jpeg', [0xff, 0xd8, 0xff]],
  ['.gif', [0x47, 0x49, 0x46, 0x38]],
  ['.webp', [0x52, 0x49, 0x46, 0x46]],
  ['.ico', [0x00, 0x00, 0x01, 0x00]],
  ['.pdf', [0x25, 0x50, 0x44, 0x46]],
  ['.zip', [0x50, 0x4b]],
  ['.gz', [0x1f, 0x8b]],
  ['.woff', [0x77, 0x4f, 0x46, 0x46]],
  ['.woff2', [0x77, 0x4f, 0x46, 0x32]],
  ['.ttf', [0x00, 0x01, 0x00, 0x00]],
  ['.otf', [0x4f, 0x54, 0x54, 0x4f]],
  ['.eot', null],
  ['.mp4', null],
  ['.webm', [0x1a, 0x45, 0xdf, 0xa3]],
  ['.wasm', [0x00, 0x61, 0x73, 0x6d]],
]);

/**
 * **The rename bypass, closed** (OPUS-M4-005; M4-003's §6f D-3, recorded there
 * as an M4-005 candidate).
 *
 * The allowlist is by EXTENSION, which is deliberate — a list of paths could be
 * used to excuse a text file by moving it. But it means a text file named
 * `notes.png` is skipped entirely, and the class this gate exists to catch is
 * precisely one that is invisible to a reader.
 *
 * So an allowlisted extension now has to LOOK like its format. A file claiming
 * to be a PNG that does not begin `\x89PNG\r\n\x1a\n` is scanned as text, and
 * its NULs are reported. The reviewer measured the bypass; this is the measured
 * close.
 *
 * A format with no stable prefix worth asserting keeps the extension-only
 * treatment (see `null` above), and this returns `true` for it — an honest
 * partial control rather than a sniff invented to look complete.
 */
function looksBinary(extension, data) {
  const magic = BINARY_EXTENSIONS.get(extension);
  if (magic === undefined) return false;
  if (magic === null) return true;
  if (data.length < magic.length) return false;
  return magic.every((byte, index) => data[index] === byte);
}

/**
 * Pre-existing instances, pinned by path AND count (NR-18; FAD-45(1)).
 *
 * Each is a single `U+0000` in a Markdown document owned by a packet other than
 * the one that added this gate. They are carried rather than repaired because
 * the repairing packet's allowed globs do not include them — recorded honestly
 * rather than silently skipped, and the count is pinned so the file cannot
 * acquire a second one unnoticed.
 *
 * ## OPUS-M4-005: the baseline SHRANK, deliberately (NR-18)
 *
 * `docs/evidence/EV-M3-AUTHN/INDEX.md` is repaired and its entry is gone. The
 * byte was at offset 1812, inside an inline-code span, in a sentence that
 * literally reads "Converted to the `<NUL>` JS escape" — the escape was in the
 * prose and the raw byte was in the code, which is the same shape M4-002 found
 * in `generators.ts`. It is now the four characters `\x00` the sentence claims,
 * and git will text-diff that file again: an evidence INDEX git calls BINARY is
 * an evidence INDEX whose changes nobody can review, which is the whole reason
 * NR-18 was raised.
 *
 * The two `docs/fable/control/**` instances REMAIN. They are not this packet's:
 * doc 35 §6g's allowed files expressly exclude `docs/fable/control/**` and
 * assign those two repairs to Fable. **NR-18 therefore stays open until the
 * baseline is empty**, and the packet's own "(baseline → empty)" cannot be
 * reached from inside M4-005's globs — recorded as a stated deviation rather
 * than resolved by widening a grant.
 */
const KNOWN_VIOLATIONS = new Map([
  ['docs/fable/control/CHANGELOG.md', 1],
  ['docs/fable/control/OPUS-AGENT-RUNBOOK.md', 1],
]);

/**
 * `--dir <path>` scans a directory instead of the index.
 *
 * The same escape `invariant-id-uniqueness.mjs` and `secret-scan.mjs` already
 * carry, and for the reason the red-case runner's header gives: some violations
 * cannot be committed into a scanned path, because the gate under test would
 * catch them in the repository itself. The magic-byte arm is exactly that — its
 * violation is a text file wearing a `.png` name and carrying a raw NUL, which
 * `git ls-files` would hand straight to this gate on every ordinary run.
 *
 * The baseline is IGNORED under `--dir`: a known-violations list is a statement
 * about this repository's history and means nothing about a fixture directory.
 */
const DIR_FLAG_INDEX = process.argv.indexOf('--dir');
const SCAN_DIR = DIR_FLAG_INDEX === -1 ? undefined : process.argv[DIR_FLAG_INDEX + 1];

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function trackedFiles() {
  if (SCAN_DIR !== undefined) {
    return walk(SCAN_DIR).map((path) => relative(process.cwd(), path));
  }
  const out = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 });
  return out
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0);
}

/** Under `--dir` the baseline does not apply — see {@link SCAN_DIR}. */
const BASELINE = SCAN_DIR === undefined ? KNOWN_VIOLATIONS : new Map();

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
/** Files whose extension claims a binary format their bytes do not have. */
const misnamed = [];
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

  const extension = extname(path).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) {
    /* Read the head ONCE and decide from the bytes, not from the name. A file
     * whose extension claims a format its content does not have is scanned. */
    const head = readFileSync(path).subarray(0, 16);
    if (looksBinary(extension, head)) {
      skippedBinary += 1;
      continue;
    }
    misnamed.push(path);
  }
  scanned += 1;

  const { offsets, total } = nulOffsets(path);
  if (total === 0) continue;

  const allowed = BASELINE.get(path);
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
for (const [path, allowed] of BASELINE) {
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
    `${String(skippedBinary)} binary file(s) skipped by extension AND magic bytes, ` +
    `${String(BASELINE.size)} known violation(s) held at their pinned counts\n`,
);
if (misnamed.length > 0) {
  // Not a failure by itself — a misnamed file is only a defect if it also
  // carries a NUL, and if it does it is already in `problems` above. Reported so
  // the sniff is visible rather than silent.
  process.stdout.write(
    `      ${String(misnamed.length)} file(s) carry a binary extension their bytes do not ` +
      `match and were scanned as text: ${misnamed.slice(0, 5).join(', ')}\n`,
  );
}
