# Launch market gates

Qualification date: **2026-10-07**. Account market-policy version:
**2026-10-01**. This is an operator decision record, not a public policy or
certification of legal compliance. It applies the maintainer's
[zero-budget decision](trust-and-safety.md#safety-and-legal-readiness) and reads
the [legal drafts](../legal/README.md) against current code. No production
configuration, company filing or external approval was supplied for this review.

Registration remains intended in the US, Taiwan, Singapore, Japan, South Korea
and the EU. **EU access remains reachable and image uploads remain intended at
launch.** Paid counsel and EU representatives remain deferred under the recorded
risk acceptance; that does not discharge applicable duties. Explicit images,
advertising trackers, in-app behavioral telemetry, sales, job-seeker data,
business reviews and precise location histories stay outside the qualified
launch scope. No new scanner, policy engine or personal-data collection is
proposed here.

## Decision matrix

**Policy open** means the implemented product rule permits the capability.
**Conditional** means launch evidence is still missing. **Accepted risk** names
a deliberate deferral, not readiness. All six registration gates are
conditional on the common operator inputs below; none is certified ready.
Account ages are product minimums, not universal privacy or contracting ages.
The EU row covers EU law; Account applies its 16 minimum to the wider EEA too.

| Market | Registration decision | Adult and image decision | Privacy and transfers | Analytics decision | Representatives / registrations | Code evidence and exact additional inputs |
| --- | --- | --- | --- | --- | --- | --- |
| US | Policy open at 13; declaration and current terms/privacy receipts. COPPA scope depends on child-directed service or actual knowledge, not a checkbox. [FTC COPPA](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions). | Permitted adult text/graphic themes require 18 and separate opt-ins; **not qualified for every state**. [Paxton, 2025-06-27](https://www.supremecourt.gov/opinions/24pdf/23-1122_3e04.pdf) upheld Texas age verification for covered sexual-material sites. Layered non-explicit images remain intended. | Inventory purposes, recipients, security, rights and breach handling. State privacy thresholds need the actual footprint; zero budget is not an exemption. [California AG](https://oag.ca.gov/privacy/ccpa); [CPPA adjusted revenue threshold, effective 2025](https://privacy.ca.gov/2024/12/california-privacy-protection-agency-announces-2025-increases-for-ccpa-fines-and-penalties/). | Operational measurement only; no advertising/behavioral analytics. Do not infer all hosting logs are anonymous. | NCMEC reporting setup unresolved; DMCA designation unresolved. The [Copyright Office](https://www.copyright.gov/dmca-directory/faq.html) charges $6 with three-year renewal; strict zero spending cannot silently satisfy that filing. | R/S/M/O below. Operator supplies incorporation/address, states served, revenue and applicable processing thresholds, NCMEC provider access and DMCA filing/renewal receipt. Legal owner qualifies actual content against state duties. |
| Taiwan | Policy open at 13; minor contracting/parental involvement remains conditional. | Adult categories policy open at 18; local classification and minor-access qualification outstanding. Non-explicit images use common layers. | Purpose/legal basis, direct and indirect collection notices, rights, security and overseas restrictions require actual data flows. | Operational only; personal-data measurement still needs a lawful purpose and notice. | No blanket foreign-representative exemption or requirement established for this service; determine local establishment/sector status. | R/S/M/O. Operator supplies Taiwan establishment/sector, actual adult representations, guardian process and transfer recipients; legal owner resolves operative law and content classification. |
| Singapore | Policy open at 13; consent capacity and contractual capacity remain separate qualifications. | Adult categories policy open at 18, **not permission for prohibited pornography**; actual text/images need Internet content-code review. Non-explicit images remain intended. | PDPA purpose/notice, protection, retention, rights and comparable protection for overseas transfers require evidence. | Operational only; no blanket analytics consent from terms acceptance. | DPO appointment/public business contact required where PDPA applies; a DPO is not an EU-style foreign representative. Internet class-licence/registration and designated-service duties require service classification. | R/S/M/O. Operator names DPO and supplies Singapore nexus, service categories, designation/notices, content scope and overseas protection arrangements. |
| Japan | Policy open at 13; children's consent capacity and minor contracting remain conditional. | Adult categories policy open at 18, subject to obscenity and local youth/content restrictions; images remain non-explicit. | APPI purpose, security, rights and foreign-recipient disclosure/consent or qualifying safeguards require actual recipients. Small size alone is not clearance. | Operational only; identifiable analytics and covered external transmissions need separate qualification. | No universal APPI foreign representative established; telecom registration/representation and large-platform designation remain classification inputs. | R/S/M/O. Operator supplies Japanese establishment/targeting, child-consent route, prefectural/content footprint, recipients, messaging/telecom classification and any designation. Legal owner tracks 2026 amendment commencement. |
| South Korea | Policy open at 14; PIPA guardian consent below 14 is not implemented by the minimum-age declaration. Later underage discovery requires handling. | R18 and R18G presentation unavailable; R15 retains age/settings checks. Non-explicit images remain intended. Raw interactive payload boundary still needs local qualification. | PIPA lawful processing, notice, rights and overseas-transfer basis/details required. Direct collection by a foreign operator and onward overseas transfers need separate analysis. | Operational only; identifiable tracking needs its own basis and disclosures. | Domestic representative is threshold/designation dependent, not automatic for every foreign service. | R/S/M/O. Operator supplies global turnover, Korean daily subjects, Korean establishment/control and PIPC demands; identifies collection versus onward transfers and any youth-harmful classification. |
| EU | Policy open at 16 throughout EEA; GDPR Art. 8 concerns consent-based child services and does not settle contracting. EU stays reachable. | Adult categories policy open at 18; **EU-wide adult qualification unmet**. France's [Penal Code Art. 227-24](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044394218) covers specified harmful messages and rejects simple over-18 declaration as a defense. Images remain intended under common layers. | GDPR applicability needs offering/monitoring facts, not mere reachability. Establish legal bases, notices, rights, processor contracts and Chapter V safeguards for relevant transfers. [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng), Arts. 3, 6, 8, 12–14, 28, 44–49. | Operational only. Nonessential device storage/access requires consent under national implementation of [ePrivacy Art. 5(3), consolidated 2009](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:02002L0058-20091219); cookie-free does not mean personal-data-free. | **Accepted risk, unmet qualification:** GDPR Art. 27 appointment if Art. 3(2) applies without the narrow occasional/low-risk exception; routine accounts cannot assume it. DSA Art. 13 has no general micro-company waiver. E-evidence appointment needs national-law review. | R/S/M/O. Operator supplies member states, targeting/monitoring, establishment, representative mandate/contact/authority, recipient contracts and transfer mechanism. Legal owner assesses GDPR, DSA and e-evidence scope; absence of a representative stays explicit. |

## Implemented evidence and limits

- **R — registration:** [market rules](../../services/account/src/market-policy.ts),
  [signup receipts](../../services/account/src/policy-acceptance.ts) and
  [trusted ingress](../../services/account/src/app.ts) enforce literal age
  confirmation and exactly two current policy digests. Production
  [Accounts proxy](../../apps/accounts/features/proxy/account-proxy.ts) uses
  edge country; registration does not store a birthday or seed viewing-country
  preferences. Unknown country uses 16 with adults unavailable. The focused
  [qualification test](../../services/account/tests/registration-market-qualification.test.ts)
  covers composed admission and denied/partial/stale receipts for every launch
  code. Receipts acknowledge drafts, not completed operating facts.
- **S — suitability:** [Account preferences](../../services/account/src/content-preferences.ts)
  keep birthdays private unless separately published, ask for a full date when
  enabling restricted categories, and separate sexual/grotesque opt-ins. A
  learned below-minimum date suspends/revokes sessions; it does not complete
  deletion or parental approval. [Main policy](../../services/main/src/modules/suitability/policy.ts)
  admits unassessed content on every channel. [Disclosure](../../services/main/src/modules/disclosure/read.ts)
  limits noninteractive delivery, while interactive APIs can return rated
  bodies/images for client presentation. These are accepted product choices,
  not reliable age assurance or proof that minors cannot obtain restricted
  bytes. Account's explicit market list and Main's broader known-country rule
  also cannot establish qualification outside these six markets.
- **M — images:** [byte admission](../../services/main/src/modules/media/commands.ts)
  and [rate budgets](../../services/main/src/modules/rate-limit/budgets.ts)
  supply integrity/format bounds and five new-account upload-family operations
  per day, not five completed uploads. [Local NSFW inference](../../apps/web/features/document-editor/image-inference.ts)
  supplies presentation evidence; failure remains unknown and permits manual
  labeling. [Required matching](../../services/main/src/modules/media-screen/required-matcher.ts)
  defaults to `none`; `provider` is unavailable without an approved adapter,
  and production rejects the local fixture. A configured matcher failure holds
  public delivery. No code here proves deployed Cloudflare scanning.
- **O — measurement:** [observability](observability.md) and its
  [runtime](../../packages/observability/src/runtime.ts) allowlist operational
  fields and omit raw URLs, bodies, IPs, user agents and SQL values at export;
  an absent OTLP endpoint disables the SDK. No browser analytics integration was found in
  the inspected apps. Collector recipients, correlation IDs, routine console
  logs, Cloudflare analytics and actual retention still need the operator's
  inventory. Do not publish a claim of zero personal-data processing.

These are source-level findings plus the focused registration check, not
production drills. Existing owner evidence for the manager's regression:
[registration integration](../../services/account/tests/g-731.integration.test.ts),
[preferences](../../services/account/tests/content-preferences.integration.test.ts),
[interactive disclosure](../../services/main/tests/g-897-disclosure.test.ts),
[matcher failures](../../services/main/tests/media-required-matcher.test.ts),
[media recovery](../../tests/qa/integration/media-visibility.test.ts) and
[telemetry privacy](../../packages/observability/tests/runtime.test.ts).

## Common operator inputs and owner actions

1. **Maintainer/operator → legal/about owner:** Supply legal name, incorporation
   state, business address, covered domains, governing law/venue and monitored
   support, privacy, legal, safety, NCII, security and appeal contacts plus
   account-free forms. Complete the existing
   [legal fact slots](../../apps/about/src/legal/facts.ts), which are empty and
   block release policy publication. Publish actual practices and refresh
   acceptance digests through the existing workflow; do not publish placeholders.
   Correct the Terms §4 claim that likely explicit images are automatically
   held: current NSFW evidence creates no hold. This is a legal/about owner
   change, not made by this review.
2. **Operator → trust-ops safety/deployment owners:** Name active primary and
   backup responders, their verified delivery addresses and grants; provide
   production SAFETY03/07/08 results for account-free intake, deadline alerts,
   identical-copy/cache removal, preservation, appeals and responder absence.
   Supply NCMEC provider registration/access and restricted reporting custody.
   [18 USC §2258A, official 2024 edition](https://www.govinfo.gov/content/pkg/USCODE-2024-title18/html/USCODE-2024-title18-partI-chap110-sec2258A.htm)
   requires reports on qualifying actual knowledge and one-year preservation,
   not general scanning. [NCMEC provider documentation](https://report.cybertip.org/ispws/documentation/index.html)
   explains registration. [TAKE IT DOWN Act, 2025-05-19](https://www.govinfo.gov/content/pkg/PLAW-119publ12/html/PLAW-119publ12.htm)
   requires covered platforms' notice/removal process by 2026-05-19 and valid
   NCII removal/known-copy efforts within 48 hours. These are unresolved launch
   conditions, not work deferred until funding.
3. **Operator → media/deployment owners:** Supply Cloudflare account/zone,
   enabled-scanning evidence, monitored detection inbox and coverage of each
   original/rendition/import/avatar path, cache behavior and origin bypass.
   [Cloudflare documentation, updated 2026-05-01](https://developers.cloudflare.com/cache/reference/csam-scanning/)
   describes cached-content matching, daily detection mail and blocking only
   where possible; it is not a storage-admission guarantee. Record manual
   restriction/reporting when blocking fails. Supply PhotoDNA application/status;
   [Microsoft's FAQ](https://www.microsoft.com/en-us/photodna/faq) makes approval
   case-specific and the service free for qualified customers. Approval and
   an adapter are **future enhancement conditions**, not prerequisites replacing
   the accepted launch with text-only operation. Known-hash misses and
   unassessed/manual NSFW evidence remain accepted residual risks.
4. **Operator → legal/privacy and observability owners:** Supply each hosting,
   CDN, SMTP, backup, telemetry and optional AI recipient's legal entity,
   processing/access countries, purposes/data, retention, contract and transfer
   basis; include real-person catalogue credits and indirect-collection notices.
   Supply cookie names/lifetimes, local storage, embeds, Turnstile/pre-clearance,
   Cloudflare analytics settings and collector access/TTL. Provide rights,
   deletion/hold and breach procedures with accountable contacts. No analytics
   expansion or new identity-document collection is authorized by this review.
5. **Legal/trust and Account owners:** Resolve above-minimum minors' contractual
   and consent capacity, safe parental involvement where required, underage
   correction/appeal/deletion and actual adult representations by US state,
   EU member state and Asian jurisdiction. If applicable assurance cannot be
   met at zero cost, keep that particular capability closed through the
   existing admission mechanism; preserve EU reachability and ordinary images.
   Do not equate a display mask, self-declared date or client-only rendering
   check with legally sufficient access prevention.
6. **Maintainer/operator → legal owner:** Record each required representative's
   real mandate/contact, domicile, resources and authority, or the evidence
   for a specific exception. EU deferral remains accepted risk and prevents a
   claim of full legal qualification. [DSA, 2022-10-19](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32022R2065),
   recital 8 and Arts. 13, 16–19, distinguishes substantial connection from
   mere accessibility; small-platform relief does not waive representative,
   hosting notices, reasons or threat-reporting duties. [E-evidence Directive
   2023/1544, 2023-07-12](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32023L1544),
   Arts. 2–4, 7, adds national-transposition review for interactive/hosting
   services: offerings existing on 2026-02-18 had a 2026-08-18 appointment
   deadline; offerings starting after 2026-02-18 receive six months from start. Obtain actual launch
   date and relevant national law; do not infer the later evidence-order
   regulation postpones this appointment.

## Asian primary-source qualifications

All linked primary sources on this page were checked **2026-10-07**. Statute
dates/editions are stated where material. Territorial scope, service designation
and national/local implementation remain fact dependent; this review does not
claim a complete census of state or prefectural law. The current House US Code
page was unavailable; the official 2024 edition supports the reporting claim.
The Asian sources below supply the matrix's conditional duties.

- **Taiwan:** [MOJ Civil Code Art. 77 interpretations](https://mojlaw.moj.gov.tw/LawContentExtentList.aspx?ExtentType=e&LSID=FL001351&LawNo=77)
  distinguish minor transactions requiring guardian permission from exceptions;
  free accounts/upload licences are not assumed purely beneficial.
  [Child welfare Act](https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=D0050001),
  Arts. 2, 46–46-1, covers under-18 harmful-content protection.
  [Sexual exploitation Act](https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=D0050023),
  Arts. 8–8-1, requires applicable platform restriction/removal and **180-day
  preservation**: safety owner must qualify local notice/service requirements
  and custody, alongside US holds. [PDPA regulator text](https://law.pdpc.gov.tw/LawContent.aspx?id=FL010627),
  Arts. 8–9, 19–21, 51, covers notices, processing, overseas restrictions and
  overseas processing of nationals' data. It flags 2025-11-11 amendments as
  not fully commenced; do not claim replacement Art. 20-1 already governs.
- **Singapore:** [Class Licence Notification](https://sso.agc.gov.sg/SL/BA1994-N1)
  distinguishes class licensing from registration; qualify Singapore nexus and
  provider/content category against the [Internet Code](https://www.imda.gov.sg/regulations-and-licensing-listing/internet-code-of-practice).
  [PDPC children's guidance, March 2024](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/advisory-guidelines-on-the-pdpa-for-children%27s-personal-data-in-the-digital-environment_mar24.pdf),
  paras. 4.4–4.6, requires parental consent below 13 and considers actual
  understanding above it. [PDPC obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations)
  cover DPO contact and comparable overseas protection. [OSC commencement,
  2026-06-29](https://www.osc.gov.sg/newsroom/the-online-safety-commission-begins-operations-on-29-june-2026/)
  adds prescribed-notice response and directions for specified harms;
  safety/legal owners must qualify applicability and operational response.
- **Japan:** [MOJ majority/contract FAQ](https://www.moj.go.jp/MINJI/minji07_00238.html)
  records majority 18 from 2022-04-01 and minor-contract rules.
  [PPC child-consent FAQ](https://www.ppc.go.jp/all_faq_index/faq1-q1-62/)
  assesses capacity case by case, generally below an age in the 12–15 range;
  it does not clear every 13-year-old. [APPI guidelines](https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/)
  cover foreign-service scope and transfer safeguards. The enacted
  [2026-07-17 amendment](https://www.ppc.go.jp/files/pdf/260717_houritsu.pdf),
  supplementary Art. 1, defers the substantive new under-16 regime to decree
  within two years; it is not treated as operative here. [MIC transmission FAQ](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu_00002.html)
  includes covered SNS/bulletin boards and notice/publication, consent or
  prescribed opt-out routes; an EU-style universal cookie opt-in is not inferred.
- **South Korea:** [PIPA Art. 22-2, effective 2026-09-11](https://law.go.kr/LSW/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1020398521)
  addresses verified guardian consent below 14 when consent is required.
  [PIPC cross-border guidance](https://pipc.go.kr/np/default/page.do?mCode=D060040000)
  separates direct foreign collection from onward transfer and describes legal
  routes/disclosures. [Decree Art. 32-3](https://www.law.go.kr/LSW/lsLinkCommonInfo.do?chrClsCd=010202&lspttninfSeq=196737)
  triggers representation at prior-year revenue KRW 1 trillion, average daily
  1 million Korean subjects in the prior year's final three months, or a PIPC
  determination following a materials request; operator attests all three limbs.
  [Youth Protection Act](https://law.go.kr/LSW/lsInfoP.do?lsId=000815), Arts. 2,
  16, has harmful-media classification and age/identity duties. Legal owner
  must qualify actual representations; closing adult settings alone proves
  neither classification nor legal access prevention.

Review again before opening a newly restricted representation, adding a
processor/tracker, changing served territories, receiving a designation/order,
crossing a threshold or commencement of the cited amendments. The manager can
accept this qualification record while external conditions remain unresolved;
launch approval still needs the named owners' evidence.
