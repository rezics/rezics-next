# Trust and safety operations

## Safety and legal readiness

Decision 2, 2026-09-29, revised by the maintainer on 2026-09-30. REZICS Inc, a
US company, operates at zero budget with **minimal compliance by narrowing
scope**: it meets the duties that apply from its first user and opens only what
it can carry. Child exploitation, non-consensual intimate imagery (NCII) and
credible threats are day-one duties; other harms go through reporting, removal
and appeals. A feature whose obligations cannot be met at zero cost stays
closed, such as job-seeker data, reviews of businesses and precise location
histories. User counts and funding do not define legal scope (GDPR, APPI, PIPA
and PDPA apply from the first user), so the earlier "until roughly one million
users or investment" threshold is withdrawn. Counsel, paid scanning and EU
representatives are added when affordable; the EU remains reachable, and
marketing starts in the US and Asian markets. This records accepted risk, not an
exemption from law or evidence that the service is ready.

The launch policy excludes sexually explicit images and advertising trackers.
Minimum age is 13, 14 in South Korea and 16 in the EEA. Sexual and grotesque
adult content are unavailable in South Korea and the UK; the UK is not a target
market and mainland China is out of scope. A declared birth date and request
country are policy inputs, not age assurance or proof of compliance. Maintain a versioned
market/feature matrix covering registration, adult features, privacy, transfers,
analytics and GDPR/DSA representatives; obtain counsel's approval when affordable.
The [legal owner](../legal/README.md) retains the review agenda and policy drafts.

Cover and image uploads open at launch behind free, layered controls, as on
ordinary forums; the maintainer rejected a text-first launch on 2026-09-30.
US law requires reporting known CSAM, not general scanning. The layers:
[Cloudflare CSAM scanning](https://developers.cloudflare.com/cache/reference/csam-scanning/)
checks delivered images from day one; apply for
[PhotoDNA](https://www.microsoft.com/en-us/photodna/faq), free for approved
services, and register with [NCMEC as an electronic service provider](https://ncmec.org/csam),
adding pre-publication matching once approved rather than waiting for it. A
client classifier ([NSFWJS](https://github.com/infinitered/nsfwjs)) supplies
NSFW presentation evidence tied to the exact image. It neither establishes
prohibited content nor grants clearance or creates a review hold. Human label
corrections take precedence; failed or unavailable analysis remains unknown.
The evidence producer can move to the server without changing these meanings.
New accounts have upload rate limits, and
[Turnstile](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
protects abuse-prone enrollment. Imported covers display with their source
attribution and are removed on a valid notice. An NSFW classifier outage permits
manual labeling and does not create a governance hold. Uploads open at launch;
pre-publication safety matching is added once a provider is approved, rather
than waiting for it. `MAIN_REQUIRED_MEDIA_MATCHER` defaults to `none` in every
environment, so unconfigured matching creates no admission job or publication
hold. When matching is configured and fails, new media stays pending and private
to its author until the exact bytes pass; retries after recovery admit the
requested public delivery. This uses a separate required-matcher port and durable
media job, never NSFW evidence or a classifier review hold. Development and tests
may explicitly select `local:<path>` with their own synthetic SHA-256 corpus
(a JSON array of hashes); production refuses this fixture provider. `provider`
requires an approved deployment adapter and remains unavailable until one is
supplied. Actual review holds and removals remain explicit platform decisions.

## Platform suitability moderation setup

Before a responder uses platform suitability assessments, the Access operator
provisions the fixed `governance:platform` scope. Create its `access.scope_gate`
row if absent, and explicitly open both `open` and `dispatch_open` after the
responder is approved. An existing closure requires an operator decision; an
OAuth scope alone does not open this gate.

Grant the approved active Agent `governance.moderate` on that exact scope through
`access.permission_grant`, and give each approved caller's active
`access.principal` a current `access.representation` for the same Agent and
action. Record the granting Agent, caller, expiry and reason in the operator's
provisioning record. Use bounded expiry and revoke the grant or representation
when the responder leaves. Provision while `access.recovery_fence` is open;
recovery holds must not be bypassed. These are Access operator setup steps,
not permissions automatically granted to every registered account.

The caller also needs Account OAuth consent for `governance:decide` and
`work:read`, and permission to read the target. A platform correction uses
`PUT /v1/suitability/{target}` with `basis: platform`, the Agent as
`actingSubject`, the expected revision and an idempotency key. Anonymous and
ordinary batch readers receive the assessment without the assessor's identity;
batch disclosure requires both moderation consent and current platform
authority. The PUT result retains the assessor for the caller's confirmation.

For the loopback development fixture, `task dev:seed` creates the platform gate
and grants eight-hour moderation authority to the first demo owner's Agent,
with representations for that owner and the fixture operator. Repeated runs
reuse current grants. The seed refuses a closed admission or dispatch gate and
a recovery hold; it never reopens them. Production operators provision their
approved responders explicitly rather than running the demo seed.

The manager's 2026-10-01 suitability decision admits unassessed content on share
previews, email and push as well as reads and indexing. Show **Not assessed**
wherever its assessment is shown, and keep it separate from general counts.
Without age evidence, `r15`, `r18` and `r18g` remain gated; admission of unassessed
content does not establish an age or supply an adult opt-in. The shared
[suitability policy](../contracts/classification-judgments.md#suitability-and-disclosure)
also applies to derivatives and delivery channels.

Maintainer revision, 2026-10-01: offer General, R15, R18 and R18G as separate
content settings instead of permanently withholding every restricted category.
General defaults on without an age check. Restricted settings ask for a missing
complete birth date when enabled; R15 defaults on when another flow records an
eligible birthday unless explicitly disabled, and each adult category requires
its own opt-in. Birthdays default private, with a separate explicit publication
choice. Registration need not collect the date; applicable account minimums and
parental-involvement requirements still need an admission path, including when
age becomes known later. The prior no-age-evidence launch decision is superseded.

The Account settings API, Main viewing state and Accounts UI apply these choices
together. Ordinary interactive APIs return Access-authorized content with its
assessments; the frontend checks current preferences before rendering each body
or image. Ratings do not deny Access, propagate through an entire reference tree
or suppress unrelated general text. Noninteractive preview, indexing, email and
push retain their explicit default policies. NSFW masking defaults on and is
independent of category opt-ins and author concealment. Adult text requires a supported market and its
individual opt-in; KR and GB adult categories remain unavailable, mainland
China registration is unavailable, and unknown markets cannot enable adults. Self-declaration is not automatically
sufficient for every content type or country: record which representations and
markets it can admit, and require stronger assurance where applicable before
opening those features. A catalogue rating does not authorize explicit imagery;
the existing prohibition and market restrictions remain applicable. The
[Account owner](../services/account.md#birth-date-and-content-preferences) and
[frontend direction](../plan/frontend.md#accounts-site) record the adopted
flow and privacy boundary, without claiming it has shipped.

## Intake, response and recovery

Before registration opens, name a primary and backup responder, test the public
reporting route without an account and from a suspended account, and verify
deadline alerts. Safety correspondence has its own inbox, independent of optional
notifications. Platform and Realm jurisdiction remain distinct; a Realm cannot
weaken platform restrictions. The [governance owner](../contracts/content-governance.md)
carries evidence and effects; these are operating responsibilities:

- Triage child exploitation, NCII and credible threats immediately; restrict
  evidence access and preserve the applicable reporting/preservation record.
  [18 USC §2258A](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title18-section2258A&num=0&edition=prelim)
  governs qualifying US provider reports and preservation; the chosen upload
  matching goes beyond a claim that the statute requires general scanning.
- Track valid NCII requests from receipt; remove the material within 48 hours
  and make reasonable efforts to find and remove known identical copies in that
  period. Cached copies and derivatives are part of the response. The
  [TAKE IT DOWN guidance](https://www.ftc.gov/business-guidance/resources/complying-take-it-down-act)
  supplies the deadline; ordinary appeals cannot delay it.
- Operate DMCA notices, counter-notices and repeat-infringer handling. File and
  renew the designation; the [Copyright Office](https://www.copyright.gov/dmca-directory/faq.html)
  lists a $6 fee and three-year renewal. Registration alone does not establish
  [Section 512](https://www.copyright.gov/512/) eligibility.
- Copyright notices reach the platform, not the neutral wiki toolkit: publish
  the designated agent, restrict expeditiously, handle counter-notices and a
  repeat-infringer policy, and enforce decisions across graph reads, history,
  search, caches, exports and every Zone. Public report intake accepts notices
  without an account and provides private case correspondence. Under
  [17 U.S.C. §512(g)(2)(B)–(C)](https://www.copyright.gov/title17/92chap5.html#512),
  promptly forward a valid counter-notice to the claimant and restore between
  10 and 14 business days after REZICS receives it, unless a qualifying court-filing
  notice stays restoration. Intake records the immutable receipt-based window;
  claimant sending has a separate idempotent receipt and confirmation timestamp.
  If sending remains unconfirmed at the ten-day floor, hold restoration and
  surface the case in the staff due queue and alerts. Delivery retries do not
  reset either deadline. An overlapping active restriction also blocks release;
  staff must resolve overdue delivery and restoration failures, not extend the
  statutory clock. EU notice-and-action
  under the DSA applies from the first EU user, and DSM Article 17's
  new-service regime still requires authorization efforts and notice-based
  removal. Credits naming real people (staff, voice actors) need a privacy
  notice, correction and removal route under GDPR, APPI, PIPA and PDPA.
- Give reasons for enforcement and accessible appeals, retain case
  correspondence and record reversals. Adapt
  [GitHub's CC0 policies](https://github.com/github/site-policy) to actual
  practice. Review [DSA](https://eur-lex.europa.eu/eli/reg/2022/2065/oj/eng)
  and [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) applicability;
  funding and user-count targets do not determine their scope.

Drill missing optional notifications, responder absence, scan failure, identical
copies, appeals and deletion under preservation holds before claiming readiness.
Registration, uploads and public posting can be paused independently while
reporting and recovery remain reachable; [deployment](deployment.md#launch-shape)
owns that launch sequence.

The executable [launch drill declarations](../../scripts/qa/cases/launch-safety.ts)
and [recovery tests](../../tests/qa/fault-recovery/g-744-safety.test.ts) distinguish
deadline tracking from alert delivery, and a private case inbox from safety
email. Responder alerts and mandatory uploader email are separate deliveries.
Keep readiness unclaimed until
SAFETY03, SAFETY07 and SAFETY08 run with production responder configuration and
real delivery. The [security review](security.md#launch-review-2026-10-01)
records the reviewed source and release-image limitation.

The focused [launch image drill](../../tests/qa/integration/safety-launch-drill.test.ts)
uses isolated owner databases, real Account assertions, local mail transport and
synthetic PNG bytes. It checks account-free and suspended intake/correspondence,
denied upload authority, suppression during interrupted owner effects, deadline
tracking until confirmation, primary and backup mail, active responder absence,
and configured matcher outage/recovery. This fixture evidence does not establish
production delivery, scanner coverage, responder availability or registration.
For NCII decisions, original suppression and the exact-byte digest fence commit
together. Existing and later identical copies lose delivery immediately even
when their bounded history updates or the owner acknowledgement remain pending.

Before opening, retain the actual deployment inputs and receipts:

- Appoint the approved primary and backup; record their distinct Account
  subjects, issuer, verified addresses, mail languages, and current platform
  moderation/evidence grants and representations. The backup appointment
  remains missing; neither a fixture subject nor a successful local drill fills it.
- Supply the real SMTP provider/account and host, port, TLS, authentication
  secret references and sender. Retain the domain authentication and received
  mail evidence required by the [email procedure](email.md), Main confidential
  client configuration and retained erasure relay, and real SAFETY03/07/08
  receipts. `queued`, `uncertain` and SMTP acceptance without human engagement
  remain distinct outcomes.
- Record the actual Cloudflare account/zone, enabled scanning and monitored
  detection inbox, with evidence for original, rendition, imported-cover and
  avatar delivery, caches and origin bypass. Record PhotoDNA application and
  approval status; an approved working adapter is required before selecting
  `MAIN_REQUIRED_MEDIA_MATCHER=provider`. The accepted launch default is `none`;
  the current provider placeholder always fails and local corpora are forbidden
  in production.
- Supply NCMEC electronic-service-provider registration/access and reporting
  custody, plus the actual DMCA designated-agent contact details, covered
  service names, directory link, filing receipt and renewal date from the
  [legal owner](../legal/README.md). The local fixtures supply none of these.

## Deadline alerts and responder absence

Set Main's `SAFETY_PRIMARY_ACCOUNT` and `SAFETY_BACKUP_ACCOUNT` to distinct,
existing active Account subjects at `ACCOUNT_ISSUER`. Neither setting grants
moderation or evidence access: provision the approved responders as above.
Main refuses a partial roster, duplicate subjects, placeholders and missing or
inactive principals. Both unset leaves the job disabled and logs that launch
safety readiness is unclaimed. The maintainer has not named the launch backup;
the [installation procedure](production-install.md#safety-responders) keeps that
appointment explicit.

The notification producer starts from open platform cases and reads each case's
due steps through its case index, excluding completed answers. An accepted,
partial, uncertain or failed answer remains due until every required owner
effect confirms. Cancelled answers remain unresolved. Accepting a plan cannot
stop deadline alerts or remove
the step from the staff due queue. Closed case history
does not enter the deadline scan. Each tick creates up to 32 primary and 32
backup alert records and drains up to 32 durable alert intakes; those are output
bounds, while scan work scales with open cases and their due steps. Each source
statement has a five-second timeout. The safety job runs after the other Access
notification producers and logs failures separately so relay notifications
continue. It alerts the primary two hours before an unanswered platform NCII or
DMCA process deadline.
A current primary case claim acknowledges engagement for its existing
30-minute lease; renew it while working. Thirty minutes after primary alert
intake, no current claim raises a backup alert. An inactive primary raises the
backup alert immediately in the approach window. At the deadline the backup is
alerted even if the primary's claim remains current. Claiming or reading a
notification never answers a legal process step; the owner decision does that.
Resolved, answered or superseded case generations do not deliver stale alerts.

Alerts contain only an opaque alert ID, deadline and escalation reason. The
notification inbox and Account's existing mandatory notice queue bypass optional
notification choices and optional-mail unsubscribe. Account resolves the
verified address and recorded language, encrypts queued mail, and sends through
its configured SMTP transport. The Main HTTP notification provider is not
required for safety email. Retained Account erasure replay is required. Alert
intake is idempotent after restart; Account deduplicates the stable delivery ID
before SMTP.

Inspect the bounded audit view for a case or delivery; retain the receipt with
the drill record:

```sql
SELECT alert_id, step_id, account_subject, responder, reason, due_at,
       intake_state, delivery_id, channel, delivery_state, diagnostic
FROM access.safety_alert_delivery
WHERE case_id = '<case UUID>'
ORDER BY created_at, alert_id;
```

`queued` intake proves durable notification work, not external delivery.
Main records `delivered` only after Account reports SMTP acceptance (`sent`),
not after Account queue intake. It does not prove the responder read the mail.
A lost HTTP acknowledgement is looked up by the same delivery ID on restart.
Account's ambiguous SMTP result remains `uncertain` and is never automatically
resent; inspect Account mail status and contact the backup through the operator's
existing procedure. Expired queued mail is a failed delivery. Missing verified
addresses or language produce a failed intake, never a success. Inspect
`notification_attempt` for transport attempts and the Account row named by
`provider_message_id` for confirmed mail.

The source records are durable while PostgreSQL row leases bound concurrent
queue consumers ([PostgreSQL 18 SELECT](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE)).
SMTP acceptance transfers delivery responsibility to the receiving server,
not proof of human acknowledgement ([RFC 5321 §4.2.5](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.2.5)).
G-917's [integration drills](../../tests/qa/integration/g-917-safety-alerts.test.ts)
exercise deadline boundaries, claim expiry, concurrency, partial intake, restart,
revocation, recovery holds, unsubscribe and unconfirmed SMTP delivery.
