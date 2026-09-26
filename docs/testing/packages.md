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
Pseudo-versions, replace/exclude/retract, Go 1.17+ pruning, checksum provenance,
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
private write and exact read. This is partial PKG05/PKG12 evidence. Wildcard and
local replacements, provider capture and checksum evidence remain
open.

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
