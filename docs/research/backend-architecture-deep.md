# Backend architecture: independent deep audit

Research date: 2026-10-31. Inspected development revision:
`6d3f767467c85dbb9d3bb561d12af784407bd92c` (`dev` and this worktree's initial HEAD).
This is desk research, not an adopted design, implementation change or release assessment.
No software was installed, built or started; no tests, gates, runtime measurements or browser campaign were run.
The independent architecture, home and subject investigations were not consulted before writing this report.

## Assessment

The repository has a substantial generic core, but it does not yet satisfy its architecture as a complete product.
The strongest parts are explicit command ownership, ordinary-API imports, immutable definition/profile pins,
bounded progress representations, current disclosure checks and finite worker protocols.
It is inaccurate to describe the whole kernel as a collection of hardcoded book/anime engines.
It is equally inaccurate to infer delivery from a typed port, a module's tests or a generated client declaration.

The most consequential defects are architectural rather than cosmetic:

1. Subject summary and identity-observation batching does not implement the architecture's single snapshot and
   statement grouping per database. Partition loops remain on common hydration paths.
2. A Collection is capped at 5,000 members, with whole-owner reads and respacing behind individual operations.
   This cannot meet the settled million-item requirement by increasing a constant.
3. A definition release admits only 1,024 types. Its whole-release lookup patterns do not establish support for
   200,000 kinds. A large immutable catalogue needs a different delivery/indexing boundary.
4. Generic profile writes coexist with fixed shelf summaries and an `in_progress` semantic branch. There are also
   dormant fixed-vocabulary bulk schemas, which must not be confused with a mounted public bulk operation.
5. Important integration seams remain closed: the default shelf generation binding throws unavailable; mixed
   discovery is not mounted by the kernel composition root; large native scope preparation is not universally ready.
6. Several research/status documents describe older missing implementations which now exist. Other documents
   correctly distinguish source integration from native proof. Neither direction of drift should be flattened.
7. The custom machinery is concentrated around real consistency and lifecycle obligations, but overlapping read
   contexts, query ledgers, participant protocols and generated server type closures impose avoidable complexity.

Keep the modular monolith and its owner contracts. First repair shared reads and close concrete end-to-end seams;
then replace whole-owner algorithms and whole-release assumptions. Do not introduce another graph engine, workflow
engine, authorization service or wallet merely to make the diagram look more general.

## Evidence and interpretation

The authority read includes the complete research instruction and backend addendum at
`.temp/goal/web/research-20261031.md`, [feature design](../development/feature-design.md),
[architecture](../architecture.md), [scope](../scope.md), the development workflow, the
[system inventory](system-inventory.md), and all eight `design-status-*` reports: accounts, commerce, content,
imports, performance, search, semantic and web. The inventory identifies its own older source snapshot;
it is an index of systems, not a current capability receipt.
Owner evidence includes Kernel's Access/gates, Command, Events, Work, Semantic, Search, Library, Rating,
Community, Content, Commerce, Presentation and Zones READMEs, Auth and Importer READMEs, and all eight package
READMEs. Source and the actual server composition take precedence over their readiness claims in this audit.

“Implemented” below means a substantive source path exists. “API exposed” means the operation is mounted in
the inspected composition, with any missing default dependency stated separately. “Interface exposed” requires
an actual route/component integration; a story or recording only establishes that particular presentation.
“Tested” records the evidence inspected, not an execution by this audit. A test file's existence establishes
neither that its assertions cover the whole journey nor that it passed at this revision.
Causes below are inferred from the juxtaposition of contracts, composition and source unless explicitly documented.

Upper-bound examples use 300 Realms/Spaces, 200,000 semantic kinds, 10,000 follows and 1,000,000 members in one
Collection. These are design inputs, not measured populations. “Kinds” is interpreted as catalogue semantic types,
not 200,000 separately installed execution plugins. A Realm is not automatically a distinct definition Context;
the definition Context cap therefore does not itself prove a 300-Realm membership failure.

The supplied `.temp/goal/web/refs/maintainer-20261031/rezics-filter-panel-bug.png` was visually inspected.
Its 678 × 617 image shows filter controls extending beyond a very narrow panel over the result list.
The originating viewport, build revision and backend response are unknown. It corroborates a presentation failure,
not its CSS cause or an absent search engine. No additional capture was made; the public Pages/Patterns campaign
belongs to the completeness audit. The settled portrait default, landscape-image support and header search design
are requirements here, not questions to reopen.

## Every architecture principle

| Principle                                                                        | Evidence and verdict                                                                                                                                                                                                                                                | Required correction or boundary                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One graph and generic engine across verticals                                    | Semantic uses released types/properties and generic statements; profile-bound Library writes accept released vocabulary. Fixed shelf summaries and the literal state branch remain.                                                                                 | Complete the generic profile contract on every Library read/write surface; retain generic structural progress algorithms.                                                         |
| Simplest adequate design; mature engines first                                   | PostgreSQL, OpenSearch, Better Auth, Stripe, DBOS and fractional-indexing are already used. Custom ownership and retirement protocols fill stronger requirements than these components provide alone. Several protocols duplicate orchestration and read admission. | Keep proven gaps narrow; remove dormant schemas/fallback authorities and consolidate shared read/ledger adapters before replacing infrastructure.                                 |
| Bounded neighbourhood for every operation                                        | Many point reads, pagination limits, worker steps and query dimensions are explicit. Collection point operations conceal a 5,000-row read; summary cost scales with distinct partitions.                                                                            | Name examined keys and physical statements, not just result count. Repair the two algorithms before raising limits.                                                               |
| Finite, resumable large jobs                                                     | Import journals, identity participant pages and worker continuations are real. Some erasure and shared-history closure remains explicitly incomplete.                                                                                                               | Retain finite manifests/checkpoints and finish every owned storage/history class; a workflow return is not a lifecycle acknowledgment.                                            |
| Capability wherever its abstraction appears                                      | Generic entries, shelves, Continue, copies, Collection rules, public lists, aggregate pages and UI stories have different maturity. Default shelf composition is unavailable.                                                                                       | Adopt one capability/surface matrix and require ordinary API journeys through the production composition.                                                                         |
| One authority per capability                                                     | Access owns authorization; Semantic owns identity/facts; Library owns personal tracking; Commerce owns entitlements. Source indexes and UI fallbacks risk becoming competing truth.                                                                                 | Keep projections fenced and disposable; make presentation defaults singular; never infer ownership from catalogue types or tracking state.                                        |
| All product writes use ordinary API                                              | Importer's generated client uses ordinary batch writes, source metadata/statistics and media operations. Conversion is pure.                                                                                                                                        | Retain this seam; improve API admission rather than add a privileged import database path. Deployment bootstrap and fixtures are different categories.                            |
| Definitions / behaviour / presentation separation                                | Immutable Library profile pins are a strong implementation. Literal `in_progress` behaviour and three cover-default locations cut across it.                                                                                                                        | Model automatic-follow policy as a generic declared capability if retained; consolidate presentation config without using image ratio as semantics.                               |
| Single-partition writes; no cross-partition read joins                           | `runCommand` and owner routes generally enforce one command home. Many SQL joins stay inside that home. Cross-owner workflows use separate commands.                                                                                                                | Do not label every SQL join a violation. Audit actual full keys and route predicates; cross-owner effects need receipts and reconciliation, not a hidden distributed transaction. |
| Batched full-key reads: one statement per row kind, one RR snapshot per database | Content's batch reader is a useful positive implementation; Semantic summaries and identity collection use per-partition transactions/queries.                                                                                                                      | Share a database-grouped read context, batch partition rows too, and handle moved partitions through the same route contract.                                                     |

“One graph” does not require sessions, payment evidence and authorization grants to be stored as interchangeable
semantic statements. Those facts have different authorities and invariants. The architectural failure is duplicate
ownership or vertical-specific interpretation of generic vocabulary, not the existence of product modules.

## Capability matrix

The matrix separates exposure from implementation. `Source tests` means relevant test source was located/read;
all such evidence remains unexecuted in this audit. Interface observations are deliberately narrower than the
backend audit: no live frontend journey was inferred from a mock, recording or generated type.

| Capability                                   | Specified / designed                                                 | Backend implemented                                                                       | API exposed in inspected composition                                           | Interface exposed / limitation                                                    | Test evidence and limit                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Definitions, typed subjects and statements   | Generic catalogue and released profiles                              | Compiler, release validation, Semantic writes and reads                                   | Definitions and Subject routes mounted                                         | Generic presentation/client exist; not proof for all 200,000 kinds                | Definitions tests and Semantic suites exist; release hard cap remains                             |
| Library entries and profile vocabulary       | Released profile binding, generic states                             | Exact accepting-type/profile pins; generic validation                                     | Personal Library routes mounted                                                | Library components/stories exist; no native journey observed                      | `released-profile-user-cases.test.ts`, `profile-vocabulary-schemas.test.ts`; not full shelf proof |
| Library shelf pages, counts and type facets  | Complete owner library, bounded generation                           | Native page/metadata SQL and maintenance runtime exist                                    | Routes mounted; default generation dependency throws unavailable               | Shelf stories cannot establish production readiness                               | `shelf-http.test.ts`, `shelf-reads.test.ts`; composition gap still visible                        |
| Copies and FULL representation               | Profile-bound copy kinds/status, presentation expansion              | Copy writes and actual FULL presentation path                                             | Personal routes mounted                                                        | Component existence does not prove purchasing/copy journey                        | Library tests exist; old status claims cannot substitute for current source                       |
| Sessions, progress and Continue              | Generic progress structures; later verified mappings distinguished   | Scalar, cursor and sparse-unit modes; real session presentation                           | Progress/Continue routes mounted                                               | Continue components are not universal verified resume                             | Source tests protect representations; structure mapping remains unverified                        |
| Manual Collection membership/order           | Curated and personal collections, large-owner requirement            | Commands, ordering and visibility exist; 5,000 cap and whole-owner repair                 | Collection routes mounted                                                      | List/grid components exist; supplied panel is visibly broken                      | Collection user-case/rule HTTP suites exist; not million-item evidence                            |
| Collection source / rule filtering           | Generic Source ABI, current identity/privacy, preparation            | Real source observations and scope executors                                              | Collection rule routes mounted; larger-owner readiness is conditional          | Scoped header wiring not established by these modules                             | `collection-source-native.test.ts`, `collection-rule-read-http.test.ts`; no executed result here  |
| Library bulk actions                         | Generic capability expected where offered                            | Fixed-vocabulary admission schema exists                                                  | No use of `bulkAdmissionSchema` found in route wiring                          | A selection menu is not a delivered bulk API                                      | `bulk-schemas.test.ts` tests the schema, not a public journey                                     |
| Public structured filters                    | Closed bounded grammar; ordinary scoped lists                        | Real public runtime, source binding and Search service                                    | Server installs runtime; Search/page routes exist                              | Filter controls/stories do not prove every scope is wired                         | `growth-public-filter-source-binding.test.ts` exists; native final-revision proof separate        |
| Facets and private scope preparation         | Current counts/exclusions, finite useful pages                       | Runtime/storage and preparation code exist; adapter readiness varies                      | Cannot infer complete production facet support from exported ports             | No assertion of all scope/facet UI completion                                     | Source fixtures test pieces, not every default binding                                            |
| Mixed discovery / first home                 | First scope is Continue plus catalogue discovery; shared feeds later | Mixed discovery planning/source code exists                                               | `discovery` dependency is declared but not consumed/mounted by Kernel          | Current four-vertical home is presentation config, not native mixed feed delivery | Released discovery fixtures/capability tests are not a mounted mixed-home receipt                 |
| Static Zone page execution                   | Static composition in; advanced source reads constrained             | Common page/runtime and source work exist                                                 | Zone routes mounted; retained/native readiness must be checked per plan        | Inert starter JSON is not live source execution                                   | `static-page-runtime.test.ts`, `public-slice-exposure.test.ts`; no broad readiness inference      |
| Identity changes and merge                   | Finite participant-coordinated identity publication                  | Coordinator and Search/Library participants exist                                         | Merge route still returns synchronous-shaped `200`; operation contract differs | No operation-progress journey established                                         | Semantic tests do not erase the HTTP/document contradiction                                       |
| Auth, sessions and passkeys                  | Credential authority separated from Access                           | Better Auth integration, OAuth/OIDC provider, verified passkey bridge                     | Auth service routes exist; deployment restore admission separate               | No login/browser observation in this audit                                        | Auth passkey/restore/fence suites exist; no physical-restore conclusion                           |
| Accounts, profiles, Realms and Spaces        | Owner authority and shared profile/contracts                         | Native Access and Community commands/readers                                              | Kernel mounts Access and Community routes                                      | Context-specific views consume these; no 300-container UI proof                   | Account/profile and Community native source tests exist                                           |
| Ratings and public figures                   | Independent native/source populations and capped counted realms      | Native votes, aggregate readers and public figures                                        | Rating routes mounted                                                          | Rating story is illustrative presentation, not complete multi-context interaction | `public-figure-http.test.ts`; positive batch reader does not prove subject page quality           |
| Content, moderation, reactions and notices   | Minimal public content, outcomes and preferences in                  | Native content, disclosure, reactions, notices and retention paths                        | Content/notices/reaction routes mounted                                        | Error walls cannot be explained as “no backend” without per-request tracing       | Notice/reply/mention/growth source suites; no live coverage claim                                 |
| Commerce                                     | Offers, orders, payment evidence, entitlements in; points later      | Substantial native owner/state-machine/Stripe code; some producer/editor seams incomplete | Commerce routes mounted                                                        | Purchase-slot stories do not establish a buyer/creator journey                    | Commerce status distinguishes missing journey/native proof; not wholesale absence                 |
| Imports                                      | Ordinary API, permissioned proposed facts and resumable acquisition  | Real generated-client transport, SQLite journal and bounded stages                        | Import client calls ordinary Kernel APIs                                       | CLI/review workflow is separate from catalogue UI                                 | `transport-outcomes.test.ts`, `source-record-metadata.test.ts`, growth suites; unexecuted         |
| Wallet / economic tokens / market settlement | Wallet and points are later; token meaning must be explicit          | Orders/entitlements are not a balanced wallet ledger                                      | No wallet API is established here                                              | No delivered wallet should be advertised                                          | No wallet readiness inferred from OAuth tokens or Stripe mocks                                    |

## Findings, causes and owner seams

### F1. Per-partition hydration contradicts the database snapshot contract

**Class:** shared-read contract violation and cost amplification.
[Semantic summaries](../../services/kernel/src/semantic/summaries.ts), especially `readSubjectSummaries`,
the `PublicReader` adapter and the partition-group loop, bind `pool.query` as a client, open a separate read
transaction for representative editions, then run summary queries outside that same transaction.
Authorization, edition hydration, media checks and source-fence reads add further stages.
For 256 subjects on 256 distinct partitions in one database, the first subject stage alone can issue 256
representative-edition statements plus 256 summary statements, before those later stages or transaction control.
This is not one statement per row kind per database, nor one shared RR snapshot.

[Identity epoch reads](../../services/kernel/src/semantic/identity-epoch-read.ts) similarly loop source and control
homes, each inside its own `withReadTransaction`. The double collection compares relevant identity observations
and avoids treating unrelated changes as failures; that is useful concurrency logic. It does not make the
different transactions one database snapshot. At 100 distinct source and control homes, two collections can
perform up to 1,000 owner/data statements: `(2 source + 3 control) × 100 × 2`, excluding transaction control.

**Cause:** older per-home isolation and later proof guards were composed without changing the underlying batched
reader to the stronger architecture rule. **Impact:** a bounded result can incur hundreds of round trips and observe
inconsistent label/edition/cover inputs. Current disclosure checks reduce risk, but this audit does not establish
that every dependency shares a safe snapshot or demonstrate an actual information leak.
The same class also appears in [graph traversal](../../services/kernel/src/semantic/graph.ts): `visibleIdsFor`
and expansion reads group by partition. At the HTTP maximum of eight properties, both directions and depth two,
the first frontier can contain 400 distinct neighbours (`8 × 2 × 25`); the next expansion plan can contain 6,400
descriptors. The expansion loop can visit 400 partition groups even after the remaining edge budget reaches zero.
The 500-edge output cap therefore does not by itself state the statement or intermediate-descriptor bound.
[Expansion SQL](../../services/kernel/src/semantic/read-graph-expansions.sql) keeps its joins in the selected
partition and limits edge candidates; the defect is not an illicit cross-partition join.

**Owner/correction:** Semantic plus the shared database resolver; use database-grouped full-key batches and a
single pinned RR client for all row kinds. Preserve final current-authority checks rather than removing them.
[Content `batchSnapshot`](../../services/kernel/src/content/reads.ts) and Rating's public-figure batch contract
provide existing same-database snapshot patterns. Content currently operates on its supplied pool; it is not
evidence of a complete multi-database placement resolver. Reuse the local pattern rather than add another framework.

### F2. Collection size and ordering are designed around a small owner

**Class:** upper-bound admission failure and hidden whole-owner work.
[Collections](../../services/kernel/src/library/collections.ts) defines `MEMBER_LIMIT = 5000`; adding and restoring
members enforce it. `readMemberOn` calls `listMembers` with that limit and searches the result for one member.
`placeInCollection` normally uses neighbouring ordinal keys, but a gap failure reads and respaces the whole owner.
[Collection batch placement](../../services/kernel/src/library/collection-batch.ts) has the same repair shape.
[Ordinal helpers](../../services/kernel/src/library/ordinal.ts) already use the established `fractional-indexing`
library; the problem is the owner-wide fallback, not absence of fractional keys.

**Cause:** the member cap makes an otherwise unbounded repair appear locally bounded, while product requirements
later demand millions. **Impact:** the millionth member is not merely slow; admission fails after 5,000.
Raising the cap alone exposes a one-member read and adversarial gap repair to roughly a million rows/updates.
**Owner/correction:** Library's membership store, ordinal planner, Collection Source and retained maintenance.
Read a member by full owner/member key. Use bounded local order blocks or generation-based resumable maintenance
with a finite manifest and atomic publication; keep old order readable until the replacement is valid.
Choose the simplest scheme that supports insertion/reorder semantics, not a CRDT solely because the list is large.

### F3. The definition release cannot represent the settled catalogue bound

**Class:** model-size mismatch and whole-catalogue delivery.
[Portable limits](../../packages/definitions/src/portable.ts) cap a release at 1,024 types, 4,096 properties,
64 properties and 16 facets per type, 256 Contexts and 4 MiB. The type cap is approximately 195 times smaller than
200,000. [Filter facet lookup](../../packages/filter/src/filter.ts) constructs a release cache by iterating all
types; [compilation](../../packages/definitions/src/compile.ts) validates release-wide closures.
Cold publication validation can legitimately scale with a finite release. Interactive lookup must not repeatedly
load, traverse or ship the entire catalogue to obtain one type's hints.

**Cause:** a bundled launch release, described as having headroom for launch configurations, became the assumed
universal catalogue unit. **Impact:** adding a vertical is configuration-only only while it fits this closed unit;
the settled number is rejected before rendering becomes the issue.
**Owner/correction:** Definitions owns immutable manifests and bounded keyed type/profile retrieval; Semantic,
Filter, Client and pickers consume it. Design paged/searchable catalogue indexes and pinned dependency bundles.
Do not simply raise every release/regex/JSON cap or create one UI block per type. A new manifest format must retain
reproducible validation and exact profile pins, not weaken them into mutable lookups.

### F4. Generic Library writes stop short of generic Library behaviour

**Class:** vocabulary interpreted as behaviour and inconsistent public surfaces.
[Entry model](../../services/kernel/src/library/entry-model.ts) uses string states;
[profile resolution](../../services/kernel/src/library/profile.ts) selects the exact accepting type's released
profile and pins its digest. [Session creation](../../services/kernel/src/library/sessions.ts) validates against
the actual descriptor after syntax admission. Thus the old claim that all new writes accept only book/episode
units is false at this revision.

However, [entries](../../services/kernel/src/library/entries.ts) still branches on `entry.state === 'in_progress'`
to auto-follow a subject. [Shelf contract](../../services/kernel/src/library/shelf-contract.ts) and
[shelf schemas](../../services/kernel/src/library/shelf-schemas.ts) retain five fixed state tabs/summary keys.
[Bulk schemas](../../services/kernel/src/library/bulk-schemas.ts) also enumerate fixed states, but searches found
no route consumer of `bulkAdmissionSchema`; this is dormant design surface, not proof of an exposed bulk rejection.

**Cause:** compatibility vocabulary and shipped launch defaults escaped their adapter boundary.
**Impact:** a profile can admit a state which is absent from the summary or fails to acquire the same automatic
follow behaviour as a similarly meaningful default state. UI selection can overstate bulk capability.
**Owner/correction:** Library profile/entry/shelf contract, then Client and UI. Keep explicit legacy provenance in
the compatibility adapter. Return profile-bound state descriptors/counts. If automatic follow remains required,
declare its generic policy/capability; do not add more literal synonyms. Remove unused bulk declarations or design
the real ordinary-API bulk operation before advertising it.

### F5. Progress is structurally generic, but verified continuation is a separate capability

**Class:** capability conflation, rather than evidence of a wholly vertical engine.
[Progress](../../services/kernel/src/library/progress.ts) has generic scalar, cursor and completed-unit algorithms,
bounded decimals, sparse unit identifiers and explicit lifecycle. Legacy page/chapter/episode/etc. fallback is
conditional on missing descriptor/legacy provenance; it should not be described as the new profile grammar.
Sparse completed units are capped at 20,000, changes at 100 and locators at 256; it does not enumerate a giant
filled numeric range. Those are genuine examined-input bounds.

[Profile native progress units](../../services/kernel/src/library/profile.ts) and
[FULL progress presentation](../../services/kernel/src/library/progress-routes.ts) do not establish verified
cross-edition mapping or structure-backed resume: current structures are explicitly unverified/session-local
where applicable. The FULL representation reader and copy FULL path are real, contrary to older missing-code
claims. **Cause:** a rendered current position can be mistaken for verified semantic continuation.
**Impact:** misleading resume confidence and inconsistent cross-edition treatment.
**Owner/correction:** Library plus Semantic structure authority; expose verification/provenance separately from
the display value. Retain the structural engine; add a capability only for an adopted mapping requirement.

### F6. Production composition leaves working modules unavailable or unreachable

**Class:** integration closure failure.
[Server setup](../../services/kernel/src/server.ts), when Search is configured, installs the real
[public Filter runtime](../../services/kernel/src/search/public-runtime.ts). It does not provide the optional
shelf native binding to [Kernel composition](../../services/kernel/src/http/kernel.ts).
[Default shelf reads](../../services/kernel/src/library/shelf-reader-defaults.ts) therefore use a generation
function that throws `ShelfReadUnavailableError`, naming missing native maintenance/generation admission.
The page, metadata, cursor and type SQL adapters are substantive; the missing default dependency is the defect.
The same composition declares `discovery?: DiscoverySearch` without consuming it to mount mixed discovery.

**Cause:** factory-local tests and optional dependency injection were treated as enough evidence for the release
composition. **Impact:** an API route may exist yet remain unavailable; a discovery contract may have no ordinary
route. Stories can still render recordings. **Owner/correction:** Kernel composition with Library/Search owners.
Make required released dependencies explicit, connect one ordinary persona journey through the real composition,
and keep unavailable capability states honest until the owner protocol is installed. Do not return empty success.

### F7. Native scoped search exists, but small-owner readiness is not large-owner readiness

**Class:** partial algorithm coverage and inconsistent cost admission.
[Scope source](../../services/kernel/src/search/scope-source.ts) contains real `prepare` and `orderedPrefix`
implementations, not unconditional placeholder throws. Its Collection preparation paths read at most 99 candidates
and refuse an unexhausted native prefix. This is an honest bounded-small-owner result, not a million-member
ordered/filter result. [Collection Source](../../services/kernel/src/library/collection-source.ts) and
[identity observations](../../services/kernel/src/semantic/identity-scoped-observations.ts) contain real enrollment,
late-writer and fence logic. Replacing these descriptions with “all ports missing” would be wrong.

[Scope allowances](../../services/kernel/src/search/scope-execution.ts) include compatibility/default ceilings of
65,536 native rows, 16,384 identity-metadata rows, 256 empty seeks, 4,096 native points, 8,192 witness keys,
8,192 statements and 4 MiB. These are allowed maxima, not measured execution. They are much looser than the
composed per-backend budget in [filtered lists](../filtered-lists.md), which names 72 statements and 96 engine
operations across an admitted page. A caller-supplied composed ledger can be tighter; exported defaults alone
do not prove every caller uses it.

**Cause:** independently developed owner/source compatibility allowances lack a visibly singular admission seam.
**Impact:** inconsistent unavailability, preparation and cost across Collection, Zone and standalone surfaces.
**Owner/correction:** Search owns one composed ledger; source owners debit every physical dimension, including
identity/control reads. Complete retained preparation for large owners, with finite input and current query-level
privacy. Do not conflate the Source comment about identity-metadata sweeps with proof that every page scans all
privacy heads: these are different axes and need separately attributed evidence.

### F8. Documentation drift obscures both real work and real gaps

**Class:** stale capability accounting and incompatible operation contracts.
[Search README](../../services/kernel/src/search/README.md) describes a provisional/unavailable source binding while
`public-runtime.ts` and configured server setup now install real sources. This supersedes a blanket missing-source
claim, not the separate missing facet composition: server setup does not pass `facetProvider`, whose omission
retains the documented `503 index_not_ready`. Search/Zone status statements about missing
`scope-source.ts` preparation are superseded by substantive current bodies, although their large-owner limits
remain. [Semantic status](design-status-semantic.md) describes a missing coordinator while
[the coordinator](../../services/kernel/src/semantic/identity-epoch-coordinator.ts) now exists.
[Commerce status](design-status-commerce.md) has older missing-route/representation claims superseded by mounted
label and current FULL paths. [Auth README](../../services/auth/README.md) excludes authorization-provider work
which [website-provider](../../services/auth/src/website-provider.ts) now installs through Better Auth.

One definite wire contradiction remains: [Semantic README](../../services/kernel/src/semantic/README.md) describes
accepted identity operations with `202`/operation observation while
[Subject merge HTTP](../../services/kernel/src/semantic/http/subjects.ts) returns `200` with survivor, redirected
and revision fields. It needs reconciliation even if a gate currently prevents public use.
Separately, [scope](../scope.md) defers user-saved dynamic queries while
[Collection routes](../../services/kernel/src/library/collection-routes.ts) accept a dynamic rule on creation.
This establishes implemented/mounted private storage ahead of public scope, not necessarily a scope violation:
stored meaning and the private-family grants do not establish public execution admission or release activation.
Keep its public status deferred unless the owning scope changes; do not silently count it as delivered first scope.

**Cause:** reports and READMEs are manually maintained at different revisions; declarations, integration and proof
are not tracked separately. **Impact:** duplicated work, false readiness and incompatible clients.
**Owner/correction:** each owner reconciles its current contract with composition, retaining dated historical
receipts as history. A small generated route/dependency inventory can assist, but cannot decide product scope.
Do not turn this report into a second authoritative product specification.

### F9. Presentation defaults have multiple authorities

**Class:** configuration duplication and cross-surface inconsistency.
[Released definitions](../../packages/definitions/release/rezics.json) include non-portrait list hints;
[list presentation fallback](../../packages/ui/src/components/list-presentation-model.ts) assigns landscape to
anime/movie/TV/recipe types and square to music; [standalone cover fallback](../../packages/ui/src/components/cover-model.ts)
has its own type families and ratios. Thus fixing one page cannot ensure the settled all-kind portrait default.
This is not evidence that the backend must add an Anime engine or discard landscape assets.

**Cause:** backward-compatible fallback tables outlive presentation contract changes.
**Impact:** the same subject acquires different geometry in lists, standalone cards and mixed pages.
**Owner/correction:** Definitions/Presentation and UI own one released default contract, with a single generic
fallback and explicit per-image fit/focal point/credit. Preserve intrinsic image dimensions and landscape support.
Portrait default is settled; contain/crop policy must follow the adopted image presentation contract, including
accessible names and credit, rather than silently changing semantic type or source artwork.

### F10. Lifecycle protocols are strong locally and incomplete as whole-system closure

**Class:** partial lifecycle coverage and external-owner gap.
[Command](../../services/kernel/src/command/README.md), [Events](../../services/kernel/src/events/README.md) and
[Work](../../services/kernel/src/work/README.md) explicitly distinguish committed outcomes, delivery, effect
completion, shared history and retirement. This is valuable complexity: a queue acknowledgment is not deletion.
[Library lifecycle](../../services/kernel/src/library/README.md) acknowledges partial owned-fact purge; entries,
copies and follows do not cover sessions, labels, retained source output, command/outbox custody and all logs.
The Auth restore contract also needs trusted database-owner admission before restored writers become usable;
application fences cannot establish physical backup disposal or deployment custody.

**Cause:** owner-local progress was implemented before every participating retention/storage class had a closed
owner protocol. **Impact:** a seemingly finished deletion/restore can retain authority or resurrect a writer.
**Owner/correction:** lifecycle owner plus each storage owner, and the actual deployment/database custodian.
Retain exact finite inventories, writer fences and acknowledgments; document the external owner instead of
claiming physical erasure from a passing application test. No actual restore or deletion experiment was performed.

### F11. Service seams exist, but directory separation is not deployment separation

**Class:** dependency coupling and premature split readiness.
[Auth contract](../../packages/auth-contract/src/index.ts) is a useful neutral port: bounded credential commitments,
authority observations and authn epochs without copying raw credentials into Kernel. Auth does not need direct
product database ownership. However, Kernel's dependency/wiring still includes Auth and in-process bindings.
[Work module registration](../../services/kernel/src/work/modules.ts) names a fixed owner list.
Search scope code imports Library/Semantic participants, the Semantic identity coordinator imports Search and
Library participants, and Content/Commerce use Semantic, Access and edition authority. These are real coordination
dependencies, not independent services ready to lift out by renaming folders.

**Cause:** TypeScript module reuse and explicit participant registration substitute for deployment-neutral ports.
**Impact:** splitting creates distributed retries, current-authority reads and custody handoffs which are not solved
by HTTP wrappers. **Owner/correction:** keep the modular monolith; narrow owner DTO/command/observation ports and
separate storage capabilities first. Shared PostgreSQL can remain the initial placement. Split only for a measured
operational or trust requirement, with retained failure/reconciliation semantics, not as an aesthetic cleanup.

### F12. The client package exposes server type topology

**Class:** compile-time coupling and accidental dependency surface.
[Client](../../packages/client/README.md) uses generated Kernel declarations and Eden, with shared-route workarounds
for route intersection complexity. Its dependency closure includes server-oriented packages such as DBOS and `pg`.
This is not proof those runtimes are bundled into a browser: type-only imports and bundling need separate evidence.
It does make client publication and service splitting depend on server implementation type topology.

**Cause:** generating the server declaration tree is simpler initially than maintaining a transport boundary.
**Impact:** unrelated server changes can disturb consumers and increase declaration/build complexity.
**Owner/correction:** Client plus HTTP owners; compare an explicit transport DTO/OpenAPI boundary and generated
client against the existing approach. Keep opaque IDs, discriminated unavailable states and shared grammar semantics;
do not maintain two hand-written validation systems. Keep viewer-specific session tokens isolated per client instance.

### F13. Counting policy and disclosure must survive presentation composition

**Class:** semantic count ambiguity and partial-state disclosure risk.
[Voter Realm enrollment](../../services/kernel/src/rating/voter-realms.ts) intentionally caps the counted population
at 100. With 300 memberships this does not mean 300 rating contexts should all be queried/rendered automatically.
The cap is a policy with bounded maintenance, not a failure to store memberships. Native vote counts and imported
source statistics are distinct populations. [Follow-count reads](../../services/kernel/src/library/follow-count-reads.ts)
have real current account/epoch/Access checks; old “no runtime count” statements are stale.

[Notice reads](../../services/kernel/src/content/README.md) distinguish unread count admission, current target
visibility, mandatory outcomes and optional bodies. A bounded candidate scan may return fewer visible notices;
this is not automatically the useful-filtered-list contract. **Cause:** counters, membership and rendered context
cards are easy to collapse into a single attractive number. **Impact:** misrepresented ratings, leaked hidden
membership/targets or UI work proportional to all contexts.
**Owner/correction:** Rating/Library/Content supply population, coverage and availability metadata; Presentation
shows a bounded selected context, searchable selector and honest unknown/unavailable states. Do not replace failed
count reads with zero or mix imported ratings into native totals.

### F14. Commerce is a viable owner seam, not an implicit wallet

**Class:** future-capability conflation and incomplete journey integration.
[Commerce](../../services/kernel/src/commerce/README.md) separates immutable captured offer terms, orders,
provider evidence, current protected use and entitlements. Substantial storage/state-machine code exists; creator
sales production and parts of benefit-version editing remain explicitly incomplete. A purchase-slot error story
does not prove absent APIs, and a payment-provider success does not prove access to the purchased object.

**Cause:** common names such as “token”, “balance” and “ownership” obscure different authorities.
**Impact:** a later wallet could duplicate payment/order truth or treat a manually tracked copy as an entitlement.
**Owner/correction:** finish an ordinary buyer/creator/entitlement journey before broadening scope. Auth bearer
tokens are credentials, Library copies are personal tracking, and economic credits need a separate balanced ledger.
Choose ledger and custody policy only when the wallet requirement exists; keep current Commerce contracts extensible
through immutable external references and idempotent settlement events rather than generic graph balance updates.

## Desk cost analysis at the settled bounds

These are code-path counts and asymptotic consequences, not latency, throughput or memory measurements.
Independent owner/database placement matters: grouping by partition is not grouping by physical database.
The 10-connection server pool is a resource cap, not evidence that 512 sequential SQL statements are inexpensive.

| Path / anchors                                 | Examined input and expansion                                                                                             | At the upper bound                                                                                                              | Assessment / correction                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Subject summaries: up to 256 full subject keys | Partition loop, representatives, subjects, editions, per-row authorization, media and fences                             | 256 distinct partitions in one database can yield at least 512 first-stage statements                                           | Violates database batching contract; batch all row kinds in one RR context                                                                 |
| Identity observations: up to 100 original keys | Two collections of exact source/control owner and state reads                                                            | Up to 1,000 owner/data statements for 100 distinct source/control homes                                                         | Relevant-key proof is useful; separate RR per home is still the wrong physical batching                                                    |
| Content batch hydration                        | Full keys at the supplied pool; one read-only RR client, batched partitions/kinds                                        | Output and ancestor expansion remain bounded; chain length at most 32                                                           | Positive same-database pattern, not a general placement resolver; retain final current disclosure where mandated                           |
| Public figure hydration                        | Up to 256 requested figure keys in caller RR                                                                             | Contract names two statements: question rows plus full-key fields/pending guards                                                | Positive shared-reader example, not a claim about an entire page's Access cost                                                             |
| Collection add/restore                         | One owner, uniqueness/count/order checks                                                                                 | Rejected beyond 5,000, long before 1,000,000                                                                                    | Admission failure, not a measured slowdown                                                                                                 |
| Collection point/member placement              | `readMemberOn` scans a capped owner; gap repair respaces all members                                                     | Raising cap makes one-member lookup/repair O(1,000,000)                                                                         | Exact lookup plus bounded order maintenance and retained publication                                                                       |
| Native scope preparation                       | Bounded ordinal/order prefix of at most 99 and exhaustion check                                                          | A million-member owner generally needs retained preparation; refusal is honest                                                  | Do not call the small-owner direct path a scalable complete capability                                                                     |
| Composed useful lists                          | 16 reads, 128 slots; direct candidates `min(600, 6s+3)` and ready `2s+2`                                                 | Sixteen direct reads of eight slots admit 816 candidates total                                                                  | Adopted global budget is 6,784 Access points, 14,080 examined rows, 72 statements/backend, 96 engine operations; all sources must debit it |
| Query-level privacy coverage                   | Fixed 4,096 homes with indexed coverage/control summaries                                                                | Adopted coverage query is two statements and `64 + 2 × (unacknowledged + changed homes)` rows                                   | Returned-hit checks alone cannot make NOT, counts, exclusion or ordering safe; no page-wide 8,192-head scan shortcut                       |
| Public graph                                   | Depth 1 or 2, up to eight properties, both directions, 25 edges/expansion, 500 total edges; summary chunks of 256        | Up to 400 first-frontier neighbours and 6,400 second-round expansion descriptors; up to 400 second-round partition query groups | Bounded but expensive; partition loops and later hydration inherit F1. Local joins are not cross-partition joins.                          |
| Definitions and facets                         | Release admission plus first-use whole-type cache                                                                        | 200,000 types rejected at 1,024; whole manifest/client payload would grow with catalogue                                        | Separate cold compilation from bounded keyed runtime lookup                                                                                |
| Progress                                       | Bounded scalar/cursor input or 20,000 sparse completed units; updates at most 100                                        | Does not enumerate every unit of a huge work                                                                                    | Keep explicit structural limits and session-local/unverified labels                                                                        |
| Home/follows                                   | Fixed admitted descriptors; selected cursor page rather than one block/follow/type                                       | 10,000 follows or 200,000 kinds must not generate 10,000/200,000 queries or controls                                            | First scope can deliver bounded Continue/catalogue rows; a native mixed feed needs its own adopted scope and mounted plan                  |
| Realm ratings                                  | Current population and explicitly capped counted enrollment                                                              | 300 memberships, at most 100 counted Realm enrollments under current policy                                                     | Searchable context selection; state counting policy and avoid rendering all contexts                                                       |
| Notices                                        | Current target checks over bounded candidates, count capped at 100; page scan at most four times limit, limit at most 50 | Up to 200 candidates, not an unbounded history scan                                                                             | May produce a short visible page; communicate continuation and unknown counts accurately                                                   |
| Worker, import and lifecycle steps             | Finite input/page checkpoints, exact command/receipt keys and fenced generations                                         | Total work may be large, but each step must retain its named row/byte/history limits                                            | A global scheduler's fixed home loop is not permission to scan all product rows; finish missing custody classes                            |

For an actual future cost proof, record source and control queries, Access points, returned and examined rows,
engine operations, bytes, transaction count and connection occupancy separately. Neither a low SQL count nor
128 output slots proves a cheap plan. That future verification is a recommendation, not work performed here.

## Custom mechanism inventory and established alternatives

This inventory groups mechanisms by invariant rather than counting each SQL file as a separate engine.
Alternatives are comparisons, not proposals to install them all. “Retain” means retain the required invariant and
narrow owner implementation; it does not certify the present code or exempt it from the shared cost contract.

| Mechanism and local evidence                                                     | Established alternative / gap                                                                                                        | Recommendation                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routed identities and owner partitions; Semantic/Command storage                 | PostgreSQL partitioning and UUID standards do not themselves route an application identity or enforce product ownership              | Retain routing convention with full-key validation; use native indexes/constraints. Do not create a distributed database engine inside route helpers.                                                       |
| Single-partition command, receipt and authority preparation; `command/README.md` | PostgreSQL transactions and unique idempotency keys cover atomicity; Stripe illustrates replay semantics but not local authorization | Retain one command executor; remove owner-specific duplicate retry/receipt executors. Authorize current caller before replay.                                                                               |
| HMAC receipts/cursors and bounded key ring                                       | Standard MAC primitives and opaque pagination tokens, not custom cryptography                                                        | Retain authenticated owner/query binding with rotation; separate cursor integrity from authorization.                                                                                                       |
| Outbox relay and delivery checkpoints; `events/README.md`                        | Debezium outbox routing, Redis Streams and RocketMQ provide established transport/progress patterns                                  | Retain transactional outbox/owner fences; replace transport plumbing when equivalent. Delivery is not effect completion or erasure.                                                                         |
| DBOS workflow retirement and writer fence; SDK patch and Work                    | DBOS deletion/idempotency; Temporal durable histories                                                                                | Keep the narrow patch while pinned upstream lacks the same permanent late-writer invariant. Upstream it/remove on equivalence; changing engine alone does not solve physical custody.                       |
| Shared history custody and bounded workflow segmentation                         | Engine retention/archival and application-owned histories                                                                            | Retain exact participant custody and finite segment limits; consolidate common registration and evidence instead of each owner inventing history accounting.                                                |
| Auth OAuth/passkey integration                                                   | Better Auth maintained OAuth/OIDC/passkey plugins; RFC 9700                                                                          | Retain upstream protocol/crypto. Keep only the verified-result/native-authority bridge and proven race fixes; do not write another identity provider.                                                       |
| OAuth refresh-family patch                                                       | RFC 9700 rotation/replay defence; upstream transactional token stores                                                                | Retain exact family locking/revocation until upstream equivalent; avoid history scans and preserve revocation after cleanup.                                                                                |
| Current Access, epochs and owner eligibility                                     | SpiceDB consistency tokens and OpenFGA consistency choices                                                                           | Keep native owner truth/current-disclosure semantics. Compare engines if graph complexity demands them; cache bypass alone does not supply all current owner eligibility or erase guards.                   |
| Erasure and restore generations                                                  | Database backup/restore ownership, engine retention and fenced writers                                                               | Retain application fences; add real external custodian admission. Do not substitute a generic job status for physical lifecycle closure.                                                                    |
| Definition compiler, digest pins and immutable releases                          | LinkML, JSON Schema, RFC 8785 canonical JSON, standard SPDX/BCP 47 tooling                                                           | Keep Semantic-specific compilation over mature libraries; split catalogue delivery from cold compile rather than implement another schema language.                                                         |
| Portable regex proof and execution checkpoints                                   | RE2-style non-backtracking engines / restricted safe patterns                                                                        | Keep a documented bounded subset if portability requires it; compare replacing the custom proof once all accepted semantics and resource limits match. Never fall back to unrestricted JS regex.            |
| Closed filter AST and capability admission                                       | OpenSearch Query DSL or SQL express much more but are not safe public product grammars                                               | Retain the small inert public grammar. Compile into one admitted backend path; remove parallel ad hoc interpreters.                                                                                         |
| Query-level Source ABI, START/FINAL observations and negative-query safety       | OpenSearch PIT/search-after; Zanzibar-family consistency                                                                             | Retain the missing live authority/coverage invariant; PIT stabilizes index results, not live permissions or exclusion proofs. Consolidate common observation/ledger plumbing.                               |
| Retained scope preparation and continuation                                      | Materialized/indexed views and durable bounded jobs                                                                                  | Retain where useful current pages cannot be obtained directly; finish large-owner adapter and publication. Avoid a second general workflow framework.                                                       |
| Database-grouped batched read                                                    | PostgreSQL RR, array/full-key batches                                                                                                | Replace per-partition read wrappers with one shared read context; Content/Rating already show the simpler direction.                                                                                        |
| Identity merge/coordinator participants                                          | Generic durable workflow, idempotent participant commands                                                                            | Retain Semantic-owned identity transition and explicit source participants. Replace ad hoc route completion with the adopted accepted-operation contract.                                                   |
| Fractional Collection order and whole-list respacing                             | Existing `fractional-indexing`; bounded order-maintenance blocks or retained generations                                             | Retain library-generated keys; replace whole-owner lookup/repair. CRDTs only if concurrent offline editing actually requires them.                                                                          |
| Shelf counters/type-key structures and generations                               | PostgreSQL indexed projections/materialized views with incremental maintenance                                                       | Retain exact owner generation and bounded reads; compare simplifying bespoke structures after million-item read/update semantics are explicit. Merely refreshing a whole materialized view is insufficient. |
| Library state/profile/progress engine                                            | Configurable profile vocabulary; Zotero/Notion show data-defined views, Bangumi shows legitimate closed vertical vocabulary          | Retain structural generic behaviours and exact profile pins; remove literal value semantics and duplicate fixed summaries outside compatibility.                                                            |
| Rating shards, enrollment and aggregate generations                              | PostgreSQL aggregates, indexed incremental summaries                                                                                 | Keep capped/current population policy and exact reversals; do not build a streaming platform for a bounded native aggregate without need.                                                                   |
| Community discovery buckets and rank projection                                  | Indexed time buckets plus established search/ranking engine                                                                          | Keep derived, epoch-fenced owner projection; use bounded expiry/due frontiers, not periodic Realm/thread sweeps.                                                                                            |
| Content notices, mention caps and disclosure projection                          | Durable queue plus indexed inbox; ActivityPub supplies public activity vocabulary, not local private inbox authority                 | Retain minimal local inbox and current target eligibility. Defer unrelated federation; use shared lifecycle/command facilities.                                                                             |
| Versioned rich documents and stable block IDs                                    | ProseMirror/Tiptap, JSON canonicalization; HTML/Markdown interchange                                                                 | Retain closed owner profiles over maintained editors. Replacing with arbitrary HTML loses current validation/anchoring; format conversion is not the semantic authority.                                    |
| Composition JSON, registry, slot planner and aggregate read admission            | Puck-style inert composition; mature renderer/editor libraries                                                                       | Retain closed product descriptors and one cost planner; don't duplicate query execution in the page system or ship arbitrary executable components as definitions.                                          |
| Media source/import/processing and current availability                          | Object store/image-processing libraries, standard dimensions/rights metadata                                                         | Retain ordinary API source ownership/current disclosure; keep processing and storage adapters replaceable. A cached image URL is not rights or visibility authority.                                        |
| Immutable Commerce terms, payment evidence and entitlements                      | Stripe APIs/idempotency; specialized ledger for future balances                                                                      | Retain native order/entitlement authority and provider reconciliation. Do not add a homegrown money ledger to generic graph properties.                                                                     |
| Import SQLite journal, acquisition bounds and receipt reconciliation             | SQLite WAL/transactions plus ordinary API idempotency                                                                                | Retain bounded local execution state; simplify repeated retry wrappers where one journal contract suffices. Never promote the journal to catalogue truth.                                                   |
| Provider conversion modules                                                      | Established provider schemas and pure adapters                                                                                       | Retain provider-specific mapping outside Kernel. Adapters are appropriate vertical specificity; no direct writes/fetching in conversion.                                                                    |
| Generated server declaration client                                              | OpenAPI transport schema and generated clients                                                                                       | Compare replacing server declaration closure with a small transport boundary; keep one source for grammar and unavailable/error shapes.                                                                     |
| Cover/type fallback maps                                                         | Released presentation configuration and one generic fallback                                                                         | Remove duplicated type tables after consolidating defaults; preserve per-image geometry, focal point and rights.                                                                                            |

Two custom patches have concrete reasons, not merely preference. The local Better Auth OAuth patch documents a
refresh-family race between parent revocation/child insertion and replay-history cleanup; exact family transactions
and permanent revocation close a different invariant from ordinary token expiration. The DBOS patch adds retirement
and writer fencing for actual workflow IDs after history deletion. Both need a version-pinned removal criterion.
Their presence is neither an automatic architecture failure nor a reason to keep forks indefinitely.

## Authorities, ordinary writes and service boundaries

| Authority                                                          | Current source seam                                                    | Consumers / split implications                                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials and verified authentication                            | Auth / Better Auth, neutral `auth-contract` observations               | Access admits product actions from current account/authn epoch. Credential records must not become a second product account database. |
| Product account/profile and authorization                          | Kernel Access and owner eligibility                                    | Community, Semantic, Library, Content and Commerce consume current authority; cached permission is not an owner fact.                 |
| Semantic identity, statements and definition pins                  | Semantic plus Definitions release                                      | Imported proposals require ordinary adoption; search indexes/summaries and source keys remain derived.                                |
| Personal entries, copies, progress, follows and curated membership | Library                                                                | Tracking a copy or setting completed is not ownership/payment evidence. Shared profile contracts must work on all surfaces.           |
| Realm/Space lifecycle and classification                           | Community, with Access grants                                          | A Zone/page consumes it; presentation templates must not create shadow membership or Context authority.                               |
| Content revisions, moderation/publication and notices              | Content and explicit current owner gates                               | Feed/discovery projections consume committed source facts; notices cannot disclose hidden target bodies through counts/previews.      |
| Ratings                                                            | Native Rating population; separate imported source-statistic authority | Aggregates need population labels and current availability; native and imported counts do not merge silently.                         |
| Offers/orders/provider evidence/entitlements                       | Commerce; provider controls payment evidence                           | Current protected use rechecks native entitlement and object authority, not a frontend success screen.                                |
| Workflow execution/retirement and shared history                   | Work plus explicit owner custody                                       | All owner effects still need their native fences. DBOS status is not universal product completion.                                    |
| Query preparation and derived index publication                    | Search/Source owners                                                   | Search cannot rewrite source facts or bypass current owner disclosure. Empty, unavailable, preparing and denied differ.               |

[Importer transport](../../services/importer/src/import-client.ts) uses `@rezics/client` for ordinary
`subjects:batchWrite`, source-fence checks, source-statistic writes, media import/status and source-record metadata.
[Importer orchestration](../../services/importer/src/importer.ts) checkpoints commands and recovers receipts.
Its SQLite WAL run store records acquisition generations, entries, members, acknowledgments, command payloads and
envelopes; these are execution custody, not an alternate catalogue. Converted proposals are not automatically
accepted semantic facts. No privileged direct Kernel database importer was found on this path.
Deployment bootstrap/seeding and test fixtures must remain explicitly labelled; their existence alone does not
contradict the ordinary product-write rule.

The eight packages have useful boundaries worth preserving:

- `definitions`: immutable vocabulary/compiler/profile contracts; change catalogue delivery, not its ownership.
- `filter`: inert bounded grammar and capability lookup; no direct database authority.
- `document`: versioned document validation and canonicalization over maintained editor primitives.
- `composition`: inert templates/slots and read-plan admission; no second query/authorization engine.
- `conversion`: pure provider-specific mappings; no product permission or storage ownership.
- `auth-contract`: neutral bounded credential/authority DTOs and ports; no credentials or product tables.
- `client`: transport/session handling; reduce its server declaration dependency surface.
- `ui`: accessible rendering/primitives and presentation; remove semantic/default truth copied into type tables.

For a later wallet, first distinguish non-transferable points, spendable credits, refundable money, bearer API
credentials and tradable assets. Only actual monetary/credit balances need balanced integer ledger entries,
idempotent posting, holds/capture/release, reversals, currency/asset separation and auditable conservation.
A specialized ledger such as TigerBeetle is a comparison candidate, not an adopted dependency.
Cross-owner transfers cannot be hidden inside a normal single-partition graph command; define one ledger authority
or an explicit reconciled transfer protocol. Marketplace seller settlement, disputes, tax/custody and withdrawals
are additional product requirements. Present order/entitlement separation helps, but establishes none of them.

## Mainstream product comparison

Twenty product references were consulted for the visible capabilities relevant to this architecture. Technical
engines are compared separately above. Evidence is official documentation/API/schema/source, accessed 2026-10-31;
this is not a logged-in usability audit. Chinese and international examples are included. An API's page limit or
an official screenshot does not establish its internal query cost, privacy correctness or behaviour at our bounds.

| Product / primary evidence                                                                                                                  | Relevant observed/documented pattern                                                                                  | Classification and recommendation for REZICS                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Reddit search](https://support.reddithelp.com/hc/en-us/articles/19695647891988-How-does-Reddit-search-work)                                | Search supports community scope and result/filter choices.                                                            | Existing scope concept, incomplete cross-surface delivery; use one admitted search contract rather than page-local filters. No internal cost claim.                                           |
| [X search](https://help.x.com/en/using-x/x-search)                                                                                          | Search exposes result categories and filtering.                                                                       | Generic result selection/presentation; mixed discovery still needs native ranking/authority and a mounted route. No authenticated timeline inspected.                                         |
| [Discord search](https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord)                                   | User, channel, date and content predicates refine a scoped history.                                                   | Existing bounded grammar can express analogous capabilities; source and permission scope must remain explicit. Not evidence for unrestricted global search.                                   |
| [Slack search](https://slack.com/help/articles/360058495714-Find-information-you-need)                                                      | Common search spans messages/files/people with modifiers.                                                             | Shared engine plus bounded selectable kinds, not one page block per kind. Help documentation does not expose backend work.                                                                    |
| [GitHub pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)                                    | API pagination has explicit continuation links and resource limits.                                                   | Ordinary transport capability, not justification to fan out over 10,000 follows. Reuse opaque continuation semantics.                                                                         |
| [GitLab search](https://docs.gitlab.com/user/search/)                                                                                       | Search distinguishes global/group/project scope and search engines/capability availability.                           | Model supported/unsupported scope capabilities explicitly; do not pretend every configured surface supports every query. Tier/engine-dependent.                                               |
| [Shopify connections](https://shopify.dev/docs/api/usage/pagination-graphql)                                                                | Cursor connections bound result pages; documented maximum page size is 250.                                           | Established API pattern to retain; page bounds do not prove examined-row bounds or authorize returned nodes.                                                                                  |
| [Mastodon timelines](https://docs.joinmastodon.org/methods/timelines/)                                                                      | Home/public/list scopes use cursor parameters and bounded pages.                                                      | Shared read abstraction with scope and current viewer; a follow is not a new independently rendered home section. No federation scope is proposed.                                            |
| [Discourse API](https://docs.discourse.org/) and pinned source below                                                                        | Latest/category/topic queries are shared product operations with limits.                                              | Reuse domain-independent list concepts; its offset path is not a proof for deep million-item pagination.                                                                                      |
| [Open Library Lists](https://openlibrary.org/developers/api/lists)                                                                          | Lists reference works, editions and subjects rather than cloning their truth.                                         | Good authority separation. Its source's large-seed facet shortcut is an anti-pattern for our exact useful-list contract.                                                                      |
| [Bangumi API](https://bangumi.github.io/dev-docs/) and pinned server source                                                                 | Collection type is a closed five-value vocabulary; private collection reads check ownership.                          | Legitimate vertical design there; not a reason to hardcode the same states in REZICS's extensible kernel.                                                                                     |
| [VNDB API](https://api.vndb.org/kana)                                                                                                       | Explicit filters/fields and paginated results with a `more` indicator.                                                | Closed public query/representation grammar is useful. Do not expose arbitrary backend DSL; API evidence does not establish query cost.                                                        |
| [AniList Page](https://docs.anilist.co/reference/object/page)                                                                               | Page metadata separates items from continuation information.                                                          | Reuse explicit result/continuation states; do not equate a page object with universal cross-type filtering.                                                                                   |
| [Feishu search](https://www.feishu.cn/hc/en-US/articles/360025112714-use-feishu-search)                                                     | Global search and categorized scope/filter controls share a search interaction.                                       | Existing generic scope/presentation capability; supports one shared entry point, not copied per-page engines. Enterprise availability may vary.                                               |
| [Notion views](https://www.notion.com/help/views-filters-and-sorts)                                                                         | One database has alternate views, data-defined property filters/sorts and title/property search.                      | Configuration should select shared behaviour. REZICS still needs stricter public authority/cost admission; saved dynamic queries remain a scope decision already recorded as later.           |
| [Zotero search](https://www.zotero.org/support/searching)                                                                                   | Collections can constrain searches; saved searches store criteria and update results.                                 | Distinguish curated membership from derived query output. This is evidence for the distinction, not permission to bring deferred saved-query scope forward.                                   |
| [Steam assets](https://partner.steamgames.com/doc/store/assets?language=english)                                                            | Store/header, vertical capsule and Library art have different required geometries.                                    | Intrinsic artwork and slot defaults are separate. Supports retaining landscape assets while applying the settled portrait default; not a reason to reopen it.                                 |
| [YouTube filters](https://support.google.com/youtube/answer/111997?hl=en-AU)                                                                | A common search exposes a filter action and content-type narrowing.                                                   | Reuse the adopted shared search/filter interaction; documentation is not evidence for exact keyboard/focus behaviour or the live variant served to every user.                                |
| [Goodreads shelves](https://help.goodreads.com/s/announcements/a031H00000OfCxDQAV/helpful-goodreads-hack-viewing-books-on-multiple-shelves) | Exclusive reading shelves and optional custom shelves have different meanings.                                        | Separate state from labels/collections. Closed book-specific defaults do not establish generic state vocabulary for all REZICS profiles. Article is historical, not a current visual capture. |
| [Douban Books](https://book.douban.com/)                                                                                                    | Public discovery presents a bounded selection and category navigation rather than rendering every catalogue category. | Presentation reference only; public page does not reveal internal storage, ranking or logged-in collection behaviour. No private access or performance claim.                                 |

Shared patterns are explicit scope, bounded result pages, reusable read models and configuration of views over one
owner's data. Products disagree legitimately on closed vocabularies, saved queries, result mixing and artwork slots.
REZICS's extensible semantic catalogue and strict current-disclosure contract require more than copying any one
product. Use the patterns in the repository's stack; do not copy source files or adopt another product's scope.

## Primary technical evidence and reference provenance

All web sources below were consulted on 2026-10-31. Current documentation is evidence about the described design,
not proof that our pinned dependency has every current feature. Vendor documentation remains under its publisher's
terms; no implementation or long passages are reproduced. Standards are cited by document/section, not copied.

- [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html) describes one RR transaction's
  snapshot and serialization retries; [partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
  explains native partition pruning/constraints. These support batching and indexing, not a measured plan here.
- [OpenSearch pagination](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/) explains deep
  `from`/`size` cost and PIT with `search_after`. An index snapshot does not freeze native product permissions.
- [SpiceDB consistency](https://authzed.com/docs/spicedb/concepts/consistency) documents consistency tokens;
  [OpenFGA consistency options](https://openfga.dev/blog/query-consistency-options-announcement) documents stronger
  cache behaviour. Neither alone establishes REZICS's cross-owner source/privacy/lifecycle invariant.
- [DBOS workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) and
  [methods](https://docs.dbos.dev/typescript/reference/methods) distinguish durable execution/idempotency and deletion;
  [Temporal execution](https://docs.temporal.io/workflow-execution) is the established durable-history comparison.
  Engine migration would require an invariant/cost comparison, not an assumption that deletion fences all effects.
- [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider) supplies maintained protocol
  support. [RFC 9700 §4.14](https://www.rfc-editor.org/rfc/rfc9700.html) supplies refresh-token replay guidance.
  Keep protocol/crypto upstream and owner-authority integration narrow.
- [Debezium outbox](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html),
  [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/) and
  [RocketMQ domain model](https://rocketmq.apache.org/docs/domainModel/01main/) show established event/progress
  mechanisms; deduplication/acknowledgment does not close product custody.
- [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests) concerns provider request replay;
  [TigerBeetle modelling](https://docs.tigerbeetle.com/coding/data-modeling/) concerns balanced ledger accounts/transfers.
  Neither replaces native entitlement checks. TigerBeetle's current distribution/licensing must be evaluated if
  adoption is later proposed; no licence assumption or installation is made here.
- [TiDB architecture](https://docs.pingcap.com/tidb/stable/tidb-architecture/) is an established distributed SQL
  comparison. It is a reason to avoid inventing such an engine, not evidence that REZICS needs to migrate.
- [Wikibase data model](https://www.mediawiki.org/wiki/Wikibase/DataModel) shows generic statements, qualifiers,
  references and rank; [ActivityPub](https://www.w3.org/TR/activitypub/) standardizes public activity/collection
  vocabulary. Neither mandates converting all product invariants into semantic graph statements.
- [OpenAPI](https://spec.openapis.org/oas/latest.html) is a transport-boundary alternative;
  [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) provides canonical JSON and
  [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562) UUID formats. A routed UUID convention must be evaluated against
  its chosen format, not called invalid merely because some bits have application meaning.
- [RE2's project documentation](https://github.com/google/re2) describes a safe alternative to backtracking engines;
  [fractional-indexing documentation](https://github.com/rocicorp/fractional-indexing) documents the ordering-key
  primitive already imported locally (CC0-1.0). These are documentation comparisons, not additional cloned source
  audits or proposals to copy implementations. The missing bounded Collection maintenance policy remains local.
- [Google pagination guidance](https://google.aip.dev/158) supports opaque continuation. A cursor is not a grant,
  a guarantee of cheap filtering, or permission to reuse another viewer's response.

Existing reference clones were reused read-only under `/home/edge/projects/rezics/rezics-next/.reference/`.
Their existing `INDEX.md` entries already identify them; no clone was installed, built, run or modified.
Licences below are source licence observations, not permission to copy into differently licensed files.

| Reference clone / pinned revision                                                             | Actual files inspected and primary URL                                                                                                                                                                                                        | Licence / finding                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search-worker-outcome-harness/dbos-transact-ts` — `980dc55095f445b189aecb59e7f3334345179f65` | `src/system_database.ts` (`deleteWorkflows`), `src/dbos.ts`; [pinned source](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/system_database.ts)                                               | MIT, root `LICENSE`. Deletion's transaction removes status/input/output/history; that method does not install REZICS's permanent actual-ID writer fence. Not a claim about every newer upstream revision. |
| `accounts-design/better-auth` — `860c4b936b897e664145b292e14551af1fa5e6a4`                    | `packages/oauth-provider/src/index.ts`, `packages/passkey/src/routes.ts`; [pinned passkey source](https://github.com/better-auth/better-auth/blob/860c4b936b897e664145b292e14551af1fa5e6a4/packages/passkey/src/routes.ts)                    | MIT, `LICENSE.md`. Official verifier routes use `requireUserVerification: false` at verification sites; REZICS's verified-result bridge explicitly requires user verification for its authority policy.   |
| `shelves/bangumi-server` — `1997713eafc51487cbea705b37011442f35539fa`                         | `web/handler/user/get_subject_collection.go`, `openapi/components/subject_collection_type.yaml`; [pinned handler](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/web/handler/user/get_subject_collection.go) | AGPL-3.0-only source notice. Owner/private checks and closed five-state product vocabulary; learn the boundary, not a generic-vocabulary implementation.                                                  |
| `partitioned-sitemap-feeds/openlibrary` — `37e446827465be2febad416de1bc18753b66997d`          | `openlibrary/core/lists/model.py`, especially `_get_all_subjects`; [pinned source](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/core/lists/model.py)                              | AGPLv3, root `LICENSE`. Works/editions/subjects remain references; the over-500-seed facet shortcut returns empty, unsuitable for our million-member exact/unknown semantics.                             |
| `partitioned-sitemap-feeds/discourse` — `589325e2b8466178ee83acac9ec411de555a0093`            | `lib/topic_query.rb` pagination; [pinned source](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/topic_query.rb)                                                                                     | GPL-2.0-or-later, `LICENSE.txt`/source notice. Per-page limits coexist with `page × per_page` offset; mainstream pagination is not an upper-bound proof.                                                  |
| `search-visibility-witnesses/openfga` — `57b39bc3dcc12f92270602bc01eb933ca4accfbe`            | `pkg/server/commands/check_command.go`; [pinned source](https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/pkg/server/commands/check_command.go)                                                                | Apache-2.0, root `LICENSE`. Higher-consistency handling changes cache use; it does not implement all REZICS owner/source checks.                                                                          |

Repository-local pure packages explicitly licensed Apache-2.0 include Definitions, Filter, Document and Composition;
Conversion declares AGPLv3. Other packages inherit their applicable repository notices unless otherwise stated.
No external code is proposed for wholesale porting. The implementation recommendations concern designs in the
current TypeScript/PostgreSQL/OpenSearch stack and its existing libraries.

## Legacy behaviour: useful lessons and upper-bound failures

Old REZICS was read only at `/home/edge/projects/rezics/rezics`, revision
`95167ceab7173dc1c5fb0ee70568c5c95f1dba8d`:

- `apps/web/features/explore/home.tsx` uses a mixed feed with kind/language/Realm/tag query state and continuation.
  It is not simply one backend request per catalogue kind. The lesson is native mixed items plus scope, not copying
  an old storage/query stack or claiming that its UI proves the current home's backend exists.
- `services/main/src/services/api/collections/service.ts` uses `(position, targetId)` continuation, `limit + 1`,
  page-key hydration and filtering of invisible hydrated items. Candidate work is bounded for that page; many
  hidden items can produce a short visible page, which is weaker than a prepared useful-list contract. There is
  no proof here that its hydration satisfies the new partition/snapshot rules at a million members.
- `services/main/src/services/api/progress/authority.ts` checks account/self authority inside its Drizzle transaction.
  Preserve the single-owner/current-authority lesson, not the old account table as a second credential authority.
  Adjacent `progress/schema.ts` contains fixed status/kind and video/audio/publishing/program structures; extending
  those by editing a growing kernel switch would repeat the very vertical hardcoding under review.

Old rezics-next was read with `git show legacy-final:<path>` at
`1ac6ed6e0668f04e30025c41e59ceaf3bdee5061`:

- `apps/web/features/home/server.ts`, `followed-concept-feed.ts` and `home-page.tsx` provide followed Realm/Zone
  choices, saved preferences and a bounded followed-concept page (20 default, 64 maximum), with fitting tabs/More.
  The has-follows probe requests one follow. These paths do not justify saying every old home query loaded all
  follows. Rendering every followed Realm/context as a block still fails with hundreds; keep selection/search and
  one bounded current stream rather than reproducing all contexts.
- `services/main/src/modules/feed/cost-contract.ts` names explicit upper plans: anonymous 24 PostgreSQL/8 Fuseki,
  signed-in 30/8, Continue 110/30 and suggestions 60/25 statements; BestK 256, hydration M at most 8 and Trending
  5 × 16 candidates. Those are desk contracts, not demonstrated latency. Continue's book-specific seeks are not
  a generic verified-resume algorithm for all profiles; the multi-engine plan is not automatically simpler than
  the current stack.
- `services/main/src/modules/feed/compositions.ts` uses batched SPARQL `VALUES` and bounded object-tree ranges.
  Learn full-key composition and finite candidate sets. Do not import Fuseki or legacy modules merely because
  they existed, or infer that a fixed candidate count establishes current Access/privacy and database snapshots.

Neither legacy tree was changed, merged or copied. Historical strengths are behaviour references; they do not
establish current product delivery or justify weakening the new contracts.

## Security, lifecycle, accessibility and surface consistency

Current authorization is required for writes, receipt replay, source admission and final public disclosure.
Prepared source output is a derived generation, not a durable permission grant. Search negation, facets, rank,
counts and exclusions require query-level coverage; rechecking only returned hits does not protect hidden inputs.
Missing authority must remain unavailable/denied according to the owner contract, never fabricated empty success.
Opaque cursors must bind owner/viewer, query, generation and expiry as specified, with current access rechecked.
Viewer-specific client/session state must not leak through a shared cached client or public cache entry.

Lifecycle completion must enumerate owned rows, derived views, pending effects, command receipts/outbox, workflow
history, retained outputs and external copies. A bounded cleanup page and a retired workflow do not alone prove
that every late writer is fenced. Restored databases require trusted external owner admission before serving writes.
These are distinct from data minimization/retention policies and physical backup custody; do not collapse them into
one green “deleted” state.

Backend states need an accessible public representation: loading, preparing, known-empty, partial, unavailable and
forbidden have different meanings. Do not render unavailable counts as zero or replace every independent section
with a full-page error wall. Search/filter selection and scope must be labelled, keyboard operable and announced;
preparation needs a status message and recoverable continuation, and mobile full-screen search needs correct focus
entry/return. Covers need useful accessible names and honest withholding/credit. These are recommended interface
obligations derived from the shared contracts, not accessibility results measured in this audit.

Cross-surface consistency means standalone APIs, aggregate pages, Zone reads, Collection/Library scopes and clients
use the same owner grammar, limits, current-authority observations and error semantics. A story built from a recorded
response is valuable for deterministic presentation, but cannot establish this wiring. Maintain a small set of
ordinary persona/API journeys and recorded-response UI cases tied to those journeys; do not maximize test line count.

## Prioritized removal and replacement roadmap

Sizes are relative change surfaces, not elapsed-time or staffing estimates: S is one owner/contract seam,
M spans a shared adapter plus consumers, and L changes an owner algorithm/data lifecycle. No implementation or
new acceptance suite is authorized by this research recommendation.

| Order / slice                                        | Size and coherent result                                                                             | Dependencies and removal target                                                                                                                                               | Later evidence needed, not run here                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0. Reconcile capability authority                    | S per owner: date/status matrix from actual mounted composition, scope and dependencies              | Update stale claims; record saved-dynamic implementation separately from deferred public scope and reconcile merge-operation contract. Remove redundant readiness narratives. | Ordinary API route and unavailable-state inventory; do not adopt a report as contract automatically              |
| 1. One database read context                         | M/L: full-key batch hydration across Semantic and identity, one RR snapshot/database                 | Reuse Content/Rating patterns; remove per-partition transaction wrappers and pooled query escape from a batch                                                                 | Multiple partitions in one DB, moved partitions, concurrent revisions, disclosure and exact per-DB statements    |
| 2. Close released Library profile surfaces           | M: generic state summaries, explicit follow policy, actual default shelf generation binding          | Slice 0; remove duplicated fixed states outside explicit legacy adapter and dormant bulk advertising                                                                          | One non-default profile through create/change/summary/shelf/Continue/copy and real production composition        |
| 3. Million-member Collection algorithm               | L: exact member lookup, bounded ordering repair, retained publication and bounded Source integration | Slice 1; replaces owner-wide respacing/lookup rather than only increasing 5,000                                                                                               | Adversarial repeated insertion, reorder/retry, hidden members, million-owner indexed desk/native cost later      |
| 4. Large definition catalogue                        | L: immutable manifest/index and bounded type/profile/hint lookup                                     | Stable shared reads; replace monolithic runtime release assumptions and whole-catalogue picker payloads                                                                       | 200,000-kind admission, publication closure, pinned reads and bounded picker/facet paths                         |
| 5. One scoped-list admission path                    | L: common composed ledger and direct/prepared Source execution across surfaces                       | Slices 1–4 where applicable; remove loose compatibility-budget bypass and duplicate local interpreters                                                                        | Positive/negative filters, facets, revocation, resumed preparation and finite retained completion                |
| 6. Presentation authority and actual first-home seam | M: one portrait default, configured images, bounded first-scope home, mounted declared capabilities  | Slices 0/2/5; remove fallback type tables and misleading four-vertical universality                                                                                           | API-derived recordings plus bounded selected contexts; no per-kind/per-follow section expansion                  |
| 7. Lifecycle closure and patch retirement criteria   | L: every owner/history class and external restore custodian accounted for                            | Existing fences retained; consolidate common custody/registration, retire patches only on upstream equivalence                                                                | Late writer, replay, restore and physical-custodian evidence; runtime work belongs to later implementation       |
| 8. Commerce journey before new economics             | M initially: buyer/creator/current entitlement path; later wallet design separately                  | Complete producer/editor seams; preserve immutable order/provider references                                                                                                  | Ordinary API purchase/refund/protected-use journey; wallet/market acceptance only after product authority exists |

Do not start a new engine migration in parallel with these repairs. The high-value simplifications are removing
duplicate authorities, bypass paths and whole-owner algorithms. Generic product behaviour still needs domain
invariants; deleting them merely to reduce line count would simplify the code while breaking the architecture.

## Decisions and limits

Ambiguities resolved for this report:

- The inspected `dev` revision, not main-only files or an older status snapshot, determines implementation claims.
- A substantive unmounted dependency is implemented but not exposed; a mounted route with a missing native binding
  is exposed but unavailable. Neither is a delivered capability.
- Fixed legacy vocabulary is acceptable behind explicit provenance; interpreting arbitrary released vocabulary by
  literal spelling in generic behaviour is not. Structural session lifecycle states are not catalogue vocabulary.
- The 200,000-kind requirement is applied to semantic catalogue types; definition Context count is not equated with
  the number of Realms. The 100-counted-Realm policy is reported honestly rather than silently expanded to 300.
- First-scope Continue/catalogue discovery is distinguished from deferred general feeds and saved dynamic queries.
  The critique's upper-bound/mixed-home requirement does not authorize implementing a deferred feed during research.
  A private saved-rule route ahead of public scope is recorded as implemented/exposed, not presumed publicly released.
- A Source allowance is a maximum admission, not an observed cost. Identity metadata and privacy control reads are
  separate dimensions. No throughput, latency, coverage percentage or test-pass claim is inferred from source.
- Existing reference clones and their index entries suffice; no reference repository or index mutation was needed.
  The supplied screenshot is contextual evidence only. No sibling report or duplicate capture campaign was used.

No new maintainer-only choice is needed to fix the diagnosed batching, Collection bound, profile inconsistency,
default portrait or composition gaps. Two future product choices genuinely need authority before implementation:
whether and when deferred general mixed feeds/saved dynamic queries enter public scope (recommend finish first-scope
shared primitives first), and what economic instrument/custody model a later wallet/market offers (recommend avoid
transferable/withdrawable balances until explicitly required). Neither blocks this research report.

Only this report is a tracked change. There are no outside-declared-path tracked changes, adopted contracts,
interface changes or runtime verification results. Source evidence establishes the findings and recommended order;
integration, native acceptance, accessibility and growth verification remain later work.
