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

This behavior protects against accidental departure. It does not persist drafts or promise recovery after reload,
tab closure, authentication expiry or reopening the thread. Composer copy describes writing as unsaved and does not
claim server autosave. The guard does not create, replay or alter a write command or its authority.

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
