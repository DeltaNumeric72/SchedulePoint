import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT, lineOf, lineStarts, listFiles, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Secret scan.
 *
 * **Why this is hand-rolled.** The gate list names a gitleaks-class scanner.
 * gitleaks is a Go binary and the execution environment has no Docker, no
 * Homebrew and no sudo (FAD-7), so it cannot be installed here. Rather than
 * declare the gate "blocked", this implements the same *shape* of check —
 * regex detectors for the credential formats that actually leak — with unit
 * tests that prove each detector fires and that the placeholder logic does not
 * swallow a real key. Replacing it with gitleaks in CI later is a config change,
 * not a redesign.
 *
 * **What it does not do.** No entropy analysis, no git-history scan, no
 * verification against the issuing provider. A high-entropy string with no
 * recognisable prefix will pass. This is a floor, not a ceiling, and it is
 * recorded as a known limitation rather than described as full coverage.
 */

/** @typedef {{ file: string, line: number, detail: string }} Violation */

/**
 * @typedef {{ id: string, description: string, pattern: RegExp, placeholderGroup?: number }} Detector
 */

/**
 * Detectors. Each pattern targets a *format*, so a match is a credential shape
 * rather than "a long string".
 *
 * @type {Detector[]}
 */
export const DETECTORS = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key assignment',
    pattern: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
    placeholderGroup: 1,
  },
  {
    id: 'private-key-block',
    description: 'PEM private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'stripe-secret-key',
    description: 'Stripe secret key',
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'json-web-token',
    description: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: 'connection-string-password',
    description: 'connection string with an inline password',
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)::?\/\/[^\s:'"/]+:([^\s@'"/]+)@/g,
    placeholderGroup: 1,
  },
  {
    id: 'generic-secret-assignment',
    description: 'quoted assignment to a secret-named identifier',
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']([^"'\n]{12,})["']/gi,
    placeholderGroup: 1,
  },
];

/**
 * Values that are obviously not credentials.
 *
 * Deliberately conservative: it recognises *declared* placeholders and template
 * expressions, not "looks a bit short". A permissive placeholder list is how a
 * secret scanner becomes decorative.
 */
const PLACEHOLDER_EXACT = new Set(
  [
    'changeme',
    'change-me',
    'change_me',
    'replaceme',
    'replace-me',
    'replace_me',
    'example',
    'placeholder',
    'dummy',
    'redacted',
    'notarealsecret',
    'your-secret-here',
    'xxxxxxxxxxxx',
  ].map((s) => s.toLowerCase()),
);

const PLACEHOLDER_CONTAINS = ['${', '<', 'process.env', 'your_', 'your-', 'todo', 'sops:'];

/**
 * Values whose **leading token** declares them a throwaway local credential —
 * `spike-local-runtime`, `dev_local_password`. The prefix must start the value;
 * a real key that merely contains the word "test" is still reported.
 *
 * This is the one concession that lets the scanner run over the whole
 * repository (spike fixtures included) instead of excluding directories, which
 * would be a much larger hole.
 */
const LOCAL_CREDENTIAL_PREFIX = /^(?:spike|dev|local|sample|fixture)[-_](?:local[-_])?/i;

/** @param {string} value */
export function isPlaceholder(value) {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_EXACT.has(lower)) return true;
  if (LOCAL_CREDENTIAL_PREFIX.test(trimmed)) return true;
  return PLACEHOLDER_CONTAINS.some((token) => lower.includes(token));
}

/**
 * @param {{ path: string, text: string }[]} files
 * @returns {Violation[]}
 */
export function analyze(files) {
  /** @type {Violation[]} */
  const violations = [];

  for (const { path, text } of files) {
    const starts = lineStarts(text);
    for (const detector of DETECTORS) {
      detector.pattern.lastIndex = 0;
      for (const match of text.matchAll(detector.pattern)) {
        const captured =
          detector.placeholderGroup === undefined ? undefined : match[detector.placeholderGroup];
        if (captured !== undefined && isPlaceholder(captured)) continue;
        violations.push({
          file: path,
          line: lineOf(starts, match.index ?? 0),
          detail: `${detector.id}: ${detector.description}`,
        });
      }
    }
  }

  return violations;
}

/**
 * Paths excluded from the scan.
 *
 * The red-case fixtures are excluded because they exist precisely to contain
 * key-shaped strings; without the exclusion the gate would fail on the proof
 * that the gate works. The exclusion is one narrow glob, and the red-case runner
 * re-runs this scanner *against* those fixtures with the exclusion off, so the
 * excluded content is still checked — just by the test that needs it to match.
 */
const EXCLUDED = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)scripts\/red-cases\/[^/]+\/fixture\//,
  /(^|\/)\.git\//,
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz)$/i,
];

/** @param {string} path */
function isExcluded(path) {
  const norm = path.replaceAll('\\', '/');
  return EXCLUDED.some((re) => re.test(norm));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = typeof args['dir'] === 'string' ? resolve(args['dir']) : REPO_ROOT;
  const noExclude = args['no-exclude'] === true;

  const files = listFiles(dir)
    .map((path) => rel(path))
    .filter((path) => noExclude || !isExcluded(path))
    .map((path) => {
      try {
        return { path, text: readFileSync(resolve(REPO_ROOT, path), 'utf8') };
      } catch {
        return { path, text: '' };
      }
    });

  process.exit(
    report(
      'secret-scan',
      analyze(files),
      `${String(files.length)} file(s) under ${rel(dir)}, ${String(DETECTORS.length)} detectors`,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
