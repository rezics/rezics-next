# Space setup caller lifetime

The setup page admits one mounted caller for its Space target, signed-in subject, command readiness, locale, and the
current QueryClient session source and revision. Read readiness is separate from command readiness: a healthy
authenticated session with no CSRF token may read the original setup, Context directory and exact Context, and Board
scheme/concept choices, while every command remains disabled. Each server read reports the subject established by the
same prepared request and credential used for its bounded native read. An explicit credential with no session subject
is unbound and cannot borrow the browser's current identity.

The route captures the original QueryClient/session observation before its unchanged `readSpaceSetup` call. The
serializable loader result carries that observation and the read's actual reader through route serialization and
hydration; neither contains a bearer credential, CSRF token, or seal. The page requires an actual session reader and a
matching admitted subject. A bare browser snapshot is not an admission. When the loader and page share one in-memory
QueryClient, its revision and update/error observations also reject a replacement that happened during the read.
Across an independent SSR/browser cache, those local counters are observations only. There is no shared monotonic
session producer in this repository: an away-and-back replacement to the same subject, readiness and final session
values between server capture and browser hydration cannot be distinguished from no replacement. The current
session subject and actual request reader still have to agree; the undetected case is limited to that unobserved
cross-cache ABA interval.

The session source retires callers on successful equal-value cache replacement, identity or credential changes,
retained-data errors, cache removal, unknown/sign-out transitions and any observed batched away-and-back sequence.
It ignores fetch status and observer-only events. Source replacement, target/search or locale changes, loss of
readiness and final unmount retire queued work. StrictMode effect replay reconnects the visit, while work carrying its
old ticket stays retired. Guards run before queued work, after settlement, before publication or merge, and before
retry, refresh, finalization or cache insertion. A retired callback cannot clear a later operation's busy state.

Every admitted command closes over its caller and CSRF token. One immutable command and idempotency key remain in
place after an uncertain result; a retry reuses the exact command. Definite refusals permit editing under the existing
rules. Successful Space, Realm and Board identities are applied before the bounded follow-up read, so a failed read
does not lose a confirmed result or replay the accepted command. Context/Subject resolution, the bounded twenty-item
Context directory, Board scheme/concept limits, native ordering/cursors, freshness and disclosure remain with their
existing readers and command authorities.

The mounted form registers changed setup fields, Context/scheme/concept selections and unresolved commands with the
shared authoring-departure provider. Router departure (including a changed validated Space target and Back/Forward)
offers one accessible Stay/Leave decision; active protection also installs the native browser beforeunload guard.
Stay keeps the step, exact fields, selections and immutable command/key. Leave immediately retires the caller before
the next route read, losing local retry recovery without cancelling or undoing an accepted command. Session, target
and source retirement release old protection irreversibly. Confirmed steps compare against their accepted resource
values even when the follow-up read fails; independent changed fields remain protected after any successful step.
Decision: picker search queries are browsing state; changed Context reference input and selections are protected,
while step navigation and pausing keep the same in-memory draft without a departure decision.

`SpaceSetupEntry` captures the session source before its read, checks the actual reader before returning a result to
its private cache, and keys each generation by the observed source revision. No lifecycle or permission authority is
inferred from Context directory or Board display data. No additional native read, polling or per-row hydration is
performed.

## Board choice recovery

An invalid or unavailable continuation offers **Restart options from the beginning** alongside same-request retry;
only a failed continuation offers restart, while stale retry keeps its existing first-page recovery and denied
results retain their meaning. Restart retains the exact query, picker kind and scheme, drops the cursor and reads
one ordinary bounded first page. It does not change the draft, selected values or their admission. A first-page
invalid result stays invalid without an automatic reset or a broader search.

Restart retires the failed page's queued actions and loaded choices before starting its read. Source, query, scheme
and private caller replacements still retire old results and callbacks; reader provenance, native ordering, page
limits and freshness remain with the existing readers. Recovery adds no polling, enumeration or automatic retry.

The connected regression suite in `apps/web/tests/space-setup-reader-compatibility.test.tsx` covers the production
route, server preparation/read wrappers, caller, form and choice readers after integration. Its assertions are
authored but have not been run. Existing native and command acceptance remains the authority for those outcomes.
