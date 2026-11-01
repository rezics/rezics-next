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

This behavior protects against accidental departure. It does not persist drafts or promise recovery after reload,
tab closure, authentication expiry or reopening the thread. Composer copy describes writing as unsaved and does not
claim server autosave. The guard does not create, replay or alter a write command or its authority.
