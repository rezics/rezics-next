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
collected cell/byte counters. Release readings follow each witness. Next, 32,768 explicitly retained parent
objects must appear in the parent's heap without appearing as that many additional Worker cells. This tests
VM locality, rather than assuming that a process-wide metric becomes local when called from a Worker.

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

The diagnostic has not yet produced accepted measurements. Raw parent-reviewed JSON belongs in the managed check
log, with its exact revision/runtime/host/load; no numbers are populated before execution. The required final
checks are the two-file kernel check and root typecheck once after the final implementation commit. A queued
check stays queued until its managed terminal result. Diagnostic success and the deliberately red original HTTP
case must be reported separately. No passing heap assertion closes publication admission or this Goal.
