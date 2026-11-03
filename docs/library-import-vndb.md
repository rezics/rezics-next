# Personal VNDB list import

The mounted Kernel API imports only the authenticated person's uploaded `vndb-export version="1.0"` XML.
It does not fetch accounts, claim another person's account, create catalogue subjects, change provider mappings,
create holdings, labels or sessions, admit local votes, or publish notes/reviews. Web owns the interface.

Decision: compose explicit released entry-state commands with private source evidence; role suggestions never
grant an import mapping or invent state IDs, and every other field stays retained until its native owner admits it.
Profiles with no entry state set cannot receive a state. There is no separately released VNDB field mapping.
Integration preserves AniList label adoption with native operation metadata and existing erasure phase numbers; VNDB evidence cleanup appends after label consolidation.

Matching uses the admitted native `semantic.external_claim` tuple `(source="vndb", external_id="v123")`,
its tuple home, current canonical identity and subject readability. Alternate source namespaces are unavailable
through this slice. A title is display/search assistance only. Release IDs (`r123`) are never VN identities.
Release records, reviews, length votes, unknown containers and export metadata are retained privately.
Catalogue batch creation uses its existing native Record history (codec 3021) and admitted provider tuple;
VNDB review extends the native import guard union while other sources keep their original command operands.
Candidate arrays distinguish matched, ambiguous, unmatched, unavailable and unsupported. Native tuples are unique;
the ambiguous shape is reserved for multiple disclosed canonical candidates, never generated from titles.
Unmatched rows accept an explicit readable target obtained through ordinary catalogue search.

| Source field                                             | Review and native treatment                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Playing / Finished / Stalled / Dropped / Wishlist labels | Suggest active / completed / paused / dropped / planned roles; the person explicitly selects an actual released state ID.                                                            |
| Other labels and per-label attributes                    | Private evidence; no automatic local label creation.                                                                                                                                 |
| Vote                                                     | Preserve value and original 1–10, step 0.1 scale; no native vote or aggregate write. Zero is invalid on this source scale.                                                           |
| Started / finished                                       | Preserve year/month/day precision, including trailing unknown `00` components; invalid and unknown dates remain distinguishable. No command clock or historical session is inferred. |
| Progress and measure                                     | Preserve original value, including zero, and supplied unit; no session or counted activity is inferred.                                                                              |
| Notes, privacy, review, metadata, unknown XML            | Visible retained evidence with its reason; exact original XML is downloadable only by its owner. Notes are never public reviews.                                                     |

Missing, empty/unknown, invalid and valid values have distinct `kind` values with original `raw` text retained.
No absent value clears native facts. Existing entries are preserved by default; `replace:true` captures the current
revision and incarnation for explicit review. Confirmation names that immutable `reviewId`. Apply rechecks current
account authority, chosen identity, readability, release, cancellation and native admission. A changed basis returns
`stale`; refresh review. Native commands freeze target, state, revision, incarnation, review guard and command key.
An unknown failure retries that original command; it cannot be re-reviewed into different operands. Exact native
receipt replay remains possible after an acknowledgement is lost. Applied rows are never applied again.

Limits: 2 MiB UTF-8 XML (JSON wire bound 12 MiB + 64 bytes, including escaping); depth 32 before parsing; at most 5,000 review rows including metadata; 16 MiB parsed evidence;
four uploads per account; eight rows per page/apply; a five-second scheduling budget per apply, with bounded native
commands already in flight allowed to finish. Cancellation/deletion orders against fresh admission under the same
owner lock, stops new rows and leaves acknowledged effects intact. Each row returns applied/skipped/stale/unsupported/
failed. Unstarted rows are omitted when `stopped` is deadline/cancelled; resume the same selection. Uploads expire
after 24 hours for new work, are removed on the next upload or explicit DELETE, and belong to Library terminal erasure.
DTD/entity declarations, malformed XML and XML bounds return 400; the JSON wire bound returns 413. Evidence and review payloads never enter public Search,
events, logs or error details. Responses use `Cache-Control: private, no-store`; mutation receipts carry only bounded
identifiers/outcomes, while source evidence stays in the owner table. HTTP admission also requires personal Library
exposure and the current `library_entry:update` scope; native entry reads require `library_entry:read`.

The following are constructed typed request/result examples for Web, not execution evidence. All mutations except
apply require the ordinary quoted `Idempotency-Key`; apply reuses the stable commands named by its review IDs.
The exported `createVndbImport` result types and mounted `vndbImportRoutes` form the typed response contract.

```ts
// POST /v1/libraryImports/vndb:preview
const previewRequest: { xml: string } = {
  xml: '<vndb-export version="1.0"><vns><vn id="v123"><title>Title</title></vn></vns></vndb-export>',
};
// 200: {uploadId: UUID, rows: 2, limits: {bytes:2097152,depth:32,rows:5000,evidenceBytes:16777216,page:8,uploads:4,lifetimeMs:86400000,applyMs:5000}}
// GET /v1/libraryImports/vndb/{uploadId}?offset=0
// 200: {uploadId,state:"active",expiresAt:ISODate,total:2,next:null,rows:[{ordinal:0,kind:"vn",identifier:{provider:"vndb",kind:"vn",value:"v123"},title:"Title",labels:[],suggestedRole:null,fields,retainedReason,evidence,match:{status:"unmatched",candidates:[]},target:null,decision:null,fieldsTreatment}, metadataRow]}
// POST /v1/libraryImports/vndb/{uploadId}:review
const reviewRequest: { ordinal: number; action: 'state'; targetId: string; state: string; replace: boolean } = {
  ordinal: 0,
  action: 'state',
  targetId: '01900000-0000-7000-8000-000000000001',
  state: 'playing',
  replace: false,
};
// 200: {reviewId:UUID,status:"reviewed",targetId:UUID,state:"playing",baseline:null,replace:false}
// GET again shows current candidate states, conflicts, retained fields and the stored decision before confirmation.
const applyRequest: { rows: { ordinal: number; reviewId: string }[] } = {
  rows: [{ ordinal: 0, reviewId: '01900000-0000-7000-8000-000000000002' }],
};
type Service = ReturnType<typeof import('../services/kernel/src/library/list-import-vndb.ts').createVndbImport>;
const applyResult: Awaited<ReturnType<Service['apply']>> = {
  uploadId: '01900000-0000-7000-8000-000000000003',
  outcomes: [{ ordinal: 0, reviewId: applyRequest.rows[0]!.reviewId, status: 'applied' }],
  stopped: null,
};
// POST /v1/libraryImports/vndb/{uploadId}:apply
// 200: {uploadId:UUID,outcomes:[{ordinal:0,reviewId:UUID,status:"applied"}],stopped:null}
// action:"skip" => skipped; action:"retain" => unsupported, with evidence still readable.
// GET /v1/libraryImports/vndb/{uploadId}/source => 200 {xml:string}
// POST /v1/libraryImports/vndb/{uploadId}:cancel => 200 {uploadId:UUID,state:"cancelled"}
// DELETE /v1/libraryImports/vndb/{uploadId} => 200 {uploadId:UUID,state:"deleted"}
```

Catalogue dependency history keeps the conservative account-bearing classification when duplicate declarations
conflict; native command and Record account associations remain independently guarded.

Read references: `legacy-final:services/main/src/modules/library-import/formats/vndb.ts`, its contract/bounds/XML
helpers and `csv.ts#sourceDate`; native entry/profile/identifier contracts; `.reference/INDEX.md` (no VNDB entry).
The native HTTP scenarios live in `services/kernel/test/library/list-import-vndb-http.test.ts`; broader frozen
acceptance remains an integration responsibility. No provider live-account or alternate-source support is claimed.
