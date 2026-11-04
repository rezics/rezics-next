# Space and Realm page lifetime

Each original route read captures the expected QueryClient session observation before it starts. The server action
returns a serializable `readerOrigin` from the same `prepareSession` call and credential passed to the unchanged native
read. The client compares that origin with the captured expected reader. An absent subject remains unidentified; the
current browser session is never copied onto a response to make it appear valid. Anonymous reads remain anonymous.
The envelope contains no bearer, access token, seal or raw CSRF value. A read-only signed-in session with a null CSRF
value remains eligible when its subject matches.

The page query cache stores `{ page, admission }`, and the route loader returns the same admission with the page. This
keeps the original read identity and actual reader origin through route serialization, query dehydration and hydration
into a separate browser QueryClient. The runtime reconnects there by comparing the serialized actual origin and
expected session fields with the hydrated session. Source IDs, generation counters and the CSRF digest are comparison
inputs only; none authenticates a reader or proves that a different QueryClient observed every intervening update.
The digest is only used to reject a changed cached CSRF value.

Each original route attempt keeps its own runtime. Before its BFF read, the query function binds the exact Query object,
query key, baseline data-update count and TanStack cancellation signal. Its returned envelope identifies the query
function result, but does not certify what the cache committed. A cache observer records the committed value from the
exact Query's successful update notification after structural sharing, and only when that live Query, signal and one
expected data-update count still belong to the operation. The committed Query data reference and count then remain the
ownership witness; the raw envelope reference is never compared with `query.state.data`.

After each await, the loader checks the original session observation, route abort, exact Query, query-function envelope
and committed data generation. Equal data writes still advance the Query update count and retire the original result.
A synchronous cache subscriber that changes the session, removes and recreates the Query, or replaces its result retires
the old attempt before the loader can return a page or throw the Realm's canonical 307. Structural sharing may retain
unchanged page subtrees while copying the envelope root; this preserves a healthy own commit without accepting another
success, removal or successor Query as its result.

Router abort races the route loader's wait and remains attached to a successfully published page until its mounted
lifetime retires; it does not cancel a shared QueryClient fetch. The attempt is permanently retired on abort, and its
late transport result cannot become that loader's page or redirect. Query-owned cancellation or exact-query removal
can receive one fresh eligible attempt while the route remains active. The replacement check compares the committed
data generation when the original Query still exists, and recognizes a successor Query with installed data or an
active fetch without overwriting it. Recovery is bounded to one retry and required read errors pass through. Mounted
route effects allow one invalidate/refetch for each current route and session observation. They check the current
admission immediately before acting so an older effect cannot invalidate a successor.

A same-QueryClient observer advances its private generation for successful session data replacements (including equal
data), session query errors and removal. Ordinary fetch starts, observer notifications and StrictMode effect replay do
not advance it. A private page admission is retired after any observed generation or session tuple change. A public
anonymous loader may adopt the first successful session refresh when it began from an unknown session; subsequent
observed replacements retire that visit. The Space route can then load its existing session page for a signed-in reader.

Each board and publication continuation takes its own ticket before calling its existing server action. A ticket binds
the page visit, current QueryClient observation, shelf generation, cursor window and actual reader origin. The result is
checked before it changes busy/failure state, merges items, advances the cursor or restarts a list. A replacement
generation can run while an older transport is still pending; the older callback cannot clear its busy state or publish
rows. Board and publication reads retain independent cursors and their existing limits, order, disclosure filters and
subject-summary reads.

Keyboard continuation focuses the first newly admitted visible entry, or the named shelf heading for a sparse page;
moving focus or using a pointer cancels the handoff, and only the accepted current shelf read may announce its result.

There is no current producer for a monotonically versioned native bearer credential that can be serialized with a page
without exposing a secret or adding session work. For example, a same-subject bearer rotation that retains the same
CSRF value and occurs entirely between independent QueryClient observations is indistinguishable from no rotation.
An away-and-back change observed by one QueryClient is retired by its event generation; an ABA completed before that
client begins observing cannot be proven from the final tuple or serialized counters. The implementation does not
claim either missing proof. A future stronger guarantee requires a non-secret monotonic session credential generation
from the existing session producer, which is outside this reader-only contract.

The composed acceptance is authored in `apps/web/tests/space-page-lifetime.test.tsx` and
`apps/web/tests/space-reader-compatibility.test.tsx`; its assertions remain UNRUN under the current execution policy.
It retains actual route loaders, default structural sharing over existing plain cache data, exact successful commit
counts, QueryClient cache notifications, mounted and bounded loader recovery, server preparation and the deferred native
client seam, alongside external equal replacements, observer/fetch activity, rerenders, StrictMode reconnect, initial
public session refresh, null-CSRF reads and the existing shelf limits and serialization checks. The recreated-Query
case captures committed data before removal and installs that same data in the successor. The existing native bounds
remain in `realm-pages.test.ts`, `realm-publications.test.ts` and the read-only `realm-pages-cost.test.ts`.

Private first-render provenance remains unresolved. Serialized comparison fields do not prove the actual cookie or
authorization credential, independent-cache provenance or unobserved credential history. This change does not alter
private server-rendered output, add a trusted generation or raw credential transport, or add preparation/native reads.
The existing `createRoot` serialization cases are not `renderToString`/`hydrateRoot` first-paint proof; the private
first-render producer/SSR contract remains deferred.

## Realm home source boundary

The mounted Kernel home now composes a current viewer observation with its container, presentation and shelves.
Its anonymous observation is `{ state: 'anonymous' }` with sign-in advice. Its signed-in observation carries native
readability, membership episode and participation, plus current entry, management and leave advice. It does not
supply join or claim advice. The installed generated Client declaration still omits home, boardShelf and
publicationShelf. The prepared consumer and its local operation seam do not establish generated default-route
availability; the normal producer and controller retain generation and native acceptance.

Membership and each command require their own explicit composed native advice. Separate standing, participation,
setup or claim reads cannot manufacture that observation. Missing publication support remains unavailable; it must
not fall back to per-publication Subject hydration, another DTO or an endpoint assembled by Web. The legacy fixture
helpers retain their original reads until the generated replacement is installed.

Decision: a fresh native response starts both shelves again, while replacing or mutating the original heads,
selected presentation or viewer observation permanently retires the complete visit.

The prepared consumer checks the carrying Space and Realm heads, active lifecycle and selected media and rules
revision before presenting them. Native concealment may retain an empty optional presentation even when a selected
reference is set. Orphan identity remains readable when the native read permits it; its governance stays read-only.
The original heads and selected references survive route serialization alongside the native observation.

The route lifetime captures the exact page, container, native source, lifecycle, presentation and observation
references before mounting. Value snapshots also reject in-place changes. An outer page copy, equal nested
replacement or removed observation cannot transfer a response into that lifetime. The injectable rendering boundary
uses the same source comparison and retires old pages permanently; a fresh response remounts both shelves and their
controllers. Credential, locale, route and operation replacement also require a fresh response. Existing route
admission remains required for session-cache generations, pending continuation tickets, lifecycle retirement and
hydration; this local boundary supplies neither native viewer currentness nor private first-paint proof.

## Selected shelf return

Decision: Realm and carrying Space routes consume only `node=boards|publications` and that shelf's opaque `cursor`; a row fragment restores eligible focus, while the other shelf retains its own reader and focus owner.

The selected return window is read once through the existing shelf reader, replacing that shelf window without
refill or a scan of earlier pages. Row links quote the cursor that actually supplied their row, rather than the
next frontier. Publications use the existing Subject `via` return; Board entry and thread creation use the
existing `returnTo` validator. The existing Board reading history state carries that admitted return through a
thread and back. Neither address supplies command authority. Original Subject-region Realm/node/cursor returns
continue to use their existing consumer.

Only supported public route locators are forwarded by outer follow, membership and claim call sites. Auth's
existing server login return consumes these addresses; its short-lived recovery cookie remains query-free.
A recovered consumed login callback can therefore restart at the carrying page instead of restoring a cursor.
No browser storage, private command operands or automatic participation are added.

A fresh page object remounts the outer visit even when values compare equal. Changed shelf source, account,
credential, route or frozen state retires its pending return effects before replacement render. A late read may
not navigate or move focus after retirement. Missing, denied and stale windows keep the native shelf's explicit
retry/restart controls; focus restoration never takes focus from an intervening user action.

The remaining acknowledged in-page participation return needs an outer source-bound completion seam from the
existing command owners. Their current invalidation replaces the page and restarts its ephemeral selection.
This implementation does not retain that selection across an unqualified replacement or intercept a command.
The continuation also adopts Content's approved community mount once its public render slot is available.
