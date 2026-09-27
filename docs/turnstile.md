# Registration abuse protection

Account registration and recovery need explicit abuse admission: bounded
attempts and, when required, a server-verified challenge before the effect.
Cloudflare Turnstile is a prospective provider profile, not authentication
or evidence of account ownership. No widget, hostname or secret is provisioned
by this design.

A delivered integration must bind proof to action and allowed hostname,
reject invalid, expired and replayed tokens, and keep secrets server-only.
Test credentials belong only to an explicit development profile.
Provider failure and blocked-network states need typed, accessible retry
outcomes that preserve safe form input without creating a duplicate account.
These requirements remain pending until an Account feature implements and
tests the admission boundary.
