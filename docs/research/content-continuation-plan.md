# Next Content outcomes

This index selects product continuations from the existing authorities; it does not replace their contracts.
The handoffs live under `.temp/continuation/` for controller collection. Native delivery and interface delivery
remain separate where the interface requires an undelivered API.

## Published rating pages without history-sized reads

- **Authority:** [Rating public figures and cost](../../services/kernel/src/rating/README.md#cost).
- **Exact premise:** [Content road, E4 and CD6][road] names the retained indexed-page implementation, not a new
  aggregate redesign. The base query's `JOIN input` in
  [public-figures-page.sql](../../services/kernel/src/rating/public-figures-page.sql) still contains the known
  history-sized page plan; the Rating cost row explicitly records that defect. Retained commits `0e8b0c7deb`
  and `b658da7c` supply the indexed seek and its contract clarification. They are not in the reviewed dev history.
- **Consumer:** [public-figure.ts](../../services/kernel/src/rating/public-figure.ts) and its existing page
  callers; no Web rating presentation or identity-repair producer changes.
- **Acceptance:** fixed-size pages seek the selected partition/question/population and strict Subject cursor;
  examined work stays bounded as unrelated figures and vote history grow. Published revisions only, exact
  nullable/zero values, Subject ordering, empty/end pages and existing privacy semantics survive.
  Reuse [the native growth regression](../../services/kernel/test/rating/growth-figures-statistics.test.ts),
  including its intentionally failing page case; do not replace the native harness.
- **Handoff:** `content-next-01-published-rating-pages.md`, kind `claim`, no code dependency. Carry forward the
  retained implementation, adapting only what current native interfaces require. Performance's retained rating
  repair owner keeps its segment/identity work and the other Rating README sections.

## A catalogue moderator can finish a Subject report

- **Authority:** [Moderation scope](../scope.md), the [native Content contract](../../services/kernel/src/content/README.md#appeals),
  and the [Web catalogue-report contract](../../apps/web/README.md#catalogue-moderation-reports-moderationcatalogue).
- **Exact premise:** [Content road, F3 and CD2][road] explicitly separates native Subject reporting from the Web
  catalogue queue. Its retained native owner names `subject_report.list` and `catalogue_report.list`, using
  `GET /v1/subjects/{id}/reports` and `GET /v1/catalogue/reports`; it retains Subject admission and outcome delivery.
  The [submission adapter](../../apps/web/src/report/submit.server.ts) already accepts a Subject draft but casts
  through the older kernel target type. [Report reading](../../apps/web/src/moderation/reports-read.ts) still
  exposes board/thread/post sources only. A report receipt is reporter-only, not a moderator detail page.
- **Consumers:** extend the existing submission adapter and report action/result conventions; add the mounted
  catalogue queue and its reader under `apps/web/src/moderation/` and `apps/web/src/routes/moderation/`.
  Reuse the private reader lifetime and the existing reporter receipt. Keep the active content-action clipboard
  and appeal-resolution owners' regions intact.
- **Acceptance:** a readable Subject submission yields its real receipt; an admitted Global catalogue moderator
  can page reports newest-first, inspect supplied evidence separately from currently readable target content,
  dismiss a report or use the existing Semantic visibility/takedown action, and see confirmed results.
  Queue pages retain the native cursor and limit of at most 50; no board traversal or client-side refill.
  Viewer/credential retirement removes private evidence; denied reads are concealed, unavailable reads offer
  explicit retry, and an uncertain action keeps its original intent/key. Restoration never reopens an actioned
  report. No catalogue appeal or moderator workbench is introduced.
- **Handoff:** `content-next-02-catalogue-report-interface.md`, kind `interface`, after the existing native Subject
  report owner. The native owner keeps its handle; this is its single consumer handoff, replacing the need to
  emit another equivalent interface continuation. No second native producer is authorized.

Decision: retain existing native/Home owners, carry forward the indexed rating implementation, and use one private
catalogue queue at `/moderation/catalogue` with the existing reporter-only receipt route.

## Boundaries retained from the source review

| Source outcome                                                               | Decision for continuation selection                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed Home, Space selection and its original-read preparation                | Complete overlap with **The mixed Home, end to end, now**, its preserved Space-scoped source branch, and the held original-post reader. Keep those handles; do not create another feed, Source or preparation producer. The held **Resolve Home post selections outside the first page** remains its consumer.       |
| Question-selected Home and richer discussion rows                            | Keep the existing activation and Home delivery. Native witness qualification and author/excerpt summaries are already represented by `53fb1f6f69`, `ec262f95af` and `f7d7695ddc`; they do not justify a replacement producer. The remaining native selection gap belongs to Home.                                    |
| Thread atomicity, terminal media ingestion, authored edition history         | Keep the retained **Commit thread creation and revision atomically**, **Finish media ingestion with one terminal result** and **Retain the correct authored edition history** owners, including stopped work.                                                                                                        |
| Other Content road fixes                                                     | Preserve landed work: exact-revision retirement, post location, uncertain reactions, media collection, document image recovery, Realm discovery/setup/appearance, author erasure, viewer actions and Inbox refresh. `git log dev` contains their deliveries; old queued/stopped labels are not new product premises. |
| Report/appeal transition repairs and thread subject navigation               | Keep the dispatched handles and their retained source; related-subject presentation alone is not evidence of a missing native journey. Do not manufacture replacement work from old cancellation labels.                                                                                                             |
| [Quality round three][quality], shared-family slices 6 and 9 and scoped Home | Its Home/producer/retirement leads explicitly retain existing owners. The missing-author/excerpt premise is superseded by the native summary delivery; unavailable visual evidence does not authorize a new producer or proof task.                                                                                  |
| [Dev health][health], failure classes D6–D9 and L1                           | Locale parity, recording maps, shared item invariants, DocumentBody identity and lint ownership remain with their existing Web/service owners. The report establishes no additional unowned Content product outcome.                                                                                                 |
| [Scope](../scope.md) and [Content decisions C3–C6][decisions]                | Keep row ratings, public Collections/reviews/Spaces in discovery, pins, slow mode, watch, mute/block and a moderator workbench outside these handoffs. Reviews do not feed imported source statistics. Main promotion/proof work remains parked.                                                                     |

## Sources reviewed

The named [Content road][road] (tracks A–H and CD1–CD10), [convergence decisions][decisions] (X1–X6 and Content),
[quality backlog][quality] (source dispositions, shared-family/scoped Home and owner ordering), [dev health][health]
(failure classes), and [scope](../scope.md) were compared with `git log dev`, the Goal task store and Content backlog.
The comparison included all retained active/held/stopped Content owners, adjacent moderation/rating owners, and the
preserved Home source. The source plan at `0e8b0c7deb`, Rating query/cost contract, Content summaries, Web report
submission/readers/receipt and moderation contracts were inspected directly. The older
[report-to-appeal research](content-moderation-appeals-design.md#amendments-to-adopt-and-product-slices) supplies the
existing receipt/retry boundary; the later Content road owns additive Subject reporting. No external design survey
or reference implementation is needed for these already decided outcomes.

[road]: /home/edge/projects/rezics/rezics-next/.temp/goal/supermanager/road/content.md
[decisions]: /home/edge/projects/rezics/rezics-next/.temp/goal/supermanager/road/decisions.md
[health]: /home/edge/projects/rezics/rezics-next/.temp/goal/supermanager/dev-health-20261102.md
[quality]: quality-round3-backlog.md
