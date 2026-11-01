# Space and Realm page lifetime

Each route page result is admitted by the existing QueryClient session observation before its bounded page read
starts. Its runtime binding retains the source identity and revision plus the exact session tuple; the serializable
loader envelope carries a tuple fingerprint and update counters with the route target, Realm, locale and credential
mode. A route cache hit from an earlier read is not promoted into a new visit: the
loader performs the existing page read once for the new admission. Page query functions reject results whose
session observation changed while the request was pending.

The browser reattaches a serialized loader admission only when the hydrated `sessionQuery` entry has the same
tuple fingerprint and update counters. If the server captured an unknown session and the anonymous public page is hydrated as
the browser performs its first session preparation, that one initial transition is adopted. Later
CSRF, readiness, sign-out and batched away-and-back changes retire the visit. A mismatched hydration snapshot has
no admission and causes the route to load its own page result; it does not borrow current credentials or accept
cached private data.

One mounted visit owns both Realm shelves. The board and publication cursors keep their independent native
continuations and bounded reads. Each saved continuation or update checks the visit before its read, after its
await and again before publishing busy, failure or merged data. Page admission changes remount both local lists;
unmount retires the old callbacks. Strict Mode's synchronous effect reconnection preserves the current visit while
changing its callback ticket.

Anonymous public HTML and its initial shelf rows remain renderable through ordinary session initialization. The
existing public/session query keys, server reads, redirect and head behavior, shelf order and native limits remain
unchanged. `SpacePage`, `spaceQuery`, `realmPageQuery` and `RealmShelf` keep their existing public call shapes;
the route loader envelope and optional shelf lifetime argument are internal wiring.

The composed acceptance is `apps/web/tests/space-page-lifetime.test.tsx`. Its pending-response cases resolve each
deferred server seam before observing completion. The controller defers the full acceptance and native verification;
this implementation contract's permitted foreground evidence is Web typing only.
