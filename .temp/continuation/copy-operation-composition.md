# Continue copy operation bounds

Goal: performance. Manager: performance.

## Completed in the preceding change

- Added immutable nine-axis declarations bound to the actual copy store SQL, private restore source read, detail
  presentation read, retention read/CAS, filtered page variants, and bounded inventory options query.
- Preserved the 100-row page cap and separate maximum-page sentinel; the inventory query still reads at most 65
  values per dimension.
- Added native assertions for a full maximum filtered page followed by its cursor continuation and for Undo after
  the retained original subject redirects.
- Restore now withholds Undo when the retained subject resolves to a replacement subject.

## Remaining owner work

Compose complete immutable plans for create, update, no-change, delete, restore, stale/expired refusal, exact
receipt replay, read/presentation and both inventory observations. Derive and bind account/action/group preparation,
current owner account floor/fence, original/current Source and profile checks, partition/floor/epoch observations,
locks and open-loan evidence, receipt lookup/replay, transaction connection/time/rollback, copy triggers, Shelf and
History/outbox effects, terminal response serialization, and the actual foreign Semantic/Access calls through their
existing owners. Include raw cursor/option candidates, pins, source redirects and every dispatched retry. A bounded
SQL leaf is not the whole command plan.

Keep the existing command runner, client, deadline, retries, admission, SQL/indexes, 64/65 inventory limits, 100 page
limit and exact receipt/retention fences. Do not add a refusal path, capacity increase, source scan, alternate
scheduler or duplicated transport contract. Add only a few causal assertions to existing native suites and keep
the test lines below product lines. The verifier owns acceptance/native/root receiving after integration.
