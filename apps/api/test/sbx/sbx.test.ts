import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';
import PgPkg from 'pg';
import type pg from 'pg';

const { Client: PgClient } = PgPkg;
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../src/audit/verification.js';
import { TENANT_TABLES } from '../../src/db/schema.js';
import { buildServer } from '../../src/http/server.js';
import type { RouteTableEntry } from '../../src/http/route-table.js';
import { adminClient } from '../support/admin-client.js';
import { createPool } from '../../src/db/pool.js';
import { API_ROOT } from '../support/env.js';
import { isEvidenceRefresh, resolveEvidencePath } from '../support/evidence-target.js';
import { log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { seedRulesForSweep } from '../support/rules.js';
import { seedLocationsForSweep } from '../support/settings.js';
import { seedBuildLifecycleForSweep } from '../support/builds.js';
import { seedRequestsForSweep } from '../support/requests.js';
import { seedSolverSnapshotsForSweep } from '../support/solver.js';
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

/* The catalogue and staffing rows this file's probes need.
 *
 * Every table registered in `TENANT_TABLES` must be observed with a VISIBLE
 * row: a probe over a table nobody ever saw a row in reports "0 wrong-tenant
 * rows" for the most boring possible reason, and that vacuous pass is what the
 * non-vacuity checks exist to refuse. So the fixture holds rows in all of them.
 *
 * The seeding used to be two per-file modules called after `ownedMulti` had
 * provisioned, because packet 30 §5 made the MULTI provisioning script
 * read-only while the two M2 packets ran in parallel. The **D-1** ruling moved
 * it back into `provisionMulti`, so a file DECLARES what it needs and the
 * fixture is complete when `beforeAll` returns.
 *
 * The credential is issued to Alpha's `scheduler` membership deliberately:
 * `qualification_holdings` is SENSITIVE-PII with no organization-wide read
 * policy, and that membership is the one these probes act as. A holding
 * belonging to anybody else would be invisible to every probe context and the
 * table would report a vacuous zero. */
const multi = ownedMulti('sbx-harness', {
  profile: 'full',
  seed: { staffing: true, catalogue: ['alpha'], schedule: true },
});

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

  /* ── OPUS-M3-002: rule rows for the SBX-004 sweep ────────────────────────
   *
   * Migration 0008 registers `rules` and `rule_sets` in `TENANT_TABLES`, and the
   * sweep's own non-vacuity check fails when a REGISTERED table is never seen
   * with a visible row — "0 wrong" over an empty table means nothing. So the
   * fixture needs rule rows.
   *
   * Seeded HERE rather than in `provisionMulti`, deliberately: `test/support/
   * multi.ts` is the single fixture owner and is **prohibited to this packet**
   * (packet 32 §4/§6, and it is M3-003's window too). This file and
   * `test/support/rules.ts` are both in OPUS-M3-002's allowed globs, so the
   * seeding reaches the same fixture without either packet editing the shared
   * provisioning script. If the two packets' needs ever have to meet in
   * `multi.ts` itself, that is the integration packet's job, not a merge.
   *
   * Written into BOTH of Alpha's groups and into Beta, so the group predicate
   * arm has rows it COULD see if the predicate were broken — not only the
   * cross-organization arm. */
  const alpha = multi().alpha;
  const beta = multi().beta;
  const seedRuntime = runtimes.get('app_runtime');
  if (seedRuntime === undefined) throw new Error('no app_runtime runtime for rule seeding');
  const seeded = await seedRulesForSweep(seedRuntime.runner, [
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      label: 'alpha_one',
    },
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupTwo.id,
      membershipId: alpha.users.scheduler.groupTwoMembershipId,
      label: 'alpha_two',
    },
    {
      organizationId: beta.organizationId,
      groupId: beta.groupOne.id,
      membershipId: beta.users.scheduler.membershipId,
      label: 'beta_one',
    },
  ]);
  log(`      · OPUS-M3-002: seeded ${String(seeded)} rule row(s) across three groups for SBX-004`);

  /* ── OPUS-M3-007: location rows for the SBX-004 sweep ─────────────────────
   *
   * Migration 0010 registers `locations` in `TENANT_TABLES` — this packet RAISES
   * the sweep floor — and the sweep's non-vacuity check fails a registered table
   * that is never seen with a visible row. Same arrangement as the rule seeding
   * above and for the same reason: `test/support/multi.ts` is the single fixture
   * owner and packet 32 §10a gives this packet `test/support/settings.ts` alone.
   *
   * Into both of Alpha's groups and into Beta, so the group-predicate arm has
   * rows it could see if the predicate were broken.
   *
   * **Alpha Group One is seeded by the GROUP ADMINISTRATOR**, who holds the key
   * by role — no grant is written for it. The other two groups have no
   * `group_admin` membership, so they get a TEMPORARY layer-4 grant that
   * `seedLocationsForSweep` closes again the instant the rows are written.
   *
   * Both details are a correction, not a preference. The first version granted
   * the capability to `alpha.users.scheduler` and left the grant open, and this
   * scenario's own matrix then printed
   * `scheduler(G1+G2) … GET settings/locations=200` — true of that principal,
   * and badly misleading on a row labelled by ROLE, since doc 08 §6 puts
   * scheduler at `—` for group settings. Found by reading the run's output. */
  const alphaFull = alpha.full;
  if (alphaFull === undefined) throw new Error('the full profile provisions a group admin');

  const seededLocations = await seedLocationsForSweep(seedRuntime.runner, [
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      // The GROUP ADMINISTRATOR, who holds `group.location.administer` by ROLE
      // (doc 08 §6 "Group settings"). No grant is written here at all — which
      // is what keeps SBX-001's `group_admin(G1)` row a true statement about
      // the role rather than about a fixture's grant.
      membershipId: alphaFull.groupAdmin.membershipId,
      label: 'alpha_one',
    },
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupTwo.id,
      membershipId: alpha.users.scheduler.groupTwoMembershipId,
      grantorMembershipId: alpha.users.organizationAdmin.membershipId,
      label: 'alpha_two',
    },
    {
      organizationId: beta.organizationId,
      groupId: beta.groupOne.id,
      membershipId: beta.users.scheduler.membershipId,
      grantorMembershipId: beta.users.organizationAdmin.membershipId,
      label: 'beta_one',
    },
  ]);
  log(
    `      · OPUS-M3-007: seeded ${String(seededLocations)} location row(s) across three groups ` +
      'for SBX-004 (sweep floor raised)',
  );

  /* ── OPUS-M4-001: solver input snapshots for the SBX-004 sweep ─────────────
   *
   * Migration 0016 registers `solver_input_snapshots` in `TENANT_TABLES` — this
   * packet RAISES the sweep floor again — and the sweep's non-vacuity check
   * fails a registered table that is never seen with a visible row. Same
   * arrangement, same reason.
   *
   * **Two groups, not three**, and the asymmetry is deliberate rather than an
   * omission: assembling a canonical input needs a catalogue, and only Alpha is
   * provisioned with one (`seed.catalogue: ['alpha']`, which seeds Group One and
   * its sibling). Two groups is what the cross-GROUP arm actually requires —
   * rows Group One could see if the group predicate were broken. Extending the
   * catalogue seed to Beta to make a symmetry nothing needs would change what
   * every existing Beta assertion is asserting about.
   *
   * A snapshot is the single most consequential row in this schema to leak: it
   * is a description of one group's entire staffing position for one period. */
  const alphaCatalogue = multi.catalogue('alpha');
  const alphaShiftType = alphaCatalogue.shiftTypeIds[1];
  const siblingShiftType = alphaCatalogue.sibling.shiftTypeIds[1];
  if (alphaShiftType === undefined || siblingShiftType === undefined) {
    throw new Error('the alpha catalogue seed produced no shift type for the solver sweep');
  }
  const seededSnapshots = await seedSolverSnapshotsForSweep(seedRuntime.runner, [
    {
      label: 'alpha_one',
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      userId: alpha.users.scheduler.id,
      shiftTypeId: alphaShiftType,
      // 2039, far from every other fixture window in this file.
      startDate: '2039-01-03',
      endDate: '2039-01-09',
    },
    {
      label: 'alpha_two',
      organizationId: alpha.organizationId,
      groupId: alphaCatalogue.sibling.groupId,
      membershipId: alpha.users.groupTwoScheduler.membershipId,
      userId: alpha.users.groupTwoScheduler.id,
      shiftTypeId: siblingShiftType,
      startDate: '2039-02-07',
      endDate: '2039-02-13',
    },
  ]);
  log(
    `      · OPUS-M4-001: seeded ${String(seededSnapshots)} solver input snapshot(s) across two ` +
      'groups for SBX-004 (sweep floor raised)',
  );

  /* ── OPUS-M4-003: the six build-lifecycle tables (migration 0018) ──────────
   *
   * Same arrangement, fourth time: seeded HERE rather than in `provisionMulti`,
   * because `test/support/multi.ts` is the single fixture owner and
   * `test/support/builds.ts` is this packet's own file.
   *
   * `seedBuildLifecycleForSweep` drives one whole build per group through the
   * PRODUCTION service — configure, create, transition, claim, persist the
   * outcome — so every one of the six tables holds a row the application can
   * actually produce. The candidate is deliberately refused by a synthetic
   * `not-evaluable` finding, which is what puts a row in `build_run_violations`
   * as well: a clean build would leave that table empty and the sweep's own
   * non-vacuity check would (correctly) fail it. */
  const buildsCatalogue = multi.catalogue('alpha');
  const buildsShiftType = buildsCatalogue.shiftTypeIds[1];
  const buildsSiblingShiftType = buildsCatalogue.sibling.shiftTypeIds[1];
  if (buildsShiftType === undefined || buildsSiblingShiftType === undefined) {
    throw new Error('the alpha catalogue seed produced no shift type for the build sweep');
  }
  const seededBuilds = await seedBuildLifecycleForSweep(seedRuntime.runner, [
    {
      label: 'alpha_one',
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      userId: alpha.users.scheduler.id,
      shiftTypeId: buildsShiftType,
      startDate: '2041-01-07',
      endDate: '2041-01-13',
    },
    {
      label: 'alpha_two',
      organizationId: alpha.organizationId,
      groupId: buildsCatalogue.sibling.groupId,
      membershipId: alpha.users.groupTwoScheduler.membershipId,
      userId: alpha.users.groupTwoScheduler.id,
      shiftTypeId: buildsSiblingShiftType,
      startDate: '2041-02-04',
      endDate: '2041-02-10',
    },
  ]);
  log(
    `      · OPUS-M4-003: seeded ${String(seededBuilds)} complete build(s) across two groups ` +
      'for SBX-004 — six tables, sweep floor raised 48 -> 54',
  );

  /* ── OPUS-M5-000b: the ten request/vacation tables (migrations 0021, 0022) ──
   *
   * Same arrangement, fifth time, and for the same reason: migrations 0021 and
   * 0022 register ten tables in `TENANT_TABLES` — this packet RAISES the sweep
   * floor 54 -> 64 — and the sweep's non-vacuity check fails a REGISTERED table
   * that is never seen with a visible row.
   *
   * `seedRequestsForSweep` differs from the four helpers above in one way it
   * states plainly in its own header: there is no production service to drive,
   * because doc 42 §5b ships none — the whole packet exists to land the schema
   * and its enforcement BEFORE any lifecycle transaction. It therefore writes
   * through the unit of work under real tenant context, meeting the deferred
   * D-18 guard, D-19, D-20, the `allow_request` trigger, the week-in-period
   * trigger and D-27 on the way in.
   *
   * Two of the ten rows are conditional on what the catalogue seeded into the
   * group, which is why the helper returns an outcome per target rather than a
   * count: only Alpha's groups have shift types, and only Alpha Group One's
   * bundle has `allow_request = true` (the sibling's is deliberately false). The
   * assertion below is that SOMETHING wrote both, since one visible row is what
   * non-vacuity needs. */
  const seededRequests = await seedRequestsForSweep(seedRuntime.runner, [
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      label: 'alpha_one',
      periodStart: '2043-03-02',
    },
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupTwo.id,
      membershipId: alpha.users.scheduler.groupTwoMembershipId,
      label: 'alpha_two',
      periodStart: '2043-04-06',
    },
    {
      organizationId: beta.organizationId,
      groupId: beta.groupOne.id,
      membershipId: beta.users.scheduler.membershipId,
      label: 'beta_one',
      periodStart: '2043-05-04',
    },
  ]);
  log(
    `      · OPUS-M5-000b: seeded ${String(
      seededRequests.reduce((total, one) => total + one.requests, 0),
    )} request(s) across three groups for SBX-004 — thirteen tables, sweep floor raised 54 -> 67` +
      ` (shift preference in ${String(
        seededRequests.filter((one) => one.shiftPreference).length,
      )}, shift-group-off in ${String(
        seededRequests.filter((one) => one.shiftGroupOff).length,
      )})`,
  );
}, 240_000);

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
      expect(
        contractProblems(scenario),
        `${scenario.id}: ${contractProblems(scenario).join('; ')}`,
      ).toEqual([]);
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
      await client.query(`select set_config('app.organization_id', $1, true)`, [
        multi().alpha.organizationId,
      ]);
      const guarded = await client.query<{ wrong: string }>(
        `select count(*) filter (where organization_id is distinct from $1::uuid)::text as wrong
           from memberships`,
        [multi().alpha.organizationId],
      );
      expect(
        Number(guarded.rows[0]?.wrong),
        'the sweep saw foreign rows BEFORE the control was removed',
      ).toBe(0);

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
    /* Raised 120s -> 900s by OPUS-M4-005. SBX-015 and SBX-017 run FOUR real
     * CP-SAT solves in a separate subprocess between them (doc 35 §6g Included
     * (C)); the tenancy subset alone never left this process. The bound is a
     * guard against a wedged subprocess, not a performance assertion — nothing
     * in this file asserts on a duration. */
  }, 900_000);

  it('SBX-004 passed with zero cross-tenant rows and no vacuous table', async () => {
    await ensureSubsetRun();
    const sweep = results.find((r) => r.id === 'SBX-004');
    expect(sweep?.state).toBe('PASS');
    expect(sweep?.probeOutcome, 'the sweep could not be made to fail').toBe('FALSIFIABLE');
    /* EVERY registered tenant table, derived from the registry rather than
     * counted by hand.
     *
     * **Both M2 packets fixed the same hard-coded literal, independently.** It
     * was `13` — twelve tables plus `users` — and each of OPUS-M2-002's nine
     * catalogue tables and OPUS-M2-003's four staffing tables made that number
     * wrong while the property it stood for became more true. A hand-counted
     * number is also a merge conflict that resolves silently to the wrong
     * answer, which is precisely the risk two parallel worktrees create.
     *
     * This composition keeps both properties the two sides asserted:
     *
     *   - **set equality** (M2-002's form) — a missing table is named, rather
     *     than reported as an off-by-one that could be any of twenty-six;
     *   - **a shrink floor** (M2-003's form) — a registry that got SMALLER would
     *     satisfy set equality against its own shrunken self, so the floor is
     *     what notices a table being removed from the registry entirely.
     *
     * What makes either assertion real is the sweep's own vacuity check, which
     * fails when a REGISTERED table is never seen with a visible row. These
     * lines only confirm the sweep reported on all of them. */
    const expectedTables = TENANT_TABLES.map((table) => table.name).sort();
    // Raised 17 → 33 by OPUS-M3-002 (31 after migration 0007, plus `rules` and
    // `rule_sets` from 0008), then 33 → 44 by OPUS-M3-003 as the SECOND MERGER:
    // migration 0009 adds the eleven publication-spine tables. The floor is
    // RAISED rather than left alone because a floor that lags the registry stops
    // noticing a removal — which is the only thing it is for. Raising it
    // strengthens the assertion; it can never be lowered.
    //
    // Both packets' seeding runs in this file, which is what keeps all 44
    // non-vacuous: `seedRulesForSweep` (M3-002) and `seed.schedule` (M3-003).
    //
    // 44 → 47 across the M4-000 family (`staffing_set_versions` from 0012,
    // `rule_revisions` from 0015, and `locations` already counted), then
    // 47 → 48 by OPUS-M4-001: migration 0016 adds `solver_input_snapshots`,
    // kept non-vacuous by `seedSolverSnapshotsForSweep` above. A floor that lags
    // the registry stops noticing a removal, which is the only thing it is for.
    //
    // ## TWO DIFFERENT COUNTS, and confusing them is easy
    //
    // This floor is over the REGISTRY — `TENANT_TABLES.length`, currently **48**.
    // The SBX-004 sweep reports a smaller number, currently **47**, because
    // `probeUnder` skips the one table whose scope is `through-membership`:
    // `users` is global by PO-DEC-06 and reached THROUGH a membership, so
    // "wrong tenant" is not a column comparison for it and it gets its own
    // dedicated probe instead. So `sweep = registry − 1`, permanently, and a
    // runner line reading "47 of 47 tables observed" against a 48-entry registry
    // is the two counts agreeing rather than disagreeing.
    // 48 → 54 by OPUS-M4-003: migration 0018 adds the six build-lifecycle
    // tables, kept non-vacuous by `seedBuildLifecycleForSweep` above.
    //
    // 54 → 64 by OPUS-M5-000b: migrations 0021 and 0022 add the request
    // aggregate, its five non-vacation subtype tables, and the four vacation
    // carriers (`vacation_periods`, `vacation_grants`, `vacation_selections`,
    // `vacation_approval_commands`), kept non-vacuous by `seedRequestsForSweep`
    // above. Raising the floor is what keeps it able to notice a removal, which
    // is the only thing it is for; it can never be lowered.
    //
    // The two-counts note above still holds unchanged: `users` is the one
    // `through-membership` table and gets its own dedicated probe, so the
    // runner's sweep line reads one less than this registry length.
    //
    // 64 -> 65 by OPUS-M5-002: migration 0024 adds `approvals`, SPEC-08 §4's
    // decision record, kept non-vacuous by the same `seedRequestsForSweep` — which
    // now walks a fifth request through the BINDING two-step and records the
    // decision, so the seeded row is one a production writer could have produced.
    // The floor rises for the reason it always rises: a floor that lags the
    // registry stops noticing a removal, which is the only thing it is for.
    //
    // 65 -> 66 by OPUS-M5-00C: migration 0026 adds `request_comments`, SPEC-08
    // §4's fifth row under FAD-58, kept non-vacuous by the same
    // `seedRequestsForSweep` — which now writes ONE ROW PER CHANNEL through the
    // two DIFFERENT policy arms that admit them, so a loosening or a tightening
    // of either arm fails the seed rather than passing quietly. The floor rises
    // for the reason it always rises: a floor that lags the registry stops
    // noticing a removal, which is the only thing it is for.
    //
    // 66 -> 67 by OPUS-M5-004: migration 0027 adds `vacation_commit_commands`,
    // FAD-59's commit-command ledger, kept non-vacuous by the same
    // `seedRequestsForSweep` — which now also creates the DRAFT schedule version
    // the ledger row names, because the schedule seed is opt-in and a ledger row
    // that depended on it would be absent from every fixture that did not ask.
    // The table has NO own-arm, so the seed's INSERT goes through the
    // administration arm and its author pin; a loosening or tightening of either
    // fails the seed rather than passing quietly. The floor rises for the reason
    // it always rises.
    expect(expectedTables.length, 'the tenant registry shrank').toBeGreaterThanOrEqual(67);
    expect(
      [...(sweep?.tables ?? [])].sort(),
      `tables exercised: ${sweep?.tables.join(', ')}`,
    ).toEqual(expectedTables);
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
        expect(
          Number(checkpoints.rows[0]?.n),
          `${organizationId}: no checkpoint signed`,
        ).toBeGreaterThan(0);
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
      /* NR-14 (OPUS-M3-008). A plain run writes under `.evidence-scratch/`, so
       * the battery no longer dirties the tree and the restore-with-`git
       * checkout --` discipline retires; `SP_EVIDENCE_REFRESH=1` writes the
       * TRACKED paths. The DECLARED relative path is unchanged either way — it
       * is the scenario's SPEC-16 contract value, and the manifest below keys on
       * it — so only the root moves. */
      const refresh = isEvidenceRefresh();
      const manifest: { path: string; bytes: number }[] = [];
      const write = (relative: string, body: string): void => {
        const target = resolveEvidencePath(repoRoot, relative, refresh);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body, 'utf8');
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
    const refresh = isEvidenceRefresh();
    const byPath = new Map(manifest.map((entry) => [entry.path, entry.bytes]));

    const problems: string[] = [];
    for (const result of results) {
      const relative = result.contract.retainedArtifact;
      // Resolved the way THIS run wrote it. Checking the tracked path on a
      // scratch run would pass against the checked-in file from a previous run —
      // precisely the Layer 4 staleness D-04 closed, reopened by the redirect.
      const path = resolveEvidencePath(repoRoot, relative, refresh);
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
    const refresh = isEvidenceRefresh();
    const at = (rel: string): string => resolveEvidencePath(repoRoot, rel, refresh);
    const phantom = 'docs/evidence/EV-M2-SBX/this-artifact-is-never-written.txt';
    expect(manifest.some((entry) => entry.path === phantom)).toBe(false);
    expect(
      existsSync(at(phantom)),
      'the phantom path exists, so this red case would pass vacuously',
    ).toBe(false);
    const declared = [...results.map((r) => r.contract.retainedArtifact), phantom];
    const missing = declared.filter((rel) => !existsSync(at(rel)));
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
    executed: all.filter((r) => r.state !== 'EVIDENCE_BLOCKED' && r.state !== 'NOT_RUNNABLE')
      .length,
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
    if (result.policies.length > 0)
      lines.push(`  policies exercised: ${result.policies.join(' | ')}`);
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
  lines.push(
    'AUDIT CHAIN AFTER THIS RUN — chain problems / checkpoints signed / checkpoint problems',
  );
  lines.push('(clean is 0 / N>=1 / 0; the middle number is reported rather than pinned, because');
  lines.push(' the periodic sweep may legitimately have signed more than one)');
  for (const line of chainVerification.length > 0 ? chainVerification : ['  (not captured)']) {
    lines.push(`  ${line}`);
  }
  lines.push('');
  lines.push('evidence path: docs/evidence/EV-M2-SBX/scenario-report.txt');
  return `${lines.join('\n')}\n`;
}
