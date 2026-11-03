# Realm claim approval operation binding

The bound base source is `4de743f07ffdb50deec3f995df253cc0c4b3ca10`; the authored test and private
fixture are committed at `999c789875a7c8b08d0245f19d4199b384100fb1`. This acceptance extends
[Content Done-when 3 and Acceptance](../goals/content.md) and the community
[Approve Realm claim source/state Cost row](../../services/kernel/src/community/README.md#cost).
It does not establish measured growth or promotion.

## Native fixture

`test/community/growth-realm-claim-approval.test.ts` uses its private
`support/growth-realm-claim-approval-fixture.ts` and the existing `createCommunityDriver`.
That driver constructs the native Content/Auth system with production `createAccess`, starts
`src/worker.ts`, and drains its registered workflows and source event consumers. Global creation
and approval grants use the real grant HTTP command. The selected Realm is created by a newly
registered account; Auth's approved account deletion supplies the immutable erasure root.
No stored orphan state, injected event or direct succession adapter stands in for that workflow.

The first assertion after registered erasure completion requires the original Realm identity to
be orphaned at that exact root, with its deadline exactly 720 hours later. Once that prerequisite
holds, the test checks premature refusal, exact-deadline native request production and request
replay, denied approval without writes, real Accounts approval, consumed-source refusal and exact
receipt replay without additional ownership or request application.

## Missing native producer binding

Source inspection finds a narrower missing seam than the saved community text describes:
the `member_locator` migration and native projector now exist. However,
`community/account-erasure.ts:phasePage` calls `eraseAccountMembershipsPage({pool}, ...)`;
that function's Realm loop closes/purges membership and then unlinks the account locator without
calling `eraseAccountRealmOwnership`. The latter adapter exists in the same module and prepares
Accounts' committed-root authorization before applying native succession in the Realm writer.
The registered path therefore cannot establish the selected orphan episode required here.
This is source evidence of a missing prerequisite, not an executed assertion failure.

Proposed owning seam: the Community membership-erasure producer must compose the existing
`createRealmOwnershipCommands`/`eraseAccountRealmOwnership` boundary before retiring each owner
locator, retaining the locator and cursor for pending succession. Accounts must prepare its real
erasure root before Realm checkout; grant changes and Content continuity must share the writer.
Production and shared fixtures remain read-only in this acceptance slice.

## Measurement plan

Keep native succession as a hard prerequisite; never substitute the stored-state orphan helper.
After the owning seam is delivered, use the shared growth observer/classifier on the real
`approveRealmClaim` operation. Grow unrelated Realms, requests, native grants and retained history
independently at 256/1024/4096, preserving the selected routed request and neighbourhood. Seed
pressure outside capture and distinguish setup, selection, command completion and receipt replay.
The Content budget remains one Realm/head lock, one exact request lock, one native owner-role
point read and two conditional updates; Accounts' authorization/grant/receipt/history envelope
must be attributed separately. Include stale-source rollback and denied/empty branches without
requester, member or history enumeration. Existing claim-review listing costs are separate.

Decision: implement the growth proof against the documented native succession contract; keep registered Auth erasure as a hard prerequisite and defer runtime acceptance until the controller admits it after integration.

## Attempt record

Fixture binding is `test/community/growth-realm-claim-approval.test.ts` to
`test/community/support/growth-realm-claim-approval-fixture.ts` at revision
`999c789875a7c8b08d0245f19d4199b384100fb1`. The fixture creates the selected Realm through the
registered Community runtime and Auth deletion worker, then measures the real
`approveRealmClaim` with the production Access instance and shared `checkGrowth` capture. Growth
pressure is seeded through the separate growth database connection.

No runtime assertion was reached: the current controller deferred the native acceptance launch.
In particular, the registered orphan prerequisite, rollback, denied/empty, approval/replay, and
all measured-operation assertions remain unexecuted. The requested scale observations are:

| Independent axis | 256 | 1024 | 4096 |
| --- | --- | --- | --- |
| Unrelated Realms and revisions | Not observed | Not observed | Not observed |
| Unrelated claim requests | Not observed | Not observed | Not observed |
| Native resource-role grants | Not observed | Not observed | Not observed |
| Retained receipt/outbox/write-basis history | Not observed | Not observed | Not observed |

`bun run --cwd services/kernel typecheck` ran at `999c789875a7c8b08d0245f19d4199b384100fb1`
and exited 2 on diagnostics in unchanged base files; it reported none in the authored test or
fixture. One base diagnostic is `src/access/shared-history.ts(247,35): error TS2304: Cannot find
name 'commandHistoryKind'.` The native acceptance command
`bun run --cwd services/kernel check test/community/growth-realm-claim-approval.test.ts` was not
launched because the current controller defers native, browser and acceptance checks until after
integration. Type checking does not substitute for that command.
