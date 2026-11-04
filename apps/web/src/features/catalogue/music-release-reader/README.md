# Music release reader

An ordinary Subject overview distinguishes one music edition from its album, media, recordings and files.
The [coverage audit](../../../../../../docs/research/api-first-platform-coverage.md#musicbrainz) and
[Subject contract](../../../../../../docs/subject-pages.md#imported-music-and-live-action-profiles) own those identity
boundaries. Album contents and Recording destination readers remain separate owners. Destinations use the current
ordinary Subject composition, without adding a View or changing the existing release-fidelity release types.

Decision: until the current Definition publishes `rezics:MusicMedium` with its release-membership relation, keep
medium/disc membership explicitly unavailable and read only released ordered `schema:track` recordings.
This reader requires the exact released `schema:MusicRelease` identity (or a released descendant).
`schema:MusicRecording` is a published Type; `rezics:MusicMedium` remains an explicit unpublished association seam.
Labels, generic release ancestry, mappings and provider codes never admit music.
The ordinary frame uses its native summary ancestry to discover descendants; the reader independently checks the
current immutable Release before exposing edition facts. A missing admission offers generic facts and correction.

Only admitted `schema:releaseOf` or `schema:exampleOfWork` with a released MusicAlbum target identifies the album.
All selected album relationships remain separate. Format, region, date, status and identifiers belong to this edition.
Admitted fields with no statement differ from fields absent from configuration. Date values retain exact/partial
precision, explicit TBA (`somevalue`), explicit no-value, absence and unsupported precision. No unknown or malformed
value becomes TBA. All qualifiers, reference groups, source provenance, native rank and pinned accepting digest remain
available. Earlier accepting meaning is marked separately from current configuration. Generic facts and correction
retain their existing authority and draft recovery; this reader performs no writes or playback operations.

One selected stream follows native direction and order. Forward item relations must admit this release and target a
released music identity; inverse relations must target this release and be admitted on a released music identity.
The default window is admitted `schema:track`. Canonical containment still uses `bf:hasPart`/`schema:hasPart` forward
and `schema:isPartOf`/`wdt:P361`/`wdt:P1433` inverse when those streams are selected. Listing-occurrence Concepts on
`wdt:P642` keep repeated recording slots distinct; `rezics:MusicMedium` stays unpublished. No album, file or generic
CreativeWork target is relabelled as a recording or medium. Rows retain holder, statement, slot qualifiers and summary
identity, including repeated recordings in distinct slots. A withheld summary has no invented destination. Corrections
open the exact holder's existing membership editor.

Each next, stream, previous or restart performs a fresh current read for its address. Unavailable stream reads retain
the other disclosed window; changed, invalid and withheld reads retire it. The reader keeps at most 20 prior addresses
and one pending address, never prior authorized payloads. Each address is bounded to a 36-character Subject and
Context, 256-character stream, 4,096-character cursor, revision and 128-character Definition digest; even with JSON
escaping, the 21 retained addresses use under 588 KiB. A deliberate read uses at most four native reads: Subject,
active pointer, immutable Definition and one relation page. The Subject response is capped at 2 MiB; one page is capped
at 20 rows, 128 KiB per row and 2,686,976 bytes total. Qualifiers, references and their related labels are inside
those row/page bytes; no target Subject or document read is added. Subject, Context, Realm, locale, source observation,
Query provider, session and exposure changes retire the old reading, even across away/back. Delayed responses cannot
restore old controls or focus. Native destinations and correction open new tabs; keyboard return restores the exact
row or stable heading. Wrapping components, inherited themes and 44px controls serve phone390/desktop1280 and all
eight locales.

## Cost

One deliberate window uses one exact Subject read, the shared active-pointer plus immutable Release reads, and at
most one native relations/links page: at most four reads and no target reads or writes. Release bounds remain 4 MiB,
1,024 types and 4,096 properties; at most 64 streams are accepted. Subject responses above 2 MiB are unavailable.
The native page is limited to 20 rows, each at most 128 KiB serialized UTF-8 JSON, and 2,686,976 total bytes. Opaque
cursors are at most 4,096 UTF-16 units; an immediate repeated cursor, duplicate assertion or mismatched identity is
unavailable. One accepted response, one pending address and one keyboard origin are retained. Work is O(Release
metadata + admitted subject/page bytes), independent of total catalogue size. Serialization and runtime object
allocation add transient memory; producer transport allocation precedes the consumer's bounds.

Focused generated-client tests pin edition identity, dates, configuration, directed slots, continuation recovery and
observation retirement. Stories describe admitted, TBA, empty, unavailable-continuation and unsupported states; they
are source examples and do not establish native configuration or browser acceptance. Integration owns broader
acceptance, theme/viewport rendering and native publication checks.
