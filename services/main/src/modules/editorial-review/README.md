# Shared editorial review seam

G-865 publishes the adapter contract before the wiki bundle binding. A kind adds
`<kind>-adapter.ts` exporting `adapterModule`; discovery owns no kind list.
`contract.ts` names the exact target, immutable candidate/prestate, base heads,
evidence, private independence keys, current authority, owner permit and receipt.
`lifecycle.ts` computes current review state and viewer actions and guards a
decision. It never stores a mutable status or treats an old approval as current.
The current-candidate rule follows the [protected-review precedent](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-pull-request-reviews-before-merging)
(reviewed 2026-10-01); that precedent supplies no cross-owner atomicity guarantee.

`component-correction-adapter.ts` validates Work metadata and semantic component
states through their existing owner validators. Its owner ports must call the
existing in-process commands, with a proposal-qualified admission checked by the
owner in the effect transaction. No production bridge or HTTP routes are wired.
Ordinary edit admissions cannot substitute for that missing binding.

The required bridge is blocked at `modules/access/admission.ts`, claimed by
G-523 at G-865 dispatch. G-508 installed `work.create`/`work.edit` role permissions,
not the review permission named in the brief. An adapter-side authority preflight
followed by an ordinary edit would allow authority/revision changes between
review and effect. The Work-title template already solves its own narrower case
with a signed title admission; it does not bind metadata or semantic corrections.
The existing metadata header also has no date field, and the semantic validator
rejects the canonical Work type as `reserved-owner`. The brief's Work date
journey therefore needs a separately owned date/metadata command extension;
an admitted semantic Resource can already correct a temporal assertion.

The next store must append proposal, revision, review, application-intent and
terminal-decision rows. Serialize each proposal across revision and decision;
retain the application intent before owner dispatch. Unknown acknowledgement
keeps it pending until the exact receipt or cancellation resolves it. A new HTTP
idempotency key must not allocate a second owner operation: use
`revisionOperationKey(proposal, n)`. Do not revise, withdraw or reject over an
unresolved application. Successful decisions retain the owner receipt, its exact
candidate and prestate; `compensate(receipt)` creates the reversal candidate
without accepting replacement prestate from a caller. Reversal creates a new
proposal and restores values by compensation.

## Cost and conformance

Candidates are at most 1 MiB, evidence and component heads at most 32, messages
at most 4,000 characters and cursor pages at most 50. Candidate canonicalization
is linear in candidate bytes with a nesting bound of 32. Review reduction is
linear in supplied stances and the requested history page. The eventual store
must fetch current stances through an index, not scan an unbounded review log.
Component corrections read one current component and dispatch one owner command;
the existing validators retain their tighter metadata/semantic limits.

`services/main/tests/g-865-adapter-conformance.test.ts` discovers every adapter
and its own `g-865-<kind>-fixture.ts`, then runs the same lifecycle guard suite.
A new kind without a fixture fails the suite. Fixtures exercise the adapter
through deterministic owner ports; they qualify no production admission, database
serialization, HTTP journey, recovery fence or workload subcase. Those remain
pending until the production bridge/store and integration journey are delivered.
