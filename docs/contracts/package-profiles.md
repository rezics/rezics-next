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
