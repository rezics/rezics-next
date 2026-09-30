# Realm-scoped delivery still to qualify

The [fixed-site owner](../../services/main/src/modules/pro-site/store.ts) and
[SUB cases](../../scripts/qa/cases/subscriptions-and-pro.ts) cover site
configuration, sparse Realm queries and independent reply placements. General
REZICS and fixed-Realm sites are intended to share frontend and APIs. A
fixed-Realm site is a [Zone](../product/platform-thesis.md#zones-are-routed-sites)
whose population is one Realm's selection; its host binding should move from the
separate `site.definition` store into the Zone so that one site abstraction remains.

The fixed Realm boundary still needs end-to-end qualification across SSR, browser
navigation, direct APIs, Search, downloads, shared links and caches. An empty or
inaccessible local result cannot fall back to general content or reveal private
counts. Search text, snippets, media and ranking must use the same accepted
selection. Queries need bounded candidate/hydration work and explicit partial or
unavailable outcomes. Bind cursors to context, selection and security generations;
stage, catch up and fence any rebuilt query projection.

A Realm's shared [Context](context.md) expresses its own reading. Cross-Realm
adoption must keep the original speaker, exact target, selected semantic revision
and applied DefinitionRefs; a different Realm interpretation is separately
attributed. Hosting or membership does not confer institutional authorship.
Root readability alone does not authorize every reply. Shared links must retain
the selected semantic revision across viewer preferences. Deletion/reorganization
must preserve other authors' original references.
