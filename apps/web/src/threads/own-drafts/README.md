# Server-saved drafts consumer

This Web slice defines the bounded inventory and private inspection component. The inventory keeps one native page of
metadata, indexes that page once, and requests one selected body only after an explicit selection. Continuation
replaces the current page; the opaque cursor stays in component memory. Unknown and concealed selections share one
message, a stale revision asks for an explicit inventory restart, and an operational read failure retains the exact
selection for retry. Account, authentication/caller epoch, locale, source, reader and active-state replacements
remount the private boundary and synchronously abort outstanding reads. A concealed or changed selected head drops
its metadata and action advice; returning to the inventory requires an explicit retry or restart. Keyboard selection
focuses the inspection heading and returning restores focus to the corresponding inventory control.

Decision: resume inspection through a typed `OwnDraftReader` seam and bind it only after Content publishes its
generated own-draft client methods; browser-local writing is not read or replaced by this consumer.

Decision: Keep browser and server writing as independent sources after every command acknowledgement. Require a
named body choice before opening the editor, retain the browser copy, and report a later current read separately.

Decision: Keep the selected revision in the private erase retry intent and use the existing typed DELETE command,
whose native contract accepts an idempotency key but no revision precondition.

The signed-in localized route, account navigation, composer choice, save/publish/erase controls, and current-post
readback are connected through typed Web actions. The checked-in `@rezics/client` declaration still lacks the
generated `own_drafts.list` and `own_drafts.resume` methods, so `ownDraftNativeReader` returns unavailable until
those typed methods are delivered. No advice path becomes a browser fetch destination. Binding that generated
reader and completing the deferred controller acceptance are in
`.temp/continuation/own-drafts-native-reader.md`.

## Cost

### Own-draft inventory and inspection

- Touches: one explicit page operation; one exact selected-body operation after row selection. No body is requested
  while listing or opening another page.
- Bound: At most 20 metadata rows in one page index, one retained page and one selected native body. Lookup is O(1)
  after one O(N) map build. Continuation replaces the page; there is no refill, polling or accumulated body list.
- Growth check: `apps/web/tests/own-drafts-page.test.tsx` checks the 20-row bound, duplicate identities and
  identity/cursor keying. Mounted `own-drafts-resume.test.tsx` checks 1/10/20-row pages, one explicitly selected body,
  sparse replacement, focus restoration and late-response retirement. `own-drafts-commands.test.tsx` pins exact
  account/resource/revision action advice, including malformed and absolute paths. Native 256/1024/4096 history and partition growth remain Content acceptance.

Decision: a concealed or changed selected head discards the retained inventory metadata and action advice; retrying
or restarting the inventory is explicit.
