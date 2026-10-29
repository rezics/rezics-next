# Definition publication CPU and concurrent progress

Research snapshot: 2026-10-29, repository revision `5dfa8a7b4efec80a940b8332774d88bb093c2eec`.
This is independent evidence for an owner decision, not an adopted contract or delivered execution port.

The smallest useful correction has three parts: reuse finite generated-schema authority; reuse the actual
immutable published release after guarded canonical hashing; prepare cold releases outside the command and,
with the present indivisible checker, outside the request event loop. None alone proves success within the
unchanged 2,000 ms production deadline. Local measurements also expose a pre-existing bundled-release refusal
that needs a real regression test before implementation; caching must not turn that refusal into safety.

## Measured history and source identity

Read the actual Accounts `failure.json`, `contract.md`, `approaches.json`, phase-capture `diff.patch`, and raw
run output from their supplied absolute main-checkout paths, plus the integrated structural-checker review.
The failure artifact SHA-256 starts `264f75ae22c20b10`, the diff `1a3bb8f5ff923f53`, and review
`1be3818fc6a26a61`; these identify the evidence without embedding dispatch identifiers here.

The measured base was `8ba7672a63e8fc4a66c9cd2169144968378b107e`, head
`2bb2f2626e19b7eca07fa41ffb6da44fd269667d`. Both have identical definitions `index.ts` blob
`f5408a39c8009780583be35affc3890c22f46fb8`: inline browser `checkSync(pattern, 'u', { timeout: 3000 })`.
Neither contains `pattern-safety.ts`. The investigated worktree instead has index blob
`a25838bee6bd178da18c07fa34122b52e2bedded` and checker blob
`654caa91ae2d7fb3aad5bbbe869d12f78d431a66`, the latter identical at integrated revision
`cdf00171a34a0ce54dbb321f43ee35b8cab5c89e`. Historical timings cannot become current-counter timings.

The supplied twenty quiet isolated samples give validation-plus-digest p50 392.6 ms/p95 611.4 ms,
validation p95 605.3 ms, and seven combined samples above 500 ms. Digest p95 was 8.0 ms. Twelve actual
HTTP 503s took 2,469–15,462 ms, overwhelmingly before `runCommand`, with zero gate/transaction/contention.
The capture separately timed validation and digest before fixture creation, then used command-phase
instrumentation for HTTP. `before_command` also includes authentication, parsing and admission; it does not
attribute every millisecond to regex analysis. No unchanged eighty-publication benchmark was repeated.
The separate generous test-kernel fixture changes neither production's deadline nor synchronous stalls.

## Actual work, including work already shared

[`index.ts`](../../packages/definitions/src/index.ts) executes `Compile(schema)` once at module load.
TypeBox's pinned `Validator` constructor builds/evaluates code once; `Check` reuses it, while `Errors` invokes
error traversal separately. There is no release-schema compilation per property to remove.

`validateRelease` checks collection limits, estimates JSON UTF-8 bytes before full canonicalization, checks
library progress semantics and the compiled release shape, then semantic references/value schemas. Every
property reconstructs `valueSchema(datatype, options)` and compares canonical actual/expected schemas.
Patterns in those schemas are walked separately. A call-local map keyed by exact pattern source deduplicates
both true and false verdicts; subsequent validations repeat the proofs. Each property still pays schema
serialization/traversal when patterns repeat. Errors keep the first code per pointer, sort pointers lexically
and cap at 64; collection violations return before later phases. Preserve that precedence.

[`compile.ts`](../../packages/definitions/src/compile.ts) has a separate local pattern map in `slotProfile`
and ends by calling `validateRelease`. Compiler-then-validator proof duplication exists, but native JSON
publication does not invoke this compiler. [`validate.ts`](../../packages/definitions/src/validate.ts) already
has one compiled authored-document validator and a WeakMap of release identity to lazy property validators;
those content-validation caches are not publication's hotspot or proof of arbitrary input immutability.

The complete [root policy](../../packages/definitions/README.md) and
[`pattern-safety.ts`](../../packages/definitions/src/pattern-safety.ts) bound source length 256, nesting 16,
repeat endpoints 64, repeat sum/expanded units 128, NFA transitions 1,024 and analysis checkpoints 8,192.
Backreferences, named groups, Unicode properties, lookbehind and nontrivial lookahead are refused. The pinned
browser build runs in a private `node:vm` realm whose `performance.now` advances the counter. Host clocks
are untouched. Only an automaton `safe` verdict succeeds; errors, unknowns, counter exhaustion, structural
fallback and fuzz entry fail closed. The realm's 3,000 timeout value scales the counter; it is not a request
latency allowance. A checkpoint bound is neither a machine-instruction count nor a worker cancellation API.

Pinned recheck creates a fresh, non-reusable analysis context per `checkSync`. `checker: 'auto'` enforces its
size limits but can fall back to fuzz; the repository logger refuses that entry before seeding. Explicit
`automaton` mode bypasses relevant limits and is not equivalent. Browser `check` lazily creates its own
one-worker pool; `checkSync` uses the pure implementation. Substituting that async API loses the private
counter authority and introduces another scheduler. Pure-library async wrapping does not make CPU yield.

## New controlled phase evidence

All probes are in this worktree's [temporary evidence directory](../../.temp/definition-validation-cpu-deep/).
`phases.ts`, `index-probe.ts`, `phases.jsonl` and empty `phases.stderr` retain code/counts/raw output. The copied
index wraps phase calls but invokes the actual unmodified `analyzePattern`, including its private counter.
`diagnostic.ts`/`pattern-diagnostic.ts` expose the refused logger stage; `diagnostic.jsonl` records it. No
installed dependency, product clock or runtime source was edited.

Initial environment: Linux x64, Bun 1.4.3 revision `c6da4a4d3010e5553438c60f6bd76d981976867c`, recheck
4.5.0, TypeBox 1.4.3, canonicalize 5.1.0. Actual module import took 132.6 ms; the second instrumented module
compiled its release validator once, in 4.1 ms. A separate native baseline/worker probe below uses the actual
repository-pinned Bun canary, reporting 1.4.4 revision `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`.
All observations are local exploration, not check-host/native HTTP acceptance or a latency distribution.

The tracked bundle has 24 types, 103 properties and 140,822 canonical UTF-8 bytes; digest
`sha256:eb8bc8b685e4f8e12897e0e9ac0ab978a8eff60102053081bd95ef4af0688702`.
Order: instrumented bundle first, same bundle again, unmodified original validator, then increasing distinct
patterns. There was no cross-call proof cache. Times below are single observations in milliseconds.

| Input | Validation | Digest | Distinct proofs/checkpoints | Proof time | Parent timer delay |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bundle, first instrumented call | 1,217.3 | 7.5 | 15 / 14,474 | 1,186.5 | 1,225.1 |
| Bundle, repeated instrumented call | 789.1 | 22.3 | 15 / 14,474 | 766.2 | 811.4 |
| Bundle, unmodified original | 777.7 | 3.4 | not instrumented | not instrumented | 783.9 |
| 64 distinct properties | 89.4 | 1.4 | 64 / 1,088 | 85.2 | 90.8 |
| 512 distinct properties | 415.8 | 9.6 | 512 / 8,704 | 383.4 | 425.4 |
| 4,096 distinct properties | 1,997.4 | 68.0 | 4,096 / 69,632 | 1,743.4 | 2,075.1 |

Fixtures use actual `valueSchema('string', {pattern})`, one type referencing at most 64 properties, and
`^codeNNNN-[A-Z]{1,8}$` distinct patterns: no violations, exactly 17 checkpoints/proof. The largest is
3,777,541 bytes, below 4 MiB. Its schema check took 31.6 ms, size walk 39.4 ms, and 4,096 `valueSchema`
calls 2.3 ms. Its 8,194 canonicalizations, including digest, took 170.8 ms; phase totals overlap because
semantics includes nested operations. Proof dominates; template construction alone is not the explanation.
A timer scheduled before synchronous validation never fired before return.

Bundle first-call proofs included time 6,222 checkpoints/392.1 ms, language 4,206/266.3 ms and URL
1,651/325.9 ms. Warm execution did precisely the same proof work. JIT/order effects matter. Largest-fixture
process RSS rose from 197.7 to 244.6 MB, heap from 32.9 to 35.6 MB. Process CPU was 4,609.7 ms, including
JIT/GC and runtime threads; this is not single-thread CPU or isolated peak memory. One user pattern/property
can permit 4,096 × 8,192 = 33,554,432 checkpoints, plus fixed patterns. Finite per-pattern work establishes
neither small aggregate cost, an event-loop scheduling bound, nor success before 2,000 ms.

**Actual bundle refusal:** all three current bundle calls returned exactly
`/properties/wdt:P1114/value/properties/unit/pattern` with `unsafe_pattern`. The generated wildcard quantity
unit pattern was refused at 163 checkpoints. The diagnostic copy recorded
`fuzz: start (usesAcceleration: true)`; the original unmodified validator independently returned the same
violation. `pinned-baseline.ts`/`pinned-baseline.jsonl` independently confirm the same original-validator
refusal/digest on the pinned canary: import 178.2 ms, validation 1,248.5 ms, digest 3.7 ms, parent timer
1,254.2 ms. The integrated review's shipped-pattern expectation therefore fails on both measured runtimes.
Freeze this exact baseline finding before implementation; do not exempt the bundle because it is a datatype
field, previously stored, or useful to a benchmark. A body without
actual validation authority cannot seed a new validated cache. This is a base finding, not this report's
change. Computing the real digest is not native publication success.

## Finite reuse and hostile cache churn

Use a finite module-owned table for exact generated patterns/templates, with source-controlled membership.
Initialize/check it through the existing deterministic authority, retaining failures as failures. Bind each
entry to exact source bytes, `u` flags, checker build and structural-policy revision. Module/deployment reload
replaces the table; each worker owns its private checker/table. Reusing a proven fixed language, time, UUID
or decimal literal is valid even in a user field. A datatype tag grants no exemption: compare the entire
actual schema to the expected schema, then apply exact-pattern proof reuse.

Cache fixed expected canonical schemas once. Variable schemas can share within one owned preparation: key
by datatype and every affecting option, including exactness, integerness, ordered units and exact pattern
bytes. Never omit usually-default options. Ordinary quantity lower/upper bound schemas remain unchanged;
remove both only for exact quantity. Preserve wildcard/unit/integer semantics, monolingual/document language,
media suffix and library progress/profile rules. Canonical comparison preserves array order/historical pins;
an equivalent-looking schema is not automatically accepted. A mutable `bundledRelease` export is not authority.

A finite initialized table moves measured work to readiness, not out of existence. Charge initialization and
worker startup when they occur after request entry. A cold release on a ready process differs from a cold
process/worker; measure both. The wildcard proof stays false until a separately justified generator/checker
repair passes unchanged policy and exact-schema-byte tests. Successful precomputed certificates would need
an explicit proof/version contract, not an unexplained allowlist.

Sharing the compiler map with its final validation can avoid duplicate work if both use exactly the same
policy; it does not accelerate native JSON publication. An arbitrary cross-call user-proof cache requires an
explicit owner decision. If adopted, key by full policy/checker version, flags and exact source, cap entries
and retained bytes, and use bounded eviction. Store only completed deterministic verdicts; never make an
unknown/timeout/cancellation safe. Fresh-pattern churn must yield bounded occupancy and ordinary misses,
not increased authority or permanent negative-cache denial. This cannot promise cold success or progress.
Do not globally retain untrusted generated-unit variants, arbitrary JSON identities or pending promises.

## Reusing an actual immutable published body

Current [`publishRelease`](../../services/kernel/src/semantic/definitions.ts) validates synchronously before
`runCommand`, including matching receipts, then canonicalizes again for its digest. The
[HTTP route](../../services/kernel/src/semantic/http/definitions.ts) computes the canonical request-envelope
hash before that release-size guard. Both hashes need guarded input, not just a fast published lookup.
Canonicalize once per owned release and reuse those bytes for the same SHA-256. The envelope digest must
retain exactly the current operation/client/requested-by/body encoding; the receipt separately keys the actor.

Before either hash, use bounded iterative JSON/collection/UTF-8 size admission, stopping over 4 MiB of release
JSON, not adding a 4 MiB envelope rule. Count escaped strings/keys, separators and dense-array elements
exactly; canonical sorting does not change length. Check well-formed UTF-16 keys/values, finite numbers and
JSON-only nodes. Detect ancestor cycles without treating sibling aliases as cycles; avoid recursion or a new
depth limit. Current `exceedsSize` has no cycle set and uses `Object.entries`; it does not establish dense,
plain JSON. A cycle can consume repeated work until the byte limit instead of failing promptly as a cycle.

The pinned canonicalizer rejects cycles/non-finite numbers/lone surrogates but calls `toJSON`, unboxes
objects, omits undefined/function/symbol object fields and maps them to null in arrays. It is not a JSON
guard. The README's supported input is parsed JSON without cycles; the native TypeScript `unknown` accepts
broader values at its boundary. Parsed HTTP JSON cannot contain accessors/cycles/custom prototypes.
Cache eligibility must exclude getters, symbols, holes, special prototypes and serialization hooks without
invoking them. Non-JSON/unsupported values need bounded typed failure/fallback preserving error precedence,
not a sanitized hash followed by publication of an unsanitized object. Freeze malformed/limit examples first:
collection-first errors, root size errors, pointer escaping/order and 64 cap. Keep JSON/JCS `-0` as zero.
Characterize cyclic errors before replacing the walk: where it currently yields root `limit`, faster cycle
detection must not silently substitute `invalid`. Descriptor inspection cannot prove an arbitrary Proxy inert;
no such capability is claimed. Establish the owned parsed-JSON boundary, not a promise about arbitrary JS.

Capture a privately owned snapshot before any await; callers cannot mutate what was hashed. Freezing an
already partially frozen caller tree is insufficient: the current helper returns early at a frozen parent.
Make native HTTP ownership, descriptor checks, snapshot cost and the no-user-code premise explicit. Freeze
the private validated body recursively; structured clone does not transfer frozen guarantees. Never cache
a mutable caller reference. An aborted/cancelled preparation creates no reusable validation authority.

Existing `readRelease(pool, digest, {composed:false})` is the closest authority: it checks current-database
existence even on a process-cache hit; on a miss it reads, validates, checks digest, freezes and caches.
A composed hit is not proof of publication. Include database scope in the key or retain that existence
check; a body cached from another pool is insufficient. There is no `authoritativeRelease` symbol in this
snapshot; these are the actual authority semantics. The published map has no eviction; do not add another
unbounded input-driven map. Cache committed actual bodies only; eviction/restart misses must use the same
bounded preparation rather than synchronously blocking in an ordinary read helper.

Hash equality with that immutable published body permits its actual validated data to be reused under the
existing canonical SHA-256 collision assumption. Object-key order is immaterial; an enum order/value, extra
field or quantity bound changes canonical bytes and cannot borrow authority. Reuse is internal before native
authorization, never an early HTTP success or public existence probe. Cache/row timing must not disclose
stored data or change a denied response/effect. Historical accepted bodies require the owner's immutable
publication policy, not an invented exemption for an input the current validator refuses.

Every attempt, including same-key replay, still needs native current account admission, fresh Access,
authoritative `T`, and transaction authorization **before receipt lookup**. Saving CPU before command entry
does not permit early receipt reads. Keep actor/kind/key and unchanged envelope-digest comparison: same key
with changed body conflicts. The first created result is 201 and its receipt replay remains 201; an already
published digest/fresh key returns 200 with existing command event/receipt behavior. Same-key replay adds
no effect/position. Denied callers receive no stored receipt or publication data. A blanket 200 is wrong.

## Native execution, deadlines and lifetime

Existing [request admission](../../services/kernel/src/http/admission.ts) bounds normal permits at eight,
reserved permits at two and waiting jobs at 32. Expired/aborted queued work is removed; active synchronous
CPU is not interrupted. Async wrappers/Promises do not preempt it. Yielding between properties can bound
aggregate slices but not a single 6,222-step proof; the measured fixed proof blocked hundreds of milliseconds.
Keeping the indivisible checker while requiring progress during it requires off-thread preparation.
A resumable proof implementation is a larger policy/dependency change, not an existing supported API.

Only existing Bun `Worker`/`node:worker_threads` mechanisms were investigated. A real native probe used
`node:worker_threads`, loaded the actual definitions module/private VM and validated a new
4,187,141-byte/4,096-distinct-pattern release. Code/raw output: `native-worker.ts`, `worker-probe.ts`,
`worker.jsonl`, empty `worker.stderr` in the temporary evidence directory. No `typeof`, mock or allow stub
was used as evidence. The worker returned no violations and digest
`sha256:b20d853e8a9f9c2a575481086703be417d728c2c6c1b8da2b66cbf03812bf260`.

The same native probe was also run with the pinned executable; `pinned-worker.jsonl` and empty
`pinned-worker.stderr` retain the separate observations. Both returned the same digest/no violations.

| Runtime | Ready/import | Parent post | Validation/digest | Total | Parent timer after entered |
| --- | ---: | ---: | ---: | ---: | ---: |
| PATH Bun 1.4.3 | 138.0 / 119.6 | 20.8 | 2,339.7 / 159.9 | 2,667.2 | 1.2 |
| Pinned canary 1.4.4 | 204.1 / 183.5 | 37.0 | 3,223.1 / 91.7 | 3,572.6 | 1.7 |

Fixture creation and parent canonical-size calculation preceded construction and are excluded from total.
Each worker's first validation was cold; its second job reused the initialized module/checker, without a
cross-call proof cache. Both parent timers ran before the result: native workers permit parent progress here,
but neither result
satisfies 2,000 ms. Process RSS across each job rose 129.0→227.7 MB and 133.2→242.6 MB respectively;
these are not worker heap caps. No HTTP/Access/SQL/envelope/admission was measured. Each second actual
validation was terminated at its entered marker: exit 1 after 333.2 ms/90.7 ms respectively, no late result.
The following 100 ms used 19.6/65.9 ms process CPU, with RSS 110.9/116.5 MB. This proves an actual native
cancellation path, not instantaneous termination, physical-thread reclamation or a worst-case native bound.

Bun documents separate JavaScript instances/threads, structured-clone messaging and experimental termination;
`close` can precede complete exit. Source forwards termination to the native worker; the `worker_threads`
promise resolves from close. `unref` is not cancellation, `Promise.race` does not stop CPU and a cancellation
message cannot interrupt synchronous JS. The inspected wrapper exports an empty `resourceLimits`; no hard
per-worker heap limit was established. Do not assume Node/V8 limits in Bun. Source revision differs from
the probed runtimes; bounded cleanup/VM interruption/resource behavior still needs native acceptance.

Proposed port, requiring executor/request owners: reuse existing admission with a small fixed number of
ready workers, one active preparation each and **no additional waiting queue**. Try to acquire capacity
after existing admission; if busy, return existing typed overload instead of adding hidden waiters.
Initialization of an assigned worker still consumes the original deadline. Workers receive owned definition data,
job identity/deadline only, never Access evidence, `T`, SQL clients or callbacks. Bound retained jobs/bytes,
initialization, idle lifetime and replacement attempts; include all copies and checker/JIT heaps. Saturation
must preserve reserved authentication capacity. Hostile inputs cannot spawn workers/retain payloads unboundedly.

Use ready handshakes, small result records and generation tokens. Timeout/abort/error rejects the request,
ignores late results and disposes the worker. Do not replace it until cleanup is accounted for; if native
reclamation cannot be established, keep the slot unavailable rather than accumulate retired workers. Failed
startup, clone error, unexpected exit and malformed reply require typed outcomes and deterministic cleanup
scenarios, not success-shaped fallback. Retain structural work bounds and verify native termination; an
expired request must never leave unbounded CPU. A plain cancellation message is insufficient during a proof.

Guard/snapshot/clone/hash can still stall the parent; the measured 20.8 ms post is real. String/transferable
byte messages may reduce cloning but add serialization/UTF-8/parse/ownership costs; measure both ends, not
Bun's advertised fast-path example. Move canonicalization/digest into the preparation where possible;
returning/rebuilding/freezing publication data still costs work. Bound and measure parent preparation phases;
a worker alone does not prove every parent phase responsive or the default request successful.

Retain the original request-entry absolute deadline through guard, lookup, startup, worker, authorization and
command. Check before dispatch, after awaits and before fresh command entry; never start expired work or
grant another 2,000 ms. Typed deadline/unavailability/refusal is correct when aggregate work cannot finish.
Off-thread execution does not make CPU cheaper. Ordinary production success and concurrent progress need
separate evidence: the largest local workload exceeds the whole budget before native Access/SQL. A cache
hit or quiet p95 below 500 ms does not prove cold behavior. If every maximum permitted release must succeed,
that stronger requirement needs an owner-adopted algorithmic correction with measured headroom, not a larger
budget, a generous fixture, or more workers competing for the same CPU.

Finish preparation before [`runCommand`](../../services/kernel/src/command/command.ts): its attempt mints
`T`, prepares [current Access](../../services/kernel/src/request/access.ts), enters the Global
gate, checks out a transaction, authorizes and reads the receipt. Evidence lasts at most 1,000 ms and binds
to the attempt/`T`. Preparation after minting or inside the held gate/transaction risks stale evidence and
blocking unrelated commands. After preparation awaits, command entry must prepare fresh native evidence;
retries do so again. No parallel permission check, proof transport or control-query substitute is justified.
Existing admission/Access resource dependencies need their owners' review; do not introduce a nested queue
or hold a command connection while waiting for worker preparation.

## Tests to freeze before implementation

These are proposed additions to existing definitions/native API tests, not test changes delivered here.
Keep current checker, release, exact-quantity, library-profile and native deadline tests unchanged.

1. Freeze the real bundle digest, validation outcome and wildcard pointer on the pinned runtime; independently
   require intended native bundle publication. Resolve baseline incompatibility before using it as a successful
   cache seed. Cover every generated schema/option, ordinary quantity bytes, historical pins, exact quantities
   and all pointer/code/order/cap cases.
2. Count actual analysis calls/checkpoints for repeated fixed patterns, repeated user literals, 4,096 distinct
   patterns, reversed order and cold/warm/restarted workers. Fixed authority is finite; hostile churn cannot
   increase cross-call occupancy. Assert real verdicts rather than a mocked `safePattern` result.
3. Use the real definitions HTTP API and existing `createRealAccess` JWT/native account/grant fixture: cold
   new, same digest/new key, same-key replay, changed-body conflict, grant revocation, account/admission
   invalidation and denied caller. Assert exact statuses/bodies, components/receipt reuse, event counts and
   zero denied effects/disclosure; count validation reuse separately from Access checks.
4. Exercise malformed/cyclic/non-finite/non-JSON native values, lone surrogate keys/values, sparse arrays,
   serialization hooks, partial freezes, boundary UTF-8 sizes and collection overflow. Mutate the original
   after preparation starts: publication/digests remain its owned snapshot or reject consistently. Composed-only
   or other-database cache entries cannot masquerade as actual published releases.
5. Hold preparation at a barrier outside command entry; complete an unrelated real request using available
   admission, then release preparation. A native worker harness can pause between actual validation phases
   while the parent completes that request, then resume the same real proofs/result. Assert actual operations
   before/after and no held gate/transaction; never replace the validator/verdict. This deterministic schedule
   proves ownership/progress while work is pending. It does not prove simultaneous CPU progress: retain the
   separate actual-proof parent-timer observations above, without a fragile loaded-host latency threshold.
6. Expire a real default-2,000-ms request while preparation is held, then release it: typed 503, no command,
   receipt/event or deadline renewal/late-result authority. Separately cancel an actual running proof, fail
   worker/startup and saturate capacity; assert bounded live/retired workers/bytes and released permits.
   Use causal barriers with real timers, never a monkeypatched product clock.
7. Hold preparation beyond the 1,000-ms Access TTL while inside a native request schedule; record that mint
   and Access preparation occur afterward with fresh `T`; cover command retry reauthorization. Keep a separate
   unmodified-production-deadline publication test; a generous fixture cannot satisfy it.

Functional schedules prove ordering/isolation/cleanup; phase captures additionally report cold versus warm,
order/cache, guard, clone, import, proof, canonicalization, digest, Access, gate/SQL, RSS and parent progress.
Clock-free assertions do not prove headroom; elapsed time does not prove correctness.

## Adoption boundary and primary sources

Definitions owns finite reuse/canonical preparation and the bundle refusal regression; Semantic owns actual
published-body reuse and exact API/receipt behavior. Executor/request owners must adopt worker capacity,
lifetime and deadline changes; native Access owners review evidence timing. Separate pure proportional work
and publication reuse from the shared execution port. Freeze existing-API/new scenarios before implementation.
No service, durable queue, permission cache, engine, production budget or dependency change is delivered here.

Owner contracts must explicitly settle: finite table membership/version/readiness and the bundle defect;
published-cache scope/eviction and immutable historical-policy authority; parsed-JSON snapshot/error behavior;
worker count, zero extra queue, byte/lifetime/retirement accounting and typed capacity/cancellation outcomes.
Arbitrary cross-call proof caching remains unapproved. Start with
`packages/definitions/test/{pattern-safety,release}.test.ts` and
`services/kernel/test/semantic/{definitions,growth-definitions,exact-quantity-schema}.test.ts`, using
`real-access.ts` and the existing request-deadline tests rather than alternate auth/clock implementations.

Reference clones were read only, never installed/built/run. Provenance entries were added to main
`.reference/INDEX.md`; paths below are relative to that `.reference/`, inspected on 2026-10-29.

| Source | Provenance and inspected authority |
| --- | --- |
| recheck 4.5.0, MIT (`LICENSE`) | `definition-validation-cpu-deep/recheck`, `b40bd4d39217e54c94d2de5ed6ec521540fcffd6`; [browser API](https://github.com/makenowjust-labs/recheck/blob/b40bd4d39217e54c94d2de5ed6ec521540fcffd6/packages/recheck/src/browser.ts), `modules/recheck-common/shared/src/main/scala/codes/quine/labs/recheck/common/Context.scala`, `modules/recheck-core/shared/src/main/scala/codes/quine/labs/recheck/ReDoS.scala`. Installed browser SHA-256 `fd332e833abd002c9fc9e0b9d7a5282bbb33b0b5e81b06e7ff67c32bedca2fce`. |
| TypeBox 1.4.3, MIT (`license`) | `definition-validation-cpu-deep/typebox`, `ed9d84abeaec53af8da0bdc45c107e0eb5189de8`; [validator](https://github.com/sinclairzx81/typebox/blob/ed9d84abeaec53af8da0bdc45c107e0eb5189de8/src/compile/validator.ts), `src/compile/compile.ts`, schema build code. |
| canonicalize 5.1.0, Apache-2.0 (`LICENSE`) | `definition-validation-cpu-deep/canonicalize`, `31fb117afde3ef305b2e1d99bde539bf6300bc62`; [serializer](https://github.com/erdtman/canonicalize/blob/31fb117afde3ef305b2e1d99bde539bf6300bc62/lib/canonicalize.js), primitive and iterative container handling. |
| Bun, MIT plus dependency licences (`LICENSE.md`); inspected WebCore files carry BSD-2-Clause headers | Reused `search-worker-outcome-harness/bun`, `c643ea8c2a9da88cae7e3508d2dd95c8f5857926`; [worker wrapper](https://github.com/oven-sh/bun/blob/c643ea8c2a9da88cae7e3508d2dd95c8f5857926/src/js/node/worker_threads.ts), `src/jsc/bindings/webcore/Worker.cpp`, `WorkerMessagingProxy.cpp`, `docs/runtime/workers.mdx`; [official Workers documentation](https://bun.sh/docs/runtime/workers). |

[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), an Informational RFC, supplies JCS input constraints,
number/string serialization and UTF-16 key ordering (§§3.1–3.2.3). Shared source patterns are reuse of compiled
immutable machinery, fresh per-operation contexts, exact serialization authority and explicit execution/
lifetime boundaries. These support designs in this stack, not copying an upstream worker pool or weakening
the deterministic safety policy.
