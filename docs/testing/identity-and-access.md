# Account and Access acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| IAM01 | Log in across two products and select different Agents per tab | OIDC/session boundaries and tab contexts remain independent. |
| IAM02 | Replay invalid issuer/audience/redirect/CSRF state | Reject without changing account state. |
| IAM03 | One principal represents several Agents; several control one Agent | No public account mapping and no one-to-one assumption. |
| IAM04 | Combine direct account and represented Agent rights | Reject unauthorized pooling. |
| IAM05 | Edit populated role/group while impact approval is pending | Stale generation/ceiling blocks activation. |
| IAM06 | Leave/rejoin Org or Realm | New admission generation; no revived dependent grant or erased ban. |
| IAM07 | Revoke while command/search/download is admitted | Declared fence and in-flight semantics hold at completion. |
| IAM08 | Lose last controller or recover compromised account | Continuity proof and independent recovery enforced. |
| IAM09 | Refresh revoked consent/installation | Cannot regain access or widen ceilings. |
| IAM10 | Account or Access becomes unavailable | Protected admission fails closed; no unknown-to-allow conversion. |
| IAM11 | Erase account then restore/replay | Private credentials stay erased without deleting unrelated public content. |
| IAM12 | Invite a cataloged author with no admitted representative | Invitation remains pending; profile editing or a matching name cannot activate it. |
| IAM13 | Grant to an author, change its admitted representative, then issue a grant as that author | Recipient/issuer object identity persists; actual principals and complete grantable ceilings remain explicit. |
| IAM14 | Issuing employee departs, or a dependent upstream grant is revoked | Institutional assignments and dependent delegation follow their distinct lifetime contracts. |
| IAM15 | A wiki excludes a Realm, evaluated under principal and acting-subject modes | Switching Agent cannot bypass principal-mode exclusion; actor mode does not infer membership through every controlled object. |
| IAM16 | Reorder a scoped exception and a Realm exclusion | Results follow the declared combining algorithm and policy revision; mandatory guards remain effective. |
| IAM17 | Earlier exclusion evidence is unavailable or its work budget is exhausted | Do not fall through to a later allow or treat unknown membership as non-membership. |
| IAM18 | Mute a Realm, block its interactions, and inspect direct resource access | Presentation, interaction admission and resource-access effects follow separate declared contracts. |
| IAM19 | A private membership set is referenced by another wiki's policy | Reference is admitted for that purpose; errors/diagnostics do not expose a private roster or create an unrestricted membership oracle. |
| IAM20 | Atomically switch grant and exclusion facts between two always-denied states while reading decision inputs | A decision cannot combine facts from different authority snapshots into an allow. Batch transport or cache bypass alone does not establish this boundary. |
| IAM21 | Read old content after its reader's authority is revoked | Historical data uses current qualified authority; an old content snapshot cannot revive old grants. |
| IAM22 | A lower-priority condition is unavailable after an earlier rule already decided, or a higher-priority condition is unavailable before a later allow | Preserve first-applicable/error semantics without weakening mandatory guards; unresolved earlier evidence cannot become non-membership. |
| IAM23 | Realm administrator moderates an organization's local publication or suspends participation | Affect only admitted Realm scopes; no global organization control, source ownership or other-Realm erasure. |
| IAM24 | Independent organization joins/moves between Realms, or changes to explicitly managed mode | Structural changes confer no control; managed mode requires the organization's admitted grant and ceilings. |
| IAM25 | P is only A's member/profile editor/administrator while A may manage B | No represented access to B without a representation mandate; an explicit eligible-set grant is evaluated under its own selector. |
| IAM26 | P represents A for B's granted member-administration operation | Allow as A with P recorded privately; a publishing-only mandate does not qualify. |
| IAM27 | A manages B and B holds rights on C | No use of B's rights until an admitted bounded representation path to B exists. |
| IAM28 | Compound command uses several complete proofs, or tries to assemble one obligation from incompatible partial paths | Complete proofs in the admitted acting context can satisfy distinct obligations; incompatible pooling cannot satisfy one obligation. |
| IAM29 | Two independent complete grants allow an operation; revoke one | Preserve the other source and its provenance, subject to mandatory guards. |
| IAM30 | Administrator adds themselves to a protected set, rewrites its role, reparents a group or installs privileged automation | Reject without the resulting authority ceiling and required approvals. |
| IAM31 | Concurrent representation/topology changes each appear acyclic in isolation | No cycle/unapproved expansion becomes active; ordinary mutual management and descriptive links do not imply representation. |
| IAM32 | Institutional representative roster changes within its approved policy, or the policy ceiling widens | Qualified roster replacement retains the institutional grant; widening requires its declared grantor/approval authority. |
| IAM33 | Reuse a proof handle after revoke, expiry, leave/rejoin, role revision or actor switch | Revalidate bound context and dependency generations; no stale allowance. |
| IAM34 | Diamond paths have different limits, or one supporting edge is removed | Memoization preserves distinct bounded states and independent valid support; no duplicate authority or accidental revocation. |
| IAM35 | High branching, negative check, bulk work or an operational-limit reduction exceeds the supported profile | Bounded work and typed unavailable outcomes; profile activation/migration prevents silent reinterpretation of saved grants. |
| IAM36 | Parent/child groups have different grants | Child membership receives the admitted parent grant; parent membership does not receive the child's extra grant. |
| IAM37 | A Realm editor may edit an organization's catalog description | Apply the content owner's editing policy; the edit permission does not establish organizational control. |

The `organization-publication-moderation` fixture targets IAM23 through real
Account OAuth, Main, Access and Jena. It exercises the separate Realm action,
exact selected publisher and episode, stale/revoked representation, lock-wait
expiry, changed Work/selection/publication heads, suspension, leave/rejoin and
local-only selection/search effects. The paired
`organization-publication-recovery` fixture uses isolated owner copies and a
held graph replay to reject missing Access tail or altered retained evidence,
recover an acknowledgement lost after graph commit, and preserve another Realm
and Main search. Its authentication is isolated; the API fixture owns OAuth.
The Access WAL fixture checks immutable moderation proof durability with
synthetic graph coordinates; it does not itself prove the graph publication.
The generic rejection receipt regression retains old digest semantics. These
are affected checks, not a final backend qualification or a claim that every
mixed-owner recovery cut works. Merged API `20260926t084104-81f740`, native
model `20260926t084136-b616c2` and physical recovery
`20260926t084151-09b82d` passed on `9780586`. Together with the prior
independent-admission fixture, the merged real-owner checks cover the full IAM23
row: an exact Realm manager can reject an organization publication or suspend
participation within that Realm, without acquiring organization/source control
or erasing another Realm or the native Work. IAM23 is declared a complete-case
candidate for the final recorded backend run. Broader WORK/SEARCH assertions
are unchanged.

The `access-org-realm-api` fixture covers partial IAM06/IAM23/IAM24 through real
Account OAuth/introspection, Main handlers and Access PostgreSQL. It checks two
distinct organization/Realm principals and authority subjects, exact selected
mandate/grant/subject generations, policy and terms changes, expired proposals,
an accepting grant expiring while the other party's proof lock waits,
principal fencing, single-use acceptance, concurrent invitations/joins/suspensions,
immutable receipt replay, independent retained bans, leave/rejoin and unchanged
Agent rosters/authority/other-Realm state. Unrelated invitation-history growth
at 0/32/256 added rows checks constant Access calls and selected rows for exact
reads. A held shared scope lock admits reads and invitations while a mutation
times out as unavailable. Account session deactivation and Access recovery hold
deny new effects. The Access PITR fixture restores the participation episode,
ban, exact proofs, immutable history and receipt replay from archived WAL after
the base backup. This fixture alone does not qualify managed mode, Realm
publication moderation, moves, quota/review, paid benefits or deployment
capacity; IAM06 and IAM24 remain partial. The combined G-020 fixture above
adds the missing IAM23 moderation and declares that full row as a candidate.

The `access-managed-organization-api` fixture adds partial IAM24/IAM23/IAM06
through real Account OAuth, Main HTTP handlers and isolated Access PostgreSQL.
It checks the separate issuer mandate/assignment ceiling, exact recipient and
organization resource, named action, zero redelegation, original authority
generations, narrowed validity, expired recipient representation, current Account
session, exact retries, changed keys, concurrent issue/revoke and lock/recovery
fences. A managed policy change actually closes/reopens organization roster joins
through the existing consent and membership APIs. Participation in two Realms,
roster membership and descriptive RDF cannot create that right. Leave/rejoin
cannot revive a revoked grant. Parent-recipient use is separate from Realm use.
SQL calls, selected rows and four logical row writes stay constant with
unrelated grant growth; the exact grant lookup checks its primary-key plan.
The isolated Access PITR case issues, uses and revokes the grant after its base
backup, then checks WAL-restored payload, events, policy history and exact receipt
replay while denying a new effect. These tests do not qualify founding grants,
general control/recovery, voting, publication moderation, paid benefits, moves,
complete quota/review or host capacity; the retained IAM IDs remain partial.

The G-024 `access-org-realm-move-api` fixture adds an actual atomic move through
Account OAuth/introspection, Main and Access. It covers exact source identity,
both policy/generation branches, target terms/proposal identity and expiry,
two-party acceptance, revoked saved proof and principal epochs, inactive
organization/principal, target closure, both bans, recovery hold, lock timeout
and accepting authority expiry during a saved target lock wait. A late database
constraint failure proves that both tuple writes and histories roll back. Same
generation competition leaves one pair/receipt; exact concurrent retries and
retries after a return move preserve the original result, while changed intent
conflicts. Returning to an existing tuple advances its generation. Operational
rosters, unrelated participation, representation, direct grants and a real
explicit managed grant remain unchanged; that parent's protected policy operation
still succeeds after the move and return. Work creation still needs its own grant.
At 0/32/256 added background episodes, SQL calls, selected rows and eight logical
writes are bounded; replay writes zero and an exact proposal probe uses its
primary-key index. These are small logical-cost checks, not I/O or capacity proof.

The moderation fixture now moves after dispatch admission, checking unchanged
native Work/Contribution/selection state, rejection of new source admissions,
and completion only within the unchanged original deadline. The Access WAL
fixture writes the move after its base backup, restores exact paired histories,
consumed proposal and receipt, checks full state coverage and authorized read/
replay after reopening the isolated copy, and rejects missing WAL. G-012 join,
G-017 explicit managed grant and G-024 move together supply an IAM24 candidate
for manager integration; final recorded backend QA owns qualification. Broader
founding grants, control/recovery, voting, quotas, review and paid benefits remain
outside these profiles.
Selected worker API checks passed in `20260926t092431-149640` (four fixtures),
with strengthened preservation checks in `20260926t092718-2c90bf`; Access WAL
passed in `20260926t092432-d9e446`. These selections do not replace merged or
recorded backend acceptance.

The IAM06 first-profile `access-membership-api` fixture uses Account OAuth,
Main HTTP handlers and Access PostgreSQL. It covers separate Org/Realm policies,
recipient and manager OAuth scope separation, recipient-issued consent and
revocation, exact owner/kind/member/episode binding,
join/leave/rejoin generations, bound direct and group grants and a role binding,
their use-path loss and saved claim rejection,
unchanged independent Realm state, a retained ban, stale and changed-key
conflicts, exact replay, concurrent same-generation leave and immutable history.
It also checks a closed admission policy still permits leave, that 257 mixed
dependent authority rows return unavailable without a partial leave, and that Access
recovery hold rejects the operation.
The `access-private-membership-api` fixture covers an Account-verified recipient
without a public Agent, manager/recipient scope separation, private self-read,
consent replay/revocation, separate Org/Realm policy and ban state, leave/rejoin
episodes, direct principal-grant dependency, deactivation and Account deletion
fences. This bounded profile does not qualify general group/role recipient
semantics or wider Realm publication; IAM06 remains partial until those paths
and broader capacity profiles are qualified. The Access PITR fixture includes
private consent, consumed episode, dependent grant and row digest in its
isolated WAL restore.

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

The registered [IAM11 fault fixture](../../tests/qa/fault-recovery/account-erasure-frontier.test.ts)
deletes an authenticated Account member after Access deactivation and retention of
the exact deletion intent and subject tombstone in the relay owner. An unrelated
member creates a public Work through verified Account and Access admission, and
publishes an exact PostgreSQL Content revision. The fixture checks that the graph
Work and publication, and Content's returned revision bytes, survive deletion and
the current isolated physical restore. A physical backup taken before deletion
restores readable credentials but cannot pass the retained Account/Access
frontiers or release the graph hold. A second backup taken after deletion restores
no user, password account or session for the erased member and releases only with
the signed current Account, Access and Content coverage and deletion set. IAM11
remains partial: historical physical copies are not sanitized, and production
off-host journal and backup custody are unproven.

The authenticated Work API journey also exercises IAM10 with a real Account
bearer. Main instances whose Account verification endpoint or Access database is
unavailable each return `503 dependency_unavailable` for a protected Work create;
the graph sequence does not advance. Selected integration
`20260925t195424-739f4a` passed. IAM10 is declared for the final complete run.

The first `work.create` acting-context API fixture exercises real Account OAuth,
Access PostgreSQL representation, Agent and direct-principal grant, public
attribution rows, and Main HTTP reads. Its concurrent checks model independent
direct and represented selections. Negative cases reject incomplete paths,
cross-mode borrowing, missing attribution, revoked direct proofs, deactivated and
reactivated Agent/principal generations, and a stale scope epoch in both modes.
It also checks that 50 combined choices are complete and a 51st returns
unavailable without a truncated success. The owner cost contract records the
remaining SQL-plan and composed-route work checks.
It exercises direct command registration and claim. This is an IAM04
slice; browser tab storage, grant mutation, compound multi-obligation commands,
and multi-hop representation remain unqualified. The QA integration tier runs
this fixture against Account and Access databases cloned from its migrated templates, so its
scope closure cannot change another file's authority state.
The same fixture saves and clears a private task preference, proves exact replay
and stale/concurrent CAS, keeps another principal's choice separate, and checks
that a revoked preferred Agent disappears from the eligible default without
changing an already explicit tab selection. It checks that the Access recovery
digest changes with the private preference row and its receipt. Browser tab
behavior remains for W1.

The IAM36 first-profile extension to that real Account OAuth, Access PostgreSQL
and Main HTTP fixture installs private same-scope Agent groups through the Access
owner mutation boundary. It checks child-only grant isolation from a parent
member, ancestor grant reachability by a child member, discovered context
privacy, represented command registration and selected-path claim, grant
revocation before claim, stale generation, populated reparent denial, cycle
rejection and the 32-edge admission limit. This remains a partial IAM36/IAM05
slice until central QA executes it and until impact approval, general roles,
principal membership and broader capacity/concurrency profiles are qualified.
Source/type checks alone are not runtime evidence.

The IAM05/IAM36 public group API extension uses a real Account OAuth bearer,
Main route and Access owner. It checks unauthorized and unrepresented callers,
immutable same-key replay across Main instances, changed-intent conflict, one
winner under concurrent scope CAS, empty reparent, assignment-lifetime ceiling,
current object-generation read, selected `work.create` proof and its invalidation
after revocation, populated reparent denial, a grant receipt replay after expiry,
and an over-cap state read that returns unavailable rather than a truncated list.
Selected integration `20260925t174136-90d043` passed. This remains partial
IAM05/IAM36 because independent impact approval, general roles and broader
capacity/physical-cost qualification are not implemented.

The IAM05/IAM30 populated-reparent extension stages a bounded potential-impact
preview through the manager's Account token and reads it under a separate
approver's token. The real Access owner rejects an intervening scope generation,
self-approval despite a separate approval grant, and approval without the
independent work.create ceiling; all leave the parent unchanged. A fresh proposal
then approves and activates in one transaction, returns the same result for the
same key, conflicts on a reused key or changed approval intent, exposes activated
status, preserves the selected descendant grant path, and rejects mutation of
the activation receipt. Selected integration `20260925t175421-c312b7` passed.
General role/representation impact, exact final per-Agent eligibility preview,
physical lock contention and broader capacity remain open; IAM05/IAM30 are partial.

The IAM13/IAM14 first institutional grant API fixture uses real Account OAuth,
Main routes and Access PostgreSQL. It denies a missing assignment ceiling and a
grant lifetime beyond that ceiling, then creates an Agent-to-Agent `work.create`
grant with the issuing principal retained privately. Exact key replay and
changed-intent conflict, one winner under concurrent epoch CAS, exact and 50/51
keyset reads, and revocation of the selected use path pass. The issuing operator
loses its mandate while another qualified operator reads and revokes the same
issuer-Agent grant; the recipient Agent gains a new representative who uses its
separate seeded assignment mandate to issue a grant as that Agent. Selected
integration `20260925t180337-25c0aa` passed. General role revisions, mandate
creation, dependent grant lifecycle and physical cost remain open; IAM13/IAM14
are partial.

The IAM25/IAM26/IAM33 representation API fixture starts with a verified Account
recipient who has no Access principal. Its single-purpose request creates that
private principal, returns only a handle, and can be read by an authorized Agent
manager without exposing the Account subject or principal ID. Acceptance without
the assignment ceiling, and a validity longer than that ceiling, are denied.
An exact key replay survives the advanced scope epoch while changed intent
conflicts. The recipient becomes eligible for the selected Agent and registers
one exact `work.create` admission; revocation denies the selected context and
its saved claim. A new request and mandate restore current eligibility while
the old claim stays denied. Request and change receipts reject mutation.
Selected integration `20260925t181322-6dc851` passed. Protected mandate policy,
recipient self-revocation, composed representation and physical cost remain open;
IAM25/IAM26/IAM33 are partial.

The IAM05/IAM30/IAM33 first role profile fixture uses verified Account OAuth,
Main API routes and the Access owner. It creates an empty role revision and
binding, then shows neither grants `work.create`. Adding a permission requires
the separate assignment ceiling; the old binding stays empty while a newly
pinned binding allows current discovery, selection and represented command
registration. The admission saves its exact binding identity, generation and
revision. A later empty revision does not remove that right from the old pinned
binding; revocation denies selection and its saved claim. The fixture also
checks validity ceilings, exact replay and changed-intent conflict, a stale
head, one winner under concurrent scope CAS, current exact/page reads and
immutable revisions and receipts. Selected integration
`20260925t182755-e1c783` passed. General roles, protected revisions and physical
cost remain open; IAM05/IAM30/IAM33 remain partial.

The IAM33 represented `work.create` owner fixture pins the selected
representation and direct Agent grant, or the selected group path, in each
admission. Claim checks their exact identities, actions, scope, validity and
generations alongside the principal epoch and public Agent generation. Revoke,
expiry, an alternate valid mandate/grant, and an actor switch cannot rescue a
saved path; a fresh registration may use independent valid support. An
idempotent retry returns its original receipt with dispatch disabled after the
saved proof becomes stale. This is a partial IAM33 profile pending central QA
and the broader leave/rejoin, role-revision and multi-operation dependency graph.

The IAM04/IAM36 discovery cost fixture adds 20 Agents through inherited group
permission, fills the mixed represented/direct context list to 50, and rejects
the 51st complete candidate. A counted real Access connection bounds discovery
to 13 SQL calls including transaction setup and commit. Selected checks and
command claims still evaluate their own current exact authority path; the
discovery output contains Agent choices without private membership details.

The registered `services/account/tests/consent-revocation.integration.test.ts`
checks the first IAM09 consent slice with real Account HTTP, disposable
PostgreSQL and Main-verifiable access. It covers an old refresh token after
withdrawal and in-place narrow/widen re-consent, codes held across an edit
and delete/re-consent, scope/client/subject isolation, and a concurrent
refresh/delete postcondition. Run it through the central QA integration tier;
source/type checks alone are not runtime evidence. Installation revocation,
selected acting-Agent context and opaque-token issuance are outside this first
profile, so the full IAM09
row remains open after a consent-only pass.
