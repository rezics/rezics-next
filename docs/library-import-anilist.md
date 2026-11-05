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

Decision: a retained source score has no inferred native conversion; the owner may separately choose native units or
clear the native vote, then separately confirm its effects. Missing, null, zero, invalid and exact numeric source
evidence remain distinct.

`mediaId` and `media.id` identify AniList media; entry `id` never does. `media.idMal` separately declares a
`myanimelist` identifier. Existing native external claims resolve `anilist`/`myanimelist` tuples; current canonical
subject access and identity epochs are checked. No provider availability is inferred from these generic native
claims. Titles are display/search assistance only. Conflicting media ids or different canonical targets require
explicit review; no first-hit choice is made. Match states are matched, unmatched, ambiguous and unavailable.
Review may select any currently readable canonical target or skip. Apply refreshes identity, access, claim
fingerprint and release pin; a stale unstarted review must be refreshed. Native entry commands enforce original
revision/incarnation guards and current account admission; an optional internal review guard pins identity/profile
again inside native command preparation without changing ordinary entry requests. Source timestamps never order commands.

Every row exposes its evidence, group metadata, provider identifiers and field validity/reason; `scoreLexeme` keeps
the exact JSON token for a numeric score, while header `rawUpload` retains the original text. Absent fields stay
absent, null is unknown, zero stays zero and invalid values stay visible. `POINT_100`, `POINT_10_DECIMAL`,
`POINT_10`, `POINT_5` and `POINT_3` remain distinct scales; omission means unknown scale. Decimal precision outside
the declared scale is invalid. Advanced components do not imply a standard score, and POINT_3 labels do not imply
enjoyment intervals. No conversion is inferred. A score review shows the retained value, exact numeric token,
scale, Content's current standard question/revision/meaning and owner-selected 0–20 native units. Review can select
an explicit native clear separately. Apply needs a separate `confirmNativeVoteEffects:true`; source privacy,
upload confirmation, state import and the score value do not provide that consent.

Decision: compose Rating's complete native review observation and exact guarded command for the selected
same-logical-home target in the existing AniList row; foreign-home support remains deferred. Effect confirmation
is separate from review, and retries preserve the original guard, operands and command key. Owner reads take
`currentScore` from Rating after guarded effects.

`createVoteCommands.readVoteReview` supplies the current question, canonical identity and required identity epochs,
raw original/canonical slots and counted own-vote witness. The importer stores its complete version 1 guard with
immutable source evidence and selected native operands. Review reports observation availability independently of
write availability. `putVoteOutcome(actor, {questionId,targetId,units,guard}, key)` owns validation, receipt digest
and effects. `replace:true` explicitly permits replacing a current vote as well as state; clear remains an explicit
score action. Missing effect consent is resumable. Consent checkpoints retain the original key and guard across
uncertain delivery; retries call that exact command without replacing its observations. Native stale and unavailable
results remain typed. Unexpected delivery errors propagate with the started checkpoint retained. Owner page reads
include `currentScore` from Rating alongside the current Entry proposal; receipts and retained evidence are not
current readback. A supported guarded effect is complete only after Rating accepts it and the importer records its
outcome; a later owner read reports Rating's current vote.

Progress keeps episodes (ANIME), chapters (MANGA), unknown measures and
volumes separate. Repeat, priority, notes, privacy, precise/partial dates, updatedAt and all unrecognized fields are
retained, never applied. Unknown date components are not filled. Private notes are not reviews; custom/private lists
are not public Collections. No holdings, entitlements or labels are inferred. Explicitly selected supported custom membership can be adopted
through the independent [private-label review](library-import-anilist-labels.md).

Limits: 1,048,576 UTF-8 upload bytes, JSON depth 24, 200 rows (65,536 bytes/128 fields each, 100-character field names),
8,192-byte group metadata, valid Unicode without NUL, five retained uploads per owner, 20 rows per
read/apply page. Upload is JSON text inside the request envelope. Headers carry the ordinary quoted Idempotency-Key
on preview/review/cancel. Apply confirms stored review ids; each review binds a stable native command key, original
operands and client attribution. Failed commands resume with those operands. Acknowledged row outcomes replay
without new effects. Outcomes are applied, skipped, stale, unsupported, failed or unavailable; native score outcomes
are nested per row. Retained lists identify fields not admitted. Failed attempts remain retryable. Stale started attempts retain their original identity for inspection;
start a fresh upload for a new choice. Pages stop starting rows at cancellation, disconnection or the request
deadline (20 seconds outside HTTP). Cancellation does not undo committed native effects. An in-flight command may
finish after cancellation. `complete:false` leaves remaining confirmations resumable. Evidence remains until explicit
remove or native account erasure; the account-leading store is erased in 100-key pages with the Library owned graph.
Receipts/events contain locators and outcomes only, never uploads, raw notes or review evidence. These stores have
no public Search projection. Read and update Library scopes are required. Shared history minimization retains its existing native owner responsibilities.

Private-label evidence, review/apply methods, normalization, bounds and per-item outcomes are specified in
[custom-list label adoption](library-import-anilist-labels.md).

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
// A score choice is separate: {ordinal: 0, subjectId: 'canonical-uuid', fields: [], score: {action: 'vote', questionId: '00000000-0000-7000-8000-000000000001', questionRevision: 1, units: 12}}
// Review retains source score/scale and the current Content question; current counted vote is typed unavailable.
POST /v1/libraryImports/anilist/{importId}:apply
{ confirmations: [{ordinal: 0, reviewId: 'review-uuid'}] }
// 200 {outcomes:[{ordinal:0,status:'applied',retained:['mediaId','notes']}],complete:true}
// A native score action additionally requires confirmNativeVoteEffects: true. Missing consent reports skipped and
// remains resumable; guarded success reports applied and is read back from Rating.
POST /v1/libraryImports/anilist/{importId}:cancel
{ remove: true } // 200 {cancelled:true}; false/omitted stops new work while retaining evidence
```

Exact TypeScript request/result types are inferred by `list-import-anilist-routes.ts` from the native composition
in `list-import-anilist.ts`; arbitrary evidence uses unknown JSON values. Owner/current-authority errors use native
problems; malformed uploads return invalid_request and oversized HTTP bodies return 413 without input echoes; foreign ids return not_found,
and review conflicts return conflict. No user-supplied account id or native command key is accepted.

## Web journey

The signed-in page is `/library/import-anilist`, documented in
[personal AniList import](../apps/web/src/library/personal-anilist-import.md). Library navigation adds that entry
beside the Bangumi and MyAnimeList importers; the three sources keep separate controllers. Upload, preview, review,
confirmation, partial results, cancel and evidence removal stay in the mounted visit. JSON, notes and private rows
never enter the URL or persistent browser storage. A replacement upload removes the previous native document first.
Viewer or CSRF replacement retires retry authority. Web binds the generated `libraryImports.anilist` methods when
present and otherwise shows unavailable.

Decision: unmatched target search is display assistance through the existing authenticated subject suggestions; only
the explicit UUID submitted to `review.subjectId` is identity. Apply defaults to preserving local facts
(`replace:false`). Only admitted `status` is selectable in state review. The independent `reviewLabels`/`applyLabels` methods
adopt explicitly selected retained custom membership without changing state/progress choices. Missing `scoreFormat` stays unknown scale and is never
converted into native units. Native score review offers only the standard question, records its current Content
revision/meaning and requires a second effect confirmation. The supported same-logical-home guarded write is
performed by Rating; foreign-home targets remain deferred. Native review owns `commandKey`, `clientId` and `requestedBy`. The generated client snapshot may
omit this surface; missing methods render unavailable rather than a local parser.

Own-upload attestation does not verify an AniList account. Preview does not mutate Library facts. Apply revalidates
identity, access, claim fingerprint and release; a stale unstarted review refreshes, and started original work keeps
its identity. Cancellation stops new admission; already admitted work may finish. Evidence removal removes evidence,
not admitted facts. `complete:false` is resumable, not success for every row.

## Cost

- Operation: `library.anilist.preview`, paged owner read, `library.anilist.review`, `library.anilist` apply
  batches and cancel/remove. Existing Library entry writes remain Commerce-owned.
- Touched neighbourhood: `library.list_import_anilist` on the owner route, unique AniList and separate MyAnimeList
  external claims, current released profile state roles, and the personal Library entry command. Web retains the
  current 20-row page plus N metadata rows; it does not scan other owners or fork the native engine.
- Formula: `preview(B,N) + K page reads + M reviews + Q apply batches + lifecycle + R retries`, with upload bytes
  `B <= 1,048,576`, rows `N <= 200`, page/apply `<= 20`, and `Q <= ceil(M/20)` only for full batches. Preview
  accounts for UTF-8 sizing, JSON parse, structural validation and one bounded source-token walk over `B`, then
  writes the header and `N` rows through the existing owner receipt/event. Each page accounts for its indexed
  20-row read, per-row provider claims and current Subject/Profile/Entry observations; score-review rows add one
  authorized complete Rating review read for current readback. Each review repeats its row, provider-claim and Subject/Profile/Entry reads;
  selecting a score adds the question read, header score-format read and one bounded plan/receipt write.
  Complete Rating observations add question/target admission, at most two native identity-home epoch reads and
  one account snapshot with account admission, at most two exact raw slots and one indexed counted slot. Each apply
  confirmation repeats cancellation/header and row reads; a selected score repeats Content question, provider-claim
  and current target reads before its first attempt, then persists consent and invokes one exact guarded native
  command. Every retry repeats current authorization and native receipt lookup; started commands retain their guard. Existing state commands
  retain their own admission and receipt work. No history discovery or account-wide vote scan is added.
- Caps and encoding: the existing 1 MiB upload, 200-row, 65,536-byte row, 8,192-byte group and SQL 4 MiB row-payload
  limits retain `scoreLexeme`, reviewed operands and consent in the existing rows. Page encoding checks the existing
  result-byte bound after adding score/question details; apply still selects at most 20 bounded outcomes. There is
  no additional evidence store. Upload deletion and account cleanup remain the existing explicit delete and 100-key
  owned-graph phase. The bounded guard carries at most two epochs and a native witness capped at 4,096 bytes.
  Native attempts include repeated question/target/account admission, identity epochs, receipt lookup, raw and
  counted vote locks and witness reads. Successful effects use Content's component/aggregate and receipt work
  through the same reviewed guarded command. No independent measurement writer is introduced.
- Growth check: Web focused test `apps/web/tests/personal-anilist-import.test.tsx` drives 20, 100 and 200
  native-shaped rows through the same controller and asserts call counts, 20-row reads, 20-row writes and the
  retained-byte bound. Native statement/index bounds stay with the Commerce engine; the native review uses exact
  slot keys and the counted-target index. Guarded effects remain bounded by the reviewed exact slots and
  counted-target index.
