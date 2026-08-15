import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SOLVER_STATUSES, TERMINATION_REASONS } from '@schedulepoint/domain';
import { describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';
import { SOLVER_ROOT } from '../support/solver.js';

/**
 * **NAMED PROOF — the worker's structural invariants, as scanners** (OPUS-M4-001;
 * SPEC-04 §1.1, ADR-0006, ADR-0020, FAD-10).
 *
 * Four rules govern every line of the solver package. Each is stated in
 * `solver/README.md`, and each is a rule with a scanner behind it here, because
 * a paragraph is what the next person reaches for a signal handler in spite of.
 *
 * | # | Rule | Source | Why a scanner |
 * |---|---|---|---|
 * | 1 | **no database client anywhere in the worker** | SPEC-04 §1.1, S-15t | the credential's absence is the primary control; a driver arriving first is how a credential arrives second |
 * | 2 | **`socket` in exactly one module** | SPEC-04 §1.1 | an `import requests` for "just telemetry" removes the boundary while every document still says otherwise |
 * | 3 | **no signal-based cancellation** | EV-M0-SPC H-4, FAD-10 | measured: 28 s latency and a MISREPORTED outcome, because Python runs handlers only on the main thread and only in bytecode |
 * | 4 | **`ortools` in at most one adapter module** | ADR-0006 | the engine stays replaceable behind the port; today M4-001 imports it nowhere at all |
 *
 * The fifth case is a **parity** check rather than a rule: the outcome
 * vocabulary exists twice, once per runtime, because the two cannot share a
 * definition. Two copies are safe only while something compares them, and that
 * something is this file — it reads `protocol.py` as text and fails if the sets
 * have drifted.
 *
 * ## Mutation control (FAD-15)
 *
 * Every scanner asserts a non-zero file count before it asserts a zero hit
 * count. A scan over an empty directory reports "no violations" for the most
 * boring possible reason, and that vacuous pass is exactly what these controls
 * exist to make impossible.
 */

/** Every `.py` file in the worker package, as `[relative path, text]`. */
function workerSources(): readonly [string, string][] {
  const packageDir = join(SOLVER_ROOT, 'schedulepoint_solver');
  return readdirSync(packageDir)
    .filter((name) => name.endsWith('.py'))
    .sort()
    .map((name) => [name, readFileSync(join(packageDir, name), 'utf8')] as [string, string]);
}

/** A rough comment/docstring strip, so a RULE is not tripped by DESCRIBING it. */
function code(text: string): string {
  return text
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .replace(/^[ \t]*#.*$/gm, '')
    .replace(/#.*$/gm, '');
}

const SOURCES = workerSources();

describe('the solver worker package', () => {
  it('has sources to scan at all', () => {
    /* The mutation control every case below depends on. */
    expect(SOURCES.length, 'no worker sources were found — every scan below is vacuous').toBeGreaterThan(
      4,
    );
    log(`      · scanning ${String(SOURCES.length)} worker module(s): ${SOURCES.map(([n]) => n).join(', ')}`);
  });

  it('imports NO database client, anywhere (SPEC-04 §1.1, S-15t)', () => {
    const drivers = /\b(psycopg2?|asyncpg|sqlalchemy|sqlite3|pymysql|MySQLdb|pyodbc)\b/;
    const offenders = SOURCES.filter(
      ([name, text]) => name !== 'egress_guard.py' && drivers.test(code(text)),
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
    /* `egress_guard.py` is excepted because it NAMES the drivers in order to
     * refuse them — the list is its detector, not its dependency. */
    expect(readFileSync(join(SOLVER_ROOT, 'schedulepoint_solver/egress_guard.py'), 'utf8')).toContain(
      'FORBIDDEN_MODULES',
    );
  });

  it('imports `socket` OR `_socket` in exactly ONE module — the guard', () => {
    /* `_?socket`, not `socket`. `socket.socket` is a thin Python wrapper over the
     * C accelerator `_socket.socket`, so a module doing `import _socket` opens a
     * connection while a scanner looking only for `import socket` reports a clean
     * package. The independent review demonstrated the bypass; the guard now
     * stubs both constructors and the scanner now sees both imports. */
    const importers = SOURCES.filter(([, text]) =>
      /^\s*(?:import|from)\s+_?socket\b/m.test(code(text)),
    );
    expect(importers.map(([name]) => name)).toEqual(['egress_guard.py']);
  });

  it('installs NO signal handler — cancellation is a watcher thread (H-4, FAD-10)', () => {
    /* The measured finding, not a preference: Python runs signal handlers only on
     * the main thread and only while it is executing bytecode. During a blocking
     * native solve it is doing neither, so delivery waits — 28 s, measured, with
     * the outcome then misreported. A watcher thread is not subject to that, and
     * `StopSearch()` from one was measured at 17 ms. */
    const offenders = SOURCES.filter(([, text]) => /\bsignal\s*\.\s*signal\s*\(/.test(code(text)));
    expect(offenders.map(([name]) => name)).toEqual([]);

    /* And the positive half: the watcher thread genuinely exists, so this is not
     * "no signals because no cancellation". */
    const cancellation = SOURCES.find(([name]) => name === 'cancellation.py');
    expect(cancellation).toBeDefined();
    expect(code(cancellation?.[1] ?? '')).toContain('threading.Thread');
    log('      · no signal handler; the watcher thread is present');
  });

  it('imports `ortools` in at most one adapter module (ADR-0006)', () => {
    const importers = SOURCES.filter(([, text]) => /^\s*(from|import)\s+ortools\b/m.test(code(text)));
    /* **The allowance is now SPENT, once** — OPUS-M4-002, the packet's
     * "deliberate first spend". M4-001 asserted `[]` while the budget was
     * unspent, which was the right pin for a milestone that shipped a stub; the
     * assertion CLASS this test is named for has always been "at most ONE
     * adapter module", and that is what is asserted now.
     *
     * Pinned to the exact filename rather than to a count, and that is the
     * load-bearing part: a count of one would still pass if a SECOND module
     * imported ortools and the adapter stopped. `runtime.py` still reads the
     * library version from package METADATA rather than importing it, precisely
     * so the adapter stays the only importer — the reason that mattered at
     * M4-001 is the reason it matters now. */
    expect(importers.map(([name]) => name)).toEqual(['cpsat_adapter.py']);
    log(`      · ortools importers: ${String(importers.length)} — the allowance is spent, once`);
  });

  it('the stub solver never claims OPTIMAL or INFEASIBLE', () => {
    /* A greedy fill has no proof of either. SPEC-04 §7 forbids an optimality
     * claim for a feasible result, and a failure to fill greedily is not a proof
     * that nothing fills it — so the stub returns FEASIBLE or UNKNOWN and says
     * nothing it cannot support. Starting to violate that in the stub and fixing
     * it later is how the violation ships. */
    const stub = SOURCES.find(([name]) => name === 'stub_solver.py');
    expect(stub).toBeDefined();
    const body = code(stub?.[1] ?? '');
    expect(body).not.toContain('STATUS_OPTIMAL');
    expect(body).not.toContain('STATUS_INFEASIBLE');
    expect(body).toContain('STATUS_FEASIBLE');
    expect(body).toContain('STATUS_UNKNOWN');
  });
});

describe('the outcome vocabulary is the same in both runtimes', () => {
  const protocol = readFileSync(join(SOLVER_ROOT, 'schedulepoint_solver/protocol.py'), 'utf8');

  /** Pull a `NAME: Tuple[str, ...] = ( ... )` literal out of the Python source. */
  function pythonTuple(name: string): readonly string[] {
    const match = new RegExp(`${name}[^=]*=\\s*\\(([\\s\\S]*?)\\)`, 'm').exec(protocol);
    expect(match, `${name} was not found in protocol.py`).not.toBeNull();
    const constants = (match?.[1] ?? '')
      .split(',')
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '');
    /* The tuple names CONSTANTS, so each one is resolved to its literal. A
     * comparison against the constant NAMES would pass while the values drifted,
     * which is the failure this is here to catch. */
    return constants.map((constant) => {
      const literal = new RegExp(`^${constant}\\s*=\\s*"([^"]+)"`, 'm').exec(protocol);
      expect(literal, `${constant} has no literal in protocol.py`).not.toBeNull();
      return literal?.[1] ?? '';
    });
  }

  it('the solver statuses match, value for value', () => {
    expect([...pythonTuple('SOLVER_STATUSES')].sort()).toEqual([...SOLVER_STATUSES].sort());
    log(`      · ${String(SOLVER_STATUSES.length)} statuses agree across TypeScript and Python`);
  });

  it('the termination reasons match, value for value', () => {
    expect([...pythonTuple('TERMINATION_REASONS')].sort()).toEqual([...TERMINATION_REASONS].sort());
  });

  it('MUTATION CONTROL: the comparison can FAIL', () => {
    /* Both cases above would pass against a parser that returned the TypeScript
     * list. The control asserts the Python source is genuinely the source of the
     * comparison by checking a value that exists only there. */
    expect(pythonTuple('SOLVER_STATUSES')).toContain('MODEL_INVALID');
    expect(protocol).toContain('STATUS_MODEL_INVALID = "MODEL_INVALID"');
    expect([...pythonTuple('SOLVER_STATUSES')].sort()).not.toEqual(
      [...SOLVER_STATUSES, 'NOT_A_REAL_STATUS'].sort(),
    );
  });
});
