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

The same loader calls libraryConsumptionSummary.get once. It renders native completed occurrence, distinct subject,
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
