# Viewer actions

Research evidence, 2026-10-28. This report proposes a contract for adoption; it does not change the Access authority.

Recommend one kernel-owned, bounded personal read that returns allowed action names and their usable operation IDs
for already identified resources. Use it for detail pages and list items. Compute it through the installed Access
formula and admission's gate function, with the caller's actual credential. Keep it out of public resource DTOs and
edge-cached anonymous HTML. A command always authorizes again at its own T.

## Survey method

The survey covers **23 products/authorization systems**, counting each product once despite multiple API styles,
plus three hypermedia precedents. Links below are primary API documentation, standards or project source.
“User rights” does not mean “this OAuth token can execute the write.” Where documentation only promises the former,
the table says so. Absence means no general affordance contract was found in the cited public surface, not a claim
about a vendor's private frontend APIs.

For proprietary systems, internal query counts, asymptotic CPU costs and permission-propagation SLAs are generally
unpublished. “Refetch” below means a fresh observation through that API, without a promised linearizable revocation
boundary. Cost descriptions distinguish documented limits from inferred work: returning N items and A action values
requires that output, but does not prove O(N × A) database work. Events can prompt a refetch; they do not turn an old
answer into authority. No vendor's cache policy should be imported as REZICS's revocation guarantee.

### Resource-oriented products

| Product and primary evidence | Placement, shape and list items | Token scope coverage | Freshness and server cost |
| --- | --- | --- | --- |
| **GitHub REST and GraphQL.** [Repository REST](https://docs.github.com/en/rest/repos/repos), [GraphQL repositories](https://docs.github.com/en/graphql/reference/repos), [issue fields](https://docs.github.com/en/graphql/reference/issues), [token permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens). | REST repository reads/list responses can carry `permissions` booleans such as `push`, `pull`, `admin`; GraphQL nodes expose action booleans such as `viewerCanUpdate` and the coarser `viewerPermission` enum. GraphQL connection nodes can select these per item. | Do not assume role/boolean fields certify every token permission. Endpoint token requirements are separate; `viewerPermission` can be null for GitHub App authentication. The issue reference warns that one metadata ability uses base roles rather than all custom-role grants. | Refetch selected fields; no universal revocation SLA. REST adds fields to a read; GraphQL resolves selected abilities per node. Backend cost is unspecified. Role compression loses action detail. |
| **GitLab REST and GraphQL.** [Projects API](https://docs.gitlab.com/api/projects/), [GraphQL reference](https://docs.gitlab.com/api/graphql/reference/), pinned permission resolver below. | REST project `permissions` contains project/group access levels; single-project documentation warns the field is absent from project lists. GraphQL resource `userPermissions` contains individual ability booleans and can be selected on connection nodes. | The pinned resolver calls `Ability.allowed?` for `context[:current_user]`; it is evidence of user ability, not a universal intersection with every endpoint's OAuth scope. | Resolve again on reads. Selected booleans invoke the shared ability engine; batching/caching is implementation-dependent. REST access levels cannot describe all object-specific decisions. |
| **Google Drive v3.** [File capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files), [sharing guide](https://developers.google.com/workspace/drive/api/guides/manage-sharing), [OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth). | `File.capabilities` is an output-only map of fine-grained booleans, e.g. `canEdit`, `canDelete`, `canShare`. Select it in `files.get` and `files.list` field masks, per file. | Defined as the current user's capabilities; OAuth scopes separately restrict API use. The documented semantics do not promise that `canEdit` is false for every read-only token. | Refetch after relevant changes. No per-field revocation SLA or query count published. Field masks bound response work; capability evaluation accompanies each selected file. |
| **Microsoft Graph / OneDrive.** [Effective sharing permissions](https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0), [permission model](https://learn.microsoft.com/en-us/graph/permissions-overview). | Separate `driveItem/permissions` collection contains permission objects and roles, not a uniform `viewerCan*` map on every file-list item. Owners see all sharing permissions; non-owners see applicable ones. | Delegated access depends on app permissions and user authority. A returned sharing role alone does not certify that intersection for a different write endpoint. Application permissions have a different principal model. | Refetch the permission collection; no portable revocation SLA. Extra collection reads, potentially many ACL entries, cost more output than an action summary. Internal evaluation cost unspecified. |
| **Box.** [File resource](https://developer.box.com/reference/resources/file--full/), [folder listing](https://developer.box.com/reference/get-folders-id-items/). | Authenticated file `permissions` contains `can_delete`, `can_rename`, `can_upload`, etc. Folder listings support selected fields on entries, including file permissions; mini/default item representations must not be assumed to contain them. | Documented as authenticated-user permissions, without a blanket guarantee about all token scope/downscoping restrictions. Distinguishes content eligibility (`is_download_available`) from the viewer's `permissions.can_download`. | Refetch requested fields. Inferred per-item capability output; backend cost and freshness SLA unspecified. This is a useful precedent for keeping object state separate from authorization. |
| **Dropbox.** [Single metadata](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/sharing/get-file-metadata), [batch metadata](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/sharing/get-file-metadata-batch). | Separate shared-file metadata read accepts requested `actions`; `permissions` returns corresponding action/allow/reason information alongside `access_type`. Batch checks provide one result per supplied file; ordinary folder listings are not this check. | `sharing.read` is sufficient to obtain sharing capability information. Those user sharing rights do not promise the token has the scopes for every resulting modification. | Reissue the metadata/batch read. Requested actions bound output and avoid asking for unrelated abilities; no public internal complexity or revocation SLA. |
| **Notion.** [Connection capabilities](https://developers.notion.com/reference/capabilities), [Page schema](https://developers.notion.com/reference/page). | Capabilities such as read/update/insert content belong to the connection/token; sharing determines accessible content. The documented page schema has no general per-page effective-action list, including in query results. | Token capabilities and resource access are both enforced, but there is no returned per-resource action intersection in this surface. | Recheck through current reads/operations after capability or sharing changes; no permission-answer TTL exists here. Listing accessible content costs normal pagination; synthesizing an affordance from configuration requires additional knowledge. |
| **Figma.** [File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/), [scopes](https://developers.figma.com/docs/rest-api/scopes/). | File metadata includes `role` and `link_access`. This is a single-file metadata answer, not a documented complete per-action list on every file-list item. | Scopes explicitly do not supersede file/team/organization rights. A file role alone is insufficient: comments, variables and other operations have separate scopes and plan restrictions. | Refetch metadata and respect operation errors. One metadata call per queried file absent another supported batching path; internal permission cost unspecified. |
| **Slack.** [Conversation object](https://docs.slack.dev/reference/objects/conversation-object/), [conversation read](https://docs.slack.dev/reference/methods/conversations.info/). | Conversation objects contain membership/state and restrictions such as `posting_restricted_to`; these are policy facts, not a complete caller action map. Applicable conversation properties appear in reads/list objects, varying by conversation type. | Method scopes and conversation access are checked separately. Reading restrictions does not certify `chat:write` or another write scope. | Refetch state, react to relevant events and handle `missing_scope`/`no_permission`. Output follows channel properties; computing complete abilities from all restrictions is client work these APIs do not eliminate. Server complexity unspecified. |
| **Discord.** [Permission computation](https://docs.discord.com/developers/topics/permissions), [command permissions](https://docs.discord.com/developers/docs/interactions/slash-commands). | Role bitfields plus channel/member overwrites yield computed effective permissions; some contexts supply computed permission bitfields. General channel lists do not contain a universal per-caller operation list. Command permissions separately govern command-picker visibility. | Guild permissions and OAuth scopes are distinct. Updating command permissions explicitly needs an appropriate bearer scope and sufficient user permissions. A guild bitfield is not a token-scope summary. | Update role/member/channel inputs from Gateway events or refetch. Documented computation traverses applicable roles/overwrites; administrator and implicit permission rules matter. This moves appreciable policy complexity into clients. |
| **Atlassian Confluence.** [v2 permitted operations](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-operation/), [legacy response schema](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-users/). | `operations` uses `{operation, targetType}` entries. Legacy embedded/expanded content representations demonstrate this shape; current v2 exposes `/pages/{id}/operations`, `/spaces/{id}/operations`, etc. The dedicated endpoint is per entity, not automatically on list items. | The endpoint has a read scope and resource-view prerequisites. Do not infer that an offered user operation also supplies the token's write scope. | Refetch operations; no global cache/revocation promise. Separate entity checks add calls unless another documented read includes them. Internal cost unspecified. |
| **Atlassian Jira.** [My permissions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/), [performance rationale](https://developer.atlassian.com/cloud/jira/platform/change-notice-get-my-permissions-requires-permissions-query-parameter/). | Separate `mypermissions` returns keyed `havePermission` booleans for requested keys, scoped to global/project/issue context. It is not an ability map on every issue-list item. A project/global positive can differ from the particular issue result. | Read permission scope obtains user-permission answers; it is not a substitute for write scopes or workflow conditions. | Refetch in exact issue context. Atlassian required explicit permission keys because an extensible all-permissions query became expensive. This directly supports bounding REZICS's candidate action set. |
| **Salesforce UI API.** [Official engineering introduction](https://developer.salesforce.com/blogs/2018/01/introduction-salesforce-ui-api), [UI API object metadata](https://developer.salesforce.com/docs/platform/graphql/guide/query-objectinfo.html). | Object metadata includes `updateable`/`deletable`; these are object-type abilities, not proof of access to each record. Separate UI action resources describe actions for detail, edit and list-view records, supporting per-record UI construction. | User-aware UI metadata does not document a universal certificate of every OAuth/session limitation. Object-type CRUD alone cannot establish record-specific or field-specific permission. | Refresh UI data/actions/metadata when relevant state changes. Combined data/layout metadata and separate action requests trade larger payloads for fewer round trips; internal permission query counts unspecified. |
| **Linear.** [GraphQL introduction](https://linear.app/developers/graphql), [OAuth](https://linear.app/developers/oauth-2-0-authentication), [permission-change guidance](https://linear.app/developers/agents). | `viewer` identifies the caller; GraphQL returns accessible objects and supports normal connection pagination. The cited public guides do not promise a universal `viewerActions` map for issue nodes. | Read/write/admin and specialized scopes constrain the token; accessible issue data is insufficient evidence of mutation rights. | Permission-change webhooks can trigger refresh; subsequent reads and mutations still enforce authority. No general per-item affordance cost contract; requesting each object/check separately risks more calls. |
| **Reddit.** [Current-user moderator permissions](https://developers.reddit.com/docs/api/public-api/classes/User), [official usage](https://developers.reddit.com/docs/capabilities/server/reddit-api), [REST API](https://www.reddit.com/dev/api/). | User/subreddit context supplies moderator permission names through `getModPermissionsForSubreddit`; REST has moderator listings and object state. This is a community permission list, not a complete per-post permitted-action list on feed items. | Moderator rights do not establish every OAuth scope or per-post condition. Devvit app identity must also be distinguished from the human caller. | Re-fetch the subreddit permission context; no universal revocation SLA. One community answer can be reused within a request, but post-specific checks remain. Internal cost unspecified. |
| **Mastodon.** [Status](https://docs.joinmastodon.org/entities/Status/), [status methods](https://docs.joinmastodon.org/methods/statuses/). | Status detail and timeline items contain viewer state (`favourited`, `reblogged`, `bookmarked`); quote approval also expresses a current-user policy outcome. This is not a universal edit/delete permission map. | Having favourited a post says nothing about a token's current `write:favourites` scope; edit methods document their own scope and ownership requirements. | Refetch status and handle streaming updates; no universal TTL or cross-instance immediate freshness guarantee. Per-item relationship hydration has output proportional to items; internal cost unspecified. |
| **Bluesky / AT Protocol.** Pinned lexicon and AppView implementation below; [post-thread API](https://docs.bsky.app/docs/api/app-bsky-feed-get-post-thread). | `postView.viewer` carries relationship record URIs and flags including `replyDisabled` and `embeddingDisabled`, on post views used by feeds and threads. Source omits the viewer object without authenticated viewer state. | These are viewer/relationship/thread-policy facts, not a complete proof of the PDS token's record-write permissions. | AppView hydrates and presents viewer state; indexing can lag repository writes. Source batches viewer relationships for hydrated posts. Neither a universal action list nor a read-after-revocation certificate. |
| **MediaWiki.** [Userinfo rights](https://www.mediawiki.org/wiki/API:Userinfo), [page action tests](https://www.mediawiki.org/wiki/API:Info). | `userinfo` returns global rights; `prop=info&intestactions=edit` tests exact pages and returns `actions` per page, also on multi-page queries. Detailed errors are available with `intestactionsdetail=full`. | Global rights are weaker evidence than page tests. Do not assume either is a certificate of all credential grants, CSRF tokens or write-time extension checks. | Refetch page tests; `quick` explicitly skips expensive checks and must not be mistaken for full admission. Cost grows with pages/actions and enabled policy hooks; full/quick distinction exposes the accuracy/cost tradeoff. |

### Authorization systems and hypermedia

| System and primary evidence | Placement, shape and list items | Token scope coverage | Freshness and server cost |
| --- | --- | --- | --- |
| **Kubernetes.** [Access reviews](https://kubernetes.io/docs/reference/access-authn-authz/authorization/#checking-api-access), [rules review](https://kubernetes.io/docs/reference/kubernetes-api/definitions/self-subject-rules-review-v1-authorization/). | Separate `SelfSubjectAccessReview` asks about exact verb/resource/name and returns `allowed`, `denied`, reason/evaluation error. `SelfSubjectRulesReview` enumerates namespace rules and can mark the result incomplete. Neither decorates ordinary list items. | Evaluates authenticated Kubernetes identity through configured authorizers; there is no generic OAuth client-scope intersection beyond restrictions represented in authentication/authorizer inputs. | Review again after policy changes; rules review explicitly warns about revocation/cache correctness and is advisory for UIs. Exact reviews cost authorizer checks per request; rule enumeration can be incomplete or unsupported. |
| **AWS IAM simulation.** [Simulation API](https://docs.aws.amazon.com/IAM/latest/APIReference/API_SimulatePrincipalPolicy.html), [limitations](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html). | Separate simulation accepts action/resource sets and returns decisions with context/policy details, paginated when needed. No resource-list decoration. | Simulated policies/context are not the live calling session's complete authority. Not all live service/session/resource checks are represented; AWS warns results can differ from live execution. | Re-simulate with current policies/context; no capability lease. Work scales with requested action/resource combinations and policy evaluation. Useful diagnostics, unsuitable as REZICS's independently implemented admission simulator. |
| **SpiceDB.** [Querying](https://authzed.com/docs/spicedb/concepts/querying-data), [bulk-check advice](https://authzed.com/docs/spicedb/getting-started/faq), [consistency](https://authzed.com/docs/spicedb/concepts/consistency), pinned source below. | `CheckBulkPermissions` returns request/result pairs with permission outcomes, including conditional results/errors. `LookupResources` finds resource IDs for a subject/permission. A host application can batch checks for its list page; no automatic product DTO. | Application scopes must be modeled or intersected by the host. SpiceDB API authentication is not the end user's client-consent policy. | Consistency/ZedTokens select revision freshness; default latency optimization can be stale. Pinned bulk code caps 10,000 checks, deduplicates/groups them and bounds concurrency. Lookup explores accessible graph paths and can have broad fanout. |
| **OpenFGA.** [Check](https://openfga.dev/docs/getting-started/perform-check), [ListObjects](https://openfga.dev/docs/getting-started/perform-list-objects), [consistency](https://openfga.dev/docs/interacting/consistency), pinned batch source below. | `BatchCheck` returns correlation-keyed allowed/error outcomes; `ListObjects` returns IDs for user/relation/type. Host batches known list items or performs reverse lookup. | Caller must model or separately enforce token scopes and supply trusted contextual inputs. The service token is not evidence of the resource viewer's scopes. | `HIGHER_CONSISTENCY` skips query caches; default `MINIMIZE_LATENCY` can miss a recent tuple change. Source bounds batch size/concurrency, deduplicates checks, and gives ListObjects deadlines/result limits. Graph fanout remains model-dependent. |
| **Cerbos.** [API](https://docs.cerbos.dev/cerbos/latest/api/index.html). | `CheckResources` accepts multiple resources with action lists and returns per-resource action effects. `PlanResources` returns a conditional query-plan AST, not object IDs or a per-item decision. Both are separate host-facing ports. | Principal attributes/roles and optional JWT data can enter policy; client scopes are included only if modeled by the application/policy. Policy `scope` is policy hierarchy, not OAuth consent. | Recheck with current policy and current trusted attributes. Work follows resources/actions and policy conditions; planning moves some work into the host's database. A stale host attribute snapshot remains stale even with a fresh PDP call. |
| **Siren.** Pinned [specification](https://github.com/kevinswiber/siren) below. | Resource `actions` describes named behaviors with method, href, content type and fields; entities/subentities can expose their own actions. Server chooses whether/how to supply these on list representations. | Format does not mandate authorization or token-scope semantics. The producer must filter actions. | Refetch the representation; no lease/freshness guarantee in the format. Output grows with advertised actions and form descriptions; permission evaluation is entirely the server's responsibility. |
| **HAL-FORMS.** Pinned [specification source](https://github.com/rwcbook/hal-forms) below. | `_templates` describes available transitions and input properties, with method/target. A separate representation or embedded item can carry templates; not a mandated per-list-item authorization map. | Representation format alone does not intersect token scopes or certify authorization. | Refetch templates with correct cache separation. Cost includes template output plus producer's authorization checks; the media type specifies no backend bound. Useful for form discovery after deciding an action, not a replacement policy engine. |
| **HTTP `Allow`.** [RFC 9110 §10.2.1](https://www.rfc-editor.org/rfc/rfc9110.html#name-allow). | Response header lists supported HTTP methods for the target URI, required on 405. It does not describe individual business actions or per-item affordances inside a collection representation. | It is method support information, without a caller-rights/client-scope guarantee. CORS method advertisements likewise cannot authorize a command. | Origin defines the set at request time. Header size follows method count; optional personalization would incur the producer's policy cost. Too coarse for REZICS, where multiple commands/actions use POST. |

## Source evidence and licences

Reference root is `/home/edge/projects/rezics/rezics-next/.reference/`; all paths in this table are relative to it.
Existing clones were reused. New clones were shallow; none was installed, built or executed. Git object reads were
used for GitLab files outside its sparse checkout. The reference index records these uses outside the worktree.
Vendor documentation remains under its publisher's terms; the report paraphrases findings rather than copying code
or substantial specification text. These licences describe the inspected project sources, not a recommendation to port them.

| Reference directory; pinned commit | Inspected paths and finding | Licence evidence; immutable source URL |
| --- | --- | --- |
| `merge-queues/gitlab`; `7f6a2f6c243fa6ea4a3aa86b1fa90fd5fa41ad57` | `app/graphql/types/permission_types/base_permission_type.rb` routes ability fields to `Ability.allowed?`; `app/graphql/types/permission_types/project.rb` declares action booleans. | MIT Expat for these files; `LICENSE` distinguishes documentation CC BY-SA 4.0 and other directories. [Resolver](https://gitlab.com/gitlab-org/gitlab/-/blob/7f6a2f6c243fa6ea4a3aa86b1fa90fd5fa41ad57/app/graphql/types/permission_types/base_permission_type.rb), [licence](https://gitlab.com/gitlab-org/gitlab/-/blob/7f6a2f6c243fa6ea4a3aa86b1fa90fd5fa41ad57/LICENSE). |
| `search-visibility-witnesses/spicedb`; `7e7420c3f541648971b70642691ef86cac00a6cc` | `internal/services/v1/bulkcheck.go` groups checks, keeps request ordering, returns item errors, uses one revision and caps concurrency/input. `internal/graph/lookupresources3.go` implements reverse traversal. | Apache-2.0, `LICENSE`. [Bulk implementation](https://github.com/authzed/spicedb/blob/7e7420c3f541648971b70642691ef86cac00a6cc/internal/services/v1/bulkcheck.go), [licence](https://github.com/authzed/spicedb/blob/7e7420c3f541648971b70642691ef86cac00a6cc/LICENSE). |
| `search-visibility-witnesses/openfga`; `57b39bc3dcc12f92270602bc01eb933ca4accfbe` | `pkg/server/commands/batch_check_command.go` validates correlation IDs and caps/deduplicates checks; `pkg/server/list_objects.go` configures query deadlines, result limits and read concurrency. | Apache-2.0, `LICENSE`. [Batch implementation](https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/pkg/server/commands/batch_check_command.go), [licence](https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/LICENSE). |
| `viewer-actions/atproto`; `6ed6fe39dded20f1e8995042135fba83b31d7b26` | `packages/bsky/lexicons/app/bsky/feed/defs.json` defines viewer state; `packages/bsky/src/views/index.ts` emits it only for a viewer and derives reply/embed flags; `packages/bsky/src/hydration/feed.ts` hydrates viewer relationships. | MIT OR Apache-2.0, `LICENSE.txt`, `LICENSE-MIT.txt`, `LICENSE-APACHE.txt`. [Lexicon](https://github.com/bluesky-social/atproto/blob/6ed6fe39dded20f1e8995042135fba83b31d7b26/packages/bsky/lexicons/app/bsky/feed/defs.json), [presentation](https://github.com/bluesky-social/atproto/blob/6ed6fe39dded20f1e8995042135fba83b31d7b26/packages/bsky/src/views/index.ts), [licence](https://github.com/bluesky-social/atproto/blob/6ed6fe39dded20f1e8995042135fba83b31d7b26/LICENSE.txt). |
| `viewer-actions/siren`; `c29a87840407419d52c2acd742a1ad6a03ce80da` | `README.md` entity actions and action fields; `siren.schema.json` representation shape. | MIT, `LICENSE`. [Specification](https://github.com/kevinswiber/siren/blob/c29a87840407419d52c2acd742a1ad6a03ce80da/README.md), [licence](https://github.com/kevinswiber/siren/blob/c29a87840407419d52c2acd742a1ad6a03ce80da/LICENSE). |
| `viewer-actions/hal-forms`; `53dedbbcc09fefd794459e1148ddc32491644797` | `index.asciidoc` defines `_templates` and transition inputs; example JSON shows a separate form representation. | MIT, `LICENSE`. [Specification](https://github.com/rwcbook/hal-forms/blob/53dedbbcc09fefd794459e1148ddc32491644797/index.asciidoc), [licence](https://github.com/rwcbook/hal-forms/blob/53dedbbcc09fefd794459e1148ddc32491644797/LICENSE). |

## Patterns to adopt

Resource capabilities are more useful than roles for UI decisions: Drive, Box and GitHub/GitLab action fields avoid
making clients reconstruct ownership policy. Dropbox, Cerbos, SpiceDB and OpenFGA show how one request can answer for
known resources and actions. Jira demonstrates why the action set must be explicit and bounded; use exact item
context rather than a project-level positive. Kubernetes makes the advisory boundary explicit. Siren and HAL-FORMS
show why naming the usable transition matters when different operations share an action.

Several surfaces expose only user rights, relationship state or role labels. That is insufficient for REZICS's
consented-scope requirement. Reverse permission lookup and query planning solve resource discovery, which can touch
a large graph; decorating an already bounded page should use forward checks. Nothing surveyed justifies enumerating
a resource ACL, translating a role into a private frontend policy, or treating a long-lived positive as authority.

## Mapping to REZICS today

The implementation anchors are [Access](../../services/kernel/src/access/README.md),
[the evaluator](../../services/kernel/src/access/permission.ts),
[the one formula](../../services/kernel/src/access/permission-check.sql),
[gate visibility](../../services/kernel/src/access/gates/visibility.ts),
[resource-role compilation](../../services/kernel/src/access/resource-roles.ts),
[mounted action declarations](../../services/kernel/src/http/request.ts),
[private-count authority](../private-follow-counts.md) and
[the Collection loader](../../apps/web/src/library/collection-load.ts).

For authenticated grant-derived authority, the relevant action must lie in the actor's grants **and** the client's
consented scopes **and**, when assigned, the principal's grants. “Grants” includes resolved resource roles,
`active_accounts` and currently proved organization/Realm membership roles. Membership inverse entries only admit
bounded candidates; they do not establish that membership is current. Current identity, assignment, validity ranges,
authentication floors/fences and exact-action denials remain operands. Organization membership alone is no action.

The public anonymous floor is a separate verified branch, not an inferred public flag. The current evaluator
explicitly allows a verified floor without the requested scope even when the caller has other token scopes; it does
not allow a scope-less grant branch. Preserve this rule through Access. Do not turn the scope rule into a new blanket
denial of genuine public-floor reads. Neither an open gate nor an account grant creates an anonymous floor.
Suspended/fenced identity evidence fails authenticated preparation; do not silently downgrade a refused bearer to
anonymous. A separately anonymous request may still read genuinely public resources. `realm_ban` denies the exact
Realm join/participate actions recorded by Community; it is not a universal “ban every resource action” rule.

Platform gates are an additional operation-admission condition. Opening a group, or holding `gate:<group>`/`gate:any`
on the Global Context under admission's rule, never supplies `collection:update` or its client scope. Reuse the
admission function for discovery and viewer actions. The inspected visibility implementation currently filters
exposure; the accepted discovery rule also requires the gated operation's action in client scopes. This report
assumes that correction and does not propose an alternative gate evaluator.

The formula also has documented Global governance reach for a closed set of exact actions. Viewer checks must
include that supported behavior, without recording governance-use writes outside commands. Do not add an independent
staff allow branch. Missing permission evidence denies; Access unavailability/deadline failures are 503, never an
empty success disguised as a denial. An entire viewer answer must fail if a required dependency is unavailable.

The loader's curator-ID comparison bypasses all these operands. Private counts already define Collection management
by ordinary `collection:update`, Space management by `space:manage`, and account-agent management on the resolved
account. This report extends the shared decision mechanism, not the count-specific self exception or disclosure rules.

## Proposed kernel contract

### Placement and shape

Add **`POST /v1/viewerActions`**, a side-effect-free personal read with a closed JSON body containing 1–100 distinct
`{type, id}` resource references. A single-resource page sends one reference; a list sends its displayed references
in one batch. Both get the same complete per-resource affordance answer. Resource detail/list content reads carry no
viewer fields by default; clients join the personal response to those reads by type and ID. No per-item HTTP probes.

```json
{
  "resources": [{ "type": "library.collection", "id": "<routable UUID>" }]
}
```

```json
{
  "resources": [{
    "type": "library.collection",
    "id": "<same UUID>",
    "viewerActions": [{
      "action": "collection:update",
      "operations": ["collection.update", "collection_member.create"]
    }]
  }]
}
```

The success example illustrates shape, not the complete installed catalogue. Entries are sorted by action and
operation ID, unique and allow-only; no action entry has an empty operations list. `viewerActions: []` is a complete
negative for that visible resource at the read's observations. A concealed/unknown resource returns the same per-item
`{type, id, error: "not_found"}` shape, with no viewer actions. A real dependency failure returns 503 for the whole
request, without partial positives. Invalid/duplicate/oversized references or unsupported types return 400 before
permission work; authentication errors retain normal status. Routes/partitions and caller identity come from trusted
kernel derivation, never supplied actor/principal/owner fields. Preserve request order for resource results.

Operation IDs are necessary: an action can back several routes whose exposure or authority anchor differs. An entry
means at least one named operation is usable on this anchor. A UI control checks both its action and its operation
ID; a positive for a different route cannot open a gated control. This follows Siren's transition identity while
keeping forms, URLs and input schemas in the existing operation catalogue.

### Candidate actions and evaluation

Compile a resource-type-to-action/operation index from trusted, mounted, **data-defined** action declarations and
resource-role data. Extend that metadata with each operation's authority type/anchor binding and shared eligibility
port; current `x-resource-types` and owner/standing role templates alone are insufficient to describe all mutations.
Include mounted applicable actions even when nobody's owner role contains them. Never infer a list from role names,
action-name prefixes or a frontend switch. Parent-authorized creation is advertised on its authority parent; new
resource IDs do not confer creator permission. Composite commands must expose their complete known authority needs.

Each module supplies bounded existence/visibility and domain-eligibility readers for its resource types. The same
ports must serve commands: no second interpretation of published/locked/deleted/member state. Account settings bind
the actual account; proposal transitions bind the proposal's declared authority; Collection member operations bind
their command's Collection authority plus known prerequisites. No arbitrary callback from request JSON.

Access owns one supported `viewerActions` batch port, registered through `accessRoot` so derived Access adapters keep
the same implementation. It returns independent per-resource/per-action decisions, not one all-or-nothing execute
proof. Use the existing singleton/page formula and preparation machinery; extend that port for result vectors and
domain floors where needed. `resourceAuthorizationPage` currently requires all decisions to permit and supplies no
anonymous eligibility; its execute proof cannot simply be reused as a viewer result. Never copy permission SQL into
a module or a new route. The explicit-without-floor port is also not the ordinary viewer decision.

For each candidate operation: resolve its trusted authority and module prerequisites, apply admission's gate and
credential requirements, then the installed ordinary Access decision with the real actor/client/principal and fresh
request evidence. A grant-derived positive requires the exact action scope; a gated operation also obeys discovery's
scope filter. A genuinely anonymous-admitted public-floor operation retains its existing semantics. A closed gate,
missing scope, expired grant, invalid membership, revoked assignment or denial removes that operation. Include an
action only if at least one bound operation survives. No gate opening, role label or curator pointer is a shortcut.
Mint one kernel read T for the batch and pass it through the supported ports within their evidence deadlines. This
aligns temporal validity checks; it does not create a distributed snapshot or freeze policy changes between reads.

This answer authorizes **offering/starting an action**, not a particular future payload. Unknown grant recipients,
requested grant actions, selected child objects, workflow approval, revision preconditions and input validation still
belong to the command. For an identical valid input, unchanged policy/domain evidence and the same T, the shared
checks must agree; otherwise a mismatch is a kernel defect. A generic action list cannot certify arbitrary future
input. Rate limits, capacity errors and concurrent changes are not predicted permission outcomes.

### Cost bound

Adopt a composition cap of **64 candidate actions per resource type and 256 operation bindings per type**; reject an
over-budget registration at composition, rather than silently truncating a result. These are proposed initial
limits, not existing guarantees. Each binding also declares a validated, fixed maximum E of authority/prerequisite
checks, including visibility and floor work; reject an unbounded binding. Group only compatible derived
route/type/action/authority bindings, with at most 100 IDs per homogeneous formula page. A mixed page has N supplied
resource anchors for N ≤ 100 and at most NBE declared authority checks; deduplicate shared account, principal, group
and gate work within the request. Use bounded scheduling and release connections before another anchor.

Let A ≤ 64 be the maximum applicable action count, B ≤ 256 the operation-binding count, and E the largest declared
check bound. In Access's existing notation, k ≤ 2 actor/principal identities, J ≤ 1000k ≤ 2000 admitted inverse
entries, V ≤ J matched membership proofs, R catalogue role expansion. A conservative implementation ceiling is
**Σ over compatible binding/check groups of (P + Q(page))**, plus declared bounded module work and one deduplicated
gate snapshot for the mounted groups. Without any batching benefit, a detail read costs at most BE(P + Q(1)); a
page costs at most NBE(P + Q(1)). With one common authority per action, H ≤ N homogeneous route/type groups need
at most AH preparations and AH formula statements, with Σ(page sizes × actions) ≤ NA. Distinct operation anchors or
prerequisites require their own groups within the larger bound. A genuine shared preparation port can reduce this;
do not claim reuse across bindings unless the installed port actually supports it.

P uses O(1 + J + V) rows and `2 + d + k + V` native statements; Q(page) probes O(Ngroup(1 + J)) bounded keys,
expanded by trusted roles R, and emits one decision per ID. At fixed catalogue, page size and admitted membership,
rows/statements stay constant as unrelated grants, denials, members, resources and temporal history grow; indexed
blocks retain Access's measured logarithmic growth in stored history. Work is at most linear in capped J (and role
expansion), with total decision output O(NB). Assignment/account seeks and a fresh acting-account observation are
included once per applicable request preparation; command attempt admission still runs independently on writes.

Each registered module must declare a constant number of indexed validation/authority hops per binding. Visibility
and floor preparation costs must be included, not hidden behind the Access formula bound. Do not enumerate ACLs,
scan all organizations, call LookupResources to fill a page, or retry candidate scans until enough allowed items
appear. Existing list selection retains its own contract. Assert statement/row/buffer bounds through the real Access
ports, including gate reads, cross-partition anchors and unavailable paths.

### Caching and time

Return `Cache-Control: private, no-store`; fetch with the same credential as the eventual command and bypass edge
caching for this endpoint. Anonymous callers may use it for genuine public-floor actions; their results are also
uncached. Keep anonymous HTML, public JSON, sitemap responses and shared hydration payloads free of viewer data.
After hydration, fetch one personal batch for the detail/list page. While pending or unavailable, show no enabled
mutation controls; an unavailable state may offer retry and must not masquerade as “you lack permission.”

Recompute on **every next personal read**; never serve an old positive via TTL, stale-while-revalidate, resource ETag
or a public content revision. Grants, consent, gates, account floors and bans can change without that revision.
Request-local deduplication is permitted only for the same complete actor/client/scope/principal/anchor/action
binding within the native evidence deadline. Preserve Access's bounded evidence lifetime; it is not a browser lease.
Refresh current account/fence evidence through Access rather than carrying a prepared actor across requests.

Refresh on navigation, page refresh, identity/client/principal change, page focus and after a local permission-changing
command; event notifications may trigger additional reads. Bind in-flight responses to the current credential
context and page generation so an old editor response cannot overwrite a later revocation result. Discard old
controls before switching identity. An already open idle tab need not change before another observation; “next read”
is not instantaneous push revocation. A click still calls the command, which reauthorizes at its own T, including
fresh command account admission. Handle denial by withdrawing the control and refetching. No bearer authority,
grant provenance or promise of future admission is encoded in the result.

## Acceptance examples for adoption

Use native reads/commands and genuine credentials in the eventual implementation tests. Test detail and list-page
personal batches against the same personas, with valid command input and other prerequisites satisfied.

| Persona / change | What the person sees on the next read | What happens when they act |
| --- | --- | --- |
| Curator of “Favourite vegetarian meals”, proper scope and admitted Collection gate | Editing is offered because the current installed owner authority passes `collection:update`. | A valid edit is admitted while that authority remains current. |
| Delegated editor, different account from curator, current `collection:update` grant and scope | The same editing controls appear on the Collection and its applicable list row. Curator identity still describes attribution. | The same valid edit is admitted. No curator-equality branch is involved. |
| That editor after grant/role revocation, using the same bearer | Editing disappears on the next personal read, even if content/revision did not change. | A stale control's edit is refused without effects. |
| Token missing `collection:update`, despite grant and open gate (also test held `gate:any`) | No Collection-edit operation is offered. Other separately admitted public-floor reads can remain available. | Editing is refused. The gate and grant do not supply the missing consent. |
| Anonymous reader of a public Collection | Can read through the verified anonymous floor and admitted exposure; cannot edit. A closed Collection gate is not opened by public visibility alone. | Public read succeeds only under its native floor/gate; mutation is refused. No personalized data enters cached HTML. |
| Suspended/fenced account that formerly edited | Its refused credential yields the normal authentication/Access failure, never an old positive or silent signed-out fallback. No enabled editor controls. | Edit is refused; a separate anonymous public read has only anonymous authority. |
| Banned Realm member with otherwise live membership/grants | Join/participate controls covered by the current `realm_ban` denial disappear; unrelated permitted reading remains governed by its own checks. | Denied participation is refused. Ending the ban restores only authority the formula still grants. |
| Assigned actor whose principal lacks the action, is suspended, or whose assignment was revoked | The action disappears despite the actor's own grant and scope. Organization/Realm role membership expiry has the same result. | Command refuses at its T. Both grant operands and current assignment/state are required. |
| Closed gate later opened, then closed; scoped caller with and without resource authority | Opening alone offers no mutation to the ungranted caller. The granted/scoped caller sees it only while admission allows the gate. | Command and discovery use that same gate rule; no alternate evaluator. |
| Visible resource with no allowed candidates versus unavailable Access | The former returns an empty action list; the latter shows retry/unavailable after 503 and supplies no partial positives. | No fabricated denial/allow and no effect on failure. Missing or concealed resources share `not_found`. |

Also test the same action behind differently gated operation IDs; a permitted operation must not enable another
control. Cover Space/Realm management, boards/threads, Zones, proposals and account settings through each module's
actual action declarations, including a catalogue extension that needs no web permission code. Verify exact denial
actions, genuine floor-without-scope behavior, Global governance reach without read-side writes, grant expiry at T,
cross-person response isolation, and unchanged query bounds as unrelated data/history grows.

## Changes needed and decisions made

- **Kernel / Access:** supported read-decision batch port, current identity evidence, shared gate admission, bounded
  vector results, native failure classification, route/schema/client typing, and validated data-defined bindings.
  Extend existing formula/page ports where needed; maintain one SQL authority. The personal read must not mint an
  execute capability or write governance-use records.
- **Each owning module:** register its resource/authority bindings, bounded visibility/eligibility readers and all
  applicable catalogue actions; factor command prerequisites into shared supported ports. Preserve module-specific
  concealment and disclosure. Resolve management by actions, with existing documented exceptions only.
- **Web and other interfaces:** fetch the same contract for detail and displayed list items, use action plus operation
  membership for controls, remove curator/role/staff permission guesses, isolate credentials and refresh/refuse safely.
  Shared components may map operation IDs to labels/forms; they do not evaluate policy.

Resolved ambiguities: use a separate personal batch for **both** detail and list views to preserve public caching;
return operation IDs as well as action names to disambiguate gates; keep the genuine anonymous floor exception to
scope filtering; treat suspension as refused credential rather than public downgrade; interpret “exactly” as shared
authority for valid input at a given T, with command-time revalidation; use forward checks rather than discovery
enumeration; choose explicit composition caps rather than an unbounded extensible catalogue. All are proposed
adoption decisions, not claims of implementation. Once adopted, move the contract to the owning Access/module
documents and leave this report as evidence.
