# Auth pages

For the complete loopback stack, generated keys, persona and reset command, see
[Local development stack](../../docs/development/local-stack.md). Run `task dev:infra` then `task dev` from the repository root.

Auth is a TanStack Start app on Cloudflare Workers. Its page frame is served at the unprefixed paths /login, /signup,
/consent, /recovery, /security and /step-up. Each page contains the REZICS brand header and a localized heading.
Paraglide supplies the eight launch locales.

Route-error Retry performs bounded current-route read/render recovery, never command replay; missing pages use a localized 404 for classified
browser documents and fixed local exits at `/login` and `/security`.

Local development uses the Cloudflare Vite plugin's default `.cloudflare/state`. Test launches receive an independent
temporary persistence directory per Auth Vite process. `AUTH_TEST_STATE_INSTANCE_DIR` supplies a caller-owned path for
one instance whose state must survive a sequential restart; Auth leaves that directory in place after shutdown.

Set `PRIVACY_CONTACT_URL` to the deployment's `https:` or `mailto:` privacy contact URL; missing or invalid values disable account deletion at request time.

Pages compose the shared shadcn card, field, input, input-group, button and alert components. Security
lists also use shadcn items and badges. Password reveal buttons have localized show/hide names and stay disabled
until hydration. Native form submissions keep their fields and actions; scripted actions retain their pending
states with an accessible busy indicator. Error text uses ink blue, with red reserved for the brand mark.

## Mounted operation lifetime

These are adopted browser requirements; documentation establishes no native, browser or shared-suite pass.
Current private advice and generic operation history are separate. Mounted history keeps the first unresolved
generic unknown plus the latest review/interruption, at most two records, until explicit dismissal. It contains no
private account/client/target/key/scopes/payload, and adds no persistence. Fresh documents invent no history.
Later acknowledgement, refusal, decline, actor/request replacement, inventory and current reads never settle the
earlier unknown. Dismissal hides text only: it cannot cancel or confirm work, remove a marker/fence, authorize resend
or remove an unresolved attempt's departure caution.

Distinguish unsent, staged/approved/applied, acknowledged/refused and possibly-sent unknown. Lost, malformed or
timeout mutation replies are uncertain effects, not editable failures. Supported native idempotent retry retains
the original exact actor/client/key/payload/scopes in its existing attempt/descriptor. Read Retry fetches current
advice only. Fresh work requires deliberate review and installed warning acknowledgement; no observation attributes
an earlier effect. Existing Stay/Leave and unload guards protect meaningful drafts and unresolved sends.

Adopt a validated native acknowledgement while its original callback and descriptor are current, before an
independent final session read. If that read fails, signs out or replaces identity, keep the generic acknowledgement;
private created details and navigation still need unchanged before/after proof. Replies arriving after retirement
remain unknown. Retry, return and dismissal cannot reopen an acknowledged invocation or clear replacement markers
or drafts. An older completion cannot consume a newer descriptor.

Pagehide and authority replacement synchronously clear private DOM, including detached inputs, and retire callbacks.
Cached return retains only generic history until current advice and deliberate review. Late callbacks cannot restore
identity, focus, reset or navigation. Exact continuation operation/target/key/return destination must match before
and after observation; account equality alone is insufficient. Retained private retry operands use only the existing
supported descriptor/attempt lifetime; generic history cannot reconstruct them. Language changes use the mounted
language mechanism below, with no navigation or command replacement. Focus, dismissal and historical display add
zero I/O. Each page's finite advice, preflight and readback costs remain additional below.

## Account home

The Auth brand and `/` open the localized account home. It uses one existing private `POST /account-identity` read to
show only the current own account, with a missing email left missing. Signed-out, refused and unavailable reads stay
distinct; unavailable has an explicit Retry and sign-in/recovery exits without assuming the visitor is signed out.
The technical account ID is behind a disclosure; email and ID are display-only and establish no permissions, human
kind or operator status. Public task groups remain usable in every read state. Destructive deletion has a distinct
review entry with consequence guidance, never a submit control.

Security, handle rename, personal deletion, organization creation and automated-account creation use ordinary links
to the installed zero-selector review pages. Destination-native advice determines current action availability and
authentication requirements. Home availability is unknown; even a successful private identity read grants nothing.
Creation keeps the native forms, deliberate review, continuation markers and Stay/Leave protections with their owners.

Decision: group identity/lifecycle, security and account creation separately; exact-target tasks get explanations and
attached Security exits because Auth has no admitted local directory entry to reuse.

Membership needs an exact organization selection; organization deletion needs its exact ID. Operator transfer needs
the exact actor/source/destination request and destination acceptance before source submission. Session opening needs
the exact automated actor/current operator and replaces the browser session. These are explained without linking empty
selectors, guessing public-profile targets or preparing drafts. Native authentication, permission and consequence
checks remain on their owning flows. An uncertain result is never presented as deletion or cleanup completion.

Whole-call home cost: server rendering, task navigation and language changes perform zero home requests. Each mount,
explicit read Retry or persisted `pageshow` performs one installed `POST /account-identity` with `{}` and a five-second
deadline through response-body completion. `pagehide` synchronously clears private data and aborts the old generation;
source replacement retires the prior read and makes one fresh observation. Late results cannot restore old identity.
There is no focus polling or automatic retry, inventory fan-out, command prepare, approval or write. Links perform no
background preflight and accept no operands or workflow keys. Read Retry only refreshes the observation, focuses its
current status and never navigates or starts authentication.

The local guide has phone/desktop and light/dark stories for current identity, missing email, loading, signed-out,
denied, unavailable and current-read replacement. The mounted language chooser updates all guide copy without a reload
or a required preference write. Native/browser and integrated acceptance remain controller-owned.
distinct; unavailable has an explicit Retry. The technical account ID is behind a disclosure. Security, rename and
deletion links open their existing review pages; each page checks its own current native guidance, so navigation does
not promise that an action is available. The home never loads an inventory, changes state or resumes an operation.

Home offers installed zero-selector review links for Security, rename, personal deletion, organization creation
and automated creation. Identity is display-only; each destination's current native advice owns execution.
There are no fabricated organization targets, per-card preflights or membership link without a selected ID.

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

During an explicit sign-in, disable account switching and session review; switching before dispatch retires
conditional mediation and the old Continue control synchronously. Native email is display context, never credential input.

The current account, credential entry for another account, pending authentication, unavailable advice and reviewed session
are distinct mounted choices. Continue belongs to that choice, not merely the last loaded page. An explicit passkey operation owns the method controls until its response retires; a password cannot replace it. Same-turn events share LoginAttempt's exclusion before React renders. A dispatched request cannot be
cancelled at the server by changing browser presentation. Account-operation returns use the existing step-up selectors and
confirmation helpers; a page review cannot complete or replay them.

When authentication has no confirmed response, the page removes the old account label and offers Review current session.
This makes exactly one bounded `POST /signin/page` read with the original query. It does not resend authentication. The
review explains a changed account, signed-out state or unavailable observation before another explicit choice. Even a
matching account is not evidence that the uncertain request succeeded. The person may deliberately continue a supported
current-session return or choose credentials again; neither step claims the uncertain request failed or was cancelled.
Review clears credentials, invalidates conditional mediation and never automatically starts another ceremony. No private
choice or credential data survives pagehide; BFCache restoration starts with one fresh native observation.

Sign-in history uses the mounted lifetime above, with generic method/phase only. Idle autofill alone does not
warn on departure; possibly sent autofill does. Switch retires previous autofill, Continue and completions
synchronously. Button and autofill passkeys remain separate browser choices even when they share cached options.
A deliberate new authentication needs current advice; retained return never starts autofill. Existing exact
step-up helpers retain their native preflight/readback and conservative possible-dispatch classification.

The whole-call bound remains one bounded native page read per entry, retained return or deliberate read Retry,
one password authentication or two passkey Auth calls (options plus response, with the existing four-minute options
cache), and the existing native preflight/readback for operation confirmation. Local phase observation, dismissal,
focus and return history add zero I/O, inventory scans, polling or speculative commands.

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
four minutes, so a sign-in is two Auth calls however it starts. A dismissed explicit prompt (`NotAllowedError`) gives an attached next step; replacing idle conditional mediation is silent. A definitive refusal shows a passkey-specific alert; an unconfirmed outcome offers
current-session review. Without WebAuthn the page shows no passkey control and the email field keeps
`autocomplete="username"`.

Password, explicit passkey and autofill completions belong only to the current login journey. Changing the
URL, leaving the page or restoring a cached document discards old callbacks and private inputs. A password
submission can replace conditional mediation only before its assertion dispatch; only a current completion may unlock the form or navigate.
Replacement cancels the browser ceremony, without undoing a server sign-in or retrying an uncertain request.

login Stay/Leave protects non-whitespace email, any password or a pending explicit sign-in in memory; Stay retains validation, the current request and focus, Leave clears inputs and retires callbacks, reload/close uses the browser warning, and replacement login requests or successful validated returns bypass the choice. Background conditional passkey autofill alone does not warn.

The submit button stays enabled until a request is pending. Submission validates the email and password, marks each
invalid field with a linked error, and focuses the first invalid field. The password uses the shared in-field show and
hide control. A refusal keeps the email, clears the password and focuses a destructive alert with an icon and title:
401 reports incorrect email or password without identifying an account, 429 includes valid `Retry-After` seconds,
and an unconfirmed response enters current-session review without a resend or a success claim.

## Recovery

Recovery has an email-start form and a new-password form. Each submit makes one browser Auth request; native commands retain their existing Access checks. Every 200 start response shows the same acceptance acknowledgement while leaving the email editable. A recovery fragment is
removed from browser history before the completion form can send a request. Completion sends the account id, token and
new password as JSON; the token is not rendered in the page or placed in a request URL. The page sets
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

Successful completion revokes the account's sessions and sends the person to `/login` with a localized success notice.
An invalid or expired link offers a new recovery link. Rate limits show a valid `Retry-After` duration, and outages
ask the person to try again later.

Leaving or replacing the recovery journey discards its browser results and private inputs; returning from a cached
document starts a fresh form without retrying a mutation. Departure cannot undo a completed native password change.
an unknown completion retains the original account, token and password only in the mounted attempt; explicit retry sends that exact submission, while restart or departure discards it without asserting cancellation. Definitive first validation refusals allow correction; a later refusal cannot resolve an earlier unknown outcome. Start acknowledgement confirms acceptance only.

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
An already signed-in visitor continues with the current account and can choose Sign in to replace it.
Nonblank handle/email, any password or confirmation, or a pending creation prompts Stay/Leave; Stay
preserves input, validation and the same attempt, while confirmed creation releases the warning before sign-in.
Reload/close warns only for that unfinished work; Leave clears in-memory details and retires browser continuations
without undoing a dispatched creation. A persisted browser return clears entered values, challenge tokens, request
payloads and old callbacks, then shows only a generic summary for a possibly completed creation or confirmed creation
whose automatic sign-in did not establish a session. Before showing registration controls, it reads fresh native advice.
An untouched draft or known terminal refusal restores without a warning, after the same fresh advice read. A deliberate
review acknowledgement can open a new form only while native advice permits registration; the form has a new key and
explains that the earlier result remains unknown. Browser restoration never replays registration or automatic sign-in.

An uncertain acknowledgement retains the normalized original business input and request key in the
mounted journey, shows the retained handle/email without the password, and allows only an explicit exact retry with
a fresh Turnstile token or sign-in/recovery. A failed verification or refusal of that retry does not resolve the
earlier unknown result. A retry-after delay gates the explicit retry without claiming to cancel creation. Pagehide
retires this credential-bearing lifetime; the return summary cannot retry or attribute the old write to a current viewer.

Only a first-response 409 `handle_unavailable` establishes the safe handle-correction transition. It has no
account effects; after choosing a different valid handle, the page starts a new request with a new key. A 400
`registration_denied` before any uncertain result permits the same draft to continue with a fresh challenge. Generic
409 responses remain non-enumerating and offer sign-in/recovery without opening a changed registration request.
Network failures, unread responses and 503 responses stay uncertain. A malformed 201 body still confirms creation.

## Consent

`/consent?client_id=<id>&scope=<space-separated scopes>` reviews a third-party client's request. The private
`GET /consent/<client_id>?scope=...` projection binds the exact bounded request, registered client facts, current
effective grants, pending reduction state, admitted acting account and native decisions. Its exact-self email is used
only on this private page; it is not labeled verified or returned to the client. The read revalidates the human session
and client while holding the existing issuance and consent locks, and returns `private, no-store`. Unknown requested
names remain visible with their literal identifier and an honest fallback description; query text never declares a
supported scope or grants access.

Each requested scope shows a localized description, identifier, and whether it is already granted, new, or unavailable.
Approval sends the existing same-origin `POST /consent` writer the exact reviewed account, effective grants, request and
the replacement union of existing grants with requested registered scopes. Native Auth checks the reviewed grant set
again under the consent lock before writing. A grant added after review makes the action stale and requires a fresh
explicit decision; it cannot be removed by an ordinary Allow. Requested names outside the registered client ceiling
remain visible but are excluded from the write. Success lists only the exact submitted scope set. Declining is a local
decision and never claims to revoke or undo an earlier uncertain approval.

The page never redirects and ignores arbitrary query destinations. The account-switch link uses only the supported
local `/login` return target for this exact client and request. Unknown and first-party clients show a localized
not-found message. Unavailable reads never become an empty review. Changed client/request observations, account changes,
page departure and restoration retire old results; restoration reads a fresh review before enabling decisions.
Uncertain writes remain unresolved and are never replayed automatically. Tab storage keeps only the minimum marker
context for the admitted account, client and request. A legacy marker without an account remains visibly unattributed;
a different account cannot inherit or resolve it from matching consent.

Consent history follows the mounted lifetime, with current private client/scopes/account shown only from fresh
exact review. Read Retry uses the same client/scope GET and sends no decision. Pending reduction advice remains
separate from historical uncertainty. Allow requires current native review and deliberate activation; Decline sends
nothing. Protected navigation uses Stay/Leave and unload warnings. Focus moves to the generic review summary when
private controls retire, then to the current read result/error. Fixed exits are exact review sign-in and Security;
no client-supplied redirect is accepted.

Whole-call costs: initial review, each explicit read Retry, focus return after blur and cached-document restoration
perform at most one existing five-second bounded exact consent GET each (zero if the client is missing or the request
is invalid). Each deliberate Allow performs one existing five-second bounded POST; there is no implicit resend,
inventory read, marker scan, polling or per-permission call. Repeated activation shares the active read or decision;
Decline, Stay and historical presentation perform zero requests. Leaving can only retire browser ownership.

Page paths render only for GET and HEAD. Other methods, including `POST /consent` and `POST /signup`, pass the
original request through to Auth at the issuer origin in production, or through the existing `AUTH_ORIGIN` proxy in
development. Auth's response returns unchanged, without page headers.

## Private review reads

each private session, consent and inventory read has a five-second deadline through response-body
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

Retired Security attempts use the mounted generic history. A current inventory proves only current presence or
absence, never which earlier action ran. Same-account exact target retry needs a fresh native review and new
confirmation; changed authority hides private targets. Generic history remains independent of these controls.

Whole-call costs remain bounded: the page uses one native `GET /security-page` read; dispatch uses the existing current
`GET /session` check and one exact-key removal command (two Auth requests, zero kernel reads); each deliberate
current-state check uses one native Security page read and zero commands. Pagehide, return, focus and notice dismissal
add no Auth or kernel calls, inventory scans or per-row reads.

The browser action wait is twelve seconds: the existing sequential five-second native account check and
five-second command, plus two seconds for browser/BFF delivery. Expiry, abort, thrown transport or malformed
acknowledgement after invocation becomes unknown. One invocation sends at most one command; cancellation cannot
undo native work. Target reads use the five-second private-read deadline even if an injected source or browser
transport ignores abort. Retired waits cannot publish or release another operation.

Passkey enrollment shows options preparation, the browser prompt, registration dispatch, and its confirmed or unknown
result as separate states. Cancelling before dispatch sends no registration request. After dispatch, a lost response or
page departure retains only the attempt identity, initiating account and uncertainty in mounted-page memory; restoration
loads current native advice and requires an explicit bounded passkey review before a new enrollment is available. A
matching name, visible row, empty list or truncated list never settles the earlier write. Finishing review acknowledges
only the inventory shown and does not claim whether that write committed. A blank name receives a browser-and-system
suggestion, which may not identify the saved passkey.

When the direct passkey review has no explicit completeness flag, a full 32-row result is shown as potentially
truncated because the read is bounded at the native contract limit.

Security departure is protected by any nonempty new password, a nonblank passkey name, or an unresolved operation;
Stay keeps the in-memory review and focus, while Leave clears local authority and drafts without claiming to cancel an
operation already underway. Reload or close warns while protected. Cached-page return reloads the account,
credential/session lists and both application inventories before enabling their controls.
Only an unresolved destructive target's original account, kind and native id survive in page memory: for the same
account, return requires fresh explicit readback and confirmation; a different account discards that target. Failed
reads offer Reload, ended sessions offer sign-in, and return never replays a credential or consent command.

Connected-application reviews use one page-local controller and acquire the same write boundary until cancellation or a determinate result. Nonempty reductions carry the exact reviewed grant set to the native writer, which rechecks it under the consent lock before publishing a reduction barrier. If it changed, the page refreshes the current permissions and requires a new explicit decision; it never changes the reduction into Allow or resubmits. Explicit remove-all retains its existing meaning, pending reductions keep their ceiling, and uncertain reductions keep all security writes blocked without replay. Independent owned-client navigation remains available and consent navigation cannot discard a review.

Connected-application history uses the mounted first-unknown plus latest-review limit. New deliberate review does
not settle an earlier unknown, and retired callbacks cannot replace current review or history.

Connected-application whole-call costs: Security entry and cached-document return each make one bounded `/clients` inventory read and one bounded `/consents` inventory read, at most 20 rows apiece. Each explicit inventory retry or page navigation makes one read for that inventory and cursor. A confirmed reduction first reads the same bounded consent page once to recheck the target, pending state and exact current grants. A nonempty retained set then makes one existing exact `GET /consent/<client_id>` review; remove-all makes no consent GET. Each path sends at most one existing `POST /consent`; nonempty reductions include the original `reviewed_scopes`, while remove-all keeps its empty-scope body. Every awaited preflight is followed by the existing operation-currentness check, including the exact consent read, and a final currentness check immediately precedes the POST. The response is classified only from its exact native result; no post-write inventory read settles an unknown. A known `stale_review` refusal permits one bounded current consent-page read and no second command. Return, Retry, pagination, focus, language changes and notice presentation send zero commands. There is no polling, full list scan or per-row authority read.

Password changes use the current native Auth password limits, shown locally with Unicode character counts and kept
within Auth's storage bounds, and require matching new-password confirmation. Before dispatch, the person reviews the
current account and the native session consequences. Replacing an existing password retires all sessions, including
the current one; adding the first password leaves existing sessions active. Security advice never discloses password-row existence; the review explains both outcomes.

One random operation key and its exact stage, approval and apply bindings stay in mounted page memory. A transport
failure, timeout or malformed response is phase-specific uncertainty. No phase is retried automatically. An explicit
retry reuses that exact phase payload only while current Security advice allows it; native authorization remains final.
Only a validated apply receipt confirms completion. A refusal or expired approval after an unknown apply does not
resolve that earlier result. A confirmed replacement retires the session and the page offers sign-in with the new password;
if that does not work, the existing account-recovery path remains available. When current advice requires step-up, the
page goes to `/step-up?return_to=%2Fsecurity` before sending any credential-effect request. No password is put in a URL.

Page departure or private-authority retirement captures only the interrupted stage, approval or apply phase and
whether an apply receipt was confirmed. Passwords, proof, bindings, references, keys and the former identity are
cleared. This generic history stays in mounted memory through cached-page restoration and cannot be settled by a
current Security read. It offers sign-in and account recovery; a fresh password form appears only after explicit
acknowledgement of an earlier unknown result and a current allowed Security review. Exact retry is unavailable after
the original attempt is retired. Review current Security performs no command: it reuses the existing Security page and
password-requirements reads (two Auth reads), current account-identity read, and one bounded first page each for
clients and consents (five reads total). It performs no inventory scan or per-row authority reads.

Mounted return history keeps only the most advanced interrupted phase and whether an apply receipt was observed; read Retry preserves that history, while fresh work requires explicit acknowledgement and current native advice.

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

Registration uses the existing five-second issuer deadline through response-body completion; an uncertain acknowledgement holds the page operation boundary until an account-bound native passkey refresh and explicit review, never infers success from names or WebAuthn IDs, and never replays the ceremony or registration POST.

Passkey history follows the mounted lifetime. Check current and Finish review remain separate actions; neither
settles enrollment. Current rows/actions require native advice and bounded inventory. Without explicit completeness,
a direct 32-row result is potentially truncated. Names and WebAuthn IDs never identify native rows. An acknowledged
registration remains acknowledged if later session readback fails, without restoring private details or navigation.

Security entry, cached return and page Retry each make one existing bounded native Security read (64 sessions and 32
passkeys). Deliberate registration uses the admitted advice, one bounded options call, one browser ceremony, one
bounded register command and, after acknowledgement, one bounded native Security readback before actions return.
Check current makes one bounded registration review read; Finish review makes one bounded Security read. These paths
keep the existing native preflight, issuer deadline and readback. Dismissal, Finish review itself, focus, locale changes
and cached return history make no command; there is no inventory scan, polling, per-row authority loop or replay.

A lost or 503 mutation response retains only the account, operation kind and exact target id in page memory and
shows an unknown result. It never sends an automatic duplicate. An explicit check reads current native authority
and the own session/passkey inventory with no-store, using the fixed request cookie, then rechecks authority.
Malformed inventories and explicitly truncated native windows cannot prove a target absent. Reconciliation reads the native page and replaces target advice; a complete window at capacity can prove absence. A present target enables an
explicit retry with a new confirmation and normal native checks. A denied or ended session clears private rows;
sign-in is the remedy and does not establish that the action succeeded. No operation target is persisted.

The native Security page exposes bounded first windows (64 sessions, 32 passkeys) with explicit truncation, rather than adding cursor navigation; WebAuthn support gates creation only.

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

`/account/delete` obtains current advice and the session-bound identity through
`POST /account-management/deletion-page`. An ordinary session receives authentication-required without private
identity or deletion preparation. Deletion is permanent, signs the person out everywhere and has no account restore.
The person reviews operated-account responsibilities, last organization ownership and pending transfers; application
and consent inventories cannot verify eligibility. Native refusal does not identify the failed prerequisite.
Operated-account and transfer guidance uses the existing operator-transfer route. Organization ownership uses
supported website management; without a trusted destination and selected organization, retain the local Security
fallback. No membership target is fabricated.

`loadAccountDeletionPage` performs one same-origin advice POST for entry, retained-document return or deliberate
read Retry, with the five-second private-read deadline and no automatic retry. Only admitted advice mounts
`SecurityInventory`: one clients page and one consents page, each capped at 20 rows. Further pages need explicit
navigation. Review retirement aborts its lifetime and invalidates both inventory results. There is no separate
session GET, approval or execution on return or Retry.

Each mounted attempt retains its original account, key and exact approval/execution payload. Before dispatch,
authentication keeps an unsent continuation; execution dispatch sets its submitted marker. Older descriptors
without a marker are conservatively submitted hints. Step-up returns to fresh native review, clears confirmation
and compares exact human/target/key before another explicit choice. Confirmation uses the localized phrase,
case-insensitive after surrounding-whitespace trimming and Unicode NFC normalization.

Lost or malformed mutation replies remain unknown across later refusal, authentication change, unavailable advice,
dismissal and account replacement. A submitted hint cannot reconstruct which phase ran. Keep the original descriptor
and fence; another deliberate exact retry requires fresh review and typed confirmation. Only a validated native
completion acknowledges deletion acceptance, with cleanup and downstream custody still pending. Browser timeout
ends waiting without cancelling work. No mount, observation or recovery action executes deletion automatically.

From an admitted current review, ordinary successful submission sends one approval POST and one execution POST.
Each phase permits at most one same-body retry for `503 unavailable` while that review still owns the attempt.
The advice POST and its two admitted inventory reads are separate: a normally admitted entry plus submission is
five Auth requests. Ordinary authentication-required advice reads no inventory. Each admitted return or read Retry
adds one advice POST and two bounded inventory reads, with zero commands. These finite counts are independent of
session, organization and operated-account populations. Native preparations, proofs and whole-call ceilings remain
owned by [Auth](../../services/auth/README.md#personal-account-deletion-review).

Protect meaningful confirmation and unresolved sends with Stay/Leave and unload warnings. Stay preserves review
and focus; Leave retires callbacks without cancelling native work. Authority loss clears private controls and
intended reauthentication retains its unsent continuation. An unresolved send keeps its generic history, exact
reconciliation identity and departure caution independently of current advice. Dismissal hides the generic return
summary only; it removes no descriptor, native fence or warning. After a failed exact retry, a fresh native review
is required before another explicit retry; the earlier unknown and original operands remain unchanged.

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
already dispatched native work continues. cached-page recovery is explicit Retry with fresh confirmation,
retaining the initiating human and any original uncertainty identity. warn on nonblank confirmation or a
pending or uncertain deletion; Stay preserves the exact in-memory review, while Leave retires callbacks without
cancelling or replaying native work. Authority loss releases an unsent draft warning, but every readback result
(including authentication-required advice) preserves an unresolved attempt’s departure protection independently
of current private authority. Recovery shows current advice without private labels or another command. Stay focuses
the recovery heading; Leave retires browser work without clearing its exact stored uncertainty fence. Storage loss
does not settle the in-memory attempt. Readback is deliberate, single-flight and uses the existing bounded native
page reader; it cannot settle the command or produce an authentication-and-delete continuation.
Even readable recovery advice omits private labels; it reports current readability only.

After a cached-page return, retain only generic mounted history and wait for a deliberate current review; that read never repeats or settles the deletion request. The page keeps known-unsent, dispatched/unresolved and acknowledged outcomes separate from current organization advice. History contains no identity or operation descriptor. An accepted request remains distinct from downstream erasure custody and cleanup.

Whole-call browser cost: entry is one deletion-review POST; deliberate return adds one identical read and zero
writes; confirmed submit adds one preflight review, one approve and one execute. Failed review Retry adds one read.
The existing current-generation limits permit one unavailable-response approval retry and one same-key execution
retry; departure repeats neither. Step-up stops execution and returns to fresh review/confirmation. Every review
has before/after actual Auth-session proof. For ordinary live-human advice, it returns authentication-required
without target, role or permission I/O, and exposes no target detail. An untrusted target/key survives only as the
auth continuation; exact-profile denial remains denial.

The exact admitted profile branch separately composes two native snapshots: four account reads, four partition-anchor
reads and two organization-role reads, plus bounded ENTRY preparations/checks and Auth proofs. If both entry and
submit use this branch, total review cost is eight account, eight anchor and four role reads, plus approval and
execution; a return adds four/four/two and no command. This arithmetic never applies to the ordinary branch.
Return compares exact human/target/key and clears confirmation before explicit review. Generic history need not
reveal private organization labels even when current advice is readable. No automatic execution or settlement runs.

## Create organization

Protect nonblank handles and unresolved creation with Stay/Leave and an unload warning; current refusal or loss of session authority retires controls but preserves the earlier unknown attempt and its departure protection. Only a known first mounted refusal releases its continuation; restored hints are conservatively unresolved, regardless of their submitted marker.

`/organizations/new` reads the current session and asks for one handle. An unavailable initial read offers a read-only Retry without discarding the saved draft. It applies the same claim rule and
lowercase normalization as sign-up. Creation uses one operation key for the
approve and execute requests. The `organizations` gate is checked by Auth; a closed gate keeps the handle and shows a
localized message without exposing gate details. A 409 says the handle may be taken, leaves it in the field and focuses
it. Handle format guidance appears before entry. Success names `@<handle>` and links to the created organization's
membership page using the native result's account ID and the existing membership-ID validator. A result that cannot
represent that destination keeps the Security fallback. Navigation grants no membership authority; the destination
retains its own current-session and permission checks. Each explicit submission rechecks the initiating account, client
and scopes before and after native work. The first visit reads `/session` once on entry. A command then reads
`/session` once before native approval and once after native work, sends one `/account-operations/approve`, and sends
one `/account-operations/execute`: four requests for the command and five for the initial journey. Approval retains
its existing single same-body retry after an unavailable response, making six requests when that retry is used.
Execution is never automatically retried; an uncertain result stays unknown until the person deliberately retries the
exact admitted operation. A retained-document return and each explicit read Retry make one fresh `/session` read and
zero command requests. They never allocate an operation key or rewrite the saved descriptor. Focus, locale changes and
result acknowledgement make no requests. Return advice uses only the current session and exact pending marker; it
performs no organization lookup, list scan or per-row authority read. Step-up keeps its existing exact-operation reads
after authentication and after the native session observation.

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

membership departure, paging and reload offer Stay/Leave for changed input or unresolved work; Stay preserves the exact review and focus, Leave discards unsent input while retaining dispatched command identity, and authority loss retires private details while keeping the generic unknown and its guard. Restore exact details only after the initiating account explicitly rereads current page advice and the selected reservation. One read-only recovery review is capped at four native requests (session, page session, page, selected member); exact retry rechecks session and selected member before one execute. Reauthentication remains in-page and secrets remain ephemeral.

Mounted membership return keeps the first generic unknown and the latest local interruption or native result,
at most two classifications, independently of current membership. A native acknowledgement is recorded before
readback and survives an unavailable or subsequently changed membership. Matching state, absence and later native
refusal or acknowledgement never erase an earlier unknown. Dismiss history hides presentation only; exact stored
continuations and their native retry gates are unchanged. Ordinary fresh documents make no mounted-history claim.

Authority retirement closes callbacks before a synchronous React commit removes roster identity, exact review,
confirmation and authentication inputs from the DOM, including before a cached page snapshot. A retained unknown
uses only the installed exact continuation. Return and visible read Retry create fresh read generations; released
older reads cannot repopulate private content. Current membership has its own heading and read-only refresh.
Stay preserves a current review; Leave discards an unsent review and retains a dispatched marker.

One ordinary entry, restored ordinary page or explicit refresh uses at most three native requests: route session,
page preparation session and one bounded page (up to 20 holders). An unresolved restored document reads only the
route session until explicit review. A mounted known acknowledgement adds at most one selected-member read to
ordinary refresh (four calls total), retaining the original submitted marker until its existing observed-close rule
allows clearing it. One explicit recovery review still uses at most four native requests: session,
page preparation session, bounded page and selected membership. Selection adds one selected-member point read.
A fresh submit uses session, selected-member preparation, approval and execute (four), then selected readback and
page preparation/session plus page (three); exact retry uses session, selected-member preparation and execute
(three), then those same three observation requests. Reauthentication uses sign-in and session (two), followed by
the existing explicit review. Local history, retirement, dismissal and focus add zero calls; there is no scan,
refill, polling, per-row authorization or automatic command on restoration, Retry or locale change.

## Operator transfer

Imported transfer data follows the [Accounts operator contract](../../docs/accounts.md#2-operators-and-automated-accounts);
destination presentation cannot establish source approval or execution.

Operator-transfer read failures offer Retry within the mounted page. A failed session read preserves the saved
attempt without treating it as an account mismatch; recovery restores it only for its initiating account and requires
fresh confirmation. Signed-out or changed accounts cannot act on it. Relation retries repeat only the failed read;
after a submit failure, Retry reads the current relationship and leaves approval/execution in the original explicit
reconciliation flow, retaining the request, operation key and references. If native execution may have occurred, its
generic unresolved notice and Stay/Leave protection survive authority retirement and cached-page return. A current
relationship observation never attributes that relationship to the earlier operation; an exact retry remains a
separate, freshly reviewed and explicitly confirmed action using the retained descriptor.

Retirement invalidates operation/read and file generations before synchronously removing private identity, review,
credentials, handoff, references, relation and native advice from the DOM. Generic mounted history retains the first
unresolved source execution plus the latest local review/outcome (at most two classifications), without identifiers,
timestamps or account binding. Known source acknowledgement survives matching, failed and conflicting readback,
missing/invalid/replaced storage and cached return. Destination acceptance is not source execution. A later
acknowledgement, refusal or current relation never settles an earlier unknown send. Dismissal clears presentation
only; exact descriptors and submitted markers remain under their installed ownership. Ordinary documents without
saved evidence make no historical claim.

Decision: visible current-state Retry after retirement opens a fresh bounded read lifetime using current management
session/readiness and the exact saved descriptor; it never reuses a retired callback. Missing, invalid or replaced
continuation cannot reconstruct private credentials or enable a replacement operation. A same-account descriptor
still requires matching native advice and a separate human confirmation for its exact next command.

An explicit current-state recovery action is bounded to one existing `/session` binding and one operator-transfer review
request (2 Auth requests total), with zero approve or execute requests. Source execution uncertainty and acknowledged
readback recovery read only the current relation; destination acceptance recovery rereads only destination advice.
Unavailable reads can be retried deliberately. Entry costs one session binding plus one readiness request when
an initial session is supplied, or two session reads plus readiness otherwise. Restoring an approval-stage descriptor
adds one session binding and one selected native advice request. Cached return and retired Retry use fresh session,
readiness and selected recovery: at most five Auth requests (three session reads, readiness, selected review).
An active relation/advice Retry costs two Auth requests. Each native transfer-review request retains its ten-second
whole-call bound, including authentication and at most two selected relation reads; source preparation uses the same
session/selected-source pair and allocates one local operation key, and destination import review uses one
session/selected-destination pair. Browser transport retains
its five-second bound through response-body completion. There is no list scan, refill, per-row authorization, polling,
file replay, operation allocation, approval or execution in return/read Retry. Native command retries retain their
original tuple, reference, operation key, deadlines, relation lock and explicit current-authorized confirmation.

Departure protects meaningful input and unresolved review with Stay/Leave; only a review created here and never
submitted is discarded, while restored attempts are conservatively retained because approval may already have reached
native. Caller replacement and permission loss retire local authority without prompting away an unresolved send.

## Rename account

Rename review belongs to the mounted page and its native source. A definitive native execution acknowledgement
and a current handle observation are separate facts. Observing the desired handle after an unknown send never
claims success or consumes its descriptor. An explicit exact retry can submit only the original key and operation;
native approval and execution remain authoritative. Acknowledgement with failed or changed readback has its own
notice and offers current review without another command.

retain only a generic mounted outcome classification across authority loss and cached-document return;
keep the admitted original descriptor in its existing storage until definitive acknowledgement, including after
conflict, refusal or account replacement. A replacement viewer cannot review or retry the former account's work.
New input cannot replace unknown work. No history summary is stored in browser storage, URLs, history or cookies.
An ordinary reload without a retained descriptor makes no historical claim.

Refusal, signed-out and management-auth-required states hide all private labels and command controls immediately,
but show unresolved history independently. Current review is explicit and read-only, with visible pending/failure
states and a useful focus destination. Same-account management authentication uses the existing exact continuation
and requires deliberate confirmation on return. References remain in the authorized live attempt only; restoration
never reconstructs a reference or credentials. Expired references require native approval again with the same key.
A newer descriptor or marker cannot be consumed by an older completion.

Page retirement aborts bounded reads, clears private cached DOM and retires callbacks before the next browser stage.
It does not cancel a dispatched native effect. Stay retains current review and focus; Leave preserves unknown history
and its admitted descriptor, without implying cancellation or starting background reconciliation. Known unsent drafts
can be discarded. Focus, language changes and history restoration never retry a command.

`nativeRenameSource` uses one `GET /session` and one cookie-authenticated `POST /account-management/rename-page`
per current review, with the existing finite native projection and `account:update` management profile. Each browser
read has the existing five-second bound, including its body. Entry, cached-document return and explicit read Retry
each cost at most two Auth requests. One explicit command turn costs at most six Auth requests: two current-review
pairs plus at most one approval and one execution. A 409 uses the second pair for current advice instead of readback;
reusing a live reference omits approval. No polling, inventory scan, per-row loop or new native read is added.
Authentication handoff retains its existing sign-in/session costs and adds no rename command on return.

## Operated session opening

Router departure protects nonblank input, prepared review and unresolved opening with Stay/Leave and reload/close warnings; Stay preserves the exact in-memory review and focus, Leave retires callbacks while retaining submitted readback, and fresh-human authentication or invalidated caller authority bypasses the guard.

Read recovery keeps the selected human, subject, operator and original opening key; cached-document return discards private review state and restores only reads from the existing pending descriptor. Submitted openings retain their command for native session readback, and departure retires browser continuations before their next stage.

Cached-document retirement synchronously removes the keyed review before the browser can save it. The bounded generic history stays in mounted memory outside that review; it contains no identity, operation key, labels, scopes, proof, timestamp or payload. Dismissing the summary clears its presentation only. A later acknowledgement or refusal does not settle an earlier unknown opening.

Submitted return and explicit Retry call only `GET /session`. A matching automated session is displayed in a separate current-state region and is labelled as an observation; it does not prove which request created that session. Unknown issuance is never replayed. A new opening uses a fresh human step-up, current metadata, and a new explicit confirmation.

Keep public identity labels explicitly undisclosed under the opening profile; recovery links to `https://rezics.com/{locale}/accounts` and a confirmed operated session can continue to `https://rezics.com/{locale}/`.

## Step-up

A signed-in browser whose session is not fresh enough for `prompt=login` or `max_age` arrives at
`/step-up` with the authorization query, `sig` and `exp`. One sentence explains why confirmation is
needed. The form asks for email (`autocomplete="username"`) and password
(`autocomplete="current-password"`).

Departure is protected when the email has non-whitespace text, the password is nonempty, or a confirmation is pending; leaving clears local input and retires callbacks while any dispatched sign-in continues.

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
use a 1280×900 viewport; login also has one 390×844 light-theme phone image per locale. Pass `--out <directory>` to choose a temporary output directory inside the worktree.

## Development

Shared `authPost` submissions have a five-second deadline (`AUTH_POST_TIMEOUT_MS`), matching existing Auth issuer
transport conventions and covering both connection waiting and JSON consumption. A timeout uses the existing localized
outage state; native writes remain uncertain where their protocol requires readback or exact-command recovery.
A deadline ends browser waiting only; its distinct `timeout` result prevents automatic approval or execution
retries, retaining the original account, operation key and command for explicit recovery.

From this directory, run:

    bun run dev --host 127.0.0.1 --port 4200 --strictPort

The rezics_locale cookie wins when it names a supported locale. Otherwise Auth negotiates the weighted
Accept-Language header and falls back to English.

The real shell offers all supported interface languages by their native names. Selecting a language stages a
choice; Apply changes translated presentation and document `lang`, and Cancel returns focus to the chooser.
The current language remains active until Apply. A blocked cookie shows that the choice lasts only in this
document. Hydration starts from the exact server language without depending on cookie access or writing it again.

Apply interface language in the mounted route through a locale subscription, without navigation or
router invalidation; route component types and keys stay stable, preserving each owner's drafts and attempts.
No account preference, native read, command or authorization URL participates. Paraglide writes only its existing
interface cookie, with its existing scope and lifetime. Restored documents may read a newer supported cookie
without republishing their former choice. Pending local selections are discarded on departure/restoration.
The mounted registration form keeps its challenge language so changing shell presentation does not retire a
Turnstile generation or its token. A new form uses the current interface language.

When AUTH_ORIGIN is set during development, every path outside the six pages and /auth-assets/ is sent to that
origin with its method, path, query, headers and streamed body. Redirects are returned without following them; Auth's
response headers and body pass through unchanged.

Every page is private and not stored, and the frame policy blocks embedding with both frame-ancestors 'none' and
X-Frame-Options: DENY.

## Production routes

The Worker is attached to auth.rezics.com for `/`, `/login`, `/signup`, `/consent`, `/recovery`, `/security`,
`/step-up`, `/account/delete`, `/account/rename`, `/organizations/new`, `/automated/new`, `/automated/open`,
`/organizations/delete`, `/organizations/members`, `/operators/transfer` and the `/auth-assets/*` static asset
prefix. Auth's own issuer endpoints stay on that host without passing through this Worker. Production does not set
`AUTH_ORIGIN`.

## Cost

The static page frames make zero K, D, R and A calls. Development forwarding makes one Auth request per forwarded
request, streams both bodies, and buffers nothing. Both costs are constant per request.
The sign-in page makes one Auth `POST /signin/page` read on entry or BFCache restoration, and one per explicit
Retry or Review current session. Switching alone adds no page read. Review never chains reads or retries authentication. A password
sign-in adds one `POST /signin` and one navigation on success. A passkey sign-in remains two Auth requests and one
navigation on success. The page read adds no kernel calls and carries no preparation token into submission.
Recovery makes no kernel reads and adds one Auth request per submit.
Auth pages make no kernel reads. Step-up is one `POST /signin` per submit.
Sign-up makes no kernel reads. A successful submit is one browser `POST /signup` and one browser `POST /signin`.

### Account home

- **Touches:** one same-origin `POST /account-identity` on entry, explicit Retry or BFCache return; the existing transport deadline is five seconds through response-body validation
- **Bound:** 1 Auth read per entry or renewal, 0 kernel reads and 0 mutations; no inventory reads
- **Growth check:** `tests/account-home.test.tsx`: separate viewers and each explicit renewal own one independent read

### Passkey sign-in

- **Touches:** `POST /signin/passkey/options` and `POST /signin/passkey`; autofill and the button share one set of options
- **Bound:** 2 Auth requests and 0 kernel reads, whatever the number of passkeys the person has
- **Growth check:** `tests/passkeys-cost.test.ts`: a passkey sign-in makes two Auth requests however many passkeys the person has

### Passkey step-up

- **Touches:** the same two requests as a passkey sign-in
- **Bound:** 2 Auth requests and 0 kernel reads
- **Growth check:** `tests/passkeys-cost.test.ts`: a passkey step-up makes two Auth requests however many passkeys the person has

### Interrupted step-up review

- **Touches:** one bounded `POST /recovery/page` per review or Retry; an exact retained account or management continuation adds one bounded `GET /session`. Deliberate Continue repeats those same reads and uses the existing exact local return-marker transition before navigation.
- **Bound:** at most 1 recovery-page read and 1 exact session read per review attempt, 0 kernel reads, 0 authentication or account-command requests. A separate password confirmation uses 1 Auth request; a fresh passkey confirmation uses the existing 2.
- **Recovery:** current advice and exact continuation selectors determine whether Continue is offered. Unavailable, stale or replaced reads never restore former account detail or erase an unknown send.
- **Recovery:** After a failed explicit Continue recheck, fresh authentication stays hidden until deliberate Retry obtains current advice.

### Passkey list

- **Touches:** native `GET /security-page`, with current viewer/advice, at most 64 sessions and 32 passkeys and explicit truncation; direct `GET /passkeys` reviews without completeness stay potentially truncated at 32.
- **Bound:** one bounded native Security read; 0 browser-to-kernel requests; missing/truncated rows do not establish causal enrollment settlement.
- **Growth evidence:** existing passkey cost fixtures cover direct request counts, not the complete mounted/native journey.

### Adding a passkey

- **Touches:** current admitted advice, `POST /passkeys/register/options`, one browser ceremony, `POST /passkeys/register`, then one bounded Security readback after acknowledgement.
- **Bound:** 2 Auth requests for registration plus 1 readback, with any required current-advice/preflight reads counted separately. No replay of the ceremony or registration POST.
- **Qualification:** the original direct two-call cost fixture does not prove this whole mounted flow; inventory is current state, not settlement.

### Removing a passkey

- **Touches:** current `GET /session`, then the existing exact-key `POST /passkeys/remove`; explicit recovery reads one current `GET /security-page` with its native viewer, inventories and advice
- **Bound:** 2 Auth requests for dispatch and 0 kernel reads; an explicit recovery check makes 1 native Security page read and 0 kernel reads
- **Growth check:** the original `tests/passkeys-cost.test.ts` oracle remains unchanged; `test/security-reconciliation.test.ts` covers the focused recovery behavior

### Operated session opening and return

- **Touches:** page entry reads one human `GET /session`; review reads the human session and makes one `POST /account-management/operators/opening-page`. Before confirmation is sent, the page repeats that bounded native point observation, the existing approval stage reads the current human session and makes one `POST /account-operations/approve`, then one `POST /operator-sessions/open` issues the session. The approval reference remains only in the request stack. Submitted return and each explicit current-session Retry make one `GET /session` through `readOpenedSession`.
- **Bound:** a complete opening uses at most 3 `GET /session` reads, 2 bounded opening-page observations, 1 approval request and 1 issuance request; each unsent Retry repeats at most 1 human-session read and 1 opening-page observation. A submitted return or read Retry uses exactly 1 `GET /session` and 0 metadata, approval or issuance calls. Each ordinary focus validation adds at most 1 human-session read. There is no inventory scan, poll or automatic issuance replay. Required fresh sign-in remains the existing native step-up flow.
- **Growth check:** `tests/operator-opening-return-cost.test.ts` verifies one readback request and no approval or issuance; `tests/operator-opening-return.test.tsx` verifies cached return, replacement cookies, released late reads and zero replay after Retry.

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

Automated creation asks Stay/Leave for meaningful input or unresolved review; Leave discards only unsent review, while a tab-local submitted marker preserves the original command for recovery. Caller replacement or permission loss revokes review without prompting.

Opening advice uses a dedicated native management observation; the exact manage-only client keeps identity labels undisclosed instead of acquiring read scope. The read remains advice, never an opening approval.

The Auth host installs `POST /account-management/operators/opening-page` from the native account bindings. Its closed current response identifies the acting human, installed actor target, installed operator kind, reservation/version and supported `opening` action. Missing authority returns refused; missing infrastructure returns unavailable. A single ten-second deadline covers one authentication, two bounded native transfer-state reads and one full-key operator-kind read. The two relation observations must agree. The endpoint performs no command, approval or credential staging; the page consumes one observation and preserves its exact tuple for explicit opening review. Public labels remain undisclosed under the manage-only profile; submission still needs the existing fresh-human approval and opening command.

Step-up rereads the exact retained account or organization operation after authentication and again after native session observation. A replaced, missing or malformed continuation refuses the old return, preserves replacement storage and asks the person to review the action again; authentication does not execute it.

When a cached step-up page returns, its secret-bearing form and credential ceremony retire. The mounted page keeps only a generic unsent, refused, acknowledged or unresolved classification; it uses no browser storage. It reads current step-up advice before offering a deliberate continuation or a separate fresh confirmation. A current actor is an observation, not proof that an earlier request caused it. Review never authenticates, executes the account action or navigates automatically. A replaced or unavailable continuation remains unresolved and can be left without implying cancellation.

Recovery and step-up read `POST /recovery/page` with only `stage` (`start`, `complete` or `step-up`).
The native producer returns installed handler methods, stage actions, native password limits, and whether to return
through sign-in or review after authentication. This is advice, never credential eligibility, proof validity or a
prepared operation. Anonymous reads perform zero account, email, credential or token lookups, even with a signed-in
cookie. The step-up viewer uses the existing authorized exact-self identity read: three fixed human-proof
observations, two full-key client admission seeks and one full-key user seek, with the existing issuance guard.
The complete viewer observation has a three-second deadline and no inventory scan or fan-out. Responses are at
most 4 KiB; the request is the existing bounded JSON body containing one fixed stage. Browser reads have the existing
five-second whole-read bound, including streamed body consumption. Failure is explicitly unavailable with Retry,
never inferred sign-out. Focus or visibility refresh removes old viewer advice; route replacement/departure rejects
late results. Browser WebAuthn support gates the passkey ceremony alongside the installed native method flag.

The existing recovery completion notice is consumed only after current native sign-in advice is ready, so initial sign-in attempt replacement cannot discard it.

### Returning to recovery

The mounted recovery page retains only a fixed start/complete outcome classification: dispatched with unknown
outcome, or acknowledged. It retains no account, email, token, password, payload or reconstructible link. This
summary is never written to storage, a URL, history state or cookies; an ordinary reload makes no historical claim.
Page departure immediately clears the inputs (including detached DOM nodes), retires command callbacks and aborts
advice reads. Leaving cannot cancel a native effect. A retained document first reads current `/recovery/page` advice
before enabling new work. Loading and read failure have visible states, fixed sign-in exits and an explicit read Retry.
Focus moves to the generic return explanation or read result when private controls retire.

A start acknowledgement confirms neither account existence nor mail delivery. An unavailable start response keeps
its outcome unknown. Requesting another link is deliberate new work: the person reviews fresh start advice and
confirms another send. A later refusal or another send's acknowledgement cannot settle an earlier unknown request.
A first definitive refusal still establishes that submission was not executed. Completion retry keeps the exact
original credentials only in its active attempt. After retirement, the fragment and credentials stay cleared;
current advice or a successful sign-in cannot establish what the earlier reset did. Historical uncertainty never
creates the login completion notice. Only native completion acknowledgement uses the existing notice owner.
Stay preserves active work; explicit Leave clears it and warns that a sent request may still finish.

Deliberate fresh recovery opens an empty start form after current start advice, while generic earlier
uncertainty remains visible and independent of the new request.

Whole-call cost: summary capture and display make zero requests. Entry, retained return, focus/visibility refresh,
explicit read Retry and deliberate transition from completion history to a fresh start each make at most one installed
`POST /recovery/page` read (stage only), zero kernel reads and no command. The existing five-second/4 KiB bounds apply.
A start or completion submit makes one existing Auth command request, with no reconciliation read, polling, inventory
scan or speculative retry. Resend confirmation rereads one start advice response; its eventual explicit send makes
one command. Language changes and displaying history make no requests. Read advice is never an execution receipt.
