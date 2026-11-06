# Recover one Collection from a Library archive

Web provides a signed-in visit at `/library/recover-collections` for one manually curated Collection from a completed
private Library export. It uses the installed `libraryArchiveCollectionRecoveries` methods and their generated request
and response types. The browser does not decode the archive, persist its bytes, or create a second importer.

Decision: offer only a new private destination because the installed native journey admits creation but exposes no
merge or reuse command.

## What the visit supports

The visit sends original export versions 1 through 4 to native validation. Each complete manifest and all unsupported
rows retain their original version and accounting. It shows native coverage and omissions, and selects one eligible curated Collection.
It reads one native page at a time and shows each occurrence as its own item, including repeated Subjects, its actual
note state and native order support. A selected occurrence is preserved with its stored note and validated native
order; omitting the occurrence omits its note as well. The native review owns order movement and the final order
operands.

For each distinct selected source Subject, the person explicitly searches the current disclosed Subject suggestions
and chooses a target. Native review checks current canonical identity again. An archived Subject ID, title, pin,
revision, timestamp or receipt never grants current access. Missing, inaccessible, changed or unsupported targets
remain unresolved in native outcomes.

Review names the new private destination and source title and description, lists the exact selected occurrence notes,
shows native membership/order completeness and any admitted pin result, then requires a deliberate confirmation.
Apply proceeds only from the native review ID and digest. Each click admits the native maximum of 25 steps; the visit
shows continuation and never polls or refills in the background. Current outcomes are read one page at a time and
link only to the actual receiving-account Collection ID returned by Native.

Version 1 sections outside the selected curated Collection remain retained evidence or explicit omissions. Entries,
labels, assignments, sessions, holdings, provider import evidence, dynamic rules, publication, public follow state,
grants, other accounts and full-account restoration are not offered here. Unsupported Collection kinds stay visible
but cannot be selected. Source privacy is never copied; destination privacy is always private.

## Private visit and retry boundaries

Decision: disable the file chooser while preparing one selected archive; keep a failed read selected for explicit retry or replacement.

Decision: Keep separate bounded cursor windows for Collections, selected-Collection occurrences, and outcomes; commit coordinates only after the exact current read succeeds, and retry its staged cursor as a read.

The upload, current page, selected operands and previews live only in mounted page memory. The upload uses a same-site
no-store server function and the current viewer/CSRF session; neither archive bytes, continuation cursors nor source
IDs enter the URL or persistent browser storage. Current session, CSRF credential epoch, route unmount or native
expiry retires the visit and ignores late callbacks. Native evidence expires 24 hours after upload; reads do not
extend it.

An uncertain write keeps its original command key where the native operation has one, exact body, current visit and
confirmation operands. The only retry control replays that command. A stale review must be read and reviewed again;
it cannot authorize apply. Explicit cancellation stops new native work while accepted members and the resulting
private Collection remain. Expiring evidence does not delete or unpublish that Collection.

## Bounds and checks

The delivered bounds are `U = 34 MiB` raw upload, `P = 50` native preview/result rows, `R = 1,000` selected
occurrences, 25 native steps per apply call, 24-hour evidence retention, and 4,096-character cursors. The canonical
base64 upload body is at most 47,535,448 ASCII characters. A conservative current native response bound is
`B = 50 × (120,000 source-record bytes + 512 projected-response bytes) + 16,384 root/cursor bytes = 6,041,984 bytes`.
The visit retains at most one current page per reader, so three simultaneous page bodies are bounded by `3B =
18,125,952 bytes`; it retains no old pages or response archives.

Each of the three cursor windows keeps at most eight predecessor cursors, one current cursor and one staged target.
At 4,096 characters each, this is at most 40,960 cursor characters (81,920 UTF-16 bytes) per reader and 122,880
characters (245,760 UTF-16 bytes) total, plus fixed object and array overhead. A staged target stores only its cursor
and admission coordinates; it does not duplicate the predecessor stack.

The explicit selection retains at most `R` delivered occurrence operands. At the producer's 120,000-byte source-row
cap plus 512-byte projection allowance, that is at most 120,512,000 bytes for 1,000 selected row copies. Review sends
only occurrence IDs and one source-to-target mapping per distinct selected Subject (at most 1,000 each), not those
row copies; its canonical JSON body is at most 155,094 ASCII bytes for UUID operands. Apply retains one review ID and
64-character digest (127 canonical JSON bytes) and each click admits at most 25 native steps; total selected work
remains capped at `3R + 2` attempts. Upload transfer remains `O(U)`. The visit does not walk pages to a total, hydrate
each row, reconstruct rank keys, or load the archive into browser storage. Subject suggestions run only after an
explicit search term.

Decision: keep the original encoded archive after a successful read so Cancel then Restart can reuse it; a completed
export from this signed-in owner is the same source. Results reopen the current Collection reader for actual title,
privacy, member identities, notes and order.

Stories cover upload, local preparation, file-read failure, reviewed selection, stale conflict and partial result.
Journey tests pin original-archive restart, exact original bytes, opaque sequential cursors, native Collection readback and other-member denial. The native Web owner
and other-member walk exports a completed file, restores through the page, and rereads the Collection. Focused Web
acceptance exercises the mounted journey and bounded/source-session behavior; native HTTP producer acceptance
remains owned by Commerce.
Preparation decoders and producer implementation are not Web delivery; this guide describes the delivered consumer.
