# Recover one Collection from a Library archive

Web provides a signed-in visit at `/library/recover-collections` for one manually curated Collection from a completed
private Library export. It uses the installed `libraryArchiveCollectionRecoveries` methods and their generated request
and response types. The browser does not decode the archive, persist its bytes, or create a second importer.

Decision: offer only a new private destination because the installed native journey admits creation but exposes no
merge or reuse command.

## What the visit supports

The visit accepts export version 1, shows native coverage and omissions, and selects one eligible curated Collection.
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
base64 body is at most 47,535,448 characters. A conservative current response bound is
`B = 50 × (120,000 source-record bytes + 512 projected-response bytes) + 16,384 root/cursor bytes = 6,041,984 bytes`;
the source row cap and fixed native envelope supply these terms.

Upload transfer is `O(U)`. One-page rendering and response state are `O(P + B)`; the explicit selection retains at most
`R` delivered occurrence operands, and review adds `O(1)` beyond those operands. The visit does not walk pages to a
total, hydrate each row, reconstruct rank keys, or load the archive into the browser. Subject suggestions run only
after an explicit search term. Native apply independently caps each request at 25 commands and total selected work
at `3R + 2` attempts.

Stories cover upload, reviewed selection, stale conflict and partial result. Focused Web acceptance exercises the
mounted journey and bounded/source-session behavior; native HTTP producer acceptance remains owned by Commerce.
Preparation decoders and producer implementation are not Web delivery; this guide describes the delivered consumer.
