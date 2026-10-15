# Work read sessions

A read fences the units that determine its returned page. A write to another
Work, another rating target, or another avatar does not move that read. A change
to a selected head, publication, Structure, displayed media row, or admission
proof either replays a safe read or produces its typed moved, missing or
unavailable outcome. Dataset write sequence is diagnostic position, not a
session-wide consistency token.

Fuseki requests are separate transactions ([Jena remote transaction semantics](https://jena.apache.org/documentation/rdfconnection/#remote-transactions)). The session records each bounded
query's row token and each registered owner dependency when first consumed,
then compares those dependencies before returning. Repeated reads of the same
dependency must agree within an attempt. Empty selected relations are recorded
too, so a newly created selected row cannot escape the fence. Dependencies from
nested sessions belong to the enclosing attempt and must close before delivery.

Admission scans can inspect more candidates than the page returns. The session's
selection reader repeats that bounded admission operation and registers only the
returned rows and whether a continuation exists. Candidate-only descriptive
heads, payloads and summaries are excluded; an edit to them that leaves the
selected page and continuation unchanged does not replay. Every selection probe
still closes its authority and recovery checks. The returned rows retain their
head tokens, and subsequent displayed hydration registers its own dependencies.

## Position and continuation

A read reports its successful attempt's opening position, not a dataset-wide
snapshot. A cursor preserves its owner's selection, ordering, recovery and
admission basis; it grants no authority. Local dependencies let unrelated writes
proceed without invalidating the page. An owner that still needs a broader cut
retains that cut until its mutable inputs are registered.

## Fence ownership

The [read session](../../services/main/src/modules/work/read-session.ts) and
[read contract](../../services/main/src/modules/work/read-contract.ts) define
selected graph tokens, owner dependencies, byte/call/deadline limits and replay.
[Session fence tests](../../services/main/tests/work-read-session-fences.test.ts)
and [summary fence tests](../../services/main/tests/resource-summary-session-fences.test.ts)
cover selected and unrelated changes, including absence. Do not copy their
mutable inventory or numeric limits into this document.

## Caller inventory

The executable [consumer inventory](../../services/main/tests/work-read-consumer-inventory.test.ts)
owns caller coverage. Extend the responsible owner and its inventory when a
new consumer returns data that depends on mutable state. A query token fences
its bounded selection, not the whole repository or dataset.

## Replay bound and outcomes

Replay is for safe reads explicitly admitted by the owner. Mutation preflight,
internal builders and ordinary continuations do not acquire permission merely
by using a session. Attempts share the request budget; preserve movement as the
cause when it exhausts that envelope. The read-session implementation owns the
attempt limit, measured-cost admission and diagnostics.

## Thread and reply consumers

Thread/reply readers must close the same selected identity, disclosure and media
dependencies as other consumers. Their owner-specific cut remains until that
composition has equivalent registered dependencies. The consumer inventory and
integration tests provide the current coverage.
