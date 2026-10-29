# Definition publication CPU and concurrent progress

Research snapshot: 2026-10-29, repository revision `5dfa8a7b4efec80a940b8332774d88bb093c2eec`.
This report is evidence for an owner decision, not an adopted runtime contract or implementation.

The correction must address two independent outcomes: ordinary permitted publication within the unchanged
2,000 ms request deadline, and progress of other requests while cold validation runs. A local proof cache
already removes repeated patterns within a release; compiling the release schema once is already implemented.
Immutable published data can avoid repeat validation, but cannot remove cold distinct-pattern work.

## Evidence boundary

Read the actual main-checkout Accounts evidence (`failure.json`, `contract.md`, `approaches.json`, and the
phase-capture `diff.patch`) and the integrated structural-checker review. The measured base was
`8ba7672a63e8fc4a66c9cd2169144968378b107e`; its head was `2bb2f2626e19b7eca07fa41ffb6da44fd269667d`.
Both have the identical `index.ts` blob `f5408a39c8009780583be35affc3890c22f46fb8`, with inline browser
`checkSync(pattern, 'u', { timeout: 3000 })`; neither has a separate `pattern-safety.ts` file.
The current structural checker has blob `654caa91ae2d7fb3aad5bbbe869d12f78d431a66`, identical to the
integrated revision `cdf00171a34a0ce54dbb321f43ee35b8cab5c89e`. Historical timings are therefore evidence of
the observed failure, not a measured performance result for the current deterministic checker.

The supplied twenty quiet isolated validation-plus-digest samples have p50 392.6 ms and p95 611.4 ms;
validation alone has p95 605.3 ms and seven combined samples exceed 500 ms. Twelve actual HTTP 503s took
2,469–15,462 ms, overwhelmingly before `runCommand`, with zero gate/transaction/contention time. That phase
also includes parsing, authentication and admission, so it does not attribute every millisecond to recheck.
No unchanged eighty-publish benchmark was repeated. The community fixture's generous deadline is separate
from both production's 2,000 ms budget and a synchronous event-loop stall.

## Existing work and authority

[`index.ts`](../../packages/definitions/src/index.ts) creates the TypeBox release validator once at module
initialization. Each `validateRelease` checks collection limits, estimates canonical UTF-8 size, canonicalizes
the full input, runs the compiled schema, then performs semantic checks. Each property generates its fixed
value schema and canonicalizes both actual and expected schema bytes. Pattern proofs are deduplicated by
exact source string within that call, including failures, with a fresh map on the next call.

[`compile.ts`](../../packages/definitions/src/compile.ts) has its own local source-pattern map and finishes
with `validateRelease`; compile-and-then-validate can repeat proofs across these two maps. Native publication
accepts release JSON and does not invoke the LinkML compiler. [`validate.ts`](../../packages/definitions/src/validate.ts)
already caches content validators by release identity and property in a WeakMap; that is a separate consumer.

[`pattern-safety.ts`](../../packages/definitions/src/pattern-safety.ts) is the sole compiler/release safety
authority. Preserve its source/depth/repetition/expansion/graph bounds and private 8,192-checkpoint counter;
only an automaton safe verdict succeeds. Do not replace it with the browser asynchronous API, wall-clock
safety, fuzz success, or cached unknowns.

[`publishRelease`](../../services/kernel/src/semantic/definitions.ts) validates synchronously before
`runCommand` on fresh keys and receipt replays, then computes the canonical release digest. The HTTP route
also hashes the canonical request envelope. Native authorization still precedes receipt lookup on every
command attempt. Reuse must preserve that order and fresh Access evidence, not create a permission cache.

## Recommendation to develop

First remove repeat generated-schema and canonicalization work using finite immutable authority, and make
published-digest reuse consume actual validated frozen data from the current database. Keep cold validation
outside the Global gate and command transaction. Treat cooperative scheduling and native Bun off-thread
preparation as alternatives requiring measured cold-work and cancellation evidence before adoption.
