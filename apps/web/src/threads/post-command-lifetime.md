# Post command caller lifetime

`ThreadReadingPost` admits edit, delete, restore and current-post refresh work against its existing
`QueryClient` and `['session']` cache. The caller binds the cache source and monotonic revision, the exact
session state/account/CSRF tuple, personal readiness, reader authority, post/thread/revision/author and target,
plus its mounted connection. It starts no query, poll or alternate transport. A session cache add, removal,
successful replacement, or tuple transition advances the revision synchronously. Same-account credential and
readiness replacements, including away/back updates batched by React, permanently retire retained callbacks.

Commands use the ready CSRF value captured by their original caller. Each command and refresh checks that caller
before its existing server action or page refresh, after awaits, and before local state, post/opening-title changes,
invalidation, focus and Undo feedback. A stale action cannot use a replacement caller's credential. The real
browser cache must say signed in, contain a nonempty subject and CSRF token, match the current viewer, and have
current personal data before post commands are admitted. Restore also requires the original deleted post's current
native restore window, or the immediate local Undo for a confirmed delete; the native endpoint remains the final
authorization and deadline authority. Public reading never grants command authority.

One visit retains exact idempotency keys through transport uncertainty. Duplicate delete/restore activation is
latched synchronously. A successful write is not repeated when its follow-up page read fails. An uncertain restore
first uses the existing page refresh and retries only the same post command and key when the returned post remains
restorable. A restore conflict preserves its existing exact-review link. Local deletion keeps only the existing
content-free placeholder, original opening-title behavior and measured minimum height; it invents no native receipt
or restore deadline. Dirty editor state and its Composer-owned departure, upload and submission protocol remain
inside the mounted `InlinePostEditor`; the route caller fences only the supplied write and success callbacks.

The composed regression is
[`post-command-lifetime.test.tsx`](../../tests/post-command-lifetime.test.tsx). It uses the real `ThreadReadingPost`,
`QueryClient`, `InlinePostEditor`, `ContentActions`, Undo toast and deferred existing action/page-refresh boundaries.
It is authored but **UNRUN** under the current implementation check policy. The foreground web typecheck is the
only permitted check for this source attempt; native, browser and full acceptance remain integration obligations.

## Cost

The caller adds one constant-size read-only observer per `QueryClient`, constant bookkeeping per mounted post
caller, one original native command per intent, and only the existing explicit current-page refreshes. It adds no
post request, session read, polling or per-post query. Acceptance must retain exact command/key/payload counts and
show zero obsolete queued sends, reads or callback effects.
