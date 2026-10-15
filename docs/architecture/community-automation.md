# Bounded community automation

Status: proposal for program review, 2026-10-16. This note proposes ownership
and semantics for competitor-coverage finding B07. It adds no contracts, scope
rows, operations, migrations or implementation. Program reviews the proposal
before any contract step; it does not change the first-public-scope cut.

The missing job is to route a flagged post to the right human without repeating
the same moderator command, and to lift one explicitly defined newcomer limit
when admissible participation evidence qualifies. Manual rule publication and
case handling supply neither automatic execution nor earned progression. The
report calls this an operator-retention gap; that priority remains a hypothesis,
not measured demand or a reason to introduce arbitrary executable rules.

## Evidence and existing owners

[Reddit's AutoModerator documentation](https://support.reddithelp.com/hc/en-us/articles/52866343172500-Full-automoderator-documentation)
describes checks, actions and recorded action reasons. Its current
[basic-rule guidance](https://support.reddithelp.com/hc/en-us/articles/52865423682452-Writing-basic-automoderator-rules)
also restricts enforcement-action availability for new or previously unused
communities. [Discourse's trust-level guide](https://blog.discourse.org/2018/06/understanding-discourse-trust-levels/)
(June 2018, updated December 2025) describes participation-based progression
and increasingly uses independent group permissions rather than elevating an
entire trust level. Reviewed 2026-10-16, these are vendor descriptions, not
evidence that REZICS has equivalent behavior or retention. Our deduction is to
automate a small authorized command, keeping its reason and independent rights.

| Owner and present evidence | Reuse | Addition and reason |
| --- | --- | --- |
| Governance [rule revisions](../../services/main/src/modules/governance/rules.ts), [rule lifecycle limits](../contracts/governance-rules.md) and [case/decision store](../../services/main/src/modules/governance/README.md) | Scoped immutable rule documents, expected heads, receipts, exact evidence, case generations, attributable decisions and reversal chains. | An admitted executable interpretation and separately authorized activation of a reviewed rule revision. Generic JSON publication currently establishes neither activation nor execution authority. Keep that meaning in Governance. |
| Realm [management commands](../../services/main/src/modules/access/realm-management.ts) and [bounded command definitions](../../services/main/src/modules/realm-admin/contract.ts) | Existing report/submission escalation to Realm owners, current jurisdiction, target generations and command receipts. | A restricted automation binding to those commands. Escalation currently appends an immutable record and has no withdrawal command; reversible effective routing needs an owner extension before this action can be admitted. Do not delete its audit record or build an automation-only queue. |
| Access [authority and lineage](../contracts/identity-and-access.md), [Realm participation gates](../../services/main/src/modules/access/realm-management-settings.ts) and [grant owner](../../services/main/src/modules/access/grants.ts) | Representation, exact scope, assignment ceilings, grant episodes, expiry, revocation and recovery fences. | A narrowly admitted progression grant profile and its assignment/revocation authority, if program accepts the configuration below. The installed Agent grant profile is not a general-purpose permission issuer. Automation never becomes a second trust or authority owner. |
| [Submission owner](../../services/main/src/modules/realm-submission/store.ts), [Realm permit](../../services/main/src/modules/access/realm-management-policy.ts) and [baseline admission](../../services/main/src/modules/access/baseline.ts) | Existing submission commands, mandatory review, bans, membership and current policy checks. | A named newcomer restriction and grant-bound exception need owner qualification. Today `trusted-members` uses membership, not an earned permission; ordinary baseline submission admission is not proof of a separate progression gate. Do not award membership or moderation roles to approximate it. |
| [Committed events/jobs](../contracts/events-and-jobs.md), [Main relay](../../services/main/src/modules/outbox/relay.ts) and [Scheduled decision](scheduled-plans.md#program-review) | Committed owner facts, stable event identities, owner receipts, bounded continuations, leases, recovery generations and current authority checks. | One shared durable-work mechanism for Scheduled due actions and event-triggered actions: admission, claim, fence, retry, cancellation and receipt reconciliation. The job protocol still has qualification work; Scheduled's decision is not evidence that a general runner is installed. |
| [Notification owner](../../services/main/src/modules/notification/README.md) | Recipient eligibility, preferences, durable intake dedupe, disclosure, provider idempotency and uncertain-send lookup. | An admitted automation subject reader/producer only when a configuration needs notice. No custom mailer, second inbox or membership-wide synchronous fan-out. |
| [Semantic model](../contracts/semantic-model.md#definition-responsibilities), [Context](../contracts/context.md) and [finite rule profile](../../model/definitions/semantic-rule-v1.ttl) | Existing resource/revision and inference vocabulary where its meaning fits. | Context inference describes derived meaning, not permission to perform commands. Keep authorization and operational activation out of RDF classification and descriptive rule inference. |

## Proposal: one rule interpretation, existing action owners

Extend Governance with versioned event–condition–authorized-action rules. A
reviewed definition selects one admitted owner event type, one exact scope,
finite predicates and one action binding. Activation pins the approved digest,
definition revision, policy generation, delegated ceiling and finite validity.
Publishing prose, translating it, dry-running it and activating it are distinct
acts; publishing a document cannot start work. Editing meaning creates a new
revision requiring explicit activation. A retired or superseded activation
fences pending applications immediately, without walking its job history.

Reuse CloudEvents source plus ID for committed input identity, the existing
Governance rule/evidence revision basis, and owner Action/receipt meanings.
Use [schema:Action](https://schema.org/Action) for the intended action and
[PROV Activity and derivation](https://www.w3.org/TR/prov-o/#Activity) for its
performed process and evidence. Neither vocabulary supplies execution powers.
Executable binding and activation bookkeeping are semantic gaps to resolve in
later owning profiles; this note creates no new RDF terms, rule language or
universal trust-level vocabulary. Private grants, principals and case evidence
remain in Access custody, outside public RDF and public event payloads.

Predicates inspect only the selected committed fact and bounded exact owner
witnesses: event kind, Realm/target identity, current case state, an exact
independent review outcome, or the presence/absence of a named current grant.
Missing, erased, unsupported or unavailable evidence is a held/refused outcome,
never false evidence of safety or permission. Exclude arbitrary queries, scripts,
regular expressions, network calls, learned classifications and historical
counts assembled during evaluation. A future threshold needs a separately
qualified owner projection with explicit coverage, withdrawal and counting
meaning; the first cut uses one exact qualifying review, not a reputation score.

| Configuration | Proposed effect and boundary |
| --- | --- |
| Flagged post | A committed Realm report opens or updates its existing case; the rule matches that case and requests the existing escalation-to-owners command. It retains report/evidence revisions and an explanation. It does not decide guilt, hide/delete the post, ban its author or publish the report. Admit this binding only after the Realm owner can conditionally withdraw/supersede its effective routing while preserving history. |
| Newcomer progression | An exact contribution accepted by an independently authorized human can qualify its author for a finite exception to one optional Realm newcomer submission-frequency limit. Propose a maximum seven-day exception, with no renewal from event replay. Access/participation must define that restriction and its single-purpose grant profile first; no such cap/exemption is claimed to exist today. Membership, bans, submission eligibility, mandatory review, protection and publishing authority still apply. Neither the review event nor the rule grants rights by itself. |
| Later reuse | Editorial intake can route an existing review case; release notices can submit authorized notification intake; Collection upkeep can request an admitted guarded owner command. Each needs its own event, predicates, inverse and authority qualification. This proposal does not admit them automatically or make Scheduled capable of running arbitrary bindings. |

The smallest addition is the bounded interpretation and its durable handoff,
plus the missing profiles in their existing owners. Reject configurations whose
effect, inverse or authority is unsupported. This makes the owner gaps explicit
instead of claiming that a generic workflow runner solves progression or reversal.

## Bounded neighbourhoods

The following are proposed admission budgets for review and later measurement,
not measured capacity. They bound examined candidates, including hidden/stale
ones, rather than only successful results. No operation scans all rules, members,
reports, grants, events or prior executions to find its work.

| Read, sweep or command | Selected neighbourhood and continuation |
| --- | --- |
| Publish, review, activate, edit or retire | One rule head/revision, one activation, at most 8 predicates and 16 exact authority/evidence dependencies; definition at most 16 KiB. One action slot. Use expected heads and idempotent receipts. Scope indexing changes in the same bounded commit; activation never backfills history. |
| Rule, match, explanation or receipt read | One selected object and at most 16 exact dependencies. Rule/execution/history lists examine at most 50 indexed candidates for one authorized scope/selection, returning continuation over examined candidates even when the disclosed page is empty. No refill scan, offset traversal or unbounded exact count. |
| Event intake and rule matching | At most 16 committed envelopes per relay page; select matching activations by an index on scope and event type, at most 32 candidates per activation. Persist the event/rule cursor and durable action intents before advancing coverage. More rules produce continuations, not a Realm-wide rule cap or a silently truncated match set. |
| Dry-run or replay request | An explicit retained event selection, at most 50 candidates per page, with the same predicate/dependency bounds and current disclosure. Dry-run writes no action intent. Historical replay defaults to dry-run; application requires explicit admission, retains original effect identities and never resets completed dispositions. No live catch-up scan in the request. |
| Due work, retries and expired leases | At most 32 indexed due intents plus 32 expired leases per sweep. Each evaluates one binding, one exact target and at most 16 selected owner dependencies, then calls one bounded command. Sweep by due state/time; do not reevaluate all active rules or poll each rule separately. Scheduled uses these mechanics with its own occurrence meaning. |
| Effect, inverse or progression grant | One exact case/target or one recipient and one exact grant episode, within both the binding budget and the called owner's stricter cost limit. No role-wide assignment, member expansion, bulk decision or revocation of all grants to a person. An inverse is separately authorized and guarded by the affected owner head. |
| Disable/revoke, cleanup, retention, erasure and recovery | Closing the activation or Access gate is a point command that fences admission first. Reconciliation/cleanup follows indexed rule, source, subject or generation keys in checkpointed pages of at most 32 candidates; no synchronous history rewrite. Recovery holds effects until receipts, erasures and source coverage reconcile. |
| Optional notice and export | One explicitly eligible native recipient per notice intent; Notification retains its own endpoint/dispatch bounds. Export explicitly selected definitions and execution evidence in pages of at most 50 with current access checks on every page/download. No rendered private evidence or other people's grants in a public artifact. |

Bound predicate input, evidence references and response bytes as well as rows:
propose a 64 KiB envelope, 128 KiB total evaluation input and 256 KiB page/output
ceiling, with references to separately paged owner evidence instead of copying
large bodies. Use a five-second activation deadline and the owners' shorter
timeouts where applicable. Overflow/refused admission is observable; it never
means a successful prefix or a non-match. Index seeks may grow with tree depth;
hydrated rows and predicate work stay independent of total inventory/history.

Activation begins at an explicit source coverage position, captured without a
gap as the matching index becomes usable. Intake and paged matching pin the
activation selection/coverage basis; a concurrent edit cannot silently skip
remaining candidates. New activations do not acquire old events implicitly.
Changed source epochs, missing receipts and retention gaps hold the continuation
for explicit reconciliation; no jumping to the latest event. Keep terminal
dedupe tombstones through the admitted replay/recovery floor, and refuse replay
beyond retained evidence. Pending/held coverage is distinguishable from no work.

Admit each trigger only after its owner supplies a versioned committed envelope
with the exact report or independent-review reference and scope. Existing relay
and resource-selection adapters alone do not qualify those trigger meanings.
Event publication and effect dedupe belong to their respective owner commits;
neither a client callback nor periodic rescanning of cases can fill the gap.

## Authority, application and reversal

The worker uses a narrow service identity, bound to one selected activation's
current delegated ceiling and scope. It never impersonates the publishing
principal. At claim and at owner admission, recheck activation, rule revision,
representation/assignment lineage, target generation, recovery fence and exact
evidence. Scope matching cannot establish authority: a Realm A event cannot
cause an action against Realm B, even if the same operator manages both.

An explanation retains the input source/ID, rule revision/digest, predicate
results, exact evidence references, action intent, authority basis and owner
receipt or refusal. Disclosure remains with the referenced owner: authorized
reviewers can inspect the reason; affected people get their permitted decision
and appeal information; neither gets hidden reporter identities or private
grants through a debug trace. Rechecking disclosure applies to receipt replay,
continuations and downloads, not only the first read.

The logical effect identity binds source/ID, stable rule identity and action
slot, not worker attempt, activation revision or lease. A progression award
also binds recipient and the policy's qualifying evidence, so unrelated events
cannot renew the same award. Identical intent retries reconcile the same owner
receipt; different intent under that identity conflicts. Changing/re-activating
a rule cannot replay a successful effect as new. Cross-owner dispatch records
uncertainty before calling, then reconciles the original receipt after lost ACK;
it never assumes absence of a worker ACK means absence of the effect.

Revocation winning owner admission prevents a new effect. If the owner already
committed/admitted work, retain its receipt and report the actual pending,
partial or completed disposition under that owner's finite drain/cancellation
boundary. Cancelling an automation intent alone cannot erase an admitted owner
operation. Recheck before any further effect, and request an owner cancellation
or compensating command where permitted. Do not claim that revocation undoes a
committed moderation decision or retracts an already sent notice.

Reversal adds an attributable command linked to the original effect. Existing
Governance reverse/restore semantics are reused only for their admitted decision
families. For routing, the proposed owner inverse withdraws only that active
escalation if its expected head still holds. For progression, Access revokes
only the automation-issued grant episode; a later human assignment survives.
Expiry or disabling the rule prevents renewed automated privilege; disabling
does not silently remove unrelated human authority. Evidence withdrawal queues
the exact dependent award for re-evaluation; qualification must fence further
use of an invalid award before deferred cleanup. If an owner cannot enforce
that dependency, leave the action unadmitted. A stale inverse reports conflict
for human resolution instead of restoring an old snapshot over later edits.

## Per-persona authority as API observations

These are observations required of later public-API proof, not new operation
contracts or scope rows. Hidden identities are concealed; a readable object
with insufficient command authority is denied. Moderator, rule author, reviewer,
activator and grant administrator are independent powers.

| Persona | Allowed API observation | Refused or concealed API observation |
| --- | --- | --- |
| Signed-out visitor | Read separately published community rules and public content. | Authentication required for commands; private definitions, case evidence, execution history and grant identities concealed. |
| Signed-in stranger / another Realm's member | Same public reads and ordinary reporting under the report owner's policy. | Cannot enumerate private automation or invoke dry-run, activation, replay, inversion or grant assignment; own Realm status conveys no authority here. |
| Newcomer / affected author | Read own currently disclosable outcome/reason and existing appeal path; after a qualifying award, exercise only its named exception until expiry/revocation. | No self-award, self-review, rule activation, reporter identity, moderation power or bypass of membership, ban or mandatory human review. Losing the exception leaves other rights intact. |
| Rule author without activation authority | Publish an authorized scoped candidate and dry-run an explicitly readable selection if separately permitted. | Publication does not activate. Cannot inspect unreadable cases, assign grants or promote a dry-run result to an action. |
| Realm moderator / independent reviewer | Inspect permitted cases, run admitted routing and review contributions within current jurisdiction; see authorized reasons and request a permitted guarded inverse. | Moderation alone does not grant rule activation, assignment ceilings, private principal/grant inventories or authority in another Realm. Cannot automate a decision requiring independent human review. |
| Realm owner / authorized activator and grant administrator | With each separate power, activate the reviewed digest within a finite delegated ceiling, disable it, inspect bounded audit pages and revoke the exact issued award. | Ownership is not universal evidence-read, representation or platform authority. No wildcard future actions, unconsenting membership, broader roles or changes to mandatory review through progression. |
| Platform operator without community grants | Observe bounded non-content lag, lease, capacity and recovery diagnostics; hold/recover work through operational authority. | Platform status grants no private case/definition read, rule activation, community command or progression award. Recovery cannot reopen revoked authority. |
| Delegated client / automation worker | Client sees the person's current scoped API outcomes. Worker leases admitted intents, submits authorized owner commands and reconciles their exact receipts. | Neither writes owner storage directly, pools different people's rights, treats an event as a grant, or continues applying after its delegation is fenced. |

## Alternatives, falsifier and review boundary

Manual cases remain appropriate for uncertain decisions but cannot remove the
repeated command. Embedding conditions in the UI loses work on client exit and
diverges across agents. Extending Context inference with effectful execution
mixes descriptive meaning with authority. A new trust service or global score
duplicates Access and rewards unrelated powers. Arbitrary workflows/scripts add
unbounded reads and unverifiable effects. A broker may later transport events;
it supplies neither owner idempotency nor current authorization. Prefer one
admitted rule interpretation and shared jobs over any of those additions.

The falsifying scenario is a flagged post in Realm A and a newcomer with one
independently accepted contribution, under an explicitly reviewed activation.
The later contract/outcome step must demonstrate all of these API observations:

| Scenario / observer | Required API observation |
| --- | --- |
| Authorized moderator dry-runs and activates routing; relay repeats the same report event and loses a command ACK. | Dry-run explains the match with no escalation. Live processing exposes one logical effective escalation and the original owner receipt after reconciliation, with exact report/rule/evidence references. No duplicate case, decision or notice. |
| Activator edits/retires the rule or Access revokes its delegation before owner admission; a stale lease retries. | No new owner effect. Execution shows the fenced/refused reason. If admission already won, expose its true disposition and permitted cancellation/inverse, never a false claim that nothing happened. |
| Realm A moderator submits a B target, event or replay selection; stranger guesses A execution IDs. | Cross-Realm application denied and no B owner receipt created; private A objects/evidence concealed from the stranger. A multi-Realm operator still cannot widen a single activation implicitly. |
| Newcomer has exact independent accepted evidence; compare before/after submission under the proposed frequency policy. | Only the named cap changes for that recipient and finite episode. A fresh submission still enters mandatory review; unrelated posting, publishing, roles and private reads remain refused. Duplicate/revised/replayed events do not extend expiry; self-review and missing/withdrawn evidence cannot qualify. |
| Human changes routing or makes an independent grant, then requests reversal; qualifying evidence is withdrawn. | Owner inverse preserves the later human change, returning conflict if necessary. Only the automation grant loses effect; a human grant survives. Invalid qualifying evidence fences the dependent exception, with its reason visible to the authorized observer. |
| Authorized replay after downtime, erasure, source retention loss and restore; optional notice has an uncertain provider result. | Checkpoints resume without duplicating owner effects. Recovery/coverage gaps remain held, erased evidence stays undisclosed, expired grants stay expired. Notification alone owns retry/lookup and current recipient disclosure; a sent notice is not described as reversible. |
| Large rule/event/case histories, mostly hidden pages, many matching rules, poison input and exhausted capacity. | Bounded operational counters/storage plans show the proposed neighbourhood on each path. API continuations progress through empty disclosed pages; later matching rules are reached. Oversize/unavailable work is explicitly held/refused with reason, without dropped coverage or successful prefixes. |

Program must accept or revise the rule activation boundary, finite budgets,
shared-job ownership, routing inverse and narrow Access progression profile
before contracts. If either owner action cannot be made reversible within
these bounds, keep it dry-run-only and return the unsupported outcome to program;
do not substitute membership or broader moderation authority.

No stack, capacity experiment or human journey was run for this proposal.
Later proof needs real owner/API observations for every persona, concurrent
revocation and reversal, recovery faults, retained large-population fixtures and
physical plans/counters. A later surface must expose scope, reason, dry-run,
activation/expiry, held work and guarded recovery through those same APIs.
This note establishes a reviewable design, not implemented automation,
operator-retention improvement or competitor replacement parity.
