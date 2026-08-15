import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringify } from '@schedulepoint/domain';

import { canonicalInputHash } from '../../../src/solver/snapshot-store.js';
import type { CorpusExpectation, CorpusFixture } from './generators.js';

/**
 * The committed corpus manifest — seeds, hashes, and the constructed cause.
 *
 * ## What is committed, and what is not
 *
 * The **documents are not committed**; the manifest is. A document is a pure
 * function of its seed (`generators.ts` reads no clock, no environment and no
 * file), so committing both would give a second copy that can drift from the
 * generator while still looking authoritative — the `corpus-tamper` failure mode
 * at corpus scale.
 *
 * The one exception is `B-race-retired-holding`, which cannot be generated at
 * all: it is captured from a live interleaving and its document IS committed,
 * with its own drift guard in the harness that produces it.
 *
 * ## Why the expectation is in here
 *
 * "The corpus matched its constructed cause" is only a claim if the cause was
 * written down before the run. Putting each fixture's expectation in a committed
 * artifact means a change to what a fixture is *for* shows up as a diff, rather
 * than as an assertion quietly edited to match a new observation.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export const MANIFEST_PATH = resolve(HERE, 'manifest.json');

/** Set to any non-empty value to REWRITE the manifest from the generators. */
export const REFRESH_ENV = 'SP_REFRESH_CORPUS_MANIFEST';

export interface ManifestEntry {
  readonly name: string;
  readonly corpusClass: string;
  readonly seed: string;
  readonly construction: string;
  readonly expectation: CorpusExpectation;
  /** `canonicalInputHash` of the document — the same hash a build dispatches. */
  readonly sha256: string;
}

export interface CorpusManifest {
  readonly corpusVersion: number;
  readonly generator: string;
  readonly note: string;
  readonly fixtures: readonly ManifestEntry[];
}

export const CORPUS_VERSION = 1;

export function manifestOf(fixtures: readonly CorpusFixture[]): CorpusManifest {
  return {
    corpusVersion: CORPUS_VERSION,
    generator: 'apps/api/test/solver/corpus/generators.ts',
    note:
      'Wholly synthetic canonical input snapshots for the E1 feasibility corpus (doc 35 §6d, ' +
      'SPEC-04 §8). Every identifier is a SHA-256 derivation of the seed, so regeneration is ' +
      'byte-identical; the documents are therefore NOT committed, only their hashes. ' +
      'B-race-retired-holding is the exception — it is captured from the shipped ' +
      'granted-while-retiring interleaving and its document is committed under fixtures/.',
    fixtures: fixtures.map((fixture) => ({
      name: fixture.name,
      corpusClass: fixture.corpusClass,
      seed: fixture.seed,
      construction: fixture.construction,
      expectation: fixture.expectation,
      sha256: canonicalInputHash(fixture.document),
    })),
  };
}

export function readManifest(): CorpusManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as CorpusManifest;
}

export function writeManifest(manifest: CorpusManifest): void {
  writeFileSync(MANIFEST_PATH, `${canonicalStringify(manifest)}\n`, 'utf8');
}
