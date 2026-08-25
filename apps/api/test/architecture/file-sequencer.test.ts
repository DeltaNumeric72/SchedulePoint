import { describe, expect, it } from 'vitest';

import type { TestSpecification } from 'vitest/node';

import { canonicalOrder, fileShuffleRequested, shuffleBySeed } from '../../vitest.config.js';
import { log } from '../support/harness.js';

/**
 * **The NR-22 sequencer's own control** (FU-01; the M5-000a review's C-7).
 *
 * The canonical-sort sequencer is what makes `--sequence.seed=N` a replay key
 * again, and every part of it is silent in ordinary use: the predicate decides
 * whether the sequencer is installed at all, the comparator decides an order
 * nobody reads, and the shuffle produces an order that looks random whether or
 * not it is the RIGHT random order. A defect in any of the three restores NR-22
 * — an unstable or a non-replayable order — with nothing turning red, which is
 * exactly the shape this repository writes controls for.
 *
 * The review found one such defect by measurement rather than by reading (C-1:
 * the first predicate installed the sequencer for `--sequence.shuffle.files
 * false`, a spelling in which Vitest does NOT shuffle files), so the table below
 * is not a restatement of the implementation. It is the review's MEASURED table
 * — sixteen argv shapes, each run against Vitest 3.2.4 to see what Vitest itself
 * did — and this file asserts the predicate agrees with all sixteen.
 *
 * The shuffle expectations are pinned the same way: they are the permutations
 * `@vitest/utils` 3.2.4's own `shuffle` produces, quoted as literals. That is
 * deliberate and it is the whole value of the assertion — pinning our own output
 * against our own function would pass for any function. `@vitest/utils` is a
 * transitive dependency that pnpm's isolated store does not expose to this
 * workspace, which is why `shuffleBySeed` restates the algorithm and why these
 * literals, rather than an import, are how the restatement stays honest.
 */

/** Vitest reads exactly three fields off a specification, so a probe supplies three. */
function spec(moduleId: string, project = 'api', pool = 'forks'): TestSpecification {
  return { moduleId, project: { name: project }, pool } as unknown as TestSpecification;
}

const ids = (specs: readonly TestSpecification[]): string[] =>
  specs.map((entry) => `${entry.moduleId}|${entry.project.name}|${entry.pool}`);

describe('fileShuffleRequested — agreement with Vitest 3.2.4, per measured argv shape', () => {
  /**
   * `[argv, did Vitest 3.2.4 actually shuffle FILES?]`.
   *
   * Measured by the M5-000a review, not derived from the predicate. Two rows are
   * the C-1 finding itself: `--sequence.shuffle.files false` and
   * `--sequence.shuffle false`, where cac consumes the following token as the
   * option's value and Vitest therefore does not shuffle files.
   */
  const MEASURED: readonly (readonly [readonly string[], boolean])[] = [
    [[], false],
    [['--sequence.shuffle.files'], true],
    [['--sequence.shuffle.tests'], false],
    [['--sequence.shuffle'], true],
    [['--sequence.shuffle.files', '--sequence.shuffle.tests', '--sequence.seed=1'], true],
    [['--sequence.shuffle=false'], false],
    [['--sequence.shuffle.files=false'], false],
    [['--sequence.shuffle.files=true'], true],
    [['--no-sequence.shuffle.files'], false],
    [['--sequence.shuffle.files=false', '--sequence.shuffle'], true],
    [['--sequence.shuffle.tests', '--sequence.shuffle.files'], true],
    [['--sequence.shuffle.files', 'true'], true],
    [['--sequence.shuffle.files', 'false'], false],
    [['--sequence.shuffle', 'false'], false],
    [['--sequence.shuffle.tests=true'], false],
    [['--sequence.seed=1'], false],
  ];

  it('agrees with every one of the sixteen measured shapes', () => {
    const disagreements = MEASURED.filter(
      ([argv, shuffled]) => fileShuffleRequested(argv) !== shuffled,
    ).map(
      ([argv, shuffled]) =>
        `${JSON.stringify(argv)}: vitest shuffled files = ${String(shuffled)}, predicate said ${String(
          fileShuffleRequested(argv),
        )}`,
    );
    expect(disagreements, 'the predicate disagrees with what Vitest measurably does').toEqual([]);

    /* Non-vacuity: a table of sixteen falses would pass against a predicate that
     * always returned false. Both answers must be represented. */
    expect(MEASURED.filter(([, shuffled]) => shuffled).length).toBeGreaterThan(0);
    expect(MEASURED.filter(([, shuffled]) => !shuffled).length).toBeGreaterThan(0);
    log(`${String(MEASURED.length)} measured argv shapes; predicate agrees with all of them`);
  });

  it('does not shuffle FILES for a tests-only request, in any of its spellings', () => {
    // The harmful direction, called out on its own because it is the one that
    // would reorder files for a run that asked only for within-file shuffling.
    for (const argv of [
      ['--sequence.shuffle.tests'],
      ['--sequence.shuffle.tests=true'],
      ['--sequence.shuffle.tests', 'true'],
    ]) {
      expect(fileShuffleRequested(argv), JSON.stringify(argv)).toBe(false);
    }
  });

  it('reads the LAST decision when a run says both, in either order', () => {
    expect(fileShuffleRequested(['--sequence.shuffle.files', '--no-sequence.shuffle.files'])).toBe(
      false,
    );
    expect(fileShuffleRequested(['--no-sequence.shuffle.files', '--sequence.shuffle.files'])).toBe(
      true,
    );
  });
});

describe('canonicalOrder — the permutation must not depend on how collection ordered the set', () => {
  const paths = [
    'apps/api/test/audit/chain.test.ts',
    'apps/api/test/architecture/citation-integrity.test.ts',
    'apps/api/test/server.test.ts',
    'apps/api/test/schedule/timezone-basis.test.ts',
    'apps/api/test/db/queue-pool-release.test.ts',
  ];

  it('returns the same order for every input permutation', () => {
    const canonical = ids(canonicalOrder(paths.map((path) => spec(path))));
    /* Every permutation of five, not a sample: 120 orders is cheap, and a
     * sampled invariance proof is the weaker claim. */
    const permutations = (input: string[]): string[][] =>
      input.length <= 1
        ? [input]
        : input.flatMap((head, index) =>
            permutations([...input.slice(0, index), ...input.slice(index + 1)]).map((rest) => [
              head,
              ...rest,
            ]),
          );
    const all = permutations(paths);
    expect(all.length).toBe(120);
    for (const permutation of all) {
      expect(ids(canonicalOrder(permutation.map((path) => spec(path))))).toEqual(canonical);
    }
    log(`canonical order identical across all ${String(all.length)} input permutations`);
  });

  it('is a TOTAL order: one module id collected twice is still ordered', () => {
    // Vitest can collect one file under two projects, and one project under two
    // pools. A comparator returning 0 there would leave those two entries in
    // collection order — the exact leak this sequencer exists to close.
    const one = 'apps/api/test/server.test.ts';
    const collected = [
      spec(one, 'web', 'forks'),
      spec(one, 'api', 'typescript'),
      spec(one, 'api', 'forks'),
    ];
    const first = ids(canonicalOrder(collected));
    const second = ids(canonicalOrder([...collected].reverse()));
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(3);
    expect(first).toEqual([`${one}|api|forks`, `${one}|api|typescript`, `${one}|web|forks`]);
  });

  it('sorts by code unit rather than by locale', () => {
    // `localeCompare` orders these two differently from code-unit order in some
    // locales; a locale-dependent comparator would put the machine back inside
    // the permutation the seed is supposed to own.
    //
    // The two module ids here are DELIBERATELY not repository paths, and the
    // reason is a failure this file caused. Its first spelling used a
    // lower-case/upper-case pair of plausible-looking test paths under this
    // package, and the citation sweep two files away read them as citations of
    // test files that are not in the tree: the composed run went red —
    // REV-B-005's class (a path-like token turning a gate red), arriving through
    // a FIXTURE rather than through prose, and invisible until the file was
    // tracked (NR-20's second trigger). A synthetic root and a non-test suffix
    // keep a fixture out of a sweep that is right to be literal-minded.
    const ordered = ids(
      canonicalOrder([
        spec('synthetic/case/b.spec-fixture'),
        spec('synthetic/case/B.spec-fixture'),
      ]),
    );
    expect(ordered[0]).toContain('/B.spec-fixture');
    // …and the ordering is the code-unit one: 'B' (0x42) sorts before 'b' (0x62).
    expect(ordered).toEqual([
      'synthetic/case/B.spec-fixture|api|forks',
      'synthetic/case/b.spec-fixture|api|forks',
    ]);
  });

  it('does not mutate the array it is given', () => {
    const collected = paths.map((path) => spec(path));
    const before = ids(collected);
    canonicalOrder(collected);
    expect(ids(collected)).toEqual(before);
  });
});

describe('shuffleBySeed — the permutation Vitest 3.2.4 itself produces', () => {
  const base = ['a', 'b', 'c', 'd', 'e', 'f'];

  /**
   * Produced by `@vitest/utils` 3.2.4's own `shuffle`, quoted here as literals.
   * The point of the assertion is that these came from the LIBRARY: a
   * restatement checked against its own output would pass however wrong it was.
   */
  const PINNED: readonly (readonly [number, readonly string[]])[] = [
    [1, ['d', 'b', 'c', 'a', 'f', 'e']],
    [123456, ['d', 'b', 'e', 'c', 'f', 'a']],
    [740673, ['a', 'b', 'd', 'f', 'e', 'c']],
    [0, ['c', 'b', 'f', 'e', 'd', 'a']],
  ];

  it('matches the library permutation for every pinned seed', () => {
    for (const [seed, expected] of PINNED) {
      expect(shuffleBySeed(base, seed), `seed ${String(seed)}`).toEqual([...expected]);
    }
    expect(shuffleBySeed(['x', 'y', 'z'], 20260825)).toEqual(['y', 'x', 'z']);
    expect(shuffleBySeed(['solo'], 5)).toEqual(['solo']);
    expect(shuffleBySeed([], 5)).toEqual([]);
    log(`${String(PINNED.length + 3)} pinned library permutations reproduced`);
  });

  it('is a function of the seed alone, and a permutation of its input', () => {
    expect(shuffleBySeed(base, 1)).toEqual(shuffleBySeed(base, 1));
    expect(shuffleBySeed(base, 1)).not.toEqual(shuffleBySeed(base, 123456));
    expect([...shuffleBySeed(base, 1)].sort()).toEqual([...base].sort());
  });

  it('does not mutate the array it is given', () => {
    const input = [...base];
    shuffleBySeed(input, 1);
    expect(input).toEqual(base);
  });
});
