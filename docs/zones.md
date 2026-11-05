# Zones

Decision: This owner edit adopts the Zone cleanup and default-profile Subject GET contracts, consolidates the linked Identity/importer and synopsis Sources owners, and records design only; required native delivery remains pending.

A Zone is an owner-controlled routed site over saved catalogue scopes and mounted Collections. It uses the
one catalogue, the one Collection model and the common composition renderer. It is neither a Realm nor a
Space, grants no rights in its sources, and creates no vertical-specific backend. This document owns the
first public Zone resource, lifecycle and page-read contract under [scope](scope.md) and [deletion](deletion.md).
The eight `packages/definitions/presentation/*/zone.json` starters are inert input data. They instantiate
nothing until a person submits a create command; subsequent definition releases never rewrite a Zone.

[Filtered lists](filtered-lists.md) owns complete indexed observations, current disclosure, direct/prepared plans,
freshness, canonical identity and cost. [Zone membership](zone-membership.md) owns source composition obligations.
The resource substrate, independent static configured-page reader, native-owner page composition and mounted
Collection summary list are implemented. Actual ordered owner execution and native page/default proof, plus
Zone-specific withholding, purge, account cleanup and scheduler work remain incomplete. Typed schemas, immutable
loaders, cursor capacity and helper setup do not establish those capabilities; the
[integration audit](research/semantic-integration-audit-zone-composition.md) remains evidence, not a completion gate.

## Public exposure boundary

The public slice is configured static routed documents with no planned source reads, through current
`zone:read` authority. The mounted `zone.read_page` operation remains public for this slice. Saved-scope
and mounted-Collection unions, direct catalogue targets, the separate Subject-source list and retained preparation
execute only behind explicit `zone_sources` platform grants and actual native owner readiness. A source-dependent request first proves current Zone
readability, preserving identical unknown/private concealment and the safe public shell, then calls native
`admitGroup` with the real Actor, mounted client action, original deadline and configured clock. Anonymous
and ungranted accounts receive the standard `403 platform_closed` Problem. Zone ownership supplies no gate.

An explicit `gate:zone_sources` (or covering platform grant) admits development exposure only. It supplies
no membership or source permission and reveals no private mount metadata. Unready source/runtime owner
ports answer the truthful typed `503 semantic_not_ready`, with `Retry-After: 1`, after admission.
That response is not supported dynamic behavior; the full native dynamic journey remains required before
opening. Existing native grant administration handles the exact gate action; this internal branch is not a
separate mounted operation in visibleOperations or OpenAPI. Static routes keep the ordinary platform
filtering and original schemas. No public request switch or Source option selects a privilege.

### Source-dependent page admission cost

- Touches: the current Zone-read authority and exact Zone head/partition keys, bounded configured route/document
  selection, then the native `zone_sources` exposure point and exact Global gate checks. No source is read.
- Bound: one group admission with the original deadline and clock after Zone authority; constant keyed rows
  and statements under the existing Access cap, logarithmic gate index probes, and no membership/source scan.
  Static document selection retains the existing configuration limits and performs no extra gate lookup.
- Growth check: reuses `test/access/gates/growth-admission.test.ts` for the keyed gate point. Native static 200,
  ungranted 403, granted fail-closed readiness, concealment and clock evidence are in
  `test/zones/public-slice-exposure.test.ts` and `test/zones/static-page-runtime.test.ts`; neither declarations
  nor those readiness outcomes claim dynamic source execution or CPU proof.

## Routes and native declarations

Browser paths are `/zones/{id}` (home), `/zones/{id}/{relativeRoute}` (configured page), and
`/zones/{id}/subjects/{subjectId}/{view?}` (eligible subject, common subject renderer). Web applies its
existing locale prefixes. An absent subject view means `overview`. Global subject URLs remain canonical;
ordinary related-subject links may leave the Zone. There are no custom domains or host claims in this scope.
Decision: Zone Subject visits keep their localized Zone URL and render only after the current native `readPage`
admits the exact subject and view; Global Subject paths remain canonical metadata destinations, and visible facts
continue to come from the admitted Zone page.
Configured routes are decoded once, relative, case-sensitive and canonical: no leading/trailing slash,
empty segment, dot segment, query, fragment, encoded slash, backslash or URL. The empty string means home.
Reserve the entire first segment `subjects`, including `subjects` itself, before page lookup. A configured
page cannot shadow it. Unknown configured pages return 404; they do not fall back to the generic template.

Owner browser paths use the same locale prefixes: `/my/zones` is the authenticated owner workspace,
`/my/zones/new` creates a private site from an explicitly selected inert starter, and
`/my/zones/{id}/edit` is the selected saved-configuration destination. My Zones uses one native owner-list
page at a time with `limit=20`, `deleted=false` for Active and `deleted=true` for Trash. It preserves opaque
`next` cursors without decoding, walking the whole index or deriving totals. Changing tabs starts at the
first page; invalid or stale continuations offer a first-page link. This list does not enumerate delegated
grants or act as public discovery. Open links to the independently authorized current `/zones/{id}` reader;
Configure links to the selected editor destination without borrowing reader or source authority.

Creation copies the selected `packages/definitions/presentation/*/zone.json` into an ordinary create
command, retaining its pages and saved scopes, empty mounts and private visibility. The owner authors a primary
name in a selected supported language; translations are optional and are never filled from starter labels. No label translation, source data or grants are synthesized. Later releases never instantiate
or rewrite the saved site. A confirmed create navigates to its returned ID's configuration destination;
an owner who deliberately leaves while creation is unresolved is not redirected back if that request later succeeds.
source-dependent starter pages remain subject to current source Access, feature admission and readiness.
The form does not promise that creating the resource makes those reads available.

The configuration editor connects route selection, the common composition editor, labels and appearance,
released saved-scope selection and currently readable common Collection mounts in one workspace. Local
unsaved edits are distinct from the saved configuration. Save submits the full configuration and mounts
through Configure with the current quoted revision and an idempotency key. A confirmed save advances the
editor's revision; a precondition failure preserves local edits while the editor loads the current head
for reconciliation. Uncertain delivery retries the original command rather than issuing a new write.

Preview opens the saved route through the ordinary Zone reader with the viewer's current credentials,
session and languages. It makes no promise to render unsaved input. The editor explains before saving
that changes to a public or unlisted Zone become visible immediately. Publish changes visibility only;
returning to private uses that same command. Editing a Zone or changing its visibility never publishes,
grants access to or changes a mounted Collection.

Configured-route preview and eligible-subject navigation use the existing two page target kinds. Subject
pages inherit the active common type/base/generic profile; there is no per-Zone subject-template editor.
Code-owned list descriptors inherit the Zone's source restriction, including their default filters and
ordering. The reader distinguishes a genuinely exhausted empty result from retained preparation and
unavailable dependencies; it never fills an unavailable Zone list with a global catalogue query.

Move to trash requires confirmation and calls the ordinary delete route; Restore calls the ordinary
restore route. Both carry the row's quoted revision and a command-specific idempotency key. Uncertain
delivery retains the original command for retry; a known conflict requires refreshing current state before
another attempt. Trash displays the backend's original `restoreUntil`, removes restore availability at
that deadline, and leaves expiry, write fences and current permissions to the backend. There is no owner
hard-delete action. All owner reads and commands use the existing session/CSRF handling and private,
no-store responses. Primary-owner metadata never supplies UI permission.

The implementation adds code-first TypeBox/Elysia request and response declarations in
`services/kernel/src/zones/http.ts`. These TypeScript shapes specify that ABI; emit OpenAPI from those
route declarations, never a handwritten schema. Every object below is closed; string aliases carry the
existing validators, not coercion. UUIDs are canonical lowercase routed IDs, revisions decimal strings,
instants RFC 3339 UTC with milliseconds. `View`, `CompositionDocument`, `ZoneConfiguration` and `APPEARANCE`
are imported from `@rezics/composition`. No alternative composition format is admitted.

```ts
import type { CompositionDocument, View, ZoneConfiguration, ZoneLanguage } from '@rezics/composition';
import { APPEARANCE } from '@rezics/composition';
type UUID = string;
type Revision = string;
type Instant = string;
type Visibility = 'private' | 'unlisted' | 'public';
type Appearance = { [K in keyof typeof APPEARANCE]?: (typeof APPEARANCE)[K][number] };
type PublicLabels = ZoneConfiguration['labels'];
type Navigation = { route: string }[];
type ZonePublic = {
  id: UUID;
  revision: Revision;
  labels: PublicLabels;
  primaryLanguage?: ZoneLanguage;
  visibility: Visibility;
  appearance: Appearance;
  navigation: Navigation;
};
type ZoneOwned = ZonePublic & { ownerId: UUID; deletedAt: Instant | null; restoreUntil: Instant | null };
type CreateZone = { configuration: ZoneConfiguration; mounts: UUID[]; visibility: Visibility };
type ConfigureZone = { configuration: ZoneConfiguration; mounts: UUID[] };
type ConfigurationResponse = { zone: ZoneOwned; configuration: ZoneConfiguration; mounts: UUID[] };
type ZoneResponse = { zone: ZoneOwned };
type ZoneMetadataResponse = { zone: ZonePublic };
type PageRequest = {
  target: { route: string } | { subject: UUID; view?: View };
  languages?: string[];
};
// Exactly the existing common page response, extended by the Zone shell; no nested second page format.
type CommonPage = {
  profile: string;
  template: { scope: 'route' | 'type' | 'base' | 'generic'; key: string | null };
  document: CompositionDocument;
  reads: Record<string, { status: number; body: unknown }>;
  subject?: UUID;
  views?: View[];
};
type ZonePageResponse = CommonPage & { zone: ZonePublic };
type ZoneList = { zones: ZoneOwned[]; next: string | null };
type PublishZone = { visibility: Visibility };
type Takedown = { notice: { complaint: string; received_at: Instant }; fields: string[] };
type ReleaseTakedown = { fields: string[] };
type Purge = { reason: string; order?: string };
```

`languages` uses the existing presentation page `validateHitOptions` language constraints and fallback order.
Saved configuration adds optional `primaryLanguage` to the existing versioned JSON representation; no
migration or bulk rewrite is needed. With an explicit supported primary language, the closed label map
requires that name and allows any of the other seven translations. Each present name is nonblank safe
plain text of at most 80 code points. Legacy configurations without primary metadata retain all eight
required names and remain readable and editable without an implicit rename. Once explicit primary metadata exists, a legacy full-configuration command
that omits the field retains that stored primary; only an explicit language selection changes it. Inert starters and generic
composition label rules keep their existing requirements.

Zone-only display uses the requested readable language, then the stored primary language, then the
explicit legacy order: `en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr`, `es`. The shared `pickZoneName`
helper consumes only disclosed labels; missing or withheld names are never recovered from private
configuration. When explicit primary metadata exists but neither the requested nor primary name is
readable, the display remains unnamed instead of selecting an unrelated translation. The owner editor explains the legacy order and stores an explicit primary when the owner
edits a name or chooses its language. Switching either interface or primary language preserves entered
names; selecting a missing primary presents a blank required field without adding an empty translation. Only nonprimary translations can be
removed. Optional translations are progressively disclosed and must be authored, never synthesized. The form
explains the primary-name fallback. Name validation identifies the affected input with localized correction
text associated through `aria-describedby`; invalid translations open their optional section.
Public output remains a closed partial label map, including the empty map after withholding, with optional
primary-language metadata subject to the same field withholding. A configured
route has no `view`; a subject has no `route`; account targets are not Zone targets. Bodies with extra keys,
invalid targets or reserved configured routes fail with 400 `invalid_request` and existing RFC 6901 field
errors. Shared validation violations map `limit` to `out_of_range`, and the remaining composition violations
to `invalid_format`, prefixed with `/configuration`. Unknown envelope fields use `unknown_field`.

| Method and native path                          | Body and success                                                | Authority                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /v1/zones`                                | `CreateZone` → 201 `ZoneResponse`, Location `/v1/zones/{id}`    | `zone:create` on Global Context; authenticated                            |
| `GET /v1/zones?limit=&cursor=&deleted=`         | 200 `ZoneList`                                                  | caller's own Zones only; authenticated `zone:read` per returned resource  |
| `GET /v1/zones/{id}`                            | 200 `ZoneMetadataResponse`                                      | `zone:read`, public exposure                                              |
| `GET /v1/zones/{id}/configuration`              | 200 `ConfigurationResponse`                                     | `zone:configure` or current owner-role `zone:read`; authenticated         |
| `PUT /v1/zones/{id}/configuration`              | `ConfigureZone` → 200 `ZoneResponse`                            | `zone:configure`; authenticated                                           |
| `POST /v1/zones/{id}:publish`                   | `PublishZone` → 200 `ZoneResponse`                              | `zone:publish`; authenticated                                             |
| `POST /v1/zones/{id}:readPage`                  | `PageRequest` → 200 `ZonePageResponse`                          | `zone:read`, public exposure                                              |
| `GET /v1/zones/{id}/subjects?limit=&cursor=`    | adopted: 200 `{subjects,next}`, 202 `{next}`, or dependency 503 | `zone:read`, anonymous floor and current source Access; route not mounted |
| `GET /v1/zones/{id}/collections?limit=&cursor=` | 200 `{collections,next}`                                        | `zone:read`, current source Access                                        |
| `DELETE /v1/zones/{id}`                         | no body → 200 `ZoneResponse`                                    | `zone:delete`; authenticated                                              |
| `POST /v1/zones/{id}:restore`                   | `{}` → 200 `ZoneResponse`                                       | current owner role and `zone:restore`; authenticated                      |
| `POST /v1/zones/{id}:takedown`                  | `Takedown` → 200 `ZoneResponse`                                 | `moderation:takedown`; authenticated                                      |
| `POST /v1/zones/{id}:releaseTakedown`           | `ReleaseTakedown` → 200 `ZoneResponse`                          | `moderation:takedown`; authenticated                                      |
| `POST /v1/platform/zones/{id}:purge`            | `Purge` → 200 `{id,state:'purge_pending'}`                      | `zone:purge` on existing Platform resource                                |
| `POST /v1/platform/zones/{id}:hold`             | `{reason:string}` → 200 `{id,held:true}`                        | `zone:purge` on Platform                                                  |
| `POST /v1/platform/zones/{id}:releaseHold`      | `{}` → 200 `{id,held:false}`                                    | `zone:purge` on Platform                                                  |

Decision: `GET /v1/zones/{id}/collections` walks the current configured mount order, omits only native
`not_found` Collection reads, and returns the Collection owner's existing safe resource projection. Its default
list cursor contains the last disclosed Collection ID and current Zone revisions; it never stores a mount ordinal
or hidden mount identity. Every page re-reads each configured mount and revalidates both source summaries and the
Zone basis before publishing the envelope or cursor.

### Mounted Collection summary list cost

- Touches: one current `zone:read` admission and Zone basis read before the `zone_sources` gate; at most sixteen
  native Collection reads in configured order; then a second pass of at most sixteen native Collection reads and
  a final Zone basis read. Each Collection read retains its owner's current Access and summary projection. No
  Collection members, histories, editor predicates or owner-list rows are read.
- Bound: two Zone read-authority checks, six keyed Zone-head observations and four Zone-owner Account reads
  across the two basis reads, plus one gate-group admission. At most 32 serial native Collection owner reads;
  each releases its own native checkout before the next owner call. Each selected Collection performs its
  existing `collection:read` check and one current resource projection per pass, with the Collection owner's
  existing additional cover/currentness reads when applicable. No cross-home transaction or shared budget change
  is introduced.
- Output: at most sixteen safe Collection summary slots regardless of `limit` (1–100); no total field. The
  default cursor profile stores three keys: the last disclosed Collection ID, Zone revision and lifecycle
  revision. Its token stays within the existing 4,096-character limit; hidden mounts contribute no cursor key or
  output slot. Encoded response bytes are the JSON encoding of those selected owner projections, the two-field
  envelope and at most one default-profile cursor; no bytes are spent on source descriptors or hidden mounts.

The last three routes are platform-exposed, never owner privilege or anonymous privilege. An early purge
requires that separate action/path even after an ordinary delete. An order reference is required to purge
an active record or payload covered by a current takedown; an early deleted-record privacy purge may
omit it only for uncovered payload. Supplying `order` explicitly selects the `legal_order` intent branch;
omitting it selects early privacy purge. `reason` is explanatory text, not authority. Neither a free-text
reason saying 'Legal order' nor generic early-purge authority permits erasing covered material. A hold blocks both automatic and requested
purge until explicitly released. Reasons/complaints are safe plain text of 1–2,000 code points, order
references 1–255; they are confidential moderation evidence, never part of public metadata or events.
Every route declares its action and `x-exposure` using the existing Exposure conventions. Only commands
initializing ordinary grants declare `x-resource-types`: `zone:create` declares `['semantic.zone']`.
Reads and non-initializing mutations omit it. Parent create authorizes Global Context; platform actions
authorize Platform; other actions authorize the Zone. This does not change Access metadata semantics.

`subjects` and `collections` reuse the current owning APIs' safe summary item schemas, with no total or
source-count field. All Zone lists, including the owned listing, use integer limits 1–100, default 20.
Success fills the requested page or proves genuine final exhaustion; otherwise return explicit preparation/
readiness. Admission covers filter + source + order with per-plan work bounds, and aggregate bounds for a common
page. The universal 256 raw-key rule and successful short/empty raw-window chains are superseded; unrelated native
batch/string/byte and cursor limits retain their own units.
Composition component preview limits and the existing appearance format are unchanged. These envelopes, canonical member ordering,
deduplication, freshness witness and continuation semantics belong to the independent Zone query contract;
this document does not choose a query algorithm. Its implementation must provide an anchored eligibility
probe for subject targets and bounded pages for these two routes before those paths can land. Do not
implement scans or an unreviewed query engine to fill this dependency. Refer also to
[dynamic Collections](dynamic-collections.md) and [library query research](research/library-query-bulk.md).

## Configuration, publication and Access

The resource base mounts create, metadata, owned listing, configuration, publish, delete and restore.
The mounted readPage runtime composes static documents and native source union/current-membership providers. The Subject GET is an adopted route design, not a mounted route; its native sparse preparation, replay, generated client and growth proof remain pending. Ordered Scope readiness and destructive lifecycle delivery are described in the [runtime inventory](../services/kernel/src/zones/README.md).
The code-first `Zone*Schema` exports in `src/zones/contract.ts` define the resource envelopes.

Creation authorizes the parent before touching the new partition. Allocate a routed Zone ID and copy the
validated configuration plus at most 16 distinct Collection IDs. The creating actor initializes primary owner metadata and the ordinary owner role. Parent
creation authority is not a permanent right to edit other Zones. In the same Zone command partition,
initialize the ordinary `semantic.zone.owner` resource role using the existing resource grant initializer.
Its actions are `zone:read`, `zone:configure`, `zone:publish`, `zone:delete`, `zone:restore`, `access:grant`.
There is no implicit owner shortcut in Access. `ownerId`/`owner_id` is primary owner metadata for
private-payload attribution, owned indexing and account cleanup, not immutable creator authority. All
maintenance/disclosure uses current Access and the current ordinary owner role where ownership is required;
a matching metadata ID alone never admits a request. Current legitimate owners cannot be rejected by a
creator-ID comparison. No transfer command or transfer probe has been supplied in this scope; Accounts
must supply the role-change/primary-owner synchronization probe through the manager before that behavior
is implemented. Do not invent a transfer workflow or permission formula to fill that dependency. A delegated editor needs explicit ordinary resource grants;
configure grants do not imply publish, delete, restore or rights in mounted data. No standing role grants
private Zone read or create to anonymous users. Ordinary Global Context grants control create admission;
this scope does not change registration defaults or auto-enable create for every account.

`private` is read only with a current resource grant. `unlisted` and `public` permit anonymous direct read
under the existing public resource eligibility formula. Only `public` is eligible for discovery/sitemaps;
unlisted direct links remain readable. A suspended valid bearer is refused with 403 `account_suspended` even if the same URL is anonymously readable. Missing, invalid or revoked credentials return 401 where required; they never silently downgrade to anonymous.
Unknown, private-unreadable, deleted, wholly withheld and ineligible subject targets all return the same
404 `not_found` problem apart from `request_id`. A known resource's unauthorized mutation/configuration
request returns 403. No authorization failure reads a receipt to disclose a previous result.

`GET /v1/zones` is an owner index, not public discovery. `deleted=false` is the default; `true` selects only
restorable deleted records. It uses opaque existing cursor sealing, binding account, route purpose, filters,
limit and freshness/security revision; malformed/tampered/rebound cursors give 400 `invalid_cursor`, stale
witnesses 409 `stale_cursor`. The source list routes bind viewer and Zone revision in addition to their
query contract's witnesses, and never expose raw Collection/source cursors. Cursors are not Access grants;
every resumed page checks the current Zone, actor and source authority before returning any row.

Validate with `validateZoneStarter(platformRegistry, configuration, {filters})` using the active definition
release's saved-filter IDs; retain that release digest with the configuration. A later release must not
silently retarget saved IDs: a missing/incompatible scope is unavailable until an owner republishes against
a compatible release. Reuse the closed sorted page/home and scope envelopes: at most 16 pages and 16
saved scopes, and every document at most 65,536 canonical UTF-8 bytes, 256 nodes, depth 8, 16 distinct reads
and cost 128. Mount IDs add no inline documents. They are references, never copied membership facts.
Configuration is a full replacement; invalid or stale updates change nothing. Check the new mounts through
the caller's current Collection read route before commit, with separately prepared source evidence and
current revision checks. Do not hold a Zone transaction while opening an unrelated home transaction.
Subsequent source revocation does not invalidate stored configuration, but removes that source from reads.

Create takes its initial visibility. Configure changes labels/pages/scopes/mounts immediately at the next
revision; there is no draft or hidden second page head in first scope. Publish is a separately authorized
visibility change, including a return to private. The term publish does not copy a page to another store.
Revision starts at `"1"`; every successful configuration, visibility, delete, restore and withholding change
advances it once. One strong ETag is the quoted revision on configuration, metadata and mutation responses;
`If-Match` is required on those Zone mutations other than create. Missing/malformed conditional headers
return 400 `invalid_request`; stale values return 412 `precondition_failed`. Never accept `*` as a revision.
Platform hold/purge commands serialize against the latest lifecycle head and recheck holds at effect time.

Every command uses the existing quoted `Idempotency-Key`, canonical request digest, receipted command,
CAS, session-token and outbox protocols. Exact replay returns the original status/body/ETag even when its
original If-Match is now old, after current actor and action admission. Reusing a key for a different
request gives 422 `idempotency_conflict`. Revoked or suspended replay is denied and writes nothing. Commit
resource/page changes, owner grants, receipt, write basis and outbox in ONE command partition; no source
owner's rows are mutated. Error paths leave no new revision, receipt or event.

## Shared page response and no-leak reads

### Web configuration interface

The signed-in configuration page is `/my/zones/{id}/edit`, with the existing Web locale prefix.
It reads the actual configuration and current resource actions independently of the My Zones list.
Available controls follow current `zone:configure` and `zone:publish` actions; owner metadata never supplies
authority. Missing, denied, session, unavailable and retry states retain the native outcome.
Unavailable action metadata disables writes and displays the API's status and problem code; a successful
configuration read alone never substitutes for current configure or publish authorization.

The kernel registers `semantic.zone` with the existing `viewerActions` protocol. Configuration reads,
configuration saves and publication declare their resource binding on the mounted routes, so the native
catalogue supplies `zone.get_configuration`, `zone.configure` and `zone.publish` from current Access grants.
The adapter reads only the requested current Zone keys and their native account fences in the request's
read snapshot. Active private heads retain a false public floor for explicit read grants; deleted, purged,
root-withheld, missing and inactive-owner heads are absent. Owner identity never grants an action, and no
source reads or source permissions are inferred from this metadata.

The page edits one primary name with optional translations, up to 16 sorted relative routes including the required empty
home route, and each document through the common registry-derived Puck composition editor. Page appearance
uses the common root tokens. Navigation follows the sorted configured routes; there is no independent navigation
layout or ordering store. The first route segment `subjects` remains reserved. Saved filters come from the actual
active definitions release and mounted Collection choices come from the current viewer's common Collection API,
including pagination. Existing unavailable selections remain identifiable and removable. No filter expression,
query, source member data, or executable page configuration is authored by this interface. Saving selects the
server's active compatible release; the UI does not submit a fabricated release pin.

Edits live only in the mounted page. Save sends the full configuration and mount IDs with the opaque decimal
revision quoted in `If-Match` and a quoted idempotency key. It replaces the current head immediately, including
on public and unlisted Zones. The generic editor's publication callback has no Zone visibility semantics; the
resource form supplies Save. Visibility changes use the separate publish operation on that same saved head,
with a new CAS basis and key. Unsaved edits disable saved preview and visibility changes.

Errors preserve local edits. The editor re-reads the server before offering a mutation retry; a changed head or
412 requires an explicit reload/discard or reapply choice. Reapply keeps local edits against the newly read
revision and requires a separate Save. Exact unchanged retries retain their request key; changed bodies or
revision bases get new keys. Navigation away from dirty edits asks before discarding; closing or reloading the
document uses the browser's unsaved-changes prompt.

Saved preview posts only a route and reader languages to `zones/{id}:readPage` using the current viewer, and
passes the response to the existing Zone shell and common renderer. It never submits the local document or uses
configure authority as fallback read authority. Missing, denied, preparing and source-runtime readiness responses
remain real states with retry controls. Open/copy links address the actual `/zones/{id}/{relativeRoute}` reader.
An unlisted link may be readable without signing in; visibility never grants mounted-source authority. Source
execution remains subject to the existing exposure boundary above.

`readPage` wraps the existing presentation result at the top level with `zone`, preserving `profile`,
`template`, `document`, `reads`, optional `subject` and `views`. It adds no page-specific data API. Configured
pages select `{scope:'route',key:relativeRoute}`; `profile` is the active common presentation digest captured
for that read. Subject targets first prove current Zone membership and subject readability, then resolve
the existing active type/base/generic profile and view. Membership is the deduplicated union of readable
saved scopes and readable mounted Collection members, never a promise that a related subject is eligible.
Invalid views give 400; an undefined valid view gives 404, as on the common page endpoint.

Use `planReads(platformRegistry, document, {subject,...})` and the existing
`services/kernel/src/presentation/reads.ts` `readPage`. Each descriptor dispatches to its actual owning
read with the original authorization/session credentials and languages, preserves its status/body and
merges returned session tokens using the common protocol. Search-backed lists must use the independently
specified Zone query restriction; they must not accidentally run a global TypeList query. Related attributes
retain their owning disclosure predicates; Zone membership does not authorize private relations, library
facts, reviews or Collection content. No cross-home SQL join or borrowed owner credentials is permitted.
Recheck current Zone visibility and each source's Access at disclosure, including a repeated identical
request after revocation. `Cache-Control: private, no-store` applies to all successful Zone reads; an ETag
is a write precondition, never a reason to skip current Access checks.

`ZonePublic` is also the shell in page results. Navigation is only the sorted configured `{route}` entries
that remain visible. Its labels come from the Zone's authored safe name map, not mounted Collection titles.
It has no owner ID, mounts, scope IDs, source names, private configured counts, total source counts,
configuration, deletion evidence or history. Readable Collection summaries appear only through the separate
Collection mount route, which omits unreadable entries entirely. Configuration response is authenticated
and contains the exact mounted IDs and documents for authorized maintenance. Public metadata has exactly
`ZonePublic` even for an owner; owner fields appear only in configuration, owned listing and mutation responses.

Appearance is the EXISTING root `props.appearance` vocabulary: density `compact|comfortable`, radius
`sm|md|lg`, surface `flat|cards`, cover `portrait|square|landscape`, headingScale `md|lg`. The shell's effective
appearance is the home document's tokens overlaid by the selected document's tokens, per key. Omitted keys
stay omitted and use existing renderer defaults. Metadata uses home tokens. Do not invent a second set of
defaults or new colours/fonts. Subject template appearance overlays home tokens the same way. Appearance
changes mixed-list frames; subject headers retain semantic type frames and existing portrait/5:7 behavior.
Use the common safe href validator for existing LinkGrid links; there are no arbitrary URL configuration
fields, custom CSS, HTML, script, stylesheet, font, iframe or executable page hooks.

### Static configured-page runtime and Cost

`POST /v1/zones/{id}:readPage` currently completes admitted configured documents whose common `planReads`
plan contains no data reads, including empty documents. It uses the current caller's `zone:read`, never the
owner-only configuration HTTP route or `zone:configure`. Current eligibility, native Access at authoritative
T, the selected document, public shell and partition epoch/position are read in the same Zone-home
`REPEATABLE READ` snapshot. The response records that actual session observation without a synthetic
projection caught-up claim. The Zone connection is released before the common active-profile lookup.
The active immutable profile supplies the real digest; the template is `{scope:'route',key:relativeRoute}`.
The common read executor receives the empty plan and performs no subrequests. Languages retain common
validation and do not translate configured copy. Static pages require no preparation and return complete 200.

Unknown or withheld pages/documents return concealed 404. The copied document empties covered text and
omits covered appearance tokens; navigation and labels use the existing public shell withholding rules.
The selected document's safe appearance overlays the safe home appearance. Internal configuration, mounts,
scope and owner attribution do not cross this boundary. Valid-shaped unusable POST cursors fresh-start
under current authority; invalid query/body shapes remain 400 and GET cursors are unchanged.

Cost: this path prepares the existing anchored Zone eligibility/Access evidence, then reads the exact
`(route,zone_id)` head, current native Access evidence and the one Zone partition observation. Eligibility
verification uses the same exact head key. There are no source, subject, Collection, history or owner-list
reads. The in-memory route selection and navigation visit at most 16 admitted pages; each document retains
the existing 65,536 canonical UTF-8 byte, 256-node and depth-8 limits. Only the selected document is copied
and redacted. After release, the existing Global active-profile index reads its newest activation and, on
an immutable-cache miss, the exact digest body (existing 1,048,576-byte / 128-template admission). Point
rows and statements are independent of unrelated Zones/history; index buffers follow index depth. The
common plan executes zero distinct data reads and zero output slots, within the existing 16/128 bounds.
The request's native deadline also bounds the Zone snapshot's statements and is checked around profile
lookup and response construction. This adds no query budget, projection or maintenance work.

Subject targets and configured documents requiring data first require native `zone_sources` admission
after current Zone readability: ungranted callers receive `403 platform_closed`. The mounted composition now
uses the actual same Search service and native Collection/canonical providers. Original saved scopes retain their
release pin; mounted Sources require current native authorization. The union settles only completely discovered
covered ranges and retains actual unfinished owner progress. A MemberSource is intersected with this union.
Direct targets require current native membership before the common Subject/type/view reader; a source-free direct
target is concealed 404. No Source ID, Zone ownership or exposure grant supplies membership.

Name/count TypeLists call the exact selected Scope `nativeOrder` preparation and `orderedPrefix` ports, preserving
native tuples and work receipts. Their current native bodies are still unavailable in this input; the composition
propagates standard retryable 503 rather than substituting a UUID page or complete public Search result. Underlying
Source `metadata_missing` remains an independent owner dependency. See the [callable runtime inventory](../services/kernel/src/zones/README.md).

Real bounded advancing work retains disposable locators and returns private/no-store `202 {next}`; complete pages
return 200. Native unavailability or impossible/no-progress work returns 503 with Retry-After and no partial document
or replacement cursor. `zones.page_preparation` is bounded derived work, separate from the existing authoritative
Zone head. Configuration/lifecycle updates invalidate it in the owning transaction. Cursor encryption uses the
existing Accounts search profile and current authorization on every request. This establishes composition code,
not native six-surface, Source publication, physical/growth, GET-list or account/lifecycle completion.

### Retained preparation and current query safety

A common page combines admitted direct catalogue/owner or prepared public/owner plans and has aggregate admission
within 16 distinct reads and 128 TOTAL output slots. These prose names select no executable discriminants. Direct
execution needs a page-derived bound including engine work; otherwise use bounded retained preparation with finite
progress/quota/expiry on existing infrastructure, or reject 422 before enumeration. A LIMIT or timeout is no proof.
Sparse matches must yield useful pages after finite preparation, not repeated final-leaf replay.

POST keeps optional opaque cursor query and existing Search profile for every viewer, stable request binding,
mutable encrypted basis, exact native tuple types and fresh current authorization on unusable valid-shaped progress.
`200` is the complete common page plus shell; `202 {next}` is explicit preparation with private/no-store; `503`
Problem + Retry-After without cursor is unavailable/no progress. No partial document. Web follows at most four 202
steps then renders a private/no-store preparing page retaining continuation. A 202 is not empty successful output,
cached authority, per-leaf verdicts or a client result vector. GET keeps its default profile. No schema, status/body
or codec change is selected here.

Current original AND terminal Access/eligibility, source consent, foreign targets and tuple fences remain required
for everything disclosed, including exclusion/order/source metadata/cursors. Query-level privacy invalidation and
acknowledgement is additionally required: local reductions invalidate public use in their authoritative transaction;
foreign source-fence/target/consent/Collection reductions invalidate affected use immediately. Acknowledgement covers
actual refresh-visible repair INCLUDING dependent foreign repair. Observe safety before execution and revalidate
before disclosure. Missing/pending/unsafe/changed acknowledgement means preparing/readiness. A withheld harem tag
must not affect NOT harem exclusion or order; returned-ID checks and omitted counts alone are insufficient. Normal
checkpoints, local securityRevision or complete ordinary generations cannot certify query privacy. This abstract
seam selects no safety-token store, global sweep or new permission authority, and current ports remain incomplete.
Unsafe engine totals/facet counts over unchecked populations are omitted, without approximate/as_of or zero/row-length
fallback.

Ordinary catalogue edits become filterable within 60 seconds in healthy operation; over five minutes of actual
source-to-searchable lag gives readiness. Engine refresh alone is insufficient. Privacy reductions apply immediately
and owner writes appear on the owner's next read. Canonical lists use maintained canonical-ID indexes and unique
prepared rows. Lists prepare while the shared identity epoch is pending and cursors restart after epoch changes;
no request-time exhaustive alias/home sweep. Group admission is at most 4,096 originals before effects, with only
direct published redirects to active terminals. Original/terminal disclosure and stored personal occurrences remain.

The [shared acceptance matrix](filtered-lists.md#shared-acceptance-matrix) requires harem light novels, Book wordCount

> 1,000,000 and combined across public Zone/Collection and own library without/with own state, all Collection kinds,
> visibilities and mounts. Preserve exact-threshold/absent exclusions, qualifier/unit and compact/expanded conformance,
> two-release pins, real shared Search runtime, canonical cross-page ordering, current grant/source/fact revocation,
> paused-indexer NOT/order/count readiness through local AND foreign repair, native cursor restart/session/cache and
> full persona/API/default/growth requirements. Old SAME256, final-replay, alias-window and home-certificate remedies
> are superseded evidence; this prose proves no native acceptance.

## Deletion, restoration, withholding and durable cleanup

Delete is soft deletion at authoritative time T: retain the original visibility, set restore_until to T+30 days, suppress public page/metadata reads, remove discovery eligibility and leave tombstones in referring systems. Inside the window, only the current owner may read the deleted listing/configuration; read/configure grants alone do not bypass deletion. Delete never removes a mounted Collection, catalogue subject or grant in another resource. Restore requires the current owner role and zone:restore strictly before the original deadline; at the deadline it returns 409 even if cleanup has not run. It preserves configuration, prior visibility and current withholding, never releases a takedown, and unknown/purged resources return 404. Holds do not extend restoreUntil. A restore committed before first destructive CAS cancels deletion-bound work. Once destructive work wins, its CAS advances the Zone revision/lifecycle revision and enters purge_pending. Account erasure is terminal immediately and has no individual restore period.

The committed access.erasure barrier makes private Zone payload eligible immediately, including an individually deleted Zone inside its window; account deletion ends owner restore authority. The consumer uses primary-owner metadata, terminal account state and the committed barrier, not creator privilege or an event alone. Access confirmation does not wait for physical cleanup. Public/unlisted-ever Zones retain a nonpersonal tombstone; always-private rows are removed only after children and protection settle. No ownerless-read exception is added for an active account-retained public Zone.

Takedown withholds only the least necessary original at structurally interpreted RFC 6901 pointers. Covered originals survive ordinary expiry, early privacy and account cleanup, with version-specific array reversal locators retained. Editing rebinds protected originals to the edited configuration; it never guesses a replacement location. Named release removes only its own coverage. Holds block every destructive branch. A takedown uses 1–16 unique pointers into existing configuration fields, validated against the admitted revision and field type before commit. Covered text renders as safe empty text; a covered page/document is omitted and answers 404; a covered label is omitted. Other fields remain readable, and ordinary grants never reveal the retained original. Releasing the same pointers removes only those decisions. Takedown keeps active/deleted state and the existing deletion clock unchanged, creates no destructive work or 30-day clock, and never releases a source fence owned by another module. Events and audit keep IDs and decisions only; restricted evidence retains protected originals and exact reversal locators. Platform intent is committed separately from ordinary delete, with holds rechecked before every destructive batch.

### Zone cleanup authority and protection

Zone cleanup requires a Zone-only admitted operand, distinct from the unchanged ordinary RecordPurgeAuthority. Its common binding includes the committed intent/barrier, original home and epoch, Zone revision and lifecycle revision, deletion generation, durable progress, and protection revision. Proposed prepareZoneCleanup and lockZoneCleanup interfaces are not delivered callable exports.

The operand has four branches: ordinary expiry uses the real committed ordinary deletion; early_privacy uses committed Platform intent on a deleted Zone; legal_order uses explicit intent plus a Content-admitted exact Zone/generation/scope/decision reference; terminal_account uses the committed access.erasure identity and barrier, terminal account state, and captured primary-owner evidence. An event, reason string, timestamp or asserted type cannot authorize cleanup. The ordinary authority remains ordinary-only; it grants none of the other branches.

All protection, intent, configuration, account and payload-copy writers lock the exact Zone parent before child rows, including insertion of an absent decision. Hold head, protection, source and copy fences stay locked through destructive COMMIT or ROLLBACK. Recheck current authorization on retry. An already accepted receiving effect pins its source until native release; protection completes after that release while preserving original command custody. This extends existing Zone branch validation and committed completion verification, without creating a protocol, scheduler, receipt family, Source, custodian or foreign-home scope.

Own CAS advances expected progress. Active legal cleanup receives its own generation. The first destructive CAS fences writers, enters purge_pending and preserves deletion identity. Restore that wins before it cancels deletion-bound work; restore never moves the original 30-day deadline. Always-private Zone rows are removed only after children and protection settle; no unbounded cascade or resurrection is allowed. Closed minimal source identity remains after always-private payload removal.

### Bounded cleanup and completion

One invocation selects K+1 raw ordered keys before eligibility or hold filtering, with K=1–100; it processes at most K and retains the lookahead without effects. Keyed durable wakeups avoid wrapping over held populations. Keep separate history, physical-copy, grant and preparation cursors. Share at most 16 payload targets, four history members and one physical copy across the whole invocation, not per selected key.

Proposed internal byte admission is 1,024 bytes per raw key descriptor, 4,096 per control/progress row and 2,097,152 canonical UTF-8 bytes for one selected current/history payload unit. These are work allowances, not accepted-input caps. Oversized historical material is paged by its custodian. Coverage adds at most 16 × (D+1) indexed existence probes for maximum admitted pointer-token depth D, reserved before effects. Derive BEGIN, settings, COMMIT/ROLLBACK, callbacks, triggers, constraints, empty seeks, authorization, replay, progress, receipt/outbox, rows, points, statements, UTF-8 bytes and engine requests separately; failed attempts remain charged. No complete path price or native pass is established by these reservations.

Completion requires closed source inventory, actual minimized copies, released receiving holds and resolved late effects. Empty traversal is not completion. Public-ever deleted Zones retain only nonpersonal ID/type, revision, deletion/tombstone state and relation/count skeleton; always-private rows disappear after child/protection settlement. Backup expiry is separate. Active account-retained public readability remains an owner policy dependency; add no ownerless-read exception.

### Storage seams and owner responsibilities

The authoritative row remains zones.zone. resource-store.ts owns its SQL: readZoneHead, lockZoneHead and compareAndSetZone bind resource and lifecycle revisions in the surrounding native command. Ordinary mutations retain independent withholding, hold and write-fence evidence. Account-erasure's direct Zone UPDATE and retention's final direct UPDATE must move through this writer; the current ordinary RecordPurgeAuthority predicate and candidate/Context consumers remain unchanged.

Access owns paged resource-grant minimization; Content owns committed order scope and exact reversal evidence; History owns Zone receipt/outbox/work dispositions and physical closure; Accounts supplies the committed terminal barrier, captured owner evidence and its copy minimization. Each exact receiving interface remains pending delivery. Minimize configuration/history/mount/owner/preparation copies through their owners; keep protected originals and reversal locators until their disposition commits. Replay must not restore payload or reveal old receipt responses. No retention or account completion is inferred from an empty cursor or receipt status. Backup expiry remains separate.

Register Zone lifecycle events through the existing event composition with only ID, revision and needed decision metadata; never owner links or payload. Do not emit a second event on replay or enqueue destructive work on takedown. Owned-resource indexes and cursors remain keyed by Zone home/owner and current security evidence; attribution alone is not authority. Read and preparation bounds follow [Filtered lists](filtered-lists.md#cost): at most 16 shared reads and 128 output slots, with separate current probes for up to 16 scopes and 16 mounts.

Cleanup growth still requires native two-connection COMMIT/ROLLBACK schedules and fixed selected-work growth across 64/512/4096 unrelated Zones and independently growing histories, copies, viewers, preparation and grants. Those outcomes remain unproved by this adoption. The relevant general owner contracts are [Deletion](deletion.md), [semantic deletion](../services/kernel/src/semantic/deletion-contract.md#ordinary-owner-issued-purge-authority) and [History](../services/kernel/src/history/README.md).
