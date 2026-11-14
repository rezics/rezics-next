# Home question selection lifetime

Global Home owns one question-choice page and one independently selected question. The generated directory reader
requests at most twenty entries and carries its opaque `next` value unchanged. A later page replaces the current
choice page; absence from that page does not mean the selected identity was lost. The generated point reader runs
only when a question is selected, restored or explicitly refreshed. It supplies the current label, grain, revision
and scale shown for the selector.

The consumer uses the normally generated directory and point routes without handwritten declarations, casts or
generator changes. Labels use native question text; grain, revision, scale and all control/error text have all eight
launch-locale messages. The initial anonymous Home preload remains unselected.

The receiver validates the installed `RatingQuestionView` shape, including its optional `realmId`, `meaning`,
`canonicalLabel`, `labelRevision` and `lifecycle` fields. Global Home omits Realm selection. A directory response
containing any Realm-scoped or retired entry is unavailable; an active Realm-scoped point is denied, and an explicitly retired
point is lost. Neither case clears the selected ID or chooses another question. Refresh retries that exact ID;
clear is the deliberate way to remove it. A directory failure alone does not establish selected identity loss.

The selector shows the label only; its grain, scale and revision stay in the closed information disclosure. When a
ready selection's mixed feed returns `dependency_unavailable`, the question control explains that refusal (the generic
Home feed message is suppressed) and Refresh or Clear recover it.

The selected `ratingQuestionId` stays conjunctive with the current stream, kind and Space in each public or prepared
private mixed-feed request. Selection or observed question revision replacement retires the displayed feed rows
and cursor before the replacement read. Current directory and point requests use no-store responses and abortable
signals; generation checks suppress late results after another selection, viewer/session replacement or route
remount. Private feed and selected metadata stay outside the reusable Home query cache, hydration, URL and history
payload.
The route's locale, subject and CSRF remount fences those abortable requests as well.

An operational directory failure retains the exact attempted cursor for an explicit retry. A stale or invalid
frontier requires the explicit restart action, which removes that cursor while retaining the selection. A valid
empty page with `next` remains page-local empty copy and offers deliberate continuation. No option hydration,
directory refill, question vote read, total, Realm discovery or all-question accumulation is added.

Back and Forward restore only the validated same-origin Home descriptor and re-read selected metadata. The descriptor
contains the current selectors and bounded frontier, never rows or credentials; a frontier that cannot be restored
requires explicit restart. Content cards keep their own citation provenance and historical scale. That historical
scale is not current selector metadata and cannot establish a selectable question.

## Evidence boundary

The authored default-route composition cases cover question propagation, bounded paging, conjunctive
kind/Space/question selection, sparse continuation, revision/lost identity and stale request isolation. They were
not executed for that consumer source delivery. The retained PageStory IDs
`pages-discovery-home--question-selection`, `pages-discovery-home--question-choices-unavailable` and
`pages-discovery-home--question-choices-next-page` use illustrative native-format consumer envelopes. Additional
sparse continuation, same-input retry, explicit restart and selected-retirement stories retain their existing IDs;
none is a native recording or visual proof. The generated directory and point receiving do not establish native
question predicates, complete default Source coverage, original acceptance, visual review or public delivery.
