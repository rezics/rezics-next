# Web audit gaps: journey assignments

This plan maps the open Web outcomes in [page needs](page-needs-api-render-audit.md),
[component parity](web-component-parity.md) and [platform coverage](api-first-platform-coverage.md).
The retained source is `683638d2c18047d3f389f25c68dda8dba9738dd5`. Task names below identify the
assignments returned by `bun tools/goal/src/cli.ts status`; commit anchors are from `git log dev`.
Integrated means source exists, not that frozen acceptance or rendered review has passed.

The launch premise needs narrowing: Web has two running domain-reader assignments, and Content has running and
held publication work. Many findings predate integrated implementations. Rebriefing those journeys would duplicate
work. A cancelled Manga reader assignment supplies no delivery; the retained Subject still mounts its correction
entry, without an ordinary Manga reader. Inbox and Settings still default to unavailable watch adapters despite
Content's newer mounted contracts. Those consumer gaps need one connected update-triage journey.

Decision: interpret 2,000–3,000 lines as estimated product changes, keep briefs below the repository's 12,000-character
limit, and group Inbox triage with stopping its unwanted updates; released configuration remains producer-owned.

## Ready continuations

These files are controller inputs in this worktree, not new product implementations or committed evidence.
Each uses the supplied JSON contract shape, `goal: web`, `manager: web`, default placement and no model/effort.
The estimates are outcome sizes, not quotas. Both assignments preserve existing writers and require tests shorter
than product changes. There are two new assignments, below the ten-brief cap.

| Brief | Complete journey | Estimate | Existing work it consumes, without duplicating |
| --- | --- | --- | --- |
| `.temp/continuation/01-watch-update-triage.md` | Read a current update, acknowledge that notice, open its exact destination, then stop an unwanted thread/board subscription in Settings. | 2,900 product lines, 20 files | Native current Inbox disclosure; native watch inventory/removal; integrated thread toggle and Settings controller. |
| `.temp/continuation/02-manga-parts-reader.md` | Read a Manga work, distinguish its admitted volumes/chapters/editions, visit an exact part and return to the same window. | 2,400 product lines, 12 files | Existing work-parts relations, composed Subject reads and independent Library/progress consumers. |

The first brief replaces consumer unavailability, not Content's native implementation, publication or growth work.
The second replaces a cancelled reader outcome, not the delivered Manga editor or private tracker.

## Page-needs audit: every Web interface row

| Row | Assignment and retained disposition | Remaining boundary |
| --- | --- | --- |
| I01 — community citation/reaction loss | Integrated **Preserve community citations and native reactions** (`a7786a0fc7`), followed by **Finish Subject community command binding and mounted action journeys** (`3583c3824c`). | Keep undisclosed counts unknown and current citation distinct from own vote. Do not repeat the community-card implementation. |
| I02 — rejected watch notices | Ready **01-watch-update-triage**. The earlier watch-presentation seam (`128716c677`) is integrated, but `inbox-read.ts` still defaults to `unavailableInboxWatch`. | Consume the current composed Inbox item, including actual watch kinds, actor/target disclosure and actions; no per-target hydration. |
| I03 — unavailable/revision-shaped thread watch | Integrated **Watch a thread and recover its current private state** (`5f627ec395`). | GET `{watching}` and requested-state PUT/DELETE 204 are separate from management-row revision/receipt semantics. No new toggle task. |
| I04 — full Realm catalogue handoff | Integrated **Browse the full Realm catalogue from its home** (`991129fe5c`, following `44ec547121`). | Preserve Realm scope and the scoped Search return; the publication shelf is not the population. |
| I05 — missing progress column | Integrated **Save a Library view and resume it across visits** (`0e43861432`); the Library owner explicitly admits active progress. | Preserve supplied mode/unit/value; do not introduce per-row progress reads or score sorting. |
| I06 — shelf preferences unused | Integrated **Save a Library view and resume it across visits**, then **Keep saved shelf score intent across Settings and Library** (`1f4e87a5d6`). | Explicit URL wins. Saved score intent survives while whole-shelf execution can remain unavailable. Unsupported columns/sorts are retained, not offered. |
| I07 — sales lack offer/work destinations | Integrated **Follow a creator sale to its offer and work, then return** (`652ed67426`). | Keep private buyer-order access separate; reuse current inspection/return ownership. |

### API rows and their Web consumption

These rows are assigned to other Goals in the audit. Their Web edges are included to prevent new briefs from
silently taking over producers or treating a reserved interface as installed behavior.

| Audit rows | Existing owner assignment or Web receiver |
| --- | --- |
| A01/A02 — Home reactions and review/reply context | Integrated Home reaction receiver (`219a39a7e2`) and **Render admitted review and reply context in Home** (`512c7ab4e7`, `b3f15975b2`). Content retains projection/publication ownership. |
| A03 — mixed Space/Collection/review discovery | Integrated **Compose Collection, review and Space Home rows** (`22d347ef8e`), with Content's discovery projection (`563dfd92a0`). Search/Library retain their native registration/disclosure work. |
| A04/A10 — composed Inbox context and chosen-notice acknowledgement | Content's integrated **Finish current Inbox notice disclosure** (`3f4f2ce044`, after `a774c634fd`) supplies current item context and one-item seen actions. Ready **01-watch-update-triage** binds the Web receiver. |
| A05/A06 — personal score overlay/order and rich shelf/member summaries | Live Commerce **Complete the native shelf and Collection row presentation journey**; integrated Web **Traverse the personal shelf in native score order** and saved-score-intent follow-up. Keep current unavailable ordering honest; do not create another shelf overlay or sort implementation. Search owns its mixed-search projection. |
| A07 — private watch enumeration/removal | Live Content **Install the generated watch client and finish native watch proof** and **Finish generated watch inventory, independent history growth and native proof** own native publication/proof. Integrated Performance **Manage my thread and board watches in Settings** supplies the Web controller, whose default remains unavailable. Ready **01-watch-update-triage** binds that controller; no second native inventory. |
| A08 — conversation size/activity | Content's current thread/Board projections and publication assignments remain the producers; integrated Web **Read the installed composed thread page in the existing visit** (`ad9724fcf8`) and **Inspect current Board replies without retiring Home recovery** (`90c1c313d6`) receive their observations. |
| A09 — released main-character meaning | Semantic owns vocabulary/definition release. Integrated Web **Read a character across works and correct the exact appearance or relationship** supplies the typed reader/correction surface; missing released meaning stays unsupported. |

## Component-parity rows

The parity report has delivered/reserved owner rows rather than an open ticket list. Each row has a disposition
here; its review boundary is not evidence of a missing implementation.

| Component family or section | Assignment |
| --- | --- |
| Action bar | Integrated **The reaction and action bar on every feed card** (`4486b29b96`) and Home native reaction receiver. Native state remains page-owned. |
| Shell | Integrated **One app shell with a top bar at least as good as the legacy app's** (`c8ba252c1a`). Phone clearance remains shell-owned; no replacement navigation. |
| Feed rows and attribution | Integrated mixed feed rows (`2acb31f0a6`, `22d347ef8e`) and admitted Home context follow-ups. Missing source data is not reconstructed locally. |
| Reply context and branches | Existing thread reader/reply-context owners, integrated native thread-page receiver and Home reply-context receiver. No independent branch implementation. |
| Composer and draft recovery | Integrated **Import, inspect and export unsent writing safely** and **Resume the existing private Drafts journey with delivered generated reads**. Browser-only recovery and native Drafts retain their separate documented limits. |
| Empty and route states | Integrated feed availability/contextual empty recovery (`3aabcdc687`) and shell route states. Sparse continuation is distinct from an empty population. |
| Generic tag controls | Semantic's reserved generic tagging capability is not a released generic ballot UI. Integrated Web **Assess a disclosed classification and compare independent provider figures** consumes the separately admitted classification model; Content's connected classification work remains live. No invented generic tagging journey. |
| Selection review and results | Integrated **Select Library rows, review an action and understand its results**; live Commerce **Complete native selection review through recoverable results** retains preview/result ownership. |
| Shared selection bar and navigation | Existing UI SelectionBar plus measured shell clearance, as linked by the parity report. No second selection/navigation primitive. |
| Review boundary | Phone/desktop, themes, localization, keyboard and reduced-motion rendered acceptance remain integration work; this plan does not turn them into duplicate implementation briefs. |

## Platform-coverage rows

The platform report does not assign every B/C feature to Web. This table maps its incomplete presentation rows and
ranked gaps to existing assignments or the new reader. Provider-specific integrations, unpublished configuration
and deferred products do not become new Web engines merely because a generic page can represent a value.

| Platform rows / ranked gap | Assignment and boundary |
| --- | --- |
| Shared migration row; VNDB/Bangumi transfer; AniList full MediaList; MAL richer entries; Open Library/Goodreads imports; rank 1 | Existing private VNDB/Bangumi/MAL/AniList import visits, **Export and recover a private Library artifact**, and V3/V4 export follow-ups. Commerce owns consent, match review, field-loss evidence, parser/apply and artifact versions. No duplicate importer or imaginary provider synchronization. |
| Bangumi episode state; MAL chapter/volume measures; rank 2 | Integrated **Mark actual episodes in a private checklist**, **Manage an exact manga series or volume in the private Library**, and independent-measure consumers own personal tracking. Integrated **Browse canonical episodes from a screen work** owns screen catalogue navigation. Ready **02-manga-parts-reader** supplies the missing ordinary Manga catalogue journey; public counts never prove private completion. |
| VNDB producer/staff history, biography and occupations; Bangumi people; rank 3 | Integrated **Read a person biography and occupations from the ordinary subject page** (`cc9fa12e5e`) and **Read organization history and directed affiliations** (`4482bb4d68`). Semantic retains missing property/concept publication. |
| VNDB age/main-character/traits; Bangumi directed character relationships; rank 3 | Integrated **Read a character across works and correct the exact appearance or relationship**. Display only admitted qualifiers and exact direction; do not infer semantic identity from appearance roles. |
| Bangumi music/live action; MusicBrainz releases/recordings/media/tracks/credits; Discogs master/release workflow; rank 4 | Integrated Imports **Read and correct admitted imported music and live-action profiles**, Web **Read an album track listing without collapsing release identities**, **Read a recording and its qualified contributions** (`408781d9d3`) and **Read a music release as an edition of an album** (`2029aff2bb`). These are native admitted catalogue readers/editors, not complete provider import or playback. Music Library controls remain conditional on an actual released profile; do not invent one for MusicAlbum. |
| Source ballots/figures across VNDB, Bangumi, AniList, MAL, Open Library, MusicBrainz, TMDb, Letterboxd, IGDB and IMDb; rank 5 | Integrated **Assess a disclosed classification and compare independent provider figures**, source-observation inspection and private assessment receiver. Live Content **Finish the connected native classification journey** and **Return to and withdraw an exact current classification assessment** retain producer ownership. Unadmitted provider statistics are not native votes or new Web arithmetic. |
| VNDB release-to-release/TBA; Bangumi relation/kind codes; AniDB episode kinds; all typed provider IDs/role vocabularies; rank 6 | Existing finite relation/qualified-credit/source readers and editors plus current domain readers consume released semantics. Semantic publishes concepts/admissions; Imports owns source mappings and unknown-code review. Generic facts remain the fallback for unpublished configurations; no new provider-specific editor is approved by this row alone. |
| AniList/MAL richer history; Goodreads rereads/challenges; Letterboxd diary/annual statistics; rank 7 | Integrated **Manage a private Library entry and its occurrence diary**, **Assess an exact occurrence and open its reported-year bucket**, and **Complete native occurrence assessment and exact reported-year navigation**. Commerce owns missing occurrence/analytics semantics. Do not add a new challenge model or infer history from current progress. |
| Wikidata graph, quotations, music/file/location browsing; AniDB catalogue file/group; rank 8 | Existing bounded graph/concept inspection and integrated **Read a quotation with its exact source context**. Live Web **Read a venue or event from its ordinary catalogue destination** and **Read a catalogue file without confusing it with a release or owned copy** own the remaining location/file readers. A general visualizer is expressly optional; it is not another ready task. |
| TMDb/Letterboxd/IMDb live-action composition | Integrated Imports music/live-action reader plus existing screen reader/editor and canonical episode reader. New provider IDs/regional vocabularies remain Semantic configuration; provider averages/sync remain their own capability. |
| Open Library/Goodreads work and exact edition; IGDB/Steam game/release; series/parts | Integrated **Read a literary work and choose an exact edition** (`1caeabab6e`), **Read a game work and its actual released editions**, and **Read a story arc through its ordered works and appearances** (`1978331497`). Do not collapse work, edition and owned copy. |
| Steam ownership/achievements; AniDB file matching/MyList; lossless Wikidata lexical/geographic types; Discogs condition fields/marketplace; rank 9 | These are new model/integration or explicitly deferred capabilities, not Web-only gaps. Retain the source report's C/D classification; do not create a fake tracker, condition model, lending reader or marketplace. |

All fifteen platforms are represented above. Already-present native actions (votes, reviews, lists, follows,
copies, generic facts/history) reuse their existing interfaces. Conditional vocabulary is tracked with its producer;
it is neither a second authoritative schema nor a claim that a missing profile is available.

## Reading and delivery boundaries

The mapping uses the three named reports, the current task contracts returned by status and dev commit history.
Consumer premises were checked against the Inbox, Settings, Library and Subject owner sections, the ordinary
Subject entry, watch ports, current native Inbox DTO/routes and the bounded work-parts implementation. The reference
registry was consulted; this assignment adds no provider research or external-source-derived design. The cancelled
Manga outcome informed the replacement brief; it is not listed as live or integrated coverage.

The controller can dispatch the two continuation inputs independently. Their frozen, native and rendered acceptance
stays with integration; an assignment marked integrated above must not be interpreted as a passed runtime check.
