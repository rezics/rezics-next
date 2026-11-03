# Personal AniList upload

The mounted Kernel journey imports the authenticated person's uploaded JSON, without contacting AniList,
requesting credentials, creating catalogue subjects or claiming account synchronization. Commerce owns native
semantics; Web owns presentation. Preview stores private evidence but changes no native personal facts.

The supported dialect is `v1`, derived from retained primary AniList docs at commit
`03281c0a4bbf0c7f2097e0c935cddaed1096aa65`: `object/medialist.md`, `medialistcollection.md`,
`medialistgroup.md`, `fuzzydate.md`, `media.md` (idMal/type), and `enum/scoreformat.md`, `medialiststatus.md` under
`.reference/api-first-platform-coverage/anilist-docs/docs/reference`. These describe GraphQL types, not one
universal official downloadable export. The parser accepts a MediaList array, a collection `{lists:[{entries:[]}]}`,
`{MediaListCollection:collection}`, or `{data:{MediaListCollection:collection}}`. Deprecated statusLists/customLists
collection wrappers are rejected. Repeated entries in groups remain independent review rows. `hasNextChunk:true`
and all wrapper/group fields remain visible: this is the uploaded slice, never a claimed complete account snapshot.

Decision: absent a released AniList-specific field mapper, propose only a unique released entry-state role mapping;
retain every other field privately with its reason instead of creating progress sessions or Content contributions.
CURRENT maps to active, PLANNING to planned, COMPLETED to completed, DROPPED to dropped and PAUSED to paused.
REPEATING remains unsupported because repeat state/count does not authorize historical occurrences. Missing or
ambiguous native roles remain unsupported. A present local entry is preserved unless review explicitly sets replace.

`mediaId` and `media.id` identify AniList media; entry `id` never does. `media.idMal` separately declares a
`myanimelist` identifier. Existing native external claims resolve `anilist`/`myanimelist` tuples; current canonical
subject access and identity epochs are checked. No provider availability is inferred from these generic native
claims. Titles are display/search assistance only. Conflicting media ids or different canonical targets require
explicit review; no first-hit choice is made. Match states are matched, unmatched, ambiguous and unavailable.
Review may select any currently readable canonical target or skip. Apply refreshes identity, access, claim
fingerprint and release pin; a stale unstarted review must be refreshed. Native entry commands enforce original
revision/incarnation guards and current account admission; original source timestamps never order commands.

Every row exposes its evidence, group metadata, provider identifiers and field validity/reason; header rawUpload
retains the original text, including numeric spellings that JSON parsing cannot represent exactly. Absent fields
stay absent, null is unknown, zero stays zero, invalid values stay visible. Scores require separately declared
POINT_100, POINT_10_DECIMAL, POINT_10, POINT_5 or POINT_3; omission means unknown scale. Scores and advanced
components never create votes or aggregates. Progress keeps episodes (ANIME), chapters (MANGA), unknown measures
and volumes separate. Repeat, priority, custom membership, notes, privacy, precise/partial dates, updatedAt and all
unrecognized fields are retained, never applied. Unknown date components are not filled. Private notes are not
reviews; custom/private lists are not public Collections. No holdings, entitlements or labels are inferred.

Limits: 1,048,576 UTF-8 upload bytes, JSON depth 24, 200 rows (65,536 bytes/128 fields each, 100-character field names),
8,192-byte group metadata, five retained uploads per owner, 20 rows per
read/apply page. Upload is JSON text inside the request envelope. Headers carry the ordinary quoted Idempotency-Key
on preview/review/cancel. Apply confirms stored review ids; each review binds a stable native command key, original
operands and client attribution. Failed commands resume with those operands. Acknowledged row outcomes replay
without new effects. Outcomes are applied, skipped, stale, unsupported or failed; retained lists identify fields
not admitted. Failed attempts remain retryable. Stale started attempts retain their original identity for inspection;
start a fresh upload for a new choice. Pages stop starting rows at cancellation, disconnection or the request
deadline (20 seconds outside HTTP). Cancellation does not undo committed native effects. An in-flight command may
finish after cancellation. `complete:false` leaves remaining confirmations resumable. Evidence remains until explicit
remove or native account erasure; the account-leading store is erased in 100-key pages with the Library owned graph.
Receipts/events contain locators and outcomes only, never uploads, raw notes or review evidence. These stores have
no public Search projection. Read and update Library scopes are required. Shared history minimization retains its existing native owner responsibilities.

Web uses these actual mounted methods (examples below are constructed, not execution evidence):

```ts
POST /v1/libraryImports/anilist:preview
{ upload: '[{"mediaId":1,"status":"PLANNING","notes":"private"}]', scoreFormat: 'POINT_10' }
// 200 { id: string, count: number }
GET /v1/libraryImports/anilist/{importId}?after=-1
// 200 { header: {document: unknown, rawUpload: string, scoreFormat: string|null, count: number, cancelled: boolean},
// rows: [{ordinal, source:{evidence,group,identifiers,fields}, match, proposal, review?,started?,outcome?}], next:number|null }
POST /v1/libraryImports/anilist/{importId}:review
{ ordinal: 0, subjectId: 'canonical-uuid', fields: ['status'], replace: false }
// 200 { ordinal: number, review: {id,match,observation,input,commandKey,clientId,requestedBy} }
POST /v1/libraryImports/anilist/{importId}:apply
{ confirmations: [{ordinal: 0, reviewId: 'review-uuid'}] }
// 200 {outcomes:[{ordinal:0,status:'applied',retained:['mediaId','notes']}],complete:true}
POST /v1/libraryImports/anilist/{importId}:cancel
{ remove: true } // 200 {cancelled:true}; false/omitted stops new work while retaining evidence
```

Exact TypeScript request/result types are inferred by `list-import-anilist-routes.ts` from the native composition
in `list-import-anilist.ts`; arbitrary evidence uses unknown JSON values. Owner/current-authority errors use native
problems; malformed/oversized uploads return invalid_request without input echoes, foreign ids return not_found,
and review conflicts return conflict. No user-supplied account id or native command key is accepted.
