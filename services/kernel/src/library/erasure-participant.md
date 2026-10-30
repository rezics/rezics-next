# Library terminal participant boundary

[Deletion](../../../../docs/deletion.md#account-erasure), the [Access consumer API](../access/README.md#erasure-consumers)
and the [Library retention inventory](README.md#retention-inventory) own policy. This contract describes the
implemented registration and its deliberately incomplete proof. Whole-graph cleanup remains a launch gate.

The default `libraryWorkModule` installs `library_account_erasure` through `context.addEffects`. The real
`account-tombstoned.v1` effect enqueues `library.accountErasure` on the existing `workflows` queue with identity
`library:erasure:<accountId>`. There is one executor, no new service or coordinator, and no initiator restoration.
The account ID is never reused and Access creates exactly one terminal obligation. Each inspection checks the
current deleted/fenced native account and its committed version-1 erasure under the account partition command
and shared row locks. Missing accounts, missing obligations, unsupported versions and query failures throw;
none means **no data applies**, never unavailable or dispatch success.

## Current outcome

There is currently **no complete native no-data proof**, even for an unused actor. `bulk_target` and `bulk_effect`
have operation-leading keys, not a complete account-to-operation locator. Shared payload custody has no exact
Library producer locator/minimizer handoff. A deleted Collection can leave `collection_listing_history` without
its curator. Empty entry roots or even all the indexed probes below cannot establish absence of these roles.
Consequently the current participant records `pending` and exact blockers in durable workflow output and never
calls `acknowledgeErasure`. This is a missing-proof boundary, not a successful no-data adapter.

The worker does execute the available `purgeAccountFactsPage` primitive for entries, copies and follows. Its
`exhausted` flag proves only that page's namespace. Every page uses the current native tombstone guard, at most
100 raw indexed keys, and the native 5,000ms command deadline. Receipts atomically store each page result with
its deletes/events. The step key derives from account, kind and the last examined immutable key. A crash after
commit but before DBOS checkpoint replays that receipt; a crash before commit repeats unchanged work. DBOS stores
bounded step results/cursors and final blocker evidence. No private row payload is copied into progress. These
receipts, events and work payloads also need shared-owner disposition; they do not establish custody closure.
Shared history's adopted handoff uses typed scopes and exact locators through same-kernel-database `enqueueIntent`;
its native producer/minimizer ports are not delivered. This participant's direct work enqueue and account-bearing
workflow identity, inputs and results are conversion gaps, without a permanent retention exemption. This slice
does not invent those ports or change the Core/work adapter; derived Library rows remain Library-owned.
Each workflow segment commits at most 100 fact pages. If facts remain, its pending result records the exact next
`{kind, after}` and a segment-limit blocker. Exhausting a kind advances that position to the next kind with a null
cursor. This boundary does not invent a continuation dispatcher; a future graph implementation must resume it.

The final inspection independently probes native roots; it never deletes parents, counters or heads on the
strength of partial exhaustion. An existing immutable participant ACK is returned unchanged without purging or
reopening it. Pending workflows finish with pending evidence rather than busy-polling another participant.
A future graph implementation must explicitly resume these obligations; SUCCESS in DBOS is not erasure success.

## Applied stores and exact producer gaps

Inventory checked against `db/library/schema.sql`, its migrations, the module README and native writers:

| Actual stores / producer                                                                                                                                                    | Exact ownership route and remaining disposition                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry`, `entry_deleted`, `copy`, `follow`; `entries.ts`, `copies.ts`, `follows.ts`, `entry-retention-store.ts`                                                             | Account route; entry/follow owner PK and `copy_account_created` bound the implemented pages. Archived entry episodes remain pending despite an empty live entry page.                                                                                                                                                                         |
| `personal_label`, `label_assignment`; `label-store.ts`, `label-assignment-store.ts`                                                                                         | Account-prefix keys; assignments, soft-deleted definitions and assignment `slot_no`/`assignment_id` reservations need child-before-parent purge. No separate reservation table is asserted.                                                                                                                                                   |
| `progress_session`, `progress_unit`, `progress_change`, `progress_head`; `progress.ts`, `progress-store.ts`, `shelf-heads.ts`                                               | Owner seek finds sessions; unit/history PKs need known session. Children precede sessions; orphan heads need their own account-prefix purge.                                                                                                                                                                                                  |
| `published_log`; `published-logs.ts`                                                                                                                                        | Account page index; erase every snapshot, including published reading logs. No public log retention.                                                                                                                                                                                                                                          |
| `collection`, `collection_member`, `collection_listing_history`; `collections.ts`, `collection-store.ts`                                                                    | `collection_curator_listing` finds existing headers, including deleted ones. Member keys require the header. History has no curator after parent removal. Full classifier, child pages and de-identification are missing.                                                                                                                     |
| `canonical_source_state`, `canonical_source_fact`; `canonical-source-store.ts`                                                                                              | Collection-parent keys; factories currently throw. No completed-A retention/minimizer exists. Remove obsolete/private/pending-B generations; never evaluate a fresh private query at T. Only active completed public contribution/output A may retain immutable meaning with de-identified attribution; never keep the curator identity link. |
| `subject_collection`, `subject_collection_version`, `subject_listing`, `subject_collection_source_fence`; `listing.ts`, `listing-apply.sql`, `listing-apply.sql`, `work.ts` | Remote subject pairs/versions have exact Collection reverse indexes. Listing totals and partition fences require per-item source/target reconciliation and late-first-apply guards before parent removal. No account-home copy locator or terminal locator fence exists.                                                                      |
| `builtin_collection_reference`, `builtin_state_reference_source`; `builtin-reference-store.ts`                                                                              | Owner tuple/PK probes exist. Source children precede reference parents; no full terminal purge or repair fence.                                                                                                                                                                                                                               |
| `shelf_count`, `shelf_type_reservation`, `shelf_type_node`, `shelf_type_root`, `shelf_type_value`; shelf/type DAOs                                                          | All have owner-prefix keys. Erase zero-use and orphan data; nodes/roots precede values.                                                                                                                                                                                                                                                       |
| `type_preparation_header`, `type_preparation_progress`, `type_preparation_slot`; preparation DAOs                                                                           | Owner-prefix keys; fence publication, then progress/slots before immutable headers and type values. All staging generations need disposition.                                                                                                                                                                                                 |
| `bulk_target`, `bulk_effect`; `bulk-outcome-page.ts`, `bulk-schemas.ts`, bulk contract                                                                                      | Known-operation pages exist; account-wide operation/selection discovery does not. `bulk_effect` may be in a target home. Actor/editor/operator/acting-human provenance needs exact producer locators, not an `account_id` or JSON scan. Logical requests/selections are not asserted as additional applied tables.                            |
| `owner_write_counter`; `owner-write-sequence.ts`                                                                                                                            | Exact same-owner `(route,account_id)` PK; erase after dependent facts without native sequence allocation. Current worker leaves it pending.                                                                                                                                                                                                   |
| `fact_source_head`; native `advance_fact_source_head` triggers                                                                                                              | Exact owner PK; remove LAST after every child-delete trigger and late writer can no longer recreate it. Current worker leaves it pending.                                                                                                                                                                                                     |
| `core.receipt`, `core.outbox`, `editorial.write_basis`, DBOS workflow inputs/results/checkpoints; command/event/work producers                                              | Exact producer/store-owner minimization is missing for owner, curator, editor, operator and acting human. Relay enqueue, DBOS success and age-based retention prove no payload disposition.                                                                                                                                                   |

Profile pins are actual columns on entry/archive/copy/session rows. There is currently no applied Library pin-list,
owner candidate index or query-cache table in this schema; new stores require a disposition before release.
Logs, caches, exports, replicas, legacy ownership and backup custody remain unknown, never inferred absent.

## Locator closure and acknowledgement admission

`work.ts` listing effects and `listing.ts` commit subject-home derived copies. They do not currently write an
account-home exact locator. Access now supplies `recordLateErasureItem(tx, {accountId, participant, locator})`,
`resolveLateErasureItem({pool}, {accountId, participant, locator})` and registration through
`ERASURE_LOCATOR_EFFECTS`; the Access consumer README owns those interfaces. This slice does not import them:
the Library producer, local fence and actual per-copy minimizer are still missing. An available coordinator API
does not establish Library custody closure.
When the real locator producer lands, every locator transaction must lock the same per-account fence, which the
participant closes before paging. A copy that committed before its delayed locator must become a native late item
in that locator transaction; a closed fence permits no ordinary locator or recreated payload. Resolve only after
actual per-item disposition commits. The required coordinator frontier follows source-before-T ordering and
indexed native open locator-work rows. The relay must durably open input-free registered work BEFORE enqueue;
only successful native execution marks it done. Every other ending stays open until supported same-ID success
or explicit platform resolution after the owner handles the copy; a fork never clears the old work. DBOS history
absence, failure-time probes and retention handoff cannot prove closure. These are required coordinator semantics,
not APIs implemented or consumed by this slice. An empty page/checkpoint/timeout is never closure. The native late-effect and
in-flight locator-lock acceptance cases remain unavailable until those Library producers and dispositions land.

Once all local-role and located-item dispositions and the local fence closure actually commit, call the delivered
`acknowledgeErasure({pool}, {accountId, participant:'library', outcome})` in its **own separate account transaction**.
Use `none` only for complete native absence evidence, `erased` only after final purge commit. Do not wait for
`readErasureStatus.complete`, other participant ACKs or overall frontier completion: that creates a circular wait.
A local ACK can coexist with an open late item owned by an effect; the coordinator remains incomplete until actual
minimization/resolution and its own frontier/other-participant requirements hold. This implementation admits no
such ACK yet because its own graph and locator closure cannot be proved.

Account-T private reads/writes are a separate immediate fence: old tokens cannot regain owner commands, and direct
private/unlisted Collection reads check the current curator tombstone before disclosing header or members.

## Cost

### Terminal inspection

- Touches: account-partition envelope, exact Access obligation/account/ACK keys, and 22 fixed owner-prefix existence probes. No bulk/history/global JSON scan or full count.
- Bound: one account home, 5,000ms deadline; at most one match per indexed namespace and 22 fixed store names, less than 2KiB of probe payload. Index work is the sum of 22 logarithmic owner seeks. Missing locators are reported without scanning.
- Growth check: `test/library/erasure-participant.test.ts` exercises empty and populated native roles; full graph growth/closure remains unavailable, not a measured completion claim.

### Available fact pages

- Touches: existing account-fact page command authorization, receipt, at most 100 source keys/deletes, fact-head triggers and bounded events; each home is released before another command. No remote cleanup is claimed.
- Bound: 100 raw UUID keys (copy keys also carry one timestamp), at most 100 fixed deletion events plus one page event; cursor/page result under 512 bytes. Source result under 12KiB; row payload deletion additionally pays existing entry/copy/follow schema limits. DBOS checkpoints store only this bounded result. Workflow arguments and results obey the kernel's [4,096-byte Bounded job steps ceiling](../../README.md#bounded-job-steps). The native participant test checks the UTF-8 JSON size of the complete workflow result against that ceiling; output contains only fixed store/blocker names, bounded counters and one raw-key continuation.
- Growth check: existing `test/library/account-fact-purge-boundaries.test.ts` and `test/library/account-fact-purge.test.ts` own primitive coverage; the native participant test proves default registration, partial progress, T fences and replay without false ACK. Full final-purge/ACK crash and late-locator lock-order cases cannot be established until actual missing graph/locator APIs land.
