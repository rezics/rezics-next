# Native rating segment terminal and replay growth

## Operation binding

The Realm segment binding starts with the real membership HTTP command and follows the registered Community and Accounts membership workflow, `rating_voter_realms`, `rating_segment_job`, the DBOS segment workflow, and registered `rating_aggregate` effects. Eligibility starts with the native suspension command and follows `rating_voter_eligibility`, the same registered segment job and workflow, and the registered aggregate effects. Each measured selected voter has exactly 100 native vote commands; the eligibility voter retains one counted Realm membership and affects Global plus that Realm. The test asserts `[100, 0]` page sizes, a settled terminal checkpoint, and unchanged aggregate state after re-delivery of the first real page event.

The empty case starts with a voter that has no votes and asserts its single `[0]` terminal page. It is kept distinct from the second empty page after an exact 100-vote page. Unrelated voters and votes, then retained native command receipts, grow independently at 256, 1024, and 4096 while the selected vote neighbourhood and route partition stay fixed. The owning Cost bounds are constant rows, logarithmic blocks, and constant statements for these fixed terminal sequences; this does not claim constant cost for an unbounded workflow.

**Decision:** Re-key stays bound to the existing `processRatingSegmentPage` page measurement in `growth-segment-job.test.ts`; this slice adds no re-key terminal or replay owner.

## Verification record

Current check source revision: `4db85aa196c9653b7b2f09ad83afaef9b0be85e1`.
Contract SHA-256: `f440d63c2d57e30abf0fff9ed8a5b6a01c4022470ffc592a57e716cb61ea3b37`.
Focused command: `bun run --cwd services/kernel check test/rating/growth-segment-terminal.test.ts`.
The fixture now supplies dedicated receipt keys to the private kernel. Schema consistency passed and the test reached
native subject creation, then failed with `TypeError: Record sources require native command history serialization`
from `validateCommandHistoryScope` in `services/kernel/src/history/record.ts`. The owning product seam is the native
Semantic subject command's serialization of the source set opened by `writeSubject` in
`services/kernel/src/semantic/subject.ts`; no product code was changed. No named test assertion or growth measurement
was reached, so unrelated-vote and retained-history observations at 256, 1024, and 4096 remain unmeasured.

`bun run --cwd services/kernel typecheck` at this revision reached compilation and exited 2 on diagnostics in
untouched kernel test files; it reported no diagnostics in the declared terminal-growth files.

Source revision: `c3105007c907b8063a565b2cfa68b47b90806701`.

Authored fixture: four selected voters each receive 100 votes through native vote HTTP; two eligibility voters receive a native Realm membership; Realm transitions use the native HTTP membership command; eligibility transitions use the production suspension and reinstatement commands. Four independent growth checks specify unrelated votes and retained receipts at 256, 1024, and 4096. The test asserts `[100, 0]` terminal pages, an initially empty `[0]` page, registered aggregate completion, a settled checkpoint, and unchanged aggregates after replay. No three-scale observations or test assertions were reached.

`bun run --cwd services/kernel typecheck` at this revision stopped during remote source-artifact publication with `absolute preparation deadline exceeded`. A prior typecheck identified two diagnostics in the authored files; both were fixed in `c3105007c907b8063a565b2cfa68b47b90806701`. The retry did not reach compilation. It also reported diagnostics in untouched kernel files.

`bun run --cwd services/kernel check test/rating/growth-segment-terminal.test.ts` stopped before loading the test with `Schema dump differs from db/library/schema.sql.` The declared source changes do not touch schema files. The test's measurement assertions therefore remain unverified. Browser, native suite, root, worker, remote, and controller acceptance launches remain deferred by the current launch context. The frozen `growth-segment-job.test.ts` remains unchanged; no product, protocol, account, Access, or shared runtime contract code changed.

Retry source revision: `24ab1a6eef2b7152121697d536cf03326fe7fb53`. At `5d40d179dc55d85fe80a02392323ddc1c9862da8`, the focused command passed schema consistency and reported a formatting error in the new test; formatting was corrected in the retry source revision. The focused command at `24ab1a6eef2b7152121697d536cf03326fe7fb53` and the kernel typecheck retry both stopped during remote source-artifact publication with `absolute preparation deadline exceeded`. No runtime assertions or three-scale observations were reached.
