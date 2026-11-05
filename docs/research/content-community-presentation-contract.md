# Native community presentation metadata

Research evidence, 2026-10-31. The Web interface consumption is adopted in
[the Web owner contract](../../apps/web/README.md#realm-appearance-and-rules). The selected Realm-owned native
presentation slice is adopted in the Community and Content owner contracts linked below. Accounts retains its
membership source authority. This report is not an interface authority or evidence of delivered APIs, runtime
behaviour or completion.

## Primary evidence

- **Lemmy**, commit `1cc23de9ec0baf13dc4f02c47f6722985c0c60d3`, AGPL-3.0
  ([manifest](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/Cargo.toml),
  [licence](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/LICENSE)).
  [Community storage](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_schema/src/source/community.rs)
  separates title, short summary, sidebar, icon/banner, subscribers and activity figures.
  [Community uploads](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/routes/src/images/upload.rs)
  authorize against the community before changing its images.
  [Subscriber triggers](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/diesel_utils/replaceable_schema/triggers.sql)
  derive deltas from actual follow changes; [views](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_views/community/src/impls.rs)
  filter visibility/removal. Follow totals are evidence for incremental maintenance, not REZICS membership semantics.
  Official [user documentation](https://join-lemmy.org/docs/users/01-getting-started.html) places rules beside subscribing.
- **Discourse**, commit `589325e2b8466178ee83acac9ec411de555a0093`, GPL-2.0-or-later
  ([licensing declaration](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/README.md),
  [licence](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/LICENSE.txt)).
  [Category](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/category.rb)
  owns uploaded logo/background references and links its description to a real topic/first post and revisions.
  [Group](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/group.rb)
  maintains a separate user count and repairs it with a membership tally. That recount strategy is unsuitable for
  a bounded native request. Shared pattern: container-owned optional presentation, real editorial content and
  source-derived statistics; disagreement: Markdown sidebar versus topic-backed description. Adopt the latter
  storage pattern using existing REZICS posts, and incremental statistics using Realm membership.

Reused caches: `.reference/content-moderation-appeals/lemmy/` and
`.reference/partitioned-sitemap-feeds/discourse/` in the main checkout. Paths in the links above are the inspected
source paths; sparse files were read with `git show`, without installing, building or running either project.
No source implementation or passage is proposed for copying.

## Adopted authority

The Realm-owned presentation/reference contract is adopted in the owning
[Community README](../../services/kernel/src/community/README.md#realm-presentation) and
[Content README](../../services/kernel/src/content/README.md#community-presentation).
Those documents own settings, exact native rules disclosure, shared DTO, producer signatures and operation costs.
The [Web owner contract](../../apps/web/README.md#realm-appearance-and-rules) owns interface consumption, settings
presentation and visual review; native adoption does not supersede that authority.
Accounts still owns its membership source/version/removal seam; members remain unknown until that source and
Content's aggregate are installed. Content's native assets producer owns
[claims, derivative summaries and downloads](../../services/kernel/src/content/README.md#realm-presentation-media).
This report retains only research evidence and is not a second settings or read contract. Adoption establishes no
native, physical, visual, cleanup or promotion proof.
