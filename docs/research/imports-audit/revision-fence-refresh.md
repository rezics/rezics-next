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

The first actual local ledger run reached all 28 cases: 27 passed, with 7,842 assertions. The first failure was
`fence keys do not suppress another source record or field group`: after a fenced transition to the second
converter, switching back retained an old matching first-converter candidate instead of producing a fresh
proposal. A focused rollback regression was added and committed before the follow-up production correction;
it reproduced the missing public proposal. The correction checks the acknowledged converter transition and
the current run's exact candidate signature as well as the producing revision.

An independent read-only review of the implementation revision found no blocking provenance, fence, identity,
recovery or statistic-retention defect. Native authorization/disclosure evidence remains with acceptance.
