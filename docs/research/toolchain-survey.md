# Mature toolchain survey

Reviewed 2026-09-23 as a selection input, not an adopted dependency list.
[Toolchain](../development/toolchain.md) and manifests own pins and commands;
[source-data rights](source-data-rights.md) owns provider-specific reuse limits.
The [Jena CJK probe](../../scripts/research/jena_text_cjk/README.md) is executed
search evidence; most other candidates below were desk reviews.

## Decisions and alternatives

- Use selected runtime modules before adding services. Jena supplies SHACL,
  text indexing, maintenance and metrics; [command module](../../infra/jena/command-module/)
  and [storage contract](../storage/jena.md) own the transactional path.
  Jena graph ACLs and retired jena-permissions do not establish the product's
  protected graph/text disclosure; [Main's bridge](../implementation/authorization-bridge.md)
  remains necessary.
- Keep REZICS-owned receipts, fences, revision manifests, ordered Access policy,
  Context/Main Version semantics and reducers. LinkML is a useful model reference,
  but its incomplete SHACL/Rust generators did not replace the
  [model compiler](../../model/compiler/).
- Fluree 4.2.1's append-only history had no documented excision route for the
  [erasure contract](../operations/erasure.md), and its fixed-English BM25 path
  truncates before joins. Its [license](https://github.com/fluree/db/blob/v4.2.1/LICENSE)
  also restricts a third-party database service. Oxigraph 0.5.x is Rust-native
  and mutable, but [full-text support](https://github.com/oxigraph/oxigraph/issues/48)
  is absent. These were reasons to retain Jena, not proof of Jena capacity.
- Better Auth covered most connected-app needs in the dated review, while RFC
  8693 token exchange remained a gap; panva oidc-provider was a fallback.
  Reassess against the pinned Account implementation before changing providers.
- MinIO's community repository was archived; RustFS's historical
  [console](https://github.com/rustfs/rustfs/security/advisories/GHSA-7gcx-wg4x-q9x6)
  and [Object Lock](https://github.com/rustfs/rustfs/security/advisories/GHSA-j548-9grx-fh4f)
  advisories identified fixed versions, not a permanent exclusion. Object
  stores still need conditional-write, backup and restore qualification.
- Native validators, RDF Delta/GeoSPARQL wrappers and a separate search writer
  remain proposals until their owner tests establish the required semantics.
  The dated survey did not verify jena-text crash atomicity, RDF wrapper
  composition, Better Auth/OIDC integration or production Workers rendering.

Software licenses and source-data reuse are separate decisions. No product
contract follows from a library's presence in a survey. Adopting a candidate
requires an owner change and its own verification.
