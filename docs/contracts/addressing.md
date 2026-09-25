# Resource identity, routes and canonical addresses

## Invariants

Native UUID/IRI, namespace slug, route occurrence and physical locator are distinct.
Routes target a Resource and typed context; they do not create another content
identity. A Main Version supplies the common product entry, with explicit links
to releases, contributions, revisions and occurrences.

## Resolution and assignment

Resolve fixed, UUID, scoped namespace-slug and admitted dynamic routes through
server-owned bindings. Slug assignment has normalization/version, namespace,
expected head, reserved-name rules and a transaction-safe uniqueness decision.
Concurrent claims have one winner. Renames preserve allowed redirects without
retargeting the original referent to unrelated content.

The first implemented profile is `work-address-claim-v1`: `POST /v1/addresses/claims`
requires an Account `address:claim` assertion and an Access
`address.claim` grant for `address:claim:<Work IRI>`. The Main command lowercases
ASCII slugs, validates one current metadata Work target, and writes a distinct
route binding, immutable revision anchor, admission-tied receipt and outbox event
atomically. `GET /v1/addresses/work/{slug}` resolves that binding only while its
target Work and Main Version remain current. A repeated idempotency key returns
the same receipt; a changed request conflicts. This profile does not yet define
renames, redirects, other namespaces or historical selection.

Route precedence and parameter codecs are deterministic. Dynamic resolvers are
registered bounded capabilities, never arbitrary uploaded code. Reverse-link
generation uses the same resource/context and canonical preference contract.
Resolve ownership and disclosure before returning titles, redirects or existence-
sensitive details. A stale locator does not authorize a different resource.

## Context and lifecycle

Zone routing selects presentation and admitted publication context independently
from governance. Mounting a Collection neither publishes its members nor changes
their canonical identities. Fixed-site Realm boundaries survive browser navigation,
SSR, direct API and shared links. Exact historical links do not silently follow HEAD.

Delete/merge/retire bindings through explicit history and current authority. Prevent
redirect cycles and bound chains. Route caches bind configuration/disclosure epochs;
revocation and identity correction invalidate affected entries. Qualify scoped slug
collisions, renamed identities, fixed-site escape attempts and unavailable targets.
