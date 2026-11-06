# My ratings

`/library/ratings` is the private account view of the native current-vote inventory. The row's original
`(questionId, targetId)` is its identity even when its admitted Subject summary points to a merged terminal. The
summary is opened through the localized Subject route; the native `subjectHref` is never used as a browser URL.
Public figures, source statistics and Library membership do not come from this inventory.

The route reads the installed native page through the generated `@rezics/client` operation
`me['rating-votes'].get`, and its page and row types come from that operation's published response. A server-only
closed validator in `response.ts` still admits each page before use. Vote PUT, DELETE and exact original-key readback
use the same typed client. The producer owns identity resolution, question lifecycle, suppression, write admission and
readback. Do not broaden the Subject assessment writer.

The page renders at most twenty original keys in native question/Subject order and keeps the opaque cursor byte for
byte. An empty page with a continuation remains a continuation. It does not accumulate pages, refill after clear,
search, sort, filter or infer a total. A same-key update retains its position; a clear removes only that visible row.
The next page is always a fresh native request. A dependency failure exposes an explicit retry at the identical
opaque cursor, even when no successful read remains. Signed-out/revoked access, unavailable dependencies, empty
terminal pages and concealed empty pages with continuation have separate outcomes.

An admitted editable question uses its integer minimum, maximum and step. Retired questions allow only the delivered
Clear action. Merged-source, identity-pending and read-only rows explain the current limitation without command or readback
controls. Read-only answers retain their original pair, scale, zero or nonzero units, change time and admitted Subject
navigation. Read-only advice is separate from retired-question Clear. Commands carry the exact original
key and one idempotency intent; uncertain retry reuses the frozen method, path, body and key. Acknowledgement is
reported separately from exact readback. An explicit exact read after an uncertain command reports the current
answer without confirming the original command, even if the value matches; the original intent remains available for
explicit same-intent replay while currently admitted. A clear is confirmed by readback 404. No public aggregate can restore a
cleared row.

Ratings owns the explicit operation/context descriptor, including the currently required `personal_library` exposure.
Web reader infrastructure composes the current viewer, that exposure, locale, route address/cursor and native source for the private
query. It is no-store, has zero query retention, and stays out of URL/history payloads and persistent storage.
Account, credential/CSRF, locale, exposure, address and admitted-reader replacement retire selection, draft and
callbacks. Replaced action advice also retires the form, confirmation and delayed command/readback callbacks; a
later editable row requires explicit selection and never replays the previous command. Returning
from Subject reading requests the current page again and restores focus. Dirty drafts use the shared departure
confirmation; pending or uncertain command ownership requires review before departure.

Decision: after return, retain only the exact original pair as a short-lived in-memory focus bookmark; hide prior advice while refreshing, then require a fresh Inspect action before editing or clearing.

Decision: during an eligible My ratings visit, retain up to eight admitted predecessor cursors plus the current cursor in the existing return provider; stage each move and commit it only after the target response is admitted.

## Cost

- **Touches**
  - One native page request on admission or explicit refresh/return, using the existing prepared session.
  - One native page request for each First, Previous or Continue move; the return provider keeps only the accepted cursor path, never page bodies.
  - One O(N) exact-pair index per admitted page. Selection and row lookup are O(1); presentation is O(N).
  - Zero per-row question, vote, public-figure or aggregate reads. A deliberate write has one command and one exact
    original-pair readback. An explicit uncertain retry reuses the same intent; there is no polling.
- **Bound**
  - Native page: N ≤ 20; cursor ≤ 4096 characters. Web retains one page, one selected pair and one bounded draft or
    command intent. It never refills or accumulates pages.
  - The in-memory visit path holds at most eight predecessor cursors plus current, each within the existing 4096-character cursor bound. A failed target leaves the accepted path unchanged for exact-cursor retry.
  - The inventory and command requests use private no-store handling. Query state has `gcTime: 0` and does not enter
    persistent storage, URL or browser history state.
- **Growth checks**
  - Presentation and indexing at N=1, 10 and 20 stay linear in the supplied page. A selected editor does not scan
    other rows or hydrate additional records.
  - Repeated terminal summaries remain distinct by original pair; zero remains a value; retired and merged-source
    and read-only action variants expose only their admitted controls.
  - Sparse continuation, exact clear/readback, uncertain same-intent retry and callbacks after account/locale/address
    retirement are covered by focused Web acceptance.
  - Native indexed raw-page and cold summary/account/Realm costs belong to Content's producer acceptance. Native
    256/1024/4096 growth is not asserted by this frontend.

Decision: vote PUT and DELETE send the command's Idempotency-Key as a quoted structured-field string, the form the Kernel
parses. Subject rating writes do the same, so a bare UUID is never sent as a command key.

Decision: HTTP 503 `atomic_guard_unavailable` is retryable. Own-votes and the shared rating control keep the original
intent for exact replay and do not treat that answer as a local reject. Same-logical-home reviewed writes still
commit; foreign-home provider votes stay deferred.

Decision: the seeded ratings walk is the fewest check that pins the served Subject and My ratings journey; native
vote, aggregate and figure suites stay the producer. It runs on a local walk stack after the Worker can load
denied config dependencies, so the pages actually start. Each walk retires leftover seed journals because the
stack database is new; the journey `bun test` runs from `apps/web` so root preloads cannot send it to check hosts.

Decision: own-votes tests that stub `kernel/client` keep the real `kernelClient` export, so a shared `bun test`
process can still load Subject ratings and mixed personal actions.

Decision: the installed generated own-votes operation is the only read seam. Web types re-export the published
`OwnVotesPage` and `OwnVoteEntry` from `@rezics/client`, so no Kernel schema import remains in the Web module graph.
Tests use those types. The Workers-safe validator stays because the outer envelope is additive while entries and action
advice remain closed; it adds no second native schema meaning.

The installed producer exports `createOwnVotesReader(deps).page(actor, { cursor? }, deadline)` and the register DTOs
and schemas. Its source examples in `services/kernel/test/rating/own-votes-page.test.ts` cover populated zero,
concealed continuation, identical-cursor dependency retry, fenced read-only advice and revoked access. Those cases
inform the typed Web states; they are not native execution evidence or published response recordings. Mounted response
recordings remain Content's seam. Connected stories exercise the
existing workspace boundary; they do not substitute for generated publication or native acceptance.
