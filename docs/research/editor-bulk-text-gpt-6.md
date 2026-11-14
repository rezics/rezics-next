# Bounded bulk text replacement

Inspected: 2026-11-15. The adopted execution contract is [Editor](../editor.md#bounded-bulk-text-execution).
This report supplies evidence and design constraints, not an implementation or acceptance claim.

## Reached failure

The declared editor benchmark found 100,000 literal matches in a 100,000-character text document in approximately
10 ms. Constructing the ordinary native per-match transaction then exceeded the receiving check's 6 GiB memory
limit and exited 137 before application, history or bookmark checks. The input is below the admitted snapshot
ceiling. A prior 10,001-match case did not establish the required scale. Near-ceiling cases were not repeated after
the same failing allocation class was demonstrated.

The installed versions inspected are ProseMirror Transform 1.12.4, State 1.4.4, History 1.5.1 and Model 1.25.12,
through the pinned Tiptap 3.32.2 integration. Their package metadata declares MIT. No library implementation has
been copied by this research; any later substantial adaptation must retain its exact source and notice.

Primary implementation evidence:

- [Transform](../../node_modules/.bun/prosemirror-transform@1.12.4/node_modules/prosemirror-transform/src/transform.ts):
  addStep retains each pre-step document in docs; clearing that list violates later consumers.
- [Mapping](../../node_modules/.bun/prosemirror-transform@1.12.4/node_modules/prosemirror-transform/src/map.ts):
  native range recovery uses a 16-bit range index, and mapResult includes deletion/recovery semantics beyond position.
- [Transaction](../../node_modules/.bun/prosemirror-state@1.4.4/node_modules/prosemirror-state/src/transaction.ts):
  selection identity, lazy selection mapping, stored marks and step recording must remain coherent.
- [History](../../node_modules/.bun/prosemirror-history@1.5.1/node_modules/prosemirror-history/src/history.ts):
  steps are inverted against their prefix documents; undo/redo and mirrored rebasing must be considered together.
- [Model](../../node_modules/.bun/prosemirror-model@1.25.12/node_modules/prosemirror-model/src/node.ts):
  resolve and resolveNoCache differ in caching; a proxy receiver must preserve resolved document identity.

These are the bundled source versions actually inspected. They are available after the ordinary workspace install.

## Alternatives and constraints

| Approach | Outcome |
| --- | --- |
| Keep ordinary per-match transactions | Correctness reference, but reproduces measured retention failure. History merging happens after construction. |
| One broad paragraph/document replacement | Reduces construction cost but moves untouched gaps, bookmarks and pending insertion targets incorrectly. |
| Many separately dispatched chunks | Requires new partial-publication, interleaving, cancellation and history-group semantics; ordinary undo can still reconstruct the oversized event. |
| Atomic multi-replace Step/map | Attractive allocation profile, but not adopted: adjacent boundary flags, inverse collapsed ranges, range-index limits and partial-member mirrored recovery are unresolved native-equivalence obligations. |
| Compact native transaction | Conditionally viable for an owned text-only path: retain native per-edit maps/history, change bounded construction and prefix representation rather than their semantics. |

Two independent bounded source investigations identified the atomic map risks. A native probe showed that adjacent
range triples can return the same position but different deletedBefore/deletedAfter/deleted values from sequential
native maps. Inverted adjacent deletions can choose the first collapsed boundary rather than the final inserted
edge. A mapped batch that drops one logical member can also be paired with the original whole batch as one history
mirror; simply returning a position from recover cannot communicate a skipped external deletion. Supplying range
triples is therefore insufficient evidence of correct history behaviour. These findings rule out silently adopting
a broad or incomplete map to obtain a passing memory benchmark.

The independent reviews conditionally accept an owned compact-native path with no unavoidable map/history
contradiction, provided the following implementation boundaries are proven.

## Compact-native boundary

Keep every logical native ReplaceStep and StepMap, including the native history Item/mirror structure. Build final
affected inline content with chunk accumulation and one join per resulting mark run. Avoid creating and repeatedly
concatenating one text node per match. Preserve original node attrs/IDs, untouched child identity where possible,
marks, links, atoms, ruby containers, table content and footnotes.

Prefix docs remain semantically correct immutable Node/Fragment observations, materialized on demand with a bounded
internal cache. Exact inversions can be computed/cached for an owned native step and its true prefix. A step created
by native map/merge, or inverted against a foreign document, cannot reuse an unrelated identity-only cache. Preserve
native prototypes and serialization; no new Step JSON is required. Laziness must not retain the original complete
prefix as each proxy's backing target or indirectly retain every prefix through resolution caches.

The live editor receives a real final document. Selection resolution and public setSelection must agree on exact
document identity, preserve anchor/head direction and restore stored marks deliberately. The owned bulk command
may explicitly restore selection; it must not pretend that every transaction flag is unchanged. No global patch
to EditorState.tr is required: existing owned undo/redo and visit-bound native history-input handlers can use the
same transaction factory/facade. The existing history extension already suppresses the duplicate default beforeinput
handler, so browser historyUndo/historyRedo remain an explicit owned route.

The fast recorder accepts only proved monotone closed inline-text edits. Structural, non-monotone or unknown steps
use the verified maintained path. A private proof is required before bypassing UniqueID replay, whose normal
combineTransactionSteps reconstructs an ordinary Transform and otherwise recreates the allocation problem. The
proof covers the whole append batch; one accepted text transaction cannot hide another structural transaction.
No untrusted document/profile validation is bypassed.

Encoded output expansion must be checked with safe arithmetic before building or dispatching a huge replacement.
UTF-16 character count alone does not establish the serialized UTF-8/JSON ceiling, especially for Unicode and
escaped controls. Validate the complete resulting snapshot. No operation may publish a truncated or partial
document to fit a budget. Empty/no-op, rejected and canceled outcomes must settle the existing pending-snapshot
state without claiming a saved edit.

Transient find highlights must be cleared before processing the replacement's map chain; mapping thousands of
decorations through hundreds of thousands of maps can dominate cost. Rebuild them against the admitted result.
History boundaries must isolate prior and subsequent typing without adding an empty undo event.

## Decisive evidence

1. Compare native step JSON, prefix docs, inversions and every mapped position/deletion flag for both associations
   on small generated documents, including adjacent/spaced growth, shrinkage and deletion.
2. Compare forward, undo and redo with native history after mapped/merged steps and intervening non-history edits,
   including deletion of only one matched member. Preserve exact unaffected document content.
3. Verify marks and non-inclusive links at boundaries, nested ruby, atoms, lists, tables and footnotes; replacement
   text retains the actual first matched text's marks and leaves non-target structure intact.
4. Preserve upload insertion bookmarks before, between and after matches, plus reverse text/structural selections
   and stored marks. Reject stale/retired work rather than applying it to another visit.
5. Exercise the actual editor plugin stack, not only a model helper: UniqueID, history, transient decorations,
   validation, native history input and ordinary fallback must participate in the proof.
6. Measure dense 100k, separated matches, many small blocks and near-2 MiB admitted content through real dispatch,
   undo and redo, recording peak memory and user-visible latency separately from model-only build time.
7. Reject oversized Unicode/escaped output atomically; retain editable source and settle pending/error feedback.

The recommendation is invalidated by prefix-value or selection-identity differences, reused incorrect inversions,
unbounded replay in an actual plugin, altered native mirror behaviour, or failure of the dense end-to-end bounds.
Such a failure requires repairing the execution design, not relaxing bookmark semantics or adding a logical match cap.
