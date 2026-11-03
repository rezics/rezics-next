# Private reported consumption year

Library extends the delivered session journal and all-time native counter owners. The owner-only mounted API is
`GET /v1/libraryReportedYearSummary?year=2020`, operation `library_consumption.reported_year`. Its typed method is
`client.libraryReportedYearSummary.get({query:{year:2020}})`. It requires current own-account standing,
`progress_session:list`, `reading_progress` exposure and normal physical admission. There is no owner selector.
The all-time API has no new parameters or changed count semantics.

Decision: use the journal's explicit proleptic Gregorian finish date, years 1 through 9999, with year-only finishes
in a named month-unallocated bucket; installation uses the existing fenced shelf backfill, never read-time refill.

## Counts and reported precision

A retained native session contributes exactly once when its actual state is `completed` and its valid explicitly
reported journal finish year equals the selected year. Year/month and year/month/day finishes belong to the actual
month. Year-only finishes belong to the year and `monthUnallocated`, never January. Dates remain calendar values:
no timezone, guessed day, recording date, command completion date or observation time supplies missing meaning.
Missing, cleared, malformed and unsupported finishes supply no year membership. Current native constraints reject
malformed journal dates, including impossible Gregorian leap days, before any derived effect can commit.

The response includes `scope: retained_native_sessions`, `calendar: gregorian`, the selected `year`,
`dateSource: explicitly_reported_journal_finish`, year totals, twelve ordered `months` with numeric month 1..12,
and `monthUnallocated`. Every displayed count set has these unsigned decimal strings:

| Field | Meaning within that displayed year or bucket |
| --- | --- |
| `completedOccurrences` | Retained native completed session identities |
| `distinctCompletedSubjects` | Distinct stored native Subject identities among those occurrences |
| `repeatOccurrences` | Completed occurrences minus distinct completed Subjects |
| `completedOccurrencesWithUnknownProfile` | Included occurrences without an accepted historic profile pin |
| `finishPrecision.year/month/day` | Included occurrences at each explicitly reported finish precision |

Distinctness and repeats are calculated independently for the year and every bucket. A Subject completed once in
February and once in March contributes two occurrences, one distinct Subject and one repeat to the year; each month
has one occurrence, one distinct Subject and zero repeats. Neither monthly distinct counts nor monthly repeats can
be added to recover the year totals. Year-only occurrences contribute to both the year head and the unallocated
bucket, not twice to the year. The precision counts sum to the occurrence count within each displayed count set.

Stored Subject grouping does not follow redirects. Accepted historic profile pins are not interpreted through a
current release; absent pins remain explicitly unknown. Unit meaning is not evaluated, and these counts do not
imply duration or canonical Episode completion. A completed entry, provider repeat total, scalar value, purchase,
public log or imported observation without a native session identity supplies no occurrence.

## Coverage, installation and lifecycle

`coverage.nativeSessions: complete` means all currently retained native session rows have been received, with the
existing shelf maintenance preparation ready and open. `initializedSessions` and `retainedSessions` are exact,
whole-owner decimal counts. They must agree; otherwise the API returns `503 dependency_unavailable`, including for
an absent requested year. No failed or incomplete preparation produces an authoritative zero.
`completedOccurrencesWithMissingFinish` counts completed retained native occurrences with all finish components
absent. `completedOccurrencesWithUnsupportedFinish` counts completed occurrences whose nonempty finish cannot be
interpreted by the delivered Gregorian shape. These two counts cover the whole owner, cannot be assigned to the
selected year, and are not added to its totals. `otherHistory: unavailable` and `unitMeaning: not_evaluated` preserve
the boundary around unrecorded, provider-only and unavailable historical profile meaning.

The migration installs empty derived tables and synchronous source triggers transactionally, adding only a fast
constant-default `reported_year_initialized=false` column to existing sessions. It does not aggregate history.
New native session rows initialize immediately. Existing rows initialize through the installed
`createShelfMaintenanceOps(...).requestRebuild(actor,{owner,kind:'backfill',requestKey})` and its existing durable
page/recover mechanism. Its bounded `sessions` phase already updates each addressed source row; that same transaction
receives this derivation. No separate workflow, payer, event subscriber, runtime refill or deletion coordinator is
introduced. Operators must schedule retained owners through this existing maintenance mechanism. Reads stay pure.
An ordinary mutation can initialize its addressed old row, but cannot claim coverage for other retained rows.

The owner head serializes native receiving, including concurrent first completions and last removals of one Subject.
One source mutation removes its old initialized contribution and adds its new contribution in the same native
transaction. Journal correction, month/day precision changes, explicit clear and progress completion retain their
separate revisions and owners. Reflection-only and unrelated progress changes do no year-membership work. Original
receipt retries with no source mutation do not increment again. Changed finish year removes the old year/month and
Subject contribution and adds the new one atomically. Zero-count membership and bucket rows are deleted. The last
initialized source removal deletes the owner head. Existing bounded native session retirement and terminal erasure
pay these same effects; their source deletion leaves no year/Subject keys or private owner tombstone.

Coverage is equality against the installed all-time retained-source counter, under one statement snapshot, plus the
native maintenance ready/open fence. A last initialization page cannot publish success while its native backfill
is still rebuilding; the existing final publish fence must complete. The all-time installation marker must also be
complete. A missing schema, marker, counter coverage or preparation is unavailable, not successful empty data.

## Delivery and Web integration

`currentness:{state:'snapshot',revision}` binds counts and coverage to one admitted database statement snapshot.
The opaque whole-owner revision changes when year derivation changes; `empty-v1` identifies no initialized source.
It is not a journal or progress precondition, and is not numerically ordered. The reader holds the current owner
account share lock through response preparation and rechecks native standing/authentication floor before commit.
It rereads the coverage/maintenance heads at delivery and refuses a changed revision or fence. It checks deadline and abort immediately before returning the encoded response, with no intervening asynchronous
work. Reads are private, `no-store`, fixed at thirteen returned buckets, at most fourteen counter rows plus addressed
heads, and 16,384 encoded UTF-8 bytes. Counts never expose raw journal dates, reflections or Subject membership IDs.
Private inputs/counts do not enter Search, public DTOs, events or error payloads.

The existing private diary/statistics reader remains the integrating surface. Bind every request to the current account, selected year and
abort lifetime. Clear old values when changing either selection, starting a replacement request, losing authority,
receiving missing coverage, or failing a request. Never relabel a previous year's successful values. Discard a late
response after cancellation/account/year change. Retry repeats this GET with the current binding. Replace counts,
coverage and currentness together on success. A failed GET never changes native journal/progress state.

Date clear uses the installed journal PATCH with its journal revision, explicit `finishDate:null`, and one original
idempotency key/body while acknowledgement is uncertain. Retry that original command, then GET the current journal
and affected year summaries. A changed edit uses a new key after reconciliation. Completion remains the progress
command and its independent revision. Clearing scalar progress does not clear the finish or remove completion.
Authentication is 401, owner/scope/exposure denial is 403, invalid year/query is 400, missing coverage is 503. No
competing diary page, statistics page or client cache is introduced by this API-first handoff.

## Cost and verification boundary

Let H be retained owner sessions, P=100 the installed maintenance page cap, and B=13 returned buckets. A summary
cost is `Cfixed-authority + Csummary(B)`: installed Access/exposure/admission, account primary-key lock and two exact
account reads, two probes each of the installation key, all-time owner key, year owner key and shelf gate key, and one
`(route,account_id,year,bucket)` index range bounded to fourteen rows. The one-statement snapshot joins only addressed
heads and aggregates the bounded bucket range. It does not scan sessions, historical years or distinct Subjects.
Absent/deep historical years use the same exact range and zero-fill the thirteen response buckets in memory.
Output bytes are capped independently of H. Index tree depth and lock waiting remain real costs, not zero terms.

A native effect costs `Cnative-mutation/history/receipt + Cdate-membership(old,new) + Ccleanup`. Existing native
preparation, source/profile authority, history, original-receipt and event work are not waived. The added before-row
trigger locks at most the old/new owner heads and performs at most four exact bucket/Subject membership transitions
(old year head and month/unallocated, new year head and month/unallocated). Each transition probes the membership
primary key, inserts/updates/deletes it, and updates or deletes one bucket head. No Subject enumeration occurs.
Source no-ops on the relevant fields skip receiving; original receipt replays add no source effect. Missing finishes
update only coverage heads; the zero-membership path deletes rather than retaining empty Subject/bucket rows.
The existing all-time after-row trigger continues paying its own owner/Subject work independently.

Installation is charged separately to the existing complete backfill campaign: its drain fence, H indexed parent
sessions and their bounded history continuations, ceiling(H/P) source-update pages plus an exhaustion page, and its
existing shelf entry/type/count preparation, validation, publish and bounded retirement. Every session phase
addresses at most P indexed source rows and pays this derivation per row; it neither hides a whole-history SQL
aggregation nor skips the other native preparation phases. Each source initialization happens at most once except
rolled-back work; native page receipts/cursors retain original replay and finite continuation. Erasure pays bounded
source/history pages plus at most four counter/Subject transitions per deleted initialized source. Whole-campaign
cost depends on retained history, entries and type edges as well as H; it is not a constant-time installation.

Focused native scenarios live in `services/kernel/test/library/reported-year-summary.test.ts`. Source derivation is
separate from executed measurement. Three-scale 64/512/4096 growth, statements/examined rows/buffers/bytes including
nested authority/history, populated/absent/deep years, full maintenance and erasure campaigns remain integration
acceptance. Missing coverage, unavailable preparation or counter errors are failed/unmeasured, never growth passes.
Performance review is required for the nested preparation/campaign terms; no measurement result is asserted here.
