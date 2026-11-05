# Workbench loaded-report dismissal

A moderator on one selected board's submitted-reports page can dismiss at most twenty pending reports that are
actually loaded for the current reader and queue read generation. Selection is page-local: it never includes later
cursors, appeals, resolved cases, decision history or Global catalogue reports.

## Bound and exclusions

`workbenchLoadedReports` keeps pending board `Report` records from the private workbench read, capped at twenty.
WorkbenchCase public fields stay the triage projection; selection binds the original private `Report` including
`revisionId` and `resolvedAt`. Catalogue and appeal projections stay compatible and contribute no selectable rows.

Individually labelled row checkboxes, select-loaded, clear, a selected count, review, cancel and confirm compose the
existing `createReportsBulkAction` and `ReportsBulkControls`. Confirm names the board and the selected report IDs from
admitted native queue data. Command authority is never inferred from the rendered checkbox.

## Native dismissal and recovery

Confirm starts only the reviewed selection and runs the existing sequential per-report `POST /v1/reports/{id}:dismiss`
wrapper with current session and CSRF admission. Acknowledged successes remain acknowledged if a later report
conflicts, is denied, or has unknown delivery. The UI distinguishes unattempted, pending, dismissed, uncertain and
the actual native failure states. There is no batch endpoint, grant, queue engine or atomic rollback.

Retry sends only the original uncertain command with its immutable sender, credentials, key and operands. It never
starts remaining unattempted reports. Refresh keeps the existing unknown-command fence.

## Retirement and departure

A session, board, queue, page or reader replacement retires rows, selection, pending delivery and command authority.
A late response from a previous generation cannot publish results or continue the batch. Private report evidence and
selection never enter URLs, public metadata, diagnostics or persistent browser storage.

Case links, queue changes and page departure use `reportReviewNavigationContext` and the existing authoring-departure
boundary so retry authority is not silently discarded. Keyboard focus follows the delivered bulk controls through
selection, review, cancellation, uncertain retry and a fresh reading.

## Remaining binding

Dismissal reuses the installed report action wrapper. Content owns authorization, conflict and delivery. There is no
native bulk-dismiss method; Web does not invent one.
