# Board decision history

The workbench exposes a board-only history entry beside its existing report and appeal queues. Opening it keeps the
selected board and the current queue's return position. Returning marks the active queue control as the next keyboard
focus target. The history cursor has its own opaque search parameter and does not replace or decode the queue cursor.

Content owns the private history page method, decision row meaning, ordering, cursor and current disclosure. The
delivered Web client currently has board report and appeal lists plus a point decision reader, but no private board
decision-history page method. The history view therefore reports unavailable, offers retry and returns to the same
queue. It does not invent an endpoint, render illustrative rows or rebuild history from report or appeal scans.

The native list, decision detail, current target reading, permitted case/appeal destinations, sparse continuation,
and stale/denied recovery remain pending the Content binding. When that binding is delivered, each page must retain
its opaque cursor, recheck disclosure, keep historical metadata when a current target is hidden, and retire private
results on board or session replacement. See [the Web Goal](../../../../docs/goals/web.md#ownership).
