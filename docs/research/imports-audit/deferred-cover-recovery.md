# Deferred cover acknowledgement recovery evidence

Production code reviewed and exercised at commit
`d06435e227fb60b27e18244850e1c1511438ab95`. No product code changed.

From `services/importer`, the exact local command was:

```sh
bun test ./tests/deferred-cover-recovery.test.ts
```

Bun v1.4.3 exited 1: **2 pass, 2 fail, 109 expect() calls**, four tests
in one file. Normal deferred resolution and interruption after remote success
before local acknowledgement passed. Both interruption-after-acknowledgement
cases failed: a new record and a changed record replacing an older cover.
The failing assertion was `expect(observations).toEqual(...)` at line 178,
with `error: expect(received).toEqual(expected)`.

In both failures, expected `live: [C]`, `bound: [C]`, `proposal: [P]` and
`retractions: []` became `live: []`, `bound: []`, `proposal: []` and one
retraction targeting C. The original proposal had exactly one authoritative
effect; media effects stayed at one for the new record and two total for the
replacement case. Resume nevertheless committed a complete present snapshot,
and the subsequent identical input committed without requests, media resolution
or authoritative effects. Thus completion and input idempotence alone conceal
the lost cover.

## Fixture and invariants

The test uses the real Bangumi registration/converter, Importer, ImportSession,
RunStore and RecordBindings with a temporary file SQLite database. Only public
batch transport and media availability are substituted. The remote receipt map
compares serialized command bytes on key reuse, creates a candidate only on
first proposal success, removes exactly the retracted ID, and exposes live cover
IDs. Media availability is pending during ordinary planning and returns the same
available media ID during deferred recovery, with one effect per identical
media request.

A one-shot prototype interceptor runs immediately before
`RunStore.resolveDeferredCover`. It observes that C is already locally bound and
remotely live, aborts the invocation and throws before clearing the pending bit.
It is restored after the interrupted invocation and again in `finally`. The
same database is closed/reopened while remote receipts survive. No local journal
transition or orchestration is simulated. The earlier crash window uses the
existing post-success callback. The replacement variant changes the title and
cover URL and verifies exactly one retraction of the older cover.

Required recovery invariants are exactly C live and bound, original proposal
identity retained, zero retractions targeting C, no repeated media effect, a
complete snapshot and subsequent no-effect replay. The assertions describe
observable behavior without constraining the eventual storage schema.

## Smallest repair boundary

The defect lies in importer deferred-cover coordination: recovery rebuilds a
retraction from current C while reusing original proposal P. Replaying P's remote
receipt does not recreate C, and duplicate local acknowledgement is a no-op.
Repair belongs in deferred-cover orchestration and its durable local publication
boundary; this evidence introduces no product fix or new remote operation.
Preserve exact source/record/run indexed seeks and bounded per-cover command
pages. No global scan or universal lifetime cap is implied.

Read surfaces: the imports README recovery contract; importer resolveCover,
acknowledgement and resume paths; RunStore deferred-cover methods; RecordBindings
acknowledgement/current-candidate methods; import-session offline receipt fixture
patterns; the Bangumi subject fixture; and the reconciliation audit's concrete
defects subsection. No reference-project source was named for this surface.
Decisions: use abort plus the narrow interceptor to prevent in-process retry
from hiding the crash; retain a durable fake media receipt per request; include
both optional scenarios because the focused test remains below 260 lines.
