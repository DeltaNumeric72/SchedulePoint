import type { TenantContext } from '@schedulepoint/domain';
import { sql } from 'kysely';

import type { PgUnitOfWorkRunner } from '../db/unit-of-work.js';

/**
 * Where a dispatched outbox event actually goes, and where exactly-once lives.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## NOTHING LEAVES THE MACHINE. THAT IS A REQUIREMENT, NOT A STAGE OF WORK.
 *
 * The safety rules are unambiguous: **no test may send a notification to a real
 * person**, and **the client talks to no third party** (CAP-068 / T-23). Real
 * providers are TDG-06 and are procurement-reserved; they arrive behind
 * SPEC-07's ports with a registered processor, a declared payload schema,
 * residency and retention.
 *
 * There is **no HTTP client, no SMTP client and no socket** in this file or
 * anywhere it imports, and `apps/api/test/audit/outbox-dispatch.test.ts` asserts
 * that the module graph reachable from the dispatcher contains no
 * outbound-network module.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## Deduplication is DURABLE, because the alternative was measured to fail
 *
 * The first version of this file deduplicated in a `Map` inside the delivering
 * process. That is worth nothing across a restart and nothing across two
 * workers, and the second review measured both failures:
 *
 * | Window | What happened |
 * |---|---|
 * | two dispatchers, same event | **both delivered** |
 * | crash **after** the effect, before the dispatched mark | **the replacement delivered again** |
 *
 * graphile-worker is **at-least-once** (SP-D §6) — it re-runs a job whose effect
 * already happened, by design — so the deduplication has to be as durable as the
 * effect. `outbox_effects` carries the idempotency key as its **primary key**,
 * and applying an effect *is* inserting the row: a duplicate is a constraint
 * violation rather than an argument.
 *
 * ## The honest limit
 *
 * For an effect that lives in this database, the row and the effect are the same
 * object, so exactly-once is real. For a real external provider they are not,
 * and no database can make them one. The best available shape there is: commit
 * the key **before** calling the provider, and require the provider to honour an
 * idempotency key of its own. Recorded in `docs/evidence/EV-M1-AUDIT/INDEX.md`
 * §5 rather than implied away here.
 */

export interface OutboxDelivery {
  readonly organizationId: string;
  /** The group the originating mutation ran under, or `null`. */
  readonly groupId: string | null;
  readonly outboxEventId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly attempt: number;
}

export interface OutboxSink {
  /**
   * @returns `true` when this delivery was new, `false` when the idempotency key
   *          had already been delivered. Never throws for a duplicate — a
   *          duplicate is the expected consequence of at-least-once, not a fault.
   */
  deliver(delivery: OutboxDelivery): Promise<boolean>;
}

function contextFor(delivery: OutboxDelivery): TenantContext {
  return {
    organizationId: delivery.organizationId,
    // The same tenant tuple the originating mutation and its audit row used, so
    // the effect row lands in the partition the RLS policies expect.
    groupId: delivery.groupId,
    membershipId: null,
    correlationId: delivery.correlationId,
  };
}

/**
 * The production sink: the effect is a row, and the row is the effect.
 *
 * It opens a unit of work **of its own**, outside the transaction that committed
 * the domain change and outside the one that marks the outbox row. That is I-11
 * holding structurally: by the time this runs the writing transaction is over
 * and this process holds no handle to it, so nothing here can roll it back.
 */
export class DatabaseOutboxSink implements OutboxSink {
  readonly #worker: PgUnitOfWorkRunner;
  readonly #observed: OutboxDelivery[] = [];
  readonly #suppressed: OutboxDelivery[] = [];

  constructor(worker: PgUnitOfWorkRunner) {
    this.#worker = worker;
  }

  async deliver(delivery: OutboxDelivery): Promise<boolean> {
    const inserted = await this.#worker.run(contextFor(delivery), async ({ query }) => {
      const result = await sql<{ idempotency_key: string }>`
        insert into outbox_effects (
          organization_id, idempotency_key, group_id, outbox_event_id, kind,
          correlation_id, attempt
        ) values (
          ${delivery.organizationId}::uuid,
          ${delivery.idempotencyKey},
          ${delivery.groupId}::uuid,
          ${delivery.outboxEventId}::uuid,
          ${delivery.kind},
          ${delivery.correlationId},
          ${delivery.attempt}
        )
        on conflict (organization_id, idempotency_key) do nothing
        returning idempotency_key
      `.execute(query);
      return result.rows.length === 1;
    });

    // Observation only. The DEDUPLICATION is the primary key above; these arrays
    // exist so a test can say what this process saw, and are deliberately not
    // consulted by `deliver` — a reader must not be able to mistake them for the
    // mechanism, because that mistake is the defect this class replaced.
    if (inserted) this.#observed.push(delivery);
    else this.#suppressed.push(delivery);
    return inserted;
  }

  /** What THIS process delivered. Not the system's record — `outbox_effects` is. */
  get deliveries(): readonly OutboxDelivery[] {
    return this.#observed;
  }

  /** Redeliveries the primary key suppressed. Non-empty is normal. */
  get suppressed(): readonly OutboxDelivery[] {
    return this.#suppressed;
  }

  clear(): void {
    this.#observed.length = 0;
    this.#suppressed.length = 0;
  }
}

/**
 * A sink that always fails — the I-11 instrument.
 *
 * I-11 says a notification failure never rolls back a domain change. The only
 * way to assert that is to have a delivery that genuinely fails **after** the
 * domain transaction has committed, and then to look at the domain row. This is
 * that failure, and it is deliberately not configurable to fail "sometimes":
 * a flaky instrument produces a flaky proof.
 */
export class AlwaysFailingSink implements OutboxSink {
  readonly attempts: OutboxDelivery[] = [];

  deliver(delivery: OutboxDelivery): Promise<boolean> {
    this.attempts.push(delivery);
    return Promise.reject(
      new Error('SINK_UNAVAILABLE: synthetic delivery failure (I-11 instrument)'),
    );
  }
}
