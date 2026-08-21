import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * **A marquee proof must not be skippable to green** (FAD-50 C-3).
 *
 * ## The defect this closes
 *
 * `real-stack.config.ts` matches exactly one spec, and that spec guards itself
 * on a `SP_REAL_STACK` handshake that **nothing set**. The result was the worst
 * possible shape: `corepack pnpm gate:e2e:real-stack` exited **0** with
 * `2 skipped`, and two docblocks said the handshake was in force. A suite that
 * reports success for having run nothing is not a weaker proof than one that
 * fails — it is a proof that has stopped existing while still appearing in the
 * evidence.
 *
 * The handshake is now set by `real-stack-setup.ts` (one spelling, and the
 * docblocks corrected to match). This is the second half: **the config refuses
 * to pass when no test actually executed.** The first fix could regress silently
 * again — a renamed variable, a `testMatch` that stops matching, a spec moved to
 * another directory — and each of those failure modes ends in the same
 * `0 passed` that used to read as success.
 *
 * ## Why a reporter rather than an assertion in the spec
 *
 * An assertion inside the spec cannot fire when the spec does not run, which is
 * precisely the case under repair. The reporter is outside that circle: it sees
 * the run whether or not anything in it executed.
 *
 * Skips are counted as "did not run" deliberately. `test.skip()` is how the spec
 * declines when its precondition is absent, so a skipped real-stack run means
 * the stack was not there — the exact condition this exists to make loud.
 */
export default class MustRunReporter implements Reporter {
  #executed = 0;
  #skipped = 0;

  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') this.#skipped += 1;
    else this.#executed += 1;
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    if (this.#executed > 0) return undefined;

    process.stdout.write(
      '\nREAL-STACK SUITE RAN NOTHING.\n' +
        `  executed: ${String(this.#executed)}   skipped: ${String(this.#skipped)}\n` +
        '  This configuration exists to prove the 14-step critical path against a real\n' +
        '  browser, a real API, a real database and a real CP-SAT worker. Zero executed\n' +
        '  tests is a FAILED run, not a passed one (FAD-50 C-3).\n' +
        '  Usual cause: the SP_REAL_STACK handshake is not set, so critical-path.spec.ts\n' +
        '  skipped itself. `real-stack-setup.ts` is what sets it.\n\n',
    );
    return { status: result.status === 'passed' ? 'failed' : result.status };
  }
}
