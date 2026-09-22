# Backend acceptance map

Qualify owning contracts through actual storage and service boundaries. A schema,
generated client, successful fetch or queued job is not an executed business gate.

| Area | Required test owner |
| --- | --- |
| Identity, value and model meaning | [Model contracts](../testing/model-contracts.md). |
| Account/Access/delegation | [Identity/access](../testing/identity-and-access.md). |
| Space and contextual classification | [Classification](../testing/classification.md), [wiki composition](../testing/wiki-composition.md). |
| Main Version, creation and history | [Native Work](../testing/native-work.md), [Book](../testing/book-and-creation.md), [composition](../testing/content-composition.md). |
| Query and graph | [Search](../testing/search.md), [relationship graph](../testing/relationship-graph.md), [ratings/time](../testing/ratings-and-event-time.md). |
| Sources and packages | [Live conformance](../testing/source-conformance.md), [packages](../testing/packages.md), [Hub](../testing/ai-hub.md). |
| Governance/commerce/verification | [Integration](../testing/backend-integration.md), [Subscribe](../testing/subscriptions-and-pro.md), [verification](../testing/information-verification.md). |
| Operations | [Recovery/load](../testing/operations.md). |

Use IDs and receipts returned by preceding operations. Exercise denied and stale
states, concurrent connections, failed/unknown effects and restore. Respect the
[phase policy](execution-workflow.md). Initial practical-volume qualification
does not establish future billion-row throughput, and does not require it.

The [fast-start milestones](README.md#fast-start-milestones) select the first subset:
S0 graph persistence/text, S1 guarded commands and authority, S2 authenticated
Work/Realm/edit/search. They do not waive remaining capability cases. In particular,
passing public-text smoke queries does not qualify private search, language relevance,
application SHACL, permanent revisions or a production recovery set.
