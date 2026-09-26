# Universal package-management acceptance

Use [package profiles](../contracts/package-profiles.md) and current captured
provider data. Native tools are semantic oracles only for their declared versions,
environment and policies. Compare satisfied constraints, selection policy,
activated features and instance topology; equal lockfile bytes are not required.

| ID | Scenario | Required result |
| --- | --- | --- |
| PKG01 | Cargo feature/target/resolver combinations | Correct feature sets and host/target instances. |
| PKG02 | Cargo incompatible native links or yanked selection | Correct conflict/locked eligibility behavior. |
| PKG03 | npm nested incompatible versions and peer hosts | Distinct scoped instances; no name-to-one-version collapse. |
| PKG04 | npm optional/platform/alias/workspace overrides | Native semantics preserved or explicitly unsupported. |
| PKG05 | Go MVS with replace/exclude/retract and major paths | Correct build list and source/checksum meaning. |
| PKG06 | Nix follows/locked inputs and derivation outputs | Input graph, build graph and observed runtime closure remain distinct. |
| PKG07 | Fabric soft conflict versus hard breaks | Advisory versus unsatisfiable outcomes remain different. |
| PKG08 | Forge/NeoForge side/version/load-order constraints | Separate selection/ordering validation and correct loader-specific manifest semantics. |
| PKG09 | Modrinth/CurseForge embedded/provider dependencies | No duplicate download or lost dependency grain. |
| PKG10 | Nexus experimental/inaccessible metadata | Actual coverage recorded; missing requirements not assumed empty. |
| PKG11 | Steam soft dependency/Collection relation | Do not invent a mandatory installation constraint. |
| PKG12 | Same source snapshot solved by native/REZICS profiles | Logical correspondence and meaningful divergence explained. |
| PKG13 | Unsatisfiable, incomplete data and solver timeout | Three distinct outcomes; no false unsat proof. |
| PKG14 | Lock replay after mutable tag/file changes | Exact artifact validation or unavailable result. |
| PKG15 | Archive traversal, file ownership collision or unapproved hook | Stage rejected before unsafe effects. |
| PKG16 | Crash during activate/update/remove | Journal/generation recovery; preserve user data. |
| PKG17 | Roll back after artifact/authority revocation | Current policy enforced; no resurrection. |
| PKG18 | Skill composes multiple ecosystem requirements | Scoped environment and adapters; no false cross-ecosystem substitutability. |
| PKG19 | Large candidate universe with selective requirements | Lazy bounded loading, cancellation and truthful budget outcome. |
| PKG20 | Refresh next live run | New upstream versions admitted without changing semantic test intent. |

Controlled installation/plan tests need not compile every upstream project.
Do not claim runtime/build success from a resolver-only pass. Preserve rejected
states, dependency explanations, installation inventory and exact run profiles.

G-019 adds `npm-lock-v3-topology-v1`, a bounded caller-supplied lockfile-v3
topology validator. `yarn package:npm-oracle` checks installed npm 11.19.1,
then uses native offline `ls --package-lock-only` and its bundled Arborist
virtual tree against the same exact manifest/lock bytes. Eight cases compare
paths, stable versions, literal resolved URLs, SRI and actual peer hosts:
nested incompatible versions, an incompatible peer, an absent peer with a
same-name package elsewhere, nearer incompatible ancestor shadowing,
child-local peers, root peers, scoped peers, and identical artifacts in distinct
host environments. Child-local rejection is taken from Arborist's `PEER LOCAL`
edge error; CLI `ls` alone does not report that error as an invalid version.
The native helper forbids network access, no installed tree is created and
inputs remain unchanged. Results stay in `.temp/package-npm-oracle/result.json`.

Unit tests also cover duplicate JSON keys/escaped paths, root disagreement,
malformed bytes/digests/SRI, unsupported metadata/selectors, incomplete parent
or source evidence, unused nodes, peer cycles and byte/node/edge/depth budgets.
The real Account/Access/Main/PostgreSQL fixture checks concurrent same-key
convergence, exact bytes and receipt replay, private/scope denial, byte/policy
key conflicts, every outcome, immutable rows and inactive-principal fencing.
It bulk-copies 64/512/4,096 unrelated owner receipts, observes real owner query
row counts and checks native read plans/buffers. At 64 rows PostgreSQL can choose
a short sequential scan; the filter-count bound applies at 512 and 4,096 rows,
while page and one-result bounds apply at each scale. These checks do not qualify
deployment capacity.
The physical owner-cut fixture retains npm beside Cargo v1/v2/v3 and all six
Go receipt profiles. Signed Content coverage v4 includes `pkg.npm_resolution`;
a changed restored npm outcome blocks both exact read and graph hold release.
These recovery assertions passed in the manager's merged physical cut
`20260926t080447-f54717`. Eight npm unit
and contract tests, all fifteen retained Cargo unit cases, the eight-case native
npm oracle, generation, backend static and documentation checks passed in the
worker. API attempt `20260926t074528-c08118` stopped before npm behavior because
the initially selected migration number duplicated existing Source migration
017. The npm migration is now 020; G-018 owns preceding 019. The worker did not
fabricate or temporarily copy that migration. The manager's first merged API
run `20260926t080308-47d285` reached npm behavior and found that the 64-row
query plan violates an assertion requiring every plan to filter at most one row.
After the small-table correction at `3f8aefd`, stable merged API
`20260926t080416-91b114` passed the same complete fixture with 512/4,096-row
selectivity and page bounds; the physical restore above passed on the same
source. These are selected passes, not full qualification.
Partial PKG03/PKG12/PKG13 only: live registry resolution, range solving,
optional/platform/alias/workspace behavior, artifact verification and installation
remain unqualified. A lock parser or source-only graph does not close PKG03.

G-021 adds `npm-lock-v3-topology-v2` and `npm-lock-topology-receipt-v2`, with
an explicit OS/CPU target, exact optional dependencies and optional peers.
Its 33 native comparisons cover eleven fixed cases on Linux x64, Windows x64
and Linux arm64: an OS/CPU-gated optional parent, an incompatible optional
child, a shared required platform failure, a missing required dependency,
absent optional dependencies/peers, incompatible required and optional peer
shadowing, a present optional peer host, an optional cycle, a dependency shared
by optional parents, and positive/negative/any/empty platform selectors.
`yarn package:npm-oracle` retains the original eight native cases and compares
exact paths, versions, source/SRI, optional flags, edges, peer hosts, active
paths and omission causes. Results remain under `.temp/package-npm-oracle/`.
The virtual tree itself retains every locked package; the oracle explicitly
applies the pinned npm platform and optional-region helpers to the declared
target. This is evidence for the bounded projection, not npm installation.

`npm-platform-topology.test.ts` adds malformed and unknown targets/selectors,
unsupported inactive metadata, immutable target identity, optional-flag
disagreement, required source failures inside inactive branches, child-local
optional peers, and byte/node/edge/selector/path/ancestor limits. Multi-scale
optional graphs retain bounded visit and lookup counters.
`npm-v1-compatibility.test.ts` fixes canonical hashes for all eight original
G-019 outcomes, including identity and costs. The shared real API fixture adds
both receipt versions, private exact replay, target/byte/profile key conflicts,
no-row malformed admission and inactive-principal fencing. It checks both
versions' indexed reads/replays at the same 64/512/4,096 unrelated-history scales,
without constructing a second background corpus. The physical owner-cut fixture
adds Linux and Windows v2 receipts alongside v1 and the retained Go/Cargo rows;
changed omission evidence must fail both exact read and signed hold release.
The worker's 17 selected npm unit/contract tests, all 41 native comparisons,
generation and backend static checks passed. Selected real API run
`20260926t082809-7a0af6` and physical owner-cut run
`20260926t082839-21d09a` passed on the same stable source fingerprint
`342e7a1b6426`. The earlier API attempt corrected a test expectation for the
existing transport boundary: malformed target envelopes return 400, while
malformed admitted snapshot contents return 422; neither creates a receipt.
The manager must repeat affected checks after integration; these selected runs
do not qualify the complete backend.

These are partial PKG04/PKG12/PKG13 assertions. Override/engine semantics,
composition with the separate alias/workspace profile below, other npm strategies,
pnpm/Yarn, registry solving, artifact validation, installation and complete-case
qualification remain retained later work.

G-023 adds `npm-lock-v3-topology-v3` and `npm-lock-topology-receipt-v3` for
required dependency/peer topology with exact aliases and caller-supplied workspace
manifest bytes. Its 25 fixed npm 11.19.1/Arborist 9.9.1 counterexamples compare
declared slots and resolved names, identical artifacts in two alias slots,
scoped aliases, aliases in distinct peer environments, alias peer hosts,
incompatible alias peers, workspace internal dependencies and
root/local peer hosts, workspace directory/name differences, wrong link slots and
targets, missing link/source/SRI, malformed evidence, unknown source grammar,
overrides and engines. Results retain exact inputs, CLI output, native nodes,
edges and loader errors, profile outcomes and each intentional admission
difference in `.temp/package-npm-oracle/identity-result.json`. The existing eight
v1 and 33 v2 comparisons remain in the same root command.

The native probe exposed two material distinctions. Workspace targets are native
filesystem tops and can resolve a peer in their own children. An alias edge
checks the target version but does not authenticate its package name; a mismatch
therefore returns unsupported identity evidence, not a native conflict claim.
Missing source/SRI and malformed SRI may also survive native virtual loading;
the profile separately requires bounded literal evidence. `loadVirtual` reads
workspace manifests from disk, so the isolated oracle writes only the exact
supplied bytes under its disposable fixture. Main itself reads no caller paths.
The oracle records npm's absolute temporary workspace edge spec and verifies its
explicit mapping to the request's relative path; registry URLs are never rewritten.
No physical symlink, installed package tree, artifact verification or lifecycle
execution is asserted.

Identity tests cover byte/name/path bindings, duplicate and malformed workspace
inputs, alias-name ambiguity, missing records, unsupported hidden metadata,
source grammar, cycles, aggregate/file/workspace/node/edge/path/ancestor budgets,
and counted 8/32/128-node work. The v1/v2 compatibility tests pin all 41 historical
outcome hashes, including IDs, costs and v2 omission evidence. The shared real
API fixture adds v3 concurrent same-key convergence, exact read/replay, changed
root/workspace byte and profile conflicts, private/scope denial, malformed no-row
admission, immutable owner rows and inactive-principal fencing. One bulk history
corpus serves all three versions' reads/replays at 64/512/4,096 unrelated rows;
`npm-receipt-reads.json` in the QA run records native plans, result/filter counts
and page reads.
The physical owner-cut fixture retains two v3 receipts with all previous npm,
Go and Cargo receipts, and tampers alias and workspace-target evidence in the
isolated restored copy to test exact-read and signed-hold-release denial.

The worker's 25 npm unit/contract cases, all 66 native comparisons, generation,
backend static and documentation checks passed. Selected real API run
`20260926t090612-cad7b8` passed with stable source fingerprint `7f8e90e15f90`.
Its retained `npm-receipt-reads.json` shows six exact read plans across v1/v2/v3:
at 64 unrelated receipts PostgreSQL used five-block sequential scans; at 512 and
4,096 it used three-block index scans, one result and zero filtered rows. V3's
eight-node/eight-edge workspace fixture retained eleven ancestor lookups and
21 graph visits at every history size. These bounded measurements do not qualify
deployment capacity. Physical owner-cut run `20260926t090705-fe0189` passed on
stable source `d01a36f0159b` after separating the two v3 tamper assertions; no
package implementation changed between the API and recovery runs. Both selected
runs cleaned up their own isolated stacks. PKG04/PKG12/PKG13 remain partial.
Optional/platform plus alias/workspace composition, workspace globs/external
links, override/engine policy, pnpm/Yarn, registry selection, artifact integrity
and installation are unqualified. The manager repeats affected checks after merge;
these virtual-tree results cannot close PKG04 or qualify the whole backend.

The affected command set for this slice is:

```sh
yarn test tests/qa/unit/npm-identity-topology.test.ts tests/qa/unit/npm-v1-compatibility.test.ts tests/qa/unit/npm-v2-compatibility.test.ts tests/qa/unit/npm-lock-topology.test.ts tests/qa/unit/npm-platform-topology.test.ts tests/qa/unit/npm-lock-contract.test.ts
yarn package:npm-oracle
yarn gen
yarn test tests/qa/integration/source-authenticated-api.test.ts
yarn test tests/qa/fault-recovery/coordinated-owner-cut.test.ts
yarn check:backend
yarn docs:check
```

G-026 adds the separate `npm-lock-v3-topology-v4` composed identity/target
profile. The offline oracle retains 29 scenarios on all four Linux/Windows and
x64/arm64 pairs (116 comparisons) in
`.temp/package-npm-oracle/composition-result.json`. Cases combine optional aliases,
required/optional shared aliases, a workspace whose differently named directory
owns an omitted child, required and local workspace peers, internal workspace
links, platform restrictions on both links and targets, absent and shadowing
optional peers, cycles and shared optional children. Missing required edges,
workspace manifests/targets/link sources, literal sources/SRI, wrong alias or
plain package identity, malformed evidence, optional flag disagreement and
override/engine clauses cannot become successful projection.

Each observation records exact caller bytes, native virtual nodes/edges, npm
11.19.1 and Arborist 9.9.1 identity, recomputed optional flags, platform errors,
optional-region omissions and the REZICS result. Validated cases compare every
slot/name/source/SRI, workspace target, selector, optional flag, peer host,
active edge and omitted instance/edge cause path. Deliberate admission differences
are asserted separately. V1's eight and v2's 33 outcome hashes remain frozen;
the v3 compatibility test freezes all 25 G-023 outputs including errors, costs
and identities before admitting v4. The oracle verifies that all fixture bytes
are unchanged and that no package directories were installed.

Unit tests exercise composed failure precedence, exact-byte/workspace/target
identity, malformed inputs, selector semantics, shared regions, cycles, and
byte/node/edge/workspace/path/ancestor/visit bounds at multiple small scales.
The selected real Account/Access/Main/Content test adds concurrent v4 same-key
convergence, changed target and workspace-byte conflict, private/scoped/inactive
denial, immutable rows, and exact reads/replay across v1/v2/v3/v4 at 64, 512 and
4,096 unrelated rows. `npm-receipt-reads.json` retains all eight owner query plans.
The physical owner-cut fixture adds all four v4 targets to signed Content
coverage v4, restores exact reads/replay, and corrupts alias identity, workspace
target and omission causes independently in the restored copy to require both
exact-read and hold-release denial.

The affected G-026 command set is:

```sh
yarn test tests/qa/unit/npm-composition-topology.test.ts tests/qa/unit/npm-v3-compatibility.test.ts tests/qa/unit/npm-v2-compatibility.test.ts tests/qa/unit/npm-v1-compatibility.test.ts tests/qa/unit/npm-identity-topology.test.ts tests/qa/unit/npm-platform-topology.test.ts tests/qa/unit/npm-lock-topology.test.ts tests/qa/unit/npm-lock-contract.test.ts
yarn package:npm-oracle
yarn gen
yarn test tests/qa/integration/source-authenticated-api.test.ts
yarn test tests/qa/fault-recovery/coordinated-owner-cut.test.ts
yarn check:backend
yarn docs:check
```

The worker passed 34 unit/contract tests and all 182 native comparisons, generated
the Main contract, and passed backend static and documentation checks. Final
selected API run `20260926t094945-c1f2aa` and physical owner-cut run
`20260926t094830-cbbf03` both passed on stable runtime source fingerprint
`2277e067155c`, in 13.2 and 44.1 seconds respectively. The v4 exact reads used
six-block sequential scans at 64 unrelated receipts and three-block index scans
at 512 and 4,096, returning one row; the latter scans filtered zero rows. Its
six-node/five-edge fixture retained eight ancestor lookups and 60 graph visits
at every scale. The generated API changes only the two npm paths; v1/v2/v3
request and read-response schemas compare equal to the base. These are selected
worker checks, not final backend qualification; the harness removed its isolated
stacks after each run.

G-033 adds `npm-lock-v3-topology-v5` and a separate immutable v5 receipt for
bounded flat root overrides and explicit Node/npm engine targets. The native
oracle adds five npm 11.19.1/Arborist 9.9.1 cases, bringing the fixed comparison
set to 187. It checks a transitive override's declared and effective edge
selectors, per-node native engine results, npm's direct-dependency `EOVERRIDE`,
the deliberately unsupported nested override, and missing SRI provenance.
`policy-result.json` retains exact inputs, native outputs and REZICS outcomes.
An incompatible optional node is still checked before platform omission; this
is REZICS strict admission, while npm's default engine check is advisory.
The selected unit/contract and real Source/npm API tests cover success, negative
outcomes, same-key convergence, private exact reads, conflicting replay and
indexed reads at 64/512/4,096 unrelated receipts. The physical owner-cut test
restores a v5 receipt and independently corrupts its override and engine-check
witnesses to require exact-read and graph-hold denial. Signed Content coverage
includes all ten npm receipts. These are affected checks, not full backend
qualification, and PKG04/PKG12/PKG13 remain partial.

The affected G-033 command set is:

```sh
yarn test tests/qa/unit/npm-policy-topology.test.ts tests/qa/unit/npm-lock-contract.test.ts tests/qa/unit/npm-v1-compatibility.test.ts tests/qa/unit/npm-v2-compatibility.test.ts tests/qa/unit/npm-v3-compatibility.test.ts tests/qa/unit/npm-composition-topology.test.ts
yarn package:npm-oracle
yarn gen
yarn test tests/qa/integration/source-authenticated-api.test.ts
yarn test tests/qa/fault-recovery/coordinated-owner-cut.test.ts
yarn check:backend
yarn docs:check
```

PKG04/PKG12/PKG13 remain partial. V4 qualifies bounded virtual identity and target
projection only. Broad workspaces, overrides, engine policy, pnpm/Yarn, registry
solving, artifact validation, installation and deployment capacity remain open.
The manager repeats affected checks on integrated source; this selected worker
scope does not qualify the whole backend.

The G-008 Cargo slice adds `cargo-index-exact-resolver2-v1` with exact root
manifest and registry-index bytes. The pinned Cargo 1.98.1 local-registry oracle
compares lock selection and active root dependency kinds on a fixed resolver 2
graph, including a transitive feature union, distinct build/normal features,
optional default activation and Linux versus Windows target selection. Unit
cases cover incompatible version instances, malformed/duplicate identities,
missing source, explicit `links`/yank refusal and a traversal budget. Real
Account OAuth, Access and PostgreSQL API checks cover scope denial, private read,
immutable exact replay, changed-key conflict and inactive-principal fencing.
The selected API integration run `20260926t052109-b15e57` passed; its 11
reported IDs are partial evidence only. The oracle result is retained locally
at `.temp/package-cargo-oracle/result.json`.
At G-008, PKG01/PKG02/PKG12/PKG13 remained partial: general semver selection, native
conflict and yanked-lock eligibility, broader target predicates, provider
capture, artifact checks and installation are still separate work.

G-011 adds `cargo-index-exact-resolver2-v2` and an exact native `links` conflict
witness. `yarn package:cargo-oracle` retains G-008's comparison and adds ten
local-registry scenarios: incompatible selected versions sharing a native
name, distinct names, one owner across roles, Linux/Windows and default-feature
variants, different package names sharing `links`, inactive target/root-optional
owners, and inactive versus enabled transitive optional owners. Cargo 1.98.1
and REZICS agree on conflict versus solved outcomes, exact solvable lock/source
identities, active edges and feature unions. Each native `links` crate includes
a build script that would fail if run; metadata resolution does not execute it.
The extra oracle result is `.temp/package-cargo-oracle/links-result.json`.
After merge with Source, the manager also passed the combined real API selection
`20260926t055142-cf5e59` and a coordinated physical owner-cut restore
`20260926t055206-dc75de` on signed Content recovery coverage v3. The restore
replayed exact stored v1/v2 Cargo receipts; this supersedes the worker's
pre-integration coverage limitation below, without qualifying package installation.

Unit cases preserve v1's exact unsupported receipt shape, deterministic sorted
v2 witnesses and role identities, unselected-release isolation and separate
malformed/missing/unsupported/budget outcomes. Small 1/8/24-release additions
leave selected-graph counters unchanged; this is bounded complexity evidence,
not deployment capacity. Real Account/Access/PostgreSQL API run
`20260926t054414-5ce654` passed private reads, distinct scopes, concurrent same-key
convergence, v1/v2 replay, changed-profile refusal, immutable rows and revoked
principals. Isolated physical restore `20260926t054502-d24a52` preserved exact
v1/v2 stored receipts and replay. That worker run used the pre-integration
recovery coverage; the manager owns adding the Cargo table to the signed
coverage and repeating the restore check on merged source.
PKG02/PKG12/PKG13 remain partial. General semver/backtracking, other Cargo
constraints, yanked fresh/locked eligibility, provider capture, artifact checks
and installation remain separate requirements.

G-013 adds the separately versioned `cargo-index-exact-resolver2-v3` admitted-lock
profile. `yarn package:cargo-oracle` adds sixteen native Cargo 1.98.1 scenarios:
fresh denial; exact locked yanked reuse; changed root identity; incompatible
requirements; changed/missing source; changed/missing checksum; disconnected
historical edges; absent locked package; non-yanked and unselected-yanked
releases; a new non-yanked selection; unselected checksum disagreement;
non-yanked checksum disagreement; and interaction with native `links` conflicts.
Three format comparisons reject floating-point `4.0` and admit integer `0x4`
and `+4`; Bun's parsed number alone cannot distinguish these native rules.
The locked-yanked case uses the native-generated unyanked seed lock. The oracle
compares REZICS v3 outcomes, exact selected identities, active edges and features,
and checksums from the native output lock. A single explicit source-label
mapping substitutes the local HTTP sparse index with the fixture's admitted
HTTPS sparse identity; both original native and mapped request bytes are
retained in `.temp/package-cargo-oracle/lock-result.json`. This mapping exists
only in the oracle and does not make HTTP or URL aliases valid in Main.

`cargo-lock-resolution.test.ts` also checks malformed/unsupported locks,
incomplete source, package/reference limits, deterministic provenance and
witnesses, v1/v2 unchanged receipts, and 1/8/24 irrelevant historical entries.
The real Account/Access/PostgreSQL API selection covers concurrent same-key
writes, separate read/resolve scopes, private reads, exact byte retention,
comment-only key conflict, no stored row for malformed input, every v3 outcome,
immutability and inactive-principal fencing. The coordinated owner-cut test
physically restores exact v1/v2/v3 receipts and replays their original keys.
Worker API run `20260926t061642-a5b188` and physical-restore run
`20260926t061712-287f61` passed on the same stable working-tree fingerprint.
All fifteen Cargo unit cases, the baseline/links/lock native oracle,
`yarn check:backend` and `yarn docs:check` passed for this slice. These selected
checks do not qualify the full backend; the manager repeats affected verification
after merging with the concurrent Access slice.
These cases are partial PKG02/PKG12/PKG13 evidence. General semver/backtracking,
`cargo update --precise`, other lock/manifest/source syntax, provider capture,
artifact verification and installation remain open.

G-016 adds the separately versioned captured pruned main-directive profile.
`go-pruned-directives.test.ts` covers exact/path-wide precedence, excluded
required versions, replacement-controlled legacy expansion, `/v2` identity,
root-upgrade stabilization, absent versus captured-but-unexpanded sources,
missing source without fallback, wrong declared identity, byte/digest and parsed
metadata disagreement, malformed/duplicate/unsupported rules, source collisions,
and 2/4/9-root work growth with both traversal ceilings. No checksum trust is
inferred from raw capture digests. Earlier Go owner/parser tests remain selected.

The Go 1.27.1 oracle adds six combined-rule cases: exact, path-wide, both with
precedence, a legacy replacement branch, an excluded explicit root, and an
upgraded explicit root. It compares selected original coordinates and remote
source coordinates, retaining the main/source bytes and results under
`.temp/package-go-oracle/`. The pruned `/v2` replacement has only `.info`
metadata in the proxy: its unneeded `.mod` file is absent. Root stabilization
was added after native Go exposed the different dependency sets contributed
by the lower and selected root versions; the old pruned receipt profile retains
its previous behavior.

The focused `go-pruned-directives-api.test.ts` uses real Account OAuth tokens,
Access principals, Main routes and PostgreSQL. It checks exact private creation
and read, separate scopes, another principal's 404, replay, byte-only and capture
inventory key conflicts, incomplete and unsupported outcomes, malformed/duplicate
rule refusal, wrong source identity, immutable storage and inactive-principal
fencing. Its provider responses are fixed captured-source fixtures. The
coordinated physical owner-cut test restores all six Go receipt profiles and
their original keys; the new profile also replays from restored private captures
with provider access disabled. These remain partial PKG05/PKG12/PKG13 evidence;
live provider selection, workspace/local combinations, verification of all
captures, general release versions, locks and installation remain open.
The stable focused API run `20260926t070954-58eec4` passed; physical restore
`20260926t070613-9229b0` passed all six Go receipt versions. The older snapshot
and capture API files also passed in selected run `20260926t070613-249119`,
whose new API case failed before the matcher repair. All 26 selected Go unit
tests, the 19-case native oracle, backend static checks and documentation checks
passed. These are worker diagnostics; the manager verifies merged source.

The pinned Bun 1.4.2 nested `toMatchObject` with an `expect.arrayContaining`
value mutated the actual receipt's evidence array into the matcher object in a
minimal local reproduction. The new API fixture uses literal checks and exact
coordinate lookup before comparing persisted/read/replayed receipts. Other
resolver fixtures using nested asymmetric matchers should avoid reusing the
matched object as a later expected receipt; no broader matcher migration is
included in this slice.

G-005's local-replacement slice passed `yarn package:go-oracle` on pinned
Go 1.27.1 with `go 1.16` files and a generated local module directory. Its
version-specific local rule overrode a path-wide rule, and native/REZICS build
lists and selected local source identities matched. The pinned tool did not
assign the local bytes a remote version or checksum. Selected unit cases cover
source requirements, missing local bytes, missing remote captures, changed
digest, duplicate/conflicting rules, absolute/parent path refusal and newer
`go` directive refusal. Real isolated Main/Access/PostgreSQL integration
`20260926t044718-5a4de1` covered private scoped resolution/read, exact local
bytes and digest, idempotent replay, changed-key conflict, missing source,
digest/path/rule refusals and inactive-principal denial. This is partial
PKG05/PKG12 evidence. Go 1.17+ pruning, live provider sets, checksum provenance
for remote captures and package lock/installations remain separate work.

Selected unit cases in [`go-mvs.test.ts`](../../tests/qa/unit/go-mvs.test.ts)
and real PostgreSQL/Main API integration `20260925t221834-907295` passed the
first `go-mvs-stable-unpruned-v1` profile. The unit graph selected the highest
required version per module path, retained a dependency found only in a lower
visited version, kept a `/v2` path distinct, and ignored an unrequired newer
release. Missing required manifests and partial declared coverage returned
`incomplete-source-data`; a declared replacement returned
`unsupported-semantics`; a 129-version chain returned `budget-exhausted`.
The API stored one immutable private request/outcome under an idempotency key,
replayed it exactly, rejected a changed request on that key and denied another
principal or inactive owner. This is partial PKG05/PKG13/IAM10 evidence. The
Account verifier in the API fixture was isolated; the snapshot was supplied
by the caller rather than captured from a live provider.
At that batch pseudo-versions, replace/exclude/retract, Go 1.17+ pruning, checksum provenance,
general conflict outcomes and locks/installations remain open.

Selected real Account/Access/Main/PostgreSQL integration
`20260925t222044-4cf935` passed the package OAuth boundary. A
`package:read` token could not create a Go resolution; a `package:resolve`
token created one but could not read it. The owner read with `package:read`,
another active principal received 404, and deactivation denied both later
operations. This is partial IAM10/PKG05/PKG13 evidence; the selected Go profile
still has no live module capture.

`yarn package:go-oracle` compared the B51 graph against native Go 1.27.1 using
`go list -mod=mod -m all` with a `go 1.16` main module and a local file proxy.
The official archive was SHA-256 verified before extraction. The native and
REZICS six-module build lists matched exactly: two direct roots, a selected
higher `c` version, a separate `/v2` module, a transitive `d` found through the
lower visited `c`, and `e` from the selected `c`; the unrequired `d v1.9.0`
was absent. The result is retained locally at
`.temp/package-go-oracle/result.json`. This is partial PKG05/PKG12 evidence
for one fixed snapshot only. That first command did not fetch live module
metadata, verify provider checksums or build packages.

The v2 main-directive profile adds exact-version exclusion and version-specific
module replacement. Unit tests cover ignored excluded requirements, replacement
source manifests, missing source data, declared-module mismatch, source
collision and fork source identity. The pinned oracle now compares three fixed
snapshots: baseline, same-path replacement plus exclusion, and fork replacement
plus exclusion. Native and REZICS build lists and replacement source identities
matched in all three. The selected real PostgreSQL/Main API test exercises v2
private write and exact read. This is partial PKG05/PKG12 evidence. At that
batch, wildcard and local replacements, provider capture and checksum evidence
remained open.

The B72 path-wide remote replacement cases use one source for both visited
versions of an original module and an exact-version override for the selected
version. The pinned native Go 1.27.1 oracle matches both build lists and
selected source identities; it also matches a superseded exact replacement
whose source is the ultimately selected higher version. Unit and private API
checks cover duplicate wildcard refusal, missing source, exact precedence and
immutable read. This remains partial PKG05/PKG12 evidence for bounded Go 1.16
snapshots; local directory replacement is still unsupported.

The B73 pseudo-version cases compare two timestamped `v1` revisions, a `v2`
path and a prerelease-derived pseudo-version against its stable tag. Native Go
1.27.1 and the bounded resolver select the same build lists in both local
proxy scenarios. The captured-manifest parser retains those exact requirements;
the v1 stable-tag capture operation rejects a pseudo-version before any
provider fetch. Selected PostgreSQL/Main resolution `20260926t033758-22bd61`
and stable-tag capture `20260926t033835-c14c92` integrations passed with
private exact read and the existing capture contract. At that batch,
pseudo-version source capture and build metadata remained open, so
PKG05/PKG12/PKG13 stayed partial.

The B74 exact pseudo-version capture profile retains two fixed-origin proxy
responses without a version-list membership claim. Unit checks cover the
two-request path, timestamp mismatch and refusal of a stable tag. The private
PostgreSQL/Main API case checks v2 immutable storage, exact read, replay without
refetch, other-principal denial and capture-derived MVS with explicit pseudo
selection evidence. Selected capture/checksum-trust integration
`20260926t034444-a51524` and coordinated physical restore
`20260926t034509-cf6c9e` passed with the new owner column. This remains
partial PKG05/PKG14/PKG20 pending signed checksum verification for an exact
pseudo-version and broader provider data.

The B75 pinned Go 1.27.1 archive's `src/cmd/go.mod` retains exact
`rsc.io/markdown@v0.0.0-20240306144322-0bf8f97ee8ef`; its `src/cmd/go.sum`
pins both module and `go.mod` h1 values. The bounded checksum oracle captured
only that version's `.info` and `.mod` from `proxy.golang.org`, calculated
`h1:8xcPgWmwlZONN1D9bjxtHEjrUtSEa3fakVF8iaewYKQ=` from the exact manifest
bytes (SHA-256 `038b5839adbc1838c667b9ba684db797ef32907e6786328fff0ca0ed3d826994`),
and matched Go's verified `GoModSum` and the official `cmd/go.sum`. The signed
`sum.golang.org` lookup includes record 23,408,365 for the same path, version
and h1; bounded tiles prove inclusion in its 65,255,406-record tree. The
fresh signed `/latest` was slightly older (65,255,335 records); bounded tiles
proved that it is a prefix of the lookup tree. The Content trust owner now
accepts this ordering and advances its durable checkpoint to the newer signed
lookup head after validating both. A selected isolated PostgreSQL test covered
private exact read, source/capture binding and refusal of a changed record;
unit tests cover version, native checksum, capture bytes and signed tree
mismatches. This closes B75's exact pseudo provenance assertions as partial
PKG05/PKG14/PKG20 evidence. Wider Go syntax and ecosystems, lock replay and
live-refresh cases remain open.

The v2 profile also reports retracted selected versions as advisories from the
highest supplied release manifest, without changing the build list. A fourth
local Go oracle scenario matched both the selected version and native
`go list -m -u -json` retraction rationale. Unit and real PostgreSQL/Main API
tests exercise the advisory and immutable read. This remains partial PKG05
evidence because the latest-release claim and module bytes are supplied by the
caller, not captured from a provider.

The first Go proxy capture operation passed a fixed-origin/bounded-response unit
case and isolated PostgreSQL/Main API integration `20260925t224146-39f3c5`.
The API test covered separate capture/read scopes, private exact read, replay
without refetch, changed-key conflict, immutable row and inactive-principal
denial with a deterministic proxy response. `yarn package:go-probe` then fetched
one live `golang.org/x/sync@v0.1.0` observation from `proxy.golang.org` on
2026-09-25 22:42 UTC: 23 stable tags in the 175-byte list, exact info and
25-byte manifest, with raw digests in `.temp/package-go-provider/probe.json`.
This is partial PKG05/PKG20/IAM10 evidence. Real Account token qualification,
Go manifest parsing, checksum-database verification and resolution from the
captured bytes remain open.

Selected real Account/Access/Main/PostgreSQL integration
`20260925t224359-6036a4` qualified `package:capture` as a distinct
authorization-code token scope. A read-only token made no provider request;
the capture-only token made three bounded requests but could not read. The
owner read with `package:read`, another active principal received 404, and
deactivation blocked capture and read. This is partial IAM10/PKG05/PKG20
evidence; it does not establish checksum or parser provenance.

The conservative captured-manifest parser passed grouped and single
`require` cases, refusal of unsupported syntax and a pinned native
`go mod edit -json` comparison for the baseline fixture. Selected real
PostgreSQL/Main API integration `20260925t224700-d2703f` returned the parsed
manifest with an exact private read. A fresh live proxy observation at
2026-09-25 22:47 UTC parsed `golang.org/x/sync@v0.1.0` as a module with no
requirements or `go` directive, and therefore did not claim Go 1.16 profile
compatibility. This is partial PKG05/PKG13 evidence. Provider-derived MVS,
checksum provenance and broader Go syntax remain open.

The captured-resolution API passed isolated PostgreSQL/Main integration
`20260925t225211-037dc3`. Two private captured `go 1.16` manifests produced
the expected A→B build list with immutable capture IDs and raw digests in the
resolution request. Omitted B returned incomplete data; a captured manifest
without compatible `go` directive returned unsupported semantics. Another
principal could not use the capture IDs; private read, changed-key conflict and
idempotent replay passed. This is partial PKG05/PKG12/PKG13 evidence. Go checksum
verification, a captured main-module file and broader Go syntax remain open.

Selected real Account/Access/Main/PostgreSQL integration
`20260925t225337-7e36da` also fenced the capture-derived resolution route.
A `package:capture` token could not resolve, an active other principal could not
use the capture ID, the owner's `package:resolve` token produced an explicit
unsupported outcome for a captured manifest without a Go 1.16 directive, and
deactivation denied the later request. This is partial IAM10/PKG05/PKG13
evidence; checksum verification remains open.

The capture API now reports calculated Go `go.mod` `h1:` alongside raw SHA-256.
The empty-file reference constant, a fixed live manifest, unit tests and real
PostgreSQL/Main API integration `20260925t225611-b2a623` passed. The pinned
`yarn package:go-checksum-oracle` used Go 1.27.1 with `sum.golang.org` enabled
on `golang.org/x/sync@v0.1.0`; Go's verified `GoModSum` equalled the calculated
`h1:RxMgew5VJxzue5/jJTE5uejpjVlOe/izrB70Jof72aM=`. Diagnostic metadata is
under `.temp/package-go-checksum/result.json`. This is partial PKG05/PKG14
evidence. Main still computes the value without verifying a signed sumdb record.
A fresh-cache metadata-only `go list -m -json` probe fetched the manifest without
the module archive, but returned neither checksum field. It is diagnostic only;
the Main API still needs a reviewed signed-verifier and trust-state design.

The retained main-manifest resolution request passed isolated PostgreSQL/Main
integration `20260925t230359-2d9c7b`. Main decoded canonical base64 `go.mod`,
derived its module path and direct requirements, and preserved exact text and
SHA-256 in the immutable v3 request. A closed captured A→B graph solved; exact
private read, idempotent replay and changed-key conflict passed. Another
principal could not use the captures, malformed base64 was rejected, and an
unsupported main `replace` directive or incompatible `go 1.17` returned no build list. This is partial
PKG05/PKG12/PKG13 evidence; signed sumdb verification and wider Go syntax remain
open.

A bounded signed-tree primitive passed a fixed real `sum.golang.org` note
retained by Go 1.27.1, plus malformed UTF-8, tampered tree text, tampered
signature, wrong signer and size-limit refusals. The live
`yarn package:go-checksum-oracle` now extracts Go's exact lookup note and checks
it with the pinned public key. This is partial PKG05/PKG14 evidence. No lookup
record has been authenticated by an inclusion proof in Main, and no monotonic
trusted tree state exists, so the API still exposes only a calculated h1.

The record inclusion primitive passed selected synthetic trees of 1, 2, 3, 4,
5, 7, 8, 9 and 17 records with every leaf position, plus changed record,
missing/extra hash, wrong index and wrong root refusals. It follows Go's
`tlog.CheckRecord` order but is not yet supplied by authenticated live tiles.
This remains partial PKG05/PKG14 evidence.

The bounded lookup diagnostic passed the fixed live
`golang.org/x/sync@v0.1.0` record: seven `sum.golang.org` tiles reconstructed
the audit path to the signed 65,209,736-record tree, and the included
`/go.mod` h1 equalled the fresh proxy capture. A synthetic 300-record tree
crossed height-eight tile boundaries at records 255/256; redirect and oversized
tile refusals and a mismatched capture h1 refusal passed. The diagnostic result
is `go-sumdb-included-unpinned-v1`; it is partial PKG05/PKG14 evidence because
monotonic tree consistency and durable evidence remain open.

The tree consistency primitive passed a synthetic 256→300-record extension,
equal-size identity, and rollback, fork, changed prior root and changed new
root refusals. A live fresh signed `/latest` at 65,215,452 records proved an
extension of the included lookup's 65,209,736-record tree through five bounded
tile reads. This is partial PKG05/PKG14 evidence; Main has no persistent
monotonic checkpoint or private capture-bound proof receipt yet.

The Content PostgreSQL trust owner passed isolated integration
`20260925t232455-b764c5`. A retained real signed lookup fixture and captured
`golang.org/x/sync@v0.1.0` manifest produced an immutable private receipt and
baseline checkpoint. Exact read after a new store instance revalidated the
signed inclusion evidence; same-key replay made no lookup, another principal
could not use the capture, and key conflict and DB mutation guards passed. An
inconsistent candidate advanced neither head nor receipt; a later real signed
head fixture advanced history, and concurrent same-key writes converged. The
consistency function was injected in this owner test; separate synthetic and
live tile tests exercise the real function. This remains partial PKG05/PKG14
until scoped API exposure and broader rollback/recovery checks.

The scoped Main API passed isolated Account-verifier/Access/Main/PostgreSQL
integration `20260925t232828-32bfc4`. A read-only token could not verify; a
verify-only token wrote but could not read; an active other principal could not
use the capture or read the receipt. Owner exact read, idempotent replay without
a second lookup, changed-capture key conflict and deactivation denial passed.
The test used retained real signed lookup/latest fixtures with an injected
consistency function, while separate live and synthetic tests exercise that
function. This is partial PKG05/PKG14/IAM10 evidence pending real Account OAuth
and recovery.

Real Account authorization-code tokens qualified `package:verify` in the
Account/Access/Main/PostgreSQL integration `20260926t030902-dbecb4`. Read-only
and capture-only tokens failed before checksum work; another active principal
could not use the capture or read the receipt. The owner's verify-only token
created the private receipt but could not read it; `package:read` could read,
replay made no second lookup, and principal deactivation blocked both routes.
The checksum provider was represented by retained signed lookup/latest fixtures
and an injected consistency function here; separate live and synthetic checks
exercise the real verifier. IAM10/PKG05/PKG14 remain partial pending full
recovery and broader package behavior.

The coordinated stopped-owner fault/recovery drill `20260926t031243-858f24`
retained a Go proxy capture, signed checksum checkpoint and inclusion receipt
through a physical PostgreSQL backup and isolated restore. The restored
Content owner read the exact receipt offline and replayed its idempotency key
without fetching the proxy or checksum database. This adds OPS03/PKG14
recovery evidence. At that batch the signed Content coverage still excluded
`pkg.*` tables.

The selected coordinated recovery and Account erasure run
`20260926t032239-fad04d` passed with version-two signed Content coverage of
all five package tables. It rejected a changed restored checksum checkpoint
before releasing the graph hold; after restoring the checkpoint, release passed.
Direct capture with zero graph Content references still covered the package
rows, and the capture command now requires the Content owner for every cut.
A complete-backup rollback still needs an independent checkpoint.
