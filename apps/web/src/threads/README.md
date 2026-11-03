# Thread authoring

## Board pins

The pin and unpin consumer contract, native-order presentation and pending Content binding are documented in
[Board pins](board-pins.md).

## Board row sharing

Clipboard failures reveal an inline read-only URL field, focus/select it after menu dismissal, and return focus to
the row menu on Close. The URL is the row's already-admitted localized canonical thread destination, without a post
position or additional read; unavailable rows use the untitled destination. Only a successful clipboard write reports
success. Board, row availability, destination replacement and unmount retire prior copy results and manual recovery.

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

Stale-edit recovery previews only the admitted current snapshot without extra reads; Keep editing returns focus to
the unchanged local body, and only explicit replacement with an available body resets the base and settled command
intent. The preview uses unavailable image placeholders rather than inventing media authority. A missing or erased
current body cannot replace the draft. Replacement retires local uploads before mounting the delivered revision.
Unknown outcomes retain recovery of the original immutable command.
The inline edit still inherits native licence and review metadata and offers no separate controls for them.

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
Each command freezes the thread, viewer/session stamp, requested state, native revision and idempotency key. An unknown
response permits only exact retry; a refusal requires a fresh status read and never claims a new current state.
Anonymous readers keep the page and receive sign-in guidance without a private watch read. Notification settings remain
the authority for in-app preferences.

Decision: Until Content delivers generated thread-watch reads and commands, Web keeps an installed unavailable seam; test and story responses are illustrative, not native proof.

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

Long links and table cells wrap; native media keeps its supplied alt text, credit and unavailability/retry behavior.
Spoiler and image-recovery controls retain phone targets and keyboard focus. Detail documents stay selectable and
complete. The exact-revision page uses the same body composition and its existing localized return-to-post link;
opening provenance/history never substitutes a current head for the selected immutable revision.

Rendering adds no loader, observer or network read. One media index plus one renderer traversal gives O(B+V) work
within the existing native document/media limits. Prepared multilingual stories cover the post/revision/return
journey at 390 and 1280 pixels in both themes, plus keyboard use and unavailable media. They reuse recorded DTO
shapes and visibly identify prepared content; they are not native disclosure proof.

## Following reply branches

[Reply context](reply-context.md#bounded-page-branches) owns bounded supplied-page ancestry, local collapse and exact
parent follow/return. `ThreadReading` composes `ConversationBranches` around its passed Post and keeps its existing
reply-selection callback and single composer. The model never sorts the canonical list or reads off-page ancestors.
The existing native exact-post locator is used for missing parents; no new hierarchy producer or hydration seam is
introduced. The priority post action and document renderer interfaces are unchanged.

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
