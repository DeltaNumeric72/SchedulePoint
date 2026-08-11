import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useEffect, useState, type JSX } from 'react';

import { fetchGrid } from './api.js';
import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import { SECONDARY_BUTTON_CLASS } from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { CellEditor } from './CellEditor.js';
import { ScheduleGridView, type GridView } from './ScheduleGrid.js';
import { ScheduleLayout } from './ScheduleLayout.js';
import { buildRows, type CellView } from './grid-model.js';

/**
 * The schedule-authoring grid for one version (OPUS-M3-004).
 *
 * ## Validation display is RECORDED conflicts and structural completeness only
 *
 * The packet is explicit: "validation display = recorded conflicts + structural
 * validation only (no rule execution against drafts — that is the step-06 class,
 * M3-008; displaying it here would fake a capability)".
 *
 * So this page shows exactly two things, and neither is a rule evaluation:
 *
 *  1. **Recorded conflicts** — rows already in `schedule_conflicts`, written by
 *     whatever recorded them, rendered as they stand.
 *  2. **Incomplete demand** — an arithmetic comparison of assignments against
 *     the period's stated requirement. That is counting, not rule execution.
 *
 * There is no "check this draft against the rules" control anywhere here,
 * because nothing on this branch can honestly answer it. Compiled HARD rules are
 * evaluated against version content at publication, and that join is M3-008's.
 *
 * ## The server is the authority after every mutation (PO-DEC-18)
 *
 * A successful cell mutation returns the cell, and the page then re-reads the
 * grid rather than patching its own cache. What is rendered is therefore always
 * a view some server produced — never one assembled in the browser from a
 * response plus an assumption.
 */

export function GridPage(): JSX.Element {
  return (
    <ScheduleLayout
      title="Schedule grid"
      description="One draft version, by date and shift type. Only a draft can be edited; a published version is shown read-only."
    >
      <GridPanel />
    </ScheduleLayout>
  );
}

function GridPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const narrow = useNarrowViewport();
  const params = useParams({ strict: false }) as { versionId?: string };
  const versionId = params.versionId ?? '';

  /**
   * The rendering the user gets.
   *
   * The narrow viewport DEFAULTS to the table — a 20-column grid does not fit in
   * 320px and pretending otherwise produces horizontal page scroll (SC 1.4.10).
   * It is a default and not a lock: the control below switches either way at any
   * width, because "the alternative is not a degraded mode" has to mean the user
   * decides.
   */
  const [view, setView] = useState<GridView | null>(null);
  const effectiveView: GridView = view ?? (narrow ? 'table' : 'grid');

  const [openCell, setOpenCell] = useState<{ date: string; shiftTypeId: string } | null>(null);

  const grid = useQuery({
    queryKey: ['schedule-grid', scope.organizationId, scope.groupId, versionId],
    queryFn: () => fetchGrid(scope, versionId),
    retry: false,
  });

  // A version that stops being editable under the author (published by somebody
  // else) must not leave an editor open over content that can no longer change.
  useEffect(() => {
    if (grid.data !== undefined && !grid.data.version.isEditable) setOpenCell(null);
  }, [grid.data]);

  const rows = grid.data === undefined ? [] : buildRows(grid.data);
  const selected: CellView | undefined =
    openCell === null
      ? undefined
      : rows
          .find((row) => row.date === openCell.date)
          ?.cells.find((cell) => cell.shiftTypeId === openCell.shiftTypeId);

  const conflicts = grid.data?.conflicts ?? [];
  const incompleteCount = rows.reduce(
    (total, row) => total + row.cells.filter((cell) => cell.isIncomplete).length,
    0,
  );

  return (
    <div className="flex min-w-0 flex-col gap-sp-5">
      <SurfaceState
        isLoading={grid.isPending}
        error={grid.error}
        isEmpty={grid.data !== undefined && grid.data.shiftTypes.length === 0}
        emptyMessage="This group has no active shift types, so there is nothing to schedule yet. Create one in the catalogue first."
        label="the schedule grid"
      >
        {grid.data === undefined ? null : (
          <>
            <section aria-labelledby="version-summary-heading" className="flex flex-col gap-sp-2">
              <h2 className="text-lg font-semibold text-text" id="version-summary-heading">
                {grid.data.period.name}
              </h2>
              <p className="text-text-muted">
                {grid.data.period.startDate} to {grid.data.period.endDate} · times shown in{' '}
                {grid.data.timezone}
                {grid.data.timezoneSource === 'version-snapshot'
                  ? ' (the zone this version was published with)'
                  : ' (the group’s current zone)'}{' '}
                ·{' '}
                {grid.data.version.versionNumber === null
                  ? 'unpublished draft'
                  : `version ${String(grid.data.version.versionNumber)}`}{' '}
                ({grid.data.version.state})
              </p>
              {/* The explicit staleness surfacing doc 34 §4-F requires. A draft
                  whose instants were derived under a zone the group has since
                  left cannot be published, and being told that here — rather
                  than at the publish button — is the difference between a
                  correction and a dead end. `role="alert"` because it appears
                  after the page has loaded and changes what the reader can do. */}
              {grid.data.timezoneStale ? (
                <p className="text-text" data-testid="timezone-stale" role="alert">
                  This version was authored in a different time zone from the one the group uses
                  now, so its times no longer mean what they did when it was written. It cannot be
                  published until it is rebuilt against {grid.data.timezone}.
                </p>
              ) : null}
              {grid.data.version.isEditable ? null : (
                <p className="text-text" data-testid="grid-readonly">
                  This version is not a draft. It is shown read-only; amend it by cloning it into a
                  new draft and publishing forward.
                </p>
              )}
            </section>

            {/* Validation display: recorded conflicts, and counting. Nothing here
                evaluates a rule against this draft. */}
            <section aria-labelledby="validation-heading" className="flex flex-col gap-sp-2">
              <h2 className="text-lg font-semibold text-text" id="validation-heading">
                Validation
              </h2>
              <p className="text-sm text-text-muted" data-testid="validation-scope-note">
                This shows conflicts already recorded against this version and requirements that are
                not yet met. Scheduling rules are checked when a version is published, not here.
              </p>

              <p className="text-text" data-testid="incomplete-demand">
                {incompleteCount === 0
                  ? 'Every stated requirement is met.'
                  : incompleteCount === 1
                    ? '1 requirement is not yet met.'
                    : `${String(incompleteCount)} requirements are not yet met.`}
              </p>

              {conflicts.length === 0 ? (
                <p className="text-text-muted" data-testid="conflicts-empty">
                  No conflicts have been recorded against this version.
                </p>
              ) : (
                <ul className="flex flex-col gap-sp-2" data-testid="conflicts-list">
                  {conflicts.map((conflict) => (
                    <li
                      className="rounded-panel border border-border bg-surface-raised p-sp-3"
                      key={conflict.id}
                    >
                      <p className="font-medium text-text">
                        {conflict.severity === 'hard-breach'
                          ? 'Hard breach'
                          : conflict.severity === 'soft'
                            ? 'Soft breach'
                            : 'Information'}{' '}
                        · {conflict.state}
                      </p>
                      {conflict.explanation === null ? null : (
                        <p className="text-text-muted">{conflict.explanation}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="schedule-grid-heading" className="flex min-w-0 flex-col gap-sp-3">
              <div className="flex flex-wrap items-center justify-between gap-sp-3">
                <h2 className="text-lg font-semibold text-text" id="schedule-grid-heading">
                  Assignments
                </h2>
                <div className="flex flex-wrap items-center gap-sp-2">
                  <span className="text-sm text-text-muted" id="view-switch-label">
                    Rendering
                  </span>
                  {/* Both renderings are offered at every width. The narrow
                      viewport only changes the DEFAULT. */}
                  <button
                    aria-pressed={effectiveView === 'grid'}
                    className={SECONDARY_BUTTON_CLASS}
                    data-testid="view-grid"
                    onClick={() => setView('grid')}
                    type="button"
                  >
                    Grid
                  </button>
                  <button
                    aria-pressed={effectiveView === 'table'}
                    className={SECONDARY_BUTTON_CLASS}
                    data-testid="view-table"
                    onClick={() => setView('table')}
                    type="button"
                  >
                    Table
                  </button>
                </div>
              </div>

              <p className="text-sm text-text-muted" data-testid="view-explainer">
                {effectiveView === 'grid'
                  ? 'A month at a glance. Arrow keys move between cells; Enter opens one.'
                  : 'One row per date and shift type, with full table semantics. The same data as the grid.'}
              </p>

              <ScheduleGridView
                onOpenCell={(cell) => setOpenCell({ date: cell.date, shiftTypeId: cell.shiftTypeId })}
                rows={rows}
                shiftTypes={grid.data.shiftTypes}
                timezone={grid.data.timezone}
                view={effectiveView}
              />
            </section>

            {selected === undefined ? null : (
              <CellEditor
                cell={selected}
                isEditable={grid.data.version.isEditable}
                onClose={() => setOpenCell(null)}
                onMutated={() => {
                  void queryClient.invalidateQueries({ queryKey: ['schedule-grid'] });
                }}
                locations={grid.data.locations}
                roster={grid.data.roster}
                scope={scope}
                versionId={versionId}
              />
            )}
          </>
        )}
      </SurfaceState>
    </div>
  );
}
