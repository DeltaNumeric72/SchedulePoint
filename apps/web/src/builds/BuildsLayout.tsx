import { Link } from '@tanstack/react-router';
import type {
  BuildRunStateWire,
  ConflictClassWire,
  ExplanationStateWire,
} from '@schedulepoint/contracts';
import type { JSX, ReactNode } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';

/**
 * The frame every build surface sits in (OPUS-M4-003).
 *
 * ## Why this is not `ScheduleLayout`
 *
 * The authoring frame says "manual authoring is for override, recovery and fixed
 * assignments" — and it is right to. This frame carries the other half of I-05,
 * which is the sentence a scheduler most needs on this screen: **a build is how a
 * schedule is produced, and it never publishes anything.** Reusing the authoring
 * chrome would make `aria-current` lie about where the user is and would put the
 * production mechanism inside a section labelled for overrides.
 *
 * ## Navigation uses ROUTER links (M3-005 N4)
 *
 * A plain `<a href>` is a full document navigation: the SPA is torn down and
 * rebuilt and every cached query is discarded, which is an amplification an
 * accessible-looking anchor hides (I-10). The skip link stays an `<a href="#main">`
 * because it is a same-document fragment link.
 */

export function BuildsLayout({
  title,
  description,
  periodId,
  children,
}: {
  title: string;
  description: string;
  periodId: string | null;
  children: ReactNode;
}): JSX.Element {
  const scope = useGroupScope();

  return (
    <>
      <a
        href="#main"
        className="sr-only rounded-control bg-accent px-sp-4 py-sp-2 text-accent-contrast focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:inline-flex focus:min-h-target focus:min-w-target focus:items-center"
      >
        Skip to main content
      </a>

      <div className="mx-auto flex min-h-screen w-full min-w-0 max-w-6xl flex-col gap-sp-5 p-sp-4">
        <header>
          <p className="text-sm font-medium uppercase tracking-wide text-text-muted">
            SchedulePoint · Builds
          </p>
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <p className="mt-sp-2 text-text-muted">{description}</p>
          {/* I-05 and I-18, on the screen and not only in a comment. */}
          <p className="mt-sp-2 text-sm text-text-muted" data-testid="builds-scope-note">
            A build proposes a schedule; it never publishes one. Selecting a candidate writes it
            into a new draft version, which then goes through the usual review and publication.
          </p>
        </header>

        <nav aria-label="Build sections">
          <ul className="flex flex-wrap gap-sp-2">
            {periodId === null ? null : (
              <li>
                <Link
                  activeProps={{ 'aria-current': 'page', className: 'border-accent text-accent' }}
                  className="inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text"
                  params={{
                    organizationId: scope.organizationId,
                    groupId: scope.groupId,
                    periodId,
                  }}
                  to="/organizations/$organizationId/groups/$groupId/builds/periods/$periodId"
                >
                  Builds for this period
                </Link>
              </li>
            )}
            <li>
              <Link
                className="inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text"
                params={{ organizationId: scope.organizationId, groupId: scope.groupId }}
                to="/organizations/$organizationId/groups/$groupId/schedule/periods"
              >
                Periods and drafts
              </Link>
            </li>
          </ul>
        </nav>

        <main className="flex min-w-0 flex-col gap-sp-4" id="main">
          {children}
        </main>

        <footer className="mt-auto text-sm text-text-muted">
          <p>Synthetic environment. No real staff, patient, or customer data exists here.</p>
        </footer>
      </div>
    </>
  );
}

/**
 * **The words a scheduler reads for each of the sixteen states.**
 *
 * One table, so that `infeasible` and `failed` cannot drift into each other in
 * one screen's copy while staying apart in another. The distinction report 21 §4
 * insists on is a distinction the INTERFACE has to make, or it does not exist:
 * a user who is told "the build failed" for an infeasible problem will go
 * looking for a system fault that is not there.
 */
export const STATE_LABELS: Readonly<Record<BuildRunStateWire, string>> = {
  draft_configuration: 'Being configured',
  validating: 'Validating the configuration',
  readiness_check: 'Checking readiness',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed — all preferences met',
  completed_with_unmet_preferences: 'Completed — some preferences unmet',
  infeasible: 'Infeasible',
  failed: 'Failed',
  cancelled: 'Cancelled',
  reviewed: 'Reviewed',
  progressively_extended: 'Extended by a further stage',
  approved: 'Approved',
  applied_to_draft_schedule: 'Applied to a draft schedule',
  superseded: 'Superseded by a later build',
  archived: 'Archived',
};

export const STATE_EXPLANATIONS: Readonly<Record<BuildRunStateWire, string>> = {
  draft_configuration:
    'Nothing has been run yet. Submit it when the configuration is what you want.',
  validating: 'Checking that the configuration is internally consistent.',
  readiness_check:
    'Checking that demand, roster, rules and qualifications can all be resolved for this period.',
  queued: 'Waiting for a worker. You can cancel it before it starts.',
  running: 'A solve is in progress. Cancelling asks it to stop; it stops when it actually stops.',
  completed: 'A schedule was found and independently re-checked. Every preference was met.',
  completed_with_unmet_preferences:
    'A schedule was found and independently re-checked. Some preferences could not be met — the objective breakdown shows which.',
  /* The distinction report 21 §4 requires the interface to make. */
  infeasible:
    'No schedule satisfies the hard rules for this period. This is a statement about the problem, not a fault in the system — the explanation below names what conflicts.',
  failed:
    'The build did not finish. This is a statement about the system, not about whether a schedule exists.',
  cancelled: 'You cancelled this build. No partial result was kept.',
  reviewed: 'You have inspected the findings. Approve it, or run a further stage over it.',
  progressively_extended:
    'A further stage is running over this result, protecting the assignments you locked.',
  approved:
    'Zero unresolved hard violations. Selecting it writes the candidate into a new draft version.',
  applied_to_draft_schedule:
    'The candidate is now a draft version. Review and publish it through the usual path.',
  superseded: 'A later build for this period was approved.',
  archived: 'The period is closed. This build is kept as history.',
};

/**
 * The FAD-34 termination vocabulary, in words — never collapsed.
 *
 * `deadline` is not `crashed` is not `user_cancelled`. Each one sends a
 * scheduler somewhere different, and a single "it stopped" would send them
 * nowhere.
 */
export const TERMINATION_LABELS: Readonly<Record<string, string>> = {
  completed: 'ran to completion',
  deadline: 'reached its time limit',
  user_cancelled: 'was cancelled by a scheduler',
  killed: 'was terminated by the platform',
  crashed: 'stopped without reporting why',
  rejected: 'produced a candidate the independent check refused',
};

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M4-004 — the E2 vocabularies. Same rule, same reason: one table, so two
 * screens cannot say two different things about one fact.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **PO-DEC-13's four conflict classes, in words.**
 *
 * Four, closed, in the decision's own severity order. The wording carries the
 * distinction the taxonomy exists to make: the first three are things that are
 * WRONG with a candidate, and the fourth is a MEASUREMENT with no threshold —
 * SPEC-04 §7 leaves every band undefined until the benchmark corpus is run and
 * no band is set until the M6 benchmark, so nothing here calls a dispersion too large.
 */
export const CONFLICT_CLASS_LABELS: Readonly<Record<ConflictClassWire, string>> = {
  'hard-breach': 'Hard breach',
  'unmet-demand': 'Unmet demand',
  'eligibility-failure': 'Eligibility failure',
  'fairness-outlier': 'Fairness outlier',
};

export const CONFLICT_CLASS_EXPLANATIONS: Readonly<Record<ConflictClassWire, string>> = {
  'hard-breach':
    'A hard rule was broken, or could not be checked at all. A candidate carrying one can never become a schedule.',
  'unmet-demand':
    'A required slot was not filled. A shortfall is a hard-rule violation, not a quality score.',
  'eligibility-failure':
    'Someone was placed on work they are not eligible for, or nobody eligible exists for a slot.',
  'fairness-outlier':
    'A measured extreme in the distribution of burden. There is no threshold for this — it is reported so you can look, not because anything is wrong.',
};

/**
 * **The five explanation states** (SPEC-04 §5's table, verbatim in meaning).
 *
 * The two degraded states are first-class here, not a fallback branch. SPEC-04
 * §5 spends a paragraph on exactly why:
 *
 * > A scheduler is better served by "we could not isolate the cause in 60
 * > seconds, here is what we do know" than by a system that appears to hang or
 * > invents a confident-sounding but wrong answer.
 */
export const EXPLANATION_LABELS: Readonly<Record<ExplanationStateWire, string>> = {
  EXPLAINED_EXACT: 'Cause identified exactly',
  EXPLAINED_SUBSET: 'Conflicting rules identified',
  EXPLAINED_MINIMAL: 'Conflicting rules narrowed to a minimal set',
  EXPLANATION_BUDGET_EXCEEDED: 'The cause could not be isolated within the time budget',
  EXPLANATION_UNAVAILABLE: 'No explanation could be produced',
};

export const EXPLANATION_DETAIL: Readonly<Record<ExplanationStateWire, string>> = {
  EXPLAINED_EXACT:
    'A structural check found the cause before any search was needed. This answer is exact.',
  EXPLAINED_SUBSET:
    'These rules conflict. The set is sufficient to explain the infeasibility but is not necessarily the smallest such set.',
  EXPLAINED_MINIMAL:
    'These rules conflict, and each one was shown to be necessary: removing any single rule from this set would not resolve it on its own.',
  EXPLANATION_BUDGET_EXCEEDED:
    'Infeasible. The cause could not be isolated within the time budget. What was established is shown below, and it is partial.',
  EXPLANATION_UNAVAILABLE:
    'Infeasible. The explanation step itself did not produce an answer. This says nothing about why the period is infeasible — only that we could not narrow it here.',
};

/**
 * Deterministic mode, in words — and its cost, disclosed rather than implied.
 *
 * `reproducibilityMode` is COMPUTED from the parameters and is never a flag a
 * caller sets (SPEC-04 §4 as amended). The wording says what the mode buys and
 * what it costs, because a toggle offered without its cost would be a trap.
 *
 * REPAIR F-04 (FAD-46): the cost quoted is THIS packet's own measurement on the
 * E1 corpus (EV-M4-004 §5) — ≈1× on the thirteen startup-dominated classes,
 * 10.05× on `B-fairness-shaped`, the only class with an objective large enough to
 * search, where deterministic mode also returned FEASIBLE where best-effort
 * proved OPTIMAL. EV-M0-SPC H-7's toy-instance figures used to stand here; H-7's
 * faster-on-a-hard-instance half is NOT reproduced by this corpus, so it is not
 * claimed.
 */
export const REPRODUCIBILITY_LABELS: Readonly<Record<string, string>> = {
  deterministic: 'Deterministic — reproducible',
  'best-effort': 'Best effort — not reproducible',
};

export const REPRODUCIBILITY_DETAIL: Readonly<Record<string, string>> = {
  deterministic:
    'The full pinned parameter set is in force, so the same problem run again on the same worker build produces the same schedule.',
  'best-effort':
    'The same problem run again may produce a different schedule of the same quality. A fixed seed alone is not enough — the parallel search synchronises on thread timing.',
};
