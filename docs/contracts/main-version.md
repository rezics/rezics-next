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

Its content axis can be natively multilingual. This is distinct from an
independently published translation with its own Work/version and translation
relationship. A Main Version wrapper does not turn a single-language external
publication into a multilingual one or copy its linked translated Works' bodies.
Each available native language variant retains independent revision, source and
version-specific official/third-party provenance. A sealed release pins the actual
language manifest and coverage; a missing newer translation remains unavailable
or explicitly falls back rather than being silently certified as current.

## User continuity

Ordinary discovery, discussion, follows and curation lead to the common Work/Main
Version entry. Readers can select translations and specific releases there.
Realm-local substantive adoption changes the selected view while retaining that shared spine.
Creating a Realm, importing another provider or changing a display language does
not fork the Work or create an unrelated community root.

Ordinary translation preference is sparse reader state. A Realm may supply an
optional recommendation using the same selection mechanism; it does not need an
independent translation-adoption history for every language. These preferences
choose among eligible variants without changing their identity or publication.

The first reader API exposes current public native Contribution variants at
`GET /v1/main-versions/{id}/native-variants`, saves or clears a private choice at
`PUT /v1/me/main-versions/{id}/variant-preference`, and resolves it at
`GET /v1/me/main-versions/{id}/selection`. The write uses the authenticated
principal, an expected preference revision and an idempotency key. The read
returns the actual Contribution, author, language and exact draft, plus
`personal-preference`, `main-default` or `preferred-ineligible`. It does not
alter the public default selection or grant publication eligibility. Realm
recommendations, separate translated Works and version-scoped authorization
remain later WORK02 slices.

Main Version ratings and release/translation ratings have distinct targets.
Specific discussions preserve their exact targets and remain discoverable from
the common entry under current disclosure. Identity correction and independently
maintained adaptations/forks use [Work continuity](work-and-release.md).

## Content selection

Resolve disclosure and applicability before selecting content. An explicitly
requested fixed selection either succeeds exactly or is unavailable. Otherwise
use the eligible context adoption, then its declared Main Version fallback and
the [language/preference policy](content-languages.md#selection-and-edits).
Return the actual contribution/language/selection and reason.
Do not silently choose a draft, incompatible subtitle or different release.

Ordinary Post-backed chapters follow context-eligible published content while
retaining stable occurrences for progress. Reviewed adoption and fixed releases
pin exact states. A new source revision proposes an advance; it does not mutate
an existing reviewed selection. Selection changes have expected-head preconditions,
idempotent receipts, authority checks and derived-index invalidation.

## Application-owned immutable history

REZICS retains exact component revisions under one history contract. Semantic
anchors are in TDB2 with sealed payloads/manifests; Content anchors, manifests and
bounded bodies are in PostgreSQL. A revision names its owning resource/component, operation,
predecessor, model/shape profile, byte digest and exact selected dependencies.
Current heads are mutable projections; sealed payload meaning cannot change.
TDB2 transaction snapshots are not a permanent time-travel API, and no native
commit hash, ledger branch or physical transaction counter identifies a revision.

Prepare verified immutable bytes before activation. The owning transaction
commits its component head, revision metadata, receipt and outbox: PostgreSQL for
Content, Fuseki/TDB2 for semantic state. Graph publication separately adopts an
exact durably prepared Content reference. The owner receipt proves its local
outcome, while the manifest resolves exact state. One local transaction may
activate several same-owner anchors; it cannot atomically activate both stores.
Staged work is not published before its required activation. Search visibility
may follow asynchronously under the [publication contract](commands.md#content-publication-and-delayed-visibility).

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
