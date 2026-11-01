# Space setup caller lifetime

The setup page admits one mounted caller for its Space target, signed-in subject, CSRF token, readiness,
locale, and the current QueryClient session source and revision. Every admitted native action closes over that
caller. A session cache write, replacement, readiness change, locale change, source replacement, or unmount retires
its callbacks before queued work or a follow-up read can start. A later caller starts from the route's current
admission state; it does not inherit draft text, resolved choices, expected heads, or an uncertain command from a
retired caller. StrictMode effect replay reconnects the same mounted caller while its earlier work stays retired.
The route loader captures its session-cache tuple and revision before reading the initial snapshot and carries that
admission beside the unchanged snapshot shape through hydration. The page accepts that snapshot only when the
current cache still matches it, then claims it once after commit.

Each explicit write still uses one immutable command at a time. Only an uncertain outcome retains the exact command
and idempotency key for a retry within that caller's lifetime. A successful returned Space, Realm, or Board identity
is applied before the existing bounded refresh, so a failed refresh cannot erase the native result. Conflict and
denial require the existing explicit refresh path. No lifecycle or permission authority is inferred from Context
directory or Board choice display data.

Context exact/current reads and one-page searches are scoped to the mounted picker and its text, head, and source
generation. Board one-page reads are scoped to source, scheme, query, and pager generation; only native-provided
continuation tokens are used. Cancellation retires callbacks even when the native reader cannot cancel its I/O.

`SpaceSetupEntry` observes the existing session QueryClient source and revisions in its private query key and checks
that source again when a read resolves. An old same-account result therefore cannot become visible after CSRF,
readiness, or away-and-back cache changes.

The composition coverage in `apps/web/tests/space-setup-lifetime.test.tsx` is authored for post-integration
acceptance. It is intentionally not a claim that native acceptance has run.
