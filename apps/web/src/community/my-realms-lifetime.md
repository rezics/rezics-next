# My Realms caller lifetime

Each My Realms read captures one QueryClient, route cursor and locale, credential mode, session tuple and cache
revision, source revision, and actual reader origin. A per-QueryClient visit generation is reserved before the caller's
asynchronous CSRF fingerprint. A newer route capture supersedes an older pending capture even when the session values
are equal. The old capture cannot activate after the new one or borrow its query/result owner.

The existing query function checks the caller and exact Query object before the native read, after its asynchronous
action import, and after the response. `publishResponse` admits only the original page whose actual session origin
matches the captured reader, and tags that page with the same caller and query object before TanStack Query can publish
success. Query data is usable only while the exact query, page object, update revision, route, locale, credential mode
and session source still belong to that visit. Successful equal-data session replacement, error/removal, observed ABA,
address changes, abort, a replaced query or final unmount retire the caller. Fetch and observer activity alone do not.

Retirement removes only the exact owned query object. Its cancellation and removal filters include that object identity,
so a replacement query sharing the cursor key survives reentrant cleanup. A late read, query error, `finally` callback
or verification from a retired visit cannot publish or clear a newer query. StrictMode's synchronous effect replay
reconnects the current caller; an asynchronous hydration verification is scoped to its own connection attempt, and an
older completion cannot unlock the replayed connection.

The current route still returns its accepted loader page for server rendering and adopts it in the browser. The existing
`acceptsHydrationSeed` branch can render private data before post-mount verification; that branch is an explicit
reserved contract and is not proven safe by this lifetime or by matching receipt fields. This work does not change
private SSR or first-render output, claim `renderToString`/`hydrateRoot` first-paint proof, or add a trusted synchronous
shared hydration/session producer. Independent QueryClients still cannot reveal an unobserved away-and-back session
transition; the known independent-cache/ABA limit remains.

The source boundary is the existing My Realms caller's capture, admission, verification, query ownership and
post-verification effects; its route host; this document; and the three connected regression files. The membership query, page reader, session producer and native query retain their contracts. The existing first-page
request, cursor recovery and continuation, order, private disclosure and null-CSRF read-only behavior are preserved.
No extra session read, authentication preflight, polling, per-row hydration or native request is added.

Decision: offer first-page recovery only for cursor failures without an HTTP status or with status 408 or 5xx; other HTTP failures, including admission denial and platform-closed, keep their existing retry or closed handling. The localized action targets `/realms` with empty search so the route guard and a fresh caller own the visit.

## Current-entry envelope boundary

The installed `GET /v1/me/realms` response is a closed page of `items` containing `realmId`, `name`, and the literal `role: 'member'`, plus `next`. It supplies no current Realm address, readability state, presentation, media grant, membership episode, or management/leave advice. The Web view can render a description supplied to it, but the native response and generated client do not provide one; supplied-page descriptions are presentation examples only. The loader and fake response now preserve the installed shape rather than adding an undeclared description.

Decision: Until Content publishes the expanded generated response and examples, Web consumes only the installed fields and does not treat `role: 'member'` as entry, management, or leave authority. Inventory rows now show localized unavailable entry instead of deriving a Realm link from membership. The current-entry continuation owns admitting a destination from the expanded native response.

## Expanded entry and selected leave admission

Activation requires both the mounted generated `KernelClient.me.realms.get` response and its recorded
`my-realms.json` example to expose current entry, presentation, media, membership episode and independent
enter/manage/leave advice. A newer service schema alone does not activate this receiver. Keep the installed
projection until that boundary exists; do not introduce a browser response type, raw endpoint or cast to bridge it.

Admit presentation and media only from that current page. Concealment retires prior labels and media; it never
refills a sparse window. Image `none` and `unavailable` are independent of action admission. Membership does not
admit a readable destination, manager status or leave authority. Supplied Realm actions go to the canonical Realm
owner, which rereads its viewer and exposure. Owner leave remains `owner_invariant_observation_unavailable`
until the native predicate is observable; no inferred last-holder check or browser preflight substitutes for it.

One explicit leave selection captures the native command, immutable operands, original operation, exact Account
and membership episode, credential/CSRF lifetime and current advice. Interval tokens are opaque within that
Account; neither chronology nor uniqueness across Accounts is inferred. Confirmation and exact retry use only
that selection while it remains admitted. Replacement advice or a new episode requires a new explicit selection.
Null CSRF keeps the page read-only, and the existing native membership command authorizes every execution.

Accepted execution stays pending until supported readback confirms the original operation's transition. Unknown
and rejected outcomes stay distinct. Later matching membership alone cannot establish that the original command
succeeded. Readback and retry remain attached to the original operation and episode, never a replacement row.

The existing caller, Query object, page, session, source, locale and credential fences also govern the selected
review, readback and retry. Exposure or presentation retirement discards the selection and fences late effects.
Returning from entry or management obtains a fresh admitted inventory page; keyboard return restores focus only
within that current visit. This extension preserves the reserved private SSR/hydration boundary above.

## Finite inventory return

Decision: keep at most eight accepted predecessor coordinates, current and one staged exact target in the existing
per-QueryClient named-route visit. Previous rereads the most recent retained predecessor; First deliberately reads
without a cursor, including on direct later-page visits. A direct visit, reload or new tab has no predecessor.
Next after Previous starts a new branch; First clears the predecessor chain. No old page body is retained.

Each explicit movement makes one existing native page read through the signed-in route guard and a fresh caller.
Only exact-target loader admission commits the staged history change. Failure retains the accepted chain and exact
target for existing route Retry; denial, closed, restartable failure and native waits keep their separate handling.
Sparse and empty terminal windows keep Previous and First. Coordinates stay opaque within the native 4096-character
ceiling; no offset or predecessor is inferred. Only the current native window of at most 20 rows is displayed.

The source transfers coordinates across the movement's caller-host remount while retiring each old address and
exact Query normally. Retired route matches do not recreate a disabled target Query while a new caller captures it. Reentrant activation cannot replace a staged target. Session success (including equal-data
replacement), error/removal, credentials, locale, source, QueryClient and actual visit replacement clear coordinates
and focus; ordinary query observation does not. Leaving the named route clears even a failed target. Late completion
and cleanup cannot alter a new owner's history. No additional session observer, private storage or entry authority
is introduced. Current-entry and selected-command admission remain owned by the preceding section.

Keyboard Next, Previous and First transfer focus to the newly admitted heading only while that movement still owns
the request and the reader has not focused or pointed elsewhere. Retirement clears the pending focus effect.
