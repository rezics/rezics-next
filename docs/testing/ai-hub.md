# Skill Prompt and MCP acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| HUB01 | Import current Skill directory and manifest | Preserve files/declarations; missing requirements explicit. |
| HUB02 | Edit Prompt parameters/examples | Exact revisions and schema applicability retained. |
| HUB03 | Resolve Skill package dependencies | Use ecosystem profiles and concrete artifact lock. |
| HUB04 | Ingest malicious instruction text | No execution or secret/network authority. |
| HUB05 | MCP server changes tool schema/capabilities | Observed version drift; no silently widened consent. |
| HUB06 | Invoke controlled protocol cases | Pagination, errors, cancellation and delegated scopes preserved. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
