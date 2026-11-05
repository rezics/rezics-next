# Web design status

Baseline: 2026-10-30. This report covers the three directly owned **In** systems in
[scope](../scope.md), with shared backend ownership preserved. It records design, source seams and known evidence;
it is not a completion manifest or a new product authority. Owner delivery inventories are accepted without
rerunning their checks. Main promotion is paused; local typing, a recording or an integrated helper cannot prove
an entire UI/API/storage journey. No new execution or privacy, lifecycle or cost receipt is claimed here.

Web also consumes and collaborates on the UI of other owners' rows: Search, catalogue editors, communities,
accounts/Auth, moderation, notifications, Zones and commerce. Their backend ownership stays with those owners.
Header search, Collection outer/inner/editor and the Type renderer already have active implementation work;
protected media/moderation/Inbox/current-Zone UI, order/entitlement, real Auth fixture assembly and the full personal
driver are also existing work. Recommendations below identify the remaining whole slices without commissioning
duplicate writers or auditing those other systems.

## 1. Subject pages, relations, editions and credits

**Owner and authority.** Web owns the reading experience in [Subject pages](../subject-pages.md).
Semantic owns [relations, credits and inverse reads](../../services/kernel/src/semantic/README.md#relations);
Search owns [composition and subject views](../../packages/composition/README.md#subject-views) and the native
[presentation executor](../../services/kernel/src/presentation/README.md). Content owns covers and discussion;
Rating owns figures; Accounts owns verified agent identity. A page combines these authorities, it does not replace them.

**Primary-source research: partial.** Existing [page evidence analysis](search-pages-completion-audit.md) concerns
REZICS delivery, not a complete comparative design study. The inspected BookWyrm
[book view](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/views/books/books.py#L30-L95)
resolves a work to an edition and filters reviews for the viewer: useful evidence for a coherent work/edition
reading journey, not evidence for REZICS's generic credits, Realm or bounded graph design. It was read from
`.reference/shelves/bookwyrm/bookwyrm/views/books/books.py` under the shared reference directory; no code is copied.
The dedicated [subject design report](web-subject-design.md) is **research in progress, absent from this checkout**.
Cross-vertical relations/credits research coverage remains a gap until that report arrives; an owner doc alone
does not complete it.

The table maps the complete reading journey, including exits and unresolved seams. Paths include a site locale;
`S` below is `/{locale}/subjects/{id}/{slug}`. Native details are documented in the owner links above and the
[Web read placement contract](../../apps/web/README.md#search-engines-and-sharing).

| UI step / actual page                                         | API method and endpoint                                                                                                       | Native owner / record                                                                                                 | Authorization, continuation and lifecycle boundary / gap                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter `S`, resolve an old address or agent                    | `GET /v1/subjects/:id`; agent lookup `GET /v1/accounts?agent=…`; `POST /v1/pages:read`                                        | Semantic subject/identity; Accounts verified account; Presentation profile and planned reads                          | Anonymous SSR; merged API 308 becomes Web 301 after the bounded follow. Hidden/removed/unknown conceal with 404. Verified agents use `/@handle`; no agent Realm identity.                                                                                                                                                                                                             |
| Read overview/About, Parts and Details at `S` or `S/details`  | `POST /v1/pages:read` with subject/view target                                                                                | Presentation aggregate over Semantic selected statements, definition release and Content public document/media bodies | Same public data feeds rendered body and JSON-LD; private statement audience stays excluded. Existing aggregate caps are 16 descriptors, 128 output slots and concurrency 4, not a whole-backend cost proof.                                                                                                                                                                          |
| Traverse `S/relations`, `S/editions`, `S/contents`            | `POST /v1/pages:read`; standalone `GET /v1/subjects/:id/relations` and `GET /v1/subjects/:id/links` for forward/inverse pages | Semantic statements; `outbound_link` / `inbound_link`, Context projections and counters                               | Edition/part membership is a relation, not a separate edition store. Property/type/qualifier-bound opaque cursors; limits at most 100. Current target disclosure and relay readiness still apply; a short page may continue.                                                                                                                                                          |
| Traverse `S/credits`, `S/characters`, agent Works/Appearances | Same page aggregate and forward/inverse relation GETs, selected by release properties                                         | Semantic credit/appearance statements, role/order/cast qualifiers and the same link projections                       | No separate credit API or duplicate credit truth. Every full list must continue; spoiler-safe presentation and exact/at-least counts remain required. Complete current UI/proof across these views is not established by templates.                                                                                                                                                   |
| Choose personal next action; return to page                   | `GET`/`PUT`/`DELETE /v1/libraryEntries/:subjectId`; progress endpoints in section 2                                           | Commerce-owned Library entry/session; Rating and Content retain their own actions                                     | Browser personal queries begin after sign-in; no personal state in public SSR/cache. Current Auth/Access and accepted profiles govern writes. Full personal-driver evidence remains existing work.                                                                                                                                                                                    |
| Read a Realm-routed subject and return to Global              | Selected `POST /v1/pages:read` with `target.realm`                                                                            | Community Realm/publication head; Semantic Context and statements                                                     | **GAP:** production Realm wire and rating/review/discussion/list population bindings remain open in the subject authority. Current bans conceal; a genuine null publication after a readable Realm may permit an independently authorized Global fallback with no Realm metadata. Unavailable reads retain typed failure. Final authority must be revalidated inside existing bounds. |

**Known gaps and next whole slice.** The [Presentation delivery inventory](../../services/kernel/src/presentation/README.md#release-evidence-and-scope)
records real native and Workers evidence, along with an unresolved corrected Workers execution; it does not certify
the current integrated revision. Definition templates and the existing renderer work are useful delivered pieces,
not proof of every view. Realm population bindings and Context deletion are explicitly not all frozen. The next
Global slice is one real work → editions → edition → credits → creator Works journey, including forward/inverse
continuation, unavailable sections, hidden targets, source credits and canonical return, through the existing
renderer and real owner APIs. Attach its native/public-body/JSON-LD and accessible localized UI evidence through
the existing fixture effort. Keep Realm binding as a separately owner-completed dependency; do not substitute mock
population labels or claim that slice from Global evidence.

## 2. Library, Collections, progress and copies

**Owner and authority.** Web owns browsing/editing UI; Commerce owns Library API, native facts and storage.
[Library and Collections](../library-and-collections.md) and the joint
[Collection presentation and editor contract](../collection-presentation.md) are authoritative. The
[Library module](../../services/kernel/src/library/README.md) inventories implementation; linked dynamic,
filtering, labels, profile and deletion authorities retain their boundaries. Semantic owns definitions and fact
enrichment; Content owns media/reaction authority; Accounts owns authentication and terminal coordination.

**Primary-source research: partial.** [Library abstraction](library-abstraction.md) supplies the generic
entry/session/copy/Collection comparison; [shelf research](library-shelves.md) supplies layout evidence. The inspected
BookWyrm [Shelf/ShelfBook model](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/shelf.py#L19-L110)
has owner, privacy and distinct shelf membership: evidence for separating a named list from personal reading
state, not for REZICS's dynamic union, retained preparation or receipt guarantees. Local source read:
`.reference/shelves/bookwyrm/bookwyrm/models/shelf.py`. The dedicated
[Library design report](web-library-design.md) is **research in progress, absent from this checkout**. The existing
research does not establish the whole first-public capability or native/API/UI completion.

| UI step / actual page                                                                                    | API method and endpoint                                                                                                                                                                                                            | Native owner / record                                                                              | Authorization, continuation and lifecycle boundary / gap                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enter `/{locale}/library`, inspect tracked entries and pins                                              | `GET /v1/libraryEntries?view=FULL`, `GET /v1/libraryPins`, `GET /v1/collections?curatorAccountId=…&view=FULL`; Continue uses `GET /v1/libraryContinue`                                                                             | Library private entry, pins, Collection header and session facts in owner partition                | Private, no-store and bounded cursor pages, at most 100. Entry-only compatibility reads are **tracked entries**, not Everything. **GAP:** complete Everything/state/Liked discovery and common-members runtime, including copy/session-only support.                                             |
| Open `/{locale}/library/collections` → `/{locale}/collections/{id}`                                      | `GET /v1/collections`, `GET /v1/collections/:id?view=FULL`, `GET /v1/collections/:id/members`                                                                                                                                      | Library `collection`, ordered `collection_member` occurrences and subject summaries                | Public render is anonymous; owner controls hydrate separately. Current native access and hidden-member filtering apply. Curated cursor seals order epoch; duplicates remain editable occurrences. Selected canonical/dynamic browsing is not supplied by the stored occurrence reader.           |
| Create via `/{locale}/collections/new`; edit, save, cancel or remove in detail                           | `POST /v1/collections`; `PATCH`/`DELETE /v1/collections/:id`; `POST …/members`; `PATCH`/`DELETE …/members/:memberId`; `POST …/members/:memberId:move` and `:restore`                                                               | Library Collection/member commands, revisions, receipts and retained occurrence episode            | Current curator/update grant, numeric CAS and idempotency; cap 5,000 occurrences. Existing editor saves independent operations, stops on first failure and reports earlier successes. Member restore is native 720-hour retained lifecycle; whole UI Undo/bulk transfer is not inferred from it. |
| Start/continue at `/{locale}/library/progress`; open `/library/progress/{id}`                            | `POST`/`GET /v1/progressSessions`; `GET /v1/progressSessions/:id`, `/changes`, `/completedUnits`; `POST …/:id:record`, `:complete`, `:abandon`                                                                                     | Library session, progress head/units/change history and accepted profile pins                      | Owner-private; bounded history/unit pages and record batches. Amount, cursor and completed-unit modes retain distinct meanings. Historic pins survive release changes; complete production profile acceptance and personal-driver proof remain open.                                             |
| Manage `/{locale}/library/copies`; change subject state                                                  | `GET`/`POST /v1/copies`; `GET`/`PATCH`/`DELETE /v1/copies/:id`; entry GET/PUT/DELETE and `POST /v1/libraryEntries/:subjectId:restore`                                                                                              | Library holding/copy and entry/archive; private owner write sequence                               | Holdings, state and sessions remain independent. Current authority/CAS/replay apply; entry Undo obtains fresh write order. **GAP:** full holding retained-delete/Undo lifecycle and whole-graph terminal cleanup are not certified by existing copy commands.                                    |
| `/{locale}/library/labels`, `/library/following`; History destination; publish/export/mount a Collection | Following: `GET /v1/follows`, `PUT`/`DELETE /v1/follows/:targetId`; logs: `GET`/`POST /v1/publishedLogs`. **GAP:** complete label HTTP, unified History route, shared bulk/export and dynamic publication/mount execution bindings | Library label assignments, follows, published logs and Collection source; Semantic consumes mounts | Private predicates/facts never leak through membership, counts or export. Follows/mounts grant no subject access. Source factories/partial cleanup are not complete runtime; saved dynamic queries stay deferred/closed.                                                                         |

**Known gaps and next whole slice.** The joint document's original inventory predates some source: current
[Collection model](../../services/kernel/src/library/collection-model.ts) includes kind/cover fields and
[presentation helper](../../services/kernel/src/library/collection-presentation.ts) performs selection/media checks.
That is partial integration, not complete dominant-kind derivation, ordered fallback, FULL facts, generated handoff
or end-to-end proof. Preserve optional-field fallbacks until the actual producers arrive. Browse/editor/Type work
already exists; do not assign another version. Next, join those writers to one owner-complete curated Collection
slice: create → duplicate occurrences → paged browse → edit/cancel/save/conflict → remove/restore, with real kind,
cover and FULL facts only where delivered, and denied/partial states otherwise. The full personal driver supplies
the parallel state → session → holding independence journey. The genuine remaining backend slice is complete
built-in/common-members evaluation and preparation, with selective currentness and full lifecycle/custody;
membership GET may return the adopted exact `202 {preparing:true}` with Retry-After/no-store, never false empty.
Terminal fencing and all store-owner cleanup acknowledgements remain mandatory, without claiming a new receipt here.

## 3. Sitemaps, metadata, sharing and SEO

**Owner and authority.** Web owns [SEO policy](../seo.md), rendered metadata/JSON-LD, export and artifact serving.
Each product owner owns public eligibility, feed data, publication timestamps and lifecycle; Semantic owns the
[subject page feed](../../services/kernel/src/semantic/README.md#subject-page-feed), Commerce the
[Collection feed](../../services/kernel/src/library/README.md#sitemap-feeds), Content its community feeds, and
Accounts agent identity. Object storage holds derived sitemap artifacts, never permission authority.

**Primary-source research: partial for the whole system.** Existing [sitemap scale research](sitemaps-at-scale.md)
and [subject publication research](subject-sitemap-publication.md) provide substantial primary-source backing.
The [Sitemaps protocol](https://www.sitemaps.org/protocol.html), read for this baseline, requires escaped XML,
limits each sitemap to 50,000 URLs/50 MB uncompressed and distinguishes page from file `lastmod`.
Open Library's inspected [offline generator](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/sitemaps/sitemap.py)
separates dump processing and XML output; this supports off-request artifact generation, not REZICS's current
disclosure or public-change timestamp semantics. Local source read:
`.reference/partitioned-sitemap-feeds/openlibrary/scripts/sitemaps/sitemap.py`. These are reused evidence, not a new
comparison campaign. The dedicated [SEO design report](web-seo-design.md) is **research in progress, absent from
this checkout**; whole-system sharing, generated-card and route-coverage research is not marked complete.

| UI / crawler journey                                                                      | API method and endpoint                                                                                                                        | Native owner / record or artifact                                                                        | Authorization, cursor and lifecycle boundary / gap                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow a localized subject URL and view/share its head                                    | `GET /v1/subjects/:id` for address; `POST /v1/pages:read` for public representation                                                            | Semantic subject/statements; Presentation public result; Web `subject-head.ts` and shared head builder   | Canonical/reciprocal alternates and JSON-LD use the rendered public data; configured origin, never request Host. Title-only and later cursor pages are noindex. Merges 301; removed/hidden/unknown 404. Personal state remains outside public head/body.                                                                                                   |
| Export subject URL families                                                               | `GET /v1/subject-pages?limit=1000&cursor=…`                                                                                                    | Semantic candidate/public-publication records and native navigation projection; Web subject feed adapter | Default Web projection consumes the actual native Account admission/template intersection for overview/posts/reviews/collections without per-row reads; explicit empty views, sparse cursors, label fallback and original valid times retain their semantics. Native, whole-feed, privacy, cost, visual and promoted-main proof remain unestablished here. |
| Export public Collections and community pages                                             | `GET /v1/sitemap/collections`, `/v1/sitemap/boards`, `/v1/sitemap/threads`, `/v1/sitemap/realms`, `/v1/sitemap/spaces`                         | Library public Collection records; Content board/thread/Realm/Space records; Web feed adapters           | Owner feeds decide disclosure and opaque cursor validity; export consumes until `next:null`, including empty continuation pages. Existing Community and agent adapters remain bound; full owner-to-export runtime coverage is not established here.                                                                                                        |
| Build daily export; publish only after all feeds finish                                   | Internal Workflow calling the feed GETs, then R2 operations; no product mutation API                                                           | Web exporter; R2 `shards/`, `runs/`, staged run and `index.xml`                                          | At most 3,000 page families / 24,000 locale URLs and 40,000,000 uncompressed bytes per shard. Children precede conditional index replacement; failed feeds retain the previous public index. No request starts enumeration. Existing source is not a successful whole-feed runtime receipt.                                                                |
| Crawl `GET`/`HEAD /sitemap.xml`, `/sitemap-{type}-{digest}.xml.gz`; `GET /robots.txt`     | No kernel read at artifact-serving time                                                                                                        | Web `sitemap/serve.ts`, `sitemap/robots.ts`; SITEMAPS R2 binding                                         | One object read per sitemap request; no session or permission shortcut. Current page denial/removal acts immediately, inventory catches up next export. Missing binding/index returns unavailable; immutable shards do not certify current page access.                                                                                                    |
| Share `/{locale}/collections/{id}`, `/@handle` or a community page; visit a private route | Collection `GET /v1/collections/:id`; agent `POST /v1/pages:read` with account target; **GAP:** per-community sharing bindings not mapped here | Current permitted page projection and authorized cover variant; owner records remain authoritative       | Open Graph/Twitter/ItemList and generated fallback-card policy must match public content. **GAP:** complete route/card/locale/cache delivery evidence is not established. Library, private account/settings, checkout, editors and auth are noindex; never expose private fields to previews.                                                              |

Source anchors: [subject adapter](../../apps/web/src/sitemap/feeds/subjects.ts),
[registered adapters](../../apps/web/src/sitemap/feeds.ts),
[subject HTTP envelope](../../services/kernel/src/semantic/http/subject-pages.ts),
[export inventory](../../apps/web/README.md#sitemap-export),
[artifact serving](../../apps/web/src/sitemap/serve.ts) and
[subject head](../../apps/web/src/features/pages/subject-head.ts).

**Known gaps and next whole slice.** Selected publication semantics, export code and protocol research are distinct
from a working production inventory. The delivered Subject source is now bound to the existing exporter, including
the native current Account overview root and admitted activity views; its DTO declares no agents-feed ownership
exclusion. Semantic intersects offered templates with the original native Account admission batch and rereads it
before finishing metadata guards. Native, whole-feed, privacy, cost, visual and promoted-main proof remain pending.
Next prove the original subject publication/feed journey:
public meaningful change → current feed → eight-locale family → stored shard →
atomic index → crawler GET, then hide/remove the last public fact and show immediate noindex/404 as appropriate,
next-export omission, stable/omitted `lastmod`, and previous-index retention on failure. Reuse real fixture assembly
for body/head/privacy evidence. Follow with proof of the existing agent inventory and public sharing/card coverage; do not
treat local typing, optional IndexNow or a generated artifact alone as system completion.
