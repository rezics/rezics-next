# Package ecosystem implementation profiles

## Shared adapter interface

Adapters parse native manifests/coordinates, enumerate bounded candidates, compare
versions, lower requirements, interpret environment/features, choose solving policy,
produce instance topology, explain conflicts and import/export lock/install plans.
Keep original syntax and exact source observations. An unsupported clause cannot
silently disappear. An adapter's semantics/profile version is part of every lock.

## Cargo

Represent package/source identity, compatible and incompatible versions, target
predicates, optional/default features, build/dev/runtime roles and resolver version.
Feature unification depends on resolver/host-target context. Native `links` names
constrain co-installation even when ordinary package versions could coexist.
Preserve yanked eligibility for fresh resolution versus an admitted existing lock.
Compare with Cargo's resolved graph/features for the same captured manifests,
toolchain/resolver and target, not merely package counts.

The first `cargo-index-exact-resolver2-v1` profile is a deliberately bounded
fresh resolution. The caller supplies canonical base64 of one root `Cargo.toml`,
its SHA-256, one exact registry index URL as source identity, and canonical
base64 plus SHA-256 for each complete newline-delimited index file. The request
names a target and host triple, root features and default-feature selection.
Main stores those bytes and the outcome in a private immutable resolution.
The root manifest must declare `resolver = "2"`, one package, and dependencies
from the named `snapshot` registry. The admitted version requirements are exact
`=major.minor.patch` only. A selected index record must use schema v1,
non-yanked releases, no `links`, no `features2`, and exact same-registry
dependencies. Incompatible exact versions retain distinct instance identities;
compatible exact version collisions return unsupported until a native conflict
profile is proved. The supported feature grammar is direct features, `default`,
`dep:name` and `name/feature`; weak features, renames, workspaces, path/git
sources, patches, overrides, dev selection and existing locks are outside v1.
Target predicates are only absent or `cfg(target_os = "linux")` and
`cfg(target_os = "windows")` for the admitted Linux/Windows triples. This
profile has no rust-version fallback, artifact download or build claim.

The result has a lock selection keyed by registry URL/name/version and an
active instance graph keyed by that identity plus host/target role. Edges keep
their dependency kind, target predicate and requested features; each instance
keeps its activated features. Optional and nonmatching target dependencies may
be lock-selected yet inactive. Missing required index files/versions produce
`incomplete-source-data`; unfamiliar syntax or unsupported semantic clauses
produce `unsupported-semantics`; a traversal limit produces
`budget-exhausted`, with no partial graph presented as solved. Malformed
base64/digests and duplicate or changed source identities are rejected. The
bounded profile allows at most 32 index files, 128 releases, 256 dependency
edges and 512 feature activations; each raw file is at most 65,536 bytes.
The full Cargo solver, `links` conflicts and yanked lock eligibility remain
outside this profile until separately proved against native Cargo.

This boundary follows Cargo's [resolver 2 feature and target rules](https://doc.rust-lang.org/cargo/reference/resolver.html#feature-resolver-version-2),
[registry index schema](https://doc.rust-lang.org/cargo/reference/registry-index.html#json-schema),
and [metadata graph fields](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html).

The separately versioned `cargo-index-exact-resolver2-v2` profile admits the
index's optional `links` value. Absent/null means no native library; admitted
names match `[A-Za-z_][A-Za-z0-9_-]{0,63}` and remain case-sensitive. A nonstring
value is malformed; other string syntax is unsupported. Root-manifest `links`
and build-script execution remain outside the profile. All v1 requests retain
their original unsupported-`links` behavior and stored v1 receipts replay
without adding fields or changing their outcome.

V2 lock selection enables all root features and optional dependencies, then
propagates the requested/default dependency features across all targets. Inactive
transitive optional dependencies are not selected. This versioned correction is
necessary to avoid a false `links` proof; v1 traversal remains frozen for replay.
`featureActivationCount` in v2 includes lock and active-graph expansion work under
the shared 512-activation budget. V2 first completes its bounded selected graph
and feature validation. Missing source data, unsupported clauses and exhausted
budgets retain their distinct
outcomes; none is relabeled unsatisfiable. Only distinct selected
registry/name/version identities claiming the same native name prove
`unsatisfiable`. One identity used in both host and target roles is one owner.
Unselected index releases cannot introduce a conflict. The v2 outcome adds
`linksConflicts`, empty except on unsatisfiable outcomes. Each conflict has
`kind: native-links`, the exact `links` name and sorted `packages` containing
`id`, `source`, `name`, `version` and sorted active `roles`. A lock-selected but
inactive owner has no active roles. Conflicts sort by native name and package
identity; unsuccessful outcomes keep the normal selected/instance/edge arrays
empty, so the witnesses cannot be mistaken for a usable lock or build plan.

The design follows Cargo's [native-library uniqueness rule](https://doc.rust-lang.org/cargo/reference/resolver.html#links)
and [index links metadata](https://doc.rust-lang.org/cargo/reference/registry-index.html#json-schema).
The bounded native differential fixture establishes both conflict and solvable
cases on Cargo 1.98.1; the [package tests](../testing/packages.md) record its scope.
It does not prove
general backtracking, yanked fresh/locked eligibility, artifact validation or
installation; PKG02/PKG12/PKG13 remain partial.

The separately versioned `cargo-index-exact-resolver2-v3` adds explicit
`existingLock`: null means fresh resolution; an object carries canonical
`bytesBase64` and `sha256` of caller-supplied `Cargo.lock`. It retains v2's
manifest/index/feature/links boundary. V1/v2 parsing, outcomes and receipt replay
remain frozen. V3 admits boolean index `yanked` values, including on unselected
releases. Only a required yanked release lacking an exact retained
name/version/source lock entry is unsatisfiable; mere lockfile presence grants
no eligibility.

The lock grammar is TOML lock format 4, declared by a bare or quoted literal
root `version` key and a TOML integer token (not a float), with `[[package]]` records containing
stable `name`/`version`, optional `source`, optional lowercase SHA-256 `checksum`
and optional `dependencies`. Registry sources must be literal
`sparse+https://…/` identities; eligibility requires exactly
`sparse+` plus the request's registry URL, with no URL aliases or protocol
substitution. Other HTTPS sparse sources and source-less historical entries
are retained but cannot authorize a release from this request's registry.
Dependency references admit a name, a name plus stable version, or a name plus
stable version and parenthesized sparse source. They are retained historical
references, not an assertion that the current graph is closed. Current
requirements and features are resolved from the supplied manifest/index.
Git sources, patches, replacement fields, other lock formats and unknown fields
return unsupported semantics. Invalid TOML, malformed identities/checksums,
duplicate package identities, invalid UTF-8/base64 or a raw digest mismatch are
422 errors. The lock is at most 65,536 bytes, 129 package records and 256
historical dependency references; record/reference overflow is budget exhausted.

V3 does not implement `--locked` or `cargo update --precise`. Changing root
name/version or historical root edges does not discard an otherwise exact
eligible dependency; changing a dependency requirement never makes its old
version satisfy the new requirement. A missing lock checksum remains explicitly
absent and permits exact identity reuse, as native Cargo does. A supplied
checksum on a selected exact source/name/version must equal the current index
checksum, including for non-yanked releases. Disagreement yields
`inconsistent-source-data` with `checksumConflicts`, not an unsatisfiability
proof. Checksums of unselected historical entries have no effect.

Every v3 outcome adds `lockEvidence` (null until a supplied lock is admitted,
otherwise `provenance: caller-supplied`, its SHA-256, `version: 4`, package and
registry-package counts), `reusedYanked`, `yankedConflicts` and
`checksumConflicts`, alongside v2 `linksConflicts`. A solved outcome's
`reusedYanked` entries carry the exact selected identity, native lock source,
nullable lock checksum and index checksum. An unsatisfiable yanked witness
identifies the required package, expected lock source and index checksum.
Checksum witnesses carry both disagreeing checksum values. Witnesses sort by
package identity; failed outcomes keep selected/instance/edge and reuse arrays
empty. Missing current source, unsupported grammar and budget exhaustion take
precedence over conflict claims. The exact lock bytes and digest join the
immutable private request and idempotency digest; receipts never imply provider
capture, artifact verification, installation or a trusted prior build.

This boundary follows Cargo's [yanked-version eligibility](https://doc.rust-lang.org/cargo/reference/resolver.html#yanked-versions)
and [lock preference under changed requirements](https://doc.rust-lang.org/cargo/reference/resolver.html#lock-file).
The Cargo 1.98.1 native differential probe on 2026-09-26 establishes renamed
root reuse, checksum omission, checksum disagreement and exact source matching.
Those observations support this bounded caller-intent profile, not general
lock import or artifact integrity. PKG02/PKG12/PKG13 remain partial.

## npm, pnpm and Yarn

Package instances are scoped by dependency/peer environment; a map from package
name to one version is insufficient. Preserve peerDependencies and optional peers,
optional dependency platform behavior, aliases, workspaces, overrides, engines,
OS/CPU constraints and registry origin. Separate logical resolution from physical
hoisting/symlink/store layout. Each selected package-manager strategy has explicit
conformance rather than assuming identical layouts. Installation hooks remain
declared executable steps, disabled unless admitted by executor policy.

## Go

Use MVS over module requirements with module-path/major-version identity, pseudo-
versions and main/workspace replace/exclude rules. Retraction affects eligibility
under the selected operation; it is not an arbitrary retroactive graph deletion.
Keep checksum provenance and actual build list distinct from every hash in go.sum.
Module graph pruning/lazy loading follows the selected toolchain/profile. Do not
replace MVS with highest-available-version selection.

The `go-mvs-from-main-local-captures-v3` API profile admits only main-module
`replace` directives whose source is a bounded `./` relative directory. The
caller supplies each source identity and canonical base64 `go.mod` bytes with a
matching SHA-256. The private immutable `go-mvs-local-unpruned-v4` snapshot
retains the exact UTF-8 text, digest, main directives and remote capture
identities. The API never reads a caller-named server path. A local replacement
keeps the original module path and selected version in the build list, while
`selectedLocalSources` records the relative identity, declared module and raw
digest; it has no invented remote version or checksum. A `replace` does not add
a module unless a requirement reaches it. Exact-version rules override path-wide
rules. The profile accepts Go 1.16 unpruned manifests and single or grouped
local replacements; other main directives and newer pruning semantics return
`unsupported-semantics`. Missing caller-supplied source bytes return
`incomplete-source-data` with `missingLocalSources`. Invalid base64, digest,
absolute/parent paths and duplicate rules are rejected. The bounded resolver
returns `budget-exhausted` without a build list when traversal limits are hit.

The local-source cost is O(C + L + V + E) for C supplied captures, L supplied
local `go.mod` bytes, V visited module versions and E requirements. One bounded
owner query reads at most 128 private captures; the resolve write and replay
use a bounded insert plus keyed read. At most 32 local sources and 32 rules are
accepted, each manifest at most 65,536 bytes; traversal stops after 128 visited
versions or 512 requirements. Local resolution performs no host file or provider
network reads. These are per-request work limits, not module ecosystem limits.

The `go-mvs-from-main-pruned-captures-v4` API profile derives a Go 1.17–1.27.1
build list from an exact retained main `go.mod` and private remote capture IDs.
Its immutable `go-mvs-captured-pruned-v5` snapshot binds the main bytes and
SHA-256, parsed roots, each supplied capture ID and its list/info/manifest
digests, and each remote module's parsed `go` directive and requirements.
Every main `require`, including `// indirect`, is an explicit root. The resolver
reads each root's immediate requirements; it follows full transitive
requirements from a Go 1.16 module reached as an explicit root or through
another Go 1.16 branch. Requirements reached only from Go 1.17+ branches stay
selected without loading their manifests. Thus a selected module may lack a
retained `go.mod` while the build list remains defined; this is a graph result,
not an installation or source-integrity claim. A missing manifest needed for
expansion returns `incomplete-source-data`. Unsupported syntax or a missing,
older, or future `go` directive on a loaded manifest returns
`unsupported-semantics`; unsupported metadata on an unexpanded module cannot
alter this graph. Main `replace`/`exclude` and workspace directives remain
outside this profile. The Go 1.16 profiles remain selectable and unpruned.

The pruning cost is O(C + V + E) for C at most 128 supplied private captures,
V at most 128 expanded module versions, and E at most 512 queued requirements.
The owner reads captures in one bounded private query and uses the established
immutable write/replay path. It performs no provider or host filesystem read
during resolution. The separate local-file proxy oracle compares the build
list with pinned Go 1.27.1 and withholds a pruned transitive `.mod` file to
check lazy loading. This profile implements only the bounded captured graph;
live version sets, complete directive combinations, checksum verification of
these captures, locks and installation require their own qualification.

This pruning rule follows the [Go module reference](https://go.dev/ref/mod#graph-pruning)
and [Go 1.17 release notes](https://go.dev/doc/go1.17#go-command).

## Nix

Preserve original versus locked flake inputs, follows references and exact source
hashes. A flake input graph can contain cycles; it is not universally a build DAG.
Evaluate the selected system/profile through a bounded Nix adapter, record derivation
outputs/build inputs, and obtain runtime closures separately when available.
Evaluation/import-from-derivation and builds are execution, not safe manifest parsing.
Preserve evaluator/configuration identity and unobserved runtime closure explicitly.

## Minecraft loaders and providers

Distinguish registry project, release/file, declared mod ID, game/loader/runtime
and environment side. Fabric depends/breaks are hard constraints, while recommends/
conflicts are advisory and suggests is metadata under that profile. Forge and
NeoForge profiles preserve their own manifest schema, dependency range, side and
load-before/after conditions. Do not assume their fields/enums are interchangeable. Ordering
cycles can fail even when dependency selection succeeds. Embedded providers must
not be fetched twice or confused with independent installed instances.

Modrinth supports project/version-qualified dependency forms and required/optional/
incompatible/embedded meanings. CurseForge distinguishes required/optional/tool/
embedded/include/incompatible. Nexus file-version range APIs can be experimental;
record actual surface coverage and access gaps. Steam Workshop soft dependencies
cannot automatically become mandatory installation constraints. See [live matrix](../testing/source-conformance.md).

## Cross-ecosystem composition

A Skill may require an npm package, a Rust binary and a runtime. Resolve explicit
environment/capability requirements with each profile, then compose a plan under
declared process/path/ABI boundaries. Matching names or version strings across
ecosystems does not establish substitutability. Shared artifact digests prove only
the observed bytes, not equal package semantics or rights.

## Sources

[Cargo resolver](https://doc.rust-lang.org/cargo/reference/resolver.html),
[npm manifests](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[Go modules](https://go.dev/ref/mod),
[Nix lock semantics](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake.html),
[Fabric manifest](https://wiki.fabricmc.net/documentation:fabric_mod_json_spec),
[Forge mod files](https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/),
[NeoForge mod files](https://docs.neoforged.net/docs/gettingstarted/modfiles/),
[Modrinth version](https://docs.modrinth.com/api/operations/getversion/),
[CurseForge API](https://docs.curseforge.com/rest-api/),
[Nexus schema](https://github.com/Nexus-Mods/Vortex/blob/master/packages/nexus-api-v3/schema/openapi.yaml),
[Steam UGC](https://partner.steamgames.com/doc/api/ISteamUGC).
