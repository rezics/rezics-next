# Personal consumption statistics

Library owns the private consumption summary. Current shelf state, holdings, consumption
sessions and public published logs remain independent facts. The mounted native method is
`GET /v1/libraryConsumptionSummary` (`library_consumption.summary`), requiring the authenticated
owner, `progress_session:list`, the existing `reading_progress` exposure and normal physical
admission. There is no account selector and no public, Search or publication count adapter.
The typed client calls `client.libraryConsumptionSummary.get()`.

## Measures and coverage

Decision: count explicit completed retained native session identities, grouped by their stored
subject identity, for all time; do not invent date windows or canonical episode membership.

All counts are unsigned decimal strings, preserving integers beyond JavaScript's safe range:

| Field                                    | Meaning                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `completedOccurrences`                   | Number of retained native sessions whose explicit state is `completed` |
| `distinctCompletedSubjects`              | Distinct stored `subject_id` values among those sessions               |
| `repeatOccurrences`                      | Completed occurrences minus distinct completed subjects                |
| `completedOccurrencesWithUnknownProfile` | Included completed sessions with no accepted historic profile pin      |

Two completed session identities for one subject and one for a second subject yield `3`, `2`,
`1`. Separate version selections do not split their parent subject. Stored different subjects
remain separate, including after identity changes unless the native session writer actually
changes the stored subject. A retained session's explicit completion is native authority even
when its historic unit or profile meaning is unknown. No release lookup or current vocabulary
reinterpretation is required for this state-based measure. The unknown-profile count is not a
count of unresolved durations, missing sessions or incomplete occurrences.

Active and abandoned sessions contribute no completion. Filling a scalar total, recording a
position, adding sparse completed units, setting an entry to completed, buying copies and
publishing or retracting a log never complete a session. Clearing recorded values preserves
explicit completion, so it preserves these counts. Starting a repeat session changes no
completed count until the repeat itself explicitly completes. Units and positions are never
summed, converted to time or interpreted as chapters, volumes or canonical episodes.

`scope: retained_native_sessions` and `coverage.nativeSessions: complete` mean complete for
the currently retained installed native source, not a person's lifetime consumption. Erased
sessions are excluded. `coverage.otherHistory: unavailable` covers provider counts, imports
without native session identities, unrecorded history and publications alone. An empty native
summary can therefore be an exact native zero without claiming an exhaustive lifetime zero.
`coverage.unitMeaning: not_evaluated` prevents treating these occurrence counts as understood
historic unit totals. Current release/profile display and canonical episode membership remain
with their existing owners.

There are no date-window parameters. Native `started_at`, `completed_at`, `last_changed_at`
and change `recorded_at` use the installed command audit clock. They do not establish a
user-reported consumption date. Historical date editing and partial date precision retain
their existing owners; this summary neither guesses a date nor fills in missing precision.

## Native maintenance and currentness

`consumption_statistics_owner` stores one header per owner with retained sessions;
`consumption_statistics_subject` stores one counter per retained stored subject. Both are
derived data, never another occurrence writer. The source table's synchronous database
trigger receives inserts, updates and deletes in the same transaction. Session revisions,
corrections, identity moves, value clears, retries, native retirement and account erasure
cannot commit a session change without its matching derivation. A receipt replay that does
not mutate the source cannot double count. The owner header lock serializes concurrent
first completions of the same subject. Ordinary updates touch at most two owner/subject
counter pairs; no history is read. Multirow retirement performs that constant work per
source row under the existing lifecycle writer's bounds.

The deployment migration locks source writes while it initializes existing source rows and
installs the trigger in one transaction. This one-time deployment aggregation is not a GET
or recurring repair. `consumption_statistics_installation(version=1, complete=true)` is
published only after initialization. Missing or incomplete installation is unavailable,
including for an owner with no header; GET never performs a backfill. Database migration
rollback leaves neither a complete marker nor a partially installed derivation.

The reader uses a read-only repeatable-read snapshot, the current native owner account
and authentication floor, one installation key and one owner primary key. Returned
`currentness.state: snapshot` means current in that admitted snapshot, not a promise about
future writes. `revision` is an opaque owner revision replaced on every native source
mutation; an exact empty source uses `empty-v1`. Do not compare revisions numerically or
use them as mutation preconditions. No query scans sessions, fans out by subject, fetches
profile releases or depends on public indexes. Read rows and statements are constant;
index seek blocks grow logarithmically with owner count.

Deleting the last source row removes both owner and subject derived rows. The existing
session erasure participant therefore clears every owner key here without another
account-deletion coordinator. A terminal, fenced, suspended, non-actor or stale-authentication
owner cannot read even while erasure is still removing source rows. Retained sessions
continue to count independently of current subject disclosure or shelf state, as private
history already does; no subject details are disclosed by this aggregate.

## Web integration and failures

The existing personal-statistics interface owner consumes this method; it retains its
reserved surface. No competing page or second statistics facade is introduced here.

The successful body is exactly the fields above plus `coverage` and `currentness`.
No query parameters are accepted, including owner selectors and date filters. Responses
use `Cache-Control: private, no-store`. Authentication failures are `401`; scope, current
owner and gate denials are `403`. Missing/incomplete derivation is `503 dependency_unavailable`.
Normal admission can also return `overloaded`, `partition_unavailable`,
`transaction_retry_exhausted` or `deadline_exceeded`. Failed reads never return cached
counts as current, and a cancelled/expired read never manufactures a zero.

Web must bind the result to the current viewer and request lifetime, discard responses
after navigation, cancellation or account changes, and clear previous values when a new
load fails or authorization ends. Retry repeats this GET with the current viewer; it
does not resume a preparation job or send a mutation/idempotency key. A successful retry
replaces all counts and coverage together. Clearing progress values uses the installed
session command and preserves completed occurrences; erasure/removal follows the existing
native lifecycle rather than a statistics-specific clear operation.

## Web private history surface

The private /library/history page consumes the installed generated libraryDiary.get and
libraryConsumptionSummary.get methods through an authenticated server loader. It shows completed occurrence,
distinct completed subject and repeat counts from the native definitions above, plus unknown-profile count, native
coverage, unavailable other-history coverage, unevaluated unit meaning and snapshot currentness. Counts remain
decimal strings so values above JavaScript's safe integer range are not rounded. An unavailable summary is shown as
unavailable rather than zero. Web does not enumerate sessions or derive statistics from diary pages.

Web performs one summary call per page visit; the summary's reader remains bounded by its native installation and
owner-index reads. Its design-visible source/statement bound is documented above: constant database rows and
statements, with logarithmic index seek blocks as the owner count grows. This Web increment adds no summary engine
query, projection or worker. Three-scale growth acceptance remains with the normal dev verifier and was not run here.

## Composed occurrence continuity cost

Reported-year summary and filtered diary now expose this same maintained source generation. Counts preserve their
existing meanings; reflection/assessment corrections change currentness without changing membership, and exact
original receipt replay changes neither. A summary revision and each occurrence's journal revision have separate
purposes: compare summary generations before displaying a bucket as current, and use the addressed journal revision
only for that occurrence's correction. Missing year coverage remains unavailable, including empty requested buckets.

For diary cap L=25, the complete reader adds two nine-key PostgreSQL catalog observations (at most 18 attribute rows)
to its two indexed source pages (at most 52 rows), two coverage/head probes, native account/partition authority and
one batch of at most 50 distinct Subject/version IDs. Include every nested Access/Semantic pool, its repeated source
observations and locks, operational-time mint/release, connection transactions and deadline admission. Catalog probes
are fixed-key work; session and owner B-tree seek blocks grow with population even while returned rows and statements
stay bounded. Serialization retains two compact observations plus bounded summary fields, 2,048 input token characters
and 65,536 response bytes. It never serializes reflection, history or whole source rows to detect optional installation.

Correction pays the existing exact source lock, journal CAS, owner fencing, command dispatch and immutable receipt,
the all-time old/new owner/Subject counter transitions, and native indexes. Effective finish/state changes also pay
the existing at-most-four reported-year bucket/Subject transitions; reflection/assessment-only changes skip those
transitions. Retry still pays admission, authority and original-receipt lookup/serialization across all native pools;
only a new accepted source mutation adds receiving work. Archive/import recovery retains its own reviewed operands,
receipt identity and writers; V1/V2 absence, fixed V3 assessment meaning and inert V4 evidence are unchanged.

Fresh multi-page navigation allocates one of eight owner slots; continuation probes its exact key without extending
its lifetime. Cancellation deletes one original key; absolute expiry reuses one slot, and terminal cleanup deletes at
most eight indexed keys per page. Source retirement/erasure additionally pays all existing child/history pages,
receipts, counter transitions, locks, dispatch and background lifecycle work. Those campaigns grow with retained
source/history; a fixed navigation cap does not make the whole journey constant. Three-scale native execution at
64/512/4096, retained handles, rendered review, frozen acceptance and full Kernel checks remain controller-owned and
unexecuted here. These are inclusive source bounds, not measured rows, blocks, statements, bytes or timing results.
