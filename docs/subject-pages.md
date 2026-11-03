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

Type3 maps to MusicAlbum with no work/release/track split. Individual tracks and recordings stay unpublished. MusicAlbum
has no Library profile, so Library states, copies and progress stay unpublished. Type6 maps pinned movie platforms to
Movie and pinned TV-template platforms to TVSeries; unknown platform codes stay ignored. Movie and TVSeries expose the
existing `anime.film` and `anime.series` Library controls. Opening an admitted `schema:TVSeason` or `schema:Episode`
subject uses that grain's released fields and Library pin; Bangumi episode family bootstrap stays unpublished on the
series page.

Correction uses the existing album and screen editors: an explicit proposal, native candidate review, and a current
reread of the same subject. Empty, loading, denied, stale and unavailable readings keep useful copy and a bounded retry;
retry never creates. A contributor list previews the credits view.

Decision: MusicAlbum keeps no Library profile; type3 tracks and type6 episode families stay unpublished until those
immutable native profiles and source bindings are published.

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

Release date uses the released time property. Exact day, partial year/month, explicit TBA (`somevalue`), explicit
no-value and an absent statement remain distinct. TBA is never a missing date, Unix epoch or year zero. Status and
region appear only when the current descriptor admits those properties; otherwise the page names them unavailable.
Historical accepting meaning is the statement's pinned `rezics.release` digest, shown separately from the current
editor admission. An explicit correction review is required after configuration changes.

Directed release-to-release streams appear only for admitted item properties whose targets are released edition
types or descendants. Work-targeted CreativeWork relations stay on the existing relation editor. Unknown source
codes stay visible as provenance. Native edition creation, source mapping and adoption remain with Imports.
Missing producer capability is named unavailable; Web does not fork native commands.

Correction reuses Subject facts and the relation editor for the exact selected assertion, then returns to this
release. Native-return links keep the work, existing publisher target selection, candidate reader and Changes.

## Inspect catalogue file metadata and its release group

`/{locale}/subjects/{id}/{slug}/file` is the companion for an admitted catalogue file or release group. The frame
offers it for `schema:MediaObject`, `rezics:CatalogueFile`, `rezics:ReleaseGroup`, `wd:Q82753` and `wd:Q55327` when
those exact type IDs are current. Until Semantic publishes file/group types in the active release, the page names
the profile unreleased. Hashes, size, codec, language and quality are catalogue statements. They never prove the
viewer possesses, matched or consumed the file. A file is not an AnimeRelease. Group credits render independently
from creator credits. File association does not create progress completion. Web does not upload, scan, hash-match,
synchronize AniDB, download or store a private MyList.

Related episode, release, file and group links keep their admitted direction and kinds. A concealed episode stays
concealed. Editing uses the exact selected assertion with revision recovery and return to the file. Native subjects,
links and candidates remain the implementation.

## Release and file visit cost

One selected release or file/group visit uses C = 4 installed components: descriptor, subject, one association page
and at most one explicitly selected detail. Calls per visit are at most C. Web projection and retained response state
are O(∑ L_i + ∑ B_i) for that visit, independent of catalogue/file history N. Each continuation replaces its page.
Correction uses a fixed addressed native command/readback sequence.

| Component   | L_i (rows)                                      | B_i (bytes)                         | Source |
| ----------- | ----------------------------------------------- | ----------------------------------- | ------ |
| descriptor  | 1,024 types                                     | 4 MiB                               | `RELEASE_LIMITS.types` / `RELEASE_LIMITS.bytes` in [definitions portable](../packages/definitions/src/portable.ts) |
| subject     | 64 properties per type                          | unavailable                         | `RELEASE_LIMITS.propertiesPerType`; subject-read bytes have no delivered cap |
| association | 20 (native default; producer admits at most 100) | unavailable                         | Kernel relations/links `limit` default 20, max 100 |
| detail      | 1 selected subject                              | unavailable                         | one `GET /v1/subjects/{id}` |

An absent byte cap is an unavailable receiving seam. The loader never preloads one detail per listed file, never
fans out per association row, and never substitutes elapsed time for this bound. Tests
`apps/web/tests/release-fidelity-profile.test.tsx` and `apps/web/tests/catalogue-file-group-profile.test.tsx` run
populations 32, 256 and 2,048 through the same loader at initial and deep keysets, with sparse concealed endpoints
and a selection replacement. Total work across k deliberate page visits is O(k times the per-visit sum).

This journey adds no engine query, command, projection or worker path. Existing native engines remain producer-owned.

Decision: companion files follow the existing nested `$id_.$slug_.release.tsx` / `$id_.$slug_.file.tsx` route pattern.

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
Manga correction retires current and nested public markup when a reload starts or is refused; private scalar, relation and authored holders retain drafts and exact unresolved commands, and resume only after a fresh read matches the original subject and Type, with nested holders rereading their own addresses before explicit retry.
Manga creation's explicit keyboard qualifier Add orients to the admitted stable qualifier's first editing control, falling back to its labelled group; refused additions, pointer use, moved focus and retired row or Type activation stay quiet.
Manga correction shares one departure decision across scalar, relation and authored holders for pathname or search changes and browser unload: excluded changed assertions and unresolved proposals remain protected during read recovery; Stay preserves the complete holder, while Leave permanently releases local editing and retry recovery without cancelling native work. Pristine source copies and confirmed results alone permit departure, and inline confirmed-candidate review retains all sibling drafts.
People correction retains private scalar and relation holders through failed reads; an explicit refresh restores all profile terms, work references and links only from a fresh matching subject, Type and supplied work, while exact review reopens against fresh authority.
The People profile groups multilingual authored biography, occupations and working languages as labelled facts. `schema:abstract`, occupation concepts and `schema:knowsLanguage` bind only when the active release admits those exact descriptors; unreleased requested fields stay named unsupported, distinct from a supported field with no current value and from an independently unreadable current value. Biography opens the existing authored document route with language, document identity, references and return to the original profile. Occupations and languages are independently selected admitted items, not localized free-text identities. A stale selected fact requires explicit reselection. Returned candidates remain awaiting review; public facts refresh only from a new current read. Create, select and publish labels, Japanese 下書き, the credit create-and-return handoff and 44px wrapping stay with their existing owners. Decision: requested biography, occupation and language IDs are configuration until this release admits them; Web does not fork definitions.
Screen correction also retains only private editor holders across refusal, including concealment; only a fresh matching read restores identity, selected evidence, nested editors and explicit sealed retries.
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
catalogue or substituting sample rows. `/{locale}/my/contexts/new` accepts a name and its data language only, through
the generated native Context creation method. Optional settings/defaults are omitted until a released choice can
be supplied. The returned Context DTO is not an Item.

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
semantics stay with their existing Goal; missing producer capability is named unavailable. Decision: requested parent and
predecessor/successor IDs are configuration until this release admits them; Semantic owns configuration and Imports owns
identity/source mapping.

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
8. **Reviews and discussion.** Public Global reviews and discussions in Content’s native last-activity order, with summaries, bylines, canonical thread links and bounded continuation. Realm reviews remain closed until their population binding is delivered; existing Realm discussions retain native Context authority.
9. **Lists.** Public collections and reading orders that include the subject.
10. **Sources.** Cover credits, source records for the facts shown with each source's licence and attribution,
    external identifiers, and a link to Details.

Community pages decode only against their planned native request and its row limit; missing request metadata or malformed rows make that region unavailable. The DTO omits place, so native board placement remains authoritative.

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

A Character page distinguishes appearing in a work from a directed character-to-character relationship. Appearances
are the inverse of admitted `schema:character` statements on works. Role, credited name, spoiler level, part and any
admitted appearance-specific quantity (including age at that appearance) stay on that exact work statement. They never
overwrite the character's timeless biography, traits or measurements, and they never imply another character identity.
Voice credits (`wdt:P725` with the character qualifier) remain an independent stream.

Relationships are admitted association or world item properties whose targets include the character Type, read forward
and inverse from the current release. Direction uses the property's labels and inverse labels. No relationship type,
privacy inference or automatic merge is invented on the page. Classification ballots and source figures stay with their
existing owner.

The dedicated appearances-and-relationships reading is a finite native page with an explicit continuation. Unavailable
configuration (age-at-appearance, main-character linkage, character-to-character properties the current release does
not admit) is named on the page. An independently unreadable stream keeps the character identity and the other groups.
A vanished endpoint keeps its count semantics and drops the unreadable summary rather than substituting another
subject. Type descriptors for holders on the current page are read at most four at a time, deduplicated within that
page, and not retained between calls.

Correction opens the existing qualified relation editor with the selected statement, slot and holder, then returns to
the same character, stream, cursor and selected work. Candidate review and Changes remain their existing surfaces.
Changing the character, the selected work, the release or refusing the current reading retires previous rows and
action authority before recovery. The Character identity editor keeps its existing groups; this reading does not fork
the descriptor producer or the generic relation editor.

Decision: appearance-specific age, role and main marks stay on the work's appearance statement; VNDB age-at-appearance
and main-character linkage and Bangumi direct character-to-character types remain named unavailable until the current
release admits them.

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
