# Universal package and dependency management

## Scope

REZICS supports cataloging, dependency resolution, lock creation, artifact
acquisition/verification, installation planning, activation, update, rollback and
removal. Rust, TypeScript/JavaScript, Go, Nix, Minecraft and major mod sites are
conformance targets. Genericity means one coherent model and workflow with
ecosystem semantics, not one universal version comparator or solver strategy.

## Model and identity

| Object | Contract |
| --- | --- |
| SoftwareProject | Creative/product identity and common Main Version entry. |
| PackageCoordinate | Ecosystem + registry/origin + namespace/name; aliases retain source evidence. |
| Release | An identified published version with original version syntax and ecosystem comparison profile. |
| Artifact | Exact downloadable/buildable object, integrity evidence, platform applicability and source. |
| Requirement | Typed dependency/compatibility proposition with native selector, conditions, scope and provenance. |
| ResolvedInstance | Selected release/artifact within an environment and co-installation/peer scope. |
| Environment | OS, architecture, ABI, runtime/toolchain, host/target, loader/game version, side and requested features. |
| Resolution | Request + candidate-source snapshot + policy/profile + solution or explicit failure. |
| Installation | Materialized instance topology, owned files/paths, activation state and recovery journal. |

Requirement forms include hard/optional/peer/build/runtime/test dependencies,
embedded/provided capabilities, incompatibilities, alternatives, feature activation,
workspace/path/git selectors and load-order constraints. Preserve source syntax
and unsupported residuals. Package URL is an exchange identifier, not a replacement
for native identity or proof that two providers distribute identical bytes.

## Resolver architecture

Jena stores and queries dependency facts, evidence and results. Package runtime
loads bounded candidate closures into a solver adapter. The shared Rust constraint
core can use Resolvo, with PubGrub as a comparison; ecosystem profiles own version
ordering, preferences, instance scopes and special rules. Go MVS and Nix evaluation/
lock semantics use appropriate adapters rather than pretending to be SemVer SAT.

Candidate loading is lazy, cached within a source snapshot and cancellable. Do not
download an entire registry or enumerate every possible environment before solving.
Track why each instance/feature is selected, rejected alternatives and a useful
conflict explanation. A graph cycle is not universally invalid: dependency, input,
build and load-order graphs have different cycle contracts.

Results distinguish solved, unsatisfiable, incomplete-source-data,
unsupported-semantics, cancelled and budget-exhausted. A timeout is not an unsat
proof; an inaccessible dependency is not an empty dependency set.

The first callable profile, `POST /v1/package-resolutions`, accepts
`go-mvs-stable-unpruned-v1`: a bounded caller-supplied snapshot of parsed Go
module requirements with a `go 1.16` graph declaration. It supports stable
`vM.m.p` tags and module-path major suffixes. It visits each required module
version's manifest, then selects the highest required version per module path;
extra available releases do not affect the build list. `GET` on the returned
resolution ID privately re-verifies the immutable request digest and outcome.
`package:resolve` and `package:read` are separate Account scopes, both fenced by
an active Access principal. The owner stores request, digest and outcome as an
immutable PostgreSQL row under an idempotency key. Missing required manifests or
declared partial coverage yield `incomplete-source-data` with no build list;
declared unsupported clauses yield `unsupported-semantics`, and a traversal over
128 versions or 512 requirement visits yields `budget-exhausted`. This v1 profile
does not fetch modules, parse `go.mod`, verify checksum provenance, apply
replace/exclude/retract, perform pruned Go 1.17+ loading, generate a lock or
assert an actual Go build. A caller's coverage declaration is retained evidence
about its supplied snapshot, not independent proof of upstream completeness.
The [Go Modules Reference](https://go.dev/ref/mod) defines the MVS graph rule,
module-path major suffixes and the effect of main-module replacements/exclusions.
The fixed `go 1.16` snapshot used in B51 also matched the pinned Go 1.27.1
native build list through `yarn package:go-oracle` and a local file proxy. This
proves correspondence for that graph, not the unimplemented Go clauses or live
provider provenance.
`go-mvs-stable-unpruned-main-directives-v2` adds main-module version-specific
`replace` and exact-version `exclude` arrays to the same bounded `go 1.16`
snapshot. Excluded requirements are ignored before loading. A replacement
loads the source release's requirements while preserving the original path and
version in the build list; `selectedSources` reports the source for each
selected replaced entry. A remote replacement manifest must declare the
original module path. Missing source manifests return incomplete data, and a
source selected elsewhere is rejected. The immutable v1 request and result
keep their prior shape. The local Go oracle matches both same-path and fork
replacement combined with an exclusion. Wildcard replacements, local directory
replacements and `go 1.17+` graph pruning remain unsupported and
must be declared in `coverage.unsupportedClauses`.
The v2 release manifest may include bounded `retractions` from its `go.mod`.
The highest supplied release per original module path provides the retraction
advisory. A selected retracted version stays in the build list and appears in
`retractedSelected` with the announcing release and rationale, matching native
Go's exact-version versus upgrade distinction. This is only an advisory over
caller-supplied manifests; it does not prove that the announcing release is the
actual latest provider version or that its bytes/checksum are authentic.

`POST /v1/package-sources/go` captures one stable tagged module version from the
fixed `proxy.golang.org` origin, with no caller-controlled URL or redirect. It
reads the tagged-version list, exact `.info` and exact `.mod` through three
bounded requests (128 KiB, 4 KiB and 128 KiB; five seconds each). The private
`GET /v1/package-sources/go/{capture}` returns the stable tags observed, raw
SHA-256 digests and byte counts, version timestamp and exact manifest text.
PostgreSQL retains all three raw responses in an immutable row and rechecks their
combined digest on read. `package:capture` and `package:read` are separate scopes
behind the active Access principal fence; the idempotency key avoids a repeated
provider request on replay. The version list is a non-atomic observation of
tagged releases, and SHA-256 of raw response bytes is not the Go `h1:` module
checksum. Captured bytes are not yet assembled into a resolver snapshot or checked
against the Go checksum database. The fetch path is O(response bytes plus listed
versions), with three fixed proxy requests and one indexed PostgreSQL insert/read.
The capture read includes `manifest.parsed`, a conservative line-oriented parser
for simple `module`, `go` and `require` directives. It handles bounded grouped
requirements and comments; unfamiliar directives, pseudo-versions, quoted
syntax, duplicate paths and mismatched module identity return
`unsupported-syntax` with no requirements. `compatibleWithUnprunedGo116` is true
only for a clean parse with explicit `go 1.16`. The view is derived from the
retained raw bytes on every exact read and is not yet attached to a
provider-derived resolution or Go checksum-database proof.
Each exact capture read also calculates the Go `go.mod` `h1:` value from the
retained bytes using Go's single-file dirhash format. A pinned native Go 1.27.1
diagnostic matched this value against `GoModSum` from a fixed live
`go mod download` with `sum.golang.org` verification enabled. The API field is a
calculation, not a statement that Main verified a signed checksum-database
record; in-service provenance verification is still required.
`POST /v1/package-resolutions/from-captures` accepts a main module, direct
requirements and up to 128 private capture IDs. Under `package:resolve`, Main
reads those immutable captures in one principal-scoped PostgreSQL query, derives
each release's requirements from its retained manifest, and persists a v3
resolution request with capture IDs and the three raw response digests. The
solver reports a missing required captured version as `incomplete-source-data`
without a build list. Unsupported parser syntax or a directive outside explicit
`go 1.16` yields `unsupported-semantics`. A closed supported graph can solve;
read with `package:read` re-verifies its immutable request/outcome. This does
not independently authenticate the proxy bytes through the Go checksum database
or capture the caller's main-module file. Owner work is one indexed capture
selection plus bounded parsing/traversal and one indexed resolution insert/read.
The first profile indexes at most 256 supplied release manifests and visits at
most 128 distinct required versions and 512 requirement edges. Local work is
O(S + E) for supplied manifests and traversed requirements, plus one indexed
PostgreSQL insert/read; exact read repeats the bounded calculation. No registry
or artifact bytes are fetched. Physical plans and a live-provider byte budget
remain to be qualified.

## Ecosystem profiles

| Profile | Required distinctions |
| --- | --- |
| Cargo | Features/resolver version, host/target and target predicates, multiple versions, native links uniqueness, yanked/locked releases and workspace overrides. |
| npm-family | Nested instances, peer host scope, optional dependencies, aliases, workspaces, overrides, engines/platforms and install-layout strategy. TypeScript is content/runtime metadata, not a separate universal package algorithm. |
| Go | MVS, module/major-version paths, pseudo-versions, replace/exclude/retract, workspace and checksum provenance. |
| Nix | Original/locked flake inputs, follows, content hashes, derivation outputs, build inputs versus runtime closure and evaluator/system identity. |
| Minecraft | Project/file/mod identity, loader/game/Java version, client/server, mandatory versus advisory dependencies, embedded providers and load order. |
| Mod sites | Provider-specific requirement grain, download eligibility, file/version applicability and incomplete or experimental metadata. |

See [ecosystem profiles](package-profiles.md) for implementation rules.

## Lock and installation protocol

Resolve against an explicit environment, request and source snapshot. Lock exact
instances, artifacts/digests, activated features, dependency edges, chosen profile
and solver policy. Main Version may recommend a channel but cannot replace an exact
artifact in a lock. Mutable tags/URLs resolve to observed immutable evidence or
remain explicitly unverifiable.

`planned -> fetching -> verified -> staged -> activating -> active`.
The install plan declares fetch/build/configuration steps, owned paths, conflict
rules, executable hooks, capabilities, expected prior generation and compensation.
Verify artifacts before use; extract into confined staging, detect traversal/path
collisions and retain rollback state. Activation switches a controlled generation
or uses a journaled adapter when atomic directory replacement is unavailable.

Update resolves desired state while preserving explicit pins; rollback restores
the chosen installation generation subject to current artifact/security eligibility.
Remove only files owned by the installation and preserve declared user data.
Interrupted operations inspect receipts and actual state before retrying.
Build scripts and package hooks run only through the approved executor with its
network/filesystem/secret/resource contract; metadata never authorizes execution.

## Live conformance

Each run obtains current provider contracts and suitable current version sets,
captures them once, then compares native-tool/profile behavior against the same
snapshot. Assert constraint satisfaction, selected feature/instance topology,
update/rollback meaning and explainable failures, not fixed release numbers or
identical lockfile formatting. Offline adversarial cases complement live data.
See [package acceptance](../testing/packages.md) and [live sources](../testing/source-conformance.md).

## Evidence

[Cargo](https://doc.rust-lang.org/cargo/reference/resolver.html),
[npm](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[Go modules](https://go.dev/ref/mod),
[Nix flakes](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake.html),
[Resolvo](https://github.com/prefix-dev/resolvo) and
[PURL](https://github.com/package-url/purl-spec) inform profiles; none certifies
their composition into REZICS. Download/indexing and full hosted execution remain
separately admitted operations even though package management is selected scope.

[Package plans](../implementation/package-plans.md) specifies requirement lowering,
instance keys, lock fields and recovery at each installation boundary.
