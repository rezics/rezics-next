# Zones

A Zone is an owner-controlled routed site over saved catalogue scopes and mounted Collections. It uses the
one catalogue, the one Collection model and the common composition renderer. It is neither a Realm nor a
Space, grants no rights in its sources, and creates no vertical-specific backend. This document owns the
first public Zone resource, lifecycle and page-read contract under [scope](scope.md) and [deletion](deletion.md).
The eight `packages/definitions/presentation/*/zone.json` starters are inert input data. They instantiate
nothing until a person submits a create command; subsequent definition releases never rewrite a Zone.

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
type Navigation = { route: string }[];
type ZonePublic = {
  id: UUID;
  revision: Revision;
  labels: ZoneStarter['labels'];
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
The eight required label keys are `en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr`, `es`; selecting one does
not change the labels envelope. Labels are safe nonempty plain text, at most 80 code points each. A configured
route has no `view`; a subject has no `route`; account targets are not Zone targets. Bodies with extra keys,
invalid targets or reserved configured routes fail with 400 `invalid_request` and existing RFC 6901 field
errors. Shared validation violations map `limit` to `out_of_range`, and the remaining composition violations
to `invalid_format`, prefixed with `/configuration`. Unknown envelope fields use `unknown_field`.

| Method and native path                          | Body and success                                             | Authority                                                                |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `POST /v1/zones`                                | `CreateZone` → 201 `ZoneResponse`, Location `/v1/zones/{id}` | `zone:create` on Global Context; authenticated                           |
| `GET /v1/zones?limit=&cursor=&deleted=`         | 200 `ZoneList`                                               | caller's own Zones only; authenticated `zone:read` per returned resource |
| `GET /v1/zones/{id}`                            | 200 `ZoneMetadataResponse`                                   | `zone:read`, public exposure                                             |
| `GET /v1/zones/{id}/configuration`              | 200 `ConfigurationResponse`                                  | `zone:configure` or recorded owner's `zone:read`; authenticated          |
| `PUT /v1/zones/{id}/configuration`              | `ConfigureZone` → 200 `ZoneResponse`                         | `zone:configure`; authenticated                                          |
| `POST /v1/zones/{id}:publish`                   | `PublishZone` → 200 `ZoneResponse`                           | `zone:publish`; authenticated                                            |
| `POST /v1/zones/{id}:readPage`                  | `PageRequest` → 200 `ZonePageResponse`                       | `zone:read`, public exposure                                             |
| `GET /v1/zones/{id}/subjects?limit=&cursor=`    | 200 `{subjects,next}`                                        | `zone:read`, current source Access                                       |
| `GET /v1/zones/{id}/collections?limit=&cursor=` | 200 `{collections,next}`                                     | `zone:read`, current source Access                                       |
| `DELETE /v1/zones/{id}`                         | no body → 200 `ZoneResponse`                                 | `zone:delete`; authenticated                                             |
| `POST /v1/zones/{id}:restore`                   | `{}` → 200 `ZoneResponse`                                    | recorded owner and current `zone:restore`; authenticated                 |
| `POST /v1/zones/{id}:takedown`                  | `Takedown` → 200 `ZoneResponse`                              | `moderation:takedown`; authenticated                                     |
| `POST /v1/zones/{id}:releaseTakedown`           | `ReleaseTakedown` → 200 `ZoneResponse`                       | `moderation:takedown`; authenticated                                     |
| `POST /v1/platform/zones/{id}:purge`            | `Purge` → 200 `{id,state:'purge_pending'}`                   | `zone:purge` on existing Platform resource                               |
| `POST /v1/platform/zones/{id}:hold`             | `{reason:string}` → 200 `{id,held:true}`                     | `zone:purge` on Platform                                                 |
| `POST /v1/platform/zones/{id}:releaseHold`      | `{}` → 200 `{id,held:false}`                                 | `zone:purge` on Platform                                                 |

The last three routes are platform-exposed, never owner privilege or anonymous privilege. An early purge
requires that separate action/path even after an ordinary delete. An order reference is required to purge
an active record; an early deleted-record purge may omit it. A hold blocks both automatic and requested
purge until explicitly released. Reasons/complaints are safe plain text of 1–2,000 code points, order
references 1–255; they are confidential moderation evidence, never part of public metadata or events.
Every route declares its action, exposure and resource types. Resource type is `semantic.zone`, except
parent create authorization on the existing Global Context and platform actions on Platform.

`subjects` and `collections` reuse the current owning APIs' safe summary item schemas, with no total or
source-count field. Limits are integers 1–24, default 24. These envelopes, canonical member ordering,
deduplication, freshness witness and continuation semantics belong to the independent Zone query contract;
this document does not choose a query algorithm. Its implementation must provide an anchored eligibility
probe for subject targets and bounded pages for these two routes before those paths can land. Do not
implement scans or an unreviewed query engine to fill this dependency. Refer also to
[dynamic Collections](dynamic-collections.md) and [library query research](research/library-query-bulk.md).

## Configuration, publication and Access

Creation authorizes the parent before touching the new partition. Allocate a routed Zone ID and copy the
validated configuration plus at most 16 distinct Collection IDs. The creating actor is the owner. Parent
creation authority is not a permanent right to edit other Zones. In the same Zone command partition,
initialize the ordinary `semantic.zone.owner` resource role using the existing resource grant initializer.
Its actions are `zone:read`, `zone:configure`, `zone:publish`, `zone:delete`, `zone:restore`, `access:grant`.
There is no implicit owner shortcut in Access. A delegated editor needs explicit ordinary resource grants;
configure grants do not imply publish, delete, restore or rights in mounted data. No standing role grants
private Zone read or create to anonymous users. Ordinary Global Context grants control create admission;
this scope does not change registration defaults or auto-enable create for every account.

`private` is read only with a current resource grant. `unlisted` and `public` permit anonymous direct read
under the existing public resource eligibility formula. Only `public` is eligible for discovery/sitemaps;
unlisted direct links remain readable. A suspended account is refused with 403 even if the same URL is
anonymously readable. Invalid credentials return 401; they never silently downgrade to anonymous.
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

## Deletion, restoration, withholding and durable cleanup

Delete is soft deletion at authoritative domain time T. Set `deleted_at=T`, `restore_until=T+30 days`,
retain the previous visibility for restoration, suppress all public and owner page/metadata reads immediately,
remove discovery eligibility, and leave tombstones in referring systems. The owned deleted listing and
configuration route may return the owner's tombstone and retained configuration inside the window; editor
read/configure grants alone do not bypass deletion. Restore is available only to the recorded owner with
current `zone:restore` and T strictly before `restore_until`; exactly at the deadline it returns 409
`conflict` even if cleanup has not run. Restoration preserves configuration and prior visibility. A purged
or unknown resource returns 404. Delete does not delete a mounted Collection, catalogue subject or grant
in another resource. Account erasure must enqueue the same Zone payload cleanup under its existing barrier.

After the window, bounded durable work automatically purges personal/private payload with no platform
permission or manual action. Remove configuration/documents, labels, mounts, owner/author links and resource grants, historical
payload and payload-bearing receipt responses. Events/audit retain identifiers and decisions only; no
page text, original labels, complaint contents, owner link or private source references survive in evidence
past the window. Prefer command receipts that contain only nonpayload outcome references from the outset;
cleanup must also scrub any responses that originally contained labels. A replay after the window cannot
resurrect or disclose the erased response. Previously publicly readable (public or unlisted) Zones keep only a nonpersonal ID/type,
revision, deletion/tombstone state and nonpersonal relation/count skeleton. Always-private
sites have a personal skeleton (it reveals a private site/owner relationship): erase their whole Zone row.
Do not preserve private mount edges under the name of relations. Whole-row erasure is this narrow exception,
not the general purge algorithm. Purged public tombstones retain no owner authorization link.

Legal holds suspend cleanup without changing restore deadlines. Purge requests before the window, and
legal-order purges of active data, use the separate Platform route; default delete accepts no purge flag.
Requests commit durable intent; workers recheck a current hold immediately before each destructive batch.
An unheld automatic batch needs no actor admission; its authority is the committed deletion and deadline.
Failures resume from a sealed source-key continuation. Count examined keys before eligibility/hold filters,
so a page of held keys cannot cause an unbounded scan. A batch examines at most `limit` source keys plus
one lookahead; `limit` is 1–100. It must advance past held/ineligible keys while preserving a durable retry
for holds/deadlines. Completion and per-key effects are idempotent under worker replay and CAS races.

Takedown is separate least-field withholding, never deletion. `fields` has 1–16 unique RFC 6901 pointers
into configuration: a label, a page text field, a whole page document, or `""` for the whole resource only
when nothing smaller serves the notice. Validate existence and allowed field types before committing.
Store original data unchanged with separate withholding decisions. Covered text renders as empty safe text;
a withheld document/page is omitted from navigation and answers 404, and a covered label is omitted from
public labels (the public label map may therefore have fewer than eight keys during withholding). Other
labels/pages/fields remain readable. Whole-resource withholding answers the normal 404. Never return the
covered original through public document, navigation, search, metadata, receipt or audit endpoints. Owner
configuration is restricted evidence; ordinary read grants do not reveal withheld originals. Releasing the
same pointers removes only those decisions and reveals retained data again. Takedown leaves `state=active`,
`deleted_at=null`, `restore_until=null`, schedules no destructive work and starts no 30-day clock.

## Storage seams, bounds and implementation splits

Production work belongs in `services/kernel/src/zones/` (`http.ts`, `contract.ts`, `commands.ts`, `reads.ts`,
`eligibility.ts`, `purge.ts` and colocated SQL) and `services/kernel/db/zones/` with additive migrations.
Use Zone-home keyed state and page heads, not a vertical table. The raw-effect acceptance seam is
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

| Independent task  | Files/callsites and required handoff                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header/ABI first  | Add `zones/contract.ts` code-first schemas/types from this document; expose the common page response schema without changing `/v1/pages:read` behavior. This unlocks Web/client typing.                                                                 |
| Resource commands | Add Zone migration, commands and HTTP metadata/configuration/create/publish/CAS; compose `src/http/kernel.ts`, `src/http/write-rate-routes.ts`, Access resource roles/action declarations and schema derivation. Parent initializer is mandatory.       |
| Routed page read  | Add Zone read/eligibility and reuse presentation `planReads`/`readPage`, credential/session forwarding and profile lookup. Preserve existing routes and renderer. Depends on query eligibility probe, not on lifecycle worker.                          |
| Lifecycle         | Add delete/restore/withholding and bounded `purge.ts`/worker registration, account-erasure adapter, receipt/evidence scrubbing and platform authorization. Depends on resource commands, not on Web.                                                    |
| Native growth     | Exercise fixed reads at 64/512/4096 unrelated Zone/page/history scales through unchanged shared growth capture; constant rows/statements and logarithmic blocks. Add bounded cleanup pages with held/ineligible keys, real CAS races and retry effects. |

Read cost touches Zone-home metadata and current page points, at most 16 shared reads/cost 128, and separately
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
