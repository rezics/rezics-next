# Distribution and editions

A distribution or release identifies an issuing specification, platform or
selected publication scope. Work, Main Version, edition, carrier, artifact and
announcement remain separate. Incomplete external correspondence should remain
explicit instead of inventing an edition parent or merging equal identifiers.

The [fixed native text release](../../services/main/src/modules/work/fixed-release.ts)
seals an exact eligible selection. The [Media owner](../../services/main/src/modules/media/)
retains original Use provenance and role for cover and gallery assets. Repeated
tracks and chapters need distinct occurrences even when they share one member.

## Release kinds and status

The release record, its kind and status, and a web publication's closed snapshots
are carried by [`release-v1`](../../model/definitions/release-v1.ts),
[`web-publication-v1`](../../model/definitions/web-publication-v1.ts),
[`web-snapshot-v1`](../../model/definitions/web-snapshot-v1.ts) and
`services/main/src/modules/release/`. Edition language lists are
[`work-metadata-details-v2`](../../model/definitions/work-metadata-details-v2.ts).

A release says what it is. It is a formal edition or physical release, a web
publication, a REZICS fixed release or a virtual release. Every kind except the
virtual release is a [closed record](work-and-release.md#closed-records-and-open-axes).

A web publication is a real release: RDA's carrier type
["online resource"](http://rdaregistry.info/termList/RDACarrierType/1018) and
MusicBrainz's digital-only releases treat it so. Its content can change, so it
records the original URL and dated snapshots in the sense of
[Memento (RFC 7089)](https://datatracker.ietf.org/doc/html/rfc7089); each snapshot
is closed, and its exact bytes are a source observation of that content location.
One release offered through several stores or sites remains one release with
several locations. An unsanctioned repost is a separate release and is never
merged into the official one.

A virtual release is built on REZICS and corresponds to no real publication,
like a MusicBrainz [Pseudo-Release](https://musicbrainz.org/doc/Style/Specific_types_of_releases/Pseudo-Releases).
It mirrors one source release's structure, states its coverage, such as chapters
1–20 of 100, and carries [user translations](content-languages.md#user-submitted-translations)
of that release's content. It is never evidence that anything was published.

Status follows [MusicBrainz release status](https://musicbrainz.org/doc/Release):
official, unofficial (an unsanctioned release), virtual, withdrawn or cancelled.
A virtual release is always virtual; status never turns a user construction into
a publication claim.

## Remaining distribution work

General external distribution creation, partial bundle validation, versioned
language applicability and release-specific availability/download rights still
need owner operations and evidence. A Work representative image must point to an
eligible original Use without losing its release origin or source-primary status.
