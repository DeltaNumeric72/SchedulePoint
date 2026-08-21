import { createCheckpointSigner } from './audit/checkpoint-signer.js';
import { maxConcurrentBuildsPerOrganization } from './builds/capacity.js';
import { startBuildQueueRunner, type BuildQueueRunner } from './builds/queue-runner.js';
import { SessionPrincipalResolver } from './authn/principal-resolver.js';
import { createAuthnService } from './authn/service.js';
import { createSecretBox } from './authn/secret-box.js';
import { ProcessAlertSink } from './db/alerts.js';
import { createPool } from './db/pool.js';
import { assertTransactionAffinity } from './db/pooler-assertion.js';
import { installQueueSchema } from './db/queue-schema.js';
import { PgUnitOfWorkRunner } from './db/unit-of-work.js';
import { undeclaredRoutes } from './http/route-table.js';
import { buildServer } from './http/server.js';
import { startOutboxRunner, type OutboxRunner } from './outbox/runner.js';
import { DatabaseOutboxSink } from './outbox/sink.js';

/**
 * Process entry point.
 *
 * Three things happen before the socket opens, and each of them refuses to serve
 * traffic rather than degrade:
 *
 *  1. **The pooler-mode assertion** (SPEC-01 §4 amendment (c)). The
 *     per-transaction read-back is a detector, not a proof, against
 *     statement-level routing — the load-bearing control is configuration. A
 *     process that cannot demonstrate transaction affinity has no basis for any
 *     tenant guarantee it would otherwise make, so it exits.
 *
 *  2. **The undeclared-route assertion** (I-02). CI catches this before merge;
 *     the boot check means a route that somehow reaches a running process still
 *     fails closed rather than serving unauthorized traffic.
 *
 *  3. **The principal resolver is the SESSION resolver** (OPUS-M3-001). It
 *     replaces `denyAllPrincipalResolver`, which shipped at M1 as the
 *     fail-closed default until a session store existed. What has NOT changed is
 *     the absence of any header-, environment- or query-parameter-based
 *     principal: there is exactly one way to be authenticated in a production
 *     process, and it is a cookie naming a row in `sessions`.
 *     `denyAllPrincipalResolver` is retained in `http/context/principal.ts` and
 *     is what a process built without a database still uses.
 *
 * ## The async kernel starts here too (OPUS-M1-003)
 *
 * The second review found the audit/outbox kernel wired into the test harness
 * and nowhere else: a production process would have started happily and then
 * failed on the first `publishOutboxEvent`, because `app_enqueue_job` would not
 * exist (R-03). Three things therefore happen before the socket opens:
 *
 *  4. **`installQueueSchema()`** — graphile-worker owns its own schema and its
 *     own migration history, so it cannot live in `apps/api/migrations`. It also
 *     applies SP-D condition C-1's policies, without which `app_worker` reads
 *     zero rows from the queue and processes nothing, **silently**.
 *
 *  5. **The outbox runner**, which consumes dispatches and carries SPEC-11 §2's
 *     periodic checkpoint and verification jobs. The verification job **pages**
 *     on any discrepancy; `src/audit/verify-cli.ts` remains for an operator who
 *     needs to ask directly during an incident.
 *
 *  6. **`SP_DISABLE_WORKER=1`** runs the API without the worker, for a
 *     deployment that runs workers as separate processes. It is a deliberate
 *     opt-out with a name that says what it does, not a default — a process that
 *     quietly declined to run the audit checkpointer would be the worst of both.
 *
 * **The signing key is the local stub** (`keyIsIsolated === false`). It is
 * logged at startup, every time, because a checkpoint signed by a key the
 * application holds proves the signing path works and nothing about who could
 * have produced it. SPEC-11 §6 requires a separate trust domain; real KMS is a
 * deployment condition (TDG-15).
 */
async function main(): Promise<void> {
  const alerts = new ProcessAlertSink();
  const pool = createPool('app_runtime');

  const probe = await assertTransactionAffinity(pool);
  process.stdout.write(
    `pooler-mode assertion passed: one backend (${String(probe.firstBackendPid)}) for the ` +
      'whole transaction, transaction-local setting survived within it and expired after it\n',
  );

  const runtime = new PgUnitOfWorkRunner({ role: 'app_runtime', pool, alerts });

  /* ── the async kernel ─────────────────────────────────────────────────── */
  const queueSchema = await installQueueSchema((message) =>
    process.stdout.write(`${message}\n`),
  );
  process.stdout.write(
    `queue schema ready: ${String(queueSchema.workerMigrations)} graphile-worker ` +
      `migration(s), ${String(queueSchema.policiesCreated)} RLS table(s) policed for app_worker\n`,
  );

  let outbox: OutboxRunner | undefined;
  let builds: BuildQueueRunner | undefined;
  if (process.env['SP_DISABLE_WORKER'] !== '1') {
    const workerPool = createPool('app_worker');
    const workerRunner = new PgUnitOfWorkRunner({ role: 'app_worker', pool: workerPool, alerts });
    const signer = createCheckpointSigner();
    if (!signer.keyIsIsolated) {
      process.stdout.write(
        'AUDIT SIGNING KEY IS NOT ISOLATED: checkpoints are signed by a key held in this ' +
          'process (local stub, FAD-7). SPEC-11 §6 requires a separate trust domain; a ' +
          'checkpoint proves the signing path works and nothing about who produced it.\n',
      );
    }
    outbox = await startOutboxRunner({
      worker: workerRunner,
      sink: new DatabaseOutboxSink(workerRunner),
      signer,
      alerts,
      label: 'api',
    });
    process.stdout.write(
      `outbox runner started: pool ${outbox.poolId}, reclaimed ` +
        `${String(outbox.reclaimedAtStartup.length)} stale pool(s); periodic checkpoint and ` +
        'chain-verification jobs scheduled (SPEC-11 §2)\n',
    );

    /* ── D-4b's queue binding (OPUS-M4-005) ────────────────────────────────
     *
     * Its OWN pool, not another task on the outbox runner's. An outbox dispatch
     * is milliseconds and a solve is minutes, and one shared concurrency budget
     * means a saturated solver stops every notification in the system. SPEC-10
     * §2 already gives the solver its own process class; this is the queue-side
     * half of the same separation, and `SP_DISABLE_WORKER=1` still opts a
     * pure-HTTP process out of both. */
    builds = await startBuildQueueRunner({
      worker: workerRunner,
      label: 'builds',
      concurrency: Number.parseInt(process.env['SP_BUILD_WORKER_CONCURRENCY'] ?? '1', 10),
    });
    process.stdout.write(
      `build solve runner started: pool ${builds.poolId}, reclaimed ` +
        `${String(builds.reclaimedAtStartup.length)} stale pool(s); D-4b cap ` +
        `${String(maxConcurrentBuildsPerOrganization())} concurrent solve(s) per organization\n`,
    );
  } else {
    process.stdout.write(
      'SP_DISABLE_WORKER=1: this process serves HTTP only. Another process MUST run the ' +
        'outbox dispatcher, the SPEC-11 §2 periodic jobs AND the build.solve task, or outbox ' +
        'events will never be delivered, the chain will never be checkpointed, and every ' +
        'submitted build will sit in `queued` for ever.\n',
    );
  }

  /* ── authentication (OPUS-M3-001) ─────────────────────────────────────── */
  const authn = createAuthnService();
  const secretBox = createSecretBox();
  if (!secretBox.keyIsIsolated) {
    // Logged every time, for the reason the signing-key warning above is: the
    // TOTP secrets in `user_mfa` are encrypted with a key this process holds,
    // so an actor who can read the process's environment can read them. Real
    // key custody is a deployment condition (TDG-15), not a claim.
    process.stdout.write(
      'MFA SECRET KEY IS NOT ISOLATED: TOTP secrets are encrypted with a key held in this ' +
        'process. A database reader without the key recovers nothing; an actor with the ' +
        "process's environment recovers everything.\n",
    );
  }

  const { app, routeTable } = await buildServer({
    logger: true,
    tenancy: { runtime, principals: new SessionPrincipalResolver({ runtime, authn }) },
    authn,
  });

  const undeclared = undeclaredRoutes(routeTable);
  if (undeclared.length > 0) {
    for (const route of undeclared) {
      app.log.fatal({ route }, 'route registered without a policy declaration');
    }
    throw new Error(`${String(undeclared.length)} route(s) registered without a policy`);
  }

  // The worker holds a lease on anything it is running; a process that exits
  // without releasing it costs four hours of recovery (SP-D E-2.3), so the
  // shutdown path is wired even though nothing sends the signal here yet.
  const shutdown = async (): Promise<void> => {
    await builds?.stop();
    await outbox?.stop();
    await app.close();
  };
  process.once('SIGTERM', () => void shutdown());

  const port = Number.parseInt(process.env['PORT'] ?? '3001', 10);
  const host = process.env['HOST'] ?? '127.0.0.1';
  await app.listen({ port, host });
}

await main();
