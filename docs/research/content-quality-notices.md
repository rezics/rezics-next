# Notification acceptance

The [notification owner contract](../../services/kernel/src/content/README.md#notifications) defines delivery,
recipient finalization, private inbox disclosure and cleanup. This page maps that contract to native checks;
registering a binding does not establish that its scenarios pass. Email and a second producer are outside this scope.

## Native boundary and fixtures

`services/kernel/test/content/notification-outcomes.test.ts` sets `CONTENT_NOTIFICATION_DRIVER` to
`notification-driver.ts` and imports the unchanged frozen `specs/content-notification-outcomes.test.ts`.
The adapter calls production `createKernel.handle`, maps response envelopes and drains committed outbox events
through the separate notification effect host. Replay uses a new consumer on the same committed sources.
`support/notification-fixtures.ts` provisions real signed credentials, native Access, public and protected Realms,
eleven distinct public readers, and separate content and account partitions. Effects begin paused.

Decision: preference fixtures use Accounts' GET/PATCH version contract; a mandatory-kind toggle must receive
Accounts' rejection instead of inserting an impossible stored preference. Each fixture credential has
`account:update` scope; that scope does not replace production authorization. Optional changes must return 200;
the mandatory `moderation_decision` patch must return 400. A preference failure belongs to Accounts, with the
HTTP response and failing assertion, rather than a Content SQL workaround.

`support/reply-notice-fixture.ts` provides native content commands, fixture-issued credentials and Access grants
for focused delivery and growth tests. Its HTTP helper preserves bodyless 204 responses. Source events come
from the production outbox. Seeded growth pressure is separate from notices whose delivery is asserted.

## Persona jobs and bindings

| Job                                             | Native binding and assertions                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Author and replier                              | Frozen reply scenario and `reply-notices.test.ts`: parent versus opening author, self suppression, source identity and replay uniqueness.                                                                                                                                                                                               |
| Eleven mentioned readers                        | Frozen mention scenario: duplicate nodes, first ten distinct accounts, later edits, opening publication and draft transition. `mention-notices.test.ts` additionally checks independent board routes and reply precedence.                                                                                                              |
| Member, protected non-member, deleted recipient | Frozen paused-delivery scenario changes membership, preferences and account state after creation and before drain; replay after restoration must not reopen suppression.                                                                                                                                                                |
| Suspended, fenced and pending recipient         | `reply-notices.test.ts` checks suspended/fenced/deleted suppression; `notice-finalization.test.ts` checks pending account or changed preference after a successful Access read, before recipient finalization.                                                                                                                          |
| Banned member                                   | `mention-notices.test.ts` checks the native Realm ban before send.                                                                                                                                                                                                                                                                      |
| Current reader                                  | `notice-inbox-http.test.ts` checks a revoked protected target; mention and reply tests check board, thread, post, ancestor and Realm denial at send time. Display uses current full-chain Access, independently of send.                                                                                                                |
| Private owner and another account               | Frozen inbox/count scenarios and `notice-inbox-http.test.ts` check ownership, opaque cursors, ordering, exact 100 versus capped 101, and forward-only markers. `notice-seen-retry.test.ts` retries the original key after another production delivery and checks that the later notice stays unread; a foreign owned point returns 404. |
| Moderator, reporter and appellant               | Frozen takedown, report-resolution and appeal cases call native moderation APIs and drain their effects; statements/deadlines/outcomes come from owner APIs even when the content is unreadable. `notice-finalization.test.ts` covers mandatory delivery with optional kinds disabled.                                                  |
| Anonymous                                       | The frozen driver requires a bearer persona; it has no anonymous fixture. Anonymous inbox HTTP rejection remains a separate native measurement to add, without inventing a bearer identity.                                                                                                                                             |
| Expired or erased recipient data                | `notices.test.ts` covers the exclusive 180-day cutoff, bounded pages, retained fresh records and another recipient's isolation; `account-erasure-notices.test.ts` covers the native erasure participant.                                                                                                                                |

Decision: preserve the frozen publication assertions and leave visibility unmapped until Content defines a native
draft publication command. Post creation publishes immediately and revision has no visibility field, so fixture-only
visibility transitions would not provide evidence. Moderation binding failures must be coordinated with the
moderation clause owner using the reached assertion and response, without replacing those scenarios.

## Cost operations and three-scale measurements

All growth checks use the shared `checkGrowth` observer/classifier for native rows, shared blocks and statements.
Constant rows/statements and logarithmic blocks retain the owning budgets. HTTP operations include authentication,
admission, Access, source reads, recipient work and response projection in the measured callback where applicable.
Fixture creation and pressure growth happen outside that callback. No planner switches or security TTL changes
are part of measurement. Reports emitted by the runner, rather than source inspection, provide measured values.

| Owning operation                                                     | Existing check and scales                                                                                                                                                                                                                                                                             | Remaining measurement                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Reply candidate selection, current Access and recipient finalization | `growth-reply-notices.test.ts`: [64, 256, 1024] posts per thread; production effect, denied and completed-suppression redrives, and a paused Accounts preference writer at the recipient partition fence.                                                                                             | None for reply finalization in this slice.                                   |
| First-ten mention selection and finalization                         | `growth-mention-notices.test.ts`: [16, 64, 256] unrelated post/revision history; fixture setup is outside observation, with ten fixed recipients and a native first-publication event.                                                                                                                | None for first-ten selection in this slice.                                  |
| Notice insertion and replay uniqueness                               | `growth-notices.test.ts`: [256, 1024, 4096] unrelated recipient/partition rows; native `writeNotices`. `growth-reply-notices.test.ts` measures a registered production effect runner at [64, 256, 1024].                                                                                              | Required moderation outcome runner costs remain in the row below.            |
| Inbox candidate range and current disclosure                         | `growth-notice-inbox.test.ts`: [256, 1024, 4096] recipient history; native HTTP list includes a production reply disclosure.                                                                                                                                                                          | None for the classified native range and disclosure operation in this slice. |
| Empty, foreign-owner, deep readable and sparse denied inbox pages    | `growth-notice-cursors.test.ts`: [256, 1024, 4096] same-recipient and other-recipient pressure; empty, private, deep, sparse, seen retry, maximum admitted ancestry and continued full-chain denial profiles.                                                                                         | None for these native page profiles in this slice.                           |
| Owned marker retry                                                   | `growth-notice-cursors.test.ts`: [256, 1024, 4096], native mark-seen HTTP including advancing, retained-frontier and foreign points; pressure is split by recipient.                                                                                                                                  | None for these marker operations in this slice.                              |
| Capped unread                                                        | `growth-notice-inbox.test.ts`: native classified empty, exact-100, capped and retained-frontier count operations at [256, 1024, 4096].                                                                                                                                                                | None for these count boundaries in this slice.                               |
| Expiry and account erasure page                                      | `growth-notices.test.ts`: [256, 1024, 4096] unrelated history; expiry/finalization cleanup, empty terminal pages and the complete native erasure participant page loop. `account-erasure-notices.test.ts` measures the complete Auth tombstone and registered Content DBOS worker at [64, 256, 1024]. | None for account-erasure worker cost in this slice.                          |
| Required takedown/report/appeal outcomes                             | Frozen native workflow scenarios cover visible outcomes; `growth-notices.test.ts` measures required takedown, report projection and appeal notice runners at [64, 256, 1024], plus bounded report resolution at the same scales.                                                                      | None for these native outcome runner costs in this slice.                    |

Decision: account-erasure worker profiles use real Auth tombstones and the registered Content DBOS worker, with account-scoped author-item pressure seeded before effect dispatch and outside measured callbacks.

## Commands and external conditions

Run from the worktree root through the owning check runner, with its normal admission and placement. Each selection
below contains at most twelve nearby test files. These are integration recipes, not recorded passing runs.

```sh
bun run --cwd services/kernel check test/content/notification-outcomes.test.ts test/content/notice-inbox-http.test.ts test/content/notice-finalization.test.ts test/content/reply-notices.test.ts test/content/mention-notices.test.ts test/content/growth-notice-inbox.test.ts test/content/growth-notices.test.ts test/content/growth-reply-notices.test.ts test/content/growth-mention-notices.test.ts
bun run --cwd services/kernel check test/content/notice-seen-retry.test.ts test/content/growth-notice-cursors.test.ts
bun run --cwd services/kernel check test/content/notices.test.ts test/content/account-erasure-notices.test.ts
```

The kernel runner supplies migrated PostgreSQL, native Auth setup, partition custody and DBOS/system-database
configuration. The notification effect host is a separate process using the fixture database and clock.
Configured compiler/check-host access and heavy-check admission are external requirements. Missing setup, queue
admission or infrastructure exit 70/75 reaches no product assertion. Keep the frozen suite intact and retain
the runner's source revision, selected command, reached assertions and artifact references when integration runs.
The capability manifest's unbound wording must only be replaced with actual executed evidence; this mapping
alone makes no pass or promotion claim.
