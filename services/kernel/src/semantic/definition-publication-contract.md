# Definition publication CPU admission

This is the owning proposed publication contract and first native HTTP acceptance. It does not implement
execution, change the Problem catalogue or export a preparation/permission capability. Freeze requires
Semantic, Definitions, Core/Accounts, Performance and Root review. The existing production deadline is
2,000 ms. The existing synchronous publication protocol remains. No background publication, 202 response,
additional DBOS launch, release-format reduction or permanent own-work retry loop is selected.

The [Semantic README](README.md#definition-publish) owns existing storage cost; the
[Definitions README](../../../../packages/definitions/README.md) owns release validity and pattern policy.
This document adds proposed work admission and its native schedules, not another schema/safety authority.
The current paired adoption and Performance's candidate review supersede the earlier weighted-meter proposal:
the proposed runtime meter is pattern checkpoints only; other work needs construction bounds. Root approved the HTTP
precedence amendment below; ingress integration and execution proofs remain required before freeze.
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
Root approved cheap bounded 400 checks, sorted distinct analysis, then first-excess 422; see the
[publication owner section](README.md#definition-publish). That storage section remains the owner link; its
HTTP amendment must accompany the runtime handoff, without duplicating Definitions safety authority.

## Owned input, two digests, fresh command

Owned serialized input must be established before any mutable-body await and before BOTH digest domains.
Release identity remains SHA-256 of JCS(release). Receipt identity remains
`requestDigest('definitions.publish', actor, {params: {}, body: {release}})`; its outer canonical envelope includes
operation, client_id and requested_by. They cannot be substituted for each other or replaced by a wire hash.
Whitespace and equivalent JSON escapes must replay as the same value within the wire limit. Native JCS rejects
non-finite numbers and malformed Unicode. Direct internal callers must cross the same owned serialization
boundary; getters, cycles, holes, toJSON and partially frozen caller graphs cannot become authority through an
object-identity cache. No arbitrary Proxy inspection is claimed inert. JCS is not an ownership guard.
No caller reference becomes retained authority.

Finish all expensive guard, proof, schema, graph, canonicalization and hashing work before `runCommand`.
Hold no Global/Source gate, command transaction or checked-out command connection during it. The job receives no
Actor, Access, authoritative T, SQL client or permission result. Prepared data conveys no permission.
Only the separate bounded digest context described below accompanies owned body bytes.
`runCommand` mints native time BEFORE per-attempt `authorization.prepare`, then takes the gate/transaction,
authorizes at T and only then reads the receipt. Each contention retry refreshes T and Access under the SAME
original deadline. Preparation held longer than the 1,000 ms evidence TTL must finish before this fresh sequence.

Publication requires no body cache. Each request parses its own owned bytes once and computes both canonical
digest domains. An indexed published-digest existence probe in this actual database/pool can establish current
published authority. A composed body, other-pool entry or caller-supplied digest cannot. The present
`readRelease(pool,digest,{composed:false})` is the available runtime-read boundary: it verifies DB existence
even on a cache hit, validates/digest-checks a cold body and freezes it. It is not a new publication API.
Cold stored bodies must still undergo bounded verification before runtime use. Restart/eviction must not
reintroduce unbounded synchronous work. Runtime-read cache residency is separate from publication admission.

## Checkpoint admission and construction bounds

The sole proposed runtime meter is A, the SUM of actual `analyzePattern(...).steps` for distinct exact
source/`u`/checker/policy identities outside the successfully initialized finite module-owned fixed table.
Proposed `A_max = 16,384` checkpoints per request. A checkpoint is not a millisecond. Preserve the existing
8,192-checkpoint per-expression policy, source/depth/expansion/graph limits and unknown/fuzz refusals.
Fixed initialization costs its actual proof work at readiness, once per process; if done lazily it still
consumes that request's original deadline. Failed initialization supplies no reusable authority.

Fixed membership is the exact sources generated by wikibase-item/media/url/document/monolingual/time schemas
and ordinary/exact integer/decimal wildcard quantities. The diagnostic actually proves all eight sources
through today's unchanged checker. Identity includes exact source bytes, flags, checker artifact and policy.
Module/policy replacement discards the table. Structural IRI proof has zero native checkpoints but still
bounded source-recognition work. Keep unconditional schema pattern walks and call-local distinct-source
lookup; neither a canonical template nor a datatype tag grants an exemption. No arbitrary untrusted
cross-request proof LRU is selected.

Enforcement must stop at the first reservation that would exceed A_max, before effects. It must limit the
current pattern as well as the sum of finished patterns: completing an analysis then checking its count
is insufficient. The existing `analyzePattern` only returns steps after analysis; it exposes no remaining-
aggregate-budget argument or intermediate cancellation hook. REQUIRED Definitions/Semantic internal native
proof of aggregate enforcement under the unchanged per-pattern policy; this document exports no such API.
Conservatively reserving 8,192 for every pattern would reject the useful ordinary fixture and is not adopted.

Other work is bounded by capped wire/canonical bytes and explicit construction. The earlier candidate
`W = 1024*A + T + 32*G`, its weights and weighted admission fractions are rejected by Performance. No T/G
runtime debits inside TypeBox, JCS, SHA or recheck are adopted. Exact byte measurements remain cost evidence:
B = canonical release bytes; E_r = canonical receipt-envelope bytes; V = sum of canonical property-value schemas.
The current successful-path byte floor is `4B + 2E_r + 2V`: size walk B, validation JCS B, release JCS B/hash B,
envelope JCS E_r/hash E_r and actual/expected value JCS V each. It omits parse, source scans, key comparisons,
compiled-schema internals and graph traversal; it is neither a full byte count nor an admission certificate.
Repeated traversals must remain visible in phase evidence, even though bytes do not enter the runtime meter.

The test/helper retain historical weighted arithmetic fields only to preserve every frozen candidate assertion.
The additional checkpoint-only growth case asserts `A_new > 16,384` independently of bytes/weights. A low weighted floor does
not certify admission, and the historical exports do not set product constants or supply HTTP verdicts.

### Own input loops and required construction

Here n counts owned input nodes/edges/members and L their string units; n is bounded by input bytes, not history.
Key-sort comparisons cost O(n log n) comparisons plus compared string units; do not label that O(n).
These are source derivations, not measured graph counters or claims that opaque library internals are metered.

| Existing phase / producer            | Input touches and construction obligation                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` collection limits         | Enumerate type/property/context/filter keys; per-type properties/facets length checks; context defaults keys; filter group Map counts. O(n+L), no nested global scan.                                                                                                                                                                                                                                                                     |
| `exceedsSize`                        | Iterative node stack; enumerate each member, stringify each key/primitive, count actual emitted UTF-8 bytes, stop at cap. O(n+L); current arbitrary JS boundary is not owned JSON proof.                                                                                                                                                                                                                                                  |
| `validateRelease`                    | One whole-release JCS pass; Library progress checks; compiled shape Check and, only if invalid, Errors. Error Map keeps first code/pointer, final lexical sort and 64 cap. Fixed passes with key sorts; no per-property Compile.                                                                                                                                                                                                          |
| Semantic mappings/lists/CURIEs       | Enumerate definitions, adjacent sorted-list comparisons, own-key reference checks and CURIE scans. O(n+L). Property-IRI and target-name Sets built once, then point probes.                                                                                                                                                                                                                                                               |
| Type bases/properties/facets         | Visit all bases/properties/facets. Current facets call `type.properties.includes`; replace repeated membership with a Set per type. Existing 64/16 caps bound it today; do not carry nested scans into the new construction.                                                                                                                                                                                                              |
| Relations/qualifiers/units           | Walk qualifiers, targets, unit lists and relation filters. Current relation filter/slot/order checks use qualifier `includes`; prebuild a qualifier Set per property. Unit `includes('*')` in `buildValueSchema` is one linear scan, not one scan per unit. Fixed datatype/option arrays are constant.                                                                                                                                    |
| Fixed schema and patterns            | Reconstruct expected schema once/property; canonicalize actual and expected; unconditional iterative member walk; deduplicate sources locally; sort distinct sources before analysis. Fixed passes plus key/source sorts; proof checkpoints separately bounded by A_max.                                                                                                                                                                  |
| Library profiles                     | `libraryProgressSemantics` visits allowed modes/units; `libraryProfileSemantics` uses Sets for duplicate ids and traverses kinds/statuses/import sources. Count each child visit; no publication-history scan.                                                                                                                                                                                                                            |
| Contexts and saved filters           | Defaults point-check property keys. Visit every filter node and embedded subject-id string. `validateFilter`/`admitFilter` parse and visit bounded filter trees; `typeFacets` scans each selected type's bases/facets, `allReleaseFacets` caches their union per release, and qualifier membership scans lists. Repeated selected-type expansion across filters needs reuse by construction; a filter call is not one constant operation. |
| Serialization/hashes/command binding | Parse once in the job; canonical key sorts; two distinct hash domains; owned transfer and bounded result; JSONB parameter serialization/freeze if retained. Attribute every additional pass to parent/job. The current pg binding of a graph is not proof of no parent per-node traversal.                                                                                                                                                |

The disposable copied-source observation below counts the actual `index.ts` loop bodies, including native
list membership comparisons, at 64/512/3,993 changed properties. REQUIRED Definitions/Filter instrumentation
for the remaining Library/filter child loops and independently varied saved-filter shapes; the observed
series keeps those shapes fixed. Neither helper `valueNodes` nor returned SQL rows is an operation counter.
New runtime must replace repeated growing membership scans with Set/Map; this specification changes none
of those product loops.

### Deterministic own-loop observation

A managed disposable probe copied only `index.ts` under `.temp/definition-publication/`, resolved its original
imports and added counters at actual loop bodies. It counted actual `Array.prototype.includes` element reads
through a Proxy in the copy, without changing the membership algorithm or validator verdict. Both the unchanged
validator and the instrumented copy returned `[]` at all three sizes; the checker was not modified. These are
observed own-loop operations, not debits charged to TypeBox/JCS/SHA or a new runtime meter.

| Added properties | Definition entries | Property entries / IRI visits each | Datatype-member visits | Pattern nodes | Pattern members | Membership comparisons | Sum of counted operations |
| ---------------: | -----------------: | ---------------------------------: | ---------------------: | ------------: | --------------: | ---------------------: | ------------------------: |
|               64 |                194 |                                167 |                    668 |           280 |             779 |                  5,281 |                     8,935 |
|              512 |                642 |                                615 |                  2,460 |           728 |           2,571 |                  5,281 |                    14,311 |
|            3,993 |              4,123 |                              4,096 |                 16,384 |         4,209 |          16,495 |                  5,281 |                    56,083 |

Each row also counts 12 profiles, 920 sorted-list members, 27 types, 43 bases, 202 facets, 27 target-type
entries, 43 target bases, 73 targets, 26 relation filters and 26 saved filters. The sum is exactly
`8,167 + 12*addedProperties` for this fixture family. This does not prove growth for independently enlarged
qualifier/facet lists, filter trees or Library shapes, and does not count opaque compiled validation, key-sort
comparisons or all child-library internals. Their construction obligations above remain REQUIRED.

The successful managed probe is `34c3c039-8127-41e2-82e5-4d9b446ec160`, log
`.temp/goal/checks/worker-check-2026-10-29T11-03-38.061Z-f8e62a59.log`. Source SHA-256 is
`0717ecf05f578ac5b6247689c79223bd846bedeb17ba5f860fcc55ecd517e21a`; instrumented copy SHA-256 is
`0251886cb8366a32a5a147ca1c182d44359af39a0ce786cbf6a13ae4e1775bd9`.
Host `ah-ipv6`, Bun 1.4.4 revision `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`, 64 visible processors,
load averages 67.46/53.22/43.19: loaded-host deterministic evidence only, no margin or heap claim.
The first remote attempt could not synchronize the ignored temporary script; the first local attempt could
not resolve its copied package import. Neither executed the probe. The successful local managed attempt
resolved dependencies from the original Definitions package, without editing dependencies or product source.

## Successful current-policy counter observations

A single managed disposable phase probe ran the actual unchanged pure validator, then the separate checker
and exact-byte diagnostic, in one pinned process. All five releases returned `[]`, all submitted and eight
fixed-source proofs succeeded. Host A: Linux/check host, Bun 1.4.4 revision
`a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`, 12 visible processors, load averages 9.38/4.06/5.46.
These are loaded-host observations in call order, not isolated percentiles or safety/deadline oracles.
No new worker pool, native HTTP, receipt hash, SQL or physical cleanup was measured by this probe.

| Input                                             |         B |       E_r |  A_all |  A_new |       V | Exact byte floor | Validation ms observation |
| ------------------------------------------------- | --------: | --------: | -----: | -----: | ------: | ---------------: | ------------------------: |
| Current full bundle                               |   140,822 |   140,950 | 14,311 |    967 |  14,618 |          874,424 |                  1,354.94 |
| Ordinary full bundle plus 3 types / 12 properties |   144,484 |   144,612 | 14,479 |  1,135 |  15,470 |          898,100 |                    615.36 |
| 64 changed properties                             |   157,432 |   157,560 | 15,207 |  1,863 |  19,162 |          983,172 |                    798.48 |
| 512 changed properties                            |   268,985 |   269,113 | 21,479 |  8,135 |  50,970 |        1,716,106 |                    867.18 |
| 3,993 changed / 4,096 total properties            | 1,135,755 | 1,135,883 | 70,213 | 56,869 | 298,121 |        7,411,028 |                  2,438.11 |

All byte columns are UTF-8 bytes, all A columns are actual unchanged-checker checkpoints. Fixed-source
initialization costs 13,344 checkpoints at readiness. Each generated new literal costs 14. The last fixture
retains the entire current catalogue and is below 4 MiB; schema/pattern invalidity cannot explain its HTTP red.
No weighted floor is an admission threshold. The checkpoint-only series is asserted by the added diagnostic
case; these measurements do not implement reservation inside analysis.

Value-schema canonical byte sums are 14,618 / 15,470 / 19,162 / 50,970 / 298,121 respectively. Observed process
RSS after those validations is 164,241,408 / 197,287,936 / 244,936,704 / 249,573,376 / 292,106,240 bytes.
These sequential process readings and the runner's 445 MiB peak include diagnostics/runtime/install and cannot
derive worker baseline H0, c or peak heap. No physical allocation bound is claimed.

Under checkpoint-only admission the bundle is `967 / 16,384 = 0.05902` of A_max and the ordinary
three-type/twelve-property fixture is `1,135 / 16,384 = 0.06927`. The changed-input series is
`1,863 / 16,384 = 0.11371`, `8,135 / 16,384 = 0.49652`, and `56,869 / 16,384 = 3.47101`.
These are actual checkpoint counts with prospective fixed-table reuse, not implemented runtime admission.
All eight fixed proofs succeeded; initialization
is 13,344 checkpoints. New literal sources each cost 14 checkpoints on the unchanged current checker.

The cold bundle's observed 645.06 ms and ordinary body's 1,384.64 ms remaining against 2,000 ms exclude
native overhead. They are loaded-host margin observations, not a safe A_max or native completion proof.
Before A_max/K freeze, REQUIRED Performance/Semantic one native observation with A exactly A_max and a
maximum-canonical-size body on an idle check host, recording host/runtime/load and all native overhead.
The existing helper/fixture series does not produce that exact-boundary workload or an idle-host observation.
Do not repeat the historical eighty-publication incident suite or infer maximum-size publication success.

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

Bun ignores Worker resourceLimits; no runtime heap cap is claimed. Proposed transport is one transferred
owned wire buffer, never a structured clone of a parsed graph. Result is verdict, digests and at most 64 errors.
Charge actual ingress assembly, parent byte scans and allocations; transfer adds zero full-body copy.
Per-node JS parsing/traversal belongs in the job. Parse once.

The current adopted ingress declaration is `RELEASE_LIMITS.bytes + 65,536 = 4,259,840` wire bytes, independently
of the unchanged 4,194,304 canonical-release-byte cap. Send compact JSON: key ordering does not affect compact
length; the `{release: ...}` envelope adds 12 bytes. Whitespace/escape-inflated spellings count against wire
bytes. Content-Length over cap refuses before reading; streaming excess cancels and returns 413
`content_too_large`, with no receipt/key/effect or extra Access/receipt/rate-limiter call. Diagnostics disclose
sizes/codes, not body text or account ids. This is the adopted shared ingress proposal, not an existing
Semantic parser or permission capability.

Root assigned ingress to Performance: `http/body.ts`, `app.ts`, `server.ts`, the Definitions route declaration,
owned-byte/wire-count accessors, process byte reservations and native ingress acceptance. The producer is
registered but not delivered; no accessor signature is inferred. The amended ingress brief resolves the mode
design: default JSON mode parses once; `detail['x-body-mode']='raw'` performs no decode, parse or body-schema
check in the request path and exposes owned bytes/wire count. Its native acceptance must send non-JSON bytes
to a raw handler. Definitions remains in JSON mode in that ingress task. The later Semantic implementation
switches it to raw and moves parse, validation, canonicalization and both digests into the job. Registering raw
mode alone does not remove the current parent parse. Do not detach a buffer still owned by ingress or infer
mutable-buffer transfer ownership before delivered-code review. Both modes retain wire/reservation bounds;
pre-admission bodies consume ingress reservations independently of original request permits.

### Digest context and whole-process memory

The main thread derives exactly `{operation,client_id,requested_by}` from the mounted route and verified Actor.
Both identity fields are null for anonymous. Never use body principals, headers or arbitrary raw data as identity.
This small canonical context is data, never permission. No Actor/Access/T/client/authorization crosses the boundary.
No context is returned, logged or persisted. Discard parent references after transfer and job context after completion,
cancellation or retirement; late results must not echo it.

`http/request.ts` currently owns one `requestDigest(operation,actor,body)` implementation. The future shared
extractor must split ONE pure core over context/body and use it from BOTH that wrapper and the job, keeping
all real consumers/imports/tests byte-compatible. This SPEC exports no core/signature. The existing canonical
envelope sorts `body`, `client_id`, `operation`, `requested_by`. Incremental hashing feeds `{"body":`, canonical
BODY bytes, then the comma-prefixed canonical client/operation/requested-by members and `}` in that order.
BODY here is `{params:{},body:{release}}`, not the release alone. This preserves the receipt digest domain exactly;
never hash raw-wire spelling or invent a context-first domain. Release SHA-256 remains its separate JCS domain.
Anonymous idempotency-key restrictions and the receipt-key codec remain unchanged.

For this route, mounted `operationId` is `definitions.publish` (19 ASCII bytes). Actual Auth `text` in
`services/auth/src/service.ts` and verified claims in `access/authenticate.ts` limit client id to 1,024 UTF-16
units. The claim validator does not impose an ASCII-only rule. The worst allowed JSON string content is six
UTF-8 bytes per unit (for example an escaped control); do not assume 1,024 bytes. `requestedByPattern` fixes
`urn:rezics:request:` (19 bytes), two 36-byte UUIDs and one colon: 92 bytes. Empty-string fields with the mounted
operation, punctuation and key names cost 68 JCS bytes including quotes. Thus `C_max = 68 + 6*1024 + 92 = 6,304`
canonical bytes, also covering null/ordinary accounts. The added pure size-witness test asserts these numbers;
it does not mint an Actor, claim that a control-character client has native consent, or prove a transfer.
Native maximum-context identity issuance remains Accounts' boundary. A stricter proven Auth repertoire may
reduce this conservative verified-claim bound only with Accounts/Performance approval.

Never concatenate context and body into a second full buffer in the parent. Transfer the owned body ArrayBuffer
with a transfer list, detaching every parent view; send context separately as small bounded canonical data.
The actual ingress producer must settle transfer/release ownership; a borrowed accessor alone is insufficient.
REQUIRED native maximum-wire-body plus maximum-context admission, detached parent bytes/no retained parent
reference, and disposal/late-result-no-context-echo schedules. Hash equality against the existing wrapper must
cover real account, delegated and anonymous requests; changing either client_id or requested_by must change
its digest/conflict, while whitespace and escape variants remain JCS-equivalent. Future extractor scope includes
`http/request.ts`, its actual consumers/tests and Accounts review. No copied digest implementation in test support.

With idle JOB heap H0 bytes, working-set amplification c bytes/byte EXCLUDING the transferred input, and actual
ingress reservation I, the whole publication/ingress process bound is
`I + K*(H0 + c*B_wire_max + C_max) + bounded result bytes`, plus separate runtime-read cache storage.
Here `B_wire_max = 4,259,840`, `C_max = 6,304`, and
`I = (permits+queue)*1,048,576 + 2*4,259,840 = 50,462,720 bytes` (40 MiB plus two largest bodies).
Ingress keeps its reservation UNTIL THE REQUEST ENDS, including while its buffer is transferred to the job;
the input is already in I. Do not add another K*B or permits*B term. Count actual ingress assembly/framing
buffers under I, context and message overhead separately, active AND retired allocations until disposal, and
result allocations until consumed. This formula grants neither a new buffer allowance nor a pool size.

Measure H0 and c from JOB heap after forced GC following parse/validation at all three changed-input sizes,
excluding transferred input bytes. Record runtime/host/load and fit/qualify c; whole-process RSS is insufficient.
Transient parse/checker/JIT/message allocations, framing and retained successful result serialization for the
existing DB insertion need precise native measurement/binding. A verdict plus digests alone cannot insert a
release body: no parent graph clone/reparse/JSONB serialization may hide as free. REQUIRED Semantic/Core bounded
successful-result/DB binding and Performance byte review; no invented result DTO is selected here. Performance
sets memory budget and K after those measurements and the idle-host A_max/max-body native margin observation.
No literal K/c/cleanup duration or production pool is shipped before that evidence. Bun resourceLimits provides
no heap cap, and post-GC slope is not a physical reclamation or peak allocation proof.

The existing runtime-read cache is independently unbounded. Performance accepts a proposal to retain canonical
bytes keyed by digest AND pool, at most eight entries AND 8 MiB, evicting oldest insertion until both limits hold;
no pending promises, composed entries or arbitrary pattern proofs. Actual parsed graphs, if retained, require
c-times-byte accounting. Cold misses still need current-policy/digest verification. Publication retains no body
cache. REQUIRED Semantic runtime-read residency/eviction evidence at 1E/8E/64E and Performance allocation review;
no native cache producer or production literal is delivered by this document.

## Native schedule matrix and REQUIRED boundaries

No matrix row below is represented by a skipped test, optional driver, mocked successful validation, `true`,
`complete` or `noData` helper. They are outstanding native acceptance schedules. Assert actual original permits,
CPU waiters, live/idle/retired threads, outstanding jobs, owned/transferred/parent/result/cache bytes, held
connections/gates and effects after EVERY listed step, not merely at the end. Existing fixture pool/Auth ownership
must remain; do not swap another pool into its kernel to make measurement convenient.

| Schedule                        | Causal steps and required assertions                                                                                                                                                                                                                                                                                            | Available producer / precise missing owner boundary                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First publication and replay    | Validate current bundle and new three-type/twelve-property fixture independently; cold POST 201, native GET/body/digest, same-key 201/no effects, new-key 200/current command effects, changed-key-body 422, malformed 400; remove real grant, replay 403/no receipt disclosure; valid over-work POST 422/all effects unchanged | Delivered named HTTP test uses unmodified `createSemanticDriver`, its real shared Auth and fixture pool; direct fixture grant deletion follows real-access.ts, not a custom permission checker                            |
| CPU progress                    | Enter actual checker phase, hold its internal phase barrier outside command; complete unrelated ordinary GET and reserved Auth request before release; resume same actual proof; observe real active CPU separately from a parked barrier                                                                                       | REQUIRED Core/Definitions internal actual-job phase barrier and checker entry/exit producer; shared Semantic/Auth request producer already exists                                                                         |
| Ownership and digest binding    | Hold after snapshot/before proof; mutate original nested body (including partially frozen ancestor); release and require original digest/body/receipt, changed input conflicts; repeat Unicode, -0, aliases, cycles, holes, getters/toJSON and wire/canonical-byte/collection/cap boundaries                                    | REQUIRED Performance owned-wire producer and Semantic binding before BOTH hashes; HTTP driver serializes immediately and cannot prove internal ownership                                                                  |
| Publication authority           | Seed identical body in DB A; request in DB B must miss despite process cache; use different pool identities, composed-only body, restart and eviction; corrupt cold stored body must fail actual proof/digest before runtime                                                                                                    | Existing `readRelease(...,{composed:false})` and fixture pool; REQUIRED Semantic same-pool published-existence binding and separate runtime-read cache producer; independent two-driver schedule without retargeting Auth |
| Digest context/transfer         | Use real account/delegated/anonymous Auth; maximum body/context fits; transfer detaches parent views; compare job digest byte-for-byte to existing requestDigest; change each identity field; hold/cancel and inspect no parent retention or late context echo                                                                  | REQUIRED Accounts native maximum/delegated fixtures, shared requestDigest core producer and Performance/Core ownership/disposal instrumentation; size-witness test only proves the bound                                  |
| Capacity                        | Fill K jobs under original permits; fill at most permits-K CPU waiters; next admitted-capacity overflow uses existing overload; release one job, resume oldest admitted waiter without new permit/deadline                                                                                                                      | REQUIRED Core internal sub-lane accounting bound to actual Admission, not new public API or helper queue                                                                                                                  |
| Deadline and cancellation       | Enter actual proof, expire original 2,000 ms deadline or abort; return typed refusal/no effects; observe retired slot; inject late result, observe discard; only actual exit permits replacement                                                                                                                                | REQUIRED Core actual running-thread cancel/exit and original-deadline notification producer; default deadline and JobContext already exist                                                                                |
| Error/startup/exit not observed | Fail startup, worker error and repeated deadlines; hold exit acknowledgement beyond approved cleanup bound; assert active+retired<=K at each transition, NOTREADY, no replacement, no unbounded bytes                                                                                                                           | REQUIRED Core/Work runtime physical exit/reclamation evidence and readiness observation; timer/close notifications cannot supply it                                                                                       |
| Shutdown                        | With live, idle and retired slots and a waiter, initiate normal shutdown; cancel/drain, await physical exit of every thread, counts/bytes zero BEFORE pool end                                                                                                                                                                  | REQUIRED Work/Core shutdown ordering and physical thread/heap evidence; existing service relay stop does not prove CPU disposal                                                                                           |
| Fresh Access and retry          | Hold actual preparation beyond evidence TTL; revoke/suspend during hold; release; record mint T then prepare Access then authorize before receipt, denied replay returns no stored result; force native contention retry and observe fresh T/evidence without repeating immutable proof                                         | Existing `runCommand`/real Auth/Access producers; REQUIRED Core CPU barrier plus Accounts internal per-attempt trace and native contention schedule; never transport T/Access into job                                    |

## Cost rows

### Cold publication

- Touches: one owned wire buffer and parse; current distinct P_new proofs with actual A; all repeated byte passes
  and own input loops listed above; native current Auth/Access, published-row insert attempt and command effects.
- Bound: A <= proposed 16,384; wire <=4,259,840 and canonical release <=4,194,304 bytes; linear own loops and
  explicit key/source sorting, fixed passes and no repeated growing membership scans. Statements constant in
  unrelated history. These construction obligations are not a delivered full operation counter.
- Growth check: full current bundle plus 64/512/3,993 changed properties (4,096 total at the boundary), retaining
  actual safe proofs/byte measurements. Independently seed prior publications 1/8/64 with changed input fixed.
  The own-loop observations above cover the copied index loops; remaining Library/filter counters and native
  SQL capture on original Kernel, shared Auth and all library pools are REQUIRED.

### Warm same body

- Touches: this request's own parse, both canonical hashes and indexed same-DB/pool published-digest existence
  probe; finite initialized fixed proofs supply zero new checkpoints on exact hits. Publication needs no body cache.
- Bound: O(owned bytes plus key sorting), constant native statements/history; byte work is not zero. Current
  existence and validation-policy authority remain necessary even if a digest was seen in another pool.
- Growth check: warm same-body native publication at independent history 1/8/64, actual existence statement and
  proof counters. Cross-pool, composed-only and cold stored-body schedules use real authority boundaries. REQUIRED
  Semantic publication binding and all-pools capture; existing GET only covers functional runtime reads.

### Exact replay and new key

- Touches: current native authentication, fresh T, Access preparation/authorization and receipt lookup; new key
  additionally uses the existing-digest command/event path. Both canonical digest domains still bind owned input.
- Bound: constant native statements/history; same key adds zero effect; new key adds one receipt/event/write basis
  and no duplicate release. No prepared data bypasses current Access or reads a receipt early.
- Growth check: native current-Auth schedules at independent history 1/8/64, exact 201 replay and new-key 200,
  conflict 422 and revoked 403. First named test is executable; REQUIRED all-pools capture and per-attempt trace.

### Resource schedules

- Touches: original permits/CPU waiters, K fixed threads, retirement, transferred input, ingress pre-admission
  reservations, parent/result allocations and physical shutdown. Runtime-read cache has its separate bound above.
- Bound: active+retired<=K after EVERY transition, CPU waiters<=permits-K, original deadline; no replacement before
  observed physical exit, shutdown zero before pool closes. Process bytes follow the formula above, not a Bun heap cap.
- Growth check: matrix schedules, repeated deadline/abort/error/late-exit cycles, H0/c job-heap observations at the
  three changed-input scales, actual ingress reservations and physical cleanup. REQUIRED Core/Work instrumentation
  and Performance memory/cleanup approval. HTTP success or shape counters do not prove cleanup/concurrency.

Native SQL must use `growth-capture.ts` and `catalogStatementBound`/`withoutCatalogTexts` from `growth-cost.ts`,
including nested captures for separate databases and all pools. `openGrowthDatabase` currently constructs its
own instrumented pool and owns the state required by `capture`; it cannot be retrofitted by assigning a different
pool to `driver.fixtures.pool`. REQUIRED Performance/shared-fixture capture attachment to the existing Kernel
and shared Auth/DBOS library pools, preserving ownership. Catalogue statements use the shared classifier and
background statements remain outside request cost. Old permissive-Access growth tests at 1/4/16 are storage
evidence only; no native 1/8/64 real-Auth statement counts are claimed here.

## Adopted deterministic precedence and remaining owner boundaries

Cheap bounded checks retain existing 400 precedence: collection limits, canonical size/JSON and schema shape.
Then analyze distinct sources in sorted order. A defect reached before budget exhaustion retains its existing
diagnostic; the first reservation exceeding A_max returns 422 `definition_work_exceeded`. Preserve first code per
pointer, lexical error order and 64 cap for defects actually reached. Unsafe/unknown never becomes safe.
This changes the mixed malformed/over-work case from running every proof to a deterministic bounded prefix;
Root explicitly approved this HTTP amendment in the paired adoption. The
[Semantic publication section](README.md#definition-publish) remains the owning document link for its runtime
handoff; Definitions retains safety authority. This three-file SPEC does not change that README or runtime.
Do not silently reinterpret a late unsafe pattern as safe or claim all old malformed outcomes survive unchanged.

The mandatory owner closure supersedes the older weighted-work and publication-cache instructions. It also
separates the 4 MiB canonical release limit from the 4,259,840-byte raw transport limit and charges context
separately. Neither the historical floor fractions nor this document establish completed admission.

Still REQUIRED before execution: actual bounded ingress producer and raw/parse-once binding; aggregate in-analysis
checkpoint enforcement; deterministic own-loop counter evidence; real all-pools history capture; idle-host native
A=A_max/max-body margin; H0/c/transient allocation evidence; CPU barrier, cancellation, physical exit, readiness and
shutdown observations. No missing port is replaced by a success-shaped helper, guessed resource DTO or authority
receipt. This SPEC and its red HTTP acceptance do not claim physical reclamation, runtime readiness, main/root
gate or Goal completion. No new external research pair is requested.
