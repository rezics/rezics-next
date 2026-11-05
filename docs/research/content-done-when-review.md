50253f81316a8e975d67971fb62ed42db3145c10

# Content completion review

The implementation is substantial, but the stated four-persona HTTP proof is incomplete.
The most important source finding is a board revalidation window in shared item reads.
Several apparent authorization proofs instead reject malformed request bodies. Neither finding
is a test failure observed in this review: no tests, checks, services or check hosts were run.

## Evidence and interpretation

All paths and line numbers below refer to the commit on the first line. The primary contracts are
[the content README](https://github.com/rezics/rezics-next/blob/50253f81316a8e975d67971fb62ed42db3145c10/services/kernel/src/content/README.md),
including its Cost section, and
[the OpenAPI contract](https://github.com/rezics/rezics-next/blob/50253f81316a8e975d67971fb62ed42db3145c10/contracts/openapi.json).
The implementation and tests are primary sources in that same repository, under its
[GNU AGPL version 3 licence](https://github.com/rezics/rezics-next/blob/50253f81316a8e975d67971fb62ed42db3145c10/LICENSE).
The document package has its own
[Apache-2.0 licence](https://github.com/rezics/rezics-next/blob/50253f81316a8e975d67971fb62ed42db3145c10/packages/document/LICENSE).
No external design research or reference clone was needed for this implementation audit.

**Met** means an existing test exercises the real HTTP boundary and asserts the relevant outcome;
it does not mean that test was executed here. **Partial** means some required outcomes have that
evidence. **Missing** means no matching persona-specific HTTP outcome proof was found, rather than
necessarily absent implementation. Each clause below has its own four-persona assessment.

The kernel wrappers import the frozen specifications with real drivers:
`services/kernel/test/content/thread-outcomes.test.ts:8`,
`services/kernel/test/content/disclosure-outcomes.test.ts:6`, and
`services/kernel/test/content/media-outcomes.test.ts:1`.
Their HTTP boundaries are `thread-driver.ts:680`, `disclosure-driver.ts:883`, and
`media-driver.ts:123`, respectively, in the same test directory. Thus specification tests cited
below are integrated tests, not merely the specification's fallback driver.

Database inspections can supplement an HTTP command to prove storage and atomicity. Internal job
triggers are legitimate test controls; jobs need no public human-invocation endpoint. A module-only
test or a refusal manufactured by the driver does not establish an HTTP authorization outcome.
For jobs, the missing reader cases concern HTTP visibility after processing or collection.

The moderator is also an account: refusing edits to somebody else's post does not prove ordinary
creation and revision of their own content. A suspended account's applicable outcome is refusal
with its bearer, including on public reads; anonymous positive controls must remain distinct.
Erasure completion includes physical cleanup, not just acceptance of a logical tombstone or a 202.
Exact erased metadata remains subject to disclosure, so an unauthorized reader should get absence,
not an unconditional tombstone. These are review interpretations, not new product decisions.

## 1. Threads, posts and replies

### One transaction in the thread's partition

- Anonymous reader — **partial**. `specs/content-thread-outcomes.test.ts:122`: "anonymous reads published thread post and reply but cannot create or revise" proves thread-create and revision refusals with unchanged storage; it does not issue anonymous post-create or reply commands.
- Author — **met**. `specs/content-thread-outcomes.test.ts:145`: "author creates first post subsequent post and nested replies on the immutable thread route"; `specs/content-thread-outcomes.test.ts:673`: "parent create grant authorizes before receipt and body with no new-ID grant and one write partition"; `specs/content-thread-outcomes.test.ts:719`: "commands carry session headers and transactional outbox envelopes and injected failure rolls back all effects" prove routing, command effects and rollback through HTTP.
- Moderator — **partial**. `specs/content-thread-outcomes.test.ts:500`: "non-author and moderator cannot revise another author and body authorId cannot spoof identity" proves refusal, but its positive creation/edit control uses the other account, not the moderator. Own thread/post/reply transactions remain unproved for this persona.
- Suspended account — **partial**. `specs/content-thread-outcomes.test.ts:541`: "suspended account authentication denies create and edit with previously valid credentials" proves no-effect thread-create/edit refusal after real suspension. Post-create and reply refusal are not exercised there.

Source agrees with the author's outcome evidence: `services/kernel/src/content/commands.ts:674`,
`:793` and `:865` enter `runCommand` for thread creation, post creation and revision; the revision
and media claim writes use the supplied transaction. The command options select the route's
partition. Replies are posts with a parent, not a separate storage or transaction system.

### Canonical document bytes, bytea and database SHA-256 validation

- Anonymous reader — **met**. `specs/content-thread-outcomes.test.ts:398`: "canonical property order preserves Unicode and authored whitespace and rejects invalid documents" compares the stored canonical bytes and digest with the document serializer and checks the anonymous HTTP read of the created item.
- Author — **met**. That same HTTP creation test proves normalization/canonical storage. `specs/content-thread-outcomes.test.ts:439`: "PostgreSQL independently checks SHA-256 and two MiB body limit with lz4 bytea storage" adds catalogue inspection and deliberately corrupt SQL inserts; `:456`: "API rejects oversized document without partial thread revision receipt claim or outbox writes" proves the API refusal.
- Moderator — **partial**. The bytes/constraint implementation is shared, but `specs/content-thread-outcomes.test.ts:500` only exercises a moderator's denied edit. No moderator-owned canonical create/read round trip was found.
- Suspended account — **partial**. `specs/content-thread-outcomes.test.ts:541` proves creation/edit denial without writes. There is no suspended-bearer current/exact read in that suite proving that stored document bytes cannot escape through the public floor.

`services/kernel/src/content/document.ts:83` normalizes and serializes with `@rezics/document`,
encodes UTF-8 and computes SHA-256. `packages/document/src/index.ts:297` identifies the serializer
as RFC 8785 after model normalization and uses `canonicalize`. The actual revision table is
`services/kernel/db/content/schema.sql:946`: `body` is `bytea`, and the
`revision_body_sha256_matches` constraint at `:964` compares against PostgreSQL `sha256(body)`.
The corrupt-digest probe is direct SQL (`services/kernel/test/content/thread-driver.ts:1060`),
not a claim that HTTP accepts a caller-controlled stored digest.

### New revision rows, SPDX licence and author content references on every item

- Anonymous reader — **met**. `specs/content-thread-outcomes.test.ts:186`: "every thread post and reply preserves its own author declared licence subject references and board placement" checks anonymous current/exact/list views; `:466`: "revision appends immutable bytes and search text while exact old revision stays readable" checks old and new HTTP reads.
- Author — **met**. Those tests inspect separate revision rows and per-item metadata. `specs/content-thread-outcomes.test.ts:248`: "revising metadata preserves old exact revision metadata and body-only edits preserve the new metadata" and `:339`: "invalid subject IDs licences and conflicting item boards reject atomically without semantic dependencies" cover edit defaults and validation failures.
- Moderator — **partial**. The well-formed non-owner edit denial at `specs/content-thread-outcomes.test.ts:500` exists; a moderator's own successful immutable revision and per-item licence/subject/board round trip do not.
- Suspended account — **partial**. The edit denial at `specs/content-thread-outcomes.test.ts:541` exists; suspended current/exact/history reads and post/reply submissions carrying valid metadata are not covered.

`services/kernel/src/content/document.ts:68` validates SPDX expressions. Revision insertion is
in `services/kernel/src/content/commands.ts:521`; the schema's revision mutation guard at
`services/kernel/db/content/schema.sql:364` permits only the constrained erasure transition.
The author tests prove references are authored IDs/placement, without requiring semantic entities
to exist. That independence is part of the content contract, not missing semantic validation.

## 2. Board keyset listing and final disclosure

### Keyset cursor

- Anonymous reader — **met**. `specs/content-disclosure-outcomes.test.ts:113`: "board keyset ordering breaks ties and newer inserts do not repeat prior items" walks pages with equal timestamps, inserts a newer item and checks exhaustion. `services/kernel/test/content/boards-http.test.ts:165`: "keyset ties reverse both keys and newer insertion cannot repeat an existing entry" covers both chronological directions.
- Author — **partial**. `services/kernel/test/content/boards-http.test.ts:180`: "signed cursors bind board normalized query sort verified viewer epoch and trusted expiry clock" obtains an authenticated page and rejects another viewer's cursor, expiry and binding changes. It does not walk the author's pages and assert ordering/no repeats/exhaustion after an insertion.
- Moderator — **partial**. `specs/content-disclosure-outcomes.test.ts:141`: "stale board candidates obey current protected thread Access and missing semantic subjects do not block content" lists a protected item using moderator grants. No corresponding moderator multi-page keyset walk is asserted.
- Suspended account — **missing**. The persona tests at `specs/content-disclosure-outcomes.test.ts:313` submit moderation commands, not board GETs. No suspended-bearer board-page or continuation request proving refusal was found.

### Every returned candidate passes current visibility and container disclosure

- Anonymous reader — **met**. `services/kernel/test/content/boards-http.test.ts:222`: "every returned candidate passes current thread root and board disclosure while projection is paused" covers stale protected/taken-down thread, opening-post and board facts. `specs/content-disclosure-outcomes.test.ts:200`: "missing or unavailable container evidence fails closed despite stale visible candidates" covers absent/unavailable evidence.
- Author — **met**. `services/kernel/test/content/boards-http.test.ts:242`: "current protected positive needs actual grants and scope; named denial overrides author identity" proves actual protected access, its absence and denial precedence. `specs/content-disclosure-outcomes.test.ts:277` also checks the author's list after takedown.
- Moderator — **met**. `specs/content-disclosure-outcomes.test.ts:141` and `:161`: "stale descendants obey protected and taken down parent board at board detail and exact history APIs" exercise moderator-granted list positives alongside concealed anonymous/unrelated lists.
- Suspended account — **missing**. No HTTP board-list refusal for that bearer was found; the source's shared authenticated access formula is not a substitute for the requested outcome test.

The board list does not emit its projection rows directly.
`services/kernel/src/content/boards.ts:419` hydrates candidates through shared disclosure,
`:446` repeats disclosure after query snapshots, and `:470` rechecks the board and Realm before
returning. Hidden-page cursor progress is separately asserted by
`specs/content-disclosure-outcomes.test.ts:215`: "a full hidden candidate page advances to visible candidates without removal counts or reasons".
No board-list path omitting these checks was found.

### Shared item-read finding: board evidence is not part of the final pass

There is a narrower source concern outside the well-defended board-page assembly.
`services/kernel/src/content/reads.ts:333` finishes `readBoard` before preparing thread/post
checks at `:339`. The final thread-partition snapshot begins at `:358`; its chain fingerprint
at `:218` contains thread, posts and revision, not the board. Its checks at `:373` cover those
same rows, and bytes are loaded at `:396`. No second board visibility/security/Access check
occurs after the intervening preparation. The Realm wrapper rechecks association and Realm
access (`services/kernel/src/http/kernel.ts:163`), not board visibility.

Consequently, a board protection/takedown or board-read revocation during that preparation can
leave previously accepted board evidence in a thread/post/exact-revision response. This is a
source-inferred release window, not a reproduced exploit. The affected callers include
`readThread` (`reads.ts:642`), `readPost` (`:666`), subject-thread hydration
(`services/kernel/src/content/subject-threads.ts:176`) and author-item hydration
(`services/kernel/src/content/author-item-reads.ts:237`, `:249`). Lists use the shared reader;
they do not all bypass disclosure outright. Post/history lists also re-read their root
(`reads.ts:765`), which still invokes that same reader.

`services/kernel/test/content/current-erased-read.test.ts:308`: "final native checks reject changed chain signatures and independently anchored board security revisions"
is a module test, and changes the board during **board** preparation (`:319`), so `readBoard`'s
own final snapshot catches it. It does not cover a change during subsequent thread/post
preparation. Add an HTTP barrier regression at that later boundary and close the board-evidence
window in content. This concerns anonymous readers, authors and moderators whose access changes;
the suspended bearer also needs a refusal control.

## 3. Moderation

### Target-partition takedown, taken_down and a new security revision

- Anonymous reader — **partial**. `specs/content-disclosure-outcomes.test.ts:277`: "moderator takedown changes security revision atomically with one target partition outbox effect" proves hidden anonymous reads/lists afterward. No well-formed anonymous HTTP takedown refusal is issued by the denial test at `:313`.
- Author — **met**. `specs/content-disclosure-outcomes.test.ts:313`: "author and suspended callers cannot impersonate moderators and refusals change no state or effects" proves author refusal; `:277` proves subsequent author concealment after a moderator's successful command.
- Moderator — **met**. The `:277` test asserts changed visibility/security revision, one event with the target's partition/transaction, inert replay and projection replay. `:331`: "moderator denial and revocation precede receipt replay and expose no stored response" proves current authority on replay. `services/kernel/test/content/moderation-http.test.ts:279`: "Realm owners and moderators can take down only content in their Realm" supplements the role boundary.
- Suspended account — **met**. The valid-bearer command in `specs/content-disclosure-outcomes.test.ts:313` is refused without changed state/effects.

`services/kernel/src/content/erase-post.ts:282` selects the target route's partition for the
point mutation. `services/kernel/src/content/takedown.sql:7`, `:12` and `:18` set
`taken_down` and increment `security_revision` for board, thread and post respectively.

### Reports as independently anchored records

- Anonymous reader — **met**. `specs/content-disclosure-outcomes.test.ts:378`: "anonymous reports require trusted Turnstile verification and reject caller verified assertions"; `:435`: "anonymous reports use UUIDv4 possession keys with matching digest replay and conflict" prove real admission/replay. `services/kernel/test/content/reports-http.test.ts:500`: "private inspection uses current moderator role, independently anchored reverse fill, and signed bounded pages" proves report anchors and anonymous inspection refusal.
- Author — **met**. `specs/content-disclosure-outcomes.test.ts:343`: "reports persist with their own anchor exact target evidence and idempotency without hiding content" asserts a distinct anchor, exact revision evidence, one partition-local report effect, inert replay and unchanged content; the author cannot privately inspect the record.
- Moderator — **met**. `services/kernel/test/content/standing-roles.test.ts:128`: "active accounts without target grants report on standing content and react to a standing post" includes a moderator's successful post report. The reports HTTP test at `:500` proves authorized inspection/pages and refusal after moderator-role revocation.
- Suspended account — **met**. `services/kernel/test/content/standing-roles.test.ts:128` submits a well-formed suspended report at `:166`, expects 401 and verifies the report count is unchanged.

The anchor is the report's own ID, not a lock or new write in the target's partition:
`services/kernel/src/content/reports.ts:340` selects its partition and `:346` runs its command.
Target reverse indexes remain candidates for authorized private inspection.

### Erasure nulls bodies, marks erased and preserves exact erased references

- Anonymous reader — **met**. `specs/content-disclosure-outcomes.test.ts:501`: "authorized erasure nulls every authored revision and exact references remain erased without substituted bytes" checks unauthorized exact reads remain absent. `services/kernel/test/content/author-post-delete.test.ts:328`: "another account, a moderator without post:erase, anonymous and suspended accounts delete nothing; replay returns the stored outcome" proves anonymous deletion refusal.
- Author — **met**. The `:501` test verifies NULL body/digest, erased availability, exact HTTP tombstones, unrelated-author preservation and no restoration by projection replay. `specs/erasure-operation-outcomes.test.ts:199`: "native completion purges every targeted history and copies while retaining unrelated authors" covers large histories and real worker completion. `services/kernel/test/content/erased-post-cleanup-work.test.ts:376`: "an author's post delete, with the actual kernel worker running, clears every revision body of that post" proves the point-delete cleanup integration.
- Moderator — **met**. `services/kernel/test/content/moderation-http.test.ts:391`: "authorized exact erased revisions survive as tombstones without bytes" reads both exact revisions with explicit moderator grants after takedown, asserting null body/hash and erased availability. `specs/erasure-operation-outcomes.test.ts:199` initiates as `legal`, which maps to the moderator bearer at `services/kernel/test/content/support/erasure-operation-fixtures.ts:236`.
- Suspended account — **partial**. `specs/erasure-operation-outcomes.test.ts:234`: "selection authorId supplies no authority and current account formula guards exact initiator status and replay" and `:262`: "a suspension ends an erasure started before it, and reinstatement does not resume it" prove initiation/status/replay fencing; the author-delete test proves point refusal. A suspended GET of current/exact erased content is still absent.

Logical point deletion deliberately precedes physical cleanup: the HTTP DELETE test at
`services/kernel/test/content/author-post-delete.test.ts:250` initially retains 205 revision
bodies while suppressing them on reads. This is not evidence that NULL cleanup is missing;
the native cleanup test above proves it. `services/kernel/src/content/null-erased-revisions.sql:18`
clears body, digest and search text together and sets revision availability to `erased`.

Replay cannot recover the deleted document:
`specs/content-disclosure-outcomes.test.ts:592`: "durable receipts and outbox do not retain authored text copies"
and `:601`: "authorized create and revision replay cannot recover erased bytes from receipts".
Imported/authored semantic fields are a separate record contract: their retained digest must
not be mistaken for a failure of post-revision digest erasure. The HTTP source-fence tests in
`specs/imported-field-outcomes.test.ts:174`: "fence after preparation hides final disclosure and exact bytes through projection replay and merge"
support that separate disclosure path, not missing post-persona coverage.

## 4. Media objects, API side

### Reservation and IDs routed by their container

- Anonymous reader — **met** for refusal. `specs/content-media-outcomes.test.ts:142`: "anonymous suspended unrelated and missing-container reservations have no effect" actually submits anonymous and suspended reservation requests and verifies no mutation.
- Author — **met**. `specs/content-media-outcomes.test.ts:109`: "parent anchored reservation copies container route and replays one stable row and effect" checks container-derived route/partition/ID/key, trusted time, stable receipt and one effect. `services/kernel/test/content/new-thread-media.test.ts:377`: "author reserves and uploads images for a new thread, then claims them on its opening post" covers reservation before thread creation.
- Moderator — **partial**. Completion refusal is tested at `specs/content-media-outcomes.test.ts:168`, but neither a moderator's permitted own-container reservation nor denied other-container reservation is submitted by `:142`; its persona loop at `:144` excludes the moderator.
- Suspended account — **met** for refusal. `specs/content-media-outcomes.test.ts:142` sends its valid bearer and checks unchanged media, receipts and effects.

The source writes the container route in `services/kernel/src/content/media.ts:411` and `:415`.
Its parent board is now read on an independent native anchor at `media.ts:380`, before release
at `:398`; the README's same-connection warning is obsolete, not a newly found routing defect.

### reserved → uploaded → available or rejected

- Anonymous reader — **met** for its applicable API outcomes. `specs/content-media-outcomes.test.ts:168`: "trusted completion binds actual bytes owner reservation request and container" proves completion refusal; `:485`: "public download allows only sanitized available derivative and original only to uploader" and `:507`: "uploaded and rejected objects are hidden from everyone except uploader" prove public available/pending/rejected decisions.
- Author — **met**. `specs/content-media-outcomes.test.ts:109`, `:168` and `:223`: "completion without declared digest records actual digest and repeated transitions cannot regress" cover reservation/upload and monotonicity. The real image processing tests at `:452` and `:469`: "over-pixel truncated and malformed images reject retaining digest decision but no sample" cover both terminal branches, including stored digest/decision and deleted rejected samples.
- Moderator — **met** for its applicable API outcomes. The completion denial at `:168` and the moderator download loops at `:490` and `:512` prove that moderator status supplies no uploader identity or original/pending/rejected access.
- Suspended account — **partial**. Reservation and well-formed completion refusals exist at `:142` and `:168`. Neither HTTP download loop at `:490` or `:512` includes suspended credentials, so public available and nonpublic states lack that refusal proof.

Completion is an uploader BFF bearer, not a separate trusted Worker principal:
`specs/content-media-outcomes.test.ts:194`: "media specification uses uploader BFF tokens instead of a separate Worker actor".
`services/kernel/test/content/media-http.test.ts:276`: "uploader reservation preflight and BFF completion use verified subject and exclusive website scope"
also sends forged fields to the actual closed HTTP schema and asserts 400. The media driver's
third `complete` argument is ignored (`services/kernel/test/content/media-driver.ts:308`), so
that argument alone is not proof that spoofed fields reached the product.

### Claim in the referencing command's partition

- Anonymous reader — **partial**. `specs/content-media-outcomes.test.ts:296`: "another authorized uploader and moderator cannot claim or impersonate owner" includes anonymous, but sends an unknown `uploaderId` field on every reference. Add a valid-schema post and revision refusal before claiming semantic ownership coverage.
- Author — **partial**. `specs/content-media-outcomes.test.ts:259`: "post and revision commands claim inside their own partition transaction" and `:276`: "failed post and revision roll back claims receipts and all effects" prove the core command/claim transaction. New-thread claims also have HTTP evidence above. However `:304`: "reserved uploaded rejected erased and forged available references are denied" always supplies forbidden `state`/`claimedAt` fields; it does not isolate each stored-state refusal with a valid body. The valid mixed-list test at `:326` covers uploaded/not-ready, not every named state.
- Moderator — **partial**. The `:296` refusal has the same malformed-body confounder, and no positive moderator-owned claim is established. Its inability to edit somebody else's post is not a media-uploader ownership check.
- Suspended account — **partial**. It appears in the malformed reference loop at `:299`; there is no equivalent valid-schema post/revision reference request proving authenticated refusal and unchanged claim state.

`services/kernel/src/content/media.ts:626` takes the existing command transaction, validates
partition/actor/command authorization and container/item/revision routing, then executes the
claim with uploader identity at `:672`. The tests' gap is semantic isolation and persona proof,
not evidence of a second claim transaction. The driver spreads `untrusted` into the HTTP body
at `services/kernel/test/content/media-driver.ts:202`; unlike `complete`, these fields do arrive.
The separate new-thread test at `services/kernel/test/content/new-thread-media.test.ts:424`:
"invalid ownership, reservation key, availability, and anonymous requests do not create or claim content"
already sends well-formed opening-post failures and an unrelated account's new-thread reservation.
The remaining claim gap is specifically the existing post/revision paths and moderator participation;
the reservation-title gap concerns its omitted existing-container case, not all unrelated requests.

### The 24-hour collection job

- Anonymous reader — **missing** for post-collection HTTP visibility. The collector test at `specs/content-media-outcomes.test.ts:343` inspects rows/storage; it does not request an old or retained object anonymously afterward.
- Author — **met** for collection behavior with HTTP-created and claimed media. `specs/content-media-outcomes.test.ts:343`: "collection removes exactly 24-hour unclaimed objects but preserves younger and claimed objects" uses real reserve/complete/reference API commands before the internal collection trigger. `:368`: "storage deletion failure preserves retryability and a rerun removes every key" and `:408`: "claim racing collection cannot commit a reference to deleted available bytes" add failure/race outcomes.
- Moderator — **missing** for post-collection HTTP visibility. The same test at `:343` has no moderator GET/download assertion for removed or retained media.
- Suspended account — **missing** for post-collection HTTP visibility. No suspended GET/download of removed or retained media is issued by that collection test.

The schedule itself is implemented and tested: `services/kernel/src/content/work.ts:299`
registers `0 * * * *`, and `services/kernel/test/content/work.test.ts:641`:
"native persistent hourly collection respects exact24h, claims, partition and pending fences after restart"
triggers it and checks the exact boundary, partitions, claims, deletion failure and restart.
Its fixtures directly insert uploaded rows (`work.test.ts:268`), so this is strong native-work
evidence but not the missing personas' HTTP aftermath. Do not expose collection as a human API
to close this gap.

### Sharp width ladder

- Anonymous reader — **partial**. `specs/content-media-outcomes.test.ts:485` proves HTTP access to a real sanitized derivative from the tiny fixture. The full-width ladder test at `:452` inspects derivatives internally, rather than authorizing each generated width anonymously through HTTP.
- Author — **met**. `specs/content-media-outcomes.test.ts:452`: "real Sharp produces every AVIF and WebP ladder width without upscaling" starts with HTTP reservation/completion and decodes all twelve outputs at widths 320, 640, 960, 1280, 1920 and 2560. `:457`: "EXIF orientation determines ladder bounds and GPS EXIF XMP are stripped" and `:463`: "tiny image receives sanitized source-width outputs in both formats" prove orientation, metadata removal and no enlargement.
- Moderator — **partial**. The moderator participates in the tiny-image HTTP download test at `:490`, but not an HTTP decision for each full-ladder output or an own-upload processing case.
- Suspended account — **missing** for image-output HTTP refusal. The download persona loop at `specs/content-media-outcomes.test.ts:490` excludes it.

`services/kernel/test/content/work.test.ts:480`:
"actual DBOS worker consumes prelaunch image work, recovers and deduplicates real Sharp effects"
proves native dispatch/restart/deduplication with a 48-pixel source and two variants. It does
not itself prove the complete width ladder or any HTTP persona: its uploaded seed is direct
SQL. Together with the HTTP-backed ladder test it proves existing implementation, not an
absent image worker. The driver returns synthetic job refusal without calling the product
at `services/kernel/test/content/media-driver.ts:219` and `:333`; the title
`specs/content-media-outcomes.test.ts:247`: "illegal processing and unauthorized jobs cannot change state"
must not be cited as HTTP job authorization evidence.

## README and test claims requiring care

- `services/kernel/src/content/README.md:160` claims current board disclosure for author-item reads; Cost's thread/post/exact-read rows at `:484`–`:486` describe final chain checks. No HTTP test proves board revalidation after subsequent item preparation; the shared-reader window above limits that claim.
- `services/kernel/src/content/README.md:269`–`:276` describes the complete ladder and sanitized variants. The HTTP-backed author's processing test proves the transformation; per-width HTTP disclosure for anonymous/moderator and suspended refusal remain unproved. This is a coverage gap, not missing Sharp code.
- Cost at `services/kernel/src/content/README.md:462` still calls public board disclosure unfinished; `:479` calls report storage/effect APIs stubs; `:570` calls reports, standalone media erasure and download decisions unfinished. These statements contradict integrated code and HTTP evidence, including `reports-http.test.ts:500`, `media-http.test.ts:276` and `platform-staff-http.test.ts:163`: "Global staff grants authorize unmoderated content through HTTP and revocation restores ordinary denials". Reconcile Cost with current operations rather than creating implementations that already exist.
- `services/kernel/src/content/README.md:567` retains a same-connection media-board assumption contradicted by the independent board snapshot in `services/kernel/src/content/media.ts:380`. It should not be treated as current architecture evidence.
- The reservation test's title at `specs/content-media-outcomes.test.ts:142` names an unrelated account; its loop at `:144` tests only anonymous and suspended. The unrelated-account reservation claim is not asserted there.
- The ownership title at `specs/content-media-outcomes.test.ts:296` and stored-state title at `:304` exceed their assertions because every request carries schema-invalid extras. Rejection and unchanged state do not identify the guard that refused it. Add new valid-body tests, preserving the frozen tests.
- The unauthorized-job title at `specs/content-media-outcomes.test.ts:247` includes refusals returned by the harness's capability map. It proves that harness boundary, not a product HTTP action. Internal jobs need native-work evidence and API-visible outcomes, not invented public actions.
- `specs/erasure-operation-outcomes.test.ts:148` and `specs/imported-field-outcomes.test.ts:65` still say "remain red without implementation" in their titles. The wrappers now bind real implementations; those historical titles are not evidence of a present failure. No runtime result is asserted by this review.

The common established pattern inside this repository is a partition-local command with receipt
and outbox, candidate-only projections, and authoritative disclosure before releasing bytes.
The best completion work preserves those mechanisms and fills the specific semantic/HTTP gaps;
it does not replace them or copy another implementation. Growth tests supplement this proof:
the thread/disclosure wrappers' three-scale checks, the media wrapper's native PostgreSQL plans,
the erasure outcome growth test and `work.test.ts` exercise distinct bounded/native properties.
Their presence is not a four-persona HTTP proof and no performance pass was measured here.

Uploads/downloads through the site Worker remain owned by the web Goal and are excluded.
Semantic presentation, accounts and Access may supply prerequisites, but this review establishes
no defect requiring a change in their paths. All suggested fixes/tests below belong to content.
Only this report is changed; no acceptance test, frozen file or implementation is edited.

## Gaps in priority order

1. Final board revalidation during shared item disclosure — anonymous reader, author, moderator, with suspended refusal control; `services/kernel/src/content/reads.ts:333`, `:358`, `:373`, `:396` retain early board evidence; smallest content task: add an HTTP barrier regression that changes the independently routed board after board disclosure but during item preparation, then revalidate board security/Access before releasing item bytes and cover inherited list callers.
2. Valid-schema media ownership and stored-state claim proofs — author, moderator, anonymous reader, suspended account, plus unrelated uploader; `specs/content-media-outcomes.test.ts:296`–`:320` sends forbidden fields on every attempt; smallest content task: add separate well-formed post/revision claims with an otherwise authorized wrong uploader, and each reserved/uploaded/rejected/erased state, asserting refusals leave claims, revisions, receipts and outbox unchanged; keep spoof cases separate.
3. Moderator's ordinary authorship — moderator; `specs/content-thread-outcomes.test.ts:500` has only its denied non-owner edit; smallest content task: add an HTTP own-thread/post/nested-reply/revision round trip with canonical byte/digest inspection, immutable old revisions, per-item SPDX/subject/board metadata and partition-local effects/rollback.
4. Suspended read and list refusal — suspended account; `specs/content-thread-outcomes.test.ts:541`, `specs/content-disclosure-outcomes.test.ts:313` and media loops at `specs/content-media-outcomes.test.ts:490`, `:512` do not cover its GETs; smallest content task: add valid suspended-bearer current/exact/history/board-page/media reservation/download requests across available, hidden and erased states, with anonymous positive controls and no leaked bytes, keys or stored responses.
5. Authenticated keyset traversal — author and moderator; `services/kernel/test/content/boards-http.test.ts:204` checks an authenticated first page while `specs/content-disclosure-outcomes.test.ts:141` checks a moderator list, not continuation ordering; smallest content task: run tie/insertion/no-repeat/exhaustion walks through each persona's own cursor, including current grant/denial changes between pages.
6. Remaining well-formed write refusals — anonymous reader and suspended account for post/reply creation, anonymous reader for takedown; `specs/content-thread-outcomes.test.ts:122`, `:541` and `specs/content-disclosure-outcomes.test.ts:313` omit those requests; smallest content task: add real HTTP requests against existing visible parents and assert unchanged content, claims, receipts and outbox.
7. Media reservation/claim participation and reservation title coverage — moderator and unrelated account for an existing container; `specs/content-media-outcomes.test.ts:144` omits both from the advertised reservation loop and `:296` has no own-media moderator positive; smallest content task: add HTTP own-container reservation/route/replay and own-media claim positives, and existing-container other-uploader negatives; retain the already covered unrelated new-thread reservation refusal.
8. Collection's HTTP aftermath — anonymous reader, moderator and suspended account, with author GET control; `specs/content-media-outcomes.test.ts:343` and `services/kernel/test/content/work.test.ts:641` finish with internal/storage assertions; smallest content task: use HTTP-created old, just-younger and claimed objects, trigger the existing collector, then assert API absence or continued permitted access/refusal for each persona at the exact 24-hour boundary and after retry.
9. Complete ladder's HTTP disclosure — anonymous reader, moderator and suspended account; `specs/content-media-outcomes.test.ts:452` inspects all outputs internally while `:485` downloads only a tiny-image derivative; smallest content task: request authorization for every produced AVIF/WebP width using anonymous/moderator bearers and the uploader control, and require suspended refusal without key/digest disclosure; reuse real Sharp output, not seeded variants.
10. Current contract/evidence inventory — all personas; stale Cost statements at `services/kernel/src/content/README.md:462`, `:479`, `:567`, `:570` and the overclaimed tests above obscure what exists; smallest content task: update the owning content README after adoption with current paths, actual Cost evidence and remaining limitations, and add new tests for overclaimed assertions without editing frozen tests. This report is evidence, not the adopted contract.
