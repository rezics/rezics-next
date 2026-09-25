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
for one fixed snapshot only. The command did not fetch live module metadata,
verify provider checksums, build packages or exercise replace/exclude/retract.
