# Game work reader

The ordinary Subject overview admits Game and Visual Novel work identities through the current immutable Release.
It reuses Game field grouping, selected ranks and released labels, preserving every selected statement's qualifiers,
references and accepting digest. Explicit unknown, no-value, TBA and partial dates remain distinct. An absent admitted
date is named absent. Missing platform, engine, language or status configuration is unsupported, with existing Details
and Edit facts links; a source code never supplies a new concept or an inferred status.

An actual software release is a separate Subject reached only through a disclosed inverse `schema:exampleOfWork`
assertion whose holder, statement, target and summary identities agree. Only released software-release Types get
release navigation. Add-ons remain separate; platform/language combinations create no release, version or copy.
The explicit inverse `schema:exampleOfWork` window includes the current disclosed assertion even when it has no
qualifiers; navigation never depends on adding an incidental qualifier or relaxing target disclosure.
Release-specific facts remain on that release's ordinary Subject and existing `/release` companion. Existing
finite Relations and Credits views, generic facts and Game correction retain their owners.

Decision: VN tag reading uses the Subject's exact pinned catalogue metadata, including its released Concept facets;
it shares tag admission with VideoGame and TVSeries rather than inferring metadata from the game reader's active Release.

Decision: exact destinations open in a new tab, preserving the source window; keyboard return restores its surviving
opener, or the reader heading if the opener disappeared, without overriding moved focus.

The mounted reader observes the existing session and exposure caches without starting another session read.
Decision: initial unknown session to signed-out or the source's matching reader, and undefined to the first prepared
spoiler setting, preserve the same work reading, optional-section state and pending release request. Until preferences
prepare, spoiler disclosure uses zero; closed spoiler gates unmount their evidence. The route's session serialization
is not a Game descriptor: the existing browser observation owns account and credential incarnation changes.
After preparation, observation replacement (including equal successful credentials), exposure loss/replacement,
source, reader, locale, Context, Realm, Type or deliberate spoiler-setting replacement retires current facts, cursors, pending results,
reveal consent and focus intent. The same retired source cannot revive after an authority transition. A replacement
source establishes a new observation. Refresh removes the prior reading; continuation removes its release window
before fetching but retains work facts on transport failure. Withheld readings remove both sections. Failed reads
retry their exact address and traversal intent; native cursor refusal, a repeated accepted token or 64 accepted windows offers an explicit
first-window restart instead. Previous explicitly revisits a successful address through the same native reader,
including a cursor already seen on forward traversal; every accepted revisit still counts toward the 64-window fence. An absent next token never supplies a catalogue total. No edit, candidate selection, provider
login or private Library action occurs.

## Subject preparation handoffs

Decision: Subject supplies undefined to Game for both absent preferences and the shared `defaultReader` sentinel;
the first actual zero or nonzero setting prepares the existing reading. Equal actual values retain it; a later
different value retires it. Mounted Subject regressions own this caller boundary as well as pending native windows,
selected edition inspection and disclosure.

Album facts use the same Subject page's installed immutable definitions immediately. The overview does not reread
the album profile. Its independent native Edition request retains current Subject, definitions and inverse
`schema:releaseOf` admission, and explicit Retry repeats that address. Undefined Edition data means preparing;
failure, unsupported configuration, an admitted empty window and rows remain distinct. Neither pending nor failed
Editions suppresses composed facts or supplies a catalogue total. Source, viewer, locale, Context or installed
definitions replacement retires the observation and its late results; a fresh page source establishes a new reading.
Track reading remains independent. Existing Album and Game stories remain the visual review surfaces.

`tests/subject-prepared-profile-mounts.test.tsx` reuses the typed Album/Game fixtures and the mounted Game harness
to pin these Subject handoffs, pending replies, exact Edition retry and observation retirement. Existing assertions in
`tests/game-reader-view.test.tsx` and `tests/subject-reading-composition.test.tsx` retain their behavior. Execution of
these integrated cases, typing, native admission and keyboard/disclosure review is deferred to the verifier.

Game dates consume shared time presentation plus release-fidelity's explicit TBA meaning. Only an absent calendar
uses the native Gregorian default; explicit non-Gregorian calendars stay unsupported. Signed years, precision,
timezone and uncertainty are shown even when the shared helper intentionally omits a structured date.

## Edition inspection and recovery

The edition list and its inspection keep the native inverse `schema:exampleOfWork` association separate from the
software-release Subject. The panel identifies the holder, statement, property, work target and released software
Type, and preserves the assertion's rank, qualifier values, references and historical marker. A missing assertion is
unavailable, not an empty set of qualifiers; a missing summary never supplies a title or destination. Repeated release
labels do not select another assertion. Inspection uses the exact admitted row object, and page replacement removes
it even when an equal response or the same row object returns. Spoiler hiding also hides its inspection.

Previous keeps a stack of at most eight accepted prior addresses, evicting the oldest first. Only successful next
navigation pushes an address; successful Previous pops it. Pending and failed navigation do neither. Start requests
the first window and clears traversal metadata only after accepted success. Pending and failed addresses are named
separately from an accepted window. Retained work facts during continuation failure remain evidence of the live work
admission, not proof that the requested edition window succeeded. No former release row remains navigable.

Decision: Previous uses a bounded backward stack with no Forward command; after retirement, recovery reruns the
installed current-Subject route loader without restoring transient edition selection or reveal consent.

Decision: Game edition and evidence values render through the catalogue-owned `WorkReadingPort`. Page composition (`work-reading-binding.tsx`) binds the live `CandidateValue` adapter; the reader no longer imports `pages/data`. Edition inspection, comparison and recovery are module-local render adapters over the existing window application.

`GameOverview` consumes that recovery through `router.invalidate({ sync: true })`; the installed Subject loader
fetches its stale-time-zero Subject query and supplies a new source. A matching result or repeated click cannot reset
the retired lease. While recovery fails or yields no new source, only safe unlabelled current Subject/Details routes
and an explicit reload remain. These preserve Realm and locale and confer no correction authority. Live admission
failures also retain deliberate Start and safe navigation. No query parameter claims URL/reload restoration.

Closing inspection restores its connected keyboard opener only from current panel interaction. New-tab return and
pending navigation completion respect later focus, key and pointer interaction. Replacement retires old destination
return intent; current keyboard navigation can still finish at the reader heading.

## HTTP admission and comparison recovery

The default Subject extension reuses its already planned inverse release window through `gameOverviewInitial`.
Composition and deliberate continuation share `gameReaderEditionPage` and its row, byte, identity and cursor bounds.
A malformed successful external response such as `{}`, a null row or an assertion missing its property/value
objects is unavailable, never an empty release catalogue. The shared HTTP receiver admits row and nested assertion
objects before reading their identities, so both composition and the dedicated reader use the existing failure mapping.
Decision: admit the optional comparison's installed closed union at that HTTP seam; malformed or oversized comparison
facts become comparison-unavailable while independently valid work facts and release memberships remain usable.
Admission checks all native card fields, statement/evidence shapes and summary/cover credits without rewriting values,
and matches each card's Subject, Type and membership to its ordered admitted row. Native unavailable, available-empty,
missing, withheld and unsupported meanings stay distinct. The comparison Retry explicitly rereads that same native
page, including its cursor, through the existing window request fence; replacement retires pending results.
Retrying an accepted page is a revisit: it neither hits the forward cursor-cycle refusal nor pushes Previous again.
An unaccepted navigation failure keeps its original traversal intent when retried. Every accepted retry still counts
toward the existing 64-window fence.
Admission costs O(N + K) for at most 20 memberships and the supplied facts within the comparison's 2 MiB cap, with
native field limits of 32 statements, 64 qualifiers, 32 references, 64 parts per reference and 64 KiB per field statement.
It adds no request, hydration or retained response history; membership assertions keep their existing row byte bound.
An initially unavailable release section retains admitted work facts and retries the first native window explicitly;
withheld or invalid admission still removes both sections. No former release destinations survive a failed retry.

## Cost

One deliberate window performs at most four generated native reads: Subject, active definitions pointer, its immutable
Release and one inverse links page limited to 20 rows. There is no target hydration, source adapter, search, automatic
refill or write. Release admission uses the existing definition reader's 4 MiB/1,024-Type limits; the Subject is bounded
to 2 MiB, each association to 128 KiB and the page to 20 × 128 KiB + 64 KiB. Oversized responses are unavailable,
not truncated into a different assertion. Cursors are opaque, at most 4,096 characters and cannot repeat themselves.
Duplicate or mismatched association identities are refused. Retention is one Subject, one immutable definition
observation, one 20-row window, at most 63 accepted continuation tokens, eight previous addresses and one pending address, independent of
catalogue size. Each address retains only the bounded work address and optional 4,096-character cursor, never
response bodies or harvested row identities. There is one accepted native edition page and one in-flight request.
Continuation is explicit and replaces the window; an empty native page with a following token still offers More. Counts are not inferred from
disclosed rows. Browser retention is private to the mounted visit; the server response is private/no-store.

Examples use the actual bundled vocabulary and typed native response shapes, independently of native acceptance.
The wrapping, theme-token layout and existing controls apply at phone390/desktop1280, both themes and all locales.

## Routed product visit

`pages-library-games--main` and the retained `pages-catalogue-game-reader--work-and-exact-release` review entry mount
`PageStory`'s generated application route tree and existing providers, with a signed-in reader and ordinary native
loaders. Both show the admitted Subject identity, cover, synopsis and actions before compact Game facts. The separate
`pages-catalogue-game-reader--reader-work-facts` and explicitly named Reader states isolate the typed reader examples.
Harbour Lights, its people, six software releases, story acts, characters, related games, reviews and collections are explicitly synthetic.
Game identities and media use a UUID namespace distinct from the other routed fixture families.
Original CC0 cover illustrations and their WebP variants live in `.storybook/media/`; no provider recording is claimed.
All installed tabs remain reachable. Native references use the reserved `north-quay.example` catalogue address.

Decision: every Game reader opens with compact admitted work facts; Credits, Relations, Editions, release comparison
and each fact's qualifiers/citations are labelled native disclosures, closed until deliberately opened. The optional
`compact` identity prop only suppresses identity text already supplied by the Subject frame; it never selects a long
fact/evidence mode. Historical meaning and unavailable/withheld field states stay beside their affected values.
An explicit current-assertion return may reveal its containing group without opening Editions or comparison.

Facts use a two-column rhythm where space permits and retain released property and related-Subject labels. Ordinary
Gregorian dates use natural language at the supplied year/month/day precision; uncertainty, unsupported calendars and
long signed years retain native presentation. Evidence retains the unchanged native date, accepting digest, statement,
rank, qualifier and reference parts. A missing released evidence label retains its native property ID as code inside
the disclosure.
Comparison groups with an available value omit redundant missing/unsupported alternative properties;
withheld and unavailable alternatives remain explicit. Comparison failure and its exact native retry belong inside
Editions, as does release-window failure when work facts survive. Neither opens that disclosure automatically.
Deliberate Editions disclosure survives native continuation/retry while its replaced rows, inspection and spoiler
consent retire; source/reader replacement retires the entire reader as before.

Named entries are `pages-library-games--exact-release-return`, `--sparse`, `--release-section-failure` and
`--reviews-section-failure` (each uses the same prefix). They stay at their named state, without automatic tab or
history traversal. Theme, viewport and locale remain Storybook globals. Interaction examples remain separately linked
from the canonical story documentation. Preview navigation uses the existing application router for new-tab links,
so an exact Switch release, its work and the same release can be followed manually with Back/Forward.

Design sources: [reading-first Overview](../../../../../../docs/subject-pages.md#reading-first-overview),
[page composition](../../pages/README.md#reading-first-overview), this reader's admission/recovery contract and
[Storybook ownership](../../../../README.md#storybook-and-page-recordings).

Malformed edition data is repaired at the shared HTTP receiver. Regression source in `tests/game-showcase.test.ts`
pins shared HTTP and comparison-envelope admission, retained work facts and release-section failure through
`gameOverviewInitial`, and natural date precision. `tests/game-reader-view.test.tsx` pins useful initial reading,
closed optional sections, deliberate evidence and native comparison recovery, exact return focus and retirement.
Source-only delivery defers test, typing, build, native and browser/capture acceptance to the integrated verifier.
Earlier checks do not establish acceptance of later promoted source; source completion is not a runtime pass.

Lifetime design sources: this README's lifetime, recovery and routed-visit sections, the Pages retained-readings
contract, `tests/game-reader-recovery.test.tsx`, `tests/game-reader-view.test.tsx`,
`tests/subject-community-current-retirement.test.tsx`, the [session observation contract](../../../session/README.md)
and its `reader/lifetime/observation.ts` implementation. The main checkout's `.reference/INDEX.md` was consulted;
this local repair needs no external code or new admission policy. The named mounted regressions cover initial
preparation, spoiler disclosure, account/credential/exposure retirement, late release responses and fresh-source recovery.
