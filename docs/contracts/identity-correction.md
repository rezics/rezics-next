# Identity correction, merge and split

The installed Work-address resolution and source-identity proposal are bounded
slices. General identity merge, split and cross-owner authority transfer remain
prospective [pending cases](../../scripts/qa/cases/identity-correction.ts).

An identity merge is an evidenced decision, not a rewrite of every incoming edge.
Equal names, bytes or external identifiers only suggest candidates. Keep original
identities, exact revisions, references and provenance; ordinary navigation may
follow a reviewed bounded resolution with its reason. Reject self/cyclic or stale
activation under expected identity and control heads.

Account-controlled Agents need their own recovery authority. Native fields,
grants, votes, subscriptions and Main Versions each need a conflict/transfer
policy and durable per-owner outcome; a source job with an old binding epoch fails.

Split is a new assignment decision. Later mixed edits may be ambiguous, so do not
invent an inverse, reuse consumed approvals or restore erased/private payloads.
Concurrent correction, partial reconciliation and restore/replay still need owner
qualification before this general protocol can be called implemented.

## Catalogue quality pipeline

Maintainer and product manager, 2026-09-30, from R54. Duplicates, wrong grain
and low-quality records are unavoidable in a user-maintained catalogue, so
REZICS prevents them where that is cheapest and makes repair dependable.
Passing a duplicate check and an advertising check establishes neither the
right grain nor valid attribution: grain errors (an edition entered as a Work,
a volume as a series, a translation as a new story), translated or romanized
duplicates, over-merges, wrong facts and fabricated or impersonated books each
need their own handling. An actually published AI-written book is a legitimate
record; AI authorship is not a spam verdict.

| Step | Owner | Behaviour |
| --- | --- | --- |
| Admission | Code | Authenticate the person or agent; enforce quotas, payload limits and a pending-creation limit (three for new contributors to start, tuned to reviewer capacity) |
| Search before creation | Code | Search original titles, language-tagged aliases, romanizations, creators, dates and identifiers before the form; offer use existing, add alias, add version or publication, or create |
| Declare grain | Contributor, validated by code | New creative scope, version or translation, publication, part, or collection, with its parent or coverage; models may suggest, never choose |
| Assess candidates | Cheap matcher, stronger model for hard cases | Same, different, related or uncertain, with compared attributes and evidence; different-grain matches become relation proposals |
| Assess abuse | Jev, code, human escalation | Advertising, SEO, impersonation, fabrication, vandalism and missing evidence are separate flags; a pass means "not detected"; holders of the bypass grant skip the classifier, recorded on the receipt |
| Publish provisionally | Code | Visible and marked unverified with field provenance; excluded from trusted exports and recommendations until verified |
| Reconcile and maintain | Reviewers decide, code executes | Merge and split plans, audits of accepted and rejected decisions |

Models propose identity changes; they may retrieve, rank, explain and reversibly
quarantine suspected spam. Automatic linking needs measured precision of at
least 99.5% on accepted matches, with coverage and confidence intervals
reported (roughly 600 independent accepted matches without error support that
bound), plus deterministic grain checks; a model's displayed confidence is not
precision. An exact identifier auto-links only to an already trusted,
collision-free binding of the same grain; an ISBN never proves Work identity.
Populated, disputed or cross-owner merges stay with humans, and one wrong
bridge can join clusters, so clustering is evaluated as well as pairs. Jev costs
about $21 per million 500-token checks (TypeSafe, 2026-09-30); it runs under the
US$10 monthly cap approved on 2026-09-30, per the
[agent owner](skills-and-prompts.md#ai-speed-through-open-interfaces).

## Merge and split as one capability

Merge and split are one reusable capability for every Resource, with grain
rules per type and reconciliation handlers per owner, never a merge engine per
domain. A merge plan pins exact source and target revisions and evidence,
previews every affected statement, relation, rating, review, library entry,
progress record, wiki fact, subscription and source binding, records a decision
for each conflict (keep alternatives, choose, reassign or leave unresolved),
executes durably across PostgreSQL and Jena without assuming one transaction,
and keeps every old ID resolving while exact revisions stay exact. One person's
two ratings never become two votes, two owned copies never collapse into one,
and account control, private grants and creator rights never transfer.

Unmerge is a compensating decision, not a rollback: later edits are assigned or
queued as ambiguous. A split allocates facts and interactions to evidenced
targets; when the old record conflated several things, its ID explains the split
and lists candidates instead of redirecting to one child. Anyone, including
agents, may propose; qualified reviewers decide; populated, contested or
high-impact merges need two independent human approvals at first, and a bot and
its operator are not independent.

The workbench shows multilingual titles, creators, grain, dates, coverage,
identifiers, provenance, conflicts and affected personal-data counts side by
side, with keyboard navigation, saved queues, batch preview with per-item
receipts, history diffs and queue dashboards (arrivals, oldest and median age,
reversals, reviewer minutes). The API offers the same operations to agents.
Quality is measured as confirmed duplicates per 1,000 new records after 30
days, wrong merges, existing-record selection at creation, abandonment and
editor minutes per trustworthy addition, by language and grain.

The older checkout's merge contracts (`services/main/src/services/units/merge/contracts.ts`
in the sibling `rezics` repository) hold preflight, two-review admission, redirects, reconciliation items and
recovery fixtures worth adapting, not porting wholesale. Today address
redirects exist (`services/main/src/modules/address/`), provider identity and
corrections are proposal-only, and creation has no candidate, grain or evidence
step.

### Launch scope

The section above preserves the broader intent and its earlier implementation
baseline. The installed launch slice is described here.

The launch duplicate-Work merge is an evidenced decision through the shared
editorial `merge` adapter. A plan pins source and survivor revisions and evidence;
preflight compares multilingual headers and bounded person-state counts. Two
independent human approvals are required for merge and unmerge. A bot and its
operator, or two Agents controlled by the same person, are not independent.

The Work owner writes `rv:mergedInto` first, with a native Jena receipt; unmerge
removes it first. Later library, follow and reading-progress writes resolve their
Work through the shared target resolver. Ordered owner commands reconcile library
statuses, follows, effective standing rating votes and public reviews. A survivor
slot wins each conflict (including cleared statuses and explicit unfollows); a
source-only slot moves. If either personal slot changes after page capture, its
current state is retained and the item cannot block completion or enter unmerge
compensation. Ratings keep original observations and sealed receipts,
selecting at most one effective vote per Account principal and Context. Exact
daily/occasion ratings and historical Main Version votes retain their original
grain. Exact reading progress, sessions and owned copies remain independent.

Graph facts remain on their original Work: statements, relations, realizations,
compositions, collections and source bindings are not rewritten. The survivor
entity page includes disclosed original headers and native fact inventories in
bounded `mergedFacts` pages through `rv:mergedInto+`. Original IDs and exact Work,
Main and address revisions remain readable with a separate typed resolution.
Address GET 200 preserves its old shape and adds optional `resolution`. Disclosure,
grants, account control and creator rights never transfer.

PostgreSQL and Jena effects have native receipts; Access retains per-item snapshots
and outcomes behind the shared ordered editorial commands. Explicit decision retry
resumes delivery; receipt-only reads cannot dispatch. Unmerge compensates the
original moved/history items using exact post-effect state. Later edits become
`ambiguous` and remain intact. SQL person-state coverage requires an owner handler
or an exact explained exclusion, including empty new tables. Graph predicate
scanning, incoming-reference fencing and identity reservations are outside the
launch scope.

Split beyond compensating unmerge, the workbench UI and batch queues are deferred.
General Resource and Account-controlled Agent corrections need their own grain and
recovery authority; the Work adapter does not admit them.
