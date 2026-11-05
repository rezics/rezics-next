# Verification of the account behind a catalogue agent

Research checked on 27 October 2026. This report is evidence and a recommendation for adoption;
it does not change the Access or Semantic contracts, operations, or exposure gates.

## Scope and method

The relevant assertion is that an account represents a particular person or organization, not that
everything it says is correct. The sources distinguish three mechanisms: access to manage an official
page, an authenticity endorsement, and a sourced catalogue link to an external identity. They are not
interchangeable. MusicBrainz and Wikidata are useful counterexamples to treating an official website
as ownership of the catalogue entry.

Only platform documentation, protocol documentation, first-party publisher guidance, and inspected
upstream source support the findings below. Penguin Random House's description is primary evidence
of its own Author Central confirmation workflow, not proof that Amazon uses that workflow for every
publisher. Public documentation is sometimes incomplete: **not documented** means that the cited
sources do not specify the procedure, evidence, deadline, or guarantee; it does not mean it is impossible.
Published turnaround estimates below are not measured service levels.

Four reference repositories were shallow-cloned and read, without installing, building, or running
their contents. To honor the instruction to write only inside this worktree and AGENTS.md's temporary
file rule, clones are in `.temp/agent-verification-refs/<project>/`, instead of the generic external
reference directory. Repository snapshots and licences are recorded below. No upstream code is copied.

## What the products accept and who reviews it

| Product                                | Evidence and eligibility                                                                                                                                                                                                                                                                                               | Reviewer, workflow, and published time                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goodreads Author Program               | A published or forthcoming book in its database and an application claiming the corresponding author profile. The accessible official program pages do not enumerate accepted domain challenges, verified social accounts, documents, or publisher attestations; a listing alone is not staff verification.            | Goodreads staff verify applications submitted from the author page. The program page says approval email within two business days. Volunteer catalogue editing is a separate function. [Program][G1], [staff explanation][G2].                                                                                                                  |
| Amazon Author Central                  | Sign in, find a book by ISBN, ASIN, or author name, and claim that author identity. PRH says Amazon asks PRH to confirm the claimant's email with the publisher; an unfamiliar address needs confirmation by the author's editor. No universal Author Central document/domain checklist is published in these sources. | Amazon with the publisher in the documented PRH route; PRH says up to seven days and directs approval problems through its Amazon representative. Amazon's own getting-started page gives no review deadline. [Amazon][A1], [PRH][A2].                                                                                                          |
| Spotify for Artists                    | Link the artist's website or social channels. Preferred distributors offer instant access. A label claim supplies owned tracks/albums; an unreleased artist supplies its URI and release UPC/EAN through support.                                                                                                      | Spotify manually reviews ordinary requests, taking a few days; one pending request per artist/label. An already claimed team admits people through its Admin; contact support if that Admin cannot be reached. [Access][S1].                                                                                                                    |
| YouTube Official Artist Channels (OAC) | Operate one artist/band channel, have a label/distributor-delivered release, meet policies and a listed partner/YPP route.                                                                                                                                                                                             | Label/distributor/Music Service Partner applies to YouTube. No deadline or exhaustive proof checklist stated; missing public videos can require extra verification. [OAC][Y1].                                                                                                                                                                  |
| Bluesky badges                         | Authentic and notable accounts can apply; Bluesky also selects accounts. Trusted Verifiers can attest identities within their expertise, such as a publisher verifying its journalists. This is an issuer's endorsement, not acceptance of any existing third-party blue check.                                        | Bluesky and selected Trusted Verifiers; Bluesky moderation reviews each issued verification. An application form exists, but the announcement provides no turnaround commitment or document checklist. [Announcement][B1].                                                                                                                      |
| Bluesky domain handles                 | Control of DNS TXT at `_atproto.<handle>` or HTTPS `/.well-known/atproto-did`, plus the matching handle in the account's DID document. No identity documents or staff endorsement are inherent in this proof.                                                                                                          | Automated bidirectional resolution, not a manual claim queue. Resolver caching means it is not a promise of instantaneous propagation. [Handle specification][B2].                                                                                                                                                                              |
| Mastodon links                         | An HTTPS profile field whose destination links back to that exact Mastodon profile using `rel="me"`. This demonstrates control of linked pages; a trusted official site makes that useful identity evidence.                                                                                                           | The server checks asynchronously after profile save. The documentation says completion can take time, with no deadline. No central documentary identity reviewer exists for this feature. [Profile documentation][M1], [rel-me definition][M2].                                                                                                 |
| MusicBrainz                            | Editors add URL relationships using public evidence. An official homepage is publicly endorsed, not necessarily authoritative; a social-network relationship denotes an artist/management-controlled posting profile. Editor email confirmation is registration, not an artist claim.                                  | Community editors, edit notes, voting and auto-edit rules. Most voting edits remain open seven days, with early decisions possible; relationship creation in the inspected source is an automatic edit. This is not a seven-day artist-verification SLA. [Homepage][C1], [social accounts][C5], [registration][C2], [voting][C3], [source][C6]. |
| Wikidata                               | Sourced statements about official websites (`P856`) and website accounts (`P553` with `P554`, or platform identifiers). P553's documentation requires a reliable source or disclosure by the person/organization. These are statements about the subject, not authentication of the Wikidata editor.                   | Community editing and review under verifiability rules, not approval of an owner. No identity-claim queue or associated response time is described. [P856][W1], [P553 documentation][W2], [verifiability][W3].                                                                                                                                  |
| Steam developer/publisher pages        | Steamworks partner access, `Edit App Marketing Data` permission and Community group control. Onboarding checks legal identity through company, bank/tax information and agreements.                                                                                                                                    | Valve onboards partners; authorized users configure/link pages. No homepage claim-review deadline. The onboarding guide's 1–5 day store/build review is separate. [Homepages][T1], [onboarding][T2].                                                                                                                                            |

As a concrete publisher-assisted example, Havok offers its authors a publisher contact and contributor
listing URL for Amazon's evidence requests, and help correcting Goodreads same-name misattribution.
Its May 2025 instructions describe its own support practice, not either platform's universal acceptance
policy. [Havok's author instructions][H1].

Documents are therefore an available escalation mechanism, not a shared prerequisite for catalogue
claims. Amazon KDP explicitly accepts government ID and may require periodic reverification, but
its help describes **KDP identity checks**, not Author Central page ownership. YouTube's ordinary
channel-verification process may request documentation, but it is distinct from OAC. Do not silently
import either process into the corresponding artist/author claim. [KDP identity][A3], [channel badges][Y2].

## What approval gives the account, and what readers see

| Product              | Resulting authority                                                                                                                                                                                                                                 | Public presentation                                                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goodreads            | Update author biography/photo and listings; enable Ask the Author and publish answers as the author, plus professional promotion tools. This is the closest example to REZICS's answer-as-subject use case.                                         | Goodreads Author badge on the author profile; a catalogue author page can exist without program membership. [Program][G1], [guidelines][G3], [staff explanation][G2].                                                                                                                                                                  |
| Author Central       | Curate biography, photo and books, with sales/review/follower tools. This documentation does not establish an answer-as-author feature or authority over customers' reviews. PRH says some photo/bio editing is possible while approval is pending. | Author Page, book-page biography and Follow entry points. The sources do not describe a distinct identity-verification badge. [Amazon][A1], [PRH][A2].                                                                                                                                                                                 |
| Spotify              | Team-scoped roles: Admin/Editor can edit the artist profile; Reader can inspect statistics/profile. Team Admin adds membership management. No catalogue-wide editorial ownership follows from team membership.                                      | Since January 2026, claimed/managed status is labelled **Registered Artist** in About. A separate **Verified by Spotify** authenticity/trust badge appears on profiles and search, with its own review criteria. Claiming access is not equivalent to receiving that badge. [Roles][S2], [label change][S3], [authenticity badge][S4]. |
| YouTube OAC          | Consolidates artist subscribers/content and provides artist analytics; channel posts, comments and streams communicate as the artist.                                                                                                               | Music-note icon beside the channel name. Ordinary channel verification is separate and unlocks no extra features. [OAC][Y1], [artist guidance][Y3], [channel badges][Y2].                                                                                                                                                              |
| Bluesky badge/domain | Authenticity signal or domain/account binding. The cited mechanisms do not grant rights to edit an external catalogue or speak for a different account; posting already belongs to the account.                                                     | Badge beside the name, with issuer details on selection; Trusted Verifiers have a distinct scalloped badge. A domain handle is a separate visible signal. Hiding badges in the viewer's settings does not revoke them. [Announcement][B1], [handles][B2].                                                                              |
| Mastodon             | Evidence about a profile link. No additional publishing or catalogue-edit permission is awarded.                                                                                                                                                    | Checkmark on the verified link, conventionally a green field; not a platform-wide identity endorsement. [Profile][M1], [rel-me][M2].                                                                                                                                                                                                   |
| MusicBrainz          | Normal community editing; adding an official link does not give its owner exclusive edit or answer-as-artist rights.                                                                                                                                | An official-homepage/URL relationship on the artist entry. The editor profile's verified email must not be read as artist verification. [Homepage][C1], [registration][C2], [relationship implementation][C6].                                                                                                                         |
| Wikidata             | Ordinary editing subject to permissions and protection. A website/account statement does not give its controller ownership of the item.                                                                                                             | Referenced statements and external links, with qualifiers/ranks where appropriate; not an authenticated-owner badge. [Properties][W1], [verifiability][W3], [ranking][W4], [permission source][W6].                                                                                                                                    |
| Steam                | Authorized group/partner members customize a brand homepage, organize games/lists, and use announcements and configured broadcasts.                                                                                                                 | Developer/publisher names link from store pages to the branded homepage; customers can follow it. The guide does not define a separate verified-owner badge. [Homepages][T1].                                                                                                                                                          |

## Reversal, disputed claims and impersonation

Reversal has at least three different meanings: removing a team member's powers, withdrawing an
authenticity assertion, and correcting catalogue information. Removing one must not be assumed to
remove the others. Publicly documented procedures and limits are:

| Product         | Owner and staff reversal; disputes                                                                                                                                                                                                                                                                                                                   | Expiry, changed evidence, and deletion                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goodreads       | The reviewed program pages do not specify self-service unclaim or a verification-only revocation flow. Support handles incorrectly attached books. Terms prohibit impersonation, permit content removal and account suspension/termination, and reserve discretion over disputes.                                                                    | No fixed verification expiry or precise badge behavior after deletion is documented in these sources. General privacy/account controls are not evidence of an author-entry deletion or unmerge procedure. [Staff explanation][G2], [terms][G4], [privacy][G5].                                                                                                                                                                                 |
| Author Central  | PRH directs approval problems to its Amazon representative; Amazon provides account support. These sources do not document owner unclaim, staff revocation steps, competing-claim adjudication, or appeal deadlines. Do not invent an Amazon policy from the signup flow.                                                                            | Page-verification expiry and what account deletion does to the catalogue page are not documented here. KDP can separately demand reverification; that does not establish Author Central expiry. [Amazon][A1], [PRH][A2], [KDP][A3].                                                                                                                                                                                                            |
| Spotify         | Team Admins remove members and change roles; removing a member is distinct from removing the artist profile or authenticity badge. Already-claimed-team access problems go to support. Misattributed recordings have a separate content-mismatch report.                                                                                             | No fixed claim expiry, owner unclaim workflow, badge-removal SLA, or automatic profile deletion on member-account deletion is specified by these sources. [Removal][S5], [roles][S2], [access][S1], [mismatch][S6].                                                                                                                                                                                                                            |
| YouTube OAC     | Strikes/limited-feature content suspend OAC to a standard channel; restoration is automatic once cleared if still eligible. Reported impersonation can cause channel removal. Owner-requested OAC removal is undocumented here.                                                                                                                      | No fixed OAC expiry or deletion-unconsolidation rule stated. Ordinary badges have separate name-change and violation revocation rules, not OAC rules. [OAC][Y1], [impersonation][Y4], [channel badges][Y2].                                                                                                                                                                                                                                    |
| Bluesky badges  | The inspected Ozone implementation lets authorized verifier/admin credentials revoke issued verifications, deleting issuer-owned records and recording the revoker/reason. This demonstrates staff/issuer reversal, not a documented subject-side unclaim API. Misleading impersonation is prohibited; reports and moderation appeals are available. | Verification records bind subject DID, handle and display name. The inspected view marks mismatching names/handles invalid and suppresses overall verification for impersonation labels. There is no expiry field in this record schema. Account deletion does not prove all issuer-held attestations are erased; clients must evaluate current validity. [Revoke][B3], [schema][B6], [view][B7], [issuer][B8], [guidelines][B4], [terms][B5]. |
| Bluesky domains | Owner changes the handle or domain proof; a failed bidirectional mapping must not be treated as a valid handle. Control of a lookalike or newly acquired domain proves control of that domain, not the prior owner's identity.                                                                                                                       | DNS/HTTPS proofs and caches can become stale; this is revalidation, not permanent certification. Domain proof is not an expiring staff badge. A DID is the persistent account identifier, while handles are mutable. [Specification][B2].                                                                                                                                                                                                      |
| Mastodon        | Owner removes/changes the profile field. In the inspected code, unchanged values retain their verification timestamp and workers skip already verified fields: removing only the website backlink is not demonstrated to withdraw an existing checkmark promptly. Account moderation remains a separate server function.                             | No fixed expiry is present in the inspected field/worker path. Removing the field, saving and re-adding it triggers a new check. Do not advertise continuous verification or immediate cross-server disappearance on deletion. Link checks reject unsafe schemes and certain IDN forms to reduce spoofing. [Docs][M1], [source][M3].                                                                                                           |
| MusicBrainz     | Editors correct/end/remove URL relationships using edits and evidence, rather than unclaiming an artist account. Disputes use edit notes/votes and community conflict resolution, with escalation described in the Code of Conduct.                                                                                                                  | Relationships support start/end dates. There is no owner-verification expiry because this mechanism is catalogue data, not an owner assertion. Deleting an editor account is not the same operation as deleting a relationship; the inspected deletion edit targets the relationship itself. [Homepage][C1], [conduct][C4], [deletion source][C7].                                                                                             |
| Wikidata        | Editors correct statements, references, ranks and qualifiers; admins handle protected editing and deletion requests. A website controller has no special unclaim power. Disputed website/account claims need evidence and community resolution, not a race for an ownership badge.                                                                   | P856 explicitly includes former sites and directs editors to retain historical URLs using its hijacked/dead-site guidance. Deprecated rank can mark erroneous statements; it is not simply an expiry flag. Deleting/blocking an editor does not itself retract a statement about an external subject. [P856][W1], [ranking][W4], [deletion requests][W5], [source][W6].                                                                        |
| Steam           | Admins unlink apps; display updates take 10–20 minutes without changing developer/publisher name metadata. Valve support considers activity, ownership and misrepresentation in group-name disputes; reassignment is not guaranteed.                                                                                                                 | Initiating app transfer removes existing homepage associations; relink afterward. No fixed homepage-verification expiry or full page deletion/unclaim procedure specified. [Homepages][T1].                                                                                                                                                                                                                                                    |

## Patterns shared by the sources

The following are synthesis, not claims that every service implements one identical policy:

1. **Evidence must connect the account to the exact subject.** Website/social presence, a distributor's
   existing relationship and publisher confirmation are reusable routes. A book listing, matching name,
   ID card or catalogue URL by itself does not establish authority to represent that artist or company.
2. **Control and endorsement are separate.** Mastodon/AT Protocol prove a controlled endpoint;
   Bluesky badges attest authenticity; Spotify now explicitly separates a managed profile from its
   authenticity badge. A third-party verified account is useful only with evidence that the claimant
   controls it and that it represents the same subject.
3. **Approval's powers must be explicit.** Goodreads grants author interaction and profile tools;
   Spotify/Steam use scoped team permissions; Bluesky/Mastodon signals do not imply editorial powers.
   MusicBrainz/Wikidata preserve community authority over catalogue facts despite official links.
4. **There is a continuing authority and correction path.** Issuers can revoke attestations, team
   admins remove members, and communities correct statements. YouTube demonstrates suspension and
   restoration rather than deleting the artist's whole record. These paths have different semantics.
5. **First arrival does not settle contested identity.** Spotify routes an inaccessible claimed team
   to support; Steam evaluates competing claims instead of guaranteeing a name transfer. Public
   documentation does not establish a common fixed expiry period or a common dispute-response SLA.

## Comparison with the current REZICS design

Baseline inspected: repository commit `b83e8ec43c3056755cc6593b35dafa2e52f2e7f0`.
The local authorities are [Access's verification section][R1], its public-profile section in the same
README, [Semantic's account-agent section][R2], and the [account routes][R3]. The contract's
answer-as-subject behavior is the intended product effect; it must not be interpreted as a general
grant to rewrite the catalogue.

| Requested point                     | Current design and fit                                                                                                                                                                                                                                                                                                                                                                      | Recommended change for the owning contract                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Accepted evidence                | `{ subject, statement, links }` accommodates public evidence but states no sufficiency rule. Person/organization visibility and type matching are useful eligibility checks, not identity evidence. **Partial match.**                                                                                                                                                                      | Publish an evidence ladder: challenge on an established official site/domain; authenticated confirmation from an established official account; publisher/distributor confirmation obtained through an independently located contact; private documents plus proof of representative authority as an escalation. A supplied link or screenshot alone is insufficient. |
| 2. Reviewer/workflow/time           | Governance reviews a pending queue with approve/reject reasons. Durable receipt-bound work handles Semantic refusal and retries. This matches a staff-reviewed claim model. No service target, request-for-more-evidence or appeal workflow is documented. **Core match; incomplete operations policy.**                                                                                    | Retain staff review and the gate. Record evidence checks and reviewer rationale, notify the claimant of outcome, support additional evidence and appeal. Publish an achievable review target without treating competitors' estimates as a REZICS SLA.                                                                                                                |
| 3. Authority afterward              | Answering as the catalogue agent matches Goodreads. Semantic merges the account node into the surviving catalogue subject and changes statement provenance. Verification itself is not an Access editorial grant. **Fits official speech if scoped.**                                                                                                                                       | Explicitly separate official speech, profile presentation and catalogue editing. Keep catalogue corrections under normal evidence/permission rules; organizations should speak through their organizational account and existing managed membership, not share a person's credentials.                                                                               |
| 4. Public display/read/lookup       | Public handle identity exposes `{ subject: { id, label, type }, verified }`; deleted accounts return null/false. This supports a linked authenticity display. It omits issuer/date/meaning, and UI wording is not specified. **Partial match.**                                                                                                                                             | Show “Verified representative of [subject]” with a link, verifier/date and explanation that this is not endorsement of statements. On the agent page expose the currently active representing account. Public responses must use active verification state and never expose private evidence.                                                                        |
| 5. Reversal                         | Withdrawal only withdraws a pending request; reject only changes a request. Approval performs a semantic merge. Moved-link bookkeeping anticipates future reversal, but the README/routes provide no approved-link self-release, staff revocation, expiry or dispute state. Deletion's public null/false is not proof that the Semantic backlink/merge has been reversed. **Material gap.** | Specify owner release, staff revocation, temporary dispute suspension, evidence-loss review and deletion cleanup. Stop official-speech authority/public verified lookup promptly; finish provenance-aware graph reversal durably. Preserve the catalogue subject and independent facts. No fixed periodic expiry is justified by the shared evidence.                |
| 6. Impersonation/conflicting claims | One pending request per account and Semantic uniqueness prevent some duplication. They do not decide who is the rightful claimant; no dispute evidence/appeal process is documented. **Material gap.**                                                                                                                                                                                      | Accept challenges even when the subject is already linked, contact independently verified representatives, suspend disputed authority when justified, retain a private audit trail, notify affected parties and permit appeal. Never auto-transfer to the next applicant merely because a link was removed.                                                          |

**The `?agent=` discrepancy:** the task describes this as part of the current design, but the inspected
`publicIdentityQuery` and `/v1/accounts` handler accept only `ids` or `handle`; neither that route nor
the inspected README documents `?agent=`. This is a baseline observation, not a research blocker or
an implementation change. Treat `?agent=<subjectId>` as the intended reverse lookup and require it to
resolve the subject's current active representative, respect visibility/deletion/suspension, and return
no verified representative during revocation. Do not derive verified status just from an old graph
redirect. Whether unknown subjects return an empty result or a not-found response belongs in the
owning API contract. [Routes][R3], [public identity implementation][R4].

## Recommendation for adoption

Keep governance approval and the current account-to-subject model, but keep the gate closed until
the contract defines evidence sufficiency, the exact official-speech permission and reversal. Do not
add automatic approval from external badges or claim that verification grants ownership of facts.

Model the **current representation assertion** separately from request history and semantic merge
history. Record subject/account, issuer, evidence method, checked-at time, decision reference and
status. Suggested active-status changes are release, revocation and temporary suspension; a rejected
application is not a revoked representation. Keep documents/contact details private and minimize
their retention. These are proposed REZICS choices, not policies prescribed by all researched products.

For reversal, make the authority cutoff precede eventual graph cleanup: fresh requests must cease
answering as the subject, and both public directions of lookup must cease advertising the active
link. The durable cleanup should use the existing merge receipt and moved-link provenance to
restore the account's derived agent without undoing unrelated catalogue edits. Historical statements
need their actual account author preserved; a revoked relationship must not keep attributing future
speech to the subject or silently relabel independently sourced catalogue facts. Reapplication is a
new reviewed decision. Acceptance for a later implementation should cover stale reads, retries,
approval/revocation races, organization management changes, deletion and disputed claims.

Prefer event-driven rechecks after compromise, domain/control changes, complaints or representative
changes, with an explicit last-checked date. Do not infer perpetual freshness from Mastodon's cached
checkmark, or adopt a fixed expiry merely because KDP can reverify publishers. A temporary domain
outage should trigger review rather than automatically award the catalogue identity to someone else.

## Source snapshots, file paths and licences

The URLs above are live first-party documentation, checked on the date at the top. The following
source links are pinned to the shallow-clone commits. Paths are relative to each named repository.
They establish implementation patterns, not promises about every deployed instance or fork.

| Project / snapshot                                                                      | Inspected paths and finding                                                                                                                                                                                                                                                                                                                                         | Licence and reuse                                                                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `bluesky-social/atproto` at `66ce7c5fde851be67c0b36362ef75ea3b0a46df6`                  | `packages/bsky/lexicons/app/bsky/graph/verification.json` binds DID/name/handle; `packages/bsky/src/views/index.ts` checks current validity; `packages/ozone/src/api/verification/revokeVerifications.ts` authorizes revocation; `packages/ozone/src/verification/issuer.ts` deletes issuer records. [Schema][B6], [view][B7], [revoke endpoint][B3], [issuer][B8]. | [LICENSE.txt][BL]: dual MIT or Apache-2.0, subject to file exceptions. Eligible for attributed code reuse after checking the actual files. |
| `mastodon/mastodon` at `4e7c02372b1e26e1a237739243ccdc4820c32fd5`                       | `app/services/verify_link_service.rb` checks backlinks; `app/models/account/field.rb` stores `verified_at` and skips verified fields; `app/models/account.rb` retains timestamps for unchanged values; `app/workers/verify_account_links_worker.rb` runs checks. [Service][M3], [field][M4], [account][M5], [worker][M6].                                           | [LICENSE][ML] and README: AGPL-3.0-or-later. Read for behavior; do not copy this implementation under this task's reuse rule.              |
| `metabrainz/musicbrainz-server` at `bade3a567e20ec69323ac7850fca9d0ee113f87d`           | `lib/MusicBrainz/Server/Edit/Relationship/Create.pm` uses the automatic-edit role; `lib/MusicBrainz/Server/Edit/Relationship/Delete.pm` removes a relationship on acceptance; `root/user/UserProfile.js` distinguishes editor profile state from artist relationships. [Create][C6], [delete][C7], [profile][C8].                                                   | [COPYING.md][CL]: GPL-2.0-or-later for these paths. Bundled permissive exceptions do not relicense the reviewed code. Patterns only.       |
| `wikimedia/mediawiki-extensions-Wikibase` at `4912c5f4ac553025d573bd79e721769e5297cd6a` | `repo/includes/Store/EntityPermissionChecker.php` checks editing authority for entities; `repo/includes/Api/RemoveClaims.php` applies statement removal and saves the entity. These are generic editing mechanisms, not external-subject ownership claims. [Permissions][W6], [removal][W7].                                                                        | [COPYING][WL] and `extension-repo.json`: GPL-2.0-or-later, with directory exceptions. Patterns only for the inspected paths.               |

Documentation licensing differs from source-code licensing. Goodreads, Amazon, PRH, Havok, Spotify,
YouTube, Bluesky product pages, microformats and Valve documentation are treated as copyrighted
references with no assumed code-reuse grant. Mastodon documentation identifies CC BY-SA 4.0; MusicBrainz documentation identifies
CC BY-NC-SA 3.0; Wikidata structured data is CC0 while other wiki text is CC BY-SA 4.0. AT Protocol
website documentation declares CC-BY. See [MusicBrainz licensing][DL1], [Wikidata licensing][DL2],
[AT Protocol website licence][DL3], and the Mastodon documentation footer. This report paraphrases
behavior and attributes the sources; it reproduces no implementation or branded badge assets.

Patterns may be followed freely. Under this task's constraint, copy code only from MIT, Apache-2.0
or BSD projects, with attribution and required notices; do not copy AGPL/GPL implementations or
assume a documentation licence permits copying accompanying code. No code reuse is needed for the
recommendation.

[G1]: https://www.goodreads.com/author/program
[G2]: https://www.goodreads.com/blog/show/1106-what-authors-should-know-about-joining-the-goodreads-author-program
[G3]: https://www.goodreads.com/author/guidelines
[G4]: https://www.goodreads.com/about/terms
[G5]: https://www.goodreads.com/about/privacy
[H1]: https://gohavok.com/havok-anthologies/anthology-author-support-amazon-and-goodreads-author-profiles/
[A1]: https://kdp.amazon.com/en_US/help/topic/G200644310
[A2]: https://authornews.penguinrandomhouse.com/have-you-made-your-amazon-author-central-page/
[A3]: https://kdp.amazon.com/en_US/help/topic/GH7TYHP6FR9QAUM9
[S1]: https://support.spotify.com/la/artists/article/getting-access-to-spotify-for-artists/
[S2]: https://support.spotify.com/ws/artists/article/access-levels-in-spotify-for-artists/
[S3]: https://support.spotify.com/us/artists/article/transitioning-verified-to-registered/
[S4]: https://support.spotify.com/us/article/verified-by-spotify/
[S5]: https://support.spotify.com/us/artists/article/removing-team-members-from-spotify-for-artists/
[S6]: https://support.spotify.com/us/artists/article/music-mixed-up-with-another-artist/
[Y1]: https://support.google.com/youtube/answer/7336634?hl=en
[Y2]: https://support.google.com/youtube/answer/3046484?hl=en-GB
[Y3]: https://artists.youtube/intl/en-GB/resources/channel-optimization/
[Y4]: https://support.google.com/youtube/answer/2801947?hl=en
[B1]: https://bsky.social/about/blog/04-21-2025-verification
[B2]: https://atproto.com/specs/handle
[B3]: https://github.com/bluesky-social/atproto/blob/66ce7c5fde851be67c0b36362ef75ea3b0a46df6/packages/ozone/src/api/verification/revokeVerifications.ts
[B4]: https://bsky.social/about/support/community-guidelines
[B5]: https://bsky.social/about/support/tos
[B6]: https://github.com/bluesky-social/atproto/blob/66ce7c5fde851be67c0b36362ef75ea3b0a46df6/packages/bsky/lexicons/app/bsky/graph/verification.json
[B7]: https://github.com/bluesky-social/atproto/blob/66ce7c5fde851be67c0b36362ef75ea3b0a46df6/packages/bsky/src/views/index.ts
[B8]: https://github.com/bluesky-social/atproto/blob/66ce7c5fde851be67c0b36362ef75ea3b0a46df6/packages/ozone/src/verification/issuer.ts
[BL]: https://github.com/bluesky-social/atproto/blob/66ce7c5fde851be67c0b36362ef75ea3b0a46df6/LICENSE.txt
[M1]: https://docs.joinmastodon.org/user/profile/#link-verification
[M2]: https://microformats.org/wiki/rel-me
[M3]: https://github.com/mastodon/mastodon/blob/4e7c02372b1e26e1a237739243ccdc4820c32fd5/app/services/verify_link_service.rb
[M4]: https://github.com/mastodon/mastodon/blob/4e7c02372b1e26e1a237739243ccdc4820c32fd5/app/models/account/field.rb
[M5]: https://github.com/mastodon/mastodon/blob/4e7c02372b1e26e1a237739243ccdc4820c32fd5/app/models/account.rb
[M6]: https://github.com/mastodon/mastodon/blob/4e7c02372b1e26e1a237739243ccdc4820c32fd5/app/workers/verify_account_links_worker.rb
[ML]: https://github.com/mastodon/mastodon/blob/4e7c02372b1e26e1a237739243ccdc4820c32fd5/LICENSE
[C1]: https://musicbrainz.org/relationship/fe33d22f-c3b0-4d68-bd53-a856badf2b15
[C2]: https://musicbrainz.org/doc/How_to_Create_an_Account
[C3]: https://musicbrainz.org/doc/Introduction_to_Voting
[C4]: https://musicbrainz.org/doc/Code_of_Conduct
[C5]: https://musicbrainz.org/relationship/99429741-f3f6-484b-84f8-23af51991770
[C6]: https://github.com/metabrainz/musicbrainz-server/blob/bade3a567e20ec69323ac7850fca9d0ee113f87d/lib/MusicBrainz/Server/Edit/Relationship/Create.pm
[C7]: https://github.com/metabrainz/musicbrainz-server/blob/bade3a567e20ec69323ac7850fca9d0ee113f87d/lib/MusicBrainz/Server/Edit/Relationship/Delete.pm
[C8]: https://github.com/metabrainz/musicbrainz-server/blob/bade3a567e20ec69323ac7850fca9d0ee113f87d/root/user/UserProfile.js
[CL]: https://github.com/metabrainz/musicbrainz-server/blob/bade3a567e20ec69323ac7850fca9d0ee113f87d/COPYING.md
[W1]: https://www.wikidata.org/wiki/Property:P856
[W2]: https://www.wikidata.org/wiki/Property:P553
[W3]: https://www.wikidata.org/wiki/Wikidata:Verifiability
[W4]: https://www.wikidata.org/wiki/Help:Ranking
[W5]: https://www.wikidata.org/wiki/Wikidata:Requests_for_deletions
[W6]: https://github.com/wikimedia/mediawiki-extensions-Wikibase/blob/4912c5f4ac553025d573bd79e721769e5297cd6a/repo/includes/Store/EntityPermissionChecker.php
[W7]: https://github.com/wikimedia/mediawiki-extensions-Wikibase/blob/4912c5f4ac553025d573bd79e721769e5297cd6a/repo/includes/Api/RemoveClaims.php
[WL]: https://github.com/wikimedia/mediawiki-extensions-Wikibase/blob/4912c5f4ac553025d573bd79e721769e5297cd6a/COPYING
[T1]: https://partner.steamgames.com/doc/store/creator_homepage
[T2]: https://partner.steamgames.com/doc/gettingstarted/onboarding
[DL1]: https://musicbrainz.org/doc/About/Data_License
[DL2]: https://www.wikidata.org/wiki/Wikidata:Licensing
[DL3]: https://github.com/bluesky-social/atproto-website/blob/main/LICENSE.txt
[R1]: ../../services/kernel/src/access/README.md#account-agent-verification
[R2]: ../../services/kernel/src/semantic/README.md#account-agents
[R3]: ../../services/kernel/src/access/routes.ts
[R4]: ../../services/kernel/src/access/account-data.ts
