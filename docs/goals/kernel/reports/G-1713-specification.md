# Explicit public disclosure reads and cursor binding

Read-only audit of [G-1591](../tasks/G-1591.md), including Decision 0, at
`2142c780d599752610ef0c35be9c268dbea3389c`. Only this report is changed. No product
code, test, generated artifact, server or QA run was changed or started.
Line references below describe this checkout, not a proposed implementation.
All source paths are relative to this worktree; `M/` means
`services/main/src/modules/`, `R/` means `services/main/src/routes/`, and `W/`
means `apps/web/`. Implementation workers must expand these prefixes.

## Decision and evidence boundaries

Keep Program's decision: public disclosure reads accept the **URL query
parameter** `mode=public|viewer`, eventually defaulting to `public`. This applies
to POST reads too; do not add a second mode to a Filter document, template
presentation or acting-subject field. Public ignores credentials for disclosure,
personal signals and mutes. Viewer requires a credential and uses that
principal's current disclosure profile. Viewer is not authority to read private
Works, Realms, drafts or another Agent's inventory. Mine and existing private
capabilities retain their admission, actor selection and private cache policy.

The owner decision belongs in [the API contract](../../../contracts/api.md#installed-http-contract)
(`docs/contracts/api.md:9–19`), beside its
[cursor requirement](../../../contracts/api.md#contracts-still-requiring-profiles-and-tests)
(`:83–90`). Record the reason there: a credential identifies a principal; it does
not request personalization. Explicit public output has one disclosure domain,
avoids accidental opt-in delivery, and permits caching when the route's other
conditions permit it. The prelaunch change is cheaper than keeping an implicit
credential-dependent public contract. Supporting query semantics already bind
preference and disclosure revisions in `docs/contracts/queries.md:124–138`.
This report is a dispatch specification, not a second decision owner.

Important corrections to the original task's description:

1. `M/work/read-cursor.ts` **does not exist**. Encryption, binding hashing,
   decode/encode, the session and public wrapper are in
   `M/work/read-session.ts:43–104,154–155,334–342`.
2. The public wrapper does verify an optional bearer and passes
   `disclosureViewer(principal)` into an otherwise anonymous Work session.
   `M/display-language/public-request.ts:4–9` strips authorization;
   `session.principal` stays null. Some bindings already contain `session.viewer`
   (resource-list, discovery concepts/sections, rating populations); ranked
   catalogue also checks mute generation. This is not uniformly an unbound
   account ID bug.
3. `disclosureViewer`'s effective profile is signed-in state, age, country and
   effective category opt-ins (`M/disclosure/viewer.ts:19–29`). It does **not**
   contain mutes. Principal-associated name/media evidence lives in WeakMaps
   (`viewer.ts:10–12`, `M/media/visibility.ts:9–17`). Hashing only enumerable
   profile fields cannot prove equivalence for every principal-aware name read.
4. Ordinary interactive `read`, `summary`, `search`, `typeahead`, `feed`,
   `thread` and `count` disclosure does not itself apply age/category eligibility.
   `M/disclosure/read.ts:63–67,108,186–190,209–213` applies that default to
   noninteractive delivery channels. Summary avatars carry assessment/concealment
   metadata (`M/media/summary.ts:98,247`). Thus the original assertion that
   ordinary Work-list *items* necessarily differ with age/opt-ins is not
   established by this checkout. Do not add a second suitability decision or
   change the existing disclosure owner's policy merely to make that assertion
   pass. Principal-aware names, authority-bearing branches, explicit discovery
   signals and search mutes are concrete sources of viewer-dependent output.
5. Fresh opaque tokens use a random AES-GCM IV
   (`M/work/read-session.ts:72–78`). Two separate equivalent requests cannot be
   expected to return byte-identical cursors, even without credentials.
   Test identical public items and **equivalent bindings/continuations**:
   either token must continue under public with or without a bearer to the same
   next items. Do not make IVs deterministic or build a token cache. Literal
   string equality in G-1591's integration acceptance needs this correction.
6. Raw decode/encode search finds **63 source files**, including the codec
   definition, retained-membership adapter, private stores and mixed-authority
   reads. A `head -80` search is incomplete. Custom structured continuations
   are additional instances; they must be guarded too.

This establishes present code paths, not runtime reproduction or human task
success. Tests below are dispatch instructions; none were run for this audit.

## Audit: public disclosure families

Each row is a distinct read/producer, even when several use one binding family.
`N` = `cache-control: no-store`; `PN` = `private, no-store`.
`P` = public-wrapper bearer profile; `D` = direct authenticated Work session
requires `actingSubject`; `A` = explicitly anonymous. In the variance column,
`profile` means a different disclosure profile reaches hydration, not proof of
age-based item filtering. `signals` and `mutes` name owners actually consulted.
There is no mute filtering in the public wrapper itself.

| Route/read | Current cursor binding profile | Bearer today / possible answer variance | Current headers | Route and producer evidence |
| --- | --- | --- | --- | --- |
| GET `/v1/works`, global/realm | `discovery-works-v1` | P; profile reaches summaries/credits; no direct mute selection; binding lacks viewer | N | `R/discovery.ts:45–58`; `M/discovery/read.ts:29–31,56` |
| GET `/v1/works`, mine | Same; basis includes active owner | D; personal membership plus disclosure; **stay private** | N today; retain private treatment, normalize PN if needed | `R/discovery.ts:54–56`; `M/discovery/read.ts:24–31` |
| GET `/v1/discovery/concepts` | `concept-search-v1` | P; profile plus optional controlled reader signals; binding already includes viewer/signals | PN | `R/discovery.ts:29–32`; `M/discovery/concepts.ts:125–142,369`; `M/discovery/reader.ts:13–31` |
| GET `/v1/discovery/sections`, each nested section continuation | `discovery-sections-v1` | P; profile/signals; both decode and per-section encode bindings include viewer | PN | `R/discovery.ts:34–37`; `M/discovery/sections.ts:117–126,266–280` |
| GET `/v1/concepts/:id/works` | `concept-works-v1` | P; profile; binding lacks viewer | N | `R/concepts.ts:47–54`; `M/concept-page/read.ts:168–170,222` |
| POST `/v1/query`, concept-works | `concept-works-v1` | P; same producer and gap | N | `R/query.ts:138–147`; same producer |
| POST `/v1/query`, filtered/union concept works | `concept-filter-v1` | P for public scopes; profile; binding lacks viewer | N | `R/query.ts:141–145`; `M/concept-page/read.ts:286–288,373` |
| POST `/v1/query`, filtered mine | `concept-filter-v1`, owner-bearing list basis | Intended private exception; see dispatch defect below; **do not reinterpret mine as public** | N today | `M/query/compile.ts:350–358`; `M/concept-page/read.ts:264–273`; `R/query.ts:141–143` |
| POST `/v1/query`, resource-list | `resource-list-v2` (response/template still v1) | P; public membership, profile hydration; binding already includes viewer | PN | `R/query.ts:115–126`; `M/query/resources.ts:411–421,814` |
| POST `/v1/query`, release-works | `release-works-v1` | P; profile; no viewer in binding | PN | `R/query.ts:128–135`; `M/facets/release-read.ts:16–18,99` |
| POST `/v1/query`, zone-browse | `zone-browse-v3` | P; profile; binding lacks viewer | N | `R/query.ts:150–157`; `M/zone-modules/browse.ts:246–247,330` |
| POST `/v1/query`, public followed-concept-feed template | Template identity `https://rezics.com/query/followed-concept-feed`, revision 1; normalized query object | P; concept roots supplied by caller, profile hydration; actor null, viewer absent from normalized binding | PN + weak ETag, 304 | `M/query/templates/followed-concept-feed.schema.ts:4–12`; `M/query/template-read.ts:76–80,138,238,248–256` |
| POST `/v1/query`, public work-publication-years template | `https://rezics.com/query/work-publication-years`, revision 1 | P; uses public template session; no demonstrated age/category/mute change to year population | PN + weak ETag, 304 | `M/query/templates/work-publication-years.schema.ts:8–21`; same executor |
| GET `/v1/search/catalogue` | `ranked-catalogue-names-v3` | Bearer via search snapshot; profile plus explicit Access mutes; mute generation checked in token order, profile/mode absent from binding | N | `R/search.ts:180–201,217–253`; `M/search/ranked.ts:61–65,176` |
| GET `/v1/realms/:realm/modules/new-adoptions` | `zone-module-v1`, kind selector | P; profile summaries; no direct mute owner | N | `R/zone-modules.ts:37–42`; `M/zone-modules/read.ts:63–64,136` |
| GET `…/modules/recently-completed` | `zone-module-v1`, status selector | P; same | N | `R/zone-modules.ts:44–49`; same producer |
| GET `…/modules/recent-decisions` | `zone-module-v1` via adoption producer | P; same | N | `R/zone-modules.ts:51–56`; `M/zone-modules/read.ts:140–143` |
| GET `…/modules/latest-chapters` | `zone-latest-chapters-v1` | P; profile; no viewer in binding | N | `R/zone-modules.ts:58–63`; `M/zone-modules/read.ts:155–156,257` |
| GET `…/modules/discussions` | `zone-replies-v1`, kind | P; profile name/Work/reply hydration | N | `R/zone-modules.ts:65–70`; `M/zone-modules/replies.ts:21–22,107` |
| GET `…/modules/reader-quotes` | `zone-replies-v1`, kind | P; same | N | `R/zone-modules.ts:72–77`; same producer |
| GET `…/modules/genres/:context` | `zone-genres-senses-v1` | P; profile concept summaries | N | `R/zone-modules.ts:79–85`; `M/zone-modules/genres.ts:39–41,86` |
| GET `…/modules/editor-lists` | Resource-list's `resource-list-v2` | P; delegates public resource-list hydration | N | `R/zone-modules.ts:87–93`; `M/query/resources.ts:411–421` |
| GET `…/modules/browse` | `zone-browse-v3` | P; profile; no viewer in binding | N | `R/zone-modules.ts:95–103`; `M/zone-modules/browse.ts:246–247,330` |
| GET `/v1/realms/:realm/rankings` | `read-rankings-v1` | P; profile; projection remains same, delivery can differ | N | `R/rankings.ts:28–39`; `M/rankings/read.ts:34–46,201` |
| GET `/v1/rankings/trending` | `read-rankings-v1` | P; same | N | `R/rankings.ts:40–42`; same producer |
| GET `/v1/realms/:realm/modules/rising` | `read-rankings-v1`, growth order | P; same | N | `R/rankings.ts:43–45`; same producer |
| GET `/v1/rating-populations` | `rating-populations-v2` | P; profile and optional controlled reader signals; already binds both | PN | `R/rating-populations.ts:13–28`; `M/rating/populations.ts:73–87` |
| GET `/v1/authors/open-library/:author` (embedded Works preview) | `author-works-v1` | D when bearer supplied; anonymous otherwise; pure public authored Work membership, profile/author-name hydration | PN | `R/authors.ts:31–40`; `M/author-page/read.ts:168,191–195` |
| GET `/v1/authors/open-library/:author/works` | `author-works-v1` | D; same public producer, no viewer in binding | PN | `R/authors.ts:42–46`; `M/author-page/read.ts:204–211` |
| GET `/v1/agents/:id/works` | `profiles-v1`, family `works` | D; readable Agent admission plus public Work membership, summaries vary by principal authority; **mixed-authority exception** | PN | `R/profiles.ts:96–103`; `M/profiles/read.ts:333–338,385–482` |
| GET `/v1/agents/:id/collections` | `profiles-v1`, family `collections` | D; readable Agent admission, public collection partition; **mixed-authority exception** | PN | `R/profiles.ts:105–111`; `M/profiles/read.ts:489–543` |
| GET `/v1/works/:id/agent-credits` | `profiles-v1`, family `native-credits` | D; Work admission and Agent-name policy; **mixed-authority exception** | PN | `R/profiles.ts:151–156`; `M/profiles/credits.ts:139–141,162`; `M/profiles/read.ts:333–338` |
| GET `/v1/realms/:realm/works` | `realm-works-v1` | D; anonymous for no bearer; private Realm membership requires authenticated actor; public branch needs explicit disclosure mode | N plus robots/referrer policy | `R/realm-reads.ts:21,47–59,89–96`; `M/realm-reads/read-works.ts:29–30,153` |
| GET `/v1/resources/:resource/page`, merged origins section | `{owner: 'merged-facts-v1', target}` | D; target can be private; embedded names and authority are principal-dependent; **stay authority-bearing** | PN | `R/entity-pages.ts:51–66`; `M/entity-page/read.ts:276–291` |
| GET `/v1/works/:id/also-enjoyed` | `also-enjoyed-v1` | D; source Work can require authority; profile plus source/personal authority; **stay authority-bearing** | PN | `R/also-enjoyed.ts:54–64`; `M/also-enjoyed/read.ts:147–149,245` |

The public author endpoints are explicitly described as public by
`R/authors.ts:24`; their public Work inventory has no private-Work admission to
preserve. They should receive mode and drop impersonation inputs. The Agent,
Work and Realm authority-bearing branches above must not be made anonymous by
applying that transformation indiscriminately. `exposure: public` describes who
may invoke an operation, not proof that every resource/read branch is public.

Potential pre-existing mine dispatch defect: compiled filtered-mine input carries
`actingSubject` and `scope: mine`, but `R/query.ts:141–143` sends it through
`publicWorkRead`, whose nested request drops authorization. `workRead` then
rejects an acting subject without authentication (`M/work/read-session.ts:386`).
This is static evidence, not a reproduced failure. The Query slice must prove
mine still uses its authenticated owner path. If correction is outside that
worker's claim, dispatch the existing-owner defect separately; do not make mine
public to bypass the denial.

### Producers missed by a raw decode/encode search, and reads without cursors

| Read | Existing binding/continuation | Viewer and cache evidence | Required treatment |
| --- | --- | --- | --- |
| POST `/v1/queries/page`, public Work phrase variants | Structured `queryDigest`, `resultDigest`, source/index generation, offset, expiry; no mode/profile | `R/search.ts:539–624`; `M/work/search-continuation.ts:55–68,91–132`; bearer snapshot + mutes; N | Same helper's audience contribution enters query digest; preserve existing `search_restart_required` |
| POST `/v1/queries/page`, public Content phrase | Structured Content continuation, graph and Content positions | `M/content-publication/search-continuation.ts:39–44,60–92`; same outer bearer snapshot; N | Bind mode/profile through same helper even when current result set is identical |
| POST `/v1/query`, search-concepts/concept-set | Structured Query cursor, presentation digest and result digest | `R/query.ts:164–214`; `M/query/concept-set.ts:60–89`; bearer mutes; N | Add common audience contribution to query digest; keep `stale_query_result` restart |
| POST `/v1/query`, phrase search | Delegates `/v1/queries/page` | `R/query.ts:217–243`; forwards bearer/display headers; N | Forward URL mode with the delegated request, not just outer schema |
| GET `/v1/feed` | `home-feed-v1` through retained-membership adapter; personal owner, actor, blocked-person digest | `R/feed.ts:64–75`; `M/feed/read.ts:467–483`; `M/read-basis/membership.ts:18–30`; PN (`R/follows.ts`, homeHeaders) | Anonymous All branch can be explicit public. Personal Home/Following/pinned branch is already private and retains actor/owner; common helper still binds disclosure profile |
| GET Realm threads | `realm-threads-v1` through same adapter | `M/realm-reply/thread-read.ts:173–207`; private/public Realm admission | Keep retained membership, revision fences and personal authority; migrate adapter to typed binding |
| GET `/v1/search/typeahead` | No cursor, only `hasMore` | `R/search.ts:256–312`, profile snapshot/mute selection/hydration; N | Add mode despite no cursor; viewer PN; anonymous public skips mute selection |
| POST `/v1/queries`, public nonpaged profiles | No continuation | `R/search.ts:360–533`, same shared snapshot/presentation code; N | Add URL mode for public profiles; private grouped/authority profiles keep existing admission |
| GET `/v1/concepts/:id` | No cursor | `R/concepts.ts:39–46`, public wrapper, N | Add mode and dynamic viewer PN alongside concept Works |
| GET `/v1/discovery/popular-terms` | No cursor | `R/discovery.ts:60–67`, public wrapper, N | Add mode alongside discovery Works; do not fabricate a cursor |
| Address-resolution internal landing/Post reads | No cursor owned by these adapters | `M/address/resolution.ts:279,310`; explicit publicViewer or authority-bearing Work session | Retain resolution's separate authority; if a nested read exposes a continuation, ensure its session binding is inherited. Do not add mode to address ownership/mutation APIs |
| Search card hydration | No separate cursor | `M/search/result-cards.ts:183`, current disclosure viewer passed into Work session | Inherit the selected audience and mode; never choose it again from the stripped request |

## Shared implementation contract

One implementation owns construction, used by a `WorkReadSession.cursorBinding`
method and by bounded server adapters for owners without a Work session. Keep it
in `M/work/read-session.ts`; extracting its crypto implementation to the
previously nonexistent `read-cursor.ts` is optional cleanup, not a dependency.
It wraps the existing route selector without discarding query, actor, owner,
scope, source-position, revision, ordering, generation or retained-expiry fences.

- Public contribution: a versioned constant and `mode: public`, never credential
  fields, profile, personal signals or mutes. Equivalent public selectors have
  identical binding hashes regardless of bearer.
- Viewer contribution: `mode: viewer` plus a stable SHA-256 digest of a canonical
  server snapshot of the **effective viewer actually used**. Build that viewer
  once through `disclosureViewer`, and use it both for hydration/AsyncLocalStorage
  and for binding. Do not hash bearer bytes, token expiry, timestamps, arbitrary
  object insertion order, or raw content evidence whose effective opt-ins differ
  from the owner's derived values.
- Reuse each existing presentation owner for its current mute/signals revision.
  Canonicalize semantic mute rows; sort set-like entries, retaining meaningful
  order. Add their stable digest to the same audience binding when they influence
  results. Keep the owner's after-read fence. Public never loads them. A profile
  digest is not a substitute for a mute revision or a follow inventory revision.
- For principal-associated private-name delivery, include an opaque,
  principal-scoped digest contribution produced from verified evidence, within
  the same helper, rather than putting a raw issuer/subject/account identifier
  into the audience envelope. Preserve any existing actor/owner selector for
  private routes. Equal enumerable age/category profiles do not establish equal
  private-name authority; test two principals with equal preferences but different
  name authority. This contribution binds context; it does not decide access.
- Viewer mode on disclosure-only public reads leaves `session.principal` null
  and does not fetch another Agent's authority. Private sessions retain their
  existing principal and actor. Use a cached session audience snapshot instead
  of a getter that constructs different viewer instances at different stages.
- Type the result as an opaque/branded cursor binding. In the final state,
  decode/encode accept only that type. The session method and non-session adapter
  call the **same** constructor. A store that has no disclosure viewer may use
  the constant public audience contribution while retaining its private owner
  selector/admission; this does not make its HTTP operation public.
- Structured search/Query continuations hash the same constructor's result into
  their existing digest fields. Do not add a second cursor codec or problem type.

The digest is a proposal requiring the equality/variance tests below. No existing
complete disclosure-profile revision covering WeakMap authority and mutes was
found. Do not invent a new preference/authorization owner: derive binding inputs
from the verified snapshot and the existing Access/disclosure owners.

### Mismatch, rate limits and cache policy

The low-level codec currently throws `WorkReadInvalid` for any binding mismatch
(`read-session.ts:89–94`), which becomes 400 `invalid_work_read` (or Realm's
`invalid_realm_read`). A valid token under a changed audience is a changed basis,
so reuse `WorkReadExpired`/`WorkReadMoved` for this case and the existing 409
`read_basis_changed` (`R/work-reads.ts:33–36`, `R/realm-reads.ts:23–27`). Keep
malformed/tampered tokens as existing invalid-input errors. Detect audience
mismatch only after authenticating/decrypting the token; no hidden-data oracle.
The present token contains only a combined binding hash, so it cannot distinguish
an audience mismatch from an invalid selector. The foundation slice must retain
an authenticated audience digest/discriminator separately from the selector
digest inside the existing encrypted payload, both constructed by the one
helper. Keep a different query/filter selector's existing invalid-input outcome;
use the existing restart outcome for a changed mode/profile. A valid older
process-local token without the new audience metadata may require restart; it
must not be accepted with an inferred viewer. This is a small format evolution
of the same codec, not a second continuation mechanism.
Do not retry into a page with a new audience or silently interpret a token as
page one. Preserve retained membership/expiry rules. Ranked/phrase search keeps
its existing restart path; concept-set keeps `stale_query_result`.

Do not strip the incoming bearer before rate-limit admission.
`M/rate-limit/hook.ts:43–69` still attributes credentialed read/search requests
to the verified principal/class via `PrincipalBudgetCache`, even for
`mode=public`. Anonymous credentials remain peer-derived; report/correspondence/
provider exceptions and address-resolution charging stay unchanged. Public mode
may omit the **read wrapper's additional** account verification, not the rate
limit owner's verification. An invalid bearer may still be 401 at that boundary;
the guarantee is identical successful public disclosure for valid credentials.
Exposure and rate-limit-family declarations do not change.

Current inspected public cursor routes have no positive shared-cache TTL: they
are N or PN. Retain N on public responses that already use N. For the current PN
public-wrapper families (resource-list, release-works, public templates,
discovery concepts/sections, rating populations, public authors), use N in public
mode and PN in viewer mode; this does not assert a new TTL is safe. Every viewer
success, including a template 304, and viewer failure is PN. Mine/private
branches remain PN. Preserve template ETag/304 and Realm robots/referrer headers,
making ETag audience-bound. Where an owner already permits shared caching,
public may keep that policy; explicit language/content-negotiation dimensions
must still be represented. Do not copy address resolution's
`public, max-age=30, must-revalidate` (`R/addresses.ts:232`) onto live disclosure
lists. Expanding caching beyond existing freshness rules is C, not required to
repair cursor isolation.

## Ordered Luna/max slices

All implementation slices use **Luna/max**. These are bounded dispatch units,
not permission to launch intermediate defaults. Serialize slices sharing a route
or helper. Commit each completed unit; the manager owns rebasing/landing and
must check ownership before assigning files beyond G-1591's old claim. No slice
depends on Claims-into-Statements. Generated outputs are handled separately
below.

Class definitions are those in
[the kernel finish-line report](G-1632-specification.md): A means first-public
function is incomplete without the change; B means existing behavior works or
can remain gated; C means defer/cut. B adaptations below preserve working private
semantics but must finish before claiming the **universal** scan guard is green.

| Order / class | Files and current entry lines | Deliverable and proof |
| --- | --- | --- |
| 1. Audience and binding foundation — **A**, required for all public families | `M/work/read-session.ts:43–104,154–155,334–342`; `M/disclosure/viewer.ts:19`; `M/work/read-contract.ts:62` | Add common mode type/schema, one audience snapshot and branded binding constructor/session method; public anonymous, viewer requires credential; transitional omission retains legacy until coordinated flip. Preserve private workRead. Add `services/main/tests/public-read-cursor-viewer.test.ts` foundation tests; revise `services/main/tests/content-viewer.test.ts:41–60` legacy assertion only at final flip. Existing `read-basis.test.ts`, `work-read.test.ts`. |
| 2. Work discovery and concept lists — **A**, launch shelves cannot page safely otherwise | `R/discovery.ts:45–67`; `M/discovery/contract.ts` discoveryQuery/popularTermsQuery; `M/discovery/read.ts:29`; `R/concepts.ts:39–54`; `M/concept-page/contract.ts` conceptWorksQuery; `M/concept-page/read.ts:168,286` | Optional URL mode for public scopes and concept detail/Works; use helper at both concept binding variants; keep Mine admission, owner basis and actor. Tests: foundation file's Works/concept sections, existing `read-basis.test.ts`; integration `g-939-discovery.test.ts`, `read-stability.test.ts`. Split discovery and concepts into consecutive workers if claims cannot cover these six files. |
| 3. Discovery signals and concepts — **A**, signed-in suggestions are launch reads | `R/discovery.ts:29–32`; `M/discovery/concepts.ts:125–142`; `M/discovery/reader.ts:13–31`; `M/discovery/audience.ts` existing signals owner | Add mode to concept search schema, common binding. Public ignores supplied legacy personalization/actor; viewer uses only the bearer's own existing reader scope. Do not equate `personalization=false` with anonymous disclosure. Replace the public actingSubject selector with owner-resolved self, preserving the existing controlled-scope decision. Add `services/main/tests/public-read-discovery-mode.test.ts`; existing `g-964-profile-discovery.test.ts`; integration `g-964-discovery.test.ts`, `g-939-discovery.test.ts`. |
| 4. Discovery sections and rating populations — **A**, Home and rating chooser are launch reads | `R/discovery.ts:34–43`; `M/discovery/sections.ts:24–61,117–126,266–280`; `R/rating-populations.ts:13–28`; `M/rating/populations.ts:73–87` plus its input contract | Mode and self-only signals, inherit slice 3 owner resolution; replace both section binding constructions, not just decode. Viewer PN, public N. Extend discovery-mode unit; integration `g-964-discovery.test.ts:103–110`, `g-939-discovery.test.ts:831–853`. |
| 5. Query resource/concept dispatch — **A**, current web browse uses POST Query | `R/query.ts:96–126,138–147`; `M/query/resources.ts:411–421,814`; Query runtime route schema | Add optional **query** mode once on POST `/v1/query`, forward it into resource and concept public branches, preserve compiled Mine branch. Use common helper in resources instead of serializing viewer ad hoc. Add `services/main/tests/public-read-query-mode.test.ts`; existing `g-939-query.test.ts`, `g-939-list-convention.test.ts`; integration `g-939-discovery.test.ts`, `g-964-discovery.test.ts`. |
| 6. Release filtering — **A**, public catalogue facet pages are incomplete without audience continuation | `R/query.ts:128–135`; `M/facets/release-read.ts:16–18,99` | Pass already-admitted mode from slice 5; migrate release binding, preserve grouping and sort. New query-mode tests for release continuation; existing `g-851-release-query.test.ts` in unit and integration. |
| 7. Public template executor — **A**, Following topic lists use it | `M/query/template-read.ts:76–80,138,238,248–256`; `M/query/template-schema.ts:9–22`; public template schemas | Read mode from URL/admitted adapter, not template parameters; public scopes use explicit audience/helper and audience-bound ETag; work-scoped credits/adoptions/versions keep actor/private admission. Public followed-concept-feed and publication-years both covered. Add `services/main/tests/public-read-template-mode.test.ts`; existing unit/integration `query-templates.test.ts`, `read-stability.test.ts`. No query-ID special implementation. |
| 8. Ranked search and typeahead — **A**, search output and suggestions share the defect class | `R/search.ts:180–215,217–312`; `M/search/ranked.ts:61–65,176`; `M/search/result-cards.ts:183` | Mode-aware common reader snapshot/presentation selection, viewer-only mutes, pass audience to ranked helper and card hydration. Typeahead no cursor still needs mode. Preserve native generation, refill and bound checks. Add `services/main/tests/public-read-search-mode.test.ts`; existing `g-556-ranked.test.ts`; integration `g-556-ranked-catalogue.test.ts`, `g-556-ranked-large.test.ts`, `public-search-scale.test.ts`. |
| 9. Structured search and Query forwarding — **A**, a raw-codec guard alone misses these public continuations | `R/search.ts:360–624`; `M/work/search-continuation.ts:55–132`; `M/content-publication/search-continuation.ts:39–92`; `R/query.ts:85–92,164–243`; `M/query/concept-set.ts:60–89`; `services/main/src/api-contract.ts` page schemas | Bind common audience into existing digest fields; add URL mode to public POST variants; pass it through internally constructed `/v1/queries` and `/v1/queries/page` URLs. Keep grouped/private profiles' private admission. Preserve restart codes. Extend search/query-mode tests; integration `paging-authority-search.test.ts`, `public-search-scale.test.ts`, `post-search-disclosure.test.ts`. Split Work/Content continuations and concept-set forwarding consecutively if needed. |
| 10. Zone adoption/chapter modules — **A**, cookie-free Realm launch modules need stable public semantics | `R/zone-modules.ts:37–63`; `M/zone-modules/read.ts:63–64,155–156`; shared module query at route top | Mode for new-adoptions/recently-completed/recent-decisions/latest-chapters; common helper; public N/viewer PN, no exposure or population change. Add `services/main/tests/public-read-zone-module-mode.test.ts`; shared new integration sections; existing `g-828-zone-browse.test.ts` only for reached behavior. |
| 11. Zone reply/genre/resource modules — **A**, same Realm public disclosure invariant | `R/zone-modules.ts:65–93`; `M/zone-modules/replies.ts:21–22,107`; `M/zone-modules/genres.ts:39–41,86`; editor-list delegation to resources | Pass mode and migrate reply/genre bindings; editor list inherits resource helper. Preserve kind/context/revision fields. Extend zone-module unit and new integration file; existing `realm-read.integration.test.ts` for route/admission regression. |
| 12. Zone browse and rankings — **A**, traversable public catalogue/ranking modules | `R/zone-modules.ts:95–103`; `M/zone-modules/browse.ts:94–103,246–247,330`; `R/query.ts:150–157`; `R/rankings.ts:11–45`; `M/rankings/read.ts:34–46,201` | Thread URL mode through GET and POST aliases without feeding mode into filter compilation; common browse/ranking binding. Public N/viewer PN; retain ranking checkpoints and expiry. Existing `g-828-zone-browse.test.ts`, `g-939-ranking.test.ts`; new integration module cases. Split browse and ranking consecutively if needed. |
| 13. Public author Works — **A**, public author preview and continuation must agree | `R/authors.ts:24–46`; `M/author-page/read.ts:168,195,204–211`; author contract | Explicit public/viewer replaces implicit optional-actor personalization on these public-inventory reads. Both embedded preview and next page use common binding. Public N/viewer PN. Existing `author-page.integration.test.ts`, `follows-authors.test.ts`; extend common integration audience tests. |
| 14. Public Realm roster branch — **A**, public roster must be credential-independent | `R/realm-reads.ts:21,47–59,89–96`; `M/realm-reads/read-works.ts:29–30,153` | Add mode for public Realm roster hydration, retaining the existing authenticated private-Realm branch and its membership proof. Public N; viewer/private PN; preserve discovery headers. Reject impersonation inputs on the disclosure-only public branch. Existing `realm-read.test.ts`, `realm-read.integration.test.ts`. Do not silently convert the private branch. |
| 15. Feed disclosure adapter — **A** for anonymous public All, **B** for existing personal Home | `R/feed.ts:64–75`; `M/feed/read.ts:467–483`; `M/read-basis/membership.ts:15–30` | Bind disclosure audience through retained adapter; public All mode must ignore credential-dependent personal preferences/mutes. Preserve personal Following/pinned capability and its actingSubject, follows, personal owner and preferences. Do not replace its already-owned selection with a second selector. Add `services/main/tests/public-read-feed-mode.test.ts`; existing `feed.test.ts`, `feed-read-basis.test.ts`; integration `feed-home.test.ts`, `feed-read-stability.test.ts`. |
| 16 onward. Existing private/mixed cursor adapters — **B**, preserve working authority-bearing reads | Groups and file lines in the following audit/adapter table | Mechanical binding adoption only. Keep routes, actors, authority, statuses and private headers. Each group is a separate Luna/max worker; no worker receives the whole inventory. Include any source producer nested in a public page so it inherits the selected session audience. |
| Penultimate. Universal scan guard — **A**, construction guarantee required for the public class repair | `services/main/tests/public-read-cursor-viewer.test.ts`; codec signatures in `M/work/read-session.ts`; raw inventory and structured producers above | Fail on every production encode/decode call that does not consume the branded common constructor; follow import aliases and local binding variables rather than searching merely for a helper name. Raw calls are permitted only inside the codec implementation and typed retained adapter. Walk the adapter callers too. Explicitly cover structured continuation emitters. Include negative scan fixtures for direct literals, preassigned unbranded arrays, import alias bypass and new files; fixtures belong inside the test or under `services/main/tests/fixtures/`. No filename allowlist hiding unconverted disclosure sites. |
| Final. Contract generation, default and acceptance — **A**, delivers adopted behavior without silently anonymous signed-in UI | `docs/contracts/api.md:9–19,83–90`; shared mode default in `M/work/read-session.ts`; authored route/OpenAPI schemas; generated output owners below | Record decision/reason, regenerate, verify generated clients and web types; flip omission default only with Launch explicit mode in the same wave or after it. Finish shared `tests/qa/integration/public-read-cursor-viewer.test.ts`, matrix below; update old content-viewer test. No new cache system, deployment toggle or Claims work. |

Slice 3 must reuse the existing reading-identity owner, not invent another
self-selector. `M/preferences/languages.ts:14–28` already defines
`PRIMARY_READING_PERSON_SQL` / `primaryReadingPerson`, with an active primary
Person selected by provision order independently of acting context.
`M/discovery/audience.ts:22–24,37–40` already embeds this owner query for languages;
`M/follows/authority.ts:9–15` admits the principal's controlled Person. Resolve
the own reader through those owners and apply that proof to signals, joined
Realms and flags (`audience.ts:65,85`), replacing public actingSubject input.
Do not choose another first-controlled-Agent rule. A bearer without a primary
Person still has viewer disclosure; return the existing honest nonpersonalized
recommendation state rather than refusing disclosure or granting a new Agent.
The exact optional-no-Person signals outcome needs the slice's owner tests.

## Private cursor audit and mechanical adapter groups

The existing private/mixed read inventory follows. These rows are part of the
audit; they do not authorize changing private routes into public disclosure-only
reads. Each mechanical group changes at most a small family of producers and
its owner tests. Store-only cursors without a disclosure viewer are listed
separately so the final scan has no unexplained holes.

In this table, D uses the existing bearer-plus-actingSubject Work envelope,
A means summary disclosure is intentionally anonymous even when a separate
inventory owner is authenticated, O means no disclosure session, and Z means
Zone's own envelope admits a bearer only with an actor. Age/category filtering
and mutes are **not demonstrated** for these interactive reads unless an
explicit owner is named. D can differ through resource/name/media authority and
reader language preferences; that is sufficient to require audience binding.

| Read / route | Binding profile/discriminator | Bearer, disclosure and exemption | Current cache | Producer and route lines |
| --- | --- | --- | --- | --- |
| GET `/v1/works/:id/classifications` | `classifications` | D; Work/concept summaries and Mine owner; private/Mine stay | PN | `M/work/read-classifications.ts:278–285,305`; `R/work-reads.ts:84–89` |
| GET `/v1/resources/:resource/rating-contexts`, Work branch | `rating-contexts` | D; target admission; Mine stays | PN | `M/work/read-rating.ts:36–41,56`; `M/rating/target-read.ts:70–75`; `R/work-reads.ts:92–105` |
| Same route, non-Work / forProjection branch | `target-rating-contexts-v1` | D; target and acceptance admission; Mine stays | PN | `M/rating/target-read.ts:70–81,98`; same route |
| GET `/v1/rating-contexts` | `standing-rating-contexts-v1` | A; route strips auth; no demonstrated viewer variance | N | `M/rating/contexts.ts:44–47,66`; `R/rating-contexts.ts:10–15` |
| GET `/v1/works/:id/editions` | `editions` | D; Work admission/local dependency basis | PN | `M/work/metadata-read.ts:87–97,136`; `R/work-metadata.ts:114–123` |
| GET `/v1/works/:id/contents` | `contents`, Work/component/parent/language/actor | D; Work/composition/target admission; local manifest dependency position; private branch stays | PN | `M/work-contents/read.ts:249–251,307`; `R/work-contents.ts:10,18–23` |
| GET `/v1/works/:id/realizations` | `realizations` | D; readable Work/realization summaries | PN | `M/realization/read.ts:50–51,65,83,89`; `R/realizations.ts:60–64` |
| GET `/v1/works/:id/releases` | `releases` | D; release disclosure and Work coverage | PN | `M/release/read.ts:159,220,245,288–289,365`; `R/releases.ts:89–94` |
| GET `/v1/releases` identifier search | `release-identifier` | D; same admission and coverage | PN | `M/release/read.ts:457–458,490`; `R/releases.ts:60–66` |
| GET `/v1/posts/:id/identifications` | `post-identifications` | D; Post and Work admission/hydration | PN | `M/post/identification-read.ts:41–44,80–82`; `R/post-identification.ts:53–63` |
| GET `/v1/resources/:resource/wholes` | `{kind:'work-wholes',resource,actor,subject}` | D; composition admission and target resolver | PN | `M/composition/read.ts:66–68,112`; `R/composition-reads.ts:51–56` |
| GET `/v1/resources/:resource/parts` | Structure object: structure/revision/parent/reverse | D; composition page + target resolver | PN | `M/composition/read.ts:25–40`; `M/structure/read.ts:383–387,473`; `R/composition-reads.ts:45–48` |
| GET `/v1/collections/:id/works`, grain series/parts | `collection-grain-v1` object, collection/grain/actor/issuer/subject | D; private Collection admission and Work summaries | PN | `M/collection/grain.ts:39–50,92,118`; `R/collection-grain.ts:14–28` |
| GET `/v1/collections/:id` | Outer `reading-position-members-v1`, inner structure object | D; Collection admission/boundary; position mine stays | N | `M/collection/visible-page.ts:18–29`; `R/collections.ts:145–161,408–428`; inner `M/structure/read.ts:383–387,473` |
| GET `/v1/collections/:id/revisions/:revision` | Same outer/inner bindings, retained revision | D; same authority-bearing branch | N | Same collection producer/route evidence |
| GET `/v1/compositions/:id` | Structure object | D; profile-specific disclosed targets; preserve authority | N | `M/structure/read.ts:383–387,473`; `R/compositions.ts:154–163,565–603` |
| GET `/v1/compositions/:id/revisions/:revision` | Same, selected revision | D; same private/authority exception | N | Same composition producer/route evidence |
| GET `/v1/compositions/:id/seals/:seal` | `{structure,seal}` | D; seal-target callback; platform catalogue-import unchanged | N | `M/structure/seal-read.ts:77–79,98`; `R/compositions.ts:606–621` |
| GET `/v1/zones/:id/routes`, mounted Collection | Outer `zone-route-v1`, inner structure object | Z; bearer ignored without actor; private route/boundary admission stays | N + discovery headers | `M/zone/route.ts:62–70,477–497`; `R/zones.ts:449–455` |
| GET `/v1/projections` | `projection-list-v3` | D; selector, boundary and projection views; position mine stays | PN | `M/projection/read.ts:60–76,93`; `R/projections.ts:49–75` |
| GET `/v1/resources/:resource/continuities` | `work-continuities-v1` | D; resolver/boundary/continuity summaries; already binds principal/actor/languages | PN | `M/relation/traversal.ts:41–56`; `R/resource-relations.ts:42–63` |
| GET `/v1/reading-positions/:work`, chooser | `reading-position-chooser-v2` | D; boundary chooser and own resume; position mine stays | PN | `R/reading-positions.ts:56–78` |
| GET `/v1/resources/:resource/discussion` | `work-discussion-v1` | D; Work/reply admission and bodies | PN | `M/work-activity/read.ts:40,53–55,81,95`; `R/work-activity.ts:22–31` |
| GET `/v1/works/:id/history` | `work-activity-history-v1` | D; Work basis/Reply visibility | PN | `M/work-activity/read.ts:40,119–121,167`; `R/work-activity.ts:35–41` |
| GET `/v1/resources/:resource/reviews` | Context/work/language/rating/sort/owner/generation object, no named profile | D; own-review pinning/exclusion; private owner branch stays | PN | `R/reviews.ts:18,128–164` |
| GET `/v1/realms/:realm/submitted-publications` | `realm-submitted-publications-v1` | D envelope; page has no disclosure/summary call; private Realm admission can differ | PN | `M/realm-submission/publications.ts:19–23,58`; `R/realm-submissions.ts:48–55` |
| GET `/v1/realms/:realm/decisions` | `realm-decisions-v1` | D; Realm/history admission and admitted decision references; public index has no private receipts/roster | N + discovery headers | `M/realm-reads/public-decision-index.ts:125–135,197`; `R/realm-reads.ts:98–103` |
| GET `/v1/realms/:realm/threads` | `realm-threads-v1` retained adapter | D; Realm/history/body/names/votes; private branch stays | N | `M/realm-reply/thread-read.ts:201–206,320`; `M/read-basis/membership.ts:18,30`; `R/realm-reply-threads.ts:49–55` |
| GET `/v1/realms/:realm/threads/:reply`, sibling continuation | `realm-thread-siblings-v1` | D; history/identity already bound, missing explicit disclosure profile | N | `M/realm-reply/thread-read.ts:335–343`; `R/realm-reply-threads.ts:57–63` |
| GET `/v1/agents/:id/realm-contributions` | `agent-realm-contributions-v1` | D; Reply/title/body hydration; binding only author/kind | N | `M/realm-reply/thread-read.ts:569–581,598`; `R/realm-reply-threads.ts:28–46` |
| GET `/v1/resources/:resource/statements` | `subject-statements-seek-v2` | D; target/boundary/scope/reference disclosure; principal/actor already bound | PN | `M/statement/subject-read.ts:235–244,620`; `R/entity-pages.ts:71–86` |
| GET `/v1/resources/:resource/page`, embedded Statements | Same subject binding | D; embedded first page under same authority | PN | `R/entity-pages.ts:48–66`; same subject producer |
| GET `/v1/agents/:id/shelves`, embedded status page previews | `agent-status-shelf-v5` | D; profile admission, public Work cards; already contains viewer/principal/actor | PN + discovery headers | `M/library/shelf-page.ts:37–40,98`; `M/library/public.ts:34–44,48–59`; `R/library.ts:106–120,263–271,355` |
| GET `/v1/agents/:id/shelves/status/:status/works` | Same agent shelf profile | D; same public/private profile authority distinction | PN + discovery headers | Same shelf producer and routes |
| GET `/v1/realms`, deprecated directory | `realm-directory-v3` | A; stripped credentials, anonymous hydration; keep public | N | `M/realm-directory/index.ts:246–268,305`; `R/realm-directory.ts:24–30,63–70` |
| GET `/v1/lexicon/definitions` | `relation-definition-list-v1` object | A/O; explicit anonymous readability/disclosure callbacks, even for editor bearer | N | `M/lexicon/catalog.ts:37–45,94`; `R/lexicon.ts:245–263` |
| GET `/v1/me/shelves` | `reader-shelves-v1` | D; mandatory private own-reader Collection inventory; stays | PN | `M/library/read.ts:99–108,150`; `R/library.ts:235–246` |
| GET `/v1/me/shelves/status/:status/works` | `reader-status-shelf-v3` | D; personal status cards; stays | PN | `M/library/shelf-page.ts:37–40,98`; `R/library.ts:248–261` |
| GET `/v1/me/agents/:agent/works` | `studio-works-v2` | D; private Studio owner summaries; stays | PN | `M/studio/works.ts:96–104,179,219`; `R/studio.ts:55–71` |
| GET `/v1/me/agents/:agent/works/:id/chapters` | Structure object via chapter adapter | D; private Studio owner route; stays | PN | `R/studio.ts:93–110`; `M/structure/read.ts:383–387,473` |
| GET `/v1/compositions/:id/progress` | `completed-occurrences-v1` | D; own progress/readable occurrence; stays | PN | `R/progress.ts:121–167` |
| GET `/v1/me/progress-summaries/:resource`, Work releases | `work-progress-releases-v1` | D; own principal/Agent + readable coverage; stays | PN | `M/progress-summary/read.ts:37–45`; `R/progress-summaries.ts:50–61` |
| Same route, series releases | `composition-progress-v2` | D; owner/composition revision/language, delegates parts cursor; stays | PN | `M/session/series-read.ts:45–55`; `M/session/series-policy.ts:5` |
| Same route, series session candidates | `series-sessions-v1` | O within D callback; owner SQL inventory subsequently disclosed; stays | PN | `M/session/series-store.ts:15–17,38`; `M/progress-summary/read.ts:46`; `M/session/series-read.ts:56` |
| GET `/v1/me/library-export`, snapshot token | `rezics-library-export-v1` | D; own retained export snapshot/fence; stays private | PN | `M/library-export/bundle.ts:72–75,125`; `R/library-export.ts:18–31` |
| Same export, page continuation | Same export binding | D; same owner and snapshot fence | PN | `M/library-export/bundle.ts:126`; same route |
| GET `/v1/me/follows` | `follows-v1` | A disclosure, separately bearer-owned inventory; stay private, do not add public mode | PN | `M/follows/read.ts:172–178,244`; `R/follows.ts:66–74` |
| GET `/v1/me/follows/authors` | `followed-authors-v1` | A disclosure, separate bearer owner; explicitly rejects session.principal; stay private | PN | `M/follows/read.ts:267–271,302`; `R/follows.ts:76–84` |
| GET `/v1/me/memberships` | `memberships-v1` | A disclosure, separately bearer-owned inventory; stay private | PN | `R/memberships.ts:44–77,154–176` |
| GET `/v1/me/contributions` | `profiles-v1`, family `contributions`, principal/actor/library stamp selector | D; own draft admission, library and listing fences; stays private | PN | `M/profiles/library.ts:12–24,37,67`; `M/profiles/read.ts:333–338`; `R/profiles.ts:137–141` |
| GET `/v1/me/ratings` | `profiles-v1`, family `ratings`, same private selector | D; own rating slot and observation read authority; stays private | PN | `M/profiles/library.ts:12–24,71,135`; same page helper; `R/profiles.ts:144–148` |
| GET `/v1/my/submissions` | `my-realm-submissions` | O; actor-authorized SQL, no disclosure viewer; stay private | PN | `M/realm-submission/reads.ts:49–63,75`; `R/realm-submissions.ts:89–95` |
| GET `/v1/me/sessions`, target/all | `consumption-sessions-v1` | O; own Person SQL, no disclosure viewer; stay private | PN | `M/session/store.ts:54–56,81`; `R/sessions.ts:52–63` |
| Same route, Work filter | `consumption-sessions-work-v1` | O; same owner, distinct indexed filter; stays | PN | Same session store/route |
| GET `/v1/works/:id/copies` | `library-copies-v1` | O; mandatory own-reader SQL; stays private | PN | `M/library/copies.ts:137–140,149–151`; `R/library-copies.ts:62–71` |
| GET `/v1/me/library-loans` | `library-loans-v1` | O; same common libraryRecordPage; stays private | PN | `M/library/loans.ts:34`; `M/library/copies.ts:137–140`; `R/library-copies.ts:113–123` |
| GET `/v1/realms/:realm/moderation` | `moderation` | O; manager/consent-fenced SQL, no graph payload; stays private | PN | `M/management-reads/read-store.ts:117–130,160–164`; `R/management-reads.ts:92–115` |
| GET `/v1/realms/:realm/audit` | `audit` | O; manager SQL audit; stays private | PN | `M/management-reads/read-store.ts:250–252`, same common cursor; `R/management-reads.ts:118–128` |
| GET `/v1/realms/:realm/moderation/:caseId` | `decision-basis` | O; manager/report candidates; stays private | PN | `M/management-reads/decision-basis.ts:61–63,94`; `R/management-reads.ts:48–55` |
| GET `/v1/safety-cases` | `safety-queue` | O; principal/action/specialist-bound moderated SQL; stays private | N | `M/safety-queue/store.ts:135–143,226`; `R/safety-cases.ts:112–130` |

The private contribution/rating/credit adapters call `M/profiles/read.ts`'s
`pageBasis` / `nextPage` rather than the primitives themselves. Trace both
`M/profiles/library.ts` and `M/profiles/credits.ts` in the guard. The two `/me`
lists are not public-mode migration targets. `GET /v1/works/:id/agent-credits`
is in the public-family table because its anonymous branch exists, but its
private Work authority stays intact.

The following bounded adapter groups are separate **B / Luna/max** slices after
the public-family slices. Tests listed here are existing owner regressions,
not permission to run entire suites. Add focused new assertions in the named
shared cursor test for binding inputs rather than duplicating each owner test.

| Group | Claimed producer files / entry lines | Preserve and prove |
| --- | --- | --- |
| Work metadata, classifications, rating | `M/work/metadata-read.ts:97`, `M/work/read-classifications.ts:285`, `M/work/read-rating.ts:41`, `M/rating/target-read.ts:81`, `M/rating/contexts.ts:47` | Local dependency tokens, Mine/target admission; `local-read-basis.test.ts`, `work-read.test.ts` under `services/main/tests/`. Split metadata from rating/classification if necessary. |
| Realization/release/Post identification | `M/realization/read.ts:51`, `M/release/read.ts:289,458`, `M/post/identification-read.ts:44` | Authority and disclosed coverage; unit `services/main/tests/g-851-release-query.test.ts`, integration `tests/qa/integration/erasure-release-proof.test.ts`. |
| Composition/structure | `M/composition/read.ts:68`, `M/structure/read.ts:387`, `M/structure/seal-read.ts:79` | Reverse/parent/revision selectors, target callbacks and seal restart; `services/main/tests/entity-page-structural-properties.test.ts`, `tests/qa/integration/entity-page-structure.test.ts`. |
| Work contents | `M/work-contents/read.ts:249–251,307` | Header/manifest/local dependency token and nested composition cursor; `services/main/tests/work-contents.test.ts`, `services/main/tests/work-contents.integration.test.ts`, `tests/qa/integration/chapter-seek.test.ts`. |
| Collection | `M/collection/grain.ts:50`, `M/collection/visible-page.ts:20` | Outer and inner cursors, reading boundary; unit/integration `g-892-collection-grain.test.ts`, `g-908-collection-page.test.ts`. |
| Zone/projection/relations | `M/zone/route.ts:481`, `M/projection/read.ts:76`, `M/relation/traversal.ts:48` | Zone actor envelope, projection/boundary/target admission; `services/main/tests/entity-page-relations.test.ts`, `tests/qa/integration/entity-page-structure.test.ts`. |
| Resource/Agent profiles | `M/entity-page/read.ts:277`, `M/statement/subject-read.ts:244`, `M/profiles/read.ts:334,338,482,543` | Embedded origins/Statements and public/private Agent admission; `services/main/tests/profiles.integration.test.ts`, `tests/qa/integration/g-629-entity-page.test.ts`, `tests/qa/integration/agent-profile.test.ts`. Split subject-read from profile adoption if needed. |
| Co-reader recommendations | `M/also-enjoyed/read.ts:149,245` | Source authority, recommendation fingerprint, moving-graph behavior; `tests/qa/integration/also-enjoyed.test.ts`. |
| Activity/reviews | `M/work-activity/read.ts:40,55,121`, `R/reviews.ts:141,156` | Reply authority and own-review pinning; `tests/qa/integration/feed-reviews.test.ts`, new audience-binding assertion in shared unit file. |
| Realm threads/publications | `M/realm-reply/thread-read.ts:206,340,343,570,598`, `M/realm-submission/publications.ts:23` | Retained adapter/identity/history/rank fences; existing `services/main/tests/feed-read-basis.test.ts`, focused shared new integration cases. |
| Public decision index | `M/realm-reads/public-decision-index.ts:134–135,197` | Common helper, preserve public revision predicates and private Realm/history branch; `services/main/tests/realm-read.integration.test.ts`. Do not alter verification/Claim representation. |
| Reading positions/progress | `R/reading-positions.ts:70`, `R/progress.ts:149`, `M/progress-summary/read.ts:38`, `M/session/series-read.ts:47`, `M/session/series-store.ts:17` | Own state, parts/releases/session nested continuations; unit/integration `g-894-progress-summary.test.ts`, `services/main/tests/long-series-progress.test.ts`, unit/integration `g-847-reading-position.test.ts`. Split route adapters and summary adapters. |
| Public/private library shelves | `M/library/read.ts:108`, `M/library/shelf-page.ts:40`, `M/library-export/bundle.ts:73–75,125–126` | Actor/owner status and export snapshot/expiry; `services/main/tests/profiles.integration.test.ts` plus targeted cursor unit cases. Split export into its own slice. |
| Studio | `M/studio/works.ts:104,219`, nested structure adapter caller `M/studio/chapters.ts` | Private owner/chapters admission; targeted shared cursor unit cases, existing local basis test. |
| Private follows/memberships | `M/follows/read.ts:178,271`, `R/memberships.ts:77,154` | Keep anonymous **disclosure** and authenticated inventory owner distinct; `tests/qa/integration/follows-authors.test.ts`, shared cursor unit assertions. |
| Anonymous directories/catalogues | `M/realm-directory/index.ts:268,305`, `M/lexicon/catalog.ts:45,94` | Constant public audience, anonymous readability callbacks; `services/main/tests/realm-directory.test.ts`, `tests/qa/integration/realm-directory.test.ts`. |
| Private SQL personal records | `M/session/store.ts:56,81`, `M/library/copies.ts:140,151`, `M/realm-submission/reads.ts:63,75` | Non-session common constructor, unchanged owner/private contract; unit/integration `g-834-session.test.ts`, `library-copies-loans.test.ts`, targeted shared cursor unit assertions. |
| Private SQL moderation | `M/management-reads/read-store.ts:121,130`, `M/management-reads/decision-basis.ts:63,94`, `M/safety-queue/store.ts:143,226` | Non-session common constructor, unchanged manager/safety admission; `services/main/tests/management-read.test.ts`, `services/main/tests/management-read.integration.test.ts`, targeted shared cursor unit assertions. |

These groups are B because their current authority-bearing capability is not
the launch public-mode regression. They are still required mechanical work for
G-1591's promise that every cursor producer uses one constructor. If the manager
elects to defer them, scope the delivered guard claim to the migrated public
families and report the universal construction requirement as unfinished;
do not silently whitelist private disclosure reads.

## Generated contracts and proving matrix

Every route-mode slice updates its authored runtime schema and status contract,
including 401 where viewer now requires authentication. Keep exposures and rate
families intact. `services/main/src/api-contract.ts` owns legacy structured
search schemas; Query's mode remains outside the closed Filter/template body.
Auth remains optional at the operation level because public mode is callable
without it; document the conditional viewer requirement in the owner contract.

`task gen` is the producer for `generated/openapi/main/public.json`,
`generated/openapi/main/exposure.ts` (the generated exposure SDK) and
`generated/query/templates.ts`, as shown in `scripts/api/generate.ts:329–348`.
The Main document also carries platform-exposed operations; this checkout does
not have a separate platform OpenAPI output from this generator. Full generation
also refreshes model artifacts, including `packages/model/src/generated/**`;
keep those packages compiling, but do not hand-edit them. Eden client parameter
types derive from `MainApp`, not a separately generated HTTP client package
(`apps/web/features/api/main.ts:1–2`). Therefore run `task web:typecheck` after
route changes as well as checking generated SDK/packages. Outputs are generated
dependencies, **not committed** under
the worker protocol. Restore tracked generated files before each handoff and
list the artifacts the manager must regenerate. No authored model change,
Content migration or native image build is required.

Implementation QA, not audit QA: use
`bun scripts/goal/goalctl.ts test <explicit test paths>` and record QA run IDs.
Never run whole tiers or --heavy. Each slice runs its own meaningful unit files
and explicitly claimed integration sections/files; list reached tests outside
the claim for the manager. Run `task main:typecheck`, `task web:typecheck` after
route-contract changes, `task gen:check` after regeneration, and the changed-file
lint/ast-grep gates required by the worker protocol. The final documentation
slice runs `task docs:check`. The present brief says no checks; none were run.

Required cases in `services/main/tests/public-read-cursor-viewer.test.ts` and
`tests/qa/integration/public-read-cursor-viewer.test.ts`, with family-specific
test files from the slices where fixtures differ:

| Case | Observable proof |
| --- | --- |
| Explicit public and final omitted default | With identical selectors/display headers and a stable source basis, anonymous and two valid bearers yield identical items/counts/facets/ETag where present; no additional disclosure verification or mute/signal load in the public wrapper. Rate limiter still verifies/charges credentials. Compare binding hashes and cross-use continuations, not fresh ciphertext equality. |
| Viewer without credentials | 401 on every public read family, including typeahead and POST/template aliases; no fallback to anonymous. Invalid enum remains the existing validation outcome. |
| Viewer profile | Same current effective profile and audience continue; changing age/country/effective opt-ins changes binding. Use an actual owner-supported viewer-dependent name or mute fixture to prove payload difference; report if an opt-in-only item-difference premise cannot be reproduced. |
| Mutes/signals | Public ignores them; viewer uses existing owner revisions and fences. Same enumerable viewer profile with changed mutes cannot reuse token; unrelated row order does not spuriously change digest. Controlled reader changes remain fenced. |
| Audience mismatch | Public→viewer, viewer→public, and changed viewer profile refuse/restart using the family's existing code. Test when item sets happen to be equal, so resultDigest alone cannot masquerade as audience binding. Same mode/profile continues with no duplicate/gap. |
| Authority | Mine and private Work/Realm/template/session routes retain denial and actor/owner binding. Viewer does not grant private resource authority. Private Agent-name fixture distinguishes principals with equal age/category preferences. |
| Stale/concurrent | Profile/mute/follow changes between pages and during hydration never emit a page from mixed audiences; retain existing after-read fences and bounded attempts. Unavailable mute/disclosure owners preserve existing unavailable failure, never unfiltered viewer success. |
| Partial/nested reads | Section-specific page 2, editor-list resource delegation, author embedded preview, nested roster/collection/statement continuations and template ETag 304 all inherit the same audience binding. Optional previews retain their existing honest omitted/unavailable behavior. |
| Recovery/expiry | Changed graph epoch, retained expiry, process restart and source/index generations retain existing refusal/restart; audience helper cannot relax them or reset expiry. |
| Rate/cache | Bearer public uses principal read/search budget; anonymous uses anonymous identity; family unchanged. Viewer response/error/304 PN. Public preserves only the route's permitted freshness policy and no credential-derived validators. |
| Guard | New raw call, aliased raw call, unbranded local binding or structured digest emitter that omits common audience fails the scan; codec and retained adapter internals are the only infrastructure exceptions. |

Existing relevant proving files, beyond the slice table, include
`services/main/tests/local-read-basis.test.ts`,
`services/main/tests/realm-directory.test.ts`,
`tests/qa/integration/realm-directory.test.ts`,
`tests/qa/integration/also-enjoyed.test.ts` and
`tests/qa/integration/follows-authors.test.ts`. Run only files the implementation
slice changes/owns, and report other affected paths for manager regression.

## Launch web handoff

Kernel edits no `apps/web` files. This inventory is the material to send to
Launch; this worker has not sent an external message. All lines below use the
`W/` prefix. Server bearer transport is `features/api/main.ts:59`; browser Eden
uses `features/api/browser.ts:14` through `/api/main`, whose cookies become bearer
in `app/api/main/[...path]/route.ts:10` and `features/api/bff.ts:72`.
An absent token in a browser helper does not prove anonymity: use the existing
anonymous browser option when public transport is intended.

| Call site in `W/` | Route and consuming flow | Launch mode |
| --- | --- | --- |
| `features/discover/read.ts:23` | GET Works; browser loader `features/discover/query.ts:18`; shelf chooses at `features/discover/shelf.tsx:88` | viewer for signed-in non-Mine shelf, public signed out; Mine stays private |
| `features/discover/query-read.ts:33` | POST concept/filter Works; same shelf at `:88–89` | Same mode on first/continuation pages; Mine stays private |
| `features/concept/works-read.ts:29` | POST concept Works; server first page `features/concept/read.ts:35`; browser page 2 `features/concept/concept-works.tsx:29` | viewer signed in, public signed out |
| `features/concept/read.ts:32` | GET concept detail, explicitly anonymous server client | public |
| `features/saved-filter/api.ts:102` | GET concept detail, authenticated saved-filter picker | viewer; sibling concept choices must use the same disclosure mode |
| `features/discover/api.ts:152` | POST resource-list; server `features/discover/load.ts:39,57`, navigation continuation `features/discover/resource-list.tsx:88` | viewer for personal client, public otherwise |
| `features/discover/api.ts:159` | GET discovery concepts; server suggestions `features/discover/load.ts:49`; picker `features/discover/topic-picker.tsx:40` | viewer signed in, public otherwise; preserve distinct personalization control |
| `features/saved-filter/api.ts:96,105,109` | GET discovery concepts for phrase/popular/paged choices; browser client at `:60`; Home tabs/pin picker | viewer authenticated personal selection |
| Topic picker consumers `features/query/condition-bar.tsx:182`, `features/onboarding/welcome-flow.tsx:142`, `features/onboarding/topics.ts:16`, `features/communities/create-form.tsx:332` | Central discovery-concept picker above | viewer signed in; community creation does not supply an actor, which must not imply anonymous |
| `features/discover/api.ts:175` | GET sections; browse `features/discover/load.ts:62`; Home preview `features/discover/recent-shelf.tsx:14` | viewer signed in, public otherwise, including selected-section continuations |
| `features/discover/api.ts:187` | GET rating populations; server chooser `features/work-page/read.ts:50`; browser `features/work-page/scope-bar.tsx:82` | viewer signed in, public otherwise |
| `features/studio/read.ts:561`, `features/studio/realm-submit.tsx:75` | Resource-list community search/paged picker via central helper | viewer for signed-in Studio picker |
| `features/home/followed-concept-feed.ts:362` | Public followed-concept-feed template; first page `features/home/server.ts:141`, browser continuation `features/home/tabs.tsx:456` | viewer for signed-in Following topics |
| `features/search/read.ts:68` | Phrase POST Query; Discover Chapter text `features/discover/chapter-text-read.ts:10`, `features/discover/load.ts:74`; browser loader `features/search/query.ts:17`, results continuation `features/search/search-results.tsx:184` | viewer signed in, public otherwise; backend delegated page request must retain mode |
| `features/search/typeahead.tsx:25` | GET typeahead, general input at `:69` | viewer signed in, public otherwise |
| `features/post-composer/composer.tsx:179` | Typeahead Work picker | viewer for signed-in composer |
| `features/work-levels-edit/work-picker.tsx:18` | Typeahead related-Work picker | viewer for signed-in editor |
| `features/zone-editor/api.ts:221` | Typeahead editor picker, injected Main client | viewer for signed-in editor |
| `features/search/fallback.ts:16,26,29` | Typeahead and Works near-match/popular fallback; no non-test production caller found | explicit public if used; the helper's supplied client can otherwise inject bearer |
| `features/release-filter/read.ts:33` | POST release-works; bearer Work reader, `features/realm/routes.tsx:294` | viewer signed in, public otherwise; fix eligible-Agent transport caveat below |
| `features/author/read.ts:45–46` | GET external author, embedded Works preview; `app/[locale]/authors/open-library/[author]/page.tsx:34` | viewer for signed-in page shelf, public signed out; authorReader at `:18–24` must preserve bearer without an eligible Agent |
| `features/author/read.ts:53–54` | GET external author Works; `app/[locale]/authors/open-library/[author]/works/page.tsx:36`, cursor from route navigation | same viewer/public mode as preview; replace public-read actingSubject with mode, preserving separate shelf/follow authority |
| `features/zones/catalogue-facts.ts:182` | Public publication-years template; `features/zones/catalogue-browse.tsx:115–116` composes with anonymous Realm roster | Recommend explicit public for coherent catalogue facets; this is a composition recommendation, not an established Launch decision |
| `features/home/server.ts:52,53` | GET feed, personal or explicit anonymous fallback | Personal Home/Following/pinned reads retain existing private actor contract. If slice 15 exposes a separate disclosure mode there, viewer; anonymous All fallback public |
| `features/feed/api.ts:39` | Browser GET feed continuation | Same personal/public branch and mode as server first page; never remove feed owner/actor to pass mode |

Every following call in `features/realm/read.ts` uses the anonymous factory at
`:48` and stays **public**, including its navigation cursors:

| Call line | Read |
| --- | --- |
| 197 | Realm Works |
| 202 / 207 | Public decision index / detail |
| 212 | New adoptions |
| 217 | Recently completed |
| 222 | Latest chapters |
| 236 | Realm rankings |
| 246 | Rising |
| 251 | Recent decisions module |
| 256 | Reader quotes |
| 261 | Discussions |
| 266 | Editor lists |
| 271 | Genres |
| 278 | Browse |
| 306 | Realm directory |

These flow through `features/realm/modules.ts:105–106,142,149,163,312,337,354,361,385–386`,
`features/realm/routes.tsx:333,397,411,429`,
`features/zones/catalogue-browse.tsx:61`. Directory itself already strips bearer;
public is its existing behavior. Other directory calls are explicit anonymous
`features/post-composer/composer.tsx:142` and injected-client admin selection
`features/manage/read.ts:114`; both should stay public without changing manager
authority. Public decision index/detail do not become personalized merely
because adjacent roster/module reads gain mode.

No production direct web call was found for GET `/v1/concepts/:id/works`, GET
`/v1/search/catalogue`, or GET `/v1/rankings/trending`; their Query/equivalent
helpers are inventoried above. There is no active `/search` route in this tree;
search components remain callable and phrase search is active in Discover.

Already-private calls stay under their existing contract: Work templates
`features/work-page/read.ts:221,230,277` (credits/adoptions/versions), Mine,
`/v1/me/...` shelves/follows/continue, manager decision read
`features/manage/read.ts:67`, and authenticated Realm-header admission such as
`features/address/space-read.ts:60`. Kernel's audience-binding helper may reach
their producers, but Launch must not add public/viewer mode in place of private
authority. The instruction to pass viewer for signed-in following lists refers
to public-disclosure following feeds/templates; `/v1/me/follows` is already a
private owner inventory and remains so.

Other common-helper consumers keep their authority-bearing route contract:
`features/profile/read.ts:83` and `features/work-page/read.ts:301` (Agent Works),
`features/profile/read.ts:127` (Agent shelves),
`features/work-page/read.ts:322` (also-enjoyed) and `:354` (native credits).
They require no Launch mode change for the B mechanical-adapter slices. The
profile's `/me/shelves` calls at `features/profile/read.ts:102,110,118,126`
likewise stay private. Their principal/actor/boundary selectors cannot be removed
because a cursor binding gains a mode contribution.

The author helpers also feed metadata/JSON-LD at
`app/[locale]/authors/open-library/[author]/page.tsx:21,46` and
`app/[locale]/authors/open-library/[author]/works/page.tsx:21`. Keep public
metadata explicitly public if the visible shelf requests viewer; include mode
in the shared helper's request-cache arguments so metadata and body do not reuse
the wrong audience. The external-author Follow and reader-shelf state calls in
`features/author/read.ts:63,72` retain their existing private owner/actor contract.

Launch must include mode in client paging/cache keys and reset continuation when
the mode/audience changes (`features/discover/query.ts:27`,
`features/search/query.ts:29`, concept paging and picker loaders). Choosing viewer
requires preserving a bearer even when no actingSubject exists:
`features/discover/server.ts:19–20` already does; `features/work-page/read.ts:44`
currently strips it without an eligible Agent. Fix that transport for the public
viewer families, while retaining private Work authority inputs. Do not infer
sign-in solely from a selected Agent.

The BFF separately forces no-store except public media
(`features/api/bff.ts:103–107`). Backend mode does not make BFF responses shared
cacheable. Changing BFF cache policy is separate Launch-owned C work unless an
existing owner explicitly requires it.

## Landing alone and open points

No slice requires Claims-into-Statements behavior, migration or native build.
[G-1618](../tasks/G-1618.md) owns verification, Statement graph/schema/
qualification/seek, Claim/Statement write-route changes and export; no raw cursor
call was found in those authored paths. The helper migration may touch
`M/statement/subject-read.ts`, which is **not** one of those claimed Statement
files. Confirm current ownership when dispatching; do not bundle either task's
changes into the other's commit/landing.

The statement that there are literally no shared files needs one qualification:
both features regenerate Main OpenAPI, and G-1618 lists generated artifacts in
its old claim. Shared **generated** OpenAPI/model outputs are not a functional
dependency. The manager regenerates them from the latest landed authored
contracts rather than carrying stale generated diffs across the two changes.
Neither task needs to wait for the other's substantive implementation.

Safe order:

1. Land additive optional mode support for all affected API families, including
   explicit public/viewer behavior and binding. Omission temporarily retains
   current behavior, solely for the handoff; do not claim Decision 0 complete.
2. Launch makes every signed-in first-page and continuation call explicit
   `mode=viewer`, and public modules explicit `mode=public`. Personal private
   feeds/Mine/work templates retain their existing owner contract. The server
   must already accept these parameters.
3. Flip omission to `public` **with the Launch client change in the same wave**,
   or after those explicit clients are already active. A default flip before
   the client is acceptable only in that coordinated wave, never an isolated
   backend landing that leaves signed-in lists silently anonymous. Remove the
   transitional legacy omission behavior and update the old viewer test.
4. Regenerate/typecheck and land this feature alone; independently regenerate
   after Claims lands if needed. Old process-local cursors may restart normally.

Not established: runtime viewer/opt-in item variance on all named routes;
literal fresh-cursor equality (contradicted by crypto); a complete preexisting
disclosure-profile revision covering mutes/private names; the no-primary-Person
outcome of the future self-only discovery adapter; runtime behavior of the suspected Query
Mine dispatch; safe new public shared-cache TTLs; browser success after Launch's
future edits. None is presented as tested. The slices specify tests or an owner
handoff for each. No optional cache expansion or authority redesign is a
dependency on Claims.
