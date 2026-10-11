# Structure and discovery regression: causes and implementation slices

Read-only analysis on 2026-10-11 at `de4e7447c2541b8e48d7fe9689feecc794cc773b`.
Only this report is committed. No product source, test, generated artifact or
native image was changed. Each numbered implementation item is one proposed
Luna/max session; session fit is an estimate. Dispatch separately with the listed
files as claims. Paths and lines refer to this worktree at that commit.

The reported reds are several independent fixture/QA contract failures, not one
demonstrated Structure reader regression. The recipe qualifier target defect was
already repaired by `99191370740b75647d39cf5fd569825c61ccae4f`; retain that repair.
No evidence here supports reverting profile registration or composition cost work.

## Evidence and reproduction

The cited run-9 artifacts are absent from this worktree. Original artifacts in the
main checkout were consulted read-only; all source inspection and new QA commands
used this worktree. Original run root is
`.temp/goal-orchestration/regress/20261010t200744-9ae88e/` relative to the main
checkout. Its manifest records source `7c190de0c49d5c505498543036caadd18a37bdf7`.
The relevant QA subdirectories, relative to that run root, are:

| File | Original batch | QA subdirectory |
| --- | --- | --- |
| `structure-composition.test.ts` | integration-128 | `qa/integration-128/attempt-1/20261010t234029-f38560/` |
| `discovery-read-isolation.test.ts` | integration-35 | `qa/integration-35/attempt-1/20261010t210705-9fc48e/` |
| `fresh-install.test.ts` | integration-44 | `qa/integration-44/attempt-1/20261010t212148-363548/` |
| `access-download-api.test.ts` | integration-17 | `qa/integration-17/attempt-1/20261010t205045-40c2ec/` |

Read `logs/integration-1.log`, the applicable `integration-r*.log` retries and
JUnit, rather than treating the failure-cluster label as the failure itself.
Original composition initial/retry both reach the first progress PUT and fail
200/401. Original access initial/retry reach the outsider bytes GET and fail
403/404. Original fresh-install initial/retry reach the second release install
and fail JSON parsing. Original discovery's first run has COPY 400 and empty Agent
names; its isolated retry has raw-update 404 before those assertions. Its other
three failures are credits 503, a request through the Context fixture returning 409, and OPS01 parsing.

The summary's claim that IAM07 and fresh-install failed with "Shard stack failed
before tests ran" is not established by these corresponding logs: both ran their
test bodies. No native stack startup exception or causative native commit can be
named from this evidence. The inventory's provenance needs reconciliation; do not
dispatch a speculative image/startup repair from that label.

All new invocations use `bun scripts/goal/goalctl.ts test`. Standalone commands
select one file under `tests/qa/integration/`; logs are
`.temp/goal/structure-alone.log`, `discovery-alone.log`,
`fresh-install-alone.log`, and `access-download-alone.log`. Ordered commands set
`REZICS_QA_SHARDS=1` and select the original batch's five files:

- Structure: `structure-book-content`, `structure-book-embeds`,
  `structure-book-volumes`, `structure-bootstrap`, `structure-composition`.
- Discovery: `discovery-read-isolation`, `discovery-refresh-retirement`,
  `discovery-refresh`, `editorial-timeline`, `entity-page-structure`.
- Install: `fresh-install`, `g-1001-work-cards`, `g-1003-address-navigation`,
  `g-1005-open-space-join`, `g-1007-follow-provenance`.
- Download: `access-authority-concurrency`, `access-avatar`,
  `access-baseline-seed`, `access-baseline`, `access-download-api`.

Each basename above ends `.test.ts`. These are reproductions through the
existing scheduler, not a new order executor. It sorts paths and respects
isolation batches; CLI argument order does not guarantee one database or five
files executing in that order. In particular Structure volumes runs separately,
and the discovery wrapper itself imports ten predecessor files in one Bun
process. Its selected *shard* also chooses the assembler, so raw capability
present in a neighbour changes the wrapper's failure from 404 to 400.

| Local probe | QA run | Test-body result / limit |
| --- | --- | --- |
| Structure alone | `20261011t083618-10524b` | FAIL: first progress PUT at 119, expected 200/actual 401; 36 assertions. |
| Structure original group | `20261011t084343-99ec36` | All five files executed. Shared batch: four tests passed, composition failed at 119 with 401; volumes isolated batch: two passed. Automatic retry was canceled while queued; exit 1, no finalized aggregate summary. |
| Discovery alone | `20261011t083606-a226cb` | FAIL: 21 passed/7 failed. Credits 503, export/raw 404, VNDB 409, install parse, projection/raw 404, and G1001/G1011 raw 404. |
| Discovery original group | `20261011t084057-c3c87a` | PARTIAL: after 498215 ms admission wait, retirement/editorial/entity-page batch passed four tests/88 assertions. Wrapper began but was canceled before completed XML; refresh was not completed. Current isolation did not reproduce the original shared wrapper order. Exit 1; no final aggregate report. |
| Install alone | `20261011t083617-1f7e6a` | FAIL: second-install JSON parse at 54 after nine assertions. |
| Install original group | `20261011t083939-0b5394` | Canceled after 8m02s waiting for an ordinary QA slot; no test bodies, exit 143. |
| Download alone | `20261011t083716-67b857` | Canceled after 10m25s waiting for an ordinary QA slot; no test bodies, exit 143. |
| Download original group | `20261011t084818-ec514a` | Bounded 60-second admission attempt exited 1 before tests: “Memory admission deadline reached waiting for another QA startup … no work started”. This imposed deadline establishes admission contention, not a product/native startup failure. |

Console logs for ordered probes are `.temp/goal/structure-order.log`,
`discovery-ordered.log`, `fresh-install-shard-order.log` and
`access-download-shard-order.log`. The initial automatic artifact directory was
moved, after the probes stopped, from `.artifacts/qa/` to
`.temp/goal/qa-initial/`; completed standalone JUnit/logs and the bounded download
startup log are there under their run IDs. Structure/discovery ordered JUnit and
logs are under `.temp/goal/qa/<run-id>/`. These artifacts are temporary and are
not committed. All runner processes created by this investigation were stopped.

Repeated `QA_STARTUP_SLOT_READY` messages during these waits are not repeated
native failures. `scripts/qa/cli.ts:210–230` retries when no lifetime QA slot is
available; the memory-admission gate then measures again. Shared host slots were
occupied by other workers. The completed standalone manifests record stable
source at the analyzed HEAD. Original ordered logs remain the only completed
ordered evidence for install/download and the discovery wrapper.

No post-fix green result is claimed: the brief forbids implementation. Sections
below identify the exact demonstrated obstruction and the proof required after
repair; a complete acceptance ID can have other registered tests.

## 1. A — Give composition progress fixtures their explicit library consent

**Cause in one line:** `8f506bb9cb61124ee2ca85cd6e8ae041802c23f5` added
`library:write` to progress PUT consent, while the composition fixture still
creates a token without it.

**Reason for A:** the integration fixture is incomplete for the operation it
asserts succeeds. The product denial is correct.

**Files and exact change:** `tests/qa/integration/structure-composition.test.ts:26–28`
passes `'openid work:create work:edit work:read library:write'` as the third
argument to `authorCreditFixture`. Make the same opt-in in the sibling
`tests/qa/integration/structure-relay.test.ts:23–24`, whose progress PUT at 94–107
uses the same default token. Do not widen the shared fixture's default scopes at
`tests/qa/fixtures/author-credit.ts:65`, or weaken
`services/main/src/routes/progress.ts:86`.

**Proof:** existing `tests/qa/integration/structure-composition.test.ts` alone and
its five-file shard, and `tests/qa/integration/structure-relay.test.ts`. Preserve
all later replay, stale, private-reader, move, seal, tombstone, concurrent and
dense-change assertions. Existing `services/main/tests/library-write-scope.test.ts`
and `tests/qa/integration/library-write-scope.test.ts` must still deny missing
consent. No new test file is needed. The relay sibling is statically established,
not reproduced here. Later composition assertions were not reached in this run.

**Acceptance:** removes the demonstrated failure shared by BOOK02, COMP01,
COMP02, COMP05 and COMP06. **Mechanisms: none. Native image build: no.**

## 2. A — Preserve process stdout separately from diagnostics

**Cause in one line:** `9da106b1ba49676e8bafd96674988cb826981b76` made the
release test consume the QA wrapper's combined stdout/stderr as JSON.

**Reason for A:** the process capture adapter loses stream identity; a successful
second install cannot be parsed when diagnostics contaminate its machine output.

**Files and exact change:**

- `scripts/qa/core.ts:495–637`, `commandAsync`: it already independently
  collects and redacts stdout and stderr. Return those two strings alongside
  existing combined `output`, without changing timeout, redaction, admission
  observation, streaming, process-group cleanup or status semantics.
- `scripts/qa/stack-startup.ts:48–56,66–81`: both child wrappers expose those
  real streams; remove aliases `stdout: result.output, stderr: ''`. Continue
  computing admission waits from combined output.
- `tests/qa/integration/fresh-install.test.ts:21–25`: successful
  `release()` returns admission-marker-filtered `result.stdout`; errors still
  include bounded `result.output`. Keep the existing install JSON assertions.

The original standalone error identifies an unexpected ESC in parsed text; the
current run fails at the same second-install parse. Better Auth emits warnings
via stderr during owner migration, and combined capture supplies them to the
parser. The test does not retain the full install payload: the precise warning
responsible for each parse is not captured. Stream mixing is established by the
adapter and original ESC failure; the exact current producer payload is not. If
separation does not remove the current failure, capture bounded stdout/stderr
from that second install before selecting another repair. No assertion that
installation itself failed follows from this parse failure.

**Proof:** extend existing `tests/qa/unit/stack-startup-parent.test.ts` using its
fake child fixture: JSON only on stdout, ANSI warning only on stderr, admission
events, and split secret fragments across writes. Assert JSON stdout remains
parseable, warning remains on stderr, combined output keeps diagnostics, and both
streams stay redacted. Exercise both wrappers. Keep its timeout and admission
cases and `tests/qa/unit/qa-harness.test.ts`. Then run existing
`tests/qa/integration/fresh-install.test.ts` and its five-file shard unchanged.
No new test file. Run `task scripts:typecheck` for the changed return shape.

**Acceptance:** OPS01, including its imported discovery-wrapper case, subject to
the rest of that wrapper's repairs. **Mechanisms: none. Native image build: no.**
The integration test rebuilds its release artifact as part of its existing proof.

## 3. A — Declare the existing wrapper's raw fixture capability at the assembler owner

**Cause in one line:** `b0d16613696699272db4b8dcb42b24855e194cd3` selected the
exclusive assembler from direct filenames, but the existing discovery wrapper's
raw-writing imports were absent from that declaration.

**Reason for A:** one existing assembler owner has an incomplete capability
declaration for a composite test; an isolated wrapper cannot execute its fixtures.

**Files and exact change:** append the existing
`tests/qa/integration/discovery-read-isolation.test.ts` to
`scripts/qa/isolated-integration-files.ts:196+`'s
`rawSparqlIntegrationFiles`, with a reason identifying the already-declared
`export-api`, `discovery-projection`, and `g-1001-work-cards` imports.
`scripts/qa/stack-environment.ts:70–71` remains the sole assembler decision.
Do not add another registry, scanner or product raw endpoint.

Correct `scripts/qa/raw-sparql-integration-files.test.ts:5–123`'s ceiling for
this pre-existing composite capability, with a focused assertion covering those
actual wrapper imports. Preserve the only-shrink prohibition for new raw-writing
files; this is not permission to move new product tests off the command API.
Add new `scripts/qa/stack-environment.test.ts` asserting the wrapper chooses the
fixture assembler, ordinary command tests keep the exclusive assembler, and
persistent raw overrides still deny exclusivity.

**Proof:** those two planner/guard files; wrapper alone and original five-file
shard. Export's real sealed-owner fixture at
`tests/qa/integration/export-api.test.ts:390` must reach its retained-position
assertions in both modes. This removes endpoint 404, and exposes the separate
COPY failure in item 4. Raw mutation still invalidates dataset preparation proofs;
do not falsely mark them complete during this correction.

**Acceptance:** removes the demonstrated endpoint blocker for COMP08, LIVE07,
LIVE10, LIVE17, and the discovery/card subcases. Wrapper green also requires
items 2,4–6 and resolution of item8. **Mechanisms: none. Native image build: no.**

## 4. A — Snapshot discovery fixtures using supported named-graph updates

**Cause in one line:** `fa84c68a2ee7a1c16a28054e35f55fa0bd18d7e1` restricted raw maintenance operations to
mutations whose invalidations can be certified; the discovery fixture still uses
unsupported COPY/ADD graph management.

**Reason for A:** `isolateDiscoveryProbeGraph` cannot perform its declared
save-and-restore operation through the existing native maintenance contract.

**Files and exact change:** `tests/qa/integration/discovery-projection-fixture.ts:23–38`:
replace each COPY with
`INSERT { GRAPH <backup> { ?s ?p ?o } } WHERE { GRAPH <original> { ?s ?p ?o } }`;
replace each ADD on restoration with the inverse INSERT/WHERE. Keep the existing
single-named-graph CLEAR/DROP or use explicit named-graph DELETE WHERE for clearing
and backup removal. Restore the original lineage and facts on successful exit and
on a thrown probe. Keep one independent backup namespace per invocation and
preserve URI, literal and blank-node bindings on the server.

The native owner at
`infra/jena/command-module/src/main/java/com/rezics/jena/TemplateIndexService.java:857–899`
already accepts these UpdateModify operations and invalidates proofs atomically.
Do not widen its allowlist or write its proof graphs. The rating-context helper
already uses supported Modify/DROP and needs no COPY repair. Restoring ordinary
graph triples does not restore server preparation proofs; retain fail-closed
behavior, and qualify any later command writer through the existing preparer.

**Proof:** existing `tests/qa/integration/discovery-projection.test.ts` and the
wrapper alone/in its shard after item 3. Extend the already-raw
`tests/qa/integration/discovery-projection.test.ts` with cases proving normal
restoration, restoration after a thrown probe, original lineage,
blank-node/literal facts, backup cleanup and absence of manufactured preparation
proofs. Reuse the existing helper; no new snapshot system or raw test file.

**Acceptance:** the discovery projection subcase needed for wrapper qualification;
does not independently certify the five reported IDs.
**Mechanisms: none. Native image build: no.**

## 5. A — Wire the Template directory into the author-credit fixture

**Cause in one line:** `bc1ae7ab01560e2aa27534c4763120f2ec43eea6` restored Work
credits through the bounded template reader, but `authorCreditFixture` omitted
the index required since `609d56a5fa7e2c3902f91980918c52852d44ea17`.

**Reason for A:** the fixture's dependency assembly is incomplete; product reads
correctly refuse an absent directory. The observed worker error is exactly
`template_directory_is_unavailabl`.

**Files and exact change:** `tests/qa/fixtures/author-credit.ts:69–211,273–315`:
construct one existing `TemplateSeekIndex` from
`services/main/src/modules/query/seek-index.ts`, on the fixture's Access pool
and its actual Fuseki client, before graph commands needing directory updates.
Backfill the current epoch through that owner's existing preparation method and
pass `templateSeek` to `createMainApp`. Preserve the fixture's query-counting
proxy and single native writer attachment. Do not instantiate a competing index
or add a fallback degree scan. At the fixture's close method around 509, stop any
recovery timer before closing the pool if a recovery timer was started; a
deterministic fixture can rely on the command writer and avoid starting one.

**Proof:** existing `tests/qa/integration/credit-source-reported.test.ts`,
`services/main/tests/work-credits-facade.test.ts`, and wrapper alone/in its
shard. Credits must include source-reported named authors before confirmation
and native authors only after each explicit confirmation, while request-cost
assertions remain bounded. Keep
`services/main/src/modules/query/template-read.ts:85–87`'s missing-owner refusal.
No new test file is required. A backfill failure on the raw assembler must be
reported and traced, not bypassed.

**Acceptance:** the imported G-327 credit subcase needed for wrapper green;
other reported IDs are not independently certified by it.
**Mechanisms: none. Native image build: no.**

## 6. B — Supply the existing name-preferences owner to card test apps

**Cause in one line:** `e7c4910b9b4e39fa54129fedb72d6908213b6ded` made Agent
card names follow their preferences owner, but G1001/G1011's hand-assembled apps
do not supply that owner.

**Reason for B:** product opening already has the correct private-name policy;
its auxiliary test apps can be aligned after that opening. This alignment is
nevertheless required before declaring this discovery wrapper green.

**Files and exact change:**
`tests/qa/integration/g-1001-work-cards.test.ts:70–71` and
`tests/qa/integration/g-1011-optional-work-reads.test.ts:60–61` pass
`personPreferences: f.composition.dependencies.personPreferences` with their
existing deliberate account/discovery overrides. Preserve fault injection.
The fixture exposes `composition.dependencies`, not `f.deps`.
`services/main/src/modules/disclosure/name-policy.ts:58` and
`services/main/src/modules/profiles/read.ts:288` remain fail-closed.

**Proof:** those two existing files, then the wrapper's raw-capable shard.
Keep bounded author order and optional credit/rating/cover failures. Exercise a
real preferences change to private and require the name to disappear; keep a
public preference and require the name to remain. Reuse the existing owner,
without a stub that declares everyone visible. No new test file is needed.
The original raw-capable run reaches empty-name assertions; the new isolated
wrapper hits endpoint 404 earlier and does not independently reproduce names.

**Acceptance:** G1001/G1011 discovery subcases needed for wrapper green;
no independent certification of COMP08/LIVE07/LIVE10/LIVE17/OPS01.
**Mechanisms: none. Native image build: no.**

## 7. B — Align IAM07 denial with private-media non-disclosure

**Cause in one line:** `f311c92dee34b044eef9c90427650d31bd495825` made private
media fail visibility before download admission, so an outsider receives 404 while
IAM07 still expects 403.

**Reason for B:** the product has the already-proved non-disclosure behavior;
the old assertion can be aligned after opening. Do not weaken it to expose
whether hidden bytes exist.

**Files and exact change:** `tests/qa/integration/access-download-api.test.ts:32`
expects 404. Immediately assert zero `access.download_read_lease` rows for that
asset before the two owner downloads. Keep the owner lease, bounded streaming,
partial abort, strong-revocation drain, stale recovery fence, completed status
and index assertions unchanged.

Owner trace:
`services/main/src/modules/media/visibility.ts:45–50,122–125` uses current
principal/acting-subject authority for private audience;
`services/main/src/modules/disclosure/assembly.ts:64–72` returns no delivery;
`services/main/src/routes/media.ts:607–612` maps it to 404.
This is a body assertion failure, not established startup failure.

**Proof:** existing `tests/qa/integration/access-download-api.test.ts` alone
and original five-file shard, plus the outsider 404 checks of
`tests/qa/integration/media-visibility.test.ts:95–115,141`.
No new test file. Later IAM07 assertions are not proved by its first denial.

**Acceptance:** IAM07, once the rest of its unchanged body passes.
**Mechanisms: none. Native image build: no.**

## 8. C — Establish the exact VNDB Context refusal before choosing a repair

**Observed outcome:** `tests/qa/integration/export-source-vndb.test.ts:149–261`
returns 409 `target_unavailable` through
`tests/qa/integration/context-fixture.ts:125–128` where 201 is expected. Original shard, original
isolated wrapper and new isolated wrapper all reproduce it. A causative commit
and exact rejected guard were **not established**. The helper-only async stack
does not establish which create/select/record/decide request failed.

**Reason for C:** selecting a product or fixture repair from generic 409 would be
guessing. An unprepared graph, Access terminal cancellation and a stale dependency are
distinguishable hypotheses, not findings. Counting successful assertions,
including the Account fixture's own assertions, points to the first Statement
record at 204–212; this is an inference, not a captured request. Context creation
must not be labelled the proven failure.

One bounded investigation session should run existing
`export-source-vndb.test.ts` alone, then the wrapper. Capture the failed request's
method/path and full bounded problem, its registered Access admission and native
terminal receipt, and the original command result before the generic error
mapping. Compare actual inputs of `services/main/src/modules/context/graph.ts:146–199` and
`services/main/src/modules/context/command.ts:197–242,259–299`, control lineage/restore hold, base/definition
lifecycle guards and actual admission disposition. The Context owner already
makes this decision; add no second policy. Only then dispatch a repair with a
causative commit and paired valid/denied/stale proof. No new implementation/test
file or native build can responsibly be prescribed yet.

**Acceptance:** LIVE07 remains unqualified until this is resolved.
**Mechanisms: none. Native image build: undetermined until the cause is known.**

## 9. C — Reconcile the reported startup failures with their source logs

**Reason for C:** the named original install/download runs reached test bodies;
their startup-failure classification cannot establish a native defect. The new
bounded startup-only result is a deliberately imposed admission timeout. No
causative product commit is established. Repair items 2 and 7 address the actual
original failures; neither is a native startup repair.

Obtain the exact failed attempt ID, source fingerprint, startup log and native
stderr that produced the inventory label, or correct that inventory to the
body failures cited above. Do not change a startup function or rebuild an image
until the producing attempt and exception are identified. This is a provenance
investigation, with no implementation files or new test to prescribe yet.

**Acceptance:** no additional OPS01/IAM07 startup claim is qualified.
**Mechanisms: none. Native image build: undetermined until such a cause exists.**

## Registration sibling audit and completion limits

The fields readers began interpreting in
`6c80125726824b412b0e46d762b500657fe8419f` were checked across
registration, format, graph and disclosure:
`targetDisclosure` (`services/main/src/modules/composition/disclosure-read.ts:54,75`),
`containerRoles` (`services/main/src/modules/structure/read.ts:91,350,378,455`),
`measures` (`services/main/src/modules/structure/read.ts:244`), `completion` (`services/main/src/modules/structure/read.ts:367,471`),
role IRIs (`services/main/src/modules/structure/graph.ts:34–49`), optional targets and selection roles
(`services/main/src/modules/structure/graph.ts:200–239`). Each owner supplies its old policy: Book resource reads,
Work/Collection/section-list Work reads, Recipe measures, Work completion and
section containers. Book's resource disclosure existed before this refactor.
The inverse new-role repair `3b6fa6156` and qualifier/self exclusion
`991913707` are already present. Existing guards are
`services/main/tests/structure-profile-data.test.ts`,
`tests/qa/integration/structure-profile-section-list.test.ts`, and
`services/main/tests/structure-listitem.test.ts`.

**C: further registration/cost repair is deferred**, because early composition
change/read/cost assertions already pass before progress 401 and no discovered
reader sibling explains these failures. Do not infer "all readers are correct"
from this bounded audit. Latent required-target corruption, historical manifests
and other profiles need a falsifying scenario before any additional fix.

All seven implementation slices reuse existing owners; their Mechanisms line is
`none`. None changes authored profiles, migrations or route contracts, so none
requires native image regeneration. Run only each slice's own proofs; manager
regression combines them. The minimum order is 1/2/3/5 independently, then 4 and 6
against the repaired wrapper capability, with 7 independently. Item 8 is a
separate investigation, not an implementation guess. Never claim the whole
discovery wrapper green from one repaired subcase.

No documentation check, typecheck, lint, unit suite, broad tier, dev server or
post-fix test was run for this read-only report; the brief limited checks to
failure reproductions. The original cluster/startup label mismatch is unresolved
evidence provenance, not a named native failure.
