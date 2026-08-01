import { describe, expect, it } from 'vitest';

// @ts-expect-error -- gate scripts are plain JS with JSDoc types; there is no .d.ts.
import { analyze } from '../route-policy-check.mjs';

/**
 * Route-policy gate tests — I-02.
 *
 * The end-to-end proof (boot the real server, register a policy-less route,
 * watch the gate fail) is the red case in `scripts/red-cases/route-policy/`.
 * These tests cover the decision logic, including the case a naive
 * implementation gets wrong: an empty route table must FAIL, not pass.
 */

interface Violation {
  file: string;
  line: number;
  detail: string;
}

const PUBLIC = { kind: 'public', reason: 'liveness probe' };

describe('route policy decision', () => {
  it('accepts a table where every route declares a policy', () => {
    expect(
      analyze([
        { method: 'GET', url: '/health', policy: PUBLIC },
        { method: 'HEAD', url: '/health', policy: PUBLIC },
      ]),
    ).toEqual([]);
  });

  it('rejects a route with no policy', () => {
    const violations = analyze([
      { method: 'GET', url: '/health', policy: PUBLIC },
      { method: 'POST', url: '/rogue', policy: undefined },
    ]) as Violation[];

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('POST /rogue');
  });

  it('rejects a null policy as firmly as a missing one', () => {
    expect(analyze([{ method: 'GET', url: '/x', policy: null }])).toHaveLength(1);
  });

  it('ignores the HEAD route Fastify synthesises from a GET', () => {
    // A synthesised HEAD inherits the GET's config; requiring a separate
    // declaration would train people to add meaningless ones.
    expect(analyze([{ method: 'HEAD', url: '/health', policy: undefined }])).toEqual([]);
  });

  it('treats an empty route table as a failure, not a vacuous pass', () => {
    const violations = analyze([]) as Violation[];
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('zero routes');
  });

  it('reports every offender, not only the first', () => {
    expect(
      analyze([
        { method: 'GET', url: '/a', policy: undefined },
        { method: 'GET', url: '/b', policy: undefined },
        { method: 'GET', url: '/c', policy: PUBLIC },
      ]),
    ).toHaveLength(2);
  });
});
