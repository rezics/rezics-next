# REZICS Main Version and revision control

## Maintained virtual version

Every admitted creative Work has one stable REZICS Main Version within its native
continuity scope. It is a maintained virtual version that supplies the common
product entry, content axis and default community target. It may be metadata-only.
It is not an external edition, the latest database transaction, a software SemVer
release or a requirement to copy all adopted content.

Main Version owns a default composition, language/variant selection policy,
adoption decisions and publication heads. Several same-language contributions
can coexist. Work identity describes the creative referent; Main Version describes
the platform-maintained content experience around it. Both have stable references.

## User continuity

Ordinary discovery, discussion, follows and curation lead to the common Work/Main
Version entry. Readers can select translations and specific releases there.
Realm-local adoption changes the selected view while retaining that shared spine.
Creating a Realm, importing another provider or changing a display language does
not fork the Work or create an unrelated community root.

Main Version ratings and release/translation ratings have distinct targets.
Specific discussions preserve their exact targets and remain discoverable from
the common entry under current disclosure. Identity correction and independently
maintained adaptations/forks use [Work continuity](work-and-release.md).

## Content selection

Resolve disclosure and applicability before selecting content. An explicitly
requested fixed selection either succeeds exactly or is unavailable. Otherwise
use the eligible context adoption, then its declared Main Version fallback and
language policy. Return the actual contribution/language/selection and reason.
Do not silently choose a draft, incompatible subtitle or different release.

Ordinary Post-backed chapters follow context-eligible published content while
retaining stable occurrences for progress. Reviewed adoption and fixed releases
pin exact states. A new source revision proposes an advance; it does not mutate
an existing reviewed selection. Selection changes have expected-head preconditions,
idempotent receipts, authority checks and derived-index invalidation.

## Application-owned immutable history

REZICS retains exact component revisions as immutable payloads/manifests with
anchor metadata in TDB2. A revision names its owning resource/component, operation,
predecessor, model/shape profile, byte digest and exact selected dependencies.
Current heads are mutable projections; sealed payload meaning cannot change.
TDB2 transaction snapshots are not a permanent time-travel API, and no native
commit hash, ledger branch or physical transaction counter identifies a revision.

Prepare verified immutable bytes before activation. A single guarded Fuseki update
commits the current component/selection head, anchor metadata, receipt and outbox
batch. Its application dataset/epoch/sequence position proves activation, while
the manifest resolves exact state. One transaction may activate several component
anchors; staged work publishes none until its complete manifest is activated.

Small revisions store complete component payloads. Large compositions use immutable
bounded pages and root manifests that reuse unchanged pages. This preserves exact
state without copying an entire database or replaying an unbounded delta chain.
A fixed release manifest names the complete transitive selected dependencies;
independently sealed states across datasets do not imply global atomicity.

Comments use resource + revision + optional occurrence/block/selector. They keep
their target when current heads change. Exact reads apply current disclosure and
verify retained payloads; missing or erased state is unavailable and never silently
replaced with current content. Retention pins anchor metadata and required bytes
against collection. Relocation/restore must preserve exact revision identities
and referenced objects even when the owner's data epoch changes.

## Operations

| Command | Required behavior |
| --- | --- |
| Create Main Version | Allocate once within Work scope; allow no body; record authority and default policy. |
| Adopt contribution | Validate compatibility, provenance, disclosure and expected selection; do not transfer contributor control. |
| Publish | Activate a completed eligible state and emit its exact selection event. |
| Change default | Preserve alternatives, user references and prior adoption history. |
| Seal release | Capture exact composition and transitive selected dependencies with a complete manifest. |
| Withdraw | Stop affected use/disclosure according to policy without rewriting unrelated publication contexts. |
| Restore | Create a new current transition from retained state after current validation; never reset the database clock. |

For software, the main entry recommends appropriate releases but cannot stand in
for a concrete artifact in a package lock. For recipes and media, applicability
and variants remain domain-specific rather than forcing a textual edition model.

## Qualification

Use two same-language translations, repeated chapters, a metadata-only Work,
Realm-specific adoption and a fixed release. Verify stable entry/progress,
concurrent selection changes, history comments, failed publication, erasure and
restoration. Main Version continuity is product acceptance, not a consequence of
using RDF. Qualification must also cover payload corruption/missing bytes,
interrupted staging, concurrent guarded publication, restored dataset epochs,
object retention and rebuilding current projections from retained components.

The [graph-record blueprint](../implementation/graph-records.md#revision-anchor-resolver)
specifies exact anchor/manifest resolution. The [Jena binding](../storage/jena.md)
separates TDB2 transactions, application history and reconstructable Lucene state.
