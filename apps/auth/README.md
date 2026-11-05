# Auth pages

For the complete loopback stack, generated keys, persona and reset command, see
[Local development stack](../../docs/development/local-stack.md). Run `task dev:infra` then `task dev` from the repository root.

Auth is a TanStack Start app on Cloudflare Workers. Its page frame is served at the unprefixed paths /login, /signup,
/consent, /recovery, /security and /step-up. Each page contains the REZICS brand header and a localized heading.
Paraglide supplies the eight launch locales.

Route-error Retry reads the current route again; it never repeats an earlier action. Missing pages keep
browser-document 404 classification and fixed `/login` and `/security` exits. The root provider retires callbacks on
pagehide, history changes and unmount. Cached return enables explicit Retry with generic copy, no
automatic read or reset. Retired completions cannot reset or focus. Successful rendering removes recovery UI; render failure reports in
the layout commit. Only the mounted boundary owns reset. Retry makes one router invalidation filtered to current match IDs: the
whole call includes the installed route chain's loaders and their documented native read bounds below, not a local
state change. Existing deadlines apply. Retirement cancels no native work. Return and reset add zero I/O; no polling or storage.

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

Decision: bound generic operation-key custody to 58,184 UTF-16 code units using existing actor, target, handle and native key limits; refused visible storage blocks command dispatch and remains byte-for-byte intact.

The canonical writer stores `{signature,key}`, where `signature` is JSON for `[actor,operation]` and the 16-byte
generated key is 32 lowercase hexadecimal characters. Actor and delete-target IDs keep their existing 4,096-code-unit
admission bound; organization handles keep the normalized 3–64 ASCII-character contract. The native workflow accepts
opaque operation keys from 1 to 128 code units, so restoration also admits older nonempty keys through 128 without
requiring the generated 32-character spelling. For deletion, an empty-operand envelope contributes 72 code units;
each of the two maximum IDs contributes at most seven after nested JSON string escaping (six inner escaped code units
plus the outer signature-string backslash), and a retained key contributes at most six per code unit. The exact cap
is `72 + 7 × (4,096 + 4,096) + 6 × 128 = 58,184`. The organization envelope with its 64-character handle is
`139 + 7 × 4,096 + 6 × 128 = 29,579`, so deletion sets the shared limit. Both generic storage readers check this raw
UTF-16 length before JSON parsing. A malformed, oversized or unsupported record is unresolved, preserved exactly,
and cannot fall through to a new key or command. A valid retained descriptor keeps its exact key; storage absence or
actual browser-storage unavailability follows the existing mounted memory fallback.

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

Whole-call home cost: rendering, task navigation and language changes make zero home requests. Mount, explicit Retry
or persisted `pageshow` makes one `POST /account-identity` with `{}`. The shared `privateAuthRead` races a single
five-second deadline through headers and body even if transport ignores abort; timeout becomes unavailable with Retry.
The receiver bounds the successful DTO to the native contract's 1,578 UTF-8 bytes before parsing and passes that same
effective read signal through body consumption.
`pagehide` synchronously clears private data and aborts the old generation; source replacement makes one fresh read.
Late results cannot restore identity or focus. There is no polling, automatic retry, inventory fan-out, command prepare,
approval or write. Links have no background preflight, operands or workflow keys. Read Retry focuses current status
without navigation or authentication.

The local guide has phone/desktop and light/dark stories for current identity, missing email, loading, signed-out,
denied, unavailable and current-read replacement. The mounted language chooser updates all guide copy without a reload
or a required preference write. Native/browser and integrated acceptance remain controller-owned.

## Sign-in

Decision: installed password and passkey journeys share `src/sign-in-transport.ts`; only the exact six-field native
SessionProof for the submitted fixed profile and password/passkey method acknowledges authentication. This covers
ordinary login, account-operation step-up, management and rename review, automated-account creation, operator
transfer and organization membership reauthentication. Each HTTP call has one five-second lifetime through fetch
and streamed bounded body completion, including abort-ignoring transports; it preserves same-origin cookies,
no-store and redirect rejection and performs no retry or extra read. Native 429 `authentication_denied` retains
Retry-After; supported older `rate_limited` envelopes remain accepted. A native suspension response is a known
refusal and uses existing credential-denied copy. Lost, malformed or excess replies remain unavailable.

A password attempt still makes one `/signin` POST. Passkey authentication still makes one options POST and one
assertion POST. The validated discoverable options response is shared for four minutes across conditional mediation
and an explicit prompt; failed entries are evicted by identity, and dispatching the assertion consumes the challenge.
Account-operation reauthentication only confirms the existing human/profile and then follows its original review or
return; it never approves or executes the protected command. Mounted return history remains generic and keeps the
first unresolved attempt across later reads or authentication. These installed fixtures do not establish real-browser
or native-authenticator qualification.

The sign-in page first reads `POST /signin/page` with only its current route query; the entered email is never sent to
this read. Auth returns the installed password and passkey methods, the current viewer from the existing native session
authority, and a bounded same-origin continuation. A signed-in visitor sees the account's own email as a private label
and can continue or open the existing sign-in form to switch accounts. A `prompt=login` continuation requires an
interactive sign-in. The projection is advice only; `/authorize` and `/signin` still evaluate the current native
session and request when used.

The page read accepts 4,096 UTF-8 query bytes and returns at most 16 KiB: two fixed method flags, at most one current
viewer and one same-origin continuation, with one exact user-key identity read. It sends no credential inventory
or entered email. Auth/Access failure offers Retry, never inferred sign-out or an empty method list.

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

When authentication has no confirmed response, the page clears the password, removes the old account label and offers
Review current session. The email remains only in mounted component state until review. This makes exactly one bounded
`POST /signin/page` read with the original query. It does not resend authentication. The review explains a changed
account, signed-out state or unavailable observation before another explicit choice. Even a matching account is not
evidence that the uncertain request succeeded. The person may deliberately continue a supported current-session return
or choose credentials again; neither step claims the uncertain request failed or was cancelled. Review clears
credentials, invalidates conditional mediation and never automatically starts another ceremony. No private choice or
credential data survives pagehide; BFCache restoration starts with one fresh native observation.

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
`@simplewebauthn/browser` and the shared bounded sign-in receiver. A "Sign in with a passkey" button asks `POST /signin/passkey/options`
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

The installed command transport accepts only the exact 16-byte `{"success":true}`
acknowledgement or a matching closed native refusal within 33 UTF-8 bytes. It
preserves compatible one-field browser fixtures, uses the existing five-second
POST lifetime through fetch and complete streamed-body parsing, and treats every
unadmitted response or post-dispatch error as unknown. Completion retries keep
the immutable original account, token and password until admitted success or
owned retirement.

Leaving or replacing the recovery journey discards its browser results and private inputs; returning from a cached
document starts a fresh form without retrying a mutation. Departure cannot undo a completed native password change.
an unknown completion retains the original account, token and password only in the mounted attempt; explicit retry sends that exact submission, while restart or departure discards it without asserting cancellation. Definitive first validation refusals allow correction; a later refusal cannot resolve an earlier unknown outcome. Start acknowledgement confirms acceptance only.

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

Decision: recovery advice uses the installed `readJsonBounded` reader with the existing `privateAuthRead` signal; the
native 4 KiB response ceiling, browser five-second whole-call deadline and one-read request cost stay unchanged.
Reader cleanup releases ownership without awaiting stream cancellation.

Decision: recovery commands use exact native envelopes and the existing five-second POST bound; every other response
preserves mounted uncertainty and the original completion input until admitted success or retirement.

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
that POST is forwarded to AUTH_ORIGIN; GET /signup remains this page. Only an admitted exact 201 `{ accountId }`
acknowledgement confirms creation; it sets no session. Creation and automatic sign-in are distinct stages: after acknowledgement the form and
retained creation credentials are cleared, and the page signs in once with the captured email and exact password.
On success it resumes with `signInTarget`. If sign-in fails or its response is uncertain, the created-account panel
and sign-in/recovery links retain the original query; repairing sign-in uses the existing login page and never
repeats creation. `src/sign-in.ts` supplies the shared sign-in result and validated destination helpers (there is no
separate login-attempt helper in this base).
The page starts with one no-store Auth registration read containing the current viewer, native field limits and
available actions. `readRegistrationPage` owns one five-second private-read deadline from before configuration
loading through server-function/BFF completion, even when transport ignores cancellation. Its optional caller signal
retires browser ownership; an already aborted caller starts no work. Rejection, timeout or cancellation returns
dependency unavailable, without retrying or cancelling native work. Each deliberate read has its own lifetime and
no shared advice cache. An already signed-in viewer gets Continue through the existing safe `signInTarget` plus a Sign in
link that replaces the active account; `return_to` remains navigation only. A failed read or missing Turnstile
configuration shows an unavailable state before the form. This read is advice only; `POST /signup` repeats native
validation and verification.
The read costs one existing Turnstile configuration read and one BFF/native `GET /registration-page`, with zero
additional Auth or Kernel calls or commands; the native issuer keeps its own deadline, origin/cookie and no-store rules.
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
Network failures, unread responses and 503 responses stay uncertain. Malformed 201, unsupported 200, extra fields,
invalid IDs and malformed refusal envelopes cannot establish creation or refusal. Native refusal is the exact
`{ error: "registration_denied" }` at 400 or 409, or `{ error: "handle_unavailable" }` at 409. The mounted native
writer has no 429 branch; unsupported rate-limit output stays uncertain without a Retry-After gate.

Decision: registration uses its own closed public projection, with opaque nonempty account IDs of at most 128
UTF-16 units for historical callback hosts; native Access supplies a routed UUID from `registrationTarget(key)`.
The compact success allowance is `16 + 6 * 128 = 784` UTF-8 bytes, including punctuation and worst-case escaping;
the two exact compact refusal envelopes need at most 31 bytes. `readJsonBounded` admits actual streamed bytes
before fatal UTF-8 decoding and JSON parsing; Content-Length cannot enlarge either allowance. One five-second
submission lifetime covers fetch and body completion even when abort is ignored. This adds no native call.
Only the still-owned acknowledged attempt releases its frozen credentials to one existing separate sign-in;
its original destination is captured before submission. Replacement and departure retire old completions.
Focused source/mounted fixtures do not establish native or browser acceptance; broader acceptance is deferred
until integration.

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

Consent outcome explanations live above the keyed private request during the mounted `/consent` route lifetime.
They retain only the first unresolved classification and the latest interruption, acknowledgement, refusal or local
Decline, at most two generic records. Records carry no former account, client, scope, request key, payload, URL or
timestamp. A new acknowledgement explains only its own result; neither it nor a refusal, Decline or current read can
settle an earlier unknown. A fresh document makes no historical assertion without evidence; existing exact-request
uncertainty hints can still require caution when that same request is reopened. History adds no browser persistence.

Each notice can be hidden independently. Hiding is presentation only: it does not cancel, confirm or undo native
work, clear an uncertainty marker, release a pending send, remove required review or change the request's departure
warning. An unrelated current read does not reconstruct a hidden notice. Dismissal focuses the remaining latest
notice, then the earlier notice, then the current review. This focus order keeps keyboard users on retained content.

The current request has its own heading and shows private client/scopes/account only from its exact native review.
Client, scope and invalid-query replacement synchronously retire the previous reader and callbacks during layout
cleanup. Pagehide synchronously clears private DOM before freezing; pageshow reobserves without approving. A retired
approval reply remains unknown even if it later arrives, and cannot clear another attempt's marker. Duplicate client
or scope parameters, including router-normalized arrays, admit no speculative read or decision. Read Retry is query-only, excludes overlapping reads and
provides loading feedback through failed, signed-out and not-found recovery. Pending reduction advice remains
separate from historical uncertainty. Allow requires current native review and deliberate activation; Decline sends
nothing. Protected navigation uses Stay/Leave and unload warnings. Focus moves away from retired private controls to
the generic notice, current review or current error. Fixed exits are exact review sign-in and Security;
no client-supplied redirect is accepted.

Whole-call costs: initial review, each query replacement, each explicit read Retry, focus return after blur and
cached-document restoration perform at most one exact consent GET each (zero if the client is missing or the request
is invalid). `privateAuthRead` owns one five-second deadline through headers, response body and private BFF transport,
and races retirement cancellation even when a transport ignores abort. The existing native currentness boundary
revalidates the session, client and request under issuance/consent locks; the consumer adds no authority mechanism.
Decision: consent review receiving uses the fixed public `@rezics/auth-contract` consent response bounds,
shared with the native closed projection, independently of Security catalogue C and kind-consent's ceiling.
`readConsent` admits bytes through `readJsonBounded` before fatal UTF-8 decoding and JSON parsing. The allowance
counts every closed key and punctuation, all three 1000-entry/128-character OAuth scope arrays, client/account
IDs (1024 UTF-16 units each), nullable display name (100) and email (254), pending state and decisions.
Six bytes per text unit conservatively covers JSON escaping and UTF-8; the requested query's 8192-byte cap can
only reduce the projection. The error allowance comes only from native `authentication_denied` plus optional
`stale_review`. Headers never raise either GET allowance. The reviewed Allow acknowledgement is the closed
`{account_id, client_id, requested, scope}` DTO; native callers without `reviewed_account_id` keep the legacy smaller
`{client_id, scope}` response. Its byte allowance is
`JSON.stringify({account_id:'',client_id:'',requested:[],scope:[]}).length + 12*1024 + 2*(1000*(128+3)-1)`.
The two array terms cover both the reviewed request and the actual submitted union; the union can be larger than the
URL request. Six bytes per UTF-16 unit covers worst-case escaping for both IDs, and OAuth scope syntax is ASCII
without quotes or backslashes. The POST error allowance is
`Math.max(JSON.stringify({error:'authentication_denied'}).length, JSON.stringify({error:'authentication_denied',code:'stale_review'}).length, JSON.stringify({error:'step_up_required',effect_status:'not_applied'}).length, JSON.stringify({error:'account_suspended',code:'ACCOUNT_SUSPENDED'}).length)`.
These are the exact native denial, stale-review, step-up and suspension variants. A 429 uses the generic denial body
where returned; its `Retry-After` header never changes the body allowance.

Both reads and the reviewed POST admit actual streamed bytes before fatal UTF-8 decoding and JSON parsing. Overflow,
invalid UTF-8, malformed JSON, lost bodies and stalled bodies are unavailable; a malformed or excess post-dispatch
reply remains unresolved even when its status is 4xx. A legal acknowledgement must exactly match the frozen reviewed
account, client, request and submitted scope set. Each deliberate Allow performs one five-second bounded POST; its
signal covers headers and body and races a stalled transport. Native currentness and stale-review refusal remain
authoritative. There is no implicit resend, inventory read, marker scan, polling, prefetch or per-permission call.
Repeated activation shares the active read or decision; locale changes, history dismissal, Decline and Stay send zero
decisions and add no reads. Leaving retires browser receiving but cannot cancel native work. Return and Retry send
zero decisions.

Page paths render only for GET and HEAD. Other methods, including `POST /consent` and `POST /signup`, pass the
original request through to Auth at the issuer origin in production, or through the existing `AUTH_ORIGIN` proxy in
development. Auth's response returns unchanged, without page headers.

## Private review reads

Private reads keep one five-second deadline through headers, body and BFF delivery, caller cancellation,
unavailable/Retry, independent inventory availability and generation-based retirement. They never retry writes.

`private-auth-json.ts` counts bytes before retaining chunks, then performs fatal UTF-8 decoding and JSON parsing.
It rejects announced excess, checks dishonest/missing lengths and cancels excess/abort without awaiting cleanup.
Errors disclose no body excerpts. The identity allowance is derived from the native DTO: a 36-byte lowercase UUID,
254 UTF-16 email code units (252 worst-case six-byte JSON escapes plus `@` and `.`), and 28 bytes of fixed JSON syntax,
for 1,578 bytes. It uses the installed `privateAuthRead` signal and five-second whole-call deadline, with no nested
timer or retry. Sign-in keeps its native 16,384-byte allowance, five-second full-call bound and request count: zero
extra requests.

Decision: selected Security inventory and `/session` share trusted `AUTH_SECURITY_SCOPE_CONFIGURATION` and the
existing five-second whole-call signal.

Decision: the human management proof reader is a server function over the same trusted configuration and native
issuer transport. It admits the complete `/session` proof with `securityResponseByteBudgets(C).session` through
`readJsonBounded` before decoding or parsing. The allowance is the closed DTO formula
`O({account_id:S(1024),client_id:S(1024),scope:A(C,S(128)),authn_epoch:17,auth_time:17,amr:A(1,S(15))})`; the
native response section in [services/auth](../../services/auth/README.md#native-private-response-bounds-and-composition)
defines `S`, `A` and `O`. `C` comes only from the mounted native `siteActions` union, including protocol scopes. The
reader keeps one native GET and the existing five-second lifetime, with no retry, discovery or command. Its complete
proof remains advice: exact client, ordered profile scopes, actor, one human `pwd` or `pop` method and ten-minute
freshness still gate the explicit review; native approval remains authority.
Unavailable, invalid or retired advice cannot approve or advance an old return.

The public `@rezics/auth-contract` exports are `securityResponseLimits`, `securityScopeLimit(siteActions?)`,
`securityJsonStringBytes(units)` and `securityResponseByteBudgets(scopeLimit, selectedLimit=20)`. The required,
nonsecret `AUTH_SECURITY_SCOPE_CONFIGURATION` Worker binding is `catalogue:<C>`, where deployment derives
`C=securityScopeLimit(siteActions.keys())` from the same Access `siteActions` map passed to native Auth. Only an
explicit `native-no-catalogue` value selects the native 1,000-scope fallback; a missing, malformed or overflowing
configuration makes dependent reads unavailable. Local `pages` launch derives this value from its actual mounted
Kernel and Access composition. Production deployment supplies it from its own mounted composition, never from the
Web client's requested scopes.

`/clients` and `/consents` each retain one native page read of 20 selected rows. Their BFF admits bytes with
`securityResponseByteBudgets(C, 20).clients` or `.consents` through `readJsonBounded` before UTF-8 decoding and JSON
parsing. The existing `privateAuthRead` five-second deadline reaches the issuer fetch and body reader through the
same BFF request signal; there is no second timer or extra native call. Overflow, malformed input, missing
configuration, a stalled body and retirement are unavailable. 401 remains signed-out, 403 denied, and 400 with a
cursor expired. Exact cursor forwarding and browser history still commit only after an admitted replacement.

Decision: `securityFixedResponseByteBudgets` exposes the native `securityPage`, `passkeys` and
`registrationPage` allowances without C. The production `/security-page`, both `/passkeys` readers and both
`/registration-page` readers (registration advice and password-change limits) use those allowances through
`readJsonBounded` with the BFF request signal through body consumption. This keeps legal escaped maxima while
rejecting overflow before parsing. `/clients` and `/consents` retain their selected-page budgets from trusted C.

`/session` receives `securityResponseByteBudgets(C).session` through `readJsonBounded` before UTF-8 decoding and JSON
parsing. It retains one native `GET /session` per user read, forwards the original cookie only to the configured
issuer and adds no metadata request, SQL read, retry or command. Its full DTO byte formula is
`O({account_id:S(1024),client_id:S(1024),scope:A(C,S(128)),authn_epoch:17,auth_time:17,amr:A(1,S(15))})`, where
`S(n)=2+6n`, `A(k,b)=2+kb+max(0,k−1)`, and
`O(F)=2+Σ(JSON.stringify(key).length+1+F[key])+max(0,|F|−1)`. It includes emitted keys, colons, commas and
maximum safe-integer widths. The reader validates only consumed account/client identifiers and scopes against
`securityResponseLimits.id`, `securityResponseLimits.scope` and C; native proof fields remain native authority. The
same `privateAuthRead` signal bounds issuer headers and body consumption. Missing or malformed trusted configuration,
overflow, a stalled read or retirement remains failure; native 401 remains signed-out.

Together, `/clients`, `/consents`, `/session`, `/security-page`, both `/passkeys` readers and both
`/registration-page` readers are bounded before parsing; public consent approval is separate. The fixed endpoints
use native C-independent budgets, while inventory and session retain the same trusted C composition. Sign-in keeps
its native 16,384-byte allowance, five-second full-call bound and request count: zero extra requests. Browser
parsing/migration and native journey qualification remain separate work.

## Security

The security page has Password, Passkeys, Sessions and Organizations sections, followed by Delete account, in a
content column up to 42rem wide. Organizations links to `/organizations/new`; Delete account explains the result and
links to `/account/delete` with a destructive outline control. It reads the
current viewer, validated session/passkey inventories and per-target action advice from one native `GET /security-page`, through the existing private BFF. The view makes no kernel reads. A password change uses three Auth calls.

Decision: exact-target removal reuses the admitted account-session reader and trusted
`AUTH_SECURITY_SCOPE_CONFIGURATION`; only a complete endpoint-specific native envelope settles a command.

Before dispatch, the BFF calls `readNativeAccountSession` through the existing Security issuer transport, which
forwards the original request cookie and signal to the configured issuer, applies the shared
`catalogue:<C>` or explicit `native-no-catalogue` configuration, and bounds `/session` with
`securityResponseByteBudgets(C).session`. It compares the returned account ID with the original exact target before
sending the existing `{ session_id }` or `{ id }` command once. Missing or invalid configuration/session data is
unavailable before dispatch; a signed-out preflight offers `/login`. No new session/currentness read is added.

The action receiver uses `securityActionResponseByteBudgets.session` and `.passkey`, exact UTF-8 maxima derived from
the native compact envelopes: `max(utf8('{}'), utf8('{"error":"authentication_denied"}'),
utf8('{"error":"authentication_denied","code":"stale_review"}'))` for session revoke; and
`max(utf8('{"success":true}'), utf8('{"error":"step_up_required","effect_status":"not_applied"}'),
utf8('{"error":"credential_effect_denied","effect_status":"not_applied"}'),
utf8('{"error":"authentication_denied"}'))` for passkey removal. It counts streamed bytes before fatal UTF-8 and
JSON parsing. Only `{}` confirms session revoke and only `{ success: true }` confirms passkey removal; extra fields,
malformed/excess/lost bodies and unmatched status/envelope pairs remain unknown. Step-up requires the native 401
`step_up_required/not_applied` envelope; the passkey attempt wrapper's 429 `authentication_denied` is a known
refusal; session unknown/foreign 404 requires `authentication_denied`. The native passkey refusal envelope is
`credential_effect_denied/not_applied`; 409 alone, or that generic envelope, does not identify a last-credential
refusal. Last-credential advice remains in the current Security inventory. Native `Set-Cookie` values are forwarded
unchanged before body receiving; a clearing cookie retires private presentation but never converts unreadable output
into acknowledgement.

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

Retired Security attempts use the mounted generic history. One invocation retains only its original account, kind and
exact id while active; late results cannot confirm a replacement target or republish retired details. A current
inventory proves only current presence or absence, never which earlier action ran. A truncated window cannot prove
absence. Same-account retry needs a fresh native review and confirmation of that same target; Retry itself and
readback send zero removals. Changed authority hides private target data while generic outcome history remains.

Whole-call costs remain bounded: the page uses one native `GET /security-page` read; each action uses one native
`GET /session` preflight and one exact-key removal command (two Auth requests, zero kernel reads); each deliberate
current-state check uses one native Security page read and zero commands. Pagehide, return, focus and notice dismissal
add no Auth or kernel calls, inventory scans or per-row reads.

The browser action wait remains twelve seconds: the sequential five-second native account check and five-second
command, plus two seconds for browser/BFF delivery. The original caller signal spans preflight, command and bounded
body receiving; expiry or abort after the shared issuer transport starts its command fetch is unknown. One invocation
sends at most one command; cancellation cannot undo native work. Target reads use the five-second private-read
deadline even if an injected source or browser transport ignores abort. Retired waits cannot publish or release
another operation.

Passkey enrollment shows options preparation, the browser prompt, registration dispatch, and its confirmed or unknown
result as separate states. Cancelling before dispatch sends no registration request. After dispatch, a lost response or
page departure retains only the attempt identity, initiating account and uncertainty in mounted-page memory; restoration
loads current native advice and requires an explicit bounded passkey review before a new enrollment is available. A
matching name, visible row, empty list or truncated list never settles the earlier write. Finishing review acknowledges
only the inventory shown and does not claim whether that write committed. A blank name receives a browser-and-system
suggestion, which may not identify the saved passkey.

Decision: enrollment review shares the configured account-session receiver (retaining native 403 denial)
and the ordinary inventory's native row parser. Session-before, passkeys and session-after retain the originating
cookie and one `privateAuthRead` five-second lifetime through headers, streamed bodies and delivery. Session bytes
use `securityResponseByteBudgets(C).session` from `AUTH_SECURITY_SCOPE_CONFIGURATION`, never current scopes;
missing or unusable configuration makes review unavailable. Passkeys retain the fixed native byte budget and
32-row limit; identifiers, names, dates and duplicate IDs are admitted at HTTP receiving, then declared fields
alone are projected. Native empty names are legal and use the existing localized display fallback. Failed or changed
final authority publishes no earlier rows. Unavailable review preserves uncertainty and explicit Retry; admitted
same-owner review and deliberate finish preserve original unknown history and never acknowledge the old ceremony.
This keeps exactly `GET /session`, `GET /passkeys`, `GET /session` for successful review, the existing deliberate
finish refresh cost, and zero enrollment, removal, approval or sign-in calls from review, Retry or focus.
Native-browser qualifications remain open.

When the direct passkey review has no explicit completeness flag, a full 32-row result is shown as potentially
truncated because the read is bounded at the native contract limit.

Security departure is protected by any nonempty new password, a nonblank passkey name, or an unresolved operation;
Stay keeps the in-memory review and focus, while Leave clears local authority and drafts without claiming to cancel an
operation already underway. The local two-action alertdialog focuses Stay first, contains Tab/Shift+Tab and
programmatic focus, and makes background controls inert and pointer-inactive. Escape chooses Stay once; only explicit
Leave proceeds. Stay restores a connected enabled initiating control, then the existing recovery/password/passkey
fallback. Close, pagehide and retirement restore prior inert and scroll state without focusing a replacement page.
Long labels wrap and the decision scrolls within the viewport. Session actions use their exact native advice as an
associated explanation, including step-up, last-credential and unavailable advice; an earlier unknown result remains
independent. The installed DTO has no separate unknown-advice value. These presentation paths add exactly zero Auth
or kernel requests, commands, persistence, retries or polling; existing whole-call bounds above remain unchanged.
Reload or close warns while protected. Cached-page return reloads the account,
credential/session lists and both application inventories before enabling their controls.
Only an unresolved destructive target's original account, kind and native id survive in page memory: for the same
account, return requires fresh explicit readback and confirmation; a different account discards that target. Failed
reads offer Reload, ended sessions offer sign-in, and return never replays a credential or consent command.

Owned applications use the existing bounded native clients inventory, independently of granted consents.
Each row shows its exact client identifier, admitted public name or localized unnamed fallback, and native
enabled/disabled state. Local details show all returned configured scope tokens with the existing permission
presentation, including unknown-token wording. These capabilities and ownership are not consent to act as the
viewer or a current native permission decision. Disabled does not assert consent removal, completed erasure or
cancellation. An empty scope list describes only that returned row.

Each accepted page reports its returned row count and presence of a next cursor, never a total. Next, Previous,
Reload current page and Retry this page each perform one bounded `loadInventory('clients', cursor, signal)` read
through the installed BFF and `privateAuthRead`; the existing Origin/cookie checks, native session authority,
owner keyset query, signed cursor validation and 20-row bound retain their costs. Within the existing read-only
transaction, each clients read includes one issuer-client admission query and one ordered owner-page query,
plus BEGIN/COMMIT and the installed human-proof preparation. These mounted read counts do not declare authority
preparation free. No separate preparation or
per-row authority calls are added. Expansion, collapse, copying, focus and locale changes perform zero native reads.
The Security entry/return preparation and other inventory costs below remain additional whole-call terms.

Decision: the Auth BFF uses the shared native `securityResponseLimits.cursor` allowance (8,260 UTF-16 code units);
each selected clients/consents request retains its existing one-native-page read cost.

Replacement reads remove old rows and details while visibly pending. Failed navigation retains its exact intended
cursor/direction for deliberate retry; only an accepted response commits navigation. Reload retains the accepted
cursor, and an expired cursor offers a separate explicit first-page restart. Identifiers and scopes stay selectable
text; deliberate local clipboard copy reports success or failure only within its exact expanded observation.
Lifetime retirement synchronously clears private DOM, details, feedback and cursor-bearing controls. Source replacement,
unmount and late read/clipboard replies cannot restore retired data; fresh reads require the current parent lifetime.
No polling, background prefetch, command or consent-management authority is added. Phone/desktop light/dark stories
and focused mounted tests describe presentation; native/browser and broader acceptance remain controller-owned.

Decision: retain at most the last 32 accepted opaque previous-page targets in mounted memory; drop only the oldest
at the bound, and clear history on an accepted explicit first-page restart or lifetime/source retirement.

Connected-application reviews use one page-local controller and acquire the same write boundary until cancellation or a determinate result. Nonempty reductions carry the exact reviewed grant set to the native writer, which rechecks it under the consent lock before publishing a reduction barrier. If it changed, the page refreshes the current permissions and requires a new explicit decision; it never changes the reduction into Allow or resubmits. Explicit remove-all retains its existing meaning, pending reductions keep their ceiling, and uncertain reductions keep all security writes blocked without replay. Independent owned-client navigation remains available and consent navigation cannot discard a review.

Consent pages replace the previous bounded observation. The visible count describes only the returned page; an empty page can still offer Next, and neither empty nor short results claim an account-wide total. Reload current reads the accepted cursor without changing history. Retry this page repeats the exact failed opaque target and direction. Start from first page is a separate deliberate read; failure preserves cursor history, while acceptance clears it. Next records the formerly accepted target only after success, Previous removes one target only after success, and the mounted stack retains at most 32 previous targets. Each action makes one installed bounded consent-inventory read. Accepted navigation focuses the current heading; a failed read focuses its attached retry. Retirement, source replacement and unmount invalidate the target, cursor history, rows, selection and focus callbacks together.

Decision: keep the accepted consent cursor separate from a failed target, commit Next/Previous history only after success, retain at most 32 opaque previous targets, and expose distinct current reload, failed-target retry and explicit first-page actions.

Decision: connected-application reduction uses the shared native client/scope acknowledgement bound:
`JSON.stringify({client_id:'',scope:[]}).length + 6*1024 + (1000*(128+3)-1)` bytes, independent of catalogue C.
Reviewed counts are admitted before native effects; unreviewed native callers retain compatibility. Remove-all
keeps its empty scope body. The narrow POST admits streamed bytes before fatal UTF-8 and JSON within one five-second
headers/body deadline, including abort-ignoring transports. Retry-After cannot enlarge the error allowance.
Closed status-matched native refusals release the current lease; bare/malformed 4xx, generic 401/404, overflow,
timeout and mismatched success remain unknown. Retirement before send is unsent; after send it cannot cancel native
work or accept a late acknowledgement. The original authority signal follows preflight and receiving.
Connected-application history uses the mounted first-unknown plus latest-review limit. New deliberate review does
not settle an earlier unknown, and retired callbacks cannot replace current review or history.

Connected-application whole-call costs: Security entry and cached-document return each make one bounded `/clients` inventory read and one bounded `/consents` inventory read, at most 20 rows apiece. Each explicit current reload, failed-target retry, first-page action or Next/Previous transition makes one read for that inventory and cursor. A confirmed reduction first reads the same bounded consent page once to recheck the target, pending state and exact current grants. A nonempty retained set then makes one existing exact `GET /consent/<client_id>` review; remove-all makes no consent GET. Each path sends at most one existing `POST /consent`; nonempty reductions include the original `reviewed_scopes`, while remove-all keeps its empty-scope body. Every awaited preflight is followed by the existing operation-currentness check, including the exact consent read, and a final currentness check immediately precedes the POST. The response is classified only from its exact native result; no post-write inventory read settles an unknown. A known `stale_review` refusal permits one bounded current consent-page read and no second command. Return, Retry, pagination, focus, language changes and notice presentation send zero commands. There is no polling, full list scan or per-row authority read.

Decision: password replacement uses closed producer-shaped phase acknowledgements, formula-derived byte limits and
one five-second browser lifetime for each of its three POSTs; retries retain exact phase custody.

Password changes use the current native Auth password limits, shown locally with Unicode character counts and kept
within Auth's storage bounds, and require matching new-password confirmation. Before dispatch, the person reviews the
current account and the native session consequences. Replacing an existing password retires all sessions, including
the current one; adding the first password leaves existing sessions active. Security advice never discloses password-row existence; the review explains both outcomes.

The password wire contracts are exact: stage echoes the original key and subject with an Auth UUID effect reference,
`set-password`, and a lowercase 64-character digest; approval has an Access sealed reference and canonical UTC
millisecond expiry; apply has an Auth UUID receipt and a boolean replay flag. Key and subject echoes use the host's
actual 1,024 UTF-16-unit string admission. Their maximum streamed success bodies are 12,465 bytes for stage, 2,823
for password approval, and 69 for apply; either exact native error body is at most 66 bytes. The password approval
reference is an Access base64url seal plus a dot and 43-character HMAC, at most 2,768 characters from the exact
workflow/operator producer shapes. Stage, approval and apply each use the installed bounded reader before fatal UTF-8
decoding and JSON parsing. Auth checks Access approval output against the stage-purpose bound and canonical UTC
millisecond expiry before projection. Apply carries the reference through its dedicated bounded input unchanged. A
wrong status, extra or duplicate field, excess body, malformed body or lost body cannot
advance a phase. The seven native `credential_effect_denied` status mappings and the `401 step_up_required` mapping
retain their exact `not_applied` marker.

One random operation key and its exact stage, approval and apply bindings stay in mounted page memory. Each POST has
one absolute five-second browser allowance from before fetch through headers and bounded body completion; the three
phases do not share one five-second journey allowance. Each native host request keeps its existing three-second
deadline. A transport failure, timeout or malformed response is phase-specific uncertainty. No phase is retried
automatically. An explicit retry resends only that exact phase payload while current Security advice allows it; a
later refusal or expired approval cannot settle earlier uncertainty. Admitted staging clears the password payload.
Only the original validated apply receipt confirms completion. A confirmed replacement retires the session and the
page offers sign-in with the new password; if that does not work, the existing account-recovery path remains available.
When current advice requires step-up, the page goes to `/step-up?return_to=%2Fsecurity` before sending any
credential-effect request. No password is put in a URL.

Page departure or private-authority retirement captures only the most advanced interrupted phase and whether an
apply receipt was confirmed. Passwords, proof, bindings, references, keys and the former identity are cleared. This
generic history stays in mounted memory through cached-page restoration and cannot be settled by a fresh Security
read. It offers sign-in and account recovery; a fresh password form appears only after explicit acknowledgement of
an earlier unknown result and a current allowed Security review. Exact retry is unavailable after the original
attempt is retired. Review current Security performs no command: it reuses the existing Security page and
password-requirements reads (two Auth reads), current account-identity read, and one bounded first page each for
clients and consents (five reads total). It performs no inventory scan or per-row authority reads. The existing single
Stay/Leave decision remains the only departure choice.

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
asks for confirmation and sends the existing `POST /passkeys/remove` with `{ id }` after the shared bounded
current-account check. Native success revokes all sessions: the page clears private data and requires sign-in. Native
last-credential advice is explicit in the current inventory. Removal refusal returns the fixed
`credential_effect_denied/not_applied` envelope; its generic 409 can also report a stale selected effect, so the BFF
does not classify 409 alone or that shared envelope as proof that this was the last interactive credential.
Registration and removal are credential changes: a 401
`step_up_required` sends the person to `/step-up?return_to=%2Fsecurity`. A dismissed browser prompt is silent. Where the browser has no WebAuthn, saved passkeys and their native removal advice remain visible; only creation is unavailable. A failed inventory shows an alert in its section, never an empty-list claim.

Enrollment preparation and acknowledgement use the shared closed formulas in
`packages/auth-contract/src/passkey-enrollment-response-bounds.ts`; the native producer qualification and supported
options are owned by the Auth service's passkey section. Each options POST keeps `{}`, same-origin cookies, no-store,
redirect rejection and its own five-second lifetime through actual streamed success/error bytes and fatal UTF-8/JSON
decoding, with effective caller cancellation even when transport ignores abort. Preparation issues a challenge;
it is never cached, retried or shared with cached sign-in options. Invalid or excess preparation never opens a prompt.
The existing one registration POST has one five-second lifetime through its bounded 201/error body. The exact native
ID/name/date acknowledgement is validated before confirmation; native null names become the same empty display
label as Security inventory, without substituting the requested/default name. The saved ID remains exact.
Only native `not_applied` refusal or the native pre-dispatch rate-limiter response establishes no effect; HTTP status,
malformed data, overflow, cancellation after dispatch and lost responses alone remain unknown. Observer exceptions
cannot alter dispatch bookkeeping. Before dispatch, cancellation retires preparation or the browser prompt.
The seven supported transport spellings include native absent/empty defaults; other historical/unconfigured producer
values remain unavailable rather than being silently stripped. Formula maxima include escaped labels and all 32
excluded credentials. These byte bounds add parsing only: no inventory refresh, native currentness check or replay.
Mocked receiving and mounted return tests qualify phase/custody behavior, not real browser WebAuthn or native growth;
existing native authenticator tests and integrated real-browser acceptance retain that authority.

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

`/account/delete` reads current advice and session-bound identity through
`POST /account-management/deletion-page`. Ordinary sessions receive authentication-required without private identity
or deletion preparation. Deletion is permanent, signs out everywhere and has no account restore. Review operated
responsibilities, last organization ownership and pending transfers; application/consent inventories cannot establish
eligibility. Native refusal identifies no prerequisite. Operator guidance uses the existing transfer route;
organization ownership uses supported management, with Security as fallback when no trusted selected target exists.

Entry, retained-document return and deliberate read Retry each send one advice POST, with the five-second
private-read lifetime and no automatic retry. Admitted advice mounts one clients and one consents inventory page,
20 rows each; further pages require navigation. Retirement aborts that lifetime and invalidates both inventories.
Return, read Retry, focus, dismissal and navigation send no command or extra session GET.
Advice uses `readJsonBounded` before fatal UTF-8/JSON: `93 + 128×6 + 252×6 + 2 = 2375` bytes for fixed syntax,
account id and email. Existing bounds remain 128 UTF-16 id units and nullable 254-unit email with `@` and `.`.
Native identities outside that browser id contract remain a separate producer/consumer qualification.

Each attempt retains its original account, key and descriptor. Authentication saves an unsent continuation;
only execution dispatch's exact stored `submitted:true` proof permits sending. Older descriptors conservatively
imply submission. Step-up compares human/target/key, refreshes advice, clears confirmation and requires another
explicit choice. Confirmation uses the localized phrase, trimmed, case-insensitive and NFC-normalized. Privacy
contact remains required. Stay preserves confirmation, feedback and focus; Leave retires receiving. Unresolved
sends retain their departure warning independently of current advice; dismissal hides only generic history.

Decision: self-deletion reuses the shared sealed-reference approval contract and admits only exact original
`{accountId}` completion. Every POST has its own five-second headers/body lifetime, including abort-ignoring
transport. `readJsonBounded` rejects raw overflow before fatal UTF-8 decoding and JSON parsing. Approval is exactly
`{reference,expiresAt}`: nonempty sealed ASCII reference up to 4096 units, canonical ISO expiry up to 27 bytes,
usable only before expiry. Its allowance is the empty JSON skeleton plus `6×4096 + 27` bytes, including legal
reference escaping. Execution is exactly `{accountId}`: nonempty opaque id up to 4096 units, original identity
only, empty skeleton plus `6×4096` bytes. Extra fields, expired/incomplete variants and wrong targets cannot acknowledge.
Error bytes are bounded by the larger serialized closed refusal: `{error:account_operation_denied,
effect_status:not_applied}` at 400,401,403,409,413,415,503 or `{error:step_up_required,effect_status:not_applied}`
at 401 (JSON string values). Exact `{error:unavailable}`/503 also fits. Bare statuses/malformed bodies prove nothing.

Lost, timed-out or unreadable execution stays unknown through later refusal, absent account, sign-out, unavailable
advice, dismissal and replacement. Restored submitted hints supply no command evidence. Only original acknowledgement
resolves uncertainty; it survives private retirement as generic completed history, with cleanup/downstream custody
pending. Late results cannot complete replacement views, clear another continuation/key or reveal former identity.
Another deliberate exact retry requires fresh review and typed confirmation; current advice grants no authority.

Submission costs two POSTs normally. Approval retries exact `503 unavailable` once; explicit deletion recovery may
retry execution once while current, preserving its identical key, descriptor and reference. Malformed output,
transport loss, timeout and proven refusal never retry. A later refusal cannot resolve earlier uncertainty.
Thus command cost is at most four POSTs: 10 seconds normally, 20 with both independent retries. Admitted entry adds
one advice and two inventory reads: five requests normally, seven maximum. Each admitted return/read Retry adds
three reads and zero commands; authentication-required advice reads no inventory. Counts are population-independent.
Native costs remain in [Auth](../../services/auth/README.md#personal-account-deletion-review). Fixtures prove mechanical
custody only; integrated native output/replay and browser acceptance remain required.

## Delete organization

`/organizations/delete?organization_id=<UUID>` reviews only the selected organization through the private native
management reader in `organization-deletion.ts`. Its default same-origin POST to
`/account-management/organizations/deletion-review` binds the cookie session server-side with exactly the fixed
`account:delete` profile, returns only the selected organization's id, kind, handle and display name, and verifies
the initiating human. The native management ENTRY deletion authority and the same Auth session are revalidated
after I/O; failures retain the existing localized recovery in all eight locales. Recovery keeps
the selected organization and first discovered initiating human, and clears typed confirmation before each fresh review.
The closed response allowance is 30,946 UTF-8 bytes: the ready JSON skeleton with a UUID36 and 64-character ASCII
handle, plus six bytes per UTF-16 unit for the 1,024-unit opaque SessionProof ID and 4,096-unit display name. Handles
remain nullable and database-limited to 64 lowercase ASCII characters; display names remain nullable and use the
profile writer's 4,096 UTF-16-unit admission limit (the database column is unbounded text, so the native producer
refuses larger output). The browser still admits only lowercase UUID IDs for sessions and descriptors; the larger
native opaque-ID allowance does not widen that established browser rule. The confirmation phrase remains `@handle`,
then display name, then localized fallback, with no truncation.
Submission revalidates the review and uses the installed approval, execution and step-up protocol. Accepted deletion
is distinct from cleanup completion. The browser shares `account-operation-response-bounds.ts`: approval is exactly
`{reference,expiresAt}` with
`DELETION_APPROVAL_MAX_RESPONSE_BYTES = JSON.stringify({reference:'',expiresAt:''}).length + 6 × 4096 + 27`;
execution is exactly `{accountId}` with
`DELETION_EXECUTION_MAX_RESPONSE_BYTES = JSON.stringify({accountId:''}).length + 6 × 4096`. Error receiving uses
`max(JSON.stringify({error:'account_operation_denied',effect_status:'not_applied'}).length,
JSON.stringify({error:'step_up_required',effect_status:'not_applied'}).length)`. References are opaque nonempty strings
up to 4,096 UTF-16 units and expiry must be canonical and still future. Only the exact original `{accountId}` result matching the selected organization
acknowledges this command. Advice, status, malformed output and mismatched identity do not. An acknowledgement means
the native tombstone committed with cleanup pending; it does not claim downstream erasure, backup removal or deletion
of external copies. Uncertain results retain the original human, organization and key through unavailable, missing,
denied and readable current advice, none of which establishes success or permits a fresh deletion.

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

The read-only POST uses `privateAuthRead` and `readJsonBounded`: one five-second browser deadline covers fetch, headers,
and actual streamed success or error bytes before JSON parsing; the mounted reader's abort signal is forwarded and
retired responses are discarded. Step-up and unknown markers retain the closed version-1 descriptor under the existing
keys, capped at 231 raw UTF-16 code units: JSON for human UUID36, organization UUID36, original 32-hex operation key,
version 1, fixed `delete`, and `/organizations/delete`, including keys and punctuation. Oversized or unreadable values
remain invalid and block another deletion. Cleanup rereads and clears only the exact descriptor owned by an established
native acknowledgement or an explicitly abandoned unsent review. Failed bodies, unknown outcomes, sign-in, current
advice, unavailable reads and departure retain the original key and unresolved marker.

After a cached-page return, retain only generic mounted history and wait for a deliberate current review; that read never repeats or settles the deletion request. The page keeps known-unsent, dispatched/unresolved and acknowledged outcomes separate from current organization advice. History contains no identity or operation descriptor. Only the original exact native acknowledgement clears its owned uncertainty descriptor; generic acknowledgement survives private review retirement. A committed tombstone means cleanup pending, not downstream erasure, backup removal or deletion of external copies.

Decision: an original exact `{accountId}` response is the only deletion acknowledgement; current organization advice
remains a separate observation. Entry costs one deletion-review POST. A confirmed submit adds one preflight review,
one approval and one execution (four POSTs through the first attempt); exact unavailable approval and execution
responses may each add one same-body retry, for six POSTs maximum through submit. Each POST has one five-second
headers-and-body lifetime. Cached return retires private advice and waits for a deliberate current review; that read and
each explicit read Retry add one review and zero commands. Focus, history and departure add zero requests. Timeout,
transport loss, malformed output and departure do not retry a command. Step-up returns to deliberate review and typed
confirmation. Every review has before/after actual Auth-session proof. Ordinary live-human advice returns
authentication-required without target, role or permission I/O, and exposes no target detail. An untrusted target/key
survives only as the auth continuation; exact-profile denial remains denial.

The exact admitted profile branch separately composes two native snapshots: four account reads, four partition-anchor
reads and two organization-role reads, plus bounded ENTRY preparations/checks and Auth proofs. If both entry and
submit use this branch, total review cost is eight account, eight anchor and four role reads, plus approval and
execution; a return adds four/four/two and no command. This arithmetic never applies to the ordinary branch.
Return compares exact human/target/key and clears confirmation before explicit review. Generic history need not
reveal private organization labels even when current advice is readable. No automatic execution or settlement runs.

## Create organization

Protect nonblank handles and unresolved creation with Stay/Leave and an unload warning; current refusal or loss of session authority retires controls but preserves the earlier unknown attempt and its departure protection. Only a known first mounted refusal releases its continuation; restored hints are conservatively unresolved, regardless of their submitted marker.

`/organizations/new` reads the current session and asks for one handle, using sign-up's lowercase 3–64 ASCII
claim rule. Unavailable entry offers read-only Retry. Auth retains the organizations exposure gate, fresh-human
proof, exact scope, approval resolution, preparation, uniqueness and native workflow/CAS authority. Success names
`@<handle>` and links to membership only when the native opaque account ID passes the destination's existing
validator; Security remains the fallback. Each deliberate submission preserves the original account/client/profile,
normalized handle, operation key and exact pending descriptor, including the monotone submitted marker before
execution. A refused persistence write sends no execution. Step-up returns for separate deliberate confirmation.

Decision: reuse the installed shared Access approval contract, close organization execution to the actual native
`{ accountId }` result, and retain deliberate execution recovery with generic acknowledgement separate from private
current-read custody. Approval is `{ reference, expiresAt }`: reference is opaque sealed ASCII
base64url body, dot and 43-character MAC, at most 4,096 units; expiry is canonical ISO, at most 27 ASCII units,
and must still be usable before execution. Its producer JSON byte formula is `31 + 4096 + 27 = 4154`.
Execution is exactly one nonempty accountId (at most 4,096 UTF-16 units); worst-case escaping gives
`16 + 6 × 4096 = 24592` bytes, without inventing handle or operation-binding result fields.
Each body is byte-counted by installed `readJsonBounded` before fatal UTF-8 decoding and JSON parsing, independently
of absent or dishonest Content-Length. The closed native errors are `{ error, effect_status: "not_applied" }`:
`step_up_required`/401, `platform_closed`/403, and `account_operation_denied`/400,401,403,409,413,415,503.
The only other supported error is `{ error: "unavailable" }`/503; their maximum closed skeleton is 69 bytes.
Unknown fields, malformed replies, overflow, invalid UTF-8 and lost/stalled replies cannot acknowledge work. After possible execution they preserve unknown history; later refusals cannot erase it.

Each POST keeps its own five-second headers-and-body lifetime, including cancellation-ignoring transports, with
same-origin credentials, no-store and redirect refusal. Page lifetime cancellation reaches existing session reads
and both command phases without an aggregate deadline or new probes. Entry reads session once; each deliberate
command then performs session/approval/execution/final-session: four requests, five with entry. Only the supported
unavailable approval permits one same-body retry (six with entry). Execution never automatically retries, reuses
approval or renews it. Each deliberate same-command retry costs four requests, or five with approval retry.
Read Retry/restoration cost one session read and zero commands; focus/dismissal/locale cost zero. There is no lookup
or scan. Injected fixtures do not grant native/browser/growth acceptance.

The mounted page adopts only a valid current original execution acknowledgement before awaiting final session
observation. It stays busy, clears the form and ends this send; approval alone proves no creation. An unchanged
account/client/scopes proof on both reads admits the private success handle and membership destination, using the
existing membership-ID validator or Security fallback. Failed, signed-out, changed-session or replaced-descriptor
final reads remove private operands and navigation while preserving generic acknowledgement. Adoption cleanup
compares the owned marker, key and draft, so final-read replacement storage survives.

Read Retry/restoration cannot restore private details, settle unknown execution or reopen acknowledged work.
Fresh documents use exact continuations and assert no historical acknowledgement. A retired reply stays unknown, and only acknowledgement of that original operation settles it.
No created-account lookup or persistent completion record is added. Generic history dismissal survives mounted
read Retry/cached return; new acknowledgement reappears as new evidence. Dismissal cannot undo, confirm or authorize
work, remove a marker or release unknown-send exclusion. There is no create-another action here.

Both creation pages retire callbacks on departure/restoration/session replacement and retain original retry operands.
Automated review keeps its exact selected operator. Leaving neither clears unknown work nor reverses creation;
uncertain recovery always requires deliberate confirmation.

## Automated account creation

Decision: derive the closed advice ceiling as 24,969 UTF-8 bytes from ASCII UUID/handle contracts plus worst-case display-name escaping, and derive retained command storage as 51,168 UTF-16 units from the closed marker variants plus worst-case escaping of keys, names and references.

`/automated/new` keeps the existing native operator selection, normalized handle review, confirmation, management-profile sign-in and exact retry flow. Typed operator IDs and returned selected-operator advice are the only operator inputs; the page performs no directory scan or per-row authorization. Each explicit retry and persisted return rechecks the initiating human and rereads current page advice before showing work. Read Retry and restoration never approve or submit a command. Signed-out and unavailable states keep read Retry and fixed Security and Account exits.

The advice page uses UUID IDs (36 ASCII characters), nullable native handles (up to 64 ASCII characters) and nullable display names (up to 4,096 UTF-16 code units). The native handle source permits 1–64 ASCII characters matching `^[a-z0-9][a-z0-9_-]{0,63}$`, including historical punctuation endings; the page's fixed creation rules remain 3–64 characters ending alphanumeric. The Auth projector returns unavailable for over-bound native labels and never truncates. `AUTOMATED_CREATION_PAGE_MAX_RESPONSE_BYTES` is 24,969 UTF-8 bytes: the maximum, over authentication-needed/authenticate, select-operator/select-operator, review/confirm and refused/none, of each closed ASCII JSON skeleton plus 36 ASCII viewer-ID bytes, and for review another 36 ASCII operator-ID bytes, 64 ASCII handle bytes, and six bytes per display-name UTF-16 unit (4,096 maximum). The skeleton includes every key, quote, punctuation mark and fixed rule string. Six bytes per name unit covers JSON escaping and UTF-8, including lone surrogates; nullable values and null operators are no larger than the included maxima.

The current browser UUID admission remains its existing case-insensitive 8-4-4-4-12 hexadecimal shape. Kernel routing requires lowercase UUID-v7/v8 plus the RFC variant nibble, so some browser-admitted selections may still be refused natively. This work does not tighten identifier admission. Native selected labels are bounded from the Access account row contract; `display_name` is an unconstrained database `text` field, so old rows above 4,096 code units remain stored and cause unavailable advice. Native transport tests do not prove database authorization; native and browser acceptance remain controller-owned.

The local attempt reader measures raw `sessionStorage` text in UTF-16 code units and rejects a value above `AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16` (51,168 code units) before `JSON.parse`, without reserializing or copying the excess value. The finite ceiling is the maximum over all four optional reference/submitted marker combinations of the closed JSON skeleton length plus `36 accountId + 2×36 operator IDs + 2×64 ASCII handles + 6×(2×128 operation-key units + 4,096 display-name units + optional 4,096 reference units)`. UUIDs and normalized/native handles are restricted to ASCII by their existing contracts; keys, names and references receive six output units per input UTF-16 unit for worst-case JSON escaping, including lone surrogates. The skeleton includes JSON syntax, quotes, fixed kind and empty registration ID. This preserves worst-case escaping, repeated command keys, and the retained approval reference. Save applies the same parser and ceiling after merging prior reference and monotone submitted state. Invalid, unreadable or unrelated stored data stays untouched and cannot become absence or allocate a fresh key; failed storage writes remain unavailable.

Mounted history contains only generic classifications: the first unresolved possibly-sent creation and the latest review interruption or native acknowledgement, at most two records. It has no account binding, identity, operator, handle, key, reference, credentials, payload or timestamp, and adds no persistence. Current matching advice, missing details and later refusal or acknowledgement never erase an earlier unknown. A native `complete` result records its generic acknowledgement before the independent final caller check; if that check fails, private result details are cleared while the acknowledgement remains. Dismissal clears displayed history only. An ordinary new document makes no historical claim without a submitted continuation.

Pagehide, explicit Leave and authority loss invalidate the current lifetime before a synchronous React commit clears the private account, selected operator, page advice, draft, attempt descriptor, result and credentials from the mounted view. The exact saved native continuation remains under the producer's existing rules; only an exact unsent review may be discarded. A cached page shows generic history and fixed Security and Account exits. Stay retains a current unsent review and restores focus to its prior control.

Whole-call bounds use the installed Auth session and page reads. A successful entry, persisted return or visible Retry uses at most four `GET /session` reads and one bounded `POST /account-management/automated/operator` read (five requests total): the route session, the loader's preflight and postflight sessions, and the route's final caller check. Selecting an operator adds at most three sessions and one selected-operator page read. An explicit submit adds at most four sessions, one `/account-operations/approve` and one `/account-operations/execute`. A fresh creation without step-up is therefore at most eleven sessions, two page reads and two command requests (fifteen Auth requests total). Existing sign-in adds its native `/signin` and six session reads, plus the selected-operator page read; no new preparation or retry behavior is introduced. Each ordinary window-focus validation adds at most one session read. History display, dismissal and retirement add zero requests; there is no polling, list scan, refill or background command.

Automated command receiving consumes only exact producer DTOs. Approval is exactly `{ reference, expiresAt }`: the Access seal and the existing execute input cap the opaque reference at 4,096 characters; `Date.toISOString()` supplies a canonical 24-character expiry, which must still be in the future before execute. Execution acknowledges only an exact `{ accountId }` UUID, bound locally to the current immutable account, operator, handle and key. The approval response ceiling is `UTF8(JSON({ reference: '', expiresAt: '' })) + 6 × 4,096 + 24`, maximized with the closed known-error bodies. Execution uses `UTF8(JSON({ accountId: '' })) + 36`, maximized with the same known errors and `{ error: 'account_operation_unresolved' }`. The execute request reader admits `UTF8(JSON({ operation: { kind: 'automated', registrationId: '', operationKey: '', operatorAccountId: '', handle: '' }, operationKey: '', accountId: '', reference: '' })) + 6 × (4,096 + 2 × 128) + 2 × 36 + 64` bytes, covering the maximum opaque reference, two key copies, UUIDs and normalized handle. Compact skeletons include keys and punctuation; six bytes per reference unit covers worst-case JSON escaping. Responses are byte-counted before fatal UTF-8 decoding and JSON parsing, regardless of `Content-Length`.

Each approval and execution POST has its own five-second lifetime across fetch headers and the bounded body. It keeps same-origin credentials, no-store, redirect refusal and the original request body; the two existing caller-session reads keep their separate five-second budgets. The request sequence and ceiling remain unchanged: one caller check, one `/session`, approval, one `/session`, execute, then the final caller check (four session reads and two commands including the route checks). No deadline restarts after headers, and one command does not consume another command or session-read budget. Exact `401 step_up_required/not_applied` returns to deliberate reauthentication; exact supported approval `403 platform_closed/not_applied` or non-503 `account_operation_denied/not_applied` is a refusal only when there was no earlier uncertain send. A 503, malformed status/body pair, unknown field, oversized or undecodable body, timeout, cancellation or lost reply stays unknown. A newer refusal never erases earlier unknown history.

Only a valid execute acknowledgement adds generic acknowledged history, before the independent final caller check. An admitted acknowledgement survives later session/readback failure as generic history, while created-account details remain visible only while the same current route still owns the original request. Invalid native output and exceptions after workflow dispatch use the unresolved response without `not_applied`; they cannot manufacture a refusal after a possible commit. Retry always obtains current approval for the exact retained request and never reuses, renews or resubmits automatically.

Each operator-page loader call has one five-second `privateAuthRead` lifetime across its installed management-session preflight, bounded page fetch/body and current-session comparison. Its effective signal reaches both session reads and the response stream; an abort-ignoring body cannot publish advice after cancellation or timeout. The loader retains the same two session reads and one POST, exact account/client/ordered-scope/epoch/auth-time/amr comparison, same-origin credentials, no-store and redirect rejection. Success and error bodies use the finite page allowance.

Decision: keep the first unresolved generic unknown beside the latest generic interruption or native acknowledgement; without its exact continuation, an unresolved unknown stays read-only, and dismissal hides mounted presentation only.

Decision: automated command receiving uses closed producer-derived response and execute-request byte budgets, separate five-second request lifetimes and exact original-request acknowledgement; malformed or possibly post-dispatch results stay unresolved.

The browser-return story covers phone 390 and desktop 1280 in light and dark themes. Focused mounted tests cover private retirement, preserved acknowledgement and uncertainty, stale reads, current-read Retry, departure and whole-call request bounds. Browser and native acceptance remain controller-owned and deferred until integration.

Deletion, creation, rename and operator-transfer pages provide a fixed local return to `/security`, including their
loading and refusal states. Query parameters and response text cannot replace that return target. Leaving performs
no cancellation, approval or operation-key cleanup; a submitted or uncertain operation still needs its original
review/reconciliation flow. Completed deletion offers no session-dependent action. Auth bounds the page grid, nested
form/card items and wrapping actions at phone widths without clipping details or focus. Rename confirmation appears
only after a valid handle is entered; password guidance is shown before the Security password field.

Automated creation asks Stay/Leave for meaningful input or unresolved review; Leave discards only unsent review, while a tab-local submitted marker preserves the original command for recovery. Caller replacement or permission loss revokes review without prompting.

## Organization membership

`/organizations/members` reads a dedicated native page bound to the current viewer and organization. Each page shows
at most 20 rows from a bounded candidate seek. Each row shows a disclosed public display name or handle with an
explicit identity fallback, and keeps the account ID behind an explicit disclosure. The viewer's current role and the
page's native per-action advice control which choices are shown. Members never see the owner editor; self-leave appears only when its native advice
allows it, otherwise its absence is explained. A last-owner observation disables the affected owner action with an
explanation. Roster unavailability is displayed separately from a ready empty page, including an empty page with
another page offered. The page reports only its local holder count, never a total. Previous, Next, Reload current
and deliberate First page each use one bounded read after preparation. Opaque cursor spelling and server order
are preserved. Only successful reads move navigation: Next pushes the former target, Previous pops once, Reload
keeps history, and First page clears history only on acceptance. Failed reads retain the exact requested target
for Retry and offer explicit First page. History retains at most 32 targets, never row DTOs; at its oldest retained
target Previous is unavailable and First page remains deliberate. No cursors or rows enter storage, URLs or generic
return history. Private retirement clears rows, disclosure and cursor history synchronously; navigation uses the
existing lifetime to reject delayed replies. Disclosure is local and adds zero reads.

Decision: the exported browser membership read uses `privateAuthRead` with one five-second allowance through
BFF completion, forwarding its effective signal through the installed server-function options. An already-aborted
caller makes zero calls; timeout, cancellation and transport rejection become the existing unavailable result.
The same effective signal covers native session preflight, page headers and both streamed bodies; neither leg renews it. The native page service deadline remains eight seconds. The route aborts local read ownership
on lifetime replacement, private retirement and unmount, retaining generation checks for transports that ignore
abort. Timeout retains the exact organization, initiating account and failed opaque target for deliberate Retry;
only an accepted replacement commits cursor history. This adds no requests, commands or automatic retry and
makes no claim that a dispatched command was cancelled.

Decision: receiving uses the shared fixed closed JSON bounds: roster 97,089 UTF-8 bytes
(`4,929 + 6 × (1,024 + 20 × 512 + 4,096)`) and selected member 200 bytes. The constant
includes JSON punctuation, keys, longest closed variants and ASCII UUIDs. Each row has two
36-character UUID fields and two nullable 256-UTF-16-unit labels; the cursor is 4,096 units.
Native viewer proof identity remains opaque up to the established 1,024-unit session ceiling;
browser selection still requires UUID identity and exact viewer matching. Six bytes per unit
covers worst-case escaping. No label is truncated. Actual bytes, including error bodies, are
counted before JSON parsing regardless of Content-Length. The selected read keeps its exact
POST and result mapping under one five-second whole-call lifetime and installed cancellation.
Refusal adds zero command effects, point reads or implicit retries. Native authority and real
browser transport qualifications remain for integrated acceptance; focused fixtures prove receiving.
Mounted fixtures adapt the predecessor session BFF seam while preserving their native call and custody assertions.

The browser sends only the organization and cursor to Auth. Auth binds the fresh human management proof to the
dedicated Kernel page source. The roster and its action advice are observations only. Before a selected change, the
existing exact member read still supplies reservation/version metadata, then native approval, command authorization,
retry identity and reconciliation remain in force. A stale page cannot authorize a write; after command completion
the route reads the page again so current roles and advice replace old controls. An unavailable dependency never
becomes an empty roster.

Leaving or changing organizations ends pending browser continuations before they can install a review or start
another request. An already dispatched change continues independently; its stored command, exact operands and
original key remain available for explicit confirmation and native reconciliation.

A determinate refusal retains an unsent exact review only while refreshed roster advice and the selected reservation
still admit it. A refused credential attempt does not establish a session: the route rereads the current session and
keeps that review only for its original actor and management profile. Session loss or replacement, refused roster
admission and private retirement hide it. Successful same-actor reauthentication clears credentials, resets confirmation
and reloads roster advice under the installed lifetime; confirmation and submit remain deliberate. It never executes
or replaces an unresolved command.

Membership departure, all page navigation and reload offer Stay/Leave for changed input or unresolved work; Stay preserves the exact review and focus, Leave discards unsent input while retaining dispatched command identity, and authority loss retires private details while keeping the generic unknown and its guard. Restore exact details only after the initiating account explicitly rereads current page advice and the selected reservation. One read-only recovery review is capped at four native requests (session, page session, page, selected member); exact retry rechecks session and selected member before one execute. Reauthentication remains in-page and secrets remain ephemeral.

Decision: approval and execution use the shared bounded account-operation POST receiver, with separate
closed membership parsers and one five-second headers/body allowance per existing POST. Approval's byte
ceiling is `JSON.stringify({ reference: '', expiresAt: '' }).length + 6 × (4,096 + 27)`;
execution's is `JSON.stringify({ accountId: '' }).length + 6 × 4,096`. These cover opaque native
identifiers, supported locator spelling, canonical extended-year ISO dates and JSON escaping;
stored command and roster bounds stay separate. Errors use the shared closed error/effect ceiling.
Only exact selected-member acknowledgement proves this command's success. Closed native
status/error/not-applied refusals describe only this dispatch; malformed, excess, timed-out or
wrong-member execution output remains unknown. Earlier unknown remains independent of a refused exact
retry or later acknowledgement. A replaced stored review cannot be overwritten during approval or
cleared by the original result. Fresh authentication uses the sign-in owner's fixed-profile receiver,
then the existing session observation, resets confirmation and never dispatches membership.

Mounted membership return keeps the first generic unknown and the latest local interruption or native result,
at most two classifications, independently of current membership. A native acknowledgement is recorded before
readback and survives an unavailable or subsequently changed membership. Matching state, absence and later native
refusal or acknowledgement never erase an earlier unknown. Dismiss history hides presentation only; exact stored
continuations and their native retry gates are unchanged. Ordinary fresh documents make no mounted-history claim.

Decision: the maximum canonical membership command descriptor is 49,470 UTF-16 code units, using 36-unit UUIDs, a
32-hex operation key, the longest role and boolean spellings, and both 4,096-code-unit optional text fields escaped
as NULs; reads reject excess input before parsing and leave it stored, while writers use the same ceiling. This adds
no native calls or native cost.

Authority retirement closes callbacks before a synchronous React commit removes roster identity, exact review,
confirmation and authentication inputs from the DOM, including before a cached page snapshot. A retained unknown
uses only the installed exact continuation. Return and visible read Retry create fresh read generations; released
older reads cannot repopulate private content. Current membership has its own heading and read-only refresh.
Stay preserves a current review; Leave discards an unsent review and retains a dispatched marker.

One ordinary entry, restored ordinary page, page transition or explicit refresh uses at most three native requests: route session,
page preparation session and one bounded page (up to 20 holders). An unresolved restored document reads only the
route session until explicit review. A mounted known acknowledgement adds at most one selected-member read to
ordinary refresh (four calls total), retaining the original submitted marker until its existing observed-close rule
allows clearing it. One explicit recovery review still uses at most four native requests: session,
page preparation session, bounded page and selected membership. Selection adds one selected-member point read.
A fresh submit uses session, selected-member preparation, approval and execute (four), then selected readback and
page preparation/session plus page (three); exact retry uses session, selected-member preparation and execute
(three), then those same three observation requests. Successful reauthentication uses sign-in and session (two), followed by
the existing explicit review. Failed unsent reauthentication adds one current-session observation to distinguish a
refused credential from lost authority (at most three requests). Local history, retirement, dismissal and focus add zero calls; there is no scan,
refill, polling, per-row authorization or automatic command on restoration, Retry or locale change.

## Operator transfer

Imported data follows the [Accounts operator contract](../../docs/accounts.md#2-operators-and-automated-accounts).
Destination advice cannot establish source approval or execution.

Decision: the stored attempt envelope is bounded to 54,109 UTF-16 units: nested request 4,096; quoted accountId
770 (128 units); acceptance and reference together 49,156 (4,096 units each at six escaped units per input unit);
outer syntax 87. The separate handoff request limit remains 4,096 units.

Failed reads offer deliberate exact Retry. A failed session read preserves the saved attempt; only its initiating
account may recover it, after fresh confirmation. Signed-out or changed accounts cannot act. Relation Retry repeats
the selected read; submit-failure Retry retains the original tuple, key, references and command stage for separate
explicit reconciliation. A current relation cannot attribute that relation to an earlier operation. Native retries
keep their original deadlines, relation lock and current-authorized confirmation.

Retirement invalidates operation, read and file generations before synchronously removing private identity,
credentials, handoff, references, relation and advice from the DOM. Generic mounted history keeps the first unresolved
source execution and latest review/outcome (at most two classifications), without identifiers, timestamps or account
binding. Acknowledgement survives matching, failed or conflicting readback, missing/invalid/replaced storage and
cached return. Destination acceptance is separate from source execution. Later acknowledgement, refusal or current
advice cannot settle an earlier unknown. Dismissal clears presentation only; exact descriptors and submitted markers
retain their installed ownership. Ordinary documents without saved evidence make no historical claim.

Decision: retired Retry creates a fresh read lifetime with current management session/readiness and the exact saved
descriptor. Missing, invalid or replaced continuation cannot reconstruct credentials or enable a replacement command.
Matching same-account advice still requires separate human confirmation of the exact next command.

Whole-call costs: recovery reads one session binding and one selected review (two Auth requests), with zero commands.
Source uncertainty/acknowledgement recovery reads the relation; destination recovery reads destination advice only.
Entry costs one session plus readiness with a supplied initial session, otherwise two sessions plus readiness.
Restoring approval-stage work adds one session plus selected review. Cached return and retired Retry cost at most
five requests: three sessions, readiness and selected review. Active read Retry costs two requests. Source preparation
uses one session/selected-source pair and allocates one local key; destination import uses one session/selected-
destination pair. Retry after unavailable source preparation reads that relation without allocating a key; new review
requires deliberate preparation. Each native review retains its ten-second deadline and at most two bounded selected
snapshots, including source consistency or destination preparation. No list scan, refill, polling, per-row authority,
file replay, approval or execution is added to return/Retry.

Decision: selected read-only POST uses `privateAuthRead`/`readJsonBounded` and the public `@rezics/auth-contract`
operator-page bounds. Shared fields are UUID36 and canonical nonnegative PostgreSQL bigint decimal19, from Kernel's
closed relation projection; opening owns its separate endpoint allowance. Source costs its empty-field JSON skeleton
plus `3 × 36 + 19`; destination adds 36. Fixed viewer/continuation, stages, actions, quotes and punctuation are counted.
IDs/versions are unescaped ASCII; no arbitrary text or catalogue C enlarges the projection. The error allowance is the
larger refused/refused or ready/unavailable skeleton. Actual bytes are limited before fatal UTF-8 decoding and parsing;
Content-Length cannot raise the limit. One five-second lifetime covers headers/body even when abort is ignored.
Invalid/excess advice becomes unavailable, preserving original handoff, command stage and unknown history for exact
Retry. This adds zero native calls and cannot approve, accept or acknowledge execution. Native/browser acceptance
and broader integration checks remain controller-owned qualifications.

Stay/Leave protects meaningful input and unresolved review. Only a review created here and never submitted is
discarded; restored attempts are retained because approval may already have reached native. Caller replacement and
permission loss retire authority without prompting away an unresolved send.

## Rename account

Rename review belongs to the mounted page and native source. Only a closed native acknowledgement bound to the
original account settles its command. Current desired-handle equality never establishes which execution changed it.
Acknowledgement survives failed/changed readback and retirement during observation; its generic mounted notice
allows explicit current review without another command. Unknown work retains its original key and descriptor after
conflict, refusal or account replacement. New input cannot replace it; another viewer cannot review or retry it.
No outcome history is persisted in storage, URLs, cookies or browser history. Reload without a retained descriptor
makes no historical claim.

Decision: rename uses the public approval/execution DTOs and byte allowances in
`account-operation-response-bounds.ts`. Approval is exactly `{reference,expiresAt}`: Access `workflow-approvals`
seals a base64url body plus a 43-character SHA-256 MAC separated by a dot; the browser keeps references opaque and
passes supported historical forms through unchanged. Native unseal and execute text admission cap references at
4,096 UTF-16 units. Expiry is the producer's canonical `Date.toISOString()` (at most 27 ASCII bytes, including
extended years) and must still be future before execute. The allowance is the closed empty-string JSON skeleton
plus `6 × 4096 + 27`, covering worst-case JSON escaping. References are never assumed UUIDs or parsed for their
internal structure. Only reference and expiry stay in authorized live memory; locally expired references require
deliberate approval again for the same descriptor.

Native rename workflow and replay return exactly `{accountId}`. Its allowance is the closed empty-string skeleton
plus `6 * 4096` bytes, covering worst-case escaping of legal opaque IDs, including lone surrogates. Browser equality
binds it to the original account. Registration `expired`/error objects, extra fields, missing/mismatched IDs and
unreadable projections cannot acknowledge rename. An incompatible native completion projects `{error:'unavailable'}`
with 503, without `not_applied`. Invalid approval projection cannot authorize execute. Other operation shapes stay
unchanged. The fixed error allowance is the maximum serialized length of the closed
`{error:'account_operation_denied',effect_status:'not_applied'}` and
`{error:'step_up_required',effect_status:'not_applied'}` envelopes. The former supports native
400/401/403/409/413/415/503, the latter only 401. Only admitted refusal with existing 401/403/409 handling can reset
an initially unsent command; no later refusal or current conflict erases an earlier unknown execution.

Each approval and execution POST independently retains its existing five-second lifetime through headers and body,
including abort-ignoring transports. Actual bytes pass `readJsonBounded` before fatal UTF-8 decoding and JSON parsing;
Content-Length cannot raise a limit. Malformed/excess/stalled replies are unavailable before execution and unknown
after dispatch. Retirement releases the wait, prevents installing approval or starting the next stage, and cannot
undo native work. The submitted marker is installed at the actual send boundary. Approval resolution, fresh human
proof, exact expectedHandle, management profile, Access preparation, native context deadline and workflow CAS/replay
remain authoritative. No automatic replay, native query, permission or effect is added.

Refused, signed-out and management-auth-required review hides private labels and controls immediately while generic
history remains. Same-account step-up uses the existing exact continuation and requires current advice and separate
confirmation on return. Restoration never reconstructs references or credentials. Stay/Leave is one decision:
Stay preserves review/focus; Leave retires callbacks and private cached DOM while retaining unknown history and its
descriptor. Known unsent drafts can be discarded. Focus, locale changes and cached return never retry commands.

Rename-page retains `RENAME_PAGE_MAX_RESPONSE_BYTES`, independent of scope catalogues. SessionProof `securityId`
allows nonempty opaque IDs up to 1,024 UTF-16 units. The bound includes closed keys/punctuation, two worst-case
escaped identities, nullable ASCII handle64, exact management client/scope, safe-integer epoch/time, one pwd/pop
method and up to eight rename/account:update actions with UUID36 resource IDs and signed safe-integer routes.
Retained actions force both account copies to UUID36; the allowance takes the larger compatible case. Oversized
projected IDs return unavailable without truncation. Each existing read has its five-second body-inclusive lifetime;
native proof revalidation and the three-second native page deadline remain. The preceding common `/session` reader
uses `AUTH_SECURITY_SCOPE_CONFIGURATION` independently, not the rename-page allowance.

The retained command keeps its compatible 4,096-unit opaque account-ID ceiling. Its raw UTF-16 allowance remains
`129 + 2 * 6 * 4096 + 32 + 2 * 64 = 49441`: closed skeleton, two escaped ID copies, generated hex32 key and two
ASCII64 handles (a maximum string exceeds null). Raw excess is refused before parsing/copying; canonical writing
uses the same fields/bound and excludes credentials and references. Absent, valid and refused storage are distinct.
Malformed, excessive, unknown-field or unreadable bytes stay untouched. Refusal/replacement before any later browser
stage leaves review read-only. Cleanup requires the exact original descriptor and submitted marker; unconditional
clear does nothing. Failed writes still permit the exact live send/retry but cannot authorize a handoff. Current
read Retry cannot repair storage or erase unknown work. No storage, modal or queue is added.

`nativeRenameSource` current review costs one `GET /session` plus one cookie-authenticated rename-page POST.
Entry, cached return and read Retry cost two requests and zero commands. A fresh acknowledged turn costs six:
preflight pair, one approval, one execution, observation pair. Unknown execution costs four; exact live-reference
retry costs three while unknown or five when acknowledged. Renewing expired approval adds one. A supported 409
uses the second pair for current advice instead of readback; failed/changed readback adds no probe. Authentication
retains its existing sign-in/session costs and sends no rename command on return. No polling or native read is added.
Focused transport/raw/mounted tests qualify local boundaries; native/browser qualification, broader acceptance and
integration remain pending with the controller. No locale changes.

## Operated session opening

Router departure protects nonblank input, prepared review and unresolved opening with Stay/Leave and reload/close warnings; Stay preserves the exact in-memory review and focus, Leave retires callbacks while retaining submitted readback, and fresh-human authentication or invalidated caller authority bypasses the guard.

Read recovery keeps the selected human, subject, operator and original opening key; cached-document return discards private review state and restores only reads from the existing pending descriptor. Submitted openings retain their command for native session readback, and departure retires browser continuations before their next stage.

Cached-document retirement synchronously removes the keyed review before the browser can save it. The bounded generic history stays in mounted memory outside that review; it contains no identity, operation key, labels, scopes, proof, timestamp or payload. Dismissing the summary clears its presentation only. A later acknowledgement or refusal does not settle an earlier unknown opening.

Submitted return and explicit Retry call only `GET /session`. A matching automated session is displayed in a separate current-state region and is labelled as an observation; it does not prove which request created that session. Unknown issuance is never replayed. A new opening uses a fresh human step-up, current metadata, and a new explicit confirmation.

Decision: opening readback consumes the admitted `trustedSecurityResponseConfiguration` and
`readSecurityIssuerResponse` seam, the same server-only `AUTH_SECURITY_SCOPE_CONFIGURATION` provenance as human
account and selected inventory reads. Before parsing it uses `readJsonBounded` with
`securityResponseByteBudgets(C).session`, then requires the closed operated proof, selected subject, opening client,
one operator AMR, safe nonnegative epoch/time and no future time. Identifier/scope maxima are 1,024/128 UTF-16 units
and C entries; there is no scope-membership requirement. C is the native mounted action/protocol union documented
under [private review reads](#private-review-reads). Missing, malformed or overflowing configuration makes no GET.
A matching current observation and every refused observation leave earlier unknown issuance unresolved.

Decision: Opening approval uses `authPostBounded` with the closed native approval envelope
`ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES = JSON.stringify({ reference: '', expiresAt: '' }).length + 4096 + 27`.
It admits only the exact ASCII base64url reference and canonical ISO expiry before marking submitted. Malformed,
excess or expired approval output sends no issuance request.

Issuance remains one native `POST /operator-sessions/open`, received through the Auth server function so the bound
uses trusted `AUTH_SECURITY_SCOPE_CONFIGURATION` value C and the exact opening profile. The JSON limit is
`max(securityResponseByteBudgets(min(C, managementOperationProfile('opening').scope.length)).session,
ACCOUNT_OPERATION_MAX_ERROR_BYTES)`. It includes punctuation, escaping, opaque native proof IDs (1,024 UTF-16 units),
profile-limited receipt scopes (128 units each), safe numeric fields and the closed operator `amr`. The proof must
match the original subject, exact client and requested scope profile. The displayed scopes remain the native
receipt-bound values. Native `Set-Cookie` values, including cleanup values, are forwarded before body projection and
unchanged. Only `step_up_required/401/not_applied` and `account_operation_denied` with
`400/401/403/409/413/415` plus `not_applied` are refusals; `503/unknown`, a status alone,
malformed/excess output or a mismatched proof stays unknown. Each command POST has one five-second lifetime through
headers and body. A late reply after departure is discarded without restoring the private review; issuance is never
replayed. The `/session` reader above remains a distinct observation consumer and does not settle command outcome.

Opening metadata uses `OPERATOR_OPENING_PAGE_MAX_RESPONSE_BYTES` from the public browser-safe
`operator-page-response-bounds` module before UTF-8 decoding or JSON parsing. Its own C-independent closed envelope
counts the opaque native viewer ID as S(1024), three routed UUID36 IDs, canonical PostgreSQL nonnegative bigint19,
fixed actor/operator kinds, undisclosed profile, opening action and every terminal stage. It does not reuse transfer's
budget or require a UUID human proof. The producer projects selected IDs from the admitted request and bounds
native viewer/relation fields before serialization. Invalid historical projection, streamed overflow, malformed or
retired metadata is unavailable; exact Retry retains its original selection/key and sends no approval or issuance.

Decision: Each explicit opening metadata or session-readback attempt has one five-second private browser-read lifetime through body and BFF completion. Route retirement aborts active reads on pagehide, departure, page replacement and unmount; a deliberate retry receives a fresh lifetime. A timed-out metadata read is unavailable and a timed-out readback remains unknown. The native opening-page service keeps its separate ten-second deadline. Each deliberate readback costs one native GET and zero metadata/mutation calls; no discovery or automatic retry is added. Installed stream, return and lifetime tests cover this seam; broader native/browser qualification remains with the controller.

Keep public identity labels explicitly undisclosed under the opening profile; recovery links to `https://rezics.com/{locale}/accounts` and a confirmed operated session can continue to `https://rezics.com/{locale}/`.

Opening advice uses a dedicated native management observation; the exact manage-only client keeps identity labels undisclosed instead of acquiring read scope. The read remains advice, never an opening approval.

The Auth host installs `POST /account-management/operators/opening-page` from the native account bindings. Its closed current response identifies the acting human, installed actor target, installed operator kind, reservation/version and supported `opening` action. Missing authority returns refused; missing infrastructure returns unavailable. A single ten-second deadline covers one authentication, two bounded native transfer-state reads and one full-key operator-kind read. The two relation observations must agree. The endpoint performs no command, approval or credential staging; the page consumes one observation and preserves its exact tuple for explicit opening review. Public labels remain undisclosed under the manage-only profile; submission still needs the existing fresh-human approval and opening command.

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

Step-up rereads the exact retained account or organization operation after authentication and again after native session observation. A replaced, missing or malformed continuation refuses the old return, preserves replacement storage and asks the person to review the action again; authentication does not execute it.

The management return consumes the full bounded human proof without reducing it to account-session advice. Only the
exact management client, complete ordered profile, selected actor and fresh human method qualify. The original
operation snapshot and `returned` continuation phase remain required through deliberate confirmation and native
approval; a matching observation cannot replace those checks or create approval by itself.

Decision: stored account, management and rename-review envelopes are limited to 65,536, 262,144 and 256 UTF-16 code units (`String.length`), respectively. The account allowance covers both 4,096-code-unit account ID fields at six JSON output code units per input unit plus fixed envelope fields; the management allowance covers the largest closed descriptor with eight 4,096-code-unit strings, worst-case JSON escaping and fixed fields; the UUID-only review envelope fits within 256. The initiating account ID uses the existing 4,096-code-unit native descriptor text ceiling without adding an identifier format rule. Each reader checks the retained string length before `JSON.parse`; malformed or oversized values remain untouched and refuse the old return before session observation or an operation. Account envelopes retain compatibility with a missing optional `submitted` marker and reject unknown outer fields. Writers serialize only closed canonical fields. Account storage access errors remain absent; management and rename-review storage access errors remain invalid.

When a cached step-up page returns, its secret-bearing form and credential ceremony retire. The mounted page keeps only a generic unsent, refused, acknowledged or unresolved classification; it uses no browser storage. It reads current step-up advice before offering a deliberate continuation or a separate fresh confirmation. A current actor is an observation, not proof that an earlier request caused it. Review never authenticates, executes the account action or navigates automatically. A replaced or unavailable continuation remains unresolved and can be left without implying cancellation.

See [Recovery](#recovery) for shared advice and bounds.

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

Static frames make no service calls. Development forwarding streams without buffering: one Auth request per
forwarded request. Auth pages make no kernel calls. Sign-in reads `POST /signin/page` once on entry/BFCache return
or explicit Retry/Review. Switching adds no read; review never retries authentication. Password sign-in adds one
`POST /signin` and navigation; passkey sign-in adds two Auth requests and navigation. No preparation token enters
submission. Recovery and step-up each make one Auth request per submit. Successful sign-up makes one browser
`POST /signup` and one browser `POST /signin`.

### Account home

- **Touches:** one same-origin `POST /account-identity` on entry, explicit Retry or BFCache return; one five-second deadline through body validation, even if transport ignores abort
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
- **Bound:** a complete opening uses at most 3 `GET /session` reads, 2 bounded opening-page observations, 1 approval request and 1 issuance request; finite reply receiving adds no native requests. Each command POST has one five-second allowance through headers/body; each unsent Retry repeats at most 1 human-session read and 1 opening-page observation. A submitted return or read Retry uses exactly 1 `GET /session` and 0 metadata, approval or issuance calls, with one five-second browser read allowance through body/BFF completion. Each ordinary focus validation adds at most 1 human-session read. There is no inventory scan, poll or automatic issuance replay. Required fresh sign-in remains the existing native step-up flow; each native opening-page service read retains its separate ten-second deadline.
- **Growth check:** `tests/operator-session-opening-route.test.tsx` covers exact proof acknowledgement, narrow refusal mapping, bounded/malformed replies and late completion; `tests/operator-opening-return-cost.test.ts` verifies one readback request and no approval or issuance; `tests/operator-opening-return.test.tsx` verifies cached return, replacement cookies and zero replay after Retry. Broader native/browser qualification remains with the controller.

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
