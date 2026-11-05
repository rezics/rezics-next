# Library operation recovery

The standalone operation address reads the native captured action, counts, phase, original execution and results
deadlines, and at most twenty native outcomes at a time. Explicit recovery repeats the same operation and current
native cursor. GET never previews, confirms, cancels or schedules personal effects. Missing, forbidden, invalid and
expired results remain distinct from a successful empty result page. A native expired phase remains visible with
its original deadlines while results are still readable.

Cancellation captures a separate request key, exact operation, original viewer, CSRF token and sender. An uncertain
result permits only explicit retry of that captured command. The server prepares a fresh request, matches the
original viewer and CSRF, and sends complete native authorization and idempotency headers. Native admission owns
all effects. Cancellation preserves already committed target counts and outcomes. Navigation, viewer replacement,
locale retirement and observed exposure retirement reject late disclosure; there is no polling or persistence.

Decision: render native outcome and reason identifiers verbatim. The separate `/:locale/library/operations/:id/undo`
address consumes the authorized native deletion evidence through `bulkOperationUndoHref`; this reader never
restores entries or infers receipts from applied outcomes.

Decision: the mounted recovery route replaces one native page (at most 20 rows). It retains eight admitted
predecessor coordinates, the current coordinate and one staged/failed target, each opaque cursor at most 4,096
characters. History contains no outcomes, operation snapshots or commands. Previous rereads its predecessor;
First omits cursor; Read more admits only native next and drops the former forward branch. Success, including
empty success, commits movement. Failed read Retry repeats its exact target; Refresh uses the accepted coordinate.
Changed counts never identify a new snapshot. Native invalid-cursor retirement starts a fresh cursorless path.

Initial and First reads cost one operation GET plus one bounded outcomes GET. Later movement and page Retry cost
one outcomes GET. Explicit Refresh costs one operation GET plus one outcomes GET at the current coordinate, so
native progress and changed statuses become visible. Invalid later cursors add one fresh first-read pair. No total
count causes further reads. Transient read failure preserves the separate uncertain cancellation capture.
Navigation retires with the actual private origin, including address, reader, exposure, CSRF and locale replacement.
Keyboard navigation reuses the existing focus owner for one admitted heading handoff.

The [native bulk contract](../../../../services/kernel/src/library/bulk-contract.md) owns effects, operation-bound
cursor invalidation, outcome facts and deletion evidence; applied outcomes alone never authorize Undo.

## Undo evidence windows

The mounted Undo reader keeps eight predecessor opaque coordinates, the accepted current coordinate and one
staged target, each cursor at most 4096 characters. History stores coordinates only. Native evidence is one replacing
page of at most twenty outcomes. Previous rereads the exact predecessor; First omits cursor; Refresh rereads the
accepted coordinate. More follows only the current native next, abandoning the forward branch. Successful empty
pages commit movement, including terminal pages; failed movement retains its exact target for deliberate Retry.
Invalid retired cursors use deliberate First recovery and a fresh admitted path. Movement commits only while its
original private admission remains current. Address, locale, mounted reader and private authority replacement retire
coordinates and failed targets through the existing origin; display rerenders retain them.

Decision: use the existing localized window controls and render captured restore attempts separately from current
native evidence, preserving uncertain Retry and completed results when a row leaves the page. No navigation creates,
replaces or settles a restore command. Preparation and sending block movement. Refresh never follows an acknowledged
restore automatically. Revisited targets use current authorized deletion evidence and the existing exact preparation;
expired evidence retains its expired meaning. Applied outcomes and counts alone never authorize Undo.

Each read activation performs one operation GET and one native outcomes GET with limit twenty, without prefetch,
refill or hydration. Deliberate preparation uses the existing session authorization, one exposure GET and the same
bounded operation/outcomes read; it seals credentials and creates one request key. Restore retains existing session/credential authorization and one native restore POST (an occupied result may
reread that Entry once; successful/occupied results retain the action’s existing presentation naming reads). Exact uncertain Retry repeats that original command, sender,
headers and credential, without another preparation. There is no browser persistence or additional receipt ledger.
The [native reader](bulk-operation-recovery-native.ts), [deletion evidence decoder](bulk-operation-undo-evidence.ts)
and [Undo preparation](bulk-operation-undo-native.ts) retain their independent authorization and deadline contracts.
