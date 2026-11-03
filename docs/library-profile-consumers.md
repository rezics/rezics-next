# Library profile consumers

## Scope and authority

This contract specifies how personal library facts consume the agreed library profile ABI. It is not a second
definitions schema, compiler, catalogue, or profile service. The definitions producer owns source validation,
inheritance resolution, canonical release bytes, and the immutable `Release.libraryProfiles` registry. Consumers use
the agreed closed `TypeDefinition.library: { profileId }` reference and one lookup in the release registry selected by
the operation. The nearest complete declaration is already resolved in the compiled type. A consumer never walks
`bases`, unions profile fields, or consults a per-account catalogue.

The authority for the exact profile object, bounds, ID/label validation, and pin union is the accepted cross-owner ABI
agreement. The first inline-profile draft and `packages/definitions/src/library-profile-design.md`'s earlier proposed
shape are not consumer input. This document records consumer rules only. It specifies the first library-profile
consumer slice in the order in [Library and Collections](library-and-collections.md): one generic engine configured
by definitions data.

Scalar progress measures consume that same released descriptor and pin contract. Every additional unit is validated
against the active profile at creation and remains under the original session pin; its complete request, response,
clear and retry semantics are in [Independent progress measures](library-progress-measures.md).

Personal facts remain separate facts owned by one account and subject: zero or one exclusive entry state, independent
labels, any number of progress sessions, any number of copies/holdings, and ratings. A state does not create a label,
session, holding, rating, entitlement, or import. A session does not create an entry or a copy. Repeated sessions and
multiple holdings of one subject keep distinct identities. Labels may coexist with every exclusive state. Ratings
remain on the rating capability.

## Current storage inventory

The consumer contract starts from the actual schema and commands in this checkout:

| Current store              | Current persisted shape and constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Consumer consequence                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library.entry`            | Primary key `(route, account_id, subject_id)`; `state` is checked against `planned`, `in_progress`, `completed`, `paused`, `dropped`; revision and created/updated timestamps are user-visible CAS/history facts. The shelf migration also adds nullable `activity_at`, `finished_at`, current `type_id`, `type_source_id`, source partition/epoch/position, and `incarnation_id`.                                                                                                                                                                                                                    | Keep the five state IDs and the row key. The source observation is not an immutable historical accepting type or release pin. Existing type IDs are not permission to copy the shelf's per-account catalogue into the profile implementation.                                                                                    |
| `library.progress_session` | Primary key `(route, session_id)` and owner/subject index; `mode` is the three-value algorithm enum; `unit` is the six-value `page`, `chapter`, `episode`, `volume`, `minute`, `percent` check; scalar/total/position are exact numeric columns, cursor locator is bounded text, session state is `active`, `completed`, or `abandoned`, and completion timestamp agrees with state. `journal_revision`, partial start/finish calendar components and bounded private reflection live on this row. `last_changed_at` and native start/completion timestamps remain distinct from user-reported dates. | Preserve the three algorithms, all 18 mode/unit pairs, each session ID, nullable progress values, progress revision and state. Journal edits use a separate revision and do not alter progress, activity or completion facts. The profile unit ID becomes bounded data after the writer validates it; it is not a new algorithm. |
| `library.progress_unit`    | Sparse set keyed by `(route, session_id, unit_id)`; a key is one opaque unit ID. The store pages it by exact unit ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Preserve only IDs actually recorded. `{1,3,7}` stays `{1,3,7}`; never create a range or infer a count from an ordinal.                                                                                                                                                                                                           |
| `library.progress_change`  | Append-only `(route, session_id, change_no)` JSONB intent with recorded time and transaction ID. It records exact adds/removes or scalar/cursor intent; it is not a materialized structure.                                                                                                                                                                                                                                                                                                                                                                                                           | Leave rows and their digests untouched during pin migration. Do not search or rewrite all session history to discover the pin. The parent session pin governs its history.                                                                                                                                                       |
| `library.copy`             | Primary key `(route, copy_id)`, owner and subject columns, non-unique subject, `status` check `ordered`, `owned`, `lent`, `disposed`, nullable location/source/acquired/disposed/note, revision and timestamps. There is no kind, condition, platform, licence, or access field.                                                                                                                                                                                                                                                                                                                      | Keep copy IDs and distinct same-subject rows. Add the agreed kind as data. Historical rows use `legacy-unspecified`; no existing value proves physical media, digital licence, access, or entitlement.                                                                                                                           |
| Shelf projections          | `activity_at`, `finished_at`, `progress_head`, `shelf_count`, shelf keyset indexes, and shelf type observation fields are separate from fact values and user revisions. The per-account shelf type value/root/node/reservation tables contain copied type text, digest roots, trie chunks, and staging state.                                                                                                                                                                                                                                                                                         | Profile pins must not replace user activity, completion dates, counters, or their stable fact keys. The copied type dictionary/trie/staging is not the profile registry and must not be revived or expanded for profiles.                                                                                                        |

The progress session row now also contains a bounded `additional_measures` JSON array for independently admitted
scalar units. Its items remain governed by that session's exact profile pin and revision; they are not a second
profile registry or an import-specific store. See [Independent progress measures](library-progress-measures.md) for
the write/read contract.

The same row owns partial user-reported consumption dates and a private occurrence reflection under a journal-local
revision. See [Private progress-session journal](library-occurrence-reflections.md) for the mounted routes, precision,
clear/replay semantics and Web318 handoff.

The relevant definitions in this checkout are immutable releases validated and published by the existing definitions
routes. The applied `20261027184414_library_profile_pins.sql` adds nullable pins, shape checks, copy kind and pending
indexes. Native row adapters and current writers consume the pins. The explicit runtime below supplies the live-fact
worker and owner cutover; native outcome proof remains a separate integration gate.

## Pinned fact semantics

Every accepted entry state and progress session has one private pin identifying the exact profile that accepted
its value. A copy captures kind and status acceptance separately, as specified below. The pin is the accepted discriminated union:

```ts
type LibraryProfilePin =
  | { provenance: 'profile'; releaseDigest: string; acceptingType: string; profileId: string }
  | {
      provenance: 'legacy';
      releaseDigest: string;
      acceptingType: string | null;
      profileId: 'legacy-fixed-v1';
    };
```

The digest is the release address. There is no `profileRevision` number. `acceptingType` is the actual type accepted
for that fact at the accepting observation; it is not a base class or a type looked up later. For a legacy migration,
write `null` when the old row never retained authoritative accepting-type evidence. In the current entry/session/copy
rows no immutable accepting-type string plus release digest is retained. A current `type_id`, a current semantic
subject, a source ID, or an observed source position is not enough to label that mutable type as historical. Do not
read or expose a hidden current type while migrating.

Store the pin on the fact row (`library.entry`, `library.progress_session`, and `library.copy`), not in a side table
that has to be scanned at read time. Each bounded pin JSONB column encodes exactly
this small closed union; validate the tag, exact member set, digest, nullable legacy type, and profile ID before use.
Keep it private and absent from route response schemas, public events, public Collection membership, and published-log
snapshots. Do not create a numeric revision column, mutable current-profile pointer per owner, per-account definition
table, or profile index. Read-time profile resolution is one immutable release-cache lookup by digest, one accepting
type lookup, then one registry lookup by `profileId`.

For `provenance: 'profile'`, verify the pinned release exists and that its exact `types[acceptingType].library.profileId`
equals the pin's `profileId`; obtain the whole profile from that same release's `libraryProfiles` registry. The type
reference is a closed compiled pointer. Do not follow bases or consult Global's current head. A missing release or a
pin/reference mismatch is an explicit unavailable/incompatible result; it never falls back to current metadata or
legacy defaults. For `provenance: 'legacy'`, look up `legacy-fixed-v1` directly in the pinned release registry,
independent of `acceptingType` and any type annotation. The `legacy-fixed-v1` entry is unattached: it does not enable
People, Concepts, or any type that lacks a current profile.

Historic values are returned using the stored pin. Known old IDs keep their exact text and meaning. Unknown historic
IDs stay readable as stored raw values with their historic provenance; they are not relabelled or coerced. A new write
must be supported by the active profile at its acceptance point. It cannot add an unknown ID, supply a legacy pin, or
submit an old pin to bypass a missing capability. API request bodies do not accept pin metadata.

### Owner Copy detail and current status advice

`GET /v1/copies/{copyId}?presentation=FULL` adds only
`copy.presentation = {meaning, kindLabel?, kindLabelLanguage?, statusLabel?, statusLabelLanguage?,
statusEditing: {state, statuses?: readonly {id, label, labelLanguage}[]}}`. The exported readonly native DTO is
`CopyPresentation` in `copy-model.ts`. This is a bounded, opt-in detail of one actual owner holding, independent of
`view=FULL` current subject summaries. Default BASIC/FULL, Copy lists, Continue, events and published logs retain
their existing fields. Responses are private, no-store. No accepting identity, release digest, profile ID or pin
is serialized. Lists retain their raw fallback and historical notice; editing or inspecting opens this one detail
instead of issuing a release read for every row. Generic visual fixtures without actual accepted metadata remain
unknown; no subject Type, location or source implies a physical/digital holding.

Meaning is `known` only when the exact private `kind_profile_pin` resolves the stored kind in its immutable
release and `status_profile_pin` independently resolves the stored status for that raw kind in its accepting release. Unknown IDs, unpinned facts and `legacy-unspecified` retain their raw provenance with `unknown`
meaning and no fabricated labels. A missing required release or mismatched reference is `unavailable`; no current
head or legacy fallback supplies historical meaning. `Accept-Language` uses the existing request language-range
and label-selection helpers. Every displayed label reports its genuine selected or fallback language.

`statusEditing` is qualified advice from the current native explicit-status validator, never permission or an
allow token. A readable current profile offers statuses for the exact stored kind; it does not infer or change
the historic kind. The current status choices may differ from the accepted status and use current labels. A
readable retired profile or absent kind proves `unsupported`. Hidden, missing or failed source/dependency evidence
is `unavailable`, without an inferred retirement. A changed source identity cannot advertise a status write that
the native validator would reject. Missing original meaning cannot establish support. Unsupported
or unavailable advice has no fabricated empty choices. Explicit status writes independently authorize and validate
the submitted value at native command time. Metadata-only edits, delete, receipts and the exact 720-hour Undo
remain under their native contracts; the detail read creates no write, migration, activation or preparation.

The reader captures one actual copy and its private pins under current owner scope, principal, account and denial checks,
releases the owner snapshot, resolves the exact release and current source, then rechecks source identity/version,
account authorization, owner partition epoch and exact copy/pin after optional summary rendering. Each foreign
home is released before another is visited. Current subject disclosure is independent of historical labels and
of the current profile's availability. Changes at the final fence fail closed.
The existing Copy read action declares its actual own-account authority through the mounted action catalogue;
this supplies native owner permission while retaining principal and denial checks. Missing credential scope is
refused by that admission with `403`, and another owner's copy remains indistinguishable from a missing copy.

Copy creation captures both pins from the actual current native acceptance. Kind is immutable. An explicit status
update validates the submitted pair against the current native profile and updates **only** `status_profile_pin`,
even when the submitted status equals the stored value. Neither `kind_profile_pin` nor the original compatibility
`library_profile_pin` changes. Metadata-only edits change neither meaning and retain their existing native current
pair validation, CAS, source, denial and receipt rules. This split preserves the successful `licensed` to current-only
`archived` transition without relabelling the original kind. Status display uses its own accepted release; current
status advice remains independently selected from the current profile rather than the kind's original status list.

Existing rows receive NULL new pins: the old shared pin was mutable and cannot establish original creation meaning.
No active-head, revision-number or subject-Type backfill is permitted. The old compatibility pin may supply status
provenance only after exact immutable resolution verifies the stored status for the raw kind. Missing creation proof
keeps aggregate meaning unknown; a missing required exact release is unavailable. The explicit native
`legacy-fixed-v1` migration captures its known unspecified kind/status without inventing physical or digital meaning.
No ordinary read migrates or fills pins. There is no second profile store or history inference.

Delete retains all three private columns on the same copy row. Undo verifies the exact accepted status and kind
independently and preserves their pins, identity, values and original 720-hour deadline. Restoring genuinely
pre-profile retained data may use only the owner's existing explicit fixed-contract migration destination, never
today's profile. The existing whole-row due purge and terminal account fact purger erase both new columns along
with the copy; no extra store, child graph or cleanup participant is introduced. Native/full privacy, growth,
regression and promoted-main evidence remain required; local compiler success does not establish them.

### Owner session display and current recording

`GET /v1/progressSessions/{sessionId}?presentation=FULL` adds only
`progressSession.presentation = {meaning, unitLabel?, unitLabelLanguage?, unitCountForms?, dimension?,
structure: 'unverified', recording: {state, inputRules?}}`. This is independent of `view=FULL`, which continues to
control current subject/version summaries under their own disclosure. All responses use private, no-store.
BASIC, ordinary FULL without the opt-in, Continue, events and published snapshots retain their existing DTOs.
No accepting type, profile ID, release digest or stored pin is exposed.

Meaning is `known` only when the exact private accepted pin resolves in its original immutable release and declares
the stored mode/unit pair. Display uses that release's English label and English count forms, with
`unitLabelLanguage: 'en'`; no active-head or fixed legacy label fallback is allowed. A missing required release or
unresolvable pin is `unavailable`. An unpinned fact or unknown original pair is `unknown`, with raw values retained
and no invented label. `unitCountForms` uses the existing Library count-form shape, including required `other`.
The accepted profile is vocabulary/validation, not a verified content structure; an explicit `versionSubjectId` is
only a readable subject reference, not an immutable edition digest or an equivalence claim.

`recording.state` is advisory descriptor compatibility, never permission or a write token. A fresh readable native
source/profile proves `unsupported` only when its profile/pair is absent or its dimension/identity/structure is
incompatible with the accepted pair. Changed numeric bounds alone do not convert historic values: a compatible
pair is `supported` with current descriptor `inputRules = {min?, max?, step, total}`. These map directly to the
existing minimum, maximum, precision and totalPolicy fields (`step: 'any'` when precision is absent). Hidden,
missing or failed current evidence is `unavailable`, without an inferred retirement or deletion. A missing original
release cannot establish recording support. The writer independently reauthorizes at its command observation,
requires compatible accepted/current meaning and validates incoming values against both native descriptors.
Completion and abandonment retain their own lifecycle authority and require no new profile value.

The read captures one owner-authorized session and its private pin in one account snapshot, releases it, reads one
exact accepted release and one current profile, and checks current original/terminal source identities, epochs and
source components before returning. Subject and explicit version summaries cannot rescue a hidden source. After
foreign reads it rechecks current account/principal/scopes/denials, owner partition epoch and exact session/pin.
A changed final source fails closed; it never returns a stale allow or a reassociated summary. Work shares one
fixed request deadline and releases each home before visiting another. The read creates no migration/preparation,
receipt, reserve, activation or other write.

Decision: Progress editors retain raw text, trim only numeric operands, and validate exact native bounds and step-derived precision before a new command or review; opaque locators retain their native 1–256-character bound without trimming.

Scalar captured totals remain frozen. Cursor text stays opaque, with no CFI interpretation. Sparse IDs remain exact
session-local keys: `{1,3,7}` has cardinality three, and completion never fills a range. New reading/version choices
create a distinct session with empty values; they never repoint, rescale, clamp, copy or repin earlier history.
Multiple active sessions remain possible, and abandonment plus a new start are independent commands.

The focused presentation and native session cases cover this seam. Local typechecking establishes the DTO and
implementation's compiler validity only; native/full privacy, growth and promoted-main proof remain deferred.

### Profile-aware write validation

For a NEW profiled value (not clearing/deleting an own fact), resolve the subject's authoritative current accepting type and the active immutable release at
the command's authorization/acceptance observation `T`. Validate the operation against the entire selected profile:

- Entry states must be an exact declared state ID. `role` is descriptive semantic mapping; it never renames an ID or
  maps `in_progress` to a new ID.
- Progress must use one of `scalar_amount`, `cursor_position`, or `completed_units`, and an allowed exact mode/unit
  pair. Pair metadata is read as data. The algorithms remain those three kernel algorithms.
- Numeric minimum/maximum comparison is exact decimal-text comparison. Optional precision is 0–6. If precision is
  absent, preserve the existing parser's 12 integer digit and 6 fractional digit behavior. Dimension is inert and
  causes no conversion. LEGACY scalar-percent amount/total preserves 0..100; legacy cursor percent is not capped.
  The 0..100 rule belongs to LEGACY profile metadata/old behavior. New unit IDs, including `percent`, use declared per-mode bounds and `totalPolicy` only.
- Completed-unit identity is `none` for scalar/cursor and `session_local` for sparse completed sets. Preserve the
  exact opaque IDs and existing bounds. `structure` is `none` only. No ordinal expansion, provider identity,
  achievement, structure revision, or invented date is introduced.
- A copy requires a declared kind/status pair. The old four status IDs remain data; the new kind is not inferred from
  `source`, `location`, or subject type.
- Import-source declarations are inert mappings. They do not install a provider adapter or grant access. Credentials,
  endpoints, executable mappings, and adapter-enable flags do not enter profile data.

Absence of `TypeDefinition.library`, or a new state, mode/unit pair, copy kind, or status absent from the selected
profile, denies NEW profiled state/progress/holding values with HTTP `422`, code `unsupported_library_profile`, and `effect_status: not_applied`.
Malformed request shapes, including caller-supplied pin metadata or a missing fresh-copy kind, return HTTP `400` with
`invalid_request`. Unsupported IDs are profile data membership failures, not rejections by a copied closed kernel enum.
Absence does not select `legacy-fixed-v1`, default a profile, infer a profile from ancestry at runtime, or grant
capabilities to People/Concepts. The bundled book and anime type declarations remain ordinary catalogue data and are
exercised alongside data-only fixture verticals; generated files do not activate themselves.

**DECIDED:** readable unprofiled subjects accept generic label assignment/unassignment and curated occurrence add/remove.
Missing or retired profiles never prevent reading historic own facts or clearing/deleting them; no default/legacy
profile enables new values. Access, scopes, CAS, deletion fences and authorization-before-receipt still apply.
Everything contains distinct subjects with any live state, label assignment, progress session or holding; follows and
curated occurrences alone do not count. Clearing state removes only state-view membership, and another live fact keeps
the subject in Everything. Removing the last live personal fact removes it. Label-only subjects have no default state.
Soft-deleted facts are hidden immediately and are not live inputs to Everything while their payload remains restorable.

[Deletion](deletion.md) governs ordinary fact hiding and undo: delete hides immediately everywhere, preserves only
permitted tombstone references, and permits owner restore within 30 days. Restore rechecks current
`deleted_at`/`purge_after`/CAS and restores the same historic fact and pin, never current-profile reinterpretation or a
new fact. Automatic minimal purge follows the window; early purge needs separate platform
permission. Business transitions (completion, abandonment, refund or revocation) do not establish undo authority or an
earlier purge deadline. Takedown withholds only the least affected field/record and never auto-purges solely for the notice;
a legal-order purge requires separate platform authority.

Account deletion is terminal at fresh authentication plus typed confirmation time `T`. Only
`account-tombstoned.v1` exists; there is no account restore, scheduled/cancelled event, account-generation counter, or
`accountDeletionState` port. Bounded durable private-payload purge starts at `T`; private, unlisted and already-deleted
payloads are hidden immediately and erased as that work settles. Legal-hold integration is deferred from first scope;
no new hold/custody engine is required here. Whole private facts, including personal skeletons, are erased; only safe
nonpersonal public skeletons survive. The durable handoff does not
wait for projection consumers, and the delete response may precede physical purge completion.
**DECIDED retention:** retained Collection identities and their classification are fixed at `T`. Only Collections active
and PUBLIC at `T` survive. A public dynamic Collection retains its last completely published generation, read-only and
de-identified with current viewer-native subject access. Private, UNLISTED and already-deleted Collections, including
formerly-public ones, are erased by bounded work. No fresh query at `T` or pending generation is adopted; if no dynamic
generation completed, no subject set is manufactured.

## Authorization, receipts, and replay

Profile selection is not authorization. An API command uses the real Access decision and signed request identity for
the current actor. The order is part of the privacy contract:

1. Authenticate and authorize the current actor/action/resource at `T`, before any receipt lookup. A missing,
   suspended, stale, or revoked actor has no receipt oracle.
2. Canonicalize the user-supplied command body and evaluate its existing receipt key/digest. Pin metadata is not
   caller input and does not create a second idempotency namespace.
3. If an authorized exact receipt exists, return its stored status/body unchanged. A different body under the same
   key returns the existing idempotency conflict. Do not revalidate current subject membership or current profile
   capability before an exact authorized receipt: a later release change must not turn a valid own receipt into a
   new write or alter its response.
4. Only when no receipt exists, perform the operation's current subject/resource admission. For NEW profiled values,
   resolve the active Global head and current accepting type at `T`, look up one profile, and validate capability/value membership. A miss or
   unsupported pair fails before any fact row, receipt, event, activity, counter, or migration state is written.
   Clearing/deleting an own historic fact uses its exact identity/CAS and stored pin without requiring a current
   profile. Generic label and curated occurrence commands likewise do not perform profile-capability admission.
5. Commit the fact row, pin, ordinary receipt and normal effects as one owner command. A successful pin records the
   exact immutable release digest/type/profile observed at `T`; later activation does not rewrite it.

This means a release change alone leaves an authorized exact replay valid and pinned to its original receipt. A real
authorization revocation still denies that replay because step 1 remains first. Tests must also prove that a changed
body conflicts without being reinterpreted against a replacement profile, and that profile preparation or migration
never changes the public request digest, prior receipt digest, HTTP status, or response body.

Reads, changes, delete, replay, unit-page reads, and log operations must remain owner-scoped under the existing Access
contract. `other`, anonymous, and suspended personas cannot infer a private fact, value, profile pin, accepting type,
or migration state. Public Collection membership discloses only the selected subjects. A published log remains its
existing explicit snapshot and never starts disclosing private amount, cursor, sparse set, copy, or state. Ratings stay
separate. Subject visibility does not make personal facts public.

## Definition lifecycle and release change

Use the existing Global definitions commands, with their existing real grants and idempotency headers:

```text
POST /v1/definitions/releases
POST /v1/definitions/releases/{digest}:activate
GET  /v1/definitions/releases/{digest}
GET  /v1/definitions/active
```

Publication validates and stores immutable bytes once. It does not move the active head. Activation supplies
`expected_head` for the Global head compare-and-set. A stale head conflicts. Rollback is a new explicit activation of
an older published digest against the then-current expected head. Neither publish, activate, rollback, nor editing a
generated bundle migrates rows or changes fact pins. There is no file-autoactivation path and no private per-account
profile catalogue.

The API acceptance publishes at least two different profile releases, reads both exact digests, activates one, changes
the Global head, and rolls back. It checks that old facts still resolve from their own stored digests through both
head changes. A changed or removed ID is not silently renamed: historical values remain readable using the source
pin, while new writes using the removed ID are refused by the active profile. Values are not converted between
units, status roles, states, copy kinds, or copy statuses. A future fact-to-fact conversion needs a separate explicit
versioned mapping contract and user-intent policy; this consumer does not invent one.

The fixture matrix exercises the agreed data-only game, recipe, and record profiles through the same API and store,
plus valid default book and anime profiles. A fourth vertical adds definitions data only. Inheritance tests prove a
complete nearest declaration, conflict rejection for incompatible declarations with the same ID, and absence when a
type has no reference. All vertical fixtures share the same generic commands and tables.

## Legacy pin migration

Migration is an explicit, checkpointed consumer operation. A release activation never starts it. At job creation,
capture one published destination digest that contains the unattached `legacy-fixed-v1` registry entry; every page
uses that same digest even if the Global head later changes. The initial migration only pins pre-profile rows. It does
not convert a fact from its accepting release to another release.

For each unpinned legacy row, set `provenance: 'legacy'`, the captured release digest, `profileId: 'legacy-fixed-v1'`,
and `acceptingType: null` unless that row itself retained authoritative accepting-type evidence. Current entry,
session, and copy rows do not retain that complete evidence; use null for them. Resolve legacy values without
guessing a current type. Preserve:

- entry row key, all five old state IDs, user revision, creation/update times, transaction identity, activity and
  finish times, and any existing receipt digests;
- session ID, subject/version subject, all 18 old mode/unit pairs, exact total/amount/locator/position, state,
  revision, start/completion/last-change times, and transaction identity;
- each sparse unit key as it exists, each exact change intent and change number, and each copy ID/status/location/
  source/date/note/revision/time/transaction identity;
- one `legacy-unspecified` kind for every historical copy, with no physical/digital/entitlement inference.

The migration profile preserves the old five state IDs (`planned`, `in_progress`, `completed`, `paused`, `dropped`),
all 18 combinations of the three modes and six historical units, the existing 12-integer/6-fraction parser behavior
when precision is absent, scalar-percent max 100 only, and the four copy status IDs (`ordered`, `owned`, `lent`,
`disposed`). It does not fill sparse ranges, invent sessions or holdings, choose a new completion date, or create
provider/achievement/structure data. Old facts without a profile pin are readable through the explicitly temporary
legacy-command adapter while that owner's migration is incomplete. The profile-aware read path is admitted for that
owner only after every existing fact row is pinned. This temporary adapter uses only the pre-profile fixed contract;
it never inspects current subject type or profile data. It is retired after owner cutover, not kept as a second steady
state.

### Bounded work and row fence

Let `P = 100` source rows. One worker transaction examines and changes at most `P` entry/session/copy rows total,
plus its bounded generic checkpoint/receipt. It keyset-pages each owner relation by its stable fact key and never
counts an account's rows up front. It does not scan `progress_unit`, `progress_change`, command receipt history,
collections, unrelated accounts, or the full profile catalogue. Total work is `O(N)` in source fact rows and page
memory/work is `O(P)` plus capped pin bytes. At every boundary the migration stores only identifiers, release digest,
last stable key, and phase—not a fact body or a user receipt body.

Use the existing nullable pin columns for the online transition. Use the entry primary key for its source-key seek,
materializing at most the remaining page allowance BEFORE filtering pending pins, even though a partial pending-entry
index also exists. The applied session/copy partial indexes supply their bounded pending seeks:

```sql
CREATE INDEX progress_session_profile_pending
  ON library.progress_session (route, account_id, session_id)
  WHERE library_profile_pin IS NULL;

CREATE INDEX copy_profile_pending
  ON library.copy (route, account_id, copy_id)
  WHERE library_profile_pin IS NULL;
```

`library.entry` uses its primary key `(route, account_id, subject_id)` to select <=100 SOURCE keys in a materialized
page before `library_profile_pin IS NULL` filtering. Advance after the LAST EXAMINED source key even if no row is
eligible; a LIMIT only after an unindexed pending filter is forbidden. Native SQL/plan instrumentation counts examined
keys including pinned rows and rows removed by filters, across the current phase/page, not only changed/returned rows. No
index on `releaseDigest`, `acceptingType`, `profileId`, or a profile ID map is needed for fact reads or writes. Once
the online backfill and per-owner writer fence prove no null pins remain, enforce non-null pins for profile-aware
rows. The migration and writer use a compare-and-set on both the observed fact revision and `library_profile_pin IS
NULL`; the migration does not increment user revision or edit user timestamps. A concurrent ordinary write wins or
loses that CAS without losing its body: a fresh write uses its current profile pin, and a migration retry observes
the committed row. The checkpoint advances in the same transaction as page pins.

The generic durable-work owner supplies checkpointing, retries, deletion fences, and crash recovery. Do not add a
second private account job engine. A crash before page commit leaves no pins/checkpoint movement. A crash after commit
but before acknowledgement replays the same stable page; the CAS and same migration identity make it idempotent.
Account deletion's authoritative `T` fence wins over a paused or resumed worker: later pages cannot recreate rows,
receipts, or erased payloads. The final owner-ready transition is monotonic and serialized with normal owner writes;
no old null-pin write can enter behind the final cursor.

### Native runtime binding

`services/kernel/src/library/profile-migration-runtime.ts` exports
`createLibraryProfileMigrationRuntime({ pool, client, clock? })`, returning the closed
`LibraryProfileMigrationRuntime` interface. `client` is the existing `createWorkClient` result;
this factory never launches DBOS. Its trusted host/operator methods are:

- `start({ accountId, releaseDigest })`: verifies the actual published immutable release through
  `readRelease(..., { composed: false })`, checks unattached `legacy-fixed-v1`, captures its digest,
  and atomically queues the first native frontier. Repeating the same destination is idempotent;
  a different destination is rejected after capture.
- `resume({ accountId })`: reads the native frontier and executes one bounded transaction, committing
  the next maintenance intent with its pins. This also recovers a failed or cancelled SDK execution
  without reviving an obsolete workflow. Calling it before explicit start fails; ready is a no-op.
- `readProgress({ accountId })`: read-only owner-local observation returning `accountId`, `phase`,
  `releaseDigest`, and `after`. `phase` is `legacy` before explicit migration, then `entry`, `session`,
  `copy`, or monotonic `ready`. It returns no invented counts, private fact body or user receipt.

These methods are internal composition exports, not HTTP endpoints. The existing single Library WorkModule
installs `registerLibraryProfileMigrationWork` and `LIBRARY_PROFILE_MIGRATION_WORKFLOW`
(`library.profileMigration`) on `maintenance`. There is no schedule or release-activation trigger.
Each workflow runs one retryable SDK step. The existing owner `fact_source_head` stores only the native
phase/digest/key checkpoint; its committed frontier serves as the bounded page completion record, and
`enqueueIntent` persists the successor in the same `OperationalTransaction` as `pinLegacyFactsPage`.
SDK replay of an obsolete frontier has no source effects. Existing terminal cleanup removes this metadata
with `fact_source_head` last; this adds no participant or erasure acknowledgement.

The existing native account fence precedes all work. Live writer triggers serialize on that same owner
source head before changing facts. A first current writer can mark a non-migrating owner ready using four
indexed pending-existence probes, never an account count. Existing current pins remain readable without
a job. During a job no new NULL-pin fact may enter, and ready refuses every live NULL-pin write. Retained
copies and retained entries stay outside this live worker. Their NULL pins participate only in bounded first-writer
pending probes, so existing non-migrating Undo does not need a job. After explicit start, exact native Undo
attaches the captured legacy pin when restoring an originally NULL-pin fact; it cannot admit a live NULL behind
cutover. Copy kind becomes `legacy-unspecified` only for that historical restoration. Existing non-NULL accepted
restoration pins are unchanged.

`assertPreProfileLibraryRead` gates the temporary fixed-contract entry/session/copy adapters on the native
owner phase. Ordinary reads create no progress and inspect no current type/profile to interpret legacy
values. Their NULL-pin branch is retired at ready; pinned DTO reads remain available during migration.
Fresh session records require original pinned meaning and current capability admission; the temporary
reader supplies no legacy write authority. The live copy pending index excludes retained episodes, so
those episodes cannot create uncharged pending-filter work.

The focused `profile-migration-runtime.test.ts` uses existing native profile fixtures and the default worker
for preservation, restart on both sides of native commit, obsolete checkpoint replay, fresh-writer pin
preservation and terminal-owner refusal. These cases and the source-page bounds still require the controller's
native gate; a local typecheck is not their proof. The current
[profile outcome adapter](../services/kernel/test/library/support/native-profiles-driver.ts) calls this runtime,
but its historical setup and migration page/receipt observations remain incomplete. Historical pre-profile
DATA/receipts must use the existing test-only native command fixture boundary. Current production commands require
current pins/copy kinds and cannot manufacture that history; no production legacy-write endpoint/default is introduced.
native gate; a local typecheck is not their proof.

The native profile driver's `seedLegacyFacts(fixture, rows?)` binds the test-only
`createProfileHistoricalNativeFixture({ pool, actor, clock?, createSubject, send, receipts })` helper to
the conformance world's existing owner. `native.accountActor('owner' | 'other')` authenticates that world's
actual bearer through its installed Access. The helper reuses the old `ownAccount` command/store boundary;
it neither provisions a substitute owner nor supplies a production legacy-write endpoint/default.
`seed(rows?)` defaults to five entry states, eighteen mode/unit pairs and four copy statuses, with sparse
units and exact decimal/date values; explicit counts select exact fresh-fixture relation sizes.
Before profile fixture activation, historical setup provisions bundled Book subjects without treating their
current type as historical accepting evidence; native keys retain caller text and HTTP keys retain their original header form.
The entry fixture's `historical(identity)` reuses this helper for retained entry/copy runtime cases.

Historical receipt HTTP status is observed by replaying each committed original command through its installed
route, with caller key and storage identity captured from `currentCommandReceipt`; inspection reads the stored
digest and response unchanged. Current successful HTTP observations use the installed receipt-key codec to join
caller keys to committed rows. Missing or ambiguous observations remain unavailable. Migration pause/crash,
page/EXPLAIN and import-run observations remain explicitly unavailable in the outcome driver; this historical
binding does not establish a complete native suite result.

### Legacy command compatibility and retirement

During rollout, the existing entry, progress-session, and copy endpoints keep their paths and existing request/response
fields. A fresh profile-aware copy create also requires the declared `kind` and `status`; it never defaults to
`legacy-unspecified`. Their handlers become adapters over the same generic command/store path. They never accept
caller-supplied profile metadata. Old IDs continue to work when the active type's profile declares those exact IDs; a
missing current capability is an explicit unsupported write. Exact prior receipts, including receipts for older
kindless copy commands, keep their old digest and response. The temporary legacy adapter exists only to read rows
awaiting the bounded backfill. After owner-ready cutover, historical reads always use stored pins.

Retire the per-account shelf type identity/trie/reservation preparation and its private dictionary lookup when all
current consumers have switched to compiled catalogue identities. Do not reimplement it as a profile index. Keep the
existing owner-scoped fact keys, progress sparse-set store, activity/final-date projections, collection listing and
generic kernel worker protocols. The shelf HTTP surface remains a compatibility adapter only while its consumers
move to dynamic Collections; it must not become a second library/profile API. Remove obsolete shelf type lookup and
preparation routes/helpers/tests only in the same cutover that replaces their remaining callers. This task defines
that retirement and does not remove an endpoint or alter those production files.

## Privacy and scale acceptance

The [profile/label quality review](research/profiles-labels-quality.md) retains its own source binding and exact
original profile/label runner entry points. Current profile-aware entry/session/copy commands and HTTP, compiled
fixtures, native adapters and the migration worker are installed; their presence supplies no passing case.
Authentic historical DATA/receipts, before/after-commit faults, racing writes, actual all-phase page costs,
receipt preservation and complete privacy observations remain unmeasured. Unsupported fixture/inspection latches
must remain explicitly unavailable. These source-inferred gaps are separate from observed failures: this review
has no current native exit. Native/acceptance/browser execution remains deferred to integration.

The native driver records actual database rows, bytes, statements, owner lock/CAS decisions, and fact effects. It must
use real `createKernel(...).handle`, production Access and signed fixture tokens; provision subjects, publish
definitions, activate/rollback, mutate facts, and delete accounts through production commands. It must not use a
policy map, model backend, fake authorization, raw source writes, invented migration counts, normalized results, or
an in-memory product model. Test-only SQL may inspect stored rows and inject a persistence fault at a named native
boundary; it may not manufacture facts or migration progress.

For profile writes, keep the target account/fact fixed and measure actual SQL at three unrelated-fact scales `64`,
`512`, and `4096` (legal geometric scales for shared `checkGrowth`, with its actual grow/operation/warmup API); also vary unrelated compiled definition manifests `10` and `100`. Each generated manifest uses
the existing definitions expansion fixture pattern, adding three types and twelve properties, with a profile attached
only through data. Include real canonical bytes and verify the existing 4 MiB, 1,024-type, and 4,096-property caps.
Record rows and bytes as well as statement counts. The profile operation's fact-row/CAS/receipt count stays fixed;
profile resolution is one bounded immutable lookup and does not copy manifests into owner rows. Do not use a wall-clock
threshold as a cost proxy.

The driver compiles data fixtures with the production definitions compiler. `profile-v2-changed-ids` replaces the
`in_progress` state ID with `reading` while retaining `planned`; `profile-v3-removed-ids` removes `planned`. The suite reads old
facts through their stored releases, rejects fresh writes using those old IDs after each release change, and checks
that the pin's accepting type and profile ID match the actual semantic subject type and compiled nearest declaration.
The inheritance fixture gives the child distinct complete profiles at two ancestors. The conflict fixture repeats an
incompatible profile ID and must fail compilation; the absence fixture removes library references from fixture verticals,
including People and Concepts. The fixtures are source data sent through the real compiler, never prebuilt release objects.

For migration, inspect every actual page's read/write rows and bytes, including a fully pinned entry prefix followed
by pending sessions and copies. The 100 examined-source-key allowance is shared across phases in one transaction;
changing phase does not reset it. Assert at most 100 owner facts per transaction,
constant bounded checkpoint work, exact-row CAS, unchanged user revisions/timestamps/values/history/receipts, restart
after both sides of commit, concurrent-write behavior, and the deletion fence. No test may use a synchronous account
count or transaction, or derive fake progress from an expected count.

## Implementation slices after the ABI agreement

This is specification-only. The following production work remains separate, reviewable slices of at most 400 changed
lines and eight files each:

1. Consume the applied nullable pin columns, shape checks and partial indexes through bounded store projections
   and native row-shape tests. Keep existing primary keys and unaffected user fields.
2. Adapt entry/session/copy commands to current Access-before-receipt ordering, one active-release/current-type lookup
   for fresh writes, stored-pin reads, and no caller pin input. Update only their existing routes and store paths.
3. Add the generic checkpointed legacy pin worker over at most 100 owner rows, exact CAS, owner-ready fence,
   account-deletion barrier, and crash/replay native outcomes.
4. Remove the private per-account type dictionary/trie/staging callers, schema, indexes, and tests only after every
   remaining consumer has migrated to compiled catalogue identity; keep its old receipt digests readable through
   existing command history. Retire shelf-specific lookup/preparation routes in the same cutover; retain the existing
   dynamic Collection contract and shared kernel work protocol.
5. Update Web's generated definition recordings only after its recording contract lands; publish and activate only
   through the existing Global API. Bundle generation is never activation.

The driver interface and outcome suite in `specs/library-profiles-driver.ts` and
`specs/library-profiles-outcomes.test.ts` are the executable consumer acceptance. The pure checks in
`specs/library-profiles-contract.test.ts` cover only pin fixture shape and the frozen legacy matrix; they are not a
substitute for the native API outcomes. The missing-driver verifier proves every named outcome fails for the single
intended reason. It does not prove the product implementation.

## Web manga series and volume visit

Web mounts configured Library controls on an exact `schema:ComicSeries` or `schema:PublicationVolume` subject.
Each identity reads its own current `TypeDefinition.library.profileId` from the selected release. A volume never
inherits series state, progress or copy kind. Physical and digital copy kinds, admitted state IDs and the first
scalar manual unit come from that descriptor; structured media or sleeve condition is not a free-text extension.
Simultaneous chapter/volume measures stay with Commerce209/Web320, canonical episodes with Web319, and rich
diary/history with Web318. Music and live-action presentation stay with Imports Reader38.

A manga type or source label is not permission. Absence of a current profile, an empty capability set, a failed
release read, a refused owner read, a known empty value and a stored ID from an earlier profile are distinct.
New writes use the current release; accepted meaning is not rewritten. The bundled ComicSeries and
PublicationVolume types currently omit `library.profileId`, so a live visit reports unsupported until Semantic
attaches independent series and volume profiles. Fixture releases used by focused tests attach `manga.series`
(chapter scalar, physical/digital) and `manga.volume` (page scalar, physical/digital).

The visit loader is `loadConfiguredLibraryVisit`. Component set **C** is one local profile/capability resolve plus
three native reads: addressed entry, one progress-session page and one copies page (`CONFIGURED_VISIT_COMPONENTS`,
`CONFIGURED_VISIT_NATIVE_CALLS` = 3). **F** is `admittedFieldCount` of the descriptor. **L** is
`LIBRARY_PAGE_LIMIT` (100). **B** is the copies cursor cap 2048 (`CONFIGURED_PAGE_CURSOR_BYTE_CAP`); copy notes
remain 1,000 characters and locators 256. Work is O(F + L + B) and independent of the owner's other entries,
copies or history N. An edit touches one addressed native entity with one command and one readback. History
disclosure loads one bounded change page for the selected session. If a producer has no bounded page, the control
stays unavailable. Focused growth in `apps/web/tests/configured-library-controls.test.tsx` runs owner populations
32, 256 and 2,048 through this loader and asserts fixed native call counts and page-bounded retained bytes.

Decision: manga series and volume each resolve their own current profile; a volume never copies a parent series
state, and live bundled types without a profile stay unsupported rather than forking a Web-owned native profile.

## Canonical episode checklist consumer

[Canonical episode progress](library-episode-progress.md) owns the installed producer/consumer interface. The
reserved Web checklist uses `GET /v1/progressSessions/{sessionId}/episodes` with up to 20 canonical IDs from a
Semantic catalogue page, then `POST /v1/progressSessions/{sessionId}:recordEpisodes` with revision and add/remove
or exclusive clear. The generated client retains these methods. Preserve exact retry keys/bodies; refresh after
409, show redacted/unavailable rows explicitly, and keep generic scalar/manual progress independent.

Adds require the session's compatible original/current profile mode/unit with `unit: episode`, plus current
Semantic Episode type and direct parent authority. This does not change any descriptor's generic identity or
structure algorithm or activate a release. Removal and clear use historical owner fact identity after definition
rollback or concealment. There is no conversion of legacy session-local tokens, no inferred prefix, no receiver-only
API and no competing Web surface. Semantic's requested bounded producer interface is currently consumed through
the selected/disclosed `readSubject` adapter; catalogue enumeration remains Semantic-owned.
