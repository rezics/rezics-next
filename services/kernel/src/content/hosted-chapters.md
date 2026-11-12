# Hosted catalogue API

The hosted book profile extends an existing Post in its current home. The Post remains the catalogue identity and
authority. Commands use ordinary Post owner/container admission and native receipts; they create no resources,
grants, Subjects or bodies. Columns and individual articles continue to use ordinary Posts without a catalogue.

## Authoring and release

| Operation ID               | Method and path                          | Input                                                                   |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `hosted_catalogue.create`  | `POST /v1/hostedCatalogues`              | `postId`, `threadId`, `placements`                                      |
| `hosted_catalogue.revise`  | `POST /v1/hostedCatalogues/{id}:revise`  | `expectedRevisionId`, `placements`                                      |
| `hosted_catalogue.publish` | `POST /v1/hostedCatalogues/{id}:publish` | `expectedRevisionId`, nullable `expectedPublicationId`, `occurrenceIds` |

Every command requires an Idempotency-Key and returns `catalogueId` and the newly selected `revisionId`. Create
returns 201; revise and publish return 200. A fresh command with a stale head or release returns 412. Native
authorization precedes receipt lookup, while concurrency comparisons follow it: an authorized exact retry can
return its original immutable revision after later changes. An altered request under the same key conflicts.

Each placement supplies `occurrenceId`, nullable `parentId`, zero-based sibling `position`, `title` and `kind`.
Parts have no target. Chapters supply a target containing `threadId`, `postId`, `revisionId` and lowercase SHA-256
hex. The occurrence and parent IDs carry the catalogue's route; target identities carry the target Post's route.
A structure has at most 512 occurrences, depth 16 and 256 Unicode characters per title. Empty structures, empty
parts, duplicate Post selections under distinct occurrences and root-only chapter lists are valid. Chapters cannot
parent children. Duplicate IDs, cycles, missing parents and noncontiguous sibling positions are invalid requests.

Revise replaces the complete tree and retains immutable history. Occurrence identity permanently fixes the kind
and target Post, even after removal; moves, titles, sibling order and exact revision selections may change. Target
attachment reads use native Post disclosure. A failed command rolls back its own changes and never erases the
independently saved target Post. No manuscript bodies are retained together during attachment processing.

Publication selects an ancestor-closed subset of the expected current structure. It stores a separate immutable
manifest, with dense positions and preorder preserving the selected relative order, and advances the publication
pointer in the same transaction. An empty selection withdraws the current TOC and removes the catalogue from
`hosted_catalogue.for_subject`. It does not publish any Post body:
ordinary Post publication and target disclosure remain necessary. Published bytes are selected by exact revision
and digest, never replaced with the current head. Later draft edits do not change a release. The three registered
events contain only catalogue/revision identities; no private target selections enter the outbox.

## Reading

| Operation ID                   | Method and path                                                       | Query                                             |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------- |
| `hosted_catalogue.get`         | `GET /v1/hostedCatalogues/{id}`                                       | selection                                         |
| `hosted_catalogue.children`    | `GET /v1/hostedCatalogues/{id}/children`                              | selection, optional `parentId`, `limit`, `cursor` |
| `hosted_catalogue.resolve`     | `GET /v1/hostedCatalogues/{id}/occurrences/{occurrenceId}`            | selection                                         |
| `hosted_catalogue.navigate`    | `GET /v1/hostedCatalogues/{id}/occurrences/{occurrenceId}/navigation` | selection, `direction`, `limit`, `cursor`         |
| `hosted_catalogue.for_subject` | `GET /v1/subjects/{id}/hostedCatalogues`                              | optional `limit`, `cursor`                        |

Selection accepts optional `revisionId` and `kind` (`structure` or `publication`). Without either, it chooses the
current release. `kind=structure` chooses the current draft head, including a catalogue that has never released.
An exact revision remains addressable after moves, removals, later releases or withdrawal; an accompanying kind
must match it. Private structures require current `post:revise` as well as ordinary catalogue Post disclosure.
Metadata contains `catalogueId`, selected `revisionId`, `kind` and nullable `sourceRevisionId`.

`hosted_catalogue.for_subject` lists current public publications associated with an
existing Subject. Candidates come from indexed `subject_thread` rows and same-route
published catalogue-post subject references. Each page inspects at most 21 raw
catalogues, discloses at most 20, and never refills concealed slots. Empty
publications are absent. Historical exact occurrence reads stay on
`hosted_catalogue.resolve` and still obey current catalogue and target Access.

Every read retains native catalogue disclosure and repeats it before returning. Chapter disclosure independently
retains the exact native target Post, Board, Realm and ancestor checks. Erased, concealed, missing or changed
targets return an unavailable slot containing only occurrence ID, parent, position, kind and availability. Titles,
target references, digests, attribution and bytes are withheld. Dependency failures remain failures, not evidence
that a target is absent. Parts disclose their titles under catalogue authority.

Resolution returns the selected occurrence and a nullable `document`. Available chapters deliver `encoding=base64`,
the canonical UTF-8 Document bytes as `canonicalBytes`, lowercase `sha256`, original Post `authorId` and `licence`.
Decoding the base64 string yields the bytes covered by that digest. The document is the exact submitted canonical
snapshot for the selected Post revision, including its stable block IDs. The native 2 MiB body bound applies. Parts
and unavailable chapters have a null document. Responses use private, no-store caching and record native session
anchors.

Children default to the root; an explicit parent must be a part in the selected revision. Navigation uses preorder
and returns only chapters, excluding the origin. `direction=next` returns ascending order; `previous` returns
descending order, nearest first. A part can serve as the navigation origin.

The default and maximum page limit is 20. A page selects at most limit plus one indexed rows, discloses at most
limit targets, and never refills denied slots. The last raw position determines `nextCursor`. Continuations bind
catalogue, original selector, selected immutable revision, kind, parent/origin, direction, limit, actor identity,
client, delegation, authentication epoch and scope ceiling. They retain the original partition epoch, navigation
origin and 15-minute lifetime. A later release or draft edit does not move a continuing page to another revision.
Changed query bindings, invalid tokens and replaced partition epochs return 400.

## Cost and integration boundaries

Mutations validate at most 512 placements and read each distinct exact selected target through the existing native
reader. They write one snapshot and bounded placement/identity inserts under the catalogue home transaction.
Publication reads the bounded source structure and processes only its selected attachments. Reads perform exact
catalogue and revision probes, at most one parent/origin probe and one indexed page query of at most 21 rows.
Subject discovery seeks at most 21 indexed `subject_thread` and same-route catalogue-post candidates, then
discloses at most 20 current publications. Each selected target has an initial and final native disclosure;
catalogue disclosure also repeats at completion.
Pages retain metadata and authority handles, not manuscript bodies. Resolution serializes one canonical body.
All nested native Access, Accounts, Board, Realm, partition, transaction, serialization and body work remains charged.

The ordinary Content HTTP composition mounts these declarations and the existing event catalogue registers their
events. Schema dump refresh, installed client publication, integration acceptance and measured native growth belong
to the existing integration and publication workflows. No alternate publisher or local readiness assertion is supplied.
