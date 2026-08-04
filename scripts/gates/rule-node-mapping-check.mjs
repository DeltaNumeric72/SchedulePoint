import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT, lineOf, lineStarts, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Rule-node → compiler-mapping closure check (OPUS-M3-002, SPEC-04 §3.2).
 *
 * This gate exists because SPEC-04 §3.2 requires that **"a node with no compiler
 * mapping is a build-time error in CI, not a runtime surprise"** — an unmapped
 * rule node must never be "silently dropped and never silently softened". The
 * TypeScript exhaustiveness check on `compileNode`'s switch is the first layer;
 * this gate is the independent second layer, with a red case proving it fires.
 *
 * It compares two sources of truth in `@schedulepoint/domain`:
 *
 *  - the **declared closed set** — the string literals of `RULE_NODE_KINDS` in
 *    `packages/domain/src/rules/ast.ts`; and
 *  - the **compiler's actual coverage** — the `case '<Kind>':` labels between the
 *    `rule-node-mapping:begin`/`:end` sentinels inside `compileNode`'s switch in
 *    `packages/domain/src/rules/compile.ts`.
 *
 * Two failures are reported, so the gate cannot pass vacuously:
 *
 *  - **unmapped node** — a kind declared in the AST that the compiler does not
 *    handle (the SPEC-04 §3.2 case: it would compile to nothing);
 *  - **orphan mapping** — a compiler case for a kind the AST does not declare
 *    (a rename-and-forget, or a mapping left behind after a node was removed).
 *
 * Read-only. It parses source and writes nothing.
 */

/** @typedef {{ file: string, line: number, detail: string }} Violation */

const AST_FILE = 'packages/domain/src/rules/ast.ts';
const COMPILE_FILE = 'packages/domain/src/rules/compile.ts';

const KINDS_BLOCK = /export const RULE_NODE_KINDS = \[([\s\S]*?)\]\s*as const/;
const STRING_LITERAL = /'([A-Za-z][A-Za-z0-9]*)'/g;
const SENTINEL_BLOCK = /rule-node-mapping:begin([\s\S]*?)rule-node-mapping:end/;
const CASE_LABEL = /case\s+'([A-Za-z][A-Za-z0-9]*)':/g;

/**
 * @param {string} text
 * @param {RegExp} block
 * @param {RegExp} inner
 * @returns {{ kinds: Map<string, number>, blockFound: boolean }}
 */
function extractKinds(text, block, inner) {
  const starts = lineStarts(text);
  const match = block.exec(text);
  if (match === null) return { kinds: new Map(), blockFound: false };
  const body = match[1] ?? '';
  const bodyOffset = match.index + match[0].indexOf(body);
  /** @type {Map<string, number>} */
  const kinds = new Map();
  for (const found of body.matchAll(inner)) {
    const kind = found[1];
    if (kind === undefined) continue;
    const at = bodyOffset + (found.index ?? 0);
    if (!kinds.has(kind)) kinds.set(kind, lineOf(starts, at));
  }
  return { kinds, blockFound: true };
}

export function analyze() {
  const astPath = resolve(REPO_ROOT, AST_FILE);
  const compilePath = resolve(REPO_ROOT, COMPILE_FILE);
  const astText = readFileSync(astPath, 'utf8');
  const compileText = readFileSync(compilePath, 'utf8');

  const declared = extractKinds(astText, KINDS_BLOCK, STRING_LITERAL);
  const mapped = extractKinds(compileText, SENTINEL_BLOCK, CASE_LABEL);

  /** @type {Violation[]} */
  const violations = [];

  if (!declared.blockFound) {
    violations.push({
      file: AST_FILE,
      line: 1,
      detail: 'RULE_NODE_KINDS declaration not found — the gate cannot verify closure.',
    });
  }
  if (!mapped.blockFound) {
    violations.push({
      file: COMPILE_FILE,
      line: 1,
      detail:
        'rule-node-mapping sentinels not found in compileNode — the gate cannot verify closure.',
    });
  }

  for (const [kind, line] of declared.kinds) {
    if (!mapped.kinds.has(kind)) {
      violations.push({
        file: AST_FILE,
        line,
        detail: `AST node '${kind}' has no compiler mapping (SPEC-04 §3.2: an unmapped node fails the build).`,
      });
    }
  }
  for (const [kind, line] of mapped.kinds) {
    if (!declared.kinds.has(kind)) {
      violations.push({
        file: COMPILE_FILE,
        line,
        detail: `compiler maps '${kind}', which is not a declared AST node (orphan mapping).`,
      });
    }
  }

  return { violations, declaredCount: declared.kinds.size, mappedCount: mapped.kinds.size };
}

function main() {
  parseArgs(process.argv.slice(2));
  const { violations, declaredCount, mappedCount } = analyze();
  const summary = `${String(declaredCount)} declared node(s) in ${rel(resolve(REPO_ROOT, AST_FILE))}, ${String(mappedCount)} compiler mapping(s) in ${rel(resolve(REPO_ROOT, COMPILE_FILE))}`;
  process.exit(report('rule-node → compiler-mapping closure', violations, summary));
}

main();
