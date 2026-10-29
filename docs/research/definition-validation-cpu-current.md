# Definition publication: CPU work, immutable reuse and request progress

Research evidence, 2026-10-29. No implementation, deadline increase, publication approval or gate completion.
The inspected worktree baseline is `5dfa8a7b4efec80a940b8332774d88bb093c2eec`.
Retry inspection confirmed unchanged Definitions, publication, HTTP, request and command sources against that
baseline; the retained probes below were inspected, not rerun as new measurements.

## Recommendation

Keep the 2,000 ms production request deadline. The smallest credible correction has three parts:
reuse finite, exact fixed-schema proof authority; reuse an actually validated immutable published body by its
canonical digest; and prepare genuinely new releases outside the request event loop before a fresh native command.
A Bun thread running the existing validator is the available execution candidate. It is not yet a proven native
solution: the exact-size cold probe below still exhausted a two-second worker lifetime. Offloading supplies
concurrent progress; it does not manufacture CPU capacity or establish native publication success.

First repair the demonstrated baseline incompatibility between the current real bundle and the structural checker.
Do not exempt its datatype or turn the checker's unknown result into safe. Then freeze the functional and
concurrency cases below before implementing optimizations. The semantic owner adopts validation/reuse decisions;
request, executor, Access and work owners approve their shared boundaries. No new service, durable queue, DBOS
launch, permission engine, schema format or larger work budget is recommended.

## Evidence and revision boundaries

The supplied MAIN absolute evidence files `failure.json`, `contract.md`, `approaches.json`, `diff.patch` and the
recorded session were read from the locations in the research brief, not from this worktree's `.temp`.
Their manifest identifies measured base `8ba7672a63e8fc4a66c9cd2169144968378b107e` and
head `2bb2f2626e19b7eca07fa41ffb6da44fd269667d`. Both have the same `src/index.ts` blob
`f5408a39c8009780583be35affc3890c22f46fb8`, importing browser `checkSync` directly with `{ timeout: 3000 }`.
Neither contains `src/pattern-safety.ts`. Thus the supplied measurements establish the earlier incident;
they are not measurements of the present deterministic structural policy.

The current `packages/definitions/src/pattern-safety.ts` blob is
`654caa91ae2d7fb3aad5bbbe869d12f78d431a66`, identical to the integrated structural revision
`cdf00171a34a0ce54dbb321f43ee35b8cab5c89e`. The complete Definitions README policy and MAIN's
[structural review](/home/edge/projects/rezics/rezics-next/.temp/goal/semantic/pattern-safety-integrated-review.md)
were read. The review records acceptance of an earlier integration; it does not establish compatibility of every
later release. No sibling investigation was read and no findings were coordinated.

The real current bundle has 103 properties, 140,822 compact/canonical UTF-8 bytes and digest
`sha256:eb8bc8b685e4f8e12897e0e9ac0ab978a8eff60102053081bd95ef4af0688702`.
`bundled.ts` reads checked-in JSON; importing it hashes the bundle but does not compile the catalogue.
The supplied separate fixture-deadline correction cannot establish production CPU or deadline correctness.
The inspected baseline's community driver still calls `createKernel`; this report does not claim that separate
fixture correction is present in this checkout.

### Supplied measurements

Re-extracting the twenty `release_own_work` records reproduces these nearest-rank percentiles:

| Operation | p50 ms | p95 ms |
| --- | ---: | ---: |
| Validation | 389.34 | 605.31 |
| Digest | 4.57 | 7.96 |
| Validation plus digest | 392.57 | 611.42 |
| Process CPU, including runtime threads | 573.91 | 815.61 |

Seven validation samples exceeded 500 ms. Twelve distinct real definitions-publish deadline records range from
2,469.17 to 15,462.09 ms. Deduplicate by request ID: session excerpts repeat some records. Their time mint,
Access preparation, gate, transaction, commit and contention phases are zero; `before_command` dominates.
For example, 15,462.09 ms total includes 15,417.83 ms before the command. This phase includes authentication,
parsing, admission, request hashing and validation; it is not a CPU-only timer for validation.

The actual patch starts monotonic timing around HTTP dispatch and switches phase on entry to `runCommand`.
Its nested phase wrapper restores the previous phase, counts contention pauses and logs once on deadline failure.
The isolated loop separately brackets `validateRelease` and `releaseDigest`, with `process.cpuUsage`.
Those are stronger attribution than inferring a lock stall from a stack frame. The prior eighty publications
were not repeated. Neither a quiet percentile nor moving a fixture to a generous kernel deadline proves that
other requests can progress during synchronous work.

## What the current code actually does

[Release validation](../../packages/definitions/src/index.ts) compiles the release JSON Schema once at module
initialization with `Compile(schema)`. Successful calls do not compile a schema per property. Validation performs:
collection limits; iterative byte counting; whole-release canonicalization; Library progress checks; the compiled
schema check; and semantic checks. Invalid schema input additionally constructs errors. Semantic checks include
references, relation metadata, facets, sorted lists, fixed value-schema equality, patterns, Library profiles,
Contexts and saved filters. Results retain first code per pointer, lexical order and the 64-pointer cap.

Each property reconstructs `valueSchema(datatype, options)` and canonicalizes both that expected object and the
submitted `value`. There are `1 + 2P` canonicalizations during successful shape validation, plus another full
canonicalization for the release digest. HTTP also canonicalizes its request envelope for the receipt digest.
The two digests have different meanings; substituting one for the other would break idempotency.

The per-validation `Map<string, boolean>` already proves each distinct pattern only once, including patterns
inside generated value schemas. The compiler has its own local pattern map, then calls `validateRelease` on
its result: the same user pattern can therefore be analyzed once in each phase. That duplication affects catalogue
compilation, not native publish of already compiled JSON. [Value validation](../../packages/definitions/src/validate.ts)
has a module-level authored-document validator and a `WeakMap<Release, Map<propertyId, validator>>` for Snaks.
That is separate lazy read/write content validation, not redundant compilation inside `validateRelease`.

[Pattern safety](../../packages/definitions/src/pattern-safety.ts) compiles the checker VM and fixed wrapper once.
Each proof still constructs `RegExp`, admits structure, parses and analyzes with recheck. Source length 256,
group depth 16, repeat endpoint 64, endpoint sum/expanded units 128, graph transitions 1,024 and 8,192 private
native cancellation checkpoints remain authoritative. Nested expansion multiplies. Backreferences, named groups,
Unicode properties, lookbehind and larger lookahead are refused. `auto` retains graph limits; the logger refuses
fallback before fuzz seeding. Recall execution is disabled. Only safe automaton verdicts pass.

The [pinned upstream source](https://github.com/makenowjust-labs/recheck/tree/b40bd4d39217e54c94d2de5ed6ec521540fcffd6)
confirms why explicit `automaton` is unsuitable: `ReDoS.scala:68` sets its graph limit to `Int.MaxValue`.
`Context.scala` creates a fresh context per check; its interrupt checkpoints test the deadline/cancellation.
The private VM counter makes verdicts independent of host elapsed time. Finite checkpoints are not milliseconds,
and per-expression bounds are not an aggregate release CPU or heap guarantee.

### New controlled operation probes

Only disposable files under this worktree's `.temp/definition-validation/` were created. No server, database,
external clone code or production resources ran. A copied `index.ts` redirects relative imports to the actual
package and wraps canonicalization, size, schema, semantics and `analyzePattern`; the checker/dependencies remain
unchanged. Timing overhead is included. Module initialization precedes per-call timers; zero compile calls means
zero during validation, not zero during import. Probes record raw JSON, process CPU, heap/RSS deltas and a timer
queued immediately before the synchronous call. That timer cannot run until validation/digest return.

Initial operation probes used PATH Bun 1.4.3, revision `c6da4a4d3010e5553438c60f6bd76d981976867c`.
The repository-pinned executable is Bun 1.4.4, revision `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`, Linux x64.
Pinned bundle, large-pair and worker probes ran concurrently with each other; do not compare their wall times
as isolated performance percentiles. The final exact-4-MiB cold probe ran separately in a fresh pinned process.
These are operation experiments, not native HTTP acceptance or benchmark success claims.

| Pinned probe, in call order within each process | Validation ms | Proof calls / checkpoints | Proof ms | Canonical calls |
| --- | ---: | ---: | ---: | ---: |
| Bundle, first proof use | 1,043.34 | 15 / 14,474 | 1,003.71 | 207 |
| Same bundle, warm VM/JIT, new local cache | 705.24 | 15 / 14,474 | 681.83 | 207 |
| 128 properties, shared literal pattern | 6.12 | 1 / 11 | 1.93 | 257 |
| 128 properties, distinct literal patterns | 107.88 | 128 / 1,408 | 101.32 | 257 |
| 4,096 properties, shared literal pattern | 241.95 | 1 / 11 | 67.12 | 8,193 |
| 4,096 properties, distinct literal patterns | 1,801.13 | 4,096 / 45,056 | 1,618.84 | 8,193 |
| Exact 4 MiB, 4,096 distinct patterns, cold | 1,858.07 | 4,096 / 45,056 | 1,660.51 | 8,193 |

All synthetic rows above have zero violations and zero per-call schema compilations. The 4,096 pair has
3,920,207 bytes. Patterns are `^x0000$` through `^x4095$`; the shared case uses only `^x0000$`.
Each property is an ordinary non-multivalued string with empty qualifiers/mappings and the exact generated value
schema. Four valid locale labels contain 180 ASCII characters each. The exact-limit case fills the remaining
274,097 bytes with valid English descriptions, at most 1,500 characters each; its canonical size is 4,194,304.
It has one type with empty bases/properties/facets, valid `ex` IRIs, and no unrelated database population.
The literal fixtures deliberately do not approximate the most expensive admitted automata.

The final cold row's raw values are: size 20.156612 ms, schema 21.458848 ms, semantics 1,767.557677 ms,
validation canonicalization 86.133113 ms (overlaps semantics), validation-plus-digest 1,915.018515 ms,
process CPU 3,543.115 ms, RSS delta 122,425,344 bytes, heap-used delta 18,888,661 bytes.
Digest: `sha256:363f1b5729262d4d6b4dd3405d7dd2bdfe007428b2103f2c5a935c3c8ec990bc`.
These are deltas, not peak or per-worker memory limits; process CPU includes JSC/GC threads.
A native request would also pay parsing, receipt hashing, admission, Access and command/commit costs.
The 84.98 ms left in this isolated computation does not prove they fit. Every synchronous row blocked the timer.

The expensive fixed generated patterns in the first pinned bundle were time (6,222 checkpoints, 338.95 ms),
monolingual language (4,206, 288.73 ms), URL (1,651, 220.84 ms), and decimal (857, 51.41 ms).
This identifies proof work, rather than property-validator compilation, as the dominant cost here.

Raw captures and scripts are `profile{,-pinned,-large,-valid-large,-valid-large-pinned,-exact-max}.jsonl` and
their generating `.ts` scripts, plus `native-confirm.jsonl`, `worker-probe.jsonl`, `worker-probe-pinned.jsonl` and
`worker-max-probe.jsonl` under the temporary directory. Earlier 400/700-character label experiments were invalid and stopped at schema errors; they are excluded
from the valid scale evidence. The exact-limit raw capture SHA-256 is
`1a7252bbaea656db9e0b011e48a9864b62c63da649878536d8c62eff65116bdf`.

### A baseline correctness defect, not an optimization result

The actual bundle returns `unsafe_pattern` at `/properties/wdt:P1114/value/properties/unit/pattern`.
An unmodified direct `validateRelease(bundledRelease)` confirms the copied-index result; the pinned Bun thread
also confirms it. In a disposable diagnostic copy of the wrapper, the exact generated wildcard-unit pattern
logs `fuzz: start (usesAcceleration: true)` after parsing, so the existing diagnostic guard throws at 163 checkpoints.
It does not exhaust 8,192 checkpoints. It must continue to be refused while its proof remains inconclusive.

The generated pattern is the current `valueSchema('quantity', { units: ['*'] })` output, not injected invalid data.
The existing structural tests use `units: ['1']` for generated quantity cases; this misses the wildcard branch.
`exact-quantity.test.ts` also pins an older bundle digest. Preserve its historical meaning; add current-bundle and
ordinary/exact wildcard cases rather than weakening any existing test or changing schema bytes to conceal this.
A finite preproved table must not label this unknown proof safe. Restoring the claimed generated-schema coverage
requires a separate correctness fix using an approved bounded proof under the unchanged policy.

## Reuse choices and their limits

1. **Fixed authority:** retain the already compiled release-schema validator. Privately precompute immutable
   canonical expected shapes and positive proofs for the finite exact generated patterns that actually pass the
   same policy. Key by exact source, `u` flags, checker artifact hash and structural-policy version. Tie lifetime to
   module/worker code, never caller identity. Verify submitted value-schema equality before using an exact proof.
   Keep arbitrary user patterns on the existing analysis path. Failed/unknown proofs never become positive authority.
   Do not return shared mutable schemas from the public `valueSchema` factory.
2. **Generated variations:** quantity units, integer/decimal and exact/ordinary presence all affect equality;
   monolingual user patterns differ from its fixed language field. Arbitrary units and user sources are not a finite
   global catalogue. Use release-local expected-shape memoization keyed by the full datatype/options tuple, including
   ordered units and exactness, or the existing release-identity WeakMap for retained immutable releases. Preserve
   required-array ordering and unknown-field rejection, not merely JSON Schema semantic equivalence.
3. **Compiler-to-validator sharing:** a private per-compilation proof context could avoid proving a user pattern
   twice, with no cross-call retention. It must not become a public `skipSafety` or caller-supplied boolean port.
   This improves compilation but is not the first correction to the HTTP publish incident.
4. **Arbitrary cross-call proof LRU:** not currently permitted. If separately adopted, its key must include exact
   string/flags, artifact and policy version; cap both entries and retained bytes; drop all entries on version change;
   store deterministic outcomes only. Hostile churn must still cost one bounded analysis per miss, never an unlimited
   pending map, retained promise or pinned entry. Capacity, eviction and whether this policy change is allowed require
   explicit semantic-owner decisions. It supplies no worst-case improvement for 4,096 distinct new patterns.

With input bytes B, P properties and D distinct patterns, the existing cost is approximately byte/schema/reference
traversals plus key sorting, P exact shape comparisons and the sum of D native analyses. Property count alone is
insufficient: 4,096 user patterns can account for 33,554,432 checkpoint allowances, in addition to shared generated
patterns. This is a bound on counted checks, not allocations between them. A local map is already proportional to
one bounded release. Persisting untrusted proofs process-wide would change both memory and admission policy.

### Published-release preparation without an authorization shortcut

[Publication](../../services/kernel/src/semantic/definitions.ts) currently validates synchronously before any
`runCommand` checkout, including replay, then hashes. It does not seed `releases` after publish.
`readRelease` does have actual validated, digest-checked, recursively frozen bodies, and verifies an exact published
row still exists on a cache hit. `composedRelease` is a different authority and must not satisfy published reuse.
The SQL publication insert is immutable `ON CONFLICT DO NOTHING`; a new key on an existing digest returns created
false but still takes the ordinary command/event path. Same-key replay returns the original response/component.

A minimal preparation port should produce a private immutable snapshot, canonical bytes/digest, and either an exact
validated published body or a completed fresh validation. Do this before `runCommand`, without holding Global's gate
or a command transaction. After successful native commit, its validated snapshot may seed existing release reuse.
Scope existence to the actual pool/Global published row; do not trust a bare process map across databases or use
extension/composed entries. A cold-process stored row is not already a current in-memory validation certificate:
validate it once off-thread unless the owner explicitly establishes durable historical validation authority.
Merely selecting a digest, a control query, imported module or `typeof` result is no such proof.
The existing process map has no eviction. Automatically seeding it on every publish would broaden retention:
adopt explicit per-pool entry and byte caps before doing so, retain only committed immutable certificates, and
evict without changing validity. A miss repeats fresh preparation; hostile digest churn must not retain pending
jobs or grow a negative cache. The semantic owner must choose those caps and pool-disposal lifetime.

Before hashing, enforce an iterative bounded JSON/UTF-8/collection guard on the snapshot. It must reject malformed
Unicode in values and keys, non-finite numbers, cycles, BigInt, undefined/functions/symbols and exotic serialization
hooks; arrays must be dense ordinary JSON arrays. Count actual escaped canonical UTF-8 bytes, not JS length or a
Content-Length header. Use an ancestor set for cycles and stop before schema/proof work at the existing size bound.
Avoid invoking getters or `toJSON` while copying; wire JSON already excludes these. The current `exceedsSize` is not
this reusable proof: it enumerates objects, has no cycle tracking and can undercount sparse arrays.
Canonicalize 5.1.0 itself supports `toJSON`, boxed values and dropping undefined members, so hash equality alone
would admit object/hash confusion. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) specifies canonical JSON,
not an authorization rule or a validator for arbitrary JavaScript objects.

Compute a digest only for guarded owned data; do not freeze/mutate the caller's object or memoize its mutable
identity. After awaits, use only that snapshot and actual immutable cached data. Equal canonical digest reuses the
existing SHA-256 collision-resistance assumption, including canonical key order and number representation; it does
not authorize bodies containing extra non-JSON members that disappear during serialization. If cached authority is
absent, run all schema/semantic/pattern checks. Invalid new releases have no exemption. Preserve existing parsed-JSON
error precedence, pointers, ordering and caps when separating guards; internal exotic-input diagnostics need explicit
coverage rather than assuming the existing size traversal is a total JSON validator.
Preserve collection-limit precedence before size, then canonical-JSON rejection before schema errors; do not
replace an existing set of collection pointers with a generic guard error. A bounded iterative guard can count
well-formed strings and escaped UTF-8 bytes in O(input bytes), without sorting keys or running any proof. It
must stop at the byte cap rather than first materializing an oversized canonical string. Retain the current
root `invalid` diagnostic for malformed Unicode/non-finite input, mapped to `/release` and `invalid_format` by HTTP.

The receipt digest remains `requestDigest('definitions.publish', actor, { params: {}, body })`, including the
client/requested-by envelope. Guarding only inside `publishRelease` is too late to protect this earlier HTTP hash.
Retain the same request digest bytes while arranging snapshot/guard preparation ahead of both hashes.
One candidate keeps the owned snapshot in the worker while returning only both digests after the guard. The
parent checks actual published authority; on a miss, the same bounded job resumes full validation, then returns
its validated body. On a hit, publication uses the certified cached body. This avoids clone-back before a hit
and duplicate parsing/proof work on a miss, but adds a message round trip and retained job bytes. Charge both
to the original deadline and capacity; this protocol needs native tests and is not demonstrated by the probes.

Every path still executes native `authorization.prepare` and final `authorize` **before receipt lookup**.
A published cache hit is data evidence only; it never grants permission, returns existence information to a denied
caller, or supplies a permission cache. Preserve anonymous 401, denied 403, malformed 400, conflict 422, immutable
201/200 replay behavior, session component, one same-key effect and typed 503 behavior. Internal existence/body reads
must not create a new public oracle. Do not change invalid-input precedence simply to authorize first.

[Command authorization](../../services/kernel/src/request/access.ts) prepares fresh admission/evidence on each
attempt, binds it to native authoritative T, pool, actor and fixed request deadline, then authorizes in the command
transaction. Access evidence has a one-second real TTL. CPU preparation must finish before that fresh attempt;
a pre-await allow decision cannot survive worker execution. Recheck native identity, scopes, suspension/fence,
resource permission and evidence freshness after preparation. Never copy T, Access capability or pool into a worker.

## Execution and cancellation boundary

Yielding between properties reduces aggregate blocking but still blocks for one entire native proof: hundreds of
milliseconds for fixed patterns above. `await Promise.resolve()` alone does not yield to I/O. The public checker
has no resumable analysis API; rewriting its internals is a larger change. Finite immutable reuse can remove
repeated fixed costs, but cannot make fresh distinct proofs disappear. Retaining this atomic checker therefore
needs off-thread execution for a strong concurrent-request-progress guarantee.

The pinned browser `check` export is not a drop-in solution: `packages/recheck/src/browser.ts` uses a one-worker
pool; `lib/worker-pool.ts` keeps an unbounded waiting array and forwards logger messages asynchronously. It does
not carry our private VM counter or synchronous fallback guard. Use Bun to run the existing whole preparation
operation with its unchanged checker policy, not this separate per-pattern pool.

[Bun Workers documentation](https://bun.sh/docs/runtime/workers) describes a separate JS thread, structured-clone
messages, termination and lifetime controls; it warns that termination remains experimental. The inspected Bun
`src/js/node/worker_threads.ts` wraps native WebWorker; `terminate()` returns a promise resolved through close.
Documentation distinguishes close notification from full exit. These APIs require runtime evidence, not import tests.

Disposable `node:worker_threads` probes executed actual validation/digest. On pinned Bun, bundle worker startup
was 249.02 ms, parent post 1.74 ms, validation 1,119.51 ms, digest 5.53 ms, total including shutdown 1,498.63 ms;
RSS delta was 86,142,976 bytes. A parent interval observed shared state marking active CPU work before completion.
An actual tight-loop worker was terminated; its shared heartbeat stayed unchanged across a subsequent 10 ms
observation. This proves limited native capability, not a portable cancellation-latency guarantee or successful
native publication (the bundle was refused as above).

The separate exact-4-MiB worker probe started in 159.91 ms; nested-object post took 23.58 ms. Parent progress
continued, but the original 2,000 ms watchdog fired before a result. Exit/shutdown observation completed at
2,067.34 ms, RSS delta 157,945,856 bytes. That watchdog models a deadline experiment, not HTTP error mapping.
There is no demonstrated two-second native success for this cold payload. A timer race without terminating work
would be incorrect. The experiments do not prove hard heap caps or interruption of every VM/native allocation.

A proposed port must use the existing request admission backlog, not introduce another application queue.
Admission currently has eight normal permits, two reserved permits and 32 waiters; active work is not automatically
cancelled by its wrapper. Owner-approved CPU slots must be finite and separately account for live/terminating
threads, payload bytes and initialized VM memory. Refuse unavailable capacity through existing typed overload;
never enqueue unbounded jobs behind a thread pool or consume reserved authentication capacity for CPU preparation.
Warm fixed workers reduce startup but retain memory; one-shot workers simplify failed-job isolation but pay startup
and lose warm proof/JIT state. Start with the smallest approved slot count; choose retention from measured cold
success and memory, not the request-permit count or CPU-core count alone.

Propagate the original deadline and abort signal, including admission wait, startup, clone, guard, canonicalization,
validation, response clone and commit. Drop cancelled waiters; signal/terminate active work; discard late results
by job identity and version; release bytes/listeners only once; quarantine failed workers until actual cleanup.
Do not replace a terminating thread early and exceed the bound. A cooperative shared cancellation flag at bounded
work boundaries can complement termination, but must not convert cancellation into safe or alter checkpoint policy.
Choose and prove shutdown/cleanup bounds on pinned Bun before adoption. If not achievable, retain typed refusal;
this report does not invent a capability. Transfer raw bytes or send an immutable string instead of a nested object
only if parse/UTF-8/digest costs and exact canonical bytes are proved; SHA-256 is still linear work.

## Acceptance to freeze before implementation

The research acceptance is a non-empty report; these are implementation scenarios to add, not claims of delivered
tests. Extend native Definitions API coverage with existing real Auth/Access, bundled data and the current
`authoritativeRelease` fixture semantics. Existing `definitions.test.ts`, `exact-quantity-schema.test.ts`,
`outcome-driver.ts`, pattern-safety and Library-profile tests provide starting boundaries; growth tests with
`authorize: async () => true` cannot prove native replay authorization. Do not replace them as functional evidence.

- Freeze current bundle/digest and every generated wildcard/explicit-unit, integer/decimal, exact/ordinary variant;
  retain historical pins, ordinary schema bytes, Library profiles, limits, malicious patterns and all error snapshots.
- Count native proof entries and schema compilations on cold/new, duplicate-pattern, identical published and same-key
  replay cases. Assert one proof per distinct new pattern, no per-property release-schema compilation, zero fresh
  proofs for an actually certified published hit, and no growth with unrelated release history. Include 1/128/4,096
  distinct sources and hostile churn; inspect retained bytes/entries and live worker counts, not just elapsed time.
- Submit reordered equivalent JSON, mutable direct-call objects, mutation after preparation, malformed Unicode keys
  and values, sparse arrays, cycles, non-finite/non-JSON values and exact/over-limit bytes. No hash or cache lookup
  precedes guard success; valid bytes/digests and existing wire diagnostics remain identical.
- Pause real preparation before completion using a private test barrier around the real worker. Complete an unrelated
  native read and reserved authentication request before releasing it; assert no Global command checkout yet. Also
  observe parent progress while the actual checker computes, using worker entry/completion counters. A parked-worker
  barrier alone does not prove real CPU offload. Use a generous harness watchdog only to detect deadlock, not as the
  production request deadline or a sub-500-ms performance assertion.
- Pause preparation, revoke the caller's grant or suspend/fence the account through native commands, then release.
  Assert 403/no receipt disclosure/no effect, including a previously successful same-key replay. Repeat with JWT
  expiry and Access-evidence expiry; stale evidence yields the native denial/unavailability, never an allow stub.
- Race two permitted identical same-key HTTP requests: original response/status/component, one receipt/outbox effect;
  race different keys for the same digest: one immutable row and existing created/event semantics. Reuse a key with
  a different request digest: authorized 422; denied caller never learns a conflict or stored result.
- With the real production 2,000 ms setting, hold preparation until expiry, then release. Await the real deadline
  notification rather than sleeping for a fragile duration; assert typed refusal, zero command effect, cancelled
  work and no late cache publication. Inject worker error/start failure and cancellation at each ownership transfer;
  assert no leaked slots, listeners, byte reservations or replacement-thread oversubscription.
- Force a native command contention retry after preparation. Assert a fresh T/admission/Access attempt under the same
  original deadline, original receipt authorization order and no second fresh CPU preparation of immutable data.
- Separately record honest phase costs for successful cold new and published/replay HTTP calls with native Auth on
  the unchanged production deadline. Include exact-limit/distinct-pattern cases and concurrent requests. Count refused
  calls and report cold/warm/order/cache, CPU, startup/clone, request/receipt hashes, admission and commit. A deterministic
  schedule proves semantics/progress; measured deployment evidence must additionally establish the production result.

## Adoption boundaries and provenance

Adopt a semantic validation/reuse contract first: exact finite proof table, current bundle compatibility repair,
owned JSON snapshot/error ordering, actual published authority and cache lifetime/version. Request and executor
owners then specify the preparation lifecycle, shared admission capacity, cancellation/refusal and immutable
receipt inputs; Access owns freshness across the added await; work owns process/worker lifecycle integration.
Only after these contracts and missing native scenarios are frozen should an implementation port be dispatched.
This report recommends these boundaries; it does not deliver that port or declare any native API/default/main gate complete.

Local dependency sources read: `recheck@4.5.0/lib/browser.js` and `index.d.ts` (MIT),
`typebox@1.4.3/build/schema/compile.mjs` (MIT), and `canonicalize@5.1.0/lib/canonicalize.js` (Apache-2.0),
inside the worktree's pinned `node_modules/.bun/` directories. Browser artifact SHA-256:
`fd332e833abd002c9fc9e0b9d7a5282bbb33b0b5e81b06e7ff67c32bedca2fce`.
Canonicalize artifact SHA-256: `c1d0195af2a0748454b06af8f218e5c90415c19d39154d0058fee8229c12d859`.
TypeBox schema-compile artifact SHA-256: `7e20d962689705477b5ff6ca161dfbc3c6696b4796b54436d2d6d132179b7885`.
Their upstreams are [recheck](https://github.com/makenowjust-labs/recheck),
[TypeBox](https://github.com/sinclairzx81/typebox) and [canonicalize](https://github.com/erdtman/canonicalize).

Reference source was read only, never installed, built or executed: MAIN `.reference/definition-validation-cpu/recheck`
is the shallow `v4.5.0` clone at `b40bd4d39217e54c94d2de5ed6ec521540fcffd6`, MIT (`LICENSE`);
files are `modules/recheck-core/shared/src/main/scala/codes/quine/labs/recheck/ReDoS.scala`,
`modules/recheck-common/shared/src/main/scala/codes/quine/labs/recheck/common/Context.scala`,
and `packages/recheck/src/{browser.ts,lib/worker-pool.ts,lib/pure.ts}`.
The reused [Bun source](https://github.com/oven-sh/bun/tree/c643ea8c2a9da88cae7e3508d2dd95c8f5857926)
is MAIN `.reference/search-worker-outcome-harness/bun`, commit
`c643ea8c2a9da88cae7e3508d2dd95c8f5857926`, MIT plus dependency licences (`LICENSE.md`);
files are `src/js/node/worker_threads.ts` and `docs/runtime/workers.mdx`. This source revision is not asserted to be
the installed canary revision. Both reference provenance lines were added to MAIN `.reference/INDEX.md`.
Official Bun documentation and RFC 8785 were accessed on 2026-10-29; the RFC is under the IETF Trust terms linked
from its publication. Shared patterns in these sources are immutable compiled authority, explicit per-job lifetimes
and cancellation distinct from proof. None provides authorization caching or a guaranteed aggregate CPU deadline.
