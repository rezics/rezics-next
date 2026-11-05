# Importer

Importer owns bounded source acquisition, run and record state, candidate journals, and recovery through caller-authorized public APIs. Conversion is pure and shared with community tools; see [conversion](../../packages/conversion/README.md). User cases and evidence limits live in the [Imports capability acceptance](../../docs/goals/imports.capabilities.md).

## Sources, grain and rights

- **Bangumi:** JSONL native subjects; unsupported types remain skipped members. Metadata and attributed summaries use CC BY-SA 3.0. Cover rights are separate.
- **VNDB:** public COPY with genuine headers and grouped native keys; API tables retain response revisions. Permitted metadata uses ODbL 1.0 and LicenseRef-DbCL-1.0; no prose, posts or images.
- **Open Library:** five-column TSV Work and Edition rows with distinct IDs. CC0-1.0 covers bibliographic metadata only; no unknown-licensed prose or covers.
- **Wikidata:** JSONL Q-items with genuine revisions and exact claims. CC0-1.0 structured data; no user text, unsupported claims or Commons images.

Registration, not aliases, dump fields or caller descriptors, sets source rights and attribution. Metadata terms do not license summaries, images or other creative content. No user posts are imported.

## Registration, identity and ordinary writes

The active registration uses Bangumi bangumi@15, VNDB vndb@8, Open Library open-library@5, Wikidata wikidata-6 and cross-media-entities cross-media-entities@15. Selected Bangumi entities compose cross-media-entities@15+bangumi@15. Vocabulary revisions belong to [conversion](../../packages/conversion/README.md#package-api).

Configured alias and exact external ID form the durable source tuple. The alias binds to one normalized API origin before run or network effects; destination placement is not authorization. Source records cannot choose provider or converter revisions. Record the genuine source revision, or unversioned with a source digest when no revision exists; never fabricate one.

A run stages one complete input generation, validates records and the mass-disappearance threshold, then seals it before public metadata or semantic writes. Its ledger tracks source, exact key, revision, digest, converter revision and new, changed or vanished decisions. Changed input creates source-backed proposals; vanished input retracts only matching importer-owned candidates. Independent subjects, identifiers, community statements and adoption remain intact. Missing, malformed, unsupported and unknown values remain distinct omissions; one omission does not suppress independent valid fields. Newly resolved dependencies on unchanged source remain observable.

Writes use ordinary bulk APIs and current permissions. There is no private database writer, SQL shortcut, new scope or grant. Before reading or writing a receipt, the importer checks current authorization. Unknown delivery retains the exact sealed actor, destination, body and key; reopening replays that intent under current authority before preparing a replacement. Current subject and tuple-home source fences apply to new, unchanged, cached and disclosed results. A takedown fence prevents refresh from restoring withdrawn material. Denial, unresolved delivery and refused media are not completion.

## Command line and recovery

Run bun services/importer/src/cli.ts with --source, --dump, --state, --api, --account-key, --account, --client and --auth, plus one source/dump/state file and API/Auth origins. --help needs no credentials, SQLite or network. Sources are bangumi, vndb, openlibrary and wikidata.

--dump - reads plain stdin. Compression is explicit: gzip for streamed Open Library and Wikidata dumps; zstd for VNDB archives or Wikidata dumps, never inferred from filenames. zstd requires one local regular file and a trusted executable. Decoded bytes default to 256 GiB; records default to 256 KiB with a hard maximum of 1 MiB, and native limits may be lower. API and Auth must be HTTPS origins without path, query, fragment or credentials. The disappearance threshold is 0–1; optional progress goes to stderr.

- preview decodes and compares with a completed baseline without public writes.
- compare and capture-comparison compare bounded plans or pages of two complete captures.
- inspect and inspect-bindings read one exact generation, binding or local journal.
- disappearance-review explains a sealed mass-disappearance stop and bounded missing-key pages.
- diagnostics pages stored diagnostics or inspects one record; it never publishes or rewrites.
- resume finishes one sealed ready/finalizing generation without the dump.
- retention and staging-retirement review or retire the exact eligible generation or unpublished capture.
- backup and validate-snapshot preserve or verify SQLite with committed WAL state.

Interrupted unsealed acquisition is discarded. Optional checkpoints cover large Bangumi, Open Library and Wikidata files and VNDB COPY. Resume verifies the same source and bytes. Sealed generations resume from their journal; unknown delivery never substitutes input. Concurrent operators share exact alias ownership, so one live operator cannot take another's lease.

## Retained source metadata

Built-in descriptors bind each provider's record URL, attribution and metadata terms. Only a complete, validated, sealed generation sends them through the public source-record API under current subject:batch_write authority and the exact alias/external-ID tuple.

Metadata has an immutable request/result journal: the first write expects no revision; changed descriptors use the last returned revision. Response-loss replay uses the original bytes and key; unchanged acknowledged descriptors are no-ops. Failure preserves the prior baseline and subject. A current subject.sourceRecords response proves neither field support nor rights to publish prose or media.

Descriptors are at most 8 KiB. A run adds at most one intent per bound record, or two when an unresolved intent precedes a change. Each coordinator attempt is capped at eight and each HTTP call at five, independently of semantic, statistic and media bounds.

## Registered source vocabulary mapping

The graph owner selects and traverses source rows, resolves native identities, and supplies normalized rows plus exact public bindings. The pure mapper follows no IDs, searches no labels and infers no equivalence. It verifies the current release, source path/code, target type, property and qualifiers. Missing, withdrawn, concealed, wrong-type or unavailable bindings yield addressable gaps, not similar-label fallbacks; valid rows survive malformed neighbors. Output uses the registered source alias, revision, digest, attribution and ordinary batch-write path. Mapping-specific command-key revisions prevent a sealed command from being replayed with changed statement bytes. Source rows cap at 128 per call and use only room remaining in the 100-command batch.

### Bangumi people, TVAnime, games and characters

For an actual type-1 Person, name is und and name_cn or the exact PersonDetail infobox key 简体中文名 is zh. Biography, names, careers and credits remain independent. A career proposal requires the actual Person/source key, source-owned careers Scheme, current bound Concept, released P106 and exact citation. Pure conversion emits no P106; source Concepts do not claim canonical occupation or cross-provider equivalence. A malformed, missing or empty career cannot erase valid sibling facts. PersonDetail career and Chinese-name acquisition shares one selected response and receipt.

TVAnime official websites remain separate schema:url statements; descriptive links remain cited P973; copyright notices remain verbatim and grant no licence. Source links are not fetched. Game Chinese names, aliases, publication dates, environments, genres, websites and work evidence remain independent, exact and cited. Type-4 source genres stay literal and unsplit; platforms and engines require current exact Concept bindings. Creator and voice credits follow Game environment/genres, then Character identity/appearance; Game cast follows Character. Each association cites its exact selected work/person or work/Character source relation and released role. Character identity, appearance, names and explicit-unit measurements stay on Character; units and blood-type Concepts are never guessed.

Only admitted source-site rows with a parsed public Bangumi /subject/N URL yield that exact numeric P5732 identifier. Person/Character URLs, other websites, titles and adaptations do not resolve identity. Game website and descriptive work-link fields retain exact URL bytes and separate properties. Open Library Work first_publish_date stays on Work; Edition dates, page counts and ISBNs remain on Edition.

### VNDB facts, tags and releases

COPY conversion retains exact table origins and native keys. Null, empty and missing optional Latin cells remain distinct in the digest: exactly empty omits only the Romanized alias; whitespace, missing and wrong-type values remain errors. Selected release names do not rank from translation flags. Dates retain year/month/day precision; TBA, unknown and absent remain distinct. Producer parent/subsidiary directions and release supersession use only their admitted outgoing source rows; no reciprocal or chronology-based edge is invented. Completeness remains a qualifier gap where no released status property exists.

Public tags require selected COPY rows and current reviewed Scheme/Concept bindings. Kana weights require an exact current /vn response for the same selected work and tag. The decimal rating, response digest and API endpoint retain their source origin. Filter and exclude user IDs, notes and votes; COPY vote counts never become weights, confidence or ratings. Missing or changed bindings withhold only their association.

The selected-family release seed reads only selected releases and works, with current reviewed development-status, platform and medium groups. Later vocabulary reseeds reuse the current seed result and latest verified groups, including released-state groups and exact source keys. A changed current binding reseeds the same selected plan; missing or retracted classification is an addressable gap and withholds only that association. Independent dates, names and editorial choices remain available. TBA/unknown are not remapped to an unreleased property.

### Wikidata exact values

A complete cited candidate must pass public Definitions validation against the actual released property. Preserve each present timezone, before and after value, including zero; absent values stay absent. Quantity amount, bounds, unit and qualifiers remain exact. If any required qualifier is unsupported, unresolved or narrowed, withhold the entire measurement. Do not invent vocabulary or an exactness flag. Unresolved keys remain cited external identifiers until a real resolution is available.

### Resolved references and reviewed catalogue seed

Conversion resolvedReferences keys and platform-seed identities are different formats. Conversion uses v1 plus compact UTF-8 JSON for the exact ordered tuple. The platform seed uses v1 plus unpadded base64url of the tuple's UTF-8 JSON. Keep exact Scheme and literal identity, current 255-byte external-ID and full public-key caps, current native receipts, and separate provider namespaces; do not normalize, hash, truncate or rewrite provider IDs.

The explicit seed publisher is the only trusted producer for the four authored reviewed-vocabulary records, including the reviewed Bangumi Episode Scheme and its seven Concepts. Seed owners are not provider records or derived UUIDs; native create/resolve receipts supply IDs. The ordinary Bangumi CLI may use the reviewed lookup, which checks exact identities, current bindings, source fences and public disclosure. It performs no label lookup or population scan. Ordinary provider imports do not invoke the seed publisher. Seed review/adoption uses current authority and fresh native heads; the importer grants nothing.

## Shared showcase and media

Ordinary import remains proposal-only. The common selected-family publisher records exact create and proposal bodies before sending and stores native IDs only after acknowledged responses. It operates on finite selected roots and direct selected graphs, not a catalogue scan. Candidate acceptance and adoption are separate authorized operations; adoption uses exact candidate IDs and preserves unrelated editorial choices. Independent current reads verify identity, endpoints, statements, qualifiers, source citations and reader routes. A missing, changed, hidden or unreadable binding withholds only the dependent result.

The development seed selects Bangumi Steins;Gate anime and book and CLANNAD anime, plus VNDB Steins;Gate and CLANNAD. It adds direct cast and episodes, not recursive work expansion or release discovery. Work links and showcase publication are separate results: source-keyed workLinks returns current source/cited-work identities and routes; showcase.published returns independently read public identities, admitted assertions and routes. No title lookup correlates them. The selected plan retains the existing graph cap of 8,192 edges and 8 MiB total, at most 1 MiB per edge, and reports overflow as a bounded gap.

Each selected VNDB link carries its raw candidate digest, normalized semantic digest, upstream entry revision and vndb-work-links@1 graph revision. At most three selected franchise families contain 256 works each, for 768 total; each owner has at most 32 links. Only selected vn_extlinks rows and matching extlinks dictionary rows are read. A website row may propose P5732 only for an exact public Bangumi subject URL after a facts fence. VN and anime identities remain separate. Missing/duplicate joins and dictionary rows are bounded gaps; malformed required headers fail with the table name.

Common publication and media refresh share one journal and exact source/tuple-home fences. Before a receipt or replay, current authorization and fences are checked. Pending or unknown outcomes retain the exact response evidence and unresolved command/key. A changed terminal response gets a distinct receipt. A nonempty plan remains recoverable; retries reuse the sealed request, independent reads verify the result, and unrelated editorial choices are preserved. Current source fences apply on unchanged and cached results. Unavailable, rejected or fenced outcomes are not success; 503/429, acquisition and reopen limits remain finite.

Content owns media rights, image processing, identity and serving; see [Content covers](../kernel/src/content/README.md#covers). The shared [operation bounds](#operation-bounds) cover media preparation, observation, resolution and route writes. A source cover needs rights-holder and via-source credit. Metadata rights do not license images. The Content URL-import/shared worker re-encodes admitted images into available media variants; originals are not public. Exact candidate adoption and current public identity/readback are separate from media completion, and current served variants follow Content policy. No hotlink, metadata licence, BFF or reservation proves an available public cover. Takedown fences the source cover field so refresh cannot restore it.

Bangumi PersonDetail fallback reads only selected actual Persons missing the relevant archive field. Exact GET /v0/persons/{id} response identity and archive type must match; only images.large is admitted for images. Missing, blank, placeholder or alternate-size images are omitted. Response bytes, digest and optional ETag are sealed; an absent source revision stays unversioned. Changed digests append immutable receipts. Pending, unknown and fenced outcomes reuse prior evidence. A retryable 503 or 429 is retained as unavailable without inventing a reservation or Media ID; independent text facts may finish and the image gap remains addressable. The source summary and image rights stay separate.

## Deletion

Vanished source fields retract only matching importer-owned candidates through ordinary APIs. Subjects, adoption and unrelated statements survive. Shared source and media fences prevent replay or refresh from restoring withdrawn material; see the [deletion contract](../../docs/deletion.md).

## Cost

R is source records, B binding/journal rows, N input bytes, M record/request/response bytes, q commands per record, r page size, K concurrent records and H retained generations. Work follows finite supplied input, selected rows, pages and commands. Indexed points are O(log R) or O(log B); keyset pages add bounded rows. There are no unrelated source-history or catalogue scans. These are logical bounds, not physical PostgreSQL counts or timing measurements.

### Cost: Bangumi PersonDetail acquisition

- **Touches:** at most 64 selected Persons/responses per provider/acquisition, one exact response and current Person/Scheme/Concept reads.
- **Bound:** requests are sequential with a 250 ms gap under the shared deadline; each response is at most 64 KiB and contains at most seven bounded careers. No archive revision is invented.
- **Growth check:** services/importer/tests/showcase-bangumi-person-careers.test.ts covers archive precedence, receipt, malformed response and sealed replay; services/kernel/test/imports/bangumi-person-careers.test.ts covers review/adoption and current reads. Native execution remains integration-owned.

### Cost: selected showcase media acquisition and publication

- **Touches:** five exact roots plus direct cast and episodes; at most 64 people/organizations per provider, 320 sequential detail requests and 320 outcomes/omissions; at most 1 MiB per response and 1 MiB combined sealed source evidence.
- **Bound:** selected graph at most 8,192 edges/8 MiB total and 1 MiB per edge; 768 source records, 8,192 assertions, 512 vocabulary records, 128 assertions per record, 100 candidates per page, 256 Bangumi works, 64 creators and 320 media outcomes. Deduplicated current reads cover at most 768 source plus 512 vocabulary subjects. Required targets stay selected. There is no catalogue scan or generic accept-all.
- **Growth check:** services/importer/tests/showcase-media.test.ts covers recovery, changed evidence, unavailable and unknown sends; services/importer/tests/showcase-publication.test.ts covers exact candidates and current reads; services/kernel/test/imports/showcase-media.test.ts retains review, public read, served variants and takedown. Actual selected-seed walkthrough remains integration-owned.

### Cost: selected VNDB release dates and states

- **Touches:** selected releases, release/work associations, reviewed development-status IDs, selected platform/media Concepts, current reads and the existing seed/common publisher.
- **Bound:** at most 64 releases, 64 vocabulary rows, 300 candidates and one date or state per selected release plus one status per work; supersession depth 8 and at most 128 relation rows. No standalone first-64 planner or catalogue scan.
- **Growth check:** services/importer/tests/showcase-vndb-releases.test.ts covers reseed, changed classification and retracted binding; services/kernel/test/imports/showcase-vndb-releases.test.ts retains CLI, reopen and independent reads.

### Cost: shared reviewed VNDB tags and Kana weights

- **Touches:** selected tags, tag parents, selected work associations, closed dictionary, current reviewed bindings and exact Kana response receipts.
- **Bound:** at most 96 selected works, 512 dictionary tags, 256 associations, 1,024 parent edges, 8 closure steps, 512 vocabulary records and 64 KiB per selected-work record. Kana reads at most 512 bound tags; each response is at most 64 KiB, 6 MiB total, 3.5 seconds per request and 120 seconds per run. Pending replay adds no source request. No user vote aggregate or unrelated row materialization.
- **Growth check:** services/importer/tests/showcase-tags.test.ts and showcase-publication.test.ts cover selected rows, bounded Kana reads, exact evidence, withheld ratings, refresh and replay; services/kernel/test/imports/vndb-public-tags.test.ts retains native review/adoption and independent reads.

### Cost: VNDB work links and franchise relations

- **Touches:** verified COPY headers, selected vn_extlinks joins, matching extlinks dictionary rows, converted selected works and current reads.
- **Bound:** at most three families, 256 works per family and 32 links per owner; W≤768 and L≤32, so selected joins and candidates are O(W×L). Dictionary work is O(K) for selected keys only. No per-field permission query or catalogue scan.
- **Growth check:** services/importer/tests/showcase-work-links.test.ts covers exact joins, unsupported source URLs, digest separation and overflow; services/kernel/test/imports/showcase-work-links.test.ts retains proposal, adoption, independent reads, reopen and facts fence.

### Other source and recovery bounds

- TVAnime original-run conversion visits at most 64 infobox fields and emits three run facts within the 64 KiB projection; it never scans episode or broadcaster tables. Game player count visits 64 fields and eight count occurrences, emitting one count and at most one qualifier.
- Creator/voice credits require at most 64 distinct roles per operation and retain the existing 8,192-association, family and journal bounds. Bangumi subject relations stream and retain at most 4,096 rows, coalesced by unordered endpoint pair. Episode-member import admits at most 64 Episodes per selected parent.
- Sealed-generation resume is constant indexed admission work, with pages of at most 100 records and no reacquisition. Comparing two complete captures is O(N+M) with a fixed 256-row window. Source-only provenance refresh follows changed-record delta; unchanged input adds no duplicate effects.
- One source statistic clear is admitted per record/run. Fenced statistic refresh retains at most three omission groups and performs no extra SQL, fence read or statistic write. Admitted source classification is O(N+A+R) over selected records, intents and bounded retries.
- VNDB character appearance uses at most 64 vocabulary rows, 100 commands and 64 gaps. Character-trait seed work is O(file bytes +(W+T+A+P+V) log R), with T≤512, P≤256 and V≤512. Platform/media tables stream by file size and retain at most 4,096 associations plus remaining vocabulary slots per release.
- VNDB height/weight emits at most two quantity facts per selected Character; each invalid value has at most one diagnostic. Blood-type seed selects at most 256 Characters and performs five current-binding reads per verification lifetime. Public-tag import touches at most 512 dictionary tags, 256 associations and 64 vocabulary rows per work within the 100-command batch.
- A scalar source feed consumes supplied input once under registered byte, field, page and command limits. Rejected-cover work is O(input bytes +(selected + dependencies)(1+q) log R), with bounded retries and envelope. Open Library Edition page counts use one five-column TSV row, 256 KiB input and 2 MiB normalized projection.
- Bangumi Character names use one selected Character, at most 16 preferred names, 64 aliases and 85 commands; the infobox is at most 32 KiB, 64 fields and depth 2, values at most 4 KiB/500 codepoints, with at most 16 diagnostics. PersonDetail name import uses at most 64 selected Persons/responses, 65,536-byte bodies, two name proposals per Person and 16 diagnostics, without graph roots or identity lookup.
- Wikidata time/quantity conversion admits one JSONL record of at most 128 KiB, 64 statements, 100 commands, 15 references per claim and 16 snaks per group. Native route, binding, receipt and fence bounds remain separate. Mixed acquisition is O(input bytes) with existing chunk/record limits and no per-property set.
- zstd streaming is O(C+B), with parent pipe windows at most 256 KiB, stderr at most 8 KiB, a 128 MiB child cap and 256 GiB default decoded-input ceiling. Interrupted acquisition performs at most one cleanup; cancellation prevents further reads and writes. Partial-reduction review pages at most 100 records and 300 owned candidates per record, without catalogue or receipt-history scans.
- Adaptive writes keep active and paused records at K≤64 (default 16). A logical write admits at most eight transport invocations, independent of input size/history. Importer erasure contributes one indexed acknowledgement within the fixed 11-participant set and does not read or mutate importer SQLite.
- Count database statements, rows, source bytes and HTTP requests separately. Credentials renew at most ceil(T/240 seconds) times over duration T, plus one renewal per 401. A run costs approximately ceil(N/K) bounded per-record request paths plus a media tail capped by mediaDeadlineMs; live state is O(K) plus one staged page of at most 100 rows.

- Open Library Work first publication uses one optional field in the five-column TSV flow, at most 1,500 characters in the 2 MiB projection and one proposal within 100 commands; no Edition lookup or extra read, and existing author/work point reads cap at 64 per record.
- Selected Bangumi Episodes cap at 64 per parent and retain the 300-candidate and journal limits. VNDB selected releases cap at 64; release supersession depth is 8 with at most 128 relation rows. Release titles cap at 64 rows and 64 KiB per release; original language and barcodes cap at one fact per release with 163 commands, 64 releases and 64 KiB, while barcodes retain the 300-candidate cap.
- VNDB localized Character names and aliases cap at 64 each, values at 4 KiB/1,500 codepoints, input at 64 KiB and proposals at 257. Minimum ages cap at 64 releases; malformed scalar diagnostics at 32 characters. Selected VNDB tags use at most 512 dictionary entries, 256 associations, 64 vocabulary rows per work and 300 candidates.
- The default Bangumi novel/book showcase caps at 32 volumes and 16 authors. VNDB producer parent/subsidiary work is O((V+P+R) log S) for admitted works/producers/parent rows and delivers identity before relations. Staff aliases cover at most eight works; exact credit seeds cap at 64 credit rows, 511 role Concepts plus one Scheme, 512 vocabulary records, 100 commands and 65,536 bytes per record.
- Selected contributor names cap at 64 values and 65 commands including identity. Contributor, producer and release websites cap at 32 links per owner and a 64 KiB projection. The selected-family link contract separately caps three families, 256 works each and 32 links per owner.

### Cost: retain conversion diagnostics

- **Touches:** exact generation, record and phase keys with bounded diagnostic payloads.
- **Bound:** at most 228 diagnostic entries and 65,536 vector bytes per record; indexed point operations use at most four statements/point rows per record plus two transaction controls.
- **Growth check:** tests/conversion-diagnostics-growth.test.ts.

### Cost: retire superseded complete generations

- **Touches:** one source's indexed generations and generation-local rows selected for retirement.
- **Bound:** at most 100 selected generations and 100 rows per page; O(log H+p) indexed page work, without OFFSET or a whole-history scan.
- **Growth check:** tests/retention-growth.test.ts.

### Cost: retire unpublished staging

- **Touches:** one exact source/generation review and explicit bounded cleanup.
- **Bound:** indexed eligibility probes; counts cost O(D) once per review and cleanup O(D log H), with page size at most 100.
- **Growth check:** tests/staging-retirement-growth.test.ts.

### Operation bounds

| Operation | Touches and bound | Growth check |
| --- | --- | --- |
| CLI entry and bounded input | Validates exact HTTPS origins before I/O; A≤16 KiB and owner key K≤16 KiB; one input read. | tests/cli-outcomes.test.ts |
| Streaming gzip dump transform | O(C+B); reader windows Wc,Wd≤256 KiB plus configured zlib window. | tests/compressed-dump-growth.test.ts |
| Streaming zstd dump transform | O(C+B); parent windows ≤256 KiB plus 8 KiB stderr; child memory cap 128 MiB. | tests/zstd-input.test.ts |
| Dump lines and parsing | O(M) scan/parse per line; live input O(C+L) with bounded record lines. | tests/dumps-growth.test.ts |
| Bangumi pure conversion | O(M), one source projection; static bounds in conversion README. | packages/conversion/tests/bangumi-growth.test.ts |
| VNDB pure conversion | O(M), one source projection; static bounds in conversion README. | packages/conversion/tests/vndb-growth.test.ts |
| Open Library pure conversion | O(M), one source projection; static bounds in conversion README. | packages/conversion/tests/open-library-growth.test.ts |
| Wikidata pure conversion | O(M), one source projection; static bounds in conversion README. | packages/conversion/tests/wikidata-growth.test.ts |
| VNDB raw entry chunks | Full backing admitted before projection; row ≤65,536 bytes, hard ceiling 1 MiB. | tests/vndb-chunk-growth.test.ts |
| VNDB archive streaming and staging | O(M) supplied bytes; spool pages of 32; keyed state and bounded row payloads. | tests/vndb-tables-growth.test.ts |
| VNDB validation, projection page and cleanup | Keyset pages of at most 32 rows plus bounded terminal ranges. | tests/vndb-tables-growth.test.ts |
| Retain conversion diagnostics | Exact generation/record/phase keys; ≤4 statements/point rows per record plus 2 transaction controls. | tests/conversion-diagnostics-growth.test.ts |
| Retire superseded complete generations | Indexed source/run prefixes; p≤100 per page and at most 100 selected generations. | tests/retention-growth.test.ts |
| Retire unpublished staging | Exact generation; indexed review and bounded cleanup, counts O(D) once per review. | tests/staging-retirement-growth.test.ts |
| Review diagnostic pages and exact record | One source and generation point read; keyset page P+1 and P diagnostic rows. | tests/diagnostics-cli-growth.test.ts |
| Binding inspection overview, page and exact request | Exact owner point reads; keyset page P≤100; bounded request body. | tests/binding-inspection-growth.test.ts |
| Fetch one request | Exact request and response bytes; attempts default 3, maximum 5; O(aM) transmitted bytes. | tests/import-fetch-growth.test.ts |
| Run start, capability, seal and checkpoint controls | Indexed generation/lease points; at most 3 statements per control operation plus transaction controls. | tests/run-store-growth.test.ts |
| Review a stopped mass disappearance | Exact source/generation header; page L≤101 including continuation. | tests/disappearance-review-growth.test.ts |
| Run stage one record | Exact generation, entry and member keys; at most 5 point statements per record plus 2 controls. | tests/run-store-growth.test.ts |
| Run pages and stored projection/observation | Keyset pages of r≤100; staged, pending and vanished pages add only bounded lookahead rows. | tests/run-store-growth.test.ts |
| Run classify, prepare and omission checks | Exact generation/entry/command keys; bounded omission and candidate rows. | tests/run-store-growth.test.ts |
| Run acknowledgement and finalize checkpoint | At most 1+8r point statements/rows; response envelope ≤65,536 bytes. | tests/run-store-growth.test.ts |
| Record get, count, page and upsert | Exact record/source keys; get/count one row, pages r rows; put 2–3 point operations. | tests/sqlite-growth.test.ts |
| Binding lookup, candidate page and media projection | Exact source/external ID and journal keys; candidate pages ≤100; bounded media projection. | tests/bindings-growth.test.ts |
| Binding prepare, acknowledge and taken-down write | Exact owner/media/group keys; bounded candidate and receipt mutations. | tests/bindings-growth.test.ts |
| Media prepare, accept and observe | Exact owner/media keys; prepare ≤4 point statements, accept/observe ≤3 plus controls. | tests/bindings-growth.test.ts |
| Media resolution | At most 64 assets; each snapshot ≤65,536 bytes, depth ≤32 and 65,536 nodes. | tests/media-resolver-outcomes.test.ts |
| Checkpointed staging resume | Hashes the complete local bytes; indexed prefix and checkpoint per accepted record. | tests/staging-checkpoint-growth.test.ts |
| Checkpointed VNDB table resume | Hashes original file; resumes accepted COPY effects with bounded spool pages of 32. | tests/vndb-acquisition-growth.test.ts |
| Coordinator acquisition and reconciliation | O(input bytes + S log R); stages to EOF and seals before effects. | tests/importer-reconciliation-growth.test.ts |
| Session ownership and recovery | Exact source lease; acquire at most 2 point statements, busy at most 1 plus controls. | tests/importer-reconciliation-growth.test.ts |
| Kernel writes and fence reads per record/batch | e≤q≤300 per prepared record; each batch ≤100 commands and 65,536 bytes; route limits remain separate from conversion. | tests/import-fetch-growth.test.ts |
