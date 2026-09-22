# Graph-integrated full-text acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| SEARCH01 | Join Realm tag/rating, Main Version Chinese body and text query | One Fluree plan yields correct binding and ranking scope. |
| SEARCH02 | First search candidates all fail graph condition | Continue/prove result or report incomplete; no false complete Top-K. |
| SEARCH03 | Public title and private body contain different terms | Private text cannot affect hits/snippets/facets. |
| SEARCH04 | Join repeated relations before grouping | Multiplicity and declared dedupe/aggregation preserved. |
| SEARCH05 | Run policy search on unsupported multi-ledger/source path | Explicit unsupported/unavailable, not successful empty result. |
| SEARCH06 | Index/query Chinese Japanese Korean and mixed identifiers | Same versioned analyzer; relevant matches and correct original selectors. |
| SEARCH07 | Change joined author/classification/selection | Bounded affected-root refresh, not full-corpus sync. |
| SEARCH08 | Switch analyzer/backend generation during paging | Snapshot-bound cursor or explicit restart; rollback respects erasure. |
| SEARCH09 | Ask historical search on current-only index | Unsupported result, not mislabeled historical data. |
| SEARCH10 | Exhaust candidate/memory/time budget | Typed partial/budget outcome; count/facet precision independently stated. |
| SEARCH11 | A visible searched property coexists with a hidden matching property | Any-visible-property admission cannot reveal the hidden match, score, snippet or count. |
| SEARCH12 | Access/content epochs advance on opposite sides of query admission | The declared lease/fence behavior holds; no unqualified post-filter fallback. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
