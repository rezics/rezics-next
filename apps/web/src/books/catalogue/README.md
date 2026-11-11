# Book catalogue entry

Decision: retain the installed canonical typed Search handoff and separate-tab exact-type Library/reader visits;
extend their native composition and currentness assertions, with native/browser acceptance in the dev verifier.

`/{locale}/books` is the public Book Library entry. Its owner navigation contribution is installed in the shared
shell, including phone navigation. Interface copy covers all eight launch locales. The entry offers Book,
BookSeries and Edition separately, using the exact released `schema:Book`, `schema:BookSeries` and `bf:Instance`
identities. Each choice reads its current descriptor through the existing definitions directory. Missing and
unavailable descriptors remain visible without an actionable catalogue or shelf destination; a failed read can
reload the same three choices. Supplied labels and descriptions retain their language. An absent label uses the
exact type reference.

## Discovery and reading

The installed discovery seam is the canonical Search address. Browse uses `discoverySearchHref`; the search form
submits `q` and the selected released `type` to the same localized Search route. No query parsing, result fetching,
filtering, sorting or pagination is implemented here. Search owns admission, its bounded native page, exact failed
page retry, explicit restart, sparse continuation, result rendering and its existing destination-return lifetime.
The entry does not imply that an available definition makes Search's production source ready.

The query and released Type use the shared Field, Input and Select primitives. Only admitted ready Types enter the
named form field. Replacing that finite choice set starts a new selector, so a previously selected unavailable Type
cannot remain as a hidden form value. A descriptor without a title keeps the exact Type reference as its label.

The installed Search recovery distinguishes a row-sparse page, whose native continuation remains usable, from an
empty continuable page, which offers an explicit restart. That restart retains the admitted query, Type, filters and
display-language chain and clears only the frontier. Unavailable recovery repeats the exact failed page. Neither
case triggers refill reads here.

Discovery opens in a separate tab, retaining the entry. Search's existing result links open the supplied Subject
identity and retain the initiating query, type, filters and opaque frontier through its existing return owner.
The ordinary Subject composition supplies covers, names, facts and admitted context. Its literary reader owns
the actual work, series or Edition identity and directed bibliography windows. Semantic bibliography does not
become Content's authored chapter table of contents. Missing creator or publication context is not hydrated here.

## Personal Library handoff

Each released choice offers its exact native type-filtered shelf through `shelfHref`. A current released literary
reader also offers the shelf for the actual Subject type, including a released descendant; an Edition never links
to a guessed work's shelf. This link disappears with the existing retired reading. Unsupported shelf type syntax
does not fall back to an unfiltered private list.

Shelf links open separately so the originating entry or reader remains at its current window. The shelf receives
only `type`: omitted state, order, layout, size and columns retain native URL/default-preference resolution. The
destination's existing private route owns safe sign-in, session admission, private request retirement, entry actions,
progress and readback. This entry stores no account state and starts no private requests. Closing the shelf tab
returns to the initiating visit; existing owners still re-admit results when required.

Continue links to its existing localized route without a type condition. A book shelf is not a replacement for
that independent progress stream. Book, Series and Edition shelves are separate exact-type visits, not a fabricated
union of private rows.

## Capability and integration boundaries

The entry performs three finite definition metadata reads in parallel and zero catalogue or shelf page reads.
Following a destination uses its installed Search or Library application and transport. There are no per-result
Subject reads, background catalogue requests, retained private payloads or alternate production adapters here.
Source readiness, native search/facet execution and private Library capabilities remain their owners' decisions.

Route-tree and Paraglide message generation belong to integration; source declarations are provided without generated
output. The focused [composition assertions](../../../tests/book-library-catalogue.test.tsx) cover released metadata,
all eight localized entries, exact shelf/default and Search filter/frontier propagation, bounded page requests,
literary reading retirement, safe sign-in and the existing shelf entry action/readback. These assertions execute
after landing in the dev verifier; source acceptance is final-source Web typing.

[Book catalogue visit stories](../../stories/book-library-catalogue.stories.tsx) mount `AnonymousBrowse`,
`MemberShelfHandoff`, `Sparse` and `UnavailableRecovery`. Public discovery and literary envelopes are explicitly
illustrative; the member shelf uses the installed recorded Library transport. Locale, phone390/desktop1280 and
light/dark globals cover the same mounted compositions. Browser/native journey acceptance, visual review and
publication remain integration work.

## Source orientation

The design follows [Web](../../../../../docs/goals/web.md), [Search](../../search/README.md),
[catalogue context](../../features/pages/catalogue-list-context/README.md),
[literary reading](../../features/catalogue/literary-reader/README.md), [Library](../../library/README.md),
[navigation](../../shell/navigation.ts), [UI](../../../../../packages/ui/README.md) and
[verification](../../../../../docs/development/verification.md). The read-only
`legacy-final:apps/web/features/library/books-library-recorded-page.tsx` supplies the behavior floor of recognizable
books, current personal state and useful Library entry. Its combined snapshot does not replace the installed native
Search, literary and private Library authorities.
