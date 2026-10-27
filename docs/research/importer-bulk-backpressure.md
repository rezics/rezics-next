# Bounded, replay-safe bulk backpressure

## Finding and scope

Use adaptive admission together with a retry budget attached to each logical write, preserved across
transport calls and queued continuations. Reducing concurrency controls pressure; it does not replace
that budget. Keep the importer's durable envelopes and continuation at the failed write. Its existing
additive growth and halving are a defensible concurrency policy, but width-one failure alone is not a
workload-independent limit on retries of a write when other writes succeed. Server-directed delays
must also survive the handoff from transport to coordinator. These are recommendations for adoption,
not changes to the importer contract, outcome checks, growth checks, source policies or cost claims.

Inspection date: 2026-10-27. The local base and `dev` both resolved to
`b83e8ec43c3056755cc6593b35dafa2e52f2e7f0`; no different implementation was substituted.
Repository guidance included the research rule in `tools/goal/README.md`.
Reference repositories were shallow-cloned under
`/home/edge/projects/rezics/temp/importer-bulk-backpressure-refs/`, in directories named
`smithy-typescript`, `elasticsearch-js` and `concurrency-limits`. Only source and documentation were
read; no dependencies, scripts, builds or product/reference tests were run.

## Primary sources and licensing

The following source commits are the inspected snapshots, not claims about every released version.
Links below pin files to those commits. Hosted documentation was accessed on the inspection date;
RFC numbers identify immutable standards. No implementation code or verbatim excerpts are reproduced.

| Source                               | Inspected locations and licence                                                                                                                                                                                          | What it establishes                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP semantics                       | [RFC 9110, sections 9.2.2, 10.2.3 and 15.6.4][http]; [RFC 6585, section 4][429]. IETF Trust Legal Provisions/BCP 78; extracted code components require Revised BSD text in RFC 9110 and Simplified BSD text in RFC 6585. | Idempotent retries, 503, 429 and the syntax/meaning of Retry-After; no adaptive algorithm or retry count.                            |
| AWS SDK guidance                     | [Retry behavior][aws]. AWS-hosted copyrighted documentation; no open-source licence assumed for this prose.                                                                                                              | Separate retry quota and adaptive request-rate admission, configuration scope and jitter.                                            |
| Smithy guidance                      | [Retrying Requests][smithy-guide] and [behavior traits][smithy-traits]. Hosted prose credits Amazon Web Services; no licence for copying prose assumed here.                                                             | Retry safety versus retry permission, server delay hints, token budgets and service-defined deduplication.                           |
| AWS/Smithy TypeScript implementation | [smithy-lang/smithy-typescript][smithy-root], commit `cb3a25c37bc9455ccb116fe722c544adac981690`; [root LICENSE][smithy-license] and `packages/core/package.json`: Apache-2.0.                                            | Actual retry accounting, adaptive rate control, classification, delays and limitations described below.                              |
| Established bulk ingestion client    | [elastic/elasticsearch-js][elastic-root], commit `acf9711ba7f55064ac70dbe1439b931501ccc7d2`; [LICENSE][elastic-license] and `src/helpers.ts` SPDX header: Apache-2.0, Elasticsearch B.V. and contributors.               | Fixed-concurrency bulk helper, bounded retries of rejected items, retained serialized operations, drop reporting and abort behavior. |
| Adaptive concurrency reference       | [Netflix/concurrency-limits][netflix-root], commit `78a74b9878d38c4c048b0304ce12a162ab7b7222`; [LICENSE][netflix-license] and inspected Java headers: Apache-2.0, Netflix, Inc.                                          | Actual additive-increase/multiplicative-decrease concurrency admission, separately from retries. It is not a bulk client.            |

Patterns may be followed freely. A later implementation port would be separate work and may copy
only MIT, Apache-2.0 or BSD code with attribution and applicable notices. This report copies none.
The Apache licences of the client repositories do not license arbitrary AWS-hosted documentation.

## What the standards and implementations actually do

### HTTP and Smithy semantics

RFC 9110 permits automatic replay where operation semantics are known to be idempotent or the first
attempt is known not to have applied. POST is not inherently idempotent. It also discourages retrying
a failed automatic retry; application-specific knowledge is needed for a more persistent policy.
503 denotes temporary overload or maintenance and can carry Retry-After. The header accepts an
HTTP-date or nonnegative integer seconds. RFC 6585 defines 429 as rate limiting, permits Retry-After,
and deliberately leaves the accounting scope unspecified. Neither response proves that a write did
not commit, nor prescribes halving concurrency. [RFC 9110][http], [RFC 6585][429].

Smithy distinguishes readonly/idempotent operations, service-enforced idempotency tokens and retryable
errors. Token replay protection lasts for a service-defined period. Its retry guide separates safety,
throttling and delay hints, recommends jitter and quota, and says a retry should not precede the
service's suggested time. These concepts support preserving command identity; they do not establish
the platform's receipt retention period or make a locally generated key sufficient. [Traits][smithy-traits],
[retry guidance][smithy-guide].

### AWS/Smithy: independent admission and retry controls

AWS guidance recommends standard mode generally and adaptive mode for latency-tolerant workloads
scoped to one throttling resource. Adaptive admission is per client: sharing it across unrelated
resources couples their throughput. Both modes have a success-refilled retry quota and per-call
attempt limit. Adaptive mode additionally gates initial sends. The page inspected describes a 2026
opt-in (`AWS_NEW_RETRIES_2026=true`), so its constants should not be assumed for all installed SDKs.
[AWS retry behavior][aws].

In the pinned implementation, relevant files are under
`packages/core/src/submodules/retry/`; compatibility packages re-export the core implementation:

- [util-retry/StandardRetryStrategy.ts][s-standard] gives each invocation a token with retry count.
  Retrying requires both an eligible classification and remaining attempts and shared capacity.
  Capacity starts at 500; success restores the last retry cost, or one token for first-attempt success,
  capped at 500. Refusal returns the underlying error through [middleware-retry/retryMiddleware.ts][s-middleware].
- [util-retry/AdaptiveRetryStrategy.ts][s-adaptive] composes that strategy with a send-token limiter.
  Initial acquisition and each permitted retry acquire a send token. It does not change a worker-pool width.
- [util-retry/DefaultRateLimiter.ts][s-limiter] enables its bucket after throttling. It uses measured
  request rate, a default multiplicative factor of 0.7 and CUBIC recovery, with a minimum fill rate
  of 0.5 tokens/second and capacity of at least one. There is no terminal "width one" condition.
- [service-error-classification/service-error-classification.ts][s-classify] recognizes 429, named
  throttle errors and a throttling trait. Its [constants.ts][s-errors] includes 500/502/503/504 as
  transient statuses. A transient 503 is retryable but does not necessarily trigger adaptive throttling.
- [util-retry/DefaultRetryBackoffStrategy.ts][s-backoff] implements full jitter below a capped
  exponential delay. [retries-2026-config.ts][s-config] selects 50/1,000 ms transient/throttle bases
  and 14/5 token costs when `SMITHY_NEW_RETRIES_2026` is true; otherwise the bases are 100/500 ms
  and retry costs are 5/10 for throttle/transient classifications. The jitter cap is 20 seconds.

Retry-After handling illustrates why guidance and implementation must be distinguished.
[middleware-retry/parseRetryAfterHeader.ts][s-after] parses response hints without restricting them
to 429, including date/seconds and AWS extensions. The pinned standard strategy uses the greater
of jittered backoff and the hint, but caps the hint at backoff plus five seconds. That can shorten a
large server hint, unlike the guide's minimum-delay recommendation. Do not transplant that clamp
as an HTTP guarantee. [StandardRetryStrategy.ts][s-standard], [Smithy guidance][smithy-guide].

The middleware retries the same request arguments and refuses non-replayable streaming payloads.
Its invocation-ID header is telemetry, not a server deduplication token. Idempotency must come from
operation semantics or the service token contract. Retry strategy and limiter waits use timers without
an AbortSignal parameter; they establish neither prompt cancellation of admission waits nor an
overall wall-clock deadline. AbortError classification is terminal, but that is a different property.
Changing the rate affects future token acquisitions, not requests already sent.
[Middleware][s-middleware], [classification][s-classify], [limiter][s-limiter].

The replenishable quota suppresses retries during widespread failures. It is not a whole-run cap:
sufficient successes can keep replenishing it. The per-invocation attempt count remains finite even
then; an application that starts a fresh invocation for every failure can bypass that protection.

### Elasticsearch JS bulk helper: bounded item retries under a semaphore

[src/helpers.ts, bulk()][e-helper] defaults to five concurrent bulk operations, a 5,000 ms retry wait
and a retry count initialized from the client's maximum retries. Its semaphore holds a slot through
the operation's item-retry loop, including waits. Input production waits for a slot; successful items
are counted and only item-level 429 rejections are retried. Other item errors reach `onDrop`.
Exhausted 429s also reach `onDrop`; the helper can resolve with failed statistics rather than reject.
A rejected `client.bulk` promise fails the helper instead of entering the item-retry path.

The retry subset uses the original serialized action/document lines. It does not regenerate work
or replay successful neighboring items. This is useful replay discipline, but not general exactly-once
delivery: autogenerated IDs or non-idempotent update scripts still need application/server protection
if a whole HTTP request is replayed after an uncertain response. [Bulk API semantics][elastic-bulk].

There is no adaptive decrease, additive growth, helper-level jitter or helper interpretation of
Retry-After in this loop. HTTP request retries belong to the delegated transport; its implementation
was not inspected and no end-to-end numeric attempt cap is inferred. The helper's item retry count
does not reset after another item's success. For a fixed finite input and bounded transport calls,
each chunk's retry loop is finite; an unlimited datasource has no whole-run time bound.
[Source][e-helper], [pinned helper documentation][e-doc].

`abort()` sets a flag and clears the flush timer. Future loop/send checks stop work, but already
running HTTP requests are not stopped by that method, and a pending retry timer can still wake to
observe the flag. The [official helper documentation][elastic-doc] explicitly describes the in-flight
limitation. This is not a guarantee of prompt cancellation of every datasource or request.

### Netflix: concrete support for concurrency AIMD, not an outage budget

[AIMDLimit.java][n-aimd] decreases on a reported drop or an RTT above its threshold, and otherwise
adds one only if sampled in-flight work is at least half the current limit. It clamps minimum and
maximum limits. Its default decrease multiplier is 0.9; configurable 0.5 is allowed. Thus additive
growth plus halving is an established variant, not a universal default or a proof of optimal settings.

[SimpleLimiter.java][n-simple] reduces semaphore permits on a limit decrease and lets existing
listeners release them on completion. It does not cancel old work to meet the new limit instantly.
[AbstractLimiter.java][n-abstract] samples the in-flight count captured at admission. The limiter
contains no retry count, Retry-After interpretation, idempotency or permanent-outage decision.
Those remain the caller's responsibilities.

## Shared patterns and meaningful differences

| Concern            | Evidence and implication for the importer                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overload signal    | HTTP 429 signals rate limiting. Smithy additionally classifies service errors; Netflix receives caller-classified drops/latency; Elastic item retries recognize only 429. The importer's outer 429/retryable-503 rule is platform-specific, not established by all sources.         |
| Admission          | Smithy adapts send rate, Netflix adapts concurrency, Elastic fixes concurrency. Separate admission from replay safety and retry accounting; a small width alone cannot limit repeated calls.                                                                                        |
| Retry budget       | Smithy has per-invocation attempts plus shared quota; Elastic has a finite item-retry loop. Netflix provides neither. Success-refilled quota controls amplification, while a non-resetting per-write limit prevents one failing write borrowing unlimited successes from neighbors. |
| Growth/decrease    | Netflix supports additive/multiplicative feedback with a utilization condition. Smithy uses time/rate-based CUBIC. None establishes the importer's exact +1 on every fulfilled write, half on final overload as optimal.                                                            |
| Timing             | Smithy jitters; Elastic's helper uses fixed waits. Retry-After is a separate signal, with an implementation/guidance difference in Smithy. A bounded client can stop rather than retry early when a hint exceeds its allowed wait.                                                  |
| Identity           | Stable request/item material and service replay semantics work together. A stable key without a matching body and valid server receipt is insufficient. Whole-record replanning is not required for a failed envelope.                                                              |
| Cancellation       | Admission stop, aborting a fetch, waking sleepers and durable recovery are separate observable properties. Neither reference retry loop proves a whole-run cancellation deadline.                                                                                                   |
| Old in-flight work | Admission changes act prospectively. Netflix drains acquired permits; Smithy changes later token acquisition; Elastic abort leaves sent work running. Old failures must not be mistaken for isolated low-width probes.                                                              |

## Comparison with the current importer

Local evidence: [README][i-readme], [src/importer.ts][i-importer], [src/import-fetch.ts][i-fetch],
[src/import-client.ts][i-client] and [tests/write-width.test.ts][i-width-tests], all at the local commit
above. Tests were read as existing assertions, not executed or modified.

Supported invariants and their limits:

1. **Replay at the failed write.** `send()` closes over the same request; bootstrap and dispatch use
   durable journals. `concurrent()` pauses that record's stack at the failing effect, preserving prior
   planning, bootstrap and media work. This follows the stable-work pattern, and the existing width
   test checks command equality and one accepted effect per key. Remote deduplication remains a
   kernel contract; this research does not re-prove its retention or transactional behavior.
2. **Bounded admission/state.** Width is constrained to 1..K, K defaults to 16 and is configured at
   most 64. A failed active record becomes a paused continuation; retries have priority over fresh
   records. Active plus paused records stay within the admitted cohort of at most K. Paused entries
   form a front-inserted stack, not a fair FIFO. Existing wider requests continue; current active
   work may temporarily exceed the reduced width. This agrees with prospective admission control.
3. **Run-scoped feedback.** The width object is shared across pages/phases by the run signal and
   resets for a new run. A successful effect adds one, bounded by K. Only a final ImportTransportError
   with 429, or 503 and `retryable: true`, halves it. HTTP retries that recover internally are invisible
   to this feedback. Growth occurs before `send()` validates item outcomes, so a fulfilled bulk
   response is not necessarily evidence of successful durable progress for every command.
4. **Isolation at width one.** `singleWriter` is captured before invoking the effect and requires both
   width and active count to equal one. A failure from an older cohort can requeue; an isolated
   width-one overload escapes the write loop. Record handlers normally catch it and mark failure,
   then continue other records, eventually producing `bulk-failed`. It is a finite-effort policy for
   that record, not proof of a permanent service outage or an immediate run-wide circuit breaker.
5. **Bounded individual HTTP invocation.** `createImportFetch()` defaults to three counted attempts,
   allows at most five, caps waits at 30 seconds each/60 seconds total and has a 120-second invocation
   deadline including body reads, credentials, waits and response buffering. It replays buffered bytes
   for safe reads, keyed POSTs and validated batchWrite keys. A one-time 401 renewal decrements the
   attempt counter: physical sends can be counted attempts plus one. Source-statistic PUT is not
   admitted by this generic retry predicate, despite its key; outer write retries are a distinct layer.

Important differences or unproven guarantees:

- The outer continuation invokes the transport afresh. Attempt count, scheduled wait total and
  request deadline restart; queue time is outside those deadlines. There is no carried per-envelope
  attempt/elapsed budget and no run-wide bulk-write deadline or shared retry quota.
- Transport retries network uncertainty, 429 and all 5xx for eligible requests; coordinator adaptation
  sees only final 429/retryable 503. Non-retryable 503 and other errors can therefore consume transport
  attempts but do not get a width continuation. Retry safety and overload admission are different rules.
- Backoff is deterministic, unlike Smithy's jitter. Retry-After is interpreted only for 429, unlike
  HTTP's documented 503 use. The HTTP adapter returns a response when a hint exceeds its wait budget;
  it also returns the final response without waiting on that response's hint. `ImportTransportError`
  retains status/type/code/retryability, but not that hint or a budget-exhaustion reason. The coordinator
  can immediately re-enter transport, bypassing the advertised delay or the reason transport stopped.
- Abort wakes paused records and prevents another effect at the loop check. The HTTP adapter races
  waits/I/O against its supplied signal. Actual in-flight cancellation depends on transport wiring:
  `ImportTransport.batchWrite` has no signal parameter; the [CLI adapter][i-cli] captures its signal.
  Arbitrary injected transports/providers need not settle promptly. Durable identity is still needed
  because local cancellation cannot undo an already committed remote write.

### Alternating success and overload: what is and is not bounded

Consider K=2, failing write A and successful writes B1, B2, ... , each the final effect of an
already-planned record. Each A failure below means a complete bounded transport invocation returning
overload. Arrange completions as follows:

| Step | Width/active state and result                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | A and B1 start at width 2. A captures `singleWriter=false`.                                                                                                                     |
| 2    | A exhausts transport and overloads; width becomes 1. A pauses, B1 remains active.                                                                                               |
| 3    | B1 succeeds; width becomes 2. The pump resumes A before admitting fresh work. A can begin its next invocation while B1 still occupies its record slot, so again captures false. |
| 4    | B1 finishes its record; B2 is admitted into the freed slot. A overloads, reducing width to 1; B2 succeeds, restoring 2. Repeat with B3.                                         |

Thus A can use arbitrarily many fresh transport budgets as the successful workload grows. An
unchanged K, five-attempt cap or 120-second request deadline does not bound A's lifetime independently
of other records. Old-cohort success can also raise width after a decrease; this is allowed by the code.

This is not a claim of infinite execution for a fixed finite dump with finitely many successful
effects and settling dependencies. With finitely many completed effects, growth events are finite.
When all work continually overloads, the cohort drains, width reaches one, and an isolated retry fails. Additional
records can still be tried at width one, so total outage traffic depends on input size. Existing tests
cover uniform overload, recovery, default-width drainage, error classification and interruption. They
do not establish a per-envelope bound under alternating successes, or a global time bound for arbitrary
input/providers/repeated invocations. A replenishable AWS quota alone would not prove those either.

## Recommendation for a separate implementation decision

Adopt **bounded logical-write retries under adaptive admission**: Netflix-style concurrency control
plus Smithy-style explicit retry eligibility/accounting and Elastic-style retained replay material.
The importer's durable envelope and continuation are already suitable foundations. Preserve K, page
and payload caps, command identities, prior completed effects, outcome reporting and existing growth
checks. Keep old cohorts draining and retain the isolated width-one failure shortcut.

The smallest recommended correction is a finite continuation allowance for each failed logical
write, consumed across all transport invocations and never replenished by unrelated successes or
width growth. Carry a monotonic elapsed deadline from its first send through queueing and retries.
Exhaustion leaves durable unresolved work and follows the existing failure outcome. Do not implement
this by silently resetting, widening or relabeling the existing per-request caps. For B allowed
transport invocations and A counted attempts each, physical sends are at most B(A+1), allowing the
existing single 401 replay per invocation. The elapsed bound needs cancellable admission and transport.
For L finite logical writes, this bounds bulk sends by L times B(A+1); acquisition, reads and injected
providers need their own accounting. This is a model for a future bound, not a new value for B or a
changed acceptance limit.

Also carry a bounded not-before time and terminal retry-budget reason across the transport/coordinator
boundary. Apply valid Retry-After to eligible 429 and retryable 503 responses; no layer should retry
earlier because another layer refused a long wait. If the hint cannot fit the remaining allowance,
stop/defer through the established unresolved-work outcome. Add jitter to fallback pacing within
existing wait/deadline ceilings; server hints remain a floor, not a random upper bound.

A shared success-refilled quota can additionally suppress fleet-wide amplification, but is optional
for the minimal correction and cannot replace the per-write limit. Likewise, reacting to every
transport throttle, utilization-conditioned growth or epoch-based recovery might improve stability;
the inspected sources do not justify changing all of those policies at once. Exact +1/half settings
and LIFO fairness remain workload-specific. A whole-run wall-clock limit would need separate adoption:
neither bounded writes nor bounded memory limits an unlimited input or non-settling provider.

## Smallest observable cases for any adopted correction

These are proposed cases, not edits to existing tests or acceptance bounds. Retain the current
outcome/growth checks. Use controlled completions, a virtual clock and observable network sends.

| Case                                         | Required observation                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partial completion then uncertainty/overload | Complete bootstrap/media once, then lose a later write response. Across transport retry, queued continuation and durable resume, command keys/bodies remain identical and accepted effects remain one per key; no repeated completed media work.                                                          |
| Alternating trace above                      | Keep A failing while neighbors succeed and width recovers. A exhausts its adopted allowance/deadline without resets; unrelated success cannot extend it. Assert physical sends including 401 renewal and queue residence, plus the existing unresolved-work outcome.                                      |
| Old cohort and recovery                      | Hold old requests, reduce width, and complete their failures out of order. They drain without a false isolated failure or fresh admission above current width. A genuine solitary width-one failure terminates its write; successful recovery still reaches K, with active-plus-paused records at most K. |
| Retry-After at both layers                   | For 429 and eligible 503, cover integer seconds, HTTP-date, malformed/absent hints and a hint beyond remaining budget. No follow-up send precedes a valid not-before time, including after final transport response or a continuation. Too-long hints stop rather than shorten the wait.                  |
| Fallback pacing and classification           | Inject randomness and assert fallback delays stay within existing ceilings and vary. Hints are never shortened. Existing non-retryable statuses retain their outcomes and do not gain new continuation rights.                                                                                            |
| Cancellation and expiration                  | Abort while queued, sleeping and in flight, and expire a logical deadline during queueing. No new sends follow termination; waiters settle and local work drains. A deliberately late remote commit remains safely replayable from durable state.                                                         |

## Unresolved questions for adoption

- What finite continuation allowance and logical-write elapsed limit fit existing recovery/outcome
  checks? Should budget exhaustion fail only the record or stop admission for the resource? Sources
  support both bounded effort and separate admission; they do not determine the platform's numbers.
- Which resource owns cooldown/quota: API origin, account, source or server-provided throttle scope?
  HTTP leaves scope open; AWS warns against coupling unrelated resources. Multiple processes also
  require jitter and server enforcement; a local width cap is not a fleet-wide bound.
- Does a retryable 503 here represent capacity pressure or transaction contention? It is an explicit
  local signal, whereas Smithy normally treats status-only 503 as transient rather than throttling.
- What server receipt lifetime and payload-fingerprint rules cover restart after a long outage?
  This report relies on existing kernel replay contracts and proposes no changes to them.
- Should growth require successful command outcomes, rather than any fulfilled effect? Should paused
  records have FIFO fairness? Neither a fairness guarantee nor optimal recovery timing follows from
  the current tests or the inspected examples.

Validation for this research deliverable is the nonempty-file acceptance command. No product behavior
or cost claim is changed; implementation and owning-document adoption remain separate work.

[http]: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2
[429]: https://www.rfc-editor.org/rfc/rfc6585.html#section-4
[aws]: https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html
[smithy-guide]: https://smithy.io/2.0/guides/client-guidance/retries.html
[smithy-traits]: https://smithy.io/2.0/spec/behavior-traits.html#idempotencytoken-trait
[smithy-root]: https://github.com/smithy-lang/smithy-typescript/tree/cb3a25c37bc9455ccb116fe722c544adac981690
[smithy-license]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/LICENSE
[s-standard]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/util-retry/StandardRetryStrategy.ts
[s-middleware]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/middleware-retry/retryMiddleware.ts
[s-adaptive]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/util-retry/AdaptiveRetryStrategy.ts
[s-limiter]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/util-retry/DefaultRateLimiter.ts
[s-classify]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/service-error-classification/service-error-classification.ts
[s-errors]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/service-error-classification/constants.ts
[s-backoff]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/util-retry/DefaultRetryBackoffStrategy.ts
[s-config]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/util-retry/retries-2026-config.ts
[s-after]: https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/middleware-retry/parseRetryAfterHeader.ts
[elastic-root]: https://github.com/elastic/elasticsearch-js/tree/acf9711ba7f55064ac70dbe1439b931501ccc7d2
[elastic-license]: https://github.com/elastic/elasticsearch-js/blob/acf9711ba7f55064ac70dbe1439b931501ccc7d2/LICENSE
[e-helper]: https://github.com/elastic/elasticsearch-js/blob/acf9711ba7f55064ac70dbe1439b931501ccc7d2/src/helpers.ts#L581
[e-doc]: https://github.com/elastic/elasticsearch-js/blob/acf9711ba7f55064ac70dbe1439b931501ccc7d2/docs/reference/client-helpers.md
[elastic-doc]: https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/client-helpers#_abort_a_bulk_operation
[elastic-bulk]: https://www.elastic.co/guide/en/elasticsearch/reference/current/docs-bulk.html/
[netflix-root]: https://github.com/Netflix/concurrency-limits/tree/78a74b9878d38c4c048b0304ce12a162ab7b7222
[netflix-license]: https://github.com/Netflix/concurrency-limits/blob/78a74b9878d38c4c048b0304ce12a162ab7b7222/LICENSE
[n-aimd]: https://github.com/Netflix/concurrency-limits/blob/78a74b9878d38c4c048b0304ce12a162ab7b7222/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/AIMDLimit.java
[n-simple]: https://github.com/Netflix/concurrency-limits/blob/78a74b9878d38c4c048b0304ce12a162ab7b7222/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limiter/SimpleLimiter.java
[n-abstract]: https://github.com/Netflix/concurrency-limits/blob/78a74b9878d38c4c048b0304ce12a162ab7b7222/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limiter/AbstractLimiter.java
[i-readme]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/importer/README.md
[i-importer]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/importer/src/importer.ts
[i-fetch]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/importer/src/import-fetch.ts
[i-client]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/importer/src/import-client.ts
[i-width-tests]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/importer/tests/write-width.test.ts
[i-cli]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/importer/src/cli.ts#L606
