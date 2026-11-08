# Saved query directory

The personal `/library/collections` page includes Saved queries from the current authenticated owner's bounded
Collection page. It never fetches later pages to build or sort a complete directory. A row requires
`membershipKind: "dynamic"`, no `builtinKind`, and `curatorAccountId` equal to the current session subject. The viewer
controller accepts only a response for that same subject and page address.

Web directory availability follows the current viewer's enrolled platform-exposure observation and its `collection.create`
operation admission. Unknown admission remains checking, denied admission remains denied, and an unavailable exposure
read remains unavailable with deliberate retry. An admitted empty Collection page is a truthful empty directory;
row presence never produces capability evidence. The existing opaque `next` cursor and layout continue the same owner
list. Dynamic rows show no membership count or timestamp.

Opening a row uses `/collections/{id}` and its existing authorized Dynamic Collection reader. The row carries a
validated same-locale return address for the exact bounded directory page, including its cursor and layout. That
address contains no private query predicate and is ignored if it points anywhere else.

The reader offers Manage saved query only when the current viewer owns an ordinary dynamic Collection and both the
current Collection read and its native resource actions admit the relevant command. The manager repeats the current
authenticated Collection detail read before showing editable metadata. It uses the returned title, description,
visibility and CAS revision. Saving sends the existing `collection.update` command with title and description while
preserving visibility; it does not read or rewrite the private rule. The saved rule keeps its accepted immutable
release. Rule editing remains at `/collections/{id}/rule` under its own current owner checks. Publication stays a
separate owner action on the saved-results header: `SavedQueryPublicationAction` opens `/collections/{id}/publish`
without rewriting metadata or the private rule.

Delete requires a review of the Collection title, exact ID and current revision. Confirmation sends the existing
`collection.delete` command. A confirmed delete returns to the same bounded directory page and removes only the
Collection; it does not delete Library facts. Unknown commands keep their original sender, CSRF credential, key and
operands for retry. Reading current metadata is an explicit recovery that retires that retry. Session, Collection,
reader and locale replacement retire the private editor state and pending response callbacks.

Decision: retain the installed saved-query lifecycle and selected publisher; bind explicit owner reads to generated
`ownerManagement`, consume the installed dynamic metadata union, and preserve admitted directory return addresses
through results and rule routes. Native/browser/growth acceptance and promoted-main verification remain separate.

Row navigation, rule return and confirmed deletion retain the exact same-locale directory cursor and rows/previews
layout. The results route shares delete-return admission of up to 4096 logical cursor characters; its finite encoded
envelope allows nine characters per UTF-16 unit plus origin, path and fixed operands. The rule-return envelope adds
its own encoded cursor, three characters per nested directory-address character and the existing 16,384-character
filter/path budget. Every layer still admits the decoded cursor independently; the encoded envelope cannot enlarge
it. External destinations, other locales, duplicate operands and overlong decoded cursors return to the directory.

Decision: manager UI callbacks are bound to their originating controller, preserving its draft, ports, command recovery and retirement.

Decision: Saved-query support follows current-viewer native operation admission; an admitted empty inventory remains empty, and row presence is never capability evidence.

The Web binding uses the installed generated Collection metadata union, owner-management readers and selected
publisher. Commerce retains native authorization, revision/CAS and deletion semantics. Dynamic member preparation
uses the existing members reader, including its native preparing and unavailable outcomes; no successful fixture
establishes native execution or whole-query publication.

## Installed visit bindings

| Owner action                    | Web caller                                                                                | Generated operation and native producer                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Save admitted one-use selection | `SavedQueryEditor` → `CollectionRuleCurrent` → `submitCollectionRule`                     | `collections.post` → `collection-routes.ts` create → `collections.ts`                                               |
| Reopen exact directory page     | `MineCollectionsCurrentViewer` → `loadMineCollectionsPage`                                | `collections.get`, FULL, curator, `ownerManagement:true`, exact cursor → `collection-reads.ts:listCollections`      |
| Correct metadata                | `SavedQueryManagementController` → `captureCollectionUpdate` → `updateCollectionRecord`   | `collections({collectionId}).patch` with original CAS revision, title/description and preserved visibility          |
| Reopen/correct rule             | `CollectionRuleCurrent` → `loadCollectionRule` / `submitCollectionRule`                   | `collections({collectionId}).rule.get/put`; accepted release stays on the private rule read                         |
| Inspect/prepare current members | `loadEditableCollectionPage`                                                              | `collections({collectionId}).get` and `.members.get`; explicit editor GET adds `ownerManagement:true`               |
| Publish reviewed selection      | `SavedQueryPublicationAction` → `CollectionPublicationPageView` → `publishSelectedNative` | `collections({collectionId}).$publishSelected.post` → `collection-publication.ts`; explicit empty/nonempty set only |
| Inspect permitted public output | ordinary anonymous Collection route → `loadEditableCollectionPage`                        | same metadata/members GETs, without owner management or private rule reads                                          |
| Delete and return               | `SavedQueryManagementController` → `captureCollectionDelete` → `deleteCollectionRecord`   | `collections({collectionId}).delete` with original revision/key, then admitted directory address                    |

The directory never refills sparse pages. Its returned opaque frontier remains available even when no saved-query
row occurs on that page. An operational failure retries the attempted address; only native stale-cursor rejection
permits the existing first-page restart. `saved-query-publication-journey.test.tsx` pins the generated sparse directory
read/retry; `saved-query-results.test.ts` pins default-route return admission through correction and deletion.
Existing editor, management, publication and current-viewer tests retain their command and retirement assertions.
Focused tests are authored acceptance; the minimal worker protocol defers their execution to the dev verifier.

The new-rule route composes Library's `SavedQueryEditor` with Search's `SavedQueryConditionInput` adapter.
The carried private selection still enters the existing owner-bound rule editor; the injected presentation neither
owns the handoff nor sends a command. Settings and Inbox Library contracts remain independent of this binding.
