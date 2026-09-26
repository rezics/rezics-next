# Realm participation policies and review

## Admission contract

A Realm defines versioned membership, publication, review, entitlement and quota
policies. Ordinary membership and permission remain distinct from paid benefits.
Org participation does not automatically admit someone to a Realm. Join/leave/
rejoin preserves consent generations and independent enforcement state.
The first Access Agent participation operation uses
`POST /v1/access/membership-changes` with `kind: realm`. Its owner policy,
management permission, ban and admission generation are independent of an
organization's `kind: org` operational roster. See
[identity/access](identity-and-access.md#subjects-scopes-and-groups) for the
first-profile wire and dependent-grant limits. Realm-local publication,
organization participation and structural Realm changes have separate owners.

## Organizational authority boundaries

### Independent organization participation profile

Access admits an organization subject in `org_participation_subject` and registers
each native Realm's participation policy with a separate managing authority
subject. These are owner-provisioned admission records, not inferences from public
Agent type, catalog links or `kind: realm` membership. The tuple
`(realm, organizationSubject)` in `org_realm_participation` is unique. Its generation
starts at zero when absent and advances on each accepted transition. The separate
ban survives organization leave. Owner registration and policy administration
remain installation inputs in this profile.

`POST /v1/access/org-realm-proposals` requires an Account `access:manage` bearer,
current Realm-manager representation and an independent direct
`access.org-realm.admit` grant. It records a five-minute, one-use invitation for
the exact tuple generation, policy revision and terms. The invitation snapshots
the principal enforcement epoch, admitted subject generations, representation
and grant IDs/generations, and gate epoch. It cannot outlive its selected mandate
or grant. A proposal alone changes no participation state.

`POST /v1/access/org-realm-changes` accepts `join`, `leave`, `suspend` and
`lift-ban`. Join is the organization's explicit consent: its verified caller
must represent the admitted organization for `access.org-realm.participate` and
the organization must hold that independent grant. The caller and authority
subject must differ from the proposal's Realm manager. Commit rechecks the
proposal's exact saved authority, gate epoch, expiry, unused status, both admitted
subjects, current policy/terms, ban and tuple generation. It atomically consumes
the proposal, creates the joined episode and records both parties' authority
proofs in immutable private history. The response exposes no private principal
IDs. An alternative fresh mandate cannot repair an old invitation.

Leave uses the organization's participation mandate, including from suspended
state, and retains any ban. Suspension and lifting a ban require the Realm's
separate `access.org-realm.suspend` mandate/grant. Suspension of a joined episode
sets an independent ban and ends participation; lifting that ban never rejoins.
Both advance the tuple generation; immutable history retains each suspension/lift
reason reference even when a later decision changes the current ban. Rejoin requires a fresh
invitation and organization acceptance for the new generation. Closed admission
does not block leave, suspension or lifting a ban. These operations require exact
policy revision and current authority but do not require the other party's assent
to end or restrict participation.

Both write APIs bind a principal-scoped `Idempotency-Key` to the canonical intent.
An exact authorized retry returns the original immutable result after subsequent
episodes; changed intent conflicts. Stale tuple/policy/proposal basis yields
`409 org_realm_stale`, invalid or missing authority `403 org_realm_denied`, and a
held recovery fence or bounded lock failure `503 org_realm_unavailable`. A closed
scope denies operations. `GET /v1/access/org-realm-participation` reads one exact
tuple and current policy under either party's corresponding mandate; no roster
expansion or private proof is exposed.

These transitions create no representation, grant, membership, publication,
source ownership or managed-organization authority. They do not move an
organization or alter participation in another Realm. No authority consumer may
use the structural tuple as a grant. The organization publication profile below
uses the exact episode as a separate precondition alongside its own permission.
This participation profile alone gives partial IAM06/IAM23/IAM24 evidence. The
later organization-publication moderation profile and merged G-020 checks make
IAM23 a complete-case candidate pending final recorded backend qualification.

The two-party invitation/acceptance design was selected over a unilateral Realm
join or reuse of the Agent roster because those alternatives cannot express the
organization's separate decision and history. The separation-of-duty principle
in [NIST AC-5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final) informs the design;
distinct callers and these permission names are REZICS choices. The transaction
uses the existing Access scope gate and row locks following
[PostgreSQL 18 consistency guidance](https://www.postgresql.org/docs/18/applevel-consistency.html),
with two-second lock and five-second statement limits. Real owner tests must
falsify stale authority, competing acceptance and post-recovery replay; the
sources do not establish correctness of this composition.

Each API performs a fixed number of primary/unique or selective indexed probes,
with no recursive path, roster scan or dependent-grant fanout. For retained tuple,
proposal and receipt history `h`, expected indexed lookup work is `O(log h)` per
probe, constant selected rows, response bytes and application memory. A change
writes at most one tuple, ban, proposal-use row, immutable history and receipt,
plus one authority-epoch update. Historical receipt replay writes nothing.
Read and invitation take shared gate/tuple locks; transitions take the exclusive
scope gate, so unrelated reads and invitations can proceed together but all
mutations retain the existing scope serialization boundary. Invitations also
serialize the principal/key receipt using one bounded transaction advisory lock.
Proof selection orders eligible independent mandates and grants by expiry then
UUID with matching indexes, and captures exactly the chosen branch. The stable
statement-time range supports the expiry index; a live clock predicate also checks validity.
Small unrelated-row growth checks bound SQL calls and selected rows; cold-cache
I/O, planner behavior, global gate contention and host capacity remain unqualified.

Organizations participate independently by default. A Realm administrator may
moderate an organization's local publications or participation only through the
corresponding Realm permissions. Editing Realm-owned content requires its named
content permissions; adopting a foreign-owned source does not grant source-edit
or global organizational authority.

An explicitly managed organization has a founding or subsequently authorized
grant to its Realm/parent authority, with named administrative operations and
ceilings. Representation, voting, control/recovery and external grants remain
separately declared powers. Joining a Realm, moving a folder or changing public
metadata cannot establish or widen that grant.

An organization's public description follows the content owner's editing policy;
permission to edit a catalog description does not establish organizational control.
Changes to its operational roster, representatives or control/recovery require
the organization's admitted authority. Other Realms' content retains its own
owner/context checks. Suspending participation in one Realm does not transfer
ownership or erase independent publications.
Apply [identity/access](identity-and-access.md) for all representation and
grantability checks, including transitions between independent and managed modes.

### Explicit managed organization profile

The first managed operation is `access.org.roster.policy`: set whether **one
organization's operational roster** accepts new joins. It changes the existing
Access `membership_policy` for `kind: org`, advancing its revision atomically;
the Agent and private-principal membership APIs consume that policy. It cannot
change terms, add members, appoint representatives, grant permissions, publish,
vote, recover control or affect a Realm's own roster. There is no wildcard or
implicit administrator bundle.

Access owns an immutable `managed_org_grant` payload with organization, one
recipient (`realm` or explicitly admitted `parent` organization), resolved
recipient authority subject, exact organization roster resource, the single
named action, validity interval, and redelegation ceiling **zero**. Its lifecycle
starts active at generation 1 and can only advance to revoked generation 2.
Typed foreign keys retain the recipient's admitted Realm or parent record,
preventing deletion/recreation from resetting a saved admission generation.
An immutable event and principal/key/intent receipt accompany each change.
`org_roster_policy_history` retains the exact grant generation and recipient
representation proof for each protected policy effect. All are private Access
state and participate in recovery coverage; public catalog links are never read.

The issuer must currently represent the admitted organization for
`access.org.managed.grant`, with an independent direct grant of that action.
Issuance additionally requires its independent
`access.org.managed.assign.roster-policy` grant. These installation-provisioned
mandates/ceilings are separate from participation and ordinary roster management;
this API cannot mint them. Wire instants use canonical UTC with three fractional
digits (`YYYY-MM-DDTHH:mm:ss.sssZ`). Validity is at most 30 days and cannot outlive the
selected issuer mandate, management grant or assignment ceiling. The recipient
Realm must have a registered manager; a parent must be an active admitted
organization. A grant cannot target its own issuer organization.

Each **new effect** requires the exact original issuer principal enforcement
epoch, subject/admission generations, representation and management/assignment
grant IDs and generations to remain current. Narrowing either saved grant's
lifetime below the managed grant's complete interval denies use, even while both
are unexpired. Recipient subject/admission generations must also match. A Realm
policy revision is the recipient admission generation in this first profile;
changing it conservatively requires a new management grant. The caller names its
current recipient representation ID/generation for `access.org.roster.policy`;
it cannot substitute membership, a different Realm, a replacement issuer mandate
or an unrelated direct right. Revocation uses a **current** organization issuance
mandate, so loss of the original issuer path does not prevent a newly authorized
organization representative from revoking. No dependent row expansion is needed:
use rechecks a fixed set of exact dependencies. Leave/rejoin, suspension, moves
and descriptive edits neither create, widen nor revive a revoked/stale grant.
Participation itself is not a grant dependency and does not revoke an otherwise
valid explicit management grant.

All routes require a verified Account `access:manage` bearer:

| API | Contract |
| --- | --- |
| `GET /v1/access/organization-management` | Under the organization's issuance mandate, read one exact organization, current authority epoch and roster policy revision/open state. |
| `POST /v1/access/managed-organization-grants` | Issue or revoke one grant with expected authority epoch; revoke also names its exact generation. Issue names recipient, action, validity and ceiling zero. |
| `GET /v1/access/managed-organization-grants/{grantId}` | Read one grant as organization issuer or recipient representative; return no principal IDs/private proofs. Recipient reads include its current representation ID/generation for use. |
| `POST /v1/access/organization-roster-policy` | Name the exact grant, recipient context, organization, grant generation, representation ID/generation and roster policy revision, then set `admissionsOpen`. |

Write keys bind canonical intent across these managed operations. An exact retry
returns its immutable prior result after current caller authority checks, even
after grant revocation or a later policy revision; it makes no new effect and
does not claim that old state is current. Changed intent gives
`409 managed_org_key_conflict`; stale epoch/grant/policy/representation generations
give `409 managed_org_stale`; missing, expired or revoked authority gives
`403 managed_org_denied`. Recovery holds and bounded database contention give
`503 managed_org_unavailable`. Account session deactivation rejects the next API
call before Access executes; Access principal deactivation also invalidates saved
issuer proof. Identity projection/recovery keeps Account and Access separate.

This chooses an explicit grant plus one policy operation over reusing the
participation tuple or a general organization-administrator role. The latter
alternatives blur use and assignment and silently enlarge the first consumer.
The independent assignment ceiling follows the escalation distinction in
[Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#privilege-escalation-prevention-and-bootstrapping)
(reviewed 2026-09-26); exact dependent lifetime, one action and zero redelegation
are REZICS choices. [PostgreSQL 18 row locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)
inform the transaction ordering, not proof of this authority composition.

All operations lock the recovery fence, scope gate, selected authority rows,
grant and policy. Writes serialize under the existing exclusive scope gate;
reads use the shared gate. Locks last through commit, with two-second lock and
five-second statement timeouts. Each request uses a fixed number of primary-key,
unique or expiry-ordered indexed probes, constant selected rows and bounded
payloads; there is no roster, grant-list or recursive authority expansion.
Expected probe work is `O(log h)` in retained history `h`. Issue writes one grant,
event, receipt and epoch; revoke updates one grant and writes one event, receipt
and epoch; the protected operation updates one policy and writes one history,
receipt and epoch. Retry/read change no business rows. These are logical owner
row counts; index maintenance and PostgreSQL row-lock/WAL bytes are not measured
by that assertion. SQL-call, selected-row, lock-wait, logical-write-count and
unrelated-history counterexamples belong to affected tests; cold-cache I/O,
physical write amplification, scope-gate throughput and deployment capacity
remain unqualified.

This is partial IAM24/IAM23/IAM06. Founding grants, general administrative
actions, control/recovery, voting, publication moderation, paid benefits, moves,
complete Realm quota/review and wider delegation remain retained work.

### Exact organization publication moderation

`POST /v1/organization-publication-rejections` accepts
`realm-organization-publication-rejection-v1` with an Account `realm:reject`
bearer and principal/action-scoped `Idempotency-Key`. It targets one native text
Contribution's selected, public publication in a Realm/Main Version slot. Inputs
name the Realm, admitted organization, participation ID/generation and consumed
proposal, policy revision, Work/Main Version and expected Work head, selection,
Contribution, publication decision, selected draft, acting manager and exact
representation ID/generation. The decision is the fixed `not-approved` local
suppression. The manager is the Realm's independently registered authority;
it needs the separate `publication.reject.organization` direct permission on
`publication:reject:<realm>`. Generic `publication.reject` authority, organization
self-representation, managed-roster grants, membership and public descriptions
cannot satisfy this permission. Installation still provisions manager mandates
and permission grants; this operation does not create or widen them.

Access owns `organization_publication_moderation`, an immutable row tied to a
dispatchable admission, exact joined-history generation, consumed proposal and
publisher admission. Its canonical target, selected manager proof, organization
admission generations and publisher receipt have a stable digest. One transaction
locks the recovery fence, G-012 scope gate, exact Realm action gate, principal,
policy, selected manager representation/grant, admitted organization and episode.
It verifies the current joined, unbanned episode, the proposal's admitted subject
generations and policy, then inserts the proof, claimed admission, admission
receipt and registration/claim outbox together. The admission lasts at most 30
seconds and cannot outlive its selected mandate or permission. Real-clock expiry
is checked again after lock waits and before commit. A deferred database
constraint rejects a moderation admission that commits without its bound proof.
Generic registration and claim explicitly refuse this action. A preflight
participation read followed by generic registration was rejected because leave
can commit between those steps.

The Contribution's author is the exact organization IRI in the native graph,
publication revision and immutable draft/publication payloads. The sealed Access
`contribution.publish` admission must have that acting subject, Contribution
scope and exact graph receipt/digest/position. The operation does not interpret
author text or catalog links as authority. Before any dispatch it checks the
immutable selected evidence and content-addressed objects. Jena compares the
current Work head, Realm slot head and Contribution publication head, plus the
selected publication/draft/author identities, inside the effect transaction.
Its clock guard refuses dispatch after the admission's deadline. A changed head
seals a stale cancellation; missing owner or graph evidence never implies success.

An admission already made dispatchable may finish within its original deadline
after a later leave, suspension or ordinary revocation, even if Main has not yet
sent its graph request. That finite in-flight decision is attributed to the
earlier admitted episode. A new admission cannot use an
ended, banned or replaced episode. Retrying an unresolved admission requires
the saved episode and manager path to remain current; a fresh grant cannot
replace the saved permission. An additional valid grant does not invalidate the
original grant, which is rechecked by its saved identity and generation.
Exact currently authorized retries can recover an already committed receipt
after later leave or rejoin. Changed intent conflicts,
and a revoked named representation or deactivated Account session denies a new
API call. Strong Access closure still requires draining/sealing its outstanding
admissions before claiming completion. There is no instantaneous distributed
revocation of a graph request already sent.

The Jena transaction replaces only the target slot head, writes one immutable
rejection and receipt/outbox, and deletes that exact predecessor's local public
MatchUnit. Local selection reads report suppression and local search omits it;
the Main selection, other Realm selections, Work, Contribution author, draft,
publication and earlier revisions survive. The rejection uses the established
`realm-local-rejection-v1` RDF shape and receipt family. Its immutable object
additionally retains the complete organization target and opaque Access proof
digest. Existing generic rejection digests, objects and receipts retain their
meaning; they cannot be reinterpreted as organization-profile evidence. This
profile covers native text publication, not general Content publication, source
editing, organization management or quota/review policy.

Access and Jena do not commit atomically with each other. Loss after graph commit
but before Access acknowledgement returns pending; retry reads the same graph
receipt and seals the original admission. Held graph recovery replays the retained
relay event and immutable object only against the exact sealed Access admission,
moderation proof and publisher admission. Missing Access tail, changed proof or
changed retained event blocks replay. Recovery keeps the original decision's
identity and attribution; it never reconstructs authority from the current
participation tuple. The Access recovery coverage includes every proof row, and
the WAL fixture retains it through independent restore. An incompatible owner
cut requires restoring the missing evidence or remaining fenced, not minting a
replacement admission. These tests do not qualify arbitrary mixed-owner backup
cuts or instantaneous cross-owner atomicity.

The lock order follows [PostgreSQL 18 row locking](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)
and the post-wait behavior described in its
[Read Committed contract](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED)
(reviewed 2026-09-26). These support the mechanism; owner races and recovery tests
establish the particular composition. Holding PostgreSQL locks across graph I/O
was rejected: it neither creates a distributed commit nor handles lost graph
responses. The chosen durable admission plus guarded receipt has an explicit,
finite in-flight boundary instead.

Authority evaluation uses fixed exact/indexed probes and selects one grant for
fresh admission; a retry also probes its saved grant by identity. These probes
are independent of roster size and publication history. For retained history
`h`, each probe is expected `O(log h)`; selected rows and metadata bytes are
constant. Fresh admission writes one admission, proof, receipt and two outbox
rows. Graph work is bounded by one slot, one publication, three immutable
payloads and one local MatchUnit; payload reads are `O(b)` in the selected text
bytes, bounded by the existing native text input limit. Recovery reads one event
and the same exact proof; no roster or revision-history expansion is needed.
Two-second lock and five-second statement bounds remain in force. Small growth,
logical row/write and graph-response budgets do not qualify cold-cache I/O,
physical WAL amplification, scope-gate throughput or deployment capacity.

## Resource and action budgets

Count publication slots, review work and other units according to explicit policy.
Reserve and settle quotas idempotently. Creating content, publishing it to another
Realm, editing, republishing and replying must all pass their relevant admission;
no alternate endpoint bypasses the policy. A failed review compensates only the
declared reservation, not unrelated purchases or contributions.

## Review and adoption

AI/human review binds exact content, dependencies, policy and method revisions.
Pending or unavailable review cannot activate accepted publication. Preserve an
accepted earlier version while a later author version awaits review. An explicit
rejection suppresses local adoption without deleting the source or other Realms.
Appeals/reversals are new attributable decisions.

## Pro application

Pro uses the same Realm, subscriptions, review and delivery contracts. General
content cannot enter a fixed-Pro view because local candidates are sparse. Other
Realms can reuse the same capabilities under their own authority. Qualification
covers normal and privileged operations, stale review, changed policies, grant
expiry, multi-Realm replies and recovery after partially completed admission.
