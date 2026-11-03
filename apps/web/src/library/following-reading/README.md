# Following target reading

Following renders one native FULL page in supplied order, at most twenty rows. Its summary identities and exact target
index are prepared once per page in O(N); inspection selects by exact target ID in O(1). Local confirmed removal
leaves a sparse page. Next uses the opaque cursor and replaces the page; a stale continuation retains the existing
explicit restart. There is no accumulated list, global search, type filter, favorite command or hidden refill.

Subject links use `subjectHref`; Collection links use the localized Collection reader when `collection.get` is
exposed. A missing summary retains the follow and its exact target reference, with identity unavailable and no link.
A supplied cover is rendered through the existing SubjectCover; absent covers remain absent. No initial row makes
a point read. Reading a label or follow source does not establish catalogue type, membership, notification delivery
or authorization. Removal retains FollowTargetControl, its current intent equivalence, point review and refresh
owners. The panel returns to that existing row control rather than mounting another command owner.

FULL Space rows carry the Community producer's current destination and applicable-action projection. A Space
destination uses its supplied address; a Realm destination uses its supplied Realm ID; an unavailable destination
creates no link. Space UUID is neither address nor Realm UUID. The row opens a supplied destination without point
reads.

Explicit inspection may make one typed `client.spaces({spaceId}).get` under the same prepared viewer and current
exposure. The response names its reader, target and locale. The selected request checks those against its parent
observation before using current title or summary, and confirms that the page's supplied address or Realm ID still
matches. It cannot create or replace a destination. Preparing, denied, unavailable, retired and ready without a
matching destination are separate states, all preserving the follow. Retry is explicit and replaces the current
selected request; there is no cache of selected communities.
One HTTP read does not bound the producer's cold access or Realm admission database work.

Selection is a separate observation from removal intent: replacing even an equivalent page object retires all
selected identity and destinations without discarding a row's uncertain command. Target, locale, cursor, account,
exposure, parent origin, close and source replacement fence responses, clipboard feedback and focus. One page and
one selection/request are retained, with no row/return payload in local storage or public URLs. Inspection focuses
its heading; Escape or Close synchronously restores its current trigger. Links use ordinary browser navigation;
the browser keeps the requested cursor address. Page hide retires inspection, and a restored browser document
requests a current page reread before a new inspection. Until a fresh page arrives, inspection and target links stay
suspended, with a readable updating state; the current trigger remains focusable. Retry focuses the inspection heading
before replacing its button with the preparing state. Collection exposure withdrawal also retires existing inspection
and retained link callbacks without replacing the follow command owner. Destination admission remains authoritative, so denied or
not-found recovery never removes a follow.

The installed [`personalLibraryRoutes` declaration](../../../../../packages/client/src/kernel/library/personal-routes.d.ts)
carries optional `destination` and `actions` operands on FULL Space rows. The browser preserves those exact generated
values and does not reconstruct them from the follow reason or Space UUID. Following exposes only supplied Realm
membership actions whose exact Realm ID and supported `realm.join` or `realm.leave` operation remain current after the
selected read. It opens the canonical Realm page; RealmMembership re-reads current viewer and exposure and owns the
command. Other or unavailable actions remain unavailable here.
Content/community retains Space/Realm reads and membership; watch/Inbox management, Library tracking and shell
community navigation remain with their existing owners.

The bounded journey is one `GET /v1/follows?view=FULL&limit=20`, optionally one deliberate selected
`GET /v1/spaces/{spaceId}`, then ordinary navigation to the supplied address or the exact admitted Realm. Existing
follow removal uses its existing writer, independently.
Native work includes the page producer's [`fullView`](../../../../../services/kernel/src/library/views.ts)
summary expansion and the Community reader's nested access/admission, not just the HTTP request count; those budgets
remain with their native owners. Connected stories distinguish selected-read success, denial, retirement, unavailability
and no destination; their successful inspection does not claim a delivered one-page destination/action projection.

Decision: after browser return, keep target inspection and links suspended until a fresh page observation arrives.

Decision: preserve native row order rather than type grouping, and request twenty rows from the existing page reader;
the retained base requested one hundred rows and grouped them by type.

Decision: route only current supplied Realm membership actions to the canonical Realm owner; unsupported Community
actions stay unavailable in Following.
