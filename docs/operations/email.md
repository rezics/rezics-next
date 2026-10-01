# Account email operations

Account sends verification, password reset, email-change and necessary account
notices through SMTP. Main's opted-in topic preferences supply daily digest
intents; Account resolves the current verified address and recorded language.
Only digests are optional. Unsubscribe, hard bounce and complaint suppress the
normalized address's digest purpose; they do not block security or recovery
mail. No marketing mail is enabled.

## Sender setup

Configure the SMTP host, credentials and verified `ACCOUNT_EMAIL_FROM` in
[Account's environment](../../services/account/.env.example). Require STARTTLS
with `ACCOUNT_SMTP_REQUIRE_TLS=true`, or implicit TLS with
`ACCOUNT_SMTP_SECURE=true`; remote plaintext SMTP is rejected. Keep sender and
event-intake secrets outside repository files and logs. Development uses
Mailpit and sends no external mail.

Publish the provider's SPF record for the envelope sender, configure DKIM for
the sender domain and align the visible From domain under DMARC. Inspect actual
received message headers before enabling production delivery; start with DMARC
reporting, then choose enforcement after legitimate senders pass alignment.
Use the public HTTPS Account origin for unsubscribe URLs. Configure the sender
to DKIM-sign both `List-Unsubscribe` and `List-Unsubscribe-Post`, and verify those
headers survive any provider rewriting. These are required by
[RFC 8058](https://www.rfc-editor.org/rfc/rfc8058), beyond merely emitting headers.

## Unsubscribe and suppression

Every digest carries an HMAC-signed URL bound to its user, current mailbox,
digest purpose and issue time. It expires after 180 days. GET returns a
confirmation-required result without changing preferences; the Accounts site
can present that result. POST accepts the RFC 8058 form field
`List-Unsubscribe=One-Click`, using URL-encoded or multipart form data, without
a cookie or account login. Repeated valid POSTs succeed without creating another
suppression. Expired or altered URLs are refused. A link for an old mailbox
does not suppress its replacement.

Suppression is checked before digest intake, during queue insertion and again
under a mailbox lock before SMTP. Digest intake returns `409 mail_suppressed`;
already queued digests expire without sending. A suppression waits for an
already running SMTP call, so its acknowledgement means no later optional
delivery can start. Main retains topic preferences and owns their UI; these
links do not unsubscribe individual topics.

## Provider event wiring

Set a separate `ACCOUNT_MAIL_EVENTS_SECRET` of at least 32 characters to enable
`POST /api/internal/mail-events`; with an empty secret the route is absent.
An authenticated provider adapter verifies its provider's webhook first, maps
hard bounces and complaints to this provider-neutral body, then signs its exact
UTF-8 JSON bytes:

```json
{"source":"smtp-provider","eventId":"unique-event-id","type":"hard_bounce","address":"person@example.com"}
```

`type` is `hard_bounce` or `complaint`; soft bounces are not suppressions. Both
source and event ID are 1–128 characters from letters, digits, underscore,
period, colon and hyphen. Requests are bounded to 4096 bytes. Keep the same
source/event ID on retry, with a fresh timestamp and signature. The receipt and
suppression commit together; duplicate events return 204 without another effect.

Send `X-Rezics-Mail-Timestamp` as Unix seconds and
`X-Rezics-Mail-Signature` as base64url HMAC-SHA256. Derive the signing key with
HMAC-SHA256 keyed by the event secret over `account-mail-events-v1`, then sign
`<timestamp>\n<exact body>`. The exported `mailEventSignature` in
[mail-suppression.ts](../../services/account/src/mail-suppression.ts) implements
this wire format. Signatures more than five minutes from Account's clock are
refused. Never forward unsigned provider callbacks directly to Account.

## Uncertain delivery and review

With `ACCOUNT_DATABASE_URL` set for the correct owner database, run
`task account:mail-report`. It prints the uncertain queue count and suppression
counts grouped by reason, without recipient addresses or decrypted links. It
never resends. A failed or lost SMTP acknowledgement, or a sending row abandoned
for two minutes, becomes uncertain; the encrypted payload is cleared and it
cannot be automatically replayed.

After an outage, check the provider's delivery record and uncertain count before
asking a person to request a fresh security link. Do not reset uncertain rows to
queued. Review suppression evidence with the provider and the person's current
preferences before any manual database correction; never bulk-clear complaints
or unsubscribes. No operator re-subscribe API is implemented. Address changes
leave the old mailbox suppressed and make no assertion of consent for the new
one. Consult [deployment](deployment.md#email-rollout) before rollout.
