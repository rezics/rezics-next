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
admission rechecks its bound principal grant, public attribution and generations
before claim;
the direct grant cannot satisfy an explicit represented-Agent selection, and an
Agent grant cannot supply missing direct principal authority. The existing
web-wide identity cookie still requires a tab-local client flow in W1, so this
API slice does not complete IAM01 or general task discovery.

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
