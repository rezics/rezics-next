# Subject page composition

Decision: Account and Agent list assembly uses the consumer-owned `AccountProfilePort`, installed by
`PublicProfilePage` through `AccountPageApplication` and the concrete Accounts `page-binding` adapter. The application
owns profile selection, planned response admission, window composition and the supported contribution
watch/reaction/reply/report/lifetime capabilities; Accounts, Threads and Report retain native reader, receipt,
engine and cursor/focus lifetimes. Ordinary routes bind live adapters. The [binding contract](../../accounts/public-profile/README.md) describes the seam.
`page-model.ts` and `overview-section.tsx` keep Agent reading and Account assembly out of the Subject renderer's value
dependency graph. The native outcomes, publication gates and work bounds are unchanged.

Decision: Search owns candidate-reading and page-visit identity behind `PageVisitHost`; Web installs the host at the
route root with session-observation and address-lease adapters, while each reader retains its native disclosure,
continuation, receipt and work-budget rules.

`candidate-reading-application.ts` owns visit identity, retirement and accepted-result binding to candidate, locale and
address. `visit-host-port.ts` defines its session, browser-observation, exposure-observation and address-lease
capabilities. `subject/page-visit-binding.tsx` installs the Web adapters at `routes/__root.tsx`; legacy Web readers
still enter through the subject compatibility wrapper until their own Goal moves them. Graph, producer history,
quotation and source-concept readers use the Search application directly, and keep their existing native outcome,
disclosure, continuation, return-receipt and work-budget behavior. Their return grammar stays page-owned; canonical
Subject base addresses use the already public `subject/load-subject` entry, and language labels use the local
`locale-presentation.ts` helper.

## Session preparation and retained readings

Decision: session preparation preserves an admitted public body; private controls bind to the first matching
prepared `browserObservation` and retire on later identity, credential, disclosure, source, descriptor, Context or
locale replacement. A new source establishes a new reading. Equal question/cache successes preserve rating selection;
actual source replacement retires it. Public DTOs may describe visible controls, but only the current prepared
observation and native admission can make a private action current. Public Person credit inspect reads that prepared
session cache and does not start another session fetch.

## Composition render identity

Decision: `CompositionRender` keeps its Puck render config while its registry has equal entries and its definitions, root and document root are unchanged, and each slot callback is invoked for its content, so composed controls stay mounted through sibling and route re-renders while a new document or registry entry still remounts them.

## Platform Home

The anonymous catalogue reads the active native `/` composition once and renders its supplied `TypeList` windows with the existing Search owner, limits and total read budget. A 404 is missing, rejected native requests remain rejected, and 5xx or fetch dependency failures remain unavailable with deliberate reload. The checked-in platform profile continues to declare the four intended populations; changing its source does not activate it. The publisher owns active profile delivery.

Decision: `ReactionSummary` renders public totals from the planned reactions leaf and the recorded native counts page. Each total is one text node (`Like 42`) so the visible label and count stay together. Viewer reaction stays on the header actions slot. A mismatched producer, malformed counts or Retry-After wait makes that leaf unavailable without hiding supported siblings. Mixed configured TypeList recovery uses the same declared slots: a waiting books leaf keeps its own hint while recorded recipes and reactions stay in document order. Zone TypeList uses the same configured Search admission as the catalogue TypeList. The renderer reads `OverviewContext` from the context leaf and admits kinds locally so it does not import overview or threads.

Decision: the fewest Web tests pin those states plus TypeList raw-limit admission. Members keep recorded native duplicates. No extra page stories.

## Work tag reading

Decision: show at most 12 source-order tag associations per local page, count only labelled tags disclosed in the retained Subject reading, open the original Concept target, and gate each over-threshold association as a whole.

The Subject header reuses the released facet labels and `SourceTagWeight` for each admitted assertion. “Why this tag applies” opens the existing Concept filter with the exact property, that statement's spoiler qualifiers and the original work return; the Concept visit remains the owner of source evidence and `FactInspectionEntry`. Equal Concept targets remain separate assertions. Missing target labels stay unavailable and never fall back to identifiers.

The page has no second Subject or Concept reader. Its next/previous controls only move through the already retained Subject response; native unavailable and refused reads remain owned by the page reader and are never shown as an empty tag set. Hidden associations do not contribute labels or counts until their own `SpoilerGate` opens.

For the existing fact admission of at most 1 MiB UTF-8, 4,096 statements and 32 qualifiers, reference groups and parts per group, projection is O(B + T + Q), where B is admitted response bytes, T admitted tag statements and Q qualifier/reference parts. The view retains a single page of P = 12 rows; it builds Concept links and validates source weight only for that visible page, at O(P + Qₚ) additional work. No hidden history, per-tag read, or automatic load-all is introduced.

## Manga reading

Decision: present only released Manga part semantics through the ordinary Subject and existing contents/edition views; use generic facts/relations when a specialized chapter structure is unsupported. No new chapter type/property/profile is adopted by this interface.

The Manga reader is a public projection of the current composed Subject page. It groups admitted membership and edition rows by their native relation property, direction and statement identity, keeps source order, and links to exact disclosed subject IDs. Partial dates stay with the existing generic Subject fact and heading readers; relation summaries do not supply dates. The existing contents/edition views own their bounded windows and continuation. A current `via` address preserves the same localized subject, context, view and opaque window on a deliberate part visit. Public relation counts remain separate from private progress, copy ownership and parent state.

The existing generic facts, contents, editions and Relations readers remain reachable when specialized chapter configuration is unavailable. The reader does not infer a parent from a title or a row position, request each target, or read private session state for public presentation. Existing Manga correction and configured Library controls keep their owners.

Subject templates place review and discussion regions through the shared community reader. The native page owns
identity, order, continuation and disclosure. Web requires its Subject/place/kind context to match the exact
`planReads` descriptor before showing cards. Global and Realm remain independent native places, including on empty
pages. A missing or mismatched context withholds the dependent region. Realm membership remains with Accounts,
identity/context with Semantic, and disclosure/action authority with Content.

The installed `GET /v1/subjects/:id/threads` operation remains public `subject:read`.
`SubjectThreadsResponseSchema` and `listSubjectThreads` add required current `context` and `reactionsAsOf`, while the
installed generated declaration still exposes ordinary ThreadView rows. The retained producer also projects
`reviewContext` through `feed-context.ts`: its question revision and scale are **current**, not a historical scale
snapshot. Neither that context nor the current question, personal vote or selected population supplies historical
provenance or action authority. See Content's [Subject threads contract](../../../../../services/kernel/src/content/README.md#subject-threads).

Decision: render Content's current card disclosures independently of historical citation; retain exact/lower-bound
public activity and at most two opening-post-owned images, and never fill withheld native authors from the public author batch.

The default composition consumes the installed `card.state`, `authors`, `presentation`, `media`, `comments` and
`currentness` fields from the existing generated Subject threads method. Native cards use their disclosed thread
author, document language and spoiler gate. Their media container is the exact opening post, not the thread;
images must also be declared and referenced by that opening document. Public comment coverage keeps its exact or
lower-bound count, including zero with a null activity time. Missing coverage displays no guessed count or date.
No native card starts author enrichment. The shared author batch remains available for ordinary rows; a native-card
page therefore makes zero `/v1/accounts` calls, and one ordinary-row region still makes exactly one.

The installed card does not supply historical scale/lifecycle/original-target provenance. Its reviewContext remains
current; a review's recorded citation therefore stays explicitly unavailable unless the separate historical extension
below is present. The default route does not manufacture that extension. Recorded `{questionId,units,revision}` stays
on the opening post and is shown as units with historical question metadata unavailable. Reply/reaction/watch retain
their existing owners; admitted overflow mounts `PostActions` with the route's existing verification configuration
and the original canonical thread target. Without configuration it links to that thread's owner. Opening-post
revision replacement retires the card even if its normalized advice is unchanged. Create-thread binds only native
`entry.current` Board advice from this page; a readable card's `boardId` is never a creation target.
Native `entry` uses the same `COMMUNITY_CARD_BYTES` bound as the historical card seam.

## Consumer card seam

`subject-community-card.ts` retains the minimal historical Web interface pending Content's historical provenance response. This is
not a generated declaration or a claim that the installed producer supplies it. Each optional `thread.card` has
`version: 1`, the exact `threadId` and first-post `postRevisionId`, and these closed fields:

- `citation` is `{state:'withheld'}`, `{state:'absent'}`, or `{state:'available',postRevisionId,recorded,question,originalTarget}`.
  `recorded` must exactly match the native first post's `{questionId,units,revision}`, including zero. `question`
  carries the historical `{id,revision,label,scale:{min,max,displayStep}}` and independently disclosed lifecycle
  `{state:'active'|'retired',revision}`. The units must belong to that historical scale. `originalTarget` carries
  `{id,label,mergedInto}` with nullable label and merge destination. A merge never replaces the original id.
  Only an explicit native null citation permits `absent`; withheld provenance contains no partial facts.
- `activity` is null or native `{replyCount,lastActivityAt}`. Zero replies remain zero; creation time and loaded
  window length cannot stand in for activity.
- `media` contains at most two `{alt,image}` entries in native order. Each image uses the existing
  `DocumentImagePresentation` shape and must name this thread's container and an image actually referenced and
  declared by the exact first-post document. The renderer uses `NativeDocumentImage`, including its failure,
  retry, credits and inspection. Web performs no media hydration. `RevisionProvenance` owns citation disclosure;
  the surrounding card shows its historical scale, question revision, retirement and original-target provenance.

Ordinary rows remain readable with bounded text. Null citation is unscored; a recorded citation without the above
provenance is unavailable. Reaction counts require a non-null watermark from the same native page. Counts retain
seven native kinds without a local total; omitted kinds inside an admitted object are zero. Omitted counts or
viewer slot remain unavailable; explicit null viewer reaction means no selection. Public projection removes viewer
slots. Reply, existing-thread post creation, reaction, watch and overflow controls require current native advice bound
to the exact thread and first-post revision; readable cards and Board destinations do not confer it. A new-thread composer stays unavailable until this page's native `entry` is `current` with create-thread advice.
Shared Board and command owners remain unchanged.

Every completed read gets one fresh local observation UUID, including same-URL replacement. Retirement observes
existing session/CSRF and exposure caches without reads. Account, successful session observation, exposure,
provider, locale, descriptor, same-source watermark or card-presentation replacement removes the entire card
subtree until a fresh native observation arrives. This includes citations, media inspection/retry and activity.
Away/back epochs do not revive a retired source. Each cleanup retires only its captured visit. A focused removed
card returns focus to the stable region heading; replacing the source remounts its cards and native disclosures.

## Cost

- **Session:** Retirement observes the existing session/CSRF and exposure cache owners; this slice starts zero
  session or exposure reads. A current card action carries only the actor identity needed by its existing command
  owner. Credentials remain owned by the existing session/command boundary.
- **Page:** One planned native page per placed region, at most five rows on overview or twenty in a full view,
  plus at most one shared public author batch for ordinary rows per composition page. Context, reaction freshness and current watch baseline
  come from that same page. A full view mounts at most twenty reaction controls and twenty watch controls. A sparse
  page retains its native continuation without refill; explicit retry repeats the same opaque cursor. Projection
  and cache subscriptions add zero session, media, activity, question, vote or per-card requests.
- **Commands:** Each deliberate reaction change uses the existing exact thread target and one idempotency key; an
  unresolved change retains one intent and retries that same key. A watch toggle uses the one desired-state
  PUT/DELETE currently admitted by the page; an uncertain write retries the same desired state. A confirmed watch
  transition spends that page's advice, so the inverse control waits for a fresh native page. Each card retains at most one pending reaction and one pending
  watch command, so a twenty-row region retains at most twenty of each. Reply opens the exact thread's existing
  `post.create` composer, and overflow opens that thread's existing report owner; neither adds a command here.
- **Readbacks:** Reactions use the page's counts/viewer slot without a mount read and perform at most one exact
  thread read after a successful write or one deliberate recovery check. At most twenty current reaction snapshots
  are retained, each with at most seven counters, one viewer slot and one freshness pair (140 counters total).
  Watch uses the page's current state without a mount GET, performs zero automatic reads after a write, and performs
  one GET for each deliberate Check again; at most twenty one-boolean watch states are retained. No read history or
  action polling is kept. A full region can have at most twenty reaction reads and twenty watch reads in flight.
- **Bound:** Admission limits each source row to 2 MiB + 64 KiB of serialized UTF-8 JSON, the whole page to
  `limit * rowBytes + 64 KiB` (43,319,296 bytes at twenty), each closed extension to 32 KiB and each normalized
  thread to 48 KiB. These are enforced admission limits, not promises about unaccepted transport input.
  Titles, historical labels and image alt text have at most 4096 UTF-16 units each; excerpts 280; licences 128;
  language tags 64; timestamps 40; source/freshness decimal positions 20. Realm titles admit at most 2048 UTF-16
  units and 4096 UTF-8 bytes. Each image has at most twelve distinct format/width derivatives, dimensions 1–65536,
  placeholder strings 128/64 units, and four unique credit obligations; each credit text is at most 1024 units
  and its licence at most 80 ASCII characters. There are at most forty images, 480 derivative entries and 140
  reaction counters per full region. Native ids are UUIDs; question/vote/lifecycle revisions are positive int32,
  scale units 0–4096, and counts nonnegative safe integers. One card's inspected action advice is at most 512 KiB
  of JSON, with at most two references and 256 operations per reference; action and operation-id strings are each
  at most 64 UTF-16 units. A twenty-row page admits at most 10 MiB of inspected advice. Web retains only four
  control states, at most 128 JSON bytes per row or 2560 bytes per full region; it never retains the operation list.
  Cursors are opaque, nonempty and at most 4096 UTF-16 units (at most 12,288 UTF-8 or 24,576 escaped JSON bytes).
  Native media admission inspects at most 32 supplied images within 32 KiB, retaining the first two in native order. Native authors retain only display name/handle (each ≤4096 units), presentation language ≤256 units, and one public count/source pair. One local observation UUID uses 36 ASCII characters. These maxima compose under the stricter JSON byte caps.
- **Retained memory:** One raw accepted native window (at most 43,319,296 JSON bytes), one normalized window
  (at most twenty × 48 KiB), one context/cursor, at most twenty distinct author keys, and at most 2560 JSON bytes
  of normalized action advice per region. Up to twenty pending reaction intents and twenty pending watch commands
  are retained, one of each per card; no command history or automatic retry queue is retained. Composition
  regions share the identity batch. Retirement retains no prior card subtree, cursor history or source registry.
  Admission temporarily materializes one page JSON string and UTF-8 buffer, then one source-row/card/normalized-row
  serialization at a time; each is bounded as above. Parsed source documents and JS object/string overhead remain
  real additional memory, not a claimed exact heap-byte measurement. The original composition response remains
  with its page owner. Rejected transport input is outside these accepted-window bounds.
- **Growth:** Projection and indexing are O(N + admitted bytes), N≤20; rendering, source comparison and retained
  card state have the same bound. The 1/5/20-row consumer checks retain one output per supplied row, with no
  accumulation, per-card hydration, reorder, refill or local totals. Native raw80 and independent 256/1024/4096
  growth evidence remains with Content and is not established by these fixtures. Action inspection is bounded by
  512 KiB per card × twenty rows; command and readback concurrency is bounded by one reaction and one watch owner
  per row, with no automatic retry or polling.

The connected Current Reading stories cover anonymous/member/writer, admitted actions with truthful recovery, zero,
changed current scale, retired/merged original target and concealed context through the native client and this seam.
Browser review at 390px/1280px, light/dark, keyboard open/action/return remains for the controller's browser check. All eight
locales share the same layout and localized historical provenance labels; continuation/retry, disclosure and media
controls retain 44px targets and wrapping. See [Subject pages](../../../../../docs/subject-pages.md#overview).

## Recording reader

The ordinary Subject overview may mount the Recording reader only for `schema:MusicRecording`. It reads the exact
immutable release named by the current Subject read, and uses only that type's admitted properties and each
relation property's admitted qualifiers. Property labels and direction come from that release; relation targets
remain the exact disclosed Subject ids from the current read. Credit-group properties keep each statement's own
role, time, order and other admitted qualifier values. Work, album and release identities stay separate Subject
destinations.

If the exact release has no Recording definition, the overview gives an unsupported state and keeps Details and the
existing facts/correction controls available. A missing or mismatched release gives an unavailable state. The reader
does not infer predicates or hydrate private or historical evidence. A bounded association page links to the ordinary
Relations view, and a validated single-hop `via` address provides the return to the source page.

### Cost

- **Reads:** One installed `definitions.releases` operation for the Subject read's exact immutable release. The
  existing Subject page read supplies facts, qualified values and disclosed relation targets. There are zero extra
  Subject, performer, work, album, release, provider, playback or per-field reads.
- **Rendering:** The reader visits only the current Subject statements whose property ids appear on the admitted
  Recording type. It retains no source registry, private state, historical snapshot or local continuation. An
  incomplete native relation window links to the ordinary Relations view without refill or cursor rewriting.
- **Return:** Only the route's validated same-locale single-hop `via` address is retained in page props and propagated
  to Recording relation destinations and finite-view links. Invalid, nested or cross-locale addresses are omitted by
  the existing return-address validator.

## Work tag evidence and visits

Decision: keep a 24-assertion overview preview, use Details for the rest of the supplied reading and the existing
property-selected Relations reader for native continuation; never display a hidden or inferred total.

The Work overview mounts the tag reader from the admitted Subject read and its exact released definitions. A
missing release is unavailable, independently of an admitted page with no readable tags. Non-work types do not
acquire a tag model. The reader performs no native calls, per-tag hydration, result crawling or writes.

Tags retain the original classification property, assertion id and Concept Subject id. A redirect may inform the
existing destination reader but never substitutes the assertion's original operand. Equal labels, repeated target
Subjects and assertions under different properties remain separate rows in supplied order. When the native page
has already selected current relation slots, the preview does not re-rank that bounded window. Otherwise it uses
the existing preferred/normal selection rule.

Spoiler admission runs before reading labels, weight evidence, selected rows or preview length. Every supplied
spoiler qualifier must have the native dimensionless exact level; unknown or malformed evidence never
becomes a level-zero assertion. The page shows only admitted assertions. Empty means no admitted assertions in
this reading at the current preference, not an assertion that the complete work has no tags. No native relation
count is used as a tag total, continuation indicator or hidden-evidence count.

`rezics:sourceTagWeight` plus `rezics:sourceTagWeightMetric=vndbTagsRating` has the released VNDB `(0,3]`, unit `1`
meaning from [Semantic](../../../../../services/kernel/src/semantic/README.md#released-source-weighted-classification-tags).
The exact signed decimal token is preserved. No rounding, normalization, sort score, confidence or REZICS rating
is derived. Absent weight, unsupported semantics and unreadable supplied evidence have separate presentations.
The independently reachable evidence control uses the existing StatementSummary, value and qualifier readers,
including the assertion's own references and released labels with their fallback language. The raw supported
meaning comes from the immutable release; the preview does not publish or map provider evidence.
Decision: tag evidence summaries consume `StatementSummary` through the catalogue-owned `StatementReadingPort`;
Subject composition binds live `CandidateValue` and the summary does not import the statement editor view.

Native `schema:genre` and `schema:keywords` associations do not imply a weight exists. VNDB dump votes and Bangumi
public metadata are not converted to the Kana aggregate by this UI. The producer's live preparation retains its
owner; a missing weight remains explicitly absent on the public page.

Tag navigation uses the Concept host's existing `role`, `tagQualifiers` and `spoiler` fields. Only native supported
spoiler equality qualifiers are carried; numeric weight evidence is not converted to a new filter language. The
Concept reader continues to own scheme selection, result filters, current membership rechecks and page boundaries.
The return address is a validated Subject visit address with its original locale, Realm, view, node and opaque
cursor. Its bounded `#work-tags` locator names only an admitted assertion/property, focus target and preference;
it is neither identity authority nor a disclosure grant. Unsupported or lost source addresses restart safely.
Graph-only classification return validation remains unchanged.

A return restores the browse or evidence control only when that assertion is still admitted at the same spoiler
preference; otherwise the tag heading is the safe restart. It never opens stale evidence automatically. One
return locator is consumed once per address visit; an unchanged URL cannot replay focus after a preference or
equal-source replacement. Classification continuation uses released Concept-targeting facets, keeping credit
and series membership readers with their existing owners. One
explicit evidence disclosure is retained at a time. A successful source replacement, even an equal one, resets it.
Preference, address, account and credential replacement retire it through the existing catalogue/browser lifetime;
A/B/A cannot revive a previous callback. Source and evidence reads remain separate from command owners.

### Cost and presentation

The projection visits the supplied facet properties and their already bounded assertion arrays once. It retains
at most 24 rendered cards and one opened evidence panel; it starts zero reads and retains zero result windows or
command intents. Remaining evidence uses Details, and property continuation uses the mounted Relations reader's
native page and opaque cursor without refilling sparse pages or implying completeness. The overview keeps exact
values, weight-state text and spoiler evidence visible beside separate browse and inspect controls. Actions wrap,
have at least 44px targets and retain focus outlines in light and dark themes. All eight UI locales include these
states; definition/Subject labels retain their native fallback language.

## Work relation region returns

Decision: Subject return parsing, bounds and URL composition live in the non-rendering `subject-visit-return.ts`
leaf, consumed by the application facade and `subject-visit-navigation.ts`. The existing composition installer
binds its narrow Semantic navigation delegates through `subject-render-binding.ts`.
The Subject leaf remains the sole navigation implementation; retain the saved Search export details through that
leaf, without a module-global navigation facade that ordinary URL helpers require to be initialized first.

Decision: retain the supported same-work Subject address and a single-hop opener, with stream/node and separate
browse/evidence focus; a replaced or no-longer-admitted reading offers an explicit restart. A new graph hop carries only
its own current opener, never the previous visit chain. An incoming (inverse) assertion keeps the opener of the stream
it was reached through and does not flip that stream.

Decision: finite work-region returns preserve Realm, node, property, direction and cursor; admit them only when the
fragment matches that selected native relation, then consume focus on the reading where it arrived.

Decision: expose the existing overview and exact native region through `showcase-work/index.ts`; select only the requested node/property/direction/current cursor, and leave finite route grammar and outer composition with Web.

### Public grouped reading

`WorkFranchiseReading` is the supported component; the retained `WorkFranchiseOverview` placement uses that same
function. `selectWorkFranchiseRegion(page, selection)` receives the acknowledged `SubjectPageData` from
`loadSubjectPage` and `{node, property, direction, cursor?}`. It returns `{page, window, continuation}` for that exact
native composition node, including unsuccessful windows; a missing or mismatched node/property/direction/cursor or
borrowed continuation returns `undefined`. `window.rows` and original assertions retain their supplied identity and
order. Identical targets remain distinct assertions. A shared read key does not transfer node continuation ownership.

Web imports those exports plus `subjectBody` and `loadSubjectPage` from the public entry. For example, acquire
`loadSubjectPage(client, subject, 'relations', locale, {realm, authorization, continuation: {node: 'sequels', cursor}})`;
select `{node: 'sequels', property: 'wdt:P155', direction: 'forward', cursor}` on its `kind: 'page'` result. Mount
`WorkFranchiseReading` with `page`, that `selection`, `reading: subjectBody(page)`, released `definitions`, `locale`,
`readerSpoiler`, `link`, validated `returnTo`/`currentHref`, and `onContinue`. Keep the existing `OverviewContext`
provider bound to that same page's Subject, selected Context/population, requested Realm/reader, release digest,
reader preferences and installed value/evidence presentation. These typed internal projections are trusted;
selection is not another authorization decision or a Subject reader.

`onContinue` receives only this node's `{node,cursor: window.next}` while its existing return lease remains current.
Web owns acquisition of the successor through `loadSubjectPage`, the acknowledged requested-reader binding and
mounting its exact selection; no query field or independent Connections cursor substitutes for that native handoff.
The component never fetches or prefetches. A source, release, selection or browser reader/credential observation
replacement retires callbacks and disclosures; equal replacement consumes old focus intent and A/B/A cannot revive
it. Missing selections show the current heading and restart. Independent drafts and unknown commands retain their
owners. Web admits only the selected native relation and matching work-region fragment, then mounts that page and
selection in the existing reader.

### Group bounds and states

The overview retains twelve assertions total, at most three per stream, allocated round-robin. A selected region
renders at most its actual admitted `window.limit` (the native paged relation cap is twelve, possibly lower), without
multiplying limits across groups. Failed, refused, concealed, absent/unrequested (204), complete-empty, unsupported,
not-caught-up and truncated streams keep separate presentations. A failed stream never erases an admitted sibling.
The original holder, property, direction, assertion, release and revision stay with evidence. Spoiler gates cover the
whole association and its evidence; selected continuation behind undisclosed associations has its own reveal gate.
Reading grants neither editing nor inspection authority.

Work is O(N + W + Q + R): N is the supplied composition's at most 256 nodes/16 distinct reads, W the admitted finite
relation rows, Q their released bounded qualifier/reference parts and R the disclosed related batch. No target
hydration, history expansion or engine change is added. For UTF-8 bytes, use the actual native envelope, not a row
count or string length: B = bytes(JSON.stringify(page)). Its ceiling composes envelope framing/metadata, the at most
65,536-byte composition, released catalogue projection (within the native 4 MiB release), and each distinct native
leaf's own response bound. The Semantic link assertion contribution for a window of L admitted rows is
`L × (273A + 257S + F)`, using the native sixteen qualifiers, sixteen references of sixteen parts, 256 related-ID
budget, admitted Snak byte bound A, disclosed-summary bound S and fixed framing F. Aggregate 16-read/128-slot
admission does not itself bound bytes or backend examined rows; the [native presentation contract](../../../../../services/kernel/src/presentation/README.md#cost)
and [Semantic response bound](../../../../../services/kernel/src/semantic/README.md) retain those authorities.
The component retains the supplied page, creates one selected-window array, and performs zero native reads.

The overview keeps the current grouped relation renderer at its existing placement. Web composes its target,
Connections and value-inspection addresses through `subjectVisitReturn`; the receiving route validates the same
address it consumes. Realm survives on overview and finite-view returns; Connections retains its own exact native
cursor/history. A finite route carries the selected node/property/direction and current cursor to the same native
selected-region consumer. Its fragment is admitted only for that node and stream. No cursor is transplanted from a
composition window into the independent Connections reader. Empty,
unavailable, historical and withheld streams keep their own current state and their own selected-stream entry.

`WorkRelation` hands back the mounted browse link or evidence summary. Returning to evidence focuses its summary
without reopening disclosure. The locator includes the original holder/assertion, stream/node, spoiler preference,
release and revision; these identify focus intent and confer no permission. Current native admission still decides
whether that control exists. Missing rows, changed release/revision or spoiler preference focus the region heading
and expose restart. Focus is consumed once for an actual address visit, so source replacement and A/B/A cannot
replay an old locator. Equal successful replacement remounts row disclosure. Browser credential/cache observation
uses the existing shared `browserObservation` and address lease; a retired source cannot rebind itself to recovery.
A return observed while that lease is retired is consumed on that reading, even if its control could not mount;
fresh equal rows cannot later inherit that focus intent.

Connections keeps its existing bounded history and exact reading checks. Target and inspection links retain that
window plus the validated work-region opener. A replacement of the mounted source consumes the prior URL intent
and requires restart before reading again, rather than replaying its old continuation. No new native call, grouping
model, evidence renderer, continuation host, source projection or inferred target is introduced by the outer journey.

## Anonymous published inspection

One inspection owns one cancellation lifetime through the prepared BFF Request and all anonymous native reads.
Close, target edits, locale/read-adapter replacement and unmount retire it; reopening starts a fresh lifetime.
An aborted aggregate starts no profile controls. The two fixed concurrent controls share its signal and retain the
immutable digest/template witness and separately observed active-head checks. Abort is best effort: serial and
current-context fences still discard retired results, and native failure semantics remain unchanged. The transport
strips credentials at the boundary with explicit omit/manual/no-store fetch options; inspection never shares viewer or page query caches.

Community's application host consumes the public `communityPublicationVisitHref` navigation capability from
`subject-visit-navigation.ts`. It composes the existing canonical Subject address, exact Realm operand and admitted
public shelf return. Community does not import Search's private Subject application. The handoff supplies no
membership, publication or access authority; the destination performs its ordinary read admission.

## Book Overview

Decision: Book Overview reuses the ordinary admitted Subject readers in an open identity, synopsis and review flow;
ratings sit beside identity, up to three admitted reviews follow the synopsis, and Relations is a canonical tab
without an inline preview or duplicate link. Short synopsis text stays complete; long text retains the native
expand/collapse, language, spoiler and exact-return behavior. Detailed populations remain in the full review
journey. Other Subject kinds and non-Overview views retain their existing contracts.

`SubjectPage` applies `bookOverviewDocument` only to an admitted `schema:Book` Overview. It omits relation, edition,
credit, collection and discussion previews from rendering and does not mount the literary or franchise overview.
The original page document still owns planning, admission and navigation counts. Native `pages.read` supplies a
bundled composition; Web starts no extra preview request to remove. Relation reads cannot be dropped from that
installed producer by this presentation projection. The canonical Relations, editions and other defined list views
remain reachable even when their original preview would have fitted entirely on Overview. Tab customization is a
future seam only; no preferences model or interface is introduced.

The Book identity retains real cover/media, title and author, native Library actions and source-local rating
failure/retry states. The compact rating uses the published public figure and its own count, never an imported score
or personal vote as an aggregate. The review bound is applied after ordinary community admission and lifetime
checks; it preserves native order, authors, thread destinations and historical citation provenance, and adds no
nested continuation. Full reviews own reaction/watch/report controls and pagination. Empty and unavailable regions
retain their own states; neither is turned into a fabricated count or review.

Use the [placement heuristics](../../../../../docs/development/feature-design.md#information-placement) when
changing the composition. Reference direction: [Goodreads Glorious Exploits](https://goodreads.com/book/show/127278133)
(its live page may refuse automated access), Impeccable's [Read guidance](https://impeccable.style/designing/) and
[distill](https://impeccable.style/docs/distill/): prioritize the reading job, remove repetition and keep occasional
choices reachable. Apply the craft floor through existing theme tokens, readable line lengths, responsive flow,
visible keyboard focus and real content. Do not copy reference assets or text.

Focused Web regressions pin Book-only omission and canonical tabs, the admitted review bound and unchanged full
views, identity rating availability, and existing short/long synopsis disclosure. These run in the dev verifier;
no extra Storybook or browser states are required for this composition change.
