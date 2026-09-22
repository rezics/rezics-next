# Content composition and import

## Explicit local composition

A Structure owns identified occurrences with parent, order and target reference.
An occurrence is one use, so the same target can appear repeatedly. Profiles admit
specific roles for chapters, tracks, ingredients, wiki navigation or other ordered
parts. A reference to a container does not implicitly expand all its descendants.

Membership, navigation, consumption order and semantic part-of are different
relations. Reordering preserves occurrence identity and progress. Reparenting
validates same-structure ownership and cycle rules under a concurrency-safe
generation. Fractional order keys have byte budgets and bounded rebalance work;
large sibling sets can use paged order segments without changing identity.

## Authoring and published versions

Ordinary chapters reuse a Post and follow context-eligible published content.
Reviewed adoption and fixed releases pin exact revisions. Structure history
uses immutable component manifests with [revision anchors](structure-history.md). Sealing a manifest
captures exact selected dependencies, not an implicit global database snapshot.

## Import and refresh commands

`plan -> stage -> validate -> activate`. Capture source structure/revision,
destination expected head, base correspondence, mapping policy and authority.
Assign stable destination occurrence IDs and record source-to-destination mapping.
Refresh performs a three-way source/base/local comparison. Human changes,
same-value confirmations, reordered items and unknown child correspondence remain
explicit; conflicts do not become last-writer-wins overwrites.

Stage bounded pages with leases and durable checkpoints. Catch up eligible
concurrent changes before a fenced activation, or return a conflict. Cancellation
leaves the active structure intact. Source withdrawal removes only its support;
it cannot erase independent adoption or contribution ownership.

## Disclosure, history and progress

Authorize target and selected content independently of the containing Structure.
A visible collection does not disclose a private member's title/count. Progress
keys stable occurrences, plus the relevant selected revision where precision is
required. Removed occurrences remain resolvable as tombstones/history. Restoring
a structure does not restore or overwrite each referenced resource recursively.

## Measurements and read models

Declare whether a metric summarizes direct children, selected leaves or another
coverage. Avoid summing both container totals and descendants or all alternative
languages. Cache by structure/selection/rule generation with source provenance.
Page children by parent/order/occurrence and expose pending metrics rather than
requiring full-tree loads on every read or write.

Acceptance covers repeated targets, huge sibling skew, concurrent reparent,
source refresh with local edits, publication changes and non-recursive restore.
