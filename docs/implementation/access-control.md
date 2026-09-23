# Access implementation plan

Use **native PostgreSQL 18 for private Access authority state and a typed TypeScript
Access module in Main**. Keep Jena as the content/interaction graph. Do not add
Redis, a PostgreSQL platform wrapper, or a separate authorization engine as a
first-release dependency. Keep the storage/query boundary explicit so a specialized
evaluation path can be introduced if a measured workload justifies it.

This is the recommended implementation plan from the
[comparative research](../research/access-storage-and-policy.md), including executed
PostgreSQL, Fluree, SpiceDB/PostgreSQL and OpenFGA/PostgreSQL probes.
Those are historical comparisons and do not qualify the new Jena bridge. This plan
specifies what to build and qualify; it does not claim the production Access system exists.

## Why this combination

- Access owns more than reachability: invitations, object representation, roles,
  grantability, independent approvals, revocation, recovery, receipts and outbox.
  A local PostgreSQL transaction can change its own records and fence together.
- Ordered rules are product semantics. The tested engines can provide useful
  relationship predicates, but an array of their native policies/checks is not
  automatically our ordered, coherent decision. Main keeps the typed policy
  compiler/combiner independent of the store.
- PostgreSQL repeatable-read input loading gives one coherent local authority
  snapshot. The selected Fuseki graph remains a separate transaction boundary.
  Main admission must protect current authority across graph reads/writes;
  TDB2 does not run the prior engine's policy machinery.
- SpiceDB remains a credible future evaluator: its tested PostgreSQL-backed bulk
  checks were coherent in the bounded probe and efficient for repeated graph
  subproblems. An extra RPC alone is not a reason to reject it. Its benefit must
  outweigh introducing another authority/workflow integration boundary.

Do not mirror independently writable grants into both PostgreSQL and another
engine. A future derived evaluator needs a versioned projection and freshness
protocol, or an explicit transfer of authority; it is not a second grant registry.

## Main module boundary

```text
services/main/src/modules/access/
  subjects/          verified authority roots and principal admission
  representation/    selected paths, ceilings and lifecycle
  membership/        effective typed member sets
  grants/            assignments, delegation and grantability
  policy/            typed conditions, compilation and ordered decisions
  admission/         current fences and admitted-operation lifecycle
  query/             bounded decision frames and bulk scope checks
  storage/           PostgreSQL transactions and parameterized queries
```

These name responsibilities rather than require empty packages. Other Main modules
call `authorize`, `authorize_many` and owning mutation commands through typed
interfaces. External workers/runtime processes use admitted Main commands or a
protected decision adapter. Clients do not get raw Access database or engine APIs.

Account remains the authentication owner. Main/Access verifies its assertions and
enforcement freshness; private Account tables are not an undocumented join surface.
Account and Access can share a physical PostgreSQL server while retaining separate
credentials, schemas/migrations and data ownership.

## Rights belong to admitted subjects

An authenticated principal, selected acting subject, grant issuer, grant recipient
and public attribution are separate fields. Any resource type can have an admitted
authority-subject capability when its identity, control and lifecycle contract
supports it. Authors and organizations are initial examples. A metadata edit,
name match or semantic relationship does not establish control.

Grants stay attached to the recipient subject. An authorized principal accepts an
invitation or issues a grant **as** that subject, with its own identity and proof
recorded privately. Pending invitations to unclaimed authors do not authenticate
anyone; verified control and acceptance are separate transitions.

Every grant operation verifies the assigning subject's grantable ceiling, the
selected representative's authority to perform that operation, scope, role/profile
revision, consent and required approvals. Use, assign, redelegate, represent and
change policy are distinct powers. No union of unrelated identities or partial
paths can manufacture a stronger proof.

Institutional assignments and dependent delegations have separate lifetime modes.
An assignment can survive its issuing operator's departure; a dependent delegation
is usable only while its recorded parent and required admissions remain eligible.
Record grant instances separately even when they contribute the same effective
permission, so removing one source preserves another independent source.

Implement the [typed composition contract](../contracts/identity-and-access.md):
membership, resource inheritance, administration and representation are distinct
relations. Recipient selectors distinguish an institutional subject from its
eligible member set. Managing one organization does not recursively expose that
organization's rights. A multi-permission command can use several complete proofs
in its admitted acting context without combining incompatible partial paths.

Admit institutional representative policies with versioned ceilings and protected
sets. Ordinary changes inside an approved roster policy need no fresh approval
from every external grantor; widening the policy does. Apply authority-impact
checks to roster/role edits, reparenting, recovery and privileged installations.
Reject representation cycles in the admitted composition domain independently of
descriptive organization links and ordinary mutual administration.

## Private records and transactions

The initial logical records are:

| Record | Required content |
| --- | --- |
| Authority subject / principal admission | Typed local identity, verified owner reference, lifecycle and enforcement state. |
| Representation grant | Representative, represented subject, scoped actions/ceilings, validity, dependency and revision. |
| Representative policy / protected set | Approved policy/role ceiling, current eligible admissions, applicable grantor approval basis and generation. |
| Prepared context / proof handle | Audience, principal/actor/operation limits, selected proof dependency identities/revisions, expiry and supported evaluation profile. |
| Effective membership | Member-set and typed subject, admission generation, consent/lifecycle and validity. |
| Role definition and binding / grant | Versioned permissions, issuer and recipient selector, resource scope, grantability, lifetime and expected revision. |
| Policy bundle and ordered rules | Owning scope, mandatory constraints, ordered decisions, typed condition IR, compiler/profile version and approval basis. |
| Fence / admission state | Current authority generations and the declared admitted-work/revocation boundary. |
| Operation receipt, audit and outbox | Idempotency key/digest, actual principal, acting/issuer subject, exact result and committed effects. |

Use indexed keys for subject/scope/action, member-set/subject and explicit parent
grant identities. Enforce local uniqueness and references. References to Jena
objects require verified registration/lifecycle protocols, not imaginary SQL
foreign keys. Keep public graph identities separate from private controller IDs.

An accepted local mutation atomically writes its state, revision/fence, receipt,
audit link and outbox intent. Stage large membership/role changes and activate a
validated generation. Serialize or otherwise qualify conflicting topology changes;
a recursive query's cycle detection alone does not prevent two concurrent writes
from creating a cycle. Grant activation revalidates its complete parent ceiling
and approval revisions under the relevant transactional protection.

## Ordered policies and joint wiki governance

A joint wiki has one explicit governing scope and admitted maintainer/approval
contract. It does not inherit an arbitrary concatenation of each participating
Realm's policies. Scope inheritance identifies mandatory parent constraints and
which decisions the child is allowed to override.

Evaluation has two distinct parts:

1. Mandatory guards: verified principal, admitted representation, credential and
   installation ceilings, hard enforcement and required parent constraints.
2. The scope's versioned **first-applicable** rule list. Each rule has a stable ID,
   action/scope match, typed condition and allow/deny effect. No match defaults to
   deny. Reordering changes meaning and therefore needs the same authority and
   impact controls as any permission change.

An explicit exception can precede a Realm exclusion within that editable scope.
It cannot bypass mandatory guards. Unknown required evidence or an unresolved
earlier condition yields unavailable, not a fall-through allow. Internal results
retain allow, deny, not-applicable and indeterminate distinctions; public errors
follow disclosure rules.

Use a closed, extensible condition registry at bootstrap: admitted subject/role,
member-set predicates, scope/action, approved grant/representation and trusted
time/context values, combined with bounded Boolean operators. Validate types,
dependencies, referenced-set visibility and work budgets before publishing a policy.
Do not expose arbitrary SQL, network calls or general graph programs as user rules.

## Realm exclusion and blocking

Membership conditions explicitly select `authenticated_principal` or
`acting_subject`; Boolean expressions can combine both. These operate on typed,
admitted membership sets. The principal mode survives changing author identity;
the actor mode does not infer membership through every object an Account controls.
Neither proves that unrelated Accounts belong to one natural person.

Store a reference to the excluded set, not copies of its roster in every page.
Private sets must be admitted for this policy purpose. Their unavailability is not
proof of non-membership, and policy explanations cannot become a public membership
oracle. A current-membership exclusion and a durable moderation ban remain distinct.
Strict membership-based exclusion requires authentication on the protected surface;
anonymous public copies cannot supply the missing identity evidence.

Personal mute preferences belong to reading/feed selection. Refusing messages,
replies or mentions belongs to those interactions' admission. Resource-access
exclusion belongs to Access. Share safe predicate definitions where appropriate,
but preserve these distinct owners and effects. Matching by publishing Realm,
author membership or publication context is explicit.

## One coherent decision frame

Compile structural rules at policy publication. For a request, verify the selected
principal/actor once, identify relevant scopes/rules, then load all required local
authority inputs in one consistent PostgreSQL transaction snapshot. Reuse these
inputs across the request and across resources sharing the same disclosure scope.
Version compiled-policy caches; start without cross-request cached allowances.

The frame contains the actual principal and acting subject, operation, selected
proof, relevant policy/membership/grant revisions, data freshness and the admitted
validity boundary. Missing data, timeout or budget exhaustion cannot become allow.
A collection of independent booleans observed at different times is not a frame.

Retain per-condition known/unknown outcomes when loading a batch. An unresolved
earlier condition prevents a later allow, while an irrelevant lower-priority
condition does not undo an already decided first-applicable result. Mandatory
guards always remain required. Conditional engine results must not be coerced
to ordinary false, especially inside exclusions.

Do not make one RPC or a full graph walk per rule, result row or protected triple.
Batch indexed membership lookups, validate bounded candidate/selected paths and
share intermediate results. Limits cover candidate paths, depth, rules, rows,
bytes and time; exceeding them reports a typed outcome rather than inventing
permission semantics. Keep the supported condition set small enough to test fully.

Discover eligible contexts through a bounded selector, then validate the chosen
proof at command time. Load named representation/dependent-grant inputs in batches
instead of walking every organization the account could represent. A proof handle
is a hint validated against its bound identity and current lifecycle, conditions
and fences; it cannot be retargeted to a different acting context.

For single-parent groups, test whether a subject's relevant direct membership is
in the granted group or one of its descendants. Walk ancestors from those direct
memberships or use a qualified ancestry index; do not reverse inheritance and
give a parent member the child's additional rights. Avoid expanding the whole
granted population.
Memoize complete evaluation states, including action, target, context, revisions
and relevant remaining limits; visited-subject alone cannot distinguish differently
bounded paths. Preserve ordered-rule and mandatory-guard semantics when cancelling
unneeded subproblems.

Selective ancestry indexes retain authoritative edges, provenance and generation.
Stage/revalidate topology changes and fence invalidated authority before index
cleanup. Multiple supporting paths must survive deletion of only one source.
Validate index freshness or current dependency generations; a stored reachability
bit or successful earlier proof is not sufficient.

The [Access workload owner](../storage/workloads/identity-access-capacity.md)
defines depth, breadth, work, query and mutation qualification. Reject unsupported
policy/topology profiles at activation; exceeding a request budget while its result
is unresolved returns unavailable. Operational limits are versioned and cannot be
lowered in a way that silently changes existing authority. The research's candidate
numbers remain tuning hypotheses.

## Governance integration

Access owns current voting mandates and protected representative policies.
[Votes](../contracts/votes-and-references.md) owns entitlement quantities,
snapshots, allocation plans and ballots in Jena. Do not implement quantities as
recursive member-set grants or materialize one institutional seat per controller.

Authorize the exact cast/change/withdraw, allocation or approved-effect command,
including its expected state and current mandate. Bind the decision to the
Jena operation through the [authorization bridge](authorization-bridge.md).
Freezing a poll's electorate never freezes permission to submit future commands.
Runtime qualification must exercise competing representatives, revoked mandates,
allocation conservation and uncertain cross-store effects.

## Current authority over content and history

Fuseki queries current graph state; Main resolves immutable historical manifests.
Access supplies current authority through the [authorization bridge](authorization-bridge.md). A content
snapshot does not pin authority to that same historical point. The research probe
demonstrates why simply querying old content and old grant data together can retain
revoked access.

Apply protected-scope/value predicates inside the query plan, before matching,
aggregation, ranking and pagination. Do not implement protected lists by fetching
one privileged page and filtering its final results. Ordinary pages can reuse one
scope decision; a heterogeneous search needs a qualified policy lowering or bounded
visibility provider. Reject unsupported query/profile combinations explicitly.

A current decision frame is not a distributed transaction with Jena. Each
protected operation binds its source snapshot, authority, target, expected state
and allowed lifetime. Ordinary admitted work has a finite completion contract.
Strong revocation closes new admission, drains/cancels earlier affected work and
reconciles ambiguous effects before acknowledging its stronger guarantee. Expiry,
an asynchronous invalidation message or a PostgreSQL transaction alone does not
establish that protocol across processes/stores.

## Implementation sequence and release evidence

1. Establish private subject registration, typed authority references, PostgreSQL
   migrations, receipts/outbox and the Main Access interface. Keep the current
   Account boundary and freshness contract explicit.
2. Complete author invitation/acceptance, representation and assignment/delegation
   with grantability, independent-source preservation and rejected/concurrent cases.
3. Add joint-wiki scope policies, both membership bases, ordered exceptions, private
   set admission and separate personal mute/interaction-block behavior.
4. Complete consistent decision-frame loading and the Jena query/write bridge,
   including current authority over historical content, complete lists/search and
   revocation during streaming or an uncertain write.
5. Qualify realistic mixed load, recovery and the elected host deployment. Use the
   research lab to reproduce mechanism questions, not as a substitute for production
   data shapes, authentication, concurrency, storage and resource measurements.

The [identity acceptance owner](../testing/identity-and-access.md) defines business
cases. Redis and a specialized authorization-engine rollout are not first-release
goals. Reconsider the evaluator only when measured graph/query complexity or an
independent scaling/isolation need justifies its additional consistency protocol.
