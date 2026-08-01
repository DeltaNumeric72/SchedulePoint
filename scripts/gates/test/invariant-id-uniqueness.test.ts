import { describe, expect, it } from 'vitest';

// @ts-expect-error -- gate scripts are plain JS with JSDoc types; there is no .d.ts.
import { analyze } from '../invariant-id-uniqueness.mjs';

/**
 * Invariant-ID uniqueness tests.
 *
 * The defect this gate exists to prevent is specific and historical: `I-05`
 * once meant two different things in two different documents (CAR-023). The
 * first test below reconstructs exactly that situation.
 */

interface Violation {
  file: string;
  line: number;
  detail: string;
}

function run(files: { path: string; text: string }[]): Violation[] {
  return (analyze(files) as { violations: Violation[] }).violations;
}

const REGISTER = [
  '# Architecture overview',
  '',
  '| ID | Rule |',
  '|---|---|',
  '| **I-01** | Tenant context is client-declared and server-verified |',
  '| **I-05** | Automated scheduling is the production mechanism |',
  '| **I-13** | No control labelled Add, New, or Create persists before Save |',
  '',
].join('\n');

describe('duplicate definitions', () => {
  it('reconstructs CAR-023: the same ID defined in two documents', () => {
    const violations = run([
      { path: 'docs/architecture/01-overview.md', text: REGISTER },
      {
        path: 'docs/architecture/10-state-machines.md',
        text: '| **I-05** | No control labelled Add, New, or Create persists before Save |\n',
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('I-05 defined 2 times');
    expect(violations[0]?.detail).toContain('10-state-machines.md');
  });

  it('catches the same ID defined twice within one document', () => {
    const violations = run([
      {
        path: 'docs/architecture/01-overview.md',
        text: `${REGISTER}| **I-01** | something else entirely |\n`,
      },
    ]);
    expect(violations.map((v) => v.detail).join(' ')).toContain('I-01 defined 2 times');
  });

  it('accepts a clean register', () => {
    expect(run([{ path: 'docs/architecture/01-overview.md', text: REGISTER }])).toEqual([]);
  });
});

describe('dangling references', () => {
  it('flags an ID cited but never defined — the renumber-and-forget signature', () => {
    const violations = run([
      { path: 'docs/architecture/01-overview.md', text: REGISTER },
      { path: 'docs/architecture/06-data.md', text: 'This follows from I-42 and I-05.\n' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toBe('I-42 referenced but never defined');
  });
});

describe('mirror documents', () => {
  it('does not treat a drafts restatement as a second definition', () => {
    expect(
      run([
        { path: 'docs/architecture/01-overview.md', text: REGISTER },
        {
          path: 'docs/architecture/drafts/CLAUDE.md',
          text: '| **I-05** | Automated scheduling is the production mechanism |\n',
        },
      ]),
    ).toEqual([]);
  });

  it('does flag a mirror restating an ID the register never defines', () => {
    const violations = run([
      { path: 'docs/architecture/01-overview.md', text: REGISTER },
      { path: 'docs/architecture/drafts/CLAUDE.md', text: '| **I-99** | invented |\n' },
    ]);
    expect(violations.some((v) => v.detail.includes('I-99'))).toBe(true);
  });
});

describe('the real corpus', () => {
  it('is clean', async () => {
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error -- gate helper is plain JS.
    const { listFiles, REPO_ROOT } = await import('../lib/gate.mjs');
    const { resolve } = await import('node:path');

    const files = (listFiles(resolve(REPO_ROOT, 'docs/architecture')) as string[])
      .filter((f) => f.endsWith('.md'))
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

    expect(files.length).toBeGreaterThan(20);
    expect(run(files)).toEqual([]);
  });
});
