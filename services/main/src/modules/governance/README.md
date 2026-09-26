# Governance owner (Access PostgreSQL)

Template for report intake and one attributable moderation decision chain. The
owner schema is Access migrations 060–061 and 065; `access.organization_publication_moderation`
from migration 027 is the first kind in `access.moderation_decision`.

| File | Role |
| --- | --- |
| `schema.ts` | Typed table declarations; SQL migrations remain the DDL owner. |
| `evidence.ts` | Exact Content, Work/Main Version, Structure occurrence and media Use readers, plus source observation anchors. `unsupported`, `empty`, `unavailable` and `erased` remain distinct. |
| `store.ts` | Access recovery fence, report receipt, case CAS, immutable decisions and process steps, effective enforcement fence and existing Access outbox. |
| `rules.ts` | Scoped rule publication and read, with immutable revisions, a CAS head and a key receipt in migration 065. |
| `composition.ts` | Main production readers for exact Content, Work, media Use and source evidence, current heads and published rules. |
| `../../routes/reports.ts` | Report/read, decision and process-step HTTP schemas and error mapping. |
| `../../routes/rights.ts` | Rights complaint and restriction profile over the same case/decision store. |

Copy `store.ts` and `../../routes/reports.ts` for another Access-local case
family. Keep the represented Agent check, active scope grant, case generation,
request digest and immutable receipt, exact evidence admission, rule/head check,
decision target rows, enforcement fence and outbox write in one Access
transaction. Copy `tests/qa/integration/governance-report.test.ts` for a real
Account/Access API test; `rights-complaint.test.ts` covers the source complaint
variant. Graph-owned writes use registered profiles and owner receipt/event
declarations.

## Cost contract

| Operation | Bound |
| --- | --- |
| `submitReport` | At most 16 owner evidence reads and inserts; one indexed open-case lookup. |
| `readReport` | One report key and at most 16 evidence rows; one indexed authority check for a reviewer. |
| `decide` | Two indexed Access authority checks, at most 64 target-head reads and one fence update per target; one outbox fact per decision. |
| `recordStep` | One case and grant check, one receipt key, one append. |
| `readEnforcement` | Indexed target lookup limited to 50 rows. |
| `restrictedTitles` | One recovery-fence check and one indexed Access lookup for at most 64 Work/head pairs; it returns no title without a graph head. |
| `restrictedContentRevision` | One recovery-fence check and one indexed Access lookup for the exact Content revision under the global context. |
| Structure evidence | Two Structure header reads and one exact revision read, with at most one occurrence and its bounded immutable object pages. |
| Media evidence | One Use primary-key lookup joined to its immutable revision and representation. |
| `rules.publish` | One authority lookup, one rule head lock, one immutable revision; document ≤ 16 KiB. |
| `rules.read` / `rules.current` | One indexed authority or head lookup. |

The integration test checks case and enforcement index buffers with 100,
1,000 and 10,000 unrelated cases. Cross-owner target/rule head checks are
preconditions to Access commit. The resource summary and exact Content revision
APIs check the committed Access fence against the graph head or exact Content
revision before disclosure. The decision outbox fact advances the fence before
search, cache, notification and media propagation; those consumers still need
owner-specific adapters. The Structure owner must accept real create commands
before available Structure evidence can be qualified through a report API test.
Source evidence currently retains the exact observation byte digest with its
reported component. A future source component reader must prove extracted
component bytes and propagated copy identities before GOV24 is complete.
