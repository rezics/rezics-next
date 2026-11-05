# Board page watch control

The Board header reads the private no-store `GET /v1/boards/{id}/watch/page` companion for the current signed-in
account. The public Board transfer, cache key, sorting, cursor and discussion return stay unchanged. A signed-out
reader gets the existing sign-in prompt with the current Board URL as its return target. Missing session identity,
denied advice and unavailable reads keep the feed readable and remove watch commands.

Commands use the existing `PUT /v1/boards/{id}/watch` CAS with the companion's exact watch revision. Each command
freezes the Board, account, requested boolean, expected revision, CSRF token and idempotency key for its lifetime.
An uncertain result offers the same command for retry and a separate current-state inspection. A revision conflict
requires an explicit inspection before another command. A successful receipt remains a separate acknowledgement;
the control then reads current state again and never derives current authority from the receipt.

The control belongs to the mounted `BoardPageCaller` visit. It checks that visit before dispatch and before accepting
late results; route, session, Board or credential replacement retires its read and command authority. Server functions
verify that the request's current account matches the captured account before calling the mounted native route.
`request.ts` contains the small consumer type seam for `board.watch_page` until the existing publication owner emits
installed route typing; it does not generate a parallel client.

Decision: a successful watch receipt triggers a fresh companion read while the receipt remains a separate acknowledgement; a conflict requires explicit status inspection.

The focused stories cover long titles, watching and unwatched states, pending and unknown outcomes, stale revisions,
and signed-out return behavior at phone 390 and desktop 1280 widths. Action names remain visible button text, and the
control restores keyboard focus after an in-place pending transition.
