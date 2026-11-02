# Container lifecycle caller lifetime

The default Space and Realm Panel binds one mounted visit to its original target, signed-in subject, CSRF token,
locale, QueryClient session source and cache revision. The session cache is observed directly so same-account token
replacement and batched away/back updates retire the visit even when React renders only the final value. Replacing the
QueryClient, losing readiness, changing target or locale, and unmounting also retire it. A new visit starts with a new
authoritative read and never inherits the prior visit's command.

The live adapter closes over the captured CSRF token. It never reads the imperative latest-token getter when sending.
The controller checks visit ownership before queued reads, changes, post-change reads and destination reads, then checks
again after every await before publishing state. A late removal cannot restrict a replacement parent, and a late
restore cannot disclose a destination. StrictMode effect replay advances the operation ticket so earlier promises
remain obsolete while the reconnected caller can continue.

An uncertain command remains immutable and retryable only within its original live visit. Its key, action, target,
context, head, version and reason are reused exactly. Injected adapters keep their fixture contract and receive a
target, locale and mounted-connection lifetime without requiring a browser session cache.

The browser caller owns this binding; the native lifecycle reader, command and independent destination reader remain
the authorities. The lifetime adds no request, poll or sweep.

A validated removal acknowledgement immediately marks its exact submitted reason as the saved baseline, and explicit page Leave retires every lifecycle caller before independent follow-up reads can publish, even after acknowledgement releases departure protection.
