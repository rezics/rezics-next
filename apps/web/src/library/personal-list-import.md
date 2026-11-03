# Personal list import

Decision: bind the generated `KernelClient.libraryImports.vndb` methods from the mounted native route. Eden's
`libraryImports` surface is a function, so Web reads `vndb` by property access rather than an object/`in` check. A row
enters the apply selection only after explicit target and released Library-state review; confirmation applies only the
displayed admitted selection. Keep the visit unavailable if the generated methods are missing.

Web owns a signed-in visit for a person's own VNDB XML export. Commerce owns private upload admission, matching,
row review, and application. The Kernel routes are mounted at `/v1/libraryImports/vndb`, and the native contract is
documented in [Personal VNDB list import](../../../../docs/library-import-vndb.md). The installed `@rezics/client`
surface exposes typed `libraryImports.vndb` methods for preview, bounded page reads, source evidence, state review,
apply, cancel, and deletion. Its current page and review types do not publish score review/result fields, and Content
has not admitted the score effect. Web keeps score actions unavailable until both boundaries are available; state
import and source inspection remain usable.

Decision: display native `fields.score` with its exact raw spelling, retaining `fields.vote` compatibility; keep the
installed generated request types as the boundary and defer score commands until those types are published.

Review inputs and selected apply commands are copied and frozen before sending, so a lost acknowledgement retries
the original operands and key even if the form changes. A new review returns to review before confirmation, and an
authoritative page without a decision removes the previous local selection.

Decision: derive page, review and apply-result types from the installed generated methods, freeze apply operands
when confirmation opens, and withdraw the previous selection as soon as replacement review begins, including refusal.
The installed declarations still lack `action: 'score'`, `nativeScore`, `scoreDecision` and `scoreReviewId`; the request
aliases remain the minimal seam for their publication. Score review can become usable when those types are published;
vote effects separately require Content's conditional writer.

The native source accepts only the person's uploaded `vndb-export version="1.0"` XML. It does not claim another
account, fetch provider data, create catalogue subjects or identities, publish reviews, or turn private notes into
public facts. VN and release identifiers remain distinct. Titles can assist display and explicit catalogue search;
they do not select identity. Existing Library facts remain unless the person explicitly reviews and chooses an
admitted state replacement. Web calls the generated client methods directly and adds no local endpoint, parser,
synchronizer, or native implementation.

Native preview maps only an explicitly selected released Library state. VNDB status labels suggest roles but do not
choose state IDs. Source scores retain their original 1–10 scale and do not become local ratings. This visit shows
that source scale but keeps native score actions unavailable. The review explains that 7.3 has no exact match on a
native half-step scale, source 0 is invalid, native vote 0 is valid, and clearing is separate. Uploading a score or
choosing a Library state does not grant consent for a public or aggregate vote; existing votes remain unchanged.
Progress and units, date precision, notes, privacy, labels, reviews, release records, unknown XML, and unmapped
metadata remain private source evidence unless a native owner admits a field. A private note never becomes a public
review.

Upload errors must preserve native distinctions. Invalid XML and XML above 2 MiB return HTTP 400. The independently
escaped JSON request wire limit is 12 MiB + 64 bytes and returns HTTP 413; browser `File.size` is not the wire size.
Web must not pre-parse XML or replace native admission. Preview changes no facts. Native pages and row outcomes are
bounded, and cancellation or departure stops new work without rolling back acknowledged rows. An unknown apply must
retain the original command and exact selection for explicit retry. Session or source replacement retires the upload,
preview, late callbacks, and retry authority. Upload contents, notes, and private evidence stay out of URLs, persistent
browser storage, public metadata, and diagnostics.

Score context cost follows the native owner: at most one question and one current-own-vote read per addressed VN
target on a page of eight rows. Each score review repeats that pair plus the bounded owner/upload read, tuple match,
target observation, review receipt and locked decision update. The native owner reserves 32 KiB per possible page row
within the existing 16 MiB evidence cap and keeps baselines and command operands within the 8 MiB decision bound.
An apply admits at most eight total actions and currently executes zero Content vote or aggregate writes. Journey
calls remain one upload plus bounded pages, explicit reviews, selected actions, lifecycle cleanup and exact retries.

MAL remains a separate uploaded format with its existing native prerequisite and journey owner. VNDB has a separate
Commerce producer dependency; neither is a generic multi-provider client parser or synchronizer.

AniList, Bangumi and MAL confirmation pages admit source observations through the installed
`libraryEntries(...).sourceObservations.post` method after the existing import apply. VNDB keeps its own generated
client contract and does not add a second parser or provider synchronizer.
