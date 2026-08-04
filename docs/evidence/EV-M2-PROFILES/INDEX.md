# EV-M2-PROFILES — effective-dated work profiles, FTE targets, qualifications

**Task:** OPUS-M2-003 · **Capabilities:** CAP-013 (weekday-variable FTE, maximum
assignments, work percentage) · CAP-058 (qualifications, credentials, expiry,
eligibility) · **Branch:** `opus/m2-003-profiles` · **Packet:**
[30-m2-task-packets.md](../../fable/30-m2-task-packets.md) §OPUS-M2-003, as
revalidated by §7.

**API-first. This packet ships no UI**, and that is a recorded sequencing
decision rather than a dropped capability: OPUS-M2-002 builds the shared form and
list foundation for the whole milestone in a parallel worktree, and profile
surfaces follow once it exists. Both capabilities remain `REQUIRED FOR
PRODUCTION`.

---

## 1. The artifacts in this bundle

| File | What it is |
|---|---|
| `INDEX.md` | this document |
| `check.txt` | `corepack pnpm check` — the twelve gates, from clean |
| `red-cases.txt` | `corepack pnpm red-cases` — every gate proven to fail on its violation |
| `fixture-regression.txt` | `corepack pnpm fixture-regression` — fixed seeds + rotating, both shuffles, standalone sweep, Layer-1 control |
| `sbx-004-sweep.txt` | the re-run SBX-004 cross-tenant sweep, showing the four new tables **observed with visible rows** |
| `migration-cycle.txt` | `up → down → up → down → up` against a throwaway embedded cluster |
| `named-proofs-standalone.txt` | the three named-condition proofs run **standalone** |
| `named-proofs-in-package.txt` | the same three run **in their package suite** |
| `round-trip.txt` | create → future-date → supersede → read history, over HTTP |
| `deny-paths.txt` | allow **and** deny per capability, plus the SENSITIVE-PII narrowing |
| `history-immutability.txt` | the database refusing every history rewrite, and the one-selector scan |
| `sbx-run.txt` | the whole SBX subset re-run |

Every capture is the verbatim output of the command named in its first line, and
**every one comes from a single coherent battery run** taken with
`SP_TEST_PG_PORT=55437`, for the reason in §1a. The `axe` gate passes **in band**
in this run — the port-4173 contention described in §1a E-2 is real and did strike
earlier runs, but it did not strike this one, so there is no isolated re-run to
reconcile.

| Command | Result |
|---|---|
| `corepack pnpm check` | **12 / 12 gates**, 49 test files, **739 tests** |
| `corepack pnpm red-cases` | **14 / 14 PROVEN** |
| `corepack pnpm fixture-regression` | **47 / 47** — 11 fixed seeds, rotating seed 24873, the 35-file standalone sweep, the Layer-1 control |
| migration cycle | `up → down → up → down → up` CLEAN, schema verified empty after `down` |
| `corepack pnpm sbx` | 4 PASS + 1 EVIDENCE_BLOCKED(authn), 0 vacuous, 0 probe-error; **17 tables exercised**, the four new ones each observed with visible rows |
| named proofs | **standalone** 7 / 4 / 8 (+ domain 36 / 8) · **in-package** 41 files, 646 tests · **in battery** within the 739 above |

The four new tables in the SBX-004 sweep, from `sbx-004-sweep.txt`:

```
membership_work_profiles: max 1 visible (app_runtime/runtime/organization)
membership_weekday_fte:   max 8 visible (app_runtime/runtime/organization)
qualifications:           max 1 visible (app_runtime/runtime/organization)
qualification_holdings:   max 1 visible (app_runtime/runtime/group-one)
```

The last line is the SENSITIVE-PII narrowing visible in the sweep itself:
`qualification_holdings` is the only one of the four **not** readable from an
organization-scoped context, and `app_readonly_support` is refused outright
(42501, recorded distinctly) because it holds no EXECUTE on the capability helper
its policy calls.

---

## 1a. TWO ENVIRONMENT FINDINGS THAT AFFECT EVERY CONCURRENT TASK

Both were found by running this packet in parallel with OPUS-M2-002, and neither
is a property of this diff. They are recorded here because the next pair of
concurrent agents will hit them on their first command.

### E-1 · Concurrent worktrees share the embedded-postgres port **by default**

`apps/api/test/support/env.ts`:

```ts
export const CLUSTER_PORT = Number.parseInt(process.env['SP_TEST_PG_PORT'] ?? '55433', 10);
```

The docblock says the override exists "so two worktrees can each override it
(execution standards §E: concurrent agents never share a database instance)".
**Nothing sets it.** `.worktrees/m2-002` and `.worktrees/m2-003` therefore derive
the same port *and* the same data-directory name
(`apps/api/.pgdata-test-55433`, since the directory is derived from the port),
and the two agents' suites destroy each other's clusters.

Observed here as the exact signature the runbook documents — whole test *files*
failing with tests *skipped* and **zero tests failed**, and sub-second runs
reporting `(no summary)`. Confirmed by `lsof`: the process holding 55433 had
`cwd = .worktrees/m2-002/apps/api/.pgdata-test-55433`.

Every capture in this bundle was taken with **`SP_TEST_PG_PORT=55437`**, and each
one says so in its first line. Suggested standing fix: derive the default from
the worktree path, or set the variable in the worktree bootstrap, so that "each
agent gets its own worktree and branch" implies its own database without anybody
remembering.

### E-2 · The Playwright preview port is fixed at 4173 and cannot be overridden

`apps/web/playwright.config.ts` hard-codes
`vite preview --port 4173 --strictPort` with `reuseExistingServer: false`. Two
concurrent worktrees cannot both run the `axe` gate, and there is no environment
variable to separate them. `apps/web/**` is OPUS-M2-002's exclusive scope this
milestone, so this task could not fix it.

A second, incidental discovery while diagnosing it: a `vite preview` process from
**`.worktrees/opus-m0-002`, a worktree deleted two days earlier**, was still
holding 4173. It was cleared (only that orphan — the live sibling's server was
left alone). The runbook's standing port-hygiene discipline covers the postgres
cluster; it does not yet cover the preview server, and this is the case for
extending it.

---

## 2. What was built

### 2.1 Schema — `apps/api/migrations/0004_work_profiles_qualifications.sql`

Four tenant tables, each with RLS **enabled, forced and policed in the same
migration**, composite tenant foreign keys, and tenant-qualified unique keys.

| Table | Shape | The control that matters |
|---|---|---|
| `membership_work_profiles` | membership-scoped, `effective_from`/`effective_to`, work percentage, three maximum-assignment fields | **`EXCLUDE USING gist (organization_id, membership_id, tstzrange(effective_from, effective_to, '[)'))`** — one authoritative row in force is a property of the schema |
| `membership_weekday_fte` | per profile version × `day ∈ {mon..sun, holiday}`, `fte_fraction`, `max_assignments` | INSERT-only: no runtime role holds UPDATE or DELETE, because a change to a weekday target is a change to the arrangement and supersedes rather than overwrites |
| `qualifications` | group vocabulary: `key`, `name`, `requires_expiry`, `issuing_body`, `status` | archive-not-delete, enforced for the table OWNER by `app_guard_qualification_delete` and not only by a missing grant |
| `qualification_holdings` | membership × qualification × `valid_from`, `valid_until`, `evidence_ref`, `status` | **`SENSITIVE-PII`**: the SELECT policies carry a capability predicate, so the narrowing is in the data rather than in a handler |

An open end is spelled `NULL`; a `*_finite_window` CHECK refuses `infinity`
(S-22). Window bounds are stored at **millisecond precision** — see §4.1.

### 2.2 The shared in-force loader — the centrepiece

- `packages/domain/src/profiles/in-force.ts` — **one window predicate**
  (`containsInstant`, `[from, to)`) and **one selection rule** (`selectInForce`),
  pure, no clock, no database.
- `apps/api/src/profiles/in-force-loader.ts` — the **only** module that selects
  from an effective-dated table. `workProfileWriteContext` returns the row to
  supersede, the next scheduled start and the history from ONE load, so a writer
  cannot bound a window against one view of history and supersede against
  another.
- **There is no tie-break.** Two rows in force means the EXCLUDE constraint has
  been dropped or bypassed; `selectInForce` returns `ambiguous` and
  `requireInForce` throws, which inside a unit of work rolls the transaction
  back. A tie-break is what an arbitrary-row loader looks like once someone has
  tidied it up.
- **"No row in force" is four facts, not one**: `no-rows`, `before-first`,
  `after-last`, `gap`. Each is reported by name, on the wire as well as in the
  domain. Collapsing them is what makes an effective-dating defect unreadable
  from a log line — which is how S-01 survived a milestone.

### 2.3 API

Eight routes under `/organizations/:organizationId/groups/:groupId`, each
declaring a SPEC-06 action and evaluated by the shipped evaluator inside the same
unit of work as its mutation and its audit row (FAD-12). Six new action keys,
six new audit event names, three new audit subject types, four tables registered
in `TENANT_TABLES` in the same change as the migration (packet §7.2).

---

## 2a. Fixture seeding — the orchestrator's ruling, and the interim it creates

**Fable's ruling, mid-task:** do not modify `apps/api/test/support/multi.ts` or
`owned-multi.ts`; satisfy packet §7.2 with an **additive per-file fixture module**
of this task's own, called from the files whose assertions need visible rows in
the new tables. OPUS-M2-002 did the same (`catalogue-fixture.ts`, untouched here).

This task's module is **`apps/api/test/support/staffing.ts`**. It writes through
the production path — real `capability_grants` rows, real guard triggers, the
two-person rule enforced — and is called from the three files whose assertions
iterate `TENANT_TABLES` and require visible rows:

| File | Why it needs rows |
|---|---|
| `test/sbx/sbx.test.ts` | SBX-004's non-vacuity check fails a registered table nobody ever saw a row in |
| `test/red-cases/probe-is-not-vacuous.test.ts` | the wrong-tenant probe must have rows to be wrong about |
| `test/tenancy/unit-of-work.test.ts` | the T-15 storm sweeps every registered table |

`multi.ts` and `owned-multi.ts` are **unmodified** (`git diff --name-only
main...HEAD` confirms).

**KNOWN INTERIM, per the ruling:** the structurally correct home for both tasks'
seeding is `provisionMulti`, so that "every registered tenant table has rows" is a
property of the fixture rather than of three call sites remembering. Consolidating
them is **integration-packet scope** and is anticipated there. Until then, a
fourth file that iterates `TENANT_TABLES` will have to add the call itself, and
nothing fails loudly to remind it — that is the cost of the interim and it is
recorded rather than absorbed.

One detail worth carrying into the consolidation: `seedStaffingRows` **closes its
own grants when it is done**. SBX-001 attempts every route as every principal
with an empty body, so leaving the seeding actor holding
`staffing.work_profile.administer` made its cell a `400 …_BODY_MALFORMED` — a
state the matrix's oracle does not model. Closing the grants leaves the rows for
SBX-004 while every SBX-001 cell on these routes is a clean deny. The alternative
was widening the oracle to accept a fourth class, which is weakening a control to
fit new code.

---

## 2b. The independent second review, and what it changed

**Verdict: APPROVE WITH FOLLOW-UPS**, eight findings, none blocking. The
centrepiece held under reviewer-authored attack — an 11-instant boundary battery,
a constructed ambiguity arm, supersession races, owner-level history-rewrite
attempts and a SENSITIVE-PII mutation test all came back correct. What the review
found instead were things that were *written down and not enforced*, which is the
more useful failure to find.

| | Finding | Disposition |
|---|---|---|
| **T-01** | Retroactive history **CREATION** was reachable while the contract claimed the database refused it | fixed, see §4.7 |
| **T-02** | A supersession silently zeroed the weekday/holiday targets | fixed, see §4.8 |
| **T-03** | The migration comment lumped `app_breakglass` under "RLS still narrows" — it has `BYPASSRLS` | comment split; §5 item 7 |
| **T-04** | Three evasions walked past the one-selector scan | scan strengthened, three red cases + a mutation test |
| **T-05** | The profile tables lacked the owner-binding DELETE guards the migration's own rationale demanded | added; regression asserts all four |
| **T-06** | The six audit events carried no payload, and three qualification mechanisms were indistinguishable | fixed, see §4.9 |
| **T-07** | A production `sequence::text` instance in `src/audit/verification.ts` | **not this task's** — out of these globs, queued as a micro-packet with the test-side sites |
| **T-08** | Three five-vs-six count comments | corrected |

### T-04 in a little more detail, because the evasions are the interesting part

The scan was pattern-only, and a pattern can be walked around. It was, three
times: `db.selectFrom(PROFILES)` where `PROFILES` is a `const`;
``sql`… from "membership_work_profiles"` `` with a quoted identifier; and a
`.returning(['effective_from', …])` reading window state off the back of a write.

The rule now has **two halves**, and the second is the one that cannot be evaded:

1. **read forms** — `selectFrom`, joins, raw `FROM`, quoted or not;
2. **naming the table at all**, outside a short allowlist (`db/schema.ts` and the
   two writers, each with a written reason) — which catches the `const`
   indirection and any spelling nobody has thought of yet, because **every evasion
   has to write the table's name down somewhere**;
3. **`.returning()` naming an effective-dated column** — a finding *even inside an
   allowlisted writer*, since it is a second view of effective-dated state.

A mutation test empties the allowlist and asserts the shipped writers become
findings, so the allowlist is demonstrably the control rather than a decoration.

---

## 3. Deliberate divergences from written documents

Both are disclosed here rather than absorbed, and both need an orchestrator
ruling before merge.

### D-1 · `membership_weekday_fte.day` extends doc 06 §3.2's `weekday (0–6)`

Doc 06 §3.2 gives the key field as `weekday (0–6)`. The packet requires "per
weekday {Mon..Sun} **+ holiday** targets", and a holiday is not a weekday number.
The column is `day text` over the closed set `{mon..sun, holiday}` — **the same
eight-member domain FAD-16 already established for
`shift_type_weekday_demand`** at OPUS-M2-002's issuance, so M2's two
demand/target dimensions agree rather than each inventing a spelling.

Implemented rather than escalated because the packet specifies the shape itself:
the escalation trigger is "doc 06's shape proves insufficient **for the owner's
target list**", and the packet resolved that by naming the holiday dimension in
its own required-implementation text. **It needs a dated additive amendment to
doc 06 §3.2 of exactly the kind FAD-16 made for M2-002.**

### D-2 · `apps/api/test/authz/schema.test.ts` — a kernel-control scope change

The M1 assertion read: *no policy **anywhere** calls `app_acting_membership_holds`
— that would be infinite recursion.*

Its own stated rationale is narrower: the helper reads `memberships`,
`capability_grants`, `roles` and `role_capabilities`, and a policy on one of
**those** would re-enter that table's own policy evaluation (FAD-11 escalation
3).

`qualification_holdings` needs a capability predicate **in a SELECT policy**: 06
§3.2 classifies it `SENSITIVE-PII`, so who may read another member's credentials
must be decided in the data, and a read is not something a trigger can gate. The
grant-aware helper is the only one that can answer it, because all six staffing
capabilities are grant-only (`SYSTEM_ROLE_CAPABILITIES` is OPUS-M1-002's file and
was not edited).

The check now derives the forbidden set from the helper's **own body**, and
additionally asserts that the probe IS called from at least one policy so the
narrowing cannot pass vacuously. That is stronger in one direction — a future
change making the helper read `qualification_holdings` fails the test with no
list to remember to update — and narrower in exactly one: a policy on a table the
helper does not read is now permitted.

**No recursion exists** and it is measured, not argued: the full battery, the
SBX-004 sweep and the SENSITIVE-PII probes all execute these policies. But this
is a change to the scope of an M1 kernel control and it is the orchestrator's
call, not the implementer's.

**The alternatives, so the ruling is informed:**

1. *Role-only helper* (`app_acting_membership_role_holds`, which 0002's policies
   already use). Cannot work: the staffing capabilities are grant-only, so it
   answers `false` always and nobody can read or write anything.
2. *Application-layer narrowing.* Permitted by the packet's wording ("role-gated
   and tested") and strictly weaker: a filter in a handler is one a future query
   can simply not call. `authorization.test.ts` includes a direct table read that
   would pass under this option and currently proves the opposite.
3. *Add staffing capabilities to system roles.* Out of this packet's file scope
   and a product decision about what a `scheduler` implicitly holds.

---

## 4. Defects found and fixed during implementation

Recorded because each was found by a control rather than by reading, and the
control is the interesting part.

### 4.1 Window bounds could not round-trip (found by the round-trip test)

`now()` has microsecond resolution; JavaScript `Date` and ISO-8601 over JSON have
millisecond resolution. A bound written with bare `now()` came back from the API
up to 999 µs earlier than it was stored — and because a successor's start is
written from its predecessor's end, that difference opens a **sub-millisecond
period with no profile in force**: invisible in every human-readable rendering,
perfectly real to the selection rule.

Every bound the schema chooses for itself is now
`date_trunc('milliseconds', now())` — column defaults, the writer, and the
retroactive-close guard, so all three agree on what "now" is. `created_at` /
`updated_at` keep full `now()`: they are observations, never boundaries.

### 4.2 A closed window is not the same thing as history (found by the round-trip test)

The first history guard refused every UPDATE to a row with a non-NULL
`effective_to`. But authoring a change for next month bounds the CURRENT row
immediately, at an instant that has not happened yet — so scheduling a future
change made it impossible to change anything today, and the answer to "reduce
this person's FTE now" became a `409` with no explanation.

History is the part of a window that has already **elapsed**. The rule is now:
**a window may only be SHORTENED, and only into the future.** Three things are
admitted (close an open end at ≥ now; bring a future-bounded end forward to ≥
now; nothing else) and everything else is refused, for the table owner as well as
the runtime roles.

The writer gained `nextWindowStart`: an immediate change authored while a future
one is pending opens `[now, scheduled)` rather than `[now, ∞)`, so the scheduled
change still takes effect exactly when it was scheduled to.

### 4.3 Body validation ran before authorization (found by SBX-001)

SBX-001 attempts every registered route as every role-bearing principal with an
empty body. These routes parsed the body first, so an unauthorized caller
received `400 …_BODY_MALFORMED` — learning that the route exists, that it takes a
body, and by iterating, what shape it has.

Every handler now evaluates the capability first. A `400` is reachable only by a
caller who was allowed to make the request at all. The `?at=` query parameter
moved inside the same boundary for the same reason.

### 4.4 A pre-existing ORDER BY sorted a bigint as text (found by rotating seed 531651)

Not this task's defect, and that is measured rather than argued: it reproduces
unchanged on `main` at `20b9f7f` in a scratch worktree.

```sql
select sequence::text as sequence from audit_events
 where organization_id = $1 order by sequence desc limit 1
```

PostgreSQL resolves an unqualified `ORDER BY` to the **output column** when one
has that name, so this sorted the bigint **as text**: `'9'` came out above
`'14'`. Correct for the first nine events of a chain, wrong from the tenth — and
how many events ALPHA's chain holds when `chain.test.ts`'s R-04 runs depends
entirely on which siblings ran first, which is why only some orderings reach it.

Three sites carried the trap. A fourth (`chain.test.ts:489`) is correct, because
its output column is named `h` and `ORDER BY` there resolves to the table column.

| Site | Fix | Had it ever failed? |
|---|---|---|
| `chain.test.ts` R-04 | `max(sequence)`, which cannot be shadowed | yes — this is the failure |
| `chain.test.ts` X-01 | output alias renamed to `seq` | **no** — it silently tampered with whichever row sorted second *lexicographically* |
| `periodic.test.ts` | output alias renamed to `seq` | **no** — same |

The two that never failed are the more interesting half: two security tests were
aiming at a row nobody chose, and passing.

R-04's precondition is now *established* rather than assumed — it appends until
the head is one no checkpoint names, instead of assuming a single append suffices,
which was an assumption about the other tests rather than a precondition of its
own.

**Seed 531651 should join `FIXED_SEEDS` per FAD-15 ruling 3.** That file is
`scripts/sbx/**`, outside this packet's allowed paths, so it is left for the
orchestrator; the seed is pinned in `fixture-regression.txt` in the meantime.

### 4.5 This task's own round trip was order-dependent

`corepack pnpm fixture-regression` reported it green standalone and **red on all
eleven fixed seeds plus the rotating one**: each phase of the round trip was its
own `it` reading an id the previous `it` had assigned. Fixed with the memoised-
precondition pattern `sbx/sbx.test.ts` already uses — the sequence still runs
once, in order, while each assertion stands alone.

### 4.7 History could not be rewritten — and could be AUTHORED (T-01)

`app_guard_work_profile_history` refuses every UPDATE that touches elapsed time,
so history cannot be **rewritten**. It said nothing about history being
**created**: an INSERT dated 2005 into a gap is a well-formed row that the EXCLUDE
constraint is perfectly happy with, and it changes what the in-force answer *was*
for a period that has already been scheduled against. The contract comment claimed
the database refused it. It did not, and it could not — `effective_from >= now()`
is not expressible as a CHECK, because `now()` is not immutable.

**Refused at the service, with a 422**, and the contract now names the enforcing
layer instead of the wrong one. The layer is deliberate: the ruling scoped
retroactive-history authoring out of this packet, and the layer that refuses it
today should be the layer that is later given the capability to permit it.

Tested at both no-row shapes, because they reach different branches of the
selection rule — an instant **before the first window**, and one **inside a gap
between two windows** — each asserting no row written and no audit row, with a
future-dated green control so the rule cannot degenerate into "rejects every
explicit instant".

**Carried forward (see §5 item 8):** retroactive authoring is a legitimate future
administrative capability. It needs its own decision, a richer audit shape than
this one, and its own packet.

### 4.8 A supersession silently discarded the weekday dimension (T-02)

"Reduce this person to 60%" is the most common call this surface takes. It names a
percentage and nothing else — and the new profile version was written with **no
weekday targets at all**, destroying the per-day and holiday dimension CAP-013
exists to hold and the M4 engine will consume. Nothing failed: losing data the
caller never mentioned looks exactly like not having been asked for it.

Omission and emptiness are now different statements:

| | |
|---|---|
| `weekdayTargets` omitted | the predecessor's targets are **carried forward** as copies |
| `weekdayTargets: []` | cleared, on purpose |
| `weekdayTargets: [...]` | replaced wholesale |

Both arms are tested, the semantics are on the contract field, and the
`authored` audit payload records `weekdayTargetsCarriedForward` — so an auditor
can tell whether a version's day dimension was stated or inherited.

### 4.9 The audit events carried no before/after (T-06)

The packet's audit requirement names five fields: actor, on-behalf-of,
before/after, mechanism, correlation id. Four come from the chain columns and
`uow.context`; **before/after and mechanism are the two a caller must supply**,
and none of the six events supplied either. An event that says only "a profile was
authored" cannot answer "what changed", which is the question an audit review
actually asks.

All six now carry both. Two decisions worth stating:

- **`staffing.qualification.written` keeps its name** and gains
  `mechanism ∈ {create, retire, reinstate}` rather than being split into three
  names. Splitting would mean retiring a name already in `AUDIT_EVENT_NAMES`,
  which is exactly what non-bypass rule 13 forbids — cheap today on an unmerged
  branch, and precisely the habit the rule exists to prevent. The before/after
  status pair says the same thing a second way.
- **The `evidence_ref` VALUE is excluded**, recorded as `hasEvidenceRef: boolean`.
  Two independent reasons: the column admits 128 characters and the closed payload
  admits 64, so it does not always fit; and a pointer to a credential document
  does not belong duplicated into an append-only table that is never deleted. What
  an auditor needs is whether evidence was recorded.

`qualifications.key` gained a token CHECK (`^[a-z0-9][a-z0-9._-]{0,63}$`) in the
same change, and that is what makes it safe to carry at all —
`app_audit_payload_is_closed` refuses any string with a space, so a free-form key
would have made every qualification audit row a 500 the first time somebody typed
two words. `name` and `issuing_body` are display text and never appear.

### 4.10 A test expectation was wrong and the kernel was right

The first version of `authorization.test.ts` asserted `404` for a denial. SPEC-06
P-6 makes an **L4** denial a `403`: reaching L4 required an active membership in
the declared tenant, so the tenant's existence is not a disclosure. The test was
corrected, not the kernel.

---

## 5. Known limitations, recorded rather than implied away

1. **Retroactive correction of an elapsed window is not supported.** A window
   that has already ended is immutable; a correction takes effect from now, as a
   new row. This is the packet's rule ("administrative corrections create new
   rows … never UPDATE history") followed literally. If the product later needs
   "this person's arrangement actually ended last Friday", that is a schema
   change with a bitemporal dimension, not a relaxation of this guard.
2. **`qualification_holdings` has no organization-scoped read policy.** An
   organization-scoped context sees only its own acting membership's holdings.
   Administering someone else's credentials is a group-scoped action performed in
   the group the credential applies to. Deliberate; stated so a later "why can't
   the org admin see this" is answered.
3. **The expiry job does not exist.** CAP-058 names an expiry-warning job; the
   status machine that a job would drive is enforced at the database, and the
   transitions are exercised, but nothing moves a holding from `valid` to
   `expiring` on a schedule. That is a later milestone's work and no capability is
   dropped by its absence.
4. **`shift_type_qualifications` is not here.** Integration-packet scope
   (packet §5), by construction: it joins this packet's tables to OPUS-M2-002's.
5. **Eligibility is answered, not enforced.** `isEligibleAt` and the read surface
   answer "is this membership credentialed at instant T"; nothing yet refuses an
   assignment on that basis, because no assignment surface exists. CAP-058's
   recorded open question — eligibility is evaluated at the shift date, not at
   request time — is honoured by making `at` a required parameter with no default.
6. **Parity-matrix and traceability rows are not moved here.**
7. **`app_breakglass` reads SENSITIVE-PII credential holdings across every
   tenant** (T-03). It has `BYPASSRLS` (0001, SPEC-01 §4.4), so no policy in this
   migration constrains it and none could — that is the declared break-glass
   exception working as designed, pinned by A-08. Two things follow, and both are
   recorded rather than implied: the SENSITIVE-PII narrowing in §2 is a statement
   about the *application roles*, not about every role in the cluster; and the M1
   residual that **break-glass session auditing (SPEC-11 §3.2) is not yet
   implemented** now has one more thing behind it that a session could read.
   `app_readonly_support` is a different case and *is* narrowed — to nothing, by
   42501, verified distinctly in the SBX-004 sweep.
8. **Retroactive history authoring is refused, and should not be forever** (T-01,
   §4.7). "She was actually at 60% from March" is a real thing an administrator
   needs to record. It is a 422 today because the capability needs its own
   decision, its own audit shape — a retroactive row changes what was true, so the
   record has to say who decided that and why — and its own packet. What exists
   today is the honest subset: forward-dated and immediate changes only.
   `docs/fable/**` and `docs/architecture/**` are prohibited paths for this task.
   CAP-013 and CAP-058 move on the orchestrator's commit, with this bundle as the
   evidence link.

---

## 6. Rollback

Stated down-migration, executed as part of the cycle in `migration-cycle.txt`:
`up → down → up → down → up`, with the schema verified empty after `down`.

`git revert` of the squash-merge is executable in development.

**The down migration destroys `qualification_holdings` rows, which carry
SENSITIVE-PII.** `DROP TABLE` fires no `BEFORE DELETE` trigger, so the retention
guard does not block it — which is the intended behaviour for a development
rollback, where every row is synthetic. A production rollback would follow
SPEC-10's expand/contract rules instead of this file.
