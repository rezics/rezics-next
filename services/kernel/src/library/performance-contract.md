# Native Entry operation bounds

Decision: derive native Entry work as immutable SQL leaves composed by the existing command owner; retain
current authorization, exact receipts, source fences, deadlines and transaction custody. Use a few causal native
journey assertions rather than a separate mirrored arithmetic test family.

## State-history page

`entry-operation-bounds.ts` declares and executes the exact `entry-state-history-page.sql` leaf through
`pageEntryStateChanges`. The caller validates the public 1–50 limit and adds one sentinel before constructing the
plan. The frozen operands are the same operands dispatched on the original authorized snapshot client.

The page can examine all 64 retained rows for the subject, including discarded revisions and other incarnations;
the requested result limit does not bound that work. Its nine-axis declaration includes one native point, one
possible empty seek, one statement, the compiled SQL, original serialized operands and every projected row,
including the sentinel. States use the existing 64-character vocabulary limit, command kind uses the longer native
writer name, and JSON escaping uses six bytes per character. Timestamp projection reserves 64 characters for the
PostgreSQL range and timezone representation. No profile-pin JSON is selected by this page. Identity metadata,
witnesses and engine requests are zero for this SQL leaf: it does not perform admission, produce a witness or call
Search. The declaration never uses observed row counts to reprice the dispatch.

This is a leaf declaration, not the whole Entry journey or a native work grant. Account/action/group admission,
source preparation/currentness, partition/floor/epoch, locks, command receipts, transaction controls, state-history
capture/pruning, Shelf work, History events and response serialization belong in their enclosing native operation
plans. The current command runner continues to own execution and replay. Read-only history cannot repair an Entry;
no-op and receipt replay cannot append a transition. Retention and the public history/page limits are unchanged.

# Progress session operations

The existing Progress and Continue descriptors retain their native session commands and response contracts.
An operation declaration describes work; it supplies neither owner authority nor evidence of execution.
Native owner admission still precedes receipt lookup. A completed mutation receipt and its current presentation
are independent: failure to present current source evidence cannot erase or acknowledge a mutation.

## Journal command identity

`patchSessionJournal` retains the principal, command kind, request key, session ID and normalized patch, including
the expected journal revision. Its receipt input retains the public `admission: null` member. Private import
admission identity never enters that digest. Consequently changing an import review cannot change the identity
of an already acknowledged journal command. A different patch with the same key remains a conflict.

Private admission runs inside the fresh mutation transaction after the session lock and owner check. Failure
rolls back the mutation and creates no successful receipt. Replay returns the original result under current
owner authorization without reasserting an obsolete import review or overwriting later journal edits. Private
admission does not grant public command authority.

Decision: retain the public journal digest shape and exclude private admission identity; two causal additions to
the existing native session suite cover replay after a later clear and rollback followed by retry.

## Operation derivation boundary

Closed session plans must compose preparation, original and current profile reads, owner/partition fences,
receipt replay, shelf head/activity, mutation, triggers, History and terminal presentation work through the
existing native ports. Keep logical results, examined rows, points, serialized bytes and engine requests as
separate axes. SQL-only terms can declare zero engine requests; nested native calls need their own declarations.
The ordinary session/unit/change limits remain default 20 and maximum 100; owner discovery remains maximum 50.
Raw sentinels and discarded candidates consume work and retain their original keyset frontier. No declaration
permits refill, account-history scans, cap increases or a second native admission.

# Library performance contract

This leaf owns Collection operation bounds and custody across Library consumers. The detailed SQL derivations and
operation-specific growth suites remain in the [Library Cost sections](README.md#cost); this contract does not claim
those suites have passed. Shared native bounds and evidence are owned by the [Kernel performance contract](../../performance-contract.md).

## Collection operation costs

Price the complete operation: request and status reads, checkpoints, activation, preparation, authorization, locks,
serialization, receipt and effect work, source fences, negative or discarded candidates, and every nested disclosure.
A short returned page, deduplicated terminal set or fixed candidate declaration does not reduce physical work already
performed. Apply the existing 100 raw-key and 262,144-row native ceilings and the published Search maxima. Producer
declarations describe admissible work; they are not native grants, pagination evidence or funding.

Library owns one immutable closed nine-axis operation set: `candidateKeys`, `nativeRows`,
`identityMetadataRows`, `nativePoints`, `witnessKeys`, `statements`, `bytes`, `emptySeeks` and `engineRequests`.
Use overflow-safe sums, complete nested costs, explicit aliases and deterministic conflict resolution. Actual
Progress/Continue and Content Feed callers consume these descriptors.

## Whole-query publication

The 50-original branch is inadmissible. Its two `resolveSubject` disclosure passes alone require
`50 × 2 × 8,192 = 819,200` native rows before settlement, above the retained 262,144-row ceiling. This is a necessary
lower bound, not the completed operation derivation or native execution evidence. Refuse before useful staging and
preserve output A, the original client and owner, deadline, current authorization, drain and rollback behavior.
Do not create a refused frontier, checkpoint, seal, activation, partial disclosure, smaller-prefix workaround or
larger ceiling.

The whole-query branch remains separate from ordinary member-page planning, directory `listCuratorPage` and
read-only previews. Its existing [Cost entry](README.md#whole-query-collection-publication) owns operation-specific
SQL detail. The [ordinary member-page entry](README.md#members-page) owns canonical store/fence behavior, owner-filter
HTTP, plan and growth evidence, BASIC/FULL continuation, and final owner/source currentness. Search receiving keeps
its five existing suites: `scoped-work-context`, `members-native-scope`,
`scope-members-source-declaration`, `scope-kind-work-context` and `publication-work-context`.

## Descriptor custody

Preserve original opaque evidence, one original client, current owner and deadline, the three-attempt limit,
current authorization and source checks, and native consumption before the tracked transaction. Drain and release
exactly once, including terminal release after useful-work expiry; preserve same-client rollback and native caps.
History and Work bind their execution adapters at service roots ([History](../history/README.md#selected-native-executor-binding),
[Work](../work/README.md#selected-execution-producer)). This documentation does not authorize cross-owner mutable
quotes or funding, refill, price profiles, another admission protocol, a second consumer or a new writer.

The [architecture](../../../../docs/architecture.md#modules-and-boundaries) owns permission-core purity, public
edges and adapter direction; [verification](../../../../docs/development/verification.md#capability-evidence)
owns the limits of native, browser and finite-execution evidence.
