# Reaction caller lifetime

`ThreadReactions` owns one mounted reader/target visit. Changing target kind or ID, withdrawing signed-in admission
or personal readiness, unmounting, or observing loss/replacement of the browser session retires that visit. Account
and CSRF token are both identity fields. Even an observed away/back transition creates a new visit. The shared
`Reactions` child remounts with the current controlled counts and selection; old optimistic state and refusal copy
cannot follow it. Ordinary rerenders, callback changes and count echoes retain the current serialized queue.

Each queued transport checks its original live visit before starting and after each await. It uses that visit's
captured CSRF token, never a replacement token. A retired completion cannot start another queued write, invoke a
refresh callback, or publish a failure into the current view. A refresh already invoked while current cannot be
undone, but its late completion cannot advance the retired queue. Leaving does not cancel or undo a native command
already accepted. A lost response is not replayed; this caller creates no recovery or idempotency contract.

Session observation reads only the existing QueryClient session entry and subscribes to its cache events. It makes
no session/native request and retains no session history. A cache without a known signed-in account and CSRF token
cannot admit a write. Standalone prepared fixtures without a QueryClient retain explicit caller admission and the
existing CSRF-header contract. Hydration and personal readiness still gate controls; anonymous readers keep the
same sign-in return URL. Thread/post kinds and Subject's restricted kinds keep their existing one-slot semantics.

Cost is one constant-size identity/revision observer per mounted caller and constant work per relevant cache event
or queued choice. Only this caller's existing choices are retained, with the existing serialized writes and refresh
callbacks; there is no polling, cache enumeration, background replay or additional request.

`tests/thread-reactions-lifetime.test.tsx` authors default-composition regressions using real `ThreadReactions`,
shared `Reactions` and the session cache, gating only the existing change transport. These regressions are **UNRUN**
pending controller verification. Browser/native assertions remain separate integration obligations; local web
typing does not establish their completion.
