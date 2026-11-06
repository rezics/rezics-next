# Web capability acceptance

This manifest covers every In row web owns or surfaces in [public scope](../scope.md).
[Web](web.md) owns served pages and transport; the linked Goals retain their kernel contracts.
These are executable specifications, not claims of implementation, passing native acceptance or visual review.
Served publication metadata, overlays and sitemap consumption live in the web app. Native and browser publication
remaining run after integration against the composed driver. Personal suite names below are reserved by the
parallel personal specification. A missing-driver verifier proves only specification execution. Product acceptance
runs `bun test <suite>` with its native driver variable configured.

The shared publication fixture is [web-publication.json](../../specs/fixtures/web-publication.json): released Book
word count/form/tag and Recipe diet definitions are prerequisites, never synthetic test releases. Each factory
owns a native kernel and a production web Worker; all served-page assertions cross real HTTP.
Owner suites listed below remain their owners' acceptance; a served-page binding marked pending does not become
covered merely by linking a kernel test.

## Subject pages, relations, editions and credits

- **User job**: Read a work, release or agent, traverse every related item in order, understand qualified credits,
  and inspect competing sourced claims and history. Catalogue contributions, identity resolution and vertical
  editors surface semantic's definitions and APIs, including provider-imported facts rather than a second model.
- **Personas**: Anonymous reader, editor, verified agent; hidden-source controls.
- **Fixture data**: Released Book with author, 1,200,001 words, light-novel form and harem tag; Recipe; game and
  distinct release; three agent kinds; 105 reverse-created, explicitly ordered targets per full view, withheld
  targets, qualified credits, competing dates and two attributed sources. Imported facts retain provider provenance.
- **Surfaces**:
  catalogue — `subject-traversal` cases below; semantic editors/import attribution are pending served-page bindings of semantic/imports acceptance.  
  curated — shared subject links lead to the same full views; `subject-traversal` freezes destination behaviour; source-to-destination navigation binding pending.  
  Everything without state — `library-surfaces` (personal suite) freezes navigation; full views use `subject-traversal`; combined binding pending.  
  own state — `library-surfaces` (personal suite); public subject traversal remains anonymous, own facts hydrate separately.  
  mounted Zone — `subject-traversal` destination binding pending through semantic's routed Zone composition.  
  configured TypeList — `subject-traversal` destination binding pending through search's configured presentation slot.
- **Scenarios**: `specs/web-publication-outcomes.test.ts`: `subject-traversal: editions are reachable once in declared order across full pages`;
  `subject-traversal: contents are reachable once in declared order across full pages`;
  `subject-traversal: cast is reachable once in declared order across full pages`;
  `subject-traversal: crew is reachable once in declared order across full pages`;
  `subject-traversal: inverse credits are reachable once in declared order across full pages`;
  `subject-traversal: relations are reachable once in declared order across full pages`;
  `subject-traversal: credit character credited name position and spoiler retain their meaning`;
  `subject-traversal: Details reaches competing sourced date and editorial history`.
  Semantic owns `services/kernel/test/semantic/relations-uncapped.test.ts` and `context-relations.test.ts`;
  imports owns `specs/imported-field-outcomes.test.ts` producer provenance. Editor and import UI binding pending.
- **Acceptance command**: `bun specs/support/verify-outcome-suite.ts specs/web-publication-outcomes.test.ts WEB_PUBLICATION_DRIVER "Web publication driver is required"`.

## Publication metadata, sitemaps and sharing

- **User job**: Discover and share a public page whose canonical identity, previews and structured facts agree with
  the page; crawlers find every eligible URL and no private one. Public agent/profile pages preserve one agent,
  one page, regardless of whether the agent is a human, organization or automated account.
- **Personas**: Anonymous crawler/reader, Alice warming cache, Bob, verified agent, editor with privileged sources.
- **Fixture data**: Seven vertical subjects, withheld author/tag/source sentinels, all launch locales, stale zh-Hans
  slug, verified handle, alternate configured origin; 23 eligible resources of each sitemap kind, applicable private/unlisted/
  taken-down controls, tiny feed pages and an empty nonterminal page, known public last-change times (omitted where genuinely unknown).
- **Surfaces**:
  catalogue — `published-vertical-metadata` and `public-discovery-and-cache` cases below.  
  curated — `public-discovery-and-cache: robots and every sitemap shard publish exactly eligible native feed URLs`.  
  Everything without state — out of scope for indexing: personal library routes are disallowed/noindex; public destinations use metadata scenarios.  
  own state — `public-discovery-and-cache` cache isolation and hydration cases; personal state never enters public metadata.  
  mounted Zone — shared-fact canonical uses the general subject URL; served Zone binding pending under Zones capability; nonpublic routes noindex.  
  configured TypeList — filtered/search pages are noindex; destination publication uses `published-vertical-metadata`; slot binding pending.
- **Scenarios**: `specs/web-publication-outcomes.test.ts`:
  `published-vertical-metadata: Book publishes author word count light-novel form and harem tag`;
  `published-vertical-metadata: Recipe publishes instructions diet and PT25M cook time`;
  `published-vertical-metadata: game metadata agrees with the rendered work`;
  `published-vertical-metadata: release metadata preserves release identity and facts`;
  `published-vertical-metadata: person metadata agrees with the rendered person`;
  `published-vertical-metadata: organization metadata agrees with the rendered organization`;
  `published-vertical-metadata: automated account metadata agrees with the rendered agent`;
  `published-vertical-metadata: withheld facts are absent from HTML and JSON-LD`;
  `published-vertical-metadata: stale slug redirects to the canonical localized slug`;
  `published-vertical-metadata: verified agent subject redirects to its handle page`;
  `published-vertical-metadata: configured alternate public origin is canonical`;
  `public-discovery-and-cache: robots and every sitemap shard publish exactly eligible native feed URLs`;
  `public-discovery-and-cache: Alice warming a public page cannot leak personal facts to anonymous or Bob`;
  `public-discovery-and-cache: private hydration requires Alice current authority`.
  Semantic/content/commerce own native publication feeds; web owns export consumption and served documents.
  Focused bun tests pin overlay HTML, JSON-LD, sharing heads, home TypeList catalogue admission and the question-management browser transport; they do not replace the composed native driver.
- **Acceptance command**: `bun specs/support/verify-outcome-suite.ts specs/web-publication-outcomes.test.ts WEB_PUBLICATION_DRIVER "Web publication driver is required"`.

## Page states

- **User job**: Distinguish preparation, outage, denial, hidden resources and a genuinely empty list, with useful
  retry guidance. A successful sparse native page, including one with no visible entries, retains its exact opaque
  continuation and offers an explicit next read. Only the native terminal frontier establishes exhaustion;
  recovery never refills a sparse page or turns it into known empty.
- **Decision**: Retire withdrawn public bodies, metadata and callbacks together; explicit recovery admits a new
  native reading with current locale/viewer/CSRF provenance, without reusing a retired continuation.
  Preserve native observation timestamps and subject action advice; route viewer identity supplies no subject grants.
  Question directory and caption-history windows share the existing Stay/Leave control; an equal address
  rerender keeps the admitted read and its keyboard focus, while a changed address retires its authority.
  Empty is the terminal frontier only: a nonterminal sparse page keeps its continuation and renders as sparse.
  Typecheck repairs in the web workspace change types only; test assertions and runtime authority stay as they were.
  Native identity recovery admits only HTTP 202, polls its supplied Location under the current session until
  `done:true`, and then follows the supplied canonical return. Keep native producers and reader ownership;
  integrated typing closes the diagnostic sweep, while native, served-persona and promoted acceptance remain separate.
  Decision: the default reader supplies QueryClient when the router has not; isolated Subject markup reuses that
  composition without a RouterProvider, and tag return uses the visit currentHref or the subject fallback. Public
  CollectionList destinations stay linked; collection.get does not hide public Collection addresses. Copies
  unknown/unavailable sessions show unavailable with safe sign-in and do not start private reads.
  Preview CollectionList still hides empty; a paged empty/sparse page keeps native continuation. Isolated Subject
  community markup keeps native cards and current-context identity; write `subject=` board destinations stay absent
  without native advice. Preview empty CollectionList renders no list slot; the page artwork host may wrap that
  absence. Pin these in focused Subject community, CollectionList, Copies session and Person Location tests;
  native/served/browser acceptance stay deferred. The focused runner admits repo-relative, app-relative and
  absolute test-file selectors for the child `apps/web` cwd; verification owns that selector contract.
  Land the retained recovery with main's published client types, typed repairs and closed notification-kind decoder;
  finish diagnostic work at the normal changed-workspace check, with strict settlement and server-boundary tests.
- **Single producers**: question-management page and label-history admission uses the published `@rezics/client` runtime schemas, and the subject page envelope filters viewer and actions once in `cataloguePageBody`; the web keeps no parallel contract copy.
- **Personas**: Anonymous, Alice, native suspended persona; real dependency outage and projection barrier.
- **Fixture data**: Cold subject view held behind its real worker, unavailable owner, private/unknown Collection,
  empty public list, native `suspended` persona from `services/kernel/test/support/personas.ts` with a
  pre-suspension bearer revoked by suspension (HTTP 401, problem code `invalid_credentials`,
  `WWW-Authenticate: Bearer error="invalid_token"`); correct-password sign-in is refused with
  403 ACCOUNT_SUSPENDED and creates no session.
- **Surfaces**:
  catalogue — preparing/unavailable cases below.  
  curated — private Collection 404 and empty public list cases below.  
  Everything without state — `library-surfaces` (personal suite); page-state served binding pending.  
  own state — suspended bearer case below and `library-surfaces` (personal suite).  
  mounted Zone — `page-states` shared state binding pending with semantic's Zone suite.  
  configured TypeList — `page-states` useful/preparing binding pending with search's page composition.
- **Scenarios**: `specs/web-publication-outcomes.test.ts`:
  `page-states: preparing subject view is useful retryable and does not cache an error`;
  `page-states: unavailable owner read serves an unavailable page with Retry-After`;
  `page-states: private Collection is indistinguishable from missing to anonymous`;
  `page-states: empty public list explicitly says it is empty`;
  `page-states: native suspended persona personal read is 401 invalid_credentials with invalid_token challenge and no personal content`.
- **Acceptance command**: `bun specs/support/verify-outcome-suite.ts specs/web-publication-outcomes.test.ts WEB_PUBLICATION_DRIVER "Web publication driver is required"`.

## Search page

- **User job**: Find released catalogue subjects through native search, see results in native order and localized
  deduplicated facet values, without engine totals or withheld classifications influencing disclosure.
- **Personas**: Anonymous zh-Hans reader; hidden classification controls owned by search.
- **Fixture data**: Three matching Book titles with native order differing from insertion order, released
  light-novel/harem Concepts labelled in zh-Hans, public and withheld controls; real index and facet responses.
- **Surfaces**:
  catalogue — `search-page` case below.  
  curated — `library-surfaces` (personal suite) filter UI binding; commerce owns curated query behaviour.  
  Everything without state — `library-surfaces` (personal suite); search/commerce own native filtering.  
  own state — `library-surfaces` (personal suite), owner-population filtering, never a public inference.  
  mounted Zone — out of scope for this suite: requires semantic's native routed Zone/search binding.  
  configured TypeList — pending served-page binding of search's `specs/pages-outcomes.test.ts` configured search slots.
- **Scenarios**: `specs/web-publication-outcomes.test.ts`:
  `search-page: anonymous zh-Hans Book search renders native order localized unique facets and no engine totals`.
  Search owns `specs/search-outcomes.test.ts` and `specs/pages-outcomes.test.ts`; commerce owns Collection consumers.
- **Acceptance command**: `bun specs/support/verify-outcome-suite.ts specs/web-publication-outcomes.test.ts WEB_PUBLICATION_DRIVER "Web publication driver is required"`.

## Library, Collections, progress and copies interfaces

- **User job**: Organize a library with profiles, independent labels, curated and built-in dynamic Collections,
  progress/history and holdings/copies; follow subjects and expose only explicitly published facts. Export a public
  Collection as schema.org ItemList. No user-saved dynamic queries or following feed are implied.
- **Personas**: Alice, Bob, anonymous visitor, delegated/unscoped actor, suspended bearer.
- **Fixture data**: Book boundary/unknown word counts and form/tag controls, Recipe cooking histories, state-only,
  label-only, history-only and holding-only support, shell/follow-only controls, duplicate curated occurrences,
  public/unlisted/private Collections, two profile releases, withheld facts and overlapping mounted sources.
- **Surfaces**:
  catalogue — `library-surfaces` subject controls, personal hydration isolation in publication suite.  
  curated — `library-surfaces`, served-page binding of commerce's curated membership/filter/ItemList cases.  
  Everything without state — `library-surfaces`, served-page binding of commerce's support-union/filter cases.  
  own state — `library-surfaces`, served-page binding of commerce's state/progress/labels/copies cases.  
  mounted Zone — `library-surfaces` controls; semantic Zone mounting binding pending.  
  configured TypeList — `library-surfaces` shared subject controls; configured-slot binding pending.
- **Scenarios**: `specs/web-personal-outcomes.test.ts`: `library-surfaces` (parallel specification).
  Commerce owns `specs/library-outcomes.test.ts`, including `public private and unlisted Collections enforce owner other and anonymous visibility`
  and `members preserve first after last moves notes deletes and duplicate subjects across pages`, and
  `specs/dynamic-collections-outcomes.test.ts`, `specs/library-profiles-outcomes.test.ts`,
  `specs/library-labels-outcomes.test.ts`, `specs/library-listing-freshness-outcomes.test.ts`.
  Accounts/commerce own follow edges and owner-only follower counts; web follow/count binding pending.
- **Acceptance command**: `bun test specs/web-personal-outcomes.test.ts` with `WEB_PERSONAL_DRIVER` configured
  to its native binding; pending parallel suite delivery. Publication privacy cells use the publication verifier above.

## Session transport, uploads and downloads

- **User job**: Use a secure session BFF, complete uploads and download authorized media while preserving caller
  identity and the current API decision on every request, including after revocation.
- **Personas**: Alice, Bob, anonymous, suspended and revoked session, delegated agent.
- **Fixture data**: Real Auth sessions, upload intent/completion, public/private media and attachments, current
  download authorization and source-fence controls; no signed redirect treated as lasting authority.
- **Surfaces**:
  catalogue — `session-transport` covers subject cover/media requests.  
  curated — `session-transport` shared transport binding.  
  Everything without state — `session-transport` current session authority.  
  own state — `session-transport` upload/download and revocation.  
  mounted Zone — `session-transport` shared transport, routed-site binding pending.  
  configured TypeList — `session-transport` shared media BFF requests; Alice upload/completion and Bob/anonymous,
  revoked and suspended refusal cases use the real personal binding. Delegated session fixture binding remains pending.
- **Scenarios**: `specs/web-personal-outcomes.test.ts`: `session-transport` (parallel specification).
  Content owns `specs/content-media-outcomes.test.ts` and `specs/content-disclosure-outcomes.test.ts` native
  authorization/disclosure; accounts owns session lifecycle. Web is their served-page/BFF binding. Attachment publish,
  reply, type refusal and recovery on the native host are in `apps/web/tests/native/publish-attachment-reply.host.test.ts`.
- **Acceptance command**: `bun test specs/web-personal-outcomes.test.ts` with `WEB_PERSONAL_DRIVER` configured
  to its native binding; pending parallel suite delivery.

## Auth pages

- **User job**: Sign up, sign in, consent, step up and manage security, preferences and account deletion through
  accessible Auth journeys; agent participation uses explicit consent and grants, never operator rights alone.
- **Personas**: New visitor, returning human, delegated agent/principal, revoked and suspended accounts.
- **Fixture data**: Auth-issued credentials, consented scopes, real session epochs, step-up challenge, preferences
  and deletion lifecycle. No email notification or public follower-count promise.
- **Surfaces**:
  catalogue — `auth-journeys` entry and return navigation.  
  curated — `auth-journeys` guarded-action entry; per-route binding pending.  
  Everything without state — `auth-journeys` sign-in boundary.  
  own state — `auth-journeys` native security, Web preferences and Auth deletion entry.
  mounted Zone — `auth-journeys` shared Auth origin; routed return binding pending.  
  configured TypeList — out of scope as an Auth renderer: this is catalogue presentation, with shared Auth entry navigation.
- **Scenarios**: `specs/web-personal-outcomes.test.ts`: `auth-journeys` (parallel specification).
  Accounts owns `specs/account-lifecycle-outcomes.test.ts` and `specs/account-authorization-outcomes.test.ts`;
  web/Auth pages bind those behaviours. The personal binding follows Web's existing account-menu link to Auth
  security; step-up resumes that native page, preferences visit Web settings, and deletion visits Auth's deletion
  page without applying deletion. First-party standing-consent review remains distinct from third-party approval.
  Explicit delegated agent/principal acceptance needs the Accounts native delegation fixture binding; operator
  sessions do not substitute for it.
- **Acceptance command**: `bun test specs/web-personal-outcomes.test.ts` with `WEB_PERSONAL_DRIVER` configured
  to its native binding; pending parallel suite delivery.

## Checkout start and return

- **User job**: Inspect an offer, start checkout, return and see an authoritative order/entitlement result; a redirect
  never proves fulfilment. Access acquired media through current entitlements. Points remain deferred.
- **Personas**: Buyer Alice, unrelated Bob, anonymous visitor, suspended bearer.
- **Fixture data**: Two offers with different targets and equal prices, controlled checkout snapshots, private and
  public benefits, pending/paid/failed order states and entitlement-protected downloads.
- **Surfaces**:
  catalogue — `checkout-journey` offer entry.  
  curated — `checkout-journey` shared offer destination; source navigation binding pending.  
  Everything without state — out of scope as a checkout renderer: library discovery links to offers, never fulfils purchases.  
  own state — `checkout-journey` order/entitlement return; `session-transport` download.  
  mounted Zone — `checkout-journey` shared checkout destination; routed return binding pending.  
  configured TypeList — out of scope as an order renderer: configured catalogue rows may link to shared offer pages.
- **Scenarios**: `specs/web-personal-outcomes.test.ts`: `checkout-journey` and `session-transport`
  (parallel specification). Commerce owns `specs/commerce-outcomes.test.ts` offer/order/fulfilment cases;
  web is their served-page binding, not a replacement payment model.
- **Acceptance command**: `bun test specs/web-personal-outcomes.test.ts` with `WEB_PERSONAL_DRIVER` configured
  to its native binding; pending parallel suite delivery.

## Community and content surfaces

- **User job**: Read boards/threads/posts/replies, publish and revise attributed content, rate/review with the proper
  population, join Realms/Spaces, report and resolve moderation with minimal appeals, and receive in-app reply,
  mention and moderation notices with per-kind preferences and send-time access checks.
- **Personas**: Anonymous, author/member, moderator, banned member with independent read grant, outsider,
  native suspended persona and notification recipient.
- **Fixture data**: Public/protected Realm and Space, paged boards/threads, revision history, licences, Global
  privacy-threshold votes and private Realm controls, reports/appeals, reply/mention notices, revoked read access.
  Articles/hosted works remain closed behind grants until polished; email notices remain out of scope.
- **Surfaces**:
  catalogue — `public-discovery-and-cache` covers public URLs; community/rating/review interaction binding pending.  
  curated — out of scope as a board renderer; links lead to shared community routes, whose binding is pending.  
  Everything without state — out of scope as a discussion population; this is the personal library, not a following feed.  
  own state — out of scope for this suite: notification/preference/moderation inbox journeys need their own served-page binding.  
  mounted Zone — out of scope for this suite: routed Realm/Space/community composition needs its native served-page binding.  
  configured TypeList — out of scope as a posting renderer; configured discussion/figure slots bind content/search contracts, pending.
- **Scenarios**: Publication suite's `public-discovery-and-cache` cases cover public inventory and cache only;
  its private hydration case includes the protected ban-over-independent-grant control. Content owns
  `specs/community-outcomes.test.ts` (`anonymous reads public Realm boards and every thread sort but cannot create join react or post`,
  `protected Realm non-member sees unknown-equivalent 404 and owner addition enables reading and posting`),
  `specs/content-thread-outcomes.test.ts` (`anonymous reads published thread post and reply but cannot create or revise`),
  `specs/content-notification-outcomes.test.ts` and native rating/moderation cases. Their full web bindings remain pending.
  New served cases use the native `suspended` persona from `services/kernel/test/support/personas.ts`:
  its pre-suspension bearer gets HTTP 401 with problem code `invalid_credentials` and
  `WWW-Authenticate: Bearer error="invalid_token"`, and correct-password sign-in gets
  `403 ACCOUNT_SUSPENDED` with no session; ban precedence still applies.
  Older contradictory owner assertions are not silently edited or adopted here.
- **Post revision history continuation**: Explicit continuations focus the newly admitted revision heading; empty and
  terminal pages get concise localized status; retry controls retain focus across failures; retired scopes cannot
  announce or focus old data.
- **Acceptance command**: Publication verifier above for discovery/cache cells. Owner acceptance:
  `bun test specs/community-outcomes.test.ts specs/content-thread-outcomes.test.ts specs/content-notification-outcomes.test.ts`
  with their native drivers; this does not establish the pending web interaction bindings.

## Zones as routed sites

- **User job**: Browse a routed site over saved scopes and mounted Collections, preserving source disclosure,
  overlap/alias handling, native ordering, useful preparation and canonical public subject identities.
- **Personas**: Anonymous visitor, Zone editor, Alice with private mounts, Bob, banned/suspended reader.
- **Fixture data**: Public Zone mounting a curated Collection and overlapping saved scope, public/private/unlisted
  controls, long Book/form/tag filters, recipe controls, withheld facts, duplicate/alias targets and sparse pages.
- **Surfaces**:
  catalogue — `subject-traversal` and `published-vertical-metadata` destination behaviour; Zone-to-catalogue binding pending.  
  curated — out of scope for this suite: semantic's mounted Collection routing needs a native served-page binding.  
  Everything without state — out of scope as a public mount: private owner population cannot become public by routing.  
  own state — `library-surfaces` personal controls; authenticated mount binding pending under semantic/commerce authority.  
  mounted Zone — routed `readPage` binding: native ordered members, overlap/alias uniqueness, sparse continuation, private-mount SSR isolation, same-tab Subject return, and current personal session/media on each BFF request.  
  configured TypeList — Search keeps Global `/search/list` controls; Zone lists stay on the Zone reader.
- **Scenarios**: Semantic owns Zone native acceptance and `specs/collection-source-outcomes.test.ts` source
  composition; search owns `specs/pages-outcomes.test.ts` configured page slots. Web's publication destination
  scenarios and personal `library-surfaces` cannot alone prove a routed Zone; no full binding is claimed here.
- **Acceptance command**: `bun test specs/collection-source-outcomes.test.ts specs/pages-outcomes.test.ts` with
  their native drivers for owner contracts; publication verifier above for destination cases. Routed Zone lists bind
  native `readPage` slots, Zone continuation, private-mount SSR isolation and same-tab Subject return; Search TypeList
  stays Global. This slice is pinned by scoped web and presentation tests; mounted native/page return stays pending.
  Broader native collection-source/configured-page persona acceptance remains the owner suites.
  Decision: existing scoped web and presentation tests pin this slice; no extra stories.
