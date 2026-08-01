/**
 * RED CASE — unit tests.
 *
 * A test that genuinely fails. `vitest run` must exit non-zero.
 */
import { describe, expect, it } from 'vitest';

describe('red case', () => {
  it('fails on purpose', () => {
    expect(1 + 1).toBe(3);
  });
});
