# Dependency constraints, locks and installation plans

## Requirement representation

Requirements preserve native selector syntax, source observation and manifest
location while lowering to typed conditions. The following is fictional design
data, not a pinned live fixture:

```json
{
  "id": "requirement-ref",
  "fromRelease": "release-ref",
  "target": {
    "kind": "package",
    "ecosystem": "npm",
    "registry": "https://registry.npmjs.org",
    "name": "example-package"
  },
  "selector": { "kind": "nativeRange", "profile": "npm-semver", "text": "^2" },
  "strength": "required",
  "phase": "runtime",
  "conditions": [],
  "instanceScope": "dependency-edge",
  "source": { "observation": "observation-ref", "pointer": "/dependencies/example-package" }
}
```

Other selectors include exactRelease, exactArtifact, gitRevision, path/workspace,
capability and native-profile forms. Alternatives/incompatibilities are typed
constraints; advisory requirements remain separate. Missing metadata is not an
unconstrained match. Version ordering belongs to the ecosystem profile.

## Candidate provider and solver

Expose bounded coordinate resolution, candidate pages, release requirements,
artifact metadata and profile capabilities. Bind one captured source snapshot;
memoize within the run. Cancellation/budgets cover network, parsing and solving.
Candidate preferences/tie-breaks are deterministic within the declared profile.

Return instances and edges, not package -> one version. An instance key includes
package/source, selected release, environment and peer/feature/isolation scope as
required. Native tools can implement a profile where most faithful, particularly
Go/Nix. Compare semantics against the same inputs, distinguishing valid alternate
solutions from divergence in required policy. Hard unknowns cannot yield solved.

## Lock manifest

| Field | Meaning |
| --- | --- |
| lockId / contractVersion | Immutable lock identity and schema. |
| request | Root requirements, explicit pins and update policy. |
| environment | OS/architecture/runtime/ABI/loader/game/side and host-target interpretation. |
| profiles | Comparator, resolver, native tool and layout/executor versions. |
| sourceSnapshot | Exact observations/frontiers used and coverage. |
| instances | Exact releases/artifacts/digests, features and scoped identities. |
| edges | Instance satisfying each requirement, with reason and source. |
| warnings / unresolved | Advisory or unqualified aspects; hard unknowns block successful resolution. |
| provenance | Solving operation, policy and permitted attribution. |

Hash a versioned canonical representation with lossless value encodings. Hash
equality proves bytes, not cross-ecosystem substitutability. Mutable tags resolve
to exact observed evidence. Replay verifies locked artifacts and current eligibility;
update creates a new resolution instead of silently changing an existing lock.

## Install plan and journal

Steps declare inputs, outputs/owned paths, action, required capabilities,
idempotency key, expected prior generation and compensation/reconciliation.
Separate fetch, verify, unpack, build, configure, register, switch and remove.
Downloading a package grants no permission to run lifecycle hooks.

| Crash point | Recovery |
| --- | --- |
| Before fetch intent is durable | Retry same step identity; no installed state claimed. |
| Downloaded but unverified bytes | Verify quarantine bytes or refetch; never activate unchecked output. |
| Partial unpack | Recreate/resume owned staging; reject path traversal/collisions. |
| Unknown build/hook outcome | Inspect receipt/declared effect; do not blindly repeat a non-idempotent hook. |
| Generation switched, response lost | Reconcile active generation and operation receipt. |
| Partial in-place adapter | Journal reconciliation/compensation; expose partial state until complete. |
| Interrupted removal | Remove remaining owned paths only; preserve user data/shared dependencies. |

Activation CASes the environment generation and checks cancellation, authority and
input/erasure fences. Concurrent installs cannot silently mix plans. Shared artifact
retention follows installation ownership, not path existence alone. Rollback uses
retained artifacts only while their execution/availability policy permits it.

## Trust and execution scope

The core supports controlled execution adapters without running arbitrary upstream
builds on the principal server by default. Native/local runners execute an admitted
plan under their own capability grant. Hosted execution requires its isolation,
secret and resource profile. Nix evaluation/build network work is not hidden inside
a metadata fetch. Validate registry origin, redirects, digests and extraction paths;
never substitute a public registry for a missing private coordinate automatically.
Indexable metadata does not imply downloadable or redistributable artifacts.
