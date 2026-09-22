# Design coverage and invariant traceability

This map connects desired behavior to implementation and prospective acceptance.
It is not another progress ledger. [The plan](../plan/README.md) owns activation
and qualification status.

| Capability | Meaning and realization | Acceptance |
| --- | --- | --- |
| Account/Agent control | [Identity](../contracts/identity-and-access.md), [Account](../services/account.md), [authorization bridge](../implementation/authorization-bridge.md) | [IAM](../testing/identity-and-access.md) |
| Space and perspectives | [Space](../contracts/space.md), [Context](../contracts/context.md), [vertical workflow](../implementation/vertical-workflows.md) | [CTX](../testing/classification.md), [WIKI](../testing/wiki-composition.md) |
| Main Version/history | [Main Version](../contracts/main-version.md), [graph records](../implementation/graph-records.md), [composition](../contracts/composition.md) | [WORK](../testing/native-work.md), [BOOK](../testing/book-and-creation.md), [COMP](../testing/content-composition.md) |
| Five indexing domains | [Catalog](../contracts/catalog.md), [recipes](../contracts/recipes.md), [Skills](../contracts/skills-and-prompts.md), [source lifecycle](../contracts/source-lifecycle.md) | [LIVE](../testing/source-conformance.md), [RECIPE](../testing/recipes.md), [HUB](../testing/ai-hub.md) |
| Packages | [Management](../contracts/package-management.md), [profiles](../contracts/package-profiles.md), [plans](../implementation/package-plans.md) | [PKG](../testing/packages.md) |
| Graph/text/context queries | [Search](../contracts/search.md), [relationships](../contracts/relationship-graph.md), [filters](../contracts/filter-documents.md) | [SEARCH](../testing/search.md), [GRAPH](../testing/relationship-graph.md) |
| Ratings and judgments | [Ratings](../contracts/ratings.md), [spoilers](../contracts/classification-judgments.md), [votes](../contracts/votes-and-references.md) | [RATE](../testing/ratings-and-event-time.md), [CTX](../testing/classification.md) |
| Presentation and addressing | [Routes](../contracts/addressing.md), [Blocks](../contracts/presentation.md), [SEO](../contracts/seo.md), [metadata-only](../contracts/metadata-only.md) | [VIEW](../testing/presentation-and-addressing.md) |
| Governance and delivery | [Reports](../contracts/content-governance.md), [rules](../contracts/governance-rules.md), [notifications](../contracts/notifications.md), [associations](../contracts/subject-association-reading.md) | [GOV](../testing/governance-and-delivery.md), [SYS](../testing/backend-integration.md) |
| Derived discovery | [Ranking](../contracts/recommendations.md), [information verification](../contracts/information-verification.md), [interoperability](../contracts/semantic-interoperability.md) | [REC](../testing/recommendations.md), [FACT](../testing/information-verification.md), [LIVE](../testing/source-conformance.md) |
| Commercial application | [Subscribe](../contracts/subscriptions.md), [Realm policy](../contracts/realm-participation.md), [scoped sites](../contracts/realm-delivery.md) | [SUB](../testing/subscriptions-and-pro.md) |
| Operations and privacy | [Deployment](../operations/deployment.md), [recovery](../operations/recovery.md), [erasure](../operations/erasure.md), [budgets](../storage/workload-budgets.md) | [OPS](../testing/operations.md), [SYS](../testing/backend-integration.md) |
| Spatial extension | [Spatial annotations](../contracts/spatial-annotations.md) | Its activation cases plus shared GRAPH/IAM/OPS invariants. |

## Shared invariants

| Invariant | Representative cases |
| --- | --- |
| I01 reference grain/resolution | MODEL01/05/10/11/12, COMP01/06/07, VIEW01/02 |
| I02 stable identity/meaning | MODEL06/07, WORK02/04/08, RATE05 |
| I03 selected cardinality | WORK03/05, COMP02/04, SYS01/03 |
| I04 exact publication/disclosure | BOOK03/04/06, SEARCH03/11/12, GOV01/02 |
| I05 current authority/fences | IAM04/05/07/09/10, SYS06/07/08 |
| I06 independent source/human support | LIVE03/05/06, RECIPE06 |
| I07 occurrence/origin continuity | BOOK02/04/08, COMP01/06, WIKI01/06 |
| I08 concurrent topology/activation | CTX08/09/10, COMP02/03/04, REC03/04 |
| I09 uniqueness/population/accountability | IAM06, RATE01/02/03/04/06, SUB04 |
| I10 idempotency/fencing | SYS02/03/04/05/08/09, PKG16, GOV06 |
| I11 erasure/recovery | IAM11, SYS07, OPS03/09/10/11/12, GOV07 |
| I12 bounded work | SEARCH02/07/10, CTX10, GRAPH03, PKG19, OPS05/06 |
| I13 exact/unknown semantics | MODEL02/03/04, LIVE01/02/07/11, RATE07/09 |
| I14 independent product grains | WORK02/04/06/07/08, PKG03/06/09, HUB03 |

Representative cases do not waive the owning contract's other requirements.
Each test records actual scope; a schema or syntax example cannot qualify runtime
behavior. Numerical objectives follow practical measurements separately from
these logical invariants.
