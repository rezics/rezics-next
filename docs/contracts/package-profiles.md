# Package ecosystem profile decisions and remaining boundaries

The admitted request and receipt contracts live in the package module types,
validators and schemas. [Package acceptance](../testing/packages.md) names the
qualified scenarios; native tools are oracles only for the recorded version,
target and captured input. A resolution receipt alone does not prove that an
artifact was fetched, installed or built.

## Shared adapter interface

Each new adapter still needs an explicit contract for native syntax and source
identity, bounded candidate discovery, version/requirement semantics, environment
and feature interpretation, instance topology, conflicts, and lock/install import.
Unsupported clauses must remain visible. A shared public interface spanning all
these operations has not yet been admitted; the current profiles deliberately own
their different inputs and outcomes. Profile versions are part of immutable locks.

## Cargo

`cargo-resolution.ts` and its unit/native-oracle cases own the bounded exact-index
resolver 2 profiles. V1 supports fresh exact requirements and a restricted
feature/target grammar. V2 adds selected native `links` conflict witnesses; it
corrects lock feature expansion without changing v1 replay. V3 adds a supplied
format-4 lock, exact source/checksum consistency and yanked eligibility. A lock
entry authorizes a yanked release only when source, name and version agree; a
checksum mismatch is inconsistent source data, not an unsatisfiable constraint.
These distinctions follow Cargo's [resolver 2 rules](https://doc.rust-lang.org/cargo/reference/resolver.html#feature-resolver-version-2),
[index schema](https://doc.rust-lang.org/cargo/reference/registry-index.html#json-schema),
[native-library uniqueness](https://doc.rust-lang.org/cargo/reference/resolver.html#links)
and [yanked eligibility](https://doc.rust-lang.org/cargo/reference/resolver.html#yanked-versions).

The profiles do not establish general Cargo backtracking, workspace/patch/git
resolution, rust-version fallback, native build scripts, artifact integrity or
installation. Preserve the difference between a fresh yanked denial and an exact
caller-lock reuse when extending them. The pinned Cargo 1.98.1 differential cases
and their scope remain in [package acceptance](../testing/packages.md).

## npm, pnpm and Yarn

The current npm profiles keep installation slots and peer hosts distinct from
package names. `npm-lock.ts` validates the exact supplied lockfile-v3 tree (v1),
`npm-platform.ts` adds optional/platform projection (v2), `npm-identity.ts`
adds aliases and workspace link/target identity (v3), and `npm-composition.ts`
combines those grammars (v4) before adding explicit engine targets and flat
overrides (v5). `npm-registry.ts` owns a separate bounded registry-range resolver.
The request schemas, receipts and routing are in `npm-schema.ts` and
`npm-resolution.ts`. Earlier profile bytes and replay semantics remain frozen.
The offline comparison is pinned to npm 11.19.1's
[virtual tree](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/arborist/load-virtual.js),
[peer edges](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/edge.js)
and [optional region](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/optional-set.js).

`validated` means the admitted supplied tree is internally consistent, not
freshly solved or installed. REZICS deliberately requires literal sources and
SRI, rejects unproven alias/package identity, and treats an incompatible declared
engine target as invalid even where npm normally warns. These are stricter
admission decisions, recorded by the native-comparison tests. The bounded npm
registry profile also records selection/layout divergences rather than treating
an equal logical package set as an equal physical tree.

General npm ideal-tree solving, arbitrary ranges/overrides and install layout,
pnpm/Yarn strategies, lifecycle execution and artifact verification remain
separate qualifications. Their clauses must be explicitly unsupported under a
profile that has not admitted them.

### Alias and workspace identity profile

V3 binds exact caller-supplied workspace manifests, distinct link and target
paths, and alias requested names; workspace targets can host their own peers.
It does not compose v2 platform projection. Missing workspace bytes/links are
incomplete evidence. Unproven alias names are unsupported, even if npm's pinned
version checker accepts the version. See `npm-identity.ts` and the v3 oracle cases.

### Composed identity and target profile

V4 validates the entire supplied graph before optional/platform projection.
Omission witnesses retain the original edge and cause path; a required peer or
wrong alias cannot disappear behind an inactive branch. V5 adds engine and flat
override checks while retaining v1-v4 receipts. See `npm-composition.ts` and its
pinned [optional-region](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/optional-set.js)
and [engine-checker](https://github.com/npm/cli/blob/v11.19.1/node_modules/npm-install-checks/lib/index.js)
comparisons. Neither profile establishes an installation result.

## Go

The Go MVS owner code keeps selected build-list versions separate from capture
and checksum provenance. Local `./` replacement inputs use caller-supplied
`go.mod` bytes; the API never reads a caller-named server path. The pruned
Go 1.17+ profile loads explicit roots and Go 1.16 transitive branches; a selected
module can remain unexpanded. The separately versioned main-directive profile
adds exact/path-wide remote replacements and excludes without changing older
receipts. It reloads roots after an upgrade so requirements from a displaced
root do not remain. This follows the [module reference](https://go.dev/ref/mod#graph-pruning)
and [Go 1.17 graph pruning](https://go.dev/doc/go1.17#go-command); see the
pinned Go 1.27.1 oracle cases in [package acceptance](../testing/packages.md).
The separate receipt version preserves earlier replay semantics. For excludes,
the profile follows the reference's [directive rule](https://go.dev/ref/mod#go-mod-file-exclude)
and pinned Go behavior, rather than the older next-higher-version description
in its MVS overview.

General live version discovery, complete workspace/local/remote directive
combinations, checksum verification of all captures, locks and installation are
still unqualified. MVS cannot be replaced with highest available version search;
retraction does not retroactively erase an admitted build-list node.

## Nix

`nix-graph.ts`, `nix-adapter.ts` and `nix-resolution.ts` keep original and locked
flake inputs, follows edges, source hashes, derivations and runtime closure
observations distinct. The input graph may contain cycles; evaluation/build is
execution rather than safe manifest parsing. Evaluator/configuration identity and
an unobserved closure must remain explicit. This follows the
[Nix flake reference](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake.html).

## Minecraft loaders and providers

`mod-profile.ts` keeps Fabric hard `depends`/`breaks` separate from advisory
`recommends`/`conflicts`, preserves Forge and NeoForge side/order rules, and
verifies a nested Fabric child against the captured parent JAR. Provider relation
kinds retain Modrinth project/version grain, CurseForge embedded/include meaning,
and Steam advisory/Collection meaning. A missing or inaccessible response is not
an empty dependency set. [Source conformance](../testing/source-conformance.md)
records access gaps; [package acceptance](../testing/packages.md) records the
qualified relation cases. Loader semantics follow the
[Fabric manifest](https://wiki.fabricmc.net/documentation:fabric_mod_json_spec),
[Forge metadata](https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/)
and [NeoForge metadata](https://docs.neoforged.net/docs/gettingstarted/modfiles/).
CurseForge `include` becomes bundled only in `mod-native-capture-v2`; saved v1
receipts retain their earlier meaning.

Versioned Fabric provided-ID requirements, wider loader grammars and live
provider acquisition remain separate work. Nexus experimental surfaces and Steam
soft dependencies must retain their observed coverage and advisory status.

## Cross-ecosystem composition

The current exact package lock composes Go, Cargo and npm segments under declared
process/path/ABI scopes. It does not establish that matching names or version
strings across ecosystems are interchangeable. Future composition of Skill
requirements, Rust binaries, Nix and mod/runtime dependencies needs explicit
capability and environment matching. Shared artifact bytes prove only those bytes,
not equivalent package semantics or rights. See `lock.ts` and
[package acceptance](../testing/packages.md).

## Sources

The upstream sources beside each profile explain its admitted boundary. Native
oracle fixtures and case records, rather than this page, preserve the exact
versions and counterexamples used to qualify current behavior.
