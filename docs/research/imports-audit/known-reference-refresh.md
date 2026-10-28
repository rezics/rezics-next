# Known native reference handoff

Inspected implementation revision: `fb7ffaca82ead9baaa84e18992aae8644aa9ae78`.
This specification freezes two native controls in
`services/kernel/test/imports/known-reference-refresh.test.ts`. It changes no product,
registry, client, helper, existing acceptance test or frozen file.

## Scope and native evidence

The positive control completes a real Open Library work import, retains the successful
public create-or-resolve response and independently point-reads its own exact
`(openlibrary, /works/OL1W)` binding. A subsequent complete TSV dump contains the
unchanged work and an edition referencing it. The edition's item relation must use
that returned identity. Its unknown author remains `somevalue` with the native
`wdt:P648` identifier qualifier; no author source adapter is introduced.

The late control first imports the edition alone. A public editor accepts and adopts
its unresolved work candidate in a community Context. The same importer/session then
imports a complete dump containing the edition and work and retains the work's actual
claim response. It reimports precisely the same dump again. Resolution can happen
during learning or on that next import, but the latter must expose the real work
relation. Native revision `1`, converter revision `open-library@3`, source digest
and all source data remain unchanged. The new semantic body requires a distinct
command key and candidate. The editor accepts/adopts that actual retrieved candidate;
the old candidate and its original revision remain readable. A further identical
import must leave the candidate page unchanged, with no duplicate or replay conflict.

The control explicitly checks that source retraction does not silently remove the
editor's earlier communal adoption. It never assumes that source ownership grants
control over another Context's selection. The positive control also revokes the real
bulk grant and replays the actual committed request: retained bindings and receipts
must not bypass current authorization or disclose the work identity on denial.

Both cases use `openApiRuntime` and its ordinary `Importer` construction, production
TSV reader, source registration, converter, transport, kernel handlers, Auth and
Access. `openApiObserver` supplies a real public editor credential and API operations;
its record/history enumeration helpers are never called. Each candidate read names
one known subject/property, has a fixed limit of 100, and asserts there is no next page.
Only two fixed source records and three fixed native keys are involved. Claim
observation consists of successful public responses and exact own-binding reads.
There is no SQL seed, label lookup, global enumeration, fabricated UUID, history scan,
new source lookup endpoint or callback supplying desired identities.

The existing runtime places SQLite under `node:os.tmpdir()` and removes it on close.
The native check ran on host `b`; a read-only `stat -f -c %T /tmp` on that host
returned `tmpfs`. No alternate SQLite journal, resolver or fixture helper is added.

## Minimal owner seam

1. `services/importer/src/cli.ts:631`, `importerOptions` construction, supplies path and
   transport but no `identifierLookup`. The API runtime's normal construction likewise
   supplies no identifier callback. Successfully remembered own claims therefore do
   not reach the converter's `resolvedReferences` context through the default path.
2. `services/importer/src/importer.ts:539–541`, `plan()`, compares the acknowledged source row
   with the staged row and returns before conversion and `identifierLookup.resolve`.
   The optional resolver call is at line 562. Adding wiring alone cannot refresh the already acknowledged, unchanged edition.
   Refresh must examine only the record's bounded native reference keys and real own
   bindings, while retaining data-only source digest/revisions and replay identity.
3. `services/importer/src/record-bindings.ts:334`, `acknowledge()`, and line 404, `claim()`, already
   preserve the real create response's subject identity and permit exact owner reads.
   This is an observation seam, not a request to invent a resolver API or server-wide
   source-identity lookup. Nonlocal claims remain outside this control.

Conversion's existing native body-key coverage is retained unchanged.
`packages/conversion/src/open-library.ts` includes the bounded statement body digest
in proposal command identity and accepts real `resolvedReferences`; its pure tests
manually supply UUIDs. They cannot establish that a platform importer learns its own
earlier claim. This specification therefore exercises the missing default handoff
and unchanged-record refresh rather than duplicating that pure conversion proof.

Semantic remains responsible for current referenced-target reads and authorization.
Its `README.md` identity-reference contract requires independently anchored current
authorization and says an identity observation is not authorization evidence. Local
bindings must never replace that boundary; the grant-revocation replay checks one
explicit denial, not exhaustive hidden/redirected-target coverage.

## Contract interpretation

The conversion README currently says a real native resolution **may be supplied** in
`resolvedReferences`; the importer README describes identifier providers as separately
injected. Neither passage expressly commits the ordinary CLI to automatically handing
off its own successful bindings or revisiting unchanged records when they become known.
The executable expectations above freeze the requested local-own-claim behavior for
owner review. The manager must adopt that precise default/refresh obligation before
dispatching a product repair; they do not imply a global discovery service. This
wording gap is recorded rather than silently inventing a resolver contract.

## Verification

Tested product revision: `fb7ffaca82ead9baaa84e18992aae8644aa9ae78`, with only the new
test/report added. The exact executed test Git blob is
`1b556f2c589aa451e80dc0ee1e3c8c92b0cbc90d`. The delivery commit retains those test bytes.

The focused native command ran once after the final test edit:

```sh
bun scripts/worker-check.ts -- env KERNEL_CHECK_SKIP_STALE_CLEANUP=1 bun run --cwd services/kernel check test/imports/known-reference-refresh.test.ts
```

Result: **exit 1, 0 pass, 2 fail, 65 assertions, 2 cases in 1 file**, with no load
reruns. Both failures reached the intended native outcome assertions:

- Positive control, line 119: expected `{type:'value', content:<actual work id>}`,
  received `{type:'somevalue'}`. The actual returned work ID in that run was
  `01a183e2-8aee-768f-8d41-20fb390c080e`; it is evidence, never fixture input.
  The complete work import, actual response/binding agreement, complete second
  import, unresolved-author control, native revision and converter revision
  checks all preceded this assertion.
- Late control, line 196: the resolved candidate was `undefined` after learning
  the real work claim and successfully reimporting the unchanged edition. The
  earlier unresolved public accept/adopt completed. Distinct resolved identity,
  stable digest, final resolved accept/adopt, retained history and duplicate-free
  final replay assertions remain frozen **but were not reached**. Likewise the
  positive control's final revoked-grant replay was not reached. These are not
  passing claims about the missing behavior.

Native log:
`.temp/goal/checks/worker-check-2026-10-28T18-57-30.848Z-9168b832.log`.
The remote runner warned that Git timing metadata was unavailable; it still ran
both cases and reached their assertions. This warning did not block the control.
These are failures against unchanged base product code, not regressions introduced
by this specification; native pass is not artifact acceptance.

The root typecheck command is `bun scripts/worker-check.ts -- bun run typecheck`.
An initial run caught two test-only union-narrowing errors; those were corrected
before the native run. The final run passed with **exit 0**, logged at
`.temp/goal/checks/worker-check-2026-10-28T19-00-32.947Z-246d59f7.log`.

Artifact acceptance passed with **exit 0** after the final report edit:

```sh
bun scripts/worker-check.ts -- test -s docs/research/imports-audit/known-reference-refresh.md
```

Delivery changes only the two declared paths. No additional owner notification or
outside-path covering check is required. The recorded native base failures remain
open for the imports owner; they do not block this specification's file acceptance.

## Sources and boundaries

Read: repository architecture, scope, imports Goal and development/verification
workflow; conversion and importer READMEs; Open Library converter/support contract,
source registry, importer planning/CLI and own binding implementation; public bulk
schema/handler; semantic identity-reference and relation-slot contracts; existing
Open Library source tests and imports API driver/tests; native API runtime, observer
and fixture; the prior Open Library and unversioned audit reports; worker-check and
kernel/root check drivers. No README cited a reference project's source for this
surface. No external research, reference checkout, legacy port or outside-path edit
was needed.
