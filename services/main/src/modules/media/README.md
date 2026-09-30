# Media owner

Media identity, upload/transform workflow and avatar selection live in Main's
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
| Receipts and positions | `content.receipt`, `content.owner_control` | Seven new `media.*` actions. Every media command takes one Content position. |
| Outbox | `content.outbox` | One event per media receipt. Uses event types `media.*` and recipe `media-v1`. |
| Immutable guard | `content.no_mutation()` | Used for `asset_state`, `use` and `selection_revision`. |
| Object adapter | `S3ImmutableObjects` | Prefix `media/asset/<asset>/`. Quarantine key: `media-quarantine/<upload>`. |

## Tables and invariants

- `asset`: identity, owner, one object namespace per asset, and a `state_head`.
  Retention domains never deduplicate across assets. Identity is immutable, and
  the head moves only to a recorded successor.
- `asset_state`: append-only CAS history of `private|public` disclosure,
  `none|suppressed` moderation and `active|deleted|erased` lifecycle.
  Deletion and erasure advance `erasure_epoch`. `erased` is terminal.
- `upload`: reservation bound to the asset's current erasure epoch. It has an
  expiry of at most one day and a declared type/size/digest. The only way to
  reach `activated` is the matching original representation insert. Expiry
  requires the reservation to have lapsed.
- `representation`: activated exact bytes; immutable except
  `available -> erased|unavailable`. An original activates only an unexpired
  reservation at the current epoch with the declared bytes. A rendition needs its
  job's `succeeded` settlement from the same operation. There is one available
  rendition per `(source, profile, crop)`.
- `transform_job`: binds input digest, profile, crop, authority epoch and erasure
  epoch. A lease replaces only an expired lease and rotates the token. Success
  needs the held, unexpired token at the current epoch.
- `use`: immutable attachment of an exact `media-asset-v1` revision and a
  representation listed in its manifest to a target, context and role
  (`avatar`, `publication-item`). The crop is a percent `xywh` media fragment.
- `selection_slot` and `selection_revision`: the avatar head per
  `(target, context, 'avatar')` under policy `avatar-selection-v1`.
  - A NULL expected head is explicit.
  - A revision whose use is NULL records removal.
  - FKs keep a selected use on the slot's own target, context and role.
  - The slot head moves only to a successor of the current head.

## Read contract for summaries

`summary.ts` resolves at most 64 references with one graph query (type, labels,
public disclosure and the graph generation), one Access query for the distinct
non-public Works and one media query. Realm names use one bounded Space owner
read for the batch. Character, Role and RelationDefinition state goes through
the semantic owner's exact current read after an Access check; Context state
goes through its disclosure-aware owner read. The latter owner reads currently
cost up to four and two graph queries per distinct reference, respectively,
and semantic Access checks cost one query per reference. They are included in
the response cost counters; a 64-item request is the hard bound.
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
2048 px and 4 MiB. It is served as-is. The local screen uses `transform_job` under profile `image-screen-v1`; no image rendition transform runs. The target resource must also be readable.

Missing selection, removal, a pending or oversized rendition, and private,
suppressed, deleted or erased media all return the same fallback. It carries no
asset or use ID. The fallback key is derived from policy, readable resource type
and resource. Responses carry `generation.graph` and `generation.media` and are
served `no-cache`/`no-store`.

`GET /v1/media/avatars/{selection}` and `GET /v1/media/uses/{use}` re-derive every
check at request time. A replacement keeps the preceding cleared selection deliverable until its exact original clears. Explicit removal stops the preceding selection immediately.

## Operation template

| Operation | Route | Receipt action | Cost contract |
| --- | --- | --- | --- |
| Reserve upload | `POST /v1/media/uploads` | `media.upload.reserve` | 1 Access register and claim, 1 PG transaction (4–6 rows) |
| Upload status | `GET /v1/media/uploads/{upload}` | Read only | 1 Account verification, 1 Access principal read, 1 indexed PG upload/original lookup |
| Activate bytes | `PUT /v1/media/uploads/{upload}/bytes` | `media.upload.settle`, then `draft.save` | ≤ 8 MiB read once; 2 object creates and 1 read-back; 2 PG transactions; ≤ 4 CAS attempts |
| Asset state CAS | `POST /v1/media/assets/{asset}/state` | `media.asset.state` | 1 PG transaction; erasure updates the asset's representations |
| Avatar selection CAS | `PUT /v1/resources/{resource}/avatar` | `media.selection.change` | 1 summary read, 1 Access admission, 1 PG transaction |
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

## Required wiring outside this module

- **Access.** `recordGraphOutcome` knows no receipt family for `media.upload`,
  `media.manage` or `media.avatar`, so these admissions stay `claimed` after the
  owner outcome, and strong closure of a media scope reports them pending.
  - Register the families `media-upload`, `media-state` and `media-avatar` in
    `access/admission.ts`.
  - Dispatch `sealMediaAdmission` in `work/strong-revoke.ts`.
  - The owner side, including the fence receipt and replay, is implemented and
    tested.
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
The separate [local screen](../media-screen/worker.ts) decodes with pinned sharp
and classifies downscaled pixels with NSFWJS on CPU. Delivery uses the exact
allowlisted image type and `X-Content-Type-Options: nosniff`.

## Clearance and identical copies

Originals activate with `screening`. The existing upload resource gains a status read so polling does not retransmit up to 8 MiB of bytes; only the reserving principal can poll
`GET /v1/media/uploads/{upload}`. Transfer and polling responses expose
`screening|cleared|held|rejected`, with no scores. An uploader's previously
admitted preview can show screening bytes; held/rejected originals are withheld
from all delivery. Private targets still require their ordinary Access lease.

A complete finite score vector below the versioned thresholds reaches `cleared`
under the local launch policy. An above-threshold result reaches `held` with
`likely-explicit`; any decode, integrity, timeout or classifier failure reaches
`held` with `screen-unavailable`. Scores, model version, exact weights digest
and thresholds remain review evidence. Neither a score nor an automated report
is a staff decision or a finding of legality. Animated files are held because
screening one frame cannot clear all their bytes. These initial thresholds have
not been calibrated against a representative REZICS corpus.

Activation atomically queues one screen. A single-flight Main loop leases one
original at a time for 60 seconds, with a 30-second deadline. Tokens and erasure
epochs fence settlement. Sixteen expired attempts reach a review hold; obsolete
jobs are cancelled. Held results queue platform case creation in a durable
Content retry table. Governance deduplicates by screen job, discloses automation
and records category `prohibited-imagery`. An unavailable case owner leaves the
image held and retries later. G-565 supplies staff authority and decisions;
`MediaScreenStore.reviewOriginal` applies its exact original CAS and records the
staff decision. It never grants that authority.

`suppressIdenticalCopies(originalDigest, after?, limit?)` writes a permanent
SHA-256 marker before advancing at most 100 asset histories per call. Its asset
cursor continues large sets; repeating a call skips already suppressed assets.
Every delivery lookup consults that marker, so unfinished batches cannot serve
copies. Later originals of the bytes activate rejected and suppressed without
queuing a classifier. There is no perceptual hash or cross-asset byte deduplication.

| Internal operation | Bound and lookup |
| --- | --- |
| Lease/cancel/exhaustion recovery | One job per indexed ready/expired queue probe; one source and asset lookup; 5-second PG statement deadline |
| Screen settlement | One asset, token-fenced job, receipt, outbox and immutable result; no fan-out writes; delivery resolves each slot through primary-key probes |
| Review intake retry | At most eight jobs per tick through pending retry index; one governance case/report/evidence transaction per job |
| Staff clearance | One original CAS, decision, receipt/outbox and no avatar-slot fan-out |
| Copy suppression | One digest marker plus at most 100 distinct asset probes/state histories; digest-and-asset index, returned continuation |

## Recovery obligations

- **Upload activation.** A conditional create accepts identical bytes. The
  activation operation ID is derived from the upload, so replay resolves through
  its receipt.
- **Activated original with no asset revision.** Reconcile with
  `saveDraft` under operation `media-asset-revision:<upload>`.
- **Transform lease loss.** An expired lease can be re-leased. A stale token or
  an advanced epoch cannot activate output.
- **Erasure.** After the state becomes erased, a sweep marks representations
  `erased` and deletes the asset namespace plus quarantine keys. Asset revisions
  follow the Content erasure procedure.
- **Content projection.** The relay acknowledges `media.*` events. It must also
  skip text projection for a `media-set-v1` publication.
- **Orphans.** Expired reservations are reclaimed through
  `upload_reserved_expiry_idx`.
