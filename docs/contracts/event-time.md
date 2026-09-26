# Events and temporal queries

## Meaning and values

An Event identifies an occurrence; an event-category Concept does not own a single
date. A named-event topic can have an accepted binding to an Event. Multiple topic
names can identify one occurrence without duplicate dates. Record participants
and roles in the same event/association occurrence.

Preserve actual versus planned time, start/end, instant/interval, precision,
uncertainty, calendar, timezone/reference system and lexical evidence. Recorded,
observed, publication and event times are independent. Unknown/open endpoints are
not infinities silently substituted into ordinary dates.

## Query semantics

Queries declare civil-date versus instant interpretation, definite versus possible
match, start-in/overlap and ordering. A month-only event can possibly overlap a
day without being an exact event at midnight. Convert calendars/zones only under
an admitted profile; unsupported comparison is explicit. Bind temporal conditions
to the same event instance as participant/role conditions.

## Implementation

Store exact semantic values and source lexicals in Jena. Maintain derived
normalized interval/search keys only with their precision/calendar assumptions.
An engine's date normalization cannot replace source evidence. Incrementally
invalidate selected native dates and context indexes after source/human changes.
Bound dense interval intersections; expensive exact distributions become jobs.

## Main API contract

`POST /v1/events/observations` records one immutable revision for an Event's
actual or planned time slot. The slot identity is stable for the pair
`(event, timeStatus)`, so correcting a date advances that slot's expected head
without changing the Event or another slot. A stale expected head returns a
conflict and has no effect. Each request uses an idempotency key and requires
`event:submit` plus the Access grant for the represented actor and Event.

Known endpoints carry a G-048 exact temporal value, including its original
lexical form and precision. `unknown` and `open` endpoints carry an explicit
bounded lexical explanation; they are not converted to infinities. An optional
Content evidence revision is an exact Content revision identifier. Main checks
its owning Work, the actor's read authority and the retained exact revision
before recording its reference. Unavailable Content evidence fails closed.

`POST /v1/events/queries` requires `event:read` and states whether it compares
civil dates or offset-fixed instants, and whether a match is possible or
definite. A month-only value can overlap a day as possible while remaining
indefinite for that day. Unsupported instant comparisons return an explicit
unsupported result. Date corrections fence histogram generations and invalidate
continuation cursors; clients restart a changed query without its cursor.

Named topics use G-049 `rdf:Statement` resources whose predicate is
`rv:denotesEvent`. Main includes only topics accepted by the requested Global or
Realm decision scope. Several accepted topic Statements may name one Event;
the query returns the Event once with the distinct accepted Statement IDs.

The synchronous query contract bounds its source to 2,000 event-time slots, a
page to 50 results, topic filters to 8 Statements, and a histogram to 732
status/bucket cells. A larger source fails explicitly instead of truncating.

Test uncertain years/months, offsets, DST, fictional calendars, two aliases of one
event, mixed planned/actual dates, stale cursors and correction during rebuild.
