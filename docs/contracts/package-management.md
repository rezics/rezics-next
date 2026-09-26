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
inconsistent-source-data, unsupported-semantics, cancelled and budget-exhausted. A timeout is not an unsat
proof; an inaccessible dependency is not an empty dependency set.

`POST /v1/package-resolutions/cargo` accepts the first bounded
`cargo-index-exact-resolver2-v1` request described in [Cargo profiles](package-profiles.md#cargo).
It binds exact base64 root manifest and registry index file bytes, SHA-256 values,
the original registry URL, resolver 2, host/target triples and requested features
to an immutable private row under `Idempotency-Key`. `package:resolve` creates or
replays; `GET /v1/package-resolutions/cargo/{resolution}` requires `package:read`
and re-verifies the stored request digest and outcome. Both operations require an
active Access principal; another principal receives 404 for a private read.
The solved response keeps a lock selection by source/name/version and a separate
active host/target instance graph with features and typed edges. The API returns
explicit incomplete, unsupported and budget outcomes with empty graph fields.
Malformed bytes or duplicate source identities return 422; a changed request on
an existing key returns 409. The same routes accept the separately versioned
`cargo-index-exact-resolver2-v2` request and return
`cargo-index-exact-resolution-v2` receipts. Their `linksConflicts` witnesses
identify exact selected native-library owners on `unsatisfiable`; all other
v2 outcomes contain an empty witness array. The v1 receipt profile and outcome
shape remain unchanged. Both profiles use the existing immutable owner table;
the request profile binds the re-solve semantics on replay and restored reads.
Changing profiles under an existing idempotency key is a changed intent (409).
It makes no artifact availability, checksum
verification, installation or build claim.

The same routes accept `cargo-index-exact-resolver2-v3` and return
`cargo-index-exact-resolution-v3`. Required `existingLock` is either null
(fresh) or exact canonical base64 `Cargo.lock` bytes plus SHA-256. The lock is
private caller intent, bound to the whole immutable request digest and replay
key. The [v3 lock grammar](package-profiles.md#cargo) retains format, source,
coverage and checksum provenance. A yanked exact dependency requires a matching
lock source/name/version; changing only the root identity does not invalidate
it. Missing checksum and disagreeing checksum are different: omission is
retained as null, while disagreement with a selected index record returns
`inconsistent-source-data` and `checksumConflicts`. These are metadata
consistency checks, not verification of an artifact. `lockEvidence` records
caller-supplied provenance/digest/counts; solved `reusedYanked` and failed
`yankedConflicts` identify exact packages and native source strings. Existing
`linksConflicts` still apply after yanked eligibility. All failures have empty
selected/instance/edge/reuse arrays; unsupported grammar, incomplete current
source and budget outcomes remain distinct. Malformed lock inputs are 422 and
are not stored. Even a comment-only lock edit changes the idempotency intent.
Stored v1/v2 receipts retain their original shape and semantics.

The Cargo operation reads no provider data at execution time. Its upper bound is
O(B + V log V + E log E + F·(E + F log F)) work for B supplied bytes, V at most
128 releases, E at most 256 dependency edges per pass and F at most 512 feature
activations; feature expansion may inspect each release's bounded dependency
list and sort accumulated requests. V2 shares the activation budget across its
lock and active feature processing; lock traversal and the active graph each
retain their edge limit. The conflict pass groups at most V selected owners by
native name and sorts the bounded witnesses. It performs one bounded
insert and one indexed PostgreSQL read on create/replay, or one indexed read for
exact private retrieval, followed by a bounded re-solve. Request and response
bytes grow with the supplied snapshot and graph. Native Cargo comparison is a
separate oracle command, never a Main runtime side effect.
V3 adds O(L + K + D) lock admission for L at most 65,536 raw bytes, K at most
129 historical packages and D at most 256 historical references, then one map
lookup per selected identity. It adds no database query or provider read.

`POST /v1/package-resolutions/npm` accepts the separate
[`npm-lock-v3-topology-v1` profile](package-profiles.md#npm-pnpm-and-yarn).
`package:resolve` creates or replays an immutable `npm-lock-topology-receipt-v1`
receipt; `GET /v1/package-resolutions/npm/{resolution}` requires `package:read`
and returns the exact revalidated receipt. Both require an active Access
principal; another principal's read is 404. The caller supplies canonical base64
manifest/lock bytes, SHA-256, npm version and policy. Name/version, package path,
literal HTTPS source, SRI and actual required peer-host identity survive the
private owner boundary. Response status `validated` establishes only the admitted
locked topology. Incomplete data, invalid topology, unsupported semantics and
budget exhaustion are durable distinct outcomes with no usable partial graph.
Malformed snapshot inputs are 422 without a row (malformed request envelopes
fail the shared transport validation with 400); changed bytes or policy under one key
are 409. HTTP creation is 201 and exact replay is 200; all receipts use `no-store`.
Required peer resolution cannot fall back to a same-name instance in another
branch or beyond an incompatible nearer instance.

The same routes also accept `npm-lock-v3-topology-v2` and return
`npm-lock-topology-receipt-v2`. The required target declares Linux/Windows and
x64/arm64 without using a server-host default. V2 preserves optional dependencies,
optional peer hosts and OS/CPU selectors, retaining the complete locked graph
alongside active IDs/edges and explicit omission witnesses. Missing optional
targets and platform-inactive instances have different reasons. A required
dependency cannot be silently omitted; present incompatible optional peers still
fail topology validation. Changed target or profile under an existing key is 409.
V1 requests and exact receipts retain their original shape and interpretation.

The npm operation reads no filesystem paths, registry or artifact. The
[profile cost contract](package-profiles.md#npm-pnpm-and-yarn) bounds every supplied
byte/node/edge and ancestor lookup. One indexed exact read follows one insert on
create/replay; private read loads one row. Revalidation repeats only the bounded
saved snapshot. Unrelated locked history does not enter the operation. The owner
schema and signed recovery coverage include the npm receipt without changing Go
or Cargo receipt semantics. Installation, range solving, artifact verification
and npm/pnpm/Yarn conformance outside the admitted grammar remain separate work.

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
source selected elsewhere in the final build list is rejected. The immutable v1
request and result keep their prior shape. The local Go oracle matches both
same-path and fork replacement combined with an exclusion. A versionless
original path replaces every visited version with one fixed remote release;
an exact-version rule for the same path takes precedence regardless of directive
order. Multiple visited versions may load that source while only the selected
original version appears in `selectedSources`. The 32-directive,
128-loaded-version and 512-requirement bounds are unchanged. Local directory
replacements and `go 1.17+` graph pruning remain unsupported and
must be declared in `coverage.unsupportedClauses`.
The separately versioned captured pruned main-directive profile is specified
under [Go package profiles](package-profiles.md#go). It derives rules from exact
main bytes and resolves private source captures; it does not extend the v2
caller-supplied snapshot or change its archived receipt semantics.
The bounded Go 1.16 snapshot now admits canonical stable tags and pseudo-version
forms without build metadata, up to 96 bytes per version. Numeric version fields
and prerelease identifiers use Go semantic-version precedence, including the
timestamp ordering within a pseudo-version and the precedence of a stable tag
over its prerelease. A `/vN` module path must match the pseudo-version's major.
The pinned native Go oracle matches two pseudo-version graphs. The v1
fixed-origin proxy capture operation requires a version listed as a stable tag;
the v2 exact pseudo-version capture below uses a separate evidence profile.
The v2 release manifest may include bounded `retractions` from its `go.mod`.
The highest supplied release per original module path provides the retraction
advisory. A selected retracted version stays in the build list and appears in
`retractedSelected` with the announcing release and rationale, matching native
Go's exact-version versus upgrade distinction. This is only an advisory over
caller-supplied manifests; it does not prove that the announcing release is the
actual latest provider version or that its bytes/checksum are authentic.

`POST /v1/package-sources/go` v1 captures one stable tagged module version from the
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
checksum. Captured bytes are not checked against the Go checksum database.
The `go-module-proxy-capture-v2` request accepts only an admitted pseudo-version.
It fetches exact `.info` and `.mod` from the same fixed origin under the existing
4 KiB and 128 KiB byte limits and five-second per-request deadlines. The exact
`.info` version and UTC time must match the pseudo-version's timestamp. The
immutable row records the v2 profile and an empty list field; the returned
`versionList` is `null`, without a claim that the pseudo-version appeared in a
tag list. Capture-derived resolutions retain `selection: exact-pseudo-version`
and both raw response digests. These are proxy observations; explicit checksum
database verification is still a separate operation.
The v1 fetch path is O(response bytes plus listed versions), with three fixed
proxy requests and one indexed PostgreSQL insert/read. V2 makes two fixed proxy
requests with the same byte and time limits for their response types.
The capture read includes `manifest.parsed`, a conservative line-oriented parser
for simple `module`, `go` and `require` directives. It handles bounded grouped
requirements, canonical pseudo-version requirements and comments; unfamiliar directives, quoted
syntax, duplicate paths and mismatched module identity return
`unsupported-syntax` with no requirements. `compatibleWithUnprunedGo116` is true
only for a clean parse with explicit `go 1.16`. The view is derived from the
retained raw bytes on every exact read and can feed a capture-derived resolution.
Each exact capture read also calculates the Go `go.mod` `h1:` value from the
retained bytes using Go's single-file dirhash format. A pinned native Go 1.27.1
diagnostic matched this value against `GoModSum` from a fixed live
`go mod download` with `sum.golang.org` verification enabled. The API field is a
calculation, not a statement that Main verified a signed checksum-database
record; in-service provenance verification is still required.
The first checksum-database verifier primitive checks a bounded signed tree note
with the public `sum.golang.org` Ed25519 key pinned in the official Go 1.27.1
toolchain. It validates the key identifier, exact note signature, tree size and
root hash. A signed tree head alone does not authenticate any module line. Main
must next verify a lookup record's Merkle inclusion under that head, compare its
`/go.mod` h1 with the retained capture, and store a monotonic trusted head with
consistency proofs across updates. The verifier must reject invalid signatures,
record/hash mismatches, rollback, fork evidence and unavailable proofs. Keep
fixed origins and explicit byte, request and time limits for lookup and tiles;
the expected work per proof is O(log N) hashes and bounded tile fetches for a
tree of N records. Only a fully checked record may be reported as verified by
the package API.
The pure record-proof primitive uses Go's RFC 6962 leaf/node prefixes and
leaf-to-root audit-path order, consumes every supplied hash, and requires a
root match with a verified signed tree head. It has a 53-hash ceiling for a
JavaScript-safe tree size. A diagnostic lookup path now fetches the fixed
`sum.golang.org` record and required height-eight hash tiles, reconstructs that
audit path, and compares the included `/go.mod` h1 against the exact captured
manifest. It uses one 4 KiB lookup, at most 128 tiles of at most 8 KiB each,
and a 15-second deadline per lookup/proof attempt. A returned
`go-sumdb-included-unpinned-v1` result means inclusion under that signed head;
it does not establish that the head extends any previously trusted head. The
Main capture API does not yet expose it as verified provenance.
The consistency primitive rebuilds a newer signed tree root and the exact
older prefix root from the newer tree's bounded tiles, rejecting rollback,
equal-size forks or divergent roots. A fixed live observation compared the
lookup's 65,209,736-record head with a later 65,215,452-record signed head.
This check also runs during the durable capture-bound verification below.
The Content owner now stores one `sum.golang.org` checkpoint and immutable
signed-head history. An exact capture verification rechecks its retained
`go.mod` h1, signed lookup note, record audit path and a freshly signed latest
head. It requires the latest head to extend both the lookup head and the
stored checkpoint, then commits the new checkpoint and a private immutable
capture-bound receipt in one PostgreSQL transaction. The first checkpoint must
be at least the pinned 65,209,736-record tree; the exact root is checked at
that size. Concurrent advancement retries against the observed head, while a
same-key replay reads the existing receipt without provider calls. Exact read
revalidates the signed note, record proof and captured bytes without network.
The checkpoint is monotonic within this database's history. Restoring an older
complete database backup could roll it back; an independent external checkpoint
or witness is still needed for stronger cross-restore rollback detection. The
`POST /v1/package-sources/go/{capture}/verify` route requires `package:verify`,
an active Access principal and an idempotency key. It refuses another principal's
capture before lookup. `GET /v1/package-sources/go-verifications/{verification}`
requires `package:read` and returns the exact private receipt after offline
evidence revalidation. Both responses use `no-store`; the receipt identifies
its included and locally trusted signed trees. A calculated capture h1 remains
separate from this explicit verification operation.
The coordinated physical PostgreSQL restore drill retained the Go capture,
signed checkpoint and exact verification receipt. An isolated restored Content
owner revalidated the receipt and replayed its idempotency key with provider
access disabled. The version-two signed mixed-owner recovery coverage now
hashes the five `pkg.*` tables alongside `content.*`, even without graph
Content references. Release rejects an absent or changed package cut. This
coverage is a stopped backup comparison; an independently held checksum
checkpoint is still needed to detect rollback of the complete signed backup
and its retained head.
`POST /v1/package-resolutions/from-captures` accepts up to 128 private capture
IDs. Its v1 body supplies a main module and direct requirements. Its v2 body
supplies the main module's raw UTF-8 `go.mod` as canonical base64 (at most 64
KiB decoded); Main derives its module identity and roots through the same
conservative parser. The exact manifest text and SHA-256 are retained in the
immutable resolution request. Unsupported main-module syntax or a directive
outside explicit `go 1.16` yields `unsupported-semantics` without a build list.
Under `package:resolve`, Main
reads those immutable captures in one principal-scoped PostgreSQL query, derives
each release's requirements from its retained manifest, and persists a v3
resolution request with capture IDs and the three raw response digests. The
solver reports a missing required captured version as `incomplete-source-data`
without a build list. Unsupported parser syntax or a directive outside explicit
`go 1.16` yields `unsupported-semantics`. A closed supported graph can solve;
read with `package:read` re-verifies its immutable request/outcome. This does
not independently authenticate the proxy bytes through the Go checksum database.
Owner work is one indexed capture
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
