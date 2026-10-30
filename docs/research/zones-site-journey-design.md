# Configured Zone site journeys

Research date: 2026-10-31. This is desk research and a recommendation for adoption, not a new contract or
evidence of native user outcomes. The existing whole source-page runtime work is already registered; ordinary
routing and the controller own its landing. This report neither dispatches a replacement nor re-verifies it.

The recommended product is one owner workspace around the existing Zone resource: choose an inert starter,
edit its configured routes with the common editor, select released scopes and common Collections, save with
the existing CAS protocol, preview through the current reader, and change visibility with Publish. The same
reader must carry the actual viewer through source-dependent pages and subject links. Finish withdrawal,
trash, restoration and terminal cleanup in those same owners. No second site engine, membership store,
permission formula or publication database is needed. The public slice remains static configured documents
without source reads; the source-dependent journey stays closed behind `zone_sources` until its existing
native dependencies deliver the whole outcome. [Zones](../zones.md), [scope](../scope.md),
[Zone membership](../zone-membership.md).

## What the primary sources establish

These products supply interaction patterns, not REZICS authority or implementation files. The conclusions in
the last column are design inferences constrained by the existing REZICS contracts.

| Primary source                                                                                                                                                                                | Observed product pattern                                                                                                                                                                                                                                                                                                                       | REZICS fit and important difference                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Notion Sites publishing](https://www.notion.com/help/public-pages-and-web-publishing)                                                                                                        | A page's Share → Publish action leads to View site; subsequent content changes update the site. Database views and their item pages remain navigable. Subpages are public by default. Unpublishing the Site can leave a separate general public-link permission active. Published metadata can contain contributors' names, photos and emails. | Keep an explicit reader link and explain that saving a visible Zone changes it immediately. Use existing Zone visibility to return to private; do not introduce a second public-link switch. Neither automatic source publication nor contributor metadata belongs in `ZonePublic`. |
| [Notion sharing](https://www.notion.com/en-gb/help/sharing-and-permissions)                                                                                                                   | Editing content, editing database structure and sharing have distinct permissions. Page-level database access rules also apply in linked views.                                                                                                                                                                                                | Separate configure from publish and from Collection authority. A configured view is no grant in its source. Do not import Notion's permission-combination rules.                                                                                                                    |
| [WordPress Query Loop](https://wordpress.org/documentation/article/query-loop-block/)                                                                                                         | Query selection, repeated Post Template, pagination and No Results are separate parts. A query can inherit the current template query or use explicit filters/order. Editing the item template affects the repeated items.                                                                                                                     | Reuse closed composition components and their code-owned read descriptors. Bind a list to the admitted Zone source restriction; never let a default component silently issue a global query. An empty successful result and unavailable/preparing are distinct UI states.           |
| [WordPress editor entities](https://developer.wordpress.org/block-editor/explanations/architecture/entities/) and [Posts REST API](https://developer.wordpress.org/rest-api/reference/posts/) | The editor tracks entity edits separately from saving them. REST exposes content, slug and publication status, with view/edit contexts; deletion has a force option separate from trash.                                                                                                                                                       | Make local edits, a durable save and the current reader distinguishable. REZICS already has one immediate head, separately authorized visibility publication and separate platform purge; do not add WordPress draft/status machinery or a force flag to Zone delete.               |
| [Webflow Collection pages](https://help.webflow.com/hc/en-us/articles/33961277976467-Structure-and-style-Collection-pages)                                                                    | One Collection page template renders individual items. The editor switches actual items for preview; list-item links target the current item's page.                                                                                                                                                                                           | Offer configured-route selection and eligible-subject navigation as two existing target kinds. Reuse the active common subject profile; a mounted Collection does not create a Zone-specific item template, item record or permission.                                              |
| [Webflow CMS publishing](https://developers.webflow.com/data/docs/working-with-the-cms/publishing)                                                                                            | Staged and live item state are separate. Marking a live item draft does not itself unpublish it; an explicit live-item deletion endpoint unpublishes while retaining the CMS item. Archiving takes effect on the next full-site publish.                                                                                                       | Show which existing command changes visibility. Do not imply a staged/live copy or delayed source withdrawal in REZICS: Configure is immediately durable and revocation must affect the next current read.                                                                          |

Notion's [trash documentation](https://www.notion.com/help/duplicate-delete-and-restore-content) distinguishes
default 30-day Trash from version history and subsequent retention. Its
[account deletion documentation](https://www.notion.com/help/delete-your-account) previews affected workspaces
and describes possible support recovery. The useful pattern is a clear impact/deadline explanation. REZICS
has its own exclusive 30-day individual restore boundary and final account confirmation at T; those vendor
retention/recovery promises must not become REZICS behavior. [Deletion](../deletion.md).

Across the sources, selection of content, presentation of repeated items, durable editing, publication and
reader navigation are connected in one product journey. None of these sources establishes REZICS's complete
canonical union, current original/terminal disclosure, privacy-repair observation or bounded progress. Those
remain obligations of the existing native owners, not consequences of choosing a familiar editor.

### Open-source implementation evidence and licences

The existing Gutenberg clone was read as untrusted data, without installation, execution or build:
`/home/edge/projects/rezics/rezics-next/.reference/storybook-features/gutenberg`, revision
`8b123377c98ce938b0a83078284c20648b66fce6`. The research topic is recorded in `.reference/INDEX.md`.

| Source path at that revision                                                                                                                                                                                 | Finding                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/block-library/src/query/block.json`](https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/packages/block-library/src/query/block.json)                            | Query attributes and inherited query context are separate from inner presentation blocks.                                                                                  |
| [`packages/block-library/src/query/edit/query-content.jsx`](https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/packages/block-library/src/query/edit/query-content.jsx)    | Editor controls update query attributes; inherited/custom query mode is an explicit distinction.                                                                           |
| [`packages/block-library/src/post-template/index.php`](https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/packages/block-library/src/post-template/index.php)              | Server rendering obtains the inherited or constructed query and supplies each item's identity to the repeated inner template. This is not a REZICS query-safety algorithm. |
| [`packages/core-data/src/actions.ts`](https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/packages/core-data/src/actions.ts) (`saveEditedEntityRecord`, `saveEntityRecord`) | Non-transient entity edits are gathered for an explicit persistence operation; autosave and ordinary save have distinct paths.                                             |

Gutenberg's [LICENSE.md](https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/LICENSE.md)
licenses the project GPL-2.0-or-later; contributions on/after 2021-04-15 are dual GPL-2.0-or-later/MPL-2.0.
This is not a claim that the whole project is MPL. Notion and Webflow are proprietary services; their help/API
pages are cited as documentation, with no implementation licence assumed. WordPress handbook pages are
documentation; the inspected implementation's licence is identified separately above. No files or extended
passages are proposed for copying. Implement the patterns in REZICS's TypeScript, Elysia, PostgreSQL and
common composition stack.

## One journey from the owner workspace to the current reader

The following is one UI ↔ API ↔ authority/storage map. UI names describe recommended entries and actions,
not newly adopted browser paths. “Mounted” means present in the inspected route declarations, not a claim
that this research ran native acceptance. The exact declarations are in
[`zones/http.ts`](../../services/kernel/src/zones/http.ts), mounted by
[`http/kernel.ts`](../../services/kernel/src/http/kernel.ts); resource commands/reads and storage are linked below.

| Stage and UI behavior                                                                                                         | Exact existing API or explicit gap                                                                                                                                                                                                                                                                                                 | Authority and stored meaning                                                                                                                                                                                                                                             | Current seam / owner                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Open My Zones; switch between active sites and restorable trash.                                                              | Mounted `GET /v1/zones?limit=&cursor=&deleted=` → `{zones,next}`. Default `deleted=false`; `true` selects restorable deleted records.                                                                                                                                                                                              | Authenticated owner's index plus current per-resource read; this is not public discovery or an index of delegated editing grants. Limit 1–100, default 20.                                                                                                               | **GAP: owner workspace UI.** Web consumes Semantic's existing index; no new discovery service.                                                                                                                                 |
| Choose a starter, name the site in the required locales, and create a private site before preview if appropriate.             | Mounted `POST /v1/zones` with `{configuration,mounts,visibility}` → 201 `{zone}`, `Location: /v1/zones/{id}`.                                                                                                                                                                                                                      | Real authenticated `zone:create` on Global Context. One native command initializes the ordinary `semantic.zone.owner` role and primary-owner attribution. Eight localized `packages/definitions/presentation/*/zone.json` files are inert inputs, not pre-created sites. | **GAP: creation UI.** Do not auto-enable create grants, auto-instantiate starters or rewrite existing sites on definition release.                                                                                             |
| Open the route/page list and edit a selected document, labels and appearance.                                                 | Mounted `GET /v1/zones/{id}/configuration` → `{zone,configuration,mounts}`; edit locally through the common composition editor.                                                                                                                                                                                                    | Current `zone:configure` or current owner-role `zone:read`; confidential configuration is separate from public metadata. No private mount details through a reader API.                                                                                                  | **GAP: Zone-specific editor integration.** The existing common editor is reusable, but its callback is not a persisted Zone journey.                                                                                           |
| Select catalogue scopes and mount common Collections; return to the ordinary Collection editor when membership needs editing. | Existing definitions `GET /v1/definitions/active` and `/v1/definitions/releases/{digest}` supply released saved-filter definitions. Existing Collection `GET /v1/collections`, `GET /v1/collections/{collectionId}` and its owning member routes supply permitted choices/content. Selection persists only through Zone Configure. | Store saved scope IDs, release digest and distinct Collection IDs, not predicates invented by the editor, source facts or copied members. Existing exposure and current Collection read apply to each picker; selection grants no source right.                          | **GAP: picker-to-editor journey; existing native source ports below.** Definitions/Semantic, Commerce, Search and Web retain their respective ownership. User-saved query authoring remains deferred.                          |
| Save the whole edited configuration, resolve a conflict and show the saved revision.                                          | Mounted `PUT /v1/zones/{id}/configuration` with `{configuration,mounts}` → `{zone}`, quoted `If-Match` and quoted `Idempotency-Key`. Re-read configuration after 412 before deciding how to reapply edits.                                                                                                                         | `zone:configure`; full replacement, immutable release meaning, current mount admission and one native CAS command. No silent last-writer overwrite. Save changes the visible head immediately.                                                                           | Backend exists. **GAP: save/conflict/error UI.** Web must distinguish its dirty local buffer from that durable head.                                                                                                           |
| Preview a saved route; open its actual reader link.                                                                           | Mounted `POST /v1/zones/{id}:readPage` with `{target:{route:""},languages?}` for home, or the chosen canonical route.                                                                                                                                                                                                              | Actual viewer's `zone:read`; no owner/configure credential substitution. Static path reads the current head, safe shell and native session observation, releases that connection, then uses the active common profile and executor.                                      | Static reader exists. **GAP: owner preview integration.** An unsaved canvas is a local layout preview, not proof of persisted/current reader behavior. No server draft-preview endpoint exists.                                |
| Publish, copy the link, or withdraw direct public access.                                                                     | Mounted `POST /v1/zones/{id}:publish` with `{visibility:'private'                                                                                                                                                                                                                                                                  | 'unlisted'                                                                                                                                                                                                                                                               | 'public'}`→`{zone}`, using the same CAS/idempotency protocol.                                                                                                                                                                  | Separate `zone:publish`; visibility changes the same head. Public/unlisted permit eligible anonymous direct reads; only public is discovery-eligible. Making a Zone visible never publishes its sources. | Backend exists. **GAP: publication UI explaining immediate saves and unlisted readability.** No staged/live page copy or new visibility axis. |
| Anonymous/current viewer follows a configured page and then an eligible subject.                                              | Same mounted `:readPage` with route target or `{target:{subject,view?},languages?}`; existing subject/list requirements apply. Specified `GET /v1/zones/{id}/subjects?limit=&cursor=` → `{subjects,next}` and `/collections?limit=&cursor=` → `{collections,next}` are **not mounted** in the inspected `zones/http.ts`.           | Current Zone plus source, original and terminal authority; common safe summaries, no union total. Public shell never becomes an owner-data response.                                                                                                                     | Static route pages are wired. **GAP: source-dependent whole journey and subject Web wiring**, within the already registered runtime's ownership. Source-dependent requests currently gate then fail closed as described below. |
| Revoke a source grant, make a source private, withhold a fact, or remove a mount.                                             | Grant/source changes use their existing owners; removal of a descriptor uses Zone Configure. Repeat the same `:readPage`/list/target read with current credentials.                                                                                                                                                                | Revoke source use immediately without rewriting stored configuration. No stale membership, NOT/order effect, source metadata or continuation authority may survive. A lost source does not become a copied public dataset.                                               | **GAP: complete current source/identity/privacy integration.** Access/Commerce/Semantic/Search implement their native portions; Web must show actual unavailable/preparing/404 states.                                         |
| Delete a site, view its retained configuration in trash, or restore before the displayed deadline.                            | Mounted `DELETE /v1/zones/{id}` → `{zone}` and `POST /v1/zones/{id}:restore` with `{}` → `{zone}`, both CAS/idempotent. Owned deleted listing/configuration support maintenance within the window.                                                                                                                                 | Delete records T and T+30 days, conceals reader/metadata immediately, retains prior visibility. Restore requires the current owner role plus `zone:restore`, strictly before the deadline; it does not release withholding or delete/restore sources.                    | Resource commands exist. **GAP: connected trash UI and complete automatic cleanup**, not a new delete mode.                                                                                                                    |
| Confirm account erasure; inspect cleanup completion/retention through the existing account lifecycle.                         | Existing `com.rezics.access.account-tombstoned.v1` barrier and registered erasure/work participants; **no Zone/account restore endpoint** is added.                                                                                                                                                                                | Terminal T fences writes and private/unlisted disclosure immediately, including individually deleted private payload still within its 30-day window. Native custodians minimize actual copies; holds/protected evidence remain restricted.                               | **GAP: complete Zone lifecycle and shared-copy custody**, with partial existing Semantic erasure code. Accounts, Semantic, Core and physical-store owners retain responsibility.                                               |

The resource writer is [`resource-commands.ts`](../../services/kernel/src/zones/resource-commands.ts), the reader
is [`resource-reads.ts`](../../services/kernel/src/zones/resource-reads.ts), and the exact-key store port is
[`resource-store.ts`](../../services/kernel/src/zones/resource-store.ts). The current
[`zones.zone` schema](../../services/kernel/db/zones/schema.sql) holds `(route,zone_id)`, resource/lifecycle
revisions, state, owner attribution, visibility, `configuration`, mount IDs, release digest, `public_ever`,
write fence, withholding, hold, delete/restore times, transaction observations and erasure key. The existing
owner index supports My Zones. These are the site head and lifecycle facts; there is no second page table,
source-membership truth or cross-home transaction to add. Source evidence is obtained and its connection
released before the Zone command, with revision checks; a store port does not open another transaction.

## Editor, payload and route boundaries

The saved input uses the existing closed shapes, not an executable site configuration:

```ts
ZoneStarter = {
  labels: { en, 'zh-Hant', 'zh-Hans', ja, ko, de, fr, es },
  pages: { route: string, document: CompositionDocument }[],
  scope: string[] // released saved-filter IDs
}
CreateZone = { configuration: ZoneStarter, mounts: UUID[], visibility: Visibility }
ConfigureZone = { configuration: ZoneStarter, mounts: UUID[] }
PageRequest = {
  target: { route: string } | { subject: UUID, view?: View },
  languages?: string[]
}
```

This is a shape sketch; the labels are required safe string values, not identifiers to evaluate. Validation
remains `validateZoneStarter(platformRegistry, configuration, {filters})` plus resource admission in
[`zones/contract.ts`](../../services/kernel/src/zones/contract.ts) and
[`composition/zone.ts`](../../packages/composition/src/zone.ts). Pages have sorted unique routes with a home;
input requires all eight label keys with safe nonempty plain text of at most 80 code points each, while
public labels may be a partial map, including empty after withholding. Selecting a display language neither
drops input locales nor translates configured copy.

[`packages/composition/README.md`](../../packages/composition/README.md) owns the closed Puck document:
`root.props`, `content`, registered node types/props, unique IDs and code-owned child slots. Reuse
[`features/pages/editor.tsx`](../../apps/web/src/features/pages/editor.tsx) and its registry-derived editor config.
Its data components currently use placeholders; its `onPublish` conversion/validation callback does not
save or publish a Zone. Wire it to the resource operations instead of treating that callback's name as a
second publishing protocol. Persist no arbitrary functions, Puck zones, SQL, CSS, HTML, scripts, iframe,
font URL or new data-query DSL. Appearance remains the existing density/radius/surface/cover/headingScale
tokens, with safe home tokens overlaid by the selected document's tokens. Ordinary safe LinkGrid links
use the common href validator. [Zones: configuration and appearance](../zones.md).

| Reader browser path, with existing locale prefix | Native target and meaning                                                                                         | Inspected Web status                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/zones/{id}`                                    | `{route:""}`; configured home                                                                                     | [`routes/zones/$id.tsx`](../../apps/web/src/routes/zones/$id.tsx) uses the Zone reader and common renderer.                                                                                                                                                                              |
| `/zones/{id}/{relativeRoute}`                    | `{route:relativeRoute}`; exact configured document, not a subject template lookup                                 | [`$id_.$.tsx`](../../apps/web/src/routes/zones/$id_.$.tsx) uses the same reader. Missing route is 404, never generic fallback.                                                                                                                                                           |
| `/zones/{id}/subjects/{subjectId}/{view?}`       | `{subject:subjectId,view?}`; prove eligibility, then active common type/base/generic template; default `overview` | [`$id_.subjects.$subjectId.tsx`](../../apps/web/src/routes/zones/$id_.subjects.$subjectId.tsx) and [`$id_.subjects.$subjectId_.$view.tsx`](../../apps/web/src/routes/zones/$id_.subjects.$subjectId_.$view.tsx) currently return `notFound`; this is an explicit missing reader journey. |

Decode routes once. Keep the admitted canonical lower-case relative route grammar, case sensitivity, no
leading/trailing slash, empty/dot segments, encoded slash/backslash, query/fragment or URL. Reserve the
whole first segment `subjects` before document lookup. A subject target is not a configured route, a
related link is not membership evidence, and an invalid view is 400 while an undefined valid view is 404.
Global subject URLs remain canonical; normal related-subject links can leave the Zone. There is no custom
domain, slug-to-new-resource scheme or per-Zone subject profile editor to implement in this scope.

The common response stays flat:

```ts
ZonePage = {
  profile: string,
  template: { scope: 'route'|'type'|'base'|'generic', key: string|null },
  document: CompositionDocument,
  reads: Record<string, { status: number, body: unknown }>,
  subject?: UUID,
  views?: View[],
  zone: { id, revision, labels, visibility, appearance, navigation: {route}[] }
}
```

The active common profile supplies `profile`, not the definition-release digest. Configured routes use
`{scope:'route',key:relativeRoute}`. There is no nested `page`, owner ID, mount list, scope ID, private
source title/count, deletion evidence or configuration in the shell. Authenticated owners get the same
public metadata shape as everyone else; owner fields belong to owned/configuration/mutation envelopes.
The shared [`page-contract.ts`](../../services/kernel/src/presentation/http/page-contract.ts) also has optional
`account` for common account pages. The current Zone schema extends that shared schema, although the Zone
owning document excludes `account` from Zone output; the current static constructor emits none. Record
that schema-narrowing seam with Semantic's existing header owner, not an account target or a new ABI here.
The existing `POST /v1/pages:read` remains the common page endpoint, not a fallback that can bypass Zone
eligibility. [Common presentation pages](../../services/kernel/src/presentation/http/pages.ts).

## Current viewer, source and query authority

An owner role grants the declared Zone actions; `owner_id` is attribution/index/cleanup metadata, not an
Access shortcut. A delegate with configure alone cannot publish, restore, read private source facts or
receive somebody else's private library. Current ordinary grants control every reader and command,
including a replay. Configuration reads may be confidential maintenance reads; public page facts never
borrow the editor's private facts. Native suspension revokes existing bearers: such a request returns
401 `invalid_credentials` with the existing invalid-token challenge, without anonymous fallback. A valid
suspended-bearer 403 is defensive, not a mintable native persona. This follows the newer shared
[filtered-list authentication decision](../filtered-lists.md), rather than older suspended-bearer wording in
Zones/membership. Invalid credentials do not become anonymous because a URL is public.

[`zones/page-runtime.ts`](../../services/kernel/src/zones/page-runtime.ts) currently completes zero-read configured
documents through `readStaticZonePage`: native Zone authority/head/document/shell/session observation share
one `REPEATABLE READ` snapshot, released before active-profile lookup. It does not fetch owner configuration
over HTTP and does not run source subrequests. Subject targets or documents with planned reads first prove
Zone readability, then call native `admitGroup` for `zone_sources` using the original Actor, mounted client
action, absolute deadline and configured clock. Anonymous/ungranted callers get 403 `platform_closed`;
explicitly granted development callers currently get 503 `semantic_not_ready` and `Retry-After: 1`.
Ownership is no platform grant, and platform admission is no source permission. This existing closed
adapter is the repository seam for the registered whole runtime, not an instruction to build another one.

| Existing owner port / contract                                                                                                                                                                                                 | Actual inspected capability                                                                                                                                                                                                 | Missing existing-scope responsibility                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search [`scope-release.ts`](../../services/kernel/src/search/scope-release.ts), [`scope-source.ts`](../../services/kernel/src/search/scope-source.ts), [`service-scope.ts`](../../services/kernel/src/search/service-scope.ts) | Immutable release loading and shared grammar admission/compiler exist. The Scope factory deliberately cannot prepare a native ready handle or execute canonical prefix/evaluation; the service adapter reports unavailable. | Search supplies actual same-service bounded catalogue restriction, complete indexed observation, freshness and current query repair, consuming Semantic's native projections. A registry/type/factory is not a successful scoped page.                        |
| Commerce [`collection-source.ts`](../../services/kernel/src/library/collection-source.ts)                                                                                                                                      | `prepare`, `prefix`, `containsSubject`, `readRawStoredPrefix` are typed ports whose current factory throws `dependency_unavailable`.                                                                                        | Commerce supplies canonical positive/complete-negative evidence, current source admission and curated/built-in/activated/frozen plans under [Collection Source](../collection-source.md). Do not turn raw rows or a stored-ID miss into canonical membership. |
| Commerce [`collection-source-native.ts`](../../services/kernel/src/library/collection-source-native.ts)                                                                                                                        | Real `readNativeCollectionMetadata`, `authorizeNativeCollectionMetadata`, `readNativeCollectionRawPage` and `probeNativeCollectionOriginal` provide lower-level native pieces; unavailable dynamic output is distinguished. | Integrate those pieces with complete current canonical Source behavior. Their presence does not mean every Collection source or union is delivered.                                                                                                           |
| Semantic [complete facet producer contract](../../services/kernel/src/semantic/public-filter-source-contract.md) and [identity owner contract](../../services/kernel/src/semantic/identity-epoch-contract.md)                  | These own producer observations, dependency safety and canonical maintenance; neither is a permission certificate.                                                                                                          | Complete released filter meaning, same-statement qualifier/unit evidence, all expanded source dependencies, one-hop mapping and scoped concurrent identity readiness. Preserve their latest accepted decisions.                                               |
| Common [`presentation/reads.ts`](../../services/kernel/src/presentation/reads.ts) and [`composition/reads.ts`](../../packages/composition/src/reads.ts)                                                                        | Shared planner, descriptor deduplication, code-owned dispatch, status/body preservation and session merge exist.                                                                                                            | The Zone runtime must bind the actual source restriction to those reads and revalidate before complete disclosure. A common global TypeList result is not a Zone result. No second dispatch engine.                                                           |

Membership is the distinct canonical union of selected released scopes and currently readable mounted
Collection members, checked under the actual viewer. Occurrences such as `[x,y,x]`, notes and their order
remain intact in the common Collection editor while browsing yields one canonical subject. A private
built-in reads its owner's native facts/pins; a public/unlisted dynamic Collection exposes only its last
completely published output, never predicates or owner facts. Eligible terminal-account frozen public
output stays under the same Collection identity; incomplete output, private/unlisted data and published
reading logs do not gain survival. No fabricated zero member count for dynamic shapes.
[Collection Source](../collection-source.md), [dynamic Collections](../dynamic-collections.md),
[Library and Collections](../library-and-collections.md).

Current Source Access, original **and** terminal subject eligibility, consent, foreign targets and tuple
fences apply to membership, fields, metadata, exclusion, order and cursors. A readable terminal cannot
launder a withheld original. Maintain last-eligible-original support without an alias walk or arbitrary
representative. An essential unknown TypeList conjunct cannot be answered by another true union source;
unknown remains unknown under NOT. Partial shards, timeouts and unavailable dependencies do not prove
exhaustion. Canonical membership uses native canonical UUID order; ordered lists use actual native
name/public Collection-count order, canonical ties and native null behavior. Sorting a truncated UUID
page does not supply an ordered union. [Zone membership](../zone-membership.md).

Use the newer [filtered-list identity decisions](../filtered-lists.md): disjoint identity groups run
concurrently under fixed local capacity, affected pending/overlap state is scoped, and each resulting group
admits at most 4,096 originals before effects. Published redirects are one hop to active terminals. Complete
Source dependencies include excluded/NOT/order-only inputs, populations, release pins and the actual physical
query. Scoped committed revisions catch clean-to-clean races; no global active marker, global maximum epoch,
universal page gate, cursor vector, alias enumeration or 4,096-home readiness sweep is authorized. Older
global-epoch wording in Zones/membership is not a reason to reopen the accepted shared identity decision.

Query privacy requires more than checking returned IDs. Semantic's same-transaction reduction log and
Search's contiguous ACK must cover refresh-visible local and dependent foreign repair. A relevant reduction
during a query invalidates its retained start/PIT/prepared observation even when repaired and ACKed before
the final observation. “Clean now,” a relay checkpoint or local security revision is insufficient. Coverage
includes excluded subjects and foreign dependencies across all logical homes via the indexed behind/changed
path, not an all-head scan hidden in an aggregate or hash. Unsafe/missing/pending/changed evidence means
preparation/readiness, with no unsafe NOT/order/count output. Ordinary edits are filterable within 60 seconds
when healthy; actual source-to-searchable lag above five minutes gives readiness. Privacy reductions are
immediate; an owner sees their write on their next read. Private changes leaving public output unchanged
must not change its public fields/cursor basis. [Filtered lists](../filtered-lists.md).

## Completion, retained progress and budgets

The current transport already expresses the needed states; the editor and reader should present those
states without adding a preview endpoint or treating progress as a result:

| Outcome                              | Existing contract and UI consequence                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete                             | `200` is the whole common page plus safe Zone shell. Static zero-read pages need no preparation and emit no 202. Lists fill requested P or prove genuine final exhaustion.                            |
| Retained progress                    | `POST /v1/zones/{id}:readPage?cursor=opaque` → `202 {next}` with `private, no-store`. Retain actual settled preparation, not per-leaf verdicts or a client result vector.                             |
| Dependency unavailable / no progress | `503` Problem plus `Retry-After`, without a replacement cursor or partial document. Do not render No Results for this.                                                                                |
| Current denial                       | Concealed identical 404 for unknown/private-unreadable/deleted/wholly withheld/ineligible targets; explicit native platform denial remains 403. Current credentials and action authority still apply. |

[`zones/zone-read.ts`](../../apps/web/src/zones/zone-read.ts) already follows at most four 202 continuation steps,
then retains continuation in a preparing result; its public input validation currently accepts route targets.
Subject-route wiring must use the real subject target rather than falling back to a global page. Valid-shaped
but unusable POST progress starts fresh under current authority; malformed shapes remain 400 and actual denial
retains its error. Preserve the existing Search cursor profile for every POST viewer: 15-minute lifetime,
60-second future allowance, confidential mutable position, stable operation/Zone/viewer/request binding,
exact native tuple types, at most eight position keys and 4,864 token bytes. GET retains the default profile
(4,096 token bytes, existing anonymous timeless/account timed behavior). No new crypto, nested owner token
vector or raw source cursor is needed. [Continuation schema](../../services/kernel/src/zones/page-continuation.ts),
[cursor profiles](../../services/kernel/src/tokens/list-cursor.ts), [Zone membership](../zone-membership.md).

All successful Zone reads remain `Cache-Control: private, no-store`; ETag is a write precondition, not cached
permission. Preserve original credentials, languages, native session propagation and the absolute request
deadline across dispatch/refill/preparation; do not renew it for another owner call. Quote strong decimal
revision ETags and `If-Match`; missing/malformed or `*` is 400, stale is 412. Receipted command replay returns
its original status/body/ETag only after current actor/action admission; conflicting idempotency payload is 422. CAS, grants, receipt and outbox commit together in the existing command partition. [Zones](../zones.md).

These are existing ceilings, not new Source discriminants or an executable counter ABI. The latest
[filtered-list budgets](../filtered-lists.md#budgets) supersede universal raw-256/final-replay prescriptions;
unrelated native raw batch, string, byte and cursor limits remain independently binding.

| Boundary                                            | Existing bound to preserve                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration/composition                           | At most 16 pages, 16 saved scopes, 16 distinct mounts; each document ≤65,536 RFC 8785 canonical UTF-8 bytes, 256 nodes, depth 8. Common active profile ≤1 MiB / 128 templates. At most 16 distinct reads and 128 total output slots.                                                                                         |
| Direct read, s output slots / c examined candidates | `1≤s≤100`, at most 32 admitted filter leaves; `c ≤ min(600,6s+3)`. At most three refills of `2 × remaining slots + 1`, six engine searches or three owner keyset seeks. Count rejects, duplicates, discarded work, lookahead and rereads. Each plan also needs a bound on actual engine work; LIMIT/timeout is insufficient. |
| Native work per read                                | Points `≤16+8c`; examined/removed PostgreSQL rows `≤64+16c`; shared blocks ≤6 per budgeted row; response bytes `≤16 KiB+4 KiB×c`, request bytes `≤64 KiB+1 KiB×c`. One-read page ≤12 statements/backend; one connection/backend shared by the whole page.                                                                    |
| Ready result                                        | `c ≤2s+2`, at most two index reads; same actual-c native ceilings. Beyond that, prepare/repair rather than return a short success.                                                                                                                                                                                           |
| Whole common page                                   | `R≤16`, `Σs≤128`, statements `≤8+4R` per backend. At maxima: 816 candidates, 6,784 points, 14,080 PostgreSQL rows, 72 statements, 96 engine searches and one connection/backend. Sixteen independently maximal reads do not establish aggregate admission.                                                                   |
| Query privacy observation                           | Once/page, two statements and `64+2×(behind homes+changed homes)` examined rows. Logical coverage of 4,096 homes does not authorize reading every head. Existing identity mapping shares batched observations/two probes within unchanged page limits.                                                                       |
| Retained preparation step                           | ≤1,000 input keys, 1,000 result writes, one frontier write, eight points/input, `64+16×input` PostgreSQL rows, 16 statements/backend, four engine searches, one connection/backend and 4 MiB response. Replay rereads at most one step.                                                                                      |
| Retained result lifecycle                           | At most 32 live prepared owner results/owner with existing LRU; 24-hour idle expiry; one current and one building public generation/read definition. Changes locate affected results through indexes, not a definition/result scan.                                                                                          |

Admit expanded filter + source + order together. A direct plan needs its page-derived bound; otherwise use
finite retained preparation on existing stores/work/quota or return 422 `unsupported_query` before
enumeration. Sparse finite ready input must eventually produce useful complete pages under fair successful
maintenance, including replay; permanent 202 or repeated final-leaf replay is not completion. Raw-100 identity
job steps and raw-256 legacy scaffolds do not become public allowances. No new worker, readiness monitor,
identity sweep or account-wide query scan follows from a preparing UI.

## Lifecycle completion means custody of actual copies

| Event                                           | Required reader/editor and storage result                                                                                                                                                                                                                                                                             | Existing seam / ownership                                                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source revocation/deletion                      | Keep the Zone's descriptor unless the owner removes it, but disclose no unreadable source summary or membership contribution; current target/read/cursor checks apply immediately. Zone deletion never deletes its Collections or subjects.                                                                           | Commerce/Access/source owners supply current native evidence; Semantic's Zone reader composes it without borrowed rights.                                                       |
| Individual Zone delete at T                     | Hide page/metadata/discovery immediately; retain configuration/prior visibility until `restore_until=T+30 days`. Owner trash/configuration can expose the retained tombstone within the window.                                                                                                                       | Mounted delete/restore and lifecycle columns exist. Deadline equality is 409 `conflict`; purged/unknown is 404. A hold never extends the restore window.                        |
| Restore                                         | Current owner role plus current action, CAS and T strictly before deadline; keep current withholding and original visibility. It cannot resurrect a deleted source or end account erasure.                                                                                                                            | Existing resource command; owner trash/restore UI missing. Owner-role/primary-owner transfer synchronization has no supplied probe; do not invent a transfer workflow.          |
| Least-field takedown and release                | Retain originals separately from RFC 6901 withholding decisions; empty covered text, omit covered labels, omit withheld pages from navigation/return 404. Whole resource only when no smaller field serves.                                                                                                           | `:takedown` / `:releaseTakedown` are specified under current moderation authority but not mounted in inspected Zone routes. Semantic + Content own this existing lifecycle gap. |
| Expired individual payload / terminal account T | Durable bounded minimization removes eligible configuration/labels/mounts/owner links/grants, historical payload and payload-bearing receipts. Public/unlisted-ever deleted sites retain only nonpersonal tombstones; always-private skeletons are personal and require whole-row erasure absent protected retention. | Zone-specific purge/retention remains incomplete. The existing erasure barrier ends owner restore authority immediately; there is no new account grace or restore API.          |
| Holds and early/legal purge                     | Hold blocks destructive effects but not deadlines; covered originals remain restricted evidence. Early purge uses separate Platform authority; covered/active legal-order purge needs explicit order intent and still respects a hold.                                                                                | Specified `POST /v1/platform/zones/{id}:purge`, `:hold`, `:releaseHold` are not mounted. Default owner delete has no force/purge option.                                        |

The existing specified `purgeZonePage({pool,clock,route,zoneId,cursor,limit}):{next}` belongs in the existing
work/retention infrastructure, not a new scheduler. Its batch examines at most `limit` raw keys plus a
lookahead, limit 1–100, charging held/ineligible keys before filtering and retaining retries/checkpoints.
Recheck hold/lifecycle CAS immediately before effect; preserve protected originals and late erasure work.
The existing [`work/modules.ts`](../../services/kernel/src/work/modules.ts) is the registration surface.
[Zones: durable cleanup](../zones.md#deletion-restoration-withholding-and-durable-cleanup).

There is already a Zone branch in
[`semantic/account-erasure.ts`](../../services/kernel/src/semantic/account-erasure.ts), plus Semantic locator
effects in the existing work system. It retains configuration/mounts only for active rows currently public
with `public_ever`, nulls matching owner attribution, otherwise marks rows purged, clears withholding and fences writes.
That is partial implementation, not absence of all account integration or proof of full retention. In
particular, [`resource-reads.ts`](../../services/kernel/src/zones/resource-reads.ts) requires an active owner;
retaining a public row while nulling that owner does not itself establish a readable de-identified site.
Clearing withholding also does not demonstrate preservation of protected originals/holds. Always-private
rows are updated rather than removed, so this branch alone does not implement required whole-row erasure.
Semantic and the existing lifecycle owners must reconcile these seams against Zones/Deletion; this report adopts no new
ownerless-read policy and makes no claim that a whole cleanup journey passed.

[Deletion](../deletion.md) requires true shared custody: register the exact physical-copy locator atomically
with producing the copy, or keep a foreign effect behind its participant fence. Account roles include
owner/author/member/actor references, not merely `owner_id`. The physical custodian minimizes its actual
payload; a locator, outbox enqueue, interface export or another participant's acknowledgement is not proof
that a DBOS/receipt/media/search/import copy was created, sealed or erased. Late copies reopen erasure
items until minimization commits. Accounts owns the shared command-receipt/outbox-event/durable-work
participants; Semantic owns Zone payloads, and each other physical store owns its copies. Completion,
restricted-retention exceptions and backup expiry are distinct states. Unknown custody remains incomplete.
Do not replace this with a central ownership graph, JSON sweep or a new Zone cleanup service. The bounded
partition traversal permitted for terminal erasure is not permission for query readiness scans.

## Recommended delivery order and decisions for the manager

Prioritize whole missing journeys already named by the contracts, rather than another header/source/helper
task. These priorities describe adoption and integration ownership, not new worker assignments:

1. **Complete the static owner-to-reader loop.** Web connects My Zones, inert starter creation, configured-route
   editing, CAS/conflict handling, saved private preview and explicit visibility publication to mounted APIs.
   Reuse common composition and the existing static reader. No new product decision is needed; owner/editor
   browser locations are a Web routing choice to record in its owning document. The immediate-save explanation
   is essential for sites already public or unlisted.
2. **Complete the registered source-to-current-reader loop.** Semantic's runtime composes Search's actual
   admitted scopes, Commerce's actual common Collection sources and Semantic's current canonical/privacy
   producer evidence, then Web opens the existing subject paths and source-dependent pages. Keep exposure
   closed until that whole outcome is available. Source lists/defaults, complete ordered union, current direct
   targets and retained progress belong to this same existing scope, not rival engines or new readiness APIs.
3. **Complete withdrawal-to-cleanup.** Semantic, Accounts, Content, Core and custodians finish least-field
   withholding, protected retention, automatic bounded purge, terminal fencing and actual shared copies;
   Web connects existing delete/trash/restore. A mounted delete or a Zone erasure branch is not this outcome.

The existing shared acceptance matrix still owns meaningful later proof: released harem light novels and
genuine Book wordCount >1,000,000 (excluding equality/absence), combined queries with/without own state
across Collection kinds/visibility/mounts, two-release pins, qualifier/unit conformance, original/terminal
revocation, concurrent scoped identity jobs, paused-indexer local/foreign NOT/order/count repair, sparse
finite preparation, complete canonical/ordered cross-page results, native personas/session/cursor and
growth/default behavior. This research neither reruns another Goal's landing nor substitutes type/stub
availability for any of those outcomes. [Shared acceptance matrix](../filtered-lists.md#shared-acceptance-matrix).

Ambiguities resolved from current authority: Configure saves the one head immediately; Publish changes
visibility only; preview of saved data uses the real reader; an unlisted link remains anonymous-readable;
the newest shared filtered-list identity/authentication decisions supersede older Zone wording; common
Collection truth and physical-copy custody stay with their existing owners. No executable Source ABI is
selected by responsibility terms such as direct/prepared public/owner.

**Root decisions, not adopted ABIs:** any future server-side unsaved-draft preview, separate staged publication,
per-Zone subject-template editing, ownership transfer/synchronization, or policy enabling an ownerless retained
public Zone needs an explicit Root decision and the relevant owning contracts. None is necessary to invent
for the static journey here. The current schema's inherited optional `account` and partial erasure/withholding
behavior are existing owner reconciliation seams; do not silently turn them into new account targets or
retention policy. Custom domains, arbitrary code, new query authoring, global readiness scans and additional
workers are outside this recommendation.

This report is the only repository deliverable. Sources were read, including the retained reference clone;
no product/code/frozen-test changes, browser/native experiments, installs, database/remote work or checks were
performed. The declared local acceptance remains later integration proof. Prose alone changes no code workspace
and requires no typecheck. Adoption belongs in the owning documents after the manager accepts the findings;
this evidence page is not a second authority for them.
