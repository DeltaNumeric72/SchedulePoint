import type { JSX } from 'react';
import type { AffectedMember, AssignmentChangeView, VersionDifferenceWire } from '@schedulepoint/contracts';

import { useNarrowViewport } from '../components/useNarrowViewport.js';

/**
 * The difference between two versions, rendered (OPUS-M3-005).
 *
 * ## The display is the server's difference, unmodified
 *
 * Every row here comes from `difference.changes` exactly as the API returned it,
 * and the API's changes are the frozen `differenceByIdentity`'s decisions with
 * decoration attached. **Nothing in this file computes, filters, merges or
 * re-orders a change**, which is what makes "the diff display equals the
 * pure-function diff" a property of the whole path rather than of the server
 * alone: `apps/api/test/schedule/publication-diff-parity.test.ts` proves the
 * response equals the pure function, and `apps/web/e2e/publication.spec.ts`
 * proves the rendered rows equal the response.
 *
 * ## Kind is carried by WORDS, never by colour
 *
 * SPEC-14 and SP-E §1.5: no colour as sole carrier. Each change states its kind
 * in prose ("Added", "Removed", "Moved from … to …", "Times changed"), so the
 * meaning survives a monochrome display, forced-colors mode and a screen reader
 * identically.
 *
 * ## Both renderings are first class
 *
 * A table below 640px produces horizontal page scroll (SC 1.4.10), so the narrow
 * viewport renders the same rows as a list. It is the same data in a different
 * shape — not a summary, not a subset — and the e2e asserts the two carry the
 * same change set.
 */

/** `HH:MM` in the group's zone. The zone is always named beside it, never implied. */
export function timeIn(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

/** The prose for one change. The single place a kind becomes words. */
export function changeSentence(change: AssignmentChangeView): string {
  const to = change.toDisplayName ?? change.toMembershipId ?? 'somebody no longer listed';
  const from = change.fromDisplayName ?? change.fromMembershipId ?? 'somebody no longer listed';
  switch (change.kind) {
    case 'added':
      return `Added — ${to} is now on this shift.`;
    case 'removed':
      return `Removed — ${from} is no longer on this shift.`;
    case 'reassigned':
      return `Moved — from ${from} to ${to}.`;
    case 'retimed':
      return `Times changed — ${to} keeps this shift at new hours.`;
    case 'amended':
      /* OPUS-M4-000C. The same person at the same time, but the shift type, the
       * location, the pin or the credit moved. The sentence NAMES which, because
       * "amended" on its own tells a scheduler nothing they can check, and these
       * changes were invisible in the review until this packet. */
      return `Changed — ${to} keeps this shift; ${describeFields(change.materialFields)} changed.`;
  }
}

/** The material dimensions, as words. Ordered as the definition orders them. */
function describeFields(fields: readonly AssignmentChangeView['materialFields'][number][]): string {
  const words: Record<string, string> = {
    participant: 'who is working it',
    date: 'the date',
    time: 'the times',
    shiftType: 'the shift type',
    location: 'the location',
    pin: 'whether it is pinned',
    credit: 'the credit',
  };
  const named = fields.map((field) => words[field] ?? field);
  if (named.length === 0) return 'something';
  if (named.length === 1) return named[0] ?? 'something';
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1] ?? ''}`;
}

export function ChangeList({
  changes,
  timezone,
  testId,
}: {
  changes: readonly AssignmentChangeView[];
  timezone: string;
  testId: string;
}): JSX.Element {
  const narrow = useNarrowViewport();

  if (changes.length === 0) {
    return (
      <p className="text-text-muted" data-testid={`${testId}-empty`}>
        Nothing changes. This version holds the same assignments as the one it would replace.
      </p>
    );
  }

  if (narrow) {
    return (
      <ul className="flex flex-col gap-sp-3" data-testid={`${testId}-list`}>
        {changes.map((change) => (
          <li
            className="rounded-panel border border-border bg-surface-raised p-sp-3"
            data-testid={`diffrow-${change.assignmentIdentityId}`}
            key={change.assignmentIdentityId}
          >
            <p className="font-medium text-text" data-testid="change-sentence">
              {changeSentence(change)}
            </p>
            <dl className="mt-sp-2 flex flex-col gap-sp-1 text-sm">
              <div className="flex gap-sp-2">
                <dt className="text-text-muted">Date</dt>
                <dd className="text-text">{change.date}</dd>
              </div>
              <div className="flex gap-sp-2">
                <dt className="text-text-muted">Shift</dt>
                <dd className="text-text">{change.shiftTypeCode}</dd>
              </div>
              <div className="flex gap-sp-2">
                <dt className="text-text-muted">Hours</dt>
                <dd className="text-text">
                  {timeIn(change.startsAt, timezone)}–{timeIn(change.endsAt, timezone)} ({timezone})
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <table className="w-full border-collapse text-left" data-testid={`${testId}-table`}>
      <caption className="sr-only">
        Every assignment that differs between the two versions, in the group time zone {timezone}
      </caption>
      <thead>
        <tr>
          <th className="border-b border-border p-sp-2" scope="col">
            Date
          </th>
          <th className="border-b border-border p-sp-2" scope="col">
            Shift
          </th>
          <th className="border-b border-border p-sp-2" scope="col">
            Hours
          </th>
          <th className="border-b border-border p-sp-2" scope="col">
            What changed
          </th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr data-testid={`diffrow-${change.assignmentIdentityId}`} key={change.assignmentIdentityId}>
            <td className="border-b border-border p-sp-2 text-text">{change.date}</td>
            <td className="border-b border-border p-sp-2 text-text">{change.shiftTypeCode}</td>
            <td className="border-b border-border p-sp-2 text-text">
              {timeIn(change.startsAt, timezone)}–{timeIn(change.endsAt, timezone)}
            </td>
            <td className="border-b border-border p-sp-2 text-text" data-testid="change-sentence">
              {changeSentence(change)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One person's stake in the change set. Both sides of a move are counted. */
export function affectedSentence(member: AffectedMember): string {
  const parts: string[] = [];
  if (member.added > 0) parts.push(`${String(member.added)} added`);
  if (member.removed > 0) parts.push(`${String(member.removed)} removed`);
  if (member.reassignedTo > 0) parts.push(`${String(member.reassignedTo)} moved to them`);
  if (member.reassignedAway > 0) parts.push(`${String(member.reassignedAway)} moved away`);
  if (member.retimed > 0) parts.push(`${String(member.retimed)} retimed`);
  if (member.amended > 0) parts.push(`${String(member.amended)} changed`);
  return parts.length === 0 ? 'no change' : parts.join(', ');
}

export function AffectedStaffList({
  members,
  testId,
}: {
  members: readonly AffectedMember[];
  testId: string;
}): JSX.Element {
  if (members.length === 0) {
    return (
      <p className="text-text-muted" data-testid={`${testId}-empty`}>
        Nobody is affected. No member of this group gains, loses or has a shift moved by this
        publication.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-sp-2" data-testid={testId}>
      {members.map((member) => (
        <li
          className="rounded-panel border border-border bg-surface-raised p-sp-3"
          data-testid={`affected-${member.membershipId}`}
          key={member.membershipId}
        >
          <span className="font-medium text-text">
            {member.displayName ?? 'A member who is no longer listed in this group'}
          </span>
          <span className="text-text-muted"> — {affectedSentence(member)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The change list and the affected list together — the review's centrepiece. */
export function DifferenceView({
  difference,
  timezone,
  testId,
}: {
  difference: VersionDifferenceWire;
  timezone: string;
  testId: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-sp-4">
      <section aria-labelledby={`${testId}-changes-heading`} className="flex min-w-0 flex-col gap-sp-2">
        <h3 className="font-semibold text-text" id={`${testId}-changes-heading`}>
          What changes
        </h3>
        <p className="text-sm text-text-muted" data-testid={`${testId}-change-count`}>
          {difference.changes.length === 1
            ? '1 assignment differs.'
            : `${String(difference.changes.length)} assignments differ.`}
        </p>
        <div className="min-w-0 overflow-x-auto" tabIndex={0}>
          <ChangeList changes={difference.changes} testId={testId} timezone={timezone} />
        </div>
      </section>

      <section aria-labelledby={`${testId}-affected-heading`} className="flex flex-col gap-sp-2">
        <h3 className="font-semibold text-text" id={`${testId}-affected-heading`}>
          Who is affected
        </h3>
        <p className="text-sm text-text-muted" data-testid={`${testId}-affected-count`}>
          {difference.affectedMembers.length === 1
            ? '1 person is affected.'
            : `${String(difference.affectedMembers.length)} people are affected.`}{' '}
          A moved shift affects both the person who loses it and the person who gains it.
        </p>
        <AffectedStaffList members={difference.affectedMembers} testId={`${testId}-affected`} />
      </section>
    </div>
  );
}
