# Subject community consumer

`withComposedCommunity` reads only the existing composition's `subjectThreads` leaves. Web's
`CommunityList` passes each admitted node to `SubjectCommunityRegion` inside the existing Subject
community, refresh and verification contexts. The shared adapter applies equally to work, character
and person pages; it never infers a placement from a title, Semantic Context or Realm membership.

Decision: a title-only Subject invitation reports that details are not available yet; it does not ask readers to add facts or imply creation authority.

`CommunityRegion.request` retains the exact response's request, including the original opaque cursor.
`CommunityDisplayContext.source` retains the native Subject partition, epoch and position; Realm place
metadata retains its Space and head revision. `CommunityThread.rowKey` distinguishes duplicate
occurrences locally, while `position` retains array order. Neither field is command authority.

A failed continuation retries that request. Native `invalid_cursor` or `stale_cursor` responses require
a deliberate first-page restart. Sparse successful pages keep Next. Replaced readings remove their
cards and controls together and reject queued clicks; keyboard focus returns to the region heading.

Decision: show independently disclosed recorded citation IDs, units and vote revision even when historical
question labels and scale are unavailable; current review question metadata never fills that history.
A native review target identifies the reviewed Subject independently of the current page's Subject.
The Thread reader consumes that immutable citation through Content's public `publishedCitationForPost` entry.
Supplied immediate-parent context uses the existing public reply presenter. Missing counts remain unknown.

A row's Board link proves navigation only. Until the native Subject response supplies admitted entry
advice, the region explains the unavailable creation entry and offers a retry. The existing producer
must supply exact Subject/place, admitted Board, current creation advice and observation; Web retains
Board/composer authority and Subject/place/return intent through sign-in. Admitted Board creation is
consumed through Content's public `BoardStartThread` entry. No row, public link or empty
region selects a creation Board. Content's additive inputs flow through the adapter and context; no
outer placement change is required for these reading and recovery fields.

Decision: consume only the showcase's supplied native Board/work association through `subjects({ id }).threads.get({ query: { board } })` and its closed `entry` response. The current installed root callable omits both `query.board` and response `entry`, and the current Subject thread composition read has no Board association operand; keep creation unavailable until the existing owners publish those inputs, without inferring a Board.

Decision: preserve the complete originating Subject region URL, including its cursor and Realm/node context,
as the return target through admitted Board entry and sign-in.

Creation acknowledgement carries that original region inside the existing thread `boardReturn` address.
The thread reader offers a direct return to the region while its Board reading remains current; redirects,
replies and pagination retain the same address. Changing the originating URL retires the mounted community
reading until a new source observation arrives, even when its full-list destination stays the same.
