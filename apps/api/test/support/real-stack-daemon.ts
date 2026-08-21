import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

import { ProcessAlertSink } from '../../src/db/alerts.js';
import { bootstrapCluster, rolePasswordsFromEnv } from '../../src/db/bootstrap.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { installQueueSchema } from '../../src/db/queue-schema.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { createAuthnService } from '../../src/authn/service.js';
import * as store from '../../src/authn/store.js';
import { startClusterDaemon, stopClusterDaemon, withClusterDiagnostic } from './cluster-process.js';
import { API_ROOT, applyHarnessEnv } from './env.js';
import { FIXTURE_PASSWORD, codeFor } from './authn.js';
import { FIXTURE_RPC_KEY_ID, FIXTURE_RPC_SECRET, SOLVER_ROOT } from './solver.js';
import { provisionMulti } from './multi.js';

/**
 * The REAL STACK, in one process — cluster, schema, fixture, credentials — plus
 * the real API as a child of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why this exists (FAD-48 clause (A) part 3)
 *
 * `apps/web/e2e/**` proves the interface under interception; `apps/api/test/**`
 * proves the server over HTTP and in SQL. **The join between them had never been
 * exercised** (EV-M4-005 §12), and the first thing that asked for it was doc 35
 * §6g's critical-path requirement. This daemon is what a browser talks to when
 * nothing is mocked: a throwaway PostgreSQL cluster, the migrated schema, the
 * production seed path, and `apps/api/src/index.ts` itself — the same entry
 * point a deployment runs, with the outbox runner and the `build.solve` queue
 * runner it starts.
 *
 * ## What it is NOT
 *
 * It is not a second server implementation and it is not a test double. The
 * only thing here that does not exist in production is the *provisioning*: an
 * organization, a group, a catalogue, and one activated account with a known
 * password — the things a real deployment gets from an administrator. Every one
 * of those is written through the production write path (`provisionMulti`, the
 * authentication service), because a fixture that writes rows directly proves a
 * schema rather than a system.
 *
 * ## Its own cluster, on its own port
 *
 * `SP_TEST_PG_PORT` is set by the caller from the same per-worktree derivation
 * `scripts/sbx/test-port.mjs` uses, in the NESTED band — so a real-stack run and
 * a Vitest run in the same worktree cannot destroy each other's data directory.
 * That collision is E-1, and it cost two agents a day (`env.ts`).
 *
 * ## The handshake
 *
 * One line on stdout — `REALSTACK <json>` — carrying the ports and every
 * identifier the browser needs, then the process stays alive until `SIGTERM`.
 * The same shape `cluster-daemon.ts` uses, and for the same reason: a file on
 * disk is a second source of truth that can be stale.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TSX_CLI = resolve(API_ROOT, '../../node_modules/tsx/dist/cli.mjs');
const API_ENTRY = resolve(API_ROOT, 'src/index.ts');

function requiredPort(name: string): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${name} must be a port between 1024 and 65535; it is "${raw ?? ''}"`);
  }
  return parsed;
}

const API_PORT = requiredPort('SP_REAL_STACK_API_PORT');

applyHarnessEnv();

/**
 * ONE MFA key for this process AND the API child, and why that is not optional.
 *
 * `createSecretBox()` mints a RANDOM key when no `SP_AUTHN_MFA_KEY_V*` is set —
 * a correct fail-safe for a process that has no key custody, and fatal here: the
 * enrolment below is sealed in THIS process and opened by the API child during
 * the browser's challenge, so two random keys means a challenge that can never
 * succeed and an error that says only "no enrolment".
 *
 * The value is COMPUTED rather than written down, so no base64-looking literal
 * that a reader (or the secret-scan gate) has to judge appears in the source. It
 * is a constant fill byte for a cluster that is destroyed at teardown.
 */
process.env['SP_AUTHN_MFA_KEY_V1'] = Buffer.alloc(32, 0x2a).toString('base64');

/**
 * The two children, in one mutable holder.
 *
 * A holder rather than two `let`s: they are declared here and assigned by the
 * top-level sequence below, which `prefer-const` cannot see and correctly
 * objects to. One object with two optional fields says the same thing without
 * arguing with the rule.
 */
const children: { cluster?: ChildProcess; api?: ChildProcess } = {};
let stopping = false;

async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  const running = children.api;
  if (running !== undefined && running.exitCode === null) {
    running.kill('SIGTERM');
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        running.kill('SIGKILL');
        done();
      }, 10_000);
      running.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
  await stopClusterDaemon(children.cluster);
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

function note(message: string): void {
  process.stderr.write(`[real-stack] ${message}\n`);
}

/* ── 1. the cluster, the schema, the queue ─────────────────────────────────── */

children.cluster = await startClusterDaemon();
note('cluster started');

await withClusterDiagnostic('bootstrapCluster', () =>
  bootstrapCluster({ passwords: rolePasswordsFromEnv() }),
);
const applied = await migrate('up');
note(`schema migrated: ${String(applied.applied.length)} migration(s)`);
await installQueueSchema();
note('queue schema installed');

/* ── 2. the fixture, through the production write path ─────────────────────── */

const alerts = new ProcessAlertSink({ write: () => {} });
const runtimePool = createPool('app_runtime', { max: 4, allowExitOnIdle: true });
const workerPool = createPool('app_worker', { max: 2, allowExitOnIdle: true });
const runtime = new PgUnitOfWorkRunner({ role: 'app_runtime', pool: runtimePool, alerts });
const worker = new PgUnitOfWorkRunner({ role: 'app_worker', pool: workerPool, alerts });

/**
 * The seed, and one option deliberately NOT taken.
 *
 * `catalogue` + `scheduleCredentials` is the combination every publication-side
 * file in `apps/api/test/schedule/**` uses: the catalogue's first shift type
 * carries a qualification requirement, and publication enforces that edge
 * structurally, so the assignees must hold the credential exactly as they would
 * in production.
 *
 * `staffing: true` is NOT taken, and the reason is measured rather than assumed:
 * it seeds its own holding of the same qualification, and the two overlap on
 * `capability_grants_no_overlapping_window` — `23P01`, from the exclusion
 * constraint doing its job. No file in the suite combines them either.
 */
const fixture = await provisionMulti(runtime, worker, 'real-stack-critical-path', 'full', {
  catalogue: ['alpha'],
  scheduleCredentials: true,
});
note('fixture provisioned');

const alpha = fixture.alpha;
const group = alpha.groupOne;
const catalogue = fixture.catalogue?.alpha;
if (catalogue === undefined) throw new Error('the alpha catalogue was not seeded');

/**
 * The account the BROWSER signs in as.
 *
 * `scheduler` rather than an administrator, because the critical path is a
 * scheduler's workflow and running it as an account with every capability would
 * prove that an omnipotent actor can drive it. It is in `MFA_REQUIRED_ROLES`, so
 * the enrolment below is not optional — it is what production requires of this
 * role, and the browser completes the challenge itself.
 */
const actor = alpha.users.scheduler;

const authn = createAuthnService();

const administratorContext = {
  organizationId: alpha.organizationId,
  groupId: null,
  membershipId: alpha.users.organizationAdmin.membershipId,
  correlationId: 'real-stack-provision',
};
const anonymousContext = {
  organizationId: alpha.organizationId,
  groupId: null,
  membershipId: null,
  correlationId: 'real-stack-provision-anon',
};

const invitation = await runtime.run(administratorContext, (uow) =>
  authn.issueInvitation(uow, {
    userId: actor.id,
    email: 'real-stack-scheduler@example.test',
    notificationRef: 'sink:real-stack',
  }),
);
await runtime.run(anonymousContext, (uow) =>
  authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
);
const credential = await runtime.run(anonymousContext, (uow) =>
  store.findCredentialById(uow, actor.id),
);
if (credential === undefined) throw new Error('the actor has no credential row after activation');

/**
 * The second factor, enrolled server-side; the browser answers with a RECOVERY
 * CODE.
 *
 * Enrolling here rather than in the browser is a scope decision, not a shortcut:
 * `MfaEnrolmentPage` has its own e2e coverage, and driving it from the critical
 * path would require the spec to compute a TOTP code — which means importing the
 * API's test support into `apps/web/e2e`, across the very import boundary
 * `.dependency-cruiser.cjs` exists to keep. The browser still performs the
 * CHALLENGE, through `MfaChallengePage`'s "Use a recovery code instead" control,
 * so the sign-in the critical path drives is the real two-step one.
 */
const enrolment = await runtime.run(anonymousContext, (uow) =>
  authn.startMfaEnrolment(uow, { userId: actor.id, label: credential.loginEmail }),
);
const confirmed = await runtime.run(anonymousContext, (uow) =>
  authn.confirmMfaEnrolment(uow, {
    userId: actor.id,
    code: codeFor(enrolment.secretBase32, new Date()),
  }),
);
note('actor activated and enrolled');

await runtimePool.end();
await workerPool.end();

/* ── 3. the REAL API, as its own process ───────────────────────────────────── */

/**
 * The solver RPC channel's environment, which is NOT optional.
 *
 * `SP_SOLVER_RPC_SECRET` has deliberately no default — the channel is mutually
 * authenticated (SPEC-04 §1.1) and `solverRpcKey` throws rather than inventing
 * one. Measured on the first real solve this harness attempted: the build
 * reached `running` and then failed with exactly that refusal, which is the
 * control working. The values are the same synthetic fixture constants
 * `apps/api/test/support/solver.ts` uses; `SP_SOLVER_WORKER_COMMAND` is supplied
 * by the caller and is never committed.
 */
const solverEnv: Record<string, string> = {
  SP_SOLVER_RPC_SECRET: FIXTURE_RPC_SECRET,
  SP_SOLVER_RPC_KEY_ID: FIXTURE_RPC_KEY_ID,
  SP_SOLVER_WORKER_ARGS: JSON.stringify(['-m', 'schedulepoint_solver']),
  SP_SOLVER_WORKER_CWD: SOLVER_ROOT,
};
const solverCommand = process.env['SP_SOLVER_WORKER_COMMAND'];
children.api = spawn(process.execPath, [TSX_CLI, API_ENTRY], {
  cwd: API_ROOT,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    HOST: '127.0.0.1',
    ...solverEnv,
    ...(solverCommand === undefined ? {} : { SP_SOLVER_WORKER_COMMAND: solverCommand }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.api.stdout?.on('data', (chunk: Buffer) => process.stderr.write(`[api] ${chunk.toString()}`));
children.api.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[api!] ${chunk.toString()}`));
children.api.once('exit', (code) => {
  note(`the API process exited with ${String(code)}`);
  if (!stopping) void shutdown(1);
});

/** Waits for the API to answer its own health route. */
async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(API_PORT)}/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error('the API did not become healthy within 90s');
    await new Promise((done) => setTimeout(done, 250));
  }
}
await waitForApi();
note(`API healthy on ${String(API_PORT)}`);

/* ── 4. the handshake ──────────────────────────────────────────────────────── */

process.stdout.write(
  `REALSTACK ${JSON.stringify({
    apiPort: API_PORT,
    organizationId: alpha.organizationId,
    groupId: group.id,
    groupTwoId: alpha.groupTwo.id,
    membershipId: actor.membershipId,
    userId: actor.id,
    loginEmail: credential.loginEmail,
    password: FIXTURE_PASSWORD,
    recoveryCodes: confirmed.recoveryCodes,
    shiftTypeIds: catalogue.shiftTypeIds,
    qualificationId: catalogue.qualificationId,
    solverCommand: solverCommand ?? null,
  })}\n`,
);

setInterval(() => {}, 1 << 30);
