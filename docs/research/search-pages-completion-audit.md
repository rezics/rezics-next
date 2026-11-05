# Pages completion evidence audit

Evidence cutoff: 2026-10-28, 12:20 UTC. This is an audit, not product authority. The original pages implementation
and substantive native API/Workers proofs exist in development history. Completion is **not established**: these
changes are absent from main, the later Workers ordering assertion has a recorded failure, and no successful root
gate for the audited revision was found. The separate Zone whole-page proof is absent. During this audit, newer
explicit decisions superseded its universal 256-key replay protocol; owner-document adoption is held, not merged.

## Sources, pins and interpretation

| Label | Immutable revision or observed source      | Meaning                                                                                                                                                                   |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D     | `34dbc5607bf58f36722fb7e252df58fc1120d541` | Audit worktree/base and initial development head; all source line references below use D unless stated otherwise.                                                         |
| V     | `326238439770d13c0fadfc5a819f1110a7a8df53` | Latest development head inspected. No diff from D in composition, presentation, Zone runtime, subject-page documents or the Workers host assertion inspected here.        |
| M     | `9cfe823db1817dc36d2eacce03b2213499a4da10` | Latest main checkout/ref inspected. Composition, presentation and the added pages feature/proofs are absent here. Development integration is not main merge.              |
| A     | `7ff5c2aa6034f8fbd9951cf477c040804b125f65` | Discussion repository authority snapshot.                                                                                                                                 |
| O     | `1b2d6867791125e6f22f2f0235165fd43d690484` | Committed ordered-source specification on an unmerged worker branch; its formerly running work is now cancelled. Not integrated runtime or current replacement authority. |

Repository sources can be located through the pinned [D tree](https://github.com/rezics/rezics-next/tree/34dbc5607bf58f36722fb7e252df58fc1120d541),
[V tree](https://github.com/rezics/rezics-next/tree/326238439770d13c0fadfc5a819f1110a7a8df53),
[M tree](https://github.com/rezics/rezics-next/tree/9cfe823db1817dc36d2eacce03b2213499a4da10) and
[A tree](https://github.com/rezics/rezics-next-discussion/tree/7ff5c2aa6034f8fbd9951cf477c040804b125f65).
`path:line` identifies the first relevant line; `git show <pin>:<path>` reproduces the source. Root package metadata
declares AGPL-3.0-only; `packages/composition/package.json:5` and its source headers declare Apache-2.0. Puck's MIT
licence is identified by ADR-0037:41. This report recommends no source copying, and used no external clone or install.

The full main-checkout `.temp/goal/managers/search.md` was read, together with `AGENTS.md`, the tooling instructions
it names and the relevant owning documents. Its six added-pages Done conditions and approved page/profile/starter
decisions remain the baseline. ADR-0037:31,41–46 and `GLOSSARY.md:425` at A establish the shared format, public
representation, registry, Puck editor and Workers Render obligations. ADR-0037:43 now points to
`docs/subject-pages.md` and `packages/composition/README.md#subject-views`; the brief's older line anchors must not
restore superseded layout authority. [ADR-0037, pinned](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0037-handwritten-kernel-api-standard-tooling.md#L29).

Later Zone resource/membership contracts (`docs/zones.md`, `docs/zone-membership.md`) add runtime obligations
beyond the original **inert** starter scope. Their historical ordered/replay specification is inspected below.
The newly resumed manager continuation explicitly supersedes universal 256-key final replay and identity sweeps;
`supermanager/decisions/{filtered-lists,identity}.md` and `search/resume-decisions.md` now govern that transition.
The eight-file owner-document adoption is held with no attempt/integration. This is an explicit changed contract,
not permission to call old stubs ready or to substitute a research proposal for implementation.

Local primary records are under main-checkout `.temp/goal/`; they are mutable/untracked, not public Git evidence.
The following SHA-256 pins identify the exact authority snapshots read:

- `managers/search.md`: `e5f17936d686a5a3758c4d1d92b1c8bb83222f0da8a466053fb8faf822a0b2fa`.
- `search/CONTINUATION.md`: `4cc3d92b3c7b6170c5d941a1aa64476fce8bfe362671ebc57a77f8058ee20234`.
- `search/op1-ordered-scope-contract-native-spec.md`: `695f6442cebc03259ce129630d44d4050db130cba3cea5548494b44bed8cc252`.
- `search/resume-decisions.md`: `7673cf02d04dbc6179d79dfbc9c22764c2f2789438a21c3dcbe0fb2922eedf1f`.
- `supermanager/decisions/filtered-lists.md`: `6b0b091b26bbb2753fd4081adb6a43f00d4c6a3c5ae55092769439db2b1b59a9`.
- `supermanager/decisions/identity.md`: `431f6486a3bec5bebdc45df4e5abe911e7a0d99cfc63f8daf453643db96e692f`.
- `semantic/resume-contract-adoption.md`: `2a3113a17e3f64a91f7885c6f3095944302bccd383e4024f179fe286fa28912c`.
- Cancelled native whole-page specification, canonical `brief.markdown` in `goal.sqlite`:
  `559c207ba43271501de8a79fb3dad8b3c4aad2b71128b218e2c20cc6414ead36`.

Classifications: **proven** means inspected direct evidence for the stated, bounded claim; **indirect** means a
fixture, unit assertion or narrower scenario supports it; **incomplete** means only part of the obligation exists;
**missing** means the required evidence/artifact is absent at the inspected pin; **contradicted** means inspected
evidence disagrees. A historical pass is always historical, not a pass on D/V or main.

## Requirement/evidence matrix

Abbreviations: composition paths are under `packages/composition`; kernel `presentation/`, `zones/`, `tokens/`
and `search/` are under `services/kernel/src`, and `http/pages.ts` means `presentation/http/pages.ts`.
Kernel `test/`, `db/` and `specs/` mean `services/kernel/test/`, `services/kernel/db/` and root `specs/` respectively.
Web `features/` and `tests/` mean `apps/web/src/features/` and `apps/web/tests/`. Paths within a cell share the
explicit prefix. Execution receipts are separate below; test existence alone is not an execution receipt.

| Requirement / named invariant                                                       | Inspected authoritative implementation and acceptance                                                                                                                                                                                                         | Classification and limit                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One registry-derived `{root,content[{type,props}]}` format; closed types/props/root | `packages/composition/src/registry.ts:232`, `src/schema.ts:42`, `src/validate.ts:334`; generated `schema/composition-v1.schema.json`; `scripts/schema.ts`; `test/validate.test.ts:69,76,251,265,280`                                                          | **Proven** structural closure and generated-schema check exist. Runtime validation additionally enforces global limits/ID uniqueness; the JSON Schema alone does not encode every aggregate invariant.                                                                                                                        |
| Reject HTML, script and executable URLs everywhere admitted                         | Composition `src/strings.ts:11`, `src/registry.ts:232`, `src/validate.ts:423`; `test/validate.test.ts:169`, localized/home tests; kernel `test/presentation/profile-routes.test.ts:110,132`; frozen `specs/pages-outcomes.test.ts:468`                        | **Proven** native refusal for the frozen unsafe cases, with exact pointers and numeric range classification. Safe hrefs are site paths or credential-free HTTPS; strings are inert data, not executable hooks.                                                                                                                |
| Bounded document/profile                                                            | Composition registry limits at `src/registry.ts:57`, validator at `src/validate.ts:423`, profile validator in `src/profile.ts`; `test/validate.test.ts:210,239`, `test/profile.test.ts:139`                                                                   | **Proven** document limits: 65,536 canonical UTF-8 bytes, 256 nodes, depth 8, unique node IDs. Profile: 1 MiB and at most 128 keyed templates, validated constituent documents.                                                                                                                                               |
| Default pages for every launch type, no per-vertical page code                      | `packages/composition/profiles/platform.json`; kernel `test/presentation/platform-profile.test.ts:30`, `platform-lists.test.ts:27`; `packages/definitions/test/vertical-bundles.test.ts:6,78`; web shared `features/pages/{subject,data,overview,render}.tsx` | **Proven** configuration/resolution coverage of released types and eight launch bundles: anime, book, character, game, manga, recipe, series, visual-novel. **Indirect** runtime breadth: native/Workers fixtures do not execute every launch type. This is no evidence that a new per-vertical implementation is needed.     |
| Explicit route > type > nearest structural base > generic; view fallback            | Composition `src/profile.ts:319,342,364`, `src/views.ts`; `test/profile.test.ts:165`, `test/views.test.ts:36,45,63,85`; kernel `http/pages.ts:290`, `test/presentation/pages.test.ts:104,122,131,165`; frozen outcomes at `:421,507`                          | **Proven** resolver order and per-view fallback. Structural bases come from the active definition release. A route target is a separate closed target; it is not silently interpreted as a subject.                                                                                                                           |
| Closed appearance and named slots, including subject actions                        | Composition `src/registry.ts:61,69,276,339`, `test/validate.test.ts:302`, `test/actions-slot.test.ts:22`; web `features/pages/layout.tsx:116`, `subject.tsx:195`, `tests/pages-layout.test.ts:18,30,69`, `pages-actions.test.ts:26,42`                        | **Proven** five token families and seven named slots. Host supplies reviewed first-party controls; configuration cannot supply executable code. Actual Workers fixture includes nested header/actions slots.                                                                                                                  |
| Code-owned bounded descriptors; distinct-read planning                              | Composition `src/registry.ts:36`, `src/reads.ts:12,18,50`; `test/reads.test.ts:57,84,113`, `test/budget.test.ts:24,34`, `test/agent-reads.test.ts:15,34,51,61`                                                                                                | **Proven** canonical descriptor deduplication, at most 16 distinct planned reads and cost 128 at publication. See exact semantics below; these are not measured SQL/engine-work limits.                                                                                                                                       |
| One aggregate BFF round trip                                                        | Kernel `http/pages.ts:213,336`; web `features/pages/subject.tsx:81`, `route.tsx`; `tests/subject-page-read.test.ts`, `pages-workers.host.test.ts:26,43`; kernel pages/frozen aggregate outcomes                                                               | **Proven** one `pages:read` for the template data, probe reuse and one remaining-descriptor batch. **Indirect** for whole-site traffic: definitions/preferences and ordinary separate controls are explicitly outside this aggregate assertion.                                                                               |
| Original page authorization/disclosure boundary                                     | Kernel `http/pages.ts:224,234`, `presentation/reads.ts:224,267,293,319`; real `test/presentation/outcome-driver.ts:7`; six frozen outcomes                                                                                                                    | **Proven** real API persona/hidden/takedown/publish/activate outcomes historically executed. Global presentation admission does not grant subject/Search/Collection rights; actual standalone routes perform their own checks.                                                                                                |
| Original DTO/status/session boundary                                                | `http/pages.ts:40,364`; `presentation/reads.ts:267,333,364`; `test/presentation/reads.test.ts:85,129,141,167`; frozen `specs/pages-outcomes.test.ts:346,369`                                                                                                  | **Proven** source forwarding/preservation and native public DTO checks. **Indirect** joined-token breadth: the explicit multi-partition token-union assertion uses a fake dispatcher, while the native driver transports real persona tokens. No full-stack multi-source token-union receipt was found.                       |
| Immutable Global Context profiles outside definition release                        | `presentation/profiles.ts:30,43,60,108,135,177`; `profiles-{read,publish,active,activate}.sql`; `db/presentation/{schema.sql,migrations/}`; `setup.ts:1`; profile storage/routes tests                                                                        | **Proven** digest-addressed immutable bodies, append-only active head/CAS, public read/active, and trusted one-time bootstrap. Setup does not reset an existing activation. Bodies remain separate from semantic definition releases.                                                                                         |
| Publish/activate require their explicit grants                                      | `presentation/http/profiles.ts:78,193`; Global resource in storage; `test/presentation/profile-routes.test.ts:166,181`; frozen outcomes at `:392,421`                                                                                                         | **Proven** historical real Auth/Access/governance proof; editor scope alone is insufficient and suspended grants do not authorize effects. Fixture-only SQL grants in narrower route tests are not the sole permission evidence.                                                                                              |
| Puck editor, registry fields, stored-format adapter                                 | Web `features/pages/editor.tsx:1,93`, `editor-config.ts`; `tests/pages-editor.test.ts:23,48,68`, `pages-editor-home.test.ts:8`                                                                                                                                | **Proven** real Puck component/config/conversion and refusal code; **indirect** interactive editing: inspected acceptance tests exercise fields/converters, not a browser drag/edit/publish session. No replacement editor or format is called for.                                                                           |
| Actual Puck Render SSR on Workers, interchangeable render map                       | Web `features/pages/render.tsx:1,84,101,114`; `tests/pages-render.test.ts:38,52,67`; actual host/fixture below                                                                                                                                                | **Proven** historical workerd HTTP rendering, not merely an import or Bun `renderToString`. **Contradicted** current completion claim by the later recorded landmark-order failure. Unknown component subtrees are pruned; editor code is separate from Render.                                                               |
| Same-public-representation schema.org JSON-LD                                       | Web `features/pages/subject.tsx:110,198,267`, `jsonld.ts:1,174`; `tests/pages-jsonld.test.ts:86,108,136,150`; Workers test `:87`                                                                                                                              | **Proven** source and actual Workers HTML/parsed JSON-LD comparison for the recorded public book, related author/date/value; script escaping is unit-covered. No second privileged fetch feeds JSON-LD. The upstream-only canary is never delivered, so its absence alone is not a native privacy test.                       |
| Inert Zone starters and active-release saved-filter validation                      | Composition `src/zone.ts:1,150`, `test/zone.test.ts:17,26,67`; eight `packages/definitions/presentation/*/zone.json`; definitions `test/vertical-bundles.test.ts:30,42,53,88`                                                                                 | **Proven** eight labels, at most 16 sorted relative pages including empty home, at most 16 saved scope references, common document validation and actual bundled saved IDs. Reading a bundle instantiates no Zone. Later Zone CRUD does not change this original starter claim.                                               |
| Native operation/growth evidence, not just Cost prose                               | Kernel `test/presentation/{growth-pages,growth-profiles,page-read-kinds,agent-read-kinds}.test.ts`; Cost rows in `src/presentation/README.md:87–185`                                                                                                          | **Proven** specific PostgreSQL captures/classifier tests exist and historical outputs were inspected. **Indirect** broader bounds: simple-page capture, fixed-body profile lookup/commands and individual list axes do not prove every descriptor combination, engine postings, latency or later Zone replay.                 |
| Later Zone shared response, no extra page format, current source rights             | `docs/zones.md:190`, `docs/zone-membership.md:40`; `zones/contract.ts` reuses `extendPageResponseSchema`; `test/zones/typed-contract.test.ts`; `zones/http.ts:76`                                                                                             | **Incomplete** runtime: resource routes and shared schemas are integrated, but D has no mounted Zone `:readPage`/membership execution. Missing functionality is already assigned pending owner work, not a newly discovered pages implementation defect.                                                                      |
| Separate whole-page Zone replay/final-disclosure gate                               | Historical continuation ordered section and ordered brief's “Whole-page and Source-access conditions”; cancelled native page specification; current common `pageAnswer` at `http/pages.ts:336`; newer filtered-list decision items 3,5,6                      | **Missing** whole-page runtime/native proof at D/V. The separate aggregate-page obligation survives; universal final-256 replay is explicitly superseded. Common batching or a single candidate's proof establishes neither the old scheduler nor replacement admission.                                                      |
| Conditional ordered source and cursor contracts                                     | `tokens/list-cursor.ts:20`, `zones/page-continuation.ts:5`, `test/zones/page-continuation-contract.test.ts:6`; O `search/scope-ordered.ts:1`, `scope-source.ts:124,195`; resume/adoption briefs                                                               | **Proven** codec/schema and committed historical specification boundaries; **incomplete** integration and positive runtime. O throws readiness after admission; native tests are staged red and work cancelled. Replacement retains cursor/transport, with owner adoption pending; capacity tests prove no ordered execution. |
| Main merge and complete root gate                                                   | Manager brief “Done when”; `scripts/gate.ts:88,109`, web `scripts/check.ts:380,386`; read-only refs/control-plane receipts below                                                                                                                              | **Missing** successful current main/root receipt. Narrow checks, root typecheck and historical workspace successes cannot substitute for `bun scripts/gate.ts` on the final promoted tree.                                                                                                                                    |

Appearance is exactly density `compact|comfortable`, radius `sm|md|lg`, surface `flat|cards`, cover
`portrait|square|landscape`, headingScale `md|lg`. Slots are `header`, `hero`, `entity`, `aside`, `footer`, `actions`,
`personal`. No arbitrary CSS, HTML, script or third-party appearance execution is admitted.

## Execution evidence actually inspected

The following are archived command outputs in `.temp/goal/runs/`, located by their content hashes and acceptance
commands, not a worker's success summary. Integration commits identify where their results entered development;
they do not assert a new execution on D/V. Slot-wait messages in these logs represent queued checks, not failures.

| Receipt / development integration                                                                                                                                                                                                            | Actual command and observed output                                                                                                                                                                                                                 | What it establishes                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real API suite; `5688c61a038d511dccfada86e120d005996a808d`; raw log SHA-256 `7c2c554081029f10645d1cd70235c1cafeae7e095db2bd89455c0837e5c0c3a9`                                                                                               | `bun run --cwd services/kernel check test/presentation/outcomes.test.ts test/presentation/outcome-driver.ts`; exit 0; wrapper 1 pass, 0 fail, 5 expectations; actual child duration 76.27 s, remote command 144.356 s after a 300.596 s slot wait. | Inspected wrapper requires the actual count of six frozen declarations, child exit 0, six passes, zero failures and no skips/todos. Child output is printed only on failure. Real isolated migrated DB, Auth, kernel, Access and governance; not a fake page responder.                                       |
| Workers host; `2bc8277178aeda4304eed00dd98d2bf83bcd0cd4`; raw log SHA-256 `e698ed81c62f679d2faeba6f7966421c4443285cb3e5dc63d2dbc617aed2998a`                                                                                                 | `bun --cwd apps/web test '--path-ignore-patterns=node_modules/**' ./tests/pages-workers.host.test.ts`; exit 0; 2 pass, 0 fail, 50 expectations, 15.29 s, after a 98.909 s slot wait.                                                               | Actual Vite/Cloudflare workerd host, HTTP HTML before hydration, nested slot placement, same JSON-LD, missing 404, one aggregate and owned process-group teardown. Upstream is a recorded-response HTTP fixture, explicitly not native kernel/Auth proof.                                                     |
| Later Workers regression; branch then at `87d8697a30a13d61fd7443126821a1195fcb4b88`, later integrated through `49ed96bcd18ab40b5d8fa1203e8df66d33d2e457`; raw log SHA-256 `f916cab068c3a6aea144615c89e39f6f8753cf65a657ee7f7685022591927e63` | Recorded invocation `bun test apps/web/tests/pages-workers.host.test.ts --list-tests` actually executed the tests: exit 1, 1 pass/1 fail, 46.94 s. Assertion at host test line 78: `Expected: > 35315`, `Received: 32070`.                         | The first real Workers test failed its ordered landmarks; the same-public-representation test passed. Test bytes at that commit equal D (SHA-256 `a5005a8d36828031faf28f6aed47673c68f2338f501c6d4d0cf024e57b469c49`). This is a historical execution, not a D rerun. Source ordering conflict remains in D/V. |
| Validation classification; `0a36628ffb54203928e713ef1ce59cd1acf90cf4`; raw log SHA-256 `653f4056f3100d1eb9b132ffab56e63b9cf8b6dc6036f5b27f0c7b843762c520`                                                                                    | Final combined composition check + kernel `test/presentation/profile-routes.test.ts`: exit 0; composition 65 pass/0 fail across 13 files; route tests 6 pass/0 fail. Separate recorded `bun scripts/typecheck.ts` exited 0 across all workspaces.  | Repairs the earlier limit-25 classification failure without changing the frozen outcome. Historical typecheck is not a root landing gate.                                                                                                                                                                     |
| Profile growth; `5bbe8a925c86e7dbdabb59aaac487d1ef07c8c6f`; raw log SHA-256 `579567ee1c2325a51120b620aab5f4f5d720f252066c3232d693432c70f0e963`                                                                                               | `bun run --cwd services/kernel check test/presentation/growth-profiles.test.ts`; recorded completed runs each report 5 pass/0 fail (35.27–40.19 s).                                                                                                | All five publish/activate/read/active/bootstrap scenarios execute, using the shared PostgreSQL growth machinery. Source fixes body size/authorization and scales 500/2,000/8,000 profile populations; it does not measure the complete HTTP authorization path.                                               |
| Subject list/read kinds; `a8d4cf7ed097c9c0525c3878f41f67d04abec6a0`; raw log SHA-256 `dcf87d61330baa2277fd289e66d45e331475c1c2468e5430d0eea852c3334b63`                                                                                      | `bun run --cwd services/kernel check test/presentation/page-read-kinds.test.ts`; exit 0; 6 pass/0 fail, 16.27 s.                                                                                                                                   | Actual route/real Access checks for inverse links, public Collections and reactions, plus separate 1/10/100 holder/Collection/contributor axes. Test Auth issuer is controlled, not the full Auth service.                                                                                                    |

The Workers fixture was inspected beyond imports: `tests/support/pages-worker-fixture.ts:36,155` starts the actual
app command/config and awaits real HTTP; it does not replace Render or hand-render HTML. Lines 117–135 await the
owned process group/listener before removing owned state; forced termination is a failure. These are implemented
cleanup assertions, not evidence that a host is currently running. The archived successful attempts exited.

The native outcome driver was inspected through `test/semantic/outcome-driver.ts` and its real fixture factory,
not inferred from its name. A separate curator receives explicit governance grants; a separate operator performs
real hide/takedown commands. `outcome-driver.ts:20` maintains the curator's session; ordinary personas use the
semantic driver's session handling. Narrower `createRealAccess` tests use genuine Access/crypto with test-issued
JWTs and seeded grants; they are useful native SQL evidence but distinct from the full Auth service outcome suite.

The simple-page growth test (`growth-pages.test.ts:35,123`) shares one subject descriptor across header/two facts,
growing unrelated subjects 1,000/4,000/16,000. Its Access fixture is permissive (`:103`); it does not measure native
authorization. Profile tests grow P/H with fixed bodies and authorization. The
individual account-list growth operations include standalone routes (`agent-read-kinds.test.ts:546,586,616,648`);
the aggregate account-page axis is separately at line 508. These exact operations, not every possible page, are
the measured claims. README rows explicitly disclose that profile HTTP route growth is inferred from lookup plus
authorization rather than measured by those lookup tests (`presentation/README.md:175`).

Read-only control-plane state reports the API and Workers proof changes as integrated and the web Zone shell as
stopped. Earlier inspection found the Zone native fixture/union/page specification held and O's worker running.
At the final refresh those native/union/page/ordered tasks are **cancelled**, without integration; the replacement
eight-file owner-document adoption is **held**, attempt zero. `git branch --contains O` still shows only its worker
branch. The resumed continuation explicitly supersedes its historical held/running table. Cancellation, a local
commit or an adoption brief supplies no positive runtime proof. Main and development advanced during inspection;
their relevant page trees remain unchanged at the final pins above.

Promotion metadata names `bc2d98c0652a0b68587552e2ed94bb68b86b48db` for a failed `bun scripts/gate.ts` result and
phase `stabilize-blocked`. Its failure excerpt includes `relation "actor_side_realm.membership" does not exist`,
with content/imports failures. This is an older failed promotion receipt, **not** a reproduced failure on D/V/M.
An additional archived gate log was inspected (`stabilize-gate-29/gate.log`, SHA-256
`5bc1c9c615fa2bffacc36e3473cd262199620002e12e2e79b68123cd08cd8058`): it ends with failed workspaces
`packages/ui services/kernel`, while several pages unit/growth scenarios pass. Its exact source revision was not
established from that log, so those partial successes are not used as pinned current proof. No gate was launched.

## Exact budgets and the separate Zone obligation

`MAX_PAGE_READS = 16` counts **distinct canonical descriptors**, not components, network packets, returned rows or
SQL statements (`composition/src/reads.ts:50`). Repeated components share a descriptor/key; absent subject/account
context can suppress a read. Publication validates with both placeholder subject and account, so context absence
cannot hide an oversized document (`validate.ts:438`). The low-level kernel executor also rejects more than sixteen
input read entries before deduplication; the production planner already supplies distinct entries.

`MAX_PAGE_COST = 128` sums requested maximum output slots for those distinct descriptors: subject, account and
reactions cost 1; Search costs `body.limit`; other lists cost `limit` (`reads.ts:18`). It is not 16 × 24. Exactly 128
is admitted, 129 refused; repeated identical reads count once. Validation rejects excess at `/content`, and profile
HTTP prefixes the error and maps `limit` to `out_of_range`. This arithmetic is enforced at publication, not inferred
from a small actual result. It does not cap related-value bytes, native Access work, physical postings or latency.

The original page endpoint authorizes presentation read on Global, releases its admission slot, resolves the
active profile/type and probes the subject/account through their real standalone reads. Probe results are reused;
remaining descriptors execute with concurrency at most four. Only Authorization and the caller session header are
forwarded, not browser cookies, arbitrary headers or stronger owner credentials. Status/body remain those of each
owning route; their session components are merged with the caller/probes. Top-level response fields are closed;
`document`/nested read bodies are intentionally broad transport schemas, backed by validated immutable documents
and owning-route DTOs. The published response is private/no-store. Account/subject discovery probes (and one
allowed subject redirect) are not additional composition descriptors; this is not a claim of sixteen total HTTP/SQL
operations (`presentation/README.md:93,99`).

The historically approved **whole-page Zone** obligation was different: the same 256 raw-key ledger covered all descriptors and
sources, internal drivers, rejected/duplicate/lookahead keys, rereads, earlier-read replay and final current
authorization checks before one atomic common-page 200. Sixteen reads/cost 128 bounds requested output; it does
not pay the replay work. No partial document, persisted result/verdict/witness vector or sixteen-result cursor
cache is admitted. Public progress is a separate closed 202 `{next}` response. `zones/page-continuation.ts` merely
declares its schema; `zones/http.ts:76` explicitly mounts resource routes only. Pending owner-native page tests
were meant to demonstrate this scheduling independently of the Source single-candidate design. Those tasks are
now cancelled: the paragraph records what the old proof would have required, not a current runtime gate.

The historical conditional ordered contract uses native name/ID or public int32 Collection-count DESC, missing 0,
then name/ID tuples. One owner step is **at most 100 total including lookahead**, quota 1–99; it shares the same
256 ledger across sources/page reads, with separate native axes. All POST Zone page continuations use the existing
Search encrypted profile: eight keys, 2,560 UTF-8 bytes/key, 3,072 aggregate string bytes, 3,584 serialized plaintext
bytes and 4,864 token characters; fifteen minutes even anonymously and 60-second future skew. Stable AAD binds
literal `POST /v1/zones/{id}:readPage`, viewer/null, Zone and body shape only. Dynamic basis is encrypted and compared
after decode; valid-shaped unusable/expired/wrong-principal/stale-basis cursors restart under **current** authorization
to 202/200. Existing GET UUID/default-profile traversal remains unchanged. Codec capacity and O's admission/stub
prove none of positive ordered execution, final disclosure or whole-page completion. Source-access and ordered
native design/adoption remain with their existing owners; this audit introduces no competing design.

The **new explicit decision** removes universal raw-256, whole-selected-slot replay, one pending leaf, identity-basis
sweeps and the ban on derived indexed results as list rules. It retains current disclosure for membership,
exclusion/NOT, order and fields. Filter/source/order must have an admitted page-bounded direct plan, bounded
preparation, or pre-enumeration 422; successful lists are filled/final, otherwise explicitly preparing. Whole-page
admission remains separate, with at most 16 distinct reads and 128 total output slots. The adoption brief retains
atomic common-page 200, 202 `{next}`, no-cursor 503, existing encrypted cursor capacity/binding/restart, and common
request/session/language forwarding. Per-plan numeric allowances and actual native counters belong to Performance
and the runtime owners; the separate **256 IDs per native Source call** is not the abolished universal ledger.
Canonical-ID indexes/identity epochs replace request-time group sweeps. These are read decisions and a held
adoption contract, not implemented capabilities in D/V. Both the old contracts and their supersession are recorded
so neither conditional design nor the changed requirement is mistaken for executable evidence.

## Concrete findings, ordered by impact

1. **Completion evidence cannot be promoted to a main-complete claim.** At M the added composition/presentation
   trees and pages proofs are absent; the inspected development integration is at D/V. Minimal counterexample:
   `git ls-tree -r M -- packages/composition services/kernel/src/presentation` has no implementation. Smallest
   independent merge check is ancestry/tree inspection of the final main ref; the original completion acceptance
   still additionally requires a successful full `bun scripts/gate.ts` at that exact tree. This is a delivery/proof
   gap, not a new product defect or a reason to repeat isolated successful checks now.

2. **The real Workers order assertion and the adopted About order disagree.** Exact pinned locations:
   D `apps/web/tests/pages-workers.host.test.ts:66` requires facts `<dl`, then Editions, then summary;
   D `apps/web/src/features/pages/overview.tsx:635,668,682` renders summary prose before the facts inside About;
   D `docs/subject-pages.md:99` puts About before Parts/Relations and prose before its facts. The recorded book is
   the minimal counterexample: the summary offset 32070 precedes the previous required landmark at 35315, failing line 78.
   The later receipt above demonstrates actual workerd execution, and both sides remain in D/V. Smallest existing
   acceptance: `bun --cwd apps/web test '--path-ignore-patterns=node_modules/**' ./tests/pages-workers.host.test.ts`.
   Both tests must execute successfully after the authority/test conflict is resolved by the owners; this audit
   neither edits the acceptance nor recommends reverting the adopted prose rule. [Test authority](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/apps/web/tests/pages-workers.host.test.ts#L66),
   [owning page authority](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/docs/subject-pages.md#L99).

3. **Whole-page Zone readiness is unproved, separately from original pages.** D `services/kernel/src/zones/http.ts:76` and
   `services/kernel/src/zones/page-continuation.ts:12` are resource routing/schema, not replay execution. Minimal proof counterexample:
   a valid document with two distinct list reads of limit 1 has cost 2, yet the common dispatcher has no Zone-wide
   aggregate admission or 202 continuation. Thus a passing ordinary two-read page cannot prove the later Zone
   obligation. Smallest independent replacement acceptance: admit two actual plans, force preparation of the
   second after observing the first, revoke first-read access, then require current disclosure and no stale/partial
   document before atomic 200; a ready finite input must eventually complete. Native counters must cover both plans
   under their adopted aggregate allowance. The former `test/zones/{ordered-page-contract,ordered-page-work,growth-ordered-page}.test.ts`
   and source-native fixture work is cancelled. Its explicit 16-read/sum-128 and replay cases remain evidence of
   the earlier obligation, not acceptance for the replacement. Owner adoption/revised native specifications must
   settle the new allowances; this audit does not revive the superseded protocol or propose duplicate runtime work.

No additional product defect is established by an absent pending export, a fixture-only assertion or an old failed
gate. In particular, actual native API and actual Workers artifacts are present: describing both as missing would
be incorrect. The current contradiction concerns the later order receipt and final integration proof.

## Remaining proof obligations and adoption recommendation

Retain the original completion boundary. The manager can adopt the matrix as evidence and track these receipts
against the final integrated revision; this report itself approves no product change:

- Resolve the concrete Workers authority/assertion conflict and retain an actual two-test workerd HTTP success on
  the final relevant code. The historical 2/2 pass cannot override the later 1/2 result. Ordinary Bun unit rendering,
  a bundle-size check or typecheck cannot supply that receipt.
- Retain a final-revision receipt for the unchanged six frozen `specs/pages-outcomes.test.ts` scenarios through
  `test/presentation/outcomes.test.ts` and the real driver. Keep explicit-grant, suspended, hidden/takedown,
  immutable-profile/CAS, unsafe-input/pointer and aggregate DTO assertions intact. Search index work is not a
  prerequisite for this particular suite, as its approved claim brief explicitly states.
- Preserve the existing composition generated-schema/check, definitions vertical/starter checks, native
  page/profile/read-kind/language/account tests and their named growth checks in final workspace coverage.
  `packages/composition/package.json` runs format, TypeScript, tests and schema regeneration comparison; kernel
  checks provide migrated DB/capture coverage; the web check explicitly runs host tests as well as isolated tests.
  Session merging, editor conversion and all-launch configuration have the narrower evidence stated above;
  do not describe them as an unperformed full browser/native matrix or demand new per-vertical product code.
- For the **later Zone scope**, first complete the held owning-document adoption and revise the cancelled native
  contracts against it. Then obtain actual current union/target disclosure, admitted ordered plans/preparation and
  whole-page growth receipts: 16 distinct reads/sum 128, independent native bounds and aggregate counters, useful
  finite completion, current revocation and safe cursor restart/atomic response. The cancelled O contract should
  not be integrated as the replacement unchanged; readiness stubs and pure codec tests are not positive outcomes.
  Source-access/ordered design and numeric allowances stay with their owners, without another pages research task.
- Merge the completed scope onto main through the existing landing process and record successful
  `bun scripts/gate.ts` plus required root typecheck for the exact promoted tree, with all workspace/control-plane
  results and no skipped host/native acceptance. Earlier failed promotion receipts must be resolved by their owners;
  neither this report nor a narrow pages pass certifies overall main health. No redefinition of completion is needed.

Audit decisions: use the moved repository topic as authority; treat default coverage as configuration evidence
without inventing vertical-specific code; distinguish original inert starters from later Zone runtime and the newer
filtered-list decision; treat O as unmerged, superseded specification; and classify the Workers order mismatch as an authority/test conflict rather than silently
choosing a redesign. Only this report was changed. No gate, service, build, installation or check-host command was
run for the audit; local validation is report existence, formatting and `git diff --check` only.
