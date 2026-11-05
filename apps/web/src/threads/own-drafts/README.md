# Server-saved drafts consumer

This Web slice defines the bounded inventory and private inspection component. The inventory keeps one native page of
metadata, indexes that page once, and requests one selected body only after an explicit selection. Previous, First and
Continue each request one fresh page through the captured reader. The visit retains only the current cursor and up to
eight admitted predecessors; a response changes that coordinate path only after viewer, epoch and page admission.
Operational failure keeps the exact staged target for Retry, while a stale cursor requires the existing explicit
restart policy. Unknown and concealed selections share one message, and an operational body-read failure retains the
exact selection for retry. A concealed or changed selected head drops its metadata and action advice. Returning from
inspection keeps the current admitted coordinate and restores focus to its opener.

Decision: Keep only the current coordinate and up to eight accepted predecessors per mounted visit; Previous and First fetch fresh metadata through the original reader, and failed targets remain staged for exact retry.

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

Account, authentication/caller epoch, locale, source, reader, local-writing reader, command adapter and active-state
replacements retire the private visit, including equal restoration and A/B/A changes. Each movement re-admits its
captured reader before the request and before commit or focus. Keyboard movement focuses the existing inventory
heading only while that action owns focus; user focus movement, failure and retirement cancel the handoff.

Native authorization, mounted producer recordings and physical 256/1024/4096 growth acceptance remain Content-owned
and deferred until executed; generated declarations and Web fixtures do not establish them.

When a resumed editor is open, Return to drafts uses the same departure decision as the editor. Staying keeps the
chosen server or browser body and its retry state; deliberate departure returns focus to the inventory opener.

## Cost

### Own-draft inventory and inspection

- Touches: one explicit page operation; one exact selected-body operation after row selection. No body is requested
  while listing or opening another page.
- Bound: At most 20 metadata rows in one page index, nine cursor coordinates (current plus eight predecessors), one
  staged target and one selected native body. Lookup is O(1) after one O(N) map build. Each deliberate movement makes
  one list request; no predecessor rows, refill, polling or accumulated body list is retained.
- Growth check: `apps/web/tests/own-drafts-page.test.tsx` checks the 20-row bound, duplicate identities and
  identity/cursor keying. Mounted `own-drafts-resume.test.tsx` checks 1/10/20-row pages, one explicitly selected body,
  sparse replacement, focus restoration and late-response retirement. `own-drafts-navigation.test.tsx` checks fresh
  Previous/First reads, exact retries, finite coordinate history, movement retirement and focus handoff.
  `own-drafts-commands.test.tsx` pins exact account/resource/revision action advice, including malformed and absolute
  paths. Native 256/1024/4096 history and partition growth remain Content acceptance.

Decision: a concealed or changed selected head discards the retained inventory metadata and action advice; retrying
or restarting the inventory is explicit.

Decision: Retain one unresolved erase episode under the active private reader, independently of inventory and
inspection; show its original title/revision and exact retry on either surface, block replacement writes until it
settles, and retain erase acknowledgement for deliberate readback across navigation. Review alone remains cancellable.
