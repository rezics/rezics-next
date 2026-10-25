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

Empty fields and pending requests prevent submission. A refusal keeps the email, clears the password and focuses an
alert: 401 reports incorrect email or password without identifying an account, 429 includes valid `Retry-After`
seconds, and other responses or network failures report an unavailable Auth service.

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

Not built yet.

## Consent

Not built yet.

## Security

The security page reads the signed-in account from `GET /session` and its sessions from `GET /sessions`, with at most
64 session rows. The view makes no kernel reads. A password change uses three Auth calls and a revoke uses one. A
signed-out response offers a link to `/login`.

Password changes accept 8 to 128 characters and use one random key for the staged credential effect: stage, approve,
then apply. A failed network request retries only its step with the same key, and a replayed apply receipt counts as
success. A `step_up_required` response sends the person to `/step-up` with `/security` as the return target and clears
the password field; no password is put in the URL.

Sessions show a readable device when the browser and system are recognized, the client id, and created and expiry
dates formatted for the page locale and time zone. The current session appears first. Revocation asks for confirmation;
revoking another session removes it from the list, while revoking the current session sends the person to `/login`.
Passkeys are not shown until that feature is available.

## Step-up

Not built yet.

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

## Visual check

The /login frame was inspected at 390 px and 1280 px in light and dark themes. The wordmark and heading remain
legible, the brand mark is the only red element, the centered card fits the narrow viewport without horizontal
overflow, and the background and card retain clear contrast in both themes.
