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

## Representation and request evaluation

Representation authorizes exercising an Agent's rights within explicit action,
resource, time and redelegation bounds. Evaluate a complete selected path from the
authenticated principal to that Agent, then the Agent's rights on the target.
Do not pool unrelated direct account rights with represented rights. Credential,
consent, installation and API scopes further narrow the decision; they never add
missing domain rights. Hard actor/resource enforcement remains conjunctive.

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

## API contracts

Provide context selection, check/bulk-check, role/group/binding management,
impact preview, membership admission, representation, revocation and recovery.
Selectors and rosters have purpose-scoped disclosure, deterministic keysets,
bounded expansion and typed stale/denied/unavailable outcomes. Preview/impact
results bind expected generations and never grant permission by themselves.

Access uses PostgreSQL for authoritative private/control state with selective
subject/target/scope indexes and local transactional invariants. Derived evaluation
indexes may accelerate reads only with a qualified freshness/fence protocol.
SpiceDB is an optional implementation assessment, not a substitute for the domain
semantics or a preselected second authoritative grant store.

## Research basis and qualification limits

[Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
and [SpiceDB consistency](https://authzed.com/docs/spicedb/concepts/consistency)
inform relation-based evaluation and causality. Cross-service command admission,
representation ceilings and recovery still require REZICS tests. See
[identity acceptance](../testing/identity-and-access.md).

[Authorization bridge](../implementation/authorization-bridge.md) defines the
Access-to-Fluree query, publication and revocation integration.
