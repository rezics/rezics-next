# Own-reference refresh verification

Implementation revision: `0b648d744b3ed6f34bf435866606c102d1b0707d`. Current frozen installation:
`fb7100272a22927635dae0b035857ac470b1be20`. Its SHA-256 is
`f46b81a106c65ed6a37732845c89c94c239affa69105ba47d67fc2d94584dc89`, exactly matching the
read-only controller registry, worker bytes and approved raw file. No worker formatting or amendment was applied.
The controller committed the observation correction; this continuation preserves all frozen bytes.

## Delivered behavior

The default `Importer` resolves at most 64 Open Library author/work keys from the sanitized projection through exact
`RecordBindings.claim({ source: configuredAlias, external_id: nativeKey })` point reads. Only successful `bound`
claims supply native IDs. Explicit identifier providers retain precedence and their existing input/output contract.
The durable `run_reference_signatures` table stores one outcome signature per acknowledged record. An unchanged
record is reconsidered only when that bounded signature changes. Existing bootstrap command bytes, key and public
receipt remain immutable through close/reopen and dependency learning.

When a dependency changes, the planner retains existing candidates whose complete semantic statements still match
the new conversion and only replaces changed bodies. Thus an unchanged unknown-author `somevalue` does not get a
second candidate while the work relation refreshes. Source revision, digest and converter revision remain unchanged.
The stored dependency signature is importer coordination metadata; it does not add account, bearer or owner data.

## Current verification

The latest authorized amendment factors the existing proposal/native property conditional into
`const property` immediately before the same generic `toContainEqual` call. The complete one-hunk
diff adds that binding and replaces the inline conditional with its name; the compared objects,
assertion order and business assertions are unchanged. The approved raw, installed canonical,
worker and read-only controller registry hashes all match the SHA-256 above. No worker formatting
or frozen edit was necessary.

The mandated root typecheck ran once first on committed revision
`39e12edb2885ffd974fa849f9de53b0fa3d21ab1`:

```sh
bun scripts/worker-check.ts -- bun scripts/typecheck.ts
```

Check `95993fff-f007-4bce-830a-78972966d876` reached terminal **exit 0**. All 13 workspaces
completed without errors. Log:
`.temp/goal/checks/worker-check-2026-10-29T18-18-52.273Z-db91360d.log`.
The full frozen file now compiles; focused native acceptance is the remaining required check.
The earlier isolated compiler probe is not used as full-file evidence.
Runtime, storage and local regression bytes are identical to `c79e538dfd`, so the qualified local
bootstrap/reopen **2 pass, 16 assertions** and post-retention adjacent **11 pass, 158 assertions**
receipts below are reused. No production, shared-type, infrastructure or dependency change is made.

## Previous erased matcher generic verification

The preceding authorized correction added only the erased generic argument
`<Statement['qualifiers'] | NonNullable<BatchStatement['qualifiers']>>` to the existing
`toContainEqual` call. The one-hunk diff from `771aa0b7203c2285d03cca3d73548264db3b9450`
changes no received value, expected object, matcher method or executable assertion. Native read datatype,
proposal id-only properties, 16 relay calls, busy 5 ms sleep, fatal stopped status and read-zero readiness
are unchanged. The installed file already has the exact approved bytes; no further frozen edit is needed.

The root typecheck ran once, first, on committed revision
`4c13e0fec1ab0a942f82eac938c2ac0803fb6602`:

```sh
bun scripts/worker-check.ts -- bun scripts/typecheck.ts
```

Check `9d85a761-1c9d-47aa-9745-90892a3d466c` reached terminal **exit 1**, after
531.044 seconds queued and 68.244 seconds executing on a. Log:
`.temp/goal/checks/worker-check-2026-10-29T14-01-15.170Z-8be87762.log`.
All 12 other workspaces completed without errors; kernel reported only:

```text
test/imports/known-reference-refresh.test.ts(73,53): error TS2353: Object literal may only specify known properties, and 'data_type' does not exist in type '{ id: string; }'.
```

The approved erased generic changed the diagnostic from TS2769 to TS2353 but did not close the frozen
helper compile error. The exact qualifier object still fails compilation. The current ruling requires
stopping on a nonzero root compiler result, so **native acceptance was not started**. No native transition
or assertion was reached in this continuation. The frozen preservation rule forbids a further helper
amendment; changing the production read schema or proposal shape would contradict their existing contracts.
This is a frozen acceptance/type conflict, not an infrastructure failure.

The same check ID was resumed through terminal status; one wait returned 75 while the check remained
running, then the next wait observed exit 1. No retry, infrastructure rerun or live check remains.
The native file retains its exact approved/registry hash. Removing only the approved generic reproduces
old SHA-256 `c2a3e80acba22a911bc2d118b07286ceb7494c6c528da7be4572c8fa76b65bf7`, verifying
the complete one-hunk amendment contains no other byte changes.

Reuse the unchanged local bootstrap/reopen **2 pass, 16 assertions** and post-retention adjacent
**11 pass, 158 assertions** evidence below. Runtime, storage and local regression bytes remain identical
to `c79e538dfd`; none was rerun. Only the owning README and this report were changed by the worker,
within the declared paths. No rebase, merge, infrastructure, dependency or shared-type change was made.
The final documentation commit records this result and does not change any tested bytes. The earlier
native receipts below retain their reached transitions and honest failure limits; none proves this
latest frozen installation passed.

## Previous three-type-edit verification

The controller installed the authorized three type-only edits: import native `Statement` with `import type`,
type `Candidate.statement` as `Statement`, and accept `BatchStatement | Statement` in the unresolved helper.
The complete three-hunk diff changes no executable expression or assertion. The exact installed worker hash
matches the approved raw hash and the read-only frozen registry entry. No worker formatting was applied.
The existing `SnakSchema` and `StatementSchema` require the native read datatype; portable proposals remain id-only.
Both required checks ran once on committed revision `331553560c92ba8b0085125ea5dfad33e69d513c`.
Both ended with exit 1 at the same frozen helper diagnostic before either native case executed:

```text
test/imports/known-reference-refresh.test.ts(73,53): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Object literal may only specify known properties, and 'data_type' does not exist in type '{ id: string; }'.
```

The authorized `BatchStatement | Statement` annotation does not close the matcher overload error.
The expected native qualifier still fails contextual typing at `toContainEqual`. Changing the native read
schema or portable proposal shape would violate their existing contracts; the later authorized matcher generic was not installed in that run. The worker preserved the installed file. This is a frozen acceptance/type conflict,
not a tooling failure, and no current native transition or successful native assertion is claimed.

| Required check | Terminal result | Receipt |
| --- | --- | --- |
| Focused native acceptance | Exit 1, compile failure before cases; 4,424.201 seconds queued, then ran on a | `c24ed1bd-2d86-4674-babf-06c56216869e`; `.temp/goal/checks/worker-check-2026-10-29T12-05-00.809Z-9efe7750.log` |
| Root typecheck | Exit 1, same kernel test error; all other 12 workspaces completed without errors; 1,199.816 seconds queued, then ran on b | `3e9d7874-a93b-4f1e-9f97-f79f0aa0bad7`; `.temp/goal/checks/worker-check-2026-10-29T12-08-12.564Z-c501505c.log` |

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/known-reference-refresh.test.ts
bun scripts/worker-check.ts -- bun scripts/typecheck.ts
```

Every queued wait resumed the same check ID until terminal status; no check was restarted or remains running.
There was no infrastructure rerun. The README and report record these results; their subsequent documentation-only
commit does not change the tested product, local regression or frozen acceptance bytes.

Importer runtime, storage and the local regression are byte-identical to `c79e538dfd`. Reuse the qualified
local 2-case/16-assertion receipt and post-retention adjacent 11-case/158-assertion receipts below; no rerun is
required for this erased-type correction. No rebase, merge, host change or dependency change was performed.

## Previous combined-file verification

Native and first recovery invocation revision: `2d8d4ee5fda226a3ebbaf52a39ef9b0c6616880d`.
Root typecheck and missing extra-file invocation revision: `c3c8c337d35f4df3d150c87421418c31feeff8d3` (documentation changes only).

The focused native command ran once, check `8e7e4f69-f2ee-4f2c-9705-2b0085447826`, and ended
with exit 1 before executing either native case. Log:
`.temp/goal/checks/worker-check-2026-10-29T10-32-03.500Z-b3752d91.log`.

```text
test/imports/known-reference-refresh.test.ts(72,53): error TS2769: No overload matches this call.
The last overload gave the following error.
Object literal may only specify known properties, and 'data_type' does not exist in type '{ id: string; }'.
```

The approved frozen helper declares `statement: BatchStatement`, so `toContainEqual` contextually types the
expected qualifier as a portable proposal snak. Its newly approved native-only property object contains
`data_type`, which that proposal type excludes. Native `SnakSchema` and `StatementSchema` do require that
read datatype; changing either production schema to accommodate this helper would redefine the contract.
No native transition was reached in this run. The frozen-file preservation requirement prevents correcting
this local helper typing without another authorized frozen correction. No worker amendment was made.

The requested adjacent invocation, check `1e62a394-38a6-462f-8c60-211852017650`, exited 0 with
**10 pass, 138 assertions**, but ran only import-session and deferred-cover-recovery. Its third argument
mistakenly named nonexistent `deferred-cover-extra.test.ts`, which Bun silently ignored. Log:
`.temp/goal/checks/worker-check-2026-10-29T10-33-38.618Z-acdb7e8a.log`.
The actual `deferred-cover-recovery-extra.test.ts` ran separately in check
`c007b425-122b-4068-a634-12bc09f022c7` and ended **exit 0, 1 pass, 20 assertions**, after waiting
496 seconds for admission. Log:
`.temp/goal/checks/worker-check-2026-10-29T10-36-36.629Z-f4124f68.log`.
Together these cover all three requested existing files once: **11 pass, 158 assertions**. This was a
command-selection correction, not a product fix. The two passing files were not rerun.

```sh
bun scripts/worker-check.ts -- bun test services/importer/tests/import-session.test.ts services/importer/tests/deferred-cover-recovery.test.ts services/importer/tests/deferred-cover-extra.test.ts
bun scripts/worker-check.ts -- bun test services/importer/tests/deferred-cover-recovery-extra.test.ts
```

No importer runtime, storage API, conversion, shared definition or local own-reference regression bytes have
changed since product `c79e538dfd`. Reuse the earlier local **2 pass, 16 assertions**; its later rerun ended
in transport before results. The previous root typecheck passed all 13 workspaces (receipt
`07-46-41.621Z-30884bbc`, check prefix `b1158554`). Other shared product/types in the current base differ
from that revision, so the mandated root typecheck ran once for this tree rather than extending that old proof.
Check `2514f6b1-33c0-4788-aee2-e459e4dee422` ended **exit 1**, with the same frozen-helper
TS2769 and no other reported type errors. All 12 other workspaces, including importer, completed without an
error; kernel reported that single error. Log:
`.temp/goal/checks/worker-check-2026-10-29T10-36-36.418Z-ae5a8010.log`.

```sh
bun scripts/worker-check.ts -- bun scripts/typecheck.ts
```

The combined frozen correction distinguishes proposal and native read property shapes and permits `busy` to
consume a relay call within the unchanged 16-call partition budget. Only `read` with zero envelopes establishes
readiness; `stopped` remains fatal. These authorized observation changes have not yet reached native execution.
The wrapper placed native acceptance on b and the adjacent command on c using inherited configuration;
no routing, host, dependency or infrastructure settings were changed.

All four started checks have terminal records; none remains running. The continuation changes only the
owning README and this report, within the declared paths. Importer runtime/local regression and all frozen
acceptance bytes remain unchanged. Delivery is blocked on the frozen helper typing, not on infrastructure.

## Earlier evidence

The previous frozen native command ran once on `c79e538dfd` with old frozen hash
`9c0ec65033be4f94562f13a986bbb5873b5ea3b14f50d105bfc3bd4736ea0e51`:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/known-reference-refresh.test.ts
```

Receipt `07-39-54.387Z-a2c9e002` produced **1 pass and 1 failure, 79 assertions**. The first native flow passed: it created and retained the real work claim;
resolved the edition relation to that returned subject ID; preserved the unknown author as `somevalue` with its Open
Library qualifier; retrieved and adopted the actual target-addressed candidate; verified stable replay; and confirmed
grant-denied replay returned 403 without disclosing the ID.

The late-learning flow failed while relaying the subject partition after its first adoption: the frozen helper
received `delivered.status === "busy"` and asserted that the relay was not busy. That invocation therefore did not
reach the later transition or assertions. Receipt `05-09-02.014Z-e5812714` (**1 pass, 1 failure, 145 assertions**), an earlier completed run on this implementation, reached the resolved
candidate transition, semantic key/body change with stable source metadata, old unresolved history, independent
community adoption, and stable replay, then failed its final unknown-author response-shape assertion: the public
candidate response contains qualifier property `{ id: "wdt:P648", data_type: "external-id" }`, while the frozen
helper expects `{ id: "wdt:P648" }`. No frozen test, converter mapping, kernel API or target admission was changed.

An earlier native attempt reached the later candidate listing with two `schema:author` candidates. The importer was
then corrected to retain unchanged semantic candidates during a dependency refresh; a subsequent completed run got
past that duplicate-candidate assertion before reaching the response-shape mismatch above.

The new local recovery regression passed in the prior attempt. Its required rerun in this continuation did not produce
a test result: after the wrapper's retry, transfer ended with
`curl: (56) OpenSSL SSL_read: OpenSSL/3.5.9: error:0A000126:SSL routines::unexpected eof while reading, errno 0`.
The same regression's earlier pass exercises the default importer with SQLite in the system temporary directory and
a durable native-shaped public receipt transport. It records the original edition bootstrap request and receipt,
closes and reopens the importer, learns the exact configured-alias work claim, repeats the unchanged edition,
verifies the resolved relation uses the actual returned work ID, and checks the bootstrap bytes/key/receipt and
resolved replay remain stable. This is local recovery evidence, not a substitute for the native permission and
adoption boundary.

The root typecheck completed successfully with exit status 0 on the same product revision. Earlier adjacent-suite
passes predate candidate retention and do not establish current recovery behavior.

## Decisions and bounds

Preserve existing semantically unchanged candidates and every immutable journal/bootstrap byte. Reuse qualified
local evidence because its relevant product/test bytes are unchanged. Current shared-base differences require a
fresh root typecheck and focused native acceptance after the authorized type-only correction; reuse the completed adjacent coverage. Do not rebase or merge this assigned branch. Existing Cost ceilings remain; candidate retention adds
at most C × Q full-statement comparisons, C ≤ 300 current owned candidates and Q ≤ 100 actual Open Library proposals,
with existing bounded statement bytes. This is local bounded work, with no new history scan or server query.

## Sources read

Read `docs/architecture.md`, `docs/scope.md`, the development workflow and Goal index, the imports capability contract,
the importer README, the existing known-reference report, the frozen native acceptance, Open Library converter and
context types, source registration and configured aliases, importer planning, run-store signatures, exact
`RecordBindings.claim` and candidate APIs, and semantic relation-slot/candidate-listing contracts, the native read schemas, the controller's earlier three-hunk type amendment and its latest exact erased matcher generic. No reference
project or legacy source was consulted. No files outside the declared paths were changed.
