# Collection presentation and editor

This page owns the joint Collection presentation and editor contract. It selects additive fields and operations;
it does **not** claim runtime, generated API or UI delivery. [Library and Collections](library-and-collections.md),
[Dynamic Collections](dynamic-collections.md), [Collection source](collection-source.md),
[Filtered lists](filtered-lists.md), [Scope](scope.md) and [Deletion](deletion.md) retain membership, admission,
privacy, cost and lifecycle authority. Existing scope defers user-saved dynamic execution; the editor requirement
below introduces selected work, not evidence that the deferred runtime or publication machinery exists.

## Model and definitions

Collection `presentationKind` is a definitions TypeId, never a fixed vertical enum, Concept/public tag or private
Label. Members keep their own actual Type. An owner override wins; null requests auto derivation. Presentation
changes no membership, profile pin, query predicate, source authority or permission. Grid/list/table remain client
layout choices. The Collection kind guides Collection presentation; each member still uses its own Type's hints.

The selected release field is exactly:

```ts
Release.types[typeId].listPresentation?: {
  imageAspect: 'portrait' | 'landscape' | 'square';
  keyFacts: string[];
}
```

`portrait` means 3:4, `landscape` 16:9 and `square` 1:1 for list/card frames. `keyFacts` is an ordered unique array
of 0–4 effective property CURIEs of that Type. They are property identifiers, not formatter functions, JSON paths,
private Library facts or labels. Existing localized property/value labels and unit metadata supply wording.
The nearest explicit base supplies the **whole object**, replaced as a whole by a nearer explicit declaration;
an explicit `keyFacts: []` clears inherited facts. The compiler emits the effective object on every applicable
Type, so clients do not traverse ancestors. Unknown fields, image ratios, unknown/out-of-Type properties and
duplicate keys fail compilation and release validation. Older releases without the object remain valid.
Existing `coverRatio`, stored media dimensions, cover metadata and accepted personal profile semantics stay intact.

Until actual generated handoff, Web treats new fields as additive/optional and uses an explicit exact-Type
fallback: `schema:Book`, `bf:Instance`, `schema:ComicSeries` and `schema:PublicationVolume` use portrait 3:4;
`schema:Movie`, `schema:TVSeries`, `schema:TVSeason`, `schema:Episode`, `rezics:AnimeRelease` and `schema:Recipe`
use landscape 16:9; `schema:MusicAlbum` uses square 1:1. Other Types use their existing valid `coverRatio`,
otherwise square 1:1. Do not infer a vertical from a label or
substring. A missing or retired Collection kind uses this member-Type fallback; it never converts member Types.
Facts remain absent without a delivered producer; no guessed author, runtime, episode or page count fills a row.

## Collection kind reads and writes

Selected list/detail read fields:

```ts
presentationKind: string | null;
presentationKindSource: 'owner' | 'members' | 'empty' | 'pending';
```

POST and PATCH accept optional `presentationKind: string | null`. Absence preserves an existing override on PATCH
and defaults to auto on create; null clears the override to auto. PATCH retains the **required current numeric
revision** and native `collection:update` authorization. A newly selected override must name a Type actually
present in the current release. If a later release lacks a stored choice, retain it as presentation data with
source `owner` and render the explicit fallback. An override requires no membership sweep.

Auto selects the most frequent actual Type among the **complete current admitted canonical visible members**,
counting each canonical subject once. Duplicates remain separate curated editor occurrences, never extra votes.
Ties use ascending exact TypeId order. Never sample the first page or three preview thumbnails, or infer a winner
from partial/private/hidden rows. Source `members` means a complete proven winner. `empty` proves no eligible
members. `pending` means complete observation/repair is unavailable and `presentationKind` is null.

Derived observations bind the actual Collection source generation, complete selective query dependencies and
current original **and** terminal disclosure. Native bounded repair/preparation and maintained observations must
replace synchronous full-table/group scans per GET, stale cached winners or global job gates. List/detail GET
remain pure under the Library contract; only the already authorized common-members preparation boundary may
start retained work. Different viewers may receive different derived kinds because their eligible members differ;
no hidden Type or curator-private count oracle is exposed. This native derivation is missing today.

## FULL member key fact values

Existing Semantic `SubjectSummary` has no facts. The selected common FULL member response may add optional
`facts: Record<PropertyId, Fact[]>` **beside** `subject`, using the member's own Type's effective `keyFacts`.
Reuse the actual `Fact` union in `services/kernel/src/search/hits.ts`:

```ts
type Fact =
  | { kind: 'item'; id: string; labels: Record<string, string> }
  | { kind: 'time'; year: number }
  | { kind: 'quantity'; amount: number; unit: string }
  | { kind: 'code'; value: string };
```

At most four configured properties and three actual values per property are returned. Hints are not data.
Absent `facts` means capability not delivered or not requested; `{}` means a complete visible no-facts outcome.
A null subject or denied entry stays concealed, without sibling facts leaking its contents. Unproved requested
fact readiness returns standard 503, never a false empty map. No browser per-row subject-detail requests.

The selected **new, not callable yet** Semantic helper in `semantic/list-presentation.ts` is:

```ts
readListPresentationFacts(
  deps: { pool: Pool; access: Access; actor: Actor; routeKey: Uint8Array; deadline: number },
  originals: readonly string[],
  options?: { languages?: readonly string[] },
): Promise<Map<string, { id: string; facts: Record<string, Fact[]> } | null>>
```

One bounded server batch accepts at most 100 ORIGINAL IDs. The map is keyed by original; returned `id` is the
actual terminal. Commerce verifies equality with the member's current terminal identity before projection.
Semantic owns the native producer and current original/terminal/source/related-item authorization and field/tuple
fences. Neither index nor fact cache supplies authority. Commerce owns FULL integration and final currentness.
Existing raw-key/source budgets remain intact; enrichment is explicitly charged, never free hydration.

## Existing-media Collection cover reference

Create/PATCH select optional `coverMediaId: string | null`; null clears the configured cover, absence preserves
on PATCH or defaults to no configured cover on create. This references only an existing available imported cover
under its original media subject/container. No Collection upload, container, claim or arbitrary-image picker is
delivered. Selection validates actual current editor/native media authority; Collection access grants no media
visibility, ownership or retention rights.

Use actual Content `checkMediaObject`/`checkMediaObjects` in `content/cover-reference.ts` as low-level reference
facts, plus `decideDownload` from `content/media.ts` with the real viewer Actor, Access, pool, trusted routeKey
and deadline in the native download context and the real trusted clock. Select an actual returned AVIF or WebP variant, never original.
Each read independently rechecks current media/container, tuple, source and variant rights. Release Collection
checkout before visiting a foreign media home and retain Collection final disclosure/currentness checks.

Selected read fields are optional `cover: CoverSummary | null` (the existing Semantic descriptor) and
`coverSource: 'owner' | 'member' | 'none' | 'pending'`. A chosen currently readable cover wins; otherwise use the
first current admitted member's authorized readable cover in actual member order. Skip members with no readable
image; do not use a cached hidden first row. Complete absence yields null/`none`; incomplete fallback search yields
null/`pending`, never fabricated empty. The authorized owner editor may receive its stored `coverMediaId`; public
reads disclose only an actually authorized descriptor. Never return storage keys, original URLs or external image
URLs, or invent source, credit, container or retention claims. The existing served-media ID+variant path owns bytes.

## Editor endpoints and delivery inventory

The table separates current dev operations from selected missing runtime. Existing write idempotency, native
current grants and response envelopes remain; selected additions do not make the current closed schemas accept them.

| Endpoint and body | Existing dev | Missing runtime / selected result |
| --- | --- | --- |
| `POST /v1/collections {title,description?,visibility}` | Metadata create, `201 {collection}` | Optional `presentationKind`, `coverMediaId`; dynamic create below |
| `GET /v1/collections?curatorAccountId=...` and `GET /v1/collections/{collectionId}` | Paged list and detail | Kind/cover projections above |
| `PATCH /v1/collections/{collectionId} {revision,title?,description?,visibility?}` | `200 {collection}`, required numeric revision | Optional `presentationKind`, `coverMediaId`, same current authorization/CAS |
| `POST /v1/collections/{collectionId}/members {subjectId,note?,after?}` | `201 {member}` | Current parent revision/lifecycle integration |
| `PATCH /v1/collections/{collectionId}/members/{memberId} {note}` | `200 {member}` | Current parent revision/lifecycle integration |
| `DELETE /v1/collections/{collectionId}/members/{memberId}` | `204` | Current parent revision/deletion headers and exact Undo are in-flight, not delivered |
| `POST /v1/collections/{collectionId}/members/{memberId}:move {after}` | `200 {member}`; intra-Collection reorder | Not cross-Collection transfer; current parent CAS/lifecycle integration remains required |
| `POST /v1/collections/{collectionId}/members:batchRemove {revision,memberIds}` | Absent | `200 {collection,removed:[{memberId,deletionId,revision}]}` |
| `POST /v1/collections/{collectionId}/members:move {revision,memberIds,destinationCollectionId,destinationRevision,after}` | Absent | `200 {source,destination,members}` |
| `POST /v1/collections {membershipKind:'dynamic',title,description?,visibility,rule:{filter,sort?},presentationKind?,coverMediaId?}` | Absent | Saved-dynamic create, `201 {collection}` |
| `PUT /v1/collections/{collectionId}/rule {revision,filter,sort?}` | Absent | `200 {collection}` |

All curated editing preserves occurrence IDs, notes, added times and duplicates, existing ordinal bounds,
parent CAS, replay and current grants. Consume the sole actual member lifecycle implementation once it lands;
its selected parent revision/deletion headers and exact Undo are not evidence of current delivery.

### Batch removal and cross-Collection move

`memberIds` is a distinct array of 1–100 occurrence IDs for both new batch commands. Batch remove uses current
native parent CAS in one atomic owning-partition command. A foreign or missing member returns 404 with no effects;
stale revision returns 409. Preserve exact 720-hour retained deletion, Undo and source-count semantics. No hard-delete
substitute or swallowed failure. Reuse the same actual lifecycle producer after it lands.

Batch move requires two distinct live curated Collections of the **same curator**, hence the same owning route.
Authorize both current updates and compare both revisions. Preserve member IDs, notes, `addedAt` and selected source
relative order regardless of request ID order. Place the block after the destination occurrence `after`, or first
when `after: null`. Respect the destination 5,000-occurrence cap and existing ordinal/respace constraints.
One same-partition transaction owns both sides; no cross-home join/write. Cross-curator transfer returns explicit
409 unsupported. This is neither same-Collection reorder nor silent copy+delete. Copy no scopes or grants.
Source/destination visibility-dependent membership, counts, public listing and fact generation effects change
exactly once through actual native producers; rollback and receipt replay leave no partial or repeated transfer.

### Dynamic editor boundary

Dynamic rules use shared `FilterDocument` and its admitted sort, never another Boolean language. Logical
Everything/state/Liked identities and rules stay immutable; member edit commands return 409
`dynamic_membership_immutable`. A saved dynamic ID is an ordinary created Collection, never a rewritten built-in.
Its rule is visible only to an authorized owner/editor, never in public DTOs or URLs.

Rule create/update require native current family scopes/gates, admitted indexed plans, complete dependencies,
bounded retained preparation and current disclosure. Public membership requires explicit complete Publication and
current subject disclosure; never evaluate curator-private facts for public readers. Pending/unbuilt dynamic
sources cannot report exact counts as zero. Existing dynamic DTO count omissions remain in force.
The current scope and dynamic owner docs defer user-saved runtime. This selected editor requirement introduces
work before that execution is delivered; it does not amend scope gates, invent publication execution or relax
Collection-source contracts. Broader scope activation remains a coordinating product decision.

## Current source inventory

- `services/kernel/src/library/collection-model.ts` has title, description, visibility, count and revision;
  no presentation or cover fields. `collection-routes.ts` exposes metadata/member/reorder operations, not the
  selected bulk transfer/removal or saved-rule editor. `collections.ts` owns native commands and the 5,000 cap;
  `collection-reads.ts` projects current metadata/member reads without kind/cover enrichment.
- `packages/definitions/src/index.ts` (`TypeDefinition`), `src/compile.ts` and `schema/release.json`
  (the release schema) have no `listPresentation` today. The names above are selected contracts, not released types.
- `services/kernel/src/semantic/summaries.ts` and `semantic/http/summaries.ts` define `SubjectSummary` with
  id/type/types/label/creativeWork/cover, no facts. `services/kernel/src/search/hits.ts` has opt-in facts;
  that existing Search capability is not a Collection FULL producer. The new helper is not implemented.
- Content's imported-cover reference facts and download authorization exist; their combined Collection integration
  does not. Unrelated stubs establish no saved dynamic editing, cross-Collection move, bulk remove or Collection
  upload capability. New fields stay optional for Web until actual generated API handoff.

## Ownership and required proof

Semantic owns whole definitions/compiler/schema/configuration/release delivery and native fact batch producers.
Commerce owns whole kind/cover/FULL projection and editor mutation/rule slices. Content owns native image authority.
Web owns one actual Collection browse/editor, the independent renderer, screenshots and visual review. No path-only
serialization or duplicate writers replace those whole producers. A source/type document or scoped test proves
neither full native/API/UI delivery nor integrated root/main behavior.

Required outcomes include owner, other account, anonymous and suspended credentials; hidden original/member and
terminal; Type ties and changes; override/clear and retired Type fallback; denied cover and current ordered fallback;
CAS, receipt replay, batch rollback, destination cap and cross-curator rejection; active/removal/Undo/public-source
changes and terminal no-resurrection. Suspension uses actual invalidated bearer behavior under Library authority.
Native growth evidence uses 1/8/64 homes, extending to 4,096 where the existing source/dependency contract requires,
with unrelated population/history, duplicates and identity churn. These are future implementation acceptance
obligations; this documentation acceptance proves publication of the joint contract only.

## Cost

Existing Cost authorities and allowances remain unchanged. Fixed request/output caps below do not promise physical
bounds: each implementation must produce native inclusive receipts/captures for rows, removed rows, statements,
buffers, connections, keys, bytes, engine work and control probes. Charge actual worker, receipt, outbox, repair,
replay, custody and minimization work, not only the visible response or a hidden callback/planner estimate.

### Metadata/cover read and write

- Touches: Collection metadata/source/current grant and account probes; configured media and ordered member-cover
  candidates; actual Content reference/download/variant/tuple-source probes, final currentness; write receipts/events.
- Bound: existing raw pages cap at 100; preview emits at most 3 members, never a complete observation. Media reference
  batches are 1–256 natively, not an allowance increase. Release Collection before foreign homes. Incomplete ordered
  cover search stays pending under admitted source budgets; no synchronous scan of all 5,000 members to find an image.
- Growth check: 1/8/64 homes through applicable 4,096-home dependencies, denied/late readable covers, privacy changes,
  first/deep preview pages and unrelated history; include foreign visits, write rollback/replay and native receipts.

### Complete dominant kind

- Touches: actual source generation, canonical admitted Type support, complete selective dependencies,
  original/terminal disclosure and bounded native observation repair/preparation and custody.
- Bound: owner override needs no sweep; derived kind needs complete maintained evidence, never raw100/three-preview
  sampling, full-table/group scans per GET or a global job gate. Curated cap 5,000 is not a read-time scan allowance;
  native steps and total finite work stay within existing source admission and Cost, without private read-time counts.
- Growth check: native 1/8/64 up to applicable 4,096 homes, ties/duplicates/hidden types, Type/source changes,
  excluded dependencies and disjoint identity churn; prove useful settlement and charge every repair/worker step.

### FULL fact batch

- Touches: one Semantic server batch over original IDs, actual terminal/type/release/property facts,
  related-item labels, native source/field/tuple Access and final currentness, including discarded enrichment.
- Bound: at most 100 originals, 4 configured properties each and 3 actual values each; these bound output, not
  examined native work. Charge all related-item/foreign probes under existing raw-key/source/page budgets;
  release before foreign-home visits. No per-row detail hydration, permission cache or allowance change.
- Growth check: native 1/8/64 through applicable 4,096 dependencies, unrelated facts/history, denied related items,
  original-to-terminal changes and readiness; capture inclusive probes/bytes and verify no fabricated empty facts.

### Selected batch remove/move

- Touches: one owning-partition command, one or two current parents/grants/CAS, 1–100 selected occurrences,
  ordinal neighbors/respace, retained deletion/Undo and actual count/listing/source/fact producers, receipts/events.
- Bound: distinct IDs 1–100; same-curator route only; destination cap 5,000 and existing ordinal bounds. Account
  for any native respace and lifecycle retention/custody work rather than claiming only 100 touched rows. Both
  parents and all producer effects commit atomically; receipt replay adds none, and failures roll back all work.
- Growth check: native small/full-cap Collections, 1/8/64-home unrelated population through applicable 4,096-source
  dependencies, CAS races, partial invalid selection, capacity/ordinal failure, replay and exact Undo/public effects.

### Saved dynamic rule

- Touches: native Collection/rule and editor scopes/gates, shared filter/release admission, complete source and
  disclosure dependencies, retained preparation/work intents, actual Publication and lifecycle/custody producers.
- Bound: existing admitted indexed source plans and page/raw100/three-preview output limits apply in their own units;
  no full-account synchronous evaluation, second Boolean engine, free workers or new allowance. Charge all rule
  invalidation, preparation, receipts and retained-copy cleanup; pending is not zero and public reads use complete output.
- Growth check: native 1/8/64 through applicable 4,096 homes, sparse rules, private fact changes, complete A/pending B,
  crash/replay, source revocation and terminal cleanup. Require finite retained progress and current safe disclosure.
