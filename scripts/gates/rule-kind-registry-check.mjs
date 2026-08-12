import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Rule-kind registry generation gate — OPUS-M4-000C, doc 34 §4-D.
 *
 * The registry of "which HARD rule kinds this system evaluates, why not the
 * rest, what each one needs, who owns it" used to be prose with the counts typed
 * into the headings (`docs/evidence/EV-M3-INTEGRATION/step-06-node-kinds.md`).
 * Three of those counts were wrong, and before them one of the *reasons* was
 * wrong — `CallSpacing` asserted that a column did not exist a milestone after it
 * shipped. A ruling document whose arithmetic nobody checks is a way to get a
 * decision made about the wrong thing.
 *
 * So the registry is **generated** from
 * `packages/domain/src/rules/registry.ts` (plus `ast.ts` and
 * `hard-rule-check.ts`, which it composes), and this gate proves the committed
 * artifact is byte-identical to what the code produces right now.
 *
 * Two modes:
 *
 *     node scripts/gates/rule-kind-registry-check.mjs           # check (CI)
 *     node scripts/gates/rule-kind-registry-check.mjs --write   # regenerate
 *
 * ## Why it reads the built domain rather than the source
 *
 * The same reason `solver/corpus/build-corpus.mjs` does: the artifact must be
 * produced by the code that actually ships, not by a second implementation
 * living in a script. `pnpm gate:rule-kind-registry` builds `packages/domain`
 * first, so a standalone run (and the red case's standalone run) compiles what
 * it is about to render.
 *
 * ## The red case
 *
 * Hand-edit one number in the committed registry. The gate must fail and must
 * say which line drifted — because "the registry is generated" is a claim about
 * a gate, and a gate that has only been seen passing is not evidence.
 */

const ARTIFACT = 'packages/domain/src/rules/rule-kind-registry.generated.md';
const DOMAIN_ENTRY = '../../packages/domain/dist/src/rules/index.js';

/** @param {string} a @param {string} b */
function firstDifferingLine(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  const limit = Math.max(left.length, right.length);
  for (let i = 0; i < limit; i += 1) {
    if (left[i] !== right[i]) {
      return {
        line: i + 1,
        committed: left[i] ?? '(missing — the committed file is shorter)',
        generated: right[i] ?? '(missing — the generated file is shorter)',
      };
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = resolve(REPO_ROOT, ARTIFACT);

  /** @type {{ buildRuleKindRegistry: () => unknown, renderRuleKindRegistry: (r: unknown) => string }} */
  let domain;
  try {
    domain = await import(new URL(DOMAIN_ENTRY, import.meta.url).href);
  } catch (error) {
    process.stdout.write(
      `FAIL  rule-kind registry — the built domain package could not be loaded.\n` +
        `      Run \`tsc -b packages/domain\` first. ${String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  const registry = domain.buildRuleKindRegistry();
  const generated = domain.renderRuleKindRegistry(registry);

  if (args['write'] === true) {
    writeFileSync(artifactPath, generated, 'utf8');
    process.stdout.write(`WROTE ${rel(artifactPath)}\n`);
    process.exit(0);
    return;
  }

  /** @type {string | null} */
  let committed = null;
  try {
    committed = readFileSync(artifactPath, 'utf8');
  } catch {
    committed = null;
  }

  /** @type {{ file: string, line: number, detail: string }[]} */
  const violations = [];

  if (committed === null) {
    violations.push({
      file: ARTIFACT,
      line: 1,
      detail: 'the committed registry does not exist. Regenerate it with --write.',
    });
  } else if (committed !== generated) {
    const drift = firstDifferingLine(committed, generated);
    violations.push({
      file: ARTIFACT,
      line: drift?.line ?? 1,
      detail:
        'the committed registry is not what the code generates. ' +
        `committed: ${JSON.stringify(drift?.committed ?? '')} ` +
        `generated: ${JSON.stringify(drift?.generated ?? '')}. ` +
        'The registry is generated, never hand-edited — change the code, then --write.',
    });
  }

  /* Structural assertions the artifact comparison cannot make on its own: a
   * hand-edit that happened to be regenerated would pass the byte comparison
   * while the underlying sets were contradictory. These are the same three
   * properties `hard-rule-check.test.ts` asserts, restated at the gate so the
   * BUILD fails on them and not only the suite. */
  const counts = registry.counts;
  if (counts.evaluated + counts.notEvaluable !== counts.uniqueKinds) {
    violations.push({
      file: ARTIFACT,
      line: 1,
      detail:
        `evaluated (${String(counts.evaluated)}) + not-evaluable (${String(counts.notEvaluable)}) ` +
        `!= unique kinds (${String(counts.uniqueKinds)}) — the two sets are not a partition.`,
    });
  }
  const classTotal = counts.byNotEvaluableClass.reduce(
    (/** @type {number} */ sum, /** @type {{ count: number }} */ row) => sum + row.count,
    0,
  );
  if (classTotal !== counts.notEvaluable) {
    violations.push({
      file: ARTIFACT,
      line: 1,
      detail:
        `the not-evaluable classes sum to ${String(classTotal)}, but ${String(counts.notEvaluable)} ` +
        'kinds are not evaluable — a kind is uncounted or double-counted.',
    });
  }
  const familyTotal = counts.byFamily.reduce(
    (/** @type {number} */ sum, /** @type {{ count: number }} */ row) => sum + row.count,
    0,
  );
  if (familyTotal !== counts.uniqueKinds) {
    violations.push({
      file: ARTIFACT,
      line: 1,
      detail:
        `the families sum to ${String(familyTotal)}, but there are ${String(counts.uniqueKinds)} ` +
        'kinds — a kind belongs to no family or to two.',
    });
  }

  const summary =
    `${String(counts.uniqueKinds)} unique kind(s), ${String(counts.evaluated)} evaluated / ` +
    `${String(counts.notEvaluable)} not-evaluable, ${String(counts.oneRulingAway)} one ruling away, ` +
    `artifact ${rel(artifactPath)}`;
  process.exit(report('rule-kind registry is generated (doc 34 §4-D)', violations, summary));
}

await main();
