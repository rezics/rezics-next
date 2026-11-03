# Release search

The journey uses the universal subjects search contract and the active released catalogue. Release types,
platform/language options, age-rating units and developer/publisher credit predicates come from that release.
Research inventory and property presence do not establish facet admission.

## Calendar precision

Decision: a partial Gregorian date matches an inclusive range when their represented intervals overlap;
unknown components remain absent from facts, and interval edges are never displayed as recorded dates.

`CalendarDate` in `@rezics/filter` records astronomical `year`, optional `month`, and optional `day`.
A day requires a month. These shapes mean year, month and day precision respectively. Native time content must
declare Gregorian calendar and precision 9, 10 or 11 with the corresponding zero/known components. Unsupported,
malformed or unsafe-integer years retain their raw statement text but have no filterable date projection.
Missing values and unknown snaks do not acquire a date.

The Semantic source and current Search hit facts preserve this shape. The HTTP fact schema admits month/day
without changing the existing year-only shape. Facts use the normal current disclosure path; this adds no new
source query, owner permission, resource lookup or enumeration. Distinct dates in one year remain distinct facts.

The shared calendar helpers parse endpoints as `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, including signed extended
years within the existing safe-integer year domain. Endpoints are inclusive: the lower edge of `gte` and upper
edge of `lte` bound the interval. Either endpoint can be absent, but both absent, impossible dates, timestamps
and reversed intervals are invalid. Thus a recorded `2024-02` can match a range starting on `2024-02-29`;
it does not assert that February 29 was the recorded day. A recorded day before that boundary cannot match.
Gregorian leap rules apply to astronomical years, including zero and negative years.

The comparison keys bias safe-integer astronomical years into fixed-width strings followed by month/day.
Lexical ordering preserves chronological ordering without a fabricated timestamp or multiplication overflow.
These keys are derived interval edges, not native time values or display labels.

## Remaining integration

This foundation does not enable precise range admission yet. Existing numeric time ranges still mean years.
The physical index still stores the historical year projection. It cannot certify the precision-sensitive
journey. The next implementation must install the typed time-range extension, matching generic candidate
projection/compiler/current verification, a new mapping generation and readiness/continuation checks together.
Do not rewrite immutable index definitions or templates, silently use an old generation, or broaden a precise
request into a year range. Generation replacement must use the existing worker preparation/publication lifecycle.

The work grouping, bounded child/group continuations, active-release operand controls, mounted release page,
eight-locale states and native all-pool growth measurements remain part of the same journey's continuation.
There is no measured grouping seek count or native growth result from this foundation. The continuation must
derive its seeks from real relation indexes, source caps and preparation plan before claiming a page bound.
