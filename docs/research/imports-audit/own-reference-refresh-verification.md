# Own-reference refresh verification

Implementation was tested on base revision `ef2a1f3e3fc42b7ea2580e2ca8aaa16c1483835a` plus the reviewed working-tree
changes. The frozen native acceptance remains byte-for-byte unchanged; its SHA-256 is
`8cce3c28e9bd9ad933a7b9881f3af320c1d337129e20e65c10e19cc77ec5635b`.

## Implementation

The default importer derives at most 64 Open Library relation keys from the sanitized projection and point-reads each
through `RecordBindings.claim` under the configured source alias. Only `bound` claims enter `resolvedReferences`.
Explicit identifier providers keep precedence and retain their input/output contract. The importer stores a bounded
signature of relation-key-to-own-claim outcomes with each resolved run entry. An unchanged record is replanned only
when that signature changes. A run entry already resolved in its immutable generation is left alone; a later input
pass performs any newly enabled refresh. Source revision, digest, converter revision, bootstrap request bytes and
receipts are not rewritten.

## Evidence

The required native command ran once:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/known-reference-refresh.test.ts
```

It failed with 0 passes and 2 failures after both intended flows reached their later candidate-page reads. In the
positive flow, the completed work import returned and retained its real claim, then the completed edition import
retained the unknown-author `somevalue` and native identifier qualifier; the property-only candidate page returned
zero rows where the frozen case expected one. The real-value proposal and revoked-grant replay assertions were not
reached. In the late flow, the unresolved edition candidate was read and accepted/adopted by the editor, the work
claim was learned, and the identical edition/work dump completed; the property-only candidate page did not expose a
resolved candidate. The resolved candidate accept/adopt, old-candidate history, stable replay, and grant-denial
assertions were not reached. Native evidence does not establish that those later outcomes pass.

The failure is a frozen-test/spec boundary conflict. The frozen helper lists candidates by subject and property
without a slot. `services/kernel/src/semantic/candidates.ts` defaults that request to `slotId(subject, property)`;
`services/kernel/src/semantic/slots.ts` defines that property-level slot. The semantic contract in
`services/kernel/src/semantic/README.md` says a resolved relation is stored in its target-keyed slot and a later
resolved statement does not move the earlier unresolved candidate. Therefore the property-only page cannot discover
the resolved candidate required by the frozen test. The importer cannot select or forge a slot through its public
proposal contract, and this task excludes a kernel/server API change and any frozen-test edit. No replacement
candidate, synthetic identity, SQL seed, or lookup fallback was used.

Local evidence passed once:

```sh
bun scripts/worker-check.ts -- bun test services/importer/tests/own-reference-refresh.test.ts services/importer/tests/import-session.test.ts services/importer/tests/deferred-cover-recovery.test.ts services/importer/tests/deferred-cover-recovery-extra.test.ts
```

Result: 12 tests passed across four files, including exact configured-alias point reads, same-file ownership and
reopen, immutable uncertain-request replay, and deferred-cover recovery. The new local test exercises the bounded
identity lookup seam; it does not mirror the native API flow.

The required root typecheck passed on its second attempt:

```sh
bun scripts/worker-check.ts -- bun run typecheck
```

The first attempt failed in generated-code startup with `Lix worker did not acknowledge request receipt within
30000ms`; the retry exited 0. The native runner also reported unavailable Git timing metadata, but it executed both
cases and reached the candidate-page assertions.

## Sources read

Read `docs/architecture.md`, `docs/scope.md`, the development workflow and Goal index, the importer README, the
existing `docs/research/imports-audit/known-reference-refresh.md`, the frozen native acceptance, Open Library
conversion/context types, source registration and CLI alias construction, the importer plan and run store, exact
record-binding claim APIs, and semantic relation-slot/candidate listing contracts. No reference project or legacy
source was consulted. No files outside the declared paths were changed.
