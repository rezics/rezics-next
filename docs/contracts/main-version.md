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

## Fluree-backed history

Fluree owns fact-change history and historical reads. REZICS does not build a
parallel full-snapshot/delta history engine. A business revision anchor identifies
the resource/component scope, operation, model revision and retained source
commit. Anchor resolution uses commit receipts/metadata; a commit does not need
to contain its own content hash. Physical `t` is ledger/branch-qualified.

Sealed revision meaning cannot be changed. One transaction may form several
component anchors; a staged operation may produce no published revision until
activation. Large payloads use immutable object references/digests. A multi-ledger
manifest names exact dependencies and verifies their completeness; independently
observed heads do not imply global atomicity.

Comments use resource + revision + optional occurrence/block/selector. Old
comments do not drift when the head changes. Historical reads apply current
disclosure, and retained revision anchors pin required history/payloads against
garbage collection. Relocation must preserve their resolution or export an exact
retained representation before the old history is retired.

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
using RDF. [Fluree time travel](https://github.com/fluree/db/blob/v4.2.1/docs/concepts/time-travel.md)
supplies historical storage; these controls remain application responsibilities.

The [graph-record blueprint](../implementation/graph-records.md#revision-anchor-resolver)
specifies anchor resolution without self-referential commit hashes or an independent
success record in another database.
