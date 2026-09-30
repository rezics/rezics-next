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
market and mainland China is out of scope. Birth month and request country are
policy inputs, not age assurance or proof of compliance. Maintain a versioned
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
local classifier ([NSFWJS](https://github.com/infinitered/nsfwjs) or
[OpenNSFW2](https://github.com/bhky/opennsfw2) on CPU) holds likely explicit
images for review; its output is review evidence, not clearance. New accounts
have upload rate limits, and
[Turnstile](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
protects abuse-prone enrollment. Imported covers display with their source
attribution and are removed on a valid notice. A scanner outage holds new
uploads for review instead of disabling media.

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
  search, caches, exports and every Zone. The report route must accept notices
  without an account; today it requires authentication. EU notice-and-action
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
