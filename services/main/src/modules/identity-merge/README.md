# Reviewed duplicate Work merge

The public `merge` adapter uses the shared editorial lifecycle. A plan pins the
original source and survivor Work revisions and evidence. Preflight returns
multilingual identity headers and bounded per-owner counts. Self, non-Work,
stale, cyclic and already-redirected pairs are refused. All launch merges and
unmerges require two independently controlled Person Agent approvals; a bot or
another Agent controlled by the same person cannot supply another approval.

The first ordered command commits the Work's `rv:mergedInto` edge and its native
Jena receipt. Unmerge removes that edge first. Subsequent person-state commands
run behind G-846's retained ordered command bindings and fresh G-865 authority.
Library, follows and reading-progress writes resolve their Work through the
shared target resolver. Incoming-reference fencing and identity reservations
are intentionally absent from this launch path.

Each owner inventories indexed pages of at most 32 source items, saves the
snapshot in Access before delivery, and atomically saves its native effect and
receipt. Native receipt lookup precedes stale-state checks. Explicit decision
retry advances pending stages; public reads only resolve retained receipts.
The shared ordered application is the only application/retry lifecycle.

| Owner | Forward policy | Compensation |
| --- | --- | --- |
| Library | Survivor slot (including a cleared slot) wins; source-only status and dates move, original retained in the journal | Exact personal slot comparison; fresh native versions; later edits ambiguous |
| Follows | Survivor slot (including explicit unfollow) wins; source-only follow moves | Exact slot and inventory comparison; unrelated follows retained |
| Rating | One current standing vote per Account principal and Context; native survivor wins; source-only vote selected with its original admission/observation receipt; exact attempts and historical Main Versions retained | Remove only this merge's selection; original observations never rewritten; later edits ambiguous |
| Review | Survivor person/Context slot wins; source-only review moves with attribution, helpful votes and revision history | Exact post-effect pair comparison; later edits ambiguous |
| Progress | Exact structure, occurrence and selection remain independent | Retained outcome never enters compensation |

Unmerge uses the original task's immutable moved/history items rather than
rediscovering survivor contents. A changed item receives an `ambiguous` outcome;
it never authorizes overwriting the intervening personal edit. Task, candidate,
owner versions and data epoch are pinned across retries.

Graph facts, realizations, compositions, collection occurrences, statements,
relations, source bindings and Main Versions remain on their original Work.
The survivor entity page includes bounded `mergedFacts` origins via
`rv:mergedInto+`, with disclosed original Work headers and links to their native
fact inventories. Exact revisions and facts remain attributable to the original
identity. Grants, private disclosure and creator rights never transfer.

Handlers are discovered as `modules/<owner>/merge-handler.ts`. The SQL
person-state coverage test detects even empty new owner tables and requires a
handler or an exact, explained exclusion from `person-state-coverage.ts`.
Sessions, owned copies, exact attempts, imported private annotations and
immutable command receipts are exclusions. Graph predicate scanning is outside
this guard.

Old IDs return a typed merged resolution. Address GET 200 preserves its original
`work-address-v1` shape and original Work/Main Version, adding optional
`resolution`. Work, Main and address revision reads retain original bytes and
add that resolution separately. Resolution uses the shared disclosure, epoch,
cycle and 32-hop bounds, including redirects whose survivor has no slug.

`g-836-sao-public-api.test.ts` exercises the native adapter through public proposal,
review, decision and reversal APIs, overlapping personal state, a committed
Content effect with lost acknowledgement, restart/retry, retained graph facts,
old IDs/addresses/revisions and later-edit ambiguity. Kernel, SQL journal and
ordered-command checks separately exercise bounded paging and receipt-only reads.

Split beyond unmerge, the workbench UI and batch queues are deferred.
