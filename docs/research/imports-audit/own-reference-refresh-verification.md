# Own-reference refresh verification

Implementation revision: `0b648d744bb80da17a70a3907233fab3168b9112`. Latest verification revision:
`c79e538dfd`. The frozen native acceptance was not edited; its SHA-256 is
`9c0ec65033be4f94562f13a986bbb5873b5ea3b14f50d105bfc3bd4736ea0e51`.

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

## Evidence

The latest frozen native command ran once on `c79e538dfd`:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/known-reference-refresh.test.ts
```

It produced **1 pass and 1 failure**. The first native flow passed: it created and retained the real work claim;
resolved the edition relation to that returned subject ID; preserved the unknown author as `somevalue` with its Open
Library qualifier; retrieved and adopted the actual target-addressed candidate; verified stable replay; and confirmed
grant-denied replay returned 403 without disclosing the ID.

The late-learning flow failed while relaying the subject partition after its first adoption: the frozen helper
received `delivered.status === "busy"` and asserted that the relay was not busy. That invocation therefore did not
reach the later transition or assertions. An earlier completed run on this implementation reached the resolved
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

The root typecheck completed successfully with exit status 0 on the same product revision. The previously passed
import-session and deferred-cover-recovery focused suites were not rerun because no product code changed after those
results.

## Sources read

Read `docs/architecture.md`, `docs/scope.md`, the development workflow and Goal index, the imports capability contract,
the importer README, the existing known-reference report, the frozen native acceptance, Open Library converter and
context types, source registration and configured aliases, importer planning, run-store signatures, exact
`RecordBindings.claim` and candidate APIs, and semantic relation-slot/candidate-listing contracts. No reference
project or legacy source was consulted. No files outside the declared paths were changed.
