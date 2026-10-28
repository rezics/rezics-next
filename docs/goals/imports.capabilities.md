# Imports capability acceptance manifest

This is the workflow inventory for [Imports](imports.md), applying the adopted
[API acceptance gaps decision](../research/api-acceptance-gaps.md#workflow-change-the-manager-can-adopt).
It adds no product authority, runtime adapter or definition switch. Behaviour remains with the
[conversion](../../packages/conversion/README.md), [importer](../../services/importer/README.md),
[Semantic](../../services/kernel/src/semantic/README.md), [Content](../../services/kernel/src/content/README.md)
and [filtered-list](../filtered-lists.md) contracts.

Source inspection baseline for this refresh: `2eb8bf31c4313bccc8ec27b92cf92a6e67d19c4e`.
Recorded executions below retain their own revisions and bytes; they were not rerun for this inventory.
No product suites were run for this inventory. The manifest's acceptance is
`node_modules/.bin/oxfmt --check docs/goals/imports.capabilities.md`; it proves formatting/delivery only.
Missing acceptance below stays owned work, not a claim that a required capability is unsupported forever.

## Evidence stages

| Capability                       | Specification validated red                                                                                                   | Native driver registered                                                     | Implementation exposed                                                                                                            | User-case pass at named revision                                                                    | Promoted                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Ordinary provider import/refresh | Existing executable suites; API fixture README records historical missing-driver red evidence, not revalidated here           | API, identity and media wrappers registered; VNDB statistics remains unbound | Ordinary batch, fence, subject/candidate, media and statistic routes visible in source; complete composed job not established     | Four selected-read cases pass in the environment-qualified discovery run; complete refresh job open | Missing: imports promotion evidence |
| Import-to-discovery              | 13 independent native cases delivered; seven recorded native reds, not missing-driver errors; remaining matrix not yet frozen | Actual discovery suite/helper registered; command and bytes below            | Four provider Context-selected reads exposed; bundled words and sourceRecords absent; production Search lifecycle/binding missing | Environment-qualified 6 pass / 7 fail; no full discovery pass                                       | Missing: imports promotion evidence |
| Cover-native-recovery            | Three native crash/replacement/fence scenarios frozen; local regressions retained                                             | Native composition registered; see execution evidence below                  | Actual receipt/media/SQLite and subject/page/download assertions; consumer matrix remains open                                    | 3 native cases pass at recorded revision; whole capability open                                     | Missing: imports promotion evidence |

“Specification validated red” requires recorded failing execution; distinguish missing binding from native product red.
File presence alone does not earn it.
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
These released schemas are not delivered runtime subject populations. The actual version **1** factory is
[`createReleasedDiscoveryFixture({version:1})`](../../services/kernel/test/support/released-discovery.ts),
introduced at `f3d11d3f95fc5bbb4062f29c7e7b4b48b91afe60`, with its
[closed interface and prerequisites](../../packages/definitions/src/released-discovery-fixtures.md).
It uses native Auth/Access, republishes the identical bundled release, creates real identities and returns actual
candidate/acceptance/adoption/revision/release receipts when admission succeeds. It is not wholly absent.
Its link projection drain proves neither Search indexing nor readiness; this inspected factory still lacks the
production Search lifecycle/binding. Prerequisite descriptors do not create runtime data.

| Required fixture/data                     | Actual delivery and missing closure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Owner                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Genuine words                             | Bundled `schema:wordCount` remains absent. Required nonnegative integer quantity, unit `1`, Book facet. Current builder amounts are controlled editorial assertions, not genuine measurements; holder/text/version/language/method/scope/provenance association remains missing                                                                                                                                                                                                                                                                                  | Semantic release/measurement producer; imports reviewed mappings                   |
| Book range controls                       | Builder specifies `B-long` 1,200,001, `B-edge` 1,000,000, `B-short` 999,999, `B-unknown` absent and `B-characters` without words. Six discovery consumers fail actual word admission before enumeration. Separate character 1,400,000 producer and crossed/unknown measurement controls remain missing; edition pages never fill work words                                                                                                                                                                                                                      | Semantic shared builder/definitions                                                |
| Form/tag controls                         | Actual builder creates public scheme/Concept receipts and selects `FORM = wdt:P7937`, `LN`/`HAREM` actual created IDs. `B-long`/`B-edge`/`B-characters` both; `B-short` form only; `B-unknown` harem/unknown form; alternate-form `B-tag-only`; `B-form-only` no harem. Complete Book group/discovery still fails word admission; logical names are never IDs                                                                                                                                                                                                    | Semantic definitions/Concept receipts; imports reviewed bindings                   |
| Recipe controls, separate editorial input | Factory has diet/recipe producers; bundled `schema:suitableForDiet` remains absent. Require authored `R-quick` vegetarian/25, `R-edge`/30, `R-slow`/31, `R-meat` nonvegetarian/20, `R-unknown` unknown diet/20, `R-cooked`/20 Alice-completed and `R-other-cooked`/20 Bob-only completed. Registration is not successful native population                                                                                                                                                                                                                       | Semantic editorial/release data; commerce completion facts                         |
| Platform release qualifiers               | gamePlatform is released; shared platform field is a prerequisite descriptor. [Statement-grain proposal and two frozen native producer cases](../../services/kernel/src/semantic/platform-tuple-contract.md#frozen-api-evidence-and-pending-consumers) now exist. Qualifier release admission, string-filter adoption and actual consumer results remain missing. Switch/Japanese and PC/English must not imply Switch/English                                                                                                                                   | Semantic definitions/producer; imports mappings; Search consumers                  |
| Personal/source/privacy controls          | Bundled libraryProfiles and type bindings now exist; this does not supply historical accepting releases or native consumers. [Registered Library population extension](../../services/kernel/test/library/support/released-library-population.md) and [helper](../../services/kernel/test/library/support/released-library-population.ts) name state/label/session/holding and curated controls. No native pass is credited here. Empty shell, read-only bearer, historical profiles, published dynamic/Zone and privacy producers remain explicit prerequisites | Commerce population; Semantic profiles/Zone; Accounts authority; Search disclosure |

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
The API populations above are controlled native-format inputs, separate from the registered shared released-data
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

**Delivered registration and recorded result:** the actual suite is
[discovery-user-cases.test.ts](../../services/kernel/test/imports/discovery-user-cases.test.ts), with
[discovery-user-cases-fixture.ts](../../services/kernel/test/imports/discovery-user-cases-fixture.ts) and its
[complete report](../research/imports-audit/discovery-user-cases.md#verification-and-cost).
`import-to-discovery` remains the parent capability label, not an exact test title or a second filename.
The delivered acceptance has **13 independent cases, 6 pass, 7 fail, zero skips/todos**, exit **1**, recorded
against base `c0c82dea99af6067464fafc403614d6acb43ebac` plus these delivered bytes (unchanged in this checkout):

- Test SHA-256: `98638edc178257c3e012a3ba7fd8d08def2ab4ec81041288801c95b0d8cb1362`.
- Helper SHA-256: `c1e429a477868248b42d724ad639ef689950c91b6c91590ca5b9524ac839c382`.

Actual recorded commands:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/discovery-user-cases.test.ts
bun scripts/worker-check.ts -- bun scripts/typecheck.ts
bun scripts/worker-check.ts -- test -s docs/research/imports-audit/discovery-user-cases.md
```

The report records native exit 1 in
`.temp/goal/checks/worker-check-2026-10-28T18-29-18.213Z-affc4401.log` and root typecheck exit 0 in
`.temp/goal/checks/worker-check-2026-10-28T18-35-49.703Z-bce10ddf.log`; its file-presence command establishes
documentation only. Native results are **environment-qualified**: the inspected helper overrides
`TMPDIR` to worktree `.temp/import-discovery` on Btrfs while opening the runtime, then restores it. A fixture
correction is queued separately. Neither corrected helper bytes nor a corrected execution report are present here;
no corrected passing result is inferred or rerun. Cover recovery instead uses `mkdtemp(join(tmpdir(), ...))`
without that override.

The exact native titles and recorded outcomes are:

| Exact scenario                                                                                                        | Recorded outcome                          |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `catalogue words strictly over one million returns only B-long`                                                       | Fail: word admission                      |
| `catalogue released light-novel form AND harem returns exactly three books`                                           | Fail: word admission                      |
| `catalogue conjunction of words and released form AND harem returns only B-long`                                      | Fail: word admission                      |
| `catalogue harem facet counts only the exact selected three-book conjunction`                                         | Fail: word admission                      |
| `readable Book detail retains selected word amounts and unit without edition page inference`                          | Fail: word admission                      |
| `readable Book detail projects actual adopted light-novel and source-scoped harem Concept IDs`                        | Fail: word admission                      |
| `bangumi ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`         | Pass, environment-qualified               |
| `vndb ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`            | Pass, environment-qualified               |
| `openlibrary ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`     | Pass, environment-qualified               |
| `wikidata ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`        | Pass, environment-qualified               |
| `Open Library edition keeps unsupported pages unknown and language separate from work identity and absent work words` | Pass, environment-qualified               |
| `Bangumi observed manga meta_tags and ordinary novel tags never imply light novel or imported words`                  | Pass, environment-qualified               |
| `imported selected metadata public read exposes sourceRecords without inventing unknown registration metadata`        | Fail: expected `[]`, received `undefined` |

All six Book cases encounter `Propose schema:wordCount ... expected HTTP 201, observed 400`, problem
`invalid_request`, `effect_status:not_applied`, pointer `/statement/property/id`, code `unsupported`, before
query enumeration. These are native admission reds, not six query passes or thirteen native passes.
The four provider passes accept/adopt only actual importer candidates in a real community Context and read
anonymously with that selected Context. Supported title/language/external-ID facts and citations survive;
this is neither Global adoption nor Global Search indexing. The observer's fallback-authoring `adopt` helper
is deliberately unused. Native Auth hosts are closed between the released and importer groups.

The Open Library edition is a separate `bf:Instance`; unsupported native `number_of_pages` stays unknown.
The runtime lacks `identifierLookup`, so its `schema:exampleOfWork` candidate remains `somevalue`, never a
client-injected work ID. Bangumi observed manga metadata and separate ordinary novel-tag controls establish
non-inference only. No imported genuine words, resolved four-provider release identities, reviewed classification
mapping or complete import-to-discovery capability is established.

[Source record attribution](../../services/kernel/src/semantic/source-record-attribution-contract.md) now owns
the closed metadata specification and `GET /v1/subjects/{id}` → `subject.sourceRecords` projection. Its native
storage, write/read exports, mounted operation and generated typed consumer schema remain producer obligations;
contract closure is not an implemented producer. Registration aliases supply no general display metadata.
The recorded unknown-array failure is not positive attribution. Imports still needs a distinct journalled
current-run metadata step before bound/unchanged shortcuts after the actual producer exists. No speculative
operation or writer is called by this suite. Facts rights, summary rights and cover credit stay separate.

**Remaining matrix:** all following cells are required, **NOT YET FROZEN** for this discovery journey, and cannot
be discharged by registering the Library extension or by the six narrow selected-read passes.

| Job                   | Public curated       | Everything without state | Own state              | Mounted public Zone       | Configured Book TypeList |
| --------------------- | -------------------- | ------------------------ | ---------------------- | ------------------------- | ------------------------ |
| Words >1000000        | `curated-words`      | `everything-words`       | `own-state-words`      | `mounted-zone-words`      | `type-list-words`        |
| Light novel AND harem | `curated-form-harem` | `everything-form-harem`  | `own-state-form-harem` | `mounted-zone-form-harem` | `type-list-form-harem`   |
| Conjunction           | `curated-combined`   | `everything-combined`    | `own-state-combined`   | `mounted-zone-combined`   | `type-list-combined`     |

Additional exact still-missing discovery scenarios from the report:

- Semantic measurements: `words-measured-statement`, `words-character-control`, `words-crossed-evidence`.
  Amount-only editorial controls do not prove genuine same-statement measurement or a character producer.
- Imports/Semantic mappings: `bangumi-meta-tags-selected-discovery`, `reviewed-form-selected-discovery`,
  `reviewed-platform-selected-discovery`, `four-provider-resolved-work-edition-release`.
- Platform consumers: `platform-release-same-statement`, `platform-false-Cartesian-control` on Search, curated,
  Everything, own state, mounted Zone and detail/TypeList. The newer frozen producer cases above do not execute
  Search or complete these cells; string qualifier admission still needs its owner.
- Metadata: `selected-native-source-attribution-positive`, requiring actual producer receipts/exports.
- Disclosure: `query-withheld-harem-positive`, `query-withheld-harem-NOT`, `query-withheld-order-count-cursor`,
  `mounted-withheld-original`, `query-foreign-source-fence`, `query-withdrawn-consent`,
  `query-final-disclosure-revocation`, independently on every applicable surface, including paused-index final
  barriers, hidden targets/originals, revoked/delegated authority and real foreign repair acknowledgements.

The actual Zone boundaries are `POST /v1/zones/{id}:readPage` and `GET /v1/zones/{id}/subjects`, with their owned
common-page and `{subjects,next}` DTOs. Configured TypeList evidence must use its configured page read, installed
profile/template, route and actual preparation; there is no invented TypeList endpoint. Public curated occurrence
notes/duplicates/alias, owner support intersections, published dynamic generations, overlapping Zone mount/scope,
source lifecycle and configured consumer execution remain open until actual native receipts and results exist.

Required exact query controls, using actual created IDs, not text search:

- Book type AND `schema:wordCount` range `gte: 1000001`, unit `1`: exactly `{B-long}`.
- Book type AND released `FORM in [LN]` AND `schema:keywords in [HAREM]`:
  exactly `{B-long, B-edge, B-characters}`; conjoin the range for exactly `{B-long}`.
- Recipe type AND released vegetarian diet Concept AND cookTime `lte: 30` in the released minute unit:
  exactly `{R-quick, R-edge, R-cooked, R-other-cooked}`. Editorial controls, not imported recipes.
- Platform plus language qualifiers must match one statement on an actual release; Switch+English cannot combine
  the Switch/Japanese and PC/English statements. Under the newer statement-grain proposal, `schema:datePublished`
  stays at release grain, not an invented date qualifier. Work-level platform union cannot invent a release tuple.

Native search uses `POST /v1/subjects:search` and `/v1/subjects:facets`, including facet values beyond previews.
Collection consumers must use the adopted common members schema, not invent a route or adapter.
The [approved owner-query wire](../library-owner-queries.md#closed-additive-wire) supersedes the report's missing
adoption note. Semantic owns the shared grammar producer; typed schema and downstream Commerce/Search consumers
remain required. The inspected [FilterDocument/parser](../../packages/filter/src/filter.ts) has no owner leaf or
`allowOwner` option. Do not guess an alternative wire. The approved Recipe template uses viewer-self presence plus
NOT completed session with actual accepting `profileId`, over Alice's admitted support union; it requires exactly
`{R-quick, R-edge, R-other-cooked}`. State clear preserves history and Bob's completion is irrelevant. This is not
public private-state inference. Registered population setup does not prove that query executes.

Recipe diet/time and owner-not-cooked jobs still require Search admission/anonymous owner denial, curated,
Everything, own-state, mounted public/private isolation and configured Recipe TypeList/detail cells from the
[original matrix](../research/api-acceptance-gaps.md#required-cross-surface-expansion). Each remains independently
required; public results never read Alice's history. Detail must disclose actual authored instructions, diet and
time; export conversion to `PT25M` is separate publication evidence.

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
The separate optional distinct-encoded-image fixture work is registered, but the inspected
[MediaBoundary.source](../../services/kernel/test/imports/media-boundary.ts) still accepts only URL/fault and emits
its normal deterministic PNG. Registration supplies neither distinct pixels nor a broader consumer case.

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

| Capability                       | Catalogue                                                                                                                                                                         | Curated                                                                                                                                         | Everything without state                                                                                                                                    | Own state                                                                                                              | Mounted Zone                                                                                                              | TypeList                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary provider import/refresh | Applicable producer: four Context-selected importer/editor/anonymous reads passed, environment-qualified; Global/search and full refresh closure missing, imports/semantic/search | Applicable consumer: imported/adopted facts and refreshed fences; composed case missing, commerce/imports                                       | No independent import list write; consume adopted subjects supported by own labels/holdings without fabricated state; missing, commerce/import-to-discovery | No independent import state write; consume only own accepted state intersection; missing, commerce/import-to-discovery | Applicable common imported subject/media consumer after mount/scope selection; missing, semantic/import-to-discovery      | Applicable configured list and factual projection of imported selected data; missing, web/semantic/import-to-discovery                                |
| Import-to-discovery              | Six Book consumers native red at word admission; unknown sourceRecords read red; same-statement qualifiers and positive attribution still missing, imports/search/semantic        | Applicable same predicates over eligible source, canonical browsing while occurrence editor preserves duplicate notes; missing, commerce/search | Applicable predicate intersect own support union, label/holding-only subject included with no entry; missing, commerce                                      | Applicable same predicate intersect selected own accepted state, Bob irrelevant; missing, commerce                     | Applicable same predicate over eligible union of mount/scope, canonical deduplication/all pages; missing, semantic/search | Applicable configured list returns same exact IDs; detail projects actual facts/units/identity, not arbitrary detail filtering; missing, semantic/web |
| Cover-native-recovery            | Native subject/media recovery scenarios registered; executed slice in report; catalogue/discovery matrix missing, imports/content/semantic                                        | Applicable common-media consumer shows recovered/replaced permitted cover and rights; missing composed case, commerce/content/web               | No importer list write; own supported subjects render recovered cover with current disclosure, missing, commerce/content/web                                | No importer state write; own state-selected subjects use same media/rights, missing, commerce/content/web              | Native subject page-read asserted separately; mounted Zone media/fence propagation still missing, semantic/content/web    | Native subject page-read registered; configured TypeList rows and web common-cover publication still missing, semantic/content/web                    |

All applicable list cells require public/unlisted/private source controls where supported, owner/other-owner
isolation, unknown evidence, alias/original identity, hidden source/subject/Concept, source revocation, sparse/deep
pages and cursor reauthorization. A successful page is full or genuinely exhausted; otherwise explicit preparation
with finite retained progress is required. Empty-success cursor chains do not establish acceptance.
For form/tag with limit 2, two admitted IDs fill the first page, one exhausts the second, with no repeats.
Public output never reads Alice's private completion history; permitted private hydration is owner-specific.

## Missing closure and owner reconciliation

- **Semantic:** extend the delivered version-1 builder with missing bundled word/diet admission, genuine
  measurement/character producers, historical accepting profiles and complete native identity/metadata producers.
  Actual form selection is `wdt:P7937`; definitions/Concept registration alone is insufficient. Imports owns pinned
  native Bangumi metadata input, reviewed mappings and the later journalled metadata step.
- **Search:** consume adopted provider facts and shared released controls through normal search/facets and common
  list predicates, preserving same-statement qualifiers, unknown evidence and current privacy/readiness.
- **Commerce:** own support/state intersections, common Collection query, occurrence versus canonical semantics,
  approved owner-query execution and library/ItemList export consumers. No imported catalogue fact fabricates personal state.
- **Content:** native cover fetch/reencode/receipt/rights/fences and source withdrawal; join with importer crash
  recovery. Media availability is separate from authorization. Metadata CC licensing never licenses the cover.
- **Web:** actual served subject/page/TypeList and common-media consumers; a serializer or fake client is not HTTP
  publication. Reuse backend evidence and add only the missing publication journey.
- **Accounts with imports/content/search/commerce:** retain distinct revoked/invalid and suspension controls.
  The newer [owner-query admission contract](../library-owner-queries.md#viewer-self-binding-and-admission)
  specifies native suspension revoking existing bearers (`401 invalid_credentials`), correct-password suspended
  sign-in `403 ACCOUNT_SUSPENDED`, and supersedes hypothetical valid-suspended `403 account_suspended` wording
  in older list documents. The fixture's revoked pre-suspension bearer proves no valid-suspended case. Preserve
  frozen bytes and reconcile the report/fixture's older prerequisite through owning acceptance; do not fabricate
  credentials or call it a pass. Reduced/unscoped/delegated and late revoked authority cannot disclose receipts
  or protected facts. A ban beats independent grants. Missing composed authority variants remain owner work.
- **Commerce/search/performance:** the existing frozen dynamic scenario
  `bounded Collection filters advance opaque prefixes through hidden and filtered candidates without joins` in
  [dynamic-collections-outcomes.test.ts](../../specs/dynamic-collections-outcomes.test.ts) expects empty successful
  continuation, conflicting with the useful-page contract. Owners reconcile through acceptance ownership; preserve
  frozen bytes and do not bless that behaviour in new scenarios.

This refresh advances discovery registration/exposure and records its environment-qualified six passes/seven reds;
cover recovery retains its three recorded native passes. Neither parent capability nor promotion is established.
No acceptance bytes or product behaviour changed. Only this manifest's scoped formatter is run here; no new test,
root typecheck, product suite, whole-kernel check or root gate is part of this documentation acceptance.
