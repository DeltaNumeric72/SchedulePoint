import { describe, expect, it } from 'vitest';

import { errorEnvelopeSchema, healthStatusSchema } from '../src/index.js';

describe('healthStatusSchema', () => {
  it('accepts a well-formed health payload', () => {
    const parsed = healthStatusSchema.parse({
      status: 'ok',
      checkedAt: '2026-08-01T00:00:00.000Z',
      correlationId: 'c-1',
    });
    expect(parsed.status).toBe('ok');
  });

  it('rejects unknown keys rather than stripping them', () => {
    const result = healthStatusSchema.safeParse({
      status: 'ok',
      checkedAt: '2026-08-01T00:00:00.000Z',
      correlationId: 'c-1',
      extra: 'should not be tolerated',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    const result = healthStatusSchema.safeParse({
      status: 'ok',
      checkedAt: 'yesterday',
      correlationId: 'c-1',
    });
    expect(result.success).toBe(false);
  });
});

describe('errorEnvelopeSchema', () => {
  it('requires a screaming-snake-case code', () => {
    expect(
      errorEnvelopeSchema.safeParse({
        error: { code: 'not_upper', message: 'x', correlationId: 'c-1' },
      }).success,
    ).toBe(false);

    expect(
      errorEnvelopeSchema.safeParse({
        error: { code: 'NOT_FOUND', message: 'x', correlationId: 'c-1' },
      }).success,
    ).toBe(true);
  });
});
