# Service boundaries and dependency contracts

## Logical owners and initial process placement

Account, Main, package runtime and workers have independent execution boundaries.
Access is initially hosted inside Main with a separately owned private data model
and typed interface. Logical ownership does not require an RPC. Extracting Access
later needs a measured consumer, isolation or scaling reason; see
[placement research](../research/access-and-interaction-placement.md).

| Owner | Authoritative state | External contract |
| --- | --- | --- |
| [Account](../services/account.md) | Private account lifecycle, credentials, sessions, OAuth clients and protocol grants. | OIDC/OAuth, account security, verified principal assertions and revocation events. |
| [Access, hosted in Main](../services/access.md) | Representation, roles, bindings, eligible member sets, assignment ceilings, effective admission and authority fences. | In-process check/bulk-check and commands; protected Main-hosted adapters for remote consumers. |
| [Main](../services/main.md) | Semantic aggregates in Jena; Content bodies/revisions/drafts and operational modules in PostgreSQL, each with its owner-local invariants. | Domain commands, joint Jena graph/text query, bounded Content reads, publication, adoption and common history resolution. |
| [Package runtime](../services/package-runtime.md) | Resolution/install operation state and local installation inventory under its execution owner. | Resolve, explain, lock, stage, activate, update, rollback and remove. |
| [Workers](../services/workers.md) | Their recoverable job checkpoints and execution receipts. | Consume committed intents and invoke owner commands; do not write another owner's facts. |
| API/BFF | Product sessions and bounded request aggregation. | Browser/client adaptation; no independent domain permission engine. |

Main contains explicit domain modules. They need not become remote services before
the first product journey works. A later split preserves their command and event
contracts. Media delivery, source intake, messaging and commerce have separable
owners but do not each require a dedicated initial host or cluster.

## One writer per authority

Main creates a package release and its requirements; package runtime reads an
identified graph snapshot and proposes a resolution through Main's owning
command. It cannot independently mutate catalog versions. Workers similarly
record observations and submit adoption commands. Lucene and search match-unit
projections are derived. Main is the only native writer; Fuseki is private and all indexed RDF changes use its text dataset wrapper.

Content commands use Main's PostgreSQL adapter. Their revision, head, receipt and
outbox commit together; graph adoption references exact prepared revisions.
Projection workers cannot independently edit either authoritative body or graph
meaning. Ordinary propagation may be delayed under the [publication workflow](../contracts/commands.md#content-publication-and-delayed-visibility).

The public Agent description belongs to Main. Private account identity belongs to
Account. Ability to act as that Agent belongs to Access. Realm enrollment requests
belong to Main's community module; Access owns effective security admission.
Activation is a staged protocol with an idempotent operation ID and explicit
pending/failure states. Neither a catalog description nor an accepted application
alone constitutes an effective grant.

## Trust and calls

Use authenticated service identities, audience-bound credentials, deadlines,
bounded retries and correlation IDs. Forward only verified principal/context
claims; never trust a client-supplied Agent ID. Internal networking is not an
authorization exemption. Browser tokens and service credentials have distinct
audiences. Access private IDs stay out of public RDF, errors and events.

Account outages prevent new authentication; existing requests follow session and
revocation freshness policy. Access outages fail protected admission closed.
Main durability does not depend on delivery or search being online. Worker
backpressure limits new intents rather than growing queues without bound.

## Databases and placement

One service can own several databases, datasets and object namespaces. Several
services can share a physical database process with separate credentials and
logical ownership. Cross-owner reads use APIs or admitted projections; no shared
private table access becomes an undocumented integration contract.

Service separation is independent of machine placement. [Deployment assessment](../operations/deployment.md)
selects principal-service concentration on one host as its starting candidate,
with API/unrelated workloads on the second. Account may be placed on either.
