# Architecture duplication audit

## Answer and source boundary

The product still has one kernel and graph, but has duplicated mechanisms around that core.
The most expensive boundary failure is runtime cost accounting copied across Collection,
History and Work. Next come browser reader lifetimes and catalogue creation orchestration.
Provider-specific Library imports repeat a common confirmation lifecycle. These are better
consolidation targets than merging every reader, card or unavailable-state component.

This is a source audit, not a claim of runtime acceptance. The retained source is
`ee25737c58757cf0cc85867519db4cc0bb42379f`. The observed local `dev` tip was
`9b39b4eb145c97a49ea69b63e70a1620a20c8dfe`, a descendant of that source. A path-scoped
Git comparison found no intervening changes in the finding modules below, including
Work/History, the four retained-list importers, browser lifetimes, catalogue creators,
UI hooks and token codecs. No merge, checkout or source mutation was needed to inspect dev.
Later dev changes are outside this report's conclusions.

Ranking combines potential user impact, duplicated executable mechanism and repair spread.
A static inconsistency is described as such; a possible stale response is a regression risk,
not an observed disclosure incident. Estimates are engineering estimates of added plus deleted
lines, including focused caller coverage, not measured savings or a quota to fill. Nested
findings share work and must not be added together as independent savings.

The owning rules are [architecture](../architecture.md), especially its one-authority and
static-ceiling rules, [viewer actions](../viewer-actions.md), [catalogue editing](../catalogue-editing.md),
[filtered lists](../filtered-lists.md), [subject pages](../subject-pages.md) and
[retained entry metadata](../library-import-entry-metadata.md). Ownership follows
[scope](../scope.md): Web owns browser infrastructure, Semantic owns catalogue contracts,
Commerce owns Library persistence and Performance owns cost verification. The package READMEs
separate vocabulary/validation, inert composition, conversion, client declarations,
documents and reusable UI from native kernel behavior.

**Decision:** consolidate executable mechanisms behind existing owners and typed adapters;
keep independent domain authority, disclosure and presentation choices. Adoption belongs in
the respective owner document, not in this research report.

## Ranked findings

| Rank | Finding | Product cost | Proposed single owner | Changed-line estimate |
| --- | --- | --- | --- | --- |
| 1 | Runtime price protocols across three modules | Extra refusal paths and repeated accounting coupled to SQL changes; violates architecture | Kernel Work execution; static costs with Performance | 2,400–3,000 for a bounded Members/History consolidation |
| 2 | Repeated session/lifetime observation | Divergent retirement rules and repeated cache subscriptions in privacy-sensitive flows | Web session/viewer infrastructure | 2,200–2,800 for core and representative consumers |
| 3 | Per-profile creation orchestration | Every metadata/draft/focus fix has multiple implementations | Web catalogue creation host | 2,200–2,800, including finding 5 |
| 4 | Four retained-list metadata confirmation coordinators | Replay, cancellation and stale-review fixes spread across provider implementations | Commerce Library metadata adoption | 2,400–3,000 for first two adapters |
| 5 | Statement summary rebuilt by profile | Same qualifiers/references/rank renderer; misleading common rank label | Web shared statement presentation | 600–900 within finding 3 |
| 6 | Cross-feature lifetime helpers owned by Library | Ratings imports Library infrastructure and personal-library gate context | Web common reader infrastructure | 500–800 within finding 2 |
| 7 | Two installed mobile hooks | Breakpoint/subscription fixes require two exports and consumer migrations | packages/ui hooks/use-mobile.ts | 80–150 |
| 8 | Superseded dialog behavior remains exported | Old Ark-shaped helpers alongside current Base UI; accidental reuse risk | packages/ui current dialog primitives | 80–140 |

### 1. Runtime accounting has become multiple engines around the engine

**Evidence.** `services/kernel/src/library/collection-source-work.ts` (948 lines) defines
`NativeCollectionWork`, eight axes, balances, held amounts, reservations, dispatch and settlement.
Its `reserve` begins at line 310 and its producer transfer starts around line 223.
`services/kernel/src/history/operational-work-budget.ts` (386 lines) repeats cost arithmetic,
phase prices, original ownership and prepaid child binding. Lines 205–220 reserve and settle
`OPERATIONAL_WORK_LOCAL_DECLARATION`; `fundOperationalWorkChildren` at line 229 checks foreign
children against prices and throws `operational-work-native-funding-unavailable`.
`services/kernel/src/work/selected-runtime-cost.ts` defines another axis list, arithmetic and
local/cleanup partitions. `services/kernel/src/work/selected-runtime.ts` (462 lines) maintains
separate remaining and cleanup balances, debits them at line 124, and refuses with
`selected-runtime-admission-exhausted`. Lines 348–385 construct the balance and prepaid lifecycle.
These are executable dispatch requirements, not just documented static ceilings.

**Boundary and impact.** Architecture says: “Do not build runtime price protocols between
owners” and explicitly excludes “prepaid funding” and “no-refill ledgers”. It requires the
producer's documented static bound instead. History imports `NativeCollectionWork` from Library;
Work imports History cost types. General execution infrastructure therefore depends on a
feature's accounting engine. A changed SQL footprint can require updating multiple prices and
phase transfers before otherwise bounded useful work can run. The explicit refusal paths are
observable code behavior; this audit does not establish how frequently users encounter them.

**History.** `ac4f601137` adopted the static-ceiling rule. `0c6de27f1b` deliberately bound
Members History phases to original child funding. `1d7117153f` and `c9935f3a05` are later
squash entries around this area; their subjects alone do not explain intent. This is deliberate
local machinery inconsistent with the current architectural direction, not an accidental duplicate
class that can simply be replaced by one more shared ledger.

**Single owner and consolidation.** Work owns execution identity, deadlines, durable steps and
replay. Library and History keep native source/partition/disclosure guards. Performance owns
static cost derivation and growth proof. Remove accounting-based dispatch authority from the
selected Members/History path; do not replace three ledgers with a fourth. Preserve native SDK
execution identity, transaction ownership, bounded SQL, retry limits and cleanup. Keep exported
static constants where composition needs a bound.

**Estimate.** 2,400–3,000 changed lines across the named files, their connected Members/source
callers and focused tests; approximately 700–1,100 accounting lines removable in that slice.
Broader accounting callers require later bounded migrations, not a global deletion.
Continuation: `.temp/continuation/static-members-history.md`; owning Goals: Performance for
cost design, Commerce for Library caller, Accounts for History/Work infrastructure.

### 2. Browser reader lifetime mechanisms repeatedly observe the same session

**Evidence.** `apps/web/src/session/browser-state.ts` manages per-QueryClient subscriptions and
normalizes observations. `apps/web/src/kernel/viewer-exposure.ts` independently tracks session
query incarnations, response identity, CSRF and updated timestamps in `ViewerExposureLifetime`.
`apps/web/src/subject/candidate-lifetime.tsx:127` builds a third session observer registry;
`observeSession` serializes state/subject/CSRF and increments its own revision from cache events.
`apps/web/src/library/library-workspace-admission.tsx` adds viewer and per-operation granted,
episode and dispatch state. `apps/web/src/library/history-current-origin.tsx:25` then adds
address, hydration, parent lifetime, mount and retirement state around that admission.
`apps/web/src/features/catalogue/editor-lifetime.tsx` adds current-reading tokens and recursive
transport fencing. These mechanisms have real distinctions but repeat the basic observation,
subscription and generation lifecycle.

**Impact.** The candidate observer compares a serialized value triple; viewer exposure also
tracks query incarnation information. These are different invalidation definitions. Any shared
refactor must preserve intentional differences rather than assume equal account IDs mean the
same request. Repeated all-cache subscriptions and feature-specific cancellation wrappers also
make the A→B→A, unmount and stale-promise cases costly to reason about. No cross-user leak was
executed or demonstrated by this audit.

**History.** `11fdc093d3` and `eaacf04311` deliberately fenced catalogue work to its original
reader and address. `4dd57dcea7` added scoped Library admission, followed by `f4a534ac6c`
which admitted copy/label reads without mutation credentials. These are security corrections
with different consumers, not obsolete code to delete without behavioral coverage.

**Single owner.** Web's session/viewer layer should own one monotonically retiring observation
and subscription per client. Compose typed read-admission, operation-admission and address leases
from it. Candidate/editor and Library adapters retain private drafts under their current policies;
resource `viewerActions`, platform exposure and authentication remain distinct authorities.
A browser lease never replaces a prepared authenticated server request.

**Estimate.** 2,200–2,800 changed lines for infrastructure and catalogue/ratings/history
consumers; about 350–600 repeated observation/lease lines removable. This includes finding 6.
Continuation: `.temp/continuation/shared-reader-lifetime.md`; owning Goal: Web, with Accounts
review for authentication and Semantic review for catalogue caller semantics.

### 3. Configurable catalogue creation still repeats orchestration per profile

**Evidence.** Under `apps/web/src/features/catalogue/`,
`music-context-create-session.tsx` (311 lines), `catalogue-file-create-session.tsx` (310 lines)
and `concept-create-session.tsx` (517 lines) each maintain `reading`, `lastGood`, pending metadata,
term drafts, facts by type, archived types, a refreshing flag and a prepared snapshot. Compare
music-context lines 43–116 and catalogue-file lines 44–117: retained-type calculation,
active/archive merge and metadata refresh are structurally the same. Each constructs a transport,
profile and review wiring around the existing `CreateSubjectForm` and `useCatalogueLifetime`.
Concept additionally has a real classification-return handoff and leave confirmation.

**Impact.** A metadata release change, newly unsupported type or retry while a draft exists must
be repaired in each host. This is duplicated UI engine behavior, despite the shared lower-level
form. Separate fields, messages, catalogue-file hash notices and Concept handoffs are valid frontend
customization; they do not justify three copies of the metadata/draft lifecycle.

**History.** `8d79181006` introduced music-context creation; `15ca41691b` introduced evidenced
catalogue file/release-group creation. The subsequent adaptation/fix and formatting commits show
separate feature delivery. Existing reuse of `CreateSubjectForm`, statement controls and native
commands is deliberate; repeated orchestration is a consolidation opportunity left by that delivery.

**Single owner.** A Web catalogue creation host owns metadata refresh, retained-type drafts,
prepared snapshot invalidation and review navigation. A typed profile supplies admitted types,
field presentation, native commands, labels and optional handoff hooks. Semantic definitions and
native command validation continue to own meaning. Keep this host in Web: React lifecycle and
browser focus do not belong in `packages/definitions` or inert `packages/composition`.

**Estimate.** 2,200–2,800 changed lines, including the three callers, shared host and finding 5;
roughly 450–700 repeated orchestration/presentation lines removable. First migrate these closely
matched creators; do not force unrelated recipe or publication editors into the same shape.
Continuation: `.temp/continuation/catalogue-create-host.md`; owning Goal: Web, collaborating
with Semantic for unchanged catalogue authority.

### 4. Retained-list importers duplicate metadata review and confirmation coordination

**Evidence.** `services/kernel/src/library/list-import-anilist.ts:811`,
`list-import-bangumi.ts:628`, `list-import-mal.ts:1668` and `list-import-vndb.ts:1251`
each define `reviewMetadata`. The same four files define `metadataView`,
`persistMetadataConfirmation` and `applyMetadata`. All build an `EntryImportMetadataReview`
with review token, caller, annotation revision, personal/source/profile digests and incarnation;
then guard retained review history, persist a confirmation and reconcile its outcome.
The common proposal/digest types are already shared; coordination remains repeated.

**Impact and limits.** Cancellation, pending confirmation, review-history bounds, changed
incarnation and uncertain command replay must remain consistent across providers. Inspection
also reveals genuine differences: MAL mutates an upload document and takes an explicit deadline;
AniList uses per-row storage/load/save and separately checks the current metadata profile digest.
Those differences prevent blindly replacing one whole importer with another. This finding is
repeated lifecycle policy, not evidence that provider parsers or source consent are redundant.

**History.** `29c5052916` added MAL score review; `e59998093e` retained AniList score review;
`4ae8028de2` added AniList/VNDB dates; `11580735dd` repaired VNDB source consent and original
command reconciliation. The importer families deliberately evolved separately. Their provider
specificity is justified; shared metadata confirmation policy can now be factored without
merging source evidence or permissions.

**Single owner.** Commerce's Library metadata-adoption coordinator should own review identity,
confirmation phases, limits and uncertain outcome reconciliation. Storage adapters provide
owner-scoped load/CAS/persist; provider adapters provide retained evidence and explicit field
mapping. Native annotations/source observations remain their existing command authorities.
Follow `docs/library-import-entry-metadata.md`; do not move private Library adoption into
`packages/conversion`, which converts catalogue provider data.

**Estimate.** 2,400–3,000 changed lines for AniList and Bangumi plus coordinator and caller tests;
approximately 300–500 duplicated lines removable there. A later MAL/VNDB migration may change
another 1,500–2,300 lines because their persistence and reconciliation differ.
Continuation: `.temp/continuation/list-metadata-coordinator.md`; owning Goal: Commerce.

### 5. Statement summaries are rebuilt inside vertical creation reviews

**Evidence.** `apps/web/src/features/catalogue/music-context-create-review.tsx:19–101`,
`catalogue-file-create-review.tsx:21–106` and `concept-create-review.tsx:20–102` each implement
`partLabel` and a profile-named StatementSummary. They render the same property/value,
qualifier list, ordered reference groups, empty-reference explanation and rank using `PartValue`
from `statement-editor-view.tsx`. Catalogue file adds a legitimate hash/codec notice.
All three summaries select `candidate_rank_normal` unconditionally, then append the actual rank
code when it differs from normal: a concrete inconsistent rank presentation in the shared pattern.

**History.** The music-context and catalogue-file introduction commits in finding 3 explain the
separate renderers. `2ee55cd187` later kept music-context summaries on descriptor projections,
which is a semantic guard the shared renderer must retain.

**Single owner and estimate.** Web shared statement presentation should own one summary renderer,
with a profile notice slot and descriptor-provided values. Preserve qualifier and citation group
order, fallback languages and unsupported-value disclosure. Estimate 600–900 changed lines,
150–220 repeated lines removed, included in finding 3's brief. `packages/ui` can provide inert
frames, but should not import catalogue releases, native readers or page policy.

### 6. Reusable reader infrastructure lives inside Library

**Evidence.** `apps/web/src/ratings/own-votes/current-origin.tsx:4–9` imports
`useLibraryWorkspaceAdmission`, `assertHistoryCurrent`, `useHistoryAddress`,
`useHistoryCurrentOrigin` and `useHistoryReadOrigin` from `apps/web/src/library/`.
Its `ownVotesQuery` also embeds the literal `personal_library` gate context. The generic
history origin itself depends on router, session and operation exposure, not Library records.

**Impact and history.** `1f0fa0d853` completed My ratings recovery using these existing helpers;
this is intentional reuse, preferable to another copy. The defect is module placement and
implicit context ownership. It makes Ratings depend on a feature folder for basic reader
lifetime and encourages future copies when other feature owners avoid that dependency.
There is no documented ban on every cross-feature Web import, so this is an ownership smell,
not a claimed forbidden-import violation or proof the current gate is wrong.

**Single owner and estimate.** Move the common admission/address primitive to Web infrastructure,
pass exact operation/context descriptors, and leave thin Library adapters where their retained
state policy is domain-specific. Include Ratings as a real consumer. Estimate 500–800 changed
lines within finding 2, with small net savings; ownership clarity is the primary benefit.

### 7. The same mobile hook has two public implementations

**Evidence.** `packages/ui/src/hooks/use-mobile.ts` (19 lines) and
`packages/ui/src/hooks/use-is-mobile.tsx` (23 lines) both export `useIsMobile`, use breakpoint 768,
subscribe to `matchMedia` and derive the answer from `innerWidth`. `packages/ui/package.json`
exports the first explicitly and the second through the hooks wildcard. Sidebar and
`apps/web/src/threads/post-reading-outline-view.tsx` use the former;
`apps/web/src/library/collection-filters.tsx`, `selection-review-view.tsx` and `copies-page.tsx`
use the latter. Both implementations are installed and used.

**History.** `0f485d170e` ported the old UI foundation; `77ae8674d1` rebuilt on shadcn/Base UI.
This is leftover equivalent infrastructure across a deliberate foundation migration.

**Single owner and estimate.** Keep `packages/ui/src/hooks/use-mobile.ts` as the owner, migrate
known callers and temporarily re-export from the old name if compatibility needs it. Estimate
80–150 changed lines including affected caller coverage; net removal about 20 lines. This is a
small repair to include with a real UI journey, not a 2,000-line standalone assignment.

### 8. Superseded dialog behavior is still publicly reachable

**Evidence.** `packages/ui/src/hooks/use-dialog-behavior.tsx` (58 lines) exports
`useDialogOpen`, `initialDialogFocus` and `useDialogContentRef`; its comment refers to Ark and
its open-change callback accepts `{open}`. The installed
`packages/ui/src/shadcn/dialog.tsx:4` uses `@base-ui/react/dialog`. A scoped symbol/import
search across `apps` and `packages/ui/src` found no consumers of the old helpers. The hooks
wildcard in `packages/ui/package.json` nevertheless exports the file.

**History.** `0f485d170e` introduced the old helpers; the later Base UI rebuild named in finding 7
replaced the foundation. `679c59ffb1` fixed typing in the old helpers, not migration to Base UI.

**Single owner and estimate.** Current UI dialog primitives own dialog interaction. Remove the
unused old helper after checking dynamic/subpath consumers at implementation time; no replacement
helper is required. Estimate 80–140 changed lines including focused interaction coverage, net
removal 58 lines. Absence of static imports is evidence of likely dead code, not proof about
untracked external consumers. Group with finding 7 in a relevant UI delivery.

## Similarity that should remain

- `services/kernel/src/tokens/cursor.ts` and `tokens/list-cursor.ts` both represent continuations,
  but the latter binds viewer/route/query and has explicit default/search byte profiles.
  `264dbe3090` deliberately made anonymous list cursors deterministic; `bd050b9121` finalized
  search bounds. `library/entries.ts` still calls the generic cursor and validates partition
  epoch. These differences are deliberate protocols; migrate callers only against an adopted
  endpoint contract, not a name-based deduplication. Keep token mechanics owned by Tokens.
- `packages/filter` admits the closed filter language; Search compiles/prepares public search,
  while Library owns owner-local plans. `docs/filtered-lists.md` explicitly assigns those roles.
  This is one language with different physical readers, not proof of competing engines.
- `apps/web/src/subject/definitions.ts` caches public immutable releases and a short-lived active
  pointer; `apps/web/src/security/page-cache.ts` caches eligible public HTML.
  `apps/web/src/kernel/viewer-exposure.ts` uses observation-bound private Query keys with zero
  retention. Different authority and freshness explain these layers; never combine them into
  an indiscriminate cache or put viewer answers in the public cache.
- `apps/web/src/search/results.tsx` already composes UI `ListRow`, `ContentItemHeading`,
  `ContentItemTitleLink` and common cover helpers. A search row differing from a shelf card is
  allowed frontend presentation, not evidence that the UI card primitive was rebuilt.
- `apps/web/src/kernel/client.ts:74–93` loads fake transport only behind `import.meta.env.DEV`
  when no kernel origin is supplied; production throws on missing origin. Fake modules are
  development/story support, not a proven installed production fallback to delete.
- The scoped import scan found no direct Web/kernel/UI dependency in the definitions,
  filter, composition, conversion and document package source imports examined. This does not
  certify every transitive or dynamic import; the positive boundary finding is the explicit
  Work → History → Library accounting coupling in finding 1.

## Primary-source comparison and recommendation

The reused reference is `.reference/catalogue-editorial-journey/wikibase`, commit
`f04124242a234a3c37f96d4be3b6ace69aebde17`, read using Git objects because the clone is sparse.
Its source headers identify GPL-2.0-or-later; repository `COPYING` supplies GPL version 2 and
explains directory-specific overrides. No source is copied or executed.

- [Wikibase statementview source](https://github.com/wikimedia/Wikibase/blob/f04124242a234a3c37f96d4be3b6ace69aebde17/view/resources/jquery/wikibase/jquery.wikibase.statementview.js),
  local Git path `view/resources/jquery/wikibase/jquery.wikibase.statementview.js:1–105`,
  composes generic statement, qualifier and reference views with configurable builders.
  [referenceview](https://github.com/wikimedia/Wikibase/blob/f04124242a234a3c37f96d4be3b6ace69aebde17/view/resources/jquery/wikibase/jquery.wikibase.referenceview.js),
  corresponding local Git path lines 1–75, separately owns Reference display/editing.
  The transferable design is statement-level composition, not its jQuery implementation.
- [React's official custom-hook guidance](https://react.dev/learn/reusing-logic-with-custom-hooks)
  distinguishes reusable stateful logic from shared state. This supports one reusable creation
  lifecycle with independent drafts per mount, not a global mutable editor store.
- [TanStack Query's official query-key guidance](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys)
  makes keys identify cached data and include changing dependencies. Keep reader/address/operation
  provenance in private query identity while centralizing observation; a shared hook alone does
  not make two different private reads interchangeable. These documentation references inform
  design; they are not a licence grant to copy site content or snippets.

The shared pattern is a stable generic mechanism with explicit inputs and domain-specific
composition. For this TypeScript/Bun, React/TanStack, PostgreSQL/DBOS stack, retain current
libraries and owners: native authority in kernel modules, static bounded-work derivations,
a Web-owned retiring reader observation, and typed catalogue/import adapters. Do not introduce
a new package, scheduler, permission engine or configuration language for this cleanup.

Adopt findings 1–4 as separate complete journeys in the supplied continuation briefs. Findings
5 and 6 are part of those consolidations; attach 7 and 8 to the next relevant UI journey.
Each brief specifies preserved user outcomes and regression cases rather than source-count
checks. Move decisions into owner documents only when adopted. The reference reuse is indexed
in `.reference/INDEX.md`; the only tracked deliverable is this report.
