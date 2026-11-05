# Liked membership primitive growth

The [Content Liked contract](../../services/kernel/src/content/README.md#reactions) bounds membership by
one caller-client statement and one complete-primary-key seek per requested ID, up to 256 inputs:
O(k log n). This operation binding supplies the missing fixed-batch growth measurement for Content's
reaction acceptance. It makes no claim of independence from k.

## Operation binding

`services/kernel/test/content/growth-liked-membership.test.ts` calls the production
`readLikedMembership` on an instrumented caller client. The shared native SQL observer verifies the exact
statement and deduplicated parameter binding. Native auto_explain notices from that same execution establish
one complete-key indexed probe per distinct input ID; the shared growth observer/classifier captures actual
rows, buffers, statements and background work. No diagnostic EXPLAIN substitutes for the operation.

Setup creates an isolated native Content/Auth system with the production Access factory and real subject
HTTP creation. Real authenticated reaction commands select like, love, laugh, and another account's love.
The native Content module registers effects; its durable dispatcher enqueues committed envelopes and awaits
the registered runner results. Native contributions establish completion before measurement. No effect is
called directly. Numerical fixture setup seeds a source version just below the safe JavaScript integer limit;
the selected like/love commands then advance it to exactly `9007199254740993n`.

Selection fixes raw IDs, like/love slots, actor, source-version snapshot and input batches before growth.
Each axis has separate small (six inputs, five distinct), 256-distinct-input, no-match, and empty-input series.
All run at 256, 1024 and 4096. Small-input duplication proves deduplication. No-match selection includes the
actor's laugh, another account's love and an absent raw ID. The 257-input rejection is captured with zero SQL,
even when all inputs duplicate a valid ID. The empty-input operation still issues one statement and returns
the selected actor's nonzero exact version. A separate native actor exercises the absent-version baseline 0n.
Neither empty membership nor baseline 0 establishes source completeness or permission.

The axes vary independently, resetting only suite-owned pressure between series:

- Other actors: one unrelated actor and love slot per scale unit, on the selected actor's route. Their source
  versions grow naturally through the trigger. Selected-actor retained history stays fixed.
- Same actor history: one unrelated subject laugh slot and one retained receipt, write basis and outbox
  event per scale unit. History clones the real laugh command's shape with fresh targets, request digests,
  keys, native positions and identities. Other-actor population stays fixed. Laughs preserve the selected
  Liked version and neighbourhood.

Fixture counts pin each axis at all three scales. Seeding, native command setup and selected effect completion
are outside the read capture. Completion of each measured operation is the caller's resolved membership query;
there is no selected background runner work. Repetitions and warmups replay this read with identical inputs,
not reaction commands or effects. The series uses constant rows/statements and logarithmic buffers, with one
index descent per distinct ID plus the source-version lookup. Planner settings, TTLs and budgets stay at their
normal values. Existing page/version curves, migrations and shared fixtures remain unchanged.

## Execution boundary

Starting retained source: `c968558f1f20e21ca88ac8e7b26754a3fd642d7a` (clean). Inspection confirms the
existing membership test captures a single 256-ID read; its three-scale curves measure page/version reads.
The new series is authored acceptance, not a measured pass. The tested source revision is the committed
worker HEAD selected by the controller for these commands:

```sh
bun run --cwd services/kernel typecheck
bun run --cwd services/kernel check test/content/growth-liked-membership.test.ts
```

The admitted check output records the exact checked revision, reached assertions and three-scale observations;
each completed series additionally emits its axis, batch, fixed raw IDs/version and native row/buffer/statement
observations. Until that command executes, no scale observations or reached native assertions are claimed.
Full frozen acceptance and promotion remain deferred to controller integration. This primitive supplies raw
stored IDs only; Commerce retains canonical identity, disclosure binding and consumer tests. No raw membership
assertion grants public readability or changes a reader protocol or writer.
