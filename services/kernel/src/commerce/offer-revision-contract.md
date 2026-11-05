# Offer price revision over HTTP

This contract owns the HTTP transport for the existing [`reviseOffer`](commands.ts) command and its
[native HTTP acceptance](../../test/commerce/offer-revision-http.test.ts). It adopts the minimal seller price
revision surface mounted by [`routes.ts`](routes.ts). The [Commerce README](README.md) continues to own purchase,
settlement and entitlement behavior. Its historical target-digest defect description is superseded for this
operation by the implemented command's `{ offerId, expectedRevision, unitAmountMinor }` intent and the
[native target-replay regression](../../test/commerce/revise-offer-target-replay.test.ts).

## Request and result

`PATCH /v1/offers/:offerId` uses the same `:offerId` parameter name as sibling Commerce routes. It requires the
ordinary bearer/Access identity, the existing `gate:selling` exposure, existing `offer:manage` action and ordinary
quoted `Idempotency-Key` header. There is no new action, grant, permission formula or provider dependency.

The JSON body is a closed object containing exactly `unitAmountMinor` and `expectedRevision`, both positive safe integers. Missing amounts or revisions,
zero, negative, fractional, unsafe or nonnumeric values and extra fields return `400 invalid_request` without
effects. The submitted revision is compared under the offer row lock in the same transaction as mutation, after exact authorized replay. A stale fresh request returns `409 offer_revision_conflict` without business effects or current terms.
Existing native storage constraints continue to apply; the safe-integer transport range does not expand them.

Success is `200 { "offer": ... }`, using precisely the existing POST/delist `offerSchema` in
[`routes.ts`](routes.ts):

| Field             | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| `id`              | Requested offer ID                                             |
| `targetSubjectId` | Unchanged captured offer target                                |
| `summary`         | Request-authorized shared `SubjectSummary`, or explicit `null` |
| `title`           | Unchanged title                                                |
| `currency`        | Unchanged currency                                             |
| `unitAmountMinor` | Accepted price                                                 |
| `state`           | `active`                                                       |

Both the envelope and offer object are closed. Internal creator, tax, royalty, revision and transaction fields
are absent. The mutation uses `summary`; public GET retains its existing `subject` spelling. Summary disclosure
is evaluated for the current request and never grants access to an otherwise hidden subject. Successful native
command metadata contributes the ordinary session consistency component, as with POST/delist.

## Authorization, errors and replay

Authenticate and check the current exposure/scope and target authorization before looking up or disclosing a
receipt. Unknown, malformed or unauthorized targets return concealed `404 not_found`; another seller's target
must not expose offer or receipt data. Missing or invalid bearer credentials return `401` using the ordinary
native authentication problem. An active caller missing the current `offer:manage` scope returns `403 forbidden`.
A closed selling gate returns the existing `403 platform_closed`. A stale revision returns `409 offer_revision_conflict`; a matching revision on a delisted target returns
`409 offer_unavailable` for a fresh authorized revision.

Native suspension increments the authentication floor and sets `authn_fenced = true`; the authenticator rejects
the old token with HTTP `401`, JSON `invalid_credentials` and an `invalid_token` challenge before producing an
identity. Gated Commerce routes retain their ordinary concealed `401 authentication_required` response for invalid
bearers. Auth correct-password sign-in returns `403 ACCOUNT_SUSPENDED` without creating a session. The acceptance
tests actual revoked bearer `401` separately and does not forge an unfenced suspended account or alter shared
authentication policy.

Receipts retain the native principal/partition/command/key identity. The digest binds the complete intent,
including the path's `offerId`, expected revision and body amount. With one seller owning two offers in the same partition, reusing
the first offer's key and amount for the second is `422 idempotency_conflict`, with no second-offer change.
Changing the amount under that key also returns the existing native `422 idempotency_conflict` problem.

Exact authorized replay returns the original accepted offer result, even after a later fresh-key revision changed
the current price. It must not return another target or the latest stored price, advance revision/partition position,
append events, create another receipt or call the provider. A newly signed token with the same principal/client
and current authority can replay; narrowed scope, another account or revoked credentials cannot disclose it.
The shared summary remains request-bound rather than a stored authorization decision.

## Captured purchases and proof

A fresh revision updates only the selected active offer through its existing native command, increments its native
revision once and atomically records the existing revised event, receipt and envelope. A fresh key can revise the
other owned target independently. Orders already captured keep their original offer revision, target and price;
existing Checkout Session parameters, settlement, transactions and entitlements stay unchanged. Revision does not
synchronize a provider catalogue, resubmit Checkout or scan buyer history.

The literal acceptance case is
`seller price revision through HTTP binds target intent preserves captured purchases and reauthorizes replay`.
It uses the real profile-entry fixture's production `createKernel`, native Auth/Access, lifecycle, grants and owner
commands. It establishes two seller-owned offers in the same partition, pending and paid captured purchases and a
real entitlement before PATCH. The official Stripe adapter talks to the existing loopback provider fixture.
It asserts raw HTTP status/body and public GET price, original replay after a later price, changed-target/amount
conflicts, Bob/unscoped/revoked denials, strict invalid input and closed selling exposure. A read-only SQL connection
inspects named offers/orders, the order-keyed entitlement, exact principal/key receipts, receipt-position events and
native partition counters to prove effects or their absence. The existing helper-only target regression stays intact.

The route delegates to the existing native command under normal admission, records its session consistency component
and resolves the summary for the current request, including replay. Closed OpenAPI and client declarations are
derived from the mounted route. Specification, implementation, exposure, passing acceptance and promotion remain
separate states; the named native cases provide acceptance evidence for this transport.

## Cost

- Touches: one owned offer native command, existing authorization/receipt/outbox and request-bound summary.
- Bound: the same one-target update and native keyed receipt; no catalogue/provider synchronization or
  buyer-history scan. Captured orders and entitlements are not revision inputs or fanout targets.
- Growth check: preserve the existing native offer/receipt/captured-order bounds. This HTTP acceptance adds
  no measurement or claim of all-Commerce growth.
