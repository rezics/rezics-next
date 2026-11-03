# Server-saved drafts consumer

This Web slice defines the bounded inventory and private inspection component. The inventory keeps one native page of
metadata, indexes that page once, and requests one selected body only after an explicit selection. Continuation
replaces the current page; the opaque cursor stays in component memory. Unknown and concealed selections share one
message, a stale revision asks for an explicit inventory restart, and an operational read failure retains the exact
selection for retry.

Decision: resume inspection through a typed `OwnDraftReader` seam and bind it only after Content publishes its
generated own-draft client methods; browser-local writing is not read or replaced by this consumer.

The installed Content routes and schemas are present in `services/kernel`, and the owner README documents their
wire page and exact action paths. The checked-in `@rezics/client` declaration does not yet include the generated
`own_drafts.list` and `own_drafts.resume` methods. The Web component therefore does not construct native URLs as
fetch destinations. Signed-in `/drafts` route and navigation binding, composer resume, save/publish/erase commands,
readback, browser-local recovery choice, and their mounted tests remain in the continuation brief.

## Cost

### Own-draft inventory and inspection

- Touches: one explicit page operation; one exact selected-body operation after row selection. No body is requested
  while listing or opening another page.
- Bound: At most 20 metadata rows in one page index, one retained page and one selected native body. Lookup is O(1)
  after one O(N) map build. Continuation replaces the page; there is no refill, polling or accumulated body list.
- Growth check: `apps/web/tests/own-drafts-page.test.tsx` checks the 20-row bound, duplicate identities, exact action
  paths and identity/cursor keying. Native 256/1024/4096 history and partition growth remain Content acceptance.
