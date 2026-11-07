# Architecture check

Decision: Rating owns its foreign runtime capabilities in `rating/dependencies.ts`. Kernel process, reading and
worker composition bind the exact native functions and constructors before Rating use; live bindings preserve
error identity, generic signatures and overloads. Rating imports shared Global context vocabulary from Semantic's
contract and Content schema helpers from their defining leaves. Existing facade exports and behavior assertions
stay compatible. Typing is the acceptance for this import-only migration; runtime checks run after integration.

Decision: Search result saving and configured Concept following invert private Library save, owner observation and follow through a Search-owned `SearchLibraryActionPort`. `library-action-port.tsx` and `saved-query-selection.ts` are Search public entries; `search-action-binding.tsx` is the Library public adapter installed once by `LibraryApplicationBoundary`. Search results and `source-concept-view` consume the host; they no longer value-import `save-query`, `saved-query-editor/selection` or `follow-target-control`. Subject `pages/data`, overview and `load-subject` stay read/href composition for this pair.

Decision: Game edition/evidence and Manga evidence invert `pages/data` `CandidateValue` through a catalogue-owned `WorkReadingPort`. `work-reading-binding.tsx` binds that adapter at Subject page composition; the readers are public entries and no longer value-import `pages/data` or `overview.sectionClass`.

Decision: Screen profile and episode continuation are instantiated from the Semantic-owned screen reading application. Navigation descriptors are dependency-free values consumed by the visit owner. Page values, spoiler disclosure, canonical Subject hrefs and visit-return admission are a Semantic-owned port bound by Search at `OverviewRoot` / `ScreenReadingBoundary`. Semantic no longer value-imports `pages/data`, `pages/values`, `subject/candidates` or `subject-visit-navigation` for this operation. Public entries are `screen-reading-port.ts` and `screen-reading-application.tsx`.

Decision: Statement summaries invert editor-view construction through a catalogue-owned `StatementReadingPort`. Request/result vocabulary lives in `statement-editor-contract`; read/propose/reload matching live in `statement-edit-application`. The editor view and `pages/data` bind live `CandidateValue`; summaries do not import the editor view and do not close the tags/Subject value cycle.

Decision: Zone membership and mounted Collection pages invert Library route/read and load-time `CollectionSourceLedger` evaluation through a Zone-owned collection port. The Library adapter is a public entry bound by the composition root (`composition/zones.ts`) and `zoneRoutes`; composition may depend on `kernel-zones` for that install. Zone HTTP no longer value-imports `collection-routes.ts` or `collection-reads.ts`.

Decision: Zone resource commands and reads invert Access command-admission, grant initialization, parent creation, resource authorization, account snapshots and public eligibility through a Zone-owned Access port (`zones/resource-access-port.ts`). Access publishes the producer (`access/zone-resource-adapter.ts`); Zone's native adapter and `resource-application.ts` are bound at composition and `createKernel`. HTTP maps admission and outcomes onto that instance. Parent locks, page authorization, owner fences, History enrollment and participant cleanup stay in their owner commands. Public entries are `resource-access-port.ts`, `resource-application.ts`, `adapters/index.ts`, `zones/index.ts` and `access/zone-resource-adapter.ts`.

Decision: Keep the current workspace and capability boundaries, assign each module to its documented Goal owner, and snapshot existing imports as explicit dependencies while grandfathering their violations for gradual removal.

Decision: Library work-dimension vocabulary is the contract module `kernel-library-contract` with public entries under `services/kernel/src/library/contract/`. Access, Platform, Search, Semantic, Content and Zones import those shapes from it, never from the Source runtime. `kernel-library-core` and `kernel-library-application` own the pure rules and use cases; native SQL and foreign Access/Search/Semantic/Content adapters bind at `composition/library.ts`.

Decision: Library Source, member, owner-query, publication, Entry/progress and funded Progress-operation seams are typed application capabilities bound by the ordinary `composeLibraryDomain` process composition; contract, core and application modules load without foreign implementations. Search filter-leaf classification is bound at composition, so `adapters/search-scope.ts` has no Search value imports; publication-staging admits catalogue-only versus owner-only through that capability. Content cover download is a Content public entry (`content/media.ts`); Collection presentation and session/Entry native paths call the composed identity and Content capabilities rather than importing those implementations. Access `adapters/account-statements.ts` and Semantic `adapters/progress-identity-statements.ts` own the account and definition/identity SQL descriptors consumed by Library progress planning.

Measured with `scripts/architecture.ts` against the integrated base `a0c2a25650` and the same value-import graph. The
changed-base check `--changed a0c2a25650` passes with no new violations; the full audit keeps errors that also occur on
that base, where `boundary-baseline.json` already lagged `main`.

| Measure                                                      |                Base |              Branch |
| ------------------------------------------------------------ | ------------------: | ------------------: |
| Full audit errors, rule 2 / rule 3 / rule 9                  | 853 (690 / 161 / 2) | 780 (631 / 148 / 1) |
| Boundary baseline entries                                    |               7,437 |               7,085 |
| `kernel-library` baseline rule 2 / rule 3                    |           676 / 373 |           582 / 361 |
| `kernel-library` current rule 2 / rule 3                     |           814 / 416 |           662 / 394 |
| `kernel-library-core` / `-application` current rule 2/3      |                   — |       0 / 0 · 0 / 0 |
| Kernel value-cycle files                                     |                 345 |                 323 |
| Library value-cycle files                                    |                  93 |                  90 |
| Largest Kernel value SCC                                     |                 326 |                 302 |
| Outgoing value edges: `kernel-library`                       |               1,593 |               1,586 |
| Outgoing value edges: `kernel-library-core` / `-application` |                   — |               3 / 5 |
| Outgoing value edges: `kernel-composition`                   |                  86 |                 107 |

Core and application value edges go only to `bounds`, the Library contract and each other; the composition root gains
the native Library adapter bindings. Against base the branch removes 352 baseline entries, 73 audit errors and 22 Kernel
value-cycle files, and the baseline only shrinks.

Decision: Register Access, Bounds, and Operations as pure core modules with only their exported package entries; grant dependencies to the concrete Kernel adapter modules that actually import them, and keep native implementation choice in composition roots.

Decision: Split Kernel Access into `kernel-access-contract`, `kernel-access-core`, `kernel-access-application` and
the existing `kernel-access` adapter. Contract, core and application have no downstream behaviour imports. Native
Access ports are bound at the Kernel composition root; Content, Community, Semantic, Library and Search publish
`access-capabilities.ts` public entries for those adapters. After wiring, kernel-access baseline rule 2/3 counts are
389/368 (from 403/376), current 391/365; Access outgoing behaviour edges 61 (from 69); Kernel files in value cycles
403 (from 405); largest value SCC 386 (from 388).

Decision: Split Kernel Work into `kernel-work-contract`, `kernel-work-core`, `kernel-work-application` and native
adapters that remain in `kernel-platform`. Contract, core and application have no downstream behaviour imports.
Native Work ports are bound at the Kernel composition root; product module assembly lives in `composition/work-modules.ts`.
Facades keep the previous import paths. Compact fake-port tests pin enqueue, registration and retirement; landing
worker tests carry receipt keys through `workerTestEnv`. Existing native Work fixtures remain the causal set.
After wiring, kernel-platform baseline rule 2/3 counts are 180/155 (from 190/155), kernel-composition rule 2 is 18
(from 24), total baseline 9,411 (from 9,427). Current Kernel files in value cycles 398; largest value SCC 381;
Work adapter outward behaviour edges 22.

Decision: History is registered as contract, core, application and adapter modules. Foreign modules use its declared application and contract entries; `composition/history.ts` binds native Postgres, command, Access, Semantic, Search, Zones and Work adapters. Server, worker, the shared runtime defaults and the explicit `composition/preload.ts` hook install that composition before use. Application facades remain implementation-free, native adapters import owner facade leaves rather than the application barrel, and no History file participates in a value-import cycle.

Measured with `scripts/architecture.ts` against base `a311990286`: the changed-base check passes with no new violations.
Kernel files in value cycles are 345 and the largest value component is 326 files; History files in value cycles are
zero. Violations that touch History source fell from 312 to zero. History source files have 109 outgoing value edges to
other modules at final; the increase is the native owner bindings in adapters, while contract, core and application
import no implementation. Baseline entries fell from 8,496 to 7,437. The full-graph check reports inherited unbaselined
errors outside this change at final.

Decision: The client declaration closure depends on the public Access, Bounds, Money, Operations, Progress and
Search Text packages used by mounted contracts. Register those dependencies alongside the client's existing package
dependencies; generated declarations retain the native package identities and the boundary baseline does not grow.

Decision: Semantic is registered as contract, core, application and adapter modules. Subject facts, item projection and canonical identity reach production through those layers. Library Source custody, Search currentness, Rating review and Content lifecycle reach inward code only as Semantic-owned ports, bound by the composition root together with hashing and routing. Content lifecycle includes batch cover reads. Subject, summaries and bulk HTTP resolve that port through `adapters/ports.ts` and the composed registry; they do not value-import `adapters/content-lifecycle.ts`. The identity-epoch participants remain `IdentityEpochParticipantPorts`. A fake-port application loads without native downstream implementations; ordinary createKernel/server/worker uses the real adapters. Public entries are contract/core/application index files, identity-core including the literal-only `rating-review-bounds.ts` leaf, adapters/native-domain, adapters/index, identity-adapter-port/runtime construction, and the existing identity-adapters mapping-read, store and binding files. Identity-epoch adapters import rating-review bounds from that leaf. Compact tests pin the fake-port domain and ordinary native composition. After wiring, kernel-semantic baseline rule 2/3 counts are 361/383 (from 521/384); total baseline 8,513 (from 9,390). Kernel files in value cycles 398; largest value SCC 381. Inward layers have no downstream behaviour value edges.

Decision: Routed Zone composition consumes Search page, visit-return and slot-admission helpers through existing public entries (`showcase-work`, `search/index.ts`, `kernel/client.ts`) and already-imported Zone reader files; it does not add manifest public entries.

Decision: The public Zone shell type is the composition appearance, label and language vocabulary in the Zone reader; Web does not import kernel `contract.ts` for it.

Decision: `apps/web/src/subject/load-subject.ts` is the web-app public entry for canonical subject reads and href helpers (`loadSubject`, `canonicalRedirect`, `keepSearch`, `accountHref`, `subjectHref`, `subjectViewHref`, `subjectUrlForView`, `subjectViewPaths`); routes, Search concept pages and Semantic Character reading import them there rather than importing `subject-href.ts` directly, so they add no rule 2 edges.
Decision: Character public preview, credited-work continuation and credit inspection consume Semantic-owned page/read/navigation slots from `character-reading-port.ts`, orchestrated through `character-reading-application.tsx`. `character-reading-binding.tsx` installs the Search page adapters beside `OverviewContext` in `PageData`. Those files no longer value-import overview, data, cover-list or subject-connections; Search pages import the application public entry. The Character cycle through those edges is removed. Adapters copy only defined optional fields between CharacterPage and OverviewValue so `exactOptionalPropertyTypes` holds.
Decision: Library Loans pages are public at `loans-current.tsx`, `loans-query.ts` and `loans-actions.ts`. The `/library/loans` route imports those entries and Web session/head composition (`session/guard.ts`, `shell/head.ts`, `shell/head-context.ts`). Loans consumes the owning Web entries for exposure, personal query, platform-closed, session query, page heading and Search `features/pages/shared.tsx` page text.
Decision: Settings Collection privacy and Shelf type/default/column preferences consume Library through `settings-contract.ts` and `settings-adapter.ts`. Settings `ports/library.ts` is the consumer contract; `adapters/library.ts` and ordinary `/settings` bind the existing transport. Presentation lives in `adapters/library-view.tsx` so Bun emit does not collide with `library.ts`. Inbox republishes the same port. Visibility, occurrence, frontier and preference vocabulary stay in the contract. Settings no longer privately imports Library read, dynamic Collection, Shelf column, parameter, preference, type-read or window-navigation files. This pair removes 14 recorded rule-2 edges (12 web-performance, 1 web-library, 1 web-composition public Settings read). Remaining Settings↔Library behaviour goes through those public entries; rule-3 module cycles are unchanged. SCC and import-closure counters stay with the landing architecture check.
Decision: Library Loans pages and the `/library/loans` route consume declared public entries: `loans-current.tsx`, `loans-query.ts` and `loans-actions.ts` on web-library; gated exposure, personal query, platform-closed, session observer/guard and shell heading/head on web-app; shared page text on web-search `features/pages/shared.tsx`. Those files own the behaviour; they are not alias barrels.
Decision: `apps/web/src/threads/community-entry.ts` is the Content public entry for admitted Board creation (`BoardStartThread`); `apps/web/src/threads/thread-reading-context.ts` is the Content public entry for a post's immutable published citation (`publishedCitationForPost`) and the owner localized thread route (`threadLocation`). Subject and Thread readers import the citation; Inbox imports `threadLocation` there rather than `thread-href`. Board, thread-page and `thread-href` remain the authorities. The original `readingPageDocumentMedia` helper keeps native page-order `pageIndex` from the bound post; it does not add a second projection.
Decision: History is registered as contract, core, application and adapter modules. Foreign modules use its declared application and contract entries; `composition/history.ts` binds native Postgres, command, Access, Semantic, Search, Zones and Work adapters. Server, worker, the shared runtime defaults and the explicit `composition/preload.ts` hook install that composition before use. Application facades remain implementation-free, native adapters import owner facade leaves rather than the application barrel, and no History file participates in a value-import cycle.

Measured with `scripts/architecture.ts` against base `a311990286`: the changed-base check passes with no new violations.
Kernel files in value cycles are 345 and the largest value component is 326 files; History files in value cycles are
zero. Violations that touch History source fell from 312 to zero. History source files have 109 outgoing value edges to
other modules at final; the increase is the native owner bindings in adapters, while contract, core and application
import no implementation. Baseline entries fell from 8,496 to 7,437. The full-graph check reports inherited unbaselined
errors outside this change at final.

`modules.json` assigns the production sources in Kernel, Auth, Importer, Web, and the runtime packages to one module each. Tests, stories, fixtures, and workspace configuration are not production source roots. Each module records its kind, owner Goal, registered capabilities, public entries, and current allowed module dependencies. Kernel foundation code with no product owner is assigned to `platform`.

The checker enforces source coverage, public entry imports (including type-only edges), module dependency direction and cycles, new value-import cycles, pure core and contract imports, adapter SQL ownership, package isolation from apps and services, and ratchet integrity. Current violations are grouped by source module in `boundary-baseline.json` with the module owner and reason `pre-boundary code`. A disappearing entry is reported so the group can be reduced.

## Parser and runtime

The check uses Bun's transpiler import scan for value dependencies and a code-aware lexical pass to retain type-only imports and source locations. It does not execute modules. Relative paths, package exports, workspace path aliases, and declaration-file fallbacks are resolved; conditional workspace exports are combined across their declared targets. SQL files are graph targets but are not parsed as TypeScript.

The full graph is cached under `.temp/architecture/graph.json`. `--changed <files...>` hashes the production roots, reparses only the listed changed files, and checks those edges against the complete cached graph. If the changed list is incomplete or the manifest or resolution configuration changed, the command asks for a fresh full scan.

`--changed <base>` is the dev landing mode. If the manifest, baseline, resolution files, and production source tree match the captured commit, the diff proves there are no new architecture violations. Otherwise it audits the final candidate once, reconstructs the graph at the captured Git commit from unchanged source edges plus the changed source blobs and base resolution files, and reports only errors newly present in the candidate. Existing violations do not block a candidate that adds none. The boundary baseline still cannot grow.

## Commands and exit codes

| Command                                            | Purpose                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun scripts/architecture.ts`                      | Validate the manifest, current graph, and baseline; refresh the graph cache.                                                                                                                                                                                                                                                                                                   |
| `bun scripts/architecture.ts --changed <files...>` | Recheck changed source edges against the cached complete graph.                                                                                                                                                                                                                                                                                                                |
| `bun scripts/architecture.ts --changed <base>`     | Compare one candidate graph with the captured commit and report only new violations.                                                                                                                                                                                                                                                                                           |
| `bun scripts/architecture.ts --map`                | Print the compact full module map (capped at 6,800 characters), including public entries and allowed dependencies. Worker prompts select rows by the brief's paths instead of this dump. Path-selected maps group public entries by directory, retain owned rows, include dependency rows while they fit, and point at this manifest when the bound truncates dependency rows. |

Decision: Keep the ten architecture tests. Pin Search's owned row and a deterministic fit/overflow fixture on the map case; drop the gone Library ScopeWork initializer; refresh the `@rezics/bounds` consumer list from verified public imports. Rule 9 remains strict with zero repository reads at import time: typed forwarders and memoized factories defer native bindings, literal-only leaves hold shared constants, and History installs Semantic's producer during ordinary composition. No new stories. Native, browser and growth stay on the sole Performance walk; Content, Accounts and Commerce walks keep their original receiving.

Exit code `0` means the check passed, `1` means an architecture or manifest violation, and `2` means invalid CLI input, unavailable cache, or a tool/configuration failure. The full graph build and initial ratchet seeding took 14.7 seconds for 6,876 production files on this worktree. The full base-delta path took 14.6 seconds for 7,433 production files in this worktree. The full check is budgeted at under 30 seconds; cached changed checks at under 5 seconds.
