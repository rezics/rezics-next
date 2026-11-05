# Character and People result windows

Character and People navigation preserves the complete executed request through `characterPersonHref` and the
receiving parser: mode, name, ordered work IDs, exact optional role, ordered languages, threshold and native sort.
Draft selection edits hide results until Apply. The labelled-selection module continues to own work and role choices.

Decision: this route supplies exact first address, cursor, address construction, native status/checkpoint and public
reader currentness to Search's shared window adapter; it never implements another history or focus mechanism.

Decision: Character and People navigation uses admitted cursor addresses for Previous and First; browser return runs
one fresh native read, and browser history retains no result rows or result-derived data.

The route's query observer dispatches one fresh native read per visit. There is no additional loader read under an
unknown reader key. The public retiring reader lease owns dispatch and completion; a transport that ignores abort
cannot publish a retired result. While a router transition still renders old match props, those props cannot dispatch
against the new browser address. Native requests and responses are private and no-store.

An opaque cursor has no known predecessor or absolute window number. First means the exact executed request without
its cursor. A sparse ready page with a continuation shows the sparse-page message, rather than terminal no-results.
Preparing and unavailable reads permit deliberate retry of the same address. Native restart offers First and never
automatically reads it. Result rendering and native destination construction remain in `DiscoveryResults`.

The route binds the public Search window adapter with its exact address builder, currentness, readiness, recovery and
checkpoint. The visit owner is keyed by the cursor-free executed form so cursor changes preserve admitted browser-entry
history while replacing the query reader. Shared controls build every destination from the route's href function;
Previous, First and browser return each execute one fresh native query.
