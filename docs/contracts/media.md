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
Avatars use the same machinery with bounded public renditions and owner selection.

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
