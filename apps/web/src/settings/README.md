# Settings

**Decision:** Collection privacy uses the existing private owner inventory and native `collection:update` advice; logical built-ins remain inspectable and read-only without a command revision.

**Decision:** Within each native page, the first row for a Collection ID wins; every successful page replaces the current 20-row window.

**Decision:** Retry-After deadlines belong to their exact command or read request; a cursor-free restart is independent of a failed next-page cursor, and expiry enables explicit recovery without triggering it.

**Decision:** Profile and public-view commands share one response-time admission deadline, separate from the current-read deadline; section changes, remounts and local edits cannot shorten it, and expiry only enables deliberate recovery.

Embedded inventory, detail, action-entry and rename-entry reads use a ten-second deadline including response bodies, composed with caller cancellation; timeout releases pending state into the existing localized retry views, and only deliberate recovery rechecks the current account. Independent feeds retain valid cursors and usable pages on transient failure; session retirement discards late replies. Cancellation never proves that a dispatched command had no effect and never replays a mutation.

Applicant verification requests use the same ten-second account budget, including headers and bodies, with caller cancellation and explicit recovery only. The private status read carries the native `{ verificationRequest, viewerActions }` envelope; Request and Withdraw follow returned admission plus local CSRF and lifetime, never browser-inferred state. A readable status may admit no command. Unavailable or malformed advice is never no request and never unlocks Request. Review and command readback never await optional subject titles: a separate cancellable title read enhances the existing generic label and cannot empty an admitted request. Subject suggestions require a fresh caller-bound eligibility release; unavailable reads remain retryable failures, never empty or definitive ineligibility. Withdrawal confirmation binds the current request identity, state and advice; a newer request or pending-to-approving transition needs a fresh decision. Uncertain commands retain their exact original input and key, and cancellation grants no replay or completion authority. Reviewer transport remains separate.

**Decision:** Private verification status uses owner verification authority for request and withdraw advice; a missing authority handle returns the latest request with empty viewerActions and never treats that read as no request.

## Profile avatar

Settings Profile reads Content `GET /v1/media/avatar-upload-advice` for current `media:create` admission, independently of profile-reference `account:update` advice. Missing, malformed or wrong-viewer advice hides upload while name, biography and avatar-reference edits stay usable. One in-memory reservation intent binds the reviewed file, avatar purpose, self container and idempotency key; a lost first acknowledgement retries that key and body, a known media id resumes, and a changed file, crop export or target mints a new intent. The generated advice handle is unavailable until Content publication `d9c5a408-5c67-4d33-bf97-76a9918a21b5`; until then the control stays honestly unavailable.

**Decision:** Web advice decoding binds the current viewer, self target and native constraints without a second UUID grammar; Content schemas remain the identifier authority.

## Notifications

The signed-in Settings notifications section reads the Access preference `page`: current optional kinds, compulsory
notices as explained policy, honest defaults, and admitted `edit`/`reset` actions with the current version. The
catalogue is the authority; the page does not invent kinds, title-case unknown keys, or promise email or push. The same
200 response carries current-viewer, read/update and Reading advice. Edit and reset appear only when its current
`account:update` observation allows them; a readable account with update denied keeps confirmed values and sees disabled
controls with the reason. Missing or malformed advice does not create a catalogue or an editable fallback. Watch
subscriptions stay at `/settings#watches`. Native notification controls are in the first Settings HTML so a no-JavaScript
save still works; after hydration the selected section is the only shown panel. Conflict reloads the current page and
version; a still-valid draft needs review and never replays a removed or compulsory kind. Session change clears private
policy and draft. Uncertain saves keep the original patch and key. A confirmed matching recovery drops the spent intent.

**Decision:** Notification edit/reset advice follows the current `account:update` observation; commands still recheck
authority before receipt lookup.

**Decision:** A failed current read retires action advice but keeps the last confirmed catalogue/values and unresolved
command available for inspection; local drafts stay local, and a successful reacquisition must be reviewed before the
original can be replayed.

## Reading

`/settings#reading` inspects the confirmed spoiler and suitability pair, changes an allowed setting, and recovers a
lost acknowledgement or conflict against the current confirmed result. The page decodes the native preference-page
envelope: viewer state, bounded supported choices, effective/default values, and owner `read`/`update` actions. Missing
or malformed choice data is unavailable; the form does not guess the enum. Signed-out local display appearance stays on
the Display section. A small inert sample shows the selected spoiler/image policy and labels draft versus confirmed
behavior. Reset, when shown, PATCHes native defaults with the reviewed shared version.

Write authority is the owner `update` action composed with the current session credential, re-evaluated at send and
after the response. An unresolved original patch and key stay until acknowledgement is certain. A readable-but-not-editable
result can refresh current values without clearing that original. Session retirement clears private drafts; a stale
response cannot restore edit authority.

Retry-After is captured once on receipt as an absolute deadline in the mounted editor. Read and unresolved-write delays
remain separate: editing or reading current values does not clear a command wait. Expiry only enables deliberate
recovery; it never sends automatically, and a retired viewer episode cannot pass its deadline to a new one.

**Decision:** Reset PATCHes the admitted native defaults with the reviewed version; missing or malformed choice/default
advice leaves reset unavailable. Viewer state and read/update actions live as additive siblings of the notification
catalogue `page` on the same preference 200, without a second preference version. Catalogue `page.actions` use the same
current `allowedActions.update` observation. A 409 returns catalogue `page` only and does not imply complete Reading
advice.

## Watches

`/settings#watches` is the existing private destination for a signed-in viewer. It reads one replaceable page for the selected `thread` or `board` kind through the generated `accounts({accountId}).watches.get` operation, with the exact opaque cursor and a limit of 20. The page supplies the current viewer, page-level remove advice and the command identity for each row. Available rows link through existing localized thread or board routes. A withheld row omits target identity, title and destination; removal still uses the owned subscription command when advice is available.

Removal uses the generated watch ID delete operation with the owner-supplied kind, expected revision, JSON-string idempotency key and the caller authorization on that same DELETE. KernelClient default authorization remains the inventory credential; an injected client still receives the selected removal credential on the explicit request headers. A confirmed removal applies only to that subscription episode; creating a later watch has a new identity. An uncertain result retains the original command, credential, idempotency key, expected revision and kind, and retries that episode rather than authority from a later render, row, session or kind selection. Transient read failures retry the same kind and cursor; an invalid or expired cursor offers a deliberate first-page restart. Denied advice and native problem metadata stay visible. Refresh may update the visible page but never claims the command succeeded. The existing dirty-departure recovery guards a pending removal. Session, account or route retirement clears rows, unresolved intent and callbacks before another visit can act.

Keep the existing thread watch toggle on the thread page. Settings does not add a second subscription inventory, board toggle, watcher census or producer.

**Decision:** Settings removes the exact current thread or board subscription, including when its target is withheld; opening, returning or starting a later subscription does not acknowledge or replay that removal. The credential selected for that episode travels on the DELETE itself; factory defaults cannot replace it, and retirement drops the unresolved intent before another viewer can retry it.

**Decision:** A watch-only departure names removal recovery; watches combined with any other Settings draft use the shared all-settings warning. Stay preserves the original intent and focus; Leave discards local recovery without promising native cancellation.

**Cost:** Each selected-kind Settings page dispatches one inventory request and retains at most 20 rows. Removal is one native command; deliberate refresh and explicit retry remain user actions. One controller owns one active read and one unresolved original command, and retirement releases its rows and callbacks. Native SQL and history growth are owned by Content. Browser growth coverage varies unrelated watches across 1, 10 and 100 sequential visits while checking request counts, retained rows and bytes, active controller release and command attempts.

## Layout defaults by type

The existing shelf editor adds exact type-URI layouts to its versioned dirty-field draft. Display reads the native preference-page `shelfAdvice` on the same envelope as Reading: current viewer, shared read/update actions, stored-value catalogues, empty native defaults, 32-scope limits and the effective stored shelf. Missing, malformed or stale shelf advice is unavailable for editing; independently valid saved values stay inspectable. Native stored choices such as rating or creator stay distinct from Library execution. A bounded Library owner-index page supplies released type choices and batch-localized names; unavailable discovery never means an empty library and never erases valid global advice. Stored scopes absent from that page remain inspectable and removable, with their original URI and no invented name. Keys longer than the owner-returned preference limit cannot create an override. The merged layout map remains within the owner-returned maximum. Single-type removal sends `{ layouts: { [type]: null } }`; the existing global reset still sends `shelf: null`. Conflict reload refreshes clean fields and advice together and preserves dirty ones for review, including choices no longer admitted. Unknown outcomes keep the original payload and command key until replay and current readback resolve them. A later catalogue cannot rewrite that original. Installed account/credential ownership retires private choices, drafts, advice and late completions on replacement. The Library resolver and score currentness fence remain shared.

**Decision:** Selecting a type is a view operation; a missing saved type offers removal, while setting a new override requires that type in the current admitted choices. Open Library links omit layout overrides to show the saved result. Shelf edit/reset use shared `allowedActions.update`; reset remains the existing null patch.

**Decision:** Shelf-only departure names the retained Library view choices and recovery information; mixed drafts use the shared Settings warning. Leaving discards only local recovery, and an already-sent command may still finish.

**Decision:** A refused current Shelf read clears actionable advice and marks retained values unconfirmed; dirty choices and any unresolved original command remain until a deliberate admitted read or exact retry resolves them.

## Account safety

The managed directory retains one successful page of at most 20 rows per feed; Next replaces only that feed and the first duplicate identity within the native page wins. A failed cursor-free restart retries cursor-free, while Retry-After keeps either recovery action unavailable until its original deadline. Successful replacement focuses that feed's heading. Credential, viewer or client replacement retires both feeds before late callbacks can install.

Directory identities, membership roles and responsibility holds supply no detail admission. Until Content's serial successor to `d9c5a408-5c67-4d33-bf97-76a9918a21b5` installs the complete native viewer/navigation envelope and callable/root, identity rows have no detail links and show explicit unavailable feedback; the strict transport decoder continues to reject incompatible responses. This consumer does not publish declarations or infer missing authority.

The Account card reads the current identity from the managed session and keeps rename advice in its separate native profile and viewer-actions read. Security, rename and deletion handoffs use only fixed Auth-owned paths from trusted issuer configuration; they do not grant a destructive command. An unavailable or denied read stays visible until deliberate reload, and native sign-out keeps ordinary POST/redirect behavior with explicit reload recovery and no automatic replay.

**Decision:** A retired managed observation may leave its rendered card visible until React removes it, but every Account destination and recovery callback is synchronously fenced by that original observation; only a newly established session context restores actions.
