import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import {
  CONTROL_CLASS,
  Field,
  PRIMARY_BUTTON_CLASS,
  ValidationSummary,
  useFieldIds,
  type FieldProblem,
} from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { SettingsLayout, useGroupScope } from './SettingsLayout.js';
import {
  ConflictError,
  ValidationError,
  fetchGroupSettings,
  setPicklistAccess,
  setRequestUntil,
  setTimezone,
} from './api.js';

/**
 * The three group settings: the request window, the picklist policy, and the
 * timezone (OPUS-M3-007; carried M2 items 4, 5 and 6).
 *
 * ## Two of these three are STORED, not enforced — and the page says so
 *
 * Packet 32 §2 rows 5-6 put enforcement of the request window at **M5**
 * (SPEC-08) and of picklist access at **M9** (SPEC-02). An interface that
 * presented either as an active gate would be claiming a capability the system
 * does not have yet — the same class of dishonesty as a validation display that
 * shows rule results nothing evaluated. So each panel states its status in
 * ordinary prose, on the page, where the administrator setting it can read it.
 *
 * ## Three panels, three permissions, three states
 *
 * The timezone is gated by a different capability from the other two
 * (`group.timezone.administer` vs `group.settings.administer`), so each panel
 * renders its own denial state. One page-level denial would hide the fact that
 * they are different permissions.
 *
 * ## I-13 everywhere
 *
 * Nothing on this page writes on change. Every panel is a form with an explicit
 * Save, and the e2e budget for filling a form without submitting is **zero
 * requests**.
 */

export function GroupSettingsPage(): JSX.Element {
  return (
    <SettingsLayout
      title="Group settings"
      description="The request window, picklist access, and the time zone this group's shifts resolve against."
    >
      <RequestUntilPanel />
      <PicklistAccessPanel />
      <TimezonePanel />
    </SettingsLayout>
  );
}

/** One query key for the whole page: three panels, one read (I-10). */
function useSettings() {
  const scope = useGroupScope();
  return useQuery({
    queryKey: ['group-settings', scope.organizationId, scope.groupId],
    queryFn: () => fetchGroupSettings(scope),
    retry: false,
  });
}

function problemsOf(error: unknown): readonly FieldProblem[] {
  if (error instanceof ValidationError) return error.problems;
  if (error instanceof ConflictError) return [{ field: 'form', message: error.message }];
  return [];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Request until
 * ──────────────────────────────────────────────────────────────────────────── */

function RequestUntilPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const plainIds = useFieldIds('request-until', ['mode', 'untilDate', 'leadDays'] as const);
  /* The summary links by looking the PROBLEM'S FIELD NAME up in this map, and
   * the server addresses these fields by their full path — `policy.untilDate`,
   * not `untilDate`. Aliasing here rather than putting a dot in the DOM id: an
   * id containing a dot cannot be used as a `#…` selector without escaping, so
   * the link would resolve in a browser and be unaddressable by every testing
   * tool. Found by the AC-11 e2e assertion, which requires the summary's link to
   * resolve to exactly one element. */
  const fieldIds = {
    ...plainIds,
    'policy.mode': plainIds.mode,
    'policy.untilDate': plainIds.untilDate,
    'policy.leadDays': plainIds.leadDays,
  };
  const settings = useSettings();

  const [mode, setMode] = useState<string | null>(null);
  const [untilDate, setUntilDate] = useState<string | null>(null);
  const [leadDays, setLeadDays] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const stored = settings.data?.requestUntil;
  const currentMode = mode ?? stored?.mode ?? 'closed';
  const currentDate =
    untilDate ?? (stored?.mode === 'fixed_date' ? stored.untilDate : '');
  const currentLead =
    leadDays ?? (stored?.mode === 'days_before_period_start' ? String(stored.leadDays) : '0');

  const save = useMutation({
    mutationFn: () => {
      const version = settings.data?.version ?? 0;
      if (currentMode === 'fixed_date') {
        return setRequestUntil(scope, { mode: 'fixed_date', untilDate: currentDate }, version);
      }
      if (currentMode === 'days_before_period_start') {
        return setRequestUntil(
          scope,
          { mode: 'days_before_period_start', leadDays: Number(currentLead) },
          version,
        );
      }
      return setRequestUntil(scope, { mode: 'closed' }, version);
    },
    onSuccess: () => {
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['group-settings'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  return (
    <section aria-labelledby="request-until-heading" className="flex flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="request-until-heading">
        Request window
      </h2>
      <p className="text-text-muted">
        When staff may submit requests against a schedule. Staff see either “closed” or the date the
        window runs until.
      </p>

      {/* The honest disclosure. This is stored and validated here; the request
          lifecycle that enforces it is a later milestone, and saying so on the
          page is the difference between a setting and a claim. */}
      <p className="rounded-control border border-border p-sp-3 text-text-muted" role="note">
        This setting is stored and validated now. The request module that enforces it is not built
        yet, so saving a window here does not currently stop anything.
      </p>

      <SurfaceState
        isLoading={settings.isPending}
        error={settings.error}
        isEmpty={false}
        emptyMessage=""
        label="the request window"
      >
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          data-testid="request-until-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            save.mutate();
          }}
        >
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="request-until" />

          <Field
            id={plainIds.mode}
            label="Window"
            problem={problems.find((problem) => problem.field.startsWith('policy.mode'))?.message}
          >
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                name="mode"
                value={currentMode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="closed">Closed — no requests accepted</option>
                <option value="fixed_date">Open until a fixed date</option>
                <option value="days_before_period_start">
                  Open until a number of days before each period starts
                </option>
              </select>
            )}
          </Field>

          {currentMode === 'fixed_date' ? (
            <Field
              id={plainIds.untilDate}
              label="Open until"
              help="Requests are accepted up to and including this date."
              problem={problems.find((problem) => problem.field.endsWith('untilDate'))?.message}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="untilDate"
                  type="date"
                  value={currentDate}
                  onChange={(event) => setUntilDate(event.target.value)}
                />
              )}
            </Field>
          ) : null}

          {currentMode === 'days_before_period_start' ? (
            <Field
              id={plainIds.leadDays}
              label="Days before the period starts"
              help="Zero means requests are accepted right up to the day the period begins."
              problem={problems.find((problem) => problem.field.endsWith('leadDays'))?.message}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  inputMode="numeric"
                  name="leadDays"
                  value={currentLead}
                  onChange={(event) => setLeadDays(event.target.value)}
                />
              )}
            </Field>
          ) : null}

          <div className="flex flex-wrap items-center gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-request-until">
              Save
            </button>
            {save.isSuccess && problems.length === 0 ? (
              <span className="text-success" role="status" aria-live="polite">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      </SurfaceState>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Picklist access
 * ──────────────────────────────────────────────────────────────────────────── */

function PicklistAccessPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('picklist-access', ['mode'] as const);
  const settings = useSettings();

  const [mode, setMode] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const currentMode = mode ?? settings.data?.picklistAccessMode ?? 'disabled';

  const save = useMutation({
    mutationFn: () =>
      setPicklistAccess(
        scope,
        currentMode as 'disabled' | 'members' | 'members_and_proxies',
        settings.data?.version ?? 0,
      ),
    onSuccess: () => {
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['group-settings'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  return (
    <section aria-labelledby="picklist-access-heading" className="flex flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="picklist-access-heading">
        Picklist access
      </h2>
      <p className="text-text-muted">
        Who may take a turn when this group runs a picklist.
      </p>

      {/* Two disclosures, and the second one matters more than it looks.
          A reader has to be able to tell that this setting cannot GRANT
          anything — otherwise "members and proxies" reads like a permission
          being handed out here, which it is not. */}
      <p className="rounded-control border border-border p-sp-3 text-text-muted" role="note">
        This setting is stored and validated now. The picklist module that enforces it is not built
        yet. When it is, this setting can only narrow who may take a turn — it never grants
        permission on its own, and a person still needs the capability their role or an explicit
        grant gives them.
      </p>

      <SurfaceState
        isLoading={settings.isPending}
        error={settings.error}
        isEmpty={false}
        emptyMessage=""
        label="picklist access"
      >
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          data-testid="picklist-access-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            save.mutate();
          }}
        >
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="picklist-access" />

          <Field
            id={fieldIds.mode}
            label="Access"
            problem={problems.find((problem) => problem.field.endsWith('mode'))?.message}
          >
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                name="mode"
                value={currentMode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="disabled">Disabled — this group runs no picklist</option>
                <option value="members">Members take their own turns</option>
                <option value="members_and_proxies">
                  Members take their own turns, and a proxy may act for them
                </option>
              </select>
            )}
          </Field>

          <div className="flex flex-wrap items-center gap-sp-3">
            <button
              className={PRIMARY_BUTTON_CLASS}
              type="submit"
              data-testid="save-picklist-access"
            >
              Save
            </button>
            {save.isSuccess && problems.length === 0 ? (
              <span className="text-success" role="status" aria-live="polite">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      </SurfaceState>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Timezone
 * ──────────────────────────────────────────────────────────────────────────── */

function TimezonePanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  /* `acknowledgePublishedImpact`, spelled exactly as the SERVER addresses it —
   * the summary looks the problem's field name up in this map, and a key of
   * `acknowledge` produced a summary entry with no link to the control the
   * administrator has to tick. Found by the AC-11 e2e assertion. */
  const fieldIds = useFieldIds('timezone', [
    'timezone',
    'acknowledgePublishedImpact',
  ] as const);
  const settings = useSettings();

  const [zone, setZone] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const published = settings.data?.publishedVersionCount ?? 0;
  const currentZone = zone ?? settings.data?.timezone ?? '';

  const save = useMutation({
    mutationFn: () =>
      setTimezone(scope, currentZone, settings.data?.version ?? 0, acknowledged),
    onSuccess: () => {
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['group-settings'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  return (
    <section aria-labelledby="timezone-heading" className="flex flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="timezone-heading">
        Time zone
      </h2>
      <p className="text-text-muted">
        The zone this group&rsquo;s shift start and end times resolve against.
      </p>

      <SurfaceState
        isLoading={settings.isPending}
        error={settings.error}
        isEmpty={false}
        emptyMessage=""
        label="the time zone"
      >
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          data-testid="timezone-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            save.mutate();
          }}
        >
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="timezone" />

          {/* The warning appears BEFORE the control and before the action,
              because a warning that only appears in an error message arrives too
              late to be one. It is ordinary prose in a bordered block: the
              colour is decoration and the sentence reads the same without it
              (SPEC-14 §2 — colour is never the sole carrier). */}
          {published > 0 ? (
            <div
              className="rounded-control border border-warning p-sp-3 text-warning"
              data-testid="timezone-published-warning"
            >
              <p className="font-semibold">
                This group has {published === 1 ? '1 published schedule' : `${String(published)} published schedules`}.
              </p>
              <p className="mt-sp-2">
                Changing the time zone changes how every shift time in this group is interpreted,
                including the ones already published. Nothing stored is rewritten, and no published
                schedule is altered — but people reading them may see different local times. The
                change is recorded in the audit log with the number of published schedules it was
                made over.
              </p>
            </div>
          ) : (
            <p
              className="rounded-control border border-border p-sp-3 text-text-muted"
              data-testid="timezone-no-published"
            >
              This group has no published schedules yet, so changing the time zone affects nothing
              that has already been circulated.
            </p>
          )}

          <Field
            id={fieldIds.timezone}
            label="Time zone"
            help="An IANA zone name, for example Europe/Dublin or America/Toronto."
            problem={problems.find((problem) => problem.field.endsWith('timezone'))?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="timezone"
                value={currentZone}
                onChange={(event) => setZone(event.target.value)}
              />
            )}
          </Field>

          {published > 0 ? (
            <div className="flex min-h-target items-start gap-sp-2">
              <input
                className="mt-sp-1 h-5 w-5"
                id={fieldIds.acknowledgePublishedImpact}
                type="checkbox"
                name="acknowledgePublishedImpact"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <label className="text-text" htmlFor={fieldIds.acknowledgePublishedImpact}>
                I have read what this means for the schedules already published.
              </label>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-timezone">
              Save
            </button>
            {save.isSuccess && problems.length === 0 ? (
              <span className="text-success" role="status" aria-live="polite">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      </SurfaceState>
    </section>
  );
}
