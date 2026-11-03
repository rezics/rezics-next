# Private consumption diary

The diary navigates actual private `progress_session` occurrences across subjects. A repeat is another session ID;
incomplete, completed and abandoned sessions all remain occurrences. No Library entry, publication, rating, dated
journal or aggregate is required. The existing session engine owns recording, correction, revision checks, accepted
meaning and terminal fences. This reader creates only bounded navigation metadata.

Decision: order occurrences by immutable native recording start time descending, then full session UUID descending;
use eight expiring owner navigation slots and the existing presented session method for addressed reopening.

## Installed methods for the existing Web diary

The typed Eden client exposes `client.v1.libraryDiary.get({ query: { limit, cursor } })` and
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
    reportedDates: {
      availability: 'available';
      revision: number;
      startDate: { year: number; month?: number; day?: number } | null;
      finishDate: { year: number; month?: number; day?: number } | null;
    };
    subject: { id: string; label: string | null; language: string | null } | null;
    versionSubject: { id: string; label: string | null; language: string | null } | null;
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
historical-date owner is now installed: `reportedDates.availability` is `available`, with its independent journal
revision and accepted partial `startDate` and `finishDate`. Unknown dates remain `null`; unknown components remain
absent. Decision: project the installed journal's date columns in the same bounded session seek, preserving its
precision and independent revision while keeping recording order unchanged. Reflection remains on addressed detail.
Read or correct dates with the existing [journal methods](library-occurrence-reflections.md), including their exact
revision, retry and clear semantics; this reader adds no writer or historical-date sort. Navigation still works
when all dates are unknown. After a date correction, retry the current page or reopen the same journal; an edit
during page rendering yields the same `409 conflict` recovery as a progress correction.

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
