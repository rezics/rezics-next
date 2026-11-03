# Consumption occurrence correction

Private progress sessions are independent occurrences. The addressed session keeps its identity, subject/version,
original accepted profile meaning, recorded values and start time. Entry state, labels and holdings are independent.
A scalar amount equal to its total never establishes completion.

Decision: reopening clears only terminal completion; retirement is final private removal with retained audit history
until account erasure, and never changes an independently published snapshot.

## Native owner operations

The default authenticated progress routes mount these existing session-writer methods:

- `POST /v1/progressSessions/:sessionId/$reopen` / `reopenSession(actor, sessionId, {revision}, requestKey)`
  changes `completed` or `abandoned` to `active`, and clears `completedAt`. Values, units, totals, original
  meaning and identity remain. Use the normal `$record` command afterward to correct values. Completion requires
  another explicit `$complete`; reopening never supplies replacement dates or duration.
- `POST /v1/progressSessions/:sessionId/$retire` / `retireSession(actor, sessionId, {revision}, requestKey)`
  changes an active or terminal occurrence to `retired`. The successful response includes its incremented revision
  and explicit retired state. Ordinary addressed reads, units/history pages, native lists and private source exports
  subsequently conceal it. There is no Undo or implicit replacement occurrence.

The command runner retains native intrinsic own-account authority; authenticated HTTP scopes and the locked
account/authentication epoch fence govern admission. Both operations use `progress_session:update`, the reading-progress gate, current account and terminal authority,
current subject disclosure, the existing owner command runner and durable receipts. No new progress value needs
current profile admission. Subsequent value recording retains the original-pin/current-capability checks.
A fresh hidden/missing/foreign occurrence returns `not_found`; a stale current revision returns `conflict`.
Reopening an active occurrence is invalid. Fresh commands against a retired occurrence return `not_found`.

For uncertain responses, retain the exact sender, credential, method, session ID, revision and idempotency key and
retry that command. An admitted replay returns the original response, including after later retirement or subject
concealment; current account/command authority still applies before receipt disclosure. A definitive conflict needs
an explicit current-detail review and a fresh intent/key. A not-found detail cannot be accepted as a new revision.
Existing `$record {revision,clear:true}` clears values without reopening or retiring the occurrence; per-measure clear
retains its established sibling/total semantics. Clear does not delete history or reset dates.

## Native history, support and public outputs

Each correction appends an intent containing only `lifecycle`, `previousState` and `previousCompletedAt` at the new
revision to `progress_change`, and emits the existing session-updated event with only the session ID. Original
record history remains. Retirement retains private values/units/history for terminal account erasure, never for a
visible tombstone walk. Existing child-first erasure queries deliberately include retired sessions. No new eraser or
cleanup job is installed. Journal fields remain on this session lifecycle and their owning shared writer.

Retired sessions do not establish Everything membership, session-presence predicates or native Collection support.
The installed owner-member-scope hook probes a live indexed same-pin witness; a remaining occurrence, entry, label
or holding continues to support membership. Source generations invalidate consumers atomically. Repeat and diary
consumers must count current completed occurrences, excluding retired rows, rather than treating accepted completion
commands, public logs or amounts as current completion facts. Session lists preserve other repeats and expose only
current facts. The existing private native source keysets exclude retired rows before LIMIT.

A published log is an independent captured public output. Correction/retirement does not recapture, withdraw,
restore, grant or otherwise modify it. A new publication cannot use a retired source. Explicit public-log withdrawal,
exact deletion/revision Undo, the original expiry and terminal account erasure remain the only log lifecycle paths.
A replay of a previously admitted publication keeps its original receipt subject to current command authority.

## Work bound

Correction and retirement have the same fixed owner/session path: native current account/command authorization and
receipt admission; a released owner snapshot with one account and one session point; current subject/profile
source preparation; the existing owner shelf-write barrier; one subject-head ensure, session point lock and reread;
one revision CAS; one bounded history insert and one existing session event/receipt. They perform no unit walk,
prior-repeat scan, public-log scan, entry raise or holding write. History intent has fixed fields; the session body
uses installed locator, unit and eight-measure caps, plus journal/text caps when those fields are received.

The CAS pays existing source-head invalidation, profile-migration writer and native-source-custody hooks. The
owner-support hook runs its existing old/new refreshes: two indexed same-pin live-session witnesses, bounded
support/directory/pin writes, and at most the existing 64 state metadata cascades on the final pin. All use exact owner
keys. Retirement has no synchronous child cleanup; eventual account erasure pages retained children before parents.
Stale refusal rolls back the command path; replay uses the existing original receipt without repeating its mutation.

Session pages use mutually exclusive first/timestamp/tie branches of `progress_session_live_page`, each limited to
P (at most 100), followed by the existing bounded merge and continuation probe. The predicate is in the partial index,
so neither first nor deep/terminal pages walk retained retirements. Raw live-source and owner seeks use their matching
partial indexes. Account-erasure seeks retain the all-session owner index and visit retained rows in bounded pages.
This is source derivation, not measured growth. Controller placement must measure actual nested statements,
examined rows/buffers, bytes, refusals/replays and cleanup at 64/512/4096 live and retired repeats and unrelated owners;
failed preparation or absent counters is unmeasured.
