# Definition publication CPU admission

This is the owning proposed publication contract and first native HTTP acceptance. It does not implement
execution, change the Problem catalogue or export a preparation/permission capability. Freeze requires
Semantic, Definitions, Core/Accounts, Performance and Root review. The existing production deadline is
2,000 ms. The existing synchronous publication protocol remains. No background publication, 202 response,
additional DBOS launch, release-format reduction or permanent own-work retry loop is selected.

The [Semantic README](README.md#definition-publish) owns existing storage cost; the
[Definitions README](../../../../packages/definitions/README.md) owns release validity and pattern policy.
This document adds proposed work admission and its native schedules, not another schema/safety authority.
The two complete research reports, their paired adoption, Performance decision 30 and final wildcard union
review were read. Their old P1114-refused bundle runs are not successful current-publication evidence.
The historical twenty isolated samples and twelve HTTP failures used the old inline checker, not these counters.

## Existing authority and unchanged outcomes

The actual tree has `iriCompositionProof` before recheck and unconditional `patterns(value, .../value)` after
canonical expected-schema equality. Keep both, every hostile/fixed regression, all catalogue/schema/release bytes,
ordinary/exact quantity variants, historical pins and the checker limits unchanged. `Compile(schema)` already
runs once at module initialization. Call-local distinct-pattern deduplication already exists.

A valid cold release returns 201 and its release digest. Native GET returns exactly that body and immutable
ETag. Exact same-key/body replay returns the original 201 and component, with no new receipt/event/position.
A new key for an existing digest returns 200 through the existing command path: one new receipt, outbox event
and write basis, no second release row. Changed body with a reused key remains `idempotency_conflict` 422.
Current revoked/denied Access returns 403 before receipt disclosure, even for a successful old key.

Proposed own-work refusal is HTTP 422, code `definition_work_exceeded`, `retryable: false`,
`effect_status: not_applied`, errors exactly `[{pointer: '/release', code: 'out_of_range'}]`, no Retry-After.
It has zero new publication, activation, revision, receipt, outbox, write-basis or partition-position effect.
Ordinary malformed release remains `invalid_request` 400; own-work refusal is distinct from idempotency conflict.
Overload/waiting and original-deadline expiry retain their existing typed retryable 503 outcomes.
This specification does not add that code to the production Problem catalogue.

Collection-limit errors precede size, canonical-JSON rejection precedes schema, and existing pointer escaping,
first-code deduplication, lexical ordering and 64-error cap remain. No arbitrary input-depth cap is added.
Pattern unknown/refusal/exhaustion never becomes safe. New work admission must not silently change these errors.
The unresolved precedence case below must be settled before freezing the aggregate producer.

## Owned input, two digests, fresh command

The owned parsed-JSON snapshot must be established before any mutable-body await and before BOTH digest domains.
Release identity remains SHA-256 of JCS(release). Receipt identity remains
`requestDigest('definitions.publish', actor, {params: {}, body: {release}})`; its outer canonical envelope includes
operation, client_id and requested_by. They cannot be substituted for each other. Native JSON rejects non-finite
numbers and malformed Unicode; the direct-call boundary additionally needs explicit sparse-array, cycle,
prototype/accessor/toJSON, alias and partial-freeze decisions without executing caller code. JCS is not that guard.
Do not claim arbitrary Proxy inspection is inert. No caller reference becomes retained authority.

Finish all expensive guard, proof, schema, graph, canonicalization and hashing work before `runCommand`.
Hold no Global/Source gate, command transaction or checked-out command connection during it. The job receives no
Actor, Access, authoritative T, SQL client or permission result. Prepared data conveys no permission.
`runCommand` mints native time BEFORE per-attempt `authorization.prepare`, then takes the gate/transaction,
authorizes at T and only then reads the receipt. Each contention retry refreshes T and Access under the SAME
original deadline. Preparation held longer than the 1,000 ms evidence TTL must finish before this fresh sequence.

Reuse requires an actual immutable validated body in this database/pool, verified through
`readRelease(pool,digest,{composed:false})` and the published-row existence check. A composed body, other-pool
cache entry or equal digest string alone is insufficient. Cold stored bodies still undergo bounded validation
and digest verification before runtime use. Eviction/restart must not reintroduce synchronous unbounded work.
The current process-wide `Map` has no entry/byte bound and is not the proposed cache.

## Work units and diagnostic boundary

Proposed units are deterministic work units, never milliseconds. Let:

- A be the SUM of actual `analyzePattern(...).steps` for distinct exact source/`u`/checker/policy identities not
  covered by the successfully initialized finite fixed table in this module. Repeated submitted patterns still
  incur their walk/lookup bytes and nodes. A structural IRI proof has zero recheck checkpoints, not zero work.
- T be the sum of bytes actually examined/emitted/copied/hashed in each phase, including repeats. Each decode,
  parse, size/ownership walk, Unicode/escape scan, canonicalization, key comparison, schema string/regex check,
  schema comparison, semantic CURIE/list/string comparison, pattern source/recognizer scan, SHA-256 input,
  freeze/serialization and parent/worker transfer contributes separately. UTF-8 bytes apply to serialized buffers;
  an examined UTF-16 code unit costs two bytes. Read AND emitted buffers are separately charged when both occur.
- G be actual primitive semantic/structural work: node/edge/member visits, reference/map probes, list comparisons,
  construction and error insertion/sorting comparisons. Repeated `includes` scans count EACH examined element,
  not one call. Canonical key-sort comparisons charge G and their actually examined key units in T.

The candidate meter is `W = 1024*A + T + 32*G`. Reserve/check before each bounded operation, and debit within
checkpoint/source/string/graph loops; use saturating checked arithmetic. Do not compute a complete expensive W
and then decide to refuse. An indivisible primitive needs an established reservation bound before entering it;
its release of unused reservation cannot authorize a previous overrun. Per-expression 8,192 checkpoints remain.
Initialization on readiness charges the same A/T/G to readiness; lazy initialization inside a request charges
that request. Reuse is not free initialization. No new callable API or guessed worker message DTO is specified.

The test helper calls the UNCHANGED real `analyzePattern` for every distinct submitted source and separately
for each finite generated fixed source; it never injects a work verdict into HTTP. The proposed fixed membership
comes from wikibase-item/media/url/document/monolingual/time schemas plus ordinary/exact integer/decimal wildcard
quantity schemas. All entries must actually pass; key exact bytes, `u`, checker artifact hash and policy source
identity. Deployment/policy change discards the table. Keep unconditional schema walks; no datatype/template
exemption and no arbitrary untrusted cross-request LRU. Failed initialization prevents reusable authority.

The delivered diagnostic is deliberately a LOWER BOUND, not the missing aggregate meter. For valid releases let
B = canonical release bytes, E_r = canonical receipt-envelope bytes, V = sum of canonical property-value schemas.
The current known byte floor is `4B + 2E_r + 2V`: size walk B, validation JCS B, release JCS B and hash B,
envelope JCS E_r and hash E_r, actual/expected value JCS V each (equal for valid schemas). Parse, ownership,
compiled-schema internals, sort comparisons, semantic graph operations and allocations are omitted from this
floor, not asserted to be zero. Optimized reuse may eliminate specific passes only with actual phase evidence.
The excess fixture additionally exceeds the candidate budget through A alone, independent of that byte floor.

Candidate `W_max = 16,777,216` work units and checkpoint weight 1,024 are REVIEW PROPOSALS. The weight makes
16,384 analysis checkpoints alone exhaust the candidate; it distinguishes the ordinary fixtures from thousands
of distinct literals even after fixed-pattern reuse. Node weight 32 is also provisional. No observed ms/checkpoint
conversion proves these weights. The evidence below cannot yet certify a full W or a safe W_max with native margin;
a floor below the budget never certifies admission. Performance must approve full counter/allocation evidence
before these become production constants. In particular, do not describe the candidate as an already derived
upper bound or promise maximum-size publication success.

## Current native counter observations

A single managed disposable phase probe ran the actual unchanged pure validator, then the separate checker
and exact-byte diagnostic, in one pinned process. All five releases returned `[]`, all submitted and eight
fixed-source proofs succeeded. Host A: Linux/check host, Bun 1.4.4 revision
`a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`, 12 visible processors, load averages 9.38/4.06/5.46.
These are loaded-host observations in call order, not isolated percentiles or safety/deadline oracles.
No new worker pool, native HTTP, receipt hash, SQL or physical cleanup was measured by this probe.

| Input                                             | B / envelope bytes    | Distinct / actual checkpoints A_all | A_new after proposed fixed reuse | Known byte floor | Current work floor | Reuse work floor / candidate W_max | Validation ms observation |
| ------------------------------------------------- | --------------------- | ----------------------------------- | -------------------------------- | ---------------- | ------------------ | ---------------------------------- | ------------------------- |
| Current full bundle                               | 140,822 / 140,950     | 15 / 14,311                         | 967                              | 874,424          | 15,528,888         | 1,864,632 / 16,777,216 = 0.11114   | 1,354.94                  |
| Ordinary full bundle plus 3 types / 12 properties | 144,484 / 144,612     | 27 / 14,479                         | 1,135                            | 898,100          | 15,724,596         | 2,060,340 / 16,777,216 = 0.12281   | 615.36                    |
| 64 changed properties                             | 157,432 / 157,560     | 79 / 15,207                         | 1,863                            | 983,172          | 16,555,140         | 2,890,884 / 16,777,216 = 0.17231   | 798.48                    |
| 512 changed properties                            | 268,985 / 269,113     | 527 / 21,479                        | 8,135                            | 1,716,106        | 23,710,602         | 10,046,346 / 16,777,216 = 0.59881  | 867.18                    |
| 3,993 changed / 4,096 total properties            | 1,135,755 / 1,135,883 | 4,008 / 70,213                      | 56,869                           | 7,411,028        | 79,309,140         | 65,644,884 / 16,777,216 = 3.91274  | 2,438.11                  |

Fixed-source initialization actually costs 13,344 checkpoints, separately charged to readiness in the proposed
reuse design. Every generated literal in the changed-input series costs 14 checkpoints under this actual
checker, not the old reports' 11/17-step fixtures. The boundary fixture's new-pattern checkpoints alone cost
58,233,856 candidate units, exceeding W_max without any assumed traversal counts. It retains the entire
current catalogue and is below 4 MiB; schema/pattern invalidity cannot explain the intended HTTP red.

Value-schema canonical byte sums are 14,618 / 15,470 / 19,162 / 50,970 / 298,121 respectively. Observed process
RSS after those validations is 164,241,408 / 197,287,936 / 244,936,704 / 249,573,376 / 292,106,240 bytes.
These sequential process readings and the runner's 445 MiB peak include diagnostics/runtime/install and cannot
derive worker baseline H0, c or peak heap. No physical allocation bound is claimed.

The candidate budget separates 512 ordinary changed literals from the existing collection boundary and admits
the _measured floors_ of both required ordinary bodies. The cold bundle's observed remaining 645.06 ms and
ordinary body's 1,384.64 ms against 2,000 ms exclude native overhead and are margin observations only. They do
not prove full aggregate admission or native success. Reuse-floor fractions are prospective arithmetic from
actual successful exact proofs, not timings of an implemented fixed table. This is why approval still needs
the full meter, native cost/history rows and memory proof; the numbers are not an authorization to build the pool.

## Resource ownership and decision 30

Core/Performance configure K beside `ADMISSION_LIMITS`, with `1 <= K <= permits` and K below processor count.
No literal production K is selected here. Fixed threads initialize once per process and are reused. Every job
holds its original admission permit. CPU waiters are at most permits minus K, visible within existing admission
running/waiting accounting, with no independent request/CPU queue or permit reacquisition. Existing overload is
503 beyond admitted capacity. Existing normal 8/reserved 2/queue 32 getters alone do not implement this sub-lane.

After EVERY transition, active plus retired threads must be at most K; idle ready threads also occupy their slots.
Deadline/abort/error retires and terminates the thread. Its slot and input-byte reservation stay occupied until
actual exit/termination completion has been observed. No replacement timer. Unobserved exit beyond an
owner-approved cleanup bound makes the process NOTREADY and leaves the slot retired. Late results have authority
only for the slot's still-live job identity. Shutdown stops intake, terminates/awaits every thread, reaches zero
jobs/threads/retained input reservations, and only then closes the pool. A close event, Promise.race, unref or
late-result check alone is not physical thread/heap reclamation evidence.

Bun ignores Worker resourceLimits; no runtime heap cap is claimed. Required transport is one transferred owned
input buffer of at most existing 4 MiB, never structured cloning the parsed object graph. Result is verdict,
digests and at most 64 errors. Parent O(B) copying/encoding and all result bytes are counted. Parent per-node JS
traversal belongs in the CPU job, including reconstruction needed by the existing JSONB write binding.
For worker baseline H0 and measured/derived amplification c, worker bytes are at most `H0 + c*B_max`; process
reservation is `K*(H0+c*B_max) + parent bytes + cache bytes + bounded result bytes`. Active AND retired allocations
remain charged. RSS deltas/process high-water observations do not prove this bound or c.

A cache proposal is at most eight entries AND 8 MiB of canonical retained bytes, evict oldest insertion first
until both bounds hold; a single oversize entry is not retained. Eight entries hold the independent eight-body
history scale; 8 MiB holds two maximum canonical bodies. These are candidate ACCOUNTED buffer capacities, not
proof that retained parsed-JS heaps occupy 8 MiB. Minimize retention to authoritative published data, no pending
promises or arbitrary pattern proofs. Performance must select E/actual resident-byte accounting and c; no literal
E/c/cleanup duration is shipped. The current helper does not build this cache or a CPU pool.

## Native schedule matrix and REQUIRED boundaries

No matrix row below is represented by a skipped test, optional driver, mocked successful validation, `true`,
`complete` or `noData` helper. They are outstanding native acceptance schedules. Assert actual original permits,
CPU waiters, live/idle/retired threads, outstanding jobs, owned/transferred/parent/result/cache bytes, held
connections/gates and effects after EVERY listed step, not merely at the end. Existing fixture pool/Auth ownership
must remain; do not swap another pool into its kernel to make measurement convenient.

| Schedule                        | Causal steps and required assertions                                                                                                                                                                                                                                                                                            | Available producer / precise missing owner boundary                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First publication and replay    | Validate current bundle and new three-type/twelve-property fixture independently; cold POST 201, native GET/body/digest, same-key 201/no effects, new-key 200/current command effects, changed-key-body 422, malformed 400; remove real grant, replay 403/no receipt disclosure; valid over-work POST 422/all effects unchanged | Delivered named HTTP test uses unmodified `createSemanticDriver`, its real shared Auth and fixture pool; direct fixture grant deletion follows real-access.ts, not a custom permission checker      |
| CPU progress                    | Enter actual checker phase, hold its internal phase barrier outside command; complete unrelated ordinary GET and reserved Auth request before release; resume same actual proof; observe real active CPU separately from a parked barrier                                                                                       | REQUIRED Core/Definitions internal actual-job phase barrier and checker entry/exit producer; shared Semantic/Auth request producer already exists                                                   |
| Ownership and digest binding    | Hold after snapshot/before proof; mutate original nested body (including partially frozen ancestor); release and require original digest/body/receipt, changed input conflicts; repeat Unicode, -0, aliases, cycles, holes, getters/toJSON and byte/collection/cap boundaries                                                   | REQUIRED Semantic HTTP/direct-call ownership observation before BOTH hashes; HTTP driver serializes input immediately and cannot alone exercise mutable native objects                              |
| Publication authority           | Seed identical body in DB A; request in DB B must miss despite process cache; use different pool identities, composed-only body, restart and eviction; corrupt cold stored body must fail actual proof/digest before runtime                                                                                                    | Existing `readRelease(...,{composed:false})` and fixture pool; REQUIRED Semantic bounded-cache residency/eviction producer, independently owned two-driver schedule without retargeting shared Auth |
| Capacity                        | Fill K jobs under original permits; fill at most permits-K CPU waiters; next admitted-capacity overflow uses existing overload; release one job, resume oldest admitted waiter without new permit/deadline                                                                                                                      | REQUIRED Core internal sub-lane accounting bound to actual Admission, not new public API or helper queue                                                                                            |
| Deadline and cancellation       | Enter actual proof, expire original 2,000 ms deadline or abort; return typed refusal/no effects; observe retired slot; inject late result, observe discard; only actual exit permits replacement                                                                                                                                | REQUIRED Core actual running-thread cancel/exit and original-deadline notification producer; default deadline and JobContext already exist                                                          |
| Error/startup/exit not observed | Fail startup, worker error and repeated deadlines; hold exit acknowledgement beyond approved cleanup bound; assert active+retired<=K at each transition, NOTREADY, no replacement, no unbounded bytes                                                                                                                           | REQUIRED Core/Work runtime physical exit/reclamation evidence and readiness observation; timer/close notifications cannot supply it                                                                 |
| Shutdown                        | With live, idle and retired slots and a waiter, initiate normal shutdown; cancel/drain, await physical exit of every thread, counts/bytes zero BEFORE pool end                                                                                                                                                                  | REQUIRED Work/Core shutdown ordering and physical thread/heap evidence; existing service relay stop does not prove CPU disposal                                                                     |
| Fresh Access and retry          | Hold actual preparation beyond evidence TTL; revoke/suspend during hold; release; record mint T then prepare Access then authorize before receipt, denied replay returns no stored result; force native contention retry and observe fresh T/evidence without repeating immutable proof                                         | Existing `runCommand`/real Auth/Access producers; REQUIRED Core CPU barrier plus Accounts internal per-attempt trace and native contention schedule; never transport T/Access into job              |

## Cost rows

### Cold publication — Touches / Bound / Growth check

Touches: distinct P_new current proofs and all actual phase bytes/nodes/edges above; one published-row insert
attempt plus native Auth/Access/command statements. Bound: linear in changed input plus explicitly metered key
sorts/list scans, W at most approved W_max, constant statements with independent publication history.
Growth check: pure diagnostics at 64/512/3,993 added properties (4,096 total is the existing collection boundary)
retain the FULL current bundle, not a tiny alternate catalogue. Independently vary actual prior publications
1/8/64 while holding changed input fixed. Do not substitute returned rows or time for examined work.
REQUIRED Semantic fixture capture attachment to the original kernel pool AND shared Auth/all library pools,
using `growth-capture.ts` and `withoutCatalogStatements`/the shared catalog classifier. Existing growth tests
at 1/4/16 with permissive Access are storage evidence, not this real-Auth counter/history acceptance.

### Warm same body — Touches / Bound / Growth check

Touches: bounded owned input and both domain hashes, finite fixed proof hits, actual published existence/body
read points. Bound: zero fresh proof checkpoints on proven fixed hits; byte work still follows this request's B;
constant statements/history, not constant in input bytes. Growth check: native body hit at history 1/8/64 with
actual existence/read statements and step counters, including cold stored-body miss after eviction. REQUIRED
bounded published-cache producer plus same all-pools capture boundary; current native GET is covered functionally.

### Exact replay / new key — Touches / Bound / Growth check

Touches: fresh native authentication, T, Access preparation/authorization and receipt lookup; new key also uses
ordinary existing-digest command path. Bound: constant statements/history; same-key adds no effect, new key adds
current one receipt/event/write basis. Growth check: repeat at prior history 1/8/64 with the shared classifier,
no pre-authorized receipt lookup and no unobserved Auth pool. Functional first case is executable today;
REQUIRED all-pools capture and current-attempt trace for full cost proof.

### Cache — Touches / Bound / Growth check

Touches: same-pool published bodies and finite module-owned proofs only. Bound: approved E and actual resident
bytes, eviction on both entry and byte pressure, readiness policy identity; no retained untrusted-pattern LRU.
Growth check: publish 1E/8E/64E distinct bodies, including maximum-size and small bodies, inspect occupancy after
every insertion/replacement/eviction and verify miss authority. REQUIRED Semantic residency producer and
Performance actual allocation accounting; canonical byte sum alone is insufficient resident-memory evidence.

### Resource schedules — Touches / Bound / Growth check

Touches: original permits/waiters, K fixed threads, retirement, one transferred owned input, parent/result/cache
allocations and shutdown. Bound: active+retired<=K at EVERY transition, waiters<=permits-K, original deadline,
physical reclamation before replacement and shutdown zero before pool closes. Growth check: matrix resource
schedules above, repeating deadline/abort/error/late-exit cycles and measuring H0/c against all three changed
input sizes. REQUIRED Core/Work physical evidence and Performance c/cleanup approval. Native shape/counter
measurements and a successful HTTP response do not prove concurrency or cleanup.

## Remaining freeze decisions

The required 4 MiB transferred-input condition is not yet reconciled with the existing 4 MiB CANONICAL release
cap. `{release: ...}` adds 12 bytes even without envelope metadata, whitespace can increase wire bytes without
changing release validity, and JSON escape spellings can expand them further. Elysia currently parses on the
parent before this route. Producing a canonical <=4 MiB release buffer there requires the per-node parent walk
that decision 30 moves into the job. Sending the unbounded wire body violates the transport condition; rejecting
it at 4 MiB silently reduces the admitted format. Core/Performance/Semantic must choose a bounded ingress/
streaming ownership primitive or explicitly reconcile this unit mismatch. This document does not invent one.

Likewise the present pure validator has no aggregate T/G debit boundary, and TypeBox/JCS/checker allocation
internals do not expose a full release meter or native heap upper bound. `analyzePattern.steps` supplies real A,
not allocation work between checkpoints. The lower-bound diagnostic can establish deterministic excess but
cannot close full W, c or native margin. Performance must approve the metering/reservation strategy and memory
proof before an execution producer is dispatched. No guessed c/heap claim is justified by the old measurements.

Finally, if a late semantic/unsafe-pattern defect exists only after work would exhaust W_max, preserving the
old complete malformed 400 diagnostic while stopping before excess work requires an owner-defined ordering or
bounded reservation proof. Running the whole validator then refusing violates early refusal; returning early
422 for every such malformed input changes existing precedence. Semantic/Definitions must settle this exact
mixed invalid/over-work case, without weakening any old per-pattern controls. Ordinary malformed 400, collection/
size precedence and the valid excess fixture are already specified separately.

These are precise proof/owner boundaries, not a request for another external research pair or a runtime API.
Until resolved, candidate numeric values are not freeze-ready and this SPEC does not claim native runtime,
physical reclamation, main/root gate or Goal completion.
