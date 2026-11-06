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
- Articles and hosted works stay grant-closed until polished. Email and account mute/block remain deferred under
  [public scope](../scope.md).

Completion covers the scoped outcomes on main with recorded HTTP/API, native command/effect/relay, default-worker,
growth, installed public-root/callable, applicable browser receiving and promoted-commit checks. Specified,
implemented, exposed, tested and promoted remain separate stages; documentation advances none.

## Scope

Content includes Kernel content, community and rating services and their composed product outcomes: boards, threads,
posts, media, publication, reactions, ratings/reviews, Realm rating sorts, moderation, slow mode, watches, discovery
and minimal in-app notices. Web owns the document package, editor, media transport and shared browser lifetimes.
Accounts owns membership authority, preferences and lifecycle ports. Semantic owns subjects, Context and identity.
Commerce owns Library, follows, Collections, financial and rights authority. Search owns public discovery sources,
results, continuations and their query and default-worker assembly.

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

Decision: Kernel Content is split into contract/core/application/adapters; composition binds ContentAmbient;
platform defineModule is not delivered so contentDeclaration() stays; edition consent is an explicit reader with
no pool WeakMap.

Type compatibility repairs preserve outcome assertions and align callers with producer-owned contracts without
changing behavior.

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
