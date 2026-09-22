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

Test uncertain years/months, offsets, DST, fictional calendars, two aliases of one
event, mixed planned/actual dates, stale cursors and correction during rebuild.
