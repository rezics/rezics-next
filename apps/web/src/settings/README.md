# Settings account reads

Embedded inventory, detail, action-entry and rename-entry reads use a ten-second deadline including response bodies, composed with caller cancellation; timeout releases pending state into the existing localized retry views, and only deliberate recovery rechecks the current account. Independent feeds retain valid cursors and usable pages on transient failure; session retirement discards late replies. Cancellation never proves that a dispatched command had no effect and never replays a mutation.

Applicant verification requests use the same ten-second account budget, including headers and bodies, with caller cancellation and explicit recovery only. Review and command readback never await optional subject titles: a separate cancellable title read enhances the existing generic label. Subject suggestions require a fresh caller-bound eligibility release; unavailable reads remain retryable failures, never empty or definitive ineligibility. Uncertain commands retain their exact original input and key, and cancellation grants no replay or completion authority. Reviewer transport remains separate.

## Watches

`/settings#watches` is a retained private destination for signed-in viewers, independent of preference-read
availability. `watches.tsx` uses `WatchController` with the installed `SettingsSessionOwner`; retirement removes
private rows and the original stop command, aborts reads and rejects late results. A failed refresh withdraws the
previous rows instead of lending them current disclosure or mutation authority. Reads share the account deadline.
A watch whose target cannot be disclosed has no title or link, but retains its owner-provided subscription identity
for removal. Removing a watch and losing access to its target are separate outcomes.

Decision: use replacement pages of at most 20 watches, preserving the owner's opaque continuation unchanged;
an empty page with a continuation offers the next page instead of claiming there are no watches.

`watch-native.ts` is a local consumer port, not an HTTP or subscription API. The retained Content README and generated
client on this base expose no typed watch-management reader or command. The default therefore reports unavailable;
it never returns an empty list, permission or successful command. Content owns the native private inventory,
subscription identities, current target disclosure and canonical links, sealed cursors, and stop command receipts.
Bind `WatchManagementIO` to those actual typed operations when released, using existing Settings account/CSRF custody
and preserving the exact original semantic command and idempotency key at the transport boundary. No native route
is guessed here. Board selection and thread/board page controls remain with their existing Web consumers.

An unresolved stop blocks another intent and survives category navigation. Explicit recovery retries the immutable
original command, including its subscription identity and key. Reading the current list never settles or replaces
that command. Timeout or cancellation after dispatch leaves the outcome uncertain; only an explicit native command
result confirms removal or refusal. Leaving Settings uses the shared unsaved-work decision.

The illustrative Page stories cover populated, inaccessible-target, failed and uncertain-unwatch states at phone
and desktop sizes. They exercise the consumer seam, not a delivered native wire; final screenshot approval belongs
to Root.
