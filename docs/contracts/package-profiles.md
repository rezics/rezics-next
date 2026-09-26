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

The separate `npm-lock-v3-topology-v1` profile validates an exact supplied tree,
not a fresh resolution. Its request binds `npmVersion: "11.19.1"`,
`policy: "literal-sources-required-peers-v1"`, and `manifest`/`lock` objects
containing canonical `bytesBase64` and lowercase SHA-256 of `package.json` and
`package-lock.json`. Canonical base64 preserves arbitrary JSON whitespace and
property order; JSON itself need not be canonical. Unknown version/policy returns
unsupported semantics. The native comparison uses npm's offline virtual tree,
with required peers and no legacy peer bypass. No actual installed directory,
artifact, lifecycle hook or registry observation is asserted.

The root and lock must agree on name, stable version and dependency/peer maps.
The v3 `packages` object contains the empty root path and only canonical
`node_modules/name` or scoped-name segments. The admitted package fields are
name, version, dependencies and peerDependencies; non-root entries additionally
require literal HTTPS `resolved` and canonical single SHA-512 or SHA-1 SRI.
Optional name must agree with the path name. Root `private` and string `license`
are inert metadata; package `license` and boolean `peer` are also retained.
The top-level lock contains name, version, lockfileVersion, packages and optional
boolean `requires: true`. Every dependency and peer selector is a bare exact
stable `major.minor.patch`. Unknown fields and other selectors return unsupported
semantics, including ranges/tags, links, workspaces, aliases, overrides,
optional/dev/platform/engine clauses, bundled packages and lifecycle metadata.
The entire supplied tree is admitted before topology validation; unsupported
metadata on an otherwise unused node cannot disappear.

Paths identify installation slots. For each edge, inspect the requesting node's
children, then each enclosing package's children up to the root. The first
same-name slot wins, even if its version is incompatible. A non-root peer found
in the requesting package's own children is invalid; there is no fallback to a
higher compatible host or another branch. A root peer may use a root child.
Dependency/peer declarations of the same name in one package are unsupported
until their precedence is separately qualified. Every supplied node must be
reachable from the root through these edges, and every enclosing package path
must exist. Cycles of dependency or peer edges are allowed.

An immutable `pkg.npm_resolution` row owns UUID, principal, idempotency key,
canonical request digest, exact request, outcome and timestamp. UUID is primary;
`(principal_id, idempotency_key)` is unique; a principal/UUID index serves private
reads. The existing package immutability trigger rejects update/delete. The
request digest includes raw bytes and version/policy, so even whitespace changes
conflict under one key. Lock identity is the versioned request digest. Each
instance ID hashes that lock identity, path, name, version, resolved and integrity;
edges and each instance's `peerHosts` bind exact host IDs and paths. This avoids
cyclic ID construction while binding the full peer environment through the lock
identity. Equal source/name/version at different paths remains distinct.

`lockfileVersion` is null before format inspection and otherwise retains the
inspected integer, including an unsupported format. A validated result always
has version 3. `validated` means all admitted edges and paths agree; it does not mean solved,
verified or installable. Missing nodes return `incomplete-source-data`, incompatible
versions, child-local peers or unreachable nodes return `invalid-topology`, and
unsupported clauses and resource limits retain their own outcomes. These failures
have empty instance/edge arrays and explicit issues. Malformed JSON, duplicate
object keys (including escaped duplicate paths), root/lock mismatch, invalid
paths, malformed identity/SRI, bad UTF-8/base64 or digest mismatch are 422 and
create no receipt. Main revalidates stored bytes, request digest and outcome on
exact read/replay. Signed Content recovery coverage version 4 binds the new table
alongside all existing Go and Cargo rows; old package receipt formats are unchanged.

Each raw file admits 65,536 bytes; a larger canonical file up to the 262,144-byte
transport ceiling yields `budget-exhausted`. JSON nesting is at most 32,
installed path depth 16, packages 129 including root, edges 256, and total ancestor
lookups 4,096. Counters report input bytes, loaded nodes, parsed edges and lookups.
Work is O(B + V log V + E log E + E·D) with bounded bytes B, nodes V, edges E and
path depth D. Create/replay uses one insert and one indexed exact-row read;
retrieval uses one indexed row. No historical receipt inventory is loaded.

This boundary follows npm's [lock location and provenance fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json),
[peer declarations](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependencies),
and the pinned [ancestor lookup](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/node.js)
and [peer-local validation](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/edge.js).
Its exact-only grammar and owner identities are REZICS choices. The npm registry
hostname is retained literally, with no claim about installation-time registry
substitution. The offline native oracle compares the same lock bytes and records
paths, peer hosts and source/SRI; it does not fetch or verify artifact bytes.
Full npm/pnpm/Yarn solving and installation remain outside this profile.

The separately versioned `npm-lock-v3-topology-v2` uses
`policy: "literal-sources-optional-platform-v2"` and a required `target` object
with explicit `os` (`linux` or `win32`) and `cpu` (`x64` or `arm64`). No host
default is inferred. Unknown target strings are unsupported; malformed target
fields are rejected. Its `npm-lock-topology-receipt-v2` uses the existing immutable
`pkg.npm_resolution` owner and Content recovery coverage v4: no migration or
historical receipt rewrite is needed. Request/profile/policy/target and exact
manifest/lock bytes all participate in the request digest and instance identity.
V1 request validation, receipts, reads and exact replay retain their original shape.

V2 adds exact `optionalDependencies`, `peerDependenciesMeta` with boolean
`optional` on a declared peer, non-root boolean `optional`, and `os`/`cpu`
selectors. Selectors admit strings or arrays of at most 16 tokens: the supported
target values, their `!` negations, or the singleton `any`. Empty arrays permit
all targets; exclusions win over inclusions, matching npm. Unknown well-formed
tokens are unsupported; malformed tokens/types are rejected. Raw bytes retain
selector syntax; outcome selectors normalize a string to one element and preserve
absence as null. All dependency classes remain disjoint; overlapping declarations
are unsupported. Engines, libc, aliases, workspaces, overrides, development
dependencies, fresh solving and installation remain outside the grammar.

Every supplied node and required edge is checked before target projection,
including inactive branches. An absent optional dependency or optional peer is
reported as `absent-optional`, never as a platform observation. A present but
incompatible optional peer is invalid, and an incompatible nearer peer still
shadows a compatible ancestor. Missing required nodes or literal source/SRI stay
`incomplete-source-data`. Declared optional flags must agree with reachability
through required edges; an incorrect optional flag cannot hide a required package.
An incompatible required platform returns `invalid-topology` with an explicit
`platform-incompatible` issue. All failed outcomes have empty graphs/projections.

A validated result retains **all** locked `instances` and resolved `edges`, adding
optional edge/peer flags, node selectors and computed optional flags. It separately
returns `activeInstances` (IDs), `activeEdges`, `omittedInstances` and
`omittedEdges`. Platform failures omit the optional dependency region: first walk
incoming required edges to the optional boundary, then remove dependencies with
no remaining external dependents. Shared required dependencies survive. Each
omitted instance binds its ID/path, `reason: platform`, and the exact incompatible
`causePath`; omitted edges distinguish absent optional targets and platform
removal. Neither array represents an observed installation. Missing optional
targets do not invent identities or artifact provenance.

This is a REZICS target projection over npm's virtual tree. The pinned
[platform checker](https://github.com/npm/cli/blob/v11.19.1/node_modules/npm-install-checks/lib/index.js),
[optional region algorithm](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/optional-set.js)
and [optional peer edge errors](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/edge.js)
define its native counterexamples. `loadVirtual` alone does not filter platforms;
the offline oracle explicitly applies npm's checker with the declared target and
its optional-region helper, without ideal-tree solving or reification. This
avoids treating CLI host defaults as the requested target environment.

V2 keeps v1 byte/node/edge/path/ancestor bounds and adds 16 tokens per selector
and 65,536 graph visits, reported as `graphVisits`. Graph work includes required
reachability and optional-region pruning; exhaustion yields no partial graph.
The conservative bound is O(B + V log V + E log E + E·D + V²·(V + E)), with
the separate visit ceiling bounding adversarial optional-region work. Indexed
owner read/replay costs remain independent of unrelated receipt history.

### Alias and workspace identity profile

G-023's separate `npm-lock-v3-topology-v3` request uses
`policy: "literal-sources-alias-workspace-v3"`, npm 11.19.1, exact root
`manifest`/`lock` bytes, and required `workspaces` entries with `path` and exact
`manifest` bytes/digest. It validates required dependencies and peers plus exact
`npm:name@major.minor.patch` aliases. V2 optional/platform projection is not
composed into this profile; those clauses, overrides and engine policy remain
explicitly unsupported. V1/v2 request bytes, receipt shapes and replay stay frozen.
The existing immutable owner and signed Content coverage v4 store the new
`npm-lock-topology-receipt-v3` without a migration or historical rewrite.

Root `workspaces` is an optional list of exact relative directories, with at most
16 entries. Globs, exclusions, nested/overlapping workspace roots, external paths,
undeclared local packages and nested links are outside this profile. Workspace
paths use at most eight safe components and never `node_modules`, `.` or `..`.
The supplied workspace manifests must match those declarations; missing manifests
or lock target records are incomplete source evidence. Extra/duplicate supplied
paths, duplicate workspace names, and disagreeing manifest/lock names, versions
or dependency maps are malformed. Directory basenames need not equal package
names. The API never opens a caller-named server path.

Each instance keeps `kind` (root, registry, workspace or link), exact lock `path`,
`slotName` (null for root/workspace), package `name`, version, literal `resolved`
and `integrity`, and `peerHosts`. A link retains its literal relative `resolved`
path plus `linkTarget` with target ID/path, with no artifact SRI. Workspace/root
sources and SRI are null; workspace source evidence is its supplied manifest.
Edges keep declared `name`, verbatim `specifier` and `requestedName`, independently
of the target's recorded package name. Synthetic root `workspace` edges use
`file:<workspace-path>`; the oracle maps npm's absolute temporary-directory spec
to that exact relative identity. Dependencies originate at the workspace target,
never the link slot. Link-to-target reachability is explicit in `linkTarget`.
Instance IDs bind the complete versioned request digest and these distinct facts.

Lookup follows installation parents; a workspace target falls back to the root.
Peers inside ordinary installed packages reject a child-local host. A workspace
target is a native filesystem top and may use its own child as a peer host.
Workspace edges must find a link at the package-name slot and its exact declared
target. A different directory basename is valid; a wrong slot is missing and a
wrong existing target is invalid topology. All supplied nodes must be reachable.
Unknown grammar wins over topology claims, and failures return no usable graph.
Missing sources/SRI/links return incomplete source data; malformed source/SRI/link
types are rejected before receipt creation.

Pinned native `dep-valid` checks an alias's version but does not authenticate its
package name. V3 therefore returns unsupported semantics when an alias's requested
name differs from the recorded package name or addresses a workspace link. It
does not claim native invalidity or artifact verification for that refusal.
Similarly, the virtual tree may accept missing or malformed SRI: the profile's
stricter source admission is explicit. Sources retain literal canonical HTTPS
identity; unfamiliar schemes remain unsupported.

Each raw file remains limited to 65,536 bytes, with an aggregate 262,144-byte
processing budget. Up to 16 workspace byte envelopes each retain the existing
262,144-byte transport ceiling. JSON nesting is 32, nodes 129 including links and
workspace targets, edges 256 including synthetic workspace edges, installed path
depth 16, ancestor lookups 4,096 and graph visits 65,536. Workspace paths add at
most one resolution hop. Counters include all supplied bytes and link traversal.
Work is bounded by O(B + V log V + E log E + E·D); private read/replay still uses
indexed exact owner rows independent of unrelated receipt history.

The design uses the pinned npm [link implementation](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/link.js),
[virtual loader](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/arborist/load-virtual.js)
and [dependency validator](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/dep-valid.js).
These are virtual-tree claims only; workspace file contents beyond the supplied
manifests, physical symlinks, archive integrity and installation are unqualified.

### Composed identity and target profile

G-026 adds `npm-lock-v3-topology-v4`, with
`policy: "literal-sources-composed-v4"`, npm 11.19.1, required explicit `target`
(`linux`/`win32`, `x64`/`arm64`), exact root/lock bytes and the v3 bounded workspace
manifest inputs. Its `npm-lock-topology-receipt-v4` composes the v3 identity
grammar with the v2 optional/platform grammar. Historical v1/v2/v3 validators,
IDs, outcome bytes, reads and replay remain frozen. The immutable npm owner and
signed Content recovery coverage v4 need no schema change.

The complete supplied virtual graph is validated before projection: every
declared slot, alias name/version, workspace manifest/link/target, peer host,
source/SRI and required edge is checked even when its branch would be omitted.
Absent optional edges remain distinct from platform removals. A wrong or missing
required peer cannot be excused by optional ancestry. A mismatching alias name,
alias addressing a link, or plain selector pointing at a differently named
package returns unsupported identity evidence. Native version edges authenticate
none of those package names; this is a deliberate stricter admission rule, not a
claim of native invalidity. Missing bytes/provenance are incomplete; malformed
bytes, SRI, paths and manifest/lock disagreement reject before storage.

All v3 identity fields and v2 optional flags/selectors are retained together.
`instances` and `edges` describe the full locked graph; `activeInstances` and
`activeEdges` describe its declared target projection. Root workspace edges are
required. Reachability and required flags traverse `linkTarget`, so a workspace
and its required peer stay required while an optional child may disappear.
Links inherit their target's platform selectors; links and targets retain
distinct IDs and paths. Optional-region expansion/pruning walks dependency edges
only, matching the pinned native helper; a link-to-target association is not
invented as a dependency edge. Workspace targets remain filesystem tops and may
resolve a peer from their own installed children. Each graph operation counts
visits and terminates under the profile budget.

Omitted instances retain their exact incompatible `causePath`. V4 omitted edges
also include `requestedName` and `causePath`: null for `absent-optional`, otherwise
the omitted source endpoint's cause, or the target endpoint's cause when the
source survives. The edge retains its original source/target IDs, paths,
specifier and optional flag. No omitted edge is rebound to a different ancestor.
Full peer-host witnesses remain on locked instances even when a host is omitted;
the projection reports the corresponding omitted peer edge. Any failure returns
empty full and active graphs and empty omission arrays, with a distinct status
and issue, unsupported clause or budget reason.

V4 keeps the v3 byte, workspace, path, node, edge and ancestor limits, the v2
16-token selector limit, and a 65,536-visit ceiling. It counts link traversal in
reachability and all adjacency, projection and output walks. Conservative work
is O(B + V log V + E log E + E·D + V²·(V + E)); the visit ceiling bounds adversarial
region pruning. Exact read and replay use indexed owner rows, independent of
unrelated history. Override/engine policy, overlapping dependency classes,
workspace globs/external/nested links, registry solving, artifact validation,
installation and other package managers remain outside the admitted grammar.

The composition follows npm 11.19.1's
[flag propagation](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/calc-dep-flags.js),
[optional region](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/optional-set.js)
and [version/alias validator](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/dep-valid.js).
The offline oracle checks virtual trees plus explicit platform and optional-region
observations on four OS/CPU pairs. These bounded observations do not establish
ideal-tree selection or installation, and PKG04/PKG12/PKG13 remain partial.

G-033 adds the separately versioned `npm-lock-v3-topology-v5` request with
`policy: "literal-sources-policy-v5"`. It requires the v4 target and explicit
`engineTarget.nodeVersion`/`npmVersion`, both exact stable versions, plus the
same exact manifest, lockfile and workspace bytes. The root manifest may contain
at most 32 flat package-name override rules with exact version values. A rule
changes the effective selector for a transitive registry dependency while the
receipt retains its declared selector and selected path. A direct root
dependency whose selector conflicts with its override returns
`unsupported-semantics` with the pinned npm `EOVERRIDE` difference recorded;
nested override objects, peer/alias/workspace override selection and ranges are
also outside this admitted grammar. V1–v4 request and receipt identities remain
unchanged. The v5 immutable `npm-lock-topology-receipt-v5` stores the engine
target, override selections and a per-node engine-check witness beside the v4
projection; read and replay revalidate these exact bytes under the same private
owner and signed Content recovery coverage.

Each root, workspace and registry node may declare `engines.node` and
`engines.npm` as an exact stable version or `>=` that version. The explicit
target is checked for every locked node, including an optional node that is
omitted from the requested platform projection. An incompatible node produces
`invalid-topology` and an empty graph. This is a strict REZICS admission rule:
npm's default engine warning does not by itself reject installation unless
`engine-strict` is enabled. The native comparison invokes npm 11.19.1's pinned
engine checker with the declared target; the virtual-tree observation is not
an install or ideal-tree solve. Missing source or SRI remains
`incomplete-source-data`, and malformed, unsupported and budget outcomes retain
empty graphs. The v5 profile advances bounded PKG04/PKG12/PKG13 evidence;
general npm override grammar, engine ranges, solver behavior, pnpm/Yarn and
artifact installation remain outside it. See npm's
[override and engine declarations](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[engine-strict setting](https://docs.npmjs.com/cli/v11/using-npm/config/), and
the pinned [native engine checker](https://github.com/npm/cli/blob/v11.19.1/node_modules/npm-install-checks/lib/index.js).

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

The `go-mvs-from-main-pruned-directives-captures-v5` API profile adds bounded
main-module exact/path-wide remote `replace` and exact-version `exclude` to
that captured pruned graph. It creates a separately versioned
`go-mvs-captured-pruned-main-directives-v6` snapshot and
`go-mvs-captured-pruned-main-directives-resolution-v6` receipt. Earlier request
and receipt profiles keep their existing behavior. Main bytes, parsed rules,
roots, capture IDs, source coordinates and list/info/manifest digests participate
in the immutable request digest. Each supplied source also retains its exact
manifest text; replay checks its SHA-256 and parsed metadata against that text.

Exclusions remove matching requirements before source lookup or expansion.
An exact replacement takes precedence over a path-wide rule. Replacements do
not introduce roots or change the original path/selected version; the source
manifest controls requirements and pruning. If the graph upgrades an explicit
root, the resolver reloads the pruned graph with that selected root until the
roots stabilize; dependencies contributed only by the old pruned root disappear.
The immutable request still retains the original main bytes and roots.
A loaded remote replacement must
declare the original module path, and its bytes come only from the exact source
coordinate's private capture. The capture's original parser result is preserved;
this profile separately parses its raw text to check replacement identity.
Missing expansion bytes report the source coordinate in `missing`, never fall
back to the original capture. `selectedSources` reports selected replacements;
`selectedSourceEvidence` reports every selected original/source coordinate,
whether it was expanded, and its exact capture evidence or `null` when absent.
A pruned source can be selected without manifest bytes. These raw digests are
capture provenance, not checksum-database verification or installation evidence.

Malformed or duplicate remote rules receive distinct invalid-request errors.
Local/workspace directives and dependency syntax outside the existing bounded
requirements parser return
`unsupported-semantics`; needed but absent captures return
`incomplete-source-data`; traversal over the existing bounds returns
`budget-exhausted`. None publishes a successful build list. Source-coordinate
collisions across selected original paths are rejected. Provider version search,
workspace/local combinations, general release sets, verification of every
capture, locks and installation remain separate retained requirements.

The traversal and validation cost is O(B + C + R + V + E), plus
O(S log S) for the returned path ordering: B retained manifest bytes,
C at most 128 supplied private captures,
R at most 32 replacements and 64 exclusions, V at most 128 expanded module
versions, and E at most 512 visited requirements across all root-stabilization
passes. S is the number of selected paths, bounded by E. The request caps every
manifest at 65,536 bytes. Repeated graph passes do not reset the work budget.
The owner reads captures in one bounded private query and uses the established
immutable write/replay path. It performs no provider or host filesystem read
during resolution. The separate local-file proxy oracle compares the build
list with pinned Go 1.27.1 and withholds a pruned transitive `.mod` file to
check lazy loading. This profile implements only the bounded captured graph;
live version sets, complete directive combinations, checksum verification of
these captures, locks and installation require their own qualification.

This pruning rule follows the [Go module reference](https://go.dev/ref/mod#graph-pruning)
and [Go 1.17 release notes](https://go.dev/doc/go1.17#go-command).
The main-rule decision was checked on 2026-09-26 against the reference's
[replace](https://go.dev/ref/mod#go-mod-file-replace) and
[exclude](https://go.dev/ref/mod#go-mod-file-exclude) sections and the pinned
Go 1.27.1 `cmd/go/internal/modload/buildlist.go` implementation of
`expandGraph`/`updatePrunedRoots`. The reference's MVS overview describes an
older next-higher-version exclusion rule; the directive section and native
oracle establish ignoring excluded requirements for this Go 1.16+ profile.
Using a new snapshot version preserves historical receipt verification; merely
adding rules to the old pruned profile would change the meaning of saved data.

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
