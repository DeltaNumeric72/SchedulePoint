import { randomUUID } from 'node:crypto';

import type { EnqueuedJob, FrozenJobContext, JobQueue } from '@schedulepoint/domain';

/**
 * The job-enqueue **stub** SPEC-01 §7.1 T-03 needs, and nothing more.
 *
 * The durable queue — the outbox, `graphile-worker`, leases, crash recovery — is
 * OPUS-M1-003. What is in scope here is the half SPEC-01 owns: **the context
 * frozen at enqueue, and the re-evaluation at execution.** Building that on the
 * real queue later is a change of storage, not a change of contract, and doing
 * it now on an in-memory list means the context path is proven before anything
 * depends on it.
 *
 * What this deliberately does NOT do, so that nobody mistakes it for the real
 * thing: it is not durable, not transactional with the domain change, has no
 * lease, no retry and no dead-letter. A process restart loses every job. It is
 * a list.
 */
export class InMemoryJobQueue implements JobQueue {
  readonly #jobs: EnqueuedJob[] = [];

  enqueue(
    kind: string,
    context: FrozenJobContext,
    args: Readonly<Record<string, string>>,
  ): Promise<EnqueuedJob> {
    const job: EnqueuedJob = {
      id: randomUUID(),
      kind,
      // Frozen by copy, not by reference. A later mutation of the caller's
      // context object must not retarget an already-enqueued job.
      context: { ...context },
      args: { ...args },
      enqueuedAt: new Date().toISOString(),
    };
    this.#jobs.push(job);
    return Promise.resolve(job);
  }

  /** Every job enqueued, oldest first. */
  get jobs(): readonly EnqueuedJob[] {
    return this.#jobs;
  }

  /** Removes and returns the oldest job, or `undefined`. */
  take(): EnqueuedJob | undefined {
    return this.#jobs.shift();
  }

  clear(): void {
    this.#jobs.length = 0;
  }
}
