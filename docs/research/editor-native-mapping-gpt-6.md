# Indexed evaluation of native mapping sequences

Inspected: 2026-11-15. This extends the evidence for
[bounded bulk text](../editor.md#bounded-bulk-text-execution); it does not introduce a new document, Step or StepMap.

## Reached second limit

The compact native model prototype passed initial native differential cases and built/applied 100k dense and
spaced text below a second without the original 6 GiB retention failure. A decisive additional case applied a real
non-history positional insertion after a 100k-character spaced edit with 50k native steps. Native undo did not
return within the isolated 20-second bound, while executing the history remap path. Forward-only construction is
therefore insufficient proof of bounded bulk execution.

The inspected [History 1.5.1 source](../../node_modules/.bun/prosemirror-history@1.5.1/node_modules/prosemirror-history/src/history.ts)
maps event steps through accumulated native maps when non-history changes intervene. The
[Transform 1.12.4 source](../../node_modules/.bun/prosemirror-transform@1.12.4/node_modules/prosemirror-transform/src/map.ts)
evaluates each mapping slice linearly. Repeated slice evaluation can dominate the owned monotone bulk undo path.
All steps, individual maps, history Items and mirror links remain the correctness reference.

## Exact evaluator

Adopt a private index over the existing native map sequence, used only by owned native step mapping. A segment
summary has an affected input hull `[lo, hi]` and total position delta. A point strictly left of the hull maps
identically with no deletion information; strictly right it maps by the delta, also with no deletion information.
A point on either endpoint or inside the hull must descend or use native evaluation.

For consecutive segments A then B, a safe tighter composition is:

```
lo = min(A.lo, B.lo)
hi = max(A.hi, B.hi - A.delta)
delta = A.delta + B.delta
```

For a point left of lo, A is untouched and leaves it left of B. For a point right of hi, A adds its delta and
leaves it right of B. Thus skipping preserves position and all deletion flags. Empty and unindexable summaries
require explicit handling; unsafe arithmetic cannot establish a skip. A wider hull is safe but can lose the
required performance under replacement growth.

Build bounded segment/forest summaries from append-only native arrays, preserving the existing map objects.
Descend affected segments to native `mapResult` and `recover`; mirror jumps retain the native condition and resume
after the mirrored index. Accumulate deletion information in the native order. The final aggregate result has
the same position/deletion flags and null recovery value as native Mapping. No native arrays or mirrors are mutated.

## Correctness hazards from independent review

- Leaf coordinates come from native `forEach`, not raw ranges. An inverted map's input ranges include preceding
  deltas. For `StepMap([0,0,10,20,0,1]).invert()`, the second affected input range begins at 30; using 20 can wrongly
  skip position 25 and return 14 rather than the native 15.
- Slice from/to are absolute map indices. Native slice defaults and a mirror exactly at to must be preserved.
  A jump can bisect a cached segment; processing resumes at the exact mirrored successor.
- Sharing maps does not imply sharing mirrors. A view created with undefined mirror retains that state after
  another owner later creates its own mirror array. Append horizons and copy-on-write identities matter.
- Mirror lookup preserves the first array occurrence. Duplicate pairs can be asymmetric; an index must not
  normalize them into a different pairing.
- Native recovery is handled before that leaf's deletion flags are accumulated. A successful jump suppresses
  those flags and intervening maps, while retaining flags accumulated before the jump.
- Zero-width ranges and endpoint equality must reach native logic. Unfamiliar map implementations, unsupported
  mutation, invalid bounds and non-finite summaries use exact native fallback.
- Rebuilding the full index for every short-lived slice would retain quadratic work. Cache/update ownership must
  follow the underlying append-only native data and actual mirror view, without retaining dead editing sessions.

The independent challenge found no counterexample to the hull proof under these conditions. It does not prove
an implementation. Existing source versions remain pinned and their MIT adaptation notice must accompany any
substantial source adaptation.

## Decisive verification

Differentially compare every position and both associations on short randomized map pipelines, including insertion,
deletion, replacement, adjacent/collapsed ranges, inverted/empty maps and native mirror recovery. Compare `map`,
all `mapResult` deletion fields and null final recovery. Exercise every slice boundary, nested/default slices,
partners at/inside/outside to, reversed/duplicate mirror entries, later mirror creation and copy-on-write appends.
Query both old and new views after each append.

Then repeat actual non-history insertion/deletion followed by native undo/redo on the reached 50k-step case,
including bookmarks, selections, partial matched-member deletion, marks and stored content. Measure index building,
updates, evaluation, actual plugin dispatch and peak memory separately. Include large growing replacements and
near-ceiling documents; same-size small models do not establish the supported envelope.

Any changed native result, mutation of native state, repeated full-prefix scanning or failure of the reached
end-to-end bound rejects the implementation. A match cap, dropped flags or disabled recovery is not an alternative.
