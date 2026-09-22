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
