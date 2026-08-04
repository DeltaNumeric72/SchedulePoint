import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { TOKEN_SCAN_EXEMPTIONS, scanForHardCodedTokens } from './support/token-scan.js';

/**
 * **Components consume tokens; they never define colours.** SP-E brief §4.
 *
 * Both directions, in one file:
 *
 *  * **GREEN** — the real `src/` tree is clean;
 *  * **RED** — the scanner is run against a fixture that violates each detector
 *    on disk, and must report each one.
 *
 * The red half is the part that makes the green half mean anything. A scanner
 * with a typo'd pattern, a walk over the wrong directory, or an over-broad
 * exemption reports "0 findings" forever, and the first anyone hears of it is a
 * palette change that leaves a component behind. This is the same lesson
 * `audit-emission-scan.ts` was moved out of its test file for (R-02).
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function fixture(files: Readonly<Record<string, string>>): string {
  scratch = mkdtempSync(join(tmpdir(), 'sp-token-scan-'));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(scratch, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return scratch;
}

describe('GREEN — no component defines a colour or a raw size', () => {
  it('the shipped src tree is clean', () => {
    const findings = scanForHardCodedTokens(SRC);
    expect(
      findings.map((finding) => `${finding.file}:${String(finding.line)} ${finding.detail}`),
      'a component names a colour or a raw pixel size instead of a token',
    ).toEqual([]);
  });

  it('the exemption list is short, and every entry carries a reason', () => {
    // An exemption nobody wrote down is indistinguishable from an oversight.
    expect(TOKEN_SCAN_EXEMPTIONS.length).toBeLessThanOrEqual(2);
    for (const entry of TOKEN_SCAN_EXEMPTIONS) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(10);
    }
  });
});

describe('RED — the scanner reports each violation class', () => {
  it('a hex colour in a component is reported', () => {
    const root = fixture({
      'catalogue/Bad.tsx': 'export const c = <span style={{ color: "#1a4fa0" }} />;\n',
    });
    const findings = scanForHardCodedTokens(root, { exempt: [] });
    expect(findings.map((f) => f.detail)).toContain(
      'hex-colour: names a hex colour; use a design token',
    );
  });

  it('an rgb()/hsl() colour is reported', () => {
    const root = fixture({ 'catalogue/Bad.css': '.x { color: rgb(10 20 30); }\n' });
    const findings = scanForHardCodedTokens(root, { exempt: [] });
    expect(findings.map((f) => f.detail)).toContain(
      'rgb-colour: names a colour function; use a design token',
    );
  });

  it('a raw pixel size in an inline style is reported', () => {
    const root = fixture({
      'catalogue/Bad.tsx': 'export const c = <span style={{ minHeight: "44px" }} />;\n',
    });
    const findings = scanForHardCodedTokens(root, { exempt: [] });
    expect(findings.map((f) => f.detail)).toContain(
      'pixel-size: hard-codes a pixel size in an inline style; use a token',
    );
  });

  it('a colour inside a COMMENT is not reported — the ratios are documented in comments', () => {
    // The scanner would be useless if it forced the contrast notes out of the
    // token file, and it would be worse than useless if people learned to
    // ignore it.
    const root = fixture({
      'catalogue/Fine.tsx': '// #1a4fa0 is 8.3:1 on white\nexport const c = 1;\n',
    });
    expect(scanForHardCodedTokens(root, { exempt: [] })).toEqual([]);
  });

  it('an exempted file is skipped, and nothing else is', () => {
    const root = fixture({
      'styles/tokens.css': ':root { --sp-color-accent: #1a4fa0; }\n',
      'catalogue/Bad.tsx': 'export const c = <span style={{ color: "#1a4fa0" }} />;\n',
    });
    const findings = scanForHardCodedTokens(root);
    expect(findings.map((f) => f.file)).toEqual(['catalogue/Bad.tsx']);
  });
});
