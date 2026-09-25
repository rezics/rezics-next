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
One Work has at most one current `work` address; a second slug claim produces a
terminal conflict receipt. Occupied slugs remain reserved after cancellation or
future route-state changes so that an old link cannot acquire a new referent.

### First-profile cost contract

Let R be retained route bindings, W current Works, H route revisions and b the
fixed-size request/response bytes. A claim performs one current-Work lookup,
two guarded existence checks (slug and current address for the Work), one
bounded native write with a receipt and event, plus fixed Account/Access admission
work. The read selects at most two binding rows by normalized slug and confirms
the current Work/Main Version. With suitable predicate-object indexes and the
enforced uniqueness invariants, the intended graph lookup work is O(log R +
log W + b), independent of H and unrelated routes. Native validation and the
single-writer transaction add fixed changed-triple work; writer wait is a
separate contention cost. This bound is conditional on the selected physical
plan, which is not yet measured on a large route corpus.

The real-owner VIEW01 test counts Main-to-Fuseki requests through the adapter:
at most 8 for a successful or denied claim, 4 for replay, 14 for a conflicting
second slug, and exactly 1 for public resolution. Those are call ceilings for
the exercised paths, not measured engine CPU, bytes, PostgreSQL/Account calls,
P95/P99 latency or capacity. The caller admits a 64-byte ASCII slug; one claim
writes one route binding/revision or a cancellation receipt and one outbox batch.
The final complexity gate still needs native plan/counter checks across R and
skewed target degree, plus cross-owner call and byte meters.

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
