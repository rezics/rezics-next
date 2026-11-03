# My ratings

`/library/ratings` is the private account view of the native current-vote inventory. The row's original
`(questionId, targetId)` is its identity even when its admitted Subject summary points to a merged terminal. The
summary is opened through the localized Subject route; the native `subjectHref` is never used as a browser URL.
Public figures, source statistics and Library membership do not come from this inventory.

The route reads the installed native page through a server-only adapter validated by the producer's
`OwnVotesPageSchema`. At this base the generated `@rezics/client` has no own-votes operation or types. The adapter
uses the installed `/v1/me/rating-votes` operation and producer schema; vote PUT, DELETE and exact original-key
readback continue through the generated typed client. The producer owns identity resolution, question lifecycle,
suppression, write admission and readback. Do not broaden the Subject assessment writer.

The page renders at most twenty original keys in native question/Subject order and keeps the opaque cursor byte for
byte. An empty page with a continuation remains a continuation. It does not accumulate pages, refill after clear,
search, sort, filter or infer a total. A same-key update retains its position; a clear removes only that visible row.
The next page is always a fresh native request.

An admitted editable question uses its integer minimum, maximum and step. Retired questions allow only the delivered
Clear action. Merged-source and identity-pending rows have no mutation controls. Commands carry the exact original
key and one idempotency intent; uncertain retry reuses the frozen method, path, body and key. Acknowledgement is
reported separately from exact readback. A clear is confirmed by readback 404. No public aggregate can restore a
cleared row.

The current viewer, `personal_library` exposure, locale, route address/cursor and native source bind the private
query. It is no-store, has zero query retention, and stays out of URL/history payloads and persistent storage.
Account, locale, exposure, address and admitted-reader replacement retire selection, draft and callbacks. Returning
from Subject reading requests the current page again and restores focus. Dirty drafts use the shared departure
confirmation; pending or uncertain command ownership requires review before departure.

## Cost

- **Touches**
  - One native page request on admission or explicit refresh/return, using the existing prepared session.
  - One O(N) exact-pair index per admitted page. Selection and row lookup are O(1); presentation is O(N).
  - Zero per-row question, vote, public-figure or aggregate reads. A deliberate write has one command and one exact
    original-pair readback. An explicit uncertain retry reuses the same intent; there is no polling.
- **Bound**
  - Native page: N ≤ 20; cursor ≤ 4096 characters. Web retains one page, one selected pair and one bounded draft or
    command intent. It never refills or accumulates pages.
  - The inventory and command requests use private no-store handling. Query state has `gcTime: 0` and does not enter
    persistent storage, URL or browser history state.
- **Growth checks**
  - Presentation and indexing at N=1, 10 and 20 stay linear in the supplied page. A selected editor does not scan
    other rows or hydrate additional records.
  - Repeated terminal summaries remain distinct by original pair; zero remains a value; retired and merged-source
    action variants expose only their admitted controls.
  - Sparse continuation, exact clear/readback, uncertain same-intent retry and callbacks after account/locale/address
    retirement are covered by focused Web acceptance.
  - Native indexed raw-page and cold summary/account/Realm costs belong to Content's producer acceptance. Native
    256/1024/4096 growth is not asserted by this frontend.

Decision: until Content publishes the own-votes route in `@rezics/client`, Web uses a server-only adapter validated
by the native schema while vote commands and readback use the existing typed client.
