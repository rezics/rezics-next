# Commands and cross-owner consistency

## Local command boundary

Each owner commits its domain change, exact revision or selection anchor,
terminal receipt and outbox batch in one local transaction. Main graph commands
use one guarded update through Fuseki's text-wrapped TDB2 dataset; Content and
private owners use their PostgreSQL transactions. An Access or relay receipt
cannot prove that another owner's mutation committed. Object bytes are verified
and retained before graph activation, outside the graph writer transaction.

The command binds a verified actor and scope, target, expected state, canonical
request digest, idempotency key and bounded input. A changed digest for the same
key conflicts. A graph guard covers exact target, expected head, create-only
condition, data/routing epoch and mutable validation dependencies, including
selected model heads and explicitly absent protection heads. A preflight read
or SHACL report does not lock those dependencies. If a read set cannot fit the
guard budget, stage an immutable generation or reject that write profile.

The guarded transaction advances its own application source position and writes
one receipt and outbox batch, including an explicit zero-event batch. Unrelated
dataset sequence progress never proves this command succeeded. A Fuseki HTTP
success can mean an unmatched update; a timeout can hide a committed effect.
Resolve the command's own receipt before retry or reply. A matching digest
reuses its outcome. An absent receipt leaves the result pending while the
original update might still commit. Seal stale, rejected, no-op and cancelled
outcomes against receipt absence and the observed decision state, then reread
the winning receipt. [Jena's command endpoint](../storage/jena.md#transactional-command-endpoint)
and the [SYS fault cases](../testing/backend-integration.md) qualify this rule.

Receipt retention has an explicit replay horizon. Expired keys need rejection
or an identity tombstone; a restored epoch never silently resets idempotency.
A retained old-lineage receipt may resolve an old command, while a missing one
after rollback needs recovery reconciliation before any replay of external
effects. Broker dedupe windows do not supply this guarantee.

## Protected editorial effects

[Editorial protection](editorial-protection.md) adds exact candidate, approval,
control and decision dependencies to a guarded transition. Approval and bounded
application commit together only within one owner; cross-owner work remains
pending until each owner confirms its effect. A new key cannot apply one proposal
revision twice. Current authorization governs replay disclosure, and a state
conflict is terminal only after its typed rejection receipt wins the same race.

## Cross-service workflows

Use durable planned, staging, ready, activating, active, cancelling, failed and
completed phases as applicable. Record prerequisites, exact owner receipts,
lease/fence and compensation per step. Compensation is a new authorized effect;
it cannot erase independent edits or reverse an unknown external outcome.
Expose pending state until all required owners are ready. Domain phase is
separate from the [API operation status](../implementation/api-and-events.md#operation-representation-and-errors).

## Content publication and delayed visibility

Content acceptance, owner commit, graph publication and search visibility have
different completion points. Content saves exact variant revisions and receipts
in PostgreSQL, pins immutable bytes for publication, then an admitted graph
command commits the exact reference, semantic revision, receipt and outbox in
TDB2. No body fetch runs inside the graph writer. The graph result is reconciled
into Content preparation: ambiguous activation keeps the pin, a rejected one
retains the saved revision, and duplicate delivery reuses the result. Pin release
needs proof that late activation cannot succeed. Search consumes committed
events and activates a complete qualified projection independently. Exact
read-after-write requests carry their dependency and deadline; they may remain
pending. Access revocation and erasure retain their stronger fences.

The installed Main publication and eligibility routes bind an exact Content
revision, digest, owner epoch, resource, variant, expected graph head and current
Account/Access admission. Eligibility separately checks original-author proof.
Their schemas, receipts and tests define the wire result. [Content storage](../storage/postgresql.md#publication-preparation-and-retention)
and [search projection](search.md#postgresql-body-projection) own retention and
derived visibility.

## Reads and bounded work

Local read-after-write verifies the same owner/dataset/epoch/sequence fence with
the read and a deadline. Historical reads verify immutable bytes and current
disclosure. Derived reads report generation and freshness. Cross-owner snapshots
seal and validate their specified dependencies. Revocation stops later Access
admission; stronger no-old-authority guarantees also drain or cancel admitted
work before acknowledging the scope fence. Domain CAS still guards resource state.

Bound batch size, bytes, affected entities, traversal, lock time and retries.
Large topology or rebuild jobs stage bounded pages, recheck fences at every
page and activate one validated generation. Failed staging leaves the active
generation intact. Cancellation must state whether an effect already committed.
