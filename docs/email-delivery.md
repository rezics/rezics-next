# Email delivery design

Account security/recovery and optional community email have separate purposes,
consent and suppression policies. Email is an asynchronous owner intent with
idempotent delivery, current recipient validation and an explicit uncertain-result
reconciliation path. No documentation task sends real messages.

Use a provider adapter for transactional delivery, verified sender/domain
configuration, HTML/text rendering and bounce/complaint processing. Keep credentials
server-only and narrowly scoped. Development/tests use non-delivering capture or
official test mechanisms; actual delivery is an explicit operational action.

Optional notification categories expose user preferences and unsubscribe controls;
security-critical purposes follow their own account policy. Signed preference
links, expiry and one-click subscription handling must be verified against the
elected provider/protocol before rollout. Do not reuse transactional infrastructure
for unselected marketing campaigns.

[Notifications](contracts/notifications.md) owns intent/read state and
[Account](services/account.md) owns security flows. Deployment selects provider,
origins and secret custody without assuming an existing domain setup.
