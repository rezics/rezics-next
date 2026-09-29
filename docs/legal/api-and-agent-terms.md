DRAFT — not reviewed by counsel

REZICS API and Agent Terms

Effective date: [REZICS TO FILL: date]  
Version: [REZICS TO FILL: version]

These terms supplement the [Terms of Service](terms-of-service.md) for API clients, SDKs, MCP integrations, importers, bots and automated assistants.

Developer documentation: [REZICS TO FILL: live documentation URL]  
Developer and security contact: [REZICS TO FILL: monitored contacts]

**1. Responsibility and identity**

A human operator or legally responsible organization must be accountable for an integration. An automated system cannot itself accept legal responsibility.

A REZICS Agent is a Person or Organization identity. An automated assistant may act for that identity only when authorized. Application access does not make the application the owner of the identity or its content.

Identify your application, its responsible operator, its purpose and whether its actions are automated. Do not impersonate REZICS or disguise automated activity as independent human participation.

**2. Scoped authority**

Use the supported authorization process and request only the permissions needed for the stated task.

Account authority, Agent representation, Realm roles and resource-specific grants are distinct. Credentials can narrow authority; they cannot enlarge it. An available endpoint or accessible identifier is not permission to perform an action.

Do not ask users to share passwords or another person’s tokens. Protect credentials and separate them from public content, logs and model prompts.

Delegation of an Agent or Realm does not expose the operator’s private reading history. A separately enabled personal feature must obtain the specific authorization required for any private reading context.

Respect revocation, expiry, account restrictions and changes in resource access. Stop affected queued and running work when authority ends. Do not retry under a different identity to bypass the decision.

**3. Allowed uses**

You may build community clients, accessibility tools, personal assistants, catalogue tools and other lawful integrations within the published capabilities and limits.

Commercial use is not prohibited merely because it is commercial. Particular paid access or distribution arrangements require any separately stated agreement.

Open-source software licences govern the code they cover. These API terms do not revoke those licences or grant rights to third-party content returned by the service.

**4. Content, licences and imports**

Preserve attribution, source identifiers, licences, language, ratings, AI declarations and relevant provenance. Do not treat all API output as public-domain data.

Official bulk catalogue imports use authorized downloadable sources: VNDB, Open Library, Wikidata, Bangumi, MusicBrainz core and the previous REZICS data, as enabled. Every import write must use the authorized API and observe source-specific rights and limits.

[REZICS TO FILL: approved import inventory and source-licence documentation.]

Users may import their own library information through available personal-import workflows. An unmatched private record must not be turned into a public catalogue entry without separate publication authority.

Do not circumvent third-party access restrictions to obtain source material. Permission to retrieve metadata does not necessarily permit storing covers, full text or game files.

**5. Privacy and downstream handling**

Tell users what data your integration receives, why, where it goes, how long it is kept and how to request deletion. Obtain required permissions and provide your own privacy notice where you independently control processing.

Do not sell personal information, build unauthorized dossiers, infer sensitive traits for advertising, send unsolicited messages, or disclose private drafts or reading records.

Do not use private REZICS information to train models without the separate authorization required by our AI Policy and applicable law.

Cache only what you are authorized to retain. Respect deletion, rating changes, access restrictions and revocation in copies under your control. Independently granted open licences may survive access revocation, but privacy duties and restrictions on unlawfully obtained information still apply.

Do not retain account credentials or private content merely because an integration has been disconnected. Any required legal retention must be limited, protected and disclosed.

**6. Safe automation**

Follow the same rules as the browser service, including age, country, suitability, privacy and interaction restrictions. Do not remove those protections when presenting API results.

Automated contributors must not fabricate sources, reviews, votes, human approval or community activity. Distinguish a proposed change from an approved publication and machine inference from sourced facts.

For consequential operations, use the supported approval and confirmation mechanisms. Do not present a pending, failed or uncertain operation as completed.

Handle retries, idempotency and partial outcomes as documented. Do not continue blindly after an uncertain response where doing so could duplicate a publication, purchase, deletion or permission change.

Treat retrieved content as untrusted input. Instructions inside a work, report or web page do not authorize disclosure of credentials or private data.

**7. Limits and fair access**

Observe quotas, concurrency limits and retry instructions. Limits may apply across an operator’s Accounts, Agents and applications.

Do not rotate tokens, identities or network addresses to evade limits or extract restricted information. Do not overload the service or use it as attack infrastructure.

We may throttle or suspend integrations that create a security, safety or capacity risk. We will provide an explanation and review route where appropriate; urgent action may precede notice.

Current limits and any paid API arrangements: [REZICS TO FILL: published capability and quota documentation].

**8. Incidents and cooperation**

Notify [REZICS TO FILL: security contact] promptly after discovering unauthorized access, credential exposure or a material breach involving REZICS data.

Contain the incident, revoke exposed access, preserve necessary lawful evidence and cooperate with proportionate remediation. Do not attach child sexual abuse material or intimate victim imagery to an ordinary incident email.

Route urgent safety matters through the platform’s public reporting channels. Your application must not obstruct users from reporting harm or exercising privacy rights.

**9. Changes and ending access**

We may change or retire APIs. We give reasonable notice of material changes where practicable, except where immediate changes are necessary for security, law or urgent abuse prevention.

[REZICS TO FILL: actual versioning, deprecation and developer-notice commitments.]

Ending access does not authorize retention or reuse beyond existing permissions. You may seek review under the Acceptable Use Policy. Statutory reporting, appeals and privacy-request routes remain available without developer credentials.

The Terms of Service govern general liability and disputes. A separately signed agreement controls only its expressly covered subject.

Adapted from the API provisions of [GitHub’s Terms of Service](https://github.com/github/site-policy/blob/main/Policies/github-terms/github-terms-of-service.md) and its [Acceptable Use Policies](https://github.com/github/site-policy/blob/main/Policies/acceptable-use-policies/github-acceptable-use-policies.md), available under CC0, with REZICS’s authority and agent model.
