# Search interface

AppShell mounts one ShellSearch. At desktop widths of at least 64rem, equal side tracks reserve 21rem each for
navigation and the bounded language, theme and account controls; the middle track grows to 40rem. This centres
global search on the viewport regardless of navigation width or sidebar state. Account labels truncate within
their existing control. Below 64rem, search rests as a compact trigger and opens the same input in a full-screen
search surface.

The expanded composer inherits the panel's `background` surface in both themes. Its separator divides entry from
discovery without painting a second card. Keyboard focus outlines the actual input or action using `foreground`;
the composer has no enclosing focus ring. Keyboard-activated suggestion Retry
restores that input when loading removes the action; the intent retires on close,
unmount, owner change, or a reader who has moved. Shared Aura tokens and danger styling retain their existing meaning.

The phone surface contains focus, returns it on Back/Escape, retains the draft and locks background scrolling.
Safe-area padding and the active visual viewport bound the surface while its discovery/results region scrolls.
Viewport listeners exist only for the active search owner, with cleanup on dismissal; no result gains requests
or listeners. Crossing the compact breakpoint while editing preserves the input and query.

Result-kind traversal is keyed by the query, locale and initial discovery checkpoint (`as_of`); a changed checkpoint
starts a fresh traversal. Mixed DiscoveryResults copy (unnamed-account fallback, verified-as text, empty and recovery
messages, and recovery actions) uses the region's supplied locale; DiscoveryKinds still calls `discoveryMessage`
without one. Generated Search chrome and invalid-input recovery copy follow the supplied page locale, with English as
the fallback for an unsupported tag. Global search accepts drafts up to 512 UTF-8 bytes; scoped inputs keep their existing
256 UTF-16-unit cap, and typeahead keeps its independent 64-code-point prefix bound.

Header suggestion ownership follows query, locale, the full value of the supplied SearchScope, the active loader and
session observation; equivalent scope objects retain ownership. Locale, scope or loader changes hide old results
during render and retire their requests before selection. An unsettled session or a change to its state, subject or
CSRF observation also retires results; a settled session reloads the retained draft, while isolated presenters without
a session observation use anonymous identity. Trending and header-suggestion retries stay manual: native Retry-After
disables retry until its minimum delay, without polling; session observations (including CSRF changes) and locale
changes retire prior suggestions and pending requests.
A successful manual retry keeps keyboard focus on Retry when that control remains, otherwise the first term or the named
trending region, using the request's currentness callback and without stealing focus if the reader moved away.

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

Condition-tree edits recover keyboard focus for the initiating action after the changed DOM commits, using that
session's draft-node identity. A later recovery, external replacement, disablement, unmount, or a focus move away from
the initiating control retires the queued handoff; the live status still announces the edit.

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
continuations for one property. Explicit Load, More and Retry keep focus on a surviving usable control; a removed
control or a disabled fieldset recovers to Retry or that property or status region, and never steals focus if the
reader moved away. Picker, Load, More and Retry share one native facet-read admission: a current refusal or restart and
a future Retry-After deadline withhold every read; expiry only enables an explicit Retry of the failed facets and
cursor, never a queued request. Local property lookup and shown-set selection stay available during those states. A new
query identity starts a fresh admitted state.

Native GET sort submission uses an empty `sort` value for Relevance, parsed as the default; `rating` is the only
explicit sort value.

Local Recent keeps exact query text within global Search's 512 UTF-8 bytes or native Recent's 256 UTF-16-unit bound,
never truncates, and leaves longer valid global queries local-only so they cannot block native synchronization.
Recent history reads at most two 20-row pages for its 32-row view; each nonterminal page must contain 20 rows, and
malformed continuations keep accepted local history and pending changes until a fresh traversal succeeds. A native
page is admitted only when every row matches the kernel entry, revision, date, identity and display contract; a present
query destination is that row's own scope path with the authored query and language parameters, never another route,
identity or origin, and never a reconstructed label or followed URL. Failed
local writes remain in the memory fallback until a write succeeds; observed durable removals and
`localStorage.clear()` invalidate cached durable buckets, including inactive ones, while account labels remain
native-hydrated. Keyboard removal focuses the next available row action, including one newly shown at the 5/32-row
limit, then the previous action, and falls back to the labeled history region; explicit clear focuses that region and
announces completion.
Recent server functions admit only native command discriminants and fields before dispatch; unknown kinds and unresolved
`pending:` remove ids fail validation with no native call. Extra adapter journal fields on a pending envelope are stripped.
Native Recent Retry-After is an in-memory, adapter-scoped minimum delay: sync, refresh and retry refuse native I/O
until that instant without polling or persisting a deadline; local remember, remove and clear continue, and an explicit
retry after the delay resends the same attempted command.

The [canonical stories](../stories/header-search/README.md) cover resting, focused discovery, suggestions,
filter entry and phone interaction. `tests/header-search-composition.test.tsx` exercises the existing routed
Search page and default shell across desktop/phone, English/Simplified Chinese and light/dark. It protects actual
geometry, surface paint, focused controls, registered filter entry and retained phone drafts. Execution of that
acceptance and native/browser evidence is deferred under the current delivery policy; workspace typing alone
does not establish those outcomes.

Composed Members replaces its single accepted native page only after successful explicit More (at most the planned limit, capped at 12 rows with facts when paged, or 24 in previews); sparse pages stay sparse, failures retry the same cursor, and cycles offer a fresh restart with at most 12 recent cursors plus one cycle checkpoint and two bounded counters per node.
