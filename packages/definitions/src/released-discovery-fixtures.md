# Released discovery fixture contract

This is a versioned native acceptance fixture contract, not a definition release, source registry or completion
claim. The [capability inventory](../../../docs/goals/semantic.capabilities.md) tracks consumer outcomes. Product
meaning stays with [definitions](../README.md), [filtered lists](../../../docs/filtered-lists.md),
[library profiles](library-profile-design.md) and their native owners. The reviewed
[mapping report](../../../docs/research/catalogue-filter-data-mappings.md) supplies evidence, not a second authority.

## One builder

Import `createReleasedDiscoveryFixture` and `ReleasedDiscoveryFixture` from
`services/kernel/test/support/released-discovery.ts`. The only supported version is **1**:

```ts
const fixture = await createReleasedDiscoveryFixture({ version: 1 });
try {
  const classification = await fixture.classification();
  const response = await fixture.read(classification.lightNovel);
  // Assert the actual status and owner's unmodified response body.
} finally {
  await fixture.close();
}
```

Options are closed to `{version: 1}`; omission selects version 1. No caller-supplied transport, release, driver,
truth callback or passing fallback exists. The builder imports the native `createSemanticDriver` module, never a
test module. It owns that driver's database, Auth accounts, real grants, kernel handle and link relay. Setup failure
closes owned resources; strict cleanup propagates failures, including combined setup/cleanup failures. A caller
must close after any group or assertion failure. Do not create concurrent instances through this driver: its
existing abandoned-setup recovery closes earlier instances. There is no new global singleton.

The result is the closed `ReleasedDiscoveryFixture` interface:

| Member                                                   | Actual representation and authority                                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                | Literal `1`; changes to logical populations or meaning require a new fixture version.                                                                                |
| `release`                                                | Actual active `digest`, `activeHead`, and complete `definition` read over HTTP; digest agrees with `@rezics/definitions/bundled`.                                    |
| `personas`                                               | Real registered Alice, Bob, outsider and empty-scope account handles, each with native account ID and bearer.                                                        |
| `meaning`                                                | Released property identifiers, explicit unit spellings, reviewed external meaning and source-scoped harem contract; never routed resource IDs.                       |
| `classification()`                                       | Actual created schemes, light-novel, different-form and source-scoped harem Concepts, plus native proposal/acceptance/adoption receipts.                             |
| `diet()`                                                 | Actual created public dietary scheme, vegetarian and nonvegetarian controls, native scheme memberships and vegetarian external correspondence.                       |
| `words()`                                                | Word-population view of `books()`, retaining the explicit missing character/measurement producer prerequisites.                                                      |
| `books()`                                                | Closed `Record<BookName, CreatedSubject>`, edition and adopted fact receipts; rejects a failed native required write.                                                |
| `recipes()`                                              | Closed `Record<RecipeName, CreatedSubject>`, fact receipts and exact completed-session prerequisite.                                                                 |
| `personal`, `sources`, `privacy`, `profiles`, `platform` | Closed `{state:'prerequisite', owner, required}` descriptors. These are not callable fake APIs or seeded scenario evidence.                                          |
| `request(persona, method, path, body?, headers?)`        | Original native HTTP status, headers and parsed body. Uses existing Auth/Access; no response normalization.                                                          |
| `setup.openFeatures(groups)`                             | Explicit native governor opening of only `personal_library` and/or `reading_progress`; no additional default opening.                                                |
| `setup.spaceCreation(persona)`                           | Grants only Global `space:create` to one existing named discovery account through the internal native governor.                                                      |
| `setup.realmCreation(persona)`                           | Separately grants only Global `realm:create` to one existing named discovery account through the same native governor.                                               |
| `scoped(persona, scopes)`                                | Fresh same-account native Auth issuance for Alice or Bob; returns an account ID and scoped request transport.                                                        |
| `inspect<Row>(sql, values?)`                             | Trusted test-only typed PostgreSQL query result from the owned kernel database in the existing read-only transaction.                                                |
| `createSubject(type, name, statements?)`                 | Native `POST /v1/subjects`; returns only the actual `subject.id`, initial revision and accepting release.                                                            |
| `adopt(subject, statement)`                              | Native proposal, Context acceptance and adoption; returns candidate ID, acceptance/adoption heads, revision and release.                                             |
| `read(subject, persona?)`                                | Native subject GET; default anonymous.                                                                                                                               |
| `authoredRecipe(name, minutes)`                          | Independent native cookTime, ingredients and authored instructions control; does not imply diet or completed history.                                                |
| `filters(classification, diet)`                          | Shared grammar documents `words`, `formHarem`, `combined`, `dietTime` containing actual created Concept IDs. Grammar documents alone prove no query execution.       |
| `catchUp(subjects)`                                      | Runs the actual link projection in the actual source partitions until it reports drained; bounded failure is an error. Does not assert Search/publication caught up. |
| `close()`                                                | Existing driver's genuine idempotent cleanup; no other worker's resources are touched.                                                                               |

Supported request personas are anonymous, editor, acceptor, steward, suspended, Alice, Bob, outsider and unscoped.
Semantic personas preserve their existing native session headers. Account fixtures use the existing `fixtures.send`
transport. DELETE is available for account personas; the existing Semantic persona transport has no DELETE method
and rejects it. `discoveryKey()` supplies fresh structured Idempotency-Key headers. Setup grants use native grant
administration, not an allow-all Access replacement. “Outsider” has no editorial acceptance authority; normal
standing create/propose rights still apply. A name is not a denial flag.

The existing driver's `suspended` persona carries a pre-suspension bearer. Native suspension fences authentication
and advances its floor, so public-route revocation controls remain HTTP 401 `invalid_credentials` with
`WWW-Authenticate: Bearer error="invalid_token"`. The verified-suspended 403 branch is defensive; there is no native
valid-suspended factory. No fake token or direct account-state update supplies such a persona here.

## Explicit native setup and inspection

The support module exports `releasedDiscoveryFeatures`, the frozen tuple
`['personal_library', 'reading_progress']`, and its `ReleasedDiscoveryFeature` union. The actual additive signatures
on `ReleasedDiscoveryFixture` are:

```ts
setup: {
  openFeatures(groups: readonly ReleasedDiscoveryFeature[]): Promise<void>;
  spaceCreation(persona: DiscoveryAccountName): Promise<void>;
  realmCreation(persona: DiscoveryAccountName): Promise<void>;
};
scoped(persona: 'alice' | 'bob', scopes: readonly string[]): Promise<DiscoveryScopedTransport>;
inspect<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
```

`DiscoveryAccountName` is `'alice' | 'bob' | 'outsider' | 'unscoped'`; `DiscoveryScopedTransport` is a readonly
`{accountId, request(method, path, body?, headers?)}` handle. Its method accepts `GET | POST | PUT | DELETE` and returns
the original `HttpResponse`. The scoped bearer stays inside that handle; existing full-scope handles stay usable.
Requested scopes must be known mounted client scopes and a subset of the original account's scopes. Issuance uses
that account's real email/password through current Auth `/signin` and `/token`; native Access verifies unchanged
account ID and exact scopes. The underlying driver adds `fixtures.scopeVariant(account, scopes)` while preserving
`person(name, options)` and its incompatible-scope reuse rejection.

No setup call is implicit. The base's original collections opening, grants, pool, runtime, relay and cleanup remain
in use. `openFeatures` validates the whole list before mutation and delegates to the driver's same-named fixture
operation. Each distinct group uses the internal governor's real credentials for
`POST /v1/platform/exposure/{group}:open`, a fresh quoted `Idempotency-Key`, existing `send` transport and unmodified
native session/response headers. Success requires HTTP 200; failure rejects with the exact native `HttpResponse`
(status, headers and raw parsed problem). Repeated opening uses native idempotent no-op semantics.
`personal_library` covers Library plus mounted reaction/rating families that declare it; `reading_progress` covers
progress. Public Content endpoints need no extra group. Space creation separately uses `fixtures.grantAccount` for
only `space:create` on Global. Realm creation separately uses the same internal
`driver.fixtures.grantAccount(personas[persona], ['realm:create'])` with its existing Global default. Both helpers
require an open fixture and validate an existing named account before mutation, return void and retain that account's
actual identity, bearer and scopes, including the unscoped account's empty scopes. Neither grants the other's action,
`space:manage` or `context:read`, changes ownership, opens gates or creates resources. No governor handle, arbitrary
grant operation, gate grant, commerce group or Content reaction standing workaround is introduced.

Inspection delegates directly to `withReadTransaction` on `driver.fixtures.pool`, retaining its native
`REPEATABLE READ READ ONLY` snapshot, deadline, rollback and connection release. Only query results escape; no pool,
client or alternative database is returned. This is a trusted fixture SQL boundary, not a sandbox for hostile SQL
transaction control. PostgreSQL rejects an ordinary mutation with `25006`; inspection and scoped transports expire
when the fixture closes. Consumers must close the fixture even after a rejected query.

`test/semantic/released-discovery-capabilities.test.ts` qualifies these primitives with initially closed 403 gates,
exact opening rows, actual released Book active-role state and stored progress rows, same-Alice read-only no-effect denial,
independent full-scope/Bob controls, explicit Space creation and read-only inspection. It does not qualify Liked,
completed history, canonical state, Search workers or the remaining producer scenarios below. Content's native
Global `reaction:set` standing remains its owner's prerequisite; this setup never grants it per subject. The current
mounted progress writer still stores a null `library_profile_pin`; profile-consumer runtime adoption remains outside
this setup capability. The existing gated-route error handler normalizes invalid bearers to 401
`authentication_required`/`Bearer`; this fixture preserves that native response as well.

### Native Context and Realm integration recipe

`test/semantic/released-realm-creation-capabilities.test.ts` adds two native cases for the explicit Realm capability
and unchanged defaults/scopes. Use the same `createReleasedDiscoveryFixture()` instance throughout:

1. As the existing `editor` persona, `POST /v1/contexts` with exactly
   `{"labels":{"en":"Discovery Realm classification"}}` and a fresh quoted `Idempotency-Key` from `discoveryKey()`.
   The editor already has native Global `context:create` and its mounted action scopes. The 201 response's
   `context.id` is the Realm's `contextId`; the response has `kind: 'community'`, `settings: null`, `defaults: {}`.
   Alice's `GET /v1/contexts/{context.id}` returns 200 for this actual community Context.
2. Call `await fixture.setup.spaceCreation('alice')`, then as Alice `POST /v1/spaces` with exactly
   `{"title":"Alice Realm host","summary":"Native Realm host"}` and a fresh `discoveryKey()`.
   The 201 response's `space.spaceId` is the Realm's `spaceId`. Alice is the Space creator; native initialization
   supplies her Space owner authority, including `space:manage`.
3. Alice initially receives 403 `forbidden` for the Realm request below. Call
   `await fixture.setup.realmCreation('alice')`, then as the same Alice `POST /v1/realms` with a fresh `discoveryKey()`:

   ```ts
   {
     spaceId: aliceSpace.spaceId,
     title: 'Discovery native Realm',
     summary: 'Explicit Realm capability control',
     visibility: 'protected',
     contextId: context.id,
   }
   ```

   This returns 201 with `realm.realmId`, `realm.headRevisionId`, the supplied Space/Context IDs and Alice as
   creator/author. `Location` is `/v1/realms/{realm.realmId}` and `ETag` is the quoted head revision ID;
   Alice reads the same Realm with `GET` on that location (200).

Alice keeps her current mounted scopes, including `realm:create`, `realm:read`, `space:manage` and `context:read`.
Only the original `collections` gate is open; personal Library and progress remain closed. The Realm command
independently requires Global `realm:create`, native `space:manage` on an existing free host Space, and native
`context:read` with `publicContextEligibility` on the supplied Context. The latter checks the actual
`semantic.context` row through `context-public-evidence.sql` and `context-public-exists.sql`; a routed unknown ID
has no eligible row. An Alice scope variant omitting `context:read` cannot read the existing Context (404) and
cannot create the Realm (403), even with the Global grant. A variant omitting `space:manage`, Bob's Space, a wrong
resource used as a Space and an unknown Space also yield 403. An occupied Space denies a second Realm (403).
Ungranted Bob's own-Space request denies independently; the granted empty-scope account still receives 403.
These are native denial/no-effect controls, not a new private Context mechanism or a Global Context recipe.

The helper supplies no local facts, ratings, reviews, Realm sources, Liked membership, Everything state or runtime
population. Those consumer prerequisites remain open. No successful Realm creation implies those outcomes.

Separately, `catchUp` follows the actual `events/log.ts` `BatchResult` union: every `stopped` result throws with
its native `gap | epoch | unknown_type | invalid_data` reason before success handling. Only `read` with zero
envelopes completes a partition. `busy` yields 5ms and retries within the unchanged 200-call cap per distinct
partition. It retains the same link projection and subject set; no new relay API or readiness claim is exported.
The Realm positive cases do not exercise every stop reason or establish Search/source publication readiness.

The native kernel retains the real write-rate limiter with a fixed test startup budget of 1000 new-account writes
per 60 seconds, admitting this bounded population without rate-limit noise. No global environment override or
request retry is used. Adoption addresses slots through the kernel's actual `isRelationProperty` classification;
a definition's presentation relation group alone does not imply a target-addressed editorial slot.

## Released meaning and honest admission

Setup reads `GET /v1/definitions/active`, republishes the identical bundled object with
`POST /v1/definitions/releases` (existing digest, HTTP 200), and reads
`GET /v1/definitions/releases/{digest}`. No fixture compiles custom definitions or alters the active release.
Tests require Book word-count/form facets, Recipe diet/time facets and actual Book/Recipe/game profile references
resolved in that same release. Missing data fails with the observed immutable release or native problem response.
A rejected required request is a red, not a completed capability. Tests neither skip nor substitute optional facts.

| Logical group  | Controlled population and expected meaning                                                                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| words          | `schema:wordCount`, exact nonnegative integer, unit `1`, Book facet. `B-long` 1200001, `B-edge` 1000000, `B-short` 999999, `B-unknown` absent, `B-characters` no word count. Zero is known; absence/somevalue/novalue are not zero.                                                                                        |
| classification | Existing `workFormat` / `wdt:P7937`, generalized to Book; real native Concept for the Q747381 literary-form sense, not a LightNovel subtype. Harem is the distinct Bangumi public `meta_tags` exact member `后宫` in its own public scheme via `schema:keywords`. Q690342 stays close only; no exact identity is asserted. |
| books          | Long and edge have both form/harem; short has form only; unknown has harem and absent form; characters has both and no words; tag-only has a different form; form-only has no harem. Edition belongs to unknown work and has 1400000 pages, never work words.                                                              |
| diet           | A public native Concept explicitly `schema:sameAs` Schema.org VegetarianDiet, in a real dietary scheme. No guessed Wikidata ID, private label, ingredient-name heuristic or licence inference. Nonvegetarian is an explicit controlled classification.                                                                     |
| recipes        | Quick vegetarian25; edge vegetarian30; slow vegetarian31; meat nonvegetarian20; unknown diet-absent20; cooked vegetarian20; other-cooked vegetarian20. Authored ingredient text and instructions use actual Content hooks, with the document's `CC-BY-4.0` licence scoped to that document.                                |

All titles, numbers and assertions are **controlled test cases**. The example.org reference identifies that status;
it is not a claim of an independently published measurement or of real-world/imported coverage. Classification
citations retain the reviewed source scope. Native created UUIDs come only from HTTP receipts. External QIDs/IRIs
are meanings/citations, never routed IDs or a licence to scrape text. Release YAML must not become a Concept registry.
No executable Bangumi classification producer is implied by these editorial assertions.

The released cookTime storage unit is **`http://www.wikidata.org/entity/Q7727`**. The admitted shared filter grammar
compares released unit strings exactly, so `minuteFilter` is also that expanded string; the report's `MINUTE`
placeholder is resolved to this actual value. `wd:Q7727` is the source YAML spelling, not an additional admitted wire
spelling. Internal amounts are signed integer strings. No prep/rest sum or duration/page/character estimate is
converted to cooking time or words. A Web export test separately owns `25 -> PT25M`.

Required catalogue sets, over this fixture's population:

- Book words strictly over 1000000: `{B-long}`, using inclusive `gte:1000001`, unit `1`.
- Light-novel form AND source-scoped harem: `{B-long,B-edge,B-characters}`.
- Both book predicates: `{B-long}`.
- Vegetarian AND cookTime at most30: `{R-quick,R-edge,R-cooked,R-other-cooked}`.
- Alice's eligible supported recipes not completed by Alice: `{R-quick,R-edge,R-other-cooked}` only **after** the
  Commerce prerequisite below is implemented. Logical cooked names alone prove no personal facts.

## Exact open producer prerequisites

These remain open even if the basic admission assertions later pass. A descriptor is not a successful fixture
producer. Extend this same builder with actual owner data when the owner adopts the representation; do not add a
parallel fixture or accept caller-injected truth.

| Group                 | Required native producer/adoption before its scenario can freeze                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| words                 | Release a separate local character property with 1400000 on B-characters and no invented external exact mapping. Adopt the measured holder/text/version/language/method/scope/provenance representation on the same statement/reference. Existing inLanguage/version definitions alone do not admit qualifiers. Current basic word amounts are controlled assertions only. Preserve qualifiers rather than recombining across statements; no edition-to-work projection. |
| books                 | The native Book keyword control covers compact/expanded creation, qualifiers, references, release pins, pending competition and rejected/deprecated evidence without replacing selected facts. Repeat these variants for word measurements once their qualifier grammar is adopted. Unknown/somevalue and crossed measurement associations still require that adopted grammar; existing editorial outcomes remain binding.                                               |
| personal              | Commerce must create state-only, label-only, active-session-only, completed-history-only, holding-only support; empty shell, follow-only and Bob-only exclusions. Collection membership creates no state. Own original IDs and occurrence multiplicity survive identity changes.                                                                                                                                                                                         |
| recipes               | Commerce must adopt the concrete completed-cooking-session predicate and owner-query wire, then create Alice completion on R-cooked and Bob-only completion on R-other-cooked. Clearing state cannot erase history. No `state != cooked`, catalogue-wide private NOT or recipe-specific backend switch.                                                                                                                                                                  |
| profiles              | Actual bundled accepting choices and two immutable released objects with renamed/retired choices preserving old accepting pins; Person with no profile cannot gain state. Existing synthetic profile suites do not prove launch choices. No universal `in_progress`.                                                                                                                                                                                                     |
| sources               | Actual curated duplicate occurrences/notes, public/unlisted/private Collections, completed published dynamic generations, mounted overlapping Zone and native source/default worker catch-up. A link-relay drain is insufficient.                                                                                                                                                                                                                                        |
| privacy               | Native moderation/source/consent commands for withheld harem, hidden targets, foreign tuple fence, withdrawn consent, hidden original/readable terminal, revoked and delegated actors. Valid suspended bearer 403; invalid/revoked 401. No SQL truth flags or private labels-as-catalogue.                                                                                                                                                                               |
| platform              | Adopt exact released platform/language/date same-statement qualifier representation. Current `schema:inLanguage` is string, not an item field; a credit-role qualifier is not language. Retain the Switch/Japanese plus PC/English crossed-tuple case; do not freeze a speculative property/QID binding.                                                                                                                                                                 |
| realm subject context | Content/Search must adopt the actual Context page schema and native local fact/rating/review population. No proposed report route is treated as mounted.                                                                                                                                                                                                                                                                                                                 |

## Native boundary and handoff

The first native suite is `services/kernel/test/semantic/released-discovery-fixtures.test.ts`:

```sh
bun run --cwd services/kernel check test/semantic/released-discovery-fixtures.test.ts
bun scripts/typecheck.ts
```

It is specification acceptance requiring successful released data and real HTTP results. It is not a green verifier
that removes a driver and counts errors. Its admission cases deliberately expose absent released facts. The suite
has independent definition, Concept, word, diet, recipe and authority cases; test-name selection uses the same native
setup. Private Collection denial and denied editorial no-effect checks are separate from missing data. Authored
instructions are read through `GET /v1/documents/{id}`, rather than treating a number or reference as content proof.

The remaining six-surface user scenarios are inventoried in the manifest. This suite does not query Search,
Collection members, Everything/state, mounted Zones or TypeLists and cannot mark those cells API-passed. Actual Zone
transport is `POST /v1/zones/{id}:readPage`, optional query cursor, existing owner body, 200 common page or 202 retained
preparation/no-store; never normalize it to a Collection envelope. The separate technical unfiltered
`GET /v1/subject-pages` crawler may return short/empty200 until next-null; it is not a filtered-list exception.

Format new support/tests before recording SHA-256 for acceptance review. Scenario names are TO-FREEZE until their
manager records accepted bytes; the existence of this contract does not freeze them or implement release data.
The handoff reports exact titles, hashes, version, observed native reds and these prerequisites. No existing frozen
test or formatter configuration changes as part of this fixture contract.

## Cost

### Construct and dispose one controlled fixture

- Touches: one existing native driver database/Auth fixture, fixed public Concepts/schemes and fixed Book/Recipe
  populations; ordinary create/propose/accept/adopt APIs, Content document hooks and link projection partitions.
- Bound: fixed logical populations; three editorial requests per adopted statement, fixed statement/reference
  inputs, at most 200 native projection steps per distinct subject partition. Failure propagates; no fake readiness,
  longer security deadline or unbounded retry. This setup bound is not a query-engine cost proof.
- Growth check: no new runtime operation is implemented here. Consumer growth remains required at 64/512/4096 under
  the native plan budgets in filtered-lists, including sparse pages, current disclosure and served share. Existing
  Semantic/Search/Commerce growth suites and the required composed-discovery scenario own that evidence.
