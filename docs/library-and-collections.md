# Library and Collections

This document owns the shared personal Library and Collection model. The [Library Goal](goals/library.md) owns its
outcomes and completion; the [Commerce Goal](goals/commerce.md) keeps this work under the same manager. The
[Library module](../services/kernel/src/library/README.md) owns native algorithms and implementation composition.
Buying an offer neither creates a personal fact nor grants protected use; Library presence and Undo never change a
payment or entitlement.

## Ownership and behavior contracts

Web owns the shell, navigation, shared presentation patterns, Storybook and visual review. Existing producers remain
handoffs. Semantic owns definitions, subject identity and shared filter meaning; Search owns catalogue plans;
Accounts owns Access, scopes, account lifecycle and website scope alignment; Content owns Rating, reactions and
publication sources; Kernel owns shared execution, receipts and durable work. No Library or Web layer duplicates
these authorities.

Specialized behavior lives with its owner: [profiles](library-profile-consumers.md), [labels](library-labels.md),
[pins](library-pins.md), [Continue](library-continue.md), [private follow counts](private-follow-counts.md),
[dynamic Collections](dynamic-collections.md), [owner queries](library-owner-queries.md), [filtered lists](filtered-lists.md),
[Collection presentation](collection-presentation.md), [Collection Source](collection-source.md),
[progress adoption](library-import-progress-adoption.md), [VNDB imports](library-import-vndb.md),
[state history and recovery](library-entry-state-history.md), [private consumption](library-consumption-diary.md),
[consumption statistics](library-consumption-statistics.md), [reported-year summaries](library-reported-year-summary.md),
[personal score ordering](library-personal-score-order.md), [occurrence correction](library-occurrence-correction.md)
and [deletion](deletion.md). This shared owner defines the common facts and visit/admission rules; it does not restate
those specialized contracts.

## Personal facts and profile meaning

For one owner and stored subject, an explicit exclusive entry state, labels, progress sessions, holdings and personal
annotations are independent private facts. Ratings remain with Rating. A label does not create state, progress,
holding, follow or presence. Clearing one fact preserves every other live fact and its contribution to Library
membership. Clearing the last qualifying fact removes the subject from Everything; a follow, curated occurrence,
rating, trash snapshot or published-log snapshot alone does not add it.

Immutable Definitions releases supply state sets, progress modes and units, copy kinds/statuses, and accepted import
meaning. A write of a profiled value requires the current accepted profile and exact admitted ID. Historical facts
retain their accepting release pins across publication, retirement, migration and Undo. A missing profile blocks new
profiled values but does not erase historical reads, clearing or exact Undo. Labels and curated occurrence edits
require no invented profile or default state. Sparse and noncontiguous progress units retain their individual
meaning; rereads are distinct occurrences, not a reset of prior history.

Stored subject IDs, personal facts and curated occurrence IDs are not rewritten by identity resolution. New writes
address the current terminal through the ordinary native resolver. Canonical browsing shows one card per canonical
subject while retaining each original fact and accepted pin; it unions independent labels and keeps sessions and
holdings separate. Identity and row order never supply permission. Private owner-write order and identity/source
currentness follow the [owner-query contract](library-owner-queries.md).

Personal notes and priority remain owner-local and revisioned; import evidence does not overwrite them without
explicit review. Copies remain separate holdings with their own status, revision and accepted kind. Optional
physical-condition observations use the finite `physical-v1` media and packaging vocabulary only when the exact
accepted Copy kind declares that condition; omission, explicit `unknown` and intentional `null` clear have distinct
meaning. Current profile advice never changes historical admission.

Personal-score ordering, diary/history, statistics, Progress snapshots and published logs retain the separate
contracts linked above. An active progress session can coexist with a non-active explicit state. Every allowed
progress mode retains its accepted unit semantics; no provider value, session, historic activity or counted use is
inferred from import mapping metadata.

## One Collection abstraction

A Collection has one stable identity, owner/curator, visibility, metadata, membership and mount/follow targets.
Curated membership is an ordered list of distinct occurrences: duplicate subjects remain individually editable,
ordered and noted. Dynamic membership derives unique subjects from native facts or a complete authorized published
output. Canonical browsing may combine matching originals into one card but never rewrites curated occurrences.
Presentation kind and client layout do not change membership or authorization.

Built-ins use the same Collection identity and members abstraction:

- **Everything** contains the distinct subjects with at least one live explicit state, label assignment, progress
  session or holding. Clearing one source does not remove another.
- **State Collections** match an exact accepted `(profileId, stateSetId, stateId)`. Live entry, copy and session facts
  with accepted pins establish supported state sets and sibling views; labels and retained deleted facts do not.
- **Liked** contains subjects with the owner's current Content `like` or `love` reaction. Switching between them
  preserves membership; clearing or another reaction kind removes it. A reaction alone adds neither Everything nor
  explicit state. Each account has a stable private Liked identity, including when empty.

Follows do not imply membership, visibility or permission. Private labels, pins, personal counts, notes, progress,
copies and import evidence never enter public indexes or anonymous views. A public Collection may disclose only the
subjects authorized by its own visibility and membership contract; a private predicate cannot be echoed as a public
fact. Publishing is an explicit owner action with its own currentness, disclosure and lifecycle.

Common Collection creation, editing, sorting, querying, filtering, export, public output, mounts and member paging
follow the [Dynamic Collections](dynamic-collections.md), [presentation](collection-presentation.md),
[filtered-list](filtered-lists.md) and [Source](collection-source.md) contracts. They require bounded native input,
actual source authority and complete currentness; an indexed candidate, prepared handle, prior grant or header does
not replace current authorization. A page is full or proves genuine final exhaustion. Sparse matches require finite
preparation that reaches useful output; rejected raw windows never become short/empty success chains. Preparation,
dependency unavailability and genuine empty/final results stay distinct.

A current-owner rule editor with the exact null-Collection address opens as a new-rule page when Collection
admission arrives. Released definitions remain usable, while Label choices stay independently gated.

Entry reading opens one exact row from the admitted shelf page without another read or write. Review the exact Entry
before clearing it; confirmation uses the existing native clear and Undo requires its supplied native receipt. Shelf
removal keeps the row and shows its refusal after a definite native or recognized thrown failure, then rotates the
next explicit key. An uncertain result retains the exact command and captured credentials for the same viewer.
Refresh never substitutes for the original retry, settles its result or rebases it.

A denied Progress-session list is a bounded permission state with no session facts or start controls; it is neither
an empty result nor start authority. The shared 403/empty/preparing distinctions above apply to session reads too.

## Destinations and actions

This section is the shared owner for Library browser visits. Subject entry, Copies, Labels, Following, Pins, Continue,
Collections and History link to their more specific contracts for exact addresses, controls and recovery.

- A signed-in native `403` becomes a permission state, never an empty inventory, inferred capability or document `500`.
  Closed, `404`, unsupported profile/kind, invalid or stale cursor, preparing, and dependency-unavailable remain
  distinct outcomes.
- A page retains its exact admitted address and explicit bounded recovery. It never makes an automatic extra read or
  invents refreshed authority. Invalid/stale cursor recovery starts at the first page only after an explicit action;
  it preserves every valid independent filter or display choice owned by that destination.
- Viewer, credential, observation, admission, locale or visit replacement retires stale display data and callbacks.
  A denied page discloses no private stale target in its DOM. Retry/recovery reads only the address the person chose.
- A read refusal never settles a command that may have dispatched. Keep its original intent, credential and key; do
  not rebase it on refreshed facts. Same-visit denied-to-admitted Following reattachment preserves that command
  custody. Only the native receipt settles a mutation or enables its exact Undo.
- Collection-list admission and Pin admission are independent. Neither permission authorizes the other. Pin order and
  target projections never create a follow, Collection, entry, holding, grant or materialization.
- Continue's successful page, stale/malformed address recovery and native historical Progress handoff keep their
  exact saved address and owners in [Continue](library-continue.md). Following and Pins retain their own bounded
  continuation and replacement rules.

## Lifecycle, privacy and acceptance

Terminal account fencing takes effect before cleanup; readers and workers cannot recreate private facts after it.
Cleanup covers every owned row, retained receipt/evidence, external participant and shared payload custody under the
[deletion contract](deletion.md). Undo is scoped to its exact native receipt and current admission. Cleanup,
publication withdrawal and source preparation do not infer one another's completion.

The [Library Goal acceptance](goals/library.md#dependencies-and-acceptance) retains original API/native outcome
specifications, fixture/compiler/module/default-worker requirements, mounted surfaces, owner/other/anonymous/
suspended personas, currentness, privacy, replay, sparse useful pages, complete growth and lifecycle obligations.
Pages use real APIs and recorded responses and receive reviewed locale, theme, device, pointer, keyboard and touch
coverage. Story inventory and source presence alone prove none of these outcomes.
