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

Decision: `sourceParents` retains child/parent keys, category, path, main. Missing, cyclic or cross-category ancestry withholds edges; source closure grants no native hierarchy admission or equivalence.

Public tags need COPY rows and current reviewed Scheme/Concept bindings. Kana weights need an exact current /vn response for the selected work/tag, retaining decimal rating, response digest and endpoint. Exclude user IDs, notes and votes; COPY votes are never weights, confidence or ratings. Changed or missing bindings withhold only their association.

Selected-family release seeds read only selected works/releases and current reviewed development-status/platform/medium groups. Reseeds reuse the current seed result, latest verified groups, released states and exact keys. Changed bindings reseed the same plan; missing/retracted classification gaps withhold only that association. Dates, names and editorial choices survive; TBA/unknown never means unreleased.

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

- Touches: selected `releases` / `releases_vn` / `vn.devstatus` rows, reviewed development-status IDs, selected platform/media Concepts, current native reads, optional UUID binding file, the existing seed and common ShowcaseJournal publisher. Dates and admitted classifications stay on actual selected Release/Work identities; later vocabulary phases reuse the composed result and current groups. The standalone first-64 archive planner is not invoked.
- Bound: one date or released-state row per selected release and one development-status row per selected work, within the existing 64-release, per-record vocabulary (64 rows), candidate (≤300) and journal budgets. Current scheme/concept reads remain limited to selected state and platform/media dependencies; no catalogue scan or extra publication path. Completeness stays a `wdt:P31` qualifier gap. TBA/unknown stay withheld because the current Release profile omits `schema:keywords` and the reviewed inventory has no released-state Concepts; do not remap them to `schema:creativeWorkStatus`. `schema:exampleOfWork` stays on the existing graph edge.
- Growth check: `tests/showcase-vndb-releases.test.ts` covers a later selected-family reseed, changed current classification and a retracted binding. `services/kernel/test/imports/showcase-vndb-releases.test.ts` authors the full CLI, exact reopen, source refresh and independent current-read path; native execution remains controller-owned. Existing importer reconciliation and native sourced-write suites retain their units.

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

- Touches: streamed `tags`, `tags_parents` and `tags_vn` COPY rows for the selected family, at most 1024 parent edges and 8 closure steps, dictionary ConceptScheme/Concept proposals through the existing coordinator and showcase journal, current disclosed scheme/concept reads, selected Kana `/vn` observations, admitted `schema:genre` and qualified weight proposals, exact work/path/tag-to-Concept identities in the common intent, plus their current native reads before review through the common publishShowcase accept/adopt/public-read path. Individual user ids, notes and votes stay unprojected.
- Bound: O(file bytes) stream plus O((W+T+A+P+V) log R) importer work for selected works W≤96, closed dictionary T≤512, associations A≤256, parent edges P≤1024 and vocabulary records V≤512. Selected VN titles cap at 64 rows and the existing 64 KiB source-record budget per work. Kana requests at most 512 currently bound tags, with 64 KiB per response, 6 MiB total, 3.5 seconds per request and 120 seconds per run. The common SQLite journal retains one indexed receipt per acquired work/refresh, including exact request, response bytes, digest and binding identities; pending replay adds no source request. Publication adds at most one current facts-fence point read per refreshed work. Dictionary schemes publish before Concepts; current released type, exact `schema:url` and `skos:inScheme` are reread for each association. Rating receipts remain separate from membership; COPY votes never supply weight. Deduplicated current reads stay inside their existing freshness lifetime. Unrelated VN/tag rows are not materialized. No catalogue scan or vote aggregate.
- Growth check: `tests/showcase-tags.test.ts` covers selected and unrelated rows, selected-work overflow, unsupported/qualified associations, bounded Kana requests, exact decimal/response evidence, withheld ratings, independent spoiler levels, changed-response refresh, stable identities and byte-identical reopen. `tests/showcase-publication.test.ts` covers exact selected association citations, a lost proposal ACK with exact reopen, wrong-Scheme withholding, refused review and independent work reads. `services/kernel/test/imports/vndb-public-tags.test.ts` exercises actual selected Kana acquisition, native acceptance/adoption, independent public reading, terminal refresh, unavailable transport and current facts fences. Existing native physical-growth obligations and tolerances remain unchanged; journal counts are local SQLite executions.

### Default Bangumi novel/book showcase seed

Decision: preserve Book Girl (series 499, seed volume 26) and add Kara no Kyoukai (series 2815, seed volume 5329); the pinned dump supports volumes 5329/10862, author 1466, illustrator 1467, publisher Organization 128 and the series relation to movie 233. The source archive is `dump-2026-10-20.210332Z.zip`, SHA-256 `9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93`; exact source rows are listed in `showcase-book-series.ts`. Bangumi relation.1 code 1 remains the released neutral cross-media counterpart relation.

- Touches: one sequential pass each over `subject-relations`, `subject`, `subject-persons` and `person`, capped at 1,000,000/500,000/500,000/100,000 rows and 512/512/256/128 MiB respectively; selected identities and relation evidence flow into the existing `seedCrossMedia` journal and publication path. A publisher is admitted only by its actual supported Organization row and identity; title text and editions do not fill missing evidence.
- Bound: at most 32 member candidates per family, 16 distinct creator identities and 64 selected credit rows. At most two duplicate source rows per membership direction and four rows for the selected anime relation are retained; excess source evidence becomes a gap. Selected records, relation rows and creator rows stay proportional to these caps; unrelated identities are never materialized.
- Growth check: `tests/showcase-book-series.test.ts` covers both retained families, exact volume ordering, supported roles, selected anime endpoint, missing endpoints, unknown/ambiguous ordinals and absent publisher evidence. `tests/showcase-books.test.ts` covers proposal, acceptance, adoption, current reads and exact durable reopen. Native/browser seeded-stack acceptance is run by the integration verifier.

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

- **Touches:** five exact roots plus direct cast and episodes; at most 64 people/organizations per provider, 320 sequential detail requests and 320 outcomes/omissions; at most 1 MiB per response and 1 MiB combined sealed source evidence.
- **Bound:** selected graph at most 8,192 edges/8 MiB total and 1 MiB per edge; 768 source records, 8,192 assertions, 512 vocabulary records, 128 assertions per record, 100 candidates per page, 256 Bangumi works, 64 creators and 320 media outcomes. Deduplicated current reads cover at most 768 source plus 512 vocabulary subjects. Required targets stay selected. There is no catalogue scan or generic accept-all.
- **Growth check:** services/importer/tests/showcase-media.test.ts covers recovery, changed evidence, unavailable and unknown sends; services/importer/tests/showcase-publication.test.ts covers exact candidates and current reads; services/kernel/test/imports/showcase-media.test.ts retains review, public read, served variants and takedown. Actual selected-seed walkthrough remains integration-owned.

### Cost: selected VNDB release dates and states

- **Touches:** selected releases, release/work associations, reviewed development-status IDs, selected platform/media Concepts, current reads and the existing seed/common publisher.
- **Bound:** at most 64 releases, 64 vocabulary rows, 300 candidates and one date or state per selected release plus one status per work; supersession depth 8 and at most 128 relation rows. No standalone first-64 planner or catalogue scan.
- **Growth check:** services/importer/tests/showcase-vndb-releases.test.ts covers reseed, changed classification and retracted binding; services/kernel/test/imports/showcase-vndb-releases.test.ts retains CLI, reopen and independent reads.

### Cost: shared reviewed VNDB tags and Kana weights

Decision: retain parent edges as source evidence with exact source paths and current native IDs; require both endpoints in the same current category Scheme before keeping dependent work-tag associations. `main` remains VNDB tree bookkeeping, not a native qualifier.

- **Touches:** selected tags, tag parents, selected work associations, closed dictionary, current reviewed bindings and exact Kana response receipts.
- **Bound:** at most 96 selected works, 512 dictionary tags, 256 associations, 1,024 parent edges, 8 closure steps, 512 vocabulary records and 64 KiB per selected-work record. Kana reads at most 512 bound tags; each response is at most 64 KiB, 6 MiB total, 3.5 seconds per request and 120 seconds per run. Pending replay adds no source request. No user vote aggregate or unrelated row materialization.
- **Growth check:** services/importer/tests/showcase-tags.test.ts and showcase-publication.test.ts cover selected rows, bounded Kana reads, exact evidence, withheld ratings, refresh and replay; showcase-cross-provider-tags.test.ts covers exact current parent bindings and dependent association withholding; services/kernel/test/imports/vndb-public-tags.test.ts retains native review/adoption and independent reads.

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

| Operation                                           | Touches and bound                                                                                                      | Growth check                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| CLI entry and bounded input                         | Validates exact HTTPS origins before I/O; A≤16 KiB and owner key K≤16 KiB; one input read.                             | tests/cli-outcomes.test.ts                            |
| Streaming gzip dump transform                       | O(C+B); reader windows Wc,Wd≤256 KiB plus configured zlib window.                                                      | tests/compressed-dump-growth.test.ts                  |
| Streaming zstd dump transform                       | O(C+B); parent windows ≤256 KiB plus 8 KiB stderr; child memory cap 128 MiB.                                           | tests/zstd-input.test.ts                              |
| Dump lines and parsing                              | O(M) scan/parse per line; live input O(C+L) with bounded record lines.                                                 | tests/dumps-growth.test.ts                            |
| Bangumi pure conversion                             | O(M), one source projection; static bounds in conversion README.                                                       | packages/conversion/tests/bangumi-growth.test.ts      |
| VNDB pure conversion                                | O(M), one source projection; static bounds in conversion README.                                                       | packages/conversion/tests/vndb-growth.test.ts         |
| Open Library pure conversion                        | O(M), one source projection; static bounds in conversion README.                                                       | packages/conversion/tests/open-library-growth.test.ts |
| Wikidata pure conversion                            | O(M), one source projection; static bounds in conversion README.                                                       | packages/conversion/tests/wikidata-growth.test.ts     |
| VNDB raw entry chunks                               | Full backing admitted before projection; row ≤65,536 bytes, hard ceiling 1 MiB.                                        | tests/vndb-chunk-growth.test.ts                       |
| VNDB archive streaming and staging                  | O(M) supplied bytes; spool pages of 32; keyed state and bounded row payloads.                                          | tests/vndb-tables-growth.test.ts                      |
| VNDB validation, projection page and cleanup        | Keyset pages of at most 32 rows plus bounded terminal ranges.                                                          | tests/vndb-tables-growth.test.ts                      |
| Retain conversion diagnostics                       | Exact generation/record/phase keys; ≤4 statements/point rows per record plus 2 transaction controls.                   | tests/conversion-diagnostics-growth.test.ts           |
| Retire superseded complete generations              | Indexed source/run prefixes; p≤100 per page and at most 100 selected generations.                                      | tests/retention-growth.test.ts                        |
| Retire unpublished staging                          | Exact generation; indexed review and bounded cleanup, counts O(D) once per review.                                     | tests/staging-retirement-growth.test.ts               |
| Review diagnostic pages and exact record            | One source and generation point read; keyset page P+1 and P diagnostic rows.                                           | tests/diagnostics-cli-growth.test.ts                  |
| Binding inspection overview, page and exact request | Exact owner point reads; keyset page P≤100; bounded request body.                                                      | tests/binding-inspection-growth.test.ts               |
| Fetch one request                                   | Exact request and response bytes; attempts default 3, maximum 5; O(aM) transmitted bytes.                              | tests/import-fetch-growth.test.ts                     |
| Run start, capability, seal and checkpoint controls | Indexed generation/lease points; at most 3 statements per control operation plus transaction controls.                 | tests/run-store-growth.test.ts                        |
| Review a stopped mass disappearance                 | Exact source/generation header; page L≤101 including continuation.                                                     | tests/disappearance-review-growth.test.ts             |
| Run stage one record                                | Exact generation, entry and member keys; at most 5 point statements per record plus 2 controls.                        | tests/run-store-growth.test.ts                        |
| Run pages and stored projection/observation         | Keyset pages of r≤100; staged, pending and vanished pages add only bounded lookahead rows.                             | tests/run-store-growth.test.ts                        |
| Run classify, prepare and omission checks           | Exact generation/entry/command keys; bounded omission and candidate rows.                                              | tests/run-store-growth.test.ts                        |
| Run acknowledgement and finalize checkpoint         | At most 1+8r point statements/rows; response envelope ≤65,536 bytes.                                                   | tests/run-store-growth.test.ts                        |
| Record get, count, page and upsert                  | Exact record/source keys; get/count one row, pages r rows; put 2–3 point operations.                                   | tests/sqlite-growth.test.ts                           |
| Binding lookup, candidate page and media projection | Exact source/external ID and journal keys; candidate pages ≤100; bounded media projection.                             | tests/bindings-growth.test.ts                         |
| Binding prepare, acknowledge and taken-down write   | Exact owner/media/group keys; bounded candidate and receipt mutations.                                                 | tests/bindings-growth.test.ts                         |
| Media prepare, accept and observe                   | Exact owner/media keys; prepare ≤4 point statements, accept/observe ≤3 plus controls.                                  | tests/bindings-growth.test.ts                         |
| Media resolution                                    | At most 64 assets; each snapshot ≤65,536 bytes, depth ≤32 and 65,536 nodes.                                            | tests/media-resolver-outcomes.test.ts                 |
| Checkpointed staging resume                         | Hashes the complete local bytes; indexed prefix and checkpoint per accepted record.                                    | tests/staging-checkpoint-growth.test.ts               |
| Checkpointed VNDB table resume                      | Hashes original file; resumes accepted COPY effects with bounded spool pages of 32.                                    | tests/vndb-acquisition-growth.test.ts                 |
| Coordinator acquisition and reconciliation          | O(input bytes + S log R); stages to EOF and seals before effects.                                                      | tests/importer-reconciliation-growth.test.ts          |
| Session ownership and recovery                      | Exact source lease; acquire at most 2 point statements, busy at most 1 plus controls.                                  | tests/importer-reconciliation-growth.test.ts          |
| Kernel writes and fence reads per record/batch      | e≤q≤300 per prepared record; each batch ≤100 commands and 65,536 bytes; route limits remain separate from conversion.  | tests/import-fetch-growth.test.ts                     |
| Operation                                           | Bound                                                                                                                  |
| ----------------------------                        | ---------------------------------------------------------------------------------------------------------------------- |
| CLI and bounded input                               | Argument work is bounded; one owned file/stdin stream and one account key.                                             |
| Gzip and zstd                                       | Streaming O(C+B); fixed-size pipe windows; decoded bytes stop at configured ceiling with at most one window overshoot. |
| Dump parsing                                        | O(M) per record; live memory is bounded by input window plus configured record limit, independent of history.          |
| Pure converters                                     | O(M); Bangumi 64 KiB, VNDB 64 KiB, Open Library 2 MiB, Wikidata 128 KiB.                                               |
| VNDB COPY chunks                                    | Default 256 KiB, hard 1 MiB chunk ceiling; importer configuration is at most 256 KiB.                                  |
| VNDB archive rows                                   | At most 65,536 bytes per row and 32 spooled rows; table and page limits apply.                                         |
| HTTP                                                | O(M) buffering; default three attempts, maximum five, unsafe writes one; lower-only request/response caps.             |
| Run controls                                        | Constant indexed statements per start, seal, capability and checkpoint control; no history scan.                       |
| Record staging                                      | At most five point statements per record plus transaction controls; commits batch at most 100 rows.                    |
| Pages                                               | Keyset order; public pages at most 100, VNDB pages 16 and internal VNDB ranges 32.                                     |
| Classification and prepare                          | At most 14+7q statements and 15+7q point touches plus bounded controls.                                                |
| Acknowledge and finalize                            | Acknowledge at most 1+8r point statements; finalization at most r+4 statements, without COUNT.                         |
| Binding and candidate access                        | Exact source-keyed seeks; page at most 100; snapshots at most 65,536 bytes.                                            |
| Media journals                                      | At most 64 assets; each snapshot ≤65,536 bytes, relation depth ≤32 and ≤65,536 nodes.                                  |
| Coordinator                                         | O(supplied bytes + S log R) acquisition and O((S+D)((1+q)log R+(1+q)log B+M)) reconciliation.                          |
| Session ownership                                   | Constant indexed acquire, busy, reopen and release operations by exact source alias.                                   |
| Kernel writes and fences                            | At most q≤300 commands per record, 100 commands and 65,536 bytes per envelope; planning and dispatch are bounded by q. |

See [Imports acceptance](../../docs/goals/imports.capabilities.md) for the unchanged fixture, API, receiving and growth requirements.
These bounds follow `src/` and `../../packages/conversion/src/`: R is stored records (including retained run history), B is binding/journal rows, M is one record/request/response's bytes, r is one page/batch's records, and k is rows changed; H is records already seen in a dump, C is a supplied chunk's backing bytes, S is supplied table/snapshot rows, D is disappearances, and q is commands for one record.
An indexed point operation examines at most one matching row plus O(log R) or O(log B) B-tree navigation; a keyset range examines its bounded results plus that navigation, without OFFSET, history enumeration, or COUNT scans.
Below, PK means the declared primary-key index, SELECT/INSERT/UPDATE/DELETE counts exclude connection-time schema/PRAGMA work, and each transaction adds BEGIN IMMEDIATE plus COMMIT (or ROLLBACK on failure); methods make zero kernel calls unless explicitly described.
Run/record pages cap r at 100, VNDB pages at 16, internal VNDB ranges at 32, and command/result batches at 100; public run projections/envelopes and binding snapshots cap M at 65,536 bytes; `readDump`/`runDump` source records default to 256 KiB with a hard 1 MiB maximum, while source-record staging separately budgets serialized normalized records at 1 MiB plus a fixed wrapper; private record plans cap M at 2 MiB and q at 300 (classification alone caps q at 100); record metadata has fixed field byte limits of 64/512/256/64/128 for source/key/revision/digest/converter revision.
Growth checks below cite exact existing titles only for the exercised paths; outcome checks cover limits and failure handling rather than every growth path.

Decision: one Operation table lists each identity once; complete-generation then unpublished-staging retirement follow retain-diagnostics, matching the Cost subsections.

| Operation                                                                           | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Growth check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry and bounded input (`cli.ts`)                                              | Parses bounded argv and validates the exact origins before I/O; reads and imports one owner-only account key, opens one file or stdin with no-follow descriptor custody, owns bounded chunks, optionally gunzips Open Library/Wikidata dumps or decompresses VNDB/Wikidata zstd dumps through one owned child, and carries Open Library's native TSV date into record metadata. The `diagnostics` subcommand delegates before credentials or network construction. gzip is rejected for VNDB/Bangumi before credentials or state. zstd is rejected for Bangumi and Open Library at the same point; dump-set members stay none/gzip. | O(A + K) preflight with A ≤16 KiB and key K ≤16 KiB. One input read, O(C+B) gzip/zstd+decoder work; owned compressed and decoded windows ≤256 KiB from backings ≤1 MiB, plus one Open Library line ≤256 KiB+1. No whole-file materialization or source-key set; diagnostics ≤4 KiB. Credential network bounds are stated above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `services/importer/tests/cli-outcomes.test.ts`: real source pipeline outcomes. `specs/imports-cli.test.ts`: actual SQLite work stays fixed and streaming input grows linearly across three scales. `tests/diagnostics-cli.test.ts`: diagnostics routing, help and handle closure. `tests/compressed-dump.test.ts` and `tests/compressed-dump-cli.test.ts`: gzip admission, integrity and equivalent decoded identity.                                                                                                                                                                                                                                                                                                      |
| Streaming gzip dump transform (`compressed-dump.ts`)                                | Sits below the common owned byte reader. Member-framed `createInflateRaw` validates CRC/ISIZE/EOF; concatenated members including an empty last member are one complete input; trailing non-gzip bytes fail. Never falls back to raw text. Reports compressed and decoded bytes separately.                                                                                                                                                                                                                                                                                                                                         | O(C+B) work; retained windows O(Wc+Wd) with Wc,Wd ≤256 KiB plus zlib's configured high-water mark; decoded budget default 256 GiB with at most one window overshoot. Memory independent of whole-file size. Codec buffering is the configured production high-water mark.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/compressed-dump-growth.test.ts`: production raw and gzip paths at 32/128/512 records, ratio four, highly compressible input and a slow consumer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Streaming zstd dump transform (`zstd-input.ts`)                                     | Sits below the same owned byte reader. Spawns one trusted zstd child (`-d -c -M128MB --no-pass-through -`) and pumps descriptor-owned compressed windows to stdin. Concatenated frames, empty last frame and skippable frames are one complete input; raw passthrough and trailing non-zstd bytes fail. Capture waits for pump EOF, parser completion and child exit 0. An early parser stop still drains decoded stdout and joins the child. Reports compressed and decoded bytes separately.                                                                                                                                      | O(C+B) work; parent windows O(Wc+Wd) with Wc,Wd ≤256 KiB plus 8 KiB stderr; child window 128 MiB plus fixed overhead; decoded budget default 256 GiB with at most one window overshoot. One child per invocation. Termination grace 2s then SIGKILL and reap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/zstd-input.test.ts`: identity versus plain Wikidata, concat/skippable/empty frames, late trailing/truncated/checksum/window failure, decode budget, missing/incompatible executable, hang SIGKILL, stderr flood and replaced file. `tests/cli-zstd.test.ts`: admission, offline preview and plan-dir reopen.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Retain conversion diagnostics (`run-store.ts`, `importer.ts`)                       | Validates the converter diagnostic array without accessors; INSERT the exact generation/record/phase identity; INSERT diagnostic-bearing review keys; UPDATE stored generation counts. Resume of the same digest/revision/converter identity is a PK seek with no second write.                                                                                                                                                                                                                                                                                                                                                     | Generation/entry/diagnostic PK exact seeks; ≤4 statements/point rows per record plus 2 transaction controls when folded into the staging commit; O(D + log R) extra work, D ≤228 and vector ≤65,536 bytes; no unrelated-generation reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/conversion-diagnostics-growth.test.ts`: `staging diagnostic retention stays indexed as diagnostic-bearing records and unrelated history grow`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Retire superseded complete generations (`retention.ts`, `retention-cli.ts`)         | Read-only list/plan of one source's generations; apply deletes generation-local rows for at most 100 explicitly named complete non-baseline IDs. Point-reads current baseline, recoverable pin, sequence, present_count and owner; keyset DELETE pages over entries/envelopes/commands/diagnostics/aggregates/leftover staging checkpoint-prefix/disappearance stop-missing evidence/VNDB run tables. Shared acknowledgements, bindings and payloads are unread.                                                                                                                                                                    | Indexed source/run prefixes; O(log H+p) per page, p≤100, selected ≤100, memory O(p+100). COUNT/EXISTS cost is the examined capture. Crash cursor persists with each bounded page. No OFFSET, payload anti-join, VACUUM or whole-history scan. Schema discovery (`run_retention_work`, `run_generation_seq`) is separate from steady-state deletion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `tests/retention-growth.test.ts`: `retention plan, apply and restart stay indexed as selected-capture rows and unrelated history grow` at 32/128/512.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Retire unpublished staging (`staging-retirement.ts`, `staging-retirement-cli.ts`)   | Read-only exact source/generation review; explicit plan; apply revalidates under conservative ownership, releases unpublished staging through a source-correct transition, then bounded selected-generation cleanup. Shared journals and the current complete baseline are unread.                                                                                                                                                                                                                                                                                                                                                  | Indexed existence probes O(log H) per fixed table; honest counts O(D) once per review; cleanup O(D log H) with p≤100 and memory O(p). No OFFSET, payload scan, VACUUM or network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/staging-retirement-growth.test.ts`: review/apply/interruption/restart at 32/128/512 selected staging rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Review diagnostic pages and exact record (`diagnostics-cli.ts`)                     | Opens an existing regular file read-only with `O_NOFOLLOW`; source/generation point lookup; indexed diagnostic-bearing keyset page; exact record PK prefix. Releases handles before rendering.                                                                                                                                                                                                                                                                                                                                                                                                                                      | 1 source + 1 generation point read, then 1 keyset SELECT of P+1 review keys and P diagnostic PK prefix reads; O(log(H+N)+P*D) local work, P≤100, output/memory O(P*D). No OFFSET, schema writes, lease, or projection JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/diagnostics-cli-growth.test.ts`: `diagnostic pages and exact lookup stay indexed as current omissions and unrelated history grow`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Binding inspection overview, page and exact request (`binding-inspection-store.ts`) | Opens an existing regular file with the shared read-only path guard; exact `binding_records` point read; optional current metadata/cover pointers and per-record group capacity; one selected journal family keyset page or one exact original-request PK. Releases handles before rendering. No `RecordBindings` constructor, WAL pragmas, lease or native call.                                                                                                                                                                                                                                                                   | Point reads O(log B); keyset page 1 SELECT of P+1 owner-prefixed rows, P≤100; body length is measured in SQL before load/hash; projection O(P·M) for M≤65,536. Memory O(P+M). No OFFSET, all-history COUNT, payload-history join or per-row table scan. Native writer paths unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/binding-inspection-growth.test.ts`: production CLI/reader at 32/128/512 retained request rows, ratio four, plus independently growing unrelated sources, records and generations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Dump lines and parsing (`dumps.ts`, `dumps-bytes.ts`)                               | Reads decompressed bytes; decodes/parses one line and yields duplicates unchanged to durable RunStore staging; no SQL/writes/API or retained native-key set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | O(M) scanning, amortized copying and parsing per record line; O(C + L) live input, line buffers, decoded scratch and COPY framing metadata, independent of H. L is caller `maxRecordBytes` + 1, + 2 for Wikidata, or max(cap + 1, 65,536) for VNDB outside COPY; accepted records remain at most cap. Chunk backing is checked before scanning/copying/yielding: default 256 KiB, maximum 1 MiB, including tiny views of larger buffers. Unterminated tails reject after L + 1 examined bytes; no next chunk is pulled before yielding. Record caps default to 256 KiB and cannot exceed 1 MiB, independently of chunk backing and normalized projection budgets; total scanning is linear in supplied bytes and skipped lines have no count cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/dumps-growth.test.ts`: `streaming parser growth follows supplied bytes with bounded per-record read-ahead`; `oversized unterminated tails abort with the same byte bound at every scale`; `one fixed admitted backing is charged in full and only the first record is visited before yield`. `tests/reader-bounds-outcomes.test.ts`: `all bounded reader outcomes pass with production parser`. Duplicate uniqueness is measured by the run-staging growth check below. `tests/record-caps-growth.test.ts`: `one-record acquisition has linear actual parser work outside database measures`; `record boundaries retain native framing overhead, UTF-8 accounting and upstream cleanup`.                            |
| Bangumi pure conversion (`../../packages/conversion/src/bangumi.ts`)                | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Normalized source ≤64 KiB, ≤64 ordinary tags and ≤64 public metadata tags, ≤6 commands and one cover intent; summary Text snapshot ≤32 KiB, infobox ≤64 KiB characters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `../../packages/conversion/tests/bangumi-growth.test.ts`: `fixed source conversion intercepts I/O at every unrelated population scale`. `../../packages/conversion/tests/logical-growth.test.ts`: `Bangumi: actual unrelated conversions leave anchor return bytes identical`; `Bangumi: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                               |
| VNDB pure conversion (`../../packages/conversion/src/vndb.ts`)                      | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Normalized grouped record ≤64 KiB, ≤64 titles, ≤32 links, strings ≤4096 bytes and ≤98 commands; no assets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `../../packages/conversion/tests/vndb-growth.test.ts`: `fixed conversion performs zero SQL network or file I/O across unrelated populations`. `../../packages/conversion/tests/logical-growth.test.ts`: `VNDB: actual unrelated conversions leave anchor return bytes identical`; `VNDB: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                               |
| Open Library pure conversion (`../../packages/conversion/src/open-library.ts`)      | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Converter normalized record ≤2 MiB, prose ≤1 MiB, field arrays ≤64, combined author/work relations ≤64 and proposals ≤100; importer admission/staging independently enforce the smaller record/projection caps above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `../../packages/conversion/tests/open-library-growth.test.ts`: `fixed conversion touches zero SQL and network across unrelated catalogue and history growth`. `../../packages/conversion/tests/logical-growth.test.ts`: `Open Library: actual unrelated conversions leave anchor return bytes identical`; `Open Library: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                               |
| Wikidata pure conversion (`../../packages/conversion/src/wikidata.ts`)              | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Native supported record ≤128 KiB, ≤64 statements and terms, ≤15 references and ≤16 snaks per bounded collection, ≤100 commands; no assets or instrumentation metrics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `../../packages/conversion/tests/wikidata-growth.test.ts`: `fixed conversion return is byte-identical after unrelated actual conversions`. `../../packages/conversion/tests/logical-growth.test.ts`: `Wikidata: actual unrelated conversions leave anchor return bytes identical`; `Wikidata: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                          |
| VNDB raw entry chunks (`vndb-tables.ts`)                                            | Admits full backing before scanning supported rows or discarding user/unknown entries; only supported entries allocate the 64 KiB row buffer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Shared chunk validator defaults to 256 KiB with a hard 1 MiB ceiling; the table loader further restricts configuration to ≤256 KiB. O(C + M) live input/row scratch (plus bounded spool pages above), with C bounded before retention/copy even for empty views; supported scanning is O(record bytes), ignored bodies count bytes without decoding. Total work is linear in admitted input, within archive admission limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/vndb-chunk-growth.test.ts`: `raw six-entry staging SQL stays constant across accumulated native keys and source history`; `native input visits grow linearly over 1/8/64 owned chunks with bounded admitted backing`; `late oversized known/header/ignored backings fail before byte access and erase staged rows`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| VNDB archive streaming and staging (`vndb-tables.ts`)                               | `begin`: INSERT run; `inspect`: SELECT run, both PK(source,run_id). Stage: keyed state UPDATE, stream six supported paths, INSERT spool before header or INSERT row + UPDATE run counters after header; drain spool via PK(source,run_id,table_name,sequence) and DELETE each consumed row; finish with keyed ready UPDATE (failure: failed UPDATE + cleanup).                                                                                                                                                                                                                                                                      | O(M) bytes scanned/decoded per supported row, raw row M ≤ 65,536 and serialized payload O(M); one fixed row buffer plus ≤32 spooled rows/decoded scratch and C backing bytes, O(C + 32M) live storage, no next chunk prefetch. Every entry is admitted before its body: total decompressed entry bytes default to 16 GiB (hard 64 GiB), entry count to 512 (hard 2048), including unknown entries and directories. Safe-integer declared sizes reserve aggregate bytes; actual bytes must match and reject over-declaration before scanning. Ignored entries are drained without decoding/row buffering. Full chunk backing is checked before retention or byte access on every raw entry, with no prefetch; `readArchive` additionally bounds tar framing and yields owned payload copies ≤512 bytes. Supported input rows capped by maxRows (default 2,000,000, maximum 10,000,000), VN records by maxSourceRecords (500,000/1,000,000). Direct row: 2 point statements; spooled row: 1 INSERT, then 1 range SELECT per ≤32 rows, 2 insert/counter statements + 1 DELETE per row. Rows touched O(k), cost O(k log R + supplied bytes); no prior-run scan.                                                                                                                                                                                                                       | `tests/vndb-tables-growth.test.ts`: `VNDB staging stays within its bound as R grows`. `tests/vndb-archive-limits-growth.test.ts`: `fixed admission rejection and ready staging keep exact-run SQL and live buffers constant over history`; `entry and byte populations stop exactly before the excessive body with linear admitted input`; `unsafe declarations, lying bodies and oversized backing close raw input without scanning or draining`.                                                                                                                                                                                                                                                                         |
| VNDB validation, projection page and cleanup                                        | Validation walks each table's PK(source,run_id,table_name,id,child) keyset; each VN seeks titles + metadata, each child seeks its VN. Page: inspect, numeric `vndb_table_ids` range, then metadata/title PK seeks per VN. Cleanup: row/spool PK prefix range SELECT and exact DELETE per row.                                                                                                                                                                                                                                                                                                                                       | Validation: 1 SELECT per ≤32 rows (plus terminal ranges), 2 SELECTs per VN or 1 per child; O(S log R + SM), not history. Title seek LIMIT children+1 ≤65 detects overflow; children ≤64; metadata 1 row. Page: 2+2r SELECTs, ≤r+1 numeric rows plus ≤66r child/metadata rows and 1 run row, O(r log R + 64rM) bytes/work. Cleanup: 1 SELECT per ≤32 rows plus 1 DELETE per row, O(k log R + kM), ending each table with a short/empty page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/vndb-tables-growth.test.ts`: `VNDB projection stays within its bound as R grows`; `VNDB validation stays within its bound as R grows`; `VNDB cleanup stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Fetch one request (`import-fetch.ts`)                                               | Reads/copies request once without teeing its stream; checks retry identity, gets one token, sends exact buffered bytes; cancels retried response bodies, buffers the final response before returning; no SQLite.                                                                                                                                                                                                                                                                                                                                                                                                                    | O(M) amortized CPU/owned buffered bytes and O(aM) transmitted bytes; a defaults to 3, maximum 5 (unsafe writes 1), with ≤a−1 waits. Lower-only request/response caps default to 2 MiB/1 MiB; final response chunks also reject backing >1 MiB before copying. Each full producer backing buffer must be ≤2 MiB before retention or copy, including empty/tiny views and direct ArrayBuffer/view bodies; accepted chunks are copied and released, so live memory is O(M + C) with C ≤2 MiB, independent of chunk history. Known excessive request length rejects before pulling; overflow cancels without another pull. GET/HEAD and keyed POST retry transport/429/5xx; batch POST requires nonempty distinct command keys. Fallback min(1,000×2^(attempt−1),30,000) ms; waits cap at 30s each/60s total and the whole invocation at 120s, all lower-only. An advertised wait beyond budget returns the bounded response without shortening the wait; unrepresentable delays do likewise. Deadline/caller abort interrupts body reads, token, upstream, cancellation and sleep.                                                                                                                                                                                                                                                                                                   | `tests/import-fetch-growth.test.ts`: `real adapter sends two attempts and linear supplied bytes at M = 1, 8, 64`; `body cap counts UTF-8 bytes and stops streaming before reading the remainder`; `repeated 429 is capped, cancels only retried bodies, and returns the actual final response`; `HTTP-date Retry-After uses the injected clock and never shortens advertised waits`. `tests/http-bounds-outcomes.test.ts`: `all bounded HTTP outcomes pass with production fetch`. `tests/request-backing-growth.test.ts`: `fixed visible bytes survive 1/8/64 chunks and five exact adapter attempts at both entrypoints`; `oversized backing stops at the first offending pull, including empty views and later chunks`. |
| Run start, capability, seal and checkpoint controls                                 | `begin`: SELECT source, UPSERT source lease/sequence, INSERT generation; busy: SELECT only. `activeRun`: source/generation join; `source`: SELECT source. `reopen`: SELECT generation + UPDATE lease. `abandon`: SELECT generation + UPDATE generation/source on release. `seal`: SELECT generation + UPDATE ready counters or two release UPDATEs; mass-disappearance adds one source point read, one `run_missing` INSERT...SELECT of M missing identities and one stop-header INSERT before release. Stored supplied/survivor/prior counters avoid aggregate scans. Failure rolls the seal back.                                 | PK source, PK(source,id) generation throughout; ≤3 statements/point rows per control operation (activeRun 1 statement/2 point rows), constant bytes, O(log R), k ≤2; mass-disappearance evidence is O(log N+M) index visits and O(B+M log M) insertion inside the existing seal transaction, constant application buffers, storage O(B+M) for generation lifetime. Every transaction adds 2 controls. The durable per-source run lease and atomic SQLite updates intentionally coordinate workers sharing one state file and its single writer; ImportSession guards live same-source coordinators before capability rotation. Separate imports scale through separate state files or independent sources; importer writes use the API, so platform bounds do not depend on this deployment boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures seal. `tests/run-store-disappearance-review.test.ts` and `tests/disappearance-review-growth.test.ts` measure evidence capture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Review a stopped mass disappearance (`disappearance-review.ts`)                     | Opens an existing regular file read-only with the shared path guard; source and generation point reads; optional stop-header PK; missing-identity keyset page `LIMIT L+1` or one exact missing PK. Releases handles before rendering. No credentials, network, lease, threshold change or import.                                                                                                                                                                                                                                                                                                                                   | Header O(log R) point reads; page O(log M+L) PK visits and O(L) bounded output, L≤101 including continuation probe; exact detail one indexed point read. Stored missing counts, no COUNT scan, OFFSET or current-membership reconstruction. No native requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/disappearance-review-growth.test.ts`: production reader/CLI at 32/128/512 prior identities, fixed missing fraction, unrelated generations, first/middle/final pages and exact detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Run stage one record                                                                | SELECT generation; INSERT OR IGNORE entry; SELECT member; optional survivor UPDATE member; UPDATE generation counters. Duplicate branch instead UPDATEs invalid flag. Stores bounded projection/row JSON and seen-generation marker. The entry PK(source,run_id,record_key) detects duplicate native keys; the invalid flag commits before throwing.                                                                                                                                                                                                                                                                                | Generation/entry/member PK exact seeks; ≤5 statements/point rows (duplicate 3) per record, +2 transaction controls per commit (the coordinator stages up to 100 records per commit; a record failing in the middle keeps the records before it and its invalid mark); k ≤3, O(log R + M) accepted bytes/work, O(M) live serialized state independent of H, no retained source-key array; H unique records occupy O(HM) durable staging bytes already included in R. Descriptor validation enumerates caller object own keys before rejection, so hostile object width is not bounded by the accepted JSON cap. Source-record mode serializes normalizedRecord with a separate hard 1 MiB budget, then adds the fixed sourceKind wrapper; public projection mode remains 64 KiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/run-store-growth.test.ts`: `Run staging stays within its bound as R grows`. `tests/record-caps-growth.test.ts`: `larger sanitized record stage and exact key/page reads stay indexed as unrelated state grows`; `hard projection cap counts serialized record bytes independently of its fixed wrapper`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Run pages and stored projection/observation                                         | `pageStaged`: source/generation capability join + entry range; `pageAcknowledged`: acknowledged range; `pagePending`: generation SELECT + `run_envelope_pending(source,run_id,pending,record_key,envelope_index)` range. `pageVanished`: generation no-op capability UPDATE + `run_missing(source,active,seen,record_key)` composite range with generation and cursor-member PK subqueries. `key`: source, optional baseline entry, acknowledgement, optional generation and staged entry SELECTs; returns persisted row/projection JSON and omissions, without parsing a private command plan.                                     | Staged/pending/vanished: 2 statements, acknowledged: 1; staged ≤r+2 rows, pending ≤r+1, vanished ≤r+3 point/range touches including capability write. Entry/acknowledgement PK and envelope index keysets avoid scans; vanished skips survivors/inactive history through index predicates. `key` ≤5 point SELECTs. O(log R + rM) page work/bytes; key O(log R + M). Projection is persisted JSON, not a platform-wide read; no write except vanished capability check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures pending. `tests/run-store-growth.test.ts`: `Run projection page stays within its bound as R grows`; `Run vanished page stays within its bound as R grows`; `Run key observation stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Run classify, prepare and omission checks                                           | SELECT generation/entry; missing entry: SELECT member, INSERT entry, re-SELECT entry. First classification: SELECT acknowledgement, baseline-entry seek with source-pointer subquery; per command SELECT payload, optional INSERT payload, INSERT command; INSERT each split envelope; UPDATE entry/generation. Omissions: UPDATE entry, SELECT each saved command, optional UPDATE command/envelope, UPDATE remaining. Resolution when eligible: UPDATE entry, UPSERT acknowledgement, UPDATE generation.                                                                                                                          | All PK seeks: entry(source,run_id,key), acknowledgement/member(source,key), payload(source,command_key), command(source,run_id,command_key), source/generation as above. ≤14+7q statements, ≤15+7q point-row touches (baseline subquery adds one), +2 controls; O((1+q) log R + M) bytes/work, q ≤100 for classify or ≤300 for prepare, omissions ≤3, saved keys ≤300; private plans ≤2 MiB split into at most q envelopes, each ≤100 commands/65,536 bytes; replay avoids history scans and rejects changed bytes for a reused key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures one-command classification. `tests/run-store-growth.test.ts`: `Run omission check stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Run acknowledgement and finalize checkpoint                                         | Ack: SELECT generation, per result SELECT command; successful unfinished results UPDATE command/envelope, group by record for UPDATE remaining RETURNING and optional SELECT entry, optional three-statement resolution above. Finalize: SELECT generation, entry PK keyset page, UPSERT member per entry, then UPDATE generation cursor or UPDATE source pointer/count + generation complete.                                                                                                                                                                                                                                      | Ack ≤1+8r point statements/rows +2 controls; O(r log R + rM) work, response envelope ≤65,536 bytes. Finalize ≤r+4 statements, ≤2r+3 row touches, +2 controls; O(r log R + rM), durable cursor, no COUNT. Across pages finalization writes all S+D entries, including unchanged records: O((S+D) log R); each call remains independent of total history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures acknowledgement. `tests/run-store-growth.test.ts`: `Run finalize stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Record get, count, page and upsert (`record-store.ts`)                              | Get SELECT record; count SELECT stored count; page SELECT keyset range. Put: SELECT previous state, UPSERT record, optional UPSERT/increment or UPDATE/decrement count.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Record PK(source,record_key), counts PK(source); get/count 1 statement/≤1 row, page 1/≤r rows; put 2–3 point statements/rows +2 controls, k ≤2. Metadata bytes constant, page O(r) bytes; O(log R + r) reads, O(log R) put, no count scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/sqlite-growth.test.ts`: `actual record store uses indexed keys at three analyzed scales` measures get/count/page. `tests/record-store-growth.test.ts`: `Record upsert stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Binding lookup, candidate page and media projection (`record-bindings.ts`)          | `claim`: SELECT owner; `journal`/`mediaPending`: SELECT owner/key journal; `candidates`: SELECT current owner/group candidate keyset; `mediaIds`: SELECT binding then current cover-key media row. No retired-history enumeration.                                                                                                                                                                                                                                                                                                                                                                                                  | PKs: records(source,external_id); journal/media(source,external_id,key); candidates(source,external_id,field_group,candidate). 1 statement/point row per lookup; page 1 statement/≤r rows; projection ≤2 statements/point rows. O(log B + rM) page bytes/work, projection O(log B + M); r ≤100/group, reserved/current capacity ≤100/group and ≤300/record, M ≤65,536 per snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `tests/bindings-growth.test.ts`: `Binding lookup stays within its bound as B grows`; `Binding candidate page stays within its bound as B grows`; `Media projection stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Binding prepare, acknowledge and taken-down write                                   | Prepare SELECTs binding/journal; create INSERTs binding; propose SELECTs group count, optionally INSERTs group, UPDATEs group/record counts; retract SELECTs candidate; finally INSERT journal. Ack SELECTs binding/journal; create UPDATEs binding; propose SELECTs/INSERTs candidate; retract SELECTs/DELETEs candidate and UPDATEs group/record counts; finally UPDATE acknowledgement. TakenDown: SELECT/UPDATE binding.                                                                                                                                                                                                        | Owner-prefixed PKs above plus groups(source,external_id,field_group), every statement exact keyed. Prepare create/propose/retract ≤4/7/4 statements, ack ≤4/5/7 (replay 2), takenDown 2; same upper bound on point rows, +2 transaction controls each. O(log B + M), constant k ≤4; one command per prepared envelope; no lookup of all journals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/bindings-growth.test.ts`: `Binding write stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Media prepare, accept and observe                                                   | Prepare SELECT binding/media, INSERT media, UPDATE cover_key (replay only two reads). Accept/observe SELECT binding/media then UPDATE receipt/status; accept replay or terminal rejected replay skips UPDATE.                                                                                                                                                                                                                                                                                                                                                                                                                       | Same owner/media PKs: prepare ≤4 point statements/rows, accept/observe ≤3, +2 controls; O(log B + M), constant k ≤2, snapshot M ≤65,536; no SQL polling loop, projection follows current cover_key, not all historical jobs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tests/bindings-growth.test.ts`: `Media write stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Media resolution (`media-resolver.ts`)                                              | Snapshots/validates all supplied assets before effects; SELECTs claim and one cover fence, then sequentially seeks exact media journals, prepares/replays POST bytes and persists receipts/statuses via bindings; returns available URL-to-ID mappings and per-asset outcomes.                                                                                                                                                                                                                                                                                                                                                      | At most 64 distinct assets, each snapshot ≤65,536 bytes, depth ≤32 and ≤65,536 nodes; O(64M) retained input/results, O(64 log B + 64M log M) local work including canonical snapshot key sorting, independent of history. One fence plus ≤1 POST and ≤1 status GET per asset: ≤129 logical calls, one in flight and no inline polling waits. HTTP retries/deadlines apply only when the injected port uses the bounded adapter; arbitrary port latency and repeated resolve invocations have no aggregate deadline. Terminal saved statuses avoid polling; accepted receipts avoid POST replay; no source-baseline write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/media-resolver-outcomes.test.ts`: `all durable cover outcomes pass with production resolver`. A resolver growth check across retained media history is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Checkpointed staging resume (`staging-checkpoint.ts`, `run-store.ts`)               | Opt-in SHA-256 of complete local bytes, then one INSERT prefix row and checkpoint UPDATE per accepted record in the staging transaction; resume PK-seeks ordinal then record key. Seal deletes the checkpoint so it is not an application cursor.                                                                                                                                                                                                                                                                                                                                                                                   | Acquire O(B) hash plus ordinary O(B+N log M) decode/stage. Resume O(B) hash plus O(B) redecode, K PK seeks, convert/insert only N-K. Live memory O(max frame); no O(K) key set. Unrelated sources do not add prefix work. Native transport starts only after seal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Checkpointed VNDB table resume (`vndb-acquisition.ts`, `vndb-tables.ts`)            | Opt-in SHA-256 of the original regular file, then one transaction per accepted COPY/spool/header effect plus cursor. Resume re-hashes, replays ustar from the first member without tar/zstd seek, PK-validates the committed prefix and inserts only remaining rows. Ready captures drop the checkpoint and publish through existing materialization.                                                                                                                                                                                                                                                                               | Verification O(C); replay O(C+B); prefix checks and remaining inserts O(R log M) with spool pages of 32. Live memory one decoder/window, one capped row and existing table page. Native transport starts only after tables are ready. Unrelated acquisitions do not add prefix work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Coordinator acquisition and reconciliation (`importer.ts`)                          | Acquires source ownership, converts/stages the source once to EOF before effects, seals, keyset-pages staged/vanished/pending work, plans current owned candidates, dispatches saved envelopes and finalizes durable pages.                                                                                                                                                                                                                                                                                                                                                                                                         | Acquisition is O(supplied bytes + S log R), with O(M) per-record conversion and separate normalized staging budget; reconciliation/finalization visit S+D records, O((S+D)((1+q) log R + (1+q) log B + M)) including bounded command work. Pages retain O(rM), r ≤100, current candidates ≤300/record; no accumulated source-key set or catalogue/history enumeration. Result arrays default empty with streaming sinks; opt-in key collection caps at 10,000 total. Resume drains durable pending work before newer input; replay preserves stored command bytes and source revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`; `source acquisition is explicitly linear and reaches EOF once before any effect`. `tests/import-session.test.ts`: `uncertain run replays original source and command bodies before changed input is consumed`.                                                                                                                                                                                                                                                                                                                                                  |
| Session ownership and recovery (`import-session.ts`)                                | Same connection supplies RunStore and RecordBindings; acquire SELECTs/upserts import_owners by source in an immediate transaction, checks Linux PID/boot/birth identity, then permits durable capability rotation; release verifies capability and deletes the exact owner.                                                                                                                                                                                                                                                                                                                                                         | PK(source) exact seeks: acquire ≤2 statements plus 2 transaction controls, busy ≤1 plus controls; reopen checks owner then reads active run and rotates its lease, ≤4 statements plus 2 controls; release 2 statements. O(log R) database work with constant identity bytes and no history scan; O(number of held sources) local ownership/close work. Live same-source owners exclude another connection; dead process recovery needs no timeout, while independent sources proceed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`. `tests/import-session.test.ts`: `same-file live owners exclude another connection while independent sources proceed`; `guard release permits capability rotation and fences old RunStore handles`; `dead process owner recovers immediately with birth identity and no lease timeout`.                                                                                                                                                                                                                                                                          |
| Kernel writes and fence reads per record/batch                                      | `Importer` checks three exact tuple fences per planning/dispatch phase, prepares bindings and immutable RunStore envelopes before writes, then validates and persists receipts. Bootstrap sends one create; dispatch sends one saved envelope with fenced groups removed. No accumulated kernel subject/candidate enumeration; default Open Library references use exact local binding point reads.                                                                                                                                                                                                                                 | One batch call per envelope e, e ≤ q ≤300 per prepared record, each ≤100 commands/65,536 bytes; optional bootstrap adds one call. A planning pass reads ≤6 fences (unchanged: 3), dispatch adds 3 per envelope, so ≤7+4q logical calls for planning plus one dispatch pass. Default Open Library planning adds at most 64 indexed local claim reads for supplied relation keys; this also applies to unchanged records before the dependency signature comparison. Coordinator writes multiply each logical call by ≤8 bounded transport invocations, each with ≤A+1 physical sends (A ≤5, including one-time 401 renewal), and O(M) per-send bytes under the adapter caps above. Resume can dispatch pending work before planning and again afterwards; repeated run invocations have no lifetime retry cap. Current owned candidate reads hold ≤300 candidates, ≤100/group, using bounded local keysets; pages hold O(rM), per-record work O((1+q) log R + (1+q) log B + M + 64 log C), where C is indexed local claim count. One compact dependency signature row is retained per acknowledged Open Library record. The coordinator reuses journal bytes/keys, hashes planned identities into source-prefixed keys, and does not batch across records. Arbitrary injected media/identifier providers have no enforced call bound; kernel internal cost is outside these files. | `tests/import-fetch-growth.test.ts`: `network uncertainty preserves exact bytes, URL, method and caller headers`; `only POST with a valid caller Idempotency-Key retries arbitrary writes`. `tests/importer-growth.test.ts`: `client transport sends each supplied bounded batch once as input grows`. `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`; `source acquisition is explicitly linear and reaches EOF once before any effect`.                                                                                                                                                                        |

When deferred cover recovery finds a currently bound candidate whose exact command key belongs to the run's immutable cover proposal, it retains that acknowledged candidate and omits both its retraction and proposal replay. Older candidates remain eligible for replacement; their retractions must still receive successful receipts, unless the cover group has a valid fence omission. This uses the existing bounded per-record candidate pages and adds no journal or database query.

Bound: Run-store and resolver descriptor validation examines O(K) own keys supplied by the caller, the changes side of the O(changes × log stored N) criterion; this work is independent of stored R/B/H and catalogue/history. Direct in-process callers pay for the objects their code builds, so validation does not reject an arbitrarily wide host object in constant time or cap its pre-validation allocation. External source records are guarded at 1 MiB (256 KiB default), parsed API responses at 1 MiB, and public envelopes and binding snapshots at 65,536 bytes. Private record plans remain capped at 2 MiB and are not public envelopes.
The concrete media resolver bounds calls and scheduled waits per invocation, while injected coordinator providers and repeated run invocations have no lifetime API-call bound.

## Native scalar-feed operator evidence

`services/kernel/test/imports/provider-cli-native.test.ts` calls actual `runImportCli` with an account key provisioned
through native Auth stage/approve/apply, native Access/public grants, the existing kernel runtime and its real worker.
The three independently named cases are:

- `Bangumi account-key CLI imports refreshes reopens and safely stops the native scalar feed`
- `Open Library account-key CLI imports refreshes reopens and safely stops the native scalar feed`
- `Wikidata account-key CLI imports refreshes reopens and safely stops the synthetic native scalar feed`

They pin `bangumi@3` (unversioned) and `open-library@3` (edition revision 11 → 12). Wikidata uses the actual
exported converter revision, currently `wikidata-6`, with synthetic Q571 revision 24681012 → 24681013.
Bangumi retains types 1/2/4 and complete skipped membership for 3/6. Open Library
uses five-column TSV, an independent work and the pinned edition with unresolved native author/work keys. Each
case checks actual tuple claims, retrieved cited candidates, immutable bootstrap bytes/keys/receipts, unchanged
new invocations, a supported-value refresh, independent community adoption and preservation of the last completed
baseline with zero public writes after malformed/truncated input and mass disappearance. Owned key/state files
are mode 0600 on tmpfs; each CLI invocation and all fixture resources are closed.

Run the native acceptance through the worker check queue; landing owns regression and root checks:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/provider-cli-native.test.ts
```

### Wikidata released time and quantity

The ordinary JSONL registration uses the exported `wikidata-6` converter. It
admits actual cited complete statements through public Definitions validation,
then native writes recheck the bound holder and its current release. Signed partial
Gregorian/Julian times retain timezone/uncertainty; quantities retain exact lexical
amount, bounds and unit. Unsupported neighbors and incomplete exact measurements
are withheld whole. No importer credentials gain acceptance or adoption authority.

Unchanged reopen retains proposal identity. Converter revision refresh discovers
supported facts on unchanged source input; changed components change the digest.
Unknown delivery reuses sealed bytes and keys. Prior receipts and editorial
selection survive omission and refresh; current authorization and tuple fences
still govern replay and disclosure.

- Touches: one selected JSONL record, its bounded claims, qualifiers and selected
  references, local staging/journal point reads and ordinary native batch calls.
- Bound: 128 KiB record, 64 statements, 100 commands, 15 source references per
  claim and 16 snaks per group; local conversion is O(selected bytes). Native
  calls retain existing batch, binding, receipt and fence bounds separately.
- Growth check: existing converter/importer/native growth suites remain authoritative;
  unrelated source and native population grows independently. Focused scenarios
  `tests/wikidata-lossless-source-completion.test.ts` and
  `../kernel/test/imports/wikidata-lossless-source-completion.test.ts` exercise
  serialization, independent accept/adopt/read, refresh, lost responses and fences.
  Authored native coverage is not an executed acceptance or upstream observation.

Caller corrections retain exact values and public contracts: the edition type expectation changed from
`schema:BookEdition` to the existing native observation `bf:Instance`; native URL/sameAs property expectations
changed from command-input `{ id }` to public `SnakSchema`'s `{ id, data_type: 'url' }`. Candidate selection uses
strict structural equality instead of JSON member order. Safe acquisition stops require zero Auth requests,
matching lazy token renewal on the first public request. Converter observations use exact repository paths.
The feed fixtures omit cover acquisition, retaining separate
Bangumi CC-BY-SA summary rights and the omission of unknown-licensed Open Library prose. This proves the scalar
operator entrypoint only; it does not add general SourceRecord metadata, words, form/classification, VNDB archive
or statistics, or the deferred cross-surface discovery matrix.

The separate [Bangumi summary and cover CLI caller](../kernel/test/imports/bangumi-cli-media-fixture.ts)
connects the account-key entrypoint to the real media reservation/status API, registered jobs, editor selection,
refreshed pixels and exact cover tuple takedown. Its [verification notes](../../docs/research/imports-audit/bangumi-cli-media.md)
record the frozen original-byte assertion conflict and distinguish privately retained originals from reencoded
public variants. A native pass is not claimed for that assertion.

## Exact CLI acknowledgement interruption

The [native account-key journey](../kernel/test/imports/cli-ack-recovery.test.ts) runs Bangumi and Open Library in
one ordinary Auth/Access/public API world. It captures a committed bulk response and its native receipts, aborts
before local acknowledgement, closes the CLI and reopens the same private SQLite/key paths. The new invocation
drains the sealed generation with its original bytes and keys before a later invocation admits the supplied
successor input. An independent community selection, immutable bootstrap/proposal/media journals and original
native media objects survive. Revoking the Global grant denies replay with the exact old bearer without revealing
stored success. See the [evidence and limits](../../docs/research/imports-audit/cli-ack-recovery.md).

Run this focused native outcome through the managed check queue:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-ack-recovery.test.ts
```

This connected outcome adds no PG growth series; missing growth evidence is recorded as missing. Existing
source, journal, media and transport limits and counted growth evidence retain their original scope.

## Native file acquisition admission

The [file journey](../kernel/test/imports/cli-file-admission.test.ts) runs ordinary
`--dump <path>` acquisition for all four sources through real account-key Auth,
Access and public writes, including the registered media worker. Each source
completes an import, rejects malformed replacements without Auth/public effects
or changes to the completed baseline and immutable receipts, then accepts a valid
successor on the same SQLite state. VNDB reads ustar through `readArchive` rather
than injected entries. Invalid archive staging exits 2, matching scalar input
admission; interruption still exits 130. Files and SQLite close on either path.
The [evidence notes](../../docs/research/imports-audit/cli-file-admission.md) describe
captured anchors and limits. This caller adds no growth measurement or input cap.

## Rejected cover and valid successor through the CLI

Keep the same source and SQLite state after a corrupt cover is rejected. Metadata import can complete while
the rejected cover remains explicitly terminal in the media journal and native status. The importer supplies
no converter media mapping for that object and publishes no cover attachment. Reopening the same input does
not submit another media job or fetch that URL again, even if the provider has replaced its bytes. A changed
source cover URL creates a distinct request and media object; only actual availability permits a cover proposal.
An editor still accepts and selects that proposal through the ordinary API. Cover credit remains
`LicenseRef-unknown`, independently of the provider's metadata rights.

The [frozen native outcome](../kernel/test/imports/cli-rejected-cover-recovery.test.ts) now has a connected
account-key caller for two independent records, Bangumi JSONL and an Open Library edition TSV, in one native
Auth/Access/worker world. It observes corrupt-image rejection, same-state reopen, a genuinely changed source,
private original equality, encoded AVIF/WebP variants, public selected media and download decisions, immutable
old journals/receipts, and an independent contributor's adopted title. Managed acceptance passed at
`94e003a486ee861a4d5a71083cda671f786bb7b9`: one native case, two provider children, six successful CLI
invocations and 820 assertions. See the [evidence record and limits](../../docs/research/imports-audit/cli-rejected-cover-recovery.md)
for the raw log, actual source/converter/bundle revisions and receipt anchors. This is scoped native evidence;
integration, promotion and the broader consumer matrix remain open.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-rejected-cover-recovery.test.ts
```

## Concurrent ordinary CLI operators

Use the same `--state` path for independent configured `--source-alias` feeds. A live CLI owns its exact alias
while acquiring input, including while stdin waits before EOF. Another CLI for that alias exits 5 before Auth
or public writes; a different alias can seal and publish in the same SQLite file. Cancel the owner through
SIGINT and reopen with the same state and complete source input. Source claims, own-reference resolution,
receipts and tuple fences remain confined to their configured alias even when native provider keys coincide.

The frozen [concurrent native journey](../kernel/test/imports/concurrent-cli-owners.test.ts) binds actual concurrent
`runImportCli` calls to one native Auth/Access/application/worker world. Its [evidence description](../../docs/research/imports-audit/concurrent-cli-owners.md)
covers held acquisition, same-alias refusal, independent publication, cancellation/reopening, immutable prior
identities/receipts, and exact-tuple fence visibility. The importer-local companion proves only pre-effect
ownership and cleanup. Native execution and growth evidence are separate; this caller introduces no growth series.

During incomplete acquisition, interruption requests upstream iterator cleanup once and releases the actual
source guard even if that cleanup never settles or is queued behind a stalled read. Late read/cleanup rejection
is observed. The CLI reports exit 130 after closing its owned handles, so a same-state rerun can acquire the
source normally. Incomplete input cannot seal a successful or empty dump, advance the prior completed baseline,
or start Auth/public effects. Ordinary EOF and parser-error cleanup retain their existing behavior; cancellation
can interrupt a pending source cleanup. Owned file reads and already-dispatched writes settle before SQLite
and descriptor closure. This boundary does not detach ingestion or change post-dispatch authorization cleanup.
The frozen [CLI child](tests/cli-upstream-cancellation.test.ts) proves the nonsettling-return acquisition case;
its timeout only bounds a failing test, and establishes no performance or native-stack claim.

## VNDB durable table materialization

`VndbMaterialization` stages a complete VNDB table generation, then publishes
through `Importer.runRecords` in pages of at most 16. The acquisition is bound
before the first public write; `baseline(key)` reads only the completed RunStore
row and that link. A page ACK does not advance the complete pointer until every
required member and native effect is durable. Failed, corrupt, missing,
changed-pending or mass-loss input cannot replace that baseline. Unchanged
publication keeps the original acquisition; interrupted sealed work resumes it
even when a later invocation supplies a different archive.

Decision: grouped VN records keep converter-allowlisted `vn.alias` with the
licensed statistic pair. The fourteen-case oracle asserts that field. Caps stay
64 alias lines, 162 commands.

### Publish a completed VNDB table generation

- Touches: one ready table acquisition, its RunStore generation, licensed
  observation and immutable ACKs through the existing archive operator.
- Bound: O(file bytes) to stage; pages of 16; one generation and acquisition
  link; no second baseline.
- Growth check: local SQLite row, statement and EQP evidence on the fourteen
  table outcomes.

Native acceptance binds those fourteen outcomes and the account-key CLI
publication/reopen/late-invalid journey.
See [the materialization evidence](../../docs/research/imports-audit/vndb-materialization-native.md).

## VNDB and Wikidata sealed CLI recovery

The [connected operator journey](../kernel/test/imports/cli-sealed-source-resume.test.ts) captures a committed
response lost before local ACK, closes all CLI handles and reopens the same private state/key paths. VNDB
validates every supplied archive before recovery: malformed replacement input rejects with status 2 and no Auth
or public effects; valid replacement input permits the original sealed generation to drain with its original
acquisition and native revisions. Wikidata drains sealed work without reading replacement stdin; the same
malformed stream is admitted and rejected only on the next fresh invocation. A later valid invocation publishes
the successor for each source, preserving subject identity, original receipts and independent Context selection.
VNDB retains its seventh statistic scope and exact statistic receipt identity.

The managed native acceptance passed at `fc2509fd177143bafb3a4f598bb0db43c55337a8`: one frozen test, two source
children and 1,686 assertions. The [receipt and limits](../../docs/research/imports-audit/cli-sealed-source-resume.md)
record exact log, source revision/digest and original receipt anchors; promotion remains separate. Source bytes are the pinned
VNDB COPY/header files in real ustar and Wikidata `Q571` in streamed JSON-array framing. This connected outcome
adds no growth series and does not close general source metadata or discovery work.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-sealed-source-resume.test.ts
```

## Mid-run bulk authority loss

The ordinary CLI retains its completed baseline and original sealed generation when native bulk authority is
revoked between writes. It exits 4 after authorization denial and closes its handles. Restore the existing grant
and reopen the same state to drain pending prepared bytes and keys; a distinct supplied successor is acquired on
the following invocation. Earlier authorized transactions remain committed. Receipt replay checks current Access
before revealing stored success, including replay with the original bearer.

The frozen [native journey](../kernel/test/imports/cli-midrun-authority-resume.test.ts) binds seventeen changed
Bangumi records after a metadata-only baseline, real account-key Auth, native Access/public writes, the media worker
and an independent community selection. It schedules actual outgoing requests before forwarding to Access and
retains exact native denial bodies. See [scenario, evidence and limits](../../docs/research/imports-audit/cli-midrun-authority-resume.md).
The corrected managed native run passed one test and 4,330 assertions at
`72f22215978b429a77e33a34e0dd7e75d909d787`, with no TypeScript diagnostics. The evidence notes retain its raw
receipt and the earlier fixture typing correction. This proves the connected journey; main promotion and native
growth evidence remain separate.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-midrun-authority-resume.test.ts
```

This connected outcome reuses existing input, envelope and retry bounds and adds no growth series. Original native
receipts, bootstrap/proposal/media journals and acquired objects remain independently observed recovery anchors.

## Explicit reviewed vocabulary and Bangumi lookup

`seedReviewedCatalogue({path, port, seeds?, signal?})` in
[`reviewed-catalogue.ts`](src/reviewed-catalogue.ts) is the one trusted operator
producer. Its finite authored input is the four records in Definitions'
`reviewed-vocabulary.json`, including the already-reviewed Bangumi Episode type
scheme and its seven Concepts. Scheme self records use the empty literal member;
the canonical member is the exact reviewed QID. These authored keys identify
seed owners, never provider records or derived UUIDs. Native create-or-resolve
receipts supply every subject/candidate ID.

Run deliberately with an already authorized ordinary operator account:

```sh
bun services/importer/src/reviewed-catalogue-cli.ts \
  --state .temp/reviewed.sqlite --api https://api.example.org \
  --auth https://auth.example.org --account-key .temp/operator.jwk \
  --account <account-uuid> --client <registered-client-id>
```

The account needs genuine current Global trusted batch, create/propose and
editorial acceptance/adoption authority and matching OAuth scopes. The tool
grants nothing. `task seed:dev` invokes this same publisher as an explicit local
showcase step, using its separate persistent journal and passing returned native
subject IDs directly to the Episode adapter. Ordinary provider imports never
invoke it. Use the same state file for subsequent ordinary Bangumi imports; the
platform seed namespace stays separate from provider namespaces. No
SourceRegistration option or parallel registry exists.

Before effects, the entire exact inventory passes descriptor-safe preflight and
the existing RunStore acquisition/seal policy. The unchanged RecordBindings
journal retains original native claim/proposal bytes and ACKs. Every owner's
real Source metadata CAS ACK precedes its bootstrap, including response-loss
recovery. The sealed inventory deterministically reproduces the same metadata
bytes/key before a claim exists; after binding, the existing metadata journal
retains the genuine receipt. Changed sealed input or unrelated editorial heads
are refused. Acceptance and adoption use freshly read native heads and genuine
returned receipts, with current authority required on replay.

Seed alias is exactly `rezics_reviewed_vocabulary`. External IDs are `v1:` plus
unpadded base64url UTF-8 canonical JSON of `[schemeURI, exactLiteral]`, without
normalization or identity hashing. The raw ConversionContext key remains UTF-8
JSON, not base64url. Both actual external ID and complete public command key are
checked before effects. The pinned member produces 82 ASCII external-ID bytes
and a 174-byte complete key with the existing 64-hex command suffix; oversize
identities are rejected, never shortened. Existing provider aliases/QID keys stay
unchanged. Reviewed licence metadata covers only its explicitly attributed
projection; authored scheme metadata deliberately has no inferred licence.

`createReviewedCatalogueLookup(bindings, port)` implements the existing
`ImportIdentifierLookup`; the ordinary Bangumi CLI installs it by default. It
reads four current original subjects, their fact fences and six bounded native
candidate slots (limit 100 each), checks scheme membership, exact external
identity, distinct canonical correspondence, accepted selected unretracted
provenance and current disclosed graph. Redirects, hidden/retracted/unselected
subjects or candidates, foreign repair, Access refusal, missing seeds and
unavailable native reads produce no mapping. A local journal ID is only a read
anchor. Retained Context adoption alone is insufficient after retraction.

Lookup makes four fence reads, four subject reads and six candidate-list reads
for the fixed reviewed inventory; no label search, population scan or extra
source probe occurs. Pure conversion bounds are twelve projected fields,
64 public metadata tags of 200 characters, six commands and the existing 64 KiB
projection guard. The native producer/consumer cases and geometric 64/512/4096
lookup case are authored in Kernel's existing native fixture. Native outcomes
remain integration proof; this source delivery permits local typing only.

## Registered source vocabulary mapping

Bangumi and VNDB registrations append bounded proposals from the shared pure
vocabulary mappers when a trusted conversion caller provides normalized graph
rows and released bindings in `ConversionContext.sourceVocabulary`. The graph
owner supplies row traversal and resolved identities; the importer registration
does not search for endpoints, create subjects or resolve labels. Mapping output
uses the existing source alias, revision, digest, licence attribution and
ordinary batch-write path. Mapping-specific command-key revisions prevent a
sealed command from being replayed with changed statement bytes.

Decision: Bangumi PersonDetail rows on the explicit `bangumi_cross_media`
ordinary CLI use five TSV columns (`/type/person`, `person:<id>`,
`unversioned`, ETag-or-empty, exact JSON body); ETag and HTTP cache headers never
become wiki revisions, and other Bangumi CLI input remains JSONL.

That framing admits only a type-1 Person body whose ID matches the requested
`person:<id>`. The optional ETag is bounded cache metadata and does not enter
source revision; the exact response body is bounded before parsing. The ordinary
importer proposes cited original and Chinese `schema:name` statements only.

The selected-family VNDB staff-credit coordinator supplies genuine `vn_staff`
and `vn_seiyuu` rows to the same mapper after resolving same-owner alias IDs to
their actual Person UUIDs and retaining exact Character UUIDs. Local review
publishes selected credit-type and blood-type requirements through the existing
showcase journal and publisher. Native and public current reads must agree on Concept
type, URI and scheme membership before a qualified assertion is built; missing
or unsupported cases remain omissions without an unqualified graph fallback.

Exact unresolved values and descriptor admission failures are returned both as
`sourceVocabularyGaps` and structured conversion diagnostics, including provider,
source path, code or endpoint, required profile and property where applicable.
VNDB release supersession uses the released `rezics:releaseSupersedes` binding for
the exact outgoing COPY row `releases_supersedes.id -> rid`, after bounded selected
endpoint acquisition and current native Release descriptor checks. Both release
identities and field citations remain in the graph proposal evidence; chronology,
organization replacement, reverse rows and missing rows do not imply supersession.
Unknown native sends retain their sealed command and key for retry. Proposal
acknowledgement does not establish independent public selection or publication.
Decision: follow only authored outgoing `id -> rid` rows reachable from release
memberships of the finite selected work family; do not infer inverse or date/title
replacement edges.
The production release-fidelity operator now supplies `release-date`, `development-status` and `release-work` rows
from authored COPY `releases.released`, `vn.devstatus` and `releases_vn.rtype`.
The default selected-family seed uses the same coordinator through
[`showcase-vndb-releases.ts`](src/showcase-vndb-releases.ts): it collects facts
only for already selected works and releases, maps needed development-status
codes onto current reviewed-catalogue subject IDs, rereads exact URI/type/inScheme,
and composes those bindings with any sibling adapter without overwriting prior
rows. Optional `--vndb-release-state-bindings` is a UUID hint file validated
against that same current read; it is not required for `task seed:dev`. The
ordinary CLI runs that adapter, then the existing public-tag importer and the
common showcase publisher, and writes release facts, publicTags and publication
results into the seed result. Work and release proposal acknowledgements stay on
the existing manifest. TBA, unknown and absent release dates remain distinct
outcomes; date precision is never guessed. Completeness
stays a `wdt:P31` qualifier gap on the release-to-work fact. These proposals do
not contain VNDB votes, personal lists or score-derived facts. Decision: COPY
integer YYYYMMDD maps 0/00000000 to unknown, 99999999 to TBA and 00/99 omitted
components to year or month precision. Decision: default `schema:exampleOfWork`
stays on the existing graph edge; the mapper records the completeness gap without
a second association. TBA/unknown stay mapper `property_not_admitted` on
`schema:keywords` because the current Release profile omits that property and the
reviewed inventory has no released-state Concepts; a current development-status
binding publishes work keywords. Decision: do not remap TBA/unknown onto
`schema:creativeWorkStatus`. Decision: default seed rereads reviewed-catalogue
development-status identities rather than inventing a second state publisher.

The default selected-family path also reads `releases_platforms` and
`releases_media` only for admitted release IDs. It prepares stable source-scheme
and source-code Concept dependencies in the same journal, submits their source
evidence to the existing manifest/publisher, and rereads current native type,
URI and `skos:inScheme` before the release mapper admits each independent
association. Duplicate source rows collapse; unsupported, conflicting, overflow
or withdrawn dependencies remain bounded omissions. The release projection
includes exact admitted associations so a changed dump refreshes through the
existing converter digest. Decision: selected release platform and medium
Concepts use stable VNDB code URIs and exact source codes as English labels;
association admission requires current native type, URI and `inScheme` readback.

Selected-family `chars` rows already reach `convertCrossMediaEntity`. Revision
`cross-media-entities@4` publishes admitted height and weight from those COPY
cells as exact native quantities with source units and citations. Appearance
selection still owns identity; measurement cells never authorize acceptance.
The dump COPY header is the public `chars` columns; height unknown is `0` and
weight unknown is `\N`. Exact `0` is never a measured zero. Those cells enter
the entity digest, so a mapping that newly admits them refreshes without a
revision bump.
Decision: dump-unknown height is COPY `0`; dump-unknown weight is COPY `\N`;
exact `0` is never a measured zero.

selected release payload and convert them through `cross-media-entities@15`.
Authored COPY headers are `id`, `lang`, `mtl`, `title`, `latin`. Bound names keep
their source language; Romanized `latin` is `schema:alternateName`. Exact-empty
latin on this table is unadmitted. Date/status/completeness remain independently
owned. Decision: label order is language then text; `mtl` never ranks names.

The production release-language operator
[`vndb-release-language.ts`](src/vndb-release-language.ts) reuses the selected-family
planner and `convertCrossMediaEntity`. `releases.olang` is a cited literal, not a
Concept binding. Title language never supplies the whole-release fact. COPY `\\N`
and codes outside the inventory language enumeration withhold only that statement.
Decision: a later absent or unsupported `olang` does not retract an independently adopted language.

Those callers also keep the COPY `releases.gtin` cell. Admitted 8 or 12–14 digit
strings become one cited `schema:gtin` fact on the same Release; dump unknown
`0`, null, malformed, unsupported-length and unsafe JavaScript numbers withhold
only that field. Decision: COPY bigint decimal spelling is preserved; `0` is
unknown; leading zeros are not invented; barcode equality does not merge
subjects.
The release-fidelity operator also reads `releases_platforms` and
`releases_media` for its selected release keys. Converter `@7` includes these
child associations in the sanitized digest, so unchanged source bytes can gain
their proposals through deliberate refresh. It proposes every supported,
reviewed current platform Concept on `schema:gamePlatform` and medium Concept on
`wdt:P437` on the same Release. Duplicate associations collapse, unknown or
unbound codes retain bounded gaps, and `qty` is ignored. The source-specific
schemes are described in the conversion contract.

- Touches: selected release keys, the two extracted COPY child tables, at most
  64 schemes/512 Concepts through cached current reads, and ordinary cited
  Release proposals.
- Bound: 4,096 selected child rows across both tables, at most 64
  source-vocabulary rows per Release after date/work rows, and 64 planner gaps.
  The existing batch and tuple-home fence paths remain in use.
- Growth check: the focused importer test covers multiple values, duplicate
  rows, an unsupported code and refresh. The connected native test covers
  independent acceptance/adoption, current disclosures, unavailable bindings
  and a facts fence; this attempt defers its execution to integration.

The production VNDB public-tag operator
[`vndb-public-tags.ts`](src/vndb-public-tags.ts) traverses extracted `tags` and
`tags_vn` COPY tables through the inventoried columns in
[`vndb-tables.ts`](src/vndb-tables.ts), binds currently accepted/adopted
category schemes and source Concepts, and supplies those rows to the existing
vocabulary admission seam. Positive integer votes 1–3 with `ignore=f`, `lie=f`
and applicable dictionary tags publish exact `schema:genre` facts and spoiler
qualifiers. Lie flags, non-positive or non-integer votes, ignore flags,
unresolved codes and duplicate `(vid,tag)` rows stay review gaps. User ids,
notes and vote values never appear in diagnostics. Native classification
ballots are not written.

The default real-dump seed also runs
[`showcase-books.ts`](src/showcase-books.ts) after the selected-family import.
It retains Book Girl and adds Kara no Kyoukai from the pinned archive stated
above. It follows only bounded 1002/1003 novel membership and the selected
series-to-movie code-1 relation. `subject-persons` role 2001 maps to
`schema:author`, 2002/2003 to `schema:illustrator`, and 2004 to
`schema:publisher` only when the actual endpoint is an Organization. The
existing creator-credit helper keeps the exact role Concept qualification and
rereads current source URI, type and `skos:inScheme`. Unknown or ambiguous
volume order stays unqualified; absent creator, publisher or relation evidence
remains a gap. The ordinary broad CLI retains the same two reviewed book
families.
`task seed:dev` elects its directly selected Bangumi Official Book root as part
of the five-work showcase. Decision: type 1 Book/BookSeries dispatch uses the
current `bangumi@14` converter, preserving Book names, TVAnime original-run
and Game player-count while adding TVAnime work evidence. Decision: one Bangumi subject stays one
identity, so ISBN on a volume does not create a `bf:Instance`. Decision:
selected Book Girl and Kara no Kyoukai records join the common showcase manifest; book review
gaps stay in the seed books section so they do not fail Steins;Gate
publication. Author-credit gaps stay in that same books section. Decision:
Book creator selection admits source type-1 people for author/illustrator
roles and source type-2 Organizations for publisher role 2004. Unsupported
roles remain explicit omissions.

The real-dump seed acquires `tags`, `tags_parents` and `tags_vn` from the same
checksum-verified current VNDB archive. The ordinary broad CLI runs
[`showcase-tags.ts`](src/showcase-tags.ts) after the selected-family import;
the bounded `task seed:dev` path composes its two reviewed content-tag concepts
with elected works in the single reconciliation run. Association projection
keeps at most one admitted row per selected work/tag before the cap, so voter
duplicates cannot starve a later work. The broad adapter closes tag parents
inside its dictionary cap and feeds the existing public-tag coordinator.
Optional `--vndb-public-tag-bindings` remains an explicit UUID override;
adopted usable bindings are those the current public read actually discloses.
Publication consumes finite vocabulary records and exact source URIs without
inventing another publisher. Concept labels preserve the exact `tags.name`
spelling under `und` when COPY has no language; Han-only, kana and Latin names
are not assigned a guessed locale. Sealed Concept identities and command bytes
stay unrepaired; later name proposals are separate reviewed commands.
Decision: only a current Kana `/vn` response for the selected work and its
currently admitted tag binding supplies `rezics:sourceTagWeight`; COPY
`tags_vn.vote` remains an association filter, and unavailable ratings withhold
only weights while valid association and spoiler facts remain eligible.
Pending or unknown publication reuses the original sealed response and command
identities until independent current public reading completes publication.
A terminal refresh appends a distinct receipt without rewriting prior commands.
Current facts fences prevent both weight adoption and replacement of its prior
selection, preserving unrelated editorial candidates. Reopening an acknowledged
nonempty plan does not relabel it as an empty statistics refresh.

### Bangumi TVAnime bounded profile conversion

`bangumi@14` includes TVAnime names, original-run, work evidence and official
websites. Ordinary and selected-family registration share bounded conversion;
selected envelopes use `cross-media-entities@15+bangumi@15`. The existing journal
preserves exact alias/key, source admission, citations, independent
review/adoption and current reads. Unversioned rows retain the bounded infobox
digest; no publisher or identity lookup is added.

- Touches: one selected TVAnime record, at most 24 name facts, 32 website facts,
  existing original-run/work-evidence facts and 16 bounded diagnostics. Every
  projected fact cites the exact Bangumi subject record.
- Bound: 65,536 projected characters, 64 infobox fields, 1,500 characters per
  URL and the existing 100-command batch ceiling; source values stay out of
  diagnostics.
- Growth check: `services/importer/tests/bangumi-official-websites.test.ts`
  covers ordinary and selected-family proposals, identity reuse, refresh and a
  bounded unsupported value. The related public-read journey is
  `services/kernel/test/imports/bangumi-official-websites.test.ts`; native
  execution remains controller-owned.

### Bangumi Book-template subject names

Ordinary Bangumi registration and the selected-family importer share one pure
extractor for Book title fields. It requires the selected native profile
`schema:Book` and the exact pinned `{{Infobox animanga/Book` header. The
source-defined `Novel`, `Manga`, `PhotoBook` and `BookSeries` templates do not
inherit this mapping. Both Book `中文名` and `别名` become additional
`schema:name` candidates; explicit Chinese names use `zh`, and unqualified
aliases use `und`. A malformed field is withheld as a whole while independent
source names and summary proposals remain available.

The ordinary importer remains proposal-only. The default selected-family path
uses its existing `cross-media-entities@15+bangumi@15` registration, record bindings,
finite showcase manifest and publication journal. Local review accepts and
adopts current candidates through separate native commands; corrected source
names create new proposals on the acknowledged Book UUID, and ordinary refresh
does not rewrite adopted names. Record citations, the unversioned marker,
source digest and field-pointer command identity remain attached.

- Touches: one selected Book record, at most 24 distinct name values and 16
  shared omission diagnostics.
- Bound: the 65,536-byte projection/infobox caps, 64 visited field occurrences,
  existing source journal and native batch limits; no catalogue scan is added.
- Growth check: `services/importer/tests/bangumi-book-names.test.ts` covers
  ordinary/default conversion, atomic malformed-field handling, same-UUID
  refresh and same-title source identity separation. The native publication and
  public-read scenario is `services/kernel/test/imports/bangumi-book-names.test.ts`;
  its execution remains controller-owned.

### Bangumi television original run

Ordinary Bangumi JSON-lines registration converts pinned TVAnime infobox
`放送开始`, `播放结束` and `话数` on type 2 through current `bangumi@14`,
retaining the original-run mapping alongside newer TVAnime evidence. Selected-family seed uses that same converter; this
journey adds no publisher. Native read is the acknowledged TVSeries. Weekday
schedule text, custom keys and OVA/Movie templates remain diagnostics. An end
date is not completion or access authority.

- Touches: one ordinary or selected type-2 TVAnime record, at most three
  original-run facts, and the existing Bangumi citation on that TVSeries.
- Bound: the existing 65,536-character infobox cap, 64 parsed field occurrences,
  and the current source journal and batch limits; raw source values never enter
  diagnostics.
- Growth check: `services/importer/tests/bangumi-television-run.test.ts` covers
  JSON-lines proposals, unknown totals, schedule/custom omissions, converter
  refresh and changed totals with stable identity. The connected ordinary caller
  is `services/kernel/test/imports/bangumi-television-run.test.ts`; native
  execution remains controller-owned.

### Bangumi Game player count

Ordinary Bangumi JSON-lines registration converts pinned Game infobox
`游玩人数` on type 4 through current `bangumi@14`, retaining original-run and
work-evidence mappings. Selected-family seed uses that same converter under its
existing combined `cross-media-entities@15+bangumi@15` registration; this journey adds no
publisher. Native read is the acknowledged VideoGame. A mode, platform, edition
or condition qualification withholds the whole occurrence. Names, dates,
platforms, developer/voice credits and websites retain their owners.
Decision: Game-template `游玩人数` admits only an entire-field unqualified
positive integer or inclusive range; a lone count invents no minimum.

- Touches: one ordinary or selected type-4 Game record, at most one
  `schema:numberOfPlayers` statement with at most one `schema:minValue`
  qualifier, and the existing Bangumi citation on that VideoGame.
- Bound: the existing 65,536-character infobox cap, 64 parsed field
  occurrences, 8 examined count occurrences, 16 diagnostics, and the current
  source journal and batch limits; raw source values never enter diagnostics.
- Growth check: `services/importer/tests/bangumi-game-player-count.test.ts`
  covers ordinary and selected-family proposals, a mode-qualified omission,
  converter refresh and a malformed-to-corrected same UUID. The connected
  selected-family caller is
  `services/kernel/test/imports/bangumi-game-player-count.test.ts`; native
  execution remains controller-owned.

### Bangumi Game platforms and software engine

Ordinary Bangumi JSON-lines registration converts pinned Game infobox `平台`
and `游戏引擎` on type 4 through `bangumi@14`, preserving Game names, player-count,
Book grain and TVAnime work-evidence mapping. Selected-family type
4 rows use that same converter.
Current reviewed Concept reads supply the only native targets; a configuration
UUID or identical label is a lookup hint. Concealed or wrong-source bindings
withhold that occurrence and keep the VideoGame identity and sealed retry
candidates. Top-level `platform` remains the profile selector. Engine version,
platform or edition text is withheld because `wdt:P408` admits no qualifiers.
No second vocabulary publisher or taxonomy release is introduced.
Decision: Game environment admission stays on the combined `bangumi@14` revision; book
grain stays on that combined revision. No infobox-field scheme URI is minted
from `平台` or `游戏引擎`.

- Touches: one ordinary or selected type-4 Game record, at most 16 platform
  and 8 engine Concept relations, exact infobox field citations, and
  independent accept/adopt/read of those properties.
- Bound: 65,536 infobox bytes, 64 fields, depth 2, 16 diagnostics, 24 cached
  current Concept reads, the 64 KiB command envelope and existing journal
  limits. No catalogue label scan.
- Growth check: `services/importer/tests/bangumi-game-environment.test.ts`
  covers selected-family planning, ordinary registration, citations and
  concealed/wrong-source withholding. The connected ordinary caller is
  `services/kernel/test/imports/bangumi-game-environment.test.ts`; native
  execution remains controller-owned.

### Bangumi Game source genres

Decision: one complete scalar `游戏类型` occurrence remains one exact literal;
compound values are not split, and nested or continued fields are withheld.

Ordinary Bangumi registration and the selected-family default seed share the
`bangumi@14` adapter. Only the exact type-4 Game template field can propose
`schema:genre` on its `schema:VideoGame`, using a finite literal-to-Concept
profile and the pinned source scheme
`https://rezics.com/schemes/bangumi/genres`. Profile UUIDs are lookup hints:
each used Scheme and Concept is reread publicly for its type, exact source URI,
and current `skos:inScheme` relation. The source mapping grants no mutation
authority, canonical taxonomy equivalence, or inferred disclosure. Public tags,
title, and platform never supply this field.

The ordinary `--bangumi-game-genre-bindings-file` option only resolves current
references for proposal conversion. Explicit local showcase configuration uses
`REZICS_DEV_BANGUMI_GAME_GENRE_BINDINGS` through the existing dev seed flow; the
common journal separately accepts, adopts, and reads each exact cited Concept
relation on the acknowledged Game. A transient read failure emits no new genre
candidate and preserves only the exact prior candidate for recovery. Corrected
source or bindings reuse the Game UUID; absent later facts do not retract
independently adopted editor facts.

- Touches: one selected Game, up to 16 exact genre occurrences, and the existing
  publication, review/adoption, and current public-read path.
- Bound: 65,536 projected characters, 64 shared infobox fields, depth 2, 16
  genre occurrences, 16 sanitized omissions, 200 characters and 1,024 UTF-8
  bytes per literal, the current-read cache, and the 64 KiB command envelope.
- Growth check: `services/importer/tests/bangumi-game-source-genres.test.ts`
  covers exact extraction and current binding states; the selected-family
  lifecycle is `services/kernel/test/imports/bangumi-game-source-genres.test.ts`.
  The fixtures are authored examples, not observed source rows.

### Bangumi creator and voice credits

The real local showcase seed derives finite staff roles from selected type-2
anime and type-4 Game `subject-persons` rows. It uses the reviewed mappings in
`bangumi-vocabulary.ts`, creates source Concepts only through acknowledged
ordinary import commands, and sends them through the common showcase manifest,
independent acceptance/adoption and tokenless current reads. Game creators must
resolve through their Bangumi person key to the current Person or Organization
profile and exact identity statement. Game `subject-characters` and
`person-characters` keep the delivered Game-character selection and tuple fences. Exact
UUIDs carry through the mapper; names and cross-provider title matches never
resolve endpoints.

Decision: local showcase creator-credit reads retain Bangumi subject types 2 and 4, matching the selected anime and Game credit contract.

Decision: staff-role Concepts cite the pinned Bangumi `subject_staffs.yml`
definition; each staff or voice credit cites its selected Bangumi work row.
Vocabulary source IDs use `vocabulary:bangumi.staff[:code]` so their native
subjects stay distinct from the selected work ID while the manifest keeps that
work as the evidence owner.
The common publisher accepts only the exact Bangumi staff-position or
performer-character row fragment under that selected work URL for these
credit facts.

Archive staff `position` remains a role code and is never copied into
`schema:position`. A credited spelling is preserved only when a supporting
association supplies it; `person-characters.summary` remains commentary and
does not become `wdt:P1932`. Voice credits keep the bound character on
`wdt:P453` for that performer and work. Music and live-action staff, unprofiled
type-3/type-6 roles, and stale or wrong-scheme role bindings remain exact gaps.
The default Book adapter derives type-1 author role 2001 through this helper;
the Game adapter derives type-4 staff roles through the same helper. Book
selection, grain and membership stay with the Book adapter. Ordinary imports
without explicit showcase state remain proposal-only.

- Touches: at most 64 staff and 64 voice association rows per Bangumi work;
  selected type-2 anime and type-4 Game staff use the finite staff inventory,
  while Game appearance and performer associations keep their existing selection
  fences. At most 64 distinct staff-role
  requirements are derived per bounded operation.
- Bound: each selected role is checked against its exact common-manifest
  create/candidate acknowledgements, pinned vocabulary citation, current
  native type, current `schema:sameAs`, and `skos:inScheme`. Credit citations
  must be the exact staff-position or performer-character row under the
  selected work URL. Game creator endpoint types come from the admitted
  `person.type` mapping; unsupported source types and unresolved endpoints
  withhold only their associations. Work/person reads are operation-local and
  invalidated after publication. Role requirements beyond the 64-role bound
  remain visible as `missing_concept` gaps. No catalogue-wide label scan or
  generic import auto-publication is added.
- Growth check: `services/importer/tests/showcase-bangumi-credits.test.ts`
  retains the type-2 anime staff/cast case. The new
  `services/importer/tests/showcase-bangumi-game-creators.test.ts` follows
  selected Game staff through planning and excludes Game character/voice rows.
  `services/kernel/test/imports/showcase-bangumi-game-creators.test.ts` covers
  current role bindings, separate acceptance/adoption, exact work/creator
  reads, role and citation meaning, wrong-scheme and unresolved withholding,
  and identity reuse on an unchanged refresh. Controller acceptance and a real
  dump walkthrough remain deferred.

### Bangumi character identity and appearance mapping

The default local showcase seed derives the character-kind and appearance-role
requirements from actual selected Bangumi character records and type-2 anime
`subject-characters` rows. It creates only the exact source-specific schemes and
codes in the pinned Bangumi mappings, then sends their candidates through the
common publication journal for separately authorized acceptance and adoption.
It publishes a scheme before creating its Concepts, rereads each acknowledged
UUID through the current public API, and reruns the complete Bangumi generation
with only current exact bindings. Names never resolve identity. The explicit
`--bangumi-character-bindings <json>` mode remains available to standalone
operators. Appearance proposals retain their source row key, digest, citation,
work and character identities, role Concept and supported order semantics.
Missing, malformed, unknown or wrong-scheme roles remain bounded diagnostics;
unsupported `schema:position` does not remove the independently useful role.

Decision: The default character vocabulary and appearance adapter follows Bangumi type-2 anime work rows only.

- Touches: at most 64 admitted appearance rows per selected anime work, one
  character-kind row per admitted character, current work/character identities,
  up to two ConceptSchemes and seven Concepts, and the existing sealed local
  publication journal.
- Bound: appearance projection is O(64 × selected anime works), source-row
  evidence is capped before materialization, and current identity reads stay in
  pages of 16. The role mapper emits a qualified relation only when exact work,
  character and current role Concept identities are available. Overflow is one
  bounded diagnostic per work.
- Growth check: `services/importer/tests/showcase-bangumi-characters.test.ts`
  covers selected anime rows, kind/role separation, exact row custody and an
  unavailable wrong-scheme binding. The native public-read and restart scenario
  is `services/kernel/test/imports/showcase-bangumi-characters.test.ts`;
  browser pages and inverse projections remain Web and Semantic ownership.

### Bangumi character source names

`planCrossMediaSeed` retains each selected `character` row for the existing
`bangumi_cross_media` registration. The shared converter accepts the pinned Crt
string and exact type-1 CharacterDetail `infobox` array; the official bounded
fixture is an excerpt of [CharacterDetail](https://api.bgm.tv/v0/characters/1)
and its [API schema](https://bangumi.github.io/api/dist.json). It emits cited
`schema:name` and `schema:alternateName` facts on the source-bound Character.
The array path preserves scalar punctuation, diagnoses unlabelled/unknown
labels, and withholds conflicting or over-limit projections. Its evidence
fingerprints only bounded name fields and retains absent/null/top-level name
states; nested API values are not interpreted. An already captured response
uses the same converter and journal, with no name-only fetch or graph expansion.
The ordinary Bangumi dump CLI remains JSONL; the fixture and malformed or
refresh derivatives are source review and synthetic test inputs respectively.

Decision: admit parsed CharacterDetail arrays beside the existing Crt grammar and reuse already captured selected responses in the same converter and journal; add no name-only fetch or graph expansion. Top-level `name` is `und`, `name_cn` is `zh`, `简体中文名` is `zh-Hans`, and only exact reviewed alias labels are mapped. The Crt path alone splits its observed full-width-comma nickname syntax.

### Bangumi character physical profile

The default `planCrossMediaSeed` path already selects a character by the
selected work's `subject-characters` relation and passes that exact `character`
row to the ordinary `bangumi_cross_media` registration. The conversion adds
bounded Crt physical evidence on that existing path; the common finite
publication manifest remains responsible for exact candidate acceptance,
independent property adoption and the current public read. An acknowledgement
alone does not make a quantity public. Source attribution and metadata rights
remain independent of summary permission.

Decision: keep only explicitly unit-bearing released quantities, preserve source units and literal zero, and withhold Bangumi blood type until a current native Concept binding exists.

Decision: Book-template names, character names and physical profile stay under Registered source vocabulary mapping and are not repeated under Explicit local showcase publication.

- Touches: at most one height and one weight quantity per selected `character:<id>`, the exact scalar and `/infobox/fields/<n>` evidence, and bounded sanitized diagnostics. Existing names, kind, appearance and summary behavior stay on their current paths.
- Bound: 65,536 UTF-8 infobox bytes, template depth 2, 64 fields, 128 retained scalar code units, 64 quantity characters, 2 emitted quantity facts and 16 diagnostics. Explicit centimetres/metres and kilograms/grams retain their source units; missing units are never guessed. The existing source journal, publication manifest and command ceiling still apply.
- Growth check: `packages/conversion/tests/bangumi-character-measurements.test.ts` covers exact unit meaning, unknown and unsupported values, independent removal and the parser bounds. `services/kernel/test/imports/bangumi-character-measurements.test.ts` covers default selected identity, exact citation, proposal versus public adoption, reopen and changed-source suppression under a current facts fence. Kernel execution remains controller-owned and is deferred to integration.

### Default Bangumi anime episodes

The default local seed discovers Episodes only for selected Bangumi type-2
anime, keeps each source `episode:<id>` identity, and adds the exact
`episode.subject_id` parent edge. The Episode kind adapter re-reads the finite
reviewed type scheme and Concepts through the current public reader before it
composes with other vocabulary-admission hooks. A retracted, hidden or changed
binding withholds only the kind statement; the converter still imports the
Episode identity and independently admitted ordinal, airdate, duration and
attributed summary. The source ordinal is a direct Episode fact; it is not
duplicated as a parent-edge qualifier. Ordinary import proposals remain subject
to separate acceptance and adoption.

Decision: the local showcase imports one `BATCH_LIMIT` Episode window per
selected franchise and reports every additional selected source key as an
explicit omission.

- Touches: selected type-2 anime Episodes, exact parent edges, the existing
  reviewed Episode type scheme/concepts, and current public parent/Episode
  readback.
- Bound: at most one `BATCH_LIMIT` Episode window per selected franchise; every
  overflow diagnostic carries its exact `episode:<id>` key, with a fixed maximum
  of 4,096 omission diagnostics. The adapter reads only the scheme and seven
  known Concepts; it performs no label or catalogue scan.
- Growth check: `tests/showcase-bangumi-episodes.test.ts` covers main/special
  identity, an unrelated row, withheld bindings, composition and overflow.
  `../kernel/test/imports/showcase-bangumi-episodes.test.ts` covers independent
  acceptance/adoption, current public reads, binding retraction and resumable
  identity. Existing Episode ordinal/date/duration/summary checks remain in
  `tests/bangumi-episode-fidelity.test.ts`.

### VNDB character traits and selected work appearances

The family seed acquires `traits`, `traits_parents`, `chars_traits` and
`chars_vns`. VNDB Character identity stays source-specific. Only actual selected
work appearances supply membership; trait and cast citations retain exact table
keys. `schema:keywords` retains the source trait Concept, lie=false and spoiler;
`schema:character` retains the exact role Concept and spoiler. False-positive,
unsupported, missing-qualifier and release-scoped rows remain gaps.

The broad publisher emits the bounded trait dictionary, parent closure and
selected appearance roles through the existing importer and common journal.
Current type, `schema:url`, `skos:inScheme` and required adopted `skos:broader`
evidence precede association use. Parent closure retains its caps; a contradiction
withholds only the affected term, leaving independent names and blood types.
Trait labels keep `traits.name`: ja for kana, zh-Hant for Han without kana,
otherwise en. Association revisions remain `character-trait@1` and
`appearance-role@1`; vocabulary uses `vndb-character-vocabulary@1`.

### Bangumi person biographies

Selected `subject-persons`/`person-characters` rows keep `person:<id>` identity
and type. Nonempty summaries become attributed `schema:abstract` proposals.
Type-1 PersonDetail `birth_year`/`birth_mon`/`birth_day` integers become one
cited day-precision `schema:birthDate`; partial, Organization and Character
`生日` stay omitted. Archive person rows lack those fields: one shared GET
`/v0/persons/{id}` per selected id (existing public GET, 65,536 bytes, 64 people)
is sealed beside the archive digest. Decision: that GET is the shared Person
career, image and date acquisition, not a second HTTP client. Failed acquisition withholds only the date.
Ordinary dumps are JSON-lines; a `career` array keys `person:<id>` under
`cross-media-entities@15`. Selected envelopes keep
`cross-media-entities@15+bangumi@15`. `last_modified` is comment time, not a
wiki revision. VNDB prose is not borrowed.

- Touches: one Person, at most one birthDate and one abstract, at most 64 PersonDetail reads.
- Bound: 65,536-byte response, one GET per id per attempt, journal reuse; no second HTTP stack.
- Growth check: `tests/showcase-bangumi-person-birth-date.test.ts`, `test/bangumi-people-biography.test.ts`; native `services/kernel/test/imports/bangumi-person-birth-date.test.ts` remains controller-owned.

Reviewed metadata and candidate provenance compare bounded canonical JSON values. Public transport snapshots
with null object prototypes retain the same provenance; prototype identity is never a source or permission fact.

## Explicit local showcase publication

Decision: `task seed:dev` publishes sealed current source/candidate digests; ordinary imports only propose.

[Seed denial diagnostics](seed-diagnostics.md).

### Refresh selected VNDB Character vocabulary

Decision: reviewed selection admits only source-supported i23/i30 traits and
selected appearance roles; unavailable Concepts withhold their associations.

The seed rereads reviewed traits and roles before initial import and each
vocabulary reseed. Characters may occupy either planned record group.
The common journal publishes selected role schemes and Concepts, then current
reads supply the returned trait/role profile and association bindings. Optional
`--vndb-character-vocabulary` / `REZICS_DEV_VNDB_CHARACTER_VOCABULARY` UUIDs are
lookup hints, never adoption authority. Unreviewed traits stay withheld.

- Touches: selected Character rows, one reviewed trait Scheme and only needed
  i23/i30 Concepts, plus selected current role bindings.
- Bound: existing closure and publication caps; each refresh reads at most one
  trait Scheme and two Concepts.
- Growth check: `tests/showcase-vndb-traits.test.ts` covers source selection and
  isolated withdrawal; `test/imports/showcase-character-vocabulary.test.ts`
  retains independent current Character/work reads and reopen acceptance.

### Selected VNDB Release context across vocabulary phases

Later Character, credit and Bangumi vocabulary reseeds reuse the actual selected Release/Work seed result and latest current platform/media groups. A changed current binding reseeds the same selected plan; a missing or retracted group withholds only its association. Release-state groups and source keys stay composed, while independent dates, names and editorial choices remain available. Ordinary imports remain proposal-only; explicit review uses the existing ShowcaseJournal and common publisher.

Decision: later release reseeds carry the latest current classifications with the actual selected seed result; they retain released-state groups and source identities while replacing stale platform/media bindings.

Decision: the local seed stores reviewed-catalogue UUIDs in the importer journal and rereads tag Concept/Scheme and other native bindings on each run; unavailable tag reads withhold only that association and exact pending keyword candidates retain their original intent.

Decision: work cover responses refresh after terminal media; pending, unknown and fenced intents retain sealed evidence; changed responses get new receipts.

Decision: selected Bangumi Person and Organization images use only pinned `GET /v0/persons/{person_id}` `PersonDetail.images.large` after exact response `id` and archive-selected `type` match; missing, null, blank and placeholder images are absent, and no alternate size or image redirect is used.

The finite selected-people rows are derived after the existing per-provider cap. Their response evidence uses the official OpenAPI schema version `2026-07-24`, bounded bytes, SHA-256 and an optional bounded ETag; a missing source revision is recorded as `unversioned`. Changed response digests create immutable receipts in the same showcase journal. Pending, unknown and fenced outcomes reuse prior evidence; ordinary media submission, cover fencing and separate local review/adoption remain shared with work covers.

If the native cover POST returns an explicitly retryable `dependency_unavailable` (503) or `rate_limited` (429),
the showcase retains its exact prepared intent as unavailable without inventing a reservation or Media ID. The same
producer invocation does not submit that refused intent again. Independently authorized text facts can finish and
publication records the image gap. An indexed check of the current unsubmitted intent and source digest keeps that
asset eligible on an unchanged source refresh. An actually accepted pending job still holds its source generation
until normal completion. Permission failures and other refusals remain failures; native admission, retry limits and
all media checks stay active.

#### Current cover source refresh

- Touches: one media intent (65,536-byte cap), source receipt and latest result; reserved, uploaded, available, rejected and unknown states stay journalled.
- Bound: two indexed binding reads, one receipt lookup, one latest intent read scanning at most 320 outcomes, and one detail GET per selected work per run within existing response and deadline limits.
- Growth check: `tests/bindings-growth.test.ts` measures indexed intent cost at three scales. `tests/showcase-media.test.ts` covers pending receipt retention, terminal source refresh, refusal, retry and native media states. `task seed:dev` keeps five roots, direct cast, episodes and 64 creators per provider; Organization `wdt:P6298` remains omitted because its profile has no Bangumi-ID property.

Decision: selected graph preparation retains at most 8,192 edges and 8 MiB total (1 MiB per edge), recording a bounded gap when either limit is exceeded.

`task seed:dev` elects Bangumi Steins;Gate anime/book (10380, 84148) and CLANNAD anime (51), plus VNDB Steins;Gate (v2002) and CLANNAD (v4). It adds direct cast and episodes, omits recursive work expansion and releases, and skips the separate Book Girl importer. It reuses the Accounts `dev:persona` setup and its private `.temp/local-stack/seed.env`. The local invocation gives the cross-media CLI a separate durable showcase journal. The ordinary CLI stays proposal-only unless that local publication state is explicitly supplied. The journal records exact create and proposal command bodies before send, then stores native UUIDs only after an acknowledged response. Publication derives its intent from those selected source records, current reads, and exact candidate identities. Ordinary selected graph relations and release membership use their existing graph commands and exact source envelopes; only an acknowledged command whose exact selected endpoints and current candidate still match enters the manifest. The publisher checks both native endpoints before review actions, then independently reads both public identities and the complete relation statement, including its qualifiers and source citation. A missing endpoint or unreadable relation withholds that edge and keeps unrelated public facts available. Publication reads only selected subject/property candidate pages, accepts each selected candidate through the review API, and adopts only those IDs while preserving any prior adoption selections. Refused steps keep their known acknowledgements; an unknown send reuses its sealed body and idempotency key on restart.

The result carries provider and native type bindings, source keys, source and converter digests, selected candidate IDs, and ordinary reader routes. Each selected subject and vocabulary dependency is checked through current reads, and final facts use the tokenless Global-context reader. Source ConceptScheme and Concept records require acknowledged create receipts and exact current URI and scheme membership; no canonical or label equivalence is inferred. Decision: retain the registered VNDB cited `schema:genre` mapping. The common journal carries each admitted work, exact `tags_vn` path and tag code with its current released Concept/Scheme IDs and URI pair, then rereads that binding before review. A missing, unsupported, withdrawn or changed binding withholds only that association and records a bounded addressable diagnostic while independent source and adopted facts remain available. Adoption action identity includes the sealed manifest intent and exact selection body. The default cross-media seed still consumes only the exact Bangumi editor `meta_tags` literal `后宫` through its trusted alias; source-tag removal retracts only importer-owned candidates. The pinned `GET /v0/subjects/{id}` response is validated against the selected work and required image fields before `images.large` is admitted. Its SHA-256 and optional ETag are sealed beside the archive revision/digest in the showcase journal. A missing or invalid cover stays an addressable gap while independent metadata remains useful. Reserved/uploaded/rejected and unknown states stay journalled; retries reuse exact bytes and keys, and only available media is proposed. Covers retain `(c) rights holder`, `via Bangumi`, unknown image licence, cover-only use, private original retention and public re-encoded variants. Prose stays private without admitted rights. Public visibility makes no Search-index claim.

### Cost: selected showcase media acquisition and publication

- Touches: preparation of at most 8,192 selected graph edges and 8 MiB of retained edge data (at most 1 MiB per edge), plus at most 768 selected source records, 8,192 candidate assertions, 512 vocabulary records, 128 assertions per record, 100 candidates per current page, 256 selected Bangumi works, 64 selected creators and 320 combined media outcomes or omissions.
- Bound: work is limited to the exact five roots, their direct cast and episodes, at most 64 people or organizations per provider, reviewed VNDB trait/tag codes i23/i30 and g105/g249, exact local candidate IDs, and required current subject/property reads. Current native and public reads are deduplicated by subject ID and cover at most 768 selected source plus 512 vocabulary subjects; graph targets must belong to that selected set. Candidate pages are limited by the 8,192 assertion cap and 100-row page bound. Selected work and creator detail acquisition is sequential and capped at 320 requests, 1 MiB per response and 1 MiB combined sealed source evidence, using the existing deadline and pacing. Media send/status uses the ordinary authenticated transport, exact importer bindings and current `(source, external_id, cover)` fence; public readback uses the existing bounded publication pass. There is no catalogue-wide scan, unsupported-tag inference or generic accept-all mode.
- Growth check: `services/importer/tests/showcase-media.test.ts` covers work recovery, creator/Organization conversion, absent/unavailable/invalid detail states, changed image evidence and unknown-send receipt reuse; `services/importer/tests/showcase-publication.test.ts` proves exact candidate and relation publication across refusal, current-read withholding and journal restart; `services/importer/tests/showcase-bangumi-genres.test.ts` covers trusted alias resolution. `services/kernel/test/imports/showcase-media.test.ts` authors the common Person/Organization media, review, public-read, served-variant and takedown path with synthetic detail derivatives; integration verifies it against the actual finite default selection. Native showcase media, genre and graph walkthroughs remain controller-owned; no native pass or database growth series is claimed here.

### Bangumi Person careers

The selected-family converter retains authentic career strings on actual
type-1 Persons. When the selected archive row omits `career`, explicit local
showcase seeding fills only that selected Person through bounded public
`GET /v0/persons/{id}`. The same validated response can supply the exact parsed
`简体中文名` entry when the selected archive row has no admitted Chinese name;
career and name projection share its sealed response and do not refetch. A
present career field, including an empty or malformed value, still takes
precedence for occupations. The API response must identify the requested
Person and contain at most seven bounded
strings; its exact endpoint, SHA-256, optional ETag and values are sealed in the
existing `ShowcaseJournal`. Missing or malformed responses withhold dependent
occupations and Chinese names while retaining the independent original name,
identity, biography and credits. No archive revision is invented.

The default local review derives only present finite categories, uses the
existing common ShowcaseJournal publisher and current vocabulary reader, and
feeds the reread bindings into the ordinary importer. The optional
`--bangumi-character-bindings` input remains a validated current-binding
override. Ordinary imports emit cited `wdt:P106` proposals only; only explicit
local showcase review accepts and adopts candidates. Source Concepts under
`https://rezics.com/schemes/bangumi/careers/` are source-owned and do not assert
canonical equivalence.

Chinese names remain ordinary proposals until a separate local review selects
their candidates and an independent current public read verifies them on the
same Person. Source refresh creates a new name candidate on that identity;
missing or malformed Chinese input does not erase an existing editorial choice.

- Touches: at most 64 selected Person/Organization rows, 64 selected-Person
  fallback requests, one 64 KiB response per request, one Scheme and at most
  seven Concept requirements, and their separate current reads.
- Bound: selected actual Persons missing archive career or birth-date fields
  share one GET `/v0/persons/{id}`; requests are sequential with a 250 ms gap,
  share the existing import deadline and bounded public transport, and no
  population or label scan occurs.
- Growth check: `services/importer/tests/showcase-bangumi-person-careers.test.ts`
  covers archive precedence, exact API receipt, malformed-response withholding
  and sealed replay. `services/kernel/test/imports/bangumi-person-careers.test.ts`
  covers default review/adoption, current reads and ordinary source proposals;
  broader acceptance remains integration-owned.

### Bangumi TVAnime official websites

The official-website projection runs through ordinary `bangumi@14` and the
selected-family `cross-media-entities@15+bangumi@15` registration. It recognizes
only a literal `官方网站` value from the exact pinned type-2 TVAnime template.
The URL fact is distinct from its `schema:url` reference to the exact Bangumi
subject record. Source spelling, path, query and fragment are preserved. A
changed value offers a new candidate on the same acknowledged work identity;
ordinary import stays proposal-only and current adopted selections are not
rewritten by source text. Absent or unsupported values do not retract facts.

The common publisher keeps independent exact-candidate acceptance and adoption,
current authority checks, journal recovery, source and tuple-home fences, and a
current public read of the acknowledged TVSeries. The website is never fetched
or used for identity resolution. The one-literal/no-host-normalization/no-list-
splitting decision is recorded in `packages/conversion/README.md`.

- Touches: one selected TVAnime source record, up to 32 URL proposals and 16
  bounded omission diagnostics, each candidate citing the source record.
- Bound: 65,536 projected characters, 64 visited infobox fields, 1,500
  characters per URL and at most 95 converter commands under the released
  100-command batch ceiling; destination pages are not requested.
- Growth check: `services/importer/tests/bangumi-official-websites.test.ts`
  covers ordinary/default proposals, same-identity refresh and unsupported
  source shape. `services/kernel/test/imports/bangumi-official-websites.test.ts`
  covers separate acceptance/adoption, public read, restart and fencing; native
  execution is controller-owned and the M1 walkthrough remains separate.

### Bangumi TVAnime work evidence

Decision: trim only horizontal template/list-boundary whitespace; `链接` remains a cited `wdt:P973` descriptive page and `官方网站` remains the separate `schema:url` mapping.

Only exact `{{Infobox animanga/TVAnime` type-2 fields `链接` and `Copyright` are admitted. Descriptive destinations preserve their source spelling and cite the Bangumi subject record; notices remain verbatim `schema:copyrightNotice` values and grant no licence or media permission. Malformed neighbors are bounded, source-free omissions; summary and cover rights remain separate.

- Touches: ordinary `bangumi@14` and selected-family `cross-media-entities@15+bangumi@15` publication of cited TVAnime work evidence through the existing journal and review/adoption/current-read path.
- Bound: 64 visited fields, 16 descriptive links, 16 diagnostics, and the compiled TVSeries 1,500-character limits. No linked-page fetch or hostname identity lookup.
- Growth check: `tests/bangumi-work-evidence.test.ts` covers selected-family proposals, unchanged/changed source, citations, malformed neighbor and repair. `../kernel/test/imports/bangumi-work-evidence.test.ts` authors ordinary independent adoption, reopen/current reads and the facts fence; no real-data walkthrough is claimed.

### Bangumi Game-template subject names

Ordinary Bangumi registration and selected-family Game records use the exact
`{{Infobox Game` grammar through the current `bangumi@14` converter. Type 4
remains `schema:VideoGame`; scalar `中文名` supplies `zh`, and scalar or
single-level bullet `别名` stays `und`. Top-level labels keep their existing
meaning. Unsupported field occurrences are withheld atomically while separate
valid names remain eligible. The normalized source retains the bounded
infobox, so changed names produce changed source digests and fresh proposals on
the acknowledged identity. This adds no identity lookup or publisher; local
review and adoption use the existing manifest, journal, source admission and
facts fence. Name links and diagnostics grant no rights.

- Touches: at most 24 distinct names and 16 omission diagnostics from one
  selected Game record, with exact Bangumi record citations.
- Bound: the 65,536-character record/infobox cap, 64 visited fields and current
  batch/journal limits; source prose stays out of logs.
- Growth check: `tests/bangumi-game-names.test.ts` covers ordinary and selected
  conversion, exact provenance, malformed field omission, neighbor exclusion
  and changed-name refresh. `../kernel/test/imports/bangumi-game-names.test.ts`
  covers independent native adoption, same identity on reopen and the facts
  fence; native execution remains controller-owned.

### Bangumi Game characters and voice performers

The selected-family seed keeps the existing type-2 anime appearance branch and
adds a separate type-4 Game branch. Only an actual `subject-characters` row on a
selected, acknowledged Game can create an appearance. A `person-characters` row
must match that Game and its admitted Character; the Person remains a separate
Bangumi identity. Existing vocabulary preparation reads only the selected role
and Character-kind Concepts, then the ordinary source registration emits cited
`schema:character` and Character-qualified `wdt:P725` candidates. The common
showcase journal, exact accept/adopt operations and public reads remain in use.

Decision: malformed optional appearance order retains the independently valid
role-qualified association, records a source diagnostic, and emits
`schema:position` only when the current `schema:VideoGame` definition admits it.

The bundled native release admits Game `schema:character` with `wdt:P3831` and
Game `wdt:P725` with required `wdt:P453` and supported `wdt:P1932`. The Bangumi
source inventory still declares `subject-characters` and `person-characters`
on `schema:TVSeries` only; its producer contract needs Game applicability while
retaining the anime path. Web and Semantic own public page and inverse
projections, so this delivery claims no page/index acceptance.

- Touches: at most 64 selected appearances and the existing stricter 64 voice
  associations per Game, within the 16 KiB row, shared 4 MiB appearance
  evidence, common batch and journal bounds, and the actual 64 KiB command
  envelope.
- Growth check: `tests/showcase-bangumi-game-characters.test.ts` pins selected
  source rows, role binding, malformed order, exact performer qualification,
  citations and unrelated-work exclusion. The native lifecycle and current-read
  scenario is `test/imports/showcase-bangumi-game-characters.test.ts`; broader
  native and public-page acceptance is controller-owned.

### Bangumi Game first publication date

[Touches, Bound and Growth check](../../packages/conversion/bangumi-game-publication.md).

### Bangumi Game web destinations

Ordinary Game imports preserve exact unqualified values from the pinned
`{{Infobox Game` fields `website` and `链接` as separate `schema:url` and
`wdt:P973` proposals. Occurrence citations retain the source field pointer; the
Bangumi subject URL remains provenance only. Unsafe, malformed or qualified
destinations are withheld without suppressing independent valid facts. The
conversion and selected-family callers share the honest `bangumi@15` revision
and existing native review, adoption, refresh, journal and current-read APIs.

Decision: preserve admitted URL bytes; withhold labelled destinations until a
released source contract can preserve their platform, region or edition meaning.
No destination is fetched or followed, and none grants mutation authority.

- Touches: at most 16 candidates across the two destination fields for one
  source-selected Game, with independent native adoption.
- Bound: existing projection, infobox, journal and 64 KiB command-envelope
  limits; overflow is an explicit bounded omission.
- Growth check: `tests/bangumi-game-web-destinations.test.ts` covers ordinary
  registration and malformed, dangerous, qualified and overflow cases. The
  selected-family native lifecycle is `test/imports/bangumi-game-web-destinations.test.ts`;
  execution and public-page acceptance remain controller-owned.
