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

`diary_navigation` adds at most eight owner-prefix navigation keys. Native account locks fence their creation
against terminal deletion; the appended `diary_navigation` graph phase deletes those keys, and the native probe
reports their actual presence. Expiry retires authority immediately and slot reuse bounds residual metadata.
This adds no claim about the independent shared custody gaps below.

## Current outcome

The worker now performs bounded local cleanup of entry episodes, copies, follows, progress sessions and history,
labels and assignments, published logs, owned Collections and children, built-in references, pins, shelf/type
state, preparation state, owner counters and fact-source heads. It preserves only active-public completed output,
clears its curator identity, and removes canonical source facts/state before that retention. Dynamic output is
eligible only when an exact source-state row proves a ready generation; pending generations are discarded.
Private/unlisted/deleted Collection graphs are removed child-first. Collection listing history is removed while
the owning Collection header still supplies the exact curator relation.

This local work does **not** establish a complete no-data proof or permit a participant ACK. Bulk effects may be
on target homes without an account-home locator/fence; historical subject listing destinations still require bounded source/role coverage beyond the newly admitted
live-copy domain; shared receipts/outbox/write-basis/work payloads have no complete Library producer handoff; and
deleted Collections may leave history after their curator header is gone. Logs, caches, exports, replicas and
backups also lack a complete custody inventory. The workflow records `pending` with exact blockers and does not
call `acknowledgeErasure`. Empty local probes never establish those missing roles or custody.

Each local page checks the current native tombstone in its account-partition command, touches at most 100 raw
keys, and uses the native 5,000ms deadline. Receipts atomically store page results with deletes/events. A crash
after commit but before the DBOS checkpoint replays the same receipt; a crash before commit repeats unchanged
work. Graph phases have bounded cursors and durable continuations. No private row payload is copied into progress.
The local receipt/event/work payloads still need their shared-store owners' disposition and do not establish
custody closure. This participant does not claim the direct work enqueue or account-bearing workflow identity,
inputs and results have been converted to shared-history custody.

The final inspection independently probes known native roots. It never deletes parents, counters or heads based
only on primitive exhaustion. An existing immutable participant ACK is returned unchanged without purging or
reopening it. Pending workflows return pending evidence rather than wait on another participant's ACK. DBOS
success is not erasure success.

## Applied stores and exact producer gaps

Inventory checked against `db/library/schema.sql`, its migrations, the module README and native writers:

| Actual stores / producer                                                                                                                               | Exact ownership route and remaining disposition                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry`, `entry_deleted`, `copy`, `follow`; `entries.ts`, `copies.ts`, `follows.ts`, `entry-retention-store.ts`                                        | Account route; entry/follow owner PK and `copy_account_created` bound the implemented pages. Shared/foreign producer custody remains open.                                                                                                                                                                                                                  |
| `personal_label`, `label_assignment`; `label-store.ts`, `label-assignment-store.ts`                                                                    | Account-prefix keys; assignments and soft-deleted definitions are purged child-before-parent. No separate reservation table exists.                                                                                                                                                                                                                         |
| `progress_session`, `progress_unit`, `progress_change`, `progress_head`; `progress.ts`, `progress-store.ts`, `shelf-heads.ts`                          | Owner seek finds sessions; unit/history PKs are paged by exact session. Children precede sessions; orphan heads use their own account-prefix purge.                                                                                                                                                                                                         |
| `published_log`; `published-logs.ts`                                                                                                                   | Account page index; erase every snapshot, including published reading logs. No public log retention.                                                                                                                                                                                                                                                        |
| `collection`, `collection_member`, `collection_listing_history`; `collections.ts`, `collection-store.ts`                                               | `collection_curator_listing` finds existing headers, including deleted ones. Exact child pages remove history before retention or parent removal. Orphan history with no curator header remains an unknown role.                                                                                                                                            |
| `canonical_source_state`, `canonical_source_fact`; `canonical-source-store.ts`                                                                         | Collection-parent keys; all generations and private source terms are deleted before parent disposition. Active-public output survives only if completed and is frozen in member output; no fresh query runs at T.                                                                                                                                           |
| `subject_collection`, `subject_collection_version`, `subject_listing`, `subject_collection_source_fence`; `listing.ts`, `listing-apply.sql`, `work.ts` | Remote subject pairs/versions have exact Collection reverse indexes. Listing totals and partition fences require per-item source/target reconciliation and late-first-apply guards before parent removal. The new live-copy domain enrolls per-role exact receiver/source/hold locators and permanent terminal gates; old unknown coverage remains pending. |
| `builtin_collection_reference`, `builtin_state_reference_source`; `builtin-reference-store.ts`                                                         | Owner tuple/PK probes exist. Source children precede reference parents; no full terminal purge or repair fence.                                                                                                                                                                                                                                             |
| `shelf_count`, `shelf_type_reservation`, `shelf_type_node`, `shelf_type_root`, `shelf_type_value`; shelf/type DAOs                                     | All have owner-prefix keys. Erase zero-use and orphan data; nodes/roots precede values.                                                                                                                                                                                                                                                                     |
| `type_preparation_header`, `type_preparation_progress`, `type_preparation_slot`; preparation DAOs                                                      | Owner-prefix keys; fence publication, then progress/slots before immutable headers and type values. All staging generations need disposition.                                                                                                                                                                                                               |
| `bulk_target`, `bulk_effect`; `bulk-outcome-page.ts`, `bulk-schemas.ts`, bulk contract                                                                 | Known-operation pages exist; account-wide operation/selection discovery does not. `bulk_effect` may be in a target home. Actor/editor/operator/acting-human provenance needs exact producer locators, not an `account_id` or JSON scan. Logical requests/selections are not asserted as additional applied tables.                                          |
| `owner_write_counter`; `owner-write-sequence.ts`                                                                                                       | Exact same-owner `(route,account_id)` PK; erased after dependent facts without native sequence allocation. Late writer custody remains open.                                                                                                                                                                                                                |
| `fact_source_head`; native `advance_fact_source_head` triggers                                                                                         | Exact owner PK; removed LAST after every local child-delete trigger. Late writer custody remains open.                                                                                                                                                                                                                                                      |
| `core.receipt`, `core.outbox`, `editorial.write_basis`, DBOS workflow inputs/results/checkpoints; command/event/work producers                         | Exact producer/store-owner minimization is missing for owner, curator, editor, operator and acting human. Relay enqueue, DBOS success and age-based retention prove no payload disposition.                                                                                                                                                                 |

Profile pins are actual columns on entry/archive/copy/session rows. There is currently no applied Library pin-list,
owner candidate index or query-cache table in this schema; new stores require a disposition before release.
Logs, caches, exports, replicas, legacy ownership and backup custody remain unknown, never inferred absent.

## Locator closure and acknowledgement admission

Identity source invalidation additionally retains `identity_epoch_participant_work`, `identity_epoch_source_basis`
and `owner_identity_scope`. Their account-leading local probes and the participant blocker inventory expose
these copies without treating local exhaustion as Source/receiving/control closure. Exact minimizer and late-item
custody remain required before their private links/bases can be discarded or Library can acknowledge erasure.

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

- Touches: account-partition envelope, exact Access obligation/account/ACK keys, and 25 fixed owner-prefix existence probes. No bulk/history/global JSON scan or full count.
- Bound: one account home, 5,000ms deadline; at most one match per indexed namespace and 25 fixed store names, less than 2KiB of probe payload. Index work is the sum of 25 logarithmic owner seeks. Missing locators are reported without scanning.
- Growth check: `test/library/erasure-participant.test.ts` exercises empty and populated native roles; full graph growth/closure remains unavailable, not a measured completion claim.

### Local fact and owned-graph pages

- Touches: existing account-fact page command authorization, receipt, at most 100 source keys/deletes, fact-head triggers and bounded events; each home is released before another command. No remote cleanup is claimed.
- Bound: 100 raw UUID keys (copy keys also carry one timestamp), at most 100 fixed deletion events plus one page event; cursor/page result under 512 bytes. Source result under 12KiB; row payload deletion additionally pays existing entry/copy/follow schema limits. DBOS checkpoints store only this bounded result. Workflow arguments and results obey the kernel's [4,096-byte Bounded job steps ceiling](../../README.md#bounded-job-steps). The native participant test checks the UTF-8 JSON size of the complete workflow result against that ceiling; output contains only fixed store/blocker names, bounded counters and one raw-key continuation.
- Growth check: `test/library/erasure-owned-graph-growth.test.ts` measures fixed child-page work across three owned-history scales and unrelated owners/partitions. `test/library/erasure-owned-graph.test.ts` covers default-worker local cleanup, retained public output, bounded continuation and replay. Shared-custody, late-locator lock-order and final ACK crash cases remain open until their actual producer APIs land.

## Native live-copy slice

The default Accounts erasure WorkModule now installs `access.liveCopy.recover`, while Library's ordinary work uses
its real source-hold/receiver-gate adapter. Accounts discovers `live_copy_inventory` and
`live_copy_business_inventory` under every actual retained personal role with the existing fixed 4096-home,
raw100/1 KiB locator/64 KiB page limits. Each home seal is committed after released genuine root observation and
before discovery, and the native checkpoint compares the same frontier. Minimized payload precedes inverse removal;
unresolved transition/hold/result keeps its exact locator. Receiver replay tombstones survive projection removal.
A real public pair removal decrements its aggregate once and emits the existing `subject.listed` event in the
ordinary command envelope. An older gate cannot remove a newer replacement. This body also handles a projection
that never reached ready and remains independent of Commerce financial retention and participant readiness.

The original closed History receiving families and their proofs are unchanged. These live-copy dispositions do
not certify old unknown copies, original outbox/record/SDK custody, six-driver identity effect coverage, public
retention authority, final maintenance/root or all-copy closure. The participant remains pending for its actual
remaining gaps above. The [Library identity retirement dependency](README.md#identity-retirement-dependency-retained)
retains the real unavailable page/false verifier and exhaustive same-home seal obligations; it is not replaced by
this protocol. Normal source implementation and typing are separate from deferred native/physical/privacy proof.
