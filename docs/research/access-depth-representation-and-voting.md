# Access depth, organizational representation and voting authority

Reviewed and core design adopted 2026-09-22. The owning contracts now specify
typed authority composition, institutional representation and conserved voting
entitlements. This document retains their research basis, alternatives and
unresolved performance/coverage qualification. It does not claim runtime acceptance.

The selected design combines typed relationship authorization, scoped representation
and a separate voting-entitlement model. Keep the PostgreSQL authority/Main evaluator
baseline while qualifying its workloads. An organization can hold rights on
another organization, and a person can exercise those rights through an admitted
representation path. Neither organizational membership nor an administrative title
alone establishes that path. Organizational votes belong to the entitled
organization; representatives operate its ballot without multiplying its weight.

The requested **99% coverage is a product target**. There is no measured REZICS
task distribution that establishes this percentage. The design below covers
the common task families, preserves extension points, and defines how to measure
coverage. Security invariants are requirements for every admitted operation,
not a 99% success threshold.

## Present design and evidence boundary

The current [identity/access contract](../contracts/identity-and-access.md)
already separates private principals, public Agents, representation, grants,
grantability and revocation. Groups have a same-scope, single-parent hierarchy.
The [implementation plan](../implementation/access-control.md) selects a bounded
Main evaluator with private PostgreSQL state. These are design documents in this
repository, not evidence of a deployed implementation.

The [previous backend review](access-storage-and-policy.md) tested linear
representation chains and several decision-snapshot counterexamples. It did not
establish organizational sovereignty, transitive administrative meaning,
vote-weight conservation, realistic branching or production capacity.
The [vote contract](../contracts/votes-and-references.md) now extends counting
identity and idempotent ballot mutations with institutional seats, their
representatives and conserved allocation. Those semantics still need runtime
qualification independently of the earlier probes.

This review reads primary papers, official product documentation, source code
and published operator reports. The analytical examples below are deductions
from the selected model. No new engine benchmark or runtime acceptance test was
executed for this review.

## What research and production systems actually establish

### Academic mechanisms and counterevidence

| Source | Finding relevant to this decision | Applicability limit |
| --- | --- | --- |
| Li and Mitchell, [RT: A Role-based Trust-management Framework](https://www.cs.purdue.edu/homes/ninghui/papers/rt_discex03.pdf), 2003, sections 3–4 | Locally owned roles, role inclusion, linked roles and intersections express cooperation between autonomous organizations. Selective role activation and joint-principal roles distinguish acting under a capacity from merely possessing other rights. | A formal mechanism and research implementations, not a REZICS performance result. Its monotonic foundation does not directly supply our ordered deny rules. |
| Ellison et al., [SPKI Certificate Theory, RFC 2693](https://www.rfc-editor.org/rfc/rfc2693.html), 1999, sections 4 and 6 | Delegation carries explicit propagation and intersected authorization/validity. Section 4.1 rejects treating a fixed integer delegation depth as sufficient control: depth does not constrain width and legitimate chains can need an extra intermediary. | Experimental RFC, not an Internet standard. We borrow reasoning about authority, not its certificate format or every policy choice. |
| Birgisson et al., [Macaroons](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/), NDSS 2014 | Delegated credentials can be attenuated by context, action and other caveats. | Cryptographic attenuation does not itself implement immediate revocation, organizational control or the proposed voting ledger. No recommendation to replace sessions with bearer macaroons. |
| Kahng, Mackenzie and Procaccia, [Liquid Democracy: An Algorithmic Perspective](https://ojs.aaai.org/index.php/AAAI/article/download/11468/11327), AAAI 2018 | In their binary truth-tracking model, local delegation mechanisms cannot guarantee both positive improvement and no harm, even when delegation goes to more competent neighbors. Concentrated delegated votes create correlated outcomes. | A result under stated competence and graph assumptions; not a theorem that every real delegation system fails. |
| Gölz et al., [The Fluid Mechanics of Liquid Democracy](https://arxiv.org/abs/1808.01906), 2018 | Studies limiting concentration by selecting among multiple possible delegates; choosing vote routes is a substantive allocation problem. | Theoretical and simulated evidence does not select REZICS's constitution or default voting mode. |
| Kling et al., [Voting Behaviour and Power in Online Democracy](https://arxiv.org/abs/1503.07723), ICWSM 2015 | Observations from the Pirate Party's LiquidFeedback deployment found highly influential voters, but their observed votes often aligned with the majority and had a stabilizing effect. | A historical deployment study, not a universal fairness guarantee. It is counterevidence to declaring all concentrated delegation harmful. The proceedings website's later upload date is not the study year. |

The design inference is that authorization and collective decision making need
different algebra. An access check usually asks whether a complete valid proof
exists. Weighted voting asks how much independently issued entitlement is counted,
where it came from, and whether any unit has already been used.

### Production implementations and published operational experience

| System / source | Actual approach | Lesson for REZICS |
| --- | --- | --- |
| Google, [Zanzibar, USENIX ATC 2019](https://www.usenix.org/system/files/atc19-pang.pdf), sections 3.2 and 4 | Relationship evaluation uses concurrent subproblems, pooled reads, caching and cancellation. Selected deep/wide group workloads use Leopard membership indexes. A tuple update can generate tens of thousands of index events. Table 2 reports Safe Check p95 9.46 ms and Recent Check p95 60.0 ms in its historical deployment. | Depth is real work; indexing moves some work to updates. Freshness requirements materially change cost. Google's scale and infrastructure do not predict our latency. |
| [SpiceDB recursion and depth limits](https://authzed.com/docs/spicedb/modeling/recursion-and-max-depth), retrieved 2026-09-22 | A default traversal limit of 50 bounds recursive evaluation; excessive traversal returns an error. | Engine traversal depth is not the number of visible organizations. An operational guard is not a business rule that permits 49 delegations. |
| [OpenFGA production guidance](https://openfga.dev/docs/best-practices/running-in-production), retrieved 2026-09-22 | Separate resolution-depth, in-flight breadth, database-read concurrency and list-result controls. Caching trades freshness for latency. | Limit total work as well as the critical path; isolate expensive lists from ordinary checks. In-flight breadth is a concurrency limit, not a total graph-size bound. |
| [Agicap operator case study](https://openfga.dev/docs/adopters/agicap), retrieved 2026-09-22 | The published CNCF-interview-based account reports an application facade around OpenFGA and a move from deeper to flatter authorization models to improve latency and scalability. | Even with a specialized engine, production teams simplify the authorization model and retain application admission rules. The published account does not quantify the depth/latency curve. |
| [Read AI operator case study](https://openfga.dev/docs/adopters/read-ai), retrieved 2026-09-22 | The project-published interview account reports PostgreSQL, OpenFGA v1.8.16, about 5.3 billion tuples, 5,200 peak RPS and 20 ms p99. | Substantial relation volume can be practical on PostgreSQL plus an evaluator. Reported topology, hardware and consistency detail is insufficient to use these figures as a REZICS benchmark. |
| [Google Cloud resource hierarchy](https://docs.cloud.google.com/iam/docs/resource-hierarchy-access-control) | Child resources inherit parent allow policies in the declared resource hierarchy. | Inheritance is useful inside an explicit authority boundary. It does not establish that every semantic Organization relationship must inherit rights. |
| [GitHub nested teams](https://docs.github.com/en/organizations/organizing-members-into-teams/about-teams) | A child team has one parent and inherits its repository permissions; child members are not direct parent-team members. | Effective member sets, direct membership and public organizational structure are distinct. This closely fits the existing single-parent group baseline. |
| AWS, [cross-account evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic-cross-account.html) and [AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html) | Cross-account access requires permission/trust on the relevant sides. Assuming a role separates who may assume it from what the role may do; session policies narrow its permissions. | A useful precedent for an explicit representation boundary. Our continuously bounded representation path is a REZICS rule, not a claim that AWS intersects every earlier role's resource permissions across arbitrary role chains. |
| AWS, [service control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html) | SCPs limit available permissions and do not independently grant them. | Supervisory restrictions can exist without granting administrators the ability to impersonate every subordinate organization. SCP exceptions and AWS account semantics are not copied wholesale. |
| Kubernetes, [privilege escalation prevention](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#privilege-escalation-prevention-and-bootstrapping) | Role and binding mutation has additional permission checks, including explicit escalate and bind privileges. | Protect the ability to change authorization itself. A writable roster/role can be an indirect route to stronger rights. Kubernetes's exact rules are not the REZICS grantability algorithm. |
| OpenZeppelin, [Votes implementation at v5.4.0](https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v5.4.0/contracts/governance/utils/Votes.sol) | A delegate change moves the account's own voting units; it does not recursively move all votes that other accounts delegated to it. Historical vote checkpoints support past-time counting. | A widely available implementation can deliberately use direct rather than liquid delegation. Source inspection establishes this implementation behavior, not its adoption rate or our deployment choice. |
| Snapshot, [delegation](https://docs.snapshot.box/user-guides/delegation) and [Safe multisig voting](https://docs.snapshot.box/user-guides/using-safe-multi-sig) | Delegation needs an enabled voting strategy. Its documented overriding strategy gives space-specific delegation and then the original voter precedence. Safe integration permits collective signing under one voting identity. | Delegation precedence and institutional signing are explicit product rules. They are not consequences of ordinary administrative access; other strategies may differ. |

There is no universal production rule that an administrator of an administrator
automatically becomes an administrator of everything downstream. The consistent
lesson is to define which relation composes, which scope it covers and which
changes can invalidate it.

## Selected authority vocabulary

Realm, Organization, Team and Person describe different responsibilities; they
are not four mandatory rungs of one security tree. A Realm can host an independent
organization. A team can be a recipient set. A Person can represent several
organizations. An admitted Realm or Team may itself be an authority subject, but
only through the existing verified control/lifecycle capability.

In the examples, P is the authenticated private principal associated with person
p. A public Person record alone never authenticates a request.

| Relation / operation | Meaning | Default composition |
| --- | --- | --- |
| member_of(p, group) | p belongs to an admitted recipient set. | Qualified nested group membership inside one scope; no automatic representation. |
| resource_parent(child, parent) | A declared resource-security hierarchy. | Only registered permission families marked for that hierarchy; stop at an independent authority root. |
| participates_in(org, realm) | The organization participates in a Realm. | Realm-local participation and moderation rules only. |
| manages(subject, target, actions) | The subject can perform named administrative operations on the target. | No rule deriving manages(A,C) from manages(A,B) and manages(B,C). |
| represents(delegate, subject, limits) | The delegate may exercise the subject's rights for specified operations. | Compose only admitted representation edges, retaining and intersecting their limits. |
| may_assign / may_redelegate | Authority to create an assignment or a dependent delegation. | Separately granted; an edit permission does not imply either. |
| voting_entitlement(owner, poll, units) | A holder owns a defined amount of counting power in an electorate. | Conserved across allocation/delegation; never copied through membership. |
| voting_mandate(representative, holder, limits) | Someone may operate an entitled holder's ballot. | No new voting units and no automatic ability to allocate them. |

Semantic links such as parentOrganization, affiliation, creator and sameAs remain
descriptive until admitted into a particular authorization contract. Do not run
an arbitrary property path over the public content graph to establish control.

### Two superficially similar grants with different effects

Granting edit to **Organization A as a subject** lets authorized representatives
edit as A. Granting edit to **A's eligible member set** lets each qualifying member
exercise an individual entitlement to edit under the declared subject model.

The API must distinguish these recipient selectors. An organization with 100
members does not imply 100 representatives, and a single organizational voting
seat does not imply 100 individual voting seats.

## Realm administrators and independent organizations

Use authority ownership and operation scope to answer the question, rather than
whether an object happens to have Organization as its type.

| Requested action by a Realm A administrator | Selected default |
| --- | --- |
| Moderate a post's publication in Realm A, including a post published by an organization | Allowed by the explicit Realm moderation role, within that publication context. |
| Edit content owned by Realm A | Allowed if the role includes the relevant content-edit action and scope. |
| Edit a foreign-owned source merely because it is visible in Realm A | Requires source-owner rights; visibility/adoption does not transfer ownership. |
| Suspend an organization's Realm A participation or change its local placement | Allowed only by the relevant participation/governance permission. |
| Edit the organization's global public description | Follows that content owner's editing policy; it does not establish organizational control. |
| Change the organization's operational roster, representatives or recovery | Requires the organization's admitted authority; not implied by Realm administration. |
| Change other-Realms' content | Requires the relevant owner/context rights. |
| Exercise the organization's vote or identity | Requires a separate voting/representation mandate. |
| Administer an organization deliberately created as Realm-managed | An explicit managed relationship may grant named internal administration powers; representation, voting and external grants still have declared ceilings. |

Offer two organization setup presets:

- **Independent:** participating in a Realm leaves control of the organization
  with its own authority.
- **Managed:** the organization's founding/authorized governance explicitly grants
  a named Realm/parent subject selected administration powers.

Both use the same grant records. Managed status cannot be acquired by moving an
organization into a folder, editing its public metadata, changing a Realm tag or
accepting it into a community. Changing authority ownership is a separate guarded
transition. Suspending one Realm's adoption does not erase global content or
another Realm's legitimately independent publication.

## Person p, Organization A and Organization B

Suppose B grants A permission to manage B's ordinary members. Then:

    P --valid representation for member administration--> A
    A --grant: manage ordinary members of B--------------> B

P can manage those members **acting as A**, despite having no personal
administrator assignment on B. This is an intended use case.

It requires one complete, currently valid proof:

1. P may represent A for this operation, target and context.
2. B's authority granted A that exact operation, with a valid role revision.
3. Representation, grant, credential, client and context restrictions all admit it.
4. Mandatory restrictions and the applicable ordered policy admit it.
5. The actual effect remains inside its command-admission lifetime/fence.

P remains the private operator, A the acting subject and B the target.
Changing public attribution does not change these identities.

For a command requiring several permissions, each obligation may have its own
complete valid grant proof in the admitted acting context. This does not require
every permission to come from one grant record. It forbids constructing one
obligation's authority from incompatible identities, scopes or partial paths.

| Available facts | Can P manage B? |
| --- | --- |
| p is a member of A; A may manage B | No, unless the grant deliberately targets an eligible member set. |
| p may edit A's profile; A may manage B | No. |
| p has an administrative role on A; that role has no representation mandate | No. |
| p may represent A for B's named administration operations; A has those rights | Yes, as A, within their intersection. |
| p may represent A only for publishing; A may manage B | No. |
| p may represent A and B separately, but neither complete path authorizes the requested effect | No; partial paths cannot be combined into a new proof. |
| B grants its administration role directly to A's approved administrator set | Members of that set can use that direct set-based grant; it still does not make them representatives of A or B. |

For a further link, suppose B has rights on C. A's permission to manage B does
not make A entitled to exercise B's rights on C. To do that as B, there must be a
separate admitted representation edge from A to B, and P's path must permit that
composition for the final operation on C:

    P --represents--> A --represents for specified purposes--> B
    B --grant on C------------------------------------------> C

Every representation edge contributes its limits. A publishing-only intermediary
cannot become a membership administrator because a later edge is broader.
Alternative complete proofs may independently authorize the same operation;
revoking one does not destroy another. Retain grant provenance rather than merging
all sources into an untraceable boolean.

**Using an existing representation chain is different from creating a new
delegation.** The former checks composition and use limits on that chain. The
latter additionally checks assignment/redelegation powers. A generic
can_delegate flag must not conflate these operations.

### Institutional trust and administrator presets

When B grants A institutional rights, B can trust A's admitted representative
policy rather than approving each future employee individually. Ordinary roster
changes within that approved policy then need no new B approval. Changes widening
its role/representation ceiling do. For sensitive powers, B can instead require
named representatives, fresh independent approval or a stricter approved policy.

Provide practical role presets: content editor, ordinary organization
administrator, operational representative, governance representative, and
authority custodian. A preset may explicitly bundle administration and operational
representation when that is the intended workflow. The role's registered
permissions establish that behavior; the word administrator does not.

An ordinary roster administrator must not be able to add themselves to a protected
representative set, rewrite its defining role, install a privileged automation or
reset a controller credential and thereby bypass the separation. These mutations
require their resulting authority ceiling and independent approval where declared.
Changing a group parent can also widen access and needs the same impact analysis.

Mutual ordinary administration grants can be legitimate. They do not imply a
representation cycle. Group nesting and dependent-grant ancestry must remain
cycle-free; representation proofs must not use circular authority as their root.
Initially reject cycles in an admitted representation-composition domain and
require an independent root/recovery authority. Descriptive graph cycles in other
relations have no bearing on this check.

### Ordinary user workflow

Small organizations can give their founder a preset that explicitly bundles
ordinary administration, operational representation and governance representation.
Larger organizations can separate those responsibilities. Separating the
underlying permissions does not require users to configure every operation.

Users choose the acting identity and intended task; the server resolves and
validates its proof. They do not construct graph paths or paste proof handles.
Sensitive changes show the represented organization, target, effective powers
and relevant approval requirement. A voting action shows the entitled seat and
weight, with any internal approval requirement. Explanations can show why a
permission applies without exposing private controller directories.

Mandatory restrictions keep the original principal and selected actor distinct.
Changing persona cannot bypass a principal-based exclusion. Relevant intermediate
authority must remain live; an independent valid route through another subject
is not silently revoked merely because one unrelated route became invalid.

## Voting: entitlement, representation and allocation

The phrase voting weight needs an explicit owner and electorate. Distinguish:

- An organization is awarded 100 units in an external electorate.
- The organization awards personal voting units to its members.
- Members have an internal ballot used to decide the organization's external vote.

These are different constitutions. None is inferred from the access hierarchy.
Ordinary access permissions are not percentages. Post authorship, speaking as an
organization, reputation/ranking scores, vote-casting permission and counting
weight also have separate meanings.

### Recommended default: one organizational entitlement

If Organization A has 100 units, its authorized voting representative can cast
A's ballot with those 100 units. The units stay owned by A. There is no automatic
division by the number of members, administrators or representation hops.

If P and Q are both representatives, they operate the **same ballot identity**.
They do not receive 100 units each. A change replaces the previous ballot under
an expected revision; concurrent conflicting changes produce a conflict instead
of two counted ballots. Having three valid authority paths to A still yields one
entitlement.

Use a declared mandate rule:

| Mandate rule | External result |
| --- | --- |
| A designated representative, with replacement/backup authority | One organizational ballot; normal default. |
| Any currently admitted representative | Still one ballot; authorized revisions can replace it before close. |
| k-of-n independent approvers | One exact proposed ballot activates after its approval threshold is satisfied. |
| An internal organizational decision | An exact finalized internal result authorizes the organization's external ballot. |

For k-of-n, bind approvals to poll, choice, entitlement/allocation, weight snapshot,
expected ballot revision and mandate revision. Different choices cannot share
approvals. Multiple accounts/personas do not prove independent human approval;
the electorate's admitted counting/control identity determines that requirement.

An internal 60–40 member vote may, by A's charter, produce one 100-unit external
Yes ballot. Alternatively, a charter may permit a 60/40 external split. These are
explicit aggregation choices, not a recursive multiplication of permissions.

### Optional allocation: split only by explicit governance action

If the electorate permits A to allocate its units, A may assign 40 to a member
seat and 60 to another seat. Allocation is a different permission from casting:
neither an ordinary administrator nor a ballot submitter can invent more units.

For each root entitlement r:

    sum(active leaf allocations for r) <= issued units of r
    sum(counted units derived from r) <= issued units of r

If all 100 units have been allocated to leaves, the parent cannot cast another
100-unit ballot. Partial allocation may leave an explicit residual seat. Store
units as integers in a declared scale or exact rational values; define rounding
and residual ownership and never lose/create units through floating point.

Keep immutable source-entitlement IDs through allocations and delegation. A
diamond of paths reaching the same 40-unit allocation still carries only 40.
Separate issuance roots must themselves satisfy electorate uniqueness, so copying
one admitted voter into two roots cannot manufacture two entitlements.

Allocating a seat to an admitted Person makes that Person its holder; eligible
controllers may cast for the Person under its own mandate. Allocating to a
member-set selector must explicitly mean separate member seats or a collective
seat. A writable membership set is not itself an undefined vote multiplier.

Org A's institutional 100 units and p's independently admitted personal 1 unit may
both count only if that electorate explicitly includes both classes. A
one-person-one-vote electorate does not admit corporate seats as an extra persona.
One-account-one-vote is not a proof of one-natural-person uniqueness.

### Optional proxy voting and full liquid democracy

For ordinary proxy voting, start with **one explicit proxy hop per entitlement**.
The proxy cannot automatically delegate the received units onwards. A holder
override/reclaim operation, when enabled by the charter, updates the same
entitlement's ballot and removes its proxy contribution. It does not add another
ballot. Only an admitted representative of an organizational holder can invoke
that holder's override.

At poll opening, freeze entitlement weights, allocations, counting rules and the
proxy-routing snapshot. Evaluate the current security authority of anyone
submitting/changing a ballot. A revoked proxy cannot make new changes using an
old snapshot. The original holder can reclaim if the frozen charter allows it;
new proxy routes normally apply to the next poll. A live-routing voting mode needs
its own explicit replacement/recount contract and is outside the initial default.

If a community explicitly selects liquid democracy, its rules additionally need
transitive proxy composition, direct-vote precedence, topic-specific overrides,
cycle disposition, concentration policy, abstention/quorum behavior and complete
unit provenance. Compute its routing for a named poll snapshot in bounded jobs;
do not recursively recompute the whole electorate on every vote or Access check.
Initially reject delegation cycles instead of silently choosing a winner or
dropping weight. Full liquid delegation remains an extension requiring its own
governance and scale qualification.

Limiting a delegate's weight changes voting policy; it is not merely an index
optimization. The conflicting theoretical and observational evidence above is
why this is not the default for all organizations.

### Snapshots, current control and effects

Freeze the electorate and weights for a governance poll, while checking current
representation, principal enforcement and admission on every mutation. If a
representative leaves, A retains its seat and a replacement can operate it.
Already admitted ballots do not disappear solely because their operator later
leaves. Invalidation for compromise or misconduct is a separate auditable
governance decision under the frozen charter.

Count quorum using the poll's declared unit: institutional seats, eligible people,
weight or separate constituencies. Signatures are not extra seats. Specify the
treatment of explicit abstention and uncast weight before opening the poll.
Ordinary ratings/reactions can retain a different live-population contract.

A successful vote authorizes an effect only through an admitted governance
capability, for the exact approved proposal and effects. It does not confer
arbitrary administrative power on its voters or execute outside the body's scope.

## Depth and performance

### Count the work actually done

Track at least:

- Resource-hierarchy depth.
- Nested membership depth and the number of memberships relevant to the query.
- Selected representation depth.
- Dependent-grant ancestry depth.
- Compiled policy/subproblem depth, including intersections, exclusions and order.
- Reachable subproblems/edges, database reads, concurrency, result cardinality,
  freshness requirements and invalidation/update fan-out.

These dimensions can combine in one request. One business edge can compile into
several evaluator nodes; an indexed subtree may require little online traversal.
Depth increases worst-case work, but cache/index behavior means it does not
necessarily increase every observed latency monotonically.

For a selected proof with d edges, validating its edge-local conditions is O(d)
logical work, excluding membership/condition subqueries. It need not mean d
sequential network calls: load named dependencies in a consistent batch.

For fixed, plain reachability with deduplication, a traversal is O(Vr + Er) over
the reached subgraph. That graph may nevertheless be large. Enumerating every
proof path is unnecessary and can be exponentially more expensive.

| Structure | Structural work / size, not a latency measurement |
| --- | --- |
| One 16-edge chain | 17 vertices. |
| Complete 4-way tree, depth 4 | 341 vertices. |
| Complete 4-way tree, depth 8 | 87,381 vertices. |
| Complete 4-way tree, depth 16 | 5,726,623,061 vertices. |
| 20 serial diamonds, each with two alternate branches and a merge | 61 vertices and 80 edges, but 1,048,576 distinct complete paths. |

The O(Vr + Er) statement is not a bound for arbitrary policy programs. Conditions,
path limits and Boolean expressions create distinct evaluation states. Memoization
must include action, target, selected context, policy revision and relevant
remaining limits; a global visited(subject) set can incorrectly merge paths with
different authority. A known invalid cycle is not a reason to erase a separate
valid proof. Negative results and earlier ordered deny conditions may need more
work than finding a positive grant.

### Historical depth experiment: no Jena qualification

The retained 2026-09-22 comparison predates the Jena architecture. Fluree is now
retired; all backend labels and measurements below preserve the original run.
No row measures Fuseki/TDB2 or current Access-to-Jena command enforcement.

The retained [depth probe](../../scripts/research/access_backend_comparison/expanded.py)
performed 15 repeated positive checks at each depth with reused clients.
Its [recorded results](../../scripts/research/access_backend_comparison/evidence/2026-09-22/expanded-original-query.json)
contain these medians in milliseconds:

| Backend path | Depth 1 | Depth 4 | Depth 8 | Depth 16 |
| --- | ---: | ---: | ---: | ---: |
| Native PostgreSQL | 0.064 | 0.075 | 0.087 | 0.113 |
| SpiceDB/PostgreSQL | 0.453 | 0.477 | 0.472 | 0.460 |
| OpenFGA/PostgreSQL | 0.763 | 1.380 | 2.234 | 3.772 |
| Fluree/Main | 0.661 | 0.646 | 0.697 | 0.729 |

These are previously recorded observations, not new tests. The
[environment](../../scripts/research/access_backend_comparison/evidence/2026-09-22/environment.json)
was one Threadripper host, about 62 GiB RAM, tmpfs storage, local transports and a
small synthetic graph. This is neither a concurrent production workload nor a
test of the selected authority/voting semantics or candidate work limits.
Transport/query/cache differences prevent attributing the differences solely
to the database engine.
The near-flat rows do not prove depth is free, and 15 observations do not qualify
p99 behavior.

### Recommended evaluation strategy

1. Compile typed policies and recipient selectors on publication. Keep the
   closed condition registry and first-applicable semantics from the current
   implementation plan; do not admit arbitrary graph queries in user policies.
2. Discover eligible acting contexts outside the critical command path. Return
   bounded, opaque proof/context handles for a selected actor. A handle is a
   lookup hint bound to identity, limits and revisions, not an unrevocable token.
3. For a request, load the selected representation proof and relevant target
   grant/ancestor information in one consistent local authority snapshot.
   Validate current lifecycle, time limits and fences. Do not search every
   organization represented by the account to discover accidental authority.
4. Within a single-parent group tree, check whether a subject's relevant direct
   memberships are in or descend from the granted group. Do not enumerate all of the
   granted group's members or all organization descendants per request.
5. Share request-local subproblems and same-scope decisions across bulk checks.
   Preserve mandatory guards and ordered-rule dependencies when short-circuiting.
6. Precompute selective group/scope ancestry only where the measured read benefit
   outweighs mutation and storage work. Preserve the authoritative edges,
   dependency generations and paths; do not copy every permission to every
   current account.
7. Keep expensive discovery, impact previews, reverse membership and poll
   preparation paginated or asynchronous. Protected list/search completeness
   follows the [authorization bridge](../implementation/authorization-bridge.md),
   not filtering one fetched page and calling it a complete list.

Full transitive closure can require O(n²) rows for general graphs. For a bounded
single-parent tree, ancestor rows are bounded by the sum of node depths.
Reparenting may affect ancestor-count times moved-subtree-size rows. This is our
structural cost analysis, not a claim that closure is always the right index.
An incremental index must preserve independent supporting paths when deleting one
edge. A reachability bit without provenance cannot safely implement all revocation.

A prepared proof/index does not make revocation O(1) by magic. Either validate its
bounded dependency generations against authority, or maintain a qualified fence
that invalidates every affected admitted proof. Cross-request allowance caching
remains deferred until that protocol is qualified. Start by caching immutable
compiled models and reusing one request's coherent inputs.

### Initial work profile to qualify, not a universal semantic limit

Business limits and evaluator limits are separate:

- Default grants permit use without granting creation of further dependent grants.
  Explicit redelegation records the allowed scope, recipient class, action and
  conditions. A business rule can limit crossings of independent organizations
  for a specific reason; it must not count technical wrappers as new institutions.
- Pure nesting and admitted representation remain expressive relationships.
  Admission rejects profiles the deployment cannot evaluate reliably, instead of
  saving a grant that will consistently time out when used.
- Changing an operational limit cannot silently reinterpret an existing grant.
  Requalify/migrate affected profiles before enforcing a lower supported limit.

The following are **proposed starting parameters for experiments**, not measured
coverage, security theorems or production SLOs:

| Control | Starting candidate | Required behavior on excess |
| --- | --- | --- |
| Pure group/resource hierarchy | 32 edges per hierarchy | Require a qualified indexed profile or a validated scope redesign before activation. |
| Selected representation chain | 8 representation edges | Require an explicitly qualified larger profile; a proof hint still preserves all dependencies. |
| Dependent-grant ancestry | 8 dependency edges | Same; only the rightful authority can replace dependencies with a new durable institutional assignment. |
| Compiled subproblem depth | 64 evaluator levels | Unavailable/complexity result; never assume allow or treat missing exploration as definitive denial. |
| Total work for one decision | 2,048 distinct evaluation states and 50 ms evaluation deadline | Bound database/CPU work too; return unavailable if the decision remains unresolved. Tune from actual mixed load. |
| Ordinary bulk checks | Up to 100 targets per page | Share inputs but enforce both per-target and total request work; report partial/unavailable explicitly. |

These numbers deliberately are not justified by the phrase 99%. The local depth
probe and external traversal guards only motivate testing a bounded profile.
Database statement deadlines, memory, queue length and per-tenant rate/concurrency
limits are also necessary. A state-count check performed after an unbounded SQL
scan is not a work limit.

If profiles frequently hit limits, use evidence to choose selective indexing,
shallower explicit authority assignments, policy changes or a specialized
evaluator. Merely raising every recursion limit is not a capacity strategy.

## Storage and command integration

Keep private authority in PostgreSQL, voting facts under their existing
Jena/governance ownership, and no second independently writable authority store.
The additional logical responsibilities are:

| Owner | Records / invariant |
| --- | --- |
| Access / PostgreSQL | Representation and grant instances, admitted subject roots, protected recipient sets, role/mandate-policy revisions, current generations and fences. |
| Access / PostgreSQL | Bounded proof handles/index metadata with dependency identities; not a permanent account-to-all-permissions matrix. |
| Governance / Jena (TDB2) | Immutable poll charter/electorate snapshot, issued root entitlements, allocation plan, resolutions and ballot revisions. |
| Governance / Jena (TDB2) | One current ballot per poll and active allocation leaf, guarded expected-revision/idempotency semantics and conserved source units. |
| Existing command/bridge boundary | Bind current Access admission to the exact ballot/allocation/proposal and expected state; handle revocation, retries and uncertain effects. |

Useful indexes start from the query: target scope + action + recipient selector;
selected representative + represented subject; group + member; parent grant ID;
and poll + entitlement/allocation identity. Role compilation can supply a bounded
permission-to-binding candidate index. Inspect real query plans before adding
closure tables or per-account expansion.

Group/representation topology changes must serialize within their admitted
mutation domain or use another qualified concurrency protocol. Two individually
acyclic writes can collectively create a cycle. Large changes stage a new
generation; invalidated authority is fenced before background index cleanup.
An old index may deny or become unavailable but must not admit a stale allowance.

Vote allocation and ballot mutations use the Main adapter's conditional SPARQL
transaction through Fuseki, with complete dependency guards, immutable revision
references, application sequence, receipt and outbox committed together,
including conflicts between splitting a root and voting that root. Keep immutable
allocation plans and activate them before the poll opens. Their transaction and
uniqueness behavior remains prospective qualification, not a claim that a relational
UNIQUE constraint exists across TDB2 and PostgreSQL.

PostgreSQL repeatable-read input loading alone does not make the later Jena
write atomic with revocation. Reuse the existing admitted-command protocol and
strong-revocation drain/cancel boundary. Snapshot entitlement weight is not
historical permission to submit a new ballot.

## Alternatives considered

| Alternative | Where it works | Why it is not the general default |
| --- | --- | --- |
| One universal Realm → Org → Team → Person inheritance tree | A tightly controlled single enterprise hierarchy. | Participation, sovereignty, management and representation get conflated; shared organizations and institutional voting do not fit. |
| Arbitrary recursive administrator closure | Very permissive transitive control. | Administrative cycles and membership changes can yield unexpected authority; negative checks and mutation effects are hard to bound. |
| Flatten all effective rights onto accounts | Small static rosters and cheap direct lookups. | Controller changes require broad rewrites; institutional identity, proof provenance and revocation dependencies are lost or recreated elsewhere. |
| General distributed capability chains | Deliberately decentralized delegation. | Key/credential lifecycle and revocation add complexity; quantity conservation and organizational governance still need another model. |
| Specialized ReBAC engine for all semantics | High-volume relationship evaluation with suitable freshness integration. | Does not independently define representation, ordered rule composition, grant mutation or weighted voting. Remains a credible measured evolution. |
| Typed relationships + scoped representation + entitlement accounting | Mixed individuals, teams, communities and autonomous organizations. | Recommended combination. Costs are explicit control admission, revisions, proof provenance and separately specified voting rules. |

## Intended coverage and the meaning of 99%

| Task family | Selected path |
| --- | --- |
| Personal ownership and ordinary collaborators | Direct or eligible-set grants. |
| Team/project permissions | Single-parent group inheritance and scoped roles. |
| Deep folder/content hierarchy | Explicit resource scopes with bounded traversal/selective ancestry index. |
| Realm moderation of individuals and organizations | Publication/participation permissions in that Realm. |
| Independent organizations in several Realms | Separate institutional authority and context-specific participation. |
| Realm-managed or parent-managed organization | Explicit managed-organization preset and grants. |
| Parent-company administration of a subsidiary | Scoped institutional grant; representation declared separately. |
| Agency/outsourcer administering a client | Client grants to the agency subject plus its admitted representatives. |
| Person → Team → Org → other Org | Typed representation proof followed by the target grant; no implicit admin transitivity. |
| Temporary acting officer | Time-limited representation with current admission and replacement. |
| Grants that survive employee turnover | Durable institutional assignment. |
| Grants dependent on a contractor's upstream rights | Dependent delegation with recorded parent/fence. |
| One-person voting | Admitted private counting identity, independent of public persona. |
| Weighted organization/delegate assembly | Institutional entitlement plus ballot mandate. |
| Board approval or internal vote before an external vote | Exact approval/resolution activates one institutional ballot. |
| Organization explicitly distributing its voting weight | Conserved allocation leaves, if the electorate permits it. |
| Ordinary proxy | One-hop proxy with declared snapshot and holder-override policy. |
| API client/service automation | Workload principal, scoped representation, installation/client ceilings. |
| Recovery and protected authority changes | Independent-root recovery and operation-specific approvals. |
| Unlimited liquid delegation, multi-parent authority networks or live fractional flow | Explicit extension profile, not silently promised by ordinary membership. |

For the first delivery, ordinary access plus institutional ballots/approval is
the default. Direct proxies and explicit allocations can use the same records
when those capabilities are selected; fully liquid routing is a separate
qualification. This is a scope distinction, not an assumption that all uncommon
cases collectively account for exactly 1%.

Measure coverage against legitimate user tasks across the selected use-case
families, not the percentage of requests that happen to be easy:

    coverage = weighted legitimate tasks completed with supported semantics
               / weighted legitimate tasks attempted

Keep task-success coverage separate from latency/availability SLOs. Also report
the result by tenant size and task family so one large simple workload cannot hide
a completely unsupported category. A goal of at least 99% needs representative
usage/journey data and usability observation; a handpicked matrix is not that data.
Zero accepted counterexamples is required for the security/conservation invariants.

## Validation that can change this recommendation

### Semantic and lifecycle acceptance

These are required prospective cases, not executed test results:

| Case | Expected outcome |
| --- | --- |
| Realm admin moderates an org's local publication | Can affect that context; cannot acquire global org control. |
| Organization joins/moves between Realms | Does not acquire a new controller from that structural change. |
| P only manages A; A manages B | No represented access to B. |
| P represents A for B's granted operation | Allowed as A; audit preserves P and the exact proof. |
| A manages B; B has rights on C | No use of B's rights until an admitted representation path to B exists. |
| One path supplies representation, an unrelated path supplies a missing ceiling | Deny the assembled proof. |
| Two complete independent grants; one revoked | Remaining complete source can still allow. |
| Administrator edits a roster/role to gain protected representation | Reject without the required ceiling/approval. |
| Concurrent group reparenting/representation edits | No cycle or unapproved effective expansion becomes active. |
| Leave/rejoin, role revision or mandate revision changes | Old generations do not revive dependent authority. |
| Timeout before resolving an earlier ordered rule | Unavailable; no fall-through allow. |
| Org has 100 units and two representatives | At most 100 counted; concurrent ballot updates conflict or serialize. |
| Same voting entitlement reached through two paths | Count once. |
| Split 100 into 40 + 60 while an old root ballot is submitted | No accepted state counts both parent and children. |
| Principal switches Person/Org public attribution | Cannot multiply a one-person entitlement. |
| 2-of-3 approval with different proposed choices | No approval threshold for a mixed digest. |
| Frozen entitlement but current representative revoked | Existing admitted ballot follows charter; new mutation rejected. |
| Proxy votes, then holder validly overrides | Replace that source contribution; preserve total units. |
| Two organizational seats share the same operator | Separate seats only when the electorate admitted them independently. |
| Crash/retry during casting, allocation or tally projection | Idempotent effect and replayable conserved tally. |
| Passing proposal exceeds the body's authority | No out-of-scope execution. |
| Stale projection after revoke; uncertain cross-store command | Current fence/admission contract prevails; no stale new allowance. |

### Performance qualification

Use the actual initial-host hardware and durable storage. Vary one dimension
first, then representative mixed workloads:

- Chain depth 1, 2, 4, 8, 16, 32 and an intentionally rejected larger profile.
- Fan-out 1, 4, 16, 64; avoid accidentally materializing a complete exponential
  tree. Include bounded sparse graphs, diamonds and deliberately invalid cycles.
- Subjects with small and high membership counts; hot teams, roots and objects;
  both positive and negative checks; first-applicable exclusions and intersections.
- Single checks, 100-target batches, membership/visibility lists and heterogeneous
  protected search. Keep completeness and authorization guarantees identical.
- Warm/cold inputs, role/membership churn, expiry, root/middle-edge revocation,
  index rebuild, slow replica, dropped invalidation and process restart.
- Institutional polls with many representatives per seat; many seats delegated
  to one operator; simultaneous casts/replacements; allocation/tally recovery.

Record p50/p95/p99, throughput and errors, but also rows read, subproblem count,
database round trips, CPU, memory, queueing, index size, write amplification and
time from authoritative revoke to rejected new admission. Measure end-to-end
command effects separately from the Access check.

Compare native traversal, selected closure indexes and a specialized evaluator
using identical policies, data, snapshot/freshness and command semantics. A
faster path that permits stale authority or returns incomplete lists fails.
If ordinary qualified workloads cannot meet the elected latency/resource budget,
the native evaluator recommendation must be revisited.

## Owning contracts and remaining qualification

The following owners incorporate the accepted design. They define normative
behavior; this report retains evidence, alternatives and remaining experiments:

- [Identity/access](../contracts/identity-and-access.md): typed composition,
  institutional representative policies and protected-set mutation.
- [Realm participation](../contracts/realm-participation.md): independent versus
  explicitly managed organizations and local moderation scope.
- [Votes/references](../contracts/votes-and-references.md) and
  [governance](../contracts/governance-rules.md): entitlements, mandates,
  snapshots, allocations, proxies and approved-effect authority.
- [Access implementation](../implementation/access-control.md),
  [workload design](../storage/workloads/identity-access-capacity.md) and
  [authorization bridge](../implementation/authorization-bridge.md): supported
  work profiles, proof dependencies, index activation and cross-store admission.
- [Identity acceptance](../testing/identity-and-access.md) and
  [governance acceptance](../testing/governance-and-delivery.md): the corresponding
  positive, rejected, concurrent, revocation and conservation cases.

The proposed starting limits and coverage claim remain unqualified until the
specified workload and user-task evidence exists.
