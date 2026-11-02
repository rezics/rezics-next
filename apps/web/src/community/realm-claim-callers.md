# Realm claim caller lifetimes

The review and requester status panels bind private reads to one Realm target and one current browser session-cache
generation. Review also binds its approval intent to the original request row and CSRF token. The native readers and
approval endpoint remain the only permission authorities.

`realm-claim-caller-lifetime.ts` observes the existing `['session']` QueryClient entry. It records each data update,
including same-account CSRF changes and away/back transitions that React batches into one render. A visit is ready
only when `useSession` and that cache entry agree on a signed-in subject and nonempty CSRF token. Unknown, signed-out,
preparing, missing-token, target-change, cache-replacement and unmount transitions retire the visit. Retirement
withholds its queue, claimant, confirmation, receipt or status immediately and makes its queued work obsolete.

Every controller operation checks its visit immediately before each adapter read or send and after every await. A
retired prepare or retry cannot start an approval; an approval that resolves late cannot publish its receipt or start
the post-approval queue read. The review adapter closes over its original CSRF token. Same-visit uncertain retries
keep the original Realm, request, source episode and idempotency key, including recovery after the request leaves the
pending queue. Retirement hides the caller without determining whether a remote command was applied. A new visit cannot
inherit that intent.

Claim controls join the existing page departure owner, including sibling authoring work. Sending and uncertain
requests or approvals protect the original immutable intent; a reviewed, unsent approval confirmation is protected
until deliberately cancelled. Stay keeps the same caller and confirmation without native I/O or a new key. Confirmed
Leave retires every registered claim caller synchronously before navigation continues, so late results cannot expose
a receipt, refresh the old queue or restore recovery. Leaving only retires local work: a command may already have
applied and is neither cancelled nor rolled back. Session/cache-generation, CSRF and Realm replacement immediately
invalidate protection through the private lifetime and never transfer recovery.

Decision: a validated receipt releases command protection immediately, including while the existing post-approval
queue refresh is pending; reading, preparing, untouched management and settled receipts add no protection.
An isolated claim boundary delegates session retirement to its private caller lifetime; an existing authoring page
owner remains shared. Registration and rendering add no native reads or sends, storage, timers or background work.
Claim registrations reuse the shared per-work Leave callback; other page owners retain their own departure copy.

The review route binds its loader page to the Realm and the signed-in subject, session query update count and update
time. A client loader also carries its QueryClient source identity. The subject and cache markers transfer authentic
server-rendered loader data through initial hydration without copying the CSRF token into loader data. Once hydrated,
a replacement session, target, QueryClient or disconnected visit must perform a new current read before showing private
data. The page is consumed once. Requester status still
performs one foreground point read per current mount or explicit check. Sparse reviewer pages retain their exact
opaque continuation and advance by one explicit native page.

The bounded costs remain one supplied page of at most 20 review rows, one read for deliberate prepare, one original
approval command per explicit confirmation or uncertain retry, and one first-page refresh after a current approval.
Requester status remains one point read per foreground check. There are no timers, polling, hidden refill, extra
endpoint or local authorization rule.

`tests/realm-claim-callers.test.tsx` composes both actual panels with a real QueryClient session cache and deferred
adapter results. The review and status unit suites retain their native transport, closed-payload and behavior oracles.
