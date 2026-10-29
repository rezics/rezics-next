# Imports erasure participant audit

The importer has no account-owned persisted payload in the reviewed storage.
Its SQLite `RecordBindings`, `RunStore`, `RecordStore`, and `ImportSession`
schemas are keyed by source, external record key, run, or process ownership;
they contain no platform account owner or account locator. Stored candidate
and media identifiers, source projections, exact command and acknowledgement
bytes, receipts, counts, and generation state support source reconciliation.
The automated account key is an operator-managed file, while bearer
credentials remain in memory. Source input and operator configuration are
external to application storage.

The account key used for API authentication does not make importer state
personal payload for that account. An imports erasure effect therefore
acknowledges `none` through the Access coordinator after receiving the actual
account tombstone event. It neither reads nor mutates importer SQLite and does
not restore the deleted initiator. The participant is a server kernel work
module; the importer CLI has no PostgreSQL dependency, privileged write,
deletion hook, or access to operator files.

This disposition covers only importer-owned state. Author, editor, uploader,
delegate, operator and acting-human evidence, and copies in receipts, outbox,
media, search, catalogue and other shared stores remain with their owning
participants. Their cleanup is not claimed by imports. If an importer-owned
personal field or shared copy is introduced, its producer must add an indexed
native ownership relation or atomically recorded exact locator and bounded
minimizer before release. No broad JSON/name scan or central ownership graph
is permitted.

The effect performs fixed event validation and one coordinator acknowledgement
transaction. It performs no domain scan or purge. Its growth bound is the
coordinator's indexed point acknowledgement for the `imports` participant
within the 11-entry version-1 participant set; see
`services/kernel/test/access/growth-erasure-coordinator.test.ts`, test
`erasure acknowledgement (first) stays constant as accounts and completed
erasures grow at three scales`. Imports adds no local counters or benchmark.
