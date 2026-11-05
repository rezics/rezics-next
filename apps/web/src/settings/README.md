# Settings

**Decision:** Collection privacy uses the existing private owner inventory and native `collection:update` advice; logical built-ins remain inspectable and read-only without a command revision.

**Decision:** Within each native page, the first row for a Collection ID wins; every successful page replaces the current 20-row window.

**Decision:** One mounted Collection privacy viewer keeps the longest Retry-After deadline for its list endpoint across cursors; Retry retains the failed request and Restart stays cursor-free, with expiry enabling deliberate recovery only. Row reads and commands keep independent deadlines.

**Decision:** Collection privacy page reads, row Saves and current reads each use the existing ten-second managed deadline independently. A page timeout keeps the current window and exact failed cursor; Retry repeats that request and Restart stays cursor-free. A Save timeout leaves the immutable original uncertain without proving cancellation or commitment. A valid replay receipt permanently settles that original, and a timed-out current read stays read-only recovery. Late timed-out results cannot acknowledge, replace a later window, clear a successor loading flag, bypass unresolved-row protection or start follow-up IO.

**Decision:** Deliberate Collection privacy drafts survive current reads, including preexisting review, conflict and refusal intent. Clean fields adopt native values. A validated receipt consumes the acknowledged original and keeps only later edits. Explicit Use current retires local intent; a denied read withdraws native advice without substituting a default visibility or converting an unknown command into cancellation.

**Decision:** Collection privacy pins stalled Save and page deadlines, late-result isolation, retained drafts and receipt consumption in the existing focused tests. Conflict reload now reviews the kept choice; Use current discards it.

**Decision:** Profile and public-view commands share one response-time admission deadline, separate from the current-read deadline; section changes, remounts and local edits cannot shorten it, and expiry only enables deliberate recovery.

**Decision:** After a Profile command is acknowledged, a failed current read retains that fact and offers deliberate read recovery only; a successful read adopts newer native values and preserves only edits outside the command or made after it for review.

**Decision:** A current Profile projection matching an unacknowledged command changes displayed values only; it is neither acknowledgement, denial nor commitment. Only the exact command response acknowledges the original. An independent current read, later draft, remount, original retry and viewer retirement remain distinct. Leaving ends local recovery without claiming cancellation or nonapplication.

**Decision:** Private Profile reads consume the installed `{ profile, editing }` GET and PATCH `{ accountId }` acknowledgement; setup, serialization and unknown native bodies stay in the existing success/failure envelope. The original intent keeps its immutable credential, key, version and body for exact retry. Local preview stays local until the original acknowledgement; only later edits remain for review.

Profile controls and whole-patch admission consume each field's `applicable` value and each admitted public-view
flag. Null advice closes changes while preserving the local draft. Before every self or delegated dispatch, including
an original retry, the server rereads the selected immutable account's private native advice without replacing the
captured body or key. Advice preflight and PATCH share one ten-second deadline. Failed current reads after receipt
remain read-only recovery; current values never manufacture command acknowledgement. The local preview labels a
clean, confirmed current profile as saved and retains its draft label while command readback is unresolved.

The preflight adds one exact-account private GET per dispatch; there is no directory, watch or profile-history
scan. Profile editing retains one bounded profile, one draft and one original command; public-view admission examines
at most four flags. Native Accounts and Content own the GET's nested authority and avatar work. Existing native
watch listing, removal identity/revision and receipt contracts remain unchanged.

Decision: keep the delivered native Profile and Watches contracts; enforce applicable field and public-view flag
advice in controls and both write paths, preserve deliberate post-dispatch notification intent, and prove saved-preview
and ten-second recovery behavior in the existing focused suites. Add no stories for these existing states.

The profile reader accepts additive top-level response fields while keeping the consumed profile and editing advice
closed, bounded and identity-bound. Editing advice stays in the private reader result; the command retains its strict
profile projection and frozen idempotency key.

The Settings section notice observes the same current viewer exposure operation authority as its controls. Unknown
admission stays pending, denied admission stays closed, and a failed exposure read stays unavailable; an empty
admitted Watches page settles through its existing reader without a second exposure fetch.

Embedded inventory, detail, action-entry and rename-entry reads use a ten-second deadline including response bodies, composed with caller cancellation; timeout releases pending state into the existing localized retry views, and only deliberate recovery rechecks the current account. Independent feeds retain valid cursors and usable pages on transient failure; session retirement discards late replies. Cancellation never proves that a dispatched command had no effect and never replays a mutation.

Applicant verification requests use the same ten-second account budget, including headers and bodies, with caller cancellation and explicit recovery only. The private status read carries the native `{ verificationRequest, viewerActions }` envelope; Request and Withdraw follow returned admission plus local CSRF and lifetime, never browser-inferred state. A readable status may admit no command. Unavailable or malformed advice is never no request and never unlocks Request. Review and command readback never await optional subject titles: a separate cancellable title read enhances the existing generic label and cannot empty an admitted request. Subject suggestions require a fresh caller-bound eligibility release; unavailable reads remain retryable failures, never empty or definitive ineligibility. Withdrawal confirmation binds the current request identity, state and advice; a newer request or pending-to-approving transition needs a fresh decision. Uncertain commands retain their exact original input and key, and cancellation grants no replay or completion authority. Reviewer transport remains separate.

**Decision:** A validated command receipt remains historical acknowledgement through failed current reads; the next readable snapshot at the ordering floor retires the attempt regardless of current request identity. Without a receipt, matching request payload does not prove success, and withdrawal recovery still requires the exact request identity and native advice. Receipts offer only current-status recovery and never show original-command retry guidance.

**Decision:** Viewer preparation, client construction and native transport or body failures for current-status, request and withdraw return the same private success/failure envelope as subject search, with native wait metadata when the response supplied it. A timeout or matching current fields still does not prove native cancellation or commitment.

**Decision:** Applicant verification is proven by the existing recovery, chooser and journey checks plus one setup-envelope and receipt-without-retry assertion; named current-status and recovery stories stay, with no extra stories.

Subject lookup carries a private success/failure envelope with a safe localized message and supported native status details. A valid native Retry-After becomes a response-time deadline: edits retain only the current term, and retry remains deliberate after expiry. Refusal, closed service and unavailable reads stay visible failures; only a successful eligible suggestion can be selected.

**Decision:** Private verification status uses owner verification authority for request and withdraw advice; a missing authority handle returns the latest request with empty viewerActions and never treats that read as no request.

**Decision:** A transient failed status read neither grants nor proves denial of native admission; original-command retry stays unavailable until a fresh readable snapshot supplies that exact operation.

**Decision:** Subject search maps native 403 `platform_closed` to closed, other native 4xx responses to refused, and malformed, deadline, transport or server failures to unavailable; valid Retry-After gates only a deliberate retry.

Notification recovery records deliberate choices made after dispatch separately from the submitted intent. Toggling
a choice away and back still preserves that later choice when an acknowledged original is consumed and a newer
current page is adopted. Failed current reads keep the receipt, offer Reload and never replay that original. A later
Save uses the adopted version and a new key. This retained intent is bounded by the current optional notification kinds.

## Profile avatar

Settings Profile reads Content `GET /v1/media/avatar-upload-advice` for current `media:create` admission, independently of profile-reference `account:update` advice. Missing, malformed or wrong-viewer advice hides upload while name, biography and avatar-reference edits stay usable. One in-memory reservation intent binds the original File, avatar purpose, self container, request body, CSRF credential and idempotency key; a lost first acknowledgement retries that exact intent, and a known media id resumes it. A changed file, crop export or target mints a new intent. Uncertain reservations are retained without automatic cleanup or account-update acknowledgement. Eden supplies the Content callable at runtime; the existing reflective transport seam trusts that callable while the official [Kernel client declaration publication](../../../../services/kernel/README.md#client-declaration-output-placement) is unavailable because of unrelated producer compilation errors. Advice bodies still pass the HTTP-boundary decoder.

**Decision:** An exact reservation replay may already return uploaded or available media; transfer bytes only for a reserved result, retain rejected media as rejected, and continue processing with the original File and credential. The 256 KiB bound applies to PNG/JPEG crop headers; native upload admission retains five image types and 20 MiB. Focused regressions cover installed advice and settled replay; seeded browser/native acceptance is deferred to integration.

**Decision:** Web advice decoding binds the current viewer, self target and native constraints without a second UUID grammar; Content schemas remain the identifier authority.

**Decision:** During an unresolved avatar upload, a separate availability check may reread current `media:create` advice without changing the retained file, reservation identity or upload retry deadline; only the existing upload retry resumes it.

**Decision:** Avatar reservation, transfer and processing waits keep the longest Retry-After deadline captured at the failing response, including 503 and HTTP dates; expiry enables deliberate retry only, and local replacement cannot bypass it.

**Decision:** Avatar crop reads at most 256 KiB of PNG/JPEG header. Advice, preparation, crop export and upload observation use the existing ten-second Profile deadline; timeout ends local busy presentation while retaining the exact upload identity and native waits, and late results cannot alter a successor.

## Notifications

The signed-in Settings notifications section reads the Access preference `page`: current optional kinds, compulsory
notices as explained policy, honest defaults, and admitted `edit`/`reset` actions with the current version. Edit and
reset use that advice's version in the existing PATCH envelope; no separate version or inferred action is admitted. The
catalogue is the authority; the page does not invent kinds, title-case unknown keys, or promise email or push. The same
200 response carries current-viewer, read/update and Reading advice. Edit and reset appear only when its current
`account:update` observation allows them; a readable account with update denied keeps confirmed values and sees disabled
controls with the reason. Missing or malformed advice does not create a catalogue or an editable fallback. Watch
subscriptions stay at `/settings#watches`. Native notification controls are in the first Settings HTML so a no-JavaScript
save still works; after hydration the selected section is the only shown panel. Conflict reloads the current page and
version; a still-valid draft needs review. Removed or compulsory kinds stay as retained local choices until discarded or
current advice admits the whole patch; a filtered subset is not completion. Session change clears private
policy and draft. Uncertain saves keep the original patch and key. A confirmed matching recovery drops the spent intent.

**Decision:** Notification edit/reset advice follows the current `account:update` observation; commands still recheck
authority before receipt lookup.

**Decision:** A failed current read retires action advice and keeps a transport-uncertain original available for
inspection; only a successful reacquisition that supplies current advice can permit its exact replay. A validated
replay receipt ends replay actionability even if its follow-up read fails: retain it as historical confirmation, allow
deliberate read recovery only, then review current native values and later local edits.

**Decision:** Reviewed Save/Restore stays visible but disabled until current native advice admits its exact retained intent; the unavailable state explains the denial and offers deliberate Reload to reacquire current advice.

**Decision:** Notification patches are admitted as a whole against the current optional catalogue; retained unavailable kinds stay local and distinct until discarded or later advice admits the full set. Current switches follow the fresh envelope; a retained local value is never shown as current compulsory state.

**Decision:** Native preference responses accept additive envelope fields while the consumed catalogue and action records remain closed. Edit and reset advice may be supplied independently. Form recovery retains the complete merge patch, including per-kind defaults, and requires current advice for the whole operation. An uncertain retry keeps its original version and key; acknowledgement followed by a failed current read offers only Reload. Focused transport, editor and form regressions pin these cases; seeded browser/native acceptance follows integration.

**Decision:** Recovered drafts project only retained deliberate choices onto adopted native optional values; acknowledging a first send consumes its intent so only later edits can enter a reviewed patch. A failed read after a Save or Restore receipt permits Reload, never another replay of that consumed command.

**Decision:** Each notification Save and current GET uses the existing ten-second managed deadline independently. A Save timeout
leaves its immutable original uncertain; a timed-out GET withdraws current advice and permits deliberate read recovery. Late
timed-out results cannot acknowledge, restore authority or start follow-up IO.

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

**Decision:** Reading saves and current reads each use the existing ten-second deadline; a save timeout preserves the
exact original for deliberate retry, while a timed-out read remains unavailable and never replays a validated command.

A refreshed choice list can stop admitting a retained draft value. The editor keeps and labels that local intent, then
requires every changed value in a new patch to be admitted before sending. A singleton suitability choice is shown as
read-only while the native effective and default values remain visible, even when the default is not currently offered.
Reset is available only when both native defaults are admitted. This admission check never changes an uncertain
original patch or its retry.

**Decision:** Retained unsupported choices stay local until explicitly changed or discarded; new patches are admitted
as a whole against current advice, uncertain originals retry unchanged, and a singleton suitability choice is read-only.

**Decision:** A current Reading read rebases fields without local intent onto native values. A matching receipt consumes
only that command's fields. Edits outside the command or after dispatch, including an edit back to an earlier value,
stay for review; Use current clears them. Explicit edits made during conflict or review remain intent even when they
equal the older baseline. A successful acknowledgement needs a separate current read before it can establish current
values; a live read Retry-After may defer that read without blocking replay of the original write, and the write
acknowledgement does not erase the read's absolute wait. A clean read does not open review or save.

**Decision:** Reset PATCHes the admitted native defaults with the reviewed version; missing or malformed choice/default
advice leaves reset unavailable. Viewer state and read/update actions live as additive siblings of the notification
catalogue `page` on the same preference 200, without a second preference version. Catalogue `page.actions` use the same
current `allowedActions.update` observation. A 409 returns catalogue `page` only and does not imply complete Reading
advice.

## Watches

`/settings#watches` is the existing private destination for a signed-in viewer. It reads one replaceable page for the selected `thread` or `board` kind through the generated `accounts({accountId}).watches.get` operation, with the exact opaque cursor and a limit of 20. The page supplies the current viewer, page-level remove advice and the command identity for each row. Available rows link through existing localized thread or board routes. A withheld row omits target identity, title and destination; removal still uses the owned subscription command when advice is available. Previous keeps up to eight exact addresses for the active kind and rereads only the selected address; switching kind or deliberately restarting from the first page clears them. A failed Previous or Next retains its exact kind and cursor for deliberate retry, with no prior page body or write authority retained.

Removal uses the generated watch ID delete operation with the owner-supplied kind, expected revision, JSON-string idempotency key and the caller authorization on that same DELETE. KernelClient default authorization remains the inventory credential; an injected client still receives the selected removal credential on the explicit request headers. A confirmed removal applies only to that subscription episode; creating a later watch has a new identity. An uncertain result retains the original command, credential, idempotency key, expected revision and kind, and retries that episode rather than authority from a later render, row, session or kind selection. A refused replay also retains that original and its response-time retry deadline, but withdraws the current page disclosure and advice. A later deliberate read can reacquire advice without settling the original, even when the row is absent, present or revised; only its validated receipt settles it. Transient read failures retry the same kind and cursor; an invalid or expired cursor offers a deliberate first-page restart. Denied advice and native problem metadata stay visible. Refresh may update the visible page but never claims the command succeeded. Original retry requires current native removal advice plus the current session and its captured Retry-After deadline; read recovery has a separate captured deadline. The existing dirty-departure recovery guards a pending removal. Session, account or route retirement clears rows, unresolved intent and callbacks before another visit can act.

Keep the existing thread watch toggle on the thread page. Settings does not add a second subscription inventory, board toggle, watcher census or producer.

**Decision:** Settings removes the exact current thread or board subscription, including when its target is withheld; opening, returning or starting a later subscription does not acknowledge or replay that removal. The credential selected for that episode travels on the DELETE itself; factory defaults cannot replace it, and retirement drops the unresolved intent before another viewer can retry it.

**Decision:** A confirmed original removal clears only a displayed row matching its watch ID, kind and expected revision. A refreshed row with another revision stays current, and stopping it is a new command.

**Decision:** A refused replay preserves the original removal as unresolved, drops denied page authority, and permits only a deliberate current read or exact replay; only a validated removal receipt settles it.

**Decision:** A valid removal Retry-After is one absolute endpoint deadline scoped to the installed Settings owner. Keep the longest live deadline through reads, category changes and Watch view remounts; gate fresh removal and exact-original replay in the controller and controls, show definite refusal waits, and let expiry enable deliberate action without IO. Read waits remain independent.

**Decision:** A watch-only departure names removal recovery; watches combined with any other Settings draft use the shared all-settings warning. Stay preserves the original intent and focus; Leave discards local recovery without promising native cancellation.

**Decision:** Same-tab return keeps the current address, up to eight prior addresses and exact subscription ID, kind and revision in the Settings history entry. Return rereads that window; keyboard focus goes to its current disclosed stop control only after an exact native match and only if focus has not moved, while pointer return never changes focus. Missing, changed or withheld rows leave the current watches region available without scanning.

**Cost:** One accepted page is limited to 20 rows and 262,144 UTF-8 JSON bytes. The active cursor and next cursor are each at most 4,096 UTF-16 code units; the previous-address stack retains at most eight such cursor strings (65,536 UTF-16 payload bytes), and the private same-tab return receipt is capped at 65,536 UTF-8 JSON bytes. Each page action makes at most one native request with limit 20. One controller keeps one active read, one accepted page and one unresolved original command; no earlier page bodies or background requests are retained. Native SQL and history growth are owned by Content. Browser growth coverage varies unrelated watches across 1, 10 and 100 sequential visits while checking request counts, retained rows and bytes, active controller release and command attempts.

## Layout defaults by type

The existing shelf editor adds exact type-URI layouts to its versioned dirty-field draft. Global and type layout controls share the current native `shelfAdvice.supported.layouts` and parent label formatter; edit callbacks and dispatch recheck changed choices against current advice. Unsupported stored layouts remain labeled and removable, and untouched values survive unrelated valid edits. Display reads the native preference-page `shelfAdvice` on the same envelope as Reading: current viewer, shared read/update actions, stored-value catalogues, empty native defaults, 32-scope limits and the effective stored shelf. Missing, malformed or stale shelf advice is unavailable for editing; independently valid saved values stay inspectable. Native stored choices such as rating or creator stay distinct from Library execution. A bounded Library owner-index page supplies released type choices and batch-localized names; unavailable discovery never means an empty library and never erases valid global advice. Stored scopes absent from that page remain inspectable and removable, with their original URI and no invented name. Keys longer than the owner-returned preference limit cannot create an override. The merged layout map remains within the owner-returned maximum. Single-type removal sends `{ layouts: { [type]: null } }`; the existing global reset still sends `shelf: null`. Conflict reload refreshes clean fields and advice together and preserves dirty ones for review, including choices no longer admitted. Unknown outcomes keep the original payload and command key until replay and current readback resolve them. A later catalogue cannot rewrite that original. Installed account/credential ownership retires private choices, drafts, advice and late completions on replacement. The Library resolver and score currentness fence remain shared.

**Decision:** Selecting a type is a view operation; a missing saved type offers removal, while setting a new override requires that type in the current admitted choices. Open Library links omit layout overrides to show the saved result. Shelf edit/reset use shared `allowedActions.update`; reset remains the existing null patch.

**Decision:** Shelf-only departure names the retained Library view choices and recovery information; mixed drafts use the shared Settings warning. Leaving discards only local recovery, and an already-sent command may still finish.

**Decision:** A refused current Shelf read clears actionable advice and marks retained values unconfirmed; dirty choices and any unresolved original command remain until a deliberate admitted read or exact retry resolves them.

**Decision:** Shelf writes and current reads use independent ten-second managed deadlines and native Retry-After deadlines. A local Save timeout retains exact original custody without claiming cancellation and supplies no Retry-After; a current-read timeout clears busy state and advice, keeps a validated receipt acknowledged and permits only deliberate current-read recovery. A confirmed original write remains complete when its follow-up read fails, so recovery reloads current values without replaying that command.

**Decision:** Keep unsaved Shelf choices is a local review resolution beside Discard. It rebases clean fields onto the current snapshot and retains only later local intent. It never writes, mints a command key, or treats matching current values as a committed original. Save stays a separate command against that version. An unresolved original is unchanged. A confirmed receipt consumes its operands so they cannot roll back a newer current snapshot; a later edit remains. Reset review keeps later edits and drops pre-reset choices.

**Decision:** Type discovery uses the [Library retained-coordinate contract](../library/README.md#saved-shelf-presentation)
independently for each current defaults editor. Browsing Previous, Next, First or exact Retry never edits a layout,
selected override, global scope, unsent draft or original command. Only the current admitted 20-row page supplies
new choices; absent saved overrides remain visible and removable within the existing 32-layout/256-scope bounds.
The editor keeps eight predecessor coordinates and one staged target, never historical rows, labels or counts.
Existing Save, uncertain original custody and the single Stay/Leave owner remain unchanged.

## Account safety

Managed detail captures Retry-After at response receipt in its immutable viewer/target reader. The longest observed
endpoint deadline guards every new detail read, including captured callbacks, feed recovery, first-page restart and
whole-detail refresh. Already admitted sibling responses may settle without shortening that wait. Expiry only enables
deliberate controls; it never dispatches. Missing or malformed headers add no delay. Failed first-page reads retain a
cursor-free recovery request, and blocked controls preserve failure feedback, retained pages and native action advice.
Directory navigation and direct detail selection use the native observations described below; detail response-wait recovery remains with its existing reader.

While the session is unavailable, any requested account selection shows only its Back link; invalid and valid selections share that view.

The managed directory retains one successful page of at most 20 rows per feed; Next replaces only that feed and the first duplicate identity within the native page wins. A failed cursor-free restart retries cursor-free, while Retry-After keeps either recovery action unavailable until its original deadline. Successful replacement focuses that feed's heading. Credential, viewer or client replacement retires both feeds before late callbacks can install.

A session credential replacement, including a CSRF token change, retires both feeds before late callbacks can install, and the replacement reader reads once. A retired session observation is replaced only by a fresh observation that matches the current session, so an unavailable session keeps the retired reader without re-creating it.

The directory captures Retry-After once at response observation as an absolute endpoint deadline. The longest
outstanding deadline guards both feeds, first-page recovery and whole refresh, including captured callbacks. An
already admitted sibling may settle under its current reader generation without shortening the wait. Blocked
actions preserve the exact failed request, page and feedback; expiry only enables deliberate actions. One
presentation timer serves all directory controls, and reattachment never restarts the delay. Retirement clears
the observation with the private pages; detail, Auth and independent Settings endpoints remain independent.

**Decision:** Directory Refresh is a separate deliberate cursor-free action; Retry preserves the failed feed request,
and both obey the longest response deadline. A successful Refresh resets both feed coordinates; a failed Refresh retains usable pages and coordinates for deliberate recovery.

Managed action reads publish their response-time Retry-After deadline in the viewer/target snapshot. The recovery
control uses that same absolute deadline after reattachment; expiry enables deliberate retry only.

**Decision:** Managed-detail identity, role, operator and target characteristics follow the latest admitted read.
An older sibling may settle its selected feed page and loading state without replacing newer shared detail or
navigation observations, including when that older feed fails. Native restrictions still withdraw proof and invalidate sibling reads.

Directory identities, membership roles and responsibility holds supply no detail admission. Settings consumes the native current-viewer and per-row navigation observations: only admitted disclosed rows link to detail. A direct selection reads the native management endpoint without fetching the directory; that endpoint independently enforces current viewer and target authorization. The installed client declarations are published only by the official Kernel emitter.

**Decision:** A directory detail link requires the native admitted navigation observation. Returning removes only `managedAccount`, preserves locale and query context, retains at most the current page per feed for the same current viewer, and focuses the originating row or its feed heading if that row is no longer present.

The Settings account panel keeps a visited directory reader mounted but hidden and inert during a detail selection;
returning uses the router and reuses its current pages, exact failed requests, deadlines and eight predecessor
coordinates. A direct detail selection does not start a directory read to infer admission. Session, credential or
client replacement still retires that retained reader while hidden. Keyboard return restores the originating admitted row, or its feed heading when that row is absent; pointer return leaves focus alone. A newer cross-feed observation retires older navigation admission while retaining each feed’s bounded rows and exact recovery coordinates.

The Account card reads the current identity from the managed session and keeps rename advice in its separate native profile and viewer-actions read. Security, rename and deletion handoffs use only fixed Auth-owned paths from trusted issuer configuration; they do not grant a destructive command. An unavailable or denied read stays visible until deliberate reload, and native sign-out keeps ordinary POST/redirect behavior with explicit reload recovery and no automatic replay.

**Decision:** A retired managed observation may leave its rendered card visible until React removes it, but every Account destination and recovery callback is synchronously fenced by that original observation; only a newly established session context restores actions.

**Decision:** Account rename server setup, native result consumption and serialization faults return the same plain AccountRenameResult envelope. Framework redirects and not-found still throw. Private no-store is set whenever the response helper loaded.

**Decision:** Session preparation for the rename read uses the existing ten-second managed deadline; timeout neither cancels the lookup nor enables rename. Profile and viewerActions remain the two exact current reads.

**Decision:** Mixed native failures in one envelope present unavailable before denied before failed, keep the longest Retry-After, and never leave a previously available destination clickable.

**Decision:** Sign-out recovery bounds the existing session query with that same deadline. Timeout keeps original uncertainty visible, unlocks only the deliberate Reload, and never submits sign-out or treats a late session as idle for an obsolete viewer.

**Decision:** Account safety recovery is proven by the existing region, link and card checks plus setup-envelope, non-cooperative session recovery, old-viewer late completion and deliberate current destination assertions. No extra timer-test family or stories.

**Decision:** Reuse the retained directory and native management GET for selection, with regressions for installed GET serialization, current-viewer binding, cross-feed admission retirement and keyboard return. Browser/native seeded acceptance remains with integration; fixtures and focused checks do not establish it.
