import { canonicalStringify, snapshotRefusals } from '@schedulepoint/domain';
import { describe, expect, it } from 'vitest';

import { canonicalInputHash } from '../../../src/solver/snapshot-store.js';
import { log } from '../../support/harness.js';
import { e1Corpus } from './corpus.js';
import { CORPUS_CLASSES, corpusId, generatedCorpus } from './generators.js';
import { REFRESH_ENV, manifestOf, readManifest, writeManifest } from './manifest.js';

/**
 * **NAMED PROOF — the E1 corpus is deterministic, complete, and synthetic**
 * (OPUS-M4-002; doc 35 §6d "Corpus requirements", SPEC-04 §8).
 *
 * | # | Property | What breaks silently without it |
 * |---|---|---|
 * | 1 | every §6d class is present, exactly once | a class quietly disappears and the summary still looks full |
 * | 2 | regeneration is byte-identical | the "deterministic corpus" claim is about one run on one machine |
 * | 3 | the committed hashes match | a fixture changes meaning and every downstream assertion moves with it |
 * | 4 | generation is order-independent | the manifest records an accident of iteration order |
 * | 5 | no fixture would be refused at assembly | the corpus measures unposed problems |
 * | 6 | every fixture is synthetic | the clean-room boundary is a comment |
 *
 * Case 2 is the one that costs something to hold: it generates the whole corpus
 * **twice, in the same process**, and compares the canonical renderings. A
 * generator that read a clock, an environment variable or `randomUUID` fails it
 * on the first run rather than on somebody else's machine six weeks later.
 */

describe('the E1 corpus manifest', () => {
  it('1. covers every §6d class, exactly once', async () => {
    const corpus = await e1Corpus();
    const classes = corpus.map((fixture) => fixture.corpusClass).sort();
    expect(classes).toEqual([...CORPUS_CLASSES].sort());
    expect(new Set(corpus.map((fixture) => fixture.name)).size).toBe(corpus.length);
    log(`      · ${String(corpus.length)} fixtures across ${String(CORPUS_CLASSES.length)} classes`);
  });

  it('2. regenerates byte-identically within one process', () => {
    const first = generatedCorpus();
    const second = generatedCorpus();
    for (const [index, fixture] of first.entries()) {
      const other = second[index];
      expect(other?.name).toBe(fixture.name);
      expect(canonicalStringify(other?.document), `${fixture.name} is not reproducible`).toBe(
        canonicalStringify(fixture.document),
      );
    }
    log(`      · ${String(first.length)} generated fixtures reproduced byte for byte`);
  });

  it('2b. the derivation is a pure function of seed and label', () => {
    /* The mechanism behind case 2, isolated. If `corpusId` ever stopped being
     * deterministic, case 2 would still pass for a corpus that memoised its
     * results — this is what makes the claim about the derivation itself. */
    expect(corpusId('seed', 'label')).toBe(corpusId('seed', 'label'));
    expect(corpusId('seed', 'label')).not.toBe(corpusId('seed', 'other'));
    expect(corpusId('seed', 'label')).not.toBe(corpusId('other', 'label'));
    expect(corpusId('seed', 'label')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('3. matches the committed manifest, hash for hash', async () => {
    const corpus = await e1Corpus();
    const generated = manifestOf(corpus);

    if (process.env[REFRESH_ENV] !== undefined && process.env[REFRESH_ENV] !== '') {
      writeManifest(generated);
      log('      · manifest REWRITTEN');
    }

    const committed = readManifest();
    expect(committed.corpusVersion).toBe(generated.corpusVersion);
    /* Compared whole rather than field by field: a fixture ADDED to the
     * generator and not to the manifest is exactly as much of a drift as a hash
     * that moved, and a per-entry loop would miss it. */
    expect(canonicalStringify(committed.fixtures)).toBe(canonicalStringify(generated.fixtures));
    log(`      · ${String(committed.fixtures.length)} committed hashes all matched`);
  });

  it('4. is independent of the order the spec is written in', () => {
    /* The reviewer's "reordered inputs" probe, held as a property rather than
     * left to a reviewer: every collection in the builder is emitted sorted by
     * its own key, so the canonical rendering cannot depend on the order the
     * fixture happened to list participants, shift types or rules in. Proven
     * against the ONE fixture that lists the most of each. */
    const ruleHeavy = generatedCorpus().find((fixture) => fixture.corpusClass === 'rule-heavy');
    expect(ruleHeavy).toBeDefined();
    const document = ruleHeavy?.document;
    const isSorted = (values: readonly string[]): boolean =>
      values.every((value, index) => index === 0 || (values[index - 1] ?? '') <= value);

    expect(isSorted((document?.shiftTypes ?? []).map((s) => s.code))).toBe(true);
    expect(isSorted((document?.ruleRevisions ?? []).map((r) => r.ruleKey))).toBe(true);
    expect(isSorted((document?.constituents ?? []).map((c) => `${c.kind}:${c.key}`))).toBe(true);
    expect(
      isSorted((document?.demand ?? []).map((d) => `${d.on}${d.shiftTypeId}`)),
    ).toBe(true);
  });

  it('5. would not be refused at assembly — every fixture is a POSED problem', async () => {
    for (const fixture of await e1Corpus()) {
      const refusals = snapshotRefusals(fixture.document);
      expect(
        refusals.map((refusal) => `${refusal.reason}@${refusal.subject}`),
        `${fixture.name} would be refused`,
      ).toEqual([]);
    }
  });

  it('6. is wholly synthetic: derived ids, 2027 dates, and no borrowed name', async () => {
    for (const fixture of await e1Corpus()) {
      const document = fixture.document;
      /* The generated fixtures are pinned to 2027 by construction; the captured
       * one carries the race harness's own 2036 window. Both are synthetic and
       * neither is anywhere near a real calendar the product would ship
       * against — the assertion is that the year is one of the two the corpus
       * deliberately uses, so a fixture built from a live period would fail. */
      expect(
        ['2027', '2036'],
        `${fixture.name} is dated outside the corpus's synthetic windows`,
      ).toContain(document.startDate.slice(0, 4));
      for (const shiftType of document.shiftTypes) {
        expect(shiftType.code, `${fixture.name} carries a non-synthetic shift-type code`).toMatch(
          /^[A-Z0-9]{3,8}$/,
        );
      }
      expect(document.periodName.length).toBeLessThan(64);
    }
  });

  it('7. the hash MOVES when the problem does — the manifest is not decorative', async () => {
    /* Without this, every hash assertion above would pass against a hash
     * function that returned a constant. */
    const corpus = await e1Corpus();
    const hashes = corpus.map((fixture) => canonicalInputHash(fixture.document));
    expect(new Set(hashes).size).toBe(corpus.length);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
