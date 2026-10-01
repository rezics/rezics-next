# Governance owner (Access PostgreSQL)

Template for report intake and one attributable moderation decision chain. The
owner schema is Access migrations 060–061 and 065; `access.organization_publication_moderation`
from migration 027 is the first kind in `access.moderation_decision`.

| File                                                   | Role                                                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`                                            | Typed table declarations; SQL migrations remain the DDL owner.                                                                                                                     |
| `evidence.ts`                                          | Exact Content, Work/Main Version, Structure occurrence and media Use readers, plus source observation anchors. `unsupported`, `empty`, `unavailable` and `erased` remain distinct. |
| `store.ts`                                             | Access recovery fence, report receipt, case CAS, immutable decisions and process steps, effective enforcement fence and existing Access outbox.                                    |
| `rules.ts`                                             | Scoped rule publication and read, with immutable revisions, a CAS head and a key receipt in migration 065.                                                                         |
| `composition.ts`                                       | Main production readers for exact Content, Work, media Use and source evidence, current heads and published rules.                                                                 |
| `../../routes/reports.ts`                              | Report/read, decision and process-step HTTP schemas and error mapping.                                                                                                             |
| `../../routes/rights.ts`                               | Rights complaint and restriction profile over the same case/decision store.                                                                                                        |
| `../public-report/` / `../../routes/public-reports.ts` | Account-free intake, case credentials, private correspondence, statutory deadlines and preservation holds (migrations 930–931).                                                    |

Copy `store.ts` and `../../routes/reports.ts` for another Access-local case
family. Preparation keeps the represented Agent check, active scope grant, case
CAS, retained evidence, current rule/head checks, immutable statement and planned
targets in one Access transaction. It commits before owner dispatch. Copy
`tests/qa/integration/g-565-safety-decisions.test.ts` for staff decisions and
`rights-complaint.test.ts` for the source complaint variant. Graph-owned writes use registered profiles and owner receipt/event
declarations.

## Cost contract

Decision preparation reads the rule and case under Access locks, checks each
bounded target head twice and saves the immutable plan. The API returns `202`
with `accepted`; replaying the same key resumes effects. Each unconfirmed effect
has two short Access transactions: save uncertainty before dispatch, then hold the
operation lock through the idempotent owner call, enforcement fence and receipt
confirmation. A lost response reconciles the same decision/ordinal owner receipt.
A confirmed effect is skipped. An owner failure leaves the durable plan and a
`partial` outcome. Cases remain in the queue while effects are incomplete, after
cancellation, or when a newer report, appeal or counter-notice needs review.

| Operation                      | Bound                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitReport`                 | At most 16 owner evidence reads and inserts; one indexed open-case lookup.                                                                                                                                                                                                                                     |
| Public intake                  | One target resolution and exact evidence capture (G-506 plus bounded Realm/Agent/reply and media probes), one indexed receipt replay and one open-case lookup. NCII adds one deadline; child safety repeats owner admission under the erasure fence and adds one indexed author/account hold.                  |
| Public status / correspondence | One hashed credential lookup; status returns at most 50 steps with a continuation. A correspondence writes at most 3 steps and one credential-local receipt.                                                                                                                                                   |
| Preservation                   | One indexed target or account hold lookup and idempotent postponement records. Intake and Content erasure share a target lock across owners. Held Content erasure stops before graph suppression; Account credentials may still be deleted while safety material and its reason remain.                        |
| `readReport`                   | One report key and at most 16 evidence rows; one indexed authority check for a reviewer.                                                                                                                                                                                                                       |
| Platform queue / claims       | At most 50 results plus one lookahead; reads use at most 12 Access statements, claims 13 and holds 11 including authority and recovery checks. Keysets retain full timestamp precision.                                                                                                                      |
| `decide` / resume              | At most 64 reviewed targets; preparation retains one plan per target. Resume uses two Access transactions per unconfirmed effect, each at most 24 statements plus its owner call; graph and Content use exact receipt identities, and copy closure advances at most 100 assets per call. |
| `recordStep`                   | One case and grant check, one receipt key, one append.                                                                                                                                                                                                                                                         |
| `readEnforcement`              | Indexed target lookup limited to 50 rows.                                                                                                                                                                                                                                                                      |
| `restrictedTitles`             | One recovery-fence check and one indexed Access lookup for at most 64 Work/head pairs; it returns no title without a graph head.                                                                                                                                                                               |
| `restrictedContentRevision`    | One recovery-fence check and one indexed Access lookup for the exact Content revision under the global context.                                                                                                                                                                                                |
| Structure evidence             | Two Structure header reads and one exact revision read, with at most one occurrence and its bounded immutable object pages.                                                                                                                                                                                    |
| Media evidence                 | One Use primary-key lookup joined to its immutable revision and representation.                                                                                                                                                                                                                                |
| `rules.publish`                | One authority lookup, one rule head lock, one immutable revision; document ≤ 16 KiB.                                                                                                                                                                                                                           |
| `rules.read` / `rules.current` | One indexed authority or head lookup.                                                                                                                                                                                                                                                                          |

The G-565 integration test counts real query bounds and checks concurrent claims, receipt-preserving partial
recovery, private party reasons, appeals, expiring participation, identical copies
and legal windows. Earlier GOV02 tests describe the preceding synchronous CAS
contract and need adaptation to accepted plans and owner failure outcomes.
Cross-owner checks remain bounded to at most 64 targets per decision. The
resource summary and exact Content revision APIs check the committed Access
fence against the graph head or exact Content revision before disclosure. The
decision outbox fact commits with the final receipt and enforcement fence before
search, cache, notification and media propagation; those consumers still need
owner-specific adapters for partial progress. The
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
party messages are separate. The structured statement of reasons and effect outcome appear in credential-based
case status independently of the legacy rationale disclosure flag.

G-565 calls `mintPartyCredential(client, caseId, reportId)` after authorizing the
affected party, within its decision/notice transaction. The secret belongs in
the private notice payload, never in an outbox or an event. The seeded specialist
role declares the grants staff provisioning must issue through Access. Deadlines
are immutable governance steps: NCII is receipt plus 48 elapsed hours;
counter-notice windows add 10 and 14 UTC weekdays, without a holiday calendar.
The timing bases follow [FTC guidance](https://www.ftc.gov/business-guidance/resources/complying-take-it-down-act)
and [17 USC 512(g)](https://www.copyright.gov/title17/92chap5.html#512).

Erasure services require the Access pool at construction, including recovery
callers. Direct Content erasure requires that pool or a live owner-issued target
fence. Deferred erasure responses expose the same generic outcome; the specific
basis remains in Access's internal postponement records. Hold release and actual
restoration remain staff decisions; correspondence does not release evidence or
restart deadlines.

## Staff decisions and recovery

Migrations 932–934 add the platform queue, persistent exclusive claims, private
mandatory party notices and per-target effect progress. `/v1/safety-cases` filters
urgency, category, original content language and due time; case reports and queue
pages have continuations. Urgent evidence, claims, decisions, replay, cancellation and holds
require the specialist grant.
`/v1/safety-notices` is an owned private inbox; notice secrets never enter the
outbox or generic notification payloads. Party credentials keep appeals open
when participation is restricted. Generic Main write admission checks platform
participation fences across every Agent represented by the principal and uses
the database clock for expiry. Media erasure requires G-564's live Access
preservation fence; an active hold postpones erasure before owner writes.

Reasons retain facts, scope, duration, automation involvement, original language,
appeal route and the rule's exact revision/digest. Automation in retained evidence
must be disclosed. Cancellation preserves every confirmed effect and prevents
future dispatch; reconsideration appends a new decision. A reversal after partial
cancellation targets only the original confirmed effects. DMCA restoration must
fall inside the recorded counter-notice window and is stayed by claimant action.

The operation shape adapts the separation of acceptance and progress in
[AIP-151](https://google.aip.dev/151) and request identity in
[AIP-155](https://google.aip.dev/155), reviewed 2026-10-01. It uses the case API
and client-driven continuation because this milestone excludes a job runner and
generic operations service. The local state-machine and real owner tests, rather
than those source patterns, establish receipt and cancellation behavior here.

G-571's identical-copy marker is immutable in Content migration 601 and delivery
always rejects a marked digest. A successful NCII appeal therefore still needs a
Content-owner migration and a reversal primitive to lift that marker and restore
eligible copies. G-565 leaves such an effect unconfirmed instead of asserting
restoration. Account suspension remains an Accounts administration action with
the case ID in its reason note.
