import { defineConfig } from 'vitest/config';

import { CanonicalFileSequencer, fileShuffleRequested } from './apps/api/vitest.config';

/**
 * One test run for the whole workspace.
 *
 * Vitest projects rather than per-package invocations: a single `vitest run`
 * cannot silently skip a package, and the gate cannot be satisfied by a subset.
 *
 * ## Why the NR-22 sequencer is installed HERE (FU-01)
 *
 * The class and its reasoning live in `apps/api/vitest.config.ts`, which is
 * where a reader looking for the `api` project's ordering will look. It has to
 * be INSTALLED here, and that is measured rather than assumed: Vitest 3.2.4
 * reads the sequencer once per run, from the root configuration
 * (`ctx.config.sequence.sequencer`, where `ctx` is the Vitest instance), and a
 * `sequence.sequencer` set on a PROJECT is silently ignored — a probe sequencer
 * placed on a project printed nothing on a real run, and the same class placed
 * here printed on every one.
 *
 * The installation is conditional, and that is the whole of the "shuffle OFF is
 * untouched" guarantee: with no file shuffle requested there is no `sequence`
 * key in this config at all, so Vitest resolves `BaseSequencer` down exactly the
 * path it resolved before this change existed.
 *
 * `seed` restores a default Vitest applies only to its own `RandomSequencer`
 * (`resolved.sequence.seed ??= Date.now()` fires only when the sequencer IS
 * `RandomSequencer`), so a shuffled run with no `--sequence.seed` still draws
 * one seed for the whole run rather than leaving each worker to draw its own for
 * the within-file shuffle. An explicit `--sequence.seed=N` overrides it: the CLI
 * wins over a config value, measured on 3.2.4 (config 777 + `--sequence.seed=1`
 * resolved to 1).
 */
const FILE_SHUFFLE = fileShuffleRequested(process.argv.slice(2));

export default defineConfig({
  test: {
    projects: [
      './packages/contracts/vitest.config.ts',
      './packages/domain/vitest.config.ts',
      './apps/api/vitest.config.ts',
      './apps/web/vite.config.ts',
      './scripts/gates/vitest.config.ts',
    ],
    ...(FILE_SHUFFLE ? { sequence: { sequencer: CanonicalFileSequencer, seed: Date.now() } } : {}),
  },
});
