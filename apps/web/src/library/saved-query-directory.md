# Saved query directory

The personal `/library/collections` page includes Saved queries from the current authenticated owner's bounded
Collection page. It never fetches later pages to build or sort a complete directory. A row requires
`membershipKind: "dynamic"`, no `builtinKind`, and `curatorAccountId` equal to the current session subject. The viewer
controller accepts only a response for that same subject and page address.

The current viewer's enrolled platform-exposure observation supplies the `collection.create` operation admission;
the Collection DTO never proves whether saved queries are supported. Unknown admission remains checking, denied
admission remains denied, and an unavailable exposure read remains unavailable with deliberate retry. An admitted
empty Collection page is a truthful empty directory. The existing opaque `next` cursor and layout continue the same
owner list. Dynamic rows show no membership count or timestamp.

Opening a row uses `/collections/{id}` and its existing authorized Dynamic Collection reader. The row carries a
validated same-locale return address for the exact bounded directory page, including its cursor and layout. That
address contains no private query predicate and is ignored if it points anywhere else.

The reader offers Manage saved query only when the current viewer owns an ordinary dynamic Collection and both the
current Collection read and its native resource actions admit the relevant command. The manager repeats the current
authenticated Collection detail read before showing editable metadata. It uses the returned title, description,
visibility and CAS revision. Saving sends the existing `collection.update` command with title and description while
preserving visibility; it does not read or rewrite the private rule. The saved rule keeps its accepted immutable
release. Rule editing remains at `/collections/{id}/rule` under its own current owner checks. Publication stays a
separate owner action: `SavedQueryPublicationAction` opens `/collections/{id}/publish` without rewriting metadata
or the private rule.

Delete requires a review of the Collection title, exact ID and current revision. Confirmation sends the existing
`collection.delete` command. A confirmed delete returns to the same bounded directory page and removes only the
Collection; it does not delete Library facts. Unknown commands keep their original sender, CSRF credential, key and
operands for retry. Reading current metadata is an explicit recovery that retires that retry. Session, Collection,
reader and locale replacement retire the private editor state and pending response callbacks.

Decision: row navigation carries a validated same-locale cursor/layout return address so confirmed deletion returns to the exact bounded Library page.

Decision: Saved-query support follows current-viewer native operation admission; an admitted empty inventory remains empty, and row presence is never capability evidence.

The Web binding uses the installed Collection detail, metadata update and delete routes, all private `no-store` reads
and writes. Commerce retains native authorization, revision/CAS and deletion semantics. Its remaining Web-facing
producer gaps are complete paged dynamic owner metadata, dynamic member preparation and their required native outcome
proof; Web adds no endpoint or successful fixture for those gaps.
