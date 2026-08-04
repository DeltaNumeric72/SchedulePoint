import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import {
  CONTROL_CLASS,
  Field,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  ValidationSummary,
  useFieldIds,
  type FieldProblem,
} from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { SettingsLayout, useGroupScope } from './SettingsLayout.js';
import {
  ConflictError,
  ValidationError,
  createLocation,
  fetchLocations,
  updateLocation,
} from './api.js';

/**
 * The group's locations (OPUS-M3-007; CAP-004, carried M2 item 7).
 *
 * ## The site label is a LABEL, and the interface says so
 *
 * PO-DEC-01 is pending with the working default "defer a first-class Site; model
 * location as an attribute" (doc 06 §3.2a). So this page has:
 *
 *   * no site picker, because there is nothing to pick from;
 *   * no site list, no site page, no filter-by-site;
 *   * a plain optional text field whose help text says what it is — free text
 *     the group types, not a record anything points at.
 *
 * A dropdown here would be the pending decision's non-default branch arriving
 * through the interface (non-bypass rule 12), and it would be the version of it
 * that is hardest to notice: an administrator using a site picker reasonably
 * concludes sites are entities.
 *
 * ## Archive, never delete
 *
 * There is no delete control, because there is no DELETE grant. Archiving is a
 * status move and archived locations stay in the table, marked — the same
 * treatment retired shift types get, and for the same reason: a location a
 * published schedule refers to cannot stop existing.
 */

export function LocationsPage(): JSX.Element {
  return (
    <SettingsLayout
      title="Locations"
      description="The places this group works. Archived locations are kept, never deleted."
    >
      <LocationsPanel />
    </SettingsLayout>
  );
}

function problemsOf(error: unknown): readonly FieldProblem[] {
  if (error instanceof ValidationError) return error.problems;
  if (error instanceof ConflictError) return [{ field: 'form', message: error.message }];
  return [];
}

function LocationsPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('location', [
    'name',
    'siteLabel',
    'address',
    'timezone',
  ] as const);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [siteLabel, setSiteLabel] = useState('');
  const [address, setAddress] = useState('');
  const [timezone, setTimezone] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const list = useQuery({
    queryKey: ['locations', scope.organizationId, scope.groupId],
    queryFn: () => fetchLocations(scope),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      createLocation(scope, {
        name,
        // An empty box is ABSENT, not an empty string: the column's CHECK
        // refuses a blank-but-present label, and sending one would produce a
        // 422 for a field the user simply did not fill in.
        siteLabel: siteLabel.trim() === '' ? null : siteLabel,
        address: address.trim() === '' ? null : address,
        timezone: timezone.trim() === '' ? null : timezone,
      }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      setSiteLabel('');
      setAddress('');
      setTimezone('');
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['locations'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const archive = useMutation({
    mutationFn: (target: { locationId: string; version: number }) =>
      updateLocation(scope, target.locationId, {
        status: 'archived',
        expectedVersion: target.version,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['locations'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const locations = list.data?.locations ?? [];
  const narrow = useNarrowViewport();

  const archiveButton = (target: { locationId: string; version: number; name: string; status: string }) =>
    target.status === 'archived' ? (
      <span className="text-text-muted">—</span>
    ) : (
      <button
        type="button"
        className={SECONDARY_BUTTON_CLASS}
        data-testid={`archive-${target.locationId}`}
        onClick={() => archive.mutate({ locationId: target.locationId, version: target.version })}
      >
        Archive<span className="sr-only"> {target.name}</span>
      </button>
    );

  return (
    <section aria-labelledby="locations-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="locations-heading">
        Locations
      </h2>

      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        data-testid="new-location"
        aria-expanded={open}
        onClick={() => {
          // I-13: this opens a form and writes nothing. The e2e budget for this
          // click is ZERO requests, and it can never be raised without the
          // invariant changing first.
          setOpen((value) => !value);
          setProblems([]);
        }}
      >
        {open ? 'Cancel' : 'Add a location'}
      </button>

      {open ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          aria-labelledby="new-location-heading"
          data-testid="location-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            create.mutate();
          }}
        >
          <h3 className="text-lg font-semibold text-text" id="new-location-heading">
            Add a location
          </h3>
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="location" />

          <Field
            id={fieldIds.name}
            label="Name"
            problem={problems.find((problem) => problem.field === 'name')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>

          {/* Free text, and the help says exactly that. NOT a picker: sites are
              not entities in this system, and a dropdown would tell an
              administrator otherwise (PO-DEC-01, doc 06 §3.2a). */}
          <Field
            id={fieldIds.siteLabel}
            label="Site label (optional)"
            help="Free text. A label you use to group locations that sit together — it is not linked to anything."
            problem={problems.find((problem) => problem.field === 'siteLabel')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="siteLabel"
                value={siteLabel}
                onChange={(event) => setSiteLabel(event.target.value)}
              />
            )}
          </Field>

          <Field
            id={fieldIds.address}
            label="Address (optional)"
            problem={problems.find((problem) => problem.field === 'address')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            )}
          </Field>

          <Field
            id={fieldIds.timezone}
            label="Time zone (optional)"
            help="Only if this location is in a different zone from the group. Leave it blank otherwise."
            problem={problems.find((problem) => problem.field === 'timezone')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            )}
          </Field>

          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-location">
              Save
            </button>
            <button className={SECONDARY_BUTTON_CLASS} type="button" onClick={() => setOpen(false)}>
              Discard
            </button>
          </div>
        </form>
      ) : null}

      <SurfaceState
        isLoading={list.isPending}
        error={list.error}
        isEmpty={locations.length === 0}
        emptyMessage="No locations recorded yet. A location is a place this group works — a ward, a theatre, a clinic."
        label="the locations"
      >
        {narrow ? (
          <ul className="flex flex-col gap-sp-3" data-testid="location-list">
            {locations.map((location) => (
              <li
                className="flex min-w-0 flex-col gap-sp-2 rounded-panel border border-border p-sp-3"
                key={location.locationId}
              >
                <p className="font-medium text-text">{location.name}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-sp-3 gap-y-sp-1">
                  <dt className="text-text-muted">Site label</dt>
                  <dd className="min-w-0 break-words text-text">{location.siteLabel ?? '—'}</dd>
                  <dt className="text-text-muted">Address</dt>
                  <dd className="min-w-0 break-words text-text">{location.address ?? '—'}</dd>
                  <dt className="text-text-muted">Time zone</dt>
                  <dd className="text-text">{location.timezone ?? 'Group time zone'}</dd>
                  <dt className="text-text-muted">Status</dt>
                  <dd className="text-text">
                    {location.status === 'archived' ? 'Archived' : 'Active'}
                  </dd>
                </dl>
                <div className="flex flex-wrap gap-sp-2">{archiveButton(location)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="w-full min-w-0 overflow-x-auto">
            <table className="min-w-full border-collapse text-left" data-testid="location-table">
              <caption className="pb-sp-2 text-left text-text-muted">
                {locations.length === 1 ? '1 location' : `${String(locations.length)} locations`}
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th className="p-sp-2" scope="col">
                    Name
                  </th>
                  <th className="p-sp-2" scope="col">
                    Site label
                  </th>
                  <th className="p-sp-2" scope="col">
                    Address
                  </th>
                  <th className="p-sp-2" scope="col">
                    Time zone
                  </th>
                  <th className="p-sp-2" scope="col">
                    Status
                  </th>
                  <th className="p-sp-2" scope="col">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {locations.map((location) => (
                  <tr className="border-b border-border" key={location.locationId}>
                    <th className="p-sp-2 font-normal text-text" scope="row">
                      {location.name}
                    </th>
                    {/* An em dash rather than a blank cell: an empty cell reads as
                        "no value announced" to a screen reader, which is
                        indistinguishable from a rendering bug. */}
                    <td className="p-sp-2 text-text">{location.siteLabel ?? '—'}</td>
                    <td className="p-sp-2 text-text">{location.address ?? '—'}</td>
                    <td className="p-sp-2 text-text">{location.timezone ?? 'Group time zone'}</td>
                    {/* The status as a WORD. A coloured dot would make the column
                        colour-dependent (SPEC-14 §2). */}
                    <td className="p-sp-2 text-text">
                      {location.status === 'archived' ? 'Archived' : 'Active'}
                    </td>
                    <td className="p-sp-2">{archiveButton(location)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SurfaceState>
    </section>
  );
}
