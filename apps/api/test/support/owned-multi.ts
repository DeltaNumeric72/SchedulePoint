import type { TenantContext } from '@schedulepoint/domain';
import { afterAll, beforeAll } from 'vitest';

import { ProcessAlertSink } from '../../src/db/alerts.js';
import { createPool } from '../../src/db/pool.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { administratorContext } from './fixtures.js';
import {
  RUN_NONCE,
  provisionMulti,
  registerSlug,
  type MultiFixture,
  type MultiProfile,
  type MultiSeedOptions,
  type SeededCatalogue,
  type SeededStaffingRows,
} from './multi.js';

/* ────────────────────────────────────────────────────────────────────────────
 * FAD-15 Layer 2 — a test file that writes owns its tenant.
 *
 * ## How a file uses it
 *
 *     const multi = ownedMulti('chain');
 *     ...
 *     it('...', async () => {
 *       await runner.run(groupContext(multi().alpha.organizationId, ...), ...);
 *     });
 *
 * `ownedMulti` registers the `beforeAll` itself, so adopting it is one line at
 * the top of the file plus `FIXTURE.` becoming `multi().`. The accessor is a
 * FUNCTION rather than a value because the fixture does not exist at module
 * evaluation time — and a file that dereferences it too early gets a named
 * error rather than `undefined` three frames deeper.
 *
 * ## Ownership and cleanup
 *
 *  - **Ownership, and exactly what enforces it.** `multi.ts` owns the *content*
 *    of a fixture; the calling file owns the *instance* it provisions. Two
 *    controls keep them apart: a **per-run slug registry** (a duplicate slug
 *    throws, naming both owners) and a **per-run nonce mixed into every minted
 *    id**, so a file cannot re-derive a sibling's identifiers from its slug.
 *
 *    **RLS is NOT what enforces ownership**, and an earlier version of this
 *    comment claimed it was. An independent review disproved it by deriving a
 *    sibling's ids from its slug and writing into that tenant: RLS scopes a
 *    connection to the context it DECLARES, it does not decide which context a
 *    caller may declare. RLS is what keeps a tenant's rows invisible to a
 *    DIFFERENT declared context — proven at 24 concurrent tenants with zero
 *    wrong-tenant rows (`docs/evidence/EV-M2-NR13/owned-tenant-prototype.txt`) —
 *    and that is a different guarantee from ownership.
 *  - **Cleanup, stated precisely.** On a NORMAL run — pass, fail, or thrown
 *    error — there is nothing to clean: the cluster is created and destroyed per
 *    run and no state outlives it. On a **SIGKILL**, teardown does not run and
 *    the data directory survives; the NEXT run does not inherit it silently —
 *    it fails to start and says which process and directory to clear
 *    (`cluster-process.ts`). So: no contamination in either case, and no
 *    silent contamination in the second. The pools ARE closed below, because a
 *    leaked pool holds connections.
 *
 * ## Why not one shared fixture, as before
 *
 * NR-13, measured: six tests across five files read state a sibling had
 * established, and eleven of twenty-four files modified rows the shared seed had
 * created. FAD-15.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface OwnedMultiOptions {
  /** `full` adds every SPEC-06 role, the suspended/invited cases and the entitlement-off organization. */
  readonly profile?: MultiProfile;
  /**
   * Optional feature rows `provisionMulti` should write into this fixture.
   *
   * Since the D-1 ruling the catalogue and staffing seeding lives in `multi.ts`,
   * the single fixture owner, and a file that needs those rows **declares** them
   * here instead of calling a seeding function of its own after the fact. The
   * fixture is therefore complete when `beforeAll` returns, which is what makes
   * "the provisioning script is the single fixture owner" true rather than
   * aspirational.
   */
  readonly seed?: MultiSeedOptions;
}

/**
 * The accessor a file holds.
 *
 * Callable for the fixture itself, and carrying `administrator()` so a converted
 * file does not have to thread its own fixture through every
 * `administratorContext` call — which was the one part of the conversion that
 * was not a textual substitution.
 */
export interface OwnedMulti {
  (): MultiFixture;
  /** An organization-scoped context acting as THIS fixture's administrator for that organization. */
  administrator(organizationId: string, correlationId?: string): TenantContext;
  /**
   * The catalogue rows this fixture was provisioned with.
   *
   * Throws — naming the option that was not passed — rather than returning
   * `undefined` for a file that forgot to declare `seed.catalogue`. An
   * `undefined` three frames deeper is how a test comes to assert against
   * nothing.
   */
  catalogue(which?: 'alpha' | 'beta'): SeededCatalogue;
  /** The staffing rows this fixture was provisioned with. Throws if none were asked for. */
  staffing(): SeededStaffingRows;
}

/**
 * Provisions one MULTI fixture for the calling test file and returns an accessor
 * for it. Registers its own `beforeAll` and `afterAll`.
 *
 * `slug` must be unique within the run — the file's own name is the obvious
 * choice, and it is what appears in the fixture's synthetic email addresses, so
 * a stray row is traceable to the file that wrote it.
 */
export function ownedMulti(slug: string, options: OwnedMultiOptions = {}): OwnedMulti {
  // Claimed at module evaluation, before any test runs, so a duplicate fails
  // immediately and names both owners rather than surfacing as a mystery later.
  registerSlug(slug, 'a test file');

  // The slug actually provisioned under. The declared slug is what a reader and
  // the duplicate registry see; the nonce is what stops another file deriving
  // this fixture's identifiers from that declared slug.
  const effectiveSlug = `${slug}-${RUN_NONCE.slice(0, 8)}`;

  let fixture: MultiFixture | undefined;
  const disposers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    const runtimePool = createPool('app_runtime', { max: 4, allowExitOnIdle: true });
    const workerPool = createPool('app_worker', { max: 2, allowExitOnIdle: true });
    disposers.push(
      () => runtimePool.end(),
      () => workerPool.end(),
    );

    const alerts = new ProcessAlertSink({ write: () => {} });
    const runtime = new PgUnitOfWorkRunner({ role: 'app_runtime', pool: runtimePool, alerts });
    const worker = new PgUnitOfWorkRunner({ role: 'app_worker', pool: workerPool, alerts });

    fixture = await provisionMulti(
      runtime,
      worker,
      effectiveSlug,
      options.profile ?? 'core',
      options.seed ?? {},
    );
  }, 240_000);

  afterAll(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  const accessor = (): MultiFixture => {
    if (fixture === undefined) {
      throw new Error(
        `owned MULTI fixture "${slug}" was read before its beforeAll ran. ` +
          'Dereference it inside a test or a hook, never at module scope.',
      );
    }
    return fixture;
  };

  return Object.assign(accessor, {
    administrator: (organizationId: string, correlationId?: string): TenantContext =>
      administratorContext(organizationId, correlationId ?? 'fixture-administration', accessor()),

    catalogue: (which: 'alpha' | 'beta' = 'alpha'): SeededCatalogue => {
      const seeded = accessor().catalogue?.[which];
      if (seeded === undefined) {
        throw new Error(
          `owned MULTI fixture "${slug}" holds no catalogue rows for ${which}. ` +
            `Declare them: ownedMulti('${slug}', { seed: { catalogue: ['${which}'] } }).`,
        );
      }
      return seeded;
    },

    staffing: (): SeededStaffingRows => {
      const seeded = accessor().staffing;
      if (seeded === undefined) {
        throw new Error(
          `owned MULTI fixture "${slug}" holds no staffing rows. ` +
            `Declare them: ownedMulti('${slug}', { seed: { staffing: true } }).`,
        );
      }
      return seeded;
    },
  });
}
