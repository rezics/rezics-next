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

## Surfaces and routers

Maintainer, 2026-10-02. One Space can be two products: a Realm is a community
and a Zone is a site. Each has its own router over the same
[Space address](../product/urls-and-seo.md#durable-addresses).

- `/r/{space}` is the community router. The platform owns its routes: feed,
  about and rules, members, discussions and their threads, submissions and
  decisions. A community cannot add routes; one that wants its own pages adds a
  Zone.
- `/z/{space}` is the site router. The Zone's route table owns every path below
  it, home included. Main checks a new route path against a short reserved list
  and the existing routes, so no platform tab can shadow a Zone page. Browse and
  search are starter routes that the Zone may rename or localize.
- A Zone needs no Realm and a Realm needs no Zone. When a Space has both, the
  Zone's navigation offers the community and the community's header offers the
  site. For a Space without a community, `/r/{space}` (its home only) answers
  one 301 to the site, because sites lived under `/r` before the routers split
  and those links must keep working; its community routes (feed, members,
  discussions…) answer 404 (2026-10-03).
- Links name the Space, never a Realm or Zone capability identity; a capability
  ID in a link redirects to its Space's canonical address. Follow and Join target
  the Space ([interactions](community-interactions.md#follow-join-and-notification)),
  so one follow covers both surfaces.

One shared prefix was rejected: the fixed community tabs (`about`, `browse`,
`works`) shadowed Zone routes of the same name, a Space with both capabilities
had two homes competing for one URL, and only a site can ever bind a host.

## Visibility, listing and history

Maintainer, 2026-10-02. Who can read, who can find and what a newcomer sees are
separate settings, as XMPP's
[multi-user chat](https://xmpp.org/extensions/xep-0045.html) separates public
and hidden rooms from open and members-only rooms, and as
[Matrix](https://spec.matrix.org/v1.1/client-server-api/) separates directory
visibility from join rules and history visibility.

| Setting | Values | Decides | Applies to |
| --- | --- | --- | --- |
| Visibility | public · private | Who can read (Access) | Realm, Zone |
| Listing | listed · unlisted | Appearing in Discover, search, recommendations, suggestions and sitemaps | Realm, Zone, Agent |
| History | everything · from admission | What a new member of a private Realm reads | Realm |
| Admission | open · request · invitation; paid tiers later | How a person joins | Realm |

- Only public and listed resources are indexable; everything else carries
  `noindex` and stays out of sitemaps.
- Unlisted opens for anyone with the link and says so where it is set.
- A private Space admits only members. Outsiders see a join page with name,
  description, rules and a request action when admission is by request;
  otherwise they get the same 404 as for a missing Space.
- A change takes effect on the next read, search, sitemap shard and delivery.
  While a Space is private, non-members' follows pause; they resume if the
  person joins or the Space becomes public again.
- Creation defaults: public, listed, history everything; the creator chooses
  admission. An unlisted person keeps a working profile but leaves people search
  and suggestions.

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

Joining is one server command that admits the member and writes their Space
follow ([interactions](community-interactions.md#follow-join-and-notification)).
Membership in an Org or Realm must not imply management of a Space or its
referenced content; ban and mute states need separate recovery rules. The web
still needs to render typed route bindings through the common renderer. These
remaining requirements need owner schemas, commands and tests before this page
can be retired.
