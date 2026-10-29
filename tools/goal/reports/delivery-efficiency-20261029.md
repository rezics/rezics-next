# Delivery efficiency and the first public scope

Evidence cutoff: **2026-10-29 14:28:33 UTC** (22:28:33 Asia/Shanghai).
Whole rewrite: October 25 00:00 UTC to cutoff. Recent window: October 27
14:28:33 UTC to cutoff, exactly 48 hours. “Last three days” follows the
contract's explicit **since October 26 00:00 UTC**, a 3-day 14-hour window,
rather than silently replacing that date with a rolling 72 hours.

The rewrite has delivered substantial running code, but its delivery system
rewards completed fragments more reliably than complete public journeys.
There are **2,142 landed tasks**, yet only **1,057 have their recorded landing
commit on main**; 1,085 remain dev-only. This does not mean every main task is
a complete capability. A typed interface, a native storage primitive and a
formatter acceptance can all land without making a page useful.

The strongest intervention is to finish a small number of already-started
journeys with one accountable integrating manager, while stopping speculative
contract branches and repeated acceptance repair. Adding workers would enlarge
the work and review queues before it addressed that conversion problem.

## Evidence, accounting and limits

All operational records were read-only. No control-plane CLI, product check,
typecheck, test, build, installation, reference-project execution, remote check
or process belonging to another attempt was run or changed. Only this report
is a tracked change. This is evidence for manager adoption, not a new authority
for product behaviour.

Primary sources and reproducible identifiers:

| Source                                                          | Pin / selection                                                                                                                                                             | What it establishes                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/edge/projects/rezics/rezics-next/.temp/goal/goal.sqlite` | Opened with `sqlite3 -readonly`; JSON bodies in `worker_tasks`, `worker_attempts`, `worker_records`, `worker_events`, `landing_queue`, `manager_inbox`, `worker_promotions` | Contracts, starts, outcomes, readings, integration events and manager traffic                                                                                                       |
| Store extracts                                                  | 2,652 tasks; 4,731 attempt rows; 4,676 record rows; 8,736 worker events; 2,844 landing rows; 7,861 inbox rows; one current promotion                                        | Collection was successive read-only queries, not one atomic transaction; exclude two starts after cutoff and three pre-period imported attempts from attempt-rate/hour calculations |
| Git dev                                                         | `ba52753840`                                                                                                                                                                | Reachable product and document changes; 332 explicit style/format commits excluded                                                                                                  |
| Git main                                                        | `426c262414`                                                                                                                                                                | Ancestry, not current deployment or a new successful release gate                                                                                                                   |
| Attempt streams                                                 | Exact `worker_attempts.logPath`, `.temp/goal/runs/<task>/<attempt>.jsonl`                                                                                                   | Systematic every-83rd-attempt sample yielded 42 raw Codex terminal usage records; 39 match saved input counters exactly                                                             |
| Landing streams                                                 | Exact `landing_queue.outcome.logPath`; 2,726 readable logs                                                                                                                  | Failure evidence, executed commands, selected slot-wait messages                                                                                                                    |
| Promotion streams                                               | `.temp/goal/promotion-783333d6-76cc-4678-96ff-815085282233-head-0.log` and `...-head-infrastructure-rerun-2-0.log`                                                          | Main promotion can require reruns; one Auth workspace alone recorded 544–698 seconds and 93 passing cases; not a complete all-workspace verdict                                     |
| Manager notes                                                   | Exact paths named below, recovered from inbox evidence references                                                                                                           | Decisions, handoff gaps and competing interpretations; notes are evidence, not a second product authority                                                                           |

The repository and its inspected source are **AGPL-3.0-only**, as declared in
`package.json`. Source URLs below pin the same repository revision; private
operational records have local paths rather than public URLs. No outside
project was needed to answer this internal-records question, so no reference
clone or `.reference/INDEX.md` change was made.

Reproduction: `SELECT body FROM worker_tasks` and corresponding reads of
attempts/records/events; `SELECT * FROM landing_queue` and `manager_inbox`.
Join task/attempt keys, not summaries. Use `git rev-list <pinned-ref>` for
reachability and `git log <dev-pin> --since=2026-10-25T00:00:00Z --no-merges
--numstat -w` for additions/deletions. Attribute commits by
`integratedCommits`, then `integratedCommit`/`mergedCommit`, then `Task:` or
`Goal-Task:` trailers. Keep unmatched commits in an unattributed bucket.
Research integrations count when their commit is reachable too. Count each
landed task once, dated by its passing integration/research event, falling
back to its landing commit time.

Line classes are exclusive: Markdown/text and `docs/` or non-generated
`contracts/` are documents; test/spec/fixture paths and test/spec/story files
are tests; `tools/`, `scripts/`, root configuration and automation are tooling;
remaining `apps/`, `services/`, `packages/` files are product. Product includes
SQL, definitions, translations, CSS and runtime configuration, including typed
stubs in production directories. Consequently it is an **upper bound on
effective product code**, not a count of useful unique functionality.
Tooling tests remain in tests, not tooling. Exclude recordings, lockfiles,
binaries and generated paths in `.gitattributes`: OpenAPI, generated client,
kernel schema dumps, definition releases, recorded definitions, plus generated
route/message outputs. Explicit style/format commits are excluded and `-w`
ignores whitespace-only changes. Embedded incidental reformatting and repeated
semantic edits cannot all be separated automatically; churn is not final size.

Allowance needs particular care. **pp means a percentage point of an account
window, not dollars, tokens, or a percentage of a common cross-provider budget.**
Use the longest window in each before/after reading, normally 10,080 minutes.
Deduplicate identical observations by allowance key, observed time, reset and
value; order them, sum positive adjacent movements, and discard reset changes
of at least 120 seconds (allowing small timestamp jitter). Attribute a movement
to its later observation's UTC day. Negative movements and reset transitions
are not reconstructed. These are **observed consumption proxies**, not audited
account totals: account rotation, stale samples, rounding and activity outside
workers remain possible. Account keys identify configured accounts, not
immutable provider identities. Grok/Cursor accounts have no usable readings.

Naively summing every attempt's positive before/after delta yields **11,982 pp**
(5,017 codex-1, 6,650 codex, 315 Claude), whereas the deduplicated observation
series yields **881 pp**. Overlapping attempts repeatedly observe the same burn.
For per-Goal/class/outcome ratios, allocate each observed movement once among
overlapping attempts on that account, proportional to overlap duration. Those
allocations are explicitly **inferred proxies**; managers' usage on the same
account is not separable. Never treat them as invoice-quality individual spend.

Worker-hours mean summed attempt wall-clock residency, clipped to the window,
including checks, waits and retries. They are not CPU-hours or active reasoning.
Exclude three imported pre-period attempts: two bootstrap attempts were only
closed on October 28, so treating their cancellation timestamps as execution
would invent **175.4 worker-hours** and badly overcharge control-plane specs.
Do not infer zero spend from a missing counter.

## What actually landed since October 26

The following is a capability inventory, not a repetition of every fixture
repair. Each row names concrete landed code and its task/commit; branch means
ancestry at the pinned refs. “Works” here means implemented and supported by
recorded native/worker evidence, not freshly exercised in this read-only audit
or observed in a public deployment. Exposure gates and deployment configuration
can still keep an implemented operation closed. A page story is evidence of
rendering, not proof of its real backend journey.

| Goal / delivered surface               | Observable addition or repair since October 26                                                                                                                                                                            | Task / landing commit / branch                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts / profile API                 | Edit public display name, biography, avatar, links and activity views through `PATCH /v1/accounts/{accountId}`.                                                                                                           | `3ab1ed28` / `da107d37f4` (dev)                                                                                                                                                                                                                                        |
| Accounts / agent pages                 | Organization speakers listing and account/public-agent linkage; deleted handles conceal identity, cursor payloads are opaque and old handles are reserved.                                                                | `e8dbaa5d` / `4f12fb4a1f` (dev); `3637f665` / `499f446742` (dev); `d49ce056` / `7ad0b0c2ca` (dev); `fa81d356` / `3f39010279` (dev)                                                                                                                                     |
| Accounts / sessions and authorization  | Native revocation adapter, principal/assignment-aware workflow approvals, and overload answered as unavailability rather than false permission denial.                                                                    | `bc2e00eb` / `a8eab930c4` (dev); `de4a60ad` / `63639fee39` (dev); `596aefc3` / `720e6dd53c` (main); `d5bce4d8` / `d0ddda0022` (main)                                                                                                                                   |
| Accounts / erasure                     | Terminal erasure coordinator and a native workflow entry for collaborating owners; this is not every participant completing erasure.                                                                                      | `0976f424` / `4af7478974` (dev); `cac6895e` / `38a79a3e4b` (dev)                                                                                                                                                                                                       |
| Commerce / checkout                    | Buyer order return shows captured purchase and subject. `PATCH /v1/offers/{offerId}` exposes target-bound native price revision; offers/orders/entitlements already existed.                                              | `43781d1b` / `2ce8897416` (dev); `67756621` / `57a39700ac` (dev)                                                                                                                                                                                                       |
| Commerce / shelf API                   | Private shelf HTTP transport, five newly split date readers, active-session enrichment and serialized shelf/progress heads. These are working slices, not the complete new Library.                                       | `f8015318` / `2c6d33962c` (dev); `7b4faa5b` / `c833366fec` (dev); `c033c8e8` / `cf8e8ee46f` (dev); `c716f012` / `cf150fa3f5` (dev); `03f18dab` / `fb1a5adb08` (dev); `3f6f3b10` / `f371ecf732` (dev); `23c38679` / `d28389b710` (dev); `9100d7b5` / `74d9352e26` (dev) |
| Commerce / native support              | Profile selection and exact-decimal metadata consumers; independent label DAO and retained-entry/copy storage. These are internal primitives, not a shipped label/profile journey.                                        | `1cddc8a1` / `8ac0c0f8b9` (dev); `40f2030d` / `f020bc2ad5` (dev); `2b3f9655` / `f3daf2a739` (dev); `b70b7951` / `b303443511` (dev); `7fbfacf3` / `e0f1d2f61f` (dev)                                                                                                    |
| Content / ratings API                  | Native rating questions, populations and own-vote reads/writes under `/v1/subjects/{id}/ratings`; public Global Bayesian figure producer for search ordering.                                                             | `32b6dd58` / `b3747cb845` (dev); `ec1fda32` / `9f1987ee15` (dev); `d10af0a0` / `9b444eaf56` (dev); `82b6d404` / `937abf0c06` (dev)                                                                                                                                     |
| Content / moderation                   | Minimal author appeals and independent moderator resolution, plus Realm participation/ban enforcement. Boards/threads expose appeal queues.                                                                               | `09f7f49e` / `480dc7e88e` (dev); `3a8e4d46` / `91acdd8051` (main); `c74523a3` / `e8e316ec30` (main); `e282012c` / `fcb2f5ad61` (dev)                                                                                                                                   |
| Content / inbox API                    | Durable notice store and `GET /v1/accounts/{accountId}/notifications`, `/notifications/count`, `POST /notifications:markSeen`.                                                                                            | `c3ba1fd8` / `cfa3a93f99` (dev); `5744506d` / `e99f2ca7ce` (dev)                                                                                                                                                                                                       |
| Content / erasure and publication      | Account-indexed reactor/reporter erasure, community cleanup and public board/thread sitemap feeds; participant work remains distinct from whole-account completion.                                                       | `fb2a623f` / `dc184fc467` (dev); `0fbdd1b5` / `9e34dbbb75` (dev); `9ff2d972` / `f0ffa3ad90` (dev)                                                                                                                                                                      |
| Imports / runtime CLI                  | Pipelined records with nonblocking covers, importer account-key sign-in and bearer renewal, CPU overhead repair and retryable-overload width reduction.                                                                   | `29d61752` / `2615b99be1` (main); `576f7d33` / `1048293682` (main); `aeb58c04` / `2ce9cf7c31` (main); `a1858ac3` / `22fa922aa4` (dev)                                                                                                                                  |
| Imports / converters                   | Open Library conversion correction and optional Latin source handling. Most recent imports landings are audits/specification, not new providers.                                                                          | `b39f1831` / `1d24808598` (dev); `e17a402e` / `5b535f0270` (dev)                                                                                                                                                                                                       |
| Search / results and ordering          | Result cards can request typed facts; native Global-rating query implementation and bounded live facet helper. Universal cross-owner discovery is still incomplete.                                                       | `04f4f9bd` / `6d128a9756` (dev); `2f1adf32` / `df24ff9ab6` (dev); `ad63e27b` / `18ff947641` (dev)                                                                                                                                                                      |
| Search / native coverage state         | Durable coverage-store allocation/enrolment/completion CAS and real subject/home story bindings. State machinery is not the full real-source closure.                                                                     | `09409fb9` / `2adc32765d` (dev); `902c1b08` / `6d2b027b77` (main); `d80ebaaa` / `df357da257` (main)                                                                                                                                                                    |
| Semantic / relations                   | `GET /v1/subjects/{id}/relations`, inverse relation reads and `GET /v1/subjects/{id}/graph`; Realm-context relations and custom definition activation.                                                                    | `9a340329` / `3e4dbc2919` (dev); `56fb2ca0` / `e0af08c228` (dev); `74bbfb65` / `4a152e780e` (dev); `b45fda7a` / `848119dc8b` (dev); `dd0ae332` / `bf7f06d39a` (dev)                                                                                                    |
| Semantic / identities and presentation | Account graph agents and verification linkage, consenting pen-name/collective links, cover summaries and ordered story arcs.                                                                                              | `b00c0940` / `7e0cf2a22e` (dev); `9cb0e27b` / `de2d81e4f9` (dev); `f4afed4e` / `c31665e85f` (dev); `172f348d` / `ef2f35780c` (dev); `1a8e5bbf` / `834be85476` (dev)                                                                                                    |
| Semantic / definitions and Zone base   | Released library-profile vocabulary and word/form/diet data; Zone resource CRUD/configuration/publish/delete/restore at `/v1/zones`. Zone union/query execution is not delivered by that base.                            | `abf2ba63` / `fb7ffaca82` (dev); `069ae09e` / `d41ac8dc6e` (dev); `eaeb571a` / `d2262f0daf` (dev)                                                                                                                                                                      |
| Web / public subject and agent pages   | Real subject views, common covers, compact relations, account page read kinds and localized property labels; `/subjects/$id[/$slug][/$view]`, `/@handle`.                                                                 | `089fe259` / `7c193a2209` (dev); `ccd60834` / `c2bf7fe4b3` (dev); `ed29b7fa` / `dd4daf62bb` (dev); `fd0336fa` / `9a17de7a92` (dev)                                                                                                                                     |
| Web / search and boards                | Rating-sort control at `/search`; Active/Hot/New thread sorting on `/boards/$id` and thread context/header repairs.                                                                                                       | `e9f4dd87` / `3c2bb84731` (dev); `27e4ad3d` / `8bb03224ba` (dev); `027131cf` / `8f7ff41c1a` (dev)                                                                                                                                                                      |
| Web / Library and Collections          | `/library/copies` subject filtering, profile-aware choices, public progress logs at `/logs/$id`, settings for private Collections and styled `/collections/$id`.                                                          | `86b896fe` / `336e908111` (main); `3f99d572` / `ff3f87ceb2` (dev); `85524f56` / `4e4a191f94` (main); `90f0da61` / `d9a1975800` (dev); `c94897b4` / `3db75d4318` (dev)                                                                                                  |
| Web / community and notices            | Post mention format/editor, common signed-out Join action, feedback/rating display components; backend notice APIs exist separately from unfinished inbox polish.                                                         | `48da290e` / `738f14c3a8` (dev); `7cd762ad` / `c9c731d793` (dev); `9737bcb2` / `844ec7a859` (dev); `bb9a92de` / `a63febfb27` (dev)                                                                                                                                     |
| Web / publication and Zone shell       | Anonymous public rendering, board/thread canonical metadata, sitemap/robots serving, and `/zones/$id[/subjects/$subjectId[/$view]]` shell. The shell does not supply the missing Zone evaluator or all sitemap producers. | `9ae01bc9` / `03c85b591b` (dev); `6c4ffd25` / `0115f8a9b6` (dev); `9829e48f` / `07196cd607` (dev); `d3a53740` / `2470887a4b` (dev); `a1c0aafd` / `3c79986041` (dev); `56b4e815` / `42e69d504e` (dev)                                                                   |
| Performance / development tooling      | Deterministic database settlement diagnostics, database-independent kernel/Auth typecheck setup, cheap pinned Bun provisioning, and lazy Search-container lifetime.                                                       | `849a8ce4` / `415d455be8` (dev); `4d6fb53b` / `e6f9e7ebe6` (dev); `961f4625` / `d203351345` (dev); `4dc5b046` / `2602165e1e` (dev); `e66fcaa9` / `2837b901d4` (dev)                                                                                                    |
| Control-plane / delivery tooling       | Durable retry intents, pending-start recovery, acceptance enforcement, mechanical Markdown/translation conflict handling, consistent control-plane branch propagation and process-group shutdown.                         | `de85ef5e` / `fd9ba8681e` (main); `7f000f61` / `0f110985d2` (dev); `86585e9d` / `00ff7375b0` (dev); `f6eb7e49` / `760db046dc` (main); `572b6581` / `2ea9b1e2c9` (main); `450aeb6c` / `fbd181022e` (main); `c5c121c6` / `426c262414` (main)                             |

The tracked source inventories behind these claims are
[`contracts/openapi.json`](https://github.com/rezics/rezics-next/blob/ba52753840/contracts/openapi.json),
[`apps/web/src/routes`](https://github.com/rezics/rezics-next/tree/ba52753840/apps/web/src/routes),
and the native modules named by each task. OpenAPI existence alone was not
counted as working implementation. For example, the actual rating query now
has code, while the Collection source factory still declares its missing
implementation explicitly.

The following source probes distinguish an export from working behaviour.
All are repository source under AGPL-3.0-only at the pinned dev revision:

| Exact source path and link                                                                                                                                                             | Evidence and implication                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`services/kernel/src/search/rating-query.ts`](https://github.com/rezics/rezics-next/blob/ba52753840/services/kernel/src/search/rating-query.ts)                                       | Native rating-subject query implementation; the earlier unavailable contract is no longer the whole story.                                                                  |
| [`services/kernel/src/library/collection-source.ts`](https://github.com/rezics/rezics-next/blob/ba52753840/services/kernel/src/library/collection-source.ts)                           | `createCollectionSource` still returns unavailable operations. `collection-source-native.ts` adds real supporting reads, which do not make this public owner factory ready. |
| [`services/kernel/src/library/canonical-source-store.ts`](https://github.com/rezics/rezics-next/blob/ba52753840/services/kernel/src/library/canonical-source-store.ts)                 | Explicit derived-storage ABI and prerequisite list; exports are not production writer/scheduler readiness.                                                                  |
| [`services/kernel/src/library/bulk-contract.ts`](https://github.com/rezics/rezics-next/blob/ba52753840/services/kernel/src/library/bulk-contract.ts)                                   | Contract factories cannot establish a complete bulk command/status/cancel journey.                                                                                          |
| [`services/kernel/src/library/listing-freshness-contract.ts`](https://github.com/rezics/rezics-next/blob/ba52753840/services/kernel/src/library/listing-freshness-contract.ts)         | Contract declarations and unavailable implementations remain distinct from native listing freshness.                                                                        |
| [`services/kernel/src/semantic/public-filter-source-contract.md`](https://github.com/rezics/rezics-next/blob/ba52753840/services/kernel/src/semantic/public-filter-source-contract.md) | Explicit unimplemented execution and privacy/ACK race obligations; the contract is not the implementation receipt.                                                          |

### Material landed without a new running capability

These are useful evidence or contracts, but must not be reported as finished
product. Some add TypeScript interfaces in product directories and therefore
also inflate the mechanical product-line metric.

| Goal / delivered surface            | Observable addition or repair since October 26                                                                                                      | Task / landing commit / branch                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Commerce / bulk and shelf contracts | Executable specifications, throwing stores and interface refinements; no bulk admission/status/cancel implementation from these tasks.              | `51087a8a` / `0e01ce44f2` (dev); `2700f986` / `78268fbb1a` (dev); `20393eff` / `0e8a95c5fb` (dev)                                  |
| Commerce / canonical sources        | Zone/Collection Source contract and derived access-path ABI. Later `294146ec` supplies some native reads, not complete composition.                 | `01142def` / `1f836e3f9c` (dev); `8dcb80b3` / `4399a4332f` (dev)                                                                   |
| Search / source contracts           | Global-rating source and scope-source interfaces; rating API wiring originally accepted formatting while the query was still unavailable.           | `180ea297` / `2708f26181` (dev); `2986b188` / `b1da296be1` (dev); `48b891bd` / `d874a24957` (dev)                                  |
| Semantic / privacy and closure      | Native public-filter source contract, identity cutover/coowner studies and completion audits; the contract lists unimplemented execution/ACK races. | `836b804c` / `c540d300eb` (dev); `643e15b7` / `186d49c927` (dev); `be7e5248` / `3262384397` (dev); `6243c934` / `1b7f2b2d2a` (dev) |
| Content / notices and appeals       | Owner-document adoption preceded the actual notice/appeal implementations above.                                                                    | `04832b47` / `6753c60c6f` (dev)                                                                                                    |
| Web / consent acceptance            | Frozen website-consent case correction; it repairs the test contract, not sign-in functionality.                                                    | `6c621e5b` / `3975fa3043` (dev)                                                                                                    |

Other research/reviews include `docs/research/universal-search.md`, the paired
Library scoped-text plans, paired identity-concurrency protocols, provider
audits and capability manifests. Full-period planning classifications below
separate their count and inferred allowance from implementation. A report
landing is evidence delivered, not an API delivered.

### First public scope, read against actual composition

Authority is [`docs/scope.md`](https://github.com/rezics/rezics-next/blob/ba52753840/docs/scope.md).
“Working core” means the named core path exists with native evidence; “partial”
means the full scoped system is not proved complete. “Specified only” below
applies to the named missing extension, not to an already working adjacent API.
No broad system is called release-complete merely from a green fragment.

| Scope system                                                                | State at cutoff                                 | Plain assessment                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subject pages, relations, editions, credits                                 | Partial; working core                           | Subject/agent routes, relations and graph reads work; full anonymous publication, rating input and metadata are still held or in flight.                                                                                                         |
| Catalogue, editorial contributions, identity, definitions, vertical editors | Partial; working core                           | Native catalogue/definitions/relations and released data exist; scalable identity cutover, composed current disclosure and complete vertical journeys are unfinished.                                                                            |
| Bangumi, VNDB, Open Library, Wikidata imports                               | Partial; working core                           | All four provider paths exist; pipeline and CLI improved. End-to-end released-data/publication, known-reference relay and lifecycle/revocation closure remain unproved. Recipe-site import is explicitly excluded.                               |
| Search, facets, discovery                                                   | Partial; working core                           | Basic catalogue search, facets and Global rating order have native code; universal/shared conditions, private predicates, retained preparation and real-source cross-surface closure remain incomplete.                                          |
| Library, Collections, progress, copies                                      | Partial; working initial core                   | CRUD, sessions, copies, published logs and shelf slices exist. Profiled writes, independent labels/support, built-in dynamic Collections, complete source composition and bulk execution are not a finished journey; several are specified only. |
| Ratings and reviews                                                         | Partial; working API                            | Voting/populations and Global public aggregate exist, review/forum infrastructure exists; subject rating writer UI is held and complete contextual/release acceptance is open. Realm rating sorts are deferred.                                  |
| Posts, threads, boards                                                      | Working core; partial release proof             | Native APIs and board/thread pages, sorts, reactions and mentions exist. Full capability/privacy/publication matrix is not closed.                                                                                                               |
| Articles, hosted works, media                                               | Partial and intentionally closed                | Media/content infrastructure exists; product polish/public opening is outside the current open surface, as scope requires.                                                                                                                       |
| Realms and Spaces                                                           | Working core; partial release proof             | Membership, joins/bans, resources and web routes exist; cross-owner privacy and composed publication still have open cases.                                                                                                                      |
| Zones                                                                       | Partial resource base; evaluator specified only | CRUD/configuration/publish and shell exist. Mounted Collection/saved-scope union, useful query/list/page execution and lifecycle/custody closure remain absent as a complete path.                                                               |
| Agents and public profiles                                                  | Working core; partial release proof             | One-page linking, profile updates, speakers, verification and handle routing exist; wider publication/erasure acceptance remains open.                                                                                                           |
| Moderation, reports, appeals                                                | Working core; partial closure                   | Reports, decisions, takedown/restore and minimal appeals have native implementation. Do not substitute that for all cross-owner disclosure/erasure outcomes.                                                                                     |
| Notifications                                                               | Working minimal backend; partial interface      | Notice storage/inbox/count/seen APIs exist. Complete reply/mention/moderation delivery and current access/preferences journey needs final capability evidence and UI completion.                                                                 |
| Follows                                                                     | Working edge core; partial new counts/support   | Follow edges/list pages exist. New owner-only counts and personal-support interactions are not complete merely because their contracts exist.                                                                                                    |
| Commerce offers, checkout, orders, entitlements                             | Working native core; partial public readiness   | Native buyer/provider workflows and web start/return exist, with simulated external-provider boundary in native tests; no claim of configured live payment deployment. Points deferred.                                                          |
| Accounts, authentication, preferences, deletion                             | Working core; partial erasure completion        | Registration/sign-in/session/consent/preferences and terminal coordinator exist. Complete cleanup across every participant, durable history and retention is not finished.                                                                       |
| Sitemaps, metadata, sharing, SEO                                            | Partial                                         | Robots/sitemap serving, exporters/feed slices and board/thread metadata exist. Subject metadata task remains held and all producer/publication closure is unfinished.                                                                            |
| Feeds; recommendations; partner API; points                                 | Not started for this release / deferred         | Explicit scope exclusions, not missing first-public commitments. Curated rankings/search sorting and Collection ItemList export are separate in-scope obligations.                                                                               |

There is no evidence for saying the first public scope is finished. There is
also no evidence for saying nothing has been built. The dominant gap is
**composition and release closure**. Capabilities manifests are useful lists
of obligations, but some refer to older inspected bundles: Semantic's manifest
says words/diet data is missing while `069ae09e` has since landed that data.
Use the code/revision and a native journey receipt, not stale stage prose.

## Output, daily and by Goal

| UTC day    | Landed tasks | Product +/− churn | Tests churn | Docs/spec/research churn | Tooling churn |
| ---------- | ------------ | ----------------- | ----------- | ------------------------ | ------------- |
| 2026-10-25 | 762          | 159,493           | 254,043     | 8,099                    | 7,305         |
| 2026-10-26 | 420          | 67,267            | 126,383     | 3,593                    | 5,177         |
| 2026-10-27 | 391          | 68,000            | 127,698     | 26,102                   | 5,876         |
| 2026-10-28 | 400          | 28,395            | 98,981      | 43,015                   | 8,075         |
| 2026-10-29 | 169          | 20,083            | 41,522      | 12,444                   | 5,504         |

| Goal          | 10-25 | 10-26 | 10-27 | 10-28 | 10-29 | Total / main |
| ------------- | ----- | ----- | ----- | ----- | ----- | ------------ |
| accounts      | 141   | 97    | 49    | 38    | 19    | 344 / 194    |
| commerce      | 54    | 32    | 66    | 59    | 18    | 229 / 82     |
| content       | 126   | 118   | 18    | 31    | 16    | 309 / 212    |
| imports       | 93    | 17    | 10    | 36    | 6     | 162 / 106    |
| search        | 60    | 16    | 76    | 66    | 5     | 223 / 67     |
| semantic      | 67    | 39    | 52    | 44    | 18    | 220 / 93     |
| web           | 86    | 49    | 68    | 35    | 41    | 279 / 109    |
| performance   | 63    | 48    | 37    | 67    | 20    | 235 / 88     |
| control-plane | 43    | 4     | 15    | 24    | 26    | 112 / 77     |
| kernel        | 29    | 0     | 0     | 0     | 0     | 29 / 29      |

| Goal          | Product added | Product deleted | Tests churn | Docs churn | Tooling churn |
| ------------- | ------------- | --------------- | ----------- | ---------- | ------------- |
| accounts      | 43,662        | 6,140           | 114,751     | 9,378      | 1,109         |
| commerce      | 21,296        | 1,179           | 62,622      | 15,207     | 12            |
| content       | 41,195        | 5,077           | 107,409     | 2,719      | 20            |
| imports       | 9,768         | 560             | 45,230      | 6,165      | 3             |
| search        | 15,646        | 1,686           | 41,059      | 8,389      | 6             |
| semantic      | 45,032        | 5,173           | 64,613      | 28,326     | 6             |
| web           | 103,882       | 28,354          | 114,332     | 6,538      | 37            |
| performance   | 3,414         | 484             | 55,666      | 8,771      | 6,535         |
| control-plane | 363           | 103             | 13,060      | 5,334      | 10,721        |
| kernel        | 3,788         | 165             | 297         | 62         | 7             |
| unattributed  | 6,190         | 81              | 29,588      | 2,364      | 13,481        |

| Class     | Added   | Deleted | Churn   |
| --------- | ------- | ------- | ------- |
| product   | 294,236 | 49,002  | 343,238 |
| tests     | 598,580 | 50,047  | 648,627 |
| documents | 81,353  | 11,900  | 93,253  |
| tooling   | 27,464  | 4,473   | 31,937  |
| excluded  | 567,868 | 208,663 | 776,531 |

Non-generated counted churn is **1,117,055 lines**: product 30.7%, tests
58.1%, documents 8.3%, tooling 2.9%. Excluded material is another 776,531 lines.
Product additions are **294,236**, deletions 49,002; their difference is
245,234, not a unique final-code count. Tests produce 1.89 times product churn.
This is not proof that tests are waste: many privacy, authorization and durable
workflow contracts need them. It is proof that gross Git volume substantially
overstates effective product delivery.

The last 48 hours landed **744 tasks**: product churn **57,150**, tests 189,468,
documents 68,379 and tooling 18,233 (plus 66,371 excluded). Product is only
17.2% of that counted churn. Since October 26, 1,380 tasks landed; they are not
1,380 user-visible capabilities. Early rewrite scaffolding makes direct
before/after rate comparisons descriptive, not a controlled productivity test.

## Spend and manager traffic

| UTC day    | codex-1 observed pp | codex observed pp | Claude observed pp | Attempts started | Worker-hours |
| ---------- | ------------------- | ----------------- | ------------------ | ---------------- | ------------ |
| 2026-10-25 | 120.0               | 68.0              | 0.0                | 1420             | 252.5        |
| 2026-10-26 | 57.0                | 68.0              | 65.0               | 822              | 400.8        |
| 2026-10-27 | 95.0                | 97.0              | 34.0               | 812              | 802.3        |
| 2026-10-28 | 91.0                | 91.0              | 0.0                | 834              | 898.5        |
| 2026-10-29 | 28.0                | 67.0              | 0.0                | 838              | 688.5        |

| UTC day    | codex-1 attempts | codex attempts | Claude attempts | Grok | Cursor | Cursor-Grok | Fixture |
| ---------- | ---------------- | -------------- | --------------- | ---- | ------ | ----------- | ------- |
| 2026-10-25 | 552              | 655            | 0               | 211  | 0      | 0           | 2       |
| 2026-10-26 | 142              | 315            | 229             | 34   | 59     | 43          | 0       |
| 2026-10-27 | 300              | 425            | 73              | 0    | 0      | 14          | 0       |
| 2026-10-28 | 394              | 440            | 0               | 0    | 0      | 0           | 0       |
| 2026-10-29 | 220              | 618            | 0               | 0    | 0      | 0           | 0       |

| Account worker-hours | 10-25 | 10-26 | 10-27 | 10-28 | 10-29 |
| -------------------- | ----- | ----- | ----- | ----- | ----- |
| codex-1              | 62.9  | 50.9  | 279.1 | 396.4 | 198.0 |
| codex                | 104.5 | 166.1 | 459.2 | 502.1 | 490.5 |
| claude               | 0.0   | 115.1 | 57.0  | 0.0   | 0.0   |
| grok                 | 85.1  | 13.4  | 0.0   | 0.0   | 0.0   |
| cursor               | 0.0   | 18.6  | 0.0   | 0.0   | 0.0   |
| cursor-grok          | 0.0   | 36.7  | 7.0   | 0.0   | 0.0   |
| fixture              | 0.2   | 0.0   | 0.0   | 0.0   | 0.0   |

Measured readings after period filtering: codex-1 2,850, codex 4,413,
Claude 436 (duplicate observations removed). Reset-discontinuity
pairs: 6, 5 and 1 respectively. Daily sums are 391 pp, 391 pp and 99 pp.
Claude's absent later readings do not prove zero account usage. Other provider
allowances and manager-only burn are unknown. Attempts/hour residency include
those providers, so allowance-normalized rates omit an unknown resource cost.

There are **4,726 in-period starts** and **3,042.6 worker-hours**; 51 attempts
are in flight at cutoff. Recent window: **2,064 starts**, **2,040.9 worker-hours**,
and **384 observed pp**. The two imported bootstrap tasks remain in the task
inventory but their three pre-period attempt records are not active work.

Token totals below are **recorded telemetry**, not corrected provider billing.
Cached input is already part of input; reasoning is already part of output.
Date attribution uses attempt start because per-response timestamps are not
available consistently in the retained attempt stream.

| UTC start day | Record rows | Input tokens   | Cached input (subset) | Output tokens |
| ------------- | ----------- | -------------- | --------------------- | ------------- |
| 2026-10-25    | 1420        | 5,674,503,695  | 5,520,373,888         | 39,693,607    |
| 2026-10-26    | 822         | 5,911,428,329  | 5,793,914,109         | 30,139,155    |
| 2026-10-27    | 812         | 11,035,134,673 | 10,866,230,544        | 36,379,978    |
| 2026-10-28    | 834         | 8,514,561,826  | 8,336,724,096         | 26,714,699    |
| 2026-10-29    | 785         | 6,555,956,925  | 6,438,511,360         | 17,915,206    |

Whole-period saved records total **37,691,585,448 input**, of which
36,955,753,997 cached, plus **150,842,645 output**. Recent start cohort totals
21,411,059,988 input, 21,022,551,132 cached and 63,076,744 output across
2,011 records. Of 4,673 in-period record rows, 4,488 have nonzero input/output.
Across all saved records, 1,622 identify `codex-session` usage and 31 identify
`attempt-profile`; older rows lack that provenance. The three raw-sample
mismatches include `738f5acd/1`, `fa81d356/7`, `7545cdad/1`: saved counters exceed
terminal event counters. The existing
[`agent-token-efficiency` audit](https://github.com/rezics/rezics-next/blob/ba52753840/docs/research/agent-token-efficiency.md)
explains compaction/resume accounting and found 51.99% of its own earlier
Codex-winning cohort's raw tokens in nonwinning attempts. That is independent
corroboration, not a statistic extrapolated to this larger cohort.

Inbox events have **no creation timestamp**. The table therefore measures
events by `read_at` UTC day, not exact arrival traffic. It includes instructions
as well as blockers and may move old events to their eventual read day. A true
arrival-per-day series cannot be recovered from this schema. Zero undated
events must not be silently imputed to today.

| Manager       | 10-25 | 10-26 | 10-27 | 10-28 | 10-29 | Last 48h | Undated / unread |
| ------------- | ----- | ----- | ----- | ----- | ----- | -------- | ---------------- |
| supermanager  | 194   | 244   | 444   | 599   | 559   | 1395     | 7                |
| accounts      | 306   | 205   | 113   | 157   | 195   | 402      | 0                |
| commerce      | 93    | 69    | 129   | 161   | 157   | 398      | 4                |
| content       | 307   | 205   | 99    | 129   | 109   | 277      | 0                |
| imports       | 118   | 49    | 40    | 73    | 50    | 137      | 0                |
| search        | 99    | 30    | 113   | 190   | 128   | 372      | 1                |
| semantic      | 164   | 81    | 172   | 318   | 241   | 640      | 3                |
| web           | 153   | 81    | 186   | 154   | 212   | 441      | 0                |
| performance   | 123   | 107   | 82    | 149   | 191   | 370      | 0                |
| control-plane | 0     | 0     | 0     | 0     | 0     | 0        | 0                |
| kernel        | 48    | 0     | 0     | 0     | 0     | 0        | 18               |
| library       | 0     | 0     | 0     | 0     | 0     | 0        | 1                |
| community     | 0     | 0     | 0     | 0     | 0     | 0        | 1                |

Of 7,861 rows, the supermanager alone has 2,040 dated reads. For the last
48 hours use `read_at >= 1793111313000`; the same limitation applies. Traffic
is not model turns and cannot be priced without manager session usage. Large
message volume is an observable coordination load, not a measured token bill.

## Efficiency and outcomes

P is product churn (+ and −), A is inferred allocated observed pp, H is
worker wall-hours. Ratios are `P/A`, `landed/A`, `P/H`, `landed/H` and
`attempts/landed`. They measure throughput, not quality. Kernel is an early
bootstrap cohort, not a comparable current Goal; unattributed code stays out
of individual-Goal numerators.

| Goal          | Attempts | H     | A pp (inferred) | P/A     | Landed/A | P/H     | Landed/H | Attempts/landed |
| ------------- | -------- | ----- | --------------- | ------- | -------- | ------- | -------- | --------------- |
| accounts      | 822      | 454.8 | 175.6           | 283.6   | 1.96     | 109.5   | 0.76     | 2.39            |
| commerce      | 498      | 420.4 | 89.5            | 251.1   | 2.56     | 53.5    | 0.54     | 2.17            |
| content       | 754      | 395.8 | 132.4           | 349.6   | 2.33     | 116.9   | 0.78     | 2.44            |
| imports       | 274      | 88.5  | 33.5            | 307.9   | 4.83     | 116.7   | 1.83     | 1.69            |
| search        | 380      | 172.0 | 50.5            | 343.4   | 4.42     | 100.8   | 1.30     | 1.70            |
| semantic      | 481      | 341.2 | 90.4            | 555.1   | 2.43     | 147.2   | 0.64     | 2.19            |
| web           | 763      | 793.9 | 195.7           | 675.8   | 1.43     | 166.6   | 0.35     | 2.73            |
| performance   | 445      | 242.4 | 88.1            | 44.3    | 2.67     | 16.1    | 0.97     | 1.89            |
| control-plane | 268      | 132.0 | 24.6            | 18.9    | 4.55     | 3.5     | 0.85     | 2.39            |
| kernel        | 41       | 1.6   | 0.7             | 5,340.5 | 39.18    | 2,416.8 | 17.73    | 1.41            |

| Goal, last 48h | Landed | Product churn | H     | A pp (inferred) | P/A   | P/H  |
| -------------- | ------ | ------------- | ----- | --------------- | ----- | ---- |
| accounts       | 80     | 4,996         | 232.6 | 43.4            | 115.0 | 21.5 |
| commerce       | 118    | 7,295         | 318.7 | 65.1            | 112.1 | 22.9 |
| content        | 51     | 8,307         | 203.8 | 36.4            | 228.4 | 40.8 |
| imports        | 44     | 208           | 40.0  | 6.5             | 31.8  | 5.2  |
| search         | 109    | 4,193         | 136.4 | 33.0            | 127.1 | 30.7 |
| semantic       | 83     | 6,703         | 231.4 | 48.8            | 137.4 | 29.0 |
| web            | 95     | 23,566        | 596.8 | 102.9           | 229.1 | 39.5 |
| performance    | 102    | 1,882         | 157.5 | 29.2            | 64.4  | 11.9 |
| control-plane  | 62     | 0             | 123.6 | 18.7            | 0.0   | 0.0  |

Whole: **389.6 product churn lines/observed pp**, **2.43 landings/pp**,
**112.8 product lines/worker-hour**, **0.70 landings/hour**, **2.21 attempts per
landing**. Product additions alone are 334.0/pp and 96.7/hour. Last 48 hours:
**148.8 product churn lines/pp**, **1.94 landings/pp**, **28.0 product lines/hour**,
**0.36 landings/hour**. Product conversion has deteriorated even while workers
remain busy. This is not a model comparison: task maturity, provider coverage,
cached context, review work and growing queues are confounders.

Outcome precedence: terminal saved `passed` is success; explicit cancellation
next; then spec/scope failure kind, tool/environment/pool exhaustion, stalled/
early-stop/round-limit, otherwise superseded, residual failure or in-flight.
An attempt superseded after reporting a concrete conflict retains the conflict
class; “superseded” is not allowed to erase the reason for lost work.

| Attempt outcome | Count | Worker-hours | Allocated pp (inferred) |
| --------------- | ----- | ------------ | ----------------------- |
| environment     | 818   | 629.1        | 134.5                   |
| success         | 2142  | 981.8        | 330.8                   |
| superseded      | 509   | 512.7        | 124.1                   |
| stalled         | 140   | 130.4        | 48.4                    |
| scope-growth    | 326   | 192.1        | 79.3                    |
| spec-conflict   | 592   | 329.8        | 105.7                   |
| cancelled       | 67    | 124.4        | 38.6                    |
| other-failure   | 81    | 77.0         | 10.5                    |
| in-flight       | 51    | 65.4         | 9.1                     |

Recent outcomes are classified at cutoff, including attempts that began
earlier but overlap the window. Starts are the recent cohort; hours are clipped
to the recent window. Allowance uses observed movements whose later reading
is in that window, assigned once using the same overlap rule. An observation
interval crossing the boundary cannot be divided accurately; this is a
resolution limit of the readings, not exact per-response metering.

| Outcome, last 48h | Overlapping attempts | Starts | Worker-hours | Allocated pp (inferred) |
| ----------------- | -------------------- | ------ | ------------ | ----------------------- |
| superseded        | 263                  | 243    | 343.4        | 63.0                    |
| environment       | 599                  | 591    | 548.7        | 100.8                   |
| success           | 741                  | 733    | 579.9        | 121.7                   |
| spec-conflict     | 241                  | 239    | 196.6        | 38.1                    |
| stalled           | 62                   | 56     | 78.0         | 13.8                    |
| cancelled         | 31                   | 28     | 104.6        | 18.8                    |
| scope-growth      | 45                   | 44     | 49.5         | 8.5                     |
| other-failure     | 79                   | 79     | 74.7         | 10.2                    |
| in-flight         | 51                   | 51     | 65.4         | 9.1                     |

Recent success accounts for only 31.7% of the observed allocation, versus
37.5% over the whole period. Environment outcomes account for 100.8 pp in the
recent window versus 134.5 pp overall: most observed environment loss is recent.
The recent window therefore needs both better product composition and the
already-in-progress infrastructure repairs.

Success consumes about **37.5% of allocated observed pp**; the remainder
contains failed work, replacements and ongoing work, not all avoidable waste.
Cancelled task inventory is 236 tasks; cancellation of a task and cancellation
of an individual attempt are different counts. Non-Codex unmeasured allowance
and manager consumption prevent a precise all-provider waste fraction.

### Dispatch to integration: do not invent an unavailable phase split

For 2,142 landed tasks, use created time, earliest in-period attempt start,
last landing request before successful integration, then integration event.
Retries and manager response gaps are retained rather than dropped. Imported
tasks do not supply in-period attempt timing.

| Observable interval         | Summed task-hours | p50 hours | p90 hours | What it includes                                                                   |
| --------------------------- | ----------------- | --------- | --------- | ---------------------------------------------------------------------------------- |
| Dispatch → first start      | 3,303.8           | 0.0002    | 5.0       | Dependencies plus capacity/start queue; not pure admission latency                 |
| First start → final request | 3,355.0           | 0.3692    | 3.6       | Implementation, worker checks/slot waits, failed landings, retries, manager delays |
| Final request → integration | 613.0             | 0.0539    | 1.0       | Landing queue, setup/rebase, acceptance/check slots and integration execution      |
| Dispatch → integration      | 7,271.8           | 1.1403    | 8.8       | Complete elapsed path; the three preceding sums partition it                       |

Passing gate events report **61.47 host-hours**. Do not subtract them from
613.0 landing-residence hours and call the difference queue time: `hostMs` does
not consistently describe the same phase across runner versions. In 2,726
readable landing logs, only 22 explicit `remote-check: slot wait N s` lines
sum to **1,059.768 seconds (0.294 hours)**. That is a sparse observed subtotal,
not the whole check queue. Worker slot waiting is largely inside the second
interval and cannot be separated reliably from these records.

For example inbox event 7,861 reports `e8a178c3/1` running 2h36m with 2h24m
waiting, but other watchdog messages report waits exceeding attempt wall time
(`20acf234/3`: 2h15m run versus 2h45m wait). Summing those messages would invent
time. The report therefore leaves **implementation-only, complete check-slot
wait, and pure landing-queue wait unidentifiable**, with their measured
containing intervals above. Missing timestamps are an instrumentation defect,
not permission to present a fabricated four-way split.

## Planning, rework and dependency evidence

Classify by declared research/specification first, then explicit frozen-test
amendment language, then all-Markdown review/document paths, all-test paths,
performance/control-plane tooling, and remaining product implementation.
The frozen-amendment count is a reproducible text heuristic, not a manual
audit of every changed assertion. Current briefs can differ from their first
version; product implementation is an upper bound and includes contract stubs.

| Planning class         | Tasks | Task share | Landed | Worker-hours | Allocated pp | Allowance share (inferred) |
| ---------------------- | ----- | ---------- | ------ | ------------ | ------------ | -------------------------- |
| tooling                | 221   | 8.3%       | 183    | 230.4        | 49.5         | 5.6%                       |
| specification          | 372   | 14.0%      | 325    | 206.9        | 61.0         | 6.9%                       |
| product-implementation | 1391  | 52.5%      | 1093   | 1,940.7      | 554.3        | 62.9%                      |
| test-only              | 361   | 13.6%      | 293    | 347.3        | 123.5        | 14.0%                      |
| frozen-amendment       | 151   | 5.7%       | 116    | 251.1        | 77.8         | 8.8%                       |
| documentation-review   | 52    | 2.0%       | 42     | 16.1         | 3.6          | 0.4%                       |
| research               | 104   | 3.9%       | 90     | 50.1         | 11.4         | 1.3%                       |

| Planning class, last 48h | Overlapping attempts | Starts | Worker-hours | Allocated pp | Allowance share (inferred) |
| ------------------------ | -------------------- | ------ | ------------ | ------------ | -------------------------- |
| product-implementation   | 953                  | 914    | 1,253.3      | 235.0        | 61.2%                      |
| tooling                  | 322                  | 320    | 201.5        | 32.6         | 8.5%                       |
| test-only                | 189                  | 186    | 178.2        | 31.5         | 8.2%                       |
| specification            | 341                  | 340    | 189.2        | 45.3         | 11.8%                      |
| frozen-amendment         | 162                  | 159    | 160.4        | 27.9         | 7.3%                       |
| research                 | 96                   | 96     | 46.4         | 9.0          | 2.3%                       |
| documentation-review     | 49                   | 49     | 11.8         | 2.7          | 0.7%                       |

Specifications + research + documentation/reviews + frozen amendments are
**679 tasks (25.6%)**, consuming **153.8 pp (17.5%, inferred)**. Add test-only
tasks and that is **1,040 tasks (39.2%)**, **277.3 pp (31.5%)**. Research alone
is **104 tasks and 11.4 pp (1.3%)**. Blanket elimination of research would miss
the larger waste. Product implementation is 52.5% of tasks and 62.9% of
allocated pp, but includes unfinished primitives and interfaces. The seven
planning classes sum to the whole inventory; code classes and task classes
answer different questions.

Current dependency declarations affect **1,502 tasks (56.6%)** using `after`
or symbolic `waiting`; **1,331** have an `after` pointing to a known task.
At cutoff **115 are held**, **80 with no in-period attempt**. Their dispatch
ages range from 0.23 to 56.23 hours, median **19.70 hours**. Those are ages,
not proof of continuous holding. An eligibility-wait proxy (dispatch to latest
known prerequisite integration, capped at first start/cutoff) sums to 12,052.7
task-hours, p50 1.32h/p90 32.82h; **inferred**, because current briefs are not
a historical held-state transition log and named unresolved contracts have no
integration timestamp. Do not add this to worker-hours.

Concrete contract chains:

- Web rating writer `15a6a36c` is held at age 56.23h behind rating read
  `0963aae4` and anonymous-subject separation `ebfa31f6`; subject metadata
  `3e5d5330` is held at age 54.91h behind that separation and other page work.
  A real backend rating feature therefore still lacks its full public UI.
- Search real-source verification `2078af88` is held at age 53.79h behind six
  production/source/driver prerequisites. A green coverage-store fragment is
  not the promised default-worker search journey.
- Semantic `a69d5b99` and performance guard `31dec463` are held at ages 53.00h
  and 52.97h. The former explicitly awaits performance storage infrastructure
  and content work; the latter waits for that semantic work. This is a
  cross-Goal integration chain, not independently useful guard delivery.
- Accounts native durable binding `817b3745` and Content's native workflow
  binding repair `8cfeaa2f` appear in each other's current prerequisite
  descriptions. Both ultimately landed (`71350c3bae`, `db57284eae`), but the
  apparent reverse references show why current dependency state cannot be
  treated as an exact historical DAG. The binding required 15 attempts.

Current cross-Goal `after` edges include content→accounts **142**,
content→performance **62**, semantic→accounts **50**, accounts→performance
**49**, content→semantic **41**, search→semantic **39**, commerce→accounts
**37**, imports→semantic **30**, web→content **23**, web→accounts **21**.
These are edge counts, not independent delays; many converge on one producer.

There are **420 distinct brief-hash transitions over 255 tasks** (9.6% of all
tasks); 421 attempts carry change hashes because one pair repeats. Distribution:
149 tasks changed once, 67 twice, 26 three times, seven four times, five five
times and one six times. Earlier changes without hashes are not recoverable.

Of tasks with an in-period attempt, 1,420 have one attempt, 462 two, 413 three
to five and 115 six or more. Worst examples: `944262e7` **21**, `b6c2e2bc` and
`25566a54` **16**, `817b3745` and `5332fd52` **15**. A repeated attempt is not
necessarily rewritten code, but it necessarily repeats dispatch/settlement
and often context/check/review work. The current cancellation inventory alone
does not identify all superseded code; do not call every cancellation zero
value, since the imported control-plane bootstrap code was retained.

Brief size: **median 60 lines / 4,750 bytes**, p90 144 lines / 11,393 bytes,
maximum 1,840 lines / 87,504 bytes; 228,332 brief lines total. Estimated patch
size: median 260 lines, p90 700, maximum 9,000. Estimated-size bins: ≤200
985 tasks; 201–400 1,077; 401–800 391; >800 199. Declared paths: median four,
p90 eleven, maximum 47. Both extremes are visible: large multi-owner briefs
and tiny pieces that only make another task possible. Commerce's six separate
date/direction reader briefs exemplify repeated setup for one shelf capability.

### Own acceptance versus landing

Landing queue outcomes: **2,142 passed**, **588 failed**, **114 pending**.
Failures are **361 rebase**, **174 gate**, **45 scope**, **8 setup**. Of the
failures, **453 follow a worker JSON `status: success`**: 284 rebase, 142 gate,
23 scope, four setup. This is 16.6% of decided queue entries (453/2,730).
Of those, **358 explicitly claim an acceptance pass** in their result text
(233 rebase, 108 gate, 15 scope, two setup). This is a self-reported lower
bound, not independently verified pre-landing execution; the store has no
universal signed local-pass receipt. It answers the acceptance/landing question
without equating every successful worker exit with a passing acceptance.

Ten gate failures are explicitly marked `failsOnMain`; 44 failed outcomes
mention frozen files. Representative causes:

- `9586bafb/3`, landing 2,735: narrow acceptance passed, landing growth test
  rejected the activity-ascending probe bound. Related coverage was missing.
- `69ac9df1/3` and `/4`, landings 2,738/2,769: the two own acceptance tests
  passed, broader promotion-prefix tests failed. Fixing one contract was not
  enough to preserve callers.
- `68fe00e0/1`, landing 2,800: worker claimed three acceptance tests passed;
  landing hit command/process-environment isolation failures. The concrete
  follow-up `c5c121c6` landed process-group isolation repairs.
- `69da1884/9`, landing 2,734: `RemoteTransportError: remote-check: connection
  to c failed during remote command before a result`. This is environment,
  not evidence that the product acceptance was wrong.
- `001630df/1` and `/2`: the commerce driver was asked to prove price revision
  with no production revision port, then `{items:[]}` versus native
  `{entitlements:[]}` while both test and driver paths were frozen/restricted.
  These are recorded contract contradictions, not model inability.

## Per-Goal interpretation

| Goal          | Implementation tasks | Spec / research / review / freeze tasks | Test-only tasks | Tooling tasks | Implementation pp (inferred) | Spec/research/review/freeze pp (inferred) |
| ------------- | -------------------- | --------------------------------------- | --------------- | ------------- | ---------------------------- | ----------------------------------------- |
| accounts      | 262                  | 69                                      | 61              | 0             | 129.0                        | 21.3                                      |
| commerce      | 191                  | 123                                     | 22              | 0             | 52.1                         | 32.3                                      |
| content       | 216                  | 76                                      | 61              | 0             | 92.1                         | 25.7                                      |
| imports       | 47                   | 114                                     | 26              | 0             | 5.3                          | 17.3                                      |
| search        | 121                  | 117                                     | 17              | 0             | 27.8                         | 19.4                                      |
| semantic      | 181                  | 93                                      | 32              | 0             | 59.1                         | 25.2                                      |
| web           | 342                  | 25                                      | 18              | 0             | 188.2                        | 4.9                                       |
| performance   | 0                    | 42                                      | 122             | 111           | 0.0                          | 5.5                                       |
| control-plane | 0                    | 20                                      | 0               | 110           | 0.0                          | 2.0                                       |
| kernel        | 31                   | 0                                       | 2               | 0             | 0.7                          | 0.0                                       |

These are current-contract classifications, not an assertion that every
implementation brief produced a complete feature. Test-only and tooling spend
are separate from the two allowance columns; use the whole planning table for
their totals. The allocation remains a proxy and excludes unmetered providers.

| Goal          | What the output actually means                                                                                                                                                                                   | Largest next conversion opportunity                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| accounts      | 43,662 product additions and large native security/workflow coverage; comparatively little declared research. Many later attempts prove cross-owner safety rather than adding pages.                             | Complete one terminal-erasure journey across the fixed participants with real receipts; stop multiplying independent custody contracts.              |
| commerce      | 21,296 product additions versus 62,622 test churn and 15,207 document churn; many working shelf/storage fragments, missing full profiled Library/source/bulk composition.                                        | Join the existing shelf/profile/support primitives into one useful private-Library case before another standalone ABI.                               |
| content       | 41,195 product additions, actual ratings/notices/appeals and Realm protections; 107,409 test churn. Strong concrete product output, expensive shared native binding and lifecycle closure.                       | Close one reply/mention→notice→read/seen journey and its preferences/access variants, with web as consumer.                                          |
| imports       | 9,768 product additions; 83 of 187 tasks declared specification. Last 48h only 208 product churn lines despite 44 landings. Provider audits and final proof now dominate.                                        | Bind already-working provider output through released catalogue data and served pages; do not count each converter audit as a new import capability. |
| search        | 15,646 product additions; 83 specifications and 17 research tasks among 255. Native query/coverage work exists alongside source interfaces and 53h-held integration proof.                                       | Finish the actual default-worker source chain and one released-data query, then expand the matrix using that driver.                                 |
| semantic      | 45,032 product additions, much definitions/data; 28,326 document churn and 64,613 test churn. New relations/agents/Zone base are real, but privacy/identity/source contracts remain ahead of native composition. | One Zone or current-disclosure producer-to-consumer path, with actual dependency implementation and no second parallel authority document.           |
| web           | 103,882 product additions, the highest raw volume; 793.9 worker-hours, only 279 landings. Real page/UI improvements coexist with repeated screenshot/style cycles and unfinished backend-dependent flows.        | Finish rating input and anonymous subject publication before additional shell polish; evaluate complete user journeys, not screenshots alone.        |
| performance   | 3,414 product additions, 55,666 test churn and 6,535 tooling churn. Its leverage is enabling every other Goal, not direct page volume.                                                                           | After in-flight resource fixes, demonstrate stable native evidence on one blocker chain instead of opening another broad harness campaign.           |
| control-plane | 363 product additions are incidental; 10,721 tooling churn and 13,060 tests. It should be judged by avoided lost attempts and faster integration, not feature lines.                                             | Keep failed-pass provenance and phase telemetry trustworthy; do not expand the controller before existing changes measurably reduce rework.          |

These comparisons reject two misleading conclusions: Semantic's large YAML/
definition output is not automatically more useful than Content's smaller
completed workflow; Imports' high historical landings/allowance includes many
specs and audits. Conversely, performance and controller work can earn back
their cost across every Goal. Their benefit needs a before/after outcome,
not a count of tooling commits.

Manager-note evidence supports the same pattern:

- `.temp/goal/commerce/scoped-text-plan-pair-comparison.md`: both independent
  reports proposed title-only semantics although the shared contract required
  labels, aliases **and descriptions**; both correctly inspected the mapping.
  The avoidable work was misbriefed product meaning, not missing research.
- `.temp/goal/accounts/universal-search-research-accounts-review.md`: the
  review first claimed suspension changed no public discovery, then explicitly
  withdrew it after reading native `authn_fenced` behaviour. Native contracts
  must be checked before coowner approval, not after several relay messages.
- `.temp/goal/semantic/identity-concurrent-protocol-pair-comparison.md`:
  acquisition order, stable job-home custody and fairness were still open
  after paired reports. A comparison that has no adopted implementable next
  seam should stop dispatch, not spawn another broad implementation fiction.
- `.temp/goal/web/typecheck-classes.md`: three route-parameter spellings broke
  generated client intersections; generated declarations imported a service;
  root dependencies hid undeclared workspace imports. One cross-workspace
  contract defect generated many consumer failures and subsequent repair tasks.

## Causes and estimated avoidable share

The records cannot assign a causal allowance bill to each process defect.
The shares below are **judgement estimates of the avoidable portion**, not
percentages of all spend and not additional measured losses. Central shares
sum to 100%; ranges overlap in uncertainty and benefits are not additive.
Security, privacy, correct deletion and truthful cost proofs remain required.
Neither research nor tests are declared waste merely because they add no page.

| Cause                                                      | Evidence                                                                                                                                                                                     | Estimated share of avoidable waste                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Contract/readiness mistakes discovered after launch        | 592 spec-conflict and 326 scope-growth attempts; 420 brief transitions; concrete missing revision port / response-shape conflict; paired scoped-text reports solving the wrong meaning.      | 30% (20–40%)                                           |
| Fragmentation and cross-owner closure queues               | 1,502 dependency-bearing tasks, 115 held; six shelf readers dispatched separately; resource/ABI/source code lands without useful Zone/Library discovery; 53–56h-old held user-facing tasks.  | 25% (15–35%)                                           |
| Repeated environment/check/integration work                | 818 environment outcomes, 361 rebase refusals, process/environment leak at landing 2,800; prior check audit recovered 141.0 check-hours and 33.9 root-typecheck hours in its own 24h cohort. | 25% (15–35%); much already targeted by in-flight fixes |
| Acceptance/freeze mismatch and incomplete related coverage | 358 explicit own-pass claims followed by landing rejection; 44 frozen-file mentions; broader callers fail after narrow green tests; stale capability stage prose differs from code.          | 15% (10–25%)                                           |
| Manager relay/context reconstruction and repeated reviews  | 7,861 inbox events, 16.69MB of current briefs, coowner corrections after substantial review; earlier token audit identifies read/context and nonwinning work as large costs.                 | 5% (2–15%); manager tokens themselves unmeasured       |

Cancelled/superseded outcomes are symptoms distributed across these causes,
not an extra causal bucket. Likewise check waits lengthen worker residency
without necessarily burning allowance at the same rate as active model work.
The estimated process shares must not be added to the observed outcome shares.

## Ranked optimisation plan for the next day

Gains are **testable forecasts of landed useful product output per observed
allowance**, relative to a matched next-day cohort; they are not guaranteed
line-production targets. Keep useful native journeys as the primary outcome,
and product additions/pp as a secondary diagnostic so copied code, stubs or
deleted tests cannot improve the score. The repository already prescribes
brief preflight, third-attempt investigation and focused context in
[`docs/development/efficiency.md`](https://github.com/rezics/rezics-next/blob/ba52753840/docs/development/efficiency.md).
The changes below operationalize ownership and selection, rather than merely
rewriting those rules. They do not remove frozen assertions or public scope.

| Rank / expected gain (inferred)      | Concrete planning/process change                                                                                                                                                                                                                                                                                                                                                                              | Owner                                                                                   | Measure at +24h                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / +25–45%                          | Select three existing nearly-complete journeys, each with one integrating owner and a native demo receipt: subject rating input/publication; profiled private Library shelf; one default-worker released-data search. Stop new nonblocking feature/ABI branches for one day; reassign existing managers to the actual missing seams. Declare task complete only for the bounded behaviour its receipt proves. | supermanager; web, commerce, search managers own respective closures                    | At least three useful native journey receipts landed; no formatter/helper-only receipt counted; report product additions/pp and zero expansion of held user-facing WIP.                                                                                    |
| 2 / +15–30%                          | At dispatch, the consuming manager names actual prerequisite exports/routes, one caller and one native failing outcome on the current integrated revision. Producer and consumer agree the exact response/predicate once. If the port is absent, brief its smallest useful implementation and the consumer binding together; no third contract-only tier.                                                     | supermanager enforces; semantic and commerce managers pilot with search                 | Next ten pilot tasks: ≤1 contract/scope rejection, no launch against an absent factory, ≤1 brief transition per task. List exact exceptions rather than weakening acceptance.                                                                              |
| 3 / +10–25%                          | Size around one bounded useful behaviour, normally one native implementation plus caller/binding. Group symmetric shelf readers or equivalent adapters into one task when they share one fixture/check; split genuinely different authority/race boundaries. Replace multi-owner acceptance essays with a short outcome and links to one authoritative contract.                                              | commerce manager; semantic manager for cross-home/identity seams                        | Five briefs reviewed before launch; median first-attempt context/setup commands and attempts per useful landing fall ≥20% against comparable earlier work; no useful capability split into more than one pure ABI prerequisite without an explicit reason. |
| 4 / +10–20%                          | Use one release-closure board from existing task records: a named owner, current source revision, smallest remaining native proof and next consumer for each held public journey. Resolve semantic decisions once in the owner document and retire duplicate note interpretations. Distinguish code ready from publication accepted.                                                                          | supermanager; all named Goal managers maintain only their own rows                      | Every held first-public task older than 12h has one actionable next prerequisite; held public-task count decreases ≥25% and oldest age stops increasing without cancellations being called delivery.                                                       |
| 5 / +8–15%                           | Acceptance author traces each frozen scenario to the actual native transport and checks the driver contract before freezing. Add missing scenarios in new tests; change a frozen contract only through its separate owning amendment. Record why a related-file check is required; prevent format-only acceptance from masquerading as runtime proof.                                                         | accounts manager for shared personas/HTTP; content and web managers for their consumers | Next ten landings: zero test/product shape contradictions and ≤1 explicit-own-pass landing rejection attributable to missing related coverage; retain all old assertions. A freeze amendment has one owning reason and one consumer acknowledgement.       |
| 6 / +5–12%                           | Commission research only for a named unresolved choice with two plausible designs, evidence needed and a specific consumer implementation. Use one independent report by default; paired work only where the uncertainty materially affects privacy, bounded work or irreversible data design. Stop at an adoptable seam; do not use new reports to postpone an already decided implementation.               | supermanager; semantic and commerce managers for current paired research                | Every new report request names its decision and next task; zero duplicate investigation of an already adopted direction; each completed report adopted/rejected with reason within one manager turn and useful consumer work started within the day.       |
| 7 / +3–8%                            | Consolidate manager handoffs into a single concise evidence object: source revision, exact remaining question, proposed decision, one affected consumer. Coowner review returns accept or one counterexample; send another instruction only for a changed fact. Reuse the recorded native persona and response evidence instead of re-describing it.                                                          | supermanager; accounts, semantic and search managers pilot                              | Pilot instruction events per useful landed journey fall ≥30%; no unchanged-question relay after owner decision; unresolved questions older than 6h decrease, with manager-token savings reported only if actually measured.                                |
| 8 / indirect, enables honest control | Emit durable enqueue/start/check-slot-acquired/check-finished/landing-start/integrated timestamps and immutable local-pass commit+command+environment receipts; add inbox created-at and a deduplicated account-observation series. Version reports so imported cancellation artifacts and resumed counters cannot become invented spend. This is targeted missing telemetry, not a new scheduler.            | supermanager owns control-plane brief; performance manager owns check phase boundaries  | Next day ≥95% of new attempts have reconstructible disjoint phases and pass provenance; all inbox events have arrival time; account movement counted once. Do not claim historical gaps repaired.                                                          |

Expected gains overlap. Do not sum the percentages or promise an aggregate
speedup. Test the first two changes before creating another tooling programme.
Do not reduce required privacy, deletion, authorization or bounded-work cases
to make the day look productive. Do not optimize for exhausting allowance.

### Already in progress: expected effects, not new proposals

The maintainer explicitly identifies the following work as in progress; it
must not be redispatched as the optimisation plan. Recorded task state is an
observation at this audit cutoff, not a request to supersede its owner.

| Existing work                                   | Recorded evidence where available                                                          | Expected effect / next-day observation                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker-only acceptance; batch checks at landing | `68fe00e0` (landing); follow-up `c5c121c6` / `426c262414` (main)                           | Remove duplicate broad worker checks; compare check invocations and check-hours per useful landing, not just worker duration.                          |
| Parallel batch acceptance                       | `15e0c8b5` / `85dea39d33` (main)                                                           | Raise train service throughput on available slots; compare final-request→integration p90 with batch size and failure rate held visible.                |
| Admission and slot-lease repairs                | `bc31a85d` / `9d95b4290a` (dev)                                                            | Prevent load/swap overload and orphaned checks; compare environment attempts and stale occupied slots, without increasing concurrency to mask defects. |
| Reuse of passing results                        | Already in progress per contract; no separate complete historical receipt established here | Reduce repeated execution only when revision/command/environment identity permits it; measure reused checks and stale-result rejection.                |
| Stale tool blocker handling                     | `670da73d` / `0c8f0370e9` (main)                                                           | Avoid treating an old manifest error as a fresh tool failure; measure repeat blockers with no new command evidence.                                    |
| Pool policy reload                              | `ae1f3584` / `e4f943bdd9` (main)                                                           | Make current budgets effective in long-lived waiters; measure policy-change→admission response and absence of stale reserve decisions.                 |
| Watchdog ticket fix                             | `e8c2f10d` / `7324b61fe9` (main)                                                           | Avoid cancelling legitimate queued workers; measure queued starts misclassified as stalled and replacement attempts prevented.                         |

The prior
[`check-cost` audit](https://github.com/rezics/rezics-next/blob/ba52753840/docs/research/check-cost.md)
recovered 3,381 worker check logs and 502 landing logs in its own 24h evidence
window, with 141.002 reported check-hours, including 33.919 root-typecheck
hours. That supports a substantial opportunity for the existing work, but not
a prediction that all 141 hours are removable or that the audit covers all
hosts. Compilation reuse, admission and narrower checks should first reduce
environment loss and wall time; they will not implement missing Zone/Library
semantics or reconcile conflicting contract meanings.

## Decisions and verification for this research attempt

1. The explicit report path in the contract takes precedence over the generic
   research-directory instruction: there is one report at
   `tools/goal/reports/delivery-efficiency-20261029.md`, with no duplicate
   authority under `docs/research/`. Task identifiers appear because this
   contract expressly requires them; eight-character prefixes are unambiguous
   in the captured store and accompanied by landing commits.
2. UTC is used for all windows. October 29 is a partial day. Code history and
   captured operational state are pinned; later landings are excluded.
3. Ancestry and native evidence support implemented-slice claims, not fresh
   public deployment certification. Existing capability prose can be stale;
   a test declaration or unavailable stub never proves a finished user job.
4. Per-account observations are measured; per-task/Goal allowance allocation
   and causal savings are inferred. Unknown providers, missing inbox arrival
   times and unsplit check waits stay unknown. No fabricated completeness.
5. Imported bootstrap attempt residency is excluded; its two task contracts
   stay in the task inventory. This prevents bookkeeping cancellation from
   becoming several days of fictitious active work or specification spend.
6. No frozen file, existing acceptance test, package manifest or lockfile was
   edited. No external source code was copied. All retained source evidence
   is this repository or its operational records; no new external research
   dependency or product decision blocks the report.
7. The report is the named acceptance artifact; the explicit research
   instruction says **run no checks**, so neither the shell acceptance command
   nor root typecheck is run in this attempt. Nonempty report content and the
   calculations were reviewed as research, not asserted as a product check.

No tracked file outside the declared path changed. Temporary extraction and
analysis files are confined to this worktree's `.temp/delivery-research/`;
nothing was written under the shared `.temp/goal` or the main checkout.
