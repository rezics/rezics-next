# Content and communities

## Outcome

Readers, authors, members and moderators can publish and discuss content, rate and review subjects, receive eligible
in-app notices, and resolve reports. Current disclosure, authority, attribution, references and erasure apply across
boards, threads, posts, media, Spaces and Realms.

## Done when

- Readers, authors and moderators create, read, page and revise threads, posts, replies and exact revisions through
  mounted APIs. Thread creation is one partition command; edits create immutable revisions. Canonical RFC8785 bytes
  are stored as `bytea` with SHA-256, SPDX licences and exact references under the
  [document package](../../packages/document/README.md). Persistent board pins never grant visibility; active, hot
  and newest continuations skip pinned threads without losing sparse-page progress under current container-chain
  disclosure.
- Content owns the hosted-book structure and Post revision contracts for the first-public book library: ordered,
  nested parts and chapters have stable occurrence identities and support add, reorder and move; chapter revisions
  support history and comparison; explicit publication freezes a public TOC selection with its exact Post revisions.
  Unselected drafts stay private under ordinary author and reader authorization. Native API acceptance is a separate
  gate from Web's mounted author and reader acceptance. Both must meet or exceed the read-only `../rezics` behavior
  baseline at `95167ceab` and demonstrate an improvement, such as exact chapter links surviving moves with atomic
  published-revision selection. A flat native first slice alone does not satisfy the launch gate.
- Reports retain exact anchors. Takedown targets the resource partition and security revision. Erased revision bodies
  become `NULL` while exact references disclose erased availability. Author thread erasure makes bounded durable
  progress with current per-post authority; point erasure and takedown keep their synchronous contract.
- Media reservation, uploader-bound completion, derivative processing, current downloads and bounded collection of
  abandoned objects work across the Kernel and site Worker, preserving reserved, uploaded, available and rejected
  states, same-partition claims, the 24-hour collection boundary and the Sharp width ladder.
- Spaces and Realms have stable identities and partition homes, membership, roles, bans, boards, slow mode, watches,
  Context and subject publication. Publication grants no global subject ownership or rights. A ban denies protected
  reads immediately while removal continues.
- Reactions, ranking, Realm rating sorts, subject ratings and reviews expose only eligible aggregates with declared
  freshness. Reports, independent appeals, in-app reply, mention and moderation delivery honor current read access,
  send-time access and preferences.
- Public Collection, review and Space discovery, mixed Home and moderator work follow their owner disclosure rules.
  The moderator directory stays unavailable where authoritative Access currentness is unavailable; exact and manual
  report queues remain independent.
- Articles and non-book hosted works stay grant-closed until polished; media retains its existing [public-scope
  policy](../scope.md). Email and account mute/block remain deferred under [public scope](../scope.md).

Completion covers the scoped outcomes on main with recorded HTTP/API, native command/effect/relay, default-worker,
growth, installed public-root/callable, applicable browser receiving and promoted-commit checks. Specified,
implemented, exposed, tested and promoted remain separate stages; documentation advances none.

## Scope

Content includes Kernel content, community and rating services and their composed product outcomes: boards, threads,
posts, media, publication, reactions, ratings/reviews, Realm rating sorts, moderation, slow mode, watches, discovery
and minimal in-app notices. Content owns hosted-book structures and Post revisions. Web owns the shared Studio and
book reader, document package, editor, media transport and shared browser lifetimes. Accounts owns membership
authority, preferences and lifecycle ports. Semantic owns Book/Series/Edition bibliography, subjects, Context and
identity. Commerce owns personal Library, follows, Collections, financial and rights authority. Search owns public
discovery sources, results, continuations and their query and default-worker assembly.

## Ownership

Content owns `services/kernel/{src,db,test}/content/**`, `community/**` and `rating/**`.
[Content](../../services/kernel/src/content/README.md),
[community](../../services/kernel/src/community/README.md), [rating](../../services/kernel/src/rating/README.md)
and [deletion](../deletion.md) own the detailed behavior. Content owns mixed Home composition through the existing
Home port; Search owns the public discovery source/result/continuation entry, real adapters, query/default-worker
assembly and minimal caller migration. No second renderer or private Library merge is introduced. Semantic owns its
small acyclic reader for Copy/census/relocated mapping and narrow binding/import repair; Commerce owns Copy/Follow
semantics, Library and showcase Collections. Content retains census, reaction/Rating, native compiler,
installed-root, original mapping and growth acceptance.

Content's existing `document-public.ts` owns the public document schema, type and mapper consumed by routes and
Semantic. One official-client publisher owns compiler and construction inputs, schema/module/bootstrap/dependency
closure, generated callables, declarations and exports. Web consumes installed contracts without local DTOs, casts,
private native imports, generated edits or another publisher. Content supplies Board, work and edition publication
helpers; Imports owns its persona/seed wrapper and dev stack, Commerce its ranked/grid/mixed showcase Collections,
eligible offers and rights, and Accounts operator bootstrap, replay after revocation and atomic grant/receipt/event
behavior. Web completes membership/publication through its existing current-source host
after authoritative acknowledgement, admitted refresh and committed render, then focuses the eligible supplying
shelf. Return destinations cover entry only; preserve retired/unknown guards and uncertain commands without a new
host, interception or storage. Standalone ReviewList/ThreadList mounts work without Router; directory and
Previous/First controls navigate only, while selection changes reset selection-bound cursors under native authority.
The [Home](../../apps/web/src/features/feed/README.md), [threads](../../apps/web/src/threads/README.md),
[Content](../../services/kernel/src/content/README.md), [community](../../services/kernel/src/community/README.md)
and [rating](../../services/kernel/src/rating/README.md) owners retain the detailed receiving and lifecycle rules.

The shared rules are owned by [architecture](../architecture.md),
[Access](../../services/kernel/src/access/README.md),
[commands](../../services/kernel/src/command/README.md),
[events](../../services/kernel/src/events/README.md), [durable work](../../services/kernel/src/work/README.md),
the [document package](../../packages/document/README.md) and [deletion](../deletion.md). Consumers adapt to
producer-owned interfaces; Content does not copy another module's storage or authority.

Decision: Content contract/core/application/adapters separate ambient operands and native effects; composition
installs activity, current review context, exact document-media and bounded mention capabilities with real Access
reading adapters. Explicit optional outcomes preserve unknown/deleted identities, historical citations, exact
revision anchors and partial sibling presentation. Existing closed reading/history shapes and final native
authorization remain; HTTP mapping stays at the compatibility boundary. Focused application/composition tests pin
these states without new stories. Runtime/growth acceptance stays with sole Goal walks. Platform defineModule
is undelivered, so contentDeclaration()/contentHttpDeclaration() remain. Work registrations compose in
composition/work-modules.ts; startWorker binds Content and shares the original database pool with WorkClient and
composeWork. Native queue registration refuses a stub; edition consent stays explicit with no pool WeakMap.

Decision: pin Community construction with declaration inventory, ambient deadline refusal, and one populated Realm
witness revision/replay native test including stale work; no extra stories. Domain clocks stay required on holders;
deadlineNow is a separate ambient; Access-facing public entry includes realmReadEligibility. Command pools supply
declared receipt keys before setup and grants; `createKernel` reuses a pool ring when composition omits `receiptKeys`.
Policy catalogues drop resource types that did not resolve for the mounted action subset. JSON-array readers bind
keys as text so `jsonb_to_recordset` never sees a non-array. Composition tests compare installed roles with
`accessActionCatalogue` of the mounted routes. The Realm minting test records `preparePage` for the Global parent
and `prepare` for Space/Context extras, capturing the live extras attempt during prepare because
Access refuses a finished command time; extras deadline and the Space slot witness are stored on
that command attempt at prepare so authorize admits only that attempt, without a shared scalar
fallback. Growth isolation pools that run authored erasure commands bind the same dedicated
receipt-key ring as HTTP fixtures. GrantDeniedError maps to forbidden before its write-denied superclass. Native HTTP
fixtures carry dedicated receipt keys and the shared 30s request budget. Sequential fixtures unfence and re-issue tokens at the current
authentication floor after suspension and never decrease `minimum_authn_epoch`.
Boolean Realm-read and publication disclosure checks conceal eligibility `not_found` as a closed miss;
a metadata revision rechecks current visibility. The publication list fixture deletes
`search_selection_state` then the subject under Semantic erasure cleanup. Existing realm visibility
and publication disclosure tests pin those states; no extra stories.

Decision: mixed Home construction is one Content feed application over continuation, public-summary and
presentation ports. Library and Semantic own the real Continue and disclosed-summary adapters; composition
binds them once. HTTP mapping stays on the existing feed route. Missing authority is unavailable. Fewest
tests pin those states in `feed-application.test.ts` and `feed-composition.test.ts`; the existing Content walk
keeps runtime acceptance. No extra stories. Destination kinds stay distinct union members so thread, subject,
collection and account extract; public summary/Continue schemas stay TypeBox objects for composition and stamp the Content contract page types. Cover
credit obligations stay the CC literals. Existing feed tests keep their assertions.

Decision: compose Realm community, exact disclosure and Subject scope as one Content application over
consumer-owned ports; bind independent Community/Semantic evidence and Search execution at existing roots.
Focused identity, unavailable-authority and final-currentness tests preserve existing outcome assertions; no extra
stories or positive default-journey claim. Typing is implementation acceptance; the Goal walk owns runtime acceptance.

Decision: Rating counted preparation/read/finish and vote admission consume required Rating application ports;
Semantic supplies native adapters through composition. Rating owns exact readback and vote events; Semantic owns
immutable review operands. Extend vote-review for original actor/Pool/deadline/transaction handoff, receive installed
repair/default-worker acceptance, and leave native/browser/growth receiving to sole Goal walks. See the [Rating boundary](../../services/kernel/src/rating/README.md#vote-and-semantic-application-boundary).

## Dependencies

Requires Accounts membership, role, ban, preference and lifecycle ports; Access authorization and resource grants;
Semantic subject and Context publication; Commerce Library, follows and Collections; registered Kernel commands,
events and durable work; Web uploader transport and authenticated pages; and Search's public discovery projections.
Content owns only its composed outcomes and native adapters.

## Acceptance

Use [capability acceptance](content.capabilities.md) for frozen scenarios and stage distinctions,
[thread outcomes](../../specs/content-thread-outcomes.test.ts),
[disclosure outcomes](../../specs/content-disclosure-outcomes.test.ts),
[media outcomes](../../specs/content-media-outcomes.test.ts),
[notification outcomes](../../specs/content-notification-outcomes.test.ts),
[community outcomes](../../specs/community-outcomes.test.ts), native content/community/rating and
[deletion acceptance](../../services/kernel/test/content/erasure-workflow.test.ts).
Cover anonymous, author, member, moderator, banned, suspended and protected non-member personas. Exercise mounted
HTTP/API, real command/effect/relay and default-worker paths. Use owning kernel checks, installed callable/root and
receiving checks, browser evidence where applicable, growth checks and promoted-commit verification. Publisher
acceptance separately covers clean/incremental generation, workspace resolution, package dependencies, named
OpenAPI/client exports and installed callable/root; native reconciliation and consumer receiving remain separate.
Native units alone do not prove the composed workflow.

## External conditions

Object storage, image delivery and production moderation operations require configured services. Isolated repository
acceptance proves lifecycle and disclosure behavior; private operational setup remains external.
