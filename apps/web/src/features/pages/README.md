# Subject page composition

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
No native card starts author enrichment. The shared author batch remains available for ordinary rows.

The installed card does not supply historical scale/lifecycle/original-target provenance. Its reviewContext remains
current; a review's recorded citation therefore stays explicitly unavailable unless the separate historical extension
below is present. The default route does not manufacture that extension. The controller retains generation and
native publication. Reply/reaction/watch retain their existing owners; admitted overflow mounts `PostActions` with
the route's existing verification configuration and the original canonical thread target. Without configuration it
links to that thread's owner. Opening-post revision replacement retires the card even if its normalized advice is unchanged.

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
to the exact thread and first-post revision; readable cards and Board destinations do not confer it. A new-thread
composer stays unavailable until Content supplies a concrete Board target. Shared Board and command owners remain
unchanged.

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
