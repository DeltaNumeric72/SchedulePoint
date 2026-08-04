import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * **A hard-coded colour or size in a component is a review-rejectable defect**
 * (SP-E brief §4), turned into a check.
 *
 * ## Why this exists as code rather than as a review habit
 *
 * The brief states the rule and the packet repeats it, and neither can catch the
 * one that gets written at 5pm. The tokens are the contract SPEC-14's
 * accessibility matrix binds to: a component that writes `#1a4fa0` directly is
 * a component whose contrast is no longer governed by the token file, and the
 * next palette change silently leaves it behind.
 *
 * ## The scanner lives here, not inside its test
 *
 * The same reason `tenant-access-scan.ts` and `audit-emission-scan.ts` do: a
 * check whose rules are re-declared in its own red case proves nothing about
 * the real one. This is exported, the green case runs it over `src/`, and the
 * red case runs **it** over a fixture that violates each pattern.
 *
 * ## What is allowed, and why each exemption is narrow
 *
 * | Allowed | Why |
 * |---|---|
 * | `src/styles/tokens.css` | it IS the token definitions |
 * | `tailwind.config.js` | it maps token names to `var(--sp-…)` and defines no colour of its own |
 * | `scripts/contrast.mjs` | it computes the ratios; the values are its INPUT, and they are asserted against the token file |
 *
 * Nothing under `src/**` other than `tokens.css` may name a colour.
 */

export interface TokenFinding {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export const TOKEN_DETECTORS: readonly {
  readonly id: string;
  readonly pattern: RegExp;
  readonly label: string;
}[] = [
  {
    id: 'hex-colour',
    pattern: /#[0-9a-fA-F]{3,8}\b/,
    label: 'names a hex colour; use a design token',
  },
  {
    id: 'rgb-colour',
    pattern: /\b(?:rgb|rgba|hsl|hsla)\s*\(/,
    label: 'names a colour function; use a design token',
  },
  {
    id: 'pixel-size',
    // A raw pixel length in a style attribute or a CSS-in-JS value. Tailwind
    // utility classes are token-backed and are not this.
    pattern: /style=\{\{[^}]*\b\d+px\b/,
    label: 'hard-codes a pixel size in an inline style; use a token',
  },
];

/** Files exempt from the scan, each with its reason. */
export const TOKEN_SCAN_EXEMPTIONS: readonly { file: string; reason: string }[] = [
  { file: 'styles/tokens.css', reason: 'the token definitions themselves' },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Comments discuss colours constantly — the ratios are documented in them. */
function codeOnly(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*$/, '')
    .replace(/^\s*\*.*$/, '');
}

const SCANNED = /\.(tsx?|css)$/;

/**
 * @param root absolute directory to walk (normally `apps/web/src`).
 */
export function scanForHardCodedTokens(
  root: string,
  options: { readonly exempt?: readonly string[] } = {},
): TokenFinding[] {
  const exempt = new Set(options.exempt ?? TOKEN_SCAN_EXEMPTIONS.map((entry) => entry.file));
  const findings: TokenFinding[] = [];

  for (const absolute of walk(root)) {
    if (!SCANNED.test(absolute)) continue;
    const file = relative(root, absolute).replaceAll('\\', '/');
    if (exempt.has(file)) continue;

    const lines = readFileSync(absolute, 'utf8').split('\n');
    lines.forEach((raw, index) => {
      const code = codeOnly(raw);
      for (const detector of TOKEN_DETECTORS) {
        if (detector.pattern.test(code)) {
          findings.push({ file, line: index + 1, detail: `${detector.id}: ${detector.label}` });
        }
      }
    });
  }

  return findings;
}
