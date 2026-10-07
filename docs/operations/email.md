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

### Production inputs and DNS evidence

Before rollout, retain a dated operator record with the provider/account name,
SMTP host/port and TLS mode, credential secret references, verified From address,
actual envelope MAIL FROM/Return-Path domain, outbound IPs or provider SPF include,
DKIM signing domain (`d=`), active selector (`s=`), and provider-issued TXT/CNAME
names and values. Include the DMARC policy domain, policy/report destinations,
event source, authenticated webhook verification method, event-secret reference,
and public HTTPS Account origin. These inputs come from the chosen provider;
there is no production provider or domain selected by this repository. Keep
credentials and event secrets out of this record.

Write the five exact DNS inputs into an operator JSON file, for example
`.temp/mail-domains.json` (replace every example with the provisioned values):

```json
{
  "fromDomain": "accounts.example.com",
  "envelopeDomain": "bounce.example.com",
  "dkimDomain": "example.com",
  "dkimSelector": "transactional",
  "dmarcDomain": "example.com"
}
```

Run `task ops:mail-check -- .temp/mail-domains.json` and retain its JSON result
with the UTC time and resolver environment. It queries TXT at the envelope
domain, `<selector>._domainkey.<dkimDomain>` and `_dmarc.<dmarcDomain>`; normal
DNS resolution follows provider CNAMEs. Use the actual effective DMARC policy
domain: check the From domain first and use its organizational domain only when
the direct record is absent. The checker does not guess a public suffix or
automatically discover an inherited policy.

The three lookups run together with a five-second deadline and bounded answers.
`missing` means no matching record or DNS ENODATA/NXDOMAIN; `invalid` means
duplicate or unusable record structure; `unknown` means DNS failure, timeout,
an oversized answer, an unsupported key type or SPF macros needing provider
evaluation. Every state except `present` exits nonzero. `present` checks basic
record structure and usable RSA/Ed25519 key material, not SPF include/redirect
expansion, sender-IP authorization, reporting destination authorization,
cryptographic message verification or DMARC alignment. Recheck unknown results;
do not treat them as missing and rewrite DNS. Record rules follow
[SPF](https://www.rfc-editor.org/rfc/rfc7208#section-4.5),
[DKIM](https://www.rfc-editor.org/rfc/rfc6376#section-3.6.1),
[RSA key requirements](https://www.rfc-editor.org/rfc/rfc8301#section-3.2),
[Ed25519 keys](https://www.rfc-editor.org/rfc/rfc8463#section-4) and
[DMARC discovery](https://www.rfc-editor.org/rfc/rfc7489#section-6.6.3).

Only after configuration and DNS evidence pass, inspect a separately authorized
provider test message's received `Authentication-Results`, Return-Path and
DKIM-Signature: SPF must authorize the actual sending IP, DKIM must verify, and
DMARC must pass alignment with From. For digests, also retain proof that DKIM
covers both unsubscribe headers. Offline tests send solely to local SMTP fakes;
they cannot establish this production evidence.

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
immediately before SMTP. Suppressed digest intake returns 204 without queuing;
already queued digests expire without sending. No database lock spans SMTP;
suppression that arrives after the final check takes effect on subsequent sends.
Main retains topic preferences and owns their UI; these
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
source/event ID on retry, with a fresh timestamp and signature. The source and
event ID are retained on the suppression record. Suppression is idempotent by
mailbox and purpose; retries return 204 without another effect or timestamp
change. No separate event journal is retained.

Send `X-Rezics-Mail-Timestamp` as Unix seconds and
`X-Rezics-Mail-Signature` as base64url HMAC-SHA256. Derive the signing key with
HMAC-SHA256 keyed by the event secret over `account-mail-events-v1`, then sign
`<timestamp>\n<exact body>`. The exported `mailEventSignature` in
[mail-suppression.ts](../../services/account/src/mail-suppression.ts) implements
this wire format. Signatures more than five minutes from Account's clock are
refused. Never forward unsigned provider callbacks directly to Account.

Rehearse the verified provider mapping with one signed hard-bounce event for a
controlled mailbox: retain its source/event ID, timestamp, HTTP 204 and evidence
that subsequent optional digest intake does not queue mail. Retry the same event
with a fresh signature and verify no additional suppression effect; an altered
body, wrong key or stale timestamp must be refused. Security/recovery mail remains
mandatory. Capture complaint mapping too before enabling that webhook type.

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

The focused offline drill is
`task goal -- test scripts/ops/tests/mail-check.test.ts services/account/tests/production-mail-drill.test.ts`.
It exercises DNS adverse outcomes, local required TLS/authentication, signed
hard-bounce suppression and lost SMTP acknowledgement without a backend or any
external delivery. A passing rehearsal is preparation evidence; production DNS,
provider header and authenticated webhook evidence remain operator inputs.
