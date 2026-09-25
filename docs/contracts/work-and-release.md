# Native Work, Main Version and release

## Continuity and grain

A Work identifies an independently maintained creative scope. A Main Version is
its native virtual content axis; an external publication or fixed release retains
its own identity. A composition, recording, album, novel, film, software project,
recipe or editorial creation can each be a Work where that scope is justified.
A person, place or concept is not a Work merely because it has a description.

Metadata corrections, native Main Version language contributions, new encodings
and alternative presentation normally preserve Work identity. An independently
published translation has its own REZICS Work, connected to its source Work by an
identified translation relationship, narrowed to applicable versions where known.
Independently maintained adaptations, new recordings and software forks can also
establish distinct Works with derivation.
Matching names, bytes, identifiers or provider classes never proves identity.
Uncertain correspondence remains uncertain; do not invent a Work to satisfy an
external edition hierarchy.

## Composition and publication

[Main Version](main-version.md) owns native defaults and adoption. Contributions
retain independent authorship, source, language, applicability, revision and rights.
Two same-language translations are valid. A fixed release identifies selected
content, order and coverage; an ISBN or distribution identifier belongs to the
corresponding publication grain rather than automatically to the Work.

Distinguish localized metadata, independently published translated Works and
native multilingual content. An English book can have a Chinese display title
while its content language remains English. Its official Chinese publication and
a separately maintained third-party translation have their own Work/version
identities and translation links; do not duplicate those publications inside the
source Work's translation fields. A REZICS Main Version can instead compose
multiple language contributions within the same maintained version, like language
tracks in a game. Its existence does not fabricate translations of an imported
single-language publication.

Official/third-party status records version-specific translator, publisher or
authorizing party, evidence and coverage. It neither determines Work identity
nor transfers automatically to later versions. Unknown/disputed attribution stays
explicit. Source-version references remain unknown when evidence does not identify
one. Native variants retain the equivalent provenance and exact source revision.
Actual derivation through another translation is a relationship path, never
recursive embedding of complete translated Works.

WORK02 represents an independently published translation as its own ordinary
Work/Main Version and an identified immutable `translation-link-v1` relation. A
link names a target Main Version revision, a source Work/Main Version, and either
an exact retained source Main Version revision or explicit `unresolved` source
version status. It records content language, translator, publisher, public evidence
URL and `official` or `third-party` provenance. An official link requires an exact
source revision and a current Access admission scoped to that source Work and
revision, in addition to target link authority; the authorizing party and epoch
are retained. A third-party link records no official authorization. One target
revision has at most one link; a later revision has no inherited link or status.
The link carries no source or translated body. Native same-language Contribution
variants remain within their own Work/Main Version and use the reader choice path.

`POST /v1/translation-links` commits the relation with an idempotency key;
`GET /v1/main-versions/{mainVersion}/revisions/{revision}/translation-links`
returns the complete exact-revision relation inventory. The POST target must be
the current Main Version head, while an exact source revision may be historical.
The read is revision scoped and returns no recursive publication payload. Creating
the translated Work and linking it are separate commands, so a Work can exist
before its provenance link is admitted. This slice does not infer coverage for
later releases, determine legal entitlement from a third-party declaration, or
select independently published Works as native variants.
The relation and its `TranslationLinkedEvent` enter the graph and outbox in one
native command. The relay retains an idempotent typed envelope with the exact
source revision or explicit unresolved status, target revision and official
authority witness. A cancellation that writes only a receipt uses a zero-event
batch. Native graph backup retains the relation; rebuilding it from retained
relay events during isolated restoration uses the same one-position, held-graph
reconciliation fence as Work restoration. It requires the retained event and
batch, the captured relay coverage, and the sealed Access admission matching
the exact request digest, actor, source scope, receipt and source position. The
digest is recomputed with the admission's retained idempotency key. The
reconstructed relation retains its original ID, model revision, source-version
certainty and authorization witness; replaying the same position is idempotent.
Missing or changed evidence stops reconciliation. Live graph-loss qualification
of this WORK02 path remains pending.

The first WORK04 continuity profile records a separately admitted target
Work/Main Version and an immutable `work-derivation-v1` relation at its current
Main Version head. The relation names an exact retained source Work/Main Version
revision and declares one of `adaptation`, `new-recording`, or `software-fork`,
with a public evidence URL and the target-side actor. The target actor needs a
current `work.derive` Access admission scoped to `derivation:link:{targetWork}`.
The native command compares the expected target head and permits one derivation
per target revision; an idempotency key replays its receipt. The exact revision
read and typed outbox event retain both identities and the declared kind, with
no copied body or implied equivalence. `POST /v1/work-derivations` and
`GET /v1/main-versions/{mainVersion}/revisions/{revision}/work-derivations`
are the initial API. A later target revision does not inherit the relation.
WORK04 remains partial for unresolved source versions, multiple source paths,
contested or corrected continuity decisions, source-side endorsement, and
isolated graph-loss replay from retained events.

Albums/anthologies and independently maintained parts can all be Works. Membership
does not absorb child identities, rights, ratings or future content. A social
publication announcing a release is a separate event/utterance.

## Domain applicability

Duration applies to a timed recording/cut/selection; word count to a particular
language revision and coverage; pixels to an image representation; dependencies
to applicable package versions/environments. Unknown, zero and inapplicable are
different. Subtitles fit a cut, language packs fit a build, and pure visual content
does not receive fictitious language support.

## Operations and exchange

Create, describe, contribute, adopt, publish, seal, withdraw and correct through
owning commands. Changes that alter creative continuity require an explicit
decision with evidence and links to the prior scope. Map external Work/Edition/
Recording/Release terms by referent, not matching class names. A separately
identified translated REZICS Work may map to an Expression within a bibliographic
Work grouping; do not infer equivalence from the word Work. Bibliographic and
music exports state residual data and mapping losses. Validate source-free and
cross-provider cases in [native Work acceptance](../testing/native-work.md).
