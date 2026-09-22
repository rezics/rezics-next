# Client synchronization and offline editing

## Local state and authority

Clients may keep private drafts, pending commands and explicitly cached readable
content. Local state is not another authority for public facts. Caches bind
resource/revision, context, language, disclosure and freshness. An offline cached
permission never authorizes a later server mutation. Private credentials and
controller graphs stay outside public client artifacts.

## Editing protocol

The initial contract uses an identified base revision and validated patches or
bounded payload replacement with expected-head CAS. Persist local operation IDs
before sending. On reconnect, authenticate, refresh authority/target state and
replay eligible commands with the same idempotency keys. A lost response reconciles
its receipt rather than creating another edit.

Conflicts retain base, local intent and server state for compare/retry/explicit
merge. Automatic merge requires a qualified operation/profile that preserves
block/occurrence identity and validates the result. Realtime collaborative editing
can add an admitted merge protocol; keystroke/presence transport is never the
publication history authority.

## Realtime updates

Events carry sequence/source positions and invalidation hints, not permanent access
grants. Reconnect detects gaps and retrieves bounded snapshots/deltas under current
disclosure. Selection/context changes invalidate relevant query caches; exact
references remain exact. Coalescing must preserve a recoverable frontier.

## Privacy and experience

Agent changes in one task/tab do not retarget another's queued command. Show queued,
syncing, conflicted, denied and completed states. Cancellation explains whether an
effect already committed. Apply cache retention/erasure policy without claiming
the server can recall independent copies previously delivered.

Test offline/remote edit races, revoked authority on reconnect, timeout retry,
context switch, missed events, deleted blocks and expired cursors. Controlled
protocol tests and separately authorized client/rendered tests qualify different
aspects of this contract.
