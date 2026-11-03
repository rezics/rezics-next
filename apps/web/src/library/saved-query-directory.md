# Saved query directory

The personal `/library/collections` page includes a Saved queries section composed from the current authenticated
owner's bounded Collection page. It never fetches later pages to build or sort a complete directory. A directory
row requires `membershipKind: "dynamic"`, no `builtinKind`, and `curatorAccountId` equal to the currently prepared
session subject. The viewer controller accepts only a response for that same subject and page address.

The current and already-required first navigation page provide the only capability evidence. If neither returns a
dynamic Collection DTO, the directory shows an explicit unavailable state and retry link; it does not present that
producer gap as an empty result. With dynamic support, an empty message describes only the current page. The existing
opaque `next` cursor and layout continue the same owner list. Dynamic rows show no membership count or timestamp.

Opening a row uses `/collections/{id}`, the existing authorized results and Collection management route. Rename and
delete continue through that page's current `collection.update` and `collection.delete` lifecycle commands, including
their native authorization, revision, CSRF and uncertain-command recovery. Deleting the Collection does not delete
Library facts. A rule link uses `/collections/{id}/rule`; the existing private rule GET and current owner operation
gates remain authoritative. Links contain only the Collection ID. Predicates never enter links or public profile DTOs.
Built-in Everything, state and Liked views are excluded, and the shared rule-link guard also excludes built-ins.

Decision: use only the current owner page and any already-loaded navigation page; missing dynamic DTO support is unavailable, not an empty result.

The Web seam is bound to the existing owner list, Collection detail, rule and lifecycle routes. Commerce remains the
producer for complete paged dynamic membership metadata, dynamic member preparation and native authorization. Those
native semantics are not implemented here; unsupported owner pages and unavailable route responses remain visible.
