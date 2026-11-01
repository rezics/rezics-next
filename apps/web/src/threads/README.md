# Thread authoring

The default new-thread, reply and inline-edit composers compare their current local work with the mounted editor's
baseline. Changed titles, structured bodies, review or discussion selections, uploads, active submissions and
unresolved outcomes register with the page's authoring-departure owner. The owner shows one accessible Stay/Leave
decision for router navigation and coordinates an explicit discard decision for changed inline edits. Editors retain
their own draft and command state; the navigation owner keeps only live predicates and never copies a command.

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
