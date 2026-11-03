# Personal Library export

The authenticated native API exports current owner facts independently of public Collection ItemList export.
Decision: use a fifteen-minute fenced, replayable page stream with no retained private artifact; a source change
requires a new request identity, including after a completed stream or a failed local download. Installed import
evidence joins this fence; expiring MAL evidence makes the original capture stale.
Decision: version 2 appends independent `annotations`, `provenance` and `journals` sections; version 1 and the
archive-entry/label merge retain their original version 1 coverage.

## Mounted methods and Web handoff

All methods require a bearer account and `library_entry:list`, `library_entry:read`, `copy:list`,
`progress_session:list`, `progress_session:read` and `collection:read` scopes. Native owner admission and the
personal_library, reading_progress and collections gates apply on every invocation, including retries.
All responses are `application/json`, `Cache-Control: private, no-store`. There is no public download token.

| Method                                       | Request                                         | Response                                             |
| -------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `POST /v1/libraryExports`                    | Structured-string `Idempotency-Key`; no body    | Original capture status                              |
| `GET /v1/libraryExports/{id}`                | Bearer owner                                    | Status and original `first` cursor                   |
| `GET /v1/libraryExports/{id}/pages?cursor=…` | Original opaque cursor, at most 4096 characters | Bounded records, `next`, final manifest              |
| `DELETE /v1/libraryExports/{id}`             | Bearer owner                                    | Cancelled status; all cursors cease delivering facts |

A status has `format`, a supported `version`, `exportId`, `capturedAt`, `expiresAt`, `privacy:"private"`, `state`,
`completeness:"supported-native-facts"`, `fullExport:false`, `sections`, `omissions` and `first`.
A page has `{exportId,state,records,next,manifest}`. Each record has `section` and the fields below.
Only the final page has a manifest; it adds cumulative `rows` and `recordBytes` to the format/version/coverage
fields. Version 2 also includes `sectionTotals` for every declared section, including sections with zero rows. A
non-final page never asserts completeness. An empty intermediate page can still have `next`.
Web fetches sequentially, keeps the original identity and cursors, and assembles a local JSON artifact
`{manifest,records}` only after a final `ready` page. The manifest's omissions must remain visible with the file.
Download uses those exact collected bytes; a local save failure can retry them. If local bytes were lost, replay
`first` under this capture; a changed source returns `stale`, never a replacement under the completed identity.

## Web visit

Web owns `/library/export` as the signed-in Library portability visit. Commerce owns capture, paging, cancellation,
fences, expiry and artifact semantics. The page binds `KernelClient.libraryExports` when post, status GET, pages GET
and DELETE are present. The generated client snapshot may lag the kernel source; missing methods render unavailable
rather than a local engine or successful fixture. Decision: use the create response's original `first` cursor on the
happy path and call status GET only to replay lost bytes or reread a still-valid capture.

Before capture, the page explains supported-native-facts coverage and `fullExport:false` in product language. Entries,
labels, sessions, copies and permitted Collection metadata stay independent facts; stored rules are references;
a copy is not a purchase; source, audit and consumption times stay distinct; source privacy does not publish.
The visit never promises reimport, a full account archive or financial evidence, and never copies missing provider
evidence as zero. Create starts only on explicit intent. Ambiguous retries keep the original sender, credentials,
request key and operands. Progress reports collected records and returned pages without inventing a total. Empty
intermediate pages continue. Local assembly stores each page as its own chunk and writes `{manifest,records}` once
after the final manifest. Partial, stale, expired, cancelled or limit outcomes expose no downloadable file.
Cancellation during traversal, viewer or session replacement, unmount and terminal failure clear private bytes.
Return uses locale-aware `/library` with no shelf or filter operands.

Version 1 is the fixed historical coverage set below and never implies annotation, provenance or journal coverage.
New captures use version 2. A stored version 1 capture and its epoch 1 cursors keep their original sections,
manifest fields and byte accounting; version 2 cursors use epoch 2 and carry per-section counters. Unsupported
versions and cursor shapes are refused. The archive-entry/label merge continues to accept version 1 only.

## Version matrix and section additions

| Version | Capture use                                | Sections                                                                       | Final accounting                                               |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1       | Existing stored captures and their retries | The original 14 sections listed in the first installed manifest                | `rows` and `recordBytes`; no new section claim or counters     |
| 2       | New captures                               | The version 1 sections followed by `annotations`, `provenance`, and `journals` | `rows`, `recordBytes`, and `sectionTotals` for all 17 sections |

| Omission                 | Version 1                                                                                                             | Version 2                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `trash`                  | Excluded; current live facts and retained session history only                                                        | Same                                                                                                                      |
| `providerIdentifiers`    | Stored personal import evidence only; no shared custody scan or inferred identifiers                                  | Explicitly reviewed owner observations and retained import evidence only; no shared custody scan or inferred identifiers  |
| `personalImportEvidence` | Retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded | Retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded |
| `commerce`               | Excluded; orders and financial evidence use Commerce retention/export policy                                          | Same                                                                                                                      |
| `publication`            | Excluded; stored rules only, no dynamic evaluation or working publication output                                      | Same                                                                                                                      |
| `reimport`               | Unavailable; no installed re-import endpoint is promised                                                              | Version 1 archive recovery only; version 2 annotations, provenance and journals are not imported                          |

Version 2 additions use independent owner-indexed selections. An annotation record preserves the account and Subject,
the current entry incarnation and profile pin when an entry row exists, `annotationRevision`, note, priority and
`annotationUpdatedAt`. A revision remains present after both values are cleared. A missing entry row does not hide
the retained annotation.

A provenance record contains one accepted source observation with its native provider and record ID, revision,
privacy choice, source-created/source-updated values and precision, and `recordedAt`. Unknown, absent, cleared,
private and source-visible values stay distinct. Source-visible privacy grants no publication permission. Raw
uploads, credentials, internal review tokens and reconstructed provider identities are not included.

A journal record contains one live occurrence's owner, session and Subject identity, original profile pin, progress
revision, and the native journal `{sessionId,revision,startDate,finishDate,reflection}`. Reported dates remain plain
partial calendar objects: absent month or day components remain absent, and a cleared date is `null`. Empty
reflections remain distinct from `null`. The progress revision and journal revision are independent. A retired
occurrence is not exported even while its audit rows remain in erasure custody. Existing MAL evidence remains its
own section; no importer-to-journal provenance link or new completion is inferred.

## Version 2 accounting and work bounds

The fixed returned-record page size is `P=16`; each indexed keyset selection fetches at most `P+1=17` candidate
keys. One direct section page uses one owner-keyset statement. A nested section uses one indexed parent seek and one
indexed child keyset statement. Annotation and provenance pages add one indexed batch join over at most `P` returned
Subject identities; the sentinel candidate never joins the entry table.
journal pages have no optional-row join. Sparse partial indexes make absent annotation and journal probes bounded
without scanning unrelated owner history. A deep cursor uses the same keyset predicates and does not add offset
work.

Each SQL-projected row is capped at 65,536 encoded bytes before it reaches the driver, preserving the original
version 1 bound. Version 2 also refuses a serialized record above 65,536 bytes; both versions cap serialized page
records at 120,000 UTF-8 bytes. The worst-case version 2 source buffer is 17 rows times 65,536 bytes, plus fixed SQL
row metadata.
`recordBytes` is the sum of UTF-8 bytes of each exact `JSON.stringify(record)` value; it excludes
the page envelope, cursor, and final manifest. Version 2 section totals use the same byte definition and count every
declared section, including empty sections. The whole stream stops at 100,000 records or 32 MiB of record bytes.
An oversized supported row returns `limit` with no records or manifest; it is never truncated.

## Cost

- Operation: personal Library export create, sequential page reads, status reread, cancel and local artifact
  finalization.
- Touched neighbourhood: installed `libraryExports` methods, the mounted visit, bounded page chunks and one completed
  local file. No subject embellishment, second export engine or unbounded prefix copy.
- Formula: `K + C + R` native calls for K returned pages (including empty continuing pages), fixed create/status/cancel
  component C and explicit retries R. K is the actual page count, not `ceil(N / 16)`, because parent transitions may
  emit empty pages. Projection/serialization is `O(N + B)`; retained bytes are `O(B + manifest/framing + one page)`.
- Installed caps: 16 returned fact rows plus one sentinel row and one parent key per page, 64 KiB per SQL-projected
  row, an additional 64 KiB encoded record cap in version 2, 120,000 encoded record bytes per page, stream stop at
  100,000 records or 32 MiB, fifteen-minute fixed expiry, 4096-character cursors
  (`docs/library-export.md` and `library-export-routes.ts`).
- Test reference: `apps/web/tests/private-library-export.test.tsx` growth cases at 16/128/1,024 records with empty
  continuation pages.

## Stored field meanings

Record keys use native snake_case. UUIDs retain their entire routable identity, never shortened IDs.
`subject_id`, `requested_subject_id` and `version_subject_id` also have corresponding `*_reference` objects
`{id,href:"https://rezics.com/subjects/{id}"}`. These preserve native canonical accepting anchors and original
requested/version anchors separately; the routable Subject URL follows later identity redirects. They assert no
current metadata visibility, provider identity or entitlement. No subject metadata is fetched to make the export.

| Section        | Meaning                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| entries        | `subject_id`, `requested_subject_id`, `incarnation_id`, stored exclusive `state`, `revision`, `library_profile_pin`; `created_at`, `updated_at`, `activity_at`, `finished_at` remain independent timestamps                                |
| labels         | `label_id`, `normalized_name`, `revision`, `created_at`, `updated_at`; only live owner labels                                                                                                                                              |
| assignments    | Composite `(subject_id,label_id)`, nullable historical `assignment_id`, revision and dates; only live assignments with a live label parent                                                                                                 |
| sessions       | `session_id`, subject/version anchors, mode/unit, total, amount, additional measures, locator, position, completed-unit count, state/revision/pin, started/completed/last-changed dates; active, completed and abandoned retained sessions |
| units          | `session_id`, exact opaque `unit_id` and `added_at`; a sparse completed set, never a derived interval                                                                                                                                      |
| history        | `session_id`, `change_no`, original `intent`, `recorded_at`; independent recorded progress intents                                                                                                                                         |
| holdings       | `copy_id`, subject, kind/status, all three stored profile pins, location/source, acquired/disposed dates, note, revision and creation/update timestamps; only retained live copies                                                         |
| collections    | Own active metadata: identity, title/description/privacy/revision, membership kind, builtin identity/pins, presentation kind, stored rule/filter/sort/release/revision and dates                                                           |
| collectionPins | Owner `collection_ids` ordering and revision; references do not disclose referenced Collections                                                                                                                                            |
| occurrences    | Own curated live `member_id`, parent/subject IDs, note, `ordinal_key`, member revision and `added_at`; duplicates retain independent identity and order                                                                                    |
| annotations    | Version 2 only; owner/Subject identity, entry incarnation and pin when present, note/priority and annotation revision/update time; independent of other optional rows                                                                      |
| provenance     | Version 2 only; one accepted owner observation with declared provider/record ID, native revision, privacy and source timestamp precision                                                                                                   |
| journals       | Version 2 only; one live occurrence with owner/session identity, original profile pin, independent journal/progress revisions and partial reported dates                                                                                   |

| bangumiUploads / bangumiEvidence | Owner upload identity/cancellation and original ordinal/evidence, including stored provider IDs and field meanings; no reviews, choice tokens or apply internals |
| malImports / malEvidence | Unexpired owner upload identity/cancellation/expiry and indexed parsed source rows, including original provider IDs, dates/precision and unknown vocabulary; credential-shaped fields excluded |

A pin retains provenance, immutable release digest, accepting Type and profile ID exactly as stored. Unknown old
vocabulary stays readable as raw text plus its stored pin, including null pins; no current meaning is guessed.
Decimals and bigint revisions are decimal strings. Native integer revisions/counts remain numbers. SQL dates are
`YYYY-MM-DD`, timestamps are PostgreSQL timezone-bearing text preserving microseconds, and null means unstored,
never zero or an estimated date. Free-form copy `source` is preserved text, never parsed into a provider ID.
A holding implies no purchase, license, entitlement, state, session or label. Stored rules are references only;
export never evaluates them or starts dynamic publication. All owner facts remain private in this artifact,
regardless of any Collection visibility field.

## Coverage and bounded continuation

Installed native owner tables supply these sections, including retained Bangumi and unexpired MAL row evidence.
Raw MAL XML/envelope metadata and review/apply internals are excluded; credential/capability-shaped field keys are
removed. Other import stores are unavailable; no shared provider custody is scanned and no identifier is invented.
Both formats declare their fixed section sets; version 2 reports zero totals for empty sections without fabricating
fact records. `ready` means all supported native sections were exhausted, never a completed full account export.
Trash, published/working output, credentials, Access capabilities, secrets, other accounts and Commerce order or
financial evidence are excluded. No compatibility with a re-import endpoint is promised.

One control row per owner survives for at most the current capture; no private fact payload is retained server-side.
Native fact fences cover entries, labels, assignments, sessions, measures/history, copies, Collection metadata,
occurrences, Collection pins, rich-entry annotations and accepted source observations. Journal writes, reopen,
retirement and entry incarnation changes use those existing source-fence owners. Each page holds the account
terminal barrier and source fence while reading.
Any intervening native edit conservatively makes the capture `stale`, even when unrelated to already read pages.
A new capture has a new idempotency key; original command receipts never regenerate it on replay.
One live capture at a time returns `409 conflict` for another new request. Cancel, expiry or a stale/limit outcome
allows a new identity. An older replaced identity returns `404`, including its original create replay.

Keysets use owner/parent indexes with no offsets. Each page examines at most seventeen fact rows and one parent key,
guards SQL-projected rows at 65,536 bytes, returns at most sixteen records, and emits at most 120,000 encoded record
bytes. Version 2 also caps each final encoded record at 65,536 bytes. A stream stops at
100,000 records or 32 MiB; `limit` returns no records or manifest and requires a narrower future format or support.
`stale`, `expired`, `cancelled` and `limit` return no records, next cursor or successful manifest. Expiry is fixed
at capture plus fifteen minutes; retries never renew it. Malformed/cross-capture cursors return `400 invalid_cursor`;
foreign/missing identities return `404`; current native authentication/authority failures return `401/403`.
Native deadlines, admission and cancellation apply before and after each bounded transaction; aborted work rolls
back and cannot publish a success manifest. Terminal account deletion immediately denies capture, every page and
final delivery. The appended native Library owned-graph phase erases the single control row; no deletion
coordinator, private output generation or public capability is added.
