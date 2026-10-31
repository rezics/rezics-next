# What the tests protect, and what they leave open

Research snapshot: **2026-10-31**, development revision **`6d3f767467c85dbb9d3bb561d12af784407bd92c`**.
This is evidence and a recommendation for the owning managers. It does not adopt product behavior, certify
delivery, or report a passing test run.

The repository has **719,566 physical lines in 2,750 tracked test/spec-suffix files** at this revision.
Kernel alone accounts for **420,359** of those lines. A broader, explicitly defined test-related inventory
contains **925,869 lines**, including recordings, fixtures, stories, fake transports and harness support.
These are different boundaries. Neither number counts independently executable assertions or completed journeys.
The original receipt, revision and counting expression behind “400k+” were not supplied; the kernel subtotal is
compatible with that description, but does not establish its historical origin.

The sampled tests include substantial product protection: real search/index recovery, native Collection editing,
private Library navigation, rating persistence and payment settlement. The evidence does **not** support deleting
the backend tests as a class. It does support a more specific diagnosis: many interface tests prove that a supplied
response renders or that an adapter forwards a request; they leave the actual scope binding, composed page quality,
design judgment and published version outside their oracle. Some assertions actively preserve superseded design.
An example is the current header story requiring the composer's shadow to change on focus while only forbidding
a shadow on the inner input. Another is the home heading assertion equating rendered copy to the message that
still contains the rejected tagline.

## Evidence boundary and method

The research authority was read completely, including its backend addendum:
`.temp/goal/web/research-20261031.md`. The governing sources were
[feature design](../development/feature-design.md), [architecture](../architecture.md),
[scope](../scope.md), [Goal definitions](../goals/README.md), [subject pages](../subject-pages.md),
[Library and Collections](../library-and-collections.md), the applicable owner READMEs, the
[system inventory](system-inventory.md), and the applicable `design-status-*.md` reports. The inventory describes
an older revision and is a map for investigation, not a current capability receipt. Source at the inspected
development revision takes precedence over those reports' statements about missing code.

The audit combined a tracked-file census with call-path and assertion inspection. Twenty journeys below were
chosen to challenge the maintainer's specific symptoms, not sampled randomly. The explicitly allocated close-read
sample comprises 24 test files and 7,752 lines, about **1.08%** of the suffix inventory; additional source, stories,
driver support and selected assertions were inspected outside that allocation. This is not a branch-complete review
of those files or a semantic review of all 719,566 lines. No percentages of “valuable tests,” mutation scores,
coverage percentages, flake rates, execution times or current pass rates can be inferred from it.

No repository or reference tests, checks, compilers, builds, installs, stacks, native campaigns or backend
measurements were run. Counting and reading source are desk research. Every “would fail” judgment below is a
counterfactual about the inspected assertions **if the relevant case reaches them**. A declaration, a historical
receipt and an executed passing result at this revision are three different things.

The current public Storybook build was not identified. A read-only request to
`https://storybook.rezics.com/build.json` returned `HTTP Error 403: Forbidden`; this optional metadata observation
does not establish that the deployment is stale or broken. No second exhaustive capture campaign was started.
The separate completeness audit owns current public captures; its results must be joined by exact build revision
before attributing a public screenshot to this source. This report's visual evidence is the supplied material,
actually opened with the image viewer:

| Local evidence path                                                   | Image dimensions; viewport/source limitations                       | Observation relevant to test value                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.temp/goal/web/refs/maintainer-20261031/reddit-search-panel.png`     | 596 × 983 image; capture viewport, version and device scale unknown | Search, recent items and discovery share a readable panel; this is a design reference, not a REZICS oracle.                                                                        |
| `.temp/goal/web/refs/maintainer-20261031/rezics-filter-panel-bug.png` | 678 × 615 cropped image; source build and CSS viewport unknown      | Form controls extend beyond a narrow popover background. A closed-toolbar screenshot would miss this state. The crop cannot prove that every current Collection row lacks a cover. |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-top.webp`  | 2,000 × 1,384 image; viewport/version unknown                       | Title, portrait cover, rating and edition navigation have an explicit hierarchy.                                                                                                   |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-full.webp` | 662 × 2,000 image; stitched/resized page, viewport unknown          | Summary expansion, folded details and later reviews demonstrate progressive disclosure; the image is not evidence of an exact breakpoint or a backend API.                         |
| `.temp/goal/supermanager/refs/mobile-home-reference.jpg`              | 1,440 × 3,200 image; CSS viewport unknown                           | Phone search trigger remains in the header above a mixed content stream.                                                                                                           |
| `.temp/goal/supermanager/refs/mobile-search-open-reference.jpg`       | 1,440 × 3,200 image; CSS viewport unknown                           | Open search occupies its own phone surface with Back, query, Recent and discovery. Product-specific Ask functionality is not an adopted REZICS requirement.                        |

The cited REZICS story identities are source identities, not claims of captures made here:
`pages-library-collection--signed-in`, `patterns-subjects-purchase-entry-slot--empty`,
`patterns-subjects-subject-rating--ready`, the header stories under
`apps/web/src/stories/header-search/`, and `pages-commerce-subject-purchase--actual-adapter-unavailable`.
Existing source browser cases use 390 and 1280 widths where stated below. Image dimensions above must not be
substituted for those CSS viewports. Screenshots remain ignored local evidence and are not committed.

## Counting the actual boundary

Physical lines mean newline bytes plus a final unterminated line. Blank lines, comments, imports, setup and embedded
data count. Only Git-tracked, readable regular files without NUL bytes were included. The current working tree was
clean before this report. Untracked output, dependencies, `.temp/`, `.reference/`, other worktrees, old REZICS and
`legacy-final` are excluded. No recursive search outside the authorized source/reference directories was used.

The strict suffix is `\.(?:test|spec)\.[cm]?[jt]sx?$`. Its ownership partition is disjoint:

| Ownership boundary      |     Files | Physical lines |
| ----------------------- | --------: | -------------: |
| `services/kernel`       |     1,562 |        420,359 |
| `apps/web`              |       503 |        130,797 |
| `services/auth`         |       122 |         35,212 |
| `services/importer`     |        84 |         13,171 |
| `apps/auth`             |        33 |          9,033 |
| `packages`              |       172 |         20,715 |
| `specs`                 |        75 |         38,638 |
| `scripts`               |        24 |         17,493 |
| `tools/goal`            |       175 |         34,148 |
| **Total strict suffix** | **2,750** |    **719,566** |

The broad union adds paths matching
`(^|/)(test|tests|specs|__tests__|fixtures|recorded|fake)(/|\.)`, names containing `.stories.`, or ending
`/fixtures.json`. Assign each file to the **first** matching row below. The rows are non-overlapping; do not add
the strict total to this total again.

| First-match artifact class                                  |     Files |       Lines | What the count means                                                                                                  |
| ----------------------------------------------------------- | --------: | ----------: | --------------------------------------------------------------------------------------------------------------------- |
| Strict test/spec suffix                                     |     2,750 |     719,566 | Executable candidates, including helpers, fixture literals and setup inside these files; not 719,566 assertion lines. |
| Remaining `/recorded/` paths                                |        87 |      17,103 | Response snapshots; replay input does not make an assertion or prove fresh capture.                                   |
| Remaining `/fixtures/`, `/fixtures.*`, `/fixtures.json`     |        64 |      14,420 | Fixture data/support; includes data produced or normalized by code.                                                   |
| Remaining `.stories.` files                                 |       335 |      43,647 | Examples, rendering code and, for some stories, executable `play` assertions. Not all decorative, not all assertions. |
| Remaining `/fake/` or `/fake.*`                             |       100 |      14,598 | Substitute transports/models; useful deterministic inputs, not proof of the substituted service.                      |
| Remaining drivers, helpers, documentation and other support |       383 |     116,535 | Includes native setup, SQL/support and contracts. Essential in places, but not independently counted user outcomes.   |
| **Total broad union**                                       | **3,719** | **925,869** | Artifact volume, not product completeness.                                                                            |

For reproducibility, the census is equivalent to this read-only algorithm; it is documentation, not a requested check:

```python
paths = git_ls_files_zero_delimited()
for path in paths:
    if not is_readable_regular_file(path):
        continue
    data = read_bytes(path)
    if b"\0" in data:
        continue
    lines = data.count(b"\n") + int(bool(data) and not data.endswith(b"\n"))
    # Strict suffix, broad membership and first-match order are defined above.
    add_once_to_artifact_bucket(path, lines)
```

Other plausible boundaries overlap these numbers: the entire `services/kernel/test` tree has 509,594 lines;
`apps/web/tests` has 141,728; all `specs` has 49,448. They include support that the strict suffix excludes.
A lexical scan found 88,082 `expect(` occurrences in strict files. It is **not** an assertion count: loops and
parameterization multiply executions, helpers hide assertions, `assert` and Storybook expectations are additional
forms, and dead/setup-unreached calls execute zero times. Counting test titles has the same limitation.

### Classification by protected meaning

Artifact type and protected meaning are separate axes. For example, a native outcome test includes setup and
custody code; a mocked browser test can protect real keyboard behavior; an SSR test can protect private serialization.
Generated snapshots can exercise a renderer but cannot establish that the backend currently emits their contents.
`apps/web/scripts/record.ts:23` explicitly generates definition snapshots without a runtime. Its normalization
also substitutes known story labels/covers. A “recorded” filename therefore needs producer, normalization and
revision provenance before being treated as an unmodified native wire recording.

An exhaustive **mechanical** partition of the strict inventory gives a useful routing queue, not a semantic verdict:

| First-match routing rule                                                         |     Files |       Lines | Limitation                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | --------: | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/` or `tools/`                                                           |       199 |      51,641 | Controller/check infrastructure; its users are contributors, not catalogue readers.                                                                                                  |
| Remaining named native/support/growth/custody/physical/bounded/budget/host cases |       406 |     113,712 | Filename-selected infrastructure and bound coverage; contains real user journeys too.                                                                                                |
| Remaining `specs/*-outcomes.test.*`                                              |        40 |      23,838 | Declarative outcome contracts; not evidence that a driver executed or passed.                                                                                                        |
| Remaining paths containing `contract`                                            |        64 |      11,466 | Explicitly named contract cases; other contracts have other names.                                                                                                                   |
| Remaining local module/component cases                                           |     2,041 |     518,909 | **Mixed and unallocated semantically.** Includes observable behavior, native DB integration and implementation details. Calling all of it redundant unit tests would be unsupported. |
| **Total**                                                                        | **2,750** | **719,566** | No overlap.                                                                                                                                                                          |

The second rule uses the exact expression
`(?:^|/)(?:native|support)(?:/|\.)|growth|custody|\.host\.test\.|host-placement|check-(?:lease|lane|host|timing)|physical|bounded|budget`.
It deliberately does not claim to recognize every growth or native test.

The following **manual allocation of the close-read sample** supplies the protected-meaning classification.
Each listed file is assigned once by its primary oracle; mixed assertions within a file remain acknowledged.
These totals must not be extrapolated to the unreviewed remainder or added to the artifact totals.

| Primary protection in the allocated sample     |  Files / lines | Exact allocated files; assessment                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | -------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-visible journey outcomes                  |      7 / 2,933 | `specs/search-outcomes.test.ts`, `specs/web-publication-outcomes.test.ts`; Web `search.test.ts`; native `library-navigation.host.test.ts`, `native-curated-collections.host.test.ts`, `subject-rating.host.test.ts`, `native-purchases.host.test.ts`. High-value outcomes, with different fake/native boundaries documented below. |
| Boundary and serialization contracts           |      5 / 1,039 | Web `continue-adapter.test.ts`, `subject-purchase.test.ts`, `collection-filters.test.ts`, `subject-ratings.test.ts`, `header-search.test.ts`. Keep closed-wire, privacy and request semantics; titles sometimes imply more than their stubs prove.                                                                                 |
| Implementation/configuration shape             |        3 / 414 | Web `home-heading.test.ts`, `home-recording-freshness.test.ts`, `collection-presentation.test.ts`. Some useful provenance/type assertions; exact document shape, stale array preservation and superseded aspect expectations need owner review.                                                                                    |
| Growth/native lifecycle and suite custody      |        2 / 169 | Kernel Search `default-public-runtime.test.ts`, `outcomes.test.ts`. Native positive recovery and a wrapper enforcing exit/pass/no-skip accounting. Protects different failures from a UI test.                                                                                                                                     |
| Presentation/controller behavior over fixtures |      7 / 3,197 | Web `page-stories.test.ts`, `home-cards.test.ts`, `collection-page.test.ts`, `collection-members-layout.test.ts`, `subject-header-description.test.ts`, `closed-sections.test.ts`, `header-search-panel.test.ts`. Includes real browser geometry/a11y and SSR/reducer cases; fixture-backed is not synonymous with useless.        |
| **Allocated sample**                           | **24 / 7,752** | The other 711,814 strict lines are not assigned a semantic value judgment here.                                                                                                                                                                                                                                                    |

The routing queue also explains why many tests cannot make a frontend good: `scripts/remote-check.test.ts` alone
has 7,063 lines, `scripts/worker-check.test.ts` 3,510, and `tools/goal/src/verification.test.ts` 2,453.
They can protect dispatch, isolation and evidence integrity without evaluating a subject page. Their size is a
maintenance question for their owner, not evidence of fake product coverage. Similarly, importer parser bounds
and Auth restore/erasure custody protect important failures invisible in a static page. The importer
`tests/reader-bounds-outcomes.test.ts` invokes its production-parser outcome driver; Auth
`test/restore-erasure-contract.test.ts` names missing-custody refusal and stale-session fencing. These are examples,
not a separate full security audit.

## Capability matrix: a test at one layer does not fill the next column

“Implemented” below means source composition was found, not executed proof. “Exposed” means a route or interface
entry exists; gates, readiness and disclosure still apply. “Tested” records the actual oracle boundary, never an
assumption of a current pass. The matrix intentionally avoids one “done” cell per system.

| Capability                               | Specified / designed                                                                                             | Backend implemented                                                                                                                                                                                                                 | API exposed                                                                                       | Interface exposed                                                                                                                                             | Test evidence and remaining seam                                                                                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public text search and suggestions       | Search conditions, current disclosure, stable cursors, multilingual matching                                     | `server.ts:217–290` composes real OpenSearch, rated Semantic source and default public-filter runtime when configured; worker owns indexing                                                                                         | `search/http/routes.ts`: subjects search, suggest and facets; advanced admission is separate      | `/search`, shared header suggestions, localized subject links                                                                                                 | Native outcome/runtime/privacy suites plus fake-Web browser tests. Default-source binding exists; none of this proves every public filter, deployment or visual state.                                          |
| Header scope and Filters                 | Settled single centered field, removable scope, right-end Filters, full-screen phone panel                       | Resource authority must come from the actual owner; chip is presentation                                                                                                                                                            | Global search and owner member APIs exist; an arbitrary header action grants no scope             | `ShellSearch` accepts optional scope; default AppShell supplies none. Scope kinds include Library, Collection, Realm, Zone, Agent, not a distinct Space entry | Tests protect no silent widening, one input, URL/state and fixture interactions. No traced Collection/Space route-to-header-to-native scoped text journey.                                                      |
| Collection/Library filtered members      | Common Collection semantics, strict quantity boundary, owner-only predicates                                     | `createCollectionSource` is real native code with authorization/current-generation checks; its ready branch supports curated/private-built-in authorities, refuses other authority kinds. Additional producer/readiness gaps remain | Collection members, stored rules and private Library readers; capabilities have independent gates | Curated/dynamic pages, filter form and private rule editor exist. Collection route validates facets/layout/cursor but not `q`                                 | Fake harem/range cases, native public-search intersection, dynamic/curated outcome suites and native navigation exist. Their existence does not demonstrate the missing header scoped-query consumer.           |
| Home discovery                           | Current `scope.md` defers feeds and describes Continue/catalogue rows; new research asks for native mixed home   | Presentation route template and native Continue adapter exist; no mixed-home ranking implementation established in this trace                                                                                                       | `pages:read`, `libraryContinue`                                                                   | Four configured catalogue rows, personal slot, tagline message still used                                                                                     | Geometry, locale, document freshness and private adapter tests exist. They validate the current catalogue design, not an adopted mixed-feed contract.                                                           |
| Subject overview, tabs and relations     | Subject hub with views; settled need for folding, not everything on overview                                     | Aggregate presentation and native semantic/content readers exist; per-descriptor success remains independent                                                                                                                        | `pages:read`, semantic links/relations and owner routes                                           | Overview/About, views, relation streams, ratings and purchase slots                                                                                           | Real traversal/SSR contracts plus recorded browser content tests. Small prose samples and slot-only tests leave long-page and partial-failure composition open.                                                 |
| Covers and Collection density            | Every kind defaults portrait; landscape source images remain supported                                           | Authorized cover summaries and derivatives; definition/list-presentation hints                                                                                                                                                      | Subject/member summaries carry covers; native source retains disclosure                           | `collection-page.tsx` passes covers to `MemberListRow`; shared Cover renders real images or placeholders                                                      | Existing tests protect facts/notes/layout and fixture identity. Some explicitly expect Movie landscape. Current source has covers; screenshot absence is not proof of absent implementation.                    |
| Library state, progress and navigation   | Private personal facts; common Collection destinations; lifecycle/retention                                      | Native commands/readers and preparation; Continue consumes one FULL native page                                                                                                                                                     | Library/Collection/progress/follow routes                                                         | Library, built-in Collection destinations, Continue/progress routes                                                                                           | Native exact-link reload/follow cases, personal outcome suites and closed adapter tests. Account-switch and disclosure must be joined across actual public/private caches.                                      |
| Native/imported ratings                  | Separate populations/scales, own vote, publication threshold; paged population selection in current owner README | Votes, public figures and aggregate readers                                                                                                                                                                                         | Vote CRUD and aggregate/public figure routes                                                      | Rating control and summaries; current test supplies four Realms and expects only first three                                                                  | Native browser test saves/reloads/clears and crosses five-vote threshold. Fixture tests do not prove a usable selector among hundreds of Realms.                                                                |
| Subject offer discovery                  | One bounded native directory; no purchase/ownership inference                                                    | Native producer and generated client binding exist in current source                                                                                                                                                                | `GET /v1/subjects/:id/offers`                                                                     | Shared subject regions, offer review, preparing/denied/unavailable states                                                                                     | `subject-offers.test.ts` exercises the generated caller over mocked fetch. Illustrative ready examples and actual-adapter 503 example are distinct; no inspected successful current native directory recording. |
| Pay, retain record and use exact benefit | One-time account-bound immutable edition benefit; payment evidence distinct from eligibility/use                 | Native order/settlement/entitlement and Content sale/use adapters present; integrated proof remains a separate obligation                                                                                                           | Offers, orders, entitlements and guarded edition routes                                           | Offer → Checkout → order → entitlement → edition links                                                                                                        | Native purchase test exercises real local services with a provider simulator. It does not prove live provider eligibility or current protected Content delivery merely by creating an entitlement.              |

Two document/source contradictions matter to this audit. The
[Search status](design-status-search.md) says the default public-filter binding is missing and
`createCollectionSource` only reports unavailable; current `server.ts` and
`library/collection-source.ts:314–355` show narrower, real composition. Also
`services/kernel/src/presentation/README.md` still describes a home `SearchBox`, whereas the current profile and
home freshness tests exclude that node. Neither stale statement should be turned into a new missing-backend task.
Conversely, a source binding is not native readiness for every authority or a passing user journey.

## Twenty concrete journeys and their counterfactual strength

Paths in this section are relative to the repository root. `apps/web/tests/` is abbreviated **Web tests** and
`services/kernel/test/` **Kernel tests**. Quoted titles or line anchors identify the actual assertions. “No traced
oracle” is limited to the named route/component/test paths inspected; it does not claim repository-wide absence
from a filename search. Setup failure always means the protected assertion was not reached.

### 1. Search globally, open a localized subject, then request the next page

Call path: header/global form → `/search` → `search/search.tsx` → `POST /v1/subjects:search` → native search service →
hydrated subject links. Web tests `search.test.ts:187`, “the search page lists matching subjects and pages with the
cursor,” asserts text in the POST, no first cursor, later cursor, canonical localized links and disappearance of
More at exhaustion. It **would fail** for those browser/adapter regressions. Its `Bun.serve` fake at line 63 returns
fixed pages based on cursor, with only a special no-match query; a broken native tokenizer, ranking or authorization
can leave it green. Separate `specs/search-outcomes.test.ts:232–520` and Kernel `search/default-public-runtime.test.ts`
cover real matching/current hydration/recovery. The two boundaries need a small native served-Web bridge, not deletion
of the useful isolated browser case.

### 2. Type, debounce, use arrow keys and open a suggestion

Call path: `HeaderSearch`/suggestion controller → `/api/search/suggestions` → generated subjects suggest caller →
canonical target. Web `search.test.ts:268,301` checks keyboard selection and delayed requests; header panel tests
at 162 and 193 check the eight-item cap and rejection of late results even when abort is ignored. These **would
fail** for the selected keyboard/debounce/late-state regressions. Fixed suggestion responses bypass native prefix
matching and current disclosure. Kernel `search/default-public-runtime.test.ts:95` separately exercises real prefix
hydration. Neither proves centering or filter popover geometry.

### 3. Focus the single centered header field and open the phone panel

Call path: `shell/shell.tsx:500` → `search/header-search/shell-search.tsx` → `header-search.tsx`.
Web `header-search.test.ts:73,101` asserts modal semantics on phone and one ordinary GET form; panel test 299 bans
`focus-within:border-ring`. The actual component still has `focus-within:ring-2 focus-within:ring-ring`, an expanded
`bg-background` and a resting `bg-muted/50`. Header story `header-search.stories.tsx:143–173` checks aligned inner
headings and **requires the composer shadow to change on focus**, while requiring the input's shadow to be none.
Those assertions can pass with the complained-about composer ring and differing surfaces. They **would fail** if
one input or those semantics disappeared; no inspected assertion ties the full shell field center to viewport center
with unequal side controls. This is a wrong/incomplete visual oracle, not an absence of all browser testing.

### 4. Search text inside the current Collection without widening to Global

Call path should retain Collection identity through header action, route query and owner membership search.
`header-search/authority.ts` refuses a supplied scope without a safe existing local `searchAction`; tests
`header-search.test.ts:13,27` assert both refusal and an injected `/ja/library?collection=reading` action.
Panel test 211 ensures scoped text is never sent to global suggestions. These **would fail** if the safety
boundary widened, and are worth keeping. They would **not** fail merely because no real Collection route supplies
that action: AppShell defaults to `<ShellSearch />`, the traced Collection route drops `q`, and its inline filter
submission serializes facets/ranges, not text. A fake scope label or injected URL proves no Collection text execution.
No completed Collection-header-text-to-members oracle was found along this call path.

### 5. In a private Library, combine state, harem and more than one million words

Call path spans Library owner authority → common filter admission → semantic public predicates → current members.
Web `collection-filters.test.ts:41,57,64,151` checks harem admission, inclusive `gte:1_000_001`, conjunction and a fake
matching subset. It **would fail** for those parser/fake-model changes, but its fake can agree with the client while
the owner/native seam is absent. There is real backend evidence: Kernel
`search/query-privacy-user-cases.test.ts:199` uses `createReleasedLibraryPopulation({version:1, search:'native'})`
and asserts only B-long survives the released light-novel/harem/word-count intersection, excluding equality, missing
words and edition pages; line 490 checks private labels never classify public catalogue results. These **would fail**
for those native public semantics. They do not supply the browser's Library state operand or missing scoped header
action. Keep native predicate/privacy protection; add only the missing owner-and-browser conjunction bridge.

### 6. Search within a Realm or Space and retain its current authority

The header type lists Realm but no distinct Space; its generic scoped tests provide labels and an arbitrary existing
route, not a Space source. Current community pages and subject Realm selection are different capabilities from
scoped text retrieval. `header-search.test.ts` and panel test 211 **would fail** on unintended global fallback, but
can remain green if every community page still opens global header search. The inspected `community/space-page.tsx`,
Realm routes and default shell did not establish a native scoped text handoff. A new oracle must enter an actual
community page, submit text, exclude an outside-only match and then revoke membership; do not infer authority from
a chip or from a successful Realm-routed subject view.

### 7. Search through a Zone's mounted Collection without exposing a closed source

Call path for the existing runtime is Zone routes → `POST /v1/zones/:id:readPage` → configuration/mount authority →
member source/presentation. This is not automatically the global subjects-search route. `scope.md` keeps dynamic,
source-dependent Zone capabilities closed; static no-data-read Zone pages are in scope. Generic Zone chip refusal
tests **would fail** on silent widening, not on absence of an end-to-end mounted text search. The inspected routes,
header authority and dynamic Collection outcome contract supply no completed phone/header mounted-search oracle.
Do not open a gate or fabricate a result to make this journey look present. Later acceptance must cover mount
withdrawal, source denial and no inference through NOT, counts or continuation as well as a positive result.

### 8. Arrive signed out at a useful native mixed home without a marketing slogan

Call path: `/` → `features/pages/home-queries.ts` → route `pages:read` → platform profile → `RoutePage`.
Web `home-page.test.ts:20,43` expects one page read and the recorded catalogue rows; `home-heading.test.ts:89,105`
and `page-stories.test.ts:544` compare the heading to localized `home_heading`. English
`apps/web/messages/en.json:432` still says “A clearer view of what matters.” These tests **would fail** for losing
the expected heading/template, but **would not** fail because the copy is unwanted or the page lacks the newly
requested mixed stream. Some would resist a correct redesign until the owning contract changes. Current feeds
are explicitly deferred in `scope.md`; this is a design/scope reconciliation and subsequent delivery slice, not
evidence that an already accepted mixed-feed test passed incorrectly.

### 9. Continue a title from home and reach its exact active progress session

Call path: browser-only home personal slot → `loadContinueState` → `nativeContinueSource` → generated
`libraryContinue.get({limit:6,view:'FULL'})` → `ContinueRow` → `/library/progress/{sessionId}`.
`home-cards.test.ts` checks six cards, exact progress links, cover sizing at 390/640/700/1280, and fake request
counts; `continue-adapter.test.ts:71` checks one current FULL request, credentials, cancellation and no-store.
They **would fail** for their respective wrong-link/rendering/transport regressions. The home-card fake records six
legacy per-subject progress reads; that is not evidence that the current production adapter performs six reads.
Small story data and injected wire responses cannot prove native FULL availability, preparation or session currency.
Reuse the native personal driver to connect this existing adapter to a saved/reloaded active session.

### 10. Use home with 200,000 kinds, 300 memberships and thousands of follows

The present home has **four** fixed TypeLists, each limit 12, rather than 200,000 kind blocks. Thus the literal
current template is not O(number of all kinds) in row count. It also does not implement the requested mixed-kind
discovery experience. `home-cards.test.ts` checks geometry for the recorded rows; `home-heading.test.ts` fixes the
six top-level node types; neither **would fail** merely because a different design created one new block per kind
outside that fixture or because personalized selection scanned every follow. No upper-bound home selection/DOM
oracle was established in these paths. The aggregate's 16-descriptor/128-slot limit is an output bound, not a proof
of native SQL, candidate scanning, Access, bytes or DOM history cost. The next contract must bound all of them.

### 11. Read a long subject description, expand it, and reach the next useful section

Call path: `SubjectPage` → aggregate reads → `overview.tsx:845` `Summary` → `DocumentValue` or description paragraph.
Web `subject-header-description.test.ts:32` checks description once in About and never duplicated in the header,
language fallback and abstract preference. `page-stories.test.ts:833` waits for the recorded prose/facts/edition
link to be visible. These **would fail** for those content regressions, but short supplied prose does not exercise
folding or first-screen allocation. The inspected Summary renders chosen prose directly, with a spoiler gate when
needed; the gate is not long-text progressive disclosure. No long-summary expand/collapse/retained-tab-state
assertion was found in these readers/tests. Add the long and empty cases to the page owner slice, not a character
count copied from a competitor screenshot.

### 12. Traverse subject editions, contents, cast, crew and relations through their views

Call path: current subject view links → view route → `pages:read`/native relation streams → next cursor.
`specs/web-publication-outcomes.test.ts:129–172` names editions, contents, cast, crew, inverse credits, relations and
sourced Details, asserting reachability exactly once in declared order across full pages. Native
`web-publication-outcomes.host.test.ts` loads the frozen suite through the real driver. If reached, these **would
fail** for broken traversal/order/disclosure, stronger than merely checking tabs exist. The recorded subject browser
case separately checks a visible edition link. None chooses which previews deserve overview space or approves
folding and density. A historical native setup failure can prevent all these assertions from running; test existence
must not be reported as their current success.

### 13. Keep a subject useful when one independent owner is unavailable

`overview.tsx:267` renders a headed retry section per failed descriptor. Repeating that valid local behavior can
produce the reported wall of failures. Pattern `patterns-subjects-purchase-entry-slot--empty` passes a recorded page
directly into `SubjectPage`; its `play` checks only no purchase slot and a visible h1. It **would fail** if the empty
slot appeared, but **would not** fail if every independent section below the title were an error. Web
`subject-ratings.test.ts:146` renders a failed rating beside a separately supplied “About remains available” element;
it proves local containment, not a successful composed About read. `closed-sections.test.ts:39,55` usefully suppresses
closed-feature panels and tabs. Keep those distinctions; add a composed partial-failure oracle and move slot-only
examples to the smallest context that exercises their real integration seam.

### 14. See covers on every Collection member, with portrait defaults and landscape art preserved

Call path: member FULL summary → `collection-page.tsx:1201` → UI `MemberListRow` → shared `Cover`.
The current source always supplies the row-cover container; it does not omit all covers. Web
`collection-members-layout.test.ts:106` uses members with `cover:null` and checks rows/notes/links; grid cases check
card slots. `collection-presentation.test.ts:91` explicitly expects Movie `16:9` and, for its null-cover fixture,
no `<img>`. These **would fail** for the specified facts/layout or old aspect policy, but can stay green when a real
image fails to load, the default is contrary to the settled portrait decision, or art is poorly fitted. Source
`collection-presentation.ts:8–19` still hardcodes video/anime/Recipe landscape and MusicAlbum square fallbacks.
Investigate image load/disclosure/version separately; add mixed real-image/placeholder/fitting cases across list,
grid, header and editor without claiming the supplied screenshot identifies the current build.

### 15. Open Collection Filters, enter both conditions, apply, clear and retain them on paging

Call path: Collection toolbar → `CollectionFilters` → UI `Menu` custom content → facet/range URL → members query.
`collection-filters.test.ts:200`, despite its phone-responsive title, only parses one selected tag. It does not open
or measure a panel. The SignedIn story's `compactCollectionReady` measures hero/first member/toolbar alignment at
390 and closed-page scroll width; it does not open this filter surface. These assertions **would not** fail for
the supplied open-popover spill. A concrete source mismatch explains the risk: `Menu` at 299 fixes custom-content
width to `max(triggerWidth,128)`, while `collection-filters.tsx:124` gives the form its own desktop width up to 32rem.
The screenshot is consistent with that disagreement, though computed CSS at its unknown build was not measured.
The header Filters story opens global search checkboxes, not this Collection menu. Add an actual composed open-state
geometry/keyboard/apply journey when the controls move to their already-decided header seam.

### 16. Create, edit, publish, export and withdraw a curated Collection

Call path: real Collection editor/pages → session BFF → native Collection/member commands → public reads/export.
Web native `native-curated-collections.host.test.ts:217` creates subjects, enters through the served Library page,
edits/publishes/exports and withdraws through actual pages with Alice, Bob and anonymous contexts. It **would fail**
for those native mutation/persistence/disclosure regressions when setup succeeds; this is not a solely illustrative
story. The Collection story additionally checks ItemList export removes private fields. Keep these tests. Their
successful assertions would still not approve header scoped search, real cover loading or opened filter fit unless
those steps are asserted. A UI journey can be high-value while protecting only part of the final page.

### 17. Open real built-in Library destinations, follow them, reload, and conceal another owner's facts

Call path: Library → native pins/Collection listing → exact emitted curated/built-in URLs → members/follows.
Native `library-navigation.host.test.ts:19` requires a real Everything record, cold 202 with Retry-After, eventual
200 within its finite deadline, a genuine member, exact links, reloads and two PUT follows. At 121 it separately
checks native dynamic preparing/empty/denied states and private-fact non-disclosure. These **would fail** for those
runtime/identity/readiness/privacy regressions; they do not merely accept endless unavailable as success. Remaining
risks are actual account-switch cache/late-response composition and larger personal workflows. Their absence from
this one navigation test is not proof no personal suite exists: `specs/web-personal-outcomes.test.ts` and the Library
outcome families are additional contracts to retain and reuse, not duplicate.

### 18. Rate a subject, reload, see the publication threshold, clear it, and compare populations

Call path: native browser range control → vote API → current vote → aggregate/publication → rating section.
Native `subject-rating.host.test.ts:72` uses the real web/Auth/Kernel stack, saves 7.5, verifies stored units 15,
reloads, adds four API votes, requires the five-vote Global figure, then deletes the browser vote and requires a
four-vote unpublished figure. It **would fail** for native write/persistence/threshold regression. In contrast,
`subject-ratings.test.ts:99` supplies four Realms, sorts/slices the first three and checks one aggregate/source/vote
call. It does not prove membership retrieval or a usable selector with 300 Realms. That fixture can remain green
with an unfinished crowded rating block or missing navigation to other populations. Retain numerical, imported-scale,
zero/unknown and native vote tests; add compact population selection and whole-page design acceptance.

### 19. Discover an offer from a subject without mistaking empty, pending or denied for ownership

Call path: subject public region → `checkout/subject-offers.ts` generated native directory caller → offer link.
`subject-offers.test.ts:34` uses the actual generated client but spies on fetch; it asserts one GET, limit 10,
credential/language/no-store/redirect semantics and explicit cursor continuation. At 67 it differentiates sparse
continuation, preparing positives, refusals, malformed response and genuine failure. These **would fail** for the
adapter regressions but not for a native producer that never emits a useful offer. `subject-purchase.test.ts:72`
stitches discovery/review/checkout/order/entitlement using injected fixtures and mock fetch, not a real sale. Its
value is correct handoffs and no invented permission. Keep the explicit actual-adapter-unavailable story honest;
add one positive native subject-directory-to-reviewed-offer bridge before claiming discovery completion.

### 20. Pay once, retain the record, and use only the currently permitted exact purchased edition

Call path: `/offers/{id}` → `/checkout` BFF → native order/provider port → verified event → order/entitlement →
guarded `/editions/{id}` reader. Native `native-purchases.host.test.ts:72,147,169` asserts pending before verified
delivery, forged return parameters grant nothing, signed simulated paid event settles once, duplicate delivery
creates one entitlement, and buyer history/cursors conceal Alice from Bob/anonymous. It **would fail** for those
native local-settlement and isolation regressions. The provider is a simulator, and checkout.stripe.com navigation
is deliberately aborted. The inspected entitlement assertion matches a subject-level entitlement, not actual
Content body delivery under current exact-version Access. The mocked subject-purchase test even receives a reader
403, correctly preserving refusal. Keep settlement proof; separately require the existing Content/Commerce owner
driver to prove allowed exact-benefit use, wrong-version denial, revocation/takedown and no Library side effects.

## Defect classes that explain the observed result

These findings are about **why a class can escape**, not an assertion that every example currently fails in public.
Each correction belongs with the existing owning capability; it is not authorization to edit frozen acceptance.

| Defect class and exact evidence                                                                                                                                                                                                            | Cause that lets it through                                                                                                                                                            | User impact                                                                                            | Owner seam and proposed correction                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Oracle is below the user's job.** Header scoped-action tests accept an injected URL; Collection route ignores `q`; default shell has no scope. Journeys 4–7.                                                                             | Component authority safety and owner API semantics are tested separately; nobody asserts the actual route supplies the owner binding.                                                 | Search appears contextual but cannot complete the contextual job, or still starts globally.            | Web + Search + Library/Community/Semantic: one real route-to-owner positive and outside-only negative per supported source family; keep fail-closed unsupported scopes.                                                                                                                                             |
| **Wrong or obsolete design oracle.** Header story requires changing composer shadow; home tests expect the rejected localized heading; Movie ratio test requires landscape. Journeys 3, 8, 14.                                             | Assertions follow current component/configuration values rather than the adopted user decision. A technically stable implementation preserves the wrong design.                       | Ring/surface inconsistency, tagline and inconsistent cover hierarchy can look approved.                | Web/UI + definitions/presentation owners: adopt the settled decisions in owning docs, then add approved design cases alongside preserved frozen cases; conflicting frozen contracts need owner resolution, not worker edits.                                                                                        |
| **Interaction state omitted.** Collection phone-filter test only checks parsed params; SignedIn story measures the closed toolbar. Journey 15.                                                                                             | “Responsive” in a title is accepted as evidence, while the failing popover is never opened.                                                                                           | Inputs spill, controls become hard to reach, the wrong Filters entry remains.                          | UI Menu + Web filter consumer: shared content-size/placement contract and open-state bounds, focus, apply/clear and retained-cursor checks at phone/desktop.                                                                                                                                                        |
| **Local fallback multiplication.** `overview.tsx:267` creates a retry section per failed descriptor; purchase-slot Empty play asserts only absence+h1. Journey 13.                                                                         | Each owner handles failure honestly; page owner has no composed usefulness requirement. A full-page wrapper is used to test a tiny slot.                                              | A valid title above an error wall, with repeated reload links and little useful reading.               | Web subject IA + composition owners: separate whole-page unavailable from optional partial failure; one coherent retry/status where appropriate; assert independent successful content remains useful and closed sections are omitted.                                                                              |
| **Fixture authority substituted for native authority.** Search fake returns predetermined pages; `subject-offers` and `subject-purchase` mock transport; home card fake differs from current Continue source.                              | Wire/rendering proof gets described as retrieval/readiness/whole-journey proof. Test names are stronger than actual setup.                                                            | Empty/illustrative/503 examples can be mistaken for product completion; integration gaps remain.       | Each producer/consumer pair: label evidence layer and provenance; retain boundary cases, add a minimal native bridge with an eventual positive, not another parallel fixture implementation.                                                                                                                        |
| **Recording freshness is conditional.** `scripts/recording-normalization.ts:21–48,103–110` preserves previous strings/array length/keys except selected identity/cover/label fields; freshness test explicitly expects old non-Home shape. | Stabilization reduces fixture churn but can retain removed nodes/old cardinality. Home, definitions and search have specific fresher paths; others do not automatically inherit them. | Story type compatibility may pass while current page composition and optional sections differ.         | Web recording owner: distinguish authored illustrative fixtures from faithful captures; canonicalize only declared volatile identity/time fields; attach producer revision/normalization identity and compare semantic shape at the seam. Do not blanket-regenerate stable examples or overwrite existing evidence. |
| **Evidence version is not the source version.** Public build revision unobserved; current Collection code contains covers; status docs still describe missing source bindings/SearchBox.                                                   | Source inventories, old receipts, modified fixtures and published stories are conflated.                                                                                              | Work may target already-fixed code or advertise unproved delivery; maintainer sees a different result. | Owner delivery + existing publisher: join source/profile/definition/recording/build revisions and actual capture state; preserve publishers and compare only matching versions.                                                                                                                                     |
| **Small visible fixtures do not establish upper-bound selection.** Four home rows/six Continue cards; rating fixture slices four Realms to three; `readCollectionTypeOptions` enumerates and sorts the whole release.                      | Finite examples and output/request-count bounds are treated as full selection/physical/DOM bounds.                                                                                    | Missing contexts, huge selectors, slow preparation or unbounded history despite a tidy first screen.   | Capability owner + Performance: paged searchable selectors, bounded selected pages, count source examination/Access/bytes as well as output; desk derive bounds before later native tests.                                                                                                                          |
| **Negative success mistaken for useful readiness.** Actual-adapter 503 example and closed-feature omission are legitimate; a useful feature still needs a positive.                                                                        | Individual refusal cases are easier to demonstrate than actual positive composition.                                                                                                  | “Safe” but permanently unavailable capability could be labeled complete.                               | Producer + consumer: require a finite eventual-positive case and independent denial/lifecycle cases. Existing Library navigation and Search default-runtime cases already do this and should be reused.                                                                                                             |
| **Setup/custody failure is outside product assertions.** Web native README records a 28-scenario publication attempt with 26 setup timeouts looking up three titles and two fixture-write 503s.                                            | The fixture cannot reach the seeded journey; a suite file exists but its useful assertions are not reached. This is historical recorded evidence, not a current rerun.                | No reliable current completion evidence, even when substantial test code exists.                       | Existing native harness/producer owner: repair actual fixture binding/readiness and retain terminal evidence. Do not replace failures with fake fixtures, skips, wider timeouts without cause, or mark unexecuted cases passing.                                                                                    |

### Growth, disclosure, lifecycle and accessibility are separate obligations

At the settled upper bounds, output limits are necessary but insufficient. The current home profile emits at most
48 catalogue cards from four 12-item lists. Continue's current adapter emits at most six rows from **one** FULL
request. These are source-derived bounds, not measured work or latency. A design adding one row per 200,000 kinds
would multiply four rows by 50,000; a rating card per 300 contexts creates 300 attention targets before history.
`readCollectionTypeOptions` in `collection-presentation.ts:89` performs an O(K) map and O(K log K) sort of the release.
It is an actual upper-bound hotspot for kind selection, distinct from the fixed home template. A million-member
Collection needs bounded page selection, current disclosure and independent whole-query preparation, not a
million-node browser list or a client-side filter over a first page. Request count alone cannot rule out scans
inside a request, underfilled pages or expensive source authorization.

The appropriate invariants already have valuable native tests. Kernel Search
`query-privacy-user-cases.test.ts:289–469` addresses positive/negative predicates, withheld targets, cursor
invalidations and finite useful preparation; `default-public-runtime.test.ts` requires recovery to positive pages.
Library navigation requires preparation to terminate positively. These protect negative information and lifecycle,
not just visible titles. Preserve authorization under NOT and OR, absence vs unknown, order/facet/cursor leakage,
account/session reduction, withheld image variants, deletion/merge, source-generation changes and withdrawal of
mounts/publications. A public warm cache followed by another actor is a separate attack path:
`specs/web-publication-outcomes.test.ts:384,398` explicitly names Alice/anonymous/Bob and current private hydration.
Do not remove these cases because a screenshot looks poor.

Growth/custody tests must also be evaluated by what they measure. The
[Performance status](design-status-performance.md#cross-cutting-audit-page-growth-harness) identifies the existing
five `support/growth-counters.test.ts` cases and a still-missing whole counted-unit scenario, including median vs
every-repetition ceilings. That is a documented handoff to the Performance owner, not a new execution result here.
Keep frozen growth cases and resource-ownership/cleanup tests: a leaking harness can corrupt other workers' evidence.
Prefer testing actual bounded native operations over assertions that source contains a LIMIT or a budget constant.
No runtime extrapolation from these desk observations is offered.

Accessibility coverage is present and meaningful. `page-stories.test.ts:438–568` starts Storybook, requires browser
results for named representative pages, opens indexed entries in eight locales at 1280 × 860, checks landmarks,
language, headings, navigation and runs Axe. It deliberately blocks external services to keep stories replay-only.
That boundary is explicit, not a hidden claim to native integration. However, at-rest Axe and a `role=dialog` string
cannot establish the opened Filters geometry, mobile focus trap/return, keyboard scope removal, zoom reflow or
composed error announcements. W3C's [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
requires actual focus containment, Escape and sensible return; [WCAG reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
uses a 320 CSS-pixel equivalent for the ordinary vertical case. A 390-only screenshot is not that proof.
Preserve visible focus while correcting its approved treatment; do not respond to the unwanted blue composer ring
by making keyboard focus invisible.

## Comparative evidence from twenty products

All sources below were accessed on **2026-10-31**. These are current official help, product pages or official schema
documentation, sometimes through their search-index extract. They are not authenticated full product walkthroughs.
No vendor's private test suite, conversion funnel or unpublished performance is inferred. Vendor prose/screenshots
are copyrighted material with no code-reuse licence established here; findings are paraphrased and no product
assets or passages are proposed for copying. API documentation establishes a capability model, not its rendered UI.

| Product; primary source                                                                                                                                                                                                                 | Observed pattern and implication for a REZICS oracle                                                                                                                                                     | Evidence limitation                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reddit — [available search features](https://support.reddithelp.com/hc/en-us/articles/19696541895316-Available-search-features)                                                                                                         | Community scope is explicit and removable; compare scoped results against an outside-only match and preserve the selected scope through refinement.                                                      | Help plus supplied search/phone images; no authenticated cross-platform campaign.                                                                                              |
| X — [search help](https://help.x.com/en/using-x/x-search)                                                                                                                                                                               | Result categories and filters are distinct controls; following/location/safe-search choices affect the job. Test selection and result meaning together.                                                  | Official help, not verification of every account/client variant.                                                                                                               |
| YouTube — [advanced search filters](https://support.google.com/youtube/answer/111997?hl=en)                                                                                                                                             | A search is refined by content type and other filters. A visible filter icon alone is insufficient; assert the returned category and query retention.                                                    | Help workflow; no claim its geometry matches REZICS.                                                                                                                           |
| GitHub — [searching on GitHub](https://docs.github.com/en/search-github/searching-on-github)                                                                                                                                            | Qualifiers and categories distinguish repository/code/issues/users. Test scope grammar and actual target eligibility independently.                                                                      | Public documentation, not signed-in code-search execution.                                                                                                                     |
| Discord — [search help](https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord)                                                                                                                        | Server/DM context, author/channel/media/date refinement and jumping to a result are a connected job. Test destination context, not just a chip.                                                          | Desktop/mobile capabilities differ; help does not establish universal parity.                                                                                                  |
| Slack — [search in Slack](https://slack.com/help/articles/202528808-Search-in-Slack-Search-in-Slack-)                                                                                                                                   | Channel/person modifiers, suggestions and explicit desktop/mobile Filters coexist. Test the same predicate across keyboard entry and filter editing.                                                     | Official help; no workspace access or AI capability assumption.                                                                                                                |
| Notion — [search](https://www.notion.com/help/search)                                                                                                                                                                                   | Search window includes recent access and explicit narrowing. History/discovery and query execution need different readiness and privacy oracles.                                                         | Documentation includes optional connected/AI sources; those are not REZICS requirements.                                                                                       |
| Steam — [graphical asset overview](https://partner.steamgames.com/doc/store/assets)                                                                                                                                                     | Required portrait Library Capsule and wide Library Hero/Header are separate representations. Preserve source art while testing the chosen frame on each surface.                                         | Publisher asset specification, not an end-user usability study; does not reopen settled portrait defaults.                                                                     |
| Goodreads — [rating/review guidelines](https://www.goodreads.com/review/guidelines) and supplied subject images                                                                                                                         | Rating/review visibility can differ from personal shelf retention; images show summary/details expansion and edition navigation. Test disclosure and progressive disclosure separately.                  | The images' version/viewport are unknown; guidelines do not define the displayed layout.                                                                                       |
| StoryGraph — [official getting-started guide](https://thestorygraph.freshdesk.com/support/solutions/articles/79000142013-getting-started-with-storygraph)                                                                               | Personal tracking/tags and discovery are distinct activities. A subject's availability in a discovery fixture does not prove the user's saved state.                                                     | Help/onboarding evidence, not an authenticated library or recommendations test.                                                                                                |
| Douban — [Book help](https://help.douban.com/?app=book)                                                                                                                                                                                 | Help separates editions, ratings, long/short reviews, notes, purchase links, lists and tags. Test navigation and grain rather than merging every item into overview.                                     | Public help index and notes instructions; no private reading-history access.                                                                                                   |
| Bangumi — [official API docs](https://bangumi.github.io/dev-docs/)                                                                                                                                                                      | Separate subject search, relations, episodes, reviews and user collections show independently addressable capabilities. Test each owner/read boundary before composing previews.                         | Official private-API documentation is publicly readable; it is not a stable public integration promise or a live UI observation. Public API landing supplied no readable body. |
| AniList — [ScoreFormat schema](https://docs.anilist.co/reference/enum/scoreformat)                                                                                                                                                      | Multiple score formats distinguish display scale from stored meaning. Keep native units, imported scales and unscored cases explicit.                                                                    | Official search-index evidence; direct document fetch returned 403. No rendered rating UI was verified.                                                                        |
| VNDB — [Kana API](https://api.vndb.org/kana)                                                                                                                                                                                            | Docs explicitly distinguish API and site capabilities; some API filters are unrecognized by the frontend. An API test does not establish filter-editor exposure, or conversely.                          | Public API specification; no account/list write attempted. Data/API usage terms do not grant wholesale asset reuse.                                                            |
| Letterboxd — [official page and new FAQ link](https://letterboxd.com/about/faq/)                                                                                                                                                        | Public form distinguishes diary date, watched state, rating and review privacy; displayed notice qualifies which activity remains public. Test derived/public effects, not one blanket private flag.     | Current public HTML/form only; main FAQ has moved to linked support site. No private account behavior verified.                                                                |
| IMDb — [Watchlist FAQ](https://help.imdb.com/article/imdb/track-movies-tv/faq-for-the-watchlist-feature/G9PA556494DM8YBA) and [Lists FAQ](https://help.imdb.com/article/imdb/track-movies-tv/faq-for-the-list-feature/GNQMN47VZSE7KW38) | Watchlist and authored lists are distinct surfaces. Keep built-in personal views separate from curated membership while sharing list presentation.                                                       | Help evidence; no bulk/account operation observed.                                                                                                                             |
| Spotify — [search](https://support.spotify.com/us/article/search/) and [Your Library](https://support.spotify.com/uk/article/your-library/)                                                                                             | Global discovery and personal library organization have different scopes. Test that switching surfaces changes actual selection authority, not just wording.                                             | Help pages; client/account variants not exercised.                                                                                                                             |
| Apple Books — [organize books on iPhone](https://support.apple.com/en-az/guide/iphone/iphab219b91/ios)                                                                                                                                  | Built-ins, overlapping custom collections, grid/list and sort are separate user controls; deleting a collection does not delete the books. Test destructive-action meaning and cross-layout equivalence. | Official regional iPhone guide; no claim about every Books client or backend implementation.                                                                                   |
| Zotero — [collections and tags](https://www.zotero.org/support/collections_and_tags)                                                                                                                                                    | One item can be in many collections; saved searches update from criteria and deleting a collection need not delete items. Test identity, membership and query lifecycle independently.                   | Official documentation explicitly notes client/web differences; not a recommendation to copy its storage design.                                                               |
| WeRead — [official public home](https://weread.qq.com/)                                                                                                                                                                                 | Public search, hot searches, bounded ranked rows with See all, and a category entry are exposed together. This supports bounded previews plus expansion rather than one row per all possible kinds.      | Text-only public observation; no account bookshelf/reader access, CSS viewport or ranking implementation verified.                                                             |

Shared patterns are explicit scope, bounded previews with an exit, separation of personal facts from public discovery,
and several representations of one identity. They support tests for the **whole selected job**, especially preserving
scope and state across surfaces. Disagreements matter: media services use different aspect ratios; products distinguish
ratings, reviews, lists and personal status differently; desktop/mobile filter locations vary. Therefore do not
freeze one competitor's DOM, ranking or score scale as a universal REZICS contract. The settled REZICS header and
portrait decisions remain constraints; test them in the repository's own React/Workers/native API stack.

### Established source: Discourse tests at the real seam

The reused read-only clone is
`/home/edge/projects/rezics/rezics-next/.reference/partitioned-sitemap-feeds/discourse`, revision
`589325e2b8466178ee83acac9ec411de555a0093`, **GPL-2.0-or-later** per `README.md` and `LICENSE.txt`.
Its reference registry entry was added under the audit topic. Nothing from the clone was installed, built or run.

[`spec/system/search_spec.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/spec/system/search_spec.rb)
enables the real indexer, forces indexing of fabricated posts and exercises the rendered search page, mobile state,
keyboard result selection and retained menu state. This bridges actual retrieval and browser behavior while keeping
controlled data. Forced indexing does **not** prove eventual production indexing; keep a separate freshness case.
[`spec/system/header_search_spec.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/spec/system/header_search_spec.rb)
resizes the real browser between 500 and 1000 widths and checks field/icon visibility with scroll/settings.
These are useful patterns for REZICS's existing browser/native drivers, not files to port or a reason to copy GPL
implementation. They also do not by themselves decide pixel centering, visual quality or the REZICS phone design.

[Playwright's testing guidance](https://playwright.dev/docs/best-practices) recommends testing visible behavior and
isolating tests; that supports existing focused boundary cases alongside a few integrated journeys.
[Screenshot assertions](https://playwright.dev/docs/test-snapshots) compare against baselines; generating or updating
a baseline is not product approval. [Storybook interaction testing](https://storybook.js.org/docs/writing-tests/interaction-testing)
executes declared `play` interactions, so an unasserted section is outside that oracle. Current upstream documentation
describes principles; it is not proof that the repository's installed version ran these cases. These primary sources
support a layered strategy, not a line-count target or indiscriminate removal of isolated tests.

## What the legacy sources do and do not establish

Old REZICS was read at `/home/edge/projects/rezics/rezics`, revision
`95167ceab7173dc1c5fb0ee70568c5c95f1dba8d` (root AGPL licence). Exact inspected paths:

- `apps/web/app/(app)/page.tsx` enters `features/explore/home.tsx`; that component drives a real `ApiFeedList` with
  sort, content, language, Realm and tag URL state rather than a catalogue row per kind.
- `features/content-feed/data/api-feed-list.tsx:70,127–153` uses a default page size of 20 and cursor-backed
  `postApiFeedQuery`. Its controls at 300–332 load only 50 Realms and 50 tags and map those loaded items to options.
  This bounds initial choices but, in the inspected control code, does not prove discoverability of the 51st of
  hundreds of Realms. Infinite-page rendering also needs a retained-DOM bound; a paged backend alone does not supply it.
- `features/content-feed/components/feed-item-card.tsx` discriminates post and unit items; a native mixed feed was
  a real source concept. This is not evidence of its current backend cost, rights or relevance at upper bounds.
- `features/collections/pages/collection-detail-page.tsx` reads the Collection API and supplies a conditional hero
  Cover, count and `CollectionContentFeed`; `features/collections/components/collection-content-feed.tsx` pages stable
  content targets into the shared `FeedItemCard`. This supports retaining identity/cover/feed continuity. It does not
  show the old code always provided a cover when absent, or that its queries meet the rebuilt contracts.

Old rezics-next was inspected only through `git show legacy-final:<path>`, revision
`1ac6ed6e0668f04e30025c41e59ceaf3bdee5061` (`package.json`: AGPL-3.0-only):

- `apps/web/features/home/home-page.tsx` consumes mixed feed, Continue, pinned filters and followed contexts through
  native API-oriented props. `features/home/server.ts` reads followed Realm/Zone pages and concepts with cursors;
  `features/home/tabs.tsx` has fit/overflow handling and More topics. Thus the terminal tag is not accurately described
  as blindly rendering every Realm on the home first screen. The inspected files do not prove its full physical
  selection or accumulated-tab cost at thousands of follows.
- `apps/web/features/scoped-rating/subject-projections.tsx:31–49` fetches a projection page, then for each visible
  projection reads questions and usually its rating: up to `1 + 2p` calls for p visible projections. Its rendered
  `visible.map(ProjectionRow)` gives each projection a framed card, and subsequent pages accumulate in local state.
  With 20 relevant projections this can mean 20 cards and up to 41 calls for that selected page, before other page
  work; this is an arithmetic source bound, not a measured runtime. At 300 contexts, incremental paging limits the
  first request but not the eventual accumulated UI. This concrete pattern supports the maintainer's context-density
  criticism without claiming that every legacy home path made those requests.

Legacy is a behavior reference. None was merged, copied wholesale or recommended as a source port. A new design
should retain successful jobs and deliberately replace upper-bound failures using the rebuilt common capabilities.

## Keep, retire and add by marginal protection

**Keep** native outcome contracts, current-disclosure/negative-information tests, exact cursor bindings, ordinary-write
read-after-write, finite useful preparation, payment idempotency/current benefit checks, account-switch/erasure
fences, native cost attribution and harness custody. Keep deterministic component/adapter cases for rapid diagnosis,
especially no-store/credential/late-response behavior, missing-vs-empty and imported-vs-native score meaning.
Keep real browser geometry and accessibility checks already present. A visual defect does not invalidate them.

**Candidates to retire or consolidate after owner adoption and replacement evidence:**

- Source-substring checks as the only oracle for a user journey, such as expecting a route to contain specific
  component names. Retain a source check only where the source boundary itself is the requirement, such as forbidding
  a server dependency from a browser package. Replace functionality evidence with served behavior.
- Superseded exact design literals/shapes, including the marketing heading, landscape defaults and composer-ring
  expectation. Do not weaken or edit a frozen suite in this research. The owner must reconcile it with current
  authority and preserve independent privacy/behavior requirements when commissioning the replacement.
- Repeated full-shell wrappers whose sole assertion concerns an isolated slot, when they add no shell interaction.
  Retain one composed integration example and smaller local variants. Where scope/search/Filters actually is part
  of the job, the full shell is essential and its interaction must work.
- Duplicate fixture algorithms that restate the production matcher or sort. Retain transport fixtures with explicit
  expected examples, but avoid maintaining a second backend whose agreement is mistaken for correctness.
- Stabilization expectations that preserve obsolete semantic shape. Keep intentional authored scenarios as authored
  fixtures; keep actual captures truthful and versioned. Do not delete recorded evidence merely to reduce lines.

Retirement is conditional: record the failure protected, identify the surviving oracle, obtain that owner's adopted
contract and then remove only redundant evidence. No wholesale deletion budget or desired line count is justified.

**Add or complete these missing assertions through the existing suites/drivers**, after managers adopt the slices.
These are proposed scenarios, not new accepted/frozen test names:

| Proposed observable scenario                                                                         | Reuse and exact missing oracle                                                                                                          | Risk/bound to retain                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Enter a real Collection/Library/community scope, submit query+filter, page, then remove scope        | Existing header, members and native search drivers; assert actual native operand and outside-only exclusion from served page            | No silent Global fallback; owner identity, current membership, cursor/query binding.                                     |
| Open the real Collection Filters at 390/1280, keyboard-edit harem and strict word bound, apply/clear | Current SignedIn PageStory + shared header filter surface; assert panel/control bounds, retained query and no duplicated toolbar form   | Also 320-equivalent reflow, focus visibility/return and no hidden overflow.                                              |
| Header with unequal left/right controls, focus, expanded query and long scope label                  | Existing header stories inside actual AppShell; approve centered field and one coherent surface                                         | Do not remove accessible focus; phone full-screen/Back/Escape and one query surface.                                     |
| Long subject overview, details and editions; expand/collapse then navigate/reload                    | Existing native traversal and recorded page cases; assert useful first-screen content and explicit exits, not every section on overview | Independent cursors, spoilers, retained context and localized content.                                                   |
| One unavailable optional owner beside useful successful content                                      | Existing composed subject fixtures; assert correct containment and a coherent recovery path, rather than just h1                        | Distinguish closed, concealed, empty, preparing and failed; no fabricated counts.                                        |
| Mixed actual images and missing/withheld images across Collection list/grid/editor/header            | Shared Cover and current Collection story members; assert portrait defaults, landscape preservation and loaded/placeholder state        | Image rights/credit/variants, no unauthorized URL/alt leakage or layout shift.                                           |
| A native Continue item saved through ordinary progress API reaches the exact session                 | Existing native personal driver and current one-FULL-request adapter                                                                    | Six-item bound, session/account changes, no public SSR personal state; native readiness remains honest.                  |
| Select a rating population among 300 readable candidates without one card per candidate              | Existing rating tests and population picker API                                                                                         | Bounded searchable paging, no inaccessible membership disclosure, one own vote and no blended figures.                   |
| Native subject directory → offer review → existing checkout, then exact current Content use          | Existing subject-offers adapter, native purchase and Content sale/use drivers                                                           | Positive plus no-offer/denial/preparing, old revision refusal, duplicate payment, wrong-version/revoked/takedown denial. |
| New mixed home for signed-out/member/special home at settled upper bounds                            | Existing home, community, source and Performance contracts after scope adoption                                                         | Fixed initial blocks/selected candidates/bytes/DOM, useful expansion, independent privacy and lifecycle costs.           |
| Match deployed story to exact source/profile/release/recording version                               | Existing publisher/capture metadata and evidence registry                                                                               | Preserve current publisher; capture cannot substitute for native proof or maintainer design review.                      |

Do not add a parallel exhaustive Storybook campaign. Reuse the completeness auditor's valid artifacts and the
existing canonical publisher. One visual baseline per meaningful state after review is more useful than repeated
screenshots of unchanged shells. Use a temporary, bounded fault rehearsal later to demonstrate the new oracle:
drop the actual scope operand, force an outside-only hit, narrow the opened panel or withhold one composed owner.
That would validate diagnostic value; no such mutation or rehearsal occurred in this research.

## Maintenance cost and a coherent delivery order

No runtime or financial cost was measured. The following is a planning model, in contributor time, not a forecast
derived from LOC. The inputs are explicit so owners can replace them with actual receipts after integration.

One change to a shared wire/profile/definition can affect producer validation, generated client, decoder, normalized
recording, fake response, story and frozen/native driver. The expensive quantity is the number of independent
representations of meaning, not how many JSON lines a formatter prints. An illustrative change with 4–8 affected
representations at 20–45 minutes each costs **1.3–6 hours** before product work and any failed-run investigation.
Repeated source-shape assertions and hand-maintained duplicate fakes increase that fanout; common native adapters
and faithful fixtures reduce it. This model is not an observed frequency for this repository.

| Continuing work                           | Explicit planning assumption                                                                   | Cost per month under that assumption                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Boundary fixture/contract updates         | Four shared semantic changes/month, 1.3–6 hours of evidence maintenance each                   | 5–24 contributor-hours                                           |
| Design review of changed canonical states | 8–12 genuinely changed states/month, 15–30 minutes each, plus two 1-hour cross-surface reviews | 4–8 hours                                                        |
| Native bridge/harness triage              | Two distinct failures/month, 1–4 hours investigation each                                      | 2–8 hours; frequency unmeasured                                  |
| Privacy/lifecycle/growth review           | One 2–4 hour review/month of changed operation bounds and owner seams                          | 2–4 hours; native execution cost additional                      |
| **Illustrative ongoing total**            | Assumptions above only; overlap must be removed in real accounting                             | **13–44 contributor-hours/month**, about 1.6–5.5 eight-hour days |

This is not an estimate to maintain every existing test, nor an infrastructure runtime budget. A full 20-journey ×
8-locale × 2-viewport × 2-theme × 3-persona cross product has 1,920 combinations before failure states. Do not turn
that arithmetic into a new campaign. Factor invariants: exhaustive pure grammar/serialization cases, representative
visual axes, and a small native bridge per distinct authority/lifecycle seam. Add another dimension only when it
changes the behavior or visual risk. Retain broad existing language/a11y tests until their owner can demonstrate
equivalent protection; proposed factoring is not permission to weaken acceptance.

Suggested sequence and rough **test/evidence engineering** sizes follow. They exclude the unknown product/backend
implementation effort, external provider readiness and deferred native execution time. One day means eight hours;
the ranges are desk estimates, not promises or work authorizations.

| Order and coherent slice                            | Owner/dependency                                                                                                                | Evidence work size                               | Exit to ask the manager to adopt                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Establish evidence truth and reconcile oracles   | Web + existing publisher; owner docs reconcile settled copy/cover/header choices and stale status text first                    | 1–2 days                                         | Every claimed result names source and boundary; current public captures joined to a build or explicitly unknown; no fixture described as native proof.                                                                                                 |
| 2. One functioning scoped Collection search surface | Web/Search/Library + UI Menu; requires actual supported owner query binding, not a scope label                                  | 2–4 days after binding exists                    | Enter, query, refine, page, clear/remove scope, reload and revoke through the real shell with positive/outside-only cases; open Filters fits and remains accessible. Extend via adapters to supported community/Zone sources, respecting closed scope. |
| 3. Coherent subject page and covers                 | Web + composition/Semantic/Content; uses adopted independent subject/cover research rather than preempting it                   | 2–4 days after IA adoption                       | Long/empty/partial-failure overview, useful tab exits, portrait/landscape/missing cover states and compact rating population selection reviewed together; existing native traversal retained.                                                          |
| 4. Connect personal and purchase seams              | Library/Commerce/Content + Web; reuse actual native positive producers                                                          | 2–3 days after producer readiness                | Continue exact-session bridge, subject-directory positive to existing checkout, exact-version protected use and revocation; keep settlement/threshold/native isolation cases.                                                                          |
| 5. Adopt and deliver mixed home as its own slice    | Owning product scope + Search/Community/Semantic/Library/Web; follows independent home research and upper-bound cost derivation | 2–4 days for evidence after design/API selection | Bounded mixed initial view and expansion for signed-out/member/special home, no slogan, fixed attention/selection work at 200,000 kinds/300 memberships/thousands follows. No implied reopening of feeds before scope adoption.                        |
| 6. Consolidate redundant evidence                   | Each test/recording/harness owner after replacement scenarios exist                                                             | 1–2 initial days, then normal maintenance        | Remove only duplicate/obsolete oracles with a named surviving requirement; retain frozen/privacy/lifecycle/growth contracts and record any adoption conflict.                                                                                          |

The non-overlapping initial evidence-work estimates total **10–19 days**, conditional on the named design and native
dependencies. They can share existing fixtures and captures; do not add the twenty-journey audit again as another
implementation task. The highest immediate return is fixing the scoped-search/filter seam and the subject page's
whole-page usefulness oracle, while preserving strong native protection underneath. Deleting large suites first
would lose hard-to-recover security/lifecycle evidence without resolving those visible defects.

There is no unanswered maintainer-only design question needed to complete this audit. Header placement, phone
surface, no slogan, portrait defaults and upper-bound quantities are settled. Managers can choose coherent sequencing
and update owning documents. Mixed feeds do require explicit scope reconciliation: retain catalogue-only first scope,
or adopt a bounded mixed-home slice with its native source/ranking/privacy contract. Given the stated intent, recommend
the latter after independent home findings are adopted; this is a recommendation, not a change to `scope.md` here.
Do not conflate that owner adoption step with asking the maintainer to decide the same visual choices again.

## Research decisions and handoff

- Count strict candidates and the broad artifact union separately. Do not retroactively assign the unsourced 400k
  claim a precise boundary. Record kernel's compatible subtotal without asserting historical provenance.
- Leave unreviewed semantic value **unknown**. The sampled evidence demonstrates specific valuable native contracts
  and specific weak/wrong frontend oracles; it supports neither “all tests are useful” nor “the tests have no value.”
- Treat unavailable/fake/recorded as explicit states. Correctly refusing an unsupported scope is valuable safety
  behavior; a complete product additionally needs a finite positive journey. Current source overrides stale inventories.
- Treat supplied screenshots as symptom/design evidence with unknown build/viewport. Source/public mismatch is an
  unresolved version seam, not a proved stale deployment. Do not duplicate the live completeness capture owner.
- Preserve independence of the home, subject and backend investigations. This report identifies test seams and
  prerequisites; it does not adopt their design, ranking, architecture or disclosure decisions before their reports land.
- Only this English report is a tracked change. The sole write outside its declared report path, besides authorized
  ignored authority/reference staging, is the authorized reference registry entry at
  `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`, recording the reused Discourse source, commit, licence
  and date. No product, frozen acceptance, configuration, dependency, publisher or capture was changed.

Verification is deliberately deferred: the report-only research mode and current execution policy prohibit the
original acceptance/native/browser/check campaign. Documentation changes require no workspace compiler. This report
claims source inspection and completed research, with no new executed-passing evidence and no whole-feature/Goal
completion claim. The manager can adopt the corrections in the single owning documents and commission the coherent
slices above without reopening settled decisions or mistaking test volume for delivery.
