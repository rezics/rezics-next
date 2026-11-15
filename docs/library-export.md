# Personal Library export

The authenticated native API exports current owner facts independently of public Collection ItemList export.
Decision: use a fifteen-minute fenced, replayable page stream with no retained private artifact; a source change
after a completed stream requires a new request identity. Local delivery is single-flight per visit; false or thrown
save failures retry the exact completed bytes under the same capture. Installed import evidence joins this fence;
a supported Bangumi or MAL member, or a VNDB member, that expires after capture makes the original capture stale.
Decision: a Bangumi upload expiring between its header and evidence sections invalidates the live capture even when the
source generation is unchanged; the later evidence page is never delivered under that capture.
The canonical v1 artifact contains all 22 owner-fact sections, including independent annotations, accepted
source observations, occurrence journals with private assessment, and VNDB/AniList upload evidence. Recovery
owners explicitly select supported facts; provider evidence stays retained and counted without execution authority.

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
fields. The manifest includes `sectionTotals` for every declared section, including sections with zero rows. A
non-final page never asserts completeness. An empty intermediate page can still have `next`.
Web fetches sequentially, keeps the original identity and cursors, and assembles a local JSON artifact
`{manifest,records}` only after a final `ready` page. The manifest's omissions must remain visible with the file.
Download uses those exact collected bytes; a local save failure can retry them. If local bytes were lost, replay
`first` under this capture; a changed source returns `stale`, never a replacement under the completed identity.

## Web visit

Web owns `/library/export` as the signed-in Library portability visit. Commerce owns capture, paging, cancellation,
fences, expiry and artifact semantics. The page binds `KernelClient.libraryExports` when post, status GET, pages GET
and DELETE are present. Decision: export adoption remains unavailable until complete generated declarations and
installed client typing agree on canonical v1 coverage, all 22 sections and the journal assessment contract. Missing methods
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

## Canonical inventory and omissions

The format is `https://rezics.com/formats/library-export`, `version:1`, with coverage
`private-library-owner-facts-v1`. Its fixed section order is `entries`, `labels`, `assignments`, `sessions`,
`holdings`, `collections`, `collectionPins`, `bangumiUploads`, `bangumiEvidence`, `malImports`, `units`, `history`,
`occurrences`, `malEvidence`, `annotations`, `provenance`, `journals`, `vndbUploads`, `vndbEvidence`,
`anilistUploads`, `anilistEvidence`, `hostedReading`. Final accounting requires `rows`, `recordBytes` and every section's
`sectionTotals`, including empty sections. No generation selector, older parser or alternate writer is installed.

| Omission | Meaning |
| --- | --- |
| `trash` | Current live facts and retained Session history only |
| `providerIdentifiers` | Explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred IDs |
| `personalImportEvidence` | Retained Bangumi, unexpired MAL/VNDB and retained AniList parsed rows; no raw uploads, wrapper documents, credentials or review/apply capabilities |
| `commerce` | Orders and financial evidence use Commerce retention/export policy |
| `publication` | Stored rules only; no dynamic evaluation or working publication output |
| `reimport` | Reviewed recovery of supported native facts only; unsupported evidence never authorizes execution |

Annotation and journal operations are specified in
[Personal archive annotation, journal and assessment recovery](library-archive-personal-fact-recovery.md).

Independent facts use independent owner-indexed selections. An annotation record preserves the account and Subject,
the current entry incarnation and profile pin when an entry row exists, `annotationRevision`, note, priority and
`annotationUpdatedAt`. A revision remains present after both values are cleared. A missing entry row does not hide
the retained annotation.

A provenance record contains one accepted source observation with its native provider and record ID, revision,
privacy choice, source-created/source-updated values and precision, and `recordedAt`. Unknown, absent, cleared,
private and source-visible values stay distinct. Source-visible privacy grants no publication permission. Raw
uploads, credentials, internal review tokens and reconstructed provider identities are not included.

A journal record contains one live occurrence's owner, session and Subject identity, original profile pin, progress
revision, and the native journal `{sessionId,revision,startDate,finishDate,reflection,assessment}`. Reported dates remain plain
partial calendar objects: absent month or day components remain absent, and a cleared date is `null`. Empty
reflections remain distinct from `null`. The progress revision and journal revision are independent. A retired
occurrence is not exported even while its audit rows remain in erasure custody. Existing MAL evidence remains its
own section; no importer-to-journal provenance link or new completion is inferred.

## Exact hosted checkpoints

`hostedReading` retains the saved Subject, catalogue/publication/occurrence address, required exact target Post ID, revision and
SHA-256, document block/offset, checkpoint revision and changed time. Optional nullable `bodyLanguage` accompanies
that exact address: omission or null selects the semantic default, while a canonical language tag selects its
separate exact body. Decoding preserves omission, null and tags without changing revision or digest. These private
records require `target_post_id` alongside `target_revision_id` and `target_sha256`;
no Post is inferred from an occurrence or default body. They remain unsupported recovery evidence; they grant no Content access and never resolve or install a body.

The existing `readHostedReadingExportPage` owner hook supplies an account/Subject keyset of at most 17 checkpoint
rows, with fixed UUID/digest/revision fields, bounded language/position fields and no chapter/document bytes.
Save, update and clear participate in the same account source fence as the rest of the capture.

## Provider evidence and assessment

The four provider sections follow journals in the canonical inventory. Cursor epoch 1 carries the fixed
per-section counter pairs as a JSON string component. `fullExport` remains false; provider evidence is
private retained source meaning, never authority to execute a recovery command.

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

The exporter applies credential/capability-shaped key redaction recursively to all retained evidence, including arrays of
`{field,...}` descriptions and nested parsed XML nodes. Review IDs, command/client keys, receipts, authority grants,
confirmation and apply/recovery state keys are also removed. Allowed unknown vocabulary values stay original.
SQL projection and final JSON encoding both enforce
65,536-byte record bounds before delivery, including escaping and UTF-8; oversize returns `limit`, never truncation.

The received occurrence producer seam is `journal.assessment:{meaningRevision:1,units:number|null}` with integer
units 0..20. The journal record serializes the installed producer-owned `journal_assessment_meaning_revision` and nullable
`journal_assessment_units` columns. The assessment owner retains its CAS/write semantics; this export adds no
assessment adoption or archive writer.
Missing assessment is invalid; unknown assessment meanings remain inert evidence.

The same owner source generation covers VNDB parent and indexed evidence rows, plus every AniList header/source/
review mutation, cancellation, pruning and deletion. Owner/expiry-indexed MAL and Bangumi probes, plus the VNDB
probe, run before and after each page and on status and original create replay. Expiry needs no row write to make
collecting or completed captures stale.
The final page rechecks current owner, source and time under the existing account barrier and source lock; no GET
repairs, replacements, partial success or new request identities occur. Erasure still owns the export control row;
VNDB parent deletion cascades its source-owned parsed row index, and existing AniList erasure deletes its rows.

### Whole caller work

Let P=16 and S<=17 be candidates, Uv<=4 retained VNDB uploads, Ua<=5 retained AniList headers, and K actual pages
(including parent-transition/empty pages). Existing admission, account barrier, authorization, operational
preparation/locks/receipt work and native section counters remain on the existing Library request payer.
Each page adds no account-wide discovery: direct metadata uses one owner-indexed P+1 seek; provider evidence uses
at most one owner/upload parent seek and one owner/upload/ordinal P+1 seek. Header-only AniList's partial index
avoids reading unrelated rows. Expiry uses owner/expiry-indexed existence probes for MAL and Bangumi, plus VNDB,
per currentness check; each page does two currentness checks, each with one exact control-row lock and one
source-generation lock.
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
22 fixed pairs. Artifact caps, browser assembly, expiry and one control row per owner are unchanged.

VNDB deletion/pruning/terminal cleanup adds at most 5,000 indexed child deletes and fence updates per parent to its
existing source cleanup payer (at most four VNDB parents and 20,000 children in its installed owner erase call); AniList generated projections follow each existing row's cleanup. Source index data
is never an export artifact and has no independent lifetime. No new server artifact, scheduler, payer, automatic
retry or runtime refill is introduced. Total work is the existing capture/status/cancel costs plus K bounded page
callers, returned native rows/bytes, source projection write/cleanup work and explicit retries. Native growth and
whole-caller budget measurements remain unmeasured here and belong to controller acceptance.

References inspected: `legacy-final:packages/model/src/native-export.ts` (bounded continuation and revision binding),
`legacy-final:services/main/src/modules/library-import/formats/vndb.ts` (private identifiers and precision), installed
VNDB/AniList parsers and upload lifetime owners, and the retained AniList MediaList/FuzzyDate reference. No legacy
code was copied. The existing Web export interface and canonical archive consumer retain their owners for the canonical artifact.

## Accounting and work bounds

The fixed returned-record page size is `P=16`; each indexed keyset selection fetches at most `P+1=17` candidate
keys. One direct section page uses one owner-keyset statement. A nested section uses one indexed parent seek and one
indexed child keyset statement. Annotation and provenance pages add one indexed batch join over at most `P` returned
Subject identities; the sentinel candidate never joins the entry table.
journal pages have no optional-row join. Sparse partial indexes make absent annotation and journal probes bounded
without scanning unrelated owner history. A deep cursor uses the same keyset predicates and does not add offset
work.

Each SQL-projected row is capped at 65,536 encoded bytes before it reaches the driver, preserving the original
fixed owner bound. The exporter refuses a serialized record above 65,536 bytes; the exporter caps serialized page
records at 120,000 UTF-8 bytes. The worst-case source buffer is 17 rows times 65,536 bytes, plus fixed SQL
row metadata. Assessment adds only the fixed assessment meaning revision and nullable integer to journal records.
`recordBytes` is the sum of UTF-8 bytes of each exact `JSON.stringify(record)` value; it excludes
the page envelope, cursor, and final manifest. Section totals use the same byte definition and count every
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
  row, an additional 64 KiB encoded record cap per record, 120,000 encoded record bytes per page, stream stop at
  100,000 records or 32 MiB, fifteen-minute fixed expiry, 4096-character cursors
  (`docs/library-export.md` and `library-export-routes.ts`).
- Test reference: `apps/web/tests/private-library-export.test.tsx` growth cases at 16/128/1,024 records with empty
  continuation pages.

MAL metadata cancellation and parsed rows also have source-owned stored projections in the canonical artifact: the export uses
owner/upload/ordinal page+1 seeks without reopening its retained document. The existing 48 MiB document and 500-row
source cap bound one source write comparison; a rows change replaces at most 500 child rows under the existing
source payer. Header cancellation is computed on writes. Three retained uploads bound terminal cascade cleanup at
1,500 rows; pruning/deletion owns the same cascade.

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
| sessions       | `session_id`, subject/version anchors, mode/unit, total, amount, additional measures, locator, position, independent local `completed_unit_count` and canonical `episode_completed_count`, state/revision/pin, started/completed/last-changed dates; active, completed and abandoned retained sessions |
| units          | `session_id`, exact `unit_id`, `unit_kind` (`local` or `episode`) and original `added_at`; the independent manual and canonical Episode fact sets, never a derived interval                                                                                                                                      |
| history        | `session_id`, `change_no`, original `intent`, `recorded_at`; independent recorded progress intents                                                                                                                                         |
| holdings       | `copy_id`, subject, kind/status, all three stored profile pins, location/source, acquired/disposed dates, note, revision and creation/update timestamps; only retained live copies                                                         |
| collections    | Own active metadata: identity, title/description/privacy/revision, membership kind, builtin identity/pins, presentation kind, stored rule/filter/sort/release/revision and dates                                                           |
| collectionPins | Owner `collection_ids` ordering and revision; references do not disclose referenced Collections                                                                                                                                            |
| occurrences    | Own curated live `member_id`, parent/subject IDs, note, `ordinal_key`, member revision and `added_at`; duplicates retain independent identity and order                                                                                    |
| annotations    | owner/Subject identity, entry incarnation and pin when present, note/priority and annotation revision/update time; independent of other optional rows                                                                     |
| provenance     | one accepted owner observation with declared provider/record ID, native revision, privacy and source timestamp precision                                                                                                  |
| journals       | Private journal dates, reflection and assessment `{meaningRevision,units}`; only supported meanings are adoptable                                                                      |

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

A local unit and an Episode fact with equal ID text remain two independent records. `unit_kind` identifies the
native fact family; it never grants current Subject authority. An omitted origin or Episode counter is unknown,
not inferred from UUID syntax or a manual count. The source fence covers direct Episode fact insertion, rekey,
update and deletion as well as the native Session revision changes.

Installed native owner tables supply these sections, including retained Bangumi and unexpired MAL row evidence.
Raw MAL XML/envelope metadata and review/apply internals are excluded; credential/capability-shaped field keys are
removed. The artifact includes unexpired VNDB and retained AniList uploads and parsed rows; other import stores are unavailable; no shared provider custody is scanned and no identifier is invented.
The format declares its fixed section set and reports zero totals for empty sections without fabricating
fact records. `ready` means all supported native sections were exhausted, never a completed full account export.
Trash, published/working output, credentials, Access capabilities, secrets, other accounts and Commerce order or
financial evidence are excluded. The archive consumer supports its documented reviewed recovery subset, including occurrence assessment.

One control row per owner survives for at most the current capture; no private fact payload is retained server-side.
Native fact fences cover entries, labels, assignments, sessions, both local and canonical Episode fact sets, measures/history, copies, Collection metadata,
occurrences, Collection pins, rich-entry annotations and accepted source observations. Journal writes, reopen,
retirement and entry incarnation changes use those existing source-fence owners. Each page holds the account
terminal barrier and source fence while reading.
Any intervening native edit conservatively makes the capture `stale`, even when unrelated to already read pages.
A new capture has a new idempotency key; original command receipts never regenerate it on replay.
One live capture at a time returns `409 conflict` for another new request. Cancel, expiry or a stale/limit outcome
allows a new identity. An older replaced identity returns `404`, including its original create replay.

Keysets use owner/parent indexes with no offsets. A unit page reads at most seventeen local rows and seventeen canonical Episode rows through their own indexes, then returns at most sixteen records. Its internal cursor carries the fact-family frontier; exported IDs are never prefixed or rewritten. Other pages examine at most seventeen fact rows and one parent key,
guards SQL-projected rows at 65,536 bytes, returns at most sixteen records, and emits at most 120,000 encoded record
bytes. The exporter also caps each final encoded record at 65,536 bytes. A stream stops at
100,000 records or 32 MiB; `limit` returns no records or manifest and requires a narrower future format or support.
`stale`, `expired`, `cancelled` and `limit` return no records, next cursor or successful manifest. Expiry is fixed
at capture plus fifteen minutes; retries never renew it. Malformed/cross-capture cursors return `400 invalid_cursor`;
foreign/missing identities return `404`; current native authentication/authority failures return `401/403`.
Native deadlines, admission and cancellation apply before and after each bounded transaction; aborted work rolls
back and cannot publish a success manifest. Terminal account deletion immediately denies capture, every page and
final delivery. The appended native Library owned-graph phase erases the single control row; no deletion
coordinator, private output generation or public capability is added.
