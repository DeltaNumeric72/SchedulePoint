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
