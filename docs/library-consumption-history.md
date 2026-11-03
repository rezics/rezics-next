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

The generated diary query accepts the selected `year` and numbered `month` or literal `unallocated`; omission
of month opens the whole reported year. The existing summary's month links open exactly that native bucket,
including empty buckets. Both month and cursor repeat on every next request. The server owns completed-state
inclusion, partial precision, recording-time/full-UUID ordering, filter-bound keysets and eight-slot allocation.
Unknown finish dates remain outside every selected year. Web does not scan history or repair totals.

Filtered page and summary revisions must agree before the occurrence list is shown. A mismatch offers a restart
of the same bucket; missing current counts offers an explicit retry. Each occurrence link carries the exact opaque
cursor, selected year/month, original caller and opened Session ID for keyboard focus on return. Detail returns to
that frontier deliberately and reads it afresh. A stale native cursor offers a first-page restart retaining the bucket.
Date correction, retirement and deletion never adjust displayed counts locally.

One page visit uses one diary GET and one summary GET, all-time or reported-year. The retained diary page is at most
25 rows / 65,536 bytes; reported-year summary is at most 16,384 bytes, twelve months and one unallocated bucket.
A next, retry, final or empty page has the same two-read bound and replaces the prior page. A failed retry clears the
previous summary. Explicit departure cancels the retained continuation with one POST, including on a final/empty page.
Detail adds one addressed journal GET to the existing progress detail reads. A journal attempt uses one PATCH and at
most one GET; each exact uncertain replay has the same bound and retains only one original key/body. Accepted PATCH
acknowledgement is distinct from supported current readback. No Web cost term depends on unrelated occurrence count.
Native index, maintenance, export and growth acceptance retain their existing owners.

Touches: one bounded native summary, one diary page, and one addressed occurrence on detail; explicit next, retry
and independent readback repeat only their fixed reads. Bound: 25 rows / 65,536 diary bytes, thirteen summary buckets /
16,384 bytes, and one journal with at most 1,000 characters / 4,096 UTF-8 reflection bytes and fixed assessment/date
fields; PATCH is capped at 16,384 bytes. Growth: retained Web state is one page, one summary and one original uncertain
journal intent, independent of unrelated history. Native indexes, maintenance, archive export and physical growth
measurement remain producer/controller responsibilities.
