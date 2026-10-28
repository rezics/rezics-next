# Imports capability acceptance manifest

This is the workflow inventory for [Imports](imports.md), applying the adopted
[API acceptance gaps decision](../research/api-acceptance-gaps.md#workflow-change-the-manager-can-adopt).
It adds no product authority, runtime adapter or definition switch. Behaviour remains with the
[conversion](../../packages/conversion/README.md), [importer](../../services/importer/README.md),
[Semantic](../../services/kernel/src/semantic/README.md), [Content](../../services/kernel/src/content/README.md)
and [filtered-list](../filtered-lists.md) contracts.

Source inspection baseline: `5ee41687d596ddf03894a9d42cc9701388cf9e0a`.
No product suites were run for this inventory. The manifest's acceptance is
`node_modules/.bin/oxfmt --check docs/goals/imports.capabilities.md`; it proves formatting/delivery only.
Missing acceptance below stays owned work, not a claim that a required capability is unsupported forever.

## Evidence stages

| Capability                       | Specification validated red                                                                                         | Native driver registered                                                                | Implementation exposed                                                                                                        | User-case pass at named revision                                  | Promoted                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| Ordinary provider import/refresh | Existing executable suites; API fixture README records historical missing-driver red evidence, not revalidated here | API, identity and media wrappers registered; VNDB statistics remains unbound            | Ordinary batch, fence, subject/candidate, media and statistic routes visible in source; complete composed job not established | Missing: imports must record executed native results and revision | Missing: imports promotion evidence |
| Import-to-discovery              | REQUIRED NOT YET FROZEN for the composed released-data matrix                                                       | Missing: imports composed wrapper/driver; shared consumer bindings are not this journey | Partial producer mappings and native subject reads; reviewed tag/form mappings and released controls missing                  | Missing: imports with semantic/search/commerce/web                | Missing: imports promotion evidence |
| Cover-native-recovery            | Three native crash/replacement/fence scenarios frozen; local regressions retained                                   | Native composition registered; see execution evidence below                             | Actual receipt/media/SQLite and subject/page/download assertions; consumer matrix remains open                                | 3 native cases pass at recorded revision; whole capability open   | Missing: imports promotion evidence |

“Specification validated red” requires recorded execution with missing binding; file presence alone does not earn it.
A missing-driver verifier can advance only that stage. Registration is inspected binding, exposure is inspected
production code, a pass requires actual named-revision execution with all exact scenarios and zero skips/todos,
and promotion requires separate integration evidence. Helper, converter and SQLite tests support these jobs;
they never substitute for native HTTP closure. Historical report/README observations are not current passing runs.

## Released definitions and fixture delivery

The actual bundled definitions are [release/rezics.json](../../packages/definitions/release/rezics.json),
[Book](../../packages/definitions/catalogue/book.yaml), [classification](../../packages/definitions/catalogue/classification.yaml),
[game](../../packages/definitions/catalogue/game.yaml) and [Recipe](../../packages/definitions/catalogue/recipe.yaml).
Book work `schema:Book` and edition `bf:Instance` are distinct; `schema:exampleOfWork` links them.
`schema:keywords` is Concept-valued; game/release `schema:gamePlatform` is released.
Recipe `schema:cookTime` is an integer minute quantity (`wd:Q7727`).
These released schemas are not delivered runtime subject populations or actual Concept creation receipts.

| Required fixture/data                     | Actual delivery and missing closure                                                                                                                                                                                                                                                                                                                                     | Owner                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Genuine words                             | No `schema:wordCount` in bundled release. Required nonnegative integer quantity, unit `1`, Book facet; counted text/version, language, source and measurement meaning must accompany genuine producer data                                                                                                                                                              | Semantic release/builder; imports reviewed source mappings                               |
| Book range controls                       | Required `B-long` 1,200,001; `B-edge` 1,000,000; `B-short` 999,999; unknown words absent/somevalue; characters-only 1,400,000 with no words; edition page-count control. Native runtime creation receipts missing                                                                                                                                                       | Semantic shared released-data fixture builder                                            |
| Form/tag controls                         | Required actual created `HAREM` and `LN` Concept IDs, public labels/scheme/attribution and a released `FORM` key. None delivered for this journey. `B-long`/`B-edge`/`B-characters` both; `B-short` form only; `B-unknown` harem/unknown form; alternate-form `B-tag-only`; `B-form-only` no harem. These names are logical discriminators, never IDs or title searches | Semantic definitions/Concept receipts/builder                                            |
| Recipe controls, separate editorial input | `schema:suitableForDiet` release/representation and vegetarian Concept receipt missing; cookTime already released. Required genuine authored `R-quick` vegetarian/25, `R-edge`/30, `R-slow`/31, `R-meat` nonvegetarian/20, `R-unknown` unknown diet/20, `R-cooked`/20 Alice-completed, `R-other-cooked`/20 Bob-only completed. Native shared data missing               | Semantic editorial fixtures; commerce own completion facts                               |
| Platform release qualifiers               | Released gamePlatform does not supply actual Switch/PC Concept receipts or discriminating release population. Required Switch/Japanese versus PC/English statements with dates; Switch+English must not Cartesian-match across statements, Switch+Japanese must match one statement                                                                                     | Semantic shared builder/qualifier admission; imports reviewed mappings; search consumers |
| Personal/source/privacy controls          | Released profile bindings and two immutable accepting releases missing; Alice/Bob independent state, label-only, holding-only, active/history-only, empty shell/follow-only controls missing from shared journey. Required public curated duplicate occurrence/alias, private/unlisted controls, overlapping Zone scope/mount and current withholding/revocation        | Semantic profiles/Zone; commerce population; accounts authority; search disclosure       |

Genuine word and character scopes remain separate: no pages, characters, translated estimate, reading duration or
series sum fills words. If the four providers supply no genuine words, imported words remain unknown. Separate
genuine editorial word fixtures must exercise the range controls. Recipe editor data is not four-source import
data; no recipe-site method import or new source is introduced. Inventory YAML and this report are not delivered
runtime data. No synthetic release may mask missing launch definitions, no private label may stand in for diet,
and no fake Concept ID or arbitrary title search may stand in for classification.

Imports' independent pinned Bangumi input is now present:
[public-book-meta-tags.json](../../specs/fixtures/imports/bangumi/public-book-meta-tags.json) and its
[provenance](../../specs/fixtures/imports/bangumi/PUBLIC-METADATA.md). It preserves native Book `id: 498`, `type: 1`
and the complete ordered public `meta_tags`, including `后宫` and `漫画`, from archive
`dump-2026-10-20.210332Z.zip`, line 457; the provenance records asset/line hashes, offsets and CC-BY-SA-3.0
attribution. This is a pinned native input, not an adopted REZICS subject, light-novel assertion or converter pass.
Imports owns its collection and reviewed mapping; Semantic owns the real Concept/property binding.
Current [Bangumi converter](../../packages/conversion/src/bangumi.ts) does not consume `meta_tags` or emit these
classification proposals. Ordinary `tags`, platform/infobox/date retention is not discovery support.

## Ordinary provider import and refresh

**Job:** a maintainer imports licensed records, restarts safely, refreshes only changed facts and proposes permitted
source removal without erasing communal subjects or independent adoption. Community tools use the same pure,
revisioned converter exports and ordinary public authority, never a private writer.

**Personas:** ordinary importer with explicit Global grants and Auth scopes; ordinary contributor/editor with
subject-create but no bulk authority; governance operator only for fixture provisioning; anonymous public reader;
owner and other-owner consumers after import. Reduced/unscoped actors cannot borrow grants; revoking bulk authority
must deny original-bearer receipt replay without disclosing it. Delegated actors must use current delegated
permissions, not inherit importer privilege. Suspended-valid and revoked/invalid credentials are distinct controls.

| Provider     | Actual checked-in input and mapping                                                                                                                                                                                                                                                                                                                                        | Evidence limit                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bangumi      | [API JSONL](../../specs/fixtures/imports/api/bangumi.jsonl): native IDs 1/2, TV-series records, summary and first cover; [single record](../../specs/fixtures/imports/bangumi/subject.json). `wdt:P5732`, names, Text abstract with CC-BY-SA-3.0; cover separately unknown rights                                                                                          | Synthetic inspectable API data, not released Book classifications. Public metadata-tag input above is independently observed; its runtime mapping missing     |
| VNDB         | API suite constructs public `vn`/`vn_titles`/`entry_meta` table streams, v1/v2, revisions 7/19 and zero votes using [real headers](../../specs/fixtures/imports/vndb-tables/db/vn.header). [Grouped record](../../specs/fixtures/imports/vndb/record.json) supports pure conversion; [legacy inline fixture](../../specs/fixtures/imports/api/vndb.sql) is rejection input | Permitted metadata ODbL-1.0/LicenseRef-DbCL-1.0; descriptions/images omitted. Zero-vote API data cannot prove nonzero statistics                              |
| Open Library | [Five-column TSV](../../specs/fixtures/imports/api/openlibrary.tsv): OL1W/OL2W work revisions 1; [work](../../specs/fixtures/imports/open-library/work.json)/[edition](../../specs/fixtures/imports/open-library/edition.json) conversion controls for native work/edition, ISBN-13, unresolved relations retaining external-ID qualifiers                                 | CC0 bibliographic metadata; unknown-licensed prose omitted, cover separately unknown. API work fixture does not establish native edition-to-discovery closure |
| Wikidata     | [JSONL](../../specs/fixtures/imports/api/wikidata.jsonl): Q1/Q2 revisions 101/102, Book P31 and referenced P648; [entity](../../specs/fixtures/imports/wikidata/entity.json) richer supported claim controls                                                                                                                                                               | CC0 structured data; bundled vocabulary controls claims/types/qualifiers, unresolved references remain unresolved; no user/talk text                          |

[Source registration](../../services/importer/src/source-registry.ts) supplies trusted aliases and converter revisions;
[converter sources](../../packages/conversion/src/) supply pure commands, never IDs, adoption or transport.
Open Library reader kind `openlibrary` differs from its default envelope alias `open-library`.
The API populations above are synthetic controlled native-format inputs, not the missing shared released-data
builder. The [runtime](../../services/kernel/test/imports/api-runtime.ts) binds the real Importer/SQLite, authenticated public
batch/fence/media requests and native content workers. The [observer](../../services/kernel/test/imports/api-observer.ts)
reads subjects/candidates/revisions and performs ordinary Context adoption; those inspection reads use its observer
credential, so they do not prove every anonymous discovery surface. Native returned IDs and receipts are observed,
not minted in an adapter. Cover bytes are reencoded and disclosed separately from source URLs.

**Native acceptance registration (commands recorded, not run here):**

- `bun run --cwd services/kernel check test/imports/api-outcomes.test.ts`:
  [wrapper](../../services/kernel/test/imports/api-outcomes.test.ts) sets `IMPORT_API_DRIVER` to
  [api-driver.ts](../../services/kernel/test/imports/api-driver.ts), opening the real fixture; checks exact suite count and no skips/todos.
- `bun run --cwd services/kernel check test/imports/identity-outcomes.test.ts`:
  [wrapper](../../services/kernel/test/imports/identity-outcomes.test.ts) binds `IMPORT_IDENTITY_DRIVER` to
  [identity-driver.ts](../../services/kernel/test/imports/identity-driver.ts), real Auth namespaces/Access/grants.
- `bun run --cwd services/kernel check test/imports/media-boundary-outcomes.test.ts`:
  [wrapper](../../services/kernel/test/imports/media-boundary-outcomes.test.ts) binds `IMPORT_MEDIA_BOUNDARY_DRIVER` to
  [media-boundary-driver.ts](../../services/kernel/test/imports/media-boundary-driver.ts), real jobs/Sharp/object-store boundary.
- `bun run --cwd services/kernel check test/content/imported-field-outcomes.test.ts`:
  [wrapper](../../services/kernel/test/content/imported-field-outcomes.test.ts) sets `IMPORTED_FIELD_DRIVER` to
  [native driver](../../services/kernel/test/content/imported-field-driver.ts); Content owns its field/fence/media assertions.

The API suite asserts actual source envelopes, receipts and returned native identity; new/changed/unchanged/vanished
plans, restart/idempotency, mass-stop boundaries, source isolation, field fences before shortcuts and server recheck,
denied replay, actual Retry-After, bounded readers and measured work. Pure conversion or a local SQLite plan is
supporting evidence only. Current transport policy is at most five counted attempts per invocation plus one 401
renewal; the coordinator admits at most eight invocations per logical write, without refill from unrelated successes.
Retry-After must fit the 30-second per-wait, 60-second total wait and 120-second request deadline, never be truncated
into an early retry. Width defaults to 16 (maximum 64), halves on admitted overload and grows on success; the
service rate tier is explicit provisioning, not extra authority. Local
[logical-write-budget](../../services/importer/tests/logical-write-budget.test.ts),
[retry-after-layering](../../services/importer/tests/retry-after-layering.test.ts) and
[write-width](../../services/importer/tests/write-width.test.ts) tests are supporting evidence, not composed native
passes. Imports owns remaining native rate/retry composition evidence. The frozen API scenario inventory follows; all titles are existing, not new prescriptions.

### Frozen native API scenarios

Source: [imports-api.test.ts](../../specs/imports-api.test.ts). Exact existing scenario titles:

- `Bangumi dump preserves summary rights and separately credited cover`
- `VNDB COPY dump preserves permitted factual rights and source references`
- `unsupported inline VNDB COPY fixture has no effects or checkpoint`
- `truncated public VNDB table streams and mismatched headers cannot publish or checkpoint`
- `Open Library five-column TSV imports through public bulk API`
- `Wikidata JSON lines retain references without fabricating native external IDs`
- `identical dumps after importer restart have zero duplicate effects for every source`
- `changed records and converter revisions append proposals while community adoption survives`
- `mass disappearance stops before bulk writes or checkpoints and isolates sources`
- `exactly twenty percent disappearance proposes source removal without deleting subjects`
- `losing all prior records always stops even for a one-record baseline`
- `takedown fences survive unchanged refresh payload changes restart and reconversion`
- `server fence recheck blocks a takedown arriving after client preflight`
- `cover fences prevent reimport on unchanged and changed refresh and hide later disclosures`
- `ordinary preflight and public bulk replays deny import authority before receipt disclosure`
- `importer obeys actual Retry-After and never acknowledges a rejected batch`
- `transport uncertainty retries stable keys after restart without duplicate effects`
- `malformed and truncated dumps never publish disappearances or advance snapshots`
- `hostile user posts and oversized records never become imported content`
- `fixed changes have bounded indexed work as unrelated catalogue and history grow independently`
- `shared PostgreSQL harness measures real bounded API Auth Access fences and receipts`
- `a full dump imports end to end through the public API with fixed reader memory and re-imports idempotently`
- `pure conversion scales with bounded fields and rejects the hard field cap without database work`

### Frozen native identity scenarios

Source: [imports-identity.test.ts](../../specs/imports-identity.test.ts). Exact existing scenario titles:

- `Auth-issued credentials verify exact subjects client scopes and current account state`
- `explicit active human bootstrap persists only a data-defined governance role marker and audit on Global`
- `bootstrap is a durable same-account no-op and refuses a different active human`
- `both actors share subject create but only bulk has import grants on exact Global scope`
- `real reduced-scope Auth issuance cannot borrow a resource grant and tampered tokens fail verification`
- `bulk revocation preserves the original bearer and all other authority for later receipt replay tests`
- `fixtures isolate application Auth namespaces tokens and grants and close idempotently`
- `partial opening failures clean every namespace host and pool before returning the original failure`

### VNDB nonzero statistics: reuse existing unbound acceptance

[imports-vndb-statistics.test.ts](../../specs/imports-vndb-statistics.test.ts) already has six scenarios below;
[driver contract](../../specs/imports-vndb-statistics-driver.ts) loads `IMPORT_VNDB_STATISTICS_DRIVER`.
No native factory/wrapper was found: binding and executable native acceptance command are **missing, imports owner**,
not six tests to duplicate. The suite builds ustar COPY entries from the pinned headers/rows, changes v123 to
`c_average: 735`, `c_votecount: 20`, expects mean 7.35 on 1–10, as-of 2026-10-25, and retains revision 7.
It requires seven-scope native Auth/Access, real bulk-returned identity, statistic PUT and anonymous current GET;
no native votes or Bayesian c_rating. Registration code emits this statistic, but inspection is not a native pass.

- `pinned COPY reaches seven-scope Auth, real Access, public bulk identity and statistic PUT/current GET`
- `reimport and reopen are no-ops; changed native average updates once without native votes`
- `lost committed response retries original bytes and idempotency identity with one effect`
- `zero votes invent neither statistic nor native votes`
- `reduced real Auth scope denies before persistence; revoked grant denies original-bearer receipt replay`
- `source acquisition and mass disappearance failure send no statistic and preserve baseline`

### Import-to-discovery

**Job:** import actual supported provider facts, accept/adopt candidates through ordinary Semantic APIs and discover
those selected facts with traceable work/edition/release identity and source attribution. Search/facets, Collections,
Zones and configured TypeLists must consume the same released meaning.

**Personas:** ordinary importer produces proposals; ordinary editor selects/adopts under current Context authority;
anonymous and editor receive only public facts; Alice and Bob have separate support/state populations. Reduced,
unscoped/delegated, suspended-valid and revoked callers repeat relevant writes and reads. Public consumers cannot
borrow editor/curator private grants. Hidden Concept targets, source fences, aliases with hidden originals and late
revocation must affect positive/negative membership, ordering, counts, cursors and final disclosure.

**Data:** use the shared released controls above and actual provider mappings only. Bangumi's current tags/form
mapping is missing; VNDB's current names/links do not establish platform/form; Open Library work/edition proposals
and Wikidata supported vocabulary do not establish a released cross-surface population. Imports owns mapping and
native transport; Semantic owns shared fixture construction, property releases, Concept receipts, selection/adoption
and identity. Search owns indexing/facets/query admission, Commerce common Collection and owner-query consumers,
Semantic mounted Zone routing, Content source/media disclosure and Web page/TypeList publication.

**REQUIRED NOT YET FROZEN:** `import-to-discovery` is the report's capability label, not an existing exact native
test title. Each applicable producer-to-consumer cell below needs separately named native scenarios. No composed
suite, wrapper, driver or executable native command currently establishes it; imports owns that missing registration.
A future `services/kernel/test/imports/import-to-discovery.test.ts` and
`bun run --cwd services/kernel check test/imports/import-to-discovery.test.ts` are **pending**, not runnable acceptance.
Reuse existing API/identity/media scenarios above rather than duplicate their covered outcomes.

Required exact query controls, using actual created IDs, not text search:

- Book type AND `schema:wordCount` range `gte: 1000001`, unit `1`: exactly `{B-long}`.
- Book type AND released `FORM in [LN]` AND `schema:keywords in [HAREM]`:
  exactly `{B-long, B-edge, B-characters}`; conjoin the range for exactly `{B-long}`.
- Recipe type AND released vegetarian diet Concept AND cookTime `lte: 30` in the released minute unit:
  exactly `{R-quick, R-edge, R-cooked, R-other-cooked}`. Editorial controls, not imported recipes.
- Platform plus language/date qualifiers must match one release statement; Switch+English cannot combine the
  Switch/Japanese and PC/English statements. Work-level platform union cannot invent a release tuple.

Native search uses `POST /v1/subjects:search` and `/v1/subjects:facets`, including facet values beyond previews.
Collection consumers must use the adopted common members schema, not invent a route or adapter.
The report's owner completion wire form remains Commerce-owned missing adoption; “not cooked” is not a public NOT
on private state or a recipe switch. This inventory does not freeze its proposed session interpretation.

### Cover-native-recovery

**Job:** interrupt a real importer/SQLite run after a native acknowledgement and before local completion, reopen the
same run, recover exactly once, then replace the provider cover. Anonymous subject/media/page reads disclose the
right old and replacement cover with source attribution and separate original rights, never a source hotlink.

**Personas:** ordinary scoped importer; editor/adopter; public reader; owner and other-owner list/page consumers;
reduced/unscoped/delegated actors, valid suspended bearer and revoked/invalid credential. Current container authority
and cover-tuple fences govern downloads even when media is available; current bans beat independent grants.

**Actual local evidence by inspection, not executed here:**
[deferred-cover-recovery.test.ts](../../services/importer/tests/deferred-cover-recovery.test.ts) opens/reopens real
SQLite with Importer, ImportSession, RunStore and RecordBindings. Its generated exact titles are:

- `deferred cover survives normal and same-input replay`
- `deferred cover survives before acknowledgement and same-input replay`
- `deferred cover survives after acknowledgement and same-input replay`
- `deferred cover survives changed after acknowledgement and same-input replay`

It checks durable receipt/candidate identity, no duplicate proposal/retraction and retained deferred cover across
reopen; its transport receipts and media availability are fake. Its local command is
`bun test services/importer/tests/deferred-cover-recovery.test.ts`; execution would prove local recovery only.
[Extra local regression](../../services/importer/tests/deferred-cover-recovery-extra.test.ts),
`acknowledged cover survives partial success across reopen`, has the same native-integration limit.
The real API uncertainty scenario covers lost bootstrap response, not this deferred-cover crash/replacement chain.
Native media event replay/object-store recovery below likewise does not establish importer SQLite recovery.

**Frozen native composition:**
[wrapper](../../services/kernel/test/imports/cover-native-recovery.test.ts) and
[fixture](../../services/kernel/test/imports/cover-native-recovery-fixture.ts) use `openApiRuntime`,
`openApiObserver`, real Importer/ImportSession and `createMediaResolver` over public transport, native receipts,
reserved/available media and registered content jobs. Exact scenario names:

- `native new-cover acknowledgement survives interruption before local deferred completion`
- `native changed-cover acknowledgement survives interruption and subsequent replacement remains correctly credited`
- `a fenced cover during native recovery is never restored while adjacent unfenced facts remain readable`

Command: `bun run --cwd services/kernel check test/imports/cover-native-recovery.test.ts`.
Executed at `facb2d0b1d7431227815e423f7e3c10eeba694bb`: **3 pass, 0 fail, 326 expect() calls**, no skips/todos.
This preserves genuine passes of the repaired coordinator; it is not a whole-capability or promotion result.
[Execution evidence and limitations](../research/imports-audit/cover-native-recovery.md) distinguish native results
from this report's acceptance and promotion. The producer boundary is the real Bangumi converter, native media
reservation/jobs and successful public proposal ACK before local deferred completion; no fixture release is invented.
Replacement selects actual candidates through the editor API; public subject, available-variant download and
`/v1/pages:read` are the covered consumers when reached. Distinct replacement-pixel delivery needs the minimal
external-source fixture seam recorded in the report; normal source URLs currently share deterministic PNG bytes.

Imports owns crash/run composition; Content owns fetch/jobs/media/rights and final download authority; Semantic
owns selection and source-record metadata. General source-record attribution/licence production is a separate
pending Semantic producer: a source URL is not that effect and this suite creates no substitute ABI or I2 pass.
Catalogue/list consumers, mounted Zones, configured TypeLists and Web served publication remain missing cross-owner
proof; passing this slice cannot close I1, the whole capability, main acceptance or promotion.

### Existing native media slices for import and recovery

Source: [imports-media-boundary.test.ts](../../specs/imports-media-boundary.test.ts). Exact existing scenario titles:

- `registered content jobs fetch encoded source bytes and publish actual Sharp derivatives`
- `cover credit stays structured and unknown independently of catalogue metadata CC licensing`
- `duplicate native event delivery uses one workflow identity and one committed effect`
- `native Open Library source host uses the same registered content boundary`
- `redirect to an unconfigured host rejects without an available media ID`
- `redirect to private IP rejects through the production URL checks`
- `a fourth redirect rejects at the production redirect cap`
- `streamed source bytes beyond 20 MiB reject without trusting content length`
- `the production source deadline rejects a stalled external response`
- `Sharp rejects encoded input above 40 megapixels`
- `Sharp rejects corrupt encoded image data`
- `unconfigured source hosts are rejected before any source HTTP request`
- `object-store failure leaves actual recoverable state and retries registered work`
- `cancelled bounded drain leaves a real reservation recoverable by registered jobs`

Content's [imported-field suite](../../specs/imported-field-outcomes.test.ts), through its native wrapper above,
also retains these exact relevant frozen scenarios:

- `source documents fence race and imported cover API outcomes remain red without implementation`
- `tuple fence read and governance use protected grants scopes trusted time and one stable home`
- `unchanged receipt and changed refresh recheck fence before body with no new effect`
- `fence after preparation hides final disclosure and exact bytes through projection replay and merge`
- `ordinary bulk bearer imports real reencoded cover bytes and claims within semantic transaction`
- `URL policy caps and invalid image rejection purge samples durably without fabricated media states`
- `denied invalid and aborted semantic cover commands leak no claim`
- `current container and tuple rights fence guard every cover download and refresh cannot restore it`
- `actual checkGrowth observes bounded source tuple and document accesses`

## Explicit surface obligations

Every cell applies to the produced catalogue abstraction; “missing” names missing composed acceptance, not a
missing basic CRUD API. Imports owns the end-to-end import journey; named collaborators own their boundary.
Pipeline conversion and provider-library export produce proposals/assets and have no personal-list write operation:
no state, label, holding or library membership is created merely by importing. That precise non-operation does not
remove the Everything/state/curated/Zone/TypeList consumer obligations below. Personal-library migration is outside
[first public scope](../scope.md).

| Capability                       | Catalogue                                                                                                                                            | Curated                                                                                                                                         | Everything without state                                                                                                                                    | Own state                                                                                                              | Mounted Zone                                                                                                              | TypeList                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary provider import/refresh | Applicable producer: four-source native batch/subject reads registered; anonymous semantic discovery closure missing, imports/semantic/search        | Applicable consumer: imported/adopted facts and refreshed fences; composed case missing, commerce/imports                                       | No independent import list write; consume adopted subjects supported by own labels/holdings without fabricated state; missing, commerce/import-to-discovery | No independent import state write; consume only own accepted state intersection; missing, commerce/import-to-discovery | Applicable common imported subject/media consumer after mount/scope selection; missing, semantic/import-to-discovery      | Applicable configured list and factual projection of imported selected data; missing, web/semantic/import-to-discovery                                |
| Import-to-discovery              | Applicable exact range, form/tag, conjunction and same-statement release qualifiers plus facets/source attribution; missing, imports/search/semantic | Applicable same predicates over eligible source, canonical browsing while occurrence editor preserves duplicate notes; missing, commerce/search | Applicable predicate intersect own support union, label/holding-only subject included with no entry; missing, commerce                                      | Applicable same predicate intersect selected own accepted state, Bob irrelevant; missing, commerce                     | Applicable same predicate over eligible union of mount/scope, canonical deduplication/all pages; missing, semantic/search | Applicable configured list returns same exact IDs; detail projects actual facts/units/identity, not arbitrary detail filtering; missing, semantic/web |
| Cover-native-recovery            | Native subject/media recovery scenarios registered; executed slice in report; catalogue/discovery matrix missing, imports/content/semantic           | Applicable common-media consumer shows recovered/replaced permitted cover and rights; missing composed case, commerce/content/web               | No importer list write; own supported subjects render recovered cover with current disclosure, missing, commerce/content/web                                | No importer state write; own state-selected subjects use same media/rights, missing, commerce/content/web              | Native subject page-read asserted separately; mounted Zone media/fence propagation still missing, semantic/content/web    | Native subject page-read registered; configured TypeList rows and web common-cover publication still missing, semantic/content/web                    |

All applicable list cells require public/unlisted/private source controls where supported, owner/other-owner
isolation, unknown evidence, alias/original identity, hidden source/subject/Concept, source revocation, sparse/deep
pages and cursor reauthorization. A successful page is full or genuinely exhausted; otherwise explicit preparation
with finite retained progress is required. Empty-success cursor chains do not establish acceptance.
For form/tag with limit 2, two admitted IDs fill the first page, one exhausts the second, with no repeats.
Public output never reads Alice's private completion history; permitted private hydration is owner-specific.

## Missing closure and owner reconciliation

- **Semantic:** deliver shared released-data native builder, actual property/profile releases and Concept receipts;
  select the released form key; ordinary selection/adoption and native work/edition/release identity. Definition
  inventory alone is insufficient. Imports separately maintains pinned native Bangumi metadata input and mappings.
- **Search:** consume adopted provider facts and shared released controls through normal search/facets and common
  list predicates, preserving same-statement qualifiers, unknown evidence and current privacy/readiness.
- **Commerce:** own support/state intersections, common Collection query, occurrence versus canonical semantics,
  owner-query schema and library/ItemList export consumers. No imported catalogue fact fabricates personal state.
- **Content:** native cover fetch/reencode/receipt/rights/fences and source withdrawal; join with importer crash
  recovery. Media availability is separate from authorization. Metadata CC licensing never licenses the cover.
- **Web:** actual served subject/page/TypeList and common-media consumers; a serializer or fake client is not HTTP
  publication. Reuse backend evidence and add only the missing publication journey.
- **Accounts with imports/content/search/commerce:** new valid suspended-bearer cases require `403 account_suspended`;
  revoked/invalid credentials are separate. Frozen scenarios expecting `401 invalid_credentials` for suspension
  need owner reconciliation, not edits here. Reduced/unscoped/delegated and late revoked authority cannot disclose
  receipts or protected facts. A ban beats independent grants; the report's earlier unresolved precedence note is
  not authority to bypass the current contract. Missing composed variants remain owner work.
- **Commerce/search/performance:** the existing frozen dynamic scenario
  `bounded Collection filters advance opaque prefixes through hidden and filtered candidates without joins` in
  [dynamic-collections-outcomes.test.ts](../../specs/dynamic-collections-outcomes.test.ts) expects empty successful
  continuation, conflicting with the useful-page contract. Owners reconcile through acceptance ownership; preserve
  frozen bytes and do not bless that behaviour in new scenarios.

This manifest deliberately leaves native passes and promotion unclaimed. Existing frozen scenarios are reused;
missing released fixtures, bindings, commands and composed cases stay explicit owner obligations.
