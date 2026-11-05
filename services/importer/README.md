# Importer

The importer owns source acquisition, run and record state, candidate journals and recovery. It sends ordinary public API requests under current caller authority. It does not have a privileged catalogue writer.

## Sources, grain and rights

- **Bangumi:** JSONL native subject IDs/grain; unsupported types remain skipped members. CC-BY-SA-3.0 metadata and attributed summaries; covers have separate rights.
- **VNDB:** Public COPY with real headers/grouped keys; API tables retain response revisions. ODbL-1.0 + LicenseRef-DbCL-1.0 metadata; no prose, posts or images.
- **Open Library:** Five-column TSV Work/Edition rows with distinct IDs. CC0-1.0 bibliographic metadata only; no unknown-licensed prose or covers.
- **Wikidata:** JSONL Q-items with native revisions and exact claims. CC0-1.0 structured data; no user text, unsupported claims or Commons images.

Reviewed source registration fixes licences and attribution; dump fields and caller descriptors cannot. An alias cannot admit a source or default licence. Metadata terms do not grant summary, image or other creative-content rights.

## Registration, identity and ordinary writes

The importer uses the converter revision exported by the registered converter. Current exports are Bangumi bangumi@15, VNDB vndb@8, Open Library open-library@5, Wikidata wikidata-6 and cross-media-entities cross-media-entities@14. Selected Bangumi family conversion combines the current exports as cross-media-entities@14+bangumi@15. Vocabulary revisions are owned by the conversion package. See its [public exports and current mapping contract](../../packages/conversion/README.md#package-api).

A configured source alias and exact external_id form the durable record tuple. Provider identity and converter revision come from registered code, not the source body. An alias binds to one normalized API origin before run or network effects; the same source state cannot silently move to another destination.

A run stages one complete input generation, validates its source records and mass-disappearance threshold, then seals it before public metadata or semantic writes. Records and their owned candidates are reconciled through the ordinary API. Changed input creates new source-backed proposals; vanished source facts may retract only that importer's owned candidates. Independent community subjects and adoption are not deleted or overwritten. Missing, malformed, unsupported and unknown values remain distinct omissions; one omission does not suppress independent valid fields.

Each durable request keeps its original tuple, command key and bytes. If delivery is unknown, reopening replays that exact intent under current authorization before it prepares a replacement. Reprocessing does not regenerate or mutate a sealed command. Current permissions, source/field ownership and takedown/facts fences are checked before new effects or replay. A denial or unresolved response does not count as completion.

## Command line and recovery

Run `bun services/importer/src/cli.ts` with --source, --dump, --state, --api, --account-key, --account, --client and --auth, plus one source/dump/state file and API/Auth origins. --help needs no credentials, SQLite or network. Sources: bangumi, vndb, openlibrary, wikidata.

`--dump -` reads plain stdin. Compression is explicit: gzip for streamed Open Library/Wikidata dumps; zstd for VNDB archives/Wikidata dumps, never inferred from filenames. zstd requires one local regular file and trusted executable. Decoded bytes default to a 256 GiB ceiling; records default to 256 KiB, hard maximum 1 MiB (native limits may be lower). API/Auth must be HTTPS origins without path, query, fragment or credentials. Disappearance threshold is 0–1; optional progress goes to stderr.

- `preview`: decode and compare with a completed baseline; no public writes.
- `compare` / `capture-comparison`: compare bounded plans or pages of two complete captures.
- `inspect` / `inspect-bindings`: read one exact generation, binding or local journal.
- `disappearance-review`: explain a sealed mass-disappearance stop and bounded missing-key pages.
- `diagnostics`: page stored diagnostics or inspect one record; never publish or rewrite.
- `resume`: finish one sealed ready/finalizing generation without the dump.
- `retention` / `staging-retirement`: review/retire the exact eligible generation or unpublished capture.
- `backup` / `validate-snapshot`: preserve/verify SQLite with committed WAL state.

Interrupted unsealed acquisition is discarded; optional checkpoints cover large Bangumi/Open Library/Wikidata files and VNDB COPY. Resume verifies the same source and bytes. Sealed generations resume from the journal; unknown delivery never substitutes input. Concurrent operators share exact alias ownership, so one live operator cannot take another's lease.

## Retained source metadata

Built-in descriptors bind each provider's record URL, attribution and metadata terms. Only a complete, validated, sealed generation sends them through public source-record API under current subject:batch_write authority and the exact alias/external_id tuple.

Metadata has an immutable request/result journal: first write expects no revision; changed descriptors use the last returned revision. Response-loss replay reuses original bytes/key; unchanged acknowledged descriptors are no-ops. Failure preserves the prior baseline and subject. The current subject.sourceRecords response does not prove field support or rights to publish prose/media.

Descriptors are ≤8 KiB. A run adds ≤1 intent per bound record, or two when an unresolved intent precedes a change. Each coordinator attempt is capped at eight and each HTTP call at five, independently of semantic, statistic and media bounds.

## Registered source vocabulary mapping

The graph owner selects/traverses source rows, resolves native identities and supplies normalized rows plus exact public bindings. The pure mapper follows no IDs, searches no labels and infers no equivalence. It verifies the current release, source path/code, target type, property and qualifiers. Missing, withdrawn, concealed, wrong-type or unavailable bindings yield addressable gaps, never a similar-label fallback; valid rows survive malformed neighbors.

Bangumi/VNDB vocabulary rows cap at 128 per call and use only room remaining in the 100-command batch. Scheme/Concept bindings and diagnostics are bounded; unknown subtrees are not traversed. Proposals stay separate from current reads, acceptance, adoption and public return.

### Bangumi TVAnime websites and work evidence

Exact type-2 TVAnime: literal HTTP(S) 官方网站 → schema:url (duplicates coalesce; distinct URLs stay separate); ordinary 链接 → cited descriptive wdt:P973; Copyright → cited schema:copyrightNotice, not a licence. All cite only the exact Bangumi subject, never a source URL, identity or fetch instruction. TVSeries values cap at 1,500 characters; conversion visits ≤64 fields and emits ≤16 links, 16 notices and 16 diagnostics. A malformed occurrence cannot withhold an independent valid one.

### Bangumi Book and Character mapping

Book titles require schema:Book and exact {{Infobox animanga/Book}}; Novel, Manga, PhotoBook and BookSeries headers are excluded. 中文名 and aliases add schema:name; TVAnime aliases remain schema:alternateName. Source profile selects Book/BookSeries; manga remains Book. ISBN, publisher, pages and volumes do not create work Edition facts. Parser: ≤64 fields, 24 names, 16 omissions; exact field citations. Character identity, kind, appearance, names and explicit-unit measurements stay on Character; never guess units or blood-type Concepts.

### Bangumi Game names, dates, environment and genres

Only type-4 {{Infobox Game}} supplies fields. Scalar 中文名→zh; scalar or single-level bullet 别名→und. Platforms/engines need exact current Concept bindings. Scalar 游戏类型 stays one exact, unsplit, untranslated literal; only the exact Concept in https://rezics.com/schemes/bangumi/genres after current public verification binds. Per Game: ≤16 genre occurrences/omissions; each literal ≤200 chars/1,024 UTF-8 bytes. Player count accepts only a complete positive integer/range. 发行日期 accepts one unqualified strict Gregorian YYYY, YYYY-MM or YYYY-MM-DD for schema:datePublished; type-4 top-level, qualified, duplicate, malformed and unsupported dates omit. Preserve precision and exact subject citation. Game website→schema:url; 链接→descriptive wdt:P973; keep exact URL bytes including query/fragment and keep the fields separate even when equal. Unsafe schemes, credentials, controls, labels and mixed structures omit independently. Shared parser: ≤64 fields/65,536 bytes; projection: ≤16 website/link candidates, each selected field ≤4,096 bytes, bounded omissions. Names, date, genres, environment, player count, websites and cast remain independent.

The Game destination revision preserves the previously reviewed bangumi@14 source-genre and publication-date mappings within the actual current bangumi@15 export. This states the reviewed mapping history without assigning a new revision.

### Bangumi creator and voice credits

Selected type-2 anime and type-4 Game subject-person rows provide finite creator and voice credit roles. Role and person Concepts use the released Bangumi vocabulary. Each association keeps the exact source work/person relationship and citation; missing role or identity binding is a gap, not an inferred credit. There is no catalogue scan or name-based person match.

### Bangumi Character identity and appearance

Selected type-2 work-character rows define appearance; Character records define identity. Kind and role use distinct exact schemes/Concepts. Names use `name=und`, `name_cn=zh`, pinned Crt strings or exact type-1 CharacterDetail infobox arrays ([endpoint](https://api.bgm.tv/v0/characters/1), [schema](https://bangumi.github.io/api/dist.json)). Labels: 简体中文名=zh-Hans, 第二中文名=zh, 英文名=en, 日文名/纯假名=ja, 罗马字=und-Latn, 昵称=und. Only Crt nicknames split on full-width comma; preserve punctuation. Reconcile exact Chinese duplicates; diagnose/withhold only conflicting, ambiguous, unknown or unlabelled names. Fingerprint bounded fields/presence and retain raw infobox for replay; cite the Character endpoint. Reuse selected responses, with no name-only fetch or graph expansion. Malformed neighbors do not suppress valid facts. Bounds: 64 aliases; 4 KiB/500 codepoints each; infobox ≤32 KiB, depth 2/64 fields; 16 diagnostics; 85 commands. Physical profile ≤65,536 bytes, depth 2/64 fields, 128 scalar units, 64 quantity characters, ≤2 explicit-unit quantities and 16 diagnostics. No broader selection or second identity.

### Bangumi Game cast

A Game cast association requires a selected acknowledged type-4 Game, its actual subject-character row, the exact Character identity and a matching person-characters row for a voice performer. The Game's source work citation and role qualification are preserved. A malformed or unrelated neighbor does not suppress an independent valid cast row.

### Bangumi source publication mapping

Source dates cite the exact subject, follow its selected Book, Game, music or live-action profile, and never use dump/import time. TVAnime run facts use 放送開始, 播放结束 and 话数; top-level dates do not imply them. Missing, unknown, malformed, duplicate and unsupported precision remain distinct omissions.

### Bangumi Person biographies and careers

Selected person rows keep person:<id> identity. A nonempty source summary becomes an attributed schema:abstract. Birth-date facts use only the supported PersonDetail integers. Career strings are normalized only for an actual type-1 Person, at most seven values, and do not themselves create an occupation.

Only the vocabulary mapper emits P106, for the actual Person at exact `person:<id>`, with source-owned careers Scheme, exact current career Concept, released P106 and Person `#/career` citation. The pure converter emits none; source Concepts do not imply cross-provider equivalence. Valid items survive malformed neighbors; empty, unknown, malformed or Organization cases yield no unsupported occupation.

The career feature review retains its original identities cross-media-entities@12, bangumi-vocabulary@3 and source-vocabulary@3 as history. The current source registration uses the checked-in exports above. When the archive omits career data, only the separately authorized local showcase may use the fallback described under [Explicit local showcase publication](#explicit-local-showcase-publication).

### Open Library Work first publication date

Only the Work's optional top-level first_publish_date produces an independently keyed, cited schema:datePublished proposal. Its exact scalar remains in the normalized digest; publish_date and Edition conversion remain distinct. The converter validates the complete released statement and diagnoses malformed or unsupported forms. See the [conversion mapping and bound](../../packages/conversion/README.md#source-mappings-and-limits).

## Explicit local showcase publication

Ordinary import is proposal-only. The explicit local seed uses the common journal/public API to record finite intent, review exact native candidates, accept/adopt under current authority, then check current returned facts. A plan or acknowledgement alone is not publication. Source Concept/Scheme proposals are not canonical mappings; reread URI, type and membership before admitting dependent assertions.

Showcase inputs are bounded by the selected work/person graph, with no label/catalogue scans. Missing, retracted, concealed or changed exact bindings withhold only dependent facts; independent names, biography, identity and credits remain usable.

### Bangumi Person career acquisition

Archive careers, including empty or malformed values, win. Fetch PersonDetail only for a selected actual Person missing career or birth date; one response may supply both. At most one request for each of at most 64 Persons, sequentially spaced 250 ms, sharing the import deadline; responses are ≤64 KiB, identify the requested Person and contain ≤7 bounded careers. Invent no archive revision.

The immutable journal receipt binds exact GET `https://api.bgm.tv/v0/persons/{id}`, archive digest, response SHA-256 and optional ETag. Restart reuses the sealed response. Missing, malformed or unavailable data withholds only dependent P106/birth-date facts; identity, biography and credits stay independent. Admission uses the exact Person, Scheme, Concept and P106 mapping above.

### Media rights and replay

Converters return media intent only. Acquisition needs a supported provider source and current subject. A 202 reservation is not an available media ID: the journal records request, receipt and status. Unknown delivery reuses original bytes/key; only confirmed media enters a separately reviewed cover candidate.

Bangumi covers retain rights-holder credit, “via Bangumi” attribution, unknown image licence and cover-only use. Originals stay private; public output is re-encoded. Cover permission/metadata does not license summary prose. Rejected or missing covers remain addressable gaps without suppressing metadata. The [deletion policy](../../docs/deletion.md) fences withdrawal/takedown against refresh.

Selected Bangumi Person/Organization images use only GET `/v0/persons/{id}` `PersonDetail.images.large` under schema `2026-07-24`, after exact response-ID/archive-type match. Missing, null, blank or placeholder images are absent; alternate sizes/redirects are excluded. Immutable receipts bind archive revision/digest, response SHA-256 and optional ETag; missing revisions stay unversioned. Changed digests append journal entries; pending, unknown and fenced outcomes replay prior evidence. Acquisition stays within the selected graph and shared deadline/pacing.

## Deletion

Imports owns its source-backed candidates and retained local acquisition state. Vanished fields retract only matching owned candidates through ordinary APIs; subjects, independent adoption and unrelated statements survive. Shared takedown/withdrawal fences prevent refresh or replay from restoring removed material; see the [deletion contract](../../docs/deletion.md).

## Cost

For R retained records, B binding/journal rows, N input records, M one record/request/response bytes, q per-record commands, r page size and K concurrent records, costs are finite in supplied input, selected rows, bounded pages and commands. Indexed point work is O(log R/B); keyset pages add only bounded results. No operation scans unrelated history or catalogue state.

### Import authored Bangumi television original-run and episode count

At most 64 infobox fields and three run facts in the existing 64 KiB projection and command budget; no episode-table or broadcaster scan.

### Import authored Bangumi Game player count

At most 64 fields, eight examined count occurrences, one count and one optional qualifier.

### Bangumi creator and voice credits

At most 64 distinct role requirements per operation; existing 8,192-association, family and journal bounds apply.

### Bangumi subject relations

Source rows stream; at most 4,096 retained relation rows coalesce by unordered endpoint pair.

### Resume a sealed generation without its dump

Constant indexed admission work; existing pages contain at most 100 records and resume does not reacquire source bytes.

### Compare two retained complete captures

O(N+M) merge work with a fixed 256-row scan window; page memory is bounded by the page and window.

### Explicit source statistic removal

At most one native clear per source record/run. Unknown delivery sends no duplicate statistic intent.

### Receive admitted source classifications

O(N+A+R) for selected records, admitted intents and bounded retries; each intent remains bound to one subject/association.

### Source-only provenance refresh

Work scales with changed-record delta and bounded indexed proposal/journal work. Unchanged input adds no duplicate effects.

### Fenced statistic refresh

At most three in-memory omission groups; no additional SQL or fence request and zero statistic writes for the fenced tuple.

### Import VNDB character traits and qualified appearances

Existing 64 vocabulary-row, 100-command and 64-gap limits apply; bound character identities are reused.

### Default VNDB character-trait showcase seed

O(file bytes + (W+T+A+P+V) log R); dictionary T≤512, selected associations bounded, parent edges P≤256 and vocabulary records V≤512.

### Default VNDB release platform and medium showcase seed

Tables stream by file size; at most 4,096 distinct retained associations and the remaining source-vocabulary budget per release.

### Import VNDB character height and weight

At most two quantity facts per selected character; each invalid value yields at most one diagnostic.

### Import VNDB character blood types

At most 256 selected characters and five current-binding reads per verification lifetime.

### Publish admitted VNDB public tag associations

At most 512 dictionary tags, 256 associations and 64 vocabulary rows per work; no more than the 100-command batch.

### Operate a permitted scalar source feed

Consumes the supplied input once under the registered byte, field, page and command limits; no catalogue scan.

### Complete the rejected-cover operator journey

O(input bytes + (selected + dependencies)(1+q) log R) with bounded retry count and envelope size.

### Import Open Library edition page counts

One five-column TSV row defaults to 256 KiB; normalized projection ≤2 MiB; one bounded allowlist pass and scalar count.

### Import Bangumi Character source names

One selected Character; at most 16 preferred names, 64 aliases and 85 commands. Infobox is capped at 32 KiB, 64 fields, depth 2; names at 4 KiB/500 codepoints; at most 16 diagnostics. Reuse the selected response; no name-only fetch or graph expansion.

### Import Open Library Work first publication date

One optional Work field in the existing five-column TSV flow; at most 1,500 characters in the 2 MiB projection and one proposal within 100 commands. No Edition lookup or extra source read; existing author/work point reads remain capped at 64 per record.

### Selected showcase media acquisition and publication

Five exact roots plus direct cast/episodes; ≤64 people/Organizations per provider; ≤320 sequential detail requests and ≤320 outcomes/omissions; ≤1 MiB per response and ≤1 MiB combined sealed evidence. Selected caps: 8,192 graph edges/8 MiB (1 MiB/edge), 768 source records, 8,192 assertions, 512 vocabularies, 128 assertions/record, 256 Bangumi works, 64 creators. Deduplicated current reads cover ≤768 source plus 512 vocabulary subjects; graph targets stay selected. Candidate pages are ≤100 rows. Shared deadline/pacing; ordinary authenticated media send/status, exact bindings and current `(source, external_id, cover)` fence. No catalogue scan or generic accept-all.

### Native mixed Wikidata acquisition

O(input bytes), with existing chunk and record retention caps and no retained per-property set.

### Local zstd admission

Streaming work O(C+B); parent pipe windows ≤256 KiB, stderr ≤8 KiB, child memory 128 MiB plus fixed overhead, decoded input defaults to 256 GiB.

### Interrupted source acquisition cleanup

At most one cleanup per unfinished iterator; cancellation prevents further reads and acquisition writes.

### Review and resume a bounded partial source reduction

At most 100 records per page and 300 owned candidates per record; no catalogue or receipt-history scan.

### Adaptive writes

Active and paused records total at most K; K defaults to 16 and is capped at 64.

### Logical write retry admission

At most K live records and eight transport invocations per logical write, independent of input size and history.

### Imports erasure disposition

One indexed coordinator acknowledgement within the fixed 11-participant set; importer SQLite is not read or mutated.

### Measurement units and evidence

Database statements, rows, source bytes and HTTP requests are counted separately. Growth evidence uses fixed page, record and batch sizes; serialized bytes are not machine heap measurements.

### Credentials

At most ceil(T/240 seconds) renewals over run duration T, plus one renewal per 401 response.

### Import run

Approximately ceil(N/K) times the bounded per-record request path, plus a media tail capped by mediaDeadlineMs. Live state is O(K) plus one staged page of at most 100 rows.

### Import authored Bangumi episode members

At most 64 Episodes per selected parent; per-record converter, 300-candidate and journal limits apply.

### Import authored VNDB release dates and completeness

At most 64 selected releases, supersession depth 8 and 128 relation rows; table scans have fixed row and byte ceilings.

### Publish selected-family VNDB release dates and states

At most 64 vocabulary rows, 300 candidates and one date/state per selected release plus one status per work.

### Import authored VNDB release titles

At most 64 title rows and 64 KiB per release; at most 64 names and 64 Romanized aliases.

### Import authored VNDB release original language

At most one language fact per release, with the existing 163-command, 64 KiB and 64-release limits.

### Import authored VNDB release barcodes

At most one barcode fact per selected release; 64 releases, 163 commands, 64 KiB and 300 candidate limits.

### Import authored VNDB character names and qualified aliases

At most 64 localized names and 64 aliases per Character, 4 KiB/1,500 codepoints per value, 64 KiB input and 257 proposals.

### Import authored VNDB release minimum ages

At most 64 releases; malformed scalar diagnostics are bounded to 32 characters.

### Import authored VNDB public tag associations

At most 512 dictionary entries, 256 associations, 64 vocabulary rows per work and 300 candidates.

### Default VNDB public-tag showcase seed

At most 96 selected works, 512 dictionary tags, 256 associations, 1,024 parent edges and 512 vocabulary records.

### Default Bangumi novel/book showcase seed

At most 32 volumes and 16 authors, within existing relation, credit and journal limits.

### Import authored VNDB producer parent and subsidiary rows

O((V+P+R) log S) for admitted works, producers and bounded parent rows; sequential identity then graph delivery.

### Import authored VNDB staff aliases and credited roles

At most eight admitted works; entities are converted before work credits so person identities are already bound.

### Carry exact VNDB credits through the normal selected-family seed

At most 64 credit rows, 511 role Concepts plus one Scheme, 512 vocabulary records, 100-command batch and 65,536 bytes per record.

### Identify an imported VNDB contributor by preferred and additional source names

At most 64 selected names and 65 name commands including the identifier.

### Import authored VNDB contributor, producer and release websites

At most 32 admitted links per owner and a 64 KiB projection; public website URL rules still apply.

### Import selected VN work websites and cited Bangumi work identifiers

At most three selected families, 256 works per family and 32 links per owner.

### Import run (processor)

Processor work per record is constant in dump size and retained history; only first preparation of each statement adds per-run work.

### Retain conversion diagnostics

At most 228 diagnostic entries and 65,536 vector bytes per record; page-bounded memory.

### Retire superseded complete generations

At most 100 rows per page and O(log H+p) indexed work per page; no OFFSET or whole-history scan.

### Review and retire one unpublished capture

Indexed eligibility probes; explicit cleanup work is O(D log H) with page size at most 100.

### Review a stopped mass disappearance

Indexed header and exact-record reads; pages return at most 100 keys plus one continuation probe.

### Review diagnostic pages and exact record

At most 100 records per page, O(log(H+N)+P·D) work and O(P·D) output; no aggregate scan.

### Skipped input accounting

O(1) retained state and one indexed point write/read per run; no second acquisition pass or ignored-key set.

### Operation bounds

| Operation                    | Bound                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| CLI and bounded input        | Argument work is bounded; one owned file/stdin stream and one account key.                                             |
| Gzip and zstd                | Streaming O(C+B); fixed-size pipe windows; decoded bytes stop at configured ceiling with at most one window overshoot. |
| Dump parsing                 | O(M) per record; live memory is bounded by input window plus configured record limit, independent of history.          |
| Pure converters              | O(M); Bangumi 64 KiB, VNDB 64 KiB, Open Library 2 MiB, Wikidata 128 KiB.                                               |
| VNDB COPY chunks             | Default 256 KiB, hard 1 MiB chunk ceiling; importer configuration is at most 256 KiB.                                  |
| VNDB archive rows            | At most 65,536 bytes per row and 32 spooled rows; table and page limits apply.                                         |
| HTTP                         | O(M) buffering; default three attempts, maximum five, unsafe writes one; lower-only request/response caps.             |
| Run controls                 | Constant indexed statements per start, seal, capability and checkpoint control; no history scan.                       |
| Record staging               | At most five point statements per record plus transaction controls; commits batch at most 100 rows.                    |
| Pages                        | Keyset order; public pages at most 100, VNDB pages 16 and internal VNDB ranges 32.                                     |
| Classification and prepare   | At most 14+7q statements and 15+7q point touches plus bounded controls.                                                |
| Acknowledge and finalize     | Acknowledge at most 1+8r point statements; finalization at most r+4 statements, without COUNT.                         |
| Binding and candidate access | Exact source-keyed seeks; page at most 100; snapshots at most 65,536 bytes.                                            |
| Media journals               | At most 64 assets; each snapshot ≤65,536 bytes, relation depth ≤32 and ≤65,536 nodes.                                  |
| Coordinator                  | O(supplied bytes + S log R) acquisition and O((S+D)((1+q)log R+(1+q)log B+M)) reconciliation.                          |
| Session ownership            | Constant indexed acquire, busy, reopen and release operations by exact source alias.                                   |
| Kernel writes and fences     | At most q≤300 commands per record, 100 commands and 65,536 bytes per envelope; planning and dispatch are bounded by q. |

See [Imports acceptance](../../docs/goals/imports.capabilities.md) for the unchanged fixture, API, receiving and growth requirements.
