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
Supplied immediate-parent context uses the existing public reply presenter. Missing counts remain unknown.

## Creation entry

A supplied Board travels as one exact `board` operand: the Subject page URL, the page read target, the composition
`subjectThreads` leaf and the native `/v1/subjects/{id}/threads` query all carry it. The native response answers with
its closed `entry`, decoded against the exact request it answers.

Decision: omission never selects a Board. Without one the entry is `not_selected`; the region offers no creation
control and makes no unavailable claim. The composer query is withheld. A row's Board link proves navigation only,
and no row, public link or empty region selects a creation Board. Subject review and discussion tabs follow the open
composition read, not account publicViews.

With a supplied Board each native state renders distinctly:

- `concealed`: the Board is not available for discussions about this work; no creation control.
- `unavailable`: the entry was not admitted; the region offers a retry of the same request.
- `current` with `allowed`: a link opens the composer with the Subject preset and the regional return.
- `current` with `sign-in`: sign-in returns to that same composer link, so the preset and return survive.
- `current` with `denied`: a denial notice and no control.

A ready response that lacks the explicit `entry` for a supplied Board, or answers for another Board or Subject, is
unavailable. Web keeps no Board, composer or thread authority: the composer and the thread command stay authoritative.

Preserve the complete originating Subject region URL, including its cursor and Realm/node context, as the return target through admitted Board entry and sign-in.

Creation acknowledgement carries that original region inside the existing thread `boardReturn` address.
The thread reader offers a direct return to the region while its Board reading remains current; redirects,
replies and pagination retain the same address. Changing the originating URL retires the mounted community
reading until a new source observation arrives, even when its full-list destination stays the same.

Decision: bind each mounted region to the shared browser observation and its exact composition query; use cached
external-store snapshots for standalone ReviewList/ThreadList mounts, returning that same cached value for client and
server reads until a subscription fires. Origin away is fenced by sourceCurrent/isCurrent, never by pairing that fence
into getSnapshot. Fetching, invalidation and equal successful source replacement retire the old reading before a queued
click can use it. Unrelated cache keys supply no authority. Standalone lists without a source observation key treat equal
descriptors as one visit.

The exact showcase `community.source.subjectId` / `community.board.id` pair is passed in the Subject URL as `board`.
An explicit Global Board read prepares the current viewer just like a Realm read; ordinary unselected public reads
remain anonymous. Navigation carries the supplied preset and regional request, while native Subject/Realm/Board/Access
observations remain in their readings and the composer obtains its own current admission. No authority is serialized
into sign-in or return addresses.

The seeded participation walk runs with
`bun --smol services/auth/scripts/dev-stack.ts walk -- bun --smol apps/web/scripts/vndb-seeded-journey.ts`.
It consumes the wrapper's published Subject/Board pair, follows actual author links, reads durable native effects
independently, and records the exact profile occurrence return. The walk owns its stack through the existing runner.

Decision: remote placement forwards the original launcher `GOAL_TASK_ID`, `GOAL_ATTEMPT` and
`GOAL_ACCEPTANCE_REQUIRES` into that walk command without rewriting recorded argv. Walk stacks cap OpenSearch at
128m without mmap, give Postgres 256m and OpenSearch 768m docker ceilings so volume file cache cannot fill the 6 GiB
run slice, and start Kernel with bun --smol and no `--watch`. Native Auth and Kernel stay up for persona/seed;
Web, Auth pages, Playwright and the one-worker pool start after seed, with issuer JWKS forwarded through native Auth
until the pages bind. Anonymous locale/viewport captures share one Chromium and own one context each; the signed-in
session is a second browser.
Concurrent remote-check walks share `/tmp/rezics-walk-stacks` and skip Docker-published or already-allocated slot ports.
The walk restores only the launcher's pinned archives onto `/srv/rezics-check/datasets/dumps/downloads`, then extracts
under the dump-cache lock on the host before the run slice so seed neither downloads a rotated VNDB file nor extracts
archives inside the 6 GiB memory cap. Incomplete archive transfers resume.
A restored extraction that matches the pin timestamp is reused without hashing the archive, and the pin marker is
written when missing. Sequential dump-table reads drop-behind and reclaim only inactive file pages. Walk and start
parents keep Kernel, Postgres and dump modules off their waiter graphs; walk setup skips Kernel catalogue composition
and the Auth host writes frontend bindings after assemble. The walk parent sets `REZICS_WALK_SMOL` so database/search/setup use bun --smol,
leftover Docker teardown never throws, and each walk/seed/browser phase asks the slice to reclaim inactive file cache.
Launch the walk itself with `bun --smol` so the parent module graph shares that heap.
`persona` reuses the host-written `seed.env` rather than assembling a second Auth+Kernel composition; issuer forwarding
keeps POST bodies so seed sign-in reaches native Auth. The walk `start` waiter runs under bun --smol and fails if Host or Kernel exits before the walk
signal, reprinting the stack log; Playwright and the Kernel client are imported only after seed.

Decision: existing summary-family, current-visit, entry-return and contribution-actions host tests pin this journey;
no extra stories.
