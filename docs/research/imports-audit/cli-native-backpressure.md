# Account-key CLI public backpressure journey

The frozen native outcome is `Real public rate refusal and bounded operator resume` in
[`cli-native-backpressure.test.ts`](../../../services/kernel/test/imports/cli-native-backpressure.test.ts).
Its fixture calls the ordinary account-key CLI three times against one `openApiRuntime`, with the existing
ordinary service-tier actor and a startup write budget of eight command units per two seconds. It neither
changes production retry policy nor fabricates public responses. The key is provisioned through the real
stage/approve/apply credential effects. Secrets and importer SQLite files live on private tmpfs and are removed
on close; diagnostics contain no private JWK, assertion, cookie or bearer.

The supplied input contains seventeen synthetic supported Bangumi metadata records, one with a native cover
intent. The real registration retains `bangumi@3`, the native `unversioned` revision and data-only SHA-256 digests.
The emitted evidence contains the actual registration/module observations and bundled definition digest.
Acquisition reaches EOF and sealing before initial application requests. Fresh invocation resumes the already
sealed durable generation before consuming newer stdin; its application requests verify that exact persisted
ready generation, supplied count and validation state. No provider posts or recipe text are supplied.

The first CLI invocation crosses multiple real public envelopes and recovers under the default transport and
coordinator policy. During the second invocation, only metadata records without the cover change. Before each
physical send for one selected refreshed record, the scheduler replays a captured, previously committed public
envelope until native admission refuses it. These authorized replays consume ordinary admission units and return
their actual immutable receipts; the fixture never moves counters or server time. Each fill is bounded by nine
sends. Independent records still make progress, but cannot refill the selected logical write's allowance.
An isolated width-one failure may terminate before the eight-invocation ceiling, as the existing contract permits.
The fixture captures counts rather than claiming every run reaches the ceiling.

After exhaustion, read-only SQLite observations retain the prior complete-generation pointer and source rows,
and enumerate only the bounded supplied source's pending envelopes. After two real elapsed seconds, a fresh CLI
invocation reopens the same state and drains exactly those serialized bytes and command keys. Repeated transport
attempts are counted separately from logical invocations, fence reads, Auth requests and competing receipt replays.
Resume comparisons use unique observed logical envelopes sorted by their actual bytes, since concurrent physical
completion order is not a product guarantee. Receipts are read by exact partition/principal/kind/key. Native
claims, candidates, original bootstrap/media journals and independent public selection reads provide separate
effect evidence. The cover is processed by the registered worker through the existing media boundary; its
available native row, object variants and events survive the metadata refresh.

The implementation adds an optional CLI construction boundary that retains the real Importer/RunStore/
RecordBindings and wires the existing CLI clock into coordinator waits as well as HTTP waits. The two local
tests in `services/importer/tests/cli-native-backpressure.test.ts` cover real durable construction with that
shared clock, cancellation before and during scheduling, and safe cleanup after constructor failure. Default
coordinator waits retain the existing cancellable native timer; explicitly supplied clock waits race cancellation.
They do not claim
native rate acceptance.

The shared reference index was read at its prescribed read-only path. The three implementations cited by the
importer README were absent from that index/tree, so their pinned upstream source was read directly:
[Netflix SimpleLimiter](https://github.com/Netflix/concurrency-limits/blob/78a74b9878d38c4c048b0304ce12a162ab7b7222/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limiter/SimpleLimiter.java),
[Smithy StandardRetryStrategy](https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/util-retry/StandardRetryStrategy.ts),
and [Elastic bulk helper](https://github.com/elastic/elasticsearch-js/blob/acf9711ba7f55064ac70dbe1439b931501ccc7d2/src/helpers.ts).
The existing policy separates prospective admission, finite per-operation attempts and retained serialized work.
No reference implementation or new policy is imported by this caller binding.

This is a focused connected caller outcome, not a new native PostgreSQL growth series. Existing source,
reader, transport, coordinator and media limits remain in force. No native growth blocks or synthetic counts
are supplied. The managed check log contains the raw public exchanges, actual scheduled waits, logical and
physical sends, baseline rows, pending bytes, native receipt anchors, public selection and worker evidence.
Validation results belong to the managed receipt for the committed implementation revision.

The native acceptance passed at code revision `84a092c6a0cb3650b7b3bb93ab438e33e0309a10`:
one child, `Real public rate refusal and bounded operator resume`, with 3,777 assertions. The raw receipt is
`.temp/goal/checks/worker-check-2026-10-30T07-12-24.878Z-442f29de.log`, under
`CLI native backpressure evidence`. The selected kernel compiler and quality phases also passed; this does
not claim a root or all-workspace gate. Edited-file formatting, the importer compiler and both local tests
passed: `CLI construction preserves the real coordinator, durable completion and shared retry clock` and
`a construction failure closes the opened dump and keeps private diagnostics out of CLI output` (18 assertions).

The captured registration was `bangumi@3` with native record revision `unversioned`, using bundle
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`. The seventeen-record baseline
completed after 54 actual CLI rate refusals. Exhaustion retained one exact two-command pending envelope while
fifteen changed neighbors succeeded; the selected operation used five logical invocations and fifteen physical
sends. The fresh invocation sent that pending envelope once and completed. There were 71 CLI and 15 competing
rate refusals during exhaustion, all native refusals carried Retry-After of one or two seconds, and 104 actual
waits were scheduled. Width-one termination occurred before the eight-call ceiling; this run does not independently
exercise the exact ceiling branch covered by the existing logical-write budget tests.

All 52 original receipt rows and 52 original immutable command journals remained equal. One actual receipt
anchor is transaction `01a18ba9-3c31-771c-ab85-9ff43ed8f41f`, bootstrap key
`bangumi:920001:333c04dd151a2a6831c039cb9a651df29198be8a04e16ce861d4b6a34a11c954`.
Native media `01a18ba9-4330-71f3-a30a-7ef9153a383f` remained available with source digest
`1474917101a84c44e276774c43f05327e6f05475a3e209899c0749a4ba0594be`; the registered worker executed two
jobs, `content.importFromUrl` and `content.image`. Independent accepted candidate
`90c99e98-6cc4-87ac-b85c-548fafc0f1ab` remained selected. The raw receipt retains the remaining keys, bodies,
source digests, transactions, media events and public reads.

The first managed attempt exposed two fixture type errors and the incorrect fresh-stdin EOF precondition at
resume. These were corrected while retaining every frozen assertion. Review also found and verified the repair
of prompt cancellation for the newly connected optional clock. No production retry-policy defect was invented,
and no files outside the declared paths were changed.
