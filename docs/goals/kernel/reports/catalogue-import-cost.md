# Pinned catalogue import cost

Measured on 2026-10-12 at source revision `2445c3ebaed4c3e0eb7e5c10d3860081be3930fd`. Both recipe extracts completed. Bangumi manga and game completed their bounded source retention and native Work mapping; anime retained every source record but its first native episode batch was refused. **There is no measured full anime import rate.**

## Method and limits

The throwaway measurement used `bun scripts/goal/goalctl.ts test tests/qa/integration/catalogue-import-measurement.test.ts` on isolated QA storage. The temporary registered wrapper loaded `.temp/catalogue-import-cost.test.ts`; neither is committed. Main was the existing `startMediaStack` composition, with real Access/Content PostgreSQL, Fuseki and immutable object storage, and the fixture's verified bearer-to-principal Account substitute. Requests entered `stack.main.handle` with the same public API bodies, idempotency keys and routes as product imports. This measures API execution and importer work without a TCP hop to Main or production Account introspection. No catalogue data was written directly to owner stores, and no importer, route or schema was changed. Fixture authority setup used existing fixture helpers.

Recipes used the verified `readLockedFixture` Gutenberg seeds and line boundaries in [recipe-extract-pins.json](../../../../tests/fixtures/gutenberg/recipe-extract-pins.json). Each nonblank ingredient line was one ingredient; each complete method extract was one instruction string, with the edition's `en` or `it` language. Each recipe used one catalogue Work import, one composition creation and one local-file import. The last route invokes the existing [recipe importer](../../../../services/main/src/modules/recipe/importer.ts) through [the product file-import API](../../../../services/main/src/routes/recipes.ts). Whole-import time includes those commands, extract conversion and measurement checkpoint writes; it excludes stack startup, fixture identity setup and per-Work authority grants (Boston 0.203 s; Artusi 0.083 s).

Bangumi used the pinned `l21-2026-10-06` seed in [fixtures.lock.json](../../../../tests/fixtures/fixtures.lock.json): archive SHA-256 `2f4273f1aa5d6932c8aa2c448f91771fe0d07ec69c1ef64b4c5098f0760f8d99`, normalized extract SHA-256 `7102695a8c071619d0a9aa7254abac56d0fa394a2322d73b0ee6e463b1eb56d1`. The measurement constructed one frozen snapshot per pin using the existing subject/episode row mapping, `bangumiMappedData`, and episode edges from [the acquisition adapter](../../../../scripts/datasets/bangumi.ts), then called the unchanged [product dataset importer](../../../../scripts/datasets/import.ts). The seed does not contain the full related-subject catalogue. Every exact direct-relation row and the game's three platform names were retained in the existing scope-manifest intake; no endpoint subject or platform concept was fabricated. These snapshots elect subject/episode records and retain relation evidence: they are **not relationship-closed catalogue imports**. No native Work-to-Work relationship, platform classification or recipe section hierarchy is claimed by this measurement. Provider acquisition, remote downloads and snapshot assembly are outside the Bangumi import clock; local importer journaling and URL-index generation are inside it.

Per-command latency starts before invoking Main and ends after consuming the JSON response. Existing [request/work-profile meters](../../../../tests/qa/support/work-profile.ts) collect sampled request traces after the whole-import clock stops, with PostgreSQL loaded after telemetry initialization. Every issued command has SQL-statement and Fuseki-call counts; no count is substituted with zero because of missing telemetry. Counts cover the request's traced descendants and exclude attributed background work. SQL plan rows, buffers and WAL, native Jena operators, untraced background work and Fuseki engine time are unavailable. The Account substitute contributes no external Account calls or Account SQL. A Fuseki call is an observed HTTP round trip, including queries and writes, not just a graph query.

Tables show SQL and Fuseki counts as **median / total** within each operation class. Command totals sum individual request latencies; the dataset importer runs source intakes in cohorts of four, so these totals can exceed whole-import wall time. Entity counts name application identities, excluding immutable revisions, receipts, pages and other implementation artifacts. Rates count recipes for Gutenberg and subject/episode DatasetRecords for Bangumi; relation rows, platform names and retained manifest chunks do not increase that denominator. All are single observations on this host, with no cold-cache or quiet-host capacity claim.

## Boston cookbook — pg65061

| Item or API operation | Count | Whole wall / command total (s) | Command median (ms) | SQL median / total | Fuseki median / total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Source | 20 recipes; 111 ingredient lines | — | — | — | — |
| Entities created | 20 Works; 20 Main Versions; 20 Structures; 131 occurrences (111 ingredients + 20 steps); 20 source records; 20 observations | — | — | — | — |
| Complete import | 60 commands; **76.44 recipes/min** | **15.699** | — | — | — |
| POST /v1/work-imports/bulk | 20 (one Work each) | 4.245 | 179.128 | 41 / 1,381 | 5 / 356 |
| POST /v1/compositions | 20 | 3.912 | 195.731 | 91 / 1,820 | 7 / 140 |
| POST /v1/recipes/:id/file-imports | 20 | 7.532 | 362.747 | 202 / 4,139 | 12 / 240 |

The first Work import observed 602 SQL statements and 261 Fuseki calls, versus 41 and 5 for every later Boston Work import. The cause of that first-request overhead was not separately measured; it remains included in the totals and wall time. File imports accounted for 48.0% of summed command latency. All Work-bulk responses reported a succeeded item and complete batch; all composition and file-import responses were HTTP 201.

## Artusi — pg59047

| Item or API operation | Count | Whole wall / command total (s) | Command median (ms) | SQL median / total | Fuseki median / total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Source | 10 recipes; 62 ingredient lines | — | — | — | — |
| Entities created | 10 Works; 10 Main Versions; 10 Structures; 72 occurrences (62 ingredients + 10 steps); 10 source records; 10 observations | — | — | — | — |
| Complete import | 30 commands; **92.53 recipes/min** | **6.484** | — | — | — |
| POST /v1/work-imports/bulk | 10 (one Work each) | 1.306 | 109.878 | 41 / 410 | 5 / 50 |
| POST /v1/compositions | 10 | 1.557 | 146.016 | 91 / 910 | 7 / 70 |
| POST /v1/recipes/:id/file-imports | 10 | 3.617 | 314.036 | 211 / 2,128 | 12 / 120 |

Artusi followed Boston in the same stack. File imports accounted for 55.8% of summed command latency. All Work-bulk responses reported a succeeded item and complete batch; all composition and file-import responses were HTTP 201.

## Bangumi anime — subject 975

| Item or API operation | Count | Whole wall / command total (s) | Command median (ms) | SQL median / total | Fuseki median / total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Source | 1,192 records: 1 subject + 1,191 episodes; 410 relation rows | — | — | — | — |
| Entities created before refusal | 1 Work; 1 Main Version; 1,196 source records; 1,196 observations; **0 native episode resources** | — | — | — | — |
| **Aborted import** | 1,199 commands; full-import rate **unavailable** | **16.309 to refusal** | — | — | — |
| POST /v1/catalogue/candidates | 1 | 0.318 | 317.538 | 104 / 104 | 54 / 54 |
| POST /v1/sources/intakes | 1,196 | 57.177 | 45.011 | 38 / 45,750 | 0 / 0 |
| POST /v1/work-imports/bulk | 1 (one Work) | 0.265 | 265.058 | 41 / 41 | 5 / 5 |
| POST /v1/semantic/changes/bulk | 1 refused batch of 16 episodes | 0.057 | 56.790 | 31 / 31 | 3 / 3 |

All 1,192 normalized records were retained, plus four chunks of the scope manifest containing all 410 relations. The first native episode batch returned HTTP 422 with code `unavailable_reference`; no episode batch succeeded. The API response does not identify the refused reference. Its cause is unresolved here; no bypass or owner fix was attempted. Source intake dominates the attempted run's summed command work, but this is not evidence of what dominates a completed anime import.

## Bangumi manga — subject 3510

| Item or API operation | Count | Whole wall / command total (s) | Command median (ms) | SQL median / total | Fuseki median / total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Source | 1 subject record; 349 relation rows, including 234 volume relations | — | — | — | — |
| Entities created | 1 Work; 1 Main Version; 2 source records; 2 observations; 0 native relationship resources | — | — | — | — |
| Complete bounded import | 4 commands; **157.62 subject records/min** | **0.381** | — | — | — |
| POST /v1/catalogue/candidates | 1 | 0.156 | 156.340 | 10 / 10 | 9 / 9 |
| POST /v1/sources/intakes | 2 (subject + scope manifest) | 0.078 | 39.188 | 39 / 78 | 0 / 0 |
| POST /v1/work-imports/bulk | 1 (one Work) | 0.137 | 137.330 | 41 / 41 | 5 / 5 |

Every relation row was retained in the scope manifest; the 234 related volumes were not imported as native Works because their subject records are outside this snapshot. Catalogue candidate lookup was the largest measured command class (42.0% of summed command latency).

## Bangumi game — subject 249311

| Item or API operation | Count | Whole wall / command total (s) | Command median (ms) | SQL median / total | Fuseki median / total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Source | 1 subject record; 4 relation rows; 3 platform names | — | — | — | — |
| Entities created | 1 Work; 1 Main Version; 2 source records; 2 observations; 0 native relationship or platform resources | — | — | — | — |
| Complete bounded import | 4 commands; **158.52 subject records/min** | **0.378** | — | — | — |
| POST /v1/catalogue/candidates | 1 | 0.095 | 94.765 | 10 / 10 | 9 / 9 |
| POST /v1/sources/intakes | 2 (subject + scope manifest) | 0.075 | 37.493 | 39 / 78 | 0 / 0 |
| POST /v1/work-imports/bulk | 1 (one Work) | 0.203 | 203.197 | 41 / 41 | 5 / 5 |

Relations and platform names were retained as evidence, with no native platform classification asserted. Work import was the largest measured command class (54.5% of summed command latency).

## Arithmetic extrapolation

If each measured completed rate holds, `records × measured wall time / measured source records` gives Boston **13.08 min for 1,000 recipes and 21.80 h for 100,000**, Artusi **10.81 min and 18.01 h**, bounded Bangumi manga **6.34 min and 10.57 h**, and bounded Bangumi game **6.31 min and 10.51 h**. These are arithmetic extrapolations, not measurements at those catalogue sizes; the manga/game estimates each come from one subject and retain its relation evidence without importing related Works, and neither estimates the cost of 1,000 or 100,000 episodes or relationship-closed subjects. Recipe file import dominates both completed recipe sets; candidate lookup dominates manga and Work import dominates game. Anime has no full-import extrapolation because its native episode import was refused; source intake dominates only its measured aborted attempt.

## QA and retained evidence

- QA `20261012t000738-7fead1`: runner rejected `.temp` as an unregistered integration path before any import or stack started.
- QA `20261012t000802-d7a4de`, project `20261012t000802-d7a4de-1`: recipe imports completed once; test then failed at the anime episode refusal. This first fixture had the Work grants but omitted the semantic-create administrator grants. Its aborted anime attempt took 20.413 s and is not used as the qualified anime measurement above.
- QA `20261012t001027-fb530e`, project `20261012t001027-fb530e-1`: Bangumi-only measurement with all five `DATASET_ADMIN_GRANTS` from [the existing administrator bootstrap](../../../../scripts/datasets/bootstrap.ts). Anime failed again with the same 422; manga and game completed. The measurement test passed because it recorded each attempted outcome and continued after the refusal; this **does not certify a completed anime import**. Recipes were not rerun. The two Bangumi attempts used separate isolated QA epochs, not a replay presented as a fresh import.
- Raw command measurements and set summaries remain in `.temp/catalogue-import-measurement/evidence.json` (SHA-256 `1aab525a92d31ad7261242502891a135e33eb69268dcf526da7ec4c056551004`) and `.temp/catalogue-import-bangumi-measurement/evidence.json` (SHA-256 `acc69839fb00c599583e4d18592fe3346c06dc7dd3efe6e3feb2c5d4ad438799`), relative to the measurement worktree. Bangumi's per-request journals there retain API receipts and exact source chunks. These are temporary local artifacts, not committed report dependencies.

Every requested pin was available offline and attempted. No request timed out. Full native anime import and full related-subject/volume/platform projection were not measured for the reasons above. The next useful measurement requires resolving the episode-reference refusal through the existing owners, then measuring that completed path; this report does not propose or implement that fix.
