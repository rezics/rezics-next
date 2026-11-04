# Private consumption diary

The diary navigates actual private `progress_session` occurrences across subjects. A repeat is another session ID;
incomplete, completed and abandoned sessions all remain occurrences. No Library entry, publication, public rating or
aggregate is required. The existing session engine owns recording, correction, revision checks, accepted
meaning and terminal fences. This reader creates only bounded navigation metadata.

Decision: order occurrences by immutable native recording start time descending, then full session UUID descending;
use eight expiring owner navigation slots and the existing presented session method for addressed reopening.

## Installed methods for the existing Web diary

The typed Eden client exposes `client.v1.libraryDiary.get({ query: { limit, cursor, year, month } })` and
`client.v1.libraryDiary.$cancel.post({ continuation })`. `GET /v1/libraryDiary` defaults to 20 rows and accepts
1–25. Omit `cursor` for a fresh first page. Pass `next` unchanged with the same limit for a continuation. The reply is:

```ts
{
  occurrences: Array<{
    id: string;
    subjectId: string;
    versionSubjectId: string | null;
    state: 'active' | 'completed' | 'abandoned';
    revision: number;
    recordedStartedAt: string;
    recordedCompletedAt: string | null;
    reportedDates:
      | {
          availability: 'available';
          revision: number;
          startDate: { year: number; month?: number; day?: number } | null;
          finishDate: { year: number; month?: number; day?: number } | null;
        }
      | { availability: 'unavailable' };
    assessment?: { meaningRevision: 1; units: number | null };
    subject: {
      id: string;
      label: string | null;
      language: string | null;
    } | null;
    versionSubject: {
      id: string;
      label: string | null;
      language: string | null;
    } | null;
  }>;
  order: 'recorded_started_desc_id_desc';
  next: string | null;
  continuation: string | null;
  expiresAt: string | null;
}
```

`next: null` means end, including an empty first or later page. An empty first page has no continuation. Retain the
`continuation` handle until leaving this journey; it remains available on the last page. Call
`POST /v1/libraryDiary:cancel` with `{ continuation }` when clearing or replacing navigation. It returns
`{ cancelled: true }`, including a repeated cancellation or already expired handle. A `next` token is also a valid
cancellation handle. Cancel does not change sessions. Abort a superseded HTTP request and ignore its late response;
cancel an already returned navigation as well. A lost initial response can retain one slot until expiry.

Reopen exactly `GET /v1/progressSessions/{occurrence.id}?presentation=FULL&view=FULL`, or Eden
`client.v1.progressSessions({ sessionId: occurrence.id }).get({ query: { presentation: 'FULL', view: 'FULL' } })`.
This installed method returns the existing `progressSession` with current revision, exact values, accepted meaning,
current recording admission and independently authorized subject/version summaries. It verifies native owner,
partition, revision/pin and current source observations after rendering. Reopening does not require a live diary
continuation. It never selects the subject's newest session in place of the addressed occurrence.

Show `recordedStartedAt` as **Recorded start** and `recordedCompletedAt` as **Recorded completion**. Detail's existing
`startedAt` and `completedAt` have that same audit meaning. None is a person-reported historical date. The optional
historical-date owner supplies `reportedDates.availability: available`, with its independent journal
revision and accepted partial `startDate` and `finishDate`. Unknown dates remain `null`; unknown components remain
absent. Decision: project the installed journal's date columns in the same bounded session seek, preserving its
precision and independent revision while keeping recording order unchanged. Reflection remains on addressed detail.
Read or correct dates with the existing [journal methods](library-occurrence-reflections.md), including their exact
revision, retry and clear semantics; this reader adds no writer or historical-date sort. Navigation still works
when all dates are unknown. After a date correction, retry the current page or reopen the same journal; an edit
during page rendering yields the same `409 conflict` recovery as a progress correction.

The bounded occurrence row also returns its private `assessment:{meaningRevision:1,units}` value. Units are integers
0–20 in steps of 1 and display as `units / 2`; `null` units mean no current assessment. This field is read from the same
indexed progress-session row and is not derived from a public Subject vote or question.

Decision: unfiltered history remains readable when optional journal columns are absent; return only
`reportedDates: { availability: 'unavailable' }` when its revision/date columns are incomplete, and omit `assessment`
when its columns or stored meaning are unsupported. Available unknown dates remain null. Supported cleared assessment
units remain null and numeric zero remains a value. The response type above therefore also admits the unavailable
reported-dates object. No missing installation is repaired by GET. Addressed native progress and historical profile
presentation stay independent; journal reads/writes still require their own installed owner. A fixed nine-key catalog
probe per source observation selects only installed projections; neither reflection nor other session values are
serialized to discover installation. Recheck installation on the second observation rather than cache it.

## Currentness and recovery

Every page requires an authenticated active unfenced acting account, current authentication floor, current native
`progress_session:list` authorization and the `reading_progress` gate. There is no account selector. Continuations
bind operation, account, client, requesting principal, authentication epoch, exact scope set, limit and partition
epoch. They expire absolutely 15 minutes after navigation creation; fetching another page does not extend expiry.

This is a live keyset journey, not a historical snapshot. Corrections retain the key and expose the current revision
when revisited or reopened. Deletion between pages skips the retired occurrence. Deleting the cursor anchor does
not invalidate the seek: its exact microsecond recording time and ID are in the sealed token. Newer recordings
appear on refresh, not behind the current boundary. A newly committed recording with an older key can appear on a
later page. Edits during rendering produce `409 conflict`; retry the same cursor. No entire-library mutation fence
invalidates a journey for unrelated progress updates. Partition epoch changes, cancellation, overwritten expired
slots and expiry produce `409 stale_cursor`: clear saved tokens and restart at the first page.

Malformed, tampered, foreign-caller or changed-limit tokens produce `400 invalid_cursor`; clear them and restart.
Unknown query keys (including unsupported sorts) are `400 invalid_request`. Missing/invalid credentials are `401`;
lost scope or native permission is `403`. Clear private rows and detail on either; never fall back to another
account's cached data. Addressed missing/retired/foreign occurrences are concealed as `404`; remove the stale detail
and offer diary refresh. Detail's concurrent revision conflict is `409 conflict`; reload that occurrence.

Transient native authority, partition or catalogue failures use existing `503` problem codes, including
`semantic_not_ready`, `dependency_unavailable` and `deadline_exceeded`; preserve the last known page only while the
same account remains admitted, mark it stale and retry the same request. `503 overloaded` can also mean all eight
navigation slots are live: cancel a retained handle or wait until expiry. A cancelled or expired request cannot
revive navigation. Terminal account deletion blocks all reads/writes and the existing Library erasure worker drains
the navigation keys through its indexed owner phase. This does not claim complete shared erasure closure.

Subject/version labels come only from the native batched Semantic summary reader under current visibility. A
concealed, unavailable or unknown subject is `null`: show an unavailable-subject label with the occurrence's private
recording facts. Do not infer a title, current type or original meaning from IDs or raw unit strings. Labels are
compact (256 UTF-8 bytes, language 64); opening detail uses the full existing native presentation. Page summaries
are optional display, never authority for a session write. Missing current profile means unavailable/unsupported
recording advice at detail according to the existing accepted-meaning owner; it never guesses historical meaning.

## Native bounds and scenarios

The owner index is `(route, account_id, started_at DESC, session_id DESC)`. Initial and continuation statements use
separate fixed index range shapes. Each owner observation fetches at most `limit + 1` compact rows; a second bounded
observation fences concurrent edits after the shared summary batch. There is no subject scan, full-history count,
offset, per-row session read, unit/history walk or per-row release/profile read. At most 50 distinct subject/version
IDs enter one native summary batch. Native Access and Semantic maintain their own currentness/physical-work bounds.
Owner work is logarithmic index positioning plus bounded rows, independently of subject/history cardinality.

Only eight PK slots can exist per owner, including expired slots. Expired keys are logically retired and replaced
in place on fresh navigation; no unbounded age scan or new maintenance service is needed. Cancellation deletes one
exact owner/navigation key; terminal cleanup deletes at most eight. Slots contain no session facts, bearer tokens,
subject IDs or retained allow decision. Cursor input is capped at 2,048 characters; output at 65,536 encoded UTF-8
bytes, with bounded label fields and at most 25 occurrences.

`services/kernel/test/library/diary.test.ts` exercises real native session recording, multiple pages, ties, repeats,
active/completed/abandoned states, correction and addressed reopening, concealed subjects, other/anonymous/reduced
scope callers, client/limit binding, cancellation, deleted anchors, expiry and authentication fencing. Broader
frozen acceptance and the existing integrating Web diary's placement remain controller-owned.

## Opening a reported-year count

Decision: extend this same diary with `year?: number` (1–9999) and `month?: number | 'unallocated'`
(1–12 or the literal `unallocated`); omit month for the whole year. Month requires year. Preserve the
unfiltered recording-time/full-UUID order and page size, including existing callers and cancellation handles.
The actual `createKernelClient` method is `client.libraryDiary.get({ query: { year: 2020, month: 2, limit: 20 } })`;
its next request repeats year, month and limit with the opaque `cursor`. The mounted Eden method keeps its `v1` prefix.
`client.libraryDiary.$cancel.post({ continuation })` needs no filter fields. Web318 continued by Web142 remains the
only history interface; this delivery adds native filtering and client declarations, with Web adoption owned there.

Filtered rows use exactly the [reported-year summary](library-reported-year-summary.md) inclusion rule: valid explicit
Gregorian finish year, actual completed state and retained native occurrence identity. A year-only finish matches
only `month=unallocated` (and whole-year navigation); missing dates and incomplete occurrences match neither.
All twelve month counts and independent Subject distinctness remain summary-owned. Opening any returned `id` uses
the existing addressed Session/journal, including earlier repeats, as described above.

A filtered page includes `currentness: { state: 'snapshot', revision: string }`, comparable to the summary's
currentness. Replace the displayed summary if its revision differs before presenting the opened count as current.
The sealed cursor binds the exact year/bucket in addition to owner, authority, limit, partition and absolute expiry.
The existing all-time source revision is conservatively bound: any source mutation, even in another year,
invalidates filtered continuation with `409 stale_cursor`. A finish correction, completion change, retirement or
deletion therefore requires refreshing both counts and first page. Revision changes during rendering produce
`409 conflict`; retry the same request (a now-stale cursor still requires restart). No historical snapshot is retained.
Unfiltered navigation retains its live deletion/anchor and correction behavior. Cancellation and expiry use the
same eight slots for both forms; stale revision handles can still cancel their exact slot.

Summary and filtered diary use the installed all-time source generation, including reflection-only and assessment-only
journal corrections. Membership counts need no rebuild for these edits, but the old accepted occurrence revision
cannot remain a current navigation basis. Original command receipt replay performs no source mutation and preserves
this generation even after a newer correction. Reconcile the original receipt by its exact Session, key, body and
journal revision before reading current values; a repeat's latest Session never substitutes for that identity.
An aborted page checks its request lifetime before either observation, before allocating a slot and after encoding.
A slot committed immediately before cancellation remains bounded until original cancellation or absolute expiry.

Two partial native indexes seek `(route,account_id,journal_finish_year[,coalesced-month],started_at DESC,session_id DESC)`
for valid completed rows. Coalesced month 13 is an internal indexed key only; the public value is `unallocated`.
The whole-year and bucket queries use separate shapes, with the microsecond time/full-UUID boundary in the index range.
Source updates maintain these indexes in the same transaction as the installed summary trigger. There is no second
statistics engine or per-owner preparation on GET. Existing incomplete summary coverage yields `503 dependency_unavailable`.

For page cap L=25, each of two owner observations receives at most L+1 compact source rows (52 total), including
empty/final pages. The first observation retains at most 26 rows; response construction retains at most 25 occurrences,
50 unique Subject/version IDs and their one native summary batch. Two shared summary coverage probes each address the
installation, all-time owner, reported-year owner and shelf gate keys. Existing account locks/authority reads and native
Access/Semantic disclosure work remain charged; the second observation rechecks source rows, revision and coverage.
Serialization retains bounded compact rows plus at most 65,536 output UTF-8 bytes and 2,048 characters per input token.
Expiry, stale revision and invalid binding do no history scan; cancellation addresses one navigation key, expiry reuses
one of eight slots, and terminal cleanup deletes at most eight. No occurrence payload is retained in a slot. Request
retry repeats this bounded work and does not refresh the absolute 15-minute lifetime. PostgreSQL B-tree positioning,
lock waits, nested native authorization and summary rendering remain real costs; unrelated history increases index
depth, not page rows. One-time index installation scans the retained table and builds both indexes under migration
locking; subsequent writes pay two native index updates rather than a new aggregate or maintenance workflow.

The focused diary test now exercises typed year/month/unallocated requests, repeats across pages, summary revision
agreement, addressed reopening, filter substitution, cancellation, correction, retirement and invalid query shapes.
`services/kernel/test/library/diary-continuity.test.ts` composes maintained derivation with two repeats, partial/unknown
dates, independent private reflection/assessment, null/zero, stale revisions, exact original receipt replay after a
newer correction, year/unallocated movement, historical profile presentation, concealment, eight-slot exhaustion,
absolute expiry/reuse, original cancellation, terminal cleanup and optional journal installation.
Whole-caller rows/buffers/bytes at native64/512/4096, nested disclosure/lifecycle work and Web acceptance remain unmeasured
and deferred to integration. Reference comparison read `legacy-final:apps/web/features/library/reading-stats.tsx`
(twelve visible months), Yamtrack `src/app/statistics.py` (explicit date range selection) and Ryot
`apps/frontend/app/components/routes/media-item/displays/history-item.tsx` (individual history identity), from the
registered `shelves` reference checkouts. These supply journey comparisons only; no reference code was copied.

Decision: the all-time summary supplies no finish-precision distribution; show precision only for selected reported-year/month buckets and never infer it from received rows.
