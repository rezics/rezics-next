# Media assets, representations and uses

## Identities

An Asset identifies maintained media; an asset revision identifies content state;
a Representation identifies exact encoding/bytes; a Locator identifies a way to
obtain them; a Use attaches an asset to another Resource/context with roles.
Originals, thumbnails, posters and transcodes are representations, not additional
cover identities. Similar images or identical bytes do not prove the same rights
or referent. Deduplication stays inside compatible disclosure/retention domains.

Uses retain front/back/booklet/screenshot roles, applicability, order, crop and
source. A source's primary flag and its role label are separate from native cover
selection. One image can serve multiple compatible roles and several releases.
Avatars use the same machinery with bounded disclosable renditions and owner
selection.

## Universal avatar selection

Every object can participate in avatar selection, including concepts, characters,
works, shared Contexts and relation definitions. The required
[`ResourceSummary.avatar`](presentation.md#resource-summaries) result is either
an eligible selected image or a stable fallback. This guarantee does not require
an uploaded Asset or a separately stored default image for every resource.

An avatar is a Media Use with the avatar role, owner/context selection, exact
asset/representation basis and optional crop. Reuse Asset, Use and Representation
identities; do not introduce an Avatar asset family. Selection follows an explicit
versioned context policy. Never choose the first available image, inherit a cover,
or follow a related object's image without an admitted rule and readable basis.

Selection/replacement/removal commands require resource authority, expected
selection revision, idempotency and a durable outcome. Resource creation does
not wait for media upload. An absent selection resolves to the admitted fallback;
private, suppressed, erased or undeliverable media resolves safely without leaking
the asset reference. A fallback is presentation output and never changes the
resource's semantic types, statements or acceptance.

Image responses retain the eligible use/rendition and actual selection source.
Rendition size, delivery lifetime, revocation and erasure follow the existing
media policy. Name/type defaults and image selection are generation-bound so a
cached object list cannot retain a revoked avatar. These are adopted API
requirements, not an assertion that the generic selection path is implemented.

## Upload and processing

Reserve upload intent, upload into quarantine, verify size/format/digest, perform
admitted scanning/transformation, then activate an asset representation through an
owner command. Object storage and graph publication form a staged workflow, not
one transaction. Orphans have expiry; published references pin required objects.

Transformation jobs bind exact input digest, profile, authority and erasure epoch.
Stale or cancelled workers cannot activate outputs. Do not fetch arbitrary URLs
with trusted network credentials; source acquisition enforces URL/redirect budgets.
Metadata-only external assets may keep locators without a fabricated byte digest.

## Delivery and lifecycle

Check current disclosure and selected use before signed delivery. Bound URL lifetime
and include revocation/erasure policy for cache/CDN and all derivatives. Changing
a remote URL's bytes creates a new observation, never mutates an exact reference.
Retraction, moderation suppression, deletion and physical erasure are separate.

Gallery reads page by owner/context/order with bounded hydration. Media role and
language fallback disclose their actual source selection. Qualify upload failure,
stale transformation, private thumbnails, conflicting cover selection, timed
subtitle references and erasure/recovery across every representation.
