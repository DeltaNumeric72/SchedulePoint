import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ports } from '../src/index.js';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('@schedulepoint/domain', () => {
  it('exports the port registry', () => {
    expect(ports.unitOfWork).toBe('UnitOfWorkRunner');
  });

  /**
   * The dependency-cruiser gate is the enforcement mechanism; this test is the
   * in-package tripwire so a violation is visible in the unit run too.
   */
  it('contains no import of any outward layer', () => {
    const offenders: string[] = [];
    const forbidden =
      /from\s+['"](fastify|pg|kysely|react|@schedulepoint\/(?!domain)|\.\.\/\.\.\/\.\.\/apps)/;

    for (const file of walk(srcDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (forbidden.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
