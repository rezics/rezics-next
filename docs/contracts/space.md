# Space, Realm, Zone and curation

## Responsibilities

Space is a stable resource with independently admitted Realm and Zone capabilities.
Realm supplies community governance, participation and contextual decisions. Zone
supplies routes, navigation and presentation. They can coexist on one Space or
be separately identified and linked when that better expresses governance.

A Collection is curated membership/order with its own identity and visibility.
A Dynamic Collection is a versioned selection rule. Neither mounting nor listing
a resource copies its content, publishes its drafts or grants control over it.
An ordinary wiki can combine a Zone, Collections and a governing Realm.

The installed `space-realm-v1` creation profile allocates a public Space and a
distinct Realm capability identity in one product transaction. Its initial
membership policy is closed, so creation does not enroll anyone. Its review
policy requires an explicit Realm manager adoption decision on exact eligible
content; naming the creator as Space owner does not create an Access management
grant. Its publication policy declares Main Version fallback when there is no
local decision, while a local rejection must suppress fallback. The current
runtime creates and reads these identities and policy references; management
grants, local decisions, policy revisions and Zone capability creation are
separate unfinished operations.

## Context and decisions

Bind presentation, publication, governance, classification and canon roles
explicitly through [Context](context.md). A Zone can display a Realm's classifications,
ratings and adopted main-version content. A Realm has multiple rating questions;
its ID alone does not identify a scale/population/cadence.

Resource identity, Main Version and contribution identities are shared across
Spaces. Local acceptance, suppression and chosen versions are independent. Removing
a route or membership preserves other authorized uses. Retiring one Space
capability cannot silently retire the other or erase the common identity.

## Operations

| Command | Result and guards |
| --- | --- |
| Create Space | Allocate stable identity, owner and selected capabilities; no implicit Org parent. |
| Configure Realm | Version rules, membership policy and context defaults; validate assignment ceilings. |
| Configure Zone | Update typed routes/presentation with expected revision and host/context constraints. |
| Mount collection/resource | Create explicit occurrence; verify allowed disclosure without transferring ownership. |
| Adopt content | Select eligible contribution/revision under a local publication context. |
| Retire/recover capability | Check dependents and current authority; preserve other capabilities and references. |

Joining a Realm uses staged enrollment and effective Access admission. A community
member is not automatically a manager of the Space or its referenced content.
Org membership does not imply participation in every Realm. Ban/mute states are
independent of leave/rejoin and use defined recovery rules.

## Routes and dynamic collections

Routes resolve to ResourceRef plus typed context, then invoke the common renderer.
They can follow Main Version selection or pin a fixed selection. A body/Block AST
is not the route identity. [Addressing](addressing.md) owns uniqueness and redirects.

Dynamic collection reads compile a bounded Jena query using admitted graph and
full-text operations. They do not create stored memberships. Capturing results
creates a separate ordinary Collection with provenance and explicit complete/
partial capture boundary. Query definitions and cached results have separate
visibility; private sources/counts/cursors cannot leak through a public definition.

## Implementation and acceptance

Store identity, capability configuration, route/mount occurrences and contextual
decisions as Jena facts. Use versioned publication/route heads and local CAS.
Large topology/import operations stage and activate a generation. Avoid a dataset
per Space or a synchronous copy of all global classifications into every Realm.

Qualify one Main Version in two Realms with conflicting tags, scores and content
selections, then present each through a Zone. Exercise capability retirement,
private collection membership, dynamic query capture and exact historical links.
