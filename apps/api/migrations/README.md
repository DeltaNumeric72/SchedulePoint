# Migrations

Plain versioned SQL files, run by `node-pg-migrate` under the migration role (TDG-02).

**Empty by design.** OPUS-M0-002 ships no migrations; the directory exists so the
migration+RLS pairing gate (`scripts/gates/migration-rls-check.mjs`) has a real target
from the first commit rather than being switched on later.

Every file that creates a tenant table must, **in the same file**:

1. `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;`
2. `ALTER TABLE <t> FORCE ROW LEVEL SECURITY;`
3. at least one `CREATE POLICY ... ON <t>`

The gate fails the build otherwise. See `scripts/gates/migration-rls-check.mjs` for the
exact rule and `scripts/gates/__fixtures__/migrations/` for green and red examples.
