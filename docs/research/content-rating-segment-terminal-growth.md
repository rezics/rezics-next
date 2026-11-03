# Native rating segment terminal and replay growth

## Operation binding

The Realm segment binding starts with the real membership HTTP command and follows the registered Community and Accounts membership workflow, `rating_voter_realms`, `rating_segment_job`, the DBOS segment workflow, and registered `rating_aggregate` effects. Eligibility starts with the native suspension command and follows `rating_voter_eligibility`, the same registered segment job and workflow, and the registered aggregate effects. Each measured selected voter has exactly 100 native vote commands; the eligibility voter retains one counted Realm membership and affects Global plus that Realm. The test asserts `[100, 0]` page sizes, a settled terminal checkpoint, and unchanged aggregate state after re-delivery of the first real page event.

The empty case starts with a voter that has no votes and asserts its single `[0]` terminal page. It is kept distinct from the second empty page after an exact 100-vote page. Unrelated voters and votes, then retained native command receipts, grow independently at 256, 1024, and 4096 while the selected vote neighbourhood and route partition stay fixed. The owning Cost bounds are constant rows, logarithmic blocks, and constant statements for these fixed terminal sequences; this does not claim constant cost for an unbounded workflow.

**Decision:** Re-key stays bound to the existing `processRatingSegmentPage` page measurement in `growth-segment-job.test.ts`; this slice adds no re-key terminal or replay owner.

## Verification record

Pending the focused test and kernel typecheck. The frozen `growth-segment-job.test.ts` remains unchanged. No product, protocol, account, Access, or shared runtime contract code is changed. Browser, native suite, root, worker, remote, and controller acceptance launches remain deferred by the current launch context.
