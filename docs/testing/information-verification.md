# Information verification acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| FACT01 | Two sources repeat one original claim | Dependency lineage prevents false independent corroboration. |
| FACT02 | AI output is re-ingested | Not treated as an independent authoritative source. |
| FACT03 | Counterevidence or missing source | Preserve disagreement/unknown; not automatic false. |
| FACT04 | Source corrected after assessment | Bounded invalidation and exact old assessment history. |
| FACT05 | Export to an independent evaluator | Claims/evidence/method/policy and losses remain inspectable. |
| FACT06 | Paid index result challenged | Funding cannot change verdict or suppress material correction. |

## Required assessment and protection subcases

The following refine FACT01-FACT06 without adding new acceptance IDs. They remain
prospective; existing source-support reads do not qualify a general verdict or
quality projection. The [verification contract](../contracts/information-verification.md)
owns the dimensions, records, planned APIs and cost bounds.

| Scenario | Existing case | Required result |
| --- | --- | --- |
| Different sites, source attachments or domains repeat one origin | FACT01 | Known copying is not independent corroboration. Unknown dependence stays unknown; circular or over-budget lineage produces explicit incomplete/abstaining output. |
| AI output cites earlier AI/source copies and is re-imported | FACT02 | Retain exact derivation, method/model and inputs. Neither a new model nor a new URL manufactures another independent source. |
| A source is reliable for identifiers but untested for plot summaries | FACT03 | Keep domain/context-specific source assessments and separate claim support. Source reputation does not become a truth flag on every field. |
| A changed announcement refers to a later valid-time/version scope | FACT03 | Preserve the earlier precise proposition; do not manufacture contradiction by discarding temporal/edition context. |
| Submit a challenge against a reviewed, protected value | FACT03 | Record pending challenge and exact counterevidence without granting the submitter verdict authority. Qualified assessment may mark disputed while review history and protection survive. |
| The last source becomes unavailable or withdraws support | FACT03, FACT04 | Missing support is not automatically false. Independent confirmation/support and exact older assessments remain; required reassessment is explicit. |
| Content/evidence, source reliability, disposition or policy changes after assessment | FACT04 | Exact dependencies make the summary stale/pending even while invalidation delivery is delayed. A historical reviewed badge cannot imply a current assessment. |
| Reassessment worker finishes after a newer generation activated | FACT04 | CAS rejects stale activation. One outbox/invalidation identity has one durable effect; no old result replaces the new one. |
| A popular source change invalidates many components | FACT04 | Indexed paged dependency work is bounded, resumable and idempotent. Foreground reads verify bounded freshness proof rather than scanning the corpus or trusting queue completion. |
| Evidence or rating dependencies exceed the admitted prefix/page | FACT01, FACT04 | Reject or stage a complete manifest; no prefix is labeled complete or independently corroborated. |
| Export reviewed/disputed/stale data with private or unavailable evidence | FACT05 | Preserve exact claim/value qualifications, acceptance context, method/policy/input revisions, dependence, coverage and losses subject to disclosure. Do not flatten to a score or expose private principal/source bytes. |
| A model returns a probability-like score without calibration evidence | FACT05 | Retain it as method output with limitations; do not present it as calibrated fact probability. An independent consumer can inspect the method/basis. |
| Funded publisher demands removal of a material correction | FACT06 | Payment cannot alter review authority, evidence verdict or applicable correction notification. Current recipient disclosure still applies. |

Use [editorial-protection subcases](editorial-protection.md) for concurrent
adoption, exact approvals and protected restoration. A summary update cannot
unlock or replace adopted content. Restore older summaries against newer
withdrawal/erasure/rule frontiers and refuse false-current results.

Method quality needs representative labeled cases, held-out comparison,
calibration, coverage, abstention and adversarial/disagreement evidence; a
deterministic policy unit test does not qualify the method itself. Owner-boundary
tests verify exact history, dependency changes, disclosure and source-owner lag.
OPS05/OPS06 work probes measure dependency reads, reverse fan-out, writer time,
queue lag and cold/skewed queries independently of full-corpus capacity.

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
