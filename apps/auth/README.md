# Auth pages

Auth is a TanStack Start app on Cloudflare Workers. Its page frame is served at the unprefixed paths /login, /signup,
/consent, /recovery, /security and /step-up. Each page contains the REZICS brand header and a localized heading.
Paraglide supplies the eight launch locales.

## Sign-in

The sign-in page has labelled email and password fields with password-manager autocomplete. `src/sign-in.ts` holds the
provisional client id (`login`) and scope (`[]`). It uses the shared `src/api.ts` client to send JSON to same-origin
`/signin` with same-origin credentials. The browser supplies the issuer `Origin`; redirects fail closed, and network
failures become an unavailable result.

After successful sign-in, the browser navigates to `/authorize` with the received query, preserving repeated and empty
parameters and removing every `sig`, `exp` and `prompt`. It keeps `max_age`. Without a remaining query it navigates to
`/security`. The response body never supplies a navigation target. Recovery links to `/recovery`; sign-up preserves
the login query.

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

## Sign-up

The sign-up page keeps the query it was opened with. Its sign-in link keeps that same query. The form has a handle,
email and password. Email uses `autocomplete="email"`. Password uses `autocomplete="new-password"` and the shared
in-field show and hide control. Submission validates the handle, email and password. Field errors are tied to their
inputs with `aria-describedby`, and focus moves to the first invalid field.

The page creates one random key for the form and reuses it when a submit is retried after a network failure. It loads
the Turnstile script once and renders the widget explicitly with the public `TURNSTILE_SITE_KEY`, `action: "signup"`
and the page locale. In development, `TURNSTILE_SCRIPT_URL` replaces the script address. The submit button is enabled
before a token arrives; submitting without one shows a localized message beside the widget and sends no request.
While a request is pending, the button shows its loading state. Every request uses a new token, and the widget resets
after every request that does not end in 201.

`POST /signup` sends `{ key, handle, email, password, turnstile_token }` as JSON with same-origin credentials. In
development that POST is forwarded to AUTH_ORIGIN; GET /signup remains this page. A 201 response is `{ accountId }`
and sets no session. The page then signs in with `POST /signin` and resumes with `signInTarget`. Passwords shorter
than 8 or longer than 128 characters are refused before a request. 400
`registration_denied` reports bad input or a refused token. 409 `handle_unavailable` is shown on the handle field.
Any other 409, including an email already in use, shows the same generic message with links to sign in and recovery,
and does not say whether the address exists. 429 includes a valid `Retry-After` duration. 503 and network failures
ask the person to try again later.

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

Signed-out visitors get a link to `/login`. Unknown and first-party clients show a localized not-found message.
Other failures use the shared status-and-code messages, including valid `Retry-After` seconds; Auth body text is
never displayed. Pending approval disables both buttons, and a failure permits retrying.

Page paths render only for GET and HEAD. Other methods, including `POST /consent` and `POST /signup`, pass the
original request through to Auth at the issuer origin in production, or through the existing `AUTH_ORIGIN` proxy in
development. Auth's response returns unchanged, without page headers.

## Security

The security page has Password and Sessions sections in a content column up to 42rem wide. It reads the signed-in
account from `GET /session` and its sessions from one `GET /sessions`, with at most 64 session rows. The view makes no
kernel reads. A password change uses three Auth calls and signing out one session uses one. A signed-out response
offers a link to `/login`.

Password changes accept 8 to 128 characters and use one random key for the staged credential effect: stage, approve,
then apply. A failed network request retries only its step with the same key, and a replayed apply receipt counts as
success. A `step_up_required` response sends the person to `/step-up` with `/security` as the return target and clears
the password field; no password is put in the URL.

Sessions are an item list with separators. A local browser and system map formats recognized user agents as a device;
unrecognized values show a localized unknown-device label, and user agents are never sent elsewhere. The muted
description contains the app name and signed-in and expiry dates formatted for the page locale and time zone. A
response `client_display_name` is used when present; `login` maps to the localized REZICS account name,
`rezics-website` maps to REZICS, and other client ids remain muted monospace. The current session appears first and is
marked This device. Each row offers Sign out with an accessible name containing its device. Signing out asks for
confirmation; another session disappears from the list, while signing out the current session clears its cookie and
sends the person to `/login`. Passkeys are not shown until that feature is available.

## Step-up

A signed-in browser whose session is not fresh enough for `prompt=login` or `max_age` arrives at
`/step-up` with the authorization query, `sig` and `exp`. One sentence explains why confirmation is
needed. The form asks for email (`autocomplete="username"`) and password
(`autocomplete="current-password"`).

`src/step-up.ts` reuses `signIn` and `signInTarget`. Confirmation is one browser `POST /signin` with
the same `client_id` and `scope` as sign-in. On success, Auth replaces the previous session. The
browser then resumes at `/authorize` with that query, removing every `sig`, `exp` and `prompt` and
keeping `max_age`. With no authorization query left, it goes to `/security`. The response body never
supplies a navigation target. Passkey confirmation comes later.

A wrong password, rate limit or outage uses a destructive alert with an icon and title for 401, 429 and 503 and keeps
the person on the page. Submission validates email and password, links field errors to their inputs and focuses the
first invalid field. Password visibility uses the shared in-field control. The submit button stays enabled until a
request is pending and shows its loading state while waiting.

## Screenshots

Run `bun run screenshots` to capture all eight page states in the eight launch locales and both themes. Desktop images
use a 1280×900 viewport; login also has one 390×844 light-theme phone image per locale. By default, images are written
to `.temp/screenshots/auth/` at the repository root. Pass `--out <directory>` to choose another destination.

## Development

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
The sign-in page makes no server reads. A sign-in adds one browser `POST /signin` and one navigation on success.
Recovery makes no kernel reads and adds one Auth request per submit.
Auth pages make no kernel reads. Step-up is one `POST /signin` per submit.
Sign-up makes no kernel reads. A successful submit is one browser `POST /signup` and one browser `POST /signin`.

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
