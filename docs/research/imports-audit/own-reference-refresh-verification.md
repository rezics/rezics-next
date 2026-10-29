# Own-reference refresh verification

Implementation revision: `0b648d744bb80da17a70a3907233fab3168b9112`. The frozen native acceptance was not edited;
its SHA-256 is `9c0ec65033be4f94562f13a986bbb5873b5ea3b14f50d105bfc3bd4736ea0e51`.

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

The frozen native command ran twice during implementation. The final run produced **1 pass and 1 failure after 145
assertions**:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/known-reference-refresh.test.ts
```

The first native flow passed all assertions: it created and retained the real work claim; resolved the edition
relation to that returned subject ID; preserved the unknown author as `somevalue` with its Open Library qualifier;
retrieved and adopted the actual target-addressed candidate; verified stable replay; and confirmed grant-denied
replay returned 403 without disclosing the ID.

The late-learning flow passed the resolved candidate transition, semantic key/body change with stable source metadata,
retention of the old unresolved history, independent community adoption, and stable replay assertions. Its final
unknown-author check failed in the frozen helper: the public candidate response contains qualifier property
`{ id: "wdt:P648", data_type: "external-id" }`, while the frozen assertion expects `{ id: "wdt:P648" }`. The
converter's local proposal keeps the expected property shape; the additional field appears in the native candidate
response. This is the older native-field `somevalue` oracle noted in the contract. No frozen test, converter mapping,
kernel API, or target admission was changed to bypass it.

The first native attempt reached the later candidate listing with two `schema:author` candidates. The importer was
then corrected to retain unchanged semantic candidates during a dependency refresh. The final native attempt got
past that duplicate-candidate assertion and reached the response-shape mismatch above.

The new local recovery regression passed:

```sh
bun scripts/worker-check.ts -- bun test services/importer/tests/own-reference-refresh.test.ts
```

It exercises the default importer with SQLite in the system temporary directory and a durable native-shaped public
receipt transport. It records the original edition bootstrap request and receipt, closes and reopens the importer,
learns the exact configured-alias work claim, repeats the unchanged edition, verifies the resolved relation uses the
actual returned work ID, and checks the bootstrap bytes/key/receipt and resolved replay remain stable. The existing
37-line seam test still covers exact alias isolation. This is local recovery evidence, not a substitute for the
native permission and adoption boundary.

Root typecheck was attempted after the local regression. The first attempt stalled in `packages/ui`, then its
wrapper retry failed during SSH/transfer (`Session open refused by peer`, followed by an incomplete archive). A
subsequent attempt found and prompted correction of proposal-union typing in the new test, but its final verification
also stalled without log growth and its SSH retry ended with `Session open refused by peer` and an unexpected EOF.
The final root typecheck therefore has no passing result. Its failure is infrastructure evidence, not a claim that
the corrected tree typechecks.

## Sources read

Read `docs/architecture.md`, `docs/scope.md`, the development workflow and Goal index, the imports capability contract,
the importer README, the existing known-reference report, the frozen native acceptance, Open Library converter and
context types, source registration and configured aliases, importer planning, run-store signatures, exact
`RecordBindings.claim` and candidate APIs, and semantic relation-slot/candidate-listing contracts. No reference
project or legacy source was consulted. No files outside the declared paths were changed.
