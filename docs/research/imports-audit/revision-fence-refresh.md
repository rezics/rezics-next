# Converter revision refresh verification

The supplied promotion failure reached three ledger assertions: explicit converter revision changes,
unchanged-refresh field fences followed by reconversion, and fence isolation. Each reconversion returned
`bulk-failed` instead of `committed`. Retention compared statements, subjects and field groups while ignoring
the converter revision recorded in the saved public proposal. No new native submission was used to rediscover
that supplied failure.

## Local reproduction

The focused regression was committed before production edits at
`48f423b1a61ec99eea93238229bb70cce2a243fc`. Running
`bun test services/importer/tests/revision-fence-refresh.test.ts` produced two passing and three failing cases
(201 assertions). The first failure observed `conversion-v1` in a retained candidate where a real
`conversion-v2` proposal was required. The fence case observed no fresh facts proposal for the unfenced record;
the VNDB case observed no new-converter proposal after a successful statistic write. Denied and interrupted
recovery already passed. These tests use the real HTTP adapter, Importer, RunStore and bindings with a local
protocol server; local server IDs and receipts do not claim native authorization or disclosure proof.

## Repair and decisions

Retention now additionally requires equality of the producing converter revision from the immutable prior
proposal and the freshly converted proposal. When the acknowledged converter changes, only candidates with
the current run's exact saved signature can be retained. This also handles converter rollback: a matching
older candidate left behind a field fence is still old work, not proof of the current refresh.
The existing subject, group, full-statement and one-to-one matching
rules stay intact. A revision mismatch follows ordinary owned retraction and fresh proposal planning with
run-specific stable keys; no empty acknowledgement or synthetic effect count substitutes for a proposal.
The existing bounded candidate lookup supplies all comparison evidence without reading history or rewriting
bootstrap requests. RunStore needs no interface or storage change.

Same-revision semantic retention remains valid for dependency refresh and acknowledged work in the current run.
VNDB statistic-only completion still follows a successful statistic write; denied/uncertain writes preserve
the completed baseline. A new converter revision also requires real proposals for VNDB, even if its statistic
write succeeds. Existing empty-plan, journal, deferred-cover and stale-run guards remain unchanged.

The regression checks multiple same-value records, exact source/record/field isolation, immutable prior journal
bytes and receipts, unchanged native revision/digest during reconversion, stable subject identity, fresh candidate
IDs and operation keys, owned retractions, reopened no-op and denied/interrupted recovery. Recovery supplies
newer input to verify that unresolved older envelopes drain byte-for-byte before that input can be consumed.
The only kernel runtime-file edit removes the assigned unused type import from `imports/erasure.ts`.

## Sources and limits

Read the existing ledger driver, ledger outcome wrapper and source-statistics fixtures, including their
same-revision statistic success/denied/lost-response cases; the ordinary source registration and transport;
the ledger converter/fence cases; the public API reconversion/adoption case; and the frozen native wrapper.
The local Bangumi records derive from `specs/fixtures/imports/api/bangumi.jsonl`, with equal scalar values
and no cover acquisition. No external reference implementation was needed or copied.

The native proof uses all 28 unchanged ledger cases and only the three existing public API cases selected by
the frozen wrapper through the existing ledger driver and native API fixture. It does not prove growth,
root typecheck, promotion, main integration or completion of the full Imports Goal. The controller owns those
checks. No declared-path exceptions are needed.

## Results

Initial implementation revision: `5288dbc8d27e54a02fff88c6967a70761888c263`.
Edited-file `oxfmt --check` and the direct
`node_modules/.bin/tsc --noEmit -p services/importer/tsconfig.json` passed.
The five focused cases and six existing source-statistic cases passed (369 assertions across the local invocation).
The focused same-value test observed fresh `conversion-v2` candidate IDs/keys for both native records,
unchanged source digest/native revision and subject, byte-identical prior bootstrap/proposal journals and receipts,
and retractions naming the prior owned candidates. The separate VNDB test retained semantic journals only for
the successful same-converter statistic refresh, then observed real `conversion-v2` proposals.

The initial local command also included `ledger-outcomes.test.ts`. Its child inherited the root stack-routing
preload and queued for a remote slot; the existing wrapper timed out at 120 seconds before any ledger assertion.
That invocation exited 1 with 11 passing local cases and one wrapper timeout. This is not a ledger pass or a
product assertion failure. An explicit scratch Bun configuration still inherited root routing and queued a
direct ledger invocation; it was allowed to finish. The local ledger proof instead imports the unchanged
specification in-process through a scratch test entry, retaining the existing driver and test-environment
isolation without requesting a native stack. The named native acceptance uses its unmodified managed command.
The queued direct invocation ultimately exited 1 before business assertions: remote placement omitted its
caller-supplied driver environment, yielding `IMPORT_LEDGER_DRIVER is required: bind production import state
reconciliation` in all 28 cases. It is setup failure evidence only, not a product regression or acceptance result;
the subsequent in-process local proof below supplies the required driver and passes every case.

The first actual local ledger run reached all 28 cases: 27 passed, with 7,842 assertions. The first failure was
`fence keys do not suppress another source record or field group`: after a fenced transition to the second
converter, switching back retained an old matching first-converter candidate instead of producing a fresh
proposal. A focused rollback regression was added and committed before the follow-up production correction;
it reproduced the missing public proposal. The correction checks the acknowledged converter transition and
the current run's exact candidate signature as well as the producing revision.

An independent read-only review of the implementation revision found no blocking provenance, fence, identity,
recovery or statistic-retention defect. Native authorization/disclosure evidence remains with acceptance.

Final production revision: `5f6ee518a1`. Edited-file formatting and the direct importer compiler both passed.
The final local command was:

```sh
IMPORT_LEDGER_DRIVER="$PWD/services/importer/tests/ledger-driver.ts" TMPDIR="$PWD/.temp" \
  bun test --timeout 30000 ./.temp/imports-ledger-local.test.ts \
  services/importer/tests/revision-fence-refresh.test.ts services/importer/tests/source-statistics.test.ts
```

The scratch entry contains only `await import('../specs/imports-ledger.test.ts')`, so all unchanged ledger cases
execute in-process with the ordinary production driver. Result: 40 passed, zero failed, 8,497 assertions:
28 unchanged ledger cases, six focused regressions and six existing source-statistic cases. All three originally
failing ledger cases passed, including rollback through the exact field fence. No native stack or effect
counter was substituted for these local outcomes.

The independent review continued on the final production revision and found no blocking issue in the
acknowledged-revision/current-run signature rule. It specifically checked that rollback cannot retain a
matching older candidate while acknowledged current-run work remains eligible for retention.

## Managed native acceptance

The single named submission tested `53493af0507a7b9f3d4ec90158cd36763cd895c4`, containing final production
revision `5f6ee518a1` and the final local proof. Its command was:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/revision-fence-refresh.test.ts
```

It waited for admission and completed with exit status 0, without a load rerun. Both frozen wrapper tests passed
(11 wrapper assertions); their unchanged count, zero-failure and zero-skip assertions establish these child results:

| Child suite or native case                                                                 | Result                            |
| ------------------------------------------------------------------------------------------ | --------------------------------- |
| All unchanged ledger cases                                                                 | 28 passed, zero failed or skipped |
| changed records and converter revisions append proposals while community adoption survives | Passed                            |
| takedown fences survive unchanged refresh payload changes restart and reconversion         | Passed                            |
| cover fences prevent reimport on unchanged and changed refresh and hide later disclosures  | Passed                            |

There was no final child failure. The public API reconversion case retrieved actual `conversion-v2` proposals
for the already-bound subject, retained native revision `2` and the changed input's original digest, preserved
all earlier proposals/revisions and the independently adopted `Community title`, and observed no extra subjects.
The two fence cases exercised the existing ordinary API fixture, including unchanged, changed and reconverted
inputs and later disclosure. Local exact-byte assertions separately preserve original bootstrap/proposal
requests, operation keys and receipt attachments; refreshed same-value candidates have new keys/IDs and
unchanged source revisions/digests. No fabricated effect counter or generic empty completion was used.

The managed check also passed its compiler and quality phases, writing 909 Reylo analyses. Its two wrapper
tests took 42.75 seconds; the managed command took 123.226 seconds after admission. Child stdout is intentionally
captured by the unchanged wrapper, so the log reports wrapper totals rather than standalone child assertion counts.
The check receipt and exact log path accompany the delivery result; operational identifiers are not copied here.
