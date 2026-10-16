# Target architecture

Use standard vocabulary, one authoritative representation per meaning and bounded
owner operations. Evaluate architecture by the work needed to add a view or
vertical, rather than by endpoint count. Domain names such as Book and Recipe
can appear in code without requiring separate engines.

The [overview](overview.md) describes installed ownership. The contracts below
own domain decisions; this page keeps cross-domain choices and unresolved
qualification. A design target does not claim deployed behavior.

## Data placement and representation

[Storage ownership](../storage/ownership-and-placement.md) defines writers and
movement. Public identities, names, relationships, Statements, classification
and accepted placements belong in RDF. Keep current semantics sparse; retain
exact revision payloads by digest with owner-managed revision locators.

Content bodies and drafts, private authority, sessions, follows, Library state,
notifications and operational counters belong in PostgreSQL. Object storage
holds media and sealed payloads. Ordering indexes and uniqueness reservations
are physical algorithms, not competing semantic authority. Erasure journals,
holds and replica inventories need independent custody so restore cannot undo
suppression. Unadopted external graphs remain in isolated Source scope.

The target removes RDF copies used only for text search in favor of jena-text
external entity documents. Public names remain graph facts. This differs from
the installed body projection described in [search](../contracts/search.md#postgresql-body-projection);
change publication, query scope and generation proofs together before switching.

A graph command retains a small commit proof in its own transaction. Retire it
only after the owner has custody of the full receipt and outbox; writing a
PostgreSQL receipt after a graph commit alone is insufficient. Public type,
package and revelation relationships should converge on graph authority while
admission, solver results and private positions retain their owners.

Keep sparse chapter identities and placements for wiki references, appearances,
spoilers and reuse. An unreferenced parsed outline can remain outside RDF.
Exact pins, DefinitionRefs and receipt results remain resolvable. Cold history
and asynchronous analysis do not require arbitrary historical SPARQL. Bound hot
history by both age and fact count; choose the limits from measured churn.

Provisional density targets are about 16 quads per metadata-only book, 8 per
chapter with one placement, 4–6 per additional placement, 3–8 for a referenced
chapter coordinate, and 6–12 or more per qualified Statement. Ordinary tagging
uses a local relation and head metadata; independently contestable classification
uses a Statement. These are qualification targets, not measured capacity.

## Storage engines and qualification

Use Jena TDB2 for the first release. Compare Virtuoso OSS on the same sparse
representation only if Jena fails workload qualification. QLever is a later read
or analytical replica; exact history, authority and read-after-write return to
the authoritative owner. Do not build a database, pre-shard by domain/language/Zone,
or add distributed transactions ahead of a measured need.

The capacity objective is 500 million business entities, with 300 million as
the fallback qualification. A 256 GiB RAM/NVMe host is the starting candidate,
not a deployment claim. [Workload budgets](../storage/workload-budgets.md) own
current preparation and import limits; old extrapolations are not acceptance.
Batch one business task into one durable commit where possible. Keep parsing,
upload and inference outside the writer.

A candidate engine must perform preflight, CAS, policy, update, post-state
invariants, focused SHACL and commit evidence in one durable transaction.
Reject candidates requiring a private fork. Default-graph placement needs joint
qualification of command, SHACL and text scope before replacing current storage.

Use Jena statistics after imports and distribution changes, tuple `VALUES`,
bounded property paths, `LATERAL` and `CONSTRUCT` before custom closure or caches.
Timeouts diagnose and bound failure; they do not prove local work. Use RDF Patch
for cold differences and export, while receipts, commit proofs, PROV and
CloudEvents retain separate meanings.

Keep live datasets under `NoEntailment`; small sealed vocabularies may use
offline reasoning. RDF 1.2 triple terms need separate index qualification before
primary storage. Do not add RDF Delta, Kafka connectors, a second history engine,
HDT authority, or full live RDFS/OWL/`owl:sameAs` closure. Dynamic spatial queries
use a PostGIS projection rather than an immutable GeoSPARQL index.

Use the [pinned Jena CLI](../development/toolchain.md#pinned-jena-cli) and private
maintenance wrappers. Replacing the runtime with a full Fuseki UI server solely
for one maintenance endpoint is unwarranted. Validate `sh:conforms`, including
actual focus coverage, rather than relying on the SHACL CLI exit status.

## Versioning and evolution

[Model profiles](../contracts/model-profiles.md) own evolution: accepted means
the current reviewed definition, while retained manifests, payloads and exact
references remain immutable. Format, content, publication and snapshot versions
serve different purposes. Optional properties, relaxed constraints and UI metadata
do not create new semantic families; a changed meaning needs a new term.

Before public release, converge each family on one current definition and rebuild
seeds and fixtures. Remove compatibility readers, cutover APIs, startup backfills
and old URL syntax. Retain only authored value, source evidence or exact-reference
obligations. After release, use a local converter only for a real client need.
Package reads verify sealed solver results; re-running a historical solver is
an explicit audit action.

SHACL Turtle is the authored constraint source. Generate only the finite TypeScript,
TypeBox and JSON-LD adapters it can support without losing JSON container, null
or lexical meaning. Avoid a second authoring DSL, LinkML authority, ShEx validation
source, frozen accepted-definition lock or generic self-validating arbitrary data.
[Presentation](../contracts/presentation.md) owns field metadata, task editors and
independently versioned extension payloads; `rdf:JSON` alone does not validate
payload structure.

## API, semantics and communities

[API](../contracts/api.md), [commands](../contracts/commands.md) and
[queries](../contracts/queries.md) separate ordinary edits, reviewed queries and
named tasks. Authority, publication, money, algorithms, erasure and recovery
remain owner behavior. Route metadata generates transport inventories; do not
introduce a universal runtime operation registry. The browser submits retryable
owner operations rather than orchestrating persistence.

Reviewed SPARQL templates carry typed parameters and response schemas, scope,
physical access qualification and budgets. Bind RDF terms rather than trusting
text substitution for injection safety. Resource CONSTRUCT/JSON-LD reads use
fixed contexts over an already authorized finite graph. Do not fetch remote
contexts on ordinary requests. SELECT lists keep explicit typed JSON schemas.

Initial query design budgets are 64 roots per batch, pages of 20 by default and
64 at most, two hops and 256 candidates for ordinary reads. Sorting requires a
seek path; exact counts require maintained metrics, otherwise return a lower
bound or job. These limits await executable admission qualification. ETags bind
selected owner/component revisions, with revocation and erasure admission before
304. Arbitrary public SPARQL, Graph Store writes and remote SERVICE stay closed.
Any later restricted SPARQL admits public data and qualified template structures
only, without Update or SERVICE.

[Classification](../contracts/classification.md), [Context](../contracts/context.md)
and [semantic model](../contracts/semantic-model.md) distinguish topic, typed
classification, local placement, interpretation and acceptance. Global can mean
an interpretation, acceptance holder or public population; new APIs use explicit
fields for each. A shared SKOS scheme can be reused without copying labels or
transferring edit authority. Realm-local policy never comes from `broader`,
mapping or implication. [Space](../contracts/space.md) owns the independent
Space, Zone and Realm roles and [Realm participation](../contracts/realm-participation.md)
owns admission. A new Realm represents a new community, not a new private section.

[Information verification](../contracts/information-verification.md) owns the
convergence of verification claims on Statement meaning. Preserve precision,
valid time, edition scope and exact targets. PROV attribution distinguishes
speaker, activity and acting Agent; `actedOnBehalfOf` needs real delegation.
Batch exact decision joins, pinned Context resolution and hydration of selected
IDs. Do not group every Statement before pagination or interpret hidden as absent.

## Presentation and authority

[Presentation](../contracts/presentation.md) owns Content-backed Zone documents,
extension blocks, read shapes, semantic components and replaceable renderers.
Semantic definitions, capabilities and the presentation catalog stay separate;
the catalog references owner contracts rather than cloning permissions. Unknown
blocks remain preservable and exportable with an explicit public placeholder.
Ordinary reading invokes no model. Third-party executable blocks stay closed.

[Identity and Access](../contracts/identity-and-access.md) owns current authority,
controller continuity and platform gates. Public ORG/SIOC/Role descriptions do
not grant authority. Do not adopt Solid authorization, DID primary keys,
general VC issuance, OpenFGA or SpiceDB in the first release. ActivityStreams
vocabulary is admitted separately from ActivityPub federation, which is deferred.
Stable REZICS identity and controller transfer do not promise cross-platform
identity/follower migration.

## Performance and consistency

A read or continuation binds its owner, component or collection revision, not a
site-wide sequence. Independent owners must not share a correctness counter,
fence or global row. TDB2 can retain one active writer while its work stays
bounded. Outbox positions carry stream scope and cannot be compared across streams.

Maintain ratings, ranking coverage, search indexes and seek checkpoints
incrementally. Bound joins, iterations, recomputation and write amplification,
not just output. Exhaustion returns a meaningful partial outcome and continuation;
a request budget is not a product inventory cap. Pool checkout has a deadline,
and a checked-out client cannot borrow another from the same pool. Valid input
must not poison shared projection pipelines; an unprojectable target cannot block
unrelated work.

Use local generation dependencies for prepared writes and Context/Statement reads.
Use incremental Event buckets, subject/predicate/meaning seek, paged follow fan-out,
bounded verification traversal and batched erasure maintenance. Popular sorted
classification and late chapter pages need physical ordered seek paths. These
are design requirements; inspect current owners before treating an old file/line
inventory as an outstanding defect list.

## AI acceptance

Keep Access, CAS, transactions, receipts, source evidence, withdrawal and recovery
deterministic. Content is data, not authority to change rules or move private bytes.
Progress from drafts to reviewed reusable mappings and then qualified low-impact,
compensable automation under the same owner APIs. High-impact actions need human
approval. Record automated acceptance as policy-approved automation.

Qualification binds task, source, language, model configuration, evidence process
and evaluation-set revision. Keep source revisions, raw output, configuration,
verifier results and acceptance decisions for reevaluation; a new model adds a
judgment rather than overwriting one. Evaluate judges independently of generators.
Prefer reusable mappings for stable structured sources; per-item inference is
appropriate for extraction, translation and review. Compare total cost per
accepted result. Automatic identity linking needs at least 99.5% precision and
an impact-specific error budget. [Agent contribution](../contracts/skills-and-prompts.md)
owns official inference funding and review fallback.

## Release choices and unresolved qualification

[The capability map](../product/capabilities.md) and [plan](../plan/README.md)
own release sequencing. The first public scope includes the book library,
recipes, visual-novel and Bangumi-like catalogues and most Realm/Zone capabilities.
Forum counts, ranks and page sections may lag with explicit freshness and bases.
Unfinished operations remain behind platform grants; opening a group changes
exposure without a second execution path.

Moderator/team roles are public. Member counts are public; member lists default
to Realm members and can be configured by the Realm. Follow counts are public;
follow lists default to public and can be hidden by their owner. Ordinary people
classify others' resources through independently withdrawable Statements; authors
and local moderators may use compact relationships within their authority.
Managed navigation pins scheme revisions while discovery can follow live schemes.
Older descriptive data remains readable with quality state after tightening;
authority, privacy and core structural violations fail immediately.

Suppression is immediate. The target physical erasure periods are 30 days for
active storage and 90 days for backup expiry, with the erasure journal replayed
before restore serves reads. Show suppressed, retained, destroyed and blocked
separately. Authorized export, template APIs and current public N-Quads are the
initial data channels; history dumps and update subscriptions remain gated.

Qualification still needs the business-entity mix at 500 million, hardware budget,
acceptable maintenance/recovery/rebuild windows, and hot-history age/fact limits.
The launch thesis ties the 300-million fallback to the funding decision; this is
an unresolved business constraint, not an engine guarantee.
