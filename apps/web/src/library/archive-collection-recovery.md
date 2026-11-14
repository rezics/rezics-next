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

## Explicit presentation choice

Decision: default to mixed and reuse the Collection editor's released-Type choices; only an explicit
`presentationKind` enters native review, and sealed native kind, source and release digest remain unchanged through
apply retry and independent presentation results. Archived values never select a Type.

The occurrence preview supplies the raw archived kind, availability, disposition and current digest. Unsupported
archived meaning stays visible while the person chooses mixed or a current Type. Choices read the existing active
release and use the existing Collection editor projection and accessible radio controls, with no member hydration
or separate Type directory. Leaving the choice unset sends null. Native performs Type admission and seals the
reviewed release; Web does not substitute a browser release digest.

Review displays the sealed kind, archived/alternative/mixed source and release digest next to the title, member,
note and order choices. Editing a confirmed review requires a new native review and deliberate confirmation.
Unknown commands lock edits and retain their exact body, command key, visit credential and review. A current release
cannot rename or replace a sealed choice. A stale unaccepted create is read back before a fresh review; an accepted
create replays its original confirmation. Cancellation and source/account/locale retirement keep the existing visit
boundaries. Presentation results show mixed, adopted, unsupported-or-stale and unattempted independently of member,
note and order results, with `fullRestoration: false`. Explicit native Collection readback includes its current
presentation kind and owner/mixed source, including the native fallback after Type retirement.

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

## Revisiting the current Collection

Decision: keep an independent native Collection window with one displayed page, at most eight observed predecessor
addresses, and one requested or failed address; First is explicit, Back rereads an observed address, and Retry repeats
the exact failed address without moving recovery outcomes or replaying restore.

Next remains available on sparse pages when Native supplies a continuation. No ordinal is inferred across pages;
members retain the native order within the displayed page, and only Native supplies the Collection member count.
Each explicit movement makes one existing receiving-Collection read: its metadata read and one bounded 100-member
read. There is no refill, member hydration, scan or prefetch. Opaque tokens stay unchanged, including an empty token.
An unsuccessful read leaves the displayed position and history intact and labels the failed request separately.
Unavailable, rejected address, missing Collection, denied access, sparse page and empty terminal page have distinct
messages. Denied or missing Collection responses hide the former page while preserving recovery results.

A new request supersedes an older response. A changed destination ID, archive source, account, credential, locale,
unmount or expiry retires Collection coordinates and deferred focus. A status or outcome read with the same
Collection ID does not move this window. Collection reads also preserve sealed review operands and any uncertain
write command. Keyboard activation moves focus to the Collection heading only after that exact current read succeeds;
subsequent focus, pointer or keyboard movement cancels the deferred focus. Controls wrap, retain 44px targets and
visible focus, and use all eight locales.

## Bounds and checks

The delivered bounds are `U = 34 MiB` raw upload, `P = 50` native preview/result rows, `R = 1,000` selected
occurrences, 25 native steps per apply call, 24-hour evidence retention, and 4,096-character cursors. The canonical
base64 upload body is at most 47,535,448 ASCII characters. A conservative current native response bound is
`B = 50 × (120,000 source-record bytes + 512 projected-response bytes) + 16,384 root/cursor bytes = 6,041,984 bytes`.
The visit retains at most one current page per reader, so three simultaneous page bodies are bounded by `3B =
18,125,952 bytes`; it retains no old pages or response archives. Independently, the Collection reader keeps one native page of at
most 100 members and its metadata, without retaining previous member page bodies.

Each of the three cursor windows keeps at most eight predecessor cursors, one current cursor and one staged target.
At 4,096 characters each, this is at most 40,960 cursor characters (81,920 UTF-16 bytes) per reader and 122,880
characters (245,760 UTF-16 bytes) total, plus fixed object and array overhead. A staged target stores only its cursor
and admission coordinates; it does not duplicate the predecessor stack. The independent Collection window adds
at most eight predecessor tokens, one displayed token and one requested token: another 40,960 characters (81,920
UTF-16 bytes), with no page numbers or native membership inferred from these coordinates.

The explicit selection retains at most `R` delivered occurrence operands. At the producer's 120,000-byte source-row
cap plus 512-byte projection allowance, that is at most 120,512,000 bytes for 1,000 selected row copies. Review sends
only occurrence IDs and one source-to-target mapping per distinct selected Subject (at most 1,000 each), not those
row copies; its canonical JSON body is at most 155,884 ASCII bytes for UUID operands plus a 128-character Type identifier (including JSON escaping). Apply retains one review ID and
64-character digest (127 canonical JSON bytes) and each click admits at most 25 native steps; total selected work
remains capped at `3R + 2` attempts. Upload transfer remains `O(U)`. The visit does not walk pages to a total, hydrate
each row, reconstruct rank keys, or load the archive into browser storage. Subject suggestions run only after an
explicit search term. Presentation choices add one active-release read per opened choice editor or explicit retry;
the immutable definitions body keeps its existing producer bounds and cache. The browser holds one options array
(`O(T)` in the definitions-bounded released Types), without scanning member pages. Mixed adds no native Type lookup, and
review adds only the native addressed Type admission and constant-size sealed choice.

Decision: keep the original encoded archive after a successful read so Cancel then Restart can reuse it; a completed
export from this signed-in owner is the same source. Results reopen the current Collection reader for actual title,
privacy, member identities, notes and order.

Stories cover upload, local preparation, file-read failure, populated review, unsupported evidence, sparse
continuation, unknown application recovery, acknowledged result, stale conflict and partial result. Presentation
stories label explicit current choices, unsupported archived meaning, sealed mixed/Type reviews, and separate
mixed/adopted/unsupported-or-stale/unattempted outcomes.
Journey tests pin original-archive restart, exact original bytes, opaque sequential cursors, native Collection
readback and other-member denial. Focused regression source additionally pins three independent Collection addresses,
exact failed retry, sparse continuation, bounded Back/First, destination/source/viewer replacement, late response
retirement, outcome-cursor independence and deliberate keyboard focus. The existing denial assertion now keeps
recovery results visible and reports the denial within the Collection reader. The native Web owner and other-member walk exports a completed file, restores through the page, and rereads the Collection. Focused Web
acceptance exercises the mounted journey and bounded/source-session behavior; native HTTP producer acceptance
remains owned by Commerce.
Preparation decoders and producer implementation are not Web delivery; this guide describes the delivered consumer.

Decision: show each Coverage fact once, then lead review and results with supplied Collection and selected target
titles. Preserve duplicate occurrences in native order and distinguish missing, empty, cleared, invalid and supplied
notes. Localize independent add/note/order outcomes; keep source IDs, review/digest, reasons and complete supplied
evidence in closed labelled details. Privacy, unsupported scope and note omission warnings remain beside
confirmation. The destination is always a new private Collection, without title-based merge. Story assertions pin
confirmation, continuation and evidence disclosure using the real components on the private route. Execution and
native, focus/keyboard and visual acceptance are deferred to the verifier. This source-only change runs no compiler,
tests, build, browser or capture; consumer/native suites and phone/desktop/theme/locale review remain unverified.
