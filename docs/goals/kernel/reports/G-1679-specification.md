# Semantic race interception and Global rating disclosure: implementation specification

Read-only investigation on 2026-10-11. Implementation line references below are
against `goal/g-1631`, commit `bb74465fe21f9d0e299e9918e89718bc11519653`.
The investigation checkout starts at `07338f583`; it does not contain that
branch's retryable-refusal changes. No product code or test was changed.

Both reported failures have causes predating the branch. The semantic test
intercepts an authorization query before admission and fails its own assertion.
The Global rating test admits writes through explicit grants but supplies no
baseline authority to disclose a private stale head. Keep the 409 semantic
expectation; repair the hook. Keep authority before head disclosure; repair the
rating fixture and distinguish its unauthorized alternate persona.

Classification follows the existing kernel briefs: A = incomplete or wrong
function/qualification, B = can follow opening, C = defer. Both repairs below
are A. They fit one proposed Luna/max implementation session on `goal/g-1631`;
session fit is an estimate, not an implementation measurement. No new mechanism,
migration, route contract, model revision or native image build is needed.

## 1. A — Intercept the semantic ownership query after admission

**Cause in one line:** `6022d66c8` added a pre-admission server-selected capability
query that accidentally matches the existing-type race hook introduced by
`cdf346e2d`; the hook's missing-admission assertion becomes a generic route 503.

### Exact path to the failure

The loop has five seams (`semantic-change-race.test.ts:29-30`). The collision is
the fourth, `existing-type`, not native CAS or replay:

1. The proxy at `tests/qa/integration/semantic-change-race.test.ts:59-65`
   selects any query containing the target, `SELECT ?type WHERE` and
   `VALUES ?type` for that seam.
2. `services/main/src/modules/semantic/admitted.ts:76-85` checks the restore
   fence and Account, then awaits `selectedCapabilities` at line 78, before
   `access.register` at line 85 and `access.claim` at line 91.
3. `services/main/src/modules/semantic/selected-capability.ts:25-30` issues
   exactly such a query: target in `VALUES ?resource`, `SELECT ?type WHERE`,
   and `VALUES ?type`. It asks for retained Event/Offer/Product types to select
   platform exposure. It is not the semantic ownership query.
4. The proxy calls `commitWinner`, sets `intercepted = true` at test line 48,
   and at lines 50-52 expects the loser's Access row to be `claimed`.
   Registration has not happened, so the selected rows are empty. The assertion
   throws before the winner write at line 55. This also explains why
   `expect(intercepted).toBe(true)` at line 77 succeeds.
5. The exception is an **`Error`**, a Bun assertion failure from
   `expect(...).toEqual(...)` (the standalone route fault records
   `error.class: "Error"`),
   not a native `CommandRejected`, `AdmissionUnavailable`, or a
   `StaleSemanticHead`. It happens before the admitted wrapper's `try` at
   line 88. POST `/v1/semantic/changes` catches it in
   `services/main/src/routes/semantic.ts:129`, calls `semanticError`, whose
   unrecognized-error fallback at line 75 calls `commandError`.
   `services/main/src/routes/problems.ts:141-147` logs
   `main.route.dependency_unavailable` and returns **503
   `dependency_unavailable`**, with `Retry-After: 1`.

The newly added catch at `change.ts:565-577` cannot handle this exception:
`changeSemanticComponent` has not been dispatched and the exception is not a
native `unknown-profile` rejection. The test has not actually lost an admitted
head at this interception point.

### Exact implementation change

Change only the existing-type branch of `ownerQuery` at
`tests/qa/integration/semantic-change-race.test.ts:60-62` to require the concrete
ownership subject pattern as well:

```ts
query.includes('SELECT ?type WHERE')
  && query.includes('VALUES ?type')
  && query.includes(`${iri(target)} a ?type`)
```

The intended query at `modules/semantic/change.ts:479-482` uses that concrete
subject. The pre-admission capability query uses `?resource a ?type`, so it no
longer matches. Preserve the predicate-query hook, after-admission hook and
write-CAS hook. Give the assertion failure seam context so later failures name
the seam, rather than requiring another trace through a shared status assertion.

**409 remains the right expected result** once the hook executes at its intended
post-admission ownership seam. The test grants read/edit at lines 40-41; its
winner then moves the named head. `sealStale` at `change.ts:623-633` retains a
cancelled receipt and winning head; `command.ts:116` throws `StaleSemanticHead`;
`routes/semantic.ts:61-64` emits 409 `stale_head` with that head. Keep all terminal
Access sealing and replay assertions. Do not weaken the status expectation to
503 or bypass server-selected capability admission.

**Class A reason:** an existing concurrency qualification no longer exercises
its declared admitted race after a legitimate authorization preflight was added.
The test defect conceals the real ownership/CAS qualification.

### Proving tests

- Corrected `tests/qa/integration/semantic-change-race.test.ts`: all five seams
  return 409 with the winner; Access is sealed/cancelled; the retained terminal
  says stale-head; replay stays identical after a later successor; a genuine
  ownership conflict at the unchanged head still returns 422 `reserved_owner`.
- `services/main/tests/platform-selected-capability.test.ts` and
  `tests/qa/integration/platform-selected-capability.test.ts`: keep the
  pre-admission retained-type exposure gate, including removal of closed types.
  These are affected follow-up proofs, not tests run by this investigation.

History evidence: `git log --all -S 'resolvedSemanticCapabilities' --
services/main/src/modules/semantic/admitted.ts
services/main/src/modules/semantic/selected-capability.ts` identifies
`6022d66c8` (2026-10-07, G-1249); the race test and ownership-head guard are in
`cdf346e2d` (2026-10-05). The native retryable-refusal branch did not introduce
the collision.

## 2. A — Separate rating write admission from private head disclosure

**Cause in one line:** `e37d3f88a` added live baseline-member disclosure gates to
Global stale responses, but RATE06's `3b11f948b` fixture/expectation still uses
unverified, unprovisioned Personas; `bb74465fe` removed only the first gate and
therefore leaves the same final 403.

### Which check refuses first

The alternate persona `a2` **is admitted to write**. Test lines 137-139 grant
`rating.observation.set` representation and permission. The explicit-grant path
in `services/main/src/modules/access/admission.ts:1337-1352` recognizes those
records. `modules/rating/global-admitted.ts:63-66` registers the command; its
principal-based slot already has `a`'s opinion. The sealed cancelled receipt is
translated by `modules/rating/global.ts:196-201` into `StaleRatingObservation`.
There is no missing Realm standing or role at this step.

The route then applies disclosure authority:

- In the branch, `routes/rating-global.ts:95-100` verifies Account and resolves
  the active private principal, then selects only its own slot.
- After fetching its head, line 117 calls `canReadAsBaselineMember`; line 118
  returns 403 `authority_denied`.
- The **first false predicate** inside that method is
  `!principal.emailVerified` at `access/admission.ts:508-509`. The Persona IRI
  passes the other input check.
- `tests/qa/support/rating-account.ts:42-46,52-66,94-105` signs users up without
  email verification. Account introspection reads the live flag at
  `services/account/src/introspection.ts:61-65,73`; Main includes
  `emailVerified` only for true at `modules/account/verify-assertion.ts:152-153`.
  The repository already proves this exact signup behavior in
  `tests/qa/integration/access-baseline.test.ts:70-76`, and supplies verification
  by updating the isolated Account row at line 49.
- Even after verifying email, `a2` lacks an active Person provision and
  `agent.control`: the fixture inserts only `authority_subject` and action
  grants. `modules/access/baseline.ts:118-138` explicitly rejects an ordinary
  representation as Person custody. `provisionFixtureAuthor` supplies native
  graph author state for `a`, not Access Person custody for any Persona.

The current code's **403 is the correct result for this fixture**. Private head
disclosure requires current authority; ownership of a private counting slot
alone is not the existing disclosure contract. Write admission and disclosure
admission are different checks. Existing
`services/main/tests/rating-order.test.ts:143-168` proves authorized stale/replay
=> 409/current revision position and denied baseline => 403/no currentHead.

### Exact implementation and expectation correction

Two coordinated changes finish the whole file; changing line 165 alone would
leave its later race and withdrawn-head expectations failing.

1. In `services/main/src/routes/rating-global.ts:95-100`, restore the initial
   `canReadAsBaselineMember(principal, body.actingSubject)` check immediately
   after Account verification and before principal/head lookup. Return the
   existing 403 `authority_denied` if false. Keep the final recheck at
   lines 117-119 to detect authority loss during the lookup. Keep slot selection
   derived solely from the authenticated active principal.
2. In `tests/qa/integration/rating-global-synthesis.test.ts:35-74`, make
   `a`, `b`, and `c` valid baseline Personas while leaving `a2` deliberately
   without baseline custody:
   - Pass the existing default rating OAuth scope string plus `agent:create`
     as the second argument of this file's `ratingAccount` call. Change no
     shared Account fixture default.
   - Open a small Pool against **the cloned** `databases.urls.account` and
     update `"user"."emailVerified"` for `identity.a.id`, `identity.b.id`, and
     `thirdId` before using them for baseline disclosure. Close this local Pool
     in `finally`. Introspection checks the current flag on every verify;
     token renewal is not required (`access-baseline.test.ts:47-50,73-77`).
   - After constructing `environment`, construct
     `new AgentProvisioning(accessPool, environment)` from
     `services/main/src/modules/agent/provision.ts`. For each of a/b/c call
     `provision(identity.verifier, bearerRequest, { kind: 'person', displayName },
     randomUUID())`, where `bearerRequest` carries that user's existing token.
     Its exact signature is lines 190-197; it verifies `agent:create` itself.
     Assert `state === 'active'` and use the returned Agent as that Persona.
     Keep the existing explicit principal IDs: the owner reuses them by
     `(account_issuer, account_subject)` at lines 80-86.
   - Replace the a/b/c synthetic IRI construction and manual authority-subject
     inserts with these returned IDs. Keep only the synthetic a2 authority
     subject, plus its existing rating grants. Remove this file's redundant
     `provisionFixtureAuthor` call/import for a: the Agent owner already creates
     native Person state and active Access custody/control
     (`agent/provision.ts:154-167`). Keep all rating-specific grants.
3. At test lines 164-165, give a2's first write a retained key and assert **403
   `authority_denied` with neither `currentHead` nor `sourcePosition`**. Verify
   the existing opinion is unchanged, e.g. replay a's original key/body and
   compare its original revision. Query the exact a2 admission by principal,
   action and key: assert sealed/cancelled, and use the existing
   `readStandingRatingReceipt(environment, admissionId)` to assert
   cancelled/stale-head. Add a fresh authorized `globalSet('a', 1)` with null
   expected head: assert 409 `stale_head`, `currentHead: a.observationRevision`
   and the original success response's source position. a2's inability to add
   a second opinion is
   retained without disclosing a's head to an unprovisioned Persona.
4. Preserve the **authorized** 409 cases: c's concurrent first-write loser at
   lines 167-173, b's withdrawn predecessor at line 214, and the same-key
   idempotency conflicts. a/b/c now have the required disclosure prerequisites.
   Keep population, cost, recovery, private-counting-identity and synthesis
   assertions. Provisioning happens before their metered writes.

The removed initial gate is not right to keep. A final gate alone can let
`rating_revision_unavailable` at lines 113-115 answer before authority denial
when the stored head evidence is malformed or erased. Restoring the first gate
preserves authority-before-staleness and authority-before-head-evidence errors;
the final gate preserves revocation during a lookup.

**Class A reason:** RATE06's fixture lacks disclosure prerequisites required by
the current owner contract, and the branch partially removes a required gate
instead of repairing that mismatch. Do not lower the live disclosure policy to
make action-specific test grants equivalent to Person custody.

### Proving tests and history

- Corrected `tests/qa/integration/rating-global-synthesis.test.ts`: a2 denied
  without disclosure; one opinion per private principal remains; authorized
  first-write race and withdrawal restoration retain 409/current-head behavior;
  the existing synthesis and bounded-cost assertions still pass.
- `services/main/tests/rating-order.test.ts:143-168`: preserve the current-head
  revision position on authorized stale/replay, denied => 403, and erased
  evidence => 503. Add denied **and** erased together: 403 with no head must win
  before lookup. Add loss of authority during the head query: the final
  recheck must return 403. These tests distinguish both gates' purposes.
- `tests/qa/integration/access-baseline.test.ts`: existing evidence for verified
  email, Person custody and revocable live authority; do not rewrite its policy.

`git log --all -S "code: 'stale_head'" --
tests/qa/integration/rating-global-synthesis.test.ts` identifies `3b11f948b`.
`git log --all -S 'authority_denied' -- services/main/src/routes/rating-global.ts`
identifies `e37d3f88a` and the partial removal in `bb74465fe`.
The Person/control proof was introduced by `8cc2f6c6e`; the
`canReadAsBaselineMember` method with its email predicate by `4981752b0`.

## Branch changes to retain or remove

| Change in `bb74465fe` | Decision and evidence |
| --- | --- |
| `AdmissionLockBusy` and PostgreSQL `55P03` translation in `access/admission.ts:164-167,267-279` | Keep. `admissionError` translates command-transaction failures; all other SQL failures still become `AdmissionUnavailable`. A held lock is contention, not evidence that authority is absent or a dependency failed. |
| `routes/problems.ts:394-396`: named 409 `admission_busy`, Retry-After 1 | Keep. It gives the distinct lock class an explicit same-request retry outcome; do not widen generic `AdmissionUnavailable`. |
| Lock-class propagation in rating context, Global context/observation, standing observation, policy, question presentation, semantic admitted wrappers | Keep. Their broad pending-operation adapters must not erase a known retryable refusal. |
| `modules/rating/target.ts:216-219` recognizes the translated lock class | Keep. That adapter already owns `rating_write_busy`; recognize both native SQL and translated lock forms rather than inventing another rating mechanism. The brief reports `rating-gate` passes; its lines 216-233 assert held-gate retry and later same-key success. |
| Removed first disclosure gate in `routes/rating-global.ts` | Restore as specified above; keep the final recheck and principal-derived slot. The slot was already principal-derived before the branch. This removal did not fix RATE06 and changes denied-plus-corrupt precedence. |
| Native `unknown-profile` stale-head catch in `modules/semantic/change.ts:565-577` and new `CommandRejected` import | Remove this unsubstantiated addition for this repair. Native `CommandService.java:297-307` emits unknown-profile for missing/mismatched profile/hash/shape, before graph execution, not for a lost CAS. Its guarded-write path returns guard-unmatched when no receipt was created (:1039); existing post-write stale sealing at `change.ts:578-590` already owns CAS classification. This report found a fixture assertion failure, not a native profile rejection. An independent profile/head race contract would need its own evidence and test before changing availability precedence. |

Removing that native catch does not mean changing the generic native problem
mapping: preserve genuine profile unavailability as 503 and real invalid profile
validation as its existing typed refusal. Do not broaden `CommandRejected` into
stale-head solely because a test expected 409.

## Reproduction and limits

Only the two requested integration files may be reproduced by this investigation,
using `bun scripts/goal/goalctl.ts test <file>` with
`REZICS_QA_ARTIFACT_ROOT=.temp/qa`. No fault-recovery rating file was inspected,
and no product, test or generated file was edited. The translated historical
chain artifacts are absent from this worktree; the earlier failure outcomes in
the brief are supplied evidence, not newly observed historical logs.

The standalone semantic reproduction completed:

- Command: `REZICS_QA_ARTIFACT_ROOT=.temp/qa bun scripts/goal/goalctl.ts test
  tests/qa/integration/semantic-change-race.test.ts`.
- Run `20261011t101002-9eaf34`, source `07338f5835a4e1b27ee68b802eeb9f2fcf9db549`,
  stable source, **FAIL**: line 78 expected 409, received 503; 0 pass/1 fail,
  52 assertions, 10.5 seconds in the integration body. The log records
  `main.route.dependency_unavailable`, `error.class: "Error"`.
- Evidence: `.temp/qa/20261011t101002-9eaf34/logs/integration-1.log` and
  `.temp/qa/20261011t101002-9eaf34/summary.md`. Startup/slot wait was 195 seconds;
  it is separate from the integration body. An earlier invocation
  `20261011t100831-a7132d` was cancelled while waiting, to set the requested
  `.temp/` artifact root; it ran no test body. Its wait log was moved under
  `.temp/qa/`.

The log intentionally reports an error class rather than an internal assertion
stack; the exact failing assertion and fourth-seam collision are established
by the source path above. The new run is on this investigation checkout, not an
execution of `bb74465fe`; branch conclusions use its exact git objects and the
brief's supplied branch failure evidence. No fix was executed or qualified by
this read-only investigation.
