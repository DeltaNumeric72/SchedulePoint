import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT, listFiles, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Invariant-ID uniqueness check.
 *
 * This gate exists because of a real defect: `I-05` once meant **two different
 * things** — "automated scheduling is the production mechanism" in the
 * architecture overview, and the Add/New/Create save contract elsewhere. Finding
 * CAR-023 split them (`I-13` is now the save contract) and required a CI check
 * so it cannot recur. A stable ID that silently changes meaning corrupts every
 * document that cites it, and nothing about the citation looks wrong.
 *
 * Read-only. It parses documentation and writes nothing.
 *
 * Two failures are reported:
 *
 *  - **duplicate definition** — the same `I-nn` defined in more than one place
 *    (mirror documents excluded; see below);
 *  - **dangling reference** — an `I-nn` cited somewhere but defined nowhere,
 *    which is what a renumber-and-forget looks like.
 *
 * A *definition* is a markdown table row whose first cell is exactly `**I-nn**`.
 * Mirror documents (the agent-instruction drafts, which deliberately restate a
 * handful of invariants) do not create definitions; instead their restatements
 * must correspond to an ID the canonical register actually defines.
 */

/** @typedef {{ file: string, line: number, detail: string }} Violation */

const DEFINITION_ROW = /^\|\s*\*\*(I-\d{2})\*\*\s*\|/;
const REFERENCE = /\bI-\d{2}\b/g;

/** Documents that restate invariants rather than defining them. */
const MIRROR = [/\/drafts\//];

/** @param {string} path */
function isMirror(path) {
  return MIRROR.some((re) => re.test(path.replaceAll('\\', '/')));
}

/**
 * @param {{ path: string, text: string }[]} files
 * @returns {{ violations: Violation[], definitions: Map<string, { file: string, line: number }[]>, references: Set<string> }}
 */
export function analyze(files) {
  /** @type {Map<string, { file: string, line: number }[]>} */
  const definitions = new Map();
  /** @type {{ id: string, file: string, line: number }[]} */
  const mirrorDefinitions = [];
  /** @type {Set<string>} */
  const references = new Set();
  /** @type {Map<string, { file: string, line: number }>} */
  const firstReference = new Map();

  for (const { path, text } of files) {
    const lines = text.split('\n');
    lines.forEach((lineText, i) => {
      const def = DEFINITION_ROW.exec(lineText);
      if (def !== null) {
        const id = def[1] ?? '';
        if (isMirror(path)) mirrorDefinitions.push({ id, file: path, line: i + 1 });
        else definitions.set(id, [...(definitions.get(id) ?? []), { file: path, line: i + 1 }]);
      }
      for (const ref of lineText.matchAll(REFERENCE)) {
        const id = ref[0];
        references.add(id);
        if (!firstReference.has(id)) firstReference.set(id, { file: path, line: i + 1 });
      }
    });
  }

  /** @type {Violation[]} */
  const violations = [];

  for (const [id, sites] of [...definitions.entries()].sort()) {
    if (sites.length > 1) {
      violations.push({
        file: sites[0]?.file ?? '?',
        line: sites[0]?.line ?? 0,
        detail: `${id} defined ${String(sites.length)} times: ${sites
          .map((s) => `${s.file}:${String(s.line)}`)
          .join(', ')}`,
      });
    }
  }

  for (const { id, file, line } of mirrorDefinitions) {
    if (!definitions.has(id)) {
      violations.push({
        file,
        line,
        detail: `${id} restated in a mirror document but never defined in the canonical register`,
      });
    }
  }

  for (const id of [...references].sort()) {
    if (!definitions.has(id)) {
      const site = firstReference.get(id);
      violations.push({
        file: site?.file ?? '?',
        line: site?.line ?? 0,
        detail: `${id} referenced but never defined`,
      });
    }
  }

  return { violations, definitions, references };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir =
    typeof args['dir'] === 'string'
      ? resolve(args['dir'])
      : resolve(REPO_ROOT, 'docs/architecture');

  const files = listFiles(dir)
    .filter((f) => f.endsWith('.md'))
    .map((path) => ({ path: rel(path), text: readFileSync(path, 'utf8') }));

  const { violations, definitions, references } = analyze(files);

  process.exit(
    report(
      'invariant-id-uniqueness (CAR-023)',
      violations,
      `${String(files.length)} document(s), ${String(definitions.size)} invariant definition(s), ${String(references.size)} distinct ID(s) referenced`,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
