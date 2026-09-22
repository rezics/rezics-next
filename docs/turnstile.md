# Registration abuse protection

Account registration/recovery endpoints use explicit abuse admission policies:
rate limits, challenge when required and verified proof before the protected effect.
Cloudflare Turnstile is an available integration profile, not authentication or
proof of account ownership.

Bind challenge verification to intended action, allowed origin/hostname and
provider token validity; validate server-side and reject replay/expired/invalid
responses according to the provider contract. Keep secret keys server-only.
Test credentials are admitted only in an explicit development profile and never
accepted as a production configuration shortcut.

Challenge failure preserves safe form input and supports retry without duplicating
account creation. Accessibility, blocked-provider and unavailable-network states
need usable typed outcomes. Select and verify the exact provider integration at
implementation; no widget, hostname or secret is assumed provisioned by this design.
