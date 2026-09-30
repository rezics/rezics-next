# Registration abuse protection

Account registration and recovery need explicit abuse admission: bounded
attempts and, when required, a server-verified challenge before the effect.
Account's Cloudflare profile verifies sign-up, password reset requests and
verification email requests through Better Auth's captcha plugin before account
or email effects. The widget sends action `account-enrollment`; the server checks
that action and the hostname of `ACCOUNT_BASE_URL`, as well as provider success.
[Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
rejects invalid, expired and replayed tokens. The secret stays in
`ACCOUNT_TURNSTILE_SECRET_KEY` on the service; the Accounts forms receive only
`ACCOUNT_TURNSTILE_SITE_KEY`. Turnstile is abuse admission, not authentication or
evidence of ownership.

`ACCOUNT_TURNSTILE_MODE=cloudflare` selects the live provider on both the service
and Accounts site. Configure a real secret and site key and register the public
hostname with Cloudflare. A missing site key disables the enrollment widget and
logs its configuration problem on the server. General site configuration, OAuth,
sessions and `/api/auth` proxying do not require a widget key.

Local stacks explicitly set `ACCOUNT_TURNSTILE_MODE=local`. The form supplies
`local:<public-hostname>:account-enrollment`; the service accepts that local proof
without a script download or Siteverify exchange. This predictable verifier is
for offline development and tests only; Account refuses local mode in production.
Without a configured secret, development/test configuration defaults to this
mode. Local seed clients receive the proof through `ACCOUNT_ENROLLMENT_TOKEN`.
Provider behavior tests substitute a local Siteverify HTTP fixture, including
wrong-hostname, wrong-action and unavailable responses.
Provider failure and blocked-network states need typed, accessible retry
outcomes that preserve safe form input without creating a duplicate account.
The enrollment tests include an offline browser journey through the Accounts
proxy. Live provider reachability is an operational check when provisioning a
widget; it is not a prerequisite for local seeding or test execution.
