# Structure change work

A cross-parent group move reads the moved group's subtree summary, the old and
new parent ancestries (at most 16 occurrences each), and the existing bounded
order-segment neighbourhood. Its read and projection work is independent of
the number of descendants moved. Immutable tree seeks and copies retain their
existing bound of six page levels. This applies to every profile using the
shared Structure change command; profiles may impose a shallower depth limit.

Each active container record retains `subtreeLevels`, a histogram of active
descendants at distances 1 through 16. Height is the last nonzero bin's distance.
An insert adds one occurrence along its parent chain, a remove subtracts it,
and a cross-parent move transfers the occurrence and its histogram between
the two ancestries. This permits height to shrink without scanning siblings.
The summary belongs to the retained record, with no graph copy or second index.
Read responses omit it because it also counts undisclosed descendants.

Record pages written by the owner use `rezics-structure-record-page-v2`.
Legacy `rezics-structure-page-v1` record pages still verify; they cannot carry
the summary field. A copied record tree may reuse untouched legacy pages.
The manifest's `pageFormat` continues to name the base order/pin page format;
record and qualifier-key pages declare their own formats. Summary changes
produce new record leaf digests, copied ancestor-page digests and a new manifest
digest. Old retained pages and roots are never rewritten in place.

## Legacy repair

A foreground topology change that needs a missing group summary refuses with
HTTP 409, `structure_summary_repair_required`, naming the existing staged
replacement procedure. It never falls back to a descendant scan. Read the exact
retained records, create a replacement through `POST /v1/compositions/:id/stages`,
upload pages, seal and activate it. Seal derives summaries from validated parent
chains, replacing any counters supplied by the uploader. Restore also derives
summaries into the new revision while preserving the source revision's bytes.

This repair inherits staged replacement's current 4,096-record materialization
limit (and ordinary restore's 32-record limit). Larger legacy trees need the
existing staged builder to gain a scalable seal before their summaries can be
repaired. Newly command-built trees maintain summaries incrementally up to the
Structure placement limit. A refused repair leaves the retained head intact.

The [augmented-tree propagation pattern](https://docs.kernel.org/core-api/rbtree.html#support-for-augmented-rbtrees)
informs the choice to maintain aggregates on mutation paths. Here the semantic
tree's fixed depth and histogram, rather than its sibling count, bound updates.
The growth check in `tests/qa/integration/structure-group-move-growth.test.ts`
measures one admitted move at 16, 64 and 256 descendants; the unit check covers
summary maintenance, depth refusal, legacy rebuilding and immutable page reuse.
