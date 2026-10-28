# Semantic core and launch catalogue integration audit

## Finding and evidence boundary

The original semantic objective is **not evidenced complete**. The integrated tree contains substantial
implementation and real API acceptance bodies. Current main does not contain that implementation or its API
driver. No stored root-gate baseline for the inspected main commit was found. Integration receipts, compiler
tests and service registration therefore cannot establish the required main-merged, full-native API outcome.

The launch catalogue is also incomplete independently of promotion: anime release/version grain has no
identified concrete configuration witness; the agreed library profile registry has compiler support but no
bundled launch declarations; and the definitions recording guard and bundle producer remain unfinished.
These findings do not declare the research task or any unrelated owner blocked. This report is evidence for
the completion decision, not a replacement completion contract or an implementation proposal.

Reference and task/landing snapshot: **2026-10-28 12:07:36 UTC**. State claims refer to that snapshot,
not live state; the separately timed manager-status observation is recorded in the ignored evidence map.
Git, SQLite and document reads are not one atomic cross-system snapshot.

| Inspected reference         | Commit                                     | Interpretation                                                  |
| --------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| Audit worktree base         | `34dbc5607bf58f36722fb7e252df58fc1120d541` | Source and test bodies read from this tree                      |
| Local main                  | `90ffc5216ae62d52d4534696b3e6957b9ffbe8f8` | Completion target inspected with Git object reads               |
| Local dev                   | `3f587a8b5494992a46d976df56d9752453a29ed4` | Current integrated reference at cutoff                          |
| Local stabilize             | `a40b0ea35b4eb92dab2c41082fdd6b24031ce7f9` | Separate reference; its existence is not promotion proof        |
| Remote-tracking main        | `bc90e2d8b1afcab25a99f8ee80a7bb356bef3148` | Stale relative to local main; not used as the completion target |
| Discussion authority mirror | `7ff5c2aa6034f8fbd9951cf477c040804b125f65` | Existing local design-source checkout, read only                |

Main is an ancestor of dev; `git rev-list --left-right --count main...dev` returned `0 3783`.
The audit base is also an ancestor of dev. The six commits between the base and inspected dev change only
`docs/research/imports-audit/deferred-cover-recovery.md`, `packages/conversion/README.md`,
`services/importer/tests/deferred-cover-recovery.test.ts` and `services/kernel/src/content/README.md`.
No semantic/catalogue/test body cited here differs in that delta. This is an explicit comparison, not an
assumption that an earlier checkout is current dev. Future movement of any reference needs a new pin comparison.

The complete governing `.temp/goal/managers/semantic.md` and `.temp/goal/semantic/CONTINUATION.md` were read
from the main checkout, followed by focused owning documents, production source and actual test bodies.
Control-plane records were queried through a read-only SQLite connection to `.temp/goal/goal.sqlite`.
Task, current-attempt, result-record, landing, promotion, baseline, manager-session and inbox metadata were
distinguished. An integrated task or an exited attempt is not a completion certificate.

No gate, native test, check-host command, service, build, installation or runtime experiment was started.
No environment, credential or local-configuration secret was opened. Runtime fixtures and hidden fixture data
are not reproduced. The ignored worker-local `.temp/semantic-integration-audit-state.json` holds the useful
identifier/state/dependency map, receipt candidates and ancestry results; identifiers are deliberately absent
from this report. That map is diagnostic evidence, not a published authority or a control-plane mutation.

## Requirements derived before assessing completion

The governing original Done-when requires **all** of the following on main, passing `bun scripts/gate.ts`,
with real API outcomes for anonymous readers, editors, Context acceptors and suspended accounts:

1. A versioned, schema-validated catalogue defines types, properties and value constraints. Book work and
   edition, recipe, and a fixture third type work end to end from definitions without their own backend code.
2. Publication is immutable; activation and historical release pins preserve meaning across changes.
3. Candidate statements carry references. Context acceptance is distinct from adoption. Wikibase ranks,
   competing values and disputed/rejected values retain provenance.
4. Each adoption creates a new subject revision in the subject partition. Commands own one partition;
   revision identifiers are never reused, including concurrency and replay paths.
5. Relations use item values. Referenced labels are filled by partition-batched point reads. Inbound links
   are an asynchronous outbox projection in the target partition, with declared and observable freshness.
6. Subject merges leave a redirect and reads follow at most one hop, including referenced labels.
7. Actual writes pass the current Accounts Access formula with the correct authority, principal and scopes.

The added catalogue outcomes retain every original requirement and add:

8. VN work plus platform/language release; anime work, season, episode and release/version; manga, game,
   character and series profiles at the independently referable grain in engineering discussion §6.
9. Credits are role-property statements with credited-as, order and detailed-role qualifiers. Appearance
   is `schema:character` / P674 plus a role qualifier, rather than an independent credit backend.
10. Classification uses SKOS ConceptScheme/Concept and `foaf:focus`. World-series membership is adopted
    statements, distinct from collection/list membership.
11. Eight locale labels, Context settings, saved filters and Zone starter configuration accompany verticals.
12. A new vertical adds no backend path, table, deployment or executable configuration. Query cost stays
    within budget at 10 and 100 manifests; compilation/byte limits are additional evidence, not that cost proof.

The continuation adds relevant already-agreed delivery prerequisites: canonical library profile registry and
closed type references, whole-profile inheritance, historical pins, eleven accepting launch declarations,
an unattached legacy profile, explicit percent dimensions, and synchronized generated definitions recordings.
Commerce consumes that ABI in its own implementation; the compiler does not prove consumer migration.

The frozen original **13 Search outcomes plus 6 relation-facet outcomes**, their real default services, and
the current semantic API persona suite remain required. Native internal and helper tests supplement these
outcomes. They do not replace them. Creation declarations and per-write original-revision author anchors are
cross-owner prerequisites here; this report does not expand into another lifecycle inventory.

Evidence classifications used below:

| Class         | Meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Proven source | Directly established by the inspected code/data or exact commit ancestry; not a runtime pass            |
| Incomplete    | A required artifact or dependency is present only in part, or an owned producer is unfinished           |
| Contradicted  | A concrete inspected artifact disagrees with a proposed broader completion claim                        |
| Weak/indirect | Relevant assertion, historical receipt or helper exists, but does not cover the whole claim             |
| Missing       | No matching artifact or current-pin execution/completion evidence was identified in the inspected scope |

Every runtime completion claim below still has the overarching **main and root-gate evidence missing**.

## Main versus integration and stored execution evidence

`git ls-tree` on main shows only `book.yaml`, `core.yaml`, `recipe.yaml` and `rezics.yaml` in the catalogue,
with the early flat English/Japanese/Traditional Chinese presentation files. Semantic production files are
the early definitions, create/read subject, item/rules/profile and partition-page implementation.
Main has `services/kernel/test/semantic/definitions.test.ts` and `rules.test.ts`; it has neither the current
`semantic/outcomes.test.ts` wrapper nor its real `outcome-driver.ts`, candidates, Context adoption, merge or
inbound-link implementation. The declaration `specs/semantic-outcomes.test.ts` on main cannot execute the
required API outcomes without a driver. Thus “integrated” and “main merged” are concretely different here.

Selected stored receipts were checked against actual ancestry:

| Capability                   | Receipt commit                             | Stored scope and result                                                                | Ancestry / limit                                                        |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Semantic API wrapper         | `ea8974280aa77776974281dd71b44c79cc6103f3` | Kernel check of `test/semantic/outcomes.test.ts`; passed merge stage                   | Ancestor of inspected dev; absent from main                             |
| Semantic driver repair       | `75bb0559797513b3d666c243dbe177baeaa2654e` | Kernel check of `outcome-driver.test.ts` and `outcomes.test.ts`; passed merge stage    | Same ancestry; historical scope only                                    |
| File-only vertical expansion | `d1fff1e45bb55585ed1f1c2f66d7bbf0a9224634` | Kernel `test/semantic/expansion.test.ts`; passed merge stage                           | Same ancestry; not a full default/native gate                           |
| Expansion follow-up          | `b5ad51ce8166fba066bc2a2f4c48c79268c2d000` | Same expansion file; passed merge stage                                                | Same ancestry; later source changes are not revalidated by this receipt |
| Library profile compiler     | `6c58958d839fe4c9aff636c3030c2a5d44c375ef` | Definitions profile and expansion tests, with the launch-data test explicitly excluded | Same ancestry; cannot prove bundled launch data                         |

The compiler acceptance uses a negative test-name pattern excluding
`book anime game visual novel and recipe library profiles are configuration only`.
This exclusion is an intentional slice boundary visible in the recorded command and the owning design
document. A green receipt for that command must not be reported as passing the excluded launch outcome.

No `landing_baselines` entry names current main `90ffc5216ae62d52d4534696b3e6957b9ffbe8f8`.
The recorded promotion is `stabilize-blocked`, with different pins:
main base `4031f5a86c8599ea8db9730c6b8bd9e4c218582d` and dev head
`bc2d98c0652a0b68587552e2ed94bb68b86b48db`. Its root command is `bun scripts/gate.ts`;
its recorded failed subcommand covers Content media and Imports identity/media-boundary files.
That record establishes an earlier promotion failure, **not** a fresh failure or pass at either current pin.
Stored output from a different commit/scope was not promoted to current execution evidence.

The manager session has operational status `running` and its embedded goal state is `active`; neither is
semantic completion. Recent inbox records
are instructions/conflict notifications. No current-pin completion verification was identified among the
inspected baseline/promotion/session records. Missing evidence is not a claim that an uninspected log passed,
nor a claim that the controller cannot later produce a valid receipt.

## Original core outcomes: requirement-by-requirement

### Definitions, immutable publication, activation and pins

**Proven source; runtime/main proof missing.** `packages/definitions/schema/release.json`, `src/index.ts`
and `src/compile.ts` define/validate the release. `src/bundled.ts:31-48` discovers YAML/presentation/settings/
filter files and reads a generated bundled release. Validation has closed limits and datatype-specific
constraints; `packages/definitions/README.md:3-21` documents the schema and bounded validation surface.

`services/kernel/src/semantic/definitions.ts:27-77` validates stored content, recomputes digest on read and
freezes cached releases. Publication at `:115` uses `runCommand`; `definitions-publish.sql` inserts by
`(route,digest)` with `ON CONFLICT DO NOTHING`. Activation at `definitions.ts:142` verifies a published
digest and uses an expected-head update/history record. Historical reads address the digest, not the current
active body. These are API/storage-path immutability witnesses; they do not establish an unrestricted
database administrator cannot mutate rows. No such stronger claim is needed or inferred.

`specs/semantic-outcomes.test.ts:349` asserts anonymous active-pointer and immutable-release cache behavior.
The body at `:381` compiles a music fixture, publishes/replays it, activates with expected head, rejects a
stale activation, creates its objects through the API and checks release pins. At `:468`, editor/anonymous/
suspended publication and activation are denied, invalid releases are not stored and unknown activation fails.
Those concrete assertions cover more than a schema helper, but no current full execution receipt was found.

**Minimal missing evidence:** the unfiltered semantic suite and root gate passing for the main commit that
contains these artifacts, with the actual driver/command identified. A publish helper green or a cached
release object alone is insufficient.

### Book work, edition, recipe and third type without backend code

**Proven configuration and API assertion bodies; full runtime evidence missing.** `catalogue/book.yaml`
separates `schema:Book` work from `bf:Instance` edition, with `schema:exampleOfWork`; `recipe.yaml` declares
the recipe constraints. `specs/semantic-outcomes.test.ts:501` creates work, edition and recipe, checks
Wikibase-shaped values, references/ordering, related labels, replay without a new revision and conflict on
changed idempotent input. At `:584`, invalid type, property, target, qualifier, rank and quantity inputs
produce specific field errors without a successful subject/location response.

The third-type witness at `:381` is a compiled MusicComposition fixture alongside existing books. It is a
data extension served by the generic API, not a product music importer or a backend branch for that type.
`services/kernel/test/semantic/expansion.test.ts:273` adds fixture files, compares OpenAPI and database
relations/columns/indexes before and after publication, and exercises create/propose/accept/adopt/read/labels.
It rejects executable LinkML features. The test's unchanged-process/schema/API checks support the absence of
new code/table requirements; they are not an independent deployment-system inventory.

**Minimal missing evidence:** execution of both the full semantic API suite and this expansion acceptance at
the completion pin. Preserve the file-only fixture and schema/API comparisons; do not substitute pure compile.

### Candidate, reference, acceptance, adoption, rank and provenance

**Proven source and substantive assertions; disputed coverage is specific rather than universal.**
`semantic/candidates.ts:138-322` proposes immutable candidate/fact data under `runCommand` with a release pin
and original revision. `semantic/slots.ts:100-178` reconstructs candidate facts and rejected/deprecated ranks;
`:178-219` resolves Context-local replace/suppress versus inherited values. Acceptance and adoption have
distinct append paths in `candidates.ts:386-553` and `:573-813`.

`specs/semantic-outcomes.test.ts:656` checks proposal revision 2, acceptance revision 3 without changing the
display, and adoption revision 4. It retains references, original revisions and preferred versus normal
competing values. At `:746`, a rejected date remains deprecated with its reference/origin, and relation
adoption stays in its addressed target slot. At `:864`, community accept/reject/replace/suppress/inherit
decisions differ from Global and ungranted Context writes fail.

These bodies cover pending/accepted/adopted, competition and a concrete rejection/dispute history. They do
not assert every property/rank/qualifier/provenance combination or a separate universal “disputed” lifecycle.
There is no basis to discard the assertions, or to inflate one rejected-date case into arbitrary dispute
coverage. Any broader disputed-provenance completion claim needs its exact required observable scenario named.

**Minimal missing evidence:** matching full API execution, preserving assertions for unchanged display after
acceptance, competing values, retained references/origins and Context-local decisions. If a broader dispute
scenario is required beyond these existing bodies, its ownership/acceptance must be made explicit.

### Revision append, partition boundary, concurrency and no reuse

**Proven mechanisms and representative API assertions; universal runtime invariant not independently proved.**
Proposal/accept/adopt use `partitionOf(subject route)` in `candidates.ts:170`, `:389` and `:576`.
Editorial revision append at `:338` and adoption at `:690-718` allocate the next subject revision.
`db/semantic/schema.sql:648`, `:960`, `:1243-1250` provide the composite revision primary key and immutable
update/delete/truncate guards. These enforce append identity at the storage boundary rather than a reused
mutable revision object.

The API body at `specs/semantic-outcomes.test.ts:656` inspects revision rows `[1,2,3,4]`, the subject partition
and four distinct recorded transactions. At `:825`, concurrent adoption with one expected head yields one
success and one conflict, one new revision, an idempotent winning replay and rejection of a changed payload.
The merge body at `:1137` separately checks the redirected subject's revision/transaction behavior.
Internal `test/semantic/candidates.test.ts:391` also targets revision paging and partition ownership; it is
supplemental, not a substitute for the API body.

A route/transaction assertion on selected revision rows does not trace every SQL write of every command.
The source `runCommand` boundary and constraints supply structural evidence; no all-path native invariant
receipt at the completion pin was found. **Minimal missing evidence:** full API/native receipts retaining
concurrency/replay assertions and the relevant command/storage invariant acceptance, followed by main/root proof.

### Item relations, batched labels and reference authorization

**Proven source; current full display and cost acceptance incomplete.** Item-valued properties are declared
in the release, validated generically and rendered with related labels. `semantic/subject.ts:593-661` deduplicates
IDs, groups by partition and runs one label statement per partition, with a 256-ID bound. `:694-764` batches
related visibility/security/labels/redirect state, then loads one redirect target hop. This is a point-fill
design; the redirected target can require another partition batch, so it is not “one SQL total.”
Batching also does not establish bounded history work: `read-labels.sql` and `read-related.sql` use lateral
fact reads with latest-per-language ordering over asserted label history. The subject identity probe is a
point seek, but a fixed statement count alone cannot prove that label-history rows touched stay within the
required budget. That remains part of the existing display/growth evidence gap.

`semantic/http/subjects.ts:615-701` supplies real per-target read authorization and summary dependencies.
`semantic/references.ts:9-27` authorizes the source identity in the same read-only snapshot and exposes only
the identity and partition component; it explicitly does not follow/authorize a destination automatically.
The integrated authorized-reference helper is a prerequisite, not a full display implementation.

API bodies at `:501`, `:656` and `:1137` check specific referenced labels and redirected labels. The current
registered full display/authorized-summary writer is stopped at attempt 3. The related-page performance
producer is stopped at attempt 6; the continuation preserves actual early related-read failures and missing
higher-scale observations. Some page seeks passing does not prove the full six-file native/growth acceptance.
The preserved page-seek candidate resolves to `eff3ac6bf5c010671b4ebb21f7c08ad7cd662637`.

**Minimal missing evidence:** the existing display/related-label native and growth acceptance, including
denied/unavailable/redirect targets, and the complete existing page-seek acceptance. No new display producer,
latency relaxation, cache workaround or duplicate bounded-leaf research follows from this audit.

### Outbox inbound projection and freshness

**Proven source and real projection fixture; default-service completion incomplete.**
`semantic/links.ts:184-191`, `:287-340` and `:787-849` group projection changes by target partition and apply
them through partition commands/relay. `:866` declares eventual consistency with `target_seconds: 10`.
`link-freshness.ts` supplies bounded catch-up checks; `links.ts:928-942` and `:1043-1074` preserve `caught_up`
as an observable result rather than blocking indefinitely.

`specs/semantic-outcomes.test.ts:1089` checks editor-session links and eventual anonymous visibility within
15 seconds, including the 10-second target metadata. At `:1109` it pauses the real projection, expects a stale
response within three seconds with `caught_up: false`, then resumes and observes catch-up. A declared
10-second target and a 15-second deadline test are different facts: the latter is not proof of a hard 10-second SLA.

`test/semantic/outcome-driver.ts:413` starts the production `linkProjection` relay in a fixture runner.
`src/worker.ts:99` also registers it in the default worker. This establishes code composition for this relay,
not completion of all relation-source invalidation/fence services. Those dependencies remain registered.

**Minimal missing evidence:** the unfiltered API execution for stale/catch-up behavior and real default-worker
Search source/update acceptance at one completion pin. Manual fixture relay success cannot establish the latter.

### Merge redirect and one-hop reads

**Proven source and explicit API assertions; main/runtime proof missing.** `semantic/merges.ts:55-98`
chooses the deterministic default survivor and commands the redirected subject partition. `:102-157` appends
the redirected subject revision, records the redirect and emits the merge event. Existing redirects/type
checks prevent an ordinary merge from constructing chains/cycles. `subject.ts:728-764` follows one hop for
related labels; it preserves the stored original relation value.

`specs/semantic-outcomes.test.ts:1137` asserts the smallest-UUID survivor, HTTP 308 with Location, related
labels resolved to the survivor, unchanged stored relation identity, unchanged survivor revisions, a new
redirected-subject revision, replay and chain/cycle/type rejection. This covers the stated API merge contract;
it does not prove every consumer, web cache or later alias-group implementation is migrated.

**Minimal missing evidence:** current main full API receipt for this body. Broader structural identity and
terminal/alias consumers already have registered dependencies and are not new work proposed here.

## Access formula and actual API personas

**Proven production route wiring; current acceptance is meaningful but bounded.**
`semantic/README.md:44-71` enumerates authority/action bindings. Create/propose/merge/publish/activate use the
seeded Global Context; accept/adopt use the selected Context. `semantic/http/subjects.ts:372-392` uses the
same-partition `authorizeCommand` or the cross-partition `resourceAuthorization` seam. At `:463-493`, real
subject creation passes that authorization into `createSubject`. Definition routes similarly prepare and
pass `CommandAuthorization` (`semantic/http/definitions.ts:96-108`, `:214-227`).

`access/resource-authorization.ts:94-110` documents the prepared single-use proof bound to the action, actor,
authority, target partition, attempt and authoritative time. `access/permission.ts:131-143` checks active,
unfenced account identity and authentication epoch; `:180-226` evaluates the anonymous eligible floor or
authenticated scope/grant branch at the authoritative time. A public floor is not a substitute grant for
protected writes. `command/command.ts:425-479` performs authorization before receipt lookup and execution.
The audit does not introduce a competing permission formula or revisit the already-owned bounded Access design.

The API driver is substantive: `specs/semantic-driver.ts:1-24` requires migrated PostgreSQL and production
kernel/Access. `test/semantic/outcome-driver.ts:209-231` composes real kernel/Access/Auth; `:270-283` obtains
personas through Auth workflows; `:334` uses `app.handle`; `:361-411` creates real grants and suspends an
account through the current authority. It is not an `authorize: true` stub. Its broad issued action scopes
and explicit fixture grants nevertheless do not cover every independent grant/scope dimension.

| Persona               | Actual assertions in `specs/semantic-outcomes.test.ts`                                                                                                              | Exact limit / missing evidence                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous reader      | `:349` active/release reads; `:468` cannot publish/activate; `:952` cannot create/propose/Context-create; `:1089` eventual links; `:1199` indistinguishable bad IDs | No anonymous successful write is claimed; current full execution and default Search receipt missing                             |
| Editor                | `:501` creates work/edition/recipe; `:656` proposes; `:952` cannot accept/adopt/merge; `:381` uses fixture type                                                     | Standing grants plus broad token scopes do not prove every missing-scope, transferred/revoked-grant or narrow-token combination |
| Context acceptor      | `:656` accepts/adopts; `:864` Context-specific outcomes; `:952` denials for another Context and granted creation/proposal; `:1137` merge                            | Persona grants are explicit fixture configuration; Context-local effects do not imply authority over all Contexts               |
| Suspended account     | `:468` publication/activation fail; `:952` protected writes and seven read routes return 401                                                                        | Concrete route coverage, not an exhaustive claim for every newer route; real current-pin execution missing                      |
| Steward, supplemental | `:381` publication/activation/replay; `:468` positive control and invalid release behavior                                                                          | Extra definition-governance persona supplements the required four; it does not replace them                                     |

`test/semantic/outcomes.test.ts:9-29` spawns the suite, requires exit zero, the exact declared pass count,
zero failures and no skips/todos. There are **14 current semantic `test(...)` declarations**, not a pass count
inferred from a name or an earlier inventory. The wrapper is strong execution enforcement when actually run;
this audit found no current completion-pin full-run proof to attach to it.

The fixture currently has `person(name)` without the required independent capability options and its request
surface lacks DELETE. A registered fixture-capability producer is stopped at attempt 3. That gap already has
an owner; frozen acceptance must not be weakened to fit the fixture.

`semantic/authored.ts:7-9` currently retains the prepared authorization while rebinding the recorded subject
resource; authored documents flow through the existing Content hook. The continuation requires compatible
Content creation declarations and a per-account-write anchor derived from the original revision before retiring
that compatibility seam. Accounts creation declarations and native-time support have integration evidence;
the semantic contribution writer is held behind state/command/store and compatible Content hooks. These are
current cross-owner prerequisites, not proof that the new anchor flow is already implemented. Keep the Global
formula, original revision and no imported-author/backfill grants; no lifecycle port inventory is added here.

## Added launch catalogue outcomes

| Requirement                           | Direct source/test-body evidence on dev                                                                                                                                                                  | Assessment and minimal missing evidence                                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VN work and platform/language release | `catalogue/visual-novel.yaml` uses `wd:Q689445`; `game.yaml:31-75` supplies shared `wd:Q20631656` release with work/platform/language slots; `test/visual-novel-profile.test.ts` asserts that split      | Proven configuration. Shared release is valid reuse; a cross-product of every work platform/language is not implied. Main and actual API configuration execution still missing                                 |
| Anime work/season/episode/release     | `catalogue/anime.yaml` declares TVSeries, Movie, TVSeason, Episode; `test/anime-profile.test.ts:40-100` asserts those four and episode parent/number                                                     | Incomplete release/version witness. The test title mentions releases but its body does not assert a distinct release type, linkage or independently referable version. Movie is a work, not proof of a release |
| Manga grain                           | `catalogue/manga.yaml` declares `schema:ComicSeries` work and `schema:PublicationVolume` with credits and classification; `test/manga-profile.test.ts` asserts mappings, fields/facets and locale labels | Proven schema/assertions. Not proof of end-to-end native manga writes or every independently referable edition/version; main/current runtime evidence absent                                                   |
| Game work/release/add-on              | `catalogue/game.yaml` separates VideoGame, VideoGameRelease and GameAddOn; `test/game-profile.test.ts` checks source fields, release targets, facets and labels                                          | Proven configuration. No game-specific backend is required by these declarations; full generic API/growth receipts remain mandatory                                                                            |
| Character                             | `catalogue/character.yaml` declares fictional character with traits/appearance terms; `test/character-profile.test.ts` and shared terms test validate range and labels                                   | Proven configuration. Appearance provenance/adoption has generic-path evidence, not a new character-native outcome receipt                                                                                     |
| Series distinct from lists            | `catalogue/series.yaml` declares Series/BookSeries; `test/series-profile.test.ts:49` and `test/shared-terms.test.ts` assert `wdt:P179` on the member with position qualifier                             | Proven statement shape. Generic adoption evidence is relevant; no observed API body specifically creates/adopts series membership while independently changing a collection                                    |
| Qualified credits                     | `core.yaml` role slots and `book.yaml` publisher/translator use creditedAs/position/detailedRole; `test/shared-terms.test.ts:96` iterates role mappings/ranges/qualifiers                                | Proven configuration and compiler assertions. `schema:position` maps P1545; it is not a missing literal P1545 slot. Full all-role API execution is not asserted by this helper                                 |
| Qualified appearance                  | `core.yaml:645-658` maps `schema:character` to P674 with detailedRole and other qualifiers; shared test checks character/voice-role targets                                                              | Proven configuration. Detailed role P3831 satisfies the role qualifier shape; voice character P453 is a separate related qualifier. Native outcome evidence remains generic                                    |
| SKOS and focus                        | `classification.yaml` declares ConceptScheme/Concept, inScheme, broader and foafFocus; shared test validates focus on `schema:Thing` and inheritance extension                                           | Proven configuration. No backend classification-use entity is required. A compile fixture is not an API acceptance/adoption scenario                                                                           |
| Eight locales                         | Profile/shared tests assert nonempty labels for `de`, `en`, `es`, `fr`, `ja`, `ko`, `zh-Hans`, `zh-Hant`; presentation groups are discovered by `src/bundled.ts`                                         | Proven bundled structure/assertions, absent from current main's three-locale early catalogue. Not proof of complete translated UI behavior                                                                     |
| Context settings and saved filters    | `contexts/`, `filters/`, and `test/vertical-bundles.test.ts` cover all eight vertical groups and matching type filters                                                                                   | Proven inert data. Settings defaults are allowed to be empty; their existence does not prove Context activation/adoption behavior                                                                              |
| Zone starters                         | Vertical presentation starter JSON; `test/vertical-bundles.test.ts` validates registry references, scope and home TypeList/filter alignment                                                              | Proven configuration validity. It does not instantiate a production Zone or prove actual default/runtime membership; that chain belongs to the separate Zone/composition audit                                 |

The independently referable anime release/version requirement remains explicit in the original added catalogue
scope and discussion engineering §6. No catalogue class named release is required merely for naming symmetry;
an existing generic type could satisfy the requirement if its actual configuration, constraints and API witness
were identified. None was found here. `bf:Instance` is documented as a book edition, and the software release
is for game/VN works; neither is evidence of an anime release simply because its base range is broad.
This is an uncovered outcome, not authorization to invent another architecture.

### Library profile compiler, bundle, registry and recordings

**Compiler source proven; bundled outcome concretely incomplete.** The integrated compiler at
`6c58958d839fe4c9aff636c3030c2a5d44c375ef` implements `src/compile-library-profiles.ts`, the closed profile ABI,
nearest-base whole-profile inheritance, canonical registry interning and locale presentation homes.
`test/library-profiles.test.ts` covers closed references, explicit legacy handling and historical pins.
`test/library-profile-expansion.test.ts:17-81` compiles 10/100 file-only manifest sets and accounts exactly for
canonical registry and reference bytes, preserving the plain release and unrelated types.

`src/library-profile-design.md:212-247` names eleven actual accepting declarations: book work/edition;
anime series/season/episode/film; game work/release/add-on; VN; recipe. Each needs its agreed state, progress,
copies and eight-locale labels. `legacy-fixed-v1` remains unattached; all 18 legacy mode/unit pairs and bounds
are retained. Explicit percent dimension applies to the agreed percent pairs, with scalar-percent maximum
100; cursor-percent is not silently capped. No production unit-name guessing is justified.

Direct JSON inspection of `release/rezics.json` found **24 types, 101 properties, no `libraryProfiles` member
and no type `library` references**. The active and release recordings share
`sha256:62ffcac2e2acd972d9c96e71fbad6621aabf50ca71bbaeb78983c94a4ce2cdd5`; their release also has no registry.
Matching recorded digests alone cannot prove regeneration against current source or the absent profile data.
The older numeric catalogue inventory in `packages/definitions/README.md:23-26` is stale relative to the
inspected JSON; it was not used as actual launch inventory or growth measurement.

The full launch-data body `test/library-profiles.test.ts:640-656` requires every declared accepting type's
closed reference, complete compiled profile, all eight locales, the unattached legacy registry object and
absence on Person/Organization/Concept/ConceptScheme. Its exclusion from compiler acceptance explains why
compiler integration is compatible with a missing launch bundle; it does not satisfy that body.

The Web recording-guard producer is stopped at attempt 6; the launch-data producer is held before attempt 1,
after compiler and guard dependencies. Current `apps/web/tests/recorded-responses.test.ts:27-190` checks typed
response shape and a nonempty expected file inventory, not the required new registry/recording semantic guard.
`apps/web/scripts/record.ts:1523-1530` fetches active then the same digest's release and rejects digest mismatch.
The continuation requires both recordings regenerated through that script in the same change as each bundle
change. Existing type-shape green cannot establish this newer requirement.

**Minimal missing evidence:** guard integration, then the existing single bundle producer delivering the eleven
profiles, complete legacy object, generated release and both recordings together; unexcluded launch-data and
profile-expansion acceptance; the actual recording guard receipt and main/root proof. Commerce's resolver and
consumer migration remain its own registered work, not a compiler completion inference.

### Expansion and cost: what each witness actually measures

`services/kernel/test/semantic/expansion.test.ts:174-240` serves the added vertical through generic production
routes. `:689-743` checks operations at scales 1, 10 and 100 with row/block/statement budgets and fixed
background data; `:745` checks 100 manifests add 300 types and 1,200 properties within release limits.
This is the closest runtime witness for the original manifest-cost requirement. The fixture uses a real
kernel/Access path, but seeds its accounts/grants through SQL and uses a permissive rate-limit fixture.
It does not substitute for native Auth persona outcomes or the real default worker.

The definitions profile expansion test instead measures compilation output, canonical bytes, interning and
limits. `test/semantic/growth-definitions.test.ts` uses internal calls with a permissive authorization callback.
Neither establishes API permissions or end-to-end/default query cost. The historical expansion receipts above
are useful scoped evidence; no current-pin full growth run was found. No measurements were fabricated or
rerun to close that gap.

**Minimal missing evidence:** existing expansion native/growth acceptance with all 10/100 budget assertions at
the final source pin, plus the full API/default suites and root gate. Do not replace measured rows/blocks/
statement budgets with elapsed-time anecdotes, a schema-file count or successful publication.

## Frozen Search outcomes and current default composition

The original 13 bodies are still visible in `specs/search-outcomes.test.ts:199-506`: language folding,
aliases/descriptions versus statement text, persona policy, 15-second freshness, adopted filters/negation,
immediate takedown/hide suppression and refill, signed stable paging/totals, rebuild/token invalidation,
typeahead/admission/budgets, and retryable index unavailability while subject reads continue.

The additional six are `specs/search-relation-facets.test.ts:173-415`: an adopted author outside the bounded
sample (positive, negative and nested predicates for every one of 129 authors); honest lower-bound facets;
hidden/taken-down source suppression while paused; declared author adoption refresh of the source within one
15-second deadline; hidden relation-target suppression; and refusal of qualified relation filters without
changing unqualified semantics. At `:314-349`, accepted-but-unadopted candidates must not match, adopted values
must refresh positive and negative views, inbound targets must not become outgoing author witnesses, and
suspended search/suggest are refused. These assertions cannot be replaced with “source factory exported.”

`services/kernel/test/search/outcomes.test.ts` and `relation-facet-outcomes.test.ts:9-35` enforce the exact
declared pass count, exit zero, zero failures and no skips/todos. `outcome-driver.ts:4-7` constructs the native
driver client. `support/outcome-worker.ts:75-116` decorates actual default modules' service starters, calls
`startWorker`, and requires one real search service plus real semantic services. Its rebuild path at `:160-169`
uses production `subjectSource`. This is strong fixture architecture, not evidence the fixture ran successfully.

There is also a direct composition mismatch: `src/work/modules.ts:69-79` lists the actual default modules
without a `semantic` module, while `support/outcome-worker.ts:110-116` requires one with a started service.
The standalone link relay in `src/worker.ts:99` does not satisfy that module/factory requirement. Thus an
already-complete default-composition claim is **contradicted by current source**, independently of missing
execution receipts. Separately, `semantic/scope-leaf-evidence.ts:92-103` explicitly returns `not_ready` for
valid requests without Access/SQL work. Its honest exported signature is an owned prerequisite, not current
leaf evidence or permission proof. No replacement algorithm is proposed here.

The actual relation-facet source producer is stopped at attempt 7. Tuple dependency/fence invalidation,
pair-absence correctness and final default composition are held in the registered chain. The existing source
lower-bound/selective-evidence question already has completed research and a pending owning decision; it was
not researched again here. The conditional ordered-Zone question likewise belongs to its existing chain.

**Minimal missing evidence:** the original unmodified 13+6 outcomes passing through this actual driver and
default worker after those real exports integrate, with current source-fence/update behavior and matching
native/growth acceptance. A staged fixture, helper certificate, missing-export fallback, isolated internal
unit, registered service name or stopped source candidate supplies no substitute proof.

## One authority per converted topic

Repository `AGENTS.md` requires replacing a converted topic's discussion page with a pointer in the same
change. The current package/module documents describe the definitions compiler, immutable release protocol,
qualified relations and actual catalogue as repository-owned behavior.

At discussion commit `7ff5c2aa6034f8fbd9951cf477c040804b125f65`,
`docs/adr/0031-standard-vocabularies-linkml-definitions.md:10-60` remains an accepted full decision document
covering standard terms, SKOS/focus, qualified credits/appearance, LinkML, immutable release activation and
manifest cost. Its converted definitions/catalogue topic has not been replaced by a repository pointer.
`docs/engineering/11-schema-classification-and-vertical-profiles.md:64-76` still supplies the detailed grain
table; other sections retain earlier classification structures, with the ADR listing required rewrites.
This is concrete evidence of overlapping full topic text and an incomplete conversion handoff, rather than
proof that all discussion material is invalid.

Some neighboring topics do use pointers: discussion
`docs/adr/0037-handwritten-kernel-api-standard-tooling.md:43` points to the repository subject-page/
composition documents. That does not discharge the definitions/catalogue pointer obligation.
No paired discussion/repository commit proving a same-change pointer migration for the converted core catalogue
was identified. The audit does not edit either authority or elevate this report above its governing sources.

**Minimal missing evidence:** a topic-specific authority inventory and the paired conversion/pointer commit for
definitions/catalogue and other actually converted semantic topics. Keep unconverted accepted standards/grain
requirements available until that owning-document conversion is adopted; do not silently narrow the objective.

## Ownership, exact gaps and next decisions

The control-plane snapshot distinguishes existing work from uncovered acceptance. It does not dispatch,
resume, retry or infer permission to change capacity from a stopped/held state.

| Gap or capability                                               | Registered position at cutoff                                                    | What remains, without duplicating a producer                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Relation-facet production source                                | Stopped, attempt 7                                                               | Owning resolution and actual source/native outcome evidence                                                     |
| Tuple dependency/fence relay, pair absence, default composition | Held dependency chain                                                            | Real exports and final native/default Search 13+6 evidence                                                      |
| Full display/authorized related summaries                       | Stopped, attempt 3                                                               | Existing display/permission/redirect native and growth acceptance                                               |
| Payload-bearing page seeks and related-read cost                | Stopped, attempt 6                                                               | Existing full six-file acceptance; passing subsets do not erase preserved failures                              |
| Definition recording guard                                      | Stopped, attempt 6                                                               | Actual semantic recording guard and same-change regeneration evidence                                           |
| Launch library profile bundle                                   | Held, no attempt yet                                                             | After compiler/guard, one data producer plus complete generated artifacts and unexcluded tests                  |
| Semantic API fixture capabilities                               | Stopped, attempt 3                                                               | Existing independent capability/persona/request extension acceptance                                            |
| Per-write original-revision authorship                          | Held semantic contribution chain plus cross-owner Content/Accounts prerequisites | Compatible declaration hooks and actual original-revision anchor outcome proof; no new lifecycle inventory      |
| Commerce library consumer                                       | Existing owner dependency                                                        | Actual consumer/resolver implementation; catalogue/compiler green is insufficient                               |
| Publication, aggregates and Zone runtime                        | Separate registered producers and audit reports                                  | Consult their audit evidence; starters and this core report make no completion claim for them                   |
| Anime release/version witness                                   | No active focused producer identified in inspected semantic registration         | Decide whether an existing configured type satisfies it; otherwise keep the uncovered required outcome explicit |
| Converted-topic discussion pointers                             | No focused active core-catalogue pointer producer identified                     | Identify owning conversion and paired pointer evidence; do not rewrite authority in this audit                  |
| Current-main full completion proof                              | Controller/owning completion responsibility                                      | Exact main ancestry, all original outcomes/growth and successful root gate at that same pin                     |

Small prioritized next-decision list:

1. **Keep completion open against the original scope.** Require a single main commit and its successful root
   gate, plus the full semantic persona and native/default Search 13+6 receipts. Record artifact path, command,
   commit, complete counts and no skips. Earlier promotion failure and later narrow green are neither proof.
2. **Resolve the two uncovered catalogue/authority questions.** Identify a concrete anime release/version
   configuration and API witness, and assign the converted-topic pointer handoff if no paired conversion
   exists. This is a focused ownership/acceptance decision, not a new architecture or external research brief.
3. **Use the existing producer/dependency chain.** Preserve the launch-data exclusion as an unfinished slice,
   then require the full bundle, legacy/profile/pin tests and generated recording guard. Leave default source,
   display/growth and compatible original-revision declarations with their registered owners. No mechanical
   retries, new duplicate briefs or worker/pool recovery are implied.

Audit interpretation decisions: shared game/VN releases count as reuse, not a missing VN-specific backend;
`schema:position` with P1545 mapping satisfies the credit-order term; empty Context defaults can be valid
settings; inert Zone starters do not prove Zone runtime; generic rejected/competing statement cases establish
their exact provenance assertions, not every possible dispute; and absent main/gate evidence keeps all native,
default, API and growth requirements visible. None changes the authoritative Done-when.

## Source provenance and inspection limits

Primary repository sources are pinned to the audit base above (equivalent for these files at inspected dev),
under **AGPL-3.0-only** (`package.json:4`, root `LICENSE`). File paths and line anchors above identify the
specific code/test evidence; the immutable source root is
[rezics-next at the audit base](https://github.com/rezics/rezics-next/tree/34dbc5607bf58f36722fb7e252df58fc1120d541).
Main absence comparisons use
[the inspected main tree](https://github.com/rezics/rezics-next/tree/90ffc5216ae62d52d4534696b3e6957b9ffbe8f8).

Discussion requirements were read from the existing local mirror at
`/home/edge/projects/rezics/docs/rezics-next-discussion`, especially
[the accepted vocabulary/LinkML ADR](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0031-standard-vocabularies-linkml-definitions.md)
and [the vertical grain document](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/engineering/11-schema-classification-and-vertical-profiles.md).
No top-level licence file was found in that mirror; no permission to copy its prose is inferred. Requirements
are restated in English without decision-speaker history. No external reference clone, third-party code,
installation, algorithm research or copied implementation is part of this audit.

The patterns the inspected sources share are data-driven generic execution, immutable digest/revision bases,
separate acceptance/adoption and asynchronous read projections with explicit freshness. The recommended course
is to finish and verify that existing design in this repository's TypeScript/Bun/PostgreSQL stack through its
registered owners, preserving original outcomes. Source presence, historical scoped receipts and runtime
composition are separate evidence classes until main ancestry and matching full execution join them.

The only validation authorized for this evidence artifact is existence/format validation. No product tests,
root typecheck or root gate were run by this audit. Missing execution proof is reported for its controller/
owner to obtain under the existing acceptance, rather than filled by a new manual run.
