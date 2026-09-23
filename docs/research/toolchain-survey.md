# Mature toolchain survey

Research checked 2026-09-23. This survey identifies mature tools, standards and
services that let REZICS avoid rebuilding solved infrastructure around the selected
Apache Jena architecture. It is a selection input for owner contracts, not an
adopted dependency list: each owner records an accepted choice in its own document
and qualifies it during the applicable [verification phase](../plan/execution-workflow.md).

Versions, licenses and terms come from project repositories, package registries
(Maven Central, crates.io, npm, PyPI), specifications and vendor documentation on
that date. The consequential claims were rechecked directly. Items marked
*unverified* still need confirmation. The [jena-text CJK probe](../../scripts/research/jena_text_cjk/README.md) supplies
executed graph evidence. The [application stack review](application-stack.md)
separately records framework verification and its limits; other rows are desk reviews. Pin exact releases and digests in release manifests rather
than copying this snapshot. Language-specific tools outside the selected Main
table remain candidates for their actual consumers; Rust libraries are not
in-process TypeScript dependencies.

## Selection rules

- Adopt a component when its semantics match the owning contract, and wrap it
  behind that owner's interface. A popular tool with different semantics is not a
  shortcut.
- REZICS keeps the meanings that define the product: receipts, fences and outbox
  delivery; the Access evaluator and its first-applicable ordered rules; revision
  manifests and their resolver; typed context resolution; Main Version selection;
  Tag Path meaning; rating and vote reducers.
- Prefer modules already inside selected runtimes (the Fuseki jar, PostgreSQL,
  TypeScript packages and justified native libraries) over new services. Add a service when its feature activates.
- OSI and source-available licenses are both acceptable when the intended use
  needs no upfront payment; record restrictions. Data licenses and API terms are
  separate constraints from software licenses.

## Highest-leverage findings

1. **Use what Fuseki 6.2.0 already ships.** Query/update timeouts, Prometheus
   metrics, compaction, backup, bulk loading, text reindexing, SHACL and endpoint
   authentication are built in. None needs a REZICS implementation.
2. **Spike a transactional command module inside Fuseki.** A Fuseki module can run
   guard checks, the update, receipt/outbox writes and jena-shacl
   `GraphValidation.update` in one TDB2 write transaction; validation failure aborts
   it. That could replace the single-request guarded HTTP protocol and the external
   validator helper in [storage binding](../storage/jena.md) and
   [model validation](../implementation/model-profile-validation.md). Keep domain
   policy in Main; the module would be a generic executor.
3. **Search needs configuration, not a new engine.** The
   [probe](../../scripts/research/jena_text_cjk/README.md) found four
   [search contract](../contracts/search.md) corrections:
   - Index and query CJK text with the same unigram+bigram analyzer; `CJKAnalyzer`
     misses every single-character query.
   - Compile user input into escaped phrases joined by `AND`. The default parser
     treats multi-token Chinese input as OR.
   - Always pass an explicit `text:query` limit; without one Lucene returns only
     10,000 hits before later filters run.
   - Do not configure `text:queryAnalyzer`, which broke graph scoping.
4. **Do not use Jena's access modules for authorization.** jena-permissions is
   retired and had no release after 5.6.0. Fuseki graph ACLs apply only to read-only
   datasets, and source reading indicates `text:query` bypasses the TDB2 graph
   filter. Main remains the authority, as in the
   [authorization bridge](../implementation/authorization-bridge.md).
5. **Keep the model compiler, but make it thin.** LinkML's own dashboard shows its
   SHACL generator passing 32% of compliance cases and its Rust generator is
   unfinished. Have the compiler emit JSON Schema 2020-12 for TypeScript bindings; generate
   Rust bindings only when a native consumer needs them.
6. **Source data carries legal constraints.** CurseForge terms forbid saving or
   caching API data and building competing services. Open Library's API is not
   meant as a third-party data backend; bulk use belongs to its dumps. MusicBrainz
   supplementary data and VNDB's AniDB-derived fields are non-commercial or
   share-alike.
7. **Several defaults changed in 2026:**
   - The MinIO community repository is archived.
   - pgBackRest was declared unmaintained in April and revived with sponsors in May.
   - Trivy's release and actions were compromised in March (GHSA-69fq-xp46-6x23).
   - MCP's current specification is 2026-07-28 and deprecates dynamic client
     registration.
8. **Better Auth covers most of the connected-apps authorization server.** Its
   OAuth provider, CIMD, MCP and passkey plugins cover resource indicators (RFC 8707),
   DPoP, introspection and pairwise subjects. Token exchange (RFC 8693) is the main
   gap; panva `oidc-provider` is the certified fallback.

## Engine alternatives reviewed

Fluree and Oxigraph were reconsidered against the same search and architecture
needs. They do not change the Jena selection.

- **Fluree 4.2.1.**
  - Its documentation states that all transaction history is preserved as
    append-only, and no purge or excision procedure is documented. That conflicts
    with the [erasure contract](../operations/erasure.md) unless erasable content
    never enters the ledger, which would also remove the benefit of its inline full-text.
  - The 4.x line started with v4.0.0 on 2026-04-22.
  - Its [BUSL-1.1 grant](https://github.com/fluree/db/blob/v4.2.1/LICENSE) excludes
    offering it as a third-party "Database Service" for four years per version.
  - Inline full-text is per-row and exact after graph filtering. The BM25 graph
    source uses a fixed English analyzer and truncates before joins.
  - [Time travel](https://github.com/fluree/db/blob/v4.2.1/docs/concepts/time-travel.md),
    [BM25](https://github.com/fluree/db/blob/v4.2.1/docs/indexing-and-search/bm25.md).
- **Oxigraph 0.5.x.**
  - It is mutable (RocksDB, repeatable read) and Rust-native.
  - It has no full-text index; [issue #48](https://github.com/oxigraph/oxigraph/issues/48)
    has been open since 2020.
  - It depends heavily on one maintainer.
  - Its crates are valuable Main tooling; see the next sections.
- **Architecture consequence.** Application-owned revisions keep history portable
  across engines. Engine-owned history would become the main exit cost.

## Graph substrate and Semantic Web modules

| Capability | Tool (2026-09-23) | Decision | Owner |
| --- | --- | --- | --- |
| SHACL validation | jena-shacl 6.2.0: Core, SPARQL constraints, CLI, `GraphValidation.update` | Adopt now | [Model validation](../implementation/model-profile-validation.md) |
| Query/update budgets | `arq:queryTimeout`, `arq:updateTimeout`; no built-in row cap | Adopt now; Main still injects `LIMIT` | [Workload budgets](../storage/workload-budgets.md) |
| Metrics | Fuseki `/$/metrics` (Micrometer, Prometheus format) | Adopt now | [Observability](../operations/observability.md) |
| Maintenance | `/$/compact`, `/$/backup` (N-Quads, Lucene excluded), `tdb2.xloader`, `jena.textindexer` | Adopt now | [Recovery](../operations/recovery.md) |
| Endpoint authentication | `fuseki:allowedUsers`, Shiro; separate query/update principals | Adopt now as defense-in-depth | [Security](../operations/security.md) |
| Graph-level ACL | jena-fuseki-access | Avoid for authorization | [Authorization bridge](../implementation/authorization-bridge.md) |
| Permissions | jena-permissions | Avoid; retired after 5.6.0 | — |
| Transactional commands | Custom Fuseki module plus `GraphValidation.update` | Spike first; module API documented as experimental | [Storage binding](../storage/jena.md) |
| CJK analysis | Lucene 10.3.1 `analysis-icu`, `-smartcn`, `-kuromoji`, `-nori` on the Fuseki classpath | Adopt ICU normalization now; compare smartcn; Japanese/Korean when activated | [Search](../contracts/search.md) |
| Script variants | jena-text `text:searchFor`/`text:auxIndex`; OpenCC 1.4.2 for derived fields | Spike; Traditional→Simplified ICU transform needs a small wrapper class | [Content languages](../contracts/content-languages.md) |
| Change log | RDF Patch `patch:LoggedDataset` | Spike for incremental backup/audit; not an outbox (writes before commit, no fsync, per source) | [Recovery](../operations/recovery.md) |
| Replication/HA | RDF Delta (last release 1.1.2, 2022; `main` builds on Jena 6.2) | Adopt only when HA activates | [Deployment](../operations/deployment.md) |
| Spatial | jena-geosparql 6.2.0 (documents GeoSPARQL 1.0, read-only STRtree index) | Adopt when spatial activates, after stacking spike | [Spatial annotations](../contracts/spatial-annotations.md) |
| Identified assertions | RDF 1.2 triple terms and reifiers (Jena 6.1+; specs CR/WD) | Spike first | [Semantic model](../contracts/semantic-model.md) |
| Inference | `ja:DatasetRDFS` query-time RDFS | Only for bounded class queries; otherwise materialize | [Model profiles](../contracts/model-profiles.md) |
| Dump conversion | SPARQL Anything 1.2.0 (Jena 6-based CONSTRUCT over JSON/XML/CSV) | Spike in a separate batch JVM | [Source lifecycle](../contracts/source-lifecycle.md) |
| Binary RDF | Jelly-JVM 3.7.3 (targets Jena 5.6) | Spike later | — |

Avoid jena-querybuilder (Java-only), jena-serviceenhancer (not needed), TopBraid
SHACL rules (REZICS limits entailment), BDRC `lucene-zh` (Lucene 8) and the
stale jieba-analysis, IK and HanLP Lucene plugins. The CJK probe also showed that
graph-first matching with `CONTAINS` on a normalized literal took 14 ms for 2,000
candidates, while per-subject `text:query` took 2.7 s because each call opens a
new index reader. That makes `CONTAINS` the exact lane for selective graph filters.

## Model definitions, validation and source mapping

| Need | Tool | Decision |
| --- | --- | --- |
| Single source of truth | REZICS TypeScript-authored IR and compiler | Keep; emit JSON Schema 2020-12, JSON-LD contexts and SHACL |
| Rust types | [typify](https://github.com/oxidecomputer/typify) 0.8.0 from JSON Schema | Optional native consumers only |
| TypeScript types | json-schema-to-typescript 16.0.0 | Adopt |
| Round-trip check | schemars 1.2.2 | Native consumer CI only |
| Schema reference/export | [LinkML](https://github.com/linkml/linkml) 1.11.1 | Design reference and optional export; not the IR |
| In-process pre-validation | [rudof](https://github.com/rudof-project/rudof) 0.3.21 (on oxrdf/spargebra) | Native integration candidate only; not an in-process Bun dependency; jena-shacl remains the authority |
| JSON-LD checks and framing | jsonld.js 9.0.0 | Adopt for CI and framed exports |
| RDF I/O and SPARQL | Bounded TypeScript query templates/serialization in Main; oxrdf/oxttl/oxjsonld/spargebra/sparesults for native consumers | The executed spargebra round trip remains Rust evidence; qualify any TypeScript parser/serializer separately |
| Wikidata statements | [Wikibase RDF format](https://www.mediawiki.org/wiki/Wikibase/Indexing/RDF_Dump_Format); Wikidata Toolkit 0.18.0; wikibase-sdk 11.6.5 | Adopt the format; store raw entity JSON |
| Identity-match evidence | SSSOM 1.0 pattern; Reconciliation API v0.2; Splink 4.0.17 | Adopt SSSOM pattern; API when matching activates; Splink spike |
| Event time | EDTF with edtf.js 4.11.1; OWL-Time; ICU4X `icu_calendar` 2.3 | Adopt for Gregorian lexical forms |
| Concept-scheme quality | qSKOS 2.0.4 (GPL CLI); SHACL-SPARQL for `skos:broader+` cycles | CI step when schemes activate |
| Vocabulary/shape docs | pyLODE 3.6.0; SHACL Play 0.12.4 | Adopt when vocabularies are published |
| Source schema bootstrap | LinkML schema-automator 0.5.7 | Use once per new source |

Wikidata's query service is moving from Blazegraph to QLever, with Blazegraph
shutdown planned by 2027-06-30. Avoid Blazegraph-only features such as the label
service ([migration](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_backend_update)).
No Rust RML engine exists and the RML specifications are still Community Group
drafts. Keep typed source adapters in the owning worker, and spike SPARQL Anything or Morph-KGC
2.10 only for declarative bulk mappings. Avoid TypeSpec as the model source (no RDF output),
shacl2code, RMLMapper as a runtime, VocBench, Widoco/ROBOT/ODK, sophia,
horned-owl (LGPL), nanopub libraries and the GPL Rust `wikibase` crate.

## Main service (TypeScript on Bun)

The maintainer selects Elysia 2.0 and Bun with Yarn workspaces. See the
[framework comparison](application-stack.md) for versioned primary evidence,
Hono alternatives, plugin compatibility and qualification limits. The former
Axum/utoipa/sqlx Main defaults no longer apply to this application layer.

| Area | Pick | Qualification or boundary |
| --- | --- | --- |
| HTTP/runtime | Elysia `2.0.0-beta.16`, Bun `1.4.2` | Selected production target; not a claim that the beta is a stable release. |
| Dependency management | Yarn `4.18.0`, `nodeLinker: node-modules`, one `yarn.lock` | Backend workspace commands explicitly invoke Bun. |
| OpenAPI | `@elysia/openapi@2.0.0-beta.4` with explicit schemas | Verify status-specific errors, response schemas and lossless wire values; avoid depending on TypeScript compiler API extraction. |
| TypeScript clients | openapi-typescript + openapi-fetch | Eden is optional for scoped consumers; public HTTP contracts stay independent of Elysia implementation types. |
| Problem Details | Elysia 2 RFC 9457 transport plus REZICS domain error mapping | Preserve safe codes, disclosure and operation IDs. |
| PostgreSQL | TypeScript driver/query adapter behind Account/Access owners | Select/qualify the driver with actual transaction and revocation cases; Rust sqlx is no longer the Main binding. |
| Outbox/jobs | Bounded owner poller and durable leases/checkpoints | `defer` and after-response hooks do not provide durability; no new broker. |
| Observability | Compatible Elysia 2 OpenTelemetry plugin and structured logs | Qualify request context and outbound Fuseki/SQL spans; do not infer full coverage from plugin installation. |
| Fuseki | Bounded Fetch/HTTP adapter with connection reuse and cancellation | Guarded update/receipt reconciliation stays explicit; no retry of ambiguous non-idempotent effects. |
| Validation/model | Shared IR, explicit schemas and the pinned Jena SHACL helper | TypeScript is not RDF validation or runtime input validation by itself. |
| Native components | Rust when a solver/worker integration warrants it | Not a second implementation of ordinary Main commands. |

## Account, connected apps and web client

| Area | Pick | Notes |
| --- | --- | --- |
| Authorization server | Better Auth 1.7.5 with `oauth-provider`, `cimd`, `mcp`, `passkey`, `captcha` (Turnstile) | RFC 8693 missing ([#8023](https://github.com/better-auth/better-auth/issues/8023)); `acr` fixed at `"0"` ([#11267](https://github.com/better-auth/better-auth/issues/11267)); inject an SSRF-safe CIMD fetcher on Bun; old `oidc-provider` plugin deprecated |
| Fallback authorization server | panva `oidc-provider` 9.12 (OpenID Certified) | Zitadel 4.19 (AGPL) if a separate IdP service is preferred; avoid Hydra and Keycloak here |
| Webhooks | Standard Webhooks | Do not invent a signature scheme |
| Account HTTP | Same Elysia 2/Bun baseline as Main | Adapt Better Auth Fetch integration to version-correct routes; qualify actual OIDC flows. |
| React framework | vinext on Vite, deployed to Cloudflare Workers | Selected for the maintainer's Workers/Vite requirement; Next.js and React Router remain alternatives, not blanket exclusions. See [comparison](application-stack.md#frontend-options). |
| Data fetching | TanStack Query 5 with shared key factories | Generated clients from the Main section |
| Block editor | Tiptap 3 (headless; unique IDs; static renderer) | When wiki editing starts; write a codec to the REZICS Block AST; Yjs later; avoid BlockNote and Plate |
| UI messages | Lingui 6 or Paraglide 2 | Spike; MessageFormat 2 later (`Intl.MessageFormat` is Stage 1) |
| Parameter forms | RJSF 6 with SharkUI widgets; JSON Forms 3.8 as alternative | Precompile Ajv for strict CSP; stored JSON Schema stays canonical; zod 4 at boundaries |
| UI verification | Storybook 10.6 with addon-vitest and addon-a11y; Playwright 1.63 | Pin Vitest 4.1 (addon does not accept Vitest 5); avoid archived Lost Pixel |
| Executable themes | Separate registrable domain, sandboxed iframe without `allow-same-origin`, CSP, artifact hash approval, denylist kill switch | quickjs-emscripten spike for logic-only themes; SES, ShadowRealm and workerd alone are not boundaries |
| SEO | schema-dts 2.0, `sitemap` 9.0, route metadata | — |
| MCP clients/servers in TypeScript | `@modelcontextprotocol/server` and `/client` 2.0 | Reject legacy protocol versions |

Owners: [Account](../services/account.md), [connected apps](../contracts/connected-apps.md),
[frontend plan](../plan/frontend.md), [custom themes](../contracts/custom-theme-execution.md).

## Content domains

| Domain | Adopt | Constraint or later step |
| --- | --- | --- |
| Package solving | resolvo 0.12.1 (used by pixi/rattler); Go MVS implemented directly | pubgrub 0.4 only as a conflict-explanation reference |
| Package identity and metadata | PURL (ECMA-427) via `packageurl` 0.7.1; SPDX license list 3.29 via `spdx` 0.13.5; CodeMeta 3.1; SWHID (ISO/IEC 18670) | Mod-platform PURL types may be missing (*unverified*) |
| Supply-chain data | OSV 1.9 exports; deps.dev v3 enrichment; CycloneDX 1.7 (ECMA-424) when SBOM ships | ecosyste.ms data is CC BY-SA |
| Mod platforms | Modrinth API v2 (300 req/min, User-Agent) | CurseForge: outbound links only; Nexus Mods requires app registration; Steam Web API 100,000 calls/day |
| Books | Open Library monthly dumps, low-volume live lookups; `isbn` crate; marc4j/pymarc; LoC marc2bibframe2 XSLT (CC0) | LRMoo 1.1.1 for export mappings only; Bangumi dumps state no data license |
| Visual novels | VNDB Kana API (ODbL/DbCL) | Exclude AniDB-derived CC BY-NC-SA fields and images |
| Music | MusicBrainz core data (CC0), dumps, `musicbrainz_rs` 0.14 | Supplementary data and live feed are CC BY-NC-SA; Cover Art Archive images are linked or proxied; avoid AcoustID |
| Images | libvips 8.18 through imgproxy 4.0 (signed URLs); re-encode as the sanitizer; ClamAV 1.5 `clamd` in quarantine | imgproxy 4 moved pHash and cache to Pro; `image_hasher` 3.1 for deduplication |
| Audio/video | FFmpeg 9 | When media transcoding activates |
| Region annotation | Annotorious 3 with OpenSeadragon 6 (W3C Web Annotation) | Mirador 4 / Universal Viewer only for IIIF interoperability |
| Recipes | Schema.org Recipe; UCUM codes; QUDT 3.5 (CC BY 4.0); USDA FoodData Central (public domain) | ingredient-parser-nlp is English-only; Open Food Facts (ODbL) stays in its own named graphs |
| Spatial | geo, geojson, geozero; PROJ bindings when needed; Turf in the client | GeoJSON only for Earth coordinates; game worlds use custom CRS or Web Annotation selectors |
| Recommendations | pgvector 0.8.6 with Qwen3-Embedding-0.6B (Apache-2.0) or BGE-M3 (MIT) | `implicit` ALS when interaction volume justifies it; Wilson and Bayesian averages are code, not libraries |
| AI hub | Agent Skills format; MCP 2026-07-28; MCP Registry `server.json` import; Wasmtime 49 for REZICS-defined tools | Agent Skills has no version field (use content hashes); LiteLLM when hosted inference ships; gVisor or self-hosted E2B spike for arbitrary code; avoid microsandbox |
| Language | OpenCC 1.4.2; lingua 1.8 with an OpenCC round-trip heuristic for Hans/Hant; IANA subtag registry; CLDR 48.2 | Avoid CLD3 and fastText (archived) |

Owners: [package management](../contracts/package-management.md),
[catalog](../contracts/catalog.md), [media](../contracts/media.md),
[recipes](../contracts/recipes.md), [recommendations](../contracts/recommendations.md),
[Skills and Prompts](../contracts/skills-and-prompts.md).

## Operations

| Area | Pick | Notes |
| --- | --- | --- |
| Object storage | Compare RustFS 1.0.0, VersityGW 1.8 (S3 gateway over ZFS/XFS) and SeaweedFS 4.47 | RustFS is eligible for local development; production candidates must pass the object contract. Inspect affected/fixed versions rather than rejecting all releases for historical advisories. MinIO community repository archived; Garage lacks `If-None-Match` PUT; Cloudflare R2 as offsite/fallback (no object lock). |
| PostgreSQL PITR | pgBackRest 2.59 | WAL-G or Barman as fallbacks; `pg_dump` for logical exports only |
| TDB2, Lucene and bucket backups | restic 0.19 (`rewrite --exclude` aids erasure); rclone 1.75 for mirroring | Keep both stopped-process snapshots and N-Quads backups |
| Observability | OpenTelemetry Collector, Prometheus 3 + Alertmanager, VictoriaLogs, Grafana, node_exporter, postgres_exporter, Fuseki `/$/metrics` | Traces later (Tempo or VictoriaTraces); JMX exporter unnecessary |
| Email | Postmark or Amazon SES through an SMTP adapter | Cloudflare Email Sending is beta; parsedmarc later |
| Secrets | SOPS 3.13 with age 1.3; systemd-creds | OpenBao only for dynamic credentials or PKI |
| Deployment | systemd units; Podman Quadlet for third-party containers; Caddy 2.11; Cloudflare CDN cache-tag purge | Kamal and Nomad unnecessary |
| CI and supply chain | GitHub Actions, Renovate, Yarn lockfile scanning, zizmor; cargo-deny for native consumers | Syft and build-provenance attestations at first release; avoid Trivy after GHSA-69fq-xp46-6x23 |
| Load testing | k6 2.3; oha 1.16 | IGUANA only for comparing triple stores |
| Documentation | lychee 0.24 (anchors), markdownlint-cli2 | Keep the Python checker for reachability and REZICS roles; autocorrect spike for CJK spacing |
| Local orchestration | Aspire 13.5 (Bun, executables, PostgreSQL) | Development only |

Owners: [objects](../storage/objects.md), [recovery](../operations/recovery.md),
[observability](../operations/observability.md), [deployment](../operations/deployment.md),
[development](../development/README.md).

RustFS's [release history](https://github.com/rustfs/rustfs/releases) includes
1.0.0 on 2026-09-16. The historical
[console XSS advisory](https://github.com/rustfs/rustfs/security/advisories/GHSA-7gcx-wg4x-q9x6)
and [Object Lock advisory](https://github.com/rustfs/rustfs/security/advisories/GHSA-j548-9grx-fh4f)
identify fixed versions; they do not justify excluding every later version from
local development. This corrects the earlier blanket exclusion without claiming
that REZICS's object-storage integration has been tested.

## Keep REZICS-owned

No mature component matches these semantics, or the adjacent tools would weaken
the contract:

- Receipt, fence and outbox protocols. A generic leased poller can serve both
  PostgreSQL and SPARQL outboxes.
- The Access evaluator: first-applicable ordered rules, representation and
  decision frames. Cedar, OpenFGA and SpiceDB remain references.
- Revision anchors, manifests, paged payloads and the resolver.
- Context resolution, Main Version selection, Tag Path semantics, and rating and
  vote reducers.
- The thin model compiler and its IR.
- Fictional calendars and an EDTF level-2 parser for Rust. The `edtf` crate stops
  at level 1; test against edtf.js.
- A restore-verification script that reloads, reindexes and compares per-graph
  counts and digests.
- Small typed Problem Details and CloudEvents structures.

## Data licenses and API terms

- Keep ODbL and CC BY-SA sources in separately licensed named graphs: Open Food
  Facts, VNDB and ecosyste.ms.
- Do not store or cache CurseForge API data without a written agreement.
- Open Library: dumps for bulk data; identified, low-volume live lookups (3 req/s).
- MusicBrainz: core data CC0; supplementary data and live feed non-commercial;
  Cover Art Archive images remain third-party copyright.
- ISBN range data may be used but not republished; Bangumi dumps need permission
  before bulk republication.
- UCUM tables carry Regenstrief terms; QUDT requires CC BY attribution.
- Embedding models: prefer Apache-2.0 or MIT (Qwen3-Embedding, BGE-M3). Avoid
  models without a clear license tag.

## Spikes by payoff

1. **Transactional Fuseki module.** Guards, update, SHACL validation, receipt and
   outbox run in one TDB2 write transaction.
   - Adopt if competing edits, lost responses, validation failures, restart and
     restore pass the [backend cases](../testing/backend-integration.md).
   - That would simplify the guarded HTTP protocol and the validator helper.
2. **CJK analyzer profile on real corpus samples.**
   - Compare unigram+bigram with ICU normalization against smartcn.
   - Measure highlight offsets, index size and common-character phrase cost.
   - Test field-level analyzers with graph scoping.
3. **Object storage.** RustFS, VersityGW and SeaweedFS, covering conditional writes,
   multipart uploads, garbage collection, backup and restore.
4. **Frontend toolchain on Workers.** vinext/Vite with the matching Cloudflare
   adapter, Storybook, generated clients, auth and cache isolation. Yarn installs
   dependencies; Bun hosts Main/Account, not the Workers runtime.
5. **Declarative source conversion.** SPARQL Anything on Open Library and
   MusicBrainz dumps, measuring throughput, provenance graphs and memory.
6. **Optional native validation.** Only if a native consumer warrants it, compare
   rudof pre-validation with jena-shacl results on generated shapes.
7. **Identified assertions.** RDF 1.2 reifiers through Fuseki, jena-text and the
   Rust parsers.

## Evidence and limits

Consequential claims were rechecked directly against these sources:
- **Jena:** [archived modules](https://github.com/apache/jena/blob/jena-6.2.0/archived-modules.md),
  [GraphValidation](https://github.com/apache/jena/blob/jena-6.2.0/jena-shacl/src/main/java/org/apache/jena/shacl/GraphValidation.java),
  [Fuseki modules](https://jena.apache.org/documentation/fuseki2/fuseki-modules.html),
  and the Maven Central entries for the Lucene 10.3.1 analysis modules.
- **Operations:** the archived [MinIO repository](https://github.com/minio/minio),
  [pgBackRest news](https://pgbackrest.org/news.html) and the
  [Trivy advisory](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23).
- **Libraries and specifications:** the utoipa and Better Auth registry entries,
  [MCP versioning](https://modelcontextprotocol.io/specification/versioning) and
  the [LinkML generator dashboard](https://github.com/linkml/linkml/blob/main/docs/generators/dashboard.md).
- **Terms:** [CurseForge API terms](https://support.curseforge.com/en/support/solutions/articles/9000207405-curse-forge-3rd-party-api-terms-and-conditions)
  and [Open Library API guidance](https://openlibrary.org/developers/api).

Remaining unverified items:
- The `text:query` bypass of graph ACLs at runtime.
- RDF Delta, GeoSPARQL or RDFS wrappers stacked over `TextDataset`.
- Whether jena-text participates in TDB2's transaction coordinator, and crash
  atomicity in any case.
- rudof SHACL-SPARQL coverage and Jelly on Jena 6.
- The selected vinext/Workers product build, and actual Better Auth/OIDC and
  observability integration on Elysia 2/Bun; `oidc-provider` remains a fallback.
- PURL types for mod platforms.
- Several data-license details noted in the tables.

This survey changes no owner contract. Adopting a row means updating its owner
and running that owner's verification.
