# Adopt retained MAL tags as private labels

This extends the installed [personal MAL upload/review/apply producer](library-import-mal.md), using its
upload identity, immutable row evidence, admitted claim/manual Subject review, review version, command runner,
page size and finite evidence owner. Web's `/library/import-mal` remains the upload-to-result interface.
No catalogue subject, Entry, rating, Session, date, privacy, publication or saved rule is created by tag adoption.
Native label assignment is independent of Entry presence, progress, copies and follow/licence authority.

Decision: support the conservative `mal-comma-v1` subset of the retained `my_tags` XML scalar: literal commas
separate values, surrounding whitespace is ignored for selection, and quotes/backslashes make the whole field
unsupported rather than guessing an escape convention.

## Evidence and explicit review

The existing XML parser decodes XML entities and CDATA once. `fields.my_tags` and the original XML remain the
source; neither a rendered `tags` display string, comments nor repeat counts are tokenization inputs. The page's
`tagEvidence` exposes the grammar, exact supported raw scalar, ordered values with exact raw segments, trimmed
selection values and duplicate source indices. Missing fields, explicit empty scalars, whitespace-only unknowns,
invalid empty segments/control characters and unsupported quoting/escaping or excessive bytes/counts are distinct.
There is no CSV quoting, backslash escape, semicolon splitting or additional XML entity pass. A literal comma
cannot be escaped into a tag in this supported subset. Oversized raw text stays in the producer's retained source
fields/XML rather than being copied into a second evidence projection. Comments and repeats stay separate.

Existing retained uploads need no migration or re-upload: the projection reads their retained scalar directly.
The reviewed source digest canonicalizes JSON object keys and retains array order. Rows are immutable within an
upload; this digest is their revision. An automatic canonical MAL anime/manga claim, or an explicitly submitted
manual canonical Subject, supplies identity. Text never chooses or creates identity. The producer has a unique
external-claim index, so it cannot manufacture an ambiguous candidate set. Missing/unavailable identities keep
their existing unmatched/unavailable outcome and cannot enter review without explicit readable resolution.

`review.labels` is optional. Omission preserves the original status journey. Supplying it explicitly selects source
value indices and either an owned live label ID/revision or a proposed native name. The page returns
`review.labels.selections` with `ready`, `duplicate`, `invalid`, `collision`, `unavailable` or `unsupported` and a
reason. Proposed names use native NFC, Unicode whitespace collapse/trim, case-sensitive uniqueness, no controls
or lone surrogates, and a maximum of 100 Unicode scalars. Collisions require choosing the existing identity;
they never silently adopt a name match. Duplicate source values cannot choose conflicting targets.

## Installed transport

The generated `KernelClient.libraryImports.mal` retains `$preview.post`, `({ id }).get`, `({ id }).source.get`,
`({ id }).review.post`, `({ id }).apply.post`, `({ id }).cancel.post` and `({ id }).delete`.
The same mounted review and apply methods carry the extension:

```ts
// POST /v1/libraryImports/mal/:id/review; fresh Idempotency-Key supplies version
{ row: 0, target: null, skip: false, replace: false, labels: [
  { value: 0, target: { labelId: existingId, revision: 1 } },
  { value: 1, target: { name: "Watch together" } }
] }
// GET the same page and inspect review.labels before confirmation.
// POST /v1/libraryImports/mal/:id/apply
{ confirm: true, rows: [{ row: 0, version, fields: ["tags"] }] }
// outcomes[0].labels: [{ value, status, labelId, assignment: {id,revision} | null, reason }]
```

Each value returns `accepted`, `unchanged`, `stale`, `unsupported` or `failed`. Duplicate source values/targets and
already assigned labels return explicit unchanged outcomes. Native capacity refusal returns failed with
`library-label-capacity`; unavailable dispatches remain failures and retry the original command. Per-value
assignment identities are exactly the native command results, readable through `libraryLabelAssignments.get`
with `subjectId`. The row retains its existing applied/skipped/stale/unsupported/failed envelope.
`remainingLabels`, `remaining` rows and `stopped` describe partial cancellation. Accepted assignments survive it.

Confirmations bind owner/upload/immutable source row, selected ordered values/normalized targets, current Subject
and identity epoch, and the fresh review version. A refresh with `labels` explicitly retires previous confirmation
authority. Old review receipts cannot reinstall a retired version. Existing labels bind ID and revision, including
delete/restore/recreate differences. Proposed names bind their normalized spelling; after creation the native
identity/revision is retained independently. Label creation and assignment use original per-target native keys.
Losing acknowledgement replays those original keys and identities, never a replacement label with the same name.
Native fresh effects lock the upload/review and addressed live label, and prepare current Subject/claim controls.
Original receipt replay is followed by addressed identity checks before further effects.

All methods preserve the installed own-account standing, both read/update scopes and personal Library exposure.
Reads use the producer's read-time account checks; native command fences grant no read authority. Responses are
private, no-store. Final account disclosure checks remain in force; request cancellation stops new dispatch.
Source timestamps remain evidence, audit times come from native commands, and no consumption times are assigned.

## Finite work and lifecycle

`labelLimits` publishes R <= 20 selected rows, T <= 32 admitted/source-selected values per row, M <= 32 selected
new-label proposals per apply, 8,192 UTF-8 source tag bytes, 16,384 encoded selection bytes per row and 524,288
encoded per-value outcome bytes per apply. P remains the producer's 20-row page. These limits do not enlarge
4 MiB JSON wire, 2 MiB decoded XML, 500 rows, depth 16, 12 MiB retained JSONB evidence, three uploads or seven days.
Every mutation also enforces the retained evidence cap; PostgreSQL's existing encoded JSONB cap remains final.

Lookups address `(route, account_id, upload_id)` in the producer primary key, then an immutable bounded array row.
There is no owner-wide history/label LIMIT scan. Review does at most R*T exact label-ID or partial-live-name-index
probes, native normalization and collision decisions. Apply does R*T decisions, at most M distinct native creations
and at most R*T native assignments, deduplicating original keys for duplicate targets in one row. Each selected
value may reload and serialize the bounded document for intent, created identity, original assignment observation
and outcome. Thus whole-caller document work is O(R*T*D), D <= 12 MiB, not O(T) bytes. Page work includes one
bounded document and P current Subject/profile/Entry observations. Full native authority, currentness, preparation,
locks, receipts, History/events, owner-index maintenance and serialization costs remain charged to the existing
producer and native commands, with no second reservation or allowance increase.

Each assignment takes the native owner/Subject admission guard; the covering reservation index reads at most 32
tuples with `slot_no IS NOT NULL` on that exact Subject plus the desired tuple. It locks up to 33 addressed parent
labels. Effective assignments require assignment `deleted_at IS NULL`, a reserved slot and a live parent. A full
reservation set refuses capacity unless an addressed parent is deleted; reclaim compares that parent's exact
`deleted_at` and `purge_after`, assignment identity/revision and slot before reuse. The composition adds no parallel
reservation or owner-wide count. Native rollback/retry and original receipts own failed command disposition.

Cancellation stops subsequent native effects; accepted assignments remain. DELETE/expiry reclaim the original
document, including selections and per-value intents, without deleting native labels. Terminal account erasure
deletes the whole document through the existing `list_import_mal` graph phase. Native labels/assignments retain
their own erasure phases. Export projects immutable source rows only, excluding new review/command capabilities.

Focused coverage: `test/library/list-import-mal-labels.test.ts` and the retained MAL case in
`test/library/erasure-owned-graph.test.ts`. The owner journey uses the generated client to reopen the actual
producer's evidence, submit existing/new targets, confirm and read exact native assignment IDs/revisions. An
explicit canonical manual target change retires the previous confirmation even when both Subjects have the same
display text. No claim mutation or tag-derived identity is needed for this case.

Decision: growth fixes R=3 selected rows (two supported and one negative), T=32 supported values, M=2 new names,
P=20 and source bytes while growing native owner/neighbor labels and inactive same-Subject/label assignments.

The native64/512/4096 case measures the mounted whole caller: upload, first/deep/final pages, exact source,
review, maximum source bytes/values, duplicate targets, capacity refusal, lost-acknowledgement original replay,
stale review, final cancellation, evidence removal and native cleanup. It captures actual statements, plan rows and
buffers and encoded database request/response bytes across the instrumented pools. Producer document SELECT and
UPDATE occurrences and their wire bytes are separately identified; complete plans retain Subject/account
preparation, reservations, native receipts, History/events and owner-index maintenance. Source, selection, page and
per-value outcome bytes are counted separately. Preparation and measurement errors fail the case; an unavailable
native run supplies no measurement. Partial request cancellation and terminal erasure remain the focused cases
above. Frozen integration remains a controller check; authored growth coverage does not claim an executed result.

## Performance review

The current composition reloads the JSONB document during each value's currentness checks and native dispatch
fence. Producer intent/label/before/outcome saves each load the document for update, canonicalize once for the cap
and again for the UPDATE parameter; PostgreSQL then parses/stores that encoded document. These bytes and native
work belong to the caller even when each addressed predicate is constant work. Page projection also materializes
the retained document and makes P current Subject/profile/Entry observations. Fixed R/T/M/P/source growth tests
isolate unrelated native population growth, not the separate D axis: O(R*T*D) document CPU/bytes remains bounded
by the existing caps but is not an O(T)-byte claim or a latency measurement.

Reservations still read at most 32 reserved tuples and lock at most 33 addressed parents with the predicates
above. Those facts do not bound nested command work: owner admission/preparation, original receipt checks,
History, events and index maintenance must remain in total statement/row/buffer/byte comparisons. The new caller
case retains their full plans rather than subtracting them or declaring failed preparation a zero-cost sample.
Any document batching optimization must preserve committed original operands, per-value acknowledgement,
currentness fences and partial cancellation; it needs a separate measured D-axis comparison before adoption.
