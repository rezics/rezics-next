# Account-key CLI acknowledgement recovery

The frozen native outcome is
[`cli-ack-recovery.test.ts`](../../../services/kernel/test/imports/cli-ack-recovery.test.ts).
Its connected caller is [`cli-ack-recovery-fixture.ts`](../../../services/kernel/test/imports/cli-ack-recovery-fixture.ts).
Native acceptance passed through the managed command; the receipt and observed revisions are recorded below.

One `openApiRuntime` owns both Bangumi and Open Library journeys, ordinary Auth, native Access, public APIs and
registered media worker. The caller uses `identitySupport` and `openApiObserver` through their existing exports.
An operator key is staged, approved and applied through Auth; the CLI reads its mode 0600 private JWK and the same
SQLite path in tmpfs on every invocation. Diagnostics and evidence exclude credentials. No authorization, rights,
source registration or kernel API extension is introduced.

Both providers first establish a real baseline. A separate observer accepts and adopts a retrieved title in a
community Context, then creates, accepts and adopts an independent title there. Bangumi's cover traverses the existing `mediaBoundary` source server, native media API and
registered worker. Refresh then captures the real successful bulk response and exact native receipts before an
actual AbortController interrupts delivery to the CLI. After every handle closes, independently reopened SQLite
shows the original unresolved envelope. Fresh CLI calls replay it through ordinary Auth/public transport;
subject, candidate, retraction, revision and receipt rows are compared before and after that replay.

## Recovery decisions

A fresh invocation finishes the old sealed generation. Its supplied newer stdin is not acquired during that
recovery invocation. The subsequent explicit CLI invocation admits that successor input. This preserves the
existing Importer contract and proves ordering with captured public request ordinals and consumed-byte counts.
Both providers drain before either successor starts. No manual authorized replay supplies the retry evidence.
The only explicit replay is the required negative request after revoking the operator's Global grant; it uses
the exact captured old bearer/body and must return 403 without stored success.

Every result is a captured response, persisted local row, exact native receipt or independently retrieved object.
The fixture also checks each provider separately, rather than relying on aggregated exit codes. Bootstrap,
previous proposal and media journal bytes/keys/receipts and the original native media bytes remain immutable;
independent accepted/adopted selections survive. Current fences are read by the unmodified production importer.
Source/converter revisions and source digests come from the actual registrations and persisted baselines.
The definition bundle digest and observed caller-byte SHA-256 are recorded with raw evidence in
`.temp/goal/cli-ack-recovery/`; the native log retains the raw witness and exact file anchor. The managed check
receipt below records the tested Git revision; the check-host source snapshot has no Git metadata.

## Native receipt

The managed command was
`bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-ack-recovery.test.ts`.
It tested code revision `213272bfca7cecd19ea7f036379a937fe4ef2eeb` and exited 0. The frozen outcome
`Ordinary operator exact ACK interruption and restart recovery` passed: one test, 1,098 assertions, two provider
children (`bangumi`, `openlibrary`). The final log contains no TypeScript diagnostics. Local preflight passed
formatting for the four edited files, the importer compiler for 137 files and both local recovery tests with
18 assertions. These are selected checks, not a root or full-kernel regression claim.

Raw evidence is retained at line 59 of
`.temp/goal/checks/worker-check-2026-10-30T06-53-54.708Z-521f81e9.log`; its summary is line 60 and the terminal
exit status is line 79. The raw object contains `committedBeforeLoss[].receipts`, the original receipt rows,
SQLite pending envelopes, public selections and native media observations. A local extracted copy is
`.temp/goal/cli-ack-recovery/native-passed-evidence.json`. The observed caller SHA-256 is
`b04c79042ef8a0d354537e0197a1e894a3f0ab51484b15e4eafb4d30c991db90` and the definition bundle is
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`.

| Child | Converter | Native record revisions | Initial source digest | Successor source digest |
| --- | --- | --- | --- | --- |
| Bangumi | `bangumi@3` | `unversioned` throughout | `a3644ed0a27b96061586a50e697bb0e15ce0a3e84c50866b8cb43ffe84a7f0db` | `be4949cb963eae9b59962193c45177612200ff7612e632f1a0b64bba122643a5` |
| Open Library | `open-library@3` | `11` → interrupted `12` → successor `13` | `9983e19abb562ff65589f7530a35550e4ea8eb6949bb3bbed097cac9d2694eeb` | `12ba76dab8638fc5f70da8a13cfb096954d3abda043dd9b4b2ab0708db970a8b` |

Two committed responses were interrupted, leaving two pending envelopes and 16 exact command receipts.
All 27 original command receipts remained unchanged after recovery and revoked replay; no duplicate native
effect rows appeared. Pending drain ended at captured effect ordinal 59 and successor effects began at 70.
Both revoked requests returned 403 without stored success. The baseline worker capture observed two jobs:
`content.importFromUrl` and `content.image`; bootstrap bytes, media and both independent selections survived.

The first local proof failure was an incomplete Open Library test record without `last_modified`; supplying
the required native timestamp fixed it. The first native run passed its assertions but printed TS7034/TS7005,
TS7006 and TS2769 diagnostics for observation arrays. Explicit observation types and a checked index fixed
those diagnostics before the final managed run. No production importer defect was reached.

## Bounds and limits

The caller supplies one bounded native record per provider and observes only exact tuple, subject, command,
receipt and media anchors, with the existing 100-candidate/64-asset and transport limits. It creates no catalogue
scan, shared capture harness or new PG growth series. Native growth evidence for this connected outcome remains
missing; existing source/transport/coordinator growth evidence keeps its original units and bounds.

`services/importer/tests/cli-ack-recovery.test.ts` is a separate local protocol proof of sealed recovery and
successor admission for both providers. Its transport double is not native acceptance. The connected caller
requires the managed native test, including its real worker. No production defect is inferred from a missing
caller, and none is manufactured for this slice.

Read sources: the existing CLI, credentials, Importer, ImportSession, RunStore, RecordBindings, source registry,
media resolver, native API runtime/observer, identity fixture, media boundary and both converter modules and
fixtures. The read-only reference index was inspected; no external reference implementation was needed to bind
these existing contracts. The frozen test is unchanged.
