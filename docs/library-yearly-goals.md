# Yearly completion goals

Decision: count completed consumption occurrences in the reported Gregorian year; each repeated completion is another occurrence.
Decision: target editing follows the native owner actions independently of progress availability; uncertain commands retain their exact reviewed body, revision and idempotency key for retry.

## Native contract

The goal is an optional target for one authenticated Library owner and one Gregorian year. The metric is
`completed_consumption_occurrences`: it counts explicit journal finishes allocated by the retained native reported-year
summary. It does not mean distinct works, books, hours, chapters or public challenge completions. A target is an integer
from 1 through 1000. A year is an integer from 1 through 9999.

The current target revision is a separate fence from the reported-year summary generation. Clearing a target sets its
active value to null and increments its revision; the row remains as a tombstone. Recreating a target therefore cannot
make an earlier revision current again. A set or clear is an owner-scoped Library command with the existing immutable
command receipt. Retrying an uncertain request uses the same idempotency key and body to resolve its original result.
A stale expected revision returns `409 conflict` and never overwrites the current value. Reusing an idempotency key with
different input returns `422 idempotency_conflict`.

`GET /v1/libraryYearlyCompletionGoal?year=2026` reads the selected year's target and composes it with the existing
reported-year summary. The query accepts exactly one `year`, without leading zeroes or additional query parameters.
Responses are private, uncached and limited to 20,480 bytes. Counts and revisions are decimal strings so large native
quantities stay lossless. This excerpt shows the state distinction; it omits secondary summary fields and repeated
monthly rows for brevity. The response includes all twelve monthly buckets and every field listed below:

```json
{
  "year": 2026,
  "metric": "completed_consumption_occurrences",
  "viewer": {
    "state": "owner",
    "actions": {
      "editTarget": { "allowed": true },
      "clearTarget": { "allowed": false, "reason": "no_target" },
      "navigateYear": { "allowed": true }
    }
  },
  "target": { "state": "set", "target": 24, "revision": "3" },
  "progress": {
    "state": "available",
    "summary": {
      "completedOccurrences": "0",
      "repeatOccurrences": "0",
      "completedOccurrencesWithUnknownProfile": "0",
      "finishPrecision": { "year": "0", "month": "0", "day": "0" },
      "coverage": {
        "nativeSessions": "complete",
        "completedOccurrencesWithMissingFinish": "0",
        "completedOccurrencesWithUnsupportedFinish": "0",
        "otherHistory": "unavailable",
        "unitMeaning": "not_evaluated"
      },
      "currentness": { "state": "snapshot", "revision": "summary-generation" }
    }
  }
}
```

The actual summary also includes distinct completed subjects, initialized and retained session counts, calendar and
date-source labels, all twelve monthly buckets, and the unallocated month bucket. Known zero is reported as `"0"`.
Missing and unsupported finish coverage remain separate from the count. Other history is explicitly unavailable; it is
not treated as zero. The native summary generation identifies progress currentness independently of the goal revision.

An absent target is `{ "state": "none", "revision": null }`. A cleared target remains `none` with its latest revision.
An uninstalled target table is `{ "state": "unavailable", "reason": "not_installed" }`, not an empty target. When the
target remains readable but the summary cannot provide a current result, progress is
`{ "state": "unavailable", "reason": "summary_unavailable" }`; the owner can still edit the target. A refresh after
summary-generation change rereads progress and does not mutate the goal.

`PUT /v1/libraryYearlyCompletionGoal` requires the `idempotency-key` header (3–1024 characters) and this exact JSON
shape:

```json
{
  "year": 2026,
  "metric": "completed_consumption_occurrences",
  "target": 24,
  "expectedRevision": null
}
```

`expectedRevision: null` means the caller reviewed an absent target. An existing target must be edited or cleared with
its positive decimal-string revision. Set and clear both use this endpoint; `target: null` clears, and clear requires a
non-null expected revision. Extra fields, fractional or coercive values, unsupported metric names, and out-of-range
years or targets are invalid. A successful response reports the accepted year, metric, nullable target and new revision.
Unauthorized, forbidden, stale-revision (`409`), reused-key (`422`), erased-receipt and unavailable dependency outcomes
remain distinct.

The API reads only the target row and the already-installed reported-year summary. It does not scan sessions, recount
entries, create another summary projection, invent finish dates, or change Entry state. Owner retirement and erasure
include the goal row in the existing bounded Library graph cleanup; the shared command receipt lifecycle remains in
Library command plumbing.

## Web page

The selected Gregorian year is the unit of navigation and the exact year sent to the native read. The owner page
presents the target revision separately from reported-year progress, shows all twelve monthly buckets and the
unallocated bucket, and links those buckets to the existing History destination. Decimal-string counts and revisions
remain strings in presentation. A missing summary does not hide an editable target.

The page shows edit and clear actions only when the current native viewer actions allow them. A stale command keeps its
proposed target until the owner explicitly refreshes and reviews the current revision. An uncertain command retains its
original body and idempotency key for exact retry; receipt resolution precedes current-state readback. Replacing the
selected year or current viewer retires callbacks and private page state.

The mounted Kernel GET/PUT routes and shared receipt lifecycle are delivered. The installed `@rezics/client` Kernel
surface does not yet expose the yearly-goal route binding. Keep year and History navigation available while the target
and progress states remain unavailable until Content's shared client publisher emits that binding. Web consumes the
published `KernelClient` types; no local client declaration, raw-fetch substitute or second generator is part of this
contract.
