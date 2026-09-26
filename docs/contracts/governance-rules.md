# Governance rules and decisions

## Rule lifecycle

A rule has stable scope/identity and immutable semantic revisions, localized
presentation, activation interval, eligible decision makers and enforcement
capabilities. Draft, reviewed, active, superseded and retired are distinct.
Changing display translation must not alter the approved rule meaning.

Decisions cite exact rule revisions and evidence. Platform-wide minimum
restrictions remain distinct from Realm additions. Owner or Realm power does not
override protected account security or erase unrelated contexts. No API may infer
authority from a rule's title, classification or mere presence in a graph.

## Admission and review

Rule authoring, activation and enforcement are separately grantable. Bind previews
and approval to candidate digest and expected policy generation. Sensitive changes
require declared independent approval and grantability checks. Concurrent rule
activation serializes within its scope; old jobs recheck eligibility before apply.

AI review records method, input, model/tool configuration, limitations and observed
output; it is evidence under a selected policy, not an unrestricted administrator.
Ambiguous/unavailable review routes to explicit pending/human disposition.

## Collective decisions and execution authority

[Editorial protection and correction](editorial-protection.md) applies these
rules to an exact adopted component/selection. Tightening, confirmation,
relaxation and correction review are separately admitted effects. An ordinary
edit grant cannot authorize a temporary unlock or weaken the rule that requires
review. The initial correction policy requires an independent human reviewer;
Access checks private principal/control identity, not merely different public
Agent IDs. Unknown independence cannot be guessed from graph attribution.

Approval binds the proposal revision, candidate digest, target/context, expected
content/protection/control state, evidence and rule basis. For a bounded local
correction, approval and adoption commit together with a one-use application
identity while protection stays active. Other profiles must expose pending
approval/application and revalidate their exact basis at activation. A later
governance reversal appends a new authorized decision; it never rewrites history.

The [vote contract](votes-and-references.md) defines electorate snapshots, institutional
entitlements, representative mandates, allocations and counting. An organization
can resolve its internal vote before casting one external institutional ballot;
its charter declares the aggregation and required independent approvals.

A finalized resolution binds the exact proposal/effect digest, rule revision,
electorate snapshot, result and approval evidence. Only an admitted governance
capability within the body's scope may turn that resolution into effects. Passing
a proposal does not grant arbitrary administrator powers to its voters or erase
another organization's authority.

Bind execution to the current command-admission boundary and expected target
state. Retries cannot execute the same effect twice. A stale basis or unavailable
authority remains pending/rejected under the declared policy; it cannot silently
retarget an approval. Security revocation of an operator and governance
invalidation of an already admitted ballot are separate attributable transitions.

The first executable capability is `access.org.roster.policy`, the protected
`POST /v1/access/organization-roster-policy` operation in the [managed
organization contract](realm-participation.md#explicit-managed-organization-profile).
Its effect profile names the organization, the existing managed grant and exact
recipient, the grant generation, the recipient representation ID and generation,
the expected roster policy revision, and `admissionsOpen`. The proposal target
must be that organization IRI and its capability must be exactly
`access.org.roster.policy`; the body's capability grant is scoped to
`access:org-roster:<organization UUID>`. No other capability or scope is
executable in this profile.

For this effect profile, canonical JSON is UTF-8 JSON with recursively sorted
object keys, no insignificant whitespace, and array order preserved.
`effectDigest` is SHA-256 of that encoding for the complete
`access-organization-roster-policy-v1` request fields, including the profile
and `admissionsOpen`. `expectedTargetState` is SHA-256 of that encoding for
`{ profile: "access-organization-roster-policy-state-v1",
organizationSubject, policyRevision, admissionsOpen }` read from Access at
approval. The client operation ID is bound to the exact proposal revision,
resolution and effect digest; all retries recover the same Access and target
owner receipts by that ID. The execution admission records the finalized adopting resolution,
exact proposal revision/digest/target, the executor's current mandate for the
voting body and that body's active generation of the exact capability grant.
The handler re-reads the current policy and submits the existing G-017 operation
with the approved payload and expected revision. An unsupported capability,
scope mismatch, changed policy generation, grant or representation returns a
denial or stale conflict before changing policy. Retries use the same operation
ID and return the saved result; they do not apply another policy revision.

The selected write is bounded by the proposal's exact poll/resolution and
revision, one body mandate and one capability grant, one organization policy
row, and one history/receipt record. It does not scan members, other
organizations or corpus content. Admission and API tests count those owner
reads and verify that denied, stale and recovered calls do not repeat the
policy write.

Moderation decisions use the reviewed owner head as a compare-and-apply
condition in the admitted command: Content checks and applies against its exact
draft head, and Jena checks and applies against its exact graph head. Access
commits the case decision and enforcement fence only after every target owner
accepts the same operation ID and expected head. A failed owner CAS returns
stale and leaves the Access decision and enforcement unchanged. If an owner
accepts but the caller loses the response, retry reconciles that owner's
operation receipt before finishing the Access decision; it never substitutes
the then-current head. Work is bounded by the declared target limit, with one
owner CAS per target and no corpus scan.

## Persistence and capacity

Store rules, localized forms, decisions and exact anchors in Jena. Access owns
effective security grants/fences. Staged enforcement and paged reverse impact
avoid full-corpus synchronous rewrites. Caches include rule and disclosure
generations; a retired rule does not retroactively change historical citations.

Test rule edits during decisions, localization drift, competing reversals,
independent approvers, source evidence changes and interrupted enforcement.
