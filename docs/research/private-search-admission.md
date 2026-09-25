# Private phrase search admission boundary

This is the implementation brief for the first bounded SEARCH11/SEARCH12 lane.
It does not qualify private full-text until the owner-boundary tests pass.

## Selected first lane

The implemented candidate starts with one native TextContribution draft. Main
owns its current `draftHead`, immutable RevisionAnchor and object manifest. Its
guarded create/edit command projects one body MatchUnit for that exact head into
`urn:rezics:search:private`, replacing the prior unit on edit. The Lucene map
uses a distinct `rv:privateSearchBody`/`privateBody` field. The internal query
adapter checks the exact object bytes against the private graph literal and a
concrete-subject Lucene posting before a zero-or-one phrase result. It returns
stable unit identity without score, snippet or facet. Missing source,
projection, posting or a moved head/index fence makes the adapter unavailable.

The candidate adapter accepts a 2–80 character phrase, one Contribution, one
body field and one unit. Its matching phase has a 1,500 ms abort timer, at
most 10 Fuseki calls and a 1 MiB Fuseki/response bound. The internal admitted
path adds a two-call native position recheck under a separate 1,500 ms budget
after Access begins delivery and before Access arms the send. Access admission
precedes every graph and Lucene call on that path. These remain phase limits;
Account and Access calls have not yet been placed under one whole-request
deadline. The public
`/v1/private-queries` profile is currently fail-closed with a typed 503 and
does not call Account, Access or Jena. The installed Elysia `afterResponse`
hook may run before socket delivery completes; using it to finish a delivering
Access lease could let a strong scope close acknowledge while response bytes
are still in flight. A proven send-completion/cancellation fence is required
before this route can return results.

## HTTP delivery-fence decision (2026-09-25)

The checked-in runtime pins **Bun 1.4.2** and **Elysia 2.0.0-beta.16** in the
[toolchain](../development/toolchain.md#api-and-clients). In the installed
Elysia artifact, `dist/handler/fetch.mjs` schedules `afterResponse` with
`queueMicrotask` from request handling. A loopback test using the pinned
versions holds the body producer behind a barrier: the hook runs while no
sensitive body byte has even been produced. The same order holds when that
client disconnects before the barrier opens. The focused
[`private-delivery-lifecycle.test.ts`](../../tests/qa/unit/private-delivery-lifecycle.test.ts)
ran through `yarn test` with two passing cases. Thus the hook's name and the
[Elysia lifecycle description](https://elysiajs.com/essential/life-cycle#after-response)
cannot be used as a per-response send-completion guarantee for this build.

[Bun's direct-stream documentation](https://bun.sh/docs/runtime/streams#handling-backpressure)
and the installed `bun-types/globals.d.ts` describe `write()` as accepting a
chunk and `flush(true)` as waiting for the destination's **internal buffer** to
drain under backpressure. Neither defines a successful per-response callback
after the HTTP send buffer has emptied, including the final framing bytes.
[The Bun 1.4.2 HTTP stream sink](https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/src/runtime/webcore/streams.rs)
resolves `endFromJS()` when uWS ends or accepts the response and then drops its
abort callback for that HTTP/1 response. It may resolve `0` for an already
closed sink. This source confirms an internal write boundary, not a callback
for subsequent kernel/peer delivery or abort. The pinned
[`RequestContext`](https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/src/runtime/server/RequestContext.rs)
has native `onWritable`/`onAbort` paths, but does not expose their final
per-request state to this Elysia route.
Stream `pull()`/`close()` says when the JavaScript producer finished; an abort
signal or `cancel()` is a negative signal, not proof that a normal response has
drained. [`Bun.serve`'s server lifecycle](https://bun.sh/docs/runtime/http/server#server-lifecycle-methods)
offers a drain promise for stopping the whole server, not for one response on a
running replica. This is an API-contract finding, not a claim that direct
streams never drain correctly. A future transport may use them only after a
pinned-source and loopback proof of both completion and abort paths.

For the current HTTP route, retain `503 private_search_unavailable` with no
Account, Access or Jena call. The Access
PostgreSQL test separately proves that two registries serialize `begin` against
scope/principal closure and count a `delivering` read until explicit terminal
finish. That is the database half only: an HTTP adapter must still begin just
before first sensitive byte, retain the durable lease through verified send
completion, and on timeout/disconnect stop the socket before recording `aborted`.
If the process dies while delivering, the row remains pending; expiry alone
cannot authorize strong closure. A second replica may acknowledge closure only
after its pending-read count reaches zero. Run the combined two-replica race
with paused and disconnected clients, normal and maximum size results, expiry,
process death and recovery before enabling the route. A dedicated transport with
per-response write-complete and abort events is another candidate, but requires
a reviewed toolchain/topology change and the same combined test.

## WebSocket delivery-fence probe (2026-09-25)

The pinned Bun 1.4.2 `ServerWebSocket` exposes `send`, `ping`, `drain`, `pong`
and `close`; Elysia 2.0.0-beta.16 exposes those through its opt-in
`elysia/websocket` capability. Bun's installed `bun-types/serve.d.ts` says a
positive `send()` return is a byte count, `-1` means backpressure and `0` means
dropped. Its `drain` callback says a connection under backpressure is ready for
more data. None is a peer receipt event. Elysia's installed
`dist/ws/context.mjs` passes `send` and `ping` to Bun and
`dist/ws/route.mjs` wraps `pong` and `close` lifecycle callbacks.

The focused [loopback test](../../tests/qa/unit/private-websocket-delivery-fence.test.ts)
ran with `yarn test tests/qa/unit/private-websocket-delivery-fence.test.ts`
on Bun 1.4.2 and Elysia 2.0.0-beta.16: **6 pass, 0 fail**. A raw WebSocket
client paused its receive callbacks while the server's result `send()` and
subsequent nonce `ping()` both returned positive values. On resumption it read
the complete text frame followed by the ping frame, sent a masked matching
pong, and the Elysia server received that pong. This establishes the observed
normal small-result order. For a protocol-compliant peer, a fresh matching
pong is evidence that it received the later ping; it can serve as a
**peer-receipt candidate** only after proving the entire bounded result frame
precedes that ping. [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-5.4)
allows control frames inside fragmented messages, and
[Section 5.5.3](https://www.rfc-editor.org/rfc/rfc6455#section-5.5.3)
allows unsolicited pongs. A nonce prevents stale or guessed pongs; this first
small-result case alone does not establish larger frame ordering. A pong also
does not prove that client application code has consumed or displayed the
result, so that meaning of delivery needs an explicit client contract.

The abort path fails the required fence. After a positive `send()`, a paused
client half-closed its TCP write side. Elysia's server `close` callback fired;
the client then resumed and read the sensitive result frame from its buffered
receive side. The separate abrupt-disconnect case produced `close` without a
matching pong. Thus **neither `close` nor `terminate()`/timeout followed by
`close` can be assumed to prove that the client cannot consume previously sent
result bytes after an Access lease is marked `aborted`**. The half-close case
is an observed counterexample for `close`; the `terminate()` statement is an
API-contract limit, not a claim that the probe observed a later frame after
`terminate()`.
The [WebSocket close rules](https://www.rfc-editor.org/rfc/rfc6455#section-5.5.1)
also allow message completion around close and do not define a server event
which certifies that the peer will never read already received bytes.

There is consequently no demonstrated terminal transition for every sent
result. A safe candidate would keep the durable `delivering` row pending until
a validated receipt, and only mark `aborted` if no sensitive send began or a
separately proven cancellation fence exists. A client that disconnects before
receipt, withholds pong, or outlives a crashed Main process can leave the row
pending indefinitely; lease expiry cannot make strong closure safe. This
blocks the WebSocket route as a replacement for the HTTP route. Keep
`/v1/private-queries` fail-closed. Before enabling any future candidate, qualify
its maximum-size frame ordering in the deployed path, client receipt
definition, terminal recovery after disconnect/crash, two-replica Access
closure race and Jena head/index fences in one combined test.

The follow-up loopback case sent a **1,048,576-byte uncompressed result** while
the raw client's receive callbacks were paused. Bun 1.4.2 emitted one complete
WebSocket text frame, followed by the nonce ping; the client reconstructed the
whole result and only then answered that ping. This is direct-peer loopback
evidence for that pinned size and handshake, not a source-level guarantee that
every compressed, fragmented or backpressured send will preserve the same
frame boundary. The test parser accepts fragmented data frames and requires the
final fragment before the ping. Its observed count was one frame. The raw
client could also send a wrong pong while its receive callbacks were paused;
Elysia invoked the server `pong` handler before the client read the result.
Another test sent an unsolicited pong before any result or ping, and Elysia
likewise delivered it to the handler. A transport must bind a fresh nonce to a
single outstanding lease and result, ignore every early or nonmatching pong,
and never treat the mere `pong` callback as completion. A 1 MiB result remained
readable from the paused client's buffer after its TCP half-close had caused
the server `close` callback, confirming the abort counterexample at the bound.

The precise successful boundary is **receipt by the direct WebSocket peer of
the ping after a preceding complete result frame**, conditional on ordering
for the actual send and a fresh matching pong. It says nothing about a browser
`message` handler having run or a user seeing the result. If a reverse proxy
terminates WebSocket, it proves that proxy's receipt, not the browser's; any
deployment path would need its own forwarding and buffering proof. It also
does not let a server withdraw bytes the peer already buffered. For this
contract, an ambiguous send after `beginContributionSearchDelivery` must stay
durably `delivering`; the [Access bridge](../implementation/authorization-bridge.md)
requires strong closure to return pending rather than acknowledge completion.
The two-registry Access test shows `pendingReads = 1` for a delivering row
after closure and still after expiry. This is safe as a refusal to claim
closure, but it has no automatic liveness: a half-closed connection cannot
return a receipt, process death loses the socket, and a client may withhold
receipt indefinitely. No WebSocket route was enabled by these probes.

### Durable receipt candidate and unresolved recovery state

Access migration 010 adds a monotonic `send_started_at` marker and SHA-256
receipt digest. The transport must commit this marker **before** invoking its
first sensitive send. `aborted` is then forbidden for that row, including after
timeout, `close`, lease expiry or process death. A `delivered` finish requires
the matching 256-bit receipt challenge; it remains available after lease expiry
because the send was armed during the lease. An unarmed admission or delivery
may be aborted. The recovery manifest now covers these rows, and
`ACCESS_DATABASE_URL=... yarn access:pending-search` lists up to 100 unresolved
deliveries with their send markers, without exposing challenges or result bytes.
The Access recovery fence refuses reopening while any `delivering` row exists.
For an upgraded 009 database, migration 010 retains any historical `delivered`
row with null send marker and receipt digest. The terminal-send CHECK is
`NOT VALID` for those prior rows, but rejects every new or updated delivered row
without a marker. The migration test exercises this exact upgrade boundary.

The internal `PrivateSearchReceiptSession` constructs one bounded WebSocket
result message with a fresh challenge as its final field. A client receipt
echoing the exact challenge and lease identity is accepted only after the
server has armed the Access row and offered that message to the transport.
The loopback test shows a full result followed by a matching client receipt,
ignores a wrong receipt, and retains an armed row when TCP half-close reports
server close before buffered result bytes are read. This is a direct-peer
receipt protocol candidate; it does not certify UI display, proxy forwarding
or terminal cancellation of an ambiguous send. A compromised client that learns
the challenge could also echo it without displaying the result. The HTTP route
continues to return 503. SEARCH11/12 still need a deployed-path proof, broad
Content mapping, two-replica live owner race and a product decision for rows
that can remain pending permanently after an unacknowledged send.

The admitted-read candidate orders Access admission, native matching, Access
delivery begin, a second native head/sequence/generation/JVM/write-epoch check,
then the durable Access arm and frame offer. The unit barriers move the native
draft head or private index write epoch between matching and send: both abort
before arm and offer no frame. A definitive Access arm denial also aborts the
unarmed row; a lost owner response stays unresolved because the marker may
have committed. These checks close the waiting-result gap, but the final Jena
read and Access arm are separate owner operations. A graph edit in that gap
still lacks a serialization fence, so this evidence does not open the route.

## Node HTTP response boundary probe (2026-09-25)

The adopted Node 26.8.2 runtime has a more specific server-response event than
the pinned Elysia/Bun route. [Node's `ServerResponse` documentation](https://nodejs.org/api/http.html#class-httpserverresponse)
defines `finish` as the final response headers and body segment handed to the
operating system for network transmission; it explicitly does **not** establish
client receipt. Its `close` event means either completion or premature
termination. A `close` observed before
`finish` is therefore a negative signal, not a completion receipt or proof that
the peer cannot read bytes already queued. [RFC 9293, Section 3.6.1](https://www.rfc-editor.org/rfc/rfc9293#section-3.6.1)
allows each TCP direction to close independently and buffered data to arrive
after a close operation.

The focused [Node loopback probe](../../tests/qa/unit/private-node-http-delivery-fence.test.ts)
runs an actual Node 26.8.2 HTTP server as a child of the repository's `yarn test`
unit command. Its four cases passed: ordinary complete response; a paused raw
TCP client whose read callbacks remain at zero when `finish` fires and later read
the full result; premature disconnect after a prefix write with `close` before
`finish`; and a maximum 1 MiB body that reaches `finish` while client callbacks
are still paused and is read afterward. This is evidence for a **Node-process
send-completion fence** at the application-to-OS boundary. It does not show that
the network drained, that the peer received the bytes before a strong closure,
or that its application consumed them. A loopback client that resumes reading
after `finish` is already a counterexample to treating `finish` as a client
consumption fence. A `close` before `finish` also cannot certify that no
previously sent bytes remain readable.

The current [search contract](../contracts/search.md) says the network must
have drained the response body, and the
[Access bridge](../implementation/authorization-bridge.md) says expiry alone
cannot prove the network response stopped. `finish`'s application-to-OS handoff
is narrower than that wording. Consequently this candidate does **not** yet
justify finishing or aborting a delivering Access lease, acknowledging strong
closure, or enabling `/v1/private-queries`. The blocking decision is whether
the guarantee can explicitly be stated at the Node-server send boundary, with
already handed-off bytes excluded from the closure guarantee, or whether a
stronger peer/network boundary is required. The latter has no proof from these
Node events; `close` cannot provide the missing cancellation proof.

If the owner explicitly chooses the narrower server-send guarantee, a dedicated
Node transport would need to own the actual client-facing response socket.
Routing its result through Bun or a buffering reverse proxy would move `finish`
to an upstream hop and invalidate the claimed public boundary. It would obtain
the bounded candidate result and a durable Access admission through trusted
owner calls, recheck the exact authority/content/index fences, call
`beginContributionSearchDelivery` immediately before the first sensitive byte,
then choose one terminal path from response events installed before writing:
`finish` records server-send completion; `close` before `finish` destroys the
socket and records only a separately justified cancellation outcome. Crashes or
ambiguous partial sends must leave the durable delivering row pending under
the recovery hold. The full two-replica closure, paused and disconnected client,
timeout, 1 MiB, process-death/restart and Jena fence test remains required before
any endpoint activation.

Access owns the principal, acting-subject representation, grants, scope epoch
and finite read admission. Main owns this native draft's exact source, graph
head and index generation. The existing `canReadContributionDraft` boolean
ends its transaction before matching and does not provide a delivery fence.
Broader private Content search still needs a mapping from PostgreSQL Content
heads and revisions into Access-scoped MatchUnits, including multi-field and
up-to-32-unit admission, source reconciliation, erasure and whole-request
owner-call bounds. This candidate does not qualify SEARCH11 or SEARCH12.

## Why the existing public path cannot be reused as authorization

The installed assembler indexes public MatchUnits. Jena's
[`TextQueryPF`](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextQueryPF.java)
and [`TextIndexLucene`](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextIndexLucene.java)
show graph and concrete-subject constraints reaching the Lucene adapter.
A later SPARQL `FILTER` or post-hit Access check cannot prove that hidden units
were excluded before hit collection. This is a source-level inference that
requires a runtime test against the pinned image and query plan.

A separate private named graph in the same index does not isolate ranking
statistics for a shared field. The candidate maps the private body to its own
Lucene field so private documents do not enter the public `body` field's term
statistics. Jena pins Lucene 10.3.1 in its
[POM](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/pom.xml), and
Lucene's [BM25 documentation](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/similarities/BM25Similarity.html)
uses collection term/document statistics. The first private lane therefore
does not return a score. A future scored lane must prove that changing hidden
documents cannot change another user's visible score or ordering.

## Falsification gates

- SEARCH11: put a matching hidden field beside a visible nonmatching field,
  then reverse visibility. Compare hits, count, ordering and every diagnostic
  surface. No private literal may enter the public graph or projection.
- SEARCH12: place barriers before Access admission, after the native draft head
  resolution, during Lucene read and before delivery. Race scope/principal
  closure across two Main replicas, expiry, restart and Access outage. No result
  may be delivered after a completed strong closure.
- Rebuild from currently eligible exact Content revisions after reconciling
  disclosure and erasure. Check RDF and Lucene membership, source positions,
  projection lag and changed generations; missing bodies keep search unavailable.
- Trace the entire request, including retries and nested owner calls, against
  the declared time, call, byte and hit budgets. Test a hidden-match-heavy
  corpus so the lane cannot pass by filtering a public top-K afterward.

This lane is a required step toward the retained private-search capability,
not acceptance of broad private graph search or private paging.
