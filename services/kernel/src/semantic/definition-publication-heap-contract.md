# Definition publication: Worker heap observations and remaining margin

This prerequisite specifies and instruments a diagnostic. It grants no publication, memory, concurrency,
deadline, readiness or Cost authority. The original
[publication HTTP acceptance](../../test/semantic/definition-publication-work.test.ts) and its helper remain
unchanged. Cold 201/GET/ETag, replay 201/no effects, new-key 200, conflict 422, malformed 400, current denied
replay 403 and the valid-excess 422/no-effects requirement all remain. Today's valid-excess 201 is the intended
meaningful red. No diagnostic verdict supplies a product verdict or narrows any pending native scope.

The earlier [publication proposal](definition-publication-contract.md) is historical candidate evidence where
superseded here. Performance's complete candidate-four review, the prerequisite split requirements and Accounts'
digest-frame correction were read from the supplied main-checkout evidence paths. The exact candidate-four
contract/test/support snapshot was also read. Its weighted meter, standalone-context bound, linearity claims
and request-end reservation rule do not establish current bounds. No historical sample suite is repeated.

## Native instrumentation and limits

The installed `bun-types@1.4.4` sources were read before instrumentation:

- `jsc.d.ts`: `heapStats()`, `heapSize()`, `HeapStats`, `gcAndSweep()`, `fullGC()` and `memoryUsage()`.
- `bun.d.ts`: `Bun.gc(force)`, `WorkerOptions`, transfer lists and `Worker.terminate()`.
- `docs/runtime/workers.mdx`: separate JavaScript instances, message transfer, natural termination and `close`.

`bun:jsc.heapStats().heapSize` describes the calling VM's last collected live cells plus their owned external
memory, including string and ArrayBuffer contents. It is not an allocation-since-last-GC counter.
`heapCapacity` is reserved VM capacity plus external memory; it is neither live size nor an all-time peak.
`extraMemorySize` is included in both quantities, not a second charge. `objectCount` counts collected cells;
type counts include recent allocations. Neither is a byte counter. The diagnostic records numeric fields,
discarding the potentially large type maps returned by `heapStats()`.

`Bun.gc(true)` synchronously requests collection and mimalloc cleanup. `gcAndSweep()` synchronously collects
and sweeps JS garbage; its documented scope differs from `Bun.gc(true)` for WeakRefs and non-JS memory.
Each reading records a pre-GC snapshot and three successive `Bun.gc(true); gcAndSweep(); heapStats()` snapshots.
Their minimum/maximum reports observed measurement variation, not statistical confidence. Explicit module roots
keep current job data alive during measurement. GC and instrumentation perturb allocation/JIT/lifetimes.

No RSS measurement is used to derive per-Worker heap. `bun:jsc.memoryUsage()` reports the whole process.
The installed Worker options leave `resourceLimits` commented out; `smol` selects a smaller configuration,
not a hard heap cap, and is not selected here. `terminate()` returns void. The installed documentation says
`close` means marked terminated and the thread can take longer to fully exit. Thus neither `close`, a job
reply, natural event-loop exhaustion nor this test's final cleanup proves physical disposal.

There is no trustworthy per-Worker synchronous-phase peak or physical-reclamation authority in the APIs above.
No interval on the Worker can interrupt synchronous parse/JCS/checker/hash to sample their internal peak.
The output records phase-boundary capacities, last-GC live sizes and post-GC retained sizes; their maximum is
an **observed boundary maximum**, never the true peak or a safety ceiling. Transient allocations entirely
inside a phase, JIT/native stacks, allocator slack outside this VM, structured-message internals and physical
thread exit remain REQUIRED evidence. The summary deliberately leaves `truePeak` null.

## Workload and observation protocol

The test creates exactly one real Bun Worker, then serially submits all observations to it. It starts no
replacement, runtime pool, queue, service, ingress, Admission, checker/validator variant or DB connection.
The Worker imports the same unchanged Definitions implementation and original `workDiagnostic`; fixture creation
imports original `publicationFixture`. All current bundle properties/types are retained. Worker initialization
runs the actual bundled validator and checker diagnostic before the first H0. The measured baseline therefore
includes module/schema initialization, current imported catalogue and diagnostic roots; it is specific to this
instrumented VM, not a claim about a future production worker's H0.

First, three serial live-allocation witnesses (1,024/4,096/16,384 objects with strings) must increase the actual
collected cell/byte counters. Release readings follow each witness. Next, an explicitly retained and touched
8 MiB parent ArrayBuffer must appear in the parent's collected heap size without adding half that byte count to
the Worker's collected heap size. This tests VM locality through the runtime's documented external-memory
accounting, rather than relying on object-count deltas that varied substantially across GC observations.

The independent scales are 16/64/256, six series and eighteen jobs in total:

| Family     | Valid series                                                                                        | Invalid series                                          | Independent growth                                     |
| ---------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Properties | Original fixture with 16/64/256 added properties, each with a 1,024-character description           | Same, one empty required English label                  | Property/object density with fixed string length       |
| Strings    | Original twelve-property fixture, generator version 16/64/256 KiB                                   | Same, one empty required English label                  | Long string bytes with fixed JSON nodes and properties |
| Nodes      | Original twelve-property fixture, each added property has 64/256/1,024 unique sorted short mappings | One property's enum contains 4,096/16,384/65,536 zeroes | Scalar-node density with fixed property count          |

The valid node family uses short unique legal CURIE arrays; it does not repeat filter/base expansion. It is a
dense admitted family, **not a proven global maximizer over every valid release**. The invalid node family uses
one-digit numeric arrays: asymptotically two JSON bytes per scalar node, the flat scalar-array maximum. `enum`
has no uniqueness constraint, so duplicate zeroes cannot invoke the known quadratic `uniqueItems` diagnostic.
The unchanged schema's enum shape passes and expected-schema semantics rejects it. Invalid label variants
exercise actual schema errors. Parsing happens before all of those refusals.

No body exceeds the test-only 1 MiB wire cap. This cap is a safe workload selection, not product admission.
Actual installed TypeBox `build/schema/engine/uniqueItems.mjs` was read: Check hashes into a Set; Errors spreads
the accumulated duplicates once per duplicate. The known duplicate-heavy 4 MiB shape is deliberately **not run**.
That axis remains REQUIRED after construction fixes. Valid global node-density maximizers, maximum body,
independent bases/qualifiers/saved-filter density, deep structures, escape/Unicode expansion and all construction
adversaries remain REQUIRED. Neither safe sampling nor a small malformed observation approves their c.

Each sample begins with a new idle reading in the same initialized Worker. The parent encodes one compact
`{release}` buffer and transfers it with a transfer list; it asserts every parent view detaches. The Worker keeps
that input, the cloned maximum-size context witness, decoded text and parsed graph explicitly rooted. It measures:

1. Owned input and context received.
2. Decode and parse once.
3. Unchanged `validateRelease`, including actual checker work and actual invalid diagnostics.
4. An explicitly retained canonical release string.
5. Actual `releaseDigest`, including its additional opaque JCS/hash allocations.

These are a diagnostic lifetime schedule, not a proposed product implementation. Retaining decoded text and
canonical bytes deliberately exposes those copies. Each phase records time before GC, then its heap reading;
time excludes the diagnostic GCs and is observation only. The original checker diagnostic additionally runs in
the parent for valid property cases, outside Worker timings/heap, preserving the prior actual-step assertions.

For phase post-GC extrema H, sample idle extrema H0 and transferred wire bytes B:

`c_sample_min = max(0, max_phase(H_min) - H0_max - B) / B`

`c_sample_max = max(0, max_phase(H_max) - H0_min - B) / B`.

This subtracts the transferred input exactly once; wrappers, decoded input, parsed graph, canonical strings,
context and diagnostic bookkeeping remain charged. It is a retained-working-set ratio against actual wire bytes,
not a fitted slope. Global exercised c is the maximum sample upper endpoint across all six series. H0 minimum
and maximum are reported independently. Three GCs do not measure run-to-run/systematic uncertainty, future
runtime versions or omitted shapes. No permanent expected H0/c/K number is asserted in acceptance.

The Worker nulls the job root and transfers the same input back. The parent verifies original byte hash/length;
the Worker records its detached length and a released reading. Buffer transfer proves this view's ownership
change, not physical disposal or absence of hidden allocator copies. Idle readings occur in a subsequent message
turn to avoid retaining the preceding handler stack. Only bounded numeric/error/digest results cross back, with
at most 64 actual validator errors. Eighteen observations remain in the parent; there is no unbounded history.
The parent reviews every output, recomputes c, checks counts/shape/verdict/transfer and prints complete JSON.
On an assertion or Worker error it terminates its own Worker and observes close before leaving; on success it
removes the message handler, observes natural close, and starts no replacement. No exit-ready flag is invented.

## Remaining native margin and binding schedule

`Amax = 16,384` stays CANDIDATE. Performance accepts checking the sorted distinct sum after each unchanged
pattern. Each pattern executes at most 8,193 checkpoints, so the later executed boundary is candidateAmax+8,193
(24,577 with today's candidate). This replaces the stale demand for an in-analysis remaining-budget API.
Existing defect-before-exhaustion and same-pattern defect/excess HTTP precedence still need their native case.

The later margin run cannot start from this diagnostic alone. In dependency order it requires:

1. Delivered Definitions/Filter construction bounds, pre-schema linear duplicate diagnostics, compiled per-type
   facet reuse and qualifier membership, with co-owner compatibility/cap/precedence decisions. Actual deterministic
   three-scale valid/invalid counters must vary duplicates, bases, qualifiers and filters independently.
2. The delivered construction producer's admitted worst valid and invalid shapes, retaining the full catalogue.
   Review the actual producer and its exports then; no producer identifier/signature is invented here.
3. Maximum canonical release 4,194,304 bytes, maximum wire 4,259,840 bytes, maximum context, and actual executed
   candidateAmax+8,193 checkpoints. Exact admission/worst-shape construction is still REQUIRED, not guessed by
   padding one ordinary fixture or submitting today's quadratic malformed shape.
4. Final native raw ingress/ownership, Worker execution, shared digest core and actual JSONB/result binding.
   Run original HTTP publication on an idle host under the unchanged 2,000 ms deadline. Record host/runtime/load,
   parse/JCS/hash/checker/schema/native Auth/Access/command/SQL overhead and actual executed checkpoints. Include
   cold/read/replay/current denial/zero-effect excess, rather than replacing HTTP with the pure validator.
5. Performance review of complete outputs, true peak evidence or its missing boundary, margin and memory budget
   before freezing Amax/c/K/Cost. Loaded-host timing here cannot substitute for that idle native margin.

Envelope-minus-BODY context overhead is **6,312 = 76 + 6\*1,024 + 92**, not the standalone context's 6,304.
The size witness is canonical envelope minus canonical `{params:{},body:{release}}`; it is neither an Actor
nor native delegated issuance/hash-equality proof. No receipt digest algorithm is copied here. Native maximum
context must use actual registerClient/control characters and resolved delegated Auth, plus account/anonymous
wrapper equality through one shared reviewed pure digest core. Context canonical bytes are not a heap cap.

Whole-process accounting still needs ingress I once, H0/c per occupied slot, context/message overhead, runtime
read-cache residency and every result/parent pg copy. Input reservation must last until the **later of request
end and job buffer disposal**, or separately charge retired inputs. Request-end alone after a 503 is insufficient.
The result term depends on actual JSONB binding: returning the original buffer retains I; returning canonical
bytes adds or explicitly reserves those bytes; parent pg serialization is never free. At most eight cache entries
AND 8 MiB canonical bytes is conditional only: parsed graphs require amplification review, cold misses their
bounded job lane/Cost row and residency at 1E/8E/64E. No cache implementation is selected.

Active plus retired slots, original permits/waiters, deadline/abort/error/late-result handling, actual physical
exit before replacement, failure readiness and shutdown-before-pool-close all remain REQUIRED in the final
native producer. This diagnostic has no DB binding, access freshness, cancellation margin or physical lifecycle
authority. Preserve every outstanding schedule in the original contract with the corrections above.

## Cost

### Worker diagnostic observation

- Touches: one serial actual Worker, bounded owned inputs and actual validator/checker/GC/heap APIs; no DB,
  production authority, queue or request path. Original HTTP acceptance separately uses the native driver.
- Bound: one diagnostic Worker total; each input at most 1 MiB, three calibration witnesses, eighteen bounded
  observations, actual errors at most 64. No replacement or unbounded history. Measured working heap excludes
  transferred bytes and explicitly identifies omitted worst shapes and inaccessible phase-internal peak.
- Growth check: independently varied property/string/node density and valid/invalid three-size observations;
  deterministic node/property/byte counts and actual VM heap/capacity readings. Time is observation, never admission.

## Delivery evidence

The real Worker diagnostic completed serially: one Worker, eighteen jobs, no database connections, no replacement,
and a logical finish followed by `close`. The transferred parent buffer returned with its SHA-256 and original
length intact, and its detached length was zero after return. For each job the Worker explicitly retained the
transferred input, maximum context witness, decoded text, parsed release, canonical release string, validation
errors and digest until the measurements completed; then it nulled the job root before returning the input and
bounded result fields. The 8 MiB parent ArrayBuffer raised the parent's collected heap size from 14,141,050 to
22,529,820 bytes, while the Worker's collected heap stayed within 4,128 bytes of its calibration idle reading.
This validates the per-VM counters on this run; it says nothing about physical thread reclamation.

| Observation               | Result                                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                   | Bun 1.4.4, revision `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`, executable `bun@1.4.4-canary.20261027.1`                                                                                                                                                                |
| Host                      | `B`, Linux `6.12.113+deb13-cloud-amd64`, 16 processors; load averages at Worker initialization 12.08 / 8.95 / 8.28                                                                                                                                                      |
| Initialized idle H0       | Three forced-GC readings ranged 25,781,902–25,782,566 bytes (24.57 MiB) after bundled validation and checker initialization                                                                                                                                             |
| Per-job idle baseline     | 25,771,923–27,892,311 bytes (24.58–26.60 MiB) across the eighteen serial samples; this drift is observed and included per sample, not hidden by reusing initialization H0                                                                                               |
| Exercised c               | Maximum upper endpoint 23.373442 at invalid node-dense scale 256; that sample's lower endpoint is 23.370306. The 0.003136 spread comes from the recorded three post-GC readings and baseline extrema only, not a confidence interval or systematic uncertainty estimate |
| Sampled boundary capacity | Maximum `heapCapacity` 114,342,699 bytes (109.0 MiB), at invalid node-dense scale 256. It is the maximum of phase-boundary readings, not the synchronous-phase peak                                                                                                     |
| Actual true peak          | Unavailable; `truePeak` remains null                                                                                                                                                                                                                                    |

The exercised c formula for each sample is `max(0, maximum post-GC heap - per-job H0 - transferred wire bytes) / transferred wire bytes`, with the transferred input subtracted once. The tested property, string and node shapes each grew independently at scales 16/64/256; each family includes valid and invalid cases. The table gives all eighteen wire-byte sizes and c intervals. All inputs remained under the diagnostic's 1 MiB cap; the maximum observed input was 473,797 bytes. Invalid samples each produced one actual validator error, under the existing 64-error cap.

The actual maximum context witness was 6,304 canonical bytes, and its canonical envelope-minus-body overhead was
6,312 bytes. The measurement retains that context with the input and parsed/canonical forms. The Worker reply
contains the returned input buffer, actual digest, up to 64 errors, shape/counts and phase readings; its structured
clone byte size was not measured. Parent result and DB parameter copies therefore remain an explicit native
binding cost rather than an inferred zero.

| Family / validity    | Wire bytes at scales 16 / 64 / 256 | JSON nodes at scales 16 / 64 / 256 | Measured c interval at scales 16 / 64 / 256                     |
| -------------------- | ---------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| Properties / valid   | 162,276 / 224,580 / 473,797        | 7,548 / 8,268 / 11,148             | 19.280035–19.281613 / 13.075412–13.076552 / 9.748561–9.754099   |
| Properties / invalid | 162,262 / 224,566 / 473,783        | 7,548 / 8,268 / 11,148             | 15.137703–15.210912 / 10.112283–10.113423 / 8.391297–8.433916   |
| Strings / valid      | 160,874 / 210,026 / 406,634        | 7,464 / 7,464 / 7,464              | 11.603628–11.630978 / 10.312718–10.313937 / 8.575869–8.576499   |
| Strings / invalid    | 160,860 / 210,012 / 406,620        | 7,464 / 7,464 / 7,464              | 10.779703–10.781294 / 9.895973–9.897592 / 8.494469–8.495099     |
| Nodes / valid        | 149,868 / 165,960 / 230,328        | 8,233 / 10,537 / 19,753            | 11.792464–11.794172 / 12.614052–12.626151 / 14.788910–14.841956 |
| Nodes / invalid      | 152,627 / 177,203 / 275,507        | 11,557 / 23,845 / 72,997           | 13.464033–13.469196 / 16.713413–16.714858 / 23.370306–23.373442 |

Each sample records these actual phases, elapsed times excluding diagnostic GC, post-GC live heap ranges, and
before/after-GC capacity readings: receive input/context (0.001–0.006 ms); decode/parse (1.106–3.111 ms);
unchanged validation including the real checker (47.496–740.966 ms); retained release canonicalization
(2.696–6.558 ms); and actual `releaseDigest` with its own JCS/hash (3.420–8.679 ms). The largest post-GC
heap reading over all samples was 34,607,237 bytes. Phase-internal transients can be higher: observed capacity
reached 114,342,699 bytes during invalid node-dense validation. These timings are observations, never a deadline
or admission proof. The three readings describe only within-reading GC variation; host/runtime changes, repeated
run variation and omitted shapes remain unmeasured.

This is not approved worst-case `c`, `K`, `Amax`, process memory, or a Cost limit. The unsampled axes remain
explicit: construction-bounded maximum valid/invalid shapes, the quadratic duplicate-heavy 4 MiB case, maximum
body/context, deep and escaped/Unicode structures, independent bases/qualifiers/saved-filter density, true
synchronous-phase peak, native result/JSONB copies, physical Worker exit/reclamation and idle native margin at
executed `Amax + 8,193 = 24,577` checkpoints under the unchanged 2,000 ms deadline. Later margin depends on the
construction producer and final native ingress/DB binding. The exact limits, input transfer/retirement ownership,
result accounting, and shutdown proof remain open as specified above.

The required managed checks ran after implementation commit `efd5852426`:

- Check `24610784-35cb-4f60-b8e8-1ab0feb7bfbd` ran
  `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/semantic/definition-publication-work.test.ts test/semantic/definition-publication-heap.test.ts`.
  The heap diagnostic passed (one test, 1,034 assertions). The command
  exited 1 only because the unchanged original HTTP publication assertion remains the contract's expected
  red: valid excess returned 201 with digest `sha256:e6c0f126b003a7cb15829cd8332d167e7da5961c05963a57b2e796d9a7172a56`,
  where the frozen contract requires 422 `definition_work_exceeded`. It wrote one release, receipt, outbox and
  write-basis row; all other tracked effect-table row deltas were zero. The other original HTTP outcomes passed.
- Root typecheck check `a06fdd5b-b2e6-4649-87f5-72a3be2604f8` passed with exit 0.

Complete raw Worker JSON, exact phase readings, outputs and the expected HTTP red are in managed log
`.temp/goal/checks/worker-check-2026-10-29T20-38-54.542Z-f2aead8b.log` (SHA-256
`575ba6dc5cd03d31fc5806812cfcb50f0a8da54602de905f63fa00ad177d1428`). The root typecheck log is
`.temp/goal/checks/worker-check-2026-10-29T20-38-54.540Z-f5056076.log` (SHA-256
`f0c97240c686a7f5255444a0120dd6c1bf8c1df28df6920bcdf51d1b5a1d041838`). Neither the diagnostic success nor
the retained HTTP red closes publication admission, native margin, physical cleanup or the Semantic Goal.
