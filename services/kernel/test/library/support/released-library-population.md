# Released Library population contract

This is the Commerce extension of the [shared released discovery fixture](../../../../../packages/definitions/src/released-discovery-fixtures.md),
version 1. It supplies native setup and acceptance specification, not a product implementation, frozen acceptance,
release promotion, membership oracle or completed parent capability. The owning rules remain
[Library](../../../../../docs/library-and-collections.md),
[profiles](../../../../../docs/library-profile-consumers.md),
[labels](../../../../../docs/library-labels.md),
[dynamic Collections](../../../../../docs/dynamic-collections.md),
[filtered lists](../../../../../docs/filtered-lists.md) and
[erasure](../../../../../docs/deletion.md).

## Actual interface

Import from `services/kernel/test/library/support/released-library-population.ts`:

```ts
async function createReleasedLibraryPopulation(options?: { version: 1 }): Promise<ReleasedLibraryPopulation>;
```

Omitting options selects version 1. `ReleasedLibraryPopulation` is the exported inferred return type; its exact
closed members are below. There is no injected driver, transport, release, truth, resource ID, policy or query port.
Use one instance at a time, as required by the shared native driver's abandoned-setup recovery.

```ts
const population = await createReleasedLibraryPopulation({ version: 1 });
try {
  const holding = await population.holdings();
  const read = await population.request('alice', 'GET', `/v1/copies/${holding.copy.id}`);
  // Assert native status, body and subsequent owner reads.
} finally {
  await population.close();
}
```

| Member          | Actual output / operation                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`       | Literal 1.                                                                                                                                                                                                                                                                                      |
| `base`          | The single actual `ReleasedDiscoveryFixture`, created with `{version:1}`; its release, personas, shared Book/Recipe groups and native transport are reused.                                                                                                                                     |
| `calls`         | Read-only view of extension calls: persona, method, path, body, actual sent headers and original `HttpResponse`. Failed statuses remain intact. Base subject/editorial calls remain available through base transport, not rewritten here.                                                       |
| `request`       | Exact base request signature and original response; extension calls are journaled without normalization.                                                                                                                                                                                        |
| `profile(type)` | Actual HTTP-read bundled type reference and registry object, plus the expected accepting pin derived from that same release. This metadata is not proof that a backend persisted a pin.                                                                                                         |
| `state()`       | Own state-only Book subject, selected active-role choice, expected accepting metadata, native entry handle and original response.                                                                                                                                                               |
| `labels()`      | Own `vegetarian` label; shared B-long label-only assignment without an entry; Bob's distinct label/assignment on that same subject; independent Recipe with a private label and unchanged public unknown diet, including original public-before response.                                       |
| `sessions()`    | Separate Book subjects supported only by active session and completed history. Each has create/record/optional complete responses, actual session handle and expected accepting metadata.                                                                                                       |
| `holdings()`    | Separate Book supported only by a copy, actual copy handle, response and expected accepting metadata. No state or purchase.                                                                                                                                                                     |
| `controls()`    | Empty subject, follow-only subject with native follow response, Bob-only state subject and curated-only subject. Empty subject is not an entry shell.                                                                                                                                           |
| `multiple()`    | The same `state()` subject with independent native holding and completed session.                                                                                                                                                                                                               |
| `recipes()`     | The base's shared released Recipe group; Alice create/record/complete on R-cooked and Bob on R-other-cooked. Neither creates state/copy.                                                                                                                                                        |
| `sources()`     | Three curated source handles (public/unlisted/private), original create/member responses and ordered occurrence handles. Each contains every shared Book, edition, Recipe, personal support and empty/follow/Bob/curated-only control, plus a second B-long occurrence with a distinct note/ID. |
| `prerequisites` | Explicit non-success boundaries: shell, ownerReadonly, publishedDynamicAndZone, historicalProfiles, cookedQuery. They are never successful populated groups.                                                                                                                                    |
| `close()`       | Idempotently closes only the owned base resources. A failed family closes the base and rethrows native evidence; combined cleanup failure is preserved.                                                                                                                                         |

Families are lazy and memoized. Each acceptance owns a fresh instance and closes in `finally`, including assertion
failure. This isolates missing labels, profiles and released measurements rather than introducing a skip mode or
another product capability. Callers must discard an instance after a family fails. A partial family is never
returned as successful. No SQL is issued by this extension; all positive routed IDs come from owner HTTP receipts.
The base's native Auth, Access, default kernel and owned projection infrastructure are retained. No worker readiness
is inferred from link projection, and no replacement worker or permission map is installed.

## Native writes and reads

The following describes required native setup/assertions, not shipped profile-aware commands. Source inspection at
integration base `21a2c4bbb75a3d17f3d25666a61cfd6c0eb0f679` finds `entries.ts` still checking five fixed
`ENTRY_STATES` with `state()` before the command body, without a profile lookup or accepted pin. `copies.ts` and
its HTTP DTO have fixed statuses and no kind/profile/pin admission. `sessions.ts` uses `parseSessionCreate` and
`parseRecord` from `progress.ts` with fixed units. Profile/compiler/decimal helpers and prospective native command
tests exist, but their existence establishes no profile-aware writer or native pass.

Entry writes use `PUT /v1/libraryEntries/{subjectId}` with a state selected by declared active role from the actual
Book profile. There is no universal `in_progress`. Copy creation sends the profile's declared kind and status;
the legacy kindless route is not treated as proof of profile-aware admission. Session creation uses a declared
scalar mode/unit, records its declared minimum (or zero where absent), then explicitly completes history sessions.
Recipe sessions require the actual declared scalar/minute pair; public cookTime storage's expanded Wikidata IRI is
not a personal progress unit. Recording zero is a controlled progress fact, not a cooking duration inferred from
catalogue data, and completion is the explicit native complete command. Missing required choices fail with release
digest and exact field; there is no fallback registry, synthetic type or unsupported422 success.

Labels use only the adopted `POST /v1/libraryLabels {name}` and
`POST /v1/libraryLabels/{id}:assign {subjectId}`. Lists assert actual `{id,name,revision}` and
`{id,labelId,subjectId,revision}` tuples. No invented label/subject PUT or point-label GET is used. Follows use PUT
with no body. Curated setup uses existing create/member/visibility APIs and preserves occurrence multiplicity.
Fresh structured idempotency keys are supplied for native writes. Updates, clears and completion carry the actual
returned revision. No client truth flag, owner_write_seq, pin or authorizing assertion is sent.

Everything is discovered from the owner's actual Collection list. Acceptance requires the native dynamic
Everything descriptor and members response, then compares the exact own union once. Shells, follows, curated
occurrences and Bob-only supports never enter that expected union. The helper exports no membership result.
An absent route, missing dynamic descriptor or unsupported response remains a real failing assertion.

Clear acceptance requires the adopted per-subject DELETE with revision, requires 204 and the two native descriptor headers
`Library-Entry-Deletion-Id` / `Library-Entry-Deletion-Revision`, and restores through
`POST /v1/libraryEntries/{subjectId}:restore` with closed `{deletionId,revision}`. The ordinary entry and independent
holding/history must be read back; original dates/state must survive Undo. Actual `entries.deleteEntry` still
physically deletes through `store.deleteEntry`, returning the old entry; HTTP emits empty 204 without descriptor
headers and has no restore route. Archive/incarnation schema and future native tests do not supply the absent
`entry-retention-store.ts` export, retained command outcome or completed DAO. The required archive keeps all 18
pre-delete snapshot fields in the owning entry deletion contract plus original `owner_write_seq`, with exact
720-hour expiry, addressed deletion/incarnation CAS and empty-slot/no-overwrite restore. These remain native
acceptance obligations. Undo must allocate a new private owner sequence,
but this fixture neither manufactures backend counters nor claims HTTP can prove their allocation. Native owner
state-write acceptance remains responsible for that transaction invariant. Deleting a label parent must immediately
invalidate its effective assignments and remove Alice's final support even while Bob's independent assignment lives.

## Explicit unavailable producer boundaries

The shared base opens Collections but does not provision personal Library, progress or commerce capability gates.
Native follows and entitlement reads currently return403 `platform_closed`; these remain visible setup prerequisites,
not evidence of an owner denial or an empty payment list. This extension does not install broad grants or alter gates.

The actual base exports only Alice/Bob/outsider/unscoped account handles. Its internal genuine identity factory is
not exported. Unscoped denial is covered; it does not prove an Alice read-only bearer, which remains a prerequisite.
The delivered Semantic `suspended` persona already carries the genuine pre-suspension bearer. Native suspension
fences authentication and advances its floor, revoking that bearer: HTTP `401`, JSON problem code
`invalid_credentials`, exact raw `WWW-Authenticate: Bearer error="invalid_token"`. `invalid_token` is a challenge
error only, not a JSON problem catalogue code. There is no valid-suspended-bearer prerequisite or exported
population key. This supersedes the older hypothetical producer requirement still present in the base's privacy
descriptor/document; neither base nor Auth is altered here. Auth issues tokens only for active accounts. Verified
correct-password sign-in's `403 ACCOUNT_SUSPENDED` with no session is a distinct journey; defensive kernel
`403 account_suspended` handling cannot justify a manufactured bearer. No SQL state, JWT or authentication-floor
bypass is permitted. `403 insufficient_scope` challenges and all other `401` responses remain unchanged. The
revoked native control asserts private-list concealment and unchanged owner Collections after a refused write.

The adopted entry PUT requires state. No actual adopted shell creation API exists, so there is no raw shell INSERT
or fake shell handle; the empty-subject control is explicitly distinct. Historical renamed/retired bundled profiles
still require two real immutable released objects from the base producer. Current bundled choices are independently
required in acceptance; custom compiler/extension suites remain separate evidence. Public occurrence setup cannot
supply a published dynamic generation, mount or Zone. Base `sources` is a prerequisite descriptor, not a callable
source group, so v1 creates only its one curated group. Native mount/publication APIs and their workers remain
explicit prerequisites. Generic completed-session query adoption remains open; there is no `notCooked` request,
policy or backend switch.

## Acceptance and handoff

Run once after the final relevant edit:

```sh
bun run --cwd services/kernel check test/library/released-library-population.test.ts
bun scripts/typecheck.ts
```

The literal native test titles proposed for freezing are:

- `released native Library population is created only through actual owner APIs and discriminates state-only label-only retained-session holding shell follow-only and other-owner support without a synthetic released model`
- `Released personal supports are independent: own native state does not invent a label session holding or payment`
- `Released label-only B-long and a private vegetarian label preserve no-entry support and public Recipe classification`
- `Released active-session-only and completed-history-only supports create neither entry nor copy and retain actual changes`
- `Released holding-only support retains a native copy without an entry session or payment`
- `Shared controlled labels copies and session history retain no-entry supports while Bob facts never become Alice private rows`
- `Unscoped native identities cannot create private Library support`
- `Native pre-suspension and invalid bearers reach401 invalid_credentials with invalid_token challenge and no private disclosure or effects`
- `Discovered Everything has the exact own support union once and excludes empty follow curated and Bob-only controls`
- `State clear removes only state while native history holding and exact Undo descriptor survive`
- `Removing the final live label support removes presence on the next owner read and deleted parents never qualify`
- `Released Recipe cooking history belongs to Alice on R-cooked and only Bob on R-other-cooked without state or copy`
- `Bundled Book game Recipe and record choices are actual release bindings without a universal active state or synthetic pin`
- `Released curated source setup preserves raw duplicate occurrences and public unlisted private controls`

The executable titles reside in `released-library-population.test.ts`. These are proposed acceptance bytes for
manager review/freezing. Their required success paths remain red against missing native data/implementation;
no missing-driver verifier, caught error, skip/todo, fake successful page or unsupported response counts as completion.
The handoff must report the exact titles/counts, observed native failures, format status, file hashes and real commit.
Only the explicitly amended native credential case/title is reconciled here; the other 13 cases and all frozen
parent scenarios remain unchanged. This suite adds fixture discrimination and source setup rather
than duplicating curated CRUD, profile migration, privacy ordering or retained-history frameworks.

Read-only reference surfaces inspected: the indexed BookWyrm `bookwyrm/models/shelf.py` owner-local uniqueness;
Bangumi `openapi/components/user_subject_collection.yaml` and `user_subject_collection_modify_payload.yaml` separate
tags/state; Mealie `tests/integration_tests/public_explorer_tests/test_public_cookbooks.py` public/private exact-ID
controls and `tests/integration_tests/user_household_tests/test_group_cookbooks.py` native create/read patterns.
Paths and revisions are recorded in `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`. No source was copied,
executed or modified. The API acceptance gaps report supplies evidence; adopted owner wire takes precedence.

## Cost

### Released fixture population

- Touches: one existing shared native release/Concept/subject world, Auth/Access and finite named owner writes and
  readbacks; no global/account scan, broad own grant or public-index copy of private facts.
- Bound: fixed named subjects and three curated controls; each family executes only explicit finite setup calls.
  Native errors propagate. Provider, metadata, Auth, setup and worker work are separate from measured requests;
  none is hidden as a free query counter. No automatic retry or raw SQL fallback exists.
- Growth check: downstream member/filter/API bindings use [three-scale checks](../../../../../docs/filtered-lists.md#three-scale-checks)
  and their counted-unit harness. This population acceptance claims neither composed numeric cost nor completion
  of the unbound owner suites or parent capabilities.
