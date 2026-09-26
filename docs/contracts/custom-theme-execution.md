# Custom themes and executable presentation

## Default and elevated capability

Ordinary themes use validated tokens, presets and declarative layout. Executable
external-live themes require an explicit elevated capability, exact host/owner/
revision approval, expiry, review and emergency disable. Describing a theme in
the graph or applying a classification does not confer execution authority.

## Trust boundary

Declare allowed runtime, origin, network, data, secret and resource access. Isolate
execution from Account cookies/private control origins and the main application
authority. An inspected entry file does not seal mutable transitive dependencies;
pin artifacts where a reproducible approval is required and report otherwise.
Never use a theme to hide consent, security consequences or inaccessible states.

## Lifecycle

Submit -> inspect/test -> approve exact basis -> activate -> monitor -> expire/kill.
Changed executable bytes/capabilities require new approval. Stale render caches
and running sessions obey kill policy. Rollback rechecks current eligibility rather
than restoring a revoked approval. Restricted diagnostic logs redact secrets and
private content. Qualification uses controlled malicious/failed dependencies,
origin isolation, timeout, key rotation and emergency disable cases.

## Backend approval API

`POST /v1/themes/{theme}/activations` accepts an Account-authenticated owner approval
for one dependency digest, origin, runtime capability set and UTC expiry. The owner
must present the `theme:approve` Account scope and an Access grant for that theme.
The request names the expected activation revision (`null` only for the first
activation); a successor records that exact predecessor and increments the approval
generation. A changed dependency digest or capability basis requires a new approval.
`Idempotency-Key` must equal the request's idempotency key; replay returns its terminal
receipt and never makes an older revision current again. Reusing a key for a different
approval request returns a conflict.

`GET /v1/themes/{theme}` requires `theme:read` and reports only the current approval.
Its `active` value becomes false at expiry. A stale expected revision returns a conflict,
denied or already expired approval returns a denial, and uncertain or mismatched graph
and Content state remains unavailable. If the graph commit succeeds before the Content
projection, retrying the same approval completes that projection before returning
success. Replaying an earlier successful key after a successor approval leaves the
successor current.
