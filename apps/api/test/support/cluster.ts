import { rm } from 'node:fs/promises';

import EmbeddedPostgres from 'embedded-postgres';

import { CLUSTER_DATA_DIR, CLUSTER_PORT, HARNESS_ENV } from './env.js';

/**
 * FAD-7 environment substitution: a REAL PostgreSQL server, started user-space.
 *
 * The reference machine has no Docker, no Homebrew and no `sudo`, so the harness
 * runs the `embedded-postgres` package's platform binaries — the same `postgres`
 * executable a container would run, listening on `127.0.0.1` with a throwaway
 * data directory. Everything this harness asserts is server-side: RLS
 * evaluation, `set_config(..., true)` lifetime, GUC reset semantics, role
 * attributes, `FORCE ROW LEVEL SECURITY`, foreign-key and unique-check
 * behaviour. None of it differs from a containerised server.
 *
 * What the substitution does **not** cover is unchanged from the spike's
 * disclosure: container networking, and any **external** pooler process
 * (PgBouncer, pgcat, RDS Proxy). Statement-level pooling is simulated at the
 * driver boundary; a simulation is not the product, and TDG-03 needs a follow-up
 * spike in CI if the deployment puts an external pooler in front of PostgreSQL
 * (SPIKE-REPORT §8.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## ⚠ IMPORTING THIS MODULE CHANGES THE PROCESS'S EXIT CODE. MEASURED.
 *
 * `embedded-postgres` registers a graceful-shutdown hook through
 * `async-exit-hook`, which hooks **`beforeExit` with code 0** and, on a natural
 * exit, calls `process.exit(0)` in `process.nextTick`. That **discards
 * `process.exitCode`**. Reproduced directly:
 *
 * ```
 * $ node -e "import('embedded-postgres').then(() => { process.exitCode = 1 })"
 * $ echo $?
 * 0
 * ```
 *
 * The consequence is not subtle. With this module imported into Vitest's main
 * process, `vitest run` printed `1 failed | 232 passed` and **exited 0** — the
 * unit gate reported PASS on a failing suite. `pnpm red-cases` caught it, which
 * is exactly what that command is for: a gate that has only ever been observed
 * passing is not evidence of anything.
 *
 * **So this module is imported by exactly one file — `cluster-daemon.ts` — which
 * runs in a CHILD PROCESS.** The exit hook then belongs to a process whose exit
 * code nobody reads, and Vitest's own exit code is untouched.
 * `test/architecture/embedded-postgres-isolation.test.ts` asserts that this stays
 * true; if a future change imports the package into the runner, that test fails
 * before the masking can hide anything else.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One further sharp edge, recorded so nobody pays for it twice: **do not raise
 * `log_min_messages`.** `embedded-postgres` detects readiness by matching
 * "database system is ready to accept connections" on stdout, and suppressing
 * that line makes `start()` hang forever (SPIKE-REPORT §6.8).
 */
export class TestCluster {
  #server: EmbeddedPostgres | undefined;
  #started = false;

  async start(options: { fresh?: boolean; quiet?: boolean } = {}): Promise<void> {
    const { fresh = true, quiet = true } = options;
    if (fresh) await rm(CLUSTER_DATA_DIR, { recursive: true, force: true });

    this.#server = new EmbeddedPostgres({
      databaseDir: CLUSTER_DATA_DIR,
      port: CLUSTER_PORT,
      user: HARNESS_ENV['SP_PG_SUPERUSER'] ?? 'postgres',
      password: HARNESS_ENV['SP_PG_SUPERUSER_PASSWORD'] ?? '',
      authMethod: 'scram-sha-256',
      persistent: false,
      onLog: quiet ? (): void => {} : (m: string): void => console.log(`[pg] ${m}`),
      onError: quiet ? (): void => {} : (m: unknown): void => console.error(`[pg] ${String(m)}`),
      // A small but non-trivial connection budget. The harness deliberately runs
      // tiny pools against it and must not be masked by an enormous ceiling.
      postgresFlags: ['-c', 'max_connections=60'],
    });

    await this.#server.initialise();
    await this.#server.start();
    this.#started = true;
  }

  async stop(): Promise<void> {
    if (this.#server !== undefined && this.#started) {
      await this.#server.stop();
      this.#started = false;
    }
  }
}
