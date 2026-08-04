# EV-M3-SETTINGS — OPUS-M3-007, group settings and the site attribute

**Task:** OPUS-M3-007 (packet [32](../../fable/32-m3-task-packets.md) §10c) ·
**Branch:** `opus/m3-007-settings` · **Base:** `d8babbe` ·
**Carried M2 items closed:** §2 rows 4, 5, 6 and 7.

Everything in this bundle was produced by running the commands in §6. Where a
claim could not be verified by running something, it says so.

---

## 1. What shipped

| # | Deliverable | Where |
|---|---|---|
| 1 | Migration `0010_group_settings_locations.sql` | `apps/api/migrations/` |
| 2 | Typed, CHECK-constrained group-settings columns — no free-form JSON | `groups.request_until_*`, `groups.picklist_access_mode`, `groups.settings_version` |
| 3 | `locations` per doc 06 §3.2 row 237, with the free-form `site_label` | migration 0010 |
| 4 | Settings service, policies and HTTP surface | `apps/api/src/settings/**`, `apps/api/src/http/routes/settings.route.ts` |
| 5 | Contracts | `packages/contracts/src/settings/**` |
| 6 | Accessible UI (group settings + locations) | `apps/web/src/settings/**` |
| 7 | BOTH site-migration directions, as fixtures | `apps/api/test/settings/site-migration-fixtures.test.ts` |
| 8 | SBX-004 sweep floor raised for `locations` | `TENANT_TABLES` 44 → **45** |
| 9 | Three additive action keys, six additive `settings.*` audit events | `packages/domain/src/authz/catalogue.ts`, `audit/event-names.ts` |

---

## 2. The settings shapes, and what each one is grounded in

### 2.1 Request-until — a discriminated triple, not a nullable date

```
request_until_mode  text NOT NULL DEFAULT 'closed'
                    CHECK IN ('closed','fixed_date','days_before_period_start')
request_until_date       date      -- exactly when mode = 'fixed_date'
request_until_lead_days  integer   -- exactly when mode = 'days_before_period_start', 0..365
CONSTRAINT groups_request_until_shape  -- enforces "exactly the fields this mode needs"
```

| Element | Source | Classification |
|---|---|---|
| a group-level "Request Until Date" exists | research 01 §ADM-01 | `OBSERVED` |
| staff see either "(CLOSED)" or "(UNTIL `<date>`)", and the window differs per group | research 02 §4 | `OBSERVED` |
| the group's `request_until_date` **policy** is what `expires_at` is computed from, server-side, at submission | SPEC-08 §5; doc 09 §3 | design, normative |
| `closed` and `fixed_date` as distinct modes | the two observed states above | design |
| **`days_before_period_start`** | — | **`SCHEDULEPOINT-REQUIREMENT`, not observed** |

**Why three modes.** One nullable date can express two of the three states, and
it collapses *deliberately closed* and *never configured* into the same value —
NULL. That is the distinction the M5 enforcement most needs: the first is a
decision and the second is a gap, and a group whose window nobody has set must
not silently read as a group that closed it.

**`days_before_period_start` is offered for ratification with its classification
attached.** It reproduces nothing; it exists because a fixed date is a deadline
somebody has to remember to move every period, and this schema already carries
`group_holidays` for the sibling problem (CAR-011: "the deadline is Friday" is
ambiguous when Friday is a holiday). If the owner declines it, removing the mode
is a CHECK change and a contract union member — the other two modes stand.

### 2.2 Picklist access — a closed enum that can only narrow

```
picklist_access_mode text NOT NULL DEFAULT 'disabled'
                     CHECK IN ('disabled','members','members_and_proxies')
```

**What is OBSERVED is that a control exists. Nothing else.** Research 17 GAP-17
records a group-level "Pick List Access" control, found late and never
exercised; C-02 is still open and still blocking; and doc 05 §5 states the
consequence outright — *"the source's `Picklist Admin` / `Pick List Access`
semantics remain UNRESOLVED and are not asserted anywhere in this design."*

So the enum is SchedulePoint's own, and each member is grounded in
SchedulePoint's own model:

| mode | meaning | source |
|---|---|---|
| `disabled` | this group runs no picklist turns | the safe default |
| `members` | members holding the turn capability take their own turns | doc 08 §6, "Picklist: take own turn / proxy" |
| `members_and_proxies` | additionally, a proxy grant-holder may act on behalf of a member | PO-DEC-19 default scope, CAP-034 |

**The property that keeps this from becoming a fifth authorization layer:** the
setting can only ever NARROW; it never grants. PO-DEC-02's four layers decide
whether a principal may act, and when M9 enforces this it applies as an
additional AND *after* them. `members_and_proxies` confers proxy rights on
nobody — it declines to withhold them from a principal who already holds the
grant.

That is why `disabled` is the DEFAULT. A setting whose default widened anything
would be a capability expansion arriving through a migration (non-bypass rule
11). The property is stated in the migration, in the contract, in the service
header, **and on the page the administrator reads** (§5).

### 2.3 Timezone — the column existed; this packet built the audited surface

`groups.timezone` NOT NULL DEFAULT `'UTC'` landed with migration 0009
(OPUS-M3-003). This packet adds the administration surface, its capability, its
audit event, and the warning.

### 2.4 `settings_version` — a defect found by running, and the fix

The first version of this slice guarded every settings write with
`WHERE group_version = <the value this transaction read>`.
**`group_version` bumps only on a `status` change** (migration 0001,
`app_maintain_group_version`; SPEC-06 §4). The predicate therefore matched
forever: two writers read the same version, both wrote, and the second silently
overwrote the first.

`apps/api/test/settings/timezone.test.ts` caught it on its first run —
`expected 409, got 204`.

The fix is a counter of its own: `groups.settings_version`, database-owned by
`app_maintain_group_settings_version`, absent from every UPDATE grant, refusing
to decrease, and bumped **only** when one of the five settings columns moves (a
rename or a pick-position increase must not invalidate an open settings form,
which is why this bump is conditional where the catalogue's single-facet tables
are unconditional).

Making `group_version` move instead was rejected in writing: it is an
AUTHORIZATION freshness counter, and bumping it for a request-window edit would
invalidate every cached decision for the group on a change that alters no
authorization at all.

### 2.5 What is deliberately NOT here

**Enforcement.** Packet 32 §2 rows 5 and 6 assign it to M5 (SPEC-08, requests,
CAP-021..023, gate R-01..14 + QA-REQ, evidence EV-M5) and M9 (SPEC-02/03,
picklist, CAP-030 + CAP-060, gate SBX-020/022 + LIVE-SIM, evidence EV-M9).
**Nothing in `apps/api/src/` reads either setting to decide anything** —
asserted by inspection of the diff, and true by construction: the only consumer
of `readGroupSettings` is the settings route itself.

---

## 3. The site attribute (PO-DEC-01) — what exists, and what provably does not

`locations` carries `site_label text` — free-form, nullable, indexed only by a
partial index for the §3.2a forward query, referenced by nothing.

**Asserted against the live catalogues**
(`test/settings/site-migration-fixtures.test.ts`):

| Claim | How |
|---|---|
| no `sites`, `group_sites` or `shift_type_sites` table exists in `public` | `pg_class` count = 0 |
| `locations` has no `site_id` column | `information_schema.columns` |
| `locations` has no site-shaped foreign key | `pg_constraint` count = 0 |
| no site picker, no site list, no site link in the UI | e2e: the control is an `INPUT`, `select[name=siteLabel]` count = 0, `link[name=/site/i]` count = 0 |

### 3.1 BOTH directions, proven on real rows

Executed as real SQL in a per-run scratch schema (`sp_site_fixture_<nonce>`,
dropped cascade in `afterAll`) over `locations` rows written through the real
production write path, spanning **two organizations** so §3.2a's "per
organization" clause is testable at all.

| | Result |
|---|---|
| baseline | 8 locations, 2 unlabelled, 4 distinct labels, one label shared across BOTH organizations |
| **Direction 1** attribute → entity | **5 sites** — one per distinct *(organization, label)* PAIR. `Shared campus` correctly becomes TWO sites, one per tenant. Unlabelled rows linked to nothing. `site_label` RETAINED, as §3.2a's one-release rollback path requires |
| **Direction 2** entity → attribute | round trip recovered **all 8 rows exactly**. The rollback reads `sites.name`, never the retained copy — reading the retained copy would make every arm pass trivially, including the broken ones |

### 3.2 The failure arms — the round trip can fail, and does

| arm | injected bug | caught |
|---|---|---|
| **organization-blind keying** | sites keyed by label ALONE; the backfill then leaves the other tenant's rows unlinked and the rollback nulls their labels | **2 labelled rows in exactly one organization came back unlabelled** |
| **case folding** | `lower()` in the `GROUP BY` merges `Shared campus` with `SHARED CAMPUS`; the rollback writes one canonical spelling back | **1 row lost its spelling** |
| control | the correct round trip, re-run after both | exact again — so the RED arms showed a caught bug, not a damaged fixture |

### 3.3 An assumed bug that is NOT one — recorded rather than dropped

A third arm was written on the theory that omitting `where site_label is not
null` would be lossy: an unlabelled location would be given a site and the
rollback would invent a label for it.

**It round-trips exactly.** `GROUP BY` collapses all NULLs into one group, so a
single site named NULL is created; the backfill matches it with
`IS NOT DISTINCT FROM`, where NULL matches NULL; and the rollback writes that
NULL straight back.

The arm is kept, asserting the correct outcome and saying why, so the next reader
does not form the same hypothesis. What it does **not** say is that the filter is
unnecessary: the transform creates 2 meaningless site rows. The data survives;
the schema would be untidy.

### 3.4 Recorded for the exit report — §3.2a leaves two columns unsourced

doc 06 §3.2a says "Create `sites (organization_id, name, address, timezone)`"
and "populate by distinct `locations.site_label` per organization". **It does not
say what populates `address` or `timezone`.** `locations` carries its own address
and zone per place, and there is no stated rule for reducing several locations'
addresses to one site's.

The fixture leaves both NULL rather than inventing a rule. If PO-DEC-01 is ever
decided in favour of the entity, that rule has to be decided with it.

---

## 4. Authorization, audit and isolation

### 4.1 Three action keys, proposed for FAD ratification

All three **group-scoped**, in `core_scheduling`, **role-implied for
`group_admin` and held by nobody else**.

| key | covers | route capability |
|---|---|---|
| `group.settings.administer` | request-until, picklist access, and the settings READ | CAP-021 / CAP-030 |
| `group.timezone.administer` | the group timezone | CAP-021 |
| `group.location.administer` | `locations` | CAP-004 |

**Grant-only vs role-implied, from doc 08 §6.** The "Group settings / vocabulary
/ connectors" row reads `— — — — ✓ ✓` with the parenthetical "(connectors: G)".
A `✓` is role-implied and a `G` is grant-only; the row marks exactly one of its
three subjects as a grant, and it is not these. **Scheduler is `—`**, which is
why none of the three joins `scheduler` — the same line
`group.holiday_calendar.administer` and `group.pick_positions.administer`
already sit on.

**Why three and not one.** doc 08 §6 draws no line inside the row, so the split
is justified by blast radius exactly as the catalogue's three keys are:
`group.timezone.administer` is the one settings change that reaches
ALREADY-PUBLISHED history (every shift-local boundary resolves against it), the
same shape of argument that gave `group.pick_positions.administer` its own key.

**These do not expand the 58-capability baseline.** The routes declare their
`CAP-###` in `policy.capability`; these are ACTION keys, the unit SPEC-06's L4
evaluates.

### 4.2 Six `settings.*` audit events, plus one subject type

`settings.request_until.changed` · `settings.picklist_access.changed` ·
`settings.timezone.changed` · `settings.location.created` ·
`settings.location.updated` · `settings.location.archived`

New subject type: **`location`**. The three group-settings events file under the
existing `group` subject, because a request window, a picklist mode and a
timezone are properties OF the group.

**Every one of the six is DRIVEN through its real route** and read back from
`audit_events` (`test/settings/audit.test.ts`): six mutations → six rows, right
names, right subjects, right order. A denied mutation writes neither the change
nor a row. The chain verifies clean across 23 events, with a non-vacuity floor.

**Payloads are scalars only (I-07).** The site LABEL never reaches a payload —
only `hasSiteLabel`. The label is free text a person typed;
`app_audit_payload_is_closed` admits `[!-~]*` and would refuse it, but relying on
the CHECK to catch it would mean a 500 on a legitimate request.

### 4.3 Isolation — both boundaries, with non-vacuity on each

`test/settings/locations-isolation.test.ts`:

```
control: three groups populated, INCLUDING Alpha's sibling group
Alpha Group One:  2 visible, 0 wrong-organization, 0 wrong-group
Beta  Group One:  2 visible, 0 wrong on both boundaries
organization-scoped context: 0 locations visible (no organization policy exists)
FALSIFIABILITY: the same probe reports 2 wrong-organization / 2 wrong-group
                against a deliberately wrong expectation
```

The sibling-group seeding is the control the catalogue's equivalent sweep was
missing when a reviewer proved it green with the `group_id` clause removed. It is
here from the start.

---

## 5. The UI

`apps/web/src/settings/**`, routed at
`/organizations/:o/groups/:g/settings/{group,locations}`.

**Honest disclosure is on the page, not in a comment.** Both stored-only settings
say the module that enforces them is not built yet, and the picklist panel says
in words that the setting can only narrow and never grants.

**The timezone warning is before the action, not after it.** The published-version
count comes back on the settings READ, so the page can state the consequence
before the administrator acts; the acknowledgement checkbox appears only when the
SERVER reports published schedules, and the server refuses an unacknowledged
change with a field-addressed 422. A warning that appears only in an error
message arrives too late to be one.

**States captured, both viewports** (`screenshots/`, 22 files): loading ·
populated · timezone warning · timezone without published schedules · refused
(validation summary focused) · permission denied · not found · locations empty ·
locations populated · locations denied · locations at 320px.

### 5.1 Four UI defects, every one found by running

| | defect | fix |
|---|---|---|
| 1 | `page.route` on the bare base URL matched the READ and none of the writes; three tests failed against the preview server's own 404 rather than the fixture | route the base **and everything under it** |
| 2 | the 422 mapping keyed on `error.code`. `errorEnvelopeSchema` is `.strict()`, so a 422 carrying `problems` never parses as an envelope and arrives as `UNEXPECTED_RESPONSE` — **the validation summary never appeared** | match on the BODY (the catalogue client records the same finding; this file reproduced it) |
| 3 | the summary could not LINK to the acknowledgement checkbox or the request-window fields: the server addresses them as `acknowledgePublishedImpact` and `policy.untilDate`, the field-id map was keyed `acknowledge` and `untilDate` | alias the server's names onto the same DOM ids — **not** a dot in the id, which resolves in a browser and is unaddressable by every testing tool |
| 4 | 213px of page-level horizontal overflow at 320px from the six-column table | the list alternative the catalogue already established — chosen, not hidden, so the accessibility tree holds one copy of every row. The overflow assertion is now BEHAVIOURAL (scroll the page, look where it lands) rather than a `scrollWidth` proxy that flags a table scrolling correctly inside its own box |

### 5.2 Budgets — every number measured

| interaction | budget | measured (both viewports) |
|---|---|---|
| `settings-open-new-location` | **0** | 0 — I-13, and this budget can never be raised without the invariant changing first |
| `settings-save-location-accepted` | 2 | 2 — POST + server-authoritative re-read (PO-DEC-18) |
| `settings-save-timezone-accepted` | 2 | 2 — PUT + re-read. Load-bearing rather than cosmetic here: the settings response carries `settings_version`, so a client patching its own cache would save against a version it invented |
| `settings-save-timezone-refused` | 1 | 1 — a refused save does not refetch |

---

## 6. Commands, with results

| Command | Result |
|---|---|
| `corepack pnpm install` | ok |
| *(environment)* | `SP_TEST_PREVIEW_PORT=4212` for every browser run. The preview port defaults to a FIXED 4173 with `--strictPort`, and a concurrent review worktree held it — the axe gate failed with "4173 is already used" until the override was set. That is the E-2 class the playwright config's own header describes (loud and harmless, unlike a database-port collision), and it is the review's NB-7 follow-up |
| `corepack pnpm check` | **13/13 PASS**, exit 0 — 92 files, **1128 tests** passed. Full log: `check-output.txt` |
| `corepack pnpm red-cases` | **16/16 PROVEN**, exit 0. Full log: `red-cases-output.txt` |
| `corepack pnpm fixture-regression` | **88/88 passed, 0 failed**, exit 0 — 13 fixed seeds + rotating seed **621481**, each 821/821 under file- AND test-order shuffle, plus the per-file standalone sweep and the baseline-immutability control. Log: `fixture-regression.txt`. Failed 11/88 on its FIRST run, which is how the order dependence in §7.4(a) was found |
| `corepack pnpm sbx` | **6/6 PASS**, 0 blocked, 0 vacuous, every probe FALSIFIABLE. SBX-004: 308 (role, context, table) readings across 7 contexts, **0 wrong-tenant rows, 44 of 44 tables observed with visible rows** — the floor rose from 43. See `sbx-run.txt`, `sbx-004-sweep.txt` |
| `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | **MIGRATION CYCLE CLEAN — up → down → up → down → up, 1255 ms**, `0001..0010`. Log: `migration-cycle.txt` |
| settings suite, standalone | 6 files, **68 tests**, all passing |

### 6.1 Standalone verification

Every settings test file was run **alone** as well as in the package suite and
in the full battery. All three results agree.

| file | standalone | in `pnpm check` |
|---|---|---|
| `test/settings/schema.test.ts` | 13 pass | pass |
| `test/settings/authorization.test.ts` | 20 pass | pass |
| `test/settings/audit.test.ts` | 15 pass | pass |
| `test/settings/timezone.test.ts` | 6 pass | pass |
| `test/settings/locations-isolation.test.ts` | 5 pass | pass |
| `test/settings/site-migration-fixtures.test.ts` | 9 pass | pass |

---

## 7. Deviations, and one glob escalation

### 7.1 `packages/domain/src/authz/cross-product.ts` — disclosed glob deviation

Packet 32 §10c names `packages/domain/src/authz/catalogue.ts` for the settings
action keys. **The role seed that makes those keys reachable lives in
`cross-product.ts`** (`SYSTEM_ROLE_CAPABILITIES`), which the packet's
"everything else" prohibition covers.

The edit is three entries appended to `group_admin` and nothing else. The
alternative — declaring the keys grant-only — would contradict doc 08 §6, whose
"Group settings" row is a `✓` and not a `G`, and would leave group settings
unreachable for the one role the document assigns them to.

**Disclosed here and in the return report for ratification alongside the keys.**

### 7.2 Pure validation lives in contracts, not domain

The catalogue puts its pure rules in `packages/domain`. This packet's allowed
globs give it only `event-names.ts` and `authz/catalogue.ts` in that package, so
field-level validation is expressed as zod refinements in
`packages/contracts/src/settings/**` and semantic validation in
`apps/api/src/settings/`. No rule is weaker for it — the database enforces every
one independently — but the placement differs from the catalogue's and is
recorded rather than left to be noticed.

### 7.3 Two "Group settings" pages now exist

`apps/web/src/catalogue/GroupSettingsPage.tsx` (OPUS-M2-002) holds the
pick-position count and the holiday calendar at `/catalogue/group-settings`.
Packet 32 §10a freezes that file to this packet, so the new settings section
lives at `/settings/group` beside it rather than being merged by a packet that
may not touch one of them.

**Consolidating the two belongs to OPUS-M3-008**, which owns composition.

### 7.4 Two fixture defects the batteries found, and what each cost

Both were found by running, not by reading, and both are recorded because the
class matters more than the instance.

**(a) An order dependence in this packet's own test file.**
`corepack pnpm fixture-regression` failed **11 of 88 runs** — every fixed seed.
`settings/authorization.test.ts` asserted the DEFAULTS (`closed` / `disabled`)
inside the "a group administrator reads the settings" test; under test-order
shuffle the picklist-access write ran first, so the test was reading what a
sibling had left behind. That is exactly the coupling FAD-15's shuffled run
exists to find, and it was in the new file.

The read test now asserts the SHAPE; the defaults claim moved to its own test
against a group this file never writes to, read as ground truth. Order-independent
**and** a stronger claim — it is about the column defaults migration 0010
declares rather than about whatever ran last.

**(b) The SBX fixture was asserting the opposite of the model.**
The location seeding granted `group.location.administer` to
`alpha.users.scheduler` and left the grant open. SBX-001's role ×
registered-surface matrix then printed:

```
scheduler(G1+G2)  …  GET settings/locations=200  POST settings/locations=422
```

True of that principal — it held an explicit grant — and badly misleading on a
row labelled by ROLE, since doc 08 §6 puts scheduler at `—` for group settings.
A reviewer reading the matrix would reasonably have concluded the opposite of the
model this packet implements.

Two changes: Alpha Group One is seeded by the GROUP ADMINISTRATOR, who holds the
key by role and needs no grant at all; the other two groups get a **temporary**
grant that is closed (`valid_to = now()`) the instant the rows are written, in a
`finally` so a failed seed cannot leave a live administrative grant behind. The
rows persist — the capability trigger fires on INSERT/UPDATE, not SELECT — so
SBX-004 still observes `locations` non-vacuously.

The matrix now reads exactly as doc 08 §6 specifies:

| principal | `GET /settings` | `PUT /settings/*` | `GET /settings/locations` | `POST /settings/locations` |
|---|---|---|---|---|
| `scheduler(G1+G2)` | 403 | 403 | 403 | 403 |
| `member(G1)` · `viewer(G1)` · `telecom(G1)` · `group-only` | 403 | 403 | 403 | 403 |
| **`group_admin(G1)`** | **200** | **422** *(authorized, reached validation)* | **200** | **422** |
| `org_admin` | 404 | 404 | 404 | 404 *(organization-scoped context, group-scoped route)* |
| `departed(ended)` | 401 | 401 | 401 | 401 |

### 7.5 A no-op write is not audited as a change (review NB-1)

The independent review probed `UTC → UTC` on `PUT /timezone` and got
`settings.timezone.changed` with identical `from` and `to`; the same shape held
for request-until, picklist-access, and a location PATCH carrying only
`expectedVersion`.

The DATABASE was already correct — `app_maintain_group_settings_version` uses
`IS DISTINCT FROM`, so `settings_version` never moved. That is precisely what
made the audit row wrong: it recorded a transition that did not occur, and an
incident review counts those.

**All four routes now emit nothing when nothing moved**, and the write is still
a success on the wire — the caller asked for a state and that state holds. The
CAS is unaffected: a stale `expectedVersion` still loses with a 409 even when
the value it carries happens to match.

**Why silence rather than a distinct "unchanged" event name.**
`AUDIT_EVENT_NAMES` is a CLOSED list that only ever grows (non-bypass rule 13)
and one name means exactly one thing. Four permanent names recording that
nothing happened would be four names no query wants and no retention rule can
drop — and there is nothing to attribute, because the state transition the event
would describe did not occur. It is the same reason a denied mutation writes no
row.

**The location case draws a distinction worth stating.**
`app_maintain_catalogue_version` bumps `locations.version` unconditionally, by
design: "a writer that read version N and wrote nothing still has to lose to a
writer that read N and wrote something" (migration 0005). That is a concurrency
property and it is correct. It is not a statement that the location changed, so
`changed` compares the DOMAIN fields (name, site label, address, zone, status)
and the no-op probe asserts both facts — zero audit rows **and** a bumped
counter.

Five tests cover it, including a **CONTROL** proving all four routes still emit
exactly one correctly-named row when something really moves — without it, "zero
events" would be satisfied by four routes that had simply stopped auditing.

**The change had a consequence the battery found.** Making a no-op silent means
a test that requests a FIXED value can now be a no-op if a sibling test already
left the group there. `pnpm fixture-regression` failed **6 of 88** immediately
after the NB-1 fix — each failing seed missing
`settings.picklist_access.changed`, because under test-order shuffle the new
CONTROL had already set the mode to `members`. The six-route test now chooses
every requested value RELATIVE to the current state, which makes "six mutations
produce six rows" true in every order. Re-run: **88/88, 0 failed**.

### 7.6 The acknowledgement is read, never derived (review NB-2)

`publishedImpactAcknowledged` was computed as `publishedVersionCount > 0`
instead of reading the client's `acknowledgePublishedImpact`. Behaviour was
fine — the route already refuses unacknowledged writes — but the audit field
asserted a human act the payload never read, and a derived field that is right
by coincidence becomes wrong the first time the surrounding rule changes.

The value is now carried from the parsed request through `setTimezone` into the
payload. The discriminating test runs on a fixture with **zero** published
versions, where the derived answer would be `false` and the client sends `true`:
the row records `true`. A second test sends `false` and gets `false`.

### 7.7 The settings READ is gated by the same key as the writes

There is no `group.settings.read`, for the reason the catalogue's equivalent
decision gives: inventing a read capability means inventing which roles hold it,
and doc 08 §6 has no row to read that off. Deny-by-default is the correct
direction to be wrong in (I-02).

The refinement the catalogue's decision later needed — the D-10 holiday-read
ruling, where a scheduler authored holiday demand without being able to see the
dates — does not apply: no non-administrator surface in this milestone displays a
group's request window or picklist mode. If M5 or M9 needs a non-administrator
read, it declares its own action then.

---

## 8. Recorded to the M3 exit report — NOT resolved here

### 8.1 The timezone display-semantics question

Packet 32 §10c: *"the display-semantics question is recorded to the exit report"*.

**The question.** After a group's timezone changes, should an already-published
assignment render at its **original wall-clock time** (07:00 stays 07:00, so the
absolute instant it names moves) or at the **new zone's equivalent of its stored
instant** (the instant is preserved, so the displayed time changes)?

**What this packet did NOT do.** It did not decide, and it changed nothing that
would presume an answer.

**What is proven, narrowly and by running:** *no stored instant moves.*
`assignment_snapshots` carries `timestamptz` — absolute instants — and
`test/settings/timezone.test.ts` asserts that all 4 snapshot instants in the
fixture are byte-identical across two zone changes. A published snapshot is
immutable at the database anyway (D-15a), so a migration that "helpfully" shifted
them would be refused; the API does not attempt it either.

**Why it matters.** The two readings differ for every staff-facing view, every
report, and every calendar rendering of a period that straddles the change. It is
a product decision, and OPUS-M3-006 (staff-facing views) is the surface that will
have to render whichever answer is given.

### 8.2 doc 06 §3.2a does not say what populates `sites.address` / `sites.timezone`

See §3.4.

---

## 9. Limitations, stated plainly

1. **Enforcement of two of the three settings does not exist**, by design. They
   are stored, validated and audited; M5 and M9 own the gates. The UI says so on
   the page.
2. **The e2e suite intercepts the API at the browser's network boundary.** It
   proves the interface behaves correctly for each response; the server is proven
   to produce those responses separately, over HTTP, against the real database,
   in `apps/api/test/settings/*.test.ts`. That division is the catalogue's and is
   restated rather than assumed.
3. **No real-AT session was run.** SPEC-14's `M` cells remain honestly unclaimed
   (packet 32 §2 row 12; M6 owns them). What is claimed here is axe-clean at both
   viewports plus keyboard journeys, which is what was actually executed.
4. **`locations.address` is free text** in an administrative authoring path. doc
   06 classifies `locations` sensitivity `NONE`; an address is a place, not a
   person; and this is not a protected ingestion path (SPEC-03), so non-bypass
   rule 8 is not engaged. It is length-bounded and trimmed so a form does not
   become a notes field.
5. **A grant-only holder of `group.location.administer` with no settings key**
   can maintain locations and not read the group's other settings. That is the
   intended narrowing, not an artefact — but it is stated because the catalogue's
   equivalent edge (S-10) was not, and had to be ruled on later.

---

## 10. Files in this bundle

| File | What it is |
|---|---|
| `INDEX.md` | this document |
| `check-output.txt` | the complete `corepack pnpm check` log, 13/13 |
| `red-cases-output.txt` | the complete `corepack pnpm red-cases` log, 16/16 |
| `fixture-regression.txt` | the fixture-regression run |
| `sbx-run.txt` | the SBX battery, with the raised sweep floor |
| `migration-cycle.txt` | `0001..0010` up → down → up → down → up |
| `screenshots/` | 22 state captures, 11 states × 2 viewports |
