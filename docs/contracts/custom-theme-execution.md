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
