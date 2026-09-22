# Access-to-Fluree authorization bridge

## Three independent inputs

Access owns current principal admission, representation, grants and authority epochs.
Main owns content lifecycle, selected publication and per-component disclosure
scope. Fluree executes graph/text plans under a trusted policy context. None can
infer the other two solely from a signed JWT or a Resource's semantic type.

Access initially runs in Main's process, so Main-to-Access decisions use a typed
local interface. Fluree remains a separate engine; policy lowering or a bounded
provider is still necessary. Co-location does not supply cross-store atomicity or
permit cached allowances without the required freshness and revocation fences.

Every protected value/search unit has an explicit disclosure scope and content/
selection generation. Permission to inspect a public Resource header need not
permit its body, private name, historical revision or hidden relationship. Query
authorization must apply to intermediate matches and aggregates as well as output.

## Query admission

1. Main verifies Account/client assertions and requests an Access decision for
   the selected authority/context and query capability.
2. Access creates a bounded QueryAuthorizationContext: audience, principal/context
   binding, policy revision, relevant scope/authority epochs, validity and opaque
   decision handle. It does not enumerate every Resource into a JWT.
3. Main binds a data/selection snapshot and trusted disclosure mapping. Required
   authority/content freshness must be observed before query execution.
4. The Fluree adapter lowers the admitted policy to per-fact/per-unit predicates
   or a request-scoped candidate/visibility provider. Complex checks use bounded
   bulk Access evaluation inside this plan, before protected matching/aggregation.
5. Validate decision/fence eligibility at delivery under the admitted lease
   contract. Expired or revoked strong-fence work is cancelled/restarted, not
   served from a cache under a new identity.

The provider and lowering are REZICS integration work. If a rule/query shape cannot
be enforced faithfully, reject it as unsupported; do not run privileged search and
filter only final hits. Native Fluree policies can enforce the qualified subset,
but must not become a second independently administered business grant registry.

## Search-unit discipline

Partition indexed text by coherent disclosure, exact selection and revision. A
single document containing public title and private body cannot be admitted because
one searched property is readable. Protect text participating in scoring, snippets,
suggestions, count and facets. For strict isolation, choose compatible statistical
corpora or an explicitly qualified scoring policy so hidden corpus statistics do
not become an undeclared information channel.

The reviewed Fluree helper uses an any-visible-searched-flake condition. That is
insufficient evidence for mixed-disclosure document safety; REZICS must constrain
unit formation and/or implement stricter operator enforcement and test the
public-title/private-body counterexample. [Source implementation](https://raw.githubusercontent.com/fluree/db/v4.2.1/fluree-db-query/src/search_readability.rs)
supports this integration requirement; no unexecuted end-to-end claim is made.

## Publication and restriction ordering

For a new private draft, register the protected scope before it can be disclosed.
Prepare a complete content selection and dependencies, then admit its publication
under the current Access/content policy. Externally visible activation occurs only
after all required owner receipts are available. A failed step remains pending.

For narrowing visibility, advance an effective deny/fence first, invalidate or
drain prior admitted work according to the chosen guarantee, then update content
selection and derived indexes. Widening publishes no more than the prepared eligible
selection after authority activation. Reconciliation is idempotent and never
"compensates" a restriction by accidentally reopening data.

Each command declares its linearization/admission boundary. Ordinary admitted work
may complete within a finite contract; strict no-old-effects-after-completion
operations close admission and wait for cancellation/drain before acknowledging.
No sequence of independent check-then-write calls by itself proves stronger atomicity.

## Projection and cache rules

Mirror only minimal security descriptors needed by qualified queries. Each mirror
records source authority/selection epochs and fails closed when required freshness
is unknown. Revocation does not wait for a full-corpus projection rebuild.
Resource/field scope indirection and request-scoped decisions avoid materializing
all users x resources. Public caches still obey visibility/erasure generations.

Cache/query/candidate keys include selected subject, relevant context/authority
scope, data/index generation and policy revision. Opaque handles are bounded,
expiring and not transferable to another audience. Private account/controller
information never enters public graph exports or cached query diagnostics.

## Acceptance and failures

Test a new member after a private edit, a revoked member on an old search snapshot,
mixed public/private fields, denied intermediate nodes, changed Realm adoption,
Access outage, delayed security projection, cache reuse by another Agent and a
revocation during streaming/export. Check both admission-order outcomes rather
than assuming one universal timing guarantee.

[Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
and [SpiceDB consistency](https://authzed.com/docs/spicedb/concepts/consistency)
explain causal authorization concerns. Their tokens do not make Main/Fluree and
Access/PostgreSQL one transaction; the bridge must qualify its own protocol.
