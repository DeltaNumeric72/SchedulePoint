# Development setup

From a fresh clone to a green gate battery.

```bash
corepack enable
corepack pnpm install
corepack pnpm run e2e:install     # Chromium for the accessibility gate (~80 MB, user cache)
corepack pnpm check
```

That is the whole path. If `pnpm check` is green, the branch meets the bar.

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **24.x** | `engines` requires ≥22; CI runs 24 |
| pnpm | **11.18.0** | Via **corepack only** — see below |
| Python | 3.12+ | Only if you are working in `solver/` |

### pnpm comes from corepack. Always.

```bash
corepack enable
corepack pnpm --version   # 11.18.0
```

`packageManager` in the root `package.json` pins the version, and corepack honours it.

**Do not `npm install -g pnpm`.** On the reference machine the npm global prefix is
root-owned, so a global install needs `sudo` — and a package manager installed with
`sudo` is a package manager that runs dependency lifecycle scripts as root. Corepack
keeps the whole toolchain in the user cache.

Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` in a non-interactive shell (CI already does).

### Prefix every pnpm command with `corepack`

`corepack pnpm install`, `corepack pnpm check`. The one consequence worth knowing: inside
a script spawned by `corepack pnpm`, `pnpm` is **not** on `PATH`, so scripts never invoke
it recursively. `scripts/run-in-workspace.mjs` resolves a workspace package's local
binary directly instead, and `scripts/check.mjs` re-invokes the package manager through
`npm_execpath`. If you add a script, follow the same pattern.

---

## 2. Approving dependency build scripts

pnpm 11 refuses to run a dependency's install script until it is approved in
`pnpm-workspace.yaml` under `allowBuilds`. Exactly one is approved today:

```yaml
allowBuilds:
  esbuild: true
```

If an install prints `ERR_PNPM_IGNORED_BUILDS`, **do not** blanket-approve. An install
script is arbitrary code execution on every developer's machine; add the single entry
with a comment saying why the package needs it.

---

## 3. The gate battery

```bash
corepack pnpm check
```

**Seventeen** gates, all build-failing, in dependency order. The full transcript is
written to `scripts/check-output.txt` — or, on a plain run, to an untracked scratch path
(see §12).

| # | Gate | What it proves |
|---|---|---|
| 1 | `lint` | ESLint, including the ban on every `SET` form of a tenant setting |
| 2 | `typecheck` | `tsc -b` across every project, tests included |
| 3 | `unit` | Vitest across all five projects, against a real PostgreSQL cluster (§10) — through `scripts/gates/vitest-must-run.mjs`, which fails a run that executed **no** test |
| 4 | `import-boundary` | dependency-cruiser: `packages/domain` imports nothing |
| 5 | `route-policy` | Every registered Fastify route declares a policy (I-02) |
| 6 | `migration-rls` | No `CREATE TABLE` without RLS in the same migration (I-15) |
| 7 | `invariant-ids` | No `I-nn` defined twice or cited undefined (CAR-023) |
| 8 | `rule-node-mapping` | Every declared AST node kind has a compiler mapping (SPEC-04 §3.2) |
| 9 | `rule-kind-registry` | The committed rule-kind registry is GENERATED, not typed by hand |
| 10 | `provider-boundary` | No provider call inside a unit of work (SPEC-12 U-07) |
| 11 | `solver-kind-parity` | The model builds every HARD kind the checker evaluates |
| 12 | `secret-scan` | Eleven credential-format detectors over the whole tree |
| 13 | `raw-nul` | No raw `U+0000` in a tracked text file (FAD-45(1)) |
| 14 | `build` | `vite build` produces the production bundle |
| 15 | `network-guard` | No non-allowlisted client host, in source **or** bundle (SP-HR-1) |
| 16 | `axe` | axe-core over the shell at desktop and mobile viewports (CAP-066) |
| 17 | `request-budget` | One user action, one request (I-10 / SP-HR-2) |

Order matters in three places: `build` before `network-guard` (the guard scans the
bundle and treats a missing one as a failure), `build` before `axe` (Playwright serves
the production build), and `axe` before `request-budget` (the browser run writes the
recordings the budget gate compares).

The `raw-nul` gate carries a **known-violations baseline** pinned by path AND count. Two
entries remain, both in `docs/fable/control/**`. A baselined file is not exempt — its
count is pinned, so acquiring a second NUL fails the build, and repairing the last one
fails it too, so the list shrinks deliberately rather than rotting. Its extension
allowlist is checked against **magic bytes**, so a text file renamed `.png` is scanned
rather than skipped.

Individual gates: `corepack pnpm run gate:<id>`.

**The unit gate cannot pass by selecting nothing** (FAD-53 R-7, finding REV-B-006).
Vitest exits **0** when a `-t` / `--testNamePattern` filter matches no test: the files are
found, collected, and then every test in them is reported as skipped —
`--passWithNoTests=false` is about missing FILES and does not see this. `gate:unit` and
`gate:unit:builds` therefore run through `scripts/gates/vitest-must-run.mjs`, which reads
the executed count from Vitest's own JSON reporter and exits non-zero when it is zero. It
never softens a real failure: a non-zero child status is passed straight through. Direct
`corepack pnpm exec vitest run …` invocations (including the red-case arms that spawn one)
are **not** wrapped — they carry path filters only, and a wrong path already exits
non-zero with `No test files found`. Add the wrapper to any invocation that grows a name
filter.

### Proving the gates still work

```bash
corepack pnpm red-cases
```

**Sixty-six** cases. Each introduces a real violation into the working tree, asserts
the gate **fails**, then restores. Output goes to
`scripts/red-cases/evidence-output.txt` (or scratch — see §12).

Three properties of the runner are worth knowing before you read its table:

  * a case whose output matches an **ERRORED signature** — vitest's `No test files
    found`, or `anchor not found` — is never counted as proven, however its exit code
    read. A misspelled test path exits non-zero, so without this an arm that never ran
    reported PROVEN;
  * the revert sweeps `dist/**/__red_case__*`. Compiled artifacts survive a *successful*
    run and are invisible to `git status`, because `dist` is gitignored. After a run,
    `find packages/*/dist -name '__red_case__*'` must be empty;
  * the production bundle is built once up front, so the bundle-scanning arms never scan
    an empty `dist` on a fresh worktree.

This is not optional ceremony. A gate with a broken regex or a wrong scan path reports
PASS forever, and the first anyone hears of it is when the thing it was meant to prevent
ships.

---

## 4. Running things locally

```bash
corepack pnpm --filter @schedulepoint/api dev     # Fastify on :3001
corepack pnpm --filter @schedulepoint/web dev     # Vite on :5173
corepack pnpm run seed:dev                        # placeholder — no schema exists yet
```

The web shell calls `/api/health`. Without the API running it renders its error state,
which is a legitimate state and is what the accessibility gate exercises.

---

## 5. The local database

### `docker-compose.yml` is authored but has never been started here

It defines PostgreSQL 16, MinIO, and Mailpit. **It has not been run**: the machine this
scaffold was built on has no Docker daemon, no Homebrew and no `sudo` (FAD-7). Treat it
as unverified until someone runs `docker compose up` on a machine with a daemon and
reports back.

```bash
docker compose up -d        # on a machine that has Docker
```

### The interim local database is `embedded-postgres`

Per [`spikes/sp-a-isolation/SPIKE-REPORT.md`](../spikes/sp-a-isolation/SPIKE-REPORT.md)
§2, the tenant-isolation spike substituted `embedded-postgres` — a real PostgreSQL
server binary downloaded into the user cache and run as the current user, no daemon and
no root. That is the interim local path until Docker is available.

Two things the spike found that any local setup has to respect:

1. RLS predicates read `nullif(current_setting('app.<x>', true), '')::uuid`. `SET LOCAL`
   reverts the *value*, it does not undefine the GUC, so the setting is `NULL` **or**
   `''` (SPIKE-REPORT §6.1).
2. `embedded-postgres` hangs if you suppress its readiness log line (§6.8).

No migrations exist yet, so there is nothing to run against a database today.

### Concurrent worktrees

Two agents working in parallel never share a database instance. Use a distinct compose
project name (or a distinct embedded-postgres port) per worktree.

---

## 6. Environment variables

Copy `.env.example` to `.env` and fill in. `.env` is gitignored; `.env.example` is the
only tracked one and contains no real credential — the secret-scan gate enforces that.

Production secrets come from the secret store (TDG-13), never from a file.

---

## 7. Container images

Three, matching SPEC-10's topology. **All three are skeletons and none has been built
here** (no Docker daemon):

| File | Image | Notes |
|---|---|---|
| `Dockerfile.app` | application | Fastify API + static web bundle. Multi-stage, non-root, no baked credential |
| `Dockerfile.ingress` | ingress enclave | ADR-0021 / I-17. Raw payloads exist only here. Log format carries no body and no query string |
| `solver/Dockerfile` | solver | Python. **No database credential, no database client.** OR-Tools is deliberately absent until OPUS-M0-003 reports |

---

## 8. The solver package

```bash
cd solver
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
python -m schedulepoint_solver   # exits non-zero on purpose
```

### Running the tests that need a real solve

The platform spawns the worker as a subprocess and finds the interpreter through
`SP_SOLVER_WORKER_COMMAND`. Every suite that performs a real CP-SAT solve therefore
needs an interpreter that has OR-Tools:

```bash
SP_SOLVER_WORKER_COMMAND=/path/to/venv/bin/python3 corepack pnpm check
```

**This is the FAD-7 substitution and it is a standing CI condition, not a solved
problem.** `Dockerfile.solver` pins Python 3.12 and an exact OR-Tools version; it is
authored and **has never been built** — there is no Docker daemon in the development
environment — so no image digest exists, `reproducibilityMode` can only ever be a
statement about the *parameters*, and every measurement in this repository was taken
under whatever interpreter the variable pointed at. Re-running the suite against the
pinned 3.12 image, and recording its digest, remains outstanding.

The resolution order is documented in `apps/api/test/support/solver.ts`: an explicit
`SP_SOLVER_WORKER_COMMAND` outranks everything, and it is pinned by
`apps/api/test/solver/worker-interpreter.test.ts` — because a default that silently
overrode the deployment's own setting is a defect that already happened once.

---

## 9. Troubleshooting

**`pnpm: command not found` inside a script.** Expected under corepack. Use
`scripts/run-in-workspace.mjs` or `npm_execpath`; see §1.

**`ERR_PNPM_IGNORED_BUILDS`.** See §2.

**Playwright cannot find a browser.** `corepack pnpm run e2e:install`. The download goes
to `~/.cache/ms-playwright` and needs no root.

**`network-guard` fails with "built bundle absent".** Run `corepack pnpm run gate:build`
first. The guard treats a missing bundle as a failure rather than a skip, because a guard
that scans nothing and reports PASS is worse than no guard.

**`request-budget` fails with "no recording".** Run `corepack pnpm run gate:axe` first —
the browser run writes the recordings. Same reasoning as above.

**Port 4173 is in use.** Playwright starts its own preview server with `--strictPort` and
will not silently attach to something else. Stop the other process.

---

## 10. The tenancy harness (added by OPUS-M1-001)

`corepack pnpm check`'s **unit** gate now starts a real PostgreSQL 17 server and runs
the SPEC-01 §7.1 and §7.2 batteries against it. Nothing extra to install and nothing to
start by hand: the harness owns the cluster's whole lifecycle.

```bash
corepack pnpm check                                          # includes the tenancy harness
corepack pnpm exec vitest run --project api                  # just the harness
corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded   # up -> down -> up, captured
```

### What a run does

1. Spawns a **cluster daemon** (`apps/api/test/support/cluster-daemon.ts`) which destroys
   `apps/api/.pgdata-test-<port>` and re-initialises it, so no run inherits state. The port
   is part of the directory name deliberately: with a fixed path, a second harness on a
   different port still deleted the first one's data directory out from under it.
2. Bootstraps the five SPEC-01 §4.4 roles and the database **as superuser** — roles are
   cluster objects and `app_migrator` deliberately holds neither `CREATEROLE` nor
   `CREATEDB` nor superuser.
3. Runs the migration cycle **up → down → up**, so every test runs against a schema whose
   down migration was just proven executable.
4. Seeds the two-organization fixture **through the unit of work**, under `app_runtime`.
   If the wrapper did not work, the fixture would not exist and the suite would fail
   loudly on its first assertion.

**The port is derived from the worktree path** (see [Ports, per worktree](#ports-per-worktree)
below) and the data directory follows the port, so two worktrees never share a cluster
without anybody remembering. `SP_TEST_PG_PORT` overrides the derived value.
`SP_STORM_ITERATIONS` overrides the T-15 storm's loop count (default 120).

### ⚠ Never import `embedded-postgres` into a process whose exit code matters

`embedded-postgres` registers a graceful-shutdown hook through `async-exit-hook`, which
hooks **`beforeExit` with code 0** and calls `process.exit(0)` on a natural exit. That
**discards `process.exitCode`**:

```bash
$ node -e "import('embedded-postgres').then(() => { process.exitCode = 1 })"
$ echo $?
0
```

While the package was imported into Vitest's main process, `vitest run` printed
`1 failed | 232 passed` and **exited 0** — the `unit` gate reported PASS on a failing
suite. `corepack pnpm red-cases` caught it; that is what the command is for.

The package is therefore imported by exactly one module,
`apps/api/test/support/cluster.ts`, which is imported by exactly one module,
`cluster-daemon.ts`, which runs as a **child process**.
`apps/api/test/architecture/embedded-postgres-isolation.test.ts` asserts both facts, so a
future import cannot quietly re-introduce the masking.

### Database environment variables

Every credential comes from the environment and **there is no default** — a missing
password throws at the point of use rather than falling back to a well-known string.

| Variable | Meaning |
|---|---|
| `SP_PG_HOST` / `SP_PG_PORT` / `SP_PG_DATABASE` | Connection target |
| `SP_PG_SUPERUSER` / `SP_PG_SUPERUSER_PASSWORD` | Cluster bootstrap only. No request path reads these |
| `SP_PG_PASSWORD_APP_MIGRATOR` | Migrations only, never application traffic |
| `SP_PG_PASSWORD_APP_RUNTIME` | Web/API processes |
| `SP_PG_PASSWORD_APP_WORKER` | Background, scheduling and real-time processes |
| `SP_PG_PASSWORD_APP_READONLY_SUPPORT` | Support tooling, `SELECT` only under RLS |
| `SP_PG_PASSWORD_APP_BREAKGLASS` | Two-person emergency only |

The harness sets all of them itself, to synthetic `fixture-local-*` values, from
`apps/api/test/support/env.ts`. They are not secrets and must never be copied into
non-test code.

### Two more sharp edges

- **`node-pg-migrate` prints `Can't determine timestamp for 0001`** on every run, because
  the migration files use a sequential `0001_` prefix rather than a 13-digit timestamp.
  Ordering and up/down behaviour are correct; the warning is cosmetic. One convention has
  been picked — sequential — and it should stay picked.
- **Do not raise `log_min_messages`** for the embedded cluster. `embedded-postgres`
  detects readiness by matching *"database system is ready to accept connections"* on
  stdout, and suppressing that line makes `start()` hang forever.

### Running the API against a real database

```bash
corepack pnpm --filter @schedulepoint/api migrate:up     # needs SP_PG_* set
corepack pnpm --filter @schedulepoint/api dev
```

The process asserts **transaction affinity** before it opens its socket (SPEC-01 §4
amendment (c)) and exits if the assertion fails: a process that cannot demonstrate that a
transaction-local setting survives to the next statement has no basis for any tenant
guarantee it would otherwise make. It then serves `/health` and returns `401` from every
route needing a principal — authentication lands in a later packet, and until it does the
server fails closed rather than inventing a principal.

---

## The `btree_gist` extension (added by OPUS-M1-002)

`apps/api/migrations/0002_authorization.sql` begins with:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

**Why it is needed.** SPEC-06 P-7 requires overlapping effective-dated grant windows to
be *"prohibited by an exclusion constraint"*, and the constraint has to combine equality
on `(organization_id, membership_id, capability_key)` with range overlap on the validity
window:

```sql
EXCLUDE USING gist (
    organization_id WITH =, membership_id WITH =, capability_key WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
)
```

`gist` has no built-in operator class for `uuid`/`text` **equality**; `btree_gist`
supplies it. The same constraint shape protects `entitlements`.

**Why it does not need a superuser.** `btree_gist` is a *trusted* extension in PostgreSQL
13 and later, so the **database owner** may install it. `app_migrator` owns the database
(`bootstrap.ts` creates it `OWNER app_migrator`), and migrations run as `app_migrator` and
only as `app_migrator` (SPEC-01 §4.4) — so the migration installs it without any
privilege the role matrix does not already grant. **Verified against this cluster before
the migration was written**, because a migration that needs a superuser is a migration
that cannot run under the role matrix at all.

**If you point the API at a managed PostgreSQL** where `app_migrator` is not the database
owner, `CREATE EXTENSION` will fail with `42501`. Install `btree_gist` once, out of band,
as whatever role that platform gives you; the `IF NOT EXISTS` then makes the migration a
no-op. The `down` migration drops it, so a manually-installed extension will be removed
by a full rollback — install it again before the next `up`.

---

## The audit chain and the queue (OPUS-M1-003)

### The queue schema is NOT one of our migrations

`graphile-worker` owns its own schema and its own migration history
(`graphile_worker.migrations`). Reproducing its DDL under `apps/api/migrations` would
fork it at the first upgrade, so installing it is a **bootstrap step**, alongside
`bootstrapCluster`:

```ts
import { installQueueSchema } from './src/db/queue-schema.js';
await installQueueSchema();          // as app_migrator, idempotent
```

`test/support/global-setup.ts` calls it before seeding, so every test run has it.

### Two things about it that will otherwise cost you an afternoon

**graphile-worker enables RLS on all four of its tables and defines no policy at all**,
and its migrations contain no `GRANT`. RLS is not `FORCE`d there, so its owner bypasses it
and every other role is refused — *regardless of grants*. The dangerous half is silent:

| Role | With full table grants |
|---|---|
| `app_worker` | reads **zero rows, silently**. graphile-worker logs `No tasks found; nothing to do!` and idles forever, reporting healthy |
| `app_runtime` | `add_job` → `42501` |

`installQueueSchema` fixes both — named policies for `app_worker`, and an
`app_enqueue_job(text, json)` `SECURITY DEFINER` wrapper for `app_runtime`, which holds
**no direct grant on the queue tables**. It throws at startup if any RLS-enabled table is
left unpoliced, so the silent-idle mode cannot happen quietly.

**The lease is four hours and is not configurable.** Only the sweep interval is
(`minResetLockedInterval` / `maxResetLockedInterval`, default 8–10 min). A *graceful*
shutdown does not release the in-flight job either, so an ordinary rolling deploy would
strand every in-flight job for four hours. The mitigation is the `queue_pools` registry and
the startup+periodic reclaim in `outbox/runner.ts` — measured at **565 ms** end to end
against an unmitigated four hours. All of it is in
[`spikes/sp-d-worker/SPIKE-REPORT.md`](../spikes/sp-d-worker/SPIKE-REPORT.md).

**Write every job handler to honour `helpers.abortSignal`.** One that does not will not
exit on the first `SIGTERM` at all (measured, SP-D E-2.4b).

### What starts automatically

`apps/api/src/index.ts` installs the queue schema and starts the outbox runner
before the socket opens, and the runner carries SPEC-11 §2's two periodic jobs:

| | When |
|---|---|
| queue schema + the SP-D C-1 policies | process start |
| outbox dispatch | continuously |
| stale worker-pool reclaim | startup, then every 5 s |
| checkpoint sweep (`audit.checkpoint`) | cron `0 * * * *`, every *N* entries or at least daily |
| chain verification (`audit.verify`) | cron `30 */6 * * *`, **pages** on any discrepancy |

`SP_DISABLE_WORKER=1` runs the API without the worker, for deployments that run
workers as separate processes. It is an explicit opt-out and it logs what it
costs — a process that quietly declined to run the audit checkpointer would be
the worst of both.

### Verifying the chain

```bash
corepack pnpm --filter @schedulepoint/api exec tsx src/audit/verify-cli.ts <organization-id>
# exit 0 = intact · 1 = a problem was found · 2 = could not check
```

`1` and `2` are deliberately different: "the chain is broken" and "I could not check" must
never look the same to a monitor. Run it **after every migration and after every restore**
(SPEC-11 §3). The periodic job above is the always-on layer; the CLI is for when an
operator needs to ask directly and read an exit code.

It verifies **one organization at a time and only the session's own** — a foreign
organization id raises `restrict_violation` rather than reading as a clean chain, which is
what it would otherwise do under RLS.

To see it work end to end on a throwaway cluster, including a deliberate tamper:

```bash
npx tsx apps/api/test/support/audit-verify-demo.ts
```

> The local signer holds its key **in the process** (`keyIsIsolated === false`). A
> checkpoint verified here proves the signing path works and nothing about who could have
> produced it. SPEC-11 §6 requires a separate trust domain; real KMS is a deployment
> condition (TDG-15).

### Adding an audit event to a new mutation

One line, inside the same `runtime.run(...)` callback as the write — the organization,
group, actor and correlation id all come from `uow.context`, never from the call site:

```ts
await recordAuditEvent(uow, {
  eventName: 'grant.issued',   // add it to packages/domain/src/audit/event-names.ts first
  subjectType: 'membership',
  subjectId: targetMembershipId,
});
```

The event-name list **only grows** (rule 13). Payloads carry identifiers and tokens only:
a string value must be printable ASCII with no space, at most 64 characters, enforced by
both the domain validator and a CHECK constraint (I-07).

---

## Fixture isolation: the regression gate (FAD-15)

```bash
corepack pnpm fixture-regression          # the gate
corepack pnpm fixture-regression --quick  # seeds only, no standalone sweep
```

**What it runs.** Eleven full `api` suite runs with **both** `--sequence.shuffle.files`
and `--sequence.shuffle.tests` — ten fixed seeds plus one rotating seed drawn per run —
and then **every test file on its own**. The FAD-15 Layer 1 baseline control runs inside
all of them, so a run that writes to the shared read-only MULTI fixture fails and names
the file that did it.

**Why it is not in `pnpm check`.** 35 suite runs is the wrong cost for a per-commit gate
and the right cost for an acceptance gate. It is a **standing acceptance-time
requirement**: it runs at every task acceptance and at every milestone exit, not on every
push. (Wiring it into the gate runner would also be a gate-runner edit, which task packets
treat as an escalation.)

**What a red means.** Not a flake. NR-13 measured that a *single* shuffled run is a weak
detector — four of ten seeds found nothing against the pre-refactor suite — so a seed that
does find something has found a real order dependence.

- The rotating seed is **printed before its run**, so a failure is reproducible from the
  log alone: `--sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=<n>`.
- **A rotating-seed failure is a defect to fix, never a flake to retry.**
- Once a seed has exposed a defect it **joins the fixed set** in
  `scripts/sbx/fixture-regression.mjs` — so the gate keeps proving that fix while a fresh
  seed keeps hunting beside it.

**The rule the gate exists to hold.** The shared MULTI baseline is **read-only**. A test
that needs to write calls `ownedMulti('<slug>')`
(`apps/api/test/support/owned-multi.ts`) and works in its own tenant.

Two controls keep tenants apart, and it is worth being exact about which does what: a
**per-run slug registry** (a duplicate slug throws, naming both owners) and a **per-run
nonce** in each owned fixture's effective slug, so its ids cannot be re-derived from the
declared slug. **RLS is not the ownership control** — it keeps a tenant's rows invisible to
a *different declared context*, which is a different guarantee.

**Cleanup.** On a normal run — pass, fail, or thrown error — there is nothing to clean; the
cluster is per-run. On a **SIGKILL**, teardown does not run and the data directory
survives. The next run does not silently inherit it: it refuses to start and prints the
orphan pid, the data directory, and the recovery commands:

```bash
# <port> is THIS worktree's derived port — the message prints it, and
# `node -e "import('./scripts/sbx/test-port.mjs').then(m => console.log(m.resolveTestPgPort()))"`
# answers it from anywhere in the worktree.
lsof -nP -i:<port> -t | xargs -r kill -9
rm -rf apps/api/.pgdata-test-<port>
```

## The SBX evidence harness

```bash
corepack pnpm sbx
```

Runs the SPEC-16 scenario subset and prints the table it writes to
`docs/evidence/EV-M2-SBX/scenario-report.txt`. Every scenario declares all nine SPEC-16
contract fields — a missing or blank field makes it **not runnable** — and carries a
falsifiability probe that must fail. A scenario that cannot be made to fail is reported
**VACUOUS** and fails the run. `EVIDENCE_BLOCKED` is never a pass and never a silent skip,
and on a **gate-required** scenario it fails the run outright.

## Ports, per worktree

**Added by OPUS-M2-004 from findings E-1 and E-2, both measured while two agents ran in
parallel worktrees.**

Two ports decide whether two worktrees can run their batteries at the same time. Until
this change, one of them had a default nobody set and the other had no override at all.

| Port | Variable | Default | What holds it |
|---|---|---|---|
| embedded PostgreSQL | `SP_TEST_PG_PORT` | **derived from the worktree path**, in `55500..55899` | `pnpm check`, `pnpm sbx`, `pnpm fixture-regression`, `pnpm red-cases`, any `vitest --project api` run |
| Vite preview (Playwright) | `SP_TEST_PREVIEW_PORT` | `4173` | the `axe` gate (`pnpm gate:axe`), `pnpm --filter @schedulepoint/web preview` |

### The database port is derived, not defaulted

`apps/api/test/support/env.ts` used to read `SP_TEST_PG_PORT ?? 55433`, and its comment
said the override existed so two worktrees could each set it. **Nothing set it.** Two
worktrees therefore derived the same port *and* the same data directory — the directory
name follows the port — and each agent's suite destroyed the other's cluster. It presents
as the runbook's contention signature: whole test *files* failing, tests *skipped*, and
**zero tests failed**.

The default is now `55500 + (sha256 of the worktree root, mod 400)`, so "each agent gets
its own worktree" implies its own database. The band is deliberately above every port this
repository has ever named — the SP-A spike's `55432`, the old default `55433`, and every
port pinned in an evidence capture — so a derived port cannot collide with a documented
fixed one.

Ask for this worktree's port:

```bash
node -e "import('./scripts/sbx/test-port.mjs').then(m => console.log(m.resolveTestPgPort()))"
```

`SP_TEST_PG_PORT` still wins when set — the red-case harness spawns a deliberate second
cluster on a port of its own, and the NR-13 benchmarks pin theirs. A malformed value
throws rather than falling back to the derived one.

The derivation exists twice — `scripts/sbx/test-port.mjs` (JavaScript, because `scripts/`
is outside every TypeScript project here) and `apps/api/test/support/env.ts` (TypeScript,
because the harness cannot import from `scripts/`). They are not trusted to stay equal:
`apps/api/test/architecture/derived-test-port.test.ts` executes the JavaScript module in a
child process and fails if the two disagree.

### The preview port is overridable, and still defaults to 4173

`apps/web/playwright.config.ts` hard-coded `vite preview --port 4173 --strictPort` with
`reuseExistingServer: false`, so two concurrent worktrees could not both run the `axe`
gate. `SP_TEST_PREVIEW_PORT` now moves it.

The default is **still 4173**, and unlike the database port it is not derived. The
difference is the failure mode, not the inconvenience. A database-port collision was
silent and destructive — two worktrees shared a port *and* a data directory, and each
suite destroyed the other's cluster while reporting zero failed tests. A preview-port
collision is loud and harmless: `--strictPort` refuses to start and names the port. An
override is the proportionate fix; a concurrent agent sets the variable, and a solo run
is unchanged.

```bash
SP_TEST_PREVIEW_PORT=4273 corepack pnpm check      # the second worktree
```

### Port hygiene, extended to the preview server

The runbook's standing discipline — finish with no background run still holding a cluster
— applies to `vite preview` too. While diagnosing E-2, a preview server from a worktree
**deleted two days earlier** was still holding 4173. Both are worth checking before
concluding anything about a failing run:

```bash
lsof -nP -i:4173 -t                              # who holds the preview port
node -e "import('./scripts/sbx/test-port.mjs').then(m => console.log(m.resolveTestPgPort()))"
lsof -nP -i:<that port> -t                       # who holds this worktree's cluster
```

### `pnpm red-cases` waits for the cluster port

Running `pnpm red-cases` immediately after `pnpm check` used to race the previous run's
shutdown: the `unit` case's **GREEN arm** starts the cluster, the port was still held for a
moment, and the arm failed — reporting a broken gate when nothing was broken. The runner
now waits for the port to be released first (up to 30s). It **waits rather than retries**:
retrying the gate would mask a genuine GREEN failure, which is the one thing that runner
exists to detect. If the budget runs out it continues anyway and says so, so a genuinely
stuck cluster surfaces as a failure rather than as a hang.

### Migration `0011` may be **recorded but not applied** in a long-lived dev database

If you have a development database that ran migrations between the merge of
`0011_period_length_and_audit_scope.sql` and its fix, that migration is recorded in
`pgmigrations` while having executed **nothing**. The file shipped without an
`-- Up Migration` marker, so `node-pg-migrate` took the up section to be empty, applied it
successfully, and wrote the row. There is no error and no warning: the migration table says
the schema is current, and it is not.

Two things are missing in such a database:

- the `schedule_periods_length` CHECK — so a period longer than 366 days is refused by the
  contract and accepted by the table;
- `app_verify_audit_chain`'s group-scope guard — so a group-scoped call walks a subset of
  the chain and reports gaps that are not there (the N-8 false alarm).

The test harness is unaffected: it destroys and recreates its cluster on every run and runs
the full cycle, which is why this surfaced as a test failing to be *rejected* rather than as
a broken schema. **Only a long-lived database is at risk.** Check and repair with:

```bash
# does the guard exist?
psql -c "select pg_get_functiondef(oid) ~ 'v_session_group' as has_guard
           from pg_proc where proname = 'app_verify_audit_chain'"
# does the CHECK exist?
psql -c "select count(*) from pg_constraint where conname = 'schedule_periods_length'"
```

If either answers `false` / `0`, re-apply the migration by hand: `node-pg-migrate` will not
re-run a migration it has already recorded, so take `0011`'s up section down to `-- Down
Migration` and execute it as `app_migrator`. Both statements are idempotent in effect —
`CREATE OR REPLACE FUNCTION` and an `ADD CONSTRAINT` that fails loudly if it is already
there. A throwaway development database is quicker to recreate than to repair.

---

## 12. Where evidence goes, and the acceptance batteries (current state)

**A plain run leaves the working tree clean.** Every evidence writer resolves its
destination through `scripts/evidence-target.mjs`: without `--refresh` it writes to the
untracked `.evidence-scratch/`; with `--refresh` (or `SP_EVIDENCE_REFRESH=1`) it writes
the tracked path. That is the NR-14 redesign, and it is red-cased by breaking the
redirect.

**Do not set `SP_EVIDENCE_REFRESH=1` casually.** A refresh run rewrites *every* tracked
evidence artifact it can produce, including 151 screenshots belonging to accepted
bundles. Regenerate a specific artifact deliberately, and assert that the others came
back byte-identical.

`pnpm check` is the per-commit bar. Four batteries are **acceptance-time** and are run
explicitly, serially, one at a time on a quiet machine:

```bash
corepack pnpm check               # the seventeen gates
corepack pnpm red-cases           # 67 cases, both directions
corepack pnpm fixture-regression  # FAD-15: 13 fixed seeds + a rotating one + every file alone
corepack pnpm sbx                 # the SPEC-16 sandbox scenarios under their contracts
```

Serial, and the word is load-bearing: two batteries at once share one embedded-postgres
port and one machine, and a run taken beside another run is a run nobody can interpret.
Check `uptime` first — a 1-minute load average above ~6 has produced three different
false failures in this repository's history, each of which cost more to diagnose than
waiting cost.

**`fixture-regression` retains the FULL output of any failing run** under
`.evidence-scratch/fixture-regression/` and prints the path (NR-15). The summary lines in
the console are a convenience; the capture is the evidence. Diagnose from it.

---

## 13. What the current tree does and does not do

Stated because a reader arriving at the repository will otherwise infer it from the
volume of code, and the inference would be wrong.

**It does:** author, revise and publish schedules through a versioned, immutable
publication path; compile a typed rule AST and evaluate every M4-evaluable HARD kind
independently of the solver; assemble one immutable canonical input snapshot per build;
run a real CP-SAT solve in a separate Python subprocess that holds no database
credential; validate the candidate independently; carry a build through a sixteen-state
server-authoritative lifecycle with claim fencing and a reaper; and write a selected
candidate into a NEW draft version, which then flows the ordinary review path.

**It does not:** claim any performance or quality band — SPEC-04 §7 leaves every band
except `hard_violations = 0` undefined until the benchmark corpus is run, and that is
M6; assert anything about the pinned solver image, which has never been built; or make
any production-readiness or compliance claim of any kind. The required legal and
operational work is explicitly not done ([14](architecture/14-security-and-privacy.md)
§11).
