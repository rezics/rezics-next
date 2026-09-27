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

## Remaining capabilities

Management grant provisioning, Realm policy revisions and general Realm
capability retirement/recovery remain pending. A Realm must be able to select
exact published Context revisions for scoped interpretations without gaining
Context edit authority or reinterpreting members' earlier statements. Official
Realm speech requires current representation authority; hosting personal
statements never makes them Realm speech.

Joining a Realm still needs staged enrollment and effective Access admission.
Membership in an Org or Realm must not imply management of a Space or its
referenced content; ban and mute states need separate recovery rules. Routes
should resolve typed ResourceRefs through the common renderer, and removing a
route must leave other authorized uses intact. These requirements need owner
schemas, commands and tests before this page can be retired.
