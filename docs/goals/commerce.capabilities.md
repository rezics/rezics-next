# Commerce capability acceptance inventory

This is the parent checklist for the complete [Commerce Goal](commerce.md), reconciled with
[first-public scope](../scope.md) and the [API acceptance audit](../research/api-acceptance-gaps.md).
Its historical inspection was at revision `6557c8ae6379cb0f5f9dbcbd849339530bc87bbb`.
Shared fixture delivery, credential reachability, profile writers and ordinary entry deletion are reconciled below
against integration base `21a2c4bbb75a3d17f3d25666a61cfd6c0eb0f679`; unrelated capability evidence remains historical.
It does not validate product completion, execute native cases, or replace the full Goal with a smaller test list.
Product authority remains in the linked owning specifications; the audit's suggested transports are not adopted APIs.
The existing per-capability Markdown format is used; no manifest schema or validator is introduced.

## Evidence and stages

Each capability has named job, authority, personas, fixture, surface, scenario, binding, gap and stage fields.
`APPLICABLE` means the job must be accepted there, including another owner's participating surface.
`NOTAPPLICABLE` explains a genuine abstraction boundary, not an implementation gap or permanent closure.
`MISSING` means required acceptance has not been frozen/bound here. `NOTPRESENT` describes an absent artifact;
`NOTREGISTERED` describes an absent production test binding/command. Source existence is not acceptance.

Each **Stages** field lists these five distinct stages, in order:

1. **Specification validated red:** `unknown` means no red-run evidence was inspected; a frozen declaration alone
   does not prove that validation ran. Missing composed scenarios still need acceptance-first freezing.
2. **Native driver registered:** records actual wrappers below, or `NOTREGISTERED` for the whole user job.
3. **Implementation exposed:** source-inspected partial behavior or missing composition, never inferred execution.
4. **User-case accepted at revision:** `unknown` everywhere in this initial inventory; there is no named passing revision.
5. **Promoted:** `pending` everywhere; main/root/integration proof is separate and has not been supplied.

All 276 exact literal scenarios in the eleven requested suites are indexed below. Only the Library and Commerce
suite wrappers are located: 47 literal registrations in source, not 47 passes. The other 229 declarations have no
located production wrapper. Primitive native tests are useful supporting evidence, never substitutes for those
bindings or the composed jobs. No count, source-shape check, missing-driver verifier, historical partial run,
manifest/file-presence acceptance or integrated change advances a product acceptance stage.

### Native binding register

Paths and argv below are existing, scoped native acceptance entry points to run at the capability gate, **not run by
this documentation change**. Kernel paths in argv are relative to `services/kernel`. The check runner provisions
native dependencies; directly importing an unbound spec is not equivalent.

| Suite               | Exact literal count | Inspected production wrapper and driver                                                                                                                                | Native acceptance argv                                                                  |
| ------------------- | ------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Library             |                  24 | `services/kernel/test/library/outcomes.test.ts` sets `LIBRARY_DRIVER` to `services/kernel/test/library/support/outcome-driver.ts`, exporting `createLibraryDriver`     | `["bun", "run", "--cwd", "services/kernel", "check", "test/library/outcomes.test.ts"]`  |
| Commerce            |                  23 | `services/kernel/test/commerce/outcomes.test.ts` sets `COMMERCE_DRIVER` to `services/kernel/test/commerce/support/outcome-driver.ts`, exporting `createCommerceDriver` | `["bun", "run", "--cwd", "services/kernel", "check", "test/commerce/outcomes.test.ts"]` |
| Library profiles    |                  37 | `specs/library-profiles-driver.ts`; native wrapper/implementation of the complete driver NOTPRESENT                                                                    | NOTREGISTERED                                                                           |
| Library labels      |                  29 | `specs/library-labels-driver.ts`; native wrapper/complete driver NOTPRESENT                                                                                            | NOTREGISTERED                                                                           |
| Dynamic Collections |                  30 | `specs/dynamic-collections-driver.ts`; native wrapper/complete driver NOTPRESENT                                                                                       | NOTREGISTERED                                                                           |
| Library bulk        |                  38 | `specs/library-bulk-driver.ts`; native wrapper/complete driver NOTPRESENT                                                                                              | NOTREGISTERED                                                                           |
| Collection source   |                  30 | `specs/collection-source-driver.ts`; native wrapper/complete driver NOTPRESENT                                                                                         | NOTREGISTERED                                                                           |
| Listing freshness   |                  14 | `specs/library-listing-freshness-driver.ts`; native wrapper/complete driver NOTPRESENT                                                                                 | NOTREGISTERED                                                                           |
| Library deletion    |                  18 | `specs/library-deletion-driver.ts`; native wrapper/complete driver NOTPRESENT                                                                                          | NOTREGISTERED                                                                           |
| Follow counts       |                  17 | `specs/follow-counts-driver.ts`; native wrapper/complete driver NOTPRESENT                                                                                             | NOTREGISTERED                                                                           |
| Viewer actions      |                  16 | `specs/viewer-actions-driver.ts`; native wrapper/complete driver NOTPRESENT                                                                                            | NOTREGISTERED                                                                           |

The two bound drivers use isolated migrated PostgreSQL, native Auth/Access and `createKernel.handle` returning raw
Responses. Library boots the bundled release, uses production worker modules and store-backed volume seeding plus
a real final member command; its volume seeding is not evidence every fixture was created over HTTP. Commerce uses
the official Stripe adapter against `test/commerce/support/fake-stripe.ts`, signed webhook bytes, native commands,
outbox and a separate production worker executor. Neither driver currently supplies the released composed jobs.
`test/library/canonical-source-fixture.ts` calls the real source factory, and conditionally loads
`DYNAMIC_COLLECTIONS_DRIVER`; it does not register or implement that missing driver. Its prospective DDL is not a
migration. Missing-driver contract/verifier suites are specification checks only.

Supporting native entry points include these existing argv, with their narrower scope preserved:

- `["bun", "run", "--cwd", "services/kernel", "check", "test/library/profile-entry-command.test.ts", "test/library/profile-session-command.test.ts", "test/library/profile-copy-command.test.ts"]`:
  prospective native data-defined command/HTTP acceptance using compiled **test** releases and
  `test/library/support/profile-entry-fixture.ts`. These tests exist, but their profile-aware writers are absent
  at the integration base; file existence proves neither passing admission nor the bundled vertical journey.
- `["bun", "run", "--cwd", "services/kernel", "check", "test/commerce/revise-offer-target-replay.test.ts"]`:
  native target-bound receipt regression, not offer discovery or the complete offer lifecycle.
- `["bun", "run", "--cwd", "services/kernel", "check", "test/commerce/payouts.test.ts", "test/commerce/payout-mark-paid.test.ts"]`:
  creator accounting and paid-reference primitives, not financial erasure participation.
- `["bun", "run", "--cwd", "services/kernel", "check", "test/library/sitemap-discovery.test.ts"]`:
  native discovery SQL behavior, not served Web XML or cache isolation.
  Existing `test/library/sitemap-http.test.ts` supplies the native HTTP feed collaborator, with seeded native rows.

The audit's suggested `services/kernel/test/library/collection-user-cases.test.ts`,
`services/kernel/test/commerce/purchase-user-cases.test.ts` and
`services/kernel/test/performance/composed-discovery-user-cases.test.ts` are NOTPRESENT here; their commands are
NOTREGISTERED. Names below identify missing-to-freeze jobs, not invented exports, paths or runnable wrappers.
Existing frozen tests remain unchanged. Reconciliation of superseded assertions belongs to their owners before
native binding; this inventory does not claim it has happened.

## Shared personas and released fixture contract

**Personas P:** Alice/owner, Bob/other, anonymous, authenticated unscoped caller, invalid/revoked bearer including
the genuine bearer held before native suspension, delegated/editor with distinct actor/principal and consent, and
revoked grant/assignment/consent. Protected-context ban beats an independent read grant immediately. Every applicable
read, write, receipt retry, continuation and final disclosure must use current native Access. Native suspension
fences authentication and advances its floor; the pre-suspension bearer returns HTTP `401`, JSON problem code
`invalid_credentials`, and `WWW-Authenticate: Bearer error="invalid_token"`. `invalid_token` is the challenge error
only, not a JSON problem catalogue code. [Accounts](../accounts.md) and [Auth](../../services/auth/README.md) admit
token issuance only for active accounts: there is no valid-suspended-bearer producer prerequisite. Verified
correct-password sign-in instead returns `403 ACCOUNT_SUSPENDED` with no session; that distinct Auth journey and
defensive kernel `403 account_suspended` handling do not make such a bearer reachable. No SQL-made state, JWT or
floor bypass supplies one. `403 insufficient_scope` challenges and all other `401` behavior remain unchanged.
An authenticated refusal never falls back to anonymous. Public facts and private viewer-self personalization have
separate disclosure/cache boundaries.

**Personas M:** P plus buyer, other buyer, refunded buyer, seller, creator, authorized payout operator and outsider.
Seller and creator authority are not inferred from buyer entitlements, subject authorship or organization pointers.
All records below explicitly select P or M and describe the job-specific actors. Accounts owns credential/ban/
delegation producers; Commerce owns its real consumer obligations, not a second authorization evaluator.

The ONE registered shared fixture delivery is the Definitions contract
[`packages/definitions/src/released-discovery-fixtures.md`](../../packages/definitions/src/released-discovery-fixtures.md)
and native acceptance producer
[`services/kernel/test/support/released-discovery.ts`](../../services/kernel/test/support/released-discovery.ts).
Both artifacts are delivered at the integration base; the earlier NOTPRESENT observation applies only to the
historical inspected revision. The actual export is
`createReleasedDiscoveryFixture(options?: {version: 1}): Promise<ReleasedDiscoveryFixture>`; omission selects 1.
It returns `version`, HTTP-read `release` (`digest`, `activeHead`, `definition`), native `personas`
(Alice/Bob/outsider/unscoped), `meaning`, lazy `classification()`, `diet()`, `words()`, `books()`, `recipes()`,
`request`, `createSubject`, `adopt`, `read`, `authoredRecipe`, `filters`, `catchUp` and `close`.
`personal`, `sources`, `privacy`, `profiles` and `platform` are prerequisite descriptors, not populated groups.
The old valid-suspended-403 requirement in the base's `privacy.required` and fixture document is superseded by
the credential barrier above; it is not a new Accounts producer obligation. Actual IDs come from native receipts.

Commerce's delivered extension is
[`createReleasedLibraryPopulation(options?: {version: 1}): Promise<ReleasedLibraryPopulation>`](../../services/kernel/test/library/support/released-library-population.ts),
with exported inferred return type and [contract](../../services/kernel/test/library/support/released-library-population.md).
It reuses one base and returns `version`, `base`, `calls`, `request`, `profile`, lazy `state`, `labels`, `sessions`,
`holdings`, `controls`, `multiple`, `recipes`, `sources`, `prerequisites` and `close`. Its native acceptance is
`["bun", "run", "--cwd", "services/kernel", "check", "test/library/released-library-population.test.ts"]`
(14 literal cases). Neither integration nor this registration proves accepted/passed/promoted user APIs. The base
opens Collections, not Library/progress/commerce gates; bundled profiles and measurement/diet admissions still have
meaningful native reds. No duplicate fixture, runtime or successful setup is inferred from these exports.

| Fixture set                    | Discriminatory logical data and delivery boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B: books                       | `B-long` has 1,200,001 genuine words; `B-edge` 1,000,000; `B-short` 999,999; `B-unknown` absent/somevalue; `B-characters` requires 1,400,000 characters and has no word count; the separate character producer remains a prerequisite. Page counts on editions and character counts are never words. Actual fixture meaning is nonnegative integer `schema:wordCount`, unit `1`; required bundled admission is still absent. Basic amounts are controlled assertions, not measured-source proof; holder/text/version/language/method/scope/provenance grammar remains open.                                                                                                                                                                                                          |
| F: form and tag                | Actual builder meaning uses `wdt:P7937` (`workFormat`, currently anime-scoped; required Book generalization remains red), with native light-novel and source-scoped harem Concepts from HTTP receipts. Light novel cites `http://www.wikidata.org/entity/Q747381`; harem is Bangumi public `meta_tags` exact member `后宫`, via `schema:keywords`, with Q690342 close only. No fabricated CURIEs or exact harem identity are supplied. B-long/B-edge have LN+harem; B-short LN without harem; B-unknown harem with unknown form; B-characters LN+harem but unknown words; B-form-only LN without harem; B-tag-only harem with other form. `schema:keywords` tag meaning is distinct from form.                                                                                       |
| R: recipes                     | `R-quick` vegetarian/25 min, `R-edge` vegetarian/30, `R-slow` vegetarian/31, `R-meat` nonvegetarian/20, `R-unknown` unknown diet/20, `R-cooked` vegetarian/20 with Alice's completed session, `R-other-cooked` vegetarian/20 with only Bob's completed session. Declared `schema:suitableForDiet` maps an adopted diet Concept to Schema.org VegetarianDiet; the native Concept correspondence exists, but required bundled `schema:suitableForDiet` admission remains red. Cook duration uses `schema:cookTime`; actual storage and filter unit are both `http://www.wikidata.org/entity/Q7727` (`wd:Q7727` is YAML spelling only), excluding prep/rest time. Authored ingredients/instructions are required. Bob's private label named `vegetarian` is never public diet evidence. |
| G: platform tuples             | Games/releases include Switch and PC and platform/language/date qualifiers on the SAME statement. Separate statements deliberately form a false Cartesian match. Actual approved Concepts and native released tuple producer are pending; no holding-derived platform join is promised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| H: historical profiles         | Real bundled Book/game/recipe/record consumer journey with two immutable releases, explicit accepted pins, changed/retired values and rollback. An unprofiled Person cannot acquire fresh profiled state/session/holding. Existing `fixture.*` compiled releases test generic plumbing only; they are not bundled acceptance. Full delivered vertical choices/two-release producer remain MISSING.                                                                                                                                                                                                                                                                                                                                                                                   |
| L: independent private support | Alice has state-only, label-only, active-session-only, completed-history-only, holding-only, overlapping multi-support, no-entry label/holding support, shell-only and follow-only controls; Bob has separate facts. No-entry differs from a state entry not equal to a selected state. Labels/sessions/holdings support Everything without inventing state; archive/deleted rows do not. Purchase, state, session, holding, follow, rating and subject reaction never imply one another.                                                                                                                                                                                                                                                                                            |
| C: sources and outputs         | C-public/C-unlisted/C-private contain all relevant controls, duplicate occurrences with independent notes/order and a B-long alias to a readable canonical terminal. Z-public mounts eligible overlapping Collection and saved scope; TypeList uses the configured released vertical. Completed public generation A and private pending B have different output/payloads. Only complete eligible public A can survive terminal de-identification; B never becomes public by deletion.                                                                                                                                                                                                                                                                                                |
| Q: privacy/cursors             | Withheld harem, hidden foreign tag target, revoked source/consent/foreign tuple fence, hidden original with readable terminal, hidden-only aliases, no matches and deep sparse matches. Include invalid/revoked credentials and the native pre-suspension bearer barrier, delegated editor and ban plus independent grant on a protected context. Exact result sets, exclusion, ordering and cursor metadata must all be safe; private witnesses never enter public caches.                                                                                                                                                                                                                                                                                                          |
| O: payment/retention           | Two authorized offers in the SAME partition with distinct offer targets and equal requested prices; other seller/target; captured existing order and receipt history. Controlled paid/unpaid/refund/dispute provider reads with barriers, abandoned/cached attempts and newer business no-op; known late-paid order repair and signed replay/forgery. Ordinary deletion before/at exact 720 hours, repeated episodes/replacement/CAS and parked purge; account-terminal all-graph plus separate financial participant and shared payload controls. No account-restore/hold/custody engine is implied.                                                                                                                                                                                |

Each capability's fixture field selects these declared sets plus inspected existing suite fixtures. Shared delivery,
actual released IDs and composed setup remain open unless explicitly described as existing; a native custom release
cannot close a released fixture requirement. Public member browsing canonicalizes identities; editing/export of
curated occurrences preserves permitted duplicates, notes and order.

## Contract reconciliation and remaining producers

- [Library](../library-and-collections.md) owns state reduction: highest committed per-owner `owner_write_seq` wins
  across original subjects, never timestamps, UUID order or an executor hook. Undo allocates a fresh sequence;
  originals, pins and independent session/copy histories remain. The [sequence prerequisite](../../services/kernel/src/library/owner-write-sequence.md)
  supplies schema/allocator only; entry set/clear/Undo writers and canonical reduction integration remain missing.
- [Filtered lists](../filtered-lists.md) owns scale/admission and query privacy. Its
  [three-scale checks](../filtered-lists.md#three-scale-checks) replace the audit's old membership/filter scale example.
  Per-plan rows/bytes/statements/pool/alias/depth/progress obligations remain; unrelated operation-specific scales
  stay valid. Old universal 4P/256 and dynamic empty-success/raw-nonmatch cursor assertions need owner reconciliation
  and native binding. A useful full/exhausted page or explicit readiness with finite retained progress is required.
- [Labels](../library-labels.md) owns `POST /v1/libraryLabels/{labelId}:assign` and minimal label/assignment DTOs;
  the audit's PUT example is not adopted. [Library deletion](../../services/kernel/src/library/README.md) owns
  per-subject `POST /v1/libraryEntries/{subjectId}:restore` and addressed deletion/incarnation CAS. No aggregate
  restore or invented endpoint is selected here. Continue/export/offer discovery/offer revision exposure and the
  common owner-query wire remain PENDING owner contracts, not false dependencies on workflow documentation.
- The two old label-only/trash state-support hypotheses need precise correction: a profiled or unprofiled
  label-only subject supports Everything but supplies NO accepted state-set tuple; do not inspect its current type
  to synthesize a state sibling. To test empty membership of a still-supported sibling after clearing an entry,
  retain a separate live pinned session/copy or entry supporting that exact state set. To test removal of the last
  tuple, remove that last live support and expect discovery/reference resolution to cease, rather than use an old
  opaque ID as an indefinitely supported empty view. Trash is exact Undo evidence, not live tuple support; Undo
  may re-establish its exact old pin only after current authorization/incarnation/deadline checks. In
  `specs/dynamic-collections-outcomes.test.ts`, inspect the setup/lifetime of
  `labels overlap optional state and retained sessions or holdings preserve Everything membership` and
  `profile retirement preserves every own fact until clearing or soft deletion without accepting new profile facts`
  against those rules. Preserve label-only Everything, no-entry queries, retained-history and privacy outcomes;
  owner reconciliation/native binding is still required, not accomplished by these notes.
- Bind follow-count and viewer-action suspension assertions to the actual native pre-suspension bearer: `401`
  `invalid_credentials` with the `invalid_token` challenge. A hypothetical valid suspended `403` prerequisite is
  superseded; no manufactured bearer is required. Existing public-Realm readability tests do not prove the
  protected-context ban barrier. These frozen files are not edited by this inventory.
- [Commerce's native refresh protocol](../../services/kernel/src/commerce/README.md) supersedes the audit's time
  watermark proposal. Times are metadata. Receipt-aware native order-revision admission/fresh provider read/apply,
  the shared metadata-only completion helper, default queue composition and repair producers remain missing.
  Conversely, current `commands.ts` already includes `offerId` in revise intent and has the native same-partition
  regression; the audit's old digest defect is not reported as still unfixed.
- Semantic projection/reduction-log/identity-epoch contracts are not delivered runtime ports. Required local and
  foreign query-safety acknowledgements include actual refresh-visible dependent repair, not just returned-row
  checks or counters. No witness cache, private mirror, test permission model or new framework is authorized here.

## curated-collection-lifecycle

**User job:** Create, edit, share, page and follow an ordered Collection while retaining independent duplicate occurrences, notes and moves.

**Source authority:** [Library and Collections](../library-and-collections.md); [Library native boundary](../../services/kernel/src/library/README.md).

**Personas:** P; Alice curates, Bob/anonymous read eligible public or known unlisted resources; editor exercises actual delegated authority, not curator equality.

**Released fixture data:** C, Q; current Library driver has native public/private/unlisted Collections and member-volume controls.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: public subject Collection listings; Library scenario `public subject listings count each public Collection once with multiplicity and exclude private derived rows`. |
| public curated                 | APPLICABLE: Library CRUD/visibility/notes/reorder/paging scenarios below; existing native Library binding.                                                                       |
| Everything WITHOUT state       | NOTAPPLICABLE to curation: Everything has no editable occurrences; unique read behavior is covered under builtin-discovery.                                                      |
| own-state Collection/predicate | NOTAPPLICABLE to curation: state membership is derived; predicate reads remain required under common query capabilities.                                                         |
| mounted Zone                   | APPLICABLE: `collection-actions` mounted canonical read; composed binding MISSING.                                                                                               |
| TypeList                       | APPLICABLE: `collection-jobs` configured list consumption, not editing duplicate rows; composed binding MISSING.                                                                 |

**Frozen scenarios:** [library outcomes](../../specs/library-outcomes.test.ts): `public private and unlisted Collections enforce owner other and anonymous visibility`; `members preserve first after last moves notes deletes and duplicate subjects across pages`; `two hundred inserts after one member respace bounded keys and reject the pre-respacing cursor`; `five thousand members succeed and the next member fails collection_full without any change`; `another account cannot mutate private or public Collections or their members`; `deleted Collection becomes unknown and leaves public subject and curator listings after settle`.

**Missing-to-freeze scenarios:** `collection-actions`, `collection-jobs`; reuse the existing CRUD suite rather than replacing it.

**Native wrapper/driver and acceptance:** Library register above: existing production wrapper/driver and exact Library argv. Shared composed consumers are NOTREGISTERED.

**Coverage gap:** Native curated CRUD exists; filtering, export, mounting, delegated discovery and composed current disclosure need their own acceptance.

**Stages:** Specification validated red: unknown; native driver registered: Library suite only; implementation exposed: curated APIs exist; composed consumers partial; user-case accepted at revision: unknown; promoted: pending.

## released-profile-journey

**User job:** Choose meaningful vertical-specific states/progress/holding values and keep the meaning originally accepted after release change, removal and rollback.

**Source authority:** [Library profile consumers](../library-profile-consumers.md); Definitions release contract.

**Personas:** P; Alice creates/pins facts, Bob/anonymous cannot learn pins or accepting types; revoked receipt retries reauthorize.

**Released fixture data:** H, L, Q; existing native profile-entry/session/copy fixtures compile test releases, not the required bundled two-release journey.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `released-profile-journey` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `released-profile-journey` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `released-profile-journey` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `released-profile-journey` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `released-profile-journey` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `released-profile-journey` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [library-profiles outcomes](../../specs/library-profiles-outcomes.test.ts): `profiled personal facts preserve release pins and legacy values through migration and replay`; `historic reads use their pinned release after head change and rollback`; `profile pins and hidden accepting types are absent from fact responses public collections and published logs`; `unprofiled readable subjects accept labels without default state but reject new state progress and holding`; `removing a profile preserves historic state progress and holding pins while permitting own clear and delete`.

**Missing-to-freeze scenarios:** `released-profile-journey` with actual bundled choices, historical consumers and two immutable releases.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. The three profile primitive argv above are existing and narrower.

**Coverage gap:** Full profile driver, bundled Book/game/recipe/record producer and historical end-to-end consumer binding are missing. At the integration base, `entries.ts` still validates the fixed five `ENTRY_STATES` through `state()` before the command body, with no profile import or accepted pin. `copies.ts` has fixed statuses and no kind/profile/pin admission; `sessions.ts` calls `parseSessionCreate`/`parseRecord` from `progress.ts` with fixed units. Profile source/compiler/decimal helpers and prospective command tests exist; the missing profile-aware writers are not implemented by those artifacts.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: legacy fixed entry/copy/session commands/HTTP exist; profile helpers/compiler exist, profile-aware writers and released composed journey missing; user-case accepted at revision: unknown; promoted: pending.

## independent-labels

**User job:** Organize an own library with private labels, including a label-only subject, without creating an exclusive state or public classification.

**Source authority:** [Library labels](../library-labels.md); [Dynamic Collections](../dynamic-collections.md).

**Personas:** P; Alice assigns, Bob has an independent `vegetarian` label; anonymous diet discovery never consumes either label.

**Released fixture data:** L, R, Q; labels have native metadata/reservation/lifecycle DAOs, but no complete HTTP driver.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `label-only-library` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `label-only-library` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `label-only-library` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `label-only-library` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `label-only-library` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `label-only-library` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [library-labels outcomes](../../specs/library-labels-outcomes.test.ts): `independent personal labels coexist with exclusive state and disclose nothing without a Collection`; `creating and assigning a label creates no implicit state session holding follow or entitlement`; `state-only and label-only subjects contribute distinct source facts while follows contribute none`; `parent hiding and unchanged-claim undo affect Everything before any cleanup worker`; `retained assignment identity survives reassign reclear and stale purge but ends at whole purge`.

**Missing-to-freeze scenarios:** `label-only-library`, including removal of the last support and public diet isolation.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. `library-labels-driver.ts` requires real native HTTP/Access, not DAO-normalized responses.

**Coverage gap:** Adopted POST :assign/minimal DTO transport, individual lifecycle/pages, command/purge integration and all source consumers still need binding. A label definition alone supports nothing.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: metadata/reservation/lifecycle stores exist; full API composition missing; user-case accepted at revision: unknown; promoted: pending.

## typed-progress-and-continue

**User job:** Record bounded typed progress, correct sparse units, finish/restart sessions, and find Continue items by their pinned active role.

**Source authority:** [Profile consumers](../library-profile-consumers.md); [Library](../library-and-collections.md).

**Personas:** P; Alice owns current and historical sessions, Bob's completed cooking never excludes Alice's recipe.

**Released fixture data:** H, L, R, Q; completed-only history supports Everything independently of state.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `progress-and-continue` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `progress-and-continue` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `progress-and-continue` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `progress-and-continue` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `progress-and-continue` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `progress-and-continue` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [library outcomes](../../specs/library-outcomes.test.ts): `progress creation requires exactly one mode and records must match that mode with one intent`; `completed units preserve the sparse set removals and both exact change intents`; `cursor positions can move backward and session revisions reject stale records and transitions`; `completing then restarting a subject retains the first session completion timestamp`.

**Missing-to-freeze scenarios:** `progress-and-continue`; Continue transport is PENDING, and owner-query absence remains separately pending.

**Native wrapper/driver and acceptance:** Library register above: existing production wrapper/driver and exact Library argv. Complete profiles/Continue composition is NOTREGISTERED; native profile-session primitive argv exists.

**Coverage gap:** Continue still has a literal in_progress consumer. Session creation/recording uses the legacy fixed mode/unit parser, without profile lookup or accepted pin; prospective profile-session tests do not establish admission, Continue or the released recipe absence job. No completion infers state/holding/purchase.

**Stages:** Specification validated red: unknown; native driver registered: Library suite only; implementation exposed: native legacy session modes/history exist; profile-aware admission missing; Continue journey incomplete; user-case accepted at revision: unknown; promoted: pending.

## independent-holdings

**User job:** Keep two physical/digital holdings of one edition with distinct kind/status/history and delete/undo one without inferring acquisition, progress or rights.

**Source authority:** [Profile consumers](../library-profile-consumers.md); [Library](../library-and-collections.md).

**Personas:** M; Alice owns holdings, buyer/refunded buyer remain separate from a holding owner; Bob/anonymous learn no location/note/pin.

**Released fixture data:** H, L, O; no-entry holding-only and two same-edition copies.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `holdings-are-independent` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `holdings-are-independent` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `holdings-are-independent` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `holdings-are-independent` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `holdings-are-independent` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `holdings-are-independent` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [library-profiles outcomes](../../specs/library-profiles-outcomes.test.ts): `two holdings of one book edition keep independent copy IDs and update history`; `exclusive state does not create or couple independent labels sessions holdings or ratings`; `fresh copy creation requires a declared kind and never defaults to legacy-unspecified`.

**Missing-to-freeze scenarios:** `holdings-are-independent`, including typed invalid-pair atomicity and copy ordinary Undo.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Existing Library two-copy scenario and profile-copy native primitive argv remain supporting coverage.

**Coverage gap:** `copies.ts` and the HTTP create DTO accept legacy fixed statuses, without a declared kind, profile lookup or accepted pin. Profile-copy tests are prospective acceptance, not implementation proof. Complete released journey/Undo binding is missing. Copies are neither purchase evidence nor a rights grant.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: legacy fixed-status copy commands/HTTP exist; profile-aware kind/status/pin admission missing; ordinary retained copy/Undo and composed journey incomplete; user-case accepted at revision: unknown; promoted: pending.

## builtin-discovery-and-population

**User job:** Discover stable read-only Everything/state/Liked logical identities and browse supported unique subjects without materializing a header on GET.

**Source authority:** [Dynamic Collections](../dynamic-collections.md); [Library](../library-and-collections.md).

**Personas:** P; Alice read-only credential discovers own logical resources, Bob/anonymous private-ID lookup matches unknown.

**Released fixture data:** L, H, C, Q; all independent supports, no-entry and shell/follow-only controls; current SUBJECT like/love drives Liked independently.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `everything-population` subject detail/public projection excludes private support; composed binding MISSING.                                |
| public curated                 | APPLICABLE: `everything-population` curation occurrences stay separate and cannot become support; composed binding MISSING.                             |
| Everything WITHOUT state       | APPLICABLE: `everything-population` includes live state/label/session/history/holding once; shell/follow-only excluded; dynamic binding MISSING.        |
| own-state Collection/predicate | APPLICABLE: `everything-population` state siblings from live accepted entry/session/copy tuples; labels alone create no state sibling; binding MISSING. |
| mounted Zone                   | APPLICABLE: `collection-actions` consumes eligible published output only; private source/builtin remains concealed; binding MISSING.                    |
| TypeList                       | APPLICABLE: `collection-jobs` unique dynamic DTO consumption without occurrence/count/time fabrication; binding MISSING.                                |

**Frozen scenarios:** [dynamic-collections outcomes](../../specs/dynamic-collections-outcomes.test.ts): `an empty owner has one private Everything identity and no state-set fanout`; `Everything counts live personal facts once and excludes follow-only curated-only and unprofiled state views`; `Collection DTOs discriminate curated metadata and localized dynamic presentation without private keys`; `opaque state lookup uses one native point and terminal deletion defeats delayed repair and follow`.

**Missing-to-freeze scenarios:** `everything-population`, released Liked identity/Content subject-reaction consumer acceptance and support lifetime corrections.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Dynamic/profile/label/source driver contracts participate; deterministic identity/schema tests are not full bindings.

**Coverage gap:** Logical revision 0, first owner-write materialization revision 1, native grants/fact fence and terminal-safe reference repair still need composed runtime. Liked native DTO/identity/source adapter is missing; do not equate it with Everything support.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: identity/reference helpers exist; full discovery/materialization/source and Liked composition missing; user-case accepted at revision: unknown; promoted: pending.

## canonical-own-state-order

**User job:** See one canonical state after alias/merge changes, deterministically select the newest owner write and Undo as a new write while preserving original facts and pins.

**Source authority:** [Library owner-write order](../library-and-collections.md); [Filtered lists](../filtered-lists.md#canonical-identity-and-personal-references).

**Personas:** P; Alice merges/reduces own facts only, Bob's writes never enter Alice's reduction; original and terminal authorization remain current.

**Released fixture data:** L, H, C, Q; disagreeing original states, clear/Undo, duplicate supports, hidden-original/readable-terminal controls.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `collection-jobs` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `collection-jobs` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `collection-jobs` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `collection-jobs` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `collection-jobs` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `collection-jobs` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [collection-source outcomes](../../specs/collection-source-outcomes.test.ts): `stored a to z c z cannot masquerade as covered canonical order and exact stored misses cannot prove canonical absence`; `identity basis merge unmerge and repoint restart valid continuations while unrelated partition writes do not`; `positive alias discovery rechecks current original terminal and Collection authority at final use`.

**Missing-to-freeze scenarios:** Canonical owner-sequence/Undo scenarios within `collection-jobs` and `ordinary-delete-undo` remain MISSING to freeze; no exact frozen sequence scenario was located.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Collection-source/dynamic contracts name real native canonical plans, not an executor reducer substitute.

**Coverage gap:** Per-owner allocator and nullable live/archive sequence columns exist as prerequisites only; native state writer/cutover and reduction integration remain missing. Highest owner_write_seq wins, with fresh Undo sequence and retained source originals; no timestamp/UUID tie-break or private witness cache.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: semantic contracts/helpers present; ordered own-state runtime missing; user-case accepted at revision: unknown; promoted: pending.

## book-word-count-query

**User job:** Find Books strictly over one million genuine words, excluding exact-edge, short, unknown and character/page-only controls.

**Source authority:** [Audit fixture job](../research/api-acceptance-gaps.md#definitions-and-fixtures-the-missing-cases-require); [Filtered lists](../filtered-lists.md).

**Personas:** P; anonymous/Bob see public facts only, Alice additionally intersects her own support/selected state.

**Released fixture data:** B, L, C, Q; expected global eligible set is exactly `{B-long}`, then source/population intersection per cell.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `catalogue-jobs` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `catalogue-jobs` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `catalogue-jobs` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `catalogue-jobs` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `catalogue-jobs` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `catalogue-jobs` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [dynamic-collections outcomes](../../specs/dynamic-collections-outcomes.test.ts): `first and deep native pages stay bounded with sparse catalog filters and hidden candidates at three scales`.

**Missing-to-freeze scenarios:** `catalogue-jobs` and `collection-jobs`: separate word-count exact-set case in every applicable cell, not a generic range placeholder.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Search/Zone/presentation native collaborators must bind the same released predicate.

**Coverage gap:** Released word property/data, common members query admission and complete consumer bindings are missing. Existing generic ranges/scales do not prove this job.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: generic search ranges exist; released word/member composition missing; user-case accepted at revision: unknown; promoted: pending.

## book-form-and-harem-query

**User job:** Find light novels tagged harem using distinct released form and tag facts, with form-only/tag-only false-positive controls.

**Source authority:** [Audit fixture authority](../research/api-acceptance-gaps.md); [Filtered lists](../filtered-lists.md).

**Personas:** P; withheld harem or hidden target must affect positive and negative queries safely without private labels.

**Released fixture data:** B, F, L, C, Q; expected set `{B-long,B-edge,B-characters}` before eligible source/own-population intersection.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `catalogue-jobs` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `catalogue-jobs` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `catalogue-jobs` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `catalogue-jobs` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `catalogue-jobs` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `catalogue-jobs` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [dynamic-collections outcomes](../../specs/dynamic-collections-outcomes.test.ts): `shared cursors bind Collection identity, the effective filter, and the admitted sort`.

**Missing-to-freeze scenarios:** `catalogue-jobs`, `collection-jobs`, `query-privacy`: actual FORM/LN/HAREM IDs and exact sets in each cell.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Generic frozen filter/cursor coverage is not the released form/tag binding.

**Coverage gap:** Actual adopted form property/Concept IDs and shared producer are pending. Do not invent a CURIE or reuse private label text as public tag evidence.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: generic filters exist; released form/tag composition missing; user-case accepted at revision: unknown; promoted: pending.

## combined-book-query

**User job:** Apply word threshold AND light-novel form AND harem tag as one query, preserving source and owner-population intersections.

**Source authority:** [Audit cross-surface matrix](../research/api-acceptance-gaps.md); [Filtered lists](../filtered-lists.md).

**Personas:** P; own supports are viewer-self only; anonymous queries cannot consume Alice's labels/state.

**Released fixture data:** B, F, L, C, Q; exact eligible global result `{B-long}`; B-characters must fail unknown words.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `collection-jobs` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `collection-jobs` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `collection-jobs` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `collection-jobs` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `collection-jobs` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `collection-jobs` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [dynamic-collections outcomes](../../specs/dynamic-collections-outcomes.test.ts): `bounded Collection filters advance opaque prefixes through hidden and filtered candidates without joins`.

**Missing-to-freeze scenarios:** `catalogue-jobs` and `collection-jobs` combined exact-set cases; `bulk-user-population` consumes the same selected job.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Bind current native suite contracts rather than substituting a shelf-only endpoint.

**Coverage gap:** Shared released predicate, member admission and owner-query wire are pending. All three conjuncts must execute; a generic author/type fixture is insufficient.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: members route accepts view/cursor/limit, not the full shared query; user-case accepted at revision: unknown; promoted: pending.

## recipe-diet-and-time-query

**User job:** Find vegetarian recipes with actual cook time at most thirty minutes, retaining inclusive edge and unknown/nonvegetarian exclusion.

**Source authority:** [Audit recipe fixtures](../research/api-acceptance-gaps.md); [Filtered lists](../filtered-lists.md).

**Personas:** P; Bob's private `vegetarian` label cannot affect any public projection or result.

**Released fixture data:** R, L, C, Q; exact eligible global set `{R-quick,R-edge,R-cooked,R-other-cooked}` before intersections.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| catalogue                      | APPLICABLE: `catalogue-jobs` catalogue exact-set case; native composed binding MISSING; Recipe factual detail/instructions and duration projection agree with disclosed facts. |
| public curated                 | APPLICABLE: `catalogue-jobs` intersects C-public eligible canonical members; native composed binding MISSING.                                                                  |
| Everything WITHOUT state       | APPLICABLE: `catalogue-jobs` intersects Alice's live support union including no-entry support; native composed binding MISSING.                                                |
| own-state Collection/predicate | APPLICABLE: `catalogue-jobs` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.                                      |
| mounted Zone                   | APPLICABLE: `catalogue-jobs` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                                                            |
| TypeList                       | APPLICABLE: `catalogue-jobs` in the configured released vertical; presentation collaborator binding MISSING.                                                                   |

**Frozen scenarios:** [dynamic-collections outcomes](../../specs/dynamic-collections-outcomes.test.ts): `game recipe and record profiles share Everything and use scoped profile state identities`.

**Missing-to-freeze scenarios:** `catalogue-jobs`, `collection-jobs`, factual Recipe detail and Web publication collaborator; generic recipe type alone is not this case.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Released diet/time fixtures and each consumer binding remain missing.

**Coverage gap:** Actual released diet representation/mapping and shared fixture delivery are pending; cookTime minutes differ from preparation/rest. Public detail must not substitute a private label.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: Recipe type/cook-time data exists; released dietary consumer journey missing; user-case accepted at revision: unknown; promoted: pending.

## recipe-own-completion-absence

**User job:** Find eligible quick vegetarian recipes not completed by the current owner, including no-entry support, without excluding a recipe completed only by Bob.

**Source authority:** [Profile consumers](../library-profile-consumers.md); [Audit](../research/api-acceptance-gaps.md); [Filtered lists](../filtered-lists.md).

**Personas:** P; only Alice's supported population and live own completed-session absence are relevant; Bob/anonymous never query Alice's private completion.

**Released fixture data:** R, L, H, C, Q; proposed owner set `{R-quick,R-edge,R-other-cooked}` within supported population. NOTstate includes no-entry and is not session absence.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `catalogue-jobs` viewer-self owner-query composition at catalogue boundary; anonymous receives no private predicate/facts; wire PENDING, binding MISSING. |
| public curated                 | APPLICABLE: `collection-jobs` public curated source plus Alice-only predicate; no publicly stored personalization; wire PENDING, binding MISSING.                     |
| Everything WITHOUT state       | APPLICABLE: `collection-jobs` completed-session absence over support union including no-entry; wire PENDING, binding MISSING.                                         |
| own-state Collection/predicate | APPLICABLE: `collection-jobs` own tuple/predicate intersection; NOTstate and session absence tested separately; wire PENDING, binding MISSING.                        |
| mounted Zone                   | APPLICABLE: `collection-jobs` viewer-self predicate over mounted eligible source, never published private facts; wire PENDING, binding MISSING.                       |
| TypeList                       | APPLICABLE: `collection-jobs` viewer-self TypeList predicate with the same semantics; wire PENDING, binding MISSING.                                                  |

**Frozen scenarios:** [library-profiles outcomes](../../specs/library-profiles-outcomes.test.ts): `exclusive state does not create or couple independent labels sessions holdings or ratings`.

**Missing-to-freeze scenarios:** `progress-and-continue`, `collection-jobs`, `query-privacy`: owner absence/no-entry cases MISSING to freeze after owner wire approval.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. No recipe-specific flag or endpoint is selected by this inventory.

**Coverage gap:** Common owner-query wire remains a PENDING owner contract. Do not falsely block known fixture/profile/CRUD contracts on workflow docs, or claim session absence is already frozen by a state inequality.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: independent session facts exist; owner-query contract/composition pending; user-case accepted at revision: unknown; promoted: pending.

## platform-same-statement-query

**User job:** Find releases matching platform/language/date qualifiers on one statement, excluding combinations assembled from different statements.

**Source authority:** [Audit platform qualifiers](../research/api-acceptance-gaps.md); [Filtered lists](../filtered-lists.md).

**Personas:** P; current foreign target/tuple disclosure is checked before positive/negative eligibility or order escapes.

**Released fixture data:** G, L, C, Q; Switch/PC and false Cartesian controls with actual released IDs.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `platform-qualifiers` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `platform-qualifiers` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `platform-qualifiers` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `platform-qualifiers` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `platform-qualifiers` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `platform-qualifiers` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** No exact released `platform-qualifiers` scenario is frozen in the eleven indexed suites; existing generic semantic/search qualifier cases are supporting evidence, not this job.

**Missing-to-freeze scenarios:** `platform-qualifiers` and its `catalogue-jobs`/`collection-jobs` cells, including withheld foreign tuple controls.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Semantic/Search own native tuple/projection collaborators; Commerce owns member-source intersections.

**Coverage gap:** Actual released fixture and composed six-cell binding missing. A holding-derived platform join remains deferred; that does not defer public same-statement qualifiers.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: generic qualifier semantics exist; composed released job missing; user-case accepted at revision: unknown; promoted: pending.

## common-query-text-sort-layout-and-paging

**User job:** Use the same members query with text, sort, layout and stable canonical continuation across sources, including useful deep sparse pages.

**Source authority:** [Filtered lists](../filtered-lists.md); [Collection source](../collection-source.md); [Dynamic Collections](../dynamic-collections.md).

**Personas:** P; continuation binds viewer/request/source/meaning/generation, current revocation defeats an old cursor, no private raw candidates are disclosed.

**Released fixture data:** B, F, R, G, H, L, C, Q; first/deep pages, aliases/duplicate history, no-match/hidden controls and pinned release A after B.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `collection-jobs` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `collection-jobs` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `collection-jobs` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `collection-jobs` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `collection-jobs` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `collection-jobs` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [dynamic-collections outcomes](../../specs/dynamic-collections-outcomes.test.ts): `curated and builtin dynamic Collections share one members page cursor and visibility boundary`; `shared cursors bind Collection identity, the effective filter, and the admitted sort`; `first and deep native pages stay bounded with sparse catalog filters and hidden candidates at three scales`.

**Missing-to-freeze scenarios:** `collection-jobs`, `catalogue-jobs`, `query-privacy`, `freshness-and-recovery`, and native useful-page reconciliation.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. `createCollectionSource` exports an ABI but all methods currently throw dependency_unavailable; source/semantic preparation ports remain incomplete.

**Coverage gap:** Members route does not admit the full common query. Text/order/layout must change only their contracted projection/order, not meaning or authority. No raw-nonmatch cursor/empty-success loop or universal 4P/256 claim closes the job.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: curated paging exists; common filtered source/preparation composition missing; user-case accepted at revision: unknown; promoted: pending.

## bulk-captured-population

**User job:** Apply a bounded bulk action to the captured eligible population with sealed discovery, per-target outcomes, replay, partial failure and cancellation.

**Source authority:** [Library native bulk contract](../../services/kernel/src/library/README.md); [Filtered lists](../filtered-lists.md).

**Personas:** P; Alice initiates, editor needs native target authority too; consent/account/grant revocation stops undispatched effects while reconciling committed evidence.

**Released fixture data:** B, F, L, C, Q, O; combined long-harem-LN query, source high-water, replacement incarnations, in-flight commit and partial denial.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `bulk-user-population` selects eligible catalogue subjects under the approved owner-query contract; composed binding MISSING.             |
| public curated                 | APPLICABLE: `bulk-user-population` curated add/remove captures occurrence identities and preserves preexisting duplicates; bulk driver MISSING.       |
| Everything WITHOUT state       | APPLICABLE: `bulk-user-population` support-union selection including no-entry support, no inferred state; wire/binding MISSING.                       |
| own-state Collection/predicate | APPLICABLE: `bulk-user-population` captured own-state/predicate population, pre-discovery live membership versus post-seal CAS; bulk binding MISSING. |
| mounted Zone                   | APPLICABLE: `bulk-user-population` source population collaborator where query selection uses mounted scope; approved wire/binding MISSING.            |
| TypeList                       | APPLICABLE: `bulk-user-population` configured vertical uses the same admitted selection; approved wire/binding MISSING.                               |

**Frozen scenarios:** [library-bulk outcomes](../../specs/library-bulk-outcomes.test.ts): `query selection exceeds one hundred and seals before status writes shrink its filter`; `state edits before discovery match live predicates while post-seal edits conflict`; `one target denial records partial completion and continues other authorized targets`; `cancellation reconciles an in-flight commit and never compensates over later edits`; `crashes before target commit after commit and before or after acknowledgement never duplicate effects`; `enqueue success never reports mutation success and unavailable receipt evidence remains reconciling`.

**Missing-to-freeze scenarios:** `bulk-user-population` over the shared real released fixture population.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. `library-bulk-driver.ts` requires real default command/work/receipt boundaries; bulk factory/admission/execution remain stubs.

**Coverage gap:** Native target/operation schemas and outcome-page primitives do not implement captured query selection, immutable occurrence transfer, recoverable enqueue or no-effect receipts. No state inference from current rows after loss of receipt evidence.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: bulk contracts/schema helpers exist; full operation runtime missing; user-case accepted at revision: unknown; promoted: pending.

## follow-export-and-mounted-source

**User job:** Follow a readable public/unlisted Collection, export a faithful ItemList and browse its mounted source with current eligibility.

**Source authority:** [Library](../library-and-collections.md); [Collection source](../collection-source.md); [Dynamic Collections](../dynamic-collections.md).

**Personas:** P; Alice/eligible Bob follow known readable unlisted resources; anonymous reads permitted export; other callers cannot discover private source/builtin identities.

**Released fixture data:** C, L, Q; duplicate notes/order and alias, overlapping mounted scope, permitted completed output.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `collection-actions` canonical public target URLs/detail links agree with factual subject eligibility; composed binding MISSING.                     |
| public curated                 | APPLICABLE: `collection-actions` readable-unlisted follow and occurrence-faithful ItemList export; existing native Library follows only partial.                 |
| Everything WITHOUT state       | APPLICABLE: `collection-actions` own identity follow/read and eligible published output; Bob/anonymous cannot infer private predicates; dynamic binding MISSING. |
| own-state Collection/predicate | APPLICABLE: `collection-actions` state-source eligibility and unique dynamic export, no private predicate projection; binding MISSING.                           |
| mounted Zone                   | APPLICABLE: `collection-actions` mounted source canonical uniqueness/current authority; native source factory unimplemented.                                     |
| TypeList                       | APPLICABLE: `collection-actions` configured source consumption agrees with member/export identity; composed binding MISSING.                                     |

**Frozen scenarios:** [library outcomes](../../specs/library-outcomes.test.ts): `explicit follow and unfollow of a public Collection remain private and list only following`.

**Missing-to-freeze scenarios:** [dynamic-collections outcomes](../../specs/dynamic-collections-outcomes.test.ts): `follow mount export and bulk selection use the Collection identity and unique dynamic subjects`. Missing `collection-actions`; export transport remains PENDING owner approval.

**Native wrapper/driver and acceptance:** Library register above: existing production wrapper/driver and exact Library argv. Source/dynamic/export/Zone composition NOTREGISTERED.

**Coverage gap:** Existing public curated follow is not readable-unlisted coverage. ItemList must preserve permitted curated occurrences/notes/order, while dynamic browsing/export uses unique subjects. No proposed export route is silently adopted.

**Stages:** Specification validated red: unknown; native driver registered: Library suite only; implementation exposed: curated explicit follows exist; export and native mounted-source composition missing; user-case accepted at revision: unknown; promoted: pending.

## completed-output-and-listing-freshness

**User job:** Read only complete eligible public output A while B is pending, withdraw unsafe output immediately and preserve correct versioned public listings.

**Source authority:** [Dynamic Collections](../dynamic-collections.md); [Collection source](../collection-source.md); [Library](../../services/kernel/src/library/README.md).

**Personas:** P; Alice edits private source; anonymous/Bob see only completed eligible output and never B/private predicate/owner sequence.

**Released fixture data:** C, Q, O; completed public A/pending private B, source revocation, reverse/duplicate delivery, bigint source positions, rollback.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `published-output-lifecycle` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `published-output-lifecycle` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `published-output-lifecycle` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `published-output-lifecycle` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `published-output-lifecycle` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `published-output-lifecycle` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [library-listing-freshness outcomes](../../specs/library-listing-freshness-outcomes.test.ts): `a paused old positive first application cannot restore a pair after a newer private zero`; `never-public private and unlisted zeros leave no target holder version receipt or outbox`; `real source commands order bigint positions beyond the safe integer boundary`.

**Missing-to-freeze scenarios:** `published-output-lifecycle` (the audit's exact name); listing-freshness composed coverage also remains open.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Bind existing freshness/dynamic/source driver contracts; source-version/observer native tests are primitives, not end-to-end output acceptance.

**Coverage gap:** Same released source RR snapshot/version, first-zero fencing, equal-stamp invariant and target atomicity need full native bind. Never-public private/unlisted changes leave no public trace. Public cursor bases cannot track no-output private edits.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: version/schema helpers exist; source/publication/freshness composition missing; user-case accepted at revision: unknown; promoted: pending.

## ordinary-delete-and-undo

**User job:** Delete an owned fact immediately, Undo only its addressed retained episode before exact 720-hour expiry, reject replacement/stale CAS and purge due data boundedly.

**Source authority:** [Deletion](../deletion.md); [Library lifecycle](../../services/kernel/src/library/README.md); [Labels](../library-labels.md).

**Personas:** P; Alice owns private fact, authorized editor handles curated record; Bob/anonymous see only permitted tombstone identity, platform authority is not private Undo authority.

**Released fixture data:** O, H, L, C, Q; entry/copy/member/Collection/label/assignment/log, original deadline, replacement/name/ordinal/capacity conflicts, parked repeated-episode purge.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `ordinary-delete-undo` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `ordinary-delete-undo` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `ordinary-delete-undo` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `ordinary-delete-undo` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `ordinary-delete-undo` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `ordinary-delete-undo` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [library-deletion outcomes](../../specs/library-deletion-outcomes.test.ts): `exact kernel day-thirty rejects undo while real purge is parked after durable capture for every kind`; `replacement ordinal name and capacity collisions and stale CAS never overwrite newer facts or allocate another identity`; `entry undo contracts adopt independent deletion addresses replacement-safe incarnation CAS and unchanged authorized replay`; `an exact parked D1 purge cannot consume D3 after restoring and clearing the same incarnation again`.

**Missing-to-freeze scenarios:** `ordinary-delete-undo` (audit name); Library Undo composed coverage remains open.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Retain library-deletion driver contracts, prospective retained-entry native tests and existing Collection/label lifecycle primitives; no completed entry-retention DAO is exported.

**Coverage gap:** Required entry deletion has independent deletionId/deletionRevision and incarnation, per-subject restore; Undo must preserve originals/pins/dates and allocate a fresh state sequence. At the integration base, `entries.deleteEntry` calls physical `store.deleteEntry` and returns the old entry; HTTP returns empty `204` without deletion descriptor headers and has no restore route. Archive/incarnation schema columns and prospective native tests exist, but no `entry-retention-store.ts` export, retained command outcome or completed DAO does. The required archive preserves all 18 pre-delete snapshot fields listed by the [entry deletion contract](../../services/kernel/src/library/README.md#entry-deletion-identity-and-restoration), plus original `owner_write_seq`; exact 720-hour expiry, deletion/incarnation CAS, empty-slot/no-overwrite restore and native binding remain obligations. The snapshot fields are `route`, `account_id`, `subject_id`, `requested_subject_id`, `state`, `revision`, `created_at`, `updated_at`, `transaction_id`, `activity_at`, `finished_at`, `type_id`, `type_source_id`, `type_source_partition`, `type_source_epoch`, `type_source_position`, `incarnation_id` and `library_profile_pin`. All owned kinds need actual HTTP/default purge binding. Follow unfollow is a transition; session/history has no independent delete/Undo API. Archive rows never support current Everything/state. No account restore or hold/custody engine.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: archive/incarnation schema and Collection/label lifecycle primitives exist; entry command still physically deletes, retained-entry DAO/outcome/restore runtime missing; complete route/lifecycle/purge graph missing; user-case accepted at revision: unknown; promoted: pending.

## terminal-library-and-financial-closure

**User job:** At terminal account T conceal the whole private graph and shared payloads, then finish bounded erasure without losing permitted de-identified public A or restricted financial integrity.

**Source authority:** [Deletion](../deletion.md); [Library graph](../../services/kernel/src/library/README.md); [Commerce participation](../../services/kernel/src/commerce/README.md).

**Personas:** M; deleted Alice/old credentials cannot act or Undo; Bob/anonymous retain only eligible public contributions/output; creator/buyer privacy stays fenced.

**Released fixture data:** O, C, L, H, Q; completed public A and pending B, private/unlisted/deleted output, logs, source/derived preparations, retained payloads and financial participant.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `terminal-erasure-graph` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `terminal-erasure-graph` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `terminal-erasure-graph` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `terminal-erasure-graph` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `terminal-erasure-graph` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `terminal-erasure-graph` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [library-deletion outcomes](../../specs/library-deletion-outcomes.test.ts): `account retention freezes completed public A discards pending B and erases unlisted private deleted and log payload`; `child before parent pages recover rollback and commit before enqueue without duplicate effects or broad scans`.

**Missing-to-freeze scenarios:** [dynamic-collections outcomes](../../specs/dynamic-collections-outcomes.test.ts): `terminal durable handoff retains completed public A through pending private B and stale delivery only`; `terminal deletion preserves completed A and purges private payload through bounded work with no consumer wait`. Missing `terminal-erasure-graph` and native financial participant completion.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Existing account-fact-purge primitive is not the full Accounts participant workflow or shared payload closure.

**Coverage gap:** Cover entries/deletion episodes, copies, every follow state, labels/assignments/reservations, sessions/units/history/heads/logs, builtins/canonical/source/candidates, all shelf/type/preparation generations, listings/history, bulk manifests/outcomes, receipts/outbox/write bases/work payloads via exact owner locators. Child-before-parent checkpoints/fences must defeat late replay. Commerce needs terminal account share barrier, exact financial participant/locators/minimization and approved external retention schedule; none is supplied by immutable financial rows. Only eligible completed PUBLIC A freezes; unlisted adoption assertion is superseded, B never publishes.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: point purge/graph contracts exist; full graph/shared payload/financial participation missing; user-case accepted at revision: unknown; promoted: pending.

## private-follows-and-owner-counts

**User job:** Control own outgoing follows and read incoming counts only with current target-management authority, without public follower identities/counters or inferred acquisition.

**Source authority:** [Private follow counts](../private-follow-counts.md); Accounts native Access contract.

**Personas:** P; Alice follows, target manager/editor/self may count; Bob/anonymous/unscoped/revoked cannot learn another outgoing graph or private incoming count.

**Released fixture data:** L, C, Q, O; explicit follow/unfollow beats implied follow, delayed first positive after negative, suspended/reactivated/terminal account.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `follow-owner-counts` subject/agent targets; ordinary unowned subjects have no incoming-count owner; native count binding MISSING.                |
| public curated                 | APPLICABLE: `follow-owner-counts` Collection update authority including delegated management; curated native follows partial, count driver MISSING.           |
| Everything WITHOUT state       | APPLICABLE: `follow-owner-counts` own logical source follows stay private, no public support/count projection; dynamic/count binding MISSING.                 |
| own-state Collection/predicate | APPLICABLE: `follow-owner-counts` same logical state-resource authority, no inference from state; binding MISSING.                                            |
| mounted Zone                   | APPLICABLE: `follow-owner-counts` eligible Space management uses native space:manage; mount does not create follow edges or count authority; binding MISSING. |
| TypeList                       | APPLICABLE: `follow-owner-counts` configured public projections omit all private counts; composed binding MISSING.                                            |

**Frozen scenarios:** [follow-counts outcomes](../../specs/follow-counts-outcomes.test.ts): `follower counts are visible only through existing target management authority and outgoing follows only to their follower`; `person agent self automated operator and organization owner resolve the actual account before management`; `a delayed reverse positive cannot beat a newer negative even on its first target application`; `private follow data never enters public responses FTS public counts sitemaps or notifications`.

**Missing-to-freeze scenarios:** `follow-owner-counts`; bind the frozen suspended-token fixture to the native pre-suspension credential barrier before native binding.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Native Library outgoing follows are existing; complete count projection/source protocol and HTTP binding are missing.

**Coverage gap:** Collection uses collection:update; Space space:manage; agent resolves actual active reciprocal account then self/account:manage, no guessed ID/operator authority. No follower list or public count. Source observations/apply ordering, source-account coverage and erasure are missing, not satisfied by stamps.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: private outgoing edges/pages exist; owner-count runtime missing; user-case accepted at revision: unknown; promoted: pending.

## current-viewer-actions-and-delegation

**User job:** Discover operations actually allowed now and execute them under current actor AND principal grants, consent and containing authority.

**Source authority:** [Commerce Goal](commerce.md); [Private follow counts](../private-follow-counts.md); Accounts viewer-action contract.

**Personas:** P; curator and noncurator delegated editor have equivalent allowed operations; principal/actor/assignment/consent revocation and protected ban independently deny.

**Released fixture data:** Q, C, O; distinct identity partitions, discovered-positive then revoked execution; genuine pre-suspension bearer revoked by the native authentication floor (`401 invalid_credentials`, `invalid_token` challenge).

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `advertised-actions` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `advertised-actions` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `advertised-actions` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `advertised-actions` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `advertised-actions` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `advertised-actions` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [viewer-actions outcomes](../../specs/viewer-actions-outcomes.test.ts): `a delegated editor who is not the curator is offered the same operations`; `the same editor after the grant is revoked is offered nothing on the next read with the same bearer and the edit is refused`; `an assigned actor whose principal lacks the action or is suspended or whose assignment was revoked is offered nothing for it`; `a banned Realm member loses join and participate while unrelated reads keep their own answers`.

**Missing-to-freeze scenarios:** `advertised-actions` and `protected-ban-barrier` protected-context/independent-grant variant; old public-Realm case is not that proof.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Complete viewer-actions native driver remains missing, even though underlying permission suites exist.

**Coverage gap:** Discovery is private/no-store and is not authorization. Native execution must not replace Access with curator equality. Suspension uses the native pre-suspension credential barrier above; ban beats independent grant in protected contexts, public unrelated reads keep their own scope.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: native permission foundations exist; composed action metadata binding missing; user-case accepted at revision: unknown; promoted: pending.

## offer-to-usable-benefit

**User job:** Discover an offer from a readable subject, understand target/price/benefit, check out, and identify usable owned access while retaining refund privacy.

**Source authority:** [Commerce native boundary](../../services/kernel/src/commerce/README.md); [Commerce Goal](commerce.md).

**Personas:** M; anonymous discovers eligible public offer, buyer uses benefit, other/refunded buyer have distinct owned access, seller/creator do not read buyer-private history.

**Released fixture data:** O, Q, L; controlled checkout/provider state and owned entitlements independent of all Library support.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | NOTAPPLICABLE to catalogue list execution: `offer-to-benefit` is a resource workflow, not a predicate/list operation. Any subject-detail or benefit disclosure is a separate participating resource boundary, stated in the coverage gap. |
| public curated                 | NOTAPPLICABLE: curated member enumeration does not execute `offer-to-benefit`; target links do not confer purchase authority.                                                                                                             |
| Everything WITHOUT state       | NOTAPPLICABLE: a private support union does not execute `offer-to-benefit` or imply ownership.                                                                                                                                            |
| own-state Collection/predicate | NOTAPPLICABLE: state/predicates do not execute `offer-to-benefit` or imply an entitlement.                                                                                                                                                |
| mounted Zone                   | NOTAPPLICABLE: a Zone mounts eligible subject sources, not `offer-to-benefit` transaction execution.                                                                                                                                      |
| TypeList                       | NOTAPPLICABLE: TypeList enumerates subjects, not `offer-to-benefit` transaction execution.                                                                                                                                                |

**Frozen scenarios:** [commerce outcomes](../../specs/commerce-outcomes.test.ts): `anonymous reads an offer but cannot create orders list entitlements or discover private IDs`; `buyer checkout snapshots the offer at T in the buyer partition and sends inline Stripe prices`; `signed paid completion grants once and other sees only the same 404 as an unknown ID`; `refunded buyer keeps a listed inactive entitlement after a full Stripe-originated refund`.

**Missing-to-freeze scenarios:** `offer-to-benefit`: subject detail offer-discovery link and actual usable-benefit journey, owner-approved transport MISSING.

**Native wrapper/driver and acceptance:** Commerce register above: existing production wrapper/driver and exact Commerce argv. Primitive offer/order/entitlement APIs are bound; complete discovery/usable-access journey NOTREGISTERED.

**Coverage gap:** Subject detail is APPLICABLE to discovery/factual projection and final benefit resource is APPLICABLE to access. Offer-by-known-ID and listed entitlement do not show discovery or usable access; no subject-to-offer discovery/history boundary is approved here. Purchase creates no Library state/session/copy.

**Stages:** Specification validated red: unknown; native driver registered: Commerce suite only; implementation exposed: known-ID offer/checkout/entitlement APIs exist; discovery and usable-benefit composition missing; user-case accepted at revision: unknown; promoted: pending.

## offer-lifecycle-and-target-receipts

**User job:** Hide a delisted offer publicly, reject new purchase with 409, preserve captured existing order/benefit history and bind exact authorized revise target in receipt intent.

**Source authority:** [Commerce](../../services/kernel/src/commerce/README.md); [Audit](../research/api-acceptance-gaps.md).

**Personas:** M; seller can manage exact authorized offer, other seller cannot replay a receipt; existing buyer keeps captured snapshot/benefit.

**Released fixture data:** O, Q; SAME-partition distinct authorized offer targets at equal revised price; replay original versus conflicting target/body.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | NOTAPPLICABLE to catalogue list execution: `offer-lifecycle-receipts` is a resource workflow, not a predicate/list operation. Any subject-detail or benefit disclosure is a separate participating resource boundary, stated in the coverage gap. |
| public curated                 | NOTAPPLICABLE: curated member enumeration does not execute `offer-lifecycle-receipts`; target links do not confer purchase authority.                                                                                                             |
| Everything WITHOUT state       | NOTAPPLICABLE: a private support union does not execute `offer-lifecycle-receipts` or imply ownership.                                                                                                                                            |
| own-state Collection/predicate | NOTAPPLICABLE: state/predicates do not execute `offer-lifecycle-receipts` or imply an entitlement.                                                                                                                                                |
| mounted Zone                   | NOTAPPLICABLE: a Zone mounts eligible subject sources, not `offer-lifecycle-receipts` transaction execution.                                                                                                                                      |
| TypeList                       | NOTAPPLICABLE: TypeList enumerates subjects, not `offer-lifecycle-receipts` transaction execution.                                                                                                                                                |

**Frozen scenarios:** [commerce outcomes](../../specs/commerce-outcomes.test.ts): `delisting prevents new checkout but preserves an existing entitlement`.

**Missing-to-freeze scenarios:** `offer-lifecycle-receipts`: public GET delisted 404/new purchase409/captured history and owner-approved revision HTTP exposure.

**Native wrapper/driver and acceptance:** Commerce register above: existing production wrapper/driver and exact Commerce argv. Also existing revise-offer-target-replay primitive argv above: `offer revise canonical intent binds the exact authorized target so a same-partition different offer cannot replay another offers receipt`.

**Coverage gap:** Current revise command already canonicalizes `{offerId,unitAmountMinor}` and reauthorizes before receipt; the inspected regression uses distinct offer IDs with the same benefit subject (the shared fixture still needs distinct benefit targets); do not claim its old digest defect persists. Public GET still tests existence rather than active state; revision HTTP route is absent/PENDING. Subject detail discovery must omit delisted offers.

**Stages:** Specification validated red: unknown; native driver registered: Commerce suite only; implementation exposed: target-bound revise command exists; public delist disclosure and revision/discovery transport incomplete; user-case accepted at revision: unknown; promoted: pending.

## receipt-aware-native-provider-refresh

**User job:** Keep older/abandoned observations from revoking or restoring newer admitted truth, including a newer business no-op and retry of already completed work.

**Source authority:** [Native refresh protocol](../../services/kernel/src/commerce/README.md); audit O3 outcome with time-watermark mechanism superseded.

**Personas:** M; buyer/refunded buyer see current order/benefit, old/deleted accounts cannot be resurrected by workers; provider is controlled truth, not webhook payload.

**Released fixture data:** O, Q; completed A retry while B admitted, out-of-order physical reads, cached/abandoned live DBOS bodies, newer no-op, late-paid known order.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | NOTAPPLICABLE to catalogue list execution: `checkout-observation-order` is a resource workflow, not a predicate/list operation. Any subject-detail or benefit disclosure is a separate participating resource boundary, stated in the coverage gap. |
| public curated                 | NOTAPPLICABLE: curated member enumeration does not execute `checkout-observation-order`; target links do not confer purchase authority.                                                                                                             |
| Everything WITHOUT state       | NOTAPPLICABLE: a private support union does not execute `checkout-observation-order` or imply ownership.                                                                                                                                            |
| own-state Collection/predicate | NOTAPPLICABLE: state/predicates do not execute `checkout-observation-order` or imply an entitlement.                                                                                                                                                |
| mounted Zone                   | NOTAPPLICABLE: a Zone mounts eligible subject sources, not `checkout-observation-order` transaction execution.                                                                                                                                      |
| TypeList                       | NOTAPPLICABLE: TypeList enumerates subjects, not `checkout-observation-order` transaction execution.                                                                                                                                                |

**Frozen scenarios:** [commerce outcomes](../../specs/commerce-outcomes.test.ts): `dispute needs_response revokes and won restores the same entitlement`; `lost dispute stays revoked and does not emit a restoration`; `lost Stripe create records unknown then same-key retry recovers the single session`.

**Missing-to-freeze scenarios:** `checkout-observation-order`: all claim/read/apply/no-op/replay/recovery races remain MISSING to freeze and bind natively.

**Native wrapper/driver and acceptance:** Commerce register above: existing production wrapper/driver and exact Commerce argv. Existing snapshot/work tests are supporting only; approved combined native protocol/helper/default serial queue producers are NOTPRESENT.

**Coverage gap:** Under SAME order lock check metadata-only stable apply completion BEFORE claiming, so completed A retry cannot suppress B; a matching completion exits without a claim or provider read. Uncompleted physical attempt claims native revision via real UPDATE+event/receipt, commits/releases then freshly reads full provider truth. Apply under same order lock validates captured revision/session and stable wf:{id}:apply intent; superseded attempt has no apply receipt. Never recapture during SQL retry. No-op admission persists. One provider-account/mode/session serial queue, distinct triggers, independent sessions concurrent; compatible cached-history drain/fork/rewind, no SDK patch. Known late-paid repair must work after expiry/reconcile stop. Provider send/byte/deadline/retry bounds include abandoned work; times are metadata only. Shared hasOwnCommandCompletion helper/claim implementation remains missing.

**Stages:** Specification validated red: unknown; native driver registered: Commerce suite only; implementation exposed: current split durable clock/read/apply exists; approved receipt-aware revision protocol missing; user-case accepted at revision: unknown; promoted: pending.

## signed-webhook-replay-and-provider-truth

**User job:** Accept authentic retried provider events once, reject forged/stale/tampered bytes and derive settlement from current provider truth rather than claimed payload state.

**Source authority:** [Commerce](../../services/kernel/src/commerce/README.md).

**Personas:** M; anonymous HTTP webhook sender has no buyer authority, invalid signature grants nothing; buyer/other/refunded buyer observe isolated outcomes.

**Released fixture data:** O, Q; signed duplicate bytes before/after processing, wrong secret, missing header, stale timestamp, validly signed paid claim over unpaid actual session.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | NOTAPPLICABLE to catalogue list execution: `signed provider event` is a resource workflow, not a predicate/list operation. Any subject-detail or benefit disclosure is a separate participating resource boundary, stated in the coverage gap. |
| public curated                 | NOTAPPLICABLE: curated member enumeration does not execute `signed provider event`; target links do not confer purchase authority.                                                                                                             |
| Everything WITHOUT state       | NOTAPPLICABLE: a private support union does not execute `signed provider event` or imply ownership.                                                                                                                                            |
| own-state Collection/predicate | NOTAPPLICABLE: state/predicates do not execute `signed provider event` or imply an entitlement.                                                                                                                                                |
| mounted Zone                   | NOTAPPLICABLE: a Zone mounts eligible subject sources, not `signed provider event` transaction execution.                                                                                                                                      |
| TypeList                       | NOTAPPLICABLE: TypeList enumerates subjects, not `signed provider event` transaction execution.                                                                                                                                                |

**Frozen scenarios:** [commerce outcomes](../../specs/commerce-outcomes.test.ts): `identical signed bytes replay before and after processing with one event workflow and grant`; `wrong secret tampered bytes missing header and stale timestamp reject without durable changes`; `forged completed for an unpaid session grants nothing while a real paid completion grants`; `validly signed payload claiming paid cannot override an unpaid current Stripe session`.

**Missing-to-freeze scenarios:** No replacement signature suite; compose existing scenarios with `checkout-observation-order` and terminal financial fence.

**Native wrapper/driver and acceptance:** Commerce register above: existing production wrapper/driver and exact Commerce argv. Uses official adapter/local HTTP provider and production webhook/workflow composition.

**Coverage gap:** Existing native signature/provider-truth scenarios are registered, with no run evidence here. They do not prove newer-admission safety, full queue recovery or terminal no-resurrection. Subject benefit read participates after settlement, not six duplicate checkouts.

**Stages:** Specification validated red: unknown; native driver registered: Commerce suite only; implementation exposed: signed webhook/current provider reads exist; new protocol/terminal composition missing; user-case accepted at revision: unknown; promoted: pending.

## incremental-creator-statements

**User job:** Read incremental creator statements and lines with exact currency/rounding and record an authorized actual external payment reference without a Stripe payout engine.

**Source authority:** [Commerce payouts](../../services/kernel/src/commerce/README.md).

**Personas:** M; creator reads own statements, payout operator marks paid, buyer/other creator/anonymous cannot read private financial history; revoked retries deny.

**Released fixture data:** O; sales/refunds/disputes, late adjustments into current UTC month, currency separation, repeated paid reference and terminal creator.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| catalogue                      | NOTAPPLICABLE to catalogue list execution: `creator statement` is a resource workflow, not a predicate/list operation. Any subject-detail or benefit disclosure is a separate participating resource boundary, stated in the coverage gap. |
| public curated                 | NOTAPPLICABLE: curated member enumeration does not execute `creator statement`; target links do not confer purchase authority.                                                                                                             |
| Everything WITHOUT state       | NOTAPPLICABLE: a private support union does not execute `creator statement` or imply ownership.                                                                                                                                            |
| own-state Collection/predicate | NOTAPPLICABLE: state/predicates do not execute `creator statement` or imply an entitlement.                                                                                                                                                |
| mounted Zone                   | NOTAPPLICABLE: a Zone mounts eligible subject sources, not `creator statement` transaction execution.                                                                                                                                      |
| TypeList                       | NOTAPPLICABLE: TypeList enumerates subjects, not `creator statement` transaction execution.                                                                                                                                                |

**Frozen scenarios:** No creator-statement scenario is present in the 23 frozen Commerce outcomes; reuse the existing native suites rather than adding equivalent tests. In [services/kernel/test/commerce/payouts.test.ts](../../services/kernel/test/commerce/payouts.test.ts): `legacy worked example runs through fulfilment, real royalty worker, exact creator statement and closed events`; `a later refund goes to its recording UTC month even when the original statement is paid`; `dispute fees are shown without deduction; mixed rates round once across the statement and currencies stay separate`; `creator disclosure uses identical 404s; operator root grant, final month, once-only payment and receipt authorization`. In [services/kernel/test/commerce/payout-mark-paid.test.ts](../../services/kernel/test/commerce/payout-mark-paid.test.ts): `the platform operator pays once; replay needs current authority before reading its receipt`.

**Missing-to-freeze scenarios:** Terminal financial privacy/retained-field completion and its participant workflow remain MISSING to freeze/bind; do not duplicate the existing fulfilment-to-statement and mark-paid journeys.

**Native wrapper/driver and acceptance:** Existing direct native payout/mark-paid suites and exact argv above are registered for their named journeys. They use native settlement/royalty work, creator HTTP reads and operator authorization; terminal financial participant/closure binding is NOTREGISTERED.

**Coverage gap:** Incremental lines and creator account owner grant exist; refunds/disputes adjust new period rather than rewrite a paid statement. Statements are outside Stripe transfers. Exact financial participant/read barrier/shared payload minimization/retention schedule remain missing; no invented financial duration.

**Stages:** Specification validated red: unknown; native driver registered: direct native payout/mark-paid suites exist; terminal financial closure NOTREGISTERED; implementation exposed: native incremental payout primitives exist; terminal financial completion missing; user-case accepted at revision: unknown; promoted: pending.

## composed-native-cost-progress-and-privacy

**User job:** Obtain useful current full/deep pages and bulk results within each adopted plan budget, including all native work, retained preparation and privacy-reduction repair.

**Source authority:** [Filtered lists](../filtered-lists.md); [Library cost obligations](../../services/kernel/src/library/README.md); [Commerce cost obligations](../../services/kernel/src/commerce/README.md).

**Personas:** M; anonymous/Alice/Bob plus denied/unscoped/revoked/suspended/delegated cases measured, not excluded as cheap failures.

**Released fixture data:** B, F, R, G, H, L, C, Q, O; shared three-scale population, sparse no-match/aliases/duplicates/unrelated history, provider/DBOS backlog, restart/revocation.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `composed-cost-and-progress` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `composed-cost-and-progress` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `composed-cost-and-progress` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `composed-cost-and-progress` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `composed-cost-and-progress` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `composed-cost-and-progress` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** [collection-source outcomes](../../specs/collection-source-outcomes.test.ts): `native first and deep plans at three legal geometric scales bound actual rows buffers statements bytes aliases and duplicate history`; `native resumable alias first and deep windows at 64 512 4096 measure fixed quota and actual last-alias success`.

**Missing-to-freeze scenarios:** `composed-cost-and-progress`, `query-privacy`, `freshness-and-recovery`: native full-plan/default-worker/engine/foreign-ack cases MISSING to freeze/bind.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Module growth tests remain required, but no primitive count/SQL assertion or known-order read stands in for a composed feed/provider/queue run.

**Coverage gap:** Charge examined/removed rows, buffers, all pool statements/holds, bytes, Access/dependency points, aliases/lookahead and actual engine work; preserve 16 reads/128 output slots and operation-specific bounds. Fixed finite input must converge by bounded durable progress, not perpetual preparation. Local reduction and foreign fence/target/consent/Collection reduction ACK must cover actual refresh-visible repair before safe negative/order/results. Runtime projection/reduction-log/epoch ports and numeric plan admission are incomplete.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: module instrumentation/primitive budgets exist; full native plan/privacy/progress proof missing; user-case accepted at revision: unknown; promoted: pending.

## public-discoverability-and-cache-isolation

**User job:** Discover every eligible public Collection URL through native feeds and served Web XML/cache while excluding private/unlisted/taken-down output and viewer personalization.

**Source authority:** [Commerce Goal](commerce.md); [Public scope](../scope.md); [Audit Web publication](../research/api-acceptance-gaps.md).

**Personas:** P; Alice warms public cache, anonymous/Bob read it, current private hydration reauthorizes; terminal curator retains only eligible de-identified output.

**Released fixture data:** C, Q, L, O; public/unlisted/private curated and completed dynamic A/pending B, hidden original/target, all private state/label/history/holding/vote markers.

**Surface cells:**

| Cell                           | Applicability and scenario/binding                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                      | APPLICABLE: `public-discovery-and-cache` catalogue exact-set case; native composed binding MISSING; factual subject detail, with no private support/pins. |
| public curated                 | APPLICABLE: `public-discovery-and-cache` intersects C-public eligible canonical members; native composed binding MISSING.                                 |
| Everything WITHOUT state       | APPLICABLE: `public-discovery-and-cache` intersects Alice's live support union including no-entry support; native composed binding MISSING.               |
| own-state Collection/predicate | APPLICABLE: `public-discovery-and-cache` intersects the selected own tuple/predicate with its full owner population; native composed binding MISSING.     |
| mounted Zone                   | APPLICABLE: `public-discovery-and-cache` over eligible mounted Collection/saved-scope union; Zone collaborator binding MISSING.                           |
| TypeList                       | APPLICABLE: `public-discovery-and-cache` in the configured released vertical; presentation collaborator binding MISSING.                                  |

**Frozen scenarios:** In [services/kernel/test/library/sitemap-http.test.ts](../../services/kernel/test/library/sitemap-http.test.ts), `the Collection sitemap lists only indexable public Collections and advances after filtered candidates` and `immutable checkpoints survive edits and profile Collections visibility does not hide public pages` exercise native HTTP feeds with seeded rows; `test/library/sitemap-discovery.test.ts` separately contains `private, unlisted and deleted Collections are never candidates`. Sibling semantic/community/content feeds remain collaborators. No served XML/cache composed scenario is in the eleven indexed suites.

**Missing-to-freeze scenarios:** `public-discovery-and-cache`, linked with `published-output-lifecycle` and `query-privacy`; Web served XML/cache native-product collaborator binding MISSING.

**Native wrapper/driver and acceptance:** NOTREGISTERED: complete native wrapper/driver and acceptance argv are missing; retain the named existing suite/driver contracts. Existing discovery SQL argv above is supporting coverage; native HTTP feed argv is `["bun", "run", "--cwd", "services/kernel", "check", "test/library/sitemap-http.test.ts"]`. Neither is served Web XML/cache acceptance.

**Coverage gap:** Follow every eligible feed/XML continuation with correct lastmod/public URL. No private builtin/source identity, predicate, labels/state/progress/copies/own vote in public HTML/structured data/cache; unlisted read eligibility is not sitemap eligibility. Existing feeds must be reused rather than duplicated; fake-client serializer tests do not prove served HTTP behavior.

**Stages:** Specification validated red: unknown; native driver registered: NOTREGISTERED for the composed job; implementation exposed: native discovery and HTTP feed tests exist; served Web publication/cache composition missing; user-case accepted at revision: unknown; promoted: pending.

## Adoption limits and inventory use

Read-only reference source inspection for this inventory covered BookWyrm
`.reference/shelves/bookwyrm/bookwyrm/models/shelf.py` (shelf identity/uniqueness), Bangumi
`.reference/shelves/bangumi-server/openapi/components/user_subject_collection.yaml` and
`user_subject_collection_modify_payload.yaml` (independent collection fields), Mealie's public cookbook recipe
selection and cross-household update tests in `.reference/shelves/mealie/tests/integration_tests/`, OpenFGA
`TestListObjectsUnevaluableExclusion` in `.reference/search-visibility-witnesses/openfga/pkg/server/list_objects_test.go`,
and Stripe's inline `PriceData` declaration in
`.reference/commerce-integrated-done/stripe-node/src/resources/Checkout/Sessions.ts`. These were read under the main
checkout's reference index; no reference code was ported and no reference was built or executed.

This inventory names 28 semantic capabilities. The six explicit cells in every record are required coverage decisions,
not a count of implemented surfaces. Subject-detail and financial resource boundaries supplement those cells where
lists are not the abstraction. Shared Search, Semantic, Definitions, Accounts, Content, Zones, Performance and Web
participants remain visible obligations; absent composition is never permanent unsupported scope.

Known contracts can proceed acceptance-first without waiting for a workflow-document dependency. Remaining released fixture
producer gaps, pending owner-query and Continue/export/offer transports, missing native driver registration,
owner-sequence runtime, source/preparation/query-safety producers, native provider protocol and financial closure are
separate exact gaps. Do not invent a producer signature or route to turn a gap into apparent completion.

This reconciliation advances inventory accuracy only; fixture/test-source delivery does not advance product acceptance. Specification red execution remains
unknown, native acceptance requires zero skips/todos and the named real bindings at a named revision, and promotion/
main/root proof remains pending. No acceptance command listed here has been run as part of this inventory.

## Exact frozen scenario index

Names below are literal `test` registrations read from the existing suites, including assertions requiring owner
reconciliation. Counts are inventory counts, not passes or approved proof. Every linked driver contract was inspected;
the binding register above distinguishes actual native wrappers from unbound declarations.

### library: 24 scenarios

Source: [specs/library-outcomes.test.ts](../../specs/library-outcomes.test.ts).
Driver contract: [specs/library-driver.ts](../../specs/library-driver.ts).

- `public private and unlisted Collections enforce owner other and anonymous visibility`
- `Collection revision guards update and deletion without changing stale snapshots`
- `members preserve first after last moves notes deletes and duplicate subjects across pages`
- `two hundred inserts after one member respace bounded keys and reject the pre-respacing cursor`
- `five thousand members succeed and the next member fails collection_full without any change`
- `another account cannot mutate private or public Collections or their members`
- `deleted Collection becomes unknown and leaves public subject and curator listings after settle`
- `library entry states are exclusive and missing stale or unknown revisions change nothing`
- `entries list newest updates first once each through cursor pages`
- `in_progress follows by library and explicit unfollow survives later entry transitions`
- `progress creation requires exactly one mode and records must match that mode with one intent`
- `completed units preserve the sparse set removals and both exact change intents`
- `completed unit requests accept one hundred opaque ids but reject larger batches without changes`
- `percent is bounded while elapsed minutes never implicitly complete a session`
- `cursor positions can move backward and session revisions reject stale records and transitions`
- `completing then restarting a subject retains the first session completion timestamp`
- `two copies of one edition remain independent through revision updates and deletion`
- `explicit follow and unfollow of a public Collection remain private and list only following`
- `entries sessions completed units changes copies and follows conceal all owner data from other and anonymous`
- `public subject listings count each public Collection once with multiplicity and exclude private derived rows`
- `published logs are anonymous immutable snapshots and only their owner can publish or delete them`
- `suspended credentials refuse every library write and private read without changing authoritative state`
- `list limits are one through one hundred with a default twenty and stable cursor traversal`
- `member insert members page entry write entries page and unit record use equal statements at three seeded scales`

### library-profiles: 37 scenarios

Source: [specs/library-profiles-outcomes.test.ts](../../specs/library-profiles-outcomes.test.ts).
Driver contract: [specs/library-profiles-driver.ts](../../specs/library-profiles-driver.ts).

- `profiled personal facts preserve release pins and legacy values through migration and replay`
- `definition publication is immutable and profile activation or rollback never changes fact pins`
- `game recipe and record profiles are data-only and bundled book and anime profiles stay valid`
- `nearest complete inherited profile wins while incompatible repeated profile IDs fail compilation`
- `profile absence does not grant People or Concepts new profiled state values`
- `changed and removed IDs remain readable from their stored release and fail for fresh writes`
- `callers cannot submit a legacy pin or an old release pin as new fact metadata`
- `fresh copy creation requires a declared kind and never defaults to legacy-unspecified`
- `fresh state unit kind and status IDs are checked as profile data`
- `owner other anonymous and suspended personas use real authorization for private library facts`
- `authorized exact receipts replay before current subject membership validation and changed bodies conflict`
- `release change preserves an authorized exact replay but current authorization revocation denies it`
- `all 18 legacy progress mode and unit pairs survive migration unchanged`
- `legacy decimal parsing keeps twelve integer and six fraction digits when precision is absent`
- `numeric profile bounds compare decimal strings exactly and scalar percent alone caps at one hundred`
- `sparse completed-unit identity preserves exact opaque keys and never fills ordinal ranges`
- `copy migration preserves four statuses and marks kind legacy-unspecified without inferring rights`
- `two holdings of one book edition keep independent copy IDs and update history`
- `exclusive state does not create or couple independent labels sessions holdings or ratings`
- `import source declarations remain inert and create no provider adapter or import run`
- `historic reads use their pinned release after head change and rollback`
- `profile pins and hidden accepting types are absent from fact responses public collections and published logs`
- `legacy unknown values and null accepting type remain readable without consulting the current type`
- `profile writes perform one bounded lookup across three unrelated fact scales`
- `ten and one hundred profile manifests stay inside canonical release caps without owner catalogue copies`
- `migration reads and changes no more than one hundred indexed owner rows per checkpoint`
- `migration crash before page commit leaves no partial pins and restarts from the last committed key`
- `migration crash after page commit replays the same page without duplicate pins or skipped rows`
- `migration CAS preserves a concurrent current-profile write and never increments user revisions`
- `account deletion fences a paused migration and recovery never restores erased rows or receipts`
- `migration preserves row IDs times intents and receipts without searching or rewriting progress history`
- `migration target digest stays fixed across activation changes and bundle compilation never autoactivates`
- `unprofiled readable subjects accept labels without default state but reject new state progress and holding`
- `removed profile values remain pinned and readable and their owner can clear them without reacceptance`
- `migration bounds examined source keys through a long pinned prefix and interspersed pinned rows`
- `removing a profile preserves historic state progress and holding pins while permitting own clear and delete`
- `migration shares one examined-source allowance across pinned entries and pending session and copy phases`

### library-labels: 29 scenarios

Source: [specs/library-labels-outcomes.test.ts](../../specs/library-labels-outcomes.test.ts).
Driver contract: [specs/library-labels-driver.ts](../../specs/library-labels-driver.ts).

- `independent personal labels coexist with exclusive state and disclose nothing without a Collection`
- `reapplying one assignment has one native row and one private assignment effect`
- `a subject has a race-safe cap of 32 distinct live labels while duplicate assignment still succeeds`
- `owner partition and active library admission gate owner other anonymous suspended and scope-less actors`
- `receipt replay completes current authorization before lookup and skips lookup on denial`
- `foreign and unknown owner-scoped label identifiers have the same not-found result`
- `assignment requires an admitted catalogue subject and unknown subjects create no owner fact`
- `a foreign label query is hidden as not-found from another account`
- `normalized same-name labels conflict while rename preserves identity and delete permits a new identity`
- `stale label and assignment CAS revisions conflict without changing native rows`
- `exact receipt replay is inert and cannot revive a logically deleted label`
- `state changes leave labels and label changes leave the current exclusive state`
- `creating and assigning a label creates no implicit state session holding follow or entitlement`
- `only explicit public Collection visibility may disclose returned subjects and never label values`
- `state-only and label-only subjects contribute distinct source facts while follows contribute none`
- `logical deletion revokes assignment reads and query facts before physical cleanup`
- `bounded assignment cleanup survives a committed-page crash and concurrent same-name recreation`
- `the account-deletion barrier fences label writes receipts and cleanup resurrection`
- `label commands reject duplicate JSON keys unknown fields and coercion without partial writes`
- `deep catalogue and assignment keysets stay within candidate and memory bounds`
- `assignment rename and logical delete stay fixed-cost as owner data grows at three scales`
- `readable unprofiled labels and curated membership use real admission while new profiled facts stay unsupported`
- `real hidden unprofiled subjects remain concealed and failed label admission has no native effects`
- `logical built-ins are read without writes and keep their identity through first owner writes`
- `empty logical Everything detail and members remain read-only without a stored resource`
- `one stale reservation is reclaimed and parent undo cannot revive it above the live cap`
- `parent hiding and unchanged-claim undo affect Everything before any cleanup worker`
- `retained assignment identity survives reassign reclear and stale purge but ends at whole purge`
- `read-only reserved source and current parent plans stay bounded through same-subject inactive history`

### dynamic-collections: 30 scenarios

Source: [specs/dynamic-collections-outcomes.test.ts](../../specs/dynamic-collections-outcomes.test.ts).
Driver contract: [specs/dynamic-collections-driver.ts](../../specs/dynamic-collections-driver.ts).

- `curated and builtin dynamic Collections share one members page cursor and visibility boundary`
- `curated duplicate occurrences keep order and notes while builtins return each subject once`
- `game recipe and record profiles share Everything and use scoped profile state identities`
- `an empty owner has one private Everything identity and no state-set fanout`
- `profile activation and retirement preserve old pins and do not relabel state identity`
- `labels overlap optional state and retained sessions or holdings preserve Everything membership`
- `source fact changes invalidate old cursors and expose current keyset membership`
- `curator authorization and viewer-native subject reads apply to dynamic members`
- `private predicates stay owner-only and public dynamic output contains only readable subjects`
- `public dynamic revocation withholds stale membership and older projection events cannot restore it`
- `bounded Collection filters advance opaque prefixes through hidden and filtered candidates without joins`
- `shared cursors bind viewer Collection sort size profile generation and keyset and reject tamper or expiry`
- `follow mount export and bulk selection use the Collection identity and unique dynamic subjects`
- `unpublish hides dynamic results immediately and a visibility-revocation stamp defeats stale events`
- `account deletion freezes adopted public subjects without waiting for consumers and erases private predicates`
- `three-scale native page work stays within the candidate cap and shared growth classifier`
- `retired profile facts can lazily resolve their old pinned state Collections`
- `dynamic members have no curated occurrence fields and reject every curation mutation`
- `curated Collections preserve curator order while dynamic members use the unique subject keyset`
- `shared cursor lifetime and key retirement follow the common anonymous and account policy`
- `first and deep native pages stay bounded with sparse catalog filters and hidden candidates at three scales`
- `shared cursors bind Collection identity, the effective filter, and the admitted sort`
- `Everything counts live personal facts once and excludes follow-only curated-only and unprofiled state views`
- `profile retirement preserves every own fact until clearing or soft deletion without accepting new profile facts`
- `terminal durable handoff retains completed public A through pending private B and stale delivery only`
- `terminal deletion fences new private writes while completed public output remains visible`
- `unprofiled curated occurrences remain removable and foreign or hidden mutations have no native effects`
- `terminal deletion preserves completed A and purges private payload through bounded work with no consumer wait`
- `Collection DTOs discriminate curated metadata and localized dynamic presentation without private keys`
- `opaque state lookup uses one native point and terminal deletion defeats delayed repair and follow`

### library-bulk: 38 scenarios

Source: [specs/library-bulk-outcomes.test.ts](../../specs/library-bulk-outcomes.test.ts).
Driver contract: [specs/library-bulk-driver.ts](../../specs/library-bulk-driver.ts).

- `explicit status deduplicates subjects and replays admission and target receipts once`
- `explicit admission rejects empty over-limit mixed selection and unknown predicates`
- `query selection exceeds one hundred and seals before status writes shrink its filter`
- `growing sparse and no-match input advances bounded raw pages to the admitted high-water`
- `entries created after admission high-water are excluded even on later discovery pages`
- `delete and recreate before discovery cannot admit a new revision-one incarnation`
- `external edits before a candidate page change discovery-time membership`
- `state edits before discovery match live predicates while post-seal edits conflict`
- `frozen incarnation CAS rejects delete recreate ABA and missing expected entries`
- `explicit absent status uses validated create and conflicts with concurrent creation`
- `already desired unchanged status has a native no-effect receipt and never rewrites revision`
- `owner other anonymous suspended and consent-revoked use real private admission boundaries`
- `scope role and personal-library gate refusal cannot create a durable operation`
- `target Collection gate and update scope are required in addition to personal-library authority`
- `delegated initiator restoration stops undispatched work on midway consent revocation`
- `account and delegation revocation after a commit reconcile its evidence without another effect`
- `one target denial records partial completion and continues other authorized targets`
- `bulk add skips existing occurrences preserves duplicates and appends one missing subject per operation`
- `Collection capacity skips present subjects and fails only when an absent subject needs an append`
- `explicit occurrence removal deletes only its member identity and deduplicates member ids`
- `query Collection removal freezes all occurrences once and later additions survive reorders`
- `explicit subjects remove all captured occurrences while a missing captured member conflicts`
- `library removal retains sessions progress history copies follows and Collection members`
- `cancellation during discovery labels selection incomplete and applies nothing`
- `cancellation reconciles an in-flight commit and never compensates over later edits`
- `crashes at discovery commit and seal recover atomic manifest checkpoint and enqueue intent`
- `crashes before target commit after commit and before or after acknowledgement never duplicate effects`
- `occurrence transfer commit and acknowledgement crashes preserve immutable pages across partitions`
- `enqueue success never reports mutation success and unavailable receipt evidence remains reconciling`
- `failed enqueue leaves native admission recoverable without a second admission or false completion`
- `missing immutable source fails closed and cannot use current-state inference`
- `progress is bounded truthful and outcome pagination does not repeat or expose the manifest on summary`
- `foreign and unknown operations share 404 for summary outcomes and cancellation`
- `opaque cursors bind viewer route operation filters and page size and reject tampering`
- `cursor key rotation retirement and clock expiry use the accounts opaque helper`
- `durable chunk budgets retry the same index and unavailability is retryable without logical counter drift`
- `native expiry and bounded GC prevent retained DBOS segments and stale admission keys reopening effects`
- `growth axes retain indexed admission replay summary and fixed outcome pages without manifest recounts`

### collection-source: 30 scenarios

Source: [specs/collection-source-outcomes.test.ts](../../specs/collection-source-outcomes.test.ts).
Driver contract: [specs/collection-source-driver.ts](../../specs/collection-source-driver.ts).

- `one Collection source owner preserves native authority covered canonical prefixes and aggregate charged work without rewriting stored identities`
- `5000 duplicate occurrences use strict stored subject index seeks with quotas one and 256 and actual bounded EXPLAIN work`
- `stored a to z c z cannot masquerade as covered canonical order and exact stored misses cannot prove canonical absence`
- `257 aliases with only the last readable retain the boundary and recover the actual positive witness after accepted bounded native repair`
- `identity basis merge unmerge and repoint restart valid continuations while unrelated partition writes do not`
- `current owner other anonymous grants and source sink anchors conceal denial before any candidate work`
- `canonical coverage precedes subject rejection and truthful EOF lookahead rereads and empty seeks are all charged`
- `aggregate reservations across multiple calls never exceed 256 and zero or indivisible extra dimensions stop before work`
- `essential unknown retains its boundary independent true OR settles and ordinary rejection permits advancing empty pages`
- `Everything uses all four native facts overlaps clearing soft deletion unprofiled labels and immutable old profile pins`
- `empty builtins are real identities and missing runtime canonical index profile and publication never report empty readiness`
- `actual activated A private pending B terminal freeze and erasure preserve one public identity without private projection facts`
- `unactivated dynamic publication is withdrawn at terminal deletion and revoked generation cannot be resurrected by older events`
- `activated unlisted output freezes through native public adoption while private builtins remain curator authorized`
- `active public curated Collection survives terminal deletion deidentified with its occurrences intact`
- `native direct membership and shared Boolean proofs do not turn unknown into false under NOT or render to probe`
- `encrypted native continuations bind viewer request basis and route without exposing receipts pins rejected keys or aliases`
- `native first and deep plans at three legal geometric scales bound actual rows buffers statements bytes aliases and duplicate history`
- `257 and 4096 last-readable aliases recover through explicit bounded source group continuation after native repair`
- `pending alias groups reject other targets and stale source or identity bases before candidate work`
- `all-concealed alias groups terminate only after complete windows and late grants require a fresh traversal`
- `positive alias discovery rechecks current original terminal and Collection authority at final use`
- `optional positive evidence is only a current witness hint and rechecks original terminal and Collection authority`
- `native resumable alias first and deep windows at 64 512 4096 measure fixed quota and actual last-alias success`
- `actual advancing alias cursors retain the settled union boundary before the pending group until the last readable witness`
- `an independent current true native source settles a group while another owner has resumable unknown alias evidence`
- `prepare final use and resumed native calls reserve both identity sweeps separately and settle actual work on errors`
- `bounded alias fetch lookahead and unchecked suffixes are charged without adopting an unprocessed native frontier`
- `direct native eligibility resumes beyond 257 and 4096 aliases through shared private 202 cursors with both keysets advancing`
- `direct zero-progress maintenance returns standard retryable 503 Retry-After with no continuation`

### library-listing-freshness: 14 scenarios

Source: [specs/library-listing-freshness-outcomes.test.ts](../../specs/library-listing-freshness-outcomes.test.ts).
Driver contract: [specs/library-listing-freshness-driver.ts](../../specs/library-listing-freshness-driver.ts).

- `a paused old positive first application cannot restore a pair after a newer private zero`
- `first publication followed by private withdrawal fences a positive that never reached the target`
- `a newer delete zero fences an unknown target pair before an old positive first application`
- `duplicate delivery is inert while public private public cycles advance native versions`
- `arbitrary same-source delay and reverse arrivals preserve distinct counts and zero tombstones`
- `partition epoch and Collection member truth share one released authoritative RR client`
- `moved and unavailable source ownership never becomes a successful withdrawal`
- `equal stamps with different projected payload or source binding abort without partial effects`
- `real source commands order bigint positions beyond the safe integer boundary`
- `never-public private and unlisted zeros leave no target holder version receipt or outbox`
- `target failure rolls back version pair count and outbox together`
- `legacy bootstrap learns public evidence without marking private rows and rejects old prepared writers`
- `public pages omit tombstones and reverse history pages cover many current and obsolete public pairs`
- `native apply and bounded public pages keep fixed work as unrelated current and obsolete histories grow`

### library-deletion: 18 scenarios

Source: [specs/library-deletion-outcomes.test.ts](../../specs/library-deletion-outcomes.test.ts).
Driver contract: [specs/library-deletion-driver.ts](../../specs/library-deletion-driver.ts).

- `first-scope owned Library records hide on delete restore within thirty days and purge only through bounded authorized lifecycle`
- `other anonymous and suspended actors cannot delete restore read retained payload or use receipt replay`
- `public references expose only tombstone identity and private existence stays concealed`
- `authorized same-key delete and restore replay once but current revocation precedes receipt lookup`
- `exact kernel day-thirty rejects undo while real purge is parked after durable capture for every kind`
- `replacement ordinal name and capacity collisions and stale CAS never overwrite newer facts or allocate another identity`
- `profile absence allows clearing and exact pinned undo but rejects new profiled values`
- `automatic due purge needs no platform grant and explicit early purge cannot borrow delete authority`
- `purge preserves safe public skeleton references and never decrements visible aggregates twice`
- `stale positive projection and old page cursor cannot resurrect deletion or replace restored generation`
- `restoring a private fact fences its parked stale purge before private state reopens`
- `account retention freezes completed public A discards pending B and erases unlisted private deleted and log payload`
- `child before parent pages recover rollback and commit before enqueue without duplicate effects or broad scans`
- `real SQL examined rows blocks and statements stay bounded at three legal geometric populations`
- `entry undo contracts adopt independent deletion addresses replacement-safe incarnation CAS and unchanged authorized replay`
- `entry deletions retain independent complete snapshots and restore only the addressed occurrence`
- `an exact parked D1 purge cannot consume D3 after restoring and clearing the same incarnation again`
- `entry undo preserves user dates and provenance and permits an old pinned clear and undo without its current profile`

### commerce: 23 scenarios

Source: [specs/commerce-outcomes.test.ts](../../specs/commerce-outcomes.test.ts).
Driver contract: [specs/commerce-driver.ts](../../specs/commerce-driver.ts).

- `anonymous reads an offer but cannot create orders list entitlements or discover private IDs`
- `buyer checkout snapshots the offer at T in the buyer partition and sends inline Stripe prices`
- `checkout without Managed Payments enables automatic tax`
- `same Idempotency-Key replays one order and session while a changed body conflicts`
- `signed paid completion grants once and other sees only the same 404 as an unknown ID`
- `async unpaid completion stays pending until async payment succeeds`
- `async payment failure settles failed without an entitlement`
- `expired unpaid checkout settles failed without an entitlement`
- `identical signed bytes replay before and after processing with one event workflow and grant`
- `wrong secret tampered bytes missing header and stale timestamp reject without durable changes`
- `forged completed for an unpaid session grants nothing while a real paid completion grants`
- `validly signed payload claiming paid cannot override an unpaid current Stripe session`
- `refunded buyer keeps a listed inactive entitlement after a full Stripe-originated refund`
- `partial refund preserves the entitlement and a subsequent full refund revokes it`
- `refund events arriving before checkout completion never grant an entitlement`
- `dispute needs_response revokes and won restores the same entitlement`
- `lost dispute stays revoked and does not emit a restoration`
- `warning_needs_response inquiry preserves an active entitlement`
- `delisting prevents new checkout but preserves an existing entitlement`
- `suspended account cannot create an order while an active account can`
- `definitive Stripe create rejection records failed with no checkout URL`
- `lost Stripe create records unknown then same-key retry recovers the single session`
- `create order webhook delivery and entitlement listing use equal statement counts at three seeded scales`

### follow-counts: 17 scenarios

Source: [specs/follow-counts-outcomes.test.ts](../../specs/follow-counts-outcomes.test.ts).
Driver contract: [specs/follow-counts-driver.ts](../../specs/follow-counts-driver.ts).

- `follower counts are visible only through existing target management authority and outgoing follows only to their follower`
- `Space management uses its installed role through native Access`
- `person agent self automated operator and organization owner resolve the actual account before management`
- `revoked Collection management and ordinary unowned subjects conceal follower counts`
- `anonymous suspended no-scope and closed gate requests fail closed without disclosing counts`
- `outgoing keyset cursors stay signed and bound to the authenticated follower`
- `hidden account agent resolution is empty and cannot be replaced with guessed ownership`
- `one management authorization is performed per count page independent of follower edges`
- `follow unfollow receipt replay and duplicate projection effects preserve a single source edge`
- `explicit unfollow wins over later implied library follow until a new explicit follow`
- `a delayed reverse positive cannot beat a newer negative even on its first target application`
- `suspension and reactivation reconcile current truth and never resurrect explicit unfollow`
- `a positive first application rechecks current account state without waiting for its notification`
- `terminal account event starts bounded private purge immediately and all old work remains fenced`
- `unready projection and unavailable Access never masquerade as observed zero`
- `private follow data never enters public responses FTS public counts sitemaps or notifications`
- `three legal geometric growth scales bound target and outgoing rows blocks and statements`

### viewer-actions: 16 scenarios

Source: [specs/viewer-actions-outcomes.test.ts](../../specs/viewer-actions-outcomes.test.ts).
Driver contract: [specs/viewer-actions-driver.ts](../../specs/viewer-actions-driver.ts).

- `the curator of a Collection with the scope and an admitted gate is offered collection update on the detail read and on its list row`
- `a delegated editor who is not the curator is offered the same operations`
- `the same editor after the grant is revoked is offered nothing on the next read with the same bearer and the edit is refused`
- `a token without the collection update scope is offered no edit operation even with a grant an open gate or gate any`
- `an anonymous reader of a public Collection is offered no mutation and the answer is private no-store`
- `a suspended account gets its normal refusal and never an old positive or an anonymous answer`
- `a banned Realm member loses join and participate while unrelated reads keep their own answers`
- `an assigned actor whose principal lacks the action or is suspended or whose assignment was revoked is offered nothing for it`
- `opening a closed gate offers nothing to an ungranted caller and the granted caller sees the operation only while the gate admits it`
- `one action behind two differently gated operations offers only the admitted operation`
- `a visible resource with no allowed action answers an empty list while a failing dependency answers 503 with no partial positives`
- `a concealed and an unknown resource answer the same not_found item`
- `malformed duplicate oversized or unsupported references answer 400`
- `answers keep request order and are sorted and unique within a resource`
- `two personas never see each other's answers`
- `statements and rows stay constant as unrelated grants resources and history grow`
