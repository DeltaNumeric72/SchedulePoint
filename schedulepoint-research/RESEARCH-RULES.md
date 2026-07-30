# Research Rules — ischedule.md Clean-Room Investigation

These rules govern all Claude for Chrome activity against **https://ischedule.md** for the SchedulePoint clean-room product research. They apply to every session, every screen, and every account used for this research, without exception.

## Permitted (read-only navigation)

Claude for Chrome may autonomously navigate https://ischedule.md in **read-only mode** using:

- Links
- Tabs
- Menus
- Pagination
- Non-saving search and filters (client-side/query controls that do not write to the server)
- View selectors (e.g. Date View / Staff View / Shift View toggles, date-range pickers, display-only sort/font/zoom controls)
- Drawers
- Modals — but only to **read** their contents; opening a modal to inspect its fields is permitted, submitting it is not (see Prohibited)

Navigation may be broad and systematic (exploring every menu, tab, and screen reachable in read-only mode) in order to build a complete application map.

## Prohibited (no exceptions)

The following are prohibited on ischedule.md at all times, regardless of role, session, or apparent low risk:

- Any **server-side mutation** of any kind — creating, editing, saving, or updating any record, field, toggle, or setting
- **Messages** — sending email, SMS, dial/voice notifications, or any other message to any person
- **Uploads** — uploading any file or document
- **Imports** — running any import action
- **Approvals** — approving any request, vacation, swap, or other pending item
- **Acceptances** — accepting, claiming, or confirming any offer, shift, or opportunity
- **Publications** — publishing, locking, or releasing any schedule, build, or list
- **Deletions** — deleting, removing, erasing, or clearing any record, user, build, schedule, or setting (including bulk/batch delete tools)
- **Setting changes** — changing any configuration, preference, notification rule, permission, or account setting
- **Impersonation** — using "Sign In As" or any other mechanism to act as another user

This prohibition covers the control itself, not just the follow-through: do not click a button whose label or icon indicates any of the above (e.g. Save, Update, Approve, Deny, Remove, Delete, Publish, Lock, Unlock, Start List, Batch Add, Batch Delete, New Build, Erase Master Schedule, Add User, Add Staff, Add Locum, Add All, Clear, Send Email, Send SMS, Import, Upload, Sign In As), even to see what happens next.

## When safety is uncertain: do not click

If it is not clear from a control's label, icon, or surrounding context whether an action is read-only or mutating, **do not click it.** Instead:

1. Inspect the surrounding UI (labels, tooltips, adjacent confirmation text, URL changes) to reason about what the control likely does.
2. Record the uncertainty as an unresolved question rather than resolving it by clicking.
3. Move on to the next area of exploration.

If a click unexpectedly opens something that turns out to be a mutating confirmation (e.g. a delete or approval dialog appearing where a read-only detail view was expected), dismiss it via the safe, non-destructive option (Cancel/Close) immediately, and do not repeat the click on similar controls elsewhere in the app.

## Data handling

- Do not copy source code, proprietary assets, credentials, tokens, or API keys.
- Do not copy customer data or patient information into any research artifact.
- Where a screen displays real personal data (staff names, personal emails, phone numbers) or clinical/patient detail, describe the **feature and field schema** generically in research output — do not transcribe the actual values.
- Use generic, descriptive filenames for any evidence saved to disk (no names, phone numbers, patient details, or other sensitive data in filenames or content).

## Scope

These rules apply for the duration of the SchedulePoint clean-room investigation of ischedule.md and govern all findings recorded under `schedulepoint-research/`. If the investigation's scope, target site, or account changes, these rules should be reviewed and updated accordingly.
