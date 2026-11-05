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

## Edit conflict inspection

A definitive native edit precondition refusal may supply a current-post result to the still-mounted editor. Only that
result, after the original command caller's post-await check, can open conflict inspection. Transport uncertainty
retains the exact sealed command/key for existing retry/readback; an unavailable send or read is never promoted into
a conflict, and inspection does not settle an uncertain command.

`InlinePostEditor` receives the route's optional `inspectionAdmission` identity and synchronous original-caller guard.
It narrowly binds its retained body reference, monotonic draft revision, installed snapshot readiness and session
abort signal to the optional presentation port in `EditConflictRecovery`. Existing callers without this port keep
the single-current-reader behavior. Neither port grants upload or command authority. The recovery journey owns
paired readers, local indexes, disclosure visits, the replacement snapshot and return focus; the editor continues to
own its draft, selection, media repairs and immutable command preparation.

Replacement requires the original admitted conflict object, exact current post/thread/revision/security identity,
body/media references and licence, the original reader/session admission, and the exact retained draft revision and
reference. It also requires an available body admitted by the installed document codec within the native/editor byte
ceiling. A pending/failed editor snapshot, body edit, media-reference change, replaced result, missing/erased body or
reader retirement prevents replacement. Invalidation clears private projections and cannot be reversed by restoring
an earlier value. A new review may use the existing current result only while its original admission still holds.

The destructive replacement button confirms discarding local writing; the existing owner callback alone retires
uploads, updates the local base revision and resets the settled key. It sends nothing. Keep editing and Escape leave
the draft and command untouched, including media recovery and supported editor selection. Return focus checks the
original caller and any newer outside interaction. Closing clears readings; retirement also clears pending return
state. Late section, spoiler, replacement and focus callbacks cannot act on the retired visit.

The composed regressions are [`post-command-lifetime.test.tsx`](../../tests/post-command-lifetime.test.tsx),
[`post-edit-conflict-recovery.test.tsx`](../../tests/post-edit-conflict-recovery.test.tsx) and
[`19-edit-conflict-inspection.test.tsx`](../../tests/19-edit-conflict-inspection.test.tsx).

## Cost

The caller adds one constant-size read-only observer per `QueryClient`, constant bookkeeping per mounted post
caller, one original native command per intent, and only the existing explicit current-page refreshes. It adds no
post request, session read, polling or per-post query. Acceptance must retain exact command/key/payload counts and
show zero obsolete queued sends, reads or callback effects.
