# Trust and safety operations

## Safety and legal readiness

Decision 2, 2026-09-29: the product manager selected the safety scope under
maintainer delegation. The maintainer chose REZICS Inc, a US company, as operator
and a zero-budget launch: no paid counsel or scanning, accepting imperfect
compliance until roughly one million users or investment. Child exploitation,
non-consensual intimate imagery (NCII) and credible threats are day-one duties.
The EU remains reachable while representatives wait for revenue; marketing
starts in the US and Asian markets. This records accepted risk, not an exemption
from law or evidence that the service is ready.

The launch policy excludes sexually explicit images and advertising trackers.
Minimum age is 13, 14 in South Korea and 16 in the EEA. Sexual and grotesque
adult content are unavailable in South Korea and the UK; the UK is not a target
market and mainland China is out of scope. Birth month and request country are
policy inputs, not age assurance or proof of compliance. Maintain a versioned
market/feature matrix covering registration, adult features, privacy, transfers,
analytics and GDPR/DSA representatives; obtain counsel's approval when affordable.
The [legal owner](../legal/README.md) retains the review agenda and policy drafts.

The reason for text-first launch with typographic covers is operational: known
CSAM matching must work before new image uploads open. Apply for
[PhotoDNA](https://www.microsoft.com/en-us/photodna/faq), free for approved
services, and register with [NCMEC as an electronic service provider](https://ncmec.org/csam).
Hash access and provider approval are separate facts to establish.
[Cloudflare CSAM scanning](https://developers.cloudflare.com/cache/reference/csam-scanning/)
is backup detection on cached delivery, not an upload-clearance substitute.
Evaluate [NSFWJS](https://github.com/infinitered/nsfwjs) or
[OpenNSFW2](https://github.com/bhky/opennsfw2) on CPU for explicit-image screening;
classifier output is review evidence, not clearance. Use
[Turnstile](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
for abuse-prone enrollment. Scan outage keeps new media unavailable.

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
