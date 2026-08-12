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
  /**
   * `./provider-boundary.ts` — implemented by `apps/api/src/db/provider-boundary.ts`
   * (OPUS-M4-000C, SPEC-12 U-07). The probe the boundary decision reads: it is a
   * port because the thing that knows whether a transaction is open is an
   * `AsyncLocalStorage`, and this package imports no node builtin.
   */
  providerBoundary: 'ProviderBoundaryProbe',
  /** `./alerts.ts` — implemented by `apps/api/src/db/alerts.ts`. */
  alerts: 'AlertSink',
  /** `./job-queue.ts` — implemented by `apps/api/src/jobs/in-memory-queue.ts`. */
  jobQueue: 'JobQueue',
  /** `./principal.ts` — implemented by `apps/api/src/http/context/principal.ts`. */
  principal: 'PrincipalResolver',
  /** `../audit/port.ts` — implemented by `apps/api/src/audit/recorder.ts`. */
  auditRecorder: 'AuditRecorder',
  /** `../audit/port.ts` — implemented by `apps/api/src/outbox/publisher.ts`. */
  outboxPublisher: 'OutboxPublisher',
  /** `../audit/port.ts` — implemented by `apps/api/src/audit/checkpoint-signer.ts`. */
  checkpointSigner: 'CheckpointSigner',
} as const;

export type PortName = keyof typeof ports;
