# Release search

The journey uses the universal subjects search contract and the active released catalogue. Release types,
platform/language options, age-rating units and developer/publisher credit predicates come from that release.
Research inventory and property presence do not establish facet admission.

## Calendar precision

Decision: a partial Gregorian date matches an inclusive range when their represented intervals overlap;
unknown components remain absent from facts, and interval edges are never displayed as recorded dates.
Decision: `rebuildSubjects` defaults to a fresh calendar successor; legacy generations stay immutable, and precise
compilation requires readiness for the exact physical UUID.

`CalendarDate` in `@rezics/filter` records astronomical `year`, optional `month`, and optional `day`.
A day requires a month. These shapes mean year, month and day precision respectively. Native time content must
declare Gregorian calendar and precision 9, 10 or 11 with the corresponding zero/known components. Unsupported,
malformed or unsafe-integer years retain their raw statement text but have no filterable date projection.
Missing values and unknown snaks do not acquire a date.

Decision: Search result metadata and list facts display exactly the recorded Gregorian components in the reader's
locale, retaining signed astronomical years; malformed dates have no display projection. Client fact declarations
preserve optional month/day. Year-only consumers may still request a year, but result cards do not discard precision.
This presentation uses the existing four-property, three-values-per-property preview and four-visible-fact cap;
it adds no native read, source seek or retained state. It does not establish a bound for grouped execution.

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

## Typed range primitives

Decision: precise calendar ranges use `range: { type: 'time', gte?: string, lte?: string }`; numeric ranges
retain their existing year/quantity meaning. The universal parser and active-release admission accept the typed
extension, including saved and Boolean filters. Current statement matching uses inclusive interval overlap and
retains same-statement qualifiers. Its current Boolean leaf identity includes the range kind and full endpoints.

`documentActions` has an explicit calendar-format projection that retains native month/day, deduplicates exact
dates, and derives `time_lower`/`time_upper` keys. Its default remains the historical year-only projection for
existing physical writers. `calendarIndexDefinition` derives an inert successor mapping without changing frozen
definitions or allocating/upgrading a generation. Its compatibility predicate checks metadata and all date-key
fields; mapping compatibility alone establishes neither complete population nor publication readiness.

The generic compiler emits same-nested-fact interval comparisons only with an explicit calendar-format capability.
The resumable Subject rebuild now allocates the successor mapping, replays it through the matching writer codec,
and marks it ready only after reconciliation. Readiness is tied to the physical index UUID; the active Search service
supplies the compiler capability only when that exact generation is ready. Old year-only generations remain
unavailable for precise candidate compilation, including under NOT.
The universal condition editor preserves imported typed endpoints as text, with its existing localized bound
labels, rather than coercing them into numeric years. These primitives do not enable the release journey.

Decision: when a platform is selected, release languages constrain that same `schema:gamePlatform` statement
through its `schema:inLanguage` qualifier; without a platform, they use the release-level language facet.

Decision: expose developer and publisher controls only when the active release subtype admits their exact property;
do not expose a generic producer control without a separately admitted Semantic property.

## Remaining integration

Decision: mixed calendar documents use format 3, derived from the immutable mixed format-2 mapping with calendar
fact fields; format-2 documents and physical generations retain their year-only meaning. New mixed physical
generations use the format-3 mapping, and population, replay, reconciliation and continuing native writes select
their codec from that physical mapping. Publication remains behind the existing complete population and replay
lifecycle; old generations keep their original mapping and writer shape.

The work grouping, bounded child/group continuations, active-release operand controls, mounted release page,
eight-locale states and native all-pool growth measurements remain part of the same journey. There is no measured
grouping seek count or native growth result yet; derive its seeks from real relation indexes, source caps and
preparation plan before claiming a page bound.
