# Event time owner

`Event` is the occurrence identity. An Event has separate actual and planned
time slots; each slot points to one revision head. Topic aliases remain
`rdf:Statement` records whose `rv:denotesEvent` target is resolved through the
G-049 acceptance decision reader. Their names never create a second date slot.

Participants and roles belong to that same occurrence. Event-category Concepts
describe a class of occurrences; they do not themselves carry one Event date.

Known time points use the G-048 `time:GeneralDateTimeDescription` representation
from `value-exact-v1`, including its exact lexical and temporal precision. The
event profile adds only endpoint state and a link to that shared value. Unknown
and open endpoints keep their supplied lexical without converting them to a
calendar limit. The shape follows the W3C Time Ontology's general date/time
description vocabulary: <https://www.w3.org/TR/owl-time/>.
Recorded, observed, publication and occurrence times keep separate meanings.

## Operations and fences

`POST /v1/events/observations` is an Account-verified, Access-admitted Main
command. A slot is deterministic for `(event, actual|planned)`. The graph
command compares the expected head, validates event and exact-value shapes,
stores an immutable revision manifest, advances the Main sequence and writes
the receipt and outbox row atomically. Corrections preserve the predecessor.
Admission sealing, replay and stale-head outcomes use the shared owner protocol.

`POST /v1/events/queries` consumes the Event temporal projection. A cold index
or an unfinished bucket window returns explicit coverage progress; retry the
same request while the existing Main projection worker advances it. Queries
do not build coverage or enumerate source slots. A ready page rechecks its
current graph heads and exact manifests. Its cursor binds the selected Event
collection heads and topic acceptance basis, so unrelated owner writes keep
it usable.

## Projection recovery

The existing Main projection lifecycle also advances Event source backfill,
retained outbox batches, target retries and requested bucket windows. Initial
populated backfill replays retained Main relay history from sequence zero;
indexed batch headers and members share the live delta path and commit durable
stream checkpoints. Each tick bounds all members, including unrelated writes,
before selecting Event keys. Window scans also commit seek checkpoints;
restarting Main resumes them. Missing journal coverage leaves the index
unavailable rather than enumerating or sorting the current graph. Recovery must
retain the journal and exact manifests with populated Event data.
A target with missing or inconsistent immutable bytes remains a failed pending
item while healthy targets proceed. Restore the exact retained bytes and let
the retry run; do not substitute a source scan in the query handler.

The Access recovery fence and graph lineage apply to both projected reads and
consumer work. A different data epoch requires recovery of the projection's
checkpoint and rows together before coverage can be claimed. Without the
retained relay configured, the index remains unavailable with progress.

The request and consumer budgets live in `EVENT_QUERY_COST_CONTRACT` and
`EVENT_PROJECTION_COST`. The EventTime and Event query bounds tests cover
precision, actual/planned slots, accepted aliases, authority, interrupted
backfill, target isolation, retries, withdrawal, cursor changes and more than
2,000 legal slots. The populated backfill fixture uses owner-admitted
observations and measures the actual PostgreSQL inventory plans before and
after unrelated Event growth: batch/member visits, filtered rows and shared
buffer accesses remain bounded. Its owner-command corpus uses the existing
large-tmpfs QA allocation so retained TDB2 transaction files fit during setup. Returned source rows separately count exact
target hydration; they do not measure Jena quad visits or production throughput.

Requested windows retain their own membership and counters so pagination and
histograms stay independent of the total Event population. This uses more
projection storage as distinct windows are requested. Status-leading page and
work indexes follow PostgreSQL's [multicolumn index guidance](https://www.postgresql.org/docs/current/indexes-multicolumn.html);
the sparse-status fixture checks actual filtered rows through `EXPLAIN`.
Consumer transactions use an [advisory transaction lock](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
to serialize durable scans and deltas within the existing worker lifecycle.
