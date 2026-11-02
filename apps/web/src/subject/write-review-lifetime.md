# Write review preparation lifetime

`WriteReviewAction` captures the browser's original QueryClient, session cache revision and subject destination
before it starts the existing first-page My Realms read. A visit is ready only when that exact cache entry has a
successful signed-in record with a subject. A missing CSRF token remains a valid read-only visit.

The private page and board-choice server boundaries each return reader provenance from the same prepared Request
and credential used by their unchanged read. The membership boundary reuses `loadMyRealms` once and reads its
existing per-Request subject and CSRF maps after that read. The board boundary prepares once, compares the actual
reader, then passes that exact credential into the existing native board reader. Both boundaries return only the
reader subject and a SHA-256 CSRF fingerprint. They never send bearer or CSRF values to the browser, and expected
identity is only a comparison value.

One QueryCache observation retires active visits synchronously on every successful session replacement, including
equal data, error, removal, identity/readiness changes and batched away/back writes. Fetch status and observer
notifications preserve healthy work. A visit also binds subject, title and locale. Its read tickets fence the queued
server call, response, private state update, failure callback, retry ownership, finalizer and automatic one-choice
navigation. A pending ticket is released only by its own finalizer. The mounted connection disconnects immediately;
a microtask retires a final unmount while allowing StrictMode's synchronous effect replay to reconnect the same
visit without duplicating its read.

The original 20 Realm page, review-board pagination and disclosure filters, route destinations, empty states,
public component props and subject-route mount remain the existing interface. Realm and board discovery failures
stay in the expanded entry and expose the existing localized “Try again” action, which begins a fresh reader-ticket
read. No reads, cursors or credentials are added to the kernel boundary.

The connected regression is `apps/web/tests/write-review-lifetime.test.tsx`. It uses the actual QueryClient,
component, session preparation, My Realms and board server boundaries; only the native transport and session store
are controlled. The new regression is authored UNRUN, as required by the task execution policy. Native and broader
browser acceptance remain integration obligations.

## Cost

### Review-entry preparation and chooser

- Touches: one existing first-page My Realms request and the existing bounded, paginated board-choice reads for the
  first 20 memberships, owned by one browser caller generation.
- Bound: no second preparation, membership read, polling, per-board request or change to native pagination and
  disclosure rules.
- Growth check: connected repeated-replacement and stale-lookup assertions preserve original calls and reject
  obsolete queued reads, private publication and navigation; UNRUN.
