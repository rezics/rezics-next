# Library and Collections

The [private reported-year summary](library-reported-year-summary.md) extends native completed occurrences with
explicit journal finish-year membership, twelve months and a year-only bucket, preserving separate all-time semantics.

The [personal consumption statistics contract](library-consumption-statistics.md) defines
private completed occurrences, distinct stored subjects and repeats from retained native
sessions, independently of current shelf state, holdings and published logs.
Decision: use explicit native completion for all-time counts and preserve unknown historic
profile coverage; date editing and canonical episode membership retain their existing owners.

A person's library and their lists are one capability. Every vertical (books, anime, games, visual novels, recipes,
records) configures it through definitions; no vertical has kernel code of its own. This document adopts required
first-public behavior, not a claim of runtime completion. The [Library module](../services/kernel/src/library/README.md)
records actual implementation and remaining gaps. The [Library Goal](goals/library.md) owns delivery under the
commerce manager, separately from the [purchase contract](../services/kernel/src/commerce/README.md). Purchasing
does not silently create Library facts; Library presence or Undo never grants or reverses payment/benefit rights.
[Scope](scope.md) defers user-saved dynamic queries.

The shared owner contracts are [Dynamic Collections](dynamic-collections.md), [Collection source](collection-source.md),
[filtered lists](filtered-lists.md), [Collection presentation and editor](collection-presentation.md),
[independent labels](library-labels.md),
[profile consumers](library-profile-consumers.md), and [deletion](deletion.md). Indexed evaluation and source-scoped
concurrent identity currentness below supersede older per-page proof/replay, whole-slot observation and identity-basis protocols in
those adoption surfaces and earlier research. Their ABI revisions belong to their owners; this adoption creates no
alternate mode, budget, API or authority document. The [library abstraction research](research/library-abstraction.md)
is background evidence, not implementation evidence.

## Personal facts and one Collection abstraction


The mounted [personal VNDB upload](library-import-vndb.md) supports private preview, identifier matching, explicit
review and confirmed entry-state apply through existing native commands. Scores, dates, progress, notes and unmapped
fields remain visible private evidence; broader personal-list migration remains second scope. Upload/review records
are bounded Library-owned data included in terminal erasure; cancellation never reverses acknowledged native facts.
