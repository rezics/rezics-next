# Media owner schema

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

The first slice of `avatar-selection-v1` probes the requested context, then
`urn:rezics:media:context:default`. That is at most two primary-key probes per
target, batched with `target = ANY($1)`, then joins in this order:

1. the head revision;
2. its use;
3. the asset state head;
4. the available rendition, through `representation_rendition_idx`.

An image is returned only for an `active`, unsuppressed asset whose disclosure
the viewer may read. Missing selection, removal, pending rendition, private,
suppressed, deleted or erased media all return the same fallback. It carries no
asset or use ID. The fallback is keyed by policy, readable resource type and
resource. The cache generation is the pair of Content positions of the slot head
and the asset state head.

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
