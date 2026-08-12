import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT, lineOf, lineStarts, listFiles, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Provider-outside-transaction gate — **SPEC-12 U-07**, doc 34 §4-H.
 *
 * SPEC-12 U-07: a provider or RPC call may not occur inside a database unit of
 * work. Database snapshot creation and external execution are separate,
 * explicit phases. This gate is the STATIC half; the runtime half is
 * `apps/api/src/db/provider-boundary.ts` and the domain decision it wraps.
 *
 * It exists before any provider does, deliberately: M4-001's solver RPC is the
 * first provider, and it will be written against a boundary that already
 * refuses rather than having one retrofitted around it.
 *
 * ## What a "provider module" is, and why it is declared rather than guessed
 *
 * A module is a provider port implementation when its text contains the marker
 *
 *     @provider-port <name>
 *
 * Declared, not inferred. An inferred rule ("anything that imports `undici`",
 * "anything with `fetch`") is a rule whose scope drifts silently as the codebase
 * grows, and the drift is invisible because the gate keeps saying PASS. A marker
 * is greppable, is reviewed when it appears in a diff, and cannot be acquired by
 * accident. The same sentinel discipline as `rule-node-mapping-check.mjs`.
 *
 * ## Three violation classes
 *
 *  1. **unguarded entry point** — an exported function in a provider module
 *     whose body does not OPEN with `assertOutsideUnitOfWork(`. The guard is
 *     only a guard if it runs before the work; a call further down has already
 *     let the caller past it.
 *  2. **provider inside a unit of work** — a name imported from a provider
 *     module, appearing lexically inside a `.run(…)` unit-of-work callback body.
 *     This is the ordinary case a reviewer would want caught at build time.
 *  3. **provider opens a transaction** — a provider module that itself imports
 *     the unit-of-work runner. A provider that can open a transaction can put
 *     itself inside one, and then class 2 has nothing to see.
 *
 * ## What this gate deliberately CANNOT catch, and why that is stated
 *
 * A dynamic `await import(...)`, a callback captured outside the transaction and
 * invoked inside it, a provider reached through a lookup table: none of them is
 * visible to a source scan, and pretending otherwise is how a decorative gate
 * gets trusted. Those are the runtime guard's job, and the packet's mutation
 * case attacks exactly them — the red case reaches a provider through an
 * indirection this gate does not see, and proves the RUNTIME arm still fires.
 *
 * ## Non-vacuity
 *
 * A gate that scans zero provider modules passes forever. So the gate FAILS when
 * it finds none, and names the fact. Until M4-001's solver provider lands the
 * population is `apps/api/test/support/provider-probe.ts`, which is a real
 * provider port implementation used by the boundary's own proofs.
 *
 * Read-only. It parses source and writes nothing.
 */

/** @typedef {{ file: string, line: number, detail: string }} Violation */

const DEFAULT_ROOTS = ['apps/api/src', 'apps/api/test/support'];

/**
 * The marker must be a doc-comment line of its OWN — ` * @provider-port <name>`
 * and nothing else on the line.
 *
 * Written this narrowly because the first spelling (`@provider-port` anywhere in
 * the text) matched the phrase inside a sibling module's docblock that merely
 * DESCRIBED the marker, and quietly recruited a bookkeeping helper into the
 * provider population. A marker that can be acquired by talking about it is not
 * a declaration.
 */
const PROVIDER_MARKER = /^[ \t]*\*[ \t]*@provider-port[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*$/m;
const GUARD_CALL = 'assertOutsideUnitOfWork(';
const RUNNER_IMPORT = /from\s+'[^']*\bunit-of-work(?:\.js)?'/;

/**
 * Exported function declarations and exported arrow constants, with the offset
 * at which their BODY begins (the character after the opening brace).
 *
 * @param {string} text
 * @returns {{ name: string, at: number, bodyAt: number }[]}
 */
function exportedEntryPoints(text) {
  /** @type {{ name: string, at: number, bodyAt: number }[]} */
  const found = [];

  const declaration = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
  for (const match of text.matchAll(declaration)) {
    const name = match[1];
    if (name === undefined) continue;
    const bodyAt = bodyStartAfterSignature(text, (match.index ?? 0) + match[0].length - 1);
    if (bodyAt === -1) continue;
    found.push({ name, at: match.index ?? 0, bodyAt });
  }

  const arrow = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g;
  for (const match of text.matchAll(arrow)) {
    const name = match[1];
    if (name === undefined) continue;
    const bodyAt = bodyStartAfterSignature(text, (match.index ?? 0) + match[0].length - 1);
    if (bodyAt === -1) continue;
    found.push({ name, at: match.index ?? 0, bodyAt });
  }

  return found.sort((a, b) => a.at - b.at);
}

/**
 * From the offset of a `(`, skip the balanced parameter list and any return-type
 * annotation, and return the offset just after the body's opening `{`.
 *
 * @param {string} text
 * @param {number} openParenAt
 * @returns {number} -1 when no body brace follows
 */
function bodyStartAfterSignature(text, openParenAt) {
  const afterParams = matchBalanced(text, openParenAt, '(', ')');
  if (afterParams === -1) return -1;
  for (let i = afterParams; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') return i + 1;
    if (ch === ';' || ch === '\n') {
      // A return-type annotation may span lines; only a `;` truly ends the
      // declaration (an overload signature, which has no body).
      if (ch === ';') return -1;
    }
  }
  return -1;
}

/**
 * @param {string} text
 * @param {number} openAt offset of the opening delimiter
 * @param {string} open
 * @param {string} close
 * @returns {number} offset just after the matching close, or -1
 */
function matchBalanced(text, openAt, open, close) {
  let depth = 0;
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The first statement of a body, ignoring comments and whitespace.
 *
 * @param {string} text
 * @param {number} bodyAt
 * @returns {string}
 */
function firstStatement(text, bodyAt) {
  let i = bodyAt;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    const ch = text[i] ?? '';
    if (ch.trim() === '') {
      i += 1;
      continue;
    }
    break;
  }
  const end = text.indexOf(';', i);
  return text.slice(i, end === -1 ? Math.min(text.length, i + 200) : end + 1);
}

/**
 * Names imported into `text` from any module in `providerFiles`.
 *
 * Matching is by module SPECIFIER basename, which is enough here: a provider
 * module is a file, and the importing file names it by path.
 *
 * @param {string} text
 * @param {Set<string>} providerBasenames
 * @returns {Set<string>}
 */
function providerNamesImported(text, providerBasenames) {
  /** @type {Set<string>} */
  const names = new Set();
  const importer = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+'([^']+)'/g;
  for (const match of text.matchAll(importer)) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? '';
    const base = (specifier.split('/').pop() ?? '').replace(/\.js$/, '');
    if (!providerBasenames.has(base)) continue;
    for (const piece of clause.split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== '') names.add(name);
    }
  }
  return names;
}

/**
 * Every unit-of-work callback body in `text`, as `[start, end)` offsets.
 *
 * A unit-of-work callback is the argument list of a `.run(` call — the only
 * shape `UnitOfWorkRunner` exposes (there is no `commit()`/`rollback()`, so a
 * transaction body cannot be written any other way). The whole balanced
 * argument list is taken rather than trying to isolate the function expression:
 * the context argument beside it never names a provider, and a wider window
 * cannot produce a false NEGATIVE.
 *
 * @param {string} text
 * @returns {{ start: number, end: number }[]}
 */
function unitOfWorkCallbackRanges(text) {
  /** @type {{ start: number, end: number }[]} */
  const ranges = [];
  const call = /\.run\s*\(/g;
  for (const match of text.matchAll(call)) {
    const openAt = (match.index ?? 0) + match[0].length - 1;
    const end = matchBalanced(text, openAt, '(', ')');
    if (end === -1) continue;
    ranges.push({ start: openAt, end });
  }
  return ranges;
}

/**
 * @param {string[]} roots
 */
export function analyze(roots = DEFAULT_ROOTS) {
  /** @type {Violation[]} */
  const violations = [];

  /** @type {{ path: string, text: string, provider: string }[]} */
  const providers = [];
  /** @type {{ path: string, text: string }[]} */
  const all = [];

  for (const root of roots) {
    for (const file of listFiles(resolve(REPO_ROOT, root))) {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
      if (file.endsWith('.d.ts')) continue;
      const text = readFileSync(file, 'utf8');
      all.push({ path: file, text });
      const marker = PROVIDER_MARKER.exec(text);
      if (marker !== null) providers.push({ path: file, text, provider: marker[1] ?? 'unnamed' });
    }
  }

  if (providers.length === 0) {
    violations.push({
      file: roots.join(', '),
      line: 1,
      detail:
        'no module declares `@provider-port` — the gate would pass vacuously. ' +
        'Every provider port implementation must carry the marker (SPEC-12 U-07).',
    });
  }

  const providerBasenames = new Set(
    providers.map((p) => (p.path.split('/').pop() ?? '').replace(/\.tsx?$/, '')),
  );

  /* Class 1 — an exported entry point that does not OPEN with the guard, and
   * class 3 — a provider module that can open a transaction of its own. */
  for (const provider of providers) {
    const starts = lineStarts(provider.text);

    if (RUNNER_IMPORT.test(provider.text)) {
      violations.push({
        file: rel(provider.path),
        line: lineOf(starts, RUNNER_IMPORT.exec(provider.text)?.index ?? 0),
        detail:
          `provider module '${provider.provider}' imports the unit-of-work runner. ` +
          'A provider that can open a transaction can put itself inside one (SPEC-12 U-07).',
      });
    }

    for (const entry of exportedEntryPoints(provider.text)) {
      const opening = firstStatement(provider.text, entry.bodyAt);
      if (!opening.includes(GUARD_CALL)) {
        violations.push({
          file: rel(provider.path),
          line: lineOf(starts, entry.at),
          detail:
            `provider entry point '${entry.name}' does not open with ${GUARD_CALL}…). ` +
            'The guard is only a guard if it runs before the work (SPEC-12 U-07).',
        });
      }
    }
  }

  /* Class 2 — a provider name used inside a unit-of-work callback body. */
  for (const file of all) {
    if (providerBasenames.size === 0) break;
    const imported = providerNamesImported(file.text, providerBasenames);
    if (imported.size === 0) continue;
    const starts = lineStarts(file.text);
    for (const range of unitOfWorkCallbackRanges(file.text)) {
      const body = file.text.slice(range.start, range.end);
      for (const name of imported) {
        const used = new RegExp(`\\b${name}\\s*\\(`).exec(body);
        if (used === null) continue;
        violations.push({
          file: rel(file.path),
          line: lineOf(starts, range.start + (used.index ?? 0)),
          detail:
            `provider '${name}' is called inside a unit-of-work callback. ` +
            'SPEC-12 U-07: assemble inside the transaction, call the provider after it commits.',
        });
      }
    }
  }

  return { violations, providerCount: providers.length, scannedCount: all.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args['dir'];
  const roots = typeof dir === 'string' ? [dir] : DEFAULT_ROOTS;
  const { violations, providerCount, scannedCount } = analyze(roots);
  const summary =
    `${String(scannedCount)} module(s) under ${roots.join(', ')}, ` +
    `${String(providerCount)} declared @provider-port module(s)`;
  process.exit(report('provider outside unit of work (SPEC-12 U-07)', violations, summary));
}

main();
