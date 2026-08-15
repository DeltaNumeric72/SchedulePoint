import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT, lineOf, lineStarts, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Solver/checker HARD-kind parity (OPUS-M4-002, FAD-42 R-7; doc 35 §6d required
 * behaviour 2).
 *
 * §6d requires that the set of HARD kinds the **model** builds and the set the
 * **independent checker** evaluates stay identical, and that a divergence be a
 * "compile-time/CI error, not a runtime surprise". Nothing enforced that clause:
 * the two lists live in different languages, in different packages, and agreed
 * only because one person wrote both on the same afternoon.
 *
 * The failure this prevents is quiet and asymmetric, which is what makes it
 * worth a gate rather than a convention:
 *
 *  - a kind in **Python but not TypeScript** — the model constrains something the
 *    checker cannot see, so the checker's silence stops meaning agreement and
 *    the redundancy SPEC-04 §3.3 relies on is gone for that kind;
 *  - a kind in **TypeScript but not Python** — the checker enforces something the
 *    model never posted, so every candidate carrying that rule is refused after
 *    the solve and the engine reports "worker output rejected" where the honest
 *    answer is INFEASIBLE. **This is exactly the shape of the R-1 defect**, and a
 *    kind-level version of it would look identical from the outside.
 *
 * ## Static, on purpose
 *
 * It parses both sources as text. No Python interpreter, no import of the domain
 * package, no build step — so it runs in the same second on a machine with no
 * OR-Tools and no venv, which is the only way a CI clause of this kind is
 * actually kept. The two declarations are plain literal lists in both languages,
 * so text is a faithful reading rather than a guess.
 *
 * Read-only. It parses source and writes nothing.
 */

/** @typedef {{ file: string, line: number, detail: string }} Violation */

const PYTHON_FILE = 'solver/schedulepoint_solver/model.py';
const TS_FILE = 'packages/domain/src/rules/hard-rule-check.ts';

const PYTHON_BLOCK = /^HARD_KINDS = \(([\s\S]*?)^\)/m;
const PYTHON_LITERAL = /"([A-Za-z][A-Za-z0-9]*)"/g;
const TS_BLOCK = /export const EVALUATED_HARD_RULE_KINDS = \[([\s\S]*?)\]\s*as const/;
const TS_LITERAL = /'([A-Za-z][A-Za-z0-9]*)'/g;

/**
 * The kind names inside a declaration block, with the line each is on.
 *
 * Comments are stripped first. Both declarations carry prose that names kinds —
 * the TypeScript list annotates entries with their ruling, and a `RK-RULING-09`
 * comment mentioning a kind must not be read as declaring it.
 *
 * @param {string} text
 * @param {RegExp} block
 * @param {RegExp} inner
 * @param {'py' | 'ts'} language
 * @returns {{ kinds: Map<string, number>, blockFound: boolean }}
 */
function extractKinds(text, block, inner, language) {
  const starts = lineStarts(text);
  const match = block.exec(text);
  if (match === null) return { kinds: new Map(), blockFound: false };
  const body = match[1] ?? '';
  const bodyOffset = match.index + match[0].indexOf(body);

  // Blank the comments rather than delete them, so every offset below still
  // points at the line it came from.
  const blanked =
    language === 'py'
      ? body.replace(/#[^\n]*/g, (run) => ' '.repeat(run.length))
      : body
          .replace(/\/\*[\s\S]*?\*\//g, (run) => run.replace(/[^\n]/g, ' '))
          .replace(/\/\/[^\n]*/g, (run) => ' '.repeat(run.length));

  /** @type {Map<string, number>} */
  const kinds = new Map();
  for (const found of blanked.matchAll(inner)) {
    const kind = found[1];
    if (kind === undefined) continue;
    const at = bodyOffset + (found.index ?? 0);
    if (!kinds.has(kind)) kinds.set(kind, lineOf(starts, at));
  }
  return { kinds, blockFound: true };
}

export function analyze() {
  const pythonText = readFileSync(resolve(REPO_ROOT, PYTHON_FILE), 'utf8');
  const tsText = readFileSync(resolve(REPO_ROOT, TS_FILE), 'utf8');

  const model = extractKinds(pythonText, PYTHON_BLOCK, PYTHON_LITERAL, 'py');
  const checker = extractKinds(tsText, TS_BLOCK, TS_LITERAL, 'ts');

  /** @type {Violation[]} */
  const violations = [];

  /* A missing block is a violation in itself. Without this the gate would find
   * two empty sets, call them equal, and pass — the vacuity failure mode, which
   * is the one a parity gate is most prone to. */
  if (!model.blockFound) {
    violations.push({
      file: PYTHON_FILE,
      line: 1,
      detail: 'HARD_KINDS tuple not found — the gate cannot verify parity.',
    });
  }
  if (!checker.blockFound) {
    violations.push({
      file: TS_FILE,
      line: 1,
      detail: 'EVALUATED_HARD_RULE_KINDS declaration not found — the gate cannot verify parity.',
    });
  }
  if (model.blockFound && model.kinds.size === 0) {
    violations.push({ file: PYTHON_FILE, line: 1, detail: 'HARD_KINDS is empty.' });
  }
  if (checker.blockFound && checker.kinds.size === 0) {
    violations.push({ file: TS_FILE, line: 1, detail: 'EVALUATED_HARD_RULE_KINDS is empty.' });
  }

  for (const [kind, line] of model.kinds) {
    if (!checker.kinds.has(kind)) {
      violations.push({
        file: PYTHON_FILE,
        line,
        detail:
          `the model builds HARD kind '${kind}', which the independent checker does not ` +
          'evaluate — the checker\'s silence would stop meaning agreement (SPEC-04 §3.3).',
      });
    }
  }
  for (const [kind, line] of checker.kinds) {
    if (!model.kinds.has(kind)) {
      violations.push({
        file: TS_FILE,
        line,
        detail:
          `the checker evaluates HARD kind '${kind}', which the model does not build — every ` +
          'candidate carrying such a rule is refused after the solve, and the engine reports ' +
          'a rejected output where the honest answer is INFEASIBLE (the FAD-42 R-1 shape).',
      });
    }
  }

  return { violations, modelCount: model.kinds.size, checkerCount: checker.kinds.size };
}

function main() {
  parseArgs(process.argv.slice(2));
  const { violations, modelCount, checkerCount } = analyze();
  const summary =
    `${String(modelCount)} HARD kind(s) in ${rel(resolve(REPO_ROOT, PYTHON_FILE))}, ` +
    `${String(checkerCount)} in ${rel(resolve(REPO_ROOT, TS_FILE))}`;
  process.exit(report('solver/checker HARD-kind parity (§6d)', violations, summary));
}

main();
