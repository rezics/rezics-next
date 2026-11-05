# Subject pages

A subject page is the hub for one subject: a work, edition, episode, character, person, organization, concept,
recipe or any other admitted type. This document is the single authority for what a subject page shows and how its
views are organised. Mechanisms live with their owners: covers in [Cover](../packages/ui/README.md#cover) and
[content covers](../services/kernel/src/content/README.md#covers), relations in
[semantic relations](../services/kernel/src/semantic/README.md#relations), ratings in
[ratings](../services/kernel/src/rating/README.md), templates in
[composition](../packages/composition/README.md#subject-views).

This page spans those modules because a reader experiences one page; splitting its rules across owners would let
each owner ship a correct part and the page still fail.

## Reader Type display

Reader labels, cover proportions and explicit Schema.org hints come from the shared Web Type-directory
adapter's exact descriptors for the Types actually present, including Types in other active Releases. The native
descriptor selects the label using the existing language fallback; Web uppercases its first Unicode character
in the selected language and preserves the remainder. Effective cover inheritance is already compiled into that
single descriptor. Web validates cover ratios and explicit `https://schema.org/Term` hints, reads no ancestors,
and never infers visibility, authority or Schema.org metadata from a parent.

Decision: deduplicate within each finite caller page, allow four concurrent exact reads, and retain no descriptor
cache between calls; missing, retired or unavailable Types omit optional display metadata and can recover on the
next read. This also clears a previously attached Type label when current metadata is unavailable.

For N supplied subject/Type slots, U distinct Types require at most U descriptor requests, U ≤ N; there are no
registry, release or ancestor reads. Existing page limits bound N (for example Space's 12 publication slots or
the shelf chooser's 20 Type slots); a subject frame needs one descriptor. Each descriptor retains the native
1,024-Type/4 MiB Release bounds and at most 64 property points. Whole-release consumers and historical pinned
readers keep their existing contracts, as do subject access, session/no-store handling, rendering and links.

## Imported music and live-action profiles

An ordinary imported `schema:MusicAlbum`, `schema:Movie` or `schema:TVSeries` overview groups admitted scalar facts,
qualified credits and related work with human field labels from the current immutable release. Source records stay
source provenance, distinct from editorial acceptance. Relation pages that return a following `next` token are the
loaded page only; they never imply a complete tracklist or episode list.

Type3 maps to MusicAlbum with no work/release/track split. The ordinary album contents reader consumes only admitted canonical containment streams; it does not publish tracks or recordings. MusicAlbum, MusicRelease and MusicRecording
have no Library profile, so Library states, copies and progress stay unpublished. An album overview offers admitted inverse `schema:releaseOf` editions as destinations. Decision: the edition page
defaults to the admitted `schema:track` window; listing-occurrence Concepts distinguish repeated recording slots and
medium identity stays unpublished. An ordinary Subject Recording destination
is available when its distinct type and fields are admitted by that subject's pinned immutable definition release. Type6 maps pinned movie platforms to
Movie and pinned TV-template platforms to TVSeries; unknown platform codes stay ignored. Movie and TVSeries expose the
existing `anime.film` and `anime.series` Library controls. Opening an admitted `schema:TVSeason` or `schema:Episode`
subject uses that grain's released fields and Library pin; Bangumi episode family bootstrap stays unpublished on the
series page. A Screen work reader can still browse already-admitted TVSeason and Episode members from the released
work-parts relation; this does not create an episode family or imply personal completion.

Correction uses the existing album and screen editors: an explicit proposal, native candidate review, and a current
reread of the same subject. Empty, loading, denied, stale and unavailable readings keep useful copy and a bounded retry;
retry never creates. A contributor list previews the credits view.

TVSeries and TVSeason episode browsing uses only the released inverse `schema:isPartOf` link window. It preserves the
native response order and displays `schema:position` only when that exact membership assertion discloses the admitted
string qualifier. It never derives a number or episode kind from a title, position or array offset; extra episode facts
open the exact Episode or Season page. If the assertion projection is withheld, its title, link and evidence stay hidden.

Decision: preserve native episode link order and position strings; an absent released episode-kind fact stays unknown.

### Screen episode reader Cost

One screen profile read and one inverse link page suffice for a visit; the reader requests `WORK_PARTS_PAGE_CAP` (20)
rows from the current `/links` endpoint, whose input accepts 1–100. The public link response has no aggregate UTF-8
ceiling. Before retaining evidence, the adapter measures the complete decoded page and refuses it above 1 MiB without
dropping qualifiers or references. Native statement admission bounds one statement to 16 qualifiers, 16 references
and 16 parts per reference. This retained-page budget does not claim a native query or wire-byte bound; the adapter
does not enumerate unrelated subjects, hydrate members or read historical membership versions.

Admitted public containment is independently readable through the [album contents owner](../apps/web/src/features/catalogue/album-track-reader/README.md).

## Read a game work and its editions

Decision: Comparison cards retain the native inverse-link order of the current bounded release page.

The ordinary Game and Visual Novel overview mounts the [Game reader](../apps/web/src/features/catalogue/game-reader/README.md).
It groups admitted work facts, classifications, qualified credits and relations using the active immutable Release.
Work, software release and independently referable add-on remain separate identities. Missing platform, engine,
language or status configuration stays unsupported, with existing generic Details and Edit facts paths. Unknown
source codes remain provenance; no platform/language product creates releases and no public fact establishes
ownership, private progress or provider authentication. Existing Game correction, personal import and scoring stay
with their current owners.

Only the current disclosed, bounded inverse work-link window offers actual software-release destinations. Its exact
holder, assertion, work target and summary must agree; no per-target hydration occurs. Qualifiers, references,
accepting meaning and partial/TBA/unknown dates remain intact. Existing ordinary release reading and the `/release`
companion own edition details and correction.

Decision: Game destinations open in a new tab to preserve the source window, with keyboard return to its surviving
opener or reader heading; replaced authority or source retires old results, cursors, reveal and focus intent.

Decision: a failed release continuation retires release destinations while retaining the work reading; native cursor
refusal, a repeated accepted cursor or 64 accepted windows requires an explicit fresh reading, never an exhaustion claim.
Refresh retires the whole prior reading. A withheld reading removes both work and release facts. An empty window with
continuation still offers More; an absent continuation does not establish a catalogue total. Game dates use the shared
time presentation and release-fidelity TBA interpretation, retain the native absent-calendar Gregorian interpretation,
and name explicit non-Gregorian calendars unsupported. Precision, signed years and uncertainty remain visible even
when a date cannot be emitted as a structured date.

**Cost:** At most four native reads per explicit window (Subject, active pointer, immutable Release, one 20-row links
page), no target hydration or writes. The [reader Cost](../apps/web/src/features/catalogue/game-reader/README.md#cost)
bounds bytes, cursors and retained windows. Shared Subject wiring adds no View enum or route ownership.

## Read a literary work

The ordinary Subject page recognizes released `schema:Book`, `schema:BookSeries` and `bf:Instance` identities,
including delivered descendants. Type names, multilingual terms and property labels come from the current native
descriptor. A Book's actual directed series membership and supplied position remain attached to that statement;
an edition's disclosed canonical work stays separate from its publisher, translator and publication facts. Sources,
unknown values and partial dates retain the shared native value presentation. Missing canonical mapping, a withheld
target and failure to read current facts are separate outcomes. Existing Terms, Facts and correction handoffs keep
their current admission; public reading does not require a correction companion.

Decision: A released Book with a directed series membership remains that exact Book; neither a numbered title nor a stated count grants a new volume Type, member identity or integer position.

Every membership and Edition window supplied by the current Subject composition is discoverable in native order,
labelled by its released property and direction. The explicitly selected node wins only in its own family; the
reader retains at most one membership page and one Edition page at a time. Rows retain statement identity, repeated
occurrences, direction, source references and qualifiers; a missing target summary never becomes a link. Preparing,
withheld, unavailable, unsupported, empty terminal, sparse, continued and truncated states remain distinct from a
missing canonical work mapping. The native page's row limit applies before projection. A deliberate stream change
starts that node without a cursor. A sparse page can continue; a stale cursor offers a fresh reading instead of
claiming exhaustion. Overview enters the existing full view, since its preview node need not be the full view's node.
Destinations opened from an Overview preview return to that exact preview node, property, direction and focus without
a cursor; entering the full view remains a fresh address.
Full-view continuation uses the exact current node and opaque cursor, replacing the loaded page rather than
accumulating a catalogue. A selected stream that disappears or changes its released property or direction is
unavailable until the reader explicitly reloads the current Subject.

Decision: Keep stream choices in native order, render one active page per family, and restart a deliberate stream change at its own node without carrying another node's cursor.

Destinations open in a new tab and carry the existing validated single-hop return address. Returning preserves the
source window, locale, Realm Context, reader settings and focus. Explicit return links name the original native
node and cursor. Moving focus cancels automatic restoration. Subject, source incarnation, release, Context, locale,
reader or credential replacement retires the preceding reading, including A-to-B-to-A. Read retirement never clears
private drafts or cancels a command. Canonical work links use only the currently admitted native disclosure; no
parent resolver or per-target read is added.

Decision: Previous retains at most eight prior addresses, evicting the oldest; it reloads current native facts and restores focus only when the exact assertion remains disclosed. A removed row leaves a currentness message and the available Restart or Next actions.

`subject.tsx` mounts the public `LiteraryReaderEntry` on Overview, Contents and Editions. Its module exports that entry
plus `literaryWorkIdentity`, `literaryAuthorityKey` and `literaryReaderRetired`. The local `/sources` link continues to
the existing Subject Sources page; the reader does not create correction actions.

### Literary work reader Cost

The adapter starts zero requests and decodes zero additional network bytes. It shares the already decoded Subject,
related summaries and native descriptor. Choices retain at most the 16 relation windows allowed by
`MAX_PAGE_READS`; each supplied window carries its exact native `PageRead.limit` and freshness. The reader retains rows
from at most two active windows, so its row bound is the sum of those two planned limits. `SubjectList` in
`platformRegistry` admits at most 24 rows (12 for paged previews), while other relation nodes keep their own installed
planned limit. Each explicit Previous, Next or target return performs one current page read through the existing
Subject route. The browser retains at most eight prior view/node/cursor/focus addresses (each existing cursor remains
capped at 8,192 characters), with no prior native payload; the serialized literary address is capped at 32,768
characters and evicts the oldest history entry as needed. The two selected windows retain only their native planned
rows, related summaries, qualifiers and references within the existing composition payload; no document reads are
added by this reader. The shared plan retains `MAX_PAGE_READS = 16`, `MAX_PAGE_COST = 128`, `MAX_COMPOSITION_NODES = 256` and
`MAX_COMPOSITION_BYTES = 65,536`. The descriptor uses the existing bounded definition-release vocabulary; extending
its literary admission adds no engine query. No SQL selection, scan, count or statement-history path is added.

The focused composition case at 64/512/4096 unrelated Subjects and obsolete reads records the supplied window's
UTF-8 bytes, retained projection bytes, rows and zero incremental requests/decoding. Only reads named by the current
native composition enter that projection. This is adapter evidence; it does not assert execution or growth results
for native SQL. The installed page producer has no exported whole-response byte ceiling: these measurements are
actual fixture bytes, not an invented native byte limit. Native compact selection and seeded journey acceptance
remain with their owners. Terms retain the existing 32-title/48-alias/16-description preview, with explicit overflow
advice; no facts are silently cut to meet a budget.

## Read a music edition

The ordinary Subject overview offers the [music release reader](../apps/web/src/features/catalogue/music-release-reader/README.md)
for a native `schema:MusicRelease` identity or descendant, independently of album contents and Recording readers.
`MusicReleaseOverview` uses the current Subject page's id, Context, Realm, locale, reader observation and native actions.
It names this edition's admitted album relationship, catalogue number, format, label, date, duration and ordered
recording associations. Recording targets retain Context, Realm, selected stream/cursor and row focus through the
existing Subject visit return. Track association evidence is behind one disclosure gate; withheld target summaries
render no target labels, links or assertion identifiers. Region and medium-level disc or side identity stay unavailable
because the current Definition does not publish the required medium grain. TBA, partial/absent dates and unsupported
configuration stay distinct. Existing generic facts and correction remain available under current native advice.

Decision: until the current Definition publishes `rezics:MusicMedium` with its release-membership relation, keep
medium/disc membership explicitly unavailable and read only released ordered `schema:track` recordings.
Music release admission requires the exact released `schema:MusicRelease` identity or a released descendant.
`schema:MusicRecording` is published as its own Type; `rezics:MusicMedium` stays unpublished, and listing-occurrence
Concepts on `schema:track` distinguish repeated recordings without inventing a medium. Generic release labels and
provider codes do not admit them. Duration and distribution format reuse the existing `schema:duration` and `wdt:P437`
slots. Track associations use Wikidata P642 targeting Concept as slotKey so the same recording can occupy two positions.
The composed page reuses the file-page caller `viewer` (state and `statementPropose`) and carries native Access
`actions` as a sibling; catalogue metadata includes MusicAlbum, MusicRelease and MusicRecording. Catalogue 1.0.4
publishes sourced release status and episode-kind vocabulary while 1.0.3 music bytes stay pinned.

### Music edition Cost

The reader repeats at most four reads for one deliberate window: Subject, active pointer, immutable Release and one
20-row association page. It performs no target hydration or writes. The [reader Cost](../apps/web/src/features/catalogue/music-release-reader/README.md#cost)
defines subject/page byte bounds, bounded retention and retirement on replacement authority or observation. Existing
release/file companion costs and release type meanings remain unchanged.
Decision: TVSeries and TVSeason readers use one active-release work-parts stream, preferring inverse
`schema:isPartOf` and otherwise the released default; they show only disclosed TVSeason/Episode identities, retain
native relation order and position strings, and return with the same context and cursor.

### Screen work membership cost

A TVSeries or TVSeason visit reads one current Screen profile, its active and released definitions, and one work-parts
page capped at 20 rows. A deliberate continuation repeats those bounded reads for its opaque cursor; the reader does
not refill sparse pages, hydrate each member or traverse a season's episodes from the series. The native relation page
supplies each disclosed member summary, its admitted order and any string `schema:position`; absent positions remain
absent and specials keep their exact identity and position. Withheld, stale or unavailable membership remains distinct
from an exact empty page. The reader exposes navigation only; personal completion, current advice and mutation stay with
the existing progress checklist. No Screen reader read or navigation grants checklist authority.

## Read a story arc

The ordinary Subject overview exposes the [Story Arc reader](../apps/web/src/features/catalogue/story-arc-reader/README.md)
for an arc and for a work with disclosed arc slots. Its existing Summary supplies admitted narrative context.
Separate directed membership and sequence streams preserve native order, positions, first/last parts, qualifiers
and exact sources. An arc member can show only that work’s appearances explicitly qualified for this arc; missing
released filtering is unsupported with the existing Details path. Spoiler qualification gates the complete row,
including target navigation. Unavailable continuation is not an ending, and replaced authority retires old controls.

Decision: public destinations open in a new tab to preserve the exact originating work/arc window and keyboard
return; at most one member appearance window opens inline, with Back restoring its member control.

### Story arc Cost

Each deliberate window uses one Subject read, the existing active/immutable definition pair and at most one
20-row relation page, without target hydration. One outer and one optional appearance window are retained;
the [reader Cost](../apps/web/src/features/catalogue/story-arc-reader/README.md#cost) defines byte, cursor and stream
bounds. Current Character, correction/classification and prerequisite-deferred native acceptance remain unchanged.

## Read a Recording

The ordinary Subject Recording overview reads only the current disclosed identity, duration/version, and qualified
performer, composition and release associations admitted by that subject's pinned immutable definition release.
Recording, musical work, album and release remain distinct identities. Each association preserves its declared
direction, role/time qualifiers and exact target; unsupported vocabulary keeps the existing Facts and correction path.
A Recording has no Library profile until Commerce publishes one.

Decision: A Recording overview preserves each property's declared direction and exact target identity, and carries its
exact statement focus in the current Subject address with at most one validated nested `via` return intent.

### Recording Cost

The reader uses the existing Subject page read plus one read of its exact immutable definition release. It adds no
Subject, provider, playback or per-association reads; an incomplete relation window continues through the ordinary
bounded Relations view.

## Read a music place, area, event or instrument

The ordinary Subject overview recognizes released `schema:Place`, `schema:AdministrativeArea`, `schema:Event` and
`schema:MusicInstrument` identities (including their admitted descendants). It names the exact released Type and reads
the finite forward and inverse relationship streams admitted for that Type. Related event, area, participant and
instrument destinations retain their native direction, qualifiers, references, partial dates and exact readable
identity. Hidden summaries do not link; coordinate strings do not become locations. Unsupported Types have a named
unsupported state while generic Subject facts and correction access remain available.

Decision: related Subjects open in a same-locale new tab; closing it returns keyboard focus to the source relation link.

The [reader Cost](../apps/web/src/features/catalogue/music-location-reader/README.md#cost) bounds each current Subject and
one selected relation window, with no target hydration or writes. The existing dedicated MusicContext profile and
correction route remain unchanged.

## Create a catalogue subject

`/{locale}/catalogue/new` is the generic initial-terms form, discoverable in the ordinary subject header's
content action slot. It offers the existing header search and search page first; opening a matching subject keeps
that existing identity. Creation never merges identities or assigns a client-generated subject ID.

The form reads the active immutable definition release through the shared release helpers. Its Type choices and
localized help come from emitted metadata and the existing language fallback. Work, edition and release remain
different objects. The data-language tags on names, descriptions and aliases are independent of the interface
language. One name is required per entered language; descriptions and newline-separated aliases are optional.
This route creates initial terms only, with no manufactured statement, citation, custom Type publication, Type
migration or post-create term-update API. Later field contributions use their separate editor.

Submission uses the generated `POST /v1/subjects` ItemInputSchema body and the existing session BFF, CSRF check
and native idempotency key. A confirmed response means **created**, not a pending proposal: initial facts are
virtually accepted and adopted in Global. The same native client reads the exact returned ID without bearer
fallback, carrying the native write session token into that ordinary read. A successful read supplies its canonical
localized subject address; a failed or concealed read never becomes a fabricated page or a different identity.

Definitions loading, no available Types, signed-out, denied, invalid, conflict, unavailable and saving have explicit
states. Errors link to controls. Server value rejection refreshes the active release while retaining the draft.
An uncertain submit freezes the exact draft and idempotency key for retry; concurrent clicks issue one command.
Decision: Literary keyboard Add focuses the exact new assertion's value-state control; pointer additions, rejected additions, moved focus and retired rows or workspaces never restore that intent.
Game creation retains multilingual terms, per-Type rows and applicable sealed commands across unavailable metadata refresh, blocks new intent until recovery, and binds known initial-fact correction links to stable rows and inner controls; unsupported pointers stay in technical details.
Album and Game creation clear a withdrawn or newly occupied single-valued initial-field choice, explain it beside the chooser, and require deliberate current re-selection even if that field returns; authored facts, multilingual terms and sealed commands are retained.
Album and Game keyboard Add focuses the first editable control of the exact acknowledged initial assertion by stable row identity; refused additions retain the choice, and pointer additions, moved focus and retired admission stay quiet.
Game creation confirms removal of populated optional initial facts locally, including selected items, qualifiers and references; Cancel or Escape preserves mounted controls and restores trigger focus, confirmation focuses a surviving control, blank scaffolding may remove immediately, and current command locks apply to open confirmations.
A key conflict requires explicit review before a new request. A confirmed creation with an unavailable reader
keeps its exact ID and offers an ordinary read retry without creating again. This private, uncached form is noindex.

Independent Publication recovery keeps local values visible but disables editing and creation while the current work
reading is unavailable. Refresh start hides the previous work title and links; only a fresh read for the same work
restores admission, and an unresolved command retries only after an explicit action with its original body and key.
After a current keyboard addition, focus moves to that admitted field's first value control (quantity amount, time
precision, otherwise its first edit control); rejected, stale and pointer additions do not redirect focus.

Character creation keeps multilingual terms and optional initial facts in semantic field groups using the shared
content frame; terms use one column on phones and two on desktop. Confirmed creation leads with its status and
reader actions, with the exact returned ID in labeled technical details; concealment and unavailable-reader
messages remain visible beside the read retry.
Decision: Character keyboard Add language or fact focuses the exact admitted stable row's language input or fact group; pointer additions, moved focus (including away and back), and retired or replaced rows, readings or metadata stay quiet, while removal keeps its existing handoff.

Character creation guards router and unload departure while a language row or initial-fact property is staged, a
term is edited, or a create is unresolved; Stay retains local controls and exact retry intent, while Leave retires
local recovery without cancelling a sent native operation.

Choosing an existing Character or another credited work uses the replaced holder’s departure decision: Stay retains its draft, selection and exact unresolved request; Leave retires that local holder and its callbacks, and the first reviewed destination stays fixed. Classification keeps its separate boundary.

Character creation refreshes rejected metadata independently of the public current reading, retaining editable terms,
facts and correction links on refresh failure with a metadata retry.
An explicit successful required refresh revalidates retained input before new commands; retired facts stay private
until corrected or removed, while unresolved commands keep exact replay. Populated language rows and staged facts
require row-local removal confirmation with Cancel; surviving inputs retain their stable correction targets. Uncertain
submissions keep removal and editing locked to the original request.
When refreshed Character definitions withdraw an additional field choice, return the chooser to its prompt with an explanation and disable Add until deliberate valid re-selection; preserve authored input and never restore the choice automatically.

Character selected-work admission uses the current exact descriptor for that work's actual Type, independently
of the Character's Release. A failed or mismatched descriptor is unavailable; a missing or unsupported Type is
ineligible. Failed reads retain the selected address and private drafts behind the current-reading boundary.
Decision: picker admission reads each result's actual Type, whose properties already include inheritance, rather
than probing its presentation bases. The existing eight-result picker deduplicates actual Types, requiring at most
eight exact requests, or eight Type and 512 property points under the 64-property descriptor limit; it never pages
the Type directory. Actor-support guidance describes only the selected work. Character fields and native credit
validation still require complete effective property, qualifier and reference definitions; a partial descriptor is
not a replacement Release and cannot supply missing support definitions or reinterpret stored pins.

Album creation resolves rejected submitted indices to stable assertion rows and authored language controls; following an invalid correction explicitly reviews a new command, while conflicts still require Review and uncertain commands remain sealed. Unknown addresses remain inspectable without a correction link.
Album creation freezes retained private controls and shows complete assertion snapshots while metadata is retired; explicit refresh restores only admitted definitions, keeps retired facts for deliberate removal, and leaves exact uncertain retries and created-reader recovery independent.
Album creation confirms populated initial-field removal locally, including meaningful qualifiers or citations with a blank main value; Cancel or Escape restores the trigger, confirmation focuses a surviving control, and blank scaffolding may be removed immediately while sealed rows remain locked.
Album qualifier removal confirms populated values locally with Cancel or Escape, retains selected summaries and stable private control identities, and focuses a surviving qualifier or Add qualifier after removal; submitted indices still resolve against the exact command, and current draft locks apply to open confirmations.
Decision: Album and Screen nested qualifier choices stay staged until explicit Add, admit one instance per qualifier property up to the 16-part limit, and move focus into the new qualifier only after successful keyboard addition rechecks current metadata and parent admission.
Album creation protects retained terms and added initial-fact rows on router departure and browser unload; blank extra language scaffolding alone stays clean, Stay retains exact local and unresolved command state, Leave retires only local recovery, and confirmed native success releases protection before its reader opens.
Manga creation confirms populated initial-field removal locally, including authored metadata, qualifiers and citations; Cancel preserves the entire row, and removal focuses the next usable form control or a preceding survivor while sealed drafts stay locked.
Decision: keyboard Add focuses the named new assertion only after current Type and definition metadata admit its row; pointer additions, rejected additions and refreshes keep focus in place.
Retired Manga facts stay private and expose the complete retained statement as collapsed technical details; historical field labels remain marked stale and target labels are not presented as current authority. Populated retired rows require local confirmation with Cancel or Escape, preserving the exact row and feedback; confirmation removes only that current row and focuses a next or preceding survivor under current command locks, while blank scaffolding may remove immediately.
Manga creation protects both Type drafts on departure, including added blank facts, changed Type or independent-publication confirmation; Stay preserves the entire workspace and exact retry, while Leave retires local recovery without cancelling a sent command.
Manga creation resolves rejection addresses by decoded property and assertion index to stable draft rows and
supported inner controls; ambiguous or unsupported addresses stay at their named section with technical details,
duplicate-language feedback targets the later row, and unavailable sessions offer a sign-in check retry.
Removing an unsent Manga qualifier keeps the assertion and sibling drafts, confirms populated values locally with Cancel, clears obsolete submission feedback and returns focus to Add qualifier; retained controls keep their identities and sealed commands freeze removal.
People creation resolves only its produced assertion and editable scalar or citation parts to stable, named controls;
unsupported addresses remain inspectable without links, and retired Types retain staged facts for explicit removal.
With a supplied work, creation retains the credit context and offers the exact returned reader through its explicit link.
People creation confirms populated initial-fact removal locally, including meaningful citations with a blank scalar; Cancel or Escape preserves the mounted row and restores trigger focus, confirmation focuses the next usable control or a preceding survivor, and current command or retired-metadata locks apply to open confirmations.
People creation keeps editable private terms, facts and citations through failed metadata recovery, hides retired work references, admits only fresh reads of the original work, and blocks new commands until recovery while preserving exact unresolved retries within the original viewer and CSRF session.
Decision: an admitted keyboard Add fact focuses the new field's first scalar control (including its value-state selector); pointer additions and metadata refreshes stay quiet, and focus movement or holder retirement cancels the handoff.

Screen creation resolves submitted assertion indices to stable row and nested-part identities, links only supported value, qualifier and citation controls with human field labels, and preserves sibling assertions and citation groups when correcting; a blank citation remains editable until explicitly removed, unknown addresses remain technical details and uncertain commands stay sealed across metadata recovery.
Decision: a keyboard-added initial assertion focuses that row's primary value control after admission; pointer additions leave focus at Add.
Screen creation confirms removal of an unsent initial fact containing a value, meaningful qualifier or citation content; Cancel restores trigger focus and preserves the complete row, while removal focuses the next usable control or a preceding survivor and obeys the current draft lock.
Screen creation confirms populated qualifier removal by stable part identity; Cancel or Escape retains picker summaries and restores the trigger, while confirmation focuses the next qualifier, a preceding qualifier or the parent control, in that order, and obeys current command locks.
Screen citation removal confirms populated URLs by stable part identity, preserves the complete draft on Cancel or Escape, and focuses the next citation, a preceding citation or a parent control after confirmation; blank citations remain editable until explicit removal and current command locks apply to open confirmations.

Existing Screen correction reloads retire the public reading before transport starts. Only a fresh matching result restores public fields and proposal admission; mounted private corrections retain their drafts and exact sealed retries, while callbacks from the preceding reading stay retired after equal-subject recovery.

Album, Manga and Recipe creation confirm removal of each populated unsent language row, including language-only input; Cancel or Escape retains its inputs and correction targets and restores trigger focus, while confirmation removes that stable row only, focuses the next row or Add language, and obeys current command and metadata locks.

Album and Manga creation hand keyboard Add language focus to the exact newly admitted stable row's language control; pointer additions stay in place. Focus movement, including moving away and back before mounting, or retirement of the row, metadata, Type activation or workspace cancels the handoff; rejected additions and background changes never move focus.

## Create and correct a recipe

`/{locale}/catalogue/recipe`, linked from catalogue creation, creates a released `schema:Recipe` with initial
terms and explicitly entered facts. The recipe's ordinary subject page links to
`/{locale}/subjects/{id}/{slug}/recipe` for later field proposals. Both routes use the existing shell and session
BFF; the correction route resolves the canonical subject address first.

Decision: recipe correction carries the source reading’s observed Context and existing public Realm selector through
canonical redirects, its private session and native Subject read; only a matching Global read can offer the existing
Global candidate editor. Other Contexts show an explicit limitation and retain their Realm return address. Opening
Global is a separately named destination that drops the earlier correction intent. The Subject entry remains an
overview; an explicit recipe-local property/statement/holder locator selects only a newly disclosed exact occurrence,
never an equal value or row index. Malformed, duplicate, incomplete or foreign address fields are invalid. The local
address is capped at 8 KiB and contains no public payload, evidence, native advice, credentials or candidate tokens.
A reading refresh retires unsent evidence comparison even when its draft is unchanged; a changed or withheld source
locks fresh submission while sealed uncertain commands keep their original bodies. Recorded proposal success remains
visible if its subsequent current read fails. Final fresh public return admission/focus and transition/replay coverage
remain a continuation of this journey.

The explicit Context changes no native read cap: one anchored Subject read (at most 512 descriptive facts, up to 12
preview rows per admitted relation property and the existing at-most-256 related-summary plan), one active Definition
pointer and one immutable bundle. Private action advice adds one existing two-resource viewer-action batch. No new
method document request, per-ingredient fanout or candidate collection is introduced. Existing authored method bodies
remain with their original document reader. The 8 KiB address bound is independent of those payloads; these UI bounds
do not establish native SQL growth. Candidate windows retain their native page contract.

Only effective fields present in the active native release appear. Ingredient monolingual text is separate from
the released material relation `wdt:P186` and dietary Concept claims. Linked targets come from the existing subject
picker and are admitted against the released targets; typing an ingredient or diet name never creates a claim.
Cooking time and yield use the released quantity schemas and explicit unit choices. Definition labels follow the
interface locale; term and ingredient languages remain explicit data values.

Instructions use the shared rich text editor and native inline authored document input, with an explicit language,
SPDX licence and confirmation that the writing is original. Correcting an existing method starts an explicit new
replacement document. The original document reference is preserved; no rich body is silently flattened or fetched
from an external recipe site. Citations use existing native references and never confer prose or image rights.

Creation sends initial statements through native subject creation, whose facts are initially selected in Global.
The confirmed UUID alone supplies the ordinary canonical reader; an unavailable reader can be retried without
creating again. Later per-field submissions create candidates awaiting review and leave the current reading
unchanged. Each field retains its own draft and request key after uncertain responses. Comparison, acceptance and
selection reuse the existing candidate review controls and native decision heads. Current denial, concealed data,
invalid input, conflict and unavailability remain distinct from an empty recipe profile.
Recipe recovery retires public current markup through failed reads, retains mounted private drafts, permits explicit
replay of sealed commands with their original requests, and restores authority only from a matching fresh read.

Recipe creation rejection focuses the first known correction; editing clears only that control's feedback,
and unknown server addresses stay unlinked until validation runs again. Errors retain stable language and fact
row identities when another row is removed. Corrections preserve all other terms, facts, instructions and original
declarations; document and subject-picker errors describe their field groups and lead into the editable control.
Removing a populated unsent recipe field confirms locally, including authored text, language, licence, original-work declaration or citations; Cancel or Escape preserves the row and sibling feedback, and confirmation focuses the next usable control or a preceding survivor while sealed commands stay locked.
A successful refresh that withdraws a selected additional Recipe field identifies the stale choice, returns the chooser to its prompt, preserves entered terms and rows, and keeps Add disabled until a currently admitted field with available single-value capacity is deliberately selected.
An admitted keyboard Add focuses the first usable control in the exact new Recipe row, with its heading as fallback; repeated properties use row identity, and pointer or refused additions, moved focus, removed targets and retired editors never replay orientation.
Decision: Recipe keyboard Add language uses the shared specialist handoff to the exact stable term ID's language control, admitted against the same current read and workspace; pointer additions and cancelled or retired intent stay quiet.
An admitted keyboard Correct focuses the first usable control in the exact source-backed Recipe row, with its heading as fallback; pointer or refused corrections, moved focus, removed targets and retired reads never replay orientation.

## Correct names and descriptions

The subject header and compact view frame link to `/{locale}/subjects/{id}/{slug}/terms`. This private companion
editor follows the [multilingual terms browser flow](catalogue-editing.md#browser-flow-multilingual-subject-terms),
keeping the exact native subject, explicit per-language changes and recoverable drafts through conflicts.
Terms edit and native selection callbacks share the language-opening admission witness; returning to a language or unlocking never revives retired callbacks, while current native selection stays quiet under its existing rules.
Rejected term edits offer at most twelve distinct language/field correction routes from exact known pointers to retained drafts; each selects that language and focuses its replacement input or mode with associated guidance, while malformed or unknown pointers remain general failures and raw detail remains secondary.
Decision: keyboard Terms Add language and unsaved-language resume focus the first explicit edit's value or mode (name mode for a new draft), or the language-labeled draft heading for a locked retained draft; invalid tags focus their associated error input, while pointer use, native selection, moved focus and retired admission stay quiet.

## Add an edition or release

The work's Editions view and a work header that supports Editions offer
`/{locale}/catalogue/publication?work={id}`. The editor requires the exact readable existing work; missing or hidden
work is concealed, and a merged identity is not silently substituted. Discovery opens the existing search page
before creation. A separate confirmation identifies an independent publication: a file, language/format combination,
personal Library Copy or distribution event alone does not establish this grain.
Publication independence uses a native checkbox button so validation links focus the visible control.
Explicit keyboard Retry or definitions Refresh preserves a surviving meaningful opener or focuses the current form/review heading, unsupported-profile state or failed-read recovery; pointer, automatic, moved-focus and retired recovery intent stays quiet.

Only emitted profiles and effective fields are offered: Book editions use `bf:Instance`, video works use
`rezics:AnimeRelease`, and software/game works use `wd:Q20631656` where the released work target permits it.
`schema:exampleOfWork` identifies the work; the released AnimeRelease `bf:hasPart` means an included work instead.
These are separate native relations, not an invented anthology Type. Definition labels follow the interface locale;
the entered name's data language is independent. Optional ISBN, identifier, date, publisher, language and page facts
use their released schema. ISBN text is retained without guessed normalization, date precision and quantity units
are explicit, and publisher selection uses existing discovery summaries and real subject IDs. An entered citation
supports the work link and entered facts. Work credits, word count and progress are never copied.
Creation error links address exact current scalar parts and the editable citation; unsupported or retired addresses
remain general diagnostics.
Populated optional publication facts require local removal confirmation with Cancel; empty scaffolding may remove immediately, Cancel restores trigger focus, and confirmation focuses the next usable control or a preceding survivor while preserving sibling facts, publisher summaries, terms, independence and the shared citation under the current command lock.

The form uses the same generated `POST /v1/subjects`, session BFF and CSRF path as generic creation. Native creation
selects initial facts in Global; it is not a proposal-only result. Success reads the exact returned UUID through the
ordinary current reader and opens its canonical address. A concealed or unavailable reader offers only a read retry.
Definite refusal preserves the draft and key until an explicit edit; uncertain delivery freezes the original command
for exact retry. A conflict requires explicit review before a new request. Rejected values refresh current definitions
without discarding the draft. After a definite definitions refusal, keep the exact staged relation and all facts
visible; validate them against the producer's current profile and schema, including selected publisher targets.
Keep the original labels of staged choices when their definitions disappear, with exact property/value details for inspection.
Unsupported choices require explicit change or removal, and a separate review starts a new command/key only after
requirements reload successfully. A missing profile keeps the draft inspectable until a supported profile returns.
The private editor is noindex and does not infer ownership or media permissions.

## Inspect an exact release and correct admitted metadata

`/{locale}/subjects/{id}/{slug}/release` is a private companion of an existing edition or release. The compact
subject frame's Contribute menu offers it for `bf:Instance`, `rezics:AnimeRelease` and `wd:Q20631656`. Subtypes
admitted by the current descriptor remain reachable at the same URL. The shared composition View enum and generic
`$view` route stay unchanged.

The page distinguishes the canonical work (`schema:exampleOfWork`) from this concrete edition: language, platform,
region, format, publisher, developer and identifiers stay on the release. A missing work link, a concealed related
work and an unreadable work identity are separate states. Work, edition, alternative release and provider file stay
distinct objects.
Decision: native `readCopyWorkDisclosure` is the completeness-aware copy/release-to-work batch; the ordinary
Subject relation adapter shows complete-empty and withheld work controls without leaking hidden members, and
Commerce keeps FullCopies and inventory adaptation. Unpublished merge mapping and mixed home cuts stay
`unavailable` on that batch; they do not leak a terminal or mixed membership.

Release date uses the released time property. Exact day, partial year/month, explicit TBA (`somevalue`), explicit
no-value, an absent statement, invalid concrete values and unsupported precision or calendars remain distinct. Only
`somevalue` is TBA. Signed and extended years retain their sign and digits without converting through a bounded Date.
Status and
region appear only when the current descriptor admits those properties; otherwise the page names them unavailable.
Decision: Missing release time calendars keep the existing Gregorian reading; explicit non-Gregorian calendars stay unsupported.
Admitted status is `schema:creativeWorkStatus` on the exact work or release holder; completeness of a particular
release for its work is the `wdt:P31` qualifier on `schema:exampleOfWork`. A status Concept is never used as a date.
Historical accepting meaning is the statement's pinned `rezics.release` digest, shown separately from the current
editor admission. An explicit correction review is required after configuration changes.

Directed release-to-release streams appear only for admitted item properties whose targets are released edition
types or descendants, including `wdt:P155` chronology and the native `rezics:releaseSupersedes` replacement relation.
P155 means follows; release replacement does not imply chronology. Work-targeted CreativeWork relations stay on the
existing relation editor. Unknown source codes stay visible as provenance on the
`schema:sameAs` qualifier of that follow as an exact http(s) URI; compact source codes are not URL values. Native edition
creation, source mapping and adoption remain with Imports. Missing producer capability is named unavailable; Web
does not fork native commands. One composed `POST /v1/pages:read` response carries selected facts with independently
cacheable public reads and private, no-store viewer/actions derived from native Access for the actual caller.
Catalogue file/group pages keep nested `viewer.actions.statementPropose`; other Subject pages return a kind-based
`viewer` and the existing viewer-actions envelope as top-level `actions`. Nested catalogue `viewer` and kind-based
`viewer` are never mixed on one response. Decision: ordinary Subject `actions` reuse `POST /v1/viewerActions` rather
than a second Access check.

Correction reuses Subject facts and the relation editor for the exact selected assertion, then returns to this
release. Native-return links keep the work, existing publisher target selection, candidate reader and Changes.

Decision: VNDB `releases_supersedes.id → rid` maps to the native `rezics:releaseSupersedes` relation; P155 remains chronology, and P1365/P1366 remain Organization replacement.

### Current release visits

The release companion accepts the public UUID `context` selector, defaulting to Global only when it is absent.
Malformed selectors and unsupported search intent are rejected. A `realm` address is explicitly unavailable to this
native reader; it is never treated as a Context or replaced with Global. Canonical identity reads use that selected
Context and preserve only validated review and return intent. The mounted caller session retains its original
admission, query key and retirement rules.

Decision: explicit non-Global release visits offer other release companions in that exact Context; Work, File,
Sources and Changes visits are unavailable until those destination owners expose a compatible Context selector.
Their Global visits use the existing Subject `via` return facility. File and Changes routes expose that validated
single return link without changing their reader or command controllers. A missing target label is unavailable.
Release relations retain their released property and direction; qualified duplicate occurrences remain separate.
Work binding and exact association inspection include their supplied qualifier and reference parts and historical
release pin. File associations inspect that current row locally and restore its evidence control without reading the
File as a release detail; the File destination keeps its existing producer. Whole-association spoiler controls cover labels, links and evidence.

One closed `#release-reading?visit=` locator identifies the original release UUID, Context, definition digest,
subject revision, current stream/cursor, exact holder/statement/target and statement revision, and intended focus.
Its complete address is at most 8,192 UTF-8 bytes, including escaping; it contains no evidence, credentials, native
session token, commands, arbitrary URL or nested return chain. It is validated by the existing Subject visit API.
An explicit return, browser history return or return from another tab performs a fresh native visit. Only an exact
current occurrence restores inspection and row focus. A changed release revision or definition discards the old
cursor; removed, concealed or repointed occurrences announce the change and focus the current association section.
No later page is scanned. Destination detail failure retains the independently admitted source reading. Missing
return intent starts a usable current stream. Restart discards the old locator and cursor history.

The reader retains one current projection, eight cursor addresses and one return locator. It preserves the 20-row
association request, native maximum of 100 and four installed visit components. Decision: each release component has a Web projection
byte ceiling equal to the installed descriptor limit (4 MiB), subordinate to any tighter native limits. The complete
encoded payload, including summaries, qualifiers and references, is charged before expansion. Existing descriptor,
subject property, association and selected-detail row ceilings remain 1,024, 64, 20 and one. These ceilings describe
Web admission, not native database work; the visit adds no database operation or per-row hydration.

## Inspect catalogue file metadata and its release group

`/{locale}/subjects/{id}/{slug}/file` is the companion for an admitted catalogue file or release group. The frame
offers it for `schema:MediaObject` files and `rezics:ReleaseGroup` source groups when those exact type IDs are current.
`schema:MediaObject` is the file class; a second local file alias is not published. `rezics:ReleaseGroup` is the
distinct source-group grain and is not a file, release or personal copy. The page does not publish `wd:Q55327` as a
group type. Until Semantic publishes these types in the active release, the page names
the profile unreleased. Hashes, size, codec, language and quality are catalogue statements. They never prove the
viewer possesses, matched or consumed the file. A file is not an AnimeRelease. Group credits render independently
from creator credits. File association does not create progress completion. Web does not upload, scan, hash-match,
synchronize AniDB, download or store a private MyList.

The ordinary Subject overview also shows an admitted catalogue-file reader. It uses the same typed Subject read and
only relation rows already disclosed by that page. It groups identifiers, technical and language facts, generic facts,
group facts and qualified credits; it keeps file identity, release or episode associations, work identity and owned
copies separate. Statement version, qualifiers, references, exact units, unknown values and source records remain
visible. A concealed target stays concealed, and a retired relation cannot create a destination link. No target is
hydrated for this reader.

Related episode, release, file and group links keep their admitted direction and kinds. They open the exact disclosed
ordinary Subject in the same locale and carry one validated `fileSource` identity with bounded local evidence keys back to the reader. The
existing `/file` profile remains the correction path, with the exact selected assertion, revision recovery and a
return to that anchor. Correction is offered only for the currently admitted type in the existing candidate context.
Native subjects, links and candidates remain the implementation.

Decision: use `schema:MediaObject` for catalogue files and `rezics:ReleaseGroup` for source groups; `wd:Q55327` is Échevannes, France, not a release-group class.

Decision: a File target visit carries one local `#catalogue-file-reader?evidence=` receipt, never a nested visit stack or arbitrary return URL. It retains the original source UUID and canonical slug, existing public `realm` selector, resolved Context UUID, Definition digest, group and exact assertion key. Native statement ID, release and revision remain part of that key; associations also retain direction, property and original holder. Qualifier and reference item visits retain their local part index, return to their owning assertion and focus that exact part only while its revision still matches.

The consumed entries are `subjectHref`, the ordinary Subject route's `realm` selection and current `publicHref`, `CatalogueFileReaderOverview` over the current composed `SubjectRead` and finite `profileRelationPages`, and `CatalogueFileReturnLink`. The Subject shell passes the current address and reader spoiler level through; its Context link preserves this validated receipt without adding `via` or replacing its source population. No shared return facility is introduced. The existing correction profile and candidate Context admission retain correction ownership.

Decision: the existing `/file` correction receiver accepts one optional public origin containing the observed Subject and Type, Context, Definition, selected Realm, exact optional property/statement/holder locator, and one same-locale immediate public return. It treats that descriptor as intent only, runs the existing Global native profile read and current advice, refuses selected Context/Realm explicitly, and offers a separately named fresh Global visit that drops the selected intent and locator. `CatalogueFileProfileEntry` exposes `origin?: { subject: string; type: string; context: string; definition: string; realm?: string; returnHref: string; selection?: { property: string; statement: string; holder: string } }`; the File reader and outer Subject page owners pass their observed values and already validated current return without synthesizing selection evidence. The receiving surface refreshes its current profile after an acknowledged existing command; the reader re-reads the public return and focuses only a selection it still admits.

Returning enters the current Subject route and resolves the key against that read, not a retained response. Only an exact current assertion in the same resolved Context and Definition restores inspection and focus. Changed, missing, historical, concealed, unavailable and retired readings explain the outcome and focus the current group or reader. The URL receipt is consumed once per address incarnation; session/cache/Context replacement cannot replay it. Complete facts, associations and inspection evidence use the existing `spoilerLevel`/`SpoilerGate` controls, with concealed association evidence unavailable rather than an identifier fallback. Missing released labels stay unavailable.

## Release and file visit cost

One selected release or file/group visit uses C = 4 installed components: descriptor, subject, one association page
and at most one explicitly selected detail. Calls per visit are at most C. Web projection and retained response state
are O(∑ L_i + ∑ B_i) for that visit, independent of catalogue/file history N. Each continuation replaces its page.
Correction uses a fixed addressed native command/readback sequence.

The `/file` receiving visit adds no native read family: it reuses the existing profile window of one Subject read, one immutable Definition read, at most one 20-row association page, and the existing optional one-detail admission (2–4 profile requests). An exact admitted locator can open the existing candidate review, whose `readSubjectCandidates` path supplies current release, candidate and authority reads without target hydration. The existing statement refresh remains one Subject read, active Definition pointer, immutable Definition and one viewer-action batch for its two resources. The Web retains at most the bounded current profile window and a 2,048-character/UTF-8-byte origin descriptor; the native Subject and relation byte ceilings remain unavailable as documented above.

A File evidence receipt occupies at most 4,096 UTF-8 fragment bytes, including percent encoding. Its local key is at most 1,024 characters, slug 768 and Definition digest 128; UUID selectors are fixed width. For V displayed target links and T inspection controls, local address/key storage is at most O(V × 4,096 + T × 1,024) bytes plus one selected receipt; it retains no evidence body beyond the current page. One return adds one current composed page read and a linear resolution over its already bounded facts and relation page, with no per-row Subject reads, scans, document fetches, authority probes or polling. Related labels and original evidence remain within that page's existing payload/stream bounds. No new engine path or growth-dependent query is added.

The ordinary Subject file reader uses the current active descriptor already resolved by `POST /v1/pages:read`; the
response carries only the selected file/group Type and its admitted field and relation meanings. Its current viewer
and proposal action come from native Access under that caller and are returned with the page's private no-store
envelope. The Subject read and finite relation pages are reused from the page composition; the reader adds no
definition request, relation continuation or per-target detail reads. Its association rows are already included in the
ordinary page's composition bounds.

The following native caps remain producer-owned; the release companion additionally enforces the complete Web
component byte ceilings above. The File controller retains its existing admission.

| Component   | L_i (rows)                                       | B_i (bytes) | Source                                                                                                             |
| ----------- | ------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| descriptor  | 1,024 types                                      | 4 MiB       | `RELEASE_LIMITS.types` / `RELEASE_LIMITS.bytes` in [definitions portable](../packages/definitions/src/portable.ts) |
| subject     | 64 properties per type                           | unavailable | `RELEASE_LIMITS.propertiesPerType`; subject-read bytes have no delivered cap                                       |
| association | 20 (native default; producer admits at most 100) | unavailable | Kernel relations/links `limit` default 20, max 100                                                                 |
| detail      | 1 selected subject                               | unavailable | one `GET /v1/subjects/{id}`                                                                                        |

An absent byte cap is an unavailable receiving seam. The loader never preloads one detail per listed file, never
fans out per association row, and never substitutes elapsed time for this bound. Tests
`apps/web/tests/release-fidelity-profile.test.tsx` and `apps/web/tests/catalogue-file-group-profile.test.tsx` run
populations 32, 256 and 2,048 through the same loader at initial and deep keysets, with sparse concealed endpoints
and a selection replacement. Total work across k deliberate page visits is O(k times the per-visit sum).

This journey adds no engine query, command, projection or worker path. Existing native engines remain producer-owned.

Decision: companion files follow the existing nested `$id_.$slug_.release.tsx` / `$id_.$slug_.file.tsx` route pattern.

Decision: related destinations open the exact disclosed ordinary Subject in the same locale and carry one validated
`fileSource` identity and a bounded reader fragment back to the current reading; only the admitted correction entry opens the existing `/file` profile.

Decision: selected release detail and its correction-return receipt stay local to the admitted release visit. A validated release locator revalidates the occurrence through a fresh native visit; without one, reload or a new tab starts the current release without claiming restoration. Correction receipts and command payloads never travel in the locator.

Decision: VNDB release completeness uses scheme URI `https://rezics.com/schemes/vndb/release-types` because the
importer does not declare a scheme URI for `releases_vn.rtype`; development status keeps `https://vndb.org/development-status`.

## Provider queue decisions

`/{locale}/imports/review` uses the provider queue's current prepared rows. Its selection toolbar acts on at most
20 explicitly checked visible suggestions, scoped to the current source, Context and review status. Changing that
scope clears the selection and any unsubmitted confirmation. Other pages, history and provider-wide selection are
excluded. Queue presence and source provenance never grant decision authority.

Confirmation seals each subject/candidate identity, decision head and independent action key. The session BFF
forwards the current viewer, CSRF protection and native session tokens to each existing candidate accept/reject
endpoint. Accepting is separate from adoption and publication; rejecting does not delete a candidate. Bulk adoption
is unavailable. Every success, stale head, current denial, concealed suggestion, rate limit and unavailable result
is shown separately. Failed and uncertain attempts retain their exact payload and key; retries skip confirmed
successes. An uncertain result stays sealed until resolved. A changed scope clears checkboxes while preserving
the earlier attempt; it must be revisited before retrying under a different visible scope.

The visit retains at most five opaque page addresses. Exact candidate review returns to the original scoped page
and rereads it with current authority. The candidate is highlighted only when it remains on that page and in the
selected status; otherwise the queue reports that it moved or became unavailable. An expired continuation can
be replaced only by an explicit start-over action. Source, Context, status and candidate selection are reset when
the scope changes.

After decisions, refresh the actual queue and current subject readings in parallel. Refresh failure retains the
decision results rather than claiming all rows disappeared. Missing and hidden subjects share a concealed state;
related values use supplied summaries, with no per-field fetches or private totals. An unserved queue preparation
port shows unavailable, never a fabricated empty queue or a successful mutation. Definition labels retain their
locale fallback and remain distinct from a value's data language.

## Canonical public reading

`/{locale}/catalogue/definitions` is the read-only Type and field guide linked from catalogue creation and
native scalar/relation contribution forms. It reads the actual active pointer and immutable release through
the generated client and shared release helper, or exactly the requested `release` digest for a pinned
assertion; it never substitutes the active bundle for a missing pin. Released labels and descriptions use
explicit language fallback, independently of authored value languages. Only effective emitted fields,
datatypes, qualifiers, units, multiplicity, targets and native reference or `sourceOrConsent` rules are
explained. Missing meaning, empty metadata, loading, invalid addresses, concealed definitions and unavailable
reads remain distinct. Help opens in a separate tab to retain the original draft and uncertain request; Return
to contribution permits only the existing localized creation or canonical subject editor address, including
its selected field and statement. A pinned field opened from that editor can compare the original exact
release with the current admitted definition of the same Type and property; unavailable pinned data never
becomes the active bundle, and the comparison does not rewrite or submit the contribution. Current authority, validation and writes remain with those editors and their
private session BFF; the guide has no mutation or publication controls.

The current type, property and release address owns the guide selection, including when a mounted guide is
reused or history returns to an earlier address. A type chosen locally remains selected across ordinary
rerenders of that address; navigation to another definition address resets it before showing content.
Changing only the validated return destination does not discard that local choice.
An explicit guide retry keeps one disabled busy action until its read settles, then focuses the returned field or Type heading (the guide heading if neither exists), or its truthful empty/failure boundary; initial, hydrated and retired-address reads never move focus.

Adopt the complete reader journey recommended by [subject design research](research/web-subject-design.md):
discovery or a collection → current canonical identity → public facts and text → traversable relations, editions
and credits → original evidence and current rights. Work, edition and agent identities remain separate until their
native identity authority says otherwise. Presentation follows released definitions rather than a vertical-specific
store. The research's Wikibase statement model, Open Library work/edition/author navigation, Schema.org role
annotation and Omeka resource templates support these choices; they do not supply a REZICS API or permission.
Research observations describe their inspected revision, so delivered native fixes take precedence.

### Original authored catalogue text

`/{locale}/subjects/{id}/{slug}/authored` opens from the existing subject header actions. It retains the exact
canonical subject identity and offers only document-valued fields admitted by the active emitted Type metadata.
The private, noindex composer prepares the current session before its CSRF-protected server actions run. Field
labels follow the existing locale fallback; the authored text's BCP 47 language is a separate explicit input.
An unavailable or concealed read never supplies a cached document or a privileged public fallback.

The shared rich-text editor starts with an empty Text-profile document for a **new replacement candidate**. It
never preloads, flattens or edits the current document. Existing candidates and all their formatting remain intact.
The contributor declares authorship, enters an SPDX licence or LicenseRef and supplies the supporting citation URL
required by the native statement contract. A citation supports the field; it does not license copied text. Provider
names never determine a licence. Withheld text, user posts and recipe-site methods are not authoring inputs.

Submission uses the existing generated `POST /v1/subjects/{id}/candidates` statement input with inline
`value.content: {document, licence, language}`. The public `@rezics/document` snapshot and native validation govern
shape, language, licence and the 2 MiB canonical byte limit; authored media nodes are refused. There is no new body,
upload or Source-metadata writer. A returned candidate means proposed and awaiting review, never published.
Draft, validation, saving, denied, conflict and unavailable outcomes remain distinct. An uncertain retry freezes the
exact document, statement and idempotency key. A key conflict requires explicit draft review before a new request.
Refreshing definitions or public reading retains the draft. Discard clears only the selected unsent replacement,
including its original-work declaration, and resets the composer with empty undo history; text or nonblank
language, licence or citation requires confirmation with a keep-editing option. Other drafts and public text stay
intact; submitted, uncertain and stale commands awaiting explicit review cannot be discarded locally.
Each discard question binds its original unsent replacement and retires synchronously on Cancel, Confirm, replacement, edit or reading retirement; only a current keyboard action whose question holds focus returns focus to the discard control or fresh composer, while pointer and background actions make no forced focus handoff.

Review opens the existing candidate comparison for the exact returned candidate and field. Its actual statement's
document locator is read through `GET /v1/documents/{id}` with the viewer identity and native session position.
Candidate, subject, language and digest must match before the body renders. Missing, hidden or erased documents
share the neutral unavailable notice. Candidate pagination stays explicit; an absent candidate on a page supplies no
invented body. Acceptance and selection keep their independent native heads and confirmation controls.

The current public text is read independently without the editor's bearer, using the selected rank and existing
language fallback. Its body also comes from the ordinary document endpoint, with current Content disclosure and
rights. Current citations render separately from the work's actual document licence. After a decision the composer
reloads that public statement and body; a receipt or the editor draft never becomes public truth. The overview link
continues to the actual canonical public reader. Story states live under `Pages/Catalogue/Authored text` and use the
shared locale, theme and viewport globals.

Explicit current-text reloads and field changes retire current public text before I/O, preserve private replacement drafts and exact unresolved proposals, and permanently fence preceding callbacks and results; a current-only reload retains an independently read comparison while pending, but refusal removes it until explicit review after recovery.

Keyboard explicit current-text recovery keeps a surviving same-action opener; when it disappears, completion focuses the selected-text boundary, draft form or read-failure boundary, while pointer use, native field changes, background reads, moved focus and retired intent stay quiet.

### Identity and navigation

The [native subject reader](../services/kernel/src/semantic/http/subjects.ts) owns merges, disclosure and the
applicable release; [Accounts](accounts.md#handles) owns case normalization, verified-agent eligibility and former
claim lifetime. The localized subject slug is a label, never an identity. The shared
[URL helpers](../apps/web/src/subject/subject-href.ts) append a supported view to either a subject or an account
address, preserving query bytes and fragments without double encoding. An id-only, stale-slug or merged subject
address redirects 301 to its current canonical address. A native subject read may follow at most one merge 308;
a further merge response is unavailable, not a successful stale subject. The native page endpoint's account 308
is translated to the same website 301, including verification that changes between canonical and page reads.
The existing exported native redirect adapter retains its 308 shape for compatibility.

A verified account with a current handle has one page at `/@handle`, with every supported view retained. A
handleless account supplies no invented `@` address: keep its readable subject identity. Account case correction
uses 308; a current native `movedTo` uses 302 to the current handle, without alias walks. Web does not reproduce
the forwarding clock, active-state rule or claim syntax. All former-handle, redirect, missing and private outcomes
are `private, no-store`; mutable aliases must never receive five-minute caching. Successful public subject HTML
retains the existing [bounded public cache](../apps/web/README.md#routing).

A composed Subject-to-account redirect requires the planned active profile's immutable ID to match the admitted account ID; absent, handleless or mismatched profiles retain the matching catalogue Subject and selected Realm, or return unavailable when that fallback identity is missing.

A closed view redirects temporarily to the overview. A list whose preview contains everything can omit its tab
while retaining its direct view URL. A slug that equals a view name still identifies the canonical overview when
it matches the current localized slug; otherwise that id/view shorthand redirects to the full view address.
Current tabs, frame and list traversal remain with their existing readers, and
[public metadata](../apps/web/src/features/pages/subject-head.ts) continues to own head and JSON-LD.
Subject title years use native astronomical numbering, with a localized era for year zero and earlier,
while positive-year labels retain their current presentation.

### Public data and failure states

Public SSR uses anonymous typed `POST /v1/pages:read` subject targets, including the requested language chain and
view. Preserve the actual subject response `{subject, account, summary, related}`, including its release,
resolution, selected statements, qualifiers and support references. Use current bounded related summaries rather
than extra per-card reads. Neither a presentation profile nor a cached label grants current access.

For each document-valued property a page binds, show at most one released public statement: preferred rank before
normal rank, then the reader's language and the subject's original-language fallback. If eligible statements tie at
that rank and language, the smallest statement UUID in code-unit order wins. `pages.read` obtains that exact body
through the existing `document.get` aggregate; a locator alone is never prose. The page renders an available body
with its language through the shared document renderer. Embedded document controls follow a supplied
reader-interface locale; callers without one keep the ambient locale, independently of that authored language.
A missing eligible reference contributes no body. A body
withheld by Content renders the ordinary unavailable value and contributes no `recipeInstructions`; a failed body
read remains a page read failure and is never converted to an empty or successful value. Public `recipeInstructions`
keeps the existing Schema.org `HowToStep` projection and uses the same selected body as the rendered statement, so
HTML and JSON-LD cannot select different candidates.

Titles, short descriptions and admitted facts render without JavaScript. Validated document bodies in the page's
aggregate response use the existing document renderer; a document locator alone is not prose. Select the reader's summary
language before deciding whether its body is available. If the selected body is unavailable, About retains a real
short description when present and explicitly offers a document retry. No summary is different from an unreadable
summary, and a failed dependency is different from an empty successful section. Retry keeps the current query and
view. Raw document IDs and fixture bodies never establish successful native summary delivery.

Library state, reader preferences, own reactions, own ratings and imported suggestions begin only after viewer
preparation and hydration; their requests use the existing private BFF and `no-store`. Anonymous HTML and its
dehydrated data carry no private values. Public failure never initiates a privileged fallback.

### Selected-fact sources

The overview's Sources entry also opens `/subjects/{id}/{slug}/sources`, a companion reader outside the
Composition view template. It uses the ordinary anonymous `GET /v1/subjects/{id}` with the existing language chain,
current disclosure and one-hop merge handling. Stale identities redirect to the current subject and retain the
query and fragment. Missing and hidden subjects use the same concealed not-found state. Denied, invalid, changed
selection and unavailable responses remain failures; retry reads the same address again.
Only an explicit keyboard Sources retry from the focused Retry button keeps focus on that surviving control or
moves it to the current Sources heading when the control disappears; pointer retry performs the same read quietly.
Decision: use the focused Retry click's zero detail to admit keyboard intent; moving away and back, Tab, window blur,
navigation, locale or Context-reader changes retire that intent, and pending retries issue only one read.

The page groups the currently disclosed selected facts by field, using emitted property labels and released Type
labels with the existing locale fallback. It follows the overview's selected rank, summary-language and safe spoiler
rules. Citation parts belong to the individual selected value; a citation is supporting material, not a verification
badge. Values with no citations remain visible with an explicit notice. Related values use only supplied public
labels, with no per-field target reads. Document and media locators are reading pointers, never rendered IDs, prose
or externally fetched images.

Reuse the existing Sources presentation for any actually returned reviewed provider name, URL, licence and
attribution and for separate cover credit. Provider metadata remains subject-level metadata, never evidence of a
particular field's support. Missing metadata and unknown cover rights are explicit; a structured-data licence does
not license authored text or images. This reader does not create a metadata producer or infer provider identity from
a citation URL.

A supported descriptive field links to the existing Details candidate comparison with `candidateField` selected.
The private review remains explicitly opened after session preparation and uses its existing CSRF-protected BFF;
no candidate or authenticated overlay enters the public sources response. Back to subject returns to that same
public subject. Relation-edge slots continue through their existing target-aware readers.

Unavailable value-explanation reads offer Retry this page with the exact attempted cursor and the producer's
returned session, or the attempted session when no page returned; Back to first page deliberately abandons the
continuation. Denied, missing, invalid or changed readings retire recovery, and every reread hides the prior explanation.
A changed transport or locale rereads from the first page unless it also supplies a new initial reading.
Recovery stays inside the existing viewer/session and visit lifetime; saved controls belong to the read that offered them.
Explicit More, exact-retry and reload results focus the mounted “Why this value?” heading with a visible focus ring
when the same focused keyboard action still owns the read and current result and its opener has disappeared; a surviving
meaningful opener keeps focus. Pointer activation, background/resume work, intervening pointer, Tab or focus movement,
movement away and back, window blur, and retired reads remain quiet; initial and hydration reads do not move focus or add
a completion announcement.

### Recorded changes

The subject header offers Changes at `/subjects/{id}/{slug}/changes`. This private, no-store, noindex
companion page starts reads after browser session preparation. It follows the native revisions list and its
opaque continuation unchanged, including an empty page with another continuation. The current public subject
read supplies its identity, title and return address; it is independent of the authorized revisions read.

Choosing a revision clears any previous detail and asks the same session BFF for its safe explanation. A failed
detail read preserves the revision list and selection and offers an exact retry. Missing or concealed detail has
one neutral state. A current subject refusal clears the page. No historical value, source input or current value
is used to reconstruct withheld information. Only the producer's authorized summary may describe term fields and
data languages, a proposal, a Context decision or an adoption. A proposal, acceptance and current public selection
remain separate; the latest revision is never labelled as the current selection. Return to current reading uses
the ordinary public subject journey. This page offers no lifecycle command or historical snapshot comparison.

Explicit keyboard continuation or retry focuses a boundary for newly admitted unique revisions (including zero and the actual next-page state); keyboard selection or explanation retry focuses its heading, while failed reads focus their own retry or failure boundary. Pointer actions, initial reads and retired results stay quiet. Focus movement, including away and back, pointer interaction, Tab or leaving the window cancels the original handoff; a successful read never revives it.

Loading, no revisions, denied, invalid, changed, unavailable/retry and limited safe detail are distinct states.
The generated client binds the served revision-detail read through the private/no-store session BFF. Consumer
presentation examples do not establish native execution or visual acceptance. There is no guessed detail wire schema or
successful runtime fallback. Definition labels use the existing locale fallback, independently of data languages.

### Open owner joins

These joins complete the adopted journey; naming one here does not claim it is implemented:

| Join                                   | Current authority and required binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary body                           | [Semantic authored installation](../services/kernel/src/semantic/authored.ts) emits `{language, document: id, digest}`. [Content document reads](../services/kernel/src/content/document-routes.ts) supply `{document: {availability, body, subjectId, candidateId, …}}` under current disclosure and rights. [Composition reads](../packages/composition/README.md#reads) currently admit no document descriptor. Content/Composition must provide a bounded, typed selected-summary binding inside the public page aggregate, retaining selected support and current erasure behavior. Web does not guess a descriptor, append per-statement reads or authorize from the locator. |
| Relations, editions, credits and Works | Semantic owns native incoming/outgoing/count cursors; Composition and the sibling traversal region own full outgoing and independent group continuations, labels, qualifiers and truthful counts. Preserve their current inputs and newer integrated fixes.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Original source evidence               | The [source-record attribution contract](../services/kernel/src/semantic/source-record-attribution-contract.md) owns exact original tuples, selected support, metadata and fences. Its deferred producer/import registration and source-readiness bindings remain with those owners; reflective or fixture metadata is not delivery. The imported-suggestions region below retains its independent source review.                                                                                                                                                                                                                                                                   |
| Realm and neighboring sections         | The native freeze below remains authoritative. Production Realm selection/revalidation and each rating, review, discussion and list population require their actual admitted bindings. A Global result never becomes Realm output through labeling.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Focused [canonical journey cases](../apps/web/tests/subject-canonical-journey.test.ts) cover the generated-client
boundary, navigation, request bounds and public rendering using native recorded DTOs and explicit failure responses.
They do not establish live native eligibility, document-body delivery or visual conformance. Full served-page,
current-withdrawal and screenshot review remain integration proof across no-JS, keyboard, phone/desktop, locales and
themes. The reusable [public reading pattern](../apps/web/src/subject/reading-state/index.tsx) has one story identity
across those globals and is the same component used by About.

## Edit a released profile

The subject header and compact view frame offer **Edit facts** at
`/{locale}/subjects/{id}/{slug}/edit`. Without a selected `property`, this is the multi-field catalogue workspace.
A property/statement address still opens the existing single-field correction form. Both keep the canonical subject
identity and its current released Type. This workspace is catalogue data, separate from Puck presentation editing.

The private session BFF starts the ordinary public subject and active-definition reads together, then resolves the
immutable release. Effective emitted Type properties determine the field inventory and order; scalar datatypes
group text/identifiers, dates and quantities. Labels/descriptions use definition-language fallback, independently
of authored value languages. Every selected public assertion, qualifier and citation remains visible separately.
Opening an editor creates a clearly labelled private draft, never a selected public value. Multiple selected values
require an explicit choice of assertion; a multivalued field may instead propose an additional value. Cardinality
still governs the later whole-slot selection, not a client-side collapse of existing assertions.
Scalar Edit/Add keyboard activation focuses the newly admitted private draft heading in the same opening transaction; refusal, moved focus or retired reading/workspace cancels that handoff, and pointer, initial and background renders never request it.

Refresh retains a still-selected source; a withdrawn choice requires an explicit current replacement before editing, even if only one remains or no values remain, while an explicit additional-value action stays separate and other drafts stay intact.

Generic and Manga scalar corrections always confirm local discard, including empty additions; Cancel or Escape preserves the full assertion, while confirmation removes only the original unsent draft, releases its slot and focuses the retained source choice or staging control under current-reading, busy and sealed-command guards.
Each local fact-discard confirmation is a single-use question bound to the exact draft and current reading; Cancel, Confirm, replacement or departure retires it synchronously.
Character classification uses one profile-level Stay/Leave decision across all holders; Stay retains authored assertions and exact unresolved commands through current-reading failures, while Leave retires only local recovery, and untouched empty additions, unchanged source copies or confirmed results alone do not block departure.
Character and StoryArc classification keyboard Edit/Add focuses the new private draft's entity picker; pointer activation, refused staging and read refresh stay quiet, and moved focus or retired holder, reading or admission cancels the opening intent.
Classification correction feedback links unknown or withdrawn pointers to the nearest rendered labelled statement group; unknown statement-level pointers link to the labelled correction-fields group.

Generic fact corrections protect pathname and search-address departure and browser unload for all changed private drafts, including excluded drafts and drafts retained during read recovery, and pending or unknown proposals; Stay preserves exact retries and siblings, while Leave retires local recovery without undoing sent proposals. Confirmed results alone do not block departure, and their inline candidate review remains available without leaving the workspace.

The workspace reuses the scalar editor's native value, qualifier and grouped-citation controls and validators.
Invalid scalar feedback reuses the single-statement correction guidance and stable control associations; editing clears the
submitted violations, and unresolved nested targets link to their matching section fallback.
Existing unsupported parts stay intact. Names and descriptions use the separate actual terms PATCH editor;
relations/credits use their exact-slot editor. Relation qualifier selection only stages a choice; explicit Add
rechecks the current field, datatype, composition position availability and sixteen-part limit, then keyboard Add
focuses the exact new part. Decision: changed field or metadata observations clear the choice and require current
re-selection; pointer use, refusal, moved focus and retired editing stay quiet. Types with document fields link to the
existing [authored composer](#original-authored-catalogue-text) at `/authored` for a new original-text candidate.

A contributor explicitly includes changed fields and submits at most twelve fields per workspace. Unchanged or
excluded fields issue no request. Blank or incomplete values produce invalid drafts, never deletion or clearing.
Each admitted change seals its own immutable statement body and native idempotency key before any request begins.
The existing generated per-subject candidate POST runs once per included field through the session BFF and CSRF
boundary; no bulk endpoint or grant exists. Individual results distinguish proposed, stale, denied, invalid,
unavailable and uncertain delivery. Failed drafts remain available; uncertain/unavailable requests freeze editing
and retain their exact body/key for retry. Definite failures can be edited into a new explicit intent. Later submits
retry only unresolved included fields and never replay a confirmed success. Refresh preserves drafts and keys;
current concealment or failure hides the workspace until a readable response is available again.
Album correction hides current markup as soon as a reload starts, retains private drafts and exact unresolved proposals, and resumes scalar and relation holders only after a fresh read matches the original subject and Album Type; exact review reopens against fresh authority.
Album correction confirms removal of populated or previously edited unsent drafts locally by stable draft identity; Cancel or Escape preserves the full assertion and restores the trigger, confirmation returns focus to the retained source choice or a surviving correction control, and untouched empty additions may remove immediately under current reading and command locks.
Album correction shares the existing page departure decision with relation editors: excluded changed assertions and unresolved commands remain protected through current-reading failure, Stay preserves the entire holder, and Leave permanently retires its local recovery without cancelling native work; pristine source copies and confirmed results permit departure, and same-page candidate review retains the holder.
Game correction retires public identity, current assertions and classification summaries as soon as explicit reload starts, while keeping mounted private scalar, classification and relation drafts; callbacks from earlier reads stay retired even after an equal-subject success. Only a fresh matching read restores public markup and new proposals. Exact unresolved commands remain available through their original explicit retry; reload creates no command.
Game correction composes classification protection with the existing scalar departure owner and relation navigation state in one shared decision: excluded changed drafts and unresolved commands remain protected through reading failure; Stay preserves them, while Leave retires local callbacks and retry recovery without cancelling native work.
Game classification keyboard opening focuses the exact newly staged, named private draft fieldset; pointer opening, failed admission, moved focus and retired draft or workspace intent remain silent.

**Game correction visit**

Decision: preserve the source Context and Realm as bounded intent; non-Global readings show an unsupported
correction state before mounting any Global editor, with a separate, explicitly named Global entry.

The ordinary Subject Game correction entry carries the actual Context, selected Realm, Type and effective release
when supplied by the page. It names an overview, never an implicitly selected classification occurrence. The
installed `/game` canonicalizer reads that Context, keeps the validated intent across slug redirects, and the
session rereads the Subject and active immutable Definition before presenting editing. Subject, Context or Type
mismatch and changed effective release retire editing. The existing session/editor generation includes the full
visit descriptor, so replacing a source cannot reuse a matching earlier caller's query result. No extra session
read or command authority is introduced. Direct Global entry and creation keep their existing flows.

The route intent is at most 2,048 characters and 2,048 UTF-8 bytes. It retains one same-locale, validated relative
Subject source address with only its established Realm selector; no root Context selector, nested history, draft,
reader proof, advice or result is carried. Duplicate selectors, foreign subjects/locales, contradictory Realms and
non-Global sources without a Realm address are invalid. Return links use the source address to request the ordinary
current Subject reading; navigation itself does not claim successful recovery or restore an assertion selection.

The canonicalizer issues one exact Subject GET. Destination admission uses three generated reads: Subject with
explicit Context, active Definition pointer and immutable release. The Subject ceiling is 2 MiB and the release
ceiling is 4 MiB with at most 1,024 Types; oversized responses are unavailable, never truncated. No related-target
hydration, scan, search or candidate refill is added. Existing classification review remains a 20-candidate window,
with at most twelve explicitly included scalar commands. These consumer ceilings do not establish native indexed
growth evidence. Source reading and return keep the ordinary reader's existing finite page limits.

Manga correction retires current and nested public markup when a reload starts or is refused; private scalar, relation and authored holders retain drafts and exact unresolved commands, and resume only after a fresh read matches the original subject and Type, with nested holders rereading their own addresses before explicit retry.
Manga creation's explicit keyboard qualifier Add orients to the admitted stable qualifier's first editing control, falling back to its labelled group; refused additions, pointer use, moved focus and retired row or Type activation stay quiet.
Manga correction shares one departure decision across scalar, relation and authored holders for pathname or search changes and browser unload: excluded changed assertions and unresolved proposals remain protected during read recovery; Stay preserves the complete holder, while Leave permanently releases local editing and retry recovery without cancelling native work. Pristine source copies and confirmed results alone permit departure, and inline confirmed-candidate review retains all sibling drafts.
People correction retains private scalar and relation holders through failed reads; an explicit refresh restores all profile terms, work references and links only from a fresh matching subject, Type and supplied work, while exact review reopens against fresh authority.
The People profile groups multilingual authored biography, occupations and working languages as labelled facts. `schema:abstract`, occupation concepts and `schema:knowsLanguage` bind only when the active release admits those exact descriptors; unreleased requested fields stay named unsupported, distinct from a supported field with no current value and from an independently unreadable current value. Biography opens the existing authored document route with language, document identity, references and return to the original profile. Occupations and languages are independently selected admitted items, not localized free-text identities. A stale selected fact requires explicit reselection. Returned candidates remain awaiting review; public facts refresh only from a new current read. Create, select and publish labels, Japanese 下書き, the credit create-and-return handoff and 44px wrapping stay with their existing owners. Decision: this release admits `schema:abstract`, occupation `wdt:P106` (Concept values) and `schema:knowsLanguage`; requested `schema:hasOccupation` and `schema:occupation` stay named unsupported. Web does not fork definitions. Independent P1365/P1366 stay separate properties with rezics inverse metadata; Organization authored history reuses `schema:abstract`. Ordinary Person and Organization pages attach viewer and Access-derived propose/accept/adopt actions on Global Context; public facts stay independently cacheable.

Decision: Person and Character fact visits filter only displayed text in the active local window (20 rows), with explicit previous/next controls over the supplied native current selection; the whole added projection must fit 1 MiB of UTF-8 and 64 fields/4096 facts. This is not catalogue, candidate or source completeness. One embedded existing ValueExplanationSession retains the original Subject/property/assertion/Context and retires with its profile reading. Modified clicks retain the existing value URL. Close returns to the original row, or its field with a changed-reading notice; existing correction and Sources destinations cannot restore detailed local state after navigation.
Screen correction also retains only private editor holders across refusal, including concealment; only a fresh matching read restores identity, selected evidence, nested editors and explicit sealed retries.

### Screen correction visit and return

Decision: Selected Screen readings retain their native Context and Realm for inspection and return; non-Global
correction is read-only, and a named Global choice starts a fresh correction admission.

The installed `/screen` route accepts one independently validated `screenVisit` descriptor. It binds the canonical
Subject ID, released Screen Type, native Context, optional Realm, locale, effective Definition, one same-origin
overview source, and at most one exact `{holder, property, statement}` occurrence. The descriptor is intent only;
the route performs a fresh native read and verifies ID, Context, Type and Definition before it presents selected
facts. A Global reading may use the existing Global fact and candidate editors. Other Contexts retain the selected
reading as read-only inspection and offer a separately named Global destination. Opening that destination drops the
old visit descriptor and Realm, preserves a valid classification handoff, and performs a fresh Global read.

The decoded visit or return descriptor is capped at 2,048 UTF-8 bytes, its same-origin source address at 2,048
bytes, and the installed route search at 2,048 characters. The combined route search includes any existing
`classificationHandoff`; each destination is refused as invalid when it cannot fit. No field is truncated. Bodies,
drafts, advice, session proofs and command receipts are never navigation state. One current inspection and one source
address are retained. A stale ID, Context, Type or Definition, duplicate/contradictory selector, foreign source,
oversized address or incompatible non-Global/classification-handoff pair yields a recovery page that preserves a
valid handoff on its named Global link.

One already-loaded Movie overview uses one ordinary Subject read, then the Screen reader's three native reads:
Subject in the selected Context, active Definition and immutable Definition. The installed correction visit adds
one canonical Subject lookup and the same three current Screen reads. A fresh return performs one ordinary Subject
read and the three Screen reads again. Therefore a complete Movie overview → correction → fresh return uses 12
Screen/Subject/Definition requests including the initial overview. TVSeries and TVSeason overviews add one current
inverse-membership links page per public admission: at most 20 rows and 1 MiB retained JSON each; the correction
session adds no episode page. Existing signed-in correction advice and any deliberate candidate comparison remain
with their current owners. A candidate page keeps its native `limit: 20`; no Screen entry adds per-row hydration,
automatic refill or a broader scan.

An exact visit is admitted only when the statement ID, holder ID and property still occur together in the fresh
reading. Equal values remain separate statements. Current rank, qualifiers and each reference group render with
released field labels and the existing `CandidateValue`; the full association, including links and accessible text,
stays behind its spoiler gate. Missing, changed, withheld or concealed evidence retires its old action without
exposing its former identity. Returning carries only the bounded locator, then reloads the public overview and focuses
the surviving exact statement, current correction entry or reader heading. Pointer movement, focus/key interaction,
source/caller replacement or another return intent cancels pending focus. The Screen episode visit still owns its
membership locator, cursor and return focus; correction return does not settle or focus an episode visit.
Literary creation retains metadata only for its drafts; a refused or unavailable page or scalar current subject read removes identity, facts and editor markup, permanently retires old callbacks/results, and retains private drafts and exact sealed retries until a fresh matching read restores editing; relation and authored holders reread their original addresses before resuming. An existing Literary correction reload retires current public identity and assertion markup at start while keeping private correction holders and exact retries; only a fresh matching success restores current reading and proposal admission, and callbacks from the preceding observation stay retired across equal-identity recovery.
Story Arc reload starts a new page observation: cached identity, links, facts and nested editor markup retire at reload start, while private holders keep unsent drafts and exact sealed retry intent; only a fresh successful matching Story Arc/work read restores page authority, and earlier callbacks/results stay retired even when identities match. Reload sends no command, and nested holders resume through their existing fresh-address recovery.
Story Arc local arc and work choices share one departure decision across creation, scalar, classification and work-relation holders, including hidden unresolved recovery; Stay retains the exact workspace and opener, while Leave changes only the captured local choice and retires all replaced holders without cancelling native commands. Repeated choices keep the first destination until the decision settles.
Creation metadata refresh errors, including query errors with retained data, block new commands until an explicit successful refresh revalidates all retained terms and facts; exact uncertain retries keep their original command independently of metadata recovery.

A successful field offers its exact returned candidate at
`/edit?reviewProperty={property}&candidate={candidate}` and an in-place comparison using the existing candidate
review controls. In-place review carries the returned native session token; reopening the address performs a fresh
current read. Acceptance/rejection, cardinality-aware whole-slot adoption and ordinary public reading remain
separate explicit steps. The workspace never claims publication or an atomic save. Current private candidate
visibility and current native command authority remain with the existing review/session APIs.
Signing out or replacing the signed-in account retires that editor visit: an old callback, read or submit cannot
reveal its protected candidate or start a new mutation for the replacement account. Pending drafts and retry UI
are gone; the new reader needs an explicit newly admitted visit. An already accepted native write remains, and only
a current-authority readback may disclose it. Private responses stay no-store, and session continuation tokens stay
off URLs, logs and cross-reader caches.

## Propose a cited correction

A signed-in reader can choose **Propose correction** beside an existing scalar fact in Details (also available
where that fact appears in the overview). The canonical subject route `/subjects/{id}/{slug}/edit` retains the
exact subject, property and selected statement address. The editor names the subject and its released Type,
shows the current assertion and citations, and identifies Global as the proposal context. Missing and hidden
subjects use the same concealed unavailable state; a moved subject resolves through existing canonical routes.

Controls follow the current emitted property definition: text and value language, URL or external code, date
precision with its declared calendar, and quantity with explicit admitted units and optional bounds. No unit,
calendar, date precision or word-count coverage is inferred. Known, unknown and no-value remain distinct.
Qualifiers use the property's admitted definitions. Citations retain their statement-level groups and parts.
Explicit current keyboard additions focus the exact new part's first editing control or the empty reference's property chooser (its labelled group when no chooser exists); local identity binds this intent, and pointer use, rejected additions, moved focus and retired or replaced targets remain quiet.
A contributor can remove a qualifier, reference group or reference part added through the current draft controls;
removal immediately returns focus to its surviving add control (or section if no choices remain). Removing the
last added part leaves its local reference group available for another part or explicit group removal. Parts
present when the controls open remain protected; removal never edits selected evidence or submits a command.
Unsupported qualifier or citation values remain visible and are submitted intact with an explanation; an assertion
that is no longer safe under current definitions is rejected without narrowing it. Definition labels use the
existing locale fallback; a value's language remains authored data.

The session BFF sends the generated client's `POST /v1/subjects/{id}/candidates` with only `{statement}` and an
idempotency key. It uses current session authorization and CSRF handling; ingestion Source metadata, term-map
replacement, relations, media and rich document authoring are outside this form. A `schema:name` fact does not
replace labels. The native endpoint owns current Type/release validation, permission and source provenance.
Invalid, denied, stale and unavailable outcomes retain the draft. Reloading definitions retains the draft too.
An uncertain outcome freezes editing until an exact retry resolves the original request and key.

Success means **proposed, awaiting review**. It does not accept, adopt or mutate the selected assertion. The
returned candidate identity and session consistency token feed the existing comparison/review region. That
region selects only that exact candidate, including when it requires continuation; another candidate never
stands in for it. Acceptance and Global adoption remain separate explicit confirmations, followed by the
ordinary anonymous reader. Only the reader's exact selected statement confirms public selection. The public
link uses existing canonical subject handling.

## Imported suggestions

The canonical subject overview and Details offer signed-in readers an **Imported suggestions** region after the
reading content. Opening it loads a private, uncached review through the prepared BFF session; public HTML and
anonymous reads contain no candidate data. A public subject never implies permission to accept or adopt. The
native command checks the current account's permission, and refusal removes the review data from the region.

Choose a named descriptive field admitted by the subject's emitted Type, then traverse its native candidate
pages, twenty suggestions at a time. The review compares the ordinary public field values with a proposed value
and its qualifiers, references and available source-record licence/attribution. Related labels use supplied public
summaries, without per-value hydration. Import details disclose the source record and source/converter revision.
Missing attribution stays missing; the browser does not infer a licence or permission from the provider.

Acceptance, rejection and selection are separate confirmations. Accept and reject use the observed candidate
decision head; rejection retains the assertion. The comparison distinguishes awaiting-decision, rejected,
accepted-but-unselected, actually public-selected and retracted suggestions. A native selected rank without its
ordinary public reading remains unconfirmed. Deprecated assertions do not establish successful selection.

The public-selection draft starts with all currently disclosed selected values, including those outside the
displayed candidate page. Reviewers explicitly include or remove values and choose normal or preferred rank.
The emitted property's multiplicity limits a single-valued field to one selection; multivalued fields permit at
most 32. Rejected, retracted, deprecated and unresolved draft choices cannot be submitted. A draft choice that
has not been redisclosed after reload needs a fresh comparison or explicit removal. Loading another candidate
page, changing fields or reloading does not silently discard the draft, removed choices or edited ranks; newly
disclosed public selections join the draft unless explicitly removed. No hidden count or hidden value is inferred.

Selection uses native Global adoption in replace mode with the observed slot adoption head and the complete
explicit selection. Confirmation shows its values and ranks and explains that unchecked values are replaced;
an empty replacement explicitly clears the field's selection. No per-row action substitutes one candidate for a
multivalued field. Optional exact target, sameAs and qualifier-key addresses remain available to existing relation
callers; browser Context overrides and community editing are not introduced.

Each confirmation carries an independent idempotency key. An uncertain retry retains the exact request, draft,
heads and key and freezes editing until that request is resolved. A 409 retains the selection draft, requires a
reload of the comparison, then another explicit confirmation with a new key. Reload never automatically resubmits.
No command grants permission or changes account scopes; a current refusal removes the review data from display.

After a confirmed command the browser reads the ordinary public subject once without viewer authorization,
carrying the native session consistency token. Only the returned exact selection and its normal/preferred ranks
establish successful public replacement. An accepted suggestion can still need adoption; a submitted adoption
whose public read is not yet confirmed remains pending. Manual reloads check again; there is no polling or
replacement of public page data with proposal or mutation JSON. A confirmed selection links back through the
ordinary canonical subject reader, preserving merge and language handling.

The current native candidate read requires a property and, for relation slots, a target address. There is no
subject-wide candidate or relation-slot discovery read. This region therefore covers descriptive property slots,
including classifications, and does not offer an invented list of imported relation targets or a raw-id entry.

## Withdrawing a just-submitted contribution

After an ordinary field correction succeeds, its exact returned candidate offers **Withdraw contribution** beside
the existing comparison and subject link. The confirmation addresses that contribution alone. It calls the declared
native `DELETE /v1/subjects/{id}/candidates/{candidate}` through the session BFF; original write-revision authorship
and current `statement:delete` authority remain native decisions. Source provenance, subject creation, adoption and
target identity never establish ownership. An unserved lifecycle route remains unavailable, with no local tombstone.
The subject candidate reader offers the same withdrawal and restore for the exact reviewed candidate; native author
evidence remains the only ownership basis.

A confirmed deletion clears the correction draft, private comparison and cached subject/candidate payloads. The BFF
rereads the current subject and candidate slot in parallel and returns only availability, without the removed text or
author profile. The subject keeps its identity. **Restore contribution** requires another confirmation and a new
native `POST …/{candidate}:restoreDeleted`, checking current native author authority and Global `statement:propose`.
It does not change acceptance or adoption, undo moderation/source fences or restore terminal consent/account state.
An actual restore 409 ends restoration in this flow. Missing or concealed reads share the unavailable state.

Explicit refresh replaces prior action assumptions: confirmed availability offers withdrawal, a visible tombstone
offers restoration, and an unconfirmed reading offers refresh alone; only a confirmed restore command reports
restoration.

Decision: keyboard contribution confirmation or exact retry hands lost focus to its current confirmed effect or
refusal after clearing settles; an unchanged surviving retry keeps focus, and moved focus or retired holders stay
quiet. Confirmed effects remain confirmed if clearing throws; availability reads never announce restoration.

Contribution withdrawal and restoration share their enclosing editor's departure decision: only a sent unresolved
command protects route/search departure and browser unload; Stay keeps exact retry recovery without sending, and
Leave retires local recovery and late callbacks without cancelling native work. Confirmed effects or refusals release
that command before any clearing callback; reads and dismissed confirmations remain clean.

Uncertain retries keep the exact operation, subject/candidate, consistency token and idempotency key. The original
server thirty-day window applies; the interface creates no local deadline. Until the producer publishes a deadline
DTO, it displays no invented date or countdown. The temporary typed port uses the generated client's existing runtime
transport and must bind to generated lifecycle declarations when published. Page stories are declared-interface
examples, not native acceptance or visual-review evidence.

## Context review

An actual subject reading links its native Context to
`/{locale}/subjects/{id}/{slug}/context-review?context={contextId}`. This companion editor retains the public
canonical subject frame. It verifies the explicit Context with native `GET /v1/contexts/{id}` after session
preparation and explicit opening. Its label and Global/community scope come from that response. A Realm name
never supplies editorial scope, and this route does not change the selected Realm reader or its publication.

The editor reuses candidate comparison for descriptive fields. Existing exact-slot links may additionally supply
`property`, `target` or `sameAs`, and an admitted qualifier `key`. Those addresses travel intact through native
candidate listing and adoption; a relation property without its exact address is not offered as a scalar field.
The comparison shows separately the anonymous Global values and the authenticated Context reading, with supplied
related summaries. Native adoption and resolution distinguish inherited, replaced, suppressed and unresolved
readings. Relation resolution is field-wide, so the editor labels its disclosed exact-slot preview accordingly
instead of assigning a field diagnostic to one relation or picking a winning candidate.

Global supports replacement only. Community review additionally offers inherit and suppress with an empty command
selection; switching modes retains the replacement draft. Replacement uses normal/preferred ranks and emitted
cardinality. Candidate acceptance/rejection and slot adoption retain their separate observed heads and native
`context:accept` / `context:adopt` checks. Reading or preparing the Context grants neither write permission.

The private no-store session BFF preserves current identity, CSRF, session continuity and idempotency. A stale
comparison keeps the draft and mode, requires reload, then a new explicit confirmation and key. An uncertain
request freezes its exact payload and key for retry. Confirmed writes re-read the actual Context, subject and slot;
a failed reread remains unconfirmed. A local adoption never claims whole-Context publication. A separate link
opens the ordinary public canonical subject. Candidate data never enters public SSR or its dehydrated cache.

### Named editorial Context lifecycle

The Context review workspace links to `/{locale}/contexts/new`, retaining the exact subject and canonical slug
for its review link. `/{locale}/contexts/{id}` opens the same private lifecycle workspace. Both routes are
noindex; Context content loads only after session preparation through the private no-store BFF. A named Context
uses generated `POST /v1/contexts` with its data-language label and existing native creation authority. Success
retains the returned identity and rereads `GET /v1/contexts/{id}` before offering the existing subject review link.
Creating a Context does not publish a catalogue or website or change the Realm reader's selected Context.

A readable community Context offers an explicit deletion request and confirmation; it does not assert ownership.
Global is communal and offers no deletion. Generated `DELETE /v1/contexts/{id}` and
`POST /v1/contexts/{id}:restore` recheck native current resource-owner grants, independently of creation history.
The selected native `GET /v1/contexts/{id}/lifecycle` read supplies current retained lifecycle metadata;
`GET /v1/contexts?deleted=true` discovers only currently readable tombstones with native restore authority.
The ordinary directory defaults to active authorized Contexts and supports prefix selection with an opaque cursor.
An unknown or nonvisible 404 supplies no tombstone or inferred Global Context. No owner flag or browser deadline decides restoration eligibility.
Denial, revoked or transferred authority, conflicts and expired native restoration remain refused outcomes.

Confirmed deletion unmounts private candidate comparisons and drops cached Context labels before rereading the
actual native state. A concealed or unavailable reread displays no old private payload. Confirmed restoration is
separate from successful current reading. Ordinary subjects, contributions and Global selections remain independent;
no page claims cascade deletion or completed cleanup. A failed request keeps its draft, exact action and key.
An uncertain request remains sealed for exact retry; a definite refusal allows explicit review of a new request.
Lifecycle controls admit only their current observed draft, target, action and confirmation; a retained retry may replay only its still-unresolved command with its original payload, key and session.
Current keyboard commands keep a surviving opener or focus their local result/recovery summary after settlement, including confirmed success with an unavailable reread; pointer use, focus movement and retired workspace intent stay quiet.
All actions preserve current session identity, CSRF, native response/session headers and current authority through
the existing BFF. Lifecycle command responses carry identity and state; the lifecycle metadata read supplies the native deadline.

### Editorial Context workspace

`/{locale}/my/contexts` is the signed-in **Editorial Contexts** directory in the existing Web shell. It lists
current readable Contexts, not Contexts owned by the reader. Search, active/deleted selection and cursor navigation
consume one bounded native directory page; an unavailable producer renders unavailable rather than scanning a
catalogue or substituting sample rows. `/{locale}/my/contexts/new` accepts multilingual names and, optionally, one currently released settings ID through
the generated native Context creation method. No-setting creation remains the default. A chosen policy is captured
by native create as `{id,release}` plus the released inherit/suppress defaults; the returned Context DTO is not an
Item.

Empty directory pages with continuation use page-local copy; exhausted later pages offer restart with the same search and filter, while only an exhausted first page uses directory-empty or no-matches copy.

`/{locale}/my/contexts/{id}` reads the native Context and read-only settings/defaults. A disclosed subject picker
links to the existing subject Context review with the selected Context; reading grants no acceptance or adoption.
Creation is offered only from native `viewerActions` on the Global `semantic.context` parent. Community deletion
and restoration use current native actions for that exact resource, never creator history, website scopes or a
copied authorizer. Global has neither lifecycle action. A missing resolver leaves changes disabled.

The generated `GET /v1/contexts` and `GET /v1/contexts/{id}/lifecycle` methods bind the signed-in workspace
directory and lifecycle reads. Each directory entry is exactly
`{id,kind,labels,state,deletedAt,purgeAfter}`; labels and lifecycle dates come only from the current authorized
server response. Create, read, delete and restore remain the existing generated methods. Decision: production
`/my/contexts` reuses the community twenty-row directory parser and native viewerActions/restore deadlines; it
does not infer ownership.

Each mutation seals one payload and idempotency key. Unknown outcomes permit only exact replay while retaining the
draft. Confirmed writes reread native current Context, lifecycle and actions with returned session continuity;
a failed reread never resurrects cached labels or grants. Conflicts, expiry and holds require current rereading
and explicit review before a new intent. Deleted metadata can be displayed only from the lifecycle read, including
a directly opened deleted Context. Server-supplied purge dates are informational: no browser clock grants restore
eligibility or promises success. Context deletion makes its editorial source unavailable and normally allows a
30-day restore period subject to current native permission and retention checks. This workspace changes no
Realm/Space binding, fallback, grant or ownership.

Existing Context deletion and restoration protect route departure and browser unload while sent or unavailable:
Stay retains exact recovery; Leave retires local callbacks without cancelling native work. Ordinary reads and
confirmed commands permit departure even when the subsequent read fails.

Private query keys include actor, locale, directory query/filter/cursor or resource identity. Private data is
removed on actor retirement, logout and denial, and hidden during current rereads. All eight launch locales share
the same phone390/desktop1280 behavior stories. Ordinary Web visual review receives these exact story IDs, each
reviewed at both widths through viewport globals:

- `context-workspace--directory`, `context-workspace--empty`, `context-workspace--search-empty`
- `context-workspace--loading`, `context-workspace--unavailable`, `context-workspace--stale-cursor`
- `context-workspace--create`, `context-workspace--create-denied`, `context-workspace--active`
- `context-workspace--global`, `context-workspace--read-only`, `context-workspace--permission-unavailable`
- `context-workspace--deleted`, `context-workspace--revoked`, `context-workspace--expired`
- `context-workspace--retention-hold`, `context-workspace--delete`, `context-workspace--restore`
- `context-workspace--conflict`, `context-workspace--unknown-outcome`, `context-workspace--confirmed-reread-unavailable`

Theme and locale also use globals; these fixtures make no native or visual approval claim.

## Relation contributions

The canonical Global overview links to `/{locale}/subjects/{id}/{slug}/relation-edit`. The route keeps the
subject's canonical identity and shared frame; Realm readings do not expose a Global writer. A Realm query on the
editor shows the unsupported Context state. There is no browser Context override.

After session preparation, contributors choose an effective released relation property and a real target through
the existing subject picker, or edit one of the public reader's existing relations. Classification properties stay
in descriptive-field review. Qualifiers use released property meanings and item pickers for roles and declared
keys. Decision: admitted relation fields come from the exact Type descriptor; qualifier definitions missing from that
projection are filled from the same pinned release. Existing qualifiers, original names and reference parts survive
replacement proposals. Citations are attached
to the immutable statement submitted through native candidate proposal, not to a presentation document.
Relation draft edits synchronously retire their callback lifetime before advancing its revision; retained target, qualifier, staging, citation and consent callbacks cannot restore a replaced property/source or removed qualifier, while current callbacks keep editing mounted controls.

Removing a populated qualifier or replacing a populated relation draft uses an in-form cancellable decision; blank
scaffolding stays immediate, Cancel preserves values, sources and consent, and confirmation is valid only for the
current editor, reading and field. Restore focus after resolution only if it has not moved outside the decision.

Review addresses exactly the property plus target, or an existing unresolved `sameAs` IRI, and the declared item
qualifier key when present. Target and `sameAs` are mutually exclusive. Twenty candidates and their continuation
belong to that address. A failed candidate read retries its exact slot, cursor and session token; a separate
restart opens the first page. Starting a read retires the previous comparison as decision authority, and changing
slots retires the retry destination and late results. Empty intermediate pages retain deliberate continuation.
Decision: candidate More, exact failed-page Retry and explicit Restart/Reload orient only the same admitted focused keyboard intent; preserve a surviving focused opener, otherwise use the current page, empty or failure boundary. Pointer/background reads, movement away and back, Tab, window blur and replaced or retired reads cancel orientation permanently.
Initial standalone or embedded keyboard Open focuses the admitted property control,
or the truthful empty, unsupported Context or failed/denied boundary; pointer opening, automatic reads, moved focus
and retired intent stay quiet. Composition opening and mutation readbacks retain their existing focus behavior.
The comparison shows the public selection for that slot, proposed qualifiers, evidence,
source details, decision and selected rank. Unresolved references remain unresolved; unavailable summaries never
become invented identities. Related labels come from supplied summaries or the existing bounded suggestion response.

Accept and reject use the observed candidate decision head. Adoption uses the observed slot adoption head and
replaces only that target/key slot with one normal or preferred selection. Retracted and deprecated suggestions
cannot be selected. Each confirmation has its own idempotency key; uncertain retries keep the exact request and key.
A 409 retains both draft and comparison, requires a reread and another explicit confirmation, and never silently
resubmits against a new head. Current denial removes review data from display; missing or hidden remains concealed.

Successful commands reread the ordinary public subject with session continuity. Only the exact candidate in that
slot at an admitted selected rank confirms public selection. A committed adoption with no confirmed public result
stays pending. The canonical reader is refreshed and linked after confirmation; private proposal JSON never replaces
its data. The editor's page stories use the shared shell and locale/theme/viewport globals.

Work Parts explicit keyboard opening focuses the admitted private editor heading, including an already open draft; pointer opening, moved focus and retired opening intent stay silent.
Work Parts lets contributors close one opened correction or staged addition while other private drafts stay mounted.
Cancel preserves picker summaries, statement, citation and focus; confirmed close returns focus to its source action,
and reopening starts a fresh editor from the admitted reading. A changed correction requires confirmation; an
untouched staged addition also confirms because its selected target is authored input, while an untouched correction
closes directly. A submitted, uncertain or stale command and an already proposed relation cannot be discarded here.
Composition Close and Cancel settle only the current question for its original draft holder; cancellation, confirmation, draft replacement and reading replacement retire that question synchronously, and stale callbacks neither close a draft nor dismiss a later question.
Work Parts More, Restart, Reload and explicit read retry orient only a still-current focused keyboard intent: preserve a
surviving meaningful opener; otherwise focus the count-bearing current slice (including empty/no-stream) or the visible
failure alert. Movement away and back, pointer or Tab interaction, window blur, replacement reads and retirement cancel
orientation permanently; independent corrections and exact unresolved commands remain intact. A read action attempted
while busy cancels pending orientation without starting duplicate transport; retired reads stay silent.

The Organization compact frame and Contribute menu add **Producer history** at
`/{locale}/subjects/{id}/{slug}/producer` without widening the shared View enum or replacing `$view`. Parent `wdt:P749`
and predecessor/successor `wdt:P1365`/`wdt:P1366` bind only when the active release admits their direction, range and
inverse; unreleased requested fields stay named unsupported. Display predecessor, successor, parent, subsidiary and
credited role as distinct meanings. Do not infer mergers, chronology or identity equivalence from a name, a date or a
symmetric edge. Repeated credited names do not create organizations. The page is one native bounded relations/links
window with current qualifiers, references and independently readable related subjects; continuation is explicit and
incomplete history is not a complete genealogy. Date precision and unknown status are preserved. Editing opens the
existing admitted relation/fact workflow with exact subject, statement and return context; returned proposals remain
awaiting review. A stale selected assertion requires explicit reselection. Concealed endpoints stay concealed. There is
no inferred global company tree and no per-card fetch loop. Native producer APIs, publication, authorization and durable
semantics stay with their existing Goal; missing producer capability is named unavailable. Decision: this release admits parent `wdt:P749`, predecessor `wdt:P1365` and successor `wdt:P1366` as independent
directed organization relations with start and end qualifiers; Semantic owns configuration and Imports owns
identity/source mapping.

### Ordinary Organization history

The ordinary Organization overview reads history without entering the People editor. It names the released grain,
retains multilingual descriptions, and groups admitted authored/text facts, dates and outgoing organization or credit
relations. The People profile read and biography affiliation model remain shared with correction; the producer model
binds requested predecessor, successor and parent descriptors. Unconfigured predicates are unsupported, not empty
history. An admitted field with no assertions is empty; an independently concealed destination is withheld; a missing
native document presentation is unavailable. No date, label, redirect or repeated credit creates an inferred edge.

Each assertion can open its rank, original statement identity/revision, start/end qualifiers and grouped citations.
Partial date precision remains with the native value. A disclosed destination visit carries a bounded Organization
field/assertion locator in the existing Subject visit address. The return reads the current page and restores only the
same holder, Context, property, candidate, revision and release; a changed, concealed, removed or no-longer-admitted
assertion reports the change and focuses its current field. The address retains no authorized reading snapshot or
nested return chain. Browser back/forward preserves inspection intent and reacquires current reading authority.
Inspection returns focus to its surviving opener and offers the existing exact statement correction address with the
selected Context and Realm. Facts, Relations and Works remain the full reading/correction routes and own their native
continuation and command recovery. Replacing the source, locale, provider, session observation or exposure retires
values, links, open inspection and its return controls. Delayed profile reads cannot revive them; authority retirement
needs a fresh Subject observation.

Decision: the ordinary overview uses one fresh shared People profile observation, and delegates inverse relations and
continuation to the existing Relations/Works readers rather than inferring incoming edges from outgoing facts.
Decision: use a validated Subject fragment containing the exact Organization field assertion and Context; on return,
reopen only an exact match from the current page read and focus the field when the assertion has changed.

**Cost:** One People profile read per admitted composition observation (one Subject GET and the existing active
definition pointer/release GETs), with one request in flight; no per-row hydration, session/exposure reads, commands,
polling or automatic retries. A failed ID-only fallback offers one explicit full-page refresh of the current Context.
The accepted public response is at most
2 MiB of serialized UTF-8 JSON; admission temporarily serializes it once. At most 32 released fields and 20 assertions
per field are presented, with at most 32 qualifiers, 16 reference groups and 16 parts per group per assertion. An
oversized assertion is withheld intact and the overview explicitly directs the reader to full facts/relations.
Only one evidence inspection and its opener are retained in the mounted view. The return fragment is capped at 2,048
characters and retains at most nine fixed locator values; exact resolution examines at most the selected field's 20
assertions. Browser history carries no assertion payload, authorized reading or nested return chain. An explicit
refresh reloads the current page Context; it does not repeat the incapable ID-only fallback read. Work is O(released
fields + accepted public bytes); retained UI references share the one admitted public response and release.
JSON/string/object overhead remains additional memory. Locale strings wrap and all actions have 44px targets in the
existing phone390/desktop1280 theme layouts. Source stories are illustrative, not native or browser verification.

## Statement consent

The relation editor uses the released `disclosure: sourceOrConsent` annotation. For an unsourced assertion,
contributors explicitly declare that its target is the agent linked to their current account before submitting
through the ordinary candidate proposal. The native command validates this declaration; no ownership is inferred
from labels, Source provenance, subject creation or proposal authorship. The returned candidate identity opens
`/{locale}/subjects/{id}/{slug}/statement-consent` with its exact property and relation-slot address. Existing
unsourced candidates in that slot offer the same conditional entry without claiming ownership.

The consent page prepares its private candidate only after session hydration and an explicit opening. A bounded
candidate page and the anonymous public subject read start together. Candidate continuation is explicit; absence
from one page establishes neither ownership nor consent. Empty intermediate pages offer deliberate continuation;
a failed read retries its exact cursor and session token, while a separate restart returns to the first page. Labels come from the candidate's immutable definition
release. Cited assertions follow ordinary sourced review and do not offer consent controls. The native candidate
response supplies no eligibility or disclosed flag: the page says so, separating unsourced/private review from
presence or absence in the current public result.

Decision: only current keyboard Open, continuation, exact-page retry, restart and confirmation transitions orient to their returned assertion, truthful empty, terminal or recovery boundary, or confirmation heading; cancellation restores only its still-meaningful action in the same reading. Pointer and automatic transitions stay quiet, and focus movement (including away and back), pointer use or holder retirement cancels deferred intent. Public refreshes never move focus.

Sharing and retraction require separate explicit confirmations through the generated native
`POST /v1/statements/{id}/disclose` and `POST /v1/statements/{id}/retract` methods. The existing session BFF retains
CSRF protection, current credentials, native idempotency keys and session-token continuity. Only the current native
target-account check grants the action. An uncertain response retains the exact operation, identity and key;
denial or concealment clears prepared values. Invalid/conflicting requests require fresh review and confirmation.

A confirmed write triggers an anonymous public reread of the same subject with the native session token. Consent
sharing is separate from current public selection and availability. Retraction is terminal for this assertion,
not contribution deletion or Account preferences: there is no undo or 30-day restore. Confirmed retraction clears
the assertion payload; a lagging public result reports pending removal without returning that value. Public-read
retry never repeats a confirmed mutation. Private reads and values use no-store responses and component state,
never public SSR, dehydrated query caches or local-success previews.

Refreshing the public result keeps the open confirmation and ownership declaration for the same candidate read.

## Principles

- **Readers first.** A page shows covers, titles, people, scores, what people say and what to do next, in words
  readers already know. Contexts, revisions, identifiers and provenance sit at the end of the page or behind
  "Details".
- **Nothing raw.** No value is ever shown as an internal identifier, a media id, a document id or a property CURIE.
  A value the page cannot present is left out of the reading view and remains available in Details.
- **Every list is traversable.** A preview shows a few items, an exact or "at least" count, and a link to the full
  view. A full view pages with a continuation, never a fixed slice.
- **One type system, no per-vertical code.** Which views and sections a type shows comes from its presentation
  template and the data that exists, never from a branch on the type's name.
- **The page works without JavaScript.** Every view is a server-rendered URL; personal controls hydrate on top.
- **Honest states.** A section whose read failed says so in a sentence with a retry; it is not silently empty and it
  does not break the rest of the page. A contested fact shows as unresolved, with a link to the competing claims.

## Views

A subject page is a set of views, each with its own URL under the subject's address:

| View       | Path          | Shown when                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview   | `/`           | Always                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Editions   | `/editions`   | The type has editions or releases, and at least one exists                                                                                                                                                                                                                                                                                                                                                                                                        |
| Contents   | `/contents`   | The type has ordered parts (volumes, episodes, chapters, routes) and one exists. The work-parts editor can review explicit native-string positions for memberships on the loaded page; each change is an independent proposal. A TVSeries parts view can open episode creation with that series as a confirmed membership suggestion and return to highlight the new child on the current stream page, or show its located identity without scanning later pages. |
| Characters | `/characters` | At least one appearance exists                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Credits    | `/credits`    | At least one credit exists (staff and cast)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Relations  | `/relations`  | At least one relation exists in either direction                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Reviews    | `/reviews`    | An open read exists (shown with an invitation when empty)                                                                                                                                                                                                                                                                                                                                                                                                         |
| Discussion | `/discussion` | An open read exists (shown with an invitation when empty)                                                                                                                                                                                                                                                                                                                                                                                                         |
| Lists      | `/lists`      | At least one public collection contains the subject                                                                                                                                                                                                                                                                                                                                                                                                               |
| Details    | `/details`    | Always: every fact with qualifiers, sources, identifiers and history                                                                                                                                                                                                                                                                                                                                                                                              |

A person or organization shows Works (their credits, grouped by role) instead of Credits, and Characters (roles
they voiced or played) when any exist. A character shows Appearances (works, with role and cast) and Relations.
A Realm-routed page adds nothing to this list; it changes the population of scores, reviews and discussion (see
[Realm context](#realm-context)).

Repeated previews of the same planned list, including different limits, contribute its strongest supplied count once (an exact total before a lower bound); any unknown total stays unknown, distinct lists add as before, and every preview must independently fit before its tab is hidden.

Views appear in the order above. Each tab shows its count when the count is known. A view whose feature is not open is
left out, with no panel or notice; its URL redirects to the overview. A view with no data is left out, except Reviews
and Discussion, whose open reads invite the first contribution when empty. A list view whose items all fit in
its overview preview, with nothing to filter, has no tab: the overview section shows all of it without a "See all"
link, and the view's URL still renders. With typical catalogue data (a median work has about five characters, two
credits and one relation) most subjects show Overview, Reviews, Discussion, Lists and Details, and no tab repeats
the overview. A template may give a view the vertical's word (Contents is "Episodes" on an anime, "Volumes" on a
manga). The tab bar stays in view under the top bar while the page scrolls. On narrow screens it scrolls
horizontally with the active view in sight; it never wraps into several rows.
The bar is navigation between URLs: ordinary links expose the current page with `aria-current`, and retain native
keyboard and modified-click behaviour. A defined list whose read is unavailable stays reachable without an invented
count; a concealed or closed read does not expose a tab. A full-view frame supplies one compact identity. A single
paged list owns its own heading and continuation; the frame adds a page heading only for documents with several
groups or without a list heading, and never repeats a list's continuation.

Relations retain one native page per stream: successful More replaces it, pending or transport failure preserves its exact retry, native refusal removes it, and repeated cursors or 64 successful requests (including the supplied page, excluding retries) require a native first-page restart; empty pages follow their actual continuation and announcements count only the accepted window.

Members continuations reject conflicting native subject IDs, route template keys and available account identity reads before projecting rows; the DTO cannot independently prove a handle-to-ID relationship without an account identity read, a generic fallback's route or the selected view, so those remain with native target resolution and canonical changes return to ordinary route handling.

## Agents

People, organizations (studios, publishers, bands, groups) and automated agents are agents, whether they arrived
as catalogue subjects (an author imported from a source), as accounts, or both. Every agent has exactly one page.

- **One agent, one page.** An account is an agent. When an account is verified as a catalogue person or
  organization, the two are one agent with one page at the account's `/@handle`; the subject's address redirects
  there. An agent without an account keeps its subject address. The page is the same either way.
  While the account is suspended its page is not served, and the subject's address serves the subject page.
- **Views.** An agent's page is a subject page: Works (credits by role) and Characters come from the graph; an agent
  with an account adds its public posts, reviews and collections; an organization adds its members and, if it
  chooses, the accounts that speak for it. The view rules above apply unchanged.
- **Speaking for another agent.** A person's account acts for an organization through membership in that
  organization; what it publishes as the organization is the organization's speech and appears on the
  organization's page. A pen name or a collective name is its own agent, related to the people behind it; a link
  that is not already a sourced public fact is shown only when the people behind it make it public.
- **Who controls what.** The agent controls its self-presentation: display name, avatar, bio, links and which of its
  activity views are public. Sourced facts about the agent (dates, credits, affiliations) stay under the ordinary
  edit and review process with their sources; the agent can dispute them there but cannot remove them by owning
  the page. Its own statements about itself are accepted with the agent as their source.
- **Verification before merging.** An account becomes a catalogue agent only through verification. An unverified
  claim never merges pages or changes attribution.
- **Separate personas are separate accounts.** A person who wants a reading life apart from their author page uses
  another account under the same controller; ratings still count once per controller.
- **Never inside a Realm.** An agent's page is never routed inside a Realm or Zone. A Realm is a venue where the
  agent speaks, not where its identity lives.

## Overview

The overview answers "what is this, is it for me, and what do I do next" in the first viewport, then previews every
other view. Sections a type does not support are left out; the rest keep this order and stable anchors.

1. **Identity and next action.** Cover; title in the reader's language with the original title quietly beside it;
   type and date; principal creators, linked; the headline score with its population and count; the reader's own
   status, progress and rating with one primary action (Continue, Start, Add). On phones the cover is a thumbnail
   beside the title. The primary action area follows that row at the full available width on phones: Library,
   progress, copies, Follow and Contribute retain their owner controls and never compete with the thumbnail for a
   narrow column. On larger screens the header's top right holds the reaction cluster (like, love, laugh, insightful and sad, each with its count; a
   subject has no upvote or downvote because its score is its rating) and an overflow menu that carries copy link
   and report. One reaction per reader; choosing another kind replaces it. Signed-out readers see the counts and a
   sign-in link. Signed-in readers can retry a failed own-reaction read from the header; each retry starts a fresh
   page-scoped observation, stays disabled while pending and keeps public counts visible.
2. **About.** The summary (spoiler-safe by default), a short set of key facts chosen by the type's template, genres
   and the most-used tags, and content warnings.
   When a subject has no summary, About shows its short description instead, and the header never shows one.
   Long summaries start with a plain excerpt of at most 420 characters and two paragraphs, excluding spoiler-marked
   text. A native Read more / Show less disclosure preserves the complete rich document, links and inline spoiler
   controls without clipping focusable content. An unavailable document keeps its actual unavailable state; a short
   description may accompany it. The first eight template-selected fact groups show at most three values each, with
   up to six ordinary tags and six spoiler-gated tags. Details remains complete, including all additional values,
   qualifiers, references and tags, and About links to it. Spoiler buttons name their current Show / Hide action.
3. **Parts.** For types with parts: the next part for this reader, then the ordered list preview.
4. **Relations.** Related subjects grouped by relation group (order, derivation, world, membership), each with
   cover, title, relation label and date. Series order is shown as order, not as a list of links.
5. **Characters.** Main characters first, then supporting, each with portrait, name, role and cast.
6. **Credits.** Principal staff by role, in credit order.
7. **Ratings.** The score distribution, count and population, the reader's Realm scores, and a link to Reviews.
8. **Reviews and discussion.** Public Global and native Realm review/discussion windows retain Content's order,
   bylines, canonical thread links and bounded continuation. Current cards mount only the controls admitted by
   Content's selected-card advice on the exact thread and first-post revision. Recorded value, historical scale, question revision and original
   target remain independent of current question, personal vote and selected population, including zero, retired
   questions and merged targets. A citation without its own complete native provenance stays unavailable.

Content's `listSubjectThreads` and `SubjectThreadsResponseSchema` add current context and reaction freshness; the
retained producer's `reviewContext` supplies a current question, not a historical scale snapshot. The generated
client still declares ordinary ThreadView rows. The default reader consumes Content's installed current card through the existing generated method: disclosed
thread authors, document language/spoiler presentation, opening-post-owned media and public activity coverage.
Its exact/lower-bound reply count remains independent of nullable last activity; missing coverage is unavailable.
The optional versioned `card` seam separately binds historical citation, media and activity to the exact first-post
revision without changing generated declarations. It remains a historical interface, not evidence that the installed
producer supplies historical scale, lifecycle or original-target facts. `recorded` must exactly equal the first post's citation. `question` supplies its own historical id, revision,
label and min/max/step; current lifecycle is separate. `originalTarget` retains its id/label even when `mergedInto`
names the current Subject. Withheld citation has no partial provenance. Media must belong to the same thread and
be declared and referenced by that exact document; it uses the existing media renderer without hydration. Native
activity, reaction counts/freshness and citation disclosure use their existing owners. Runtime selected-card action
advice is parsed separately from historical presentation and retained only as four control states; generated
declarations and `reviewContext` grant no actions. Accounts retains Realm membership, Semantic retains
identity/context authority, and Content remains the action authority.

Decision: Bind controls only to Content's current selected-card advice on the exact thread and opening-post revision; `post.create` opens that thread's existing reply owner, and new-thread creation stays unavailable until Content supplies a concrete Board target. Current `reviewContext` grants neither historical provenance nor action authority.

Decision: render Content's current card disclosures independently of historical citation; retain exact/lower-bound
public activity and at most two opening-post-owned images, and never fill withheld native authors from the public author batch.

The native card's media container is the opening post and each image must be declared and referenced by that exact
document. Spoiler content stays behind the existing disclosure. Admitted overflow uses the existing report menu,
original canonical thread target and route verification configuration; absent configuration links to the thread owner.
Selected opening-revision replacement retires the complete card even when control states happen to be equal.
The historical extension alone retains its thread-container contract; current native cards never fabricate it.

Community reading cost:

- **Session:** Session/CSRF and exposure replacement uses the existing cache observers and adds zero reads.
- **Page:** One native page per region (five overview/twenty full-view rows) and at most one shared author batch for ordinary rows; zero
  added question, vote, media or per-card reads. The page supplies each card's current reaction/viewer baseline and
  watch baseline. Sparse continuation never refills. Retry repeats the opaque cursor. A full region mounts at most
  twenty reaction controls and twenty watch controls.
- **Commands:** Each deliberate reaction change sends one exact-thread write with one idempotency key; an
  unresolved intent retries that same key. Each watch toggle sends the one desired-state PUT/DELETE currently
  admitted by the page, and exact retries repeat the same desired state. A confirmed watch transition spends that
  page's advice, so the inverse control waits for a fresh native page. There is at most one pending reaction command and one pending watch command per
  card: twenty of each in a full region. Reply opens the existing thread `post.create` owner. Overflow opens the
  existing thread report owner. New-thread creation has no concrete target and is not mounted here.
- **Readbacks:** Neither reaction nor watch reads on mount. A successful reaction write performs at most one exact
  thread readback; a deliberate reaction recovery check also performs one read. At most twenty current reaction
  snapshots are retained, each with at most seven counters, one viewer slot and one freshness pair (140 counters
  total). Watch performs no automatic readback; each deliberate Check again performs one GET, and at most twenty
  one-boolean watch states are retained. There is no read history or action polling. At most twenty reaction and
  twenty watch readbacks can be in flight for a full region.
- **Bound:** Source row ≤2 MiB + 64 KiB JSON bytes; page ≤`limit * rowBytes + 64 KiB`, or 43,319,296 at twenty;
  card extension ≤32 KiB; normalized thread ≤48 KiB. Text fields ≤4096 UTF-16 units, excerpts 280, licences 128,
  language tags 64, timestamps 40, decimal source/freshness positions 20. Realm title ≤2048 units/4096 UTF-8 bytes.
  Native media admission inspects ≤32 supplied images within 32 KiB and retains the first two in supplied order.
  Each retained card has ≤2 images with ≤12 derivatives each, hence ≤40 images/480 derivative entries per full region;
  media credit text ≤1024 units, credit licence ≤80 ASCII characters, ≤4 unique obligations, dimensions ≤65536,
  placeholders ≤128/64 units. Seven reaction counters per thread are never summed. Counts are safe integers,
  scale units 0–4096, revisions positive int32. Action advice is capped at 512 KiB JSON per card, two references,
  256 operations per reference and 64 UTF-16 units per action/operation-id string. A twenty-row page inspects at
  most 10 MiB of action advice. Web retains four fixed control states at ≤128 JSON bytes per row, ≤2560 per region;
  operation lists and command history are discarded. Cursor ≤4096 units,
  ≤12,288 UTF-8/24,576 JSON-escaped bytes; local observation UUID 36 ASCII characters. Byte admission caps are
  stricter when several text maxima coincide; oversized extensions withhold only dependent presentation.
- **Memory and Growth:** One raw accepted window, one normalized window (≤20 × 48 KiB), one context/cursor,
  ≤20 author keys, ≤2560 JSON bytes of action state, ≤20 pending reaction intents, ≤20 pending watch commands,
  and ≤20 reaction snapshots (≤140 counters) per region, and no retained prior card tree or source registry. Watch
  status retains at most twenty booleans. Admission temporarily creates
  page JSON/UTF-8 copies and one row/card/normalized-row copy at a time. Parsed-document and JS object overhead
  remains additional; these are logical admission bounds, not exact heap measurements or a transport-input cap.
  Native author display name/handle each retain ≤4096 units, presentation language ≤256 units, and activity one public count/source pair. Projection/rendering/source comparison is O(N + admitted bytes), N≤20. Consumer checks at 1/5/20 rows do not
  establish Content's raw80 or independent 256/1024/4096 growth evidence. Control concurrency remains bounded at
  one owner of each action type per row; repeated network attempts require deliberate user actions and add no
  retained command history. The [page reader contract](../apps/web/src/features/pages/README.md) defines the closed seam.

Connected Current Reading stories cover anonymous/member/writer, admitted actions with truthful recovery, zero,
changed current scale, retired/merged targets and concealed context. 390px/1280px light/dark browser review remains
for the controller; frozen acceptance entrypoints are unchanged.

9. **Lists.** Public collections and reading orders that include the subject. 10. **Sources.** Cover credits, source records for the facts shown with each source's licence and attribution,
   external identifiers, and a link to Details.

Community pages decode only against their planned native request and its row limit; missing request metadata or malformed rows make that region unavailable. The DTO omits place, so native board placement remains authoritative.

Decision: every completed community read starts a fresh local visit even at the same URL; retired cleanup cannot
retire its replacement. Local visit identity grants no native authority. Continuation and retry retain the opaque
cursor within Content's nonempty 4096-character bound; continuation and recovery links have 44px minimum targets.
Decision: a retired native observation stays unavailable through an away/back browser epoch; only a fresh native
observation may admit cards again. Mounted regions observe the existing session/CSRF and exposure caches, retire
their cards, media inspection/retry, citations and activity on replacement, and return a removed card's keyboard focus to the surviving heading.

Every preview shows at most twelve items (fewer for reviews, threads and lists) and links to its full view when
there are more. A subject with only a
title still renders a complete page: the cover placeholder, the title, an empty-state invitation to add facts, and
Discussion.

Section anchors use their stable composition node IDs. Reader headings and full-view links use familiar localized
view names, while relation labels still qualify the rows. Subject identity and page/view headings use Manrope;
serif remains for document Work titles and cover placeholders. These bounds reuse the native aggregate and existing
continuation URLs; Overview performs no extra reads or per-item hydration.

## Covers on pages

The cover area always renders with a portrait 5:7 default for every subject Type, matching Collection cards and
lists. Explicit valid released frame ratios remain supported. Wide artwork stays whole inside the reserved frame,
with the designed placeholder when there is no image. On a subject page, the cover opens a viewer with the original
image and its credit; credits and notices are collected in Sources at the end of the page, never as a caption. See
[Cover](../packages/ui/README.md#cover).

## Disclosed artwork facts

An ordinary non-cover media fact retains its original statement, role label, qualifiers and Sources/correction
handoffs. Its media ID is resolved through the original `threads/document-media.ts` reader and displayed through
`NativeDocumentImage` and `DocumentImageInspector`. Nullable credit and placeholder stay nullable. The selected
header cover remains on the Cover family and is not repeated as another assertion's image. A canonical media ID
without an admitted image stays unavailable; other media values have an unsupported state with no guessed URL.
Omitted metadata cannot distinguish denial, absence or the producer's expired empty envelope. It never proves
that the subject has no artwork or that a source was uncited. Image credit belongs only to its delivered image;
statement references remain on the exact original statement through Facts and Sources.

Decision: each visit uses one explicitly selected artwork window, loaded on View/Show artwork; selecting another
fact replaces its summary and inspector instead of accumulating thumbnails or issuing automatic per-row reads.
This reversible presentation choice retains one image while using the existing batch operation with one ID.
Statement spoilers must first be revealed; suitability `blur` separately requires Show artwork without claiming
that the image is classified sensitive. Neither gate mounts an image or resolves metadata before reveal. `show`
uses the reader's deliberate setting. Hiding an image unmounts its inspector. A new Subject, Context, release,
reader/credential observation, source object or original statement retires its state, including A → B → A.
After a credential observation changes, artwork needs a replacement page source before another metadata read.
Ordinary dialog close restores its trigger; retirement with an open dialog focuses the current Subject group.
Failure offers a section-only retry and leaves the remaining facts readable. Media success supplies no correction
authority; the existing original-candidate/editor handoff remains independent.

### Artwork composition cost

The native page retains `MAX_PAGE_READS = 16`, `MAX_PAGE_COST = 128` and the original admitted decoded Subject
payload; artwork adds no Subject, history, citation or related-object reads and does not copy a candidate payload.
For original decoded bytes D, rendering is O(D) and the retained current assertion identity is at most D. The
artwork window is N = 1 (within `DOCUMENT_MEDIA_LIMIT = 32`), one metadata request per explicit selection or
failed-section retry, one summary and one inspector. No lookup or retained index depends on unrelated subjects,
media or obsolete statements. The native producer enumerates N exact `(route, media_id)` keys, at most 12N
variant rows, and at most 2N derivative verifications, preserving its existing bounded parent/source/final anchors.
The current producer returns one largest WebP, or AVIF fallback; the renderer uses only returned slots and the
existing site `/media/<id>/<format>-<width>` transport.

`ARTWORK_RESPONSE_BYTES` derives a 23,272-byte receiving ceiling from the closed `DocumentMediaPageSchema`:
three 1024-character credit strings at six bytes per JSON-escaped code unit, an 80-character licence, four bounded
obligations, twelve variant records, the nullable 44-character hash and a 2048-byte allowance for closed keys,
identities, punctuation and numeric tokens. Oversized wire envelopes are rejected before JSON decoding; injected
decoded envelopes are checked again without truncation. A supplied transport TimeoutError remains a timeout;
missing requested metadata remains unavailable. At 64/512/4096 unrelated objects/history this composition still
adds one request, at most that response ceiling, no citation bytes, and one retained image. Focused composition
tests exercise the real client/reader boundary; they do not claim native SQL growth or mounted native seed success.

## Relations, characters and credits on pages

Relations are shown from the reader's side of the fact: on a sequel the original appears under "Prequel", using the
property's inverse label. Symmetric relations appear on both sides under the same label. A relation group shows its
count, and the full Relations view pages through each group.

Characters, credits and relations come from the subject's facts on every page; they never depend on a wiki Zone,
a Realm or any other site having been set up for the subject.

Characters and credits are grouped by role and ordered by the stated credit order, then by name. A credited name
that differs from the subject's display name is shown with the credit. Spoiler-level qualifiers hide the
character, role or relation behind a reveal control according to the reader's spoiler setting.

Relation reveal consent follows the statement occurrence, delivered content, page subject, selected Context and reader gates; indistinguishable duplicate occurrences use their occurrence order, while unchanged relations retain consent across rerenders and reordering.

Custom relation types from a selected Context appear in their own group under their own label, after the bundled
groups, and are labelled with the Context they come from.

## Character appearances and relationships

### Character-origin work visits

The Character overview links directly to its public work appearances in the existing Connections reading. An
anonymous reader sees the admitted incoming `schema:character` window as **Work appearances** and the independently
admitted, Character-qualified incoming `wdt:P725` window as **Voice performances**. Both reuse the current loader,
section state, released labels, shared covers, qualified values and native Previous/Next/Retry controls. Other connection
streams and the signed-in Global correction workspace retain their separate uses. Character identity and main
character associations remain their released producer's assertions; neither appearance roles nor voice credits
establish identity.

Each row keeps its exact disclosed work holder, original property and statement. Duplicate assertions to one work
stay separate. Role, performer and source information comes only from that assertion and its supplied summaries.
Missing role/performer qualification is named as unavailable. A withheld work has no caption or destination. Source
spoilers gate the entire row, including evidence actions, and native withheld counts never become local group totals.
An original assertion without qualifiers still links by its native holder/property/statement identity; missing
identity leaves inspection unavailable while retaining the independently disclosed work destination. Original
inspection deliberately opens the existing public value destination in a labeled new tab. It does not construct a
correction candidate or an immutable historical Item. Empty disclosed references mean no disclosed citations.

Decision: Character work visits use the existing Characters and Credits sections as separate loaded-window views;
original assertion inspection uses the exact-holder public value destination in an explicitly labeled new tab.

Ordinary work links retain normal modified-click behavior and the single bounded Connections return locator. The
existing parser derives Characters/ Credits section ownership for these two exact native stream keys, preserving
cursor, reading fingerprint and original holder/statement focus. Current Context is rechecked by the native loader;
Realm and locale remain in the canonical return destination. Changed readings require an explicit stream restart;
a missing selected row reports its absence and offers that same restart. Focus restoration yields to user movement.
The shared session observation retires even batched session A/B/A results; replaced Character, Context, locale,
release, reader or route windows cannot accept retired callbacks. Private workspace drafts are not part of this state.

**Cost:** Initial loading remains two page aggregates, one active pointer/release pair and one selected stream per
nonempty native section: `4 + g <= 7` HTTP calls. The Character default chooses the admitted appearance and qualified
voice directions; it adds zero calls. An explicit selected-stream replacement costs five calls, including exactly
one existing native stream read. View composition consumes only its already loaded section. Three windows retain
at most `3 * 12 = 36` rows and `3 * 1,048,576` UTF-8 JSON bytes. Inverse projection requests at most 256 distinct
holder/qualifier/reference summaries per response, so three sections supply at most 768 such summary entries before
per-assertion reuse. Qualifiers and references have no additional fixed array cap in this DTO; they and their strings
are charged within each admitted response's measured UTF-8 bytes. Processing is linear in those supplied rows and
bytes. No cursor drain, per-row Subject read, graph expansion or additional SQL producer is added. The optional
Search-owned qualified work-context projection is not present on this native links DTO; no replacement enrichment
pipeline is introduced.

The released `wdt:P725` voice stream is admitted only for the exact `wdt:P453` slot key and the Character filter.
Its native request page accepts at most 20 rows; the Character visitor requests 12. One indexed SQL statement merges
the Global and selected Context projections, examines at most 20 ordered keys (at most 40 layer seeks plus two
lookahead seeks), and returns the last examined key when more work remains. Current selected-holder hydration checks
at most 20 candidate statements in one batched current-fact read, selects at most 12 current rows for output, and
hydrates their current statements by source home (at most 12 homes). At most 256 distinct related Subjects are
resolved for labels and assertion disclosure. Each statement retains the native admission bound of 16 qualifiers,
16 references and 16 parts per reference; complete response bytes are charged by the existing 1 MiB stream adapter.
The direct native Character preview selects at most 15 document bodies, caps each source at 262,144 bytes, and caps
the retained documents map at 1 MiB, independently of relation lookup; page composition retains its existing 2 MiB
native document limit. If the index scan reaches its 20-key cap before finding
enough current assertions, the response includes `partial: true` and a continuation after the last examined key;
the reader presents this as incomplete. Projection freshness can independently be eventual through the existing
10-second deadline. The bounded growth test covers 64/512/4096 same-Character projection degree and unrelated
history, charging statements, examined rows, blocks and response bytes. It does not establish imported Kurisu admission.

Decision: the Character `wdt:P725` inverse keeps the released `wdt:P453` slot key, reports a capped scan as partial,
and resumes from the last examined projection key while keeping the `wdt:P725` main value as the performer.

Focused mounted cases exercise assertion separation, selected-window return, independent retry, withheld/spoiler
rows and session/Context retirement. The adapter64/512/4096 case measures typed calls, retained rows and response
bytes on native-shaped doubles; it is not native SQL growth evidence. Existing current-relation and directed-credit
native growth acceptance, the actual seeded Character walkthrough, keyboard and 390/1440 light/dark captures remain
integration acceptance. Earlier profile and credits references inform public-read/edit separation and per-read retry;
no legacy implementation is ported here.

A Character page distinguishes appearing in a work from a directed character-to-character relationship. Appearances
are the inverse of admitted `schema:character` statements on works. Role, credited name, spoiler level, part and any
admitted appearance-specific quantity (including age at that appearance) stay on that exact work statement. They never
overwrite the character's timeless biography, traits or measurements, and they never imply another character identity.
Voice credits (`wdt:P725` with the character qualifier) remain an independent stream.

The Character correction entry preserves the current Subject Context and optional Realm through read admission; its
Global-only mutation boundary and exact-evidence return are owned by [catalogue editing](catalogue-editing.md#correct-an-existing-character-from-the-selected-reading).

Relationships are admitted association or world item properties whose targets include the character Type, read forward
and inverse from the current release. Direction uses the property's labels and inverse labels. No relationship type,
privacy inference or automatic merge is invented on the page. Classification ballots and source figures stay with their
existing owner.

Work appearances and Character-to-Character relations remain separate groups in the existing public Connections
window. The Character relation presentation selects and pages that one current Relations stream; it adds no overview
reader or target-subject reads. Incoming rows name the original holder and the released inverse meaning, with a
separate original-property label when it differs. Every exact statement offers the existing original-assertion
destination, while a target remains usable if statement identity is unavailable. A current page with no rows, a
withheld summary, missing release configuration and a failed stream keep distinct states. Previous, Next, Retry and
restart operate on the selected native window, and returning validates its stream, retained cursor addresses, reading
and assertion focus before restoring focus.

Unavailable configuration (age-at-appearance, main-character linkage, character-to-character properties the current
release does not admit) is named on the page. An independently unreadable stream keeps the character identity and the
other groups. A vanished endpoint keeps its count semantics and drops the unreadable summary rather than substituting
another subject. Type descriptors for holders on the current page are read at most four at a time, deduplicated within
that page, and not retained between calls.

Correction opens the existing qualified relation editor with the selected statement, slot and holder, then returns to
the same character, stream, cursor and selected work. Candidate review and Changes remain their existing surfaces.
Changing the character, the selected work, the release or refusing the current reading retires previous rows and
action authority before recovery. The Character identity editor keeps its existing groups; this reading does not fork
the descriptor producer or the generic relation editor.

Decision: appearance-specific age, role and main marks stay on the work's appearance statement. The current release
admits appearance age (`wdt:P3629` in years) on that statement, the Character identity association
(`rezics:relatedCharacterIdentity`, VNDB `chars.main`) and spouse, sibling, father, mother, partner and rival
relations targeting Character. The appearance role code `main` remains a protagonist role. Older releases still name
age-at-appearance, main-character linkage or character-to-character properties unavailable when they omit them.
Unknown Bangumi relation codes stay unsupported provenance. Character pages reuse the existing viewer/actions
envelope and add released identity meanings plus unavailable configuration; they do not introduce a second
permission engine. Viewer-bearing `POST /v1/pages:read` stays private,
no-store; public facts remain independently comparable after omitting viewer.

Decision: source spoiler qualifiers gate the whole association until explicit reveal; reader image suitability applies to shared artwork because public summaries have no association-suitability field and withholding an image does not withhold the subject.

The base-source review confirmed that Character already mounts the generic public Connections window; the new visit is
only its relation-row presentation. Focused mounted tests and the 64/512/4096 adapter measurement exercise the
consumer boundary. They do not establish native SQL growth or actual seeded page admission. Native producer suites
remain with their owners, and a fixture story is not mounted-seed evidence.

## Person voice credits

The Person page keeps the released `wdt:P725` voice-credit group separate from author, contributor and other work
credits. The current catalogue release is `1.0.4`, pinned by
`sha256:1ded81205f3588d10a0cb5dab75bfaec1fcb22cac3e2e54809cf0086f54806f7`. Its direction examples are
work `schema:character` → Character `rezics:appearsIn`, and work `wdt:P725` → Person `rezics:voiceActorOf`; both
retain the original statement property and its exact qualifiers. `wdt:P453` stays the voice statement's character
qualifier, not another assertion. A Person page continuation keeps the release pin, statement, revision, Context and
current disclosure result. Decision: voice-credit language remains the work's released `schema:inLanguage` fact.

Decision: original Person credit inspection opens disclosed destinations in a separate tab to retain the exact loaded
window and focus; correction reads one exact slot page and uses only its authorized original candidate payload,
remaining unavailable when that page cannot supply it. A public empty citation list means no disclosed citations.

### Inspect and return to a Person credit

`creditVisit` admits only the Works view's native LINKS page and the exact released inverse direction. It supplies
current Definition labels for that window's original properties, qualifiers and reference parts; no creator alias or
forward cast admission is added. `CreditInspectionSession` and `CreditInspection` retain the exact holder, assertion,
revision, release and slot, shared value rendering, citations, revision metadata and native bounded correction editor.
The readable inspection links the original work and Sources, keeps Character-qualified voices separate, and uses
released field labels rather than property identifiers. Partial dates keep the shared renderer's exact precision.
Missing field labels have an unavailable label; identifiers live only in explicit technical details. Unknown source
values, an empty disclosed citation list, refused correction and unavailable correction remain distinct.
Return metadata preserves the native caller's link decision for an unlabelled work; it never substitutes a new anchor.

Decision: Person credit returns carry one bounded assertion locator; Context is revalidated against the fresh native
window, never used as an authority override. Work, Character and Sources destinations carry that single validated `via`
address with locale, Realm, native node/cursor and exact assertion focus. Slot comparison uses the existing SHA-256
byte digest so even an unlabelled Character key never appears in a destination or return link. Disclosed destinations open separately;
explicit return reloads the current native window. `CreditVisitReturn` consumes its locator once on mount and reopens
only an exact current holder/property/assertion/revision/release/slot and Definition pin in that Context. A missing,
replaced or newly concealed row reports an unavailable reading and focuses its surviving window, yielding to deliberate
focus movement. Hash changes cannot revive an old reading. Whole-association concealment unmounts the inspection portal,
links, labels, evidence and accessible names together. Current correction advice still comes only from viewerActions
and the existing exact editor read; no return address or public reading grants mutation.

The comparison baseline was the read-only `legacy-final` author page/work credits and `legacy-main-final` work Sources:
explicit role/byline separation, labelled source details and continuation on the actual work. No legacy code is ported.
The existing correction, draft departure, exact uncertain-command and late-response handling remains with its native
editor and session boundary. The named Person visit stories cover qualified voices, two credits to one work, current
labels, partial dates/source unavailability, concealment, Context return, replacement, correction refusal/unavailability,
retry and retired replies, with 390/1440 light/dark and anonymous/ordinary signed-in fixtures. Browser captures and the
original native/Search receiving, denial and growth acceptance remain integration work, not inferred from those stories.

### Person credit visit Cost

This presentation starts zero additional reads and decodes zero additional network/document bytes. It shares one
already selected native LINKS window (planned limit L, at most 100; the normal Works page uses its supplied limit), its
original assertions and related summaries. Let B be that supplied JSON page's UTF-8 bytes, P its distinct property IDs,
Q its qualifier count, R its reference count and S its reference-part count. Retention is O(B + P labelled strings),
traversal O(L + Q + R + S); it never accumulates continuation pages. The native statement contract bounds each assertion
to 16 qualifiers and 16 references with 16 parts each, hence at most 273 Snaks per row. Labels reuse only the current
caller's finite Definition projection, not a catalogue scan. Original work/Character summaries are already supplied;
there is no per-row hydration or background authority probing. Unsupported document values add zero document bodies.

Each destination retains one address, no body, label, source snapshot, draft or authority. Its opaque cursor keeps the
existing 8192-character envelope, the local locator is at most 4096 characters, and the existing validated complete
return address is capped at 32768 ASCII URL characters/UTF-8 bytes.
Encoding that address once in a destination’s `via` costs at most 98304 ASCII bytes plus the destination path/query;
the existing parser permits only one nested hop. Only one assertion locator is retained, with zero history addresses. Explicit return repeats the ordinary current-page
reader once; opening revision metadata adds one exact revision request, and correction uses one existing exact slot-page
read. Sources and destination pages retain their own current reader costs. No engine query, native index, polling or
new growth-sensitive producer is introduced.

## Work cast comparison

An admitted forward `wdt:P725` page groups the current returned credit window by the disclosed `wdt:P453` Character
qualifier on each exact original statement. Each performance keeps that statement identity, the Person target, the
Character target, and independent role and credited-as qualifiers. Multiple Character values on one assertion remain
separate pairings; duplicate names do not merge assertions. Appearance membership never supplies a voice credit.
Unlabelled or undisclosed Character targets stay unpaired and non-clickable. Regular staff credits and appearances keep
their existing groups. The Character grouping and original credit order are both local presentations of the same native
window; the scope label names that window, and the native continuation remains unchanged.

Decision: inspect the exact forward P725 holder/property/statement through the existing ValueExplanation entry; open disclosed Character and Person targets in same-locale new tabs with a validated Context/node/presentation/focus return carrying up to 16 opaque cursor addresses (16 KiB URL-encoded history cap), never old page data; each return or Previous route re-reads its selected current page, and a row that no longer qualifies reports the changed window and offers the current restart. An unlabelled or concealed target has no link.

### Work cast Cost

The adapter reads only the selected native relation response. A relation page is capped at 100 original rows and one
current page is retained by the mounted relation stream. Native statements admit at most 16 qualifiers, so a page can
produce at most `100 × 16 = 1,600` Character-pair references (or fewer when qualifiers repeat the same Character).
Each pair retains the original row identity and references its already returned summaries; the page contains at most
256 related-summary inputs. Grouping is linear in returned rows and qualifier values. A rendered pair can repeat at most
15 non-Character qualifier notes beside its Person, for a structural maximum of `1,600 × 15 = 24,000` note rows.

Those values are the native response values: qualifier strings stay subject to the current Definitions limits, and the
UTF-8 byte charge is the exact existing relation body, with no cast fetch or second response serialization. A summary is
the existing disclosed `SubjectSummary`; its cover is null or the current cover summary, with at most 12 variants and
the native imported rights-text limits (8 KiB for cover-credit metadata). No missing summary is repaired from a cover
or identifier. The Web adapter test charges typed calls, retained rows, and UTF-8 body bytes at 64, 512, and 4,096
unrelated Subjects and historical assertions; those scales do not change this loaded window. This is not native SQL
growth evidence; the directed-credit native growth acceptance remains separate.

For one complete visit, the mounted controller retains only the selected current page (at most 100 original rows, 256 related summaries and 1,600 pair references) plus at most 16 cursor strings; encoded cursor history is capped at 16 KiB, and the full validated return remains under the existing 32 KiB address bound. Target return and Previous each resolve one selected page from the current native reader; More requests only its one next cursor. Original inspection reads the exact holder/property/statement through the existing value reader, and Sources uses its current selected statement; no prior authorized payload is retained in navigation.

## Scores on pages

A score is never shown without its population, question, scale and count. The installed public headline is the
standard question's eligible Global published figure, in its documented 0–10 display domain. A Realm-routed page
never relabels that Global figure as a Realm result. Exact selected Realm populations appear separately; figures
are never averaged, blended or silently substituted. See [ratings](../services/kernel/src/rating/README.md#display).

### Independent reading and population comparison

The [first-scope audit](research/first-scope-remaining-backlog.md) is adopted for this Subject journey. The old
all-siblings-or-null read and first-three-memberships comparison are superseded. Question, published public figure,
Global aggregate/distribution and imported source statistics have independently settled serializable outcomes and
separate public query keys. Each failed source has its own explicit retry, which reads that source once and keeps
successful siblings and the personal vote draft intact. A focused Retry that is removed for idle or
ready returns keyboard focus to that source's named group when the Subject, selected population,
locale and source incarnation are still current and the reader has not moved focus. An absent, failed, unavailable or terminal source is never
a successful zero. Genuine zero, privacy suppression and native updating/as-of observations remain distinct.
Imported scales, dates, source names, licence and attribution come from their own source DTO; they are not Realm
populations or community votes. Public head and JSON-LD consume only the eligible anonymous published figure.
A healthy Global distribution can remain readable when that figure's request fails; it still requires the real
question scale, threshold, supplied mean/buckets and a non-updating aggregate. When a headline is supplied, its
eligibility and matching count continue to constrain the distribution. No buckets are inferred from a mean.

A reader opens the installed `GET /v1/subjects/:id/ratings/populations` directory for the exact Subject
and question. One native page examines at most twenty candidates. It may be sparse or empty while carrying `next`;
the consumer preserves that cursor opaquely and offers explicit Next, Start again and Retry, with no automatic
refill, text search, membership enumeration or history accumulation. Global is explicit and read separately.
A pending or failed transport read, including an explicit first-page restart, keeps the currently disclosed directory
window; a current refusal removes it. Repeated/cyclic cursors or 64 successful reads (including the first, excluding
failed retries) require an explicit fresh traversal. Directory moves and restarts preserve ordered comparisons and
their independent disclosure and source-local retry.
The reader can select up to twenty Realm populations across pages. The selected aggregate request carries the exact
complete selection in one call; it never silently truncates it or includes Global beyond the native twenty limit.
Removing a selection retires its held response and callbacks. Page transitions and removal place keyboard focus at
the next useful field or legend; native labelled checkboxes, shared fields and wrapping actions support phone use.

Private directory and selection readers live only in `subject-rating-populations.ts`, its actions and its view.
Each BFF read prepares the actual Request once, derives actual reader provenance from its credential/subject and
returns a serializable envelope. Expected reader only compares the result; it supplies neither authentication nor
a browser authority stamp. Current Realm identity/labels come from generated `client.realms({realmId})` reads,
bounded to the current page or selected items. A masked aggregate zero alone never establishes readability.
Refused Realm names/counts disappear from comparison and current choices, including after clearing; only a fresh
matching private response can restore them. Signed-out readers use a fresh anonymous envelope, as the native picker permits; signing out retires the prior
private visit before that read. Healthy same-subject signed-in observations with null CSRF may read.
The original non-null-token native vote command, bodies, rollback and finally ownership remain unchanged.

Browser keys separate actual readers and visits. The cache listener subscribes before async work. Observed session
Query replacement/removal, every committed session success (including equal data), sign-out, Subject/question,
QueryClient, transport and visit replacement and unmount retire old work monotonically. Selection/page versions
prevent ABA restoration; source successes replace callback ownership before React commit, and explicit source
replacement/removal requires a fresh private response. Useful ordinary fetch, invalidation, observer and non-success
notifications preserve current work. Ownership is checked before reads, completion/publication, dispatch, focus and
retry; late responses or queued callbacks cannot revive the old visit. Private payloads/provenance never enter
public aggregate caches, loader head operands or JSON-LD.

Cost: four independent anonymous source reads, one per requested source; targeted retry touches one. A private page
uses one native directory call and at most twenty exact Realm reads. A selected batch uses at most twenty aggregate
operands and twenty exact Realm reads concurrently, with no per-render requests or hidden page loop. Global has its
own call. Mounted metadata retains only current/selected keys; unrelated members, votes or imported history do not
increase the request count. Native examined-work and physical cost remain the producer's verification obligation.

Source and proof are separate: the consumer, generated-client wire, fixtures, eight-locale copy and connected
Subject/reader/lifetime/keyboard stories and assertions are authored. All new connected assertions remain **UNRUN**.
Workspace typing establishes compiler compatibility only. Native signatures, native disclosure/growth, browser
keyboard/focus/layout at phone390 and desktop1280 in all eight locales, physical cost and integration acceptance
remain unverified. A fixture does not prove private first-render/SSR production or unobserved credential history
across independent QueryClients; both boundaries remain unresolved. Existing Subject shell, reactions, personal
preference/own-vote helpers, canonical routing and native producers keep their ordinary owners.

## Classification assessment on pages

A person assesses one currently disclosed canonical Global classification association from the ordinary Subject page.
This is never classification proposal, fact acceptance or native enjoyment rating. Semantic classification editors and
the current-reading owner stay authoritative. Realm-local associations are named unavailable until native disclosure
admits them. Display labels, redirected subjects and a concept alone cannot identify a ballot.

Association identity binds subject, candidate (`associationId`), released property, concept target, Global context,
qualifier key (including spoiler) and optional release/revision supplied by native admission. Inspecting meaning reuses
the existing value-explanation and Changes destinations.

Installed typed methods, bound after the native ballots and SourceStatistics producers landed:

- `PUT /v1/subjects/{id}/classification-associations/{associationId}/assessment` (`classification_ballot:set`) with
  `{ assessment: "support" | "oppose", falsePositive: boolean }`. Response `{ associationId, revision, delivery }` where
  `delivery` is `enqueued` or `unchanged`. Acknowledgement does not establish committed own state or a new aggregate.
- `DELETE` on the same path withdraws the whole ballot (`204`).
- `GET` on the same path (`classification_ballot:read-own`) returns only the authenticated person's slot:
  `{ associationId, hasBallot, assessment, falsePositive, revision, pending }`. Own `pending` compares that person's slot
  revision with their retained contribution.
- `GET /v1/subjects/{id}/classification-associations/{associationId}/aggregate`
  (`classification_ballot:read-aggregate`). Below five eligible ballots the aggregate is `{ associationId, state:
  "suppressed", pending: "unknown" }` with no count, denominator, fraction, flag count, progress or ordering hint.
  Missing numbers are not zero. At five or more, `state: "published"` includes support and oppose counts, an independent
  false-positive count, `supportFraction = supportCount / (supportCount + opposeCount)`, `asOf`, `generation` and
  `pending: "unknown"`. Public pending is unknown, never a current published aggregate. The native suppression threshold
  stays five; Web invents no confidence, weighting or threshold adaptation.
- `GET /v1/subjects/{id}/source-statistics` remains the independent provider array, now bounded to at most VNDB and
  Bangumi. Each row keeps provider, alias, record, scale, mean/count, asOf, licence and attribution. Additive optional
  `observation={kind:"unversioned",digest}` is provenance, not a version promise. Bangumi uses canonical numeric IDs and
  a 0–10 scale. A valid zero mean differs from a missing or cleared figure. An absent provider is not a zero count.
  Providers are never averaged, normalized into native enjoyment units, turned into classification votes or treated as
  per-person ballots. A concealed VNDB row cannot remove an independently disclosed Bangumi row. Record links use the
  admitted Subject Sources route, never an arbitrary URL.

The generated KernelClient nested types do not yet export `classification-associations`; Web binds the installed HTTP
paths through the same seam used for own reactions, and names the producer unavailable when the handle is missing. Native
authorization alone admits controls. Ballots never enter `rating.vote`, the public headline, JSON-LD, ranking or native
rating counts.

Own states: preparing, signed-out, absent, acknowledged, actor-local pending, denied, concealed, unavailable, conflict
and stale. Subject, association, viewer or session replacement retires public/private rows, callbacks and effects.
Concealment never leaves a stale own ballot or public aggregate visible. An uncertain write keeps the original sender,
credentials, idempotency key and operands; explicit retry replays that command. A new edit is deliberate only after
native outcome is reconciled.

Decision: native classification aggregates have no delivered `updating` state; public `pending` stays `"unknown"` as
installed, and write-pending is actor-local only. Decision: source statistics retain the existing independent array
bounded to VNDB and Bangumi, with optional unversioned observation provenance.

Cost: for one selected disclosed association the fixed installed components C are current-reading, own-ballot, native
aggregate and source-statistics. The provider array has at most two independent rows. Web projection/retention is
O(one bounded association response + one own ballot + one aggregate + two bounded source rows); calls are at most C,
independent of eligible voters N or provider observation history H. A deliberate set/delete uses one addressed native
command plus a fixed reconciliation sequence. Acknowledgements do not authorize unbounded aggregate polling. Growth
acceptance is `apps/web/tests/subject-classification-assessment.test.tsx` at 20, 200 and 2,000 eligible historical
ballots with the selected association and two provider rows held fixed. Unknown native scan bounds remain unknown.
No engine adapter is added; existing native engines stay producer-owned.

## Provider source observation inspection

The provider record link in Subject ratings and the selected Global classification assessment opens the same Subject
Sources route with the admitted provider and the exact `observation.digest` supplied by the current public source row.
Rows without that optional digest keep the existing generic Sources destination; the Web consumer never invents or
accepts a guessed digest from an input field. The route retains its current Realm context and uses the canonical
Subject identity. The URL carries provider and digest only; provider alias, record, payload and signed history cursor
remain in the mounted reader.

Sources search validation preserves the URL's `provider` key through repeated router validation; conversion to the
reader's `source` operand happens only when mounting the observation panel.

Decision: provider observation inspection keeps the existing `source_statistic:write` admission; a displayed record
link grants no read or write permission.

Decision: returning from the observation panel preserves the current Realm query and targets the Subject Sources
heading for keyboard focus.

The reader presents the current head beside the exact selected retained observation. Empty head, clear tombstone,
published payload and unavailable payload remain distinct. Provider date and committed native order have separate
labels; native order is local commit order, not provider chronology. The content digest is labelled unversioned, not a
provider revision. Positive payloads show provider, alias, record, as-of date, original scale/mean/count, licence,
attribution and any supplied figures without filling missing bins or deriving a rank denominator. Public statistics,
classification ballots and native enjoyment remain independent.

History is an explicit one-page action. An empty page with a cursor is continuing, including a page whose candidate
was concealed; it does not refill locally or claim exhaustion. A page with no cursor is exhausted. Selecting a row
retains one selected observation beside the page's current head. Continuing replaces the page and retains that
selection. Exact or current concealment stays indistinguishable from missing, and failures show no provider identifiers.
A `409` retains the original request and cursor for explicit retry. Protected responses use private no-store delivery and stay in the
mounted reader. Subject, provider/digest, route, locale, viewer or CSRF-session replacement retires the reader, and a
late response cannot restore its contents.

The native `GET /v1/subjects/{id}/source-statistics/{source}/observations` is mounted and protected by the existing
importer action. Its response contract supplies the current head, exact selection, one history row, payload version,
legacy marker and unversioned digest meaning. Native history is ordered by committed `nativeOrder`; provider `asOf`
is not that order. The current `@rezics/client` generated declaration does not yet expose this mounted GET. Web keeps
the named unavailable seam `KernelClient GET /v1/subjects/:id/source-statistics/:source/observations`; it does not
hand-build a request or cast the generated client. Thus the current production route opens with an unavailable state
until generated delivery is installed. The component caller, response admission and illustrative stories are not
generated delivery, native authorization proof or the frozen acceptance.

Cost:

- **Touches:** One exact selected read returns the current head and selection. One explicit history action reads the
  current head and at most one native row. Every continuation is one further explicit request with the same opaque
  cursor on retry. No row hydration or importer recovery command is added.
- **Bound:** One mounted reader retains one head, one selected payload and one history page of at most one row. The
  Web admission matches the native limits: each payload at 32,768 bytes, the response at 68,000 bytes, the cursor at 512 characters and
  figures at ten bins. The current public provider array remains at most two rows.
- **Growth:** Projection and display are O(rows + admitted bytes), with rows at most one per history page. There is no
  accumulated history, local refill or per-row request. `apps/web/tests/subject-source-observation.test.tsx` pins
  ten-bin payloads, the native one-row page, withheld continuation, retained selection, exact 404, retry inputs and
  retired late results. Stories pass native-shaped examples through admission and the existing Sources page; generated
  transport, native acceptance and browser geometry remain pending.

## Realm context

The same subject page is reachable from the general site and from a Realm or Zone. The facts come from the
selected Context, inheriting Global except where that Context accepts, replaces or suppresses a value. Current
Context selection and population labeling use the native contract below. Realm ratings, reviews, discussion and
lists require their own population bindings before a page can consume them; a label alone does not establish those
producers. Existing Global output must never be relabeled as Realm output.

### Native page request and response freeze

`POST /v1/pages:read` accepts `{target:{subject:<id>,realm?:<RealmUUID>,view?:<existingView>},languages?}`.
Exactly one existing target family is required. Account and route targets reject `realm`. UUIDs, body types,
languages, views and unknown fields follow the existing API validation rules. Neither a raw Context id nor a Context
override is accepted. Realm choice belongs to this request, never to the persisted presentation profile. Existing
requests without Realm retain their response shape and behavior. Agents retain their canonical Global redirect or
Global subject read; selecting a Realm never creates an agent Realm page.

A successful subject response to a Realm request adds optional subject-page metadata:

```ts
context: {
  id: selectedContextUUID,
  population: { kind: 'global' } | { kind: 'realm', id: realmUUID, title: actualRealmViewTitle }
}
```

The actual subject read's `subject.context` equals `context.id`. A Realm population uses the title returned by the
current native Realm view. A fallback has exactly `{id:GlobalContextUUID,population:{kind:'global'}}`; it contains no
Realm id, title, label, reason or guessed publication status. This labels the current facts, not a Realm score,
review or thread producer. The product can offer a Global switch without disclosing why Realm publication was
unavailable.

### Current authority and dispatch

Resolve `community/realm.ts`'s actual `readRealm(deps, actor, realmId, {deadline})` first. Its `RealmView` includes
`contextId` and `headRevisionId`. A null result conceals with 404, including unknown, denied and currently banned
readers of protected Realms, even when an independent grant exists. The similarly named board-scheme reader is not
this authority; it lacks the protected-Realm ban check.

Then use `community/publication.ts`'s actual
`readPublication(deps, realmId, subjectId, {actor,deadline})`. It returns the current adopted `PublicationHead` or
null and rechecks Realm and subject readability in its own snapshot. Its protected-Realm check delegates
`realmReadEligibility`: a current ban throws `ProblemError(not_found)`; the snapshot rolls back and rethrows.
`readRealm` catches its internal `RealmReadDeniedError` into null, but `readPublication` does not. A thrown
`not_found` from either reader conceals the whole page with standard 404, never Global fallback. Other native
deadline or unavailable errors retain their typing; no catch-all conversion to null is permitted. Genuine null
publication conflates missing or unreadable slots, withdraw and reject; it certifies neither permission nor
unpublished status. Only after a readable Realm and genuine null publication may the page independently authorize
a current Global subject read. A denied Global subject remains concealed.
Never carry Realm labels into that fallback.

A publication pointer and a Realm grant do not authorize the Context. For a Realm result use actual `readContext`,
`publicContextEligibility` and native Context lifecycle authority. Current subject deletion, hiding, candidate
moderation and Context deletion remain effective. Apply the selected Context's existing inherit, replace and
suppress semantics. An operation locator or old Context id supplies no current authority.

These reads use separate snapshots. Before any Realm response, re-read the actual `realm.ts` Realm and compare its
current Context and head revision. Denial conceals; a change requires bounded retry or readiness failure, never a
successful stale Context A response after a change to B. Comparing both `contextId` and `headRevisionId` is necessary but insufficient: publication withdrawal,
rejection and a protected ban can leave both unchanged. Revalidate current publication and protected-ban authority
after selected subject and links execution and before returning Realm output. A late withdrawal or rejection
requires independently authorized current Global subject and links with exact Global metadata, or a truthful typed
503 with no result and standard Retry-After. A later healthy read must return current Global, not permanent
preparing. A late protected ban requires standard whole-page 404 without context, reads, Realm metadata, selected
facts or private reason, even while the independent Realm read grant remains. The same concealment applies when
a ban commits after the initial delegated Realm read but before publication: publication's thrown `not_found`
never becomes Global 200. Reuse the existing deadline and retry policy without a new numerical allowance
or a clock bypass. Final authority work remains charged inside the same bounds; this specification supplies
no runtime growth pass. Runtime growth evidence must include late authority paths at the existing geometric
scales and current owner populations, including final guard costs.

Internal subject and links descriptors carry only the server-resolved current Context. That Context participates
in actual probe reuse, descriptor deduplication, dispatched requests and session binding. Subject and links must
use the same selection. Keep the caller's bearer, Actor, Auth, Access and session throughout. No anonymous
substitution, special permission header, second client request or profile/cache permission is allowed. Keep the
existing 16 distinct reads, 128 read-cost slots, concurrency and request deadline bounds; charge actual Realm,
publication and Context points as well as subject and links work within those bounds.

Use the delivered sticky `withPublicStatementReader` export from `semantic/statement-disclosure.ts` for the whole
aggregate. `presentation/reads.ts` applies it to actual probe and planned dispatch through `readPage`. Its sole purpose is to exclude publisher-private candidates and related ids from public page output.
It does not resolve Realm or publication, grant Context access or make protected Realm metadata globally public.
Standalone permitted private hydration retains the same current caller and its existing behavior. The frozen
[aggregate authority suite](../services/kernel/test/presentation/aggregate-authority-user-cases.test.ts) remains
unchanged.

### Native acceptance and remaining bindings

The [native Realm page cases](../services/kernel/test/presentation/realm-context-user-cases.md) use the existing
Semantic driver and its real composed kernel, Auth and Access. They freeze public subjects, distinct Context A/B
facts, actual protected readable Realms and publication, Global fallback without Realm disclosure, current bans,
lifecycle, candidate audience, subject/links/session consistency, validation, agent canonical behavior and the
Context A-to-B race. Four additional during-read schedules cover an early protected ban, late publication
withdrawal and rejection separately, and a late protected ban. Late barriers hold the actual links completion only
after both selected subject and links responses succeeded; they never hold the subject probe waiting for links.
Mutations use native writes outside page observation, with unchanged Realm Context/head controls for late schedules.
All authorization delegates real Access with the same opaque native time, actor, evidence and session. A suspended account uses its genuine pre-suspension bearer: 401 `invalid_credentials` with
`Bearer error="invalid_token"`, never a manufactured bearer.

| Surface                                        | Binding status                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Subject facts, links and current Context label | Request/response and native acceptance frozen here; production Realm wire still required                               |
| Native Context deletion lifecycle              | NOT YET FROZEN: existing lifecycle acceptance requires DELETE, but the composed Context routes expose only create/read |
| Sticky public statement audience               | Delivered `statement-disclosure.ts` export; `presentation/reads.ts` wraps actual probe and planned dispatch            |
| Realm rating figures                           | NOT YET FROZEN: require Rating's actual question/population binding and current authority                              |
| Realm reviews                                  | NOT YET FROZEN: require Content's actual Context/population read export                                                |
| Realm discussion                               | NOT YET FROZEN: require Content's actual Context/population thread export                                              |
| Realm lists                                    | NOT YET FROZEN: require Library's explicit population binding                                                          |
| Global review/thread previews                  | Independent Content/Search acceptance; no duplicate fixture in this freeze                                             |

This specification adds no page, compiler, schema, client, Realm, Context, Source or figure implementation and no
resolver export. It establishes no Source safety or identity acknowledgment, deployment default or main-branch
completion. Manager acceptance requires full native check output and Root, Search and Community review of this
owner contract and its evidence.

## Qualified relation streams

Credits and characters render each current native statement with its own credited name, order, detailed role and
character qualifiers. Item names and canonical links come from the response's disclosed related summaries. Missing
qualifier fills stay absent. Spoiler markings use the current stored qualifier and reader setting; the entire row,
including title, metadata and links, remains behind the accessible reveal control until explicitly opened.

`OutgoingRelations` selects the existing native forward stream for one property. Each group previews at most 12
rows. In a full view each group owns its cursor, loading, retry and restart state. More resolves the current
template and selected Context again and dispatches only that group's relation read. Other relation groups are
returned as unrequested (204), retaining their existing client state. A continued document opened directly offers
those groups a fresh-start link. No first-page slice or cross-group cursor represents a complete graph or total.
The existing 16-read, 128-slot and native request bounds still apply.

## Mounted cross-media visits

Home mounts the native `/` page's four existing TypeLists alongside the existing Home feed. Books, Anime,
Visual novels and Recipes retain Search's admission, ordering, 12-hit preview and explicit list continuation.
The anime and visual-novel Realm pages retain their delivered native Space page and independently authorized
publication shelf. Native publication membership, not a Realm title or a source record, admits a work to that shelf. Neither
page reads an Imports manifest, invents a featured seed card, or performs a per-hit detail fetch. The authentic
Imports cross-media producer supplies selected identities and statements; a proposed statement is not a public
relation. Its `gaps[].fields`, `gaps[].record` and `unresolved[].{holder,target,property}` remain producer-owned.

The mounted Subject overview adds **Connections across works** under the native page composition. It admits its
forward and incoming stream choices from the current definitions release's effective type properties, targets,
inverse labels and relation groups. Work relations include cross-media counterparts, adaptations, sequels and
side stories when admitted. Characters expose incoming appearances and independently filtered character-qualified
voice credits; people expose incoming staff and cast credits. These are the generated native `relations` and
`links` methods, with the original holder, property, selected Context, native cursor and qualifier filter. The
reader never joins another subject's biography into an appearance or treats a qualified character as the voice
actor. Existing character and generic catalogue editors retain all command, admission and immutable retry custody.

Each of Relations, Characters and Credits owns one selected property/direction and one current page of at most
12 rows. Changing that selection or choosing Next removes its prior page before requesting the replacement; Previous
refetches the retained cursor under the current admitted reader instead of restoring rows. Each group and selected
stream retains at most eight cursor addresses, not page responses. When earlier pages have rolled off, the oldest
retained address names that boundary and offers a restart from the first page. Stream changes begin at that stream's
first page, and sibling sections remain independent. Native counts may include concealed endpoints. Empty pages with a
native continuation still offer Next; hidden summaries never acquire a guessed title or a raw-ID link. The existing
qualified-credit projection supplies credited names, order, role, character and part notes from each assertion's
own disclosed related summaries. Spoiler consent remains per assertion occurrence and content. Nothing in a
character's voice-credit result authorizes its appearance endpoint, or conversely.

Decision: Connections keeps at most eight cursor addresses per group and stream; exact assertion returns carry only
validated addresses that fit the 28 KiB fragment cap, with an explicit restart at any omitted-history boundary.

The supplemental authenticated Web loader re-resolves the actual page representation before and after the selected
native reads. It checks the caller's expected Context and current release. A replacement or refused reading retires
all old rows, pending deliveries and cursors; retry starts a fresh visit. Session state, account, CSRF-session token,
page, Realm, Context, locale or reader-gate replacement retires the mounted private window synchronously. Responses
are private/no-store and remain outside public hydration, shared QueryClient caches and metadata. Reads reuse the
installed session authorization helper; writes and unknown-command retry credentials remain with the existing
editors. Loading, sparse-empty, denied, stale and unavailable states retain explicit recovery. Selection, More,
recovery and reveal controls wrap at phone widths, keep a 44px target and return keyboard focus to the section status
when an exhausted action disappears.

Decision: cross-media navigation keeps one immediate canonical public opener; a relation return can restore one validated stream/cursor and exact disclosure fingerprint, while changed readings require an explicit current restart. Native graphs without a Realm Context selector remain unavailable in Realms.

Work links use the current native slot selection; legacy unselected Subject projections apply preferred-then-normal
best rank before the compact cap of 20. An admitted native page window takes precedence over the Subject preview,
including inverse assertions. Only released work classifications already used by the native reader become work
links. Provider identifiers and title matches never supply a relationship. Each work assertion remains separate,
with its original holder, direction, property, qualifiers and disclosed reference parts. The ordinary card and value
renderers supply the reading; work relations do not open the qualified-credit inspector. Empty references mean
that no citations are disclosed by this reading. Facts and Sources remain public destinations even when exact
review metadata is unavailable to an anonymous reader.

Decision: the bounded Connections fragment carries one stream, optional native cursor, SHA-256 reading locator
and optional original holder/statement focus; it carries no row, reveal choice, credential or nested opener. A
stream-only fragment is a handoff to a fresh current window. Restored windows are read again through current
native authority; the locator only compares the exact page, release and delivered section representation. A mismatch
leaves other sections readable and offers an explicit restart of the selected stream. Retry preserves the failed
stream and cursor. A newly selected stream or replaced visit retires its prior explanation and spoiler choices.
The original `CONNECTION_LIMIT = 12`, `CONNECTION_BYTES = 1_048_576`, three selected-stream ceiling and explicit
limit-25 depth-1/2 graph remain unchanged. Fingerprinting and explanation consume only the page aggregate and
returned native window; no history, catalogue index or per-card request is added.

The Character visit is a presentation of the current Relations section, not a second reader. A full initial adapter
read uses two current page aggregates, the active/release pair and up to three selected streams: `4 + g`, at most
seven HTTP calls. It returns at most three sections of 12 rows each (36 retained rows). One selected-stream
replacement, including More or explicit Retry, uses five calls and replaces that section's current page rather than
folding history; Character presentation adds no rows or calls. A successful section charges the exact UTF-8 byte
length of `JSON.stringify(body)` through `TextEncoder`, rejecting any body over 1 MiB; three section bodies therefore
retain at most three separately charged MiB windows. Each returned statement allows one main Snak, 16 qualifiers and
16 references of up to 16 parts (273 Snaks maximum). The released relation DTO carries one target/holder summary per
row and its `related` summaries use the shared summary reader's maximum 256 distinct input IDs per response. The
charge is computed from the actual DTO, including labels, covers, qualifiers and references; no assumed label byte
limit replaces that measurement. This is consumer request/retained-response evidence only: native relation scan rows
and SQL work keep their original producer acceptance.

Character adapter growth case: the same relation visit is measured at 64, 512 and 4,096 unrelated Subjects and
obsolete assertions for calls, current sections/rows and UTF-8 response bytes. Focused mounted cases cover directed
identity and incoming parent meaning, duplicate-target assertion identity, whole-association spoiler and withheld
states, exact return and caller/Context A/B/A retirement. Source review, authored consumer tests and fixtures are
separate evidence classes; actual seeded mounted evidence and native producer growth are not claimed here.

The private Character Relationships editor keeps its visit in the source history entry. Its navigation state is capped
at 327,680 UTF-8 bytes and contains at most eight opaque cursors (8,192 UTF-16 units each), the current stream/work
keys and an exact disclosed holder/statement focus; it carries no page, source, release, session or reveal payload.
Eight worst-case four-byte cursors account for 262,144 bytes; the cap also covers the duplicated origin address and
fixed keys. A target click adds no read. Returning performs one fresh current-page adapter read, and More, Previous,
Retry or restart each perform one read through the private reader. The selected window requests at most 20 rows;
holder descriptors are deduplicated and read four at a time, related summaries admit at most 256 distinct IDs, and
each statement is bounded to one main Snak, 16 qualifiers and 16 references of up to 16 parts (273 Snaks). Only the
current response remains mounted; retained prior-page payload bytes are zero. Missing row or work identity is
announced and offers a fresh read of the current stream.

A `via` return address admits only a same-locale canonical Subject or Realm path, with at most one Realm operand.
No nested return chain, credential, draft or private row travels with it. A bounded Connections fragment may carry the selected native cursor and comparison locator described above. A link from a qualified note has
the same return behavior as its main work/person link. Returning re-resolves the destination under current authority
and anchors at Connections. Native canonical redirects continue to preserve the original bounded search operands.

**Explore nearby connections** explicitly selects up to eight release-admitted properties, depth 1 or 2 and the
installed native limit of 25. It calls the existing native graph reader once through a minimal typed seam for the general Web reading owner; it does not perform traversal in Web.
The current graph DTO has no Context selector or per-edge `qualifiers`/`related` projection. Realm exploration is
therefore labelled unavailable, and Global graph connections use independent reveal controls. Exact qualified credits
remain in the stream lists. A truncated graph says it is partial and links to exact readable destinations, whose
lists start a fresh bounded visit. Semantic owns any future Context-aware graph DTO; Imports owns actual omitted
source fields and unresolved seed endpoints. Neither gap licenses a local graph producer or fabricated success.

### Cross-media visit cost

For a selected page let `P(v)` be the installed native `pages:read` plan's component count, already bounded by
16 reads and 128 slots; its supplied section limits remain authoritative. Home adds one such aggregate: its four
catalogue search components have limit 12, so at most 48 hits enter the existing TypeList projection. The existing
Home feed keeps its own fixed request components and caps. The existing Realm shelf requests at most 20 boards
and 12 publications, with at most 12 independently authorized subject summaries; presentation, membership and
continuation remain with that shelf’s original owner. For that existing route these fixed components and selected
summary window comprise its component bound; this composition adds no search
or detail request per catalogue hit.

The supplemental visit has two page aggregates, the installed active-digest/release pair and one selected stream
per nonempty group: `C(v) = 4 + g(v) <= 7` native HTTP calls, or `2P(v) + 2 + g(v)` underlying components. A deliberate
single-section replacement has five HTTP calls and at most 12 rows. A deliberate graph selection has five HTTP
calls, native depth 1/2, at most eight properties and limit 25 per expansion. The installed graph engine caps its
edges at 500 and nodes at 501; Web does not alter its indexed-row, expansion or statement derivation. This adapter
introduces no database query, engine projection or worker path.

Every successful stream response retained by this adapter is at most 1,048,576 UTF-8 JSON bytes and 12 native rows;
over-limit responses become unavailable. Projection consumes only those rows and their bounded response's related
summaries. Three current sections retain at most 36 rows and three such byte windows, plus fixed release stream
metadata. An explicitly requested graph retains at most one such byte window in addition to those sections; its
nodes, edges and truncation descriptors are processed once. Aggregate and release metadata remain request-local,
never accumulated across deliberate visits. Processing and retained current-page state are
`O(sum L_i + sum B_i)` plus the one selected graph response. Following `k` destinations costs the sum of their
bounded components; unrelated catalogue population does not add calls or retained rows.

`apps/web/tests/subject-connections.test.ts` exercises the actual Web loader/window boundary with native-format
response doubles for work, character and person destinations at catalogue populations 32, 256 and 2,048, counting
calls, processed values and serialized bytes,
including concealed summaries, sparse continuation, stale reading and late-delivery retirement. This is authored
Web boundary coverage, not evidence of native SQL scan bounds or mounted seed admission. Existing native engines
remain their owners' responsibility. The native acceptance uses actual mounted selected seed destinations.

### Final mounted core capture acceptance

`apps/web/tests/native/cross-media-pages.test.ts` reuses a retained native browser/session rather than provisioning
another campaign. `REZICS_CROSS_MEDIA_VISIT` names a private worktree-local configuration containing the mounted
`origin`, retained `cdp` and `contextIndex`, authentic Imports `seedResult`, both actual `realms` paths, independently
admitted `destinations` for Library, Collection, board thread, settings and creator sales, and selected native `edges`
with holder/direction/property, an optional exact character `filter`, target and expected qualifier text. Proposed-only or missing seed identities fail
acceptance; no canned seed or Storybook substitute is admitted. Native producer gaps remain visible.

After the connected native journey succeeds, its last step captures Home, both Realms, one work for each of
Steins;Gate, CLANNAD and Fate, a character, a person, Search, Library, Collection, a board thread, settings and creator
sales. Every page requires phone390 and desktop1440 in light and dark: 56 images under
`.temp/screenshots/core/<nn>-<page>-<width>-<theme>.png`, with every resulting path listed by the task result. These
captures are required mounted acceptance, not a substitute for growth assertions. The landing policy defers native
acceptance and browser capture to the integration verifier; authored harnesses do not establish executed evidence.

## Explore the bounded catalogue graph

A subject header offers additive companion routes `/graph`, `/quotations`, `/concepts` and `/music-context`. These
do not widen the shared composition View enum and do not replace the generic `$view` route. Ordinary finite
relations, credits and appearance lists remain the basic catalogue journey.

On a readable work, released item-valued facets that point to readable Concepts appear as tag chips. Each chip opens
that Concept on the existing `/subjects/:id/:slug/concepts` host and carries its exact property and the work's safe
overview return path. The visit keeps Concept identity, source meaning and hierarchy fixed while composing admitted
work types, descendant selection, spoiler threshold and additional conditions through native Search. It uses the sole
readable source scheme automatically only when the Concept has exactly one source scheme; multiple schemes require
an explicit choice. Decision: a tag chip carries its exact released property, and a source scheme is auto-selected
only when it is the Concept's sole readable source scheme.

Decision: Concept returns use one validated 8 KiB descriptor with at most eight hierarchy addresses, currentness,
filter intent and focus; the original work address remains separate, and tagged-work returns restart the filtered
Search under fresh admission without restoring a work cursor.

The source Concept reader supports the current Global view. A supplied historical pin remains explicitly unsupported;
it never falls through to a different Concept binding. The URL-safe descriptor is capped at 8 KiB after encoding,
including its current Concept identity, role, release/revision/context/type, work filters, section/row focus and up to
eight hierarchy addresses. Each retained native continuation is at most 4,096 UTF-8 bytes. Older addresses are
evicted with a visible truncation notice and a Restart action. The descriptor contains no session receipt, evidence
snapshot, work cursor or nested return URL; the original work return is a separately validated local Subject address
of at most 2,048 UTF-8 bytes.

Child, scheme, association, tagged-work and browser-history returns first perform a current native read. The reader
compares the saved Concept binding and requested role, then uses only the fresh session receipt for the saved native
hierarchy continuation. It focuses a saved row only when that row is present in the newly admitted window; a missing
row is announced and focus moves to its current section with Restart and any currently admitted Next control
available. Filter intent is restored and Search executes again under current admission. Hierarchy and Search
availability remain independent, and native
lagging, preparing, unavailable, unsupported and exact-empty hierarchy states keep their separate meanings.

The works request is capped at 24 Search rows, 65,536 serialized request bytes and 65,536 serialized response bytes.
The current public result and viewer envelope share that response cap; the released work-admission metadata embedded
in the Concept read is separately capped at 65,536 bytes. The work-list composition therefore retains at most
196,608 serialized bytes across request, admission metadata and result/viewer state, in addition to the existing,
separately budgeted Concept definition and hierarchy reads. Continuation is explicit and bounded; the visit does not
read work details per result.

The graph reader consumes `GET /v1/subjects/:id/graph`, `/links` and `/counts`. Native `graph.ts` admits depth 1 or 2,
at most eight relation properties, and a **per-expansion** neighbour page of at most 25. The producer also stops
edge exploration at 500 edges; Web never requests more than 25 neighbours per expansion and never crawls, auto-expands
or hydrates every node. Truncated expansions continue through the matching bounded `/relations` or `/links` page.
Incomplete is distinct from empty. Edge direction, inverse labels, qualifier/credit slots, cycles and repeated node
identities are preserved; duplicate edges are not. Graph reachability does not authorize access or prove identity.

A keyboard-selectable diagram has a readable table equivalent. Only public anchor, relation, direction, depth and
selected node/edge identifiers belong in the route. Locale, session epoch, read refusal, anchor replacement and a
source-page change retire obsolete nodes, continuations and pending results. Redirects, stale cursors, concealed
endpoints and an unavailable graph never leak previous labels.

Selecting a node issues at most two explicit native reads (the selected subject, and one quotation, concept or music
companion page). Correction uses the existing facts, relation and authored-document editors and returns to the same
bounded exploration address.

Decision: Music-context relation and correction returns preserve only the selected public stream and its bounded
native cursor; the reader keeps at most eight page addresses and returns without rows or session tokens.

Decision: unreleased `schema:Quotation` and place/event/area/instrument types stay named unavailable until Semantic
admits them; unknown source roles stay retained evidence.

### Cost

Let G be one native graph response at the chosen depth with limit 25. That limit bounds each expansion's neighbour
page, not the catalogue and not all three of vertices, edges and work. The producer edge budget of 500 is a separate
engine cap. Let D be the explicitly selected detail components (at most two) and L_i / B_i their installed row and
byte caps: quotation, concept and music-context pages use 20 rows; a selected subject/document body is bounded by the
existing document contract, retained here at 262,144 bytes for the composed detail. Web projection and retention are
O(G + sum L_i + sum B_i), independent of catalogue N. A further user expansion pays the same formula once and replaces
the corresponding truncated page instead of accumulating history. Missing native bounds stay unavailable. Growth
acceptance is `apps/web/tests/subject-graph-browser.test.tsx`.

## Read an admitted quotation

Native admission: `schema:Quotation` is a released Thing with a document-valued `schema:text`, `schema:inLanguage`, a
`schema:about` work-context, `schema:spokenByCharacter`, a credited `schema:creator` and an optional `schema:actor`.
The ordinary subject `POST /v1/pages:read` carries current viewer state and Access-derived correction actions for this
type. Historical pins without the type keep unsupported reading. Quotation class, text, about, creator and actor live
in `works.yaml` with `schema:spokenByCharacter`, so labels stay in the eight works presentation files. Work-context is
`schema:about`, not episode `schema:isPartOf`. Credited creator and performing voice use association, not credit.
Decision: the ordinary overview includes admitted `schema:text` in the existing document composition; `Summary` still
hydrates only `schema:abstract`. Catalogue file and release-group pages keep viewer
`{ state, context, statementPropose }`; admitted quotation pages keep `{ kind }` plus correction `actions`.
Decision: direct quotation routes carry Context; one-use receipts pin Context, caller generation and assertion across `via` returns; corrections use exact Subject/Context permission and stay unavailable when Global-only operation advice cannot serve the selected Context.

The public `via` address remains a bounded path plus quote intent and a one-use marker whose public Context suffix is
only a recovery address, because the shared Subject return validator does not admit Context inside a nested quotation
address. A lost receipt restarts with a current read. Accept and adopt stay on their Context commands. A hidden speaker stays omitted from statements and related,
matching ordinary subject disclosure, while `somevalue` remains the withheld unknown speaker.

The `/quotations` companion follows only relation targets whose released type extends `schema:Quotation`. A quote's
text comes from the first released `schema:text` or `schema:abstract` property on that type and one unambiguous
best-ranked statement. The reader keeps that statement ID, its exact language, permitted qualifiers and reference
hashes together. It never uses a relation label or a different text property as quotation text. A document value is
read through the existing exact authored-document operation and rendered with `DocumentBody`; statement spoilers use
the existing spoiler gate.

`schema:spokenByCharacter` supplies a speaker. `schema:creator` supplies a credited person and never a speaker.
`schema:isPartOf` and `schema:about` remain separate cited-work identities, as do recorded voice identities and the
quotation subject itself. Missing roles remain unknown or missing according to the released field; restricted,
withheld and unsupported values remain explicit. If quotation text configuration or the current subject's list
property is absent, the companion explains that reading is unavailable and links back to the ordinary subject facts.

Decision: quote sources come only from references attached to the exact admitted text statement; item-level source
records do not imply textual attribution, and only a current release-admitted absolute HTTP(S) destination is linked.

The reader retains each native reference hash and its admitted parts on the same text statement. It does not copy
source prose or hydrate providers. A missing or withheld reference has a visible state and no destination link. A
selected quote or source observation is retired while the bounded read is refreshed; a stale relation or quote
address exposes no former attribution or source controls. Returning to the subject remains a stable, keyboard-visible
link, and selecting a quotation moves focus to its detail region.

### Cost

Reading a quotation from a work uses one current Subject read, at most one relation page of 20 entries, one exact
selected-quotation Subject read, one exact Subject/Context `viewerActions` request for a signed-in caller, and at most
20 exact authored-body reads. Direct quotation routes use one Subject read, skip the relation page and separate
selected-quotation Subject read, and retain the same viewer-action and body ceilings. `ItemSchema` uses unbounded
string records for native labels and neither native Subject, relation nor viewer-action responses have aggregate
byte caps. Web therefore rejects each such JSON over 1 MiB, any displayed UTF-8 label over 1,024 bytes, and any
composed reading over 8 MiB. These post-response caps bound Web retention and rendering, not native database work.
`checkDocument` enforces the existing 2 MiB serialized document limit. The admitted evidence ceiling remains
`20 * (1 + 32 + 32 * (1 + 32)) = 21,780` entries. No database or native response-byte bound is claimed. Native
growth measures the selected quotation page, outbound relation reads, document bytes and retained UTF-8 size.
Qualifiers and reference parts come from that same selected subject response; they add no provider or
per-reference requests. Continuation replaces the visible 20-entry page. Focus revalidation repeats the same bounded
read and hides old source controls until it completes.

## Work title variants

The ordinary work overview exposes the labels and aliases in its already admitted Subject reading, grouped by
supplied language. Exact duplicates share a row within one language while retaining title and alias roles; spelling,
punctuation and diacritics remain unchanged. The disclosure does not replace the page heading, cover or action bar.
The selected title uses the existing composition language selection; a fallback is explained locally. Original
language remains unknown without native evidence. Sources retains the Subject and selected Realm.

Decision: the public disclosure admits at most 262,144 serialized UTF-8 bytes of labels and aliases as a whole;
above that presentation budget it shows unavailable rather than a partial list advertised as all supplied names.
This is a Web admission limit, not evidence of a native producer bound. No requests are made per name or language.
Session observation changes retire the reading until a replacement page source arrives.

The ordinary work disclosure checks the current admitted release descriptor and its ancestry; `summary.types`
repeats the release descriptor's bases but does not establish that the descriptor is currently available. Missing
or unsupported descriptors grant no work identity. The page aggregate includes the existing Global mounted Terms
operation advice (`statement:propose`, `subject.terms`), independently of public disclosure. Advice distinguishes
loading, failure, refusal and signed-out state. Only failed advice has one explicit refresh; replacing the page
reading starts a new visit. It never retries the Subject or each language. Terms re-reads its original native
candidate and authority and retains its existing draft/uncertain-command recovery.

Decision: supplied-name return uses one bounded browser history value and the existing validated same-locale `via`
address; filters stay out of URLs, and changed caller, Context or release refuses restoration.
The shared handoff restores the expanded disclosure, mounted language groups, group/row window, filter and Terms
focus on work and people names, plus the Sources focus anchor. Its binding includes Subject, actual Context, selected Realm, locale,
release/revision and browser session-cache incarnation metadata (including weak query identity, so replacing a cache entry cannot revive a return); it contains no credentials or editing state.
A returned fresh page may restore the view, but a mounted retired source object never becomes current again,
including A-to-B-to-A, locale replacement and session refresh. Late copy and advice callbacks cannot update it.
Ordinary browser history owns the value; there is no return registry, retained catalogue or former reading list.

Decision: work-name Sources activation uses the existing validated same-locale `via` address with the actual selected
Realm and stores its closed view descriptor only in ordinary browser history. Browser Back restores after a fresh
current work reading; the existing `SubjectSourcesPage` `returnTo` anchor carries no history state, so an explicit
state-less return focuses the newly admitted names section and restarts its local window. That anchor is the exact
state-transfer seam for coordination; the Sources owner remains unchanged here.

### Supplied names Cost

The native input producers are `checkSubjectStructure` (`packages/definitions/src/validate.ts`: at most 512 total
terms/statements, 250 UTF-16 units per text, 32 aliases per language) and `patchTerms`
(`services/kernel/src/semantic/terms.ts`, validating the complete resulting term set). `FACT_LIMIT = 512` in
`write-facts.ts` bounds one fact write; it does not by itself bound examined revision history. The native language
pattern has no maximum tag length. `DEFAULT_BODY_LIMIT = 1,048,576` bounds ordinary HTTP input, not an aggregate
Subject response or all import producers. `MAX_PAGE_READS = 16` and `MAX_PAGE_COST = 128` bound a composition plan's
reads/Subject cost; `RELEASE_LIMITS.bytes = 4,194,304` bounds one released definition artifact, not the whole page.

Let R be actual serialized UTF-8 page response bytes, T its labels/aliases bytes, E encoded name/language entries,
and A the actual bounded-operation action-response bytes. The response producers `responseResult` in
`services/kernel/src/presentation/reads.ts` and `respond` in `presentation/http/pages.ts` decode/serialize complete
responses without a generic response-byte ceiling. Charge O(R) response decoding and O(T + E) admission/grouping,
including temporary JSON/UTF-8 encodings, even when T exceeds the 262,144-byte presentation budget. Text JSON alone
can use 1,500 bytes per 250-unit term through escaping; language keys add their actual encoded length. Consequently
512 valid Japanese 250-unit names already exceed the presentation budget. Such an admitted response is unavailable
as a whole, never a truncated list. Neither the presentation budget nor input/write limits prove a native SQL or
whole-page byte bound; the complete response remains owned by the existing page reader.

One work visit uses one page projection request plus one existing Terms authority request when signed in (zero for
signed-out); the latter is included in the Web page aggregate. A people visit uses its existing one authority read.
At most one explicit failed-advice refresh adds one action request and its A bytes. Opening Terms adds one original
Subject projection, one current authority read and a definitions read (at most two native requests on a cold cache: active pointer and
released artifact) under existing Terms recovery; charge their
actual complete response bytes, not T alone. No grouping, opening, paging, filtering or copying adds requests.
The exact Terms commands and drafts remain private editor-owned state and are not charged as names-return payloads.

Names retain one admitted O(T + E) projection (T <= 262,144), a filter of at most 250 UTF-16 units, at most
`PEOPLE_NAME_GROUP_WINDOW` (8) mounted language groups and `PEOPLE_NAME_ROW_WINDOW` (24) rows per group (192 rows).
Copy state is per mounted control. Return decoding accepts at most 8,192 UTF-8 bytes with at most eight bounded group
descriptors, the current query/window, and one finite focus intent; browser Back retains one such value in its
history entry, with no traversal of obsolete entries. Sources uses its existing validated `via` address and current
bounded request; returning uses the ordinary current work read. The Sources `returnTo` anchor does not transmit local
history metadata, so that path starts a clean local window. Three-scale composition cases
at 64/512/4096 unrelated Subjects and obsolete history charge the same local projection, action refresh and handoff
work. They establish no native examined-row bound or executed browser/visual result; native and browser acceptance
remain integration-owned.

## Character document previews

Decision: a direct native Character read opts into public document previews with `includeDocuments=true`; page
composition keeps its existing dependent document plan, so a page does not hydrate each body twice.

Decision: Semantic and native Document routes share the public view mapper and strict schema from Content's narrow
`document-public.ts` entry; the route module keeps compatibility exports for existing callers.

`GET /v1/subjects/:id?includeDocuments=true` adds `documents`, keyed by the selected original candidate UUID, for
`wd:Q95074`. It selects only document properties admitted on the Character by its recorded release and actually
present in the current Context observation. Best rank, requested language and original-language fallback use
`pageDocumentReferences`, also used by the page reader. Spoiler-bearing document candidates remain excluded from
this public preview selection. This field is independent of `includeViewerActions` and grants no operation.

Each entry is the existing public `document.get` representation, including original source/rights or author/licence.
The native document owner rechecks current Subject and candidate disclosure and imported source fences. A preview
must match document ID, Subject, candidate, language and digest, with an available, canonical body whose SHA-256
matches. Missing, erased, oversized and mismatched bodies have no map entry; their assertion remains readable and
the existing unavailable/retry presentation applies. Reads containing this field are private/no-store and merge
the document owner's session anchors.

The direct preview admits at most 15 selected bodies, each with a 262,144-byte source cap enforced by the native
bounded document read before body transfer. The complete serialized `documents` map, including keys, labels in body
content and source attribution, retains at most 1,048,576 UTF-8 bytes. Reads are serial and release native connections
between documents and source homes. Work is proportional to those exact document IDs; no candidate-history,
work-population or relationship scan is added. Page composition retains its existing 15-document budget and native
2-MiB document limit, and includes the Character profile's admitted document fields even when a template omits
Summary. Character profile rendering accepts either the native or composed map through the same exact
`statementDocument` binding. Appearance and qualified voice associations retain their separate relation authority.

## Person and Character supplied names

The existing public Person and Character profiles expose one compact supplied-names disclosure. The selected page
label and a supplied fallback are distinguished from supplied labels and aliases. Matching text never joins a Person
to a Character or implies a legal name, persona, romanization, original language or provider verification. Language
groups use native language labels and text direction. Exact duplicates retain each supplied language and label/alias
role. Names have no inferred statement-level source attribution.

The people view imports the work-name grouping/admission producer, with work-only original-title metadata excluded.
It admits the entire labels/aliases response within the same 262,144-byte UTF-8 presentation budget; oversized,
malformed, empty, retired and empty-filter results have separate states. The limit does not establish a native
producer bound. Filtering searches only admitted spellings, without normalizing punctuation, scripts or diacritics.
No catalogue-wide or provider completeness is implied. At most eight groups and 24 rows per group are mounted, with
explicit local continuation. All admitted groups and names remain reachable. Copy results are announced beside the
originating control; late callbacks cannot update a replacement visit.

The finite projection and filter result retain O(B + E) local string/group references, where B is admitted UTF-8 bytes
and E is the number of encoded name/language entries. Mounted name rows are independently bounded at 192. Filter
text is at most 250 UTF-16 code units (at most 1,000 UTF-8 bytes); no filter or name state is added to URLs or shared
caches. Opening, filtering, paging and copying perform no native requests. Current Terms advice uses the existing
bounded mounted-operation authority read once per visit and once per explicit retry. Unavailable, refused and
signed-out advice leave public names and Sources usable. The existing Terms owner reads its original Subject and
retains its own candidate, command and draft state; the names projection is never a replacement edit payload.

Decision: Person/Character names preserve the native selected Context in the validated return address and capture
Realm from the installed page link's final address. Sources and Terms remain unsupported for a non-Global selected
Context; the names stay readable and no Global visit opens implicitly.

The original address fields are locale, Subject UUID/slug, native `context`, final `realm` when selected, and
`#supplied-names`. Destination `via` contains that address, without a nested return or copied spellings. Sources
accepts `realm` and `via`, but no selected-Context input; Terms accepts `via` and reads Global with fresh authority.
The entry explains that limit. The installed `NamesHandoff` and `PeopleNamesView.captureSourcesVisit` carry the
query (250 UTF-16 units), page, expansion, at most eight group descriptors and Sources/Terms focus through ordinary
history. The whole closed descriptor is charged in UTF-8 by `namesReturn` against 8,192 bytes, tighter than the
shared return address's 32,768-character limit; the destination search budget adds encoded `via` to its fixed
2,048-character allowance. The final Realm is included in real hrefs before modifier/new-tab activation.

Fresh native admission precedes restoration. Subject/type, actual Context, release/revision, locale and observed
caller bind the visit; reading/release/reader replacements retire old controls permanently. Changed bindings show
current names and recovery, while missing history metadata explicitly restarts the local view. No provider,
spelling or old authorized payload enters a locator. Filtering/copying adds no read; supported advice retains its
single independent explicit retry. Advice always observes the reader in Global, independently of source
provenance; the unsupported-Context notice identifies that scope rather than inventing a native denial.

The installed shared focus grammar is only `terms | sources`; exact surviving-name focus and protection against
stealing an already connected control's focus require its original owner's additive hook. The Sources owner's
plain `returnTo` anchor still transfers no history metadata: explicit return and a new tab restart honestly; Back
can restore a current finite window. That state-transfer seam remains with Sources. The Person/Character consumer
does not add another handoff, source read or Terms authority implementation.

## Choose a supplied work synopsis

The ordinary About section for Visual Novels (`wd:Q689445`), anime films and series (`schema:Movie` and
`schema:TVSeries`), and books (`schema:Book`) admits only the already disclosed best-rank `schema:abstract`
assertions. It groups supplied document languages using their native tags and retains each assertion as a separate
choice. The default uses the current supported language fallback; an explicit choice does not change the interface
locale. A language describes the supplied text only. It does not claim source language, authorship, verification or a
translation relationship. Person and Character pages keep their existing reading owners.

The selected document must bind to that Subject, candidate, document ID, digest, language and available state through
the existing `statementDocument` contract. Filled text requires no request. Selecting a missing body or retrying makes
one explicit `readPublicSubjectDocument` request; a fresh response repeats the exact binding before display. Empty
documents remain successful reads. Unavailable references, missing bodies and failed reads stay separate, and a short
description remains labeled as a separate fallback. Candidate qualifiers and references render only from the selected
assertion; no page-level source record is attributed to synopsis text. Spoiler disclosure covers both text and evidence.

Sources and the existing authored-field correction route receive a bounded `via` descriptor for the current
candidate, document digest, language, Subject context, Realm, locale and release when present. It retains only selection,
expansion and a safe focus target; it contains no prose, body, credentials or editor state. Return restores only an exact
current candidate match. Correction links use the page's bounded `statementPropose` advice and do not infer authority
from public reading.

Decision: Keep same-language synopsis candidates separate and label them by native order unless disclosed citation
metadata gives a clearer distinction; show evidence only for the selected assertion.

### Cost

The selector consumes only the existing disclosed Subject assertions and makes no language, reference, paragraph or
render requests. It admits the complete choice metadata projection up to 256 KiB and 512 entries; larger projections
make the selector unavailable instead of dropping choices. This Web consumer limit is separate from native statement,
provenance and document bounds. It retains one selected body, one active explicit read and one bounded return
descriptor; no cross-visit body cache is added. Composition growth and native producer checks remain separate acceptance.

### Selected synopsis correction visits

Decision: a synopsis correction visit inspects the exact current Global assertion named by the existing bounded
return locator. It never substitutes the ordinary language default for an explicit selection. Realm and other
unsupported Contexts explain the Global-only destination before canonical Global label reads or editor reads;
return remains a real link to the originating reading. Malformed, duplicate and mismatched visit locators cannot
start an editor. A separate current Global field link retires the selection and starts an ordinary visit.

The authored address and its refresh/review transport retain one validated `via`. The current native Subject,
best-rank synopsis admission, active Definition release and exact candidate/document/digest/language binding must
match before inspection. Failed body binding leaves a changed/unavailable view with a deliberate current-field link.
Inspection does not initialize an editable draft or grant an action; the original authoring controller still owns
independent drafts, current native advice, proposals, confirmation and uncertain-result recovery. Subject, locale,
selection and observed reader changes retire the visit, including A/B/A revisits. The producer charges UTF-8 bytes
and encoding expansion for the whole authored address against its existing 2,048-byte outer budget. The 512-entry,
262,144-byte metadata admission and 2,048-character summary fragment bounds remain unchanged. No native request is
added: inspection replaces selection inside the existing authored Subject/release/document/advice reads.

The return reading announces a changed or unavailable selection and focuses the current synopsis when the saved
binding no longer matches. Correction and sign-in hrefs are enclosed by the selected assertion's spoiler gate.

Exact Sources receiving remains dependent on the Sources projection owner: `explainSubjectSources` currently
redacts document values to `somevalue`, omits their document/digest/language binding and omits the Global resolved
Context. Its language filter can also exclude a selected non-default-language assertion. `SubjectSourcesPage` cannot
verify the required exact current binding from that result. The Sources reader and route remain unchanged until
that owner supplies a compatible bounded projection; row indices, citation text and provider provenance cannot
replace that seam. Native and browser acceptance, including complete Sources traversal, remains integration-owned.

## Person correction current visit

Decision: Person correction returns use one bounded `#person-biography` locator in the existing Subject via address and reread the Person before restoring a matching current assertion.

The mounted Person correction page presents biography documents, admitted occupations and languages, and released
Organization affiliations together. Admission still requires the released Type and exact property. The shared
Definitions root/browser `chooseLabel` rule selects each Subject, target and property label and preserves the stored
language tag; the native `services/kernel/src/semantic/language.ts` path remains a compatibility re-export.

Authored, relationship and disclosed target addresses carry the current Context. A target visit uses one validated
`via` source address with a bounded locator containing a Context UUID, field, optional assertion UUID and one of the
four mounted section names. Return rereads the current Person once through the existing page transport. It restores the
field, open assertion inspection and focus only when that assertion remains current; a replaced assertion is reported
and focus moves to its field. A concealed assertion never opens its spoiler gate during restoration. Missing related
targets remain unreadable and have no label or href derived from their identifiers. Evidence and document bodies stay
inside the existing value and document readers, including their disclosure and rights behavior.

Readable facts do not grant mutation. Authored and relationship corrections continue through their existing editors,
operation advice and command recovery. The locator carries no draft, permission, credential or nested return address;
it does not change Context resolution or choose a replacement assertion. The browser review at 390/1440, light/dark
and keyboard-only remains an integration acceptance.
