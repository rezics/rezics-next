# Personal list import

Decision: bind the generated `KernelClient.libraryImports.vndb` methods from the mounted native route. A row enters
the apply selection only after explicit target and released Library-state review; confirmation applies only the
displayed admitted selection. Keep the visit unavailable if the generated methods are missing.

Web owns a signed-in visit for a person's own VNDB XML export. Commerce owns private upload admission, matching,
row review, and application. The Kernel routes are mounted at `/v1/libraryImports/vndb`, and the native contract is
documented in [Personal VNDB list import](../../../../docs/library-import-vndb.md). The installed `@rezics/client`
surface exposes typed `libraryImports.vndb` methods for preview, bounded page reads, source evidence, review, apply,
cancel, and deletion. Web stays unavailable if any required generated method is missing.

The native source accepts only the person's uploaded `vndb-export version="1.0"` XML. It does not claim another
account, fetch provider data, create catalogue subjects or identities, publish reviews, or turn private notes into
public facts. VN and release identifiers remain distinct. Titles can assist display and explicit catalogue search;
they do not select identity. Existing Library facts remain unless the person explicitly reviews and chooses an
admitted state replacement. Web calls the generated client methods directly and adds no local endpoint, parser,
synchronizer, or native implementation.

Native preview maps only an explicitly selected released Library state. VNDB status labels suggest roles but do not
choose state IDs. Scores retain their original 1–10 scale and do not become local ratings. Progress and units, date
precision, notes, privacy, labels, reviews, release records, unknown XML, and unmapped metadata remain private source
evidence unless a native owner admits a field. A private note never becomes a public review.

Upload errors must preserve native distinctions. Invalid XML and XML above 2 MiB return HTTP 400. The independently
escaped JSON request wire limit is 12 MiB + 64 bytes and returns HTTP 413; browser `File.size` is not the wire size.
Web must not pre-parse XML or replace native admission. Preview changes no facts. Native pages and row outcomes are
bounded, and cancellation or departure stops new work without rolling back acknowledged rows. An unknown apply must
retain the original command and exact selection for explicit retry. Session or source replacement retires the upload,
preview, late callbacks, and retry authority. Upload contents, notes, and private evidence stay out of URLs, persistent
browser storage, public metadata, and diagnostics.

MAL remains a separate uploaded format with its existing native prerequisite and journey owner. VNDB has a separate
Commerce producer dependency; neither is a generic multi-provider client parser or synchronizer.

AniList, Bangumi and MAL confirmation pages admit source observations through the installed
`libraryEntries(...).sourceObservations.post` method after the existing import apply. VNDB stays unavailable until
those generated import methods exist; this visit does not add a second parser.
