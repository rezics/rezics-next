# Identity, representation and authorization

## Identity and service boundaries

Account owns private human/workload principals, authentication, credentials and
recovery. Main owns public Agents, including Person, Organization and Service
descriptions. Access owns their effective representation and grants. Cataloging a
person or organization does not establish control, participation or a private
account. Multiple principals may represent an Agent and one principal may represent
several Agents. Do not publicly reverse-map them into an account directory.

Distinguish authenticated principal, selected authority subject, public attribution
and client application. A private main-Agent/default preference selects convenience,
not rights; request/tab context is explicit and prepared commands/consents cannot
be retargeted by changing a default. Workload principals need no public persona.

## Subjects, scopes and groups

Grantees are typed private principals, admitted Agents or eligible member sets.

Admitted objects can be both grant recipients and grant issuers. The authenticated
principal actually issuing a command remains distinct from its selected issuer
subject and is recorded privately. An extensible authority-subject capability
requires explicit lifecycle/control admission; merely being a native object or
editing its public description does not grant representation authority.

Groups collect recipients, roles collect permissions and bindings attach grants
to scopes and conditions. Groups are not authenticated callers. Resource scopes
reference the native owner and lifecycle; private account scopes remain private.
Service-local identities use concrete integrity constraints. Remote resources use
owner-verified registration/lifecycle fences, not fictional cross-database FKs.

Membership has an admission generation, consent/terms basis, current state and
history. Leaving/rejoining creates a new generation and cannot revive old dependent
authority. Realm participation, Org operational membership and Agent control have
independent admission policies. All-members sets derive from qualified membership;
they are not a second writable roster.

Groups initially use a same-scope, single-parent hierarchy with cycle-free changes.
Group reparenting and populated membership edits stage assignment-impact analysis,
require independent approvals where the affected ceiling demands them, and activate
under expected topology/role/admission generations. Inherited membership retains
its actual path; direct selection, effective membership and public Team presentation
remain distinct. Do not materialize every group descendant per account request.

Realm, Organization, Team and Person are not mandatory levels of one authority
tree. Membership, Realm participation, resource containment, administration and
representation are distinct typed relations. Descriptive links such as affiliation,
parentOrganization or sameAs establish no control. Resource inheritance applies
only to registered permission families and stops at an independent authority root.
Realm-local and explicitly managed organization powers follow
[Realm participation](realm-participation.md).

A grant to an organization subject is exercised through its representatives. A
grant to its eligible member set authorizes the qualifying members under that
selector's declared subject model; it does not make them representatives. A Team
may have a separately admitted authority-subject capability, but a recipient set
alone is not an acting identity.

## Roles, bindings and grantability

Permission keys describe independently grantable domain operations. Editing,
publishing, changing ownership and assigning authority remain distinct when their
consequences differ. No wildcard grants unknown future permissions. Built-in and
custom role revisions have stable definitions, valid target/subject types and
explicit approval ceilings. Editing a role cannot silently widen an externally
approved installation or representation grant.

Bindings identify recipient, target scope/path, permission/role revision, validity,
conditions, assigning authority and lifecycle. Authority to use a permission,
assign it, edit a role and redelegate are independent. Compare effective expansion
against the assigner's permitted ceiling and required independent approval.
Staged discovery cannot use stale role/group generations at activation.

Role presets may bundle ordinary administration, operational representation and
governance representation for small organizations. Each component remains an
explicit permission; the title administrator grants no additional power.
Protected representative sets, their role definitions, controller recovery and
privileged automation require the resulting authority ceiling at mutation time.
An ordinary roster administrator cannot acquire stronger rights by adding
themselves to such a set or changing its parent.

The first institutional grant API profile is `work.create` from one admitted
Agent to another at `work:create:root`. `GET /v1/access/grants` keyset-pages the
selected issuer's grants in stable UUID order, at most 50 per page, and returns
the current scope authority epoch and an explicit next cursor.
`GET /v1/access/grants/{grantId}` reads one current or revoked grant with its object
generation. `POST /v1/access/grant-changes` creates or revokes one grant under
an expected authority epoch; revocation also requires the grant's generation.
An `access:grant` Account bearer must represent the selected issuer Agent for
`access.grant.assign.work.create`. The Agent must hold that exact assignment
grant, and creation's validity cannot outlive its ceiling. A recipient must be
an active admitted Agent. The Access owner stores the actual assigning principal
privately while the durable grant retains the issuer Agent; a later qualified
representative may exercise that Agent's separate assignment authority after
the original operator departs. Grant use, assignment and representation remain
independent. Create/revoke advance the scope authority epoch, and an immutable
principal/key/intent receipt returns the original result for an exact retry.
The API does not expose private principal IDs. It has no wildcard action or
implicit ability to assign authority-management permissions. The explicit
assignment check follows the same escalation concern described for role
bindings in [Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#privilege-escalation-prevention-and-bootstrapping);
the work.create ceiling and institutional lifetime here are REZICS rules.
General role revisions, protected permissions, mandate creation and dependent
delegation remain separate work.

## Representation and request evaluation

Representation authorizes exercising an Agent's rights within explicit action,
resource, time and redelegation bounds. Evaluate a complete selected path from the
authenticated principal to that Agent, then the Agent's rights on the target.
Do not pool unrelated direct account rights with represented rights. Credential,
consent, installation and API scopes further narrow the decision; they never add
missing domain rights. Hard actor/resource enforcement remains conjunctive.

Administration is not transitively closed. If principal P can represent A for
member administration on B and B granted A that operation, P can perform it as A
without a personal administrator assignment on B. Merely being A's member,
profile editor or administrator does not supply representation. Managing B does
not permit exercising B's rights on C; that requires an admitted representation
path to B for the final operation, with all path limits satisfied.

Using an existing representation chain and creating a delegation are separate
operations. The former validates composition/use limits; the latter additionally
requires assignment/redelegation authority. Initially reject representation cycles
within the admitted composition domain and require an independent authority root.
Mutual ordinary administration grants do not by themselves create representation.

The first ordinary representation API profile is one Agent's `work.create`
mandate for one authenticated recipient. `POST /v1/me/representation-requests`
requires the recipient's `access:represent` Account scope and records an immutable
15-minute, single-purpose request handle and desired mandate validity. Access
creates a private principal only from that verified assertion; the request
response exposes neither Account subject nor principal ID. A manager with an
`access:representation-manage` Account scope, current representation of that
Agent for `access.representation.manage`, and its current management grant can
read the handle through `GET /v1/access/representation-requests/{requestId}`.
The manager receives the handle from the recipient through an appropriate
channel; the API does not turn request discovery into a private account roster.

`POST /v1/access/representation-changes` accepts a pending request or revokes
an existing `work.create` mandate. Acceptance additionally requires the issuer
Agent's `access.representation.assign.work.create` ceiling through the requested
validity, a current active recipient principal, and an expected scope authority
epoch. The requested mandate expires within 30 days in this first profile; the
request to accept it expires in 15 minutes. Revocation requires the mandate's
object generation. Both changes advance the scope authority epoch and retain an
immutable principal/key/intent receipt.
`GET /v1/access/representations/{representationId}` returns mandate state and the
request handle to an authorized manager, without the private recipient identity.
Request handles are single-use; an exact authorized replay returns the original
result. A replacement request creates a new mandate identity, so an old admission
cannot borrow it after its saved mandate is revoked. Protected representation,
recipient self-revocation, broader actions, invitation identity proof and
representation composition remain pending.

For a command with several permission obligations, each may have its own complete
valid proof in the selected acting context. Do not construct one obligation's
authority from incompatible identities, scopes or partial paths. Preserve
independent valid sources when one proof is revoked.

An institutional grantee can use an approved representative policy whose current
eligible roster changes without reapproval by every grantor. Pin its permitted
policy/role ceiling; widening it requires the relevant grantor/approval authority.
Sensitive grants may instead require named representatives or fresh independent
approval. Intermediate dependencies remain live, and original-principal
restrictions cannot be bypassed by changing acting identity.

Record a private decision/audit link to principal, selected subject, attribution,
client, path, policy generation and operation. Public output contains only admitted
Agent and contribution information. API recipients use audience/purpose-scoped
handles where needed; raw private principal IDs and controller lists stay private.

## Durable assignments, dependent delegation and revocation

An institutional assignment may survive the issuing operator's departure. An
explicitly dependent delegation follows its parent/admission liveness. Record
this distinction at grant creation; do not revoke every assignment by walking
an issuer's historical actions. Conversely, dependent authority cannot survive
a revoked parent simply because its token is valid.

Revocation advances an authoritative fence before bounded cleanup. Sensitive
operations use stop-admission/drain/cancel semantics from [commands](commands.md).
Access checks after the effective fence must deny; earlier admitted requests have
an explicit finite validity boundary. Neither event delivery nor JWT expiry alone
proves immediate revocation. Historical content always uses current disclosure.

## Recovery and lifecycle

Owner continuity, last-controller removal, account takeover and replacement
recovery require operation-specific proof and independent approval. A cycle of
controllers is not an independent recovery path. Preserve original authority paths
and decisions; replacement recovery is a new explicit procedure, not a mutation
of past proof. Credential erasure is bounded and fences the principal immediately.
Account erasure does not automatically delete shared Agents or their content.
Before removing credentials, Account requires Access to fence any existing
principal and requires the independent relay to retain both the Access intent
when present and the deleted Account subject. A missing relay prevents deletion;
a retained subject with a still-present Account user requires retry or recovery
reconciliation. Restore keeps admission held if a retained deleted subject
reappears in Account, including one that never had an Access principal.

## API contracts

Provide context selection, check/bulk-check, role/group/binding management,
impact preview, membership admission, representation, revocation and recovery.
Selectors and rosters have purpose-scoped disclosure, deterministic keysets,
bounded expansion and typed stale/denied/unavailable outcomes. Preview/impact
results bind expected generations and never grant permission by themselves.

Context discovery can return opaque, purpose-bound proof handles. Users select
an acting identity and task; the server resolves and revalidates the proof.
Handles retain dependency identities/revisions and never substitute for current
authority. Bound depth, distinct evaluation states, database work, time and total
bulk work; an unresolved budget-limited decision is unavailable, not an allow or
a definitive absence of rights. Supported profiles require admission validation
and qualified migration before their operational limits are lowered.

The first private context profile covers `work.create` at `work:create:root`.
Account verifies the current `work:create` assertion. Access discovery returns
represented Agents in `contexts` and direct-principal public attribution Agents in
`directContexts`, at most 50 complete choices in total, or reports unavailable if
the bound is exceeded. A direct choice requires both an active grant to the
authenticated principal for this action/scope and an independent principal-to-Agent
attribution authorization. It does not use that Agent's representation or grant.
Discovery includes no principal IDs or controller roster. The client supplies
the public `actingSubject`, `authorityPath` (`represented-agent` or
`direct-principal`) and discovered scope epoch to a separate check. Omitted
`authorityPath` means `represented-agent` for existing clients. `GET /v1/me/acting-contexts`
requires `task=work.create`; `POST /v1/me/acting-context-checks` carries the
selected `actingSubject`, optional `authorityPath` and `expectedAuthorityEpoch`.
A changed epoch is stale; the check denies a missing complete path or a closed dispatch fence, and discovery
returns no contexts for a closed fence. Neither response saves a default or
authorizes a later command; the check returns `decision: eligible-now` and
`reusable: false`, without a proof handle. It evaluates the selected path in one
Access snapshot, and command admission revalidates the explicitly supplied
path, including its selected authority mode. `POST /v1/works` accepts the same
optional `authorityPath` and records it with the Access admission. A direct
admission rechecks its bound principal grant, public attribution, Agent generation
and principal enforcement epoch before claim. Claims in either mode reject a saved
scope authority epoch after closure or reopening;
the direct grant cannot satisfy an explicit represented-Agent selection, and an
Agent grant cannot supply missing direct principal authority. The existing
web-wide identity cookie still requires a tab-local client flow in W1, so this
API slice does not complete IAM01 or general task discovery.

For this `work.create` profile, let `N` be Access authority rows, `d_r` the
principal's represented Agent rows, `d_a` its direct attribution rows, and `k`
the returned choices (`k ≤ 50`). The selected direct check adds two indexed
Access probes, one for the principal grant and one for attribution plus the
Agent, after the shared gate/principal reads. Direct command registration repeats
those two probes and claim adds one joined proof recheck. Absent and denied paths
perform no candidate refill; stale scope checks stop before proof reads. Each
probe is expected to cost `O(log N + 1)` with the active lookup indexes in
migration `012_direct_principal_work_create.sql`; lock scope is the selected
proof rows, and extra response memory/bytes are `O(1)`. A retried registration
rechecks the proof before returning its idempotent receipt. Cold-cache I/O,
contention and the full Account/Access/Main call total remain to be measured.

The selected represented `work.create` admission makes two indexed proof reads
after the shared gate, principal and Agent reads: one mandate plus Agent row and
one direct Agent grant. If the direct grant is absent, it adds the bounded group
proof below. Claim checks the saved mandate and Agent generations, then the
saved direct grant or saved group path; an idempotent retry checks the same saved
path. The direct path has a fixed number of Access SQL calls and selected rows,
expected `O(log N + 1)` per indexed probe, with `O(1)` application memory and
receipt size. The IAM33 owner fixture exercises changed generations, expiry and
alternate valid paths; query plans, cold-cache I/O and contention remain open.

Discovery makes two fixed selection queries and returns at most 51 candidates
per mode before rejecting a combined count above 50. Its application response
uses `O(k)` memory/bytes and never returns a truncated complete list. The
current `DISTINCT`/ordered SQL can still inspect or sort up to `d_r + d_a`
eligible rows; under the declared indexes its worst owner work includes
`O(d_r log d_r + d_a log d_a)` ordering and indexed grant checks. The 50/51
real-owner IAM04 case verifies the output bound and explicit unavailable result;
SQL plan/operator growth under high degree, cold cache, and the composed route
budget remain unqualified cost checks. This limit is a request work ceiling,
not a limit on how many Agents may exist.

For a represented `work.create` selection, a current same-scope group proof
may supply the Agent's grant. Access stores its selected member/grant identities
and scope group generation in the command admission; claim rejects a changed
generation or lost selected path. Direct-principal selection never borrows a
group grant. `GET /v1/access/group-scope?issuerSubject=...` returns the current
scope generation and bounded group, active-member and unexpired-grant state with
their object generations to an authorized manager. `POST /v1/access/group-changes`
accepts `work-create-group-change-v1`, an `Idempotency-Key`, and the expected
scope generation. Its six actions create a group, reparent an empty subtree, add
an Agent member, grant `work.create`, revoke a member or revoke a grant. Reparent
also requires the group's object generation; revocations require the target's
object generation. Both routes require an Account bearer with `access:manage`,
active principal representation of the selected issuer Agent for
`access.group.manage`, and that Agent's current management grant. Assignment
additions also require its `access.group.assign.work.create` ceiling; grant
validity cannot outlive that ceiling. Recovery or scope closure denies the
operations. The change and immutable principal/key/digest receipt commit in
one Access transaction under the scope gate. An exact authorized replay returns
its original generation, including after a granted lifetime ends; another
intent with the key conflicts. These routes do not expose a selected user's
private group proof. Populated reparent remains denied pending independent
impact approval; general roles and grants remain pending.

For a populated reparent, `POST /v1/access/group-impact-proposals` records an
immutable 15-minute preview under the current scope and group object generations.
It names the number of distinct currently affected member Agents and the grant
IDs that may be gained or lost through old/new ancestors. This is a potential
path impact, not a claim that every affected Agent's final effective permission
changes: another independent path can still authorize that Agent. The preview's
digest binds the exact active membership rows, ancestor grants and grant expiry
times without disclosing the roster. An `access:approve` bearer with a current
`access.group.approve` representation and grant can read the proposal through
`GET /v1/access/group-impact-proposals/{proposalId}`. The read marks an expired
or generation-changed proposal stale and an applied one activated.

`POST /v1/access/group-impact-approvals` applies a proposal only for an approver
whose principal and issuer Agent both differ from the manager's. It rechecks the
manager's current representation/grant, the approver's current approval path,
the preview digest and both expected generations under the Access scope lock.
Potentially gained `work.create` grants must fit the manager's assignment ceiling
and the approver's separate `access.group.approve.work.create` ceiling through
their full validity. A stale, expired, over-ceiling or self-approved proposal
does not change topology. Approval and the reparent commit in one transaction
with an immutable activation receipt; principal-scoped idempotency keys bind both
proposal and approval intents. This same-scope work.create profile is only one
part of the general role/binding impact policy. It follows the separation-of-duty
principle in [NIST AC-5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final);
the exact two-actor and ceiling rules here are REZICS design choices. The scope
row's transaction lock follows [PostgreSQL's consistency guidance](https://www.postgresql.org/docs/18/applevel-consistency.html);
real concurrent owner tests remain the evidence for this composition.

The first group profile caps a scope at 256 groups, 1,024 active memberships,
16 direct memberships per Agent, 256 active grants and 32 parent edges. With
these admission preconditions, one `groupWorkCreateProof` uses three Access SQL
reads and expands at most `16 × 33 = 528` path rows; its recursive evaluation
and sort are `O(R log R)` for `R ≤ 528`, with `O(R)` transient engine memory and
constant response bytes. A selected claim adds one more recursive read after
rechecking the original proof, so a revoked or stale path cannot be replaced
silently. Absent membership stops after the first read; over-limit or cyclic
paths return unavailable. An authorized mutation holds the scope gate row,
makes a fixed number of owner calls, and may count or inspect up to the scoped
group/membership limits before one row change and one generation bump. Index
plans, cold-cache work, lock contention and accumulated inactive history remain
unverified; the IAM36 real-owner test checks the 32-edge boundary and stale
selected proof, not those physical costs.

The group-state read holds the recovery and scope gates in one transaction and
uses three ordered, capped owner reads after fixed authorization checks. It
returns at most 256 groups, 1,024 active members and 256 unexpired active grants;
its response bytes and application memory are `O(G + M + A)` within those caps.
Change responses are constant size. Mutations serialize on one scope row and
perform a fixed number of owner calls, with count scans over at most the admitted
active rows and topology walks over at most 256 groups. The real IAM05/IAM36 API
test checks a bounded state read on a small varied fixture, stale/concurrent generations,
receipt replay and selected-proof invalidation. Physical index plans, inactive
history growth and cold-cache work remain unqualified.

Impact staging and activation each take a fixed number of indexed owner calls
under the one-scope lock. The supported profile first limits topology to 256
groups, then visits at most 256 subtree groups, 1,024 active membership rows and
256 active grants. Two ancestor paths have at most 32 edges each. Digest and
preview memory are `O(G + M + A)` under those caps, while the response carries
at most 256 distinct gained/lost grant IDs and constant other fields. The immutable proposal and
activation inserts/readbacks use primary and principal/key indexes; their
expected lookup cost grows with retained history `h` as `O(log h)` under those
indexes. Lock contention, exact PostgreSQL plans, inactive history and cold-cache
work remain physical cost checks. A stage with no active member uses the ordinary
empty-reparent command; over-cap or cyclic topology fails unavailable.

An institutional grant write locks one scope gate row, checks one indexed
principal/representation path and assignment ceiling, one exact recipient or
grant row, then writes at most one grant row, one authority-epoch bump and one
immutable receipt. The response is constant size; exact retry checks a
principal/key index and does not repeat the effect. The scoped read uses an
issuer/UUID index and fetches at most 51 rows to emit 50 plus a continuation
cursor; under that index its expected work is `O(log h + k)` for retained grant
history `h` and `k ≤ 51`, with `O(k)` bytes and memory. Exact grant read is
`O(log h)` under the primary key. Denied, stale and absent paths stop after a
fixed number of indexed checks. Global scope-row contention, cold cache, exact
plans and write amplification remain unmeasured; the IAM13/IAM14 real owner
fixture checks a 50/51 page, concurrent CAS, institutional continuity and
revocation, not physical throughput.

Representation requests and changes use fixed indexed principal, subject,
mandate, request and receipt lookups under the scope gate. One request inserts
one private principal only when absent and one immutable request; one acceptance
inserts one mandate and receipt and advances one epoch. Results have constant
size, with no Account roster or graph expansion. Under the declared unique
indexes, ordinary work is `O(log h)` for retained request/mandate history `h`;
lock contention, exact plans and cold-cache behavior remain unmeasured. The
IAM25/IAM26/IAM33 real owner test covers lost responses, changed key, missing
ceiling, over-lifetime request, selected context, saved admission revocation and
fresh-mandate recovery; it does not qualify protected delegation or high-degree
representation paths.

Discovery visits at most 51 represented candidates and uses one set-based
direct-grant query, one bounded membership query and, when memberships exist,
one recursive group-path query. With the fixed recovery, gate, principal,
preference, represented-candidate and direct-context reads, this is at most nine
Access reads, or 13 SQL calls including begin, two local timeout settings and
commit, regardless of candidate count. The membership response has at
most `51 × 16 + 1 = 817` rows; a complete valid path expansion has at most
`51 × 16 × 33 = 26,928` engine rows and returns at most 51 aggregate subjects.
The app's transient membership memory is `O(k × 16)` and its context response
is `O(k)` for `k ≤ 50`; the engine's recursive work is bounded by the expanded
paths and per-node indexed grant probes. Excess membership or depth is
unavailable, and a 51st candidate is never returned as a complete truncated
list. The IAM36 owner case checks query-call and response ceilings; query plans,
cold-cache work and aggregate grant degree remain open physical cost checks.

`PUT /v1/me/acting-context-preferences/work.create` saves one private, task-scoped
convenience choice with an expected revision and idempotency key. Setting a
non-null Agent requires its complete current representation/grant path; clearing
the choice is allowed while the task gate is closed, but recovery hold denies the
write. A concurrent choice with the same expected revision returns stale. Exact
key replay returns its original receipt, even if a newer preference now exists;
clients read discovery for the current choice. Discovery returns the preference
revision for CAS, and identifies the preferred Agent only while it remains in the
eligible context list. Changing the saved choice never retargets an existing tab,
prepared operation or command. The caller still supplies and rechecks the selected
Agent for each operation.

Access uses PostgreSQL for authoritative private/control state with selective
subject/target/scope indexes and local transactional invariants. Derived evaluation
indexes may accelerate reads only with a qualified freshness/fence protocol.
SpiceDB is an optional implementation assessment, not a substitute for the domain
semantics or a preselected second authoritative grant store.

## Research basis and qualification limits

The [depth, representation and voting study](../research/access-depth-representation-and-voting.md)
records the evidence for typed composition and institutional representation.
Its proposed work-profile numbers and 99% task-coverage target remain unmeasured.
[Votes](votes-and-references.md) owns conserved entitlements and ballot mandates;
access membership and representation do not independently create voting weight.

The current [storage and policy review](../research/access-storage-and-policy.md)
evaluates storage/engine choices under the accepted source-accessible and
no-up-front-payment criterion, object invitation and grant lifecycle,
principal- versus acting-subject Realm exclusions, personal blocking and ordered
rule semantics. It records confirmed requirements, a proposed combining algorithm
and remaining qualification rather than silently equating every rule engine.

[Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
and [SpiceDB consistency](https://authzed.com/docs/spicedb/concepts/consistency)
inform relation-based evaluation and causality. Cross-service command admission,
representation ceilings and recovery still require REZICS tests. See
[identity acceptance](../testing/identity-and-access.md).

[Authorization bridge](../implementation/authorization-bridge.md) defines the
Access-to-Jena query, publication and revocation integration.
