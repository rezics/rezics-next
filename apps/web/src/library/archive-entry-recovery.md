# Library archive recovery

`/library/recover-archive` is the Library destination for recovering selected Entries, private labels, assignments,
annotations, occurrence journals and source observations from a completed local archive. The native owner is
[Library archive review and merge](../../../../docs/library-archive-merge.md);
the artifact format is owned by [Library export](../../../../docs/library-export.md). This guide owns the mounted Web visit.

Decision: use the installed generated original-text upload and exact `{items:[{ordinal,reviewRevision}]}` confirmation
for every supported branch; preserve current fields by default and require deliberate field-level set or clear choices
for personal facts. Web consumes producer-published operands without generating another client, decoding files locally
or adding a native endpoint. Content remains the shared publisher.

## Upload and inventory

The signed-in route prepares exposure, sets `private, no-store`, keeps no private loader cache and uses noindex metadata.
The mounted visit captures the existing encrypted original-sender credential before accepting a file. Every server
function admits the expected current viewer and credential epoch before opening that credential. The browser keeps
it only with the mounted visit; an uncertain command never swaps to a newly captured sender.

The file control admits an original file up to 34 MiB before reading its text. The generated upload sends that text
unchanged. Only the native decoder interprets JSON, with depth 32, 100,000 records, 32 MiB compact record bytes and
120,000 bytes per record. Completed V1/V2/V3 artifacts follow current native support; V4 remains refused, even though
new exports emit it. Malformed, incomplete, unsupported and inconsistent files retain their native outcomes.

One upload identity and one preview page of at most 100 records are retained. Inventory shows native computed
section counts, capture and treatment alongside validated overall manifest rows and compact bytes. It explains empty
captures, retained unsupported evidence and manifest omissions. An empty page never substitutes for inventory. One
upload, page size, selected-row limit and immutable review lifecycle cover every activated branch. V4 provider sections
and rows without a producer-published review operand remain retained unsupported evidence.

## Deliberate selection and immutable review

A person explicitly enters the current canonical Subject, a supported current state and create/update/preserve choice,
or chooses a current private label ID or validated creation using its archived name. Personal rows require a current
Subject plus the exact existing Entry incarnation, non-retired Session or provider/record address. Equal names,
archived IDs, titles and dates never supply mappings. Native review compares current values with archived evidence.
Personal fields start as preserve; set and clear are deliberate field-level choices. Label mappings must be reviewed
before assignments; a created label must be acknowledged before reviewing its assignments. The shared selection is
bounded to twenty rows across branches and page navigation.

The selected choices and returned ordinal, status and `reviewRevision` appear together. The displayed preview also
shows its exact native review, including current conflicts. Explicit confirmation binds the returned revisions; a
review refresh or selection edit clears confirmation. A changed current revision/incarnation produces fresh native
conflict and requires a new review and explicit confirmation for unstarted effects. Accepted rows can be unselected
before reviewing the remaining work; a native acknowledged row is never refreshed or reapplied as a new choice.

## Delivery, cancellation and readback

`visit.ts` owns the existing bounded selection, immutable confirmation and cancellation checkpoints. `controller.ts`
connects it to `KernelClient.libraryArchiveMerges` upload/status/preview/review/apply/results/cancel/prune. Unknown
upload delivery retains the original text/key for explicit retry and disables replacement. After admission the text
is released. Unknown apply retains the exact original upload, revisions and sender; native per-item custody retains
its original key, canonical operands and started checkpoint. Reads of current facts never settle that uncertainty.
A refused replay also retains the original command. Cancellation stops unstarted effects while preserving accepted
partial results; it cannot release a started command before matching native acknowledgement.

Only acknowledged matching effects supply canonical destinations. One selected result page is shown, retaining
acknowledged rows for the current selection when a later native page omits them. Explicit readback uses the actual
current Entry, private annotation/source-observation reader, occurrence journal reader or addressed FULL
label-assignment reader, never historical archive values. Removal and seven-day expiry of private evidence do not
undo admitted Library changes.
Expiry clears private upload/replay state and retains accepted results until replacement or session retirement.
Pruning is explicit and native-bounded to 100 evidence records per command.

Every callback is fenced by upload identity and the existing visit requests, the live viewer/credential/CSRF epoch,
route address, locale, exposure observation and mounted lifetime. Replacement and unmount retire callbacks and
private state. The server functions return `private, no-store`; archive values never enter query caches or errors.

## Bounds and verification

One native preview/result acquisition reads P+1 complete retained rows (P≤100); review/apply selects R≤20 across
entries, labels, assignments, annotations, journals and source observations. The
120,000-byte record cap does not bound the full response: every preview row also includes review JSON and revision,
and results include native result JSON. The composed maximum is the UTF-8 size of the complete native envelope,
including coverage, escaped evidence/review/results and punctuation. The native producer's precise caller formula
and remaining native costs are owned by [Bounds and verification](../../../../docs/library-archive-merge.md#bounds-and-verification).
This page adds one sender preparation, one upload, one first preview, a review plus a refresh of only the displayed
page, explicit apply/retry/cancel, and only requested status/result/current reads or cleanup. It never scans every
page or account-wide labels and adds no smaller native cap. Source bounds are not observed byte/growth acceptance.

Focused Web tests cover mounted file admission, exact confirmation, unchanged original retries, cancellation,
current readback and native boundary outcomes using the existing native fixture. Existing controller fence and
bounded-growth assertions remain. Browser, installed-root, byte/caller observations, broader native acceptance and
promotion remain integration responsibilities.
