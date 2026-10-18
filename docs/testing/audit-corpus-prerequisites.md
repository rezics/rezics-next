# Audit corpus consumer prerequisites

This is the stack-free triage required by the 2026-10-18T21:42:18Z decision.
It describes the current wave consumers and their actual parsers, rather than
certifying a prepared corpus. No preparation, owner startup, import, backup,
restore, baseline or fixed proof ran during this continuation. No ready recipe,
qualified source collection or compatible backup was supplied in this worktree.
Product assertion reach in this continuation is **unexecuted** for every corpus
consumer. Historical setup failures below retain their original product pins.

The [shared contract](../../tests/qa/fixtures/audit-corpus-contract.ts) registers
18 prove files and eight projections. The
[producer procedure](audit-corpus.md) remains the only preparation lifecycle.
The tables below identify requirements, not a second manifest format or seeds.
An unavailable command, source or readiness predicate has no successful binding
and cannot publish a ready manifest.

## Existing manifests and readiness

All paths are relative to the assigned worktree. Private manifests and receipts
remain mode 0600. External restores must finish before the consumer hook; consumer
restores each open their own writable copy of the same stopped cut.

| Consumer and existing parser | Manifest and schema | Required preparation/readiness stage | Genuine receipts and owner prerequisites |
| --- | --- | --- | --- |
| Imports: [openImportFixture](../../tests/qa/support/import-outcomes.ts) | `.temp/audit-corpus/imports.json`, or `REZICS_IMPORT_OUTCOME_FIXTURE`; `import-outcomes-corpus-v1` | External isolated restore; matching `REZICS_QA_RUN_ID`, fixture root, current product revision and independent matrix digest; frozen `sourceRoot`; source intake parts reconstruct the original provider bytes. Both named selections have replay commands with returned identity pointers. | Original resource/mainVersion/revision bindings, real observation/conversion/proposal identities and bytes, retained import mandate/grants, exact command bodies/keys/statuses. Refresh needs different base/candidate conversions and real old/new generations plus the unexecuted application command. See I, M, A and B below. Proposed release/coverage results are assertions, not successful-setup prerequisites. |
| Context: [contextHarness](../../tests/qa/support/context-outcomes.ts) | `.temp/qa-context-outcomes/{runId}/restored.json`; `restored-context-outcomes-v1` containing `context-outcomes-fixture-v1` | External restore with source key, backup digest, positive build/restore times within 600 s, smoke and actual pristine product/test overlay. Verify the checksummed command ledger and retained personas before any query under proof. | Exact occurrence/revision/DefinitionRef/roles/participations, source citations and qualifiers for all 13 appearance controls, overflow 65, every credit role, inverse controls and the public tail after more than 800 hidden occurrences. History requires distinct current/prior exact occurrences and real source-position, model and restore-generation snapshots. See M, A and B. The finite `catalogueWorks` query scope (at most 64) is separate from the full preserved ledger of 113 originals. |
| Releases: [openReleaseMediaFixture](../../tests/qa/integration/support/catalogue-release-media.ts) | `.temp/qa-fixtures/catalogue/releases-and-media.json`; `catalogue-release-media-v1`, selection `catalogue-release-media` | External restore; QA run matches; graph, Account, Access, Content, relay and object addresses differ from the source and match the restored environment. Source field pointers and real media bytes verify before proof. | At least VNDB and a second provider; 3–6 releases per catalogue, exact release/realization qualification and four counterexamples. Retained cover/portrait bytes, URL pointer, rights/credit/obligations, dimensions/digests, and missing/acquisition-failed/publication-forbidden controls. Reading binds the exact Work/release/realization/Structure/occurrence/content revision. See R, S, A and B. |
| Information: [loadInformationCorpus / openInformationCorpus](../../tests/qa/integration/support/catalogue-information.ts) | `.temp/fixtures/catalogue-information/corpus.json`, or `REZICS_INFORMATION_CORPUS`; `catalogue-information-corpus-v1` | External restore; stopped backup digest, checksummed command receipts, Account/Access/Content/graph/objects, measured preparation within 600 s. Source pointers validate identity/name and exact values for every record, including successful empty sections. | Fourteen supporting record kinds; eight inverse cases; all coverage/value controls; ordered episode/medium/track occurrences with repeated recording placements; explicit Collection purpose assertions and ordinary membership; hidden controls, non-null public recipe/chapter recovery selectors and exact public/private mutation commands. See I, M, A and B. The [author handoff](../goals/audit-remediation-20261019/information-outcomes.md) keeps proposed display/coverage/purpose/read behavior in the proof. |
| Public domain: [loadPublicDomainCorpus](../../tests/qa/fixtures/catalogue-public-domain.ts), [publicDomainFixture / publishPublicRecipe](../../tests/qa/support/catalogue-public-domain.ts) | `.temp/goal/public-domain-corpus.json`; `catalogue-public-domain-corpus-v1` | Consumer restore through `createCorpusBackupDriver`; all file paths, including backup, must be checkout-relative and contained locally. Original 113 IDs, retained personas, normalized source quotes and digests validate first. Recipe publication must return 201 and a visitor recipe read must return a non-null exact Structure/revision before the proof body. | Real rich/no-nutrition recipes, all required qualified nutrition/substitution cases, real Book description/author, two releases and two meaningful chapters. Ingredient/step/allocation order, exact fractions, positive servings and cooking duration come from retained sources. No nutrients may be invented for missing evidence. See S, R, A and B. |
| Search: existing parser in [search-intent.test.ts](../../tests/qa/integration/outcomes/catalogue/search-intent.test.ts) | `.temp/search-intent/corpus-source.json`, or `REZICS_SEARCH_INTENT_CORPUS`; existing `rezics-retained-source-v1` envelope, key `rs-search-intent-*`, metadata `search-intent-corpus-v1` | Consumer restore; namespace `si` plus eight hexadecimal characters; exactly two public/private realms and all 24 plan keys. Every evidence file is checksummed **single-command JSON** with a successful POST/PUT/PATCH `/v1/` receipt whose answer contains the native ID. | Public visitor read is 200/non-null with frozen name/type/summary/revision pointers; private visitor read is 404 and its owner read is 200; exact public credit name and unknown-resource 404. Native revision may use the parser's admitted native IRI or UUID representation. Actual command IDs and receipt pins use `command:<id>` and `receipt:<id>`, never a JSONL file parsed as JSON. See M, A and B. |
| Identity: [identityReaderFixture](../../tests/qa/support/identity-reader-fixture.ts) | `.temp/identity-reader/corpus.json`; `identity-reader-corpus-v1` | Consumer restore; exact helper recipe digest and storage/load compatibility; retained OAuth/persona sessions and actual alternative Agent for each authenticated persona. Account-only control is created through `prepareEmptyIdentity`, not native identity insertion. | Four distinct Book controls: public with two published exact chapters, empty, private, and published without search eligibility; private successor draft, exact phrase/content bindings and digests. Public publication must succeed before retention. See P, A and B. The helper's missing-manifest fallback is not another authorized corpus producer. |
| Author: [restoreAuthorManagementCorpus](../../tests/qa/support/author-management-fixture.ts) | `.temp/author-management-corpus/retained.json`; `author-management-corpus-v1` | Consumer restore before **each** proof body; exact compatibility digest and three-helper recipe digest; two independent public Realms; anonymous exact chapter and Post reads must be 200. | 23 searchable author Works with stable order/ties and draft/type/foreign/alternate-Agent controls; Book's root Volume and root Part with chapters under Part (depth 2), 23 chapter occurrences; original chapter/Post exact revision, digest, Content epoch/sequence, publication and qualification; independently pinned adoption and reply placements. See P, A and B. The historical stopped-backup failure is retained below. |

## Named consumers and assertion boundary

`p` below means each of `visitor`, `stranger`, `member`, `owner`, `moderator`,
`operator`. For outcome rows the exact title is `row / p: cell.test`, defined by
[outcomeTitle](../../scripts/qa/cases/outcome-cells.ts); the linked declarations
retain each persona's literal suffix. None of those independent assertions or
pending states was changed. A failing expected-failure wrapper is not evidence
that a product assertion was reached.

| Actual prove file | Named cases | Required stage before assertions; reach evidence |
| --- | --- | --- |
| [import-fidelity](../../tests/qa/integration/outcomes/catalogue/import-fidelity.test.ts) | [`catalogue/import-fidelity / p`](../../scripts/qa/cases/outcomes/catalogue/import-fidelity.ts) | `beforeAll` → `openImportFixture`: missing manifest/env, frozen bytes, bindings or source receipts stop setup. Original identity/facts/relations/tags/music assertions and operator replay then run in bodies. Unexecuted here. |
| [source-coverage](../../tests/qa/integration/outcomes/catalogue/source-coverage.test.ts) | [`catalogue/source-coverage / p`](../../scripts/qa/cases/outcomes/catalogue/source-coverage.ts) | Same import setup. Public coverage, operator inventory, source-support withdrawal and atomic refresh remain body assertions. Missing refresh-generation inputs are a premise blocker, not proof of a mixed generation. Unexecuted here. |
| [contextual-associations](../../tests/qa/integration/outcomes/catalogue/contextual-associations.test.ts) | [`catalogue/contextual-associations / p`](../../scripts/qa/cases/outcomes/catalogue/contextual-associations.ts) | `beforeAll` → `contextHarness` requires the restored manifest/ledger. First public subject-associations HTTP 200 is a body assertion, followed by independent occurrence/evidence correlation. Unexecuted here. |
| [credits-and-inverse](../../tests/qa/integration/outcomes/catalogue/credits-and-inverse.test.ts) | [`catalogue/credits-and-inverse / p`](../../scripts/qa/cases/outcomes/catalogue/credits-and-inverse.ts) | Same context hook. First query HTTP 200 is the body boundary; exact credit roles, inverse traversal, sparse tail, cursor binding and obsolete snapshots are subsequent assertions. Unexecuted here. |
| [releases-and-media](../../tests/qa/integration/outcomes/catalogue/releases-and-media.test.ts) | [`catalogue/releases-and-media / p`](../../scripts/qa/cases/outcomes/catalogue/releases-and-media.ts) | `beforeAll` validates the release/media manifest, real field/media evidence and restored personas. Discovery, exact release/realization constraints and media delivery are body assertions. Unexecuted here. |
| [catalogue-discovery-navigation](../../tests/qa/integration/catalogue-discovery-navigation.test.ts) | `catalogue discovery navigation / p: executes advertised methods, profiles and source-neutral query bounds` | Same release manifest hook. Advertised methods/profiles/facets and returned links are exercised in bodies, never readiness oracles. Unexecuted here. |
| [supporting-information](../../tests/qa/integration/outcomes/catalogue/supporting-information.test.ts) | [`catalogue/supporting-information / p`](../../scripts/qa/cases/outcomes/catalogue/supporting-information.ts) | Information load/open in `beforeAll`; source identity/value/section premises precede page/facts/inverse assertions. The author's retained missing-corpus attempt reached no product assertion; no new execution here. |
| [ordered-domain-read](../../tests/qa/integration/outcomes/catalogue/ordered-domain-read.test.ts) | [`catalogue/ordered-domain-read / p`](../../scripts/qa/cases/outcomes/catalogue/ordered-domain-read.ts) | Same information hook; ordered native episode/media/track reads and Collection semantics remain body assertions. No new execution here. |
| [catalogue-partial-read](../../tests/qa/integration/catalogue-partial-read.test.ts) | `p: null, empty, zero, unknown, unmapped and withheld facts remain different`; `p: {person,recipe} keeps known identity and type when only summary/name fails, then recovers`; `p: failed facts keep identity, inverse paths and section href, with bounded retry and recovery`; `p: unavailable {recipe,chapter} keeps the same public Work and successful facts, then retries the same section` | Information load plus `graphFaultProxy` in `beforeAll`; summary/facts selectors must match the actual owner queries. Non-null public recipe/chapter selectors must match the recovery identity. A stale selector is a fixture setup mismatch before the intended partial-read assertion. Unexecuted here. |
| [collection-domain-roles](../../tests/qa/integration/collection-domain-roles.test.ts) | `p: ordinary membership, a book list, recipe selection, series and franchise stay distinct`; `six personas: cursors bind subject, parent and order; private changes preserve them, public changes restart explicitly` | Information hook; exact membership/purpose/order and public/private mutation commands are premises. The mutation body uses only its isolated restore; cursor behavior remains asserted. Unexecuted here. |
| [catalogue-real-book-reading](../../tests/qa/integration/catalogue-real-book-reading.test.ts) | `C28 real public Book / p: understand, choose, read, navigate and return` | `beforeAll` → public-domain load/restore, source oracles and public header smoke; release choice, chapter navigation and own return are body assertions. No corrected-baseline body has run per the author's [handoff](../goals/audit-remediation-20261019/public-domain-outcomes.md). |
| [catalogue-public-recipe](../../tests/qa/integration/catalogue-public-recipe.test.ts) | `C27 public real Recipe / p: ordered cooking, exact scaling and own return` | `beforeAll` restores, publishes the exact recipe, verifies a non-null visitor recipe and adds a private draft. A refusal/null Structure is setup failure before ordered cooking/scaling assertions. No new execution here. |
| [nutrition-and-substitutions](../../tests/qa/integration/outcomes/recipes/nutrition-and-substitutions.test.ts) | [`recipes/nutrition-and-substitutions / p`](../../scripts/qa/cases/outcomes/recipes/nutrition-and-substitutions.ts) | `beforeAll` restores and publishes every distinct qualified/no-nutrition recipe, then adds a private draft. Missing source qualification/publication blocks setup; numeric provenance and exact substitution stay in bodies. No new execution here. |
| [search-intent](../../tests/qa/integration/outcomes/catalogue/search-intent.test.ts) | [`catalogue/search-intent / p`](../../scripts/qa/cases/outcomes/catalogue/search-intent.ts), each executing the retained intent plan | `beforeAll` parses the existing envelope, validates single-command evidence, restores and rechecks all public/private record pointers. Only then do plan queries and executable links assert intent semantics. The author's corrected baseline is not run; no new execution here. |
| [identity-discovery](../../tests/qa/integration/outcomes/realm/identity-discovery.test.ts) | [`realm/identity-discovery / p`](../../scripts/qa/cases/outcomes/realm/identity-discovery.ts); `D4-007 / authenticated empty Account: 200 empty is distinct from sign-out, denial and owner failure`; `D4-007 / insufficient scope and invalid bearer: never replace authenticated refusal with anonymous discovery` | `beforeAll` → `identityReaderFixture`; OAuth callbacks also run before a case's discovery assertions. `reached()` records the actual boundary. Both retained historical runs failed in hooks, with no body assertions. Corrected original baseline is not run. |
| [audit-public-reading](../../tests/qa/integration/audit-public-reading.test.ts) | `D4-008 / p: public Book contents, chapter and default links select the same published bytes`; `D4-008 / p: audited public phrase search and its continuation lead to readable chapters`; `D4-008 / p: empty, private, unpublished and missing reader data remain distinct`; `D4-008 / p: owner failure is unavailable and recovery retains the Book and Account`; `D4-008 / authenticated empty Account: public reading requires no anonymous authority change`; `D4-008 / invalid bearer: {header,contents,chapter,exact,default,search,search-page} returns authentication refusal without anonymous retry` | `beforeAll` restores and logs in every authenticated reader. Exact bytes, phrase results, unavailable reads and Account survival are body assertions. Historical hook failures reached none; corrected original baseline is not run. |
| [studio-inventory](../../tests/qa/integration/outcomes/realm/studio-inventory.test.ts) | [`realm/studio-inventory / p`](../../scripts/qa/cases/outcomes/realm/studio-inventory.ts); `AMGT01 Studio recent created and title sorts are stable across every page`; `AMGT01 Studio continuations bind query sort filters page size and controlled acting Agent`; `AMGT01 Studio counts nested and paginated chapter occurrences without counting groups`; `AMGT01 Studio rejects a continuation whose valid inventory source basis moved` | `AMGT01` → per-body author restore. `AMGT00: retains one command-created author-management corpus` is the legacy preparation case, not an outcome assertion or authorization for another producer. Historical selection/topology/backup failures never reached AMGT01. |
| [published-author-lifecycle](../../tests/qa/integration/outcomes/realm/published-author-lifecycle.test.ts) | [`realm/published-author-lifecycle / p`](../../scripts/qa/cases/outcomes/realm/published-author-lifecycle.ts); `AMGT01 corrected content republishes the same identity with exact publication and qualification heads`; `AMGT01 qualification withdrawal removes only the selected Post publication support and retains author history`; `AMGT01 Structure removal qualification withdrawal and independent Work publication withdrawal have distinct effects`; `AMGT01 owner placement withdrawal preserves another publisher placement and another author reply` | `beforeEach` restores author corpus and verifies exact anonymous Content reads. Original revision/digest/epoch/publication/qualification/placement heads must come from real receipts; correction/withdrawal/replay effects remain body assertions. Historical preparation blocked them; no new execution here. |

## Owner interfaces and executable blocked stages

The existing recipe's `stages[].commands[]` run through
[`AuditRecorder.command`](../../scripts/qa/fixtures/audit-corpus.ts), which retains
the actual caller, body, key, response and time. `requires` orders stages;
unobserved references fail. The same code handles the supported commands below;
there is no ready recipe with invented identities. `inspect` reports missing
inputs/mapper bindings without startup, while preparation refuses the first
unavailable owner operation and retains failed-attempt evidence.

| Key | Existing owning interface | Needed command/receipt and precise unresolved prerequisite |
| --- | --- | --- |
| I | [selectDatasetRoots](../../scripts/datasets/selection.ts), [importDataset / DatasetImportOptions](../../scripts/datasets/import.ts), [import author handoff](../goals/audit-remediation-20261019/import-corpus-handoff.md) | Selector produces `DatasetRootSelection` over the immutable parent. Import options currently expose `maxRecords`, not a selected-parent contract. Producer's `auditSelectionIsWholeSnapshot` refuses bounded selections rather than replacing indexes/digests. Owner must admit that interface and return real journal/coverage/native bindings. Public stage commands remain `POST /v1/sources/intakes`, `POST /v1/sources/observations/{observation}/conversions`, `POST /v1/sources/conversions/{conversion}/source-graph`, proposal and native-work adoption, with supported provider mappings. A Bangumi-only conversion cannot qualify VNDB/MusicBrainz. Refresh old/new generations must be supplied by the owning contract; do not execute the application under proof to guess them. |
| M | [projectDatasetFields](../../scripts/datasets/native/fields.ts), [datasetRelationMapper](../../scripts/datasets/native/relations.ts), [datasetCreditMapper](../../scripts/datasets/native/credits.ts), shared [native types](../../scripts/datasets/types.ts) | Field projection is a pure plan, not an acknowledged native mapper. Relations mapper `relations/source-associations-v1` exists and routes classifications/compositions, but unsupported source association dispositions remain explicit. Credits mapper requires a genuine `DatasetCreditAdoptionBinding` per candidate: proposal, conversion, observation, source/native ordinal, expected head, base support and correspondence. It verifies those source-owner receipts before `POST /v1/works/{work}/source-author-credits`; no raw credit fallback. Producer currently registers only the media mapper. Register/adapt other mappers only after these actual inputs and receipt/coverage contracts are available; their existence does not make every source association adopted. |
| R | [datasetReleaseMapper / DatasetReleaseCorrespondence](../../scripts/datasets/native/releases.ts), [datasetMediaMapper](../../scripts/datasets/native/media.ts) | Release mapper requires an acknowledged correspondence containing the exact source reference, Work, native release/projection and realization bindings, verified through existing release/realization GETs. A descriptive PublicationEvent or ordinary release PUT receipt alone cannot supply source adoption/support. Media mapper needs actual retained captured bytes plus source identity and rights; existing image evidence/reservation/upload/selection commands retain their real receipts. Neither mapper may turn unknown coverage into full playable content. |
| S | [AuditEvidence](../../tests/qa/fixtures/audit-corpus-contract.ts), [public-domain source handoff](../goals/audit-remediation-20261019/public-domain-outcomes.md), existing frozen import matrix | Custodians must supply byte-pinned record pointers, qualified public-domain/licensed Book/chapter/Recipe quotes and reviewed nutrition/calculation/author-declared alternative evidence; licensed cover/portrait bytes with original URL pointer, role, credit and obligations. Existing Gutenberg/Open Library captures alone do not qualify all requested cases. `inspect` checks these pins and refuses original prose as public-domain evidence. No acquisition or second source corpus is authorized. |
| A | [retainPersonaRealm / restorePersonaRealms](../../tests/qa/support/personas.ts), [grantFixtureAuthority](../../tests/qa/support/persona-fixture-authority.ts), [prepareEmptyIdentity](../../tests/qa/support/identity-reader-fixture.ts) | Original operator/OAuth bindings must survive the original restore. Supported grants return actual grant/representation IDs; preserve scope/action/lifetime and caller Account/Agent. Account-only signup/verification/sign-in uses the existing fixture stage. Owner/source/platform authority is never inferred from a role label or provisioned with business SQL/RDF. |
| P | [identity createBook](../../tests/qa/support/identity-reader-fixture.ts), [author originalContent / buildAuthorManagementCorpus](../../tests/qa/support/author-management-fixture.ts) | Reuse their supported public Work/composition/chapter/content/publication/qualification/reply stages in the shared recipe. Keep exact Work/Content/Structure/placement heads, digests and source positions. `POST /v1/work-publications` with `work-structure-publication-v1` must yield its genuine 201 decision and visitor exact read readiness. Historical 404 `contribution_unavailable` is an owning publication premise, not authorization to fabricate a decision or duplicate the Work. |
| B | [RetainedSources](../../scripts/qa/retained-source.ts), [retainStoppedOwnerBackup / restoreCatalogueBackup](../../scripts/load/catalogue-backup.ts), producer `liveAuditRuntime` | Original 113-binding ledger/backup and baseline-compatible owner restore are absent inputs. After all supported preparation/readiness succeeds, use one stopped all-owner cut (`purpose: corpus`, `resumeSource: false`, `stopCorpusSourcePostgres`), then a measured compatible round trip. Do not bypass physical shutdown certification after the retained 30 s `pg_controldata` failure. Storage owner must establish the supported certifier prerequisite before a new execution phase. Current-wave migrations/model/compose compatibility cannot be relabeled as original-baseline compatibility. |

The source snapshot pins remain those in the independent
[import matrix](../../tests/qa/fixtures/catalogue/import-outcomes.json):

| Provider | Snapshot ID | Logical digest | Frozen file SHA-256 |
| --- | --- | --- | --- |
| VNDB | `dataset-904aa4496a525e699074` | `904aa4496a525e699074365819fd4f5682755645980c3ef11c220b8df155a7de` | `e32b3489a7a178fba54aa6d9dcbe93aeb57fb3f5ca0deecb2e0d035a2e31a5bd` |
| Bangumi | `dataset-424753e973cbd3609613` | `424753e973cbd3609613c7ef373d214c9d1576bce1d05da4fe21b23826eef88d` | `89ba2f7bb2b874ec77886bae97007d959c0e3409af1d8581fa7d05a7f9911625` |
| MusicBrainz | `dataset-a178e59cbd2efe477b79` | `a178e59cbd2efe477b79547e69fc8d22c9930e8d38cbeff942ca78f31050a949` | `ca9e77b44671bef775b607e2c8799c05eabb79b73f3fb7939ddc0b075b13d9e5` |

Their original creation times, selected record digests, original edge indexes and
edge digests remain authoritative in that matrix. All 113 native original
resource/mainVersion/revision bindings must be supplied by the retained ledger
and verified before and after preparation and on each isolated restore. No
same-name replacement, prefix import or new snapshot can supply them.

## Retained failure evidence and excluded reader cases

These are committed author reports, not newly inspected live logs or new runs.
The reports' paths and original pins remain unchanged:

- [Identity/reader historical preparation](../goals/audit-remediation-20261019/identity-reader-outcomes.json)
  at product `79be80d4d0e1cad1639b6a65e8f0795d6a95929a`: job
  `6b07d19a-f509-4c96-9b37-e584b3d38be7`, QA
  `20261018t195139-618183`, both files' `beforeAll`, composition 400 from an
  over-wide command body. The retained correction narrowed it to admitted fields.
  Job `3f79ebcf-cdf9-4317-9a21-ec407fe53fa8`, QA
  `20261018t195855-5055f7`, then stopped at Book publication 404
  `contribution_unavailable`. No backup, restore, empty Account or outcome body
  was reached. The corrected future baseline remains unexecuted.
- [Author historical preparation](../goals/audit-remediation-20261019/author-management-outcomes.json)
  at the same later product: the first AMGT00 selection matched no case; the
  corrected selection's job `1cf6c970-e48a-42b8-86e0-d840499a1dde` / QA
  `20261018t195727-b5748c` failed the
  depth-2 composition premise (409 `composition_conflict`, 101075 ms body).
  The current helper keeps Volume and Part at the root, chapters under Part.
  Job `07c130ea-16df-41ff-8cbb-cb29c0d9770b` / QA `20261018t200648-4ee118` completed public commands and
  anonymous exact chapter/Post smoke, but stopped-owner backup certification's
  read-only `pg_controldata` exceeded 30000 ms (exit null). Body 197811 ms, active
  run 271424 ms, admission 13172 ms; no backup published and no AMGT01 assertion.
  Preserve its cleanup evidence; no blind retry of this known failure is advised.
- The [information handoff](../goals/audit-remediation-20261019/information-outcomes.md)
  records a prior missing-corpus attempt with no product assertion. The public
  domain and search author reports retain not-run baselines. None establishes
  readiness or product failure at the corrected original baseline
  `69eac3ceeaf885be70205a70248bc951e9d81cc9`.

The two [Zone reader tests](../../apps/web/tests/g-655-zone-site.test.ts) are
outside `auditProofFiles` and consume local `pageRequest` fixtures rather than
these manifests. The decision retains these distinctions for manager triage:

| Exact case | Failure stage and assertion reach | Owning prerequisite |
| --- | --- | --- |
| `every module card and row whose Work is in the population links inside /z/{ref}/` | `loadModules` result fails the ready-module-types assertion; that assertion is reached, before population link checks. | Reader/module fixture contract (`discussion-list`, `editorial-list`, `hero-carousel`, `quote-stream`, `ranking`, `rising`, `shelf`) and actual advertised reads. No demonstrated shared-corpus omission. |
| `a card from a mounted Collection opens under its mount, the rest under /w` | Editorial module lookup throws `The editors’ list did not load` before the mounted-Collection href assertion. | Local Collection/module fixture readiness. No outcome assertion reached and no demonstrated shared-corpus omission. |

## Deferred execution and budget

The exact preparation, stop/backup and restore commands are the single
[`prepare-audit prepare` procedure](audit-corpus.md#explicit-preparation-and-one-backup).
It owns the stop/cut/round trip internally; there is no separate manual backup
producer. Inspection, initial restore/setup, public commands, readiness,
shutdown, backup, round trip and cleanup must all fit the existing **600 s**
active preparation budget; only host admission is excluded. Every proof restore
has its own existing 600 s preparation budget. No duration is claimed for an
unexecuted stage; stack-free inspection here is not a completed preparation.

After owner inputs, baseline compatibility and an explicit manager execution
phase exist, use that procedure and the existing proof command from the assigned
worktree, selecting the exact files above:

```sh
task goal -- prepare-audit inspect .temp/audit-corpus/recipe.json
task goal -- prepare-audit prepare .temp/audit-corpus/recipe.json
REZICS_AUDIT_CORPUS_RECIPE=.temp/audit-corpus/recipe.json \
  bun scripts/goal/goalctl.ts test tests/qa/integration/outcomes/catalogue/import-fidelity.test.ts
```

Record long commands through main's Goal job owner while retaining this
worktree as cwd. The manager separately pins original-baseline product/spec
overlay and fixed-wave proof; no source publication or stack-free test promotes
an outcome. Preserve failed attempts, exact source/model/restore generations,
replay keys and native bindings. Each file/body's supported restore owner must
isolate writable state; never share one mutable corpus between proofs.
