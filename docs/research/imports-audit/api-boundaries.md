# Importer API, identity and media completion evidence

Reviewed checkout: `50253f81316a8e975d67971fb62ed42db3145c10`.
All relative `file:line` citations below refer to that commit, not a moving integration branch.
This is an internal evidence review, not a new contract or a substitute for the owning documents.
No executable suites, root gate, kernel check or remote checks were run for this review.
`proved-by-current-code-and-tests` means the inspected production path and executable assertions support the
requirement; it does **not** assert that those suites passed in this attempt.
`unverified` identifies missing execution or missing coverage; `incomplete/contradicted` identifies concrete drift.
Main merge and a passing `bun scripts/gate.ts` remain **unverified** and necessary for Goal completion.

## Authority and scope decisions

- The manager brief was read completely at the supplied read-only path. Its Done-when supplies the outcome inventory.
  Current repository contracts take precedence over its obsolete implementation wording.
- `services/importer/README.md:21` and `services/importer/src/credentials.ts:10` specify six base scopes and seven for
  VNDB, superseding the brief's literal “exactly its four scopes.” Four explicit import grants are not six token scopes.
  `services/kernel/src/semantic/README.md:62` also requires per-command create/propose authorization.
- The current first-party registration is explicit (`services/kernel/test/imports/identity-fixture.ts:362`);
  no third-party-client restriction or website identity is inferred from older wording.
- The brief's earlier upload wording is superseded by URL import: the current public driver contract requires
  `POST /v1/media:importFromUrl`, an ordinary account bearer and no BFF (`specs/imports-api-driver.ts:57`).
- Literal “writes only through public bulk API” is **incomplete/contradicted** as an all-writes statement:
  media uses the approved public media API, and VNDB statistics now use public PUT
  (`services/importer/src/cli.ts:606`, `services/importer/src/import-client.ts:289`).
  Subject creation/proposal/retraction still use bulk. The owning importer README at line 34 documents the statistic
  route; this report does not invent an exemption or silently reconcile the older blanket sentence.
- Cover complaints are two ordinary commands in separate partitions (`specs/imports-api-driver.ts:257`), not an atomic
  media-plus-fence transaction. `services/kernel/src/content/README.md:309` says takedown also fences; the route explicitly
  requires a separate fence command (`services/kernel/src/content/media-moderation-routes.ts:38`). This wording ambiguity
  remains visible; the reviewed outcome proves the two-command workflow, not automatic fencing from media takedown alone.
- Converter internals and the general reconciliation/journal algorithm are outside this review. Their outputs and
  storage observations are traced only where needed to evaluate public boundary fidelity.

## Ordinary identity and authorization

- **proved-by-current-code-and-tests — automated account, normal Auth and JWKS.**
  `services/kernel/test/imports/identity-fixture.ts:343` creates the real Auth host with native account/proof bindings;
  lines 403, 436 and 441 invoke deployment bootstrap, durable approval and automated-account creation.
  Lines 449–466 stage/approve/apply its public-key credential; lines 467–493 sign only an account assertion and call
  `/signin/key`, then `/token`. Access tokens are not signed by the driver. JWKS fetch goes to the real Auth handler
  (line 319); this is an in-process transport boundary, not a verifier replacement.
  `specs/imports-identity.test.ts:59` checks issuer, audience, sub, client, JWKS kid, verified Access actor, native active
  account state and automated/operator ownership. Lines 104–113 require actual captured authentication SQL/plans.
- **proved-by-current-code-and-tests — exact grants, reduced scopes and no completion bypass.**
  `specs/imports-identity-driver.ts:38` defines Global and the common/import actions; public grant requests attach them
  to Global (`services/kernel/test/imports/identity-fixture.ts:529`). `specs/imports-identity.test.ts:43` calls production
  `accessCheck` on a connection; lines 152–198 compare persisted grants, deny decoy resources, remove token scopes and
  reject tampering. Line 56 denies `media:complete`. Registration has six scopes at fixture line 365, while explicit
  grants have four; the standing proposal grant and reservation ownership supply the remaining authority.
- **proved-by-current-code-and-tests — distinguish registration from issued token scopes.**
  The identity-only fixture issues four scopes (`identity-fixture.ts:256`, line 564), matching the exact assertion in
  `services/kernel/test/imports/identity-key-credential.test.ts:17`; registration allowing six does not widen it.
  The full API fixture explicitly obtains another token with all six before any import (`api-runtime.ts:256`) and
  renews with the same scopes at line 417. Thus the identity-only assertion is not proof of full media/proposal scope
  sufficiency, and is not a contradictory test. No scope exception is inferred from its narrower token.
- **proved-by-current-code-and-tests — replay is reauthorized without disclosing receipts after revocation.**
  `specs/imports-api.test.ts:721` exercises ordinary preflight, direct captured HTTP replay and revoked bulk authority;
  lines 750–761 forbid stored IDs/receipt disclosure and any new effect/checkpoint.
  `api-fixture.ts:124` forwards replay to `api-runtime.ts:808` (`app.handle`), retaining original bytes and bearer.
  Production bulk authorizes Global first (`services/kernel/src/semantic/http/bulk.ts:166`) and binds create/propose
  authorization plus fence enforcement for each command (line 275). Identity revocation itself uses public grant
  commands (`identity-fixture.ts:581`), retaining the original token (`specs/imports-identity.test.ts:201`).
- **unverified — complete seven-scope VNDB identity integration.**
  CLI selects `VNDB_IMPORTER_SCOPES` (`services/importer/src/cli.ts:540`), but the real identity/API fixture registers
  only the six base scopes and no statistic grant. CLI credential tests do not substitute for real seven-scope issuance.

## Public API outcome chain

- **proved-by-current-code-and-tests — real subject effects use public bulk.**
  `services/importer/src/import-contract.ts:21` is a transport port, not database authority.
  `import-client.ts:254` constructs `@rezics/client`; line 282 calls `subjects.$batchWrite.post` and validates ordered
  result keys. `services/kernel/test/imports/api-runtime.ts:588` wires that transport into the production importer;
  line 504 calls the complete `createKernel` application, composed at line 290 with real Access and write admission.
  No kernel write SQL is injected on this outcome path. `api-runtime.ts:386` independently reads exact native receipt
  keys. `specs/imports-api.test.ts:279` compares those receipts with each returned command result.
- **proved-by-current-code-and-tests — fixture inputs for all four sources reach actual calls and storage.**
  `specs/imports-api.test.ts:72` reads native synthetic fixtures; `api-runtime.ts:640` uses `readDump` or
  `VndbTablesStore`, then actual `runRecords` and `createSourceRegistration` (line 682).
  `specs/imports-api.test.ts:291` requires successful captured bulk POSTs, bounded bodies, receipts, public subjects,
  source-bearing proposals, references and native effect deltas. Source-specific cases are at lines 371, 380, 436, 440.
  `services/kernel/test/imports/api-observer.ts:95` reads public subjects/candidate pages/revisions; native SQL discovers
  property keys but does not synthesize proposal bodies. Lines 180–217 count persisted subjects/revisions for IDs
  discovered through successful captures. This is bounded fixture observation, not a global database absence proof.
  Public proposal assertions retain source/external ID, converter revision, digest and native record revisions
  (`specs/imports-api.test.ts:330`); facts carry no fabricated copyright terms (line 341).
- **proved-by-current-code-and-tests — user posts are excluded from imported content.**
  `specs/imports-api.test.ts:930` injects hostile posts/comments into the real Bangumi dump path, runs the importer,
  and checks their sentinel is absent from the public stored view while the legitimate summary remains (line 944).
- **unverified — VNDB archive and statistic completion in the real API assembly.**
  The “COPY dump” case supplies `COPY TO STDOUT` table/header entry streams at `specs/imports-api.test.ts:82`, not a tar
  byte stream; the old inline SQL fixture is deliberately rejected at line 386. This does not prove CLI archive decoding
  plus live API in one execution. The injected `vn` rows have zero vote counts (line 86), so no statistic is emitted.
  The real API runtime omits `writeSourceStatistic` (`api-runtime.ts:588`); a statistic-bearing record reaches
  `services/importer/src/importer.ts:589` and throws `Source statistic transport is unavailable` at line 592.
  Small deterministic failing-test sketch: retain those valid table headers, set `c_average=735`, `c_votecount=20`,
  retain the registration's pinned dump date, and expect a complete run with a persisted VNDB statistic.
  Actual fixture composition lacks both writer and authority. Smallest evidence owner: API/identity fixtures under
  `services/kernel/test/imports/`; this is missing integration evidence, not a claim that the production CLI lacks PUT.
- **proved-by-current-code-and-tests — identical reimport has no new measured effect.**
  `specs/imports-api.test.ts:448` loops all four sources, restarts the SQLite-backed importer, requires equal effect
  totals, equal baseline and stored public view, and repeats with only the fixture label changed.
  Restart really reopens state (`api-runtime.ts:798`); baseline is read from RunStore (`api-fixture.ts:96`).
- **proved-by-current-code-and-tests — changed record/revision creates a new proposal without overwriting adoption.**
  `specs/imports-api.test.ts:467` changes Open Library title/revision; lines 490–529 require a distinct candidate,
  old retraction, changed digest/native revision, stable subject, retained community adoption and exact proposal deltas.
  Adoption uses ordinary public proposal/accept/adopt calls (`api-observer.ts:294`), not seeded editorial rows.
  Limit: mutation/reconversion integration is Open Library, not an independent changed-record case for every source.
- **proved-by-current-code-and-tests — disappearance halts before effect/checkpoint.**
  `specs/imports-api.test.ts:531` imports five Bangumi records and a VNDB baseline, then supplies three changed records;
  it requires mass-disappearance, no exchanges, equal effects/baselines and unchanged stored evidence.
  Line 590 covers loss of a one-record baseline; line 549 distinguishes allowed 20% removal from deletion of subjects.
- **proved-by-current-code-and-tests — fenced fields stay hidden on refresh and late fencing.**
  `specs/imports-api.test.ts:601` covers unchanged/changed/restart/reconversion summary refresh; line 655 inserts a
  real takedown after preflight. Lines 675–719 require restricted fence reads, immediate 404 disclosure, no added cover
  POSTs/jobs after unchanged or replacement-URL refresh, and still-visible adjacent fields.
  `api-observer.ts:345` calls real media and tuple-fence routes; production bulk rechecks fences before command effects
  (`semantic/http/bulk.ts:295`). The contract explicitly promises final hiding, not physical exclusion across partitions
  (`specs/imports-api-driver.ts:63`). No atomic cross-partition guarantee is inferred.

## Media ownership, rights and serving

- **proved-by-current-code-and-tests — public URL import/status, platform mechanical jobs.**
  `services/importer/src/media-resolver.ts:170` checks the cover fence, durably prepares exact bytes, sends at most one
  POST and one status GET per asset/invocation (lines 189–209), and returns IDs only for available media (line 214).
  `import-client.ts:391` and line 424 use public media methods. The API fixture drains real registered work before
  that GET (`api-runtime.ts:611`), an explicit test scheduler intervention rather than importer-owned image processing.
  `media-boundary-driver.ts:926` composes `KERNEL_WORK_MODULES`; line 1021 enqueues actual committed envelopes and awaits
  DBOS workflow results. `services/kernel/src/content/media-import-job.ts:89` accepts only a media ID, reads persisted
  work/fence and invokes the production source fetch (line 172); it takes no restored importer credential.
- **proved-by-current-code-and-tests — cover credit/licence separate from metadata and no source hotlink.**
  `specs/imports-api.test.ts:199` asserts reserved/uploaded/available, cover purpose, rights-holder credit, linked
  Bangumi provenance and `LicenseRef-unknown`, independently of summary CC-BY-SA-3.0 obligations at line 189.
  `api-fixture.ts:29` reads native media/variants and reauthenticates the captured public bearer. The dedicated media
  suite asserts native original and actual Sharp derivative hashes, no credentials to source and no live internet
  (`specs/imports-media-boundary.test.ts:59`); lines 112–134 check stored credit, authorized derivative delivery and
  absence of `sourceUrl` in status. Bangumi summary storage is independently compared with semantic transaction xmin
  (`api-observer.ts:220`), not merely a converter assertion.
- **proved-by-current-code-and-tests — bounded source fetch, real failures and deduplication.**
  `specs/imports-media-boundary.test.ts:137` redelivers native events and checks unchanged state/workflow identity;
  lines 190–257 assert rejected states/no variants for redirect, private-IP, byte, deadline, pixel and format faults,
  plus recoverable storage failure/cancellation. Production checks live in
  `services/kernel/src/content/fetch-source-image.ts:62` and `services/kernel/src/content/image-job.ts:79`.
  Limits: external HTTP/DNS responses and R2 service are deterministic fixtures (`media-boundary.ts:214`), with
  generated encoded PNGs (line 234) and in-memory objects behind the production R2 adapter. They do not prove live
  CDN/R2 deployment, website media-route headers, or a full VNDB-cover import. The no-hotlink assertion checks an
  authorized derivative read; it is not an end-to-end browser/website serving test.

## Rate limits, retries, typed client and CLI

- **proved-by-current-code-and-tests — public command-weighted rate limiting and Retry-After.**
  Bulk declares write units=`commands` (`services/kernel/src/semantic/http/bulk.ts:158`);
  `services/kernel/src/http/rate-limit.ts:29` charges the batch once. Real fixture governance sets service tier
  (`api-runtime.ts:335`). `specs/imports-api.test.ts:765` installs a small real limiter budget, observes 429/no receipt
  or ACK, then requires exact request replay no earlier than Retry-After and 17 unique committed subjects.
  Its `nowMs` is deliberately ignored; windows and waits are real (`specs/imports-api-driver.ts:268`).
- **proved-by-current-code-and-tests — finite logical-write retry budget and retained refusal/deadline.**
  `services/importer/src/import-fetch.ts:295` bounds attempts, body, response, waits and deadline; lines 383–448 allow
  one 401 renewal, parse overload hints and retain a not-before/deadline/refusal. `importer.ts:323` counts at most eight
  transport invocations per logical write; width recovery never refills that counter. Refused waits cannot requeue.
  `services/importer/tests/logical-write-budget.test.ts:48` asserts eight calls/sixteen sends despite neighboring
  successes and durable unresolved bytes; line 77 checks explicit resume. `retry-after-layering.test.ts:15` checks
  429/503 seconds/date hints across both layers, and line 116 terminal refusal during deferred cover work. These invoke production coordinator,
  client and fetch through `tests/pipeline-driver.ts:446`; HTTP overloads/media effects are simulated there.
  Thus aggregate accounting has executable local evidence, not full real-API overload/recovery evidence.
  The bound is per logical write: at most `8*(A+1)` sends, A≤5, not a lifetime bound across dumps/operator resumes.
- **proved-by-current-code-and-tests — current client/CLI wiring; unverified — live combined deployment.**
  `packages/client/README.md:15` assigns session propagation to the generated client; importer construction forwards
  session options (`import-client.ts:272`). CLI reads an owner-only JWK, signs ES256 assertions, renews memory-only
  bearer and calls normal Auth (`credentials.ts:59`, line 120, line 232). CLI wires actual batch, statistic PUT, fence
  and media ports (`cli.ts:606`, line 620), not database writes to kernel modules.
  CLI wrappers execute the portable suites and reject skip/todo (`services/importer/tests/cli-outcomes.test.ts:5`,
  `cli-credentials-outcomes.test.ts:5`), but their Auth/API responders are simulated (`cli-driver.ts:279`,
  `cli-credentials-driver.ts:109`). `source-statistics.test.ts:118` checks actual client URL/body/key with a fake response.
  The statistic client uses a local type cast (`import-client.ts:300`), so that route is not itself full generated-type
  evidence. No current typecheck or complete real-Auth/real-API CLI invocation was executed here.

## Integrated growth binding and execution limits

- **proved-by-current-code-and-tests — measured work uses current public API, not warmed outcomes.**
  `api-fixture.ts:169` warms only a spare fence read before capture; `api-runtime.ts:744` specifies no ledger/receipt
  or checkpoint effect. `api-warmup.test.ts:18` captures fresh tuples, requires actual SQL and no repeat catalogue
  probes, and retains ordinary/anonymous denial. `api-capture.ts:28` captures both application/Auth databases and
  SQLite executions/iteration (line 245); this is not a static query-count estimate.
  Growth uses the same runtime (`growth-fixture.ts:537`), a separate real spare bootstrap (line 549), and separate
  scenario source aliases restored before measurement (line 1164). Measurement starts new capture/event slices at
  line 1291. Normal new/changed/revision operations call production `runRecords` (line 1145); private-plan, bulk and
  vanished-page scenarios use specialized fixture operations (line 1114), not the entire native dump/CLI chain.
- **unverified — cold startup, default-budget throughput and current passing growth/root results.**
  Growth starts with a large service budget (`growth-fixture.ts:541`), while outcome rate tests deliberately configure
  another budget. Runtime also serializes bulk sends and admits at most eight HTTP requests (`api-runtime.ts:413`,
  line 458). Spare/scenario warmups exclude their own effects from measurement; they do not prove cold-start latency
  or normal production concurrency. Media growth directly admits selected workflows after quieting queues
  (`media-boundary-driver.ts:1026`), so it does not prove scheduler-wide throughput under unrelated queue load.
  No passing check artifact is asserted. Known central check-host saturation is infrastructure context, not a new
  product defect or reason to alter these assertions; no diagnosis or product workaround is proposed here.

Read inventory: the complete supplied manager brief; owning importer, Auth, client, semantic authorization/cost and
content covers/fences README sections; the six requested importer modules; API/identity/media drivers, fixtures,
runtime, observers and wrappers cited above; their portable specs/direct contracts; CLI, source-statistic and retry
drivers/assertions; current growth binding/capture/warmup code; fixture README; scope and existing backpressure review.
The read-only reference index was inspected; no external implementation was used to design a new surface.
Only this report is changed. Remaining limits are evidence gaps and authority wording drift, not new product policy.
