# Email delivery design

Account security/recovery and optional community email have separate purposes,
consent and suppression policies. Email is an asynchronous owner intent with
idempotent delivery, current recipient validation and an explicit uncertain-result
reconciliation path. No documentation task sends real messages.

Account uses Nodemailer SMTP with code-owned English and Simplified Chinese
plain-text/HTML templates. The HTTP process queues encrypted, expiring messages
in PostgreSQL; it never waits for an SMTP server during an authentication request.
The sender checks the committed account before delivery. Signup requires email
verification; changing email confirms the old mailbox before verifying the new
one. Password reset links expire after 30 minutes and consume once.

Configure the `ACCOUNT_SMTP_*` and `ACCOUNT_EMAIL_FROM` variables in
`services/account/.env.example`. Development defaults target Mailpit at
`127.0.0.1:1025`, with its inbox at `http://127.0.0.1:8025`. The deployment must
provide that sink or a verified transactional SMTP sender. Remote SMTP requires
TLS. Integration tests use a local SMTP capture server and never send externally.

SMTP cannot promise exactly-once delivery after a lost acknowledgement. A failed
send or an abandoned sending lease is retained as `uncertain`, with the encrypted
link removed, and is not automatically resent. Inspect counts by state in
`rezics_account_email`; a user can request a fresh link after the rate-limit
window. Provider bounce/complaint processing remains a deployment integration.

Optional notification categories expose user preferences and unsubscribe controls;
security-critical purposes follow their own account policy. Signed preference
links, expiry and one-click subscription handling must be verified against the
elected provider/protocol before rollout. Do not reuse transactional infrastructure
for unselected marketing campaigns.

[Notifications](contracts/notifications.md) owns intent/read state and
[Account](services/account.md) owns security flows. Deployment selects provider,
origins and secret custody without assuming an existing domain setup.
