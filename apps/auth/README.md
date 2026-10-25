# Auth pages

Auth is a TanStack Start app on Cloudflare Workers. Its page frame is served at the unprefixed paths /login, /signup,
/consent, /recovery, /security and /step-up. Each page contains the REZICS brand header and a localized heading.
Paraglide supplies the eight launch locales.

The login page has labelled email and password fields with password-manager autocomplete. It sends JSON to the
same-origin `/signin` endpoint from the browser with same-origin credentials. `src/sign-in.ts` holds the provisional
client id (`login`), scope (`[]`) and parameters dropped when resuming authorization (`sig` and `exp`).

After a successful sign-in, the browser navigates to `/authorize` with the received query, preserving repeated and
empty parameters and removing every `sig` and `exp`. Without a remaining query it navigates to `/security`. The
response body never supplies a navigation target. Recovery links to `/recovery`; sign-up preserves the login query.

Empty fields and pending requests prevent submission. A refusal keeps the email, clears the password and focuses
an alert: 401 reports incorrect email or password without identifying an account, 429 includes valid `Retry-After`
seconds, and other responses or network failures report that sign-in is unavailable.

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
The login page makes no server reads. A sign-in adds one browser `POST /signin` and one navigation on success.

## Visual check

The /login frame was inspected at 390 px and 1280 px in light and dark themes. The wordmark and heading remain
legible, the brand mark is the only red element, the centered card fits the narrow viewport without horizontal
overflow, and the background and card retain clear contrast in both themes.
