# Search interface

AppShell mounts one ShellSearch. At desktop widths of at least 64rem, equal side tracks reserve 21rem each for
navigation and the bounded language, theme and account controls; the middle track grows to 40rem. This centres
global search on the viewport regardless of navigation width or sidebar state. Account labels truncate within
their existing control. Below 64rem, search rests as a compact trigger and opens the same input in a full-screen
search surface.

The expanded composer inherits the panel's `background` surface in both themes. Its separator divides entry from
discovery without painting a second card. Keyboard focus outlines the actual input or action using `foreground`;
the composer has no enclosing focus ring. Shared Aura tokens and danger styling retain their existing meaning.

The phone surface contains focus, returns it on Back/Escape, retains the draft and locks background scrolling.
Safe-area padding and the active visual viewport bound the surface while its discovery/results region scrolls.
Viewport listeners exist only for the active search owner, with cleanup on dismissal; no result gains requests
or listeners. Crossing the compact breakpoint while editing preserves the input and query.

Result-kind traversal is keyed by the query, locale and initial discovery checkpoint (`as_of`); a changed checkpoint
starts a fresh traversal. Global search accepts drafts up to 512 UTF-8 bytes; scoped inputs keep their existing
256 UTF-16-unit cap, and typeahead keeps its independent 64-code-point prefix bound.

Header suggestions retire on an unsettled session or a change to its state, subject or CSRF observation; a settled
session reloads the retained draft, while isolated presenters without a session observation use anonymous identity.
Trending and header-suggestion retries stay manual: native Retry-After disables retry until its minimum delay, without
polling; session observations (including CSRF changes) and locale changes retire prior suggestions and pending requests.
Trending retries stay manual: native Retry-After disables retry until its minimum delay, without polling; session
observations (including CSRF changes) and locale changes retire prior suggestions and pending requests.
Native Trending may repeat a query when distinct sources share a public label; `literalQuery` is the quoted display,
so a repeated query repeats that display, and each delivered `{query, display}` occurrence keeps its own row identity.

Filters stays at the left of the composer's second row. `HeaderSearchFilterProvider` and
`useRegisterHeaderSearchFilters` connect it to the current route's actual editor and active count. Search owns
result filters; Collection's dialog remains a separate delivery slice. No new filter state or backend operation
is introduced here. Scope labels require a supported scoped action and suggestion loader; otherwise they remain
explicitly unavailable until removed, without falling back to global search.

Filters edits result-language preferences as an ordered list of at most eight: add from supported locales, preserve
existing valid authored tags verbatim, remove or move individual entries, and use the page-language default only
when the user clears the list.

The Revert edits action appears at the bottom of Filters only when condition or ordered-language drafts differ from
the committed search; it restores those drafts, clears draft validation, and focuses a status announcement in the
active surface.

Range controls show a localized Remove range link only for a committed property range; lower/upper strings and units
stay local to the SearchPage committed-state identity across Filters dismissal and desktop/phone changes, and blank
bounds remain invalid on Apply. The condition/language Revert action does not reset range drafts.

Property changes preserve values only when released datatypes and value definitions match, ranges only when both
definitions support the selected unit, and statement qualifiers only when both properties allow the same released
qualifier; incompatible nonempty operands require confirmation before reset to a fresh draft.

Refinement property lookup searches case-insensitive substrings of the current localized name or exact case-sensitive
identifiers; options with colliding names include their property IDs.

Facet More replaces the visible ten-value window while pending and failed reads retain the accepted window. Refinement
keeps windows and cursor progress only for the eight shown properties, then offers a restart after 64 successful
continuations for one property.

Native GET sort submission uses an empty `sort` value for Relevance, parsed as the default; `rating` is the only
explicit sort value.

Recent history reads at most two 20-row pages for its 32-row view; each nonterminal page must contain 20 rows, and
malformed continuations keep accepted local history and pending changes until a fresh traversal succeeds. Failed
local writes remain in the memory fallback until a write succeeds; observed durable removals and
`localStorage.clear()` invalidate cached durable buckets, including inactive ones, while account labels remain
native-hydrated. Keyboard removal focuses the next available row action, including one newly shown at the 5/32-row
limit, then the previous action, and falls back to the labeled history region; explicit clear focuses that region and
announces completion.

The [canonical stories](../stories/header-search/README.md) cover resting, focused discovery, suggestions,
filter entry and phone interaction. `tests/header-search-composition.test.tsx` exercises the existing routed
Search page and default shell across desktop/phone, English/Simplified Chinese and light/dark. It protects actual
geometry, surface paint, focused controls, registered filter entry and retained phone drafts. Execution of that
acceptance and native/browser evidence is deferred under the current delivery policy; workspace typing alone
does not establish those outcomes.

Composed Members replaces its single accepted native page only after successful explicit More (at most the planned limit, capped at 12 rows with facts when paged, or 24 in previews); sparse pages stay sparse, failures retry the same cursor, and cycles offer a fresh restart with at most 12 recent cursors plus one cycle checkpoint and two bounded counters per node.
