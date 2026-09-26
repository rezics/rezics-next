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
public disclosure and the graph generation) and one media query. Each non-public
Work or Main Version reference costs one Access `canReadWork` check. That
per-item authority check is the remaining gap: it needs an Access batch read.
The media query probes the requested context, then
`urn:rezics:media:context:default`. That is at most two primary-key slot probes
per target, followed by joins to:

1. the head revision;
2. its use;
3. the asset state head;
4. the representation.

The requested context's slot wins even when it records a removal.

An image is returned only for a public, unsuppressed, active asset whose
original is available and within the `avatar-selection-v1` rendition bounds:
2048 px and 4 MiB. It is served as-is. The transform tables are ready, but no
image transform runs yet. The target resource must also be readable.

Missing selection, removal, a pending or oversized rendition, and private,
suppressed, deleted or erased media all return the same fallback. It carries no
asset or use ID. The fallback key is derived from policy, readable resource type
and resource. Responses carry `generation.graph` and `generation.media` and are
served `no-cache`/`no-store`.

`GET /v1/media/avatars/{selection}` and `GET /v1/media/uses/{use}` re-derive every
check at request time. A replaced selection therefore stops resolving at once.

## Operation template

| Operation | Route | Receipt action | Cost contract |
| --- | --- | --- | --- |
| Reserve upload | `POST /v1/media/uploads` | `media.upload.reserve` | 1 Access register and claim, 1 PG transaction (4–6 rows) |
| Activate bytes | `PUT /v1/media/uploads/{upload}/bytes` | `media.upload.settle`, then `draft.save` | ≤ 8 MiB read once; 2 object creates and 1 read-back; 2 PG transactions; ≤ 4 CAS attempts |
| Asset state CAS | `POST /v1/media/assets/{asset}/state` | `media.asset.state` | 1 PG transaction; erasure updates the asset's representations |
| Avatar selection CAS | `PUT /v1/resources/{resource}/avatar` | `media.selection.change` | 1 summary read, 1 Access admission, 1 PG transaction |
| Image-only body | `POST /v1/media/publications` | `media.use.create`, then `draft.save` | ≤ 16 items; 1 basis query, 2 PG transactions, 1 Access seal |
| Summaries | `GET /v1/resources/{id}`, `POST /v1/resources/summaries`, `GET /v1/public-previews/{id}` | none | 2 graph queries (lineage and batch), 1 media query, ≤ k Access checks |
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
- **Content relay.** `relayContentProjectionOnce` must acknowledge events with
  recipe `media-v1`. It must also skip text projection for `media-set-v1`
  publications. Otherwise the search projection cursor stops at the first media
  event.
- **Main entrypoint.** `services/main/src/index.ts` must pass
  `media: { store: new MediaStore(contentPool, content), content, objects }`.
  Here `objects` builds an `S3ImmutableObjects` for each namespace prefix.

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
- **Content projection.** The relay must acknowledge `media.*` events and must
  not project a `media-set-v1` publication as text.
- **Orphans.** Expired reservations are reclaimed through
  `upload_reserved_expiry_idx`.
