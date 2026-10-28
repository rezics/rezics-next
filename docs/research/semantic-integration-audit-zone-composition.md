# Zone integration and completion audit

Date: 2026-10-28. This is read-only audit evidence, not a completion claim,
product decision, replacement specification or permission to admit runtime work.
The first-public Zone objective remains incomplete on the inspected integration
branch and is not present on the inspected main branch. The implemented resource
substrate is useful evidence; it does not establish membership, page composition,
lifecycle cleanup, default production readiness or main/root-gate completion.

## Inspection pins and method

The source inspection pin is `34dbc5607bf58f36722fb7e252df58fc1120d541`
(the worker's initial HEAD). The control-plane snapshot was taken at
2026-10-28 11:56:47 UTC. Ref observations were:

| Ref       | Initial observed commit                    | Later observed commit                      |
| --------- | ------------------------------------------ | ------------------------------------------ |
| main      | `90ffc5216ae62d52d4534696b3e6957b9ffbe8f8` | unchanged                                  |
| dev       | `82790bc9cccf63ee1d5242ac4cbc5878f37d45ec` | `79ada9bf4e15a44560c1d419b16be6041d90c998` |
| stabilize | `a40b0ea35b4eb92dab2c41082fdd6b24031ce7f9` | unchanged                                  |

The main commit is an ancestor of the inspection pin; there are 3,777 commits
between main and that pin. `git ls-tree` at main contains no
`services/kernel/src/zones/` or `services/kernel/test/zones/` files. An empty
focused diff between the inspection pin and the later dev observation covers
`docs/zones.md`, `docs/zone-membership.md`, Zone source/tests, Search source,
`packages/composition/` and `apps/web/src/features/pages/`. This establishes
those paths' equality, not a complete dev audit or proof about later commits.
The final control-plane read cutoff was 12:10:21 UTC. Several owner registrations
changed from held/running to cancelled during inspection; the ownership table
below preserves this distinction. The code findings did not change in the
focused diff at the final dev pin. This is a bounded snapshot, not a live monitor.

Read in full: `AGENTS.md`, the authoritative ignored
`.temp/goal/managers/semantic.md` and
`.temp/goal/semantic/CONTINUATION.md` in the main checkout. The latter supplies
the latest conditional ordered-page, cursor and whole-page obligations. Focused
owning documents and actual source/test bodies were then inspected. The
control plane was opened through a read-only SQLite URI at
`.temp/goal/goal.sqlite`; task, attempt, worker-result, landing, promotion and
baseline records were distinguished rather than treating their states as synonyms.
Full registered briefs for native fixture composition, UUID union, ordered-page
specification and retention/custody specification were read.

No product, test, runner, database or control-plane state was changed. No native
check, gate, manual worker drain or root typecheck was run. No credentials,
environment files or local configuration were opened. No confidential fixture
values or runtime tokens are reproduced. The report's own existence/format
validation is separate from every product proof discussed below.

Evidence vocabulary:

- **Proven**: the cited source or test body proves the explicitly limited claim;
  a runtime claim additionally needs matching executed evidence.
- **Incomplete**: some required implementation or proof is absent.
- **Weak/indirect**: useful evidence at another boundary, scope or commit.
- **Missing**: no matching artifact or proof was found in the inspected scope.
- **Contradicted**: an assertion of completion conflicts with current source,
  ancestry, test scope or the adopted requirement. This does not mean a new test
  failure was observed.

All source line references below refer to the inspection pin unless another
commit is supplied. A directory or absent export is an inventory finding, not an
observed HTTP response. Stored green results are attributed only to their own
candidate and registered command.

## Requirements, artifacts, invariants and personas

These requirements precede the completion assessment. `docs/scope.md:9–30`
keeps Zones in first public scope as routed sites over saved scopes and mounted
Collections. It also keeps catalogue/editorial/identity/definitions, Search,
Library/Collections and subject pages in scope. No delivered subset changes that.

| Requirement                          | Owning evidence and required artifact                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One catalogue and common composition | `docs/zones.md:3–19,190–226`: inert starters; locale-preserving Zone paths; configured routes and current catalogue subject/view templates; common renderer, no vertical runtime fork.                                                                             |
| Resource/configuration               | `docs/zones.md:21–80,82–99,163–188`: exact eight input labels, safe appearance/navigation, saved scopes and mounts, current release pin, parent create authority, ordinary owner grants, CAS and replay admission.                                                 |
| Safe metadata and owned list         | `docs/zones.md:114–161,210–226`: safe public shell for every reader, owner-only configuration/index, actual current Access; unknown/private/deleted/wholly withheld indistinguishable to outsiders; bounded lists.                                                 |
| Membership                           | `docs/zone-membership.md:11–74`: distinct canonical UUID union of readable scopes and readable mounted Collections; direct membership and mounted-summary endpoints; no mirror, private facts, union totals or authority borrowed from curator.                    |
| Covered progress and identity        | `docs/zone-membership.md:76–166`: common settled watermark; essential unknown cannot mean false/EOF; current original and terminal authority; resumable alias groups; one aggregate raw-key allowance.                                                             |
| Restricted page                      | `docs/zones.md:190–226`: `POST /v1/zones/{id}:readPage`, common top-level page plus safe Zone shell; membership before subject rendering; each list intersects its declared predicate with current readable Zone membership and subject Access.                    |
| Ordered whole page                   | Latest continuation: same-runtime ordered raw Search sibling plus current Zone residuals, conditional on full page proof; at most 16 distinct reads and cost 128 output slots, `readCost(search)=limit`, one 256 ledger for final/replay, no result-vector cache.  |
| Cursor and protocol                  | Latest continuation: POST uses existing Search profile for all viewers, stable AAD and encrypted mutable basis; unusable valid-shaped progress restarts current authorization to 202/200. Default GET stays timeless/deterministic for anonymous readers.          |
| Lifecycle                            | `docs/zones.md:228–319`: exclusive 30-day record restore; least-field withholding/release, legal holds/purge intent, bounded durable cleanup, terminal-account immediate barrier, receipt/history minimization and scheduler registration.                         |
| Native/default/growth completion     | Original resource and membership API/growth tests remain required, including later page consumers; actual owners, all pools and native work accounting; default maintenance can reach readiness; main ancestry and matching root gate are separate final evidence. |

Personas that must remain visible are anonymous public/unlisted reader, authenticated
reader without owner authority, editor/owner with current ordinary role, former
owner after revocation, invalid-credential caller, suspended account, terminal
deleted account, platform moderation/legal actor, and source/subject readers whose
current permissions differ. Curator authority never substitutes for the caller.
The broader semantic objective additionally retains editor and Context acceptor
outcomes; this report does not audit those independently owned contribution APIs.

The original semantic completion objective also retains data-driven versioned
book/recipe definitions plus a third fixture; candidate/provenance/Context
acceptance and adoption/ranks; real partition revision changes; batch relation
labels and incoming freshness; one-hop merge redirect; the actual Access formula;
VN/release/platform/language, anime work/season/episode/release and other catalogue
fixtures, qualified credits, SKOS, eight locales, settings/filters/starters and
10/100-manifest growth. This focused audit neither certifies those obligations nor
substitutes Zone resource tests for their existing ownership and evidence.
All required work must ultimately be merged to main with the root gate at the
relevant main commit. Integrated specification or narrow API green is insufficient.

## Ancestry and stored execution evidence

| Capability                           | Integrated commit                          | What the record establishes                                                                                    |
| ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Resource native specification        | `509e3c15ac14f5b251f837d6d17dfdbbaed31eab` | Documents, fixture and original resource assertions exist; not implementation or execution of the whole suite. |
| UUID membership native specification | `f78f97bd618e8244f6824c87ca98ca6a757a07e6` | Existing membership and growth assertions are registered; not owner readiness.                                 |
| Typed Zone transport                 | `5c37ed018bad25d2af17c1840b3acff4c5e00cf7` | Closed schema boundary; no page runtime.                                                                       |
| POST continuation schema             | `6da22999fe24c544551a85562354803a006f2c61` | Additive query and 202 schema; no continuation coordinator.                                                    |
| Resource substrate                   | `d2262f0daff56b34ae90d02e85041d6eed38daea` | Landing record reports passed at merge stage for the focused resource acceptance below.                        |
| Immutable scope-release loader       | `2202b61fa82fa8828a656c308f50ab6ccf7852ad` | Matching landing reports passed; immutable lookup is not indexed native Scope readiness.                       |

Each listed commit is an ancestor of the inspected HEAD/dev and is not an
ancestor of inspected main. Therefore “integrated” is proven for this integration
history, while “main merged” is contradicted for these capabilities.

The resource landing's registered command is exactly:

```sh
bun run --cwd services/kernel check test/zones/resource-core.test.ts test/zones/typed-contract.test.ts
```

Its candidate/merged commit is the resource commit above, and its stored outcome
is passed/merge. This is useful narrow native acceptance evidence. It does not
execute `resource-contract.test.ts`, `membership-contract.test.ts`, either full
membership growth suite or a Zone page/default-production suite. Supplementary
worker prose about other checks is not substituted for matching controller output.
A no-file check selecting zero tests cannot prove the omitted assertions.

The examined promotion record is `stabilize-blocked`, with main base
`4031f5a86c8599ea8db9730c6b8bd9e4c218582d` and dev head
`bc2d98c0652a0b68587552e2ed94bb68b86b48db`. Its root-gate result is false
at that old dev head. It is neither a successful root gate nor an execution at any
current pin. No matching successful main/root-gate or semantic completion proof
was found in the examined records. No old failure is attributed to this report,
and no repair or rerun was attempted.

## Resource, configuration and public metadata

| Requirement                                  | Assessment                                        | Exact evidence and remaining limit                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mounted base API                             | Proven, limited                                   | `src/zones/http.ts:76–end` mounts create, own list, metadata, configuration read/write, publish, delete and restore; `src/http/kernel.ts:374–380` composes it. Its comment explicitly limits this to resource routes.                                                           |
| Real store and transaction                   | Proven in source; focused executed evidence       | `src/zones/resource-store.ts:25–103`, `resource-commands.ts:153–216,233–320`: keyed head/lock/CAS, parent authorization, native command receipt and event in the write transaction.                                                                                             |
| Create/current admission and replay          | Proven, limited                                   | `test/zones/resource-core.test.ts:10–48` asserts receipt replay, changed-input conflict, stale CAS, current grant revocation before replay, concurrent 200/412 and revoked parent create. This is one of the stored accepted files.                                             |
| Configuration shape and release admission    | Proven in source; additional bodies exist         | `contract.ts:132–185`, `resource-commands.ts:59–112`: validated starter, real released filter lookup, reserved routes, current mounted Collection reads and revision comparison. `resource-validation.test.ts:17–83` rejects unsafe/oversized/unknown input without receipts.   |
| Publication meaning                          | Proven in source                                  | `resource-commands.ts:294–311` changes visibility through publish and replaces configuration/pin through configure; there is no second draft workflow.                                                                                                                          |
| Current read permission                      | Proven in source; partial native coverage         | `resource-reads.ts:60–110` prepares actual Access and mints native read time inside repeatable read, applies active/visibility/withholding checks and uses not-found for inaccessible public reads. Current configure authority separately governs configuration.               |
| Safe shell for every reader                  | Proven shape, partial runtime proof               | `contract.ts:79–90`, `resource-reads.ts:25–49` emit only id/revision/visibility/labels/navigation/appearance. Core test `49–69` checks exact public keys and suspended/configuration/list denials; typed test `1–33` rejects private fields. Full page shell still unavailable. |
| Native owner role rather than creator bypass | Proven in source; narrower coverage than transfer | `resource-store.ts:117–120` and `resource-owner-evidence.sql:1–5` read the current ordinary `semantic.zone.owner` role. `resource-reads.ts:112–215` combines owner index, role and actual Access. Attribution alone is not permission.                                          |
| Revocation and owned continuation            | Incomplete executed proof                         | `resource-validation.test.ts:156–184` removes the ordinary role while generic read remains and checks configuration/list/restore denial plus cursor binding. This is stronger than a creator-only test, but no full transfer/synchronization native outcome is established.     |
| Limits and growth                            | Weak/indirect for the full objective              | `resource-growth.test.ts:1–47` grows 64/512/4096 resource populations and measures metadata/own-list with limit one. It does not measure page proof, alias degree, configuration history cleanup or default Source readiness.                                                   |
| Invalid/suspended/terminal actors            | Partial                                           | Core test covers suspended metadata and anonymous own-list; `resource-validation.test.ts:85–112,186–212` covers invalid credentials, verified suspension and terminal-account writes/replay. Terminal rejection is not payload erasure.                                         |

Paths in this table are relative to `services/kernel/` unless prefixed otherwise.
`http.ts:72` sets private/no-store caching for base reads. That is not evidence
that every future page/202 response forwards the right headers or session state.

`docs/zones.md:127–146` explicitly describes the mounted base and pending transfer
proof. Accordingly, attribution and owner index must not be promoted to an
unbounded claim of every future account/role lifecycle being complete.

## Lifecycle: delete/restore is not purge and custody completion

Soft delete and restore are implemented. `resource-commands.ts:294–305` retains
configuration, sets the 30-day deadline, and refuses restore at or after that
deadline. `resource-core.test.ts:70–85` asserts retained payload, unauthorized
restore, success at one millisecond before the deadline and conflict exactly at
the deadline. These are real bounded claims supported by the narrow landing.

The remaining lifecycle requirements are incomplete or missing:

| Obligation                           | Current evidence                                                                                                                                                                                                             | Minimal missing proof / ownership                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Least-field takedown and release     | `docs/zones.md:278–290`; original `resource-contract.test.ts:455–487` checks partial labels and restore retaining withholding. No mounted takedown/release route exists in current Zone HTTP.                                | Actual commands, platform admission and native safe metadata/document/receipt outcomes. Resource follow-up is described, but no active dedicated Zone lifecycle implementation was found in the inspected registration set. |
| Legal purge intent versus takedown   | Original resource contract `296–423,489–547` requires automatic cleanup to respect notice evidence, explicit legal-order intent and holds. Current resource routes implement none of these commands.                         | Real hold/intent generation, races, covered evidence preservation and least-payload cleanup.                                                                                                                                |
| Bounded durable purge                | `docs/zones.md:272–276,292–310` requires `purgeZonePage`, opaque generation-bound progress, held/ineligible raw-key advancement and durable wakeup. `resource-fixture.ts:163` imports `zones/purge.ts`; that file is absent. | Native purge export, transactionally persisted checkpoints, fragment bounds, replay/crash/race assertions and scheduler continuation.                                                                                       |
| Default scheduler                    | `src/work/modules.ts:68–79` registers existing account/library/commerce/Search/etc. modules; no Zone cleanup module exists.                                                                                                  | Actual registered default work and restart/held-release completion, not manual calls alone.                                                                                                                                 |
| Terminal account barrier and cleanup | Base validation rejects terminal-account writes. Original resource contract `549–593` requires immediate active/deleted private payload and receipt cleanup after native account finalization.                               | Actual account consumer/owner traversal and cleanup proof with no individual-record grace.                                                                                                                                  |
| Public tombstone/private skeleton    | Original resource contract `296–423` inspects raw payload, grants, receipts and public/private residue; current base soft delete retains payload.                                                                            | Proven minimization of configuration/mount/history/receipt data while preserving only lawful nonpersonal skeleton.                                                                                                          |

The registered retention/custody native specification is held and covers
`test/semantic/{deletion-contract,retention-contract,growth-retention,account-erasure,scoped-takedown}.test.ts`
and the semantic deletion contract/fixture. Its full brief requires the exact
Core receipt/outbox, Content body/media and account-tombstone port inventory,
raw-key/fragment bounds and crash/hold races. It is the existing owner of that
inventory; this report does not duplicate it or invent ports. Its declared scope
does not implement `zones/purge.ts`, Zone HTTP withholding or Zone scheduler
registration. Those Zone production obligations remain additional gaps.

## UUID membership and actual owner readiness

The implemented Zone directory contains resource, eligibility, transport and
continuation-schema files. It contains no `membership.ts`, `membership-work.ts`,
`membership-position.ts` or `membership-http.ts`. Consequently the three required
membership consumers are not implemented by the inspected Zone router:

| Consumer                           | Required outcome                                                                                   | Current assessment                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /v1/zones/{id}/subjects`      | Canonical distinct UUID union, default 20/limit 1–100, opaque bounded progress and no total/count. | Missing route/coordinator; existing native assertions are not execution proof. |
| `GET /v1/zones/{id}/collections`   | Only currently readable mounted public summaries, no source/private metadata leakage.              | Missing route; common owner summary types alone cannot satisfy it.             |
| Direct subject / `containsSubject` | Current native positive/negative/not-proven, alias-resumable and later page gate.                  | Missing Zone primitive; the page consumer is separately missing.               |

The genuine owner boundaries currently stop before a usable producer:

| Boundary                      | Current code/test body                                                                                                                                                                         | Assessment                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Same Search service           | `src/search/service-scope.ts:9–33` records runtime ownership but `createSearchScopeForService` always throws `index_not_ready`.                                                                | Contract/registration is proven; service-bound native capability is missing.                                                                    |
| Scope prepare/prefix/evaluate | `src/search/scope-source.ts:123–175` parses, expands/admit/compiles using the real compiler, then returns unavailable; prefix/evaluate only validate reservations/progress before unavailable. | No prepared native handle or current truth is implemented.                                                                                      |
| Immutable release             | `src/search/scope-release.ts:8–20` uses `readRelease(pool,digest)` for explicit pins and active release only when omitted. Scope prepare passes that immutable body through admission.         | Loader is implemented. No native Zone test yet proves pin A survives activation of changed same-ID release B while Access/facts remain current. |
| Current Semantic leaf         | `src/semantic/scope-leaf-evidence.ts:96–103` validates and returns `not_ready`. `src/semantic/README.md:224–431` specifies the real reader and independent slices.                             | Types/specification are present; native evidence production is missing.                                                                         |
| Collection source             | `src/library/collection-source.ts:189–215` declares prepare/prefix/contains/raw-prefix; every factory method throws `dependency_unavailable`.                                                  | Neither a usable curated adapter nor all required built-in/public/frozen providers is established.                                              |
| Canonical identity/alias      | `src/semantic/README.md:433–864` specifies terminal, basis, sealed metadata and group ports. Current Zone dependencies do not provide the missing native producer exports.                     | Existing lightweight item identity/reference reads are not substitutes for complete canonical-group coverage or current terminal Access.        |
| Ready canonical Search index  | Registered storage, lifecycle/native contract and controlled-population helper slices exist, but actual initialization/population/certification/activation are pending in the owner chain.     | A helper import or format-only landing is not READY certification or production convergence.                                                    |

`test/search/scope-source-contract.test.ts:27–83` uses forbidden fake runtime
methods and explicitly expects valid native admission to fail readiness. A green
there proves fail-closed admission, not successful native search. The valid Source
research pair remains evidence awaiting proof/adoption at its own boundary:
`docs/research/semantic-native-leaf-access-current.md` at
`8edc18751cd60a7e3aa5cd8b5680fcb88b03fccf` and
`docs/research/semantic-native-leaf-access-independent.md` at
`75fa75b409914a86d969fc27ae831e960ef749af`.
Their current complete-negative-selection examples exceed 256 facts within an
admitted plan. No remedy, Source interpreter, certificate, query restriction or
codec design is proposed here. Treating the pair as an implemented capability
would be contradicted by the reader and evaluator stubs.

### What existing native membership bodies actually assert

`test/zones/membership-contract.test.ts` contains meaningful full API assertions:

- `236–261`: overlapping Scope/Collection union, scope-only and collection-only
  membership, safe summaries and outside/withheld direct target denial.
- `263–313,425–442`: private/hidden sources and private-Zone unknown equivalence.
- `315–338`: long filtered windows with finite progressing empty pages.
- `340–359`: viewer, Zone and query cursor isolation.
- `372–418`: actual built-in library-backed membership without copying private
  library notes into the Zone or public source metadata.
- `444–491`: current grant revocation on continuation and actual Collection
  delete/restore behavior.
- `493–535`: canonical ascending traversal despite reverse source/occurrence
  order, preserving stored occurrences and notes.
- `537–567`: denied prefix followed by a positive tail with bounded progress.

Do not overread them. The helper at `177–192` sorts accumulated IDs, so the early
union assertion alone does not prove traversal order; the later dedicated body
does. The unsupported saved-scope case at `361–370` supplies an unknown saved ID
and expects 400; it does not prove 422 for a known expanded but unsupported plan.
The built-in privacy body checks selected output fields, not complete
before/after cardinality/privacy invariance for every public cursor and summary.

The fixture creates the real kernel and actual Access but does not inject the
same real Search service or run controlled native index population/certification.
It also does not establish a complete Zone presentation setup. The registered
native fixture-composition specification explicitly owns this correction, the
two-release case, actual Commerce repair/factory use and missing native accounting
observations. No passing substitute fixture was constructed in this audit.

`test/zones/growth-membership.test.ts:20–54,58–131` retains 64/512/4096 scales,
one warmup, three repetitions, first/continued windows and successful direct
`:readPage` consumption. Its explicit coarse rows/statements ceilings are useful
SQL safeguards; they are not proof of one raw-key ledger or physical engine work.
The 4096 repeated occurrences case is not a 4096-alias/only-last-readable case.
A missing page route must not become a successful low-cost growth sample.

## Restricted composition, ordered reads and protocol

| Layer                              | Evidence that exists                                                                                                                                                                                                       | What it does not establish                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed DTO                         | `src/zones/contract.ts:93–112` derives the common page extension, route-or-subject target and bounded languages; `typed-contract.test.ts:1–33` rejects private/invalid shapes.                                             | No page execution, final membership or actual renderer status handling.                                                                                                            |
| 202 query/body                     | `src/zones/page-continuation.ts:1–20`, `page-continuation-contract.test.ts:1–29` accept an unpadded token up to 4864 and only `{next}`.                                                                                    | No route, progress generation, current authorization or termination.                                                                                                               |
| Common planner                     | `packages/composition/src/reads.ts:12–49` fixes 16 reads, cost 128 and search cost equal to limit, deduplicating equivalent descriptors. `test/budget.test.ts:24–48` checks exact 128 versus 129 and repeated descriptors. | No native multi-owner 256 budget or whole-page final/replay proof.                                                                                                                 |
| Common read executor               | `src/presentation/reads.ts:224–364` forwards caller credentials/session/languages, dispatches standalone APIs, follows one redirect and uses concurrency four.                                                             | Its Search path is global `/v1/subjects:search`; there is no Zone predicate, shared Zone ledger or ordered residual coordinator.                                                   |
| Common executor tests              | `test/presentation/reads.test.ts:85–255` checks credentials, redirect, session merge, deduplication, 16 reads and max four in flight using `fakeKernel`.                                                                   | These are useful orchestration tests, not actual Zone owner/native work or whole-page final evidence.                                                                              |
| Common page templates              | `test/presentation/pages.test.ts:65–189` checks readiness, type/base/generic/view/route lookup through the real common page API.                                                                                           | No Zone target-membership gate, current residual ordering or continuation.                                                                                                         |
| Existing Zone full page assertions | `test/zones/resource-contract.test.ts:148–294` requires safe top-level page, caller languages/session/status, appearance/navigation and subject/view targeting.                                                            | Fixture configured pages are text and the generic subject page has a SubjectHeader; this is not a multi-TypeList ordered/full-final workload. Current router has no page endpoint. |
| Web consumer                       | `apps/web/src/features/pages/route.tsx:14–48,65–104` loads/renders common pages.                                                                                                                                           | No Zone routes/shell, Zone 202 continuation loop or max-four-then-preparing-503 cursor flow was found. The earlier dedicated shell registration is stopped.                        |

### Adopted conditional ordered direction versus delivered evidence

The current ordered evidence pair is
`docs/research/zone-type-list-order-current.md` at
`1a88c2e6f81540a1426cda8282d2defbbf5e3b29` and
`docs/research/zone-type-list-order-sol-xhigh.md` at
`df2cc338e1ee05753d09c4b5ee638f0e02236a85`.
The conditional direction preserves native complete `name_sort ASC/id` or public
Collection-count descending/missing-zero/name/id order with current Zone
residuals. Sorting a UUID result page locally cannot prove that order. The
Search ordered owner contract was running at the initial snapshot and was
cancelled by the final read; no ordered runtime export exists at the inspection
pin. The Zone ordered native specification is held, not integrated.

Its registered scope already includes the following exact missing proof; these
are owned specification obligations, not new research requests:

- Real same Search runtime and native Collection/identity producers; divergent UUID
  versus native name/rank ordering, ties/missing values and real 250-CJK/normalizer
  boundaries; no fabricated ranks, raw hits or ready certificates.
- Actual 257/4096 aliases with only the last readable original, pending original
  resumed first, current source/Zone/original/terminal/fact/fence/consent revocation.
- Essential unknown predecessor blocks later truth/EOF; independent current true
  may settle membership OR but never an unknown TypeList conjunct.
- Sixteen distinct reads with sum limits 128, plus mixed subject/list plans,
  equivalent-descriptor deduplication and independently overlapping descriptors.
- Paid nonempty lookahead, late pending reads, prior-read replay, current revocation
  and cold/final checks under the SAME outer 256 allowance; atomic full 200 and
  finite completion on a fixed finite ready basis without result-vector storage.
- Every owner call TOTAL at most 100 including lookahead; all raw candidates,
  aliases, internal facts, duplicates, rereads and final checks reserved before I/O.
  Native points/witnesses/rows/bytes/empty seeks, engine work and all pools remain
  independently observed. The fixed two-sweep basis cost is 8192 metadata rows
  plus Core observations per applicable phase, not free per-candidate evidence.

No current native whole-page test file or result proves these requirements.
The original membership/identity specifications have relevant component assertions:
`test/semantic/scope-leaf-identity-composition.test.ts:34–196` checks compact
identity/progress and basis work, and `197–246` constructs real 257/4096 merges,
hides all but the last original and requires actual basis/group/terminal exports.
That latter body is a component last-alias test, not Zone list/direct-target or
whole-page final replay. Missing exports do not make it pass.

There is a concrete contract-reconciliation obligation before runtime admission:
`src/search/scope-source.ts:151–154` permits quota 100 with separately reserved
lookahead, and its comment at `173` refers to 101 remaining keys. Identity/leaf
native contracts similarly describe 100 plus one. The latest Zone requirement is
TOTAL 100 including lookahead, so a Zone reservation must fit inside 100; native
101 must not silently become Zone 101. Current code returns unavailable, so this
is not evidence of an executed overrun. The existing fixture/ordered briefs
already cover the stricter composition cap; no budget expansion is authorized.

### Cursor proof is narrower than restart and liveness proof

`src/tokens/list-cursor.ts:20–47` publishes the existing profiles:

| Profile | Keys / per-key UTF-8 | Aggregate / plaintext / token | Required Zone policy                                                                 |
| ------- | -------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| default | 8 / 256              | 2048 / 3038 / 4096            | GET subjects/collections unchanged; deterministic timeless anonymous, timed account. |
| search  | 8 / 2560             | 3072 / 3584 / 4864            | POST readPage for every viewer; 15 minutes plus 60-second future skew.               |

`test/tokens/list-cursor.test.ts:271–365,423–554` contains actual default timeless,
Search capacity/expiry/future-skew and profile-isolation assertions. These prove
codec policy at that boundary, not a mounted Zone policy.
`test/search/ordered-cursor-capacity.test.ts:150–174` round-trips proposed vectors
through the actual codec and records bounded serialization maxima.
Its `177–208` body binds only literal POST route, viewer, Zone and body-shaping
digest, decrypts the old basis and compares it to a different current basis.
The body explicitly calls this unit comparison evidence. Overflow and cross-profile
cases at `211–245` are useful safeguards; no native order parser, real pending
record, current Access or repeated-page liveness follows from them.

Minimal missing native protocol evidence is a real expensive request producing
progress, followed by all-viewer timed continuation, actual basis change,
expiry/sign-in/viewer change and malformed-but-valid-shaped ciphertext restarting
fresh current authorization into 202 or full 200. Invalid body/query still returns
400; actual current denial remains denial; invalid credentials never downgrade.
202 must contain only `{next}` with private/no-store; 200 must contain the full
common page plus shell; genuine no-progress/readiness 503 has Problem and
Retry-After with no cursor. Web must exercise at most four bounded continuations
then surface preparing 503 while preserving the usable cursor. None is established
by capacity vectors or the generic common-page loader.

## Registered ownership versus genuine gaps

This is a capability/state map from the inspected registrations, not a dispatch
plan. Exact identifiers and dependency edges are kept only in the ignored worker
file `.temp/zone-audit-control-plane.json`.

| Capability                                                      | Observed state and dependency coverage                                                                                                                                                                                                                      | Remaining classification                                                                                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Resource substrate / transport / immutable loader               | Integrated at the commits above.                                                                                                                                                                                                                            | Limited implemented foundation; no full completion claim.                                                                                                                                  |
| Native UUID fixture and prefix/target/work/growth specification | Held after actual Collection source/raw prefix contracts. Requires same real Search setup, native repair, two-release semantics, aliases and all-pool accounting; preserves original full API tests.                                                        | Already owned; do not duplicate its producer or fake missing providers.                                                                                                                    |
| Thin UUID coordinator                                           | Held after resource, Collection factory, Search service/evaluator, native fixture, release loader and coverage lifecycle. Acceptance is focused GET/prefix/contains/work/growth.                                                                            | Already owned; intentionally excludes page and Zone cleanup. Original page-consuming API suites remain mandatory later.                                                                    |
| Search current evaluator/service binding                        | Initially held through compiler/current matcher, native leaf, identity/group and canonical coverage dependencies; evaluator and prefix registrations are cancelled at the final read, while binding remains held.                                           | Existing owner chain is interrupted; no usable service-bound producer or replacement for the cancelled evaluator was found.                                                                |
| Canonical identity foundation                                   | Metadata producer stopped; terminal/group slices held.                                                                                                                                                                                                      | Registered chain exists, but the stopped prerequisite needs an owner/controller decision; no native readiness inference.                                                                   |
| Canonical Search coverage/default setup                         | Storage/contracts/helper integrated; initialization, population and certification held. Lifecycle initially held, cancelled at final read; its declared chain includes population/certification. A later registered default-worker slice is also cancelled. | Existing dependencies need owner/controller reconciliation; format-only contract/projection results and helper extraction do not prove convergence.                                        |
| Collection canonical repair/factory/default work                | Initially held through native source reader/repair/contains; factory, raw-prefix, current-reader, repair, contains and default-worker registrations are cancelled at final read.                                                                            | Existing Commerce responsibility has an interrupted production chain; no active replacement touching those producer paths was found. Built-in/public/frozen availability remains required. |
| Ordered Search contract                                         | Initially running, typed honest-unavailable contract and candidate specification only; cancelled at final read.                                                                                                                                             | Existing registered scope covers the handoff, but an active producer is missing at cutoff; no permission for runtime admission.                                                            |
| Ordered Zone whole-page specification                           | Held after native fixture. Full brief explicitly owns 16/128, SAME256, current replay, no result cache and all-pool native growth.                                                                                                                          | Already owned missing evidence; do not duplicate ordered specification or algorithm research.                                                                                              |
| Source access proof pair                                        | Reports integrated; proof/adoption at current native boundary pending.                                                                                                                                                                                      | Already active research/decision chain; not implemented capability.                                                                                                                        |
| Retention/custody native port inventory                         | Held semantic deletion specification, exact owner ports and native boundaries explicitly in scope. Its preceding semantic deletion-command producer changed from running to stopped.                                                                        | Already owned inventory with a stopped prerequisite; does not cover Zone-specific runtime and routes.                                                                                      |
| Restricted page runtime and default whole-page execution        | No active dedicated implementation registration found beyond specification/union consumers in the examined set.                                                                                                                                             | Genuinely uncovered production handoff: consume actual union and ordered owner ports, mount page API, preserve native full page behavior. Do not create another specification producer.    |
| Zone withholding/purge/account cleanup and default scheduler    | Required by owning doc and original native resource suite; absent current runtime and dedicated active registration found.                                                                                                                                  | Genuinely uncovered Zone production work, distinct from semantic retention inventory.                                                                                                      |
| Web Zone routes/shell/continuation                              | Earlier registration stopped; no integrated Zone consumer found.                                                                                                                                                                                            | Existing responsibility needs reactivation/replacement decision rather than a duplicate producer.                                                                                          |

“Held” is not failure or permission to bypass an owner. A queued check is not
stuck. This audit neither starts checks nor changes registrations or dependencies.
No task graph edge or current source proves the eventual production result.

## Prioritized next decisions and exact missing evidence

1. Preserve the current incomplete designation. Main needs the actual capability
   commits in ancestry and a matching successful `bun scripts/gate.ts` result;
   neither the old promotion nor resource landing is that evidence. Keep the
   original semantic/catalogue/API personas and native/default/growth outcomes
   visible alongside this Zone slice.
2. Resolve the stopped identity prerequisite and await the existing Source/current
   evidence decision. Required evidence is actual exported native ports, current
   proof under the admitted legal case and honest independent work receipts. Do
   not rerun the pending research, invent Source truth or lower admission limits.
   Reconcile the now-cancelled Search/Collection producer registrations with the
   still-held consumer dependencies; registered historical scope is not an active
   producer. No cancellation is treated as an implementation or research result.
3. Complete the already registered native fixture/UUID and ordered specification
   handoffs. Required evidence is real same-runtime setup/certification, immutable
   release A versus active B, finite list/direct-target last-alias traversal,
   current revocations and public cardinality/privacy invariance. Component helper,
   typed schema and serialization greens remain separately labeled.
4. Keep ordered runtime conditional. Required evidence is native whole-page
   16-read/cost-128 execution with equivalent and independent overlapping
   descriptors, late pending work, all-pool/engine reservations and SAME256 final
   replay, finite atomic 200 and no result-vector cache. One read, one candidate,
   coarse SQL ceilings or fresh 256 per descriptor cannot satisfy this condition.
5. Assign the uncovered production handoffs without duplicating existing native
   specification or custody inventory: restricted page API/default execution,
   Zone-specific lifecycle/account/scheduler work, and the stopped Web consumer.
   Required evidence includes the unchanged full resource/membership/growth API
   assertions, actual default maintenance and native POST restart/status/session
   behavior for every persona, plus Web bounded continuation/rendering outcomes.

## Sources, shared patterns and recommendation

Primary sources are this repository's owning documents, code and actual test
bodies, pinned above, plus the read-only registered briefs and execution metadata.
Repository URL: [rezics-next](https://github.com/rezics/rezics-next).
For reproducible source navigation, use
[the inspected tree](https://github.com/rezics/rezics-next/tree/34dbc5607bf58f36722fb7e252df58fc1120d541),
including [Zone contract](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/docs/zones.md),
[membership contract](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/docs/zone-membership.md)
and [Zone native tests](https://github.com/rezics/rezics-next/tree/34dbc5607bf58f36722fb7e252df58fc1120d541/services/kernel/test/zones).
The root package declares AGPL-3.0-only; the composition files cited above carry
Apache-2.0 SPDX headers. No external reference clone or third-party excerpt was
needed, installed, built or run. No external design is being imported.

The sources consistently separate resource admission, current owner truth,
canonical discovery, final authorization, common composition and durable cleanup.
They also separate typed/format readiness from successful native production and
integration ancestry from main promotion. The recommended action is to retain
those boundaries and the original acceptance, use the existing owner chains for
missing evidence, and explicitly cover the uncovered production handoffs. This
report changes no owning authority and makes no new architectural choice.
