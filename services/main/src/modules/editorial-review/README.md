# Shared editorial review

Catalogue corrections, future identity merges (G-836) and wiki bundles (G-846)
share proposal, revision, review and decision identities. Kinds supply candidate
meaning and an owner commit through `<kind>-adapter.ts`, exporting `adapterModule`.
Discovery needs no kind registry edit. The owner factory receives the current
`{ work, request }` runtime. `contract.ts` is the binding interface; the shared
conformance runner requires each installed kind's `g-865-<kind>-fixture.ts`.

The Access migrations retain immutable proposals, candidate/prestate revisions,
reviews, application intents, outcomes, command receipts and events. State and
viewer actions are computed from these rows, with one terminal decision. A new
revision invalidates all earlier approvals, including when only evidence changes.
Comments do not replace a review stance. Each operator supplies at most one
current stance and one counted approval, across their Agents. Current Agent
control and maintainer, contextual grant or appointed `work.review` role authority
are checked again for the decision and owner admission. The proposer, their
original controllers and current controllers cannot independently review it.
Review authority covers publicly readable Works. A private Work additionally
requires the reviewer's current Work-specific edit grant; a read grant plus a
global review role or contextual review grant cannot authorize its correction.
Private independence keys never enter API history, errors or hook events.

The current-candidate rule follows the
[protected-review precedent](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-pull-request-reviews-before-merging)
(reviewed 2026-10-01). This precedent supplies no cross-owner atomicity guarantee.
Here an immutable application intent fences the proposal before dispatch. It binds
one revision-qualified owner operation key, candidate digest, deciding Agent and
server-computed owner action/scope/digest. Access consumes this permit at
registration and claim. Ordinary edit permission cannot substitute for it.
Authority rows stay locked across owner delivery; the owner atomically guards
expected heads and native receipt absence. Generic edits still use their own
admission path.

An unknown owner acknowledgement stays pending: revision, withdrawal, rejection
and a new apply cannot overtake it. Reading or explicitly recovering the proposal
looks up the original admission's receipt, seals it and appends its outcome. This
needs current target disclosure but no old controller credential and never
redelivers the owner command. If a process stopped before registration, recovery
takes the registration lock and appends cancellation; later registration then
fails. An admitted intent without a terminal receipt remains pending until the
existing owner admission sealer resolves it. A cancelled or stale attempt requires
a new revision. API key replay retains the exact receipt or typed blocker, even
after authority revocation; current target disclosure is checked before replay.
The pre-registration cancellation proof applies only to adapters declaring
`admission: 'access'` and using that shared registration lock/mapping. Other owner
mechanisms resolve their own receipts through `resolve(input)`; absence of a graph
admission cannot prove their effect absent. Merge/wiki bindings retain this same
lifecycle rather than treating a foreign owner effect as cancelled.
Ordinary reads take no exclusive proposal lock. Pending recovery attempts that
lock without waiting; an active owner delivery remains readable as pending.
A SQL snapshot keeps each returned revision, decision and timeline coherent.

`component-correction` calls the existing Work header metadata and semantic
commands in process. The header corrects existing title/description fields.
Semantic descriptions attach to the admitted resource IRI; a first Work
description compares its existing Work head, later descriptions their semantic
head. Work-owned types and predicates remain reserved. Existing resource and
definition components retain their owning validators. Reverting an applied
proposal creates a new proposal from the receipt's retained prestate and after
heads. Compensation restores values while advancing heads; it never erases or
mutates the original decision.

## Consumers and operating boundaries

`routes/editorial-proposals.ts` exposes create, revise, review, decide, withdraw,
reversal, get/list and receipt-only recovery, with discoverable OpenAPI schemas.
Writes require `Idempotency-Key` and `work:correct` or `work:review`; disclosure
uses `work:read`. Public catalogue review application needs no separate ordinary
edit capability; private Work review preserves its Work-specific edit boundary.
Public reads/recovery allow an anonymous viewer; private targets and contexts
still require their owner disclosure proofs. Allowed actions are advisory current
results, not reusable authority. GUI G-867 consumes these results without creating
a separate review state machine.

`EditorialReviewStore.eventsAfter(sequence, limit)` is the durable G-866 hook.
Consumers checkpoint only after their own delivery transaction and recheck
current disclosure before exposing an event. The global event clock serializes
commit order so a checkpoint cannot skip an earlier uncommitted event. Events
carry proposal/revision, kind and actor, with no candidate or operator payload.
Notifications and UI implementation belong to their respective workers.

## Cost and evidence

Candidates/prestate are at most 1 MiB, evidence and heads at most 32, messages at
most 4,000 characters and cursor pages at most 50. Candidate canonicalization is
linear in bytes with a depth bound of 32. Current review queries return at most
the required one/two approvals and one changes-requested stance; indexed probes
exclude superseded stances. Cursor order retains exact database timestamp precision
and numeric sequence order. Applying dispatches one owner command under the
declared graph budget; owner validators retain their tighter limits.

The conformance suite rejects stale approvals, dependent reviewers, malformed or
absent receipts, an implicit second decision, altered targets/permits and deliberate
regressions. The integration journey exercises actual Access/graph admissions,
header and semantic corrections, revision, rejection, withdrawal, compensation,
concurrent decisions, lost-response/process recovery, authority revocation,
immutable SQL guards, cursors and hook ordering. These prove the named bounded
journey and lifecycle slice, not full-corpus engine cost, restore qualification,
legacy protection routes or the future merge/wiki owner bindings.
