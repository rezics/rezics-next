# Backend acceptance map

## Backend-only scope

The activated Goal retains every backend/API obligation in the 2026-09-26
acceptance inventory. The harness freezes all 277 case IDs with an ID-and-owner
fingerprint and selects 276 backend cases. `VIEW04` is the sole excluded ID: its
specified safe rendering of malformed historical Blocks is a rendered-client
obligation. Backend preservation of unknown Block data remains required by the
[presentation contract](../contracts/presentation.md) and MODEL/data-export cases;
this exclusion grants no authority to discard or rewrite it. Any changed case
inventory requires a reviewed scope fingerprint before backend QA will run.

Mixed cases retain these backend results through real API clients and owner
storage. Browser or Storybook results never satisfy their backend declarations:

| Case | Retained backend result | Removed rendered result |
| --- | --- | --- |
| IAM01 | Session and request-scoped acting identity remain isolated across concurrent clients. | Browser-tab selection UI. |
| GRAPH02/GRAPH06 | Relation provenance and saved layout data are returned and changed under admitted API operations. | Graph display and layout interaction. |
| VIEW03 | Zone selection and private-content disclosure are enforced by owner/API reads. | SSR/browser presentation. |
| VIEW06 | API edits preserve unknown-to-editor advanced configuration and semantic state. | Ordinary UI editor behavior. |
| VIEW08 | API language selection, availability and metadata-only emptiness are correct. | RTL layout, accessibility and visual empty states. |

The same rule applies to any other mixed case: retain its storage, authority,
operation, exact-read, recovery and cost assertions; remove only component and
rendering assertions. A named partial test contributes zero completed IDs. The
backend denominator changes only through reviewed case and scope edits, not by
omitting an unimplemented service.

The 2026-09-26 Goal includes every retained M01–M10 backend/API behavior and
G1–G4/G6. Frontend rendering, browser journeys, Storybook and G5 are excluded.
API operations are the delivery unit; all business behavior must be callable and
verifiable with the web app stopped. UI consumes these operations.

Before publishing a completion percentage, map each retained case to its API
operation. Preserve all backend clauses of mixed cases with explicit links to the
original ID; separate only browser/presentation assertions. Do not classify
authorization, session isolation, data integrity, recovery or client-independent
workflow semantics as frontend. The historical 277-ID inventory is mixed; the
reviewed backend denominator is 276 IDs.

Record implemented operations separately from passed cases. Fully passed retained
backend cases divided by the frozen backend total is the qualification percentage;
partial, failed and uncovered cases do not count as passed. Ordinary affected
checks report their selected scope. The final recorded backend run must cover the
whole retained backend inventory. The [backend harness scope](../testing/test-harness.md#backend-only-goal-scope)
is implemented; complete-case declarations and the final recorded run remain pending.

## Owner map

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
[phase policy](execution-workflow.md). Every entry path needs a derived cost
contract and applicable [complexity checks](../testing/complexity.md), including
fallbacks and background effects. Initial host profiles and small growth tests
do not establish capacity for the current 500M business entities/documents or
future 3B scenario; those claims require separately scoped deployment evidence.

The [fast-start milestones](README.md#fast-start-milestones) select the first subset:
S0 graph persistence/text, S1 guarded commands and authority, S2 authenticated
Work/Realm/edit/search. They do not waive remaining capability cases. In particular,
passing public-text smoke queries does not qualify private search, language relevance,
application SHACL, permanent revisions or a production recovery set.
