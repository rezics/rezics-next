# Collection placement and transfer journey

The Collection editor moves selected curated occurrences through its existing native atomic transfer command. The
chooser only captures a currently owned destination revision and, when selected, one disclosed occurrence ID as its
`after` anchor. Subject identity is not used as an occurrence identity; repeated Subjects remain separate rows and
separate transfer operands.

## Bounded browsing

Destination pages come from `readCollectionMoveChoices`, which makes one owner Collection-list request with the
current viewer's curator ID. It retains only native `curated` identities, so the source, dynamic Collections and
built-in identities cannot be destinations. Selecting a row performs an authorized current destination header read;
the header must name the same viewer, a curated Collection and a positive revision. Public source rows do not supply
authority for this private owner lookup.

Placement pages come from `readCollectionMovePlacements`. Each explicit page reads the destination header and one
member page, checks the same owner and captured revision, and projects only disclosed occurrence IDs and labels.
Labels from page 3 or later say which local page and position was used. The dedicated `At the start` choice is native
`after: null`; the first row loaded from a later page is never described as the Collection's beginning.

The navigator keeps one current page and one previous cursor descriptor. Next consumes the exact native opaque
frontier; Previous steps back once, and Restart explicitly rereads page one. Further previous movement uses Restart
instead of retaining a cursor history. Empty continuing pages keep their frontier and remain navigable. There is no
refill, total scan, numeric offset, catalogue search over downloaded rows or inferred exhaustion. The Web validators
derive cursor cap **C=4,096 characters** from the installed Collection routes. Each native list request uses
`LIBRARY_PAGE_LIMIT=100`, so **L=100 rows**. Source selection is limited to the current 100-row page and native
transfer accepts **S=1–100 distinct occurrence IDs**. A page projects at most L destination or anchor labels (**B
≤100 labels per current page**); a selected anchor retains only its ID and one label/page/position snapshot.

Per visit, one destination page costs one native owner-list request. Choosing a destination costs its header plus one
first placement page (header and member request); each later placement page repeats only those two bounded reads.
Transfer remains one existing native command. A confirmed receipt triggers one source page read and one destination
header/member-page read; an explicit reconciliation retry has the same fixed bound. Browser retention is
**O(L+S+B+C)**: current choice and placement pages, the selected destination, one selected-anchor review snapshot,
the source occurrence snapshot, and bounded cursor/route descriptors. It never retains all previous pages or a
whole catalogue. The native command's indexed work, locks, capacity admission and repair cost remain Commerce-owned.

## Capture, confirmation and recovery

Choosing an anchor captures its occurrence ID and disclosed label separately from any Subject ID. The label may
remain visible while another placement page is read, but the page replacement does not reauthorize it. A new
selection must use a currently disclosed row. A destination revision mismatch retires the placement and parent
review choice; the person must reread the destination and choose again. Concealed, missing or removed anchors cannot
be newly selected. The native transfer remains the final authority for anchor validity, source/destination CAS,
capacity and eligibility.

Review shows the source Collection, selected occurrence IDs and count, destination title/revision, exact anchor or
native start placement, and that one atomic native command moves all captured occurrences together. Confirmation
preserves the source page revision and selected IDs, destination revision and anchor ID. `transferCollectionMembers`
is the only writer: the browser does not loop through remove/add or deduplicate by Subject.

The command capture retains the original viewer's credential, sender, key and body. An unavailable response keeps the
review and exact command for explicit retry; browsing is disabled and cannot retarget it. A definitive refusal keeps
the review and offers explicit source/destination rereads. After reread, a new intent requires fresh selections and
placement; the old request is not resubmitted under a new key. A success receipt is never sent again during
navigation. It reconciles one bounded current source read and one bounded destination read, then offers locale-aware
links to both exact Collection routes. The source link preserves its current validated filter and cursor. Back and
Forward re-admit current native state; confirmation and private chooser data remain component-local.

All private reads use the current session and native disclosure, return `private, no-store`, and stay out of shared
hydration and query caches. Read admission may permit a healthy null-CSRF session where the native read contract does;
commands still require current native write authority. Session, viewer, locale, route, exposure or source Collection
replacement retires old reads and controls synchronously. Late responses cannot change another destination or move
focus. Closing a destination browse focuses the chooser heading; closing review remounts the chooser and focuses its
destination heading. Controls wrap long localized titles and retain 44px targets in all eight launch locales.

The destination-only bulk-add consumer shares this bounded destination chooser but does not select a placement or
construct a transfer. Its producer's ordered Subject snapshot, duplicate-permitting versus skip-present mode,
preview/confirm, native operation and unknown-command recovery remain with the existing bulk journey. If that
producer snapshot changes before submission, the selected destination is retired. A sealed unknown bulk command
retains its original capture and is not cleared by later producer changes.

## Decisions and remaining evidence

Decision: browse visits retain the current page plus one previous cursor; Previous steps back once, and Restart
explicitly rereads page one, so deep browsing never stores cursor history.

No new endpoint, writer, bulk engine or execution/undo schema is introduced. Web binds the installed owner-list,
destination/member read helpers and native transfer command. Focused consumer fixtures exercise their request shapes;
native authorization/execution, browser, visual and cross-scale acceptance remain integration checks.
