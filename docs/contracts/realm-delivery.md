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

## Publication-year browse

`GET /v1/realms/{realm}/modules/browse` accepts `publicationYear`, either a
calendar year (`1995`) or an inclusive bounded range (`1990-2000`), within
1..9999. It uses the same active, globally accepted date-published Statements
as `work-publication-years`; missing, withdrawn or unaccepted dates do not
match. Multiple matching Statements still yield one Work.

The admitted `publicationYear` Facet represents this global calendar-year
path. GET compiles the year into the same inclusive range Condition that
`POST /v1/query` accepts, so programs can combine it with other browse Facets
without a client-only vocabulary.

The filter applies inside the browse graph read, alongside Realm adoption and
public disclosure. `query.publicationYear` echoes the applied condition. Items,
`matches`, Facet counts and `nextCursor` come from that read; the cursor binds
the year as well as the other query inputs. A request budget can produce an
empty page with a continuation, never a fixed member-population cap. Counts
remain lower bounds until traversal finishes with a current projection.

Anime and Manga pass their selected year to this read. Their all-years view
uses `1-9999`; both views keep the API continuation and counts. The reason to
apply the year here is that intersecting separately paged member and year
lists loses eligible Works beyond whichever list the client stopped reading.
