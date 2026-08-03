import { recordAuditEvent } from '../audit/recorder.js';
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
  // OPUS-M1-004: the SAME SPEC-06 action the HTTP route declares, evaluated by
  // the SAME truth table (FAD-13 item 1). The provisional role allow-list this
  // replaced could not see entitlements, module availability or grants.
  //
  // `apps/api/test/jobs/job-context.test.ts`, describe block "SPEC-06 §7 — one
  // evaluator, every path", compares this declaration against the route's own
  // `GROUP_SCOPED_CONFIG` object rather than against a copy of its contents, so
  // the two surfaces cannot drift.
  policy: {
    capability: 'CAP-003',
    actionScope: 'group',
    action: {
      key: 'membership.touch_self',
      moduleKey: 'core_scheduling',
      requiresObjectPolicy: false,
    },
  },
  run: async (uow, _job, membership) => {
    await uow.query
      .updateTable('memberships')
      .set({ last_active_at: new Date(), updated_at: new Date() })
      .where('id', '=', membership.id)
      .execute();

    // OPUS-M1-003 — the same one line as the HTTP surface, inside the same unit
    // of work as the mutation and the authorization re-evaluation (FAD-12). The
    // two surfaces emit the SAME event name against the SAME subject, which is
    // what lets `apps/api/test/audit/emission-coverage.test.ts` assert that a
    // mutation is audited identically however it is reached (SPEC-06 §7).
    await recordAuditEvent(uow, {
      eventName: 'membership.activity_touched',
      subjectType: 'membership',
      subjectId: membership.id,
    });
  },
};

export function defaultJobHandlers(): ReadonlyMap<string, JobHandler> {
  return new Map([[contextProbeTouchHandler.kind, contextProbeTouchHandler]]);
}
