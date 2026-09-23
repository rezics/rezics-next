# Access-to-Jena authorization bridge

## Owners and actual enforcement

Access owns current principal admission, representation, grants and authority
fences in PostgreSQL. It is a typed module inside TypeScript Main. Main owns content
lifecycle, exact publication selection, field disclosure and query compilation.
Fuseki executes admitted SPARQL against TDB2 and jena-text/Lucene in one JVM.
These are separate storage transactions even when they share a machine.

Fuseki endpoint authentication is infrastructure protection; it is not a Fluree
policy engine or an implementation of REZICS grants. Named graphs, RDF types,
SHACL and a signed JWT do not authorize an individual fact or text unit. Main
is the product enforcement boundary. Deny public access to raw Fuseki query,
update, Graph Store, upload and administration surfaces; only scoped internal
credentials and maintenance paths may reach them. The relevant distribution's
[Fuseki security configuration](https://jena.apache.org/documentation/fuseki2/fuseki-security.html)
must be configured explicitly, not inferred from administrative endpoint defaults.

Every protected value and MatchUnit has a disclosure scope and exact content/
selection generation. A readable Resource header does not authorize its body,
private name, old revision or hidden relationship. Apply scope rules to graph
intermediates, candidate selection and aggregates, not only returned resources.

## Query admission and delivery

1. Main verifies Account/client assertions and selects the intended actor/context.
   Access loads the needed policy, membership, representation and fence inputs
   from one coherent PostgreSQL authority snapshot.
2. Access returns a bounded QueryAuthorizationContext: audience, subject/context,
   action, policy revision, relevant scope epochs, validity and opaque decision
   identity. It never turns all readable resources into a JWT payload.
3. Main binds current content selection, application data fence, index generation
   and trusted scope mapping. It compiles only supported graph/field/predicate
   patterns and checks that the actual execution path enforces every required
   constraint. Missing or stale authority/content input fails closed.
4. Run the admitted query. Protected joins must constrain contributing values
   before they influence matching, scoring, grouping, counts and diagnostics.
   Current supported profiles are recorded in the [search contract](../contracts/search.md).
   Bounded bulk Access decisions can prepare an eligible relation, but merely
   placing a `FILTER` late in SPARQL is not proof of pre-match enforcement or
   completeness. Qualify binding propagation and the actual query plan.
5. At response or stream delivery, check that the admission remains eligible
   under its fence/lease contract and that selection/disclosure has not invalidated
   the result. Revoked or expired work is cancelled/restarted. Revalidating a handle
   does not authorize reuse under a different subject or expand its original scope.

The bootstrap public-text corpus avoids private text participating in Lucene
retrieval. Current public scope narrowing still fences affected search before
stale entries can contribute. Private graph-bound text is a retained product
requirement with a separate qualification gate: prove pre-match candidate
restriction, mixed public/private-field safety, counts/snippets and statistical
isolation. Until then reject that query shape as unsupported. A conservative
all-hidden result must not masquerade as a successful empty answer.

## Cross-store admission and revocation protocol

Use a durable Access admission registry in PostgreSQL for effects requiring a
revocation guarantee. Each record binds operation/request identity, request digest,
subject, scopes, authority epochs, admitted capability and deadline. Registration
and scope-gate checks occur in the same authority transaction using the owning
scope locks/serialization protocol. All Main replicas obey it; an in-process mutex
cannot fence another replica. Scope sets are bounded and acquired in a canonical
order. New admissions against a closed or unknown gate are rejected/unavailable.

Main sends a registered command through the [Jena guarded mutation](../storage/jena.md)
path. One SPARQL conditional update checks the expected content/model/shape/
placement/data-epoch dependencies and receipt absence; it writes the immutable
revision reference, head/projection, receipt, outbox and incremented dataset
sequence together. Its receipt records admission identity and authority epochs for
reconciliation. This does not read or transactionally lock PostgreSQL authority.
A current query scope and a command's historical admission record are distinct.

Ordinary revocation prevents later admission; previously admitted bounded work
can finish only within the documented contract. For a strong revoke/restriction:

1. Commit closure of relevant scope gates and a new effective deny/authority epoch
   in PostgreSQL. Broadcast wakeups, but use authoritative state for correctness.
2. Enumerate affected registered work across Main replicas; stop new execution,
   cancel streams/tasks and drain in-flight commands. A dropped HTTP connection
   or elapsed lease does not prove that Fuseki aborted an update.
3. Resolve unknown outcomes through durable Jena operation receipts before marking
   each admission drained. Receipt absence is not proof of cancellation. When an
   outstanding command must be stopped, write the storage protocol's terminal
   cancellation receipt under the same receipt-absence guard, with its sequence/
   outbox. The original mutation and cancellation seal compete for that identity;
   reread the winner. Only a durable terminal outcome seals a delayed dispatch out.
   Keep unresolved work pending; reconcile after Main or Fuseki restart. Prevent
   new claims on closed registrations through the shared claim/fence protocol.
4. Invalidate old cache/candidate/export handles, apply narrowed selection/index
   state and acknowledge the stronger guarantee only once no old admitted effect
   can be delivered or still commit. Timeout returns pending/unavailable with an
   operation identity, never a false completed strong revoke.

This protocol is a REZICS implementation obligation, not a native distributed
transaction. A grant check followed by an unrelated Jena write, a wall-clock
lease alone, or a second check after returning bytes cannot establish it.
The implementation must qualify the register/claim/close race and make work claims
visible to the closing transaction before external execution. Cancellation may
stop future delivery while an already committed effect requires reconciliation;
it must report that distinction.

## Publication and restriction ordering

Register a new protected scope before storing content through any public path.
Prepare the exact selection and its dependencies; activation requires the owning
content receipt and current authority admission. Incomplete workflows remain
pending. Widening exposes only the prepared eligible generation after authority
activation. Narrowing uses the deny/gate sequence above before content projection,
index deletion or cache cleanup, so cleanup lag cannot reopen disclosure.

An application fence `{datasetId, dataEpoch, sequence}` identifies committed graph
state and is separate from Access authority epochs and index-reader generation.
A minimum data fence is not current permission or a retained historical snapshot.
Cross-store/multisource tokens retain their distinct positions. Restoration must
change epochs and reconcile admissions before reopening protected operations.

## Search-unit and projection discipline

A unit contains one exact disclosed literal or bounded selected fragment. Public
title and private body cannot share an admitted searchable document merely because
one property is readable. Permission constrains terms, literal bindings, snippets,
suggestions, counts and facets. A later private-text capability must also select
compatible ranking corpora or a qualified statistics policy; hidden corpus
statistics must not become an undeclared signal.

Mirror only minimal scope/selection descriptors needed by admitted queries. Each
mirror records its source authority and selection epochs; unknown freshness fails
closed. Revocation does not wait for full projection rebuild. Scope indirection
and bounded decisions avoid materializing users multiplied by resources. Public
caches still bind visibility and erasure generations. Private account/controller
identifiers stay out of graph exports, receipts visible to clients and diagnostics.

Cache/candidate keys bind subject, context, authority scope, policy revision,
data/index generation and expiry. Current delivery eligibility must be checked
even for an exact historical revision or a fully materialized query result.

## Institutional voting commands

A poll's electorate/weight snapshot is a governance input, separate from current
Access permission. Bind cast/change/withdraw to the poll, represented holder,
source entitlement or active allocation leaf, exact choice, charter/mandate
revisions and expected ballot revision. Allocation/opening binds the expected plan
and root entitlement state. The owning guarded TDB2 transaction enforces one
contribution per source unit, exclusive parent/child allocation and idempotency.

Changing current representation affects new admission without rewriting frozen
weights or historical audit. Unknown commits reconcile by operation identity
before retry or compensation; tally replay preserves the same source units.
Resolution execution additionally binds the exact approved effects and current
governance capability. See [vote invariants](../contracts/votes-and-references.md).

## Acceptance and failures

Exercise new membership after a private edit, revoked membership with old results,
mixed fields, denied intermediate nodes, changed Realm adoption, Access outage,
projection lag, cross-subject cache reuse and revocation during export. Test every
register/claim/close/commit ordering, multiple Main replicas, lost replies, expired
leases and restart with unresolved admissions. Keep ordinary admission and strong
revocation guarantees distinct in API tests.

[Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
and [SpiceDB consistency](https://authzed.com/docs/spicedb/concepts/consistency)
provide causal authorization mechanisms to study. Their tokens do not make
Access/PostgreSQL and Main/Jena one transaction. No historical Fluree policy probe
qualifies this bridge; production implementation and end-to-end acceptance remain.
