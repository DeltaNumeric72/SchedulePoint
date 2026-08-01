import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- gate scripts are plain JS with JSDoc types; there is no .d.ts.
import { analyze } from '../request-budget.mjs';
// @ts-expect-error -- gate helper is plain JS.
import { REPO_ROOT } from '../lib/gate.mjs';

/**
 * Requests-per-interaction budget tests — SP-HR-2 / I-10.
 *
 * The most important test here is `missing recording is a failure`. Without it
 * the cheapest way to satisfy the budget would be to break the browser run that
 * produces the measurements, and the gate would report PASS while measuring
 * nothing.
 */

interface Violation {
  file: string;
  line: number;
  detail: string;
}

const BUDGETS = [
  { id: 'health-retry-click', description: 'one click', maxRequests: 1 },
  { id: 'shell-initial-load', description: 'cold load', maxRequests: 8 },
];

function recording(interaction: string, count: number, project = 'desktop') {
  return {
    path: `recordings/${interaction}.${project}.json`,
    recording: {
      interaction,
      project,
      requests: Array.from({ length: count }, (_, i) => ({
        method: 'GET',
        url: `/api/thing/${String(i)}`,
      })),
    },
  };
}

function run(recordings: ReturnType<typeof recording>[], budgets = BUDGETS): Violation[] {
  return analyze({ budgets, recordings }) as Violation[];
}

describe('budget enforcement', () => {
  it('passes when every interaction is within budget', () => {
    expect(run([recording('health-retry-click', 1), recording('shell-initial-load', 5)])).toEqual(
      [],
    );
  });

  it('fails when one click produces two requests (I-10)', () => {
    const violations = run([
      recording('health-retry-click', 2),
      recording('shell-initial-load', 5),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('issued 2 request(s), budget 1');
  });

  it('lists the offending requests so the amplification can be found', () => {
    const violations = run([
      recording('health-retry-click', 3),
      recording('shell-initial-load', 5),
    ]);
    expect(violations[0]?.detail).toContain('/api/thing/0');
    expect(violations[0]?.detail).toContain('/api/thing/2');
  });

  it('checks every project independently', () => {
    const violations = run([
      recording('health-retry-click', 1, 'desktop'),
      recording('health-retry-click', 4, 'mobile'),
      recording('shell-initial-load', 5),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('[mobile]');
  });
});

describe('the gate cannot be satisfied by producing nothing', () => {
  it('fails when a budgeted interaction has no recording', () => {
    const violations = run([recording('shell-initial-load', 5)]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('no recording for budgeted interaction');
  });

  it('fails when there are no recordings at all', () => {
    expect(run([])).toHaveLength(BUDGETS.length);
  });

  it('fails on a recording nobody budgeted', () => {
    const violations = run([
      recording('health-retry-click', 1),
      recording('shell-initial-load', 5),
      recording('undeclared-interaction', 1),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('has no declared budget');
  });
});

describe('the shipped budget file', () => {
  it('declares the strict one-action-one-request example', () => {
    const parsed: { interactions: { id: string; maxRequests: number }[] } = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT as string, 'scripts/gates/request-budget/budgets.json'),
        'utf8',
      ),
    );
    const retry = parsed.interactions.find((i) => i.id === 'health-retry-click');
    expect(retry?.maxRequests).toBe(1);
  });
});
