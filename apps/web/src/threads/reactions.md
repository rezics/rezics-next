# Reaction caller lifetime

`ThreadReactions` owns one mounted reader/target visit. Changing target kind or ID, withdrawing signed-in admission
or personal readiness, unmounting, or observing loss/replacement of the browser session retires that visit. Account
and CSRF token are both identity fields. Replacing the QueryClient also creates a new visit, even with identical
session fields. Even an observed away/back transition creates a new visit. The shared
`Reactions` child remounts with the current controlled counts and selection; old optimistic state and refusal copy
cannot follow it. Ordinary rerenders, callback changes and count echoes retain the current serialized queue.
Every committed success update of the exact one-segment session Query retires earlier work synchronously, even
when all serialized fields are equal and structural sharing retains the data object. Fetch starts, observer
attachment/results notifications and invalidation without a successful replacement preserve current work.

Each queued transport checks its original live visit before starting and after each await. It uses that visit's
captured CSRF token, never a replacement token. A retired completion cannot start another queued write, invoke a
refresh callback, or publish a failure into the current view. A refresh already invoked while current cannot be
undone, but its late completion cannot advance the retired queue. Leaving does not cancel or undo a native command
already accepted. A lost response keeps its immutable intent and Idempotency-Key for an explicit retry in this visit.
Other choices are disabled until recovery reads the current server slot and projected totals. Replay receipts and
conflicts cannot finalize counts or selection; a failed current read retries only that read. Recovery does not survive
session/target replacement, unmount or reload. The browser key is forwarded unchanged after the existing reader fence.

Session observation reads only the existing QueryClient session entry and subscribes to its cache events. It makes
no session/native request and retains no session history. A cache without a known signed-in account and CSRF token
cannot admit a write. Standalone prepared fixtures without a QueryClient retain explicit caller admission and the
existing CSRF-header contract. Hydration and personal readiness still gate controls; anonymous readers keep the
same sign-in return URL. Thread/post kinds and Subject's restricted kinds keep their existing one-slot semantics.

Mounted commands capture the current session reader with their CSRF token. The server prepares that command's
session once and compares the supplied reader with the identity recorded by the same preparation before making a
native request. The reader is only a mismatch fence; the native credential and CSRF/origin checks remain authoritative.
Standalone prepared transports may omit the operand, but production mounted commands may not dispatch without it.

Subject own-reaction reads use a separate mounted scope keyed by subject, locale, view, actual browser reader,
session admission and provider-local generation. The BFF prepares authorization once, captures the reader from that
preparation, and returns the private value only with that reader. Session cache errors, removal, replacement, route
changes and unmount retire the old scope synchronously. Public counts remain visible with no own selection while a
private response is unavailable. A fresh same-reader admission performs a fresh private read; no stale cache entry,
in-flight response or queued command is reused. A successful current command updates that exact private cache or
Zone result from its admitted intent, so it does not add another own-reaction read in the same admission. The public
counts request remains independent of reaction count, and server rendering performs no private own-reaction read.

Callers may supply an optional native source watermark to the same engine. Thread/post point reads retain their native
`reactionsAsOf`; a missing/null or older projection cannot settle that command. Recovery then retries the
point read without replaying a known receipt. Source watermark replacement retires the caller like target or
session replacement. Other installed callers retain their existing settlement contract when no source watermark
operand is supplied.
Home's generated publication must install its page watermark before that caller can bind this operand.

Cost is one constant-size identity/revision observer per mounted caller and constant work per relevant cache event
or queued choice. Recovery retains one intent. Ordinary writes keep their one-request bound; each explicit recovery
makes at most one write and one thread/post point read, or two Subject point reads. There is no polling, cache
enumeration or background replay. Single-post reads now carry the same viewer slot and projected counts as thread
reads, using the existing native readers; this is the minimal seam needed for exact post recovery.

`tests/thread-reactions-lifetime.test.tsx` and `tests/subject-reaction-reader.test.tsx` author mounted regressions
using real `ThreadReactions`, shared `Reactions`, the QueryClient cache and the ordinary Subject adapter, gating only
the existing read and change transports. These regressions are **UNRUN** pending integration verification.
Browser/native assertions remain separate integration obligations; local web typing does not establish their
completion.

Equal-success regression campaigns also cover manual cache updates and real Query fetch completion, before React
commits, through the ordinary Subject consumer and production Zone personal loader. Fresh admissions share one
matching own response among mounted readers; independent Zone preferences, Library and public counts keep their
original load. These authored campaigns and the original native cost campaigns remain **UNRUN** until integration.
