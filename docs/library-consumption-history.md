# Personal consumption dates

Historical dates belong to a real native Library progress session. An owner can record a known year, year and month,
or complete calendar date for the start and finish of that occurrence. Missing month and day components remain
unknown. The service does not infer an instant, order partial dates, or substitute `startedAt`, `completedAt`, command
time or audit time for a user-reported date.

Dates use the session-addressed journal API, revision and clear semantics documented in
[Private progress-session journal](library-occurrence-reflections.md). The same occurrence can retain its private
reflection. Repeats remain separate by session ID. Historical dates do not imply progress, elapsed duration, current
Library entry state, completion, public activity, review or rating. Public log snapshots retain their explicit,
independent content and existing owner.

An installed import adapter may write a source date only when its precision fits the native calendar shape. It
retains unsupported evidence privately and does not invent month/day values.

## Web private diary receiving

The authenticated /library/history route binds loader data to the current viewer and CSRF session and calls
libraryDiary.get with the native page limit of 25. The installed native diary response is bounded to 65,536 bytes.
A next-page visit replaces the current route entry so one page is retained at a time; closing or returning cancels the
addressed continuation. A stale continuation offers a first-page restart. Each diary row links to the existing
addressed progress-session detail and preserves the caller return path for the original Subject Library visit.

Without a selected reported year, the same loader calls libraryConsumptionSummary.get once. It renders native completed occurrence, distinct subject,
repeat, unknown-profile, coverage and snapshot-currentness values verbatim as decimal strings; it does not aggregate
sessions or substitute zero after an unavailable read. The displayed scope is retained_native_sessions, with
otherHistory: unavailable and unitMeaning: not_evaluated. User-reported partial dates remain year, year-month or
full date; native start/completion audit times are shown separately.

For one visit, Web work is fixed caller/profile/detail reads plus one addressed entry read, one diary page, one summary,
or one journal detail as applicable. Annotation confirmation returns the exact native entry; source privacy correction
uses one addressed PATCH and one personal-entry readback; journal correction uses one PATCH and one journal readback;
reopen or retire uses one addressed command. The diary terms are L=25 rows and B=65,536 response bytes. These terms
and retained projections do not grow with the owner's total occurrence history N. Statistics remain a single native
aggregate call; its engine cost is owned by [consumption statistics](library-consumption-statistics.md), not inferred
from Web response counts.

Journal read/update and occurrence reopen/retire are separately gated with their installed operation names. Their
server calls use the generated client with the current request's authorization header and exact native command key.

Focused tests cover partial-date preservation and exact native-summary pass-through. Three-scale loader/controller
growth acceptance and browser evidence remain deferred to the normal dev verifier; they were not run in this increment.

## Reported-year selection

The existing diary accepts an explicit Gregorian year from 1 through 9999. Selecting a year replaces the all-time
summary read with one generated `libraryReportedYearSummary.get({query:{year}})` read, independently of diary
navigation. Counts, precision, whole-owner coverage and snapshot currentness are replaced together. Pending address,
viewer, credential or exposure replacement hides retained values; an unavailable summary never supplies a zero.
Reported-year meaning remains with [the native owner](library-reported-year-summary.md).

Decision: while the native diary has no reported-year filter, show reported-year counts with disabled month and
unallocated actions and explicitly label the occurrence list as all history; never approximate a bucket locally.

The installed `packages/client/src/kernel/library/diary-routes.d.ts` query has only `limit` and `cursor` at source
head `bd78d5aa5b40c51d76be768082002076b6121017`. Native filter-bound month/unallocated navigation is unavailable.
This is independent of the available reported-year summary export. The summary retains year-only precision in
`monthUnallocated`; missing finishes remain outside every selected year. Web does not scan history or repair totals.

Each occurrence link carries an encoded history return context: exact opaque cursor, selected year and original
caller. The existing progress detail preserves it, and journal/lifecycle return opens that native page afresh. Native
stale-cursor refusal offers a first-page restart with the selected year retained. Corrections and retirement never
adjust displayed counts locally. The progress detail route is extended only to retain this validated return context.

One page visit uses one diary GET and one summary GET, all-time or reported-year. The retained diary page is at most
25 rows / 65,536 bytes; reported-year summary is at most 16,384 bytes, twelve months and one unallocated bucket.
A next, retry, final or empty page has the same two-read bound and replaces the prior page. A failed retry clears the
previous summary. Explicit departure cancels the retained continuation with one POST, including on a final/empty page.
Detail adds one addressed journal GET to the existing progress detail reads. A journal attempt uses one PATCH and at
most one GET; each exact uncertain replay has the same bound and retains only one original key/body. Accepted PATCH
acknowledgement is distinct from supported current readback. No Web cost term depends on unrelated occurrence count.
Native index, maintenance, export and growth acceptance retain their existing owners.
