# Native rating segment terminal and replay growth

## Operation binding

The Realm segment binding starts with the real membership HTTP command and follows the registered Community and Accounts membership workflow, `rating_voter_realms`, `rating_segment_job`, the DBOS segment workflow, and registered `rating_aggregate` effects. Eligibility starts with the native suspension command and follows `rating_voter_eligibility`, the same registered segment job and workflow, and the registered aggregate effects. Each measured selected voter has exactly 100 native vote commands; the eligibility voter retains one counted Realm membership and affects Global plus that Realm. The test asserts `[100, 0]` page sizes, a settled terminal checkpoint, and unchanged aggregate state after re-delivery of the first real page event.

The empty case starts with a voter that has no votes and asserts its single `[0]` terminal page. It is kept distinct from the second empty page after an exact 100-vote page. Unrelated voters and votes, then retained native command receipts, grow independently at 256, 1024, and 4096 while the selected vote neighbourhood and route partition stay fixed. The owning Cost bounds are constant rows, logarithmic blocks, and constant statements for these fixed terminal sequences; this does not claim constant cost for an unbounded workflow.

**Decision:** Re-key stays bound to the existing `processRatingSegmentPage` page measurement in `growth-segment-job.test.ts`; this slice adds no re-key terminal or replay owner.

## Subject command serialization

**Decision:** `subject.create` owns permanent History command kind 3020 and declares its receipt and every actual returned event using the identity evidence supplied by native Access admission; the growth fixture creates subjects through the existing private HTTP kernel with dedicated receipt keys.

The declaration stays in `createSubject`, after `writeSubject` has sealed its source set and returned the complete event list, before the executor serializes History. The identity terminal wrapper retains its existing drain and replay behavior. Production receipt-key validation and native source-set validation remain strict. The fixture grants its owner `subject:create` on Global Context and uses native HTTP creation, vote, membership, workflow and aggregate-effect paths.

## Measurement status

The clean base `10a74b6494213a0d72702c68e37dd17b17d6ad10` retains the source-set serializer failure reported at `4db85aa196c9653b7b2f09ad83afaef9b0be85e1`: `TypeError: Record sources require native command history serialization`. Its `createSubject` body opens and seals a source set without declaring command History. The previous focused check reached subject creation, before any named test assertions or growth observations.

The current launch defers focused acceptance until integration for changed source. No new runtime assertions or cost observations have been reached in this attempt. Done-when 4 remains unmeasured pending `bun run --cwd services/kernel check test/rating/growth-segment-terminal.test.ts` on the integrated source.

| Independent population                 | 256        | 1024       | 4096       |
| -------------------------------------- | ---------- | ---------- | ---------- |
| Unrelated Realm-segment votes          | Unmeasured | Unmeasured | Unmeasured |
| Retained Realm-segment command history | Unmeasured | Unmeasured | Unmeasured |
| Unrelated eligibility votes            | Unmeasured | Unmeasured | Unmeasured |
| Retained eligibility command history   | Unmeasured | Unmeasured | Unmeasured |
