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

Twelve gates, all build-failing, in dependency order. The full transcript is written to
`scripts/check-output.txt`.

| # | Gate | What it proves |
|---|---|---|
| 1 | `lint` | ESLint, including the ban on every `SET` form of a tenant setting |
| 2 | `typecheck` | `tsc -b` across every project, tests included |
| 3 | `unit` | Vitest across all five projects |
| 4 | `import-boundary` | dependency-cruiser: `packages/domain` imports nothing |
| 5 | `route-policy` | Every registered Fastify route declares a policy (I-02) |
| 6 | `migration-rls` | No `CREATE TABLE` without RLS in the same migration (I-15) |
| 7 | `invariant-ids` | No `I-nn` defined twice or cited undefined (CAR-023) |
| 8 | `secret-scan` | Eleven credential-format detectors over the whole tree |
| 9 | `build` | `vite build` produces the production bundle |
| 10 | `network-guard` | No non-allowlisted client host, in source **or** bundle (SP-HR-1) |
| 11 | `axe` | axe-core over the shell at desktop and mobile viewports (CAP-066) |
| 12 | `request-budget` | One user action, one request (I-10 / SP-HR-2) |

Order matters in three places: `build` before `network-guard` (the guard scans the
bundle and treats a missing one as a failure), `build` before `axe` (Playwright serves
the production build), and `axe` before `request-budget` (the browser run writes the
recordings the budget gate compares).

Individual gates: `corepack pnpm run gate:<id>`.

### Proving the gates still work

```bash
corepack pnpm red-cases
```

Fourteen cases. Each introduces a real violation into the working tree, asserts the gate
**fails**, then restores. Output goes to `scripts/red-cases/evidence-output.txt`.

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

`solver/` is a skeleton with an empty dependency list. See
[`solver/README.md`](../solver/README.md) for why OR-Tools is not there yet.

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

Set `SP_TEST_PG_PORT` to move the cluster off `55433` (the data directory follows the port) — required when two worktrees run
at once, because concurrent agents never share a database instance (execution standards
§E). `SP_STORM_ITERATIONS` overrides the T-15 storm's loop count (default 120).

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
