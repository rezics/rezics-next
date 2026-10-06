# Media owner

Media identity, upload/transform workflow and avatar/showcase selection live in Main's
Content PostgreSQL database under the `media` schema
(`services/content/migrations/070_media_owner.sql`). `typed-schema.ts` declares
the same tables for typed queries. Bytes live in the configured object bucket.
No semantic graph profile is added. Private uploads, alternative text and
selection history stay out of TDB2, where
[erasure](../../../../../docs/operations/erasure.md) would need a sanitized rebuild.

## Reused owners

| Concept | Reused record | Media use |
| --- | --- | --- |
| Asset revision anchor | `content.variant` + `content.revision` | Variant `urn:rezics:variant:<asset>` on resource `https://rezics.com/id/<asset>`, language `zxx` unless the image carries language. Model `media-asset-v1`; its manifest lists exact representations. The asset head is `content.variant.draft_head`, written by `ContentCore.saveDraft`. |
| Image-only publication body | `content.revision`, `content.publication_preparation`, graph `content-publication-v1` | Model `media-set-v1` lists ordered exact Use IDs with their asset revision, representation and SHA-256. The existing pin, graph decision (`rv:contentModel "media-set-v1"`) and Realm selection of that exact decision apply unchanged. No text document is created. |
| Receipts and positions | `content.receipt`, `content.owner_control` | Registered `media.*` actions. Every media command records a receipt; the Content sequencer numbers it after commit and the command returns that position. Media rows reference their receipt by operation, not by a copied position. |
| Outbox | `content.outbox` | One event per media receipt. Uses event types `media.*` and recipe `media-v1`. |
| Immutable guard | `content.no_mutation()` | Used for `asset_state`, `use` and `selection_revision`. |
| Object adapter | `S3ImmutableObjects` | Prefix `media/asset/<asset>/`. Quarantine key: `media-quarantine/<upload>`. |

Table shapes live in [typed-schema.ts](typed-schema.ts); lifecycle, exact Use
bases and activation fences live in the owner migrations and their tests.

## Width rendition lifecycle

[Showcase art](../../../../../docs/contracts/media.md#showcase-art) needs
responsive bytes for one authored crop, including transparent logos and cutouts.
The media owner calls
[requestUseRenditions](../media-rendition/request.ts) after admitting an exact
Use. Showcase selection calls it before sealing its admitted outcome. A retry
after a committed selection repairs interrupted queueing; a replaced, removed or
unavailable source needs no new work. It shares retained jobs across Uses of the same source
and crop, rather than creating another selection or asset revision.

Main runs the [rendition worker](../media-rendition/worker.ts) beside its existing
workers. Orientation is inspected before queueing because JPEG header dimensions
can address the wrong axes; [Sharp's oriented metadata](https://sharp.pixelplumbing.com/api-input/)
and [operation ordering](https://sharp.pixelplumbing.com/api-operation/) support
the orientation-before-crop pipeline. The versioned encoding and capacity choices
are in [policy.ts](../media-rendition/policy.ts). Tests exercise actual AVIF/WebP
alpha, crop and orientation output, child termination and database lease recovery.

Readers pass Uses whose targets they have already resolved through disclosure
and Access to `MediaStore.renditions.candidatesBatch`. Its URLs retain each
requesting Use, so sharing derived bytes never shares target authority.
The existing representation metadata/bytes route applies that Use's concealment
and the rendition's own exact edit basis. Until the rendition is labelled,
metadata derives its labels from the exact source representation. Missing or
pending renditions leave the candidate list empty;
selection readers can keep delivering their admitted original while work finishes.

Zone configuration saves request only newly referenced publication-item Uses,
after the graph commit and Access seal, as best effort. Dedicated campaign Uses
request renditions when created. Campaign delivery reads the originating Zone
from the retained creation event and checks its current public configuration,
slide schedule and reader-visible Work in one bounded check.

Interrupted transforms retry under the existing lease protocol. Byte persistence
holds the asset/source fence through settlement, so an erasure sweep cannot
finish before a late put recreates bytes. Unpublished bytes after a crash stay
inside the same asset namespace and follow its existing erasure sweep. Live
source availability, staff restrictions and exact-copy suppression remain the
delivery authority even after a rendition has settled. The integration test is
[media-rendition.test.ts](../../../../../tests/qa/integration/media-rendition.test.ts).

## Read contract for summaries

`summary.ts` resolves at most 64 references with one graph query (type, labels,
public disclosure and the graph generation), one Access query for the distinct
non-public Works and one media query. Realm names use one bounded Space owner
read for the batch. Character, Role and RelationDefinition state goes through
the semantic owner's exact current read after an Access check; Context state
goes through its disclosure-aware owner read. The latter owner reads currently
cost up to four and two graph queries per distinct reference, respectively,
and semantic Access checks cost one query per reference. They are included in
the response cost counters; a 64-item request is the hard bound. A projection
adds its parts: its subject and frames are summarized as ordinary references in
extra pages of 64 on the same graph generation, and its disclosure is the most
restrictive of theirs ([projections](../projection/README.md)).
`access-batch.ts` evaluates the current gate, principal, represented subject and grant under the Access recovery fence.
It takes the same share locks as `AccessAdmissionRegistry.canReadWork`; each
target needs only an indexed scope/grant probe, and no result is cached.
The media query probes the requested context, then
`urn:rezics:media:context:default`. That is at most two primary-key slot probes
per target, followed by joins to:

1. the head revision;
2. its use;
3. the asset state head;
4. the representation.

The requested context's slot wins even when it records a removal.

An image is returned only for a public, unsuppressed, active asset whose
original is available, has clearance `cleared`, has no exact-byte suppression marker, and is within the `avatar-selection-v1` rendition bounds:
2048 px and 4 MiB. It is served as-is. Classifier evidence does not determine clearance. The target resource must also be readable.

Missing selection, removal, an oversized rendition, and private,
suppressed, deleted or erased media all return the same fallback. It carries no
asset or use ID. The fallback key is derived from policy, readable resource type
and resource. Responses carry `generation.graph` and `generation.media` and are
served `no-cache`/`no-store`.

`GET /v1/media/avatars/{selection}` and `GET /v1/media/uses/{use}` re-derive every
check at request time. Valid replacements become deliverable immediately; NSFW and age metadata accompany the selected image. Explicit removal stops the preceding selection immediately.

## Operation template

| Operation | Route | Receipt action | Cost contract |
| --- | --- | --- | --- |
| Reserve upload | `POST /v1/media/uploads` | `media.upload.reserve` | 1 Access register and claim, 1 PG transaction (4–6 rows) |
| Upload status | `GET /v1/media/uploads/{upload}` | Read only | 1 Account verification, 1 Access principal read, 1 indexed PG upload/original lookup |
| Activate bytes | `PUT /v1/media/uploads/{upload}/bytes` | `media.upload.settle`, then `draft.save` | ≤ 8 MiB read once; 2 object creates and 1 read-back; 2 PG transactions; ≤ 4 CAS attempts |
| Asset state CAS | `POST /v1/media/assets/{asset}/state` | `media.asset.state` | 1 PG transaction; erasure updates the asset's representations |
| Avatar selection CAS | `PUT /v1/resources/{resource}/avatar` | `media.selection.change` | 1 summary read, 1 Access admission, 1 PG transaction |
| Showcase art/trailer CAS | `PUT /v1/resources/{work}/showcase/{art\|trailer}` | `media.selection.change` | 1 target summary read, 1 avatar Access admission, 1 PG transaction; an image adds one bounded object inspection and the rendition request |
| Zone campaign art | `POST /v1/zones/{id}/campaign-art` | `media.use.create` | 1 Zone/Realm graph probe, 1 Zone editor Access admission, 1 PG transaction, 1 bounded object inspection and ≤12 rendition requests |
| Showcase batch | `POST /v1/resources/showcase` | none | ≤ 64 targets, existing graph/Access summary batch without avatars, 1 media query; ≤ 12 candidates per selected image |
| Image-only body | `POST /v1/media/publications` | `media.use.create`, then `draft.save` | ≤ 16 items; 1 basis query, 2 PG transactions, 1 Access seal |
| Summaries | `GET /v1/resources/{id}`, `POST /v1/resources/summaries`, `GET /v1/public-previews/{id}` | none | 2 graph queries (lineage and batch), 1 media query, ≤ 1 Access batch query for ≤ 64 Works |
| Sitemap | `GET /v1/sitemap` | none | 1 graph query per page of 500. The keyset still orders all public Works, a scan over P |

Extension, for a new PG-owned media command:

1. Copy one `MediaStore` method: `prior`, then `receipt`, then owner rows in one
   transaction. Stale outcomes are written as `stale_head` receipts.
2. Register its action in a new `07x` migration via `content.receipt_action`.
3. Wrap it with `admitted()` in `commands.ts`.
4. Add the route in `routes/media.ts` or `routes/resources.ts`, with `mediaError`.
5. Test it the way `tests/qa/integration/media-api.test.ts` does:
   - denied with the scope gate present;
   - key replay and key conflict;
   - stale CAS with its receipt;
   - owner rows.
6. Add a lost-stage case to `tests/qa/fault-recovery/media-recovery.test.ts`.

## Showcase selection extension

[showcase-store.ts](showcase-store.ts) extends the same slot/revision/Use records
and CAS triggers in Content migration 770. Slot roles name landscape, portrait,
cutout and trailer; a logo role includes its canonical language and tone, so an
anchor is replaceable value rather than identity. The trailer revision carries
its URL and no Use. No graph-owned Work link or second media document is added.
All commands retain the avatar scope/action/receipt family. Stale receipts keep
the observed head in their outbox payload so later replay reports that same
outcome after subsequent writes.

The existing bounded child inspector reports orientation and alpha from exact
digest-verified bytes. Admission uses the rendition worker's
[pixel crop](../media-rendition/policy.ts), backed by the
[Media Fragments spatial selector](https://www.w3.org/TR/media-frags/#naming-space)
and [Sharp metadata](https://sharp.pixelplumbing.com/api-input/). The selected
Use keeps inspected oriented dimensions, crop and focal area. Ratio and minimum
resolution apply to cropped pixels, not the un-oriented container header.

`SHOWCASE_BATCH_SQL` performs two indexed context ranges per disclosed target,
then exact head/Use/source probes and at most twelve candidate probes per image.
Its cost is O(B log S + K·C log R), with B≤64, C≤12 and K the selected slots of
these Works, including every logo language; output is O(K·C). It never scans
selection history or makes per-target round trips. A requested role/key wins
even if removed or unreadable, leaving other keys free to use the default.
The representation byte route rechecks current selection membership for a
showcase Use, besides its existing target disclosure and exact byte clearance.
Both batch descriptors and metadata/bytes pass asset and Use references through
the shared media disclosure gate. These are pages of 64 policy targets, with
one graph head batch for the distinct owning Works; the batch's
`cost.disclosureQueries` reports those added policy pages separately.
The reused Access batch reader has one transaction for explicit private Work
grants. Its baseline-author fallback still calls `authorWorkGeneration` for each
remaining Work, adding per-Work SQL and graph proof round trips. The single
media query does not settle that broader disclosure-path cost.
The integration journey is [showcase-art.test.ts](../../../../../tests/qa/integration/showcase-art.test.ts).

## Required wiring outside this module

- **Access.** Media actions declare terminal families in `receipt-family.ts`. The
  admitted command seals its Content outcome in Access, and replay requires the
  retained owner receipt. `sealMediaAdmission` records or replays the cancellation
  fence for strong closure; no absent receipt is inferred to have succeeded.
- **Content relay.** `relayContentProjectionOnce` now acknowledges `media-v1`
  events in order without invoking text projection. Its `content-body-v1`
  publication path still needs a `media-set-v1` skip before image-only
  publications can be production-enabled.
- **Main entrypoint.** `services/main/src/index.ts` supplies `MediaStore`, the
  Access batch reader and a namespaced `S3ImmutableObjects` factory. Main now
  requires the configured RustFS bucket at startup for media operations.

## Ingress and scan boundary

The current upload path accepts authenticated direct bytes only, with an 8 MiB
cap, declared SHA-256, allowlisted raster MIME type and matching container header
and dimensions. It stages and reads back exact bytes through RustFS before
activation. The transfer path never fetches a caller URL or runs a transform.
Delivery uses the exact allowlisted image type and
`X-Content-Type-Options: nosniff`. Browser inference failures remain unknown and
can be corrected manually; the retained server classifier is available for a
future producer migration, but new originals do not queue it.

## Presentation labels and controls

`presentation.ts` binds the existing `EditorialFieldTarget` slot and exact
`EditorialControlBasis` to owner-local `field_slot`/`field_revision` records.
The protection transition uses the shared Open/review-required protocol in
`protection/field-control.ts`; protection is a revision reference, not a second
boolean lock engine. NSFW and age assessment attach to exact
Representations, including renditions. Until a rendition has its own value for
a field, metadata derives NSFW and age assessment from its exact source:
`nsfwSourceId` identifies the NSFW source, and age assessment uses `basis: source`
with `sourceId`. The rendition's edit/control basis remains its own. Explicit
unknown or unassessed values override derivation; labels never pass between
unrelated representations. Concealment attaches to an immutable Use occurrence, allowing
an ordinary image to be concealed independently of its NSFW label. No semantic
graph profile is introduced.

`POST /v1/media/metadata` accepts at most 64 representation/use or current avatar
selection references and returns ordered available/unavailable descriptors.
One SQL batch probes exact heads; target disclosure and Access remain enforced.
Raw classifier scores stay outside public descriptors. Readers receive NSFW,
age assessment, concealment and each field's exact value/control/protection
basis. The frontend combines these facts with viewer state; NSFW display defaults
to masking and does not imply an age assessment. Unassessed remains distinct
from General (the existing empty assessment-label set).

Editors use `POST /v1/media/representations/{representation}/labels` and
`POST /v1/media/uses/{use}/conceal` with the observed value head and control basis.
Platform administrators can correct, lock or unlock individual fields using the
existing pinned administrator proof and Access recovery/dispatch fences. Ordinary
editor authority and automated adoption cannot change a protected field. All
field writers serialize on the stable owner slot; a first concealment lock also
locks its Use so whole-document saves cannot race an absent slot. Content's
`guardDocumentImageUses` checks exact representation/occurrence/target bindings
and protected concealment during the existing draft transaction. It traverses
only this document's actual nodes and does not follow referenced content.

`POST /v1/media/representations/{representation}/inferences` records immutable
client evidence bound to the server-confirmed representation digest. The admitted
`image-nsfw-v1` policy validates complete finite NSFWJS scores, model/version and
weights digest and recomputes the submitted result. This records what the client
reported; it does not claim server execution. Only an unestablished, unprotected
NSFW field receives an automatic initial value. Manual unknown, manual labels,
platform corrections and locked values are never overwritten. Unavailable
inference records unknown evidence and changes no adopted label. Producer remains
explicit (`client` or future `server`), so moving inference to the backend does
not change the read/edit/control contract. The initial score thresholds still
need representative REZICS calibration.

## Clearance and identical copies

New originals activate after binary admission. Main's
`MAIN_REQUIRED_MEDIA_MATCHER` defaults to `none` in every environment; that mode
creates no pre-publication matching job or hold. Explicit `local:<path>` uses a
synthetic corpus supplied by development or tests and is refused in production.
`provider` reserves the approved deployment adapter; until supplied, it fails
as unavailable. A configured matcher admits a separate durable
`required-image-match-v1` job. Upload status stays `screening` with reason
`required-matcher-pending` until that job succeeds. The shared
[visibility gate](visibility.ts) permits the uploader's private use while
withholding every public read, including bare originals, renditions, summaries
and export. Matcher failures retain an expiring lease, and exhausted jobs roll
over without opening disclosure; a recovered matcher settles the exact source
and admits its requested public disclosure. Production has no fixture fallback.
The retained
`screening|cleared|held|rejected` upload shape remains compatible, but ordinary
read clearance ignores historical classifier holds and failures. Actual staff
rejection and exact-byte suppression still deny delivery. Neither NSFW nor age
assessment decides whether an ordinarily authorized API returns the image.

The same gate resolves all current attachments of an Asset even when a read
omits its Use. Every attachment must be readable to the caller; a second public
Use cannot widen a private draft's audience. Removed selection heads cease to
bind that audience. Each page performs one indexed Asset/Use owner read and
reads the distinct attachment targets through the existing summary/Access
policy in pages of 64. Work scales with these assets' retained Uses and matching
jobs, returning their current attachments without sampling or scanning unrelated
assets. Private delivery remains `no-store`,
including reads that name only a representation.

`suppressIdenticalCopies(originalDigest, after?, limit?, decisionBasis?)` appends an immutable
SHA-256 suppression before advancing at most 100 asset histories per call. Its asset
cursor continues large sets; repeating a call skips already suppressed assets.
Every delivery lookup checks suppressions without a lift, so unfinished batches cannot serve
copies. Later originals of the bytes activate rejected and suppressed without
queuing a classifier. There is no perceptual hash or cross-asset byte deduplication.

Content migration 740 gives each suppression its own identity. Only an NCII
reversal answering a retained appeal supplies the lift basis to `moderateOriginal`.
The append-only `suppression_lift` binds the suppression, case and upheld decision
to its Content receipt/outbox event in the same transaction. Replaying reconciles
that receipt before testing the saved asset state. `restoreIdenticalCopies` then
restores at most 100 eligible histories per call; it leaves other staff decisions,
actual staff rejection and deleted/erased assets alone. A later suppression has a new
identity, so the previous lift cannot admit newly restricted bytes. Preservation
holds still prevent erasure. All MediaStore receipts use `advanceContentSequence`; positions come from `settledContentPosition` after commit.

| Internal operation | Bound and lookup |
| --- | --- |
| Lease/cancel/exhaustion recovery | One job per indexed ready/expired queue probe; one source and asset lookup; 5-second PG statement deadline |
| Screen settlement | One asset, token-fenced job, receipt, outbox and immutable result; no fan-out writes; delivery resolves each slot through primary-key probes |
| Review intake retry | At most eight jobs per tick through pending retry index; one governance case/report/evidence transaction per job |
| Staff clearance | One original CAS, decision, receipt/outbox and no avatar-slot fan-out |
| Copy suppression | One digest marker plus at most 100 distinct asset probes/state histories; digest-and-asset index, returned continuation |
| Appeal lift / copy restoration | One exact suppression and receipt/outbox; digest lock plus at most 100 distinct asset probes/state histories, returned continuation |

## Recovery obligations

- **Upload activation.** A conditional create accepts identical bytes. The
  activation operation ID is derived from the upload, so replay resolves through
  its receipt.
- **Activated original with no asset revision.** Reconcile with
  `saveDraft` under operation `media-asset-revision:<upload>`.
- **Erasure.** After the state becomes erased, a sweep marks representations
  `erased` and deletes the asset namespace plus quarantine keys. Asset revisions
  follow the Content erasure procedure.
- **Content projection.** The relay acknowledges `media.*` events. It must also
  skip text projection for a `media-set-v1` publication.
- **Orphans.** Expired reservations are reclaimed through
  `upload_reserved_expiry_idx`.
