# Settings

**Decision:** Collection privacy uses the existing private owner inventory and native `collection:update` advice; logical built-ins remain inspectable and read-only without a command revision.

Embedded inventory, detail, action-entry and rename-entry reads use a ten-second deadline including response bodies, composed with caller cancellation; timeout releases pending state into the existing localized retry views, and only deliberate recovery rechecks the current account. Independent feeds retain valid cursors and usable pages on transient failure; session retirement discards late replies. Cancellation never proves that a dispatched command had no effect and never replays a mutation.

Applicant verification requests use the same ten-second account budget, including headers and bodies, with caller cancellation and explicit recovery only. Review and command readback never await optional subject titles: a separate cancellable title read enhances the existing generic label. Subject suggestions require a fresh caller-bound eligibility release; unavailable reads remain retryable failures, never empty or definitive ineligibility. Uncertain commands retain their exact original input and key, and cancellation grants no replay or completion authority. Reviewer transport remains separate.

## Watches

`/settings#watches` is the existing private destination for a signed-in viewer. It reads one replaceable page for the selected `thread` or `board` kind through the generated `accounts({accountId}).watches.get` operation, with the exact opaque cursor and a limit of 20. Available rows link through existing localized thread or board routes. A withheld row exposes only its personal subscription identity, kind and revision so its owner can still remove it.

Removal uses the generated watch ID delete operation with the original kind, expected revision and JSON-string idempotency key. A confirmed removal applies only to that subscription episode; creating a later watch has a new identity. An uncertain result retains the original command and blocks another removal until the person retries it. Refresh may update the visible page but never claims the command succeeded. The existing dirty-departure recovery guards a pending removal. Session, account or route retirement clears rows and callbacks before another visit can act.

Keep the existing thread watch toggle on the thread page. Settings does not add a second subscription inventory, board toggle, watcher census or producer.

**Decision:** Settings removes the exact current thread or board subscription, including when its target is withheld; opening, returning or starting a later subscription does not acknowledge or replay that removal.

**Cost:** Each selected-kind Settings page dispatches one inventory request and retains at most 20 rows. Removal is one native command; deliberate refresh and explicit retry remain user actions. One controller owns one active read and one unresolved original command, and retirement releases its rows and callbacks. Native SQL and history growth are owned by Content. Browser growth coverage varies unrelated watches across 1, 10 and 100 sequential visits while checking request counts, retained rows and bytes, active controller release and command attempts.

## Layout defaults by type

The existing shelf editor adds exact type-URI layouts to its versioned dirty-field draft. A bounded Library owner-index page supplies released type choices and batch-localized names; unavailable discovery never means an empty library. Stored scopes absent from that page remain inspectable and removable, with their original URI and no invented name. Keys longer than the native preference limit cannot create an override. The merged layout map remains within 32 entries. Single-type removal sends `{ layouts: { [type]: null } }`; the existing global reset still sends `shelf: null`. Conflict reload refreshes clean fields and preserves dirty ones for review. Unknown outcomes keep the original payload and command key until replay and current readback resolve them. Installed account/credential ownership retires private choices, drafts and late completions on replacement. The Library resolver and score currentness fence remain shared.

**Decision:** Selecting a type is a view operation; a missing saved type offers removal, while setting a new override requires that type in the current admitted choices. Open Library links omit layout overrides to show the saved result.
