import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, lineOf, lineStarts, listFiles, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Network-assertion guard — SP-HR-1 / CAP-068 / T-23.
 *
 * **The client never talks to a third-party host.** Not analytics, not a font
 * CDN, not an error reporter, not a map tile server. AGENTS.md calls this the
 * strict, absolute rule; unlike the server-side subprocessor rule (which permits
 * registered processors) it has no conditional form.
 *
 * ## Two scans, because either alone is defeatable
 *
 *  - **first-party source** (`apps/web/src`) — catches intent, with a clear
 *    message, before a bundle exists. Zero tolerance: no allowlist of any kind
 *    applies here.
 *  - **the built bundle** (`apps/web/dist`) — catches a host that arrived inside
 *    a dependency, which no source scan can see.
 *
 * A missing bundle is a **failure**, not a skip. A guard that quietly scans
 * nothing is worse than no guard, because it reports PASS.
 *
 * ## Why the bundle scan needs a second, narrower list
 *
 * A minified dependency contains URLs that are *text*: `http://www.w3.org/2000/svg`
 * is an XML namespace identifier, `https://reactjs.org/docs/error-decoder.html`
 * is a string inside an error message. Neither is ever fetched, and a scanner
 * that cannot tell the difference gets switched off.
 *
 * So `vendorStringHosts` tolerates those — **but only when the URL is not in a
 * request-shaped context.** If an allowlisted host turns up next to `fetch(`,
 * `new WebSocket(`, `.src=`, `sendBeacon(` or friends, it fails anyway. The
 * escape hatch covers message text; it does not cover requests.
 *
 * Allowlist: `scripts/gates/client-host-allowlist.json`.
 */

const HOST = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}`;
const IPV4 = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;
const URL_PATTERN = new RegExp(
  String.raw`(?:https?:|wss?:)?\/\/(?:${HOST}|${IPV4}|localhost)(?::\d+)?[^\s'"\`)\]<>]*`,
  'g',
);

/**
 * Tokens that mean "this URL is about to be requested".
 *
 * Matched against the 48 characters immediately preceding the URL, which
 * survives minification: a minifier removes whitespace, it does not move the
 * callee away from its argument.
 */
const REQUEST_CONTEXT =
  /(?:fetch|WebSocket|EventSource|sendBeacon|importScripts|XMLHttpRequest|\.open|\.src\s*=|\bsrc\s*[:=]|\bhref\s*[:=]|import)\s*\(?\s*["'`]?[^"'`]{0,8}$/;

const REQUEST_CONTEXT_WINDOW = 48;

/**
 * @typedef {{ host: string, reason: string }} VendorStringHost
 * @typedef {{ requestHosts: string[], vendorStringHosts: VendorStringHost[] }} Allowlist
 * @typedef {{ file: string, line: number, detail: string }} Violation
 */

const DEFAULT_ALLOWLIST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'client-host-allowlist.json',
);

/** @param {string} [file] @returns {Allowlist} */
export function loadAllowlist(file = DEFAULT_ALLOWLIST_PATH) {
  if (!existsSync(file)) return { requestHosts: [], vendorStringHosts: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return {
    requestHosts: Array.isArray(raw.requestHosts) ? raw.requestHosts : [],
    vendorStringHosts: Array.isArray(raw.vendorStringHosts) ? raw.vendorStringHosts : [],
  };
}

/**
 * Extracts absolute/protocol-relative URL references from a text blob.
 *
 * Comments are deliberately **not** stripped. A URL in a comment in client code
 * is still a reviewable signal, and a scanner that understands comments is a
 * scanner that can be fooled by one.
 *
 * @param {string} source
 * @returns {{ url: string, host: string, index: number, requestShaped: boolean }[]}
 */
export function findExternalUrls(source) {
  /** @type {{ url: string, host: string, index: number, requestShaped: boolean }[]} */
  const found = [];
  for (const match of source.matchAll(URL_PATTERN)) {
    const url = match[0];
    const withoutScheme = url.replace(/^(?:https?:|wss?:)/, '').replace(/^\/\//, '');
    const host = (withoutScheme.split(/[/?#:]/)[0] ?? '').toLowerCase();
    if (host === '') continue;
    const index = match.index ?? 0;
    const before = source.slice(Math.max(0, index - REQUEST_CONTEXT_WINDOW), index);
    found.push({ url, host, index, requestShaped: REQUEST_CONTEXT.test(before) });
  }
  return found;
}

/**
 * @param {{ files: { path: string, source: string }[], allowlist: Allowlist, vendorStrings: boolean }} input
 * @returns {Violation[]}
 */
export function analyze({ files, allowlist, vendorStrings }) {
  const permittedHosts = new Set(allowlist.requestHosts.map((h) => h.toLowerCase()));
  const vendorHosts = new Set(
    vendorStrings ? allowlist.vendorStringHosts.map((e) => e.host.toLowerCase()) : [],
  );

  /** @type {Violation[]} */
  const violations = [];

  for (const { path, source } of files) {
    const starts = lineStarts(source);
    for (const hit of findExternalUrls(source)) {
      if (permittedHosts.has(hit.host)) continue;

      if (vendorHosts.has(hit.host)) {
        if (!hit.requestShaped) continue;
        violations.push({
          file: path,
          line: lineOf(starts, hit.index),
          detail: `vendor-string host "${hit.host}" appears in a REQUEST context — the message-text exemption does not apply (${hit.url.slice(0, 120)})`,
        });
        continue;
      }

      violations.push({
        file: path,
        line: lineOf(starts, hit.index),
        detail: `non-allowlisted client host "${hit.host}" (${hit.url.slice(0, 120)})`,
      });
    }
  }

  return violations;
}

const SCANNABLE = /\.(m?[jt]sx?|css|html|json)$/;

/** @param {string} dir */
function readScannable(dir) {
  return listFiles(dir)
    .filter((f) => SCANNABLE.test(f))
    .map((path) => ({ path: rel(path), source: readFileSync(path, 'utf8') }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const webRoot =
    typeof args['web-root'] === 'string'
      ? resolve(args['web-root'])
      : resolve(REPO_ROOT, 'apps/web');
  const allowMissingBundle = args['allow-missing-bundle'] === true;

  const srcDir = resolve(webRoot, 'src');
  const distDir = resolve(webRoot, 'dist');
  const allowlist = loadAllowlist();

  const srcFiles = readScannable(srcDir);
  const bundlePresent = existsSync(distDir);
  const distFiles = bundlePresent ? readScannable(distDir) : [];

  /** @type {Violation[]} */
  const violations = [
    // First-party source: no exemption of any kind applies.
    ...analyze({ files: srcFiles, allowlist, vendorStrings: false }),
    ...analyze({ files: distFiles, allowlist, vendorStrings: true }),
  ];

  if (!bundlePresent && !allowMissingBundle) {
    violations.push({
      file: rel(distDir),
      line: 0,
      detail:
        'built bundle absent — the guard cannot certify the shipped output. Run the build gate first, or pass --allow-missing-bundle to scan source only.',
    });
  }

  // Print the vendor-string list every run. An exemption nobody sees is an
  // exemption that grows.
  for (const entry of allowlist.vendorStringHosts) {
    process.stdout.write(`      vendor string (bundle only): ${entry.host} — ${entry.reason}\n`);
  }

  const bundleNote = bundlePresent
    ? `${String(distFiles.length)} built file(s)`
    : 'built bundle ABSENT';

  process.exit(
    report(
      'network-assertion-guard (SP-HR-1)',
      violations,
      `${String(srcFiles.length)} source file(s), ${bundleNote}; requestHosts allowlist: ${String(allowlist.requestHosts.length)} (must be 0)`,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
