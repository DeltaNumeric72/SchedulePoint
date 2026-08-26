# Migrations

Plain versioned SQL files, run by `node-pg-migrate` under the migration role (TDG-02).

**What lives here.** `0001`..`0022` — the tenancy core through the request aggregate and
the vacation carriers. Files are numbered with a zero-padded four-digit sequence and a
`snake_case` description; the number is allocated once and **never reused or
renumbered** (CLAUDE.md rule 13 — a stable ID that silently changes meaning corrupts
every document citing it), so a gap, if one is ever left, stays a gap.

**At M0 this directory was empty by design** — OPUS-M0-002 shipped no migrations; the
directory existed so the migration+RLS pairing gate
(`scripts/gates/migration-rls-check.mjs`) had a real target from the first commit rather
than being switched on later. Migrations began at M1 and the gate has guarded every one
of them since.

**Cycle discipline.** Every migration is reversible and is exercised as a cycle:
`test/support/migrate-cycle-cli.ts` runs `up → down → up → down → up` over the whole
sequence against an **empty** database, proving the schema cycle. A migration that
carries data-shape risk additionally gets a **populated**-cycle test — one that seeds
rows first and asserts what survives the round trip. Eight exist today (`0014`, `0016`,
`0017`, `0018`, `0019`, `0020`, `0021`, `0022`); the two cycles are separate claims and
are not to be described as one (FAD-53, finding REV-A-002).

`0021` and `0022` are ONE design split across two files for dependency order —
`vacation_selections` is the sixth subtype table and cannot be created before the period
and grant it references. Each still gets its own populated cycle, and 0022's
additionally asserts that the function body 0021 created and 0022 WIDENS
(`app_guard_request_subtype_row`) comes back widened after the round trip: a re-up that
restored the narrower body would leave every row census identical.

Every file that creates a tenant table must, **in the same file**:

1. `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;`
2. `ALTER TABLE <t> FORCE ROW LEVEL SECURITY;`
3. at least one `CREATE POLICY ... ON <t>`

The gate fails the build otherwise. See `scripts/gates/migration-rls-check.mjs` for the
exact rule and `scripts/gates/__fixtures__/migrations/` for green and red examples.
