# Server-saved drafts consumer

This Web slice defines the bounded inventory and private inspection component. The inventory keeps one native page of
metadata, indexes that page once, and requests one selected body only after an explicit selection. Continuation
replaces the current page; the opaque cursor stays in component memory. Unknown and concealed selections share one
message, a stale revision asks for an explicit inventory restart, and an operational read failure retains the exact
selection for retry. Account, authentication/caller epoch, locale, source, reader and active-state replacements
remount the private boundary and synchronously abort outstanding reads. A concealed or changed selected head drops
its metadata and action advice; returning to the inventory requires an explicit retry or restart. Keyboard selection
focuses the inspection heading and returning restores focus to the corresponding inventory control.

The typed `OwnDraftReader` binds the installed generated account drafts list and exact selected-read methods
through the existing authenticated server transport, with abort signals and private/no-store responses.

Decision: Keep browser and server writing as independent sources after every command acknowledgement. Require a
named body choice before opening the editor, retain the browser copy, and report a later current read separately.

Decision: Open each supplied Subject reference in a labelled new tab at its localized canonical unlabelled address, keeping the exact Subject ID visible so the private selection and both writing sources stay in their original tab.

Decision: Keep the selected revision in the private erase retry intent and use the existing typed DELETE command,
whose native contract accepts an idempotency key but no revision precondition.

The signed-in localized route, account navigation, composer choice, save/publish/erase controls, and current-post
readback are connected through typed Web actions. The list always requests at most 20 metadata rows and the exact
selected read supplies the strong revision ETag. Account, post, thread, author, visibility and revision are validated
before selected bytes can enter the composer. Invalid or stale cursors require explicit restart; operational failures
retry the same cursor or selection. Explicit conflict replacement retires the selected context and its advice before
requesting a new inventory. Browser-local writing remains independent after replacement or acknowledgement.

Native authorization, mounted producer recordings and physical 256/1024/4096 growth acceptance remain Content-owned
and deferred until executed; generated declarations and Web fixtures do not establish them.

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

Decision: Retain one unresolved erase episode under the active private reader, independently of inventory and
inspection; show its original title/revision and exact retry on either surface, block replacement writes until it
settles, and retain erase acknowledgement for deliberate readback across navigation. Review alone remains cancellable.
