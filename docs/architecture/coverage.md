# Design coverage and invariant traceability

This map connects desired behavior to implementation and prospective acceptance.
It is not another progress ledger. [The plan](../plan/README.md) owns activation
and qualification status.

| Capability | Meaning and realization | Acceptance |
| --- | --- | --- |
| Account/Agent control | [Identity](../contracts/identity-and-access.md), [Account](../services/account.md), [authorization bridge](../implementation/authorization-bridge.md) | [IAM](../testing/identity-and-access.md) |
| Space and perspectives | [Space](../contracts/space.md), [Context](../contracts/context.md), [vertical workflow](../implementation/vertical-workflows.md) | [CTX](../testing/classification.md), [WIKI](../../scripts/qa/cases/wiki-composition.ts) |
| Main Version/history | [Main Version](../contracts/main-version.md), [graph records](../implementation/graph-records.md), [composition](../contracts/composition.md) | [WORK](../../scripts/qa/cases/native-work.ts), [BOOK](../../scripts/qa/cases/book-and-creation.ts), [COMP](../../scripts/qa/cases/content-composition.ts) |
| One catalogue of admitted types | [Work and release](../contracts/work-and-release.md), [recipe profile](../../model/definitions/recipe-structure-v1.ts), [Hub schema](../../services/main/src/modules/hub/schema.ts), [source lifecycle](../contracts/source-lifecycle.md) | [LIVE](../testing/source-conformance.md), [RECIPE](../../scripts/qa/cases/recipes.ts), [HUB](../../scripts/qa/cases/ai-hub.ts) |
| Packages | [Management](../contracts/package-management.md), [profiles](../contracts/package-profiles.md), [installation](../../services/main/src/modules/package/install.ts) | [PKG](../../scripts/qa/cases/packages.ts) |
| Graph/text/context queries | [Search](../contracts/search.md), [relationships](../contracts/relationship-graph.md), [queries and filters](../contracts/queries.md) | [SEARCH](../../scripts/qa/cases/search.ts), [GRAPH](../testing/relationship-graph.md) |
| Ratings and judgments | [Rating owner](../../services/main/src/modules/rating/README.md), [spoilers](../contracts/classification-judgments.md), [votes](../contracts/votes-and-references.md) | [RATE](../testing/ratings-and-event-time.md), [CTX](../testing/classification.md) |
| Presentation and addressing | [Routes](../../services/main/src/modules/address/contract.ts), [Blocks](../contracts/presentation.md), [SEO](../../apps/web/features/seo/work.ts), [metadata-only](../contracts/metadata-only.md) | [VIEW](../../scripts/qa/cases/presentation-and-addressing.ts) |
| Governance and delivery | [Reports](../contracts/content-governance.md), [rules](../contracts/governance-rules.md), [notifications](../contracts/notifications.md), [associations](../contracts/subject-association-reading.md) | [GOV](../testing/governance-and-delivery.md), [SYS](../testing/backend-integration.md) |
| Derived discovery | [Ranking](../contracts/recommendations.md), [information verification](../contracts/information-verification.md), [interoperability](../contracts/semantic-interoperability.md) | [REC](../testing/recommendations.md), [FACT](../../scripts/qa/cases/information-verification.ts), [LIVE](../testing/source-conformance.md) |
| Commercial application | [Commerce owner](../../services/main/src/modules/commerce/README.md), [Realm policy](../contracts/realm-participation.md), [scoped sites](../contracts/realm-delivery.md) | [SUB](../../scripts/qa/cases/subscriptions-and-pro.ts) |
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
