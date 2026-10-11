# Review revocation: Main feed reference-cut refusal

QA run `20261011t224103-6e152a` completed the ranking cost measurements, then
refused Home projection 0.166 seconds after the review-revocation command.
`services/main/src/modules/feed/source.ts:115–118`, in `graphPositionAtRelay`,
is the refusing predicate. It requires exactly one distinct delivered-event
binding at the requested Main stream/epoch/sequence, a `product` dataset in the
same graph epoch, and matching Relay scope/epoch/sequence fields in the envelope.
`feedReferences` calls it for the cut's start and end positions (`:184`, `:187`).
Commit `fd18b33c48a70814f9ea291d76bbdd31fc538633` introduced this translation.

This is a stream-to-graph binding check. Realm's epoch-wide admission predicate
is instead `services/main/src/modules/rankings/realm-threads.ts:158–163`: exact
Content/Main coverage, no unindexed reply or discussion anywhere in the epoch,
and no nonpopulation dirty job anywhere. Launch's scoped-admission work and
kernel's `docs/goals/kernel/reports/gated-reads-design.md` describe replacing that
Realm gate. They do not make a missing or ambiguous feed binding valid.

The latest design on `main` also names this **separate feed-cut case**. A legal
retained batch with `event_count = 0` has a `relay.delivered_batch` row but no
`delivered_event` row. The event-only lookup cannot resolve that whole position.
The design calls for graph-sequence custody from the batch's physical header or
slim-command receipt, while keeping the reverse event lookup. That explanation
is a hypothesis for the failed run until the actual batch and event rows are
captured; the old cost trace did not retain them.

The ranking test now retains feed/Relay checkpoints and bounded delivered-batch
and delivered-event fields on this exact post-revocation failure, then rethrows
the original refusal. It neither moves the checkpoint nor invokes an alternate
projector. The final retained-corpus run supplies the owner's missing evidence.

Rerun `20261011t232333-ad92f4` confirms the named empty-batch case: the feed
checkpoint is sequence 5633, and Main coverage advances to 5634 in the same
epoch. Both sequences have delivered-batch rows, with `event_count` 1 and 0
respectively. The delivered-event query returns a valid product binding only
for 5633. Thus the through-position lookup at 5634 fails `rows.length !== 1`;
it is not the Realm epoch-wide gate. The refusal took 0.122 seconds. The
retained profile JSON includes both batch rows, the event binding and the
checkpoints. Main's feed owner needs the batch/receipt custody fix described
by the design; the test preserves the failure and applies no workaround.
