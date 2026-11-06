# Personal list import

Decision: bind the generated `KernelClient.libraryImports.vndb` methods from the mounted native route. Eden's
`libraryImports` surface is a function, so Web reads `vndb` by property access rather than an object/`in` check. A row
enters the apply selection only after explicit target and released Library-state review; confirmation applies only the
displayed admitted selection. Keep the visit unavailable if the generated methods are missing.

Web owns a signed-in visit for a person's own VNDB XML export. Commerce owns private upload admission, matching,
row review, and application. The Kernel routes are mounted at `/v1/libraryImports/vndb`, and the native contract is
documented in [Personal VNDB list import](../../../../docs/library-import-vndb.md). The installed `@rezics/client`
surface exposes typed `libraryImports.vndb` methods for preview, bounded page reads, source evidence, state review,
score review, apply, cancel, and deletion. Its released conditional score branch carries the current question, counted
own vote, native units and explicit consent. Native admission decides each effect; an unavailable conditional native
writer remains an unavailable result, never a successful vote. Web never substitutes an aggregate or a source-scale
value for a current own vote.

Decision: display native `fields.score` with its exact raw spelling, retaining `fields.vote` compatibility; keep the
installed generated request types as the boundary for independent state and score commands.

Review inputs and selected apply commands are copied and frozen before sending, so a lost acknowledgement retries
the original operands and key even if the form changes. A new review returns to review before confirmation, and an
authoritative page without a decision removes the previous local selection.

Decision: derive page, review and apply-result types from the installed generated methods, freeze apply operands
when confirmation opens, and withdraw the previous selection as soon as replacement review begins, including refusal.
The generated declarations include state, Progress and score review branches; state commands select the generated
state branch and require state review IDs. Score commands retain their separate score review IDs and exact target,
question revision, selection and consent. Neither review authorizes the other effect. A new explicit match refreshes
the retained native page before score consent, so the target and its counted vote come from the same current native
observation. A failed refresh retries the read and retains the acknowledged review.

Decision: derive score-only aliases from generated fields; source replacement immediately retires private review
authority even if deletion fails, and a credential change permanently retires its visit. Replacement retains only the
upload identifier and exact cleanup/new-preview retry commands until native cleanup succeeds. It cannot reread the
retired source, recover its selection or confirm an older review. A lost cleanup acknowledgement retries the same
deletion before submitting the replacement XML.

Decision: all four import visits share browser-observation retirement, including a same-credential A→B→A round trip,
and remount private state for each observation and locale. Bind AniList through the callable generated client surface;
copy retained-label selections before review, withdraw old confirmation before replacement review, and retry only the
captured command. MAL retains only its bounded uncertain command custody for the returning owner. AniList custom lists
become private labels under their separate owner contract; creating Collections remains a separate action.

The native source accepts only the person's uploaded `vndb-export version="1.0"` XML. It does not claim another
account, fetch provider data, create catalogue subjects or identities, publish reviews, or turn private notes into
public facts. VN and release identifiers remain distinct. Titles can assist display and explicit catalogue search;
they do not select identity. Existing Library facts remain unless the person explicitly reviews and chooses an
admitted state replacement. Web calls the generated client methods directly and adds no local endpoint, parser,
synchronizer, or native implementation.

Native preview maps only an explicitly selected released Library state. VNDB status labels suggest roles but do not
choose state IDs. Source scores retain their original 1–10 scale and do not automatically become local ratings. This
visit shows that source scale beside the released native question and counted own vote. The review explains that 7.3
has no exact match on a native half-step scale, source 0 is invalid, native vote 0 is valid, and clearing is separate.
Uploading a score or choosing a Library state does not grant consent for a public or aggregate vote; existing votes
remain unchanged. Progress requires an explicit existing occurrence or start and released native measures; date
precision, notes, privacy, labels, reviews, release records, unknown XML and unmapped metadata remain private evidence
unless their native owner admits a field. A private note never becomes a public review.

Upload errors must preserve native distinctions. Invalid XML and XML above 2 MiB return HTTP 400. The independently
escaped JSON request wire limit is 12 MiB + 64 bytes and returns HTTP 413; browser `File.size` is not the wire size.
Web must not pre-parse XML or replace native admission. Preview changes no facts. Native pages and row outcomes are
bounded, and cancellation or departure stops new work without rolling back acknowledged rows. An unknown apply must
retain the original command and exact selection for explicit retry. Session or source replacement retires the upload,
preview, late callbacks, and retry authority. Upload contents, notes, and private evidence stay out of URLs, persistent
browser storage, public metadata, and diagnostics.

Score context cost follows the native owner: at most one question and one current-own-vote read per addressed VN
target on a page of eight rows. Each score review repeats that pair plus the bounded owner/upload read, tuple match,
target observation, review receipt and locked decision update. The native owner reserves 32 KiB per possible page row
within the existing 16 MiB evidence cap and keeps baselines and command operands within the 8 MiB decision bound.
An apply admits at most eight total actions and dispatches deliberate score effects only through the released
conditional Content writer; native score admission and current counted readback determine each vote effect. Journey
calls remain one upload plus bounded pages, explicit reviews, selected actions, lifecycle cleanup and exact retries.

MAL remains a separate uploaded format with its existing native prerequisite and journey owner. VNDB has a separate
Commerce producer dependency; neither is a generic multi-provider client parser or synchronizer.

AniList, Bangumi and MAL confirmation pages admit source observations through the installed
`libraryEntries(...).sourceObservations.post` method after the existing import apply. VNDB keeps its own generated
client contract and does not add a second parser or provider synchronizer.

Decision: after apply, an explicit fresh read shows up to eight current Library entries in activity order, with
native status, Progress and counted own-vote facts. Zero, absence and unavailable remain distinct in all layouts and
inspection. Vote rows and question come only from `viewerFacts.state === "current"`; other viewer-fact states omit
votes while keeping disclosed entries and occurrence order. Facts stay in native occurrence order; source scores and
apply receipts cannot fill a missing read.
One FULL page supplies these facts with no per-row query. Normal Library navigation owns continuation; returning
to source review repeats its native page read. Result and Library work links retain the public-safe return landmark
without carrying the private upload address.

Selecting another catalogue target reads that owner's current Entry before replacement consent. The extra cost is
one authenticated point read per selection and one eight-row native page refresh after a changed-target review.

Decision: the mounted review address carries only the native upload UUID and bounded page offset. Reopening reads
that owner's retained upload through the existing native page endpoint, restores acknowledged state outcomes, and
keeps unresolved rows reviewable without uploading again. Previously reviewed targets appear only when the current
native page independently discloses them; source titles never bind identities. Counts distinguish loaded entries
needing review from source rows not yet loaded. Ordinary departure retires local callbacks and preserves the native
upload; explicit Cancel still stops its native admission. An applying state decision can only resume its original
review ID, rather than offer replacement operands. Progress and vote adoption retain their native admission policy.

- Touches: the existing upload, one addressed page and its current target/decision observations; no browser storage.
- Bound: one native page request per reopen or page navigation, at most eight rows; URL input admits a native UUID
  and an integer offset below 5,000. Reopening never calls preview, creates an entry or changes a review.
- Growth check: focused journey tests cover reopen, current refusal, native outcome restoration and exact retry;
  native owner/privacy, seeded browser and physical growth acceptance remain separate checks.

Decision: pin current versus non-current Library vote omission with one focused return test, and keep generated
`progress: null` on the existing reopened state-decision fixtures; add no extra stories.
