# Adopting imported consumption dates

Provider uploads retain their own date evidence. A reviewed row can propose a supported start or finish date for one
existing native progress session. It never creates a session, changes progress, edits a Library entry, or publishes a
date. The private progress-session journal remains the owner of native date semantics.

## Provider field matrix

| Provider | Typed source fields                                            | Meaning and precision                                                                                                                                                                                                          | Admission                                                                                      |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| MAL      | `my_start_date`, `my_finish_date` in anime and manga XML rows  | Calendar date components. `0000-00-00` and empty values are unknown; trailing zero components preserve year or year/month precision. Interior missing components, impossible calendar dates and invalid leap days are invalid. | Installed: valid year, year/month and complete dates can be explicitly adopted.                |
| AniList  | `startedAt`, `completedAt` `FuzzyDate` objects                 | Separate nullable year, month and day components. Null components preserve fuzzy precision; a day without a month and impossible Gregorian dates are invalid. `updatedAt` is source metadata.                           | Installed: exact calendar validation admits supported year, year/month and complete dates; unsupported years stay distinct. |
| VNDB     | `fields.started`, `fields.finished` on retained XML rows       | Original date text and typed missing/unknown/invalid/value state stay in the row. Trailing `00` components preserve year or year/month precision; missing interior components and impossible Gregorian dates are invalid. | Installed: exact calendar validation admits supported year, year/month and complete dates; unsupported years stay distinct. |

Only these provider fields supply dates. MAL creation/update timestamps, AniList `updatedAt`, VNDB source/catalog timestamps,
export time, upload time and command time never supply a journal date. Bangumi `*_at` and `*_date` fields remain outside adoption.

## MAL review and confirmation

First review the MAL row through the installed importer to bind its current canonical Subject. Then call:

```ts
POST /v1/libraryImports/mal/{uploadId}/dates/review
{ row: 0, occurrenceId: "<existing-progress-session-id>", startAction: "adopt", finishAction: "adopt" }
```

`startAction` and `finishAction` may be omitted, set to `adopt`, or set to `clear`. Omission preserves the native
field. `adopt` is admitted only for a valid MAL date. `clear` is a separate explicit choice and may clear an existing
value even when the source is unknown. Missing, empty and all-zero source values never clear a journal field.

The importer page returns the selected occurrence, its current journal values and journal-local revision, and a
per-field status: `already-equal`, `ready`, `conflict`, `unsupported`, `unknown`, `not-selected` or `clear`. The
occurrence ID must belong to the row's canonical Subject. The selected session must retain a current released profile
pin. The review binds the provider review version, source row, current canonical identity, session identity, original
profile pin digest and journal revision. Progress revision is not used as a journal revision.

Confirm only the reviewed fields:

```ts
POST /v1/libraryImports/mal/{uploadId}/dates/apply
{ confirm: true, rows: [{ row: 0, version: "<date-review-version>", fields: ["startDate", "finishDate"] }] }
```

Both selected dates for one occurrence share one native journal PATCH and one journal revision. Its receipt contains
only `sessionId`, resulting journal `revision` and `changed`; read the native journal or diary to reopen private values.
Each row result reports each selected field and the actual native receipt. A changed source review, local journal edit,
retired occurrence, profile mismatch, cancellation, upload deletion or expired evidence refuses a new effect. The exact
PATCH body and native idempotency key are retained before dispatch and reused after an uncertain acknowledgement.

## Bounds and privacy

One confirmation addresses at most 20 source rows and two date fields per row. Review and apply request bodies are
limited to 16 KiB; encoded result pages reuse the installed 64 KiB MAL result cap. At most one journal command runs
per selected row because the native journal writes both fields atomically. Occurrence inspection uses only the
supplied session ID; it does not enumerate the account diary. Existing MAL limits remain 500 rows, 20-row pages,
three retained uploads, 12 MiB evidence per upload and a seven-day lifetime.

Date evidence, occurrence IDs, journal conflicts and outcomes stay in the private own-account upload and journal
surfaces. Public Library, Search, events, diagnostics and errors receive no source dates or private occurrence IDs.
Cancellation and source deletion stop new commands without undoing an acknowledged journal change. Existing account
erasure and source cleanup retain custody of the upload evidence.

Decision: one MAL source row selects one existing occurrence for both dates so the native journal can keep its atomic
PATCH semantics.

## AniList and VNDB review and confirmation

Use each provider's current private row review, then select the supplied existing occurrence and review date choices:

```ts
POST /v1/libraryImports/anilist/{importId}/dates/review
{ ordinal: 0, sourceReviewToken: "<provider-review-id>", occurrenceId: "<existing-session-id>", startAction: "adopt" }

POST /v1/libraryImports/vndb/{uploadId}/dates/review
{ ordinal: 0, sourceReviewToken: "<provider-review-id>", occurrenceId: "<existing-session-id>", finishAction: "adopt" }
```

Omit an action to preserve the native field. `adopt` requires a source date that exactly fits the journal's Gregorian
model; `clear` is separate consent and may clear a populated journal field even if its source is missing or unknown.
An exact year, year/month or full date stays at that precision. No day, time or timezone is filled in. Each review binds
the current provider review, retained-row fingerprint, current match and canonical Subject, the supplied occurrence's
creation and profile identity, and the journal's independent revision. It reads only that session ID.

The provider page returns `consumptionDateReview` and `consumptionDateOutcome` on the selected row. Confirm exactly the
review version and selected fields:

```ts
POST /v1/libraryImports/anilist/{importId}/dates/apply
{ confirm: true, rows: [{ ordinal: 0, version: "<date-review-version>", fields: ["startDate"] }] }

POST /v1/libraryImports/vndb/{uploadId}/dates/apply
{ confirm: true, rows: [{ ordinal: 0, version: "<date-review-version>", fields: ["finishDate"] }] }
```

One native `patchSessionJournal` atomically writes both selected fields for a row. Before dispatch, the existing provider
row stores the exact patch body, native request key and original attribution. An uncertain retry reuses those operands.
An outcome reports each field and row separately; a later cancellation does not undo an acknowledged journal patch.
The existing private disclosure guard protects the selected occurrence. Review and apply never create sessions or
change progress, state, Library assessments, reflections, votes or publication.

## Bounds and custody

AniList keeps its 20-row adoption cap; VNDB keeps its existing eight-row page/apply cap. Both accept at most two fields
per row, limit request bodies to 16 KiB and result bytes to 64 KiB. Each call performs repeated own-account provider,
matching, profile and occurrence checks. Each applied row retains one bounded intent checkpoint before one atomic
native journal command and one bounded result checkpoint afterward. VNDB's existing 8 MiB decisions limit therefore
bounds each repeated JSONB serialization; eight selected rows can each serialize that full bound twice. AniList can
reread its 1 MiB retained header twice per selected row (40 MiB aggregate at its 20-row cap), plus each addressed row.
Each retry repeats the row's own-account, source/match, profile and exact-occurrence checks, then reuses the same native
key and receipt, so there is at most one journal effect per row. No diary scan, second evidence store or second payer is
added. Existing provider page, upload, evidence, lifetime and cleanup limits remain in force.

Date evidence, occurrence IDs, local conflicts and outcomes stay in private own-account upload and journal surfaces.
Public Library, Search, events, diagnostics and errors receive no source dates or private occurrence IDs. A changed
review, rematch, local journal correction, profile/identity drift, retirement, cancelled/deleted/expired source or
terminal account refuses a new effect. Exact receipt replay keeps its original authorization and outcome. Existing
account erasure and provider cleanup retain custody of all date operands and outcomes.

Decision: keep AniList and VNDB date review/apply routes separate per provider, matching MAL's installed review journey while each producer retains its own typed row contract.
