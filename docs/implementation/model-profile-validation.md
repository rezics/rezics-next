# Profile compilation, validation and command binding

The [authored definitions](../../model/definitions/) and
[compiler IR](../../model/compiler/ir.ts) are the shape specification. The
[registry](../../model/compiler/registry.ts) selects canonical focuses and binding
demands; the [native module](../../infra/jena/command-module/src/main/java/com/rezics/jena/ProfileRegistry.java)
loads its generated manifest. The selected subset has executable compiler,
native and [MODEL acceptance](../../scripts/qa/cases/model-contracts.ts) checks.
Seven general definition families, arbitrary runtime definitions and automated
cross-owner exchange mappings are still broader designs, not compiler features.

## Add or activate a profile

1. Add `model/definitions/<name>-v1.ts` with shapes and, for native command
   routing, `canonical` and `binding` metadata. Pin source terms and exact
   candidate meaning. Accepted is the current reviewed basis: definition and generated
   diffs are reviewed together; authored profiles and Facets may be edited or removed.
2. Run `task gen`; review the generated shape, context, schema and manifest diff.
   Add positive and denied candidate fixtures and a registry route assertion.
3. Validate against the pinned native command module. Stage affected data and
   index work under the old manifest, establish complete coverage, then activate
   under a generation guard. A stale prepared command must revalidate or fail.
4. Change native module code and bump its version only when generic registry
   routing cannot express a required rule. The module must load the matching
   manifest and shape digests at startup.

## Choose the revision boundary

| Change | Boundary |
| --- | --- |
| Optional property or relaxed constraint | Refine the same profile or Facet. |
| Tightened constraint | New constraint revision, with an admission coverage check. |
| Different meaning | New term. |
| Block payload change | Version only that block. |

The manifest retains artifact digests, `task gen:check` detects generated drift,
and the registry rejects ambiguous routing. These checks protect the current
build; they do not lock authored definitions to previous bytes.

Exact stored manifests and payloads remain immutable. The
[revision resolver](graph-records.md#revision-anchor-resolver) reads sealed
`rezics-manifest-v1` objects by digest and checks their component, profile IRI,
payload digest and byte size. Semantic revisions also retain the model-generation
IRI. Its sealed state records the build manifest digest, module version and
entailment posture, rather than a historical copy of every shape. Current exact
read paths do not load old generated SHACL or compiler manifests; the native
registry verifies only the installed build's shape bytes at startup. Removing
the authored digest lock changes neither the object custody path nor these
checks. Historical native revalidation against old generated shapes has no
implemented custody/resolution path today.

## Inspect a rejected command

Check the command outcome and its own receipt before inferring success from a
timeout. Compare the reported profile digest, focus, shape and named graphs with
the owner-selected affected state, including pre-state subjects and reverse
dependents. A removed type or selector still requires its old validation. No
shape, empty focus, unsupported executable term, incomplete coverage, blocking
report or deadline can produce an activation receipt. The module validates the
post-state in the writing TDB2 transaction; the guarded update binds heads,
absence/uniqueness slots, model generation and receipt absence. External Access
admission remains a separate fenced owner decision. Reports may expose private
paths and values, so inspect them under the owning disclosure policy.

Ordinary Fuseki Update and the optional `/shacl` report endpoint do not enforce
this path. Product ingress exposes validated commands and query; offline imports
must stage and qualify a new generation. See the
[transactional endpoint](../storage/jena.md#transactional-command-endpoint) and
[exact revision resolver](graph-records.md#revision-anchor-resolver).
