# Realm claim approval operation binding

The bound source is `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`. This acceptance extends
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

## Measurement continuation

Keep native succession as a hard prerequisite; never substitute the stored-state orphan helper.
After the owning seam is delivered, use the shared growth observer/classifier on the real
`approveRealmClaim` operation. Grow unrelated Realms, requests, native grants and retained history
independently at 256/1024/4096, preserving the selected routed request and neighbourhood. Seed
pressure outside capture and distinguish setup, selection, command completion and receipt replay.
The Content budget remains one Realm/head lock, one exact request lock, one native owner-role
point read and two conditional updates; Accounts' authorization/grant/receipt/history envelope
must be attributed separately. Include stale-source rollback and denied/empty branches without
requester, member or history enumeration. Existing claim-review listing costs are separate.

Three-scale observations for every axis are unavailable: no measured operation or assertion has
been executed in this attempt. The eventual command is
`bun run --cwd services/kernel check test/community/growth-realm-claim-approval.test.ts`.
Native, browser and acceptance launches are deferred by the current controller instruction;
type checking does not substitute for that command. The remaining measurement work is specified
in `.temp/continuation/realm-claim-approval-growth.md`.
