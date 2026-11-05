# Reviewed Person identity at the native merge boundary

Research recommendation, awaiting adoption by the Semantic owner. Consumer: Imports' same-Person review.
The guarded operation is **`mergeSubjects(pool, options)` in `services/kernel/src/semantic/merges.ts`**,
received by the existing **`POST /v1/subjects:merge` / `subject.merge`** in `semantic/http/subjects.ts`.
Do not introduce another merge service, package, identity protocol, privileged authorization or publication promise.

Recommendation: optional two-endpoint expectations, validated after successful-result lookup, with exact local
source-claim and subject locks held through commit; unsupported homes remain `atomic_guard_unavailable`.
This is a reversible proposed contract, not an adopted owner decision.

## Evidence and the actual boundary

Paths below are relative to the repository root; function names and SQL names identify the inspected seams.

- `services/kernel/src/semantic/merges.ts`: `mergeSubjects` sorts IDs unless native callers supply `survivor`;
  it preflights the survivor on a released connection. A missing/redirected preflight result is saved and thrown
  **inside** the command callback, so completed replay wins. `mergeSubjectsInCommand` calls
  `admitIdentityTerminalCapture`, then checks both visible, unredirected subjects, types and account-agent restrictions.
  It writes the redirected subject's revision, release, partition count, redirect, projection marker and page work.
  Neither endpoint read currently checks reviewed provider identity. `merges-read-visible.sql` has no row lock.
- `services/kernel/src/command/command.ts`, `executeCommand`: native attempts begin SERIALIZABLE, mint time,
  run current authorization, then `read-receipt.sql`. Matching digest returns stored response/component and commits
  without calling the body. Changed digest throws `IdempotencyConflictError`; minimized results remain erased.
  A receipt-only authorization cannot execute a new body. Body, finalization, history, receipt and outbox remain
  one commit; exceptions roll back. Preserve its deadline/contention behavior, including the single-attempt wrapper.
- `services/kernel/src/semantic/identity-terminal-closure-command.ts`: `runIdentityTerminalCommand` wraps that
  executor. `admitIdentityTerminalCapture` locks local mapping rows. If directory drain is needed it rolls back
  the source attempt, releases it, drains bounded native pages, and starts a newly authorized source attempt.
  The expectation must run again in that final attempt. These mapping locks do not lock provider assertions.
- `services/kernel/src/semantic/bulk.ts`: `batchRoute` uses `tupleRoute(routeKey, source, external_id)` for
  creation. `batchCommand` creates subject revision 1 and `external_claim` in the same native transaction.
  Existing claims resolve the original subject; fresh keys do not update its identity. `bulk-read-claim.sql`
  reads `(route, source, external_id)`; `bulk-insert-claim.sql` persists `subject_id, recorded_transaction_id`.
  `services/kernel/db/semantic/schema.sql`, `external_claim_pkey`, enforces that exact tuple's uniqueness.
  This binding is **not** the canonical identity assertion, and is not a mutable source-record metadata revision.
- `services/importer/src/showcase-person-identity.ts`: `personIdentityForSource` maps Bangumi `person:N` to
  `wdt:P6298 = N` and VNDB `sN` to `wdt:P3180 = sN`. `observePersonIdentity` checks Person and a single distinct
  exact string value in the current endpoint response. Labels, hrefs, citations and Search cannot substitute.
- `services/kernel/src/semantic/slots.ts`: `effectiveGlobalSlotFacts` is the existing native selection seam.
  `resolveSlot` reads the last operation at the derived `statementSlotId`, then compact fact log or latest Global
  adoption. `slots-read-compact.sql` joins each fact's recorded transaction to its revision;
  `slots-read-adoption.sql` seeks the latest exact subject/slot/Context head;
  `slots-read-selection.sql` reads the selected candidate keys, at most 32. Hidden facts are omitted.
  Missing expanded selection rows yield unavailable. Do not use `slotView`'s rejected display candidates as identity.
- `services/kernel/src/semantic/candidates.ts`: `writeProposal`, `decideCandidate`, `adoptCandidates` write
  native revisions; `appendEditorialRevision` calls `update-subject-release.sql`, even when the release is equal.
  Adoption can change current identity without changing `subject.type`. `change-current-facts.sql` also updates
  the subject. `bulk.ts` retraction appends a revision and updates the subject, but retraction alone does not
  remove Context adoption. Selected/current identity must be read, not inferred from proposal or retraction history.
- `services/kernel/src/semantic/subject.ts`, `updateSubjectIdentity`, uses `update-subject-identity.sql` to
  update type and append an identity revision. `moderation.ts` and `statement-disclosure.ts` update the subject's
  security revision. Thus latest **all-kind** revision and security revision matter; `readItemIdentityVersion`
  is insufficient: `read-item-identity-version.sql` selects only create/identity revisions, missing adoptions.
- `services/kernel/src/semantic/account-erasure.ts` deletes exact `external_claim` rows; it also minimizes
  fact/candidate data and can suppress adoption. Ordinary source-binding insertion is not a rebind API.
  Do not manufacture an UPDATE-claim product operation to demonstrate a race.

## Proposed receiving contract

Add the following optional field to `mergeSubjects` options and to the existing strict HTTP body.
The native call also receives server-owned `routeKey` when this field is present, to derive tuple homes.
No client-selected route, SQL, callback, Access proof or authorization flag is accepted.

```ts
expectedIdentity?: {
  endpoints: [
    {
      subject: string; // UUID, must equal subjects[0]
      revision: number; // latest native revision, all kinds
      securityRevision: string; // canonical positive decimal, no lossy Number
      source: 'bangumi' | 'vndb';
      externalId: string; // exact provider key, person:N or sN
      claimTransactionId: string; // UUID from the persisted original binding
      property: 'wdt:P6298' | 'wdt:P3180';
      value: string; // exact reviewed identifier; provider relationship validated
    },
    /* same shape; subject must equal subjects[1] */
  ];
};
```

Exactly two entries, no extras; Person and Global Context are fixed by this contract. Bound externalId/value
at 255 UTF-8 bytes each and validate the existing positive provider syntax. Bind each expectation to its input
endpoint **before** sorting survivor IDs; swapping endpoints without swapping evidence fails validation/conflict.
Both provider namespaces may differ: this is an explicit authorized same-Person decision, not inferred equivalence.
The guard checks each endpoint's own exact identity; it does not decide whether two people are duplicates.

Persisted comparisons: tuple route/source/external_id, claim.subject_id and recorded_transaction_id;
subject route/id, visible type Person, security_revision; latest revision number; absent redirect;
and the effective Global identifier slot's current selected values. Require at least one string value, with all
selected non-deprecated identity values agreeing exactly with the expectation; reject malformed selected values
rather than filtering them into apparent agreement. Preserve native hidden/disclosure semantics. A conflicting
second value must fail even if the expected value is present. No candidate vector needs retaining in the request:
whole-subject revision plus security revision intentionally over-invalidates unrelated changes.

Value equality alone accepts A→B→A. All-kind revision rejects ordinary adoption/retraction/type ABA;
security revision rejects hide/restore or disclosure ABA. Subject IDs are never reused. The claim transaction
rejects delete/recreate of an equal tuple; the tuple's original binding must equal the reviewed endpoint.
For this smallest scope, an already-redirected original binding is unsupported even if a later public read follows
it to a Person. Imports keeps that original binding; fresh canonical evidence is not permission to rebind it.

**Public observation gap:** `readReviewedSubject` in `services/importer/src/import-client.ts` currently wraps
`client.subjects({id}).get`; `ReviewedSubjectRead` does not itself certify a tuple claim transaction and coherent
security/revision evidence. Add a bounded native read helper shared with the comparison logic, and an opt-in
review projection on the existing Subject GET (exact source/externalId query, no discovery). Return the expectation
only with current subject-read disclosure and coherent tuple/endpoint evidence in the same local snapshot.
Publish its generated client declaration; do not fabricate claimTransactionId from receipt spelling or fixtures.
This is an observation addition to the existing reader, not another identity protocol or merge endpoint.

## Local exclusion, SQL and price

In the `mergeSubjects` callback, after lookup and saved preflight handling but before calling the effect helper:

1. Derive both tuple routes and both subject partitions. Require **all four keys in the redirected command partition**.
   Another partition on the same physical PostgreSQL host is unsupported, as are moved/fenced/unavailable homes,
   a foreign survivor, foreign tuple home, pending/unknown canonical mapping, or a changed partition incarnation.
   Retain native partition/identity admission; do not turn an independent read into a foreign transaction lock.
2. In deterministic key order, exact-read the two claims `FOR SHARE` and the two subjects `FOR UPDATE`.
   Compare the claim identities, visibility/type/security, then latest all-kind revision via the existing
   `(route, subject_id, revision DESC) LIMIT 1` seam. Require no redirects on either endpoint.
3. Read just the two derived identifier slots with `effectiveGlobalSlotFacts`, under these locks and this tx.
   Compare exact effective values. Preserve the existing unavailable classification for incomplete evidence.
   Add locking SQL variants for selected fact/candidate rows and latest adoption rows if their mutable maintenance
   path is not fenced by the subject row; never assert that locking an immutable revision prevents append.
4. Invoke `mergeSubjectsInCommand` unchanged in semantics. Hold guards through domain/receipt/outbox commit.
   Revalidate after terminal-drain restart. A mismatch throws before terminal capture/effects, not after redirect.

Two subject locks exclude ordinary identity, adoption, proposal, retraction, moderation and disclosure commits:
these writers update that subject in their own transaction. A writer can stage append rows before blocking, but
those uncommitted rows cannot become current before releasing the guard. A writer that committed after the
merge snapshot causes SERIALIZABLE row-lock failure, not silent acceptance of an older version.
The two SHARE claim locks exclude deletion/reinsertion and any direct update of those exact existing tuples.
Missing claims fail; no predicate/gap lock or new binding creation is needed for a positive merge guard.

For the ordinary writer boundary, incremental price is **four row locks**, two claim seeks, two subject seeks,
two latest-revision seeks, two redirect seeks and two slot resolutions. Per endpoint, slot operation/adoption
are full-key descending seeks; compact history is at most 32 assertions (the 33rd row is expansion), expanded
selection at most 32 candidate point reads. Thus at most 64 selected candidates/facts, two adoption heads and
constant head/subject/claim rows; no subject-history walk or Search scan. Existing concealment queries are bounded
by those selected keys. Maintenance coverage can add at most 64 fact/candidate SHARE locks and two adoption SHARE
locks (70 total including the four primary locks). Price these additions only when their writer audit needs them.
Request evidence is capped at 4 KiB encoded JSON; retained command digest stays **32 bytes** and no new evidence
ledger is needed. Existing Imports review state retains that bounded body and exact key until outcome is resolved.
Counts are derived logical bounds, not measured latency, heap visits or a claim about whole-command cost.

A repeatable snapshot alone preserves a read, not exclusion through physical commit. SERIALIZABLE SSI permits
an overlapping reader to serialize before a writer; a single read/write dependency need not abort either.
A last-moment reread in the same snapshot cannot see the writer. Compare-and-lock, not another snapshot,
is the smallest candidate whose ordinary writer exclusion can be proved here. Locking only redirected is
insufficient: the survivor's provider assertion is equally part of the reviewed decision.

## Counterexample schedules and required outcomes

| Schedule / endpoint | Existing behavior or insufficient design                                                                                                                                                                                   | Guarded first execution                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| After review        | Review A/B as Persons; ordinary `adoptCandidates` changes B's provider value and commits; merge still sees two Persons and redirects. Dependent credits now use an unreviewed identity.                                    | Revision/value mismatch; no merge revision, redirect, count delta, outbox or success result.            |
| During callback     | M reads reviewed B slot without locks; W adopts another value, updates B and commits; M writes only A and commits. M-before-W is a valid serial order despite W physically committing first; SSI alone need not refuse it. | Lock B too. W waits until M commit, or an already-committed W makes M fail/retry under existing rules.  |
| Survivor changed    | A is redirected, B survives; only A is locked while W changes B.                                                                                                                                                           | Both subject locks required; mirror each race with endpoints reversed.                                  |
| ABA                 | Review A; adoption selects B then A again before merge. Final strings match.                                                                                                                                               | Changed all-kind revision refuses; review again. Hide/restore similarly changes security revision.      |
| Missing             | Missing claim, missing subject, no effective selected identifier or deleted assertion.                                                                                                                                     | Concealed not-found/conflict as appropriate; no effect. No label fallback.                              |
| Wrong type          | One endpoint is Organization, or type changed after review.                                                                                                                                                                | Reject even when both now have matching non-Person types; ordinary account-agent rules remain separate. |
| Conflicting         | Expected identifier plus a different selected identifier, or claim points elsewhere.                                                                                                                                       | Conflict, preserve original binding, withhold dependent credits.                                        |
| Unavailable         | Foreign/moved home, pending mapping, incomplete selection, contention/deadline.                                                                                                                                            | Native unavailable / `atomic_guard_unavailable`; preserve review for recovery, no success claim.        |

## Digest, replay, authority and publication

`services/kernel/src/http/request.ts:requestDigest` hashes canonical JSON including operation, client_id,
requested_by and body. The HTTP binding must pass the **whole validated body**, including expectations, to it,
and pass the same expectation to the callback. Native callers must hash the same semantic request through the
existing digest convention; add no second receipt kind/key. Do not sort request arrays for hashing: existing
`test/semantic/merges.test.ts` explicitly expects a swapped subjects array under the same key to conflict.
Changing evidence, omission/presence, endpoint association or payload under a successful key remains 422.

An exact successful replay runs current authorization and receipt digest comparison first, then returns the
original result/component without precondition execution, even after evidence changes or either endpoint redirects.
Do not throw stale evidence during preflight; retain its existing delayed-error behavior. Infrastructure failure
before lookup retains its native unavailable behavior. An unsuccessful stale first execution creates no success
receipt; refreshed evidence may be attempted under the ordinary retry contract. Replays never grant authority:
a revoked actor cannot retrieve success merely by knowing the key.

The HTTP body remains two UUIDs plus the optional field, without exposing native `survivor` or `allowAccountAgent`.
Pass server routeKey from `subjectRoutes`; retain Global `subject:merge`, identity exposure gate, admission,
structured-field Idempotency-Key and existing response/component semantics. Regenerate
`packages/client/src/kernel/semantic/http/subjects.d.ts` and merge declarations through the existing publisher;
`packages/client/src/index.ts` derives `KernelSubjectsClient` from the mounted `subjectRoutes` types.
Add `mergeReviewedPersons` to the existing `createImportTransport` return in `import-client.ts`, using the actual
mounted `subjects:merge` client call and its standard credentials, deadlines, session and native error handling.
The new wrapper sends only the retained review body/key; it grants no new authority and never calls a fake Pool.

Keep unguarded callers compatible. Do not apply this Person-only option implicitly to `verifyAccountAgent` /
`unverifyAccountAgent` or change their explicit survivor, reciprocal links, verification revision, software rejection
or reversal semantics (`account-agents.ts`, `identity-epoch-contract.md#exact-existing-callable-compatibility`).
Keep one-hop redirect resolution, existing terminal epochs/jobs and rollback. The durable publication contract
requires mapping plus both Search and Library participant custody; a locally guarded redirect or stored success
is **not** proof that dependent credits may publish. Imports retains original bindings and withholds credits
until its ordinary independently current canonical Person read succeeds; missing/wrong/conflicting/unavailable
identity remains withheld. This research does not implement or promise the pending publication integration.

## Ready implementation brief and remaining proof

> Extend `mergeSubjects(pool, options)` and its existing HTTP `subject.merge` binding with optional paired
> expectedIdentity evidence as above. Add only local keyed comparison/lock SQL and bounded review-read projection.
> Place evidence comparison after exact authorized replay lookup and before terminal/effect work. Preserve all
> unguarded/account-agent behavior. Refuse unsupported homes; no distributed coordination. Publish generated client
> types and connect Imports' existing authenticated transport to this command. Preserve original source bindings.
> Add native tests for both endpoints, stale-before-call, concurrent adoption in both lock orders, ABA, missing,
> wrong-type, conflict, unavailable, exact successful replay after mutation/redirect, changed payload, swaps,
> current authorization and zero effects on failure. Keep terminal publication acceptance independent.

Native acceptance belongs to `services/kernel/test/semantic/merges.test.ts`, supplemented by
`bulk.test.ts`, `bulk-provenance.test.ts`, `sql-placement-merges.test.ts` and account-agent native suites.
Use their actual `createPool`, `createKernel`, `createRealAccess` grants/bearers, `bootstrapRelease`, HTTP helpers
and ordinary `batchCommand` / `/v1/subjects:batchWrite` creates and proposals; use `decideCandidate` and
`adoptCandidates` (existing accept/adopt HTTP bindings) to establish selected identifier changes. These are real
migrated-PostgreSQL fixtures. `updateSubjectIdentity` establishes type changes; moderation/disclosure APIs establish
security ABA. Claim deletion is erasure maintenance, not an ordinary rebind; test it separately through that owner.
Coordinate two actual database connections with a narrow callback barrier after guard acquisition; an owner-local
internal test seam may pause there, but do not replace Pool or identity reads. Observe real lock contention under
the executor's 200ms lock timeout, release the barrier, and assert writer/merge results and persisted effects.

Unresolved evidence: the proposed lock SQL and review projection do not exist yet; no native race was executed.
Before adopting full maintenance coverage, audit mutable candidate/fact/adoption erasure paths and their fences;
use the bounded extra row locks where needed. Ordinary writer exclusion is code-grounded; universal exclusion
against every maintenance producer is not established by this report. Home eligibility must be shown with actual
routeKey-derived tuple homes, not all-zero fixtures. If a required producer cannot share these locks locally,
retain unavailable rather than widening this recommendation. Confidence: high on replay placement and ordinary
writer conflict; conditional on implementation/native schedules for the complete guard. Evidence of an unfenced
identity-changing writer, or review data unavailable on the authorized native reader, changes the required seams.

## Primary sources and provenance

- PostgreSQL source reused read-only at main checkout `.reference/library-shelf-maintenance/postgres`, commit
  `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`: `doc/src/sgml/mvcc.sgml`, sections
  `transaction-iso`, `explicit-locking`, `applevel-consistency`; licence `COPYRIGHT`, PostgreSQL License.
  [Pinned source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/mvcc.sgml)
  and [licence](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT).
  Inspected as data only; designs here are repository recommendations, not proposed copied code.
- Official [row-lock documentation](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)
  establishes lock conflicts/lifetime and changed-row errors under SERIALIZABLE. Official
  [isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-SERIALIZABLE)
  establishes serial-order semantics and SSI. The concrete schedules and guard design are deductions from those
  semantics and the native writer boundaries above, not claims that PostgreSQL supplies an identity precondition.
- Repository source paths above are primary evidence at the inspected checkout. Semantic's
  `README.md#identity`, `identity-epoch-contract.md#existing-caller-compatibility` and command `README.md`
  own behavior; this report is evidence only. No external implementation is imported or relicensed.
