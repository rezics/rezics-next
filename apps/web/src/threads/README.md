# Thread authoring

## New-thread destination and community rules

The signed-in new-thread route projects the posting destination only from the current board response through
`boardCommunitySource`. It does not request community details again. Global boards have no community source;
missing or unavailable producers, an explicit no-rules result and an unavailable rules revision remain separate
states. The disclosed body keeps its own post, revision, hash and licence identity and grants no posting or membership
authority.

Ordinary route revalidation may replace the current board response while the existing editor keeps its original
board intent, draft, Subject selection, review citation and idempotency key. A changed rules identity closes the old
reading, retains only its compact identity and offers deliberate inspection of the current body. The reader is bound
to the admitted thread-creation lifetime; retirement removes its private content and rejects old focus callbacks.
Text-profile rules use the existing document renderer and same-response body, with no media, member or linked-rule
reads.

Decision: The expanded reader stays in page flow on phones and uses a bounded side panel beside writing on desktop.

## Board pins

The pin and unpin consumer contract, native-order presentation and pending Content binding are documented in
[Board pins](board-pins.md).

## Board row sharing

Clipboard failures reveal an inline read-only URL field, focus/select it after menu dismissal, and return focus to
the row menu on Close. The URL is the row's already-admitted localized canonical thread destination, without a post
position or additional read; unavailable rows use the untitled destination. Only a successful clipboard write reports
success. Board, row availability, destination replacement and unmount retire prior copy results and manual recovery.

## Authoring departure and caller lifetime

The default new-thread, reply and inline-edit composers compare their current local work with the mounted editor's
baseline. Changed titles, structured bodies, review or discussion selections, uploads, active submissions and
unresolved outcomes register with the page's authoring-departure owner. The owner shows one accessible Stay/Leave
decision for router navigation and coordinates an explicit discard decision for changed inline edits. Editors retain
their own draft and command state; the navigation owner keeps only live predicates and never copies a command.
Registered drafts may supply a Leave callback so the owner can retire local continuations synchronously before router
navigation resumes; this does not cancel a command already sent to the native authority.

New-thread navigation compares the pathname and validated preset subject, including browser Back/Forward. Stay keeps
the mounted draft, references, media and focus; Leave retires it and mounts the selected board/subject context with
a fresh command key, even if search navigation reuses the loader result.
Confirming Leave retires the original caller immediately, before a replacement route read can complete.
Subject titles are display hints: title-only, unrelated query and anchor changes keep the current editor without a
prompt, as do refreshed loader command keys for the same context. Session observations still retire authority.

While any registered work needs protection, the page also installs the browser's native `beforeunload` warning.
Browsers provide its text. A confirmed submission releases protection synchronously before its existing success
navigation. A refusal keeps the changed editor protected. An unknown result remains protected with wording that
explains the local retry recovery will be lost and that leaving does not cancel or undo the request. Native sign-out
and a changed or lost session release protection and retire the old editor.

Each editor owns its in-flight reads, uploads and submission continuations. Unmounting, changing its container or
new-thread intent, or losing/replacing its in-memory account/CSRF session retires that work irreversibly, including
switching away and back to the same account. Copied-image reads are aborted; late results cannot reserve an image,
restore private writing, change a replacement editor or call its parent. A prepared editor with an unknown session
does not gain upload authority. Choosing an ordinary reply parent keeps the current writing and reply-intent rules.

Copied images retain their original File and target in the existing bounded upload recovery. Explicit retry resumes
the exact reservation when known and never makes a second fresh reservation after an uncertain reserve. Removal
retires that image's recovery. Network uncertainty stays unknown. Submissions reject synchronous duplicates and
retain the exact immutable command and key for current-editor retry. Leaving only retires local continuations; an
already accepted native command is neither cancelled nor undone.

This behavior protects against accidental departure. Signed-in, admitted new-thread and reply editors also offer
optional [browser-only writing recovery](#browser-only-writing-recovery). Unsaved changes and current-visit exact
retry still need the departure guard. Inline edits remain current-visit-only. The guard does not create, replay or
alter a write command or its authority.

A definitive edit precondition conflict exposes **Review current version** using only the current-post result
returned by that edit. The inline editor opts into paired inspection: **Your retained draft** and **Current version**
are separate, independently labelled readings. Phone panels stack; desktop panels share a bounded dialog without
horizontal page overflow. They are neither a merge nor a native revision history. The supplied current licence,
creation time and revision time appear only when present; no author or change attribution is inferred.

Each document has a local, paged section index, a complete reader and an optional selected-section reader through
`DocumentBody`. A selected section references its original block, including all text, rather than an excerpt.
Labels contain at most 96 Unicode code points and never disclose spoiler text, component payloads or image labels.
A label is navigation, not a truncated document. Image placeholders are inert because the conflict result supplies
no exact media disclosure; no media, revision or neighbouring-post request fills this reading. Installed codec
admission refuses unsupported snapshots and documents above the smaller installed native/editor limit of
2,097,152 UTF-8 JSON bytes. Oversize content is explicitly unavailable, never silently shortened or repaired.

The optional `presentation` port on `EditConflictRecovery` supplies a draft reference, monotonic local revision,
original authoring authority, abort signal, snapshot readiness and a synchronous read guard. Callers without it retain
the single-current-reader visit. The composer increments that revision before editor snapshot publication, on snapshot
failure and on every body/media-reference replacement. It retains ownership of the rich editor, media recovery,
file tools, local recovery and immutable command preparation. The route supplies the original post-reader admission
through `inspectionAdmission`; a new reader/session cannot reuse the original visit even if its displayed identity
looks the same. The original caller's guard is consulted before replacement, section navigation, spoiler disclosure
and return focus. No alternate session or content read is created.

Opening binds the exact conflict result object, post/thread/revision/security identity, current-body and media-list
references, licence, authority, signal and retained draft revision/reference. Changed writing, pending snapshots,
a replaced result or a retired admission permanently invalidates that visit and clears both readings. Reopening
uses the still-admitted conflict result afresh; it does not refresh the native post. Missing and erased current bodies
remain unavailable while the draft stays editable under its existing admission. Unknown delivery never opens this
visit: it retains the exact original key and immutable payload for retry/readback in its existing owner.

**Keep editing**, cancellation and Escape change no draft value, selection, media recovery or command intent. Return
restores the originating editor selection where supported, falling back to its Review button if needed; a newer
outside pointer/focus action wins. Closing frees document projections. Retirement cancels selection/focus state and
late callbacks. **Replace draft with current** is the existing destructive confirmation: it only replaces local
writing through the original owner callback, retires discarded uploads and resets the settled command with a fresh
key and returned base revision. Replacement submits nothing and adopts no native revision. Only the existing
explicit **Save changes** prepares the next command.

Projection performs bounded codec/byte admission and one O(B + N) node walk; it retains only two original document
references, bounded labels/offsets and constant-size visit data. Each index page mounts ten section controls, so the
paired dialog mounts at most twenty. Each side mounts one reader, either the full document or one complete selected
block. Paging starts zero requests; opening review adds zero reads and local replacement adds zero writes.

Decision: opening Review explicitly opens both full readings; selecting an index entry shows that entire section,
and **Read full document** restores the complete reader without changing either writing.

The inline edit still inherits native licence and review metadata and offers no separate controls for them.

## Browser-only writing recovery

“Save in this browser” explicitly enables a device-local copy of confirmed-unsent text/document and title for the
mounted draft. It is not server autosave or device sync. Other users of the same browser profile may inspect its
storage; the privacy explanation appears before enabling saving. Stopping saving retains the last copy; Discard
removes that exact browser copy while leaving the live editor intact. Changes need 750 ms idle time to reach storage,
so departure protection remains necessary, including immediately after editing a saved draft.

A later signed-in, admitted visit loads only the same account and context, presents a dated plain-text preview and
requires Restore or Discard. It never injects text on load. Restore confirms replacement when the editor already
contains writing, validates the installed document schema again and allocates a fresh current-visit command key.
The current admission, thread, reply parent and selected Subject ids must match. It does not restore fetched labels,
review citations or selections into another route; the current page owns those values and native submission checks
remain authoritative. No loader, network autosave or new native producer is added.

Decision: Without an installed reload media-admission method, browser copies retain attachment descriptions as text
and require attaching files again; they store no media references, upload permissions or opaque component payloads.

The versioned private namespace `rezics:private-writing:v1` uses one bounded metadata index and 16 fixed payload
slots. Each serialized payload envelope is at most 128 KiB in UTF-8, including its title, document, text projection
and format metadata, for a 2 MiB committed payload ceiling. Metadata has a separate 64 KiB bound. New copies use an
empty slot; when full, the oldest copy (including copies older than 30 days) is proposed for replacement with its
date and explicit confirmation before any replacement. No old copy is silently expired. Another account's body or
title is never read to choose an eviction. A same-context existing copy must also be explicitly replaced or restored.
An exact current-visit saved revision can be updated without repeatedly confirming its replacement.

The store reads O(K) indexed metadata, K <= 16, and encodes/decodes only the selected payload in O(B), B <= 128 KiB.
It never enumerates unrelated localStorage. A mounted scope owns at most one 750 ms timer and one synchronous load;
retirement cancels its timer without retries. Account/readiness/CSRF replacement, including away/back notifications
before React renders, aborts the existing composer lifetime, clears the preview and export immediately and prevents
late restore/save work. Route departure retires the caller before resuming navigation. Changing context retires the
old browser-draft scope without moving its text to the replacement context. Other-tab storage changes also retire
that browser-draft scope to avoid overwriting a replacement revision.

Before a native submission starts, any exact saved copy (and any unchosen same-context preview) is synchronously
marked unknown in the index. If that marker fails, the browser keeps writing and does not start transport. Saving
and restoring stay suspended while submission is in flight or unknown; the explanation explicitly says a browser
copy cannot determine whether a request was applied. Reloaded unknown copies can be discarded but cannot become
fresh commands. The existing same-visit immutable retry remains usable. A known refusal re-enables the original
confirmed-unsent copy; confirmed success deletes only the submitted draft's exact saved revision, preserving any
replacement copy. Cleanup failures leave an unknown copy and an actionable storage error, never a restorable replay.
Previously unknown reload previews cannot become confirmed-unsent merely because an unrelated request was refused.

Storage denial, quota errors, damaged index/payload pairs and unsupported versions keep live writing intact. Retry
is explicit. Export reveals a selectable plain-text field; Copy reports success only after clipboard completion and
falls back to manual selection on denial. Text export excludes formatting and attachments. A separately confirmed
reset removes only this namespace's 16 known slots and index, with a warning that other accounts' local copies are
also removed; it never changes the live editor or published content. Index/payload revision mismatches fail closed.
The bounded v1 reader rejects unknown versions rather than guessing a migration from legacy data that may contain
publication commands. It does not scan or import legacy draft keys.

Legacy reply/composer and draft-recovery stories informed the local-copy and export choices; no legacy command,
receipt, media reservation or automatic restoration is ported. Prepared recovery stories use supplied outcomes and
show that status explicitly. The focused recovery tests pin storage boundaries, privacy/uncertainty, retirement and
the mounted reload/restore journey. Existing authoring-departure, composer lifetime and composer stories retain
ownership of navigation, upload and rich-editor interactions.

## Author erasure caller lifetime

The mounted author-erasure entry binds its admission and command to the current thread, viewer, signed-in session,
CSRF token and component lifetime. It reads the existing session query cache without adding a session request. Cache
notifications record each identity transition, including away/back and same-account token replacement, before React
can batch the visible render. Readiness loss retires the visit. Target changes and unmount do the same.

Admission results are private to that visit. A queued command checks the original visit before and after its async
server-function import and immediately before starting transport. It captures the visit's CSRF token before that
boundary, so it cannot borrow a replacement session. Synchronous duplicate confirmation is suppressed. Confirmation
and the immutable request/key remain available when the secondary action closes and reopens; an uncertain response
can retry only that exact request from the same visit. A retired caller never presents late admission/progress,
changes replacement state, calls success/navigation callbacks or claims the remote command was cancelled or not
applied.

The operation route binds loader data and displayed progress to the operation id and current authenticated viewer.
Account, readiness, CSRF, route, source or read replacement withholds old private counters and requires an actual
current read before they can reappear. Session hydration does not remount a valid visit or restore its four-read
foreground budget. Automatic reads remain visible-tab-only and capped at four; terminal operations and refusals stop
automatic refresh. Explicit manual recovery remains available for a nonterminal unavailable result, and a late read
cannot update a replacement visit or replenish its budget. A caller read failure stays unavailable rather than
claiming completion.

## Board directory continuation recovery

Unavailable continuation pages offer a localized “Start from the first page” link that drops the cursor while
retaining purpose and contribution Subject context through ordinary route navigation. First-page failures keep retry,
and the recovery action does not imply why a read was unavailable.

## Board slow mode

New-thread and reply composers show the native posting interval and the caller's next permitted attempt. An admitted
moderator inspects and changes that interval on the board. Waiting keeps the draft; countdown text is display
guidance and never auto-submits. Decision: Send and Retry stay explicitly usable so the browser clock does not gate
native permission. The [slow-mode contract](slow-mode.md) records units, eligibility display, private caller
retirement, native refusal recovery and the remaining `boards({ id }).slowMode` producer binding.

## Thread watch

A signed-in reader can watch one currently readable thread for preference-governed in-app activity. Watching grants no
read access and sends no email. The mounted control reads private state only for the current thread and viewer/session;
it uses a no-store read outside SSR/shared caches and retires the result when its target, access or credentials change.
The generated native GET returns exactly `{watching}`; PUT and DELETE return 204. Each command freezes the thread,
viewer/session stamp, original credential owner and requested state. There is no revision, command-key receipt or
version lock. A 204 confirms the requested operation at its response. An unknown response offers explicit retry of the
same naturally idempotent request or a fresh current-status read; a successful read does not establish a receipt for
the earlier request. A failed recovery read retains the uncertain request for retry. There is no automatic write retry.
Known refusals offer honest access/unavailable feedback; a fresh status read precedes another toggle.
The existing in-memory browser session observation retires state synchronously on account, credentials or readiness
replacement, including away/back. Target, admitted source, access loss and unmount also irreversibly retire the visit.
A late import checks its original dispatch fence and never obtains replacement credentials. Retirement revokes local
results, not remote execution. One initial private read per admitted visit and one active operation use constant state;
there is no polling, account inventory, browser watch registry or watch read during SSR.
Anonymous readers keep the page and receive sign-in guidance without a private watch read. Notification settings remain
the authority for in-app preferences.

Decision: Current-status recovery is available alongside exact retry, and a failed status read preserves the original
uncertain action; only a successful current read or command response clears it.

The default adapter loads the existing server/client boundary and uses generated `threads({id}).watch.get/put/delete`
with normal session authentication and CSRF protection. If those generated methods are absent, the unavailable seam
belongs to Content: generate GET/PUT/DELETE `/v1/threads/:id/watch` from `services/kernel/src/content/routes.ts`.
Settings watch inventory/removal and Inbox watch-notice presentation belong to Performance; this control owns neither.
The prior feed/thread action and notification views informed the separate watching/delivery guidance: read-only
`legacy-final:apps/web/features/feed/actions.tsx`, `shell/notifications/notifications-view.tsx`, and the earlier checkout's
`content-feed/components/feed-item-card.tsx` and `notifications/pages/notifications-page.tsx`, as linked in the
[render audit](../../../../docs/research/page-needs-api-render-audit.md); no legacy code is ported.

## Shared post actions

Detail posts use the feed `FeedActionBar` at the top right with the installed reaction count map and viewer slot.
The up/score/down pill uses the same `ThreadReactions` serialized one-slot queue; other reaction chips and the picker
remain available. Dense replies use the plain pill. The detail host retains its original reaction refresh callback,
current-reader source lifetime, reply intent, author edit/erasure commands, history, licence and provenance.
Copy/share destinations use the existing post locator, including posts outside the first page. Report stays in the
existing author/report overflow ceremony. `PostActions.extraEntries` adds the shared unavailable mute/hide entries
without changing report submission, verification, session retirement or copy recovery.

Decision: Work Library actions navigate to the existing Subject Library slot; post actions create no Library mutation
or mount read. Browser share/copy results belong to the current session/source visit. The board owner consumes the
exported port as described in [feed actions](../features/feed/README.md#card-actions), retaining pins and slow mode.

## Post reading rhythm

`PostReadingFrame` owns the byline-to-body hierarchy and the visible permalink/focus surface; its action and reply
context slots consume the existing controls unchanged. The header uses the installed `FeedActionBar` detail port;
licence, history and provenance retain their positions after the body. `ThreadPostReadingBody` passes the complete snapshot to the
existing `DocumentBody` and `NativeDocumentImage`, with a single exact-document media index. The current document's
post, thread, revision, digest and declared media must all match the supplied disclosure. A replacement revision
starts a fresh spoiler visit. Erased/withheld placeholders, keyed editing and current-reader retirement retain their
existing owners and never pass a retired body to this composition.

The shared `PostReadingBody` uses a 65-character prose column and an 88-character media region. Figures, code and
tables stay in authored order and may use that wider region. Supplied CJK block/mark languages retain their semantic
attributes and taller leading; unknown document language stays unknown, independent of the interface locale.
Decision: Code wraps long tokens while preserving indentation and newlines, so phone readers can read complete code
without a separate horizontal-scroll focus target.

Decision: Wide reading shares one post-scoped inspector; plain tables with no media or interactive descendants are
eligible, spoiler content becomes eligible only after disclosure, and code copying is capped at 128 KiB.

Published current-post and immutable-revision readers register at most 64 disclosed code/table blocks once per visit.
Inspection keeps the same rendered block in authored order; table overflow stays keyboard-scrollable, and code copy
reports only a completed clipboard write or offers the same selected code for manual copying. Concealed spoiler content,
an unavailable post, or an unsupported table structure keeps its ordinary renderer without a second preview or inspector.

Long links and table cells wrap; native media keeps its supplied alt text, credit and unavailability/retry behavior.
Spoiler and image-recovery controls retain phone targets and keyboard focus. Detail documents stay selectable and
complete. The exact-revision page uses the same body composition and its existing localized return-to-post link;
opening provenance/history never substitutes a current head for the selected immutable revision.

Rendering adds no loader, observer or network read. One media index, one bounded outline projection and the renderer give O(B+V) work
within the existing native document/media limits. Prepared multilingual stories cover the post/revision/return
journey at 390 and 1280 pixels in both themes, plus keyboard use and unavailable media. They reuse recorded DTO
shapes and visibly identify prepared content; they are not native disclosure proof.

### Published post sections

`PostReadingBody` offers an optional Sections launcher after hydration when the exact admitted published snapshot
has a visible, nonempty heading. It composes the installed shared renderer, preserving its headings, language,
marks, code and image renderer. Current post and immutable-revision readers each own their mounted namespace;
no draft inspector, history picker, reply anchor or post permalink is repurposed. A whole-body warning remains
outside and before this reader; concealed bodies must not be mounted beneath a warning.

Decision: Sections closes after a choice at both widths; the current visit keeps one Return to previous position
bookmark captured before the outline opens, including nested scroll containers and the last live reading focus.
Phone uses the shared scrollable BottomSheet, desktop the shared Dialog. Dismissal restores launcher focus; a choice
waits for modal dismissal before instant local scroll and heading focus. The existing six-rem shell offset also reserves the measured sticky launcher and a wrapping Return row.
The compact sticky controls wrap, have 44px targets and never narrow the prose column. No state enters browser
history, addresses or storage. A disappeared target reports unavailability and focuses the live reader.

One iterative O(B+N) projection runs per exact snapshot and live spoiler disclosure identity. Only source text and
hard breaks contribute plain labels, capped at 120 Unicode codepoints including any ellipsis. Image alt/title,
mention identities, link metadata, ruby annotations and embedded-component payloads never contribute labels or
requests. Headings with any still-concealed spoiler, hidden ancestor or unsupported visibility shape are omitted
entirely from labels and counts. Only the renderer's live reveal authority can admit newly disclosed headings;
opening Sections never reveals one. Visible heading levels retain hierarchy across omitted headings and duplicates
remain independent positional targets. At most 100 entries/target references survive; overflow counts only additional
eligible visible headings. There is no observer, scroll subscription, DOM-wide scan, polling or enrichment.

A document, source, viewer, route or readability replacement retires targets, return state and pending focus work,
even if the new document has equal text or returns to an earlier identity. Current readers pass their original
`PostCommandLifetime` guard; immutable readers pass their admitted revision visit guard. The optional shared heading
attribute and disclosure ports add no markup changes for other document consumers. Sections stories connect the
actual post frame, current reader and immutable reader at phone390 and desktop1280 in light/dark, including keyboard,
concealment, overflow, unavailable targets and viewer replacement. Integration owns visual review of that journey.

Behavior references: `legacy-final:packages/ui/src/components/document-body.tsx` (optional reading-anchor port),
`legacy-final:apps/web/features/feed/post-row.tsx` (post navigation), the earlier app's
`posts/components/post-detail-article.tsx` and `content-language-display/localized-portable-text-content.tsx`
(document structure and explicit concealment), and [GitHub's writing guide](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#headings)
(heading outline interaction). These are source/interaction references, not runtime or visual proof.

## Document image inspection

An available inline document image can open one image inspector from its own localized **Inspect image** control.
The inspector uses only the supplied presentation and one of its admitted `coverSrc` derivative URLs. It starts
fitted to the viewport; **Actual pixels** displays the selected delivered derivative at its stated pixel dimensions.
Both modes keep the image's aspect ratio truthful. The dialog keeps Close and both scale controls reachable, lets
keyboard users focus and scroll the image region, and returns focus to the inline control when that visit closes.
Alternative text and the existing admitted rights holder, source link and licence wrap in a separate scrollable
metadata region.

Inspection mounts no second image surface until explicitly opened, and it never reads the media map, calls a native
producer, resolves an original, preloads another document image, retries in the background or stores private image
metadata. The selected derivative's failure retires the dialog and all inspector metadata through the existing inline
failure/retry state. The current post and immutable-revision body already own disclosure, spoiler reveal and reader
lifetime; replacing or withdrawing that presentation removes the inspector with it. Callers without those guarantees
can disable the optional affordance with `inspectable={false}`.

Decision: Inspection opens in Fit view; Actual pixels uses the admitted variant with the largest pixel area and shows its exact delivered dimensions.

## Following reply branches

[Reply context](reply-context.md#bounded-page-branches) owns bounded supplied-page ancestry, local collapse and exact
parent follow/return. `ThreadReading` composes `ConversationBranches` around its passed Post and keeps its existing
reply-selection callback and single composer. The model never sorts the canonical list or reads off-page ancestors.
The existing native exact-post locator is used for missing parents; no new hierarchy producer or hydration seam is
introduced. The priority post action and document renderer interfaces are unchanged.

## Local writing files

Admitted signed-in new-thread and reply composers expose **Writing files** in the existing editor action row.
This journey owns local file reads, previews and explicit replacement, never browser autosave, native submissions,
inline stale-edit recovery or publication. The original rich editor, upload controls, mention lookup, Send and exact
uncertain-command retry remain their owners. Inline edits keep their existing recovery surface.

Decision: Local writing uses Blocks codecs, replaces media and opaque components with visible text, rejects nesting
beyond 64 JSON containers, and adds a narrow editor snapshot-state callback because the installed editor lacked one.

Supported imports are `.json` (a strict `rezics-document-v1` Text or Blocks snapshot), `.txt` (literal plain text),
and `.md`/`.markdown` (the installed CommonMark codec, including its spoiler support). Text snapshots become Blocks
for the existing discussion editor. HTML in Markdown stays literal text. No other suffix, network URL, archive,
legacy command envelope or guessed schema is accepted. Invalid versions, attributes, unsupported nodes, malformed or
duplicate block IDs refuse the entire import with a localized error; original writing stays intact. File MIME is
only a chooser hint. A suffix chooses a codec, never provenance, licence, attribution or attachment authority.

The chooser rejects more than 1,048,576 bytes before reading. This is the smaller of the journey's 1 MiB ceiling and
the installed editor's 2 MiB snapshot ceiling; the document codecs declare no smaller byte limit. Exactly one
`File.text()` and one admission journey run per selected file. Cancellation reads nothing. Actual UTF-8 bytes are
also checked after reading. Plain-text paragraph expansion has a conservative early lower-bound refusal; converted,
normalized snapshots are checked against 2,097,152 bytes before preview. Oversize conversion never truncates text.
The iterative JSON depth guard runs before recursive validation. Work is O(B + N) over bounded file bytes and admitted
nodes, without polling or network access. The focused tests project 1 KiB, 64 KiB and 1 MiB inputs without timing
thresholds and cover a one-byte overflow, invalid IDs, nesting, paragraph expansion and late file completion.

Preview renders only the admitted projection through `DocumentBody`, with an explicitly unavailable image renderer
and no metadata resolver or extra reader context. Image/media references become paragraphs containing their alt or
caption; opaque components become their fallback text. Their source URLs, arbitrary payloads and capability fields
are absent from the projection. Unsafe links and links containing URL credentials or named authentication parameters
lose their link mark while retaining visible text. Separate localized counts explain every category of repair.
Supported text, marks, IDs and language attributes otherwise keep their document meaning. Reattach files through the
existing native upload control if needed. Importing does not queue an image read or reservation.

Inspecting a file never changes writing. **Replace unsent body** explicitly replaces only the body, leaves title and
posting choices intact, resets a settled current-visit command key and returns keyboard focus to the editor.
**Keep current writing**, Cancel and Escape retain the draft. A synchronous editor transaction, title/body change,
normal recovery restore or upload-source replacement invalidates the pending preview/read. Confirmation compares the
exact current draft revision again. A newer file selection or cancellation retires older callbacks. In-flight and
uncertain commands and pending uploads suspend replacement; a file can never reset their immutable command or key.

Exports contain only the currently identified editable body, using installed canonical `serializeDocument` or
`documentText`, with the same media/component/link repairs and notices. They never include command metadata, receipts,
credentials, session state, upload capabilities, titles, private fetched context or publication choices. Plain text
is a projection and loses formatting. An editable confirmed snapshot remains exportable during an uncertain command;
this does not establish the command outcome. Pending snapshots cannot be exported as current writing. A failed editor
snapshot blocks normal export and Send; **Download raw recovery** is visibly separate, carries only editor text and
node structure without attributes or capabilities, and is explicitly neither portable nor submit-ready. Raw recovery
is never offered as a valid document import.

Each visit retains one current preview and at most one object URL. Repeated export, changed writing, close and
retirement revoke the prior URL. A download request reports only that the browser was asked, never that a file was
saved. Every export also provides a focused, selected read-only content field and explicit Copy; clipboard refusal
retains manual selection and never reports success. Account/readiness/CSRF replacement, sign-out, route departure and
unmount retire the existing composer signal synchronously, clear private preview/export DOM, revoke the URL and fence
late file/clipboard results. There is no second draft store or autosave timer.

The file chooser bound, deliberate local import and distinct recovery export retain the meaning of
`legacy-final:apps/web/features/document-editor/body-editor.tsx`; no legacy command, schema or editor is copied.
Prepared portable-writing stories use the real composer and visibly supplied submission outcomes; raw-recovery states
are separately labelled prepared editor fixtures. Existing composer and browser-draft stories continue to own rich
formatting, upload, departure and reload interactions. Portable-writing interaction stories cover phone 390 and
desktop 1280, light/dark, long writing, file inspection, cancellation, export fallback, replacement and keyboard return.

## Inspecting current unsent writing

New-thread, reply and inline-edit composers offer **Inspect writing** without changing Send or Save. Inspection
captures one immutable current body and the applicable title; its single read-only `DocumentBody` is separate from
the mounted editor. Board/thread/reply context and an edit's source revision remain distinct from draft text. It adds
no author identity, publication date, licence choice, review routing, storage, import/export or publication command.
Close preserves the unchanged editor's selection. Structure links move within this one preview; Repair closes it and
resolves the exact current `data-block-id` in the existing editor. If that ID cannot be found, focus returns to the
editor with an explanation, without selecting a neighboring block. Keyboard dismissal and dialog focus are owned by
the installed dialog; controls retain 44 px targets, wrapping labels and reduced-motion behavior.

Decision: Measure body text in Unicode code points, title capacity in the current Web caller's UTF-16 code units,
and document sizes in UTF-8 bytes; leave the unavailable per-request and body-text budgets explicitly unknown.

`documentText` owns text projection: hard breaks and paragraph separators count, combining marks count separately,
emoji and CJK retain their code points, mentions contribute `@` without account lookup, and link targets remain in
JSON rather than being counted as resolved labels. Ruby annotations are not base text; image alt text, media captions
and component fallbacks follow the codec. `serializeDocument` owns canonical normalized bytes. Inspection also counts
the exact supplied body JSON's UTF-8 bytes. Neither byte count includes the request envelope or claims upload admission.
Supported IDs, marks, link targets, media references and Unicode spelling are never rewritten to fit a counter.

The delivered editor checks body snapshot JSON against 2,097,152 UTF-8 bytes. The portable-writing adapter's existing
64-container local safety guard is applied iteratively before recursive document admission; over-depth or oversize
snapshots are rejected whole, not truncated. Canonical output must also fit that smaller delivered document ceiling.
The document codecs expose no smaller size bound. The current Web new-thread validator accepts at most 512 title
UTF-16 code units (the native thread schema's 1024 maximum is not this caller's budget). The shared
`threadTitleCodeUnitLimit` names that unchanged rule. The existing image composer admits at most 32 image slots;
remaining slots describe editor structure, never attachment permission. No maximum is invented for other media,
visible body text or total request bytes. The native content reader has a 2 MiB request envelope cap, but Web exposes
no typed per-post request budget; context, IDs and title consume that envelope too, so it is not displayed as capacity.

Inspection consumes portable writing's installed `onSnapshotPending`, `onSnapshotError` and admitted `onChange` port.
An unnormalized current editor state is honestly pending or unsupported; inspection never falls back to an older body
as though current, nor replaces the editor's recovery authority. Inline edits now consume that same optional port.
Decision: Inline current-writing and paired-conflict inspections share the admitted snapshot revision and native
reading-admission identity; admission loss retires current-writing inspection without changing command ownership.
A valid profile/schema is distinguished from an empty body, unfinished uploads, unavailable attachments, supplied
server refusals, in-flight commands and unknown outcomes. Inspection does not read media state, resolve accounts,
fetch metadata, acquire upload capability, retry, reseal or unlock a command. Without admitted current image summaries,
the existing reader's unavailable-image placeholder is used; no media URL is invented.

Only one captured snapshot plus summaries is retained by an inspection visit. Explicit inspection performs one
O(B + N) admission/projection pipeline under the installed bound, reusing results for the same source identity and
revision. Traversal collects at most 100 outline entries and 20 diagnostic rows with exact omitted counts. The full
reader remains a single document even when navigation is shortened. Tests cover 1 KiB, 64 KiB and 1 MiB inputs,
many small blocks, one large block, long links, the 32-image boundary and deeply nested rejection. Work is linear in
serialized bytes and nodes; there are no per-node reads or requests. Typing only invalidates the optional inspection
in O(1); measurement waits 750 ms after the last change and cancels superseded work. Pending or unmeasured values
are labeled. The rich input fallback no longer flattens the live ProseMirror document on each keystroke.

Changed writing or supplied readiness facts clear the prior preview immediately and require explicit refresh while
inspection is open. Target, admission, route, edit source and authoring lifetime replacement retire the old visit.
Session/account/readiness/CSRF away-and-back changes use the composer's existing synchronous abort authority: private
preview DOM, selection callbacks and pending measurement are discarded and cannot revive. Browser-only confirmed-
unsent recovery and same-visit immutable-command recovery retain their separate owners; inspection creates no copy
in browser storage and cannot turn a saved unknown outcome into a new replay. Prepared stories supply outcomes and
exercise the connected composer; they do not establish native acceptance or final browser capture evidence.

## Finding and inspecting returned revisions

Post history uses a compact ordered list around the existing HistoryDisclosure and
[history lifetime](post-history-lifetime.md#loaded-revision-inspection). Each summary contains only admitted
author disclosure, actual revision/creation time, licence, availability and provenance presence. Loaded ordinals
are explicitly local; neither the first returned row nor its position identifies the current revision. The
native response provides no body summary, so there are no body-derived previews or inferred change descriptions.

Decision: histories initially show collapsed rows; exact immutable links open in another tab so the original
history, selected inspector, focus and reading position survive the visit without persistent storage.

The loaded-only navigator, row inspection controls and Previous/Next never fetch. A single active inspector
reuses the existing document/media renderer and provenance view. Closing it removes the full document from the
DOM without changing that revision's availability. Removed bodies retain only the admitted metadata and an
honest explanation. The review citation and the author's differing current vote remain separate facts.

Summary projection is O(N) small metadata records for N supplied revisions. Generated author/licence text fits
within 240 code points; documents are neither flattened nor duplicated. Inspection state is constant in N.
The original disclosure owns page reads, authors/mentions/media, exact failed-cursor retry and continuation
focus. The presentation is keyed by its connection and retires with the session, account, read authority,
QueryClient, route and locale. Returning through an A–B–A identity change cannot restore old disclosure.

Exact-address actions keep every canonical post/revision link. Opening a new tab leaves the original position
intact; the installed copy helper offers a selectable same-origin URL if clipboard access fails. Identifiers
stay out of ordinary summary labels. No private text, credentials or history cursor enter return navigation.
Prepared revision-history stories exercise loaded, inspected, removed, partial-failure and terminal states at
390px and 1280px, in both themes; prepared fixtures do not establish native response authorization.

## Inspecting authored references while reading

Decision: use one responsive References sheet/dialog for an ordered, bounded occurrence list and one selected
detail, with separate actions to follow, copy, or return to the exact source occurrence.

The live [Photosynthesis References list on Wikipedia](https://en.wikipedia.org/wiki/Photosynthesis) keeps work
titles distinct from separately linked DOI and PubMed destinations. REZICS keeps the authored link label distinct
from its admitted destination for the same reason; a host is shown only as a location, never as a trust signal.

`ThreadPostReadingBody` enhances the exact available published snapshot only after hydration. Its single iterative
O(B + N) projection shares traversal with Sections, follows the renderer's spoiler-mark order and omits concealed,
unsupported-visibility, unsupported-URL and mention occurrences. It retains at most 64 descriptors, each with a
label of at most 120 Unicode code points; excess disclosed links receive a truthful omitted count. The installed
link schema has no narrower `href` size than the admitted snapshot, whose authoring ceiling is 2 MiB. Descriptors
refer to that snapshot's original URL strings, and only the selected destination is retained by the detail view.
Repeated labels and URLs remain separate occurrences in authored order with distinct namespace-scoped source
targets. The list makes no metadata requests and does not inspect media, shell, reply or provenance links.

The ordinary renderer keeps authored text, admitted `href`, optional authored `title` and its normal anchor
navigation. References opens only from its 44px control; a reader selects one occurrence, sees the full wrapping,
isolated destination, and may follow its ordinary link, explicitly copy that exact address, or return to the source
without changing the fragment, revision or reply target. `mailto:` destinations are identified by their scheme;
web hostnames are location labels only. A denied or missing clipboard leaves the exact read-only address available
for manual selection. Pending writes capture their original destination, and their feedback retires when selection,
reader lifetime or source identity changes.

Source ids, selection, focus bookmarks and copy feedback are local to one mounted reader and its viewer/route
lifetime. Replacing the account, document, revision or admitted snapshot retires them even when the text is equal.
The whole-body disclosure owner stays in front of the reading body, and the original spoiler controls remain the
only authority for inline disclosure. Plain reading and ordinary links still render without JavaScript or if the
optional References visit cannot hydrate.
