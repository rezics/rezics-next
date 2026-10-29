# Own-reference refresh verification

Implementation revision: `0b648d744b3ed6f34bf435866606c102d1b0707d`. Current frozen installation:
`7067483fa8371b76b6e1ec6c6cb4e9df72de2b05`. Its SHA-256 is
`0df9043bf4316fe51014a836a680e902f0a84a7a9b6174622143d31479cc0077`, exactly matching the
controller registry and the approved combined raw file. No worker formatting or amendment was applied.
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

Tested revision: `2d8d4ee5fda226a3ebbaf52a39ef9b0c6616880d`.

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
Run the actual `deferred-cover-recovery-extra.test.ts` separately to complete that evidence without repeating
the two passing files. This is a command-selection correction, not a product fix.

No importer runtime, storage API, conversion, shared definition or local own-reference regression bytes have
changed since product `c79e538dfd`. Reuse the earlier local **2 pass, 16 assertions**; its later rerun ended
in transport before results. The previous root typecheck passed all 13 workspaces (receipt
`07-46-41.621Z-30884bbc`, check prefix `b1158554`). Other shared product/types in the current base differ
from that revision, so run the mandated root typecheck once for this tree instead of extending that old proof.

The combined frozen correction distinguishes proposal and native read property shapes and permits `busy` to
consume a relay call within the unchanged 16-call partition budget. Only `read` with zero envelopes establishes
readiness; `stopped` remains fatal. These authorized observation changes have not yet reached native execution.
The wrapper placed native acceptance on b and the adjacent command on c using inherited configuration;
no routing, host, dependency or infrastructure settings were changed.

## Earlier evidence

The previous frozen native command ran once on `c79e538dfd` with old frozen hash
`9c0ec65033be4f94562f13a986bbb5873b5ea3b14f50d105bfc3bd4736ea0e51`:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/known-reference-refresh.test.ts
```

Receipt `07-39-54.387Z-a2c9e002` produced **1 pass and 1 failure**. The first native flow passed: it created and retained the real work claim;
resolved the edition relation to that returned subject ID; preserved the unknown author as `somevalue` with its Open
Library qualifier; retrieved and adopted the actual target-addressed candidate; verified stable replay; and confirmed
grant-denied replay returned 403 without disclosing the ID.

The late-learning flow failed while relaying the subject partition after its first adoption: the frozen helper
received `delivered.status === "busy"` and asserted that the relay was not busy. That invocation therefore did not
reach the later transition or assertions. Receipt `05-09-02.014Z-e5812714`, an earlier completed run on this implementation, reached the resolved
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
fresh root typecheck; run the named native and adjacent coverage without repeating the two passing adjacent files. Do not rebase or merge this assigned branch. Existing Cost ceilings remain; candidate retention adds
at most C × Q full-statement comparisons, C ≤ 300 current owned candidates and Q ≤ 100 actual Open Library proposals,
with existing bounded statement bytes. This is local bounded work, with no new history scan or server query.

## Sources read

Read `docs/architecture.md`, `docs/scope.md`, the development workflow and Goal index, the imports capability contract,
the importer README, the existing known-reference report, the frozen native acceptance, Open Library converter and
context types, source registration and configured aliases, importer planning, run-store signatures, exact
`RecordBindings.claim` and candidate APIs, and semantic relation-slot/candidate-listing contracts. No reference
project or legacy source was consulted. No files outside the declared paths were changed.
