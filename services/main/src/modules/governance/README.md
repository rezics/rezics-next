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
| `../public-report/` / `../../routes/public-reports.ts` | Account-free intake, case credentials, private correspondence, statutory deadlines and preservation holds (migrations 930–931). |

Copy `store.ts` and `../../routes/reports.ts` for another Access-local case
family. Keep the represented Agent check, active scope grant, case generation,
request digest and immutable receipt, exact evidence admission, rule/head check,
decision target rows, enforcement fence and outbox write in one Access
transaction. Copy `tests/qa/integration/governance-report.test.ts` for a real
Account/Access API test; `rights-complaint.test.ts` covers the source complaint
variant. Graph-owned writes use registered profiles and owner receipt/event
declarations.

## Cost contract

Decision application reads one rule and one case under Access locks, then
compares each declared target head twice and asks its owner to accept one exact
CAS receipt. The target list is capped at 64; owner work is O(targets) and a
Content CAS uses the revision and variant indexes while a graph CAS matches one
current subject/head. Retries read the same owner receipt and do not repeat the
effect. The GOV02 integration cases count the two preflight head reads per target,
one owner apply per target, and retained Access/Content outcomes after a raced
head or lost owner response. Source observations and media Uses are immutable
evidence anchors in this first profile; their component fences retain their
reported revision and are not mutable owner CAS targets.

| Operation | Bound |
| --- | --- |
| `submitReport` | At most 16 owner evidence reads and inserts; one indexed open-case lookup. |
| Public intake | One target resolution and exact evidence capture (G-506 plus bounded Realm/Agent/reply and media probes), one indexed receipt replay and one open-case lookup. NCII adds one deadline; child safety repeats owner admission under the erasure fence and adds one indexed author/account hold. |
| Public status / correspondence | One hashed credential lookup; status returns at most 50 steps with a continuation. A correspondence writes at most 3 steps and one credential-local receipt. |
| Preservation | One indexed target or account hold lookup and idempotent postponement records. Intake and Content erasure share a target lock across owners. Held Content erasure stops before graph suppression; Account credentials may still be deleted while safety material and its reason remain. |
| `readReport` | One report key and at most 16 evidence rows; one indexed authority check for a reviewer. |
| `decide` | Two indexed Access authority checks, at most 64 preflight and 64 in-transaction target-head reads, one owner CAS per mutable target, and one fence update per target; one Access outbox fact per decision. |
| `recordStep` | One case and grant check, one receipt key, one append. |
| `readEnforcement` | Indexed target lookup limited to 50 rows. |
| `restrictedTitles` | One recovery-fence check and one indexed Access lookup for at most 64 Work/head pairs; it returns no title without a graph head. |
| `restrictedContentRevision` | One recovery-fence check and one indexed Access lookup for the exact Content revision under the global context. |
| Structure evidence | Two Structure header reads and one exact revision read, with at most one occurrence and its bounded immutable object pages. |
| Media evidence | One Use primary-key lookup joined to its immutable revision and representation. |
| `rules.publish` | One authority lookup, one rule head lock, one immutable revision; document ≤ 16 KiB. |
| `rules.read` / `rules.current` | One indexed authority or head lookup. |

The integration test checks case and enforcement index buffers with 100,
1,000 and 10,000 unrelated cases. Target heads are read once during review
preflight and re-read under the Access case/rule locks before owner CAS;
a target changed before owner acceptance yields stale with no decision or fence.
Cross-owner checks remain bounded to at most 64 targets per decision. The
resource summary and exact Content revision APIs check the committed Access
fence against the graph head or exact Content revision before disclosure. The
decision outbox fact advances the fence before search, cache, notification and
media propagation; those consumers still need owner-specific adapters. The
Structure owner must accept real create commands before available Structure
evidence can be qualified through a report API test. Source evidence currently
retains the exact observation byte digest with its reported component. A future
source component reader must prove extracted component bytes and propagated
copy identities before GOV24 is complete.

Public report categories and their processes live in `public-report/contract.ts`.
The statement and correspondence retain their original BCP 47 tag. The server
chooses platform jurisdiction except for a verified Realm-rule target. Urgent
case evidence requires the `governance.safety.evidence` grant; Realm queue and
decision-basis readers exclude it. Governance notifications bypass optional
inbox and delivery preferences.

`Idempotency-Key` for public intake is a random recovery capability (32–128
characters; UUIDs fit). The database retains only its hash. A retry returns the
same case and report with a fresh random case credential; each credential is
returned once and only its hash is retained. Clients keep both secrets privately.
Case credentials travel in `X-Rezics-Case-Credential`, never in URLs. Status
responses omit evidence, contact details and declarations; reporter and affected
party messages are separate. A staff decision must use `parties` disclosure for
its rationale to appear in the private case status.

G-565 calls `mintPartyCredential(client, caseId, reportId)` after authorizing the
affected party, within its decision/notice transaction. The secret belongs in
the private notice payload, never in an outbox or an event. The seeded specialist
role declares the grants staff provisioning must issue through Access. Deadlines
are immutable governance steps: NCII is receipt plus 48 elapsed hours;
counter-notice windows add 10 and 14 UTC weekdays, without a holiday calendar.
The timing bases follow [FTC guidance](https://www.ftc.gov/business-guidance/resources/complying-take-it-down-act)
and [17 USC 512(g)](https://www.copyright.gov/title17/92chap5.html#512).

Erasure services and restore/reconciliation commands must supply the Access pool
as `preservationAccess` when calling Content erasure. The HTTP composition wires
it from Main's owner dependencies. Hold release and actual restoration remain
staff decisions; correspondence does not release evidence or restart deadlines.
