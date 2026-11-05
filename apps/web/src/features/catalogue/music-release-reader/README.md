# Music release reader

An ordinary Subject overview distinguishes one music edition from its album, media, recordings and files.
The [coverage audit](../../../../../../docs/research/api-first-platform-coverage.md#musicbrainz) and
[Subject contract](../../../../../../docs/subject-pages.md#imported-music-and-live-action-profiles) own those identity
boundaries. Album contents and Recording destination readers remain separate owners. Destinations use the current
ordinary Subject composition, without adding a View or changing the existing release-fidelity release types.

Decision: this reader requires the exact released `schema:MusicRelease` identity (or a released descendant).
`schema:MusicRecording` is a published Type. Until the current Definition publishes `rezics:MusicMedium` with its
release-membership relation, keep medium/disc membership explicitly unavailable and read released ordered
`schema:track` recordings.
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

A listener selects one exact holder/assertion pair in the accepted window. Repeated targets keep separate inspect
controls; selecting a recording never selects another occurrence sharing its target. The inspector shows native
property/direction, holder, assertion, source qualifiers, separate reference groups, rank, revision and pinned accepting
release using the existing value renderer. Earlier accepting meaning remains separate from current configuration.
Only a disclosed summary supplies a recording destination. The exact holder supplies the existing membership editor.
The list keeps supplied order, position and slot qualifiers, without treating a listing slot as a medium.
An unavailable request names whether retry rereads Previous, continues Next or starts the requested stream; the
accepted stream remains labelled separately so a failed stream switch cannot relabel the visible occurrences.

Next and Previous replace the single accepted body. Previous rereads the exact prior Subject/Context/stream/direction
and opaque cursor, retaining at most eight prior addresses. An unavailable operation keeps the accepted window,
selected occurrence and exact pending operation; retrying Previous consumes its address only on success. Invalid or
withheld results retire the entire window and its controls. Empty continued, exhausted, stale, unsupported, failed and
withheld readings remain distinct; the end of a frontier never implies complete release contents.
Decision: successful Start and stream switches clear the prior-address stack; unavailable attempts preserve the accepted window.
A successful replacement clears occurrence selection; an intentional stream switch clears it immediately.

Subject, Context, Realm, locale, source observation, Query provider, session and exposure changes retire the old
reading, even across away/back and equal successful replacement. Explicit recovery runs the ordinary Subject route
loader through MusicReleaseOverview. The reader requires a newly admitted source before making a fresh first-window
read; it never reuses a pending request, an initial example body or a retirement flag as new authority. A resolved
recovery without replacement data stays retired. An environment change during recovery retires that attempt too.
A direct current-Subject link provides recovery when the embedding surface has no route-loader callback.

Delayed responses cannot restore old controls or focus. Destinations, evidence links and correction use the existing
new-tab contract. Keyboard return restores only a connected current origin, falling back to the stable heading when
that origin was removed and focus was lost. Intervening user focus wins. Mouse visits discard keyboard return origins
and do not steal focus. Keyboard inspection focuses its heading; closing returns to the exact occurrence control.
Wrapping components, inherited themes and 44px controls serve 390/1440 layouts and all eight locales.

Disclosed Subject destinations and correction links carry the exact Context, Realm and a bounded `via` return with
the current stream, opaque cursor, Definition digest/revision and selected holder/assertion locator. Returning performs
a fresh native read under current advice; changed pins retire the old occurrence and require a current restart.

## Cost

One deliberate window uses one exact Subject read, the shared active-pointer plus immutable Release reads, and at
most one native relations/links page: at most four reads and no target reads or writes. Release bounds remain 4 MiB,
1,024 types and 4,096 properties; at most 64 streams are accepted. Subject responses above 2 MiB are unavailable.
The native page is limited to 20 rows, each at most 128 KiB serialized UTF-8 JSON, and 2,686,976 total bytes. Opaque
cursors are at most 4,096 UTF-16 units; an immediate repeated cursor, duplicate assertion or mismatched identity is
unavailable. Retention is one accepted response, its exact address, one pending address/operation, at most eight
previous addresses, one selected holder/assertion key and one keyboard origin. No prior body or accumulated target
set is retained. An address has two 36-byte UUIDs, up to 256 stream units and 4,096 cursor units: at most 26,230
serialized UTF-8 JSON bytes, accounting for six-byte JSON escapes. Eight prior addresses add at most 209,840 bytes.
The complete navigation envelope (accepted, eight prior and pending addresses plus keys, separators and operation)
is at most 262,377 bytes. The selected 73-character holder/assertion key adds 75 serialized bytes. Composed with
the 4,194,304-byte Release, 2,097,152-byte Subject and 2,686,976-byte page, retained source/navigation/selection
payload is at most 9,240,884 bytes. Derived facts, labels and selected rows refer to that one accepted body and
bounded definitions; this serialized payload accounting is not a JavaScript heap estimate. Runtime projections,
serialization, DOM and transport allocations add memory. Work is O(Release metadata + admitted subject/page bytes),
independent of total catalogue size; producer transport allocation precedes the consumer's bounds.

Focused generated-client tests pin edition identity, dates, configuration, directed slots, exact occurrence inspection, bounded Previous, retry and
explicit recovery after observation retirement. Stories describe admitted, TBA, empty, unavailable-continuation and unsupported states; they
are source examples and do not establish native configuration or browser acceptance. Integration owns broader
acceptance, theme/viewport rendering and native publication checks.
