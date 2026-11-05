# Home question selection lifetime

Global Home owns one question-choice page and one independently selected question. The generated directory reader
requests at most twenty entries and carries its opaque `next` value unchanged. A later page replaces the current
choice page; absence from that page does not mean the selected identity was lost. The generated point reader runs
only when a question is selected, restored or explicitly refreshed. It supplies the current label, grain, revision
and scale shown for the selector.

The receiver validates the installed `RatingQuestionView` shape, including its optional `realmId`, `meaning`,
`canonicalLabel`, `labelRevision` and `lifecycle` fields. Global Home omits Realm selection. A directory response
containing any Realm-scoped or retired entry is unavailable; an active Realm-scoped point is denied, and an explicitly retired
point is lost. Neither case clears the selected ID or chooses another question. Refresh retries that exact ID;
clear is the deliberate way to remove it. A directory failure alone does not establish selected identity loss.

The selected `ratingQuestionId` stays conjunctive with the current stream, kind and Space in each public or prepared
private mixed-feed request. Selection or observed question revision replacement retires the displayed feed rows
and cursor before the replacement read. Current directory and point requests use no-store responses and abortable
signals; generation checks suppress late results after another selection, viewer/session replacement or route
remount. Private feed and selected metadata stay outside the reusable Home query cache, hydration, URL and history
payload.

An operational directory failure retains the exact attempted cursor for an explicit retry. A stale or invalid
frontier requires the explicit restart action, which removes that cursor while retaining the selection. A valid
empty page with `next` remains page-local empty copy and offers deliberate continuation. No option hydration,
directory refill, question vote read, total, Realm discovery or all-question accumulation is added.

Back and Forward restore only the validated same-origin Home descriptor and re-read selected metadata. The descriptor
contains the current selectors and bounded frontier, never rows or credentials; a frontier that cannot be restored
requires explicit restart. Content cards keep their own citation provenance and historical scale. That historical
scale is not current selector metadata and cannot establish a selectable question.
