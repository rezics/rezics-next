# Identity, representation and authorization

## Identity and service boundaries

Account owns private principals, authentication, credentials and recovery; workload
principals need no public persona.
Main owns public Agents, including Person, Organization and Service descriptions;
Access owns effective representation and grants. Cataloging a Person or Organization
establishes neither control nor a private account. Representation is many-to-many;
public APIs must not expose an account directory.

Authenticated principal, authority subject, public attribution and client application
serve different purposes. A preference proposes a subject; it grants no rights.
Protected commands carry that subject for Access to recheck at admission and claim.
Changing a default cannot retarget prepared operations or consent.

### Acting identity layers

The session Agent is the signed-in identity. The private main-Agent preference
initializes a new session; neither choice changes other sessions or prepared work.
A workspace such as Studio may select its own Agent without changing the session.

For a new operation, resolve an eligible Agent in this order: explicit request,
workspace Agent, exact task-and-profile default, task-only default, session Agent.
Ineligible candidates fall through; show the resolved Agent before submission.
No layer grants authority or changes an existing tab, workspace or command.

## Subjects, scopes and groups

Grantees are typed private principals, admitted Agents or eligible member sets.
A member set is not an acting identity. Membership, Realm participation, resource
containment, administration, representation and descriptive links confer no other
relation by implication. Org operational membership, Agent Realm participation and
independent Organization-to-Realm participation use separate admissions. An Agent
grant needs a representative; a member-set grant needs a qualifying member. See
the [Realm participation contract](realm-participation.md).

The [shared semantic Context contract](context.md#shared-adoption-access-and-revision)
uses resource scopes and grants; interpretation selection grants no representation.
Reading, editing, publishing, grant management and consumer selection need separate
authority. Context-specific selection, version and private-disclosure operations
still need owner contracts and tests.

## Representation and grantability

Access evaluates a complete selected principal-to-Agent path and its target right
in one current decision. Direct-principal authority is separate; paths cannot be
pooled. Credentials, consent, installation, assignment ceilings and hard actor or
resource restrictions narrow authority. Use, assignment, editing and redelegation
are separate permissions; unknown future permissions receive no wildcard grant.

Institutional assignments may survive an operator's departure; dependent grants
follow their exact upstream episode. Revocation fences new admission before bounded
cleanup; admitted work has a finite drain or cancellation boundary. Public results
expose Agents and contributions, never principal IDs or controller rosters. Access
uses private PostgreSQL state; cached allowances need qualified freshness.

Implemented `work.create` profiles live in `services/main/src/modules/access/`
types, schema, routes and IAM tests. Discovery and preflight cannot authorize
later commands. The [placement study](../research/access-storage-and-policy.md)
explains Access's placement inside Main.

## Pending profiles and qualification

- Session-Agent read/switch and `work.create`/`native-book` profile preferences need
  operations and client flows. Preferences require eligibility, revision/idempotency
  checks and the layer order above; unknown profiles are rejected.
- General permission families, protected representation and dependent delegation
  beyond installed profiles need explicit owner contracts, ceilings and approval.
  Existing `work.create` operations do not imply these broader powers.
- Shared Context authority needs private selection preferences, independent edit
  and Realm-adoption grants, revision conflicts and nondisclosing unavailable results.
- Physical plans, cold cache, history growth and high-contention capacity remain
  unqualified beyond IAM fixtures. The [depth/representation study](../research/access-depth-representation-and-voting.md)
  retains unmeasured work-profile and task-coverage proposals.

[Votes](votes-and-references.md) owns conserved entitlements;
representation creates no voting weight. See the
[authorization bridge](../implementation/authorization-bridge.md) and
[identity acceptance](../testing/identity-and-access.md) for integration and evidence.
