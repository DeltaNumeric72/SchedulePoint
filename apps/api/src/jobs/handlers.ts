import type { JobHandler } from './worker.js';

/**
 * The job handlers this milestone registers.
 *
 * Exactly one, and it does exactly what the HTTP mutation surface does — touch
 * the acting membership's `last_active_at`. That is deliberate: SPEC-01 §7.1
 * T-03 requires "identical behaviour on every surface", and the cheapest way to
 * make that assertion meaningful is for the two surfaces to perform the *same*
 * mutation, so a difference in outcome can only come from a difference in the
 * context path.
 */

export const CONTEXT_PROBE_TOUCH_JOB = 'context-probe.touch';

export const contextProbeTouchHandler: JobHandler = {
  kind: CONTEXT_PROBE_TOUCH_JOB,
  policy: {
    capability: 'CAP-003',
    actionScope: 'group',
    // The same list the HTTP route declares. If the two ever diverge, one
    // surface authorizes differently from another, which SPEC-06 §7 calls a
    // defect — `apps/api/test/jobs/job-context.test.ts`, describe block
    // "SPEC-06 §7 — the two surfaces authorize identically", compares this list
    // against the route's own `GROUP_SCOPED_CONFIG.provisional.allowRoles`
    // object rather than against a copy of it.
    allowRoles: ['scheduler', 'group_admin'],
    rationale:
      'Provisional, pending the SPEC-06 evaluator: the same roles the HTTP context-probe ' +
      'mutation permits, so the two surfaces cannot disagree.',
  },
  run: async (uow, _job, membership) => {
    await uow.query
      .updateTable('memberships')
      .set({ last_active_at: new Date(), updated_at: new Date() })
      .where('id', '=', membership.id)
      .execute();
  },
};

export function defaultJobHandlers(): ReadonlyMap<string, JobHandler> {
  return new Map([[contextProbeTouchHandler.kind, contextProbeTouchHandler]]);
}
