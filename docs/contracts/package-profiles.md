# Package ecosystem profile decisions and remaining boundaries

The admitted profiles, their versions and receipts live in the
[package module](../../services/main/src/modules/package/); [package
acceptance](../../scripts/qa/cases/packages.ts) names the qualified scenarios and
pinned native versions. Native tools are oracles only for the recorded version,
target and captured input. A resolution receipt alone does not prove that an
artifact was fetched, installed or built. Profile versions are part of immutable
locks, so a new rule is a new profile version and earlier receipts keep their
replay meaning.

## Shared adapter interface

Each new adapter still needs an explicit contract for native syntax and source
identity, bounded candidate discovery, version/requirement semantics, environment
and feature interpretation, instance topology, conflicts, and lock/install import.
Unsupported clauses must remain visible. A shared public interface spanning all
these operations has not been admitted; the current profiles deliberately own
their different inputs and outcomes.

## Cargo

A caller lock authorizes a yanked release only when source, name and version
agree; a fresh resolution still denies it. A checksum mismatch is inconsistent
source data, not an unsatisfiable constraint. These distinctions follow Cargo's
[resolver 2 rules](https://doc.rust-lang.org/cargo/reference/resolver.html#feature-resolver-version-2),
[index schema](https://doc.rust-lang.org/cargo/reference/registry-index.html#json-schema),
[native-library uniqueness](https://doc.rust-lang.org/cargo/reference/resolver.html#links)
and [yanked eligibility](https://doc.rust-lang.org/cargo/reference/resolver.html#yanked-versions).
General backtracking, workspace/patch/git resolution, rust-version fallback,
build scripts, artifact integrity and installation are not established.

## npm, pnpm and Yarn

Installation slots and peer hosts stay distinct from package names. `validated`
means an admitted supplied tree is internally consistent, not freshly solved or
installed. REZICS deliberately requires literal sources and SRI, rejects
unproven alias/package identity, and treats an incompatible declared engine
target as invalid even where npm normally warns; the native-comparison tests
record these stricter admission decisions. The bounded registry profile records
selection/layout divergences rather than treating an equal logical package set
as an equal physical tree. An omitted optional branch cannot hide a required
peer or a wrong alias. The comparison is pinned to npm 11.19.1's
[virtual tree](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/arborist/load-virtual.js),
[peer edges](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/edge.js),
[optional region](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/optional-set.js)
and [engine checker](https://github.com/npm/cli/blob/v11.19.1/node_modules/npm-install-checks/lib/index.js).

General ideal-tree solving, arbitrary ranges/overrides and install layout,
pnpm/Yarn strategies, lifecycle execution and artifact verification remain
separate qualifications; a profile that has not admitted a clause reports it
unsupported.

## Go

Selected build-list versions stay separate from capture and checksum
provenance. Local `./` replacements use caller-supplied `go.mod` bytes; the API
never reads a caller-named server path. Pruned graphs may leave a selected
module unexpanded, and roots reload after an upgrade so a displaced root's
requirements do not remain. This follows the [module reference](https://go.dev/ref/mod#graph-pruning)
and [Go 1.17 graph pruning](https://go.dev/doc/go1.17#go-command). For excludes
the profile follows the reference's [directive rule](https://go.dev/ref/mod#go-mod-file-exclude)
and pinned Go behavior rather than the older next-higher-version description in
its MVS overview. MVS cannot be replaced with highest-available search, and
retraction does not retroactively erase an admitted build-list node.

## Nix

Original and locked flake inputs, follows edges, source hashes, derivations and
runtime closure observations stay distinct. The input graph may contain cycles;
evaluation/build is execution rather than safe manifest parsing, so evaluator
identity and an unobserved closure stay explicit
([flake reference](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake.html)).

## Minecraft loaders and providers

Fabric hard `depends`/`breaks` stay separate from advisory
`recommends`/`conflicts`; Forge and NeoForge side/order rules are preserved;
provider relations keep Modrinth project/version grain, CurseForge
embedded/include meaning and Steam advisory/Collection meaning. A missing or
inaccessible response is not an empty dependency set. Loader semantics follow
the [Fabric manifest](https://wiki.fabricmc.net/documentation:fabric_mod_json_spec),
[Forge metadata](https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/)
and [NeoForge metadata](https://docs.neoforged.net/docs/gettingstarted/modfiles/);
[source conformance](../testing/source-conformance.md) records provider access gaps.

## Cross-ecosystem composition

The exact package lock composes segments under declared process/path/ABI
scopes. Matching names or version strings across ecosystems are not
interchangeable, and shared artifact bytes prove only those bytes, not
equivalent package semantics or rights. Composing Skill requirements, Rust
binaries, Nix and mod/runtime dependencies needs explicit capability and
environment matching.
