/**
 * The clock seam — SPEC-16 §4's "controllable virtual clock", as a constructor
 * parameter and nothing else.
 *
 * ## Why this is not a module-level mutable
 *
 * Every expiry in this subsystem is a comparison against a time, and a test that
 * proves an idle deadline by sleeping proves nothing repeatable. So the time has
 * to be injectable. The way it is injectable decides whether the seam is also a
 * production hazard:
 *
 *   - a settable module-level `currentClock` would let any code in the process
 *     move every deadline in the system, including code reached from a request;
 *   - a `SP_AUTHN_FAKE_CLOCK` environment variable would put the switch one
 *     misconfiguration away from a deployment;
 *   - a constructor parameter can only be supplied by whoever CONSTRUCTS the
 *     service, and the only production constructor is `createAuthnService()`
 *     below, which passes `systemClock` unconditionally.
 *
 * There is deliberately no setter, no `withClock`, and no environment branch.
 * `apps/api/test/authn/clock-seam.test.ts` asserts the absence rather than
 * trusting it: it scans this package's shipped source for any assignment to a
 * clock and for any environment read that could select one.
 *
 * ## Deadlines are computed here, never in SQL
 *
 * `now()` in a statement is the database's clock, which no test can move. Every
 * expiry comparison in this subsystem is therefore a **bind parameter** carrying
 * `clock.now()`, and the SQL contains no `now()` in any predicate. Column
 * defaults still use `now()` — `created_at` is a fact about the write, not a
 * deadline anybody compares against.
 */

export interface Clock {
  now(): Date;
}

/** The only clock a production process ever holds. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * A clock a test drives explicitly. **Test support only** — nothing under
 * `src/` other than this declaration mentions it, and nothing constructs it.
 *
 * It lives beside the interface rather than in `test/support` for one reason:
 * the alternative is an `any`-typed double at every call site, and a fake that
 * cannot be type-checked against the real interface eventually stops matching
 * it.
 */
export class ControllableClock implements Clock {
  #instant: Date;

  constructor(start: Date) {
    this.#instant = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.#instant.getTime());
  }

  /** Move forward. Never backwards: a clock that can rewind is not a clock. */
  advance(milliseconds: number): void {
    if (milliseconds < 0) {
      throw new Error(
        'ControllableClock.advance was given a negative interval. A test that needs an ' +
          'earlier instant should construct an earlier clock, not rewind this one — a rewound ' +
          'clock makes "expired" and "not yet issued" the same state.',
      );
    }
    this.#instant = new Date(this.#instant.getTime() + milliseconds);
  }
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
