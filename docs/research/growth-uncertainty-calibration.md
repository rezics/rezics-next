# Growth uncertainty calibration

## Method

| Input | Runs | Files with profiles | Check profile lines |
| --- | --- | ---: | ---: |
| Calibration | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile, calibration-5.profile | 38 | 345 |
| Coverage | coverage.profile | 201 | 528 |

| Step | Rule |
| --- | --- |
| Reference | Per check and scale, median of the run medians. |
| Noise need | max(absolute run-median deviation, half the within-run range). |
| Fit | Search relative E from 0% to 100% in 1% steps; choose the least average max(absolute E, relative E × reference) covering the requested share of calibration points. |
| Held-out | Leave out each check run, refit E, and measure covered points. |
| Coverage run | Classify each coverage profile separately under both calibrated E values. |

## Experiment sample and run records

| Design item | Value |
| --- | --- |
| Base revision | e688bfc40704aba4c2116290d4f1fe5a34510ab0 |
| Calibration sample | Fixed stratified set of 40 growth test files; all five runs used the same paths. |
| Coverage input | All 226 files returned by git grep -l 'checkGrowth(' services/kernel/test, passed in one invocation. |
| Remote concurrency | At most two remote-check requests were in flight. Actual measurement command intervals did not overlap; each run held one slot. |
| Load measure | First field of /proc/loadavg recorded at remote command start. |
| Classification reference | [growth-classification.md](growth-classification.md), policy items 3, 5 and 6. |
| Calibration profiles | 38 sample files produced 345 complete profile lines across five runs; two sample files produced no line in any run. |
| Coverage profiles | 201 files produced 528 profile lines; the remaining 25 invoked files produced no profile line. |
| Check results | All six invocations exited 1 on the unchanged base. Runs 1 and 2 include AccessUnavailableError: deadline; runs 4 and 5 report kernel test failures in 7 and 6 files. Profile lines were retained from nonzero exits. |
| Estimator | Per-check, per-scale median of run medians; noise need is the larger of between-run median deviation and half the within-run range. Relative E is searched from 0% to 100% in 1% steps, minimizing mean max(absolute E, relative E × reference) while meeting requested coverage. Held-out coverage leaves out each check run and refits E. |
| Detectable-slope base | For each metric, the median of the smallest-scale values across eligible calibration checks. |

| Owner module | Files | Sample paths |
| --- | ---: | --- |
| access | 4 | test/access/growth-agent-page-lookup.test.ts, test/access/growth-durable-initiator.test.ts, test/access/growth-organization-creation.test.ts, test/access/growth-write-rate-chunk.test.ts |
| commerce | 3 | test/commerce/growth-orders.test.ts, test/commerce/growth-payouts.test.ts, test/commerce/http.test.ts |
| community | 4 | test/community/growth-ban.test.ts, test/community/growth-membership.test.ts, test/community/growth-space-address.test.ts, test/community/participation.test.ts |
| content | 4 | test/content/board-projection.test.ts, test/content/growth-sitemap.test.ts, test/content/moderation.test.ts, test/content/source-fence-governance-http.test.ts |
| kernel | 4 | test/anonymous-receipts-growth.test.ts, test/growth-command.test.ts, test/growth-events.test.ts, test/relay-effects.test.ts |
| library | 4 | test/library/entry-store.test.ts, test/library/growth-maintenance-session-page.test.ts, test/library/growth-sessions.test.ts, test/library/shelf-page-created-asc-growth.test.ts |
| presentation | 3 | test/presentation/agent-read-kinds.test.ts, test/presentation/growth-profiles.test.ts, test/presentation/page-read-kinds.test.ts |
| rating | 3 | test/rating/growth-aggregate.test.ts, test/rating/growth-segment-job.test.ts, test/rating/subject-merge.test.ts |
| search | 3 | test/search/expansion.test.ts, test/search/growth-indexing.test.ts, test/search/growth-query.test.ts |
| semantic | 4 | test/semantic/context-relations.test.ts, test/semantic/growth-inverse-pages.test.ts, test/semantic/growth-relations.test.ts, test/semantic/growth-subjects.test.ts |
| support | 4 | test/support/growth-capture.test.ts, test/support/growth-load.test.ts, test/support/growth-scale-cap.test.ts, test/support/growth-warmup.test.ts |
| Eligibility | — | Imports and work had fewer than three eligible growth test files and were not sampled. |

| Run | Host | Host start (UTC) | Slots | Load at start | Slot wait | Command time | Total wall | Check exit | Valid profile lines |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| calibration-1 | b | 2026-10-27 23:42:01 | 1 | 4.54 | 2h36m11.567s | 5m02.365s | 2h41m50.886s | 1 | 17 |
| calibration-2 | b | 2026-10-27 21:25:17 | 1 | 6.96 | 18m42.396s | 6m48.687s | 26m51.876s | 1 | 17 |
| calibration-3 | a | 2026-10-28 04:12:03 | 1 | 4.88 | 6h38m15.565s | 3m23.981s | 6h42m21.403s | 1 | 18 |
| calibration-4 | a | 2026-10-28 04:30:47 | 1 | 14.26 | 4h42m53.202s | 3m55.891s | 4h47m21.378s | 1 | 146 |
| calibration-5 | b | 2026-10-28 04:39:25 | 1 | 9.84 | 21m26.069s | 4m50.053s | 26m58.321s | 1 | 147 |
| coverage | a | 2026-10-28 04:57:21 | 1 | 4.81 | 21m52.607s | 20m22.580s | 42m58.235s | 1 | 528 |

## Profile files without calibration or coverage lines

| Scope | File |
| --- | --- |
| Calibration sample, no line in any run | test/access/growth-organization-creation.test.ts |
| Calibration sample, no line in any run | test/support/growth-scale-cap.test.ts |
| Coverage, no profile line | test/access/growth-native-membership-work.test.ts |
| Coverage, no profile line | test/access/growth-organization-creation.test.ts |
| Coverage, no profile line | test/access/growth-recovery-completion.test.ts |
| Coverage, no profile line | test/access/growth-workflow-approvals.test.ts |
| Coverage, no profile line | test/community/own-realms.test.ts |
| Coverage, no profile line | test/content/cover-reference.test.ts |
| Coverage, no profile line | test/content/disclosure-outcomes.test.ts |
| Coverage, no profile line | test/content/media-moderation-http.test.ts |
| Coverage, no profile line | test/content/media-moderation.test.ts |
| Coverage, no profile line | test/content/media-outcomes.test.ts |
| Coverage, no profile line | test/content/reports.test.ts |
| Coverage, no profile line | test/content/source-fence-governance-http.test.ts |
| Coverage, no profile line | test/content/subject-reaction-merge.test.ts |
| Coverage, no profile line | test/content/thread-outcomes.test.ts |
| Coverage, no profile line | test/library/collections.test.ts |
| Coverage, no profile line | test/library/growth-maintenance-history-page.test.ts |
| Coverage, no profile line | test/library/growth-members.test.ts |
| Coverage, no profile line | test/library/growth-preparation-native-reader.test.ts |
| Coverage, no profile line | test/rating/growth-votes.test.ts |
| Coverage, no profile line | test/semantic/expansion.test.ts |
| Coverage, no profile line | test/semantic/growth-relation-facet-source.test.ts |
| Coverage, no profile line | test/semantic/growth-subject-pages.test.ts |
| Coverage, no profile line | test/semantic/subject-summaries.test.ts |
| Coverage, no profile line | test/support/growth-profile.test.ts |
| Coverage, no profile line | test/support/growth-scale-cap.test.ts |

## Incomplete calibration profile tails excluded from the fit

| Run | Capture size | Incomplete line | File | Check |
| --- | ---: | --- | --- | --- |
| calibration-1 | 65,537 bytes | 2,161 characters | test/commerce/growth-orders.test.ts | Order creation stays within its bound as o grows |
| calibration-2 | 65,537 bytes | 4,549 characters | test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows |
| calibration-3 | 65,537 bytes | 366 characters | test/community/growth-membership.test.ts | Realm membership publish, terminal reads and role proofs |

## Held-out coverage

| Metric | Requested coverage | Absolute E | Relative E | Exact | Held-out coverage |
| --- | ---: | ---: | ---: | :---: | ---: |
| rows | 100% | 22 | 0% | no | 100% |
| rows | 99% | 22 | 0% | no | 100% |
| blocks | 100% | 9 | 3% | no | 100% |
| blocks | 99% | 8.5 | 3% | no | 98.667% |
| statements | 100% | 0 | 0% | yes | 100% |
| statements | 99% | 0 | 0% | yes | 100% |

## Detectable slope

| Metric | Coverage | Bound | Scales | Base | Detectable slope | Smallest extra work or scan detectable |
| --- | ---: | --- | --- | ---: | ---: | --- |
| rows | 100% | constant | 1, 8, 64 | 9 | 0.69841 | About 0.69841 extra rows visited per input row (base 9). |
| rows | 100% | constant | 1, 4, 16, 64, 256 | 9 | 0.17255 | About 0.17255 extra rows visited per input row (base 9). |
| rows | 100% | logarithmic | 1, 8, 64 | 9 | 1.5306 | About 1.5306 extra rows visited per input row (base 9). |
| rows | 100% | logarithmic | 1, 4, 16, 64, 256 | 9 | 0.31774 | About 0.31774 extra rows visited per input row (base 9). |
| rows | 99% | constant | 1, 8, 64 | 9 | 0.69841 | About 0.69841 extra rows visited per input row (base 9). |
| rows | 99% | constant | 1, 4, 16, 64, 256 | 9 | 0.17255 | About 0.17255 extra rows visited per input row (base 9). |
| rows | 99% | logarithmic | 1, 8, 64 | 9 | 1.5306 | About 1.5306 extra rows visited per input row (base 9). |
| rows | 99% | logarithmic | 1, 4, 16, 64, 256 | 9 | 0.31774 | About 0.31774 extra rows visited per input row (base 9). |
| blocks | 100% | constant | 1, 8, 64 | 73 | 0.28571 | About 0.28571 extra buffer blocks touched per input row (base 73). |
| blocks | 100% | constant | 1, 4, 16, 64, 256 | 73 | 0.070588 | About 0.070588 extra buffer blocks touched per input row (base 73). |
| blocks | 100% | logarithmic | 1, 8, 64 | 73 | 0.73469 | About 0.73469 extra buffer blocks touched per input row (base 73). |
| blocks | 100% | logarithmic | 1, 4, 16, 64, 256 | 73 | 0.14035 | About 0.14035 extra buffer blocks touched per input row (base 73). |
| blocks | 99% | constant | 1, 8, 64 | 73 | 0.26984 | About 0.26984 extra buffer blocks touched per input row (base 73). |
| blocks | 99% | constant | 1, 4, 16, 64, 256 | 73 | 0.066667 | About 0.066667 extra buffer blocks touched per input row (base 73). |
| blocks | 99% | logarithmic | 1, 8, 64 | 73 | 0.69388 | About 0.69388 extra buffer blocks touched per input row (base 73). |
| blocks | 99% | logarithmic | 1, 4, 16, 64, 256 | 73 | 0.13255 | About 0.13255 extra buffer blocks touched per input row (base 73). |
| statements | 100% | constant | 1, 8, 64 | 7 | 4.018e-16 | About 4.018e-16 extra SQL statements per input row (base 7). |
| statements | 100% | constant | 1, 4, 16, 64, 256 | 7 | 9.9267e-17 | About 9.9267e-17 extra SQL statements per input row (base 7). |
| statements | 100% | logarithmic | 1, 8, 64 | 7 | 4.018e-16 | About 4.018e-16 extra SQL statements per input row (base 7). |
| statements | 100% | logarithmic | 1, 4, 16, 64, 256 | 7 | 9.9267e-17 | About 9.9267e-17 extra SQL statements per input row (base 7). |
| statements | 99% | constant | 1, 8, 64 | 7 | 4.018e-16 | About 4.018e-16 extra SQL statements per input row (base 7). |
| statements | 99% | constant | 1, 4, 16, 64, 256 | 7 | 9.9267e-17 | About 9.9267e-17 extra SQL statements per input row (base 7). |
| statements | 99% | logarithmic | 1, 8, 64 | 7 | 4.018e-16 | About 4.018e-16 extra SQL statements per input row (base 7). |
| statements | 99% | logarithmic | 1, 4, 16, 64, 256 | 7 | 9.9267e-17 | About 9.9267e-17 extra SQL statements per input row (base 7). |

## Checks rejected or inconclusive under calibrated E

| Coverage | Metric | File | Check | Owner module | Outcome | Runs |
| ---: | --- | --- | --- | --- | --- | --- |
| 100% | rows | test/access/growth-agent-page-lookup.test.ts | agent page lookup stays within its bound as unrelated verified subjects grow | access | violation | coverage.profile |
| 100% | rows | test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access | violation | coverage.profile |
| 100% | rows | test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | access | violation | coverage.profile |
| 100% | rows | test/access/growth-governance-reach.test.ts | platform governance reach | access | violation | coverage.profile |
| 100% | rows | test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access | violation | coverage.profile |
| 100% | rows | test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | late fence page: unrelated accounts | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | first fence page: completed and pending history | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | late fence page: completed and pending history | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-reinstatement.test.ts | first operator reinstatement page | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | total operator fence fanout | access | violation | coverage.profile |
| 100% | rows | test/access/growth-organization-close.test.ts | organization cleanup step | access | violation | coverage.profile |
| 100% | rows | test/commerce/http.test.ts | order creation | commerce | violation | coverage.profile |
| 100% | rows | test/content/author-item-index.test.ts | author item index | content | violation | coverage.profile |
| 100% | rows | test/content/authored-field-erasure.test.ts | authored document erasure | content | violation | coverage.profile |
| 100% | rows | test/content/authored-document-http.test.ts | authored document read | content | violation | coverage.profile |
| 100% | rows | test/content/board-rank-partition.test.ts | partition board rank refresh | content | violation | coverage.profile |
| 100% | rows | test/content/document-http.test.ts | Native imported document HTTP disclosure | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Media reserve | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Media complete | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Media reservation and state reads | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Post media claim | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Cover reference read and claim | content | violation | coverage.profile |
| 100% | rows | test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Image publication | content | violation | coverage.profile |
| 100% | rows | test/content/growth-sitemap.test.ts | Sitemap boards page, protected Realm content | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Collection selection | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Collection per object | content | violation | coverage.profile |
| 100% | rows | test/content/growth-media.test.ts | Imported image processing | content | violation | coverage.profile |
| 100% | rows | test/content/imported-fields.test.ts | imported changed documents | content | violation | coverage.profile |
| 100% | rows | test/content/media-http.test.ts | media exact variant and current independent container chain decision | content | violation | coverage.profile |
| 100% | rows | test/content/media-import-http.test.ts | HTTP native media import and protected point poll | content | violation | coverage.profile |
| 100% | rows | test/content/media-import-job.test.ts | exact imported media work | content | violation | coverage.profile |
| 100% | rows | test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | content | insufficient-evidence | coverage.profile |
| 100% | rows | test/content/neighbourhood-storage.test.ts | bounded neighbourhood probes | content | violation | coverage.profile |
| 100% | rows | test/content/neighbourhood-storage.test.ts | hot partition scan | content | violation | coverage.profile |
| 100% | rows | test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | content | violation | coverage.profile |
| 100% | rows | test/content/operation-storage.test.ts | operation identity and author endpoints | content | violation | coverage.profile |
| 100% | rows | test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | content | violation | coverage.profile |
| 100% | rows | test/content/operations.test.ts | author erasure initiation and status | content | violation | coverage.profile |
| 100% | rows | test/content/read.test.ts | current board disclosure | content | violation | coverage.profile |
| 100% | rows | test/content/reports-http.test.ts | report HTTP admission and create | content | violation | coverage.profile |
| 100% | rows | test/content/source-fence-storage.test.ts | exact source fence batch | content | insufficient-evidence | coverage.profile |
| 100% | rows | test/growth-command.test.ts | New command | kernel | violation | coverage.profile |
| 100% | rows | test/rating/growth-aggregate.test.ts | rating aggregate apply | rating | violation | coverage.profile |
| 100% | rows | test/rating/voter-realms.test.ts | voter Realm membership | rating | violation | coverage.profile |
| 100% | rows | test/relay-effects.test.ts | effects relay discovery | kernel | violation | coverage.profile |
| 100% | rows | test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | semantic | violation | coverage.profile |
| 100% | rows | test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic | violation | coverage.profile |
| 100% | rows | test/support/growth-report.test.ts | growth report evidence | support | violation | coverage.profile |
| 100% | rows | test/support/growth-rule.test.ts | series constant violation | support | violation | coverage.profile |
| 100% | rows | test/support/growth-rule.test.ts | series uncertain repetitions | support | violation | coverage.profile |
| 100% | rows | test/support/growth.test.ts | growth table scan [occurrence 2] | support | violation | coverage.profile |
| 100% | rows | test/support/growth.test.ts | growth table scan [occurrence 3] | support | violation | coverage.profile |
| 100% | rows | test/support/growth.test.ts | constant write | support | violation | coverage.profile |
| 100% | rows | test/work/growth-retention.test.ts | workflow retention batch | work | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts [occurrence 2] | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | late fence page: unrelated accounts [occurrence 2] | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | first fence page: completed and pending history [occurrence 2] | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | late fence page: completed and pending history [occurrence 2] | access | violation | coverage.profile |
| 100% | rows | test/access/growth-operator-fencing.test.ts | total operator fence fanout [occurrence 2] | access | violation | coverage.profile |
| 100% | rows | test/rating/voter-realms.test.ts | voter Realm membership [occurrence 2] | rating | violation | coverage.profile |
| 99% | rows | test/access/growth-agent-page-lookup.test.ts | agent page lookup stays within its bound as unrelated verified subjects grow | access | violation | coverage.profile |
| 99% | rows | test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access | violation | coverage.profile |
| 99% | rows | test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | access | violation | coverage.profile |
| 99% | rows | test/access/growth-governance-reach.test.ts | platform governance reach | access | violation | coverage.profile |
| 99% | rows | test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access | violation | coverage.profile |
| 99% | rows | test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | late fence page: unrelated accounts | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | first fence page: completed and pending history | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | late fence page: completed and pending history | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-reinstatement.test.ts | first operator reinstatement page | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | total operator fence fanout | access | violation | coverage.profile |
| 99% | rows | test/access/growth-organization-close.test.ts | organization cleanup step | access | violation | coverage.profile |
| 99% | rows | test/commerce/http.test.ts | order creation | commerce | violation | coverage.profile |
| 99% | rows | test/content/author-item-index.test.ts | author item index | content | violation | coverage.profile |
| 99% | rows | test/content/authored-field-erasure.test.ts | authored document erasure | content | violation | coverage.profile |
| 99% | rows | test/content/authored-document-http.test.ts | authored document read | content | violation | coverage.profile |
| 99% | rows | test/content/board-rank-partition.test.ts | partition board rank refresh | content | violation | coverage.profile |
| 99% | rows | test/content/document-http.test.ts | Native imported document HTTP disclosure | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Media reserve | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Media complete | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Media reservation and state reads | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Post media claim | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Cover reference read and claim | content | violation | coverage.profile |
| 99% | rows | test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Image publication | content | violation | coverage.profile |
| 99% | rows | test/content/growth-sitemap.test.ts | Sitemap boards page, protected Realm content | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Collection selection | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Collection per object | content | violation | coverage.profile |
| 99% | rows | test/content/growth-media.test.ts | Imported image processing | content | violation | coverage.profile |
| 99% | rows | test/content/imported-fields.test.ts | imported changed documents | content | violation | coverage.profile |
| 99% | rows | test/content/media-http.test.ts | media exact variant and current independent container chain decision | content | violation | coverage.profile |
| 99% | rows | test/content/media-import-http.test.ts | HTTP native media import and protected point poll | content | violation | coverage.profile |
| 99% | rows | test/content/media-import-job.test.ts | exact imported media work | content | violation | coverage.profile |
| 99% | rows | test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | content | insufficient-evidence | coverage.profile |
| 99% | rows | test/content/neighbourhood-storage.test.ts | bounded neighbourhood probes | content | violation | coverage.profile |
| 99% | rows | test/content/neighbourhood-storage.test.ts | hot partition scan | content | violation | coverage.profile |
| 99% | rows | test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | content | violation | coverage.profile |
| 99% | rows | test/content/operation-storage.test.ts | operation identity and author endpoints | content | violation | coverage.profile |
| 99% | rows | test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | content | violation | coverage.profile |
| 99% | rows | test/content/operations.test.ts | author erasure initiation and status | content | violation | coverage.profile |
| 99% | rows | test/content/read.test.ts | current board disclosure | content | violation | coverage.profile |
| 99% | rows | test/content/reports-http.test.ts | report HTTP admission and create | content | violation | coverage.profile |
| 99% | rows | test/content/source-fence-storage.test.ts | exact source fence batch | content | insufficient-evidence | coverage.profile |
| 99% | rows | test/growth-command.test.ts | New command | kernel | violation | coverage.profile |
| 99% | rows | test/rating/growth-aggregate.test.ts | rating aggregate apply | rating | violation | coverage.profile |
| 99% | rows | test/rating/voter-realms.test.ts | voter Realm membership | rating | violation | coverage.profile |
| 99% | rows | test/relay-effects.test.ts | effects relay discovery | kernel | violation | coverage.profile |
| 99% | rows | test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | semantic | violation | coverage.profile |
| 99% | rows | test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic | violation | coverage.profile |
| 99% | rows | test/support/growth-report.test.ts | growth report evidence | support | violation | coverage.profile |
| 99% | rows | test/support/growth-rule.test.ts | series constant violation | support | violation | coverage.profile |
| 99% | rows | test/support/growth-rule.test.ts | series uncertain repetitions | support | violation | coverage.profile |
| 99% | rows | test/support/growth.test.ts | growth table scan [occurrence 2] | support | violation | coverage.profile |
| 99% | rows | test/support/growth.test.ts | growth table scan [occurrence 3] | support | violation | coverage.profile |
| 99% | rows | test/support/growth.test.ts | constant write | support | violation | coverage.profile |
| 99% | rows | test/work/growth-retention.test.ts | workflow retention batch | work | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts [occurrence 2] | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | late fence page: unrelated accounts [occurrence 2] | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | first fence page: completed and pending history [occurrence 2] | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | late fence page: completed and pending history [occurrence 2] | access | violation | coverage.profile |
| 99% | rows | test/access/growth-operator-fencing.test.ts | total operator fence fanout [occurrence 2] | access | violation | coverage.profile |
| 99% | rows | test/rating/voter-realms.test.ts | voter Realm membership [occurrence 2] | rating | violation | coverage.profile |
| 100% | blocks | test/access/growth-account-realms.test.ts | account Realm page | access | violation | coverage.profile |
| 100% | blocks | test/access/growth-agent-pages.test.ts | public change time stays bounded as accounts grow | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/growth-auth-barriers.test.ts | native Auth barriers | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/growth-commands.test.ts | Standing parent installation stays within its bound as Gt grows | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/growth-evaluator.test.ts | actor evaluator G | access | violation | coverage.profile |
| 100% | blocks | test/access/growth-commands.test.ts | Account and organization creation stays within its bound as A grows | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/growth-operator-fencing.test.ts | total operator fence fanout | access | violation | coverage.profile |
| 100% | blocks | test/access/growth-public-identity-read.test.ts | public identity read | access | violation | coverage.profile |
| 100% | blocks | test/access/growth-rate-tier.test.ts | account rate tier | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/growth-commands.test.ts | Tombstone erasure stays within its bound as m grows | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access | violation | coverage.profile |
| 100% | blocks | test/access/membership-work-growth.test.ts | durable membership reserve | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/access/membership-work-growth.test.ts | durable membership join | access | insufficient-evidence | coverage.profile |
| 100% | blocks | test/community/growth-ban.test.ts | Realm ban, unban and list | community | insufficient-evidence | coverage.profile |
| 100% | blocks | test/community/growth-realm.test.ts | community Realm update | community | insufficient-evidence | coverage.profile |
| 100% | blocks | test/community/participation.test.ts | Realm participation | community | violation | coverage.profile |
| 100% | blocks | test/community/growth-join.test.ts | Join a Realm | community | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/author-post-delete.test.ts | Author post delete | content | violation | coverage.profile |
| 100% | blocks | test/content/board-projection.test.ts | board candidate upsert and fixed keyset page | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/board-hot-http.test.ts | Hot board page | content | violation | coverage.profile |
| 100% | blocks | test/content/cover-metadata.test.ts | batched cover reference | content | violation | coverage.profile |
| 100% | blocks | test/community/growth-join.test.ts | Leave a Realm | community | violation | coverage.profile |
| 100% | blocks | test/content/erasure-initiation-provenance.test.ts | author erasure initiation provenance | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/growth-media-erase.test.ts | Erase media | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/growth-reactions.test.ts | Subject reaction relay | content | violation | coverage.profile |
| 100% | blocks | test/content/board-hot-refresh.test.ts | one hot rank refresh batch | content | violation | coverage.profile |
| 100% | blocks | test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | content | violation | coverage.profile |
| 100% | blocks | test/content/growth-sitemap.test.ts | Sitemap threads page, listed items | content | violation | coverage.profile |
| 100% | blocks | test/content/growth-threads.test.ts | Review creation with vote citation | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/imported-fields.test.ts | imported changed documents | content | violation | coverage.profile |
| 100% | blocks | test/content/growth-threads.test.ts | Thread creation with first post | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/media-http.test.ts | media exact variant and current independent container chain decision | content | violation | coverage.profile |
| 100% | blocks | test/content/media-import-finalize.test.ts | native composite media creation | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/neighbourhood-storage.test.ts | bounded neighbourhood probes | content | violation | coverage.profile |
| 100% | blocks | test/content/neighbourhood-storage.test.ts | hot partition scan | content | violation | coverage.profile |
| 100% | blocks | test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/moderation.test.ts | point moderation and logical erasure | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/operation-storage.test.ts | operation identity and author endpoints | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/point-command-admission.test.ts | Authenticated content command admission | content | violation | coverage.profile |
| 100% | blocks | test/content/reaction-projection.test.ts | Reaction count aggregation | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/read.test.ts | current board disclosure | content | violation | coverage.profile |
| 100% | blocks | test/content/reports-http.test.ts | report HTTP admission and create | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/content/erasure-workflow.test.ts | native logical author page | content | violation | coverage.profile |
| 100% | blocks | test/content/realm-boards.test.ts | Protected Realm member thread read | content | violation | coverage.profile |
| 100% | blocks | test/content/realm-participation.test.ts | content write participation with unrelated Realms, members and bans | content | violation | coverage.profile |
| 100% | blocks | test/content/source-fences.test.ts | authorized exact tuple takedown | content | insufficient-evidence | coverage.profile |
| 100% | blocks | test/library/growth-listing.test.ts | Member listing effect | library | insufficient-evidence | coverage.profile |
| 100% | blocks | test/library/growth-listing.test.ts | Listing-change workflow step | library | insufficient-evidence | coverage.profile |
| 100% | blocks | test/library/shelf-page-activity-asc-growth.test.ts | activity ascending matching limit 1 | library | violation | coverage.profile |
| 100% | blocks | test/rating/subject-merge.test.ts | rating subject merge page voters | rating | violation | coverage.profile |
| 100% | blocks | test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | semantic | insufficient-evidence | coverage.profile |
| 100% | blocks | test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic | violation | coverage.profile |
| 100% | blocks | test/semantic/growth-sourced-writes.test.ts | a sourced bulk write at a fixed batch has constant rows and statements as subjects, documents and fences grow | semantic | insufficient-evidence | coverage.profile |
| 100% | blocks | test/support/growth-rule.test.ts | series uncertain repetitions | support | insufficient-evidence | coverage.profile |
| 100% | blocks | test/work/growth-retention.test.ts | short workflow retention batch | work | violation | coverage.profile |
| 100% | blocks | test/access/growth-evaluator.test.ts | actor evaluator G [occurrence 2] | access | violation | coverage.profile |
| 100% | blocks | test/access/growth-evaluator.test.ts | actor evaluator K | access | violation | coverage.profile |
| 100% | blocks | test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts [occurrence 2] | access | violation | coverage.profile |
| 100% | blocks | test/library/growth-sessions.test.ts | session complete [occurrence 2] | library | insufficient-evidence | coverage.profile |
| 100% | blocks | test/rating/subject-merge.test.ts | rating subject merge page voters [occurrence 2] | rating | violation | coverage.profile |
| 100% | blocks | test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | work | violation | coverage.profile |
| 99% | blocks | test/access/growth-account-realms.test.ts | account Realm page | access | violation | coverage.profile |
| 99% | blocks | test/access/growth-agent-pages.test.ts | public change time stays bounded as accounts grow | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/growth-auth-barriers.test.ts | native Auth barriers | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/growth-commands.test.ts | Standing parent installation stays within its bound as Gt grows | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/growth-evaluator.test.ts | actor evaluator G | access | violation | coverage.profile |
| 99% | blocks | test/access/growth-commands.test.ts | Delegation create/revoke/read stays within its bound as A grows | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/growth-commands.test.ts | Account and organization creation stays within its bound as A grows | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/growth-operator-fencing.test.ts | total operator fence fanout | access | violation | coverage.profile |
| 99% | blocks | test/access/growth-commands.test.ts | Handle reserve/change/resolve/expire stays within its bound as A grows | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/growth-public-identity-read.test.ts | public identity read | access | violation | coverage.profile |
| 99% | blocks | test/access/growth-rate-tier.test.ts | account rate tier | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/growth-commands.test.ts | Tombstone erasure stays within its bound as m grows | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access | violation | coverage.profile |
| 99% | blocks | test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/commerce/growth-orders.test.ts | Command envelope stays within its bound as P grows | commerce | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/membership-work-growth.test.ts | durable membership reserve | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/access/membership-work-growth.test.ts | durable membership join | access | insufficient-evidence | coverage.profile |
| 99% | blocks | test/community/growth-ban.test.ts | Realm ban, unban and list | community | insufficient-evidence | coverage.profile |
| 99% | blocks | test/community/growth-realm.test.ts | community Realm update | community | insufficient-evidence | coverage.profile |
| 99% | blocks | test/community/participation.test.ts | Realm participation | community | violation | coverage.profile |
| 99% | blocks | test/community/growth-join.test.ts | Join a Realm | community | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/author-post-delete.test.ts | Author post delete | content | violation | coverage.profile |
| 99% | blocks | test/content/board-projection.test.ts | board candidate upsert and fixed keyset page | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/board-hot-http.test.ts | Hot board page | content | violation | coverage.profile |
| 99% | blocks | test/content/cover-metadata.test.ts | batched cover reference | content | violation | coverage.profile |
| 99% | blocks | test/community/growth-join.test.ts | Leave a Realm | community | violation | coverage.profile |
| 99% | blocks | test/content/erasure-initiation-provenance.test.ts | author erasure initiation provenance | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/growth-media-erase.test.ts | Erase media | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/growth-reactions.test.ts | Subject reaction relay | content | violation | coverage.profile |
| 99% | blocks | test/content/board-hot-refresh.test.ts | one hot rank refresh batch | content | violation | coverage.profile |
| 99% | blocks | test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | content | violation | coverage.profile |
| 99% | blocks | test/content/growth-sitemap.test.ts | Sitemap threads page, listed items | content | violation | coverage.profile |
| 99% | blocks | test/content/growth-threads.test.ts | Review creation with vote citation | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/imported-fields.test.ts | imported changed documents | content | violation | coverage.profile |
| 99% | blocks | test/content/growth-threads.test.ts | Thread creation with first post | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/media-http.test.ts | media exact variant and current independent container chain decision | content | violation | coverage.profile |
| 99% | blocks | test/content/media-import-finalize.test.ts | native composite media creation | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/media-import-job.test.ts | exact imported media work | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/neighbourhood-storage.test.ts | bounded neighbourhood probes | content | violation | coverage.profile |
| 99% | blocks | test/content/neighbourhood-storage.test.ts | hot partition scan | content | violation | coverage.profile |
| 99% | blocks | test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/moderation.test.ts | point moderation and logical erasure | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/operation-storage.test.ts | operation identity and author endpoints | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/new-thread-media.test.ts | new-thread media reservation | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/point-command-admission.test.ts | Authenticated content command admission | content | violation | coverage.profile |
| 99% | blocks | test/content/reaction-projection.test.ts | Reaction count aggregation | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/read.test.ts | current board disclosure | content | violation | coverage.profile |
| 99% | blocks | test/content/reports-http.test.ts | report HTTP admission and create | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/content/erasure-workflow.test.ts | native logical author page | content | violation | coverage.profile |
| 99% | blocks | test/content/realm-boards.test.ts | Protected Realm member thread read | content | violation | coverage.profile |
| 99% | blocks | test/content/realm-participation.test.ts | content write participation with unrelated Realms, members and bans | content | violation | coverage.profile |
| 99% | blocks | test/content/source-fences.test.ts | authorized exact tuple takedown | content | insufficient-evidence | coverage.profile |
| 99% | blocks | test/library/growth-collections.test.ts | Remove member | library | insufficient-evidence | coverage.profile |
| 99% | blocks | test/library/growth-listing.test.ts | Member listing effect | library | insufficient-evidence | coverage.profile |
| 99% | blocks | test/library/growth-listing.test.ts | Listing-change workflow step | library | insufficient-evidence | coverage.profile |
| 99% | blocks | test/library/growth-sessions.test.ts | session complete | library | insufficient-evidence | coverage.profile |
| 99% | blocks | test/library/growth-published-logs.test.ts | Retract has constant rows and statements as published logs grow | library | insufficient-evidence | coverage.profile |
| 99% | blocks | test/library/shelf-page-activity-asc-growth.test.ts | activity ascending matching limit 1 | library | violation | coverage.profile |
| 99% | blocks | test/rating/subject-merge.test.ts | rating subject merge page voters | rating | violation | coverage.profile |
| 99% | blocks | test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | semantic | insufficient-evidence | coverage.profile |
| 99% | blocks | test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic | violation | coverage.profile |
| 99% | blocks | test/semantic/growth-sourced-writes.test.ts | a sourced bulk write at a fixed batch has constant rows and statements as subjects, documents and fences grow | semantic | insufficient-evidence | coverage.profile |
| 99% | blocks | test/support/growth-rule.test.ts | series uncertain repetitions | support | insufficient-evidence | coverage.profile |
| 99% | blocks | test/work/growth-retention.test.ts | short workflow retention batch | work | violation | coverage.profile |
| 99% | blocks | test/access/growth-evaluator.test.ts | actor evaluator G [occurrence 2] | access | violation | coverage.profile |
| 99% | blocks | test/access/growth-evaluator.test.ts | actor evaluator K | access | violation | coverage.profile |
| 99% | blocks | test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts [occurrence 2] | access | violation | coverage.profile |
| 99% | blocks | test/library/growth-sessions.test.ts | session complete [occurrence 2] | library | insufficient-evidence | coverage.profile |
| 99% | blocks | test/rating/subject-merge.test.ts | rating subject merge page voters [occurrence 2] | rating | violation | coverage.profile |
| 99% | blocks | test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | work | violation | coverage.profile |
| 100% | statements | test/access/growth-creation-manifest.test.ts | manifest changed resources | access | violation | coverage.profile |
| 100% | statements | test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | access | insufficient-evidence | coverage.profile |
| 100% | statements | test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | presentation | insufficient-evidence | coverage.profile |
| 100% | statements | test/support/growth-capture.test.ts | duplicate insert retry | support | violation | coverage.profile |
| 100% | statements | test/support/growth-shadow.test.ts | noisy shadow growth | support | insufficient-evidence | coverage.profile |
| 100% | statements | test/support/growth-shadow.test.ts | exact shadow violation | support | violation | coverage.profile |
| 99% | statements | test/access/growth-creation-manifest.test.ts | manifest changed resources | access | violation | coverage.profile |
| 99% | statements | test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | access | insufficient-evidence | coverage.profile |
| 99% | statements | test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | presentation | insufficient-evidence | coverage.profile |
| 99% | statements | test/support/growth-capture.test.ts | duplicate insert retry | support | violation | coverage.profile |
| 99% | statements | test/support/growth-shadow.test.ts | noisy shadow growth | support | insufficient-evidence | coverage.profile |
| 99% | statements | test/support/growth-shadow.test.ts | exact shadow violation | support | violation | coverage.profile |

## Checks omitted from calibration

| File | Check | Missing runs | Scales by run |
| --- | --- | --- | --- |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | calibration-3.profile | calibration-1.profile: 1, 8, 64; calibration-2.profile: 1, 8, 64; calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/commerce/growth-orders.test.ts | Checkout and receipt recording stays within its bound as o grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-orders.test.ts | Entitlement grant change lock and read stays within its bound as e grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-orders.test.ts | Entitlement list stays within its bound as d grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-orders.test.ts | Erasure stays within its bound as N grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | calibration-2.profile | calibration-1.profile: 1, 4, 16; calibration-3.profile: 1, 4, 16; calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-orders.test.ts | Order creation stays within its bound as o grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-orders.test.ts | Order decision and settlement stays within its bound as N grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-orders.test.ts | Webhook and commerce jobs stays within its bound as N grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/commerce/growth-payouts.test.ts | Mark paid stays within its bound as q grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/commerce/growth-payouts.test.ts | Payout lines page stays within its bound as d grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/commerce/http.test.ts | entitlement page | calibration-1.profile, calibration-2.profile | calibration-3.profile: 1, 8, 64; calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/commerce/http.test.ts | order read | calibration-1.profile | calibration-2.profile: 1, 8, 64; calibration-3.profile: 1, 8, 64; calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/community/growth-ban.test.ts | Realm ban, unban and list | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/community/growth-membership.test.ts | Realm membership publish, terminal reads and role proofs | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/community/growth-space-address.test.ts | community space address claim change resolve | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/community/participation.test.ts | Realm participation | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/content/board-projection.test.ts | board candidate upsert and fixed keyset page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 32, 256, 2048; calibration-5.profile: 32, 256, 2048 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, protected Realm content | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, listed items | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, protected Realm content | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/content/moderation.test.ts | point moderation and logical erasure | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 32, 256, 2048; calibration-5.profile: 32, 256, 2048 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 32, 256, 2048 |
| test/growth-command.test.ts | Concurrent commands in one partition stay within their bound as concurrency grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 2, 8, 32; calibration-5.profile: 2, 8, 32 |
| test/growth-command.test.ts | Denied replay | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/growth-command.test.ts | Idempotent replay | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/growth-command.test.ts | New command | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/growth-command.test.ts | One contention retry | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/growth-command.test.ts | Partition state | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/growth-events.test.ts | Batch checkpoints | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/growth-events.test.ts | Batch log | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/library/entry-store.test.ts | Library copy page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/entry-store.test.ts | Library entry page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/entry-store.test.ts | Library entry write | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions history deep | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions history first | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions owners deep | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions owners first | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions sessions deep | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions sessions first | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions units deep | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions units first | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/growth-sessions.test.ts | session abandon | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/growth-sessions.test.ts | session abandon [occurrence 2] | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/growth-sessions.test.ts | session complete | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/growth-sessions.test.ts | session complete [occurrence 2] | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/growth-sessions.test.ts | session record | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/growth-sessions.test.ts | session record [occurrence 2] | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/type | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/type | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/type | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/type | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/1/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/1/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/1/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/48/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/48/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/48/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/state | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/type | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/state | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/type | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-5.profile | calibration-4.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/state | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/type | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/state | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/type | calibration-1.profile, calibration-2.profile, calibration-3.profile, calibration-4.profile | calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/state | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/entries | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/foreign | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/sessions | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/state | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/presentation/agent-read-kinds.test.ts | Account discussions page read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 10, 100; calibration-5.profile: 1, 10, 100 |
| test/presentation/agent-read-kinds.test.ts | Account identity page read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 10, 100; calibration-5.profile: 1, 10, 100 |
| test/presentation/agent-read-kinds.test.ts | Account page read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 10, 100; calibration-5.profile: 1, 10, 100 |
| test/presentation/agent-read-kinds.test.ts | Account public collections page read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 10, 100; calibration-5.profile: 1, 10, 100 |
| test/presentation/agent-read-kinds.test.ts | Account replies page read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 10, 100; calibration-5.profile: 1, 10, 100 |
| test/presentation/growth-profiles.test.ts | Active profile lookup | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/presentation/growth-profiles.test.ts | Profile activate | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/presentation/growth-profiles.test.ts | Profile bootstrap | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/presentation/growth-profiles.test.ts | Profile publish | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/presentation/growth-profiles.test.ts | Profile read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/presentation/page-read-kinds.test.ts | Reaction counts read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 10, 100; calibration-5.profile: 1, 10, 100 |
| test/rating/growth-aggregate.test.ts | rating aggregate apply | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 64, 512, 4096; calibration-5.profile: 64, 512, 4096 |
| test/rating/growth-segment-job.test.ts | rating eligibility page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/rating/growth-segment-job.test.ts | rating re-key page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/rating/growth-segment-job.test.ts | rating segment page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/rating/subject-merge.test.ts | rating subject merge page voters | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/rating/subject-merge.test.ts | rating subject merge page voters [occurrence 2] | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 256, 1024, 4096; calibration-5.profile: 256, 1024, 4096 |
| test/relay-effects.test.ts | effects relay discovery | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/search/expansion.test.ts | Search and facet counts as vertical manifests grow | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 10, 100; calibration-5.profile: 1, 10, 100 |
| test/search/growth-indexing.test.ts | Reconcile | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/search/growth-indexing.test.ts | Retire | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/search/growth-query.test.ts | Freshness | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/semantic/context-relations.test.ts | Context inbound relation page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 16, 128, 1024; calibration-5.profile: 16, 128, 1024 |
| test/semantic/context-relations.test.ts | Context outbound relation page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 16, 128, 1024; calibration-5.profile: 16, 128, 1024 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 64, 512, 4096; calibration-5.profile: 64, 512, 4096 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 64, 512, 4096; calibration-5.profile: 64, 512, 4096 |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 64, 512, 4096; calibration-5.profile: 64, 512, 4096 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 64, 512, 4096; calibration-5.profile: 64, 512, 4096 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 64, 512, 4096; calibration-5.profile: 64, 512, 4096 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/semantic/growth-subjects.test.ts | Batch label fill stays within its bound as P grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/semantic/growth-subjects.test.ts | Command and receipt stays within its bound as N grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/semantic/growth-subjects.test.ts | Item projection and related labels stays within its bound as P grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/semantic/growth-subjects.test.ts | Partition keyset page stays within its bound as d grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/semantic/growth-subjects.test.ts | Request authorization stays within its bound as N grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/semantic/growth-subjects.test.ts | Subject creation stays within its bound as N grows | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/support/growth-capture.test.ts | duplicate insert retry | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/support/growth-load.test.ts | stable rows under varying query timing | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 4, 16; calibration-5.profile: 1, 4, 16 |
| test/support/growth-warmup.test.ts | operation-warmed probe read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/support/growth-warmup.test.ts | spare-state warmed probe read | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/support/growth-warmup.test.ts | unmeasured runs call the operation | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |
| test/support/growth-warmup.test.ts | warmup in place of the operation | calibration-1.profile, calibration-2.profile, calibration-3.profile | calibration-4.profile: 1, 8, 64; calibration-5.profile: 1, 8, 64 |

## Relations whose size did not grow

| File | Check | Relation | Run sizes (first → last reltuples) |
| --- | --- | --- | --- |
| test/anonymous-receipts-growth.test.ts | Anonymous receipt history | core.partition | calibration-1.profile: 4096 → 4096; calibration-2.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | public.auth_client_reduction | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | public.auth_consent | calibration-1.profile: 4 → 4; calibration-2.profile: 4 → 4; calibration-3.profile: 4 → 4; calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | public.auth_client | calibration-1.profile: 4 → 4; calibration-2.profile: 4 → 4; calibration-3.profile: 4 → 4; calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | public.auth_client_coverage | calibration-1.profile: 4 → 4; calibration-2.profile: 4 → 4; calibration-3.profile: 4 → 4; calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | access.account | calibration-1.profile: 3 → 3; calibration-2.profile: 3 → 3; calibration-3.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | access.principal_assignment | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | access.membership_inverse | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | access.resource_grant | calibration-1.profile: 5 → 5; calibration-2.profile: 5 → 5; calibration-3.profile: 5 → 5; calibration-4.profile: 5 → 5; calibration-5.profile: 5 → 5; coverage.profile: 5 → 5 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | access.resource_role_grant | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | access.resource_denial | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | access.organization_member | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | durable_test.authority | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | durable_test.effect | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | core.partition | calibration-1.profile: 4096 → 4096; calibration-2.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/growth-orders.test.ts | Command envelope stays within its bound as P grows | access.membership_inverse | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Command envelope stays within its bound as P grows | core.partition | calibration-1.profile: 4096 → 4096; calibration-2.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | public.auth_client_reduction | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | public.auth_consent | calibration-1.profile: 8 → 8; calibration-2.profile: 8 → 8; calibration-3.profile: 8 → 8; calibration-4.profile: 8 → 8; calibration-5.profile: 8 → 8; coverage.profile: 8 → 8 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | public.auth_client | calibration-1.profile: 8 → 8; calibration-2.profile: 8 → 8; calibration-3.profile: 8 → 8; calibration-4.profile: 8 → 8; calibration-5.profile: 8 → 8; coverage.profile: 8 → 8 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | public.auth_client_coverage | calibration-1.profile: 8 → 8; calibration-2.profile: 8 → 8; calibration-3.profile: 8 → 8; calibration-4.profile: 8 → 8; calibration-5.profile: 8 → 8; coverage.profile: 8 → 8 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | access.account | calibration-1.profile: 6 → 6; calibration-2.profile: 6 → 6; calibration-3.profile: 6 → 6; calibration-4.profile: 6 → 6; calibration-5.profile: 6 → 6; coverage.profile: 6 → 6 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | access.principal_assignment | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | access.membership_inverse | calibration-1.profile: 2 → 2; calibration-2.profile: 2 → 2; calibration-3.profile: 2 → 2; calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | access.resource_grant | calibration-1.profile: 10 → 10; calibration-2.profile: 10 → 10; calibration-3.profile: 10 → 10; calibration-4.profile: 10 → 10; calibration-5.profile: 10 → 10; coverage.profile: 10 → 10 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | access.resource_role_grant | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | access.resource_denial | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | access.organization_member | calibration-1.profile: 2 → 2; calibration-2.profile: 2 → 2; calibration-3.profile: 2 → 2; calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | durable_test.authority | calibration-1.profile: 2 → 2; calibration-2.profile: 2 → 2; calibration-3.profile: 2 → 2; calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/commerce/growth-orders.test.ts | Authorization stays within its bound as P grows | access.membership_inverse | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Authorization stays within its bound as P grows | core.partition | calibration-1.profile: 4096 → 4096; calibration-2.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/growth-payouts.test.ts | Royalty computation and payout record stays within its bound as q grows | access.resource_role_grant | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-write-rate-chunk.test.ts | write-rate-chunk-expiry | access.write_rate_counter | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | durable_test.operation | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | durable_test.source | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | public.auth_client_reduction | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access.account | calibration-1.profile: 9 → 9; calibration-2.profile: 9 → 9; calibration-3.profile: 9 → 9; calibration-4.profile: 9 → 9; calibration-5.profile: 9 → 9; coverage.profile: 9 → 9 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access.principal_assignment | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access.membership_inverse | calibration-1.profile: 3 → 3; calibration-2.profile: 3 → 3; calibration-3.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access.resource_grant | calibration-1.profile: 15 → 15; calibration-2.profile: 15 → 15; calibration-3.profile: 15 → 15; calibration-4.profile: 15 → 15; calibration-5.profile: 15 → 15; coverage.profile: 15 → 15 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access.resource_role_grant | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access.resource_denial | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | access.organization_member | calibration-1.profile: 3 → 3; calibration-2.profile: 3 → 3; calibration-3.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | durable_test.authority | calibration-1.profile: 3 → 3; calibration-2.profile: 3 → 3; calibration-3.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | durable_test.effect | calibration-1.profile: 3 → 3; calibration-2.profile: 3 → 3; calibration-3.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | core.partition | calibration-1.profile: 4096 → 4096; calibration-2.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-agent-page-lookup.test.ts | agent page lookup stays within its bound as unrelated verified subjects grow | semantic.subject | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-agent-page-lookup.test.ts | agent page lookup stays within its bound as unrelated verified subjects grow | semantic.fact | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-agent-page-lookup.test.ts | agent page lookup stays within its bound as unrelated verified subjects grow | semantic.account_agent_subject | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer creation stays within its bound as N grows | access.membership_inverse | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer creation stays within its bound as N grows | core.partition | calibration-1.profile: 4096 → 4096; calibration-2.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.definition_activation | calibration-1.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.outbound_link | calibration-1.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.fact | calibration-1.profile: 2 → 2; calibration-3.profile: 2 → 2; calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.hidden_candidate | calibration-1.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.retraction | calibration-1.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.statement_disclosure | calibration-1.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.adoption | calibration-1.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.candidate | calibration-1.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | access.membership_inverse | calibration-1.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | semantic.redirect | calibration-1.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | core.partition | calibration-1.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/growth-payouts.test.ts | Statement read and list stays within its bound as d grows | core.partition | calibration-1.profile: 4096 → 4096; calibration-2.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/http.test.ts | order creation | access.account | calibration-1.profile: 3 → 3; calibration-2.profile: 3 → 3; calibration-3.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/commerce/http.test.ts | order creation | access.exposure_opening | calibration-1.profile: 2 → 2; calibration-2.profile: 2 → 2; calibration-3.profile: 2 → 2; calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/commerce/http.test.ts | order creation | access.membership_inverse | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/http.test.ts | order creation | access.resource_grant | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-3.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/commerce/http.test.ts | order creation | access.resource_role_grant | calibration-1.profile: 2 → 2; calibration-2.profile: 2 → 2; calibration-3.profile: 2 → 2; calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/commerce/http.test.ts | order creation | access.resource_denial | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/http.test.ts | order creation | core.partition | calibration-1.profile: 4096 → 4096; calibration-2.profile: 4096 → 4096; calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | durable_test.operation | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | durable_test.source | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | core.receipt | calibration-1.profile: 3 → 3; calibration-2.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | public.auth_client_reduction | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | access.account | calibration-1.profile: 12 → 12; calibration-2.profile: 12 → 12; calibration-4.profile: 12 → 12; calibration-5.profile: 12 → 12; coverage.profile: 12 → 12 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | access.principal_assignment | calibration-1.profile: 1 → 1; calibration-2.profile: 1 → 1; calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | access.membership_inverse | calibration-1.profile: 4 → 4; calibration-2.profile: 4 → 4; calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | access.resource_grant | calibration-1.profile: 20 → 20; calibration-2.profile: 20 → 20; calibration-4.profile: 20 → 20; calibration-5.profile: 20 → 20; coverage.profile: 20 → 20 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | access.resource_role_grant | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | access.resource_denial | calibration-1.profile: 0 → 0; calibration-2.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | access.organization_member | calibration-1.profile: 4 → 4; calibration-2.profile: 4 → 4; calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | durable_test.authority | calibration-1.profile: 4 → 4; calibration-2.profile: 4 → 4; calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/commerce/http.test.ts | order read | access.account | calibration-2.profile: 3 → 3; calibration-3.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/commerce/http.test.ts | order read | access.exposure_opening | calibration-2.profile: 2 → 2; calibration-3.profile: 2 → 2; calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/commerce/http.test.ts | order read | semantic.definition_activation | calibration-2.profile: 0 → 0; calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/http.test.ts | entitlement page | access.account | calibration-3.profile: 3 → 3; calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/commerce/http.test.ts | entitlement page | access.exposure_opening | calibration-3.profile: 2 → 2; calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/commerce/http.test.ts | entitlement page | core.partition | calibration-3.profile: 4096 → 4096; calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/http.test.ts | entitlement page | semantic.definition_activation | calibration-3.profile: 0 → 0; calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/community/growth-membership.test.ts | Realm membership publish, terminal reads and role proofs | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/growth-orders.test.ts | Order creation stays within its bound as o grows | access.membership_inverse | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order creation stays within its bound as o grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/growth-orders.test.ts | Checkout and receipt recording stays within its bound as o grows | access.membership_inverse | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Checkout and receipt recording stays within its bound as o grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | durable_test.operation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | durable_test.source | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | public.auth_client_reduction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | index:auth_consent_client_owner | calibration-4.profile: 20 → 20; calibration-5.profile: 20 → 20; coverage.profile: 20 → 20 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | public.auth_consent | calibration-4.profile: 20 → 20; calibration-5.profile: 20 → 20; coverage.profile: 20 → 20 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | index:auth_client_pkey | calibration-4.profile: 20 → 20; calibration-5.profile: 20 → 20; coverage.profile: 20 → 20 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | public.auth_client | calibration-4.profile: 20 → 20; calibration-5.profile: 20 → 20; coverage.profile: 20 → 20 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | index:auth_client_coverage_pkey | calibration-4.profile: 20 → 20; calibration-5.profile: 20 → 20; coverage.profile: 20 → 20 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | public.auth_client_coverage | calibration-4.profile: 20 → 20; calibration-5.profile: 20 → 20; coverage.profile: 20 → 20 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | access.account | calibration-4.profile: 15 → 15; calibration-5.profile: 15 → 15; coverage.profile: 15 → 15 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | access.membership_inverse | calibration-4.profile: 5 → 5; calibration-5.profile: 5 → 5; coverage.profile: 5 → 5 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | access.resource_grant | calibration-4.profile: 25 → 25; calibration-5.profile: 25 → 25; coverage.profile: 25 → 25 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | access.organization_member | calibration-4.profile: 5 → 5; calibration-5.profile: 5 → 5; coverage.profile: 5 → 5 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | durable_test.authority | calibration-4.profile: 5 → 5; calibration-5.profile: 5 → 5; coverage.profile: 5 → 5 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | durable_test.effect | calibration-4.profile: 5 → 5; calibration-5.profile: 5 → 5; coverage.profile: 5 → 5 |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | durable_test.operation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | durable_test.source | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | core.receipt | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | public.auth_client_reduction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | public.auth_consent | calibration-4.profile: 24 → 24; calibration-5.profile: 24 → 24; coverage.profile: 24 → 24 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | index:auth_client_pkey | calibration-4.profile: 24 → 24; calibration-5.profile: 24 → 24; coverage.profile: 24 → 24 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | public.auth_client | calibration-4.profile: 24 → 24; calibration-5.profile: 24 → 24; coverage.profile: 24 → 24 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | index:auth_client_coverage_pkey | calibration-4.profile: 24 → 24; calibration-5.profile: 24 → 24; coverage.profile: 24 → 24 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | public.auth_client_coverage | calibration-4.profile: 24 → 24; calibration-5.profile: 24 → 24; coverage.profile: 24 → 24 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | access.account | calibration-4.profile: 18 → 18; calibration-5.profile: 18 → 18; coverage.profile: 18 → 18 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | access.membership_inverse | calibration-4.profile: 6 → 6; calibration-5.profile: 6 → 6; coverage.profile: 6 → 6 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | access.resource_grant | calibration-4.profile: 30 → 30; calibration-5.profile: 30 → 30; coverage.profile: 30 → 30 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | access.organization_member | calibration-4.profile: 6 → 6; calibration-5.profile: 6 → 6; coverage.profile: 6 → 6 |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | durable_test.authority | calibration-4.profile: 6 → 6; calibration-5.profile: 6 → 6; coverage.profile: 6 → 6 |
| test/commerce/growth-payouts.test.ts | Payout lines page stays within its bound as d grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/community/growth-space-address.test.ts | community space address claim change resolve | access.account | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/community/growth-space-address.test.ts | community space address claim change resolve | access.write_rate_counter | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/community/growth-space-address.test.ts | community space address claim change resolve | access.membership_inverse | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/community/growth-space-address.test.ts | community space address claim change resolve | access.resource_grant | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/community/growth-space-address.test.ts | community space address claim change resolve | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/community/growth-space-address.test.ts | community space address claim change resolve | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/community/growth-space-address.test.ts | community space address claim change resolve | community.realm | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.definition_activation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.outbound_link | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.fact | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.hidden_candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.retraction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.statement_disclosure | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.adoption | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | access.membership_inverse | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/board-projection.test.ts | board candidate upsert and fixed keyset page | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/content/board-projection.test.ts | board candidate upsert and fixed keyset page | editorial.write_basis | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/board-projection.test.ts | board candidate upsert and fixed keyset page | core.receipt | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | public.auth_client_reduction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | public.auth_consent | calibration-4.profile: 28 → 28; calibration-5.profile: 28 → 28; coverage.profile: 28 → 28 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | index:auth_client_pkey | calibration-4.profile: 28 → 28; calibration-5.profile: 28 → 28; coverage.profile: 28 → 28 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | public.auth_client | calibration-4.profile: 28 → 28; calibration-5.profile: 28 → 28; coverage.profile: 28 → 28 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | index:auth_client_coverage_pkey | calibration-4.profile: 28 → 28; calibration-5.profile: 28 → 28; coverage.profile: 28 → 28 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | public.auth_client_coverage | calibration-4.profile: 28 → 28; calibration-5.profile: 28 → 28; coverage.profile: 28 → 28 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | access.account | calibration-4.profile: 21 → 21; calibration-5.profile: 21 → 21; coverage.profile: 21 → 21 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | access.principal_assignment | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | access.membership_inverse | calibration-4.profile: 7 → 7; calibration-5.profile: 7 → 7; coverage.profile: 7 → 7 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | access.resource_grant | calibration-4.profile: 35 → 35; calibration-5.profile: 35 → 35; coverage.profile: 35 → 35 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | access.organization_member | calibration-4.profile: 7 → 7; calibration-5.profile: 7 → 7; coverage.profile: 7 → 7 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | durable_test.authority | calibration-4.profile: 7 → 7; calibration-5.profile: 7 → 7; coverage.profile: 7 → 7 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | durable_test.effect | calibration-4.profile: 7 → 7; calibration-5.profile: 7 → 7; coverage.profile: 7 → 7 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/community/growth-ban.test.ts | Realm ban, unban and list | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | public.auth_client_reduction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | public.auth_consent | calibration-4.profile: 32 → 32; calibration-5.profile: 32 → 32; coverage.profile: 32 → 32 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | index:auth_client_pkey | calibration-4.profile: 32 → 32; calibration-5.profile: 32 → 32; coverage.profile: 32 → 32 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | public.auth_client | calibration-4.profile: 32 → 32; calibration-5.profile: 32 → 32; coverage.profile: 32 → 32 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | index:auth_client_coverage_pkey | calibration-4.profile: 32 → 32; calibration-5.profile: 32 → 32; coverage.profile: 32 → 32 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | public.auth_client_coverage | calibration-4.profile: 32 → 32; calibration-5.profile: 32 → 32; coverage.profile: 32 → 32 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | access.account | calibration-4.profile: 24 → 24; calibration-5.profile: 24 → 24; coverage.profile: 24 → 24 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | access.principal_assignment | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | access.membership_inverse | calibration-4.profile: 8 → 8; calibration-5.profile: 8 → 8; coverage.profile: 8 → 8 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | access.resource_grant | calibration-4.profile: 40 → 40; calibration-5.profile: 40 → 40; coverage.profile: 40 → 40 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | access.organization_member | calibration-4.profile: 8 → 8; calibration-5.profile: 8 → 8; coverage.profile: 8 → 8 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | durable_test.authority | calibration-4.profile: 8 → 8; calibration-5.profile: 8 → 8; coverage.profile: 8 → 8 |
| test/community/participation.test.ts | Realm participation | access.account | calibration-4.profile: 13 → 13; calibration-5.profile: 13 → 13; coverage.profile: 13 → 13 |
| test/community/participation.test.ts | Realm participation | access.membership_inverse | calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/community/participation.test.ts | Realm participation | access.resource_grant | calibration-4.profile: 13 → 13; calibration-5.profile: 13 → 13; coverage.profile: 13 → 13 |
| test/community/participation.test.ts | Realm participation | access.resource_denial | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/commerce/growth-payouts.test.ts | Mark paid stays within its bound as q grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/growth-command.test.ts | New command | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | durable_test.operation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | durable_test.source | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | public.auth_client_reduction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access.account | calibration-4.profile: 27 → 27; calibration-5.profile: 27 → 27; coverage.profile: 27 → 27 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access.principal_assignment | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access.membership_inverse | calibration-4.profile: 9 → 9; calibration-5.profile: 9 → 9; coverage.profile: 9 → 9 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access.resource_grant | calibration-4.profile: 45 → 45; calibration-5.profile: 45 → 45; coverage.profile: 45 → 45 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | access.organization_member | calibration-4.profile: 9 → 9; calibration-5.profile: 9 → 9; coverage.profile: 9 → 9 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | durable_test.authority | calibration-4.profile: 9 → 9; calibration-5.profile: 9 → 9; coverage.profile: 9 → 9 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | durable_test.effect | calibration-4.profile: 9 → 9; calibration-5.profile: 9 → 9; coverage.profile: 9 → 9 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/growth-command.test.ts | One contention retry | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/commerce/growth-orders.test.ts | Entitlement grant change lock and read stays within its bound as e grows | commerce.order_transaction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/growth-command.test.ts | Concurrent commands in one partition stay within their bound as concurrency grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/growth-command.test.ts | Partition state | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | access.resource_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | durable_test.operation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | durable_test.source | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | core.receipt | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | public.auth_client_reduction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | access.account | calibration-4.profile: 30 → 30; calibration-5.profile: 30 → 30; coverage.profile: 30 → 30 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | access.principal_assignment | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | access.membership_inverse | calibration-4.profile: 10 → 10; calibration-5.profile: 10 → 10; coverage.profile: 10 → 10 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | access.resource_grant | calibration-4.profile: 50 → 50; calibration-5.profile: 50 → 50; coverage.profile: 50 → 50 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | access.organization_member | calibration-4.profile: 10 → 10; calibration-5.profile: 10 → 10; coverage.profile: 10 → 10 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | durable_test.authority | calibration-4.profile: 10 → 10; calibration-5.profile: 10 → 10; coverage.profile: 10 → 10 |
| test/content/moderation.test.ts | point moderation and logical erasure | access.account | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/content/moderation.test.ts | point moderation and logical erasure | access.membership_inverse | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/moderation.test.ts | point moderation and logical erasure | access.resource_role_grant | calibration-4.profile: 2076 → 2076; calibration-5.profile: 2076 → 2076; coverage.profile: 2076 → 2076 |
| test/content/moderation.test.ts | point moderation and logical erasure | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/moderation.test.ts | point moderation and logical erasure | content.thread | calibration-4.profile: 8 → 8; calibration-5.profile: 8 → 8; coverage.profile: 8 → 8 |
| test/content/moderation.test.ts | point moderation and logical erasure | content.board | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/content/moderation.test.ts | point moderation and logical erasure | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/growth-events.test.ts | Batch log | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, protected Realm content | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, protected Realm content | access.resource_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, protected Realm content | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/growth-sitemap.test.ts | Sitemap boards page, protected Realm content | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | durable_test.operation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | durable_test.source | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | public.auth_client_reduction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | public.auth_consent | calibration-4.profile: 44 → 44; calibration-5.profile: 44 → 44; coverage.profile: 44 → 44 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | index:auth_client_pkey | calibration-4.profile: 44 → 44; calibration-5.profile: 44 → 44; coverage.profile: 44 → 44 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | public.auth_client | calibration-4.profile: 44 → 44; calibration-5.profile: 44 → 44; coverage.profile: 44 → 44 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | index:auth_client_coverage_pkey | calibration-4.profile: 44 → 44; calibration-5.profile: 44 → 44; coverage.profile: 44 → 44 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | public.auth_client_coverage | calibration-4.profile: 44 → 44; calibration-5.profile: 44 → 44; coverage.profile: 44 → 44 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | access.account | calibration-4.profile: 33 → 33; calibration-5.profile: 33 → 33; coverage.profile: 33 → 33 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | access.membership_inverse | calibration-4.profile: 11 → 11; calibration-5.profile: 11 → 11; coverage.profile: 11 → 11 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | access.resource_grant | calibration-4.profile: 55 → 55; calibration-5.profile: 55 → 55; coverage.profile: 55 → 55 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | access.organization_member | calibration-4.profile: 11 → 11; calibration-5.profile: 11 → 11; coverage.profile: 11 → 11 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | durable_test.authority | calibration-4.profile: 11 → 11; calibration-5.profile: 11 → 11; coverage.profile: 11 → 11 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | durable_test.effect | calibration-4.profile: 11 → 11; calibration-5.profile: 11 → 11; coverage.profile: 11 → 11 |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | durable_test.operation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | durable_test.source | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | core.receipt | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | public.auth_client_reduction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | public.auth_consent | calibration-4.profile: 48 → 48; calibration-5.profile: 48 → 48; coverage.profile: 48 → 48 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | index:auth_client_pkey | calibration-4.profile: 48 → 48; calibration-5.profile: 48 → 48; coverage.profile: 48 → 48 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | public.auth_client | calibration-4.profile: 48 → 48; calibration-5.profile: 48 → 48; coverage.profile: 48 → 48 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | index:auth_client_coverage_pkey | calibration-4.profile: 48 → 48; calibration-5.profile: 48 → 48; coverage.profile: 48 → 48 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | public.auth_client_coverage | calibration-4.profile: 48 → 48; calibration-5.profile: 48 → 48; coverage.profile: 48 → 48 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | access.account | calibration-4.profile: 36 → 36; calibration-5.profile: 36 → 36; coverage.profile: 36 → 36 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | access.membership_inverse | calibration-4.profile: 12 → 12; calibration-5.profile: 12 → 12; coverage.profile: 12 → 12 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | access.resource_grant | calibration-4.profile: 60 → 60; calibration-5.profile: 60 → 60; coverage.profile: 60 → 60 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | access.organization_member | calibration-4.profile: 12 → 12; calibration-5.profile: 12 → 12; coverage.profile: 12 → 12 |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | durable_test.authority | calibration-4.profile: 12 → 12; calibration-5.profile: 12 → 12; coverage.profile: 12 → 12 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions history first | library.progress_session | calibration-4.profile: 127300 → 127300; calibration-5.profile: 127300 → 127300; coverage.profile: 127300 → 127300 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/1/sessions | library.entry | calibration-4.profile: 256 → 256; calibration-5.profile: 256 → 256; coverage.profile: 256 → 256 |
| test/library/growth-sessions.test.ts | session record | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions history deep | library.progress_session | calibration-4.profile: 139580 → 139580; calibration-5.profile: 139580 → 139580; coverage.profile: 139580 → 139580 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/48/sessions | library.entry | calibration-4.profile: 256 → 256; calibration-5.profile: 256 → 256; coverage.profile: 256 → 256 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, listed items | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, listed items | access.resource_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, listed items | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, listed items | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/library/growth-sessions.test.ts | session complete | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions units first | library.progress_session | calibration-4.profile: 151870 → 151870; calibration-5.profile: 151870 → 151870; coverage.profile: 151870 → 151870 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/sessions | library.entry | calibration-4.profile: 1280 → 1280 |
| test/presentation/growth-profiles.test.ts | Profile publish | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/library/growth-sessions.test.ts | session abandon | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/presentation/growth-profiles.test.ts | Profile activate | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions units deep | library.progress_session | calibration-4.profile: 164160 → 164160; calibration-5.profile: 164160 → 164160; coverage.profile: 164160 → 164160 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/sessions | library.entry | calibration-4.profile: 1280 → 1280 |
| test/rating/growth-aggregate.test.ts | rating aggregate apply | rating.question | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/rating/growth-aggregate.test.ts | rating aggregate apply | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/rating/growth-aggregate.test.ts | rating aggregate apply | editorial.write_basis | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/rating/growth-aggregate.test.ts | rating aggregate apply | core.receipt | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/sessions | library.entry | calibration-4.profile: 1280 → 1280; calibration-5.profile: 1280 → 1280; coverage.profile: 1280 → 1280 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, protected Realm content | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, protected Realm content | access.resource_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, protected Realm content | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/content/growth-sitemap.test.ts | Sitemap threads page, protected Realm content | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/rating/growth-segment-job.test.ts | rating segment page | rating.voter_realm | calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/rating/growth-segment-job.test.ts | rating segment page | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/rating/growth-segment-job.test.ts | rating segment page | editorial.write_basis | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/rating/growth-segment-job.test.ts | rating segment page | core.receipt | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account page read | semantic.context | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/presentation/agent-read-kinds.test.ts | Account page read | access.resource_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account page read | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account page read | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account page read | presentation.profile_activation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/presentation/agent-read-kinds.test.ts | Account page read | access.handle_claim | calibration-4.profile: 4106 → 4106; calibration-5.profile: 4106 → 4106; coverage.profile: 4106 → 4106 |
| test/presentation/agent-read-kinds.test.ts | Account page read | access.account | calibration-4.profile: 4107 → 4107; calibration-5.profile: 4107 → 4107; coverage.profile: 4107 → 4107 |
| test/presentation/agent-read-kinds.test.ts | Account page read | semantic.subject | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/presentation/agent-read-kinds.test.ts | Account page read | semantic.fact | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/presentation/agent-read-kinds.test.ts | Account page read | semantic.account_agent_subject | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/presentation/agent-read-kinds.test.ts | Account page read | semantic.definition_activation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/presentation/agent-read-kinds.test.ts | Account page read | access.exposure_opening | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/presentation/agent-read-kinds.test.ts | Account page read | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/presentation/agent-read-kinds.test.ts | Account page read | library.collection | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/presentation/agent-read-kinds.test.ts | Account identity page read | semantic.subject | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/presentation/agent-read-kinds.test.ts | Account identity page read | semantic.account_agent_subject | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/presentation/agent-read-kinds.test.ts | Account identity page read | semantic.fact | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/rating/growth-segment-job.test.ts | rating eligibility page | rating.voter_state | calibration-4.profile: 10 → 10; calibration-5.profile: 10 → 10; coverage.profile: 10 → 10 |
| test/rating/growth-segment-job.test.ts | rating eligibility page | rating.voter_realm | calibration-4.profile: 10 → 10; calibration-5.profile: 10 → 10; coverage.profile: 10 → 10 |
| test/rating/growth-segment-job.test.ts | rating eligibility page | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/rating/growth-segment-job.test.ts | rating eligibility page | editorial.write_basis | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/rating/growth-segment-job.test.ts | rating eligibility page | core.receipt | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account discussions page read | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/presentation/agent-read-kinds.test.ts | Account discussions page read | access.account | calibration-4.profile: 5707 → 5707; calibration-5.profile: 5707 → 5707; coverage.profile: 5707 → 5707 |
| test/presentation/agent-read-kinds.test.ts | Account discussions page read | access.resource_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account discussions page read | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account discussions page read | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/rating/growth-segment-job.test.ts | rating re-key page | rating.voter_state | calibration-4.profile: 10 → 10; calibration-5.profile: 10 → 10; coverage.profile: 10 → 10 |
| test/rating/growth-segment-job.test.ts | rating re-key page | rating.voter_realm | calibration-4.profile: 16 → 16; calibration-5.profile: 16 → 16; coverage.profile: 16 → 16 |
| test/rating/growth-segment-job.test.ts | rating re-key page | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/rating/growth-segment-job.test.ts | rating re-key page | editorial.write_basis | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/rating/growth-segment-job.test.ts | rating re-key page | core.receipt | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/sessions | library.entry | calibration-4.profile: 1280 → 1280; calibration-5.profile: 1280 → 1280; coverage.profile: 1280 → 1280 |
| test/presentation/agent-read-kinds.test.ts | Account replies page read | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/presentation/agent-read-kinds.test.ts | Account replies page read | access.account | calibration-4.profile: 5707 → 5707; calibration-5.profile: 5707 → 5707; coverage.profile: 5707 → 5707 |
| test/presentation/agent-read-kinds.test.ts | Account replies page read | access.resource_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account replies page read | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account replies page read | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/agent-read-kinds.test.ts | Account public collections page read | access.exposure_opening | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/presentation/agent-read-kinds.test.ts | Account public collections page read | access.account | calibration-4.profile: 5707 → 5707; calibration-5.profile: 5707 → 5707; coverage.profile: 5707 → 5707 |
| test/presentation/agent-read-kinds.test.ts | Account public collections page read | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/relay-effects.test.ts | effects relay discovery | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/sessions | library.entry | calibration-4.profile: 2304 → 2304 |
| test/rating/subject-merge.test.ts | rating subject merge page voters | rating.voter_realm | calibration-4.profile: 4099 → 4099; calibration-5.profile: 4099 → 4099; coverage.profile: 4099 → 4099 |
| test/rating/subject-merge.test.ts | rating subject merge page voters | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/rating/subject-merge.test.ts | rating subject merge page voters | editorial.write_basis | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/search/growth-indexing.test.ts | Reconcile | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/sessions | library.entry | calibration-4.profile: 2304 → 2304 |
| test/presentation/page-read-kinds.test.ts | Reaction counts read | semantic.subject | calibration-4.profile: 5 → 5; calibration-5.profile: 5 → 5; coverage.profile: 5 → 5 |
| test/presentation/page-read-kinds.test.ts | Reaction counts read | access.resource_grant | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/presentation/page-read-kinds.test.ts | Reaction counts read | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/page-read-kinds.test.ts | Reaction counts read | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/page-read-kinds.test.ts | Reaction counts read | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/presentation/page-read-kinds.test.ts | Reaction counts read | content.reaction_total | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/search/growth-query.test.ts | Freshness | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.subject | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.inbound_link_count | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.inbound_link_context_count | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.definition_activation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.outbound_link | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.fact | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.hidden_candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.retraction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.statement_disclosure | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.adoption | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | semantic.candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/search/expansion.test.ts | Search and facet counts as vertical manifests grow | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/search/expansion.test.ts | Search and facet counts as vertical manifests grow | core.consumer_checkpoint | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.subject | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.inbound_link_count | calibration-4.profile: 6 → 6; calibration-5.profile: 6 → 6; coverage.profile: 6 → 6 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.inbound_link_context_count | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.definition_activation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.outbound_link | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.fact | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.hidden_candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.retraction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.statement_disclosure | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.adoption | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | semantic.candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/support/growth-load.test.ts | stable rows under varying query timing | growth_load_test.rows | calibration-4.profile: 16 → 16; calibration-5.profile: 16 → 16; coverage.profile: 16 → 16 |
| test/semantic/context-relations.test.ts | Context outbound relation page | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.context | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.subject | calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.outbound_link_count | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.outbound_link_context_count | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.fact | calibration-4.profile: 12 → 12; calibration-5.profile: 12 → 12; coverage.profile: 12 → 12 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.adoption | calibration-4.profile: 5 → 5; calibration-5.profile: 5 → 5; coverage.profile: 5 → 5 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.candidate | calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.hidden_candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.retraction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/context-relations.test.ts | Context outbound relation page | semantic.statement_disclosure | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/support/growth-warmup.test.ts | operation-warmed probe read | growth_warmup_test.probes | calibration-4.profile: 516 → 512; calibration-5.profile: 516 → 512; coverage.profile: 516 → 512 |
| test/semantic/growth-subjects.test.ts | Subject creation stays within its bound as N grows | semantic.account_agent_subject | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Subject creation stays within its bound as N grows | semantic.partition_subjects | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-subjects.test.ts | Subject creation stays within its bound as N grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/support/growth-warmup.test.ts | spare-state warmed probe read | growth_warmup_test.probes | calibration-4.profile: 516 → 512; calibration-5.profile: 516 → 512; coverage.profile: 516 → 512 |
| test/semantic/context-relations.test.ts | Context inbound relation page | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/context-relations.test.ts | Context inbound relation page | semantic.context | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/context-relations.test.ts | Context inbound relation page | semantic.subject | calibration-4.profile: 4 → 4; calibration-5.profile: 4 → 4; coverage.profile: 4 → 4 |
| test/semantic/context-relations.test.ts | Context inbound relation page | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/context-relations.test.ts | Context inbound relation page | semantic.inbound_link_count | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/context-relations.test.ts | Context inbound relation page | semantic.inbound_link_context_count | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | editorial.write_basis | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | core.receipt | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | core.consumer_checkpoint | calibration-4.profile: 4097 → 4097; calibration-5.profile: 4097 → 4097; coverage.profile: 4097 → 4097 |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | semantic.inbound_link_context_count | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | semantic.inbound_link_count | calibration-4.profile: 4009 → 4009; calibration-5.profile: 4009 → 4009; coverage.profile: 4009 → 4009 |
| test/semantic/growth-subjects.test.ts | Command and receipt stays within its bound as N grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.definition_activation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | core.consumer_checkpoint | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.account_agent_subject | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.definition_release | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.context_extension_activation | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.outbound_link_count | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3; coverage.profile: 3 → 3 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.outbound_link_context_count | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.hidden_candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.retraction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.statement_disclosure | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.adoption | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | semantic.candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.definition_activation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | core.consumer_checkpoint | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.account_agent_subject | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.revision | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.definition_release | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.context_extension_activation | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.outbound_link | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.outbound_link_count | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.outbound_link_context_count | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.hidden_candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.retraction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.statement_disclosure | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.adoption | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | semantic.candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Partition keyset page stays within its bound as d grows | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/semantic/growth-subjects.test.ts | Request authorization stays within its bound as N grows | access.account | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-subjects.test.ts | Request authorization stays within its bound as N grows | access.membership_inverse | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Request authorization stays within its bound as N grows | access.resource_grant | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1; coverage.profile: 1 → 1 |
| test/semantic/growth-subjects.test.ts | Request authorization stays within its bound as N grows | access.resource_role_grant | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/semantic/growth-subjects.test.ts | Request authorization stays within its bound as N grows | access.resource_denial | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0; coverage.profile: 0 → 0 |
| test/library/growth-sessions.test.ts | session record [occurrence 2] | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/library/growth-sessions.test.ts | session complete [occurrence 2] | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/library/growth-sessions.test.ts | session abandon [occurrence 2] | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/rating/subject-merge.test.ts | rating subject merge page voters [occurrence 2] | rating.voter_realm | calibration-4.profile: 4099 → 4099; calibration-5.profile: 4099 → 4099; coverage.profile: 4099 → 4099 |
| test/rating/subject-merge.test.ts | rating subject merge page voters [occurrence 2] | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096; coverage.profile: 4096 → 4096 |
| test/rating/subject-merge.test.ts | rating subject merge page voters [occurrence 2] | editorial.write_basis | calibration-4.profile: 2 → 2; calibration-5.profile: 2 → 2; coverage.profile: 2 → 2 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.definition_activation | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | core.partition | calibration-4.profile: 4096 → 4096; calibration-5.profile: 4096 → 4096 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | core.consumer_checkpoint | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.account_agent_subject | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.redirect | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.definition_release | calibration-4.profile: 1 → 1; calibration-5.profile: 1 → 1 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.context_extension_activation | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.outbound_link_count | calibration-4.profile: 3 → 3; calibration-5.profile: 3 → 3 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.outbound_link_context_count | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.hidden_candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.retraction | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.statement_disclosure | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.adoption | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | semantic.candidate | calibration-4.profile: 0 → 0; calibration-5.profile: 0 → 0 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | access.account | calibration-5.profile: 2 → 2 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | access.write_rate_counter | calibration-5.profile: 2 → 2 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | access.membership_inverse | calibration-5.profile: 0 → 0 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | access.resource_grant | calibration-5.profile: 10 → 10 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | access.resource_role_grant | calibration-5.profile: 1 → 1 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | access.resource_denial | calibration-5.profile: 0 → 0 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | core.partition | calibration-5.profile: 4096 → 4096 |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | semantic.context | calibration-5.profile: 1 → 1 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/sessions | library.entry | calibration-5.profile: 1280 → 1280 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/sessions | library.entry | calibration-5.profile: 1280 → 1280 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/sessions | library.entry | calibration-5.profile: 2304 → 2304 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/sessions | library.entry | calibration-5.profile: 2304 → 2304 |
| test/access/growth-account-agent-effect.test.ts | account agent effect growth stays within its bound at [256, 1024, 4096] | semantic.fact | coverage.profile: 1 → 1 |
| test/access/growth-account-agent-effect.test.ts | account agent effect growth stays within its bound at [256, 1024, 4096] | semantic.redirect | coverage.profile: 0 → 0 |
| test/access/growth-account-agent-effect.test.ts | account agent effect growth stays within its bound at [256, 1024, 4096] | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/access/growth-account-realms.test.ts | account Realm page | access.account | coverage.profile: 3 → 3 |
| test/access/growth-account-realms.test.ts | account Realm page | access.resource_grant | coverage.profile: 21 → 21 |
| test/access/growth-account-realms.test.ts | account Realm page | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-account-realms.test.ts | account Realm page | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-agent-pages.test.ts | public change time stays bounded as accounts grow | access.lifecycle_coordination | coverage.profile: 0 → 0 |
| test/access/growth-agent-verification.test.ts | agent verification request stays bounded as decided requests grow | access.account | coverage.profile: 25 → 25 |
| test/access/growth-agent-verification.test.ts | agent verification request stays bounded as decided requests grow | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-agent-verification.test.ts | agent verification request stays bounded as decided requests grow | access.resource_grant | coverage.profile: 25 → 25 |
| test/access/growth-agent-verification.test.ts | agent verification request stays bounded as decided requests grow | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-agent-verification.test.ts | agent verification request stays bounded as decided requests grow | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-agent-verification.test.ts | agent verification request stays bounded as decided requests grow | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | access.account | coverage.profile: 25 → 25 |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | access.resource_grant | coverage.profile: 25 → 25 |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | semantic.context | coverage.profile: 1 → 1 |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | access.governance_bootstrap | coverage.profile: 0 → 0 |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | access.standing_parent_installation | coverage.profile: 0 → 0 |
| test/access/gates/growth-discovery.test.ts | Operation discovery with unrelated account growth | access.exposure_opening | coverage.profile: 0 → 0 |
| test/access/gates/growth-discovery.test.ts | Operation discovery with unrelated account growth | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/gates/growth-discovery.test.ts | Operation discovery with unrelated account growth | access.resource_grant | coverage.profile: 3 → 3 |
| test/access/gates/growth-discovery.test.ts | Operation discovery with unrelated account growth | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/gates/growth-admission.test.ts | Gate admission with unrelated account growth | access.exposure_opening | coverage.profile: 0 → 0 |
| test/access/gates/growth-admission.test.ts | Gate admission with unrelated account growth | access.resource_grant | coverage.profile: 3 → 3 |
| test/access/gates/growth-admission.test.ts | Gate admission with unrelated account growth | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/gates/growth-admission.test.ts | Gate admission with unrelated account growth | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-anonymous-resource-authorization.test.ts | Anonymous shared authorization and private report | core.partition | coverage.profile: 4096 → 4096 |
| test/access/gates/growth-discovery.test.ts | Operation discovery with unrelated gate grant growth | access.exposure_opening | coverage.profile: 0 → 0 |
| test/access/gates/growth-admission.test.ts | Gate admission with unrelated gate grant growth | access.exposure_opening | coverage.profile: 0 → 0 |
| test/access/gates/growth-admission.test.ts | Gate admission with unrelated gate grant growth | access.membership_inverse | coverage.profile: 32003 → 32003 |
| test/access/growth-account-handle-read.test.ts | public profile by handle | semantic.subject | coverage.profile: 0 → 0 |
| test/access/growth-account-handle-read.test.ts | public profile by handle | semantic.fact | coverage.profile: 0 → 0 |
| test/access/growth-account-handle-read.test.ts | public profile by handle | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/access/growth-account-handle-read.test.ts | public profile by handle | content.media_variant | coverage.profile: 0 → 0 |
| test/access/growth-auth-barriers.test.ts | native Auth barriers | core.partition | coverage.profile: 4096 → 4096 |
| test/access/gates/growth-admission.test.ts | Gate admission with other exposure opening growth | access.account | coverage.profile: 64005 → 64005 |
| test/access/gates/growth-admission.test.ts | Gate admission with other exposure opening growth | access.membership_inverse | coverage.profile: 32003 → 32003 |
| test/access/gates/growth-admission.test.ts | Gate admission with other exposure opening growth | access.resource_grant | coverage.profile: 32003 → 32003 |
| test/access/gates/growth-admission.test.ts | Gate admission with other exposure opening growth | access.resource_role_grant | coverage.profile: 32000 → 32000 |
| test/access/gates/growth-admission.test.ts | Gate admission with other exposure opening growth | access.resource_denial | coverage.profile: 32000 → 32000 |
| test/access/gates/growth-discovery.test.ts | Operation discovery with other exposure opening growth | access.resource_denial | coverage.profile: 32000 → 32000 |
| test/access/gates/growth-discovery.test.ts | Operation discovery with other exposure opening growth | access.resource_grant | coverage.profile: 32003 → 32003 |
| test/access/gates/growth-discovery.test.ts | Operation discovery with other exposure opening growth | access.resource_role_grant | coverage.profile: 32000 → 32000 |
| test/access/growth-command-admission.test.ts | generic command admission | access.resource_grant | coverage.profile: 3 → 3 |
| test/access/growth-command-admission.test.ts | generic command admission | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-command-admission.test.ts | generic command admission | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-command-admission.test.ts | generic command admission | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-command-admission.test.ts | multi-action command admission | access.resource_grant | coverage.profile: 3 → 3 |
| test/access/growth-command-admission.test.ts | multi-action command admission | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-command-admission.test.ts | multi-action command admission | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-command-admission.test.ts | multi-action command admission | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-bootstrap-governance.test.ts | governance bootstrap refusal | access.governance_bootstrap | coverage.profile: 1 → 1 |
| test/access/growth-bootstrap-governance.test.ts | governance bootstrap refusal | access.standing_parent_installation | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.session | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.user | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | access.account | coverage.profile: 4098 → 4098 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.auth_client | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.auth_client_coverage | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.auth_client_reduction | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.auth_consent | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.auth_public_key | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.auth_signing_generation | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | public.auth_signing_key | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | access.resource_grant | coverage.profile: 4102 → 4102 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Standing parent installation stays within its bound as Gt grows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-commands.test.ts | Standing parent installation stays within its bound as Gt grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.session | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.user | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | access.account | coverage.profile: 4098 → 4098 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.auth_client | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.auth_client_coverage | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.auth_client_reduction | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.auth_consent | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.auth_public_key | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.auth_signing_generation | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | public.auth_signing_key | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | access.resource_grant | coverage.profile: 4102 → 4102 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-creation-manifest.test.ts | manifest background | access.account | coverage.profile: 3 → 3 |
| test/access/growth-creation-manifest.test.ts | manifest background | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-creation-manifest.test.ts | manifest background | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-creation-manifest.test.ts | manifest background | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-creation-manifest.test.ts | manifest changed resources | access.account | coverage.profile: 3 → 3 |
| test/access/growth-creation-manifest.test.ts | manifest changed resources | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-creation-manifest.test.ts | manifest changed resources | access.resource_grant | coverage.profile: 73735 → 73735 |
| test/access/growth-creation-manifest.test.ts | manifest changed resources | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-creation-manifest.test.ts | manifest changed resources | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Creator grant initialization stays within its bound as Gt grows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-commands.test.ts | Creator grant initialization stays within its bound as Gt grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.session | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.user | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | access.account | coverage.profile: 4098 → 4098 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.auth_client | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.auth_client_coverage | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.auth_client_reduction | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.auth_consent | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.auth_public_key | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.auth_signing_generation | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | public.auth_signing_key | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | access.resource_grant | coverage.profile: 4102 → 4102 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-evaluator.test.ts | actor evaluator G | access.principal_assignment | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.session | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.user | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.auth_client | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.auth_client_coverage | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.auth_client_reduction | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.auth_consent | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.auth_public_key | coverage.profile: 2 → 2 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.auth_signing_generation | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | public.auth_signing_key | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | public.session | coverage.profile: 1 → 1 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | public.user | coverage.profile: 2 → 2 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | public.auth_client | coverage.profile: 2 → 2 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | public.auth_client_coverage | coverage.profile: 2 → 2 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | public.auth_client_reduction | coverage.profile: 0 → 0 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | public.auth_signing_generation | coverage.profile: 1 → 1 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | public.auth_signing_key | coverage.profile: 1 → 1 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-auth-session-capability.test.ts | operator session capability | public.account | coverage.profile: 2 → 2 |
| test/access/growth-governance-reach.test.ts | platform governance reach | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-governance-reach.test.ts | platform governance reach | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-governance-reach.test.ts | platform governance reach | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-commands.test.ts | Grant create/change/revoke stays within its bound as Gt grows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-commands.test.ts | Grant create/change/revoke stays within its bound as Gt grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-membership-inverse-bootstrap.test.ts | membership source-cursor bootstrap | access.membership_inverse_terminal | coverage.profile: 0 → 0 |
| test/access/growth-membership-inverse-bootstrap.test.ts | membership source-cursor bootstrap | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Delegation create/revoke/read stays within its bound as A grows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-commands.test.ts | Delegation create/revoke/read stays within its bound as A grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-cursor.test.ts | first operator page | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-cursor.test.ts | later operator page | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-grant-routes.test.ts | mounted native grant routes | access.account | coverage.profile: 2 → 2 |
| test/access/growth-grant-routes.test.ts | mounted native grant routes | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-grant-routes.test.ts | mounted native grant routes | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-grant-routes.test.ts | mounted native grant routes | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-fencing.test.ts | late fence page: unrelated accounts | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Account and organization creation stays within its bound as A grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Account and organization creation stays within its bound as A grows | access.membership_inverse | coverage.profile: 18 → 18 |
| test/access/growth-operator-fencing.test.ts | first fence page: completed and pending history | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-fencing.test.ts | late fence page: completed and pending history | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-transfer.test.ts | operator transfer with unrelated accounts and responsibilities | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-operator-transfer.test.ts | operator transfer with unrelated accounts and responsibilities | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-operator-transfer.test.ts | operator transfer with unrelated accounts and responsibilities | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-operator-transfer.test.ts | operator transfer with unrelated accounts and responsibilities | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-transfer.test.ts | operator transfer with unrelated accounts and responsibilities | access.organization_member | coverage.profile: 0 → 0 |
| test/access/growth-organization-close.test.ts | close organization | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-organization-close.test.ts | close organization | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-organization-close.test.ts | close organization | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-reinstatement.test.ts | first operator reinstatement page | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-reinstatement.test.ts | first operator reinstatement page | access.lifecycle_coordination | coverage.profile: 2056 → 2056 |
| test/access/growth-operator-reinstatement.test.ts | first operator reinstatement page | access.operator_relation_slot | coverage.profile: 2056 → 2056 |
| test/access/growth-operator-fencing.test.ts | total operator fence fanout | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Handle reserve/change/resolve/expire stays within its bound as A grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-organization-close.test.ts | organization cleanup step | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-organization-speakers.test.ts | organization speakers page | access.account | coverage.profile: 4120 → 4120 |
| test/access/growth-operator-reinstatement.test.ts | late operator reinstatement page | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-reinstatement.test.ts | late operator reinstatement page | access.lifecycle_coordination | coverage.profile: 4112 → 4112 |
| test/access/growth-operator-reinstatement.test.ts | late operator reinstatement page | access.operator_relation_slot | coverage.profile: 4112 → 4112 |
| test/access/growth-commands.test.ts | Account update, coordination and fences stays within its bound as A grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Account update, coordination and fences stays within its bound as A grows | access.membership_inverse_terminal | coverage.profile: 0 → 0 |
| test/access/growth-permission.test.ts | Permission preparation stays within its bound as O grows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-preferences.test.ts | account preferences set | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-preferences.test.ts | account preferences set | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-preferences.test.ts | account preferences set | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-preferences.test.ts | account preferences set | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Membership change stays within its bound as m grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-rate-tier.test.ts | account rate tier | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-rate-tier.test.ts | account rate tier | access.resource_role_grant | coverage.profile: 1 → 1 |
| test/access/growth-rate-tier.test.ts | account rate tier | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-rate-tier.test.ts | account rate tier | semantic.context | coverage.profile: 1 → 1 |
| test/access/growth-rate-tier.test.ts | account rate tier | access.governance_bootstrap | coverage.profile: 1 → 1 |
| test/access/growth-rate-tier.test.ts | account rate tier | access.standing_parent_installation | coverage.profile: 1 → 1 |
| test/access/growth-rate-tier.test.ts | account rate tier | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-registration-proof.test.ts | reference lookup is bounded across receipt history | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-resource-authorization-page.test.ts | page authorization page size | access.account | coverage.profile: 4101 → 4101 |
| test/access/growth-resource-authorization-page.test.ts | page authorization page size | access.principal_assignment | coverage.profile: 4097 → 4097 |
| test/access/growth-resource-authorization-page.test.ts | page authorization page size | access.membership_inverse | coverage.profile: 4099 → 4099 |
| test/access/growth-resource-authorization-page.test.ts | page authorization page size | access.resource_role_grant | coverage.profile: 4096 → 4096 |
| test/access/growth-resource-authorization-page.test.ts | page authorization page size | access.resource_denial | coverage.profile: 4096 → 4096 |
| test/access/growth-resource-authorization-page.test.ts | page authorization page size | access.organization_member | coverage.profile: 4098 → 4098 |
| test/access/growth-resource-authorization-page.test.ts | page authorization page size | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-commands.test.ts | Tombstone erasure stays within its bound as m grows | access.membership_inverse | coverage.profile: 18 → 18 |
| test/access/growth-commands.test.ts | Tombstone erasure stays within its bound as m grows | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-resource-authorization-page.test.ts | page authorization unrelated population | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-resource-authorization.test.ts | stable tuple composed authorization | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-resource-authorization.test.ts | creation composed authorization | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | public.auth_client | coverage.profile: 2 → 2 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | public.auth_client_coverage | coverage.profile: 2 → 2 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | public.auth_client_reduction | coverage.profile: 0 → 0 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | public.auth_signing_generation | coverage.profile: 1 → 1 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | public.auth_signing_key | coverage.profile: 1 → 1 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | access.organization_member | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | access.account | coverage.profile: 3 → 3 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | access.membership_inverse | coverage.profile: 2 → 2 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | access.resource_grant | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | core.receipt | coverage.profile: 22 → 22 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | access.lifecycle_membership_slot | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | core.partition | coverage.profile: 4096 → 4096 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access.account | coverage.profile: 3 → 3 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access.membership_inverse | coverage.profile: 2 → 2 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access.resource_grant | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | core.receipt | coverage.profile: 24 → 24 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | access.lifecycle_membership_slot | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-reinstatement.test.ts | account reinstatement | access.write_rate_counter | coverage.profile: 1 → 1 |
| test/access/growth-reinstatement.test.ts | account reinstatement | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-reinstatement.test.ts | account reinstatement | access.resource_role_grant | coverage.profile: 1 → 1 |
| test/access/growth-reinstatement.test.ts | account reinstatement | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/growth-reinstatement.test.ts | account reinstatement | semantic.context | coverage.profile: 1 → 1 |
| test/access/growth-reinstatement.test.ts | account reinstatement | access.governance_bootstrap | coverage.profile: 1 → 1 |
| test/access/growth-reinstatement.test.ts | account reinstatement | access.standing_parent_installation | coverage.profile: 1 → 1 |
| test/access/growth-reinstatement.test.ts | account reinstatement | access.committed_continuation | coverage.profile: 0 → 0 |
| test/access/growth-reinstatement.test.ts | account reinstatement | core.partition | coverage.profile: 4096 → 4096 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access.account | coverage.profile: 3 → 3 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access.membership_inverse | coverage.profile: 2 → 2 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access.resource_grant | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | core.receipt | coverage.profile: 26 → 26 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | access.lifecycle_membership_slot | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | core.partition | coverage.profile: 4096 → 4096 |
| test/access/public-floor-boundary.test.ts | public floor with bounded domain evidence | access.account | coverage.profile: 1 → 1 |
| test/access/public-floor-boundary.test.ts | public floor with bounded domain evidence | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/public-floor-boundary.test.ts | public floor with bounded domain evidence | access.resource_grant | coverage.profile: 0 → 0 |
| test/access/public-floor-boundary.test.ts | public floor with bounded domain evidence | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/public-floor-boundary.test.ts | public floor with bounded domain evidence | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | access.account | coverage.profile: 3 → 3 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | access.membership_inverse | coverage.profile: 2 → 2 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | access.lifecycle_coordination | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | access.resource_grant | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | core.receipt | coverage.profile: 28 → 28 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | access.lifecycle_membership_slot | coverage.profile: 1 → 1 |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | core.partition | coverage.profile: 4096 → 4096 |
| test/access/write-rate-expiry.test.ts | counter-expiry | access.write_rate_chunk | coverage.profile: 0 → 0 |
| test/command-event-cap.test.ts | New command stays within its bound as k grows | core.partition | coverage.profile: 4096 → 4096 |
| test/command-event-cap.test.ts | New command stays within its bound as k grows | editorial.write_basis | coverage.profile: 0 → 0 |
| test/command-event-cap.test.ts | New command stays within its bound as k grows | core.receipt | coverage.profile: 0 → 0 |
| test/access/membership-work-growth.test.ts | durable membership reserve | core.partition | coverage.profile: 4096 → 4096 |
| test/access/membership-work-growth.test.ts | durable membership join | access.account | coverage.profile: 4099 → 4099 |
| test/access/membership-work-growth.test.ts | durable membership join | access.membership_inverse | coverage.profile: 4097 → 4097 |
| test/access/membership-work-growth.test.ts | durable membership join | access.lifecycle_coordination | coverage.profile: 4097 → 4097 |
| test/access/membership-work-growth.test.ts | durable membership join | access.resource_grant | coverage.profile: 5 → 5 |
| test/access/membership-work-growth.test.ts | durable membership join | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/membership-work-growth.test.ts | durable membership join | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/membership-work-growth.test.ts | durable membership join | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-permission.test.ts | Parent creation authorization stays within its bound as G grows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-permission.test.ts | Parent creation authorization stays within its bound as G grows | core.partition | coverage.profile: 4096 → 4096 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | access.account | coverage.profile: 4 → 4 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | access.resource_grant | coverage.profile: 21 → 21 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | access.resource_role_grant | coverage.profile: 6 → 6 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | core.partition | coverage.profile: 4096 → 4096 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.redirect | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.fact | coverage.profile: 2 → 2 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.definition_release | coverage.profile: 1 → 1 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.context_extension_activation | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.outbound_link | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.retraction | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.adoption | coverage.profile: 0 → 0 |
| test/community/board-scheme.test.ts | Realm board scheme set and read | semantic.candidate | coverage.profile: 0 → 0 |
| test/access/membership-work-growth.test.ts | durable membership leave | access.account | coverage.profile: 4099 → 4099 |
| test/access/membership-work-growth.test.ts | durable membership leave | access.membership_inverse | coverage.profile: 4097 → 4097 |
| test/access/membership-work-growth.test.ts | durable membership leave | access.lifecycle_coordination | coverage.profile: 4097 → 4097 |
| test/access/membership-work-growth.test.ts | durable membership leave | access.resource_grant | coverage.profile: 5 → 5 |
| test/access/membership-work-growth.test.ts | durable membership leave | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/access/membership-work-growth.test.ts | durable membership leave | access.resource_denial | coverage.profile: 0 → 0 |
| test/access/membership-work-growth.test.ts | durable membership leave | core.partition | coverage.profile: 4096 → 4096 |
| test/community/growth-sitemap.test.ts | Realm sitemap page stays within its bound as listed items grow | access.resource_grant | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Realm sitemap page stays within its bound as listed items grow | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Realm sitemap page stays within its bound as listed items grow | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Realm sitemap page stays within its bound as listed items grow | content.board | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as listed items grow | access.resource_grant | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as listed items grow | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as listed items grow | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as listed items grow | community.realm | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as protected Realms grow | access.resource_grant | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as protected Realms grow | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as protected Realms grow | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-realm.test.ts | community Realm create | access.account | coverage.profile: 2 → 2 |
| test/community/growth-realm.test.ts | community Realm create | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/growth-realm.test.ts | community Realm create | access.resource_grant | coverage.profile: 2 → 2 |
| test/community/growth-realm.test.ts | community Realm create | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-realm.test.ts | community Realm create | semantic.context | coverage.profile: 1 → 1 |
| test/community/growth-realm.test.ts | community Realm create | core.partition | coverage.profile: 4096 → 4096 |
| test/community/growth-publication.test.ts | community publication page | access.account | coverage.profile: 2 → 2 |
| test/community/growth-publication.test.ts | community publication page | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/growth-publication.test.ts | community publication page | access.resource_grant | coverage.profile: 3 → 3 |
| test/community/growth-publication.test.ts | community publication page | access.resource_role_grant | coverage.profile: 4 → 4 |
| test/community/growth-publication.test.ts | community publication page | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-publication.test.ts | community publication page | core.partition | coverage.profile: 4096 → 4096 |
| test/community/growth-realm.test.ts | community Realm read | access.account | coverage.profile: 2 → 2 |
| test/community/growth-realm.test.ts | community Realm read | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/growth-realm.test.ts | community Realm read | access.resource_grant | coverage.profile: 2 → 2 |
| test/community/growth-realm.test.ts | community Realm read | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-publication.test.ts | community publication write | access.account | coverage.profile: 2 → 2 |
| test/community/growth-publication.test.ts | community publication write | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/growth-publication.test.ts | community publication write | access.resource_grant | coverage.profile: 3 → 3 |
| test/community/growth-publication.test.ts | community publication write | access.resource_role_grant | coverage.profile: 4 → 4 |
| test/community/growth-publication.test.ts | community publication write | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-publication.test.ts | community publication write | core.partition | coverage.profile: 4096 → 4096 |
| test/community/growth-realm.test.ts | community Realm public-read | access.resource_grant | coverage.profile: 2 → 2 |
| test/community/growth-realm.test.ts | community Realm public-read | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-space.test.ts | community Space create | access.account | coverage.profile: 2 → 2 |
| test/community/growth-space.test.ts | community Space create | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/growth-space.test.ts | community Space create | access.resource_grant | coverage.profile: 1 → 1 |
| test/community/growth-space.test.ts | community Space create | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-space.test.ts | community Space create | core.partition | coverage.profile: 4096 → 4096 |
| test/community/growth-space.test.ts | community Space read | access.account | coverage.profile: 2 → 2 |
| test/community/growth-space.test.ts | community Space read | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/growth-space.test.ts | community Space read | access.resource_grant | coverage.profile: 1 → 1 |
| test/community/growth-space.test.ts | community Space read | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-realm.test.ts | community Realm update | access.account | coverage.profile: 2 → 2 |
| test/community/growth-realm.test.ts | community Realm update | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/growth-realm.test.ts | community Realm update | access.resource_grant | coverage.profile: 2 → 2 |
| test/community/growth-realm.test.ts | community Realm update | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-realm.test.ts | community Realm update | core.partition | coverage.profile: 4096 → 4096 |
| test/community/growth-space.test.ts | community Space update | access.account | coverage.profile: 2 → 2 |
| test/community/growth-space.test.ts | community Space update | access.membership_inverse | coverage.profile: 0 → 0 |
| test/community/growth-space.test.ts | community Space update | access.resource_grant | coverage.profile: 1 → 1 |
| test/community/growth-space.test.ts | community Space update | access.resource_denial | coverage.profile: 0 → 0 |
| test/community/growth-space.test.ts | community Space update | core.partition | coverage.profile: 4096 → 4096 |
| test/access/membership-work-growth.test.ts | durable membership release | access.account | coverage.profile: 4099 → 4099 |
| test/access/membership-work-growth.test.ts | durable membership release | access.membership_inverse | coverage.profile: 4097 → 4097 |
| test/access/membership-work-growth.test.ts | durable membership release | access.lifecycle_coordination | coverage.profile: 4097 → 4097 |
| test/access/membership-work-growth.test.ts | durable membership release | core.partition | coverage.profile: 4096 → 4096 |
| test/content/author-item-index.test.ts | author item index | core.partition | coverage.profile: 4096 → 4096 |
| test/content/author-item-index.test.ts | author item index | editorial.write_basis | coverage.profile: 3 → 3 |
| test/content/author-item-index.test.ts | author item index | content.post | coverage.profile: 24 → 24 |
| test/community/growth-join.test.ts | Join a Realm | core.partition | coverage.profile: 4096 → 4096 |
| test/content/author-post-delete.test.ts | Author post delete | content.media | coverage.profile: 0 → 0 |
| test/content/author-post-delete.test.ts | Author post delete | core.partition | coverage.profile: 4096 → 4096 |
| test/content/authored-field-erasure.test.ts | authored document erasure | access.account | coverage.profile: 2 → 2 |
| test/content/authored-field-erasure.test.ts | authored document erasure | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/authored-field-erasure.test.ts | authored document erasure | access.resource_grant | coverage.profile: 4 → 4 |
| test/content/authored-field-erasure.test.ts | authored document erasure | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/authored-field-erasure.test.ts | authored document erasure | core.partition | coverage.profile: 4096 → 4096 |
| test/content/authored-fields.test.ts | authored document append and read | access.resource_initialization | coverage.profile: 2 → 2 |
| test/content/authored-fields.test.ts | authored document append and read | access.resource_role_grant | coverage.profile: 2 → 2 |
| test/content/authored-document-http.test.ts | authored document read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/authored-document-http.test.ts | authored document read | content.imported_field | coverage.profile: 1 → 1 |
| test/content/authored-document-http.test.ts | authored document read | access.resource_grant | coverage.profile: 9 → 9 |
| test/content/authored-document-http.test.ts | authored document read | access.resource_role_grant | coverage.profile: 6 → 6 |
| test/content/authored-document-http.test.ts | authored document read | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/authored-document-http.test.ts | authored document read | semantic.fact | coverage.profile: 14 → 14 |
| test/content/authored-document-http.test.ts | authored document read | semantic.retraction | coverage.profile: 0 → 0 |
| test/content/authored-document-http.test.ts | authored document read | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/content/authored-document-http.test.ts | authored document read | semantic.hidden_candidate | coverage.profile: 1 → 1 |
| test/content/avatar-media.test.ts | avatar summaries | content.media_variant | coverage.profile: 656 → 656 |
| test/access/growth-suspension.test.ts | mounted native suspension | access.write_rate_counter | coverage.profile: 4001 → 4001 |
| test/access/growth-suspension.test.ts | mounted native suspension | access.membership_inverse | coverage.profile: 0 → 0 |
| test/access/growth-suspension.test.ts | mounted native suspension | access.resource_role_grant | coverage.profile: 4001 → 4001 |
| test/access/growth-suspension.test.ts | mounted native suspension | access.resource_denial | coverage.profile: 4000 → 4000 |
| test/access/growth-suspension.test.ts | mounted native suspension | semantic.context | coverage.profile: 4001 → 4001 |
| test/access/growth-suspension.test.ts | mounted native suspension | access.governance_bootstrap | coverage.profile: 1 → 1 |
| test/access/growth-suspension.test.ts | mounted native suspension | access.standing_parent_installation | coverage.profile: 1 → 1 |
| test/access/growth-suspension.test.ts | mounted native suspension | core.partition | coverage.profile: 4096 → 4096 |
| test/content/author-item-reads.test.ts | Author thread page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/author-item-reads.test.ts | Author thread page | access.account | coverage.profile: 6 → 6 |
| test/content/author-item-reads.test.ts | Author thread page | content.thread | coverage.profile: 24 → 24 |
| test/content/author-item-reads.test.ts | Author thread page | content.post | coverage.profile: 33 → 33 |
| test/content/author-item-reads.test.ts | Author thread page | content.revision | coverage.profile: 33 → 33 |
| test/content/author-item-reads.test.ts | Author thread page | content.board | coverage.profile: 23 → 23 |
| test/content/author-item-reads.test.ts | Author thread page | access.resource_grant | coverage.profile: 0 → 0 |
| test/content/author-item-reads.test.ts | Author thread page | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/author-item-reads.test.ts | Author thread page | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/board-hot-http.test.ts | Hot board page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/board-hot-http.test.ts | Hot board page | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/board-ranking.test.ts | active board page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/collection-job.test.ts | partition media collection | core.partition | coverage.profile: 4096 → 4096 |
| test/content/current-erased-read.test.ts | current erased native disclosure | core.partition | coverage.profile: 4096 → 4096 |
| test/community/growth-join.test.ts | Leave a Realm | core.partition | coverage.profile: 4096 → 4096 |
| test/content/boards-http.test.ts | board HTTP current query and disclosure with same-partition distractors | core.partition | coverage.profile: 4096 → 4096 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | access.account | coverage.profile: 2 → 2 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | core.partition | coverage.profile: 4096 → 4096 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | access.resource_grant | coverage.profile: 0 → 0 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | semantic.fact | coverage.profile: 0 → 0 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | semantic.retraction | coverage.profile: 0 → 0 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/content/erasure-initiation-provenance.test.ts | author erasure initiation provenance | access.account | coverage.profile: 2 → 2 |
| test/content/erasure-initiation-provenance.test.ts | author erasure initiation provenance | core.partition | coverage.profile: 4096 → 4096 |
| test/content/erasure-initiation-provenance.test.ts | author erasure initiation provenance | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/erasure-initiation-provenance.test.ts | author erasure initiation provenance | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/erasure-job.test.ts | exact erased media prefix | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-boards.test.ts | Board projection | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-boards.test.ts | Board projection | content.post | coverage.profile: 0 → 0 |
| test/content/growth-boards.test.ts | Board candidate page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/author-item-reads.test.ts | Author post page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/author-item-reads.test.ts | Author post page | access.account | coverage.profile: 7 → 7 |
| test/content/author-item-reads.test.ts | Author post page | content.thread | coverage.profile: 28 → 28 |
| test/content/author-item-reads.test.ts | Author post page | content.post | coverage.profile: 41 → 41 |
| test/content/author-item-reads.test.ts | Author post page | content.revision | coverage.profile: 41 → 41 |
| test/content/author-item-reads.test.ts | Author post page | content.board | coverage.profile: 27 → 27 |
| test/content/author-item-reads.test.ts | Author post page | access.resource_grant | coverage.profile: 0 → 0 |
| test/content/author-item-reads.test.ts | Author post page | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/author-item-reads.test.ts | Author post page | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/growth-lifecycle.test.ts | Imported document append and read | access.account | coverage.profile: 501 → 501 |
| test/content/growth-lifecycle.test.ts | Imported document append and read | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/growth-lifecycle.test.ts | Imported document append and read | access.resource_grant | coverage.profile: 1001 → 1001 |
| test/content/growth-lifecycle.test.ts | Imported document append and read | access.resource_role_grant | coverage.profile: 3000 → 3000 |
| test/content/growth-lifecycle.test.ts | Imported document append and read | access.resource_denial | coverage.profile: 1000 → 1000 |
| test/content/growth-lifecycle.test.ts | Imported document append and read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-lifecycle.test.ts | Author erasure request | access.account | coverage.profile: 501 → 501 |
| test/content/growth-lifecycle.test.ts | Author erasure request | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-lifecycle.test.ts | Author erasure request | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/growth-lifecycle.test.ts | Author erasure request | access.resource_grant | coverage.profile: 1002 → 1002 |
| test/content/growth-lifecycle.test.ts | Author erasure request | access.resource_role_grant | coverage.profile: 3000 → 3000 |
| test/content/growth-lifecycle.test.ts | Author erasure request | access.resource_denial | coverage.profile: 1000 → 1000 |
| test/content/growth-lifecycle.test.ts | Author erasure binding and status | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-lifecycle.test.ts | Author erasure binding and status | access.account | coverage.profile: 501 → 501 |
| test/content/growth-lifecycle.test.ts | Author erasure binding and status | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/growth-lifecycle.test.ts | Author erasure binding and status | access.resource_grant | coverage.profile: 2002 → 2002 |
| test/content/growth-lifecycle.test.ts | Author erasure binding and status | access.resource_role_grant | coverage.profile: 3000 → 3000 |
| test/content/growth-lifecycle.test.ts | Author erasure binding and status | access.resource_denial | coverage.profile: 2000 → 2000 |
| test/content/growth-lifecycle.test.ts | URL reservation | access.account | coverage.profile: 501 → 501 |
| test/content/growth-lifecycle.test.ts | URL reservation | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/growth-lifecycle.test.ts | URL reservation | access.resource_grant | coverage.profile: 3002 → 3002 |
| test/content/growth-lifecycle.test.ts | URL reservation | access.resource_denial | coverage.profile: 3000 → 3000 |
| test/content/growth-lifecycle.test.ts | URL reservation | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-lifecycle.test.ts | URL status | access.account | coverage.profile: 501 → 501 |
| test/content/growth-lifecycle.test.ts | URL status | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/growth-lifecycle.test.ts | URL status | access.resource_grant | coverage.profile: 6002 → 6002 |
| test/content/growth-lifecycle.test.ts | URL status | access.resource_role_grant | coverage.profile: 2001 → 2001 |
| test/content/growth-lifecycle.test.ts | URL status | access.resource_denial | coverage.profile: 6000 → 6000 |
| test/content/growth-lifecycle.test.ts | URL status | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-media-erase.test.ts | Erase media | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/growth-media-erase.test.ts | Erase media | content.post | coverage.profile: 0 → 0 |
| test/content/growth-media-erase.test.ts | Erase media | content.thread | coverage.profile: 0 → 0 |
| test/content/growth-media-erase.test.ts | Erase media | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-lifecycle.test.ts | Source fence takedown | access.account | coverage.profile: 501 → 501 |
| test/content/growth-lifecycle.test.ts | Source fence takedown | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/growth-lifecycle.test.ts | Source fence takedown | access.resource_grant | coverage.profile: 1001 → 1001 |
| test/content/growth-lifecycle.test.ts | Source fence takedown | access.resource_role_grant | coverage.profile: 1000 → 1000 |
| test/content/growth-lifecycle.test.ts | Source fence takedown | access.resource_denial | coverage.profile: 1000 → 1000 |
| test/content/growth-lifecycle.test.ts | Source fence takedown | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-lifecycle.test.ts | Committed media purge | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-media.test.ts | Media reserve | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-media.test.ts | Media reserve | content.board | coverage.profile: 2 → 2 |
| test/content/growth-media.test.ts | Media reserve | access.membership_inverse | coverage.profile: 1000 → 1000 |
| test/content/growth-reactions.test.ts | Reaction slot | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-media.test.ts | Media complete | access.membership_inverse | coverage.profile: 1000 → 1000 |
| test/content/growth-media.test.ts | Media complete | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-reactions.test.ts | Subject reaction slot | semantic.redirect | coverage.profile: 0 → 0 |
| test/content/growth-reactions.test.ts | Subject reaction slot | semantic.subject | coverage.profile: 4 → 4 |
| test/content/growth-reactions.test.ts | Subject reaction slot | access.membership_inverse | coverage.profile: 8192 → 8192 |
| test/content/growth-reactions.test.ts | Subject reaction slot | access.resource_grant | coverage.profile: 8210 → 8210 |
| test/content/growth-reactions.test.ts | Subject reaction slot | access.resource_role_grant | coverage.profile: 8192 → 8192 |
| test/content/growth-reactions.test.ts | Subject reaction slot | access.resource_denial | coverage.profile: 8192 → 8192 |
| test/content/growth-reactions.test.ts | Subject reaction slot | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-reactions.test.ts | Subject reaction relay | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-media.test.ts | Media reservation and state reads | access.membership_inverse | coverage.profile: 1000 → 1000 |
| test/content/growth-media.test.ts | Post media claim | access.membership_inverse | coverage.profile: 1000 → 1000 |
| test/content/growth-media.test.ts | Post media claim | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-media.test.ts | Cover reference read and claim | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-media.test.ts | Image publication | core.partition | coverage.profile: 4096 → 4096 |
| test/community/growth-join.test.ts | Add a Realm member | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-subject-threads.test.ts | Subject thread page | semantic.subject | coverage.profile: 1 → 1 |
| test/content/growth-subject-threads.test.ts | Subject thread page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-subject-threads.test.ts | Subject thread page | access.resource_grant | coverage.profile: 0 → 0 |
| test/content/growth-subject-threads.test.ts | Subject thread page | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/growth-subject-threads.test.ts | Subject thread page | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/growth-subject-threads.test.ts | Subject thread page | content.thread | coverage.profile: 0 → 0 |
| test/content/growth-media.test.ts | Collection per object | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-media.test.ts | Imported image processing | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-threads.test.ts | Review creation with vote citation | access.account | coverage.profile: 1003 → 1003 |
| test/content/growth-threads.test.ts | Review creation with vote citation | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/growth-threads.test.ts | Review creation with vote citation | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-threads.test.ts | Review creation with vote citation | rating.vote | coverage.profile: 15 → 15 |
| test/content/imported-fields.test.ts | imported changed documents | content.imported_field | coverage.profile: 6 → 6 |
| test/content/growth-threads.test.ts | Thread creation with first post | access.account | coverage.profile: 1003 → 1003 |
| test/content/growth-threads.test.ts | Thread creation with first post | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/growth-threads.test.ts | Thread creation with first post | core.partition | coverage.profile: 4096 → 4096 |
| test/content/image-job.test.ts | image job fixed input and two outputs | core.partition | coverage.profile: 4096 → 4096 |
| test/content/image-job.test.ts | image job fixed input and two outputs | editorial.write_basis | coverage.profile: 0 → 0 |
| test/content/image-job.test.ts | image job fixed input and two outputs | core.receipt | coverage.profile: 0 → 0 |
| test/content/growth-threads.test.ts | Reply | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-threads.test.ts | Reply | access.account | coverage.profile: 1003 → 1003 |
| test/content/growth-threads.test.ts | Reply | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/http.test.ts | content HTTP bounded page with production Access and hot-partition distractors | core.partition | coverage.profile: 4096 → 4096 |
| test/content/http.test.ts | content HTTP bounded page with production Access and hot-partition distractors | content.reaction_total | coverage.profile: 0 → 0 |
| test/content/media-http.test.ts | media exact variant and current independent container chain decision | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-http.test.ts | media exact variant and current independent container chain decision | content.board | coverage.profile: 2 → 2 |
| test/content/media-http.test.ts | media exact variant and current independent container chain decision | access.resource_role_grant | coverage.profile: 12 → 12 |
| test/content/media-http.test.ts | media exact variant and current independent container chain decision | access.resource_denial | coverage.profile: 1 → 1 |
| test/content/media-http.test.ts | media exact variant and current independent container chain decision | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/growth-threads.test.ts | Post edit (new revision) | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-threads.test.ts | Post edit (new revision) | access.account | coverage.profile: 1003 → 1003 |
| test/content/growth-threads.test.ts | Post edit (new revision) | access.membership_inverse | coverage.profile: 500 → 500 |
| test/content/media-import-finalize.test.ts | native composite media creation | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-threads.test.ts | Thread read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | access.account | coverage.profile: 2 → 2 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | access.write_rate_counter | coverage.profile: 3 → 3 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | access.resource_grant | coverage.profile: 2 → 2 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | semantic.context | coverage.profile: 1 → 1 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | content.source_fences | coverage.profile: 0 → 0 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | semantic.subject | coverage.profile: 1 → 1 |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | content.media_variant | coverage.profile: 0 → 0 |
| test/content/growth-threads.test.ts | Post read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/kernel-clock.test.ts | kernel clock native command and content pages | access.write_rate_counter | coverage.profile: 1 → 1 |
| test/content/kernel-clock.test.ts | kernel clock native command and content pages | core.partition | coverage.profile: 4096 → 4096 |
| test/content/growth-threads.test.ts | Revision read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | access.account | coverage.profile: 1 → 1 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | access.resource_grant | coverage.profile: 2 → 2 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | semantic.context | coverage.profile: 1 → 1 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | content.source_fences | coverage.profile: 0 → 0 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | semantic.subject | coverage.profile: 1 → 1 |
| test/content/media-import.test.ts | native URL import and exact reservation poll | content.media_variant | coverage.profile: 2 → 2 |
| test/content/media-import-job.test.ts | exact imported media work | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-import-job.test.ts | exact imported media work | editorial.write_basis | coverage.profile: 0 → 0 |
| test/content/media-import-job.test.ts | exact imported media work | core.receipt | coverage.profile: 0 → 0 |
| test/content/growth-threads.test.ts | Post keyset page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-parent.test.ts | native media reserve with fixed private reply ancestry | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | core.partition | coverage.profile: 4096 → 4096 |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | content.thread | coverage.profile: 3 → 3 |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | access.account | coverage.profile: 2 → 2 |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | access.resource_grant | coverage.profile: 13 → 13 |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | content.board | coverage.profile: 2 → 2 |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | content.media_variant | coverage.profile: 0 → 0 |
| test/content/growth-threads.test.ts | Revision keyset page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/neighbourhood-storage.test.ts | bounded neighbourhood probes | content.thread | coverage.profile: 1 → 1 |
| test/content/growth-threads.test.ts | Public board read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | access.account | coverage.profile: 3 → 3 |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | access.write_rate_counter | coverage.profile: 3 → 3 |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | access.resource_role_grant | coverage.profile: 46 → 46 |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | content.thread | coverage.profile: 10 → 10 |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | content.board | coverage.profile: 5 → 5 |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | core.partition | coverage.profile: 4096 → 4096 |
| test/content/new-thread-media.test.ts | new-thread media reservation | access.account | coverage.profile: 2 → 2 |
| test/content/new-thread-media.test.ts | new-thread media reservation | access.write_rate_counter | coverage.profile: 5 → 5 |
| test/content/new-thread-media.test.ts | new-thread media reservation | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/new-thread-media.test.ts | new-thread media reservation | access.resource_grant | coverage.profile: 4099 → 4099 |
| test/content/new-thread-media.test.ts | new-thread media reservation | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/new-thread-media.test.ts | new-thread media reservation | core.partition | coverage.profile: 4096 → 4096 |
| test/content/new-thread-media.test.ts | new-thread media reservation | content.board | coverage.profile: 2 → 2 |
| test/content/new-thread-media.test.ts | new-thread media reservation | content.thread | coverage.profile: 1 → 1 |
| test/content/new-thread-media.test.ts | new-thread media reservation | content.media_variant | coverage.profile: 0 → 0 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | access.account | coverage.profile: 3 → 3 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | content.thread | coverage.profile: 4 → 4 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | content.board | coverage.profile: 2 → 2 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | access.resource_grant | coverage.profile: 8 → 8 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | access.resource_role_grant | coverage.profile: 12 → 12 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | access.write_rate_counter | coverage.profile: 1 → 1 |
| test/content/point-command-admission.test.ts | Authenticated content command admission | core.partition | coverage.profile: 4096 → 4096 |
| test/content/reaction-projection.test.ts | Reaction count aggregation | core.partition | coverage.profile: 4096 → 4096 |
| test/content/operations.test.ts | author erasure initiation and status | access.account | coverage.profile: 2 → 2 |
| test/content/operations.test.ts | author erasure initiation and status | core.partition | coverage.profile: 4096 → 4096 |
| test/content/operations.test.ts | author erasure initiation and status | access.membership_inverse | coverage.profile: 1000 → 1000 |
| test/content/operations.test.ts | author erasure initiation and status | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/operations.test.ts | author erasure initiation and status | dbos.workflow_output | coverage.profile: 0 → 0 |
| test/content/operations.test.ts | author erasure initiation and status | dbos.workflow_events | coverage.profile: 0 → 0 |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | core.partition | coverage.profile: 4096 → 4096 |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | content.thread | coverage.profile: 2052 → 2052 |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | content.post | coverage.profile: 2060 → 2060 |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | content.revision | coverage.profile: 2060 → 2060 |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | content.board | coverage.profile: 2053 → 2053 |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | access.resource_grant | coverage.profile: 38 → 38 |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/read.test.ts | current board disclosure | core.partition | coverage.profile: 4096 → 4096 |
| test/content/read.test.ts | current board disclosure | access.resource_grant | coverage.profile: 6 → 6 |
| test/content/read.test.ts | current board disclosure | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/read.test.ts | current board disclosure | access.resource_denial | coverage.profile: 1 → 1 |
| test/content/read.test.ts | current board disclosure | content.thread | coverage.profile: 7 → 7 |
| test/content/reactions-http.test.ts | Post page viewer reactions | access.account | coverage.profile: 2 → 2 |
| test/content/reactions-http.test.ts | Post page viewer reactions | core.partition | coverage.profile: 4096 → 4096 |
| test/content/reactions-http.test.ts | Post page viewer reactions | content.thread | coverage.profile: 2 → 2 |
| test/content/reactions-http.test.ts | Post page viewer reactions | content.post | coverage.profile: 5 → 5 |
| test/content/reactions-http.test.ts | Post page viewer reactions | content.revision | coverage.profile: 5 → 5 |
| test/content/reactions-http.test.ts | Post page viewer reactions | content.board | coverage.profile: 3 → 3 |
| test/content/reactions-http.test.ts | Post page viewer reactions | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/reactions-http.test.ts | Post page viewer reactions | access.resource_grant | coverage.profile: 22 → 22 |
| test/content/reactions-http.test.ts | Post page viewer reactions | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/reactions-http.test.ts | Post page viewer reactions | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/reactions-http.test.ts | Post page viewer reactions | content.reaction_total | coverage.profile: 0 → 0 |
| test/content/reports-http.test.ts | report HTTP admission and create | core.partition | coverage.profile: 4096 → 4096 |
| test/content/reports-http.test.ts | report HTTP admission and create | access.resource_grant | coverage.profile: 49 → 49 |
| test/content/reports-http.test.ts | report HTTP admission and create | access.resource_role_grant | coverage.profile: 1 → 1 |
| test/content/reports-http.test.ts | report HTTP admission and create | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/erasure-workflow.test.ts | native logical author page | core.partition | coverage.profile: 4096 → 4096 |
| test/content/erasure-workflow.test.ts | native logical author page | content.media | coverage.profile: 2048 → 2048 |
| test/content/source-fence-http.test.ts | protected source fence preflight | access.account | coverage.profile: 3 → 3 |
| test/content/source-fence-http.test.ts | protected source fence preflight | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/source-fence-http.test.ts | protected source fence preflight | access.resource_grant | coverage.profile: 3 → 3 |
| test/content/source-fence-http.test.ts | protected source fence preflight | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/source-fence-http.test.ts | protected source fence preflight | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/source-fence-http.test.ts | protected source fence preflight | core.partition | coverage.profile: 4096 → 4096 |
| test/content/source-fence-http.test.ts | protected source fence preflight | semantic.context | coverage.profile: 1 → 1 |
| test/content/realm-boards.test.ts | Protected Realm member thread read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/realm-boards.test.ts | Protected Realm member thread read | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/realm-boards.test.ts | Protected Realm member thread read | content.reaction | coverage.profile: 0 → 0 |
| test/content/realm-boards.test.ts | Protected Realm member thread read | content.reaction_total | coverage.profile: 0 → 0 |
| test/content/realm-participation.test.ts | content write participation with unrelated Realms, members and bans | access.account | coverage.profile: 8 → 8 |
| test/content/realm-participation.test.ts | content write participation with unrelated Realms, members and bans | access.write_rate_counter | coverage.profile: 10 → 10 |
| test/content/realm-participation.test.ts | content write participation with unrelated Realms, members and bans | core.partition | coverage.profile: 4096 → 4096 |
| test/content/realm-participation.test.ts | content write participation with unrelated Realms, members and bans | content.board | coverage.profile: 3 → 3 |
| test/content/source-fences.test.ts | authorized exact tuple takedown | access.account | coverage.profile: 70 → 70 |
| test/content/source-fences.test.ts | authorized exact tuple takedown | access.membership_inverse | coverage.profile: 42 → 42 |
| test/content/source-fences.test.ts | authorized exact tuple takedown | access.resource_grant | coverage.profile: 40 → 40 |
| test/content/source-fences.test.ts | authorized exact tuple takedown | access.resource_role_grant | coverage.profile: 1 → 1 |
| test/content/source-fences.test.ts | authorized exact tuple takedown | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/source-fences.test.ts | authorized exact tuple takedown | core.partition | coverage.profile: 4096 → 4096 |
| test/content/source-fences.test.ts | authorized exact tuple takedown | semantic.context | coverage.profile: 1 → 1 |
| test/content/subject-thread-index.test.ts | subject thread index event | core.partition | coverage.profile: 4096 → 4096 |
| test/content/subject-thread-index.test.ts | subject thread index event | editorial.write_basis | coverage.profile: 0 → 0 |
| test/content/subject-reactions-http.test.ts | subject reaction read | access.account | coverage.profile: 2 → 2 |
| test/content/subject-reactions-http.test.ts | subject reaction read | semantic.subject | coverage.profile: 7 → 7 |
| test/content/subject-reactions-http.test.ts | subject reaction read | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/subject-reactions-http.test.ts | subject reaction read | access.resource_grant | coverage.profile: 9 → 9 |
| test/content/subject-reactions-http.test.ts | subject reaction read | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/subject-reactions-http.test.ts | subject reaction read | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/subject-reactions-http.test.ts | subject reaction read | semantic.redirect | coverage.profile: 1 → 1 |
| test/content/subject-reactions-http.test.ts | subject reaction read | content.reaction_total | coverage.profile: 2058 → 2058 |
| test/content/subject-reactions-http.test.ts | subject own reaction read | access.account | coverage.profile: 2 → 2 |
| test/content/subject-reactions-http.test.ts | subject own reaction read | semantic.subject | coverage.profile: 9 → 9 |
| test/content/subject-reactions-http.test.ts | subject own reaction read | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/subject-reactions-http.test.ts | subject own reaction read | access.resource_grant | coverage.profile: 12 → 12 |
| test/content/subject-reactions-http.test.ts | subject own reaction read | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/content/subject-reactions-http.test.ts | subject own reaction read | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/subject-reactions-http.test.ts | subject own reaction read | core.partition | coverage.profile: 4096 → 4096 |
| test/content/subject-reactions-http.test.ts | subject own reaction read | semantic.redirect | coverage.profile: 1 → 1 |
| test/content/work.test.ts | Content partition collection fixed K and Delta | core.partition | coverage.profile: 4096 → 4096 |
| test/content/subject-reactions-http.test.ts | batched subject reaction counts | content.reaction_total | coverage.profile: 10750 → 10750 |
| test/content/work.test.ts | Content collection actual Delta | content.media | coverage.profile: 4096 → 4096 |
| test/content/work.test.ts | Content collection actual Delta | core.partition | coverage.profile: 4096 → 4096 |
| test/content/work.test.ts | Content collection actual Delta | editorial.write_basis | coverage.profile: 4096 → 4096 |
| test/content/work.test.ts | Content collection actual Delta | content.media_variant | coverage.profile: 4096 → 4096 |
| test/content/write.test.ts | content write with fixed body, references and changed rows | core.partition | coverage.profile: 4096 → 4096 |
| test/content/write.test.ts | content write with fixed body, references and changed rows | access.account | coverage.profile: 3 → 3 |
| test/content/write.test.ts | content write with fixed body, references and changed rows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/content/write.test.ts | content write with fixed body, references and changed rows | access.resource_grant | coverage.profile: 4103 → 4103 |
| test/content/write.test.ts | content write with fixed body, references and changed rows | access.resource_denial | coverage.profile: 0 → 0 |
| test/content/write.test.ts | content write with fixed body, references and changed rows | content.board | coverage.profile: 2 → 2 |
| test/content/realm-boards.test.ts | Realm board listing | core.partition | coverage.profile: 4096 → 4096 |
| test/content/realm-boards.test.ts | Realm board listing | access.resource_denial | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | core.partition | coverage.profile: 4096 → 4096 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.redirect | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.revision | coverage.profile: 2 → 2 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.definition_release | coverage.profile: 1 → 1 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.context_extension_activation | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.outbound_link | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.outbound_link_count | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.candidate | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.adoption | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.retraction | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/library/growth-curator-list.test.ts | Curator public first page | access.account | coverage.profile: 2 → 2 |
| test/library/growth-curator-list.test.ts | Curator public first page | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-collections.test.ts | Delete Collection | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-collections.test.ts | Note member | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-collections.test.ts | Remove member | core.partition | coverage.profile: 4096 → 4096 |
| test/growth-request.test.ts | Cursors and seal stays within its bound as N grows | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-listing.test.ts | Member listing effect | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-personal-writes.test.ts | entry delete | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-personal-reads.test.ts | Session page at a fixed limit has constant rows and statements as sessions grow | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-personal-writes.test.ts | copy delete | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-personal-writes.test.ts | membership follow | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-published-logs.test.ts | Publish has constant rows and statements as published logs grow | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-listing.test.ts | Listing-change workflow step | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-published-logs.test.ts | Retract has constant rows and statements as published logs grow | core.partition | coverage.profile: 4096 → 4096 |
| test/imports/identity-growth.test.ts | identity public grant revoke/restore and reduced Auth scope | access.write_rate_counter | coverage.profile: 1 → 1 |
| test/imports/identity-growth.test.ts | identity public grant revoke/restore and reduced Auth scope | access.membership_inverse | coverage.profile: 0 → 0 |
| test/imports/identity-growth.test.ts | identity public grant revoke/restore and reduced Auth scope | access.resource_role_grant | coverage.profile: 1 → 1 |
| test/imports/identity-growth.test.ts | identity public grant revoke/restore and reduced Auth scope | access.resource_denial | coverage.profile: 0 → 0 |
| test/imports/identity-growth.test.ts | identity public grant revoke/restore and reduced Auth scope | core.partition | coverage.profile: 4096 → 4096 |
| test/library/growth-published-logs.test.ts | Published log page at a fixed limit has constant rows and statements as published logs grow | core.partition | coverage.profile: 4096 → 4096 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/1/sessions | library.entry | coverage.profile: 1280 → 1280 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/48/sessions | library.entry | coverage.profile: 1280 → 1280 |
| test/library/shelf-page-activity-desc-growth.test.ts | activity desc sessions | library.entry | coverage.profile: 151550 → 151550 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/1/sessions | library.entry | coverage.profile: 2304 → 2304 |
| test/rating/growth-aggregate-read.test.ts | rating aggregate read voters | rating.population_pending | coverage.profile: 0 → 0 |
| test/rating/growth-aggregate-read.test.ts | rating aggregate read voters | rating.question | coverage.profile: 1 → 1 |
| test/rating/growth-aggregate-read.test.ts | rating aggregate read voters | rating.aggregate_component | coverage.profile: 16 → 16 |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/48/sessions | library.entry | coverage.profile: 2304 → 2304 |
| test/rating/growth-own-votes.test.ts | own vote batch input 1 | access.account | coverage.profile: 4103 → 4103 |
| test/rating/growth-own-votes.test.ts | own vote batch input 48 | access.account | coverage.profile: 4104 → 4104 |
| test/rating/growth-own-votes.test.ts | own vote batch input 100 | access.account | coverage.profile: 4105 → 4105 |
| test/rating/voter-realms.test.ts | voter Realm membership | core.partition | coverage.profile: 4096 → 4096 |
| test/rating/voter-realms.test.ts | voter Realm membership | editorial.write_basis | coverage.profile: 1 → 1 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | presentation.profile_activation | coverage.profile: 1 → 1 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | core.partition | coverage.profile: 4096 → 4096 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.redirect | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.definition_release | coverage.profile: 1 → 1 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.context_extension_activation | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.outbound_link | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.outbound_link_count | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.retraction | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.adoption | coverage.profile: 0 → 0 |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | semantic.candidate | coverage.profile: 0 → 0 |
| test/semantic/account-agent-cost.test.ts | account agent ensure uses constant statements as account agents grow | semantic.redirect | coverage.profile: 0 → 0 |
| test/semantic/account-agent-cost.test.ts | account agent ensure uses constant statements as account agents grow | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/semantic/account-agent-cost.test.ts | account agent ensure uses constant statements as account agents grow | semantic.partition_subjects | coverage.profile: 4096 → 4096 |
| test/semantic/account-agent-cost.test.ts | account agent ensure uses constant statements as account agents grow | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/account-agent-cost.test.ts | account agent ensure uses constant statements as account agents grow | editorial.write_basis | coverage.profile: 0 → 0 |
| test/semantic/account-agent-cost.test.ts | account agent ensure uses constant statements as account agents grow | core.receipt | coverage.profile: 0 → 0 |
| test/semantic/account-agent-cost.test.ts | account agent ownership probe uses constant statements at targets 1, 8 and 64 | semantic.account_agent_subject | coverage.profile: 83 → 83 |
| test/search/growth-facets.test.ts | Facet counts stays within its bound as N grows | core.partition | coverage.profile: 4096 → 4096 |
| test/search/growth-facets.test.ts | Facet counts stays within its bound as N grows | semantic.retraction | coverage.profile: 0 → 0 |
| test/search/growth-facets.test.ts | Facet counts stays within its bound as N grows | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/search/growth-facets.test.ts | Facet counts stays within its bound as N grows | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/search/growth-facets.test.ts | Facet counts stays within its bound as N grows | core.outbox | coverage.profile: 12 → 12 |
| test/search/growth-facets.test.ts | type facet stays within its bound as subjects grow | core.partition | coverage.profile: 4096 → 4096 |
| test/search/growth-facets.test.ts | type facet stays within its bound as subjects grow | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/search/growth-facets.test.ts | type facet stays within its bound as subjects grow | core.outbox | coverage.profile: 24 → 24 |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | semantic.redirect | coverage.profile: 2055 → 2055 |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | semantic.merge_member | coverage.profile: 2055 → 2055 |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | semantic.partition_subjects | coverage.profile: 4096 → 4096 |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | editorial.write_basis | coverage.profile: 10 → 10 |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | core.receipt | coverage.profile: 10 → 10 |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | semantic.inbound_link_context_count | coverage.profile: 0 → 0 |
| test/search/growth-facets.test.ts | Search hit facts | core.partition | coverage.profile: 4096 → 4096 |
| test/search/growth-facets.test.ts | Search hit facts | semantic.retraction | coverage.profile: 0 → 0 |
| test/search/growth-facets.test.ts | Search hit facts | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/search/growth-facets.test.ts | Search hit facts | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/search/growth-facets.test.ts | Search hit facts | core.outbox | coverage.profile: 36 → 36 |
| test/semantic/growth-definitions.test.ts | Definition publish | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-definitions.test.ts | Definition activate | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.subject | coverage.profile: 13 → 13 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.redirect | coverage.profile: 0 → 0 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.outbound_link_count | coverage.profile: 12 → 12 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.inbound_link_count | coverage.profile: 7 → 7 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.inbound_link | coverage.profile: 14 → 14 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.fact | coverage.profile: 49 → 49 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.retraction | coverage.profile: 0 → 0 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.adoption | coverage.profile: 0 → 0 |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | semantic.candidate | coverage.profile: 0 → 0 |
| test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | semantic.redirect | coverage.profile: 0 → 0 |
| test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | semantic.inbound_link | coverage.profile: 0 → 0 |
| test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | semantic.retraction | coverage.profile: 0 → 0 |
| test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | semantic.inbound_link_count | coverage.profile: 0 → 0 |
| test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | semantic.inbound_link_context_count | coverage.profile: 0 → 0 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as P grows | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as P grows | semantic.redirect | coverage.profile: 2000 → 2000 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as P grows | semantic.definition_release | coverage.profile: 2001 → 2001 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | core.consumer_checkpoint | coverage.profile: 4098 → 4098 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | semantic.subject | coverage.profile: 8194 → 8194 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | semantic.redirect | coverage.profile: 0 → 0 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | semantic.outbound_link_count | coverage.profile: 4098 → 4098 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | editorial.write_basis | coverage.profile: 2 → 2 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | core.receipt | coverage.profile: 2 → 2 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | semantic.inbound_link_context_count | coverage.profile: 0 → 0 |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | semantic.inbound_link_count | coverage.profile: 4098 → 4098 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as a subject's history grows | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as a subject's history grows | semantic.subject | coverage.profile: 2546 → 2546 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as a subject's history grows | semantic.redirect | coverage.profile: 2000 → 2000 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as a subject's history grows | semantic.fact | coverage.profile: 4547 → 4547 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as a subject's history grows | semantic.retraction | coverage.profile: 0 → 0 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as a subject's history grows | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as a subject's history grows | semantic.definition_release | coverage.profile: 2001 → 2001 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.context | coverage.profile: 7 → 7 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | core.consumer_checkpoint | coverage.profile: 5 → 5 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.subject | coverage.profile: 6 → 6 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.redirect | coverage.profile: 0 → 0 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.revision | coverage.profile: 22 → 22 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.fact | coverage.profile: 10 → 10 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.outbound_link | coverage.profile: 6 → 6 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.outbound_link_count | coverage.profile: 1 → 1 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.outbound_link_context_count | coverage.profile: 2 → 2 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.retraction | coverage.profile: 0 → 0 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.adoption | coverage.profile: 6 → 6 |
| test/semantic/custom-relation-types.test.ts | Context term resolution | semantic.candidate | coverage.profile: 4 → 4 |
| test/semantic/growth-search-source.test.ts | Source count stays within its bound as P grows | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-search-source.test.ts | Source count stays within its bound as P grows | semantic.partition_subjects | coverage.profile: 4096 → 4096 |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | core.consumer_checkpoint | coverage.profile: 4100 → 4100 |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | semantic.subject | coverage.profile: 8196 → 8196 |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | semantic.redirect | coverage.profile: 0 → 0 |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | semantic.outbound_link_count | coverage.profile: 4100 → 4100 |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | editorial.write_basis | coverage.profile: 4 → 4 |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | core.receipt | coverage.profile: 4 → 4 |
| test/semantic/growth-subject-page-candidates.test.ts | candidate window work stays bounded as unrelated and noindex populations grow | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.subject | coverage.profile: 8070 → 8070 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.redirect | coverage.profile: 0 → 0 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | index:inbound_link_all_present | coverage.profile: 67 → 67 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.inbound_link | coverage.profile: 67 → 67 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.inbound_link_count | coverage.profile: 3 → 3 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.inbound_link_context_count | coverage.profile: 0 → 0 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.outbound_link | coverage.profile: 67 → 67 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.fact | coverage.profile: 209 → 209 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.retraction | coverage.profile: 0 → 0 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.adoption | coverage.profile: 0 → 0 |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | semantic.candidate | coverage.profile: 0 → 0 |
| test/semantic/growth-sourced-writes.test.ts | a sourced bulk write at a fixed batch has constant rows and statements as subjects, documents and fences grow | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-sourced-writes.test.ts | a sourced bulk write at a fixed batch has constant rows and statements as subjects, documents and fences grow | content.media_variant | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.subject | coverage.profile: 11596 → 11596 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | core.consumer_checkpoint | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.redirect | coverage.profile: 2000 → 2000 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.fact | coverage.profile: 13603 → 13603 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | access.resource_grant | coverage.profile: 2000 → 2000 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | access.resource_denial | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.definition_release | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.context_extension_activation | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.outbound_link | coverage.profile: 6 → 6 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.outbound_link_count | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.retraction | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/support/growth-report.test.ts | growth report evidence | growth_report_test.constant | coverage.profile: 500 → 500 |
| test/support/growth-shadow.test.ts | five growth scales | growth_shadow_test.records | coverage.profile: 100 → 100 |
| test/support/growth.test.ts | linear write | growth_api_test.records | coverage.profile: 1 → 1 |
| test/support/growth.test.ts | constant write | growth_api_test.records | coverage.profile: 1 → 1 |
| test/work/growth-retention.test.ts | short workflow retention batch | dbos.workflow_input | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch | dbos.workflow_output | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch | dbos.operation_outputs | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch | dbos.notifications | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch | dbos.workflow_events | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch | dbos.streams | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch | dbos.workflow_events_history | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch | dbos.workflow_input | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch | dbos.workflow_output | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch | dbos.operation_outputs | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch | dbos.notifications | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch | dbos.workflow_events | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch | dbos.streams | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch | dbos.workflow_events_history | coverage.profile: 0 → 0 |
| test/semantic/growth-sourced-writes.test.ts | source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-sourced-writes.test.ts | source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/semantic/growth-sourced-writes.test.ts | source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow | semantic.context_extension_activation | coverage.profile: 0 → 0 |
| test/semantic/growth-sourced-writes.test.ts | source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow | semantic.outbound_link | coverage.profile: 0 → 0 |
| test/semantic/growth-sourced-writes.test.ts | source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow | semantic.outbound_link_count | coverage.profile: 0 → 0 |
| test/semantic/growth-sourced-writes.test.ts | source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/access/growth-evaluator.test.ts | actor evaluator G [occurrence 2] | access.principal_assignment | coverage.profile: 1 → 1 |
| test/access/growth-evaluator.test.ts | actor evaluator K | access.resource_role_grant | coverage.profile: 81922 → 81922 |
| test/access/growth-evaluator.test.ts | actor evaluator K | access.resource_denial | coverage.profile: 40964 → 40964 |
| test/access/growth-evaluator.test.ts | actor evaluator K | access.principal_assignment | coverage.profile: 2 → 2 |
| test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-fencing.test.ts | late fence page: unrelated accounts [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-fencing.test.ts | first fence page: completed and pending history [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-fencing.test.ts | late fence page: completed and pending history [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/access/growth-operator-fencing.test.ts | total operator fence fanout [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | access.membership_inverse | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.redirect | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.revision | coverage.profile: 2 → 2 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.definition_release | coverage.profile: 1 → 1 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.context_extension_activation | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.outbound_link | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.outbound_link_count | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.candidate | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.adoption | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.retraction | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | access.account | coverage.profile: 32001 → 32001 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.subject | coverage.profile: 32002 → 32002 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | access.membership_inverse | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | access.resource_grant | coverage.profile: 32002 → 32002 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | access.resource_role_grant | coverage.profile: 32000 → 32000 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | access.resource_denial | coverage.profile: 32000 → 32000 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | core.partition | coverage.profile: 4096 → 4096 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | core.consumer_checkpoint | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.redirect | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.revision | coverage.profile: 2 → 2 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.fact | coverage.profile: 32002 → 32002 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.definition_release | coverage.profile: 1 → 1 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.context_extension_activation | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.outbound_link | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.outbound_link_count | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.candidate | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.adoption | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.retraction | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Session header stays within its bound as j grows | semantic.hidden_candidate | coverage.profile: 0 → 0 |
| test/growth-request.test.ts | Cursors and seal stays within its bound as N grows [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/rating/voter-realms.test.ts | voter Realm membership [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/rating/voter-realms.test.ts | voter Realm membership [occurrence 2] | editorial.write_basis | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.subject | coverage.profile: 11596 → 11596 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.definition_activation | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | core.partition | coverage.profile: 4096 → 4096 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | core.consumer_checkpoint | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.account_agent_subject | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.redirect | coverage.profile: 2000 → 2000 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.fact | coverage.profile: 13603 → 13603 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | access.resource_grant | coverage.profile: 2000 → 2000 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | access.resource_role_grant | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | access.resource_denial | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.definition_release | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.context_extension_activation | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.outbound_link | coverage.profile: 6 → 6 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.outbound_link_count | coverage.profile: 1 → 1 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.outbound_link_context_count | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.retraction | coverage.profile: 0 → 0 |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | semantic.statement_disclosure | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch [occurrence 2] | dbos.workflow_input | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch [occurrence 2] | dbos.workflow_output | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch [occurrence 2] | dbos.operation_outputs | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch [occurrence 2] | dbos.notifications | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch [occurrence 2] | dbos.workflow_events | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch [occurrence 2] | dbos.streams | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | short workflow retention batch [occurrence 2] | dbos.workflow_events_history | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | dbos.workflow_input | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | dbos.workflow_output | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | dbos.operation_outputs | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | dbos.notifications | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | dbos.workflow_events | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | dbos.streams | coverage.profile: 0 → 0 |
| test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | dbos.workflow_events_history | coverage.profile: 0 → 0 |

## Shadow outcomes by run

| File | Check | Per-run shadow outcomes (rows / blocks / statements) |
| --- | --- | --- |
| test/anonymous-receipts-growth.test.ts | Anonymous receipt history | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-write-rate-chunk.test.ts | write-rate-chunk-admit | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-write-rate-chunk.test.ts | write-rate-chunk-retry | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people operations | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Command envelope stays within its bound as P grows | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people operations | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Authorization stays within its bound as P grows | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-payouts.test.ts | Royalty computation and payout record stays within its bound as q grows | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-write-rate-chunk.test.ts | write-rate-chunk-expiry | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people consents | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-agent-page-lookup.test.ts | agent page lookup stays within its bound as unrelated verified subjects grow | calibration-1.profile: violation / compatible / compatible; calibration-2.profile: violation / compatible / compatible; calibration-3.profile: violation / compatible / compatible; calibration-4.profile: violation / compatible / compatible; calibration-5.profile: violation / compatible / compatible; coverage.profile: violation / compatible / compatible |
| test/commerce/growth-orders.test.ts | Offer creation stays within its bound as N grows | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-agent-page-lookup.test.ts | agent page pointer write stays within its bound as subject pointers grow | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Offer read and delist stays within its bound as N grows | calibration-1.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-payouts.test.ts | Statement read and list stays within its bound as d grows | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/http.test.ts | order creation | calibration-1.profile: insufficient-evidence / compatible / compatible; calibration-2.profile: insufficient-evidence / compatible / compatible; calibration-3.profile: insufficient-evidence / compatible / compatible; calibration-4.profile: insufficient-evidence / compatible / compatible; calibration-5.profile: insufficient-evidence / compatible / compatible; coverage.profile: insufficient-evidence / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people consents | calibration-1.profile: compatible / compatible / compatible; calibration-2.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/http.test.ts | order read | calibration-2.profile: compatible / compatible / compatible; calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/http.test.ts | entitlement page | calibration-3.profile: compatible / compatible / compatible; calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/community/growth-membership.test.ts | Realm membership publish, terminal reads and role proofs | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Order creation stays within its bound as o grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Checkout and receipt recording stays within its bound as o grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | retry and replay: other people delegations | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | revoked replay: other people delegations | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-payouts.test.ts | Payout lines page stays within its bound as d grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/community/growth-space-address.test.ts | community space address claim change resolve | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Order session and transaction reads stays within its bound as o grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/content/board-projection.test.ts | board candidate upsert and fixed keyset page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history operations | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/community/growth-ban.test.ts | Realm ban, unban and list | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history operations | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/community/participation.test.ts | Realm participation | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-payouts.test.ts | Mark paid stays within its bound as q grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Order decision and settlement stays within its bound as N grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/growth-command.test.ts | New command | calibration-4.profile: violation / compatible / compatible; calibration-5.profile: violation / compatible / compatible; coverage.profile: violation / compatible / compatible |
| test/growth-command.test.ts | Idempotent replay | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history consents | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/growth-command.test.ts | Denied replay | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/growth-command.test.ts | One contention retry | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Entitlement grant change lock and read stays within its bound as e grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/growth-command.test.ts | Concurrent commands in one partition stay within their bound as concurrency grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/growth-command.test.ts | Partition state | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/content/growth-sitemap.test.ts | Sitemap boards page, listed items | calibration-4.profile: violation / compatible / compatible; calibration-5.profile: violation / compatible / compatible; coverage.profile: violation / compatible / compatible |
| test/commerce/growth-orders.test.ts | Entitlement list stays within its bound as d grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/entry-store.test.ts | Library entry write | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history consents | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/growth-events.test.ts | Batch checkpoints | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/entry-store.test.ts | Library entry page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/content/moderation.test.ts | point moderation and logical erasure | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/entry-store.test.ts | Library copy page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions sessions first | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions sessions deep | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/growth-events.test.ts | Batch log | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Webhook and commerce jobs stays within its bound as N grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions owners first | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/content/growth-sitemap.test.ts | Sitemap boards page, protected Realm content | calibration-4.profile: violation / compatible / compatible; calibration-5.profile: violation / compatible / compatible; coverage.profile: violation / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | retry and replay: same person history delegations | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions owners deep | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator.test.ts | revoked replay: same person history delegations | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/1/entries | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions history first | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/1/foreign | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/1/sessions | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/48/entries | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-sessions.test.ts | session record | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/48/foreign | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions history deep | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/null/48/sessions | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/commerce/growth-orders.test.ts | Erasure stays within its bound as N grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/entries | calibration-4.profile: compatible / compatible / compatible |
| test/content/growth-sitemap.test.ts | Sitemap threads page, listed items | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-sessions.test.ts | session complete | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/foreign | calibration-4.profile: compatible / compatible / compatible |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions units first | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/type | calibration-4.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/sessions | calibration-4.profile: compatible / compatible / compatible |
| test/presentation/growth-profiles.test.ts | Profile publish | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/entries | calibration-4.profile: compatible / compatible / compatible |
| test/library/growth-sessions.test.ts | session abandon | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/foreign | calibration-4.profile: compatible / compatible / compatible |
| test/presentation/growth-profiles.test.ts | Profile activate | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/type | calibration-4.profile: compatible / compatible / compatible |
| test/library/growth-maintenance-session-page.test.ts | maintenance sessions units deep | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/presentation/growth-profiles.test.ts | Profile read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/sessions | calibration-4.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/entries | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/presentation/growth-profiles.test.ts | Active profile lookup | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/foreign | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/rating/growth-aggregate.test.ts | rating aggregate apply | calibration-4.profile: violation / compatible / compatible; calibration-5.profile: violation / compatible / compatible; coverage.profile: violation / compatible / compatible |
| test/presentation/growth-profiles.test.ts | Profile bootstrap | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/state | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/1/sessions | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/entries | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/content/growth-sitemap.test.ts | Sitemap threads page, protected Realm content | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/rating/growth-segment-job.test.ts | rating segment page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/presentation/agent-read-kinds.test.ts | Account page read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/foreign | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/presentation/agent-read-kinds.test.ts | Account identity page read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/rating/growth-segment-job.test.ts | rating eligibility page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/state | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/presentation/agent-read-kinds.test.ts | Account discussions page read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/rating/growth-segment-job.test.ts | rating re-key page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/null/48/sessions | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/presentation/agent-read-kinds.test.ts | Account replies page read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/entries | calibration-4.profile: compatible / compatible / compatible |
| test/presentation/agent-read-kinds.test.ts | Account public collections page read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/foreign | calibration-4.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/state | calibration-4.profile: compatible / compatible / compatible |
| test/relay-effects.test.ts | effects relay discovery | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/type | calibration-4.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/1/sessions | calibration-4.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/entries | calibration-4.profile: compatible / compatible / compatible |
| test/rating/subject-merge.test.ts | rating subject merge page voters | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/foreign | calibration-4.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/state | calibration-4.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/type | calibration-4.profile: compatible / compatible / compatible |
| test/search/growth-indexing.test.ts | Reconcile | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180c8-4ea1-7460-a438-6a10ddecf04c/48/sessions | calibration-4.profile: compatible / compatible / compatible |
| test/presentation/page-read-kinds.test.ts | Reaction counts read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/search/growth-query.test.ts | Freshness | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/search/growth-indexing.test.ts | Retire | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/support/growth-capture.test.ts | duplicate insert retry | calibration-4.profile: compatible / compatible / violation; calibration-5.profile: compatible / compatible / violation; coverage.profile: compatible / compatible / violation |
| test/semantic/growth-inverse-pages.test.ts | Inverse first page | calibration-4.profile: violation / compatible / compatible; calibration-5.profile: violation / compatible / compatible; coverage.profile: violation / compatible / compatible |
| test/search/expansion.test.ts | Search and facet counts as vertical manifests grow | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-inverse-pages.test.ts | Inverse middle page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/support/growth-warmup.test.ts | warmup in place of the operation | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/support/growth-load.test.ts | stable rows under varying query timing | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/support/growth-warmup.test.ts | unmeasured runs call the operation | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/context-relations.test.ts | Context outbound relation page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/support/growth-warmup.test.ts | operation-warmed probe read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-subjects.test.ts | Subject creation stays within its bound as N grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/support/growth-warmup.test.ts | spare-state warmed probe read | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/context-relations.test.ts | Context inbound relation page | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-inverse-pages.test.ts | Projection at growing in-degree | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-subjects.test.ts | Command and receipt stays within its bound as N grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds | calibration-4.profile: violation / compatible / compatible; calibration-5.profile: violation / compatible / compatible; coverage.profile: violation / compatible / compatible |
| test/semantic/growth-subjects.test.ts | Anchored subject read stays within its bound as N grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-subjects.test.ts | Partition keyset page stays within its bound as d grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-subjects.test.ts | Item projection and related labels stays within its bound as P grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-subjects.test.ts | Batch label fill stays within its bound as P grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-subjects.test.ts | Request authorization stays within its bound as N grows | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-sessions.test.ts | session record [occurrence 2] | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-sessions.test.ts | session complete [occurrence 2] | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/library/growth-sessions.test.ts | session abandon [occurrence 2] | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/rating/subject-merge.test.ts | rating subject merge page voters [occurrence 2] | calibration-4.profile: compatible / compatible / compatible; calibration-5.profile: compatible / compatible / compatible; coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-relations.test.ts | A subject read examines the same rows whatever the number of relations it holds [occurrence 2] | calibration-4.profile: violation / compatible / compatible; calibration-5.profile: violation / compatible / compatible |
| test/content/source-fence-governance-http.test.ts | source fence governance HTTP | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/entries | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/foreign | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/type | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/1/sessions | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/entries | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/foreign | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/type | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180d0-de84-7507-be2b-6a10ee6901ef/48/sessions | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/entries | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/foreign | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/state | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/type | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/1/sessions | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/entries | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/foreign | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/state | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/type | calibration-5.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180d0-de84-7507-be2b-6a10ee6901ef/48/sessions | calibration-5.profile: compatible / compatible / compatible |
| test/access/growth-account-agent-effect.test.ts | account agent effect growth stays within its bound at [256, 1024, 4096] | coverage.profile: compatible / compatible / compatible |
| test/access/growth-account-realms.test.ts | account Realm page | coverage.profile: compatible / compatible / compatible |
| test/access/growth-account-public-views.test.ts | public view flags across partitions | coverage.profile: compatible / compatible / compatible |
| test/access/growth-agent-pages.test.ts | agent pages stay bounded as listed and unlisted accounts grow | coverage.profile: compatible / compatible / compatible |
| test/access/growth-agent-pages.test.ts | public change time stays bounded as accounts grow | coverage.profile: compatible / insufficient-evidence / compatible |
| test/access/growth-agent-verification.test.ts | agent verification request stays bounded as decided requests grow | coverage.profile: compatible / compatible / compatible |
| test/access/growth-agent-verification.test.ts | pending agent verification page stays bounded as decided requests grow | coverage.profile: compatible / compatible / compatible |
| test/access/gates/growth-discovery.test.ts | Operation discovery with unrelated account growth | coverage.profile: compatible / compatible / compatible |
| test/access/gates/growth-admission.test.ts | Gate admission with unrelated account growth | coverage.profile: compatible / compatible / compatible |
| test/access/growth-anonymous-resource-authorization.test.ts | Anonymous shared authorization and private report | coverage.profile: compatible / compatible / compatible |
| test/access/gates/growth-discovery.test.ts | Operation discovery with unrelated gate grant growth | coverage.profile: compatible / compatible / compatible |
| test/access/gates/growth-admission.test.ts | Gate admission with unrelated gate grant growth | coverage.profile: compatible / compatible / compatible |
| test/access/growth-account-handle-read.test.ts | public profile by handle | coverage.profile: compatible / compatible / compatible |
| test/access/growth-auth-barriers.test.ts | native Auth barriers | coverage.profile: compatible / compatible / compatible |
| test/access/gates/growth-admission.test.ts | Gate admission with other exposure opening growth | coverage.profile: compatible / compatible / compatible |
| test/access/gates/growth-discovery.test.ts | Operation discovery with other exposure opening growth | coverage.profile: compatible / compatible / compatible |
| test/access/growth-authenticate.test.ts | Bearer verification stays within its bound as A grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-command-admission.test.ts | generic command admission | coverage.profile: compatible / compatible / compatible |
| test/access/growth-commands.test.ts | Account read and public projection stays within its bound as A grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-command-admission.test.ts | multi-action command admission | coverage.profile: compatible / compatible / compatible |
| test/access/growth-bootstrap-governance.test.ts | governance bootstrap refusal | coverage.profile: compatible / compatible / compatible |
| test/access/growth-auth-credential-capability.test.ts | credential capability consumed-openings | coverage.profile: compatible / compatible / compatible |
| test/access/gates/growth-discovery.test.ts | Admitted groups read with unrelated accounts, gate grants, and openings | coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator-capture.test.ts | durable initiator capture delegated=false | coverage.profile: compatible / compatible / compatible |
| test/access/growth-durable-initiator-capture.test.ts | durable initiator capture delegated=true | coverage.profile: compatible / compatible / compatible |
| test/access/growth-commands.test.ts | Standing parent installation stays within its bound as Gt grows | coverage.profile: compatible / insufficient-evidence / compatible |
| test/access/growth-auth-credential-capability.test.ts | credential capability other-approvals | coverage.profile: compatible / compatible / compatible |
| test/access/growth-creation-manifest.test.ts | manifest background | coverage.profile: compatible / compatible / compatible |
| test/access/growth-creation-manifest.test.ts | manifest changed resources | coverage.profile: compatible / compatible / violation |
| test/access/growth-commands.test.ts | Creator grant initialization stays within its bound as Gt grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-auth-credential-capability.test.ts | credential capability old-auth-effects | coverage.profile: compatible / compatible / compatible |
| test/access/growth-evaluator.test.ts | actor evaluator G | coverage.profile: compatible / compatible / compatible |
| test/access/growth-auth-credential-capability.test.ts | credential capability unrelated-owners | coverage.profile: compatible / compatible / compatible |
| test/access/growth-auth-session-capability.test.ts | operator session capability | coverage.profile: compatible / compatible / compatible |
| test/access/growth-governance-reach.test.ts | platform governance reach | coverage.profile: violation / insufficient-evidence / compatible |
| test/access/growth-commands.test.ts | Grant create/change/revoke stays within its bound as Gt grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-membership-inverse-bootstrap.test.ts | membership source-cursor bootstrap | coverage.profile: compatible / compatible / compatible |
| test/access/growth-open-interval-history.test.ts | denial closed history (analyze after growth) | coverage.profile: compatible / compatible / compatible |
| test/access/growth-commands.test.ts | Delegation create/revoke/read stays within its bound as A grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-open-interval-history.test.ts | denial unrelated keys (analyze after growth) | coverage.profile: compatible / compatible / compatible |
| test/access/growth-open-interval-history.test.ts | group role grant unrelated keys (analyze after growth) | coverage.profile: compatible / compatible / compatible |
| test/access/growth-open-interval-history.test.ts | denial closed history (leave growth unanalyzed) | coverage.profile: compatible / compatible / compatible |
| test/access/growth-open-interval-history.test.ts | denial unrelated keys (leave growth unanalyzed) | coverage.profile: compatible / compatible / compatible |
| test/access/growth-open-interval-history.test.ts | group role grant unrelated keys (leave growth unanalyzed) | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-cursor.test.ts | first operator page | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-cursor.test.ts | later operator page | coverage.profile: compatible / compatible / compatible |
| test/access/growth-grant-routes.test.ts | mounted native grant routes | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts | coverage.profile: violation / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | late fence page: unrelated accounts | coverage.profile: violation / compatible / compatible |
| test/access/growth-commands.test.ts | Account and organization creation stays within its bound as A grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | first fence page: completed and pending history | coverage.profile: violation / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | late fence page: completed and pending history | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-transfer.test.ts | operator transfer with unrelated accounts and responsibilities | coverage.profile: compatible / compatible / compatible |
| test/access/growth-organization-close.test.ts | close organization | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-reinstatement.test.ts | first operator reinstatement page | coverage.profile: violation / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | total operator fence fanout | coverage.profile: violation / compatible / compatible |
| test/access/growth-commands.test.ts | Handle reserve/change/resolve/expire stays within its bound as A grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-organization-close.test.ts | organization cleanup step | coverage.profile: violation / compatible / compatible |
| test/access/growth-organization-speakers.test.ts | organization speakers page | coverage.profile: compatible / compatible / compatible |
| test/access/growth-preferences.test.ts | account preferences read | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-reinstatement.test.ts | late operator reinstatement page | coverage.profile: compatible / compatible / compatible |
| test/access/growth-commands.test.ts | Account update, coordination and fences stays within its bound as A grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-permission.test.ts | Permission preparation stays within its bound as O grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-preferences.test.ts | account preferences set | coverage.profile: compatible / compatible / compatible |
| test/access/growth-preferences.test.ts | notification permission | coverage.profile: compatible / compatible / compatible |
| test/access/growth-public-identity-read.test.ts | public identity read | coverage.profile: compatible / compatible / compatible |
| test/access/growth-rating-counter.test.ts | rating counter point read | coverage.profile: compatible / compatible / compatible |
| test/access/growth-permission.test.ts | Final permission check stays within its bound as G grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-commands.test.ts | Membership change stays within its bound as m grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-rate-tier.test.ts | account rate tier | coverage.profile: compatible / compatible / compatible |
| test/access/growth-registration-proof.test.ts | reference lookup is bounded across receipt history | coverage.profile: compatible / compatible / compatible |
| test/access/growth-resource-authorization-page.test.ts | page authorization page size | coverage.profile: compatible / compatible / compatible |
| test/access/growth-commands.test.ts | Tombstone erasure stays within its bound as m grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-resource-authorization-page.test.ts | page authorization unrelated population | coverage.profile: compatible / compatible / compatible |
| test/access/growth-resource-authorization.test.ts | stable tuple composed authorization | coverage.profile: compatible / compatible / compatible |
| test/access/growth-resource-authorization.test.ts | creation composed authorization | coverage.profile: compatible / compatible / compatible |
| test/access/growth-native-account-bindings.test.ts | ordinary native registration with all Auth and kernel statements | coverage.profile: compatible / compatible / compatible |
| test/access/growth-write-rate-route.test.ts | mounted-write-rate-1 | coverage.profile: compatible / insufficient-evidence / compatible |
| test/access/growth-write-rate-route.test.ts | mounted-write-rate-100 | coverage.profile: compatible / insufficient-evidence / compatible |
| test/access/growth-write-rate.test.ts | write-rate-1 | coverage.profile: compatible / insufficient-evidence / compatible |
| test/access/growth-write-rate.test.ts | write-rate-100 | coverage.profile: compatible / insufficient-evidence / compatible |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, owner) | coverage.profile: compatible / compatible / compatible |
| test/access/membership-history-cost.test.ts | membership mutation (ongoing member, removal) | coverage.profile: compatible / compatible / compatible |
| test/access/growth-reinstatement.test.ts | account reinstatement | coverage.profile: compatible / compatible / compatible |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, owner) | coverage.profile: compatible / compatible / compatible |
| test/access/public-floor-boundary.test.ts | public floor with bounded domain evidence | coverage.profile: compatible / compatible / compatible |
| test/access/membership-history-cost.test.ts | membership mutation (scheduled member, removal) | coverage.profile: compatible / compatible / compatible |
| test/access/write-rate-expiry.test.ts | counter-expiry | coverage.profile: compatible / compatible / compatible |
| test/command-event-cap.test.ts | New command stays within its bound as k grows | coverage.profile: compatible / compatible / compatible |
| test/access/membership-work-growth.test.ts | durable membership reserve | coverage.profile: compatible / compatible / compatible |
| test/access/membership-work-growth.test.ts | durable membership join | coverage.profile: compatible / compatible / compatible |
| test/access/growth-permission.test.ts | Parent creation authorization stays within its bound as G grows | coverage.profile: compatible / compatible / compatible |
| test/access/growth-committed-continuation.test.ts | committed cleanup continuation | coverage.profile: compatible / compatible / compatible |
| test/community/board-scheme.test.ts | Realm board scheme set and read | coverage.profile: compatible / compatible / compatible |
| test/community/growth-membership-history.test.ts | current Realm membership closed history | coverage.profile: compatible / compatible / compatible |
| test/access/membership-work-growth.test.ts | durable membership leave | coverage.profile: compatible / compatible / compatible |
| test/community/growth-sitemap.test.ts | Realm sitemap page stays within its bound as listed items grow | coverage.profile: compatible / compatible / compatible |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as listed items grow | coverage.profile: compatible / compatible / compatible |
| test/community/growth-sitemap.test.ts | Realm sitemap page stays within its bound as protected Realms grow | coverage.profile: compatible / compatible / compatible |
| test/community/growth-sitemap.test.ts | Space sitemap page stays within its bound as protected Realms grow | coverage.profile: compatible / compatible / compatible |
| test/community/growth-realm.test.ts | community Realm create | coverage.profile: compatible / compatible / compatible |
| test/community/growth-publication.test.ts | community publication page | coverage.profile: compatible / compatible / compatible |
| test/community/growth-realm.test.ts | community Realm read | coverage.profile: compatible / compatible / compatible |
| test/community/growth-publication.test.ts | community publication write | coverage.profile: compatible / compatible / compatible |
| test/community/growth-realm.test.ts | community Realm public-read | coverage.profile: compatible / compatible / compatible |
| test/community/growth-space.test.ts | community Space create | coverage.profile: compatible / compatible / compatible |
| test/community/growth-space.test.ts | community Space read | coverage.profile: compatible / compatible / compatible |
| test/community/growth-realm.test.ts | community Realm update | coverage.profile: compatible / compatible / compatible |
| test/community/growth-space.test.ts | community Space update | coverage.profile: compatible / compatible / compatible |
| test/access/membership-work-growth.test.ts | durable membership release | coverage.profile: compatible / compatible / compatible |
| test/content/author-item-index.test.ts | author item index | coverage.profile: violation / compatible / compatible |
| test/community/growth-join.test.ts | Join a Realm | coverage.profile: compatible / compatible / compatible |
| test/community/realm-votes.test.ts | Read Realm votes | coverage.profile: compatible / compatible / compatible |
| test/content/author-post-delete.test.ts | Author post delete | coverage.profile: compatible / compatible / compatible |
| test/content/authored-field-erasure.test.ts | authored document erasure | coverage.profile: violation / compatible / compatible |
| test/content/authored-fields.test.ts | authored document append and read | coverage.profile: compatible / compatible / compatible |
| test/content/authored-document-http.test.ts | authored document read | coverage.profile: violation / compatible / compatible |
| test/content/avatar-media.test.ts | avatar summaries | coverage.profile: compatible / compatible / compatible |
| test/content/avatar-media.test.ts | avatar check | coverage.profile: compatible / compatible / compatible |
| test/content/board-rank-partition.test.ts | partition board rank refresh | coverage.profile: violation / compatible / compatible |
| test/access/growth-suspension.test.ts | mounted native suspension | coverage.profile: compatible / compatible / compatible |
| test/content/author-item-reads.test.ts | Author thread page | coverage.profile: compatible / compatible / compatible |
| test/content/board-hot-http.test.ts | Hot board page | coverage.profile: compatible / compatible / compatible |
| test/content/board-ranking.test.ts | active board page | coverage.profile: compatible / compatible / compatible |
| test/content/cover-metadata.test.ts | batched cover reference | coverage.profile: compatible / compatible / compatible |
| test/content/collection-job.test.ts | partition media collection | coverage.profile: compatible / compatible / compatible |
| test/content/current-erased-read.test.ts | current erased native disclosure | coverage.profile: compatible / compatible / compatible |
| test/community/growth-join.test.ts | Leave a Realm | coverage.profile: compatible / compatible / compatible |
| test/content/boards-http.test.ts | board HTTP current query and disclosure with same-partition distractors | coverage.profile: compatible / compatible / compatible |
| test/content/document-http.test.ts | Native imported document HTTP disclosure | coverage.profile: violation / compatible / compatible |
| test/content/erasure-initiation-provenance.test.ts | author erasure initiation provenance | coverage.profile: compatible / compatible / compatible |
| test/content/erasure-job.test.ts | exact erased media prefix | coverage.profile: compatible / compatible / compatible |
| test/content/erasure-workflow-identity.test.ts | bind exact operation identity | coverage.profile: violation / insufficient-evidence / compatible |
| test/content/growth-boards.test.ts | Board projection | coverage.profile: compatible / compatible / compatible |
| test/content/growth-boards.test.ts | Board candidate page | coverage.profile: compatible / compatible / compatible |
| test/content/author-item-reads.test.ts | Author post page | coverage.profile: compatible / compatible / compatible |
| test/content/growth-lifecycle.test.ts | Imported document append and read | coverage.profile: compatible / compatible / compatible |
| test/content/growth-lifecycle.test.ts | Report admission proof | coverage.profile: compatible / compatible / compatible |
| test/content/growth-lifecycle.test.ts | Author erasure request | coverage.profile: compatible / compatible / compatible |
| test/content/growth-lifecycle.test.ts | Author erasure binding and status | coverage.profile: compatible / compatible / compatible |
| test/content/growth-lifecycle.test.ts | URL reservation | coverage.profile: compatible / compatible / compatible |
| test/content/growth-lifecycle.test.ts | URL status | coverage.profile: compatible / compatible / compatible |
| test/content/growth-media-erase.test.ts | Erase media | coverage.profile: compatible / insufficient-evidence / compatible |
| test/content/growth-lifecycle.test.ts | Source fence takedown | coverage.profile: compatible / compatible / compatible |
| test/content/growth-lifecycle.test.ts | Committed media purge | coverage.profile: compatible / compatible / compatible |
| test/content/growth-media.test.ts | Media reserve | coverage.profile: violation / compatible / compatible |
| test/content/growth-reactions.test.ts | Reaction slot | coverage.profile: compatible / compatible / compatible |
| test/content/growth-media.test.ts | Media complete | coverage.profile: violation / compatible / compatible |
| test/content/growth-reactions.test.ts | Subject reaction slot | coverage.profile: compatible / compatible / compatible |
| test/content/growth-reactions.test.ts | Subject reaction relay | coverage.profile: compatible / violation / compatible |
| test/content/board-hot-refresh.test.ts | one hot rank refresh batch | coverage.profile: compatible / compatible / compatible |
| test/content/growth-media.test.ts | Media reservation and state reads | coverage.profile: violation / compatible / compatible |
| test/content/growth-media.test.ts | Post media claim | coverage.profile: violation / compatible / compatible |
| test/content/growth-media.test.ts | Cover reference read and claim | coverage.profile: violation / compatible / compatible |
| test/content/growth-media.test.ts | Image publication | coverage.profile: violation / compatible / compatible |
| test/community/growth-join.test.ts | Add a Realm member | coverage.profile: compatible / compatible / compatible |
| test/content/growth-media.test.ts | Collection selection | coverage.profile: violation / compatible / compatible |
| test/content/growth-subject-threads.test.ts | Subject thread page | coverage.profile: compatible / compatible / compatible |
| test/content/growth-media.test.ts | Collection per object | coverage.profile: violation / compatible / compatible |
| test/content/growth-media.test.ts | Imported image processing | coverage.profile: violation / compatible / compatible |
| test/content/growth-media.test.ts | Source fence check | coverage.profile: compatible / compatible / compatible |
| test/content/erasure-workflow.test.ts | affected erasure revisions | coverage.profile: compatible / compatible / compatible |
| test/content/growth-threads.test.ts | Review creation with vote citation | coverage.profile: compatible / compatible / compatible |
| test/content/erasure-workflow.test.ts | native content erasure pages | coverage.profile: compatible / compatible / compatible |
| test/content/imported-fields.test.ts | imported changed documents | coverage.profile: violation / compatible / compatible |
| test/content/imported-fields.test.ts | imported field append/read | coverage.profile: compatible / insufficient-evidence / compatible |
| test/content/growth-threads.test.ts | Thread creation with first post | coverage.profile: compatible / compatible / compatible |
| test/content/image-job.test.ts | image job fixed input and two outputs | coverage.profile: compatible / compatible / compatible |
| test/content/growth-threads.test.ts | Reply | coverage.profile: compatible / compatible / compatible |
| test/content/http.test.ts | content HTTP bounded page with production Access and hot-partition distractors | coverage.profile: compatible / compatible / compatible |
| test/content/media-http.test.ts | media exact variant and current independent container chain decision | coverage.profile: violation / compatible / compatible |
| test/content/growth-threads.test.ts | Post edit (new revision) | coverage.profile: compatible / compatible / compatible |
| test/content/media-import-finalize.test.ts | native composite media creation | coverage.profile: compatible / compatible / compatible |
| test/content/growth-threads.test.ts | Thread read | coverage.profile: compatible / compatible / compatible |
| test/content/media-import-http.test.ts | HTTP native media import and protected point poll | coverage.profile: violation / compatible / compatible |
| test/content/growth-threads.test.ts | Post read | coverage.profile: compatible / compatible / compatible |
| test/content/kernel-clock.test.ts | kernel clock native command and content pages | coverage.profile: compatible / compatible / compatible |
| test/content/growth-threads.test.ts | Revision read | coverage.profile: compatible / compatible / compatible |
| test/content/media-import.test.ts | native URL import and exact reservation poll | coverage.profile: violation / compatible / compatible |
| test/content/media-import-job.test.ts | exact imported media work | coverage.profile: violation / compatible / compatible |
| test/content/growth-threads.test.ts | Post keyset page | coverage.profile: compatible / compatible / compatible |
| test/content/media-parent.test.ts | native media reserve with fixed private reply ancestry | coverage.profile: compatible / compatible / compatible |
| test/content/media-storage.test.ts | media collection route seeks | coverage.profile: compatible / compatible / compatible |
| test/content/media-state.test.ts | media reserve complete reservation and same-transaction claim | coverage.profile: compatible / compatible / compatible |
| test/content/growth-threads.test.ts | Revision keyset page | coverage.profile: compatible / compatible / compatible |
| test/content/neighbourhood-storage.test.ts | bounded neighbourhood probes | coverage.profile: violation / compatible / compatible |
| test/content/neighbourhood-storage.test.ts | hot partition scan | coverage.profile: violation / violation / compatible |
| test/content/growth-threads.test.ts | Public board read | coverage.profile: compatible / compatible / compatible |
| test/content/moderation-http.test.ts | Realm-authorized moderation HTTP point command including current Access and same-partition history | coverage.profile: violation / compatible / compatible |
| test/content/operation-storage.test.ts | operation identity and author endpoints | coverage.profile: violation / insufficient-evidence / compatible |
| test/content/post-pages.test.ts | Native post candidates | coverage.profile: compatible / compatible / compatible |
| test/content/new-thread-media.test.ts | new-thread media reservation | coverage.profile: compatible / compatible / compatible |
| test/content/post-revise-precondition.test.ts | post revise precondition and revisedAt read | coverage.profile: violation / compatible / compatible |
| test/content/point-command-admission.test.ts | Authenticated content command admission | coverage.profile: compatible / compatible / compatible |
| test/content/reaction-projection.test.ts | Reaction count aggregation | coverage.profile: compatible / compatible / compatible |
| test/content/operations.test.ts | author erasure initiation and status | coverage.profile: compatible / compatible / compatible |
| test/content/reaction-counts-http.test.ts | Post page reaction counts | coverage.profile: compatible / compatible / compatible |
| test/content/realm-of-item.test.ts | Realm of a thread and a post | coverage.profile: compatible / compatible / compatible |
| test/content/read.test.ts | current board disclosure | coverage.profile: violation / compatible / compatible |
| test/content/reactions-http.test.ts | Post page viewer reactions | coverage.profile: compatible / compatible / compatible |
| test/content/reports-http.test.ts | report HTTP admission and create | coverage.profile: violation / compatible / compatible |
| test/content/erasure-workflow.test.ts | native logical author page | coverage.profile: compatible / compatible / compatible |
| test/content/relays.test.ts | content native enqueue fixed source and changed set | coverage.profile: compatible / compatible / compatible |
| test/content/revision-pages.test.ts | native revision parent-prefix seek | coverage.profile: compatible / compatible / compatible |
| test/content/source-fence-storage.test.ts | exact source fence batch | coverage.profile: insufficient-evidence / compatible / compatible |
| test/content/source-fence-http.test.ts | protected source fence preflight | coverage.profile: compatible / compatible / compatible |
| test/content/realm-boards.test.ts | Protected Realm member thread read | coverage.profile: compatible / compatible / compatible |
| test/content/realm-participation.test.ts | content write participation with unrelated Realms, members and bans | coverage.profile: compatible / compatible / compatible |
| test/content/source-fences.test.ts | authorized exact tuple takedown | coverage.profile: compatible / compatible / compatible |
| test/content/subject-thread-index.test.ts | subject thread index event | coverage.profile: compatible / compatible / compatible |
| test/content/subject-reactions-http.test.ts | subject reaction read | coverage.profile: compatible / compatible / compatible |
| test/content/subject-reactions-http.test.ts | subject own reaction read | coverage.profile: compatible / compatible / compatible |
| test/content/work.test.ts | Content partition collection fixed K and Delta | coverage.profile: compatible / compatible / compatible |
| test/content/subject-reactions-http.test.ts | batched subject reaction counts | coverage.profile: compatible / compatible / compatible |
| test/content/work.test.ts | Content collection actual Delta | coverage.profile: compatible / compatible / compatible |
| test/content/write.test.ts | content write with fixed body, references and changed rows | coverage.profile: compatible / compatible / compatible |
| test/content/realm-boards.test.ts | Realm board listing | coverage.profile: compatible / compatible / compatible |
| test/growth-effects.test.ts | Effect enqueue | coverage.profile: compatible / compatible / compatible |
| test/growth-request.test.ts | Admission stays within its bound as N grows | coverage.profile: compatible / compatible / compatible |
| test/library/collection-store.test.ts | Collection member access | coverage.profile: compatible / compatible / compatible |
| test/growth-effects.test.ts | Effect persistence | coverage.profile: compatible / compatible / compatible |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows | coverage.profile: compatible / compatible / compatible |
| test/library/growth-bulk-outcome-page.test.ts | Bulk outcomes all first page | coverage.profile: compatible / compatible / compatible |
| test/library/growth-bulk-outcome-page.test.ts | Bulk outcomes all deep page | coverage.profile: compatible / compatible / compatible |
| test/library/growth-bulk-outcome-page.test.ts | Bulk outcomes applied first page | coverage.profile: compatible / compatible / compatible |
| test/library/growth-bulk-outcome-page.test.ts | Bulk outcomes applied deep page | coverage.profile: compatible / compatible / compatible |
| test/library/growth-curator-list.test.ts | Curator public first page | coverage.profile: compatible / compatible / compatible |
| test/library/growth-collections.test.ts | Delete Collection | coverage.profile: compatible / compatible / compatible |
| test/library/growth-collections.test.ts | Note member | coverage.profile: compatible / compatible / compatible |
| test/library/growth-collections.test.ts | Remove member | coverage.profile: compatible / compatible / compatible |
| test/growth-request.test.ts | Cursors and seal stays within its bound as N grows | coverage.profile: compatible / compatible / compatible |
| test/library/growth-collections.test.ts | Collection read | coverage.profile: compatible / compatible / compatible |
| test/library/growth-listing.test.ts | Member listing effect | coverage.profile: compatible / insufficient-evidence / compatible |
| test/library/growth-personal-reads.test.ts | Session read has constant rows and statements as sessions grow | coverage.profile: compatible / compatible / compatible |
| test/library/growth-personal-writes.test.ts | entry delete | coverage.profile: compatible / compatible / compatible |
| test/library/growth-personal-reads.test.ts | Session page at a fixed limit has constant rows and statements as sessions grow | coverage.profile: compatible / compatible / compatible |
| test/library/growth-personal-writes.test.ts | copy delete | coverage.profile: compatible / compatible / compatible |
| test/library/growth-personal-reads.test.ts | Entry read has constant rows and statements as entries grow | coverage.profile: compatible / compatible / compatible |
| test/library/growth-personal-writes.test.ts | membership follow | coverage.profile: compatible / compatible / compatible |
| test/library/growth-sitemap-discovery.test.ts | Collection sitemap discovery cost stays bounded as public and hidden Collections grow (hidden rows, first page, budget 20) | coverage.profile: compatible / compatible / compatible |
| test/library/growth-sitemap-discovery.test.ts | Collection sitemap discovery cost stays bounded as public and hidden Collections grow (hidden rows, continuation page, budget 20) | coverage.profile: compatible / compatible / compatible |
| test/library/growth-published-logs.test.ts | Publish has constant rows and statements as published logs grow | coverage.profile: compatible / compatible / compatible |
| test/library/growth-personal-reads.test.ts | Copy read has constant rows and statements as copies grow | coverage.profile: compatible / compatible / compatible |
| test/library/growth-listing.test.ts | Listing-change workflow step | coverage.profile: compatible / compatible / compatible |
| test/library/growth-sitemap-discovery.test.ts | Collection sitemap discovery cost stays bounded as public and hidden Collections grow (hidden rows, first page, budget 4000) | coverage.profile: compatible / compatible / compatible |
| test/library/progress-store.test.ts | Library unit add | coverage.profile: compatible / compatible / compatible |
| test/library/growth-sitemap-discovery.test.ts | Collection sitemap discovery cost stays bounded as public and hidden Collections grow (hidden rows, continuation page, budget 4000) | coverage.profile: compatible / compatible / compatible |
| test/library/progress-store.test.ts | Library unit page | coverage.profile: compatible / compatible / compatible |
| test/library/growth-published-logs.test.ts | Retract has constant rows and statements as published logs grow | coverage.profile: compatible / compatible / compatible |
| test/library/growth-personal-reads.test.ts | Follow read has constant rows and statements as follows grow | coverage.profile: compatible / compatible / compatible |
| test/library/progress-store.test.ts | Library change page | coverage.profile: compatible / compatible / compatible |
| test/library/growth-sitemap-discovery.test.ts | Collection sitemap discovery cost stays bounded as public and hidden Collections grow (public rows, first page, budget 20) | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-active-growth.test.ts | active probes, 1 subjects | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-asc-growth.test.ts | activity ascending matching limit 1 | coverage.profile: compatible / compatible / compatible |
| test/imports/identity-growth.test.ts | identity public grant revoke/restore and reduced Auth scope | coverage.profile: compatible / compatible / compatible |
| test/library/growth-sitemap-discovery.test.ts | Collection sitemap discovery cost stays bounded as public and hidden Collections grow (public rows, continuation page, budget 20) | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-desc-growth.test.ts | activity desc qualifying | coverage.profile: compatible / compatible / compatible |
| test/library/growth-published-logs.test.ts | Published log read has constant rows and statements as published logs grow | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-asc-growth.test.ts | activity ascending matching limit 48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-asc-growth.test.ts | activity ascending state limit 1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-desc-growth.test.ts | activity desc foreign | coverage.profile: compatible / compatible / compatible |
| test/library/growth-sitemap-discovery.test.ts | Collection sitemap discovery cost stays bounded as public and hidden Collections grow (public rows, first page, budget 4000) | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-asc-growth.test.ts | activity ascending state limit 48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-asc-growth.test.ts | activity ascending type limit 1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-desc-growth.test.ts | activity desc state | coverage.profile: compatible / compatible / compatible |
| test/library/growth-sitemap-discovery.test.ts | Collection sitemap discovery cost stays bounded as public and hidden Collections grow (public rows, continuation page, budget 4000) | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/1/entries | coverage.profile: compatible / compatible / compatible |
| test/library/growth-published-logs.test.ts | Published log page at a fixed limit has constant rows and statements as published logs grow | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-asc-growth.test.ts | activity ascending type limit 48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/1/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-asc-growth.test.ts | activity ascending foreign limit 1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/1/type | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-active-growth.test.ts | active probes, 48 subjects | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/1/sessions | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/null/1/eligible | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/48/entries | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-desc-growth.test.ts | activity desc type | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-asc-growth.test.ts | activity ascending foreign limit 48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/48/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/48/type | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc private/null/false/1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc null/01a180ec-47e2-7548-a950-6a10e4be3471/48/sessions | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-activity-desc-growth.test.ts | activity desc sessions | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/null/1/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc private/null/false/48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/null/48/eligible | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc private/null/true/1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/1/entries | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/1/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc private/null/true/48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/null/48/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/1/state | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/1/type | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/10000000-0000-7000-8000-6a3000000003/1/eligible | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc private/planned/false/1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/1/sessions | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/48/entries | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/48/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc private/planned/false/48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/48/state | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/10000000-0000-7000-8000-6a3000000003/1/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/48/type | coverage.profile: compatible / compatible / compatible |
| test/rating/growth-aggregate-read.test.ts | rating aggregate read voters | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-created-asc-growth.test.ts | created asc planned/01a180ec-47e2-7548-a950-6a10e4be3471/48/sessions | coverage.profile: compatible / compatible / compatible |
| test/rating/growth-aggregate-read.test.ts | rating aggregate read populations | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc private/planned/true/1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/10000000-0000-7000-8000-6a3000000003/1/filtered | coverage.profile: compatible / compatible / compatible |
| test/rating/growth-own-votes.test.ts | own vote batch input 1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc private/planned/true/48 | coverage.profile: compatible / compatible / compatible |
| test/rating/growth-own-votes.test.ts | own vote batch input 48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/10000000-0000-7000-8000-6a3000000003/48/eligible | coverage.profile: compatible / compatible / compatible |
| test/rating/growth-own-votes.test.ts | own vote batch input 100 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc excluded/null/false/1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc excluded/null/false/48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/10000000-0000-7000-8000-6a3000000003/48/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc excluded/null/true/1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc excluded/null/true/48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc null/10000000-0000-7000-8000-6a3000000003/48/filtered | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc excluded/planned/false/1 | coverage.profile: compatible / compatible / compatible |
| test/rating/voter-realms.test.ts | voter Realm membership | coverage.profile: violation / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/null/1/eligible | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc excluded/planned/false/48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc excluded/planned/true/1 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/null/1/foreign | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-desc-growth.test.ts | finished desc excluded/planned/true/48 | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/null/1/filtered | coverage.profile: compatible / compatible / compatible |
| test/presentation/growth-pages.test.ts | Page read stays within its bound as N grows | coverage.profile: compatible / compatible / insufficient-evidence |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/null/48/eligible | coverage.profile: compatible / compatible / compatible |
| test/semantic/account-agent-cost.test.ts | account agent ensure uses constant statements as account agents grow | coverage.profile: insufficient-evidence / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/null/48/foreign | coverage.profile: compatible / compatible / compatible |
| test/semantic/account-agent-cost.test.ts | account agent ownership probe uses constant statements at targets 1, 8 and 64 | coverage.profile: compatible / compatible / compatible |
| test/search/growth-facets.test.ts | Facet counts stays within its bound as N grows | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/null/48/filtered | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/10000000-0000-7000-8000-6a3000000003/1/eligible | coverage.profile: compatible / compatible / compatible |
| test/search/growth-facets.test.ts | type facet stays within its bound as subjects grow | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/10000000-0000-7000-8000-6a3000000003/1/foreign | coverage.profile: compatible / compatible / compatible |
| test/semantic/agent-verification-reversal.test.ts | verification reversal growth stays flat across survivor in-degree | coverage.profile: compatible / compatible / compatible |
| test/search/growth-facets.test.ts | Search hit facts | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/10000000-0000-7000-8000-6a3000000003/1/filtered | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/10000000-0000-7000-8000-6a3000000003/48/eligible | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-definitions.test.ts | Definition publish | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/10000000-0000-7000-8000-6a3000000003/48/foreign | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-definitions.test.ts | Definition activate | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-definitions.test.ts | Definition read | coverage.profile: compatible / compatible / compatible |
| test/semantic/graph-read.test.ts | a graph read costs the same whatever the size of the graph beyond its bounds | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-definitions.test.ts | Active definition lookup | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-definitions.test.ts | Definition bootstrap | coverage.profile: compatible / compatible / compatible |
| test/library/shelf-page-finished-asc-growth.test.ts | finished asc planned/10000000-0000-7000-8000-6a3000000003/48/filtered | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-definitions.test.ts | Typed validation | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-private-statements.test.ts | public inverse rows stay flat with private pen-name links | coverage.profile: violation / compatible / compatible |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as P grows | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-key-reemit.test.ts | holder key re-emission | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-reads.test.ts | Batch label fill stays within its bound as its partition grows | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-search-source.test.ts | Source snapshot stays within its bound as a subject's history grows | coverage.profile: compatible / compatible / compatible |
| test/semantic/custom-relation-types.test.ts | Context term resolution | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-search-source.test.ts | Source count stays within its bound as P grows | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-key-reemit.test.ts | target key re-emission | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-subject-page-candidates.test.ts | candidate window work stays bounded as unrelated and noindex populations grow | coverage.profile: compatible / compatible / compatible |
| test/semantic/relation-page-summaries.test.ts | a relation page's summaries are bounded by partitions touched | coverage.profile: compatible / compatible / compatible |
| test/support/growth-background.test.ts | background poller | coverage.profile: compatible / compatible / compatible |
| test/support/growth-background.test.ts | background poller [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/support/growth-background.test.ts | background poller [occurrence 3] | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-sourced-writes.test.ts | a sourced bulk write at a fixed batch has constant rows and statements as subjects, documents and fences grow | coverage.profile: compatible / compatible / compatible |
| test/support/growth-catalog.test.ts | catalog growth | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows | coverage.profile: compatible / compatible / compatible |
| test/support/growth-dbos-vacuum.test.ts | growth without DBOS tables | coverage.profile: compatible / compatible / compatible |
| test/support/growth-dbos-vacuum.test.ts | growth with DBOS tables created between repetitions | coverage.profile: compatible / compatible / compatible |
| test/support/growth-report.test.ts | growth report evidence | coverage.profile: violation / compatible / compatible |
| test/support/growth-rule.test.ts | series constant violation | coverage.profile: violation / compatible / compatible |
| test/support/growth-rule.test.ts | series uncertain repetitions | coverage.profile: insufficient-evidence / compatible / compatible |
| test/support/growth-rule.test.ts | default step rule | coverage.profile: compatible / compatible / compatible |
| test/support/growth-rule.test.ts | environment series rule | coverage.profile: compatible / compatible / compatible |
| test/support/growth-shadow.test.ts | five growth scales | coverage.profile: compatible / compatible / compatible |
| test/support/growth-vacuum.test.ts | growth vacuum statistics | coverage.profile: compatible / compatible / compatible |
| test/support/growth-shadow.test.ts | noisy shadow growth | coverage.profile: compatible / compatible / insufficient-evidence |
| test/support/growth-shadow.test.ts | exact shadow violation | coverage.profile: compatible / compatible / violation |
| test/support/growth-background.test.ts | queued workflow attribution | coverage.profile: compatible / compatible / compatible |
| test/support/growth.test.ts | growth table scan | coverage.profile: compatible / compatible / compatible |
| test/support/growth.test.ts | growth table scan [occurrence 2] | coverage.profile: violation / compatible / compatible |
| test/support/growth.test.ts | growth table scan [occurrence 3] | coverage.profile: violation / compatible / compatible |
| test/support/growth.test.ts | linear write | coverage.profile: compatible / compatible / compatible |
| test/support/growth.test.ts | constant write | coverage.profile: violation / compatible / compatible |
| test/work/growth-retention.test.ts | short workflow retention batch | coverage.profile: compatible / compatible / compatible |
| test/work/growth-retention.test.ts | workflow retention batch | coverage.profile: violation / compatible / compatible |
| test/semantic/growth-sourced-writes.test.ts | source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow | coverage.profile: compatible / compatible / compatible |
| test/access/growth-evaluator.test.ts | actor evaluator G [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/access/growth-evaluator.test.ts | actor evaluator K | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | first fence page: unrelated accounts [occurrence 2] | coverage.profile: violation / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | late fence page: unrelated accounts [occurrence 2] | coverage.profile: violation / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | first fence page: completed and pending history [occurrence 2] | coverage.profile: violation / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | late fence page: completed and pending history [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/access/growth-operator-fencing.test.ts | total operator fence fanout [occurrence 2] | coverage.profile: violation / compatible / compatible |
| test/growth-request.test.ts | Admission stays within its bound as N grows [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/growth-request.test.ts | Request access dispatch stays within its bound as N grows [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/growth-request.test.ts | Session header stays within its bound as j grows | coverage.profile: compatible / compatible / compatible |
| test/growth-request.test.ts | Cursors and seal stays within its bound as N grows [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/rating/voter-realms.test.ts | voter Realm membership [occurrence 2] | coverage.profile: violation / compatible / compatible |
| test/semantic/growth-reads.test.ts | Batch label fill stays within its bound as its partition grows [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/semantic/growth-reads.test.ts | Anchored subject read stays within its bound as the subject's history grows [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/work/growth-retention.test.ts | short workflow retention batch [occurrence 2] | coverage.profile: compatible / compatible / compatible |
| test/work/growth-retention.test.ts | workflow retention batch [occurrence 2] | coverage.profile: compatible / violation / compatible |

## Five worst calibration points

| Metric | File | Check | Run | Scale | Reference | Need | Allowance | Need / allowance | Suggestion |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| rows | test/commerce/http.test.ts | order creation | calibration-1.profile | 1 | 103 | 22 | 22 | 1 | Within-run spread points to load or transient state noise. |
| rows | test/commerce/http.test.ts | order creation | calibration-1.profile | 8 | 218 | 22 | 22 | 1 | Within-run spread points to load or transient state noise. |
| rows | test/commerce/http.test.ts | order creation | calibration-1.profile | 64 | 676 | 22 | 22 | 1 | Within-run spread points to load or transient state noise. |
| rows | test/commerce/http.test.ts | order creation | calibration-2.profile | 1 | 103 | 22 | 22 | 1 | Within-run spread points to load or transient state noise. |
| rows | test/commerce/http.test.ts | order creation | calibration-2.profile | 8 | 218 | 22 | 22 | 1 | Within-run spread points to load or transient state noise. |

| Diagnostic | Interpretation |
| --- | --- |
| Need | Larger of run-median deviation from the across-run reference and half the within-run spread. |
| Suggestion | Compares between-run and within-run variation; count profiles alone cannot separate database-state changes from plan changes. |
| Five worst points | All five are rows for commerce order creation, at scales 1, 8 and 64 in calibration runs 1 and 2; within-run spread determines the need of 22 rows. This points to load or transient database-state noise. The counts do not identify a plan change. |
| Statement slopes | Values around 10^-16 extra statements per row are numerical zero within floating-point precision. |
