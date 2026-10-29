# Zones

A Zone is an owner-controlled routed site over saved catalogue scopes and mounted Collections. It uses the
one catalogue, the one Collection model and the common composition renderer. It is neither a Realm nor a
Space, grants no rights in its sources, and creates no vertical-specific backend. This document owns the
first public Zone resource, lifecycle and page-read contract under [scope](scope.md) and [deletion](deletion.md).
The eight `packages/definitions/presentation/*/zone.json` starters are inert input data. They instantiate
nothing until a person submits a create command; subsequent definition releases never rewrite a Zone.

[Filtered lists](filtered-lists.md) owns complete indexed observations, current disclosure, direct/prepared plans,
freshness, canonical identity and cost. [Zone membership](zone-membership.md) owns source composition obligations.
The resource substrate and independent static configured-page reads are integrated; source-dependent
membership/page/default execution and Zone-specific withholding,
purge, account cleanup and scheduler work remain incomplete. Typed schemas, immutable loaders, cursor capacity
and helper setup do not establish those capabilities; the
[integration audit](research/semantic-integration-audit-zone-composition.md) remains evidence, not a completion gate.

## Public exposure boundary

The public slice is configured static routed documents with no planned source reads, through current
`zone:read` authority. The mounted `zone.read_page` operation remains public for this slice. Saved-scope
and mounted-Collection unions, direct catalogue targets, source-dependent lists and retained preparation
remain deferred behind `zone_sources` platform grants. A source-dependent request first proves current Zone
readability, preserving identical unknown/private concealment and the safe public shell, then calls native
`admitGroup` with the real Actor, mounted client action, original deadline and configured clock. Anonymous
and ungranted accounts receive the standard `403 platform_closed` Problem. Zone ownership supplies no gate.

An explicit `gate:zone_sources` (or covering platform grant) admits development exposure only. It supplies
no membership or source permission and reveals no private mount metadata. Missing source/runtime owner
ports still answer the truthful typed `503 semantic_not_ready`, with `Retry-After: 1`, after admission.
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
Configured routes are decoded once, relative, case-sensitive and canonical: no leading/trailing slash,
empty segment, dot segment, query, fragment, encoded slash, backslash or URL. The empty string means home.
Reserve the entire first segment `subjects`, including `subjects` itself, before page lookup. A configured
page cannot shadow it. Unknown configured pages return 404; they do not fall back to the generic template.

The implementation adds code-first TypeBox/Elysia request and response declarations in
`services/kernel/src/zones/http.ts`. These TypeScript shapes specify that ABI; emit OpenAPI from those
route declarations, never a handwritten schema. Every object below is closed; string aliases carry the
existing validators, not coercion. UUIDs are canonical lowercase routed IDs, revisions decimal strings,
instants RFC 3339 UTC with milliseconds. `View`, `CompositionDocument`, `ZoneStarter` and `APPEARANCE`
are imported from `@rezics/composition`. No alternative composition format is admitted.

```ts
import type { CompositionDocument, View, ZoneStarter } from '@rezics/composition';
import { APPEARANCE } from '@rezics/composition';
type UUID = string;
type Revision = string;
type Instant = string;
type Visibility = 'private' | 'unlisted' | 'public';
type Appearance = { [K in keyof typeof APPEARANCE]?: (typeof APPEARANCE)[K][number] };
type PublicLabels = Partial<ZoneStarter['labels']>;
type Navigation = { route: string }[];
type ZonePublic = {
  id: UUID;
  revision: Revision;
  labels: PublicLabels;
  visibility: Visibility;
  appearance: Appearance;
  navigation: Navigation;
};
type ZoneOwned = ZonePublic & { ownerId: UUID; deletedAt: Instant | null; restoreUntil: Instant | null };
type CreateZone = { configuration: ZoneStarter; mounts: UUID[]; visibility: Visibility };
type ConfigureZone = { configuration: ZoneStarter; mounts: UUID[] };
type ConfigurationResponse = { zone: ZoneOwned; configuration: ZoneStarter; mounts: UUID[] };
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
Configuration/input requires exactly the eight label keys `en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr`, `es`; selecting one does
not change the configured labels envelope. Public output uses `PublicLabels`: a closed partial map of
those same locale keys and safe values; withholding may remove keys, including every key. Labels are safe nonempty plain text, at most 80 code points each. A configured
route has no `view`; a subject has no `route`; account targets are not Zone targets. Bodies with extra keys,
invalid targets or reserved configured routes fail with 400 `invalid_request` and existing RFC 6901 field
errors. Shared validation violations map `limit` to `out_of_range`, and the remaining composition violations
to `invalid_format`, prefixed with `/configuration`. Unknown envelope fields use `unknown_field`.

| Method and native path                          | Body and success                                             | Authority                                                                |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `POST /v1/zones`                                | `CreateZone` → 201 `ZoneResponse`, Location `/v1/zones/{id}` | `zone:create` on Global Context; authenticated                           |
| `GET /v1/zones?limit=&cursor=&deleted=`         | 200 `ZoneList`                                               | caller's own Zones only; authenticated `zone:read` per returned resource |
| `GET /v1/zones/{id}`                            | 200 `ZoneMetadataResponse`                                   | `zone:read`, public exposure                                             |
| `GET /v1/zones/{id}/configuration`              | 200 `ConfigurationResponse`                                  | `zone:configure` or current owner-role `zone:read`; authenticated        |
| `PUT /v1/zones/{id}/configuration`              | `ConfigureZone` → 200 `ZoneResponse`                         | `zone:configure`; authenticated                                          |
| `POST /v1/zones/{id}:publish`                   | `PublishZone` → 200 `ZoneResponse`                           | `zone:publish`; authenticated                                            |
| `POST /v1/zones/{id}:readPage`                  | `PageRequest` → 200 `ZonePageResponse`                       | `zone:read`, public exposure                                             |
| `GET /v1/zones/{id}/subjects?limit=&cursor=`    | 200 `{subjects,next}`                                        | `zone:read`, current source Access                                       |
| `GET /v1/zones/{id}/collections?limit=&cursor=` | 200 `{collections,next}`                                     | `zone:read`, current source Access                                       |
| `DELETE /v1/zones/{id}`                         | no body → 200 `ZoneResponse`                                 | `zone:delete`; authenticated                                             |
| `POST /v1/zones/{id}:restore`                   | `{}` → 200 `ZoneResponse`                                    | current owner role and `zone:restore`; authenticated                     |
| `POST /v1/zones/{id}:takedown`                  | `Takedown` → 200 `ZoneResponse`                              | `moderation:takedown`; authenticated                                     |
| `POST /v1/zones/{id}:releaseTakedown`           | `ReleaseTakedown` → 200 `ZoneResponse`                       | `moderation:takedown`; authenticated                                     |
| `POST /v1/platform/zones/{id}:purge`            | `Purge` → 200 `{id,state:'purge_pending'}`                   | `zone:purge` on existing Platform resource                               |
| `POST /v1/platform/zones/{id}:hold`             | `{reason:string}` → 200 `{id,held:true}`                     | `zone:purge` on Platform                                                 |
| `POST /v1/platform/zones/{id}:releaseHold`      | `{}` → 200 `{id,held:false}`                                 | `zone:purge` on Platform                                                 |

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
The independent static runtime additionally mounts `readPage`; source lists, union evaluation and destructive
lifecycle work remain separate implementations.
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
that remain visible. Its labels come from the Zone's eight safe labels, not mounted Collection titles.
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

Subject targets and configured documents requiring data remain `503 semantic_not_ready` Problem with
`Retry-After`, without partial documents or replacement cursors, until actual source-dependent runtime
ports are available. The declared closed 202 progress envelope is reserved for real retained preparation;
this static implementation emits none. Static completion does not establish any remaining union,
direct-target, freshness, canonical-order, privacy-repair or default-worker obligation below.

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

Delete is soft deletion at authoritative domain time T. Set `deleted_at=T`, `restore_until=T+30 days`,
retain the previous visibility for restoration, suppress all public and owner page/metadata reads immediately,
remove discovery eligibility, and leave tombstones in referring systems. The owned deleted listing and
configuration route may return the current owner's tombstone and retained configuration inside the window; editor
read/configure grants alone do not bypass deletion. Restore is available only through the current owner role with
current `zone:restore` and T strictly before `restore_until`; exactly at the deadline it returns 409
`conflict` even if cleanup has not run. Restoration preserves configuration, prior visibility and all current withholding decisions; it never
releases a takedown. A purged
or unknown resource returns 404. Delete does not delete a mounted Collection, catalogue subject or grant
in another resource. Account erasure has a DIFFERENT clock: confirmation is final in first scope, not a new 30-day
account grace. The existing `com.rezics.access.account-tombstoned.v1` barrier hands off bounded Zone
payload cleanup immediately. Private payload is eligible at that barrier, including an individually
deleted Zone still inside its restore window; account deletion ends its owner restore authority.
There is no account restore endpoint or synthetic non-human deletion authority here. The consumer
uses primary owner metadata, current account terminal state and the committed barrier, not creator
privilege. It must fence writers against payload resurrection and checkpoint cleanup; Access confirmation
does not wait for physical cleanup. This handoff still respects current takedown retention and legal holds.

After an individual Zone's window (or immediately on the terminal account barrier for private payload),
bounded durable work automatically purges personal/private payload with no platform
permission or manual action. Remove configuration/documents, labels, mounts, owner/author links and resource grants, historical
payload and payload-bearing receipt responses. Events/audit retain identifiers and decisions only; no
page text, original labels, complaint contents, owner link or private source references survive in evidence
past the applicable window, except material retained under a current takedown or legal hold, kept as
restricted evidence only. Prefer command receipts that contain only nonpayload outcome references from the outset;
cleanup must also scrub any responses that originally contained labels. A replay after the window cannot
resurrect or disclose the erased response. Previously publicly readable (public or unlisted) Zones keep only a nonpersonal ID/type,
revision, deletion/tombstone state and nonpersonal relation/count skeleton. Always-private
sites have a personal skeleton (it reveals a private site/owner relationship): erase their whole Zone row
once no takedown-retained payload or legal hold requires it.
Do not preserve private mount edges under the name of relations. Whole-row erasure is this narrow exception,
not the general purge algorithm. Purged public tombstones retain no owner authorization link.

Legal holds suspend cleanup without changing restore deadlines. Purge requests before the window, and
legal-order purges of active data, use the separate Platform route; default delete accepts no purge flag.
Requests commit durable intent; workers recheck a current hold immediately before each destructive batch.
An unheld automatic batch needs no actor admission; its authority is the committed individual deletion
and deadline or terminal account barrier. A current takedown excludes its covered original from automatic
and early privacy purge even after the deadline. Purge uncovered personal/private fields only, retaining
the minimum protected payload and locator needed for reversal; do not mark covered payload purged.
Only the explicit `legal_order` intent branch with an order reference can purge that covered original,
and a legal hold still blocks it. Removing a takedown on an already expired deleted record makes that
payload eligible for automatic cleanup; it does not create a fresh restore window.
Failures resume from a sealed source-key continuation. Count examined keys before eligibility/hold filters,
so a page of held keys cannot cause an unbounded scan. A batch examines at most `limit` source keys plus
one lookahead; `limit` is 1–100. It must advance past held/ineligible keys while preserving a durable retry
for holds/deadlines. Completion and per-key effects are idempotent under worker replay and CAS races.

Takedown is separate least-field withholding, never deletion. `fields` has 1–16 unique RFC 6901 pointers
into configuration (for example `/labels/en` or `/pages/0/document/content/0/props/text`): a label, a page text field, a whole page document, or `""` for the whole resource only
when nothing smaller serves the notice. Validate existence and allowed field types before committing.
Store original data unchanged with separate withholding decisions. Covered text renders as empty safe text;
a withheld document/page is omitted from navigation and answers 404, and a covered label is omitted from
public labels (the public label map may therefore have fewer than eight keys during withholding). Other
labels/pages/fields remain readable. Whole-resource withholding answers the normal 404. Never return the
covered original through public document, navigation, search, metadata, receipt or audit endpoints. Owner
configuration is restricted evidence; ordinary read grants do not reveal withheld originals. Releasing the
same pointers removes only those decisions and reveals retained data again. Takedown on an active Zone leaves `state=active`, `deleted_at=null`, `restore_until=null`; on a deleted
Zone it preserves the existing deletion clock. It schedules no destructive work and starts no 30-day
clock. Source fences belong to Content: a Zone forwards current source disclosure outcomes, never
releases a source fence or erases a mounted source to implement its own takedown/purge.

## Storage seams, bounds and implementation splits

Production work belongs in `services/kernel/src/zones/` (`http.ts`, `contract.ts`, `commands.ts`, `reads.ts`,
`eligibility.ts`, `purge.ts` and colocated SQL) and `services/kernel/db/zones/` with additive migrations.
Use Zone-home keyed state and page heads, not a vertical table. Account-erasure-triggered `purgeZonePage` must check the real terminal account barrier and primary owner
metadata before bypassing the individual deadline; merely invoking the worker is never erasure authority.
The raw-effect acceptance seam is
`zones.zone(route,zone_id,revision,state,owner_id,configuration,mounts,deleted_at,restore_until)`; the payload
columns become NULL on a public tombstone. Page/history/withholding storage may be split further but is
subject to the same payload erasure. The bounded production worker seam is:

```ts
purgeZonePage({pool, clock, route, zoneId, cursor, limit}): Promise<{next: string | null}>
```

It performs a real durable cleanup step using native commands; cursor is opaque and bound to the Zone and
cleanup generation. The scheduler must use this same step, register it in `src/work/modules.ts`, and persist
its continuation; tests call the step with a domain clock and inspect actual rows/events/receipts, not a
simulated model. `next:null` ends this traversal; a held Zone still has a durable wakeup when released.

Register additive actions `zone:create/read/configure/publish/delete/restore/purge`, the
`semantic.zone.owner` role and resource type in existing Access composition. Reuse `moderation:takedown`;
register no new permission formula. Register event schemas for `com.rezics.zone.{created,configured,published,
deleted,restored,withheld,withholding_released,purge_requested,purged,hold_changed}.v1` with existing event
registration. Events carry `{id,revision}` and only the decision metadata needed by consumers; no payload
or owner ID. Outbox subject is the Zone UUID. Do not emit duplicate events on replay or enqueue a purge on
takedown. Read/create/update tests must verify ordinary grant initialization, current source checks and
receipt/outbox raw effects before claiming that the routes are implemented.

| Independent task  | Files/callsites and required handoff                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header/ABI first  | Add `src/zones/contract.ts` and `test/zones/header-contract.test.ts`; export the common page schema from `src/presentation/http/pages.ts` as `pageResponse`. Exact exports and focused checks below. No route registration or database work in this split. |
| Resource commands | Add Zone migration, commands and HTTP metadata/configuration/create/publish/CAS; compose `src/http/kernel.ts`, `src/http/write-rate-routes.ts`, Access resource roles/action declarations and schema derivation. Parent initializer is mandatory.          |
| Routed page read  | Add Zone read/eligibility and reuse presentation `planReads`/`readPage`, credential/session forwarding and profile lookup. Preserve existing routes and renderer. Depends on query eligibility probe, not on lifecycle worker.                             |
| Lifecycle         | Add delete/restore/withholding and bounded `purge.ts`/worker registration, account-erasure adapter, receipt/evidence scrubbing and platform authorization. Depends on resource commands, not on Web.                                                       |
| Native growth     | Exercise fixed reads at 64/512/4096 unrelated Zone/page/history scales through unchanged shared growth capture; constant rows/statements and logarithmic blocks. Add bounded cleanup pages with held/ineligible keys, real CAS races and retry effects.    |

The resource base keeps one authoritative row in `zones.zone`. `resource-store.ts` owns all row SQL.
`readZoneHead(client, route, id)` reads an exact point; `lockZoneHead(tx, route, id)` locks the current head.
`compareAndSetZone(tx, before, next, {at, transactionId})` updates payload/state against both the resource
and lifecycle revisions. Callers own the surrounding native command transaction, including receipt,
grants and outbox; these ports never open or commit a transaction. Ordinary mutations retain independent
withholding, hold and write-fence evidence. New lifecycle writers must use these ports.
Zones use the owner's route for the bounded `(route, owner_id, state, zone_id)` owned index. Index attribution
never replaces current owner-role evidence and native Access. Owned cursors also bind the partition epoch
and position plus the actor's current security snapshot; concurrent writes may require restarting a list.

Read cost follows [Filtered lists](filtered-lists.md#cost), including one internal cost object per page/step and separate shared harness captures. It touches Zone-home metadata and current page points, at most 16 shared reads and 128 TOTAL output slots, and separately
anchored source Access probes for at most 16 scopes and 16 mounts. No full owner/library/Zone/history scan,
cross-home SQL join, global count or scan-for-authority. Lifecycle cost is changed keys times index depth
plus receipt/outbox/ordinary grants in one command partition; cleanup is bounded examined source-key pages.
Use the existing growth harness accounting unchanged, with native API-created fixtures, not elapsed time
or worker-provided counters. The expected-red native resource tests name the missing HTTP availability
assertion before any new-action grants or future-module imports. Their lifecycle checks use the injected
domain clock, actual retained/erased payload, unchanged outbox on replay and a real bounded purge capture.
Full scheduler, all held-key growth and concurrent CAS coverage are implementation-task acceptance additions,
not evidence that the specification tests already prove a running scheduler.

Cross-owner dependencies to agree through the manager before implementation: Commerce supplies current
Collection summary/member Access and built-in dynamic Collection reads without copying personal facts;
Search/query supplies bounded scope-union eligibility, restricted search and freshness/cursor witnesses;
Accounts supplies parent/ordinary-role integration, account-erasure continuation and platform admission;
Content supplies moderation notice/hold evidence retention integration; Web consumes the top-level common
page wrapper, the preserved path routes and effective tokens. No new route shape changes an existing API:
all Zone paths are additive. Manager assumptions are explicit: one immediate configuration head (no draft),
public-only discovery, owner-only index, exact 30-day exclusive restore boundary, always-private skeleton
removal and publication action controlling visibility only. These choices follow this resource scope and
must not silently become a new publishing workflow, discovery service or query engine.

### Small Header/ABI handoff

The next independent implementation changes exactly `services/kernel/src/zones/contract.ts`,
`services/kernel/src/presentation/http/pages.ts` (export the existing `pageResponse` unchanged), and
`services/kernel/test/zones/header-contract.test.ts`. `contract.ts` exports the code-first schema values
`zonePublicSchema`, `zoneOwnedSchema`, `createZoneSchema`, `configureZoneSchema`,
`configurationResponseSchema`, `zoneResponseSchema`, `zoneMetadataResponseSchema`, `pageRequestSchema`,
`zonePageResponseSchema`, `zoneListSchema`, `publishZoneSchema`, `takedownSchema`,
`releaseTakedownSchema`, `purgeSchema`, and their inferred types named as in the ABI above. Export
`publicLabelsSchema` for the closed partial safe locale map, and reuse composition validators for the
exact-eight input/configuration map. The common page schema includes optional `account` for its existing
account-target responses; the Zone schema excludes that property and permits only Zone page targets.
Do not mutate the common response schema while deriving the Zone extension.

A meaningful focused test is `bun run --cwd services/kernel check test/zones/header-contract.test.ts`:
"Zone header schemas distinguish complete configuration from withheld public labels" validates a real
book starter with all eight labels as create/configuration input, rejects a missing input locale and an
unknown locale, accepts the public shell with `en` withheld, rejects unsafe public labels, and validates
a top-level common page plus Zone shell while rejecting nested `page`, `account` and private mount fields.
It also rejects a target naming both route and subject. This can pass before any Zone API/table/query
implementation exists. Shared `validateZoneStarter` plus resource-layer route validation still enforce
reserved `subjects`; the header split does not widen the inert composition validator.
