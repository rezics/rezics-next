# Rights notice completion at the API boundary

Read-only specification, 2026-10-11, against `902d8eac6afac082532e8b0f789b2ea36bedd9f9`.
Line numbers below refer to this worktree snapshot; dispatch must relocate them
after intervening merges. No product code, test, generated artifact or policy
was changed. No QA was run: the brief permits inspection and read-only
reproduction only. References to tests describe their assertions, not a fresh
passing run.

The notice system already exists. Two concrete API gaps are established:
platform staff cannot read the complete original notice, and public intake
cannot select an ordinary Content revision or an exact cover use on a Work.
The other A slices below close missing end-to-end evidence, with production
fixes limited to failures they demonstrate. They do not rebuild the queue,
counter-notice worker, notification system, restriction registry or recovery
owner.

## Finish line and owners

The first public scope must work end to end, with proving checks; external
conditions are not Goal work ([Program](../../program/GOAL.md), lines 134–142).
Trust-ops explicitly owns reporting through appeal and rights outcomes visible
to parties ([Trust-ops](../../trust-ops/GOAL.md), lines 137–140), including rights
module ownership at line 15. Kernel's [state](../state.md), lines 65 and 76,
requires Trust-ops review of rights diffs and reserves erasure, `content.ts`,
barriers and the hidden-equals-absent inventory to them. Implementation dispatch
must respect those claims rather than treating this report as permission to
edit them concurrently.

Existing acceptance IDs, not new task-numbered cases:

| ID | Required outcome | Declaration |
| --- | --- | --- |
| GOV01 | Exact component/revision evidence, including empty/unavailable outcomes | `scripts/qa/cases/governance-and-delivery.ts:5` |
| GOV02 | Target/rule movement cannot retarget a decision | Same file, line 10 |
| GOV03 | Replays/reversals have one effect and preserve other contexts | Same file, line 16 |
| GOV24 | Exact notice scope; affected copies/uses restricted without deleting unrelated facts | Same file, line 140 |
| GOV25 | Process/deadlines retained; refresh, appeal or backup replay cannot restore automatically | Same file, line 146 |
| GOV07 | Erasure wins over history pins and restored backups; no resurrection | Same file, line 36 |
| LIVE18 | Restricted expression stays restricted through refresh/reapply; facts and identity survive | `scripts/qa/cases/source-conformance.ts:125` |

“Turns green” in a slice means supplying the missing scenario for those IDs.
It does not certify every other test contributing to an ID. Program owns the
complete acceptance verdict.

The public obligation read called T1 in the brief is already implemented in
`services/main/src/modules/rights/store.ts` and described at
`services/main/src/modules/rights/README.md:31` and `:65`. It is not the
Trust-ops admission first-wave task also called T1. No obligation-read slice is
needed. Kernel state lists rights T2/T3a/T3b/T4/T5, but does not map those labels
to current task claims; the manager must reconcile them before dispatch.

The rights module's graph receipt family is for offerings, not complaint
enforcement: `services/main/src/modules/rights/receipt-family.ts:2` registers
create/end/recognize/invalidate, `services/main/src/modules/rights/offering.ts:68`
reads the terminal receipt and line 95 binds it to admission. Its relay handler
requires a matching successful owner receipt
(`services/main/src/modules/rights/outbox-event.ts:11`). Complaints instead reuse
Governance decision/target receipts and Access enforcement. Adding complaint
actions to an offering receipt family would conflate distinct existing owners.

## What exists, and what the evidence establishes

Paths in this table are repository-relative. `src/` abbreviations are avoided
so each reference can be located without another report.

| Stage | Existing API and owner evidence | Gap or qualification limit |
| --- | --- | --- |
| Submit | Account-free `POST /v1/public-reports`: `services/main/src/routes/public-reports.ts:14`, `:55`. Copyright statement, original language and signed declaration: `services/main/src/modules/public-report/contract.ts:31`, `:41`. Intake writes Governance report/evidence and `rights_complaint`: `services/main/src/modules/public-report/store.ts:110`, `:122`, `:138`. Authenticated `/v1/rights/complaints` enters the same owner and supports ordinary disputes: `services/main/src/routes/rights.ts:206`, `:223`. | Public owner resolution selects a Work title/resource record or MediaAsset Content body, rather than a caller-selected cover use or ordinary Content document revision: `services/main/src/modules/public-report/owners.ts:119`, `:125`. `reportAddress` accepts Work/resource/media/post/reply URLs, not Content-revision URLs, at line 27. This is a public transport/resolution gap; the lower-level exact evidence schema already exists in `services/main/src/routes/reports.ts:47`. |
| Triage and review | Existing paged `/v1/safety-cases`, claim and detail: `services/main/src/routes/safety-cases.ts:112`, `:165`, `:185`; rights authority in `services/main/src/modules/safety-queue/store.ts:89`. Due queue at line 316. | Original statement/contact/language/process/declarations live in `governance_report`, but intake step has a null statement (`public-report/store.ts:132`). Staff case report pages select only ID/digest/reason (`services/main/src/modules/governance/store.ts:874`). `/v1/reports/{report}` returns evidence anchors, not the original notice (`:416`, `:458`). Realm decision-basis exposes statements but requires Realm authority (`services/main/src/modules/management-reads/decision-basis.ts:50`, `:70`); it does not solve platform review. |
| Decide | `/v1/rights/restrictions` supports interim/final restriction, dismissal, restore and reverse, using `GovernanceStore.decide`: `services/main/src/routes/rights.ts:229`. Current authority/rule/claim/generation/evidence and target checks: `services/main/src/modules/governance/store.ts:530`, `:584`, `:635`. | No missing decision engine established. Public target selections must carry the same exact basis to this owner; no new merits evaluator. |
| Restrict | Effect owners and owner receipts already exist: `services/main/src/modules/governance/effects.ts:29`, `:164` (Access), `:167` (Media), `:201` (Content), `:215` (graph CAS). Confirmation requires owner receipts: `services/main/src/modules/governance/store.ts:1159`, `:1175`. Shared disclosure consumes fences: `services/main/src/modules/disclosure/read.ts:53`, `:162`. | No public identity leak established. Internal `tombstone` at disclosure line 210 is filtered: `services/main/src/modules/media/summary.ts:759`, `:773`; `services/main/src/modules/work/read-header.ts:79`; `services/main/src/modules/work/public-patterns.ts:13`. Exact Content denied results become ordinary 404 at `services/main/src/routes/content.ts:464`. Need a composed public Work/cover/Content proof, not a blanket change from tombstone to hidden. |
| Notify | Decision acceptance schedules notices and party credentials: `services/main/src/modules/governance/store.ts:779`. Recipient discovery: `services/main/src/modules/governance/notices.ts:53`. Owned `/v1/safety-notices` returns reasons/credential: `services/main/src/modules/safety-queue/store.ts:388`; route schema `services/main/src/routes/safety-cases.ts:43`. Mandatory mail has durable progress: `services/main/src/modules/governance/notices-mail.ts:58`, `:79`. | No second notification producer is needed. Account intake acknowledgement and SMTP delivery are separate facts. Full-cycle proof must obtain affected credentials from this API, not mint them directly in SQL. External sender/mailbox conditions remain outside the Goal. |
| Counter-notice | Private credential correspondence and authenticated process steps converge on `recordCounterNotice`: `services/main/src/modules/public-report/store.ts:247`, `services/main/src/modules/governance/store.ts:1378`, `services/main/src/modules/rights/counter-notice.ts:21`. Statement, valid content language and declarations are already mandatory at counter-notice line 37. | The replay fixture already supplies statement and language (`tests/qa/fault-recovery/rights-restriction-replay.test.ts:205`). Do not propose making them mandatory again or weaken the fixture. Missing/blank statement, missing/invalid BCP 47 language and missing declarations must remain denied. |
| Reinstate or uphold | Durable claimant sending and confirmed delivery gate: `services/main/src/modules/rights/counter-notice-worker.ts:97`, `:143`. Original receipt starts the window. Filing/parallel restriction guards: `services/main/src/modules/rights/counter-notice.ts:145`, `:180`. Restoration reuses ordinary decisions/effects: `services/main/src/modules/governance/store.ts:1411`. Composition starts worker at `services/main/src/composition.ts:643`, `services/main/src/index.ts:74`. | Existing real-media integration covers restoration and continued restriction. Original moderator authority is rechecked at restoration (`governance/store.ts:1413`, `:1446`); revoked/erased responder defers (`counter-notice-worker.ts:79`, `:88`). Prove current staff takeover before calling that a completion defect. Do not add a privileged service actor. |
| Appeal | Existing private correspondence accepts appeal with statement/language: `services/main/src/modules/public-report/contract.ts:54`, `services/main/src/modules/public-report/store.ts:275`. Decisions answer process steps through `answersStepId` (`services/main/src/routes/reports.ts:82`). | No new appeal registry. Need to prove the affected person's path after participation restriction and the attributable uphold/reversal result for the public targets. |
| Transparency record | Immutable attributed decision, rule/evidence digests, reasons and disclosure: `services/main/src/modules/governance/schema.ts:138`, `services/main/src/modules/governance/store.ts:748`. Confirmed `moderation.decided` event at line 1239; empty dismissal at line 799. Staff and private parties can read results. | This supplies an audit/transparency record. No general public rights transparency endpoint was found; `services/main/src/modules/realm-reads/public-decision-index.ts:62` covers other decision families. Public redacted publication is an owner question, not evidence that another registry is missing. |

Private case status already returns statements, outcomes, reasons, process
history and appropriately redacted declarations
(`services/main/src/modules/public-report/store.ts:179`). It does not return
the captured Work, image or document. Shared restriction evaluation does not
exempt a viewer merely because that viewer is a case party
(`services/main/src/modules/disclosure/read.ts:162`). Therefore **private case
visibility exists; party access to restricted material itself was not
established**. That distinction must be resolved by Trust-ops, not by silently
granting every case-credential holder access to the resource.

The existing tests are substantial:

- `tests/qa/integration/g-564-public-report.test.ts:140` proves incomplete
  copyright notice rejection and signed intake; line 159 rejects counter-notice
  before restriction; line 161 records an appeal.
- `tests/qa/integration/g-565-safety-decisions.test.ts:46` covers queue, claims,
  reasons, resumable effects, appeals and legal windows.
- `tests/qa/integration/g-906-safety-reads.test.ts:62` covers staff reading,
  redacted urgent evidence, paging, DMCA windows and reasons.
- `tests/qa/integration/rights-counter-notice.test.ts:84` uses actual owner
  databases and `publicReportOwners` (line 100), real uploaded images (line
  172), API-obtained affected credentials (line 237), suppression and deadline
  restoration (lines 346 and 358), filings and parallel restrictions (lines
  381 and 417). Line 807 tests lost owner acknowledgement. It uses controlled
  time and a test mail provider; external delivery and physical restore are
  not established by it.
- `tests/qa/integration/rights-complaint.test.ts:26` proves a source synopsis
  fence survives refresh/human confirmation while facts and identity survive;
  line 158 starts the broader source-use case.
- `tests/qa/fault-recovery/rights-restriction-replay.test.ts:155` supplies fixture
  effects and line 170 fixture evidence/head owners. The target is source
  synopsis/export (lines 175 and 184). It proves Access fencing, notice/job
  identity, signed counter/deadlines and backup rows (lines 191, 198, 217,
  245 and 278). **It does not prove restored public Work/cover/Content reads,
  production owner effects, claimant delivery after restore or erasure.**
- `tests/qa/fault-recovery/notification-erasure.test.ts:17` concerns generic
  notifications, with a manual Content tombstone at line 77. It is not an
  admitted rights-erasure proof.

## Ordered slices for Luna at max

Each slice is one session. Estimates include focused checks but are planning
estimates, not measured runtimes: eight A sessions total about 8 hours 30
minutes, leaving about 1 hour 30 minutes within the requested ten-hour window
for review and retries.
The clock assumes owner decisions and dependencies are available before
dispatch. Waiting for unlanded Trust-ops work cannot be promised to fit the
window. Do not dispatch a blocked slice and ask Luna to design around the
missing owner. The B slice is outside that A implementation budget.

All production slices extend or consume existing owners. All test slices use
production composition at the boundary being asserted; direct SQL is allowed
for fault injection/observation, not to manufacture the notice, restriction,
party credential or erasure that the scenario claims the API performs.

### 1. Complete the existing platform notice read — A, about 60 minutes

**Change and files.** Extend the authorized report-detail projection in
`services/main/src/modules/governance/store.ts:416` and `:435`, with the response
schema in `services/main/src/routes/reports.ts:61` and its GET route. Keep case
queue summaries bounded; staff follows a report ID for detail. Return retained
statement, original language, process, received time, declarations and relevant
rights-complaint metadata. Reuse fields written in
`services/main/src/modules/public-report/store.ts:122` and the existing
`rights_complaint` row. Expose contacts only under Trust-ops' approved staff
projection; distinguish public intake from authenticated intake where fields
are legitimately absent. Do not copy statements into a second store or leak
the staff projection through submit/replay responses merely because they share
`reportResult` today. Use the Realm decision-basis projection at
`services/main/src/modules/management-reads/decision-basis.ts:70` as a local
example, without borrowing Realm authorization for platform cases.

**Proof.** New `tests/qa/integration/rights-notice-review.test.ts`: contact-only
and authenticated submission; staff reads the exact original notice; reporter
and unrelated principal receive only their approved projection; revoked grant,
wrong scope and urgent/non-specialist reads deny; null optional fields survive.
Retain existing `tests/qa/integration/governance-report.test.ts` and
`tests/qa/integration/g-906-safety-reads.test.ts` as affected evidence; run only
claimed tests. Acceptance: GOV01, GOV24 review subcases.

**Mechanisms:** `governance-report: extend — existing authorized detail read;
rights-complaint: consume — retained notice metadata.`

**Migration/build:** no Content or Access migration; no native image build.
Changed route schema needs `task gen` and `task web:typecheck`; generated files
are restored before handoff. **Wait/review:** Trust-ops approves the exact
notice/contact projection and `readReport` authority diff before landing.
No known current task claims this detail read; check owner at dispatch.
Reason A: moderators cannot review the submitted allegation end to end today.

### 2. Bind public notices to exact Content material — A, about 60 minutes

**Change and files.** Extend the existing public target contract/resolution,
`services/main/src/modules/public-report/contract.ts:41` and
`services/main/src/modules/public-report/owners.ts:19`, `:104`, `:119`.
Reuse the owning Content/Media readers and evidence capture at
`services/main/src/modules/governance/evidence.ts:127`, `:143`; server-resolve
resource ownership and the actual reported revision. Allow a published
Content-revision URL or bounded exact selection through this same intake.
Selectors reuse existing
component/revision/locator meanings (`services/main/src/routes/reports.ts:47`),
not a new target registry. Trust-ops reviews the exact wire selection shape.
Never interpret an arbitrary client owner/revision pair
as an admitted binding. Preserve the ordinary Work-title intake path.

Report evidence must identify the selected material, not the Work title by
substitution. When claiming a document, resolve its
actual Content revision and variant/resource relationship rather than generic
graph record capture. Reject cross-resource revisions, unpublished private
bytes for an anonymous reporter, malformed selectors and unsupported material
with the existing unavailable/invalid outcomes. A repeated receipt retains its
original anchors after a head moves. Do not change restriction breadth or
copyright conclusions in this resolver.

**Proof.** New `tests/qa/integration/rights-notice-targets.test.ts`: preserve
ordinary Work intake and report one published ordinary Content revision.
Submission retains the current ID/credential-only receipt
(`services/main/src/modules/public-report/contract.ts:64`); an authorized
report-detail read or retained-row observation proves exact evidence anchors.
Foreign revision denied; movement/retry does
not retarget; unsupported/unavailable material; private target requires its
existing reader authority. Existing examples:
`tests/qa/integration/g-543-public-report.test.ts`,
`tests/qa/integration/g-564-public-report.test.ts`,
`tests/qa/integration/rights-complaint.test.ts`. Acceptance: GOV01, GOV02,
GOV24. LIVE18 remains the source-reapply guard, not a new intake policy.

**Mechanisms:** `public-report-target: extend — existing owner resolver;
governance-evidence: consume — exact admitted owner capture;
content-revision: consume — existing identity.`

**Migration/build:** no planned Content or Access migration; no native image
build. If reading reveals missing durable attribution, stop and send that
specific owner limitation to Trust-ops rather than add a mapping table.
Route changes require generation/web typecheck. **Wait/review:** Trust-ops
approval of Content resolver admission, unavailable behavior and exact target
mapping; slice 1 supplies the authorized detail proof. Content selection does
not wait for G-1800. Reason A: ordinary Content material cannot currently be
selected through the public notice route.

### 3. Bind a Work cover notice to its exact Media use — A, about 60 minutes

**Change and files.** Extend slice 2's same contract/resolver in
`services/main/src/modules/public-report/contract.ts:41` and
`services/main/src/modules/public-report/owners.ts:125`, consuming the existing
Media use identity rather than guessing from a Work's title or an asset URL.
`services/main/src/modules/governance/effects.ts:95` already resolves a
`media_use` target using Work target, asset revision and use locator. G-1800 and
Trust-ops supply the cover-selection wire contract and affected-use scope.
Verify the named use belongs to the named Work, is a cover, and references the
exact admitted asset revision; retain those anchors through head movement.
Authenticated Media-use capture already reads that exact relationship in
`services/main/src/modules/governance/evidence.ts:230`, but its internal
`admitted` path at line 107 handles only graph/Content and falls through to
unsupported at line 136. Factor the existing bounded Media capture into a
shared owner helper, then consume it from admitted public intake after the
resolver proves read authority for the exact Work/use/asset. Do not call the
authenticated path with a fabricated principal or duplicate its identity query
and disclosure policy. Wire the existing Media owner into the public capture
construction at `services/main/src/modules/public-report/owners.ts:108`.
Do not implement imported-cover provenance, the rights mark or copy enumeration
here. Unsupported/foreign/private selections keep existing invalid/unavailable
semantics; a notice does not itself find infringement or restrict another use.

**Proof.** Extend `tests/qa/integration/rights-notice-targets.test.ts`: public
notice for one served Work cover, staff read verifies its exact use/revision,
another Work's incompatible use is refused, an unrelated asset's cover use
remains unaffected,
retry after replacement retains the original evidence. The public receipt
continues to return IDs/credential only. Existing owner examples are
`tests/qa/integration/rights-counter-notice.test.ts:172` and
`tests/qa/integration/rights-complaint.test.ts:158`. Acceptance: GOV01, GOV02,
GOV24. **Mechanisms:** `public-report-target/governance-evidence: extend — existing
resolver and shared exact capture; media-use: consume — admitted exact use`.
**Migration/build:** none planned; no native image build; route generation and
web typecheck apply. **Wait/review:** slice 2, G-1800's served cover/use contract,
Launch Media API and Trust-ops approval of exact cover admission and scope.
Trust-ops reviews the resolver/evidence diff, G-1800 owns any missing durable
cover attribution. Reason A: a rights holder must be able to identify the
actual first-scope cover use without alleging against the Work title.

### 4. Prove the composed public rights cycle and party visibility — A, about 90 minutes

**Change and files.** Add `tests/qa/integration/rights-public-restriction.test.ts`.
Use slices 1–3 and the real owner fixture pattern in
`tests/qa/integration/rights-counter-notice.test.ts:92`. Through HTTP submit,
read queue/detail, claim, decide, poll effect completion, read notice credential,
counter/appeal, then reinstate or uphold. Include Work, exact cover use and
ordinary Content cases; share setup rather than three stacks. Retain unsigned
notice/counter rejection, required statement/language, stale generation/rule,
concurrent/repeated decision and lost effect acknowledgement checks.

Compare restricted and absent results for the direct public resource read,
summary, relevant discovery/search result, exact body/image delivery and export
path. Verify unrelated facts/other covers remain and old heads/derivatives do
not reopen material. Use the existing channel matrix in
`services/main/src/modules/disclosure/read.ts:12`, `:53`; do not assert every
channel needs a new handler. Code repairs, if the proof exposes a failure,
belong in the failing existing adapter plus this guard. Starting points:
`services/main/src/modules/media/summary.ts:759`,
`services/main/src/modules/disclosure/assembly.ts:11`, `:36`,
`services/main/src/routes/content.ts:405`,
`services/main/src/modules/work/read-header.ts:79`.

Prove reporter/affected/moderator private case status, unrelated-party denial,
and correspondence after participation restriction. Ask Trust-ops before
dispatch whether “visible to the right parties” means case outcome/evidence
metadata or access to the actual restricted material. If it requires material
inspection, first exercise an existing authorized exact read. A demonstrated
missing read needs a separately bounded Trust-ops slice extending the existing
case/evidence owner; this test session must not design a universal credential
bypass. Never let case credentials grant ordinary public resource access.

**Proof/acceptance.** This new integration file proves missing composed GOV01,
GOV02, GOV03, GOV24 and GOV25 subcases. Existing relevant evidence:
`tests/qa/integration/rights-counter-notice.test.ts`,
`tests/qa/integration/g-898-wiki-disclosure.test.ts`,
`tests/qa/integration/g-929-wiki-disclosure.test.ts`,
`tests/qa/integration/rights-complaint.test.ts` (LIVE18). Inventory affected
tests without running a whole tier.

**Mechanisms:** `none` for qualification; any demonstrated repair:
`governance-enforcement/shared-disclosure: consume — existing owner fences`.
**Migration/build:** none planned; no native image build. **Wait/review:**
slices 1–3, G-1800's served cover path, and Trust-ops' party-visibility decision.
Trust-ops reviews viewer/authority/fence and response-shape diffs; their
hidden-equals-absent inventory owns class-wide repairs. Reason A: the public
journey and adverse-state composition are not established by current fixtures.

### 5. Qualify completion after the original responder loses authority — A, about 45 minutes

**Change and files.** Extend
`tests/qa/integration/rights-counter-notice.test.ts:807` or add the narrow
`tests/qa/integration/rights-restoration-authority.test.ts` if separate fixture
ownership makes that cheaper. After signed counter and confirmed claimant
sending, revoke/expire the original decider before the due time. Assert worker
deferral rather than unauthorized restoration, then let a currently authorized
responder claim the due case and use the existing restoration/answer command.
Prove one attributable result, immutable receipt deadlines, no contact leak and
continued restriction with a filing or parallel fence.

Relevant production sites are
`services/main/src/modules/governance/store.ts:1413`, `:1446`, `:1477`,
`services/main/src/modules/rights/counter-notice-worker.ts:79`, `:88`, and
`services/main/src/routes/safety-cases.ts:185`. Do not replace original authority
with an automatic service grant. If manual takeover cannot finish through the
current owner, hand off the first denied transition; Trust-ops decides the
attributable takeover semantics before another implementation slice.

**Acceptance:** GOV25, GOV02/GOV03 recovery subcases. **Mechanisms:** `none`
for qualification; any approved repair must be
`governance-decision: extend — current authorized case continuation`.
**Migration/build:** none planned; no native image build. **Wait/review:**
Trust-ops confirms staff takeover is the intended completion path; slices 1
and 4 expose/qualify the due case and result. Trust-ops reviews authority,
claim, retry identity and restoration guard diffs. Reason A: a ten-day process
must remain completable when the original responder is unavailable; current
automatic deferral alone does not demonstrate that outcome.

### 6. Prove admitted erasure wins over rights restoration — A, about 60 minutes

**Change and files.** New
`tests/qa/integration/rights-erasure-transition.test.ts`. Seed restriction and
signed correspondence through the API, erase the exact reported material
through the existing admitted erasure route, then exercise counter deadline,
appeal answer and repeated restore. Assert erased/unavailable bytes in the
declared Content/Media owner closure and public absence, no regenerated
derivative, and retained attributable case outcome under the approved retention
rule. This does not qualify title/relay or editorial-snapshot copy erasure;
Trust-ops' separate S1/S2 specifications own those closures. Preservation hold
postponement must remain
generic publicly and must prevent physical deletion before release.

Use existing erasure route/report/owner composition, not SQL-created journal
entries or manual revision tombstones. Starting references:
`services/main/src/modules/governance/store.ts:1111` (release checks),
`services/main/src/routes/content.ts:62` (erased delivery),
`services/main/src/modules/disclosure/assembly.ts:17` (erased exact read), and
existing `tests/qa/integration/erasure-api.test.ts`,
`tests/qa/integration/erasure-readers.test.ts`,
`tests/qa/integration/erasure-custody.test.ts`. Any failure in live payload,
Media, custody or journal semantics goes back to their Trust-ops owner; this
slice supplies the rights transition guard, not an alternate erasure service.

**Acceptance:** GOV07, GOV24, GOV25. **Mechanisms:** `none` for qualification;
`erasure-owner/governance-decision: consume` if a reviewed integration repair
is needed. **Migration/build:** none in this test slice; inherited migrations
come from Trust-ops and are numbered at their dispatch. No native image build.
**Wait/review:** G-1791 public erasure integration, G-1792 custody reads,
G-1795 Media qualification, and Trust-ops'
decision on rights evidence/contact retention. G-1783 custody terminal erasure
must land first where this scenario uses it. Trust-ops reviews erasure
admission, hold, unavailable and retention diffs. Reason A: restoration cannot
resurrect erased first-scope material; existing rights tests do not prove it.

For Media coverage use the owner's complete-asset revision selection rule in
`docs/goals/trust-ops/tasks/G-1789.md:16`; a partial exact-family erase is still
unsupported there. A Work attachment never supplies an asset erasure grant.
Live qualification does not wait for G-1793's restored-owner closure; that
dependency belongs to slice 8.

### 7. Restore a pending public rights process with real owners — A, about 90 minutes

**Change and files.** New
`tests/qa/fault-recovery/rights-public-recovery.test.ts`, reusing the owner-cut
and physical restore support specified and being implemented by Trust-ops.
The existing
`tests/qa/fault-recovery/rights-restriction-replay.test.ts:108` stays as the
narrow Access replay regression; do not relabel it a whole-product proof.
Seed one representative public Content process through the
public/moderator/party APIs with production effects; capture a consistent
recovery set and restore into isolated owner copies. Assert public Content
absence before restoration is authorized, plus small Work/cover absence probes
only where inherited fixture support already supplies those material families.
An unreleased recovery hold must never serve them. Resume pending claimant
delivery by its original identity and prove receipt-based dates did not restart.
After confirmed sending and the due floor, current authorized decision/effects
restore only the appropriate target. Keep filing, parallel-fence and lost-owner
acknowledgement variants in the existing integration tests; add a recovery
variant only if restore changes its relevant retained state. Do not build three
complete physical-recovery journeys in this session.

Use `restoreRecoverySet`/`OwnerOperations.reconcileRestore` and the independently
retained current authority/relay inputs. Do not build another restore adapter,
release callback or fixture scheduler. The shared support claim is
`tests/qa/fault-recovery/independent-restore-support.ts` in G-1776; request reuse
from Trust-ops rather than copy an unfinished harness into this test. Missing
owner support is a dependency/blocker, not grounds for a fabricated graph
head, authority witness or successful effect.

**Proof/acceptance:** new fault file plus the existing replay file as affected
evidence; GOV25, GOV03. **Mechanisms:** `none` — consume existing restoration,
custody, governance effects and delivery reconciliation in the fixture.
**Migration/build:** none planned; no new native image build (use the already
built owner image, whose availability was not measured here). **Wait/review:**
slice 4, Trust-ops G-1771 owner qualification,
G-1776/G-1777 physical restore support/closure, and current authority inputs.
Trust-ops reviews recovery hold/release, retained authority and all claimed
receipt/public-read comparisons. Reason A: backup row equality alone cannot
establish that the restored public rights function works.

### 8. Extend that restore proof to a later erasure — A, about 45 minutes

**Change and files.** Extend the same
`tests/qa/fault-recovery/rights-public-recovery.test.ts` after slices 6–7.
Capture the base before one Content erasure; perform that later admitted
erasure against the live owner; independently retain its current journal/custody;
restore the old
base without updating it to include the deletion. Replay current retained
erasure before release. Then deadline/appeal/decision replay cannot recover
the erased Content body or its declared private payload copies. Inherit
G-1797's Media/original/derivative physical deletion proof; do not duplicate its
full Media closure in this session. Wider title/relay/editorial-copy closure
remains Trust-ops S1/S2 work.
Preserve the
original case/decision/step/delivery identities and their allowed retained
metadata; absent erased bytes cannot become an ordinary retirement or success
with a recreated payload.

**Proof/acceptance:** GOV07, GOV25; use
`tests/qa/fault-recovery/erasure-live-private-restore.test.ts` from G-1797 as
the inherited physical deletion/recovery guard, not another deletion engine.
**Mechanisms:** `none` — existing retained journal and terminal custody proof.
**Migration/build:** none in this slice; no native image build. **Wait/review:**
slices 6–7, G-1793 and G-1797, and Trust-ops' retained-evidence rule. Trust-ops
reviews chronology, current journal frontier, physical absence and release
evidence. Reason A: a later erasure missing from an old backup is the critical
no-resurrection case, not merely erasure in the captured prefix.

### Optional public redacted decision read — B; no dispatch before owner decision

There is an attributed immutable transparency record already. If Program and
Trust-ops require a general public redacted rights-decision read in the first
scope, promote this to A and specify one read session after their disclosure
decision. Otherwise it improves public accountability but does not repair the
already available party outcome/appeal path.

Candidate change: a bounded exact/paged projection of existing
`moderation_decision`/confirmed target outcomes, in
`services/main/src/modules/governance/store.ts:748`, `:1239` and the existing
report/safety read route family. Reuse persisted reasons, rule revision and
effect status; no second transparency registry or outbox consumer. New
`tests/qa/integration/rights-decision-disclosure.test.ts` would prove private
decisions, contacts, correspondence and urgent evidence never leak, unconfirmed
effects are not presented as completed, revocation/erasure is respected, and
paging is bounded. Relevant existing tests are
`tests/qa/integration/g-906-safety-reads.test.ts` and
`tests/qa/integration/governance-report.test.ts`. Existing acceptance GOV24–25
covers attribution; the owner must declare a public-publication acceptance
before claiming that new requirement green.

**Mechanisms:** `governance-decision: extend — redacted read of existing record`.
No planned Content/Access migration or native build; API generation/web
typecheck applies. Trust-ops must review every field and read authority;
Program/Launch decide public exposure and consumer contract. No legal-policy
text or DSA submission mechanism is included.

## Cross-Goal overlap and dispatch boundaries

Observed with `bun scripts/goal/goalctl.ts status` on 2026-10-11 during this
review. Status is a point-in-time coordination fact, not proof a commit landed.
The search through `docs/goals/trust-ops/tasks` found no literal `rights` or
`restriction` task text; that does not remove Trust-ops ownership.

| Task/status observed | Overlap and action |
| --- | --- |
| G-1783 running | Access migration and `modules/outbox/receipt-custody.ts`: exact journal-bound terminal erasure, `docs/goals/trust-ops/tasks/G-1783.md:7`, `:20`. Wait before rights erasure proof; no competing custody migration. |
| G-1781 exited | Exact immutable-object deletion foundation, `docs/goals/trust-ops/tasks/G-1781.md:7`, `:20`. Exited does not mean merged; verify landing. |
| G-1675 running | Restore fixture retained-resource disposal, `docs/goals/trust-ops/tasks/G-1675.md:7`, `:19`. Reuse cleanup; no parallel stack lifecycle implementation. |
| G-1718 conflict / queued merge | Search generation replay proof, `docs/goals/trust-ops/tasks/G-1718.md:17`, `:29`. Rights tests must use supported generation/checkpoint recovery, not replay arbitrary receipts from zero. |
| G-1763/G-1764 exited specifications | Independent restore and live-private-copy erasure plans; their child tasks still own implementation. |
| G-1776/G-1777 defined dependency chain | Independent physical restore support and closure, `docs/goals/trust-ops/tasks/G-1776.md:7`, `:10`, `:20`. These were not listed as running in observed status; do not infer delivery. |
| G-1787–G-1797 defined erasure slices | Graph inventory (1787), Media persistence/index (1788/1789), fenced completion (1790), route integration (1791), custody reads (1792), restored closure (1793), API proof (1794), Media proof (1795), later-erasure physical restore (1797). Their task files, lines 7 and 20, identify claims. Coordinate the proof seams; do not duplicate payload purge or broaden complete-asset erasure. |
| G-1800 running, Kernel | Cover import/rights mark/takedown specification, `docs/goals/kernel/tasks/G-1800.md:15`. Share exact cover-use target and delivered-read contract; this report owns public notice workflow, not importer/mark storage or derivative enumeration. |

Before each dispatch the manager checks current `goalctl owner` for every
named production/support file and refreshed status. The only file claimed by
this worker is this report; none of these implementation paths is claimed or
changed here.

## Questions and evidence still needed

1. **Trust-ops:** Does party visibility require actual restricted material
   inspection, or the implemented private case/outcome/evidence metadata?
   Settle with an approved authority matrix and a Work/cover/Content API
   scenario for affected party, claimant, moderator and unrelated caller.
   A credential for filing correspondence is not by itself a byte-read grant.
2. **Trust-ops:** Confirm current responder takeover when automatic restoration
   loses the original actor's authority. The settling evidence is slice 5's
   admitted manual restoration and durable job disposition. If it fails,
   specify that owner transition; do not privilege the background worker.
3. **Trust-ops:** Which notice/contact/declaration/evidence metadata survives
   account/material erasure and holds? The contract leaves physical erasure
   versus case evidence open at `docs/contracts/content-governance.md:23`.
   Needed evidence is an owner decision plus admitted live and later-backup
   tests. This report invents no retention duration or raw-payload exemption.
4. **Trust-ops + Program:** Public copyright intake currently requires signed
   DMCA declarations; ordinary disputes use the authenticated rights complaint
   transport. Does “a user can submit a notice” require account-free ordinary
   rights disputes without those declarations? Human review selects the
   applicable process (`docs/contracts/content-governance.md:14`), but that
   does not authorize a new category or declaration bypass. Confirm the
   intended first-scope matrix before broadening intake.
5. **Program + Trust-ops + Launch:** Is public redacted decision publication
   part of first-scope transparency, or is the existing attributed record and
   party read sufficient? Decide the B slice's exposure, safe fields and
   acceptance before dispatch. Also identify Launch's consumers of exact
   cover/Content notice selection and private case results; GUI work belongs
   to Launch, not this API report.
6. **Trust-ops + Launch/G-1800:** Approve exact cover-use selection and
   affected-copy scope. Existing MediaAsset reporting alone does not prove
   one Work's imported cover notice is precisely scoped. A real served-cover
   test with another unaffected use settles it.

No legal eligibility, registration or policy wording is decided here. The
contracts require human process selection and distinguish allegation from
finding (`docs/contracts/content-governance.md:12`). NCII remains its own
48-elapsed-hour process and must not acquire copyright restoration gates
(`docs/legal/ncii-takedown-policy.md:59`, `:79`). Existing receipt-based
copyright delivery/window rules are in `docs/operations/trust-and-safety.md:148`
and `:153`; broad intake/provenance and independent material/use conclusions
remain those in `docs/research/source-data-rights.md:76`, `:99`. No new legal
claim or external-law research is needed to establish these repository gaps.

**C / excluded, not slices:** DMCA agent registration (C-15) and legal facts or
policy statements (C-16), `docs/operations/external-conditions.md:29`. External
sender/mailboxes and source evidence likewise remain their existing external
conditions; Goals do not implement workarounds or wait for those facts to call
the repository function complete.

## Focused validation at implementation dispatch

This analysis ran file inspection, `task --list`, `git status`, source/test
searches and read-only goalctl status. It ran no tests, dev server or build.
New proving tests need acceptance-bearing titles and explicit entries in the
existing coverage declarations; a test-file name alone cannot turn an ID green.
Current rights coverage is `scripts/qa/coverage/gov-rights.ts:16`; related
declarations are `scripts/qa/coverage/gov-report.ts:4`,
`scripts/qa/coverage/gov-proposal.ts:4`,
`scripts/qa/coverage/gov-governance.ts:4`, and
`scripts/qa/coverage/gov-notification.ts:12`. Program coordinates those minimal
coverage additions for slices 1–8 under the current file owner, preserving
existing evidence rather than replacing it with a narrower test. No new
acceptance registry is needed.

Subsequent implementation workers run their explicit claimed tests with
`bun scripts/goal/goalctl.ts test <paths>`; never a whole tier or `--heavy`.
Changed TypeScript needs the owning typecheck, focused type-aware lint and
ast-grep scan. Changed API schemas require generation and web typecheck; do
not commit generated outputs. Preview affected checks without executing
outside-claim suites; Program runs wider regression. Test data uses existing
isolated recovery copies, and startup/restore remains within the repository's
ten-minute preparation budget. If a one-session proof exposes a missing owner
mechanism or policy decision, commit its guard/evidence where appropriate and
hand off the exact blocker; never replace it with a second registry, forged
receipt, altered signed digest or weakened assertion.
