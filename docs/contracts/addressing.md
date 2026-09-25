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
merge, retire or other namespaces; the separate lifecycle profile below owns
renames and historical selection.
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

### Work address rename and exact reads

`POST /v1/addresses/renames` requires an Account `address:manage` assertion,
an Access `address.rename` grant for `address:rename:<Work IRI>`, an idempotency
key and the current route revision. It atomically changes the old binding to
`Redirected`, retains its original `targetWork`, writes an immutable lifecycle
revision with its previous head, and claims a new current binding for the same
Work. A stale head or occupied new slug produces a terminal conflict receipt;
the old binding and slug stay reserved. A repeated intent returns the same
receipt even after later renames.

`GET /v1/addresses/work/{slug}` returns the current Work or a 308 response
with a `Location` for its one current canonical slug. A redirect stores the
Work identity rather than the next slug, so the resolver takes at most one
reverse lookup after any number of renames. `GET /v1/works/{id}/addresses`
returns that canonical binding or `null` for a current Work without an address.
`GET /v1/addresses/work/{slug}/revisions/{revision}` selects one immutable
revision of that binding and reports its then-current state without following
the present head. The redirect response uses `Cache-Control: no-store` because
the canonical slug can change again. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.9)
defines 308 and `Location`; the persistent route identity and direct Work
lookup are REZICS design choices informed by [W3C's URI persistence guidance](https://www.w3.org/Provider/Style/URI).

For the same R, W, H and b, rename reads one old slug/head and guards one new
slug before writing two fixed-size bindings, two revisions, one receipt and one
outbox event. Exact revision lookup uses the supplied revision IRI and binding;
reverse lookup uses a target-Work predicate and returns at most one active row.
The intended indexed work is O(log R + log W + b) for rename/current/reverse
and O(log R + log H + log W + b) for exact history, independent of total route
history except index depth. The real owner test counts at most 10 Main-to-Fuseki
requests for a successful rename, 2 for a redirect read and 1 each for reverse
and exact read. Physical index work, bytes, Account/Access calls and contention
remain unmeasured at scale.

### Merge and retirement dispositions

`POST /v1/addresses/dispositions` accepts `merge` or `retire` at one exact
current route revision. It requires the Account `address:manage` assertion and
an Access `address.dispose` grant for `address:dispose:<source Work IRI>`.
`merge` also requires a distinct target Work with a current canonical address.
It keeps the source route's original `targetWork`, marks that binding `Merged`
and `Redirected`, and records the target in `redirectWork`. `retire` marks the
source binding `Retired` with no redirect target. Both write an immutable
revision, admission-tied receipt and outbox event. A stale head, unavailable
merge target or competing disposition produces a terminal conflict receipt.

A merged slug resolves to a 308 redirect to the target Work's current canonical
slug. A retired slug returns 410 while its route identity and exact revisions
remain readable. Reverse lookup returns `canonical: null` for a Work with no
current address. Slugs stay reserved, preventing a different Work from claiming
a former address. The owner integration exercises direct merge, retire, denied,
replay, stale and concurrent dispositions plus relay handoff. It has not yet
qualified a chain where the merge target is merged again; that case and bounded
transitive resolution remain open for the next batch.

Each disposition reads one source slug/head and writes one route head, one
revision, one receipt and one outbox event. A merge also checks the target
Work/current address in the same native command. Under indexed predicate-object
lookups the intended work is O(log R + log W + b), with a fixed number of
Main-to-Fuseki requests and one TDB2 writer transaction. The physical native
plan, cross-owner calls and bytes, writer contention and transitive merge costs
remain unmeasured.

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
