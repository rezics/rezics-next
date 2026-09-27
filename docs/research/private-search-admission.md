# Private search admission decision

## Selected boundary

The first private lane reads one exact native Contribution draft body. Main
checks Account and Access before graph or Lucene work and binds the native head,
index and private-write positions before delivery. The body has a separate
Lucene field, so hidden postings do not change the public field's statistics.
The result has no score, snippet or facet. The typed adapter and limits live in
[private search](../../services/main/src/modules/content-publication/search-private.ts)
and the [route](../../services/main/src/routes/search.ts).

A WebSocket result is offered only after Access arms a durable send marker and
the final native position check succeeds. A fresh challenge in the result must
be returned by the peer before Access records `delivered`. An offered frame
without that receipt becomes `unconfirmed`: the peer may have buffered it.
Strong closure waits for that terminal outcome. The receipt proves direct peer
receipt, not display by a UI or forwarding by a terminating proxy. The
[Access bridge](../implementation/authorization-bridge.md)
describes the owner handoff.

## WebSocket delivery-fence probe (2026-09-25)

Pinned Bun/Elysia loopback probes showed that `send`, `drain`, a matching
`pong`, and `close` do not jointly prove safe cancellation of an offered frame.
A paused client read buffered result bytes after its write side closed and the
server saw `close`. A wrong or unsolicited `pong` can arrive before result
receipt. The selected protocol therefore uses an exact client challenge receipt
and retains a possible-delivery state after an ambiguous offer. The
[socket probe](../../tests/qa/unit/private-websocket-delivery-fence.test.ts)
and [private native tests](../../services/main/tests/search-private.test.ts)
hold the executable counterexamples.

The Elysia `afterResponse` hook ran before a gated HTTP body was produced, so
it cannot settle a delivering Access lease. Bun stream flush and Node HTTP
`finish` establish progressively narrower local send boundaries, not peer
receipt or proof that already queued bytes cannot be read. The
[HTTP probe](../../tests/qa/unit/private-node-http-delivery-fence.test.ts)
records that distinction. The HTTP POST names the socket when delivery owners
are configured; without them both paths remain unavailable.

Broader private fields, multi-Contribution search, whole-request Account/Access
costs and deployed proxy receipt meaning still need qualification. They are
explicit [pending SEARCH subcases](../../scripts/qa/cases/search.ts); passing
the native draft lane does not qualify them.
