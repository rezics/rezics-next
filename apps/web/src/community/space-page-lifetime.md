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

There is no current producer for a monotonically versioned native bearer credential that can be serialized with a page
without exposing a secret or adding session work. For example, a same-subject bearer rotation that retains the same
CSRF value and occurs entirely between independent QueryClient observations is indistinguishable from no rotation.
An away-and-back change observed by one QueryClient is retired by its event generation; an ABA completed before that
client begins observing cannot be proven from the final tuple or serialized counters. The implementation does not
claim either missing proof. A future stronger guarantee requires a non-secret monotonic session credential generation
from the existing session producer, which is outside this reader-only contract.

The composed acceptance is `apps/web/tests/space-reader-compatibility.test.tsx`. It is authored but remains UNRUN under
the current execution policy. The existing native bounds remain in `realm-pages.test.ts`, `realm-publications.test.ts`
and the read-only `realm-pages-cost.test.ts`.
