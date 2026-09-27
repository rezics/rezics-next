# Identity and Access experience

## Publishing identity

Studio has its own Agent switcher that never changes the session Agent. Settings
manage publishing defaults per task and content profile, such as the Agent for
new original Books. Publishing forms
prefill the Agent chosen by the [layer order](../contracts/identity-and-access.md#acting-identity-layers),
show it before submission and allow changing it for that operation only. When a
saved default is no longer eligible, say which Agent is used instead.

A cataloged Person/Org can exist without a controller; claiming/control admission
requires proof, not a matching name.

## Administration

Present members, groups, roles, bindings and representation as different concepts.
Common presets configure the same underlying permissions. Explain affected scope,
expiry and grantability when assigning powers. Impact preview identifies required
approval and stale-state conflicts; it never acts as authorization by itself.

Offer role presets that explicitly bundle administration and representation for
small organizations and permit separation for larger ones. Selecting an
organization subject as grant recipient differs from selecting its eligible
member set. Independent and explicitly managed organization modes explain the
Realm/parent's granted scope without implying control from participation alone.

Users choose an acting identity and task; the server resolves the proof. Do not
require users to construct graph paths. Sensitive operations expose the represented
subject, target, effective powers and required approvals while keeping private
controller information protected.

## Institutional voting

Show the entitled holder/seat, current weight, selected representative and required
approval rule. Multiple representatives operate one seat; previews and stale
revision errors must not suggest that each representative has another copy of its
weight. Keep casting, allocating units and deciding an internal organizational
position distinct, following [votes](../contracts/votes-and-references.md).

Present frozen electorate/weight rules separately from current ability to submit.
Preserve a prepared ballot when authority expires or another representative changes
it, and require refresh/reapproval for the changed revision. A proxy override
replaces the same source contribution under the declared charter.

## Recovery and failure

Preserve input on recoverable errors. Distinguish missing authority, stale grants,
unavailable Access, required independent approval and lost outcome. Recovery states
show the next allowed step without exposing other controllers' private accounts.
Session/logout/credential revocation consequences are scoped and explicit.

## Acceptance

Verify keyboard/focus/accessibility, role/group impact, restricted recipient
selectors and safe error states through scoped Storybook review at the
applicable phase. API denied cases remain mandatory.
