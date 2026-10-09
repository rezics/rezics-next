# Provider and composition configuration test

Both cases fail the maintainer's test in the
[platform thesis](../../../product/platform-thesis.md#expansion-acceptance):
a withheld provider and a withheld composition kind do not activate from a
mapping, a source profile, and an allowlist. Staging retained bytes for any
provider string already works. Turning those bytes into Works, titles, credits,
and facts does not. A new composition kind does not.

Assumption: the operator may POST the record bytes. Fetching `acme-catalogue`
over the network is a separate host allowlist. The test is the in-process
activation after the bytes exist. Line numbers are this worktree's committed
base. `incidental` means the literal is one provider's grammar. `owner` means
a person must decide it.

## What already accepts data

| Door | file:line | What an unseen name can do |
| --- | --- | --- |
| Manual intake | `services/main/src/routes/sources.ts:27` and `:76` | `POST /v1/sources/intakes` takes any `provider` and `namespace` string, with retained bytes. |
| Intake check | `services/main/src/modules/source/intake.ts:63` | The provider is length-checked text. No allowlist. |
| Field tables | `services/main/src/modules/source/field-schema.ts:16` | `source.field_mapping` and `source.field_disposition` can name a provider. Writers below do not read an uploaded map. |
| Statement API | `scripts/datasets/bangumi.ts:1013` | Bangumi posts an already-built statement. The API does not interpret a provider record. |
| Profile modules | `services/main/src/modules/structure/profiles.ts:122` | `*/structure-profile.ts` is loaded by glob. The id must already be in the format enum (`:129`). |
| Type registry | `services/main/src/modules/types/registry.ts:18` | Work types come from generated model terms. A new type does not register a provider or a composition kind. |

`services/main/src/modules/source/acquisition.ts:13` only constructs the run, feed, and drift stores. It does not choose a provider. The Open Library constants live in those stores.

`scripts/static/` has no provider registry and no composition-kind registry. `scripts/static/anti-silo.test.ts:30` and `:49` list domain tokens (`recipe`, `book`, `anime`, `manga`, `vn`) so a new code branch trips the guard. They are not an activation list. `services/main/src/modules/work/work-kinds.ts:43` is the home-interest list. Storing acme facts does not consult it.

## Case 1 — `acme-catalogue`

Entry today, once bytes are staged: `POST /v1/sources/observations/{observation}/conversions/open-library-work` (`services/main/src/routes/sources.ts:38`). That handler calls `projectOpenLibraryWork`, then the source-graph command, then title, synopsis, and author-credit adoption. An acme record stops at the first of those checks.

Fixture `acme-catalogue-work-v1`: one retained JSON object `{ "catalogueId": "AC-1", "heading": "…", "blurb": "…", "credits": [{ "person": "AC-P-1", "role": "writer" }], "facts": [{ "name": "page-count", "value": "320" }] }`, mapping revision `acme-catalogue-work-map-v1`, profile `source-acme-catalogue-v1`, allowlist pair `acme-catalogue` / `work`. The proof is that this fixture projects, reifies one statement per declared field, and adopts a title, one credit, and one accepted fact with an empty diff under `services/main` and `infra/jena`.

### Capture and identity

| file:line | Hard-codes | Why | Replacement | Size |
| --- | --- | --- | --- | --- |
| `services/main/src/routes/sources.ts:28` | Route path `…/acquisitions/open-library/works`. | incidental | One acquisition route whose body names `provider` and `namespace`. The allowlist supplies the URL template and id pattern. | 1 route, ~15 lines |
| `services/main/src/routes/sources.ts:38` | Conversion route `…/conversions/open-library-work`. | incidental | `POST /v1/sources/observations/{observation}/conversions` with a mapping revision the allowlist names. | 1 route, ~10 lines |
| `services/main/src/routes/sources.ts:95` | Capture profile union of two Open Library profiles. | incidental | Capture profile id is the source profile's declared capture id. | ~4 lines |
| `services/main/src/routes/sources.ts:105` | Body profile `open-library-work-acquisition-v1` and `OL…W` id. | incidental | Body is `{ provider, namespace, externalId }` checked against the allowlist. | ~8 lines |
| `services/main/src/routes/sources.ts:617` | Replay requires provider `open-library`, namespace `work`, and the work capture profile. | incidental | Replay compares the stored provider, namespace, and external id. | ~3 lines |
| `services/main/src/modules/source/open-library.ts:7` | Work id `/^OL[1-9][0-9]{0,11}W$/`. | incidental | Id pattern column on the allowlist row. | ~5 lines |
| `services/main/src/modules/source/open-library.ts:82` | Response must have `key === /works/${id}` and a string `title`. | incidental | Key template and required paths come from the mapping. | ~20 lines |
| `services/main/src/modules/source/open-library.ts:90` | Stored provider, namespace, coverage scope, and capture profile are Open Library literals. | incidental | Copy the request's provider and namespace. Coverage scope is the profile id. | ~6 lines |
| `services/main/src/modules/source/intake.ts:25` | `SourceCapture.profile` is the two Open Library acquisition profiles. | incidental | Profile is a string the allowlist lists for that provider. | ~4 lines |
| `services/main/src/modules/source/intake.ts:172` | Rate-gate SQL inserts and locks provider `'open-library'`, then waits 1 second (`:180`). | owner for the limit; incidental for the name | `reserveSlot(provider, interval)` using the allowlist's interval. The table is already per provider (`services/content/migrations/006_source_capture.sql:4`). | ~15 lines |
| `services/main/src/modules/source/intake.ts:221` | A capture is valid only for Open Library ids, namespaces `author` or `work`, and `openlibrary.org` URLs. | incidental | URL template and id pattern from the allowlist. Unknown capture profiles fail. | ~20 lines |
| `services/main/src/modules/source/acquisition-run.ts:12` | Run profile `open-library-works-run-v1`. Editions, ratings, bookshelves, and recent-changes scopes follow at `:165`–`:218`. | incidental | Run profile id and coverage scopes are rows, one per fetched surface. | ~40 lines across this file |
| `services/main/src/modules/source/provider-identity.ts:103` | Identity evidence matches the destination id, or, for Open Library works, the destination prefixed with `/works/`. | incidental | Key template from the mapping. The match itself stays. | ~6 lines |

### Projection, statements, command

| file:line | Hard-codes | Why | Replacement | Size |
| --- | --- | --- | --- | --- |
| `services/main/src/modules/source/open-library-conversion.ts:8` | Mapping revision `open-library-work-map-v1`. | incidental | Revision id is the uploaded mapping's id. | 1 constant |
| `services/main/src/modules/source/open-library-conversion.ts:95` | Conversion accepts only the Open Library work capture, provider, namespace, and coverage scope. | incidental | Accept any staged observation whose provider and namespace match the mapping row. | ~8 lines |
| `services/main/src/modules/source/open-library-conversion.ts:117` | JSON must be `{ key: /works/OL…W, title, type.key: /type/work }`. | incidental | Required paths and the key template are mapping fields. | ~25 lines |
| `services/main/src/modules/source/open-library-conversion.ts:126` | Field names `key`, `title`, `description`, `authors`, `subjects` plus two hard-coded sets (`:56`, `:57`) choose a disposition. | incidental | Read `source.field_disposition` for this mapping revision. Unknown keys stay `undeclared-field`, which the recipe writer already records. | ~40 lines, deletes the switch |
| `services/main/src/modules/source/graph-projection.ts:13` | Profile `source-open-library-work-v1`. | incidental | Profile id from the allowlist. | 1 constant |
| `services/main/src/modules/source/graph-projection.ts:54` | Triples say `rv:sourceProvider "open-library"` and namespace `work`. The observation already stores both. | incidental | Write `observation.provider` and `observation.namespace`. | ~4 lines |
| `services/main/src/modules/source/reification.ts:13` | A statement field is `'title' \| 'description'` only. | incidental | One statement per mapping field whose disposition is a claim. | ~30 lines |
| `services/main/src/modules/source/reification.ts:57` | At most 2 statements and 24 triples per conversion. | owner for a bound; incidental for 2 | Bound is a reviewed number on the profile. Cardinality follows the mapping. | ~4 lines |
| `infra/jena/command-module/src/main/java/com/rezics/jena/SourceProjectionPolicy.java:20` | Closed predicate sets for record, observation, conversion, and statement. | owner | The set stays reviewed. Its contents move to the source profile the command already pins by hash. | profile data; Java reads it, ~40 lines |
| `infra/jena/command-module/src/main/java/com/rezics/jena/SourceProjectionPolicy.java:57` | Mapping literal must match `open-library-work-map-v1`. | incidental | Mapping literal must equal the receipt and be in the reviewed allowlist. | ~8 lines |
| `infra/jena/command-module/src/main/java/com/rezics/jena/SourceProjectionPolicy.java:72` | Conversion key must equal `"/works/" + externalId`. | incidental | Key must equal the mapping's key template applied to the external id. | ~10 lines |
| `infra/jena/command-module/src/main/java/com/rezics/jena/SourceProjectionPolicy.java:84` | Statement count is 1, or 2 when a description exists. | incidental | Count equals the mapping's claim fields. | ~6 lines |
| `infra/jena/command-module/src/main/java/com/rezics/jena/SourceProjectionPolicy.java:95` | The only predicates are `sourceTitle` and `sourceDescription`, fields `title` and `description`, disposition `structured-source-only`. | owner for the disposition; incidental for the two fields | Predicates and field names come from the mapping. The disposition text stays the reviewed constant (`:111`). | ~25 lines |
| `model/definitions/source-open-library-work-v1.ttl:12` | `sh:hasValue "open-library"`. | incidental | Provider, namespace (`:14`), external-id pattern (`:17`), key pattern (`:42`), and mapping revision (`:53`) are parameters of one source-record shape. | 1 shape, ~40 lines, replaces this file's literals |
| `model/definitions/source-reification-v1.ttl:16` | Statement predicate `sh:in ( rv:sourceTitle rv:sourceDescription )`. | incidental | Predicate `sh:in` is the mapping's claim predicates. | ~10 lines |
| `model/definitions/source-reification-v1.ttl:26` | Mapping `sh:hasValue "open-library-work-map-v1"`. Field names `sh:in ( "title" "description" )` at `:28`. | incidental | Same parameter binding as the record shape. | included above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java:385` | The source graph may be validated only for `source-open-library-work-v1` and `source-reification-v1`. Repeated at `:1427`. | owner | Any profile the reviewed manifest marks `graph: source`. | ~6 lines |
| `services/main/src/infrastructure/profile.ts:5` | `ProfileId` is `keyof` the generated registry. | owner | A new Turtle profile is data, then a reviewed hash. It is not live because the shapes and the Java set above still name Open Library. | no separate edit once the shape is generic |

### Native title, synopsis, credit

| file:line | Hard-codes | Why | Replacement | Size |
| --- | --- | --- | --- | --- |
| `services/main/src/modules/work/title-control.ts:534` | Source title intent mapping must be `open-library-work-map-v1`. | incidental | Mapping must be the allowlist revision that declares the title slot. | ~4 lines |
| `services/main/src/modules/source/native-work-adoption.ts:607` | Adopted title writes that same mapping literal. Same literal again at `:694`. | incidental | Copy `conversion.mappingRevision`. | ~2 lines |
| `services/main/src/modules/source/native-work-proposal.ts:12` | Proposal profile `open-library-native-work-proposal-v1`. | incidental | One native-work proposal profile. The provider stays on the record. | ~6 lines |
| `services/main/src/modules/source/field-control-native.ts:27` | Synopsis source mapping type is that Open Library revision. Checked again at `:64`. Field is `'synopsis'` (`:30`). | incidental | Mapping id is a string. The slot name comes from the disposition's `native_target`. | ~8 lines |
| `services/main/src/modules/source/field-application.ts:17` | The only applied slot is `work-editorial-field-v1#synopsis`. | incidental | Slot is `native_target` on the disposition row. | ~10 lines |
| `services/main/src/modules/source/field-application.ts:51` | Applied value must equal `projection.description`. | incidental | Applied value must equal the mapped field named by the step. | ~6 lines |
| `infra/jena/command-module/src/main/java/com/rezics/jena/EditorialFieldPolicy.java:166` | Source control matches only `open-library-work-map-v1`, and the value must equal `sourceDescription` (`:170`). | incidental | Match the receipt's mapping and the predicate the slot declares. | ~12 lines |
| `services/main/src/modules/work/author-credit.ts:27` | Native credit provider is `'open-library'`, namespace `'author'`. Triples repeat it at `:54`. Read query repeats it at `:85`. | incidental | Provider and namespace come from the source record. | ~10 lines |
| `services/main/src/modules/work/author-credit.ts:38` | Source key must match `/authors/OL…A`. | incidental | Key pattern from the mapping's credit field. | ~4 lines |
| `services/main/src/modules/source/author-credit-schema.ts:15` | HTTP result schema repeats provider `open-library` and namespace `author`. | incidental | Both are strings. | ~2 lines |
| `services/main/src/modules/source/author-facts.ts:9` | Author identifier schemes are a fixed union (`project_gutenberg`, `librivox`, `wikidata`, `lc_naf`, `viaf`, `isni`). Fact paths are `/birth_date`, `/death_date`, `/fuller_name`, `/remote_ids/…` (`:33`). | incidental | Schemes and paths are mapping fields of kind `identifier` and `time`. | ~20 lines |

There is no Main writer from a source field to a catalogue Statement. Subjects stay JSON on the conversion (`services/main/src/modules/source/graph-projection.ts:69`). Facts such as page count, format, and completion have no slot. The fixture's `facts` array cannot land.

### Second and third projectors

These are the same decision as the Open Library switch. An acme record does not enter them either.

| file:line | Hard-codes | Why | Replacement | Size |
| --- | --- | --- | --- | --- |
| `services/main/src/modules/source/field-vndb.ts:5` | Mapping `vndb-concept-map-v1` and four Kana field lists (`:6`). | incidental | Same field-disposition rows. | deleted by the shared projector |
| `services/main/src/modules/source/field-vndb.ts:46` | `projectVndbConceptCaptures` parses tags, traits, and roles in code (226 lines in the file). | incidental | Paths and dispositions are rows. Role names that mean a new credit kind stay an owner term. | 0 lines once the projector is shared |
| `services/main/src/modules/recipe/source-conversion.ts:12` | Two slots, `recipeIngredient` and `recipeInstructions`. | incidental | The insert at `:47` already writes `source.field_mapping`. The row list should be the uploaded map, not `SLOT`. | ~15 lines |
| `services/main/src/modules/recipe/source-conversion.ts:114` | A key is native only when it is a member of `SLOT`. Grain is the literal `'recipe'`. | incidental | Disposition comes from the row. Grain is the mapping's `root_grain`. | included above |

### Bangumi, the provider outside Main

`scripts/datasets/bangumi.ts` is 1040 lines. Main never loads it. It does not call intake, conversion, or source projection.

| Lines | What it is | Data? |
| --- | --- | --- |
| `scripts/datasets/bangumi.ts:13`–`:20` | Franchise title regexes. | Tables in the script. |
| `scripts/datasets/bangumi.ts:39`–`:43` | Numeric relation-type sets. | Tables in the script. |
| `scripts/datasets/bangumi.ts:211`–`:220` | Field names to omit (posts, images). | Tables in the script. |
| `scripts/datasets/bangumi.ts:243` | `bangumiFieldDisposition` walks the record in code and applies those omit lists. | Code. |
| `scripts/datasets/bangumi.ts:319` | Enrichment refuses a source whose provider is not `bangumi`. | Code. |
| `scripts/datasets/bangumi.ts:823`–`:837` | Platform integers and status tags to format and serial status. About 15 lines. | Tables in the script. |
| `scripts/datasets/bangumi.ts:881` | `bangumiFormat` branches on subject type `2` (anime) and `1` (book). | Code. |
| `scripts/datasets/bangumi.ts:901` | Infobox keys `话数` and `册数` become episode and volume counts. | Code. |
| `scripts/datasets/bangumi.ts:952` | `bangumiWorkFacts` combines format, count, and completion. | Code. |
| `scripts/datasets/bangumi.ts:989` | `importBangumiWorkFacts` seeds format concepts and posts statements plus accept decisions (`:1013`, `:1016`). | Code calling the generic statement API. |

About 40 lines are lookup tables. The other ~1000 lines are archive selection, HTTP, and the importer. None of it is a mapping, a source profile, or an allowlist Main would accept. Adding acme by copying this file is a new program, which is the outcome the thesis refuses.

## Case 2 — section list

The kind is an ordered list of Works: sections, and a note on each entry, bound to a Work-like owner. Qualifiers, order, and disclosure are supposed to be data.

Entry today: `POST /v1/compositions` accepts only three profile literals (`services/main/src/routes/compositions.ts:43`). `work-composition` is the nearest owner (`services/main/src/modules/composition/structure-profile.ts:71`): groups, parts, a display label, and inclusion. It has no note field. `book-composition` is chapters. `recipe-composition` is ingredients and steps.

Fixture `section-list-v1`: a profile document `{ id, ownerType: CreativeWork, roles: [section, entry], qualifier: { entry: { note: text } }, disclosure: work-read }`, one owner Work, two sections, three entries with notes. The proof is that `POST /v1/compositions` creates it, an insert round-trips the note, and an unreadable target is withheld, with an empty diff under `services/main/src/modules/structure/format.ts`, `profiles.ts`, `services/main/src/routes/compositions.ts`, and the structure shapes' `sh:in` lists.

| file:line | Hard-codes | Why | Replacement | Size |
| --- | --- | --- | --- | --- |
| `services/main/src/modules/structure/format.ts:38` | Six profile ids: book, work, collection, zone, wiki, recipe. | incidental | Profile id is the registration's id. The object format already versions by hash of bytes (`:7`). | ~5 lines to drop the enum |
| `services/main/src/modules/structure/format.ts:40` | Nine occurrence roles. | incidental | Roles are the profile document's role list. Shared roles stay `group` plus the profile's entry role. | included above |
| `services/main/src/modules/structure/format.ts:44` | `PROFILE_ROLES` maps each of the six ids onto a fixed role list. | incidental | The registration's `roles` array, which already exists on `StructureProfileRegistration`. | ~10 lines |
| `services/main/src/modules/structure/format.ts:77` | Qualifier union: `work-part`, `book-group`, `zone-mount`, `ingredient-line`, `recipe-step`. No note. | incidental | A qualifier is a list of named fields whose kinds are the ones already implemented: text, enum, boolean, rational, IRI list. A note is `{ name: note, kind: text }`. | ~50 lines, deletes the five object branches |
| `services/main/src/modules/structure/format.ts:176` | Manifest `measures` are recipe yields, durations, and nutrients. | incidental | Measures are omitted unless the profile declares them. An empty array already validates. | ~6 lines |
| `services/main/src/modules/structure/format.ts:308` | Default selection-required role is `chapter` when the profile is `book-composition`. | incidental | Callers that pass the registration's `selectionRequiredRoles` already do the right thing (`services/main/src/modules/structure/change.ts:2010`). Delete the book default. | ~2 lines |
| `services/main/src/modules/structure/format.ts:336` | `group` and `step` are structural (no target). `chapter`, `part`, `member`, `mount`, `navigation` require a target. A new role matches neither and is rejected. | incidental | `target: required \| forbidden \| optional` on the role in the profile document. | ~15 lines |
| `services/main/src/modules/structure/format.ts:363` | Expected qualifier type is chosen by profile id and role: `work-part`, `zone-mount`, `ingredient-line`, `recipe-step`, or none. Book groups may also be `book-group` (`:367`). | incidental | The profile document names the qualifier id each role requires. | ~12 lines |
| `services/main/src/modules/structure/profiles.ts:93` | Book is constructed in this file. The other owners are discovered. | incidental | Book is a `structure-profile.ts` module like the others, or a data file the same loader reads. | move ~15 lines |
| `services/main/src/modules/structure/profiles.ts:129` | Discovery rejects an id that is not already a key of `PROFILE_ROLES`. | incidental | Accept an id that declares roles, owner type, and graph profile, and that passes the checks already in this function. | ~4 lines |
| `services/main/src/modules/structure/profiles.ts:202` | `structureProfileFor` throws when the id was not registered. | owner | Unknown ids still fail. Registration becomes the allowlist, so a declared id passes. | 0 lines |
| `services/main/src/modules/structure/format.ts:39` | `wiki-navigation` is one of the six ids and has roles at `:49`. No module exports it. | incidental | Delete the unused enum member, or ship its registration as data. It is not a free slot for the section list: its roles are `group` and `navigation`, and a navigation role forbids a qualifier (`services/main/src/modules/structure/format.ts:363`). | 0 lines to admit the section list |
| `services/main/src/routes/compositions.ts:43` | Create/change profile union is `book-composition`, `work-composition`, `recipe-composition`. Collection, zone, and wiki are absent. | incidental | Profile is a string `structureProfileFor` accepts. | ~6 lines |
| `services/main/src/routes/compositions.ts:57` | Insert roles omit `member`, `mount`, and `navigation`, and any new role. | incidental | Roles come from the registration. | ~8 lines |
| `services/main/src/routes/compositions.ts:66` | Optional qualifier on insert and update (`:79`) is `ingredientLine` or `recipeStep` only. Work-part uses separate `displayLabel` and `inclusion` fields (`:71`). | incidental | Qualifier body is the profile's field list. A note is one text field. | ~20 lines |
| `services/main/src/routes/compositions.ts:239` | Stage, seal, and refresh require `book-composition`. | incidental | Stage uses the structure's registered profile. | ~4 lines |
| `services/main/src/modules/structure/stage.ts:136` | Staged records are checked as `book-composition` (again at `:198`). | incidental | Check as the staged structure's profile. | ~2 lines |
| `services/main/src/modules/structure/change.ts:680` | Omitted profile becomes `book-composition`. | incidental | Omit is a 400. A named registered profile proceeds. The book-specific digest at `:684` stays for that one id. | ~3 lines |
| `services/main/src/modules/composition/disclosure-read.ts:56` | `book-composition` uses the resource reader. | incidental | Call `profile.authorizeTarget`, which work and collection registrations already supply (`services/main/src/modules/composition/structure-profile.ts:76`, `services/main/src/modules/collection/structure-profile.ts:16`). | ~15 lines to delete the branches |
| `services/main/src/modules/composition/disclosure-read.ts:57` | `collection-membership` and `work-composition` use `resolveTargets`. Any other id falls through to `canReadStructureTarget` (`:64`), which returns false without a principal. | incidental | The profile document names an existing reader: work, resource, or structure-target. | included above |
| `services/main/src/modules/composition/disclosure-read.ts:74` | Batch read exists only for collection and work composition. | incidental | Batch when the named reader has a batch form. Scalar remains correct for the others. | ~8 lines |
| `model/definitions/structure-composition-v1.ttl:15` | `rv:structureProfile` is an `sh:in` of Book, Collection, Zone, Wiki, and Recipe. Work is absent. | incidental | One shape. The profile IRI is the registration's `graphProfile`, checked because the node is a registered profile, not because it is a member of this list. | ~4 lines in the shape |
| `model/definitions/structure-composition-v1.ttl:66` | Occurrence role `sh:in` has Group, Chapter, Member, Mount, Navigation, Ingredient, Step, Equipment. No Part role. | incidental | Role IRIs are the profile's roles. Part already has to live in a second file because of this list. | ~4 lines |
| `model/definitions/structure-work-composition-v1.ttl:14` | A second shape admits only `rv:WorkComposition`. Placement roles are only Group and Part (`:26`). | incidental | Delete this fork once the shared shape takes the registration's profile and roles. | delete ~40 lines of duplicated shape |
| `infra/jena/command-module/src/main/java/com/rezics/jena/OccurrenceLabelIndex.java:43` | Label indexing runs only for `BookComposition` and `WorkComposition`. | incidental | Index every selected generation that has labels, or a `indexLabels` flag on the profile. | ~3 lines |
| `services/main/src/modules/structure/read.ts:244` | Measure read requires `recipe-composition`. | incidental | Measure read requires a profile that declares measures. | ~3 lines |
| `services/main/src/modules/structure/read.ts:367` | Completion is attached only for `work-composition` (also `:471`). | incidental | Completion is present when the profile document includes it. The section list does not. | ~4 lines |
| `services/main/src/modules/composition/structure-profile.ts:12` | Work-part projection is a function: display label, inclusion IRIs, `rv:composedWork`. | owner for the cycle guard at `:43`; incidental for the qualifier triples | Qualifier triples are a template over the declared fields (predicate, literal kind). The cycle guard stays code. | ~40 lines of template, deletes `projectWorkPart` |
| `services/main/src/modules/recipe/structure-profile.ts:22` | Ingredient and step projection and hydration are hand-written (about 110 lines, file is 159). | incidental | Same field template. Recipe-only reference checks (`services/main/src/modules/structure/format.ts:380`) run when the profile declares a field of kind "occurrence ref". | included in the template |
| `services/main/src/modules/zone/structure-profile.ts:84` | Zone mount is another hand-written qualifier (`project` at `:16`). | incidental | Same template. Reserved route segments stay an owner check. | included in the template |
| `services/main/src/modules/collection/structure-profile.ts:6` | Collection membership is a registration with no qualifier projector. | already data-shaped | A section list with only text notes needs the qualifier template above. Collection itself shows the registration object is the right place for owner type, roles, and disclosure. | 0 lines for collection |

Order keys, parent links, and language labels are already shared (`services/main/src/modules/structure/format.ts:113`–`:119`). They do not need a new kind. A note does: labels are a single string per language with a 500-character cap, and `checkOccurrenceQualifierRole` rejects a qualifier on a role that expects none. Putting the note in `labels` changes its meaning (a display label, not an entry note) and still requires no new profile only if the owner reuses `work-composition`. The case is a new kind with its own qualifier, so the enum, the route union, and both `sh:in` lists still reject it.

## Three changes, by blockers removed per line

Counts use the rows above. Size is the estimated edit, not the code it deletes.

| Rank | Change | Rows it removes | Estimate | Rows per line |
| --- | --- | --- | --- | --- |
| 1 | Replace the repeated Open Library identity literals with the observation's provider, namespace, and external id, plus one allowlist lookup for the mapping revision and the key template. Sites: `services/main/src/modules/source/graph-projection.ts:54`, `infra/jena/command-module/src/main/java/com/rezics/jena/SourceProjectionPolicy.java:57` and `:72`, both shapes' `sh:hasValue`, `infra/jena/command-module/src/main/java/com/rezics/jena/EditorialFieldPolicy.java:166`, `services/main/src/modules/work/title-control.ts:534`, `services/main/src/modules/source/field-control-native.ts:27`, `services/main/src/modules/source/native-work-adoption.ts:607`, `services/main/src/modules/work/author-credit.ts:27` and `:54`, `services/main/src/modules/source/native-work-proposal.ts:12`, `services/main/src/routes/sources.ts:95`, `services/main/src/modules/source/intake.ts:25`. | 14 | ~35 lines | ~0.4 |
| 2 | Let a structure profile document be the allowlist: drop the six-id enum (`services/main/src/modules/structure/format.ts:38`, `services/main/src/modules/structure/profiles.ts:129`), the route unions (`services/main/src/routes/compositions.ts:43`, `:57`, `:66`), and both `sh:in` lists (`model/definitions/structure-composition-v1.ttl:15` and `:66`, `model/definitions/structure-work-composition-v1.ttl:14` and `:26`). Qualifier fields are text, enum, boolean, rational, or IRI list, which covers a note. Disclosure calls the registration's existing reader instead of `services/main/src/modules/composition/disclosure-read.ts:56`. | 16 | ~70 lines | ~0.2 |
| 3 | One projector reads `source.field_disposition` and emits one claim per row. That deletes the Open Library field switch (`services/main/src/modules/source/open-library-conversion.ts:126`), the two-field reification list (`services/main/src/modules/source/reification.ts:13`, `infra/jena/command-module/src/main/java/com/rezics/jena/SourceProjectionPolicy.java:84` and `:95`, `model/definitions/source-reification-v1.ttl:16`), the VNDB parser (`services/main/src/modules/source/field-vndb.ts:46`), the recipe `SLOT` (`services/main/src/modules/recipe/source-conversion.ts:12`), and the Bangumi fact functions (`scripts/datasets/bangumi.ts:881`, `:952`). Native slots are `native_target` values, so synopsis stops being `projection.description` (`services/main/src/modules/source/field-application.ts:51`). | 12 | ~120 lines | ~0.1 |

Change 3 removes the most code and is what makes facts and credits real. Change 1 removes more blockers per line because the same three strings are copied through the command path. Change 2 is the whole of case 2.

## Owner decisions, which stay decisions

| Decision | Where | Why it stays an owner decision |
| --- | --- | --- |
| Which predicates a source projection may write | `infra/jena/command-module/src/main/java/com/rezics/jena/SourceProjectionPolicy.java:20` | The command refuses an unreviewed predicate inside the transaction. The list can be profile data. Admitting a new predicate is a review of that profile. |
| Source text is not a native fact until someone accepts it | `services/main/src/modules/source/reification.ts:9`, `model/definitions/source-reification-v1.ttl:32`, `services/main/src/modules/source/field-application.ts:54` | The disposition is `structured-source-only` until an explicit accept. Bangumi's importer posts that accept itself (`scripts/datasets/bangumi.ts:1016`). A mapping must not accept its own facts. |
| Whether raw provider bytes may be stored | `services/main/src/modules/source/intake.ts:160` and `:212` | The retention gate is already a function of provider and namespace. The terms decision is a person's. The Open Library URL check around it is incidental and is listed above. |
| Who may edit, and which existing reader applies | `services/main/src/modules/structure/profiles.ts:43`, `services/main/src/modules/composition/disclosure-read.ts:56` | Naming `work:read` or the work-target reader is data. Inventing a permission or a new disclosure rule is not. |
| A Work must not contain itself through composed Works | `services/main/src/modules/composition/structure-profile.ts:43` | Four-level cycle refusal is a graph invariant of "this Work contains that Work". The section list needs this guard, or an explicit decision that cycles are refused. The SPARQL is not a qualifier field. |
| Admitting a profile into the command module | `services/main/src/infrastructure/profile.ts:5`, `infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java:385` | The Turtle can be the source profile the thesis asks for. It runs only after the reviewed hash matches. That review is the activation decision the expansion protocol assigns to a person. |
| A credit's control and rights | `services/main/src/modules/work/author-credit.ts:56` | Provider and key should be data. `HumanConfirmed` and `Undetermined` are the accept step, same as statement acceptance. |
| Calling a remote host | `services/main/src/modules/source/open-library.ts:62` and `services/main/src/modules/source/intake.ts:180` | The URL template and the interval belong on the allowlist. Turning fetching on for a new host does not. This test assumed the operator supplied the bytes, so this row is outside the fixture. |
