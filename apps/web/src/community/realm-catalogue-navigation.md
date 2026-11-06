# Realm and Space catalogue entry

The [Web scope and rating requirements](../../../../docs/goals/web.md#second-scope-interfaces)
retain authority over Search controls. This guide owns the community handoff implemented by
`RealmCatalogueCurrent`, `RealmCatalogueNavigation` and `realm-catalogue-entry` in the default
`SpacePage` composition used for both Realm and Space routes.

## A community visit

The community identity and participation remain in `RealmHomeHeader`. Below it, Complete catalogue
explains the population and offers Browse all works, Search this catalogue and Explore rating
options in scoped Search. The boards and selected publications remain their existing native shelves.
The publication introduction explicitly describes an editorial selection. A publication does not
establish membership of the complete catalogue; its ordering and continuation are independent of
Search ordering. Membership of a Realm does not grant management or catalogue authority. The page also mounts
the shared Search section with its actual Realm identity, released facets and a single 20-row replace window.

Browse opens ordinary localized Search with the current Realm resource filter. Expanding the query
entry provides a labelled query, a description of the destination, submit and clear. Empty query
means all matching works in that same Realm. Clear returns focus to the field. Closing the query
entry retains its draft only for this visit. The controls wrap at narrow widths and have minimum
44px targets; supplied community names wrap without clipping. Search owns the mounted results, facets, conditions, rating controls and recovery. The page fixes membership to
its Realm; authorization still runs at the native boundary, including for verified anonymous readers.

The GET form uses the canonical Search pathname and a hidden native membership filter, because a
browser GET submission replaces the query string in its action. It encodes accepted query text
without trimming. It includes no cursor, previous facets, selected rating population or stored
Search state. Browse and rating discovery deliberately open the complete scoped catalogue rather
than borrowing an unsent query. Normal links/forms preserve browser history; returning through Back
can restore the same visit, or remount a fresh empty draft. A new community never inherits a draft.

Decision: subject links from scoped Search carry a bounded same-locale return through the existing
Subject `via` field; browser Back retains the full visit when the return cannot be admitted.

Opening a subject from catalogue results retains the exact query, filter, facets, cursor and rating
selection in its Search return. The return targets the Search results region so the existing Subject
Connections action can restore keyboard focus. Invalid, non-Realm, cross-locale, private or over-
2,048-character Search URLs do not become in-page returns.

## Rating meaning and unavailable seams

Decision: RealmHome provides no authorized rating choices or readiness, so rating discovery opens
scoped Search with an explanation; it does not preselect a rating population or claim a ranking is ready.

The Realm resource filter controls which works belong in the results. `ratingPopulation` independently
controls whose native ratings supply meaning, and `sort=rating` alone never adds membership. The
installed Search owner validates the chosen population and owns preparation, refusal and generation
change. This region supplies neither a numerical population nor a readiness badge. A Realm's
existence and the viewer's membership are not rating admission.

The unavailable direct ranking seam is an authorized population/readiness observation for this
current RealmHome read. Until the owner supplies that observation, there is no direct “rank by this
Realm” action here. The available rating exploration link carries the same ordinary Realm filter
as Browse, and explicitly explains that availability is determined on Search. No Search helper or
native ranking path is added to simulate this missing observation.

A null Realm means absent or unreadable, without choosing between them. The region explains that
no current readable Realm is available and supplies no link or form. A malformed Realm identity,
hidden presentation, removed Space/Realm, orphan state or refused current presentation also leaves
no destination. A Space ID or address is never substituted for a Realm ID. A protected read without
a ready signed-in reader cannot render a catalogue destination, including during server rendering.

## Currentness and cost

The [Space page lifetime](space-page-lifetime.md) owns current-source admission, actual reader
origin, route aborts and query/session observations. Its private first-render and unobserved
credential-generation limitations remain unchanged. This navigation adds no authority token or
serialized private state and does not attempt to replace that host.

`RealmCatalogueCurrent` additionally gives the entry one local mount per page read, Realm reference,
pathname, locale, session tuple and availability state. Search cursor changes keep that mount and its prior row
window while the next read is pending or fails. Facets and counts require the new response's aggregate proof.
A replacement retires the old event source during
render, before successor controls appear. Unmount disconnects it. Detached click, auxiliary-click,
context-menu, input, reset and submit handlers check that source and the host's current admission
before acting. Removed or orphaned destinations release the old draft even if historical shelves
remain readable. A subsequent current read starts with a new draft. Header, publication, claim,
follow, membership and management lifetimes keep their existing ownership.

Local claim-read and container-restriction notifications advance a navigation revision before
scheduling their existing React state updates. Previous handlers compare that revision immediately,
so a late event is refused even before the replacement render commits. A successor render creates
a fresh entry source from the newly admitted state rather than reviving the previous draft.

There is one accepted query draft of at most 512 UTF-8 bytes and fixed navigation choices. Validation
uses Search's shared UTF-8 byte limit; a length guard rejects unbounded programmatic input before
encoding. An overflowing edit is refused in full, the previous bounded draft is retained, and submit
is unavailable until correction or clear. No silent clipping or Global fallback occurs. Form submit
also validates the actual field value, including a restored or autofilled value.

Decision: the Realm query entry enforces the shared byte limit independently of tolerant route parsing.
Direct Search URLs retain oversized operands for local correction, following the Search owner contract;
that preservation does not admit an oversized Realm draft or enable its submit action.

Encoding and validation are O(Q), with Q at most 512 UTF-8 bytes, and source identity is O(1).
The navigation retains no result page and makes no page, row, background, population or command request.
It does not iterate publications. Existing twelve-publication windows and separate board limits and
native continuations remain unchanged.

The Search handoff performs no reads. Its source URL is at most 2,048 characters and is checked
against the installed Search schema and Realm scope before it is carried into a Subject link. Link
construction is bounded by the current URL length; returning reuses the existing `via` sanitizer
and focuses `#search-results` without changing the preserved query bytes. Canonical Realm-to-Space redirects
carry the query and fragment. Both route boundaries preserve Search operands beside the separate shelf cursor,
and mounted Search uses the current pathname. Subject returns accept canonical Space addresses with a Realm predicate.

The focused entry and navigation tests cover parser admission, rendered forms/links, browser return,
replacement fencing, limits and supplied 1/6/12 publication windows. Connected Storybook examples use
the production page and existing recorded native sources at phone390/desktop1280 in light/dark,
plus long labels and unavailable/query states. Their play assertions are authored; browser rendering,
visual inspection and frozen acceptance belong to the integration controller under this attempt's
verification policy. No new native capture or native evidence is claimed by those stories.
