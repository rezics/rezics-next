# Library pins

This document owns the private ordered pin preference used by the Library sidebar and phone Collection selector.
[Destinations and actions](library-and-collections.md#destinations-and-actions) owns navigation;
[viewer actions](viewer-actions.md) owns action discovery. Pins are the first independent delivery: curated pins
must work before built-in integration is complete. Continue and the common Everything, state and Liked runtime
remain separately required. This adoption and its native cases add no runtime, schema or product implementation.

## Owner and effects

One authenticated account owns one ordered list of at most **100 distinct Collection IDs**, using the shared maximum
list size. There is one CAS revision for the entire list. An empty owner starts logically at revision 0; GET creates
no row. The first effective write returns revision 1. Each effective append, reorder or removal increments once.
Retain the empty list's revision after the last removal to prevent ABA. Never reset or wrap a revision: overflow
aborts the transaction and leaves the list and receipt unchanged.

A pin stores only an ID and ordering data, never a title, authority, predicate or copied header. Pinning, reading,
reordering and unpinning create no follow, entry, holding, session or reaction, and never change the target's header,
resource grants, visibility or materialization. Unpinning is a preference transition; it does not delete a Collection.

A **new** pin requires the ordinary current Collection read, with its actual gate, eligibility, Access and client
scope checks. Curator equality is no shortcut. Unknown and concealed unreadable targets both answer 404 `not_found`.
An existing stored ID may be reordered or removed without target read authority, including after deletion or loss of
read scope. Built-ins use the actual common Collection resolver and discovered IDs; no tuple hint, fabricated profile
or direct header insertion supplies an identity.

## HTTP

All endpoints have implicit own-account scope, the `personal_library` gate and `Cache-Control: private, no-store`.
There is no `accountId` selector. Add the native actions/scopes `library_pin:list` and `library_pin:update`; update
backs both mutations. Use the existing own-account admission pattern, with no new resource/grant type or permission
formula. Read-only tokens for the same account have list scope and no update scope; Collection read scope controls
their target projection separately.

| Request                                                             | Operation ID         | Success                                            |
| ------------------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| `GET /v1/libraryPins?limit&cursor`                                  | `library_pin.list`   | `200 {pins:[{collectionId,target}],revision,next}` |
| `PUT /v1/libraryPins/:collectionId` with closed `{revision,after?}` | `library_pin.put`    | `200 {revision}`                                   |
| `DELETE /v1/libraryPins/:collectionId?revision=...`                 | `library_pin.delete` | `200 {revision}`                                   |

GET defaults to 20 and accepts integer limits 1–100. `next` is a shared signed keyset cursor or null. Bind the cursor
to the owner, limit, list revision and ordinal, using the shared codec, never custom crypto or a raw offset token.
Another owner/limit or a damaged token returns 400 `invalid_cursor`; a changed list returns 409 `stale_cursor`.
Unknown fields/selectors, invalid revisions/limits, self anchors and missing anchors return 400 `invalid_request`.

For PUT, `after:null` means first; a currently pinned ID means immediately after that anchor. Omission appends a new
pin and preserves an existing pin's placement. Never create duplicates. Unchanged placement and DELETE of an absent
pin at the current revision use native `noEffect`, preserving revision and partition position. Native noEffect may
persist its ordinary receipt. All mutations require the ordinary structured `Idempotency-Key` header. A stale list
revision returns 409 `conflict` without mutation. At capacity, an additional distinct ID returns 409 in the existing
capacity-conflict family; reorders, duplicates and removals remain possible. A failed write leaves its key reusable.

Exact authorized receipt replay acknowledges the original revision even after later list changes and target
concealment. Changed intent under the same key returns 422 `idempotency_conflict`. Owner admission and current scope,
account and credential checks precede receipt lookup; replay never discloses target metadata. Native invalid and
pre-suspension revoked bearers answer 401 `invalid_credentials`, with
`WWW-Authenticate: Bearer error="invalid_token"`. Missing credentials answer 401; missing scopes answer 403 with the
native `insufficient_scope` challenge. No valid-suspended-bearer fixture is invented.

## Current target projection

Each `target` is the **current shared Collection header union** from the same resolver and authorization semantics
as ordinary Collection GET. It includes admitted curated/dynamic and real built-in presentation, never members or
personal witnesses. A rename is visible on the next pin read without changing the pin revision. An unknown, deleted
or ordinarily concealed unreadable target yields null while preserving the owner's stored ID. Denied targets leak
no title, owner or private key. Genuine dependency unavailability, readiness and deadline failures propagate as their
native failure; they never become null or a successful partial page.

One pin request uses bounded server reads for only its returned limit at the request's native time T. Release the
owner pin connection before visiting target homes. Do not make one HTTP call per pin or join SQL across partitions.
A typed same-home join is allowed only where native ownership permits. Charge one owner record plus O(limit) target
points/Access work and output bytes; no history scan, all-pins hydration beyond the selected page or model policy
callback. GET writes no header, grant, receipt, pin row or materialization and schedules no repair.

## Native acceptance

The curated suite uses `createReleasedDiscoveryFixture({version:1})`, its actual governor-backed
`setup.openFeatures`, genuine `scoped` sign-in/token producer and read-only `inspect`. Every created Collection ID
comes from native HTTP. It uses no replacement release, backend or fabricated grant/actor. SQL instrumentation only
observes the real driver's statements. The availability case holds a real table lock in that fixture's isolated
database and releases it in finally; no domain row is inserted or altered for fault injection. The existing transport
forwards HTTP methods unchanged; its narrow TypeScript union omits PATCH, so the rename case invokes the inspected
native forwarding function through `Reflect.apply` with the actual mounted PATCH route.

[Curated cases](../services/kernel/test/library/pins-user-cases.test.ts) independently cover empty/read-only reads,
public/private-own/unlisted creation, append/reorder/remove, list CAS races, cursors, validation, noEffect and receipts,
owner isolation and current admission, current title/null/unavailability, no target/personal side effects and the
100/101 boundary with controlled native IDs. Statement observations assert no GET writes, no off-page target work
and no personal-history reads; they are not a three-scale performance claim or a chosen storage schema.

[Built-in cases](../services/kernel/test/library/builtin-pins-user-cases.test.ts) separately require actual discovery
and ordinary reads of Everything, Liked and real accepted state views, pinning without materialization and stable
identity after unpin. They do not calculate IDs or seed headers. Both files remain required; curated success alone
does not claim built-in completion. Missing pin routes or built-in discovery must produce meaningful native RED,
never skip/todo, a missing-driver verifier, permanent throw or normalized success.

Run the two named files through the worker wrapper, then the root typecheck. The handoff records literal case names,
final hashes, commit and raw native failure evidence for freezing. Existing acceptance files remain unchanged.
