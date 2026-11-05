# Workbench triage summaries

The bounded workbench queue presents native report and appeal summaries so a moderator can scan a page, inspect
disclosed details, close them, and continue the same queue. Presentation consumes only `WorkbenchCase` and the current
scoped read identity (`readKey` + `generation`). It does not fetch targets, hydrate a report, rank or filter rows, or
invent queue counts.

## Rendered fields

Each row keeps the existing selected-case link (`workbenchCaseHref`) unchanged. `WorkbenchTriageSummary` is the
non-link scan body other owners can mount beside their own links or history chrome. Compact phone reading stacks type,
target kind, reason, resolution, time and a two-line optional evidence or statement. Open details use a two-column
definition list from `xl` (1280px) and a single column below that.

| Field              | Report                                                                                         | Appeal                                        | Missing value                  |
| ------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ |
| Case type          | Report                                                                                         | Appeal                                        | —                              |
| Target type        | board / thread / post / Subject                                                                | same                                          | —                              |
| Target ID          | native                                                                                         | native                                        | —                              |
| Created            | UTC readable time plus timezone name                                                           | same                                          | Time unavailable               |
| Exact native time  | `createdAt` string in details                                                                  | same                                          | omitted when unreadable        |
| Reason             | localized `spam` / `illegal` / `inappropriate` / `off_topic` / `other`, else the supplied text | omitted                                       | Reason unavailable             |
| Resolution         | Actioned, Dismissed, or Pending review when `outcome` is null                                  | omitted; never relabelled as a report outcome | Resolution outcome unavailable |
| Report / appeal ID | report ID                                                                                      | appeal ID                                     | —                              |
| Decision ID        | omitted                                                                                        | native decision reference                     | Decision reference unavailable |
| Evidence           | submitted text                                                                                 | omitted                                       | No submitted evidence          |
| Appeal statement   | omitted                                                                                        | submitted text                                | No appeal statement            |

Evidence and statements render as safe text (`whitespace-pre-wrap`, overflow wrap). They never enter public metadata,
`href`, `title` or query strings. Native case order and the page bound stay with the queue reader.

## Report-time versus current target

Queue fields are the native list record: report-time reason, evidence, creation time and the report's own resolution.
They do not prove that the target is currently readable. Current target content and decision actions stay on the
existing selected-case interface. Details state that distinction next to the disclosed fields.

Decision: pending reports show "Pending review" for a null outcome; that is an honest absence of resolution, not a
fabricated native decision.

## Private retirement

Open details bind to the current read identity. Scope, queue, cursor, reader or generation replacement remounts the
list, closes every details panel, and ignores late close/focus callbacks. Empty, denied and unavailable pages do not
render cases, so prior evidence and statements cannot remain. Inspect and Close are 44px keyboard targets. Escape
closes the panel that contains focus. Closing returns keyboard focus to the originating inspect control when that
identity is still current. Copy exists in all eight launch locales.

The selected-case route still owns `workbenchCaseHref`, stable case links and return snapshots. History remains a
separate board entry. This module does not rewrite the queue decoder, source readers or decision controls.
