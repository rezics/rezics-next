# Reviewed native catalogue bindings

Status: **PROPOSED specification; awaiting Semantic, Imports and Root review**.
This is the missing binding producer boundary, not a deployed mapping. Only the
manager can accept/freeze it after coowner review. The
[Definitions meanings](../../../../packages/definitions/README.md#public-classification-and-genuine-measurements)
and [source inventory rules](../../../../packages/definitions/sources/README.md)
remain authoritative. This contract specifies the native observations needed to
implement those meanings. Its [type file](reviewed-catalogue-bindings-contract.ts)
exports types only; it creates no native subjects, namespace, registration or
ready binding. Released property admission is a separate prerequisite.

## Required meanings

| Input meaning                                                 | Native assertion and correspondence                                                                                                                              | Excluded inference                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Bangumi public editor field `meta_tags`, exact literal `后宫` | `schema:keywords` value is an actual adopted source Concept, in the actual scheme whose adopted external key is `https://rezics.com/schemes/bangumi/public-tags` | Ordinary `tags`, popularity, personal/private Collection labels, arbitrary infobox, normalized spellings or a matching label supply no binding |
| Canonical media-harem meaning represented by Q690342          | A distinct canonical Concept has reviewed external identity; the source Concept has standard native `skos:closeMatch` to that Concept                            | No `schema:sameAs`, `skos:exactMatch`, merge, label join or implicit filter expansion between source and canonical Concepts                    |
| Japanese literary form represented by Q747381                 | Actual adopted work-form Concept, with exact external correspondence, used as the value of existing Book `workFormat` / `wdt:P7937`                              | Generic novel, Bangumi type 1, manga, language, title or platform supplies no light-novel assertion                                            |
| Schema.org VegetarianDiet enumeration                         | Actual adopted Concept and scheme; explicit correspondence to `https://schema.org/VegetarianDiet`; value of `schema:suitableForDiet`                             | No guessed QID, ingredient heuristic or recipe-site producer                                                                                   |
| Platform vocabulary                                           | **NOT YET FROZEN** until exact current inventory and native code keys and meanings are reviewed                                                                  | No platform IDs, aliases, provider identity or Concept identity invented here                                                                  |

P7937 is an external **property** meaning, distinct from Q747381's Concept
meaning and from its native UUID. Exact P136 genre stays distinct from keywords;
the inventory's close P921 correspondence is neither executable exact mapping
nor permission to double-emit. Book stays a work; `bf:Instance` stays an edition.
An explicit trusted cited form assertion or actual Wikidata P7937 value requires
its own holder and Concept binding. An archived manga row cannot provide it.

## Operational identity decision still required

Reuse `semantic.external_claim` and existing `batchCommand` create-or-resolve.
No global claim endpoint, catalogue registry, provider converter, identity engine,
custom correspondence property or permission is proposed. UUIDs always come from
ordinary native APIs. A QID or URL is an external meaning key, never a native ID.

The minimal proposed decision is to configure one explicit platform-review seed
namespace/alias for platform-authored vocabulary, and adopt a stable literal
encoding of `(owner-adopted scheme URI, literal member)` as its `external_id`.
Review must select the alias, ownership, literal encoding/escaping and permitted
vocabulary keys. None is adopted by this specification. In particular, do not
silently use `bangumi`, `wikidata`, archive subject `498` or a fabricated numeric
tag ID as the source identity of a platform-authored vocabulary record.
Configured aliases are trusted configuration; their spelling proves no identity.

The acceptance file's `binding_mechanism_test` alias and random isolation suffix
are **test-only configuration**, proving the existing durable claim mechanism.
They are neither a runtime namespace choice nor an accepted binding producer.
The independently created graph controls prove native representability and
disclosure only. Neither they nor the shared released-discovery classification
IDs may be passed off as production reviewed provider bindings. A future shared
builder group must delegate to the one production producer once it exists.

Imports must separately review the exact Bangumi `resolvedReferences` lookup key.
The logical source/field/member tuple above is proposed identity, not an already
implemented lookup string. Existing Wikidata conversion reads actual raw QID keys
such as `Q747381`; a URL-keyed or property-keyed substitute will not resolve it.
No speculative registration option or callback follows from a type declaration.

## Ordinary native protocol and closed output

1. Authenticate and authorize the current actor on Global. Batch authority and
   each command's ordinary create/propose authority precede all receipt replay.
2. For a first-party imported-source seed, use the existing
   [source metadata contract](source-record-attribution-contract.md). Require a
   real metadata ACK before bootstrap and the sealed admitted-run policy before
   dispatch. Invalid/truncated/duplicate/mass-disappearance input cannot create
   metadata, claims, candidates or other import effects. No fabricated metadata,
   grants or direct SQL effects may bypass a missing native port.
3. Create or resolve the actual ConceptScheme and Concepts through the ordinary
   API and durable external claims under the reviewed namespace. Persist each
   returned command/result, exact source tuple, release and ID. Repeating the
   same claim with fresh request keys and another authorized actor must return
   the same ID. Process cache and label search are insufficient.
4. Propose cited scheme membership, scheme external identity and correspondence;
   accept in the actual Context and adopt the actual returned candidates with
   current expected heads. Keep acceptance and adoption receipts separately.
   Native candidate, head, revision and release values must come from responses.
5. Read the current disclosed native graph and candidate listing through the public API. Check actual
   types, scheme membership, selected correspondence and distinct source and
   canonical subjects. An accepted but unselected, hidden, suppressed, retracted,
   inaccessible or fenced fact cannot supply current binding evidence. A receipt
   is an immutable observation, not perpetual authorization or disclosure.
   Existing bulk retraction deliberately leaves Context adoptions unchanged:
   a retracted correspondence can remain in the public Item. Require the current
   listing's actual accepted, selected candidate with both `retracted` and
   `retraction` null, in addition to the Item read. Never treat the retained
   adoption as a ready binding or change bulk retraction's meaning here.
6. Only the accepted producer output can populate existing conversion
   `resolvedReferences` after coowner key review. Keep actual requests and native
   results in the existing `RecordBindings` claim/journal handoff; never turn a
   local `bound` bootstrap claim into an editorial acceptance receipt.

The closed union in the type file distinguishes Bangumi public tag, Japanese
light-novel form and Schema.org diet enumeration. It requires real claim
observations, membership, correspondence, evidence and current public read.
`accepted-output` names a required future output shape, not a factory or a
runtime validator. The union does not confer approval by structural assignment.
No default UUIDs, success stubs, hidden permission cache or fallback registry exists.

### Existing signatures versus proposal

| Existing production surface              | Actual signature or representation                                                                                                                                           | What it does not supply                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `subject.ts:createSubject`               | `(pool, options) -> Promise<CreateSubjectResult>`; actual result includes `subject: Item`, `component`, `replayed`                                                           | External vocabulary review or durable external-key claim                                 |
| `bulk.ts:batchCommand`                   | `(pool, options) -> Promise<{status: 200\|201, value: BulkValue, component}>`; options carry `BatchCommand`, native actor, authorization, release, route, deadline and clock | New source registration, metadata ACK or editorial acceptance                            |
| `POST /v1/subjects:batchWrite`           | `BatchWriteRequest` / `BatchWriteResult` from `@rezics/definitions/bulk`; create value `{id, revision}`, proposal value `{candidate, revision}`                              | Complete reviewed binding; a command-local error is not success                          |
| `candidates.ts:decideCandidate`          | `(pool, EditorialWriteOptions & {candidate, context, decision, expectedHead})`                                                                                               | Selection in a Context                                                                   |
| `candidates.ts:adoptCandidates`          | `(pool, EditorialWriteOptions & {context, property, slot?, mode, selection, expectedHead, release})`                                                                         | Perpetual disclosure or producer eligibility                                             |
| `subject.ts:readSubject`, `item.ts:Item` | Native current graph, release, revision, Context, statements, references and resolutions                                                                                     | An absent standard property or metadata route                                            |
| `ConversionContext.resolvedReferences`   | Optional `Readonly<Record<string,string>>` of source-native relation key to actual UUID                                                                                      | Authority, scheme review, readiness or CLI wiring                                        |
| `createSourceRegistration`               | `(sourceKind, options?: {source?: string; converterRevision?: string}) -> SourceRegistration`                                                                                | Metadata/binding registration option or seed producer                                    |
| `RecordBindings`                         | Caller-owned SQLite handle; `prepare`, exact `journal`, `acknowledge`, `claim`; bound claim stores actual subject response                                                   | Editorial acceptance, native scheme semantics, full record baseline or a global registry |

The type file derives native signatures with `Parameters` and awaited
`ReturnType`, and reuses `Item`, `Statement`, `Source`, `BatchCommand`,
`BatchStatement` and `BatchWriteResult`, and derives candidate observations from
`listCandidates`. Release mapping keys remain compact (`wd:P7937`); their external
property meaning is the expanded P7937 URI, not a native Concept UUID.
Future evidence wrappers are expressly
proposed; they do not add fields to existing DTOs. Native expected-head names in
function options are camelCase, whereas HTTP bodies use `expected_head`.

## Exact archived input and provenance

Reuse the complete existing
[pinned projection](../../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json)
and its [provenance](../../../../specs/fixtures/imports/bangumi/PUBLIC-METADATA.md).
The observed input was already delivered; this contract adds no extractor or copy.
Its exact native record is **498, type 1, manga**, with the complete ordered array
`日本`, `后宫`, `漫画`, `战斗`, `少年`, `奇幻`, `原创`, `系列`.

| Evidence locator                | Value                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Subject                         | `https://bgm.tv/subject/498`                                                   |
| Asset                           | `dump-2026-10-20.210332Z.zip` in the official Archive release                  |
| ZIP SHA256                      | `9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93`             |
| Member and row                  | `subject.jsonlines`, physical line 457; bytes `[1116919,1119528)` including LF |
| Raw line SHA256 including LF    | `fb80ae3cb9b5a6713c4d8f105f0fcfa079963391c85f6aa15a00ebe9ddc5331e`             |
| Raw line SHA256 without LF      | `c0058cedb0e51c52022ae6b031fd9814803e9e163d5b0bb73eb08e3bd010db83`             |
| Existing projection file SHA256 | `3b8382649610aa4c783cea2ffff319ccd0d80aad10f3147152d98a3c131debf5`             |

Retain native source URL, pin, row and digest as evidence locators. Archive date,
row number and hash are not a native record revision. The input has no native
revision, source date, word measurement or light-novel assertion; absent fields
stay absent. `record_revision: unversioned` with actual digest is the honest
bulk envelope when needed. Do not synthesize `schema:version`, `dateModified`
or ingestion time from the pin. Available Wikidata meaning revisions remain
Q747381 `2548853139`, Q690342 `2554335445`, P7937 `2556853748`, as recorded in
the mapping report; these are not Bangumi revisions.

Attribution remains Bangumi contributors, CC-BY-SA-3.0, with the existing linked
copyright statement, attribution and modification notice. This licences the
permitted metadata projection, not images, accounts, user writing or book text.

## Native proof and deliberate first reds

The native suite uses the same `createReleasedDiscoveryFixture`, its real Auth,
Access, grants, request transport and public reads. It adds no database, harness,
data registry or alternate transport. Each test is independently runnable after
setup; failure of a missing producer does not suppress the available graph cases.

| Exact scenario title                                                                                                                   | Evidence or expected missing outcome                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reviewed public tag and form bindings require actual native Concept scheme and accepted correspondence receipts with same claim replay | Existing claim create/resolve and cross-actor fresh-key replay, actual membership receipts; then required standard close proposal **201**, acceptance/adoption **200**, read receipt. Bundled `skos:closeMatch` is missing; a rejection is a red, never a binding pass |
| Bangumi exact public meta_tags harem is source scoped and never exact canonical harem or inferred light novel                          | Full pinned array/hash and independent native controlled graph; source/canonical distinction, actual membership and citations, no form/word inference. Does not claim converter delivery                                                                               |
| independent native work-form and diet graph controls retain exact reviewed external meanings and real receipts                         | Available Book P7937 and Recipe diet, scheme memberships, exact external correspondence and actual acceptance/adoption receipts; no production seed claim                                                                                                              |
| unselected and hidden correspondence cannot be disclosed as current reviewed binding evidence                                          | Ordinary native proposal, acceptance, selection and moderation remain distinct                                                                                                                                                                                         |
| native claim replay checks current authority before returning an existing binding                                                      | Ordinary account denied batch authority; pre-suspension bearer revoked before replay; authorized fresh-key claim still resolves. Valid suspended403 is a separate missing native persona, not fabricated here                                                          |
| retracted claim-backed correspondence requires provenance even when its adoption remains public                                        | Real source-owned proposal, native selection and terminal bulk retraction; actual listing retains cited retraction while Context adoption remains. A retained Item assertion alone cannot certify a binding                                                            |
| first-party vocabulary seeding requires a native source metadata ACK before any external claim bootstrap                               | Required native metadata **201**. Missing route is a red; no bootstrap dispatch is made after it. This is not proof of first-party sealed-run ordering                                                                                                                 |

Required producer prerequisites are: an adopted namespace/encoding and Bangumi
consumer key; real native source metadata and admitted-run ACK wiring; released
standard close correspondence; and the one accepted reviewed binding producer.
The current source-record contract names a future metadata route/storage/DTO;
its tests are specifications, not evidence those exports already exist. A native
metadata red must remain separate from the independently available graph proof.

No existing acceptance, shared builder, release/YAML, recordings, importer or
converter is changed. Full word/form/tag/platform, same-statement, six-surface,
defaults/index/privacy/main obligations remain with their owners. This focused
boundary does not establish genuine measurements, complete projections, indexed
execution or deployed mappings. Missing/empty/withheld tags and unresolved binding
must later omit conversion proposals; no fallback to ordinary/private tags or
infobox is authorized. Those converter obligations are not implemented by this
native controlled-graph specification.

## Read-only evidence inspected

Read Definitions and source READMEs, classification YAML and current native
properties; the catalogue-filter-data-mappings report; native batch, subject,
candidate/acceptance/adoption APIs; conversion context and Wikidata raw-QID
resolution; actual source registration and RecordBindings claim/journal APIs;
the existing archived projection, provenance and investigation report.

Reference source was read at
`/home/edge/projects/rezics/rezics-next/.reference/shelves/bangumi-server`, revision
`1997713eafc51487cbea705b37011442f35539fa`, using the read-only reference index:
`openapi/components/subject_v0.yaml`, `subject_cat_book.yaml`,
`internal/model/subject_type.go`, `internal/tag/domain.go`,
`web/handler/subject/get.go`, `web/res/subject.go`, and `cmd/archive/main.go`.
These establish editor metadata versus popularity tags, Book type/category,
current access handling and archive serialization; the pinned row establishes
the actual member. AGPL-3.0-only source was neither copied nor executed.

## Verification

From the worktree root, commit before running each required check:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/semantic/reviewed-catalogue-bindings.test.ts
bun scripts/worker-check.ts -- bun run typecheck
```

Record actual statuses and log paths in the handoff. The deliberate native reds
identify missing producers; a passing typecheck would establish only that the
proposed types and tests compile. Manager review, acceptance/freeze and promotion
remain separate.
