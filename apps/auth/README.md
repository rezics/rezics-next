# Auth pages

For the complete loopback stack, generated keys, persona and reset command, see
[Local development stack](../../docs/development/local-stack.md). Run `task dev:infra` then `task dev` from the repository root.

Auth is a TanStack Start app on Cloudflare Workers. Its page frame is served at the unprefixed paths /login, /signup,
/consent, /recovery, /security and /step-up. Each page contains the REZICS brand header and a localized heading.
Paraglide supplies the eight launch locales.

Local development uses the Cloudflare Vite plugin's default `.cloudflare/state`. Test launches receive an independent
temporary persistence directory per Auth Vite process. `AUTH_TEST_STATE_INSTANCE_DIR` supplies a caller-owned path for
one instance whose state must survive a sequential restart; Auth leaves that directory in place after shutdown.

Set `PRIVACY_CONTACT_URL` to the deployment's `https:` or `mailto:` privacy contact URL; missing or invalid values disable account deletion at request time.

Pages compose the shared shadcn card, field, input, input-group, button and alert components. Security
lists also use shadcn items and badges. Password reveal buttons have localized show/hide names and stay disabled
until hydration. Native form submissions keep their fields and actions; scripted actions retain their pending
states with an accessible busy indicator. Error text uses ink blue, with red reserved for the brand mark.

## Sign-in

The sign-in page first reads `POST /signin/page` with only its current route query; the entered email is never sent to
this read. Auth returns the installed password and passkey methods, the current viewer from the existing native session
authority, and a bounded same-origin continuation. A signed-in visitor sees the account's own email as a private label
and can continue or open the existing sign-in form to switch accounts. A `prompt=login` continuation requires an
interactive sign-in. The projection is advice only; `/authorize` and `/signin` still evaluate the current native
session and request when used.

The page read accepts at most 4,096 UTF-8 query bytes and returns at most 16 KiB. It projects two fixed method flags,
zero or one current viewer, and at most one account identity row sought by its full user primary key. It sends no
credential inventory or entered email. An Auth or Access read failure returns an unavailable page with a retry; it
never becomes an empty method list or a signed-out result inferred from a transport failure.

The sign-in form has labelled email and password fields with password-manager autocomplete. `src/sign-in.ts` holds the
provisional client id (`login`) and scope (`[]`). It uses the shared `src/api.ts` client to send JSON to same-origin
`/signin` with same-origin credentials. The browser supplies the issuer `Origin`; redirects fail closed, and network
failures become an unavailable result. Browser-unsupported passkeys, a missing native passkey method and an actual
native credential refusal have separate localized messages.

Decision: label a verified current-session continuation with that account's own email as private display context; never
derive the viewer from the address entered into the sign-in form.

After successful sign-in, the browser navigates to `/authorize` with the received query, preserving repeated and empty
parameters and removing every `sig`, `exp`, `prompt` and `return_to`. It keeps `max_age`. Without a remaining query it
navigates to `/security`, or to the `return_to` path when it is on the fixed list of Auth page paths (now only
`/security`, `/account/delete` and `/organizations/new`, plus `/consent` with exactly one nonempty `client_id` and one `scope`);
it is never forwarded to `/authorize` and never an absolute URL or another origin. Form success still uses this client
validation and the native handler does not return a navigation target. The page-read continuation is a separate
same-origin hint for an already signed-in visitor; the native authorization route checks the session again on use.
Recovery links to `/recovery`; sign-up preserves the login query.

Where the browser has WebAuthn, the page also offers passkeys. `src/passkeys.ts` holds every WebAuthn call, using
`@simplewebauthn/browser` and the shared `authPost`. A "Sign in with a passkey" button asks `POST /signin/passkey/options`
with `{}` for discoverable-credential options, prompts, and sends `{ response, client_id: "login", scope: [] }` to
`POST /signin/passkey`, which answers like `/signin`; success resumes with `signInTarget`. Where the browser supports
conditional mediation, the email field carries `autocomplete="username webauthn"` and the same ceremony runs in the
background so the browser can offer passkeys in autofill. Both start from one set of options, which the page shares for
four minutes, so a sign-in is two Auth calls however it starts. A dismissed prompt (`NotAllowedError`) or a ceremony
replaced by a newer one is silent; any other failure shows the shared destructive alert, with a passkey-specific
message for a refused passkey. Without WebAuthn the page shows no passkey control and the email field keeps
`autocomplete="username"`.

Password, explicit passkey and autofill completions belong only to the current login journey. Changing the
URL, leaving the page or restoring a cached document discards old callbacks and private inputs. A password
submission can replace a passkey ceremony; only its current completion may unlock the form or navigate.
Replacement cancels the browser ceremony, without undoing a server sign-in or retrying an uncertain request.

Decision: login Stay/Leave protects non-whitespace email, any password or a pending explicit sign-in in memory; Stay retains validation, the current request and focus, Leave clears inputs and retires callbacks, reload/close uses the browser warning, and replacement login requests or successful validated returns bypass the choice. Background conditional passkey autofill alone does not warn.

The submit button stays enabled until a request is pending. Submission validates the email and password, marks each
invalid field with a linked error, and focuses the first invalid field. The password uses the shared in-field show and
hide control. A refusal keeps the email, clears the password and focuses a destructive alert with an icon and title:
401 reports incorrect email or password without identifying an account, 429 includes valid `Retry-After` seconds,
and other responses or network failures report an unavailable Auth service.

## Recovery

Recovery has an email-start form and a new-password form. Each submit makes one browser Auth request and no kernel
reads. Every 200 start response shows the same confirmation while leaving the email editable. A recovery fragment is
removed from browser history before the completion form can send a request. Completion sends the account id, token and
new password as JSON; the token is not rendered in the page or placed in a request URL. The page sets
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

Successful completion revokes the account's sessions and sends the person to `/login` with a localized success notice.
An invalid or expired link offers a new recovery link. Rate limits show a valid `Retry-After` duration, and outages
ask the person to try again later.

Leaving or replacing the recovery journey discards its browser results and private inputs; returning from a cached
document starts a fresh form without retrying a mutation. Departure cannot undo a completed native password change.
Decision: an Auth response resolves departure protection while retaining displayed fields and results; a later edit starts a new protected draft.

## Sign-up

The sign-up page keeps the query it was opened with. Its sign-in link keeps that same query. The form has a handle,
email and password. Email uses `autocomplete="email"`. Password uses `autocomplete="new-password"` and the shared
in-field show and hide control. Submission validates the handle, email and password. Field errors are tied to their
inputs with `aria-describedby`, and focus moves to the first invalid field.

Sign-up and organization creation share `normalizeSignupHandle`: case-fold first, then accept 3–64 ASCII letters a–z,
digits, underscores or hyphens, with a letter or digit at both ends. Whitespace is refused without trimming. An
acceptance test compares the browser pattern's source with the kernel's claim pattern; the pages have no runtime
dependency on kernel or Auth modules. Reserved handles are checked by the server and get the same taken-or-reserved
field message as taken handles.

The page loads the Turnstile script once and renders the widget explicitly with the public `TURNSTILE_SITE_KEY`,
`action: "signup"` and the page locale. In development, `TURNSTILE_SCRIPT_URL` replaces the script address. The
submit button is enabled before a token arrives; submitting without one shows a localized message beside the widget
and sends no request. A local password confirmation must match but adds no Auth policy. Password and confirmation
visibility are independent, and both password fields use Auth's native length bounds.

`POST /signup` sends `{ key, handle, email, password, turnstile_token }` as JSON with same-origin credentials. The
captured handle is lowercase, email is trimmed and lowercase, and the password is preserved exactly. In development
that POST is forwarded to AUTH_ORIGIN; GET /signup remains this page. A 201 response confirms creation even if its
body cannot be read, and sets no session. Creation and automatic sign-in are distinct stages: after 201 the form and
retained creation credentials are cleared, and the page signs in once with the captured email and exact password.
On success it resumes with `signInTarget`. If sign-in fails or its response is uncertain, the created-account panel
and sign-in/recovery links retain the original query; repairing sign-in uses the existing login page and never
repeats creation. `src/sign-in.ts` supplies the shared sign-in result and validated destination helpers (there is no
separate login-attempt helper in this base).
The page starts with one no-store Auth registration read containing the current viewer, native field limits and
available actions. An already signed-in viewer gets Continue through the existing safe `signInTarget` plus a Sign in
link that replaces the active account; `return_to` remains navigation only. A failed read or missing Turnstile
configuration shows an unavailable state before the form. This read is advice only; `POST /signup` repeats native
validation and verification.
Decision: an already signed-in visitor continues with the current account and can choose Sign in to replace it.
Decision: nonblank handle/email, any password or confirmation, or a pending creation prompts Stay/Leave; Stay
preserves input, validation and the same attempt, while confirmed creation releases the warning before sign-in.
Reload/close warns only for that unfinished work; Leave clears in-memory details and retires browser continuations
without undoing a dispatched creation. A cached-document return starts an empty fresh journey and never retries a
write automatically.

Decision: an uncertain acknowledgement retains the normalized original business input and request key in the
mounted journey, shows the retained handle/email without the password, and allows only an explicit exact retry with
a fresh Turnstile token or sign-in/recovery. A failed verification or refusal of that retry does not resolve the
earlier unknown result. A retry-after delay gates the explicit retry without claiming to cancel creation.

Decision: only a first-response 409 `handle_unavailable` establishes the safe handle-correction transition. It has no
account effects; after choosing a different valid handle, the page starts a new request with a new key. A 400
`registration_denied` before any uncertain result permits the same draft to continue with a fresh challenge. Generic
409 responses remain non-enumerating and offer sign-in/recovery without opening a changed registration request.
Network failures, unread responses and 503 responses stay uncertain. A malformed 201 body still confirms creation.

## Consent

`/consent?client_id=<id>&scope=<space-separated scopes>` reviews a third-party client's request. One browser
`GET /consent/<client_id>` with the session cookie loads its display name (falling back to its id), registered scopes
and this person's current consent. The page makes no kernel reads. Each requested scope shows a localized description
first and its identifier in muted monospace afterward, followed by its already granted, new or not available state.
Unknown scopes keep their raw identifier after a generic localized description.

Approval uses the shared Auth client to send one same-origin JSON `POST /consent` with only `client_id` and `scope`.
The approved set is the union of current grants and requested registered scopes, since the write replaces consent.
Unregistered requested scopes are never sent. Declining writes nothing and confirms that the client got no new access.
After approval the person can return to the client. Neither query parameters nor response bodies supply a return
target, and the page never redirects.

Signed-out visitors get a link to `/login` with the exact client and scope request in the supported local consent
`return_to` target; sign-in returns to a fresh review. Unknown and first-party clients show a localized not-found message.
Other failures use the shared status-and-code messages, including valid `Retry-After` seconds; Auth body text is
never displayed. Pending approval disables both buttons, and a failure permits retrying.
Failed review reads reuse the localized "Try this action again" button for the same client and requested scopes.
While that read is pending,
duplicate activation cannot start another read or enable approval. Changing either request parameter or leaving
the page discards the old reader's results. Retrying the review never submits approval.
Departure also invalidates approval results; browser restoration always reads a fresh review before enabling decisions.
Decision: retain a per-request uncertainty marker in tab storage across departure, never replay approval, and let a fresh
review enable an explicit approval or decline; declining cannot claim that an earlier uncertain approval had no effect.

Page paths render only for GET and HEAD. Other methods, including `POST /consent` and `POST /signup`, pass the
original request through to Auth at the issuer origin in production, or through the existing `AUTH_ORIGIN` proxy in
development. Auth's response returns unchanged, without page headers.

## Private review reads

Decision: each private session, consent and inventory read has a five-second deadline through response-body
completion and browser BFF transport, preserving caller cancellation. Failures reuse the localized unavailable and
explicit read-retry controls for the current page/account/selection; they never replay a mutation. Independent
inventories keep their own availability, and existing page generations retire old completions.

## Security

The security page has Password, Passkeys, Sessions and Organizations sections, followed by Delete account, in a
content column up to 42rem wide. Organizations links to `/organizations/new`; Delete account explains the result and
links to `/account/delete` with a destructive outline control. It reads the
current viewer, validated session/passkey inventories and per-target action advice from one native `GET /security-page`, through the existing private BFF. The view makes no kernel reads. A password change uses three Auth calls. Session revocation and passkey removal first check the current native account using the same BFF request cookie, then dispatch the existing exact-key command once. A signed-out response
offers a link to `/login`.

Password changes, passkey prompts/removal and session revocation share one operation boundary: all other credential
and session writes stay disabled until completion or cancellation. Uncertain removal/revocation holds that boundary
through current-target readback; a present target permits only its confirmed retry, and proven absence returns the page
to idle. A determinate failure permits another operation. Account/session changes clear the boundary and private state,
and results from the previous page authority cannot restore them.

Exact session and passkey reviews show only native row fields and current advice, with Cancel focused first,
Escape to cancel and focus returned to the row or its section. Unsent review holds the same operation boundary.
A current-device review explicitly warns of local sign-out; passkey removal explains all-session retirement and
native last-credential refusal. Readback never repeats a removal. A complete current inventory proves only current
absence; a truncated missing row cannot prove absence. Only a currently present target permits a newly reviewed
exact-target command. Recovery descriptions come only from a fresh present row; retained list rows are marked as previously shown until current readback.

Decision: the browser action wait is twelve seconds: the existing sequential five-second native account check and
five-second command, plus two seconds for browser/BFF delivery. Expiry, abort, thrown transport or malformed
acknowledgement after invocation becomes unknown. One invocation sends at most one command; cancellation cannot
undo native work. Target reads use the five-second private-read deadline even if an injected source or browser
transport ignores abort. Retired waits cannot publish or release another operation.

Security departure is protected by any nonempty new password, a nonblank passkey name, or an unresolved operation;
Stay keeps the in-memory review and focus, while Leave clears local authority and drafts without claiming to cancel an
operation already underway. Reload or close warns while protected. Cached-page return reloads the account,
credential/session lists and both application inventories before enabling their controls.
Only an unresolved destructive target's original account, kind and native id survive in page memory: for the same
account, return requires fresh explicit readback and confirmation; a different account discards that target. Failed
reads offer Reload, ended sessions offer sign-in, and return never replays a credential or consent command.

Connected-application reviews acquire that same boundary until cancellation or a determinate result; uncertain reductions keep all security writes blocked without replay, while independent owned-client navigation remains available and consent navigation cannot discard a review.

Password changes use the current native Auth password limits, shown locally with Unicode character counts and kept
within Auth's storage bounds, and require matching new-password confirmation. Before dispatch, the person reviews the
current account and the native session consequences. Replacing an existing password retires all sessions, including
the current one; adding the first password leaves existing sessions active. The Security page does not disclose
whether a password row exists. Decision: the review explains both native outcomes because Security advice does not disclose whether a password row exists: replacing one retires all sessions, while setting the first password keeps them active.

One random operation key and its exact stage, approval and apply bindings stay in mounted page memory. A transport
failure, timeout or malformed response is phase-specific uncertainty. No phase is retried automatically. An explicit
retry reuses that exact phase payload only while current Security advice allows it; native authorization remains final.
Only a validated apply receipt confirms completion. A refusal or expired approval after an unknown apply does not
resolve that earlier result. A confirmed apply retires the session and the page offers sign-in with the new password;
if that does not work, the existing account-recovery path remains available. When current advice requires step-up, the
page goes to `/step-up?return_to=%2Fsecurity` before sending any credential-effect request. No password is put in a URL.

Sessions are a list of outlined items spaced by the list's gap, with no separators between them. A local browser and system map formats recognized user agents as a device;
unrecognized values show a localized unknown-device label, and user agents are never sent elsewhere. The muted
description contains the app name and signed-in and expiry dates formatted for the page locale and time zone. A
response `client_display_name` is used when present; `login` maps to the localized REZICS account name,
`rezics-website` maps to REZICS, and other client ids remain muted monospace. The current session appears first and is
marked This device. Each row offers Sign out with an accessible name containing its device. Signing out asks for
confirmation. An accepted response for another session leaves the row until an explicit current inventory read; an accepted current-session revocation clears private page data and requires sign-in.

Passkeys have their own section with an `h2`. Each passkey is an outlined item with its name, created date and last-used
date (or "Never used"), formatted for the page locale and time zone, and a Remove button whose accessible name contains
the passkey's name. The add form has an optional name that defaults to the browser and system. Adding sends
`POST /passkeys/register/options` with `{}`, runs the browser ceremony, then sends `POST /passkeys/register` with
`{ response, name? }`; the 201 body `{ id, name, created_at }` acknowledges creation, then the native page is refreshed before target actions resume. Removing
asks for confirmation and sends the existing `POST /passkeys/remove` with `{ id }` after the current-account check. Native success revokes all sessions: the page clears private data and requires sign-in. A 409 means it was the person's last interactive
credential, so nothing changed and a localized message says so. Registration and removal are credential changes: a 401
`step_up_required` sends the person to `/step-up?return_to=%2Fsecurity`. A dismissed browser prompt is silent. Where the browser has no WebAuthn, saved passkeys and their native removal advice remain visible; only creation is unavailable. A failed inventory shows an alert in its section, never an empty-list claim.

Decision: registration uses the existing five-second issuer deadline through response-body completion; an uncertain acknowledgement holds the page operation boundary until an account-bound native passkey refresh and explicit review, never infers success from names or WebAuthn IDs, and never replays the ceremony or registration POST.

A lost or 503 mutation response retains only the account, operation kind and exact target id in page memory and
shows an unknown result. It never sends an automatic duplicate. An explicit check reads current native authority
and the own session/passkey inventory with no-store, using the fixed request cookie, then rechecks authority.
Malformed inventories and explicitly truncated native windows cannot prove a target absent. Reconciliation reads the native page and replaces target advice; a complete window at capacity can prove absence. A present target enables an
explicit retry with a new confirmation and normal native checks. A denied or ended session clears private rows;
sign-in is the remedy and does not establish that the action succeeded. No operation target is persisted.

Decision: the native Security page exposes bounded first windows (64 sessions, 32 passkeys) with explicit truncation, rather than adding cursor navigation; WebAuthn support gates creation only.

Native `GET /security-page` accepts no account selector or query. The existing human proof and issuance boundary
revalidate account, exact session, epoch, client and scopes around composition. Each ready section supplies `rows`,
`limit` and `truncated`; a dependency or malformed native row makes that section `unavailable`. Session rows include
`revoke` advice, passkey rows `remove`, and page actions describe password change and passkey registration. Advice
observes the existing freshness, own-human, capacity and last-interactive-credential guards. Commands recheck all
native authorization at submission; advice is never a grant or prepared command. Registration retains its existing
before/after session checks. Accepted other-session revocation refreshes advice automatically; uncertain responses
still require explicit reconciliation. Current-session revocation uses the existing native cookie clearing and `/login` remedy.

The two owner/id index seeks read at most 65 session rows and 33 passkey rows (one sentinel each), plus one password
presence row: at most 99 composition rows and 64 bounded client-label lookups plus the sentinel lookup. Existing
fixed human-proof/issuance revalidation runs around this finite composition; there is no request loop or runtime
price dispatch. Expired sessions within the bounded window are omitted; a missing current row is unavailable.

The page heading has the same space below it as the sections have between them.

## Delete account

`/account/delete` reads the signed-in account id from one `GET /session`. The page explains that deletion is permanent,
signs the person out everywhere and cannot be undone. Before submitting, the person must type the localized confirmation
phrase shown above the input (ignoring letter case, trimming surrounding whitespace and normalizing Unicode to NFC) and
review the three prerequisites: no operated automated accounts, not the last owner of an organization, and no pending
transfer. These are requirements to resolve, never static verified results; the application and consent inventories
do not establish deletion eligibility. The server does not identify which precondition failed. Operated-account and
pending-transfer requirements link to the existing operator-transfer page. Organization ownership is managed from the
website's managed-account settings: Auth has neither a trusted website destination nor an owned organization ID in
its session/security inventories, so it keeps the local Security fallback rather than inventing a list target or
opening membership management without a valid organization ID.

Each deletion attempt keeps one exact account, operation key and payload for `POST /account-operations/approve` and
`POST /account-operations/execute`. Approval is unsent navigation state; the continuation stores `submitted: false`
until execution is dispatched. A 401 `step_up_required` returns through `/step-up?return_to=%2Faccount%2Fdelete` and
requires a fresh review and typed confirmation. Once execution may have been sent, the continuation keeps
`submitted: true`. A lost or malformed execution response remains unknown across later refusal, step-up, unavailable
advice, signout or account replacement. Only a validated native completion reports deletion accepted; cleanup remains
pending. After returning with only the submitted hint, the page cannot reconstruct which phase ran. It never dispatches
on mount or return. Refreshing deletion review only reads current advice. Repeating a command requires current review,
the same retained account, key and payload, and deliberate typed confirmation. One same-body execution retry remains
limited to the existing unavailable response; a timeout ends browser waiting without cancelling native work.
The initial review and successful submit remain three Auth requests, independent of the number of sessions,
organizations or operated accounts.

Unavailable session reads offer a review refresh without submitting deletion; recovery and cached-page restoration
require fresh typed confirmation, and departure retires callbacks while preserving the original command for explicit
reconciliation. An accepted deletion remains a confirmation of acceptance with cleanup still pending.

Decision: protect nonblank typed confirmation and unresolved deletion in memory with Stay/Leave and unload warnings; Stay keeps the exact review and focus, while Leave retires callbacks and preserves the original reconciliation identity. Authority loss and intended reauthentication release the guard immediately.

Decision: after a failed retry of an unresolved deletion, require a fresh native review before another explicit exact retry; the unknown outcome, account, key and payload remain unchanged.

## Delete organization

`/organizations/delete?organization_id=<UUID>` reviews only the selected organization through the private native
management reader in `organization-deletion.ts`. Its default same-origin POST to
`/account-management/organizations/deletion-review` binds the cookie session server-side with exactly the fixed
`account:delete` profile, returns only the selected organization's id, kind, handle and display name, and verifies
the initiating human. The native management ENTRY deletion authority and the same Auth session are revalidated
after I/O; failures retain the existing localized recovery in all eight locales. Recovery keeps
the selected organization and first discovered initiating human, and clears typed confirmation before each fresh review.
Submission revalidates the review and uses the installed approval, execution and step-up protocol. Accepted deletion
is distinct from cleanup completion. Uncertain results retain the original command identity; unavailable, missing,
denied and readable readback never establish success or permit a fresh deletion.

Departure and selection changes retire private reviews, pending browser stages, completions and operation locks;
already dispatched native work continues. Decision: cached-page recovery is explicit Retry with fresh confirmation,
retaining the initiating human and any original uncertainty identity. Decision: warn on nonblank confirmation or a
pending or uncertain deletion; Stay preserves the exact in-memory review, while Leave retires callbacks without
cancelling or replaying native work. Authority loss releases an unsent draft warning, but every readback result
(including authentication-required advice) preserves an unresolved attempt’s departure protection independently
of current private authority. Recovery shows current advice without private labels or another command. Stay focuses
the recovery heading; Leave retires browser work without clearing its exact stored uncertainty fence. Storage loss
does not settle the in-memory attempt. Readback is deliberate, single-flight and uses the existing bounded native
page reader; it cannot settle the command or produce an authentication-and-delete continuation.
Decision: even readable recovery advice omits private labels; it reports current readability only.

## Create organization

Decision: protect nonblank handles and unresolved creation with Stay/Leave and an unload warning; current refusal or loss of session authority retires controls but preserves the earlier unknown attempt and its departure protection. Only a known first mounted refusal releases its continuation; restored hints are conservatively unresolved, regardless of their submitted marker.

`/organizations/new` reads the current session and asks for one handle. An unavailable initial read offers Retry without discarding the saved draft. It applies the same claim rule and
lowercase normalization as sign-up. Creation uses one operation key for the
approve and execute requests. The `organizations` gate is checked by Auth; a closed gate keeps the handle and shows a
localized message without exposing gate details. A 409 says the handle may be taken, leaves it in the field and focuses
it. Handle format guidance appears before entry. Success names `@<handle>` and links to the created organization's
membership page using the native result's account ID and the existing membership-ID validator. A result that cannot
represent that destination keeps the Security fallback. Navigation grants no membership authority; the destination
retains its own current-session and permission checks. Each explicit submission rechecks the initiating session before and after the native command; the ordinary flow uses five Auth requests regardless of the person's existing sessions or organizations, excluding bounded protocol retries.

Both creation pages retire browser callbacks on departure, cached-page restoration and session replacement. Retry restores the exact saved operation and initiating account; organization review uses its saved handle and original key. Automated review keeps the exact selected operator. Leaving never clears an unresolved attempt or reverses native creation; uncertain results require explicit confirmation of the same command and never automatically repeat execution.

Deletion, creation, rename and operator-transfer pages provide a fixed local return to `/security`, including their
loading and refusal states. Query parameters and response text cannot replace that return target. Leaving performs
no cancellation, approval or operation-key cleanup; a submitted or uncertain operation still needs its original
review/reconciliation flow. Completed deletion offers no session-dependent action. Auth bounds the page grid, nested
form/card items and wrapping actions at phone widths without clipping details or focus. Rename confirmation appears
only after a valid handle is entered; password guidance is shown before the Security password field.

## Organization membership

`/organizations/members` reads a dedicated native page bound to the current viewer and organization. Each page shows
at most 20 rows from a bounded candidate seek. Each row shows a disclosed public display name or handle with an
explicit identity fallback, and keeps the account ID behind an explicit disclosure. The viewer's current role and the
page's native per-action advice control which choices are shown. Members never see the owner editor; self-leave appears only when its native advice
allows it, otherwise its absence is explained. A last-owner observation disables the affected owner action with an
explanation. Roster unavailability is displayed separately from a ready empty page. Reload starts a new read and
retires the old controls; the next-page cursor is opaque and viewer/organization-bound.

The browser sends only the organization and cursor to Auth. Auth binds the fresh human management proof to the
dedicated Kernel page source. The roster and its action advice are observations only. Before a selected change, the
existing exact member read still supplies reservation/version metadata, then native approval, command authorization,
retry identity and reconciliation remain in force. A stale page cannot authorize a write; after command completion
the route reads the page again so current roles and advice replace old controls. An unavailable dependency never
becomes an empty roster.

Leaving or changing organizations ends pending browser continuations before they can install a review or start
another request. An already dispatched change continues independently; its stored command, exact operands and
original key remain available for explicit confirmation and native reconciliation. Failed identity confirmation
keeps the current review usable.

Decision: membership departure, paging and reload offer Stay/Leave for changed input or unresolved work; Stay preserves the exact review and focus, Leave discards unsent input while retaining dispatched command identity, and authority loss bypasses the choice. Browser reload/close warns only while this work exists; reauthentication remains in-page and secrets remain ephemeral.

## Operator transfer

Operator-transfer read failures offer Retry within the same page view. A failed session read preserves the saved
attempt without treating it as an account mismatch; recovery restores it only for its initiating account and requires
fresh confirmation. Signed-out or changed accounts cannot act on it. Relation retries repeat only the failed read;
after a submit failure, Retry reads the current relationship and leaves approval/execution in the original explicit
reconciliation flow, retaining the request, operation key and references.

Decision: transfer departure protects meaningful input and unresolved review in memory with Stay/Leave; only a review created here and never submitted is discarded, while restored attempts are conservatively retained because approval may already have reached native. Caller replacement and permission loss retire local authority without prompting.

## Rename account

Rename review belongs to the mounted page and its native source; replacing the source resets the draft and confirmation,
and departure prevents unfinished browser stages from changing storage or starting reauthentication.
Unsent attempts stop after an outstanding read or approval; submitted attempts retain their original key and command
and finish reconciliation without changing a replacement review. An uncertain mutation requires explicit recovery,
with current-account readback establishing success. `nativeRenameSource` reads the current initiating account through
Auth's cookie-authenticated `POST /account-management/profile`, backed by the native exact-ID editable-profile reader
and its `account:update` permission formula. Only account ID, actor kind and nullable handle reach the page; unavailable
reads offer Retry and never permit mutation. The selected management profile is exactly `account:update`.
Step-up uses the shared management continuation and returns to a new explicit confirmation with the original command/key.
Departure prompts cover nonblank changed handle input, including invalid values, and unresolved operations; opening, focusing or confirming the current handle alone does not prompt.

## Operated session opening

Decision: router departure protects nonblank input, prepared review and unresolved opening with Stay/Leave and reload/close warnings; Stay preserves the exact in-memory review and focus, Leave retires callbacks while retaining submitted readback, and fresh-human authentication or invalidated caller authority bypasses the guard.

Read recovery keeps the selected human, subject, operator and original opening key; cached-document return discards private review state and restores only reads from the existing pending descriptor. Submitted openings retain their command for native session readback, and departure retires browser continuations before their next stage.

## Step-up

A signed-in browser whose session is not fresh enough for `prompt=login` or `max_age` arrives at
`/step-up` with the authorization query, `sig` and `exp`. One sentence explains why confirmation is
needed. The form asks for email (`autocomplete="username"`) and password
(`autocomplete="current-password"`).

Decision: departure is protected when the email has non-whitespace text, the password is nonempty, or a confirmation is pending; leaving clears local input and retires callbacks while any dispatched sign-in continues.

`src/step-up.ts` reuses `signIn` and `signInTarget`. Confirmation is one browser `POST /signin` with
the same `client_id` and `scope` as sign-in. On success, Auth replaces the previous session. The
browser then resumes at `/authorize` with that query, removing every `sig`, `exp` and `prompt` and
keeping `max_age`. With no authorization query left, it goes to the `return_to` path when it is on the fixed list of Auth
page paths (now only `/security`), and to `/security` otherwise. `return_to` is never forwarded to `/authorize`, and
an absolute URL or another origin is never followed. The response body never supplies a navigation target. Security
settings send a person to `/step-up?return_to=%2Fsecurity`, so password and passkey confirmation both return there.

Where the browser has WebAuthn, a "Verify with a passkey" button sits below the password form. It asks
`POST /signin/passkey/options` for options, prompts, and sends `POST /signin/passkey` with the same `client_id` and
`scope`; success resumes as above. A dismissed prompt is silent and other failures use the same alert. Without WebAuthn
the button is absent.

A wrong password, rate limit or outage uses a destructive alert with an icon and title for 401, 429 and 503 and keeps
the person on the page. Submission validates email and password, links field errors to their inputs and focuses the
first invalid field. Password visibility uses the shared in-field control. The submit button stays enabled until a
request is pending and shows its loading state while waiting.

Each confirmation belongs to the current page and exact request URL; departure, a changed request or cached-document
restoration retires its callbacks and clears private inputs. Password submission may replace a passkey prompt,
cancelling the browser ceremony without undoing a dispatched server sign-in or automatically replaying it.

## Screenshots

Run `bun run screenshots` to capture all eight page states in the eight launch locales and both themes. Desktop images
use a 1280×900 viewport; login also has one 390×844 light-theme phone image per locale. By default, images are written
to `.temp/screenshots/auth/` at the repository root. Pass `--out <directory>` to choose another destination.

## Development

Shared `authPost` submissions have a five-second deadline (`AUTH_POST_TIMEOUT_MS`), matching existing Auth issuer
transport conventions and covering both connection waiting and JSON consumption. A timeout uses the existing localized
outage state; native writes remain uncertain where their protocol requires readback or exact-command recovery.
Decision: a deadline ends browser waiting only; its distinct `timeout` result prevents automatic approval or execution
retries, retaining the original account, operation key and command for explicit recovery.

From this directory, run:

    bun run dev --host 127.0.0.1 --port 4200 --strictPort

The rezics_locale cookie wins when it names a supported locale. Otherwise Auth negotiates the weighted
Accept-Language header and falls back to English.

When AUTH_ORIGIN is set during development, every path outside the six pages and /auth-assets/ is sent to that
origin with its method, path, query, headers and streamed body. Redirects are returned without following them; Auth's
response headers and body pass through unchanged.

Every page is private and not stored, and the frame policy blocks embedding with both frame-ancestors 'none' and
X-Frame-Options: DENY.

## Production routes

The Worker is attached to auth.rezics.com only for /login, /signup, /consent, /recovery, /security, /step-up and the
/auth-assets/* static asset prefix. Auth's own issuer endpoints stay on that host without passing through this Worker.
Production does not set AUTH_ORIGIN.

## Cost

The static page frames make zero K, D, R and A calls. Development forwarding makes one Auth request per forwarded
request, streams both bodies, and buffers nothing. Both costs are constant per request.
The sign-in page makes one Auth `POST /signin/page` read on entry and one more only when Retry is selected. A password
sign-in adds one `POST /signin` and one navigation on success. A passkey sign-in remains two Auth requests and one
navigation on success. The page read adds no kernel calls and carries no preparation token into submission.
Recovery makes no kernel reads and adds one Auth request per submit.
Auth pages make no kernel reads. Step-up is one `POST /signin` per submit.
Sign-up makes no kernel reads. A successful submit is one browser `POST /signup` and one browser `POST /signin`.

### Passkey sign-in

- **Touches:** `POST /signin/passkey/options` and `POST /signin/passkey`; autofill and the button share one set of options
- **Bound:** 2 Auth requests and 0 kernel reads, whatever the number of passkeys the person has
- **Growth check:** `tests/passkeys-cost.test.ts`: a passkey sign-in makes two Auth requests however many passkeys the person has

### Passkey step-up

- **Touches:** the same two requests as a passkey sign-in
- **Bound:** 2 Auth requests and 0 kernel reads
- **Growth check:** `tests/passkeys-cost.test.ts`: a passkey step-up makes two Auth requests however many passkeys the person has

### Passkey list

- **Touches:** one `GET /passkeys`, which returns only the signed-in person's passkeys, beside the page's `GET /session`
  and `GET /sessions`
- **Bound:** 1 read of at most the person's own passkeys; 0 kernel reads; one row rendered per passkey
- **Growth check:** `tests/passkeys-cost.test.ts`: listing passkeys is one read however many passkeys the person has

### Adding a passkey

- **Touches:** `POST /passkeys/register/options` and `POST /passkeys/register`; the new row comes from the 201 body
- **Bound:** 2 Auth requests and 0 kernel reads, with no re-read of the list
- **Growth check:** `tests/passkeys-cost.test.ts`: adding a passkey makes two Auth requests however many passkeys the person has

### Removing a passkey

- **Touches:** current `GET /session`, then the existing exact-key `POST /passkeys/remove`; explicit recovery reads one current `GET /security-page` with its native viewer, inventories and advice
- **Bound:** 2 Auth requests for dispatch and 0 kernel reads; an explicit recovery check makes 1 native Security page read and 0 kernel reads
- **Growth check:** the original `tests/passkeys-cost.test.ts` oracle remains unchanged; `test/security-reconciliation.test.ts` covers the focused recovery behavior

## Visual check

The /login frame was inspected at 390 px and 1280 px in light and dark themes. The wordmark and heading remain
legible, the brand mark is the only red element, the centered card fits the narrow viewport without horizontal
overflow, and the background and card retain clear contrast in both themes.

## Security headers

GET and HEAD responses for the six page paths use a fresh 16-byte cryptographic nonce per response. TanStack Start
passes it to its scripts through the router's `ssr.nonce`; Vite's development scripts and styles use its CSP nonce
marker. The policy trusts nonced scripts with `strict-dynamic`, allows Turnstile scripts and frames at
`https://challenges.cloudflare.com`, and limits styles to this origin and the nonce. Style attributes are allowed.
Images use this origin or data URLs. Connections and form submissions stay on this origin; development also allows
the dev server's websocket origin. Base URLs, objects and framing are forbidden, and insecure requests are upgraded.

Every page sends `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` to protect authorization and
recovery state, plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Cross-Origin-Opener-Policy: same-origin`. Permissions disable camera, microphone, geolocation, payment and USB while
allowing same-origin passkey creation and authentication. HTTPS responses send HSTS for one year with subdomains,
without preload. Static assets, unknown paths and Auth forwarding retain their own responses.

The policy costs one 16-byte random nonce and one header set per response, with no reads. Run
`bun test apps/auth/tests/security-headers.test.ts` from the repository root to build and preview the production
bundle and check Chromium hydration, policy violations and the real Turnstile script URL with an offline widget.

Decision: automated creation asks Stay/Leave for meaningful input or unresolved review; Leave discards only unsent review, while a tab-local submitted marker preserves the original command for recovery. Caller replacement or permission loss revokes review without prompting.

Decision: opening advice uses a dedicated native management observation; the exact manage-only client keeps identity labels undisclosed instead of acquiring read scope. The read remains advice, never an opening approval.

The Auth host installs `POST /account-management/operators/opening-page` from the native account bindings. Its closed current response identifies the acting human, installed actor target, installed operator kind, reservation/version and supported `opening` action. Missing authority returns refused; missing infrastructure returns unavailable. A single ten-second deadline covers one authentication, two bounded native transfer-state reads and one full-key operator-kind read. The two relation observations must agree. The endpoint performs no command, approval or credential staging; submission still needs the existing fresh-human approval and opening command. Page consumption and public-label enrichment remain separate implementation work.
