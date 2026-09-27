# Realm participation and organizational authority

An organization joins a Realm by accepting a proposal from that Realm's
independently admitted manager. Two-party admission was selected because a Realm
cannot consent on behalf of the organization, and an organization's operational
roster is not its Realm participation. Leaving and suspending end the episode;
later rejoining needs fresh consent and does not erase a ban. The
[Org/Realm owner](../../services/main/src/modules/access/org-realm-participation.ts)
and [integration tests](../../tests/qa/integration/access-org-realm-api.test.ts)
carry the tuple, proposal, generation, proof and retry contracts.

Moving an independent organization uses one Access transaction across its source
and target episodes. Sequential leave and join would expose an intermediate state
that no owner intended. A move does not transfer source ownership, representation,
grants, other Realm participation or publications. The
[move tests](../../tests/qa/integration/access-org-realm-move-api.test.ts)
exercise the paired history, stale authority, rollback and recovery boundaries.

Managed authority requires an explicit grant from the organization, with a named
operation and a separate assignment ceiling. The first profile can change only
that organization's operational roster policy. Participation, catalog links and
public description edits cannot create management authority. The
[managed grant tests](../../tests/qa/integration/access-managed-organization-api.test.ts)
cover issuer and recipient proof generations, exact lifetime and revocation.

Realm publication moderation uses the Realm manager's separate permission and
the organization's exact joined episode. It suppresses only a selected local
publication; it does not edit the source, erase other Realm selections or grant
control of the organization. A finite admitted graph request may finish after
the episode ends, while a new admission cannot use that episode. The
[moderation tests](../../tests/qa/integration/organization-publication-moderation.test.ts)
and [recovery tests](../../tests/qa/fault-recovery/organization-publication-recovery.test.ts)
exercise this cross-store boundary.

## Later profiles

Realm quotas, review, paid benefits, broader administrative actions, voting and
control recovery still need explicit owner operations. Reserve and settle quota
units idempotently; a failed review compensates only its declared reservation.
Review binds exact content and policy revisions. Pending review cannot activate
new publication, while an accepted earlier version survives a later pending
version. Appeals are new attributable decisions. Pro uses the same Realm
authority and delivery rules; a sparse fixed-Pro view cannot fill with general
content. The [subscription cases](../testing/subscriptions-and-pro.md) retain
these requirements until their owner profiles are implemented and qualified.
