import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';
import PgPkg from 'pg';
import type pg from 'pg';

const { Client: PgClient } = PgPkg;
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../src/audit/verification.js';
import { buildServer } from '../../src/http/server.js';
import type { RouteTableEntry } from '../../src/http/route-table.js';
import { adminClient } from '../support/admin-client.js';
import { createPool } from '../../src/db/pool.js';
import { API_ROOT } from '../support/env.js';
import { log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import {
  ProbeFalsified,
  contractProblems,
  isRunFailing,
  runScenario,
  type SbxResult,
} from './contract.js';
import {
  assertNoCascade,
  buildScenarios,
  createRuntimes,
  type ScenarioDependencies,
} from './scenarios.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The SBX evidence harness — OPUS-M2-001 deliverable B.
 *
 * It runs inside the api test project deliberately, rather than as a standalone
 * script with its own cluster: the scenarios need the real migrations, the real
 * roles, the real fixture and the real server, and every one of those already
 * exists here exactly once. A second copy of that machinery would be a second
 * thing to keep true.
 *
 * `scripts/sbx/run-sbx.mjs` is the harness's command-line entry point; it drives
 * this file and writes the evidence bundle.
 *
 * **G-ARCH is NOT closed by this run.** It also needs SBX-011, 013, 014b, 022,
 * 023 and 028 at later milestones. This clears the tenancy subset and files its
 * evidence.
 * ──────────────────────────────────────────────────────────────────────────── */

const multi = ownedMulti('sbx-harness', { profile: 'full' });

let admin: pg.Client;
let app: FastifyInstance;
let routeTable: readonly RouteTableEntry[];
let runtimes: Map<string, Runtime>;
let http: HttpHarness;
let results: SbxResult[] = [];
let chainVerification: string[] = [];
/**
 * R-05: the chain verification used to be written by one `it` and read by
 * another, so under seeds 1 and 8675309 the evidence bundle was written with the
 * section silently absent. Same class as 74058b1 — memoised, so whichever test
 * needs it establishes it.
 */
let chainRun: Promise<string[]> | undefined;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  ({ app, routeTable } = await buildServer());
  http = await buildHttpHarness();
  runtimes = createRuntimes();
}, 120_000);

afterAll(async () => {
  for (const runtime of runtimes.values()) await runtime.destroy();
  await http.close();
  await app.close();
  await admin.end();
});

/** A raw `app_migrator` client — the table OWNER, which is what FORCE RLS binds. */
function adminMigratorClient(): pg.Client {
  const pool = createPool('app_migrator', { max: 1, allowExitOnIdle: true });
  const options = (pool as unknown as { options: Record<string, unknown> }).options;
  return new PgClient({
    host: options['host'] as string,
    port: options['port'] as number,
    database: options['database'] as string,
    user: options['user'] as string,
    password: options['password'] as string,
  });
}

function dependencies(): ScenarioDependencies {
  return {
    fixture: multi(),
    admin,
    runtimes: runtimes as ScenarioDependencies['runtimes'],
    routeTable,
    http,
  };
}

describe('SPEC-16 §1 — the contract validator', () => {
  it('every declared scenario carries all nine fields and a falsifiability probe', () => {
    for (const scenario of buildScenarios(dependencies)) {
      expect(contractProblems(scenario), `${scenario.id}: ${contractProblems(scenario).join('; ')}`).toEqual(
        [],
      );
    }
    log(`${String(buildScenarios(dependencies).length)} scenario(s), every contract complete`);
  });

  it('RED: a scenario missing a field is NOT RUNNABLE, and the validator says which', async () => {
    const [first] = buildScenarios(dependencies);
    if (first === undefined) throw new Error('no scenarios');
    const crippled = {
      ...first,
      id: 'SBX-RED-CONTRACT',
      contract: { ...first.contract, objectiveOracle: '   ' },
    };
    expect(contractProblems(crippled).join(' ')).toContain('objectiveOracle');
    const result = await runScenario(crippled);
    expect(result.state, 'a scenario with a blank field still ran').toBe('NOT_RUNNABLE');
    log('a blank contract field makes a scenario NOT_RUNNABLE, naming the field');
  });

  it('RED: a scenario whose probe cannot fail is reported VACUOUS, not PASS', async () => {
    const vacuous = {
      id: 'SBX-RED-VACUOUS',
      title: 'a deliberately vacuous scenario',
      contract: {
        owner: 'red case',
        fixtureProvenance: 'none',
        deterministicSetup: 'none',
        externalDependency: 'none',
        faultControls: 'none',
        objectiveOracle: 'an assertion that cannot fail',
        retainedArtifact: 'none',
        environment: 'MULTI',
        earliestExecutionPoint: 'E0' as const,
      },
      run: () => Promise.resolve(),
      // The probe returns instead of throwing — i.e. the scenario could not be
      // made to fail. That is the definition of vacuous.
      probe: () => Promise.resolve(),
    };
    const result = await runScenario(vacuous);
    expect(result.state, 'a scenario that cannot fail was reported as passing').toBe('VACUOUS');
    expect(isRunFailing([result]), 'a vacuous scenario did not fail the run').toBe(true);
    log('the vacuity detector catches a scenario whose probe cannot fail');
  });

  it('RED: EVIDENCE_BLOCKED is never a pass and never a silent skip', async () => {
    const blocked = {
      id: 'SBX-RED-BLOCKED',
      title: 'a fully blocked scenario',
      contract: {
        owner: 'red case',
        fixtureProvenance: 'none',
        deterministicSetup: 'none',
        externalDependency: 'a dependency that does not exist',
        faultControls: 'none',
        objectiveOracle: 'unreachable until the dependency exists',
        retainedArtifact: 'none',
        environment: 'MULTI',
        earliestExecutionPoint: 'E2' as const,
      },
      blocked: [{ subScenario: 'everything', dependency: 'authn milestone' }],
      run: () => Promise.resolve(),
    };
    const result = await runScenario(blocked);
    expect(result.state).toBe('EVIDENCE_BLOCKED');
    expect(result.state).not.toBe('PASS');
    expect(result.blocked[0]?.dependency, 'the dependency was absorbed rather than named').toBe(
      'authn milestone',
    );
    log('a fully blocked scenario reports EVIDENCE_BLOCKED with its dependency named');
  });

  it('RED: a reading refused with anything but 42501 is a HARNESS DEFECT', async () => {
    // E-02, the reviewer's 08006 injection. The guard blacklisted 25P02 alone,
    // so an injected connection failure passed straight through and three
    // readings became `wrong: 0` carrying a false grant-cause in the artifact.
    // It is a whitelist now: 42501 is the only refusal that means "the system
    // said no"; everything else means "the read did not happen".
    const clean = [
      { role: 'app_runtime' as const, context: 'c', table: 'memberships', wrong: 0, visible: 4 },
      {
        role: 'app_readonly_support' as const,
        context: 'c',
        table: 'capability_grants',
        wrong: 0,
        visible: 0,
        refused: '42501',
      },
    ];
    expect(() => assertNoCascade(clean), 'a genuine 42501 refusal was rejected').not.toThrow();

    for (const injected of ['08006', '25P02', '57P01']) {
      expect(
        () => assertNoCascade([...clean, { ...clean[1]!, table: 'groups', refused: injected }]),
        `SQLSTATE ${injected} was accepted as a genuine refusal`,
      ).toThrow(/HARNESS DEFECT/);
    }
    log('only 42501 counts as a refusal; 08006, 25P02 and 57P01 are harness defects');
  });

  it('RED: a probe that throws a TypeError is PROBE_ERROR, not FALSIFIABLE', async () => {
    // The reviewer's M-1 shape. A misspelled property threw a TypeError, the old
    // detector recorded FALSIFIABLE, and a broken probe became a green evidence
    // control.
    const base = {
      id: 'SBX-RED-PROBE-TYPEERROR',
      title: 'a probe that crashes instead of falsifying',
      contract: {
        owner: 'red case',
        fixtureProvenance: 'none',
        deterministicSetup: 'none',
        externalDependency: 'none',
        faultControls: 'none',
        objectiveOracle: 'irrelevant — the probe never reaches it',
        retainedArtifact: 'docs/evidence/EV-M2-SBX/scenario-report.txt',
        environment: 'MULTI',
        earliestExecutionPoint: 'E0' as const,
      },
      run: () => Promise.resolve(),
    };

    // GREEN control: the SAME scenario with a probe that properly falsifies.
    const good = await runScenario({
      ...base,
      probe: () => Promise.reject(new ProbeFalsified('the oracle rejected, as observed')),
    });
    expect(good.state).toBe('PASS');
    expect(good.probeOutcome).toBe('FALSIFIABLE');

    // RED: a TypeError.
    const crashed = await runScenario({
      ...base,
      probe: () => {
        const nothing = undefined as unknown as { missing: { deeper: string } };
        return Promise.resolve(nothing.missing.deeper).then(() => undefined);
      },
    });
    expect(crashed.probeOutcome, 'a TypeError was laundered into FALSIFIABLE').toBe('PROBE_ERROR');
    expect(crashed.state).toBe('PROBE_ERROR');
    expect(isRunFailing([crashed]), 'a crashed probe did not fail the run').toBe(true);
    log('a probe throwing TypeError is PROBE_ERROR and fails the run');
  });

  it('RED: a probe repointed at an ABSENT subject is never FALSIFIABLE', async () => {
    // The reviewer's mutation (b), pinned. An absence-based probe ("count === 0,
    // therefore falsified") is satisfied by a MISSING subject just as well as by
    // a working control — so repointing it at a nonexistent organization used to
    // yield PASS/FALSIFIABLE and exit 0.
    const contract = {
      owner: 'red case',
      fixtureProvenance: 'none',
      deterministicSetup: 'none',
      externalDependency: 'none',
      faultControls: 'none',
      objectiveOracle: 'a subject that must exist and must be perturbable',
      retainedArtifact: 'docs/evidence/EV-M2-SBX/scenario-report.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E0' as const,
    };

    // GREEN control: pointed at a REAL subject, the perturb-and-re-check shape
    // observes the oracle reject and is FALSIFIABLE.
    const present = await runScenario({
      id: 'SBX-RED-ABSENT-CONTROL',
      title: 'perturb-and-re-check against a real subject',
      contract,
      run: () => Promise.resolve(),
      probe: async () => {
        const { rows } = await admin.query<{ n: string }>(
          'select count(*)::text as n from memberships where organization_id = $1::uuid',
          [multi().alpha.organizationId],
        );
        const subjects = Number(rows[0]?.n ?? '0');
        if (subjects === 0) return; // no subject => VACUOUS, honestly
        throw new ProbeFalsified(`${String(subjects)} real subject(s) observed`);
      },
    });
    expect(present.probeOutcome, 'the control did not falsify against a real subject').toBe(
      'FALSIFIABLE',
    );

    // RED: the SAME probe repointed at an organization that does not exist. The
    // subject is absent, so nothing is falsified and it must NOT be FALSIFIABLE.
    const absent = await runScenario({
      id: 'SBX-RED-ABSENT-SUBJECT',
      title: 'the same probe, repointed at a nonexistent organization',
      contract,
      run: () => Promise.resolve(),
      probe: async () => {
        const { rows } = await admin.query<{ n: string }>(
          'select count(*)::text as n from memberships where organization_id = $1::uuid',
          ['00000000-0000-4000-8000-0000000000aa'],
        );
        const subjects = Number(rows[0]?.n ?? '0');
        if (subjects === 0) return;
        throw new ProbeFalsified(`${String(subjects)} subject(s) observed`);
      },
    });
    expect(
      absent.probeOutcome,
      'a probe whose subject does not exist was recorded as FALSIFIABLE',
    ).not.toBe('FALSIFIABLE');
    expect(['VACUOUS', 'PROBE_ERROR']).toContain(absent.probeOutcome);
    expect(isRunFailing([absent]), 'an absent-subject probe did not fail the run').toBe(true);
    log('a probe repointed at an absent subject is VACUOUS, never FALSIFIABLE');
  });

  it('RED: a probe that throws a SQL error is PROBE_ERROR, not FALSIFIABLE', async () => {
    // The reviewer's M-2 shape: a syntax error in the probe's own SQL. It throws,
    // and under the old detector that was indistinguishable from proof.
    const result = await runScenario({
      id: 'SBX-RED-PROBE-SQL',
      title: 'a probe whose own SQL is broken',
      contract: {
        owner: 'red case',
        fixtureProvenance: 'none',
        deterministicSetup: 'none',
        externalDependency: 'none',
        faultControls: 'none',
        objectiveOracle: 'irrelevant — the probe never reaches it',
        retainedArtifact: 'docs/evidence/EV-M2-SBX/scenario-report.txt',
        environment: 'MULTI',
        earliestExecutionPoint: 'E0' as const,
      },
      run: () => Promise.resolve(),
      probe: async () => {
        await admin.query('select this is not valid sql from nowhere');
      },
    });
    expect(result.probeOutcome, 'a SQL error was laundered into FALSIFIABLE').toBe('PROBE_ERROR');
    expect(result.failure ?? '').toContain('ERRORED instead of falsifying');
    expect(isRunFailing([result])).toBe(true);
    log('a probe throwing a SQL error is PROBE_ERROR and fails the run');
  });

  it('RED: EVIDENCE_BLOCKED on a GATE-REQUIRED scenario makes the run exit non-zero', async () => {
    // The other half of the blocked rule, and the sharper half. A scenario no
    // gate claims may rest at EVIDENCE_BLOCKED — SBX-006 does. A scenario a GATE
    // requires may not: a gate whose evidence cannot be produced is a gate that
    // has not been met, and reporting the run green would be exactly the
    // "absorbed dependency" SPEC-16 §6 forbids.
    const base = {
      id: 'SBX-RED-GATE-BLOCKED',
      title: 'a gate-required scenario that cannot produce its evidence',
      contract: {
        owner: 'red case',
        fixtureProvenance: 'none',
        deterministicSetup: 'none',
        externalDependency: 'a dependency that does not exist',
        faultControls: 'none',
        objectiveOracle: 'unreachable until the dependency exists',
        retainedArtifact: 'none',
        environment: 'MULTI',
        earliestExecutionPoint: 'E0' as const,
      },
      blocked: [{ subScenario: 'everything', dependency: 'a named but absent dependency' }],
      run: () => Promise.resolve(),
    };

    // GREEN first: the SAME blocked scenario, with no gate depending on it, is a
    // tolerated resting state. Without this the assertion below would also pass
    // if `isRunFailing` simply failed on every blocked scenario.
    const optional = await runScenario({ ...base, gateRequired: false });
    expect(optional.state).toBe('EVIDENCE_BLOCKED');
    expect(isRunFailing([optional]), 'a blocked scenario NO gate needs failed the run').toBe(false);

    // RED: the same scenario, now gate-required.
    const required = await runScenario({ ...base, gateRequired: true });
    expect(required.state).toBe('EVIDENCE_BLOCKED');
    expect(
      isRunFailing([required]),
      'a GATE-REQUIRED scenario came back blocked and the run still passed',
    ).toBe(true);
    log(
      'EVIDENCE_BLOCKED is tolerated when no gate claims it and FAILS the run when one does — ' +
        'the same scenario, both ways',
    );
  });

  it('RED: a blocked scenario with an UNNAMED dependency is NOT RUNNABLE', async () => {
    const unnamed = {
      id: 'SBX-RED-UNNAMED',
      title: 'blocked on nothing in particular',
      contract: {
        owner: 'red case',
        fixtureProvenance: 'none',
        deterministicSetup: 'none',
        externalDependency: 'none',
        faultControls: 'none',
        objectiveOracle: 'none',
        retainedArtifact: 'none',
        environment: 'MULTI',
        earliestExecutionPoint: 'E2' as const,
      },
      blocked: [{ subScenario: 'everything', dependency: '  ' }],
      run: () => Promise.resolve(),
    };
    expect(contractProblems(unnamed).join(' ')).toContain('UNNAMED');
    expect((await runScenario(unnamed)).state).toBe('NOT_RUNNABLE');
    log('SPEC-16 §6: a dependency must be named, not absorbed');
  });
});

describe('red case — SBX-004 fails when an RLS control is removed', () => {
  it('RED: with FORCE RLS off inside a rolled-back transaction, the sweep sees foreign rows', async () => {
    // The packet's red case 1. It has to be done without ever leaving the cluster
    // with RLS weakened, so:
    //
    //  - the probe runs on the SAME connection as the DDL, inside ONE transaction.
    //    PostgreSQL DDL is transactional, so the ROLLBACK undoes it completely;
    //    a variant that turned FORCE off, probed from another connection and put
    //    it back would leave a window in which RLS was off for everybody.
    //  - the role is `app_migrator`, the table OWNER. FORCE RLS is precisely what
    //    binds the owner (A-04), so removing it is the smallest possible
    //    weakening that the sweep must notice — and it is never granted to a
    //    runtime role.
    //
    // Non-bypass rule 3 says never disable RLS, including temporarily, including
    // in a test that then ships. This does not disable RLS: it removes FORCE for
    // the owner, inside a transaction that is always rolled back, and the
    // assertion afterwards proves the cluster came back.
    const client = adminMigratorClient();
    await client.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.organization_id', $1, true)`,
        [multi().alpha.organizationId],
      );
      const guarded = await client.query<{ wrong: string }>(
        `select count(*) filter (where organization_id is distinct from $1::uuid)::text as wrong
           from memberships`,
        [multi().alpha.organizationId],
      );
      expect(Number(guarded.rows[0]?.wrong), 'the sweep saw foreign rows BEFORE the control was removed').toBe(0);

      await client.query('alter table memberships no force row level security');
      const unguarded = await client.query<{ wrong: string }>(
        `select count(*) filter (where organization_id is distinct from $1::uuid)::text as wrong
           from memberships`,
        [multi().alpha.organizationId],
      );
      expect(
        Number(unguarded.rows[0]?.wrong),
        'FORCE RLS was removed and the sweep STILL saw no foreign rows — SBX-004 is not ' +
          'measuring RLS at all',
      ).toBeGreaterThan(0);
      log(
        `RED: FORCE RLS off -> ${String(unguarded.rows[0]?.wrong)} foreign membership rows became ` +
          'visible to the owner; SBX-004 would fail, as it must',
      );
    } finally {
      await client.query('rollback');
      await client.end();
    }
    // GREEN again: the rollback restored the control, checked from a fresh
    // connection rather than assumed from the ROLLBACK returning.
    const after = adminMigratorClient();
    await after.connect();
    try {
      const { rows } = await after.query<{ relforcerowsecurity: boolean }>(
        `select relforcerowsecurity from pg_class where relname = 'memberships'`,
      );
      expect(rows[0]?.relforcerowsecurity, 'FORCE RLS did not come back').toBe(true);
      log('the rollback restored FORCE RLS — verified from a fresh connection');
    } finally {
      await after.end();
    }
  });
});

describe('the G-ARCH tenancy subset', () => {
  /**
   * The subset runs ONCE, however the tests are ordered.
   *
   * FAD-15 Layer 4, and this file earned the lesson the hard way: the assertions
   * below used to read a `results` array the first `it` populated, so under
   * `--sequence.shuffle.tests` they ran first and asserted over an empty array.
   * The regression gate caught it — 7 of 10 seeds red — in the very harness
   * built to catch vacuous evidence, which is the argument for having the gate
   * rather than trusting the author. Memoised, the precondition belongs to the
   * describe block instead of to a sibling test, and the scenarios still execute
   * exactly once.
   */
  let subsetRun: Promise<SbxResult[]> | undefined;
  const ensureSubsetRun = async (): Promise<SbxResult[]> => {
    subsetRun ??= (async () => {
      const collected: SbxResult[] = [];
      for (const scenario of buildScenarios(dependencies)) {
        collected.push(await runScenario(scenario));
      }
      return collected;
    })();
    results = await subsetRun;
    return results;
  };

  it('runs every scenario under its contract', async () => {
    await ensureSubsetRun();
    for (const result of results) {
      log(
        `${result.id} ${result.state.padEnd(16)} probe=${result.probeOutcome} ` +
          `${String(result.elapsedMs)}ms${result.failure === undefined ? '' : ` — ${result.failure}`}`,
      );
    }
    const bad = results.filter((r) => r.state !== 'PASS' && r.state !== 'EVIDENCE_BLOCKED');
    expect(
      bad.map((r) => `${r.id}: ${r.state} ${r.failure ?? ''}`),
      'a scenario failed or was vacuous',
    ).toEqual([]);
  }, 120_000);

  it('SBX-004 passed with zero cross-tenant rows and no vacuous table', async () => {
    await ensureSubsetRun();
    const sweep = results.find((r) => r.id === 'SBX-004');
    expect(sweep?.state).toBe('PASS');
    expect(sweep?.probeOutcome, 'the sweep could not be made to fail').toBe('FALSIFIABLE');
    // Twelve tenant tables plus `users`. My phase-A prototype probed three of them
    // vacuously; the packet requires all twelve to be covered non-vacuously, and
    // this is where that is asserted rather than hoped.
    expect(sweep?.tables.length, `tables exercised: ${sweep?.tables.join(', ')}`).toBe(13);
  });

  const ensureChainVerified = async (): Promise<string[]> => {
    chainRun ??= (async () => {
      await ensureSubsetRun();
      // Acceptance criterion: "the audit chain must verify clean after every
      // harness run". The scenarios above append audit rows (every membership
      // touch does), so this is the state the run LEFT, not the state it started
      // from — which is the only version worth asserting.
      //
      // The shape is three numbers per organization: chain problems / checkpoints
      // signed / checkpoint problems. Clean is 0 / N>=1 / 0. The middle number is
      // reported rather than fixed at 1 because the periodic sweep may legitimately
      // have written more, and pinning it would make an unrelated change look like
      // a chain failure.
      const worker = runtimes.get('app_worker');
      if (worker === undefined) throw new Error('no worker runtime');
      const lines: string[] = [];
      for (const organizationId of multi().organizationIds) {
        const verification = await worker.runner.run(
          {
            organizationId,
            groupId: null,
            membershipId: null,
            correlationId: 'sbx-chain-verify',
          },
          (uow) => verifyAuditChain(uow),
        );
        const checkpoints = await admin.query<{ n: string }>(
          'select count(*)::text as n from audit_checkpoints where organization_id = $1::uuid',
          [organizationId],
        );
        expect(
          verification.problems.length,
          `${organizationId}: ${JSON.stringify(verification.problems)}`,
        ).toBe(0);
        expect(verification.intact, `${organizationId}: chain not intact`).toBe(true);
        expect(Number(checkpoints.rows[0]?.n), `${organizationId}: no checkpoint signed`).toBeGreaterThan(0);
        const shape = `0 / ${checkpoints.rows[0]?.n ?? '?'} / 0`;
        lines.push(
          `${organizationId.slice(0, 8)}: ${shape}  (${String(verification.entries)} entries, ` +
            `head ${String(verification.headSequence)})`,
        );
        log(`audit chain after the SBX run — ${organizationId.slice(0, 8)}: ${shape}`);
      }
      return lines;
    })();
    chainVerification = await chainRun;
    return chainVerification;
  };

  it('the audit chain verifies clean after the run (the 0 / N / 0 shape)', async () => {
    const lines = await ensureChainVerified();
    expect(lines.length, 'no organization was verified').toBeGreaterThan(0);
  });

  /**
   * D-04 — the writer is memoised, and returns a MANIFEST of what THIS run wrote.
   *
   * The meta-test and the phantom red case used to check only that files existed.
   * Under `--sequence.shuffle.tests` they ran before the writer and passed
   * against the CHECKED-IN artifacts from a previous run — a fresh instance of
   * the Layer 4 class, in the same file, three commits after fixing the last one.
   * Existence was also the wrong question: it is satisfied by a stale file.
   */
  let artifactRun: Promise<{ path: string; bytes: number }[]> | undefined;
  const ensureArtifactsWritten = async (): Promise<{ path: string; bytes: number }[]> => {
    artifactRun ??= (async () => {
      await ensureSubsetRun();
      await ensureChainVerified();
      const repoRoot = resolve(API_ROOT, '../..');
      mkdirSync(resolve(repoRoot, 'docs/evidence/EV-M2-SBX'), { recursive: true });
      const manifest: { path: string; bytes: number }[] = [];
      const write = (relative: string, body: string): void => {
        writeFileSync(resolve(repoRoot, relative), body, 'utf8');
        manifest.push({ path: relative, bytes: Buffer.byteLength(body, 'utf8') });
      };
      write('docs/evidence/EV-M2-SBX/scenario-report.txt', renderReport(results));
      for (const result of results) write(result.contract.retainedArtifact, renderArtifact(result));
      return manifest;
    })();
    return artifactRun;
  };

  it('writes the evidence bundle, including EVERY declared retained artifact', async () => {
    const manifest = await ensureArtifactsWritten();
    expect(manifest.length).toBe(results.length + 1);
    log(`scenario report + ${String(results.length)} per-scenario artifact(s) written`);
  });

  it('SPEC-16 §7 meta-test: every DECLARED artifact exists and is non-empty', async () => {
    // The review found five scenarios declaring `retainedArtifact` paths that did
    // not exist, and nothing checking. A declared artifact nobody produces is a
    // contract field that means nothing — so the declaration is now an
    // obligation the run enforces.
    // INVOKING the memoised writer is the control that closes D-04: it is what
    // guarantees the artifacts exist because THIS run produced them, whatever
    // order the tests run in. The byte-length comparison below is a redundant
    // post-write tamper guard — useful, but not the thing doing the work.
    const manifest = await ensureArtifactsWritten();
    const repoRoot = resolve(API_ROOT, '../..');
    const byPath = new Map(manifest.map((entry) => [entry.path, entry.bytes]));

    const problems: string[] = [];
    for (const result of results) {
      const relative = result.contract.retainedArtifact;
      const path = resolve(repoRoot, relative);
      const expectedBytes = byPath.get(relative);
      if (expectedBytes === undefined) {
        problems.push(`${result.id} -> ${relative}: declared but THIS run did not write it`);
        continue;
      }
      if (!existsSync(path)) {
        problems.push(`${result.id} -> ${relative}: missing from disk`);
        continue;
      }
      const actual = statSync(path).size;
      if (actual === 0) problems.push(`${result.id} -> ${relative}: empty`);
      // Byte length from THIS run must match what is on disk, so a stale file
      // left by an earlier run cannot satisfy the check.
      else if (actual !== expectedBytes) {
        problems.push(
          `${result.id} -> ${relative}: on disk ${String(actual)} bytes, this run wrote ` +
            `${String(expectedBytes)} — the file is not the one this run produced`,
        );
      }
    }
    expect(problems, 'declared retained artifacts not produced by THIS run').toEqual([]);
    log(`${String(results.length)} declared artifact(s), each produced by this run and non-empty`);
  });

  it('RED: a scenario declaring a PHANTOM artifact is caught', async () => {
    // Green-before-red: the real scenarios above pass the same check.
    const manifest = await ensureArtifactsWritten();
    const repoRoot = resolve(API_ROOT, '../..');
    const phantom = 'docs/evidence/EV-M2-SBX/this-artifact-is-never-written.txt';
    expect(manifest.some((entry) => entry.path === phantom)).toBe(false);
    expect(
      existsSync(resolve(repoRoot, phantom)),
      'the phantom path exists, so this red case would pass vacuously',
    ).toBe(false);
    const declared = [...results.map((r) => r.contract.retainedArtifact), phantom];
    const missing = declared.filter((rel) => !existsSync(resolve(repoRoot, rel)));
    expect(missing, 'the meta-test failed to notice a phantom artifact').toEqual([phantom]);
    log('a declared-but-never-written artifact is detected by the meta-test');
  });
});

/**
 * One scenario's retained artifact.
 *
 * For an executed scenario this is its observations — the matrix, the sweep
 * readings, the truth table. For a BLOCKED scenario the artifact records the
 * blocked state and every named dependency, which is itself the evidence: SPEC-16
 * §7 requires a blocked test to be reported, and "reported" means something a
 * reader can open.
 */
function renderArtifact(result: SbxResult): string {
  const lines = [
    `${result.id} — ${result.title}`,
    `generated: ${new Date().toISOString()}`,
    '',
    `STATE: ${result.state}   falsifiability probe: ${result.probeOutcome}   ` +
      `gate-required: ${result.gateRequired ? 'YES' : 'no'}`,
    '',
    'SPEC-16 §1 contract',
  ];
  for (const [field, value] of Object.entries(result.contract)) {
    lines.push(`  ${field.padEnd(24)} ${String(value)}`);
  }
  if (result.failure !== undefined) lines.push('', `FAILURE: ${result.failure}`);
  if (result.tables.length > 0) lines.push('', `tables exercised: ${result.tables.join(', ')}`);
  if (result.policies.length > 0) lines.push(`policies exercised: ${result.policies.join(' | ')}`);
  if (result.blocked.length > 0) {
    lines.push('', 'EVIDENCE_BLOCKED sub-scenarios (never a pass, never a silent skip):');
    for (const blocked of result.blocked) {
      lines.push(`  - ${blocked.subScenario}`);
      lines.push(`      EVIDENCE_BLOCKED(${blocked.dependency})`);
    }
  }
  if (result.observations.length > 0) lines.push('', 'OBSERVATIONS');
  for (const observation of result.observations) {
    lines.push('', `  ${observation.label}:`, `    ${observation.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderReport(all: readonly SbxResult[]): string {
  const counts = {
    required: all.length,
    executed: all.filter((r) => r.state !== 'EVIDENCE_BLOCKED' && r.state !== 'NOT_RUNNABLE').length,
    passed: all.filter((r) => r.state === 'PASS').length,
    failed: all.filter((r) => r.state === 'FAIL').length,
    blocked: all.filter((r) => r.state === 'EVIDENCE_BLOCKED').length,
    vacuous: all.filter((r) => r.state === 'VACUOUS').length,
    probeError: all.filter((r) => r.state === 'PROBE_ERROR').length,
    notRunnable: all.filter((r) => r.state === 'NOT_RUNNABLE').length,
  };
  const lines: string[] = [];
  lines.push('OPUS-M2-001 — SBX evidence harness, G-ARCH tenancy subset');
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('G-ARCH IS NOT CLOSED BY THIS RUN. It also needs SBX-011, 013, 014b, 022, 023');
  lines.push('and 028 at later milestones. This subset clears the tenancy part.');
  lines.push('');
  lines.push(
    `scenarios required ${String(counts.required)} · executed ${String(counts.executed)} · ` +
      `passed ${String(counts.passed)} · failed ${String(counts.failed)} · ` +
      `blocked ${String(counts.blocked)} · vacuous ${String(counts.vacuous)} · ` +
      `probe-error ${String(counts.probeError)} · not-runnable ${String(counts.notRunnable)}`,
  );
  lines.push('');
  for (const result of all) {
    lines.push('='.repeat(78));
    lines.push(`${result.id} — ${result.title}`);
    lines.push(
      `STATE: ${result.state}   falsifiability probe: ${result.probeOutcome}   ` +
        `gate-required: ${result.gateRequired ? 'YES' : 'no'}   ${String(result.elapsedMs)} ms`,
    );
    if (result.failure !== undefined) lines.push(`FAILURE: ${result.failure}`);
    lines.push('');
    lines.push('  SPEC-16 §1 contract');
    for (const [field, value] of Object.entries(result.contract)) {
      lines.push(`    ${field.padEnd(24)} ${String(value)}`);
    }
    if (result.tables.length > 0) lines.push(`  tables exercised: ${result.tables.join(', ')}`);
    if (result.policies.length > 0) lines.push(`  policies exercised: ${result.policies.join(' | ')}`);
    if (result.blocked.length > 0) {
      lines.push('  EVIDENCE_BLOCKED sub-scenarios (never a pass, never a silent skip):');
      for (const blocked of result.blocked) {
        lines.push(`    - ${blocked.subScenario}  ->  EVIDENCE_BLOCKED(${blocked.dependency})`);
      }
    }
    for (const observation of result.observations) {
      lines.push(`  ${observation.label}: ${observation.detail}`);
    }
    lines.push('');
  }
  lines.push('='.repeat(78));
  lines.push('vacuous assertions detected: ' + String(counts.vacuous));
  lines.push('');
  lines.push('AUDIT CHAIN AFTER THIS RUN — chain problems / checkpoints signed / checkpoint problems');
  lines.push('(clean is 0 / N>=1 / 0; the middle number is reported rather than pinned, because');
  lines.push(' the periodic sweep may legitimately have signed more than one)');
  for (const line of chainVerification.length > 0 ? chainVerification : ['  (not captured)']) {
    lines.push(`  ${line}`);
  }
  lines.push('');
  lines.push('evidence path: docs/evidence/EV-M2-SBX/scenario-report.txt');
  return `${lines.join('\n')}\n`;
}
