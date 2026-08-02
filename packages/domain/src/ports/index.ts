/**
 * Port registry.
 *
 * The domain declares ports; infrastructure implements them. The registry is a
 * runtime value so the set of declared ports is enumerable in a test — a port
 * that exists as a type but has no implementation anywhere is invisible
 * otherwise.
 */
export const ports = {
  /** `./unit-of-work.ts` — implemented by `apps/api/src/db/unit-of-work.ts`. */
  unitOfWork: 'UnitOfWorkRunner',
  /** `./alerts.ts` — implemented by `apps/api/src/db/alerts.ts`. */
  alerts: 'AlertSink',
  /** `./job-queue.ts` — implemented by `apps/api/src/jobs/in-memory-queue.ts`. */
  jobQueue: 'JobQueue',
  /** `./principal.ts` — implemented by `apps/api/src/http/context/principal.ts`. */
  principal: 'PrincipalResolver',
} as const;

export type PortName = keyof typeof ports;
