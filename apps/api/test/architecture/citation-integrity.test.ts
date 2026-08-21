import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';

/**
 * **Every test citation resolves to a file that exists** (OPUS-M4-005).
 *
 * ## The class, and why a sweep rather than nine repairs
 *
 * This repository's comments cite the proof behind a claim by name, constantly
 * and deliberately — it is what makes a docblock's "asserted by X" checkable
 * instead of decorative. A citation to a file nobody can open is therefore worse
 * than no citation at all, because it reads as though the coverage had been
 * checked. The class has recurred four times, each time found by a different
 * reviewer looking at a different module:
 *
 *  * EV-M4-INPUT-A F-3 — two comments citing a `requirement-replacement.test.ts`
 *    that has never existed;
 *  * EV-M4-INPUT-C N-7 — `review-identity.test.ts`, the real file being
 *    `publication-handoff.test.ts`;
 *  * EV-M4-BOUNDARY N-5 — three more, plus the first sweep;
 *  * EV-M4-004 F-09 — four repaired, and then the finding that MATTERS: **the
 *    sweep had only ever run over bare basenames.** Full-path citations were
 *    never swept, and nine of them did not resolve. "A sweep reported at a wider
 *    scope than it ran is the same defect class as a citation that points at
 *    nothing — a true statement that a reader will reasonably take further than
 *    it goes."
 *
 * Four rounds of repairing instances is what a missing control looks like. This
 * is the control. It sweeps **both** forms, over every tracked source file, and
 * it fails the build — so the fifth occurrence is caught by CI rather than by
 * the next reviewer who happens to click a path.
 *
 * ## What it deliberately does not do
 *
 * It does not check that the cited file contains the assertion the sentence
 * claims. Nothing automated can, and pretending otherwise would be the same
 * over-claim the F-09 addendum is about. Retargeting is still done by READING
 * the assertion — this only guarantees there is something to read.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

/** `apps/api/test/foo/bar.test.ts` — a path a reader can open. */
const FULL_PATH = /(?:apps|packages|solver|scripts)\/[A-Za-z0-9_./-]+\.test\.ts/g;

/** `` `bar.test.ts` `` — a basename, resolved anywhere in the tree. */
const BASENAME = /`([A-Za-z0-9_.-]+\.test\.ts)`/g;

/**
 * Paths that exist only WHILE a red case is running.
 *
 * `scripts/red-cases/run.mjs` injects them and `revertViolation` removes them,
 * so they are absent on any tree a person or CI is looking at — and citing one
 * is correct, because the citation is what tells a reader where the violation
 * lands. Matched on the `__red_case__` marker the runner already uses for
 * exactly this "this is transient" purpose, so the exemption cannot be spent on
 * anything else.
 */
const TRANSIENT = /__red_case__/;

/**
 * A HISTORICAL mention is not a citation.
 *
 * `publication-diff-parity.test.ts` names `review-identity.test.ts` in order to
 * say it "has never existed" — the record of the N-7 repair, which is exactly
 * the kind of sentence this repository writes and exactly the kind a naive sweep
 * would force somebody to delete. Deleting the record to satisfy the check would
 * be the check making the codebase worse.
 *
 * The exemption is four phrases within TWO LINES of the mention, and nothing
 * else. Two lines because a wrapped comment puts the name at the end of one line
 * and "has never existed" at the start of the next — an exemption that only
 * looked at one line would force the sentence to be rewritten to suit the check.
 * It cannot be spent on a live citation: a sentence that says a file does not
 * exist is not pointing a reader at it.
 */
const HISTORICAL = /(?:never existed|does not exist|no longer exists|has been renamed)/i;

/**
 * This file, excluded from its own sweep.
 *
 * It has to name unresolvable paths — the regex docblocks show the FORM being
 * matched, and the RED arm fabricates two paths precisely because they do not
 * exist. A scanner that reported its own examples would be unable to document
 * or falsify itself, and the alternative (writing the examples so obliquely that
 * the regex misses them) would make the file harder to read in order to satisfy
 * the file.
 *
 * ONE path, matched exactly, so the exemption cannot spread.
 */
const SELF = 'apps/api/test/architecture/citation-integrity.test.ts';

function trackedSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx', '*.mjs', '*.py'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0);
}

interface Citation {
  readonly source: string;
  readonly line: number;
  readonly cited: string;
}

/** Two lines either side, so a wrapped sentence is read as one sentence. */
const HISTORICAL_WINDOW = 2;

function citations(pattern: RegExp, group: number): Citation[] {
  const found: Citation[] = [];
  for (const source of trackedSources()) {
    if (source === SELF) continue;
    const text = readFileSync(resolve(REPO_ROOT, source), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      /* The comment markers are stripped before the window is joined, because a
       * wrapped sentence reads `has never` / ` * existed` and a naive join puts
       * an asterisk in the middle of the phrase. The check is about the prose,
       * so the prose is what it is given. */
      const window = lines
        .slice(Math.max(0, index - HISTORICAL_WINDOW), index + HISTORICAL_WINDOW + 1)
        .map((text) => text.replace(/^\s*\*/, ''))
        .join(' ')
        .replace(/\s+/g, ' ');
      if (HISTORICAL.test(window)) return;
      for (const match of line.matchAll(pattern)) {
        const cited = match[group];
        if (cited === undefined || TRANSIENT.test(cited)) continue;
        found.push({ source, line: index + 1, cited });
      }
    });
  }
  return found;
}

describe('every cited test file exists (OPUS-M4-005)', () => {
  it('FULL PATHS — the form the F-09 sweep never covered', () => {
    const cited = citations(FULL_PATH, 0);
    expect(cited.length, 'no full-path citations found — the sweep would be vacuous').toBeGreaterThan(
      20,
    );

    const unresolvable = cited.filter((c) => !existsSync(resolve(REPO_ROOT, c.cited)));
    expect(
      unresolvable.map((c) => `${c.source}:${String(c.line)} cites ${c.cited}`),
      'a citation points at a file that does not exist',
    ).toEqual([]);

    log(`${String(cited.length)} full-path test citation(s) checked; all resolve`);
  });

  it('BASENAMES — the form round 3 did cover, kept covered', () => {
    const cited = citations(BASENAME, 1);
    expect(cited.length, 'no basename citations found — the sweep would be vacuous').toBeGreaterThan(
      10,
    );

    /* A basename resolves if a file of that name exists ANYWHERE, which is the
     * strongest claim the form supports: the citation named no directory, so
     * neither can the check. */
    const everyTestFile = new Set(
      trackedSources()
        .filter((path) => path.endsWith('.test.ts'))
        .map((path) => path.slice(path.lastIndexOf('/') + 1)),
    );
    const unresolvable = cited.filter((c) => !everyTestFile.has(c.cited));
    expect(
      unresolvable.map((c) => `${c.source}:${String(c.line)} cites ${c.cited}`),
      'a citation names a test file that exists nowhere in the tree',
    ).toEqual([]);

    log(`${String(cited.length)} basename test citation(s) checked; all resolve`);
  });

  it('RED: the sweep catches a citation it was pointed at (both forms)', () => {
    /* The control's own control. Without it this file passes for ever the moment
     * the regex stops matching — which is precisely how the F-09 sweep reported
     * a clean result at a scope it had never run over. */
    const fabricatedPath = 'apps/api/test/never/written.test.ts';
    expect(existsSync(resolve(REPO_ROOT, fabricatedPath))).toBe(false);
    expect(fabricatedPath.match(FULL_PATH)).not.toBeNull();

    const fabricatedBase = '`never-written-anywhere.test.ts`';
    const matched = [...fabricatedBase.matchAll(BASENAME)].map((m) => m[1]);
    expect(matched).toEqual(['never-written-anywhere.test.ts']);

    /* The self-exemption is ONE path, spelled out, so it cannot spread. */
    expect(SELF).toBe('apps/api/test/architecture/citation-integrity.test.ts');
    expect(trackedSources()).toContain(SELF);

    /* And the transient exemption is NARROW: it admits the runner's own injected
     * paths and nothing else. */
    expect(TRANSIENT.test('packages/domain/test/__red_case__.test.ts')).toBe(true);
    expect(TRANSIENT.test('apps/api/test/authn/mfa.test.ts')).toBe(false);

    /* So is the historical one. It admits a sentence that says the file is not
     * there, and refuses an ordinary citation. */
    expect(HISTORICAL.test('This cited `review-identity.test.ts`, which has never existed')).toBe(
      true,
    );
    expect(HISTORICAL.test('asserted by `apps/api/test/authn/mfa.test.ts`')).toBe(false);
  });
});
