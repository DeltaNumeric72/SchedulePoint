import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';

import type { TestSpecification } from 'vitest/node';

/**
 * The `api` test project.
 *
 * Three settings are load-bearing rather than tuning:
 *
 *  - **`globalSetup`** starts ONE embedded PostgreSQL cluster for the whole
 *    project, bootstraps the five roles, runs the migration cycle up → down → up
 *    and seeds the MULTI fixture through the unit of work.
 *  - **`singleFork` / `fileParallelism: false`** because every test file shares
 *    that one cluster and one fixture. Parallel files would interleave writes to
 *    the same rows and turn a deterministic isolation harness into a flaky one —
 *    and a concurrency claim backed by wall-clock luck is worth nothing
 *    (execution standards §F item 7). The T-15 storm creates its *own*
 *    concurrency, deterministically, inside one file.
 *  - **`testTimeout`** because the storm and the fault-injection tests wait on
 *    real server round trips, cancellations and backend terminations.
 */
export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});

/* ══ NR-22's retirement (FU-01) ════════════════════════════════════════════
 *
 * ## What was broken
 *
 * `--sequence.seed=N` pinned the file permutation only RELATIVE TO COLLECTION
 * ORDER, and collection order is a glob walk that is not stably ordered. Vitest
 * 3.2.4's `RandomSequencer.sort(files)` is `shuffle(files, sequence.seed)` — a
 * seeded Fisher–Yates over whatever array collection hands it, with no canonical
 * pre-sort — so the landed order was a function of (collection order, seed) and
 * a printed seed was a lead rather than a reproduction. NR-22 measured it: five
 * collections of one unchanged checkout returned three distinct orders, and
 * R-12's seed-1 re-run placed `periodic.test.ts` behind a 232-job backlog where
 * R-11's had placed it behind 893. NR-22 names the exit this class takes: "a
 * sequencer that sorts the collected files canonically before shuffling (a
 * `sequence.sequencer` override … would do it), at which point seed-N becomes a
 * true replay key".
 *
 * ## What this does
 *
 * `sort` canonically orders the collected specifications FIRST — by module id,
 * then project name, then pool, all by code-unit comparison — and shuffles that
 * canonical array with the seed. The permutation is therefore a function of
 * (the SET of files, seed) alone: collection order cannot reach it, because it
 * is discarded before the shuffle sees anything.
 *
 * ## Three bounds, each structural rather than argued
 *
 *  1. **Shuffle OFF is untouched.** This class is installed by the ROOT config
 *     (see `vitest.config.ts` at the repository root) ONLY when the invocation
 *     asks for a file shuffle. When it does not, `sequence.sequencer` is never
 *     set at all, Vitest resolves `BaseSequencer` exactly as it always did, and
 *     the code path is the one that shipped — not an equivalent one. That is why
 *     the decision lives in the config rather than in an `if` inside `sort`.
 *  2. **`--sequence.shuffle.tests` is untouched.** Within-file order is decided
 *     in the worker, from `sequence.shuffle`, which nothing here reads or sets.
 *     This class only ever reorders FILES.
 *  3. **Detection power is unchanged.** The shuffle is byte-for-byte the
 *     algorithm Vitest 3.2.4 applies (`shuffle`/`random` in `@vitest/utils`,
 *     restated in `shuffleBySeed` below because that module is a transitive
 *     dependency and is deliberately not resolvable from this workspace). Any
 *     landed order is still a valid random order over the same set, so the fixed
 *     seed battery and the nightly matrix sample order space exactly as before.
 *
 * ## The seed
 *
 * Vitest defaults `sequence.seed` to `Date.now()` only when the sequencer is its
 * own `RandomSequencer`; with a custom sequencer that default does not fire. The
 * root config therefore supplies the same default itself, so that a shuffled run
 * given no seed still draws one per run — and one that IS given a seed keeps it,
 * because a CLI `--sequence.seed` overrides a config value (measured, not
 * assumed). `shuffleBySeed` defaults again at its own boundary so the class is
 * correct on its own terms.
 */

/**
 * `Math.sin`-based PRNG, quoted from `@vitest/utils` 3.2.4:
 *
 * ```js
 * function random(seed) {
 *   const x = Math.sin(seed++) * 1e4;
 *   return x - Math.floor(x);
 * }
 * ```
 *
 * Restated rather than imported: `@vitest/utils` is a transitive dependency of
 * `vitest` and pnpm's isolated store does not expose it to this workspace, and
 * adding a direct dependency on another package's internals to reach a
 * four-line function would be the worse trade. It is pinned to the version in
 * `package.json` (`vitest` 3.2.4) and the equality that matters is asserted
 * behaviourally by the probes in this packet's record, not by identity.
 */
function random(seed: number): number {
  const x = Math.sin(seed) * 1e4;
  return x - Math.floor(x);
}

/**
 * Vitest 3.2.4's own Fisher–Yates, restated (see `random` above). Shuffles a
 * COPY: the input array is never mutated, unlike the library's in-place
 * spelling, because this one is handed a freshly sorted array by its only
 * caller and a mutating helper invites a caller that is not.
 */
export function shuffleBySeed<T>(input: readonly T[], seed: number = Date.now()): T[] {
  const array = [...input];
  let length = array.length;
  let cursor = seed;
  while (length > 0) {
    const index = Math.floor(random(cursor) * length--);
    const previous = array[length] as T;
    array[length] = array[index] as T;
    array[index] = previous;
    cursor += 1;
  }
  return array;
}

/**
 * Code-unit comparison — deliberately NOT `localeCompare`.
 *
 * `localeCompare` is locale-dependent: it can order the same two paths
 * differently on two machines (and even between ICU versions on one), which
 * would put the machine back into the permutation the seed is supposed to own.
 * `<` / `>` on JavaScript strings compares UTF-16 code units, which for the
 * ASCII paths in this repository is byte order, and which is in every case a
 * fixed total order that no environment can vary.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The canonical order: module id, then project name, then pool.
 *
 * Module id alone is not a total order — one file can be collected by two
 * projects, and one project can serve two pools (`typecheck.enabled`) — and a
 * comparator that returns 0 for two distinct entries leaves their relative order
 * to `Array.prototype.sort`'s input order, which is the very thing this file
 * exists to keep out of the result.
 */
function compareCanonically(a: TestSpecification, b: TestSpecification): number {
  return (
    compareCodeUnits(a.moduleId, b.moduleId) ||
    compareCodeUnits(a.project.name, b.project.name) ||
    compareCodeUnits(a.pool, b.pool)
  );
}

/**
 * The canonical order of a collected set, independent of how it was collected.
 * Exported so a probe can predict a run's file order without running it.
 */
export function canonicalOrder(files: readonly TestSpecification[]): TestSpecification[] {
  return [...files].sort(compareCanonically);
}

/**
 * Canonical sort, THEN the seeded shuffle (NR-22 / FU-01).
 *
 * Installed by the root config only on the file-shuffle path; see the block
 * comment above for the three bounds.
 *
 * ## Why it announces its own seed
 *
 * Vitest prints `Running tests with seed "N"` only when the sequencer IS its own
 * `RandomSequencer`, so installing any custom sequencer silences that banner —
 * and an ad-hoc shuffled run given no `--sequence.seed` would then draw a seed
 * that nothing announces, which is a replay key nobody can write down. That is
 * the one thing this whole change exists to prevent, so the sequencer announces
 * the seed it RESOLVED — the CLI's value when there is one, the drawn default
 * when there is not — at the moment it uses it. To stderr, because stdout is the
 * report a machine parses. Every CI and script path passes an explicit seed, so
 * none of them depends on this line; the operator running one shuffled suite by
 * hand does.
 */
export class CanonicalFileSequencer extends BaseSequencer {
  public override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const resolvedSeed = this.ctx.config.sequence.seed ?? Date.now();
    process.stderr.write(
      `Running files with seed "${String(resolvedSeed)}" (canonical file sequencer)\n`,
    );
    return shuffleBySeed(canonicalOrder(files), resolvedSeed);
  }
}

/**
 * The two spellings that turn FILE shuffling on. Bare `--sequence.shuffle` is
 * Vitest's "shuffle files AND tests"; `--sequence.shuffle.tests` is deliberately
 * absent, because tests-only shuffling must not reorder files.
 */
const FILE_SHUFFLE_FLAGS = new Set(['--sequence.shuffle', '--sequence.shuffle.files']);

/** cac's `--no-` prefix form of the same two. */
const NEGATED_FLAGS = new Set(['--no-sequence.shuffle', '--no-sequence.shuffle.files']);

/** Values that turn one of those flags OFF, in either the `=` or the value form. */
const FALSEY_VALUES = new Set(['false', '0']);

/**
 * Did this invocation ask for a FILE shuffle?
 *
 * Read from the command line rather than from the resolved config, because the
 * resolved config no longer carries the answer: Vitest folds
 * `sequence.shuffle: { files, tests }` down to `sequence.shuffle = tests` while
 * choosing the sequencer, so by the time a sequencer could ask, the `files` half
 * is gone. Measured on 3.2.4:
 *
 * ```
 * --sequence.shuffle.files --sequence.seed=1  → {"sequencer":…,"seed":1}
 * (no shuffle flags at all)                   → {"sequencer":…}
 * ```
 *
 * — indistinguishable but for a seed that means nothing on its own.
 *
 * **The two ways of being wrong are not symmetric.** A false negative — an
 * invocation that asks for a file shuffle in a spelling this does not recognise
 * — leaves `sequence.sequencer` unset, so Vitest installs its own
 * `RandomSequencer` and the run shuffles exactly as it did before this change:
 * the retirement does not apply to that spelling, and nothing the repository had
 * is lost. A false POSITIVE is the harmful direction, because it would shuffle
 * files for a run Vitest would not have shuffled.
 *
 * So the spellings are modelled after cac's actual parsing rather than matched
 * as bare tokens, and the difference is measured rather than argued: the first
 * spelling of this predicate scanned exact tokens only, and it therefore read
 * `--sequence.shuffle.files false` and `--sequence.shuffle false` — where cac
 * consumes the NEXT token as the option's value — as requests to shuffle, which
 * Vitest does not (2 of the 16 measured argv shapes; the review's finding C-1).
 * Both value forms and both negations are now parsed, and the whole table is
 * pinned by `test/architecture/file-sequencer.test.ts`.
 *
 * **The honest bound, in place of an impossibility claim:** false positives
 * remain possible for argv shapes in which one of these tokens appears as
 * another option's VALUE (`--some-option --sequence.shuffle.files`, were such an
 * option to exist), because this reads the argv without Vitest's option schema.
 * The value form of the flags themselves is modelled, and none of this
 * repository's invocations — `package.json`, `scripts/`, `.github/workflows/` —
 * produces such a shape.
 */
export function fileShuffleRequested(argv: readonly string[]): boolean {
  let requested = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (NEGATED_FLAGS.has(token)) {
      requested = false;
      continue;
    }

    /* `--flag=value`. */
    const equals = token.indexOf('=');
    if (equals !== -1) {
      if (FILE_SHUFFLE_FLAGS.has(token.slice(0, equals))) {
        requested = !FALSEY_VALUES.has(token.slice(equals + 1));
      }
      continue;
    }

    if (!FILE_SHUFFLE_FLAGS.has(token)) continue;

    /* `--flag value`. cac consumes the following token as this option's value
     * unless it is itself an option, so `--sequence.shuffle.files false` is a
     * request NOT to shuffle — the shape the first spelling of this predicate
     * read as a request TO shuffle. */
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      requested = !FALSEY_VALUES.has(next);
      index += 1;
    } else {
      requested = true;
    }
  }
  return requested;
}
