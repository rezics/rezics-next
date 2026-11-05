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

Decision: both public web response readers preserve optional month/day and reject a page containing an invalid
Gregorian fact as unavailable, so malformed wire evidence cannot silently turn into a year-only date.

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
labels, rather than coercing them into numeric years. Grouped release search uses these existing precise range
primitives when the exact physical generation is ready.

Decision: when a platform is selected, release languages constrain that same `schema:gamePlatform` statement
through its `schema:inLanguage` qualifier; without a platform, they use the release-level language facet.

Decision: expose developer and publisher controls only when the active release subtype admits their exact property;
do not expose a generic producer control without a separately admitted Semantic property.

Decision: derive release-capable subtypes and controls from the shared inherited facet roster and released
datatypes; developer and publisher operands can be combined independently in one filter.

`admittedReleaseSearchControls` describes each subtype's admitted platform/language relationship, calendar
operand, age-rating units and separate credit roles. Its roster is metadata, not enumerated option values or
current population evidence. Language codes need the released code pattern; platform-language controls also
need that exact qualifier admission. Missing properties, incompatible datatypes and absent quantity units
withdraw the corresponding control. The filter builder consumes this same descriptor, preventing controls and
admission from diverging. Existing role-specific producer operands retain their exact role meaning.

## Mounted release journey

Decision: platform, developer and publisher operands are chosen from localized public subject suggestions; URLs retain canonical subject IDs and resolve their current labels again when opened.

Decision: ordered display languages and release-language operands have separate URL fields; applying a predicate
edit drops result continuations, while navigation links preserve the complete form and ordered operands.

Decision: grouped results use `representation: 'release-grouped-v1'` on the universal search operation; `operation: 'children'` resumes one work's independent expansion, while omission selects the group stream.

The mounted `/search/releases` page derives subtype controls and its filter from the shared `@rezics/filter`
release roster. It preserves precise calendar endpoints, separate developer/publisher operands, imported Boolean
conditions, sort, spoiler threshold and display language order across URL navigation. Unsupported or withdrawn
operands remain in the repair form and are never silently removed. Grouped responses render current work cards,
matching release previews and standalone releases. Each work expansion has its own sealed child continuation; cards
retain current summaries, exact recorded date precision and public figures.

Decision: mixed calendar documents use format 3, derived from the immutable mixed format-2 mapping with calendar
fact fields; format-2 documents and physical generations retain their year-only meaning. New mixed physical
generations use the format-3 mapping, and population, replay, reconciliation and continuing native writes select
their codec from that physical mapping. Publication remains behind the existing complete population and replay
lifecycle; old generations keep their original mapping and writer shape.

## Grouping execution policy

Decision: grouped release searches expose work-name and relevance order, defaulting to work-name; rating order is not supported.

Decision: incomplete relation previews never establish work ownership or child completeness; only explicit native
EOF ends a group, and a work with no proven matching child prepares within its own bounded continuation.

`release-search-grouping.ts` supplies the source-independent group/child execution policy. Complete adopted work
links distinguish absent, unknown, contradictory and unavailable targets. Repeated links to the same current
canonical work form one ownership link; a hidden target never supplies an identity or disagreement count.
Ungroupable current matching releases stay individual results, without a fabricated work or child enumeration.

Groups and children have separate private continuation payloads. Each binds the entire admitted filter, query,
ordered language chain, sort, spoiler threshold, page sizes, active release, physical generation identity and a
source epoch. The native epoch must cover disclosure, redirects, dates, credits and order across every source
pool. A before/after observation rejects concurrent change; every resume rehydrates current matching releases
and canonical visible works. Precise ranges require readiness for the exact physical identity.

The policy limits a response to 20 groups, 20 children or three preview children per group. Each invocation also
caps candidate keys at 256 and logical source calls at 64, including initial/final observations and hydration.
An exhausted work budget with no result produces preparation progress, never an empty terminal group. These
are policy caps, not measured native seeks. Preview EOF comes only from the owner's complete child stream.

`ReleaseGroupingSource` connects the retained native group/child streams to whole-filter current matching,
disclosure and canonical work hydration. Every admitted card is projected through the existing current summary,
fact and public figure readers; sampled `SubjectSource.statements` and Search hit facts never establish ownership.
The grouped HTTP response uses the existing encrypted, viewer-bound cursor lifecycle and exposes only opaque child
tokens, never raw positions, work keys or source epochs.

`release-search-cursor.ts` seals both the group continuation and every preview's child continuation, with separate
stream and work bindings. Its public groups contain only opaque child tokens; it snapshots the ordered request
before asynchronous reads so the policy and both cursor envelopes retain the same meaning.

The native source reserves canonical-name seeks, native relevance reads, current source hydration and the complete
work-link reader's internal work by pool. The grouped POST route binds both cursor streams to the viewer, request,
active release, physical generation and current source epoch. The mounted page keeps work expansions independent,
retains URL operands and localizes accessible preparation, repair and restart states in all eight locales. Growth
measurement and browser inspection remain deferred until the applicable validation policy permits them.

Decision: expose grouped release pages as `release-groups-v1` on the existing subjects search route; child requests
carry the work ID and their own cursor while group requests retain the group cursor.
Decision: relevance ranks each work by its first current matching release in native relevance order; ungroupable releases keep their own native relevance position.

Decision: native name traversal uses one shared canonical-name frontier across occupied homes in all pools;
every pool's retained cut, including an empty pool, participates in invalidation.

`release-search-name-stream.ts` merges the owner's native name pages in PostgreSQL UTF-8 order with a bounded
frontier. It reserves every home seek and its internal observations before dispatch, repeats reservations for
replayed lookahead and empty seeks, and revalidates all pools before returning. A full native window requires
another seek to prove EOF. These internal candidate keys establish neither matching, grouping nor disclosure.
The grouped source classifies these candidates, hydrates whole-filter matches and cards, and observes final
authority before returning. Growth measurements remain deferred; this traversal alone does not claim a whole-page
work bound.

Decision: a current CreativeWork that also admits release operands can independently supply a work candidate and
an ungroupable release candidate; neither role establishes a matching child.

`release-search-native-stream.ts` connects the all-pool name frontier and native relevance order to current Subject
snapshots and the complete native `schema:exampleOfWork` reader. Relevance emits a canonical work at the first
current matching release in native order, then suppresses later releases for that work. Child candidates have
independent per-work progress. Both streams advance past rejected candidates and require native EOF. Sampled facts
never determine ownership. Missing complete-reader support or evidence makes the operation unavailable; explicit
incomplete evidence remains unproven, and concealed targets retain the owner's identity-free unknown value.

Its retained cut includes a required full-authority observer in addition to every pool's canonical-name population.
Current snapshot positions and security revisions must agree with their name homes. Release, physical generation
and all source authority cuts participate in private stream bindings and before/after validation, including empty
pools. Dispatch reservations cover current snapshots, complete work-link calls and the reader's bounded internal
statements, canonical targets and final authority checks. Current matching, cards, viewer-bound HTTP continuation
and the localized page are installed; growth measurement and browser inspection remain deferred by validation policy.
