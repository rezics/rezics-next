# Native Work and release grain

A Work is an independently maintained creative scope. A Main Version is its
maintained content axis. A fixed release captures an exact selection; an external
publication retains its own identity and evidence. This separation lets a
metadata correction or new native contribution preserve the Work while an
independently published translation, adaptation, recording or software fork can
remain independently maintained and explicitly related to its source.

Names, bytes, identifiers and provider classes alone cannot prove continuity.
Unknown correspondence stays unknown. An ISBN or other distribution identifier
belongs to the evidenced publication grain; it does not automatically identify
the Work. A release announcement is a separate utterance.

## Closed records and open axes

Closed release corrections are enforced by `services/main/src/modules/release/schema.ts`
and `ReleasePolicy`: evidence may replace a record, and a later translation is a new one.

What REZICS records about the world is closed; what REZICS maintains is open. A
Main Version and a [virtual release](distribution.md#release-kinds-and-status)
accept new content versions. An external edition or physical release, each web
snapshot and a fixed release record what was actually published. Evidence may
correct such a record; a later translation or contribution is never added to it,
but becomes a [new content version](content-languages.md#translations-are-new-content-versions)
that names this record as its source. The number of languages does not matter: a
bilingual edition is as closed as a monolingual one.

A release is a statement of fact, so adding content published later would falsify
it and let it imply coverage it never had. Keeping publisher and community work
under separate identities also keeps their authority, rights and responsibility
apart. The same split underlies [IFLA LRM](https://www.ifla.org/files/assets/cataloguing/frbr-lrm/ifla-lrm-august-2017.pdf)
manifestations and expressions, and MusicBrainz places translations that appear
on no actual release on a [Pseudo-Release](https://musicbrainz.org/doc/Style/Specific_types_of_releases/Pseudo-Releases)
rather than on the official one.

## Installed release and translation grain

The first [fixed release](../../services/main/src/modules/work/fixed-release.ts)
seals one published native text draft and its exact Main Version selection. Its
manifest preserves the selected contribution, decision, language and body digest;
current metadata and default-selection edits cannot rewrite those references.
[WORK05 evidence](../../scripts/qa/coverage/work.ts) covers stale, denied,
concurrent and replayed seals plus exact read and graph recovery. The first
[translation link](../../services/main/src/modules/work/translation-links.ts)
pins a target Main Version revision and either an exact source revision or
explicitly unresolved source status. Official authority is version scoped; a
newer target revision does not inherit its link.

Membership in an album or anthology does not absorb a child Work's identity,
rights, ratings or future content. Domain measurements apply only to their
actual grain: duration to a timed cut, word count to a language revision, pixels
to an image representation and dependencies to a package/environment. Unknown,
zero and inapplicable remain distinct.

Multi-member native release manifests, general external distribution matching,
release-specific availability and entitlement remain separate implementation
work. Export must state residual mapping and loss when external bibliographic or
music grains do not correspond exactly to REZICS identities.
