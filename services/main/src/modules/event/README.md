# Event time owner

`Event` is the occurrence identity. An Event has separate actual and planned
time slots; each slot points to one revision head. Topic aliases remain
`rdf:Statement` records whose `rv:denotesEvent` target is resolved through the
G-049 acceptance decision reader. Their names never create a second date slot.

Known time points use the G-048 `time:GeneralDateTimeDescription` representation
from `value-exact-v1`, including its exact lexical and temporal precision. The
event profile adds only endpoint state and a link to that shared value. Unknown
and open endpoints keep their supplied lexical without converting them to a
calendar limit. The shape follows the W3C Time Ontology's general date/time
description vocabulary: <https://www.w3.org/TR/owl-time/>.

## Operations and fences

`POST /v1/events/observations` is an Account-verified, Access-admitted Main
command. A slot is deterministic for `(event, actual|planned)`. The graph
command compares the expected head, validates event and exact-value shapes,
stores an immutable revision manifest, advances the Main sequence and writes
the receipt and outbox row atomically. Corrections preserve the predecessor.
Admission sealing, replay and stale-head outcomes use the shared owner protocol.

`POST /v1/events/queries` reads one bounded Main graph snapshot, checks each
head against its immutable manifest, and publishes derived interval rows and
sparse histogram buckets in Access migration 112. It checks the Main source
position before and after activation while holding Access's recovery fence.
Pages bind an HMAC cursor to the request and generation; a new Main sequence
returns an explicit restart response. Date-normalized rows are indexes, never
the source of temporal meaning. Accepted topic filters use the existing
Statement decision resolver.

## Cost contract

The synchronous rebuild accepts at most 2,000 event-time slots and 2,001 graph
source bindings (the last binding detects overflow). It writes at most 2,000
interval keys and 732 nonempty histogram rows (366 days for both time statuses).
A page returns at most 50 events and at most eight topic Statements; it emits
at most 732 histogram buckets including zero-fill. A larger source returns
`event_query_too_large`; unsupported instant conversion returns an explicit
unsupported-time response. These are structural caps, not a capacity claim.

The selected integration crosses Account, Access, Content, Main and Jena for
denied admission, exact Content evidence, idempotent replay, actual/planned
slots, stale and concurrent corrections, paging and histogram restart. A
separate fault fixture
closes the Access recovery fence, removes an exact event manifest and restores
its retained bytes. Unit and model checks cover month precision, open endpoints
and profile reuse. These tests do not meter remote owner attempts and bytes,
Jena scan work or SQL row-plan costs. RATE08 remains partial until an accepted
G-049 topic Statement can be recorded and decided through its owner path; that
path is currently blocked by the G-049 receipt-family registration and
decision-writer IRI validation. Production throughput and large-corpus cost
remain unmeasured.
