# Adopting imported consumption dates

Provider uploads retain their own date evidence. A reviewed row can propose a supported start or finish date for one
existing native progress session. It never creates a session, changes progress, edits a Library entry, or publishes a
date. The private progress-session journal remains the owner of native date semantics.

## Provider field matrix

| Provider | Typed source fields                                            | Meaning and precision                                                                                                                                                                                                          | Admission                                                                                      |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| MAL      | `my_start_date`, `my_finish_date` in anime and manga XML rows  | Calendar date components. `0000-00-00` and empty values are unknown; trailing zero components preserve year or year/month precision. Interior missing components, impossible calendar dates and invalid leap days are invalid. | Installed: valid year, year/month and complete dates can be explicitly adopted.                |
| AniList  | `startedAt`, `completedAt` `FuzzyDate` objects                 | Separate nullable year, month and day components. Null components remain absent; invalid calendar combinations are retained as invalid. `updatedAt` is source metadata.                                                        | Retained by the installed parser; date adoption remains a continuation.                        |
| VNDB     | No typed personal upload row is installed in this Kernel base. | The retained source contract describes start and finish components with trailing unknown precision. No field is inferred from catalog metadata or a field name.                                                                | Not admitted until its existing provider composition installs its typed personal row contract. |

MAL's source fields are the only date inputs admitted by this implementation. MAL creation/update timestamps, export time,
upload time and command time never supply a journal date. Bangumi `*_at` and `*_date` fields remain outside adoption.

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

## Remaining provider work

AniList date adoption and a typed VNDB personal-row integration remain in the continuation. Keep each provider's
field parsing and review/apply composition independent while reusing the installed journal command and its precision.
