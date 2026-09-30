# Space, Realm, Zone and curation

Space is a stable identity. Realm governs community participation and contextual
decisions; Zone governs routes, navigation and presentation. Their capabilities
can coexist on one Space without sharing lifecycle or authority. A Collection
has its own membership and visibility; mounting it in a Zone does not copy its
members or grant control of their content. A [Context](context.md) remains an
independently managed resource even when several Realms and people adopt it.

The installed `space-realm-v1` profile creates a public Space and a distinct
Realm identity with closed initial membership. It does not enroll members or
grant the creator Realm management. Realm local adoption selects an exact
eligible publication, and a local rejection suppresses Main fallback; another
Realm may choose differently. The separate `classification-context-v1` profile
binds an active Realm to a distinct Context under fixed Global inheritance.
It does not implement the adopted shared Context model. Zone configuration and
retirement use separate heads and preserve the Realm and mounted content.
Current profiles and operations live in `model/definitions/space-realm-v1.ts`,
`model/definitions/zone-capability-v1.ts` and
`services/main/src/modules/{space,zone}/`.

## Mounted routes and disclosure

Zone navigation mounts bind routes to current Resources. A Work mount resolves
as a document; a Collection mount resolves as a member index or an exact member
detail. A readable Work outside that Collection cannot resolve through its
route. The `/w/{work}` route requires the default Realm's current public
adoption. Removing a mount leaves its Collection, Works and other authorized
uses intact.

Public presentation includes readable public mounts in Structure order. Private
mounts and targets require current Access grants; private Work targets also
require `work:read` OAuth scope independently of `semantic:read`. Route and
presentation reads retry concurrent graph changes within one request budget.
Index continuations bind to the Collection's membership head and data epoch,
so unrelated writes do not expire them; a membership change requires restarting
from the first page.

The common summary reader hides protected Works and erased Work heads even
from readers with Work grants. Public Work summaries require the reviewed
selection to match the Contribution's current public publication decision and
selected draft. An earlier public decision does not make a later private
publication public. These disclosure checks also apply to MainVersion summaries.

## Remaining capabilities

Management grant provisioning, Realm policy revisions and general Realm
capability retirement/recovery remain pending. A Realm must be able to select
exact published Context revisions for scoped interpretations without gaining
Context edit authority or reinterpreting members' earlier statements. Official
Realm speech requires current representation authority; hosting personal
statements never makes them Realm speech.

Joining a Realm still needs staged enrollment and effective Access admission.
Membership in an Org or Realm must not imply management of a Space or its
referenced content; ban and mute states need separate recovery rules. The web
still needs to render typed route bindings through the common renderer. These
remaining requirements need owner schemas, commands and tests before this page
can be retired.
