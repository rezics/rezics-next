# Committed events and recoverable jobs

Owner transactions remain authoritative. Events report committed facts; tasks
request work and have separate consumption and retention. External effects begin
only after the owner commit. Initial delivery polls durable owner outboxes;
NATS JetStream remains a later transport choice when fan-out or isolation needs
it. A broker cannot make business effects exactly once.

## Source positions and relay

Main's graph transaction commits its receipt, event intent and application
`{datasetId, dataEpoch, sequence}` position together through wrapped Fuseki.
Content and private PostgreSQL owners use their own transactional outboxes.
Sequence is a decimal string in transport and comparable only inside one
dataset and epoch. Each sequenced RDF mutation has one bounded batch header,
including zero-event batches. Stable event IDs and ordinals identify members;
independent owners have no shared total order.

An event envelope carries event/operation ID, versioned type, owner and target,
aggregate revision, source position, routing fence and causation/correlation,
with bounded data or a manifest pointer. Private principal or credential data
must not enter public events. Internal receipt and maintenance events are not
automatically public notifications. CloudEvent source plus ID is the dedupe
identity; occurrence time, source commit position and transport time differ.

The [Main relay](../../services/main/src/modules/outbox/relay.ts) reads a bounded
contiguous batch, verifies its exact members, ordinals, terminal receipts and
domain references, then retains private CloudEvents 1.0 envelopes before
advancing the consumer checkpoint. Its retained handoff is not an authoritative
journal of later consumer effects. A crash after delivery repeats the batch;
stable event IDs and consumer idempotency handle the duplicate. Missing members,
retention gaps, changed epochs and recovery holds stop advancement. The
[SYS04/05/12 recovery cases](../../scripts/qa/cases/backend-integration.ts) exercise these
boundaries. An offline coverage head compares the acknowledged position with
retained batch and envelope digests before restored graph writes resume.

Relay pages use numeric sequence and event ID ordering, even though transport
encodes sequence as text. Retention cleanup may prune only through the admitted
recovery floor after required handoff and retention obligations. Source records
do not grant public distribution or native adoption merely by being relayed.

## Consumer and job contracts still to qualify

Consumers advance their own checkpoints only after a durable effect or
continuation. Broker handoff would wait for each event ACK before advancing its
relay checkpoint; broker consumers still own their effects. Retention expiry
requires reconciliation or rebuild, never a silent jump to the newest sequence.
Restore fences the old writer, starts a new epoch, and reconciles old receipts,
relay positions, external effects and erasure before replay. Missing old receipts
are not proof that old effects did not happen.

Jobs retain input snapshot, owner, admission basis, target, generation, lease,
fence, checkpoint, retry policy, cancellation and terminal outcome. Every page
and activation rechecks current authority and erasure. Large fan-out creates
bounded continuations. Capacity limits cover bytes, age, batch size, in-flight
ACKs and retry/dead-letter retention. Exhausted capacity delays or rejects
admission; poison messages keep a reason and replay disposition. External
deliveries need provider idempotency or uncertain-result reconciliation.

Timers only wake durably scheduled work. Recovery restores checkpoints, receipts
and fences before effects resume. Metrics distinguish ingest, relay, consumer
and active-generation lag. A successful event delivery alone does not prove
Lucene projection readiness.

Workers consume committed intents under a scoped service identity and submit
commands to the authoritative owner; they never write Main RDF directly, open
live TDB2/Lucene files or exceed delegated ceilings. Source workers limit
provider rates, sizes and redirects and only propose mappings; media workers
verify quarantined bytes before transforming them; delivery workers recheck
recipients, preferences and disclosure before external effects. Separate
expensive imports from latency-sensitive work, and treat large Lucene
reconstruction as stopped-Fuseki maintenance.

## Main owns business tasks

Decision 11, product manager under maintainer delegation, 2026-09-29.
Import matching, publication, scheduling, bulk moderation, onboarding,
save-and-pin, discovery composition and search recovery are resumable Main
operations. Clients present and poll their outcomes. Exact inputs, expected
heads, idempotency, receipts and explicit pending, partial or uncertain states
use the command and job owners above rather than a browser-only workflow.

The reason is continuity across client loss, retries and agents: closing a tab
must not erase a task's outcome. [Google's long-running operation guidance](https://google.aip.dev/151)
is a precedent for discoverable asynchronous outcomes, not a requirement to copy
its wire format or a claim that acceptance means completion.
