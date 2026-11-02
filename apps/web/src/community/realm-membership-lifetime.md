# Realm membership caller lifetime

RealmMembership and BoardStartThread share the compatible `['realm-membership', realmId, subject]` cache key. The
two-argument `realmMembershipQuery(realmId, subject)` remains available for existing bootstrap and server fixtures.
Browser callers pass a caller binding made from the existing QueryClient session cache, Realm, subject, CSRF
readiness and component lifetime.

The binding observes session-cache notifications directly. A state, subject or CSRF change advances its monotonic
revision even when several changes are batched before React renders. A changed revision retires reads already queued
for that caller and cancels only the exact standing query they own. Bound reads check again after the deferred import,
immediately before the native standing read, and after it. Their results are tagged to the revision that completed the
read, so previously cached standing cannot expose a membership action or Board entry after an observed transition.
Bootstrap data remains usable until this browser has observed a transition.

Membership command attempts keep their original action, idempotency key and CSRF token. A later explicit retry keeps
that immutable intent; it never substitutes the replacement token. The retry itself must have a current caller and
current native standing. Results, refresh rounds, leave checks, MyRealms/Space-follow invalidations and router
invalidations all stop when that caller retires. An obsolete leave command with no observed result remains uncertain;
an obsolete accepted response cannot start a refresh cycle, and an obsolete failure cannot be described as refusal or
success. Retirement cannot establish whether the remote command was applied.

An accepted current command keeps the existing four-read settlement cycle at delays 0, 500, 1500 and 3000 ms. An
authority transition retires that cycle without restarting it. A fresh standing read is required before current
controls or Board admission are exposed again. None of these reads changes Space following.

An explicit keyboard membership operation hands focus to the named membership summary only after its current caller settles into admitted standing and its control disappears; a surviving control keeps focus, and pointer use, focus movement or caller retirement cancels the handoff.
