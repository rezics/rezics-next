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
Acquisition reaches EOF and sealing before application requests. No provider posts or recipe text are supplied.

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
