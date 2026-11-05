# Personal Library export

The authenticated native API exports current owner facts independently of public Collection ItemList export.
Decision: use a fifteen-minute fenced, replayable page stream with no retained private artifact; a source change
after a completed stream requires a new request identity. Local delivery is single-flight per visit; false or thrown
save failures retry the exact completed bytes under the same capture. Installed import evidence joins this fence;
expiring MAL or VNDB evidence makes the original capture stale.
Decision: version 2 appends independent `annotations`, `provenance` and `journals` sections; version 1 retains its
original coverage, and reviewed V2 annotation/journal date/reflection recovery is owned by the existing archive consumer.
Decision: version 3 adds the private occurrence assessment to each journal record. Version 4 appends VNDB and AniList
upload/evidence sections because installed V3 captures already bind the 17-section vocabulary. Versions
1, 2 and 3 keep their original record shapes; a missing legacy assessment is not inferred. The existing archive consumer
continues to recover V2 annotations and journal dates/reflection. Copy/progress archive inspection accepts the exact
V3 assessment inventory without adopting assessments; Entry/label merge accepts only V1/V2. All installed archive
consumers refuse V4, whose provider evidence remains inert.

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
fields. Versions 2, 3 and 4 include `sectionTotals` for every declared section, including sections with zero rows. A
non-final page never asserts completeness. An empty intermediate page can still have `next`.
Web fetches sequentially, keeps the original identity and cursors, and assembles a local JSON artifact
`{manifest,records}` only after a final `ready` page. The manifest's omissions must remain visible with the file.
Download uses those exact collected bytes; a local save failure can retry them. If local bytes were lost, replay
`first` under this capture; a changed source returns `stale`, never a replacement under the completed identity.

## Web visit

Web owns `/library/export` as the signed-in Library portability visit. Commerce owns capture, paging, cancellation,
fences, expiry and artifact semantics. The page binds `KernelClient.libraryExports` when post, status GET, pages GET
and DELETE are present. Decision: export adoption remains unavailable until complete generated declarations and
installed client typing agree on V4 coverage, all 21 sections and the journal assessment contract. Missing methods
render unavailable rather than a local engine or successful fixture. Decision: use the create response's original
`first` cursor on the happy path and call status GET only to replay lost bytes or reread a still-valid capture.

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
New captures use version 4. Stored version 1, 2 and 3 captures keep their original sections, record shapes, manifest
fields and byte accounting; their cursor epochs remain 1, 2 and 3. Version 2, 3 and 4 cursors carry per-section counters.
Unsupported versions and cursor shapes are refused. The existing archive consumer accepts V1, V2 and V3 manifests; its
supported annotation, journal and assessment operations are specified in
[Personal archive annotation, journal and assessment recovery](library-archive-personal-fact-recovery.md). V3 keeps
the exact V2 section order and adds the declared assessment object; V4 provider sections remain unsupported for
archive recovery.

## Version matrix and section additions

| Version | Capture use                                | Sections                                                                       | Final accounting                                               |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1       | Existing stored captures and their retries | The original 14 sections listed in the first installed manifest                | `rows` and `recordBytes`; no new section claim or counters     |
| 2       | Existing captures and their retries        | The version 1 sections followed by `annotations`, `provenance`, and `journals` | `rows`, `recordBytes`, and `sectionTotals` for all 17 sections |
| 3       | Existing captures and their retries        | Version 2 sections; journals add private assessment                            | `rows`, `recordBytes`, and all 17 section totals               |
| 4       | New captures                               | Version 3 sections followed by four provider sections                          | `rows`, `recordBytes`, and all 21 section totals               |

| Omission                 | Version 1                                                                                                             | Version 2                                                                                                                 | Version 3                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `trash`                  | Excluded; current live facts and retained session history only                                                        | Same                                                                                                                      | Same                                                                                   |
| `providerIdentifiers`    | Stored personal import evidence only; no shared custody scan or inferred identifiers                                  | Explicitly reviewed owner observations and retained import evidence only; no shared custody scan or inferred identifiers  | Same as version 2                                                                      |
| `personalImportEvidence` | Retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded | Retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded | Same as version 2                                                                      |
| `commerce`               | Excluded; orders and financial evidence use Commerce retention/export policy                                          | Same                                                                                                                      | Same                                                                                   |
| `publication`            | Excluded; stored rules only, no dynamic evaluation or working publication output                                      | Same                                                                                                                      | Same                                                                                   |
| `reimport`               | Unavailable; no installed re-import endpoint is promised                                                              | V1 recovery plus reviewed V2 annotations and journal dates/reflection; provenance remains unsupported                     | V1/V2 recovery plus reviewed V3 occurrence assessments; provenance remains unsupported |

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

## Version 4 provider evidence and assessment seam

Decision: version 4 appends `vndbUploads`, `vndbEvidence`, `anilistUploads`, `anilistEvidence`, in that order,
uses coverage `private-library-owner-facts-v4`, epoch 4 cursors and totals for all 21 sections. V4 binds the
fixed counter pairs as a JSON string cursor component; retained epochs keep their original component shape. V1/V2/V3 sections,
byte accounting, cursor shapes and decoding remain fixed. New captures never reinterpret an older identity.
`fullExport` remains false. V4 `personalImportEvidence` declares retained Bangumi, unexpired MAL and VNDB, and
retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities are excluded.
V4 `reimport` explicitly declares recovery unavailable to the installed V1/V2 archive consumer. That consumer
refuses V3/V4 with `unsupported_version`; a future consumer must retain unsupported evidence privately and never
execute exported capabilities. Unknown format versions remain unavailable to Web, never empty success.

VNDB metadata is `{upload_id,state,expires_at}`. Its native lifetime is 24 hours; only uploads unexpired at capture
are selected, including cancelled uploads with retained evidence. Each evidence record is `{upload_id,ordinal,evidence}`,
where `evidence` is the stored parsed VNDB row: `identifier`, `fields` (kind/raw/value/precision/scale), labels,
retained reason and parsed XML evidence. Metadata-only retained rows remain included. Missing, unknown, invalid and
zero values retain their original distinctions; VNDB vote zero remains invalid. Titles never create identifiers.
No original XML upload, decisions, native target keys or review/apply state is projected.

AniList has no time expiry in its installed store: retained upload headers (ordinal -1) supply
`{upload_id,score_format,cancelled,row_count}`. The count is original admitted count, not a completeness assertion.
Each `{upload_id,ordinal,evidence}` projects only the stored `source` object: original `evidence`, `group`,
`identifiers`, and per-field `fields` validity/reason. This preserves source score format (including unknown/null),
missing/null/zero, unfamiliar vocabulary, fuzzy date components and original declared AniList/MAL identifiers.
Wrapper documents and raw JSON are excluded; their absence is not a supported empty section. Cancellation retains
evidence, removal deletes it. Imported scores are never native votes; provider dates never create occurrences.

V4 applies credential/capability-shaped key redaction recursively to all retained evidence, including arrays of
`{field,...}` descriptions and nested parsed XML nodes. Review IDs, command/client keys, receipts, authority grants,
confirmation and apply/recovery state keys are also removed. Allowed unknown vocabulary values stay original.
V1/V2/V3 retain their historical redaction and byte meaning. SQL projection and final JSON encoding both enforce
65,536-byte record bounds before delivery, including escaping and UTF-8; oversize returns `limit`, never truncation.

The received occurrence producer seam is `journal.assessment:{meaningRevision:1,units:number|null}` with integer
units 0..20. V3 serializes the installed producer-owned `journal_assessment_meaning_revision` and nullable
`journal_assessment_units` columns. The assessment owner retains its CAS/write semantics; this export adds no
assessment adoption or archive writer.
V1/V2 absence never establishes an assessment. Their serialized journals stay unchanged.

The same owner source generation covers VNDB parent and indexed evidence rows, plus every AniList header/source/
review mutation, cancellation, pruning and deletion. Indexed MAL/VNDB expiry probes run before and after each page,
and on status and original create replay. Expiry needs no row write to make collecting or completed captures stale.
The final page rechecks current owner, source and time under the existing account barrier and source lock; no GET
repairs, replacements, partial success or new request identities occur. Erasure still owns the export control row;
VNDB parent deletion cascades its source-owned parsed row index, and existing AniList erasure deletes its rows.

### Whole caller work

Let P=16 and S<=17 be candidates, Uv<=4 retained VNDB uploads, Ua<=5 retained AniList headers, and K actual pages
(including parent-transition/empty pages). Existing admission, account barrier, authorization, operational
preparation/locks/receipt work and native section counters remain on the existing Library request payer.
Each page adds no account-wide discovery: direct metadata uses one owner-indexed P+1 seek; provider evidence uses
at most one owner/upload parent seek and one owner/upload/ordinal P+1 seek. Header-only AniList's partial index
avoids reading unrelated rows. Expiry uses two owner/expiry-indexed existence probes per currentness check (MAL and
VNDB); each page does two currentness checks, each with one exact control-row lock and one source-generation lock.
Create uses the existing command receipt/transaction, exact owner capture lock/upsert, generation lock, then status
currentness. Status and cancel each use one currentness check, with cancel's exact update. Original retries repeat
these bounded checks; R retries add R times the respective caller work, never a refreshed lifetime.

Parsed VNDB rows are indexed at source write time: one backfill over retained arrays at migration and, on actual
source rows change, at most 5,000 deletes and 5,000 inserts per upload (16 MiB total parsed input), plus their source-fence updates. Export never reparses
that upload array. AniList source and header metadata are stored generated projections, computed once per source
write (existing payload cap 4 MiB); export reads no raw wrapper/header document. Candidate source JSON work is
bounded by admitted source bytes (VNDB <=16 MiB per addressed parent, AniList <=17*4 MiB worst-case parsed source
projections); SQL limits each driver row to 64 KiB, at most 17 such rows. Application redaction, reference expansion
and serialization process at most 16*64 KiB candidate input per page, returning <=120,000 encoded record bytes.
Native annotation/provenance optional joins remain at most 16 exact Subject keys; counters/cursors now process
21 fixed pairs. Artifact caps, browser assembly, expiry and one control row per owner are unchanged.

VNDB deletion/pruning/terminal cleanup adds at most 5,000 indexed child deletes and fence updates per parent to its
existing source cleanup payer (at most four VNDB parents and 20,000 children in its installed owner erase call); AniList generated projections follow each existing row's cleanup. Source index data
is never an export artifact and has no independent lifetime. No new server artifact, scheduler, payer, automatic
retry or runtime refill is introduced. Total work is the existing capture/status/cancel costs plus K bounded page
callers, returned native rows/bytes, source projection write/cleanup work and explicit retries. Native growth and
whole-caller budget measurements remain unmeasured here and belong to controller acceptance.

References inspected: `legacy-final:packages/model/src/native-export.ts` (bounded continuation and revision binding),
`legacy-final:services/main/src/modules/library-import/formats/vndb.ts` (private identifiers and precision), installed
VNDB/AniList parsers and upload lifetime owners, and the retained AniList MediaList/FuzzyDate reference. No legacy
code was copied. The existing Web export interface and canonical archive consumer retain their owners for the V4 handoff.

## Version 2 accounting and work bounds

The fixed returned-record page size is `P=16`; each indexed keyset selection fetches at most `P+1=17` candidate
keys. One direct section page uses one owner-keyset statement. A nested section uses one indexed parent seek and one
indexed child keyset statement. Annotation and provenance pages add one indexed batch join over at most `P` returned
Subject identities; the sentinel candidate never joins the entry table.
journal pages have no optional-row join. Sparse partial indexes make absent annotation and journal probes bounded
without scanning unrelated owner history. A deep cursor uses the same keyset predicates and does not add offset
work.

Each SQL-projected row is capped at 65,536 encoded bytes before it reaches the driver, preserving the original
version 1 bound. Versions 2, 3 and 4 also refuse a serialized record above 65,536 bytes; all versions cap serialized page
records at 120,000 UTF-8 bytes. The worst-case version 2 source buffer is 17 rows times 65,536 bytes, plus fixed SQL
row metadata. Version 3 adds only the fixed assessment meaning revision and nullable integer to journal records.
`recordBytes` is the sum of UTF-8 bytes of each exact `JSON.stringify(record)` value; it excludes
the page envelope, cursor, and final manifest. Version 2 and 3 section totals use the same byte definition and count every
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
  row, an additional 64 KiB encoded record cap in versions 2–4, 120,000 encoded record bytes per page, stream stop at
  100,000 records or 32 MiB, fifteen-minute fixed expiry, 4096-character cursors
  (`docs/library-export.md` and `library-export-routes.ts`).
- Test reference: `apps/web/tests/private-library-export.test.tsx` growth cases at 16/128/1,024 records with empty
  continuation pages.

MAL metadata cancellation and parsed rows also have source-owned stored projections in V4: the export uses
owner/upload/ordinal page+1 seeks without reopening its retained document. The existing 48 MiB document and 500-row
source cap bound one source write comparison; a rows change replaces at most 500 child rows under the existing
source payer. Header cancellation is computed on writes. Three retained uploads bound terminal cascade cleanup at
1,500 rows; pruning/deletion owns the same cascade. V1/V2/V3 keep their original record bytes and section positions.

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
| annotations    | Version 2 and 3; owner/Subject identity, entry incarnation and pin when present, note/priority and annotation revision/update time; independent of other optional rows                                                                     |
| provenance     | Version 2 and 3; one accepted owner observation with declared provider/record ID, native revision, privacy and source timestamp precision                                                                                                  |
| journals       | Version 2 preserves the earlier private journal shape; version 3 adds assessment `{meaningRevision:1,units}`. Missing v1/v2 assessment is legacy-absent, not inferred                                                                      |

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
removed. Version 4 also includes unexpired VNDB and retained AniList uploads and parsed rows; other import stores are unavailable; no shared provider custody is scanned and no identifier is invented.
All four formats declare their fixed section sets; versions 2, 3 and 4 report zero totals for empty sections without fabricating
fact records. `ready` means all supported native sections were exhausted, never a completed full account export.
Trash, published/working output, credentials, Access capabilities, secrets, other accounts and Commerce order or
financial evidence are excluded. The existing archive consumer supports only its documented V1/V2 recovery subset;
the V3 assessment format is not accepted for recovery.

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
bytes. Versions 2, 3 and 4 also cap each final encoded record at 65,536 bytes. A stream stops at
100,000 records or 32 MiB; `limit` returns no records or manifest and requires a narrower future format or support.
`stale`, `expired`, `cancelled` and `limit` return no records, next cursor or successful manifest. Expiry is fixed
at capture plus fifteen minutes; retries never renew it. Malformed/cross-capture cursors return `400 invalid_cursor`;
foreign/missing identities return `404`; current native authentication/authority failures return `401/403`.
Native deadlines, admission and cancellation apply before and after each bounded transaction; aborted work rolls
back and cannot publish a success manifest. Terminal account deletion immediately denies capture, every page and
final delivery. The appended native Library owned-graph phase erases the single control row; no deletion
coordinator, private output generation or public capability is added.
